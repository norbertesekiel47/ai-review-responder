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
 * rather than a stored toggle: there is one child today, and a disclosure state
 * machine for one row would be state nobody reads back.
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
            <NavChild href="/dashboard/reviews" label="Needs action" />
            <NavChild href="/dashboard/reviews/history" label="Past replies" />
          </div>
        )}
        {solicitationEnabled && (
          <NavItem href="/dashboard/requests" section="requests" activeNav={activeNav}>
            <Icon name="trend" /> Requests
          </NavItem>
        )}
        <NavItem href="/dashboard/analytics" section="analytics" activeNav={activeNav}>
          <Icon name="chart" /> Analytics
        </NavItem>
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
