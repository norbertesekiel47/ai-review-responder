# ResponseGeneratorWorker Modularization — Design

_Date: 2026-05-28 · Branch: `refactor/response-generator-worker-modularization` (off `main`)_

## Goal

Modularize `worker/jobs/ResponseGeneratorWorker.ts` (498 LOC) per
`docs/modular-requirement.md` **Tier 2**. The debt is **one giant function**:
`handleResponseGeneration` is ~228 lines orchestrating cost-guard → generation →
moderation-hold → persist+notify. Extracting its phases makes the generation
**failure path** and the invariant-#4 **moderation-hold** named, testable units,
and lets the entry point read as pure orchestration.

This is the **invariant #4** file (high-confidence-unsafe drafts held, not
notified). The doc flags it "Tier 2 — strong, but touch carefully."

**Hard constraint: behavior must be preserved.** The existing
`worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` (13 tests, run through
the public `handleResponseGeneration` surface) is the characterization safety
net and must stay 100% green and **untouched**. The moderation-hold +
`send_notification` outbox-skip must remain in the **same transaction** as
response persistence.

The only intentional change beyond extraction: remove the
`(merged as any)._retryCostId` / `(result as any)._retryCostId` hidden-dependency
hack by threading `retryCostId` as an explicit typed field (the rules forbid
`any`).

## Public surface (must not change)

- `handleResponseGeneration(job: Job<GenerateResponsePayload>): Promise<void>` —
  imported by the test and registered in `worker/index.ts`.

All other functions in the file (`applyAvoidFactsGuardrail`,
`persistResponseAndNotify`, `maybeEnqueueFirstResponseDrafted`,
`findAvoidFactViolation`) are currently module-private and imported nowhere else,
so relocating them is safe.

## Current file anatomy

| Cluster | Lines | Concern |
|---|---|---|
| Setup (logger, branded IDs, outbox handle, `mergeLogContext`) | 38–43 | orchestration |
| Read review + business (2 SELECTs), not-found handling | 45–95 | data load |
| Subscription guard | 97–109 | policy gate |
| Build `NormalizedReview` + `BusinessContext` | 111–132 | DTO build |
| Idempotency check (existing response) + analytics + complete | 134–158 | data load / gate |
| Voice learning + regen budget | 160–175 | generation |
| Generate (mock\|real) + **4-way error classifier** | 177–216 | generation |
| Avoid-facts guardrail call | 218–236 | generation |
| `moderateResponse` call | 238–239 | moderation |
| `persistResponseAndNotify` call | 241–246 | persist (tx) |
| Post-commit analytics + `markOutboxCompleted` | 248–259 | orchestration |
| `applyAvoidFactsGuardrail` (private) | 264–331 | generation |
| `persistResponseAndNotify` (private, **invariant #4 tx**) | 335–427 | persist |
| `maybeEnqueueFirstResponseDrafted` (private) | 435–486 | analytics |
| `findAvoidFactViolation` (private) | 490–498 | generation |

## Target module layout

Follows the prior Tier-1 convention (composing shell + per-concern folder):
`worker/jobs/publisher/`, `worker/background/pollers/billing-reconciliation/`.

```
worker/jobs/
  ResponseGeneratorWorker.ts          ← orchestrator (~80 LOC, was 498); public export unchanged
  response-generation/
    load-context.ts        ← NEW: reads + DTO build + subscription guard + idempotency → discriminated outcome
    generate-draft.ts      ← NEW: voice learning + regen budget + generate + avoid-facts + 4-way classifier
    persist.ts             ← NEW: sql.begin tx (INVARIANT #4) + recordModerationAndHold tx-helper
    analytics.ts           ← NEW: maybeEnqueueFirstResponseDrafted (verbatim move)
    __tests__/
      generate-draft.test.ts          ← NEW unit tests for the classifier
  __tests__/
    ResponseGeneratorWorker.test.ts   (existing; untouched, stays green)
```

### Module responsibilities

- **`load-context.ts`** — `loadGenerationContext({ reviewId, businessId, version })`.
  The pre-generation gate: owns the two SELECTs, `NormalizedReview` +
  `BusinessContext` building, `checkSubscription`, and the idempotency query.
  Returns a discriminated outcome; performs the single
  `mergeLogContext({ account_id })` side-effect (after reading business, before
  the guard) to preserve current log-field ordering. **No `markOutbox*`, no
  logger** — those are shell effects.
- **`generate-draft.ts`** — `generateDraft(ctx, ids, logger)`. The deep
  generation module: voice learning → regen budget → generate (mock\|real) →
  avoid-facts guardrail, with the **4-way error classifier**. Owns failure
  logging (invariant #12: "modules own failure behavior"). `applyAvoidFactsGuardrail`
  and `findAvoidFactViolation` move here as private helpers.
- **`persist.ts`** — `persistResponseAndNotify(input)`. The **invariant #4
  transactional boundary**: keeps the single `sql.begin`. Extracts exactly one
  named tx-helper, `recordModerationAndHold(tx, …): Promise<boolean>` (the
  moderation-metadata `api_costs` UPDATE + the `flagged_responses` hold; returns
  `held`). Response insert, cost-row links, and the `send_notification` enqueue
  stay **inline in the same tx** so the boundary remains one readable function.
- **`analytics.ts`** — `maybeEnqueueFirstResponseDrafted(input)`. Verbatim move;
  already a clean best-effort, swallow-on-failure function.
- **`ResponseGeneratorWorker.ts`** — orchestrator. Setup → `loadGenerationContext`
  (switch on outcome) → `generateDraft` → `moderateResponse` →
  `persistResponseAndNotify` → `maybeEnqueueFirstResponseDrafted` →
  `markOutboxCompleted`. **All `markOutbox*` calls and terminal-outcome logs live
  only here.**

## Key contracts

### `load-context.ts`

```ts
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
}): Promise<LoadOutcome>;
```

The `existing` payload carries the row's own `business_id`/`account_id`
(not the job's) so the shell's `maybeEnqueueFirstResponseDrafted` call matches
current behavior byte-for-byte.

### `generate-draft.ts`

```ts
export type DraftOutcome =
  | { kind: 'ok'; result: GenerationResult; retryCostId?: string }  // retryCostId now typed (was `as any`)
  | { kind: 'failed'; reason: string };                             // permanent → shell markOutboxFailed

export async function generateDraft(
  ctx: GenerationContext,
  ids: { reviewId: string; version: number; businessId: LocationId },
  logger: WorkerLogger,
): Promise<DraftOutcome>;
```

**Error classification (preserved exactly):**

| Error | Today | After |
|---|---|---|
| `CostLimitExceededError` / `GlobalCostLimitExceededError` | `markOutboxFailed` + return | `{ kind: 'failed', reason }` (logs warn) |
| `ConcurrencyLimitExceededError` | `throw` (retry) | **re-thrown** (propagates to BullMQ via shell) |
| `TransientLLMError` | `throw` (retry, logs warn) | **re-thrown** (logs warn) |
| permanent gen error | `markOutboxFailed` + return (logs error) | `{ kind: 'failed', reason }` (logs error) |
| `RegenBudgetExceededError` (version > 1) | `markOutboxFailed` + return (logs warn) | `{ kind: 'failed', reason }` (logs warn) |
| avoid-facts guardrail failure | `markOutboxFailed` + return (logs error) | `{ kind: 'failed', reason: 'guardrail_failed: …' }` (logs error) |

`applyAvoidFactsGuardrail` returns `{ result, retryCostId? }` instead of stashing
`(merged as any)._retryCostId`. The `merged.apiCostId` restore (original cost id)
is unchanged — persist still links both cost rows.

### `persist.ts`

```ts
export async function persistResponseAndNotify(input: {
  result: GenerationResult;
  retryCostId?: string;
  reviewId: string;
  businessId: string;
  version: number;
  correlationId: string | undefined;
  suppressNotification: boolean;
  moderation: ModerationDecision;
  accountId: string;
}): Promise<string>;
```

Positional 8-arg signature → options object (reduces the param-count smell; no
external caller to update). Inside, the single `sql.begin` runs, in order:
response INSERT → `api_costs` response_id links (orig + retry) →
`recordModerationAndHold(tx, …)` → `if (suppressNotification || held) return` →
`send_notification` outbox INSERT.

```ts
// colocated with the sql.begin so the invariant is visually obvious
async function recordModerationAndHold(tx, args): Promise<boolean>;
// returns flaggedHigh; writes moderation metadata always (if moderatedCostId),
// writes flagged_responses row only when high-severity
```

`moderatedCostId = retryCostId ?? result.apiCostId` (moderation describes the
final output; on avoid-facts retry the final text's cost row is the retry's).

## Orchestrator (`handleResponseGeneration`) shape

```ts
const logger = createWorkerLogger('[ResponseGeneratorWorker]', job.data.correlation_id);
const { review_id, version } = job.data;
const businessId = asLocationId(job.data.business_id);
const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
mergeLogContext({ outbox_id: outboxId });

const loaded = await loadGenerationContext({ reviewId: review_id, businessId, version });
switch (loaded.kind) {
  case 'review_not_found':
    logger.warn(`Review ${review_id} not found`);
    return markOutboxFailed(outboxId, 'review_not_found', attempt);
  case 'business_not_found':
    logger.warn(`Business ${businessId} not found`);
    return markOutboxFailed(outboxId, 'business_not_found', attempt);
  case 'subscription_blocked':
    logger.log(`Business ${businessId} skipped: ${loaded.reason}`);
    return markOutboxCompleted(outboxId, attempt);
  case 'already_exists':
    logger.log(`Response already exists for review ${review_id} v${version}, completing outbox`);
    await maybeEnqueueFirstResponseDrafted({
      accountId: loaded.existing.accountId, businessId: loaded.existing.businessId,
      responseId: loaded.existing.id, reviewId: review_id, logger,
    });
    return markOutboxCompleted(outboxId, attempt);
}
const { ctx } = loaded; // kind === 'ready'

const draft = await generateDraft(ctx, { reviewId: review_id, version, businessId }, logger);
if (draft.kind === 'failed') return markOutboxFailed(outboxId, draft.reason, attempt);
// ConcurrencyLimitExceededError / TransientLLMError thrown inside generateDraft
// propagate to BullMQ exactly as before (no catch here).

const moderation = await moderateResponse(draft.result.responseText);

const responseId = await persistResponseAndNotify({
  result: draft.result, retryCostId: draft.retryCostId,
  reviewId: review_id, businessId, version,
  correlationId: job.data.correlation_id,
  suppressNotification: job.data.suppress_notification === true,
  moderation, accountId: ctx.accountId,
});

await maybeEnqueueFirstResponseDrafted({
  accountId: ctx.accountId, businessId, responseId, reviewId: review_id, logger,
});
await markOutboxCompleted(outboxId, attempt);
logger.log(`Response ${responseId} generated for review ${review_id} (v${version})`);
```

## Behavior-preservation map (the hard requirement)

| Original outcome | Where it lives now | Net effect |
|---|---|---|
| review not found → `markOutboxFailed('review_not_found')` | `load` → `{review_not_found}`; shell effects | identical |
| business not found → `markOutboxFailed('business_not_found')` | `load` → `{business_not_found}`; shell effects | identical |
| `mergeLogContext({account_id})` before guard | `load`, after business read | identical ordering |
| subscription blocked → `markOutboxCompleted` | `load` → `{subscription_blocked, reason}`; shell logs + effects | identical |
| existing response → analytics + `markOutboxCompleted` | `load` → `{already_exists, existing}`; shell analytics + effects | identical (analytics before completed) |
| regen budget exceeded → `markOutboxFailed` | `generateDraft` → `{failed}` | identical |
| cost/global-cost limit → `markOutboxFailed` | `generateDraft` → `{failed}` | identical |
| concurrency / transient → `throw` | `generateDraft` re-throws | identical |
| permanent gen error → `markOutboxFailed` | `generateDraft` → `{failed}` | identical |
| avoid-facts retry (skipCache, cache overwrite, re-check) | `generateDraft`/`applyAvoidFactsGuardrail` | identical |
| guardrail failure → `markOutboxFailed` | `generateDraft` → `{failed: guardrail_failed}` | identical |
| moderation call on final text | shell, between generate + persist | identical input/timing |
| response INSERT + cost links + moderation meta + flagged_responses hold + send_notification skip, **one tx** | `persist.ts` `sql.begin` (hold via `recordModerationAndHold`) | identical, **same tx** |
| post-commit analytics + `markOutboxCompleted` + log | shell | identical |
| `_retryCostId` via `as any` | explicit `retryCostId` field | **same DB writes**, no `any` |

No behavioral deviation. The only diff is the removed `as any` casts.

## Testing plan

- **Existing `ResponseGeneratorWorker.test.ts`** — the characterization net.
  Untouched. The 13 tests mock at module boundaries (`db/server`, `outbox`,
  `generator`, `mock-generator`, `voice-learning`, `costs/tracker`,
  `analytics/enqueue`, `moderation/moderate`, `uuid`) and drive
  `handleResponseGeneration`. Sub-modules import those **same** paths, so
  `vi.mock` (resolved-module-ID based) still applies; the `instanceof
  CostLimitExceededError` check still resolves to the mocked class. Run after
  **every** extraction step; must stay 100% green.
- **NEW `response-generation/__tests__/generate-draft.test.ts`** — unit tests
  asserting `DraftOutcome` for each classifier branch: ok (returns result),
  cost-limit → `{failed}`, global-cost → `{failed}`, concurrency → re-throws,
  transient → re-throws, regen-budget (version > 1) → `{failed}`, permanent →
  `{failed}`, avoid-facts violation → retry sets `retryCostId` and returns the
  clean result, guardrail-persists-violation → `{failed: guardrail_failed}`.

## Execution order (TDD-refactor, suite green between each)

> Local lint/test are **not** run from this nested worktree (CLAUDE.md caveat:
> module resolution leaks into the parent `node_modules`/eslintrc). The green
> gate is the **CI runner** on push. Each step below is still committed
> separately so a regression bisects cleanly.

1. Create `response-generation/`; extract `analytics.ts`
   (`maybeEnqueueFirstResponseDrafted`) → import into worker.
2. Extract `persist.ts` (`persistResponseAndNotify` + `recordModerationAndHold`,
   options-object signature, typed `retryCostId`).
3. Extract `generate-draft.ts` (voice/budget/generate/avoid-facts + classifier;
   `applyAvoidFactsGuardrail` returns `{result, retryCostId?}`).
4. Extract `load-context.ts` (`loadGenerationContext`) → slim the worker to the
   orchestrator switch.
5. Add `generate-draft.test.ts`.
6. Push; CI gate green: `lint`, `typecheck`, `test`, `build` (+ `ci:tenant-scope`
   since SQL moves between files).

## Out of scope (deferred, documented)

- The `persistResponseAndNotify` tx is **not** further fragmented into
  insert/link/enqueue micro-helpers — design.md warns against tiny split-outs,
  and the doc says "leave the transactional boundary intact." Only the
  invariant-bearing moderation/hold branch gets a name.
- `moderateResponse` stays a one-line call in the shell (it is already a deep
  module in `src/lib/moderation/`).
- No change to `OPENAI_MODERATION_ENABLED` gating, the fail-open behavior, or any
  moderation rule.

## Success criteria

- `ResponseGeneratorWorker.ts` drops from **498 → ~80 LOC**;
  `handleResponseGeneration` from ~228 → ~50 lines of orchestration.
- Generation failure path is a named module (`generate-draft.ts`) with focused
  tests; the moderation/hold branch is a named tx-helper (`recordModerationAndHold`)
  — both honor CLAUDE.md invariant #12.
- Moderation-hold + `send_notification` skip remain in the **same transaction**
  as response persistence (invariant #4 intact).
- Two `as any` casts removed; no new `any`.
- Public surface (`handleResponseGeneration`) and `worker/index.ts` import
  unchanged; existing test file untouched and green.
- CI gate (`lint`, `typecheck`, `test`, `build`, `ci:tenant-scope`) all green.
- Lands as its own PR off `main`.
