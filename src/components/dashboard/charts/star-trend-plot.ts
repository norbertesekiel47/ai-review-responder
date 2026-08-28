import { scaleLinear, type ScaleLinear } from 'd3-scale';
import { line as d3Line, curveMonotoneX } from 'd3-shape';
import type { ReputationSummary } from '@/lib/dashboard/types';

// The star-equivalent trend construction shared by the full analytics chart
// (ReputationTrendChart) and the hero's mini trend (ReputationHeroBand). The
// two render the SAME real series at different sizes — the series-level
// duplication rule lives in DESIGN.md (mini trend is prop-gated off the
// analytics page); this module is the single owner of how the series becomes
// a plot, so the two cannot drift.

export interface StarPoint {
  index: number;
  star: number;
}

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

/** The plotted series: weeks carrying a star-equivalent, index kept for x. */
export function starTrendPoints(trend: ReputationSummary['trend']): StarPoint[] {
  return trend
    .map((week, index) => ({ index, star: week.starEquivalent }))
    .filter((p): p is StarPoint => p.star != null);
}

export interface StarTrendFrame {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface StarTrendPlot {
  domain: { min: number; max: number };
  x: ScaleLinear<number, number>;
  y: ScaleLinear<number, number>;
  path: string;
  /** Three gridlines spanning the zoomed domain (top / mid / bottom). */
  gridStars: number[];
}

/**
 * Scales + smoothed line path for a star-trend plot. A lone week maps to the
 * plot center (domain [-1,1] puts index 0 at the midpoint); callers that hide
 * single-point "trends" simply never reach that branch.
 */
export function starTrendPlot(
  points: StarPoint[],
  trendLength: number,
  width: number,
  frame: StarTrendFrame,
): StarTrendPlot {
  const domain = computeTrendDomain(points.map((p) => p.star));
  const y = scaleLinear().domain([domain.min, domain.max]).range([frame.bottom, frame.top]).clamp(true);
  const x = scaleLinear()
    .domain(trendLength > 1 ? [0, trendLength - 1] : [-1, 1])
    .range([frame.left, width - frame.right]);
  const path =
    d3Line<StarPoint>()
      .x((p) => x(p.index))
      .y((p) => y(p.star))
      .curve(curveMonotoneX)(points) ?? '';
  const gridStars = [domain.max, (domain.min + domain.max) / 2, domain.min];
  return { domain, x, y, path, gridStars };
}
