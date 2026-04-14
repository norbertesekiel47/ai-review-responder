import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

// ── Job payload (outbox → BullMQ → worker) ──────────────────────────

export interface DemoJobPayload {
  demoId: string;
  googlePlaceId: string;
  businessName: string;
  category?: string;
  googleMapsUrl?: string;
}

// ── Generator input/output ──────────────────────────────────────────

export interface DemoGeneratorInput {
  placeId: string;
  businessName: string;
  category: string | null;
}

export interface DemoGeneratorResult {
  placeId: string;
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  metadata: DemoMetadata;
}

export interface DemoMetadata {
  totalReviews: number;
  successfulResponses: number;
  failedResponses: number;
  totalCostUsd: number;
  generationDurationMs: number;
}

// ── API response shapes ─────────────────────────────────────────────

export interface DemoListItem {
  id: string;
  slug: string;
  businessName: string;
  generationStatus: string;
  generationError: string | null;
  viewCount: number;
  createdAt: string;
  expiresAt: string;
}
