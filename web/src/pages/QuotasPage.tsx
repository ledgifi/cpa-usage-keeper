import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyViewerShell } from '@/features/key-viewer/KeyViewerShell';
import type { KeyViewerPath } from '@/features/key-viewer/navigation';
import { ApiError, fetchQuotas } from '@/lib/api';
import type { AuthSessionAPIKeySummary, ViewerQuotaResponse } from '@/lib/types';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { CredentialSubscriptionBadge } from '@/components/usage/credentials/CredentialSubscriptionBadge';
import { resolveCredentialSubscriptionBadge } from '@/components/usage/credentials/credentialSubscription';
import adminStyles from '@/components/usage/credentials/CredentialSections.module.scss';
import { QuotaWindowTimeline } from '@/components/usage/quotas/QuotaWindowTimeline';
import { Button } from '@/components/ui/Button';
import { quotaDisplayStatus } from '@/components/usage/quotas/quotaDisplay';
import { QuotaMeter } from '@/components/usage/quotas/QuotaMeter';
import { QuotaFreshness } from '@/components/usage/quotas/QuotaFreshness';
import { useQuotaClock } from '@/components/usage/quotas/useQuotaClock';
import { CredentialSectionShell } from '@/components/usage/credentials/CredentialSectionShell';
import styles from './QuotasPage.module.scss';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';

export function QuotasPage({ apiKey, onNavigate, onAuthRequired }: {
  apiKey?: AuthSessionAPIKeySummary;
  onNavigate: (path: KeyViewerPath) => void;
  onAuthRequired?: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ViewerQuotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const now = useQuotaClock(clockOffset);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await fetchQuotas(controller.signal);
      if (controller.signal.aborted) return;
      const serverTime = Date.parse(result.server_time);
      setClockOffset(Number.isFinite(serverTime) ? serverTime - Date.now() : 0);
      setData(result);
      setError(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      setData(null);
      setError(true);
      if (err instanceof ApiError && err.status === 401) onAuthRequired?.();
      if (err instanceof ApiError && err.status === 403) onNavigate('/key-overview');
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [onAuthRequired, onNavigate]);

  useHeaderRefresh(refresh);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  const accounts = data?.accounts ?? [];
  const orderedAccounts = [...accounts].sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));

  const content = <div className={styles.quotaPage}>
      <header className={styles.pageHeading}>
        <h1>{t('key_quota.heading')}</h1>
      </header>
      {data && !data.scheduled_refresh_enabled && <p className={styles.notice}>{t('key_quota.schedule_disabled')}</p>}
      {error && <div className={styles.error} role="alert"><p>{t('key_quota.error')}</p><Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => void refresh()}>{t('key_quota.retry_cache')}</Button></div>}
      {loading && !data && <p role="status">{t('common.loading')}</p>}
      {!loading && data?.accounts.length === 0 && <p>{t('key_quota.empty')}</p>}
      {accounts.length > 0 && <>
        <CredentialSectionShell title={t('usage_stats.credentials_title')} subtitle={t('key_quota.shared')}
          countLabel={String(accounts.length)}>
          {orderedAccounts.map((account) => {
            const status = quotaDisplayStatus(account, now);
            const badge = account.subscription && resolveCredentialSubscriptionBadge({ provider: account.provider, plan: account.subscription.plan, tierName: account.subscription.tier });
            return <article className={`${adminStyles.credentialRow} ${styles.subscription}`} key={account.id} data-quota-account={account.id} data-status={status}>
              <div className={styles.identity}>
                <div className={styles.accountName}><ProviderBrandIcon providerType={account.provider} size={34} /><h3>{account.label}</h3></div>
                <div className={adminStyles.credentialIdentityBadges}>
                  {badge && <span aria-label={t('key_quota.plan')}><CredentialSubscriptionBadge model={badge} /></span>}
                  <QuotaFreshness status={status} updatedAt={account.updated_at} now={now} />
                </div>
              </div>
              <div className={adminStyles.credentialQuotaBars}>
                {(account.rows.length === 0 || status === 'unavailable') && <p className={styles.description}>{t('key_quota.no_values')}</p>}
                {status !== 'unavailable' && account.rows.map((row) => <QuotaMeter key={row.id} row={row} accountLabel={account.label} stale={status === 'stale'} now={now} />)}
              </div>
            </article>;
          })}
        </CredentialSectionShell>
        <QuotaWindowTimeline accounts={orderedAccounts} now={now} />
      </>}
    </div>;

  return <KeyViewerShell activePage="quota" apiKey={apiKey} onNavigate={onNavigate} onAuthRequired={onAuthRequired}
    onRefresh={() => void refresh()} refreshing={loading} refreshDisabled={loading}>{content}</KeyViewerShell>;
}
