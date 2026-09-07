'use client';

import Image from 'next/image';
import { m, useInView } from 'motion/react';
import { useId, useRef, useState, type CSSProperties } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Staged } from '../staged';
import {
  CLOSING_ACCENT,
  CLOSING_LEAD,
  CLOSING_TAIL,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  HORIZON_LABEL,
  HORIZON_X,
  LEAD_IN,
  LEGEND_HORIZON,
  LEGEND_LABEL,
  LEGEND_NOTE,
  LEGEND_PLANNED,
  LEGEND_SHIPPED,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  STOPS,
  STOPS_LABEL,
  TODAY_LABEL,
  type RoadmapStop,
} from './future-copy';
import { routePath, type RoutePoint } from './future-route';

/**
 * Where RepWorth is going — the route map (2026-09-06 revamp).
 *
 * A survey chart of the product: one road from the run spine through every
 * shipped stop, on into the locked roadmap order, then branching into fog.
 * The chart is a generated ground (`/future/roadmap-ground.jpg`, made against
 * the agent stills so it inherits the world); the road is SVG in the same
 * 1600×900 space; every stop is an HTML button, so the names and the
 * future-tense bodies stay real text — searchable, readable, focusable.
 *
 * ── Honesty devices (all three stay) ──────────────────────────────────────
 *   1. The legend on the chart says "not available yet" about everything past
 *      the lit stops.
 *   2. Every unbuilt stop wears its marker beside its name (Phase n / Later).
 *   3. Unbuilt roads are dashed and dim; lit roads are solid gold. A skim
 *      reads the temperature before a word.
 *
 * ── Motion ────────────────────────────────────────────────────────────────
 * One `useInView` arming signal, like the fleet: the ground fades up, the lit
 * road draws in (motion `pathLength`), the stops rise in travel order, and the
 * dashed roads fade last (a pathLength draw would override their dashes).
 * Lit stops carry a breathing halo — CSS keyframes, so the ambient pause rule
 * covers it. Reduced motion renders the settled frame via `initial={false}`.
 * The old `background-attachment: fixed` glow left with the cards, so this
 * section no longer forbids transforms on its ancestors.
 *
 * The chart is FULL-BLEED (owner direction 2026-09-06): it is a sibling of
 * the content column, not a child, so it runs edge to edge while the header
 * keeps the reading measure. Below 900px it is abandoned for a trail (the
 * fleet does the same at that width): the same stops, in the same order,
 * stacked, every body visible.
 */

const LIT_STOPS = STOPS.filter((stop) => stop.state === 'shipped');
const PLANNED_STOPS = STOPS.filter((stop) => stop.state === 'planned');
const HORIZON_STOPS = STOPS.filter((stop) => stop.state === 'horizon');

const LAST_LIT = LIT_STOPS[LIT_STOPS.length - 1];
const LAST_PLANNED = PLANNED_STOPS[PLANNED_STOPS.length - 1];

const LIT_PATH = routePath(LIT_STOPS);
const PLANNED_PATH = routePath(LAST_LIT ? [LAST_LIT, ...PLANNED_STOPS] : PLANNED_STOPS);

/** After Phase 5 the roadmap "may be re-ordered", so the road forks: one faint
 *  branch from the last planned stop to each horizon stop, bowed a little. */
function branch(from: RoutePoint, to: RoutePoint): string {
  const mid = { x: from.x + (to.x - from.x) * 0.55, y: from.y + (to.y - from.y) * 0.3 };
  return routePath([from, mid, to]);
}
const BRANCH_PATHS = LAST_PLANNED ? HORIZON_STOPS.map((stop) => branch(LAST_PLANNED, stop)) : [];

/** Which side the detail card opens on, and whether it must avoid an edge. */
function cardSide(stop: RoadmapStop): 'left' | 'right' {
  return stop.x > STAGE_WIDTH * 0.62 ? 'left' : 'right';
}
function cardAnchor(stop: RoadmapStop): 'above' | 'below' | 'mid' {
  if (stop.y < STAGE_HEIGHT * 0.34) return 'below';
  if (stop.y > STAGE_HEIGHT * 0.74) return 'above';
  return 'mid';
}

function Stop({
  stop,
  index,
  armed,
  active,
  onActivate,
  onDeactivate,
}: {
  stop: RoadmapStop;
  index: number;
  armed: boolean;
  active: boolean;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const bodyId = useId();
  const style = {
    '--rw-lp-stop-x': `${(stop.x / STAGE_WIDTH) * 100}%`,
    '--rw-lp-stop-y': `${(stop.y / STAGE_HEIGHT) * 100}%`,
    '--rw-lp-landmark-aspect': stop.landmarkAspect ?? 1,
  } as CSSProperties;

  return (
    <m.li
      className="rw-lp-future-stop-item"
      data-state={stop.state}
      data-active={active ? 'true' : 'false'}
      data-side={cardSide(stop)}
      data-anchor={cardAnchor(stop)}
      data-label={stop.label}
      style={style}
      initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
      animate={armed ? { opacity: 1, y: 0 } : undefined}
      transition={
        prefersReducedMotion
          ? { duration: 0 }
          : { duration: 0.55, ease: 'easeOut', delay: 0.35 + index * 0.07 }
      }
    >
      <button
        type="button"
        className="rw-lp-future-stop"
        aria-pressed={active}
        aria-describedby={bodyId}
        onPointerEnter={() => onActivate(stop.id)}
        onPointerLeave={() => onDeactivate(stop.id)}
        onFocus={() => onActivate(stop.id)}
        onBlur={() => onDeactivate(stop.id)}
        onClick={() => (active ? onDeactivate(stop.id) : onActivate(stop.id))}
      >
        {/* The glyph is always rendered: it is the trail's bullet below 900px,
            and the chart's marker for a stop with no landmark cutout. */}
        <span className="rw-lp-future-landmark" aria-hidden="true" data-landmark={stop.landmark ? 'true' : 'false'}>
          {stop.landmark ? (
            <Image
              src={stop.landmark}
              alt=""
              fill
              sizes="(max-width: 900px) 4rem, 9rem"
              /* Served as authored: the cutouts are small WebPs with alpha
                 (7–52K) and a second lossy pass through the optimizer
                 softened their edges at 2×. */
              unoptimized
              className="rw-lp-future-landmark-img"
            />
          ) : null}
          <span className="rw-lp-future-glyph" />
        </span>
        <span className="rw-lp-future-stop-label">
          <span className="rw-lp-future-stop-marker">{stop.marker}</span>
          <span className="rw-lp-future-stop-name">{stop.name}</span>
        </span>
      </button>
      {/* "Today" pins the end of the lit road, above the last shipped stop. */}
      {stop.id === LAST_LIT?.id ? (
        <span className="rw-lp-future-today" aria-hidden="true">
          {TODAY_LABEL}
        </span>
      ) : null}
      {/* The body. On the chart it is the card that opens beside the stop; on
          the trail it is always visible. Referenced by aria-describedby, so a
          screen reader gets it whether or not the card is open. */}
      <div className="rw-lp-future-stop-card" id={bodyId}>
        <span className="rw-lp-future-stop-card-marker">{stop.marker}</span>
        <span className="rw-lp-future-stop-card-name">{stop.name}</span>
        <p className="rw-lp-future-stop-card-body">{stop.body}</p>
      </div>
    </m.li>
  );
}

function Roads({ armed }: { armed: boolean }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const drawn = armed ? { pathLength: 1 } : undefined;
  const drawTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 1.1, ease: 'easeInOut' as const, delay: 0.25 };

  return (
    <svg
      className="rw-lp-future-chart"
      viewBox={`0 0 ${STAGE_WIDTH} ${STAGE_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-armed={armed ? 'true' : 'false'}
    >
      {/* The horizon: where the locked order ends and the fog begins. */}
      <line
        className="rw-lp-future-horizon-line"
        x1={HORIZON_X}
        y1={40}
        x2={HORIZON_X}
        y2={STAGE_HEIGHT - 40}
      />
      {BRANCH_PATHS.map((d) => (
        <path key={d} className="rw-lp-future-road-branch" d={d} />
      ))}
      <path className="rw-lp-future-road-planned" d={PLANNED_PATH} />
      {/* The lit road: a soft wide glow under a thin bright core, both drawn
          in together so the light and the line arrive as one stroke. */}
      <m.path
        className="rw-lp-future-road-glow"
        d={LIT_PATH}
        initial={prefersReducedMotion ? false : { pathLength: 0 }}
        animate={drawn}
        transition={drawTransition}
      />
      <m.path
        className="rw-lp-future-road-lit"
        d={LIT_PATH}
        initial={prefersReducedMotion ? false : { pathLength: 0 }}
        animate={drawn}
        transition={drawTransition}
      />
    </svg>
  );
}

export function FutureSection() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  /* `amount: 'some'`, not a fraction: below 900px the stage is the trail, far
     taller than a phone viewport, and a fraction of it never comes into view.
     The bottom margin holds the arrival until the chart is ~15% up the screen. */
  const armed = useInView(stageRef, { once: true, amount: 'some', margin: '0px 0px -15% 0px' });
  const prefersReducedMotion = usePrefersReducedMotion();
  const [activeId, setActiveId] = useState<string | null>(null);

  const activate = (id: string) => setActiveId(id);
  const deactivate = (id: string) => setActiveId((current) => (current === id ? null : current));

  return (
    <section className="rw-lp-future" aria-labelledby="rw-lp-future-heading">
      <div className="rw-lp-future-inner">
        <div className="rw-lp-future-head">
          <Staged beat={0}>
            <header className="rw-lp-future-intro">
              <p className="rw-lp-future-eyebrow">{EYEBROW}</p>
              <h2 className="rw-lp-future-heading" id="rw-lp-future-heading">
                {HEADING_LEAD}{' '}
                <span className="rw-lp-future-heading-accent">{HEADING_ACCENT}</span>
              </h2>
              <p className="rw-lp-future-lead">{LEAD_IN}</p>
            </header>
          </Staged>

          <Staged beat={2} className="rw-lp-future-closing-slot">
            <figure className="rw-lp-future-closing">
              <blockquote className="rw-lp-future-closing-quote">
                {CLOSING_LEAD}{' '}
                <span className="rw-lp-future-closing-accent">{CLOSING_ACCENT}</span>{' '}
                {CLOSING_TAIL}
              </blockquote>
            </figure>
          </Staged>
        </div>

      </div>

      <div className="rw-lp-future-map" ref={stageRef}>
        {/* The ground — decorative; the road and stops carry the meaning. */}
        <m.div
          className="rw-lp-future-ground"
          aria-hidden="true"
          initial={prefersReducedMotion ? false : { opacity: 0 }}
          animate={armed ? { opacity: 1 } : undefined}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.9, ease: 'easeOut' }}
        >
          <Image
            src="/future/roadmap-ground.jpg"
            alt=""
            fill
            sizes="100vw"
            quality={88}
            className="rw-lp-future-ground-img"
          />
        </m.div>
        <span className="rw-lp-future-fog" aria-hidden="true" />

        <Roads armed={armed} />

        <span
          className="rw-lp-future-horizon-label"
          aria-hidden="true"
          style={{ '--rw-lp-stop-x': `${(HORIZON_X / STAGE_WIDTH) * 100}%` } as CSSProperties}
        >
          {HORIZON_LABEL}
        </span>

        <div className="rw-lp-future-legend">
          <p className="rw-lp-future-legend-label">{LEGEND_LABEL}</p>
          <p className="rw-lp-future-legend-note">{LEGEND_NOTE}</p>
          <ul className="rw-lp-future-legend-keys">
            <li className="rw-lp-future-legend-key" data-state="shipped">
              {LEGEND_SHIPPED}
            </li>
            <li className="rw-lp-future-legend-key" data-state="planned">
              {LEGEND_PLANNED}
            </li>
            <li className="rw-lp-future-legend-key" data-state="horizon">
              {LEGEND_HORIZON}
            </li>
          </ul>
        </div>

        <ol className="rw-lp-future-stops" aria-label={STOPS_LABEL}>
          {STOPS.map((stop, index) => (
            <Stop
              key={stop.id}
              stop={stop}
              index={index}
              armed={armed}
              active={activeId === stop.id}
              onActivate={activate}
              onDeactivate={deactivate}
            />
          ))}
        </ol>
      </div>
    </section>
  );
}
