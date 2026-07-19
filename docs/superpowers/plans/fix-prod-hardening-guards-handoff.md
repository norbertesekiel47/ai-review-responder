# Handoff — fix/prod-hardening-guards

**Current step:** 8 (ship) — steps 4–7 COMPLETE. Rebased onto origin/main @ 8e48bb74 (2026-07-19, reconciliation d7779e09). Standards review: 5 findings, 4 accepted+fixed (f97ca010), 1 declined (M2, post-merge cleanup). Spec review: 2 comment-only findings, fixed (23dc0204). Verify gate GREEN on the expanded check set. Remaining: staging ride → smoke → PR → owner merge approval (+ optional owner-invoked /codex:adversarial-review).
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-prod-hardening-guards`
**Branch:** `fix/prod-hardening-guards`, rebased onto `origin/main` @ `10604116` (2026-07-16).

## Authoritative artifacts (read these, not the transcript)

- Spec (owner-approved): `docs/superpowers/specs/2026-07-16-prod-hardening-guards-design.md`
- Plan (8 tasks, TDD): `docs/superpowers/plans/2026-07-16-prod-hardening-guards.md`
- Intake contract: `docs/superpowers/plans/fix-prod-hardening-guards-intake.json` (copied to `.feature/intake.json`; hooks armed — ARM CHECK passed 2026-07-16)
- Deviations log (create on first deviation): `docs/superpowers/plans/fix-prod-hardening-guards-deviations.md`
- Review reports: `docs/reviews/fix-prod-hardening-guards/`

## State

- Scope: P1, P2, P3, P5, P6, P7, P10 (guards). P4/P8/P9 are a follow-up branch — decisions locked in spec §Context.
- All 7 in-scope findings re-verified against current `main` (3 read-only agents, 2026-07-16 evening). No drift affecting fixes. Today's main commits only added Copilot/Autopilot queue registrations (P5's loop-based wiring covers them automatically).
- P3: owner decision overrides the anti-respend carve-out; CLAUDE.md gotcha updated in the same change (plan Task 3 step 6).
- Follow-up-branch note: P8's prescribed fix anchors (`STRIPE_READ_TIMEOUT_MS`, `reconcile-account.ts`, `checkout-completed.ts`) do NOT exist in the tree — re-anchor before implementing. P9: no circuit breaker exists anywhere; per-business Redis concurrency guard caps at 3 (`src/lib/costs/concurrency-guard.ts:17`), distinct from BullMQ concurrency.
- `.feature/` is NOT gitignored — never `git add -A`; use explicit paths (plan commits already do).

## Remaining

1. Codex adversarial plan review → APPROVED (max 3 rounds).
2. Execute plan Tasks 1–7 via fresh per-task subagents (TDD, commit per task).
3. Task 8: `scripts/verify-gate.sh` from worktree root (writes `.feature/gate-status.json`).
4. Step 6: PAUSE — ask owner to run `/codex:adversarial-review` (user-invocable only).
5. Step 7: two parallel review agents (spec-vs-intake + `/thermo-nuclear-code-quality-review`), reports to `docs/reviews/fix-prod-hardening-guards/`, triage, re-gate.
6. Step 8 (high lane): push branch to `staging` ride, smoke webhook ingress + dashboard + generation cycle, PR to `main`, CI green, PAUSE for owner merge approval.
