'use client';

import Image from 'next/image';
import { useCallback, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from './ambient-motion';

/**
 * An agent card that shows its animated avatar on the front and its duties on
 * the back.
 *
 * ── Why this is a <button> ────────────────────────────────────────────────
 * A hover-only flip hides the duties from everyone who cannot hover: every
 * touch device, and every keyboard user. Making the card a real button gives
 * all three input methods the same access —
 *
 *   pointer   :hover flips it
 *   touch     click toggles `flipped` (no hover state exists to strand it)
 *   keyboard  :focus-visible flips it, Enter/Space toggles
 *
 * ── Screen readers ────────────────────────────────────────────────────────
 * Both faces stay in the DOM and neither is `aria-hidden`. The flip is purely
 * visual, so a screen reader reads name then duties in order and never has to
 * discover an interaction to reach the content. Do NOT `aria-hidden` the back
 * face to "fix" duplicate reading — that hides the duties entirely from the
 * users least able to get at them.
 *
 * ── Reduced motion ────────────────────────────────────────────────────────
 * A 3D rotation is exactly the kind of movement `prefers-reduced-motion` is
 * meant to suppress, so that branch cross-fades instead (see the media query
 * in agent-flip-card.css). It also drops the video entirely and shows the
 * still poster, so the card never animates at all.
 */

export interface AgentFlipCardProps {
  name: string;
  /** One-line characterisation, shown on the front under the avatar. */
  tagline: string;
  /** What the agent does — the back of the card. */
  duties: string;
  /** A short, silent, looping avatar clip. */
  videoSrc: string;
  /** The still this clip was generated from. Also the video's poster. */
  posterSrc: string;
  /** Chip text, e.g. the publish scope or the governing rule. */
  chip?: string;
  /** Drives the chip's colour. */
  chipTone?: 'gold' | 'teal';
  /** `next` renders the roadmap treatment (§3.2 — an unshipped agent must not
   *  share a shipped agent's styling). */
  status?: 'live' | 'next';
  /** Tag shown when `status` is `next`. */
  statusTag?: string;
  /** `watchdog` switches the card to the cooler oversight palette. */
  tier?: 'persona' | 'watchdog';
}

export function AgentFlipCard({
  name,
  tagline,
  duties,
  videoSrc,
  posterSrc,
  chip,
  chipTone = 'gold',
  status = 'live',
  statusTag,
  tier = 'persona',
}: AgentFlipCardProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [flipped, setFlipped] = useState(false);

  const toggle = useCallback(() => setFlipped((v) => !v), []);

  return (
    <button
      type="button"
      className="rw-lp-flip"
      data-flipped={flipped ? 'true' : 'false'}
      data-status={status}
      data-tier={tier}
      aria-pressed={flipped}
      onClick={toggle}
    >
      <span className="rw-lp-flip-inner">
        <span className="rw-lp-flip-face rw-lp-flip-front rw-lp-glass">
          {/* `aria-hidden` on the WRAPPER, not on the video, so it covers the
              reduced-motion branch (a still <Image>) with the same declaration.
              The avatar carries no information the card does not already state
              in text — the name and the duties are both real content beside it
              — so it is decoration, and a screen reader should not stop here. */}
          <span className="rw-lp-flip-media" aria-hidden="true">
            {prefersReducedMotion ? (
              <Image
                src={posterSrc}
                alt=""
                fill
                sizes="(max-width: 560px) 100vw, (max-width: 1100px) 50vw, 25vw"
                className="rw-lp-flip-video"
              />
            ) : (
              <AmbientVideo
                className="rw-lp-flip-video"
                src={videoSrc}
                poster={posterSrc}
                preload="none"
                tabIndex={-1}
              />
            )}
          </span>

          <span className="rw-lp-flip-name-line">
            <span className="rw-lp-flip-name">{name}</span>
            {status === 'next' && statusTag ? (
              <span className="rw-lp-flip-tag">{statusTag}</span>
            ) : null}
          </span>
          <span className="rw-lp-flip-tagline">{tagline}</span>
        </span>

        <span className="rw-lp-flip-face rw-lp-flip-back rw-lp-glass">
          <span className="rw-lp-flip-back-name">{name}</span>
          <span className="rw-lp-flip-duties">{duties}</span>
          {chip ? (
            <span className="rw-lp-flip-chip" data-tone={chipTone}>
              <span className="rw-lp-flip-chip-mark" aria-hidden="true" />
              {chip}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
