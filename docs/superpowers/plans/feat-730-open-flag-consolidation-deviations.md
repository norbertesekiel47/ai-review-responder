# feat-730-open-flag-consolidation — deviations log

Entries the plan did not anticipate, one per item. Step 6 triages each with
ACCEPT / RE-PLAN before review.

## Setup-time notes

- **[2026-08-09] Surface overlap with `feat-719-drip-dropped-column` on
  `scripts/ci/tenant-scope-allowlist.ts` — no entry collision, merge order
  agreed.** feat-719's diff touches only the `ONBOARDING_DRIP_CANDIDATES_SQL`
  constant (~line 130); #730 regenerates entries in the load-replies /
  dashboard / draft-status / agents-read regions (lines ~550–1300+, ~3040).
  Disjoint hunks. Agreed order: PR #740 merges first (CI-green, auto-merge
  armed since 11:17a); #730 rebases onto main before opening its PR if #740
  has landed by then. feat-719's deviations file was deliberately NOT
  updated: its PR is at the finish line and its worktree must stay clean for
  `feature-cleanup.sh` to sweep it — this file is the single record of the
  agreement.

## Plan-review round 1 (codex, VERDICT: REVISE) — intake corrections

Owner-approved intake-field corrections (NOT surface amendments; the
amendment counter is untouched — `allowed_edit_surface` is unchanged):

- **[2026-08-09] `edge_cases` wrongly listed pending-count among the
  regenerating allowlist entries** → corrected to the six real entries
  (~327/~1285/~1509/~1516/~1530/~1537); pending-count is directly scoped and
  has NO entry (codex MINOR).
- **[2026-08-09] `tests_to_add` grew 5 → 11 titles** after codex named six
  missing failure modes as missing tests (live hasOpenFlag verification,
  newest-unheld fallback, grouped-count cross-business guard, alias
  correlation, LATERAL placement/polarity, source-scan). One partial-accept:
  the dashboard-LATERAL finding asked for live behavior coverage; a live
  dashboard-service suite was rejected as disproportionate — unit
  placement/polarity pins + the live property on the identical filtered
  composition (pending-count) cover the named regressions. Both intake copies
  updated; `estimated_test_lines` corrected ±300 → ±450.
- **[2026-08-09] v1 plan's mock claim was factually wrong** (queue-based
  route doubles would consume queued rows on fragment-build calls) and the v1
  property test was unrunnable (`loadReplies` does not exist; suite baseline
  counts non-zero). Plan v2 fixes both — fragment-aware double pattern,
  `loadPastRepliesPageView` + isolated business. T6 parallelism dropped
  (shared Git index, `git add -A` hazard) — all tasks serial, path-scoped
  staging.
