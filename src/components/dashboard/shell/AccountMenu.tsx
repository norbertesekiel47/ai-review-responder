'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import { useMenuPopover } from '@/components/dashboard/shell/useMenuPopover';
import {
  deriveDisplayName,
  deriveInitials,
  useOwnerIdentity,
} from '@/contexts/OwnerIdentityContext';
import { useToast } from '@/components/dashboard/shell/toast/ToastProvider';

/** The account destinations, in the order an owner reaches for them. */
const ITEMS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/settings/profile', label: 'Profile', icon: 'user' },
  { href: '/settings/billing', label: 'Plan and billing', icon: 'card' },
  { href: '/settings/security', label: 'Security', icon: 'shield' },
];

/**
 * The account control at the top of the sidebar — the spot a logo used to
 * waste. It carries identity (avatar, name), signals that it opens
 * (`chevron-updown`), and owns the account destinations plus sign-out, which
 * previously sat as two separate elements at the base of the rail.
 *
 * `compact` renders the trigger for the mobile top bar, where the sidebar is
 * hidden: same menu, avatar only, no name column. Without it sign-out is
 * unreachable below the 768px breakpoint.
 */
export function AccountMenu({ compact }: { compact?: boolean }) {
  const identity = useOwnerIdentity();
  const router = useRouter();
  const { toast } = useToast();
  const [signingOut, setSigningOut] = useState(false);
  // Destructured in one read: the react-hooks/refs rule treats any member
  // access on a ref-carrying object as a render-time ref read.
  const {
    open,
    containerRef,
    triggerRef,
    menuRef,
    triggerId,
    menuId,
    close,
    closeAndRestoreFocus,
    toggle,
    onTriggerKeyDown,
    onMenuKeyDown,
  } = useMenuPopover<HTMLButtonElement>('account-menu');

  const initials = deriveInitials(identity);
  const displayName = deriveDisplayName(identity);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      // The OWNER login page. Sending an owner to /admin/login dead-ends them:
      // that form is allowedRoles={['admin']}, so re-entering their own
      // credentials signs them straight back out with "That account is for the
      // owner portal."
      router.push('/login');
      router.refresh();
    } catch {
      setSigningOut(false);
      closeAndRestoreFocus();
      toast({
        tone: 'error',
        title: 'Sign out failed',
        body: 'You are still signed in. Check your connection and try again.',
      });
    }
  }, [closeAndRestoreFocus, router, toast]);

  return (
    <div
      ref={containerRef}
      className={`acct ${compact ? 'acct--compact' : ''}`}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="acct-trigger"
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-label={compact ? `Account: ${displayName}` : undefined}
      >
        <span className="avatar" aria-hidden="true">{initials}</span>
        {!compact && (
          <>
            <span className="acct-id">
              <span className="acct-name">{displayName}</span>
              <span className="acct-role">Owner</span>
            </span>
            <span className="acct-chevron">
              <Icon name="chevron-updown" size={14} />
            </span>
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="acct-menu"
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
        >
          <div className="acct-menu-head">
            <span className="acct-menu-name">{displayName}</span>
            <span className="acct-menu-email">{identity.email}</span>
          </div>
          <div className="acct-menu-divider" />
          {ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              className="acct-menu-item"
              onClick={close}
            >
              <Icon name={item.icon} size={15} />
              <span>{item.label}</span>
            </Link>
          ))}
          <div className="acct-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="acct-menu-item acct-menu-item--signout"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            <Icon name="logout" size={15} />
            <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
