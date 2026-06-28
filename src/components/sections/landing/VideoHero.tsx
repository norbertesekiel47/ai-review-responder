'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * Cinematic video intro that sits ABOVE the existing landing page and fades
 * down into it. Ported from the imported "Velorah Hero Landing" Claude Design
 * comp, re-worded for RepWorth and re-tokenised to the brand island palette.
 *
 * Layering contract (why this is a normal-flow block, not the comp's pinned
 * video): the landing's drifting-reviews marquee is `position:fixed;z-index:0`
 * and `.rw-landing` paints an opaque sage background. A permanently-pinned
 * video would either be covered by that fixed marquee or, if raised above it,
 * would itself cover the marquee behind the white island for the whole page.
 * So instead this section is a 100vh block at `z-index:61` — above the fixed
 * marquee (z0) and the section dot-nav (z60) so it cleanly covers them while
 * in view, then scrolls up and out, revealing the existing landing untouched.
 * Its bottom edge is a dark→sage gradient (`.rw-vh-fade`) that melts into the
 * sage field, and the headline fades + the video parallax-zooms on scroll.
 */

// Background footage from the imported comp, self-hosted in /public so it's
// same-origin: the production CSP has no media-src and falls back to
// default-src 'self', which blocks any external host (an external CDN URL
// renders nothing on staging/prod). Swap this file for a brand clip when ready
// — keep it same-origin so no CSP change is needed.
const VIDEO_SRC = '/video/landing-hero.mp4';

// Smooth-scroll to an element on the existing landing page below this hero:
// '#main-content' for the scroll cue (enter the page) and '#rw-cta' for the
// early-access CTA (the landing's own waitlist form, the same target its
// "Join waitlist" button uses).
function scrollToLandingTarget(id: string, smooth: boolean) {
  const el = document.getElementById(id) ?? document.getElementById('rw-hero');
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' });
}

export function VideoHero() {
  const reduced = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      // Autoplay needs muted set imperatively for iOS Safari; honour the
      // reduced-motion preference by leaving the video paused on its first frame.
      video.muted = true;
      if (reduced) {
        video.pause();
      } else {
        const playback = video.play();
        if (playback && typeof playback.catch === 'function') {
          playback.catch(() => {
            /* autoplay can be blocked; the still frame is an acceptable fallback */
          });
        }
      }
    }

    if (reduced) return;

    // Scroll-linked headline fade + video parallax. rAF-coalesced so multiple
    // scroll events in a frame collapse to one style write.
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrolled = window.scrollY || 0;
        const viewportH = window.innerHeight || 800;
        const progress = Math.min(Math.max(scrolled / (viewportH * 0.8), 0), 1);

        const content = contentRef.current;
        if (content) {
          content.style.opacity = String(1 - progress);
          content.style.transform = `translateY(${-progress * 50}px)`;
        }
        const vid = videoRef.current;
        if (vid) {
          vid.style.transform = `scale(${1 + progress * 0.12})`;
        }
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [reduced]);

  return (
    <section className="rw-video-hero" aria-label="Intro">
      <div className="rw-vh-media" aria-hidden="true">
        <video
          ref={videoRef}
          autoPlay={!reduced}
          muted
          loop
          playsInline
          preload="auto"
          tabIndex={-1}
        >
          <source src={VIDEO_SRC} type="video/mp4" />
        </video>
        <div className="rw-vh-scrim" />
        <div className="rw-vh-fade" />
      </div>

      <nav className="rw-vh-nav" aria-label="Intro navigation">
        <Link href="/" className="rw-vh-logo">
          RepWorth
        </Link>
        <div className="rw-vh-links">
          <Link href="/features">Features</Link>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/pricing">Pricing</Link>
        </div>
        <button
          type="button"
          className="rw-vh-btn"
          onClick={() => scrollToLandingTarget('rw-cta', !reduced)}
        >
          Get early access
        </button>
      </nav>

      <div className="rw-vh-content" ref={contentRef}>
        <h1 className="rw-vh-title">
          Where every <em>review</em> finds a reply <em>worth posting.</em>
        </h1>
        <p className="rw-vh-sub">
          RepWorth drafts an on-brand reply to every Google review and posts it the
          moment you approve — so every customer feels heard within minutes.
        </p>
        <button
          type="button"
          className="rw-vh-btn rw-vh-cta"
          onClick={() => scrollToLandingTarget('rw-cta', !reduced)}
        >
          Get early access
        </button>
      </div>

      <button
        type="button"
        className="rw-vh-cue"
        onClick={() => scrollToLandingTarget('main-content', !reduced)}
        aria-label="Scroll to content"
      >
        <span className="rw-vh-cue-label">Scroll</span>
        <span className="rw-vh-cue-line" aria-hidden="true" />
      </button>
    </section>
  );
}
