'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';

interface Props {
  ranking: DashboardDataActive['ranking'];
}

const COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626'];

export function RankingCard({ ranking }: Props) {
  if (!ranking || ranking.length === 0) return null;

  const series = ranking.map((s, i) => ({
    keyword: s.keyword,
    color: COLORS[i % COLORS.length]!,
    points: s.snapshots.map((p) => ({ label: shortLabel(p.date), position: p.position })),
  }));

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Search Ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6B7280' }}>local pack</span>
      </div>
      <RankingChart series={series} />
    </div>
  );
}

function shortLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function RankingChart({ series }: { series: { keyword: string; color: string; points: { label: string; position: number }[] }[] }) {
  const W = 600;
  const H = 240;
  const pad = { l: 36, r: 80, t: 16, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const allPositions = series.flatMap((s) => s.points.map((p) => p.position));
  const minRank = 1;
  const maxRank = Math.max(...allPositions, 5);
  const dates = series[0]?.points.map((p) => p.label) ?? [];
  const stepX = innerW / Math.max(1, dates.length - 1);
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
      {dates.map((label, i) => (
        <text
          key={i}
          x={pad.l + i * stepX}
          y={H - 10}
          textAnchor="middle"
          fontSize="10"
          fill="#9CA3AF"
          fontFamily="DM Sans"
        >
          {label}
        </text>
      ))}
      {series.map((s) => {
        const path = s.points
          .map((p, i) => {
            const x = pad.l + i * stepX;
            const y = yFor(p.position);
            return i === 0 ? `M${x},${y}` : `L${x},${y}`;
          })
          .join(' ');
        const last = s.points[s.points.length - 1]!;
        const lastY = yFor(last.position);
        const lastX = pad.l + (s.points.length - 1) * stepX;
        return (
          <g key={s.keyword}>
            <path d={path} stroke={s.color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            {s.points.map((p, i) => (
              <circle key={i} cx={pad.l + i * stepX} cy={yFor(p.position)} r="3" fill="#fff" stroke={s.color} strokeWidth="2" />
            ))}
            <text x={lastX + 8} y={lastY + 3} fontSize="10" fontWeight="600" fill={s.color} fontFamily="DM Sans">
              {s.keyword}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
