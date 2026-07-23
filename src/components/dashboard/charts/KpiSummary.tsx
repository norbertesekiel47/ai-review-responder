import { CHART_ACCENT, CHART_DANGER, CHART_FONT_DISPLAY } from '@/components/dashboard/charts/chart-tokens';

interface KpiSummaryProps {
  label: string;
  value: number;
  delta?: number;
}

/** One stat in the row above a velocity chart (This week / Total / Weekly avg). */
export function KpiSummary({ label, value, delta }: KpiSummaryProps) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--rw-app-text-muted)', fontWeight: 500, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: CHART_FONT_DISPLAY, fontWeight: 700, fontSize: 24, letterSpacing: '-0.02em' }}>
          {value}
        </span>
        {delta != null && (
          <span style={{ fontSize: 12, fontWeight: 600, color: delta >= 0 ? CHART_ACCENT : CHART_DANGER }}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
