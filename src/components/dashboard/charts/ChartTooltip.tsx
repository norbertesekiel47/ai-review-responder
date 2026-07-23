'use client';

interface ChartTooltipProps {
  /** Anchor position in chart pixels (== wrapper pixels per useMeasuredSvg). */
  x: number;
  y: number;
  title: string;
  value: string;
  containerWidth: number;
}

// Must stay in sync with .chart-tip { width: 96px } in console.css.
const TIP_W = 96;
const TIP_LIFT = 52;
const EDGE = 4;

/** Dark-pill tooltip as an HTML overlay: real text, never SVG-scaled. Parent must be position:relative. */
export function ChartTooltip({ x, y, title, value, containerWidth }: ChartTooltipProps) {
  const left = Math.min(Math.max(x - TIP_W / 2, EDGE), containerWidth - TIP_W - EDGE);
  const top = Math.max(y - TIP_LIFT, EDGE);
  return (
    <div className="chart-tip" aria-hidden="true" style={{ left, top }}>
      <span className="chart-tip-title">{title}</span>
      <span className="chart-tip-value">{value}</span>
    </div>
  );
}
