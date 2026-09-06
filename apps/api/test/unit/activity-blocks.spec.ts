/**
 * Vendor availability-block feature — unit tests (mocked Prisma).
 *
 * Covers:
 *  - VendorService block CRUD: ownership 404, invalid/past date, HOURLY-only
 *    time window, overlap conflict, soft-delete, cache invalidation.
 *  - BookingsService enforcement on the read side: getHourlyAvailability zeros
 *    blocked slots; getCalendarAvailability disables a fully-blocked day.
 *
 * The createBooking REJECT path (full 1400-line $transaction) is covered in
 * the integration suite against a real DB, per the existing test strategy.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { VendorService } from '../../src/vendor/vendor.service';
import { BookingsService } from '../../src/bookings/bookings.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuditLoggerService } from '../../src/common/services/audit-logger.service';
import { NotificationService } from '../../src/common/services/notification.service';
import { LoyaltyService } from '../../src/common/services/loyalty.service';
import { RedisLockService } from '../../src/redis/redis-lock.service';
import { AvailabilityCacheService } from '../../src/redis/availability-cache.service';
import { EmailService } from '../../src/email/email.service';
import { EmailQuotaService } from '../../src/email/email-quota.service';
import { SecurityLoggerService } from '../../src/common/services/security-logger.service';
import { ConfigService } from '@nestjs/config';
import { SessionDenylistService } from '../../src/redis/session-denylist.service';
import { makePrismaMock } from '../mocks/prisma.mock';
import { makeConfigMock, makeSessionDenylistMock } from '../mocks/auth-deps.mock';
import {
  makeAuditLoggerMock, makeNotificationMock, makeLoyaltyMock,
  makeRedisLockMock, makeAvailabilityCacheMock,
} from '../mocks/bookings-deps.mock';

const ACTIVE_VENDOR = { id: 'v1', status: 'ACTIVE', countryId: 'QA', businessNameEn: 'Biz' };
// HOURLY activity with slot config — bookable start slots are 08:00..20:00 (2h, 08:00–22:00).
const HOURLY_ACT = { id: 'a1', vendorId: 'v1', bookingType: 'HOURLY', checkInTime: '08:00', checkOutTime: '22:00', durationValue: 2 };

async function buildVendorSut() {
  const prisma = makePrismaMock();
  const cache = makeAvailabilityCacheMock();
  const mod = await Test.createTestingModule({
    providers: [
      VendorService,
      { provide: PrismaService,            useValue: prisma },
      { provide: NotificationService,      useValue: makeNotificationMock() },
      { provide: LoyaltyService,           useValue: makeLoyaltyMock() },
      { provide: AvailabilityCacheService, useValue: cache },
      { provide: SessionDenylistService,   useValue: makeSessionDenylistMock() },
    ],
  }).compile();
  return { sut: mod.get(VendorService), prisma, cache };
}

async function buildBookingsSut() {
  const prisma = makePrismaMock();
  const cache = makeAvailabilityCacheMock();
  const config = makeConfigMock({
    RESERVATION_WINDOW_MINUTES: '15', BOOKING_MAX_ADVANCE_MONTHS: '6', REDIS_LOCK_TTL_MS: '30000',
  });
  const mod = await Test.createTestingModule({
    providers: [
      BookingsService,
      { provide: PrismaService,            useValue: prisma },
      { provide: ConfigService,            useValue: config },
      { provide: AuditLoggerService,       useValue: makeAuditLoggerMock() },
      { provide: NotificationService,      useValue: makeNotificationMock() },
      { provide: LoyaltyService,           useValue: makeLoyaltyMock() },
      { provide: RedisLockService,         useValue: makeRedisLockMock() },
      { provide: AvailabilityCacheService, useValue: cache },
      { provide: EmailService,             useValue: { sendBookingOtp: jest.fn() } },
      { provide: EmailQuotaService,        useValue: { tryConsume: jest.fn() } },
      { provide: SecurityLoggerService,    useValue: { log: jest.fn() } },
    ],
  }).compile();
  return { sut: mod.get(BookingsService), prisma, cache };
}

// ~30 days out: always future AND within the 6-month block cap, regardless of
// when the suite runs.
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// ═══════════════════════════════════════════════════════════════════════════
// VendorService.createActivityBlock
// ═══════════════════════════════════════════════════════════════════════════
describe('VendorService.createActivityBlock', () => {
  test('404 when the activity is not owned by the vendor (ownership collapsed to 404)', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(null);
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE }))
      .rejects.toThrow(NotFoundException);
    expect(ctx.prisma._client.activity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'a1', vendorId: 'v1' }) }),
    );
  });

  test('400 for an impossible calendar date (regex passes, isValidDate rejects)', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: '2026-02-30' }))
      .rejects.toThrow(BadRequestException);
  });

  test('400 when slotTimes are set on a DAILY activity', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, slotTimes: ['12:00'] }))
      .rejects.toThrow(/hourly/i);
  });

  test('400 when a slot time is not a bookable start slot for the activity', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(HOURLY_ACT); // valid slots 08:00..20:00
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, slotTimes: ['21:30'] }))
      .rejects.toThrow(/not a bookable start time/i);
  });

  test('400 when the block is entirely in the past', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: '2020-01-01' }))
      .rejects.toThrow(/passed/i);
  });

  test('409 when all requested slot times are already locked', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(HOURLY_ACT);
    // 12:00 already locked → the requested slot is skipped → nothing left to create.
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([
      { blockStart: new Date(FUTURE_DATE + 'T12:00:00.000Z'), blockEnd: new Date(FUTURE_DATE + 'T13:00:00.000Z') },
    ]);
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, slotTimes: ['12:00'] }))
      .rejects.toThrow(ConflictException);
  });

  test('happy: slotTimes create one [t, t+1h) lock per time via createMany + bust cache', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(HOURLY_ACT);
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([]); // none existing
    ctx.prisma._client.activityBlock.createMany.mockResolvedValueOnce({ count: 2 });
    ctx.prisma._client.booking.findMany.mockResolvedValueOnce([]); // no affected bookings

    const r: any = await ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, slotTimes: ['12:00', '15:00'] });

    expect(r.created).toBe(2);
    const rows = ctx.prisma._client.activityBlock.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.vendorId).toBe('v1');
      expect(row.blockEnd.getTime() - row.blockStart.getTime()).toBe(60 * 60 * 1000); // exactly one hour
    }
    expect(rows.map((x: { blockStart: Date }) => x.blockStart.toISOString()).sort()).toEqual([
      FUTURE_DATE + 'T12:00:00.000Z',
      FUTURE_DATE + 'T15:00:00.000Z',
    ]);
    expect(ctx.cache.invalidate).toHaveBeenCalledWith('a1');
  });

  test('happy: creates a whole-day block and busts the availability cache', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    ctx.prisma._client.activityBlock.findFirst.mockResolvedValueOnce(null); // no overlap
    ctx.prisma._client.activityBlock.create.mockResolvedValueOnce({ id: 'blk1', blockStart: new Date(), blockEnd: new Date(), reason: null, createdAt: new Date() });

    await ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE });

    // Whole-day block on DAILY: [date 00:00, next-day 00:00), vendorId stamped.
    expect(ctx.prisma._client.activityBlock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activityId: 'a1', vendorId: 'v1' }),
      }),
    );
    const arg = ctx.prisma._client.activityBlock.create.mock.calls[0][0].data;
    expect(arg.blockStart.toISOString()).toBe(FUTURE_DATE + 'T00:00:00.000Z');
    expect(arg.blockEnd.getTime() - arg.blockStart.getTime()).toBe(24 * 60 * 60 * 1000); // whole day
    expect(ctx.cache.invalidate).toHaveBeenCalledWith('a1');
  });

  test('reports affectedBookings: existing active bookings overlapping the locked window (does NOT block creation)', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    ctx.prisma._client.activityBlock.findFirst.mockResolvedValueOnce(null); // no overlap
    ctx.prisma._client.activityBlock.create.mockResolvedValueOnce({ id: 'blk1', blockStart: new Date(), blockEnd: new Date(), reason: null, createdAt: new Date() });
    ctx.prisma._client.booking.count.mockResolvedValueOnce(2); // two existing bookings in the window

    const r: any = await ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE });

    expect(r.affectedBookings).toBe(2);
    // Count is scoped to the activity and excludes cancelled bookings.
    expect(ctx.prisma._client.booking.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activityId: 'a1', status: { notIn: ['CANCELLED'] } }),
      }),
    );
  });

  test('repeatWeekly reports affectedBookings overlapping a generated day', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([]); // no existing blocks
    ctx.prisma._client.activityBlock.createMany.mockResolvedValueOnce({ count: 5 });
    // A booking on the seed date's whole day → overlaps the first generated row.
    const dayStart = new Date(FUTURE_DATE + 'T00:00:00.000Z');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    ctx.prisma._client.booking.findMany.mockResolvedValueOnce([{ startDatetime: dayStart, endDatetime: dayEnd }]);

    const r: any = await ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, repeatWeekly: true });

    expect(r.created).toBe(5);
    expect(r.affectedBookings).toBe(1);
  });

  test('rejects a block more than 6 months ahead', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: '2031-01-15' }))
      .rejects.toThrow(/months ahead/i);
  });

  test('repeatWeekly generates whole-day blocks for the weekday(s) via createMany + invalidates cache', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([]); // no existing blocks → no skips
    ctx.prisma._client.activityBlock.createMany.mockResolvedValueOnce({ count: 26 });

    await ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, repeatWeekly: true });

    expect(ctx.prisma._client.activityBlock.createMany).toHaveBeenCalled();
    const rows = ctx.prisma._client.activityBlock.createMany.mock.calls[0][0].data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // Every generated occurrence is a whole-day block (exactly 24h) for the vendor.
    for (const r of rows) {
      expect(r.vendorId).toBe('v1');
      expect(r.blockEnd.getTime() - r.blockStart.getTime()).toBe(24 * 60 * 60 * 1000);
    }
    expect(ctx.cache.invalidate).toHaveBeenCalledWith('a1');
  });

  test('repeatWeekly extends each weekday through the end of the 6-month-out month', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1', vendorId: 'v1', bookingType: 'DAILY' });
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([]);
    ctx.prisma._client.activityBlock.createMany.mockResolvedValueOnce({ count: 0 });

    // Next Friday → the Sunday two days later (a 3-day set that straddles the
    // Sun–Sat week boundary — the case that exposed the cut-off bug).
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    const fri = d.toISOString().slice(0, 10);
    const sun = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);

    await ctx.sut.createActivityBlock('u1', 'a1', { date: fri, endDate: sun, repeatWeekly: true });

    const rows = ctx.prisma._client.activityBlock.createMany.mock.calls[0][0].data;
    const wdSet = new Set<number>();
    rows.forEach((r: { blockStart: Date }) => wdSet.add(r.blockStart.getUTCDay()));
    const weekdays = Array.from(wdSet).sort((a, b) => a - b);
    expect(weekdays).toEqual([0, 5, 6]); // Sun, Fri, Sat all present
    const maxOf = (wd: number) =>
      Math.max(...rows.filter((r: { blockStart: Date }) => r.blockStart.getUTCDay() === wd).map((r: { blockStart: Date }) => r.blockStart.getTime()));
    // Each picked weekday recurs through the END of the 6-month-out month (its
    // last Fri/Sat/Sun of that month), not cut at the exact 6-month date.
    // Month index arithmetic, NOT setUTCMonth: setUTCMonth keeps the
    // day-of-month, so when `fri` lands on a 31st it overflows into the month
    // AFTER the one we mean (Aug 31 + 6 -> "Feb 31" -> Mar 3) and this
    // expectation would silently mirror the very bug the code under test had.
    const friDate = new Date(fri + 'T00:00:00.000Z');
    const targetYm = friDate.getUTCFullYear() * 12 + friDate.getUTCMonth() + 6;
    for (const wd of [0, 5, 6]) {
      const last = new Date(maxOf(wd));
      expect(last.getUTCFullYear() * 12 + last.getUTCMonth()).toBe(targetYm);
    }
  });

  test('repeatWeekly rejects slotTimes (whole-day only)', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(HOURLY_ACT);
    await expect(ctx.sut.createActivityBlock('u1', 'a1', { date: FUTURE_DATE, repeatWeekly: true, slotTimes: ['12:00'] }))
      .rejects.toThrow(/whole day/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VendorService.deleteActivityBlock + getActivityBlocks
// ═══════════════════════════════════════════════════════════════════════════
describe('VendorService.deleteActivityBlock', () => {
  test('404 when the block does not exist / is not the vendor\'s', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1' });
    ctx.prisma._client.activityBlock.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(ctx.sut.deleteActivityBlock('u1', 'a1', 'blk-missing'))
      .rejects.toThrow(NotFoundException);
  });

  test('happy: soft-deletes (scoped by vendor) and busts the cache', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1' });
    ctx.prisma._client.activityBlock.updateMany.mockResolvedValueOnce({ count: 1 });

    await ctx.sut.deleteActivityBlock('u1', 'a1', 'blk1');

    expect(ctx.prisma._client.activityBlock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'blk1', activityId: 'a1', vendorId: 'v1', deletedAt: null }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(ctx.cache.invalidate).toHaveBeenCalledWith('a1');
  });
});

describe('VendorService.deleteActivityBlocksBulk', () => {
  test('soft-deletes the given ids (scoped to vendor) and invalidates cache', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1' });
    ctx.prisma._client.activityBlock.updateMany.mockResolvedValueOnce({ count: 3 });

    const r = await ctx.sut.deleteActivityBlocksBulk('u1', 'a1', ['b1', 'b2', 'b3']);

    expect(r).toEqual({ removed: 3 });
    expect(ctx.prisma._client.activityBlock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['b1', 'b2', 'b3'] }, activityId: 'a1', vendorId: 'v1', deletedAt: null }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(ctx.cache.invalidate).toHaveBeenCalledWith('a1');
  });

  test('404 when the activity is not owned by the vendor', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(null);
    await expect(ctx.sut.deleteActivityBlocksBulk('u1', 'a1', ['b1'])).rejects.toThrow(NotFoundException);
  });
});

describe('VendorService.getActivityBlocks', () => {
  test('404 when activity not owned', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce(null);
    await expect(ctx.sut.getActivityBlocks('u1', 'a1')).rejects.toThrow(NotFoundException);
  });

  test('lists only active (non-deleted) blocks for the activity', async () => {
    const ctx = await buildVendorSut();
    ctx.prisma._client.vendor.findUnique.mockResolvedValueOnce(ACTIVE_VENDOR);
    ctx.prisma._client.activity.findFirst.mockResolvedValueOnce({ id: 'a1' });
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([{ id: 'blk1' }]);
    const r = await ctx.sut.getActivityBlocks('u1', 'a1');
    expect(r).toEqual([{ id: 'blk1' }]);
    expect(ctx.prisma._client.activityBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activityId: 'a1', deletedAt: null }) }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BookingsService.getHourlyAvailability — blocked slots → available 0 + isBlocked
// ═══════════════════════════════════════════════════════════════════════════
describe('BookingsService.getHourlyAvailability with a vendor block', () => {
  const hourlyActivity = {
    id: 'a1', status: 'ACTIVE', bookingType: 'HOURLY',
    checkInTime: '08:00', checkOutTime: '12:00', durationValue: 2,
    hasUnits: false, unitCount: 0, unitCapacity: 1, capacity: 10,
    country: { defaultTimezone: 'UTC' },
  };

  test('START-MATCH: only the slot whose START is in the lock is blocked; capacity is not zeroed', async () => {
    const ctx = await buildBookingsSut();
    ctx.prisma._client.activity.findUnique.mockResolvedValueOnce(hourlyActivity);
    ctx.prisma._client.booking.findMany.mockResolvedValueOnce([]); // no real bookings
    // Lock the 09:00 start slot: [09:00,10:00). Slots (2h): 08:00, 09:00, 10:00.
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([
      { blockStart: new Date('2031-01-15T09:00:00.000Z'), blockEnd: new Date('2031-01-15T10:00:00.000Z') },
    ]);

    const res = await ctx.sut.getHourlyAvailability('a1', '2031-01-15');
    const at = (s: string) => res.slots.find((x: any) => x.slotStart === s)!;

    // 09:00 starts inside the lock → blocked.
    expect(at('09:00').isBlocked).toBe(true);
    // 08:00 starts BEFORE the lock (its 8–10 booking would run into 9–10) but is
    // NOT blocked — only the START at 09:00 is forbidden.
    expect(at('08:00').isBlocked).toBe(false);
    // 10:00 starts after the lock → not blocked.
    expect(at('10:00').isBlocked).toBe(false);
    // Capacity is independent of the lock — a booking starting earlier can span it.
    expect(at('09:00').available).toBe(10);
    expect(at('10:00').available).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BookingsService.getCalendarAvailability — fully-blocked day → disabled
// ═══════════════════════════════════════════════════════════════════════════
describe('BookingsService.getCalendarAvailability with a vendor block', () => {
  const dailyActivity = {
    id: 'a1', status: 'ACTIVE', bookingType: 'DAILY',
    checkInTime: '14:00', checkOutTime: '11:00', durationValue: null,
    hasUnits: false, unitCount: 0, unitCapacity: 1, capacity: 5,
    pricePerPerson: 100, activeDays: [],
    country: { currencyCode: 'QAR', defaultTimezone: 'UTC' },
  };

  test('a full-day block disables the day (available 0, isFullyBooked, isBlocked)', async () => {
    const ctx = await buildBookingsSut();
    ctx.cache.get.mockResolvedValueOnce(null); // force compute
    ctx.prisma._client.activity.findUnique.mockResolvedValueOnce(dailyActivity);
    ctx.prisma._client.booking.findMany.mockResolvedValueOnce([]);
    // Whole-day block on 2031-01-15.
    ctx.prisma._client.activityBlock.findMany.mockResolvedValueOnce([
      { blockStart: new Date('2031-01-15T00:00:00.000Z'), blockEnd: new Date('2031-01-16T00:00:00.000Z') },
    ]);

    const res: any = await ctx.sut.getCalendarAvailability('a1', '2031-01');
    const blocked = res.days.find((d: any) => d.date === '2031-01-15');
    const free = res.days.find((d: any) => d.date === '2031-01-16');

    expect(blocked.isBlocked).toBe(true);
    expect(blocked.isFullyBooked).toBe(true);
    expect(blocked.available).toBe(0);
    expect(free.isBlocked).toBe(false);
    expect(free.available).toBe(5);
  });
});
