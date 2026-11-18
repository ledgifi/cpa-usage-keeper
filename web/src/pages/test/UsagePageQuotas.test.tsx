// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import type { UsageIdentity } from '@/lib/types';

const api = vi.hoisted(() => ({ fetchQuotas: vi.fn(), fetchUsageOverview: vi.fn(), fetchUsageIdentitiesPage: vi.fn(), fetchUsageQuotaCache: vi.fn(), refreshUsageQuotas: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(), ...api,
  fetchStatus: async () => ({ timezone: 'UTC' }),
  fetchVersion: async () => ({ version: 'dev' }),
  fetchCpaApiKeyOptions: async () => ({ options: [] }),
  fetchUsageQuotaInspectionStatus: async () => ({ running: false }),
}));
const renderHealth = vi.hoisted(() => vi.fn());
vi.mock('@/components/usage/credentials/CredentialHealthPanel', async (original) => {
  const actual = await original<typeof import('@/components/usage/credentials/CredentialHealthPanel')>();
  return {
    ...actual,
    CredentialHealthPanel: (props: ComponentProps<typeof actual.CredentialHealthPanel>) => {
      renderHealth();
      return <actual.CredentialHealthPanel {...props} />;
    },
  };
});
import { UsagePage } from '../UsagePage';

let container: HTMLDivElement;
let root: Root;
const now = Date.parse('2026-10-14T12:00:00Z');
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(now + 60_000); // The server clock wins.
  await i18n.changeLanguage('en');
  localStorage.clear();
  window.__APP_BASE_PATH__ = '/cpa';
  window.history.replaceState(null, '', '/cpa/credentials');
  vi.clearAllMocks();
  api.fetchUsageIdentitiesPage.mockResolvedValue({ identities: [{ id: '1', identity: 'admin-auth', type: 'codex', auth_type: 1, name: 'Admin account', is_deleted: false } as UsageIdentity], total_count: 1, total_pages: 1, type_counts: [{ type: 'codex', count: 1 }] });
  api.fetchUsageQuotaCache.mockResolvedValue({ server_time: new Date(now).toISOString(), scheduled_refresh_enabled: false, items: [{ auth_index: 'admin-auth', status: 'completed', display_status: 'cached', refreshed_at: new Date(now).toISOString(), quota: { id: 'admin-auth', quota: [{ key: 'rate_limit.secondary_window', label: 'Weekly', remainingFraction: 0.5, resetAfterSeconds: 3, window: { seconds: 604800 } }] } }] });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete window.__APP_BASE_PATH__;
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
});

it('shows quota freshness and the timeline alongside upstream Credential cards and actions', async () => {
  await act(async () => root.render(<UsagePage />));
  expect(container.querySelector('[data-keeper-page="usage"]')).not.toBeNull();
  expect(container.querySelector('[data-keeper-page="key-viewer"]')).toBeNull();
  expect(container.querySelector('a[href^="/cpa/credentials"]')).not.toBeNull();
  expect(container.querySelector('a[href="/cpa/subscriptions"]')).toBeNull();
  expect(container.querySelector('a[href="/cpa/quotas"]')).toBeNull();
  expect(container.querySelectorAll('[data-quota-key]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(1);
  expect(container.textContent).toContain('Update Quotas');
  expect(container.textContent).toContain('Automatic quota refresh is off.');
  expect(container.querySelector('[data-reset-countdown]')?.textContent).toContain('3s');
  expect(api.fetchUsageQuotaCache).toHaveBeenCalledTimes(1);
  expect(renderHealth).toHaveBeenCalled();
  renderHealth.mockClear();
  await act(async () => vi.advanceTimersByTime(3000));
  expect(renderHealth).not.toHaveBeenCalled();
  expect(container.querySelector('[data-reset-countdown]')?.textContent).toContain('Awaiting update');
  expect(container.querySelector('[data-quota-freshness]')?.getAttribute('data-status')).toBe('stale');
  expect(api.fetchUsageQuotaCache).toHaveBeenCalledTimes(1);
  await act(async () => triggerHeaderRefresh());
  expect(api.fetchUsageQuotaCache).toHaveBeenCalledTimes(2);
  expect(api.fetchQuotas).not.toHaveBeenCalled();
  expect(api.fetchUsageOverview).not.toHaveBeenCalled();
  expect(api.refreshUsageQuotas).not.toHaveBeenCalled();
});


it('keeps disabled and deleted accounts out of the timeline and suppresses failed snapshots', async () => {
  const base = await api.fetchUsageIdentitiesPage();
  api.fetchUsageIdentitiesPage.mockResolvedValue({ ...base, total_count: 3, identities: [base.identities[0], { ...base.identities[0], id: '2', identity: 'disabled', disabled: true }, { ...base.identities[0], id: '3', identity: 'deleted', is_deleted: true }] });
  const cache = await api.fetchUsageQuotaCache();
  api.fetchUsageQuotaCache.mockResolvedValue({ ...cache, items: ['admin-auth', 'disabled', 'deleted'].map((auth_index) => ({ ...cache.items[0], auth_index })) });
  api.fetchUsageIdentitiesPage.mockClear(); api.fetchUsageQuotaCache.mockClear();
  await act(async () => root.render(<UsagePage />));
  expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(1);
  api.fetchUsageQuotaCache.mockResolvedValue({ ...cache, items: [{ ...cache.items[0], status: 'failed', display_status: 'unavailable', error: 'latest refresh failed' }] });
  await act(async () => triggerHeaderRefresh());
  expect(container.querySelectorAll('[data-quota-key]')).toHaveLength(0);
  expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(0);
  expect(container.textContent).toContain('latest refresh failed');
  expect(api.refreshUsageQuotas).not.toHaveBeenCalled();
});
