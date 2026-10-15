import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewerQuotaRow } from '@/lib/types';
import { resetCountdown, shortQuotaTimestamp } from './quotaDisplay';
import adminStyles from '../credentials/CredentialSections.module.scss';
import styles from './QuotaMeter.module.scss';

// Shared display fields only. Admin-only details can be supplied as children.
export function QuotaMeter({ row, accountLabel, stale, now, label, children, timeZone }: { row: ViewerQuotaRow; accountLabel: string; stale: boolean; now: number; label?: ReactNode; children?: ReactNode; timeZone?: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language;
  const number = (value: number | undefined) => value == null ? t('key_quota.unknown') : value.toLocaleString(locale, { maximumFractionDigits: 2 });
  const countdown = resetCountdown(row.reset_at, now, locale);
  const value = row.remaining_percent == null ? number(row.remaining) : `${number(row.remaining_percent)}%`;
  const description = `${stale ? `${t('key_quota.last_observed')} · ` : ''}${t('key_quota.remaining')}: ${value}`;
  let fillClass = adminStyles.credentialQuotaFillOk;
  if (stale) fillClass = adminStyles.credentialQuotaFillUnknown;
  else if (row.limit_reached || row.remaining_percent != null && row.remaining_percent < 20) fillClass = adminStyles.credentialQuotaFillDanger;
  else if (row.remaining_percent != null && row.remaining_percent < 50) fillClass = adminStyles.credentialQuotaFillWarning;
  const resetTime = shortQuotaTimestamp(row.reset_at, locale, timeZone);
  return <div className={`${adminStyles.credentialQuotaBarBlock} ${styles.meter}`} data-stale={stale} data-quota-meter>
    <div className={`${adminStyles.credentialQuotaBarHeader} ${styles.heading}`}>
      <strong className={adminStyles.credentialQuotaLabelGroup}>{label ?? row.label}</strong>
      <span className={styles.value} title={description}>{value} <span>{t('key_quota.remaining')}</span></span>
    </div>
    {row.remaining_percent != null
      ? <div className={adminStyles.credentialQuotaTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.remaining_percent} aria-valuetext={description} aria-label={`${accountLabel ? `${accountLabel} · ` : ''}${row.label}: ${description}`}><span className={`${adminStyles.credentialQuotaFill} ${fillClass}`} style={{ width: `${Math.max(0, Math.min(100, row.remaining_percent))}%` }} /></div>
      : <div className={styles.unknownTrack} aria-hidden="true" />}
    {row.metric && <span>{t(`key_quota.unit_${row.metric}`)}</span>}
    <div className={styles.reset}>
      {countdown === 'expired' ? <span data-reset-countdown title={t('key_quota.reset_passed')} aria-label={t('key_quota.reset_passed')}>{t('key_quota.reset_passed_short')}</span>
        : countdown && <span data-reset-countdown>{t('key_quota.reset_in')} {countdown}</span>}
      {resetTime ? <>
        <span aria-hidden="true">·</span>
        <time dateTime={row.reset_at} aria-label={`${t('key_quota.resets')}: ${new Date(row.reset_at!).toLocaleString(locale, { timeZone })}`} title={new Date(row.reset_at!).toLocaleString(locale, { timeZone })}>{resetTime}</time>
      </> : !countdown && <span>{t('key_quota.reset_unknown')}</span>}
    </div>
    {row.used_percent != null && row.remaining_percent == null && <p>{stale && `${t('key_quota.last_observed')} · `}{t('key_quota.used')}: {number(row.used_percent)}%</p>}
    {(row.used != null || row.limit != null || row.remaining != null) && <p>{stale && `${t('key_quota.last_observed')} · `}{t('key_quota.used')}: {number(row.used)} · {t('key_quota.limit')}: {number(row.limit)}{row.remaining_percent != null && <> · {t('key_quota.remaining_amount')}: {number(row.remaining)}</>}</p>}
    {children}
    {row.limit_reached && <p>{t(stale ? 'key_quota.exhausted_observed' : 'key_quota.exhausted')}</p>}
  </div>;
}
