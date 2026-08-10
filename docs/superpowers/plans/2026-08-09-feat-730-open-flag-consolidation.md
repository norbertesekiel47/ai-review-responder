# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

> v2 after codex plan-review round 1 (REVISE): property test rebuilt on the
> real export + isolated business (BLOCKER), five missing-test findings folded
> into T1/T4/T5/T7, fragment-aware test doubles specified (the v1 mock claim
> was wrong for queue-based doubles), all tasks serialized with path-scoped
> staging. Full triage: docs/reviews/feat-730-open-flag-consolidation/.

**Goal:** Consolidate every owner-facing surfacing spelling of the open-flag
predicate onto one composable fragment `openFlagExistsSql`, owned by
`src/lib/moderation/held-draft.ts`, leaving the deliberately-distinct
consumers alone with the divergence recorded on the owner module.

**Architecture:** Deepen the existing `held-draft.ts` module (the semantic
owner of "is this draft held") with one new interface member — a fragment
builder in the `statusArraySql` house pattern
(`src/lib/shared/response-status-sql.ts`). The 7 owner-facing files (8 inline
spellings) then compose the fragment instead of re-spelling the predicate;
`hasOpenFlag`'s body is re-expressed on the same fragment so the
`response_id`-correlation + `status='open'` semantics are spelled exactly
once. The 8 deliberately-distinct consumers (#725 inventory) are untouched.

**Tech stack:** Postgres.js nested-fragment splicing (verified round 1:
postgres 3.4.9 recursively splices nested Query fragments in all three
composition contexts; `SELECT 1 AS one WHERE EXISTS (...)` without FROM is
valid), vitest, fast-check (house style:
`src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).

**Intake:** `.feature/intake.json` (committed copy:
`docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`).
**Research deliverable:** #725's closing comment.

**Verified planning facts** (round-1 review re-verified all of these):

- `flagged_responses` is NOT in `TENANT_TABLES` — the fragment adds no new
  audit surface; `hasOpenFlag` needs no allowlist entry today.
- Exactly 8 inline spellings exist. The six allowlist entries containing them
  key on `table: "responses"` / `"review_escalations"` (lines ~327, ~1285,
  ~1509, ~1516, ~1530, ~1537); they regenerate IN PLACE, `ALLOWLIST_BASELINE`
  stays 409. Snippets store verbatim source text normalized by
  `normalizeSql(stripSqlComments(...))`; SQL comments never appear in them.
  pending-count is directly scoped and has NO entry — confirm no new one
  appears.
- Flag statuses (migration 051 CHECK): `open`, `approved_for_owner_review`,
  `dismissed_false_positive`, `requires_regeneration`; partial unique index on
  `status = 'open'` → `fc.subarray` (subset ⇒ at most one `open`).
- The Reviews-list export is **`loadPastRepliesPageView`** (there is no
  `loadReplies`). The integration suite's static seeds already include
  unheld `pending_approval` responses on the suite's business — property and
  count tests MUST run on an isolated business and treat the suite business's
  counts as a baseline to be left undisturbed.
- **Test doubles are NOT uniformly safe under fragment migration.**
  `mkTx` (held-draft.test.ts) returns the same rows for every call — safe.
  The route/dashboard doubles `shift()` a result QUEUE per tagged call —
  a fragment-building call would eat the queued row meant for the executed
  query. Every queue-based suite touched by migration gets the
  fragment-aware double below (build-calls captured but NOT consuming).

**Fragment-aware double (house pattern for this branch, used in T4/T5):**

```ts
const isExecutedStatement = (text: string) =>
  /^\s*(select|insert|update|delete|with)\b/i.test(text);

const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  readCalls.push({ text, values });
  // Fragment builds (`resp.id`, `EXISTS (...)`) are captured for assertions
  // but must NOT consume the queued result of the outer executed query.
  if (!isExecutedStatement(text)) return { fragmentText: text, values };
  return Promise.resolve(readQueue.shift() ?? []);
});
```

---

## File structure (locked)

| File | Change |
|---|---|
| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql`; `hasOpenFlag` body re-expressed; + divergence comment block |
| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment test; contract test; + T7 source-scan test; assertion updates |
| `src/lib/past-replies/load-replies.ts` | inline EXISTS → fragment; stale `#680` comment rewritten |
| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + pinning test, + property (isolated business), + grouped-count test, + live hasOpenFlag test |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | fragment-aware double + alias-correlation assertions |
| `src/app/api/dashboard/past-replies/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
| `src/app/api/dashboard/past-replies/__tests__/**` | fragment-aware double + alias-correlation assertions |
| `src/lib/dashboard/service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
| `src/lib/dashboard/aggregate-service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
| `src/lib/dashboard/pending-count.ts` | BOTH spellings → `AND NOT ${fragment}` |
| `src/lib/dashboard/__tests__/**` | fragment-aware double where queue-based + placement/polarity assertions |
| `src/lib/agents/read.ts` | anti-join → `AND NOT ${fragment}` |
| `src/lib/agents/__tests__/read.integration.test.ts` | + exclusion test + newest-unheld fallback test |
| `src/lib/agents/__tests__/read.test.ts` | assertion updates (if any pin the join text) |
| `scripts/ci/tenant-scope-allowlist.ts` | 6 `sqlSnippet` strings regenerated in place; baseline stays 409 |

No new files. No new dependencies.

## Dispatch order — FULLY SERIAL

T1 → T2 → T3 → T4 → T5 → T6 → T7. (v1 ran T6 parallel to T3–T5; round 1
killed that: tasks share the worktree Git index and `git add -A` could stage
a sibling's half-done work. All commits below are PATH-SCOPED — never
`git add -A`.) T1 still runs alone first as the enforcement spot check.

---

### Task 1: Eval task — behavior-pinning tests + promised-test stubs

**Files:**
- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
- Modify: `src/lib/agents/__tests__/read.integration.test.ts`

All eleven intake `tests_to_add` titles land VERBATIM here. GREEN now
(behavior-pinning, they must survive the refactor unchanged): #2–#8 below.
`.todo` until their implementation task: #1 (T2), #9 (T4), #10 (T5), #11 (T7).

1. `openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref` — `.todo`
2. `hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes`
3. `a held draft still projects draft_held true after the fragment migration`
4. `getReviewTimeline excludes a response whose flag is open and includes it once closed`
5. `property: projected held and filtered visibility agree for every flag-row status combination`
6. `hasOpenFlag executes the UUID-parameter fragment against live Postgres`
7. `getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged`
8. `per-business and account-grouped pending counts exclude the same open-held rows across two businesses`
9. `each draft-status awaited query projects held from its correctly correlated response alias` — `.todo`
10. `the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned` — `.todo`
11. `all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains` — `.todo`

- [ ] **Step 1: held-draft.test.ts — titles #1 (.todo) and #2**

```ts
  it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
    const open = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
    const closed = mkTx([]);
    await expect(hasOpenFlag(closed.tx, RESPONSE_ID)).resolves.toBe(false);
  });
```

```ts
describe('openFlagExistsSql', () => {
  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
});
```

- [ ] **Step 2: load-replies.integration.test.ts — titles #3, #5, #6, #8**

Read the suite first. Crib: the `REVIEW_HELD_REPLACEMENT` fixture + its
`flagged_responses` INSERT shape (~line 138), the FK-ordered cleanup
(~line 208), and how the suite creates its business/account rows.

Title #3 — behavior-pinning against the EXISTING fixture (mirror the
neighbouring #727 held-case assertions; through `loadPastRepliesPageView`,
a held replacement draft on a posted row projects `row_action 'none'` /
withdrawn Regenerate — assert exactly what the adjacent held case asserts,
under the locked title):

```ts
  it('a held draft still projects draft_held true after the fragment migration', async () => {
    const view = await loadPastRepliesPageView(/* suite's standard args */);
    const heldRow = view.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
    expect(heldRow).toBeDefined();
    expect(heldRow!.row_action).toBe('none'); // held ⇒ affordance withdrawn (invariant #4 as structure)
  });
```

Titles #5, #6, #8 — an ISOLATED business under the suite's account (created
once in a before-hook, torn down FK-ordered after). Baseline rule: read the
suite business's `getPendingApprovalCountsForAccount` entry BEFORE the
property and assert it is UNDISTURBED inside every run (cross-business
correlation guard).

```ts
  it('property: projected held and filtered visibility agree for every flag-row status combination', async () => {
    const FLAG_STATUSES = ['open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration'] as const;
    const baseline = (await getPendingApprovalCountsForAccount(sql(), accountId)).get(suiteBusinessId) ?? 0;
    await fc.assert(
      fc.asyncProperty(fc.subarray([...FLAG_STATUSES]), async (statuses) => {
        // seed on the ISOLATED business: one review + one pending_approval
        // response + one flag row per status (INSERT shapes cribbed from ~138)
        const expectHeld = statuses.includes('open');
        const view = await loadPastRepliesPageView(/* isolated business */);
        const row = view.unansweredRows.find((r) => r.review_id === propReviewId);
        // projected mode: unanswered+pending draft ⇒ draft_ready unless held ⇒ none (#727 model)
        expect(row!.row_action).toBe(expectHeld ? 'none' : 'draft_ready');
        // filtered mode, BOTH spellings:
        expect(await getPendingApprovalCount(sql(), isolatedBusinessId)).toBe(expectHeld ? 0 : 1);
        const grouped = await getPendingApprovalCountsForAccount(sql(), accountId);
        expect(grouped.get(isolatedBusinessId) ?? 0).toBe(expectHeld ? 0 : 1);
        expect(grouped.get(suiteBusinessId) ?? 0).toBe(baseline); // no cross-business bleed
        // FK-ordered cleanup of the per-run rows
      }),
      { numRuns: 12 },
    );
  });
```

```ts
  it('per-business and account-grouped pending counts exclude the same open-held rows across two businesses', async () => {
    // isolated business: one pending_approval response WITH an open flag;
    // suite business: untouched (its unheld pending responses are the second business).
    // Assert: singular count(isolated)=0; grouped map: isolated→absent/0, suite→baseline.
  });
```

```ts
  it('hasOpenFlag executes the UUID-parameter fragment against live Postgres', async () => {
    // Inside sql().begin(): hasOpenFlag(tx, heldResponseId) === true and
    // hasOpenFlag(tx, unheldResponseId) === false, using rows seeded above.
    // This is what makes the T2 re-expression's SQL VALIDITY live-verified —
    // mkTx cannot catch malformed nesting or a bad ::uuid cast.
  });
```

(Complete elided bodies with the suite's own helpers; titles, structure,
assertions-as-commented are locked. Import `fc` from `fast-check`,
`getPendingApprovalCount`/`getPendingApprovalCountsForAccount` from
`@/lib/dashboard/pending-count`, `hasOpenFlag` from
`@/lib/moderation/held-draft`.)

- [ ] **Step 3: read.integration.test.ts — titles #4 and #7**

```ts
  it('getReviewTimeline excludes a response whose flag is open and includes it once closed', async () => {
    // seed review + one displayable response; INSERT open flag → timeline response null;
    // UPDATE flag to 'dismissed_false_positive' → timeline shows the response.
  });

  it('getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged', async () => {
    // seed v1 (unheld) + v2 (open-flagged, higher version) on one review:
    // timeline must return v1 — NOT null. Pins that held-filtering applies to
    // the candidate set BEFORE ORDER BY version DESC LIMIT 1 (the T6 rewrite
    // must preserve this).
  });
```

Also add `.todo` stubs where they belong:
in `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts`:
`it.todo('each draft-status awaited query projects held from its correctly correlated response alias')`;
in `src/lib/dashboard/__tests__/service.feed-projection.test.ts` (NOT
`service.test.ts` — that file does not exist):
`it.todo('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned')`.

- [ ] **Step 4: run — all green (4 todos)**

```bash
pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts
```

(If schema assertions fail: `pnpm test:db:setup` once, re-run.)

- [ ] **Step 5: Commit (path-scoped)**

```bash
git add src/lib/moderation/__tests__ src/lib/past-replies/__tests__ src/lib/agents/__tests__ "src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__" src/lib/dashboard/__tests__
git commit -m "test(#730): eval task — pin held-draft behavior across the predicate consolidation"
```

### Task 2: `openFlagExistsSql` + re-expressed `hasOpenFlag` + divergence block

**Files:**
- Modify: `src/lib/moderation/held-draft.ts`
- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`

- [ ] **Step 1: fill title #1 (red)**

```ts
describe('openFlagExistsSql', () => {
  it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
    const { tx, calls } = mkTx([]);
    openFlagExistsSql(tx, tx`resp.id`);
    const exists = calls.at(-1)!;
    expect(exists.text).toContain('EXISTS (');
    expect(exists.text).toContain('FROM flagged_responses fr');
    expect(exists.text).toContain("fr.status = 'open'");
    expect(exists.text).toContain('fr.response_id = ');
  });
  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
});
```

Run: `pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts` —
expected FAIL (`openFlagExistsSql` not exported).

- [ ] **Step 2: implement in `held-draft.ts`**

```ts
import type postgres from 'postgres';

type TxClient = postgres.TransactionSql;
type DbClient = postgres.Sql | postgres.TransactionSql;

/**
 * The one read-side spelling of "response X has an OPEN moderation flag".
 * Composable Postgres.js fragment (nested queries splice as raw SQL text):
 * projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` — D9 sites) or
 * filtered (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`). `ref` is
 * itself a fragment: a correlated column ref (sql`resp.id`) or a bound
 * parameter (tx`${responseId}::uuid`). Client-agnostic like statusArraySql —
 * pass the surrounding query's client.
 */
export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
  return db`EXISTS (
    SELECT 1 FROM flagged_responses fr
    WHERE fr.response_id = ${ref} AND fr.status = 'open'
  )`;
}
```

(If `postgres.PendingQuery<postgres.Row[]>` fights the inferred
tagged-template type, mirror `statusArraySql`'s inference; `postgres.Fragment`
is the v3 alternative. No `any`.)

```ts
export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one
    WHERE ${openFlagExistsSql(tx, tx`${responseId}::uuid`)}
  `;
  return rows.length > 0;
}
```

- [ ] **Step 3: divergence comment block** (extend the contract header — #725 §3 sink)

```ts
// Deliberately distinct consumers — do NOT consolidate onto this module.
// Four categories read/write flagged_responses with DIFFERENT semantics, and
// force-fitting them is how a shared helper acquires a boolean parameter
// meaning "actually a different query" (full 16-consumer inventory: #725):
//   - Admin surfaces (/api/admin/flagged, flagged-service, nav-counts): their
//     subject is the FLAG ROW itself (disposition by id, queue enumeration,
//     cross-tenant badge count) — not a response's held-ness.
//   - Health alerting (health-alert/checks.ts): cross-tenant COUNT of open
//     rows vs threshold; worker alerting must not couple to an owner-UI read.
//   - Offboarding purge lane (purge-verification, purge-stages,
//     table-disposition): deliberately IGNORES status — a closed flag left
//     behind is still a purge violation.
//   - The producer (response-generation/persist.ts): writes the flag row and
//     keeps its own module-local status const (different lifecycle).
```

- [ ] **Step 4: update mkTx call-count assertions**

The re-expressed body makes `mkTx` capture 3 calls. In
`"filters on status = 'open' and the response id — the predicate that makes the hold binding"`:

```ts
    const allText = calls.map((c) => c.text).join('\n');
    expect(allText).toContain("status = 'open'");
    expect(allText).toContain('FROM flagged_responses');
    expect(calls.flatMap((c) => c.values)).toContain(RESPONSE_ID);
```

- [ ] **Step 5: run + commit**

```bash
pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # title #6 live-verifies the new body
pnpm typecheck
git add src/lib/moderation
git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
```

### Task 3: Migrate `load-replies.ts` + regen allowlist entry (~1285)

**Files:**
- Modify: `src/lib/past-replies/load-replies.ts:230-244`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (load-replies main-query entry)
- Check: `src/lib/past-replies/__tests__/` unit suites for outer-text assertions

- [ ] **Step 1: rewrite the spelling + the stale #680 comment**

Old:

```
      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
      -- held while an open flagged_responses row exists". Its hasOpenFlag is an
      -- in-tx, post-lock release gate taking a TransactionSql — it cannot be
      -- composed into a LATERAL — so the predicate is spelled inline here (D6);
      -- consolidating the spellings into one exported fragment is a #680 item.
      LEFT JOIN LATERAL (
        SELECT
          resp2.id,
          EXISTS (
            SELECT 1
            FROM flagged_responses f
            WHERE f.response_id = resp2.id
              AND f.status = 'open'
          ) AS held
```

New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`; use the
client variable actually in scope):

```
      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
      -- held while an open flagged_responses row exists"; this projection
      -- composes its openFlagExistsSql fragment (#730). Projected, not
      -- filtered (D9): a held draft must stay distinguishable from "no draft".
      LEFT JOIN LATERAL (
        SELECT
          resp2.id,
          ${openFlagExistsSql(sql, sql`resp2.id`)} AS held
```

- [ ] **Step 2: regen the allowlist entry**

```bash
pnpm ci:tenant-scope 2>&1 | tail -30
```

Expected: FAIL naming `load-replies.ts` with the newly-extracted query text.
Paste it into the existing entry's `sqlSnippet` (~line 1285,
`table: "responses"`). Entry COUNT unchanged — `ALLOWLIST_BASELINE` stays 409.
Re-run; PASS.

- [ ] **Step 3: run + commit**

```bash
pnpm vitest run src/lib/past-replies
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
git add src/lib/past-replies scripts/ci/tenant-scope-allowlist.ts
git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
```

If a unit suite pinned outer query text containing the inline EXISTS, relocate
the assertion to the fragment's captured call (fragment-aware double if the
suite is queue-based) — never delete it.

### Task 4: Migrate the two draft-status routes + regen entry (~327) + title #9

**Files:**
- Modify: `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:57-75`
- Modify: `src/app/api/dashboard/past-replies/draft-status/route.ts:109-127`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (past-replies draft-status entry ~327)
- Modify: both routes' test suites — fragment-aware doubles + title #9

- [ ] **Step 1: reviews/[reviewId]/draft-status — rewrite**

Comment: keep F5/invariant-#4 + D9 sentences; the "spells … inline (D6)"
sentences become:

```ts
    // That module is the SEMANTIC OWNER of "is this draft held"; this read
    // path composes its openFlagExistsSql fragment (#730).
```

Query: `EXISTS (…) AS held` block →
`${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held`.

- [ ] **Step 2: past-replies/draft-status — rewrite**

Same comment treatment; predicate →
`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held`
(this query's correlated ref is the unaliased table).

- [ ] **Step 3: upgrade BOTH suites' doubles to the fragment-aware pattern**
(header of this plan) — the queue-based mocks otherwise consume the queued
row on fragment-build calls. Then fill title #9 (moved from `.todo`):

```ts
  it('each draft-status awaited query projects held from its correctly correlated response alias', async () => {
    // run the route with a queued draft row, then:
    const refCall = readCalls.find((c) => c.text.trim() === 'resp.id');   // 'responses.id' in the past-replies suite
    expect(refCall, 'fragment ref must correlate on the outer query alias').toBeDefined();
    const existsCall = readCalls.find((c) => c.text.includes('FROM flagged_responses'));
    expect(existsCall!.text).toContain("fr.status = 'open'");
  });
```

- [ ] **Step 4: regen entry ~327, run, commit**

```bash
pnpm ci:tenant-scope 2>&1 | tail -30   # fails naming past-replies/draft-status; paste new snippet
pnpm vitest run "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies
git add "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies scripts/ci/tenant-scope-allowlist.ts
git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
```

(The reviews route has no allowlist entry — it binds `resp.business_id`.
Relocate — never delete — any outer-text assertions that pinned
`FROM flagged_responses`.)

### Task 5: Migrate the dashboard trio + regen 4 entries + title #10

**Files:**
- Modify: `src/lib/dashboard/service.ts:253-256`
- Modify: `src/lib/dashboard/aggregate-service.ts:404-407`
- Modify: `src/lib/dashboard/pending-count.ts:17-20,45-48`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries: ~1509/~1516/~1530/~1537)
- Modify: `src/lib/dashboard/__tests__/` — fragment-aware doubles where queue-based + title #10

- [ ] **Step 1: service.ts + aggregate-service.ts** — keep both comments; the block

```
          AND NOT EXISTS (
            SELECT 1 FROM flagged_responses fr
            WHERE fr.response_id = responses.id AND fr.status = 'open'
          )
```

becomes

```
          AND NOT ${openFlagExistsSql(sql, sql`responses.id`)}
```

(correlated ref is the unaliased `responses` table in both LATERALs; use each
query's in-scope client variable.)

- [ ] **Step 2: pending-count.ts — BOTH spellings** →
`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`. Import in all three files.

- [ ] **Step 3: fragment-aware harness + fill title #10** — grounded in the
REAL suites (round-2 fix; v2 cited a nonexistent `service.test.ts`):

The dashboard suites share a queue-based mock harness
(`harness.sqlReturnQueue` / `harness.sqlCalls`, text via `strings.join`) —
find its defining module under `src/lib/dashboard/__tests__/` and apply the
fragment-aware guard from the plan header THERE, once, so every dashboard
suite inherits it.

Title #10 goes in `service.feed-projection.test.ts` (moved from `.todo`),
using that suite's OWN `lateralBody(queryText, 'resp')` slicer (defined at
~line 41) instead of invented plumbing:

```ts
  it('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned', async () => {
    // (drive the feed query exactly like the suite's neighbouring cases, then:)
    const body = lateralBody(recentReviewsQuery()!.text, 'resp');
    const notIdx = body.indexOf('AND NOT ?');            // fragment placeholder, NEGATED polarity
    const orderIdx = body.indexOf('ORDER BY version DESC');
    expect(notIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(notIdx);            // filter BEFORE order/limit — held newest falls back to unheld sibling
    // Correlation pin — LOCKED INTENT, harness-adaptive FORM (round-3 note:
    // the harness may record only awaited statements, or may flatten fragment
    // text into the outer statement). After applying the header's
    // fragment-aware upgrade — which records EVERY tagged call, builds
    // included — assert whichever observable the upgraded harness actually
    // produces:
    //   captured-build form:  a captured call whose text.trim() === 'responses.id'
    //                         AND one containing 'FROM flagged_responses fr'
    //   flattened form:       body contains "fr.response_id = responses.id"
    //                         AND "FROM flagged_responses fr"
    // One of the two MUST be asserted; if neither is observable the harness
    // upgrade is wrong — fix the harness, do not weaken the pin.
  });
```

MANDATORY mirror for the aggregate feed query: place the same
polarity+placement+correlation assertions in the aggregate suite that
captures its query text (`aggregate-queries.test.ts` /
`aggregate-service.test.ts` — read them and put the pin beside the existing
text assertions). Also RELOCATE, never delete, the existing
`aggregate-queries.test.ts` ~line 261 `expect(call.text).toContain('flagged_responses')`
pin on the grouped pending count — post-migration that text lives in the
fragment's own captured call.

**Accepted residual (recorded for review):** the migrated service/aggregate
LATERALs have no live execution path in any suite. Accepted because the
fragment's splice validity is live-proven in all three composition contexts
(projected-in-LATERAL via load-replies, filtered via pending-count titles
#5/#8, parameter-correlated via title #6), the edits are surgical
in-place block swaps, and the unit pins above catch polarity/placement/
correlation regressions. A live dashboard-service suite remains
disproportionate for this refactor.

- [ ] **Step 4: regen entries, run — INCLUDING the cross-module property — commit**

```bash
pnpm ci:tenant-scope 2>&1 | tail -40   # 4 mismatches: service ×2, aggregate ×2 — paste each
pnpm vitest run src/lib/dashboard
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # titles #5/#8 exercise BOTH pending-count spellings live against the migrated code
git add src/lib/dashboard scripts/ci/tenant-scope-allowlist.ts
git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
```

(pending-count has NO allowlist entry — its queries are directly scoped;
confirm the audit passes without adding one.)

### Task 6: `agents/read.ts` — anti-join → NOT EXISTS

**Files:**
- Modify: `src/lib/agents/read.ts:317-334`
- Check: `src/lib/agents/__tests__/read.test.ts` for join-text assertions

- [ ] **Step 1: rewrite**

Old:

```
      FROM responses resp
      JOIN businesses b ON b.id = resp.business_id
      LEFT JOIN flagged_responses fr
        ON fr.response_id = resp.id AND fr.status = 'open'
      WHERE resp.review_id = ${params.reviewId}
        AND b.account_id = ${params.accountId}
        AND b.archived_at IS NULL
        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
        AND fr.id IS NULL
```

New:

```
      FROM responses resp
      JOIN businesses b ON b.id = resp.business_id
      WHERE resp.review_id = ${params.reviewId}
        AND b.account_id = ${params.accountId}
        AND b.archived_at IS NULL
        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
        -- Held drafts never surface on the timeline (invariant #4);
        -- src/lib/moderation/held-draft.ts owns the predicate (#730).
        AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
```

- [ ] **Step 2: run + commit**

```bash
pnpm vitest run src/lib/agents
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/agents/__tests__/read.integration.test.ts   # titles #4 and #7 — exclusion AND newest-unheld fallback
git add src/lib/agents
git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
```

(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched; no
allowlist work here.)

### Task 7: Source-scan test (title #11) + verify gate

- [ ] **Step 1: fill title #11** in held-draft.test.ts (moved from `.todo`) —
house precedent: source-scanning suites like
`src/__tests__/eslint-boundaries.test.ts` / `design-token-single-source.test.ts`:

Round-2 hardening (finding 7): the scan counts INVOCATIONS (`openFlagExistsSql(`
never matches the import specifier), requires BOTH pending-count call sites,
and mechanically forbids any of the eleven promised titles surviving as
`.todo` — closing the gate's `.todo` acceptance without touching
`verify-gate.sh` (out of surface).

```ts
  it('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains', () => {
    // file → minimum openFlagExistsSql(...) INVOCATIONS (import lines never
    // match `openFlagExistsSql(`): pending-count has TWO spellings.
    const OWNER_FACING: Array<[string, number]> = [
      ['src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts', 1],
      ['src/app/api/dashboard/past-replies/draft-status/route.ts', 1],
      ['src/lib/past-replies/load-replies.ts', 1],
      ['src/lib/dashboard/service.ts', 1],
      ['src/lib/dashboard/aggregate-service.ts', 1],
      ['src/lib/dashboard/pending-count.ts', 2],
      ['src/lib/agents/read.ts', 1],
    ];
    for (const [file, minCalls] of OWNER_FACING) {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf-8');
      // strip line comments so a mention in prose can neither satisfy the
      // invocation count nor trip the inline-spelling scan (round-3 hardening)
      const src = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      const calls = src.match(/openFlagExistsSql\(/g)?.length ?? 0;
      expect(calls, `${file} must invoke openFlagExistsSql at least ${minCalls}×`).toBeGreaterThanOrEqual(minCalls);
      expect(src, `${file} re-spells the open-flag predicate inline`).not.toMatch(/FROM\s+flagged_responses/i);
    }
  });

  it('no promised #730 test title survives as .todo', () => {
    // The verify gate's promised-tests row accepts `.todo`; this closes that
    // escape mechanically. Scans the four suites that carried stubs.
    const SUITES = [
      'src/lib/moderation/__tests__/held-draft.test.ts',
      'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts',
      'src/lib/dashboard/__tests__/service.feed-projection.test.ts',
    ];
    for (const suite of SUITES) {
      const src = readFileSync(resolve(process.cwd(), suite), 'utf-8');
      // it.todo / test.todo, dot or bracket access, whitespace-tolerant
      // (round-3 hardening: `it['todo'](...)` and `it.todo (...)` count too)
      expect(src, `${suite} still carries a .todo stub`).not.toMatch(
        /\b(?:it|test)\s*(?:\.\s*todo\b|\[\s*['"]todo['"]\s*\])/,
      );
    }
  });
```

(The second test's title is a T7 implementation detail, not a promised intake
title — it needs no intake entry; it exists to make the ".todo left behind"
failure mode mechanical rather than prose.)

Run the suite; commit:

```bash
pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
git add src/lib/moderation/__tests__
git commit -m "test(#730): source-scan — no owner-facing inline open-flag spelling remains"
```

- [ ] **Step 2:** `bash scripts/verify-gate.sh` — all rows PASS; no remaining
  `.todo` among the eleven titles; `reclassify` inside 2× both buckets.
- [ ] **Step 3:** fix fallout (re-run per fix; same failure class twice → STOP,
  anti-thrash rule). Final pre-review run: `bash scripts/verify-gate.sh --review`.

---

## Self-review (v2)

- **Round-1 findings coverage:** BLOCKER → T1 rebuilt on
  `loadPastRepliesPageView` + isolated business + baseline guard. MAJORs →
  titles #6 (live hasOpenFlag, T1/T2), #9 (alias correlation, T4), #7
  (newest-unheld fallback, T1/T6), #8 (grouped counts, T1/T5), #10
  (placement/polarity, T5 — partial-accept, live dashboard suite rejected as
  disproportionate, reasoning inline), #11 (source-scan, T7); fragment-aware
  double specified and mandated in T4/T5; T5 re-runs the property; full
  serialization + path-scoped staging. MINOR → intake edge_case corrected
  (deviations entry).
- **Placeholder scan:** elided test bodies each name the exact fixture/helper
  to crib and lock title + assertion structure; no TBDs.
- **Type consistency:** `openFlagExistsSql(db, ref)` spelled identically in
  T2–T7; ref always the executing client's fragment.
