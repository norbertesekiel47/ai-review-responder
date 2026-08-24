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

## Post-step-7 state (2026-08-24) — READ THIS FIRST ON RESUME

Phase: **reviewed**, head `f078aa09`, GATE GREEN (incl. `--review`
diff-coverage). The reclassify WARN is permanent and owner-adjudicated
(record-and-continue; disclose in the PR description).

- Execution: Tasks 1-9 complete + fix rounds. Full `pnpm test` 13,046 green.
- Step 7: 3 axes round 1 (spec NO FINDINGS; quality 7 accepted; adversarial
  4 → A2 accepted narrowly, A4 comment, A1/A3 rejected — A3 filed as #949,
  A1 rejection cites dispatch.ts:11-13's locked seven-item B6 gate). Round 2:
  both axes APPROVED. Reports + triage: docs/reviews/631-auto-approval-lane/.
- Owner overrides on record: 3rd-surface-file override; reclassify
  record-and-continue; amendment budget exhausted.

## Next actions — STEP 8, RISK=high lane

1. Ride staging FIRST: push the branch onto `staging` (full stack
   auto-deploys). Apply migration 113 to the STAGING Supabase project first
   (lockstep rule; index-only). Smoke the touched path per
   docs/runbooks/channels-staging-smoke-test.md analog: flags stay OFF —
   deploy-inert proof is sufficient for #631 (#633 owns the flips).
2. Open the PR to `main` (gh pr create; fill the PR number into the #631 row
   of .claude/reference/arch-review-log.md in the same push). PR body: intake
   rev history, the reclassify disclosure, the two rejected adversarial
   findings with both positions, #949 link, deviations pointer.
3. Confirm ALL CI checks green. Then PAUSE for the owner's explicit merge
   approval (RISK=high). At promotion: migration 113 to prod Supabase in
   lockstep. All flags stay OFF in prod.
4. After merge: pull --ff-only main; re-sync staging per deployment-guide
   §"Re-sync staging" (squash-merge ⇒ reset --hard + --force-with-lease,
   never a sync merge); `bash scripts/feature-cleanup.sh` dry-run then
   --apply; deviations promotion sweep (lab-notes/CLAUDE.md); invoke
   document-feature; domain sweep; entropy counter +1 in arch-review-log.md.
