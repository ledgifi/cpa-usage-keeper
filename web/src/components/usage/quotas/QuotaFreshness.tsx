import { useTranslation } from 'react-i18next';
import type { ViewerQuotaAccount } from '@/lib/types';
import { quotaObservationAge } from './quotaDisplay';
import styles from './QuotaFreshness.module.scss';

export function QuotaFreshness({ status, updatedAt, now }: { status: ViewerQuotaAccount['status']; updatedAt?: string; now: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language;
  const timestamp = updatedAt && Number.isFinite(Date.parse(updatedAt)) ? new Date(updatedAt).toLocaleString(locale) : t('key_quota.unknown');
  return <span className={styles.freshness} data-quota-freshness data-status={status}>
    {(status === 'stale' || status === 'unavailable') && <span className={styles.status} data-status={status}>{t(`key_quota.${status}`)} <span aria-hidden="true">·</span></span>}
    <span>{t('key_quota.updated')} <time dateTime={updatedAt} title={timestamp} aria-label={timestamp}>{quotaObservationAge(updatedAt, now, locale) ?? t('key_quota.unknown')}</time></span>
  </span>;
}
