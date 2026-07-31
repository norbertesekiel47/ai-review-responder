# Handoff — feat-628-ask-generation-lane

**Phase:** `gate_green` (all 12 plan tasks executed, per-task dual reviews
passed, full `verify-gate.sh --review` GREEN incl. diff-coverage at HEAD
`60125aae`, 2026-07-31). **Next step: 6 — adversarial review** (RISK=high ⇒
`/codex:adversarial-review`, USER-INVOKED; codex session for steps 6–7
context: `codex resume 019fb5dc-2eb6-7480-a232-d41aea5a425e`).

## Bootstrap order (read in this order, nothing else needed)

1. **Intake (drift detector):** `docs/superpowers/plans/feat-628-ask-generation-lane-intake.json`
   — amended 4× during execution (all recorded in the deviations file,
   ALL PENDING OWNER RETROACTIVE SIGN-OFF): worker/queues.ts (Task 9);
   two requests-UI fixtures (Task 11); startup-assertion.test.ts (Task 12);
   four gate-tripwire/assertion test files + runnable verification_commands
   (Task 12 gate round).
2. **Plan:** `docs/superpowers/plans/2026-07-30-628-ask-generation-lane.md`
3. **Deviations (now the primary review artifact):**
   `docs/superpowers/plans/feat-628-ask-generation-lane-deviations.md` —
   every task's deviations were adjudicated inline by per-task spec reviewers
   (all ACCEPT); step 6.5 owner triage should confirm the verdicts, especially
   the four intake amendments and the Task 8 interface deviation
   (`business_id` in `GenerateSolicitationAsksPayload` — #629's enqueue must
   pass it).
4. Governing specs as before (banner: §5 table superseded; AMEND wins).

## Session facts

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-628-ask-generation-lane`,
  branch `feat-628-ask-generation-lane`, based on main @ 44de0a79; 13 commits
  (intake, plan, handoff, Tasks 1–12; Task 8 = two commits).
- **Merge order (owner-approved): #625 merges first; this branch REBASES over
  it before its review rounds land** — collision file `batch-builder.ts`.
  #625 had NOT merged as of this checkpoint (main still 44de0a79).
- Gate mechanics learned this run: the gate flakes under its own load on this
  machine at default `MAX_PARALLEL=4`/`VITEST_WORKERS=4` (arbitrary timeouts
  in untouched suites; three distinct false-red runs). `MAX_PARALLEL=2
  VITEST_WORKERS=6` runs clean. The 5 changed live-DB integration suites run
  GREEN via the gate's "extra" verification row (39/39) — the
  `integration-suites SKIP` warning row is redundant with it.
- `reclassify WARN` is real: actual diff 8262 lines vs 3200 estimate (~2.6×,
  test-dominated). The workflow's re-classification trigger fired; owner may
  waive or re-classify at review.
- Remaining post-review steps: step 8 rides staging first (flag-off no-op
  smoke ONLY pre-#627 — the postal-address column doesn't exist; full-path
  proof belongs to the #633 runbook campaign). `SOLICITATION_SEND_ENABLED`
  must not be set anywhere before #627 lands.

## Glossary anchors (use verbatim)

Solicitation (never "Solicitor") · ask · render/outreach row · attempt ·
supersede · withheld vs cancelled vs failed (091 vocab) · lint_failed folding
(AMEND B1) · blocked-is-terminal · generate-then-approve · byte-for-byte
stored bytes · placeholders (B4) · send parent (`solicitation_send_batch`) ·
releasable.
