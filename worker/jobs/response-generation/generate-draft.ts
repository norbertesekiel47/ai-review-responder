// worker/jobs/response-generation/generate-draft.ts
//
// The generation phase of the response generator: voice-learning fetch →
// regeneration-budget check → LLM generation (mock or real) → avoid-facts
// guardrail. Owns the failure CLASSIFICATION and diagnostic logging (CLAUDE.md
// invariant #12: modules own failure behavior). Returns a discriminated
// DraftOutcome. Retryable provider/concurrency errors are RE-THROWN so the
// caller lets BullMQ retry; permanent failures return { kind: 'failed' } with a
// reason the caller writes to the outbox.

import * as Sentry from '@sentry/node';
import type { Sql } from 'postgres';
import { generateResponse } from '../../../src/lib/responses/generator';
import { TransientLLMError } from '../../../src/lib/llm/error-classifier';
import { generateMockResponse } from '../../../src/lib/responses/mock-generator';
import { getApprovedResponsePairs } from '../../../src/lib/responses/voice-learning';
import { isMockMode } from '../../../src/lib/shared/mock-mode';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  RegenBudgetExceededError,
  checkRegenBudget,
  setCachedGeneration,
} from '../../../src/lib/costs/tracker';
import { ConcurrencyLimitExceededError } from '../../../src/lib/costs/concurrency-guard';
import { CostInfraUnavailableError } from '../../../src/lib/costs/errors';
import type { BusinessContext, GenerationResult, VoiceExample } from '../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../src/lib/reviews/types';
import type { TriageSeverity } from '../../../src/lib/reviews/triage-schema';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { LocationId } from '../../../src/lib/shared/ids';
import type { GenerationContext } from './load-context';

export type DraftOutcome =
  | { kind: 'ok'; result: GenerationResult; retryCostId?: string }
  | { kind: 'failed'; reason: string };

interface DraftIds {
  reviewId: string;
  version: number;
  businessId: LocationId;
  // WS2 triage outcome for tone guidance (null = not triaged: flag off,
  // positive lane, or legacy). Required so every caller decides explicitly.
  triageSeverity: TriageSeverity | null;
}

function isCostCapError(err: unknown): err is CostLimitExceededError | GlobalCostLimitExceededError {
  return err instanceof CostLimitExceededError || err instanceof GlobalCostLimitExceededError;
}

// Dropped paid work must not be silent: a cap exhaustion terminally drops a draft
// the owner is paying for. Surface to the non-email alert sink (Sentry →
// Slack/PagerDuty) even though the failure stays terminal. (Beta-launch gate B3.)
function alertCostCapExhausted(
  err: CostLimitExceededError | GlobalCostLimitExceededError,
  businessId: LocationId,
  reviewId: string,
  version: number,
): void {
  Sentry.captureMessage(`Cost cap exhausted — draft dropped for business ${businessId}`, {
    level: 'warning',
    tags: {
      cost_event: 'limit_exceeded',
      cost_scope: err instanceof GlobalCostLimitExceededError ? 'global' : 'business',
      business_id: String(businessId),
    },
    extra: { review_id: reviewId, version },
  });
}

// Entry-point failure-classification orchestration (invariant #12): the catch
// ladder maps each generation error to a distinct outcome (cost-cap -> alert +
// terminal; concurrency/infra/transient -> retry; else -> terminal). Deep logic
// is extracted (isCostCapError, alertCostCapExhausted, applyAvoidFactsGuardrail);
// the residual is the distinct-outcome vocabulary, not tangled logic.
// fallow-ignore-next-line complexity
export async function generateDraft(
  sql: Sql,
  ctx: GenerationContext,
  ids: DraftIds,
  logger: WorkerLogger,
): Promise<DraftOutcome> {
  const { normalizedReview, businessContext, accountId } = ctx;
  const { reviewId, version, businessId } = ids;

  // ── Voice learning ──────────────────────────────────────────────────
  const voiceExamples: VoiceExample[] = await getApprovedResponsePairs(sql, businessId);

  // ── Regeneration budget check ───────────────────────────────────────
  if (version > 1) {
    try {
      await checkRegenBudget(reviewId);
    } catch (err) {
      if (err instanceof RegenBudgetExceededError) {
        logger.warn(`Regen budget exceeded for review ${reviewId}`);
        return { kind: 'failed', reason: err.message };
      }
      throw err;
    }
  }

  // ── Generate response ───────────────────────────────────────────────
  const genOpts = {
    mode: 'production' as const,
    reviewId,
    version,
    businessId,
    subscriptionTier: businessContext.subscriptionTier,
    accountId,
    triageSeverity: ids.triageSeverity,
  };

  let result: GenerationResult;
  try {
    result = isMockMode()
      ? await generateMockResponse(normalizedReview, businessContext, voiceExamples, genOpts)
      : await generateResponse(sql, normalizedReview, businessContext, voiceExamples, genOpts);
  } catch (err) {
    if (isCostCapError(err)) {
      logger.warn(`Cost limit exceeded for business ${businessId}: ${err.message}`);
      alertCostCapExhausted(err, businessId, reviewId, version);
      return { kind: 'failed', reason: err.message };
    }
    if (err instanceof ConcurrencyLimitExceededError) {
      // Transient — other jobs will finish, then this one can proceed
      throw err;
    }
    if (err instanceof CostInfraUnavailableError) {
      // Pre-LLM cost-guard Redis (Upstash) transport failure — re-throw so
      // BullMQ retries (3 attempts + backoff) and, if those exhaust, the outbox
      // watchdog re-dispatches after the 1h stale window. Matches the already-
      // retryable checkRegenBudget path; the cost RESERVATION precedes the LLM
      // call, so no spend has occurred. Budget-exceeded errors stay terminal above.
      logger.warn(`Cost-guard infra unavailable for review ${reviewId} (will retry): ${err.message}`);
      throw err;
    }
    if (err instanceof TransientLLMError) {
      // Provider outage / rate-limit / network — rethrow so BullMQ retries
      // (3 attempts + exponential backoff) and, if those exhaust, the outbox
      // watchdog re-dispatches after the 1h stale window.
      logger.warn(`Transient LLM error for review ${reviewId} (will retry): ${err.message}`);
      throw err;
    }
    // Permanent LLM/config error (auth, bad request, validation)
    logger.error(`Generation failed for review ${reviewId}: ${err instanceof Error ? err.message : err}`);
    return { kind: 'failed', reason: `generation_failed: ${err instanceof Error ? err.message : err}` };
  }

  // ── Avoid-facts guardrail ───────────────────────────────────────────
  // Guardrail errors (retry still violates, or retry LLM call itself fails)
  // must mark the outbox failed — not throw. Throwing causes BullMQ to retry
  // the whole job while the outbox stays non-terminal until the watchdog
  // recovers it, and each retry spends more on LLM calls for a problem that
  // won't resolve on its own (the avoid_facts config needs an admin fix).
  try {
    const guarded = await applyAvoidFactsGuardrail(
      sql,
      result,
      businessContext,
      normalizedReview,
      voiceExamples,
      { reviewId, version, businessId, accountId, triageSeverity: ids.triageSeverity },
      logger,
    );
    return { kind: 'ok', result: guarded.result, retryCostId: guarded.retryCostId };
  } catch (err) {
    // A cost-cap (budget) exhaustion during the guardrail retry must alert and
    // fail like the primary cost path — not be swallowed as guardrail_failed.
    if (isCostCapError(err)) {
      logger.warn(`Cost limit exceeded for business ${businessId} during avoid-facts guardrail retry: ${err.message}`);
      alertCostCapExhausted(err, businessId, reviewId, version);
      return { kind: 'failed', reason: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Avoid-facts guardrail failed for review ${reviewId}: ${message}`);
    return { kind: 'failed', reason: `guardrail_failed: ${message}` };
  }
}

// ── Avoid-facts guardrail ───────────────────────────────────────────────

// Bounded regenerate-once-and-recheck helper; the branches are the distinct
// guardrail outcomes (no avoid-facts, no violation, retry still violates,
// best-effort cache overwrite, cost-cap rethrow). Inherent to the single
// retry+recheck pass, not tangled logic.
// fallow-ignore-next-line complexity
async function applyAvoidFactsGuardrail(
  sql: Sql,
  result: GenerationResult,
  businessContext: BusinessContext,
  normalizedReview: NormalizedReview,
  voiceExamples: VoiceExample[],
  ids: { reviewId: string; version: number; businessId: string; accountId: string; triageSeverity: TriageSeverity | null },
  logger: WorkerLogger,
): Promise<{ result: GenerationResult; retryCostId?: string }> {
  const { avoidFacts } = businessContext;
  if (avoidFacts.length === 0) return { result };

  const violation = findAvoidFactViolation(result.responseText, avoidFacts);
  if (!violation) return { result };

  logger.warn(`Avoid-fact violation for review ${ids.reviewId}: "${violation}". Regenerating once.`);

  try {
    const retryOpts = {
      mode: 'production' as const,
      reviewId: ids.reviewId,
      version: ids.version,
      businessId: ids.businessId,
      subscriptionTier: businessContext.subscriptionTier,
      accountId: ids.accountId,
      triageSeverity: ids.triageSeverity,
      skipCache: true,
    };
    const retryResult = isMockMode()
      ? await generateMockResponse(normalizedReview, businessContext, voiceExamples, retryOpts)
      : await generateResponse(sql, normalizedReview, businessContext, voiceExamples, retryOpts);

    const merged: GenerationResult = {
      ...retryResult,
      costUsd: result.costUsd + retryResult.costUsd,
      apiCostId: result.apiCostId, // Restore original (retryResult spread overwrote it)
    };

    // Overwrite the cache so the polluted first-attempt entry doesn't persist
    try {
      await setCachedGeneration(ids.reviewId, ids.version, JSON.stringify({
        responseText: merged.responseText,
        language: merged.language,
        provider: merged.provider,
        model: merged.model,
        promptTokens: merged.usage.promptTokens,
        completionTokens: merged.usage.completionTokens,
      }));
    } catch {
      // Best-effort — cache TTL will expire the polluted entry eventually
    }

    // Re-check the retry for violations
    const retryViolation = findAvoidFactViolation(merged.responseText, avoidFacts);
    if (retryViolation) {
      throw new Error(
        `Avoid-fact violation persists after retry for review ${ids.reviewId}: "${retryViolation}"`,
      );
    }

    return { result: merged, retryCostId: retryResult.apiCostId ?? undefined };
  } catch (err) {
    // Cost-cap (budget) exhaustion during the retry must propagate UNCHANGED so
    // the caller's cost-cap handler alerts + fails it (not wrap as a generic
    // guardrail failure). CostInfraUnavailableError intentionally stays wrapped/
    // terminal here per the anti-respend note in CLAUDE.md.
    if (isCostCapError(err)) throw err;
    // Retry failed or still violates — do NOT fall back to the violating draft.
    // Throw so the worker marks this as failed and creates a review exception.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Avoid-fact guardrail failed for review ${ids.reviewId}: ${message}`);
  }
}

function findAvoidFactViolation(text: string, avoidFacts: string[]): string | null {
  const lower = text.toLowerCase();
  for (const fact of avoidFacts) {
    if (fact && lower.includes(fact.toLowerCase())) {
      return fact;
    }
  }
  return null;
}
