/**
 * addMonthsClamped — month arithmetic that must never overflow.
 *
 * The bug this replaces: `setUTCMonth(getUTCMonth() + n)` keeps the
 * day-of-month, so a day absent from the target month rolls FORWARD into the
 * month after. 2026-08-31 + 6 months became "2027-02-31" -> 2027-03-03, which
 * made every advance window (bookings, blocks, special prices) up to 3 days
 * too generous and let the customer calendar offer a month the API rejects.
 *
 * Expectations here are hardcoded calendar dates, never computed with the
 * helper itself — a test that reuses the implementation cannot catch it being
 * wrong, which is exactly how the original bug survived.
 */
import { addMonthsClamped } from '../../src/bookings/bookings.service';

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('addMonthsClamped', () => {
  describe('clamps to the last day of a shorter target month', () => {
    test.each([
      // base          months  expected      why
      ['2026-08-31',  1,  '2026-09-30', 'Sept has 30 days — the old code gave Oct 1'],
      ['2026-01-31',  1,  '2026-02-28', 'non-leap Feb — the old code gave Mar 3'],
      ['2028-01-31',  1,  '2028-02-29', 'leap Feb clamps to the 29th, not the 28th'],
      ['2026-08-31',  6,  '2027-02-28', 'the 6-month booking window off a 31st'],
      ['2026-03-31',  1,  '2026-04-30', 'April has 30 days'],
      ['2026-05-31',  1,  '2026-06-30', 'June has 30 days'],
      ['2026-10-31',  1,  '2026-11-30', 'November has 30 days'],
      ['2026-01-29',  1,  '2026-02-28', '29th in a non-leap year'],
      ['2026-01-30',  1,  '2026-02-28', '30th in a non-leap year'],
    ])('%s + %i months -> %s (%s)', (base, months, expected) => {
      expect(ymd(addMonthsClamped(at(base as string), months as number))).toBe(expected);
    });
  });

  describe('leaves dates that need no clamping untouched', () => {
    test.each([
      ['2026-09-05',  1, '2026-10-05'],
      ['2026-09-05',  6, '2027-03-05'],
      ['2026-01-15',  1, '2026-02-15'],
      ['2026-12-31',  1, '2027-01-31'], // 31 -> 31, and the year rolls over
      ['2026-06-30',  1, '2026-07-30'],
    ])('%s + %i months -> %s', (base, months, expected) => {
      expect(ymd(addMonthsClamped(at(base as string), months as number))).toBe(expected);
    });
  });

  describe('handles negative months (analytics look-back windows)', () => {
    test.each([
      ['2026-03-31', -1, '2026-02-28', 'the old code gave Mar 3'],
      ['2026-08-31', -6, '2026-02-28', 'the dashboard 6-month window'],
      ['2026-09-05', -6, '2026-03-05', 'no clamping needed'],
      ['2026-01-15', -1, '2025-12-15', 'year rolls backwards'],
    ])('%s %i months -> %s (%s)', (base, months, expected) => {
      expect(ymd(addMonthsClamped(at(base as string), months as number))).toBe(expected);
    });
  });

  test('never lands outside the intended calendar month, for every day of two years', () => {
    // The property the old code violated: the result month must be exactly
    // `months` ahead on the month index, whatever the day-of-month is.
    for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86400000) {
      const base = new Date(t);
      for (const months of [1, 6, -6]) {
        const out = addMonthsClamped(base, months);
        const expectedIndex = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
        expect(out.getUTCFullYear() * 12 + out.getUTCMonth()).toBe(expectedIndex);
      }
    }
  });

  test('preserves the time-of-day component', () => {
    const base = new Date('2026-08-31T13:45:30.123Z');
    const out = addMonthsClamped(base, 1);
    expect(out.toISOString()).toBe('2026-09-30T13:45:30.123Z');
  });

  test('does not mutate its argument', () => {
    const base = at('2026-08-31');
    const before = base.toISOString();
    addMonthsClamped(base, 6);
    expect(base.toISOString()).toBe(before);
  });
});
