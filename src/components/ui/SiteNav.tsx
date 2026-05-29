'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

interface SiteNavProps {
  /** When true, the right-side Log in / Sign up cluster is hidden. */
  comingSoon?: boolean;
  /** Controls whether owner self-serve auth links are exposed. */
  selfServeEnabled?: boolean;
}

const NAV_LINKS = [
  { label: 'Features', href: '/features' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Pricing', href: '/pricing' },
];

const MOBILE_MENU_ID = 'site-nav-mobile-menu';

export function SiteNav({ comingSoon = false, selfServeEnabled = false }: SiteNavProps) {
  const showOwnerAuth = selfServeEnabled && !comingSoon;
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const closeMenu = () => setMobileOpen(false);

  return (
    <nav className="border-b border-[#97B3AE]/10">
      <div className="px-8 py-4 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/Logo - SVG.svg"
            alt="RepWorth"
            width={32}
            height={32}
            className="w-8 h-8 object-contain"
          />
          <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
        </Link>

        {/* Desktop nav links (unchanged at >=640px) */}
        <div className="hidden sm:flex items-center gap-6">
          {NAV_LINKS.map(({ label, href }) => (
            <Link
              key={label}
              href={href}
              className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
            >
              {label}
            </Link>
          ))}
        </div>

        {/* Desktop auth cluster (now sm-gated so it does not duplicate on mobile) */}
        {showOwnerAuth && (
          <div className="hidden sm:flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
            >
              Sign up
            </Link>
          </div>
        )}

        {/* Mobile hamburger toggle */}
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          aria-controls={MOBILE_MENU_ID}
          className="sm:hidden inline-flex items-center justify-center rounded-md p-2 text-[#97B3AE] hover:bg-[#97B3AE]/10 transition-colors"
        >
          <svg
            className="w-6 h-6"
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

      {/* Mobile dropdown panel */}
      <AnimatePresence initial={false}>
        {mobileOpen && (
          <motion.div
            key="mobile-menu"
            id={MOBILE_MENU_ID}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="sm:hidden overflow-hidden border-t border-[#97B3AE]/10"
          >
            <div className="px-8 py-4 flex flex-col gap-1">
              {NAV_LINKS.map(({ label, href }) => (
                <Link
                  key={label}
                  href={href}
                  onClick={closeMenu}
                  className="py-2 text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
                >
                  {label}
                </Link>
              ))}

              {showOwnerAuth && (
                <>
                  <div className="my-2 border-t border-[#97B3AE]/10" aria-hidden="true" />
                  <Link
                    href="/login"
                    onClick={closeMenu}
                    className="py-2 text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
                  >
                    Log in
                  </Link>
                  <Link
                    href="/signup"
                    onClick={closeMenu}
                    className="mt-1 inline-flex w-full justify-center text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
                  >
                    Sign up
                  </Link>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
