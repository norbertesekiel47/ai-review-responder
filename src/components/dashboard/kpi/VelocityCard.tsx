'use client';

import { useState } from 'react';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import { ChartHeadlineBanner } from '@/components/dashboard/kpi/ChartHeadlineBanner';
import { computeVelocityHeadline } from '@/components/dashboard/kpi/chart-headlines';

interface Props {
  reviewVelocity: DashboardDataActive['reviewVelocity'];
}

// Single Warm Editorial accent — the old per-call hex `accent` prop is gone now
// that this only renders on the warm Analytics surface.
const ACCENT = 'var(--rw-sage-deep)';
const GRAD_ID = 'velGrad';
const LINE_ID = 'velLine';

export function VelocityCard({ reviewVelocity }: Props) {
  const data = reviewVelocity.map((r, i) => ({
    label: shortLabel(r.weekStart, i, reviewVelocity.length),
    count: r.count,
  }));
  const headline = computeVelocityHeadline(reviewVelocity);

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Review Velocity</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>
          last {data.length} weeks
        </span>
      </div>
      <ChartHeadlineBanner data={headline} />
      <VelocityChart data={data} />
    </div>
  );
}

function shortLabel(weekStartIso: string, idx: number, total: number): string {
  // Show only ~half the labels to avoid crowding (every other tick).
  if (idx % 2 !== 0 && idx !== total - 1) return '';
  const d = new Date(weekStartIso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PAD = { l: 36, r: 16, t: 28, b: 32 };

function VelocityChart({ data }: { data: { label: string; count: number }[] }) {
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
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const gap = innerW / Math.max(1, data.length);
  const barW = gap * 0.5;
  const yFor = (v: number) => PAD.t + innerH - (v / max) * innerH;
  const yTicks = [0, Math.round(max / 2), max];

  const pts = data.map((d, i) => [PAD.l + i * gap + gap / 2, yFor(d.count)] as const);
  const curve = pts.reduce((acc, [x, y], i, arr) => {
    if (i === 0) return `M${x},${y}`;
    const [px, py] = arr[i - 1]!;
    const cx = (px + x) / 2;
    return `${acc} Q${px},${py} ${cx},${(py + y) / 2} T${x},${y}`;
  }, '');

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
          <linearGradient id={GRAD_ID} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: ACCENT, stopOpacity: 0.95 }} />
            <stop offset="100%" style={{ stopColor: ACCENT, stopOpacity: 0.32 }} />
          </linearGradient>
          <linearGradient id={LINE_ID} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: ACCENT, stopOpacity: 0.4 }} />
            <stop offset="100%" style={{ stopColor: ACCENT, stopOpacity: 1 }} />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yFor(t)} y2={yFor(t)} style={{ stroke: 'var(--rw-hair)' }} strokeWidth="1" />
            <text x={PAD.l - 8} y={yFor(t) + 3} textAnchor="end" fontSize="10" style={{ fill: 'var(--rw-app-text-soft)', fontFamily: 'var(--rw-font-body)' }}>
              {t}
            </text>
          </g>
        ))}

        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={yFor(avg)}
          y2={yFor(avg)}
          style={{ stroke: 'var(--rw-app-text-soft)' }}
          strokeWidth="1"
          strokeDasharray="2 4"
          opacity="0.7"
        />
        <text
          x={W - PAD.r}
          y={yFor(avg) - 4}
          textAnchor="end"
          fontSize="9"
          fontWeight="500"
          style={{ fill: 'var(--rw-app-text-soft)', fontFamily: 'var(--rw-font-body)' }}
        >
          avg {avg.toFixed(1)}
        </text>

        {data.map((d, i) => {
          const x = PAD.l + i * gap + (gap - barW) / 2;
          const h = (d.count / max) * innerH;
          const y = PAD.t + innerH - h;
          const isPeak = i === peakIdx;
          const isHover = hover === i;
          return (
            <g
              key={i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              <rect x={x - 4} y={PAD.t} width={barW + 8} height={innerH} fill="transparent" />
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx="6"
                ry="6"
                fill={`url(#${GRAD_ID})`}
                style={{ transition: 'opacity 160ms', opacity: hover == null || isHover ? 1 : 0.5 }}
              />
              {isPeak && (
                <circle cx={x + barW / 2} cy={y - 12} r="3" style={{ fill: ACCENT }}>
                  <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              <text
                x={x + barW / 2}
                y={H - 12}
                textAnchor="middle"
                fontSize="10"
                fontWeight={isHover ? 600 : 400}
                style={{ fill: isHover ? 'var(--rw-app-text-muted)' : 'var(--rw-app-text-soft)', fontFamily: 'var(--rw-font-body)' }}
              >
                {d.label}
              </text>
            </g>
          );
        })}

        <path d={curve} fill="none" stroke={`url(#${LINE_ID})`} strokeWidth="2" strokeLinecap="round" />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={hover === i ? 5 : 3}
            style={{ fill: 'var(--rw-card)', stroke: ACCENT, strokeWidth: 2, transition: 'r 160ms' }}
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
                  y1={PAD.t}
                  y2={PAD.t + innerH}
                  style={{ stroke: ACCENT }}
                  strokeWidth="1"
                  strokeDasharray="2 3"
                  opacity="0.5"
                />
                <g transform={`translate(${Math.min(hx, W - PAD.r - 90)}, ${Math.max(hy - 48, PAD.t)})`}>
                  <rect x="-4" y="-4" width="96" height="40" rx="8" style={{ fill: 'var(--rw-app-text)' }} opacity="0.95" />
                  <text x="44" y="11" textAnchor="middle" fontSize="9" fontWeight="500" style={{ fill: 'var(--rw-app-text-soft)', fontFamily: 'var(--rw-font-body)' }}>
                    Week of {d.label || `#${hover + 1}`}
                  </text>
                  <text x="44" y="28" textAnchor="middle" fontSize="14" fontWeight="700" style={{ fill: 'var(--rw-card)', fontFamily: 'var(--rw-font-display)' }}>
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
      <div style={{ fontSize: 12, color: 'var(--rw-app-text-muted)', fontWeight: 500, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: 'var(--rw-font-display)', fontWeight: 700, fontSize: 24, letterSpacing: '-0.02em' }}>
          {value}
        </span>
        {delta != null && (
          <span style={{ fontSize: 12, fontWeight: 600, color: delta >= 0 ? 'var(--rw-sage-deep)' : 'var(--rw-danger)' }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
