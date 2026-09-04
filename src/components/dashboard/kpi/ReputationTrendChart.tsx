'use client';

import { LazyMotion, domAnimation, m } from 'motion/react';
import type { ReputationSummary } from '@/lib/dashboard/types';
import { starTrendPoints, starTrendPlot, trendSpanLabel, type StarPoint } from '@/components/dashboard/charts/star-trend-plot';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeTrendHeadline } from '@/components/dashboard/kpi/chart-headlines';
import { ChartTooltip, weekOverWeekDeltaLabel } from '@/components/dashboard/charts/ChartTooltip';
import { chartTransition, DOT_SPRING, LINE_REVEAL } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { useNearestDatum } from '@/components/dashboard/charts/useNearestDatum';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface Props {
  trend: ReputationSummary['trend'];
}

// Plot geometry (real pixels — the viewBox equals the measured wrapper width
// per the useMeasuredSvg contract). The Y-axis domain is computed from the
// data (computeTrendDomain in charts/star-trend-plot.ts) rather than pinned
// to 1–5, so movement inside the real 4.x band is visible instead of
// flattened.
const H = 200;
const LEFT = 34;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 174; // H − 26 for x labels

/**
 * `weekStartIso` is a calendar DAY, which JS parses as UTC midnight — formatting
 * it in the viewer's zone rolls it back a day west of Greenwich ("Week of Jun 21"
 * for the week that starts Monday Jun 22). Pin the zone; see `weekShortLabel`.
 */
function weekLabel(weekStartIso: string): string {
  return new Date(weekStartIso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Change vs the previous PLOTTED week, from the same points the line draws.
 * First point has no prior, so no delta renders.
 */
function starDeltaLabel(
  points: ReadonlyArray<StarPoint>,
  hovered: StarPoint,
): string | undefined {
  const pos = points.findIndex((p) => p.index === hovered.index);
  if (pos <= 0) return undefined;
  return weekOverWeekDeltaLabel(hovered.star - points[pos - 1]!.star, (n) => `${n.toFixed(1)}★`);
}

export function ReputationTrendChart({ trend }: Props) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();
  const spanLabel = trendSpanLabel(trend.length);

  const points = starTrendPoints(trend);
  const headline = computeTrendHeadline(trend);
  const { x, y, path, gridStars } = starTrendPlot(points, trend.length, width, {
    top: TOP,
    bottom: BOTTOM,
    left: LEFT,
    right: RIGHT,
  });

  const hover = useNearestDatum(points.map((p) => x(p.index)));
  const hovered = hover.index != null ? points[hover.index] : undefined;
  const last = points[points.length - 1];
  const focus = hovered ?? last;

  return (
    <div className="card rep-trend">
      <div className="rep-trend-head">
        <h2 className="card-h2" style={{ margin: 0 }}>Reputation trend</h2>
        {/* The empty state below states the unit and the span in a sentence, so
            this sub-label would say both a second time six words above it —
            the duplication T5 reworded both `Recent*` captions to avoid
            (review F5). One statement per card, whichever branch renders. */}
        {points.length > 0 && <span className="rep-trend-sub">star-equivalent · {spanLabel}</span>}
      </div>

      {points.length === 0 ? (
        // An empty chart must still say WHAT it would have plotted (#1088,
        // intake edge case). The window is real even when the series is not —
        // `trend` still carries its weekly buckets — so this names the unit and
        // the span instead of leaving the reader to guess both. One template
        // string, so JSX cannot split the phrase across text lines.
        <p className="rep-trend-empty">
          {`Not enough reviews yet to chart a trend — this chart plots star-equivalent over the ${spanLabel}. Check back in a few weeks.`}
        </p>
      ) : (
        <>
          <ChartHeadlineBanner data={headline} />
          <div ref={ref} className="rep-trend-plot">
            <LazyMotion features={domAnimation} strict>
              <svg
                className="rep-trend-svg"
                viewBox={`0 0 ${width} ${H}`}
                role="img"
                aria-label={`Reputation trend, star-equivalent, ${spanLabel}, latest ${points[points.length - 1]!.star.toFixed(1)} stars`}
                onPointerMove={hover.onPointerMove}
                onPointerLeave={hover.onPointerLeave}
              >
                {gridStars.map((star) => (
                  <line key={star} className="rep-trend-grid" x1={LEFT} x2={width - RIGHT} y1={y(star)} y2={y(star)} />
                ))}
                {gridStars.map((star) => (
                  <text key={`l-${star}`} className="rep-trend-axis" x={20} y={y(star) + 4}>{star.toFixed(1)}</text>
                ))}
                {hovered && (
                  <line className="chart-crosshair" x1={x(hovered.index)} x2={x(hovered.index)} y1={TOP} y2={BOTTOM} />
                )}
                <m.path
                  className="rep-trend-line"
                  d={path}
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={chartTransition(reduced, LINE_REVEAL)}
                />
                {focus && (
                  <m.g
                    // key={width}: with initial={false} under SSR, motion adopts the
                    // server-rendered transform (canonical width) and skips the target
                    // change that arrives in the hydration-time measured re-render,
                    // leaving the dot stranded mid-chart. Remounting on width change
                    // renders at the correct position; hover moves (same width) still
                    // spring through `animate`.
                    key={width}
                    initial={false}
                    animate={{ x: x(focus.index), y: y(focus.star) }}
                    transition={chartTransition(reduced, DOT_SPRING)}
                  >
                    <circle className="rep-trend-dot" r={4.5} />
                  </m.g>
                )}
                <text className="rep-trend-axis" x={LEFT} y={194}>
                  {trend.length === 1 ? 'last week' : `${trend.length} weeks ago`}
                </text>
                <text className="rep-trend-axis" x={width - RIGHT} y={194} textAnchor="end">now</text>
              </svg>
            </LazyMotion>
            {hovered && (
              <ChartTooltip
                x={x(hovered.index)}
                y={y(hovered.star)}
                title={`Week of ${weekLabel(trend[hovered.index]!.weekStart)}`}
                value={`${hovered.star.toFixed(1)}★`}
                delta={starDeltaLabel(points, hovered)}
                containerWidth={width}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
