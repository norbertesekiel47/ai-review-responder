'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { Icon } from '@/components/dashboard/Icon';
import { usePendingCount } from '@/components/dashboard/PendingCountContext';

const NEEDS_ACTION_HASH = '#needs-action';

// External store for the URL hash. usePathname() drops the hash, and Next's
// <Link> pushState navigation does not reliably emit `hashchange`, so the hash
// is its own source of truth: hashchange/popstate cover back/forward + deep
// links. Reading `window.location.hash` live in getSnapshot is safe — it is a
// primitive, so it only differs (and re-renders) when an event notifies.
function subscribeToHash(onStoreChange: () => void) {
  window.addEventListener('hashchange', onStoreChange);
  window.addEventListener('popstate', onStoreChange);
  return () => {
    window.removeEventListener('hashchange', onStoreChange);
    window.removeEventListener('popstate', onStoreChange);
  };
}

const getHashSnapshot = () => window.location.hash;
// Client-only component: '' matches the pre-hydration seed, so the first
// browser read is not an SSR hydration mismatch.
const getHashServerSnapshot = () => '';

interface Props {
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
}

export function MobileTabBar({ pastRepliesEnabled, editRepliesEnabled = false }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  // Real hash from the external store (back/forward + deep links).
  const storeHash = useSyncExternalStore(
    subscribeToHash,
    getHashSnapshot,
    getHashServerSnapshot,
  );

  // Optimistic override for instant tap feedback: <Link>'s pushState does not
  // fire `hashchange`, so a tap would otherwise leave the active tab stale
  // until the next real event. The override is tagged with the storeHash it was
  // set against; once a real event moves the store, the tag no longer matches
  // and the override is dropped during render (no effect needed), letting the
  // store win again.
  const [optimistic, setOptimistic] = useState<{ base: string; value: string } | null>(null);
  const hash = optimistic && optimistic.base === storeHash ? optimistic.value : storeHash;
  const setHash = (value: string) => setOptimistic({ base: storeHash, value });

  const onDashboard = pathname === '/dashboard';
  const isNeedsAction = onDashboard && hash === NEEDS_ACTION_HASH;
  const isHome = onDashboard && !isNeedsAction;
  const isHistory = pathname === '/dashboard/past-replies';
  const isSettings = pathname.startsWith('/settings');

  return (
    <nav className="mobile-tabbar" aria-label="Dashboard">
      <Link
        href="/dashboard"
        className={`mtab ${isHome ? 'active' : ''}`}
        aria-current={isHome ? 'page' : undefined}
        onClick={() => setHash('')}
      >
        <Icon name="home" size={22} /> Home
      </Link>
      <Link
        href={`/dashboard${NEEDS_ACTION_HASH}`}
        className={`mtab ${isNeedsAction ? 'active' : ''}`}
        aria-current={isNeedsAction ? 'page' : undefined}
        onClick={() => setHash(NEEDS_ACTION_HASH)}
      >
        <Icon name="inbox" size={22} /> Needs Action
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
