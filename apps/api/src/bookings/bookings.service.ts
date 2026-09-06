import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  BusinessNotFoundException,
  BusinessBadRequestException,
  BusinessConflictException,
} from '../common/exceptions/business-exception';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggerService } from '../common/services/audit-logger.service';
import { NotificationService } from '../common/services/notification.service';
import { LoyaltyService } from '../common/services/loyalty.service';
import { SecurityLoggerService } from '../common/services/security-logger.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { AvailabilityCacheService } from '../redis/availability-cache.service';
import { EmailService } from '../email/email.service';
import { EmailQuotaService } from '../email/email-quota.service';
import { envNumber } from '../common/env';
import { nowInTimezone } from '../common/validators/timezone';
import { ConfigService } from '@nestjs/config';
import { CreateBookingDto } from './dto/create-booking.dto';

// ─── Slot helpers ────────────────────────────────────────────────────────────

/** Parse "HH:MM" → total minutes from midnight */
function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

// ─── Coupon lifecycle helper ────────────────────────────────────────────────

/**
 * Roll back a coupon "use" when a booking that applied it gets cancelled.
 *
 * createBooking increments `coupon.usedCount` (vouchers + direct codes).
 * Without a matching decrement on cancel the counter monotonically climbs,
 * which (a) silently exhausts a coupon's `usageLimit` with cancelled
 * bookings and (b) lets a customer burn a one-shot voucher without ever
 * consuming the paid activity.
 *
 * Exported for reuse from every termination path carrying a `couponCode`:
 *   - customer/vendor/admin cancelBooking (points-only + cash-paid)
 *   - customer hard-delete of an unpaid PENDING booking
 *   - payment callback failure → delete booking branch
 *   - cleanup cron auto-cancel of stale PENDING bookings
 *
 * Uses `updateMany` with a `usedCount > 0` guard so double-invocation from
 * belt-and-suspenders callers can't drive the counter negative. For a
 * platform voucher (ClaimedCoupon) the `used` flag is also reset so the
 * customer can re-apply it on a future booking.
 *
 * Silent no-op when:
 *   - couponCode is null (no coupon was applied to this booking)
 *   - the coupon has since been deleted (rejected / purged)
 */
export async function refundCouponUsage(
  tx: Prisma.TransactionClient,
  couponCode: string | null | undefined,
  customerId: string,
): Promise<void> {
  if (!couponCode) return;
  const coupon = await tx.coupon.findUnique({
    where: { code: couponCode },
    select: { id: true, status: true, usageLimit: true, usedCount: true, validTo: true },
  });
  if (!coupon) return;
  const dec = await tx.coupon.updateMany({
    where: { id: coupon.id, usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  });
  await tx.claimedCoupon.updateMany({
    where: { userId: customerId, couponId: coupon.id, used: true },
    data: { used: false },
  });
  // Release a coupon that was auto-EXPIRED *solely* because it hit its usage cap
  // (the increment path flips status→EXPIRED once usedCount reaches usageLimit).
  // After refunding one use it's back under the limit, so restore it to APPROVED
  // — otherwise a single-use voucher stays dead forever after the booking that
  // claimed it is cancelled ("This voucher is no longer active"). Tight guards so
  // we never resurrect an admin-rejected or time-expired coupon:
  //   • dec.count > 0                         → a use was actually refunded
  //   • status === 'EXPIRED'                  → currently "off"
  //   • usageLimit set && usedCount >= it     → it was AT the cap (auto-capped);
  //       an admin-rejected coupon is PENDING-origin with usedCount 0 < limit,
  //       so it never matches this and stays rejected
  //   • validTo in the future                 → not a time-expired coupon
  if (
    dec.count > 0 &&
    coupon.status === 'EXPIRED' &&
    coupon.usageLimit != null &&
    coupon.usedCount >= coupon.usageLimit &&
    coupon.validTo > new Date()
  ) {
    await tx.coupon.update({ where: { id: coupon.id }, data: { status: 'APPROVED' } });
  }
}

/**
 * Server-derived JSON snapshot of a booking row, written into
 * `payment.bookingSnapshot` at booking-creation time so the PAY2M
 * callback's B2 orphan-recovery branch can re-insert the booking when
 * the cleanup cron deleted it before the success callback arrived.
 *
 * The shape is the SUBSET of Booking columns we need to recreate the
 * row plus a couple of forensic-only fields (`originalCreatedAt`) that
 * make sure the customer doesn't lose their cancellation window when
 * the row is re-inserted hours after the original.
 *
 * Critically — every value here comes from `booking` (the row that
 * Prisma JUST inserted), never from the request DTO. A tampered DTO
 * that somehow bypassed validation cannot poison the recovery price.
 */
export type BookingSnapshot = {
  ref: string;
  activityId: string;
  vendorId: string;
  customerId: string;
  unitNumber: number | null;
  startDatetime: string;        // ISO string — Json field can't hold Date
  endDatetime: string;
  guests: number;
  bookingPhone: string;         // v:2 — per-booking phone (E.164)
  guestBreakdown: any | null;
  selectedExtras: any | null;
  totalPrice: string;           // Decimal serialised as string to avoid float drift
  serviceFee: string;
  commissionPct: string;
  commissionAmount: string;
  couponCode: string | null;
  couponDiscount: string;
  pointsRedeemed: number;
  pointsDiscount: string;
  currencyCode: string;
  idempotencyKey: string | null;
  originalCreatedAt: string;
  /// Snapshot version — bump when the shape changes so the callback
  /// branch can fall back to the refund path on an unrecognised shape
  /// rather than recreating with stale assumptions.
  /// v:2 — added bookingPhone (per-booking phone, replacing the removed
  /// User.phoneVerified OTP machinery). prod has zero v:1 snapshots in
  /// the wild (no bookings) so the bump is safe.
  v: 2;
};

export function buildBookingSnapshot(booking: {
  ref: string;
  activityId: string;
  vendorId: string;
  customerId: string;
  unitNumber: number | null;
  startDatetime: Date;
  endDatetime: Date;
  guests: number;
  bookingPhone: string;
  guestBreakdown: any;
  selectedExtras: any;
  totalPrice: any;            // Prisma.Decimal
  serviceFee: any;
  commissionPct: any;
  commissionAmount: any;
  couponCode: string | null;
  couponDiscount: any;
  pointsRedeemed: any;        // Prisma.Decimal (QAR-denominated)
  pointsDiscount: any;
  currencyCode: string;
  idempotencyKey: string | null;
  createdAt: Date;
}): BookingSnapshot {
  const dec = (d: any): string =>
    d === null || d === undefined ? '0' : (typeof d === 'string' ? d : d.toString());
  return {
    ref: booking.ref,
    activityId: booking.activityId,
    vendorId: booking.vendorId,
    customerId: booking.customerId,
    unitNumber: booking.unitNumber ?? null,
    startDatetime: booking.startDatetime.toISOString(),
    endDatetime: booking.endDatetime.toISOString(),
    guests: booking.guests,
    bookingPhone: booking.bookingPhone,
    guestBreakdown: booking.guestBreakdown ?? null,
    selectedExtras: booking.selectedExtras ?? null,
    totalPrice: dec(booking.totalPrice),
    serviceFee: dec(booking.serviceFee),
    commissionPct: dec(booking.commissionPct),
    commissionAmount: dec(booking.commissionAmount),
    couponCode: booking.couponCode ?? null,
    couponDiscount: dec(booking.couponDiscount),
    pointsRedeemed: Number(booking.pointsRedeemed),
    pointsDiscount: dec(booking.pointsDiscount),
    currencyCode: booking.currencyCode,
    idempotencyKey: booking.idempotencyKey ?? null,
    originalCreatedAt: booking.createdAt.toISOString(),
    v: 2,
  };
}

/** Minutes → "HH:MM" */
function fromMinutes(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Granularity between consecutive hourly slot start times, in minutes.
 * 30 = half-hour slots (…:00 and …:30) so customers can pick e.g. 3:30 PM.
 * Safe at a finer granularity because slot conflict/availability is computed
 * on the actual [start, start+duration] time RANGE (sweep-line max-concurrency
 * below), not on slot indexes — a 30-min-offset start is just a shorter offset.
 * The `slotTime`/`slotEndTime` DTO regexes accept `:00` or `:30` to match.
 */
const HOURLY_SLOT_GRANULARITY_MINUTES = 30;

/**
 * Maximum number of slots ever returned to the frontend in a single response.
 * Defence against pathological activity configs (e.g. 24h open window + 1h
 * duration → 24 slots; safe. But a misconfig could blow up the UI).
 * Tunable via HOURLY_MAX_SLOTS env var; default 48.
 */
const MAX_HOURLY_SLOTS = Number(process.env.HOURLY_MAX_SLOTS || 48);

/**
 * Hard cap on how many `durationValue` units a single extended-range booking
 * can span. Bounds both the price (a tampered slotEndTime can't multiply into
 * astronomical charges) and the per-booking conflict-scan window. 24 × 1h =
 * one full day; 24 × 4h covers any realistic multi-day-effectively booking.
 * Tunable via BOOKING_MAX_SLOT_UNITS env var.
 */
const MAX_SLOT_UNITS = Number(process.env.BOOKING_MAX_SLOT_UNITS || 24);

/**
 * Hard cap on the number of nights a single DAILY booking can span. Bounds the
 * per-night price loop and the special-price `date: { in: [...] }` query against
 * an abusive multi-year range. Applies to BOTH flexible (durationValue=null) and
 * minimum-nights DAILY activities. Tunable via BOOKING_MAX_NIGHTS env var.
 */
const MAX_BOOKING_NIGHTS = Number(process.env.BOOKING_MAX_NIGHTS || 90);

/**
 * Compute HOURLY slot START times from checkIn/checkOut/duration.
 * Each slot runs for `durationValue` hours. Slots overlap each other — they
 * start every `HOURLY_SLOT_GRANULARITY_MINUTES` minutes (on the hour).
 *
 * Example (duration=2h, 08:00–16:00):
 *   [08:00, 09:00, 10:00, 11:00, 12:00, 13:00, 14:00]   ← last slot is 14-16
 * Example (duration=3h, 08:00–16:00):
 *   [08:00, 09:00, 10:00, 11:00, 12:00, 13:00]          ← last slot is 13-16
 *
 * The LAST slot's END never exceeds checkOutTime.
 */
export function computeSlots(checkInTime: string, checkOutTime: string, durationValue: number): string[] {
  const startMins = toMinutes(checkInTime);
  const endMins = toMinutes(checkOutTime);
  const slotDuration = durationValue * 60; // hours → minutes
  if (slotDuration <= 0) return [];          // guard against misconfig
  const slots: string[] = [];
  for (let t = startMins; t + slotDuration <= endMins; t += HOURLY_SLOT_GRANULARITY_MINUTES) {
    slots.push(fromMinutes(t));
    if (slots.length >= MAX_HOURLY_SLOTS) break;
  }
  return slots;
}

/**
 * Given a list of existing active bookings and a query window [windowStart, windowEnd),
 * return the peak number of guests concurrently booked at ANY instant inside
 * the window.
 *
 * Needed because flex-start slots OVERLAP each other. The old "sum guests of
 * every booking that overlaps the window" over-counts — e.g. booking A at 8-10
 * (30 guests) and booking B at 10-12 (30 guests) both technically overlap the
 * window 9-11, so naive summing says 60 are booked. But they are never both
 * active at the same instant — peak concurrency inside 9-11 is only 30. Using
 * max-concurrent instead of naive sum means we only reject genuinely over-cap
 * bookings, not artificially-blocked ones.
 *
 * Algorithm: sweep-line over clipped event points, O(n log n) in bookings.
 */
// Exported so the §B2/§M6 payment-recovery paths (payment.service.ts) reuse the
// EXACT same slot-conflict semantics instead of a naive SUM(guests) that
// over-counts non-concurrent overlaps + expired holds. One definition = no drift.
export function maxConcurrentInWindow(
  bookings: ReadonlyArray<{ startDatetime: Date; endDatetime: Date; guests: number }>,
  windowStart: Date,
  windowEnd: Date,
): number {
  type Event = { time: number; delta: number; isStart: number };
  const events: Event[] = [];

  for (const b of bookings) {
    // Clip the booking's active interval to the query window.
    const s = b.startDatetime > windowStart ? b.startDatetime : windowStart;
    const e = b.endDatetime   < windowEnd   ? b.endDatetime   : windowEnd;
    if (s.getTime() >= e.getTime()) continue; // no intersection with window
    // isStart: 0 = end-event (sorted first at same instant), 1 = start-event
    events.push({ time: s.getTime(), delta: b.guests,  isStart: 1 });
    events.push({ time: e.getTime(), delta: -b.guests, isStart: 0 });
  }

  // Sort by time. At the same instant, process END events BEFORE START events
  // so a booking ending at t=10 frees its seat before a new booking starting
  // at t=10 counts against capacity — "end-touching-start" is not concurrent.
  events.sort((a, b) => (a.time - b.time) || (a.isStart - b.isStart));

  let current = 0;
  let peak = 0;
  for (const ev of events) {
    current += ev.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

/**
 * Whole-unit rental? When true, ONE booking reserves an ENTIRE unit — no seat-
 * sharing, regardless of how many guests it has. This is true for:
 *   • any DAILY activity with units (rooms — DAILY is always per-unit priced), and
 *   • HOURLY activities priced PER_UNIT.
 * HOURLY + PER_PERSON activities with units still sell individual seats and so
 * pack/share a unit up to its capacity. Activities without units are unaffected.
 */
export function rentsWholeUnit(a: { hasUnits: boolean; bookingType: string; pricingModel: string }): boolean {
  return a.hasUnits && (a.bookingType === 'DAILY' || a.pricingModel === 'PER_UNIT');
}

/**
 * Build a Date from a date string (YYYY-MM-DD) + time string (HH:MM).
 * Always interprets as UTC to avoid timezone drift in conflict queries.
 */
export function buildDatetime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}:00.000Z`);
}

/**
 * Add (or subtract) whole months, CLAMPING to the last day of the target month.
 *
 * `setMonth`/`setUTCMonth` keep the day-of-month, so a day that does not exist
 * in the target month silently rolls FORWARD: 2026-08-31 + 6 months becomes
 * "2027-02-31", which JS normalises to 2027-03-03. Every advance-window check
 * built on setMonth was therefore up to 3 days too generous whenever the base
 * date fell on a 29th, 30th or 31st, and the calendars offered a month the API
 * then rejected.
 *
 * Clamping is the intended reading of "N months ahead": Aug 31 + 6 months is
 * the end of February, not the start of March. Setting the day to 1 before
 * shifting the month is what makes the shift itself overflow-proof.
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const out = new Date(date);
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDayOfTarget = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDayOfTarget));
  return out;
}

/** Get ISO weekday name for a YYYY-MM-DD string (MON, TUE, …) */
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function weekdayOf(dateStr: string): string {
  return DAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
}

/**
 * Validate a YYYY-MM-DD string is a real calendar date.
 * FIX #10: Reject invalid dates like "2026-13-45"
 */
export function isValidDate(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Get "today" in the activity's country timezone as YYYY-MM-DD.
 * FIX #4 & #20: Use the activity's timezone, not the server's.
 */
function todayInTimezone(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return parts; // en-CA format is YYYY-MM-DD
  } catch {
    // Fallback to UTC if timezone is invalid
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  }
}

// `nowInTimezone` now lives in ../common/validators/timezone (a leaf module) so
// the cleanup cron + vendor complete guard can share the SAME implementation
// without a circular import through this service (imported at the top). Re-
// exported here so existing importers (and the unit spec) keep their path.
export { nowInTimezone };

// ─── Active booking filter ────────────────────────────────────────────────────
//
// A booking "holds" a seat if ALL of the following are true:
//   1. Not CANCELLED
//   2. Not a PENDING reservation whose window has expired
//
// PENDING bookings where reservedUntil < now are treated as free seats
// immediately — no cron wait needed. The cron cleans them up asynchronously.
//
export function activeBookingFilter(now: Date) {
  return {
    status: { notIn: ['CANCELLED'] as any },
    NOT: {
      AND: [
        { status: 'PENDING' as any },
        { reservedUntil: { lt: now } },
      ],
    },
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  private readonly reservationWindowMinutes: number;
  private readonly bookingMaxAdvanceMonths: number;
  private readonly redisLockTtlMs: number;

  constructor(
    private prisma: PrismaService,
    private auditLogger: AuditLoggerService,
    private notificationService: NotificationService,
    private redisLock: RedisLockService,
    private configService: ConfigService,
    private loyalty: LoyaltyService,
    private availabilityCache: AvailabilityCacheService,
    private emailService: EmailService,
    private emailQuota: EmailQuotaService,
    private securityLogger: SecurityLoggerService,
  ) {
    this.reservationWindowMinutes = Number(
      this.configService.get('RESERVATION_WINDOW_MINUTES', '15'),
    );
    this.bookingMaxAdvanceMonths = Number(
      this.configService.get('BOOKING_MAX_ADVANCE_MONTHS', '6'),
    );
    this.redisLockTtlMs = Number(
      this.configService.get('REDIS_LOCK_TTL_MS', '30000'),
    );
  }

  /**
   * Active (non-deleted) vendor availability blocks overlapping
   * [windowStart, windowEnd). Used by the availability endpoints + booking
   * creation to treat blocked dates / time-windows as unbookable. Half-open
   * interval overlap: blockStart < windowEnd && blockEnd > windowStart.
   */
  private async getBlocksInWindow(activityId: string, windowStart: Date, windowEnd: Date) {
    return this.prisma.client.activityBlock.findMany({
      where: {
        activityId,
        deletedAt: null,
        blockStart: { lt: windowEnd },
        blockEnd: { gt: windowStart },
      },
      select: { blockStart: true, blockEnd: true },
    });
  }

  /**
   * Returns availability for an HOURLY activity on a specific date.
   * Each slot shows how many seats remain out of total capacity.
   * Uses RANGE overlap for conflict detection (FIX #22).
   */
  async getHourlyAvailability(activityId: string, date: string) {
    if (!isValidDate(date)) throw new BadRequestException('Invalid date');

    const activity = await this.prisma.client.activity.findUnique({
      where: { id: activityId },
      include: { country: { select: { defaultTimezone: true } } },
    });
    if (!activity || activity.status !== 'ACTIVE') {
      throw new BusinessNotFoundException('ACTIVITY.NOT_FOUND', 'Activity not found');
    }
    if (activity.bookingType !== 'HOURLY') {
      throw new BadRequestException('Activity is not HOURLY');
    }
    if (!activity.checkInTime || !activity.checkOutTime || !activity.durationValue) {
      throw new BadRequestException('Activity configuration incomplete');
    }
    if (activity.durationValue <= 0) {
      throw new BadRequestException('Activity duration must be greater than 0');
    }

    // FIX #4: Check if date is past using activity's timezone
    const tz = activity.country?.defaultTimezone ?? 'UTC';
    const todayStr = todayInTimezone(tz);
    const isPastDate = date < todayStr;
    const isToday = date === todayStr;

    const slots = computeSlots(activity.checkInTime, activity.checkOutTime, activity.durationValue);
    const now = new Date();

    // Get current time in the activity's timezone (HH:MM format) for slot comparison
    let nowTimeLocal = '23:59';
    try {
      nowTimeLocal = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    } catch { /* fallback to 23:59 — marks all slots as past if tz is invalid */ }

    // Fetch ALL active bookings for the entire operating window on this date
    // in ONE query — then run the interval-sweep per slot locally. With flex
    // slots, the same booking appears in multiple candidate windows, so a
    // per-slot DB aggregate would (a) multiply query count and (b) over-count
    // (see maxConcurrentInWindow docstring).
    const dayStart = buildDatetime(date, activity.checkInTime);
    const dayEnd = buildDatetime(date, activity.checkOutTime);
    // Defence-in-depth DoS cap. Even at the platform's max capacity (unitCount *
    // unitCapacity) per activity × max slots per day, real-world days fit in
    // well under this. An activity returning >5k bookings/day means misconfig
    // (capacity too high, spam, or data corruption) — we'd rather under-report
    // than buffer a gigabyte of rows into memory.
    const DAY_BOOKINGS_CAP = Number(process.env.AVAILABILITY_MAX_DAY_BOOKINGS || 5000);
    const dayBookings = await this.prisma.client.booking.findMany({
      where: {
        activityId,
        ...activeBookingFilter(now),
        startDatetime: { lt: dayEnd },
        endDatetime: { gt: dayStart },
      },
      select: { startDatetime: true, endDatetime: true, guests: true, unitNumber: true },
      take: DAY_BOOKINGS_CAP,
    });

    // Vendor availability locks overlapping the day's operating window.
    const dayBlocks = await this.getBlocksInWindow(activityId, dayStart, dayEnd);

    const result = slots.map((slotStart) => {
      const slotEnd = fromMinutes(toMinutes(slotStart) + activity.durationValue! * 60);
      const startDatetime = buildDatetime(date, slotStart);
      const endDatetime = buildDatetime(date, slotEnd);

      // Past-slot marker — uses activity's local timezone
      const isSlotPast = isPastDate || (isToday && slotStart <= nowTimeLocal);
      // Vendor lock — RAW per-hour signal: is THIS hour boundary inside a lock
      // window. The hourly picker uses this to reject any booking whose RANGE
      // (start..end, including a longer/earlier-started one) crosses a locked
      // hour. The authoritative range rejection lives in createBooking.
      // Half-open: [blockStart, blockEnd).
      const isBlocked = dayBlocks.some((b) => startDatetime >= b.blockStart && startDatetime < b.blockEnd);

      if (activity.hasUnits && activity.unitCount > 0) {
        const wholeUnit = rentsWholeUnit(activity);
        const unitSlots = Array.from({ length: activity.unitCount }, (_, i) => i + 1).map((unitNum) => {
          const unitBookings = dayBookings.filter((b) => b.unitNumber === unitNum);
          const peak = maxConcurrentInWindow(unitBookings, startDatetime, endDatetime);
          // Whole-unit rentals are all-or-nothing: any overlap takes the entire
          // unit out (no seat-sharing). Per-person units count remaining seats.
          // Capacity (concurrency) is computed independently of isBlocked; the
          // lock is surfaced via isBlocked and enforced at booking create.
          const available = wholeUnit
            ? (peak > 0 ? 0 : activity.unitCapacity)
            : Math.max(0, activity.unitCapacity - peak);
          return {
            unitNumber: unitNum,
            capacity: activity.unitCapacity,
            booked: peak,
            available,
          };
        });
        const totalAvailable = unitSlots.reduce((s, u) => s + u.available, 0);
        return { slotStart, slotEnd, units: unitSlots, totalAvailable, isPast: isSlotPast, isBlocked };
      } else {
        const peak = maxConcurrentInWindow(dayBookings, startDatetime, endDatetime);
        const cap = activity.capacity ?? Infinity;
        // Capacity (concurrency) is independent of isBlocked — see note above.
        const available = cap === Infinity ? Infinity : Math.max(0, cap - peak);
        return { slotStart, slotEnd, capacity: activity.capacity, booked: peak, available, isPast: isSlotPast, isBlocked };
      }
    });

    return { date, bookingType: 'HOURLY', slots: result };
  }

  /**
   * Returns availability for a DAILY activity on a given date range.
   */
  async getDailyAvailability(
    activityId: string,
    checkInDate: string,
    checkOutDate: string,
    unitNumber?: number,
  ) {
    if (!isValidDate(checkInDate) || !isValidDate(checkOutDate)) {
      throw new BadRequestException('Invalid date format');
    }

    const activity = await this.prisma.client.activity.findUnique({
      where: { id: activityId },
    });
    if (!activity || activity.status !== 'ACTIVE') {
      throw new BusinessNotFoundException('ACTIVITY.NOT_FOUND', 'Activity not found');
    }
    if (activity.bookingType !== 'DAILY') {
      throw new BadRequestException('Activity is not DAILY');
    }

    const startDatetime = buildDatetime(checkInDate, activity.checkInTime ?? '14:00');
    const endDatetime = buildDatetime(checkOutDate, activity.checkOutTime ?? '11:00');
    const now = new Date();

    // Vendor availability lock — if any block overlaps the requested stay,
    // the whole range is unbookable (can't stay across a blocked night).
    const blocked = (await this.getBlocksInWindow(activityId, startDatetime, endDatetime)).length > 0;

    // Overlap condition — excludes CANCELLED and expired PENDING reservations
    const overlapCondition = {
      activityId,
      ...activeBookingFilter(now),
      startDatetime: { lt: endDatetime },
      endDatetime: { gt: startDatetime },
    };

    if (activity.hasUnits) {
      if (!unitNumber) {
        // One query for all units instead of N parallel aggregates (one per
        // unit). groupBy returns only the units that actually have overlapping
        // bookings; we fill 0 for the rest below. `unitNumber` is nullable on
        // Booking, but rows with null can't appear here — overlapCondition is
        // scoped to a hasUnits activity, whose bookings always carry a unit —
        // so we defensively skip a null group when building the map.
        //
        // NOTE: this SUMs guests across every booking that overlaps the
        // requested window — same semantics as the createBooking DAILY
        // capacity check and the per-unit aggregate this replaced. Two
        // staggered (time-disjoint) stays in the same unit therefore both
        // count, which can under-report availability for a wide window. That
        // pre-dates this refactor (and matches the booking-creation path, so
        // they agree); switching DAILY to per-instant peak concurrency like
        // the HOURLY path would be a behaviour change for a separate PR.
        const grouped = await this.prisma.client.booking.groupBy({
          by: ['unitNumber'],
          where: overlapCondition,
          _sum: { guests: true },
        });
        const bookedByUnit = new Map<number, number>();
        for (const g of grouped) {
          if (g.unitNumber == null) continue;
          bookedByUnit.set(g.unitNumber, g._sum.guests ?? 0);
        }
        const wholeUnit = rentsWholeUnit(activity);
        const unitAvailability = Array.from({ length: activity.unitCount }, (_, i) => i + 1).map(
          (unitNum) => {
            const booked = bookedByUnit.get(unitNum) ?? 0;
            // Whole-unit rentals (rooms): any guest in the unit takes it entirely.
            const available = blocked
              ? 0
              : wholeUnit
                ? (booked > 0 ? 0 : activity.unitCapacity)
                : Math.max(0, activity.unitCapacity - booked);
            return {
              unitNumber: unitNum,
              capacity: activity.unitCapacity,
              booked,
              available,
            };
          },
        );
        return { bookingType: 'DAILY', checkInDate, checkOutDate, units: unitAvailability, isBlocked: blocked };
      } else {
        if (unitNumber < 1 || unitNumber > activity.unitCount) {
          throw new NotFoundException('Unit not found');
        }
        const agg = await this.prisma.client.booking.aggregate({
          where: { ...overlapCondition, unitNumber },
          _sum: { guests: true },
        });
        const booked = agg._sum.guests ?? 0;
        const available = blocked
          ? 0
          : rentsWholeUnit(activity)
            ? (booked > 0 ? 0 : activity.unitCapacity)
            : Math.max(0, activity.unitCapacity - booked);
        return {
          bookingType: 'DAILY', checkInDate, checkOutDate, unitNumber,
          capacity: activity.unitCapacity, booked,
          available,
          isBlocked: blocked,
        };
      }
    } else {
      const agg = await this.prisma.client.booking.aggregate({
        where: overlapCondition,
        _sum: { guests: true },
      });
      const booked = agg._sum.guests ?? 0;
      return {
        bookingType: 'DAILY', checkInDate, checkOutDate,
        capacity: activity.capacity, booked,
        available: blocked ? 0 : (activity.capacity != null ? Math.max(0, activity.capacity - booked) : Infinity),
        isBlocked: blocked,
      };
    }
  }

  // ─── Calendar availability (monthly) ────────────────────────────────────

  async getCalendarAvailability(
    activityId: string,
    month: string,
    unitNumber?: number,
  ) {
    const activity = await this.prisma.client.activity.findUnique({
      where: { id: activityId },
      include: {
        country: { select: { currencyCode: true, defaultTimezone: true } },
      },
    });
    if (!activity || activity.status !== 'ACTIVE') {
      throw new BusinessNotFoundException('ACTIVITY.NOT_FOUND', 'Activity not found');
    }

    // FIX #5: Safe month parsing — use Date.UTC to handle December correctly
    const [year, mon] = month.split('-').map(Number);
    if (mon < 1 || mon > 12 || year < 2000 || year > 2100) {
      throw new BadRequestException('Invalid month format');
    }

    // Cache lookup AFTER validation — never cache a malformed request and never
    // short-circuit existence/status checks. Version-based invalidation means
    // a stale entry is impossible after invalidate(); TTL bounds orphan keys.
    const cached = await this.availabilityCache.get<unknown>(activityId, month, unitNumber);
    if (cached) return cached;

    const lastDay = new Date(Date.UTC(year, mon, 0)); // last day of the month
    const daysInMonth = lastDay.getUTCDate();

    const checkInTime = activity.checkInTime ?? '14:00';
    const checkOutTime = activity.checkOutTime ?? '11:00';

    // FIX #5: Use Date.UTC for month boundaries — no string concatenation for month+1
    const monthStart = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(year, mon - 1, daysInMonth, 23, 59, 59));

    const now = new Date();
    // Defence-in-depth cap — see AVAILABILITY_MAX_MONTH_BOOKINGS env var.
    // A month's booking set for a single activity should never exceed this in
    // practice; if it does, either the activity is mis-scaled or something is
    // wrong. Truncate rather than OOM.
    const MONTH_BOOKINGS_CAP = Number(process.env.AVAILABILITY_MAX_MONTH_BOOKINGS || 50000);
    const bookings = await this.prisma.client.booking.findMany({
      where: {
        activityId,
        ...activeBookingFilter(now),
        startDatetime: { lte: monthEnd },
        endDatetime: { gte: monthStart },
        ...(unitNumber ? { unitNumber } : {}),
      },
      select: { startDatetime: true, endDatetime: true, guests: true, unitNumber: true },
      take: MONTH_BOOKINGS_CAP,
    });

    // Vendor availability locks anywhere in this month (one query for the month).
    const monthBlocks = await this.getBlocksInWindow(activityId, monthStart, monthEnd);

    // Per-date special prices for the month → override the day's displayed price.
    const monthSpecials = await this.prisma.client.activitySpecialPrice.findMany({
      where: { activityId, deletedAt: null, date: { gte: monthStart, lte: monthEnd } },
      select: { date: true, price: true },
    });
    const specialPriceByDate = new Map<string, number>();
    for (const sp of monthSpecials) specialPriceByDate.set(sp.date.toISOString().slice(0, 10), Number(sp.price));

    // FIX #4 & #20: Use activity's country timezone for "today" calculation
    const tz = activity.country?.defaultTimezone ?? 'UTC';
    const todayStr = todayInTimezone(tz);

    const days: {
      date: string; dayOfWeek: string; price: number; isSpecialPrice: boolean; isActiveDay: boolean;
      isPast: boolean; capacity: number | null; booked: number;
      available: number | null; isFullyBooked: boolean; isBlocked: boolean;
    }[] = [];

    const pricePerPerson = Number(activity.pricePerPerson);

    // For hourly activities: compute the last slot start time to check if today is still bookable
    const lastSlotTime = activity.bookingType === 'HOURLY' && activity.checkInTime && activity.checkOutTime && activity.durationValue
      ? (() => {
          const slots = computeSlots(activity.checkInTime!, activity.checkOutTime!, activity.durationValue!);
          return slots.length > 0 ? slots[slots.length - 1] : null;
        })()
      : null;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayDate = new Date(`${dateStr}T00:00:00Z`);
      const dow = DAYS[dayDate.getUTCDay()];

      let isPast = dateStr < todayStr;
      // For hourly activities: if today's last slot has already passed, mark today as past too
      if (!isPast && dateStr === todayStr && lastSlotTime) {
        // Compare in activity's local timezone, not UTC
        let nowTimeLocal = '23:59';
        try {
          nowTimeLocal = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
        } catch { /* fallback marks day as past */ }
        if (lastSlotTime <= nowTimeLocal) isPast = true;
      }

      // Support both formats: 'SUN'/'MON' (new) and 'Sunday'/'Monday' (legacy)
      const isActiveDay = activity.activeDays.length === 0 || activity.activeDays.some(
        (ad: string) => ad.toUpperCase() === dow || ad.toUpperCase().startsWith(dow),
      );

      // Count booked guests for this day using overlap.
      //
      // For HOURLY activities, flex-start slots OVERLAP each other (e.g. a 2h
      // activity has slots 8-10, 9-11, 10-12 running concurrently). Naively
      // summing every booking that overlaps the day window over-counts guests
      // and produces false "fully booked" days. We use the same peak-concurrency
      // sweep as getHourlyAvailability / createBooking.
      //
      // For DAILY, bookings are night-based and naturally concurrent across
      // their full span; a flat sum of "bookings that touch this day" is the
      // correct number of guests occupying inventory on this day.
      const dayCheckIn = buildDatetime(dateStr, checkInTime);
      const nextDay = new Date(Date.UTC(year, mon - 1, d + 1));
      const nextDateStr = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;
      const dayCheckOut = buildDatetime(nextDateStr, checkOutTime);

      // Whole-unit rentals (rooms / per-unit) → a day's availability is counted
      // in UNITS: a unit with ANY overlapping booking is fully taken (no seat-
      // sharing). Seat-based activities (per-person, or no units) count guests
      // against total capacity as before.
      const wholeUnit = rentsWholeUnit(activity);
      let booked = 0;
      let capacity: number | null = null;
      let available: number | null = null;

      if (wholeUnit && unitNumber) {
        const occ = bookings.some((b) => b.startDatetime < dayCheckOut && b.endDatetime > dayCheckIn);
        capacity = 1; booked = occ ? 1 : 0; available = occ ? 0 : 1;
      } else if (wholeUnit) {
        const occupiedUnits = new Set<number>();
        for (const b of bookings) {
          if (b.unitNumber != null && b.startDatetime < dayCheckOut && b.endDatetime > dayCheckIn) {
            occupiedUnits.add(b.unitNumber);
          }
        }
        capacity = activity.unitCount;
        booked = occupiedUnits.size;
        available = Math.max(0, activity.unitCount - occupiedUnits.size);
      } else {
        if (activity.bookingType === 'HOURLY') {
          const dayBookings = bookings.filter(
            (b) => b.startDatetime < dayCheckOut && b.endDatetime > dayCheckIn,
          );
          booked = maxConcurrentInWindow(dayBookings, dayCheckIn, dayCheckOut);
        } else {
          for (const b of bookings) {
            if (b.startDatetime < dayCheckOut && b.endDatetime > dayCheckIn) {
              booked += b.guests;
            }
          }
        }
        if (unitNumber) {
          capacity = activity.unitCapacity;
        } else if (activity.hasUnits) {
          capacity = activity.unitCount * activity.unitCapacity;
        } else {
          capacity = activity.capacity;
        }
        available = capacity != null ? Math.max(0, capacity - booked) : null;
      }

      let isFullyBooked = capacity != null ? available === 0 : false;

      // BUG FIX — HOURLY "fully booked" must be PER-SLOT, not whole-day peak.
      // The block above derives `booked`/`available` from the peak concurrency
      // (or peak unit-occupancy) ANYWHERE in the day, so a single booking on a
      // capacity-limited hourly activity (e.g. capacity 1, or 1 unit) made
      // available=0 → the WHOLE date showed fully-booked even though only a few
      // hours were taken. A date is full only when EVERY bookable slot is at
      // capacity — the same notion getHourlyAvailability uses per slot.
      if (
        activity.bookingType === 'HOURLY' &&
        activity.checkInTime && activity.checkOutTime && activity.durationValue
      ) {
        const slots = computeSlots(activity.checkInTime, activity.checkOutTime, activity.durationValue);
        const dayBks = bookings.filter(
          (b) => b.startDatetime < dayCheckOut && b.endDatetime > dayCheckIn,
        );
        const durMs = activity.durationValue * 60 * 60 * 1000;
        isFullyBooked = slots.length > 0 && slots.every((slotStart) => {
          const sStart = buildDatetime(dateStr, slotStart);
          const sEnd = new Date(sStart.getTime() + durMs);
          if (wholeUnit) {
            // Whole-unit (per-unit hourly): slot full only if every unit is
            // occupied during it.
            const occ = new Set<number>();
            for (const b of dayBks) {
              if (b.unitNumber != null && b.startDatetime < sEnd && b.endDatetime > sStart) {
                occ.add(b.unitNumber);
              }
            }
            return occ.size >= (unitNumber ? 1 : activity.unitCount);
          }
          // Seat-based (per-person units / no units): slot full when peak
          // concurrency in it reaches total capacity. Uncapped → never full.
          return capacity != null && maxConcurrentInWindow(dayBks, sStart, sEnd) >= capacity;
        });
      }

      // Vendor availability lock. A block fully covering the calendar day
      // disables it (available → 0); a partial (time-window) block only flags
      // it — those slots are removed in getHourlyAvailability and rejected at
      // booking time, so the day itself stays selectable.
      const dayEndUtc = new Date(dayDate.getTime() + 24 * 60 * 60 * 1000);
      const isBlocked = monthBlocks.some((b) => b.blockStart < dayEndUtc && b.blockEnd > dayDate);
      const fullyBlocked = monthBlocks.some((b) => b.blockStart <= dayDate && b.blockEnd >= dayEndUtc);
      if (fullyBlocked) { available = 0; isFullyBooked = true; }

      days.push({ date: dateStr, dayOfWeek: dow, price: specialPriceByDate.get(dateStr) ?? pricePerPerson, isSpecialPrice: specialPriceByDate.has(dateStr), isActiveDay, isPast, capacity, booked, available, isFullyBooked, isBlocked });
    }

    const response = {
      activityId, month,
      bookingType: activity.bookingType,
      pricingModel: activity.pricingModel,
      checkInTime, checkOutTime,
      durationValue: activity.durationValue,
      currencyCode: activity.country?.currencyCode ?? 'QAR',
      activeDays: activity.activeDays,
      hasUnits: activity.hasUnits,
      unitCount: activity.hasUnits ? activity.unitCount : undefined,
      unitCapacity: activity.hasUnits ? activity.unitCapacity : undefined,
      days,
    };

    await this.availabilityCache.set(activityId, month, response, unitNumber);
    return response;
  }

  // ─── Create booking ───────────────────────────────────────────────────────

  async createBooking(userId: string, dto: CreateBookingDto) {
    const db = this.prisma.client;

    // Idempotency: if the client already sent this key and a booking was created,
    // return that booking immediately — prevents double-booking on network retry.
    //
    // Scope the lookup by customerId so a foreign-customer's key behaves
    // identically to a never-seen key — both fall through to the normal
    // create path. If a real foreign-key collision exists, the DB unique
    // constraint will fire on insert and the global PrismaExceptionFilter
    // maps P2002 → generic 409 ("A record with one of the provided values
    // already exists"). No timing or response oracle remains for guessing
    // another user's idempotency key.
    if (dto.idempotencyKey) {
      const existing = await db.booking.findFirst({
        where: { idempotencyKey: dto.idempotencyKey, customerId: userId },
        include: {
          activity: { select: { titleEn: true, titleAr: true } },
          payment: { select: { id: true, amount: true, status: true } },
        },
      });
      if (existing) {
        return { booking: existing, seatsRemaining: null, idempotent: true };
      }
    }

    // FIX #10: Validate date format beyond regex
    if (!isValidDate(dto.checkInDate)) {
      throw new BadRequestException('Invalid check-in date');
    }
    if (dto.checkOutDate && !isValidDate(dto.checkOutDate)) {
      throw new BadRequestException('Invalid check-out date');
    }

    // 1. Load activity + vendor status + country timezone
    const activity = await db.activity.findUnique({
      where: { id: dto.activityId },
      include: {
        vendor: { select: { id: true, status: true, commissionPct: true } },
        country: { select: { serviceFeeFixed: true, defaultTimezone: true, currencyCode: true } },
        category: { select: { commissionPct: true } },
      },
    });
    if (!activity) throw new BusinessNotFoundException('ACTIVITY.NOT_FOUND', 'Activity not found');
    if (activity.status !== 'ACTIVE') throw new BadRequestException('Activity is not available for booking');
    if (activity.vendor.status !== 'ACTIVE') throw new BadRequestException('This vendor is not active');

    // FIX #1: Validate check-in date is not in the past (using activity's timezone)
    const tz = activity.country?.defaultTimezone ?? 'UTC';
    const todayStr = todayInTimezone(tz);
    if (dto.checkInDate < todayStr) {
      throw new BadRequestException('Cannot book a past date');
    }

    // Prevent bookings too far in the future (avoids indefinite seat locks)
    const maxFutureDate = addMonthsClamped(new Date(), this.bookingMaxAdvanceMonths);
    const maxFutureDateStr = maxFutureDate.toISOString().slice(0, 10);
    if (dto.checkInDate > maxFutureDateStr) {
      throw new BadRequestException(`Cannot book more than ${this.bookingMaxAdvanceMonths} month(s) in advance`);
    }

    // 2. Validate activeDays (check-in day must be allowed)
    if (activity.activeDays.length > 0) {
      const day = weekdayOf(dto.checkInDate);
      const isAllowed = activity.activeDays.some(
        (ad: string) => ad.toUpperCase() === day || ad.toUpperCase().startsWith(day),
      );
      if (!isAllowed) {
        throw new BadRequestException(
          `This activity is not available on ${day}. Available days: ${activity.activeDays.join(', ')}`,
        );
      }
    }

    // FIX #10: Validate capacity > 0 for non-unit activities
    if (!activity.hasUnits && activity.capacity !== null && activity.capacity <= 0) {
      throw new BadRequestException('This activity has no available capacity');
    }

    // 3. Determine capacity target
    let capacityLimit: number;
    let resolvedUnitNumber: number | null = null;

    if (!activity.hasUnits) {
      capacityLimit = activity.capacity ?? Infinity;
    } else {
      capacityLimit = 0; // resolved inside transaction
    }

    // 4. Build startDatetime and endDatetime, validate slot for HOURLY
    let startDatetime: Date;
    let endDatetime: Date;

    if (activity.bookingType === 'HOURLY') {
      if (!dto.slotTime) throw new BadRequestException('slotTime is required for HOURLY activities');
      if (!activity.checkInTime || !activity.checkOutTime || !activity.durationValue) {
        throw new BadRequestException('Activity time configuration is incomplete');
      }
      // FIX #3: Validate duration > 0
      if (activity.durationValue <= 0) {
        throw new BadRequestException('Activity duration must be greater than 0');
      }

      // Flex-hour booking validation. A request is valid iff:
      //   (1) slotTime + slotEndTime are on the hour or half-hour (:00/:30, DTO regex)
      //   (2) slotTime ≥ activity checkInTime
      //   (3) slotEndTime ≤ activity checkOutTime
      //   (4) hours(end − start) ≥ durationValue              (the minimum)
      //   (5) hours(end − start) ≤ durationValue × MAX_SLOT_UNITS   (DoS cap)
      //
      // NO integer-multiple-of-durationValue constraint — customers can
      // book any hour count ≥ durationValue. e.g. a 2h-baseline activity
      // can be booked for 2h, 3h, 4h, …, up to the closing time. Pricing is
      // pro-rated linearly: priceCents × hours / durationValue.
      //
      // slotEndTime is optional: when omitted, end = start + durationValue
      // (legacy single-slot behaviour, backward compatible with clients that
      // only send slotTime).
      if (!/:(00|30)$/.test(dto.slotTime)) {
        throw new BadRequestException('Slot time must be on the hour or half-hour (e.g. 09:00, 09:30)');
      }
      const slotStartMins = toMinutes(dto.slotTime);
      const checkInMins = toMinutes(activity.checkInTime);
      const checkOutMins = toMinutes(activity.checkOutTime);
      const unitMins = activity.durationValue * 60;
      const MAX_BOOKING_MINS = MAX_SLOT_UNITS * unitMins;

      let slotEndMins: number;
      if (dto.slotEndTime) {
        if (!/:(00|30)$/.test(dto.slotEndTime)) {
          throw new BadRequestException('Slot end time must be on the hour or half-hour (e.g. 10:00, 10:30)');
        }
        slotEndMins = toMinutes(dto.slotEndTime);
        const span = slotEndMins - slotStartMins;
        if (span <= 0) {
          throw new BadRequestException('Slot end time must be after slot start time');
        }
        // Whole-hour booking LENGTHS only. :30 START times are allowed (KAN-12),
        // but a half-hour SPAN (e.g. 09:00→10:30) would be rounded UP by the
        // server's hour math (Math.round) while the client preview shows the
        // lower whole hour → a silent overcharge. A :30 start + N×duration end is
        // always a whole-hour span; this rejects only an explicit half-hour range.
        if (span % 60 !== 0) {
          throw new BadRequestException('Booking length must be a whole number of hours');
        }
        if (span < unitMins) {
          throw new BadRequestException(
            `Booking must be at least ${activity.durationValue} hour(s). Requested ${span / 60}.`,
          );
        }
        if (span > MAX_BOOKING_MINS) {
          throw new BadRequestException(
            `Booking cannot exceed ${MAX_BOOKING_MINS / 60} hours. Requested ${span / 60}.`,
          );
        }
      } else {
        slotEndMins = slotStartMins + unitMins;
      }

      if (slotStartMins < checkInMins) {
        throw new BadRequestException('This time slot is before the activity opens');
      }
      if (slotEndMins > checkOutMins) {
        throw new BadRequestException('This time slot exceeds the activity closing time');
      }

      startDatetime = buildDatetime(dto.checkInDate, dto.slotTime);
      endDatetime = buildDatetime(dto.checkInDate, fromMinutes(slotEndMins));
    } else {
      // DAILY
      if (!dto.checkOutDate) throw new BadRequestException('checkOutDate is required for DAILY activities');

      const checkIn = new Date(`${dto.checkInDate}T00:00:00Z`);
      const checkOut = new Date(`${dto.checkOutDate}T00:00:00Z`);
      if (checkOut <= checkIn) throw new BadRequestException('Check-out date must be after check-in date');

      const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
      // durationValue on a DAILY activity is the MINIMUM nights (mirrors HOURLY's
      // durationValue minimum): the customer must book at least that many but may
      // extend freely (and pays per night). null = flexible (any stay ≥ 1 night).
      if (activity.durationValue !== null && activity.durationValue !== undefined) {
        if (nights < activity.durationValue) {
          throw new BadRequestException(
            `This activity requires a minimum stay of ${activity.durationValue} night(s)`,
          );
        }
      }
      // DoS bound — caps the per-night price loop + the special-price `in` query.
      if (nights > MAX_BOOKING_NIGHTS) {
        throw new BadRequestException(`A stay cannot exceed ${MAX_BOOKING_NIGHTS} nights`);
      }

      startDatetime = buildDatetime(dto.checkInDate, activity.checkInTime ?? '14:00');
      endDatetime = buildDatetime(dto.checkOutDate, activity.checkOutTime ?? '11:00');
    }

    // Vendor availability lock. Checked here, before the Redis lock + capacity
    // transaction, so a locked slot fails fast with a clear message rather than
    // appearing as "no capacity".
    //   Both HOURLY and DAILY → RANGE OVERLAP: reject if the booking's full
    //   range [start, end) crosses any locked window, even when it starts before
    //   the lock. A 3-hour or 3-night booking may not span an off-hour / off-day.
    //   Half-open overlap: block.start < booking.end && block.end > booking.start.
    const blockWhere = { blockStart: { lt: endDatetime }, blockEnd: { gt: startDatetime } };
    const overlappingBlock = await db.activityBlock.findFirst({
      where: { activityId: dto.activityId, deletedAt: null, ...blockWhere },
      select: { id: true },
    });
    if (overlappingBlock) {
      throw new BadRequestException('This date/time is not available for booking');
    }

    // FIX #12: Prevent duplicate bookings (same user, same activity, same time).
    // Uses activeBookingFilter so an EXPIRED PENDING (reservedUntil passed) does
    // NOT count — an abandoned checkout whose slot is already free must not block
    // the owner from re-booking it (the stale row is reaped by the cleanup cron).
    // This decouples the re-book UX from the cron's grace window entirely.
    const existingBooking = await db.booking.findFirst({
      where: {
        customerId: userId,
        activityId: dto.activityId,
        startDatetime,
        endDatetime,
        ...activeBookingFilter(new Date()),
      },
    });
    if (existingBooking) {
      throw new ConflictException('You already have a booking for this time slot');
    }

    // 5. Acquire distributed Redis lock for this slot before entering the DB transaction.
    //    This prevents multiple pods from simultaneously trying to book the same slot,
    //    reducing Serializable isolation conflicts under high load.
    //    Lock TTL = 30s (enough for the transaction to complete).
    //    If Redis is down, acquire() fails open (returns a token) so booking still proceeds.
    const lockKey = RedisLockService.buildSlotKey({
      activityId: dto.activityId,
      date: dto.checkInDate,
      slot: dto.slotTime ?? 'daily',
    });
    const lockToken = await this.redisLock.acquire(lockKey, this.redisLockTtlMs);
    if (!lockToken) {
      throw new BusinessConflictException(
        'BOOKING.SLOT_BUSY',
        'This slot is currently being booked. Please try again in a moment.',
      );
    }

    // Availability check + booking creation in a transaction (atomic).
    // Lock is released in the finally block regardless of outcome.
    // Serializable isolation: concurrent loser gets a serialization error → 409.
    const txNow = new Date();
    const reservedUntil = new Date(txNow.getTime() + this.reservationWindowMinutes * 60 * 1000);

    let booking: Awaited<ReturnType<typeof db.booking.create>>;
    try {
      booking = await db.$transaction(async (tx) => {
        // Note: if a Prisma serialization error (P2034) is thrown inside the
        // transaction callback, it is re-thrown as-is and caught below.


        // ── Unit auto-assign & final capacity check ──
        // For flex-start hourly slots, two bookings can overlap the query
        // window without ever being concurrent at the same instant. Using a
        // plain `sum(guests)` of overlapping bookings (the original approach)
        // over-counts and rejects valid bookings. We instead fetch the
        // overlapping bookings once and use the `maxConcurrentInWindow`
        // sweep-line helper to compute the true peak concurrent guest count
        // inside [startDatetime, endDatetime). This is both correct and
        // safe — the sweep is strictly monotonic in required capacity.
        //
        // Query stays on indexed fields (activityId + the two datetime columns)
        // so no new index is required.
        // Booking-creation conflict scan is bounded by the same env cap as
        // availability. The query is a single-activity, single-slot-window
        // window — realistically a few hundred rows max — but we cap anyway
        // so a pathological misconfig can't freeze a booking transaction.
        const windowBookings = await tx.booking.findMany({
          where: {
            activityId: dto.activityId,
            ...activeBookingFilter(txNow),
            startDatetime: { lt: endDatetime },
            endDatetime: { gt: startDatetime },
          },
          select: { startDatetime: true, endDatetime: true, guests: true, unitNumber: true },
          take: Number(process.env.AVAILABILITY_MAX_DAY_BOOKINGS || 5000),
        });

        if (activity.hasUnits && activity.unitCount > 0) {
          const wholeUnit = rentsWholeUnit(activity);
          for (let unitNum = 1; unitNum <= activity.unitCount; unitNum++) {
            const unitBookings = windowBookings.filter((b) => b.unitNumber === unitNum);
            if (wholeUnit) {
              // Whole-unit rental (rooms / per-unit): a unit is available ONLY if
              // nothing overlaps it — one booking owns the entire unit, no seat-
              // sharing, regardless of guest count.
              if (unitBookings.length === 0) {
                resolvedUnitNumber = unitNum;
                capacityLimit = activity.unitCapacity;
                break;
              }
            } else {
              // Per-person units: pack into the first unit with enough free seats.
              const peak = maxConcurrentInWindow(unitBookings, startDatetime, endDatetime);
              if (activity.unitCapacity - peak >= dto.guests) {
                resolvedUnitNumber = unitNum;
                capacityLimit = activity.unitCapacity;
                break;
              }
            }
          }
          if (!resolvedUnitNumber) {
            throw new BusinessConflictException(
              'BOOKING.CAPACITY_FULL',
              'All units are fully booked for this time',
              { available: 0, requested: dto.guests },
            );
          }
        }

        // Final availability check — max-concurrent within the requested window.
        // If we auto-assigned a unit above, constrain to bookings in that unit.
        const finalBookings = resolvedUnitNumber
          ? windowBookings.filter((b) => b.unitNumber === resolvedUnitNumber)
          : windowBookings;
        const peakConcurrent = maxConcurrentInWindow(finalBookings, startDatetime, endDatetime);
        const available = capacityLimit === Infinity ? Infinity : capacityLimit - peakConcurrent;

        if (dto.guests > available) {
          throw new ConflictException({
            message: available <= 0
              ? 'This slot is fully booked'
              : `Only ${available} seat${available === 1 ? '' : 's'} available`,
            available,
            requested: dto.guests,
          });
        }

        // FIX #24: Validate guestBreakdown sum matches guests
        if (dto.guestBreakdown) {
          const breakdownSum = Object.values(dto.guestBreakdown).reduce((a, b) => a + b, 0);
          if (breakdownSum !== dto.guests) {
            throw new BadRequestException(
              `Guest breakdown total (${breakdownSum}) must equal guests (${dto.guests})`,
            );
          }
        }

        // 6. Calculate price
        // Use integer-cents arithmetic to avoid JS floating-point drift.
        // e.g. 99.99 × 7 nights = 699.93 exactly (not 699.9300000000001)
        const priceCents = Math.round(Number(activity.pricePerPerson) * 100);

        let totalPriceCents: number;
        if (activity.bookingType === 'DAILY') {
          // Daily is always per-unit pricing: price × nights (guests don't affect price)
          const checkInD = new Date(`${dto.checkInDate}T00:00:00Z`);
          const checkOutD = new Date(`${dto.checkOutDate!}T00:00:00Z`);
          const DAY_MS = 1000 * 60 * 60 * 24;
          const nights = Math.max(1, Math.round((checkOutD.getTime() - checkInD.getTime()) / DAY_MS));
          // Per-date special prices: each night's date may override the base
          // price. The summed total is frozen on the booking, so editing or
          // removing an override later never changes this booking.
          const nightDates = Array.from({ length: nights }, (_, i) => new Date(checkInD.getTime() + i * DAY_MS));
          const specials = await tx.activitySpecialPrice.findMany({
            where: { activityId: activity.id, deletedAt: null, date: { in: nightDates } },
            select: { date: true, price: true },
          });
          const centsByDate = new Map<string, number>();
          for (const s of specials) centsByDate.set(s.date.toISOString().slice(0, 10), Math.round(Number(s.price) * 100));
          totalPriceCents = nightDates.reduce(
            (sum, d) => sum + (centsByDate.get(d.toISOString().slice(0, 10)) ?? priceCents),
            0,
          );
        } else {
          // Hourly: the stored `pricePerPerson` is the price for a baseline
          // of `durationValue` hours. Bookings longer than that are priced
          // pro-rata per hour:
          //   totalCents = priceCents × hoursBooked / durationValue  (× guests for PER_PERSON)
          //
          // Hours + durationValue are integers (enforced by HH:00 validation
          // + activity config), priceCents is integer — only the final divide
          // needs Math.round to snap to a whole cent. Derived from the SERVER-
          // validated start/end datetimes (never the raw DTO), so a tampered
          // slotEndTime can't bypass the span bounds computed above.
          // Per-date special price: the booking DATE's override (if any) replaces
          // the base, then scales pro-rata by hours. Frozen on the booking.
          const special = await tx.activitySpecialPrice.findFirst({
            where: { activityId: activity.id, deletedAt: null, date: new Date(`${dto.checkInDate}T00:00:00.000Z`) },
            select: { price: true },
          });
          const effectiveCents = special ? Math.round(Number(special.price) * 100) : priceCents;
          const bookedMs = endDatetime.getTime() - startDatetime.getTime();
          const hoursBooked = Math.max(
            activity.durationValue!,
            Math.round(bookedMs / (60 * 60 * 1000)),
          );
          const durHours = activity.durationValue!;
          const perPersonCount = activity.pricingModel === 'PER_UNIT' ? 1 : dto.guests;
          totalPriceCents = Math.round(
            (effectiveCents * hoursBooked * perPersonCount) / durHours,
          );
        }

        // 6b. Calculate selected extras cost
        let extrasCents = 0;
        const selectedExtras: { name: string; price: number; qty: number; perPerson: boolean }[] = [];
        if (dto.selectedExtras?.length && Array.isArray(activity.extraServices)) {
          // Build lookup map (case-insensitive keys)
          const extrasMap = new Map<string, { name: string; price: number; perPerson: boolean }>();
          for (const svc of activity.extraServices as { name: string; price: number; perPerson?: boolean }[]) {
            if (svc.price > 0) extrasMap.set(svc.name.toLowerCase(), { name: svc.name, price: svc.price, perPerson: !!svc.perPerson });
          }
          // Deduplicate customer selections
          const seen = new Set<string>();
          for (const name of dto.selectedExtras) {
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const svc = extrasMap.get(key);
            if (!svc) {
              throw new BadRequestException('One or more selected extras are not available for this activity');
            }
            // Determine quantity: from selectedExtrasQty if provided, otherwise default
            let qty = dto.selectedExtrasQty?.[name] ?? dto.selectedExtrasQty?.[svc.name];
            if (svc.perPerson) {
              // Per-person: customer picks 1..guests, default to guests if not specified
              qty = qty != null ? Math.min(Math.max(1, Math.floor(qty)), dto.guests) : dto.guests;
            } else {
              // Per-booking: always 1
              qty = 1;
            }
            const cost = svc.price * qty;
            extrasCents += Math.round(cost * 100);
            selectedExtras.push({ name: svc.name, price: svc.price, qty, perPerson: svc.perPerson });
          }
        }

        totalPriceCents += extrasCents;
        const totalPrice = totalPriceCents / 100;
        const serviceFee = Number(activity.country.serviceFeeFixed);
        const currencyCode = activity.country.currencyCode ?? 'QAR';

        // 6c. Calculate commission — priority: vendor override > category override > platform default
        let commissionPct = 0;
        if (activity.vendor.commissionPct !== null && activity.vendor.commissionPct !== undefined) {
          commissionPct = Number(activity.vendor.commissionPct);
        } else if (activity.category?.commissionPct !== null && activity.category?.commissionPct !== undefined) {
          commissionPct = Number(activity.category.commissionPct);
        } else {
          // Platform default — load from PlatformSettings
          const settings = await tx.platformSettings.findUnique({ where: { id: 'default' } });
          commissionPct = settings ? Number(settings.defaultCommissionPct) : 0;
        }
        // 6d. Validate and apply coupon or voucher (mutually exclusive)
        if (dto.couponCode && dto.voucherId) {
          throw new BadRequestException('Cannot use both a coupon code and a voucher');
        }

        let couponCode: string | null = null;
        let couponDiscount = 0;

        // 6d-i. Platform voucher (claimed by customer, no code needed)
        if (dto.voucherId) {
          const claimed = await tx.claimedCoupon.findUnique({
            where: { id: dto.voucherId },
            include: {
              coupon: {
                select: {
                  id: true,
                  code: true,
                  status: true,
                  validTo: true,
                  minOrderAmount: true,
                  discountType: true,
                  discountValue: true,
                  maxDiscount: true,
                  usageLimit: true,
                  usedCount: true,
                  applicableActivityIds: true,
                },
              },
            },
          });

          if (!claimed) throw new BadRequestException('Voucher not found');
          if (claimed.userId !== userId) throw new BadRequestException('This voucher does not belong to you');
          if (claimed.used) throw new BadRequestException('This voucher has already been used');
          if (claimed.coupon.status !== 'APPROVED') throw new BadRequestException('This voucher is no longer active');

          const now = new Date();
          if (now > claimed.coupon.validTo) throw new BadRequestException('This voucher has expired');
          // Usage-limit pre-check (read-then-act, fail fast). The authoritative
          // race-safe guard is the conditional updateMany at increment time below.
          if (claimed.coupon.usageLimit != null && claimed.coupon.usedCount >= claimed.coupon.usageLimit) {
            throw new BadRequestException('This voucher has reached its usage limit');
          }

          // Activity scoping (Bug A): a non-empty list restricts the voucher's
          // coupon to those activities only (empty = applies to all).
          if (
            claimed.coupon.applicableActivityIds.length > 0 &&
            !claimed.coupon.applicableActivityIds.includes(activity.id)
          ) {
            throw new BadRequestException('This voucher is not valid for this activity');
          }

          if (claimed.coupon.minOrderAmount && totalPrice < Number(claimed.coupon.minOrderAmount)) {
            throw new BadRequestException(`Minimum order amount for this voucher is ${Number(claimed.coupon.minOrderAmount)}`);
          }

          // Calculate discount
          if (claimed.coupon.discountType === 'PERCENTAGE') {
            couponDiscount = totalPrice * Number(claimed.coupon.discountValue) / 100;
            if (claimed.coupon.maxDiscount) couponDiscount = Math.min(couponDiscount, Number(claimed.coupon.maxDiscount));
          } else {
            couponDiscount = Math.min(Number(claimed.coupon.discountValue), totalPrice);
          }
          couponDiscount = Math.round(couponDiscount * 100) / 100;
          couponCode = claimed.coupon.code; // stored on booking for accounting, never shown to customer

          // Mark voucher as used + increment coupon usage count. The increment
          // re-asserts the usage limit in the WHERE (conditional updateMany, not
          // a plain update) so two users redeeming the coupon's LAST use at the
          // same time can't both pass the read-then-act pre-check above — the same
          // race fix the typed-code path got in #306. Without this guard the
          // voucher path could push usedCount past usageLimit under concurrency.
          await tx.claimedCoupon.update({ where: { id: dto.voucherId }, data: { used: true } });
          if (claimed.coupon.usageLimit != null) {
            const inc = await tx.coupon.updateMany({
              where: { id: claimed.coupon.id, usedCount: { lt: claimed.coupon.usageLimit } },
              data: { usedCount: { increment: 1 } },
            });
            if (inc.count === 0) {
              throw new BadRequestException('This voucher has reached its usage limit');
            }
            // Auto-expire once the cap is hit so no further uses can slip through,
            // even if a cancellation later decrements usedCount. Once the cap is
            // hit the coupon is permanently closed.
            if (claimed.coupon.usedCount + 1 >= claimed.coupon.usageLimit) {
              await tx.coupon.update({
                where: { id: claimed.coupon.id },
                data: { status: 'EXPIRED' },
              });
            }
          } else {
            await tx.coupon.update({ where: { id: claimed.coupon.id }, data: { usedCount: { increment: 1 } } });
          }
        }

        // 6d-ii. Vendor coupon code (typed manually by customer)
        if (dto.couponCode) {
          const codeUpper = dto.couponCode.toUpperCase().trim();
          const coupon = await tx.coupon.findUnique({ where: { code: codeUpper } });

          if (!coupon) throw new BadRequestException('Invalid coupon code');
          if (coupon.status !== 'APPROVED') throw new BadRequestException('This coupon is not active');

          const now = new Date();
          if (now < coupon.validFrom) throw new BadRequestException('This coupon is not yet valid');
          if (now > coupon.validTo) throw new BadRequestException('This coupon has expired');
          if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
            throw new BadRequestException('This coupon has reached its usage limit');
          }

          // Per-user uniqueness: a customer may only use the same coupon code once
          // across all their non-cancelled bookings.
          const priorUse = await tx.booking.findFirst({
            where: {
              customerId: userId,
              couponCode: codeUpper,
              status: { not: 'CANCELLED' },
            },
            select: { id: true },
          });
          if (priorUse) {
            throw new BadRequestException('You have already used this coupon');
          }

          // Vendor-specific coupon must match activity's vendor
          if (coupon.vendorId && coupon.vendorId !== activity.vendor.id) {
            throw new BadRequestException('This coupon is not valid for this activity');
          }

          // Activity scoping (Bug A): a non-empty list restricts the coupon to
          // those activities only (empty = applies to all). Authoritative guard —
          // the UI selector + validateCoupon preview can be bypassed, this can't.
          if (
            coupon.applicableActivityIds.length > 0 &&
            !coupon.applicableActivityIds.includes(activity.id)
          ) {
            throw new BadRequestException('This coupon is not valid for this activity');
          }

          // Minimum order amount check (against pre-discount totalPrice)
          if (coupon.minOrderAmount && totalPrice < Number(coupon.minOrderAmount)) {
            throw new BadRequestException(`Minimum order amount for this coupon is ${Number(coupon.minOrderAmount)}`);
          }

          // Calculate discount
          if (coupon.discountType === 'PERCENTAGE') {
            couponDiscount = totalPrice * Number(coupon.discountValue) / 100;
            if (coupon.maxDiscount) couponDiscount = Math.min(couponDiscount, Number(coupon.maxDiscount));
          } else {
            couponDiscount = Math.min(Number(coupon.discountValue), totalPrice);
          }
          couponDiscount = Math.round(couponDiscount * 100) / 100;
          couponCode = codeUpper;

          // Increment usage count with the limit re-asserted in the where —
          // a conditional updateMany, not a plain update. The check above
          // (usedCount >= usageLimit) is a read-then-act; baking the bound
          // into the write closes the window where two bookings racing for a
          // coupon's last use both pass the check and both increment.
          if (coupon.usageLimit) {
            const claimed = await tx.coupon.updateMany({
              where: { id: coupon.id, usedCount: { lt: coupon.usageLimit } },
              data: { usedCount: { increment: 1 } },
            });
            if (claimed.count === 0) {
              throw new BadRequestException('This coupon has reached its usage limit');
            }
            // Auto-expire once the cap is hit so no further uses can slip through,
            // even if a cancellation later decrements usedCount.
            if (coupon.usedCount + 1 >= coupon.usageLimit) {
              await tx.coupon.update({
                where: { id: coupon.id },
                data: { status: 'EXPIRED' },
              });
            }
          } else {
            await tx.coupon.update({
              where: { id: coupon.id },
              data: { usedCount: { increment: 1 } },
            });
          }
        }

        // Apply coupon discount to totalPrice (discount reduces vendor share, not service fee)
        let afterCouponPrice = Math.round((totalPrice - couponDiscount) * 100) / 100;

        // 6e. Loyalty points redemption — ATOMIC, covers vendor share + service fee
        //
        // Three critical properties:
        //  1) The deduction is atomic (no TOCTOU race). Two parallel booking
        //     attempts from the same user can't both pass the balance check
        //     and drain below zero — `LoyaltyService.redeem` uses
        //     `updateMany WHERE loyaltyPoints >= amount` + count check.
        //  2) We never debit more points than the discount actually uses —
        //     the cap is computed from the server-derived gross payable,
        //     never from the client (a tampered redeemPoints can't ride past
        //     the qarPerPoint × gross bound).
        //  3) Points may cover the service fee as well as the vendor's
        //     share. When they cover the full gross, `payableAmount` falls
        //     to 0 and the PAY2M step is skipped entirely via the CONFIRMED
        //     branch below. Customer's entire balance comes back on cancel
        //     via `pointsRedeemed` — the same path paid bookings use.
        //
        // Every redemption writes one LoyaltyLedger row with source
        // BOOKING_REDEEM — reconstructable per user.
        let pointsRedeemed = 0;
        let pointsDiscount = 0;
        // Effective service fee charged on this booking. Starts at the
        // country's fixed amount; may be waived (→ 0) when the customer
        // pays with Wanasa points that fully cover the activity price —
        // the platform swallows the fee as a loyalty-program incentive.
        // Partial redemptions (customer still pays some cash) keep the fee.
        let effectiveServiceFee = serviceFee;

        if (dto.redeemPoints && dto.redeemPoints > 0) {
          // Points are QAR-denominated (1 point = 1 QAR), so fractional
          // redemption is valid (e.g. redeem 5.50 points = 5.50 QAR). Round to
          // 2 dp — no longer floored to whole points.
          const redeemAmount = Math.round(dto.redeemPoints * 100) / 100;

          // Load loyalty config for conversion rate + minimum redemption
          let loyaltyConfig = await tx.loyaltyConfig.findUnique({ where: { id: 'singleton' } });
          if (!loyaltyConfig) {
            loyaltyConfig = await tx.loyaltyConfig.create({ data: { id: 'singleton' } });
          }

          // Enforce minimum on the user's REQUESTED amount (their intent).
          if (redeemAmount < loyaltyConfig.minRedemption) {
            throw new BadRequestException(
              `Minimum redemption is ${loyaltyConfig.minRedemption} points`,
            );
          }

          const qarPerPoint = loyaltyConfig.qarPerPoint.toNumber();
          if (qarPerPoint <= 0) {
            // Misconfigured config — treat as "no redemption" rather than /0.
            throw new BadRequestException('Points redemption is disabled');
          }

          const rawDiscount = redeemAmount * qarPerPoint;
          const activityPrice = Math.round(afterCouponPrice * 100) / 100;

          if (rawDiscount >= activityPrice) {
            // "Pay with Wanasa" path — customer's points fully cover the
            // activity price (post-coupon). Waive the service fee and cap
            // the redemption at exactly what's needed, so extra points
            // aren't burned on a waived fee. Points are fractional QAR now, so
            // this is an exact 2-dp amount (was Math.ceil for whole points).
            pointsRedeemed = Math.round((activityPrice / qarPerPoint) * 100) / 100;
            pointsDiscount = activityPrice;
            effectiveServiceFee = 0;
          } else {
            // Partial redemption — customer still pays the remaining price
            // + full service fee via PAY2M. Cap at activity price because
            // the fee is never reduced by points (either kept or waived).
            pointsRedeemed = redeemAmount;
            pointsDiscount = Math.round(rawDiscount * 100) / 100;
          }
          // NOTE: we DO NOT subtract pointsDiscount from afterCouponPrice.
          // Wanasa points are platform-issued store credit backed by the
          // platform's cash float, NOT a vendor-side discount. The vendor
          // delivered a service worth `afterCouponPrice` — they're entitled
          // to that full amount (minus commission) regardless of how the
          // customer covered it. The customer's point redemption reduces
          // what the CUSTOMER pays (via payableAmount below) but never
          // reduces the vendor's earnings.
          //
          // The actual atomic balance debit happens AFTER booking.create so
          // the ledger row carries the real booking ID.
        }

        // Vendor's earned amount = post-coupon activity value. Same for cash
        // bookings, Wanasa-paid bookings, and partial-redemption bookings.
        const finalTotalPrice = afterCouponPrice;

        // Commission is taken from the vendor's full earned amount — not a
        // reduced figure for Wanasa bookings. Platform earns commission on
        // every booking regardless of payment method.
        const commissionAmount = Math.round(finalTotalPrice * commissionPct) / 100;

        // 7. Create booking ref
        const ref = `JDWL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

        // payableAmount = customer's cash-due via PAY2M. Points directly
        // reduce what the customer pays out of pocket; they don't touch the
        // vendor's totalPrice. Service fee is already 0 if Wanasa fully
        // covers (set above).
        const payableAmount = Math.max(
          0,
          Math.round((finalTotalPrice + effectiveServiceFee - pointsDiscount) * 100) / 100,
        );

        // 8. Full Wanasa points coverage — skip PAY2M entirely.
        // If the customer's redeemed points fully cover the booking price AND
        // the service fee is 0, there's nothing left to charge via PAY2M.
        // Create the booking as CONFIRMED immediately with a synthetic payment
        // record (method='WANASA_POINTS', status=SUCCESS) so the booking
        // lifecycle stays consistent with paid bookings.
        if (payableAmount <= 0) {
          const payment = await tx.payment.create({
            data: {
              amount: 0,
              currency: currencyCode,
              status: 'SUCCESS',
              payoutStatus: 'UNPAID',
              method: 'WANASA_POINTS',
              paidAt: new Date(),
            },
          });
          const createdBooking = await tx.booking.create({
            data: {
              ref,
              activityId: dto.activityId,
              vendorId: activity.vendor.id,
              customerId: userId,
              unitNumber: resolvedUnitNumber,
              startDatetime,
              endDatetime,
              guests: dto.guests,
              bookingPhone: dto.bookingPhone,
              guestBreakdown: dto.guestBreakdown ?? undefined,
              selectedExtras: selectedExtras.length > 0 ? selectedExtras : undefined,
              totalPrice: finalTotalPrice,
              // Wanasa-funded bookings land here — fee was waived above, so
              // effectiveServiceFee=0 is persisted. Every booking list /
              // breakdown view that reads this field will correctly show
              // "no fee charged" for points payments.
              serviceFee: effectiveServiceFee,
              commissionPct,
              commissionAmount,
              couponCode,
              couponDiscount,
              pointsRedeemed,
              pointsDiscount,
              currencyCode,
              idempotencyKey: dto.idempotencyKey ?? null,
              status: 'CONFIRMED',
              paymentId: payment.id,
            },
            include: {
              activity: { select: { titleEn: true, titleAr: true } },
              payment: { select: { id: true, amount: true, status: true } },
            },
          });
          // Populate reverse scalar payments.bookingId (see note below on the
          // standard-flow branch for why this is required even though the
          // Prisma 1-1 FK lives on bookings.paymentId).
          await tx.payment.update({
            where: { id: payment.id },
            data: { bookingId: createdBooking.id },
          });
          // Atomic debit — throws ConflictException if balance insufficient.
          // The throw rolls back the whole Serializable tx, including the
          // booking + payment rows we just created.
          if (pointsRedeemed > 0) {
            await this.loyalty.redeem(tx, {
              userId,
              amount: pointsRedeemed,
              bookingId: createdBooking.id,
              note: `Redeemed on booking ${createdBooking.ref}`,
            });
          }
          return createdBooking;
        }

        // 9. Standard flow — create PENDING payment for PAY2M checkout
        const payment = await tx.payment.create({
          data: {
            amount: payableAmount,
            currency: currencyCode,
            status: 'PENDING',
            payoutStatus: 'UNPAID',
            method: 'PENDING',
          },
        });

        const createdBooking = await tx.booking.create({
          data: {
            ref,
            activityId: dto.activityId,
            vendorId: activity.vendor.id,
            customerId: userId,
            unitNumber: resolvedUnitNumber,
            startDatetime,
            endDatetime,
            guests: dto.guests,
            bookingPhone: dto.bookingPhone,
            guestBreakdown: dto.guestBreakdown ?? undefined,
            selectedExtras: selectedExtras.length > 0 ? selectedExtras : undefined,
            totalPrice: finalTotalPrice,
            // Cash bookings land here — fee stays at country-fixed amount.
            // effectiveServiceFee equals `serviceFee` in this branch because
            // the waiver only triggers when rawDiscount ≥ activityPrice
            // (which routes to the WANASA path above).
            serviceFee: effectiveServiceFee,
            commissionPct,
            commissionAmount,
            couponCode,
            couponDiscount,
            pointsRedeemed,
            pointsDiscount,
            currencyCode,
            idempotencyKey: dto.idempotencyKey ?? null,
            status: 'PENDING',
            reservedUntil,
            paymentId: payment.id,
          },
          include: {
            activity: { select: { titleEn: true, titleAr: true } },
            payment: { select: { id: true, amount: true, status: true } },
          },
        });

        // Populate the reverse scalar payments.bookingId so handleCallback's
        // `select: { bookingId: true }` → `booking.id` lookup works. The column
        // is a separate legacy scalar (not part of the Prisma 1-1 FK, which
        // is owned by bookings.paymentId). The prior absence of this write
        // meant any real PAY2M callback would reject with
        // "Argument `id` must not be null" — a latent prod bug.
        //
        // Also stamp `bookingSnapshot` (§B2 plan) — a server-derived JSON
        // copy of the booking row we just inserted. The PAY2M callback's
        // orphan-recovery branch uses this to atomically re-insert the
        // booking when the cleanup cron deleted it before the success
        // callback arrived. The snapshot is taken from the PERSISTED row
        // (`createdBooking`), never from `dto`, so a malicious DTO that
        // somehow bypassed validation cannot poison the recovery price.
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            bookingId: createdBooking.id,
            bookingSnapshot: buildBookingSnapshot(createdBooking),
          },
        });
        // Atomic debit — see comment on the CONFIRMED branch above.
        if (pointsRedeemed > 0) {
          await this.loyalty.redeem(tx, {
            userId,
            amount: pointsRedeemed,
            bookingId: createdBooking.id,
            note: `Redeemed on booking ${createdBooking.ref}`,
          });
        }
        return createdBooking;
        // timeout: this transaction performs ~10 sequential round-trips
        // (overlap scan, special prices, platform settings, coupon claim,
        // loyalty config, payment + booking insert, payment update, loyalty
        // redeem + ledger). Prisma's DEFAULT is 5s, which this can exceed
        // under load — and the resulting P2028 surfaced as an unmapped generic
        // 500 with no alert.
        //
        // 10s, deliberately BELOW the 15s per-connection statement_timeout set
        // in prisma.service.ts. Setting it equal (as an earlier version did)
        // makes a single stalled statement race two different error paths —
        // Prisma's P2028 vs Postgres's own statement error — so the failure
        // mode becomes nondeterministic. Staying under it means P2028 always
        // wins and the new PRISMA_ERROR_5XX alert fires predictably.
        //
        // maxWait: LEFT AT PRISMA'S 2s DEFAULT. An earlier version raised this
        // to 5s while claiming it made a saturated pool "fail fast" — that is
        // backwards. maxWait is how long a request waits FOR a pool
        // connection, so raising it makes saturation last longer, holding a
        // slot (pool max 20/task) and Serializable predicate locks for a
        // combined worst case of 20s instead of 12s.
      }, { isolationLevel: 'Serializable', timeout: 10_000, maxWait: 2_000 });
    } catch (err) {
      // P2034 = PostgreSQL serialization failure (two transactions conflicted).
      // Without this catch, NestJS returns 500. Map it to 409 so the frontend
      // can tell the customer "slot is busy, try again" rather than showing a crash.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
        throw new ConflictException('This slot is busy right now. Please try again in a moment.');
      }
      throw err;
    } finally {
      // Always release the lock — whether transaction succeeded, threw, or timed out
      await this.redisLock.release(lockKey, lockToken);
    }

    // Post-transaction: get accurate live availability
    const postAgg = await db.booking.aggregate({
      where: {
        activityId: dto.activityId,
        unitNumber: resolvedUnitNumber ?? undefined,
        status: { notIn: ['CANCELLED'] },
        startDatetime: { lt: booking.endDatetime },
        endDatetime: { gt: booking.startDatetime },
      },
      _sum: { guests: true },
    });
    const totalBookedNow = postAgg._sum.guests ?? 0;

    // Audit log: customer created a booking. Also pull email so we can
    // send the email-OTP (PENDING flow) right after this block.
    const auditUser = await db.user.findUnique({
      where: { id: userId },
      select: { fullName: true, email: true, bookingOtpVerifiedAt: true },
    });
    this.auditLogger.log({
      actorType: 'CUSTOMER',
      actorId: userId,
      actorName: auditUser?.fullName || `Customer ${userId.slice(0, 8)}`,
      action: 'BOOKING_CREATED',
      entity: 'Booking',
      entityId: booking.id,
      details: JSON.stringify({
        activityId: dto.activityId,
        guests: dto.guests,
        totalPrice: Number(booking.totalPrice),
        checkInDate: dto.checkInDate,
        ...(dto.couponCode ? { coupon: dto.couponCode } : {}),
        ...(Number(booking.pointsRedeemed) > 0 ? { pointsRedeemed: Number(booking.pointsRedeemed), pointsDiscount: Number(booking.pointsDiscount) } : {}),
      }),
    });

    // Email-OTP gate. PENDING bookings must verify a 6-digit code before
    // /payment/initiate will issue a PAY2M token. CONFIRMED bookings
    // (full-Wanasa-points coverage) skip this — no payment redirect to gate.
    //
    // Once-per-user: the OTP proves "a real human controls this email" and
    // only needs to happen on a customer's FIRST booking. If the user has
    // already cleared a booking OTP before (bookingOtpVerifiedAt is set),
    // the new PENDING booking is born already verified — no OTP email, no
    // entry step; /payment/initiate's gate and the frontend's needsEmailOtp
    // check both see a verified booking and go straight to payment.
    if (booking.status === 'PENDING' && auditUser?.email) {
      if (auditUser.bookingOtpVerifiedAt) {
        // Returning user — skip the OTP entirely.
        await db.booking.update({
          where: { id: booking.id },
          data: { emailOtpVerifiedAt: new Date() },
        });
        booking.emailOtpVerifiedAt = new Date();
      } else {
        // First-time customer — send the OTP. Fire-and-forget: any send
        // error is logged inside the helper and never breaks the booking
        // flow (customer can resend via the dedicated endpoint).
        void this.generateAndSendBookingOtp(
          booking.id,
          auditUser.email,
          auditUser.fullName || 'Customer',
          booking.ref,
        ).catch((err: unknown) => {
          const kind = err instanceof Error ? err.name : 'UnknownError';
          this.logger.warn(`OTP send failed for booking ${booking.id} (${kind})`);
        });
      }
    }

    // Notify vendor + admins ONLY when the booking is already CONFIRMED at
    // create time — this happens for full-Wanasa-points coverage where PAY2M
    // is skipped. PENDING bookings do NOT trigger notifications here; the
    // payment callback handler fires them after PAY2M confirms SUCCESS. This
    // prevents "ghost" notifications for abandoned checkouts where the
    // customer never actually pays.
    //
    // ⚠ IMPORTANT: If a future flow ever confirms a PENDING booking without
    // going through payment.service.handleCallback (e.g. a hypothetical
    // admin-force-confirm endpoint, a manual "confirm by email" flow, or a
    // new payment provider), emit BOOKING_NEW there too — one emit per
    // CONFIRMED transition, and never duplicate. Grep for 'BOOKING_NEW' to
    // find all emit sites before adding a new path.
    if (booking.status === 'CONFIRMED') {
      // Pull `slug` alongside `userId` — the vendor portal is namespaced by
      // slug (/vendor/[slug]/*). Linking to /vendor/<UUID>/bookings 404s.
      // Also pull the vendor user's email + name + preferred language so we
      // can enqueue the vendor booking-notification email in the same block
      // without a second round-trip.
      const vendorUser = await db.vendor.findUnique({
        where: { id: booking.vendorId },
        select: {
          userId: true,
          slug: true,
          user: { select: { email: true, fullName: true, preferredLanguage: true } },
        },
      });
      if (vendorUser) {
        this.notificationService.send({
          userId: vendorUser.userId,
          type: 'BOOKING_NEW',
          title: 'New Booking',
          message: `New booking ${booking.ref} — ${dto.guests} guest(s)`,
          link: `/vendor/${vendorUser.slug}/bookings`,
        });

        // Vendor booking-notification email — fires on every CONFIRMED-at-
        // create-time booking (full-Wanasa-points coverage; PAY2M is skipped).
        // The PAY2M success branch in payment.service.handleCallback enqueues
        // the parallel email for paid bookings. Cross-vendor leak proof:
        // `booking.vendorId` is a non-null FK, vendor.userId is @unique, so
        // exactly one User.email is reachable per booking.
        const vendorEmail = vendorUser.user.email;
        if (vendorEmail && !vendorEmail.endsWith('@deleted.local')) {
          // Mirror the date/time formatting used by the customer enqueue at
          // payment.service.handleCallback (~line 905-913). totalPrice is
          // ALREADY post-coupon (set as afterCouponPrice during create) —
          // subtracting couponDiscount again would double-count the discount.
          // Vendor sees the customer's gross booking value (post-coupon
          // activity price + service fee), Wanasa redemption excluded since
          // points reduce what the customer pays, not what the vendor earns.
          const totalForEmail = Number(booking.totalPrice) + Number(booking.serviceFee);
          const startDate = new Date(booking.startDatetime);
          const dateStr = startDate.toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric',
          });
          const timeStr = activity.bookingType === 'HOURLY'
            ? startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
            : activity.checkInTime ?? undefined;
          try {
            await db.emailOutbox.create({
              data: {
                emailType: 'VENDOR_BOOKING_NOTIFICATION',
                recipient: vendorEmail,
                bookingId: booking.id,
                payload: {
                  vendorName: vendorUser.user.fullName,
                  vendorSlug: vendorUser.slug,
                  bookingRef: booking.ref,
                  bookingId: booking.id,
                  activityTitle: activity.titleEn,
                  date: dateStr,
                  ...(timeStr ? { time: timeStr } : {}),
                  guests: dto.guests,
                  totalAmount: totalForEmail.toFixed(2),
                  currency: booking.currencyCode,
                  customerName: auditUser?.fullName ?? 'Customer',
                  customerPhone: booking.bookingPhone,
                  ...(activity.locationAddress ? { locationAddress: activity.locationAddress } : {}),
                },
              },
            });
          } catch (err: unknown) {
            // Booking is already committed; swallow the enqueue failure to
            // avoid breaking the booking flow. Reconciliation can spot a
            // CONFIRMED booking with no vendor outbox row.
            const kind = err instanceof Error ? err.name : 'UnknownError';
            this.logger.warn(`vendor email enqueue failed for booking ${booking.id} (${kind})`);
          }
        }
      }
      this.notificationService.notifyAdmins({
        type: 'BOOKING_NEW',
        title: 'New Booking',
        message: `Booking ${booking.ref} placed`,
        link: '/admin/bookings',
      });
    }

    // Availability changed for this activity — bump cache version so in-flight
    // and future calendar reads see the new state. Fire-and-forget; any Redis
    // error is logged inside the service and never breaks the booking flow.
    void this.availabilityCache.invalidate(dto.activityId);

    return {
      booking,
      seatsRemaining: capacityLimit === Infinity ? Infinity : Math.max(0, capacityLimit - totalBookedNow),
    };
  }

  // ─── Cancel booking ───────────────────────────────────────────────────────

  /**
   * Customer cancels their own booking.
   *
   * Refund logic enforced by the activity's cancellationPolicy:
   *   FREE_CANCELLATION  → full refund if cancelled 24h+ before start, otherwise no refund
   *   PARTIAL_REFUND     → 50% refund if cancelled 24h+ before start, otherwise no refund
   *   NON_REFUNDABLE     → no refund regardless of timing
   *   null/missing       → treated as FREE_CANCELLATION (customer-friendly default)
   *
   * Admin and vendor cancels always give full refund (handled in their own services).
   */
  async cancelBooking(userId: string, bookingId: string) {
    const db = this.prisma.client;

    // Bake ownership into the where so a guessed bookingId returns 404
    // whether the booking doesn't exist or belongs to another customer.
    const booking = await db.booking.findFirst({
      where: { id: bookingId, customerId: userId },
      include: {
        activity: {
          select: {
            titleEn: true, checkInTime: true, bookingType: true,
            cancellationPolicy: true,
            country: { select: { defaultTimezone: true } },
          },
        },
        // gatewayBasketId is required to detect an IN-FLIGHT PAY2M session: its
        // presence means the customer reached the gateway, so a capture may
        // still land after this cancel and the payment row must NOT be deleted.
        payment: { select: { id: true, status: true, amount: true, gatewayBasketId: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    // Use couponCode from the booking row (frozen at booking time); not from the activity.
    const appliedCoupon = booking.couponCode;
    if (booking.status === 'CANCELLED') throw new BadRequestException('Booking is already cancelled');
    if (booking.status === 'COMPLETED') throw new BadRequestException('Cannot cancel a completed booking');

    // startDatetime is local wall-clock tagged UTC (buildDatetime), so we must
    // measure "hours until start" against NOW in the activity's timezone — not
    // raw Date.now(). Otherwise, in a +offset country (e.g. Qatar UTC+3) this
    // stayed positive for hours AFTER the activity really began, letting a
    // customer cancel mid-activity. This value also drives the refund-deadline
    // math below, so fixing it here corrects both the guard and the refund window.
    const activityTz = booking.activity.country?.defaultTimezone ?? 'UTC';
    const hoursUntilStart = (booking.startDatetime.getTime() - nowInTimezone(activityTz).getTime()) / (1000 * 60 * 60);
    if (hoursUntilStart < 0) {
      throw new BadRequestException('Cannot cancel a booking that has already started');
    }

    const wasPaid = booking.payment?.status === 'SUCCESS';
    const cashPaid = wasPaid ? Number(booking.payment!.amount) : 0;
    const pointsOnly = wasPaid && cashPaid === 0;

    if (pointsOnly) {
      // ── Points-only booking → no cash refund, no vendor queue ──
      // The customer paid entirely with Wanasa points. There's nothing for
      // the vendor to refund in cash, so finalise the cancel directly:
      // payment → REFUNDED (amount 0), booking → CANCELLED, all redeemed
      // points returned atomically inside the same tx. No REFUND_REQUESTED
      // notification is sent to the vendor — that queue is only for paid
      // bookings that need the vendor's explicit refund decision.
      //
      // Cancellation policy is intentionally NOT consulted here: Wanasa
      // points are platform credit, not vendor money, so they always come
      // back (same rule the existing paid-branch applies below). If this
      // business policy ever changes, add the deadline check here and gate
      // the loyalty.refund() call accordingly.
      await db.$transaction(async (tx) => {
        const paymentResult = await tx.payment.updateMany({
          where: { id: booking.payment!.id, status: 'SUCCESS' },
          data: {
            status: 'REFUNDED',
            refundAmount: 0,
            refundedAt: new Date(),
          },
        });
        if (paymentResult.count === 0) {
          // Another writer (admin/vendor cancel, callback) already moved
          // payment out of SUCCESS. Abort so we don't double-refund points.
          throw new ConflictException('Booking state changed concurrently. Please refresh.');
        }

        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: 'CUSTOMER',
            refundDecisionAt: new Date(),
            refundDecisionBy: userId,
            refundDecisionActor: 'CUSTOMER',
            refundDecisionNote: 'Points-only booking — points refunded automatically',
          },
        });

        const redeemedPoints = Number(booking.pointsRedeemed) || 0;
        if (redeemedPoints > 0) {
          await this.loyalty.refund(tx, {
            userId,
            amount: redeemedPoints,
            bookingId,
            source: 'CANCEL_REFUND_PAID',
            actorType: 'CUSTOMER',
            actorId: userId,
            note: `Returned on customer-cancel of points-only booking ${booking.ref}`,
          });
        }
        await refundCouponUsage(tx, appliedCoupon, userId);
      });

      const refundedPoints = Number(booking.pointsRedeemed) || 0;
      const cancelUser = await db.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      this.auditLogger.log({
        actorType: 'CUSTOMER', actorId: userId,
        actorName: cancelUser?.fullName || `Customer ${userId.slice(0, 8)}`,
        action: 'BOOKING_CANCELLED_POINTS_REFUNDED', entity: 'Booking', entityId: bookingId,
        details: JSON.stringify({
          activityTitle: booking.activity.titleEn,
          pointsRefunded: refundedPoints,
        }),
        actionCategory: 'FINANCIAL',
      });

      this.notificationService.send({
        userId,
        type: 'BOOKING_CANCELLED',
        title: 'Booking cancelled',
        message: `Your booking ${booking.ref} has been cancelled. ${refundedPoints.toLocaleString()} Wanasa points have been returned to your balance.`,
        link: `/bookings/${bookingId}`,
      });

      void this.availabilityCache.invalidate(booking.activityId);

      return {
        message: 'Booking cancelled. All Wanasa points have been returned to your balance.',
        deleted: false,
        status: 'REFUNDED',
        pointsRefunded: refundedPoints,
      };
    }

    if (wasPaid) {
      // ── Determine refund based on cancellation policy ──
      const policy = booking.activity.cancellationPolicy ?? 'FREE_CANCELLATION';
      const cancellationDeadlineHours = Number(process.env.CANCELLATION_DEADLINE_HOURS || 24);
      const isWithinDeadline = hoursUntilStart >= cancellationDeadlineHours;

      // PARTIAL_REFUND percentage is env-configurable (default 50). Clamped to
      // [0, 100] so a misconfiguration can never produce an over-refund or a
      // negative number. FREE_CANCELLATION stays hardcoded at 100% because it
      // IS the definition — and NON_REFUNDABLE stays at 0% for the same reason.
      // envNumber handles both undefined AND empty string (e.g. an empty SSM
      // Parameter Store entry) — without it, `??` would pass "" through,
      // Number("") = 0, and partial refunds would silently become 0%.
      const partialRefundPercent = Math.min(100, Math.max(0, envNumber('PARTIAL_REFUND_PERCENT', 50)));

      let refundPercent = 0;
      let refundReason = '';

      if (policy === 'NON_REFUNDABLE') {
        refundPercent = 0;
        refundReason = 'Non-refundable activity';
      } else if (policy === 'PARTIAL_REFUND') {
        if (isWithinDeadline) {
          refundPercent = partialRefundPercent;
          refundReason = `Partial refund (cancelled ${Math.floor(hoursUntilStart)}h before start)`;
        } else {
          refundPercent = 0;
          refundReason = `No refund (cancelled less than ${cancellationDeadlineHours}h before start)`;
        }
      } else {
        // FREE_CANCELLATION or null — always 100% when within deadline
        if (isWithinDeadline) {
          refundPercent = 100;
          refundReason = `Full refund (cancelled ${Math.floor(hoursUntilStart)}h before start)`;
        } else {
          refundPercent = 0;
          refundReason = `No refund (cancelled less than ${cancellationDeadlineHours}h before start)`;
        }
      }

      const totalPaid = Number(booking.payment!.amount);
      const suggestedRefund = refundPercent > 0 ? Number(((totalPaid * refundPercent) / 100).toFixed(2)) : 0;

      // Paid booking → mark CANCELLED + queue a refund request.
      // Payment goes to REFUND_PENDING; the vendor (or admin) records the
      // final decision later via POST /bookings/:id/refund-decision.
      // Optimistic locking on payment.status ensures we only transition
      // from SUCCESS — guards against concurrent cancel + callback races.
      await db.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: 'CUSTOMER',
          },
        });
        const paymentResult = await tx.payment.updateMany({
          where: { id: booking.payment!.id, status: 'SUCCESS' },
          data: {
            status: 'REFUND_PENDING',
            // Pre-fill suggested refund from the cancellation policy —
            // vendor can override when they record their decision.
            refundAmount: suggestedRefund > 0 ? suggestedRefund : null,
          },
        });
        if (paymentResult.count === 0) {
          // Another concurrent writer (payment callback, cron, admin cancel)
          // already moved the payment out of SUCCESS. Abort the transaction.
          throw new ConflictException('Booking state changed concurrently. Please refresh.');
        }

        // Loyalty points are platform-side credit, not vendor money — refund
        // them immediately regardless of the cancellation policy or the
        // vendor's later decision. They always come back. Routed through
        // LoyaltyService so the ledger records the reason (CANCEL_REFUND_PAID).
        const redeemedPoints = Number(booking.pointsRedeemed) || 0;
        if (redeemedPoints > 0) {
          await this.loyalty.refund(tx, {
            userId,
            amount: redeemedPoints,
            bookingId,
            source: 'CANCEL_REFUND_PAID',
            actorType: 'CUSTOMER',
            actorId: userId,
            note: `Returned on customer-cancel of paid booking ${booking.ref}`,
          });
        }
        await refundCouponUsage(tx, appliedCoupon, userId);
      });

      // Audit + notify vendor about the NEW pending request
      const cancelUser = await db.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      this.auditLogger.log({
        actorType: 'CUSTOMER', actorId: userId,
        actorName: cancelUser?.fullName || `Customer ${userId.slice(0, 8)}`,
        action: 'BOOKING_CANCELLED_AWAITING_REFUND', entity: 'Booking', entityId: bookingId,
        details: JSON.stringify({
          activityTitle: booking.activity.titleEn,
          policy,
          suggestedRefundPercent: refundPercent,
          suggestedRefundAmount: suggestedRefund,
          refundReason,
        }),
        actionCategory: 'FINANCIAL',
      });
      const cancelVendor = await db.vendor.findUnique({ where: { id: booking.vendorId }, select: { userId: true, slug: true } });
      // Vendor gets REFUND_REQUESTED so it's distinguishable from other
      // cancellations in their bell — this is actionable work for them.
      if (cancelVendor) {
        this.notificationService.send({
          userId: cancelVendor.userId,
          type: 'REFUND_REQUESTED',
          title: 'New refund request',
          message: `${booking.ref}: ${booking.activity.titleEn} cancelled by customer. Suggested refund: ${suggestedRefund > 0 ? `${suggestedRefund}` : 'none'} (${refundReason}).`,
          link: `/vendor/${cancelVendor.slug}/refund-requests`,
        });
      }

      // Customer gets a BOOKING_CANCELLED marker (informational, not actionable).
      this.notificationService.send({
        userId,
        type: 'BOOKING_CANCELLED',
        title: 'Cancellation submitted',
        message: `Your booking ${booking.ref} has been cancelled. The vendor will review your refund request — any approved amount will be added as Wanasa points to your balance.`,
        link: `/bookings/${bookingId}`,
      });

      void this.availabilityCache.invalidate(booking.activityId);

      return {
        message: 'Booking cancelled. The vendor will review and record the refund decision.',
        deleted: false,
        status: 'REFUND_PENDING',
        suggestedRefundPercent: refundPercent,
        suggestedRefundAmount: suggestedRefund,
        refundReason,
      };
    } else if (
      booking.payment &&
      booking.payment.status === 'PENDING' &&
      booking.payment.gatewayBasketId !== null
    ) {
      // ── Unpaid, but a PAY2M session is IN FLIGHT → soft-cancel, never delete ──
      //
      // The customer opened the gateway (a basket id exists) and the payment is
      // still PENDING, so a capture may STILL land after this cancel — the
      // classic "pay in tab A, cancel in tab B" race.
      //
      // Hard-deleting here destroys the payment row (and with it the
      // gatewayBasketId + bookingSnapshot). A late success callback then looks
      // the payment up by gatewayBasketId, finds nothing, and throws
      // "Payment not found" (payment.service.ts) — the customer is charged with
      // NO booking, NO payment row and NO refund, invisible even to
      // reconciliation (which only compares our DB against our DB).
      //
      // This is the exact incident already fixed in the stale-PENDING cron
      // (cleanup.service.ts — "payments are never hard-deleted"); this path was
      // missed. Deleting the BOOKING is equally unsafe: with the booking gone a
      // late capture takes the §B2_ORPHAN branch and RE-CREATES it from the
      // snapshot — resurrecting a booking the customer deliberately cancelled,
      // which payment.service.ts explicitly forbids.
      //
      // So we keep both rows and use the states the recovery logic already
      // understands: payment → FAILED (guarded on PENDING so a capture that won
      // the race is never clobbered), booking → CANCELLED by the customer. A
      // late success then resolves to CANCELLED_REFUND and the money is
      // refunded — the existing, tested path.
      const redeemedPoints = Number(booking.pointsRedeemed) || 0;

      await db.$transaction(async (tx) => {
        // Only flip a payment that is STILL pending, and ABORT if it is not.
        //
        // This is the optimistic lock, not a filter. If a concurrent success
        // callback already moved the row to SUCCESS, count is 0 and the whole
        // cancel must roll back: the callback has committed payment SUCCESS +
        // booking CONFIRMED, and continuing would overwrite that with
        // CANCELLED while returning the coupon and the redeemed points. The
        // customer would be charged, credited back, and left with NO
        // REFUND_PENDING row — recordRefundDecision requires REFUND_PENDING,
        // so the refund queue would be unreachable for that booking.
        //
        // Throwing inside the transaction rolls back refundCouponUsage too,
        // which is why the coupon refund is ordered after this check.
        const flipped = await tx.payment.updateMany({
          where: { id: booking.payment!.id, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        if (flipped.count === 0) {
          // Deliberately does NOT assert the booking is now confirmed. count===0
          // has three causes: a capture won the race (booking CONFIRMED), the
          // stale-PENDING cron soft-FAILed the payment, or a PAY2M failure
          // callback flipped it — in the last two the booking may be gone
          // entirely. Naming only the first would send the user chasing a state
          // that isn't there.
          throw new ConflictException(
            'This booking changed while you were cancelling. Please refresh to see its current state.',
          );
        }

        await refundCouponUsage(tx, appliedCoupon, userId);

        await tx.booking.update({
          where: { id: bookingId },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CUSTOMER' },
        });

        if (redeemedPoints > 0) {
          await this.loyalty.refund(tx, {
            userId,
            amount: redeemedPoints,
            bookingId,
            source: 'CANCEL_REFUND_UNPAID',
            actorType: 'CUSTOMER',
            actorId: userId,
            note: `Returned on customer-cancel with in-flight payment, booking ${booking.ref}`,
          });
        }
      });

      void this.availabilityCache.invalidate(booking.activityId);

      return {
        message: 'Booking cancelled.',
        deleted: false,
        status: 'CANCELLED',
      };
    } else {
      // Unpaid booking → hard-delete entirely. Customer never paid, so this
      // is not a real booking — no money refund, no vendor notification, no
      // history needed. Keeping it would just clutter the customer's
      // /bookings list and the admin/vendor booking views with "ghost" bookings.
      //
      // EXCEPTION — loyalty points: points were deducted from the customer's
      // balance at booking-create time (intentional, so double-booking with
      // the same points is impossible). When the booking is thrown away,
      // those points MUST be returned — otherwise we burn their balance for
      // a booking that never existed. Same reason cash refunds go back in
      // the wasPaid branch above: customer-side credit must always round-trip.
      const redeemedPoints = Number(booking.pointsRedeemed) || 0;

      await db.$transaction(async (tx) => {
        // Refund the coupon "use" before hard-delete — the booking row is
        // about to disappear, and the coupon lives on independently.
        await refundCouponUsage(tx, appliedCoupon, userId);

        // Detach payment FK before deleting
        if (booking.payment) {
          await tx.booking.update({ where: { id: bookingId }, data: { paymentId: null } });
          await tx.payment.delete({ where: { id: booking.payment.id } });
        }
        await tx.booking.delete({ where: { id: bookingId } });

        // Refund through LoyaltyService — writes a ledger row with source
        // CANCEL_REFUND_UNPAID. The ledger row's bookingId is a soft pointer
        // (no FK) so deleting the booking above doesn't invalidate the entry.
        if (redeemedPoints > 0) {
          await this.loyalty.refund(tx, {
            userId,
            amount: redeemedPoints,
            bookingId,
            source: 'CANCEL_REFUND_UNPAID',
            actorType: 'CUSTOMER',
            actorId: userId,
            note: `Returned on customer-cancel before payment, booking ${booking.ref}`,
          });
        }
      });

      void this.availabilityCache.invalidate(booking.activityId);

      return { message: 'Booking removed.', deleted: true, pointsRefunded: redeemedPoints };
    }
  }

  // ─── Refund decision (vendor / admin) ─────────────────────────────────────

  /**
   * Records the vendor or admin's refund decision for a customer-cancelled
   * booking. The actual money movement happens outside our system (PAY2M
   * dashboard or manual) — this endpoint is purely a ledger entry.
   *
   * Security model:
   *   - Caller must be ADMIN, or the owner of the vendor that holds this booking
   *   - Payment.status MUST be REFUND_PENDING (idempotent — can't be called twice)
   *   - Amount is validated 0 ≤ amount ≤ originally paid amount
   *   - Optimistic locking on payment.status prevents double-decision races
   *   - Note is plain text, length-capped, sanitised by global SanitizePipe
   *
   * Audit trail captures: who decided, when, action taken, amount, note.
   */
  async recordRefundDecision(
    userId: string,
    userRole: string,
    bookingId: string,
    action: 'APPROVE' | 'REJECT',
    amount: number | undefined,
    note: string | undefined,
  ) {
    const db = this.prisma.client;

    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, ref: true, status: true, vendorId: true, customerId: true,
        activity: { select: { titleEn: true } },
        vendor: { select: { userId: true, slug: true } },
        // payoutStatus is needed to detect a refund on a booking whose vendor
        // has ALREADY been paid — money out twice unless finance claws it back.
        payment: { select: { id: true, status: true, amount: true, payoutStatus: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!booking.payment) throw new BadRequestException('No payment associated with this booking');
    if (booking.status !== 'CANCELLED') {
      throw new BadRequestException('Refund decisions can only be recorded on cancelled bookings');
    }
    if (booking.payment.status !== 'REFUND_PENDING') {
      throw new ConflictException('This refund request has already been decided');
    }

    // ── RBAC: must be admin or the vendor that owns the booking ──
    const isAdmin = userRole === 'ADMIN';
    const isVendorOwner = userRole === 'VENDOR' && booking.vendor.userId === userId;
    if (!isAdmin && !isVendorOwner) {
      throw new ForbiddenException('Not authorised to decide this refund');
    }

    const paidAmount = Number(booking.payment.amount);

    // ── Resolve final refund amount ──
    // REJECT → always 0.
    // APPROVE → must be a finite number, non-negative, ≤ original paid amount.
    let finalAmount: number;
    if (action === 'REJECT') {
      finalAmount = 0;
    } else {
      if (amount === undefined || amount === null || !Number.isFinite(amount)) {
        throw new BadRequestException('Amount is required when approving a refund');
      }
      if (amount < 0) throw new BadRequestException('Amount cannot be negative');
      if (amount > paidAmount) {
        throw new BadRequestException(`Amount cannot exceed the original payment of ${paidAmount}`);
      }
      // Round to 2 decimals to match the schema's Decimal(10,2)
      finalAmount = Number(amount.toFixed(2));
    }

    const actor: 'VENDOR' | 'ADMIN' = isAdmin ? 'ADMIN' : 'VENDOR';
    const safeNote = note ? note.slice(0, 1000) : null;

    // ── Load loyalty config for Wanasa points conversion ──
    // Refund money is NOT returned to the customer's card. Instead, the
    // approved amount is converted to Wanasa loyalty points (store credit)
    // at the current qarPerPoint rate. Like AliExpress / Amazon credits.
    let loyaltyConfig = await db.loyaltyConfig.findUnique({ where: { id: 'singleton' } });
    if (!loyaltyConfig) {
      loyaltyConfig = await db.loyaltyConfig.create({ data: { id: 'singleton' } });
    }
    const qarPerPoint = loyaltyConfig.qarPerPoint.toNumber();

    // Points conversion: amount / qarPerPoint = how many points the customer gets.
    // Points are QAR-denominated (1 pt = 1 QAR at qarPerPoint = 1.0), so a
    // 200 QAR refund → 200.00 points; a 50.75 QAR refund → 50.75 points. Rounded
    // to 2 dp (money precision) rather than floored to whole points.
    const refundPoints = action === 'APPROVE' && finalAmount > 0 && qarPerPoint > 0
      ? Math.round((finalAmount / qarPerPoint) * 100) / 100
      : 0;

    // ── Commit the decision inside a transaction with optimistic locking ──
    await db.$transaction(async (tx) => {
      const paymentResult = await tx.payment.updateMany({
        where: { id: booking.payment!.id, status: 'REFUND_PENDING' },
        data: {
          status: action === 'APPROVE' ? 'REFUNDED' : 'REJECTED',
          refundAmount: action === 'APPROVE' ? finalAmount : null,
          refundedAt: new Date(),
        },
      });
      if (paymentResult.count === 0) {
        throw new ConflictException('This refund request has already been decided');
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: {
          refundDecisionAt: new Date(),
          refundDecisionBy: userId,
          refundDecisionActor: actor,
          refundDecisionNote: safeNote,
        },
      });

      // Convert the approved refund amount to Wanasa points and credit
      // the customer's balance atomically inside the same transaction.
      // No money goes back to the card — platform keeps the PAY2M charge,
      // customer gets store credit they can spend on future bookings.
      // Routed through LoyaltyService → writes ledger row with source
      // {VENDOR,ADMIN}_REFUND_APPROVED so finance can sum refund credit
      // issued per month.
      if (refundPoints > 0) {
        await this.loyalty.refund(tx, {
          userId: booking.customerId,
          amount: refundPoints,
          bookingId,
          source: actor === 'ADMIN' ? 'ADMIN_REFUND_APPROVED' : 'VENDOR_REFUND_APPROVED',
          actorType: actor,
          actorId: userId,
          note: `Refund of ${finalAmount} converted to ${refundPoints} points for booking ${booking.ref}`,
        });
      }
    });

    // ── Vendor already paid out for a booking we just refunded ──────────────
    // The platform is now out of pocket: the customer has been made whole and
    // the vendor still holds the money. We deliberately do NOT block the
    // refund — the customer must not be held hostage to a bookkeeping problem
    // — but this MUST be visible, because nothing else detects it:
    // reconciliation never looks at payoutStatus, and the payout tables have
    // no clawback flow. Raising it here gives finance a record to act on.
    if (action === 'APPROVE' && finalAmount > 0 && booking.payment.payoutStatus === 'PAID') {
      this.logger.warn({
        event: 'REFUND_ON_PAID_OUT_BOOKING',
        bookingId,
        bookingRef: booking.ref,
        vendorId: booking.vendorId,
        refundAmount: finalAmount,
      });
      this.auditLogger.log({
        actorType: actor,
        actorId: userId,
        actorName: `${actor} ${userId.slice(0, 8)}`,
        action: 'REFUND_ON_PAID_OUT_BOOKING',
        entity: 'Booking',
        entityId: bookingId,
        details: `Refund of ${finalAmount} approved on booking ${booking.ref} whose vendor payout was already marked PAID — clawback required`,
        actionCategory: 'FINANCIAL',
      });
      this.notificationService.notifyAdmins({
        type: 'SYSTEM',
        title: 'Refund on an already-paid-out booking',
        message: `Booking ${booking.ref} was refunded (${finalAmount}) after the vendor payout was marked PAID. The vendor holds funds that must be clawed back.`,
        link: `/admin/bookings/${bookingId}`,
      });
    }

    // ── Audit log ──
    const decider = await db.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    this.auditLogger.log({
      actorType: actor,
      actorId: userId,
      actorName: decider?.fullName || `${actor} ${userId.slice(0, 8)}`,
      action: action === 'APPROVE' ? 'REFUND_APPROVED_AS_POINTS' : 'REFUND_REJECTED',
      entity: 'Booking',
      entityId: bookingId,
      details: JSON.stringify({
        activityTitle: booking.activity.titleEn,
        action,
        refundAmountQAR: finalAmount,
        refundPoints,
        qarPerPointRate: qarPerPoint,
        paidAmount,
        note: safeNote,
      }),
    });

    // ── Notify customer ──
    const customerMessage = action === 'APPROVE'
      ? `Your refund of ${finalAmount} QAR for booking ${booking.ref} has been added as ${refundPoints.toLocaleString()} Wanasa points to your balance.${safeNote ? ` Note: ${safeNote}` : ''}`
      : `Your refund request for booking ${booking.ref} was not approved.${safeNote ? ` Reason: ${safeNote}` : ''}`;
    this.notificationService.send({
      userId: booking.customerId,
      type: 'REFUND_DECIDED',
      title: action === 'APPROVE' ? 'Refund added as Wanasa points' : 'Refund request declined',
      message: customerMessage,
      link: action === 'APPROVE' ? '/profile' : `/bookings/${bookingId}`,
    });

    return {
      message: action === 'APPROVE'
        ? `Refund of ${finalAmount} QAR converted to ${refundPoints.toLocaleString()} Wanasa points`
        : 'Refund request rejected',
      action,
      amount: finalAmount,
      refundPoints,
      decidedBy: actor,
      decidedAt: new Date(),
    };
  }

  // ─── Vendor refund requests queue ─────────────────────────────────────────

  /**
   * Returns all customer-initiated cancellations for this vendor's bookings
   * that are awaiting a refund decision. Used to render the vendor's
   * /refund-requests page. Includes full customer + booking + payment data
   * so the vendor can make an informed decision without opening multiple
   * pages. No pagination by design — assumes the queue stays small.
   */
  async getVendorRefundRequests(vendorUserId: string) {
    const db = this.prisma.client;

    // Resolve vendor by user id (caller must be a VENDOR role user)
    const vendor = await db.vendor.findUnique({
      where: { userId: vendorUserId },
      select: { id: true },
    });
    if (!vendor) throw new ForbiddenException('Vendor profile not found');

    const bookings = await db.booking.findMany({
      where: {
        vendorId: vendor.id,
        status: 'CANCELLED',
        payment: { status: 'REFUND_PENDING' },
      },
      select: {
        id: true,
        ref: true,
        startDatetime: true,
        endDatetime: true,
        guests: true,
        totalPrice: true,
        serviceFee: true,
        commissionPct: true,
        commissionAmount: true,
        couponCode: true,
        couponDiscount: true,
        currencyCode: true,
        selectedExtras: true,
        cancelledAt: true,
        cancelledBy: true,
        createdAt: true,
        customer: {
          // Name/email/phone: the vendor needs these to identify + coordinate the
          // refund for THEIR own customer (disclosed in Privacy §4 Data Sharing).
          // The internal user id is NOT exposed — the vendor UI never uses it and
          // it has no business purpose here (PDPPL data-minimisation).
          select: { fullName: true, email: true, phone: true },
        },
        activity: {
          select: {
            titleEn: true, titleAr: true, slug: true,
            cancellationPolicy: true,
            country: { select: { currencyCode: true } },
          },
        },
        payment: {
          select: { id: true, amount: true, method: true, paidAt: true, refundAmount: true, gatewayTxnId: true },
        },
      },
      orderBy: { cancelledAt: 'asc' },
    });

    return bookings;
  }

  // ─── Get customer bookings ────────────────────────────────────────────────

  async getMyBookings(userId: string, page = 1, limit = 20, status?: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED') {
    const db = this.prisma.client;
    // FIX #28: Cap page number to prevent expensive skip calculations
    const safePage = Math.min(Math.max(1, Math.floor(page)), 1000);
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const skip = (safePage - 1) * safeLimit;
    const where = { customerId: userId, ...(status ? { status } : {}) };

    const [bookings, total] = await Promise.all([
      db.booking.findMany({
        where,
        include: {
          activity: {
            select: {
              titleEn: true, titleAr: true, slug: true, gallery: true, coverImage: true,
              bookingType: true, checkInTime: true, checkOutTime: true,
              country: { select: { currencyCode: true, defaultTimezone: true } },
            },
          },
          payment: { select: { amount: true, status: true, method: true, paidAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      db.booking.count({ where }),
    ]);

    return { data: bookings, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
  }

  async getBookingById(userId: string, bookingId: string) {
    // Ownership baked into where — same 404 for non-existent and not-yours.
    const booking = await this.prisma.client.booking.findFirst({
      where: { id: bookingId, customerId: userId },
      include: {
        activity: {
          select: {
            titleEn: true, titleAr: true, slug: true, gallery: true, coverImage: true,
            locationAddress: true, bookingType: true, cancellationPolicy: true,
            vendor: { select: { businessNameEn: true, slug: true } },
            country: { select: { currencyCode: true, defaultTimezone: true } },
          },
        },
        payment: { select: { id: true, amount: true, status: true, method: true, paidAt: true, createdAt: true, refundAmount: true, refundedAt: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  // ─── Email-OTP verification (booking → payment gate) ──────────────────────

  /** 10 minutes in ms — matches the value shown in the email template. */
  private static readonly BOOKING_OTP_TTL_MS = 10 * 60 * 1000;

  /** Max wrong-code attempts per OTP cycle before the code is invalidated. */
  private static readonly BOOKING_OTP_MAX_ATTEMPTS = 5;

  /**
   * HMAC the 6-digit booking OTP with a server-side pepper instead of a bare
   * SHA-256. The code space is only 10^6, so a leaked emailOtpHash would be
   * trivially reversible offline without a secret key mixed in; the pepper
   * (JWT_SECRET — always set + boot-validated in prod) blocks that. Output is
   * still a 32-byte hex digest, so the downstream constant-time length check is
   * unaffected. OTPs still expire in minutes regardless.
   */
  private hashBookingOtp(code: string): string {
    const pepper =
      this.configService.get<string>('BOOKING_OTP_PEPPER') ||
      this.configService.get<string>('JWT_SECRET') ||
      '';
    return crypto.createHmac('sha256', pepper).update(code).digest('hex');
  }

  /**
   * Generate a fresh 6-digit code, stamp it on the booking, and email it.
   * Used by both the booking-create fire-and-forget path AND the explicit
   * resend endpoint.
   *
   * Plaintext code lives only in the email body and the customer's memory.
   * The DB stores ONLY a peppered HMAC-SHA-256 hex digest. Logs never see the code.
   */
  private async generateAndSendBookingOtp(
    bookingId: string,
    customerEmail: string,
    customerName: string,
    bookingRef: string,
  ): Promise<void> {
    // Cryptographic randomness — NOT Math.random(). 100000-999999 inclusive.
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = this.hashBookingOtp(code);
    const expiry = new Date(Date.now() + BookingsService.BOOKING_OTP_TTL_MS);

    // Stamp hash + expiry + reset attempts. The reset is what makes the
    // resend endpoint actually usable — a customer who burned 5 attempts on
    // a stale code gets a fresh budget on the new code.
    await this.prisma.client.booking.update({
      where: { id: bookingId },
      data: {
        emailOtpHash: codeHash,
        emailOtpExpiry: expiry,
        emailOtpAttempts: 0,
      },
    });

    // Per-recipient quota (10/day for booking-otp, no progressive cooldown
    // — see EmailQuotaService.cooldownExemptTypes). On exhaustion we fail
    // closed silently so the customer must wait — but the booking row is
    // already stamped so the previous-code path still works if they had one.
    const quotaOk = await this.emailQuota.tryConsume(customerEmail, 'booking-otp');
    if (!quotaOk) {
      this.auditLogger.log({
        actorType: 'SYSTEM',
        actorId: 'system',
        actorName: 'system',
        action: 'BOOKING_EMAIL_OTP_QUOTA_BLOCKED',
        entity: 'Booking',
        entityId: bookingId,
        details: JSON.stringify({ bookingRef }),
      });
      return;
    }

    // Direct SES send (NOT via EmailOutbox) — OTP is time-sensitive (10 min).
    // sendBookingOtp returns true even on send-failure (anti-enumeration on
    // the recipient side), so we can't distinguish success here.
    await this.emailService.sendBookingOtp(customerEmail, {
      customerName,
      otpCode: code,
      bookingRef,
      expiresInMinutes: 10,
    });

    // Audit log carries booking ref ONLY. No email, no code.
    this.auditLogger.log({
      actorType: 'SYSTEM',
      actorId: 'system',
      actorName: 'system',
      action: 'BOOKING_EMAIL_OTP_SENT',
      entity: 'Booking',
      entityId: bookingId,
      details: JSON.stringify({ bookingRef }),
    });

    this.securityLogger.log({
      event: 'BOOKING_EMAIL_OTP_SENT',
      details: `Booking ${bookingRef}`,
    });
  }

  /**
   * Resend endpoint. Anti-enumeration: foreign or non-PENDING bookings
   * return the same 404 as a random UUID. Already-verified bookings are
   * a successful no-op (idempotent).
   */
  async sendBookingEmailOtp(userId: string, bookingId: string): Promise<{ ok: true }> {
    const booking = await this.prisma.client.booking.findFirst({
      where: { id: bookingId, customerId: userId, status: 'PENDING' },
      select: {
        id: true,
        ref: true,
        emailOtpVerifiedAt: true,
        customer: { select: { email: true, fullName: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Already verified — idempotent success. Don't send another code.
    if (booking.emailOtpVerifiedAt) return { ok: true };

    await this.generateAndSendBookingOtp(
      booking.id,
      booking.customer.email,
      booking.customer.fullName || 'Customer',
      booking.ref,
    );

    return { ok: true };
  }

  /**
   * Verify a 6-digit code against the stored hash. Constant-time compare.
   * Increments attempts counter atomically BEFORE the compare so even a
   * thrown error costs the customer an attempt — closes the timing-attack
   * window where an attacker could distinguish "wrong code" from "code
   * expired" by error-path latency.
   *
   * On success, stamps emailOtpVerifiedAt + nulls hash to prevent replay.
   * On 5th failure, nulls hash (lock) and requires resend.
   */
  async verifyBookingEmailOtp(
    userId: string,
    bookingId: string,
    code: string,
  ): Promise<{ ok: true }> {
    const booking = await this.prisma.client.booking.findFirst({
      where: { id: bookingId, customerId: userId },
      select: {
        id: true,
        ref: true,
        status: true,
        emailOtpHash: true,
        emailOtpExpiry: true,
        emailOtpAttempts: true,
        emailOtpVerifiedAt: true,
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Idempotent: already verified.
    if (booking.emailOtpVerifiedAt) return { ok: true };

    if (booking.status !== 'PENDING') {
      throw new BadRequestException('This booking does not require verification.');
    }

    if (!booking.emailOtpHash || !booking.emailOtpExpiry) {
      throw new BadRequestException('No active verification code. Please request a new one.');
    }

    if (booking.emailOtpExpiry < new Date()) {
      throw new BadRequestException('Verification code expired. Please request a new one.');
    }

    if (booking.emailOtpAttempts >= BookingsService.BOOKING_OTP_MAX_ATTEMPTS) {
      // Lock the cycle — only a resend can recover.
      await this.prisma.client.booking.update({
        where: { id: bookingId },
        data: { emailOtpHash: null, emailOtpExpiry: null },
      });
      this.securityLogger.log({
        event: 'BOOKING_EMAIL_OTP_LOCKED',
        userId,
        details: `Booking ${booking.ref}`,
      });
      throw new BadRequestException('Too many attempts. Please request a new code.');
    }

    // Atomic increment BEFORE compare — even an exception below leaves
    // the counter advanced. Protects against retry-loop attacks that try
    // to slip through a transient error.
    await this.prisma.client.booking.update({
      where: { id: bookingId },
      data: { emailOtpAttempts: { increment: 1 } },
    });

    const providedHash = this.hashBookingOtp(code);
    const stored = Buffer.from(booking.emailOtpHash, 'hex');
    const provided = Buffer.from(providedHash, 'hex');

    // Defensive: SHA-256 hex digests are always 32 bytes. Length-mismatch
    // means caller bypassed the DTO regex — treat as a wrong code.
    const match =
      stored.length === provided.length &&
      crypto.timingSafeEqual(stored, provided);

    if (!match) {
      this.securityLogger.log({
        event: 'BOOKING_EMAIL_OTP_VERIFY_FAIL',
        userId,
        details: `Booking ${booking.ref}`,
      });
      throw new BadRequestException('Invalid code.');
    }

    // Success. Stamp verifiedAt + null hash (prevents replay even if the
    // same code is somehow re-submitted before page reload).
    await this.prisma.client.booking.update({
      where: { id: bookingId },
      data: {
        emailOtpVerifiedAt: new Date(),
        emailOtpHash: null,
        emailOtpExpiry: null,
      },
    });

    // Mark the user as having cleared a booking OTP at least once. Every
    // future booking they make is born already OTP-verified (see
    // createBooking) — no OTP email, no entry step. First-time-only and
    // race-safe: the `bookingOtpVerifiedAt: null` guard means concurrent
    // verifies and later bookings no-op instead of overwriting the timestamp.
    await this.prisma.client.user.updateMany({
      where: { id: userId, bookingOtpVerifiedAt: null },
      data: { bookingOtpVerifiedAt: new Date() },
    });

    this.securityLogger.log({
      event: 'BOOKING_EMAIL_OTP_VERIFY_OK',
      userId,
      details: `Booking ${booking.ref}`,
    });

    this.auditLogger.log({
      actorType: 'CUSTOMER',
      actorId: userId,
      actorName: `Customer ${userId.slice(0, 8)}`,
      action: 'BOOKING_EMAIL_OTP_VERIFIED',
      entity: 'Booking',
      entityId: bookingId,
      details: JSON.stringify({ bookingRef: booking.ref }),
    });

    return { ok: true };
  }
}
