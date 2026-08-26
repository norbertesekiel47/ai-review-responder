'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * The narrow-viewport card carousel, shared by sections 2-4 (fleet, personas,
 * watchdogs).
 *
 * ── Why the EXISTING container becomes the track ──────────────────────────
 * `useCarousel` returns props for the grid element a section already renders
 * (`.rw-lp-personas-list`, `.rw-lp-watch-grid`, `.rw-lp-fleet-tier`) rather
 * than adding a wrapper. A wrapper would become the grid item on desktop and
 * every desktop rule for those containers would have to be re-pointed at it —
 * a rewrite of three layouts to change one. Instead `carousel.css` restyles
 * the same element inside `@media (max-width: 767px)` and desktop never sees a
 * single changed declaration.
 *
 * ── Why `data-carousel` ───────────────────────────────────────────────────
 * The rail rules must beat `.rw-lp-fleet-tier[data-tier='watchdog']`, which is
 * a 0,2,0 selector. `.rw-lp-carousel[data-carousel='true']` matches that
 * weight, and carousel.css is imported after every section file, so it wins on
 * order. Drop the attribute and the fleet's watchdog tier keeps its
 * `flex-direction: column` and the rail silently stops being a rail.
 *
 * ── Why native scrolling, not a transform ─────────────────────────────────
 * The track is a CSS scroll-snap container. Touch momentum, rubber-banding,
 * keyboard scrolling and screen-reader navigation all come from the platform;
 * a transform-driven carousel has to re-implement each one and gets the feel
 * wrong. JS here does exactly two things: report which slide is centred, and
 * scroll to a slide when a dot is pressed.
 *
 * ── Desktop is untouched ──────────────────────────────────────────────────
 * The breakpoint is 767px and it lives in carousel.css ALONE — there is no
 * matching constant here, deliberately: two spellings of one breakpoint drift.
 * Nothing in this file reads the viewport. `overflowing` is what stands in for
 * it, and it is a fact about the track rather than a guess about the screen:
 * on the desktop grid the container never overflows, so the dots are never
 * rendered and the scroll listener never fires. No media-query hook means no
 * hydration branch.
 */

/** Index of the slide whose centre is nearest the track's centre.
 *  Measured with `getBoundingClientRect`, not `offsetLeft`, so the track's own
 *  scroll padding cannot shift the answer by a gutter. */
function activeIndexOf(track: HTMLElement): number {
  const middle = track.getBoundingClientRect().left + track.clientWidth / 2;
  let nearest = 0;
  let shortest = Number.POSITIVE_INFINITY;
  let index = 0;
  for (const slide of track.children) {
    const box = slide.getBoundingClientRect();
    const distance = Math.abs(box.left + box.width / 2 - middle);
    if (distance < shortest) {
      shortest = distance;
      nearest = index;
    }
    index += 1;
  }
  return nearest;
}

/**
 * Whether the slides need more room than one screenful of the track.
 *
 * Measured from the SLIDES, not from `scrollWidth`. A card may paint outside
 * its own box — the future card's glow wash sits at `inset: -0.875rem` — and
 * that decorative bleed lands in `scrollWidth`: the desktop 2x2 reported 570
 * against a 556 client width and looked like a rail that could scroll 14px.
 * `getBoundingClientRect` returns border boxes and ignores pseudo-elements, so
 * the span of first-to-last is the real question: does the content run wider
 * than the visible track?
 *
 * It reads correctly on a GRID too, where first and last are diagonal corners
 * and the span is simply the grid's own width — which never exceeds the track.
 */
function overflows(track: HTMLElement): boolean {
  const first = track.firstElementChild;
  const last = track.lastElementChild;
  if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return false;
  const span = last.getBoundingClientRect().right - first.getBoundingClientRect().left;
  return span - track.clientWidth > 1;
}

/**
 * Scroll offset that puts `slide` at the track's resting start position.
 *
 * The distance between the first slide and the target slide IS the scrollLeft
 * required, because at `scrollLeft: 0` the first slide already sits where a
 * snapped slide belongs. Deriving it this way needs no reading of the track's
 * padding, so it cannot drift when the gutter changes.
 */
function offsetOf(track: HTMLElement, index: number): number | null {
  const slide = track.children[index];
  const first = track.firstElementChild;
  if (!(slide instanceof HTMLElement) || !(first instanceof HTMLElement)) return null;
  return slide.getBoundingClientRect().left - first.getBoundingClientRect().left;
}

export interface Carousel {
  /** Spread onto the section's existing card container. `HTMLElement`, not
   *  `HTMLDivElement`: the future section's card container is a `<ul>`. */
  track: { ref: (el: HTMLElement | null) => void; 'data-carousel': 'true' };
  /** Index of the slide currently centred. */
  active: number;
  /** Scrolls a slide into view. Pass to `CarouselDots.onSelect`. */
  goTo: (index: number) => void;
  /**
   * Whether the track actually has somewhere to scroll. Gate `CarouselDots` on
   * it: on desktop, and in the 700-767px band where the fleet's two watchdog
   * cards already fit, dots would be a control that does nothing when pressed.
   */
  overflowing: boolean;
}

export function useCarousel(): Carousel {
  const trackRef = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    // The observer fires once on `observe()`, so the first reading arrives
    // through the same callback as every later one — no setState in the effect
    // body, and no separate initial-measure branch to keep in step.
    const observer = new ResizeObserver(() => {
      setOverflowing(overflows(track));
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    // One frame per scroll burst. The state update lives in the listener — an
    // external-system callback — never in this effect's body.
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setActive(activeIndexOf(track));
      });
    };
    track.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  const goTo = useCallback(
    (index: number) => {
      const track = trackRef.current;
      // jsdom leaves `Element.scrollTo` undefined; a dot press in a test must
      // be a no-op rather than a crash.
      if (!track || typeof track.scrollTo !== 'function') return;
      const left = offsetOf(track, index);
      if (left === null) return;
      track.scrollTo({ left, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    },
    [prefersReducedMotion],
  );

  const setTrack = useCallback((el: HTMLElement | null) => {
    trackRef.current = el;
  }, []);

  return { track: { ref: setTrack, 'data-carousel': 'true' }, active, goTo, overflowing };
}

export interface CarouselDotsProps {
  /** How many slides the track holds. */
  count: number;
  /** Index reported by `useCarousel`. */
  active: number;
  onSelect: (index: number) => void;
  /** Names the group for screen readers, e.g. "The acting agents". */
  label: string;
  /** Matches the section's temperature: gold acts, teal watches. */
  tone?: 'gold' | 'teal';
}

/**
 * The position indicator. Real buttons, not decoration: they are the only
 * affordance that says how many cards there are before a visitor swipes. The
 * cards themselves stay reachable by scrolling and by tab order, so these add
 * a shortcut rather than gate the content.
 */
export function CarouselDots({ count, active, onSelect, label, tone = 'gold' }: CarouselDotsProps) {
  return (
    <div className="rw-lp-carousel-dots" data-tone={tone} role="group" aria-label={label}>
      {Array.from({ length: count }, (_unused, index) => (
        <button
          key={index}
          type="button"
          className="rw-lp-carousel-dot"
          aria-current={index === active ? 'true' : undefined}
          aria-label={`Card ${index + 1} of ${count}`}
          onClick={() => onSelect(index)}
        >
          <span className="rw-lp-carousel-dot-mark" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
