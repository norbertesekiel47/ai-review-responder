'use client';

import { useState } from 'react';
import { scaleBand, scaleLinear } from 'd3-scale';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import {
  CHART_AXIS_FILL,
  CHART_FONT_BODY,
  CHART_GRID_STROKE,
  RANKING_COLORS,
} from '@/components/dashboard/charts/chart-tokens';
import { KpiSummary } from '@/components/dashboard/charts/KpiSummary';
import { BAR_SPRING, BAR_STAGGER_S, chartTransition } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { VelocityChart } from '@/components/dashboard/charts/VelocityChart';
import {
  VELOCITY_H as H,
  VELOCITY_PAD as PAD,
  computeVelocitySummary,
  weekShortLabel,
} from '@/components/dashboard/charts/velocity-math';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

// One authoritative per-location palette, shared with AggregateRankingCard so a
// location is the same color in both aggregate charts. Multi-hue on purpose:
// here color encodes WHICH location, so a single sage would erase the signal
// (unlike the owner-facing single-location chart).
const STACK_COLORS = RANKING_COLORS;

interface Props {
  reviewVelocity: AggregateDashboardData['reviewVelocity'];
  perLocationVelocity: AggregateDashboardData['perLocationVelocity'];
}

export function AggregateVelocityCard({ reviewVelocity, perLocationVelocity }: Props) {
  const [mode, setMode] = useState<'total' | 'stacked'>('total');

  const data = reviewVelocity.map((r, i) => ({
    label: weekShortLabel(r.weekStart, i, reviewVelocity.length),
    count: r.count,
  }));
  const summary = computeVelocitySummary(data.map((d) => d.count));

  return (
    <div className="card">
      <div className="card-h2-row">
        <h2>Review Velocity</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--rw-app-text-soft)' }}>
          last {data.length} weeks
        </span>
      </div>

      {/* VAL-DASH-015: stacked-by-location toggle */}
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--rw-recess)', borderRadius: 9999, width: 'fit-content', marginBottom: 14 }}>
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
        <>
          <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <KpiSummary label="This week" value={summary.lastWeek} delta={summary.deltaPct} />
            <KpiSummary label="Total · last weeks" value={summary.total} />
            <KpiSummary label="Weekly avg" value={summary.avg} />
          </div>
          <VelocityChart data={data} />
        </>
      ) : (
        <StackedVelocityChart perLocationVelocity={perLocationVelocity} />
      )}
    </div>
  );
}

function StackedVelocityChart({ perLocationVelocity }: { perLocationVelocity: AggregateDashboardData['perLocationVelocity'] }) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();

  if (perLocationVelocity.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--rw-app-text-muted)' }}>No velocity data available</div>;
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

  const innerH = H - PAD.t - PAD.b;
  const xBand = scaleBand<string>().domain(weeks).range([PAD.l, width - PAD.r]).paddingInner(0.4).paddingOuter(0.2);
  const barW = xBand.bandwidth();
  const yScale = scaleLinear().domain([0, maxStack]).range([PAD.t + innerH, PAD.t]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <LazyMotion features={domAnimation} strict>
        <svg viewBox={`0 0 ${width} ${H}`} className="chart-shell" style={{ height: H, display: 'block', overflow: 'visible' }}>
          {[0, Math.round(maxStack / 2), maxStack].map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={width - PAD.r} y1={yScale(t)} y2={yScale(t)} style={{ stroke: CHART_GRID_STROKE }} strokeWidth="1" />
              <text x={PAD.l - 8} y={yScale(t) + 3} textAnchor="end" fontSize="10" style={{ fill: CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}>
                {t}
              </text>
            </g>
          ))}

          {weeks.map((week, wi) => {
            const x = xBand(week) ?? PAD.l;
            let yOffset = 0;
            const segments = perLocationVelocity.flatMap((loc, li) => {
              const v = loc.velocity.find((entry) => entry.weekStart === week);
              const count = v?.count ?? 0;
              if (count <= 0) return [];
              const color = STACK_COLORS[li % STACK_COLORS.length]!;
              const h = (count / maxStack) * innerH;
              const y = PAD.t + innerH - yOffset - h;
              yOffset += h;
              return [{ color, y, h }];
            });

            return (
              <g key={week}>
                {segments.map((seg, si) => (
                  <m.rect
                    key={si}
                    x={x}
                    width={barW}
                    fill={seg.color}
                    opacity={0.85}
                    initial={reduced ? false : { y: PAD.t + innerH, height: 0 }}
                    animate={{ y: seg.y, height: seg.h }}
                    transition={chartTransition(reduced, BAR_SPRING, wi * BAR_STAGGER_S)}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </LazyMotion>

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
