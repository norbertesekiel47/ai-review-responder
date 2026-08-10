# #731 Deferred Maintainability Bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land #731's four surviving maintainability items in one run: a type-checked orphan/live split in `toCardRow`, a single-snapshot denominator query for the **Reviews list**, deletion of the redundant single-key per-review-daily-cap peek, and removal of the retired `PAST_REPLIES_VIEW_ENABLED` from the publisher edit-existing-reply suite.

**Architecture:** No new modules and no new interfaces. `replies-view.ts` gains a **private** internal seam (two reply-facts mappers behind an unchanged `toCardRow` signature); `load-replies.ts` narrows four concurrent queries to three; `costs/tracker.ts`'s interface **shrinks** by one export; `dashboard-regen-rate-limit.ts` loses a `try/catch`. The tenant-scope allowlist shrinks 409 → 408.

**Tech Stack:** TypeScript, Postgres.js (tagged templates), Vitest (+ `fast-check`), live-Postgres integration suites gated by `TEST_DATABASE_POOL_URL`.

**Glossary terms used verbatim (CONTEXT.md:30-31):** **Reviews list**, **Posted-reply axis** (`reply_state`: `none`/`posted`/`orphan`), **Replacement-draft axis** (`draft_state`, server-internal), **Action slot** (`row_action`), **On-demand generation**, and *a per-review daily cap* — note CONTEXT.md:31 lists **"the regenerate budget"** under _Avoid_ (it names one layer, not the policy). Do not write "the regenerate budget" anywhere.

**Item 4 of the original five is MOOT** — #727 deleted both `ReviewRowState` and `row_state`. Do not look for them.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/past-replies/replies-view.ts` | Row derivation. Gains private `ReplyFacts` type + `orphanReplyFacts`/`liveReplyFacts`. `toCardRow`'s exported signature is UNCHANGED. | 2 |
| `src/lib/past-replies/load-replies.ts` | Page-load composition root. Three denominator queries collapse into one. | 3 |
| `scripts/ci/tenant-scope-allowlist.ts` | Audit data table. Two `load-replies.ts` entries out, one in; `ALLOWLIST_BASELINE` 409 → 408. | 3 |
| `src/lib/costs/tracker.ts` | Cost/budget module. `peekRegenBudget` DELETED; `peekRegenBudgetBatch` survives as the sole peek. | 4 |
| `src/lib/shared/dashboard-regen-rate-limit.ts` | Route-level enforcement. Calls the batched peek; `try/catch` deleted. | 4 |
| `worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts` | Test-only. Retired-flag references removed. | 5 |
| `docs/adr/0018-row-state-axes-projection.md` | Addendum recording the re-split and its type-level guarantee. | 6 |

**Test files touched:** `src/lib/past-replies/__tests__/replies-view.test.ts`, `.../reviews-list.test.ts`, `.../load-replies.integration.test.ts`, `src/lib/costs/__tests__/tracker.test.ts`, `.../regen-budget-batch.test.ts`, `src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts`.

**Task independence:** Task 1 runs **alone** (it authors every eval title and is the enforcement spot check). Tasks 2, 3, 4, 5 have **disjoint file sets and no blocking edges between them** — dispatch them concurrently. Task 6 blocks on 2, 3, 4.

---

## Three landmines the recon found. Read before starting.

1. **`replies-view.test.ts:351` pins the card's exact key set.** `expect(Object.keys(card).sort()).toEqual([...18 keys...])`. Task 2 must add and remove **zero** keys. The spread in Step 3 produces exactly those 18 — verify by counting, don't assume.
2. **`reviews-list.test.ts:346` asserts `expect(dataQueries).toHaveLength(4)`.** Task 3's merge makes it **2** (main row source + merged denominators). That existing test must be updated, not deleted.
3. **`fakeSql` dispatches on `/AVG\(/i` BEFORE `/COUNT\(\*\)/i`** (`reviews-list.test.ts:97-104`). The merged query contains both, so without a new branch placed **first** it resolves to `[{ avg }]` and every denominator reads 0 — a green-looking harness lying about a broken query. Task 1 Step 4 adds that branch.

---

## Task 1: EVAL — author all 14 promised titles as failing tests

**Runs ALONE.** After it completes, the orchestrator diffs `git status --porcelain` against `allowed_edit_surface` as the enforcement spot check before any fan-out.

**Files:**
- Modify: `src/lib/past-replies/__tests__/replies-view.test.ts` (append 6 titles inside `describe('toCardRow', …)`, which starts at `:137`)
- Modify: `src/lib/past-replies/__tests__/reviews-list.test.ts` (1 title + the additive `fakeSql` branch)
- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts` (3 titles + an empty-location fixture)
- Modify: `src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts` (3 titles replacing 3 existing ones)
- Modify: `src/lib/costs/__tests__/regen-budget-batch.test.ts` (1 title)

These 14 titles are the locked `tests_to_add` from `.feature/intake.json`. **The gate greps them VERBATIM** — copy them character for character, including capitalisation and the `_` in `regen_limit_reached`.

- [ ] **Step 1: Append the six `toCardRow` titles**

In `src/lib/past-replies/__tests__/replies-view.test.ts`, inside the existing `describe('toCardRow', () => {` block (starts `:137`), append. The file uses **named imports** (`toCardRow`, `type ReviewRow`) and the fixture builders `reviewRow()`, `answeredRow()`, `orphanRow()` already exist at `:20-93` — use them, do not write new ones.

```ts
  // ── #731 item 1: the orphan/live reply-facts split ──────────────────────────
  //
  // These six titles are the contract the split must preserve. They go through
  // `toCardRow` — the module's interface — and never reach the two private
  // mappers directly: testing past the interface would pin the refactor's
  // shape instead of its behaviour.

  it('toCardRow maps an orphan row from the orphan_* LATERALs and never from resp.*', () => {
    // resp.* is populated with sentinels an orphan must NOT surface. In
    // production `is_orphan` already encodes `resp.id IS NULL` (load-replies
    // F3), so this row is impossible; it is constructed precisely so a mapper
    // that reads the wrong side fails loudly rather than coincidentally.
    const card = toCardRow(
      orphanRow({
        response_id: 'LIVE-resp-must-not-leak',
        approved_text: 'LIVE-text-must-not-leak',
        approval_method: APPROVAL_METHOD.OWNER,
        posted_at: new Date('2026-04-03T10:00:00.000Z'),
        version: 9,
        failed_response_id: 'SIDECAR-must-not-leak',
        failed_posting_error: 'delete_failed_must_not_leak',
      }),
      ACTIVATED,
      true,
    );

    expect(card.reply_state).toBe('orphan');
    // Every field comes from the orphan_* side.
    expect(card.response_id).toBe('fail-1');
    expect(card.approved_text).toBe('old reply');
    expect(card.failed_response_id).toBe('fail-1');
    expect(card.failed_posting_error).toBe('post_after_delete_failed_x');
    // ...and nothing from resp.* or fail_sidecar leaks through.
    expect(JSON.stringify(card)).not.toContain('must-not-leak');
  });

  it('toCardRow keeps failed_response_id populated on an orphan row so recovery stays reachable', () => {
    // #678 round-2 Defect A: the deleted `toOrphanCardRow` dropped this field,
    // and because AnsweredControls + RecoveryControl gate the recovery ACTIONS
    // on it (not on the badge), recovery went silently unreachable. This is the
    // regression pin for re-splitting the function.
    const card = toCardRow(orphanRow(), ACTIVATED, true);

    expect(card.failed_response_id).toBe('fail-1');
    expect(card.failed_response_id).not.toBeNull();
    expect(card.row_action).toBe('recover');
  });

  it('toCardRow maps a posted row from resp.* and still carries its own delete_failed_* sidecar', () => {
    const card = toCardRow(
      answeredRow({
        failed_response_id: 'sidecar-1',
        failed_posting_error: 'delete_failed_transient',
      }),
      ACTIVATED,
      true,
    );

    expect(card.reply_state).toBe('posted');
    expect(card.response_id).toBe('resp-1');
    expect(card.approved_text).toBe('Thank you!');
    expect(card.posted_at).toBe('2026-04-01T13:00:00.000Z');
    expect(card.version).toBe(2);
    // The sidecar badge on a still-live Google reply — NOT an orphan marker.
    expect(card.failed_response_id).toBe('sidecar-1');
    expect(card.failed_posting_error).toBe('delete_failed_transient');
  });

  it('toCardRow nulls posted_at, approval_method and version on an orphan row', () => {
    const card = toCardRow(
      orphanRow({
        posted_at: new Date('2026-04-03T10:00:00.000Z'),
        approval_method: APPROVAL_METHOD.AUTO_POLICY,
        version: 4,
      }),
      ACTIVATED,
      true,
    );

    // An orphan has no live posted reply, so there is no posting time, no
    // approval provenance and no optimistic-concurrency version to offer.
    expect(card.posted_at).toBeNull();
    expect(card.approval_method).toBeNull();
    expect(card.version).toBeNull();
  });

  it('toCardRow derives provenance_badge from the dispatched approval_method, not the raw row', () => {
    const card = toCardRow(
      orphanRow({ approval_method: APPROVAL_METHOD.AUTO_POLICY }),
      ACTIVATED,
      true,
    );

    // Reading r.approval_method here would badge an orphan `auto_approved` for
    // a reply that is not on Google at all.
    expect(card.approval_method).toBeNull();
    expect(card.provenance_badge).toBeNull();
  });

  it('toCardRow maps a never-replied row with no reply facts and no recovery affordance', () => {
    const card = toCardRow(reviewRow(), ACTIVATED, true);

    expect(card.reply_state).toBe('none');
    expect(card.row_action).toBe('generate');
    // response_id null IS the unanswered predicate (the LEFT JOIN found nothing).
    expect(card.response_id).toBeNull();
    expect(card.approved_text).toBeNull();
    expect(card.approval_method).toBeNull();
    expect(card.posted_at).toBeNull();
    expect(card.version).toBeNull();
    expect(card.failed_response_id).toBeNull();
    expect(card.failed_posting_error).toBeNull();
  });
```

- [ ] **Step 2: Run them — expect 4 PASS, 2 FAIL**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle
pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts -t 'toCardRow'
```

Expected: the two leak-sentinel titles (`maps an orphan row from the orphan_* LATERALs`, `nulls posted_at, approval_method and version`) **FAIL** — today's `toCardRow` reads `r.failed_response_id`/`r.failed_posting_error` only via `isOrphan ? r.orphan_… : r.failed_…`, so the orphan branch is already right for those two, but the sentinel row has `version: 9` and `posted_at` set, which today's `isOrphan || typeof …` guard nulls correctly.

**If all six PASS, that is the expected outcome and is NOT a failure of this task.** Item 1 is a behaviour-*preserving* refactor: its tests are a regression harness, not a red-green driver. Record in the task summary which titles were green-on-arrival. The titles that MUST be red today are in Steps 3-6.

- [ ] **Step 3: Add the additive merged-denominator branch to `fakeSql` (LANDMINE 3)**

In `src/lib/past-replies/__tests__/reviews-list.test.ts`, in `fakeSql` (`:97`), insert the new branch **immediately after the `AS review_id` branch and BEFORE the `AVG(` branch**. Ordering is load-bearing: the merged query matches `/AVG\(/i` too.

```ts
    if (/AS\s+review_id/i.test(text)) return Promise.resolve(rows.main ?? []);
    // #731 item 2: the MERGED denominator query — two COUNT(*) FILTERs plus the
    // AVG over one snapshot. Matched FIRST because its text also matches the
    // `AVG(` and `COUNT(*)` branches below; dispatching it there would resolve
    // it to `[{ avg }]` and silently zero both denominators.
    if (/unanswered_total/i.test(text)) {
      return Promise.resolve([{
        unanswered_total: rows.unansweredTotal ?? 0,
        answered_total: rows.answeredTotal ?? 0,
        avg_star_rating: rows.avg ?? null,
      }]);
    }
    if (/AVG\(/i.test(text)) return Promise.resolve([{ avg: rows.avg ?? null }]);
```

Leave the three legacy branches in place — they keep the pre-merge suite green while this task's new title is red. Task 3 Step 6 deletes them.

Then extend `ROW_PRODUCING_QUERY_SHAPES` (`:186`) with the merged shape so `rowProducingQueries` still sees it:

```ts
const ROW_PRODUCING_QUERY_SHAPES = [
  /AS\s+review_id/i,
  /unanswered_total/i,
  /AVG\(/i,
  /COUNT\(\*\)/i,
  /FROM\s+businesses\s+b/i,
] as const;
```

- [ ] **Step 4: Append the one-denominator-query title**

Append inside the same `describe` that holds `'loadPastRepliesPageView scopes every row and count to the requested business_id'` (`:327`):

```ts
  it('loadPastRepliesPageView issues ONE denominator query, so the two counts and the average share a single snapshot', async () => {
    const { view, calls } = await loadView({
      main: [listRow(), answeredRow({ review_id: 'rev-2' })],
      unansweredTotal: 7,
      answeredTotal: 3,
      avg: 4.25,
    });

    // Exactly TWO data queries now: the single row source and ONE denominator
    // query. Pre-#731 there were four — two COUNTs and the AVG in a
    // `Promise.all`, i.e. three snapshots. A reply posted between the
    // unanswered COUNT and the answered COUNT made a review invisible to both,
    // deflating totalPages so the page rendered more rows than its own
    // "N of M" admitted. COUNT(*) FILTER closes the partition arithmetically.
    const dataQueries = rowProducingQueries(calls).filter(
      (call) => !/FROM\s+businesses\s+b/i.test(call.text),
    );
    expect(dataQueries).toHaveLength(2);

    // The denominator query is the one that is NOT the row source.
    const denominators = dataQueries.find((call) => !/AS\s+review_id/i.test(call.text))!;
    expect(denominators.text).toMatch(/COUNT\(\*\)\s*FILTER/i);
    expect(denominators.text).toMatch(/AVG\(/i);
    expect(denominators.values).toContain(LOCATION_ID);

    // All three figures survive the merge.
    expect(view!.unansweredTotal).toBe(7);
    expect(view!.answeredTotal).toBe(3);
    expect(view!.avgStarRating).toBe(4.25);
  });
```

- [ ] **Step 5: Run it — expect FAIL**

```bash
pnpm vitest run src/lib/past-replies/__tests__/reviews-list.test.ts -t 'issues ONE denominator query'
```

Expected: **FAIL** with `expected [ …4 items ] to have a length of 2 but got 4`. That is the correct red.

- [ ] **Step 6: Add the empty-location fixture and the three integration titles**

In `src/lib/past-replies/__tests__/load-replies.integration.test.ts`:

First, a third business with **zero reviews**. Add beside `isolatedBusinessId` (`:57`):

```ts
// #731 item 2: a business with NO reviews at all, so the merged denominator
// query's zero-row aggregate path is exercised. Kept deliberately empty — no
// test may seed into it.
const emptyBusinessId = randomUUID();
```

In `beforeAll`, after the two existing `INSERT INTO businesses` statements, add:

```ts
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${emptyBusinessId}::uuid, 'Reviews List Empty Location', 'Reviews List Owner',
              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
```

In `afterAll`, add `emptyBusinessId` to each of the four `IN (…)` sweeps, e.g.:

```ts
      await sql()`DELETE FROM businesses WHERE id IN (${businessId}::uuid, ${isolatedBusinessId}::uuid, ${emptyBusinessId}::uuid)`;
```

Then append the three titles. They use the existing `seedReview` / `seedPostedResponse` helpers and the canonical invocation shape.

```ts
  it('unansweredTotal + answeredTotal equals the location review count exactly', async () => {
    const view = (await loadPastRepliesPageView(sql(), {
      accountId: tenant!.accountId,
      locationId: businessId,
      page: 1,
    })) as unknown as ReviewsListView | null;

    const [{ count }] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM reviews WHERE business_id = ${businessId}::uuid
    `;

    // The partition is arithmetically closed, not close-enough: post-#731 both
    // denominators are COUNT(*) FILTERs over ONE scan, so a review can be
    // invisible to neither and double-counted by neither.
    expect(view!.unansweredTotal + view!.answeredTotal).toBe(count);
  });

  it('a review with a posted reply counts once as answered and never also as unanswered', async () => {
    const reviewId = randomUUID();
    const responseId = randomUUID();
    try {
      await seedReview(reviewId, 4, '2026-04-10T12:00:00Z', REVIEW_STATUS.RESPONDED, isolatedBusinessId);
      // Two posted rows for ONE review: the answered side must still count it
      // once, because the FILTER predicate is an EXISTS, not a join.
      await sql()`
        INSERT INTO responses (
          id, review_id, business_id, response_text, original_draft_text,
          approved_text, response_language, version, status, approval_method, posted_at
        ) VALUES (
          ${responseId}::uuid, ${reviewId}::uuid, ${isolatedBusinessId}::uuid,
          'Thanks!', 'Thanks!', 'Thanks!', 'en', 1, 'posted', 'owner', NOW()
        )
      `;

      const view = (await loadPastRepliesPageView(sql(), {
        accountId: tenant!.accountId,
        locationId: isolatedBusinessId,
        page: 1,
      })) as unknown as ReviewsListView | null;

      expect(view!.answeredTotal).toBe(1);
      expect(view!.unansweredTotal).toBe(0);
      expect(view!.answeredRows.map((r) => r.review_id)).toContain(reviewId);
      expect(view!.unansweredRows.map((r) => r.review_id)).not.toContain(reviewId);
    } finally {
      await sql()`DELETE FROM responses WHERE business_id = ${isolatedBusinessId}::uuid`;
      await sql()`DELETE FROM reviews WHERE business_id = ${isolatedBusinessId}::uuid`;
    }
  });

  it('the merged denominator query returns one row for a location with zero reviews, so avgStarRating stays null', async () => {
    const view = (await loadPastRepliesPageView(sql(), {
      accountId: tenant!.accountId,
      locationId: emptyBusinessId,
      page: 1,
    })) as unknown as ReviewsListView | null;

    // An aggregate with no GROUP BY returns exactly ONE row even over zero
    // input rows, so the three figures are 0 / 0 / NULL rather than undefined.
    // If this ever reads `undefined`, the merged query grew a GROUP BY.
    expect(view).not.toBeNull();
    expect(view!.unansweredTotal).toBe(0);
    expect(view!.answeredTotal).toBe(0);
    expect(view!.avgStarRating).toBeNull();
    expect(view!.totalPages).toBe(1);
  });
```

- [ ] **Step 7: Run the integration suite — expect the first two PASS, the third PASS**

```bash
pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts \
  -t 'equals the location review count exactly'
```

All three describe invariants the CURRENT three-query implementation also satisfies when nothing races it, so they are expected **green on arrival**. They are the regression net that makes Task 3 safe — record them as such, do not force them red.

- [ ] **Step 8: Replace the three `enforceRegenBudgetForReview` titles**

In `src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts`, change the tracker mock (`:20-25`) from the single peek to the batched one:

```ts
// The per-review daily cap peek is exercised in isolation here — its Redis math
// and its swallow-and-log live in src/lib/costs/__tests__/regen-budget-batch.test.ts.
// #731: the enforcer now calls the BATCHED peek, which never rejects, so an
// ABSENT MAP ENTRY (not a rejection) is the fail-open signal.
const mockPeekRegenBudgetBatch = vi.fn();
vi.mock('@/lib/costs/tracker', () => ({
  peekRegenBudgetBatch: (...args: unknown[]) => mockPeekRegenBudgetBatch(...args),
}));
```

Then replace the three existing titles in `describe('enforceRegenBudgetForReview', …)` (`:146`) with these three. **Delete** `'returns null (allows) when regenerations remain'`, `'returns a 429 regen_limit_reached no-store response when the daily cap is reached'` and `'FAILS OPEN: returns null when the budget peek throws (worker stays the gate)'`. **Keep** `'never leaks the raw review id into the fail-open log'`, changing only its mock line to `mockPeekRegenBudgetBatch.mockResolvedValue(new Map());`.

```ts
  it('enforceRegenBudgetForReview proceeds when the batched peek reports remaining above zero', async () => {
    mockPeekRegenBudgetBatch.mockResolvedValue(
      new Map([[REVIEW_ID, { used: 1, limit: 3, remaining: 2 }]]),
    );

    expect(await enforceRegenBudgetForReview(REVIEW_ID)).toBeNull();
    expect(mockPeekRegenBudgetBatch).toHaveBeenCalledWith([REVIEW_ID]);
  });

  it('enforceRegenBudgetForReview returns 429 regen_limit_reached when the batched peek reports zero remaining', async () => {
    mockPeekRegenBudgetBatch.mockResolvedValue(
      new Map([[REVIEW_ID, { used: 3, limit: 3, remaining: 0 }]]),
    );

    const result = await enforceRegenBudgetForReview(REVIEW_ID);

    expect(result).toBeInstanceOf(NextResponse);
    expect(result?.status).toBe(429);
    expect(result?.headers.get('Cache-Control')).toBe('no-store, private');
    const body = await result?.json();
    expect(body.error).toBe('regen_limit_reached');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.remaining).toBe(0);
    expect(body.limit).toBe(3);
  });

  it('enforceRegenBudgetForReview proceeds when the batched peek returns no entry for the review', async () => {
    // The ONLY fail-open path after #731. An absent MAP ENTRY means the MGET
    // itself failed, so the advisory peek is UNKNOWN. Distinct from an absent
    // Redis KEY, which still yields `{ used: 0 }` — inverting the two would 429
    // every regenerate during an Upstash outage. The authoritative gate is
    // unaffected: the worker's Lua INCR still refuses over-budget work (D-F).
    mockPeekRegenBudgetBatch.mockResolvedValue(new Map());

    expect(await enforceRegenBudgetForReview(REVIEW_ID)).toBeNull();
  });
```

- [ ] **Step 9: Run it — expect FAIL**

```bash
pnpm vitest run src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts -t 'enforceRegenBudgetForReview'
```

Expected: all four **FAIL**. Today `dashboard-regen-rate-limit.ts` imports `peekRegenBudget`, which the reshaped `vi.mock` factory no longer provides — the import is `undefined` and every call throws `TypeError: peekRegenBudget is not a function`. That is the correct red.

- [ ] **Step 10: Add the never-rejects title to the batch suite**

Append inside `describe('peekRegenBudgetBatch', …)` (`regen-budget-batch.test.ts:88`):

```ts
  it('peekRegenBudgetBatch never rejects, so no caller needs a catch of its own', async () => {
    const peekRegenBudgetBatch = await loadBatchPeek();

    // Three ways the peek can fail, all of which must resolve rather than throw
    // — this is the whole reason #731 could delete the single-key peek and its
    // caller's try/catch (D-F / D10: the swallow lives HERE, once).
    mockRedis.mget.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(peekRegenBudgetBatch([REVIEW_A])).resolves.toBeInstanceOf(Map);

    mockRedis.mget.mockImplementationOnce(() => {
      throw new Error('synchronous client construction failed');
    });
    await expect(peekRegenBudgetBatch([REVIEW_A])).resolves.toBeInstanceOf(Map);

    // An empty input short-circuits without touching Redis at all.
    mockRedis.mget.mockClear();
    await expect(peekRegenBudgetBatch([])).resolves.toBeInstanceOf(Map);
    expect(mockRedis.mget).not.toHaveBeenCalled();
  });
```

- [ ] **Step 11: Run it — expect PASS**

```bash
pnpm vitest run src/lib/costs/__tests__/regen-budget-batch.test.ts
```

Expected **PASS** — it pins behaviour `peekRegenBudgetBatch` already has. It is the precondition Task 4 relies on, so it must be green *before* Task 4 deletes the single peek, not after.

- [ ] **Step 12: Confirm every promised title exists verbatim**

```bash
node -e '
const fs=require("fs");
const titles=JSON.parse(fs.readFileSync(".feature/intake.json","utf8")).tests_to_add;
const files=process.argv.slice(1);
const hay=files.map(f=>fs.readFileSync(f,"utf8")).join("\n");
let bad=0;
for(const t of titles){ if(!hay.includes(t)){ console.log("MISSING: "+t); bad++; } }
console.log(bad===0?"ALL 14 PRESENT":bad+" MISSING");
' src/lib/past-replies/__tests__/replies-view.test.ts \
  src/lib/past-replies/__tests__/reviews-list.test.ts \
  src/lib/past-replies/__tests__/load-replies.integration.test.ts \
  src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts \
  src/lib/costs/__tests__/regen-budget-batch.test.ts
```

Expected: `ALL 14 PRESENT`. Fix any `MISSING:` line before committing — the gate's `promised-tests` row runs the same check.

- [ ] **Step 13: Commit**

```bash
git add src/lib/past-replies/__tests__ src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts src/lib/costs/__tests__/regen-budget-batch.test.ts
git commit -m "test(#731): eval — 14 locked titles for the maintainability bundle

Authors every tests_to_add title verbatim before implementation. Red today:
the ONE-denominator-query title and the four enforceRegenBudgetForReview
titles. Green-on-arrival by design: the six toCardRow titles and the three
denominator-partition integration titles are a regression net for two
behaviour-preserving refactors, not a red-green driver."
```

---

## Task 2: Item 1 — the type-checked orphan/live reply-facts split

**Blocking edges:** Task 1. **Disjoint from** Tasks 3, 4, 5 — safe to run concurrently with them.

**Turns green / keeps green:** the six `toCardRow` titles.

**Files:**
- Modify: `src/lib/past-replies/replies-view.ts:217-272` (the `toCardRow` doc comment and body)

**Precedent to follow:** `deriveAxes` / `deriveRowAction` in the same file (`:114-167`) — total, exhaustively-typed derivations with dense rationale comments. Match that comment density; this file earns its prose.

- [ ] **Step 1: Add the `ReplyFacts` type and the two private mappers**

Insert immediately **after** `const toIso = …` (`:214-215`) and **before** the `toCardRow` doc comment.

```ts
/**
 * The seven fields whose SOURCE is decided entirely by the Posted-reply axis:
 * an orphan reads them from the `orphan_*` LATERALs, every other row from
 * `resp.*` + `fail_sidecar`. Everything else on the card is axis-independent.
 *
 * `Required<>` is load-bearing, not decoration. `version`,
 * `failed_response_id` and `failed_posting_error` are OPTIONAL on
 * `PastReplyRow` (`PastReplyCard.tsx:51,55,56`), so a bare `Pick<>` would let
 * either mapper silently omit one — which is exactly how #678's round-2
 * Defect A happened: the deleted `toOrphanCardRow` dropped
 * `failed_response_id`, and because `AnsweredControls` and `RecoveryControl`
 * gate the recovery ACTIONS on that field (not on the badge), recovery went
 * silently unreachable. Stripping the `?` makes the omission a compile error
 * (TS2739) rather than something a reviewer has to catch. That type — not
 * vigilance — is what makes re-splitting the function safe this time.
 */
type ReplyFacts = Required<
  Pick<
    ReviewsListRow,
    | 'response_id'
    | 'approved_text'
    | 'approval_method'
    | 'posted_at'
    | 'version'
    | 'failed_response_id'
    | 'failed_posting_error'
  >
>;

/**
 * Orphan reply facts — mapped from the `orphan_*` LATERALs, never from `resp.*`.
 *
 * `response_id` carries the FAILED id because `/retry` and `/restore-original`
 * address the failed response by id, and `failed_response_id` carries it too
 * because the card gates the recovery actions on that field specifically.
 * The three response-level fields are null: an orphan has no live posted reply,
 * so there is no posting time, no approval provenance and no
 * optimistic-concurrency version to hand out.
 */
function orphanReplyFacts(r: ReviewRow): ReplyFacts {
  return {
    response_id: r.orphan_failed_response_id,
    approved_text: r.superseded_text ?? null,
    approval_method: null,
    posted_at: null,
    version: null,
    failed_response_id: r.orphan_failed_response_id,
    failed_posting_error: r.orphan_posting_error,
  };
}

/**
 * Live reply facts — `posted` and `none` alike, so there is no third mapper.
 *
 * `response_id` is null for a never-replied review because the `resp` join is
 * LEFT, and that null IS the unanswered predicate. The failed_* pair comes from
 * `fail_sidecar` — the `delete_failed_*` sibling of a reply that is STILL live
 * on Google — which is a different fact from an orphan marker and must not be
 * conflated with one.
 */
function liveReplyFacts(r: ReviewRow): ReplyFacts {
  return {
    response_id: r.response_id,
    approved_text: r.approved_text,
    approval_method: r.approval_method,
    posted_at: toIso(r.posted_at),
    // Postgres.js can hand back a non-number here; the guard is carried
    // verbatim from the pre-#731 `typeof r.version !== 'number'` ternary.
    version: typeof r.version === 'number' ? r.version : null,
    failed_response_id: r.failed_response_id ?? null,
    failed_posting_error: r.failed_posting_error ?? null,
  };
}
```

- [ ] **Step 2: Replace `toCardRow`'s body with a single dispatch**

Replace the whole existing function (`:231-272`) — keep its exported signature byte-for-byte — and update its doc comment's last paragraph to describe the split:

```ts
/**
 * Maps one row of the single row source → the wire shape the card expects.
 *
 * **Orphan rows are mapped from the `orphan_*` LATERALs, not from `resp.*`.**
 * The field mapping is owned by two private mappers dispatched on the
 * Posted-reply axis — `orphanReplyFacts` / `liveReplyFacts` — which replaced
 * seven `isOrphan ? … : …` ternaries at #731. The dispatch happens ONCE; see
 * `ReplyFacts` for why the split is safe now when #678's round-2 Defect A says
 * it was not before.
 *
 * The mappers are deliberately NOT exported: they are an internal seam, and
 * every test reaches them through `toCardRow`. Testing them directly would pin
 * the refactor's shape instead of the card's behaviour.
 */
export function toCardRow(
  r: ReviewRow,
  activatedAtIso: string | null,
  hasPaidTier: boolean,
): ReviewsListRow {
  const { reply, draft } = deriveAxes(r);

  const reviewDateIso =
    r.review_date instanceof Date ? r.review_date.toISOString() : String(r.review_date);
  const externalReplyIngestedAt = toIso(r.external_reply_ingested_at);
  // The ONE dispatch on the Posted-reply axis. `none` and `posted` share a
  // mapper because they read the same columns — the difference between them is
  // whether the LEFT JOIN found a row, which `liveReplyFacts` passes through.
  const facts = reply === 'orphan' ? orphanReplyFacts(r) : liveReplyFacts(r);

  return {
    review_id: r.review_id,
    review_text: r.review_text,
    review_date: reviewDateIso,
    reviewer_name: r.reviewer_name,
    star_rating: r.star_rating,
    external_reply_ingested_at: externalReplyIngestedAt,
    review_content_hash: r.review_content_hash,
    // Strict paid-tier gate computed server-side.
    canEdit: canEdit(hasPaidTier),
    ...facts,
    reply_state: reply,
    row_action: deriveRowAction(reply, draft),
    provenance_badge: provenanceBadge(
      {
        external_reply_ingested_at: externalReplyIngestedAt,
        // The DISPATCHED approval_method, not `r.approval_method`: reading the
        // raw row would badge an orphan `auto_approved`/`owner_approved` for a
        // reply that is not on Google at all.
        approval_method: facts.approval_method,
        review_date: reviewDateIso,
      },
      activatedAtIso,
    ),
  };
}
```

- [ ] **Step 3: Verify the card's key set is still exactly 18 (LANDMINE 1)**

The returned object literal has 11 explicit keys plus 7 from `...facts`. Count them against the pinned list at `replies-view.test.ts:351`. Then prove it:

```bash
pnpm vitest run src/lib/past-replies/__tests__/replies-view.test.ts
```

Expected: **all PASS**, including `'never carries draft state or held onto the wire shape'` (`:334`), which is the key-set pin. A failure naming extra or missing keys means the spread dropped or duplicated a field.

- [ ] **Step 4: Prove the `Required<>` guarantee actually bites**

This is the one claim the tests cannot make, so verify it by hand:

```bash
# Temporarily delete the `failed_response_id` line from orphanReplyFacts, then:
pnpm typecheck 2>&1 | grep -A2 'orphanReplyFacts'
```

Expected: a TS2739/TS2741 error naming `failed_response_id`. **Restore the line immediately.** Record the observed error code in the task summary — that error IS the Defect-A guarantee, and if it does not appear the `Required<>` wrapper is not doing its job and this refactor is unsafe.

- [ ] **Step 5: Run the full past-replies + card suites**

```bash
pnpm vitest run src/lib/past-replies src/components/dashboard/reviews
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/past-replies/replies-view.ts
git commit -m "refactor(#731): dispatch toCardRow's reply facts on the Posted-reply axis

Seven isOrphan ternaries -> one dispatch to orphanReplyFacts/liveReplyFacts,
both returning Required<Pick<ReviewsListRow, ...>>. Required<> is the point:
version/failed_response_id/failed_posting_error are optional on PastReplyRow,
so a bare Pick would let a mapper drop failed_response_id and make recovery
silently unreachable — #678 round-2 Defect A, now a TS2739 instead of a review
catch. Card key set unchanged (18). Mappers are private; tests go through
toCardRow."
```

---

## Task 3: Item 2 — one denominator query, one snapshot

**Blocking edges:** Task 1. **Disjoint from** Tasks 2, 4, 5.

**Turns green:** `'loadPastRepliesPageView issues ONE denominator query…'`. **Keeps green:** the three partition titles from Task 1 Step 6.

**Files:**
- Modify: `src/lib/past-replies/load-replies.ts:162,300-339`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (ledger comment ~`:51-70`, `ALLOWLIST_BASELINE` `:70`, entries `:1291-1304`)
- Modify: `src/lib/past-replies/__tests__/reviews-list.test.ts` (retire the legacy `fakeSql` branches + fix the 4→2 count)

- [ ] **Step 1: Replace the three denominator queries with one**

In `src/lib/past-replies/load-replies.ts`, change the destructuring at `:162`:

```ts
  const [rows, denominatorRows] = await Promise.all([
```

Then replace the three query literals (`:300-334`, from the `// Group denominators.` comment through the AVG query) with:

```ts
    // Group denominators AND the average star rating — ONE query, ONE snapshot.
    //
    // #731: these were three queries inside this `Promise.all`, so they could
    // observe three different states. A reply posted between the unanswered
    // COUNT and the answered COUNT made that review invisible to BOTH, which
    // deflated `totalPages` and rendered an "N of M" with more rows on the page
    // than M admitted. `COUNT(*) FILTER` makes the partition arithmetic rather
    // than coincidental: unanswered + answered is now `COUNT(*)` by
    // construction. (The row source is still a separate snapshot from this one,
    // and deliberately so — rows-vs-counts skew is inherent to any paginated
    // list and cannot produce N > M.)
    //
    // The posted-reply EXISTS is evaluated ONCE per review in the LATERAL and
    // consumed by both FILTERs; spelling it twice would plan two correlated
    // subqueries per row. Orphan rows need no term of their own — they have no
    // posted sibling, so the unanswered side already counts them.
    //
    // Scoping is unchanged (invariant #8): `r.business_id = ${locationId}`,
    // resolved for the current account by the `biz` lookup above.
    sql<
      { unanswered_total: number; answered_total: number; avg_star_rating: number | null }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE NOT posted.has_reply)::int AS unanswered_total,
        COUNT(*) FILTER (WHERE posted.has_reply)::int     AS answered_total,
        AVG(r.star_rating)::float                         AS avg_star_rating
      FROM reviews r
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1
          FROM responses p
          WHERE p.review_id = r.id
            AND p.status = 'posted'
        ) AS has_reply
      ) posted
      WHERE r.business_id = ${locationId}
    `,
  ]);
```

Then replace the three reads at `:337-339`:

```ts
  // An aggregate with no GROUP BY returns exactly one row even over zero input
  // rows, so a location with no reviews yields 0 / 0 / NULL rather than an
  // absent row. The `?? ` fallbacks are belt-and-braces, not the happy path.
  const unansweredTotal = denominatorRows[0]?.unanswered_total ?? 0;
  const answeredTotal = denominatorRows[0]?.answered_total ?? 0;
  const avgStarRating = denominatorRows[0]?.avg_star_rating ?? null;
```

Also update the `FOUR queries, not five.` header comment at `:149` to read `THREE queries.` and note the #731 merge in one line. Do not restate the whole rationale — it is on the query.

- [ ] **Step 2: Retire the legacy `fakeSql` branches (LANDMINE 3)**

In `src/lib/past-replies/__tests__/reviews-list.test.ts`, now that no production query has the old shapes, delete the three legacy branches from `fakeSql` and the two now-dead entries from `ROW_PRODUCING_QUERY_SHAPES`, leaving:

```ts
    if (/AS\s+review_id/i.test(text)) return Promise.resolve(rows.main ?? []);
    if (/unanswered_total/i.test(text)) {
      return Promise.resolve([{
        unanswered_total: rows.unansweredTotal ?? 0,
        answered_total: rows.answeredTotal ?? 0,
        avg_star_rating: rows.avg ?? null,
      }]);
    }
    if (/FROM\s+businesses/i.test(text)) return Promise.resolve(rows.biz ?? [DEFAULT_BIZ]);
    return Promise.resolve([]);
```

```ts
const ROW_PRODUCING_QUERY_SHAPES = [
  /AS\s+review_id/i,
  /unanswered_total/i,
  /FROM\s+businesses\s+b/i,
] as const;
```

- [ ] **Step 3: Fix the existing 4-query assertion (LANDMINE 2)**

In `'loadPastRepliesPageView scopes every row and count to the requested business_id'` (`:327`), change the length and its comment:

```ts
    // Exactly TWO row-producing data queries: the single row source and the
    // merged denominator query. Pre-#731 there were four — the two group
    // COUNTs and the AVG were separate, i.e. three snapshots (#731 item 2).
    // Pre-#678 there were five (the separate orphan query, deleted by F3).
    // Counted through rowProducingQueries so a bound fragment (e.g. a status
    // `text[]`) never inflates the number and dictates the production SQL (Q3).
    expect(dataQueries).toHaveLength(2);
```

Leave the `for (const call of dataQueries)` loop untouched — the merged query satisfies `business_id\s*=`, contains `LOCATION_ID` in its values, and contains no `timestamptz`.

- [ ] **Step 4: Run the two unit suites**

```bash
pnpm vitest run src/lib/past-replies/__tests__/reviews-list.test.ts src/lib/past-replies/__tests__/replies-view.test.ts
```

Expected: all PASS, including `'issues ONE denominator query'` which was red after Task 1.

- [ ] **Step 5: Run the live-DB suite — this is the real proof**

```bash
pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
```

Expected: all PASS, including the pre-existing `'unanswered-first ordering and count denominators against the live schema'` and Task 1's three partition titles. **This step is not optional and not substitutable by the unit suites** — `fakeSql` cannot tell you whether `COUNT(*) FILTER` and `CROSS JOIN LATERAL` are valid Postgres or whether the aliases match. If `TEST_DATABASE_POOL_URL` is unset the suite self-skips and proves nothing; export it (the container `repworth-testdb` is on port 5499) and re-run.

- [ ] **Step 6: Regenerate the tenant-scope allowlist**

```bash
pnpm ci:tenant-scope
```

It will fail two ways: the two `load-replies.ts` COUNT entries are now **orphaned** (their verbatim SQL no longer exists), and the merged query is **unexempted**. Do NOT hand-write the snippet — the audit normalises whitespace, and a guessed snippet is the #1 way this step burns a round. Take the exact expected text from the failure output.

Then in `scripts/ci/tenant-scope-allowlist.ts`:

1. **Delete** the two entries at `:1291-1304` (the `NOT EXISTS` and `EXISTS` COUNT entries).
2. **Add** one entry in their place, reusing the sibling's category and reason verbatim:

```ts
  {
    file: "src/lib/past-replies/load-replies.ts",
    table: "responses",
    sqlSnippet: "<<<PASTE THE EXACT NORMALISED TEXT FROM THE ci:tenant-scope FAILURE OUTPUT>>>",
    category: 'tenant-root-lookup',
    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  },
```

3. **Set** `ALLOWLIST_BASELINE = 408` (`:70`) and append to the ledger comment above it, matching the existing `414 -> 412` / `412 -> 409` entries' style:

```
//   409 → 408 (#731), a SHRINK. The two `load-replies.ts` group-count entries
//     merged into one: the unanswered COUNT, the answered COUNT and the AVG
//     became a single `COUNT(*) FILTER` query over one snapshot, so the three
//     figures can no longer disagree. Two entries out, one in. The exemption
//     narrows in the same motion — the merged query is scoped by
//     `r.business_id = ${locationId}` exactly as its predecessors were.
```

- [ ] **Step 7: Re-run the DB audits**

```bash
pnpm ci:tenant-scope && pnpm ci:rls-audit
```

Expected: both PASS, with `ci:tenant-scope` reporting 408.

- [ ] **Step 8: Commit**

```bash
git add src/lib/past-replies/load-replies.ts src/lib/past-replies/__tests__/reviews-list.test.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "fix(#731): one denominator query for the Reviews list, one snapshot

Two COUNTs + AVG in a Promise.all could observe three states: a reply posted
between the unanswered and answered COUNTs made a review invisible to both,
deflating totalPages so the page rendered more rows than its own 'N of M'
admitted. One COUNT(*) FILTER over a CROSS JOIN LATERAL EXISTS closes the
partition arithmetically. Tenant-scope allowlist shrinks 409 -> 408."
```

---

## Task 4: Item 3 — delete the single-key peek, one contract survives

**Blocking edges:** Task 1 (specifically Step 10, which must be GREEN before the single peek is deleted). **Disjoint from** Tasks 2, 3, 5.

**Turns green:** the three `enforceRegenBudgetForReview` titles.

**Files:**
- Modify: `src/lib/costs/tracker.ts:363-402` (delete `peekRegenBudget`, retitle the batch's doc comment)
- Modify: `src/lib/shared/dashboard-regen-rate-limit.ts:1-10,77-117`
- Modify: `src/lib/costs/__tests__/tracker.test.ts:412-444` (the `describe('peekRegenBudget')` block)
- Modify: `src/lib/costs/__tests__/regen-budget-batch.test.ts` (absorb the two derivation cases)

**Owner decision (locked at intake):** delete the single-key peek rather than harmonise the two. It had exactly ONE caller and nothing varied behind it — a hypothetical seam, not a real one. **The fail-open posture (D-F) is preserved exactly; only the location of the swallow changes.**

- [ ] **Step 1: Preserve the two derivation cases before deleting their home**

`tracker.test.ts`'s `mockRedis` has **no `mget`**, so these two cases cannot stay there. Append them to `describe('peekRegenBudgetBatch', …)` in `regen-budget-batch.test.ts` first — coverage must move before it is deleted, not after:

```ts
  it('treats a missing counter as zero used, so a full budget remains', async () => {
    const peekRegenBudgetBatch = await loadBatchPeek();
    mockRedis.mget.mockResolvedValueOnce([null]);

    const statuses = await peekRegenBudgetBatch([REVIEW_A]);

    // An absent KEY means unused. Only an absent MAP ENTRY means the peek
    // failed — the distinction the whole fail-open posture rests on.
    expect(statuses.get(REVIEW_A)).toEqual({ used: 0, limit: 3, remaining: 3 });
  });

  it('reports zero remaining once the per-review daily cap is reached', async () => {
    const peekRegenBudgetBatch = await loadBatchPeek();
    mockRedis.mget.mockResolvedValueOnce(['3']);

    const statuses = await peekRegenBudgetBatch([REVIEW_A]);

    expect(statuses.get(REVIEW_A)).toEqual({ used: 3, limit: 3, remaining: 0 });
    // Read-only: surfacing "limit reached" must consume no budget and trigger
    // no LLM spend (issue #335 AC), so neither the counter nor the Lua runs.
    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
```

Run and confirm green:

```bash
pnpm vitest run src/lib/costs/__tests__/regen-budget-batch.test.ts
```

- [ ] **Step 2: Delete the `describe('peekRegenBudget')` block**

Delete `src/lib/costs/__tests__/tracker.test.ts:412-444` in full (the `describe` and all three `it`s). Its three assertions are now covered by the batch suite: "reports remaining from the read-only counter without spending" by `'…in a single round trip'` plus Step 1's `incr`/`eval` assertions, and the other two by Step 1 directly.

- [ ] **Step 3: Delete `peekRegenBudget` from the module**

In `src/lib/costs/tracker.ts`, delete `:363-377` — the doc comment and the whole function. Keep `RegenBudgetStatus` (`:354-361`); the batch returns it.

Then fix the batch's doc comment (`:379-402`), whose first line names the function that no longer exists. Replace the opening paragraph with:

```ts
/**
 * The per-review daily cap's **advisory peek** — the only one. Two callers: the
 * **Reviews list** page load, which needs a counter per ANSWERED row (a first
 * `Generate` is free by construction — the door charges only `version > 1` —
 * so unanswered rows are never passed in), and the Regenerate route, which
 * passes exactly one id. One MGET, read-only: no INCR, no eval, no LLM spend.
 *
 * #731 deleted the single-key sibling `peekRegenBudget`. It had one caller and
 * nothing varied behind it, while carrying the OPPOSITE failure contract — it
 * threw and its caller caught — so the module presented two contracts for one
 * behaviour and duplicated the used/limit/remaining derivation. A single-id
 * call is `peekRegenBudgetBatch([id])`; the failure log's `subject_count`
 * distinguishes that path from a page-sized batch.
 *
 * `regenBudgetKey` embeds `todayDateStr()` (UTC), so the whole batch shares one
 * date.
 *
 * FAILS OPEN (D-F, #678): …
```

Keep the rest of the existing comment (the fail-open and swallow-here paragraphs) verbatim — it is still exactly right and is the contract Step 4 depends on.

- [ ] **Step 4: Rewire the enforcer**

In `src/lib/shared/dashboard-regen-rate-limit.ts`, change the import at `:4`:

```ts
import { peekRegenBudgetBatch } from '@/lib/costs/tracker';
```

Replace `enforceRegenBudgetForReview` (`:77-117`) — doc comment and body:

```ts
/**
 * Returns a 429 `regen_limit_reached` NextResponse when this review has used its
 * per-review daily cap, or null when a regenerate may proceed. Call BEFORE
 * enqueueing the regenerate so the owner gets synchronous feedback instead of a
 * silent worker-side failure (issue #335).
 *
 * The peek is a read-only counter read — it does NOT consume budget or trigger
 * LLM spend. FAILS OPEN by design: an Upstash outage returns null so a
 * legitimate regenerate is never blocked here. The authoritative gate is the
 * worker's checkRegenBudget (itself retryable on Redis transport failure), so
 * over-budget work is still rejected before any spend even when this peek is
 * bypassed.
 */
export async function enforceRegenBudgetForReview(
  reviewId: string,
): Promise<NextResponse | null> {
  // ONE contract, not two (#731). peekRegenBudgetBatch never rejects — it calls
  // getCacheRedis() inside its own try and logs on the shared
  // `regen_budget_peek_failed` stream — so this call site needs no catch of its
  // own, and the deleted one is not a lost guard.
  //
  // An ABSENT MAP ENTRY is the single fail-open path: the MGET itself failed, so
  // the advisory peek is UNKNOWN and the regenerate proceeds. An absent Redis
  // KEY is a different fact and still yields `{ used: 0 }` — inverting the two
  // would 429 every regenerate during an Upstash outage (D-F).
  const status = (await peekRegenBudgetBatch([reviewId])).get(reviewId);
  if (status === undefined || status.remaining > 0) {
    return null;
  }

  return NextResponse.json(
    {
      error: 'regen_limit_reached',
      message: REGEN_LIMIT_MESSAGE,
      remaining: 0,
      limit: status.limit,
    },
    { status: 429, headers: NO_STORE_HEADERS },
  );
}
```

`createWorkerLogger` stays imported — `enforceDashboardRegenRateLimit` still uses it for `rate_limit_exceeded` at `:56-64`. Verify that before assuming the import is dead.

- [ ] **Step 5: Confirm nothing still references the deleted export**

```bash
rg -n "peekRegenBudget\b" --glob '!docs/**'
```

Expected: **no hits at all** for the bare single-key name — only `peekRegenBudgetBatch`. A hit in a test file means Step 2 missed something; a hit in production code means the intake's caller analysis was wrong and this task must stop and report.

- [ ] **Step 6: Run the three affected suites**

```bash
pnpm vitest run src/lib/costs src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts
```

Expected: all PASS, including the four `enforceRegenBudgetForReview` titles that were red after Task 1.

- [ ] **Step 7: Commit**

```bash
git add src/lib/costs/tracker.ts src/lib/costs/__tests__ src/lib/shared/dashboard-regen-rate-limit.ts src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts
git commit -m "refactor(#731): delete peekRegenBudget, one advisory-peek contract survives

The two peeks carried OPPOSITE failure contracts — one threw and its caller
caught, one swallowed and logged — and duplicated the used/limit/remaining
derivation, while the single-key one had exactly one caller and nothing varying
behind it. Its caller now calls peekRegenBudgetBatch([reviewId]); an absent map
entry is the single fail-open path. D-F posture unchanged: the authoritative
gate is still the worker's Lua INCR. Derivation coverage moved to the batch
suite before its old home was deleted."
```

---

## Task 5: Item 5 — drop the retired `PAST_REPLIES_VIEW_ENABLED`

**Blocking edges:** none — fully independent of Tasks 1-4. **Disjoint file set.**

`PAST_REPLIES_VIEW_ENABLED` was retired at #678 (CONTEXT.md:30: "retired with it at #678 — the list renders unconditionally"). This suite still sets and restores it in three places plus a stale comment; `EDIT_REPLIES_ENABLED` is the sole gate. Behaviour-neutral. The directory was outside #678's edit surface, which is the only reason it survived.

**Files:**
- Modify: `worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts:46,75,78,329-332`

- [ ] **Step 1: Delete the six references**

1. `:46` — delete the `PAST_REPLIES_VIEW_ENABLED: process.env.PAST_REPLIES_VIEW_ENABLED,` line from the `originalEnv` snapshot.
2. `:78` — delete `process.env.PAST_REPLIES_VIEW_ENABLED = 'true';`.
3. `:75` — rewrite the stale comment. It currently claims the edit routes need BOTH flags:

```ts
    // Edit routes require EDIT_REPLIES_ENABLED, the sole gate since #678
    // retired the companion UI flag PAST_REPLIES_VIEW_ENABLED (the Reviews list
    // renders unconditionally). editRepliesEnabled() is its only reader.
```

4. `:329-332` — delete the whole restore branch:

```ts
  if (originalEnv.PAST_REPLIES_VIEW_ENABLED === undefined) {
    delete process.env.PAST_REPLIES_VIEW_ENABLED;
  } else {
    process.env.PAST_REPLIES_VIEW_ENABLED = originalEnv.PAST_REPLIES_VIEW_ENABLED;
  }
```

- [ ] **Step 2: Verify the snapshot/restore stayed balanced**

Every remaining key in `originalEnv` must still have exactly one restore branch — a half-removed restore leaks env state into sibling suites:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle
rg -n "PAST_REPLIES_VIEW_ENABLED" worker/
rg -n "originalEnv\." worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts
```

Expected: the first prints nothing; the second shows each surviving key an equal number of times on the snapshot and restore sides.

- [ ] **Step 3: Run the hard-gated suite**

This is the one suite `pnpm test:integration` hard-gates, so it is verified by the standard gate. Prove it directly first:

```bash
pnpm vitest run worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts
```

Expected: all PASS with `EDIT_REPLIES_ENABLED` as the only flag set. A skip means `TEST_DATABASE_POOL_URL` is unset — export it and re-run; a skipped run proves nothing here.

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts
git commit -m "test(#731): drop retired PAST_REPLIES_VIEW_ENABLED from the publisher suite

#678 retired the flag; EDIT_REPLIES_ENABLED is the sole gate. Removes three
set/restore sites and the comment claiming both flags are required. Suite
passes on EDIT_REPLIES_ENABLED alone. Behaviour-neutral."
```

---

## Task 6: ADR 0018 addendum

**Blocking edges:** Tasks 2, 3, 4.

Task 2 **reverses** a #678 round-2 review decision — the two mappers were *merged* precisely because splitting them dropped `failed_response_id`. A reversed decision whose safety rests on a non-obvious mechanism (a type, not vigilance) is exactly what an addendum is for, and ADR 0018 already owns this file's model. ADR 0017's addendum (commit `76b40b7b`) is the format precedent.

**Files:**
- Modify: `docs/adr/0018-row-state-axes-projection.md`

- [ ] **Step 1: Read the ADR and its existing structure**

```bash
sed -n '1,40p' docs/adr/0018-row-state-axes-projection.md
git show 76b40b7b --stat -- docs/adr/
```

Match the heading level and tone of whatever addendum convention 0017 established.

- [ ] **Step 2: Append the addendum**

```markdown
## Addendum (#731, 2026-08-09) — the reply-facts split is safe because of a type

`toCardRow` now dispatches its seven axis-dependent fields to two private
mappers (`orphanReplyFacts` / `liveReplyFacts`) instead of resolving each with
its own `isOrphan ? … : …` ternary.

This **reverses a #678 round-2 decision.** Defect A merged the then-separate
`toOrphanCardRow` back into `toCardRow` because the split had dropped
`failed_response_id`, and since `AnsweredControls` and `RecoveryControl` gate the
recovery *actions* on that field rather than on the badge, recovery became
silently unreachable — a defect no test caught because the card still *rendered*
correctly.

The reversal is safe now for a reason that did not exist then, and it is not
"we will be more careful": both mappers return
`Required<Pick<ReviewsListRow, …>>`. `version`, `failed_response_id` and
`failed_posting_error` are **optional** on `PastReplyRow`, so a bare `Pick<>`
would reproduce Defect A exactly. `Required<>` strips the `?`, making an omitted
field a compile error (TS2739) rather than something review has to notice.

Consequence for future edits: **adding a field to the card that depends on the
Posted-reply axis means adding it to `ReplyFacts`**, which then forces both
mappers to answer for it. A field added only to the object literal in
`toCardRow` is axis-independent by construction — if it is not, the type will
not stop you, so keep the distinction deliberate.

The mappers are deliberately **not exported**. They are an internal seam; every
test reaches them through `toCardRow`, so the pinned card key set (18 keys) and
the behaviour contract stay the test surface rather than the refactor's shape.
```

- [ ] **Step 3: Check whether CONTEXT.md needs a word**

```bash
rg -n "regenerate budget|advisory peek" CONTEXT.md
```

CONTEXT.md:31 says the per-review daily cap has an "advisory peek at the route" — **still true** after Task 4, so no edit is required. Only touch CONTEXT.md if this grep shows a statement the bundle has actually falsified. Do not add a term; nothing here coins one.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0018-row-state-axes-projection.md
git commit -m "docs(#731): ADR 0018 addendum — the reply-facts split's type-level guarantee

Records that Task 2 reverses #678 round-2 Defect A and why that is safe now:
Required<Pick<>> makes a dropped field a TS2739, not a review catch. Notes the
consequence for future card fields."
```

---

## Final verification (orchestrator, step 5 of the workflow)

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle
export TEST_DATABASE_POOL_URL="<value from .env.local>"
bash scripts/verify-gate.sh --review
```

The `--review` form adds coverage + the `diff-coverage` row (min 80% on changed lines). `TEST_DATABASE_POOL_URL` must be set or the changed-integration-suite rows log a loud SKIP, which is **not review-ready** for this bundle — items 2 and 5 are both verified by live-DB suites.

Expected rows: `lint` `typecheck` `test` `build` (surface includes ui) every `ci:*` audit except `ci:fallow*`, the two changed integration suites, `promised-tests` (14/14), `diff-coverage`, `reclassify`.

**`reclassify` watch:** the intake estimates 200 production / 230 test lines, checked at 2× per bucket (400 / 460). Task 2 is net-additive despite deleting seven ternaries — the `Required<>` rationale and the two mappers' doc comments are most of it — so if the production bucket runs hot, that is where to look. Workflow artefacts under `docs/superpowers/plans/**` and `docs/reviews/**` are excluded from both buckets.

---

## Self-review

**Spec coverage** — issue #731's four surviving items:

| Item | Task | Status |
|---|---|---|
| 1. `toCardRow` merges two row shapes behind `isOrphan` ternaries | 2 | Covered; 6 eval titles + a key-set pin + a hand-verified TS2739 |
| 2. Three-snapshot count skew | 3 | Covered; 1 unit title (query count) + 3 integration titles + allowlist 409→408 |
| 3. Opposite failure contracts on the two peeks | 4 | Covered; single peek DELETED per owner decision, 3 enforcer titles + 3 relocated derivation cases |
| 4. `row_state` typed `string` | — | **MOOT** — #727 deleted both symbols. Recorded as a non-goal. |
| 5. Stale env var in the publisher suite | 5 | Covered; verified by the hard-gated suite |

**Placeholder scan** — one intentional placeholder remains: the `sqlSnippet` in Task 3 Step 6, which is `<<<PASTE THE EXACT NORMALISED TEXT FROM THE ci:tenant-scope FAILURE OUTPUT>>>`. This is deliberate and the step says why: the audit's whitespace normalisation makes a hand-written snippet a near-certain miss, and the tool prints the exact expected text. Everything else carries real code.

**Type consistency** — `ReplyFacts` (Task 2) is referenced by that exact name in Tasks 2 and 6. `orphanReplyFacts` / `liveReplyFacts` are spelled identically in Tasks 2 and 6. The merged query's three column aliases — `unanswered_total`, `answered_total`, `avg_star_rating` — match across the `fakeSql` branch (Task 1 Step 3), the production `sql<…>` generic and its reads (Task 3 Step 1), and the retired-branch cleanup (Task 3 Step 2). `peekRegenBudgetBatch` is the surviving name in Tasks 1, 4. `emptyBusinessId` is declared, seeded, used and torn down all within Task 1 Step 6.
