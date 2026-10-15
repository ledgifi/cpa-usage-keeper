// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerQuotaAccount } from '@/lib/types';
import { QuotaWindowTimeline, quotaTimelineRange, quotaWindowGeometry, quotaUsedPercent, quotaFutureWindows } from '@/components/usage/quotas/QuotaWindowTimeline';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse('2026-10-14T12:00:00Z');
const hour = 3_600_000;
const accounts: ViewerQuotaAccount[] = [{ id: 'safe', label: 'Codex subscription safe', provider: 'Codex', status: 'cached', rows: [
  { id: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 38, reset_at: new Date(now + 2 * 86400000).toISOString() },
  { id: 'short', label: '5-hour', window_seconds: 18000, remaining_percent: 0, reset_at: new Date(now + hour).toISOString() },
  { id: 'unknown-duration', label: 'Quota window 3', reset_at: new Date(now + 2 * hour).toISOString() },
  { id: 'unknown-reset', label: 'Quota window 4' },
] }];

describe('quota window geometry', () => {
  it('uses provider percentages, preserving explicit zero and unknown usage', () => {
    const row = { id: 'quota', label: 'Weekly' };
    expect(quotaUsedPercent(row)).toBeNull();
    expect(quotaUsedPercent({ ...row, remaining_percent: 91 })).toBe(9);
    expect(quotaUsedPercent({ ...row, remaining_percent: 28 })).toBe(72);
    expect(quotaUsedPercent({ ...row, remaining_percent: 0 })).toBe(100);
    expect(quotaUsedPercent({ ...row, remaining_percent: 100 })).toBe(0);
    expect(quotaUsedPercent({ ...row, used_percent: 0 })).toBe(0);
    expect(quotaUsedPercent({ ...row, used_percent: 100 })).toBe(100);
    expect(quotaUsedPercent({ ...row, used: 3, limit: 10 })).toBeNull();
    for (const invalid of [-1, 101, Infinity, NaN]) {
      expect(quotaUsedPercent({ ...row, used_percent: invalid, remaining_percent: invalid })).toBeNull();
    }
  });
  it('clips the quota-used fill against the full window rather than rescaling usage to the visible portion', () => {
    const row = { id: 'quota', label: 'Window', reset_at: new Date(100_000).toISOString(), window_seconds: 100 };
    for (const [used, expected] of [[0, 0], [25, 0], [50, 50], [75, 100], [100, 100]]) {
      const geometry = quotaWindowGeometry({ ...row, used_percent: used }, 25_000, 75_000)!;
      expect(geometry.width).toBe(100);
      expect(geometry.usedWidth).toBe(expected);
    }
    expect(quotaWindowGeometry(row, 25_000, 75_000)?.usedWidth).toBeNull();
    expect(quotaWindowGeometry({ ...row, window_seconds: undefined, used_percent: 50 }, 25_000, 75_000)?.usedWidth).toBeNull();
  });
  it('estimates a start only from a valid duration, preserves zero headroom, and clips spans to the viewport', () => {
    const row = accounts[0].rows[0];
    const geometry = quotaWindowGeometry(row, now, now + 86400000)!;
    expect(geometry.estimatedStart).toBe(Date.parse(row.reset_at!) - 604800000);
    expect(geometry.left).toBe(0);
    expect(geometry.width).toBe(100);
    expect(geometry.visible).toBe(true);
    for (const seconds of [undefined, 0, -1, Infinity, NaN, 366 * 86400 + 1]) {
      expect(quotaWindowGeometry({ ...row, window_seconds: seconds }, now, now + 3 * 86400000)?.estimatedStart).toBeNull();
    }
    expect(quotaWindowGeometry({ ...row, reset_at: 'invalid' }, now, now + hour)).toBeNull();
    expect(quotaWindowGeometry(row, now + 4 * 86400000, now + 5 * 86400000)?.visible).toBe(false);
  });
  it('uses local calendar dates for the two-week range and shifts short ranges in absolute hours', () => {
    const range = quotaTimelineRange(now, false, 0);
    expect(range.ticks).toHaveLength(15);
    expect(new Date(range.start).getHours()).toBe(0);
    expect(new Date(range.start).getDay()).toBe(0);
    expect(new Date(range.start).getDate()).toBe(11);
    expect(new Date(range.end - 1).getDate()).toBe(24);
    const previous = quotaTimelineRange(now, false, -1);
    expect(previous.end).toBe(range.start);
    const short = quotaTimelineRange(now, true, 0);
    expect(short.end - short.start).toBe(12 * hour);
    expect(quotaTimelineRange(now, true, 1).start).toBe(short.end);
  });
  it('matches the reported weekly endpoints in the CPA comparison without creating adjacent cycles', () => {
    const range = quotaTimelineRange(now, false, 0);
    for (const [reset, start] of [
      ['2026-10-21T07:59:00-03:00', '2026-10-14T07:59:00-03:00'],
      ['2026-10-20T01:58:00-03:00', '2026-10-13T01:58:00-03:00'],
    ]) {
      const geometry = quotaWindowGeometry({ id: 'weekly', label: 'Weekly', reset_at: reset, window_seconds: 604800 }, range.start, range.end)!;
      expect(geometry.reset).toBe(Date.parse(reset));
      expect(geometry.estimatedStart).toBe(Date.parse(start));
      expect(geometry.width).toBeGreaterThan(0);
      expect(geometry.visible).toBe(true);
    }
  });
});

describe('future cycle projections', () => {
  const row = { id: 'weekly', label: 'Weekly', reset_at: '2026-10-21T07:59:00-03:00', window_seconds: 604800, remaining_percent: 91 };
  const reset = Date.parse(row.reset_at);
  const week = 604800000;
  it('starts at the reported reset, repeats the known duration, and clips to the visible range', () => {
    const cycles = quotaFutureWindows(row, reset - week, reset + week + week / 2, now);
    expect(cycles).toHaveLength(2);
    expect(cycles[0].start).toBe(reset);
    expect(cycles[0].end).toBe(reset + week);
    expect(cycles[1].start).toBe(reset + week);
    expect(cycles[1].end).toBe(reset + 2 * week);
    expect(cycles[0].left).toBeCloseTo(40);
    expect(cycles[0].width).toBeCloseTo(40);
    expect(cycles[1].width).toBeCloseTo(20);
    // A future viewport starts partway through a projected cycle.
    const shifted = quotaFutureWindows(row, reset + 100 * week + week / 2, reset + 102 * week, now);
    expect(shifted).toHaveLength(2);
    expect(shifted[0].start).toBe(reset + 100 * week);
    expect(shifted[0].left).toBe(0);
    expect(shifted[0].width).toBeCloseTo(100 / 3);
  });
  it('does not infer current/past cycles from expired observations, or project unknown/invalid windows', () => {
    const time = reset + week / 2;
    const cycles = quotaFutureWindows(row, reset - week, reset + 2 * week, time);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].start).toBe(reset + week);
    for (const seconds of [undefined, 0, -1, Infinity, NaN]) {
      expect(quotaFutureWindows({ ...row, window_seconds: seconds }, reset, reset + week, now)).toEqual([]);
    }
    expect(quotaFutureWindows({ ...row, reset_at: undefined }, reset, reset + week, now)).toEqual([]);
    expect(quotaFutureWindows(row, reset, reset + week, NaN)).toEqual([]);
    expect(quotaFutureWindows(row, reset + week, reset, now)).toEqual([]);
    expect(quotaFutureWindows(row, reset - week, reset, now)).toEqual([]);
  });
  it('keeps elapsed durations across DST and bounds very short-window rendering', () => {
    const cycles = quotaFutureWindows({ ...row, reset_at: '2026-09-05T12:00:00Z' }, Date.parse('2026-09-05T12:00:00Z'), Date.parse('2026-09-20T12:00:00Z'), Date.parse('2026-09-04T12:00:00Z'));
    expect(cycles[0].end - cycles[0].start).toBe(week);
    expect(cycles[0].end).toBe(Date.parse('2026-09-12T12:00:00Z'));
    expect(quotaFutureWindows({ ...row, window_seconds: 1 }, reset, reset + week, now)).toHaveLength(128);
  });
});

describe('local calendar boundaries', () => {
  it('constructs independent midnights when DST skips Sunday midnight in Santiago', () => {
    const time = new Date(2026, 8, 9, 12).getTime();
    const range = quotaTimelineRange(time, false, 0);
    range.ticks.forEach((tick, index) => expect(tick).toBe(new Date(2026, 8, 6 + index).getTime()));
    expect(quotaTimelineRange(time, false, 1).start).toBe(range.end);
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Santiago') {
      expect(new Date(range.ticks[0]).getHours()).toBe(1);
      expect(new Date(range.ticks[1]).getHours()).toBe(0);
      expect(range.ticks[1] - range.ticks[0]).toBe(23 * hour);
    }
  });
});

describe('QuotaWindowTimeline', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = async (value = accounts, time = now) => { await act(async () => root.render(<QuotaWindowTimeline accounts={value} now={time} />)); };
  it('switches window lengths and separates observed quotas from unfilled future projections', async () => {
    await render();
    expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-estimated-window]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-reported-reset]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-projected-window]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-projected-window]')?.getAttribute('aria-label')).toContain('key_quota.estimated_reset');
    expect(container.querySelector('[data-projected-window] [data-quota-used-fill]')).toBeNull();
    expect(container.textContent).not.toContain('Quota window 3');
    expect(container.textContent).not.toContain('Quota window 4');
    expect(container.textContent).toContain('Oct 11 – Oct 24');
    expect(container.textContent).toContain('key_quota.account');
    const short = [...container.querySelectorAll('button')].find((button) => button.textContent === 'key_quota.window_short')!;
    await act(async () => short.click());
    expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(1);
    expect(container.textContent).toContain('100% key_quota.used');
    expect(container.querySelectorAll('[data-estimated-window]')).toHaveLength(1);
    const all = [...container.querySelectorAll('button')].find((button) => button.textContent === 'key_quota.window_all')!;
    await act(async () => all.click());
    expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-estimated-window]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-reported-reset]')).toHaveLength(1);
    expect(container.textContent).toContain('key_quota.reset_unknown');
    expect(container.textContent).toContain('key_quota.start_unknown');
  });
  it('navigates ranges without changing observations and marks a passed reset stale', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="key_quota.next_range"]')!.click());
    expect(container.querySelectorAll('[data-estimated-window]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-projected-window]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('key_quota.outside_range');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'key_quota.today')!.click());
    expect(container.querySelectorAll('[data-estimated-window]')).toHaveLength(1);
    await render(accounts, now + 3 * 86400000);
    expect(container.querySelector('[data-estimated-window]')?.parentElement?.getAttribute('data-stale')).toBe('true');
    expect(container.querySelector('[data-window-lane]')?.textContent).toContain('62%');
    expect(container.querySelector('[data-estimated-window]')?.textContent).toContain('key_quota.reset_passed_short');
  });
  it('marks the weekly lane stale when another window expires and keeps full reset dates accessible', async () => {
    await render(accounts, now + 2 * hour);
    const lane = container.querySelector('[data-window-lane]')!;
    expect(lane.querySelector('[data-quota-plot]')?.getAttribute('data-stale')).toBe('true');
    expect(lane.querySelector('[role="group"]')?.getAttribute('aria-label')).toContain('key_quota.last_observed');
    expect(container.querySelector('details')).toBeNull();
    expect(lane.querySelector('time')?.getAttribute('datetime')).toBe(accounts[0].rows[0].reset_at);
    expect(lane.textContent).toContain('key_quota.stale');
    expect(lane.querySelector('time')?.getAttribute('title')).toBeTruthy();
  });
  it('does not override user timeline scrolling on a tick or ordinary cache read', async () => {
    await render();
    const scroll = container.querySelector<HTMLElement>('[role="region"]')!;
    scroll.scrollLeft = 100;
    await render([...accounts], now + 1000);
    expect(scroll.scrollLeft).toBe(100);
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'key_quota.today')!.click());
    expect(scroll.scrollLeft).toBe(0); // happy-dom has no plot layout width.
  });
  it('compares the supplied quota shares with time elapsed and labels the Now marker', async () => {
    const time = Date.parse('2026-10-14T22:00:00-03:00');
    await render([
      { ...accounts[0], id: 'claude', provider: 'Claude', rows: [{ id: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 91, reset_at: '2026-10-21T07:59:00-03:00' }] },
      { ...accounts[0], id: 'codex', rows: [{ id: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 28, reset_at: '2026-10-20T01:58:00-03:00' }] },
    ], time);
    const lanes = container.querySelectorAll('[data-window-lane]');
    expect(lanes[0].textContent).toContain('9% key_quota.used');
    expect(lanes[0].textContent).toContain('8.3% key_quota.time_elapsed');
    expect(lanes[1].textContent).toContain('72% key_quota.used');
    expect(lanes[1].textContent).toContain('26.2% key_quota.time_elapsed');
    const fills = [...container.querySelectorAll<HTMLElement>('[data-quota-used-fill]')];
    expect(parseFloat(fills[0].style.width)).toBeCloseTo(9);
    expect(parseFloat(fills[1].style.width)).toBeCloseTo(72);
    const marker = container.querySelector('[data-quota-now]')!;
    expect(marker.textContent).toContain('key_quota.now');
    expect(marker.querySelector('time')?.dateTime).toBe(new Date(time).toISOString());
    expect(lanes[0].querySelector('[data-quota-plot]')?.getAttribute('aria-label')).toContain('91%');
  });
  it('keeps unknown consumption unfilled, stale consumption historic, and passed windows expired', async () => {
    const row = accounts[0].rows[0];
    await render([{ ...accounts[0], rows: [{ ...row, remaining_percent: undefined }] }]);
    expect(container.querySelector('[data-quota-used-fill]')).toBeNull();
    expect(container.textContent).toContain('key_quota.unknown key_quota.used');
    for (const [remaining, fill] of [[100, 0], [0, 100]]) {
      await render([{ ...accounts[0], rows: [{ ...row, remaining_percent: remaining }] }]);
      expect(parseFloat(container.querySelector<HTMLElement>('[data-quota-used-fill]')!.style.width)).toBeCloseTo(fill);
    }
    await render([{ ...accounts[0], status: 'stale', rows: [row] }]);
    expect(container.querySelector('[data-quota-plot]')?.getAttribute('data-stale')).toBe('true');
    expect(container.querySelector('[data-quota-plot]')?.getAttribute('aria-label')).toContain('key_quota.last_observed');
    expect(container.querySelector('[data-quota-plot]')?.getAttribute('aria-label')).toContain('62%');
    const historicFill = container.querySelector<HTMLElement>('[data-quota-used-fill]')!.style.width;
    await render([{ ...accounts[0], rows: [row] }], now + 3 * 86400000);
    expect(container.querySelector('[data-quota-plot]')?.getAttribute('data-stale')).toBe('true');
    expect(container.textContent).toContain('key_quota.reset_passed_short');
    expect(container.querySelector<HTMLElement>('[data-quota-used-fill]')!.style.width).toBe(historicFill);
  });
  it('excludes unavailable snapshots and follows the filtered account set', async () => {
    await render([{ ...accounts[0], status: 'unavailable' }]);
    expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-projected-window]')).toHaveLength(0);
    expect(container.textContent).toContain('key_quota.no_windows');
    await render([]);
    expect(container.querySelectorAll('[data-window-lane]')).toHaveLength(0);
  });
});
