'use client';

import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * Reusable drifting-reviews background.
 *
 * Renders four horizontal rows of glassy review cards that drift in
 * alternating directions. Designed to live behind the white "island"
 * on RepWorth marketing surfaces (Landing, Features, How it works,
 * etc). Pointer-events disabled, decorative only.
 */

const REVIEWS: Array<{ name: string; stars: number; body: string; tone?: '' | 'peach' | 'pink' | 'beige' }> = [
  { name: 'Sarah M.', stars: 5, body: "Best haircut in the city. Maria really listens to what you want.", tone: '' },
  { name: 'David K.', stars: 5, body: "Been coming here for three years. Still the best espresso on the block.", tone: 'peach' },
  { name: 'Linda P.', stars: 4, body: "Lovely atmosphere and the staff remember your name.", tone: 'pink' },
  { name: 'Marcus O.', stars: 5, body: "The pad thai is worth the drive across town. Trust me.", tone: '' },
  { name: 'Emma J.', stars: 5, body: "They fixed my watch that two other shops said was beyond repair.", tone: 'beige' },
  { name: 'Tom R.', stars: 3, body: "Food was good but we waited 45 minutes for our table on a Tuesday.", tone: 'pink' },
  { name: 'Priya S.', stars: 5, body: "Honestly the kindest front desk team. Came in stressed, left calm.", tone: '' },
  { name: 'Ben Z.', stars: 5, body: "My dog actually enjoys going to the vet now. Never thought I'd say that.", tone: 'peach' },
  { name: 'Nadia W.', stars: 4, body: "Great coffee, decent pastries, wifi that actually works.", tone: 'beige' },
  { name: 'James C.', stars: 5, body: "Fixed our plumbing on a Sunday evening. Fair price too.", tone: '' },
  { name: 'Olivia H.', stars: 5, body: "My wedding cake. Everyone still talks about it six months later.", tone: 'pink' },
  { name: 'Kai L.', stars: 4, body: "Knowledgeable staff, good selection. Parking's a bit of a nightmare.", tone: 'peach' },
];

const ROWS = [
  { cls: 'r1', revs: [...REVIEWS, ...REVIEWS].slice(0, 8) },
  { cls: 'r2', revs: [...REVIEWS.slice(3), ...REVIEWS.slice(0, 3)].slice(0, 8) },
  { cls: 'r3', revs: [...REVIEWS.slice(6), ...REVIEWS.slice(0, 6)].slice(0, 8) },
  { cls: 'r4', revs: [...REVIEWS.slice(2), ...REVIEWS.slice(0, 2)].slice(0, 8) },
];

interface MarqueeBackgroundProps {
  /** Multiplier on row drift speed. 1 = default, 0 = paused, 2 = twice as fast. */
  speed?: number;
}

export function MarqueeBackground({ speed = 1 }: MarqueeBackgroundProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  // Freeze the drift when the user prefers reduced motion or the caller pauses
  // it (speed === 0). Setting `animation: none` per row avoids dividing the CSS
  // duration by an epsilon, which would otherwise produce an absurdly long but
  // still-running animation.
  const frozen = prefersReducedMotion || speed <= 0;

  return (
    <div
      className="rw-marquee-field"
      aria-hidden="true"
      style={{ ['--rw-marquee-speed' as string]: String(frozen ? 1 : speed) }}
    >
      {ROWS.map((row) => (
        <div
          key={row.cls}
          className={`rw-marquee-row ${row.cls}`}
          style={frozen ? { animation: 'none' } : undefined}
        >
          {[...row.revs, ...row.revs].map((r, j) => (
            <div key={`${row.cls}-${j}`} className={`rw-bg-review ${r.tone ?? ''}`}>
              <div className="rw-bg-stars">
                {Array.from({ length: 5 }).map((_, i) => (
                  <span key={i}>{i < r.stars ? '★' : '☆'}</span>
                ))}
              </div>
              <div className="rw-bg-name">{r.name}</div>
              <div className="rw-bg-body">{r.body}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
