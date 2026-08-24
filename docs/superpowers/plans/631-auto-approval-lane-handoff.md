# #631 Auto-approval lane — session handoff

A resumed session bootstraps from this file. Disk beats any summary.

## Artifacts (read in this order)

1. Intake (drift detector): `docs/superpowers/plans/631-auto-approval-lane-intake.json`
   — includes surface amendment 1 of 2 (notifications tree + config/worker.ts +
   whatsapp-templates runbook), owner-approved 2026-08-23.
2. Plan: `docs/superpowers/plans/2026-08-23-631-auto-approval-lane.md`
   — 9 tasks, eval-first, task graph at the bottom; locked design decisions at the top.
3. Deviations: `docs/superpowers/plans/631-auto-approval-lane-deviations.md`
4. Glossary: `CONTEXT.md` § "Solicitation (send-mode)" (lines ~59-86) — LOCKED terms.
   New terms to coin in Task 9: Auto-approval lane, Veto notice, Veto anchor.
5. Governing spec: `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md`
   (D9/D18/D19/D20) + `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md`
   (wins on conflict).

## Current step / state

- Phase: `.feature/state.json` (worktree_ready; plan review round 1 in flight).
- Plan review round 1: the companion-runtime dispatch (task-mt6kk8hy-u0ut5m)
  was LOST by the wrapper — the known failure mode. Re-dispatched 2026-08-23 via
  DIRECT `codex exec --sandbox read-only` from the worktree root; stdout goes
  straight to `docs/reviews/631-auto-approval-lane/plan-round-1.md` (codex
  session id in that file's header / scratchpad codex-r1-stderr.log).
- Gate: RED on `feature-surface` only — pre-implementation artifact (two surface
  entries match no file until Tasks 1-2 create them). 18/19 audits PASS.
- Branch: `631-auto-approval-lane`; commits `d718f871` (intake), `1eec2f47` (plan).

## Owner decisions locked this session

1. Veto-deadline anchor = releaser anchor phase (not webhook hooks).
2. Opt-in ships UI: extend /settings/auto-approval (SURFACE = mixed).
3. Auto flag off at release ⇒ downgrade unreleased auto_policy batches to owner review.
4. Surface amendment 1 approved (src/lib/notifications/**, src/lib/config/worker.ts,
   docs/runbooks/whatsapp-templates.md).

## Next actions

1. Collect codex round-1 verdict → triage → revise plan or proceed.
2. `bash scripts/feature-state.sh set-phase plan_approved` on APPROVED (or owner call after round 3).
3. Step 4: dispatch Task 1 (eval) ALONE → first-task enforcement spot check → serial 2→3→4 → parallel {5,6,8} → 7 → 9.
4. Gate after every task; final `scripts/verify-gate.sh --review`.
