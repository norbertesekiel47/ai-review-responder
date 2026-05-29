'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { usePendingCount } from './PendingCountContext';

const NEEDS_ACTION_HASH = '#needs-action';

interface Props {
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
}

export function MobileTabBar({ pastRepliesEnabled, editRepliesEnabled = false }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  // Home and "Needs Action" both live on /dashboard; the URL hash is the only
  // differentiator. usePathname() drops the hash and Next's <Link> pushState
  // navigation does not reliably emit `hashchange`, so we track the hash here:
  // a mount read seeds it, hashchange/popstate cover back/forward + deep links,
  // and an optimistic onClick gives instant tap feedback. Seeding with '' is
  // safe: this is a client-only component, so the mount-time correction is not
  // an SSR hydration mismatch.
  const [hash, setHash] = useState('');
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const onDashboard = pathname === '/dashboard';
  const isNeedsAction = onDashboard && hash === NEEDS_ACTION_HASH;
  const isHome = onDashboard && !isNeedsAction;
  const isHistory = pathname === '/dashboard/past-replies';
  const isSettings = pathname.startsWith('/settings');

  return (
    <nav className="mobile-tabbar">
      <Link
        href="/dashboard"
        className={`mtab ${isHome ? 'active' : ''}`}
        onClick={() => setHash('')}
      >
        <Icon name="home" size={22} /> Home
      </Link>
      <Link
        href={`/dashboard${NEEDS_ACTION_HASH}`}
        className={`mtab ${isNeedsAction ? 'active' : ''}`}
        onClick={() => setHash(NEEDS_ACTION_HASH)}
      >
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
