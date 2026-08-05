'use client';

import Image from 'next/image';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
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
  containerRef: React.RefObject<HTMLDivElement | null>,
  mediaRef: React.RefObject<HTMLDivElement | null>,
  nodeRefs: React.RefObject<Map<string, HTMLElement>>,
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
  registerRef,
}: {
  agent: FleetAgent;
  tier: 'watchdog' | 'persona';
  registerRef: (id: string, el: HTMLElement | null) => void;
}) {
  return (
    <article
      ref={(el) => registerRef(agent.id, el)}
      className="rw-lp-fleet-node"
      data-tier={tier}
      data-status={agent.status}
    >
      <header className="rw-lp-fleet-node-head">
        <h3 className="rw-lp-fleet-node-name">{agent.name}</h3>
        {agent.status === 'next' ? <NextTag /> : null}
      </header>
      <p className="rw-lp-fleet-node-role">{agent.role}</p>
    </article>
  );
}

export function FleetSection({ videoSrc, videoPoster, videoTitle }: FleetSectionProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [playerOpen, setPlayerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<string, HTMLElement>>(new Map());
  const gradientId = useId();

  // Connectors are drawn only in the constellation layout. Below the
  // breakpoint the nodes stack, and lines between stacked cards mean nothing.
  // Phrased as min-width so the SSR fallback (`false`) is the stacked layout —
  // the one that is correct without any measurement having happened yet.
  const constellation = useMediaQuery('(min-width: 901px)');

  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  }, []);

  const allAgents = [...WATCHDOGS, ...PERSONAS];
  const connectors = useConnectorPaths(
    containerRef,
    mediaRef,
    nodeRefs,
    allAgents,
    constellation,
  );

  return (
    <section className="rw-lp-fleet" aria-labelledby="rw-lp-fleet-heading">
      <div className="rw-lp-fleet-field" aria-hidden="true" />

      <div className="rw-lp-fleet-inner">
        <header className="rw-lp-fleet-intro">
          <p className="rw-lp-fleet-eyebrow">{EYEBROW}</p>
          <h2 className="rw-lp-fleet-heading" id="rw-lp-fleet-heading">
            {HEADING_LEAD} <span className="rw-lp-fleet-heading-accent">{HEADING_ACCENT}</span>
          </h2>
          <p className="rw-lp-fleet-lead">{LEAD_IN}</p>
        </header>

        <div className="rw-lp-fleet-stage" ref={containerRef}>
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
            {(constellation ? connectors : []).map((connector) => (
              <g key={connector.id} data-status={connector.status}>
                <path className="rw-lp-fleet-wire" d={connector.d} stroke={`url(#${gradientId})`} />
                <path className="rw-lp-fleet-wire-flow" d={connector.d} />
              </g>
            ))}
          </svg>

          <div className="rw-lp-fleet-tier" data-tier="watchdog">
            {WATCHDOGS.map((agent) => (
              <AgentCard key={agent.id} agent={agent} tier="watchdog" registerRef={registerRef} />
            ))}
          </div>

          <div className="rw-lp-fleet-centre">
            <p className="rw-lp-fleet-pill">
              <span className="rw-lp-fleet-pill-dot" aria-hidden="true" />
              {CENTRE_PILL}
            </p>

            <div className="rw-lp-fleet-media" ref={mediaRef}>
              {videoSrc && videoPoster ? (
                /* A real <button>, not a div with onClick: this opens a modal,
                   so it has to be reachable and operable from the keyboard and
                   announced as a control. The poster is decorative here — the
                   button's own label carries the meaning. */
                <button
                  type="button"
                  className="rw-lp-fleet-play"
                  onClick={() => setPlayerOpen(true)}
                >
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
                  <span className="rw-lp-fleet-play-label">
                    {videoTitle ?? 'Watch the film'}
                  </span>
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
          </div>

          <div className="rw-lp-fleet-tier" data-tier="persona">
            {PERSONAS.map((agent) => (
              <AgentCard key={agent.id} agent={agent} tier="persona" registerRef={registerRef} />
            ))}
          </div>

          {/* Sits BELOW the personas, not under the media card: the gap between
              the card and the persona tier is where the wires fan out, and text
              placed there collides with every one of them. */}
          <p className="rw-lp-fleet-caption">{CENTRE_CAPTION}</p>
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
