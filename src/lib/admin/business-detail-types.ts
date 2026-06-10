// src/lib/admin/business-detail-types.ts
//
// API-contract types for `GET/PATCH /api/admin/businesses/[id]`.
//
// These intentionally live separately from `src/app/admin/businesses/[id]/types.ts`,
// which holds page-level UI shapes that are subtly different (e.g. `tone: string`
// non-nullable, `ownerName: string` non-nullable, `ChannelEnrollmentRow` for the
// channels widget). Conflating the two has been a recurring source of bugs, so
// the boundary is explicit.

import { z } from 'zod';
import { UpdateBusinessSchema } from '@/lib/shared/schemas';
import type { ChurnScore } from '@/lib/shared/churn-score';
import type {
  ApprovalMethod,
  AutoApprovalReadiness,
  AutoApprovalThreshold,
  PolicySource,
} from '@/lib/auto-approval/types';

// Raw DB row shapes (returned from `sql<...>`)

export interface BusinessRow {
  id: string;
  name: string;
  category: string | null;
  website: string | null;
  google_place_id: string | null;
  tone: string | null;
  products_services: string | null;
  staff_names: unknown;
  highlight_facts: unknown;
  avoid_facts: unknown;
  sample_responses: unknown;
  subscription_status: string;
  subscription_tier: string;
  owner_name: string | null;
  owner_email: string | null;
  last_sync_at: Date | null;
  tracked_keywords: unknown;
  google_place_lat: number | null;
  google_place_lng: number | null;
  ranking_search_location: string | null;
  google_place_address: string | null;
  owner_email_bounced: boolean | null;
  account_id: string;
  display_label: string | null;
  is_primary: boolean;
}

export interface RankingSnapshotRow {
  keyword: string;
  rank_position: number | null;
  snapshot_date: string;
  source: string;
}

export interface ReviewRow {
  id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: string | null;
  detected_language: string | null;
  review_status: string;
  detected_at: Date | null;
  response_id: string | null;
  response_status: string | null;
  response_text: string | null;
  approved_text: string | null;
  approval_method: ApprovalMethod | null;
  version: number | null;
}

// Zernio connection panel — DB row + API shapes
//
// `getZernioPanel()` returns the snapshot needed to render the
// "Zernio Connection" admin panel (current connection state, queued
// awaiting_owner_connect responses, and unresolved finalize incidents).
// Kept on the response so the existing `useBusinessDetail` query covers
// it without adding a second round-trip.

export interface ZernioConnectionRow {
  status: 'pending' | 'active' | 'disconnected';
  connected_at: Date | null;
  disconnected_at: Date | null;
  disconnect_reason: string | null;
  last_error: string | null;
  last_error_at: Date | null;
  zernio_account_id: string;
  zernio_location_id: string;
}

export interface AwaitingOwnerConnectRow {
  id: string;
  created_at: Date;
  draft_text: string | null;
  reviewer_name: string;
  review_text: string | null;
  star_rating: number;
}

export interface ZernioFinalizeIncidentRow {
  id: string;
  finalize_unknown_at: Date;
  flow_id: string;
  zernio_profile_id: string;
}

export interface ZernioPanelData {
  connection: {
    status: 'pending' | 'active' | 'disconnected';
    connectedAt: string | null;
    disconnectedAt: string | null;
    disconnectReason: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    zernioAccountId: string;
    zernioLocationId: string;
  } | null;
  awaitingOwnerConnect: Array<{
    responseId: string;
    createdAt: string;
    draftText: string | null;
    reviewerName: string;
    reviewText: string | null;
    starRating: number;
  }>;
  unresolvedIncidents: Array<{
    id: string;
    finalizeUnknownAt: string;
    flowId: string;
    zernioProfileId: string;
  }>;
}

// Account context for multi-location support (VAL-ADMIN-001)

export interface AccountLocationSummary {
  id: string;
  name: string;
  displayLabel: string | null;
  isPrimary: boolean;
  archivedAt: string | null;
}

export interface AccountContext {
  id: string;
  displayName: string;
  subscriptionTier: string;
  subscriptionStatus: string;
  locations: AccountLocationSummary[];
}

// Audit log entry returned in business detail (VAL-ADMIN-004)

export interface ApprovalAuditLogEntry {
  id: string;
  responseId: string;
  action: string;
  actorUserId: string | null;
  createdAt: string;
}

export interface AccountAuditLogEntry {
  id: string;
  eventType: string;
  actorUserId: string | null;
  locationId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AutoApprovalPolicyDiagnostic {
  policyId: string | null;
  threshold: AutoApprovalThreshold | null;
  exists: boolean;
}

export interface AutoApprovalLocationDiagnostic {
  locationId: string;
  displayName: string;
  isPrimary: boolean;
  archivedAt: string | null;
  override: AutoApprovalPolicyDiagnostic;
  effective: {
    threshold: AutoApprovalThreshold | null;
    source: PolicySource;
    policyId: string | null;
  };
}

export interface AutoApprovalDiagnostics {
  accountDefault: AutoApprovalPolicyDiagnostic;
  locations: AutoApprovalLocationDiagnostic[];
  readiness: AutoApprovalReadiness;
  recentApprovalAudit: ApprovalAuditLogEntry[];
  recentPolicyChanges: AccountAuditLogEntry[];
}

// HTTP response shape for GET

export interface BusinessDetailResponse {
  business: {
    id: string;
    name: string;
    category: string | null;
    website: string | null;
    googlePlaceId: string | null;
    tone: string | null;
    productsServices: string | null;
    staffNames: string[];
    highlightFacts: string[];
    avoidFacts: string[];
    sampleResponses: string[];
    subscriptionStatus: string;
    subscriptionTier: string;
    ownerName: string | null;
    ownerEmail: string | null;
    lastSyncAt: string | null;
    trackedKeywords: string[];
    googlePlaceLat: number | null;
    googlePlaceLng: number | null;
    rankingSearchLocation: string | null;
    googlePlaceAddress: string | null;
    ownerEmailBounced: boolean;
    telegramEnabled: boolean;
    whatsappEnabled: boolean;
    churnScore: ChurnScore;
  };
  account: AccountContext;
  rankingSnapshots: Array<{
    keyword: string;
    rankPosition: number | null;
    snapshotDate: string;
    source: string;
  }>;
  reviews: Array<{
    id: string;
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
    reviewDate: string | null;
    detectedLanguage: string | null;
    detectedAt: string | null;
    responseId: string | null;
    responseStatus: string | null;
    responseText: string | null;
    approvedText: string | null;
    approvalMethod: ApprovalMethod | null;
    responseVersion: number | null;
  }>;
  zernio: ZernioPanelData;
  approvalAuditLog: ApprovalAuditLogEntry[];
  accountAuditLog: AccountAuditLogEntry[];
  autoApproval: AutoApprovalDiagnostics;
}

// PATCH request body shape (derived from the Zod schema so it stays in sync)

export type BusinessPatch = z.infer<typeof UpdateBusinessSchema>;
