'use client';

import Link from 'next/link';
import type { ReputationSummary } from '@/lib/dashboard/types';
import {
  computeRepPulse,
  repPulseBreakdown,
  repPulseNote,
  REP_PULSE_WEIGHTS,
  type RepPulseContribution,
} from '@/lib/dashboard/rep-pulse';
import { InfoTip } from '@/components/ui/InfoTip';

interface Props {
  summary: ReputationSummary;
}

// r=46 in a 120-viewBox circle → circumference ≈ 289 (pinned in console.css:
// .pulse-val stroke-dasharray + the rw-gauge-sweep keyframe start).
const GAUGE_CIRCUMFERENCE = 289;

/**
 * What the coined score IS — the one thing neither state says. "What moved it"
 * and "What will set it" both explain the composition; a name and a Beta chip
 * cannot say that the number runs 0–100 or where its points come from.
 *
 * It sits BESIDE the `<h2>`, never inside it: the section is
 * `aria-labelledby="pulse-heading"`, so a trigger within the heading would
 * become part of the card's accessible name.
 *
 * Weights come from `REP_PULSE_WEIGHTS`, so the copy cannot drift from the
 * arithmetic. It says "up to", because `repPulseScore` renormalises the rating
 * to carry all 100 points whenever the response rate is null — a state the
 * "What moved it" breakdown right below already renders as `… / 100`. An
 * unconditional 70/30 contradicted that breakdown by inches.
 */
function PulseTip() {
  return (
    <InfoTip subject="Rep Pulse">
      A score out of 100, built from the numbers you already see. Your average
      rating sets up to {REP_PULSE_WEIGHTS.rating} of the points and how often
      you reply sets the other {REP_PULSE_WEIGHTS.response}. With no replies to
      measure yet, your rating carries the whole score. &ldquo;What moved
      it&rdquo; below shows which applies.
    </InfoTip>
  );
}

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
          <PulseTip />
          <span className="pulse-beta">Beta</span>
        </div>
        <div className="pulse-empty" role="status">
          <b aria-hidden="true">—</b>
        </div>
        <p className="pulse-note">
          Your Rep Pulse appears after your first weeks of reviews.
        </p>
        {/* The empty state as content, not an absence: the formula is fixed and
            published, so the owner can be told WHAT will set the score without
            being shown a number the ramping rule deliberately withholds. Values
            and points are omitted here on purpose — showing the arithmetic
            would let the score be reconstructed. */}
        <div className="pulse-preview">
          <span className="pulse-preview-label">What will set it</span>
          <ul className="pulse-preview-list">
            <li>
              <span>Your average rating</span>
              <b>{REP_PULSE_WEIGHTS.rating}%</b>
            </li>
            <li>
              <span>How often you reply</span>
              <b>{REP_PULSE_WEIGHTS.response}%</b>
            </li>
          </ul>
        </div>
      </section>
    );
  }

  const breakdown = repPulseBreakdown(summary);

  const offset = GAUGE_CIRCUMFERENCE * (1 - pulse.score / 100);

  return (
    <section className="card pulse-card" aria-labelledby="pulse-heading">
      <div className="pulse-head">
        <h2 id="pulse-heading" className="pulse-title">Rep Pulse</h2>
        <PulseTip />
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
      <p className="pulse-note">{repPulseNote(pulse)}</p>

      {/* "What moved it" answered in place. It used to be a link to another
          page, which asked the owner to leave the number to understand it. */}
      {breakdown && (
        <div className="pulse-breakdown">
          <span className="pulse-breakdown-label">What moved it</span>
          {breakdown.map((part) => (
            <PulsePart key={part.label} part={part} />
          ))}
        </div>
      )}

      <Link href="/dashboard/analytics" className="pulse-why">
        See the full trend
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </Link>
    </section>
  );
}

/** One input's contribution: the value the owner already knows, then the points
 *  it earned of the points it could have. The meter is decorative — the numbers
 *  beside it carry the fact. */
function PulsePart({ part }: { part: RepPulseContribution }) {
  const filled = part.maxPoints === 0 ? 0 : (part.points / part.maxPoints) * 100;
  return (
    <div className="pulse-part">
      <span className="pulse-part-label">{part.label}</span>
      <span className="pulse-part-value">{part.valueLabel}</span>
      <span
        className="pulse-part-meter"
        aria-hidden="true"
        style={{ '--pulse-part-fill': `${filled}%` } as React.CSSProperties}
      />
      <span className="pulse-part-points">
        {part.points}<span className="pulse-part-max">/{part.maxPoints}</span>
      </span>
    </div>
  );
}
