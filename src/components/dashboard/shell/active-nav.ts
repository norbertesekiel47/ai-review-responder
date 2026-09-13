/**
 * Single owner of the nav-highlight rule: which nav section a pathname belongs
 * to. Sidebar (desktop) and MobileTabBar (mobile) both read this, so the two
 * navs cannot drift apart — before this existed each carried its own copy of
 * the same `startsWith` chain.
 *
 * Returning ONE section instead of a set of independent booleans also defines
 * away the invalid state where two rows highlight at once.
 *
 * Nested routes fold into their section: `/dashboard/reviews/history` →
 * `reviews`, `/dashboard/requests/contacts` → `requests`. Anything else under
 * `/dashboard` falls back to `dashboard`.
 */
export type NavSection = 'dashboard' | 'reviews' | 'requests' | 'analytics' | 'operator' | 'settings';

/**
 * Which settings tab the bare `/settings` route means. Single owner of that
 * fact: `settings/page.tsx` redirects here and `SettingsSidebar` highlights
 * this row for a bare `/settings` pathname, so the redirect target and the
 * highlighted row cannot point at different tabs. Lives beside
 * `deriveNavSection` because it is the same kind of fact — a nav-path rule two
 * unrelated modules must agree on — and because this module is deliberately
 * free of `'use client'`, so the server page can import it.
 */
export const SETTINGS_DEFAULT_HREF = '/settings/voice';

/** Order matters: the specific sections are tested before the `/dashboard` catch-all. */
export function deriveNavSection(pathname: string): NavSection | null {
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/dashboard/reviews')) return 'reviews';
  if (pathname.startsWith('/dashboard/requests')) return 'requests';
  if (pathname.startsWith('/dashboard/analytics')) return 'analytics';
  // ORDER-SENSITIVE: this arm MUST sit ABOVE the `/dashboard` catch-all on the
  // next line. Below it, `/dashboard/operator` folds into `dashboard` and the
  // Operator row never highlights — the same trap this module's header comment
  // names for reviews, requests and analytics.
  if (pathname.startsWith('/dashboard/operator')) return 'operator';
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) return 'dashboard';
  return null;
}
