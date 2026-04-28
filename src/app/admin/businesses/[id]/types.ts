export interface BusinessDetail {
  id: string;
  name: string;
  category: string | null;
  website: string | null;
  googlePlaceId: string | null;
  tone: string;
  productsServices: string | null;
  staffNames: string[];
  highlightFacts: string[];
  avoidFacts: string[];
  sampleResponses: string[];
  subscriptionStatus: string;
  subscriptionTier: string;
  ownerName: string;
  ownerEmail: string;
  lastSyncAt: string | null;
  trackedKeywords: string[];
  googlePlaceLat: number | null;
  googlePlaceLng: number | null;
  rankingSearchLocation: string | null;
  googlePlaceAddress: string | null;
  ownerEmailBounced: boolean;
  smsEnabled: boolean;
  telegramEnabled: boolean;
  whatsappEnabled: boolean;
  churnScore?: {
    score: number;
    level: 'healthy' | 'watch' | 'at_risk';
    breakdown: Array<{ signal: string; value: string; contribution: number }>;
  };
}

export interface ReviewRow {
  id: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string | null;
  detectedLanguage: string | null;
  detectedAt: string;
  responseId: string | null;
  responseStatus: string | null;
  responseText: string | null;
  approvedText: string | null;
  responseVersion: number | null;
}

export interface RankingSnapshot {
  keyword: string;
  rankPosition: number | null;
  snapshotDate: string;
  source: string;
}

export interface DetailData {
  business: BusinessDetail;
  reviews: ReviewRow[];
  rankingSnapshots: RankingSnapshot[];
  zernio: ZernioPanelData;
}

export interface ZernioConnectionSummary {
  status: 'pending' | 'active' | 'disconnected';
  connectedAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  zernioAccountId: string;
  zernioLocationId: string;
}

export interface AwaitingOwnerConnectResponse {
  responseId: string;
  createdAt: string;
  draftText: string | null;
  reviewerName: string;
  reviewText: string | null;
  starRating: number;
}

export interface ZernioFinalizeIncident {
  id: string;
  finalizeUnknownAt: string;
  flowId: string;
  zernioProfileId: string;
}

export interface ZernioPanelData {
  connection: ZernioConnectionSummary | null;
  awaitingOwnerConnect: AwaitingOwnerConnectResponse[];
  unresolvedIncidents: ZernioFinalizeIncident[];
}

export interface ChannelEnrollmentRow {
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
  handle: string;
  status: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  last_activity_at: string | null;
}
