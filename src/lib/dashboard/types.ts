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
  }>;
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

export interface DashboardDataPastDue {
  subscriptionStatus: 'past_due';
  businessName: string;
  /** URL to the Stripe billing portal for updating payment method. */
  billingPortalUrl: string | null;
}

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
  /** VAL-DASH-029: When the requested scope location is archived, the API
   *  falls back to primary and returns this indicator so the client can
   *  update the switcher. Only set when a fallback occurred. */
  scopeFallback?: {
    reason: 'location_archived' | 'location_not_found';
    fallbackLocationId: string;
  };
}
