'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Fragment, useState, useSyncExternalStore } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from '../ambient-motion';
import {
  EYEBROW,
  SCOPE_NOTE_LINES,
  SUBHEAD_LINES,
  TITLE_ACCENT,
  TITLE_LEAD,
  TITLE_PLAIN,
} from './cta-copy';

/**
 * Closing CTA — the night-time bookend to the hero.
 *
 * Same construction as the hero (full-bleed clip, directional scrim, pill CTA)
 * with the copy set LEFT instead of right, so the page opens and closes on
 * mirrored compositions rather than repeating one.
 *
 * ── Composition ───────────────────────────────────────────────────────────
 * Measured on a gridded frame, the RW character sits at x 58-85% of the clip
 * and holds that position for its whole 12s (static camera). The copy column
 * ends at 45%, so the two never meet — the same clean split the hero has, with
 * the sides swapped.
 *
 * That is why THIS clip and not hero3Video.mp4, which frames the character at
 * x 19-37%: with the copy on the left it sat behind the type, and there was no
 * framing fix, because the character is already near that frame's left edge
 * (no crop can add space to its left) and `object-fit: cover` gives zero
 * horizontal travel at viewports wider than 16:9. Do not swap the source back
 * without moving the copy to the right with it.
 *
 * ── Duplication note ──────────────────────────────────────────────────────
 * The backdrop below is deliberately a near-copy of HeroSection's, not a
 * shared component. Extracting one means editing the hero, whose scrim and
 * `object-position` values are measured against its own clip and documented as
 * load-bearing. The safe order is: land this, then unify the two backdrops in
 * a change that does nothing else. If you are here to do that, they differ
 * only in class prefix and asset paths.
 */

/* Transcodes of `hero3reverseVideo.mp4` (27 MB, 18.4 Mbps). The master is NOT
   in the repo: it lives in `~/Developer/startups/RepWorth-media/masters/`,
   because anything under `public/` is uploaded and served on every deploy, and
   a 27 MB file nothing links to is 27 MB of deploy for nothing. Re-transcode
   from there if these ever need regenerating. */
/** 1600px transcode, ~0.5 MB. Desktop / tablet. */
const CTA_VIDEO_WIDE = '/video/ctaVideo-1600.mp4';
/** 960px transcode, ~0.2 MB. Narrow viewports. */
const CTA_VIDEO_NARROW = '/video/ctaVideo-960.mp4';
/** Frame at t=6s, ~0.13 MB. Always rendered. */
const CTA_POSTER = '/video/ctaVideo-poster.jpg';

/** Must stay in lockstep with the `max-width: 900px` breakpoint in cta.css. */
const NARROW_QUERY = '(max-width: 900px)';

const alwaysFalse = () => false;
const alwaysTrue = () => true;
const noopSubscribe = () => () => {};

/** `false` during SSR and hydration, `true` after — lets the backdrop treat
 *  viewport and motion preference as DERIVED state instead of correcting a
 *  server guess with an effect. */
function useHasMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, alwaysTrue, alwaysFalse);
}

/**
 * Poster first, video layered over it once it can actually play.
 *
 * Not `priority` on the image, unlike the hero's: this section is the last on
 * the page and is never the LCP element, so preloading it would compete with
 * the hero for bandwidth on first paint.
 */
function CtaBackdrop() {
  const hasMounted = useHasMounted();
  const prefersReducedMotion = usePrefersReducedMotion();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const [videoReady, setVideoReady] = useState(false);

  const videoSrc =
    !hasMounted || prefersReducedMotion ? null : isNarrow ? CTA_VIDEO_NARROW : CTA_VIDEO_WIDE;

  return (
    <div className="rw-lp-cta-media" aria-hidden="true">
      <Image src={CTA_POSTER} alt="" fill sizes="100vw" className="rw-lp-cta-poster" />
      {videoSrc ? (
        <AmbientVideo
          className="rw-lp-cta-video"
          data-ready={videoReady ? 'true' : 'false'}
          src={videoSrc}
          poster={CTA_POSTER}
          /* `metadata`, not the hero's `auto`: this sits below the fold, so a
             full preload would compete with above-the-fold work for no gain. */
          preload="metadata"
          tabIndex={-1}
          onLoadedData={() => setVideoReady(true)}
          onCanPlay={() => setVideoReady(true)}
        />
      ) : null}
    </div>
  );
}

/** Hand-broken lines. The explicit space between spans is load-bearing: once
 *  the spans collapse to inline below 900px, without it the accessible text
 *  runs words together. */
function BrokenLines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={line}>
          {index > 0 ? ' ' : null}
          <span className="rw-lp-cta-line">{line}</span>
        </Fragment>
      ))}
    </>
  );
}

function ArrowGlyph() {
  return (
    <svg
      className="rw-lp-cta-arrow"
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

interface CtaSectionProps {
  /** Server-authoritative (invariant #13) — `/signup` when self-serve is live,
   *  else the lead-capture route. */
  primaryCtaHref: string;
  /** Server-resolved label. Reflects the trial offer when one is running, so
   *  it must not be replaced with a literal here. */
  primaryCtaLabel: string;
}

export function CtaSection({ primaryCtaHref, primaryCtaLabel }: CtaSectionProps) {
  return (
    <section className="rw-lp-cta" aria-labelledby="rw-lp-cta-title">
      <CtaBackdrop />
      <div className="rw-lp-cta-scrim" aria-hidden="true" />

      <div className="rw-lp-cta-inner">
        <div className="rw-lp-cta-copy">
          <p className="rw-lp-cta-eyebrow">{EYEBROW}</p>

          <h2 className="rw-lp-cta-title" id="rw-lp-cta-title" aria-label={TITLE_PLAIN}>
            <span aria-hidden="true">
              <span className="rw-lp-cta-title-line">{TITLE_LEAD}</span>{' '}
              <span className="rw-lp-cta-title-line rw-lp-cta-title-accent">{TITLE_ACCENT}</span>
            </span>
          </h2>

          <div className="rw-lp-cta-rule" aria-hidden="true" />

          <p className="rw-lp-cta-sub">
            <BrokenLines lines={SUBHEAD_LINES} />
          </p>

          {/* The same filled pill as the hero and the nav. */}
          <Link href={primaryCtaHref} className="rw-lp-cta-action">
            <span className="rw-lp-cta-action-label">{primaryCtaLabel}</span>
            <ArrowGlyph />
          </Link>

          <p className="rw-lp-cta-note">
            <BrokenLines lines={SCOPE_NOTE_LINES} />
          </p>
        </div>
      </div>
    </section>
  );
}
