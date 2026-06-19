'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/dashboard/shell/Icon';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
}

export function MobileTabBar({ pastRepliesEnabled }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  const isHome = pathname === '/dashboard';
  const isReviews = pathname.startsWith('/dashboard/reviews');
  const isHistory = pathname === '/dashboard/past-replies';
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
      {pastRepliesEnabled && (
        <Link
          href="/dashboard/past-replies"
          className={`mtab ${isHistory ? 'active' : ''}`}
          aria-current={isHistory ? 'page' : undefined}
        >
          <Icon name="history" size={22} /> History
        </Link>
      )}
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
