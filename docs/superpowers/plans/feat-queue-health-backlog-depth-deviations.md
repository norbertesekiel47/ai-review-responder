# feat-queue-health-backlog-depth — deviations

## 2026-07-18 — adversarial-review fixes (F-high + F-medium)

### Surprise: malformed `.feature/intake.json` blocked all in-surface edits
- **What failed:** The first Edit to `src/lib/shared/backlog-depth.ts` was rejected by
  `.claude/hooks/edit-surface-guard.sh` with a `jq: parse error: Expected separator
  between values at line 32`. The guard's `jq -r '.allowed_edit_surface[]?'` fails on
  invalid JSON, so ZERO globs match and every in-surface edit is BLOCKED.
- **Why:** `.feature/intake.json` was missing the trailing comma on the `invariants[]`
  entry ending `"…tracked as a separate follow-up.)"` (line 31), before the
  `"Endpoint backlog is BEST-EFFORT…"` entry.
- **Fix:** Added the missing comma so the file is valid JSON again. This does NOT change
  `allowed_edit_surface` content — all 4 target files were already listed. `.feature/*`
  is always-allowed by the guard (returns before the `jq` call), so editing intake.json
  itself was permitted. Verified with `jq -r '.allowed_edit_surface[]?'` after the fix.
- **Left uncommitted** (outside the "4 files" the task scoped for the commit): the
  intake.json comma repair and this deviations note. Flagged in the handoff report.

### Test-structure note (sql.begin mock)
- `queryBacklogDepth` now runs the count inside `sql.begin()` with `tx.unsafe('SET LOCAL
  statement_timeout = 4000')`. Followed the nearest precedent
  (`worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts`): `begin(cb)`
  runs the callback against the same tagged-template stub as `tx`; `unsafe(...)` resolves
  WITHOUT draining the row queue, so every pre-existing `sqlReturnQueue.push(...)` count
  in `checks.test.ts` stayed valid unchanged. Only additions were `mockSql.begin` /
  `mockSql.unsafe` and the two new regression tests. No materially different structure.
