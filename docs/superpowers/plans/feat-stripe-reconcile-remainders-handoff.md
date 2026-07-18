# Handoff — #479 Stripe reconcile remainders

Resume with `/feature-resume feat/stripe-reconcile-remainders` from the worktree
root `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-stripe-reconcile-remainders`.
Bootstrap order: this doc → intake → plan → ADR → (later) deviations + review tables.

## State
- **Current step: 8 (SHIP) — next up.** Steps 0-7 complete.
- Branch `feat/stripe-reconcile-remainders`. Commits: intake → plan/ADR/handoff →
  T1 `1c1ae829` (cursor+CAS) → T2 (index 080) → T3 `4f3b8d35` (truncation alert) →
  review fixes `cce0de91` (1a/2a/2b/3) → step-7 triage fixes (this commit).
- **Verify gate: GREEN** (re-run after the step-7 triage fixes); `.feature/gate-status.json`
  fresh (ts 1784344125; 16/16, 8703 tests pass).
- **Step 7 dual-axis review DONE.** Two fresh agents on the branch diff since fork
  `96b4f28c`. Full reports + triage verdicts in `docs/reviews/feat-stripe-reconcile-remainders/`
  (`spec-correctness.md`, `standards-maintainability.md`, `TRIAGE.md`). Both axes
  passed; 4 confidence-filtered findings, all comment-level:
  - S1 (MED), S2 (LOW), S3 (LOW): ACCEPTED — stale-comment fixes (stall-resets-counter
    per FIX 2b; boot-load is lazy first-tick per FIX 3; file-header scope includes
    `trialing`). Comment-only, no behavior change.
  - F1 (LOW): behavioral change REJECTED (removing the `accountCursor` re-seed would
    discard durable rotation progress and make the persisted value race-dependent —
    the durable re-seed is deliberate + safe under never-skip; see TRIAGE.md). Accepted
    as a doc gap: clarified the finally comment + added a lock-in regression test.
- **Step 6 adversarial review DONE**: ran via the Codex rescue agent (the
  `/codex:adversarial-review` slash command is user-only). Triage:
  - FIXED: 1a boot-load-failure CAS re-seed; 2a non-timeout-error no longer
    classified truncated (outcome threaded into `classifyCycle`); 2b literal
    consecutiveness (stall resets the streak); 3 boot-load deferred to first tick.
  - REJECTED (documented): 1b cross-process fencing (single-replica posture,
    map #474 / update_stripe_overage); 2c thrown-emit retry (emitter non-throwing,
    warning-level); 4 persist-previous-frontier-on-truncation (documented never-skip
    re-walk, safe); 5 index shape (staging EXPLAIN gate is the validation).
- RISK=high, backend, db-touching → staging ride before `main` (step 8).

## Enforcement environment (important)
- **edit-surface guard: ARMED** (file-anchored; enforces `allowed_edit_surface`,
  blocks wrong-tree edits). Verified via ARM CHECK.
- **stop-gate: ARMED** at real Stop time (`$CLAUDE_PROJECT_DIR` resolves to the
  worktree; an earlier Bash-subshell ARM CHECK gave a false "disarmed" because the
  subshell env lacks `$CLAUDE_PROJECT_DIR`). Manual gate-evidence discipline also
  in force: run `scripts/verify-gate.sh` and cite `.feature/gate-status.json`
  before any completion claim.
- Harness resets Bash cwd to the PARENT checkout each call — use `git -C <worktree>`
  / absolute paths; never `cd`-pin. All Write/Edit paths must target the worktree.

## Authoritative artifacts (read, don't restate)
- Scope: `.feature/intake.json`
- Plan (Rev 5, final): `docs/superpowers/plans/feat-stripe-reconcile-remainders-plan.md`
- Decision rationale: `docs/adr/0006-poller-cursor-persistence-ordering.md`
- Target module: `worker/background/pollers/StripeLocationsReconcilePoller.ts`
- Alert precedent: `worker/background/pollers/billing-reconciliation/drift-alert.ts`

## Plan review trail
- Codex adversarial plan review ran **4 rounds** (all REVISE, each finding sharper
  real edges). Final design (write-sequence CAS + corrected never-skip invariant)
  was chosen by the user after the 3-round cap was reached; not re-submitted to
  Codex. The built code still gets step-6 (adversarial) + step-7 (dual-axis) review.

## Remaining work
- **Step 8 — SHIP (RISK=high lane) (NEXT).** Land on `staging` (full-stack auto-deploy),
  apply migrations 079+080 to the **staging** Supabase project FIRST, run the
  **mandatory `EXPLAIN (ANALYZE, BUFFERS)`** on the reconcile query (cursor-null +
  cursor-set) to validate/decide index 080, smoke the poller. Then PR to `main`,
  all CI green, PAUSE for explicit merge approval; apply migrations to prod Supabase
  in lockstep at promotion. After merge: `git pull --ff-only` main, ff `staging` onto
  `main`, remove the worktree, `document-feature` sweep, bump the arch-review counter.

## Gate (step 5) — GREEN
`scripts/verify-gate.sh` — lint, typecheck, test (8696), all `ci:*` incl. tenant-scope
+ rls-audit. `pnpm build` N/A (backend). Property tests (fast-check) cover the
CAS-monotonicity + truncation state-machine invariants. Re-run after each fix round.

## Enforcement reminder for the resumed session
Re-run the ARM CHECK on resume. The stop-gate arms from `$CLAUDE_PROJECT_DIR`
(= worktree at real Stop time); a Bash-subshell probe reports it "disarmed" (no
`$CLAUDE_PROJECT_DIR` there) — that's a false negative, trust the real Stop firing.
Manual gate-evidence discipline also applies: cite a fresh `.feature/gate-status.json`
before any completion claim, staging ride, or PR.
