# Deviations — fix/1149-mfa-second-factor-name

## D1 — [2026-09-21] Gate `test` row red on the guard self-test, caused by the session's containment escape

Full gate's `test` row failed on `scripts/ci/__tests__/edit-surface-guard-worktree.test.ts` (4 assertions expecting exit 2, got exit 0) → this session's environment carries `WORKTREE_EDIT_GUARD_DISABLE=1` (the documented escape the owner applied because the swarm root session is itself a linked worktree). That var is not `GIT_`-prefixed, so it survives the test's own env filtering and leaks into the `pnpm test` subprocess tree, neutering the guard the test exercises. Confirmed by: (a) `git diff --stat` shows none of the guard scripts or their test are touched by this branch; (b) running the same test file with the var explicitly unset (`env -u WORKTREE_EDIT_GUARD_DISABLE`) turns all 4 failures green; (c) a from-scratch manual repro of the guard outside vitest reproduces the same exit-0-instead-of-2 only with the var set. Not a defect in this change or in the codebase at HEAD. What was done: the second and third full/fast/review gate invocations ran as `env -u WORKTREE_EDIT_GUARD_DISABLE bash scripts/verify-gate.sh ...` — scoped to that one subprocess tree only, not unsetting the var in the session itself (the harness's PreToolUse hook still needs it for any further edit). This is a gate-invocation change, not a code or intake change; no locked decision is affected.

**Verdict:** ACCEPT — environmental, not a branch defect. CI never sets the variable, and the gate evidence was produced with it unset, which is the CI-equivalent condition. The root runs every later gate the same way. Lesson to promote after merge (lab-notes/ci-tooling.md): a `/feature-swarm` root in a linked worktree needs the escape for edits and `env -u` for gates.

## D2 — [2026-09-21] Three T1 test titles first written as nested describe + short `it()` strings

The `promised-tests` row greps one literal string per title, so a `describe('nextFactorFriendlyName')` + short `it()` split was invisible to it. Self-corrected in the same round: the three `it()` strings are now the verbatim promised titles.

**Verdict:** ACCEPT — no behavior change; the titles now match the intake verbatim.
