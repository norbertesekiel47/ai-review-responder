'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import { mfaChallengePath } from '@/lib/auth/mfa';
import type { AdminShellIdentity } from '@/lib/admin/shell-context';
import { ADMIN_NAV_GROUPS, type AdminNavItem } from './nav-config';
import { navCountsQueryOptions, type NavCounts } from './nav-counts-query';

// The admin console is DESKTOP-FIRST. Operators work it from a laptop against
// logs and dashboards; the phone layout below (top bar + full-screen drawer)
// exists so a page can be READ on call, not so the console can be operated
// from a phone. Data tables scroll inside their own container, forms keep
// their desktop measure, and no phone-specific affordance beyond this drawer
// is owed. Treat a phone-only admin bug as a phone-only bug.

function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || Boolean(pathname?.startsWith(`${href}/`));
}

function NavLink({ item, pathname, counts, onNavigate }: {
  item: AdminNavItem;
  pathname: string | null;
  counts: NavCounts | undefined;
  onNavigate?: () => void;
}) {
  const active = isActive(pathname, item.href);
  const count = item.badge && counts ? counts[item.badge] : 0;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors ${
        active ? 'bg-gray-700 font-medium text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
      }`}
    >
      {item.label}
      {count > 0 && (
        <span className="rounded-full bg-red-400 px-1.5 text-xs font-semibold text-gray-900">{count}</span>
      )}
    </Link>
  );
}

function NavGroups({ pathname, counts, onNavigate }: {
  pathname: string | null;
  counts: NavCounts | undefined;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-4">
      {ADMIN_NAV_GROUPS.map((group) => (
        <div key={group.label}>
          {/* 11px / gray-400: the smallest legible step on gray-900 (X31). */}
          <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-widest text-gray-400">
            {group.label}
          </div>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} counts={counts} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/**
 * Who is signed in, whether the session is stepped up, and the way out (X7).
 * The only sign-out under /admin — the same Supabase browser sign-out the owner
 * `AccountMenu` uses, landing on the ADMIN login (an admin sent to `/login`
 * dead-ends: that form is owner-only).
 */
function SidebarFooter({ identity, pathname }: { identity: AdminShellIdentity | null; pathname: string | null }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!identity) return null;

  async function signOut() {
    setError(null);
    setSigningOut(true);
    try {
      const { error: signOutError } = await createBrowserSupabaseClient().auth.signOut();
      if (signOutError) throw signOutError;
      router.push('/admin/login');
      router.refresh();
    } catch {
      setSigningOut(false);
      setError('Sign out failed. You are still signed in.');
    }
  }

  return (
    <div className="border-t border-gray-800 px-4 py-3 text-xs">
      <p className="truncate font-medium text-gray-200" title={identity.email ?? undefined}>
        {identity.email ?? 'Signed in'}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-gray-400">
        <span
          aria-hidden="true"
          className={`inline-block size-1.5 rounded-full ${identity.aal2 ? 'bg-green-400' : 'bg-gray-500'}`}
        />
        {identity.aal2 ? (
          'Step-up verified (AAL2)'
        ) : (
          <>
            Step-up not verified ·{' '}
            <Link href={mfaChallengePath(pathname ?? '/admin')} className="text-gray-200 underline hover:text-white">
              Verify
            </Link>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={() => { void signOut(); }}
        disabled={signingOut}
        className="mt-2 rounded-md border border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-200 hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function AdminSidebar({ identity = null, adminAppUrl }: { identity?: AdminShellIdentity | null; adminAppUrl: string }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  const wasMobileOpenRef = useRef(false);

  const { data: counts } = useQuery(navCountsQueryOptions);

  // Move focus into the drawer on open, and back to the hamburger on close —
  // never on initial mount, when the drawer was never open to begin with.
  useEffect(() => {
    if (mobileOpen) {
      mobilePanelRef.current?.focus();
      wasMobileOpenRef.current = true;
    } else if (wasMobileOpenRef.current) {
      mobileTriggerRef.current?.focus();
      wasMobileOpenRef.current = false;
    }
  }, [mobileOpen]);

  // Escape closes the drawer; body scroll is locked while it's open (restored
  // on close or unmount).
  useEffect(() => {
    if (!mobileOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileOpen(false);
    }

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col bg-gray-900 md:flex">
        <a href={adminAppUrl} className="block px-4 py-4 text-base font-bold text-white">
          RepWorth <span className="align-top text-[10px] font-semibold text-red-400">ADMIN</span>
        </a>
        <NavGroups pathname={pathname} counts={counts} />
        <SidebarFooter identity={identity} pathname={pathname} />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-12 items-center justify-between bg-gray-900 px-3 md:hidden">
        <a href={adminAppUrl} className="text-sm font-bold text-white">
          RepWorth <span className="align-top text-[10px] font-semibold text-red-400">ADMIN</span>
        </a>
        <button
          ref={mobileTriggerRef}
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
          aria-controls="admin-mobile-nav"
          className="rounded-md p-2 text-gray-300 hover:bg-gray-800"
        >
          <svg className="size-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
            {mobileOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            )}
          </svg>
        </button>
      </div>
      {mobileOpen && (
        // A full-screen drawer that traps focus and locks scroll IS a modal
        // dialog; say so, or a screen reader announces a bare focused div (X33).
        <div
          id="admin-mobile-nav"
          ref={mobilePanelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Admin navigation"
          tabIndex={-1}
          className="fixed inset-0 top-12 z-40 flex flex-col bg-gray-900 pt-2 outline-none md:hidden"
        >
          <NavGroups pathname={pathname} counts={counts} onNavigate={() => setMobileOpen(false)} />
          <SidebarFooter identity={identity} pathname={pathname} />
        </div>
      )}
      {/* No in-flow mobile spacer here: this component is a flex-row sibling of
          <main>, so a spacer div would sit beside it, not above page content.
          The layout's <main> carries `pt-12 md:pt-0` instead, to clear the
          fixed top bar. */}
    </>
  );
}
