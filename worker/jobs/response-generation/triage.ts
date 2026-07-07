// worker/jobs/response-generation/triage.ts
//
// WS2 triage phase of the response generator: flag gate → lane eligibility
// (non-positive sentiment only) → durable idempotency check (triage_content_hash)
// → cost-guarded classification → transactional persist + guardian step.
// Returns the severity for tone guidance (null = not triaged). Transient
// classification errors propagate so BullMQ retries the whole job — the
// committed-triage hash check makes the retry spend-free.
//
// Accepted race: two concurrent generation jobs for the same review can both
// pass the skip-check → double classify (sub-cent, temperature 0) → both
// append a triage step (timeline noise only). reviews.triage_* stays correct
// via persistTriage's review-row lock serialization + the hash model.
// Dedup-under-lock is deferred until WS5 needs clean timelines.

import type { Sql } from 'postgres';
import { classifyReviewTriage, persistTriage } from '../../../src/lib/reviews/triage';
import { TRIAGE_SOURCE, type TriageSeverity } from '../../../src/lib/reviews/triage-schema';
import { triageEnabled } from '../../../src/lib/reviews/flags';
import { classifySentiment } from '../../../src/lib/reviews/sentiment';
import { isMockMode } from '../../../src/lib/shared/mock-mode';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { GenerationContext } from './load-context';

interface TriageStateRow {
  triage_severity: TriageSeverity | null;
  triage_source: string | null;
  triage_content_hash: string | null;
  review_content_hash: string | null;
}

/**
 * A stored triage row satisfies the skip-check only when its source is
 * trustworthy for the current runtime: fallback rows are always re-attempted
 * (spec §2.6), and mock rows only count inside mock mode — a mock row
 * persisted during local dev must never satisfy a real run.
 */
function isTrustworthySource(source: string | null): boolean {
  if (source === TRIAGE_SOURCE.FALLBACK) return false;
  if (source === TRIAGE_SOURCE.MOCK && !isMockMode()) return false;
  return source !== null;
}

export async function runTriagePhase(
  sql: Sql,
  ctx: GenerationContext,
  ids: { reviewId: string; businessId: string },
  logger: Pick<WorkerLogger, 'log' | 'warn'>,
): Promise<TriageSeverity | null> {
  if (!triageEnabled()) return null;
  if (classifySentiment(ctx.normalizedReview.starRating).label === 'positive') return null;

  const [state] = await sql<TriageStateRow[]>`
    SELECT triage_severity, triage_source, triage_content_hash, review_content_hash
    FROM reviews
    WHERE id = ${ids.reviewId} AND business_id = ${ids.businessId}
  `;
  // Review vanished mid-job (offboarding teardown): the generation path
  // downstream owns reporting; triage just steps aside.
  if (!state) return null;

  const upToDate = state.triage_severity !== null
    && isTrustworthySource(state.triage_source)
    && state.triage_content_hash === state.review_content_hash;
  if (upToDate) return state.triage_severity;

  const classification = await classifyReviewTriage(sql, {
    businessId: ids.businessId,
    subscriptionTier: ctx.businessContext.subscriptionTier,
    accountId: ctx.accountId,
    review: {
      starRating: ctx.normalizedReview.starRating,
      reviewText: ctx.normalizedReview.reviewText,
    },
  });

  await sql.begin(async (tx) => {
    await persistTriage(tx, {
      reviewId: ids.reviewId,
      businessId: ids.businessId,
      classification,
      // Hash of the text the LLM actually classified (loaded with the
      // generation context) — NOT the fresher state-read hash. If a
      // content-changed ingest commits between context load and the state
      // read, stamping the newer hash would falsely mark the new content as
      // triaged with an old-text classification; the loaded hash keeps every
      // divergence self-healing (mismatch → next job re-triages).
      contentHash: ctx.loadedReviewContentHash,
    });
  });

  logger.log('triage classified', {
    review_id: ids.reviewId,
    business_id: ids.businessId,
    severity: classification.output.severity,
    suggested_action: classification.output.suggested_action,
    source: classification.source,
  });

  return classification.output.severity;
}
