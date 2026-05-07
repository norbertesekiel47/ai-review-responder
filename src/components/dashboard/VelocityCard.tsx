'use client';

import { useState } from 'react';
import type { DashboardDataActive } from '@/lib/dashboard/types';

interface Props {
  reviewVelocity: DashboardDataActive['reviewVelocity'];
}

export function VelocityCard({ reviewVelocity }: Props) {
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
      <VelocityChart data={data} accent={accent} />
    </div>
  );
}

function shortLabel(weekStartIso: string, idx: number, total: number): string {
  // Show only ~half the labels to avoid crowding (every other tick).
  if (idx % 2 !== 0 && idx !== total - 1) return '';
  const d = new Date(weekStartIso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function VelocityChart({ data, accent }: { data: { label: string; count: number }[]; accent: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const counts = data.map((d) => d.count);
  const max = Math.max(...counts, 1);
  const avg = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const peakIdx = counts.indexOf(Math.max(...counts));
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

  const pts = data.map((d, i) => [pad.l + i * gap + gap / 2, yFor(d.count)] as const);
  const curve = pts.reduce((acc, [x, y], i, arr) => {
    if (i === 0) return `M${x},${y}`;
    const [px, py] = arr[i - 1]!;
    const cx = (px + x) / 2;
    return `${acc} Q${px},${py} ${cx},${(py + y) / 2} T${x},${y}`;
  }, '');

  const gradId = `velGrad-${accent.replace('#', '')}`;
  const lineId = `velLine-${accent.replace('#', '')}`;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <KpiSummary label="This week" value={lastWeek} delta={deltaPct} />
        <KpiSummary label="Total · last weeks" value={total} />
        <KpiSummary label="Weekly avg" value={Number(avg.toFixed(1))} />
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="chart-shell"
        width="100%"
        style={{ height: 220, display: 'block', overflow: 'visible', maxWidth: '100%' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.95" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accent} stopOpacity="0.4" />
            <stop offset="100%" stopColor={accent} stopOpacity="1" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={yFor(t)} y2={yFor(t)} stroke="#F3F4F6" strokeWidth="1" />
            <text x={pad.l - 8} y={yFor(t) + 3} textAnchor="end" fontSize="10" fill="#9CA3AF" fontFamily="DM Sans">
              {t}
            </text>
          </g>
        ))}

        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={yFor(avg)}
          y2={yFor(avg)}
          stroke="#9CA3AF"
          strokeWidth="1"
          strokeDasharray="2 4"
          opacity="0.7"
        />
        <text
          x={W - pad.r}
          y={yFor(avg) - 4}
          textAnchor="end"
          fontSize="9"
          fill="#9CA3AF"
          fontFamily="DM Sans"
          fontWeight="500"
        >
          avg {avg.toFixed(1)}
        </text>

        {data.map((d, i) => {
          const x = pad.l + i * gap + (gap - barW) / 2;
          const h = (d.count / max) * innerH;
          const y = pad.t + innerH - h;
          const isPeak = i === peakIdx;
          const isHover = hover === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              <rect x={x - 4} y={pad.t} width={barW + 8} height={innerH} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx="6"
                ry="6"
                fill={`url(#${gradId})`}
                style={{ transition: 'opacity 160ms', opacity: hover == null || isHover ? 1 : 0.5 }}
              />
              {isPeak && (
                <circle cx={x + barW / 2} cy={y - 12} r="3" fill={accent}>
                  <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              <text
                x={x + barW / 2}
                y={H - 12}
                textAnchor="middle"
                fontSize="10"
                fill={isHover ? '#374151' : '#9CA3AF'}
                fontFamily="DM Sans"
                fontWeight={isHover ? 600 : 400}
              >
                {d.label}
              </text>
            </g>
          );
        })}

        <path d={curve} fill="none" stroke={`url(#${lineId})`} strokeWidth="2" strokeLinecap="round" />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={hover === i ? 5 : 3}
            fill="#fff"
            stroke={accent}
            strokeWidth="2"
            style={{ transition: 'r 160ms' }}
          />
        ))}

        {hover != null &&
          (() => {
            const [hx, hy] = pts[hover]!;
            const d = data[hover]!;
            return (
              <g style={{ pointerEvents: 'none' }}>
                <line
                  x1={hx}
                  x2={hx}
                  y1={pad.t}
                  y2={pad.t + innerH}
                  stroke={accent}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.5"
                />
                <g transform={`translate(${Math.min(hx, W - pad.r - 90)}, ${Math.max(hy - 48, pad.t)})`}>
                  <rect x="-4" y="-4" width="96" height="40" rx="8" fill="#111827" opacity="0.95" />
                  <text x="44" y="11" textAnchor="middle" fontSize="9" fill="#9CA3AF" fontFamily="DM Sans" fontWeight="500">
                    Week of {d.label || `#${hover + 1}`}
                  </text>
                  <text x="44" y="28" textAnchor="middle" fontSize="14" fill="#fff" fontFamily="Plus Jakarta Sans" fontWeight="700">
                    {d.count} reviews
                  </text>
                </g>
              </g>
            );
          })()}
      </svg>
    </div>
  );
}

function KpiSummary({ label, value, delta }: { label: string; value: number; delta?: number }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 500, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 700, fontSize: 24, letterSpacing: '-0.02em' }}>
          {value}
        </span>
        {delta != null && (
          <span style={{ fontSize: 12, fontWeight: 600, color: delta >= 0 ? '#16A34A' : '#DC2626' }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
