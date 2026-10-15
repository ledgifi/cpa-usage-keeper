// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import type { ViewerQuotaResponse } from '@/lib/types';

const mocks = vi.hoisted(() => ({ fetchQuotas: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchQuotas: mocks.fetchQuotas }));
vi.mock('@/features/key-viewer/KeyViewerShell', () => ({
  KeyViewerShell: ({ children, onRefresh, refreshing }: { children: React.ReactNode; onRefresh: () => void; refreshing: boolean }) => <div><button onClick={onRefresh} disabled={refreshing}>Refresh cache</button>{children}</div>,
}));
vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => undefined }, useTranslation: () => ({ t: (key: string) => key === 'usage_stats.credentials_subscription_codex_pro_20x' ? 'Pro 20x' : key, i18n: { language: 'en' } }) }));
import { QuotasPage } from '../QuotasPage';
import { resetCountdown, quotaDisplayStatus } from '@/components/usage/quotas/quotaDisplay';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse('2026-10-13T12:00:00Z');
const fixture = (): ViewerQuotaResponse => ({
  server_time: new Date(now).toISOString(), scheduled_refresh_enabled: false,
  accounts: [{ id: 'opaque', label: 'Codex subscription fixture', provider: 'Codex', status: 'cached', updated_at: new Date(now).toISOString(), subscription: { plan: 'pro-20x' }, rows: [
    { id: 'percent', label: '5-hour', remaining_percent: 0, reset_at: new Date(now + 3000).toISOString() },
    { id: 'unknown', label: 'Weekly' },
    { id: 'zero', label: 'Requests', used: 0, remaining: 0, limit: 20 },
  ] }],
});

describe('quota display', () => {
  it('handles reset countdowns, invalid and expired resets', () => {
    expect(resetCountdown(undefined, now)).toBeNull();
    expect(resetCountdown('invalid', now)).toBeNull();
    expect(resetCountdown(new Date(now).toISOString(), now)).toBe('expired');
    expect(resetCountdown(new Date(now + 90061000).toISOString(), now)).toBe('1 day 1 hr');
    expect(quotaDisplayStatus(fixture().accounts[0], now + 4000)).toBe('stale');
    expect(quotaDisplayStatus({ ...fixture().accounts[0], status: 'available', fresh_until: new Date(now - 1).toISOString() }, now)).toBe('stale');
  });
});

describe('QuotasPage cache reads', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onNavigate = vi.fn();
  const onAuthRequired = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now + 60_000); // Deliberate client clock skew.
    mocks.fetchQuotas.mockReset(); onNavigate.mockReset(); onAuthRequired.mockReset();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
  const render = async () => { await act(async () => root.render(<QuotasPage onNavigate={onNavigate} onAuthRequired={onAuthRequired} />)); };
  it('renders unknown versus explicit zero, plans, live countdown, and passed reset without assuming refill', async () => {
    mocks.fetchQuotas.mockResolvedValue(fixture()); await render();
    expect(container.textContent).toContain('Pro 20x');
    expect(container.textContent).toContain('key_quota.schedule_disabled');
    expect(container.textContent).toContain('0% key_quota.remaining');
    expect(container.textContent).toContain('key_quota.unknown key_quota.remaining');
    expect(container.textContent).toContain('key_quota.used: 0 · key_quota.limit: 20');
    expect(container.querySelector('[data-reset-countdown]')?.textContent).toContain('3 sec');
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.querySelector('[data-reset-countdown]')?.textContent).toContain('2 sec');
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container.querySelector('[data-reset-countdown]')?.textContent).toBe('key_quota.reset_passed_short');
    expect(container.querySelector('[data-reset-countdown]')?.getAttribute('aria-label')).toBe('key_quota.reset_passed');
    expect(container.textContent).toContain('key_quota.stale');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toContain('key_quota.last_observed');
    expect(mocks.fetchQuotas).toHaveBeenCalledTimes(1);
  });
  it('polls and manual refresh only re-read cache, and aborts on unmount', async () => {
    mocks.fetchQuotas.mockResolvedValue(fixture()); await render();
    await act(async () => container.querySelector('button')?.click());
    expect(mocks.fetchQuotas).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(mocks.fetchQuotas).toHaveBeenCalledTimes(3);
    const pending = Promise.withResolvers<ViewerQuotaResponse>(); mocks.fetchQuotas.mockReturnValue(pending.promise);
    await act(async () => container.querySelector('button')?.click());
    const signal = mocks.fetchQuotas.mock.calls.at(-1)?.[0] as AbortSignal;
    act(() => root.unmount()); expect(signal.aborted).toBe(true);
    root = createRoot(container);
  });
  it('prevents duplicate requests and ignores a response after unmount', async () => {
    const pending = Promise.withResolvers<ViewerQuotaResponse>(); mocks.fetchQuotas.mockReturnValue(pending.promise);
    await render(); await act(async () => vi.advanceTimersByTime(60_000));
    expect(mocks.fetchQuotas).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    await act(async () => pending.resolve(fixture()));
    expect(container.textContent).toBe(''); root = createRoot(container);
  });
  it.each([401, 403, 503])('handles %s without displaying old data as healthy', async (status) => {
    mocks.fetchQuotas.mockResolvedValueOnce(fixture()).mockRejectedValue(new ApiError('safe error', status));
    await render(); await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Codex subscription');
    expect(onAuthRequired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(onNavigate).toHaveBeenCalledTimes(status === 403 ? 1 : 0);
  });
  it('offers inline cache retry after a read failure', async () => {
    mocks.fetchQuotas.mockRejectedValueOnce(new ApiError('safe error', 503)).mockResolvedValue(fixture());
    await render();
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    await act(async () => retry.click());
    expect(mocks.fetchQuotas).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-quota-account]')).not.toBeNull();
  });
  it('renders empty and unavailable accounts', async () => {
    mocks.fetchQuotas.mockResolvedValueOnce({ ...fixture(), accounts: [] }); await render();
    expect(container.textContent).toContain('key_quota.empty');
    mocks.fetchQuotas.mockResolvedValue({ ...fixture(), accounts: [{ ...fixture().accounts[0], status: 'unavailable', subscription: undefined, rows: [] }] });
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('key_quota.unavailable');
    expect(container.querySelector('[aria-label="key_quota.plan"]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
  it('shows the small subscription list directly without filtering controls or extra cache reads', async () => {
    const data = fixture();
    data.accounts.push({ ...data.accounts[0], id: 'claude', provider: 'Claude', label: 'Claude subscription second', subscription: { plan: 'max-5x' } });
    mocks.fetchQuotas.mockResolvedValue(data); await render();
    const ledger = () => [...container.querySelectorAll('[data-quota-account]')];
    expect(ledger()).toHaveLength(2);
    expect(ledger()[0].getAttribute('data-quota-account')).toBe('claude');
    expect(ledger()[1].getAttribute('data-quota-account')).toBe('opaque');
    expect(container.querySelector('[aria-label="usage_stats.credentials_filter_aria_label"]')).toBeNull();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(mocks.fetchQuotas).toHaveBeenCalledTimes(1);
  });
  it('keeps reset and observation timestamps inline without disclosures', async () => {
    mocks.fetchQuotas.mockResolvedValue(fixture()); await render();
    const account = container.querySelector('[data-quota-account]')!;
    expect(account.querySelector('details')).toBeNull();
    const observation = account.querySelector(`time[datetime="${new Date(now).toISOString()}"]`)!;
    expect(observation.getAttribute('title')).toBeTruthy();
    const reset = account.querySelector(`time[datetime="${new Date(now + 3000).toISOString()}"]`)!;
    expect(reset.textContent).toBeTruthy();
    expect(reset.getAttribute('title')).toBeTruthy();
  });
  it('replaces the subscription list when a cache read removes an account', async () => {
    mocks.fetchQuotas.mockResolvedValueOnce(fixture()); await render();
    mocks.fetchQuotas.mockResolvedValue({ ...fixture(), accounts: [{ ...fixture().accounts[0], provider: 'Claude', id: 'claude' }] });
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[data-quota-account="claude"]')).not.toBeNull();
    expect(container.querySelector('[data-quota-account="opaque"]')).toBeNull();
  });
});
