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
  version: number | null;
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
    smsEnabled: boolean;
    telegramEnabled: boolean;
    whatsappEnabled: boolean;
    churnScore: ChurnScore;
  };
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
    responseVersion: number | null;
  }>;
}

// PATCH request body shape (derived from the Zod schema so it stays in sync)

export type BusinessPatch = z.infer<typeof UpdateBusinessSchema>;
