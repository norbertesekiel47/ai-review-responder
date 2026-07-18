# Standards & Maintainability Review — #476 (set-based per-account aggregates)

Axis: repo standards (`.claude/rules/*.md` + CLAUDE.md invariants), deep-module
discipline, Fowler smell baseline, glossary/CONTEXT.md consistency.
Scope: `git diff main...HEAD` — `aggregate-queries.ts` (new), `aggregate-service.ts`
(rewired), `pending-count.ts`, `types.ts`, the two `__tests__/*.ts`, and the two
CI-audit baseline edits.

Method: verified the "byte-identical output" contract field-by-field against the
single-location owner (`service.ts` + `service-mappers.ts`), confirmed tenant
scoping, and audited abstraction depth. Reviewed with the
`thermo-nuclear-code-quality-review` skill loaded.

## Overall assessment

**The design is sound and I would approve it.** This is the good version of a
fan-out-elimination refactor:

- `aggregate-queries.ts` **is a deep module**: one narrow entry point
  (`fetchPerLocationAggregateSlices(sql, accountId, window) → Map<business_id,
  slice>`) hides six `GROUP BY business_id` statements + a pending-count rollup +
  bucketing + mapper wiring. Query count is constant in N (test-enforced at 8).
- **Complexity is pushed DOWN into the queries module, not onto
  `aggregate-service.ts`.** The service shrank from an orchestration tangle
  (`mapWithConcurrency`, `validPairs`, `partialFailures`, two account-total
  helpers) to a straight-line composition over `locations`.
- **The per-location mapper logic is REUSED, not duplicated.** `buildValueSummary`,
  `buildRanking`, `buildRatingBreakdown`, `selectLatestBrief`, `mapReviewVelocity`
  are the same canonical helpers `service.ts` uses. I found no re-implemented
  mapper. This is what makes "byte-identical" hold by construction rather than by
  coincidence.
- **Invariant #15** honored: `sql` is an explicit parameter; neither new file
  imports `@/lib/db/server`.
- **Tenant scope** preserved: every one of the 8 statements scopes by
  `b.account_id = ${accountId}::uuid AND b.archived_at IS NULL`. The counters/
  velocity rewrite (keeping `responses`/`reviews` in the MAIN query rather than a
  subquery) makes scope statically provable to `ci:tenant-scope` with no new
  allowlist entries — a genuine improvement. The deleted `getTotalRespondedForAccount`
  allowlist entry and baseline decrement (393→392) are consistent.
- **Byte-identical contract verified** for every retained field:
  `total_received/responded` (`COUNT(DISTINCT r.id)` correctly dedupes the response
  fan-out ⇒ equals service's `COUNT(*)` / `COUNT(DISTINCT r.id)`); velocity,
  rating, ranking, briefs match; `recentReviewCount = LEAST(total_received, 10)`
  is a correct algebraic replacement for the old `recentReviews.length`.
- The two output deltas (windowed `currentResponseRate`, `partialFailures`
  removed) are the signed-off deviations in
  `docs/superpowers/plans/…-deviations.md`; no consumer of `partialFailures`
  remains (only a comment reference).

Findings below are all LOW — polish on an otherwise clean structural win. No
blockers.

## Glossary / CONTEXT.md

No violation. `CONTEXT.md` is a 17-line seed glossary that does **not** define
"per-location fan-out", "set-based per-account aggregate", or "windowed account
response rate" (the plan file's "Glossary terms: n, n, n" confirms they were never
coined). The code + comments use those three terms consistently with the plan and
deviations doc, so there is no CONTEXT.md concept being renamed.

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| Low | `src/lib/dashboard/aggregate-service.ts:186` | Misleading comment: "Equal to the old account-wide **windowed** COUNT". The prior implementation (`getTotalReviewsForAccount`/`getTotalRespondedForAccount`, now deleted) computed an **all-time** account rate — there was no windowed account COUNT. The whole point of the signed-off delta is that the rate changed all-time→windowed; this comment tells a future reader nothing changed. design.md: comments must be accurate and not mislead. Reword to "Equal to a single account-wide *windowed* COUNT, because locations partition reviews by business_id" (drop "the old"). |
| Low | `src/lib/dashboard/aggregate-queries.ts:304` (`toBusinessRow`) | Wide-type adapter / Fowler Data-Class smell: 11 fields are stuffed with `null` to satisfy the fat `DashboardBusinessRow` when `buildValueSummary` reads only 3 baseline columns (+ name/created_at, themselves unused by the value summary). design.md: interface wider than the caller needs. Deepening remedy: narrow `buildValueSummary`'s third param to a baseline-only type (`Pick<DashboardBusinessRow,'initial_review_count'\|'initial_responded_count'\|'baseline_captured_at'>`), which deletes `toBusinessRow` entirely and tightens the shared mapper contract. |
| Low | `src/lib/dashboard/aggregate-service.ts:307` / `types.ts:65` | Shared-contract semantic divergence: `ValueSummary.currentResponseRate` is now **windowed** in the aggregate payload but remains **all-time** in the single-location payload (`buildValueSummary`). One wire field, two meanings by scope. Signed-off as intentional, but a maintainability foot-gun on a shared type — a future edit that "reconciles" the two will silently change one surface. engineering.md/design.md: one field, one meaning. At minimum document the scope-dependent semantics on the `ValueSummary.currentResponseRate` field in `types.ts`. |

## Low-confidence appendix (not table findings)

- **`const HANDLED = [...HANDLED_STATUSES] as string[]`** is duplicated between
  `aggregate-queries.ts:34` and `service.ts:39`. Trivial DRY; a shared export
  (e.g. from `response-status`) would remove it, but both are cheap and local.
- **`EMPTY_SLICE` (`aggregate-service.ts:41`) is effectively dead defensive code.**
  Its own comment says the case is "unreachable in practice" because
  `getLocationsForAccount` and the baseline query use the *identical* predicate
  (`account_id = X AND archived_at IS NULL` — confirmed in `locations/repo.ts:78`).
  design.md would prefer defining the invalid state away, but the branch is cheap
  insurance against an intra-request archival race between the two concurrent
  queries. Borderline; leaving it is defensible.
- **Active-location predicate expressed twice** (`getLocationsForAccount` vs the
  baseline query) — a mild "one authoritative owner per fact" (engineering.md)
  concern. In practice inherent: every account-scoped set query must restate the
  tenant scope anyway, and the baseline query needs the businesses join for its
  baseline columns regardless. Not worth a structural change.
- **Empty rating breakdown built two ways**: `EMPTY_SLICE` uses
  `sumRatingBreakdowns([])` while the per-location zero-fill uses
  `buildRatingBreakdown([])`. Functionally equal (both → 5 zero buckets, total 0);
  cosmetic only.
- **Top-of-file comment** in `aggregate-queries.ts` says "six `GROUP BY
  business_id` queries", but baseline isn't grouped and the two brief queries use
  `DISTINCT ON`, not `GROUP BY`. Minor comment imprecision.
