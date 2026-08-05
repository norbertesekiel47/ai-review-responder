# importReview — store a review without enqueueing generation (#674)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `importReview` to `src/lib/reviews/process-review.ts` — an insert-only path that stores a review with sentiment classification and a **completed** `review_ingested` run-spine record, enqueues no `generate_response`, and never mutates an existing review row.

**Architecture:** We deepen one existing module rather than adding a seam. `src/lib/reviews/process-review.ts` gains a second named entry point, `importReview`, beside `processReview`; the two share a new **private** helper, `insertNewReviewRow`, which is an *internal* seam (used by the implementation, never exposed in the interface). `importReview` structurally cannot reach `processExistingReview`, so "no behaviour change for existing callers" is a property of the code rather than a claim the tests must defend. Two deliberate departures from `processReview`, both justified below: there is **no `SELECT … FOR UPDATE` probe** (an existing row means zero writes, so the INSERT's `ON CONFLICT` is the whole decision, and taking no lock keeps a 100-review import from contending with live-ingest work), and the run **completes inside the insert transaction** (nothing downstream would ever complete it, so it would otherwise read as `stalled`).

**Tech Stack:** TypeScript, Postgres.js (tagged templates on a `TransactionSql`), vitest with a mocked `sql.begin`, uuidv7 PKs.

**Ticket:** [#674](https://github.com/RepWorth/ai-review-responder/issues/674) (KEYSTONE) · **Map:** [#667](https://github.com/RepWorth/ai-review-responder/issues/667) · **Spec:** `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.2 (now owned by `main` via #681 — see deviations D1/D12) · **Intake:** `docs/superpowers/plans/feat-674-import-review-no-generation-intake.json` · **Deviations:** `docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md`

**Plan review:** round 1 codex session `019fd129-092f-7e93-8409-854489caac01` → `REVISE`; this revision addresses it. Verdicts in the Review appendix.

---

## Glossary (CONTEXT.md language — use verbatim)

- **Review import** — the consented, one-time storage of an owner's newest 100 Google reviews as *inventory*. It stores reviews; it writes no replies (spec D2). The user-facing noun is **import**, never "backfill", even though the mechanism keeps its `zernio_initial_backfill` topic name.
- **Run spine** — `agent_runs` / `agent_run_steps` / `agent_outcomes`, written only through `src/lib/agents/run-spine.ts`.
- **Live-ingest lane** — the existing webhook/poller path through `processReview` that drafts a reply for every new review.

## Provenance of decisions — what the spec settles vs. what this ticket settles

The spec is an **epic-level** document. Its §6.2 states the requirement only —
"storing a review as inventory needs a path that inserts and stops… sentiment
classification still runs at the write site" — and its §2 locks D2 ("nothing is
auto-drafted"). Everything below is a **ticket-level** design decision made in
this run's grilling session and signed off by the owner on 2026-08-05; do not
read them back into the spec, and do not treat a conflict with them as a
spec violation:

| Decision | Source |
|---|---|
| Insert-and-stop path exists; sentiment at the write site; nothing auto-drafted | spec §6.2 + D2 |
| A separate `importReview` entry point rather than a `skipGeneration` flag | this ticket |
| Existing row ⇒ zero writes, never the update state machine | this ticket |
| `'new'` / `'unchanged'` return contract, race collapses to `'unchanged'` | this ticket |
| No `SELECT … FOR UPDATE` probe | this ticket |
| Run spine written **and completed** in the insert transaction | this ticket (deviations D3) |
| `first_review_ingested` fires from the import | this ticket |
| Cross-lane lost draft deferred to #675 — **not** merely a race; see the corrected D4 | this ticket (deviations D4) |

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/reviews/process-review.ts` | The review-write module: dedup by provider identity, content-hash state machine, and (new) insert-only import | Modify — extract `insertNewReviewRow`, have `startReviewRun` return its `runId`, add exported `importReview` |
| `src/lib/reviews/__tests__/process-review.test.ts` | Unit tests for both entry points | Modify — one line in the run-spine mock factory, plus a sibling `describe('importReview')` block |
| `src/lib/reviews/__tests__/import-review.integration.test.ts` | Live-Postgres proof that the new path actually executes | **Create** |
| `CONTEXT.md` | Project glossary | Modify — add the **Review import** term |

**One new file, justified.** `importReview` ships with **no callers**, so nothing in the repository executes its SQL — a wrong column name, a constraint violation, or a broken `ON CONFLICT` would pass every mocked gate and be inherited as a broken keystone by #675. The mocked suite asserts the *bindings*; only a live-DB suite asserts the statement *runs*. It cannot live in `process-review.test.ts`: live-DB suites must be named `*.integration.test.ts` so vitest serializes them into the `integration` project (concurrent DDL against sibling suites deadlocks with 40P01 — see the CLAUDE.md gotcha and lab-notes "#573"). `docs/directory.md` needs no entry — it maps production code, and every sibling `__tests__/` directory is already covered by its parent entry.

**Deliberate non-DRY:** the new `describe('importReview')` block duplicates ~12 lines of the existing `beforeEach` tx harness instead of hoisting a shared `setupTxHarness()`. For a KEYSTONE ticket whose hard requirement is "no behaviour change for any existing caller", leaving the existing `describe('processReview')` block **byte-for-byte untouched** is visible regression evidence in the diff, and that is worth more than 12 lines of deduplication. Do not refactor the existing block. The **only** shared-harness edit in this plan is adding `completeRun` to the module-scope `vi.mock('@/lib/agents/run-spine')` factory — required because `importReview` imports it, and behaviour-neutral for the existing tests since `processReview` never calls it.

## Hazards — known, deliberately not fixed here

**Cross-lane lost draft (deviations D4, as corrected in branch review round 1).** A review stored by `importReview` is **never drafted by any lane**, and this needs **no race**. The live lane enqueues `generate_response` only when it INSERTS a review or when the content hash CHANGES; a later `processReview` for an already-imported row takes the existing-row path, matches the hash, and returns `'unchanged'` without enqueueing (`processExistingReview`, the `existingHash === contentHash` branch). `ZernioBackfillWorker.processUnansweredReview` routes through the same `processReview`, so it is not a rescue either. The concurrent INSERT race is merely the simultaneous instance of this; the **sequential** case — import runs first, live lane polls later — is the common one.

Fixing it means giving the live lane a durable "generation still owed" claim consulted in `processReview`'s existing-row branch — exactly the behaviour change this ticket forbids, guarding a hazard with no caller on this branch. Owner decision (2026-08-05): document and file on #675, which owns *when* the import runs. **Do not "fix" this while implementing.** The #675 comment must carry the corrected (non-race) statement — the original framing would send an implementer after a narrow concurrency guard.

## Task graph

- **Task 1** (eval) — no blocking edges. Runs alone.
- **Task 2** — blocked by Task 1.
- **Task 3** — no blocking edges, disjoint file set (`CONTEXT.md` only). **Mutually independent with Task 2**; may run as a concurrent subagent.
- **Task 4** — blocked by Task 2 (it calls the real `importReview`).

---

### Task 1: Eval — the eight failing tests

**Files:**
- Modify: `src/lib/reviews/__tests__/process-review.test.ts`

- [ ] **Step 1: Add `completeRun` to the run-spine mock factory**

The file mocks the run-spine seam at lines 32-35. `importReview` calls `completeRun`, so the factory must export it or the import resolves to `undefined`. Replace that factory with:

```typescript
vi.mock('@/lib/agents/run-spine', () => ({
  startOrGetActiveRun: vi.fn().mockResolvedValue({ runId: 'run-1', created: true }),
  recordStep: vi.fn(),
  completeRun: vi.fn(),
}));
```

This is the only edit to shared harness. It cannot affect the existing `processReview` tests — that path never calls `completeRun`.

- [ ] **Step 2: Extend the imports**

Two existing lines change. The entry-point import (line 38):

```typescript
import { processReview, importReview } from '../process-review';
```

and the run-spine import (line 41):

```typescript
import { startOrGetActiveRun, recordStep, completeRun } from '@/lib/agents/run-spine';
```

Leave every other import, mock factory, and fixture (`makeMonitoredReview`, `withCount`, `capturedJsonbPayloads`) exactly as-is — the new block reuses them.

- [ ] **Step 3: Append the new describe block**

Append at the end of the file, after the existing `describe('processReview', …)` closes:

```typescript
// ── importReview (#674) ───────────────────────────────────────────────
//
// Insert-only import path. Deliberately duplicates the tx harness rather
// than hoisting a shared helper: the existing describe('processReview')
// block above must stay byte-for-byte untouched, because "no behaviour
// change for any existing caller" is this ticket's hard requirement and the
// unmodified block is the visible evidence for it.

describe('importReview', () => {
  let tx: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedJsonbPayloads.splice(0);

    tx = vi.fn();
    (tx as unknown as { json: ReturnType<typeof vi.fn> }).json = vi.fn((v: unknown) => {
      capturedJsonbPayloads.push(v);
      return v;
    });

    (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin =
      vi.fn().mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  });

  // tx call sequence on the insert path — THREE calls. There is no
  // SELECT FOR UPDATE probe (an existing row means zero writes, so the
  // INSERT's ON CONFLICT is the whole decision) and no job_outbox INSERT
  // (nothing is enqueued). startOrGetActiveRun / recordStep / completeRun are
  // mocked at the seam and issue no tagged-template calls of their own:
  //   1. INSERT reviews … ON CONFLICT DO NOTHING RETURNING id
  //   2. SELECT account_id FROM businesses          (startReviewRun)
  //   3. SELECT account_id, EXISTS(…)               (maybeEnqueueFirstReviewIngested)
  function mockInsertWon(earlierExists = true) {
    tx
      .mockResolvedValueOnce(withCount([{ id: 'new-id' }], 1))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1' }], 1))
      .mockResolvedValueOnce(withCount([{ account_id: 'acct-1', earlier_exists: earlierExists }], 1));
  }

  function joinedSql(): string {
    return tx.mock.calls
      .map((c) => (c[0] as TemplateStringsArray | undefined)?.join('?') ?? '')
      .join('\n');
  }

  it('importReview inserts the review and writes no job_outbox row', async () => {
    const monitored = makeMonitoredReview();
    mockInsertWon();

    const result = await importReview(sql, monitored, 'biz-1', 'corr-1');

    expect(result).toBe('new');
    expect(tx).toHaveBeenCalledTimes(3);

    const allSql = joinedSql();
    expect(allSql).toContain('INSERT INTO reviews');
    // Invariants #2 and #3: the import has no follow-up work, so nothing is
    // enqueued and nothing from this path can reach Google.
    // enqueueGenerateResponse is deliberately NOT mocked in this suite, so a
    // stray enqueue would appear here as a real job_outbox INSERT.
    expect(allSql).not.toContain('job_outbox');
  });

  it('importReview classifies sentiment at the write site', async () => {
    const monitored = makeMonitoredReview({ starRating: 1 });
    mockInsertWon();

    await importReview(sql, monitored, 'biz-1', 'corr-1');

    const insertCall = tx.mock.calls[0] as unknown[];
    const insertSql = (insertCall[0] as TemplateStringsArray | undefined)?.join('?') ?? '';
    expect(insertSql).toContain('sentiment_score');
    expect(insertSql).toContain('sentiment_label');
    expect(insertSql).toContain('sentiment_source');

    // classifySentiment(1) → { score: -1, label: 'negative',
    //                          source: 'deterministic_star_v1' }
    const params = insertCall.slice(1);
    expect(params).toContain(-1);
    expect(params).toContain('negative');
    expect(params).toContain('deterministic_star_v1');
  });

  it('importReview binds the review INSERT parameters in the canonical order', async () => {
    // Guards the Task 2 extraction. Moving 17 bindings out of processReview
    // into a shared helper could transpose two same-typed neighbours (e.g.
    // provider_review_id ↔ provider_review_name, or the two sentiment strings)
    // and still produce an identical tx call count and order — every other test
    // in this file would pass while stored identity/dedup data is corrupted.
    const monitored = makeMonitoredReview({ starRating: 5 });
    mockInsertWon();

    await importReview(sql, monitored, 'biz-1', 'corr-1');

    const [, ...params] = tx.mock.calls[0] as unknown[];
    // params[0] is the uuidv7 PK minted inside importReview.
    expect(typeof params[0]).toBe('string');
    expect(params.slice(1)).toEqual([
      'biz-1',                    // business_id
      'zernio',                   // provider
      'r1',                       // provider_review_id
      'zernio://loc1/reviews/r1', // provider_review_name
      'zernio://loc1',            // provider_location_name
      null,                       // google_review_name
      'Alice',                    // reviewer_name
      5,                          // star_rating
      'Great!',                   // review_text
      '2026-04-28',               // review_date
      'en',                       // detected_language
      'hash-abc',                 // review_content_hash
      REVIEW_STATUS.NEW,          // status
      1,                          // sentiment_score  — (5 - 3) / 2
      'positive',                 // sentiment_label
      'deterministic_star_v1',    // sentiment_source
    ]);
  });

  it('importReview records the review_ingested run-spine step and completes the run', async () => {
    const monitored = makeMonitoredReview();
    mockInsertWon();

    await importReview(sql, monitored, 'biz-1', 'corr-1');

    expect(startOrGetActiveRun).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        kind: 'review_handler',
        subjectType: 'review',
        accountId: 'acct-1',
        businessId: 'biz-1',
        correlationId: 'corr-1',
      }),
    );
    expect(recordStep).toHaveBeenCalledWith(tx, {
      runId: 'run-1',
      stepKey: 'review_ingested',
    });
    // An imported review has no draft and no publish, so nothing downstream
    // would ever complete this run — it would read as 'stalled' after 48h
    // (deriveRunDisplayState, src/lib/agents/read.ts:127). The import's work
    // genuinely is finished when the row lands, so it completes its own run.
    expect(completeRun).toHaveBeenCalledWith(tx, 'run-1', 'completed');
  });

  it('importReview does all of its work in exactly one transaction', async () => {
    const monitored = makeMonitoredReview();
    // earlierExists=false so maybeEnqueueFirstReviewIngested actually reaches
    // its enqueue — with the default (true) it returns early and the
    // enqueueAnalyticsEvent assertion below could never hold.
    mockInsertWon(false);

    await importReview(sql, monitored, 'biz-1', 'corr-1');

    // Invariant #2: one transaction, no post-commit follow-up. Without this,
    // an implementation could open a second sql.begin for the spine writes and
    // every other test in this block would still pass.
    const begin = (sql as unknown as { begin: ReturnType<typeof vi.fn> }).begin;
    expect(begin).toHaveBeenCalledTimes(1);

    // Every spine writer received the SAME tx handle, not the pool client.
    expect(startOrGetActiveRun).toHaveBeenCalledWith(tx, expect.anything());
    expect(recordStep).toHaveBeenCalledWith(tx, expect.anything());
    expect(completeRun).toHaveBeenCalledWith(tx, expect.anything(), expect.anything());
    expect(enqueueAnalyticsEvent).toHaveBeenCalledWith(tx, expect.anything());
  });

  it("importReview enqueues first_review_ingested for the account's first review", async () => {
    const monitored = makeMonitoredReview();
    mockInsertWon(false);

    await importReview(sql, monitored, 'biz-1', 'corr-1');

    expect(enqueueAnalyticsEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        eventName: 'first_review_ingested',
        accountId: 'acct-1',
        businessId: 'biz-1',
      }),
    );
  });

  it('importReview returns unchanged and performs no writes when the review already exists', async () => {
    const monitored = makeMonitoredReview();
    // INSERT … ON CONFLICT DO NOTHING matched the existing row → zero rows.
    tx.mockResolvedValueOnce(withCount([], 0));

    const result = await importReview(sql, monitored, 'biz-1', 'corr-1');

    expect(result).toBe('unchanged');
    // Exactly one statement — the INSERT that did nothing. An import never
    // mutates a row the live-ingest lane already owns.
    expect(tx).toHaveBeenCalledTimes(1);
    expect(startOrGetActiveRun).not.toHaveBeenCalled();
    expect(recordStep).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
    expect(enqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('importReview returns unchanged when a concurrent writer wins the insert race', async () => {
    const monitored = makeMonitoredReview();
    // Race loss is mechanically identical to "row already existed" — the
    // INSERT returns zero rows either way. This test pins the DESIGN CLAIM
    // that the race is not special-cased: importReview must NOT re-read the
    // winner row and fall through to processReview's existing-row state
    // machine, which would update content, supersede responses and open
    // review_exceptions on behalf of an import.
    tx.mockResolvedValueOnce(withCount([], 0));

    const result = await importReview(sql, monitored, 'biz-1', 'corr-1');

    expect(result).toBe('unchanged');
    expect(tx).toHaveBeenCalledTimes(1);

    const allSql = joinedSql();
    expect(allSql).not.toContain('FOR UPDATE');
    expect(allSql).not.toContain('UPDATE reviews');
    expect(allSql).not.toContain('UPDATE responses');
    expect(allSql).not.toContain('review_exceptions');
    expect(recordStep).not.toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ stepKey: 'review_updated' }),
    );
  });
});
```

- [ ] **Step 4: Run the new block and verify it fails**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts 2>&1 | tail -30
```
Expected: the eight `importReview` tests FAIL. Because `importReview` is not exported yet, the failure surfaces as `TypeError: importReview is not a function` (or an esbuild "No matching export" error). Either is a valid red. **The existing `processReview` tests must still PASS** — if any changed status, stop: the mock-factory edit was not behaviour-neutral.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
git add src/lib/reviews/__tests__/process-review.test.ts docs/ .feature/intake.json && \
git commit -m "test(#674): failing eval for importReview insert-only path"
```

(`.feature/intake.json` is gitignored by design; `git add` on it is a no-op and is listed only so the command is copy-pasteable. The `docs/` entry commits the plan, the deviations file, the intake audit copy, and the design of record.)

---

### Task 2: Implement `importReview` and the shared insert helper

**Blocked by:** Task 1.

**Files:**
- Modify: `src/lib/reviews/process-review.ts`

- [ ] **Step 1: Extend the run-spine import**

Line 17 currently reads `import { startOrGetActiveRun, recordStep } from '@/lib/agents/run-spine';`. Replace with:

```typescript
import { startOrGetActiveRun, recordStep, completeRun } from '@/lib/agents/run-spine';
```

- [ ] **Step 2: Extract the shared insert into a private helper**

Add this function immediately after the `processReview` function closes (i.e. before the `// ── Agent run spine (WS1) ──` banner at line 153). The SQL is moved verbatim from lines 66-82 — do not reword it, reorder columns, reorder bindings, or change the `ON CONFLICT` clause:

```typescript
// ── Shared new-review INSERT (internal seam) ─────────────────────────
// Used by both entry points. Returns the number of rows inserted: 0 means
// the review already existed (or a concurrent writer won the race), since
// ON CONFLICT (provider, provider_review_name) DO NOTHING is the dedup.
// Sentiment is classified here so every insert site classifies identically.
// Private by design — not part of the module's interface.

async function insertNewReviewRow(
  tx: TxClient,
  reviewId: string,
  businessId: string,
  monitored: MonitoredReview,
): Promise<number> {
  const { review, identity, contentHash } = monitored;
  const sentiment = classifySentiment(review.starRating);

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id,
      provider_review_name, provider_location_name, google_review_name,
      reviewer_name, star_rating, review_text, review_date,
      detected_language, review_content_hash, status, detected_at,
      sentiment_score, sentiment_label, sentiment_classified_at, sentiment_source
    ) VALUES (
      ${reviewId}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
      ${identity.providerReviewName}, ${identity.providerLocationName}, ${identity.googleReviewName},
      ${review.reviewerName}, ${review.starRating}, ${review.reviewText}, ${review.reviewDate},
      ${review.detectedLanguage}, ${contentHash}, ${REVIEW_STATUS.NEW}, NOW(),
      ${sentiment.score}, ${sentiment.label}, NOW(), ${sentiment.source}
    )
    ON CONFLICT (provider, provider_review_name) DO NOTHING
    RETURNING id
  `;

  return inserted.count;
}
```

- [ ] **Step 3: Point `processReview` at the helper**

Replace lines 63-84 of `src/lib/reviews/process-review.ts` — everything from `const reviewId = uuidv7();` through `if (inserted.count > 0) {` — with:

```typescript
      const reviewId = uuidv7();
      const insertedCount = await insertNewReviewRow(tx, reviewId, businessId, monitored);

      if (insertedCount > 0) {
```

This deletes the now-duplicated `const sentiment = classifySentiment(...)` line and the inline `INSERT`. Everything after it (the `startReviewRun` call, `enqueueGenerateResponse`, `maybeEnqueueFirstReviewIngested`, `return 'new'`, the race-loss re-read) is **unchanged**. The number and order of `tx` calls is identical to before, which is why the existing positional-mock tests stay green.

- [ ] **Step 4: Have `startReviewRun` return its run id**

`importReview` needs the `runId` to complete the run. Change the signature and the two returns (`src/lib/reviews/process-review.ts:160-186`) — the body is otherwise untouched:

```typescript
async function startReviewRun(
  tx: TxClient,
  input: {
    reviewId: string;
    businessId: string;
    correlationId?: string;
    stepKey: 'review_ingested' | 'review_updated';
  },
): Promise<string | null> {
```

and inside it, `if (!biz) return;` becomes `if (!biz) return null;`, and after the `recordStep` call add `return runId;`.

`processReview`'s two call sites ignore the returned value and are **not** edited — adding a return value to a function whose callers discard it is behaviour-neutral.

- [ ] **Step 5: Run the existing tests to prove Steps 2-4 are behaviour-neutral**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts -t 'processReview' 2>&1 | tail -20
```
Expected: every `processReview` test PASSES. If any fails, the extraction changed the tx call sequence — revert and redo Steps 2-4 without moving statements.

- [ ] **Step 6: Add the `importReview` entry point**

Append at the end of `src/lib/reviews/process-review.ts`:

```typescript
// ── Review import (#674, spec §6.2) ──────────────────────────────────

/**
 * Store a review as inventory — insert and stop.
 *
 * The consented **Review import** stores reviews without writing replies for
 * them (spec D2). Sentiment is classified at the write site and the run spine
 * records `review_ingested`, but **no `generate_response` is enqueued** — so
 * this path writes no `job_outbox` row at all, and nothing it stores can reach
 * Google (invariant #3).
 *
 * Insert-only by construction. An existing review row is left completely
 * untouched — no content update, no supersede, no `review_exceptions`, no
 * admin notify — so a bulk import can never mutate a row the live-ingest lane
 * already owns. A genuinely edited review is picked up by the live lane's next
 * poll instead.
 *
 * There is deliberately no `SELECT … FOR UPDATE` probe: because an existing row
 * means zero writes, the INSERT's `ON CONFLICT` is the whole decision, and
 * taking no review lock keeps a 100-review import from contending with
 * concurrent live-ingest work. `'unchanged'` therefore covers both "the row
 * already existed" and "a concurrent writer won the race" — the two collapse to
 * the same skip, and neither falls through to `processExistingReview`.
 *
 * The run is **completed in this same transaction**. An imported review has no
 * draft and no publish, so no downstream worker would ever complete its run and
 * it would surface as `stalled` after 48h (`deriveRunDisplayState`,
 * `src/lib/agents/read.ts`). The import's work genuinely is finished when the
 * row lands; #678's on-demand Generate opens a fresh run per owner action.
 *
 * KNOWN HAZARD (deviations D4, owned by #675) — **a review stored here is never
 * drafted by the live lane, and this needs no race.** The live lane enqueues
 * `generate_response` only when it INSERTS a review or when the content hash
 * CHANGES; a later `processReview` for a row this function already stored takes
 * the existing-row path, matches the hash, and returns `'unchanged'` without
 * enqueueing (`processExistingReview`, the `existingHash === contentHash`
 * branch). The zernio backfill lane routes through the same `processReview`, so
 * it is not a rescue either. The concurrent INSERT race is merely the
 * simultaneous instance of this; the sequential case (import runs first, live
 * lane polls later) is the common one. Fixing it means giving the live lane a
 * durable "generation still owed" claim — a behaviour change to
 * `processReview` that #674 forbids, in code with no caller until #675 wires
 * one. #675 owns *when* the import runs and therefore owns this.
 *
 * Callers screen reviews (PHI, normalization) before calling; precedent is the
 * `processUnansweredReview` closure inside `handleZernioBackfill`.
 */
export async function importReview(
  sql: Sql,
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
): Promise<'new' | 'unchanged'> {
  return await sql.begin(async (tx) => {
    const reviewId = uuidv7();
    const insertedCount = await insertNewReviewRow(tx, reviewId, businessId, monitored);

    if (insertedCount === 0) {
      return 'unchanged' as const;
    }

    const runId = await startReviewRun(tx, {
      reviewId,
      businessId,
      correlationId,
      stepKey: 'review_ingested',
    });

    if (runId) {
      await completeRun(tx, runId, 'completed');
    }

    await maybeEnqueueFirstReviewIngested(tx, { businessId, reviewId });

    return 'new' as const;
  });
}
```

- [ ] **Step 7: Run the whole file green**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts 2>&1 | tail -20
```
Expected: PASS, all tests in both describe blocks.

- [ ] **Step 8: Lint and typecheck**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && pnpm lint && pnpm typecheck 2>&1 | tail -20
```
Expected: no errors. Note `importReview` is intentionally exported with no caller in this branch — its caller is #675. If lint flags it as unused, that is a false positive on an exported symbol; report it rather than deleting the export.

- [ ] **Step 9: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
git add src/lib/reviews/process-review.ts && \
git commit -m "feat(#674): importReview — store a review without enqueueing generation"
```

---

### Task 3: Glossary entry for **Review import**

**Blocking edges:** none. Disjoint file set from Task 2 — may run concurrently.

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 1: Add the term**

`CONTEXT.md` opens with an H1 and then a run of `- **Term**: definition` bullets before its first `##` section heading. Insert the new bullet as the **last entry of that opening bullet list, immediately before the first `##` heading in the file**. Match the house style of the later entries — definition, then `_Avoid_:`, then the provenance parenthetical:

```markdown
- **Review import**: the consented, one-time storage of an owner's newest 100 Google reviews as inventory — it stores reviews and writes **no** replies (design D2). Entry point `importReview` (`src/lib/reviews/process-review.ts`), distinct from `processReview`'s live-ingest lane which drafts a reply for every new review. Insert-only: an existing review row is never mutated by an import, so a bulk import cannot supersede a response, open a `review_exceptions` row, or notify admin on behalf of the live lane; both "row already existed" and "lost the insert race" return `'unchanged'` with zero writes. It enqueues no `job_outbox` row at all, so nothing it stores can reach Google (invariant #3), and it completes its own run spine in the insert transaction because no downstream worker ever would. The mechanism keeps its existing names (`zernio_initial_backfill` topic, `zernio_backfill_runs` table, `origin_lane='backfill'`) — only the semantics changed. _Avoid_: backfill (the user-facing noun is **import**), historical sync, review sync. *(coined in #674; map #667, spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.2)*
```

- [ ] **Step 2: Verify placement and no duplicate term**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && rg -n -i "review import" CONTEXT.md && rg -n "^## " CONTEXT.md | head -1
```
Expected: exactly one hit for the term, on a line number **lower** than the first `## ` heading.

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
git add CONTEXT.md && \
git commit -m "docs(#674): CONTEXT.md glossary entry for Review import"
```

---

### Task 4: Live-Postgres proof that `importReview` executes

**Blocked by:** Task 2.

**Why this exists:** `importReview` ships callerless. Nothing else in the repo runs its SQL, so the mocked suite could be entirely green while the statement fails against the real schema. This task is the only evidence that it runs at all.

**Files:**
- Create: `src/lib/reviews/__tests__/import-review.integration.test.ts`

**Live-DB suite conventions (CLAUDE.md gotcha + lab-notes "#573") — do not violate:**
- Name MUST end `.integration.test.ts` (puts it in vitest's serialized `integration` project).
- The suite MUST NOT apply migration SQL. Provision once with `pnpm test:db:setup`; `describeWithDb` handles the schema assertion and skips cleanly when no database is configured.
- Precedent to copy: `src/lib/agents/__tests__/read.integration.test.ts`.

- [ ] **Step 1: Provision the test database**

Run:
```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && pnpm test:db:setup 2>&1 | tail -5
```
Expected: completes without error, schema at migrations head.

- [ ] **Step 2: Write the suite**

Create `src/lib/reviews/__tests__/import-review.integration.test.ts`:

```typescript
// src/lib/reviews/__tests__/import-review.integration.test.ts
//
// Live-Postgres proof for importReview (#674). The mocked suite in
// process-review.test.ts asserts the BINDINGS; this asserts the statement
// actually RUNS — every column exists, no constraint is violated, the
// ON CONFLICT dedup really dedupes, the agent run lands terminal, and no
// job_outbox row is written. importReview ships with no callers, so without
// this nothing in the repo ever executes its SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { importReview } from '../process-review';
import type { MonitoredReview } from '../types';
import { REVIEW_STATUS } from '@/lib/reviews/status';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const providerReviewId = `import-${randomUUID()}`;
const providerReviewName = `zernio://import-test/reviews/${providerReviewId}`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-review integration database was not initialized');
  return db;
}

function makeMonitored(): MonitoredReview {
  return {
    review: {
      reviewerName: 'Import Fixture Reviewer',
      starRating: 2,
      reviewText: 'Imported inventory review.',
      reviewDate: '2026-07-01T12:00:00.000Z',
      detectedLanguage: 'en',
    },
    identity: {
      provider: 'zernio',
      providerReviewId,
      providerReviewName,
      providerLocationName: 'zernio://import-test/locations/1',
      googleReviewName: null,
      identityStrategy: 'zernio_id',
    },
    contentHash: 'import-fixture-hash',
  };
}

describeWithDb('importReview against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Import Review Owner',
      accountDisplayName: 'Import Review Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${businessId}::uuid, 'Import Review Location', 'Import Review Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM agent_run_steps WHERE agent_run_id IN (
        SELECT id FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid
      )`;
      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('importReview stores the review against the live schema and returns new', async () => {
    const result = await importReview(sql(), makeMonitored(), businessId, 'corr-import-1');

    expect(result).toBe('new');

    const [row] = await sql()<{
      business_id: string;
      provider: string;
      provider_review_id: string;
      provider_review_name: string;
      reviewer_name: string;
      star_rating: number;
      status: string;
      sentiment_score: string | number;
      sentiment_label: string;
      sentiment_source: string;
      review_content_hash: string;
    }[]>`
      SELECT business_id, provider, provider_review_id, provider_review_name,
             reviewer_name, star_rating, status,
             sentiment_score, sentiment_label, sentiment_source,
             review_content_hash
      FROM reviews
      WHERE provider_review_name = ${providerReviewName}
    `;

    expect(row).toBeDefined();
    // Every binding landed in the column it was meant for — the assertion the
    // mocked suite structurally cannot make.
    expect(row!.business_id).toBe(businessId);
    expect(row!.provider).toBe('zernio');
    expect(row!.provider_review_id).toBe(providerReviewId);
    expect(row!.reviewer_name).toBe('Import Fixture Reviewer');
    expect(row!.star_rating).toBe(2);
    expect(row!.status).toBe(REVIEW_STATUS.NEW);
    expect(row!.review_content_hash).toBe('import-fixture-hash');
    // Sentiment is classified at the write site: classifySentiment(2) →
    // { score: (2-3)/2 = -0.5, label: 'negative' }. Assert the SCORE too — the
    // label alone would still pass if the score binding landed in the wrong
    // column, which is the whole point of this suite. NUMERIC comes back as a
    // string from postgres.js, so compare numerically.
    expect(Number(row!.sentiment_score)).toBe(-0.5);
    expect(row!.sentiment_label).toBe('negative');
    expect(row!.sentiment_source).toBe('deterministic_star_v1');
  });

  it('importReview leaves the agent run terminal, not running', async () => {
    const [run] = await sql()<{ id: string; status: string; ended_at: Date | null }[]>`
      SELECT id, status, ended_at
      FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid
        AND kind = 'review_handler'
    `;

    expect(run).toBeDefined();
    // An imported review has no draft and no publish, so nothing downstream
    // would ever complete this run — it would read as 'stalled' after 48h.
    expect(run!.status).toBe('completed');
    expect(run!.ended_at).not.toBeNull();

    // The FK column is `agent_run_id`, NOT `run_id` (migration 071; writer at
    // src/lib/agents/run-spine.ts:304). `run_id` is the name used for the local
    // variable in the run-spine writers, which is what makes this an easy
    // mistake — and exactly the kind of error only a live-DB suite catches.
    const steps = await sql()<{ step_key: string }[]>`
      SELECT step_key FROM agent_run_steps WHERE agent_run_id = ${run!.id}::uuid
    `;
    expect(steps.map((s) => s.step_key)).toContain('review_ingested');
  });

  it('importReview writes no job_outbox row against the live database', async () => {
    const [reviewRow] = await sql()<{ id: string }[]>`
      SELECT id FROM reviews WHERE provider_review_name = ${providerReviewName}
    `;

    const outbox = await sql()<{ id: string }[]>`
      SELECT id FROM job_outbox WHERE aggregate_id::text = ${reviewRow!.id}
    `;
    // Cast the COLUMN, not the parameter — job_outbox.aggregate_id's declared
    // type must not silently decide whether this comparison type-checks.

    // Invariants #2 and #3: no follow-up work, so nothing this path stores
    // can ever reach Google.
    expect(outbox).toHaveLength(0);
  });

  it('importReview is idempotent on a second call for the same review', async () => {
    const result = await importReview(sql(), makeMonitored(), businessId, 'corr-import-2');

    // ON CONFLICT (provider, provider_review_name) DO NOTHING really dedupes.
    expect(result).toBe('unchanged');

    const rows = await sql()<{ id: string }[]>`
      SELECT id FROM reviews WHERE provider_review_name = ${providerReviewName}
    `;
    expect(rows).toHaveLength(1);

    // The skip wrote nothing: still exactly one run, not two.
    const runs = await sql()<{ id: string }[]>`
      SELECT id FROM agent_runs
      WHERE account_id = ${tenant!.accountId}::uuid AND kind = 'review_handler'
    `;
    expect(runs).toHaveLength(1);
  });
});
```

Note the four `it` blocks run in file order and share state deliberately: the first imports, the rest observe what it produced and then re-import to prove the dedup. Do not add `beforeEach` isolation — the shared fixture *is* the scenario.

- [ ] **Step 3: Run it**

The suite reads `process.env.TEST_DATABASE_POOL_URL` directly (following its
precedent `read.integration.test.ts`), and **nothing in `vitest.setup.ts`
hydrates `.env.local`** — so a bare `pnpm vitest run <path>` skips. Export it:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
export TEST_DATABASE_POOL_URL=$(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | tail -1 | cut -d= -f2-) && \
pnpm vitest run src/lib/reviews/__tests__/import-review.integration.test.ts 2>&1 | tail -25
```
Expected: 4 passed. A `SKIP` here is a FAILURE of this task — it means `TEST_DATABASE_POOL_URL` is unset and the suite proved nothing.

(`scripts/verify-gate.sh` does this hydration itself before running
`verification_commands`, so the gate never inherits this skip — see deviations
D15.)

- [ ] **Step 4: Stage the file, THEN run the live-DB convention audit**

`scripts/ci/live-db-suites-audit.ts` enumerates files via `git ls-files`, so it
is **blind to an untracked file** — running it before staging would pass
vacuously and prove nothing. Stage first:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
git add src/lib/reviews/__tests__/import-review.integration.test.ts && \
pnpm ci:live-db-suites 2>&1 | tail -10
```
Expected: `live-db-suites-audit: passed`.

**Do not expect the suite to be named in that output** — the audit prints
filenames only in its failure branch, so a pass is always a single summary line
and the filename can never appear (deviations D15). Confirm non-vacuousness the
way the tool actually permits:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
git ls-files '*.test.ts' | grep import-review
```
Expected: the new suite is listed. That is what proves the audit's `git ls-files`
enumeration can see it; an empty result means the file is still untracked and the
check was a no-op.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-674-import-review-no-generation && \
git commit -m "test(#674): live-Postgres proof that importReview executes"
```

---

## Out of scope for this plan (do not do these)

- Do **not** fix the cross-lane lost-draft hazard (see Hazards above). It is #675's.
- Do **not** modify `worker/jobs/zernio/zernio-ingest-shared.ts`. Its private `insertImportedReview` (line 364) is a near-duplicate of the new path but has different semantics (`ON CONFLICT … DO UPDATE` to return the id, sets `external_reply_ingested_at`, writes no run-spine row) and a live caller. Converging them belongs to #675.
- Do **not** wire `importReview` into any worker, poller, or route.
- Do **not** add an `originLane` or `suppressNotification` option to `importReview` — neither is meaningful when nothing is enqueued.
- Do **not** call `recordOutcome` — a new `AGENT_OUTCOME_KINDS` member would need a migration.
- Do **not** add a feature flag, env var, or migration.
- Do **not** refactor the existing `describe('processReview')` test block.

## Review appendix

- **Round 1** (codex `019fd129-092f-7e93-8409-854489caac01`) — `VERDICT: REVISE`. Accepted: missing spec on disk (D1), stalled runs (D3), positional-swap blind spot (new param-order test), no one-transaction assertion (new test), FK-impossible Test 7 (removed), cited-symbol correction (D6). Rejected with reasoning: CONTEXT.md format objection, `job_outbox` assertion objection (D5). Deferred by owner decision: cross-lane lost draft (D4 → #675).
- **Round 2** — _(pending)_
