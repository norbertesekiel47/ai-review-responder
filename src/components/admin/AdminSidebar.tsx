'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ADMIN_AUTH_ROUTES, ADMIN_NAV_GROUPS, type AdminNavItem } from './nav-config';

interface NavCounts {
  flaggedOpen: number;
  failedJobs: number;
}

async function fetchNavCounts(): Promise<NavCounts> {
  const response = await fetch('/api/admin/nav-counts');
  if (!response.ok) throw new Error(`nav-counts failed (${response.status})`);
  return response.json();
}

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
          <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-widest text-gray-500">
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

export function AdminSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  const wasMobileOpenRef = useRef(false);

  const { data: counts } = useQuery({
    queryKey: ['admin', 'nav-counts'],
    queryFn: fetchNavCounts,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

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

  if (pathname !== null && ADMIN_AUTH_ROUTES.includes(pathname)) {
    return null;
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col bg-gray-900 md:flex">
        <Link href="/admin/overview" className="block px-4 py-4 text-base font-bold text-white">
          RepWorth <span className="align-top text-[10px] font-semibold text-red-400">ADMIN</span>
        </Link>
        <NavGroups pathname={pathname} counts={counts} />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-12 items-center justify-between bg-gray-900 px-3 md:hidden">
        <Link href="/admin/overview" className="text-sm font-bold text-white">
          RepWorth <span className="align-top text-[10px] font-semibold text-red-400">ADMIN</span>
        </Link>
        <button
          ref={mobileTriggerRef}
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
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
        <div
          ref={mobilePanelRef}
          tabIndex={-1}
          className="fixed inset-0 top-12 z-40 flex flex-col bg-gray-900 pt-2 outline-none md:hidden"
        >
          <NavGroups pathname={pathname} counts={counts} onNavigate={() => setMobileOpen(false)} />
        </div>
      )}
      {/* Spacer so page content clears the fixed mobile top bar */}
      <div className="h-12 md:hidden" />
    </>
  );
}
