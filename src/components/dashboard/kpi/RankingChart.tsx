'use client';

import type { RankingChartSeries } from '@/components/dashboard/kpi/RankingChart.helpers';

interface RankingChartProps {
  series: RankingChartSeries[];
  formatSeriesLabel?: (keyword: string) => string;
  labelFontSize?: string;
  labelFontWeight?: string;
  /**
   * 'owner' (default): the owner-facing single-location view — the first
   * (primary) series is bold in --rw-sage-deep, the rest fade to
   * --rw-app-text-soft, so the line you care about reads at a glance instead of
   * competing in a 6-color rainbow. 'series': color per series (the aggregate
   * per-location view, where color distinguishes locations via the legend).
   */
  emphasis?: 'owner' | 'series';
}

const PAD = { l: 36, r: 80, t: 16, b: 28 };

// Warm Editorial series colors for the owner-facing default. Concrete values
// (not var()) because they flow into inline `style` where they read fine, and
// stay literal for the gridline/axis which use CSS-class tokens below.
const OWNER_PRIMARY = 'var(--rw-sage-deep)';
const OWNER_FADED = 'var(--rw-app-text-soft)';

export function RankingChart({
  series,
  formatSeriesLabel = (keyword) => keyword,
  labelFontSize = '10',
  labelFontWeight = '600',
  emphasis = 'owner',
}: RankingChartProps) {
  const W = 600;
  const H = 240;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  // Build a union axis from every series' dates so sparse / mismatched
  // series still position points correctly. The axis is sorted ascending so
  // line paths render left-to-right by chronology, not by array order.
  const allDates = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.date)))).sort();
  const labelByDate = new Map<string, string>();
  for (const s of series) {
    for (const p of s.points) {
      if (!labelByDate.has(p.date)) labelByDate.set(p.date, p.label);
    }
  }

  const allPositions = series.flatMap((s) => s.points.map((p) => p.position));
  const minRank = 1;
  const maxRank = Math.max(...allPositions, 5);

  const stepX = innerW / Math.max(1, allDates.length - 1);
  const xFor = (date: string) => {
    const idx = allDates.indexOf(date);
    return PAD.l + (idx < 0 ? 0 : idx) * stepX;
  };
  const yFor = (r: number) => PAD.t + ((r - minRank) / (maxRank - minRank)) * innerH;
  const yTicks = [1, Math.ceil((maxRank + 1) / 2), maxRank];

  // In owner mode the first series is the headline series (sage, bold); the
  // rest recede. In series mode every line keeps its own legend color.
  const colorFor = (s: RankingChartSeries, si: number) =>
    emphasis === 'series' ? s.color : si === 0 ? OWNER_PRIMARY : OWNER_FADED;
  const isFaded = (si: number) => emphasis === 'owner' && si > 0;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-shell tall" style={{ height: 240 }}>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line className="rank-grid" x1={PAD.l} x2={PAD.l + innerW} y1={yFor(t)} y2={yFor(t)} strokeDasharray="3 3" />
          <text className="rank-axis" x={PAD.l - 6} y={yFor(t) + 3} textAnchor="end" fontSize="10">
            #{t}
          </text>
        </g>
      ))}
      {allDates.map((date, i) => (
        <text key={date} className="rank-axis" x={PAD.l + i * stepX} y={H - 10} textAnchor="middle" fontSize="10">
          {labelByDate.get(date) ?? ''}
        </text>
      ))}
      {series.map((s, si) => {
        const sorted = s.points.toSorted((a, b) => a.date.localeCompare(b.date));
        const path = sorted
          .map((p, i) => {
            const x = xFor(p.date);
            const y = yFor(p.position);
            return i === 0 ? `M${x},${y}` : `L${x},${y}`;
          })
          .join(' ');
        const last = sorted[sorted.length - 1];
        if (!last) return null;
        const lastX = xFor(last.date);
        const lastY = yFor(last.position);
        const color = colorFor(s, si);
        const faded = isFaded(si);
        return (
          <g key={`${s.keyword}-${si}`} style={{ opacity: faded ? 0.65 : 1 }}>
            <path
              d={path}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ stroke: color, strokeWidth: faded ? 1.5 : 2.5 }}
            />
            {sorted.map((p, pi) => (
              <circle
                key={`${si}-${pi}-${p.date}`}
                cx={xFor(p.date)}
                cy={yFor(p.position)}
                r={faded ? 2.5 : 3}
                style={{ fill: 'var(--rw-card)', stroke: color, strokeWidth: 2 }}
              />
            ))}
            <text
              x={lastX + 8}
              y={lastY + 3}
              fontSize={labelFontSize}
              fontWeight={faded ? '500' : labelFontWeight}
              style={{ fill: color, fontFamily: 'var(--rw-font-body)' }}
            >
              {formatSeriesLabel(s.keyword)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
