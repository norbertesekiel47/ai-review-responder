'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { Icon } from '@/components/dashboard/shell/Icon';
import { NAV_ITEMS, resolveActiveNavId } from '@/components/dashboard/shell/nav-items';
import { LocationPicker } from '@/components/dashboard/location/LocationPicker';
import { useLocationScope } from '@/contexts/LocationContext';

interface Props {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  /** Server-authoritative — read at layout level. */
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
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
  pastRepliesEnabled,
  editRepliesEnabled = false,
}: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  const { isMultiLocation } = useLocationScope();

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

  // Single active-state source shared with MobileTabBar (see nav-items.ts).
  const activeId = resolveActiveNavId(pathname);
  // Flag-off items are absent, not present-but-dead.
  const visibleItems = NAV_ITEMS.filter((item) => !item.flagged || pastRepliesEnabled);
  const primaryItems = visibleItems.filter((item) => item.id !== 'settings');
  const settingsItem = visibleItems.find((item) => item.id === 'settings');

  const initials = deriveInitials(ownerName, ownerEmail);
  const displayOwner = ownerName.trim() || (ownerEmail.split('@')[0] ?? '');

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="brand-name">RepWorth</div>
          {isMultiLocation ? (
            <LocationPicker singleLocationLabel={businessName} />
          ) : (
            <div className="brand-biz">{businessName}</div>
          )}
        </div>
      </div>

      <nav aria-label="Primary">
        <div className="nav-section">
          {primaryItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={`nav-item ${activeId === item.id ? 'active' : ''}`}
              aria-current={activeId === item.id ? 'page' : undefined}
            >
              <Icon name={item.icon} /> {item.label}
            </Link>
          ))}
        </div>

        <div className="nav-divider" />

        <div className="nav-section">
          {settingsItem && (
            <Link
              href={settingsItem.href}
              className={`nav-item ${activeId === settingsItem.id ? 'active' : ''}`}
              aria-current={activeId === settingsItem.id ? 'page' : undefined}
            >
              <Icon name={settingsItem.icon} /> {settingsItem.label}
            </Link>
          )}
        </div>
      </nav>

      <div className="sidebar-spacer" />

      <div className="user-chip">
        <div className="avatar">{initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="user-name">{displayOwner}</div>
          <div className="user-email">{ownerEmail}</div>
        </div>
      </div>

      {signOutError && (
        <p style={{ fontSize: 12, color: 'var(--rw-red-600)', marginTop: 4 }}>Sign out failed</p>
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
