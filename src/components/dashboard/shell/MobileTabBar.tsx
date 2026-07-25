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

  // Home is an EXACT match here, unlike the sidebar's Dashboard row which is the
  // catch-all for any unmatched /dashboard/* route. That difference is
  // deliberate and predates #544, so it is kept rather than folded into
  // deriveNavSection.
  const isHome = pathname === '/dashboard';
  const activeNav = deriveNavSection(pathname);

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
      {solicitationEnabled && (
        <Link
          href="/dashboard/requests"
          className={`mtab ${activeNav === 'requests' ? 'active' : ''}`}
          aria-current={activeNav === 'requests' ? 'page' : undefined}
        >
          <Icon name="trend" size={22} /> Requests
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
