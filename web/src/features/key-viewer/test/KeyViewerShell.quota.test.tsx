// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { KeyViewerShell } from '../KeyViewerShell';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/dashboard/DashboardHeader', () => ({ DashboardHeader: () => <div>Viewer</div> }));
vi.mock('@/components/dashboard/DashboardToolbar', () => ({ DashboardToolbar: ({ items }: { items: { id: string; label: string; href: string }[] }) => <nav>{items.map((item) => <a key={item.id} href={item.href}>{item.label}</a>)}</nav> }));

describe('quota navigation capability', () => {
  it.each([undefined, false, true])('shows quotas only with capability %s', (enabled) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<KeyViewerShell activePage="overview" apiKey={{ display_key: 'private-viewer', quota_enabled: enabled }} onRefresh={vi.fn()} onNavigate={vi.fn()}>Personal usage</KeyViewerShell>));
    expect(container.querySelector('a[href="/quotas"]') !== null).toBe(enabled === true);
    expect(container.querySelector('a[href="/key-overview"]')).not.toBeNull();
    expect(container.textContent).toContain('Personal usage');
    act(() => root.unmount());
  });
});
