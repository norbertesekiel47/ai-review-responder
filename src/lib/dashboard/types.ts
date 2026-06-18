import type { ApprovalMethod } from '@/lib/auto-approval/types';
import type { SentimentTrendPoint } from '@/lib/kpi/types';

/**
 * One hero metric with its current value and a typed, unit-correct change vs the
 * prior 30-day window. `delta` is expressed in the metric's NATURAL unit
 * (rating points / percentage points / minutes), never a generic percent. It is
 * null when `priorSample === 0` so the UI can suppress that arrow entirely
 * (per-metric suppression — a mature low-volume business still shows the deltas
 * it has, rather than hiding all of them forever).
 */
export interface ReputationDelta<T> {
  value: T;
  delta: number | null;
  /** Size of the prior-window sample the delta is based on (reviews / handled). */
  priorSample: number;
}

/**
 * Reputation/ROI hero metrics for the single-location dashboard landing.
 * OPTIONAL on DashboardDataActive: only populated when the dashboard landing
 * path opts in via getActiveDashboardData(id, { includeReputationMetrics: true }).
 * The aggregate path and other per-location consumers (e.g. /dashboard/connect)
 * leave it unset and fall back to the lifetime valueSummary.
 */
export interface ReputationSummary {
  /** AVG(star_rating) last 30d; delta in rating points. value null when no rated reviews. */
  averageStarRating: ReputationDelta<number | null>;
  /** Response rate (0–100) last 30d; value + delta in percentage points. value null when no reviews. */
  responseRate: ReputationDelta<number | null>;
  /** Owner-approved responses × per-response minutes, last 30d; delta in minutes. */
  timeSavedMinutes: ReputationDelta<number>;
  /** True when the location is younger than the trust threshold — render the
   *  hero compact (current values, no arrows, "still building baseline" copy). */
  ramping: boolean;
  /** SQL count of owner-visible drafts awaiting approval (open-flagged excluded). */
  pendingApprovalCount: number;
  /** 8-week ascending sentiment series (−1..1 AVG); the UI maps it to a
   *  star-equivalent for the reputation trend chart, never showing the raw score. */
  sentimentTrend: SentimentTrendPoint[];
}

export interface DashboardSettings {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
  ownerPhone: string;
  ownerEmail: string;
  weeklySummaryEnabled: boolean;
  monthlyImpactEnabled: boolean;
  category: string;
  googlePlaceId: string;
}

export interface DashboardDataActive {
  subscriptionStatus?: never;
  business: { name: string; createdAt: string };
  valueSummary: {
    totalReviewsHandled: number;
    totalTimeSavedMinutes: number;
    currentResponseRate: number;
    baselineResponseRate: number | null;
  };
  reviewVelocity: Array<{ weekStart: string; count: number }>;
  ranking: Array<{
    keyword: string;
    snapshots: Array<{ date: string; position: number }>;
  }> | null;
  recentReviews: Array<{
    id: string;
    reviewerName: string;
    starRating: number | null;
    reviewText: string | null;
    reviewDate: string;
    status: string;
    responseText: string | null;
    responseStatus: string | null;
    approvalMethod: ApprovalMethod | null;
  }>;
  latestBrief: {
    text: string;
    type: 'monthly' | 'weekly';
    periodLabel: string;
  } | null;
  settings: DashboardSettings;
  /** Reputation/ROI hero metrics — present only on the opted-in dashboard
   *  landing path; absent on aggregate and other per-location consumers. */
  reputationSummary?: ReputationSummary;
  zernioConnection: {
    status: 'none' | 'pending' | 'active' | 'disconnected' | 'finalize_unknown';
    pendingFlow?: {
      status: 'starting' | 'oauth_in_progress' | 'finalizing' | 'finalize_unknown';
      started_at: number;
    };
    queuedReconnectCount: number;
    hasUnresolvedIncident: boolean;
    lastDisconnectReason?: string;
  };
  /** VAL-DASH-029: When the requested scope location is archived or not found,
   *  the API falls back to primary and returns this indicator so the client
   *  can update the switcher. Only set when a fallback occurred. */
  scopeFallback?: {
    reason: 'location_archived' | 'location_not_found';
    fallbackLocationId: string;
  };
}

export interface DashboardDataPendingPayment {
  subscriptionStatus: 'pending_payment';
  businessId: string;
  businessName: string;
  paymentUrl: string | null;
}

export interface DashboardDataPendingAdminHandoff {
  subscriptionStatus: 'pending_payment_admin_handoff';
  businessId: string;
  businessName: string;
}

export interface DashboardDataActivePendingBusiness {
  subscriptionStatus: 'active_pending_business';
  businessId: string;
  businessName: string;
}

export interface DashboardDataCancelled {
  subscriptionStatus: 'cancelled';
  businessName: string;
  /** Date when the grace period ends (30 days from cancellation). */
  gracePeriodEndDate: string | null;
  /** Whether the account still has read access (within grace period). */
  readAccess: boolean;
}

export interface DashboardPastDueFields {
  subscriptionStatus: 'past_due';
  accountId: string;
  businessName: string;
  /** URL to the Stripe billing portal for updating payment method. */
  billingPortalUrl: string | null;
  /** Timestamp when Stripe first marked the account past-due. */
  pastDueAt: string | null;
  /** Timestamp when the past-due recovery window closes. */
  pastDueDeadline: string | null;
  /** Whole days remaining before read-only mode, or null when unavailable. */
  daysRemaining: number | null;
  /** True once owner write actions must be blocked. */
  isReadOnly: boolean;
}

export type DashboardDataPastDue = Omit<DashboardDataActive, 'subscriptionStatus'> & DashboardPastDueFields;

export type DashboardData =
  | DashboardDataActive
  | DashboardDataPendingPayment
  | DashboardDataPendingAdminHandoff
  | DashboardDataActivePendingBusiness
  | DashboardDataCancelled
  | DashboardDataPastDue;

// ── Aggregate Dashboard Data ──────────────────────────────────────────────
// Returned by /api/dashboard?scope=all when the account has multiple
// active locations. Each per-location entry carries enough data to render
// the KPI strip and location chips. Aggregate sums are computed server-side.

/** Per-location summary used in the KPI strip and as grouping key. */
export interface PerLocationKpi {
  locationId: string;
  displayName: string; // display_label ?? name
  isPrimary: boolean;
  totalReviewsHandled: number;
  pendingApprovalCount: number;
  recentReviewCount: number;
  /** VAL-DASH-028: True when Stripe overage webhook has not yet confirmed
   *  the quantity update for this location (active count > locations_paid + locations_included). */
  billingPending: boolean;
}

/** Per-location review velocity for stacked-by-location chart mode. */
export interface PerLocationVelocity {
  locationId: string;
  displayName: string;
  velocity: Array<{ weekStart: string; count: number }>;
}

/** Per-location ranking for stacked-by-location chart mode. */
export interface PerLocationRanking {
  locationId: string;
  displayName: string;
  ranking: Array<{
    keyword: string;
    snapshots: Array<{ date: string; position: number }>;
  }> | null;
}

/** Per-location intelligence brief with location prefix. */
export interface PerLocationBrief {
  locationId: string;
  displayName: string;
  brief: {
    text: string;
    type: 'monthly' | 'weekly';
    periodLabel: string;
  } | null;
}

/** Review row extended with location chip data for the aggregate feed. */
export interface AggregateReviewItem {
  id: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  reviewDate: string;
  status: string;
  responseText: string | null;
  responseStatus: string | null;
  approvalMethod: ApprovalMethod | null;
  locationId: string;
  locationDisplayName: string;
}

/** The full aggregate dashboard data shape. */
export interface AggregateDashboardData {
  /** Discriminator: always 'aggregate' to distinguish from per-location DashboardData. */
  scope: 'aggregate';
  /** Aggregate value summary — sums across all active locations. */
  valueSummary: {
    totalReviewsHandled: number;
    totalTimeSavedMinutes: number;
    currentResponseRate: number;
    baselineResponseRate: number | null;
  };
  /** Combined review velocity (total) across all locations. */
  reviewVelocity: Array<{ weekStart: string; count: number }>;
  /** Per-location velocity for stacked chart mode. */
  perLocationVelocity: PerLocationVelocity[];
  /** Aggregate ranking (best position across locations per keyword). */
  ranking: Array<{
    keyword: string;
    snapshots: Array<{ date: string; position: number }>;
  }> | null;
  /** Per-location ranking for stacked chart mode. */
  perLocationRanking: PerLocationRanking[];
  /** Combined recent reviews from all locations with location chips. */
  recentReviews: AggregateReviewItem[];
  /** Per-location briefs for grouped display. */
  perLocationBriefs: PerLocationBrief[];
  /** Per-location KPI strip data (one entry per active location). */
  locationKpis: PerLocationKpi[];
  /** Number of active locations (for UI display). */
  activeLocationCount: number;
  /** Locations whose per-location dashboard query failed while building aggregate data. */
  partialFailures?: Array<{ locationId: string; displayName: string }>;
  /** Present when the account is past_due but aggregate read access remains available. */
  subscriptionStatus?: 'past_due';
  accountId?: string;
  businessName?: string;
  billingPortalUrl?: string | null;
  pastDueAt?: string | null;
  pastDueDeadline?: string | null;
  daysRemaining?: number | null;
  isReadOnly?: boolean;
  /** VAL-DASH-029: When the requested scope location is archived, the API
   *  falls back to primary and returns this indicator so the client can
   *  update the switcher. Only set when a fallback occurred. */
  scopeFallback?: {
    reason: 'location_archived' | 'location_not_found';
    fallbackLocationId: string;
  };
}
