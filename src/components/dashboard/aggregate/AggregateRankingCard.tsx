'use client';

import { useState } from 'react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';

const COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626'];

interface Props {
  ranking: AggregateDashboardData['ranking'];
  perLocationRanking: AggregateDashboardData['perLocationRanking'];
}

export function AggregateRankingCard({ ranking, perLocationRanking }: Props) {
  const [mode, setMode] = useState<'aggregate' | 'per-location'>('aggregate');

  if (!ranking && perLocationRanking.length === 0) return null;

  // Aggregate series (best position across locations)
  const aggregateSeries = ranking
    ? ranking.map((s, i) => ({
        keyword: s.keyword,
        color: COLORS[i % COLORS.length]!,
        points: s.snapshots.map((p) => ({ date: p.date, label: shortLabel(p.date), position: p.position })),
      }))
    : [];

  // Per-location series
  const perLocationSeries = perLocationRanking.flatMap((loc, li) => {
    if (!loc.ranking) return [];
    return loc.ranking.map((kw) => ({
      locationDisplayName: loc.displayName,
      locationId: loc.locationId,
      keyword: kw.keyword,
      color: COLORS[li % COLORS.length]!,
      points: kw.snapshots.map((p) => ({ date: p.date, label: shortLabel(p.date), position: p.position })),
    }));
  });

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Search Ranking</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6B7280' }}>local pack</span>
      </div>

      {/* VAL-DASH-015: per-location ranking toggle */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#F3F4F6', borderRadius: 9999, width: 'fit-content', marginBottom: 14 }}>
        <button
          type="button"
          className={`tab ${mode === 'aggregate' ? 'active' : ''}`}
          onClick={() => setMode('aggregate')}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          Best Across Locations
        </button>
        <button
          type="button"
          className={`tab ${mode === 'per-location' ? 'active' : ''}`}
          onClick={() => setMode('per-location')}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          Per Location
        </button>
      </div>

      {mode === 'aggregate' ? (
        <RankingChart series={aggregateSeries} />
      ) : (
        <>
          <RankingChart
            series={perLocationSeries.map((s) => ({
              keyword: `[${s.locationDisplayName}] ${s.keyword}`,
              color: s.color,
              points: s.points,
            }))}
          />
          <div className="chart-legend">
            {perLocationRanking.map((loc, i) => (
              <span key={loc.locationId}>
                <span className="legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
                {loc.displayName}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function shortLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ChartSeries {
  keyword: string;
  color: string;
  points: { date: string; label: string; position: number }[];
}

function RankingChart({ series }: { series: ChartSeries[] }) {
  const W = 600;
  const H = 240;
  const pad = { l: 36, r: 80, t: 16, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

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
          <text x={pad.l - 6} y={yFor(t) + 3} textAnchor="end" fontSize="10" fill="#9CA3AF" fontFamily="DM Sans">#{t}</text>
        </g>
      ))}
      {allDates.map((date, i) => (
        <text key={date} x={pad.l + i * stepX} y={H - 10} textAnchor="middle" fontSize="10" fill="#9CA3AF" fontFamily="DM Sans">
          {labelByDate.get(date) ?? ''}
        </text>
      ))}
      {series.map((s) => {
        const sorted = [...s.points].sort((a, b) => a.date.localeCompare(b.date));
        const path = sorted.map((p, i) => {
          const x = xFor(p.date);
          const y = yFor(p.position);
          return i === 0 ? `M${x},${y}` : `L${x},${y}`;
        }).join(' ');
        const last = sorted[sorted.length - 1];
        if (!last) return null;
        const lastX = xFor(last.date);
        const lastY = yFor(last.position);
        return (
          <g key={s.keyword}>
            <path d={path} stroke={s.color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            {sorted.map((p) => (
              <circle key={p.date} cx={xFor(p.date)} cy={yFor(p.position)} r="3" fill="#fff" stroke={s.color} strokeWidth="2" />
            ))}
            <text x={lastX + 8} y={lastY + 3} fontSize="9" fontWeight="500" fill={s.color} fontFamily="DM Sans">
              {s.keyword.length > 18 ? s.keyword.slice(0, 16) + '…' : s.keyword}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
