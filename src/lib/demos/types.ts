import type { BasePayload } from '@/lib/shared/worker-types';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

// ── Job payload (outbox → BullMQ → worker) ──────────────────────────

export interface DemoJobPayload extends BasePayload {
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

// ── generation_status vocabulary ──────────────────────────────────────

/**
 * The persisted `generation_status` values of `onboarding_demos` — byte-for-byte
 * the CHECK constraint in migration 032 (`prospect_demos` shares the set minus
 * `archived`, which it never writes). `generation-status-contract.test.ts`
 * fails when this object and the migration's CHECK list drift apart.
 */
export const DEMO_GENERATION_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ARCHIVED: 'archived',
} as const;

export type DemoGenerationStatus =
  (typeof DEMO_GENERATION_STATUS)[keyof typeof DEMO_GENERATION_STATUS];

/**
 * UI-only sentinel for `/onboarding/demo` when the owner has a captured
 * location but NO `onboarding_demos` row (the enqueue was skipped: cost
 * ceiling, rate limit, allowlist). The page synthesizes it in memory so the
 * paywall still renders; it is NEVER written to Postgres, which is why it is
 * absent from migration 032's CHECK on purpose (#1104). Keep it out of
 * `DemoGenerationStatus` so no write site can type-check with it.
 */
export const NO_DEMO_SENTINEL_STATUS = 'skipped' as const;

/** What `PaywallWithDemoClient` can receive: a persisted status or the sentinel. */
export type OnboardingDemoViewStatus =
  | DemoGenerationStatus
  | typeof NO_DEMO_SENTINEL_STATUS;

// ── Lifecycle table parameter ─────────────────────────────────────────

export type DemoTable = 'prospect_demos' | 'onboarding_demos';

// ── Selection rules ───────────────────────────────────────────────────

export type SelectionRule = 'newest' | 'positive-with-moderate-tail';

export interface SelectQualifyingOptions {
  rule: SelectionRule;
}

// ── Lifecycle result types ────────────────────────────────────────────

/**
 * Outcome of `claimDemo`:
 *
 * - `'claimed'`           — row transitioned queued → running, caller proceeds
 * - `'already_terminal'`  — row is `completed | failed | archived`, drop the job
 * - `'race_lost'`         — row is no longer `queued` but not necessarily terminal
 *                            (another worker won the queued → running CAS, or
 *                            already raced through to a terminal state). Caller
 *                            should treat the same as `'already_terminal'` —
 *                            drop the job and complete the outbox.
 * - `'not_found'`         — row does not exist; drop the job
 * - `'reset_to_queued'`   — row was stuck in `running` >5min; reset to `queued`
 *                            and caller should throw so BullMQ re-dispatches
 */
export type ClaimResult =
  | 'claimed'
  | 'already_terminal'
  | 'race_lost'
  | 'not_found'
  | 'reset_to_queued';

export interface CompleteDemoArgs {
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  /** Optional — omitted for prospect_demos (schema has DEFAULT 'serpapi') */
  source?: 'serpapi' | 'curated_fallback';
}
