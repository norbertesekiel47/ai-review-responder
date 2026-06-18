'use client';

import type { SentimentTrendPoint } from '@/lib/kpi/types';
import { sentimentToStarEquivalent } from '@/components/dashboard/reputation/star-equivalent';

interface Props {
  trend: SentimentTrendPoint[];
}

const W = 640;
const H = 200;
const PAD = { l: 28, r: 16, t: 16, b: 28 };
const STAR_MIN = 1;
const STAR_MAX = 5;
const ACCENT = 'var(--rw-blue-600)';

// Clean single-line trend of the 8-week reputation (star-equivalent). One indigo
// line, no gradient fill, no pulsing peak, minimal gridlines (1/3/5). Weeks with
// no reviews (averageScore null) are gaps — the line breaks rather than implying
// a reading. The axis is explicitly labelled "star-equivalent": the underlying
// series is AVG(sentiment_score) on −1..1, never shown as a raw score.
export function ReputationTrendChart({ trend }: Props) {
  const points = trend.map((week, i) => ({
    x: PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, trend.length - 1),
    star: week.averageScore == null ? null : sentimentToStarEquivalent(week.averageScore),
    label: shortLabel(week.weekStart, i, trend.length),
  }));

  const hasData = points.some((p) => p.star != null);
  const yFor = (star: number) =>
    PAD.t + (H - PAD.t - PAD.b) * (1 - (star - STAR_MIN) / (STAR_MAX - STAR_MIN));

  // Break the line into contiguous runs so gaps (null weeks) aren't bridged.
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  for (const p of points) {
    if (p.star == null) {
      if (run.length) segments.push(run);
      run = [];
    } else {
      run.push({ x: p.x, y: yFor(p.star) });
    }
  }
  if (run.length) segments.push(run);

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Reputation trend</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-muted)' }}>
          star-equivalent · last {trend.length} weeks
        </span>
      </div>
      {hasData ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          className="chart-shell"
          width="100%"
          style={{ height: 200, display: 'block', overflow: 'visible', maxWidth: '100%' }}
          role="img"
          aria-label="Reputation trend over the last weeks, on a star-equivalent scale"
        >
          {[STAR_MIN, 3, STAR_MAX].map((star) => (
            <g key={star}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={yFor(star)}
                y2={yFor(star)}
                stroke="var(--rw-app-border-soft)"
                strokeWidth="1"
              />
              <text
                x={PAD.l - 6}
                y={yFor(star) + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--rw-app-text-muted)"
                fontFamily="var(--rw-font-body)"
              >
                {star}
              </text>
            </g>
          ))}

          {segments.map((seg, i) => (
            <polyline
              key={i}
              points={seg.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={ACCENT}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {points.map((p, i) =>
            p.star == null ? null : (
              <circle key={i} cx={p.x} cy={yFor(p.star)} r="3" fill="#fff" stroke={ACCENT} strokeWidth="2" />
            ),
          )}

          {points.map((p, i) =>
            p.label ? (
              <text
                key={`l-${i}`}
                x={p.x}
                y={H - 8}
                textAnchor="middle"
                fontSize="10"
                fill="var(--rw-app-text-muted)"
                fontFamily="var(--rw-font-body)"
              >
                {p.label}
              </text>
            ) : null,
          )}
        </svg>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', padding: '24px 0', textAlign: 'center' }}>
          Your reputation trend will appear here once a few weeks of reviews come in.
        </p>
      )}
    </div>
  );
}

function shortLabel(weekStartIso: string, idx: number, total: number): string {
  // Show ~half the labels (every other tick) to avoid crowding.
  if (idx % 2 !== 0 && idx !== total - 1) return '';
  const d = new Date(weekStartIso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
