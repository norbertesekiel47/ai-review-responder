# Handoff — feat-726-legacy-hold-gates

Phase: `plan_approved` (see `.feature/state.json`). Resume with
`/feature-resume feat-726-legacy-hold-gates`; next step is **step 4 EXECUTE**.

## Artifacts (read in this order; do not re-read the prior transcript)

- Ticket: GitHub #726 (parent map #710) — RISK=high, ticket-seeded
- Intake (v2, signed off 2026-08-09; 8 tests_to_add):
  `docs/superpowers/plans/feat-726-legacy-hold-gates-intake.json`
  (arming copy `.feature/intake.json`, byte-identical)
- Plan (v2, codex-APPROVED round 3):
  `docs/superpowers/plans/feat-726-legacy-hold-gates.md`
- Deviations (D1 review triage, D2 intake corrections):
  `docs/superpowers/plans/feat-726-legacy-hold-gates-deviations.md`
- Codex reviews: `.feature/plan-review-round{1,2,3}.log`; session ids
  round 1 `019fe594-63b0-78a0-b5d0-bdc478179c20`,
  round 2 `019fe5a1-5a45-7283-82d2-fbd9722f47a1`,
  round 3 `019fe5a6-02bf-77e1-9bdb-5f441be07961`.
  `planReviewRounds=3` in `.feature/state.json` — plan review budget SPENT;
  any further plan disagreement goes to the owner, never another round.

## Glossary excerpt (CONTEXT.md, for subagent prompts)

A **moderation-held draft** (invariant #4) "surfaces neither its text nor
any button"; `held_for_review` is the existing owner-visible refusal
vocabulary (publish 409 + `HeldForReviewError`). `held-draft.ts` is the
semantic owner of "is this draft held": `hasOpenFlag` in-tx post-FOR-UPDATE
on tx paths; D6 inline-EXISTS spelling on read paths.

## Step-4 entry checklist

1. `bash scripts/feature-state.sh set-phase executing`
2. Dispatch Task 1 (eval — three test files, 8 verbatim titles, tests
   1,3,5–8 red / 2,4 green characterizations) per plan §Task 1; commit.
3. Task 2 ALONE (poller) → first-task enforcement spot check
   (`git status --porcelain` vs `allowed_edit_surface`).
4. Tasks 3 + 4 in parallel (disjoint files).
5. Gate (step 5), deviations read-back (step 6), reviews (step 7 — round
   counter via `feature-state.sh incr-round branch`), ship lane HIGH
   (step 8: staging ride first, then PR + owner merge approval).
