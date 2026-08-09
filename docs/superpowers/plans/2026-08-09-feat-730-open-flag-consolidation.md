# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

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

**Tech stack:** Postgres.js nested-fragment splicing (a `PendingQuery`
interpolated into another template splices as raw SQL text — the lab-notes
#573/#706 mechanic), vitest, fast-check (house style:
`src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).

**Intake:** `.feature/intake.json` (committed copy:
`docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`).
**Research deliverable:** #725's closing comment (classified inventory, chosen
shape, divergence sink).

**Verified planning facts** (checked against the tree at fork, 2026-08-09):

- `flagged_responses` is NOT in `TENANT_TABLES` (`scripts/ci/tenant-tables.ts`)
  — the tenant-scope auditor never audits it directly. The fragment adds no new
  audit surface, and `hasOpenFlag` today needs no allowlist entry for the same
  reason.
- The six allowlist entries whose `sqlSnippet` contains the migrating predicate
  key on `table: "responses"` / `"review_escalations"`, NOT `flagged_responses`:
  lines ~327 (past-replies draft-status), ~1285 (load-replies main), ~1509 +
  ~1516 (service.ts), ~1530 + ~1537 (aggregate-service.ts). They regenerate **in
  place** — count unchanged, `ALLOWLIST_BASELINE` stays 409. Snippets store
  VERBATIM source text (interpolations appear as `${...}` source), normalized
  by `normalizeSql(stripSqlComments(...))` — SQL comments do NOT appear in
  snippets, so comment rewrites never touch the allowlist.
- Flag statuses (migration `051_flagged_responses.sql` CHECK): `open`,
  `approved_for_owner_review`, `dismissed_false_positive`,
  `requires_regeneration`. Partial index machinery exists on
  `WHERE status = 'open'` — the property test generates a SUBSET of the four
  statuses (`fc.subarray`), so it never inserts two `open` rows per response.
- Test doubles: `held-draft.test.ts` `mkTx` and the route-test `sqlMock`s
  capture tagged-template calls and return `Promise.resolve(rows)` for every
  call. After migration, building a nested fragment registers EXTRA captured
  calls and splices a Promise into `values`; the executed query still resolves
  the queued rows, but `toHaveLength(1)`-style call-count assertions and
  outer-text `toContain('FROM flagged_responses')` assertions move to the
  fragment's own captured call. Each migration task updates its suite's
  assertions accordingly.
- `load-replies.integration.test.ts` already seeds `flagged_responses`
  (INSERT at ~line 138; held-replacement fixture `REVIEW_HELD_REPLACEMENT`,
  cleanup at ~line 208) — crib its seed shape. `read.integration.test.ts` has
  NO flag coverage today; the timeline test is genuinely new.

---

## File structure (locked)

| File | Change |
|---|---|
| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql` fragment builder; `hasOpenFlag` body re-expressed on it; + "deliberately distinct consumers" divergence comment block |
| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment rendering test; contract test; call-count assertion updates |
| `src/lib/past-replies/load-replies.ts` | inline EXISTS → fragment; stale `#680` comment rewritten |
| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + behavior-pinning test + fast-check property |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | assertion updates only |
| `src/app/api/dashboard/past-replies/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
| `src/app/api/dashboard/past-replies/__tests__/**` | assertion updates only |
| `src/lib/dashboard/service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
| `src/lib/dashboard/aggregate-service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
| `src/lib/dashboard/pending-count.ts` | BOTH spellings → `AND NOT ${fragment}` |
| `src/lib/dashboard/__tests__/**` | assertion updates only |
| `src/lib/agents/read.ts` | anti-join (`LEFT JOIN … fr.id IS NULL`) → `AND NOT ${fragment}` |
| `src/lib/agents/__tests__/read.integration.test.ts` | + timeline exclusion test |
| `src/lib/agents/__tests__/read.test.ts` | assertion updates only (if any pin the join text) |
| `scripts/ci/tenant-scope-allowlist.ts` | 6 `sqlSnippet` strings regenerated in place; baseline stays 409 |

No new files. No new dependencies.

## Blocking edges / dispatch order

- **T1 (eval)** runs first, ALONE (first-task enforcement spot check).
- **T2 (owner module)** blocks every migration task.
- **T3 → T4 → T5 SERIAL** — all three edit `scripts/ci/tenant-scope-allowlist.ts`.
- **T6 independent of T3–T5** (agents/read.ts has no allowlist entry with the
  predicate) — may run in parallel with the T3–T5 chain after T2.
- **T7 (gate)** last.

---

### Task 1: Eval task — behavior-pinning tests + promised-test stubs

**Files:**
- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
- Modify: `src/lib/agents/__tests__/read.integration.test.ts`

These are the spec in executable form. The behavior-pinning tests must be
GREEN before any implementation task (they pin current behavior across the
refactor); the fragment-rendering test is a `.todo` stub until T2 fills it.
All five intake `tests_to_add` titles land VERBATIM in this task (the gate's
`promised-tests` row checks titles, `.todo` included).

- [ ] **Step 1: held-draft.test.ts — add the two titles**

Append inside `describe('hasOpenFlag', …)`:

```ts
  it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
    // Same double, both branches — pins the contract across the #730 body
    // re-expression (rows.length > 0 stays the decision rule).
    const open = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
    const closed = mkTx([]);
    await expect(hasOpenFlag(closed.tx, RESPONSE_ID)).resolves.toBe(false);
  });
```

Append a new top-level describe:

```ts
describe('openFlagExistsSql', () => {
  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
});
```

- [ ] **Step 2: load-replies.integration.test.ts — behavior-pinning + property**

Read the suite first; crib the existing `REVIEW_HELD_REPLACEMENT` seed and the
FK-ordered cleanup (`DELETE FROM flagged_responses …` before responses). Add,
inside the suite's existing live-DB describe (respecting its
`assertSchemaReady` / lock conventions):

```ts
  it('a held draft still projects draft_held true after the fragment migration', async () => {
    // Behavior-pinning (green BEFORE and AFTER #730): the Reviews list
    // projects held-ness (D9 SELECTed-not-filtered) rather than dropping the
    // row. Reuses the REVIEW_HELD_REPLACEMENT fixture seeded above.
    const view = await loadReplies(sql(), businessId, 1);
    const heldRow = view!.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
    expect(heldRow).toBeDefined();
    // draft_held is the projected fragment output — the wire never sees 'held'
    // (CONTEXT.md "Reviews list"); the projection is what deriveRowAction
    // consumes server-side.
    expect(heldRow!.draft_held ?? heldRow!.row_action === 'none').toBeTruthy();
  });
```

(The exact projected field the suite can see depends on what `loadReplies`
returns post-#727 — `draft_held` on the raw row or `row_action 'none'` on the
view. Match the suite's existing held-replacement assertions; the TITLE is
locked, the assertion mirrors the neighbouring #727 held case.)

```ts
  it('property: projected held and filtered visibility agree for every flag-row status combination', async () => {
    // Invariant #4 as a property: for ANY set of flag rows on a
    // pending_approval draft, the projected predicate (draft held) and the
    // filtered predicate (pending-count exclusion) must agree — they are the
    // same fragment used in two modes. Bounded runs: live-DB roundtrips.
    const FLAG_STATUSES = [
      'open',
      'approved_for_owner_review',
      'dismissed_false_positive',
      'requires_regeneration',
    ] as const;
    await fc.assert(
      fc.asyncProperty(fc.subarray([...FLAG_STATUSES]), async (statuses) => {
        // seed: one pending_approval response on a dedicated review row
        // (INSERT shape cribbed from the suite's existing flagged_responses
        // seed at ~line 138), one flag row per generated status
        // (fc.subarray → at most one 'open', respecting the partial unique
        // index on status='open').
        // ... seed review + response + flag rows ...
        const expectHeld = statuses.includes('open');
        const view = await loadReplies(sql(), businessId, 1);
        const count = await getPendingApprovalCount(sql(), businessId);
        // projected mode: the row's draft is held iff an open flag exists
        // filtered mode: the pending count excludes the draft iff held
        expect(/* row projected as held */).toBe(expectHeld);
        expect(count).toBe(expectHeld ? 0 : 1);
        // ... FK-ordered cleanup ...
      }),
      { numRuns: 12 },
    );
  });
```

Import `fc` from `fast-check` and `getPendingApprovalCount` from
`@/lib/dashboard/pending-count`. The property seeds/cleans INSIDE the
predicate (per-run isolation); keep the fixture ids distinct from the suite's
static seeds so the existing cases are undisturbed. Flesh the elided seed /
assertion lines out against the suite's real helpers — the STRUCTURE above
(subarray → seed → two reads → agree → cleanup) and `numRuns: 12` are locked.

- [ ] **Step 3: read.integration.test.ts — timeline exclusion**

Read the suite for its seed helpers, then add:

```ts
  it('getReviewTimeline excludes a response whose flag is open and includes it once closed', async () => {
    // Behavior-pinning for the T6 anti-join → NOT EXISTS rewrite: the
    // timeline hides a held draft (invariant #4) and shows it again after
    // the admin disposition closes the flag.
    // seed: review + pending_approval response (suite helpers), then:
    // 1. INSERT flagged_responses row (status 'open') → timeline response null
    // 2. UPDATE the flag to 'dismissed_false_positive' → timeline shows it
  });
```

(Complete the body with the suite's own seed helpers; both assertions go
through `getReviewTimeline(sql(), { accountId, reviewId })`.)

- [ ] **Step 4: run — pinning tests GREEN, stub todo**

```bash
cd <worktree> && pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts
```

Expected: all green (1 todo). If the live-DB suites fail on schema, run
`pnpm test:db:setup` once first.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(#730): eval task — pin held-draft behavior across the predicate consolidation"
```

### Task 2: `openFlagExistsSql` + re-expressed `hasOpenFlag` + divergence block

**Files:**
- Modify: `src/lib/moderation/held-draft.ts`
- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`

- [ ] **Step 1: fill the `.todo` test (red)**

Replace the `.todo` with (mkTx captures the fragment build as its own call):

```ts
describe('openFlagExistsSql', () => {
  it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
    const { tx, calls } = mkTx([]);
    openFlagExistsSql(tx, tx`resp.id`);
    // two captured calls: the ref fragment, then the EXISTS wrapper
    const exists = calls.at(-1)!;
    expect(exists.text).toContain('EXISTS (');
    expect(exists.text).toContain('FROM flagged_responses fr');
    expect(exists.text).toContain("fr.status = 'open'");
    expect(exists.text).toContain('fr.response_id = ');
  });
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
 * Composable Postgres.js fragment (nested queries splice as raw SQL text), so
 * it works projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` —
 * D9 SELECTed-not-filtered sites) and filtered
 * (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}` — dashboard reads).
 * `ref` is itself a fragment: a correlated column ref (sql`resp.id`) or a
 * bound parameter (tx`${responseId}::uuid`). Client-agnostic like
 * statusArraySql — pass the surrounding query's client.
 */
export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
  return db`EXISTS (
    SELECT 1 FROM flagged_responses fr
    WHERE fr.response_id = ${ref} AND fr.status = 'open'
  )`;
}
```

(If `postgres.PendingQuery<postgres.Row[]>` fights the tagged-template return
type, mirror however `statusArraySql`'s return type is inferred — do NOT cast
through `any`; `postgres.Fragment` is the v3 alternative.)

Re-express `hasOpenFlag` (signature and contract UNCHANGED):

```ts
export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    SELECT 1 AS one
    WHERE ${openFlagExistsSql(tx, tx`${responseId}::uuid`)}
  `;
  return rows.length > 0;
}
```

- [ ] **Step 3: divergence comment block**

Extend the module's contract header (after the existing release-disposition
lines) — the #725 §3 sink:

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

- [ ] **Step 4: update existing text-pinning assertions**

The re-expressed body makes `mkTx` capture 3 calls (ref build, fragment
build, executed query). In the existing test
`"filters on status = 'open' and the response id — the predicate that makes the hold binding"`:
drop `expect(calls).toHaveLength(1)`; assert over ALL captured text instead:

```ts
    const allText = calls.map((c) => c.text).join('\n');
    expect(allText).toContain("status = 'open'");
    expect(allText).toContain('FROM flagged_responses');
    expect(calls.flatMap((c) => c.values)).toContain(RESPONSE_ID);
```

- [ ] **Step 5: run + commit**

```bash
pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts   # all green
pnpm typecheck
git add -A && git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
```

### Task 3: Migrate `load-replies.ts` + regen allowlist entry (~1285)

**Files:**
- Modify: `src/lib/past-replies/load-replies.ts:230-244`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (`load-replies` main-query entry)
- Check: `src/lib/past-replies/__tests__/` unit suites for outer-text assertions

- [ ] **Step 1: rewrite the spelling + the stale comment**

Old (the comment cites #680, which never did the consolidation):

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

New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`):

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

(Use the client variable actually in scope in that function — read the file.)

- [ ] **Step 2: regen the allowlist entry**

```bash
pnpm ci:tenant-scope 2>&1 | tail -30
```

Expected: FAIL naming `src/lib/past-replies/load-replies.ts` with the
newly-extracted query text. Paste that text into the existing entry's
`sqlSnippet` (file ~line 1285, `table: "responses"`). Entry COUNT unchanged —
do not touch `ALLOWLIST_BASELINE`. Re-run; expected PASS.

- [ ] **Step 3: run + commit**

```bash
pnpm vitest run src/lib/past-replies
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
git add -A && git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
```

If a unit suite pinned the outer query text containing the inline EXISTS,
update it to expect the fragment call shape instead (see the Task 2 pattern).

### Task 4: Migrate the two draft-status routes + regen entry (~327)

**Files:**
- Modify: `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:57-75`
- Modify: `src/app/api/dashboard/past-replies/draft-status/route.ts:109-127`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (past-replies draft-status entry ~327)
- Check: both routes' test suites for outer-text/call-count assertions

- [ ] **Step 1: reviews/[reviewId]/draft-status — rewrite**

Comment block: keep the F5/invariant-#4 rationale and the D9 sentence; replace
the two sentences claiming the predicate "spells … inline instead (D6)" with:

```ts
    // That module is the SEMANTIC OWNER of "is this draft held"; this read
    // path composes its openFlagExistsSql fragment (#730).
```

Query: replace

```
        EXISTS (
          SELECT 1 FROM flagged_responses f
          WHERE f.response_id = resp.id AND f.status = 'open'
        ) AS held
```

with

```
        ${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held
```

(build the fragment with the client executing the query — here `sqlRead`).

- [ ] **Step 2: past-replies/draft-status — rewrite**

Same treatment: the D6 sentence becomes "composes its openFlagExistsSql
fragment (#730)"; the projected EXISTS becomes
`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held` (this query's
correlated ref is the unaliased table: `responses.id`).

- [ ] **Step 3: regen entry ~327, run, commit**

```bash
pnpm ci:tenant-scope 2>&1 | tail -30   # fails naming past-replies/draft-status; paste new snippet
pnpm vitest run "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies
git add -A && git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
```

(The reviews route has no allowlist entry — it binds `resp.business_id`; only
the past-replies entry regenerates. Update any route-test assertions that
pinned `FROM flagged_responses` in the OUTER captured text — the fragment now
registers its own captured call.)

### Task 5: Migrate the dashboard trio + regen 4 entries (~1509/1516/1530/1537)

**Files:**
- Modify: `src/lib/dashboard/service.ts:253-256`
- Modify: `src/lib/dashboard/aggregate-service.ts:404-407`
- Modify: `src/lib/dashboard/pending-count.ts:17-20,45-48`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries)
- Check: `src/lib/dashboard/__tests__/` for text assertions

- [ ] **Step 1: service.ts + aggregate-service.ts**

Both LATERALs keep their two comments (tenant-scope + held-drafts rationale);
the filter block

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
query's in-scope client variable).

- [ ] **Step 2: pending-count.ts — BOTH spellings**

In `getPendingApprovalCount` and `getPendingApprovalCountsForAccount`:

```
      AND NOT EXISTS (
        SELECT 1 FROM flagged_responses fr
        WHERE fr.response_id = resp.id AND fr.status = 'open'
      )
```

becomes

```
      AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
```

Import `openFlagExistsSql` in all three files.

- [ ] **Step 3: regen entries, run, commit**

```bash
pnpm ci:tenant-scope 2>&1 | tail -40   # 4 mismatches: service ×2, aggregate ×2 — paste each
pnpm vitest run src/lib/dashboard
git add -A && git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
```

(pending-count has NO allowlist entry — its queries are directly scoped;
confirm `ci:tenant-scope` passes without adding one.)

### Task 6: `agents/read.ts` — anti-join → NOT EXISTS (parallel-safe with T3–T5)

**Files:**
- Modify: `src/lib/agents/read.ts:317-334` (`getReviewTimeline` response query)
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

New (semantics-preserving: LEFT JOIN + `fr.id IS NULL` ⇔ NOT EXISTS; add a
one-line comment naming invariant #4 + the owner module):

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
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/agents/__tests__/read.integration.test.ts
git add -A && git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
```

(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched. No
allowlist work in this task, which is what makes it parallel-safe.)

### Task 7: Verify gate

- [ ] `cd <worktree> && bash scripts/verify-gate.sh` — full run, all rows PASS;
  `promised-tests` finds all five titles; `reclassify` inside 2× both buckets.
- [ ] Fix fallout (each fix re-runs the gate); on the same failure class twice,
  STOP per the anti-thrash rule.
- [ ] Final pre-review run: `bash scripts/verify-gate.sh --review`
  (diff-coverage row on).

---

## Self-review (done at write time)

- **Spec coverage:** #725 §2's four "Concretely for #730" bullets → T2 (fragment
  + hasOpenFlag + no new helpers), T3–T6 (both usage modes at all 8 spellings);
  §3 divergence sink → T2 step 3; #730's "divergence recorded" → same; #725
  notes 1–5 → allowlist regen steps (T3/T4/T5), stale-#680-comment rewrites
  (T3/T4), pending-count both spellings (T5), net-negative expectation
  (intake), verification commands (intake + T1/T3/T6).
- **Placeholder scan:** the two integration-test bodies are deliberately
  structure-locked with elided seed lines (the suite's own helpers are the
  precedent to follow, per anti-slop "precedent over invention") — each names
  the exact fixture/helper to crib and locks title + assertion shape. No TBDs.
- **Type consistency:** `openFlagExistsSql(db, ref)` spelled identically in
  T2–T6; ref always the executing client's fragment.
