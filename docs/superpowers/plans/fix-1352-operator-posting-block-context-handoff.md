# Handoff — fix/1352-operator-posting-block-context

State lives on disk. A resumed session reads the files below and never needs the
prior transcript.

## Where things are

| What | Path |
|---|---|
| Locked intake (24 test titles, 2 surface amendments) | `docs/superpowers/plans/fix-1352-operator-posting-block-context-intake.json` |
| Plan, revision 2, with both review appendices | `docs/superpowers/plans/fix-1352-operator-posting-block-context-plan.md` |
| Deviations D1-D4, all ACCEPT | `docs/superpowers/plans/fix-1352-operator-posting-block-context-deviations.md` |
| Plan review round 1 (REVISE, 3 High) | `docs/reviews/fix-1352-operator-posting-block-context/plan-round-1.md` |
| Plan review round 2 (REVISE, 5 contract defects) | `docs/reviews/fix-1352-operator-posting-block-context/plan-round-2.md` |
| Glossary — **Posting block** | `docs/context/core-reviews-responses.md` line 10 |
| Glossary — **Context snapshot**, **Proposal** | `docs/context/owner-operator.md` lines 13, 17 |
| Issue | `gh issue view 1352` |

## Position

Step 3 closed at `f9abf35f4`, phase `plan_approved`, fork point `650f625e7`.
Plan review rounds: 2 of 3 used, round 3 deliberately not dispatched (reason in
the plan's round-2 appendix). Surface amendments: 2 of 2 used — a THIRD triggers
the step 5 abort criteria without argument.

Tracers T1-T6 are registered. T1 runs first and alone; it carries the
first-task enforcement spot check. T2 may then run parallel with T3.

## The two decisions a resumed session must not relitigate

1. **`correctionOwed` is the single suppression switch.** `blocked`, `reasons`
   and `sentences` stay complete whenever the account is blocked. Round 2
   defect 1 was exactly the opposite reading.
2. **"Card guaranteed, chat guided"** — the owner's step 1 decision, 2026-09-20.
   The card is server-rendered and deterministic; the chat sentence is a prompt
   rule and is not guaranteed. Do not close that gap with an output validator.
   State the limitation in the PR description.

## Shipping lane

RISK = high. Rides `staging` before `main`, gets the step 7 review wave plus a
red-team pass, and pauses for explicit merge approval. Approvals still owed:
`push`, `staging_deploy`, `merge`.
