'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { addMonthsClampedLocal } from '@/lib/date-window';

interface DatePickerProps {
  value: string; // "YYYY-MM-DD" or ""
  onChange: (value: string) => void;
  placeholder?: string;
  hasError?: boolean;
  direction?: 'up' | 'down';
  disablePast?: boolean;
  minDate?: string; // earliest selectable date (YYYY-MM-DD); combined with disablePast
  maxDate?: string; // latest selectable date (YYYY-MM-DD)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function toYMD(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDisplay(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export default function DatePicker({ value, onChange, placeholder = 'Select date', hasError, direction = 'down', disablePast = false, minDate, maxDate }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date();
    return d.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date();
    return d.getMonth();
  });
  const ref = useRef<HTMLDivElement>(null);

  // Sync view to selected value when it changes externally
  useEffect(() => {
    if (value) {
      const d = new Date(value + 'T00:00:00');
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    } else if (minDate) {
      // No value yet but a minimum is set (e.g. an end-date picker bounded by
      // the start date) — open on the minimum's month so the user isn't
      // staring at a month full of disabled days.
      const d = new Date(minDate + 'T00:00:00');
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [value, minDate]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const today = useMemo(() => {
    const now = new Date();
    return toYMD(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  // The earliest selectable day = the later of "today" (when disablePast) and
  // an explicit minDate. Empty string means no lower bound.
  const minBoundary = useMemo(() => {
    const t = disablePast ? today : '';
    return minDate && minDate > t ? minDate : t;
  }, [disablePast, today, minDate]);
  const minBoundaryDate = useMemo(
    () => (minBoundary ? new Date(minBoundary + 'T00:00:00') : null),
    [minBoundary],
  );
  const isAtMinMonth = !!minBoundaryDate && viewYear === minBoundaryDate.getFullYear() && viewMonth === minBoundaryDate.getMonth();
  const maxBoundaryDate = useMemo(() => (maxDate ? new Date(maxDate + 'T00:00:00') : null), [maxDate]);
  const isAtMaxMonth = !!maxBoundaryDate && viewYear === maxBoundaryDate.getFullYear() && viewMonth === maxBoundaryDate.getMonth();

  const prevMonth = useCallback(() => {
    if (minBoundaryDate && viewYear === minBoundaryDate.getFullYear() && viewMonth === minBoundaryDate.getMonth()) return;
    setViewMonth(m => {
      if (m === 0) { setViewYear(y => y - 1); return 11; }
      return m - 1;
    });
  }, [minBoundaryDate, viewYear, viewMonth]);

  const nextMonth = useCallback(() => {
    if (maxBoundaryDate && viewYear === maxBoundaryDate.getFullYear() && viewMonth === maxBoundaryDate.getMonth()) return;
    setViewMonth(m => {
      if (m === 11) { setViewYear(y => y + 1); return 0; }
      return m + 1;
    });
  }, [maxBoundaryDate, viewYear, viewMonth]);

  const handleDayClick = useCallback((dateStr: string) => {
    if (minBoundary && dateStr < minBoundary) return;
    if (maxDate && dateStr > maxDate) return;
    onChange(dateStr);
    setOpen(false);
  }, [onChange, minBoundary, maxDate]);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const days: { day: number; dateStr: string }[] = [];
    for (let i = 0; i < firstDay; i++) days.push({ day: 0, dateStr: '' });
    for (let d = 1; d <= daysInMonth; d++) {
      days.push({ day: d, dateStr: toYMD(viewYear, viewMonth, d) });
    }
    return days;
  }, [viewYear, viewMonth]);

  const getPresets = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextMonth = addMonthsClampedLocal(now, 1);
    const all = [
      { label: 'Today', dateStr: today },
      { label: 'Tomorrow', dateStr: toYMD(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()) },
      { label: 'Next Week', dateStr: toYMD(nextWeek.getFullYear(), nextWeek.getMonth(), nextWeek.getDate()) },
      { label: 'Next Month', dateStr: toYMD(nextMonth.getFullYear(), nextMonth.getMonth(), nextMonth.getDate()) },
    ];
    const lowered = minBoundary ? all.filter(p => p.dateStr >= minBoundary) : all;
    return maxDate ? lowered.filter(p => p.dateStr <= maxDate) : lowered;
  };

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center justify-between px-4 py-3 bg-white dark:bg-slate-800 border rounded-xl text-sm focus:outline-none focus:ring-2 transition-colors text-start ${
          hasError
            ? 'border-red-400 focus:ring-red-400/20'
            : open
              ? 'border-blue-500/50 ring-2 ring-blue-500/20'
              : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600 focus:ring-blue-500/20 focus:border-blue-500/50'
        }`}
      >
        <span className={value ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-slate-500'}>
          {value ? formatDisplay(value) : placeholder}
        </span>
        <div className="flex items-center gap-1.5">
          {value && (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onChange(''); }}
              className="p-0.5 rounded-md hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-300 hover:text-gray-500 dark:hover:text-slate-300 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
          <CalendarDays className="h-4 w-4 text-gray-400 dark:text-slate-500 shrink-0" />
        </div>
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className={`absolute z-50 inset-s-0 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl shadow-xl shadow-black/10 dark:shadow-black/30 p-4 w-72 ${direction === 'up' ? 'bottom-full mb-2' : 'mt-2'}`}
          >
            {/* Month/Year header */}
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={prevMonth}
                disabled={isAtMinMonth}
                className={`p-1.5 rounded-lg transition-colors ${isAtMinMonth ? 'opacity-30 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-slate-800'}`}
              >
                <ChevronLeft className="h-4 w-4 text-gray-500 dark:text-slate-400" />
              </button>
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                {MONTHS[viewMonth]} {viewYear}
              </span>
              <button
                type="button"
                onClick={nextMonth}
                disabled={isAtMaxMonth}
                className={`p-1.5 rounded-lg transition-colors ${isAtMaxMonth ? 'opacity-30 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-slate-800'}`}
              >
                <ChevronRight className="h-4 w-4 text-gray-500 dark:text-slate-400" />
              </button>
            </div>

            {/* Day headers */}
            <div className="grid grid-cols-7 mb-1">
              {DAYS.map(d => (
                <div key={d} className="text-center text-[10px] font-semibold text-gray-400 dark:text-slate-500 py-1">
                  {d}
                </div>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7">
              {calendarDays.map((item, i) => {
                if (item.day === 0) return <div key={`empty-${i}`} />;
                const isSelected = item.dateStr === value;
                const isToday = item.dateStr === today;
                const isDisabled = (!!minBoundary && item.dateStr < minBoundary) || (!!maxDate && item.dateStr > maxDate);
                return (
                  <button
                    key={item.dateStr}
                    type="button"
                    onClick={() => handleDayClick(item.dateStr)}
                    disabled={isDisabled}
                    className={`h-8 w-full text-xs font-medium rounded-lg transition-all ${
                      isDisabled
                        ? 'text-gray-300 dark:text-slate-700 cursor-not-allowed'
                        : isSelected
                          ? 'bg-blue-600 text-white shadow-sm'
                          : isToday
                            ? 'text-blue-600 dark:text-blue-400 font-bold ring-1 ring-blue-400/40'
                            : 'text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {item.day}
                  </button>
                );
              })}
            </div>

            {/* Quick presets */}
            <div className="mt-3 pt-3 border-t border-gray-100 dark:border-slate-800">
              <p className="text-[10px] font-medium text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-2">Quick Select</p>
              <div className="flex flex-wrap gap-1.5">
                {getPresets().map(preset => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => { onChange(preset.dateStr); setOpen(false); }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      value === preset.dateStr
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-50 dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
