'use client';

import Image from 'next/image';
import { m, useInView } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Staged } from '../staged';
import { VideoLightbox } from './VideoLightbox';
import {
  CENTRE_CAPTION,
  CENTRE_LABEL,
  CENTRE_PILL,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  LEAD_IN,
  NEXT_TAG,
  PERSONAS,
  WATCHDOGS,
  type FleetAgent,
} from './fleet-copy';

/**
 * The fleet constellation: a central media node with the named agents orbiting
 * it, joined by SVG bezier connectors.
 *
 * Two structural decisions worth keeping:
 *
 *   1. Watchdogs render ABOVE the centre and personas BELOW. That is not
 *      arbitrary prettiness — it draws the reference doc's §3.5 metaphor, an
 *      oversight layer sitting over an action layer. Flattening them into one
 *      ring loses the only thing the diagram is arguing.
 *   2. Connectors are MEASURED at runtime rather than hand-authored in a fixed
 *      viewBox. Node positions come from flex/grid and move with the viewport,
 *      so hard-coded path coordinates would drift at every width. See
 *      `useConnectorPaths`.
 *
 * ── The living diagram (2026-08-24 revamp) ────────────────────────────────
 * The diagram assembles when it arrives: live wires DRAW themselves in
 * (motion `pathLength`, staggered), the nodes and centre fade up, the flow
 * current starts once the wires exist, and hovering a node brightens its own
 * wire — the diagram behaves like the system it describes. The wire layer is
 * `FleetWires`, the media hub `FleetCentre`; `FleetSection` only composes.
 *
 * Motion rule for THIS section: the nodes and the media card are MEASURED
 * (`getBoundingClientRect`, which includes transforms), and the observer
 * only re-fires on size change — an entrance TRANSFORM on a measured element
 * would bake its mid-flight position into the wire endpoints. So every
 * measured element enters by OPACITY ONLY (`armedFadeProps`); only the
 * unmeasured intro rises.
 *
 * Below 900px the constellation is abandoned entirely for a stacked list — a
 * six-node radial diagram is illegible at phone widths, and faking it with a
 * squashed SVG is worse than not drawing it.
 */

interface FleetSectionProps {
  /**
   * Optional source for the central media node. When present the centre
   * becomes a CLICK-TO-OPEN poster rather than an inline autoplaying loop:
   * this slot holds the narrated explainer, which has audio and runs 2m26s, so
   * playing it unbidden behind the diagram would be both loud and wasteful.
   * The file is only fetched once a visitor asks for it.
   */
  videoSrc?: string;
  /** Still shown in the centre before the video is opened. Required with
   *  `videoSrc` — without it the centre would open on an empty black box. */
  videoPoster?: string;
  /** Accessible name for the player dialog and the button that opens it. */
  videoTitle?: string;
}

interface Connector {
  id: string;
  d: string;
  status: FleetAgent['status'];
}

/** One stable identity for the full roster. Building this inline in the
 *  component recreated the array every render, which recreated `measure`
 *  (it depends on `agents`), which re-ran the observer effect — a
 *  re-observe/re-measure loop the async ResizeObserver merely disguised.
 *  A module constant ends the cycle at the root. */
const ALL_AGENTS: readonly FleetAgent[] = [...WATCHDOGS, ...PERSONAS];

/** The assembly's ONE fade contract: opacity only (measured elements — see
 *  the section comment), gated on the arming signal, settled instantly under
 *  reduced motion. Every fading element consumes this so none can drift into
 *  a transform. */
function armedFadeProps(prefersReducedMotion: boolean, armed: boolean, delay: number) {
  return {
    initial: prefersReducedMotion ? (false as const) : { opacity: 0 },
    animate: armed ? { opacity: 1 } : undefined,
    transition: prefersReducedMotion
      ? { duration: 0 }
      : { duration: 0.6, ease: 'easeOut' as const, delay },
  };
}

/**
 * Measures where each agent node actually sits and returns the bezier paths
 * joining them to the centre.
 *
 * The ResizeObserver is the whole mechanism, not a fallback: it fires once on
 * `observe()` with the initial size, so the first measurement arrives through
 * the same path as every later one. That also keeps the state update inside an
 * external-system callback rather than the effect body.
 */
function useConnectorPaths(
  containerRef: RefObject<HTMLDivElement | null>,
  mediaRef: RefObject<HTMLDivElement | null>,
  nodeRefs: RefObject<Map<string, HTMLElement>>,
  agents: readonly FleetAgent[],
  enabled: boolean,
) {
  const [connectors, setConnectors] = useState<Connector[]>([]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const media = mediaRef.current;
    if (!container || !media) return;

    const box = container.getBoundingClientRect();
    if (box.width === 0) return;

    // Wires terminate on the media card's EDGE, never at its centre. Running
    // them to the middle draws an X straight through the video: the card is
    // translucent glass, so anything behind it shows through.
    const mediaBox = media.getBoundingClientRect();
    const mx = mediaBox.left + mediaBox.width / 2 - box.left;
    const topEdge = mediaBox.top - box.top;
    const bottomEdge = mediaBox.bottom - box.top;

    const next: Connector[] = [];
    for (const agent of agents) {
      const el = nodeRefs.current?.get(agent.id);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const above = b.top < mediaBox.top;
      const sx = b.left + b.width / 2 - box.left;
      // Leave from the node's edge facing the card, not its middle, so the
      // line emerges from the card rather than out of its text.
      const sy = (above ? b.bottom : b.top) - box.top;
      const ey = above ? topEdge : bottomEdge;
      // Land slightly off-centre, keeping each wire's own direction, so the
      // set reads as a fan converging rather than as spokes on a hub.
      const ex = mx + (sx - mx) * 0.16;
      const midY = (sy + ey) / 2;
      next.push({
        id: agent.id,
        status: agent.status,
        d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${sx.toFixed(1)} ${midY.toFixed(1)}, ${ex.toFixed(1)} ${midY.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`,
      });
    }
    setConnectors(next);
  }, [containerRef, mediaRef, nodeRefs, agents]);

  useEffect(() => {
    // No clearing of state here when disabled — that would be a setState in an
    // effect body. Stale paths simply go unrendered; the caller gates on the
    // same `enabled` flag.
    if (!enabled) return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const media = mediaRef.current;
    if (media) observer.observe(media);
    for (const el of nodeRefs.current?.values() ?? []) observer.observe(el);

    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [enabled, measure, containerRef, mediaRef, nodeRefs]);

  return connectors;
}

function NextTag() {
  return <span className="rw-lp-fleet-tag">{NEXT_TAG}</span>;
}

function AgentCard({
  agent,
  tier,
  entranceDelay,
  armed,
  registerRef,
  onHot,
}: {
  agent: FleetAgent;
  tier: 'watchdog' | 'persona';
  /** Seconds. The dock order: watchdogs, centre, then personas. */
  entranceDelay: number;
  armed: boolean;
  registerRef: (id: string, el: HTMLElement | null) => void;
  onHot: (id: string | null) => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <m.article
      ref={(el: HTMLElement | null) => registerRef(agent.id, el)}
      className="rw-lp-fleet-node"
      data-tier={tier}
      data-status={agent.status}
      {...armedFadeProps(prefersReducedMotion, armed, entranceDelay)}
      onPointerEnter={() => onHot(agent.id)}
      onPointerLeave={() => onHot(null)}
    >
      <header className="rw-lp-fleet-node-head">
        <h3 className="rw-lp-fleet-node-name">{agent.name}</h3>
        {agent.status === 'next' ? <NextTag /> : null}
      </header>
      <p className="rw-lp-fleet-node-role">{agent.role}</p>
    </m.article>
  );
}

/**
 * The connector layer. The draw-in is motion-driven and finite
 * (pause-rule-immune); `pathLength` normalises every bezier to 0..1, so one
 * duration fits all lengths. The dashed NEXT connector keeps its stylesheet
 * dash geometry and simply fades in via the `data-armed` transitions in
 * fleet.css (a pathLength draw would override its dashes).
 */
function FleetWires({
  connectors,
  armed,
  hotId,
}: {
  connectors: Connector[];
  armed: boolean;
  hotId: string | null;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const gradientId = useId();
  return (
    <svg
      className="rw-lp-fleet-wires"
      data-still={prefersReducedMotion ? 'true' : 'false'}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rw-lp-fleet-wire-bright)" />
          <stop offset="100%" stopColor="var(--rw-lp-fleet-wire-dim)" />
        </linearGradient>
      </defs>
      {connectors.map((connector, index) => (
        <g
          key={connector.id}
          data-status={connector.status}
          data-hot={hotId === connector.id ? 'true' : 'false'}
        >
          {connector.status === 'live' ? (
            <m.path
              className="rw-lp-fleet-wire"
              d={connector.d}
              stroke={`url(#${gradientId})`}
              initial={prefersReducedMotion ? false : { pathLength: 0 }}
              animate={armed ? { pathLength: 1 } : undefined}
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : { duration: 0.9, ease: 'easeInOut', delay: 0.2 + index * 0.09 }
              }
            />
          ) : (
            <path className="rw-lp-fleet-wire" d={connector.d} stroke={`url(#${gradientId})`} />
          )}
          <path className="rw-lp-fleet-wire-flow" d={connector.d} />
        </g>
      ))}
    </svg>
  );
}

/**
 * The media hub. Opacity only — the media card inside is measured (see the
 * section comment). A real <button>, not a div with onClick: it opens a
 * modal, so it has to be reachable and operable from the keyboard and
 * announced as a control. The poster is decorative — the button's own label
 * carries the meaning.
 */
function FleetCentre({
  videoSrc,
  videoPoster,
  videoTitle,
  armed,
  mediaRef,
  onOpen,
}: FleetSectionProps & {
  armed: boolean;
  mediaRef: RefObject<HTMLDivElement | null>;
  onOpen: () => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    <m.div className="rw-lp-fleet-centre" {...armedFadeProps(prefersReducedMotion, armed, 0.25)}>
      <p className="rw-lp-fleet-pill">
        <span className="rw-lp-fleet-pill-dot" aria-hidden="true" />
        {CENTRE_PILL}
      </p>

      <div className="rw-lp-fleet-media" ref={mediaRef}>
        {videoSrc && videoPoster ? (
          <button type="button" className="rw-lp-fleet-play" onClick={onOpen}>
            <Image
              src={videoPoster}
              alt=""
              fill
              sizes="(max-width: 900px) 90vw, 40rem"
              className="rw-lp-fleet-play-poster"
            />
            <span className="rw-lp-fleet-play-ring" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" focusable="false">
                <path d="M9 7.5v9l7.5-4.5L9 7.5z" fill="currentColor" />
              </svg>
            </span>
            <span className="rw-lp-fleet-play-label">{videoTitle ?? 'Watch the film'}</span>
          </button>
        ) : (
          /* Placeholder. Pass `videoSrc` + `videoPoster` to swap it out. */
          <div className="rw-lp-fleet-placeholder">
            <span className="rw-lp-fleet-placeholder-ratio">16 : 9</span>
            <span className="rw-lp-fleet-placeholder-hint">Video</span>
          </div>
        )}
        <p className="rw-lp-fleet-media-label">{CENTRE_LABEL}</p>
      </div>
    </m.div>
  );
}

export function FleetSection({ videoSrc, videoPoster, videoTitle }: FleetSectionProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [playerOpen, setPlayerOpen] = useState(false);
  const [hotId, setHotId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());

  /* One arming signal for the whole assembly, so the wires, nodes and centre
     choreograph as a single event rather than six independent fades. */
  const armed = useInView(containerRef, { once: true, amount: 0.2 });

  // Connectors are drawn only in the constellation layout. Below the
  // breakpoint the nodes stack, and lines between stacked cards mean nothing.
  // Phrased as min-width so the SSR fallback (`false`) is the stacked layout —
  // the one that is correct without any measurement having happened yet.
  const constellation = useMediaQuery('(min-width: 901px)');

  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  const connectors = useConnectorPaths(
    containerRef,
    mediaRef,
    nodeRefs,
    ALL_AGENTS,
    constellation,
  );

  return (
    <section className="rw-lp-fleet" aria-labelledby="rw-lp-fleet-heading">
      <div className="rw-lp-fleet-field" aria-hidden="true" />

      <div className="rw-lp-fleet-inner">
        <Staged beat={0}>
          <header className="rw-lp-fleet-intro">
            <p className="rw-lp-fleet-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-fleet-heading" id="rw-lp-fleet-heading">
              {HEADING_LEAD} <span className="rw-lp-fleet-heading-accent">{HEADING_ACCENT}</span>
            </h2>
            <p className="rw-lp-fleet-lead">{LEAD_IN}</p>
          </header>
        </Staged>

        <div
          className="rw-lp-fleet-stage"
          ref={containerRef}
          data-armed={armed ? 'true' : 'false'}
        >
          <FleetWires
            connectors={constellation ? connectors : []}
            armed={armed}
            hotId={hotId}
          />

          <div className="rw-lp-fleet-tier" data-tier="watchdog">
            {WATCHDOGS.map((agent, index) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                tier="watchdog"
                entranceDelay={index * 0.11}
                armed={armed}
                registerRef={registerRef}
                onHot={setHotId}
              />
            ))}
          </div>

          <FleetCentre
            videoSrc={videoSrc}
            videoPoster={videoPoster}
            videoTitle={videoTitle}
            armed={armed}
            mediaRef={mediaRef}
            onOpen={() => setPlayerOpen(true)}
          />

          <div className="rw-lp-fleet-tier" data-tier="persona">
            {PERSONAS.map((agent, index) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                tier="persona"
                entranceDelay={0.35 + index * 0.11}
                armed={armed}
                registerRef={registerRef}
                onHot={setHotId}
              />
            ))}
          </div>

          {/* Sits BELOW the personas, not under the media card: the gap between
              the card and the persona tier is where the wires fan out, and text
              placed there collides with every one of them. Kept a direct child
              (its mobile `order` must stay on the grid item), so it is an
              `m.p` rather than a `Staged` wrapper. */}
          <m.p
            className="rw-lp-fleet-caption"
            {...armedFadeProps(prefersReducedMotion, armed, 0.9)}
          >
            {CENTRE_CAPTION}
          </m.p>
        </div>
      </div>

      {/* Rendered outside the diagram so the dialog's stacking context is not
          the constellation's — the SVG connector layer and the node z-indexes
          would otherwise sit above a modal that is supposed to cover them. */}
      {videoSrc && videoPoster ? (
        <VideoLightbox
          open={playerOpen}
          onClose={() => setPlayerOpen(false)}
          src={videoSrc}
          poster={videoPoster}
          title={videoTitle ?? 'RepWorth film'}
        />
      ) : null}
    </section>
  );
}
