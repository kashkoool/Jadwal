import { BadRequestException, ConflictException } from '@nestjs/common';
import { isValidDate, buildDatetime, computeSlots, addMonthsClamped } from '../bookings/bookings.service';
import type { CreateActivityBlockDto } from './dto/create-activity-block.dto';

// How far ahead a block may be set (matches the date picker's range).
export const BLOCK_MAX_ADVANCE_MONTHS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MS = 60 * 60 * 1000; // a slot lock captures only bookings STARTING in this 1-hour window

export interface BlockActivity {
  id: string;
  vendorId: string;
  bookingType: string;
  checkInTime: string | null;
  checkOutTime: string | null;
  durationValue: number | null;
}

/**
 * The `activity_blocks_no_overlap` GIST exclusion constraint (migration
 * 20260617000000_activity_block_no_overlap) raises Postgres error 23P01
 * (exclusion_violation) when an insert would overlap an existing ACTIVE block.
 * It is the DB backstop for the check-then-insert race the in-JS overlap checks
 * below cannot fully close under concurrency. We map it to the SAME 409 the JS
 * fast-path returns, so the race-loser gets a clean conflict instead of a 500.
 * (If the constraint isn't deployed yet, this simply never matches — the JS
 * checks still apply, so the code is safe with or without the migration.)
 */
function isBlockOverlapViolation(e: unknown): boolean {
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === '23P01') {
    return true;
  }
  const msg = e instanceof Error ? e.message : '';
  return /23P01|activity_blocks_no_overlap/.test(msg);
}

/**
 * Core "create availability block(s)" logic, shared by the vendor and admin
 * flows so validation can never drift between them.
 *
 * The CALLER must:
 *   - resolve + authorise `activity` (vendor scopes to its own activities;
 *     admin may target any activity), and
 *   - bust the availability cache after this resolves.
 *
 * Blocks are always stamped with the activity's owning `vendorId`. Enforcement
 * lives in BookingsService and is RANGE-OVERLAP for both HOURLY and DAILY — a
 * lock rejects any booking whose [start,end) crosses the locked window, not just
 * one that starts exactly at the locked time.
 */
export async function createActivityBlockCore(
  // Prisma client (or a transaction client) — typed loosely; the concrete
  // client is supplied by the caller (VendorService / AdminService).
  db: any,
  activity: BlockActivity,
  dto: CreateActivityBlockDto,
): Promise<{ id?: string; created?: number; affectedBookings: number; blockStart?: Date; blockEnd?: Date; createdAt?: Date }> {
  // Calendar-date sanity beyond the DTO regex (rejects 2026-02-30 etc.).
  if (!isValidDate(dto.date)) throw new BadRequestException('Invalid date');
  if (dto.endDate && !isValidDate(dto.endDate)) throw new BadRequestException('Invalid end date');
  if (dto.endDate && dto.endDate < dto.date) {
    throw new BadRequestException('endDate must be on or after date');
  }

  // Cap how far ahead a block may be set.
  const maxAhead = addMonthsClamped(new Date(), BLOCK_MAX_ADVANCE_MONTHS);
  const maxAheadStr = maxAhead.toISOString().slice(0, 10);
  if (dto.date > maxAheadStr || (dto.endDate && dto.endDate > maxAheadStr)) {
    throw new BadRequestException(`Cannot block more than ${BLOCK_MAX_ADVANCE_MONTHS} months ahead`);
  }

  // ── Recurring weekly ── block the WHOLE day for every weekday spanned by
  //    [date, endDate], every week for the next 6 months. Whole-day only.
  if (dto.repeatWeekly) {
    if (dto.slotTimes?.length) {
      throw new BadRequestException('A repeat-weekly block covers the whole day — remove the specific times');
    }
    const rangeStart = buildDatetime(dto.date, '00:00');
    const rangeEnd = buildDatetime(dto.endDate ?? dto.date, '00:00');
    const weekdays = new Set<number>();
    for (let t = rangeStart.getTime(); t <= rangeEnd.getTime(); t += DAY_MS) {
      weekdays.add(new Date(t).getUTCDay());
    }
    // Cover through the END of the 6-month-out month so the final month's last
    // weekday occurrences are included (not cut at the exact 6-month date).
    const sixMonthsOut = addMonthsClamped(rangeStart, BLOCK_MAX_ADVANCE_MONTHS);
    const horizonMs = Date.UTC(sixMonthsOut.getUTCFullYear(), sixMonthsOut.getUTCMonth() + 1, 0);
    const existing = await db.activityBlock.findMany({
      where: { activityId: activity.id, deletedAt: null, blockStart: { lt: new Date(horizonMs + DAY_MS) }, blockEnd: { gt: rangeStart } },
      select: { blockStart: true, blockEnd: true },
    });
    const now = Date.now();
    const rows: { activityId: string; vendorId: string; blockStart: Date; blockEnd: Date }[] = [];
    for (let t = rangeStart.getTime(); t <= horizonMs; t += DAY_MS) {
      const dayStart = new Date(t);
      if (!weekdays.has(dayStart.getUTCDay())) continue;
      const dayEnd = new Date(t + DAY_MS);
      if (dayEnd.getTime() <= now) continue; // skip fully-past occurrences
      if (existing.some((b: { blockStart: Date; blockEnd: Date }) => b.blockStart < dayEnd && b.blockEnd > dayStart)) continue; // already blocked
      rows.push({ activityId: activity.id, vendorId: activity.vendorId, blockStart: dayStart, blockEnd: dayEnd });
    }
    if (rows.length === 0) {
      throw new ConflictException('Those weekdays are already blocked for this period');
    }
    let result: { count: number };
    try {
      result = await db.activityBlock.createMany({ data: rows });
    } catch (e) {
      if (isBlockOverlapViolation(e)) throw new ConflictException('Those weekdays overlap an existing block');
      throw e;
    }
    const lastRowEnd = rows[rows.length - 1].blockEnd;
    const nowDate = new Date(now);
    const candidates = await db.booking.findMany({
      where: {
        activityId: activity.id,
        status: { notIn: ['CANCELLED'] },
        NOT: { AND: [{ status: 'PENDING' }, { reservedUntil: { lt: nowDate } }] },
        startDatetime: { lt: lastRowEnd },
        endDatetime: { gt: rangeStart },
      },
      select: { startDatetime: true, endDatetime: true },
    });
    const affectedBookings = candidates.filter((b: { startDatetime: Date; endDatetime: Date }) =>
      rows.some((r) => r.blockStart < b.endDatetime && r.blockEnd > b.startDatetime),
    ).length;
    return { created: result.count, affectedBookings };
  }

  // ── Specific start-time slot locks (HOURLY only) ──
  // Each picked time becomes a [t, t+1h) row. Enforcement (in BookingsService)
  // is RANGE-OVERLAP: a booking is rejected if its [start,end) crosses this
  // window — NOT only one that starts exactly at t. So on a >1h activity a single
  // lock blocks any session that touches that hour.
  if (dto.slotTimes?.length) {
    if (activity.bookingType !== 'HOURLY') {
      throw new BadRequestException('Specific time slots can only be locked on an hourly activity');
    }
    if (dto.endDate && dto.endDate !== dto.date) {
      throw new BadRequestException('Time-slot locks apply to a single date');
    }
    if (!activity.checkInTime || !activity.checkOutTime || !activity.durationValue) {
      throw new BadRequestException('Activity time configuration is incomplete');
    }
    const validSlots = new Set(computeSlots(activity.checkInTime, activity.checkOutTime, activity.durationValue));
    const uniqueTimes = Array.from(new Set(dto.slotTimes));
    for (const t of uniqueTimes) {
      if (!validSlots.has(t)) throw new BadRequestException(`${t} is not a bookable start time for this activity`);
    }

    const now = Date.now();
    const dayStart = buildDatetime(dto.date, '00:00');
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const existing = await db.activityBlock.findMany({
      where: { activityId: activity.id, deletedAt: null, blockStart: { lt: dayEnd }, blockEnd: { gt: dayStart } },
      select: { blockStart: true, blockEnd: true },
    });
    const rows: { activityId: string; vendorId: string; blockStart: Date; blockEnd: Date }[] = [];
    for (const t of uniqueTimes) {
      const start = buildDatetime(dto.date, t);
      const end = new Date(start.getTime() + SLOT_MS);
      if (end.getTime() <= now) continue;                                                                  // past slot
      if (existing.some((b: { blockStart: Date; blockEnd: Date }) => b.blockStart < end && b.blockEnd > start)) continue; // already locked
      rows.push({ activityId: activity.id, vendorId: activity.vendorId, blockStart: start, blockEnd: end });
    }
    if (rows.length === 0) {
      throw new ConflictException('Those times are already locked (or in the past)');
    }
    let result: { count: number };
    try {
      result = await db.activityBlock.createMany({ data: rows });
    } catch (e) {
      if (isBlockOverlapViolation(e)) throw new ConflictException('Those times overlap an existing block');
      throw e;
    }
    const nowDate = new Date(now);
    const earliest = rows.reduce((m, r) => (r.blockStart < m ? r.blockStart : m), rows[0].blockStart);
    const latestEnd = rows.reduce((m, r) => (r.blockEnd > m ? r.blockEnd : m), rows[0].blockEnd);
    const candidates = await db.booking.findMany({
      where: {
        activityId: activity.id,
        status: { notIn: ['CANCELLED'] },
        NOT: { AND: [{ status: 'PENDING' }, { reservedUntil: { lt: nowDate } }] },
        startDatetime: { gte: earliest, lt: latestEnd },
      },
      select: { startDatetime: true },
    });
    const affectedBookings = candidates.filter((b: { startDatetime: Date }) =>
      rows.some((r) => b.startDatetime >= r.blockStart && b.startDatetime < r.blockEnd),
    ).length;
    return { created: result.count, affectedBookings };
  }

  // ── Whole-day block (single date, or [date, endDate] range) ──
  const blockStart = buildDatetime(dto.date, '00:00');
  const lastDay = dto.endDate ?? dto.date;
  const blockEnd = new Date(buildDatetime(lastDay, '00:00').getTime() + DAY_MS);

  if (blockEnd.getTime() <= Date.now()) {
    throw new BadRequestException('Cannot block a date that has already passed');
  }

  const overlap = await db.activityBlock.findFirst({
    where: { activityId: activity.id, deletedAt: null, blockStart: { lt: blockEnd }, blockEnd: { gt: blockStart } },
    select: { id: true },
  });
  if (overlap) throw new ConflictException('This date overlaps an existing block');

  let created;
  try {
    created = await db.activityBlock.create({
      data: { activityId: activity.id, vendorId: activity.vendorId, blockStart, blockEnd },
      select: { id: true, blockStart: true, blockEnd: true, createdAt: true },
    });
  } catch (e) {
    if (isBlockOverlapViolation(e)) throw new ConflictException('This date overlaps an existing block');
    throw e;
  }

  const nowDate = new Date();
  const affectedBookings = await db.booking.count({
    where: {
      activityId: activity.id,
      status: { notIn: ['CANCELLED'] },
      NOT: { AND: [{ status: 'PENDING' }, { reservedUntil: { lt: nowDate } }] },
      startDatetime: { lt: blockEnd },
      endDatetime: { gt: blockStart },
    },
  });
  return { ...created, affectedBookings };
}
