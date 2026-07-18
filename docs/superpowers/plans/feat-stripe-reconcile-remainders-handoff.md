# Handoff — #479 Stripe reconcile remainders

Resume with `/feature-resume feat/stripe-reconcile-remainders` from the worktree
root `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-stripe-reconcile-remainders`.
Bootstrap order: this doc → intake → plan → ADR → (later) deviations + review tables.

## State
- **Current step: 4 (EXECUTE).** Steps 0-3 complete and signed off.
- Branch `feat/stripe-reconcile-remainders`; first commit = the intake contract.
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

## Remaining work (tracer order T1 → T2 → T3)
- **T1** migration 079 (`poller_cursors` w/ `write_seq`) + `cursor-store.ts` CAS +
  `runOnce.finally` save + boot-seed + tests (incl. the decisive detached-save CAS
  regression). Blocked by: none.
- **T2** migration 080 (plain composite `(subscription_status, id)` CONCURRENTLY) +
  migrations-log; staging `EXPLAIN` is a ride-time gate. Blocked by: T1.
- **T3** `truncation-alert.ts` + `reconcile-progress.ts` (`classifyCycle`,
  `evaluateTruncation`) + `runOnce` wiring + tests. Blocked by: T1.

## Gate (step 5)
`scripts/verify-gate.sh` — lint, typecheck, test, all `ci:*` (incl. tenant-scope,
rls-audit). `pnpm build` N/A (backend). Property tests (fast-check) required for the
CAS-monotonicity and truncation state-machine invariants.

## Next actions after execute
Step 6 adversarial review (user runs `/codex:adversarial-review`), step 7 dual review,
step 8 SHIP via staging (migrations staging-first, both Supabase projects lockstep).
