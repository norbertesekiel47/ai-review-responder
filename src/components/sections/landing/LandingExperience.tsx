'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { TiltCard } from '@/components/ui/be-ui-tilt-card';
import { NAV_LINKS } from '@/components/ui/marketing-links';
import './landing-experience.css';

/**
 * RepWorth landing page — one continuous, scroll-linked pinned stage.
 *
 * The whole page is a single fixed stage whose contents crossfade as you scroll
 * (no section-to-section hand-off, so nothing "jumps"):
 *
 *   1. Hero      — a frosted glass card on the right (copy) over the fixed,
 *                  looping /video/heroVideo.mp4.
 *   2. Expand    — that same card grows to full-bleed, its copy crossfades out
 *                  and /video/hero2Video.mp4 in, then the three agent-persona
 *                  cards (Reply / Guardian / Insights) reveal on top.
 *   3. Final     — the media crossfades to the mirrored /video/hero3Video.mp4,
 *                  the persona cards fade out, and the closing glass tilt card
 *                  fades in on the left.
 *
 * Geometry + every cross-fade are written imperatively from one rAF-coalesced
 * scroll listener. Same-origin /video/* keeps the clips inside the production
 * CSP (`default-src 'self'`, no `media-src`).
 *
 * Visual direction (Variant A — "Editorial"): serif-led display type, paper
 * surfaces, ink-first hierarchy. The signature motif is a hand-drawn ink
 * underline (see InkUnderline) that recurs once per act.
 */

const HERO_VIDEO_SRC = '/video/heroVideo.mp4';
const MORPH_VIDEO_SRC = '/video/hero2Video.mp4';
const FINAL_VIDEO_SRC = '/video/hero3Video.mp4';

interface LandingExperienceProps {
  /** Where every CTA points. `/signup` when self-serve signup is live, else the
   *  lead-capture route (`/signup` 404s when the flag is off). */
  primaryCtaHref: string;
  /** CTA label for the nav, hero, and closing card (reflects the trial offer
   *  when one is live). */
  primaryCtaLabel: string;
}

/**
 * The editorial motif: a slightly bowed, hand-ruled underline drawn in the
 * brand teal. It appears exactly once per act (hero headline, the "team"
 * annotation in act 2, the closing headline) so the accent stays decisive
 * rather than decorative. The stroke draws itself in on load; reduced-motion
 * renders it already drawn.
 */
function InkUnderline() {
  return (
    <svg
      className="rw-le-ink"
      viewBox="0 0 120 8"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 6.2 C 28 2.4, 64 2.2, 118 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        pathLength="1"
      />
    </svg>
  );
}

export function LandingExperience({ primaryCtaHref, primaryCtaLabel }: LandingExperienceProps) {
  const heroVideoRef = useRef<HTMLVideoElement>(null);
  const morphVideoRef = useRef<HTMLVideoElement>(null);
  const finalVideoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const finalBgRef = useRef<HTMLDivElement>(null);
  const finalHolderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clamp = (n: number) => Math.max(0, Math.min(1, n));

    // Muted autoplay (set as property for Safari) on every clip so each is
    // already playing when it fades in.
    for (const v of [heroVideoRef.current, morphVideoRef.current, finalVideoRef.current]) {
      if (!v) continue;
      v.muted = true;
      const playback = v.play();
      if (playback && typeof playback.catch === 'function') playback.catch(() => {});
    }

    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const track = trackRef.current;
        const panel = panelRef.current;
        if (!track || !panel) return;

        const vh = window.innerHeight || 800;
        const vw = window.innerWidth || 1200;
        const rect = track.getBoundingClientRect();
        const total = Math.max(1, rect.height - vh);
        const progress = clamp(-rect.top / total);

        // ---- Act 1 → 2: the hero card grows to full-bleed ----
        // Rest footprint (matches the hero card); centred on small screens.
        const isMobile = vw < 820;
        const w0 = isMobile ? Math.min(520, vw * 0.9) : Math.min(940, vw * 0.52);
        const h0 = isMobile ? Math.min(560, vh * 0.68) : Math.min(620, vh * 0.74);
        const left0 = isMobile ? (vw - w0) / 2 : vw * 0.95 - w0;
        const top0 = (vh - h0) / 2;
        const e = clamp(progress / 0.32); // expansion done at 32% of the track
        panel.style.width = `${w0 + e * (vw - w0)}px`;
        panel.style.height = `${h0 + e * (vh - h0)}px`;
        panel.style.left = `${left0 * (1 - e)}px`;
        panel.style.top = `${top0 * (1 - e)}px`;
        panel.style.borderRadius = `${16 * (1 - e)}px`;

        const glass = glassRef.current;
        if (glass) glass.style.opacity = String(clamp(1 - e * 2.2));
        const morph = morphVideoRef.current;
        if (morph) morph.style.opacity = String(clamp((e - 0.08) / 0.42));
        const content = contentRef.current;
        if (content) content.style.opacity = String(clamp(1 - progress / 0.12));
        const cue = cueRef.current;
        if (cue) cue.style.opacity = String(clamp(1 - progress / 0.05));

        // ---- Act 2 → 3: crossfade to the final video + card ----
        const a3 = clamp((progress - 0.62) / 0.18); // hero3 video fades in
        const finalP = clamp((progress - 0.72) / 0.16); // final card fades in

        const cards = cardsRef.current;
        if (cards) {
          const reveal = clamp((progress - 0.38) / 0.1);
          const opacity = reveal * (1 - a3); // reveal in act 2, fade out into act 3
          cards.style.opacity = String(opacity);
          cards.style.transform = `translateY(${(1 - reveal) * 28}px)`;
          cards.style.pointerEvents = opacity > 0.5 ? 'auto' : 'none';
          cards.inert = opacity <= 0.5;
        }

        const finalBg = finalBgRef.current;
        if (finalBg) finalBg.style.opacity = String(a3);
        const finalHolder = finalHolderRef.current;
        if (finalHolder) {
          finalHolder.style.opacity = String(finalP);
          finalHolder.style.pointerEvents = finalP > 0.5 ? 'auto' : 'none';
          finalHolder.inert = finalP <= 0.5;
        }
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="rw-le">
      {/* Fixed, fully-opaque looping hero video (act 1 backdrop, behind the stage). */}
      <div className="rw-le-bg" aria-hidden="true">
        <video
          className="rw-le-video"
          ref={heroVideoRef}
          src={HERO_VIDEO_SRC}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          tabIndex={-1}
        />
      </div>

      <nav className="rw-le-nav" aria-label="Primary">
        <div className="rw-le-nav-left">
          <Link className="rw-le-brand" href="/">
            RepWorth
          </Link>
          <div className="rw-le-nav-links">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href}>{link.label}</Link>
            ))}
          </div>
        </div>
        <Link className="rw-le-cta" href={primaryCtaHref}>
          {primaryCtaLabel}
        </Link>
      </nav>

      <main id="main-content" className="rw-le-scroll">
        <section ref={trackRef} className="rw-le-morph-track" aria-label="RepWorth">
          <div className="rw-le-morph-stage">
            {/* Act 1-2 — the hero card morphs into the full-bleed hero2 video. */}
            <div ref={panelRef} className="rw-le-morph-panel">
              <video
                ref={morphVideoRef}
                className="rw-le-morph-video"
                src={MORPH_VIDEO_SRC}
                muted
                loop
                playsInline
                preload="auto"
                tabIndex={-1}
                aria-hidden="true"
              />
              <div ref={glassRef} className="rw-le-morph-glass" aria-hidden="true" />
              <div ref={contentRef} className="rw-le-morph-content">
                <p className="rw-le-eyebrow">
                  <span className="rw-le-eyebrow-rule" aria-hidden="true" />
                  An AI agent team for Google reviews
                </p>
                <h1 className="rw-le-title">
                  Put a{' '}
                  <span className="rw-le-uword">
                    team
                    <InkUnderline />
                  </span>{' '}
                  on your&nbsp;reviews.
                </h1>
                <p className="rw-le-sub">
                  Reply drafts an answer to every review in your voice. Guardian holds anything
                  negative and brings it to you first. Insights files the weekly brief. Nothing
                  posts without your say — and around fifteen hours of typing a week comes off
                  your desk.
                </p>
                <div className="rw-le-hero-ctas">
                  <Link className="rw-le-btn-primary" href={primaryCtaHref}>
                    {primaryCtaLabel} <span aria-hidden="true">→</span>
                  </Link>
                  <Link className="rw-le-btn-ghost" href="/how-it-works">
                    How the team works <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </div>
            </div>

            {/* Act 3 backdrop — mirrored final video, crossfades in over the panel. */}
            <div ref={finalBgRef} className="rw-le-final-bg" aria-hidden="true">
              <video
                className="rw-le-final-video"
                ref={finalVideoRef}
                src={FINAL_VIDEO_SRC}
                muted
                loop
                playsInline
                preload="auto"
                tabIndex={-1}
              />
            </div>

            {/* Act 2 — the agent-persona cards over the expanded media. */}
            <div ref={cardsRef} className="rw-le-morph-cards">
              <div className="rw-le-cards-frame">
                <p className="rw-le-cards-kicker">
                  Meet the{' '}
                  <span className="rw-le-uword rw-le-uword-kicker">
                    team
                    <InkUnderline />
                  </span>
                </p>

                <div className="rw-le-morph-cards-grid">
                  <article className="rw-le-persona rw-le-persona-reply">
                    <h3 className="rw-le-persona-name">Reply</h3>
                    <p className="rw-le-persona-role">the writer</p>
                    <p className="rw-le-persona-body">
                      Drafts an answer to every Google review in your voice, then posts the moment
                      you approve. On Autopilot, 4–5★ unflagged replies go out on their own —
                      after a veto window you can cancel.
                    </p>
                    <p className="rw-le-persona-log">
                      <span className="rw-le-log-dot" aria-hidden="true" />
                      review in&nbsp;&nbsp;·&nbsp;&nbsp;drafted in your voice&nbsp;&nbsp;·&nbsp;&nbsp;your
                      call&nbsp;&nbsp;·&nbsp;&nbsp;posted
                    </p>
                  </article>

                  <article className="rw-le-persona rw-le-persona-guardian">
                    <h3 className="rw-le-persona-name">Guardian</h3>
                    <p className="rw-le-persona-role">the gatekeeper</p>
                    <p className="rw-le-persona-body">
                      Reads severity first. A negative or flagged review is held, escalated to
                      your channel with context and a recommended move, and tracked until it is
                      resolved.
                    </p>
                    <p className="rw-le-persona-note">
                      Negative reviews are never auto-posted. On any plan.
                    </p>
                  </article>

                  <article className="rw-le-persona rw-le-persona-insights">
                    <h3 className="rw-le-persona-name">Insights</h3>
                    <p className="rw-le-persona-role">the analyst</p>
                    <p className="rw-le-persona-body">
                      Files a weekly brief: your sentiment trend, the numbers that moved, the
                      reviews worth reading — and what the team did about them.
                    </p>
                    <div className="rw-le-persona-brief" aria-hidden="true">
                      <span className="rw-le-brief-line" style={{ width: '86%' }} />
                      <span className="rw-le-brief-line" style={{ width: '64%' }} />
                      <span className="rw-le-brief-line" style={{ width: '74%' }} />
                    </div>
                    <p className="rw-le-persona-caption">the weekly brief</p>
                  </article>
                </div>

                <p className="rw-le-cards-foot">
                  <Link className="rw-le-btn-ghost rw-le-btn-ghost-light" href="/pricing">
                    Compare Copilot and Autopilot <span aria-hidden="true">→</span>
                  </Link>
                </p>
              </div>
            </div>

            {/* Act 3 — closing glass tilt card, crossfades in on the left. */}
            <div ref={finalHolderRef} className="rw-le-final-holder">
              <TiltCard className="rw-le-final-card">
                <div className="rw-le-final-inner">
                  <p className="rw-le-final-kicker">The last word is yours</p>
                  <h2 className="rw-le-final-title">
                    Consider it{' '}
                    <span className="rw-le-uword">
                      handled
                      <InkUnderline />
                    </span>
                    .
                  </h2>
                  <p className="rw-le-final-sub">
                    Reply writes, Guardian watches, Insights reports — and the evenings you spent
                    typing go back to the business. Approve every reply on Copilot, or set the
                    policy on Autopilot and keep the veto.
                  </p>
                  <Link className="rw-le-btn-primary" href={primaryCtaHref}>
                    {primaryCtaLabel} <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </TiltCard>
            </div>

            <div ref={cueRef} className="rw-le-morph-cue" aria-hidden="true">
              <span className="rw-le-cue-label">keep reading</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
