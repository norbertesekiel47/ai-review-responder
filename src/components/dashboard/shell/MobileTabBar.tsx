'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/dashboard/shell/Icon';
import { deriveNavSection } from '@/components/dashboard/shell/active-nav';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  /** Server-authoritative SOLICITATION_WATCH_ENABLED, passed down from
   *  (authenticated)/layout.tsx. Invariant #13: the browser learns flag state
   *  only through this prop — there is no NEXT_PUBLIC companion. */
  solicitationEnabled: boolean;
}

export function MobileTabBar({ solicitationEnabled }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  // Home follows the same rule as the sidebar's Dashboard row: the catch-all
  // for any /dashboard/* route no other tab owns (connect, add-location). The
  // two navs used to disagree there — the sidebar lit Dashboard, this bar lit
  // nothing (UX audit D30).
  const activeNav = deriveNavSection(pathname);
  const isHome = activeNav === 'dashboard';

  return (
    <nav className="mobile-tabbar" aria-label="Dashboard">
      <Link
        href="/dashboard"
        className={`mtab ${isHome ? 'active' : ''}`}
        aria-current={isHome ? 'page' : undefined}
      >
        <Icon name="home" size={22} /> Home
      </Link>
      <Link
        href="/dashboard/reviews"
        className={`mtab ${activeNav === 'reviews' ? 'active' : ''}`}
        aria-current={activeNav === 'reviews' ? 'page' : undefined}
      >
        <Icon name="inbox" size={22} /> Reviews
        {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
      </Link>
      {solicitationEnabled ? (
        <Link
          href="/dashboard/requests"
          className={`mtab ${activeNav === 'requests' ? 'active' : ''}`}
          aria-current={activeNav === 'requests' ? 'page' : undefined}
        >
          <Icon name="trend" size={22} /> Requests
        </Link>
      ) : (
        /* **Review QR** is visible to EVERY owner (CONTEXT.md), and #1092 moved
           it under Requests — which is gated on watch-mode, OFF in production.
           On a phone the sidebar is hidden, so without this row the surface has
           no entry point at all. It takes the slot Requests would have used, so
           the bar stays five wide. Owner decision 2026-09-03. */
        <Link
          href="/dashboard/requests/qr"
          className={`mtab ${activeNav === 'requests' ? 'active' : ''}`}
          aria-current={activeNav === 'requests' ? 'page' : undefined}
        >
          <Icon name="qr" size={22} /> Review QR
        </Link>
      )}
      <Link
        href="/dashboard/analytics"
        className={`mtab ${activeNav === 'analytics' ? 'active' : ''}`}
        aria-current={activeNav === 'analytics' ? 'page' : undefined}
      >
        <Icon name="chart" size={22} /> Analytics
      </Link>
      <Link
        href="/settings"
        className={`mtab ${activeNav === 'settings' ? 'active' : ''}`}
        aria-current={activeNav === 'settings' ? 'page' : undefined}
      >
        <Icon name="cog" size={22} /> Settings
      </Link>
    </nav>
  );
}
