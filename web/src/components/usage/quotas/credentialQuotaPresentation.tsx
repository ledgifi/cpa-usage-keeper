import { useTranslation } from 'react-i18next'
import type { ViewerQuotaAccount, ViewerQuotaRow } from '@/lib/types'
import type { CredentialRow, DisplayQuota } from '../credentials/credentialViewModels'
import { QuotaFreshness } from './QuotaFreshness'
import { QuotaWindowTimeline } from './QuotaWindowTimeline'
import { quotaDisplayStatus } from './quotaDisplay'
import styles from './QuotaFreshness.module.scss'

// Admin data is adapted only for shared presentation. Viewer data comes from
// the dedicated server-side allowlist, never from these credential rows.
export function credentialQuotaAccount(row: CredentialRow): ViewerQuotaAccount {
  const unavailable = row.quotaLoading || row.quotaError || row.refreshStatus === 'queued' || row.refreshStatus === 'running' || row.refreshStatus === 'failed' || row.displayQuotas.length === 0
  return {
    id: row.identity.id || row.identity.identity,
    label: row.displayName,
    provider: row.identity.type,
    status: unavailable ? 'unavailable' : row.quotaCache?.status ?? 'cached',
    updated_at: row.quotaCache?.updated_at,
    fresh_until: row.quotaCache?.fresh_until,
    rows: unavailable ? [] : row.displayQuotas.map(displayQuotaRow),
  }
}

export function displayQuotaRow(quota: DisplayQuota): ViewerQuotaRow {
  return { id: quota.key, label: quota.label, limit_reached: quota.limitReached, remaining_percent: quota.barPercent ?? undefined, reset_at: quota.resetText, window_seconds: quota.windowSeconds }
}

export function CredentialQuotaFreshness({ row, now }: { row: CredentialRow; now: number }) {
  const account = credentialQuotaAccount(row)
  return <QuotaFreshness status={quotaDisplayStatus(account, now)} updatedAt={account.updated_at} now={now} />
}

export function CredentialQuotaTimeline({ rows, now, scheduledRefreshEnabled }: { rows: CredentialRow[]; now: number; scheduledRefreshEnabled?: boolean | null }) {
  const { t } = useTranslation()
  const accounts = rows.filter((row) => !row.identity.is_deleted && row.identity.disabled !== true).map(credentialQuotaAccount)
  return <>
    {scheduledRefreshEnabled === false && <p className={styles.notice}>{t('key_quota.schedule_disabled')}</p>}
    <QuotaWindowTimeline accounts={accounts} now={now} />
  </>
}
