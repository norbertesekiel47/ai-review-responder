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

- Phase: `plan_approved` (`.feature/state.json`), head `b80aa5c6`. Step 4
  (execution) is next: Task 1 (eval) dispatches ALONE, then the first-task
  enforcement spot check, then 2 → 3 → 4 serial, then parallel {5, 6, 8},
  then 7, then 9.
- Plan review: 3 rounds, counter at 3/3. Round 1 REVISE (14 findings, all
  triaged ACCEPT — see deviations file); round 2 left F3/F14 + a nit; round 3
  **VERDICT: APPROVED**. Reports:
  `docs/reviews/631-auto-approval-lane/plan-round-{1,2,3}.md`. Codex session
  `01a0316f-1ea8-73e3-8dfd-d4876710ba22` (direct `codex exec`; the companion
  wrapper lost its task — do not use the wrapper for later rounds).
- Intake is REV 2 (owner-re-locked; amendment counter reset; 44 promised test
  titles). Plan is REV 2.1.
- Gate: RED on `feature-surface` only — pre-implementation artifact (two
  surface entries match no file until Tasks 1-2 create them). All other audits
  PASS.
- Branch: `631-auto-approval-lane`; key commits `d718f871` (intake rev 1),
  `1eec2f47` (plan rev 1), `80ad7169` (rev 2), `b80aa5c6` (APPROVED).

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
