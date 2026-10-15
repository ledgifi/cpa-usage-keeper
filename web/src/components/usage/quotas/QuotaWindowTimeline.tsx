import { useEffect, useRef, useState } from 'react';
import { quotaDisplayStatus, shortQuotaTimestamp } from './quotaDisplay';
import { useTranslation } from 'react-i18next';
import type { ViewerQuotaAccount, ViewerQuotaRow } from '@/lib/types';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import { QuestionMarkHelp } from '@/components/ui/QuestionMarkHelp';
import styles from './QuotaWindowTimeline.module.scss';

type WindowMode = 'all' | 'weekly' | 'short';

function revealNow(element: HTMLDivElement | null) {
  const marker = element?.querySelector<HTMLElement>('[data-quota-now]');
  if (element && marker) element.scrollLeft = Math.max(0, marker.offsetLeft - 36);
}
const hour = 3_600_000;

export function quotaTimelineRange(now: number, short: boolean, offset: number) {
  if (short) {
    const start = Math.floor(now / hour) * hour - 6 * hour + offset * 12 * hour;
    return { start, end: start + 12 * hour, ticks: Array.from({ length: 7 }, (_, index) => start + index * 2 * hour) };
  }
  // Local calendar days, including 23/25-hour days around daylight saving.
  const date = new Date(now);
  const firstDay = date.getDate() - date.getDay() + offset * 14;
  // Construct each midnight independently: a skipped midnight (e.g. Santiago)
  // must not carry its normalized 01:00 into all the following dates.
  const ticks = Array.from({ length: 15 }, (_, index) => new Date(date.getFullYear(), date.getMonth(), firstDay + index).getTime());
  return { start: ticks[0], end: ticks[14], ticks };
}

export function quotaUsedPercent(row: ViewerQuotaRow): number | null {
  const valid = (value: number | undefined) => value != null && Number.isFinite(value) && value >= 0 && value <= 100;
  if (valid(row.used_percent)) return row.used_percent!;
  return valid(row.remaining_percent) ? 100 - row.remaining_percent! : null;
}

export function quotaWindowGeometry(row: ViewerQuotaRow, start: number, end: number) {
  const reset = Date.parse(row.reset_at ?? '');
  if (!Number.isFinite(reset)) return null;
  const seconds = row.window_seconds;
  const estimatedStart = seconds != null && Number.isFinite(seconds) && seconds > 0 && seconds <= 366 * 86400 ? reset - seconds * 1000 : null;
  const percent = (time: number) => (time - start) / (end - start) * 100;
  const left = Math.max(0, Math.min(100, percent(estimatedStart ?? reset)));
  const right = Math.max(0, Math.min(100, percent(reset)));
  const used = quotaUsedPercent(row);
  // Project quota consumed onto the full window before clipping to the viewport.
  // This compares consumption with time elapsed; it is not a usage history.
  const usedEnd = estimatedStart != null && used != null ? estimatedStart + (reset - estimatedStart) * used / 100 : null;
  const usedWidth = usedEnd != null ? Math.max(0, Math.min(100, percent(usedEnd)) - left) : null;
  return { reset, estimatedStart, left, width: Math.max(0, right - left), usedWidth, resetPosition: percent(reset), visible: reset >= start && (estimatedStart ?? reset) <= end };
}

export function quotaFutureWindows(row: ViewerQuotaRow, start: number, end: number, now: number) {
  const observed = quotaWindowGeometry(row, start, end);
  if (observed?.estimatedStart == null || end <= start || ![start, end, now].every(Number.isFinite)) return [];
  const duration = observed.reset - observed.estimatedStart;
  // Skip directly to the visible range; never turn an inferred cycle into a
  // current observation after the cached reset passes.
  const first = Math.max(0, Math.floor((start - observed.reset) / duration), Math.ceil((now - observed.reset) / duration));
  const cycles = [];
  for (let index = 0; index < 128; index++) {
    const cycleStart = observed.reset + (first + index) * duration;
    if (cycleStart >= end) break;
    const cycleEnd = cycleStart + duration;
    const left = Math.max(0, (cycleStart - start) / (end - start) * 100);
    const right = Math.min(100, (cycleEnd - start) / (end - start) * 100);
    if (right > left) cycles.push({ start: cycleStart, end: cycleEnd, left, width: right - left });
  }
  return cycles;
}

export function QuotaWindowTimeline({ accounts, now }: { accounts: ViewerQuotaAccount[]; now: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language;
  const [mode, setMode] = useState<WindowMode>('weekly');
  const [offset, setOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const range = quotaTimelineRange(now, mode === 'short', offset);
  const position = (value: number) => (value - range.start) / (range.end - range.start) * 100;
  const nowPosition = position(now);
  const lanes = accounts.flatMap((account) => account.status === 'unavailable' ? [] : account.rows
    .filter((row) => mode === 'all' || row.window_seconds === (mode === 'weekly' ? 604800 : 18000))
    .map((row) => ({ account, row })));
  const timestamp = (value: number) => new Date(value).toLocaleString(locale);
  const date = (value: number) => new Date(value).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const percent = (value: number) => `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
  const hasLanes = lanes.length > 0;
  // Only navigation or the first render repositions the chart, never a clock tick.
  useEffect(() => revealNow(scrollRef.current), [mode, offset, hasLanes]);
  return <section className={styles.section} aria-labelledby="quota-windows-heading">
    <header className={styles.header}>
      <div><div className={styles.title}><h2 id="quota-windows-heading">{t('key_quota.windows')}</h2><QuestionMarkHelp label={t('key_quota.windows')} description={t('key_quota.window_note')}>{t('key_quota.window_note')}</QuestionMarkHelp></div><p>{date(range.start)} – {date(range.end - 1)} · {t('key_quota.local_time')}</p></div>
      <div className={styles.controls}>
        <div className={styles.navigation}>
          <button type="button" aria-label={t('key_quota.previous_range')} disabled={offset <= -26} onClick={() => setOffset((value) => value - 1)}><IconChevronLeft size={16} /></button>
          <button type="button" onClick={() => { setOffset(0); revealNow(scrollRef.current); }}>{t('key_quota.today')}</button>
          <button type="button" aria-label={t('key_quota.next_range')} disabled={offset >= 26} onClick={() => setOffset((value) => value + 1)}><IconChevronRight size={16} /></button>
        </div>
        <div className={styles.modes} role="group" aria-label={t('key_quota.window_mode')}>
          {(['all', 'weekly', 'short'] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setOffset(0); }}>{t(`key_quota.window_${value}`)}</button>)}
        </div>
      </div>
    </header>
    {lanes.length === 0 ? <p className={styles.empty}>{t('key_quota.no_windows')}</p> : <div className={styles.scroll} ref={scrollRef} role="region" aria-label={t('key_quota.window_chart')} tabIndex={0}>
      <div className={styles.chart}>
        <div className={styles.axis}><div className={styles.axisLabel}>{t('key_quota.account')}</div><div className={styles.scale}>
          {range.ticks.slice(0, -1).map((tick, index) => <div key={tick} className={styles.tick} style={{ left: `${position(tick)}%`, width: `${position(range.ticks[index + 1]) - position(tick)}%` }}>
            <span>{new Date(tick).toLocaleDateString(locale, { weekday: 'short' })}</span><strong>{mode === 'short' ? new Date(tick).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : new Date(tick).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })}</strong>
          </div>)}
          {nowPosition >= 0 && nowPosition <= 100 && <div className={styles.axisNow} data-quota-now style={{ left: `${nowPosition}%` }}><time dateTime={new Date(now).toISOString()} title={timestamp(now)}>{t('key_quota.now')}</time></div>}
        </div></div>
        {lanes.map(({ account, row }) => {
          const geometry = quotaWindowGeometry(row, range.start, range.end);
          const future = quotaFutureWindows(row, range.start, range.end, now);
          const expired = geometry != null && geometry.reset <= now;
          const status = quotaDisplayStatus(account, now);
          const stale = status === 'stale';
          const used = quotaUsedPercent(row);
          const elapsed = geometry?.estimatedStart != null ? Math.max(0, Math.min(100, (now - geometry.estimatedStart) / (geometry.reset - geometry.estimatedStart) * 100)) : null;
          const value = row.remaining_percent == null ? t('key_quota.unknown') : percent(row.remaining_percent);
          const usage = `${used == null ? t('key_quota.unknown') : percent(used)} ${t('key_quota.used').toLocaleLowerCase(locale)}`;
          const elapsedLabel = elapsed != null ? `${percent(elapsed)} ${t('key_quota.time_elapsed')}` : '';
          const title = `${stale ? `${t('key_quota.last_observed')} · ` : ''}${account.label} · ${row.label} · ${usage} · ${t('key_quota.remaining')}: ${value}${elapsedLabel ? ` · ${elapsedLabel}` : ''}${geometry ? ` · ${t('key_quota.resets')}: ${timestamp(geometry.reset)}` : ''}${geometry?.estimatedStart != null ? ` · ${t('key_quota.estimated_start')}: ${timestamp(geometry.estimatedStart)}` : ''}`;
          return <div className={styles.lane} key={`${account.id}/${row.id}`} data-provider={account.provider} data-window-lane>
            <div className={styles.identity}>
              <div><ProviderBrandIcon providerType={account.provider} size={18} /><strong title={account.label}>{account.label}</strong>{stale && <span className={styles.stale}>{t('key_quota.stale')}</span>}</div>
              <span>{row.label} · {usage}</span>
            </div>
            <div className={styles.plot} data-quota-plot role="group" aria-label={title} title={title} data-stale={stale}>
              {range.ticks.slice(0, -1).map((tick) => <i className={styles.gridline} style={{ left: `${position(tick)}%` }} key={tick} />)}
              {geometry?.visible ? <>
                {geometry.estimatedStart != null && geometry.width > 0 && <div className={styles.span} style={{ left: `${geometry.left}%`, width: `${geometry.width}%` }} data-estimated-window>
                  {geometry.usedWidth != null && <i className={styles.usedFill} data-quota-used-fill style={{ width: `${geometry.usedWidth / geometry.width * 100}%` }} aria-hidden="true" />}
                  <span className={styles.windowLabel}>{expired ? <span title={t('key_quota.reset_passed')}>{t('key_quota.reset_passed_short')}</span> : elapsedLabel} · <time dateTime={row.reset_at} title={timestamp(geometry.reset)}>{shortQuotaTimestamp(row.reset_at, locale)}</time></span>
                </div>}
                {geometry.estimatedStart == null && geometry.resetPosition >= 0 && geometry.resetPosition <= 100 && <span className={styles.resetMarker} style={{ left: `${geometry.resetPosition}%` }} data-reported-reset />}
              </> : future.length === 0 && <span className={styles.unknown}>{t(geometry ? 'key_quota.outside_range' : 'key_quota.reset_unknown')}</span>}
              {geometry?.visible && geometry.estimatedStart == null && <span className={styles.unknown}>{t('key_quota.start_unknown')} · <time dateTime={row.reset_at} title={timestamp(geometry.reset)}>{shortQuotaTimestamp(row.reset_at, locale)}</time></span>}
              {future.map((cycle) => {
                const projectionTitle = `${account.label} · ${row.label} · ${t('key_quota.projected_cycle')} · ${t('key_quota.estimated_start')}: ${timestamp(cycle.start)} · ${t('key_quota.estimated_reset')}: ${timestamp(cycle.end)}`;
                return <div key={cycle.start} className={`${styles.span} ${styles.future}`} style={{ left: `${cycle.left}%`, width: `${cycle.width}%` }} data-projected-window role="group" aria-label={projectionTitle} title={projectionTitle}>
                  <span className={styles.windowLabel}><time dateTime={new Date(cycle.end).toISOString()}>{shortQuotaTimestamp(new Date(cycle.end).toISOString(), locale)}</time></span>
                </div>;
              })}
              {nowPosition >= 0 && nowPosition <= 100 && <span className={styles.now} data-quota-now style={{ left: `${nowPosition}%` }} aria-hidden="true" />}
            </div>
          </div>;
        })}
      </div>
    </div>}
    <div className={styles.legend}><span><i className={styles.legendSpan} />{t('key_quota.nominal_window')}</span><span><i className={styles.legendUsed} />{t('key_quota.quota_used')}</span><span><i className={styles.legendFuture} />{t('key_quota.projected_cycle')}</span><span><i className={styles.legendNow} />{t('key_quota.now')}</span></div>
  </section>;
}
