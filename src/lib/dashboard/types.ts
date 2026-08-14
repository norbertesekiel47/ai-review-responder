import type { ApprovalMethod } from '@/lib/auto-approval/types';
import type { OpenEscalationStatus } from '@/lib/escalations/types';
import type { TriageSeverity } from '@/lib/reviews/triage-schema';

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

/** A windowed metric with an honest prior-period comparison (PLAN.md PR2). */
export interface ReputationMetric {
  /** Current 30-day value; null when the current window has no qualifying sample. */
  current: number | null;
  /** current − prior, in the metric's own unit. null when the prior window has
   *  zero sample (per-metric delta suppression — PLAN.md C.13). */
  delta: number | null;
  /** Size of the prior window's sample; drives the delta suppression above. */
  priorSampleSize: number;
}

/** Reputation-health summary for the redesigned single-location landing.
 *  Opt-in (route passes includeReputationMetrics) so the aggregate path stays light. */
export interface ReputationSummary {
  /** Average star rating (1–5); delta in rating points. */
  averageStar: ReputationMetric;
  /** Response rate (0–100); delta in percentage points. */
  responseRate: ReputationMetric;
  /** Time saved in the window, in MINUTES; delta in minutes. */
  timeSavedMinutes: ReputationMetric;
  /** Owner drafts awaiting approval (excludes held/flagged) — authoritative SQL count. */
  pendingApprovalCount: number;
  /** 8-week star-equivalent reputation trend derived from sentiment_score. */
  trend: Array<{
    weekStart: string;
    /** clamp(3 + 2·avgScore, 1, 5); null for weeks with no reviews. */
    starEquivalent: number | null;
    reviewCount: number;
  }>;
  /** True while the location is too young for trustworthy deltas; the hero
   *  renders compact (current values, no delta arrows) — PLAN.md C.14. */
  isRamping: boolean;
}

/**
 * Reviews-by-rating distribution across the selected analytics window (#405).
 * A TRUE aggregate over every rated review in the window — NOT the capped
 * `recentReviews` sample. `counts` is always 5 entries ordered 5★→1★ and
 * zero-filled, so the card can map it without re-bucketing.
 */
export interface RatingBreakdown {
  counts: Array<{ stars: number; count: number }>;
  /** Sum of all star buckets — rated reviews in the window. */
  total: number;
}

/** Owner-facing value rollup — one wire shape for BOTH dashboard scopes. */
export interface ValueSummary {
  totalReviewsHandled: number;
  totalTimeSavedMinutes: number;
  currentResponseRate: number;
  baselineResponseRate: number | null;
}

interface ReviewFeedReviewFields {
  id: string;
  reviewerName: string;
  starRating: number | null;
  reviewText: string | null;
  reviewDate: string;
  status: string;
}

interface ReviewFeedResponseFields {
  responseText: string | null;
  responseStatus: string | null;
  approvalMethod: ApprovalMethod | null;
  /** Current auto-post deadline from the latest response; never derived or cached. */
  autoPostScheduledAt: Date | string | null;
  /** Open Guardian escalation; resolved escalations never enter the feed. */
  escalation: {
    id: string;
    status: OpenEscalationStatus;
    severity: TriageSeverity;
  } | null;
}

/** Review-feed fields shared by per-location and aggregate dashboard payloads. */
type ReviewFeedItem = ReviewFeedReviewFields & ReviewFeedResponseFields;

export interface DashboardDataActive {
  subscriptionStatus?: never;
  /**
   * ISO timestamp when a card-up-front trial ends. Non-null only while the
   * account is `trialing` (trial_ends_at IS NOT NULL ⟺ status='trialing').
   * Drives the "Trial — N days left" dashboard banner. `null`/absent for paid
   * active accounts, which render no trial banner.
   */
  trialEndsAt?: string | null;
  business: { name: string; createdAt: string };
  valueSummary: ValueSummary;
  /** Reputation-health metrics for the redesigned landing. Only populated when
   *  the route requests includeReputationMetrics (single-location landing);
   *  absent on the aggregate / lighter paths. */
  reputationSummary?: ReputationSummary;
  /** Windowed reviews-by-rating aggregate (#405) — distribution across the
   *  selected analytics window, scoped to this location. */
  ratingBreakdown: RatingBreakdown;
  reviewVelocity: Array<{ weekStart: string; count: number }>;
  ranking: Array<{
    keyword: string;
    snapshots: Array<{ date: string; position: number }>;
  }> | null;
  recentReviews: ReviewFeedItem[];
  latestBrief: {
    text: string;
    type: 'monthly' | 'weekly';
    periodLabel: string;
  } | null;
  settings: DashboardSettings;
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
  /**
   * Server-computed funnel entry point (`resolveFunnelEntry`) — replaces the
   * old hardcoded `paymentUrl`, which was always `/onboarding/pay` and
   * therefore skipped the pre-pay demo lane for owners owed it. Nullable so the
   * screen keeps an honest "unavailable" branch for a payload that predates the
   * field; the route always sends one.
   */
  funnelUrl?: string | null;
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
export interface AggregateReviewItem
  extends ReviewFeedReviewFields, ReviewFeedResponseFields {
  locationId: string;
  locationDisplayName: string;
}

/** The full aggregate dashboard data shape. */
export interface AggregateDashboardData {
  /** Discriminator: always 'aggregate' to distinguish from per-location DashboardData. */
  scope: 'aggregate';
  /** Aggregate value summary — sums across all active locations. */
  valueSummary: ValueSummary;
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
  /** Windowed reviews-by-rating aggregate (#405) — summed across all active
   *  locations of the account, over the selected analytics window. */
  ratingBreakdown: RatingBreakdown;
  /** Combined recent reviews from all locations with location chips. */
  recentReviews: AggregateReviewItem[];
  /** Per-location briefs for grouped display. */
  perLocationBriefs: PerLocationBrief[];
  /** Per-location KPI strip data (one entry per active location). */
  locationKpis: PerLocationKpi[];
  /** Number of active locations (for UI display). */
  activeLocationCount: number;
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
