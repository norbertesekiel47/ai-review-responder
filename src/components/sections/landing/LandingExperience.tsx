'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { TiltCard } from '@/components/ui/be-ui-tilt-card';
import { ScrollExpandSection } from '@/components/ui/scroll-expansion-hero';
import './landing-experience.css';

/**
 * RepWorth landing page — three scroll acts over brand video.
 *
 *  1. Hero: a glass tilt card over a fixed, looping `/video/heroVideo.mp4`
 *     background (autoplays muted, not tied to scroll).
 *  2. Expand: scrolling down pins a section where `/video/hero2Video.mp4`
 *     expands from a card-sized panel to full-bleed (over hero2background.png),
 *     then reveals the Features / How-it-works / Pricing cards on top of it.
 *  3. Final: the "Every review, answered." reveal, back over the hero video.
 *
 * Same-origin `/video/*` keeps the clips inside the production CSP (`default-src
 * 'self'`, no `media-src`).
 */

const VIDEO_SRC = '/video/heroVideo.mp4';
const EXPAND_VIDEO_SRC = '/video/hero2Video.mp4';
const EXPAND_BG_SRC = '/images/hero2background.png';

interface LandingExperienceProps {
  /** Where every CTA points. `/signup` when self-serve signup is live, else the
   *  lead-capture route (`/signup` 404s when the flag is off). */
  primaryCtaHref: string;
  /** Hero + nav CTA label (reflects the trial offer when one is live). */
  primaryCtaLabel: string;
}

export function LandingExperience({ primaryCtaHref, primaryCtaLabel }: LandingExperienceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const finalInnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Muted autoplay needs `muted` set as a property (React's attribute alone is
    // unreliable on Safari) and a best-effort play() so the loop runs from load.
    const video = videoRef.current;
    if (video) {
      video.muted = true;
      const playback = video.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(() => {
          /* autoplay may be blocked; the first frame is an acceptable fallback */
        });
      }
    }

    // Foreground scroll reactions for acts 1 and 3 only (the expand section owns
    // its own scroll). rAF-coalesced; never touches the fixed hero video.
    let finalShown = false;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrollY = window.scrollY || 0;
        const vh = window.innerHeight || 800;

        const hero = heroRef.current;
        if (hero) {
          const ho = Math.max(0, Math.min(1, 1 - scrollY / (vh * 0.82)));
          hero.style.opacity = String(ho);
          hero.style.transform = `translateY(${-(1 - ho) * 40}px)`;
        }

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
      cancelAnimationFrame(frame);
      if (io) io.disconnect();
    };
  }, []);

  return (
    <div className="rw-le">
      {/* Fixed, fully-opaque looping brand video. Decorative; no scroll coupling. */}
      <div className="rw-le-bg" aria-hidden="true">
        <video
          className="rw-le-video"
          ref={videoRef}
          src={VIDEO_SRC}
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
        {/* Act 1 — hero */}
        <section className="rw-le-hero">
          <div className="rw-le-hero-inner" ref={heroRef}>
            <TiltCard className="rw-le-hero-card">
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
            </TiltCard>
          </div>
          <div className="rw-le-cue" aria-hidden="true">
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
        </section>

        {/* Act 2 — scroll-expand: hero2Video grows to full-bleed, then the
            feature cards reveal over it. */}
        <ScrollExpandSection
          mediaSrc={EXPAND_VIDEO_SRC}
          bgImageSrc={EXPAND_BG_SRC}
          label="Explore RepWorth"
        >
          <div className="rw-le-expand-cards-grid">
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
                Simple per-location pricing with a free trial to start. Find the plan that fits your
                business — no surprises.
              </p>
              <span className="rw-le-card-link">View plans →</span>
            </Link>
          </div>
        </ScrollExpandSection>

        {/* Act 3 — final reveal */}
        <section className="rw-le-final">
          <div className="rw-le-final-inner" ref={finalInnerRef}>
            <p className="rw-le-eyebrow">Ready when you are</p>
            <h2 className="rw-le-final-title">Every review, answered.</h2>
            <p className="rw-le-final-sub">
              Save about fifteen hours a week. Your customers feel heard within minutes — and your
              rating takes care of itself.
            </p>
            <Link className="rw-le-btn-primary" href={primaryCtaHref}>
              Join the early access waitlist <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
