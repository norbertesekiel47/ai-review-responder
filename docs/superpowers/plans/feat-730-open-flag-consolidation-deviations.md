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

## Execution (T1) — surface amendment #1, spelling-only

- **[2026-08-09] SURFACE AMENDMENT #1 (spelling-only, zero path-scope
  change): the two `[reviewId]` surface entries respelled with `*`.** T1's
  implementer was blocked landing the title #9 `.todo` stub:
  `edit-surface-guard.sh` matches with bash `[[ == ]]` (unquoted pattern),
  so `[reviewId]` parses as a character class and the literal bracketed
  directory can never match its own entry — T4 (route.ts under the same
  dir) would hit the identical wall, making plan v4 unexecutable as
  spelled. Escaping (`\[reviewId\]`) was rejected: it fixes the hook but
  breaks the merge-time mirror `scripts/ci/feature-surface-audit.ts`, whose
  `globToRegExp` escapes the backslash literally (the two engines disagree
  in BOTH bracket spellings). The `*` respelling
  (`src/app/api/dashboard/reviews/*/draft-status/route.ts` + `…/__tests__/**`)
  is the only spelling both engines accept — verified by direct test in
  each engine before applying — and it restores the audit's documented
  assumption ("character classes are NOT supported (no intake uses them)").
  Both intake copies updated together. Orchestrator classification, for
  owner review at step 6: recorded as amendment #1 for the abort budget
  (a 2nd, genuinely broadening amendment aborts), but NOT treated as the
  reclassification STOP trigger — that trigger targets scope growth
  revealing lane misclassification, and this amendment adds zero files to
  the intended surface (the committed intake already named these exact
  paths through three review rounds; the merge-time audit already matched
  them literally).

## Execution (T4) — plan gap: T2's blast radius wider than its run commands

- **[2026-08-09] T2's `hasOpenFlag` re-expression silently broke 9 tests in
  three suites the plan never ran between T2 and T4** (`publish.test.ts`,
  `draft.test.ts`, `draft-id.test.ts` under
  `src/app/api/dashboard/past-replies/__tests__/`). Root cause: the
  re-expressed body issues fragment BUILD calls (`tx`${id}::uuid``, the
  EXISTS fragment) that queue/positional `tx` doubles consume or index past
  — exactly the failure mode the plan's fragment-aware-double section
  predicted, but its "every queue-based suite touched by migration" list
  missed that T2 alone (not just T3-T6 call-site swaps) touches every suite
  whose double flows through `hasOpenFlag`. Discovered at T4 Step 4 because
  its vitest path (`src/app/api/dashboard/past-replies`) is a directory
  sweep. Verified pre-existing at f4f93ab8 via stash. Triage: ACCEPT — fixed
  inside T4 (files are in T4's declared surface; same fragment-aware
  pattern), amended into the T4 commit. Follow-through for T5-T7: any suite
  whose double passes through `hasOpenFlag` or a migrated call site needs
  the fragment-aware branch BEFORE its first post-migration run.

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
