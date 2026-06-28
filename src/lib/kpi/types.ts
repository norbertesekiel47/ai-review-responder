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
 * windowDays lookback. See `DashboardKpiSummary.reviewVolume`.
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

/**
 * Canonical analytics time-range set. The browser may request any of these via
 * `?window=`; anything else clamps to {@link DEFAULT_DASHBOARD_WINDOW}. This is
 * the ONLY set of values that may ever reach the windowed SQL (as bound
 * integers — never as interpolated text).
 */
export const DASHBOARD_WINDOWS = ['7d', '30d', '90d', '12w'] as const;

export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

/** Absent / invalid `?window=` resolves here — keeps today's behavior. */
export const DEFAULT_DASHBOARD_WINDOW: DashboardWindow = '30d';

/** The two integers a window drives. Both are compile-time constants. */
export interface DashboardWindowParams {
  /** Rolling window in days (response rate, avg star, time-to-respond, current-vs-prior buckets). */
  windowDays: number;
  /** Number of weekly points in the sentiment / velocity trend series. */
  trendWeeks: number;
}

const WINDOW_PARAMS: Record<DashboardWindow, DashboardWindowParams> = {
  '7d': { windowDays: 7, trendWeeks: 4 },
  // The default (30 days / 8-week trend) reproduces the pre-#403 behavior; this
  // table is the single owner of those legacy values now.
  '30d': { windowDays: 30, trendWeeks: 8 },
  '90d': { windowDays: 90, trendWeeks: 13 },
  '12w': { windowDays: 84, trendWeeks: 12 },
};

/** Validate + clamp an untrusted `?window=` value to the allowlisted enum. */
export function resolveDashboardWindow(
  raw: string | null | undefined,
): DashboardWindow {
  return (DASHBOARD_WINDOWS as readonly string[]).includes(raw ?? '')
    ? (raw as DashboardWindow)
    : DEFAULT_DASHBOARD_WINDOW;
}

/** The bound integers for a (already-validated) window. */
export function dashboardWindowParams(
  window: DashboardWindow,
): DashboardWindowParams {
  return WINDOW_PARAMS[window];
}
