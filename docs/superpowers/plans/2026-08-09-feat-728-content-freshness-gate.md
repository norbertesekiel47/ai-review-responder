# Content-Freshness Gate at the Persist Boundary (#728) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement ADR 0017's lane-independent content-freshness gate: `persistResponseAndNotify` re-reads `review_content_hash` under the review `FOR UPDATE` lock it already takes first, and skips the responses INSERT (zero writes) when the loaded and current hashes are both non-null and differ, completing the job with the queryable skip reason `stale_review_content`.

**Architecture:** Deepen the existing persist module — no new seam. The gate predicate is a pure exported function; the persist interface changes only its return type (`Promise<string>` → discriminated `PersistResponseOutcome`), and the handler completes the outbox via `markOutboxCompletedWithReason` outside the tx, mirroring the archived-location skip precedent. `evaluateAutoApprovalCandidate` stays byte-identical (D-H, invariant #3).

**Tech Stack:** Postgres.js (`sql.begin` + `FOR UPDATE`), vitest txQueue mock harness, live-DB integration suite (`describeWithDb` + `seedTenantAccount`), fast-check.

**Authoritative references (read before your task):**
- ADR 0017: `docs/adr/0017-persist-boundary-freshness-gate.md` — the locked decision; every "why" lives there.
- Intake: `docs/superpowers/plans/feat-728-content-freshness-gate-intake.json` — invariants + verbatim test titles.
- Precedents: `SKIP_REASON_ARCHIVED_LOCATION` (`src/lib/shared/worker-types.ts:22`); the `'skipped'` handler path (`worker/jobs/ResponseGeneratorWorker.ts:46-52`); `markOutboxCompletedWithReason` (`src/lib/shared/outbox.ts:134`); live-DB suite shape (`worker/jobs/response-generation/__tests__/auto-approval-daily-cap.integration.test.ts`).

**Shared language (CONTEXT.md terms — use verbatim):** *content-freshness gate* (the persist-boundary skip), *stale_review_content* (its one-owner skip-reason token), *skip-the-INSERT* (zero writes on skip; the `(review_id, version)` slot stays free).

---

### Task 1: EVAL — executable contract + failing tests

The contract compiles; every new behavior is red. This task makes the type-level interface change everywhere (so the repo typechecks) but implements NO gate behavior: the predicate stub returns `false`, persist never skips, the handler has no skip branch.

**Files:**
- Modify: `src/lib/shared/worker-types.ts` (token, below `SKIP_REASON_ARCHIVED_LOCATION`)
- Modify: `worker/jobs/response-generation/persist.ts` (outcome type + predicate stub + return-shape change ONLY — no gate)
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (mechanical unwrap of the new return shape ONLY — no skip branch)
- Modify: `worker/jobs/response-generation/__tests__/persist.test.ts` (new describe blocks)
- Modify: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` (skip-handling test)
- Create: `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts`
- Modify (compile ripple only, if they consume the return value): `worker/jobs/__tests__/correlation-chain.test.ts`, `worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts`

- [ ] **Step 1: Token in worker-types.ts** — add directly below `SKIP_REASON_ARCHIVED_LOCATION`:

```ts
// Queryable skip-reason token emitted by the persist-boundary content-freshness
// gate (ADR 0017): a generate_response job completed WITHOUT persisting because
// review content changed after the worker loaded it. One owner so ops queries
// filter on a single value.
export const SKIP_REASON_STALE_REVIEW_CONTENT = 'stale_review_content' as const;
```

- [ ] **Step 2: Contract in persist.ts** — add the outcome type + stub predicate; change the function's return shape (behavior otherwise untouched):

```ts
export type PersistResponseOutcome =
  | { kind: 'persisted'; responseId: string }
  | { kind: 'skipped_stale_content' };

/**
 * The content-freshness gate predicate (ADR 0017). A freshness check, not a
 * provenance proof: a null hash on EITHER side passes — legacy pre-hash
 * reviews must keep generating.
 */
export function hasStaleReviewContent(
  loadedReviewContentHash: string | null,
  currentReviewContentHash: string | null,
): boolean {
  return false; // Task 2 implements; eval stays red until then
}
```

Change the signature `Promise<string>` → `Promise<PersistResponseOutcome>` and the final `return responseId;` → `return { kind: 'persisted', responseId };`. Do NOT touch `acquirePersistLocks` or add any gate call yet.

- [ ] **Step 3: Mechanical unwrap in ResponseGeneratorWorker.ts** — replace

```ts
const responseId = await persistResponseAndNotify(sql, { ... });
```

with

```ts
const persisted = await persistResponseAndNotify(sql, { ... });
const responseId = persisted.kind === 'persisted' ? persisted.responseId : '';
```

(temporary shim inside this task only — Task 3 replaces it with the real skip branch; leave a `// Task 3 (#728) replaces this` comment). Fix any other compile ripple in the three test files that consume the old string return (unwrap to `.responseId` on the persisted branch). Run `pnpm typecheck` — must be green.

- [ ] **Step 4: Unit + property tests in persist.test.ts** — new describe block. The txQueue harness resolves each `tx\`...\`` call in order; the FIRST queued row is the review-lock SELECT. Queue `[{ id: 'review-1', review_content_hash: <current> }]` there to model the re-read. Titles VERBATIM from the intake:

```ts
describe('content-freshness gate (ADR 0017)', () => {
  it('skips persist and returns skipped_stale_content when loaded and current hashes are both non-null and differ', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    const outcome = await persistResponseAndNotify(mockSql, baseInput({ loadedReviewContentHash: 'hash-loaded' }));
    expect(outcome).toEqual({ kind: 'skipped_stale_content' });
  });

  it('gate skip performs no writes: no responses INSERT, no api_costs link, no spine steps, no notification enqueue', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    await persistResponseAndNotify(mockSql, baseInput({ loadedReviewContentHash: 'hash-loaded' }));
    // The review-lock SELECT must be the ONLY tx statement.
    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(findActiveReviewRun).not.toHaveBeenCalled();
    expect(recordStep).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('persists when loaded hash is null (legacy pre-hash review passes the gate)', async () => { /* loadedReviewContentHash: null, current 'hash-current' → kind 'persisted', responses INSERT issued */ });
  it('persists when current hash is null', async () => { /* loaded 'hash-loaded', queue row { review_content_hash: null } → 'persisted' */ });
  it('persists when hashes match', async () => { /* both 'hash-1' → 'persisted' */ });

  it('content-freshness gate skips iff both hashes are non-null and differ', () => {
    // fast-check house style: src/lib/reviews/__tests__/sentiment.test.ts "invariants" block
    fc.assert(fc.property(
      fc.option(fc.string(), { nil: null }),
      fc.option(fc.string(), { nil: null }),
      (loaded, current) => {
        expect(hasStaleReviewContent(loaded, current))
          .toBe(loaded !== null && current !== null && loaded !== current);
      },
    ));
  });
});
```

Build `baseInput(overrides)` from the file's existing input fixtures (non-auto lane: `originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE`, `suppressNotification: false`, clean moderation). The three "persists when…" tests queue the follow-on rows the existing happy-path tests queue (crib from a neighbouring non-candidate test in the same file).

- [ ] **Step 5: Handler test in ResponseGeneratorWorker.test.ts** — add `markOutboxCompletedWithReason: mockMarkOutboxCompletedWithReason` to the existing `vi.mock('../../../src/lib/shared/outbox', ...)` factory, then:

```ts
it('completes the outbox with stale_review_content and skips first_response_drafted on a gate skip', async () => {
  vi.mocked(persistResponseAndNotify).mockResolvedValueOnce({ kind: 'skipped_stale_content' });
  // arrange the happy-path load/generate mocks exactly as the nearest passing generation test does
  await handleResponseGeneration(job);
  expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
    expect.anything(), expect.any(String), SKIP_REASON_STALE_REVIEW_CONTENT, expect.anything(),
  );
  expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  expect(maybeEnqueueFirstResponseDrafted).not.toHaveBeenCalled(); // via the file's analytics mock
});
```

- [ ] **Step 6: Integration suite (new file)** — `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts`. Mirror the harness of `auto-approval-daily-cap.integration.test.ts`: `describeWithDb`, ONE `postgres` client (no concurrency needed — the eval direction is sequential stale-load-then-persist), `seedTenantAccount`/`cleanupTenantAccount`, review INSERT column list copied from that suite's seed. No migration-074 helper needed: the `ON_DEMAND_GENERATE` lane is a structural non-candidate and never reads 074 columns. Header comment must state the suite's subject (the stale-content direction #678's race test does NOT cover) and that it executes no DDL. Tests, titles VERBATIM:

```ts
it('persist gate skips the INSERT when review content changed after load (stale-content direction)', async () => {
  // Seed review with review_content_hash 'hash-loaded'. The worker "loaded" it:
  const loadedReviewContentHash = 'hash-loaded';
  // Live-ingest commits a content change while the LLM call is in flight:
  await db`UPDATE reviews SET review_content_hash = 'hash-current', review_text = 'edited text' WHERE id = ${reviewId}`;
  const outcome = await persistResponseAndNotify(db, input({ loadedReviewContentHash }));
  expect(outcome).toEqual({ kind: 'skipped_stale_content' });
  const rows = await db`SELECT id FROM responses WHERE review_id = ${reviewId}`;
  expect(rows).toHaveLength(0);
  const outbox = await db`SELECT id FROM job_outbox WHERE payload->>'review_id' = ${reviewId}`;
  expect(outbox).toHaveLength(0); // no notification enqueue either
});

it('persist gate leaves the (review_id, version) slot free for the colliding fresh job', async () => {
  // After the skip above (same review, version 1), a fresh persist at the SAME
  // version with a MATCHING hash must succeed — no unique violation, proving
  // skip-the-INSERT left the slot free.
  const outcome = await persistResponseAndNotify(db, input({ loadedReviewContentHash: 'hash-current' }));
  expect(outcome).toEqual(expect.objectContaining({ kind: 'persisted' }));
  const rows = await db`SELECT version FROM responses WHERE review_id = ${reviewId}`;
  expect(rows).toEqual([{ version: 1 }]);
});
```

`input(overrides)`: `apiCostId: null` (skips cost-link writes), clean moderation, `originLane: ON_DEMAND_GENERATE`, `version: 1`, `suppressNotification: false`, no-op logger `{ log: () => {}, warn: () => {} }`. The seeded tenant has no active `agent_runs` row, so spine writes self-skip.

- [ ] **Step 7: Run and record red.** `cd` worktree; `pnpm vitest run worker/jobs/response-generation/__tests__/persist.test.ts worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` — expect the 3 gate-behavior unit tests + handler test + property skip-cases FAIL, "persists when…" tests PASS. With `TEST_DATABASE_POOL_URL` set: `pnpm vitest run worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` — expect both FAIL (INSERT currently happens). `pnpm typecheck` green.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "test(#728): eval for the persist-boundary content-freshness gate (red)"`

### Task 2: Gate implementation in persist.ts — turns unit + property green

**Blocking edge:** Task 1.
**Files:** Modify `worker/jobs/response-generation/persist.ts` only.

- [ ] **Step 1: Implement the predicate** (replace the stub body):

```ts
  return loadedReviewContentHash !== null
    && currentReviewContentHash !== null
    && loadedReviewContentHash !== currentReviewContentHash;
```

- [ ] **Step 2: Re-read under the existing lock.** In `acquirePersistLocks`, widen the review-lock SELECT — same statement, still the tx's FIRST:

```ts
const [reviewLock] = await tx<{ id: string; review_content_hash: string | null }[]>`
  SELECT id, review_content_hash FROM reviews
  WHERE id = ${reviewId} AND business_id = ${businessId}
  FOR UPDATE
`;
```

Change the function's return type `Promise<void>` → `Promise<{ currentReviewContentHash: string | null }>` and end with `return { currentReviewContentHash: reviewLock?.review_content_hash ?? null };` (orphan no-op → `null` → gate passes; existing Sentry posture unchanged). Extend the lock's doc comment: the freshness re-read rides this statement (ADR 0017).

- [ ] **Step 3: The gate.** Immediately after the `acquirePersistLocks` call inside `sql.begin`, before the responses INSERT:

```ts
let staleContentSkip = false;
await sql.begin(async (tx) => {
  const { currentReviewContentHash } = await acquirePersistLocks(tx, { ... });

  // Content-freshness gate (ADR 0017): runs before the lane split, covers all
  // lanes. Skip-the-INSERT keeps the (review_id, version) slot free for the
  // colliding fresh job — persisting in ANY status would starve it via the
  // idempotency check. Zero writes on skip.
  if (hasStaleReviewContent(loadedReviewContentHash, currentReviewContentHash)) {
    logger.log('content-freshness gate skipped persist', {
      reason: SKIP_REASON_STALE_REVIEW_CONTENT,
      review_id: reviewId,
      business_id: businessId,
      version,
      origin_lane: originLane,
    });
    staleContentSkip = true;
    return; // tx commits with zero writes
  }
  // ... existing body byte-identical ...
});
return staleContentSkip
  ? { kind: 'skipped_stale_content' }
  : { kind: 'persisted', responseId };
```

Do not log hash values (the decision-summary precedent deliberately carries no raw hashes). Import `SKIP_REASON_STALE_REVIEW_CONTENT` from worker-types.

- [ ] **Step 4: Verify** — `pnpm vitest run worker/jobs/response-generation/__tests__/persist.test.ts` all green; `pnpm typecheck` green. Confirm `git diff` shows ZERO changes to `auto-approval.ts` (D-H).
- [ ] **Step 5: Commit** — `git commit -am "feat(#728): content-freshness gate at the persist boundary (ADR 0017)"`

### Task 3: Handler skip branch — turns the handler test green

**Blocking edge:** Task 2.
**Files:** Modify `worker/jobs/ResponseGeneratorWorker.ts`.

- [ ] **Step 1:** Replace Task 1's shim with the real branch (import the token + `markOutboxCompletedWithReason`):

```ts
const persisted = await persistResponseAndNotify(sql, { ... });
if (persisted.kind === 'skipped_stale_content') {
  // Content-freshness gate fired (ADR 0017): nothing was persisted, so the
  // job completes — not fails — with the queryable skip reason. The colliding
  // fresh job (already its own outbox row) generates the current-content draft.
  await markOutboxCompletedWithReason(sql, outboxId, SKIP_REASON_STALE_REVIEW_CONTENT, outboxAttempt);
  return;
}
const responseId = persisted.responseId;
```

The persist-side log line is the observability signal — do not double-log here (the archived-location path logs handler-side only because load-context has no logger; persist does).

- [ ] **Step 2: Verify** — `pnpm vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts worker/jobs/__tests__/correlation-chain.test.ts` green; `pnpm typecheck` green.
- [ ] **Step 3: Commit** — `git commit -am "feat(#728): complete gate-skipped jobs with stale_review_content"`

### Task 4: Integration suite green — the ticket-mandated stale direction

**Blocking edge:** Tasks 2 + 3.
**Files:** `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` (fix-forward only if red for harness reasons).

- [ ] **Step 1:** With `TEST_DATABASE_POOL_URL` set (gate resolves `.env.local` itself, but run explicitly here): `pnpm vitest run worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` — expect BOTH tests PASS. If red for seeding/harness reasons, fix the suite, never the gate semantics (a semantic mismatch is a deviations-file entry).
- [ ] **Step 2:** Also run the neighbouring live suite to prove no regression: `pnpm vitest run worker/jobs/response-generation/__tests__/auto-approval-daily-cap.integration.test.ts` — green.
- [ ] **Step 3: Commit** — `git commit -am "test(#728): stale-content direction integration coverage green"`

### Task 5: CONTEXT.md glossary term (independent — may run parallel to Tasks 2–4)

**Blocking edge:** Task 1 (contract locked). Disjoint files from all other tasks.
**Files:** Modify `CONTEXT.md`.

- [ ] **Step 1:** Add a section following the file's `## <topic> (locked <date> — <ticket>)` convention:

```markdown
## Content-freshness gate (locked 2026-08-09 — ADR 0017, tickets #724/#728)

- **Content-freshness gate** — the lane-independent check at the persist boundary of response generation: under the review `FOR UPDATE` lock `persistResponseAndNotify` takes as its first statement, the current `review_content_hash` is re-read and compared with the hash the worker loaded before the LLM call. Both non-null and different → **skip-the-INSERT**: the job completes (never fails) with the one-owner skip reason **`stale_review_content`**, writing NOTHING — the `(review_id, version)` slot stays free for the colliding fresh job. A null hash on either side passes: it is a freshness check, not a provenance proof. The auto lane's stricter hash gate in `evaluateAutoApprovalCandidate` is unchanged defense in depth (invariant #3).
```

- [ ] **Step 2: Commit** — `git commit -am "docs(#728): CONTEXT.md gains the content-freshness gate term"`

---

**Mutually independent for parallel dispatch:** Task 5 ∥ (Tasks 2→3→4 serial chain). Task 1 always runs alone first (enforcement spot check).

**Self-review done:** every intake `tests_to_add` title appears verbatim in Tasks 1/4; no placeholders except deliberate crib-from-precedent instructions where the precedent file is the spec (txQueue fixtures, live-DB seed columns); type names consistent (`PersistResponseOutcome`, `hasStaleReviewContent`, `SKIP_REASON_STALE_REVIEW_CONTENT`) across all tasks.
