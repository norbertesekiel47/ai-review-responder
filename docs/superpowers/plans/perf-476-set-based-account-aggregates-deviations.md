# Deviations — #476

- **Step 4 execution done in-session (not via fresh subagents).** Rationale: byte-identical
  parity depends on exact reuse of existing dashboard mappers (`buildValueSummary`,
  `buildRanking`, `buildRatingBreakdown`, brief-picking). A context-poor subagent is more
  likely to reinvent these and silently break parity than an orchestrator holding the full
  call-graph context. Implemented directly with red-green TDD, one commit per tracer ticket.
  Fresh-agent independent review is retained at step 7 (unchanged). User was in "proceed, I
  self-enforce" mode.
- **Enforcement:** edit-surface guard is mechanically armed (file-anchored). Stop-gate is
  disarmed in this harness (anchors on the main checkout, not the sibling worktree — see ARM
  CHECK probe 2a). Self-enforcing the verify gate: no completion claim without a green
  `.feature/gate-status.json` from `scripts/verify-gate.sh`.
- **Windowed account rate folded into the set-based wave.** `getTotalReviewsForAccount`/
  `getTotalRespondedForAccount` deleted rather than windowed-in-place; the windowed account
  rate derives from the sum of per-location windowed counts (equal because locations partition
  reviews by `business_id`). Satisfies the intake goal with fewer queries; flagged for the PR.

## Implementation deviations (step-4 build)

- **Pending-count ownership = fetch-owns (not a separate service call).** The locked
  `PerLocationAggregateSlice` interface declares `pendingApprovalCount`, so
  `fetchPerLocationAggregateSlices` calls `getPendingApprovalCountsForAccount` inside its own
  `Promise.all` wave and populates the field; the service reads `slice.pendingApprovalCount`
  for `locationKpis`. This avoids both a duplicate pending query and a dead interface field.
  The spec's REWIRE phrasing ("…call plus `getPendingApprovalCountsForAccount`") and the
  "mock both in the service test" note were interpreted as: the pending rollup is part of the
  slice wave. Net effect on tests: the service test mocks `fetchPerLocationAggregateSlices`
  (which subsumes pending) and drives the #346 regression through the mocked slices;
  `getPendingApprovalCountsForAccount`'s real bucketing is unit-tested directly in
  `aggregate-queries.test.ts` (tenant scope + `GROUP BY resp.business_id`). #346 is preserved:
  the slice test proves pending is sourced from the authoritative count, and the service test
  proves it diverges from the capped `recentReviewCount`.

- **Counters + velocity SQL rewritten to keep `responses`/`reviews` in the MAIN query.** The
  spec's exact SQL scoped `responses` inside a per-count `EXISTS` subquery (counters) and
  `reviews` inside a pre-aggregation subquery (velocity). The `ci:tenant-scope` scanner strips
  SELECT subqueries before predicate analysis, so a tenant table scoped only inside a subquery
  is flagged and would need a new `tenant-scope-allowlist.ts` entry (outside this task's edit
  surface). Rewrote both to statically-provable scope, semantically identical:
  - Counters: `LEFT JOIN responses … ON resp.review_id = r.id AND resp.business_id = b.id AND
    resp.status = ANY(HANDLED)` in the main query + `COUNT(DISTINCT r.id)` (DISTINCT makes the
    counts robust to the response fan-out).
  - Velocity: `LEFT JOIN reviews rv … ON rv.business_id = b.id AND … AND
    DATE_TRUNC('week', rv.detected_at)::date = gs::date` bucketed directly (a review matches
    exactly one gs week, so a plain `COUNT(rv.id)` is exact and still zero-filled by the
    `businesses × generate_series` cross join). All new queries now pass `ci:tenant-scope`
    with NO new allowlist entries.

- **BLOCKER for the verify gate (out-of-surface): orphaned tenant-scope allowlist entry.**
  Deleting `getTotalRespondedForAccount` orphans its allowlist entry in
  `scripts/ci/tenant-scope-allowlist.ts` (≈ line 1310, `file: "src/lib/dashboard/aggregate-service.ts",
  table: "responses"`, the `SELECT COUNT(DISTINCT r.id) … JOIN responses …` snippet). The audit
  treats an unused allowlist entry as a hard failure, so `pnpm ci:tenant-scope` reports exactly
  one finding: `aggregate-service.ts: responses: unused tenant scope allowlist entry`. This file
  is outside this task's edit surface — the orchestrator must delete that single allowlist entry
  for `ci:tenant-scope` to go green. No other audit is affected (rls-audit, db-imports, lint,
  typecheck, and `pnpm vitest run src/lib/dashboard` are all green).
