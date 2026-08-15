'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { Icon } from '@/components/dashboard/shell/Icon';
import { deriveNavSection, type NavSection } from '@/components/dashboard/shell/active-nav';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { LocationPicker } from '@/components/dashboard/location/LocationPicker';
import { useLocationScope } from '@/contexts/LocationContext';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  /** Server-authoritative SOLICITATION_WATCH_ENABLED, passed down from
   *  (authenticated)/layout.tsx. Invariant #13: the browser learns flag state
   *  only through this prop — there is no NEXT_PUBLIC companion. */
  solicitationEnabled: boolean;
}

function deriveInitials(name: string, email: string): string {
  if (name.trim()) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  return (email[0] ?? '?').toUpperCase();
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

export function Sidebar({
  businessName,
  ownerName,
  ownerEmail,
  solicitationEnabled,
}: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  const { isMultiLocation } = useLocationScope();
  const pendingCount = usePendingCount();

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.signOut();
      if (error) {
        setSignOutError(true);
        setSigningOut(false);
        return;
      }
      // The OWNER login page. Sending an owner to /admin/login dead-ends them:
      // that form is allowedRoles={['admin']}, so re-entering their own
      // credentials signs them straight back out with "That account is for the
      // owner portal." The guards in require-owner-access.ts and the
      // authenticated layout deliberately still target /admin/login — those are
      // pinned by require-owner-access.test.ts and are not this path.
      router.push('/login');
      router.refresh();
    } catch {
      setSignOutError(true);
      setSigningOut(false);
    }
  }

  const activeNav = deriveNavSection(pathname);

  const initials = deriveInitials(ownerName, ownerEmail);
  const displayOwner = ownerName.trim() || (ownerEmail.split('@')[0] ?? '');

  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandLogo size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="brand-name">RepWorth</div>
          {isMultiLocation ? (
            <LocationPicker singleLocationLabel={businessName} />
          ) : (
            <div className="brand-biz">{businessName}</div>
          )}
        </div>
      </div>

      <div className="nav-section">
        <NavItem href="/dashboard" section="dashboard" activeNav={activeNav}>
          <Icon name="home" /> Dashboard
        </NavItem>
        <NavItem href="/dashboard/reviews" section="reviews" activeNav={activeNav}>
          <Icon name="inbox" /> Reviews
          {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
        </NavItem>
        {solicitationEnabled && (
          <NavItem href="/dashboard/requests" section="requests" activeNav={activeNav}>
            <Icon name="trend" /> Requests
          </NavItem>
        )}
        <NavItem href="/dashboard/analytics" section="analytics" activeNav={activeNav}>
          <Icon name="chart" /> Analytics
        </NavItem>
      </div>

      <div className="nav-divider" />

      <div className="nav-section">
        <NavItem href="/settings" section="settings" activeNav={activeNav}>
          <Icon name="cog" /> Settings
        </NavItem>
      </div>

      <div className="sidebar-spacer" />

      <div className="user-chip">
        <div className="avatar">{initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="user-name">{displayOwner}</div>
          <div className="user-email">{ownerEmail}</div>
        </div>
      </div>

      {signOutError && (
        <p style={{ fontSize: 12, color: 'var(--rw-danger)', marginTop: 4 }}>Sign out failed</p>
      )}
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="signout-btn"
      >
        <Icon name="logout" /> {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
    </aside>
  );
}
