# ResponseGeneratorWorker Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 498-LOC `worker/jobs/ResponseGeneratorWorker.ts` into a ~80-LOC composing orchestrator plus four focused `response-generation/` modules, preserving behavior exactly (the existing 13-test suite is the net) and keeping the invariant #4 moderation-hold in the same transaction as response persistence.

**Architecture:** The orchestrator calls `loadGenerationContext` (reads + DTOs + subscription guard + idempotency → discriminated outcome), `generateDraft` (voice/budget/generate/avoid-facts + 4-way error classifier → `DraftOutcome`), `moderateResponse`, then `persistResponseAndNotify` (the single `sql.begin`, with only the moderation/hold branch named as a tx-helper), then best-effort analytics. Modules **classify** outcomes; the shell **effects** the outbox (all `markOutbox*` calls and terminal logs live only in the shell). Retryable errors (concurrency/transient) propagate as throws exactly as today.

**Tech Stack:** TypeScript (strict), Postgres.js (`sql`/`sql.begin`), BullMQ job handler, Vitest. Spec: `docs/superpowers/specs/2026-05-28-response-generator-worker-modularization-design.md`.

> **Validation constraint (read first):** This work happens in a nested `.claude/worktrees/` worktree. Per `.claude/CLAUDE.md`, running `pnpm lint`/`pnpm test`/`tsc` locally from a nested worktree leaks module resolution into the parent `node_modules`/eslintrc and poisons the result. **Do NOT run local gates.** Each task commits a self-contained, behavior-preserving step for clean bisection; the green gate is the **CI runner** (lint, typecheck, test, build, ci:tenant-scope) on push in Task 6.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `worker/jobs/response-generation/analytics.ts` | best-effort `first_response_drafted` enqueue (post-commit) | Create |
| `worker/jobs/response-generation/persist.ts` | invariant #4 `sql.begin` tx + `recordModerationAndHold` tx-helper | Create |
| `worker/jobs/response-generation/generate-draft.ts` | voice/budget/generate/avoid-facts + 4-way error classifier | Create |
| `worker/jobs/response-generation/load-context.ts` | reads + DTO build + subscription guard + idempotency → `LoadOutcome` | Create |
| `worker/jobs/response-generation/__tests__/generate-draft.test.ts` | focused unit tests for the classifier | Create |
| `worker/jobs/ResponseGeneratorWorker.ts` | composing orchestrator (public export unchanged) | Replace |
| `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` | existing characterization net | **Untouched** |

Relative-path note: files under `worker/jobs/response-generation/` reach `src/lib/...` via `../../../src/lib/...`; the test under `worker/jobs/response-generation/__tests__/` uses `../../../../src/lib/...`.

---

## Task 1: Extract `analytics.ts` (verbatim move)

**Files:**
- Create: `worker/jobs/response-generation/analytics.ts`
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (remove the moved function + now-unused imports; import from the new module)

- [ ] **Step 1: Create `worker/jobs/response-generation/analytics.ts`**

```ts
// worker/jobs/response-generation/analytics.ts
//
// Best-effort `first_response_drafted` analytics enqueue for the response
// generator. Intentionally OUTSIDE the response-creation transaction: it runs
// AFTER the response commits so it can detect "first draft for the account"
// against committed rows. Idempotency across BullMQ retries-after-commit is
// guaranteed by the account-scoped event_key + ON CONFLICT (event_key) DO
// NOTHING in enqueueAnalyticsEvent, so a re-run cannot double-count. Analytics
// must never fail response generation, hence the swallowed catch.

import { sql } from '../../../src/lib/db/server';
import { enqueueAnalyticsEvent } from '../../../src/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '../../../src/lib/analytics/events';

export async function maybeEnqueueFirstResponseDrafted(input: {
  accountId: string;
  businessId: string;
  responseId: string;
  reviewId: string;
  logger?: Pick<Console, 'warn'>;
}): Promise<void> {
  try {
    const [row] = await sql<{ earlier_exists: boolean; email_verified_at: Date | null }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM responses r2
          JOIN businesses b2 ON b2.id = r2.business_id
          WHERE b2.account_id = ${input.accountId}::uuid
            AND r2.id <> ${input.responseId}::uuid
            AND r2.created_at IS NOT NULL
          LIMIT 1
        ) AS earlier_exists,
        (
          SELECT occurred_at
          FROM analytics_events
          WHERE event_name = 'email_verified'
            AND account_id = ${input.accountId}::uuid
          ORDER BY occurred_at ASC
          LIMIT 1
        ) AS email_verified_at
    `;
    if (row?.earlier_exists) return;

    const minutesToFirstDraft = row?.email_verified_at
      ? Math.max(0, (Date.now() - new Date(row.email_verified_at).getTime()) / 60_000)
      : null;

    await enqueueAnalyticsEvent({
      eventName: 'first_response_drafted',
      eventKey: makeAnalyticsEventKey('first_response_drafted', [input.accountId]),
      distinctId: input.accountId,
      accountId: input.accountId,
      businessId: input.businessId,
      properties: {
        account_id: input.accountId,
        business_id: input.businessId,
        response_id: input.responseId,
        review_id: input.reviewId,
        minutes_to_first_draft: minutesToFirstDraft === null ? null : Number(minutesToFirstDraft.toFixed(2)),
      },
    });
  } catch (err) {
    input.logger?.warn(`first_response_drafted enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 2: In `worker/jobs/ResponseGeneratorWorker.ts`, delete the `maybeEnqueueFirstResponseDrafted` function** (current lines ~429–486, including the preceding doc comment block) and add the import near the top:

```ts
import { maybeEnqueueFirstResponseDrafted } from './response-generation/analytics';
```

Also remove the now-unused imports `enqueueAnalyticsEvent` and `makeAnalyticsEventKey` from the worker's import block (they only served the moved function).

- [ ] **Step 3: Verify (reasoning, no local run)**

Confirm: the worker still has exactly two call sites for `maybeEnqueueFirstResponseDrafted` (the existing-response idempotency branch and the success path), both now resolving to the imported function with identical arguments. No other code referenced the deleted function (verified: only comments mention it).

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/response-generation/analytics.ts worker/jobs/ResponseGeneratorWorker.ts
git commit -m "refactor(response-gen): extract first_response_drafted analytics to module"
```

---

## Task 2: Extract `persist.ts` (invariant #4 tx + typed retryCostId)

**Files:**
- Create: `worker/jobs/response-generation/persist.ts`
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (delete `persistResponseAndNotify`; import it; switch the call site to the options object; drop now-unused imports)

- [ ] **Step 1: Create `worker/jobs/response-generation/persist.ts`**

```ts
// worker/jobs/response-generation/persist.ts
//
// Invariant #4 transactional boundary for the response generator. Persists the
// generated response, links its api_costs row(s), records moderation metadata,
// and — for a high-severity moderation flag — HOLDS the draft (writes a
// flagged_responses row and skips the send_notification outbox enqueue) in the
// SAME transaction as response persistence. The moderation-hold + notification
// skip must never split from the INSERT. See CLAUDE.md invariant #4.

import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql, jsonb } from '../../../src/lib/db/server';
import type { ModerationDecision } from '../../../src/lib/moderation/output-filter';
import type { GenerationResult } from '../../../src/lib/responses/types';
import type { SendNotificationPayload } from '../../../src/lib/shared/worker-types';

export interface PersistResponseInput {
  result: GenerationResult;
  /** api_costs row for the avoid-facts RETRY output, if a retry happened. */
  retryCostId?: string;
  reviewId: string;
  businessId: string;
  version: number;
  correlationId: string | undefined;
  suppressNotification: boolean;
  moderation: ModerationDecision;
  accountId: string;
}

export async function persistResponseAndNotify(input: PersistResponseInput): Promise<string> {
  const {
    result, retryCostId, reviewId, businessId, version,
    correlationId, suppressNotification, moderation, accountId,
  } = input;

  const responseId = uuidv7();
  // Moderation describes the FINAL output; when an avoid-facts retry happened,
  // the final text's cost row is the retry's row.
  const moderatedCostId = retryCostId ?? result.apiCostId;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO responses (
        id, review_id, business_id, response_text, response_language,
        version, status, original_draft_text,
        llm_provider, llm_model, prompt_tokens, completion_tokens
      ) VALUES (
        ${responseId}, ${reviewId}, ${businessId}, ${result.responseText}, ${result.language},
        ${version}, 'pending_approval', ${result.responseText},
        ${result.provider}, ${result.model}, ${result.usage.promptTokens}, ${result.usage.completionTokens}
      )
    `;

    if (result.apiCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}
      `;
    }

    if (retryCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${retryCostId}
      `;
    }

    const held = await recordModerationAndHold(tx, {
      responseId,
      moderatedCostId,
      moderation,
      accountId,
      businessId,
      reviewId,
      outputExcerpt: result.responseText.slice(0, 200),
    });

    // Backfill suppression (spec §4.6, §6.7) OR a high-severity flag both skip
    // the approval notification.
    if (suppressNotification || held) {
      return;
    }

    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: businessId,
      correlation_id: correlationId,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'send_notification', 'response', ${responseId},
        ${jsonb(notifyPayload)}, 'pending'
      )
    `;
  });

  return responseId;
}

/**
 * Records moderation metadata on the final output's api_costs row and, for a
 * high-severity flag, HOLDS the draft by writing a flagged_responses row. Runs
 * on the OPEN transaction `tx` so the hold stays atomic with the response
 * INSERT (invariant #4). Returns whether the draft was held (high-severity),
 * which the caller uses to skip the send_notification enqueue.
 */
async function recordModerationAndHold(
  tx: postgres.TransactionSql,
  args: {
    responseId: string;
    moderatedCostId: string | null;
    moderation: ModerationDecision;
    accountId: string;
    businessId: string;
    reviewId: string;
    outputExcerpt: string;
  },
): Promise<boolean> {
  const { responseId, moderatedCostId, moderation, accountId, businessId, reviewId, outputExcerpt } = args;
  const flaggedHigh = moderation.flagged && moderation.severity === 'high';

  // Record moderation metadata on the cost row for the final output. Excerpt
  // is for operational triage only — full text already lives on responses.
  if (moderatedCostId) {
    await tx`
      UPDATE api_costs SET
        moderation_score = ${moderation.score},
        moderation_categories = ${jsonb(moderation.categories)},
        flagged = ${moderation.flagged},
        flag_reason = ${moderation.reason},
        output_excerpt = ${outputExcerpt}
      WHERE id = ${moderatedCostId}
    `;
  }

  // High-confidence unsafe draft: hold it for admin disposition (PR 3b) and
  // do NOT enqueue the owner notification. The response stays pending_approval.
  if (flaggedHigh) {
    await tx`
      INSERT INTO flagged_responses (
        id, response_id, account_id, business_id, review_id, api_cost_id,
        source, reason, severity, status
      ) VALUES (
        ${uuidv7()}, ${responseId}, ${accountId}, ${businessId}, ${reviewId}, ${moderatedCostId ?? null},
        ${moderation.source ?? 'local_regex'}, ${moderation.reason}, ${moderation.severity}, ${'open'}
      )
    `;
  }

  return flaggedHigh;
}
```

- [ ] **Step 2: In `worker/jobs/ResponseGeneratorWorker.ts`, delete the `persistResponseAndNotify` function** (current lines ~333–427, including the section comment) and add the import:

```ts
import { persistResponseAndNotify } from './response-generation/persist';
```

- [ ] **Step 3: Replace the call site** (current lines ~241–246) with the options-object form:

```ts
  // ── Persist response + outbox + cost link + moderation hold in one tx ─
  const responseId = await persistResponseAndNotify({
    result,
    retryCostId: (result as any)._retryCostId, // TEMP: still set by the guardrail until Task 3
    reviewId: review_id,
    businessId,
    version,
    correlationId: job.data.correlation_id,
    suppressNotification: job.data.suppress_notification === true,
    moderation,
    accountId: business.account_id,
  });
```

> The `(result as any)._retryCostId` bridge stays **only between Task 2 and Task 3**. Task 3 moves the guardrail into `generate-draft.ts`, makes it return a typed `retryCostId`, and the shell stops reading `_retryCostId` entirely. Do not leave this cast past Task 3.

- [ ] **Step 4: Remove now-unused imports** from the worker if they are no longer referenced after this task (`jsonb` was only used by the moved function; `SendNotificationPayload`, `ModerationDecision` likewise). Keep `moderateResponse`, the costs/tracker error classes, generator/mock-generator, etc. — they are still used until Task 3. Leave any import that still has a reference; remove only the genuinely-unused ones (`jsonb`, `SendNotificationPayload`, `ModerationDecision`).

- [ ] **Step 5: Verify (reasoning)**

Tx ordering is byte-for-byte: response INSERT → cost link (`apiCostId`) → cost link (`retryCostId`) → moderation UPDATE → flagged_responses INSERT (if high) → `suppress || held` early-return → `send_notification` INSERT. `held` equals the old `flaggedHigh`. `moderatedCostId = retryCostId ?? result.apiCostId` unchanged.

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/response-generation/persist.ts worker/jobs/ResponseGeneratorWorker.ts
git commit -m "refactor(response-gen): extract persist+hold tx to module (invariant #4 intact)"
```

---

## Task 3: Extract `generate-draft.ts` (generation phase + classifier + typed retryCostId)

**Files:**
- Create: `worker/jobs/response-generation/generate-draft.ts`
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (delete `applyAvoidFactsGuardrail` + `findAvoidFactViolation`; replace the voice/budget/generate/guardrail block with a single `generateDraft` call; drop the `_retryCostId` cast and the now-unused generation imports)

> **Mock note for later tasks:** `generate-draft.ts` imports `{ generateResponse, TransientLLMError }` from `responses/generator`. The existing `ResponseGeneratorWorker.test.ts` mocks that module without `TransientLLMError` — that is safe because the only generate-rejection test throws `CostLimitExceededError`, which short-circuits before the `instanceof TransientLLMError` line ever evaluates (identical to today's behavior). Task 5's new test supplies a real `TransientLLMError`.

- [ ] **Step 1: Create `worker/jobs/response-generation/generate-draft.ts`**

```ts
// worker/jobs/response-generation/generate-draft.ts
//
// The generation phase of the response generator: voice-learning fetch →
// regeneration-budget check → LLM generation (mock or real) → avoid-facts
// guardrail. Owns the failure CLASSIFICATION and diagnostic logging (CLAUDE.md
// invariant #12: modules own failure behavior). Returns a discriminated
// DraftOutcome. Retryable provider/concurrency errors are RE-THROWN so the
// caller lets BullMQ retry; permanent failures return { kind: 'failed' } with a
// reason the caller writes to the outbox.

import { generateResponse, TransientLLMError } from '../../../src/lib/responses/generator';
import { generateMockResponse } from '../../../src/lib/responses/mock-generator';
import { getApprovedResponsePairs } from '../../../src/lib/responses/voice-learning';
import { isMockMode } from '../../../src/lib/shared/mock-mode';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
  checkRegenBudget,
  setCachedGeneration,
} from '../../../src/lib/costs/tracker';
import type { BusinessContext, GenerationResult, VoiceExample } from '../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../src/lib/reviews/types';
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
}

export async function generateDraft(
  ctx: GenerationContext,
  ids: DraftIds,
  logger: WorkerLogger,
): Promise<DraftOutcome> {
  const { normalizedReview, businessContext, accountId } = ctx;
  const { reviewId, version, businessId } = ids;

  // ── Voice learning ──────────────────────────────────────────────────
  const voiceExamples: VoiceExample[] = await getApprovedResponsePairs(businessId);

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
  };

  let result: GenerationResult;
  try {
    result = isMockMode()
      ? await generateMockResponse(normalizedReview, businessContext, voiceExamples, genOpts)
      : await generateResponse(normalizedReview, businessContext, voiceExamples, genOpts);
  } catch (err) {
    if (err instanceof CostLimitExceededError || err instanceof GlobalCostLimitExceededError) {
      logger.warn(`Cost limit exceeded for business ${businessId}: ${err.message}`);
      return { kind: 'failed', reason: err.message };
    }
    if (err instanceof ConcurrencyLimitExceededError) {
      // Transient — other jobs will finish, then this one can proceed
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
      result,
      businessContext,
      normalizedReview,
      voiceExamples,
      { reviewId, version, businessId, accountId },
      logger,
    );
    return { kind: 'ok', result: guarded.result, retryCostId: guarded.retryCostId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Avoid-facts guardrail failed for review ${reviewId}: ${message}`);
    return { kind: 'failed', reason: `guardrail_failed: ${message}` };
  }
}

// ── Avoid-facts guardrail ───────────────────────────────────────────────

async function applyAvoidFactsGuardrail(
  result: GenerationResult,
  businessContext: BusinessContext,
  normalizedReview: NormalizedReview,
  voiceExamples: VoiceExample[],
  ids: { reviewId: string; version: number; businessId: string; accountId: string },
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
      skipCache: true,
    };
    const retryResult = isMockMode()
      ? await generateMockResponse(normalizedReview, businessContext, voiceExamples, retryOpts)
      : await generateResponse(normalizedReview, businessContext, voiceExamples, retryOpts);

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
```

- [ ] **Step 2: In `worker/jobs/ResponseGeneratorWorker.ts`, delete** the `applyAvoidFactsGuardrail` function, the `findAvoidFactViolation` helper, and their section comments. Add the import:

```ts
import { generateDraft } from './response-generation/generate-draft';
```

- [ ] **Step 3: Replace the voice-learning + regen-budget + generate + guardrail block** (current Steps 6–8, the `voiceExamples` fetch through the guardrail try/catch) with:

```ts
  // ── Generate draft (cost-guard → generate → avoid-facts guardrail) ───
  // Retryable errors (concurrency / transient LLM) throw out of generateDraft
  // and propagate to BullMQ for retry. Permanent failures return { failed }.
  const draft = await generateDraft(ctx, { reviewId: review_id, version, businessId }, logger);
  if (draft.kind === 'failed') {
    await markOutboxFailed(outboxId, draft.reason, outboxAttempt);
    return;
  }

  // ── Output moderation (local rules always; provider if configured) ───
  const moderation = await moderateResponse(draft.result.responseText);
```

> NOTE: `ctx` does not exist yet — Task 4 introduces `loadGenerationContext` and `ctx`. Until Task 4, this task still references the locally-built `businessContext`/`normalizedReview`/`business.account_id`. Use this **interim** call shape in Task 3 instead, matching the not-yet-extracted load code:
>
> ```ts
>   const draft = await generateDraft(
>     { accountId: business.account_id, normalizedReview, businessContext },
>     { reviewId: review_id, version, businessId },
>     logger,
>   );
>   if (draft.kind === 'failed') {
>     await markOutboxFailed(outboxId, draft.reason, outboxAttempt);
>     return;
>   }
>   const moderation = await moderateResponse(draft.result.responseText);
> ```

- [ ] **Step 4: Update the persist call site** to use the typed `retryCostId` and `draft.result`, removing the `(result as any)._retryCostId` bridge from Task 2:

```ts
  const responseId = await persistResponseAndNotify({
    result: draft.result,
    retryCostId: draft.retryCostId,
    reviewId: review_id,
    businessId,
    version,
    correlationId: job.data.correlation_id,
    suppressNotification: job.data.suppress_notification === true,
    moderation,
    accountId: business.account_id,
  });
```

- [ ] **Step 5: Remove now-unused imports** from the worker: `generateResponse`, `TransientLLMError`, `generateMockResponse`, `getApprovedResponsePairs`, `isMockMode`, `CostLimitExceededError`, `GlobalCostLimitExceededError`, `ConcurrencyLimitExceededError`, `RegenBudgetExceededError`, `checkRegenBudget`, `setCachedGeneration`, and the `GenerationResult`/`VoiceExample` type imports if no longer referenced. Keep `moderateResponse`, `BusinessContext`, `NormalizedReview` (still used by the interim load code until Task 4).

- [ ] **Step 6: Verify (reasoning)**

Classification parity per the spec's error table. `applyAvoidFactsGuardrail` now returns `{ result, retryCostId? }`; `merged.apiCostId` still holds the original cost id; `retryCostId` is `retryResult.apiCostId ?? undefined` (null normalizes to undefined — behaviorally identical to the old `_retryCostId` nullable read because both `?? result.apiCostId` and `if (retryCostId)` treat null/undefined the same).

- [ ] **Step 7: Commit**

```bash
git add worker/jobs/response-generation/generate-draft.ts worker/jobs/ResponseGeneratorWorker.ts
git commit -m "refactor(response-gen): extract generation phase + 4-way classifier; type retryCostId"
```

---

## Task 4: Extract `load-context.ts` and slim the shell to the orchestrator

**Files:**
- Create: `worker/jobs/response-generation/load-context.ts`
- Replace: `worker/jobs/ResponseGeneratorWorker.ts` (full rewrite to the orchestrator)

- [ ] **Step 1: Create `worker/jobs/response-generation/load-context.ts`**

```ts
// worker/jobs/response-generation/load-context.ts
//
// Pre-generation gate for the response generator. Reads the review + business
// rows, builds the NormalizedReview + BusinessContext DTOs, runs the
// subscription guard, and performs the idempotency check (a previous attempt
// may have committed the response but crashed before completing the outbox).
// Returns a discriminated LoadOutcome; the caller maps each outcome to the
// appropriate outbox effect. No outbox writes happen here.

import { sql } from '../../../src/lib/db/server';
import { checkSubscription, type AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { sanitizeText } from '../../../src/lib/shared/sanitize';
import { parseDbArray } from '../../../src/lib/shared/db-array';
import { mergeLogContext } from '../../../src/lib/shared/log-context';
import type { LocationId } from '../../../src/lib/shared/ids';
import type { NormalizedReview } from '../../../src/lib/reviews/types';
import type { BusinessContext } from '../../../src/lib/responses/types';

export interface GenerationContext {
  accountId: string;
  normalizedReview: NormalizedReview;
  businessContext: BusinessContext;
}

export type LoadOutcome =
  | { kind: 'ready'; ctx: GenerationContext }
  | { kind: 'review_not_found' }
  | { kind: 'business_not_found' }
  | { kind: 'subscription_blocked'; reason: string }
  | { kind: 'already_exists'; existing: { id: string; businessId: string; accountId: string } };

export async function loadGenerationContext(input: {
  reviewId: string;
  businessId: LocationId;
  version: number;
}): Promise<LoadOutcome> {
  const { reviewId, businessId, version } = input;

  const [review] = await sql<{
    id: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
    detected_language: string;
  }[]>`
    SELECT id, reviewer_name, star_rating, review_text, review_date, detected_language
    FROM reviews WHERE id = ${reviewId}
  `;

  if (!review) {
    return { kind: 'review_not_found' };
  }

  const [business] = await sql<{
    id: string;
    account_id: string;
    name: string;
    category: string | null;
    tone: string;
    products_services: string | null;
    staff_names: string[] | null;
    highlight_facts: string[] | null;
    avoid_facts: string[] | null;
    sample_responses: string[] | null;
    subscription_status: string;
    subscription_tier: string;
    account_past_due_at: Date | null;
    account_flags: AccountFlagsInput;
  }[]>`
    SELECT b.id, b.account_id, b.name, b.category, b.tone, b.products_services, b.staff_names,
           b.highlight_facts, b.avoid_facts, b.sample_responses,
           a.subscription_status, a.subscription_tier,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    return { kind: 'business_not_found' };
  }

  mergeLogContext({ account_id: business.account_id });

  // ── Subscription guard ───────────────────────────────────────────────
  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'generator',
  });

  if (!subCheck.allowed) {
    return { kind: 'subscription_blocked', reason: subCheck.reason };
  }

  // ── Idempotency check — previous attempt may have committed ──────────
  // The schema enforces UNIQUE (review_id, version). If a previous attempt
  // committed the response + notification outbox but crashed before
  // markOutboxCompleted, detect this BEFORE spending on LLM calls or
  // reserving cost. The generator's Redis cache may have expired. DTO building
  // is pure and only runs on the 'ready' path, so checking here (before the
  // build) does not change the sequence of SQL calls (review, business,
  // existing-response).
  const [existingResponse] = await sql<{ id: string; business_id: string; account_id: string }[]>`
    SELECT r.id, r.business_id, b.account_id
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.review_id = ${reviewId}
      AND r.version = ${version}
  `;

  if (existingResponse) {
    return {
      kind: 'already_exists',
      existing: {
        id: existingResponse.id,
        businessId: existingResponse.business_id,
        accountId: existingResponse.account_id,
      },
    };
  }

  // ── Build DTOs ───────────────────────────────────────────────────────
  const normalizedReview: NormalizedReview = {
    reviewerName: review.reviewer_name,
    starRating: review.star_rating,
    reviewText: review.review_text ? sanitizeText(review.review_text) : null,
    reviewDate: review.review_date,
    detectedLanguage: review.detected_language,
  };

  const businessContext: BusinessContext = {
    id: business.id,
    name: business.name,
    category: business.category,
    tone: business.tone,
    productsServices: business.products_services,
    staffNames: parseDbArray(business.staff_names),
    highlightFacts: parseDbArray(business.highlight_facts),
    avoidFacts: parseDbArray(business.avoid_facts),
    sampleResponses: parseDbArray(business.sample_responses),
    subscriptionTier: business.subscription_tier as BusinessContext['subscriptionTier'],
  };

  return {
    kind: 'ready',
    ctx: { accountId: business.account_id, normalizedReview, businessContext },
  };
}
```

- [ ] **Step 2: Replace `worker/jobs/ResponseGeneratorWorker.ts` entirely** with the orchestrator:

```ts
import type { Job } from 'bullmq';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { moderateResponse } from '../../src/lib/moderation/moderate';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { mergeLogContext } from '../../src/lib/shared/log-context';
import { asLocationId } from '../../src/lib/shared/ids';
import { loadGenerationContext } from './response-generation/load-context';
import { generateDraft } from './response-generation/generate-draft';
import { persistResponseAndNotify } from './response-generation/persist';
import { maybeEnqueueFirstResponseDrafted } from './response-generation/analytics';

export async function handleResponseGeneration(
  job: Job<GenerateResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponseGeneratorWorker]', job.data.correlation_id);
  const { review_id, version } = job.data;
  const businessId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  mergeLogContext({ outbox_id: outboxId });

  // ── Load review + business, guard subscription, check idempotency ────
  const loaded = await loadGenerationContext({ reviewId: review_id, businessId, version });
  switch (loaded.kind) {
    case 'review_not_found':
      logger.warn(`Review ${review_id} not found`);
      await markOutboxFailed(outboxId, 'review_not_found', outboxAttempt);
      return;
    case 'business_not_found':
      logger.warn(`Business ${businessId} not found`);
      await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
      return;
    case 'subscription_blocked':
      logger.log(`Business ${businessId} skipped: ${loaded.reason}`);
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    case 'already_exists':
      logger.log(`Response already exists for review ${review_id} v${version}, completing outbox`);
      await maybeEnqueueFirstResponseDrafted({
        accountId: loaded.existing.accountId,
        businessId: loaded.existing.businessId,
        responseId: loaded.existing.id,
        reviewId: review_id,
        logger,
      });
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
  }

  const { ctx } = loaded;

  // ── Generate draft (cost-guard → generate → avoid-facts guardrail) ───
  // Retryable errors (concurrency / transient LLM) throw out of generateDraft
  // and propagate to BullMQ for retry. Permanent failures return { failed }.
  const draft = await generateDraft(ctx, { reviewId: review_id, version, businessId }, logger);
  if (draft.kind === 'failed') {
    await markOutboxFailed(outboxId, draft.reason, outboxAttempt);
    return;
  }

  // ── Output moderation (local rules always; provider if configured) ───
  const moderation = await moderateResponse(draft.result.responseText);

  // ── Persist response + outbox + cost link + moderation hold in one tx ─
  // (invariant #4: a high-severity flag holds the draft + skips notification,
  // atomically with response persistence). DB failure throws → BullMQ retry.
  const responseId = await persistResponseAndNotify({
    result: draft.result,
    retryCostId: draft.retryCostId,
    reviewId: review_id,
    businessId,
    version,
    correlationId: job.data.correlation_id,
    suppressNotification: job.data.suppress_notification === true,
    moderation,
    accountId: ctx.accountId,
  });

  await maybeEnqueueFirstResponseDrafted({
    accountId: ctx.accountId,
    businessId,
    responseId,
    reviewId: review_id,
    logger,
  });

  // ── Complete outbox ──────────────────────────────────────────────────
  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.log(`Response ${responseId} generated for review ${review_id} (v${version})`);
}
```

- [ ] **Step 3: Verify (reasoning)**

`switch (loaded.kind)` handles all non-`ready` members with `return`; TypeScript narrows `loaded` to `{ kind: 'ready'; ctx }` afterward, so `const { ctx } = loaded` type-checks. SQL-call sequence unchanged (review → business → existing). All `markOutbox*` calls and terminal logs are now in the shell only. `worker/index.ts` import (`./jobs/ResponseGeneratorWorker`) and the `handleResponseGeneration` export are unchanged.

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/response-generation/load-context.ts worker/jobs/ResponseGeneratorWorker.ts
git commit -m "refactor(response-gen): extract load-context; slim worker to orchestrator (498 -> ~80 LOC)"
```

---

## Task 5: Add focused unit tests for `generate-draft.ts`

**Files:**
- Create: `worker/jobs/response-generation/__tests__/generate-draft.test.ts`

- [ ] **Step 1: Create `worker/jobs/response-generation/__tests__/generate-draft.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerationResult, BusinessContext } from '../../../../src/lib/responses/types';
import type { NormalizedReview } from '../../../../src/lib/reviews/types';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';
import { asLocationId } from '../../../../src/lib/shared/ids';

// ── Hoisted mocks (TransientLLMError must be shared by the factory + tests) ──
const {
  mockGenerateResponse,
  mockGenerateMockResponse,
  mockGetApprovedResponsePairs,
  mockCheckRegenBudget,
  mockSetCachedGeneration,
  mockIsMockMode,
  TransientLLMError,
} = vi.hoisted(() => {
  class TransientLLMError extends Error {
    name = 'TransientLLMError';
  }
  return {
    mockGenerateResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockGenerateMockResponse: vi.fn<() => Promise<GenerationResult>>(),
    mockGetApprovedResponsePairs: vi.fn(async () => []),
    mockCheckRegenBudget: vi.fn(),
    mockSetCachedGeneration: vi.fn(),
    mockIsMockMode: vi.fn(() => false),
    TransientLLMError,
  };
});

vi.mock('../../../../src/lib/responses/generator', () => ({
  generateResponse: mockGenerateResponse,
  TransientLLMError,
}));
vi.mock('../../../../src/lib/responses/mock-generator', () => ({
  generateMockResponse: mockGenerateMockResponse,
}));
vi.mock('../../../../src/lib/responses/voice-learning', () => ({
  getApprovedResponsePairs: mockGetApprovedResponsePairs,
}));
vi.mock('../../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));
vi.mock('../../../../src/lib/costs/tracker', () => ({
  checkRegenBudget: mockCheckRegenBudget,
  setCachedGeneration: mockSetCachedGeneration,
  CostLimitExceededError: class CostLimitExceededError extends Error {
    name = 'CostLimitExceededError';
    constructor(public readonly businessId: string) { super(`Daily cost limit exceeded for business ${businessId}`); }
  },
  GlobalCostLimitExceededError: class extends Error {
    name = 'GlobalCostLimitExceededError';
    constructor() { super('Global daily cost limit exceeded'); }
  },
  ConcurrencyLimitExceededError: class extends Error {
    name = 'ConcurrencyLimitExceededError';
    constructor(public readonly businessId: string) { super(`Concurrency limit exceeded for business ${businessId}`); }
  },
  RegenBudgetExceededError: class extends Error {
    name = 'RegenBudgetExceededError';
    constructor(public readonly reviewId: string) { super(`Regeneration budget exceeded for review ${reviewId}`); }
  },
}));

// Import after mocks are wired
import { generateDraft } from '../generate-draft';
import type { GenerationContext } from '../load-context';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '../../../../src/lib/costs/tracker';

const BIZ_CONTEXT: BusinessContext = {
  id: 'biz-1', name: 'Test Biz', category: 'restaurant', tone: 'warm',
  productsServices: null, staffNames: [], highlightFacts: [], avoidFacts: [],
  sampleResponses: [], subscriptionTier: 'standard',
};

const REVIEW: NormalizedReview = {
  reviewerName: 'Jane', starRating: 5, reviewText: 'Great!',
  reviewDate: '2026-04-01', detectedLanguage: 'en',
};

const MOCK_RESULT: GenerationResult = {
  responseText: 'Thank you, Jane!', language: 'en', provider: 'openai', model: 'gpt-4o-mini',
  usage: { promptTokens: 100, completionTokens: 50 }, costUsd: 0.001, apiCostId: 'cost-1',
};

function ctx(overrides: Partial<BusinessContext> = {}): GenerationContext {
  return { accountId: 'acct-1', normalizedReview: REVIEW, businessContext: { ...BIZ_CONTEXT, ...overrides } };
}

const IDS = { reviewId: 'rev-1', version: 1, businessId: asLocationId('biz-1') };

function makeLogger(): WorkerLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as WorkerLogger;
}

describe('generateDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMockMode.mockReturnValue(false);
    mockGetApprovedResponsePairs.mockResolvedValue([]);
  });

  it('returns ok with the result on a clean generation', async () => {
    mockGenerateResponse.mockResolvedValueOnce(MOCK_RESULT);
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome).toEqual({ kind: 'ok', result: MOCK_RESULT, retryCostId: undefined });
  });

  it('classifies CostLimitExceededError as failed (no throw)', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new CostLimitExceededError('biz-1'));
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('cost limit exceeded');
  });

  it('classifies GlobalCostLimitExceededError as failed', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new GlobalCostLimitExceededError());
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
  });

  it('re-throws ConcurrencyLimitExceededError for BullMQ retry', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new ConcurrencyLimitExceededError('biz-1'));
    await expect(generateDraft(ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(ConcurrencyLimitExceededError);
  });

  it('re-throws TransientLLMError for BullMQ retry', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new TransientLLMError('rate limited'));
    await expect(generateDraft(ctx(), IDS, makeLogger())).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('classifies a permanent generation error as failed with generation_failed reason', async () => {
    mockGenerateResponse.mockRejectedValueOnce(new Error('bad request'));
    const outcome = await generateDraft(ctx(), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('generation_failed');
  });

  it('classifies RegenBudgetExceededError (version > 1) as failed without calling the LLM', async () => {
    mockCheckRegenBudget.mockRejectedValueOnce(new RegenBudgetExceededError('rev-1'));
    const outcome = await generateDraft(ctx(), { ...IDS, version: 2 }, makeLogger());
    expect(outcome.kind).toBe('failed');
    expect(mockGenerateResponse).not.toHaveBeenCalled();
  });

  it('retries once on avoid-facts violation and returns the clean retry with retryCostId', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'This mentions bad word in it', apiCostId: 'cost-1' };
    const clean: GenerationResult = { ...MOCK_RESULT, responseText: 'Thank you so much!', apiCostId: 'cost-2', costUsd: 0.002 };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(clean);

    const outcome = await generateDraft(ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());

    expect(mockGenerateResponse).toHaveBeenCalledTimes(2);
    const retryOpts = (mockGenerateResponse.mock.calls[1] as unknown[])[3] as Record<string, unknown>;
    expect(retryOpts).toMatchObject({ skipCache: true });
    expect(mockSetCachedGeneration).toHaveBeenCalledWith('rev-1', 1, expect.stringContaining('Thank you so much!'));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.retryCostId).toBe('cost-2');
      expect(outcome.result.responseText).toBe('Thank you so much!');
      expect(outcome.result.apiCostId).toBe('cost-1'); // original cost id retained on merged
    }
  });

  it('fails when the avoid-facts violation persists after retry', async () => {
    const violating: GenerationResult = { ...MOCK_RESULT, responseText: 'has bad word', apiCostId: 'cost-1' };
    const stillViolating: GenerationResult = { ...MOCK_RESULT, responseText: 'still bad word here', apiCostId: 'cost-2' };
    mockGenerateResponse.mockResolvedValueOnce(violating).mockResolvedValueOnce(stillViolating);

    const outcome = await generateDraft(ctx({ avoidFacts: ['bad word'] }), IDS, makeLogger());
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('guardrail_failed');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add worker/jobs/response-generation/__tests__/generate-draft.test.ts
git commit -m "test(response-gen): focused unit tests for generateDraft classifier"
```

---

## Task 6: Push and validate on CI; open PR

**Files:** none (CI + PR).

- [ ] **Step 1: Sanity check the diff locally (no test run)**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
wc -l worker/jobs/ResponseGeneratorWorker.ts
grep -rn "as any" worker/jobs/ResponseGeneratorWorker.ts worker/jobs/response-generation/ || echo "no 'as any' (expected)"
```

Expected: 6 commits (spec + 5 implementation commits + test), the worker file ~80 LOC, no `as any` in the new files.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --title "refactor(response-gen): modularize ResponseGeneratorWorker (498 -> ~80 shell + response-generation/)" --body "$(cat <<'EOF'
Modularizes `worker/jobs/ResponseGeneratorWorker.ts` (498 LOC) per
`docs/modular-requirement.md` Tier 2. Behavior-preserving extraction into a
composing orchestrator + `response-generation/` modules:

- `load-context.ts` — reads + DTO build + subscription guard + idempotency → discriminated outcome
- `generate-draft.ts` — voice/budget/generate/avoid-facts + 4-way error classifier
- `persist.ts` — the invariant #4 `sql.begin` tx; only the moderation/hold branch is named (`recordModerationAndHold`)
- `analytics.ts` — best-effort `first_response_drafted` (verbatim move)

Invariant #4 intact: the moderation-hold + `send_notification` skip stay in the
SAME transaction as response persistence. Also removes the
`(result as any)._retryCostId` hack via a typed `retryCostId` field.

Existing `ResponseGeneratorWorker.test.ts` (13 tests) untouched and green; adds
`generate-draft.test.ts` for the classifier (invariant #12).

Design: `docs/superpowers/specs/2026-05-28-response-generator-worker-modularization-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI; fix forward if red**

```bash
gh pr checks --watch
```

Expected: `lint`, `typecheck`, `test`, `build` all green. If `test` fails, read the failing case — the most likely culprits are (a) a missed unused-import removal (lint/typecheck), (b) the SQL-call sequence in `load-context.ts` drifting from the test's `sqlReturnQueue` order, or (c) the `generate-draft.test.ts` `TransientLLMError` mock wiring. Fix on the branch and push; do not edit the existing `ResponseGeneratorWorker.test.ts`.

---

## Self-Review

**Spec coverage:**
- load-context module → Task 4 ✓
- generate-draft module + classifier → Task 3 ✓
- persist module + `recordModerationAndHold` (invariant #4) → Task 2 ✓
- analytics module → Task 1 ✓
- orchestrator shell → Task 4 ✓
- typed `retryCostId` (remove `as any`) → Task 2 (bridge) + Task 3 (final) ✓
- new classifier tests → Task 5 ✓
- CI validation + PR → Task 6 ✓
- existing test untouched → stated in Tasks 1–6 ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete file content; the one interim shape (Task 3 Step 3 note) is fully written out, not deferred.

**Type consistency:** `GenerationContext` defined in `load-context.ts`, imported by `generate-draft.ts` and used by the shell — same shape (`accountId`, `normalizedReview`, `businessContext`) everywhere. `DraftOutcome` (`generate-draft.ts`) consumed by the shell. `PersistResponseInput` (`persist.ts`) matches the shell's call object key-for-key (`result`, `retryCostId`, `reviewId`, `businessId`, `version`, `correlationId`, `suppressNotification`, `moderation`, `accountId`). `LoadOutcome` kinds match the shell's switch arms exactly.

**Build-order soundness:** `generate-draft.ts` (Task 3) imports `GenerationContext` from `load-context.ts`, created in Task 4. This is a *type-only* import and the worktree's intermediate commits are validated only at the final CI push (Task 6), so the type resolves before any gate runs. The interim shell shape in Task 3 constructs the same object literal inline so the code compiles conceptually at each step; the authoritative compile is CI after Task 4.
