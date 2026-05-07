'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { Icon } from './Icon';

interface Props {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  /** Server-authoritative — read at layout level. */
  pastRepliesEnabled: boolean;
}

function deriveInitials(name: string, email: string): string {
  if (name.trim()) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  return (email[0] ?? '?').toUpperCase();
}

export function Sidebar({ businessName, ownerName, ownerEmail, pastRepliesEnabled }: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

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

  const isDashboard =
    pathname === '/dashboard' ||
    (pathname.startsWith('/dashboard/') && !pathname.startsWith('/dashboard/past-replies'));
  const isPastReplies = pathname.startsWith('/dashboard/past-replies');
  const isSettings = pathname.startsWith('/settings');

  const initials = deriveInitials(ownerName, ownerEmail);
  const displayOwner = ownerName.trim() || (ownerEmail.split('@')[0] ?? '');

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="brand-name">RepWorth</div>
          <div className="brand-biz">{businessName}</div>
        </div>
      </div>

      <div className="nav-section">
        <Link href="/dashboard" className={`nav-item ${isDashboard ? 'active' : ''}`}>
          <Icon name="home" /> Dashboard
        </Link>
        {pastRepliesEnabled && (
          <Link href="/dashboard/past-replies" className={`nav-item ${isPastReplies ? 'active' : ''}`}>
            <Icon name="history" /> Past Replies
          </Link>
        )}
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
        <p style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>Sign out failed</p>
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
