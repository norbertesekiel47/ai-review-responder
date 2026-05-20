'use client';

export const RANKING_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626'] as const;

export interface RankingSnapshotPoint {
  date: string;
  position: number;
}

export interface RankingSourceSeries {
  keyword: string;
  snapshots: RankingSnapshotPoint[];
}

export interface RankingChartSeries {
  keyword: string;
  color: string;
  points: { date: string; label: string; position: number }[];
}

export function formatRankingDateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function buildRankingSeries(series: RankingSourceSeries[]): RankingChartSeries[] {
  return series.map((s, i) => ({
    keyword: s.keyword,
    color: RANKING_COLORS[i % RANKING_COLORS.length]!,
    points: s.snapshots.map((p) => ({
      date: p.date,
      label: formatRankingDateLabel(p.date),
      position: p.position,
    })),
  }));
}

interface RankingChartProps {
  series: RankingChartSeries[];
  formatSeriesLabel?: (keyword: string) => string;
  labelFontSize?: string;
  labelFontWeight?: string;
}

export function RankingChart({
  series,
  formatSeriesLabel = (keyword) => keyword,
  labelFontSize = '10',
  labelFontWeight = '600',
}: RankingChartProps) {
  const W = 600;
  const H = 240;
  const pad = { l: 36, r: 80, t: 16, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

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
    return pad.l + (idx < 0 ? 0 : idx) * stepX;
  };
  const yFor = (r: number) => pad.t + ((r - minRank) / (maxRank - minRank)) * innerH;
  const yTicks = [1, Math.ceil((maxRank + 1) / 2), maxRank];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-shell tall" style={{ height: 240 }}>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={pad.l + innerW} y1={yFor(t)} y2={yFor(t)} stroke="#E5E7EB" strokeDasharray="3 3" />
          <text x={pad.l - 6} y={yFor(t) + 3} textAnchor="end" fontSize="10" fill="#9CA3AF" fontFamily="DM Sans">
            #{t}
          </text>
        </g>
      ))}
      {allDates.map((date, i) => (
        <text
          key={date}
          x={pad.l + i * stepX}
          y={H - 10}
          textAnchor="middle"
          fontSize="10"
          fill="#9CA3AF"
          fontFamily="DM Sans"
        >
          {labelByDate.get(date) ?? ''}
        </text>
      ))}
      {series.map((s, si) => {
        const sorted = [...s.points].sort((a, b) => a.date.localeCompare(b.date));
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
        return (
          <g key={`${s.keyword}-${si}`}>
            <path d={path} stroke={s.color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            {sorted.map((p, pi) => (
              <circle key={`${si}-${pi}-${p.date}`} cx={xFor(p.date)} cy={yFor(p.position)} r="3" fill="#fff" stroke={s.color} strokeWidth="2" />
            ))}
            <text x={lastX + 8} y={lastY + 3} fontSize={labelFontSize} fontWeight={labelFontWeight} fill={s.color} fontFamily="DM Sans">
              {formatSeriesLabel(s.keyword)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
