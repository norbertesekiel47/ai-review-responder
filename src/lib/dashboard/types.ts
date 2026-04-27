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

export type DashboardData =
  | DashboardDataActive
  | DashboardDataPendingPayment
  | DashboardDataPendingAdminHandoff
  | DashboardDataActivePendingBusiness;
