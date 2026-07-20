# Handoff — fix/verification-remainders

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-verification-remainders`
Branch: `fix/verification-remainders` (base: main @ eaf4f3f2)

## State

- Step 1 GRILL: complete. 4 decisions + 1 codex-surfaced decision locked; see
  intake. Key user decisions: add both indexes (082); boot assert; no
  backfill guard (comment only); hygiene included; **enforce cap at 9 with
  generate_demo included + amend ADR 0005 addendum** (codex found #490's
  inventory missed generate_demo).
- Step 2 SETUP: worktree created, intake committed, ARM CHECK passed
  (guard + stop gate both exit 2).
- Step 3 PLAN: complete, codex-adversarial-reviewed (3 rounds; all
  substantive findings resolved; round-3 residual fixed). User signed off.
- Step 4 EXECUTE: next — subagents per task T1 / T2a+T2b / T3.

## Authoritative files (read these, not the transcript)

- Intake contract: `.feature/intake.json` (rev 3, committed ba5529b7)
- Plan: `docs/superpowers/plans/fix-verification-remainders-plan.md` (rev 2 + edits)
- Deviations (created during execution if needed):
  `docs/superpowers/plans/fix-verification-remainders-deviations.md`

## Verification / ship

- Gate: `scripts/verify-gate.sh` + `pnpm build` (intake verification_commands).
- Ship: HIGH-risk lane — staging ride first; capture
  `EXPLAIN (ANALYZE, BUFFERS)` on staging for the three target
  NotificationFailoverPoller queries (INCLUDE-column decision point);
  PR to main; PAUSE for user merge approval; apply 082 to prod at promotion.
- At ship, remind user: manual `rm poller_cursors.cursor` in the PARENT
  checkout (untracked stray; worktree rule forbids touching it here).

## Vocabulary (verbatim in code/commits)

- **worker-slot cap** — per-process summed BullMQ concurrency budget for
  LLM-calling queues; global bound only under single-replica (ADR 0005).
- **pacing cap vs guarded single-consumer invariant** — zernioBackfill's
  concurrency:1 is the former; assertSingleConcurrencyWorker is reserved
  for the latter.
- **sanctioned unguarded lane** — demo/eval LLM fan-out exempt from cost
  guards, bounded by review-count cap + admin rate limits.
