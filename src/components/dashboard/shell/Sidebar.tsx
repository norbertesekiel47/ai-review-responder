'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { AccountMenu } from '@/components/dashboard/shell/AccountMenu';
import { deriveNavSection, type NavSection } from '@/components/dashboard/shell/active-nav';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { LocationPicker } from '@/components/dashboard/location/LocationPicker';
import { useLocationScope } from '@/contexts/LocationContext';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  businessName: string;
  /** Server-authoritative SOLICITATION_WATCH_ENABLED, passed down from
   *  (authenticated)/layout.tsx. Invariant #13: the browser learns flag state
   *  only through this prop — there is no NEXT_PUBLIC companion. */
  solicitationEnabled: boolean;
}

/** One nav row. Pairing className and aria-current here keeps the visual
 *  active state and the assistive-tech current-page state from drifting. */
function NavItem({
  href,
  section,
  activeNav,
  hasCurrentChild = false,
  children,
}: {
  href: string;
  section: NavSection;
  activeNav: NavSection | null;
  /** True when a rendered child of this section IS the current page. */
  hasCurrentChild?: boolean;
  children: ReactNode;
}) {
  const active = activeNav === section;
  return (
    <Link
      href={href}
      className={`nav-item ${active ? 'active' : ''}`}
      /* `.active` marks the open SECTION; `aria-current="page"` marks the one
         current PAGE. They are different facts and only look the same on a flat
         rail. Reviews' first child and Analytics' first child share their
         parent's href, so without this both rows announced themselves as the
         current page — two `aria-current` values in one nav. The child is the
         more specific claim, so the parent yields. */
      aria-current={active && !hasCurrentChild ? 'page' : undefined}
    >
      {children}
    </Link>
  );
}

/**
 * The children of each expandable section, as DATA.
 *
 * One table rather than three near-identical JSX blocks, for a reason beyond
 * tidiness: `hasCurrentChild` above has to know these hrefs, and a second
 * hand-written copy of them is exactly how the parent and child disagree about
 * which row is current. `SettingsSidebar` is the in-repo precedent for the
 * shape.
 *
 * A section appears here only if it HAS children. Requests deliberately has no
 * self-child: its screen is titled "Requests" like the section
 * (`RequestsClient.tsx:209`), so a child of that name would give a screen
 * reader two identical links to one href. Reviews and Analytics keep theirs
 * because their first screen has its own name.
 */
const NAV_CHILDREN: Partial<
  Record<NavSection, ReadonlyArray<{ href: string; label: string }>>
> = {
  reviews: [
    { href: '/dashboard/reviews', label: 'Needs Action' },
    // Same name as the tab it opens (UX audit D16) — never "Past replies",
    // which names the pre-#671 surface (CONTEXT.md → Reviews list).
    { href: '/dashboard/reviews/history', label: 'All Reviews' },
  ],
  requests: [
    { href: '/dashboard/requests/contacts', label: 'Contacts' },
    // Moved out of Settings by #1092. The QR redirect `GET /q/<businessId>`
    // does NOT move — printed codes point at it.
    { href: '/dashboard/requests/qr', label: 'Review QR' },
  ],
  analytics: [
    { href: '/dashboard/analytics', label: 'Metrics' },
    { href: '/dashboard/analytics/restraint', label: 'Restraint' },
  ],
};

/** The open section's children, or nothing. */
function NavChildren({ section }: { section: NavSection }) {
  const children = NAV_CHILDREN[section];
  if (!children) return null;
  return (
    <div className="nav-children">
      {children.map((child) => (
        <NavChild key={child.href} href={child.href} label={child.label} />
      ))}
    </div>
  );
}

/**
 * A child route that appears only while its parent section is open. A flat rail
 * stops working as the route count grows, and `/dashboard/reviews/history` was
 * reachable from nowhere in either nav. Expansion follows the active section
 * rather than a stored toggle: a disclosure state machine here would be state
 * nobody reads back, and following the active section also defines away the
 * invalid state where two child groups are open at once.
 *
 * As of #1092 the children are the ONLY sub-navigation on desktop — the routed
 * pill bars are scoped to mobile, where `.sidebar` is hidden (#1089).
 */
function NavChild({ href, label }: { href: string; label: string }) {
  const pathname = usePathname() ?? '';
  const active = pathname === href;
  return (
    <Link
      href={href}
      className={`nav-child ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      {label}
    </Link>
  );
}

export function Sidebar({ businessName, solicitationEnabled }: Props) {
  const pathname = usePathname() ?? '';
  const { isMultiLocation } = useLocationScope();
  const pendingCount = usePendingCount();

  const activeNav = deriveNavSection(pathname);

  /** Does a RENDERED child of this section own the current page? Only then does
   *  the parent yield its `aria-current` (see NavItem). */
  const hasCurrentChild = (section: NavSection): boolean =>
    activeNav === section &&
    (NAV_CHILDREN[section] ?? []).some((child) => child.href === pathname);

  return (
    <aside className="sidebar">
      {/* Identity first (Source A: a logo wastes the most convenient spot).
          Two rows, because the Console has two identities the owner switches
          between — the account, and the location the numbers describe. */}
      <div className="sidebar-identity">
        <AccountMenu />
        <div className="sidebar-scope">
          <Icon name="location" size={13} />
          {isMultiLocation ? (
            <LocationPicker singleLocationLabel={businessName} />
          ) : (
            <span className="brand-biz">{businessName}</span>
          )}
        </div>
      </div>

      <nav className="nav-section" aria-label="Main">
        <NavItem href="/dashboard" section="dashboard" activeNav={activeNav}>
          <Icon name="home" /> Dashboard
        </NavItem>
        <NavItem
          href="/dashboard/reviews"
          section="reviews"
          activeNav={activeNav}
          hasCurrentChild={hasCurrentChild('reviews')}
        >
          <Icon name="inbox" /> Reviews
          {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
        </NavItem>
        {activeNav === 'reviews' && <NavChildren section="reviews" />}
        {solicitationEnabled && (
          <>
            <NavItem
              href="/dashboard/requests"
              section="requests"
              activeNav={activeNav}
              hasCurrentChild={hasCurrentChild('requests')}
            >
              <Icon name="trend" /> Requests
            </NavItem>
            {/* Children hang from the flag-gated parent, never beside it: a
                Review QR row under a hidden Requests row would be a route with
                no visible way back. */}
            {activeNav === 'requests' && <NavChildren section="requests" />}
          </>
        )}
        {/* **Review QR** is visible to EVERY owner (CONTEXT.md), but Requests
            is gated on watch-mode, which is OFF in production. Nested under a
            hidden parent it had no entry point at all — the Settings row this
            change removed was its only one. So when the section that would
            host it is absent, it stands on its own. Owner decision 2026-09-03. */}
        {!solicitationEnabled && (
          <NavItem href="/dashboard/requests/qr" section="requests" activeNav={activeNav}>
            <Icon name="qr" /> Review QR
          </NavItem>
        )}
        <NavItem
          href="/dashboard/analytics"
          section="analytics"
          activeNav={activeNav}
          hasCurrentChild={hasCurrentChild('analytics')}
        >
          <Icon name="chart" /> Analytics
        </NavItem>
        {activeNav === 'analytics' && <NavChildren section="analytics" />}
      </nav>

      <div className="sidebar-spacer" />

      {/* Rare destinations dock at the base, separated from the main group. */}
      <nav className="nav-section nav-section--utility" aria-label="Utility">
        <NavItem href="/settings" section="settings" activeNav={activeNav}>
          <Icon name="cog" /> Settings
        </NavItem>
        <Link href="/help/contact" className="nav-item">
          <Icon name="help" /> Help
        </Link>
      </nav>

      {/* The wordmark keeps a quiet presence at the foot of the rail rather
          than occupying the prime slot the account control now holds. */}
      <div className="sidebar-brand">
        <BrandLogo size={18} />
        <span>RepWorth</span>
      </div>
    </aside>
  );
}
