'use client';

import Image from 'next/image';
import { useState, type CSSProperties } from 'react';
import { PERSONAS } from '../personas/personas-copy';
import { PIVOT_ACCENT, PIVOT_LEAD } from '../problem/problem-copy';
import { VideoLightbox } from './VideoLightbox';

/** Station names, in PERSONAS order. Each pill links to that agent's story. */
const STATION_NAMES = ['The reply desk', 'The lookout', 'The report room', 'The outbox'];

/** Pill anchor points on the courtyard art, as % of its width and height. */
const STATION_POSITIONS = [
  [18, 69],
  [29, 26],
  [67, 66],
  [85, 69],
];

function stationStyle(index: number): CSSProperties {
  const position = STATION_POSITIONS[index] ?? [50, 50];
  return {
    '--rw-lp-station-x': `${position[0]}%`,
    '--rw-lp-station-y': `${position[1]}%`,
  } as CSSProperties;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path d="M9 4.5 24 14 9 23.5Z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * Section 3 — meet the fleet. The 3:1 courtyard scene with four station
 * pills; each pill links to its agent in the personas section. Phones keep the
 * whole scene (numbered pins) and move the pills into a two-column index.
 * The film opens in the accessible lightbox.
 */
export function FleetSection() {
  const [filmOpen, setFilmOpen] = useState(false);
  return (
    <div className="rw-lp-synthesis-loop">
      <section className="rw-lp-syn-l-fleet" aria-labelledby="rw-lp-fleet-heading">
        <div className="rw-lp-syn-l-inner">
          <p className="rw-lp-syn-l-eyebrow">
            {PIVOT_LEAD} {PIVOT_ACCENT}
          </p>
          <div className="rw-lp-syn-l-fleet-heading-row">
            <h2 id="rw-lp-fleet-heading">
              A little fleet.
              <br />
              <em>A whole lot of care.</em>
            </h2>
            <button className="rw-lp-syn-l-film" onClick={() => setFilmOpen(true)}>
              <PlayIcon />
              <span>Watch the RepWorth film</span>
              <small>2m 26s</small>
            </button>
          </div>
          <div className="rw-lp-syn-l-panorama">
            <div className="rw-lp-syn-l-panorama-art">
              <Image
                src="/fleet/courtyard.webp"
                alt="Four sage CRT agents serving a miniature business from a reply counter, lookout balcony, report kiosk and outbound postbox."
                width={2172}
                height={724}
                sizes="100vw"
              />
              {PERSONAS.map((agent, index) => (
                <span className="rw-lp-syn-l-station-pin" key={agent.id} style={stationStyle(index)} aria-hidden="true">
                  0{index + 1}
                </span>
              ))}
            </div>
            {PERSONAS.map((agent, index) => (
              <a key={agent.id} className="rw-lp-syn-l-station" href={`#rw-lp-agent-${agent.id}`} style={stationStyle(index)}>
                <span className="rw-lp-syn-l-station-index">0{index + 1}</span>
                <span>
                  <small>{STATION_NAMES[index]}</small>
                  <strong>{agent.name}</strong>
                </span>
                <span className="rw-lp-syn-l-live">Live</span>
              </a>
            ))}
          </div>
          <p className="rw-lp-syn-l-panorama-note">
            <span>Four acting agents. Two independent watchdogs.</span>
            <span>Live = available today. Every action is recorded.</span>
          </p>
        </div>
        <VideoLightbox
          open={filmOpen}
          onClose={() => setFilmOpen(false)}
          src="/video/repworth-explainer.mp4"
          poster="/video/repworth-explainer-poster.jpg"
          title="Meet the RepWorth fleet"
        />
      </section>
    </div>
  );
}
