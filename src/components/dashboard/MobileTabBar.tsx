'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './Icon';

interface Props {
  pastRepliesEnabled: boolean;
}

// Note: the Needs Action tab does not currently surface a pending-count badge.
// Doing so requires lifting `pendingCount` from DashboardContent into a
// shared context (the layout is server-rendered and has no access to the
// /api/dashboard payload). Tracked as a follow-up — see PR #27 review.

export function MobileTabBar({ pastRepliesEnabled }: Props) {
  const pathname = usePathname() ?? '';
  const isHome = pathname === '/dashboard';
  const isHistory = pathname === '/dashboard/past-replies';
  const isSettings = pathname.startsWith('/settings');

  return (
    <nav className="mobile-tabbar">
      <Link href="/dashboard" className={`mtab ${isHome ? 'active' : ''}`}>
        <Icon name="home" size={22} /> Home
      </Link>
      <Link href="/dashboard#needs-action" className="mtab">
        <Icon name="inbox" size={22} /> Needs Action
      </Link>
      {pastRepliesEnabled && (
        <Link href="/dashboard/past-replies" className={`mtab ${isHistory ? 'active' : ''}`}>
          <Icon name="history" size={22} /> History
        </Link>
      )}
      <Link href="/settings" className={`mtab ${isSettings ? 'active' : ''}`}>
        <Icon name="cog" size={22} /> Settings
      </Link>
    </nav>
  );
}
