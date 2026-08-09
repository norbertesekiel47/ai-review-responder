# feat-730-open-flag-consolidation — handoff

State lives on disk; this doc is the resume entry point (`/feature-resume
feat-730-open-flag-consolidation`). It references, never restates.

## Position in the workflow

- Steps 0–3 COMPLETE. Phase: `plan_approved` (`.feature/state.json`;
  `planReviewRounds=3` — the counter is EXHAUSTED, no further plan reviews).
- **Next action: step 4 EXECUTE** — set phase `executing`, then
  `subagent-driven-development` from the orchestrator session: SERIAL
  T1→T2→T3→T4→T5→T6→T7 per the plan's dispatch-order section (no parallel
  dispatch — round-1 finding 10). T1 runs alone, then the first-task
  enforcement spot check (`git status --porcelain` vs `allowed_edit_surface`)
  before dispatching T2.

## Artifacts (worktree-relative)

- Intake (locked): `.feature/intake.json` (arming) +
  `docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`
  (committed). 11 promised test titles; surface NEVER amended (amendment
  counter 0); estimates ±140 prod / ±450 test.
- Plan **v4** (execute THIS): `docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md`
- Deviations log (has setup + round-1 triage entries):
  `docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md`
- Review reports: `docs/reviews/feat-730-open-flag-consolidation/plan-review-round{1,2,3}.md`
  (raw codex event logs; findings tables + verdicts at the tail of each).
  Codex session ids: r1 `019fe8b1-3979-79e2-9e7d-aee1822460bb`,
  r2 `019fe8c0-2d5f-7df0-8ba5-bb9f562dfe40`,
  r3 `019fe8c7-3355-7042-aeb4-4a27b577a6d8`.
- Verdict history: r1 REVISE (1 BLOCKER/8 MAJOR/1 MINOR) → v2; r2 REVISE
  (9/11 ADDRESSED, findings 4+7 open) → v3; r3 REVISE (two mechanical nits)
  → v4 hardenings folded; **owner call 2026-08-09: PROCEED with v4**
  (substitutes for APPROVED per the round protocol).

## Source-of-truth references

- Research deliverable (inventory/shape/divergence-sink): GitHub #725 closing
  comment. Ticket: #730. Parent map: #710 item 4.
- Glossary: `CONTEXT.md` → **Reviews list** entry (row-state axes, held ⇒
  `row_action 'none'`, D9 SELECTed-not-filtered); terms "owner-facing
  surfacing" / "deliberately distinct" per #725.
- Key mechanics already verified (do NOT re-derive): plan's "Verified
  planning facts" section — allowlist entries/baseline, TENANT_TABLES,
  flag statuses, `loadPastRepliesPageView`, mock-double behaviors,
  fragment-aware double pattern (plan header).

## Standing constraints for execution

- Every edit inside the worktree root; path-scoped `git add` only.
- Merge-order agreement with feat-719/PR #740 (see deviations file): #740
  lands first; rebase before opening the #730 PR if needed.
- Ship lane: RISK = high → staging ride, then PR + owner merge approval
  (step 8 high lane).
- Parent checkout has ANOTHER session's live uncommitted UI work — never
  touch the parent; inspect it only via `git -C`.
