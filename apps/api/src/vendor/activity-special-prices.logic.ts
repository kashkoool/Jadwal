import { BadRequestException } from '@nestjs/common';
import { isValidDate, addMonthsClamped } from '../bookings/bookings.service';
import type { CreateSpecialPriceDto } from './dto/create-special-price.dto';
import type { BulkSpecialPriceDto } from './dto/bulk-special-price.dto';

// How far ahead a special price may be set — 6 months, matching BOOKING_MAX_ADVANCE_MONTHS
// (the booking horizon) and the customer + block (lock) calendars. A price set beyond
// the bookable window would never apply. Past dates are rejected — they can't be booked.
export const SPECIAL_PRICE_MAX_ADVANCE_MONTHS = 6;
const MAX_PRICE = 1_000_000;

export interface SpecialPriceActivity {
  id: string;
  vendorId: string;
}

/** Midnight-UTC Date for a YYYY-MM-DD string (the @db.Date column is date-only). */
export function specialPriceDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/**
 * Core "set a per-date special price" logic, shared by the vendor and admin
 * flows so validation can never drift. Idempotent per date: setting a price on
 * a date that already has an active override UPDATES it (the calendar UX is
 * "set the price for this day"), otherwise it creates one. The partial unique
 * index (activityId, date) WHERE deletedAt IS NULL is the DB backstop.
 *
 * The CALLER must resolve + authorise `activity` (vendor → own activities;
 * admin → any) and bust the availability cache afterwards.
 */
export async function createSpecialPriceCore(
  db: any,
  activity: SpecialPriceActivity,
  dto: CreateSpecialPriceDto,
): Promise<{ id: string; date: Date; price: unknown; createdAt: Date; created?: boolean; updated?: boolean }> {
  // Calendar-date sanity beyond the DTO regex (rejects 2026-02-30 etc.).
  if (!isValidDate(dto.date)) throw new BadRequestException('Invalid date');

  const today = new Date().toISOString().slice(0, 10);
  if (dto.date < today) {
    throw new BadRequestException('Cannot set a special price for a past date');
  }

  const maxAhead = addMonthsClamped(new Date(), SPECIAL_PRICE_MAX_ADVANCE_MONTHS);
  if (dto.date > maxAhead.toISOString().slice(0, 10)) {
    throw new BadRequestException(`Cannot set a special price more than ${SPECIAL_PRICE_MAX_ADVANCE_MONTHS} months ahead`);
  }

  // Defence-in-depth on price (the DTO already validated; never trust one layer).
  if (!(dto.price > 0) || dto.price > MAX_PRICE) {
    throw new BadRequestException('Invalid price');
  }

  const date = specialPriceDate(dto.date);
  const existing = await db.activitySpecialPrice.findFirst({
    where: { activityId: activity.id, date, deletedAt: null },
    select: { id: true },
  });

  if (existing) {
    const updated = await db.activitySpecialPrice.update({
      where: { id: existing.id },
      data: { price: dto.price },
      select: { id: true, date: true, price: true, createdAt: true },
    });
    return { ...updated, updated: true };
  }

  const created = await db.activitySpecialPrice.create({
    data: { activityId: activity.id, vendorId: activity.vendorId, date, price: dto.price },
    select: { id: true, date: true, price: true, createdAt: true },
  });
  return { ...created, created: true };
}

/** Max dates a single bulk request may touch (matches the DTO's ArrayMaxSize). */
export const BULK_SPECIAL_PRICE_MAX_DATES = 200;

/**
 * Resolve a {dates, startDate, endDate} bulk request into a sorted, de-duped
 * list of YYYY-MM-DD strings. Format is already validated by the DTO; this adds
 * the cross-field rules: at least one source, both range ends together, range
 * not inverted, and a hard cap so one request can't open an unbounded
 * transaction. Per-date calendar/horizon/past validation stays in the core.
 */
export function expandSpecialPriceDates(dto: BulkSpecialPriceDto): string[] {
  const set = new Set<string>(dto.dates ?? []);

  if (dto.startDate || dto.endDate) {
    if (!dto.startDate || !dto.endDate) {
      throw new BadRequestException('Both startDate and endDate are required for a range');
    }
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    let cursor = specialPriceDate(dto.startDate);
    const end = specialPriceDate(dto.endDate);
    let guard = 0;
    while (cursor <= end) {
      set.add(cursor.toISOString().slice(0, 10));
      cursor = new Date(cursor.getTime() + 86_400_000); // +1 day (date-only, UTC)
      if (++guard > BULK_SPECIAL_PRICE_MAX_DATES + 1) break; // backstop; cap enforced below
    }
  }

  const dates = [...set].sort();
  if (dates.length === 0) {
    throw new BadRequestException('Provide one or more dates, or a startDate and endDate range');
  }
  if (dates.length > BULK_SPECIAL_PRICE_MAX_DATES) {
    throw new BadRequestException(`Cannot set a special price for more than ${BULK_SPECIAL_PRICE_MAX_DATES} dates at once`);
  }
  return dates;
}

/**
 * Apply ONE price to MANY dates by looping the per-date core. The CALLER must
 * resolve+authorise `activity`, wrap this in a $transaction (so the batch is
 * all-or-nothing), and bust the availability cache once afterwards.
 */
export async function bulkCreateSpecialPricesCore(
  db: any,
  activity: SpecialPriceActivity,
  dto: BulkSpecialPriceDto,
): Promise<{ count: number; dates: string[] }> {
  const dates = expandSpecialPriceDates(dto);
  for (const date of dates) {
    await createSpecialPriceCore(db, activity, { date, price: dto.price });
  }
  return { count: dates.length, dates };
}
