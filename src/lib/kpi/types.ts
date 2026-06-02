// Launch KPI summary (Spec 11). Distinct from dashboard valueSummary (lifetime
// metrics) — these are windowed (last 30 days / calendar-month / 8-week trend),
// scoped per-location (business_id) or per-account (all active locations).

export interface KpiResponseRate {
  /** Reviews received in the window that have a handled response. */
  handled: number;
  /** Reviews received in the window (not deleted). */
  received: number;
  /** round(handled/received*100); null when received = 0. */
  ratePct: number | null;
}

/**
 * Calendar-month based (current vs prior calendar month), NOT the rolling
 * KPI_WINDOW_DAYS window. See `DashboardKpiSummary.reviewVolume`.
 */
export interface KpiReviewVolume {
  currentMonth: number;
  priorMonth: number;
  /** round((current-prior)/prior*100); null when prior = 0. */
  deltaPct: number | null;
}

export interface SentimentTrendPoint {
  /** ISO date (week start, Monday per DATE_TRUNC('week', ...)). */
  weekStart: string;
  /** AVG(sentiment_score) that week; null when no reviews. */
  averageScore: number | null;
  reviewCount: number;
}

export type KpiScope =
  | { kind: 'location'; businessId: string }
  | { kind: 'account'; accountId: string };

export interface DashboardKpiSummary {
  scope: KpiScope;
  /**
   * Rolling window in days for response rate, avg star rating, time-to-respond,
   * and sentiment-trend lookback. `reviewVolume` is the calendar-month exception
   * — it uses current vs prior calendar month regardless of this value.
   */
  windowDays: number;
  responseRate: KpiResponseRate;
  /** AVG(star_rating) over the window, 2 decimals; null when none. */
  averageStarRating: number | null;
  reviewVolume: KpiReviewVolume;
  /** Owner-action latency (approved_at - detected_at) in hours, 1 decimal; null when none. */
  averageTimeToRespondHours: number | null;
  /** 8-week ascending sentiment series. */
  sentimentTrend: SentimentTrendPoint[];
}

export const KPI_WINDOW_DAYS = 30;
