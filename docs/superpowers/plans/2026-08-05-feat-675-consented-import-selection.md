# Consented Import Selection (#675) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `ZernioBackfillWorker` as the consented **Review import** executor — newest 100 inside the **Import window** (12-month floor, below the **live-ingest cutoff**), answered + unanswered alike, stored via `importReview` with nothing auto-drafted, paging until target met with loud cap exhaustion, writing only the collapsed counters.

**Architecture:** The worker's outbox-topic interface (`handleZernioBackfill(sql, job)`, `zernio_initial_backfill` payload) is unchanged — we deepen the implementation. Three seams move: `connectionCutoff` graduates from poller-private to `zernio-ingest-shared.ts` as `liveIngestCutoff` (two callers now — the disjoint-ownership invariant lives there); `reconcileExternallyAnsweredReview` gains a `consentedImport` option (the consented lane imports answered rows unconditionally; `EXTERNAL_REPLY_IMPORT_ENABLED` keeps governing the live lane); selection becomes the exported pure function `selectImportWindow` (the property-test surface). Storage goes through `importReview` (#674) — no `generate_response`, no `job_outbox` writes.

**Tech Stack:** TypeScript, Postgres.js, BullMQ (unchanged), vitest + fast-check (property test, house style `src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).

**Intake:** `docs/superpowers/plans/feat-675-consented-import-selection-intake.json` (locked 2026-08-05, RISK=high). Design of record: spec §6.1, map #667, ticket #675 + its two comments (#674 hand-off, #673 F2 constraint).

**Locked design calls (grilling 2026-08-05):**
1. **Disjoint ownership** resolves the #674 lost-draft hazard: import selects only `createTime < connected_at − grace` (exact complement of the poller's `isRecentForConnection`). No `processReview` change.
2. **KPI skew accepted**; pre-GA decision ticket filed as #688.
3. **No run-semantics column**: #680 discriminates pre/post-cutover rows by deploy timestamp, commented on #680 at promotion (step 8).
4. **Answered imports unconditional** in the consented lane via `consentedImport: true`.

**Plan-level notes for executors:**
- `worker/index.ts:218-221` has a now-stale comment ("4× listAllReviews pages + up to 75 processReview calls"). OUT of the edit surface — deliberately deferred to the post-merge `document-feature` sweep. Do not touch it.
- Answered reviews are NOT PHI-screened worker-side (same as today); `reconcileExternallyAnsweredReview` does its own PHI handling on the import branches. A PHI-skipped answered review still increments `imported_count` (reconcile returns void); the PHI exception row is the audit trail. Stated in the worker doc comment (Task 5).
- Legacy counters (`gap_*`/`historical_*`) are `NOT NULL DEFAULT 0` (migration 028) — the worker must end this PR with ZERO references to them (the #673 F2 "legacy writer contract ends here"), so #680's DROP cannot break it.
- `listAllReviews` keeps its other callers (publisher verifier, ops script) — the worker just stops calling it.

---

### Task 1: Eval task — glossary + promised-test stubs (runs ALONE first)

**Files:**
- Modify: `CONTEXT.md` (glossary — after the existing **Import consent** entry, line ~26)
- Modify: `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` (§6.1)
- Modify: `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`

- [ ] **Step 1: Coin the glossary terms in `CONTEXT.md`** (immediately after the **Import consent** bullet):

```markdown
- **Import window**: the set of reviews the consented Review import may select from — `createTime` within `[now − 12 months, live-ingest cutoff)`. The 100 is a ceiling inside this window, the 12-month floor a hard stop; whichever binds first wins (spec D3/D4). The upper bound makes lane ownership **disjoint by construction**: everything at or above the cutoff belongs to the live lane (webhook + recent poller), everything below it to the import — so a review stored by `importReview` can never be one the live lane owed a draft for (the #674 lost-draft hazard, resolved structurally at #675). When a location has no `connected_at`, the poller owns nothing and the import applies no upper bound — complementarity is preserved at both ends. Selection is owned by the pure `selectImportWindow` (`worker/jobs/zernio/ZernioBackfillWorker.ts`). _Avoid_: fetch window, backfill window, gap/historical (dead vocabulary). *(coined in #675 grilling)*
- **Live-ingest cutoff**: `connected_at − ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS` (default 5 min) for a location's active `zernio_connections` row — the instant from which the live lane owns review handling. One owner: `liveIngestCutoff` (`worker/jobs/zernio/zernio-ingest-shared.ts`), consumed by the recent poller (`isRecentForConnection`, ≥ cutoff) and the Review import (Import window upper bound, < cutoff). Null `connected_at` → null cutoff; each lane interprets null per its own fail direction (poller: owns nothing; import: no upper bound). _Avoid_: recency cutoff, connect grace (that names the env var, not the boundary). *(coined in #675 grilling)*
```

- [ ] **Step 2: Amend spec §6.1** — append to the "Backfill worker" bullet list:

```markdown
- **Selection is bounded above by the live-ingest cutoff** (#675, 2026-08-05):
  the import takes only `createTime < connected_at − grace`, the exact
  complement of the recent poller's `isRecentForConnection`. Lane ownership is
  disjoint by construction, which resolves the #674 "lost draft" hazard
  structurally — a review the live lane owes a draft for can never be stored
  first by the import. No upper bound when `connected_at` is null.
```

- [ ] **Step 3: Add promised-test title stubs** — a new top-level describe appended at the end of `ZernioBackfillWorker.test.ts` (existing tests untouched in this task; they still pass against the old implementation). Titles expanded per plan-review round 1 (2026-08-05):

```ts
// ── #675 consented-import selection — spec stubs ─────────────────────────
// Titles are the intake's tests_to_add VERBATIM (promised-tests gate).
// Bodies land in Tasks 3 and 5, which flip it.todo → it.
describe('consented import selection (#675)', () => {
  it.todo('imports newest 100 reviews within the 12-month floor, answered and unanswered alike');
  it.todo('excludes reviews at or after connected_at minus grace from the import selection (live-lane ownership)');
  it.todo('imports nothing and completes successfully when the window is empty');
  it.todo('stores answered reviews as list rows with their posted response regardless of EXTERNAL_REPLY_IMPORT_ENABLED');
  it.todo('enqueues no generate_response and writes no job_outbox row for imported reviews');
  it.todo('pages until the target is met and stops early at the 12-month floor when ordering is clean');
  it.todo('fails the outbox row terminally with ZernioImportPaginationCapExhaustedError and leaves completed_at NULL on cap exhaustion');
  it.todo('logs a non-descending page order warning and disables early stops for that run');
  it.todo('continues paging to feed end or cap when ordering is dirty instead of stopping at the target');
  it.todo('writes only imported_count and skipped_count; legacy counters stay at their defaults');
  it.todo('counts PHI and malformed reviews as skipped and already-ingested rows as imported');
  it.todo('routes answered PHI reviews through reconciliation and counts them imported');
  it.todo('skips as success when no active connection row exists, leaving completed_at NULL');
  it.todo('applies no upper cutoff when connected_at is NULL');
  it.todo('property: selection is always within the Import window and never exceeds 100 rows');
  it.todo('marks the outbox completed only after the run completion write succeeds');
  it.todo('passes each nextPageToken to the following listReviews request');
  it.todo('imports the exact globally newest 100 from shuffled multi-page results');
  it.todo('imports every available review when the feed ends below 100');
  it.todo('does not report cap exhaustion when the target is met or a clean floor stop ends paging');
  it.todo('derives the 12-calendar-month floor at run time and keeps paging at floor equality');
  it.todo('recomputes the import floor from runtime now on retry');
  it.todo('skips all provider and storage work when the run is already completed');
  it.todo('reactivation runs use the identical import window and stay correlation-idempotent');
  it.todo('reactivation INSERT names no legacy counter column');
  it.todo('sets skipped_count from cap overflow and oldest_skipped_create_time to the chronologically oldest overflow');
  it.todo('deduplicates reviews repeated across page boundaries');
});
```

And a stub describe appended to `zernio-ingest-shared.test.ts` (bodies land in Tasks 2 and 4):

```ts
// ── #675 consented import — spec stubs (Tasks 2 & 4 flip these) ──────────
describe('consented import seams (#675)', () => {
  it.todo('stores the external posted response when a consented answered import supersedes an active draft');
  it.todo('honors configured ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS in liveIngestCutoff');
});
```

And one stub appended to `ZernioRecentReviewPoller.test.ts` (body lands in Task 2 — the poller half of the complementarity boundary):

```ts
it.todo('processes a review at the live-ingest cutoff and skips one below it under configured grace');
```

- [ ] **Step 4: Run the suites** — `pnpm vitest run worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts` → all existing tests PASS; 27 todo (worker suite) + 2 todo (shared suite) + 1 todo (poller suite).
- [ ] **Step 5: Commit** — `git add CONTEXT.md docs/superpowers/specs/2026-08-05-consented-review-import-design.md worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts && git commit -m "test(#675): eval stubs + Import window / live-ingest cutoff glossary"`

---

### Task 2: Live-ingest cutoff — shared seam (blocked by T1)

**Files:**
- Modify: `worker/jobs/zernio/zernio-ingest-shared.ts` (new export near the top, after the type aliases)
- Modify: `worker/background/pollers/ZernioRecentReviewPoller.ts:97-118`
- Test: `worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts` (should pass unchanged; add one delegation test)

- [ ] **Step 1: Add `liveIngestCutoff` to `zernio-ingest-shared.ts`:**

```ts
// ── Live-ingest cutoff (CONTEXT.md glossary) ─────────────────────────────
// connected_at − grace: the instant from which the live lane (webhook +
// recent poller) owns review handling. The recent poller processes only
// createTime >= cutoff (isRecentForConnection); the consented Review import
// selects only createTime < cutoff. Disjoint by construction — this is what
// makes the #674 lost-draft hazard structurally impossible. Null connected_at
// → null; each caller interprets null per its own fail direction (poller:
// owns nothing; import: no upper bound).
const DEFAULT_CONNECT_GRACE_MS = 5 * 60_000;

export function liveIngestCutoff(connectedAt: Date | null): Date | null {
  if (!connectedAt) return null;
  const connectedMs = connectedAt.getTime();
  if (!Number.isFinite(connectedMs)) return null;
  const parsed = parseInt(getWorkerConfig().ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS ?? '', 10);
  const graceMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECT_GRACE_MS;
  return new Date(connectedMs - graceMs);
}
```

Add `import { getWorkerConfig } from '../../../src/lib/config/worker';` to the file's imports. (Check `ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS` is a `WorkerConfig` key — it is; the poller reads it via `readPositiveInt` today.)

- [ ] **Step 2: Delegate in the poller** — replace the bodies of `connectionCutoff` and `isRecentForConnection` (`ZernioRecentReviewPoller.ts:102-118`), delete the poller-local `DEFAULT_CONNECT_GRACE_MS` constant (line ~33):

```ts
function isRecentForConnection(review: ZernioReview, connectedAt: Date | null): boolean {
  const cutoff = liveIngestCutoff(connectedAt);
  if (!cutoff) return false; // poller owns nothing without a connect time
  const reviewMs = new Date(review.createTime).getTime();
  return Number.isFinite(reviewMs) && reviewMs >= cutoff.getTime();
}

function connectionCutoff(connectedAt: Date | null): Date | null {
  return liveIngestCutoff(connectedAt);
}
```

Add `liveIngestCutoff` to the existing `zernio-ingest-shared` import in the poller. If `readPositiveInt` now has only the grace call site removed but other callers remain, leave it; if it becomes unused, delete it.

- [ ] **Step 3: Flip the two grace-boundary stubs (both lanes, non-default grace).** (a) In `zernio-ingest-shared.test.ts`, "honors configured ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS in liveIngestCutoff": set `ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS=120000` via the suite's config seam, assert `liveIngestCutoff(new Date(T))` equals `T − 120000` (not the 5-min default), and `liveIngestCutoff(null)` is null. (b) In `ZernioRecentReviewPoller.test.ts`, "processes a review at the live-ingest cutoff and skips one below it under configured grace": same 120s grace, `connected_at = T`; a review with `createTime = T − 120000` (exactly at the cutoff) is processed and one at `T − 120001` is skipped — the poller half of the complementarity boundary. Task 5's live-lane ownership test covers the import half (`< cutoff` imports, `>= cutoff` excluded) under the same configured grace; together the two lanes partition the boundary with no gap and no overlap (plan-review r1 MEDIUM, r2 finding 6).
- [ ] **Step 4: Run** — `pnpm vitest run worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts` → PASS. NOTE: if the poller suite mocks `zernio-ingest-shared`, its mock factory must now also export `liveIngestCutoff` (re-export the real one via `vi.importActual` or reimplement the 3-line math).
- [ ] **Step 5: Commit** — `git commit -m "refactor(#675): liveIngestCutoff shared seam — poller delegates"`

---

### Task 3: `selectImportWindow` pure selection + property test (blocked by T1; independent of T2/T4)

**Files:**
- Modify: `worker/jobs/zernio/ZernioBackfillWorker.ts` (add exports; old handler untouched in this task)
- Test: `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`

- [ ] **Step 1: Add the pure function + constants to `ZernioBackfillWorker.ts`:**

```ts
export const IMPORT_TARGET_COUNT = 100;
export const IMPORT_FLOOR_MONTHS = 12;

export interface ImportSelection {
  /** newest-first, ≤ IMPORT_TARGET_COUNT, every member inside the Import window */
  selected: ZernioReview[];
  /** in-window reviews beyond the ceiling — the skipped_count seed */
  capOverflow: ZernioReview[];
  oldestSkippedCreateTime: string | null;
}

/**
 * Pure selection over the Import window (CONTEXT.md glossary): keep reviews
 * with floorMs <= createTime < upperCutoffMs (upper null = no bound, the
 * connected_at-null case), sort newest-first (defensive re-sort — Zernio's
 * ordering is verified but undocumented, spec §9), take the newest
 * IMPORT_TARGET_COUNT. Unparseable createTime is excluded outright (the
 * normalization path would reject it anyway).
 */
export function selectImportWindow(
  reviews: ZernioReview[],
  opts: { floorMs: number; upperCutoffMs: number | null },
): ImportSelection {
  const inWindow = reviews.filter((z) => {
    const t = new Date(z.createTime).getTime();
    if (!Number.isFinite(t)) return false;
    if (t < opts.floorMs) return false;
    if (opts.upperCutoffMs !== null && t >= opts.upperCutoffMs) return false;
    return true;
  });
  const sorted = [...inWindow].sort(
    (a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime(),
  );
  const selected = sorted.slice(0, IMPORT_TARGET_COUNT);
  const capOverflow = sorted.slice(IMPORT_TARGET_COUNT);
  // Epoch comparison, NOT string comparison — lexicographic ordering of
  // RFC3339 strings with differing fractional-second lengths misorders
  // ('...00.5Z' vs '...00.500Z' etc.); plan-review r1 MEDIUM.
  const oldestSkippedCreateTime = capOverflow.reduce<string | null>(
    (oldest, z) =>
      !oldest || new Date(z.createTime).getTime() < new Date(oldest).getTime()
        ? z.createTime
        : oldest,
    null,
  );
  return { selected, capOverflow, oldestSkippedCreateTime };
}
```

- [ ] **Step 2: Flip the property stub to a real test** (fast-check; house style = `src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block). Also add plain example tests for the window edges under the same describe:

```ts
import fc from 'fast-check';
import { selectImportWindow, IMPORT_TARGET_COUNT } from '../ZernioBackfillWorker';

const FLOOR = Date.parse('2025-08-05T00:00:00Z');
const CUTOFF = Date.parse('2026-08-01T00:00:00Z');

const arbReview = fc
  .record({
    id: fc.uuid(),
    // createTimes from well before the floor to well after the cutoff
    t: fc.integer({ min: FLOOR - 400 * 86_400_000, max: CUTOFF + 30 * 86_400_000 }),
  })
  .map(({ id, t }) => ({
    id,
    name: `accounts/a1/locations/l1/reviews/${id}`,
    createTime: new Date(t).toISOString(),
    comment: 'x',
    starRating: 5,
    reviewReply: null,
  }) as unknown as ZernioReview);

it('property: selection is always within the Import window and never exceeds 100 rows', () => {
  fc.assert(
    fc.property(fc.array(arbReview, { maxLength: 300 }), (reviews) => {
      const { selected, capOverflow } = selectImportWindow(reviews, {
        floorMs: FLOOR,
        upperCutoffMs: CUTOFF,
      });
      // Partition completeness (plan-review r1): selected + capOverflow is
      // EXACTLY the in-window input multiset — no silent omissions — and
      // selected takes min(100, available).
      const inWindowIds = reviews
        .filter((z) => {
          const t = new Date(z.createTime).getTime();
          return Number.isFinite(t) && t >= FLOOR && t < CUTOFF;
        })
        .map((z) => z.id)
        .sort();
      const returnedIds = [...selected, ...capOverflow].map((z) => z.id).sort();
      expect(returnedIds).toEqual(inWindowIds);
      expect(selected.length).toBe(Math.min(IMPORT_TARGET_COUNT, inWindowIds.length));
      for (const z of [...selected, ...capOverflow]) {
        const t = new Date(z.createTime).getTime();
        expect(t).toBeGreaterThanOrEqual(FLOOR);
        expect(t).toBeLessThan(CUTOFF);
      }
      // selected is the NEWEST in-window slice: nothing in capOverflow is newer
      const oldestSelected = Math.min(...selected.map((z) => new Date(z.createTime).getTime()));
      for (const z of capOverflow) {
        expect(new Date(z.createTime).getTime()).toBeLessThanOrEqual(oldestSelected);
      }
    }),
  );
});
```

(`fc.uuid()` collisions are effectively impossible, so id-multiset equality is sound.)

Boundary examples (same describe): createTime exactly at floor → included; exactly at cutoff → excluded; `upperCutoffMs: null` → included regardless of recency (this also seeds Task 5's "applies no upper cutoff when connected_at is NULL" worker test).

- [ ] **Step 3: Run** — `pnpm vitest run worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` → property + examples PASS, 26 todo remain in the worker suite, old tests PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(#675): selectImportWindow pure selection + property test"`

---

### Task 4: `consentedImport` option on reconcile (blocked by T2 — same file)

**Files:**
- Modify: `worker/jobs/zernio/zernio-ingest-shared.ts` (`reconcileExternallyAnsweredReview`, line ~180)
- Test: `worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts`

- [ ] **Step 1: Write failing tests** in `zernio-ingest-shared.test.ts` (module-level; the intake's verbatim worker-level title lands in Task 5): with `EXTERNAL_REPLY_IMPORT_ENABLED` unset/false, (a) previously-unseen answered review + `{ consentedImport: true }` → review row inserted + imported `posted` response inserted (assert via the suite's existing sql/tx mock expectations for `insertImportedReview`/`insertImportedResponse` paths); (b) matched row with no active responses + `{ consentedImport: true }` → imported response inserted onto the existing row; (c) no option → existing silent-no-op behavior preserved (regression guard); (d) **flip the stub "stores the external posted response when a consented answered import supersedes an active draft"** — matched row with a non-matching active draft (`pending_approval`, `approved_text` ≠ external reply) + `{ consentedImport: true }` → draft superseded AND imported `posted` response inserted (branch 3 today supersedes and returns without storing the reply — a one-shot import would leave the review draft-killed and reply-less, violating D5; the live lane converges on a later poll, the import never re-runs); (e) matched row with active draft + PHI-flagged review text + `{ consentedImport: true }` → PHI exception opened, NO response insert (mirror of branch 2's PHI gate); (f) **mixed protected + stale set** — one active response whose `approved_text` MATCHES the external reply (protected) plus one stale draft + `{ consentedImport: true }` → stale draft superseded, protected response kept, and NO imported response inserted (the protected response already represents the reply; r2 fix-defect guard `protectedIds.size === 0`).
- [ ] **Step 2: Run to verify (a), (b), (d), (e) fail** — the flag guards short-circuit branches 1-2 and branch 3 has no insert at all.
- [ ] **Step 3: Implement** — add the optional last parameter and widen the two flag guards:

```ts
export async function reconcileExternallyAnsweredReview(
  sql: postgres.Sql,
  target: ZernioReview,
  businessId: string,
  accountId: string,
  locationId: string,
  logger: WorkerLogger,
  opts?: { consentedImport?: boolean },
): Promise<void> {
```

Both `if (!FLAG_ON()) {` guards (the previously-unseen branch and the matched-no-active-responses branch) become:

```ts
    const importAllowed = FLAG_ON() || opts?.consentedImport === true;
    if (!importAllowed) {
```

with a doc-comment line on the function: `consentedImport: the consented Review import lane (D5) imports answered rows unconditionally — EXTERNAL_REPLY_IMPORT_ENABLED governs only the live lane's posture.`

**Branch 3 (active responses) additionally gains a consented-lane-only import** (plan-review r1, HIGH): after the `supersededRows` UPDATE + log (line ~345), and ONLY under `opts?.consentedImport === true` (NOT under `FLAG_ON()` alone — live-lane behavior stays byte-identical, its eventual convergence via the next poll's branch 2 is deliberate):

```ts
    // Consented import runs ONCE per review — it cannot rely on the live
    // lane's eventual convergence, so store the external reply now (D5).
    // Mirrors branch 2: PHI gate, then insertImportedResponse + counter.
    // protectedIds.size > 0 means one of the active responses IS our own
    // reply (approved_text matches the external text) — the reply is already
    // represented locally; inserting an imported posted row would duplicate
    // it (r2 fix-defect on the mixed protected+stale case).
    if (opts?.consentedImport === true && target.reviewReply && protectedIds.size === 0) {
      if (targetPhi.matched) {
        await openPhiReviewException(tx, {
          businessId, accountId, locationId,
          review: target, reasons: targetPhi.reasons,
          source: 'external_reply_import',
        }, logger);
        logger.warn(
          `Likely PHI detected for matched review ${target.id}; review_text=${redactPhiForLog(targetComment)}; skipping external reply import`,
        );
        return;
      }
      const inserted = await insertImportedResponse(tx, businessId, matchedRows[0]!.id, null, target.reviewReply);
      if (inserted) {
        await bumpExternalReplyIngestedCount(tx, businessId);
        logger.log(`Imported external reply onto review row ${matchedRows[0]!.id} after superseding active draft(s)`);
      }
    }
```

The `supersedeIds.length === 0` early-return (all-protected: the external reply IS our own approved text reflecting back) stays as-is — the reply is already represented by our response row. Note `external_reply_ingested_count` is a **fifth, pre-existing** counter, NOT one of the four the #673 F2 contract freezes — answered imports legitimately bump it (triage verdict on r1 HIGH-5; recorded in deviations).

- [ ] **Step 4: Run** — `pnpm vitest run worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(#675): consentedImport option — answered rows import unconditionally in the consented lane"`

---

### Task 5: Worker rewrite (blocked by T2, T3, T4)

**Files:**
- Modify: `worker/jobs/zernio/ZernioBackfillWorker.ts` (rewrite `handleZernioBackfill`)
- Modify: `src/lib/config/worker.ts` (add `ZERNIO_IMPORT_MAX_PAGES: rawOpt` beside `ZERNIO_INGEST_MAX_PAGES`, line ~167)
- Modify: `.claude/reference/env-vars.md` (register `ZERNIO_IMPORT_MAX_PAGES`)
- Test: `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`

- [ ] **Step 1: Flip the remaining `it.todo` stubs in `ZernioBackfillWorker.test.ts` to real failing tests.** Harness changes (top of file): `mockListAllReviews` → `mockListReviews` (mock `zernioClient.listReviews`); add `mockImportReview` to the `process-review` mock factory (`{ processReview: mockProcessReview, importReview: mockImportReview }`); the `zernio-ingest-shared` mock factory re-exports the REAL `liveIngestCutoff` via `vi.importActual` (NOT a hard-coded 5-min reimplementation — the config seam is pinned by Task 2's test); `sqlReturnQueue` gains the `zernio_connections` SELECT row (`{ connected_at: <date> }`). **SQL-text assertions inspect `mockSql.mock.calls` (the tagged-template capture), NOT `sqlReturnQueue` — that is a FIFO of query RESULTS** (plan-review r1 correction). Time-dependent tests freeze time with `vi.useFakeTimers({ now: … })`. Key bodies:
  - *newest 100 / floor / answered+unanswered*: `mockListReviews` returns one page of 120 in-window reviews (mixed `reviewReply`) + 10 older-than-floor; assert `mockImportReview` called for unanswered selected, `mockReconcileExternallyAnsweredReview` called with `{ consentedImport: true }` for answered selected, total selected = 100, none older than floor.
  - *exact newest-100 IDs*: shuffled reviews across TWO pages (newest not first); assert the imported set is exactly the globally newest 100 BY ID (a handler that takes the first 100 fetched fails this).
  - *live-lane ownership*: configured grace 120s (real `liveIngestCutoff` via `vi.importActual` honors it), connection row `connected_at = T`; page contains reviews at `T`, `T − grace` (exactly at the cutoff), `T − grace − 1ms`, `T − 1yr + 1d`; assert only the last two import — the import half of the complementarity boundary (Task 2's poller test owns the other half).
  - *empty window*: one page, all older than floor → run completes (`completed_at` UPDATE issued, `markOutboxCompleted` called), `imported_count = 0`, no error.
  - *feed ends below 100*: 37 in-window reviews, no `nextPageToken` → all 37 import, run completes, NO cap failure.
  - *no generate_response / no job_outbox*: assert `mockProcessReview` NEVER called and no captured SQL string contains `INSERT INTO job_outbox`.
  - *pages until target / floor early-stop*: two pages of 50 in-window → exactly 2 `mockListReviews` calls (target met). Separate case: page 1 descends past the floor with `nextPageToken` set → exactly 1 call (early stop, ordering clean).
  - *token passing*: page 1 returns `nextPageToken: 'tok-2'` → assert call 2's options include `pageToken: 'tok-2'`.
  - *floor derivation + equality*: frozen `now`; rows exactly AT the 12-calendar-month floor import (inclusive); a clean page whose oldest row is exactly AT the floor does NOT early-stop (`<` comparison) — the next page is still fetched when a token exists and target is unmet.
  - *floor recompute on retry*: run once at frozen T1 (incomplete — reconcile failure), retry at frozen T2 = T1 + 48h → assert the second run's selection uses T2's floor (a row that aged out between attempts is no longer imported).
  - *cap exhaustion (terminal)*: `ZERNIO_IMPORT_MAX_PAGES=2` via config/env, every page 50 out-of-window (post-cutoff) reviews with `nextPageToken` set → `markOutboxFailed` called with a message containing `ZernioImportPaginationCapExhaustedError`/`cap=2`, `Sentry.captureException` called, NO `completed_at` UPDATE, NO throw (handler resolves), `markOutboxCompleted` NOT called.
  - *no false cap exhaustion*: (i) target met exactly on the capped page with a token still set → success, no failure; (ii) clean floor-stop before the cap with a token still set → success, no failure.
  - *ordering warning + dirty mode*: page with an ascending step + oldest item below floor + `nextPageToken` set → `mockLogger.warn` message contains `non-descending`, and paging CONTINUES (floor early-stop disabled). Companion test (dirty target-stop): inversion on page 1, 100 in-window collected, token set → paging continues to feed end/cap and the final selection is the newest 100 of EVERYTHING fetched.
  - *dedupe*: the same review id straddles pages 1 and 2 → imported once, counted once.
  - *counters*: assert the counters UPDATE SQL text includes `imported_count` and `skipped_count` and does NOT include `gap_processed_count`, `historical_processed_count`, `gap_skipped_count`, `historical_skipped_count` (via `mockSql.mock.calls`, same style as the dual-write test it replaces).
  - *skipped/oldest semantics*: 120 in-window rows → `skipped_count = 20` and `oldest_skipped_create_time` = the chronologically oldest overflow timestamp (fixture uses differing fractional-second precision to catch string comparison).
  - *reactivation INSERT column check*: reactivation payload → the captured INSERT into `zernio_backfill_runs` names NONE of the four legacy counter columns.
  - *reactivation window + idempotency*: same correlation_id twice with boundary rows (floor-equal, cutoff−1ms) → one run row claimed, identical selection semantics both attempts.
  - *completed-run sentinel*: run SELECT returns `completed_at != null` → NO fetch, NO storage calls, outbox completed.
  - *PHI / malformed / already-ingested counting*: unanswered PHI review → `mockOpenPhiReviewException` called, counted skipped; normalization throw → skipped; `mockImportReview` resolving `'unchanged'` → counted imported. Assert via the captured counters UPDATE parameters.
  - *answered PHI routing*: answered review whose text trips `detectLikelyPhi` → `mockReconcileExternallyAnsweredReview` IS called (no worker-side pre-screen for answered), `mockOpenPhiReviewException` NOT called by the worker, counted imported.
  - *outbox-completion ordering*: `completed_at = NOW()` UPDATE rejects → handler rejects and `markOutboxCompleted` is NEVER called.
  - *no active connection*: connection SELECT returns `[]` → `markOutboxCompleted` called, NO `completed_at` UPDATE, no fetch.
  - *connected_at NULL*: connection row `{ connected_at: null }` → year-old review imports (no upper bound).
- [ ] **Step 2: Run to verify the new tests fail** against the old implementation.
- [ ] **Step 3: Rewrite the handler.** Full target shape (header comment included — it replaces the gap/historical doc block):

```ts
// worker/jobs/zernio/ZernioBackfillWorker.ts
//
// Consented Review import executor (#675, spec §6.1). Handles the
// zernio_initial_backfill outbox topic. Initial runs are one-shot per
// business; reactivation catch-up runs are keyed by correlation_id.
// Idempotent via zernio_backfill_runs.completed_at IS NOT NULL sentinel.
//
// Selection: newest IMPORT_TARGET_COUNT reviews inside the Import window
// (CONTEXT.md glossary) — createTime in [now − 12 months, live-ingest
// cutoff). The upper bound keeps lane ownership disjoint: the live lane
// (webhook + recent poller) owns createTime >= cutoff, so nothing the
// import stores can be a review the live lane owed a draft for (#674).
//
// Nothing is auto-drafted (D2): unanswered reviews store via importReview
// (no generate_response, no job_outbox row); answered reviews become list
// rows via reconcileExternallyAnsweredReview({ consentedImport: true }) —
// review row + imported 'posted' response, regardless of
// EXTERNAL_REPLY_IMPORT_ENABLED. Answered reviews are not PHI-screened
// worker-side (reconcile owns PHI on its import branches); a PHI-skipped
// answered review still counts imported — the exception row is the audit
// trail.
//
// Counters: writes ONLY imported_count / skipped_count (+
// oldest_skipped_create_time). The four legacy gap_*/historical_* counters
// freeze at DEFAULT 0 — the #673 dual-write contract ended here; #680
// drops them.
```

New handler body, replacing everything from the `listAllReviews` call through the completion log (idempotency claim, run SELECT, and `guardZernioJobEligibility` stay verbatim EXCEPT the reactivation INSERT drops the four legacy counter columns and `oldest_skipped_create_time`/`started_at`/`updated_at` stay):

```ts
  // Live-ingest cutoff: read connected_at from the active connection.
  const [conn] = await sql<{ connected_at: Date | null }[]>`
    SELECT connected_at FROM zernio_connections
    WHERE business_id = ${business_id}
      AND zernio_account_id = ${zernio_account_id}
      AND zernio_location_id = ${zernio_location_id}
      AND status = 'active'
  `;
  if (!conn) {
    logger.warn(`No active connection for business=${business_id} — skipping import (completed_at left NULL)`);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }
  const cutoff = liveIngestCutoff(conn.connected_at);
  const upperCutoffMs = cutoff ? cutoff.getTime() : null;
  const floor = new Date();
  floor.setMonth(floor.getMonth() - IMPORT_FLOOR_MONTHS);
  const floorMs = floor.getTime();

  // Page until the target is met (spec §6.1). Newest-first ordering is
  // verified but undocumented (spec §9) — a non-descending page logs a
  // warning and disables BOTH early stops for this run (target and floor):
  // in dirty mode newer reviews may sit on later pages, so stopping at 100
  // could select the wrong newest-100. Dirty mode pages to feed end or cap.
  // Pages are deduped by review id — provider page boundaries may repeat.
  const maxPages = Math.max(1, parseInt(getWorkerConfig().ZERNIO_IMPORT_MAX_PAGES ?? '6', 10) || 6);
  const fetchedById = new Map<string, ZernioReview>();
  let pageToken: string | undefined;
  let pagesWalked = 0;
  let orderingClean = true;
  let prevMs = Infinity;
  let capExhaustedWithMorePages = false;
  const currentSelection = () =>
    selectImportWindow(
      [...fetchedById.values()].filter(
        (z) => extractLocationFromReviewName(z.name) === zernio_location_id,
      ),
      { floorMs, upperCutoffMs },
    );
  try {
    for (let i = 0; i < maxPages; i++) {
      const page = await zernioClient.listReviews(zernio_account_id, {
        locationId: zernio_location_id,
        pageSize: 50,
        pageToken,
      });
      pagesWalked += 1;
      let pageOldestMs = Infinity;
      for (const z of page.reviews) {
        const t = new Date(z.createTime).getTime();
        if (Number.isFinite(t)) {
          if (t > prevMs && orderingClean) {
            orderingClean = false;
            logger.warn(
              `Zernio page order non-descending at review ${z.id} (page ${pagesWalked}) — undocumented ordering changed? Early stops disabled for this run`,
            );
          }
          prevMs = t;
          pageOldestMs = Math.min(pageOldestMs, t);
        }
        if (!fetchedById.has(z.id)) fetchedById.set(z.id, z);
      }
      if (!page.nextPageToken) break;
      // Early stops are trusted ONLY while ordering is clean.
      if (orderingClean && currentSelection().selected.length >= IMPORT_TARGET_COUNT) break;
      if (orderingClean && pageOldestMs < floorMs) break; // everything further back is older
      if (i === maxPages - 1) {
        capExhaustedWithMorePages = true;
        break;
      }
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    await handleZernioIngestError(
      sql, err, outboxId, attempt as number,
      { business_id, zernio_account_id, zernio_location_id }, logger,
    );
    return;
  }

  const selection = currentSelection();

  if (capExhaustedWithMorePages && selection.selected.length < IMPORT_TARGET_COUNT) {
    // TERMINAL, loud, never silent (r1 HIGH-2). The condition is
    // deterministic — BullMQ retries would refetch the same pages — and the
    // backfill queue has no failed-hook, so persist the failure here: named
    // error in the failed outbox row + Sentry. completed_at stays NULL, so
    // after ops bumps ZERNIO_IMPORT_MAX_PAGES the run is still claimable via
    // admin re-enqueue (consent permitting, spec §5.3).
    // (Dirty-ordering cap-outs with >= 100 candidates proceed best-effort
    // instead — the ordering warning is the ops signal there.)
    const err = new ZernioImportPaginationCapExhaustedError(
      business_id, maxPages, selection.selected.length, fetchedById.size,
    );
    logger.error(err.message);
    Sentry.captureException(err);
    // Signature verified (r2): markOutboxFailed(exec, id, error, attempt) —
    // error THIRD. Prefix with err.name so the failed row carries the class.
    await markOutboxFailed(sql, outboxId, `${err.name}: ${err.message}`, attempt);
    return;
  }

  let importedCount = 0;
  let skippedCount = selection.capOverflow.length;
  const reconcileFailures: { reviewId: string; error: string }[] = [];

  for (const z of selection.selected) {
    // Loose-equality: an omitted reviewReply on the wire is 'unanswered'.
    if (z.reviewReply != null) {
      try {
        await reconcileExternallyAnsweredReview(
          sql, z, business_id, zernio_account_id, zernio_location_id, logger,
          { consentedImport: true },
        );
        importedCount += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Import reconcile failed for review ${z.id}: ${msg}`);
        reconcileFailures.push({ reviewId: z.id, error: msg });
      }
      continue;
    }

    const phi = detectLikelyPhi(z.comment);
    if (phi.matched) {
      logger.warn(
        `Likely PHI detected for import review ${z.id}; reasons=${phi.reasons.join(',')}; review_text=${redactPhiForLog(z.comment)}; skipping`,
      );
      await sql.begin((tx) => openPhiReviewException(tx, {
        businessId: business_id,
        accountId: zernio_account_id,
        locationId: zernio_location_id,
        review: z,
        reasons: phi.reasons,
        source: 'backfill',
      }, logger));
      skippedCount += 1;
      continue;
    }

    let monitored: MonitoredReview;
    try {
      monitored = buildZernioMonitoredReview(z, zernio_account_id, zernio_location_id);
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        logger.warn(`Skipping malformed review ${z.id}: ${err.message}`);
        skippedCount += 1;
        continue;
      }
      throw err;
    }
    await importReview(sql, monitored, business_id, job.data.correlation_id);
    importedCount += 1;
  }

  // Always update partial counts so ops can audit even on retry.
  await sql`
    UPDATE zernio_backfill_runs
    SET imported_count = ${importedCount},
        skipped_count = ${skippedCount},
        oldest_skipped_create_time = ${selection.oldestSkippedCreateTime},
        updated_at = NOW()
    WHERE id = ${run.id}
  `;

  if (reconcileFailures.length > 0) {
    throw new Error(
      `Import reconciliation failed for ${reconcileFailures.length} review(s): ` +
      reconcileFailures.map((f) => `${f.reviewId} (${f.error})`).join('; ') +
      ` — re-running on retry`,
    );
  }

  await sql`
    UPDATE zernio_backfill_runs
    SET completed_at = NOW(), updated_at = NOW()
    WHERE id = ${run.id}
  `;

  logger.log(
    `Import complete business=${business_id}: imported=${importedCount} skipped=${skippedCount} ` +
    `pages=${pagesWalked} window=[${new Date(floorMs).toISOString()}, ${cutoff ? cutoff.toISOString() : 'unbounded'})`,
  );

  await markOutboxCompleted(sql, outboxId, attempt);
```

Error class (top of file, ingest-worker precedent `ZernioReviewIngestWorker.ts:64`):

```ts
/** The page cap was exhausted with nextPageToken still set and fewer than
 *  IMPORT_TARGET_COUNT in-window reviews collected. Loud by design — the
 *  old backfill truncated silently at maxPages: 4 (spec §1). Deterministic,
 *  so it is persisted TERMINALLY (markOutboxFailed + Sentry, no BullMQ
 *  retry churn); completed_at stays NULL so the run remains claimable after
 *  ops bumps ZERNIO_IMPORT_MAX_PAGES (admin re-enqueue, consent permitting). */
export class ZernioImportPaginationCapExhaustedError extends Error {
  constructor(
    readonly businessId: string,
    readonly cap: number,
    readonly inWindowCount: number,
    readonly reviewsSeen: number,
  ) {
    super(`Import pagination cap=${cap} pages exhausted with ${inWindowCount}/${IMPORT_TARGET_COUNT} in-window reviews (${reviewsSeen} seen, more pages available)`);
    this.name = 'ZernioImportPaginationCapExhaustedError';
  }
}
```

Import changes: DROP `processReview`, `GENERATE_RESPONSE_ORIGIN_LANE`; ADD `importReview` (from `process-review`), `liveIngestCutoff` (from `./zernio-ingest-shared`), `getWorkerConfig` (from `src/lib/config/worker`), `markOutboxFailed` (from `src/lib/shared/outbox` — verify its real signature at implementation time; the test harness already stubs it), `* as Sentry from '@sentry/node'` (precedent: `zernio-ingest-shared.ts:13`). DELETE: `GAP_CAP`/`HISTORICAL_CAP`, both bucketing filters, `activeSinceMs` + its malformed-ISO guard, `processUnansweredReview`, the answered/unanswered split, the legacy-counter UPDATE columns, and the four legacy counter columns (plus explicit zeros) from the reactivation INSERT (they're `NOT NULL DEFAULT 0`, migration 028). KEEP: `isSubscriptionTier` validation, both idempotency INSERT/SELECT shapes, `guardZernioJobEligibility` call and its comment, the reconcile-failures collect-and-throw.

- [ ] **Step 4: Config + registry.** `src/lib/config/worker.ts`: add `ZERNIO_IMPORT_MAX_PAGES: rawOpt,` beside `ZERNIO_INGEST_MAX_PAGES` (line ~167). `.claude/reference/env-vars.md`: add a row in the same table section as `ZERNIO_INGEST_MAX_PAGES`: worker-only, optional, default 6, "page cap for the consented Review import's until-target fetch; cap exhaustion with target unmet raises `ZernioImportPaginationCapExhaustedError` (never truncates silently); bump + admin re-enqueue (consent permitting) is the ops remedy".
- [ ] **Step 5: Delete obsolete old-behavior tests** in the same file (bucketing caps, gap/historical counters, draft-generation assertions, `subscription_activated_at` malformed-ISO guard test, dual-write test) — each replaced by a Task 5 test; infra tests that remain true (idempotency sentinel, eligibility skip, reactivation correlation keying, outbox completion) are UPDATED to the new harness, not deleted.
- [ ] **Step 6: Run** — `pnpm vitest run worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` → all PASS, zero todo. Then the adjacent suites: `pnpm vitest run worker/jobs/zernio worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts` → PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(#675): consented-import selection — newest 100, 12-month floor, disjoint lane ownership, collapsed counters"`

---

### Task 6: Hazard docs + deviations init (blocked by T5)

**Files:**
- Modify: `src/lib/reviews/process-review.ts` (the `importReview` KNOWN HAZARD doc block, lines ~506-517)
- Create: `docs/superpowers/plans/feat-675-consented-import-selection-deviations.md`

- [ ] **Step 1: Rewrite the KNOWN HAZARD paragraph** in `importReview`'s doc comment (code untouched):

```
 * RESOLVED HAZARD (#674 D4 → #675, 2026-08-05) — a review stored here is
 * never drafted by the live lane; #675 made that structurally harmless via
 * disjoint lane ownership: the import's caller (ZernioBackfillWorker)
 * selects only createTime < the live-ingest cutoff (connected_at − grace),
 * the exact complement of the recent poller's isRecentForConnection, so a
 * review the live lane owes a draft for can never be stored first by the
 * import. See CONTEXT.md "Import window" / "Live-ingest cutoff" and spec
 * §6.1. The live lane's own semantics are unchanged: an existing row with
 * a matching hash still returns 'unchanged' without enqueueing.
```

- [ ] **Step 2: Create the deviations file** with the standing entries: (a) answered-PHI counts imported (plan note, pre-decided); (b) any surprises from Tasks 1-5.
- [ ] **Step 3: Full targeted run** — `pnpm vitest run worker/jobs/zernio src/lib/reviews worker/background/pollers` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "docs(#675): importReview hazard resolved by disjoint ownership; deviations init"`

---

## Task graph

```
T1 (eval, ALONE — enforcement spot check)
├─► T2 (cutoff seam) ─► T4 (reconcile option) ─┐
└─► T3 (selectImportWindow)  ──────────────────┴─► T5 (worker rewrite) ─► T6 (docs)
```

T2→T4 serial (both edit `zernio-ingest-shared.ts`). T3 is independent of T2/T4 (disjoint files) — may run in parallel with them after T1 passes its spot check. T5 needs all three. T6 last.

## Verify gate

Standard `scripts/verify-gate.sh` after T5 and T6; final pre-review run with `--review` (diff coverage ≥ 80%). `zernio-end-to-end.integration.test.ts` is NOT expected to change (it exercises ingest, not backfill) — if an executor finds otherwise, that's a deviations entry + gate run with `TEST_DATABASE_POOL_URL` set.
