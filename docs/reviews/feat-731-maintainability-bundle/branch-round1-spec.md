# #731 maintainability bundle — round 1, spec & correctness review

**Axis:** spec fidelity + correctness. (A sibling agent owns standards/maintainability.)
**Diff under review:** `git diff 3887707d..HEAD` (fork point = `origin/main` @ `3887707d`; `git merge-base origin/main HEAD` agrees).
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle`
**Reviewed:** 2026-08-09. Read field-by-field against `.feature/intake.json` (not memory), plus the plan, the triaged deviations D1–D8, the blast radius, and `CONTEXT.md:30-31`.

---

## Verdict

**PASS with one medium finding.** All four in-scope items land, the contract's
`user_visible_behavior`, `invariants` and `edge_cases` are satisfied, all 14
`tests_to_add` titles exist with bodies that test their claims, and there is
**zero drift outside `allowed_edit_surface`** (`ci:feature-surface` reports "18
changed file(s) within the declared surface"). The one medium finding is not a
correctness defect: the merged denominator query returns the right numbers, but
the comment that justifies its *shape* is empirically false and the shape it
chose costs a measurable, avoidable amount of query time.

---

## Findings

| # | Severity | Location | Finding |
|---|---|---|---|
| F1 | **medium** | `src/lib/past-replies/load-replies.ts:316-318` (rationale) + `:330-346` (query) | The comment's central design claim — "The posted-reply EXISTS is evaluated ONCE per review in the LATERAL … spelling it twice would plan two correlated subqueries per row" — is false. Postgres pulls the single-row LATERAL up and plans **two** correlated SubPlans, one per `COUNT(*) FILTER` reference, with a plan **byte-identical in cost** to spelling the EXISTS twice. The construction also forfeits the hash semi/anti-join the two deleted queries got: planner cost 332,369 vs ~1,487, and 48.4 ms vs 3.5 ms at 20,000 reviews for one location. |
| F2 | low | `src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts:193-202` | `'never leaks the raw review id into the fail-open log'` is now **vacuous** — the rewired enforcer emits no log of its own, the suite fully mocks `@/lib/costs/tracker`, and `beforeEach` clears `mockWarn`, so `mockWarn.mock.calls.length` is always `0` and the `if` body executes zero assertions. It executed a real assertion before this diff, and nothing replaces it: `regen-budget-batch.test.ts` neither mocks the logger nor asserts on the warn payload. The "no raw review id in the peek-failure log" guarantee now has no coverage anywhere. |

Nothing else met the ≥80 % confidence bar. Speculative observations are in the
appendix and are deliberately **not** in the table above.

---

### F1 — the CROSS JOIN LATERAL does not do what its comment says, and costs ~14× the plan it replaced

**Shipped SQL** (`load-replies.ts:330-346`):

```sql
SELECT
  COUNT(*) FILTER (WHERE NOT posted.has_reply)::int AS unanswered_total,
  COUNT(*) FILTER (WHERE posted.has_reply)::int     AS answered_total,
  AVG(r.star_rating)::float                         AS avg_star_rating
FROM reviews r
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted'
  ) AS has_reply
) posted
WHERE r.business_id = ${locationId}
```

**Shipped rationale** (`:316-318`):

> The posted-reply EXISTS is evaluated ONCE per review in the LATERAL and
> consumed by both FILTERs; spelling it twice would plan two correlated
> subqueries per row.

**Measurement.** Postgres 16 (the repo's own `repworth-testdb` image), temp
tables carrying the production-shaped partial index
`UNIQUE (review_id) WHERE status = 'posted'` (= `responses_one_posted_per_review`,
migration 031), 20,000 reviews for the target location and 10,000 posted
responses, `ANALYZE`d:

| Shape | Planner cost | `EXPLAIN ANALYZE` exec | Plan |
|---|---|---|---|
| **A — shipped merged LATERAL** | 332,369.67 | **48.4 ms** | Seq Scan on `reviews` + **SubPlan 1** *and* **SubPlan 3**, each `loops=20000` |
| **B — EXISTS spelled twice, no LATERAL** | **332,369.67** | 18.5 ms* | *identical plan to A*, same two SubPlans |
| C — `LEFT JOIN … AND p.status='posted'` + `FILTER (WHERE p.review_id IS NULL)` | 1,570.86 | 3.5 ms | Hash Left Join |
| D — deleted `NOT EXISTS` count | 1,487.45 | 3.6 ms | Hash Right Anti Join |
| E — deleted `EXISTS` count | 1,398.70 | 2.7 ms | Hash Semi Join |

\* A and B differ only in warm-cache noise; the plans and costs are identical.

Two conclusions, both load-bearing:

1. **The LATERAL buys nothing.** Row A and row B are the same plan at the same
   cost. `pull_up_simple_subquery` inlines a single-row, no-`FROM` LATERAL and
   substitutes `has_reply` into both `FILTER` expressions; each reference then
   gets its own SubPlan. The stated reason for choosing this construction — CSE
   of the EXISTS — does not happen. The comment will actively mislead the next
   person who reshapes this query.
2. **The merge traded a hash join for 2N correlated index probes.** The two
   deleted counts planned as Hash Anti/Semi Joins (one hash build over the
   location's posted responses). The shipped form does two index-only probes per
   review: 40,000 probes at N=20,000. Because the old pair ran concurrently
   inside `Promise.all`, wall-clock for the denominators went from ~3.6 ms to
   ~48 ms — roughly **14×** — on a server-rendered authenticated page.

**Scale honesty.** At a more typical post-import volume of 2,000 reviews the
numbers are 1.52 ms (shipped) vs 0.21 ms (old anti) vs 0.33 ms (LEFT JOIN). The
absolute regression at plausible volumes is single-digit milliseconds, well
inside the PgBouncer `statement_timeout`. This is why the finding is **medium**,
not high: it is a needless cost, not a broken page. It nonetheless sits against
the contract's `user_visible_behavior` line "No other observable change", and it
grows linearly in N while the shape it replaced did not.

**Remedy direction (not implemented — this review is read-only).** Shape C above
preserves everything item 2 was for and costs what the old queries cost:

```sql
SELECT COUNT(*) FILTER (WHERE p.review_id IS NULL)::int     AS unanswered_total,
       COUNT(*) FILTER (WHERE p.review_id IS NOT NULL)::int AS answered_total,
       AVG(r.star_rating)::float                            AS avg_star_rating
FROM reviews r
LEFT JOIN responses p ON p.review_id = r.id AND p.status = 'posted'
WHERE r.business_id = ${locationId}
```

The partition stays arithmetically closed (`IS NULL` / `IS NOT NULL` over the
same column is total and never NULL-valued), and **no row multiplication is
possible** because `responses_one_posted_per_review` is `UNIQUE (review_id)
WHERE status = 'posted'` — at most one match per review, which is the same index
the shipped SubPlans probe. The scoping conjunct is unchanged, so the
`tenant-scope-allowlist` entry would need only its `sqlSnippet` regenerated (the
`category` and `reason` are unaffected). If the owner prefers to keep the
LATERAL, the fix is at minimum to correct the comment — the current text asserts
a planner behaviour that does not exist.

---

### F2 — a fail-open log assertion went dead

Before this diff, `enforceRegenBudgetForReview` owned its own `catch` and logged
through `createWorkerLogger`, which the suite mocks at `:13-16`. The test drove
`mockPeekRegenBudget.mockRejectedValue(...)`, the enforcer logged, `mockWarn` had
one call, and `expect(JSON.stringify(logged)).not.toContain(REVIEW_ID)` ran.

After the rewire the log lives in `peekRegenBudgetBatch`, and this suite replaces
that entire module (`vi.mock('@/lib/costs/tracker', …)`, `:23-25`) with a `vi.fn`
that returns `new Map()`. So no logger call occurs anywhere in the path,
`beforeEach`'s `vi.clearAllMocks()` (`:43-44`) guarantees the count is 0, and the
`if (mockWarn.mock.calls.length > 0)` body never runs. The test cannot fail for
any implementation.

D6(c) records that this title "stays assertion-conditional-on-a-log by design",
which is accurate as far as it goes — but the condition is now *permanently*
false rather than merely weak, and the diff did not re-home the pin. The
surviving production log is in fact clean (`{ event, peek, subject_count,
reason }` — no review id), but `reason` is `err.message` from an ioredis command
failure, which is exactly the kind of string a client library could one day
decide to decorate with the failing key. The cheapest replacement is a
`vi.mock('@/lib/shared/logger', …)` + payload assertion inside
`regen-budget-batch.test.ts`'s existing fail-open case, which already drives a
real `mget` rejection.

---

## Contract audit — field by field against `.feature/intake.json`

### `allowed_edit_surface` — no drift

`ci:feature-surface` → `passed (18 changed file(s) within the declared surface)`.
Manually confirmed against the diffstat: every one of the 18 paths falls under a
declared tree. `CONTEXT.md` is declared but untouched — permitted, and correct,
since nothing in the diff changes a glossary term (the axes model, the Action
slot and On-demand generation are all untouched; ADR 0018 gets an addendum, not
a revision).

The two intake copies are byte-equal after `jq -S` normalisation
(`.feature/intake.json` vs `docs/superpowers/plans/feat-731-maintainability-bundle-intake.json`),
so the committed audit copy is not drifting from the arming copy.

### `user_visible_behavior`

| Claim | Verdict |
|---|---|
| "'N of M' and the Answered/Unanswered denominators can no longer disagree … All three figures now come from one snapshot" | **HOLDS.** One `Promise.all` element, one aggregate. `EXISTS` is boolean-valued and never NULL, so `NOT has_reply` / `has_reply` is a total partition; `unanswered + answered ≡ COUNT(*)` by construction. Confirmed empirically (below). |
| "No other observable change. Items 1, 3 and 5 are behaviour-preserving by construction" | **HOLDS for items 1, 3, 5.** Item 2 carries the unadvertised plan regression in F1. |

### `invariants`

| Invariant | Verdict | Evidence |
|---|---|---|
| #4 — held is CARRIED not filtered; item 2 must not touch the draft LATERAL or the main row query | **HOLDS** | The `load-replies.ts` diff is confined to the destructure (`:166`), the comment block (`:148-152`, `:304-327`) and the denominator template. The main row query — including the `draft` LATERAL with `COALESCE(draft.held, false)` and `openFlagExistsSql` — is byte-identical. `deriveRowAction`'s `posted × held → 'none'` and `none × held → 'none'` cells are untouched in `replies-view.ts`. |
| #8 — merged query scoped by `r.business_id = locationId`, resolved for the account before any responses existence test | **HOLDS** | `:112-126` gates on `b.id = ${locationId} AND b.account_id = ${accountId}` and `if (!biz) return null` **awaits before** the `Promise.all`, so the denominators are unreachable for a non-owned location. Allowlist entry keeps `category: 'tenant-root-lookup'` and its reason text verbatim. |
| #13 — no new flag, no `NEXT_PUBLIC_*` companion | **HOLDS** | `ci:static-policy` passes; the only flag touched is a retired one, and only its test set/restore. |
| D-F / D10 — the advisory peek fails OPEN; the only fail-open path is an absent Map entry, still logged on `regen_budget_peek_failed` | **HOLDS** | `tracker.ts:399-414`: `getCacheRedis()` **and** key building are inside the `try`; the `catch` warns `{ event: 'regen_budget_peek_failed', peek: 'batch', subject_count, reason }` and returns the partially-empty `out` Map. `dashboard-regen-rate-limit.ts:102-104`: `status === undefined ⇒ return null`. Absent-KEY vs absent-ENTRY cannot be confused: the per-id loop (`:416-424`) is reached *only* when the MGET resolved, and `Number.parseInt(raw[i] ?? '', 10)` → `NaN` → `used = 0` → `remaining = limit > 0`, so **no path can 429 during an Upstash outage**. |
| The advisory peek never rejects and never increments | **HOLDS** | No `incr`/`eval`/`pipeline` in the function; asserted at `regen-budget-batch.test.ts:110-112` and `:170-178`. Both call sites (`load-replies.ts:371`, `dashboard-regen-rate-limit.ts:102`) are catch-free, correctly. |
| The authoritative Lua INCR gate untouched | **HOLDS** | `tracker.ts`'s only change is the deletion of `peekRegenBudget` (14 lines) plus the batch doc comment. `checkRegenBudget` / `enforceRegenBudget` / `checkAskRegenBudget` and the Lua script are unmodified. |
| Orphan rows mapped from `orphan_*`, never `resp.*`; `failed_response_id` stays populated (round-2 Defect A) | **HOLDS** | `orphanReplyFacts` (`:260-269`) reads only `orphan_failed_response_id` / `orphan_posting_error` / `superseded_text`; `failed_response_id: r.orphan_failed_response_id`. Pinned by two of the six new titles. |
| The re-split is safe only because the slice type makes omission a compile error | **HOLDS** | `ReplyFacts = Required<Pick<ReviewsListRow, …7 fields>>`. `version`, `failed_response_id`, `failed_posting_error` are `?` on `PastReplyRow` (`PastReplyCard.tsx:50,55,56`), so `Required<>` is genuinely load-bearing. `pnpm typecheck` clean. |
| Allowlist may only SHRINK, 409 → 408, two out one in | **HOLDS** | `ALLOWLIST_BASELINE = 408`; two `load-replies.ts` COUNT entries deleted, one merged entry added. `pnpm ci:tenant-scope` → `passed — entries: 408 (baseline: 408)`, which also proves the new `sqlSnippet` matches the shipped SQL under the audit's own `normalizeSql(stripSqlComments(…))` (multi-space alignment in the template collapses correctly). |
| `reviews.sentiment_*` untouched | **HOLDS** | No review-content write site in the diff. |

### `edge_cases`

| Edge case | Handled | Where |
|---|---|---|
| Orphan: `response_id`=`orphan_failed_response_id`, `approved_text`=`superseded_text`, `posted_at`/`approval_method`/`version` null | ✅ | `replies-view.ts:260-269`; tests at `replies-view.test.ts:205,255` |
| Posted row with a `delete_failed_*` sidecar comes from `fail_sidecar`, not the orphan LATERALs | ✅ | `liveReplyFacts:288-290`; test at `:239` |
| Never-replied (`reply_state 'none'`): every reply-fact null, no recovery affordance | ✅ | shared `liveReplyFacts` branch; test at `:295` |
| `version` present but not a number → null | ✅ | `typeof r.version === 'number' ? r.version : null` (`:285`), carried verbatim. Orphan hard-nulls it, so the guard is only needed on the live branch — correct. No dedicated test, and none was promised. |
| `provenance_badge` from the DISPATCHED `approval_method` | ✅ | `facts.approval_method` at `:344`; test at `:281` |
| Zero-review location returns ONE row (0 / 0 / NULL) | ✅ | Verified against live Postgres 16 directly and by the new integration title; `totalPages` clamps to 1 |
| Review with MULTIPLE posted responses counts once (EXISTS, not join) | ✅ (void as written, covered in substance) | D3(b) is right that ≥2 *posted* rows is barred by `responses_one_posted_per_review`. The distinguishing case is a posted row **plus non-posted siblings**, and that IS pinned — the shared `businessId` fixture gives three reviews a posted response *and* a replacement draft (`load-replies.integration.test.ts:220-238`), so a `JOIN responses` + `FILTER (WHERE p.status='posted')` regression would push `u + a` to 10 against a `COUNT(*)` of 7 and fail `:437`. Independently confirmed with a CTE probe: one review with `posted` + `failed` + `draft` siblings yields `u=2, a=1, total=3`. |
| MGET fails for the route's single-review peek → empty Map → `null` after logging | ✅ | Test at `:177`; log at `tracker.ts:405-411` |
| Absent Redis KEY still yields `{ used: 0, … }` | ✅ | Test at `regen-budget-batch.test.ts:154` |
| Empty `reviewIds` short-circuits; the route never passes zero | ✅ | `tracker.ts:397`; test at `:145-148`; the route always passes `[reviewId]` |
| Publisher `originalEnv` snapshot/restore stays balanced | ✅ | 4 keys captured (`:43-49`), 4 restored (`:312-331`). Suite runs green against the live DB: **9/9 passed**. |

### `tests_to_add` — all 14 present, all bodies match their titles

| # | Title | Present | Body tests the claim |
|---|---|---|---|
| 1 | orphan mapped from `orphan_*`, never `resp.*` | `replies-view.test.ts:205` | ✅ populates `resp.*` + `fail_sidecar` with `must-not-leak` sentinels and asserts `JSON.stringify(card)` excludes them |
| 2 | `failed_response_id` populated on an orphan | `:230` | ✅ asserts the value **and** `row_action === 'recover'` |
| 3 | posted row from `resp.*` + own `delete_failed_*` sidecar | `:239` | ✅ |
| 4 | orphan nulls `posted_at`/`approval_method`/`version` | `:255` | ✅ sets all three on the input row first, so the nulls are earned |
| 5 | `provenance_badge` from dispatched `approval_method` | `:281` | ✅ `AUTO_POLICY` on the row → badge `null` |
| 6 | never-replied row, no reply facts, no recovery affordance | `:295` | ✅ |
| 7 | ONE denominator query, one snapshot | `reviews-list.test.ts:364` | ✅ counts row-producing shapes → 2, pins `COUNT(*) FILTER` + `AVG(` on the same call, and pins all three returned figures |
| 8 | `u + a` equals the location review count exactly | `load-replies.integration.test.ts:437` | ✅ live DB, compares against an independent `COUNT(*)` |
| 9 | posted review counts once as answered, never also unanswered | `:455` | ✅ for the title as written (see the comment nit in the appendix) |
| 10 | zero-review location → one row, `avgStarRating` null | `:494` | ✅ dedicated empty business, also pins `totalPages === 1` |
| 11 | proceeds when the batched peek returns no entry | `dashboard-regen-rate-limit.test.ts:177` | ✅ and pins `toHaveBeenCalledWith([REVIEW_ID])`, closing D3(c) |
| 12 | 429 `regen_limit_reached` at zero remaining | `:159` | ✅ status, body, `no-store` |
| 13 | proceeds when remaining > 0 | `:150` | ✅ plus the call-shape pin |
| 14 | `peekRegenBudgetBatch` never rejects | `regen-budget-batch.test.ts:131` | ✅ three failure modes: async rejection, **synchronous** throw, empty input |

### `non_goals` — none violated

Item 4-of-five (retype `PastReplyRow.row_state`) is correctly absent; the symbols
do not exist. The fail-open posture is preserved (see invariants). The Lua INCR
gate is untouched. The denominators were **not** folded into the main row query
via window functions. `toCardRow`'s dispatch input is still `reply === 'orphan'`.
No migration, no flag, no env var, no dependency (`dependencies_added: []` — and
`git diff` shows no `package.json`). The Reviews list surface, route and
`PastReplyCard` props are unrenamed.

### `observability`

`subject_count: 1` does discriminate the route path from the page-sized batch,
and the `[DashboardRegenBudget]` prefix + `route` field are gone as declared.
F2 is the cost of that consolidation that the contract did not anticipate.

### `rollback_plan`

Accurate. A plain revert restores `ALLOWLIST_BASELINE` 408 → 409 and both COUNT
entries in the same commit, so `ci:tenant-scope` stays green across the revert;
nothing was written to either Supabase project.

---

## Blast-radius check — callers vs changed semantics

The brief's highest-value item: `enforceRegenBudgetForReview`'s internals changed
from a throwing peek + `catch` to a never-rejecting batched peek. **The blast-radius
doc over-lists the callers** — it names three route files, but
`src/app/api/dashboard/past-replies/draft/route.ts:50` imports only
`enforceDashboardRegenRateLimit` (the per-owner limiter), never
`enforceRegenBudgetForReview`. The real production callers are **two**:

| Caller | Depended on the old shape? |
|---|---|
| `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts:31` | **No.** `const capped = await enforceRegenBudgetForReview(reviewId); if (capped) return capped;` — consumes only `NextResponse \| null`, and the return-type contract is unchanged. No `try`/`catch` around it, which is now *more* correct than before (the function could previously only reject if the enforcer's own catch had been removed). |
| `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:90` | **No.** Same orchestration shape. |
| `src/lib/past-replies/load-replies.ts:371` (batch caller, unchanged) | **No.** Already catch-free, already treats an absent Map entry as UNKNOWN (`PastReplyCard.tsx` `regenBudget?` documents `undefined ⇒ render no counter, keep the button enabled`). |

Both route test suites mock `enforceRegenBudgetForReview` itself, so the
internals swap is invisible to them — correct, and it means no route suite was
silently weakened. No file anywhere still references `peekRegenBudget`.

For `replies-view.ts`: `PastRepliesClient.tsx` / `PastReplyCard.tsx` consume the
18-key wire shape, which is pinned exactly (`replies-view.test.ts:465-474`) and
unchanged — the `...facts` spread reorders object keys but adds and removes none,
and no consumer depends on key order. For `load-replies.ts`: the returned
`PastRepliesPageView` field names and types are identical; #747's concurrent edits
to `history/page.tsx` and `PastRepliesClient.tsx` (merged in at `c7d66d29`) do not
read the denominators differently.

---

## Deviation resolutions — independently re-verified, not taken on trust

| # | The plan was wrong about… | Resolution sound? |
|---|---|---|
| D3(a) | `REVIEW_STATUS.RESPONDED` | ✅ `REVIEW_STATUS.POSTED` is the real member and matches the suite's own fixtures. |
| D3(b) | "two posted rows for one review" is seedable | ✅ `responses_one_posted_per_review` bars it. And the substantive case (posted + non-posted siblings) turns out to be covered by the sibling test — see the `edge_cases` table. Keeping the one-row fixture rather than branching around an impossible state was the right call. |
| D3(c) / D6(c) | 2 of 4 enforcer titles were green for the wrong reason | ✅ Title 11 now carries `toHaveBeenCalledWith([REVIEW_ID])`, so it distinguishes rewired-correctly from swallowing. Title 14 (`never leaks…`) was left assertion-conditional — and that is exactly F2. |
| D4 | `grep -A2 'orphanReplyFacts'` as the `Required<>` proof | ✅ TS anchors assignability errors at the literal. I re-verified the guarantee independently: `pnpm typecheck` is clean, and `Required<>` demonstrably strips the three `?` fields (`Pick<>` alone would not). |
| D5(a) | the AVG-title landmine | ✅ **Highest-signal entry, and the fix is strictly stronger than what it replaced.** Both original assertions are re-applied verbatim to the LATERAL-stripped text, plus two positive `FROM`/`WHERE` pins. I checked the strip regex: `/CROSS JOIN LATERAL \([\s\S]*?\) posted/i` — the lazy quantifier's first `) posted` match is the LATERAL's own alias, not the inner `'posted'` literal (which is never preceded by `") "`), so the whole LATERAL including its `'posted'` is removed. Correct. |
| D5(b) | `ci:tenant-scope` prints the snippet it wants | ✅ `TenantScopeFinding` has no SQL field. Deriving via the audit's own `extractSqlTemplates` + normaliser was right, and the result verifies: 408/408. |
| D6(a)/(b), D7 | grep gates that forbid a string forbid it in prose | ✅ Both resolutions are defensible, and the asymmetry is right: D6 drops the identifier for a *completed* consolidation; D7 keeps it because the comment's job is to warn a reader off re-adding a retired flag. I confirmed no suite anywhere depends on `PAST_REPLIES_VIEW_ENABLED` being **set** — every remaining test reference `delete`s it. |
| D8 | measuring against bare `origin/main` | ✅ I used `3887707d` / `merge-base` throughout. `comm -12` disjointness and the clean merge hold. |

---

## Verification run in this review

| Command | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm ci:tenant-scope` | `passed — entries: 408 (baseline: 408)` |
| `pnpm ci:feature-surface` | `passed (18 changed file(s) within the declared surface)` |
| `pnpm ci:static-policy` | `passed (1129 files)` |
| `pnpm ci:process-env` | `passed (baseline 9)` |
| `pnpm ci:live-db-suites` | `passed` |
| `pnpm ci:db-imports` | `passed (strict)` |
| `pnpm ci:config-coverage` / `ci:rls-audit` | `passed` |
| `vitest run` over `src/lib/past-replies src/lib/costs src/lib/shared src/components/dashboard/reviews src/app/api/dashboard` | **1668 passed**, 207 skipped (DB-gated), 0 failed |
| `vitest run --project integration src/lib/past-replies/__tests__/load-replies.integration.test.ts` with `TEST_DATABASE_POOL_URL` | **10/10 passed** |
| `vitest run --project integration worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts` with `TEST_DATABASE_POOL_URL` | **9/9 passed** (item 4's flag removal does not break the hard-gate suite) |
| Merged denominator SQL executed directly against Postgres 16 | valid; zero-review location → **one** row `0 / 0 / NULL` |
| CTE probe: review with `posted` + `failed` + `draft` siblings | `u=2, a=1, avg=4, total=3` — EXISTS counts the review once |
| `EXPLAIN ANALYZE` matrix at 2,000 and 20,000 reviews | see F1 |

---

## Low-confidence appendix — deliberately NOT in the findings table

> **ORCHESTRATOR TRIAGE OF THIS APPENDIX (round 1):** items 1, 3, 4, 5 and 6
> noted, none actioned — see the triage section at the end of this file for
> reasoning. Item 2 (the ADR's stale line citation) **was** fixed, because a
> citation that points at the wrong line is exactly the cross-reference rot the
> house rules forbid. Note that appendix item 1's comment became *moot* rather
> than fixed: the fix round replaced the EXISTS with a join, so the comment it
> criticised no longer exists.

1. **`load-replies.integration.test.ts:462-467` — the comment's rationale is not
   exercised by its own fixture.** The comment says "were it a join, the review's
   other non-posted siblings would each contribute a row and inflate the
   denominator past `COUNT(*)`", but this test seeds exactly one response row and
   no sibling, so a join regression would pass *this* title. It is not a coverage
   gap in the branch (the `u + a == COUNT(*)` title at `:437` runs over a fixture
   where three reviews *do* have posted + draft siblings and would catch it), so
   this is a comment-locality nit, not a missing test. Adding one
   `status='failed'` sibling here would make the comment true of the test it sits
   on.
2. **ADR 0018 addendum cites `replies-view.ts(257,3)`.** The `return {` of
   `orphanReplyFacts` is now line **260** — commit `8cd0a58a` (the TS2739→TS2741
   correction) added three comment lines above it. Stale by three lines; the
   error code and the field named are right.
3. **`load-replies.ts:148-150` says "THREE queries in the whole page load".**
   True for SQL. A reader might miscount because `openFlagExistsSql(sql, …)`
   builds a fourth tagged template (a *fragment*, spliced into the main query,
   which is exactly what `reviews-list.test.ts`'s `rowProducingQueries` exists to
   discount). Accurate as written; noting it only because the same ambiguity is
   what the Q3 helper was built for.
4. **`regen-budget-batch.test.ts` does not mock `@/lib/shared/logger`**, so its
   two fail-open titles emit a real `[RegenBudgetPeek]` JSON warn line to test
   stdout. Pre-existing, cosmetic, and it is also the natural home for F2's
   replacement assertion.
5. **`user_visible_behavior`'s phrasing "the page rendered more rows than its own
   page count admitted"** describes the double-count direction loosely; the
   under-count direction manifests instead as an unreachable tail page
   (`totalPages` deflated by one at a 50-boundary). The underlying defect and its
   fix are both real; only the symptom sentence is imprecise.

---

# Orchestrator triage — round 1 (2026-08-09)

**F1 (medium — merged query is a plan regression and its rationale is false): ACCEPTED, FIXED in `27a57cc2`.**
The `CROSS JOIN LATERAL … EXISTS` is replaced by `LEFT JOIN responses p ON p.review_id = r.id AND p.status = 'posted'` with `COUNT(*) FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`. Re-measured independently during the fix round on the same container: LATERAL cost **332,820.50** / **61.5 ms** with SubPlan 1 *and* SubPlan 3 each at `loops=20000`, versus LEFT JOIN cost **1,274.27** / **4.8 ms** as a **Hash Right Join** — ~261× planner cost, ~13× execution. Both shapes returned byte-identical results (`10000 / 10000 / avg 3 / total 20000`), which independently demonstrates the join does not multiply rows.

The rewritten rationale deliberately makes **no planner claim at all** — an unverifiable assertion about subplan counts was the root of this finding — and states only two checkable facts: a LEFT join preserves every review so the `IS NULL` / `IS NOT NULL` split is total, and `responses_one_posted_per_review` (migration 031) bars fan-out.

This is the most valuable result of the review. Both axes reached it independently from different directions, which is what overrode an earlier inclination to keep the LATERAL on robustness grounds — that instinct (EXISTS is cardinality-agnostic, the join depends on an index) was not wrong in principle, but it was arguing for a 13× slowdown against a dependency the main row source 160 lines above *already* relies on for the same reason.

**F2 (low — vacuous privacy test): ACCEPTED, FIXED in `27a57cc2`.**
Coverage was **moved to where the log now lives** rather than patched in place: `regen-budget-batch.test.ts` gains `'the peek-failure warn carries subject_count and never a review id'`, which mocks `@/lib/shared/logger`, drives a real MGET rejection, and asserts unconditionally that the payload is exactly `{event, peek, reason, subject_count}` with neither review id present. The vacuous test was then **deleted** rather than salvaged: its `if (mockWarn.mock.calls.length > 0)` body could not execute under any implementation, and a test that cannot fail is worse than no test. Its title is not among the 14 locked `tests_to_add` — verified against `.feature/intake.json` before removal — so `promised-tests` is unaffected. Non-vacuity of the replacement is structural: its first assertion is `expect(mockWarn).toHaveBeenCalledTimes(1)`, exactly the condition the deleted test could never reach.

## Appendix disposition

| Item | Verdict |
|---|---|
| 1 — comment's rationale not exercised by its own fixture | **MOOT.** The fix round replaced the EXISTS with a join, so the criticised comment no longer exists. The `u + a == COUNT(*)` title at `:437` remains the real guard. |
| 2 — ADR cites `replies-view.ts(257,3)`, now line 260 | **FIXED.** A citation pointing at the wrong line is the cross-reference rot the house rules forbid. |
| 3 — "THREE queries" could be miscounted because a fragment builds a fourth template | **NOTED, not actioned.** The statement is true of SQL queries, which is what it claims. #730's lab note already owns the fragment-vs-query distinction. |
| 4 — imprecise symptom sentence in `user_visible_behavior` | **NOTED, not actioned.** A wording nit in a locked contract field; retro-editing a shipped intake's prose is worse than an accurate-in-substance sentence. |
| 5 — `RegenBudgetStatus.remaining` is redundant (`= max(0, limit - used)`) | **NOTED, out of scope.** Entirely pre-existing and untouched; the client renders all three. |
| 6 — window functions in the row source, considered and rejected by the reviewer | **AGREED, and it matches the intake's own non-goal.** Recorded in two places now so a future reviewer does not re-litigate it. |

## Two corrections this axis made to MY artefacts — both accepted

1. **`blast-radius.md` over-lists the `enforceRegenBudgetForReview` callers.** `past-replies/draft/route.ts` imports only `enforceDashboardRegenRateLimit`, so there are **two** production callers, not the three I stated when dispatching the review. Neither depended on the old throwing shape, so the conclusion is unchanged. The script's own header declares it a heuristic import-text search, so this is the tool behaving as documented rather than a defect — but the dispatching brief should have said "verify the list" instead of asserting the count.
2. **Deviation D3(b)'s "structurally unreachable" edge case is covered in substance.** The shared integration fixture gives three reviews a posted response **plus** a replacement draft, so a join-instead-of-EXISTS regression would fail the `u + a == COUNT(*)` title. Reassuring for F1's fix specifically, since that fix *is* "use a join instead of EXISTS" — the guard was already in place before the fix was written.

---

# Round 2 verification

**Scope:** verification-only. Confirms round 1's two accepted findings were
actually fixed and that the fix round introduced nothing new. No new fronts
opened against unchanged code (one untriaged observation is in the appendix).
**Diff base:** `3887707d` (= `git merge-base origin/main HEAD`) throughout — 20
changed files, no unrelated dashboard-design noise.
**Commits verified:** `27a57cc2` (the fix), `ed5bf612` (triage + 2 editorial),
`368c053d` (docs only). **Verified:** 2026-08-09. **Read-only** — no source file
edited; the only mutation was an isolated `r2bench` scratch schema on
`repworth-testdb`, dropped at the end (`pg_namespace` count 0 confirmed).

## Per-finding table

| Finding | Verdict | Evidence |
|---|---|---|
| **F1** — merged denominator was a plan regression with a false rationale | **VERIFIED FIXED** | `load-replies.ts:353-362` is the LEFT JOIN shape; zero `CROSS JOIN LATERAL` left in the file; reproduced **Hash Right Join** cost 2,124.38 / 9.7 ms vs the LATERAL's **SubPlan 1 + SubPlan 3, each loops=20000** at cost 172,670.41 / 24.0 ms |
| F1a — partition arithmetically closed, join cannot multiply | **VERIFIED** | Re-derived on live PG16: `10000 + 10000 = 20000 = COUNT(*)`; joined row count `= 20000` exactly; the fan-out trap (drop the ON-clause `status` predicate) yields **23,000** rows, so the predicate is load-bearing and the fixture exercises it |
| F1b — zero-review location returns ONE row `0 / 0 / NULL` | **VERIFIED** | Direct SQL against an unused `business_id`: 1 row, `0 / 0 / NULL`; and the live-DB title at `:494` passes |
| F1c — performance claim is real | **VERIFIED** | Hash join reproduced; **81× planner cost**, **2.5–3.3× warm exec**, **137× buffer accesses** (586 vs 80,206) at N=20,000. Magnitude differs from the fix round's 261×/13× (different fixture — see calibration note); direction and the hash join reproduce robustly across 3 runs |
| F1d — rewritten comment makes no unverifiable planner claim | **VERIFIED** | `:317-346` contains no subplan/cost/planner assertion. Its four claims are each independently checkable and each checked: LEFT-join totality (empirically closed), `responses_one_posted_per_review` = `UNIQUE (review_id) WHERE status = 'posted'` (`031_edit_existing_replies.sql:41-43`), non-posted siblings excluded by the ON clause (fan-out trap), "same shape as the main row source" (`:204-206`), and "the pre-#678 query INNER-JOINed" (`git show e447ee5b` — it was a bare `JOIN responses resp`, i.e. inner; the new wording is strictly more precise than round 1's "JOINed") |
| F1e — invariant #8 + allowlist unchanged | **VERIFIED** | `:111-127` still gates on `b.id AND b.account_id` and `if (!biz) return null` **awaits before** the `Promise.all`. `ALLOWLIST_BASELINE = 408`, still 2 `load-replies.ts` entries; `ci:tenant-scope` → `passed — entries: 408 (baseline: 408)`. The audit reports unused entries as findings (`findUnusedAllowlistEntries`), so a green run is positive proof the regenerated `sqlSnippet` matches the NEW SQL |
| **F2** — the privacy test was vacuous | **VERIFIED FIXED** | Vacuous title deleted (`dashboard-regen-rate-limit.test.ts:193-200` now carries only an explanatory comment); replacement lives at `regen-budget-batch.test.ts:140-173` |
| F2a — replacement is genuinely non-vacuous | **VERIFIED** | Every assertion is unconditional (no `if`). Mutation-reasoned: adding `review_ids` fails BOTH `Object.keys(logged).sort()` and `not.toContain(REVIEW_A)`; folding ids into `reason` fails `logged.reason).toBe('ECONNREFUSED')` and the `not.toContain` pair; removing the warn fails `toHaveBeenCalledTimes(1)`. Empirically wired, not just written — the suite is green, which is only reachable if `mockWarn` actually received the call the deleted test could never observe |
| F2b — deleted title not among the 14 locked `tests_to_add` | **VERIFIED** | Enumerated `.feature/intake.json`; the deleted string appears nowhere in it. All **14/14** locked titles still exist verbatim in `src/**` (per-title scan) — `promised-tests` unaffected |
| F2c — D-F fail-open posture intact | **VERIFIED** | Absent KEY: `tracker.ts:417-418` → `parseInt(null ?? '')` → NaN → `used = 0` → `remaining = 3`. Absent ENTRY: `:406-413` catch returns the empty map; `dashboard-regen-rate-limit.ts:102-105` → `status === undefined ⇒ return null`. Neither branch can reach the 429 — no path 429s during an Upstash outage |
| Editorial — ADR stale line number | **VERIFIED FIXED** | `0018-row-state-axes-projection.md` now cites no line number at all and says so deliberately ("an anchor into a file this ADR does not own goes stale") — stronger than re-pointing it at 260 |
| Editorial — `ReplyFacts` doc block dangling referent | **VERIFIED FIXED** | `replies-view.ts:232-234` now reads "deleting the `failed_response_id` line from `orphanReplyFacts` below … at that function's `return {`" — and `orphanReplyFacts` is genuinely below the type declaration |
| Regression — AVG title's `outsideLateral` regex surgery | **VERIFIED FIXED, no weakening** | `reviews-list.test.ts:412-416` pins exactly one `JOIN responses` and that it is `LEFT`. Discriminating: `INNER JOIN` passes the count but fails the LEFT pin; a second join fails the count; a reverted LATERAL matches `JOIN LATERAL` not `JOIN responses`, so the count drops to 0 and fails. Strength parity with the deleted assertions (neither old nor new catches a narrowing `WHERE p.review_id IS NOT NULL`, which titles 7–9 do catch) |
| Regression — two stale `NOT EXISTS` comments | **VERIFIED FIXED** | `load-replies.ts:163-165` and `replies-view.ts:367-369` now describe the merged `COUNT(*) FILTER (WHERE p.review_id IS NULL)`. The one surviving `NOT EXISTS` mention (`load-replies.ts:196`) is about #678's deleted orphan query — correctly left alone |
| Regression — `seedPostedResponse` gains `bizId` default | **VERIFIED, behaviour-preserving** | Five existing two-arg call sites (`:217,218,224,230,238`) fall through to `bizId = businessId`, byte-identical to the previous hardcoded value; the sixth (`:471`) is the new three-arg caller that replaced the hand-rolled duplicate INSERT. Live-DB suite **10/10** |

## Reproduced `EXPLAIN ANALYZE` (my own fixture, PostgreSQL 16.14, `repworth-testdb`)

Scratch schema `r2bench` replicating the production indexes
(`reviews (business_id, review_date DESC)`, `reviews (business_id, status)`,
`responses (review_id) WHERE status = 'posted'` UNIQUE, `responses (review_id, version)`
UNIQUE, `responses (status)`). Fixture: 20,000 reviews for the target location +
20,000 for a second location, 30,000 posted responses, **3,000 non-posted
siblings on already-answered reviews** (the fan-out trap) + 500 draft-only rows.
`ANALYZE`d. Three runs; steady-state (warm) figures below.

| Shape | Planner cost | Exec (warm) | Buffers | Plan |
|---|---|---|---|---|
| **Shipped LEFT JOIN** | **2,124.38** | **9.7 – 10.1 ms** | **586** | **Hash Right Join** (hash over the location's reviews, probe from `responses`) |
| Reverted CROSS JOIN LATERAL | 172,670.41 | 24.0 – 56.2 ms | 80,206 | Bitmap Heap Scan + **SubPlan 1 and SubPlan 3, each `loops=20000`** — round 1's core empirical claim reproduced exactly |
| pre-#731 `NOT EXISTS` count (deleted) | 2,218.12 | 8.7 ms | — | Hash Anti Join |
| pre-#731 `EXISTS` count (deleted) | 2,337.19 | 7.2 ms | — | Hash Semi Join |

Both shapes returned byte-identical figures (`10000 / 10000 / avg 3`, joined row
count `20000` = `COUNT(*)`), independently demonstrating no fan-out.

**Calibration note (not a finding).** My absolute numbers differ from the fix
round's (2,124 / 9.7 ms vs their 1,274 / 4.8 ms; 172,670 / 24 ms vs their
332,820 / 61.5 ms) because my fixture adds a second location and 3,500
non-posted rows, which enlarges the hash-build side and shrinks the per-probe
index cost. The **qualitative claims all reproduce**: the hash join, the two
SubPlans at `loops=20000`, and a large improvement on every axis. At a realistic
small volume (N=2,000, third location) the LEFT JOIN plans at 1,387.89 / 3.7 ms
against the LATERAL's 33,893.10 / 2.3 ms — i.e. marginally slower in warm wall
clock at small N, because the hash side seq-scans all posted `responses`
table-wide rather than only the location's. That is **not a regression the fix
introduced**: the pre-#731 pair it restores parity with had exactly the same
Seq-Scan hash side (8.7 ms + 12.1 ms across two round trips at N=2,000), so the
merged LEFT JOIN is faster than `main`'s baseline at both volumes and 2.5–3.3×
faster than the LATERAL at 20,000. Verified, not assumed.

## Verification commands run in round 2

| Command | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm ci:tenant-scope` | `passed — entries: 408 (baseline: 408)` |
| `pnpm ci:feature-surface` | `passed (20 changed file(s) within the declared surface)` |
| `pnpm ci:static-policy` | `passed (1129 files)` |
| `pnpm ci:live-db-suites` / `ci:db-imports` / `ci:rls-audit` / `ci:reviews-status` / `ci:response-status` / `ci:process-env` | all `passed` |
| `vitest run` over `src/lib/past-replies src/lib/costs src/lib/shared src/components/dashboard/reviews src/app/api/dashboard` | **1668 passed**, 207 skipped, 0 failed |
| `vitest run --project integration .../load-replies.integration.test.ts` (live DB) | **10/10 passed** — all three #731 denominator titles confirmed RUN, not skipped, via `--reporter=verbose` |
| `vitest run --project integration worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts` | **9/9 passed** (hard-gated suite) |
| 14/14 locked `tests_to_add` titles present verbatim | confirmed by per-title scan of `src/**` + `worker/**` |
| `EXPLAIN ANALYZE` matrix + fan-out trap + zero-review probe | see above; scratch schema dropped |

## New, untriaged (deliberately NOT a finding)

1. **The denominator's hash-build side is not location-scoped.** `LEFT JOIN
   responses p ON p.review_id = r.id AND p.status = 'posted'` names no
   `p.business_id`, so the planner's hash input is a Seq Scan over **every**
   posted response in the table, not the location's. Cost therefore tracks the
   global posted-response count rather than the location's review count. This is
   pre-existing in substance — the two pre-#731 `EXISTS`/`NOT EXISTS` counts
   planned identically — and it is the reason the LEFT JOIN loses by ~1.4 ms to
   the LATERAL at N=2,000 while winning by 14 ms at N=20,000. Recording it only
   so a future reader who measures a small location is not surprised; adding
   `AND p.business_id = r.business_id` would let the planner use
   `idx_responses_business_status_created`, but that is a new optimisation
   against unchanged semantics, not a round-2 finding, and it would need its own
   correctness argument (the redundant-predicate-vs-uniqueness interaction).

## Verdict

**PASS — all round-1 accepted findings VERIFIED FIXED, no regressions, nothing
new in scope.**
