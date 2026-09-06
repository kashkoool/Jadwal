/**
 * Month arithmetic that CLAMPS to the last day of the target month.
 *
 * `setMonth`/`setUTCMonth` keep the day-of-month, so a day that does not exist
 * in the target month silently rolls FORWARD: 2026-08-31 + 6 months becomes
 * "2027-02-31", which JS normalises to 2027-03-03. Calendars built on that
 * offered a month beyond the booking window, and the API — which caps the same
 * window — then rejected the date the UI had just let the customer pick.
 *
 * Clamping is the intended reading of "N months ahead": Aug 31 + 6 months is
 * the end of February, not the start of March. Setting the day to 1 before
 * shifting the month is what makes the shift itself overflow-proof.
 *
 * Two variants because the callers differ: calendars that serialise with
 * `getUTC*` need the UTC one, calendars that serialise with the local getters
 * need the local one. Mixing them shifts a boundary by a day either side of
 * midnight, which is exactly the class of bug this file exists to remove.
 */

/** Add (or subtract) whole months in UTC, clamping the day-of-month. */
export function addMonthsClampedUTC(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const out = new Date(date);
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDayOfTarget = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDayOfTarget));
  return out;
}

/** Add (or subtract) whole months in local time, clamping the day-of-month. */
export function addMonthsClampedLocal(date: Date, months: number): Date {
  const day = date.getDate();
  const out = new Date(date);
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const lastDayOfTarget = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, lastDayOfTarget));
  return out;
}
