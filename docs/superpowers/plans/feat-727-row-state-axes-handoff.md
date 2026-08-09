# feat-727-row-state-axes — session handoff

Machine phase: `.feature/state.json` (authoritative). This doc is the reading
order for a resumed session — it references, never restates.

## Artifacts (read in this order)

1. Intake contract: `docs/superpowers/plans/feat-727-row-state-axes-intake.json`
2. Plan (4 tasks, T1→T2→T3∥T4): `docs/superpowers/plans/2026-08-09-feat-727-row-state-axes.md`
3. Deviations log (locked-decision refinements — orphan×held, ADR 0018 number,
   owner Q&A): `docs/superpowers/plans/feat-727-row-state-axes-deviations.md`
4. Locked decision + cross-product table: GitHub issue #723 resolution comment
   (`gh issue view 723 --repo RepWorth/ai-review-responder --comments`);
   prototype on branch `prototype/723-row-state-axes` (never merges)
5. Feature ticket: #727 (`wayfinder` map #710 item 1, UI half)

## Glossary anchors (CONTEXT.md → Reviews list; rewritten by Task 4)

Posted-reply axis (`reply_state`) · Replacement-draft axis (`draft_state`,
server-internal, never crosses the wire) · Action slot (`row_action`). The
invariant wording: *a held draft never projects an affordance of its own* —
none/posted×held → `none`; orphan×held keeps `recover`.

## Plan review (step 3 gate, RISK = high)

- Round 1: codex session 019fe619-0605-7cd1-bff7-f1a1dda1a2d4, VERDICT:
  REVISE (2 BLOCKER / 8 MAJOR / 1 MINOR). Log:
  `.feature/logs/plan-review-r1.log`. Triage: plan's "Review appendix — round
  1" (2 rejections with reasoning, rest folded in; 5 test titles added to the
  intake, now 17).
- Round 2 (verification-only): log `.feature/logs/plan-review-r2.log`.
  VERDICT: APPROVED (9 FIXED-VERIFIED, 2 REJECTION-SOUND).

## Current step

Step 4 (execution) — plan APPROVED at round 2. Dispatch order: T1 (eval) alone
first + enforcement spot check on its diff, then T2, then T3 ∥ T4. Subagent
briefs come from the plan's task sections + the glossary anchors above.
