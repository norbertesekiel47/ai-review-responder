'use client';

interface ChartTooltipProps {
  /** Anchor position in chart pixels (== wrapper pixels per useMeasuredSvg). */
  x: number;
  y: number;
  title: string;
  value: string;
  /**
   * Optional change-vs-previous-point line (e.g. "↑ 0.2★ vs prior week"),
   * derived deterministically by the caller — never invented here.
   */
  delta?: string;
  containerWidth: number;
}

/**
 * The delta line's one grammar, shared by every chart that feeds `delta`:
 * arrow + magnitude + "vs prior week", or the flat form. `fmt` renders the
 * magnitude in the chart's own unit ("0.2★", "2"). Callers pass the change
 * vs the previous PLOTTED point — derived, never invented.
 */
export function weekOverWeekDeltaLabel(diff: number, fmt: (n: number) => string): string {
  if (diff === 0) return '→ no change';
  return `${diff > 0 ? '↑' : '↓'} ${fmt(Math.abs(diff))} vs prior week`;
}

// Must stay in sync with .chart-tip { width: 116px } in console.css.
const TIP_W = 116;
const TIP_LIFT = 52;
const DELTA_LIFT = 14;
const EDGE = 4;

/** Dark-pill tooltip as an HTML overlay: real text, never SVG-scaled. Parent must be position:relative. */
export function ChartTooltip({ x, y, title, value, delta, containerWidth }: ChartTooltipProps) {
  const left = Math.min(Math.max(x - TIP_W / 2, EDGE), containerWidth - TIP_W - EDGE);
  const top = Math.max(y - TIP_LIFT - (delta ? DELTA_LIFT : 0), EDGE);
  return (
    <div className="chart-tip" aria-hidden="true" style={{ left, top }}>
      <span className="chart-tip-title">{title}</span>
      <span className="chart-tip-value">{value}</span>
      {delta && <span className="chart-tip-delta">{delta}</span>}
    </div>
  );
}
