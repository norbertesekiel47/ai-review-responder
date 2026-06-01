'use client';

import { useState } from 'react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';

const STACK_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626'];

interface Props {
  reviewVelocity: AggregateDashboardData['reviewVelocity'];
  perLocationVelocity: AggregateDashboardData['perLocationVelocity'];
}

export function AggregateVelocityCard({ reviewVelocity, perLocationVelocity }: Props) {
  const [mode, setMode] = useState<'total' | 'stacked'>('total');

  const data = reviewVelocity.map((r, i) => ({
    label: shortLabel(r.weekStart, i, reviewVelocity.length),
    count: r.count,
  }));
  const accent = '#2563eb';

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Review Velocity</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6B7280' }}>
          last {data.length} weeks
        </span>
      </div>

      {/* VAL-DASH-015: stacked-by-location toggle */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: '#F3F4F6', borderRadius: 9999, width: 'fit-content', marginBottom: 14 }}>
        <button
          type="button"
          className={`tab ${mode === 'total' ? 'active' : ''}`}
          onClick={() => setMode('total')}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          Total
        </button>
        <button
          type="button"
          className={`tab ${mode === 'stacked' ? 'active' : ''}`}
          onClick={() => setMode('stacked')}
          style={{ padding: '4px 12px', fontSize: 12 }}
        >
          By Location
        </button>
      </div>

      {mode === 'total' ? (
        <VelocityChart data={data} accent={accent} />
      ) : (
        <StackedVelocityChart perLocationVelocity={perLocationVelocity} />
      )}
    </div>
  );
}

function shortLabel(weekStartIso: string, idx: number, total: number): string {
  if (idx % 2 !== 0 && idx !== total - 1) return '';
  const d = new Date(weekStartIso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function VelocityChart({ data, accent }: { data: { label: string; count: number }[]; accent: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const counts = data.map((d) => d.count);
  const max = Math.max(...counts, 1);
  const avg = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const total = counts.reduce((a, b) => a + b, 0);
  const lastWeek = counts[counts.length - 1] ?? 0;
  const prevWeek = counts[counts.length - 2] ?? lastWeek;
  const deltaPct = prevWeek ? Math.round(((lastWeek - prevWeek) / prevWeek) * 100) : 0;

  const W = 640;
  const H = 220;
  const pad = { l: 36, r: 16, t: 28, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const gap = innerW / Math.max(1, data.length);
  const barW = gap * 0.5;
  const yFor = (v: number) => pad.t + innerH - (v / max) * innerH;
  const yTicks = [0, Math.round(max / 2), max];

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <KpiSummary label="This week" value={lastWeek} delta={deltaPct} />
        <KpiSummary label="Total · last weeks" value={total} />
        <KpiSummary label="Weekly avg" value={Number(avg.toFixed(1))} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="chart-shell" width="100%" style={{ height: 220, display: 'block', overflow: 'visible', maxWidth: '100%' }}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={yFor(t)} y2={yFor(t)} stroke="#F3F4F6" strokeWidth="1" />
            <text x={pad.l - 8} y={yFor(t) + 3} textAnchor="end" fontSize="10" fill="#9CA3AF" fontFamily="DM Sans">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * gap + (gap - barW) / 2;
          const h = (d.count / max) * innerH;
          const y = pad.t + innerH - h;
          const isHover = hover === i;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
              <rect x={x} y={y} width={barW} height={h} rx="6" ry="6" fill={accent} style={{ transition: 'opacity 160ms', opacity: hover == null || isHover ? 0.9 : 0.5 }} />
              <text x={x + barW / 2} y={H - 12} textAnchor="middle" fontSize="10" fill={isHover ? '#374151' : '#9CA3AF'} fontFamily="DM Sans" fontWeight={isHover ? 600 : 400}>{d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StackedVelocityChart({ perLocationVelocity }: { perLocationVelocity: AggregateDashboardData['perLocationVelocity'] }) {
  if (perLocationVelocity.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>No velocity data available</div>;
  }

  // Find all week keys across locations
  const weekSet = new Set<string>();
  for (const loc of perLocationVelocity) {
    for (const v of loc.velocity) {
      weekSet.add(v.weekStart);
    }
  }
  const weeks = Array.from(weekSet).sort();

  // Build stacked data per week
  const maxStack = weeks.reduce((max, week) => {
    const stack = perLocationVelocity.reduce((sum, loc) => {
      const v = loc.velocity.find((x) => x.weekStart === week);
      return sum + (v?.count ?? 0);
    }, 0);
    return Math.max(max, stack);
  }, 1);

  const W = 640;
  const H = 220;
  const pad = { l: 36, r: 16, t: 28, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const gap = innerW / Math.max(1, weeks.length);
  const barW = gap * 0.6;

  const yFor = (v: number) => pad.t + innerH - (v / maxStack) * innerH;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="chart-shell" width="100%" style={{ height: 220, display: 'block', overflow: 'visible', maxWidth: '100%' }}>
        {/* Y-axis ticks */}
        {[0, Math.round(maxStack / 2), maxStack].map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={yFor(t)} y2={yFor(t)} stroke="#F3F4F6" strokeWidth="1" />
            <text x={pad.l - 8} y={yFor(t) + 3} textAnchor="end" fontSize="10" fill="#9CA3AF" fontFamily="DM Sans">{t}</text>
          </g>
        ))}

        {/* Stacked bars per week */}
        {weeks.map((week, wi) => {
          const x = pad.l + wi * gap + (gap - barW) / 2;
          let yOffset = 0;
          const segments = perLocationVelocity.map((loc, li) => {
            const v = loc.velocity.find((x) => x.weekStart === week);
            const count = v?.count ?? 0;
            const color = STACK_COLORS[li % STACK_COLORS.length]!;
            const h = (count / maxStack) * innerH;
            const y = pad.t + innerH - yOffset - h;
            yOffset += h;
            return { count, color, y, h };
          }).filter((s) => s.count > 0);

          return (
            <g key={week}>
              {segments.map((seg, si) => (
                <rect key={si} x={x} y={seg.y} width={barW} height={seg.h} fill={seg.color} opacity={0.85} />
              ))}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="chart-legend">
        {perLocationVelocity.map((loc, i) => (
          <span key={loc.locationId}>
            <span className="legend-dot" style={{ background: STACK_COLORS[i % STACK_COLORS.length] }} />
            {loc.displayName}
          </span>
        ))}
      </div>
    </div>
  );
}

function KpiSummary({ label, value, delta }: { label: string; value: number; delta?: number }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 500, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: 24, letterSpacing: '-0.02em' }}>{value}</span>
        {delta != null && (
          <span style={{ fontSize: 12, fontWeight: 600, color: delta >= 0 ? '#16A34A' : '#DC2626' }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
