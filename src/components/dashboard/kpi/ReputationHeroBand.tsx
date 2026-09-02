'use client';

import type { ReputationSummary } from '@/lib/dashboard/types';
import { Icon } from '@/components/dashboard/shell/Icon';
import { RESPONSE_RATE_PERIOD_CONTEXT } from '@/components/dashboard/kpi/response-rate-copy';
import { computeHeroHeadline } from '@/components/dashboard/kpi/hero-headline';
import { starTrendPoints, starTrendPlot, trendSpanLabel } from '@/components/dashboard/charts/star-trend-plot';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';

interface Props {
  summary: ReputationSummary;
  /** Lifetime reassurance figures (from valueSummary). */
  lifetimeReviewsHandled: number;
  lifetimeTimeSavedMinutes: number;
  /** Whether Google is connected (drives the header pill). */
  connected: boolean;
  /** Compact 8-week trend inside the hero. Glance dashboard only — the
   *  analytics page renders the full ReputationTrendChart beside this band,
   *  and the same series twice on one screen is noise. */
  miniTrend?: boolean;
}

function DeltaArrow({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M5 12l7 7 7-7" />}
    </svg>
  );
}

/** A windowed delta pill, suppressed when null (no prior sample / ramping). */
function Delta({ value, unit, decimals = 0 }: { value: number | null; unit: string; decimals?: number }) {
  if (value == null || value === 0) {
    if (value === 0) {
      return <span className="rep-delta flat">no change {unit}</span>;
    }
    return null;
  }
  const up = value > 0;
  const magnitude = Math.abs(value).toFixed(decimals);
  return (
    <span className={`rep-delta ${up ? 'up' : 'down'}`}>
      <DeltaArrow up={up} />
      {up ? '+' : '−'}{magnitude} {unit}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  const filled = Math.round(rating);
  return (
    <span className="rep-stat-stars" aria-hidden="true">
      {'★'.repeat(Math.max(0, Math.min(5, filled)))}
      {'☆'.repeat(Math.max(0, 5 - filled))}
    </span>
  );
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  if (hours >= 10) return String(Math.round(hours));
  return (Math.round(hours * 10) / 10).toString();
}

// Mini-trend plot geometry (real pixels; viewBox width = measured width).
const MINI_H = 72;
const MINI_TOP = 8;
const MINI_BOTTOM = 62;
const MINI_LEFT = 4;
const MINI_RIGHT = 34; // room for the star labels on the right edge

/**
 * Compact star-equivalent trend inside the hero (span follows the period) — the same REAL series
 * the analytics page charts (never synthesized). Hidden entirely below two
 * plotted weeks: a one-point "trend" is not evidence.
 */
function HeroMiniTrend({ trend }: { trend: ReputationSummary['trend'] }) {
  const { ref, width } = useMeasuredSvg();

  const points = starTrendPoints(trend);

  if (points.length < 2) return null;

  const { x, y, path, gridStars } = starTrendPlot(points, trend.length, width, {
    top: MINI_TOP,
    bottom: MINI_BOTTOM,
    left: MINI_LEFT,
    right: MINI_RIGHT,
  });

  const last = points[points.length - 1]!;
  const first = points[0]!;

  return (
    <div className="rep-mini-trend">
      <div className="rep-mini-trend-head">
        <span>Reputation trend</span>
        <span>star-equivalent · {trendSpanLabel(trend.length)}</span>
      </div>
      <div ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${MINI_H}`}
          role="img"
          aria-label={`Reputation trend across ${points.length} weeks: from ${first.star.toFixed(1)} to ${last.star.toFixed(1)} star-equivalent`}
        >
          {gridStars.map((star) => (
            <g key={star}>
              <line className="mini-grid" x1={MINI_LEFT} x2={width - MINI_RIGHT} y1={y(star)} y2={y(star)} />
              <text className="mini-axis" x={width - MINI_RIGHT + 6} y={y(star) + 3}>
                {star.toFixed(1)}
              </text>
            </g>
          ))}
          <path className="mini-line" d={path} pathLength={1} />
          <circle className="mini-dot" cx={x(last.index)} cy={y(last.star)} r={3.5} />
        </svg>
      </div>
    </div>
  );
}

export function ReputationHeroBand({
  summary,
  lifetimeReviewsHandled,
  lifetimeTimeSavedMinutes,
  connected,
  miniTrend = false,
}: Props) {
  const { averageStar, responseRate, timeSavedMinutes, isRamping } = summary;
  const lifetimeHours = Math.round(lifetimeTimeSavedMinutes / 60);
  const headline = computeHeroHeadline(summary);

  return (
    <div className={`card rep-hero${isRamping ? ' ramping' : ''}`}>
      <div className="rep-hero-top">
        <span className="rep-eyebrow">Your reputation · last 30 days</span>
        {connected && (
          <span className="rep-connected">
            <Icon name="check" size={14} /> Google connected
          </span>
        )}
      </div>

      <p className="rep-headline">{headline}</p>

      <div className="rep-stats">
        <div className="rep-stat anchor">
          <div className="rep-stat-top">
            <span className="rep-stat-num">
              {averageStar.current == null ? '—' : averageStar.current.toFixed(1)}
            </span>
            {averageStar.current != null && <Stars rating={averageStar.current} />}
          </div>
          <span className="rep-stat-label">Average rating</span>
          <Delta value={averageStar.delta} unit="rating points" decimals={1} />
        </div>

        <div className="rep-stat">
          <div className="rep-stat-top">
            <span className="rep-stat-num">
              {responseRate.current == null ? '—' : responseRate.current}
              {responseRate.current != null && <small>%</small>}
            </span>
          </div>
          <span className="rep-stat-label">Response rate</span>
          <Delta value={responseRate.delta} unit="points" />
        </div>

        <div className="rep-stat">
          <div className="rep-stat-top">
            <span className="rep-stat-num">
              {formatHours(timeSavedMinutes.current ?? 0)}<small>hrs</small>
            </span>
          </div>
          <span className="rep-stat-label">Time saved</span>
          <Delta
            value={timeSavedMinutes.delta == null ? null : Math.round(timeSavedMinutes.delta / 60)}
            unit="hrs vs prior 30 days"
          />
        </div>
      </div>

      {miniTrend && !isRamping && <HeroMiniTrend trend={summary.trend} />}

      <p className="rep-period-context">{RESPONSE_RATE_PERIOD_CONTEXT}</p>

      <div className="rep-foot">
        {isRamping ? (
          <>
            <Icon name="clock" size={15} />
            Still building your baseline. Trends and comparisons appear after a few weeks of reviews.
          </>
        ) : (
          <>
            <Icon name="check" size={15} />
            {lifetimeReviewsHandled.toLocaleString()} {lifetimeReviewsHandled === 1 ? 'reply' : 'replies'} handled for you since joining. That&apos;s about {lifetimeHours} {lifetimeHours === 1 ? 'hour' : 'hours'} back in your day.
          </>
        )}
      </div>
    </div>
  );
}
