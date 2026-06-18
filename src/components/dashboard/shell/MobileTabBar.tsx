'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { NAV_ITEMS, resolveActiveNavId, type NavId } from '@/components/dashboard/shell/nav-items';
import { usePendingCount } from '@/contexts/PendingCountContext';

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

/** Look up a NAV_ITEMS entry's href/icon by id (active state comes from resolveActiveNavId). */
function navHref(id: NavId): string {
  return NAV_ITEMS.find((item) => item.id === id)!.href;
}
function navIcon(id: NavId): IconName {
  return NAV_ITEMS.find((item) => item.id === id)!.icon;
}

// Mobile primary tabs are a curated subset of NAV_ITEMS + one action tab, kept
// to four for thumb reach (IMPLEMENTATION-PROMPT §2.3):
//   Home · Needs Action (badge) · Insights · Settings
// "Past Replies" is deliberately NOT a mobile tab — it stays a desktop-primary
// destination, reachable on mobile via the dashboard's "view all replies" link.
// Active state is computed by the SAME resolveActiveNavId as the desktop
// Sidebar, so the two navs can never disagree. Because past-replies has no
// mobile tab, when the owner is on /dashboard/past-replies the nearest primary
// ancestor — Home — stays lit (the home cluster), so a tab is never blank.
export function MobileTabBar() {
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

  const navId = resolveActiveNavId(pathname);
  // The Home cluster owns /dashboard + its wizards AND /dashboard/past-replies
  // (which has no mobile tab of its own).
  const inHomeCluster = navId === 'dashboard' || navId === 'past-replies';
  // The hash split only applies to the bare landing page.
  const onDashboardLanding = pathname === '/dashboard';
  const isNeedsAction = onDashboardLanding && hash === NEEDS_ACTION_HASH;
  const isHome = inHomeCluster && !isNeedsAction;
  const isInsights = navId === 'insights';
  const isSettings = navId === 'settings';

  return (
    <nav className="mobile-tabbar" aria-label="Dashboard">
      <Link
        href={navHref('dashboard')}
        className={`mtab ${isHome ? 'active' : ''}`}
        aria-current={isHome ? 'page' : undefined}
        onClick={() => setHash('')}
      >
        <Icon name={navIcon('dashboard')} size={22} /> Home
      </Link>
      <Link
        href={`${navHref('dashboard')}${NEEDS_ACTION_HASH}`}
        className={`mtab ${isNeedsAction ? 'active' : ''}`}
        aria-current={isNeedsAction ? 'page' : undefined}
        onClick={() => setHash(NEEDS_ACTION_HASH)}
      >
        <Icon name="inbox" size={22} /> Needs Action
        {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
      </Link>
      <Link
        href={navHref('insights')}
        className={`mtab ${isInsights ? 'active' : ''}`}
        aria-current={isInsights ? 'page' : undefined}
      >
        <Icon name={navIcon('insights')} size={22} /> Insights
      </Link>
      <Link
        href={navHref('settings')}
        className={`mtab ${isSettings ? 'active' : ''}`}
        aria-current={isSettings ? 'page' : undefined}
      >
        <Icon name={navIcon('settings')} size={22} /> Settings
      </Link>
    </nav>
  );
}
