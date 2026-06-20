import type { ReputationSummary } from '@/lib/dashboard/types';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeTrendHeadline } from '@/components/dashboard/kpi/chart-headlines';

interface Props {
  trend: ReputationSummary['trend'];
}

// Plot geometry (viewBox units). The Y-axis domain is computed from the data
// (see computeTrendDomain) rather than pinned to 1–5, so movement inside the
// real 4.x band is visible instead of flattened.
const VB_W = 720;
const LEFT = 34;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 174; // 200 viewBox height − 26 for x labels

const PLOT_W = VB_W - LEFT - RIGHT;

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

export function ReputationTrendChart({ trend }: Props) {
  const points = trend
    .map((week, index) => ({ index, star: week.starEquivalent }))
    .filter((p): p is { index: number; star: number } => p.star != null);

  const domain = computeTrendDomain(points.map((p) => p.star));
  const headline = computeTrendHeadline(trend);

  const yFor = (star: number): number => {
    const clamped = Math.min(domain.max, Math.max(domain.min, star));
    return BOTTOM - ((clamped - domain.min) / (domain.max - domain.min)) * (BOTTOM - TOP);
  };

  const xFor = (index: number): number =>
    trend.length > 1 ? LEFT + (index / (trend.length - 1)) * PLOT_W : LEFT + PLOT_W / 2;

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
          <svg
            className="rep-trend-svg"
            viewBox={`0 0 ${VB_W} 200`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Reputation trend, star-equivalent, last 8 weeks, latest ${points[points.length - 1]!.star.toFixed(1)} stars`}
          >
            {gridStars.map((star) => (
              <line key={star} className="rep-trend-grid" x1={LEFT} x2={VB_W - RIGHT} y1={yFor(star)} y2={yFor(star)} />
            ))}
            {gridStars.map((star) => (
              <text key={`l-${star}`} className="rep-trend-axis" x={20} y={yFor(star) + 4}>{star.toFixed(1)}</text>
            ))}
            <path
              className="rep-trend-line"
              d={points
                .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(p.index).toFixed(1)},${yFor(p.star).toFixed(1)}`)
                .join(' ')}
            />
            <circle
              className="rep-trend-dot"
              cx={xFor(points[points.length - 1]!.index)}
              cy={yFor(points[points.length - 1]!.star)}
              r={4.5}
            />
            <text className="rep-trend-axis" x={LEFT} y={194}>8 weeks ago</text>
            <text className="rep-trend-axis" x={VB_W - RIGHT} y={194} textAnchor="end">now</text>
          </svg>
        </>
      )}
    </div>
  );
}
