'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { Icon } from '@/components/dashboard/shell/Icon';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { LocationPicker } from '@/components/dashboard/location/LocationPicker';
import { useLocationScope } from '@/contexts/LocationContext';
import { usePendingCount } from '@/contexts/PendingCountContext';

interface Props {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
}

function deriveInitials(name: string, email: string): string {
  if (name.trim()) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  return (email[0] ?? '?').toUpperCase();
}

export function Sidebar({
  businessName,
  ownerName,
  ownerEmail,
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
      router.push('/admin/login');
      router.refresh();
    } catch {
      setSignOutError(true);
      setSigningOut(false);
    }
  }

  // /dashboard/reviews and /dashboard/reviews/history both highlight Reviews;
  // /dashboard/analytics highlights Analytics; everything else under /dashboard
  // highlights Dashboard.
  const isReviews = pathname.startsWith('/dashboard/reviews');
  const isAnalytics = pathname.startsWith('/dashboard/analytics');
  const isDashboard =
    pathname === '/dashboard' ||
    (pathname.startsWith('/dashboard/') && !isReviews && !isAnalytics);
  const isSettings = pathname.startsWith('/settings');

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
        <Link href="/dashboard" className={`nav-item ${isDashboard ? 'active' : ''}`}>
          <Icon name="home" /> Dashboard
        </Link>
        <Link href="/dashboard/reviews" className={`nav-item ${isReviews ? 'active' : ''}`}>
          <Icon name="inbox" /> Reviews
          {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
        </Link>
        <Link href="/dashboard/analytics" className={`nav-item ${isAnalytics ? 'active' : ''}`}>
          <Icon name="chart" /> Analytics
        </Link>
      </div>

      <div className="nav-divider" />

      <div className="nav-section">
        <Link href="/settings" className={`nav-item ${isSettings ? 'active' : ''}`}>
          <Icon name="cog" /> Settings
        </Link>
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
        <p style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>Sign out failed</p>
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
