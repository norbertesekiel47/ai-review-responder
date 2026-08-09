# Content-Freshness Gate at the Persist Boundary (#728) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revision 2** — incorporates codex plan-review round 1 (REVISE → fixed). Findings + triage: `docs/reviews/feat-728-content-freshness-gate/plan-review-round1.md`, `docs/superpowers/plans/feat-728-content-freshness-gate-deviations.md`.

**Goal:** Implement ADR 0017's lane-independent content-freshness gate: `persistResponseAndNotify` re-reads `review_content_hash` under the review `FOR UPDATE` lock it already takes first, and skips the responses INSERT (zero writes) when the loaded and current hashes are both non-null and differ, completing the job with the queryable completion reason `stale_review_content`.

**Architecture:** Deepen the existing persist module — no new seam. The gate predicate is a pure exported function; the persist interface changes only its return type (`Promise<string>` → discriminated `PersistResponseOutcome`), and the handler completes the outbox via `markOutboxCompletedWithReason` outside the tx, mirroring the archived-location skip precedent. The skip token joins `OUTBOX_COMPLETION_REASON` — the declared single owner of every `job_outbox.completion_reason` value (`markOutboxCompletedWithReason` is typed against it). `evaluateAutoApprovalCandidate` stays byte-identical (D-H, invariant #3).

**Tech Stack:** Postgres.js (`sql.begin` + `FOR UPDATE`), vitest txQueue mock harness, live-DB integration suite (`describeWithDb` + `seedTenantAccount`, two clients for lock serialization), fast-check.

**Authoritative references (read before your task):**
- ADR 0017: `docs/adr/0017-persist-boundary-freshness-gate.md` — the locked decision; every "why" lives there. NOTE the one locus correction: the skip token lives in `OUTBOX_COMPLETION_REASON`, not `worker-types.ts` (see deviations file).
- Intake: `docs/superpowers/plans/feat-728-content-freshness-gate-intake.json` — invariants + verbatim test titles.
- Precedents: `OUTBOX_COMPLETION_REASON` (`src/lib/shared/outbox-completion-reason.ts`); the `'skipped'` handler path (`worker/jobs/ResponseGeneratorWorker.ts:46-52`); `markOutboxCompletedWithReason` (`src/lib/shared/outbox.ts:134`); live-DB suite shape incl. two-client concurrency (`worker/jobs/response-generation/__tests__/auto-approval-daily-cap.integration.test.ts`).

**Shared language (CONTEXT.md terms — use verbatim):** *content-freshness gate* (the persist-boundary skip), *stale_review_content* (its one-owner completion reason), *skip-the-INSERT* (zero writes on skip; the `(review_id, version)` slot stays free).

---

### Task 1: EVAL — executable contract + failing tests

The contract compiles; every new behavior is red. This task makes the type-level interface change everywhere (so the repo typechecks) but implements NO gate behavior: the predicate stub returns `false`, persist never skips, the handler has no skip branch.

**Files:**
- Modify: `src/lib/shared/outbox-completion-reason.ts` (token)
- Modify: `worker/jobs/response-generation/persist.ts` (outcome type + predicate stub + return-shape change ONLY — no gate)
- Modify: `worker/jobs/ResponseGeneratorWorker.ts` (mechanical unwrap of the new return shape ONLY — no skip branch)
- Modify: `worker/jobs/response-generation/__tests__/persist.test.ts` (return-consumer unwrap at :293-295 and :763-765 + new describe block)
- Modify: `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts` (return-consumer unwrap at :430-454 and :475-516 — mechanical only)
- Modify: `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` (skip-handling test)
- Create: `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts`

(`worker/__tests__/correlation-chain.test.ts` never calls persist — no edit. The on-demand property test ignores the return — likely no edit; touch only if typecheck disagrees.)

- [ ] **Step 1: Token in outbox-completion-reason.ts** — add to the `OUTBOX_COMPLETION_REASON` object, following `IMPORT_CONSENT_BLOCKED`'s doc-comment style:

```ts
  /**
   * A `generate_response` job whose persist was refused by the
   * content-freshness gate (ADR 0017): review content changed between the
   * worker's load and the persist boundary. Zero writes happened — the
   * (review_id, version) slot stays free for the colliding fresh job, which
   * owns the current-content draft. Read by operators — no poller, no alert
   * (the gate working is not an incident; the structured log line in
   * persist.ts carries the per-fire detail).
   */
  STALE_REVIEW_CONTENT: 'stale_review_content',
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

- [ ] **Step 3: Mechanical unwrap at every return consumer.**
  - `worker/jobs/ResponseGeneratorWorker.ts`: replace `const responseId = await persistResponseAndNotify(sql, {...});` with

    ```ts
    const persisted = await persistResponseAndNotify(sql, { ... });
    const responseId = persisted.kind === 'persisted' ? persisted.responseId : ''; // Task 3 (#728) replaces this
    ```
  - `worker/jobs/response-generation/__tests__/persist.test.ts:293-295, 763-765` and `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts:430-454, 475-516`: unwrap the string consumers, e.g. `const outcome = await persistResponseAndNotify(...); if (outcome.kind !== 'persisted') throw new Error('expected persisted'); const responseId = outcome.responseId;` (or assert `expect(outcome).toEqual({ kind: 'persisted', responseId: ... })` where the test compared the string). Semantics of those tests must not change.

  Run `pnpm typecheck` — must be green.

- [ ] **Step 4: Unit + property tests in persist.test.ts** — new describe block. The txQueue harness shifts one queued row-set per `tx\`...\`` statement; the FIRST is the review-lock SELECT, so queue `[{ id: 'review-1', review_content_hash: <current> }]` there. Titles VERBATIM from the intake:

```ts
describe('content-freshness gate (ADR 0017)', () => {
  it('skips persist and returns skipped_stale_content when loaded and current hashes are both non-null and differ', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    const outcome = await persistResponseAndNotify(mockSql, baseInput({ loadedReviewContentHash: 'hash-loaded' }));
    expect(outcome).toEqual({ kind: 'skipped_stale_content' });
  });

  it('gate skip performs no writes: no responses INSERT, no api_costs link, no spine steps, no notification enqueue', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    await persistResponseAndNotify(mockSql, baseInput({ loadedReviewContentHash: 'hash-loaded', retryCostId: 'retry-cost-1' }));
    // The review-lock SELECT must be the ONLY tx statement, and nothing may
    // run on the top-level sql handle either (codex finding: a pre-gate
    // sql`UPDATE api_costs` outside the tx would evade a tx-only assertion).
    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockSql).not.toHaveBeenCalled(); // sql.begin is a property call, not a tagged-template call
    expect(findActiveReviewRun).not.toHaveBeenCalled();
    expect(recordStep).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it('content-freshness gate skips every generate-response origin lane before lane-specific work', async () => {
    // A gate conditional on one lane would pass every other test in this file.
    for (const lane of GENERATE_RESPONSE_ORIGIN_LANES) {
      vi.clearAllMocks();
      txQueue.length = 0;
      txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
      const outcome = await persistResponseAndNotify(mockSql, baseInput({
        loadedReviewContentHash: 'hash-loaded',
        originLane: lane,
        version: lane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW ? 1 : 2,
      }));
      expect(outcome, `lane ${lane}`).toEqual({ kind: 'skipped_stale_content' });
      expect(mockTx, `lane ${lane}`).toHaveBeenCalledTimes(1);
    }
  });

  it('gate skip logs stale_review_content with review_id, business_id, version, and origin_lane without raw hashes', async () => {
    txQueue.push([{ id: 'review-1', review_content_hash: 'hash-current' }]);
    const log = vi.fn();
    await persistResponseAndNotify(mockSql, baseInput({ loadedReviewContentHash: 'hash-loaded', logger: { log, warn: vi.fn() } }));
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      reason: OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT,
      review_id: 'review-1',
      business_id: expect.any(String),
      version: expect.any(Number),
      origin_lane: expect.any(String),
    }));
    const [, fields] = log.mock.calls[0];
    expect(JSON.stringify(fields)).not.toContain('hash-loaded');
    expect(JSON.stringify(fields)).not.toContain('hash-current');
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

Build `baseInput(overrides)` from the file's existing input fixtures (default non-auto lane `ON_DEMAND_GENERATE`, `suppressNotification: false`, clean moderation, spy logger). The three "persists when…" tests queue the follow-on rows the existing happy-path tests queue (crib from a neighbouring non-candidate test in the same file). Import `GENERATE_RESPONSE_ORIGIN_LANES` from worker-types and `OUTBOX_COMPLETION_REASON` from outbox-completion-reason.

- [ ] **Step 5: Handler test in ResponseGeneratorWorker.test.ts.** Codex-corrected recipe: (a) declare `mockMarkOutboxCompletedWithReason` in the HOISTED `vi.hoisted` block alongside `mockMarkOutboxCompleted` and add it to the `vi.mock('../../../src/lib/shared/outbox', ...)` factory; (b) the analytics seam in this file is `mockEnqueueAnalyticsEvent` — there is no direct `maybeEnqueueFirstResponseDrafted` mock; (c) the default job carries no `outbox_attempt`, so assert `undefined`, not `expect.anything()`. Title VERBATIM:

```ts
it('completes the outbox with stale_review_content and skips first_response_drafted on a gate skip', async () => {
  vi.mocked(persistResponseAndNotify).mockResolvedValueOnce({ kind: 'skipped_stale_content' });
  // arrange the happy-path load/generate mocks exactly as the nearest passing generation test does
  await handleResponseGeneration(job);
  expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
    expect.anything(), expect.any(String), OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT, undefined,
  );
  expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled(); // first_response_drafted must not fire
});
```

- [ ] **Step 6: Integration suite (new file)** — `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts`. Mirror the harness of `auto-approval-daily-cap.integration.test.ts`: `describeWithDb`, TWO `postgres` clients (dbA/dbB — the lock-serialization test needs genuine concurrency), `seedTenantAccount`/`cleanupTenantAccount`, review INSERT column list copied from that suite's seed. No migration-074 helper needed: the `ON_DEMAND_GENERATE` lane is a structural non-candidate and never reads 074 columns. Header comment states the suite's subject (the stale-content direction #678's race test does NOT cover) and that it executes no DDL. **Each test arranges its own review row (distinct reviewId per test) — no cross-test state dependence** (codex ordering-hazard finding). Tests, titles VERBATIM:

```ts
it('persist gate skips the INSERT when review content changed after load (stale-content direction)', async () => {
  // Own review seeded with review_content_hash 'hash-loaded', PLUS a real
  // api_costs row (input apiCostId = its id) and an ACTIVE agent_runs row for
  // the review — so a partial write (cost link, spine step) cannot hide
  // behind null inputs (codex finding).
  await dbA`UPDATE reviews SET review_content_hash = 'hash-current', review_text = 'edited text' WHERE id = ${reviewId}`;
  const outboxBefore = await dbA`SELECT count(*)::int AS n FROM job_outbox WHERE topic = 'send_notification' AND payload->>'business_id' = ${businessId}`;
  const outcome = await persistResponseAndNotify(dbA, input({ loadedReviewContentHash: 'hash-loaded', apiCostId: costId }));
  expect(outcome).toEqual({ kind: 'skipped_stale_content' });
  expect(await dbA`SELECT id FROM responses WHERE review_id = ${reviewId}`).toHaveLength(0);
  const [cost] = await dbA`SELECT response_id, flagged FROM api_costs WHERE id = ${costId}`;
  expect(cost.response_id).toBeNull(); // no cost link, no moderation metadata write
  expect(await dbA`SELECT id FROM agent_run_steps WHERE run_id = ${runId}`).toHaveLength(0);
  expect(await dbA`SELECT id FROM agent_outcomes WHERE run_id = ${runId}`).toHaveLength(0);
  const outboxAfter = await dbA`SELECT count(*)::int AS n FROM job_outbox WHERE topic = 'send_notification' AND payload->>'business_id' = ${businessId}`;
  expect(outboxAfter[0].n).toBe(outboxBefore[0].n); // send_notification payloads carry response_id/business_id, NOT review_id — baseline diff, not a review_id filter (codex finding)
});

it('persist gate leaves the (review_id, version) slot free for the colliding fresh job', async () => {
  // Own review; first a skip (loaded 'hash-loaded' vs current 'hash-current'),
  // then a fresh persist at the SAME version with the MATCHING current hash
  // must succeed — no unique violation: skip-the-INSERT left the slot free.
  await dbA`UPDATE reviews SET review_content_hash = 'hash-current' WHERE id = ${reviewId2}`;
  await persistResponseAndNotify(dbA, input2({ loadedReviewContentHash: 'hash-loaded' }));
  const outcome = await persistResponseAndNotify(dbA, input2({ loadedReviewContentHash: 'hash-current' }));
  expect(outcome).toEqual(expect.objectContaining({ kind: 'persisted' }));
  expect(await dbA`SELECT version FROM responses WHERE review_id = ${reviewId2}`).toEqual([{ version: 1 }]);
});

it('persist gate re-reads review_content_hash under the review FOR UPDATE lock (blocks on a concurrent content-change tx, then skips)', async () => {
  // The discriminating test (codex finding): an implementation that reads the
  // hash BEFORE taking the lock sees the still-committed 'hash-loaded',
  // matches, blocks on B's row lock, then persists stale after B commits.
  // Client B: open a tx holding the review row lock with the content change uncommitted.
  const bDone = dbB.begin(async (txB) => {
    await txB`UPDATE reviews SET review_content_hash = 'hash-current' WHERE id = ${reviewId3}`;
    await releaseGate; // a Promise the test resolves after asserting A blocks
  });
  // Client A: persist with the stale loaded hash — must BLOCK on the FOR UPDATE.
  const aPending = persistResponseAndNotify(dbA, input3({ loadedReviewContentHash: 'hash-loaded' }));
  const raced = await Promise.race([aPending.then(() => 'resolved'), delay(250).then(() => 'blocked')]);
  expect(raced).toBe('blocked');
  resolveReleaseGate(); await bDone; // B commits the content change
  const outcome = await aPending; // A re-reads under the lock → sees 'hash-current' → skips
  expect(outcome).toEqual({ kind: 'skipped_stale_content' });
  expect(await dbA`SELECT id FROM responses WHERE review_id = ${reviewId3}`).toHaveLength(0);
});
```

`input(overrides)`: clean moderation, `originLane: ON_DEMAND_GENERATE`, `version: 1`, `suppressNotification: false`, no-op logger `{ log: () => {}, warn: () => {} }`; `apiCostId: null` everywhere except the first test. Seed the active `agent_runs` row and the `api_costs` row by cribbing the column lists from the run-spine and cost-tracker integration/unit fixtures (their INSERTs are the authoritative shapes); `delay` is a local `(ms) => new Promise(...)` helper. The first test's mismatch-persist path must also assert the run is STILL running (`SELECT status FROM agent_runs WHERE id = ${runId}` → `running`) — a gate that completes/fails the run would strand the colliding fresh job's spine.

- [ ] **Step 7: Run and record red.** `pnpm vitest run worker/jobs/response-generation/__tests__/persist.test.ts worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` — expect the 4 gate-behavior unit tests + handler test + property skip-cases FAIL, "persists when…" tests PASS. With `TEST_DATABASE_POOL_URL` set: `pnpm vitest run worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` — expect all three FAIL (INSERT currently happens; the lock test times out or persists). `pnpm typecheck` green.

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
      reason: OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT,
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

Do not log hash values (the decision-summary precedent deliberately carries no raw hashes). Import `OUTBOX_COMPLETION_REASON` from `src/lib/shared/outbox-completion-reason`.

- [ ] **Step 4: Verify** — `pnpm vitest run worker/jobs/response-generation/__tests__/persist.test.ts` all green; `pnpm typecheck` green. Confirm `git diff` shows ZERO changes to `auto-approval.ts` (D-H).
- [ ] **Step 5: Commit** — `git commit -am "feat(#728): content-freshness gate at the persist boundary (ADR 0017)"`

### Task 3: Handler skip branch — turns the handler test green

**Blocking edge:** Task 2.
**Files:** Modify `worker/jobs/ResponseGeneratorWorker.ts`.

- [ ] **Step 1:** Replace Task 1's shim with the real branch (import `OUTBOX_COMPLETION_REASON` + `markOutboxCompletedWithReason`):

```ts
const persisted = await persistResponseAndNotify(sql, { ... });
if (persisted.kind === 'skipped_stale_content') {
  // Content-freshness gate fired (ADR 0017): nothing was persisted, so the
  // job completes — not fails — with the queryable completion reason. The
  // colliding fresh job (already its own outbox row) generates the
  // current-content draft.
  await markOutboxCompletedWithReason(sql, outboxId, OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT, outboxAttempt);
  return;
}
const responseId = persisted.responseId;
```

The persist-side log line is the observability signal — do not double-log here (the archived-location path logs handler-side only because load-context has no logger; persist does).

- [ ] **Step 2: Verify** — `pnpm vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` green; `pnpm typecheck` green.
- [ ] **Step 3: Commit** — `git commit -am "feat(#728): complete gate-skipped jobs with stale_review_content"`

### Task 4: Integration suites green — the ticket-mandated stale direction + ripple proof

**Blocking edge:** Tasks 2 + 3.
**Files:** `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` (fix-forward only if red for harness reasons).

- [ ] **Step 1:** With `TEST_DATABASE_POOL_URL` set: `pnpm vitest run worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts` — expect ALL THREE tests PASS. If red for seeding/harness reasons, fix the suite, never the gate semantics (a semantic mismatch is a deviations-file entry).
- [ ] **Step 2:** Prove no regression in the two neighbouring live suites this branch touches or shares locks with: `pnpm vitest run worker/jobs/response-generation/__tests__/auto-approval-daily-cap.integration.test.ts worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts` — green.
- [ ] **Step 3: Commit** — `git commit -am "test(#728): stale-content direction integration coverage green"`

### Task 5: CONTEXT.md glossary term (independent — may run parallel to Tasks 2–4)

**Blocking edge:** Task 1 (contract locked). Disjoint files from all other tasks.
**Files:** Modify `CONTEXT.md`.

- [ ] **Step 1:** Add a section following the file's `## <topic> (locked <date> — <ticket>)` convention:

```markdown
## Content-freshness gate (locked 2026-08-09 — ADR 0017, tickets #724/#728)

- **Content-freshness gate** — the lane-independent check at the persist boundary of response generation: under the review `FOR UPDATE` lock `persistResponseAndNotify` takes as its first statement, the current `review_content_hash` is re-read and compared with the hash the worker loaded before the LLM call. Both non-null and different → **skip-the-INSERT**: the job completes (never fails) with the one-owner completion reason **`stale_review_content`** (`OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`), writing NOTHING — the `(review_id, version)` slot stays free for the colliding fresh job. A null hash on either side passes: it is a freshness check, not a provenance proof. The auto lane's stricter hash gate in `evaluateAutoApprovalCandidate` is unchanged defense in depth (invariant #3).
```

- [ ] **Step 2: Commit** — `git commit -am "docs(#728): CONTEXT.md gains the content-freshness gate term"`

---

**Mutually independent for parallel dispatch:** Task 5 ∥ (Tasks 2→3→4 serial chain). Task 1 always runs alone first (enforcement spot check).

**Self-review done (rev 2):** every intake `tests_to_add` title (now 12) appears verbatim in Tasks 1/4; the return-consumer inventory matches codex's verified list; the handler-test recipe matches the file's actual hoisted-mock + analytics-seam shape; each integration test owns its review state; no placeholders except deliberate crib-from-precedent instructions where the precedent file is the spec (txQueue fixtures, live-DB seed column lists); type names consistent (`PersistResponseOutcome`, `hasStaleReviewContent`, `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`) across all tasks.
