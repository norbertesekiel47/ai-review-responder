'use client';

import Image from 'next/image';
import Link from 'next/link';
import { m, useScroll, useTransform } from 'motion/react';
import { Fragment, useRef, useState, useSyncExternalStore } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from '../ambient-motion';
import {
  SCOPE_NOTE_LINES,
  SUBHEAD_LINES,
  TITLE_ACCENT,
  TITLE_LEAD,
  TITLE_PLAIN,
} from './hero-copy';

/**
 * Landing hero: the RepWorth character video full-bleed, with the copy set in a
 * right-hand column.
 *
 * Composition note — the video's subject (the RW character on its outcrop) sits
 * at roughly x 15-38% of frame, so the copy is deliberately anchored RIGHT and
 * the scrim gradient enters from the right edge. The character is never
 * covered. Do not move the copy left without re-framing the video, or the
 * headline lands on the character's face.
 *
 * The video keeps its own colour (bright mint / white / gold); only the copy
 * column is darkened. Grading the whole clip down would mute the world the
 * clip was made for.
 */

/** 1600px transcode, ~1.0 MB. Desktop / tablet. */
const HERO_VIDEO_WIDE = '/video/heroVideo-1600.mp4';
/** 960px transcode, ~0.3 MB. Narrow viewports. */
const HERO_VIDEO_NARROW = '/video/heroVideo-960.mp4';
/** First frame, ~0.1 MB. Always rendered — this is the LCP element. */
const HERO_POSTER = '/video/heroVideo-poster.jpg';

/** Must stay in lockstep with the `max-width: 900px` breakpoint in hero.css —
 *  below it the copy drops under the character and the narrow clip is enough. */
const NARROW_QUERY = '(max-width: 900px)';

const alwaysFalse = () => false;
const alwaysTrue = () => true;
const noopSubscribe = () => () => {};

/**
 * `false` during SSR and the hydration pass, `true` after.
 *
 * Lets the backdrop defer every viewport- and preference-dependent decision to
 * the client as DERIVED state, so no effect has to call setState to correct a
 * server guess. Without it the server would render the wide video for
 * everyone, including reduced-motion users, who would then download it before
 * hydration could take it away.
 */
function useHasMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, alwaysTrue, alwaysFalse);
}

interface HeroSectionProps {
  /** Where the primary CTA points. Server-authoritative (invariant #13):
   *  `/signup` when self-serve signup is live, else the lead-capture route. */
  primaryCtaHref: string;
  /** Primary CTA label, reflecting the trial offer when one is live. */
  primaryCtaLabel: string;
}

/**
 * The backdrop: poster first, video layered over it once it can actually play.
 *
 * Three things are deliberate here.
 *
 *   1. The poster is a real `<Image priority>`, so the LCP element is a 0.1 MB
 *      still rather than a video that may never decode. The video fades in on
 *      `canplay` and covers it.
 *   2. The `<video>` is mounted only after mount, so the source can be chosen
 *      from the live viewport and reduced-motion users never download it.
 *   3. Reduced motion means NO video at all, not a paused one — the poster is
 *      the complete experience. The hero reads identically without it.
 */
function HeroBackdrop() {
  const hasMounted = useHasMounted();
  const prefersReducedMotion = usePrefersReducedMotion();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const [videoReady, setVideoReady] = useState(false);

  /**
   * Bookend cinema (owner override of the Linear pass, 2026-08-24): as the
   * hero scrolls out, the film grows to at most 1.045 — a slow push-in that
   * the closing band mirrors in reverse. Reader-driven, not autoplaying, so
   * it sits outside the ambient pause control (WCAG 2.2.2 governs motion that
   * moves on its own; this moves only under the reader's hand) and is skipped
   * under reduced motion. At rest the scale is exactly 1: the state every
   * scrim contrast figure was measured in.
   *
   * The transform lives on the zoom layer INSIDE this section, never on a
   * section wrapper (measurements.md §2, "The zoom layer").
   */
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({
    target: mediaRef,
    offset: ['start start', 'end start'],
  });
  const exitScale = useTransform(scrollYProgress, [0, 1], [1, 1.045]);

  // Derived, never synchronised: the video simply does not exist until the
  // client has told us the viewport and the motion preference.
  const videoSrc =
    !hasMounted || prefersReducedMotion
      ? null
      : isNarrow
        ? HERO_VIDEO_NARROW
        : HERO_VIDEO_WIDE;

  // `videoReady` is intentionally NOT reset when `videoSrc` changes across the
  // breakpoint: React reuses the element, which keeps painting its last frame
  // while the new source loads, so holding it visible avoids a flash to poster.
  return (
    // The scale lives on the inner zoom layer, NOT on this wrapper: a
    // transformed box grows the page's scrollable overflow even when a parent
    // clips its pixels, which put a horizontal scrollbar on the whole page.
    // The wrapper stays untransformed (stable for useScroll's measurements)
    // and its `overflow: hidden` clips the zoom.
    <div ref={mediaRef} className="rw-lp-hero-media" aria-hidden="true">
      <m.div
        className="rw-lp-hero-zoom"
        style={prefersReducedMotion ? undefined : { scale: exitScale }}
      >
        <Image src={HERO_POSTER} alt="" fill priority sizes="100vw" className="rw-lp-hero-poster" />
      {videoSrc ? (
        <AmbientVideo
          className="rw-lp-hero-video"
          data-ready={videoReady ? 'true' : 'false'}
          src={videoSrc}
          poster={HERO_POSTER}
          preload="auto"
          tabIndex={-1}
          onLoadedData={() => setVideoReady(true)}
          onCanPlay={() => setVideoReady(true)}
        />
      ) : null}
      </m.div>
    </div>
  );
}

/**
 * Copy set as hand-broken lines — block at desktop, inline flow below 900px
 * (see `.rw-lp-hero-line`).
 *
 * The explicit space between spans is load-bearing: once the spans collapse to
 * inline on narrow viewports, without it the accessible text runs words
 * together ("one job.Independent").
 */
function BrokenLines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={line}>
          {index > 0 ? ' ' : null}
          <span className="rw-lp-hero-line">{line}</span>
        </Fragment>
      ))}
    </>
  );
}

/** The arrow that trails the primary CTA's label. Inline SVG per brand rules. */
function ArrowGlyph() {
  return (
    <svg
      className="rw-lp-hero-cta-arrow"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 12h15M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Arrival choreography (direction B, 2026-08-24): the copy column enters in
 * five staged beats — title, rule, subhead, CTA, scope note — each a 650ms
 * fade with a 14px rise, 110ms apart. One-time, on load, finite; it is
 * motion/react-driven, so the CSS pause rule (which governs only keyframe
 * animations) cannot freeze it mid-flight. Reduced motion renders the final
 * frame immediately via `initial: false` — same element types both ways, so
 * nothing that ever observes these nodes can capture a stale one (the trap
 * measurements.md records against `Reveal`'s branch-by-type shape).
 *
 * The y-drift transforms sit on the hero's own children, never on an
 * ancestor of the future section's fixed-attachment glow.
 */
function useHeroEntrance() {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (step: number) =>
    prefersReducedMotion
      // Hydration may switch the preference after Motion applied the initial
      // hidden pose. Explicitly resolve that pose when reducing motion.
      ? { initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0 } }
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.65, ease: 'easeOut' as const, delay: 0.15 + step * 0.11 },
        };
}

export function HeroSection({ primaryCtaHref, primaryCtaLabel }: HeroSectionProps) {
  const enter = useHeroEntrance();
  return (
    <section className="rw-lp-hero" aria-labelledby="rw-lp-hero-title">
      <HeroBackdrop />
      <div className="rw-lp-hero-scrim" aria-hidden="true" />

      <div className="rw-lp-hero-inner">
        <div className="rw-lp-hero-copy">
          <m.h1 {...enter(0)} className="rw-lp-hero-title" id="rw-lp-hero-title" aria-label={TITLE_PLAIN}>
            {/* The explicit `{' '}` matter: the lines are `display: block` at
                desktop (where the breaks are hand-set) and `display: inline`
                below 900px, where they need real word gaps to flow. */}
            <span aria-hidden="true">
              <span className="rw-lp-hero-title-line">{TITLE_LEAD}</span>{' '}
              <span className="rw-lp-hero-title-line rw-lp-hero-title-accent">{TITLE_ACCENT}</span>
            </span>
          </m.h1>

          <m.div {...enter(1)} className="rw-lp-hero-rule" aria-hidden="true" />

          <m.p {...enter(2)} className="rw-lp-hero-sub">
            <BrokenLines lines={SUBHEAD_LINES} />
          </m.p>

          {/* One filled pill, the page's primary action. The nav and the
              closing band carry the same control. */}
          {/* A block wrapper, not m.create(Link): the copy column is plain
              block flow, so wrapping the inline-flex pill changes nothing. */}
          <m.div {...enter(3)}>
            <Link href={primaryCtaHref} className="rw-lp-hero-cta">
              <span className="rw-lp-hero-cta-label">{primaryCtaLabel}</span>
              <ArrowGlyph />
            </Link>
          </m.div>

          <m.p {...enter(4)} className="rw-lp-hero-note">
            <BrokenLines lines={SCOPE_NOTE_LINES} />
          </m.p>
        </div>
      </div>
    </section>
  );
}
