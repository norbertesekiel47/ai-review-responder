# Spec & correctness review — round 1

**Branch:** `feat-757-dashboard-review-time-anchor`
**Diff:** `f5151902..HEAD` (24 files, 17 commits)
**Axis:** faithfulness to `docs/superpowers/plans/feat-757-dashboard-review-time-anchor-intake.json`
and the plan. Bugs, drift outside `allowed_edit_surface`, unnamed behavior, missing
`tests_to_add`, unhandled `edge_cases`. Repo standards and design/approach are owned by the two
sibling reviewers and are not duplicated here.
**Date:** 2026-08-11

---

## Findings (≥80% confidence)

| Severity | File:line | Finding |
|---|---|---|
| MEDIUM | `CONTEXT.md:34` | The locked Review-time-anchor glossary entry still asserts, in present tense, that "Time-to-respond carries the companion validity filter `approved_at >= detected_at`" — that filter (and the TTR metric itself) exists nowhere in `src`/`worker`/`scripts` after this branch, and ADR 0019's own addendum says Decision 3 is "recorded but no longer implemented in code". |
| LOW | `CONTEXT.md:34` | The same entry opens by naming **review volume MoM** as an anchored reputation KPI — that metric died with Stack A in this branch — while omitting velocity and rating breakdown, the two metrics the branch actually anchored. The entry's own closing clause (edited by this branch) lists the correct four, so the entry now contradicts itself. |
| LOW | `docs/currents.md:32,45` | The "state map … what is true now" (its own header, not a build log) still names `src/lib/kpi/service.ts` as the one owner of `reviewTimeAnchor`/`reviewTimeWindowFilter`, and still says the rendered dashboard "still buckets on `detected_at`" with "#757 (GA-blocking)" pending. `docs/currents.md` is not in the intake's list of docs that deliberately keep stale references (`non_goals`: only `docs/reviews/**/blast-radius.md` and the root `PLAN.md`), and it is not in `allowed_edit_surface` either — so the contract has a hole here, not just the branch. |

### Detail

#### 1. `CONTEXT.md:34` — TTR validity filter claimed but absent

`CONTEXT.md` is the domain-language doc, is inside `allowed_edit_surface`, and **this branch edited
this exact glossary entry** (it rewrote the trailing "One owner:" clause). The sentence left
untouched reads:

> Time-to-respond carries the companion validity filter `approved_at >= detected_at`, so a
> pre-existing Google reply imported by reconcile can never contribute a negative duration.

Verification:

```
rg -n "ttrHandledWindowFilter|approved_at >= detected_at" src worker scripts
→ NONE IN CODE
```

The filter shipped in `src/lib/kpi/service.ts` at #688 and was deleted with that file in commit
`7f05a0e9`. This is not an oversight of the change — it is a *recorded* consequence: ADR 0019's
#757 addendum says "Decision 3 (the TTR validity filter) is therefore **recorded but no longer
implemented in code**; it returns with the metric", and the intake's `non_goals` accepts dropping
the TTR-duration metric. `.claude/CLAUDE.md` was correctly updated to drop the TTR clause in the
same commit (`04c7b18f`). `CONTEXT.md` was the one doc where the neighbouring sentence was edited
and this one was not, so the glossary now describes a guarantee the codebase no longer provides.

**Failure scenario:** an agent implementing the deferred KPI-cards work reads CONTEXT.md (the
project's stated authority for locked terms), believes the negative-TTR class is already closed by
an existing filter, and ships a TTR metric with no validity filter — reintroducing exactly the
−2.9-year rows ADR 0019 §Context item 4 catalogued.

**Suggested minimal fix (in-surface):** re-tense the clause, e.g. "Time-to-respond *will* carry the
companion validity filter `approved_at >= detected_at` when the metric returns (ADR 0019 D3 —
recorded, not currently implemented: the metric died with Stack A at #757)."

#### 2. `CONTEXT.md:34` — metric list contradicts itself

Same entry, opening clause: "the timestamp the reputation KPIs (review volume MoM, 8-week sentiment
trend, avg star) bucket on". After this branch:

- **review volume MoM** does not exist anywhere (intake `non_goals`: "Preserving Stack A's
  calendar-month volume MoM … they have never rendered anywhere").
- **velocity** and **rating breakdown** — the two metrics the branch newly anchored on both scopes
  — are missing from the opening list.

The closing clause the branch *did* edit names the right four ("velocity, rating breakdown, avg
star and sentiment trend per-location, and velocity + rating breakdown in the All-Locations
aggregate"), so a reader gets two different answers from one glossary entry. `.claude/CLAUDE.md`'s
replacement bullet got this right; `CONTEXT.md` did not.

#### 3. `docs/currents.md:32,45` — state map contradicts the shipped state

`docs/currents.md` declares itself "**State map — newest at the top.** Plain-English per-feature
summaries of what is true now. This is NOT a build log (that's progresstracking.md)". Two claims in
the #688 entry are now false:

- `:32` — "`src/lib/kpi/service.ts` — `reviewTimeAnchor` / `reviewTimeWindowFilter` lazy fragments
  (one owner of the anchor)". The file is deleted; the owner is `src/lib/kpi/fragments.ts`
  (`CONTEXT.md` and `docs/directory.md` both say so now).
- `:45` — "**GA gate transferred to #757**: … the dashboard owners actually see … still buckets on
  `detected_at` … #757 (GA-blocking) applies the anchor there". Done on this branch.

**Why this is reported and not simply fixed:** `docs/currents.md` is *not* in
`allowed_edit_surface`, and amending the surface a third time would trip this plan's abort criteria
(2 of 2 amendments already used — D1, D10). The repo convention visible in `git log` is that
`currents.md` is refreshed by a **post-merge sweep** commit (e.g. `b82dce06`, `402779a3`), which
would close this. Flagged so the sweep is not skipped, and so the intake's `non_goals` list of
"docs that keep stale references" is understood to be incomplete rather than exhaustive.

---

## Verdict by contract field

### `allowed_edit_surface` — **no drift**

All 24 changed paths fall inside the (twice-amended) surface:

| Changed path | Surface entry |
|---|---|
| `src/lib/kpi/fragments.ts`, `src/lib/kpi/types.ts`, `src/lib/kpi/__tests__/fragments.test.ts`, 3 deleted `src/lib/kpi/__tests__/*` | `src/lib/kpi/**` |
| `src/lib/dashboard/service.ts` | `src/lib/dashboard/service.ts` |
| `src/lib/dashboard/aggregate-queries.ts` | `src/lib/dashboard/aggregate-queries.ts` |
| 3 new `src/lib/dashboard/__tests__/*` | `src/lib/dashboard/__tests__/**` |
| `src/app/api/dashboard/kpis/route.ts` + its test (deleted) | `src/app/api/dashboard/kpis/**` |
| `src/app/api/dashboard/__tests__/route.test.ts` | amendment #2 (D10) |
| `scripts/ci/tenant-scope-allowlist.ts` | amendment #1 (D1) |
| `scripts/ci/__tests__/db-imports-audit.test.ts` | declared |
| `docs/adr/0019-*.md`, `docs/directory.md`, `CONTEXT.md`, `.claude/CLAUDE.md` | declared |
| `docs/superpowers/plans/**` ×3, `docs/reviews/**` ×1 | declared |

### `user_visible_behavior` — **complete, nothing unnamed**

Every behavioral change in the diff maps to a listed bullet. Checked specifically for unnamed
knock-ons:

- `aggregate-service.ts` rolls the per-location slices into an account-level `reviewVelocity`
  (week-summed, `:275`) and `ratingBreakdown` (`sumRatingBreakdowns`, `:327`). Both are direct
  consequences of bullet 2 and are the same two metrics.
- No account-level avg-star is derived from the breakdown — `RatingBreakdown` is `{counts,total}`
  only (`src/lib/dashboard/types.ts:58`), so no unnamed star metric moves.
- `windowedReceived`/`windowedResponded` → `currentResponseRate` (`aggregate-service.ts:228`) is
  untouched, matching bullet 3.
- `getActiveDashboardData` has exactly **two** production call sites, both in
  `src/app/api/dashboard/route.ts` (`:184`, `:284`). No worker, digest, or email path consumes it,
  so the ADR 0019 D2 carve-out for `MonthlyImpactWorker` is structurally safe.

### `tests_to_add` — **20/20 present verbatim, none vacuous**

Title match was scripted against every `*.test.ts(x)` in the tree; all 20 hit, each in exactly one
file. Bodies were then read and the negative controls mutation-reasoned:

| Title | Home | Non-vacuity |
|---|---|---|
| velocity buckets an imported review into its `review_date` week | integration t1 | `at(back3)?.count` is `undefined` under `detected_at`; also pins the series total = 1 so an OR-form double-count fails |
| sentiment trend buckets … | integration t2 | same shape, same total pin |
| avg star window excludes … | integration t3 | reads 5 anchored / 3 on `detected_at` |
| rating breakdown excludes … | integration t4 | `total` 1 vs 2 |
| NULL `review_date` fallback | integration t5 | fails if anyone anchors on `review_date` alone |
| future `review_date` clamps | integration t6 | green before/after by design (documented in the test); fails under `COALESCE` because +8d lands in a week `generate_series` never emits |
| response rate still windows on `detected_at` | integration t7 | **strong** — see below |
| recent-review feed still orders on `detected_at` | integration t8 | order flips (star 2 → star 5) if re-anchored |
| aggregate slices apply the anchor | integration t9 | `back6` bucket absent under `detected_at` |
| avg star prior window + sample size | integration t10 | `priorSampleSize` 1 / `delta` 4 vs empty prior + suppressed delta |
| time-saved keys on `approved_at` | integration t11 | 7 min vs 0 |
| aggregate `windowedReceived`/`windowedResponded` | integration t12 | 2/1 vs 1/0 if re-anchored |
| zero-filled velocity for a review-less location | integration t13 | length 8 vs 0 if the anchor moves `ON`→`WHERE` |
| 4 single-loc queries spell `LEAST(...)` | `service.review-time-anchor.test.ts` | **exact** occurrence counts (3/7/3/1) + `stripAnchor(...).not.toContain('detected_at')` — a partial re-anchor fails |
| response-rate & timeSaved never spell `LEAST(` | same file | `findOnly` throws on an ambiguous marker (the exact bug an earlier draft had) |
| aggregate velocity/rating spell `LEAST(r....)` | `aggregate-queries.review-time-anchor.test.ts` | exact counts 2/1 + alias-rename pins |
| aggregate counter never spells `LEAST(` | same file | + `toContain('r.detected_at >= NOW()')` |
| `reviewTimeAnchor` emits both spellings and nothing else | `fragments.test.ts` | asserts full text equality, `values == []`, and no `FROM`/`JOIN`/`business_id`/`account_id` |
| `reviewTimeWindowFilter` binds an integer | `fragments.test.ts` | full-text equality + `not.toMatch(/INTERVAL '\d+ days'/)` + `values == [30]` |
| anchor spelled only in `kpi/fragments.ts` | `fragments.test.ts` | source scan of `src` + `worker`, non-test files |

No `.todo` survivors — `fragments.test.ts`'s own header warns against exactly that and both
converted tests are real `it()` bodies.

**Negative-control strength (brief item 2).** Each of the four "must not move" behaviors was
mutation-reasoned against the fixture set, and all four genuinely fail if re-anchored:

- **Response rate, current AND prior.** Re-anchoring drops the 200-day-old import out of the 60-day
  outer window entirely → `received_current = 0` → `responseRateCurrent = null` →
  `buildMetric` returns `current: null` and `delta: null` (`reputation-summary.ts:60-67`). The test
  asserts `current === 0`, `priorSampleSize === 1`, `delta === -100`. Two of three assertions break.
  The prior half is separately pinned by the 45-day answered review.
- **Recent-review feed.** `ORDER BY rev.detected_at DESC` → import (star 2, detected today) first.
  Anchoring flips to the 2-day organic (star 5). `recentReviews[0].starRating` asserted.
- **timeSaved.** 300-day-old import answered 1h ago → 7 minutes. Any anchor-keyed variant reads 0.
- **Aggregate counters.** The 6-week-back import is inside 30d by `detected_at`, outside by anchor →
  `2/1` becomes `1/0`.

### `edge_cases` — **8/8 handled**

| Edge case | Handled where | Evidence |
|---|---|---|
| NULL `review_date` | `LEAST` semantics + `fragments.ts` doc | integration t5, passes against live PG |
| Future `review_date` | `LEAST` clamp | integration t6 (+8d, chosen so it fails *every* weekday under `COALESCE`) |
| Anchor must stay in the aggregate `LEFT JOIN … ON` | `aggregate-queries.ts:198-201` + a comment saying why | integration t13 (8 zero rows for a review-less location) |
| Alias rename `rv`/`rev` → `r` | `aggregate-queries.ts` | `ci:tenant-scope` **passes, 401/401**; the counter query's own `r` is a separate statement; shape test asserts `not.toContain('rv.')`/`not.toContain('rev.')` |
| 45s Redis caches serve pre-anchor payloads | no code needed | cache key unchanged (`locationCacheKey`), self-expiring; recorded in `rollback_plan` |
| Deleted route strands the composition-root assertion | `scripts/ci/__tests__/db-imports-audit.test.ts:102,118` | repointed to `src/app/api/dashboard/route.ts` and `src/lib/dashboard/service.ts`; suite passes |
| Orphaned `kpi/types.ts` exports | `src/lib/kpi/types.ts` | all five deleted; window vocabulary intact; `tsc --noEmit` clean |
| Imported review older than the window drops out | by construction | integration t3/t4 assert exactly this |

### Invariants named in the intake — **all hold**

- **Tenant predicates literal in every template.** `ci:tenant-scope` passes at 401/401. Neither
  fragment spells `FROM`/`JOIN`/`business_id`/`account_id` (asserted in `fragments.test.ts`). The
  two `dashboard/service.ts` allowlist snippets were mechanically refreshed (D7) and now match.
- **Windows bound as integers (#403).** Pinned three ways: `fragments.test.ts` (text + `values`),
  `service.rating-breakdown.test.ts`, and the rewritten `route.test.ts` assertion, which now reads
  *through* the captured fragment and checks both `make_interval(days => ?)` **and** the bound `30`
  — strictly stronger than the assertion it replaced.
- **No reintroduced `Promise.all` fan-out (#505/#767).** `src/lib/dashboard/service.ts:210`
  (`settledInOrder`, 13 thunks) and `:485-585` (`fetchReputationRows`, five plain sequential
  `await`s) are untouched by the re-anchor edits; `aggregate-queries.ts:133` still uses
  `settledInOrder`. `grep`: zero `Promise.all` in either file. `pool-fanout-sequential.test.ts`
  passes.
- **Invariant #15.** `fragments.ts` takes `sql: Sql` as an explicit parameter and imports only
  `type { Sql } from 'postgres'`. `ci:db-imports` passes.
- **Invariant #1.** No LLM/external work moved; `eslint` clean over `src/app/api/dashboard`.
- **Per-widget degradation.** All re-anchored queries stay inside their existing `widgetOrFallback`
  thunks; `service.degradation.test.ts` passes.
- **One owner per spelling.** `fragments.test.ts` source audit is green and would catch a
  hand-spelled `LEAST(` in `src`/`worker`.

### Blast radius — **no caller relies on the old bucketing**

`docs/reviews/feat-757-dashboard-review-time-anchor/blast-radius.md` is a naive import-text sweep
(it reports 268 importers for `kpi/types.ts` and 78 for the deleted route), so it was re-derived:

- `src/lib/dashboard/service.ts` — the only production consumer of `getActiveDashboardData` is
  `src/app/api/dashboard/route.ts` (two call sites). The other 22 "importers" in the report are
  false matches on the bare `from './service'` pattern; `rg "from '@/lib/dashboard/service'"`
  returns exactly one file.
- `src/lib/dashboard/aggregate-queries.ts` — one production importer, `aggregate-service.ts`, whose
  three consumptions of the changed slice fields (`reviewVelocity`, `ratingBreakdown`,
  `windowedReceived`/`windowedResponded`) were each read: the first two are the intended change, the
  third is untouched.
- `src/lib/kpi/types.ts` — the five deleted exports have **zero** remaining references anywhere
  (`rg` over `src worker scripts e2e tests` → CLEAN); the surviving window vocabulary
  (`DASHBOARD_WINDOWS`/`DashboardWindow`/`resolveDashboardWindow`/`dashboardWindowParams`) is
  unchanged, so its real importers are unaffected. `tsc --noEmit` clean confirms.
- Dashboard payload shape (`DashboardDataActive`) is byte-identical — only the values inside
  `reviewVelocity`, `ratingBreakdown` and `reputationSummary.{averageStar,trend}` move, so no
  component contract changes.

### Deletion completeness — **clean in code**

```
rg -n "kpi/service|api/dashboard/kpis|getLocationKpiSummary|getAccountKpiSummary|
       DashboardKpiSummary|KpiScope|KpiResponseRate|KpiReviewVolume|SentimentTrendPoint" \
   src worker scripts e2e tests
→ CLEAN
```

`src/app/api/dashboard/kpis/` is gone. Remaining doc references are: `docs/reviews/**` and root
`PLAN.md` (deliberately retained per `non_goals`); `docs/audits/**`,
`docs/future-plans/2026-07-06-codebase-audit-findings.md`, `docs/sass_ready/**` (dated historical
snapshots — `docs/sass_ready/11-data-analytics-bi.md:5` is explicitly stamped "Implementation status
(Wave 3, 2026-05-27)"); and `docs/currents.md`, which is the LOW finding above.
`docs/directory.md` never carried a row for the deleted route and now carries a correct `kpi/`
section.

---

## Verification actually run (not inferred)

| Command | Result |
|---|---|
| `tsc --noEmit -p tsconfig.json` | clean |
| `eslint src/lib/kpi src/lib/dashboard src/app/api/dashboard` | clean |
| `vitest run src/lib/dashboard src/lib/kpi src/app/api/dashboard scripts/ci/__tests__/db-imports-audit.test.ts src/__tests__/ci-audit-wiring.test.ts` | 49 files passed / 3 skipped, **484 passed** |
| `vitest run src/__tests__` | 22 passed / 1 skipped, **1229 passed** |
| `vitest run --project integration src/lib/dashboard/__tests__/review-time-anchor.integration.test.ts` **with `TEST_DATABASE_POOL_URL` exported** | **13/13 passed** against live Postgres |
| `ci:tenant-scope` | passed — entries 401 (baseline 401) |
| `ci:db-imports`, `ci:live-db-suites`, `ci:static-policy`, `ci:rls-audit`, `ci:reviews-status`, `ci:feature-surface` | all pass |

The live-DB run is worth calling out: it is the only proof the composed nested fragments produce
valid SQL and the intended bucketing, and it **self-skips** unless `TEST_DATABASE_POOL_URL` is
exported into the shell (the `.env.local` fallback does not reach `describeWithDb`, which reads
`process.env` at call time). Run without the export it reports "13 skipped" and reads green — the
failure mode commit `15d26ee8` warns about. It was run properly here and passes.

---

## Low-confidence appendix (NOT findings — observations below the bar)

1. **The feed-ordering pin runs only in the live-DB lane.** `ORDER BY rev.detected_at DESC` is
   asserted behaviorally by integration t8 and by nothing that runs in CI —
   `service.feed-projection.test.ts` pins only `ORDER BY version DESC`, and
   `rg "detected_at DESC" src --glob '**/__tests__/**'` returns nothing. Response rate, timeSaved
   and the aggregate counters each *also* have a CI-running text pin in the two shape suites; the
   feed does not. A future re-anchor of the feed would pass CI. This is consistent with the
   intake's own stated KNOWN GAP and `tests_to_add` asked for exactly one feed test, so it is not a
   contract violation — but a one-line `expect(feed).toContain('ORDER BY rev.detected_at DESC')` in
   `service.review-time-anchor.test.ts` would close it for free.
2. **`ANCHOR_PATTERN` in `fragments.test.ts:22` is argument-order-sensitive.**
   `/LEAST\(\s*(?:[A-Za-z_][\w$]*\.)?review_date\s*,/` would not match a hand-spelled
   `LEAST(detected_at, review_date)`, which is semantically identical. Narrow evasion, low value.
3. **The source audit does not scan `scripts/`.** Deliberate and correct today — the refreshed
   `tenant-scope-allowlist.ts` reasons *contain* the literal `LEAST(review_date, detected_at)` as
   prose (this is D8/D9's lesson), so scanning `scripts/` would false-positive.
4. **Sargability.** `LEAST(review_date, detected_at) >= …` cannot use either composite index; the
   ADR addendum records this as a deliberate deferral with the All-Locations aggregate named as the
   path to measure first. Design axis, already adjudicated.
5. **`ALLOWLIST_BASELINE` says 401 twice** — once in the changelog comment block, once as a trailing
   `// was 408 …` on the assignment line. Harmless duplication; the file's convention is the block.
6. **`docs/sass_ready/updates.md:108,155` and `11-data-analytics-bi.md:5`** still list
   `GET /api/dashboard/kpis` as shipped. Both are dated wave-status snapshots, so they read as
   history; noted only so the post-merge sweep can decide.

---

**Bottom line on my axis:** the implementation is a faithful, well-tested realization of the locked
contract. No production-code defect at ≥80% confidence, no surface drift, no unnamed behavior, all
20 promised tests present and substantive, all 8 edge cases handled, every named invariant
verified by a command rather than by reading. The three findings are documentation-fidelity gaps,
two of them in a file the branch edited and had every right to fix.
