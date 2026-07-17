# SPEC & CORRECTNESS review — perf #476 (set-based per-account aggregate)

Axis: spec conformance + byte-identical output parity against the locked contract
`.feature/intake.json`. Diff reviewed: `main...HEAD` in worktree
`perf-476-set-based-account-aggregates`. Read-only (no code edited).

## Verdict

The rewrite conforms to the locked contract. Every retained field is reproduced
by construction (set-based fetch → the SAME per-location mappers), the two
signed-off deltas (windowed `currentResponseRate`, `partialFailures` removed) are
implemented as specified, tenant isolation and invariant #15 hold, and all
promised `tests_to_add` are present and green. The verification commands
(`ci:tenant-scope` → 392/392, `ci:db-imports` → strict pass, `ci:static-policy` →
pass) and both dashboard test files (15 tests) pass. One low-severity stale-comment
defect is the only ≥80%-confidence finding.

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| LOW | src/lib/dashboard/aggregate-service.ts:69-84 | The `getAggregateDashboardData` JSDoc still describes the DELETED fan-out — "Runs the existing per-location dashboard query for each location", "Each location triggers the same 8-query parallel batch … could be slow. A future optimization could batch the SQL queries across locations, but the current approach is simpler" — i.e. the exact opposite of what this PR just did. Failure scenario: a future maintainer trusts the docstring, believes the N-scaling fan-out still exists, and either re-introduces per-location scaling or re-does the batching "optimization" already shipped. Contradicts engineering.md/design.md "docs communicate intent / comments current". |

## Field-by-field parity evidence (retained fields — all PASS)

Compared new SQL in `aggregate-queries.ts` against the per-location source of
truth in `service.ts`, fed through the shared mappers (`service-mappers.ts`,
`rating-breakdown.ts`, `active-mappers.ts`).

- **valueSummary sums** — `totalReviewsHandled` = Σ per-location `total_responded_all_time`
  (`COUNT(DISTINCT r.id) FILTER resp.id NOT NULL`, HANDLED join) = per-location
  all-time responded (`service.ts` `totalRespondedRows`). `totalTimeSavedMinutes`
  = responded × `MINUTES_SAVED_PER_RESPONSE` via `buildValueSummary`. Identical.
- **baselineResponseRate** — from primary location's baseline via `getBaselineResponseRate`;
  `toBusinessRow` maps the three baseline columns (`initial_review_count`,
  `initial_responded_count`, `baseline_captured_at`) fetched set-based. Matches.
- **reviewVelocity** — same `generate_series` zero-fill, same window math
  (`velocitySpanWeeks = trendWeeks-1`, `make_interval(weeks => trendWeeks)`),
  same `status <> DELETED` + `detected_at` window, `DATE_TRUNC('week', …)::date`
  bucketing. `COUNT(rv.id)` on a LEFT JOIN == `COALESCE(COUNT(*),0)`. Ordered
  `week_start ASC`. Identical.
- **ranking** — `rank_position IS NOT NULL`, `snapshot_date >= CURRENT_DATE -
  INTERVAL '12 months'`, ordered `keyword ASC, snapshot_date ASC` within each
  business bucket (bucketBy preserves row order); `buildRanking` reused. Best-position
  merge across locations unchanged from the old aggregate. Identical.
- **ratingBreakdown** — windowed `GROUP BY star_rating`, same `status<>DELETED`,
  `star_rating IS NOT NULL`, `detected_at >= make_interval(days => windowDays)`;
  per-location `buildRatingBreakdown` then `sumRatingBreakdowns` rollup. Identical (#405 preserved).
- **recentReviewCount** — `LEAST(total_received_all_time, 10)` reproduces the old
  `recentReviews.length` (the LIMIT-10 slice counts non-deleted reviews regardless
  of response). Matches the locked edge case exactly.
- **perLocation* arrays + ordering** — driven by `getLocationsForAccount` order
  (primary DESC, created_at ASC), identical to the old `validPairs` order in the
  no-failure (now the only) path.
- **recentReviews feed** — `getAccountRecentReviews` unchanged from main (byte-identical
  SQL + LATERAL joins + held-for-review exclusion + detected_at selection /
  reviewDate presentation sort). Non-goal respected.

## Signed-off deltas (as specified)

- **Windowed `currentResponseRate`** — `round(Σ windowedResponded / Σ windowedReceived
  × 100)`, 0 when received=0. Numerator = distinct non-deleted reviews with
  `detected_at` in window carrying a HANDLED response; denominator = distinct
  non-deleted reviews with `detected_at` in window. Matches `reputationSummary.rate`
  count semantics in `service.ts fetchReputationRows` (received_current / handled_current).
  Per-location partition by `business_id` makes the summed rate equal the account-wide
  windowed rate.
- **partialFailures removed** — dropped from `AggregateDashboardData` (types.ts) and
  the cache gate simplified to unconditional set; static-policy line-pin moved 285→283
  in lockstep (audit passes).

## Invariants

- **#8 tenant isolation** — every set-based query scopes via `JOIN businesses b …
  WHERE b.account_id = accountId AND b.archived_at IS NULL`; responses/reviews/
  ranking/briefs correlate through `b.id`. A foreign account's rows cannot enter a
  bucket, and output is anchored on the account-scoped baseline set (stray
  counter rows for a non-anchor business_id are dropped — test covers it).
  `ci:tenant-scope` passes at 392/392 (one dead allowlist entry removed per the
  approved surface amendment).
- **Moderation hold** — pending count (`getPendingApprovalCountsForAccount`) carries
  the `NOT EXISTS open flagged_responses` predicate. The counter query's response
  join filters `status = ANY(HANDLED_STATUSES)` = {approved, edited,
  awaiting_owner_connect, posted}; a held/flagged draft (`pending_approval`) is never
  HANDLED, so it is inherently excluded — identical to the per-location all-time
  responded query, which likewise has no explicit flagged filter. Display feed
  (RECENT_REVIEW_DISPLAY_STATUSES includes pending_approval) keeps its explicit
  flagged exclusion.
- **#15 db-client-as-param** — `aggregate-queries.ts` and `pending-count.ts` take
  `sql` as a parameter and never import `@/lib/db/server`; `ci:db-imports` strict pass.

## Empty-bucket / edge-case parity

- Zero active locations → same all-zero payload, early return, no slice wave
  issued (test asserts `mockFetchSlices` not called).
- No-review location → gets a baseline row (plain `businesses` select, no join
  gate), so a slice is always built; velocity is zero-filled by the CROSS JOIN
  generate_series, rating breakdown zero-filled by `buildRatingBreakdown`, ranking
  null, brief null. `EMPTY_SLICE` is provably unreachable: `getLocationsForAccount`
  and the baseline query use the identical `account_id AND archived_at IS NULL`
  filter.

## tests_to_add coverage

All seven present and passing: byte-identical parity (aggregate-queries +
aggregate-service composition), windowed rate (+0-denominator), query-count-constant
(2 vs 5 locations → both 8 statements), tenant isolation (account_id on every call +
non-anchor bucket dropped), empty-bucket, #346 authoritative pending >10
(`authoritativePendingCount === 38`, not 4), #405 rating rollup, partialFailures gone
(`'partialFailures' in result === false`).

## Low-confidence appendix (NOT in the table — below 80% or not a production defect)

- **Empty-bucket velocity test asserts `reviewVelocity: []` rather than zero-filled
  weeks.** The locked edge case says a no-review location must yield "velocity
  zero-fill weeks present & zero". In production the zero-fill is done by the
  velocity query's `CROSS JOIN generate_series`, so every active location always
  gets full weeks — the truly-empty-bucket path is unreachable. But because the SQL
  is mocked in unit tests, the actual zero-fill-weeks behaviour is not exercised by
  any test; the empty-bucket test codifies the unreachable `[]` path instead. No
  production divergence, but the promised "velocity zero-fill" parity is asserted
  only indirectly. Consider an integration-level fixture if that guarantee needs teeth.
- **Byte-identical parity tests assert against hand-computed expected values, not a
  literal diff against the old fan-out output.** Parity is by construction (mapper
  reuse), which is a sound argument, but no test pins new == old on a shared fixture
  as the tests_to_add wording ("produces the SAME AggregateDashboardData as the
  current fan-out") could be read to require. Acceptable given the mappers are shared.
- **Counter query adds `resp.business_id = b.id` to the all-time responded join that
  `service.ts` omits.** Results are identical under the data-integrity invariant that
  a response shares its review's `business_id`; a (theoretical) cross-business response
  row would diverge. Defense-in-depth, consistent with the recentReviews join. Not a bug.
