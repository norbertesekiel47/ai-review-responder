'use client';

import Link from 'next/link';
import { LazyMotion, domAnimation } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { NAV_LINKS } from '@/components/ui/marketing-links';
import { AmbientMotionProvider, useAmbientMotionPaused } from './ambient-motion';
import { CtaSection } from './cta/CtaSection';
import { LandingFooter } from './footer/LandingFooter';
import { FleetSection } from './fleet/FleetSection';
import { FutureSection } from './future/FutureSection';
import { HeroSection } from './hero/HeroSection';
import { PersonasSection } from './personas/PersonasSection';
import { WatchdogsSection } from './watchdogs/WatchdogsSection';
import './agent-flip-card.css';
import './cta/cta.css';
import './footer/footer.css';
import './fleet/fleet.css';
import './fleet/video-lightbox.css';
import './future/future.css';
import './hero/hero.css';
import './personas/personas.css';
import './watchdogs/watchdogs.css';
import './landing-experience.css';

/**
 * RepWorth landing page.
 *
 * Composition root for the marketing page: it owns the chrome (nav, the single
 * `<main id="main-content">` landmark the public layout's skip link targets,
 * and the footer) and nothing else. Each narrative section is its own module
 * under `./<section>/`, so this file stays a table of contents as sections land
 * rather than growing back into a monolith.
 *
 * Sections, per the narrative spine in the website design reference §3.4:
 *   1. Hero                    <- built
 *   2. Meet the fleet          <- built (constellation + run-spine centre)
 *   3. The agents that act     <- built (four personas, in depth)
 *   4. The agents that watch   <- built (Judge + Governor, cooler register)
 *   5. Where this is going     <- built (committed vs exploring, two tiers)
 *   6. The problem             <- pending, if still wanted
 *   7. The pipeline            <- pending
 *   8. Copilot vs Autopilot    <- pending
 *   9. CTA                     <- built (night bookend to the hero)
 *
 * 1 and 9 are a deliberate pair: the same world, opened in daylight with the
 * copy set RIGHT and closed at night with it set LEFT. They are the only two
 * full-bleed video sections, and they mirror rather than repeat.
 *
 * Accent temperature is load-bearing across 3 and 4: the acting agents are
 * GOLD, the supervising agents are TEAL. That contrast is what makes the
 * oversight layer read as a different tier rather than more of the same.
 *
 * Nav positioning note: the nav is absolute over the hero rather than sticky,
 * because with one section on the page there is no scrolled state to design
 * against yet. Revisit when section 2 lands.
 *
 * Scroll note (2026-08-16 Linear pass): the page scrolls natively. The Lenis
 * smooth-scroll + snap layer, the scroll-linked section dissolve, the chapter
 * rail and the vertical chapter markers were removed together — the reader
 * owns the wheel, sections are as tall as their content, and the only motion
 * on arrival is `Reveal`'s single opacity fade. Rationale and the measurements
 * that changed: docs/design/landing/measurements.md §2.
 */

interface LandingExperienceProps {
  /** Where every CTA points. `/signup` when self-serve signup is live, else the
   *  lead-capture route (`/signup` 404s when the flag is off). Resolved on the
   *  server — invariant #13, no `NEXT_PUBLIC_*` flag companion. */
  primaryCtaHref: string;
  /** CTA label, reflecting the trial offer when one is live. */
  primaryCtaLabel: string;
  /**
   * `SELF_SERVE_SIGNUP_ENABLED`, resolved on the server (invariant #13 — no
   * `NEXT_PUBLIC_*` companion). Gates the nav's Log in / Sign up pair.
   *
   * Both routes are gated the same way at the route level: `/login` and
   * `/signup` each call `notFound()` when the flag is off. So this is not a
   * cosmetic hide — showing either link with the flag off would link straight
   * to a 404, which is why Log in is gated too even though "log in" normally
   * outlives a closed signup.
   */
  selfServeEnabled: boolean;
}

/**
 * The provider is a separate outer component for one reason: the paused state
 * has to reach BOTH the clips (through context) and the page root as a data
 * attribute (so CSS can pause every infinite keyframe animation). A
 * component cannot read a context it is itself providing, so the root element
 * lives one level in.
 */
export function LandingExperience(props: LandingExperienceProps) {
  return (
    // One provider for the whole page. `domAnimation` is animations + gestures,
    // which is exactly what this page uses — `whileInView` lives in the gesture
    // set, and `useScroll`/`useTransform` are hooks that need no feature at all.
    // `strict` makes a `motion.*` component throw instead of silently pulling
    // the full feature bundle back in, which is the regression this migration
    // exists to prevent.
    <LazyMotion features={domAnimation} strict>
      <AmbientMotionProvider>
        <LandingChrome {...props} />
      </AmbientMotionProvider>
    </LazyMotion>
  );
}

function LandingChrome({
  primaryCtaHref,
  primaryCtaLabel,
  selfServeEnabled,
}: LandingExperienceProps) {
  const ambientMotionPaused = useAmbientMotionPaused();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  // Escape closes the mobile menu and returns focus to the trigger. Bound only
  // while open so the landing page adds no idle key listener.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, closeMenu]);

  return (
    // The attribute, not a class, because it is state rather than styling —
    // and it is on the ROOT so one rule in landing-experience.css can halt
    // every keyframe animation on the page without enumerating them.
    <div className="rw-lp" data-ambient-motion={ambientMotionPaused ? 'paused' : 'running'}>
      <nav className="rw-lp-nav" aria-label="Primary">
        {/* Mark + wordmark together. The logo's own gold (#e2c38b) is within a
            hair of `--rw-lp-accent`, so the pair reads as one lockup against
            the hero rather than two borrowed assets. */}
        <Link href="/" className="rw-lp-wordmark">
          <BrandLogo size={30} className="rw-lp-wordmark-mark" />
          <span className="rw-lp-wordmark-text">RepWorth</span>
        </Link>

        <ul className="rw-lp-nav-links">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="rw-lp-nav-link">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* The nav's one filled control — the same gold pill the hero and the
            closing band carry, so the primary action sits where a first-time
            visitor looks for it before reading a word of the hero.

            Flag on: the owner-auth pair, mirroring SiteNav's cluster on the
            other marketing pages (same order, same labels, same flag) so the
            two navs cannot drift into offering different doors. Flag off: the
            lead-capture CTA is the only door there is, so the pill points at
            it. Never both — with self-serve on, `primaryCtaHref` IS `/signup`.

            Short labels on purpose: the offer-bearing label ("Start your
            30-day free trial") is only ever produced when self-serve is on,
            which is exactly the branch that renders "Sign up" instead. */}
        <div className="rw-lp-nav-auth">
          {selfServeEnabled ? (
            <>
              <Link href="/login" className="rw-lp-nav-link rw-lp-nav-login">
                Log in
              </Link>
              <Link href="/signup" className="rw-lp-nav-cta">
                Sign up
              </Link>
            </>
          ) : (
            <Link href={primaryCtaHref} className="rw-lp-nav-cta">
              {primaryCtaLabel}
            </Link>
          )}
        </div>

        <button
          ref={menuButtonRef}
          type="button"
          className="rw-lp-menu-button"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
          <span
            className="rw-lp-menu-bars"
            data-open={menuOpen ? 'true' : 'false'}
            aria-hidden="true"
          >
            <span />
            <span />
          </span>
        </button>

        <div
          id={menuId}
          className="rw-lp-menu-panel"
          data-open={menuOpen ? 'true' : 'false'}
          hidden={!menuOpen}
        >
          <ul>
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="rw-lp-menu-link" onClick={closeMenu}>
                  {link.label}
                </Link>
              </li>
            ))}
            {/* Not both. With self-serve on, `primaryCtaHref` IS `/signup`, so
                rendering the primary CTA alongside "Sign up" would put two
                differently-labelled links to one destination in a short menu.
                Flag on → the auth pair; flag off → the lead-capture CTA, which
                is then the only door there is. */}
            {selfServeEnabled ? (
              <>
                <li>
                  <Link href="/login" className="rw-lp-menu-link" onClick={closeMenu}>
                    Log in
                  </Link>
                </li>
                <li>
                  <Link href="/signup" className="rw-lp-menu-link" onClick={closeMenu}>
                    Sign up
                  </Link>
                </li>
              </>
            ) : (
              <li>
                <Link href={primaryCtaHref} className="rw-lp-menu-link" onClick={closeMenu}>
                  {primaryCtaLabel}
                </Link>
              </li>
            )}
          </ul>
        </div>
      </nav>

      <main id="main-content">
        {/* Sections sit directly in the landmark. No wrapper carries a snap
            point or a scroll-linked transform any more, which also means
            nothing above the future section can put a transform on an ancestor
            of its `background-attachment: fixed` card glow. */}
        <HeroSection primaryCtaHref={primaryCtaHref} primaryCtaLabel={primaryCtaLabel} />

        <FleetSection
          videoSrc="/video/repworth-explainer.mp4"
          videoPoster="/video/repworth-explainer-poster.jpg"
          videoTitle="Watch the film"
        />

        <PersonasSection />

        <WatchdogsSection />

        <FutureSection />

        <CtaSection primaryCtaHref={primaryCtaHref} primaryCtaLabel={primaryCtaLabel} />
      </main>

      <LandingFooter />
    </div>
  );
}
