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
  children,
}: {
  href: string;
  section: NavSection;
  activeNav: NavSection | null;
  children: ReactNode;
}) {
  const active = activeNav === section;
  return (
    <Link
      href={href}
      className={`nav-item ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </Link>
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
        <NavItem href="/dashboard/reviews" section="reviews" activeNav={activeNav}>
          <Icon name="inbox" /> Reviews
          {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
        </NavItem>
        {activeNav === 'reviews' && (
          <div className="nav-children">
            <NavChild href="/dashboard/reviews" label="Needs Action" />
            {/* Same name as the tab it opens (UX audit D16) — never "Past replies",
                which names the pre-#671 surface (CONTEXT.md → Reviews list). */}
            <NavChild href="/dashboard/reviews/history" label="All Reviews" />
          </div>
        )}
        {solicitationEnabled && (
          <NavItem href="/dashboard/requests" section="requests" activeNav={activeNav}>
            <Icon name="trend" /> Requests
          </NavItem>
        )}
        {/* Children hang from the flag-gated parent, never beside it: a Review
            QR row under a hidden Requests row would be a route with no visible
            way back. */}
        {solicitationEnabled && activeNav === 'requests' && (
          <div className="nav-children">
            {/* No self-child here, deliberately. Reviews and Analytics each get
                one because their first screen has its own name — "Needs Action",
                "Metrics". The Requests screen is titled "Requests"
                (`RequestsClient.tsx:209`), so a child by that name would
                duplicate the parent row it hangs from and give a screen reader
                two identical links to the same href. The parent row IS that
                route. */}
            <NavChild href="/dashboard/requests/contacts" label="Contacts" />
            {/* Moved out of Settings by #1092. The QR redirect
                `GET /q/<businessId>` does NOT move — printed codes point at it. */}
            <NavChild href="/dashboard/requests/qr" label="Review QR" />
          </div>
        )}
        <NavItem href="/dashboard/analytics" section="analytics" activeNav={activeNav}>
          <Icon name="chart" /> Analytics
        </NavItem>
        {activeNav === 'analytics' && (
          <div className="nav-children">
            <NavChild href="/dashboard/analytics" label="Metrics" />
            <NavChild href="/dashboard/analytics/restraint" label="Restraint" />
          </div>
        )}
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
