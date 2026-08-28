'use client';

import Link from 'next/link';
import type { ReputationSummary } from '@/lib/dashboard/types';
import { computeRepPulse, repPulseNote } from '@/lib/dashboard/rep-pulse';

interface Props {
  summary: ReputationSummary;
}

// r=46 in a 120-viewBox circle → circumference ≈ 289 (pinned in console.css:
// .pulse-val stroke-dasharray + the rw-gauge-sweep keyframe start).
const GAUGE_CIRCUMFERENCE = 289;

/**
 * Rep Pulse — the coined-score card beside the reputation hero. The gauge is
 * hand-rolled SVG with a text equivalent (Console chart rule); the score comes
 * from the transparent formula in src/lib/dashboard/rep-pulse.ts. No score
 * exists while ramping — the card says so instead of inventing one.
 */
export function RepPulseCard({ summary }: Props) {
  const pulse = computeRepPulse(summary);

  if (!pulse) {
    return (
      <section className="card pulse-card" aria-labelledby="pulse-heading">
        <div className="pulse-head">
          <h2 id="pulse-heading" className="pulse-title">Rep Pulse</h2>
          <span className="pulse-beta">Beta</span>
        </div>
        <div className="pulse-empty" role="status">
          <b aria-hidden="true">—</b>
        </div>
        <p className="pulse-note">
          Your Rep Pulse appears after your first weeks of reviews.
        </p>
      </section>
    );
  }

  const offset = GAUGE_CIRCUMFERENCE * (1 - pulse.score / 100);

  return (
    <section className="card pulse-card" aria-labelledby="pulse-heading">
      <div className="pulse-head">
        <h2 id="pulse-heading" className="pulse-title">Rep Pulse</h2>
        <span className="pulse-beta">Beta</span>
      </div>
      <div className="pulse-gauge-wrap">
        <svg
          className="pulse-gauge"
          viewBox="0 0 120 120"
          role="img"
          aria-label={`Rep Pulse score ${pulse.score} of 100 — ${pulse.bandLabel}`}
        >
          <circle className="pulse-track" cx="60" cy="60" r="46" />
          <circle
            className="pulse-val"
            cx="60"
            cy="60"
            r="46"
            style={{ strokeDashoffset: offset }}
          />
        </svg>
        <div className="pulse-num" aria-hidden="true">
          <div>
            <b>{pulse.score}</b>
            <span className={`pulse-band--${pulse.band}`}>{pulse.bandLabel}</span>
          </div>
        </div>
      </div>
      <p className="pulse-note">
        {repPulseNote(pulse)} Rating carries 70%, response rate 30%.
      </p>
      <Link href="/dashboard/analytics" className="pulse-why">
        What moved it?
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </Link>
    </section>
  );
}
