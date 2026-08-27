# feat-qr-review-request — handoff

A resumed session bootstraps from THIS file, then the artifacts below. It
never needs the prior transcript.

## Artifacts (read in this order)

1. Intake contract (signed off 2026-08-26, RISK=high, SURFACE=mixed,
   db_touching): `docs/superpowers/plans/feat-qr-review-request-intake.json`
   — the arming copy is `.feature/intake.json`; keep BOTH in sync.
2. Plan: `docs/superpowers/plans/2026-08-26-qr-review-request.md`
   (6 tasks; Task 1 = eval suite; edges + parallel groups in "File structure").
3. Glossary: `CONTEXT.md` → sections **Review QR** and **QR redirect**
   (added on this branch — commit rides with the feature).
4. Deviations: `docs/superpowers/plans/feat-qr-review-request-deviations.md`
   (amendment #1 = narrowing: owner PNG endpoint dropped; one test retitle).
5. Machine state: `.feature/state.json` (phase + review-round counters).

## Owner decisions locked at grill (do not re-litigate)

- Redirect key = business UUID at `/q/<businessId>` (no token column).
- Redirect gate = subscription: `subscriptionAllowsQrRedirect` admits exactly
  {active, trialing, past_due}; pending_payment/cancelled → unavailable page.
- Owner surface = NEW settings section `/settings/review-qr` (not behind the
  locations flag).
- Deliverable = PNG (~2048px data URL) + browser print view; no PDF dep.

## Plan-review state (RISK=high gate)

- Prevalidation: PASS (2 citations, 3 fixtures, 0 stale).
- Codex round 1: session id `01a0413c-6e7b-73c1-b3d8-9179f84d4b1c`.
  First run hit the 10-min foreground cap mid-investigation; resumed in
  background → verdict log `.feature/logs/codex-plan-r1b.log` (first-run log:
  `.feature/logs/codex-plan-r1.log`). Verdict: PENDING at the time of this
  writing — read the r1b log tail for `VERDICT:`.
- Round cap: 3 (counter `planReviewRounds` in `.feature/state.json`, already
  at 1). Rounds 2-3 are verification-only deltas to the SAME codex session.

## Environment facts a resumed session needs

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-qr-review-request`
  (sibling; prefix every Bash with `cd <worktree-root> && …`; the shell cwd
  resets between calls).
- Baseline gate ran docs-only: all rows PASS except `feature-surface`, which
  fails until the surface's new files exist (self-heals as tasks land; the
  dropped-endpoint entry was already removed).
- Migration head is 114; this feature owns **115** (LOCAL-ONLY until step-8
  promotion). `ci:analytics-events` forces migration + `events.ts` registry
  into the same commit (plan Task 2).
- Parent checkout has uncommitted `docs/roadmap/` from another session —
  never absorb it into this branch.

## Next step

On codex `VERDICT: APPROVED` (or owner call after round 3):
`bash scripts/feature-state.sh set-phase plan_approved`, then step 4 —
`subagent-driven-development`, Task 1 ALONE first (enforcement spot check:
diff `git status --porcelain` against `allowed_edit_surface` after it lands),
then Task 2 ∥ Task 3, then Task 4, then Task 5 ∥ Task 6. Gate (step 5) only
after every subagent has returned; record the SHA the gate ran at.
