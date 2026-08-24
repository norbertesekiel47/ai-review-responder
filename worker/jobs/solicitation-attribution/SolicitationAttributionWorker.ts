// worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts
//
// Handles the #632 attribution lookback. Entry point — orchestrates only
// (invariant #12): subscription guard, open the transaction, call
// attributeReview, log the resolution. Every attribution RULE lives in
// src/lib/solicitation/attribution.ts, which takes its executor as a parameter
// (invariant #15) and is never reached from anywhere but here.
//
// No `'failed'` exhaustion hook by design: attribution is a shadow metric with
// no downstream consumer, so an exhausted job costs one uncounted review and
// nothing else. The shared job-failure sink still raises the Sentry issue on
// the terminal attempt (worker/job-failure-sink.ts).

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  attributeReview,
  type AttributionMatch,
  type AttributionRule,
} from '@/lib/solicitation/attribution';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxCompletedIfOwned,
} from '@/lib/shared/outbox';
import { checkSubscription, type AccountFlagsInput } from '@/lib/shared/subscription-guard';
import type { SolicitationAttributionPayload } from '@/lib/shared/worker-types';

interface AttributionSubscriptionContext {
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
}

/**
 * The subscription guard's inputs, and nothing else — invariant #11 says check
 * status EARLY, before any lookback work touches contact or review content.
 *
 * `account_id` is deliberately NOT returned: `attributeReview` resolves it from
 * the business FK inside its own transaction (deviation D3), and two resolutions
 * of the same fact is exactly how a wrong account id gets a chance to ride along.
 */
async function loadAttributionSubscriptionContext(
  sql: Sql,
  businessId: string,
): Promise<AttributionSubscriptionContext | null> {
  const [row] = await sql<AttributionSubscriptionContext[]>`
    SELECT a.subscription_status,
           a.past_due_at AS account_past_due_at,
           a.flags       AS account_flags
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
     WHERE b.id = ${businessId}::uuid
     LIMIT 1
  `;
  return row ?? null;
}

/**
 * The log shape for one resolution, narrowed on the discriminant rather than
 * reached for with `??`: `candidateCount` and `rule` each live on only some arms
 * of the union, and TypeScript is right to refuse the shorter spelling.
 *
 * The `attributed` arm reports 1 because that arm carries no candidate-set size
 * — the full count is durable in `solicitation_outreach.attribution_detail`
 * (`candidate_count`), which is where a precision analysis reads it from.
 */
function describeResolution(match: AttributionMatch): {
  candidateCount: number;
  rule: AttributionRule | null;
} {
  switch (match.resolution) {
    case 'attributed':
      return { candidateCount: 1, rule: match.rule };
    case 'no_candidates':
      return { candidateCount: 0, rule: null };
    case 'no_match':
    case 'ambiguous':
      return { candidateCount: match.candidateCount, rule: null };
  }
}

export async function handleSolicitationAttribution(
  sql: Sql,
  job: Job<SolicitationAttributionPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[SolicitationAttributionWorker]', job.data.correlation_id);
  const { review_id: reviewId, business_id: businessId } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id ?? '');

  // Invariant #11, checked before anything else reads tenant content. The
  // worker type is `summary` because attribution is reporting, not delivery:
  // the only status the choice moves is `pending_payment`, which is exempt for
  // `generator` alone (admin demo drafts) and must not attribute here.
  const context = await loadAttributionSubscriptionContext(sql, businessId);
  if (context === null) {
    // The business was deleted between enqueue and dispatch. Nothing to
    // attribute and nothing to retry — settle the row rather than let the
    // watchdog redispatch it until it exhausts.
    logger.warn('attribution_skipped', { reviewId, businessId, reason: 'business_missing' });
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }
  const guard = checkSubscription({
    status: context.subscription_status,
    pastDueAt: context.account_past_due_at,
    accountFlags: context.account_flags,
    workerType: 'summary',
  });
  if (!guard.allowed) {
    logger.log('attribution_skipped', { reviewId, businessId, reason: guard.reason });
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  // ONE transaction: claim the outbox attempt, then do the domain write.
  //
  // The claim comes FIRST and is attempt-guarded (round-1 finding A1). Without
  // it the row stays `dispatched` forever and the watchdog re-dispatches it
  // until it fails — the plan's first draft never completed its own row. A
  // `false` return means a stale attempt lost the race to the watchdog's newer
  // one, or a concurrent replay of the SAME attempt already committed: perform
  // NO mutation, because the winner is already doing this work. Idempotence is
  // keyed on the deterministic outbox id, never the BullMQ job id.
  //
  // Completion and the attribution write share the transaction, so a matcher
  // fault rolls the completion back with it and the entry is redispatchable.
  const match: AttributionMatch | null = await sql.begin(async (tx) => {
    const owned = await markOutboxCompletedIfOwned(tx, outboxId, attempt);
    if (!owned) return null;
    return attributeReview(tx, { reviewId, businessId });
  });

  if (match === null) {
    logger.log('attribution_stale_attempt', { reviewId, businessId, outboxId });
    return;
  }

  // The ONE observability signal for this feature, and it runs AFTER the
  // primary side effect has committed. `createWorkerLogger` is fail-open by
  // construction (it swallows both the sanitizer and the JSON.stringify), so
  // it cannot flip an already-completed job to `failed` and needs no second
  // try/catch around it — do not add one that would hide a real regression.
  //
  // `resolution` is a closed set; a rising `ambiguous` rate is the evidence
  // that the name rule is too loose, and it is the direct input to May 6.4's M3
  // precision bar. NEVER log the reviewer name or the review text.
  const { candidateCount, rule } = describeResolution(match);
  logger.log('attribution_resolved', {
    reviewId,
    businessId,
    resolution: match.resolution,
    candidateCount,
    rule,
  });
}
