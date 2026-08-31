---
description: Batch-grill N tickets in one sitting, then fan out N parallel /feature runs in sibling worktrees to N review-ready reports
argument-hint: <ticket-or-issue list, comma or space separated>
---

# Feature Swarm

Tickets: $ARGUMENTS

Run N features in parallel instead of serially. The owner's time concentrates
into ONE grilling sitting up front; everything after runs concurrently and
unattended until N review-ready reports. Evidence basis (2026-08): parallel
worktree fan-out is the community's #1 speed lever — teams run 4-8 concurrent
worktrees per developer; serial wall-clock is the bottleneck, not agent speed.

**What this is NOT**: /queue-run (autonomous backlog triage, opens PRs). Swarm
tickets are owner-chosen and owner-grilled; swarm STOPS at review-ready, and
every /feature rule applies inside each run — this command only changes WHEN
the human touchpoints happen (batched up front), never WHICH ones exist.

## Hard limits

- **Cap: 3 concurrent runs** (start at 2). The machine shares cores with each
  gate's parallel rows; 4+ gates thrash (the gate itself caps MAX_PARALLEL=4
  for the same reason).
- **Disjoint surfaces are a precondition.** Run `scripts/feature-surface-check.sh`
  logic across the drafted intakes BEFORE arming: any overlap between two
  tickets' `allowed_edit_surface` → those two run serially (agree the order),
  or the overlap is carved out. Never dispatch overlapping surfaces in
  parallel — merge-order pain erases the wall-clock win.
- **DB-touching tickets: max ONE per wave.** All worktrees share the one
  localhost test DB; the advisory-lock protocol serializes provisioning, but
  two db_touching gates still contend for minutes. A second DB ticket waits
  for the next wave.
- **RISK=high tickets swarm fine** — their plan-skeptic rounds happen in
  phase 1 (batched), not mid-execution.

## Phase 1 — Batch grill (the owner's one sitting)

1. Classify all N tickets (/feature step 0 each).
2. Grill sequentially but in one conversation: intake questions for ticket 1,
   then 2, then 3. Batch related questions into single AskUserQuestion calls
   across tickets where they share a decision.
3. Write and validate all N intakes (`validate-intake.mjs` each). Check the
   surfaces are disjoint (see Hard limits). ONE sign-off message covers all N
   intakes — list them, get one approval.
4. For RISK=high tickets, run plan + plan-skeptic rounds NOW, in this phase
   (parallel skeptic dispatch across tickets is fine — they are independent).
   Plans approved here; nothing later needs the owner's judgment until review.

## Phase 2 — Arm and fan out

For each ticket, serially (arming is cheap, ~1 min each):

```bash
pnpm worktree:new <branch-i>
cd ../RepWorth-worktrees/<branch-i> && bash scripts/feature-setup.sh <intake-i>
```

feature-setup arms the hooks, carries the ladder, and writes the autonomy
profile (steps 4-6 run promptless inside each worktree; shipping boundary
still prompts). Then dispatch N implementation runs IN ONE MESSAGE — one
subagent per worktree (`Agent`, general-purpose), each briefed with:

- its worktree root (every command `cd <worktree> && ...`; edits by absolute
  path — the edit-surface guard enforces the rest)
- its intake path, plan path, glossary excerpt, and tracer list
- the /feature step 4-6 contract verbatim: TDD, tracer order, deviations
  file, the GATE LOOP (gate-summary → fix → incr-gate-round → re-run; the
  budget refusal at round 4 is a STOP, not an obstacle), and `--review` mode
  before finishing
- the stop condition: green review-mode gate + current fingerprint, then
  REPORT BACK — no commits beyond the intake commit, no PR, no merge

Subagents run concurrently in the background. While they run, the root
session answers their escalations only; a budget refusal or blocked step
comes back to the owner with its context.

## Phase 3 — Review tails, serialized where it matters

As each run reports gate-green (they finish staggered — start reviewing the
first while the others still execute):

1. Deviations read-back for that branch (verdict every entry — the reviewed
   transition enforces it).
2. Dispatch that branch's review axes AND its red-team pass in ONE parallel
   wave (feature.md step 7 mechanics: axis checklists in, Haiku for mechanical
   passes, reports staged in `.feature/review-staging/`). Read
   `.agents/skills/feature/references/execution-lanes.md` § The review wave —
   with a live mutation in the wave, an untracked report file under `docs/`
   breaks the red-team preconditions.
3. Triage findings; the root fixes accepted ones IN THAT WORKTREE via its
   gate loop (`verify-gate.sh --fast` per round, full gate at the boundary);
   then step 7.5 — finalize, commit, scoped round 2, `reviewed` transition.

The gates' SUBAGENT BARRIER holds per-worktree: never run a worktree's gate
while ITS subagent is in flight; other worktrees' work is irrelevant to it.

## Phase 4 — Deliver

N review-ready reports, presented together: per branch — behavior, evidence
(gate table + SHA), review verdicts, deviations, unresolved risks, and the
available next action (PR). Ship lanes stay per-branch and owner-authorized;
recommend a merge ORDER (surface-adjacency first) and offer to execute it
one PR at a time after approval.

## Failure handling

- One run failing does NOT stop the others. A run that hits abort criteria
  (gate budget, 2nd amendment, invalidated intake) parks: rename its
  `.feature/intake.json` per the parking rule, note it in the final report.
- On resume after interruption, `$feature-resume <branch>` each run
  independently — all state is per-worktree and durable.
- Post-merge of wave PRs: realign remaining branches (`git rebase origin/main`
  per worktree, gate re-run — evidence is stale after a rebase by rule).
