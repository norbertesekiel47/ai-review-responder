import type { IconName } from '@/components/dashboard/shell/Icon';

// Single source of truth for the authenticated owner navigation. Both the
// desktop Sidebar and the mobile MobileTabBar render from this config and
// compute their active state through resolveActiveNavId, so the two navs can
// never disagree on which destination is current (the prior bug: each nav
// defined its own bespoke isDashboard/isPastReplies/isSettings logic).

export type NavId = 'dashboard' | 'insights' | 'past-replies' | 'settings';

export interface NavItem {
  id: NavId;
  label: string;
  href: string;
  icon: IconName;
  /**
   * When true, the item is gated behind a server flag (PAST_REPLIES_VIEW_ENABLED).
   * A flag-off item must be ABSENT from both navs, never present-but-dead — the
   * rendering nav filters it out using the server-authoritative boolean.
   */
  flagged?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'home' },
  { id: 'insights', label: 'Insights', href: '/dashboard/insights', icon: 'insights' },
  {
    id: 'past-replies',
    label: 'Past Replies',
    href: '/dashboard/past-replies',
    icon: 'history',
    flagged: true,
  },
  { id: 'settings', label: 'Settings', href: '/settings', icon: 'cog' },
];

/**
 * Maps any authenticated pathname to the nav item that should appear active.
 *
 * Rules (from IMPLEMENTATION-PROMPT §1, the routing/nav contract):
 *  - /dashboard/insights*       → insights  (MUST be distinct from dashboard)
 *  - /dashboard/past-replies*   → past-replies
 *  - /dashboard/add-location*   → settings  (wizard entered from Settings → Locations)
 *  - /dashboard/connect*        → dashboard (wizard entered from the dashboard banner)
 *  - /dashboard and any other /dashboard/* → dashboard
 *  - /settings*                 → settings  (catches every settings sub-page)
 *  - anything else (e.g. /account/offboarding/status, which renders without a
 *    nav shell) → null, i.e. nothing highlighted.
 *
 * Returns null rather than a NavId for routes that intentionally have no active
 * primary item; callers that always want a highlight (the wizards above) are
 * already covered by the explicit branches.
 */
export function resolveActiveNavId(pathname: string): NavId | null {
  // Normalize a trailing slash so '/settings/' matches '/settings'.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  if (path === '/dashboard/insights' || path.startsWith('/dashboard/insights/')) {
    return 'insights';
  }
  if (path === '/dashboard/past-replies' || path.startsWith('/dashboard/past-replies/')) {
    return 'past-replies';
  }
  if (path === '/dashboard/add-location' || path.startsWith('/dashboard/add-location/')) {
    return 'settings';
  }
  if (path === '/settings' || path.startsWith('/settings/')) {
    return 'settings';
  }
  if (path === '/dashboard' || path.startsWith('/dashboard/')) {
    // Covers /dashboard, /dashboard/connect, /dashboard/connect/select-location,
    // and any future /dashboard/* page not claimed by a branch above.
    return 'dashboard';
  }
  return null;
}
