# Spec & correctness review — round 1 — `feat-688-kpi-review-time-anchor`

Reviewed: `git diff 8db5fe28..HEAD` (11 files) against `.feature/intake.json`,
plan `2026-08-10-feat-688-kpi-review-time-anchor.md`, the triaged deviations
file, and `blast-radius.md`. Verification actually run in the worktree:

- `pnpm vitest run src/lib/kpi/__tests__/service.test.ts src/lib/kpi/__tests__/service.cache.test.ts` → 28 passed
- `TEST_DATABASE_POOL_URL=<.env.local> pnpm vitest run src/lib/kpi/__tests__/service.anchor.integration.test.ts` → 9 passed (8 promised + 1 supplementary) against live Postgres
- `pnpm ci:tenant-scope` → passed, entries 408 (baseline 408)

## Q1 — user_visible_behavior faithfully implemented, and only those?

**Within `src/lib/kpi/service.ts`: yes, faithfully and exactly.**

| Intake item | Evidence |
|---|---|
| 1. Volume MoM by review-time month | `service.ts:233-245` (location) / `:342-354` (account) — all 3 FILTER predicates per scope swapped to `${reviewTimeAnchor(...)}`; integration test 1 green against live Postgres |
| 2. Trend buckets by review-time week | `service.ts:264-271` / `:375-384` — SELECT-wk, week filter, GROUP BY all on the anchor; integration test 2 |
| 3. Avg star windows on review-time | `service.ts:231` / `:340` via `reviewTimeWindowFilter`; integration test 3 |
| 4. TTR excludes `approved_at < detected_at` | `service.ts:182` (`ttrHandledWindowFilter`, shared by both scopes — both alias reviews as `r`); integration tests 7/8 |
| 5. Response rate UNCHANGED on detected_at | rate queries `service.ts:210-224` / `:315-331` untouched, still `detectedAtWindowFilter`; mock tests pin `sqlCalls[0]` contains `detected_at >=` and NOT `LEAST(`; integration test 6 |

No unnamed behavior changes inside the module: the only other edits are doc
comments (header `:5-6`, `detectedAtWindowFilter` `:124-127`, TTR comment) and
the mock-suite/allowlist re-pins. Windows can only *lose* rows relative to the
old semantics (anchor ≤ detected_at always), so nothing new enters any window.
Boundary drift for organic rows is a named, accepted edge case (intake
edge_cases #5, ADR 0019 Consequences).

**BUT — see Finding A.** The intake's premise that these behaviors are
*user-visible* is false in the current codebase: `src/lib/kpi/service.ts` is
reachable only through `GET /api/dashboard/kpis`, and that endpoint has **zero
consumers** (repo-wide `rg "dashboard/kpis"` matches only the route, its own
tests, and the db-imports audit fixture; `rg -ln "kpi/service"` production
matches: only `src/app/api/dashboard/kpis/route.ts`). Every metric the owner
actually sees still buckets on `detected_at` (Q1a below).

## Q2 — 8 `tests_to_add` present verbatim and non-vacuous?

All 8 titles byte-for-byte identical to the intake array
(`service.anchor.integration.test.ts` lines 250, 258, 282, 290, 299, 315, 334,
328 — tests 7/8 use double-quoted strings for the apostrophe in `review's`,
matching the intake bytes). Assertions are substantive, each fixture
distinguishes the pre-#688 semantics:

1. Volume: fixture `review_date = DATE_TRUNC('month', NOW()) - 10 days`
   (always prior calendar month), `detected_at = NOW()`; asserts
   `{priorMonth: 1, currentMonth: 0}` — red under detected_at.
2. Trend: 3-weeks-back Monday-aligned review; asserts import-week count 1 AND
   current-week count 0 — red under detected_at. Expected week strings computed
   in SQL as `::date` and round-tripped through the same
   postgres.js-decode + `String()` path `mapTrend` uses (deviation 1, verified).
3. Star: 60d-old 1★ import beside in-window 5★; asserts exactly 5 (would read
   3 under detected_at).
4. NULL fallback pin: asserts star 4 AND `currentMonth: 1` — fails if LEAST
   NULL-handling were wrong (NULL result would drop the row).
5. Future clamp pin: asserts current-week count 1 AND total-across-weeks 1
   (the vanish detector). Caveat: Finding B — its LEAST-vs-COALESCE
   discrimination is weekday-dependent.
6. Rate pin: 200d-old imported unanswered review; asserts
   `{received: 1, handled: 0, ratePct: 0}` — fails if rate were re-anchored.
7. TTR exclusion: review G (detected 1d ago, response approved 10d ago —
   in-window negative sample) seeded inside the test; asserts average stays 6.
8. TTR keep: review H 10h/4h → 6.0h; declared BEFORE test 7 so it reads the
   pre-G state (deviation 3, verified in file order).

Commit order confirms the eval-first discipline: suite committed at 65bdc309
before implementation b1465a06 ("4 red / 4 pin" per the commit subject).

## Q3 — edge_cases covered by code + test?

- **NULL review_date** → code: `LEAST` NULL-skip (`service.ts:145-149`); test 4. ✔
- **Future review_date clamp** → code: `LEAST` (never exceeds detected_at);
  test 5, plus mock-suite `LEAST(` fragment pins and characterization pins that
  would fail on a `COALESCE` rewrite. ✔ (with Finding B caveat on the
  integration test's discrimination window)
- **In-window negative TTR** → code: `resp.approved_at >= r.detected_at`
  (`service.ts:182`); test 7 constructs exactly the bounded in-window case
  (approved 10d ago, inside the 30d approved_at window, before detection). ✔
- **Out-of-window imported rows drop out** → code: window predicates on the
  anchor; tested directly for the star window (test 3). For volume/trend the
  drop-out is only *implicit* (STAR_BIZ's 60d row absent from both volume
  buckets and RATE_BIZ's 200d row absent from all trend points are exercised
  through the account-scope consistency sum, not asserted by name). Adequate —
  the intake phrases this case as an accepted consequence, not a behavior to
  pin — noted for completeness.
- **Boundary drift** → accepted-in-ADR consequence, deliberately untestable
  (no fixed expectation exists); matches the intake's "accepted, more truthful". ✔

## Q4 — drift outside allowed_edit_surface?

None. The 11 changed files map to the surface exactly: `src/lib/kpi/service.ts`,
`src/lib/kpi/__tests__/**` (2 files), `docs/adr/0019-kpi-review-time-anchor.md`,
`CONTEXT.md` (single glossary line), `docs/superpowers/plans/**` (4 files),
`docs/reviews/**` (blast-radius.md), and `scripts/ci/tenant-scope-allowlist.ts`
— the last added to the surface by user-approved amendment #1, recorded in the
deviations file and applied to BOTH intake copies (docs copy diff +
`.feature/intake.json` both carry the entry). Amendment count is 1 (below the
re-classification trigger).

## Q5 — invariants held?

- **Tenant-scope predicates literal**: every edited query keeps
  `business_id = ${businessId}` / `b.account_id = ${accountId} AND
  b.archived_at IS NULL` and its FROM/JOIN spelled in the outer template;
  `reviewTimeAnchor`/`reviewTimeWindowFilter` contain no FROM/JOIN/SELECT.
  `pnpm ci:tenant-scope` passes at baseline. ✔
- **LEAST, not COALESCE**: both fragment arms (`service.ts:145-149`); pinned by
  mock fragment assertions and byte-identical characterization constants. ✔
- **Scopes identical**: diffed side by side — star/volume/trend each get the
  same fragment with the correct prefix per scope. Prefix audit: location
  queries use unaliased `FROM reviews` + `''` (star :225-232, volume :233-245,
  trend :263-271); account queries use `FROM reviews r` + `'r.'` (star
  :332-341, volume :342-354, trend :374-385). Location *rate* correctly keeps
  its pre-existing `r` alias + `'r.'` `detectedAtWindowFilter`. No prefix
  mistakes. The supplementary integration test locks cross-scope bucket
  equality (volume, rate, per-week trend counts); the account mock test pins
  the `r.`-prefixed fragment on calls 1/2/4. ✔
- **Response rate untouched on detected_at**: both rate templates byte-identical
  to the fork point (verified in the diff — no hunk touches them);
  `not.toContain('LEAST(')` pins in both mock tests. ✔
- **`ttrHandledWindowFilter` correct for BOTH scopes**: single shared fragment;
  location TTR joins `reviews r` (:249), account TTR joins `reviews r` (:358),
  so `r.detected_at` resolves in both. `>=` keeps a zero-duration
  (approved_at == detected_at) sample — exclusion applies only to strictly
  negative durations, matching the intake. The TTR *duration* expression
  (`ttrSelectExpr`, approved_at − detected_at) is correctly left on
  detected_at (workflow latency). ✔
- **No schema change / no new index / cache behavior unchanged**: no migration
  in the diff; cache keys, TTL 45s, fail-open blocks untouched. ✔

## Q6 — SQL correctness

- **SELECT vs GROUP BY**: both positions interpolate the *same* fragment
  (`DATE_TRUNC('week', LEAST(...))`), so the text is identical by
  construction; the SELECT's extra `::date` cast sits on top of the grouped
  expression, which Postgres permits (cast of a grouped expression), and the
  live-DB suite proves it executes and buckets correctly in both scopes.
- **Volume FILTER pair**: current = `anchor >= month_start`; prior =
  `month_start − 1mo <= anchor < month_start`. Mutually exclusive (half-open
  boundary at `month_start`) and exhaustive over the two-month span; the
  anchor can never exceed `NOW()` (anchor ≤ detected_at ≤ NOW()), so nothing
  escapes forward. All three predicates per scope (current + prior lower +
  prior upper) carry the anchor — none missed.
- **Anchor applied only where mandated**: 6 reputation sites (star ×2,
  volume ×2, trend ×2) plus the TTR exclusion predicate; NOT applied to the
  rate queries, NOT to `ttrSelectExpr`, NOT to the TTR `approved_at` recency
  window. Matches the intake exactly.
- **Trend window subset property**: `anchor >= NOW() − trendWeeks` implies
  `detected_at >= NOW() − trendWeeks`, so re-anchoring only redistributes or
  drops rows — never admits rows the old query excluded.

## Q7 — tenant-scope-allowlist re-pin strictly textual?

Yes. Exactly 3 `sqlSnippet` strings edited (location/reviews ~:2277,
account/businesses ~:2302, account/reviews ~:2309) — the three trend-query
entries whose raw template text changed. Each edit swaps
`detected_at`→`${reviewTimeAnchor(sql, '')}` (or `r.` variant) in precisely
the SELECT-wk, week-filter, and GROUP BY positions. No entry added or removed
(audit reports 408 = baseline 408, and "unused entry" detection would fail on a
stale snippet), `file`/`table`/`category`/`reason` fields untouched, no scope
predicate in any snippet changed. Matches deviation 6 / amendment #1 exactly.

## Blast-radius semantic check (25 listed importers)

The list is transitive/heuristic: **only `src/app/api/dashboard/kpis/route.ts`
calls `getLocationKpiSummary`/`getAccountKpiSummary` in production** (plus the
three kpi test files and the route test). Per-file grep of all 15 listed
production files for the two functions and the cache keys: every other entry —
the 4 approve-token routes, 3 dashboard review-action routes,
`/api/dashboard/route.ts`, `approval/{service,http-routes}.ts`,
`dashboard/aggregate-{queries,service}.ts`, both worker ingress files — has no
reference; `dashboard/route.ts` and `aggregate-service.ts` import only
`@/lib/kpi/types` (types module, untouched). Nothing invalidates or re-serves
the `kpi:location:*`/`kpi:account:*` cache keys outside `service.ts`. No caller
relies on detected_at bucketing of the changed functions.

The repo-wide check for parallel implementations of the same windows, however,
produced the round's main finding:

### Finding A (HIGH) — the re-anchored KPIs render nowhere; every visible dashboard surface still buckets on detected_at

Evidence chain:

1. `GET /api/dashboard/kpis` (the only consumer of the changed functions) has
   **no caller anywhere in the repo** — no component, hook, page, worker, or
   e2e reference (`rg "dashboard/kpis"` across the tree).
2. The dashboard the owner sees is fed by `/api/dashboard` →
   `src/lib/dashboard/service.ts` `fetchReputationRows` (:435-548), which
   re-implements the same metrics **on detected_at**: windowed avg star
   current/prior (:486-507), the 8-week sentiment trend with the *identical*
   `generate_series` + `DATE_TRUNC('week', detected_at)` shape (:526-546), and
   review velocity (:199-216). `DashboardContent.tsx:267,351` renders this as
   the Zone-1 `ReputationHeroBand` ("Your reputation · last 30 days" — Average
   rating, Response rate, Time saved) plus the trend; the analytics views
   (`AnalyticsPerLocationView`/`AnalyticsAggregateView`) add velocity and
   rating breakdown from `src/lib/dashboard/aggregate-queries.ts` (:164-215),
   also detected_at.
3. Neither the intake, the plan, ADR 0019, nor the deviations file mentions
   `fetchReputationRows` or the aggregate slices. ADR 0019 names exactly two
   deliberate detected_at holdouts (response rate, MonthlyImpactWorker digest);
   the visible avg star and visible sentiment trend are neither re-anchored nor
   adjudicated as holdouts. The intake comment "the dashboard KPI strip is
   polled" (`service.ts:23-25` cache comment) and the plan's "KPI card" non-goal
   suggest the authors believed the KPI service backs a rendered strip — it
   does not, today.

**Concrete failure scenario**: first GA customer consents to a 100-review
import → the hero band's "Average rating · last 30 days" ingests all 100
imported reviews (detected_at = import day), the visible 8-week trend shows the
one-week pile-up, and velocity spikes +100 — precisely the distortions #688
exists to remove (ADR 0019 Context items 1-3) — while the corrected numbers are
computed only for an endpoint nothing calls. Conversely, the moment the KPI
endpoint gains its intended consumer, its numbers will contradict the hero band
sitting on the same page.

This does not contradict a triaged deviation (none covers it) and is not a code
bug in the diff — it is the intake's user_visible_behavior premise failing
against the actual render path. Disposition options for the orchestrator:
(a) follow-up ticket to re-anchor `fetchReputationRows`' star + trend (and
decide velocity/rating-breakdown semantics) — the anchor fragment is single-owner
in kpi/service.ts, so this needs either an export or duplication decision;
(b) an explicit ADR 0019 amendment declaring the reputationSummary surfaces
detected_at-by-design (hard to defend — they are reputation, not workflow,
metrics by the ADR's own taxonomy).

### Finding B (LOW) — future-clamp integration test discriminates LEAST-vs-COALESCE only on weekends

`service.anchor.integration.test.ts:210-215` seeds `review_date = NOW() +
interval '2 days'`. Under a hypothetical `COALESCE` regression, the row buckets
into `DATE_TRUNC('week', NOW() + 2 days)` — which is still the *current* ISO
week whenever the suite runs Monday–Friday (only Sat/Sun push NOW()+2d past the
next Monday). On weekdays the test's assertions (current-week count 1, total 1)
would pass under COALESCE, so the "guards against a naive COALESCE" claim in
the fixture comment holds 2 days out of 7. Failure scenario: a future refactor
to COALESCE re-derives the mock characterization pins (the sanctioned
procedure) on a weekday → the whole tree is green → the trend-vanish regression
ships. Mitigation is cheap: seed `review_date = DATE_TRUNC('week', NOW()) +
interval '9 days'` (always next week) or assert the anchor semantic directly.
Today the mock suite's `LEAST(` fragment pins are the effective guard, so
severity is low.

## Low-confidence appendix (speculative / sub-80%)

- `blast-radius.md` presents a transitive importer closure as "25 importers";
  ~14 entries never reference the module. Harmless for this round (I verified
  each), but a reviewer trusting the list at face value would over-scope future
  reviews. Consider labeling the generator's output "transitive".
- Stale comment, pre-existing: `src/lib/kpi/service.ts:23-25` "The dashboard
  KPI strip is polled and re-fetched on tab switches" describes a consumer that
  does not exist; ADR 0019's "the volume card would read +100" likewise names a
  card that is not rendered. Both are symptoms of Finding A's premise, not new
  defects of this diff.
- `src/lib/kpi/types.ts` doc comment claims `weekStart` is an ISO date;
  deviation 1 documents it is actually the long local `Date` string. Already
  flagged for the step-8 docs sweep; noting so it is not lost.
- Test-order coupling: integration tests 7/8 depend on file declaration order
  (documented in-file). If the `integration` vitest project ever enables
  test shuffling, test 8 reads post-G state and still asserts 6 — which would
  *pass* after Task 3 (G excluded), so the coupling is benign under the shipped
  code; it only mattered for the red-phase choreography.
- The volume queries remain unwindowed full-per-business scans (pre-existing);
  under review-time semantics the two FILTER buckets now hit
  `idx_reviews_business_review_date`-unfriendly expressions (`LEAST(...)` is
  not indexable by that index). Per-business row counts are small and the
  intake pinned "no new index", so this is a non-issue at current scale.

## Triage verdicts (orchestrator, 2026-08-10)

- HIGH (re-anchored KPIs render nowhere; visible dashboard still detected_at)
  — **ACCEPT, resolved as follow-up issue #757** (GA-blocking, references ADR
  0019 + map #667). Independently verified: only non-test reference to
  `dashboard/kpis` is the route itself; `dashboard/service.ts` reputation
  windows use detected_at. Both positions recorded: extending this branch was
  rejected (2nd surface amendment fires the abort criteria; dashboard payload
  is a different module with its own cache/consumers, deserving its own
  /feature run). #688 the DECISION ticket is satisfied — the anchor is
  decided, recorded, and implemented in the canonical KPI module; #757 makes
  it visible.
- LOW (future-clamp test weekend-only vs COALESCE) — **ACCEPT as documented
  risk**: suite header comment added; the mock `LEAST(` template pins remain
  the every-day backstop. No code change.
