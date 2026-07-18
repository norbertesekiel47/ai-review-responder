# Step 7 review triage — perf/478-cache-kpi-dashboard

Two-axis review on `git diff main...HEAD`. Full reports: `spec-correctness.md`,
`standards-maintainability.md`.

## Spec & correctness — VERDICT: PASS
- No high-confidence findings. All 9 checks hold (tenant-key isolation,
  fail-open both directions, BusinessNotFoundError never cached, JSON round-trip
  parity, key correctness incl. rep/norep + opts.business exclusion, no
  out-of-surface drift, no non-goal violations).
- Informational: #487 aggregate cache (45s) now sits atop the new per-location
  cache (45s) → `scope=all` staleness worst-case ~90s. **ACCEPTED** — freshness
  not correctness; within locked non-goals (pure TTL, leave #487 intact).

## Standards & maintainability
- **Minor** — log prefix `[kpi]` vs sibling path-style `[dashboard/service]`.
  **ACCEPTED + FIXED** → `[kpi/service]` (`src/lib/kpi/service.ts`).
- **Major** — fail-open block is a 4th inline copy; extract `cacheReadThrough<T>`.
  **ACCEPTED-AS-VALID, DEFERRED** (user decision). A proper fix needs a new
  module + a 2nd surface amendment and should migrate ALL FOUR sites including
  #487's aggregate (a declared non-goal of this ticket); a partial 3-of-4
  extraction would leave an inconsistent split. Filed as a follow-up ticket for
  its own `/feature` run. Rejected for THIS PR on small-diff + non-goal grounds;
  correctness is unaffected.
