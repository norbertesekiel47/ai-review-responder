'use client';

import { useId } from 'react';
import { scaleBand, scaleLinear } from 'd3-scale';
import { line as d3Line, curveMonotoneX } from 'd3-shape';
import { LazyMotion, domAnimation, m } from 'motion/react';
import {
  CHART_ACCENT,
  CHART_AXIS_FILL,
  CHART_AXIS_FILL_ACTIVE,
  CHART_DOT_FILL,
  CHART_FONT_BODY,
  CHART_GRID_STROKE,
} from '@/components/dashboard/charts/chart-tokens';
import { ChartTooltip } from '@/components/dashboard/charts/ChartTooltip';
import { BAR_SPRING, BAR_STAGGER_S, chartTransition, LINE_REVEAL } from '@/components/dashboard/charts/motion-presets';
import { useMeasuredSvg } from '@/components/dashboard/charts/useMeasuredSvg';
import { useNearestDatum } from '@/components/dashboard/charts/useNearestDatum';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

import { computeVelocitySummary, VELOCITY_H, VELOCITY_PAD } from '@/components/dashboard/charts/velocity-math';

export interface VelocityDatum {
  id: string;
  label: string;
  count: number;
}

const PAD = VELOCITY_PAD;
const H = VELOCITY_H;

/** Weekly bars + smoothed trend line + avg reference, on the measured-viewBox contract. */
export function VelocityChart({ data }: { data: VelocityDatum[] }) {
  const { ref, width } = useMeasuredSvg();
  const reduced = usePrefersReducedMotion();
  const uid = useId().replace(/:/g, '');
  const gradId = `velGrad${uid}`;
  const lineId = `velLine${uid}`;

  const counts = data.map((d) => d.count);
  const max = Math.max(...counts, 1);
  const { avg } = computeVelocitySummary(counts);
  const peakIdx = counts.indexOf(Math.max(...counts));
  const innerH = H - PAD.t - PAD.b;

  const xBand = scaleBand<number>()
    .domain(data.map((_, i) => i))
    .range([PAD.l, width - PAD.r])
    .paddingInner(0.5)
    .paddingOuter(0.25);
  const yScale = scaleLinear().domain([0, max]).range([PAD.t + innerH, PAD.t]);
  const barW = xBand.bandwidth();
  const centerX = (i: number) => (xBand(i) ?? PAD.l) + barW / 2;

  const linePath =
    d3Line<VelocityDatum>()
      .x((_, i) => centerX(i))
      .y((d) => yScale(d.count))
      .curve(curveMonotoneX)(data) ?? '';

  const hover = useNearestDatum(data.map((_, i) => centerX(i)));
  const hoveredDatum = hover.index != null ? data[hover.index] : undefined;
  const yTicks = Array.from(new Set([0, Math.round(max / 2), max]));

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <table className="sr-only">
        <caption>Review velocity history</caption>
        <thead>
          <tr><th scope="col">Week</th><th scope="col">Reviews</th></tr>
        </thead>
        <tbody>
          {data.map((datum, index) => (
            <tr key={datum.id}>
              <th scope="row">{datum.label || `Week ${index + 1}`}</th>
              <td>{datum.count} reviews</td>
            </tr>
          ))}
        </tbody>
      </table>
      <LazyMotion features={domAnimation} strict>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          className="chart-shell"
          style={{ height: H, display: 'block', overflow: 'visible' }}
          onPointerMove={hover.onPointerMove}
          onPointerLeave={hover.onPointerLeave}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: CHART_ACCENT, stopOpacity: 0.95 }} />
              <stop offset="100%" style={{ stopColor: CHART_ACCENT, stopOpacity: 0.32 }} />
            </linearGradient>
            <linearGradient id={lineId} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" style={{ stopColor: CHART_ACCENT, stopOpacity: 0.4 }} />
              <stop offset="100%" style={{ stopColor: CHART_ACCENT, stopOpacity: 1 }} />
            </linearGradient>
          </defs>

          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={width - PAD.r} y1={yScale(t)} y2={yScale(t)} style={{ stroke: CHART_GRID_STROKE }} strokeWidth="1" />
              <text x={PAD.l - 8} y={yScale(t) + 3} textAnchor="end" fontSize="10" style={{ fill: CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}>
                {t}
              </text>
            </g>
          ))}

          <line
            x1={PAD.l}
            x2={width - PAD.r}
            y1={yScale(avg)}
            y2={yScale(avg)}
            style={{ stroke: CHART_AXIS_FILL }}
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity="0.7"
          />
          <text
            x={width - PAD.r}
            y={yScale(avg) - 4}
            textAnchor="end"
            fontSize="9"
            fontWeight="500"
            style={{ fill: CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}
          >
            avg {avg.toFixed(1)}
          </text>

          {data.map((d, i) => {
            const xPos = xBand(i) ?? PAD.l;
            const h = (d.count / max) * innerH;
            const yPos = PAD.t + innerH - h;
            const isHover = hover.index === i;
            return (
              <g key={d.id}>
                <m.rect
                  x={xPos}
                  width={barW}
                  rx={6}
                  ry={6}
                  fill={`url(#${gradId})`}
                  initial={reduced ? false : { y: PAD.t + innerH, height: 0 }}
                  animate={{ y: yPos, height: h, opacity: hover.index == null || isHover ? 1 : 0.5 }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : {
                          y: { ...BAR_SPRING, delay: i * BAR_STAGGER_S },
                          height: { ...BAR_SPRING, delay: i * BAR_STAGGER_S },
                          opacity: { duration: 0.16 },
                        }
                  }
                />
                {i === peakIdx && (
                  <circle cx={centerX(i)} cy={yPos - 12} r="3" style={{ fill: CHART_ACCENT }}>
                    {!reduced && <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />}
                  </circle>
                )}
                <text
                  x={centerX(i)}
                  y={H - 12}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight={isHover ? 600 : 400}
                  style={{ fill: isHover ? CHART_AXIS_FILL_ACTIVE : CHART_AXIS_FILL, fontFamily: CHART_FONT_BODY }}
                >
                  {d.label}
                </text>
              </g>
            );
          })}

          {hover.index != null && (
            <line className="chart-crosshair" x1={centerX(hover.index)} x2={centerX(hover.index)} y1={PAD.t} y2={PAD.t + innerH} />
          )}

          <m.path
            d={linePath}
            fill="none"
            stroke={`url(#${lineId})`}
            strokeWidth={2}
            strokeLinecap="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={chartTransition(reduced, LINE_REVEAL)}
          />
          {data.map((d, i) => (
            <circle
              key={d.id}
              cx={centerX(i)}
              cy={yScale(d.count)}
              r={hover.index === i ? 5 : 3}
              style={{ fill: CHART_DOT_FILL, stroke: CHART_ACCENT, strokeWidth: 2, transition: 'r 160ms' }}
            />
          ))}
        </svg>
      </LazyMotion>

      {hover.index != null && hoveredDatum && (
        <ChartTooltip
          x={centerX(hover.index)}
          y={yScale(hoveredDatum.count)}
          title={`Week of ${hoveredDatum.label || `#${hover.index + 1}`}`}
          value={`${hoveredDatum.count} reviews`}
          containerWidth={width}
        />
      )}
    </div>
  );
}
