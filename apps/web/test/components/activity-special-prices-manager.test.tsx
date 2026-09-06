import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Translator: return the supplied default string, else the key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: any) => (typeof def === 'string' ? def : def?.defaultValue ?? key),
    i18n: { language: 'en' },
  }),
}));
// Draft mode never calls the API, but the import must resolve.
jest.mock('@/lib/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() } }));
jest.mock('@/components/toast', () => ({ useToast: () => ({ toast: jest.fn() }) }));
// api-error imports @/lib/i18n which boots the real i18next instance (too heavy +
// crashes under the react-i18next mock). It's only used on error paths, never in draft.
jest.mock('@/lib/api-error', () => ({ getApiError: (_e: unknown, fallback?: string) => fallback ?? 'error' }));

import ActivitySpecialPricesManager from '@/components/activity-special-prices-manager';

function renderManager(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ActivitySpecialPricesManager — draft + collapsible (create wizard)', () => {
  it('collapsible: starts CLOSED (garage), expands only after clicking Open', async () => {
    const user = userEvent.setup();
    renderManager(<ActivitySpecialPricesManager draft collapsible value={[]} onChange={() => {}} />);

    // Closed → the calendar body (its month-nav "Previous" control) is NOT mounted.
    expect(screen.queryByLabelText(/previous/i)).not.toBeInTheDocument();
    // Only the Open toggle is shown.
    await user.click(screen.getByRole('button', { name: /^open$/i }));
    // Open → the calendar body is now mounted.
    expect(screen.getByLabelText(/previous/i)).toBeInTheDocument();
  });

  it('draft: picking a date + price bubbles {date, price} via onChange and hits NO API', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const api = (await import('@/lib/api')).default as any;
    // Not collapsible here so the calendar is open. Jump to next month for a
    // guaranteed future, unlocked day (avoids "today is past the 15th" flake).
    renderManager(<ActivitySpecialPricesManager draft value={[]} onChange={onChange} />);

    await user.click(screen.getByLabelText(/next/i));
    await user.click(screen.getByRole('button', { name: '15' }));
    // Controlled number input + per-keystroke typing desyncs under jsdom; set the
    // value in one change event (what matters is the collected payload).
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '199' } });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const lastArg = onChange.mock.calls.at(-1)?.[0];
    expect(lastArg).toHaveLength(1);
    expect(lastArg[0].price).toBe(199);
    expect(lastArg[0].date).toMatch(/-15$/);
    // Draft mode must never touch the network.
    expect(api.post).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('draft: removing a priced date bubbles an empty list (no API)', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    // Seed an override in NEXT month so the day is always future + clickable.
    // Build the month with Date.UTC rather than setUTCMonth(+1): setUTCMonth
    // keeps the day-of-month, so on a 31st whose next month is shorter it
    // overflows into the month AFTER next (2026-08-31 -> "Sept 31" -> Oct 1).
    // The test only clicks "next" once, so it would land on September while the
    // override sat in October, the priced day would never render, and there
    // would be no Remove button. That fired on 7 calendar days a year
    // (Jan 29-31, Mar 31, May 31, Aug 31, Oct 31) and turned every open PR red.
    // Date.UTC normalises a month index of 12 into January of the next year,
    // and day 15 exists in every month, so this can never pick the wrong month.
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
    const seeded = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-15`;
    renderManager(<ActivitySpecialPricesManager draft value={[{ date: seeded, price: 120 }]} onChange={onChange} />);

    await user.click(screen.getByLabelText(/next/i));
    await user.click(screen.getByRole('button', { name: /15/ })); // priced day → opens form with Remove
    await user.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
