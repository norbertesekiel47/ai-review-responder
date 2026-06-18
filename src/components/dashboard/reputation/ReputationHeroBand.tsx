'use client';

import type { ReputationDelta, ReputationSummary } from '@/lib/dashboard/types';

interface Props {
  summary: ReputationSummary;
}

// Full-width reputation/ROI hero — the single dominant zone of the dashboard.
// Three honest, unit-correct stats; the star rating is the visual anchor and is
// framed as "your reputation" (RepWorth controls responses, not star ratings,
// so the copy never implies it caused star movement). No sparklines.
//
// Two render modes, fixed zone order either way:
//   • Ramping (location younger than the trust threshold): compact — current
//     values only, no delta arrows, warm baseline copy. The prior-window
//     baseline isn't trustworthy yet, so we don't show deltas at all.
//   • Mature: each stat shows its typed delta vs last 30 days; an individual
//     arrow is hidden entirely when that metric's prior sample is zero.
//
// Delta arrows use ▲/▼ glyphs (not Lucide) to match the existing dashboard
// charts (VelocityCard) — this authenticated surface has no Lucide dependency.
export function ReputationHeroBand({ summary }: Props) {
  const { averageStarRating, responseRate, timeSavedMinutes, ramping } = summary;

  return (
    <section className="rep-hero" aria-label="Your reputation at a glance">
      <HeroStat
        anchor
        label="Your reputation"
        sub="average star rating"
        value={formatStar(averageStarRating.value)}
        metric={averageStarRating}
        deltaUnit="pts"
        deltaDecimals={1}
        ramping={ramping}
      />
      <HeroStat
        label="Response rate"
        sub="reviews you've replied to"
        value={responseRate.value == null ? '—' : `${responseRate.value}%`}
        metric={responseRate}
        deltaUnit="pts"
        deltaDecimals={0}
        ramping={ramping}
      />
      <HeroStat
        label="Time saved"
        sub="drafted for you"
        value={formatDuration(timeSavedMinutes.value)}
        metric={timeSavedMinutes}
        deltaUnit="time"
        deltaDecimals={0}
        ramping={ramping}
      />
      {ramping && (
        <p className="rep-hero-baseline">
          Still building your baseline — trends appear after a few weeks.
        </p>
      )}
    </section>
  );
}

function HeroStat({
  anchor = false,
  label,
  sub,
  value,
  metric,
  deltaUnit,
  deltaDecimals,
  ramping,
}: {
  anchor?: boolean;
  label: string;
  sub: string;
  value: string;
  metric: ReputationDelta<number | null>;
  deltaUnit: 'pts' | 'time';
  deltaDecimals: number;
  ramping: boolean;
}) {
  return (
    <div className={`rep-stat ${anchor ? 'rep-stat--anchor' : ''}`}>
      <div className="rep-stat-label">{label}</div>
      <div className="rep-stat-value">{value}</div>
      <div className="rep-stat-sub">{sub}</div>
      {!ramping && <DeltaRow metric={metric} unit={deltaUnit} decimals={deltaDecimals} />}
    </div>
  );
}

function DeltaRow({
  metric,
  unit,
  decimals,
}: {
  metric: ReputationDelta<number | null>;
  unit: 'pts' | 'time';
  decimals: number;
}) {
  // Per-metric suppression: hide the arrow entirely (not greyed) when there is
  // no prior-window sample to compare against. The dash is a decorative
  // placeholder — there is nothing to compare, so AT skips it (aria-hidden).
  if (metric.delta === null) {
    return <div className="rep-stat-delta rep-stat-delta--none" aria-hidden="true">—</div>;
  }
  if (metric.delta === 0) {
    return (
      <div className="rep-stat-delta rep-stat-delta--flat">
        no change <span className="rep-stat-delta-cmp">vs last 30d</span>
      </div>
    );
  }
  const up = metric.delta > 0;
  const magnitude = formatDeltaMagnitude(Math.abs(metric.delta), unit, decimals);
  return (
    <div className={`rep-stat-delta ${up ? 'rep-stat-delta--up' : 'rep-stat-delta--down'}`}>
      {/* Arrow is decorative; direction is carried for AT by the sr-only word,
          since colour + glyph alone don't convey up/down to screen readers. */}
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'up' : 'down'}</span>
      {magnitude}
      <span className="rep-stat-delta-cmp">vs last 30d</span>
    </div>
  );
}

function formatStar(value: number | null): string {
  return value == null ? '—' : value.toFixed(1);
}

function formatDeltaMagnitude(abs: number, unit: 'pts' | 'time', decimals: number): string {
  if (unit === 'time') return formatDurationDelta(abs);
  const n = decimals > 0 ? abs.toFixed(decimals) : String(Math.round(abs));
  return `${n} pts`;
}

/** Hero value for time saved (minutes → "Xh Ym" / "Xh" / "Y min"). */
function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

/** Delta value for time saved — minutes under an hour, else hours to 1 decimal. */
function formatDurationDelta(absMinutes: number): string {
  if (absMinutes < 60) return `${Math.round(absMinutes)} min`;
  const hours = absMinutes / 60;
  return `${hours.toFixed(1)}h`;
}
