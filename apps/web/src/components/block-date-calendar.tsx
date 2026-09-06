'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Block } from '@/lib/activity-blocks';
import { addMonthsClampedUTC } from '@/lib/date-window';

const DAY_MS = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BRAND = '#1d4f35';

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function parseYmd(s: string): number {
  return Date.parse(`${s}T00:00:00.000Z`);
}

export interface DayStatus {
  locked: boolean;     // a whole-day block fully covers this day → red
  partial: boolean;    // a time-slot lock overlaps this day → dot marker
}

/** Whole-day-locked / partially-locked status for a date, derived from blocks. */
function statusOf(blocks: Block[], dateStr: string): DayStatus {
  const dStart = parseYmd(dateStr);
  const dEnd = dStart + DAY_MS;
  let partial = false;
  for (const b of blocks) {
    const bs = Date.parse(b.blockStart);
    const be = Date.parse(b.blockEnd);
    if (bs <= dStart && be >= dEnd) return { locked: true, partial: false }; // fully covers the day
    if (bs < dEnd && be > dStart) partial = true;                            // overlaps (slot lock)
  }
  return { locked: false, partial };
}

export interface BlockDateCalendarProps {
  blocks: Block[];
  /** Pending (not-yet-saved) day selection — highlighted. */
  selected: Set<string>;
  /** Click a free/partial day. `shift` true → range-extend from the last click. */
  onDayClick: (date: string, shift: boolean) => void;
  /** Click a locked (red) day → unblock it. */
  onUnlock: (date: string) => void;
  /** How many months ahead are selectable (default 6). */
  maxMonths?: number;
  /** If true, locked (red) days are read-only (no unblock on click). */
  readOnlyLocked?: boolean;
}

/**
 * Always-visible month calendar for vendor availability blocks. Locked whole
 * days show red; tap free days to select (multi), Shift-tap to fill a range;
 * tap a red day to unblock. Bounded to [today, today + maxMonths months].
 */
export default function BlockDateCalendar({
  blocks,
  selected,
  onDayClick,
  onUnlock,
  maxMonths = 6,
  readOnlyLocked = false,
}: BlockDateCalendarProps) {
  // Today / horizon in UTC date terms (the rest of the block system is UTC-naive).
  const todayStr = useMemo(() => ymd(new Date()), []);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; // m: 0-11
  });

  const maxStr = useMemo(() => ymd(addMonthsClampedUTC(new Date(), maxMonths)), [maxMonths]);

  // First/last selectable month bounds (so nav can't run away).
  const minMonth = useMemo(() => {
    const d = new Date();
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }, []);
  const maxMonth = useMemo(() => {
    const d = addMonthsClampedUTC(new Date(), maxMonths);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }, [maxMonths]);
  const viewMonth = view.y * 12 + view.m;

  const cells = useMemo(() => {
    const firstDow = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
    const out: (string | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(ymd(new Date(Date.UTC(view.y, view.m, d))));
    return out;
  }, [view]);

  const go = (dir: -1 | 1) => {
    setView((v) => {
      const next = v.m + dir;
      const y = v.y + Math.floor(next / 12);
      const m = ((next % 12) + 12) % 12;
      return { y, m };
    });
  };
  const monthLabel = new Date(Date.UTC(view.y, view.m, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  return (
    <div className="rounded-xl border border-stone-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
      {/* Header / nav */}
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={() => go(-1)} disabled={viewMonth <= minMonth}
          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-gray-900 dark:text-white">{monthLabel}</span>
        <button type="button" onClick={() => go(1)} disabled={viewMonth >= maxMonth}
          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center text-[10px] font-medium text-gray-400 dark:text-slate-500 uppercase tracking-wider">{w}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((dateStr, i) => {
          if (!dateStr) return <div key={`x${i}`} />;
          const past = dateStr < todayStr;
          const tooFar = dateStr > maxStr;
          const { locked, partial } = statusOf(blocks, dateStr);
          const sel = selected.has(dateStr);
          const dayNum = Number(dateStr.slice(8, 10));
          const disabled = past || tooFar;

          const onClick = (e: React.MouseEvent) => {
            if (disabled) return;
            if (locked) { if (!readOnlyLocked) onUnlock(dateStr); return; }
            onDayClick(dateStr, e.shiftKey);
          };

          return (
            <button
              key={dateStr}
              type="button"
              disabled={disabled}
              onClick={onClick}
              aria-pressed={sel || locked}
              title={locked ? 'Locked — tap to unblock' : undefined}
              className={cn(
                'relative h-9 rounded-lg text-sm font-medium tabular-nums transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                disabled && 'text-gray-300 dark:text-slate-700 cursor-not-allowed',
                !disabled && locked &&
                  'bg-rose-500 text-white hover:bg-rose-600 shadow-sm shadow-rose-500/25',
                !disabled && !locked && sel &&
                  'text-white shadow-sm',
                !disabled && !locked && !sel &&
                  'text-gray-700 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800',
              )}
              style={!disabled && !locked && sel ? { backgroundColor: BRAND } : undefined}
            >
              {locked && <Lock className="absolute top-0.5 end-0.5 h-2.5 w-2.5 opacity-80" />}
              {dayNum}
              {/* time-slot lock marker on an otherwise-free day */}
              {!locked && partial && !sel && (
                <span className="absolute bottom-1 start-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-rose-400" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
