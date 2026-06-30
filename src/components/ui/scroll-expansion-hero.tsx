'use client';

import Image from 'next/image';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Scroll-driven media expansion section (adapted from the be-ui
 * scroll-expansion-hero kit).
 *
 * The original kit hijacks the whole window's wheel/touch scroll and locks the
 * page until the media finishes expanding — that can't coexist with the rest of
 * a normal landing page. This version is rewritten to use NATIVE scroll: it
 * renders a tall scroll track and a `position: fixed` stage that is only active
 * while the track crosses the viewport. Scroll position within the track drives
 * the expansion (a card-sized media panel → full-bleed) and then reveals the
 * `children` over it. No scroll-jacking, no preventDefault — it composes.
 *
 * Imperative DOM writes (driven by one rAF-coalesced scroll listener) instead of
 * React state per frame, matching LandingExperience's approach.
 */

interface ScrollExpandSectionProps {
  /** Same-origin video that expands as you scroll (autoplays muted on loop). */
  mediaSrc: string;
  /** Background shown around the panel while it is still expanding. */
  bgImageSrc: string;
  /** Optional video poster. */
  posterSrc?: string;
  /** Accessible label for the section landmark. */
  label?: string;
  /** Revealed over the fully-expanded media (e.g. the feature cards). */
  children?: ReactNode;
}

export function ScrollExpandSection({
  mediaSrc,
  bgImageSrc,
  posterSrc,
  label = 'Featured',
  children,
}: ScrollExpandSectionProps) {
  const trackRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = true;
    }

    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    let playing = false;
    let frame = 0;

    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const track = trackRef.current;
        const stage = stageRef.current;
        const panel = panelRef.current;
        if (!track || !stage || !panel) return;

        const rect = track.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        const total = Math.max(1, rect.height - vh);
        const progress = clamp(-rect.top / total);

        // Active (pinned + opaque) only while the track fully spans the viewport.
        const active = rect.top <= 0 && rect.bottom >= vh;
        // Painted while the track is anywhere near the viewport (so it can fade).
        const near = rect.top < vh && rect.bottom > 0;
        stage.style.visibility = near ? 'visible' : 'hidden';
        stage.style.opacity = active ? '1' : '0';
        stage.style.pointerEvents = active ? 'auto' : 'none';

        // Pause the clip when the section isn't on screen.
        const v = videoRef.current;
        if (v) {
          if (near && !playing) {
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
            playing = true;
          } else if (!near && playing) {
            v.pause();
            playing = false;
          }
        }

        // Expansion completes in the first ~55% of the track.
        const e = clamp(progress / 0.55);
        panel.style.width = `${44 + e * 56}vw`;
        panel.style.height = `${58 + e * 42}vh`;
        panel.style.borderRadius = `${24 * (1 - e)}px`;
        panel.style.boxShadow = e >= 1 ? 'none' : '0 30px 80px rgba(42, 42, 42, 0.35)';

        // Reveal the children once the media is (nearly) full-bleed.
        const cards = cardsRef.current;
        if (cards) {
          const c = clamp((progress - 0.62) / 0.16);
          cards.style.opacity = String(c);
          cards.style.transform = `translateY(${(1 - c) * 28}px)`;
          cards.style.pointerEvents = c > 0.5 ? 'auto' : 'none';
          // Keep the off-screen cards out of the tab order / a11y tree.
          cards.inert = c <= 0.5;
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
    <section ref={trackRef} className="rw-le-expand-track" aria-label={label}>
      <div ref={stageRef} className="rw-le-expand-stage">
        <div className="rw-le-expand-bg" aria-hidden="true">
          <Image src={bgImageSrc} alt="" fill sizes="100vw" style={{ objectFit: 'cover' }} />
        </div>
        <div ref={panelRef} className="rw-le-expand-panel" aria-hidden="true">
          <video
            ref={videoRef}
            src={mediaSrc}
            poster={posterSrc}
            muted
            loop
            playsInline
            preload="auto"
            tabIndex={-1}
          />
        </div>
        {/* Revealed over the fully-expanded media, pinned with the stage. */}
        <div ref={cardsRef} className="rw-le-expand-cards">
          {children}
        </div>
      </div>
    </section>
  );
}
