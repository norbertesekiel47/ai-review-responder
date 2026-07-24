# Handoff — feat/540-voice-report-card

**Phase:** plan_approved (see `.feature/state.json`)
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-540-voice-report-card`
**Next step:** /feature step 4 — EXECUTE via `superpowers:subagent-driven-development` (set phase `executing` first).

## Source of truth (read these, in order — do not reconstruct from chat)

1. Intake contract: `.feature/intake.json` (committed audit copy: `docs/superpowers/plans/feat-540-voice-report-card-intake.json`)
2. Plan: `docs/superpowers/plans/2026-07-24-540-voice-report-card.md` — interface contract + 5 tasks with full code
3. Ticket: GH #540; parent map #528; locked prototype decisions: #536 (closed, decisions in final comment)
4. Glossary: `CONTEXT.md` (terms to add are in plan Task 5)
5. Deviations log: `docs/superpowers/plans/feat-540-voice-report-card-deviations.md` (subagents append; triage at step 6.5)

## Task graph

- T1 voice-learning deepen (`getVoiceCorpusStatus`) ─┐ (T1+T2 commit together — T1's test imports T2's module)
- T2 voice-report-card derivation module ────────────┘
- T3 report-card route — blocked by T1+T2
- T4 UI section (`VoiceReportCard.tsx` + `VoiceClient.tsx`) — blocked by T3; subagent MUST invoke `repworth-brand-design`
- T5 CONTEXT.md glossary — blocked by T2 only

## Step-4 discipline reminders

- Every Bash command `cd`-prefixed to the worktree root; Edit/Write use absolute worktree paths.
- After the FIRST subagent task: diff `git status --porcelain` against `allowed_edit_surface` (enforcement spot check).
- Subagents return ≤10-line summaries; surprises go to the deviations file.
- Gate: `scripts/verify-gate.sh` after tasks; final pre-review run with `--review`.
- Reviews (step 7): 2 parallel agents (spec vs standards), findings tables only, reports to `docs/reviews/feat-540-voice-report-card/`, run `scripts/blast-radius.sh` first.
- Ship lane: RISK=normal → PR to main, CI green, merge (no staging ride).
