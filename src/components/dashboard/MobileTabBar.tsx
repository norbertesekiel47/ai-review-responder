'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './Icon';
import { usePendingCount } from './PendingCountContext';

interface Props {
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
}

export function MobileTabBar({ pastRepliesEnabled, editRepliesEnabled = false }: Props) {
  const pathname = usePathname() ?? '';
  const isHome = pathname === '/dashboard';
  const isHistory = pathname === '/dashboard/past-replies';
  const isSettings = pathname.startsWith('/settings');
  const pendingCount = usePendingCount();

  return (
    <nav className="mobile-tabbar">
      <Link href="/dashboard" className={`mtab ${isHome ? 'active' : ''}`}>
        <Icon name="home" size={22} /> Home
      </Link>
      <Link href="/dashboard#needs-action" className="mtab">
        <Icon name="inbox" size={22} /> Needs Action
        {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
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
