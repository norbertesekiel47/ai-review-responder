'use client';

import { scaleLinear, scalePoint } from 'd3-scale';
import { line as d3Line } from 'd3-shape';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { RankingChartSeries } from '@/components/dashboard/kpi/RankingChart.helpers';
import { chartTransition, LINE_REVEAL, LINE_STAGGER_S } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

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
const H = 240;

// Warm Editorial emphasis colors for the owner-facing default; the multi-hue
// per-series ramp lives in chart-tokens (RANKING_COLORS) via the helpers.
const OWNER_PRIMARY = 'var(--rw-sage-deep)';
const OWNER_FADED = 'var(--rw-app-text-soft)';

export function RankingChart({
  series,
  formatSeriesLabel = (keyword) => keyword,
  labelFontSize = '10',
  labelFontWeight = '600',
  emphasis = 'owner',
}: RankingChartProps) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

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

  const x = scalePoint<string>().domain(allDates).range([PAD.l, width - PAD.r]);
  const xFor = (date: string) => x(date) ?? PAD.l;
  const y = scaleLinear().domain([minRank, maxRank]).range([PAD.t, H - PAD.b]);
  const yTicks = [1, Math.ceil((maxRank + 1) / 2), maxRank];

  // In owner mode the first series is the headline series (sage, bold); the
  // rest recede. In series mode every line keeps its own legend color.
  const colorFor = (s: RankingChartSeries, si: number) =>
    emphasis === 'series' ? s.color : si === 0 ? OWNER_PRIMARY : OWNER_FADED;
  const isFaded = (si: number) => emphasis === 'owner' && si > 0;

  return (
    <div ref={ref}>
      <LazyMotion features={domAnimation} strict>
        <svg viewBox={`0 0 ${width} ${H}`} className="chart-shell tall" style={{ height: H }}>
          {yTicks.map((t, i) => (
            <g key={i}>
              <line className="rank-grid" x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} strokeDasharray="3 3" />
              <text className="rank-axis" x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10">
                #{t}
              </text>
            </g>
          ))}
          {allDates.map((date) => (
            <text key={date} className="rank-axis" x={xFor(date)} y={H - 10} textAnchor="middle" fontSize="10">
              {labelByDate.get(date) ?? ''}
            </text>
          ))}
          {series.map((s, si) => {
            const sorted = s.points.toSorted((a, b) => a.date.localeCompare(b.date));
            const path =
              d3Line<(typeof sorted)[number]>()
                .x((p) => xFor(p.date))
                .y((p) => y(p.position))(sorted) ?? '';
            const last = sorted[sorted.length - 1];
            if (!last) return null;
            const color = colorFor(s, si);
            const faded = isFaded(si);
            return (
              <g key={`${s.keyword}-${si}`} style={{ opacity: faded ? 0.65 : 1 }}>
                <m.path
                  d={path}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ stroke: color, strokeWidth: faded ? 1.5 : 2.5 }}
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={chartTransition(reduced, LINE_REVEAL, si * LINE_STAGGER_S)}
                />
                {sorted.map((p, pi) => (
                  <circle
                    key={`${si}-${pi}-${p.date}`}
                    cx={xFor(p.date)}
                    cy={y(p.position)}
                    r={faded ? 2.5 : 3}
                    style={{ fill: 'var(--rw-card)', stroke: color, strokeWidth: 2 }}
                  />
                ))}
                <text
                  x={xFor(last.date) + 8}
                  y={y(last.position) + 3}
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
      </LazyMotion>
    </div>
  );
}
