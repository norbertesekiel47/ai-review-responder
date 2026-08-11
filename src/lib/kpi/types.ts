// Canonical analytics window vocabulary for the dashboard payload. Formerly
// also held the Spec-11 launch KPI summary types; those died with the
// consumer-less Stack A KPI service (#757, Pathfinder P1). The Review-time
// anchor fragments live beside this file in ./fragments.ts.

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
