'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, m, domAnimation } from 'motion/react';
import { EARLY_ACCESS_CTA, NAV_LINKS } from './marketing-links';

interface SiteNavProps {
  /**
   * When true, the nav offers no door at all: neither the owner-auth cluster
   * nor the early-access pill. The "coming soon" posture, mirrored by the
   * page CTA bands.
   */
  comingSoon?: boolean;
  /** Controls whether owner self-serve auth links are exposed. */
  selfServeEnabled?: boolean;
  /**
   * True when the card-up-front trial is on: the CTA pill reads "Start free
   * trial" (the approved Daylight chrome label). With the trial off it says
   * "Create account" so the chrome never makes a stale trial claim.
   */
  trialEnabled?: boolean;
}

const MOBILE_MENU_ID = 'site-nav-mobile-menu';

/** True when `pathname` is the link target or one of its descendants. */
function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

const ArrowDisc = () => (
  <span className="rw-pill-circ" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  </span>
);

interface NavCtaProps extends Pick<SiteNavProps, 'comingSoon' | 'selfServeEnabled' | 'trialEnabled'> {
  /**
   * `row` is the desktop nav row: the pill carries the arrow disc and "Log in"
   * takes the `.rw-nav-login` chrome. `menu` is the mobile panel: the cluster
   * opens with a separator, the pill drops the disc, and every link closes
   * the menu via `onNavigate`.
   */
  placement: 'row' | 'menu';
  onNavigate?: () => void;
}

/**
 * The nav's right-side door, decided in ONE place for both placements:
 * coming-soon → no door; self-serve on → Log in + the signup pill; self-serve
 * off → the early-access pill to the lead-capture route (same label the
 * landing nav carries — before this, a visitor on /features had no CTA until
 * the closing band).
 */
function NavCta({ comingSoon, selfServeEnabled, trialEnabled, placement, onNavigate }: NavCtaProps) {
  if (comingSoon) return null;
  const inMenu = placement === 'menu';
  const disc = inMenu ? null : <ArrowDisc />;
  const separator = inMenu ? <div className="rw-nav-menu-sep" aria-hidden="true" /> : null;

  if (!selfServeEnabled) {
    return (
      <>
        {separator}
        <Link href={EARLY_ACCESS_CTA.href} onClick={onNavigate} className="rw-pill rw-pill-forest">
          {EARLY_ACCESS_CTA.label}
          {disc}
        </Link>
      </>
    );
  }

  return (
    <>
      {separator}
      <Link href="/login" onClick={onNavigate} className={inMenu ? undefined : 'rw-nav-login'}>
        Log in
      </Link>
      <Link href="/signup" onClick={onNavigate} className="rw-pill rw-pill-forest">
        {trialEnabled ? 'Start free trial' : 'Create account'}
        {disc}
      </Link>
    </>
  );
}

/**
 * Site-wide marketing nav — Daylight Gallery II chrome: a sticky white pill
 * inside the island (styles: `.rw-nav*` in (public)/_styles/island.css).
 * Rendered by SiteShell on the marketing pages and directly by the legal /
 * security / demo / book-a-demo / help islands, so it stays self-contained.
 * The mobile menu is a disclosure, NOT a focus trap: Escape closes and
 * restores focus; Tab flows naturally through the page.
 */
export function SiteNav({ comingSoon = false, selfServeEnabled = false, trialEnabled = false }: SiteNavProps) {
  const cta = { comingSoon, selfServeEnabled, trialEnabled };
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);

  const closeMenu = () => {
    setMobileOpen(false);
    // Restore focus to the toggle so keyboard users keep their place.
    toggleRef.current?.focus();
  };

  // Escape closes the menu and restores focus.
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
      <header aria-label="Primary" className="rw-navwrap">
        <div className="rw-nav-col">
          <nav className="rw-nav">
            <Link
              href="/"
              aria-current={isActivePath(pathname, '/') ? 'page' : undefined}
              className="rw-nav-brand"
            >
              <Image src="/logo.svg" alt="" width={26} height={26} unoptimized />
              <span>RepWorth</span>
            </Link>

            {/* Desktop nav links (>680px) */}
            <div className="rw-nav-links">
              {NAV_LINKS.map(({ label, href }) => {
                const active = isActivePath(pathname, href);
                return (
                  <Link
                    key={label}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={active ? 'is-active' : undefined}
                  >
                    {label}
                  </Link>
                );
              })}
            </div>

            <div className="rw-nav-right">
              <NavCta {...cta} placement="row" />

              {/* Mobile hamburger toggle (44px touch target) */}
              <button
                ref={toggleRef}
                type="button"
                onClick={() => setMobileOpen((open) => !open)}
                aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileOpen}
                aria-controls={MOBILE_MENU_ID}
                className="rw-nav-toggle"
              >
                <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
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
          </nav>

          {/* Mobile dropdown panel: disclosure, not a focus trap */}
          <AnimatePresence initial={false}>
            {mobileOpen && (
              <m.div
                key="mobile-menu"
                id={MOBILE_MENU_ID}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="rw-nav-menu"
              >
                <div className="rw-nav-menu-inner">
                  {NAV_LINKS.map(({ label, href }, index) => {
                    const active = isActivePath(pathname, href);
                    return (
                      <Link
                        key={label}
                        ref={index === 0 ? firstMobileLinkRef : undefined}
                        href={href}
                        onClick={closeMenu}
                        aria-current={active ? 'page' : undefined}
                        className={active ? 'is-active' : undefined}
                      >
                        {label}
                      </Link>
                    );
                  })}

                  <NavCta {...cta} placement="menu" onNavigate={closeMenu} />
                </div>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </header>
    </LazyMotion>
  );
}
