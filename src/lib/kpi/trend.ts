import type { SentimentTrendPoint } from './types';

/** Raw zero-filled weekly sentiment row as returned by the trend SQL. */
export interface SentimentTrendRow {
  week_start: unknown;
  avg_score: unknown;
  cnt: unknown;
}

/**
 * Maps zero-filled weekly sentiment rows — AVG(sentiment_score) on a −1..1
 * scale — to the SentimentTrendPoint series. Single owner of the trend shape,
 * shared by the KPI service (kpi/service.ts) and the dashboard reputation
 * metrics (lib/dashboard/reputation-metrics.ts) so the two can't drift.
 */
export function mapSentimentTrend(rows: readonly SentimentTrendRow[]): SentimentTrendPoint[] {
  return rows.map((r) => ({
    weekStart: String(r.week_start),
    averageScore: r.avg_score == null ? null : roundTo(Number(r.avg_score), 2),
    reviewCount: Number(r.cnt ?? 0),
  }));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
