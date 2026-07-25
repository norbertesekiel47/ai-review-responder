'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/dashboard/shell/Icon';
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

  const isHome = pathname === '/dashboard';
  // /dashboard/reviews and /dashboard/reviews/history both highlight Reviews;
  // /dashboard/requests and /dashboard/requests/contacts both highlight Requests.
  const isReviews = pathname.startsWith('/dashboard/reviews');
  const isRequests = pathname.startsWith('/dashboard/requests');
  const isAnalytics = pathname.startsWith('/dashboard/analytics');
  const isSettings = pathname.startsWith('/settings');

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
        className={`mtab ${isReviews ? 'active' : ''}`}
        aria-current={isReviews ? 'page' : undefined}
      >
        <Icon name="inbox" size={22} /> Reviews
        {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
      </Link>
      {solicitationEnabled && (
        <Link
          href="/dashboard/requests"
          className={`mtab ${isRequests ? 'active' : ''}`}
          aria-current={isRequests ? 'page' : undefined}
        >
          <Icon name="trend" size={22} /> Requests
        </Link>
      )}
      <Link
        href="/dashboard/analytics"
        className={`mtab ${isAnalytics ? 'active' : ''}`}
        aria-current={isAnalytics ? 'page' : undefined}
      >
        <Icon name="chart" size={22} /> Analytics
      </Link>
      <Link
        href="/settings"
        className={`mtab ${isSettings ? 'active' : ''}`}
        aria-current={isSettings ? 'page' : undefined}
      >
        <Icon name="cog" size={22} /> Settings
      </Link>
    </nav>
  );
}
