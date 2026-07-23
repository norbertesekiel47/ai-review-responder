'use client';

import { scaleLinear } from 'd3-scale';
import { line as d3Line, curveMonotoneX } from 'd3-shape';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { ReputationSummary } from '@/lib/dashboard/types';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeTrendHeadline } from '@/components/dashboard/kpi/chart-headlines';
import { ChartTooltip } from '@/components/dashboard/charts/ChartTooltip';
import { chartTransition, DOT_SPRING, LINE_REVEAL } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { useNearestDatum } from '@/components/dashboard/charts/useNearestDatum';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface Props {
  trend: ReputationSummary['trend'];
}

// Plot geometry (real pixels — the viewBox equals the measured wrapper width
// per the useMeasuredSvg contract). The Y-axis domain is computed from the
// data (see computeTrendDomain) rather than pinned to 1–5, so movement inside
// the real 4.x band is visible instead of flattened.
const H = 200;
const LEFT = 34;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 174; // H − 26 for x labels

/** Smallest star span the axis will ever show, so a flat-ish trend still reads. */
const MIN_DOMAIN_SPAN = 0.6;

/**
 * Y-axis domain zoomed to the data: [min−0.2, max+0.2] clamped to [1,5] with a
 * minimum span of ~0.6. A 4.3→4.8 run fills the axis instead of hugging the top
 * of a fixed 1–5 chart. Empty input falls back to the full 1–5 range.
 */
export function computeTrendDomain(stars: number[]): { min: number; max: number } {
  if (stars.length === 0) return { min: 1, max: 5 };

  let min = Math.max(1, Math.min(...stars) - 0.2);
  let max = Math.min(5, Math.max(...stars) + 0.2);

  if (max - min < MIN_DOMAIN_SPAN) {
    const mid = (min + max) / 2;
    min = mid - MIN_DOMAIN_SPAN / 2;
    max = mid + MIN_DOMAIN_SPAN / 2;
    // Shift the window back inside [1,5] if expanding pushed it past an edge.
    if (min < 1) {
      max += 1 - min;
      min = 1;
    }
    if (max > 5) {
      min -= max - 5;
      max = 5;
    }
    min = Math.max(1, min);
    max = Math.min(5, max);
  }

  return { min, max };
}

function weekLabel(weekStartIso: string): string {
  return new Date(weekStartIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ReputationTrendChart({ trend }: Props) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

  const points = trend
    .map((week, index) => ({ index, star: week.starEquivalent }))
    .filter((p): p is { index: number; star: number } => p.star != null);

  const domain = computeTrendDomain(points.map((p) => p.star));
  const headline = computeTrendHeadline(trend);

  const y = scaleLinear().domain([domain.min, domain.max]).range([BOTTOM, TOP]).clamp(true);
  // A lone week maps to the plot center (domain [-1,1] puts index 0 at the
  // midpoint), matching the pre-migration centering behavior for single points.
  const x = scaleLinear()
    .domain(trend.length > 1 ? [0, trend.length - 1] : [-1, 1])
    .range([LEFT, width - RIGHT]);

  const path =
    d3Line<{ index: number; star: number }>()
      .x((p) => x(p.index))
      .y((p) => y(p.star))
      .curve(curveMonotoneX)(points) ?? '';

  const hover = useNearestDatum(points.map((p) => x(p.index)));
  const hovered = hover.index != null ? points[hover.index] : undefined;
  const last = points[points.length - 1];
  const focus = hovered ?? last;

  // Three gridlines spanning the zoomed domain (top / mid / bottom).
  const gridStars = [domain.max, (domain.min + domain.max) / 2, domain.min];

  return (
    <div className="card rep-trend">
      <div className="rep-trend-head">
        <h2 className="card-h2" style={{ margin: 0 }}>Reputation trend</h2>
        <span className="rep-trend-sub">star-equivalent · last 8 weeks</span>
      </div>

      {points.length === 0 ? (
        <p className="rep-trend-empty">Not enough reviews yet to chart a trend. Check back in a few weeks.</p>
      ) : (
        <>
          <ChartHeadlineBanner data={headline} />
          <div ref={ref} className="rep-trend-plot">
            <LazyMotion features={domAnimation} strict>
              <svg
                className="rep-trend-svg"
                viewBox={`0 0 ${width} ${H}`}
                role="img"
                aria-label={`Reputation trend, star-equivalent, last 8 weeks, latest ${points[points.length - 1]!.star.toFixed(1)} stars`}
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
                <text className="rep-trend-axis" x={LEFT} y={194}>8 weeks ago</text>
                <text className="rep-trend-axis" x={width - RIGHT} y={194} textAnchor="end">now</text>
              </svg>
            </LazyMotion>
            {hovered && (
              <ChartTooltip
                x={x(hovered.index)}
                y={y(hovered.star)}
                title={`Week of ${weekLabel(trend[hovered.index]!.weekStart)}`}
                value={`${hovered.star.toFixed(1)}★`}
                containerWidth={width}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
