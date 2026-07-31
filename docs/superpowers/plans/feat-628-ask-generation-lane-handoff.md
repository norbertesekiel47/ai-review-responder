# Handoff — feat-628-ask-generation-lane

**Phase:** `plan_approved` (owner signed off 2026-07-30 after a 3-round codex
adversarial review). **Next step: 4 — EXECUTE** via
`superpowers:subagent-driven-development`, task-by-task from the plan.

## Bootstrap order (read in this order, nothing else needed)

1. **Intake (drift detector):** `docs/superpowers/plans/feat-628-ask-generation-lane-intake.json`
   — edit surface, 24 VERBATIM promised test titles, invariants.
2. **Plan (the work):** `docs/superpowers/plans/2026-07-30-628-ask-generation-lane.md`
   — 12 tasks with blocking edges; header carries 10 LOCKED decisions (3 grilling +
   7 adversarial-round resolutions). Do not re-litigate any of them.
3. **Deviations:** `docs/superpowers/plans/feat-628-ask-generation-lane-deviations.md`
   — #625 merge-order agreement, postal-address inert-landing, spec-gap resolutions.
4. **Governing docs** (slices are named per task in the plan):
   `docs/superpowers/specs/2026-07-28-ask-generation-design.md` (banner!),
   `…-send-mode-cross-spec-amendments.md` (B1/B2/B4/B5/B10 — wins on conflict),
   `…-send-mode-executor-approval-design.md` (D3/D14/D17/D21).

## Session facts a resumed session needs

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-628-ask-generation-lane`,
  branch `feat-628-ask-generation-lane`, based on main @ 44de0a79. Enforcement ARMED
  (re-run `scripts/arm-check.sh` on resume). Prefix every Bash command with
  `cd <worktree-root> && …`; absolute worktree paths for all Edit/Write.
- **Merge order (owner-approved):** #625 (consent ledger) merges first; this branch
  REBASES over it before gate/review rounds. The collision file is `batch-builder.ts`.
- **Execution discipline:** fresh subagent per task; each prompt carries the task's spec
  slice + blocking-edge context; subagents append surprises to the deviations file, never
  dump context. TDD where specifiable. Commit per completed task.
  **First-task enforcement spot check** (workflow step 4): after the first subagent
  completes, diff `git status --porcelain` against the intake's `allowed_edit_surface`;
  an out-of-surface file ⇒ STOP.
- Task order respecting blocking edges: 1 → 2, and 3/4/9 parallel-safe; 5 after 4;
  6 after 5; 7 independent; 8 after {2,3,5,6,7}; 10 after {8,9}; 11 after 7; 12 last.
- Live-DB tasks (7, 8-integration, 11-RLS test) need `TEST_DATABASE_POOL_URL`; provision
  with `pnpm test:db:setup` if the local test DB is behind head (head = 092).
- Step 5 gate: `bash scripts/verify-gate.sh` after each fix round; final pre-review run
  with `--review` (diff coverage). Codex review session for steps 6–7 context:
  `codex resume 019fb5dc-2eb6-7480-a232-d41aea5a425e`.
- RISK=high ⇒ step 6 (`/codex:adversarial-review`, user-invoked) and step 8 rides
  staging first. Full-path staging smoke is NOT possible pre-#627 (postal-address
  column) — flag-off no-op smoke only; full proof belongs to the #633 runbook campaign.

## Glossary anchors (use verbatim)

Solicitation (never "Solicitor") · ask · render/outreach row · attempt · supersede ·
withheld vs cancelled vs failed (091 vocab) · lint_failed folding (AMEND B1) ·
blocked-is-terminal · generate-then-approve · byte-for-byte stored bytes ·
placeholders (B4) · send parent (`solicitation_send_batch`) · releasable.
