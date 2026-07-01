'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { TiltCard } from '@/components/ui/be-ui-tilt-card';
import './landing-experience.css';

/**
 * RepWorth landing page — a continuous scroll morph over brand video.
 *
 *  Act 1 → 2 (one pinned morph): at the top it IS the hero — a frosted glass
 *  card on the right (with the hero copy) floating over the fixed, looping
 *  `/video/heroVideo.mp4`. As you scroll, that same card grows and slides to
 *  full-bleed, its copy crossfades out while `/video/hero2Video.mp4` fades in,
 *  and the Features / How-it-works / Pricing cards reveal on top.
 *
 *  Act 3: the morph releases and "Every review, answered." reveals, back over
 *  the hero video.
 *
 * Geometry + cross-fades are written imperatively from one rAF-coalesced scroll
 * listener (no per-frame React state). Same-origin `/video/*` keeps the clips
 * inside the production CSP (`default-src 'self'`, no `media-src`).
 */

const HERO_VIDEO_SRC = '/video/heroVideo.mp4';
const MORPH_VIDEO_SRC = '/video/hero2Video.mp4';
const FINAL_VIDEO_SRC = '/video/hero3Video.mp4';

interface LandingExperienceProps {
  /** Where every CTA points. `/signup` when self-serve signup is live, else the
   *  lead-capture route (`/signup` 404s when the flag is off). */
  primaryCtaHref: string;
  /** Hero + nav CTA label (reflects the trial offer when one is live). */
  primaryCtaLabel: string;
}

export function LandingExperience({ primaryCtaHref, primaryCtaLabel }: LandingExperienceProps) {
  const heroVideoRef = useRef<HTMLVideoElement>(null);
  const morphVideoRef = useRef<HTMLVideoElement>(null);
  const finalVideoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const finalInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clamp = (n: number) => Math.max(0, Math.min(1, n));

    // Muted autoplay (set as property for Safari) on both clips so the morph
    // clip is already playing when it fades in.
    for (const v of [heroVideoRef.current, morphVideoRef.current, finalVideoRef.current]) {
      if (!v) continue;
      v.muted = true;
      const playback = v.play();
      if (playback && typeof playback.catch === 'function') playback.catch(() => {});
    }

    let finalShown = false;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const vh = window.innerHeight || 800;
        const vw = window.innerWidth || 1200;

        const track = trackRef.current;
        const stage = stageRef.current;
        const panel = panelRef.current;
        if (track && stage && panel) {
          const rect = track.getBoundingClientRect();
          const total = Math.max(1, rect.height - vh);
          const progress = clamp(-rect.top / total);
          const active = rect.top <= 0 && rect.bottom >= vh;
          const near = rect.top < vh && rect.bottom > 0;

          stage.style.visibility = near ? 'visible' : 'hidden';
          stage.style.opacity = active ? '1' : '0';
          stage.style.pointerEvents = active ? 'auto' : 'none';

          // The hero card's footprint at rest → full-bleed. On wide screens the
          // card sits on the right (clear of the TV); on small screens it centres.
          const isMobile = vw < 820;
          const w0 = isMobile ? Math.min(520, vw * 0.9) : Math.min(940, vw * 0.52);
          const h0 = isMobile ? Math.min(560, vh * 0.68) : Math.min(620, vh * 0.74);
          const left0 = isMobile ? (vw - w0) / 2 : vw * 0.95 - w0;
          const top0 = (vh - h0) / 2; // vertically centred
          const e = clamp(progress / 0.6); // expansion done at 60% of the track
          panel.style.width = `${w0 + e * (vw - w0)}px`;
          panel.style.height = `${h0 + e * (vh - h0)}px`;
          panel.style.left = `${left0 * (1 - e)}px`;
          panel.style.top = `${top0 * (1 - e)}px`;
          panel.style.borderRadius = `${16 * (1 - e)}px`;

          const glass = glassRef.current;
          if (glass) glass.style.opacity = String(clamp(1 - e * 2.2)); // glass gone early
          const morph = morphVideoRef.current;
          if (morph) morph.style.opacity = String(clamp((e - 0.08) / 0.42)); // video fades in
          const content = contentRef.current;
          if (content) content.style.opacity = String(clamp(1 - progress / 0.16)); // copy out fast
          const cue = cueRef.current;
          if (cue) cue.style.opacity = String(clamp(1 - progress / 0.07));

          const cards = cardsRef.current;
          if (cards) {
            const c = clamp((progress - 0.66) / 0.16);
            cards.style.opacity = String(c);
            cards.style.transform = `translateY(${(1 - c) * 28}px)`;
            cards.style.pointerEvents = c > 0.5 ? 'auto' : 'none';
            cards.inert = c <= 0.5;
          }
        }

        // Act 3 reveal.
        const fin = finalInnerRef.current;
        if (fin && !finalShown) {
          const fr = fin.getBoundingClientRect();
          if (fr.top < vh * 0.82) {
            finalShown = true;
            fin.classList.add('is-revealed');
          }
        }
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    let io: IntersectionObserver | null = null;
    if (finalInnerRef.current) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && !finalShown) {
              finalShown = true;
              e.target.classList.add('is-revealed');
            }
          }
        },
        { threshold: 0.32 },
      );
      io.observe(finalInnerRef.current);
    }

    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
      if (io) io.disconnect();
    };
  }, []);

  return (
    <div className="rw-le">
      {/* Fixed, fully-opaque looping brand video. Decorative; behind everything. */}
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
            <Link href="/features">Features</Link>
            <Link href="/how-it-works">How it works</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
        </div>
        <Link className="rw-le-cta" href={primaryCtaHref}>
          {primaryCtaLabel}
        </Link>
      </nav>

      <main id="main-content" className="rw-le-scroll">
        {/* Acts 1 + 2 — the hero card morphs into the full-bleed hero2 video. */}
        <section ref={trackRef} className="rw-le-morph-track" aria-label="RepWorth">
          <div ref={stageRef} className="rw-le-morph-stage">
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
                <p className="rw-le-eyebrow">Review response, on autopilot</p>
                <h1 className="rw-le-title">
                  Every review gets the reply it{' '}
                  <span className="rw-le-mark">
                    <span className="rw-le-mark-bar" aria-hidden="true" />
                    <span className="rw-le-mark-text">deserves</span>
                  </span>
                  .
                </h1>
                <p className="rw-le-sub">
                  RepWorth drafts a reply to every Google review in your voice, notifies you, and
                  posts it the moment you tap approve. You save about fifteen hours a week — your
                  customers feel heard within minutes.
                </p>
                <div className="rw-le-hero-ctas">
                  <Link className="rw-le-btn-primary" href={primaryCtaHref}>
                    {primaryCtaLabel} <span aria-hidden="true">→</span>
                  </Link>
                  <Link className="rw-le-btn-ghost" href="/how-it-works">
                    See how it works →
                  </Link>
                </div>
              </div>
            </div>

            <div ref={cardsRef} className="rw-le-morph-cards">
              <div className="rw-le-morph-cards-grid">
                <Link className="rw-le-card" href="/features">
                  <span className="rw-le-card-num">01</span>
                  <h3>Features</h3>
                  <p>
                    Everything RepWorth drafts, posts, and tracks for you — replies written in your
                    voice, sent the moment you tap approve.
                  </p>
                  <span className="rw-le-card-link">Explore features →</span>
                </Link>
                <Link className="rw-le-card" href="/how-it-works">
                  <span className="rw-le-card-num">02</span>
                  <h3>How it works</h3>
                  <p>
                    Connect Google, set your tone, approve. Three simple steps to staying on top of
                    every review without the busywork.
                  </p>
                  <span className="rw-le-card-link">See the flow →</span>
                </Link>
                <Link className="rw-le-card" href="/pricing">
                  <span className="rw-le-card-num">03</span>
                  <h3>Pricing</h3>
                  <p>
                    Simple per-location pricing with a free trial to start. Find the plan that fits
                    your business — no surprises.
                  </p>
                  <span className="rw-le-card-link">View plans →</span>
                </Link>
              </div>
            </div>

            <div ref={cueRef} className="rw-le-morph-cue" aria-hidden="true">
              <span className="rw-le-cue-label">Scroll</span>
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

        {/* Act 3 — final reveal, over its own (mirrored) background video, copy
            in the interactive glass tilt card on the left. */}
        <section className="rw-le-final">
          <div className="rw-le-final-bg" aria-hidden="true">
            <video
              className="rw-le-final-video"
              ref={finalVideoRef}
              src={FINAL_VIDEO_SRC}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              tabIndex={-1}
            />
          </div>
          <TiltCard className="rw-le-final-card">
            <div className="rw-le-final-inner" ref={finalInnerRef}>
              <p className="rw-le-eyebrow">Ready when you are</p>
              <h2 className="rw-le-final-title">Every review, answered.</h2>
              <p className="rw-le-final-sub">
                Save about fifteen hours a week. Your customers feel heard within minutes — and
                your rating takes care of itself.
              </p>
              <Link className="rw-le-btn-primary" href={primaryCtaHref}>
                Join the early access waitlist <span aria-hidden="true">→</span>
              </Link>
            </div>
          </TiltCard>
        </section>
      </main>
    </div>
  );
}
