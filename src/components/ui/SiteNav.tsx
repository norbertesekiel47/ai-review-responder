'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, m, domAnimation } from 'motion/react';
import { NAV_LINKS } from './marketing-links';

interface SiteNavProps {
  /** When true, the right-side Log in / Sign up cluster is hidden. */
  comingSoon?: boolean;
  /** Controls whether owner self-serve auth links are exposed. */
  selfServeEnabled?: boolean;
}

const MOBILE_MENU_ID = 'site-nav-mobile-menu';

/** True when `pathname` is the link target or one of its descendants. */
function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteNav({ comingSoon = false, selfServeEnabled = false }: SiteNavProps) {
  const showOwnerAuth = selfServeEnabled && !comingSoon;
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);

  const closeMenu = () => {
    setMobileOpen(false);
    // Restore focus to the toggle so keyboard users keep their place.
    toggleRef.current?.focus();
  };

  // Escape closes the menu and restores focus. This is a disclosure, NOT a
  // focus trap: Tab is left to flow naturally through the page; we only manage
  // open/close focus.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // closeMenu only touches refs + the state setter (both stable); gating on
    // mobileOpen is enough to re-bind the listener correctly.
  }, [mobileOpen]);

  // Move focus to the first link when the menu opens.
  useEffect(() => {
    if (mobileOpen) firstMobileLinkRef.current?.focus();
  }, [mobileOpen]);

  return (
    <LazyMotion features={domAnimation}>
      <header aria-label="Primary">
        <nav className="border-b border-rw-teal/10">
          <div className="px-8 py-4 flex items-center justify-between gap-4">
            <Link
              href="/"
              aria-current={isActivePath(pathname, '/') ? 'page' : undefined}
              className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
            >
              <Image
                src="/logo.svg"
                alt="RepWorth"
                width={32}
                height={32}
                className="size-8 object-contain"
                unoptimized
              />
              <span className="text-sm tracking-wider uppercase text-rw-teal-strong">RepWorth</span>
            </Link>

            {/* Desktop nav links (>=640px) */}
            <div className="hidden sm:flex items-center gap-6">
              {NAV_LINKS.map(({ label, href }) => {
                const active = isActivePath(pathname, href);
                return (
                  <Link
                    key={label}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={`text-sm transition-colors rounded focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2 ${
                      active
                        ? 'text-rw-teal-strong font-semibold underline decoration-2 underline-offset-8'
                        : 'text-rw-teal-strong/80 hover:text-rw-teal-strong'
                    }`}
                  >
                    {label}
                  </Link>
                );
              })}
            </div>

            {/* Desktop auth cluster (sm-gated so it does not duplicate on mobile) */}
            {showOwnerAuth && (
              <div className="hidden sm:flex items-center gap-3">
                <Link
                  href="/login"
                  className="inline-flex min-h-[44px] items-center text-sm text-rw-teal-strong/80 hover:text-rw-teal-strong transition-colors rounded focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  className="inline-flex min-h-[44px] items-center text-sm bg-rw-teal-strong text-white px-4 py-2 rounded-full hover:bg-rw-teal-strong/90 transition-colors focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
                >
                  Sign up
                </Link>
              </div>
            )}

            {/* Mobile hamburger toggle (>=44px touch target) */}
            <button
              ref={toggleRef}
              type="button"
              onClick={() => setMobileOpen((open) => !open)}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileOpen}
              aria-controls={MOBILE_MENU_ID}
              className="sm:hidden inline-flex size-11 items-center justify-center rounded-md p-2 text-rw-teal-strong hover:bg-rw-teal/10 transition-colors focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
            >
              <svg
                className="size-6"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                {mobileOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                  />
                )}
              </svg>
            </button>
          </div>

          {/* Mobile dropdown panel — disclosure, not a focus trap */}
          <AnimatePresence initial={false}>
            {mobileOpen && (
              <m.div
                key="mobile-menu"
                id={MOBILE_MENU_ID}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="sm:hidden overflow-hidden border-t border-rw-teal/10"
              >
                <div className="px-8 py-4 flex flex-col gap-1">
                  {NAV_LINKS.map(({ label, href }, index) => {
                    const active = isActivePath(pathname, href);
                    return (
                      <Link
                        key={label}
                        ref={index === 0 ? firstMobileLinkRef : undefined}
                        href={href}
                        onClick={closeMenu}
                        aria-current={active ? 'page' : undefined}
                        className={`inline-flex min-h-[44px] items-center text-sm transition-colors rounded focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2 ${
                          active ? 'text-rw-teal-strong font-semibold' : 'text-rw-teal-strong/80 hover:text-rw-teal-strong'
                        }`}
                      >
                        {label}
                      </Link>
                    );
                  })}

                  {showOwnerAuth && (
                    <>
                      <div className="my-2 border-t border-rw-teal/10" aria-hidden="true" />
                      <Link
                        href="/login"
                        onClick={closeMenu}
                        className="inline-flex min-h-[44px] items-center text-sm text-rw-teal-strong/80 hover:text-rw-teal-strong transition-colors rounded focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
                      >
                        Log in
                      </Link>
                      <Link
                        href="/signup"
                        onClick={closeMenu}
                        className="mt-1 inline-flex min-h-[44px] w-full items-center justify-center text-sm bg-rw-teal-strong text-white px-4 py-2 rounded-full hover:bg-rw-teal-strong/90 transition-colors focus-visible:outline-2 focus-visible:outline-rw-teal focus-visible:outline-offset-2"
                      >
                        Sign up
                      </Link>
                    </>
                  )}
                </div>
              </m.div>
            )}
          </AnimatePresence>
        </nav>
      </header>
    </LazyMotion>
  );
}
