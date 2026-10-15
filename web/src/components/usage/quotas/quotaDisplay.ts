import type { ViewerQuotaAccount } from '@/lib/types';

export function resetCountdown(resetAt: string | undefined, now: number, locale?: string): string | null {
  if (!resetAt || !Number.isFinite(Date.parse(resetAt))) return null;
  const seconds = Math.ceil((Date.parse(resetAt) - now) / 1000);
  if (seconds <= 0) return 'expired';
  const unit = (value: number, name: 'day' | 'hour' | 'minute' | 'second') => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
  if (seconds < 60) return unit(seconds, 'second');
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), 'minute');
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
}

// A passed window invalidates the account snapshot everywhere, including lanes
// for other windows. Only a newer cached observation can confirm a refill.
export function quotaDisplayStatus(account: ViewerQuotaAccount, now: number): ViewerQuotaAccount['status'] {
  if (account.status === 'unavailable') return 'unavailable';
  if ((account.fresh_until && Date.parse(account.fresh_until) <= now)
    || account.rows.some((row) => Date.parse(row.reset_at ?? '') <= now)) return 'stale';
  return account.status;
}

export function shortQuotaTimestamp(value: string | undefined, locale?: string, timeZone?: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  try {
    return new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
  } catch {
    return null; // A Keeper timezone the browser cannot interpret stays unknown.
  }
}

export function quotaObservationAge(value: string | undefined, now: number, locale?: string): string | null {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (seconds < 60) return formatter.format(0, 'second');
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour');
  return formatter.format(-Math.floor(seconds / 86400), 'day');
}
