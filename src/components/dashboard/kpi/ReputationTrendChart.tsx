import type { ReputationSummary } from '@/lib/dashboard/types';

interface Props {
  trend: ReputationSummary['trend'];
}

// Plot geometry (viewBox units). Axis spans the full 1–5 star-equivalent range
// so a dip is never clipped; gridlines kept minimal (5 / 3 / 1).
const VB_W = 720;
const LEFT = 34;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 174; // 200 viewBox height − 26 for x labels
const PLOT_W = VB_W - LEFT - RIGHT;

function yFor(star: number): number {
  const clamped = Math.min(5, Math.max(1, star));
  return BOTTOM - ((clamped - 1) / 4) * (BOTTOM - TOP);
}

export function ReputationTrendChart({ trend }: Props) {
  const points = trend
    .map((week, index) => ({ index, star: week.starEquivalent }))
    .filter((p): p is { index: number; star: number } => p.star != null);

  const xFor = (index: number): number =>
    trend.length > 1 ? LEFT + (index / (trend.length - 1)) * PLOT_W : LEFT + PLOT_W / 2;

  return (
    <div className="card rep-trend">
      <div className="rep-trend-head">
        <h2 className="card-h2" style={{ margin: 0 }}>Reputation trend</h2>
        <span className="rep-trend-sub">star-equivalent · last 8 weeks</span>
      </div>

      {points.length === 0 ? (
        <p className="rep-trend-empty">Not enough reviews yet to chart a trend. Check back in a few weeks.</p>
      ) : (
        <svg
          className="rep-trend-svg"
          viewBox={`0 0 ${VB_W} 200`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Reputation trend, star-equivalent, last 8 weeks, latest ${points[points.length - 1]!.star.toFixed(1)} stars`}
        >
          {[5, 3, 1].map((star) => (
            <line key={star} className="rep-trend-grid" x1={LEFT} x2={VB_W - RIGHT} y1={yFor(star)} y2={yFor(star)} />
          ))}
          {[5, 3, 1].map((star) => (
            <text key={`l-${star}`} className="rep-trend-axis" x={20} y={yFor(star) + 4}>{star}</text>
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
      )}
    </div>
  );
}
