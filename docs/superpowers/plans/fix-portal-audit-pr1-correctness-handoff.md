# Handoff — fix/portal-audit-pr1-correctness

**Current step:** 4 (EXECUTE). Plan locked, no review gate required (RISK = normal).

## Where everything lives

| Artifact | Path |
|---|---|
| Spec (parent, §3 is this PR) | `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` |
| Plan | `docs/superpowers/plans/2026-08-15-portal-audit-pr1-correctness.md` |
| Intake (arming copy) | `.feature/intake.json` |
| Intake (audit copy) | `docs/superpowers/plans/fix-portal-audit-pr1-correctness-intake.json` |
| Deviations | `docs/superpowers/plans/fix-portal-audit-pr1-correctness-deviations.md` |
| Worktree root | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-portal-audit-pr1-correctness` |

## Classification

RISK = normal · SURFACE = mixed · SIZE = normal (full path).
Est. 70 prod / 180 test lines. Not DB-touching. No new deps, env vars, or flags.

Lane was an explicit owner decision: `/feature`'s rubric lists "auth" as a high
trigger and the sign-out fix is auth-flow-adjacent, but the owner chose the
normal lane on the grounds that it changes a redirect constant, not an auth
mechanism. Ships straight to `main` after CI — no staging ride.

## This PR is one of three

The spec is EPIC-sized (~18 tickets, six trees). It was decomposed at design
time into three independently shippable PRs, so each runs as its own `/feature`:

1. **PR 1 — correctness** ← this run
2. PR 2 — channel-route unification (spec §4), ~400/250 lines, 13 routes
3. PR 3 — Overview spec-alignment (spec §5), ~350/200 lines

## Task order

Task 1 (evals) blocks all others. Tasks 2–6 are mutually independent — disjoint
file sets, no shared edges — so after Task 1's **first-task enforcement spot
check** passes they may be dispatched in parallel. Task 7 is comment-only.
Task 8 is the gate.

## Two decisions already recorded as deviations

- **D1** — spec §3.5 said create `src/lib/auto-approval/labels.ts`; using the
  existing `types.ts` instead (it already exports runtime constants, is already
  imported by the admin panel, and is client-safe). Surface amendment #1 of the
  budget of 2.
- **D2** — spec §3.4's loop lives in `named-rival.ts` as `loadRivalPickerViews`,
  not inline in the page, following the `loadLocationsSettingsView` precedent.
  Not a surface amendment. This also lifts projected `diff-coverage` from ~76%
  (under the gate) to ~91%.

Both need an ACCEPT/RE-PLAN verdict at step 6.

## Verified facts worth not re-deriving

- `loadRivalPickerView(db: Sql, { accountId, businessId }: RivalPickerScope):
  Promise<RivalPickerView>` — match these names; the param is `db`, not `sql`.
- `AutoApprovalThreshold` is the literal union `4 | 5`, so
  `Record<AutoApprovalThreshold, string>` is exhaustive.
- This repo has **no executing server-page test precedent**. The convention is
  source-text assertion (`src/app/admin/autonomy/__tests__/page-source.test.ts`).
  Do not invent an executing page test.
- `diff-coverage` is an **aggregate** (`totalCovered/totalCountable`) over added
  instrumented lines, min 80%, not per-file.
- Owner Telegram `cancel` has no test today; that gap belongs to PR 2, not here.

## Next actions

1. `bash scripts/feature-state.sh set-phase executing`
2. Dispatch Task 1 alone; then run the enforcement spot check
   (`git status --porcelain` vs `allowed_edit_surface`).
3. Fan out Tasks 2–6, then Task 7.
4. Task 8: `bash scripts/verify-gate.sh --review`.
5. Step 6 deviations read-back → step 7 two review agents (spec+correctness,
   standards) → step 8 normal lane: PR to `main`, CI green, merge.
