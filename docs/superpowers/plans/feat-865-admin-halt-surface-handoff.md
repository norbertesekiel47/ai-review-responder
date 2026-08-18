# feat-865 — handoff

A resumed session bootstraps from THIS file, then the artifacts it references.
It never needs the prior transcript. Everything below is a pointer, not a
restatement — read the referenced file, do not trust a summary of it.

**Resume with:** `/feature-resume feat-865-admin-halt-surface`

---

## Where things are

| What | Path |
|---|---|
| Worktree root | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-865-admin-halt-surface` |
| Branch | `feat-865-admin-halt-surface`, based on `f28451ee` |
| Source ticket | GitHub issue #865 (`gh issue view 865`) |
| Intake contract (audit copy) | `docs/superpowers/plans/feat-865-admin-halt-surface-intake.json` |
| Intake contract (arming copy) | `.feature/intake.json` — verified byte-identical to the audit copy |
| Plan | `docs/superpowers/plans/feat-865-admin-halt-surface.md` (**revision 2**) |
| Deviations | `docs/superpowers/plans/feat-865-admin-halt-surface-deviations.md` (D1, D2) |
| Review reports | `docs/reviews/feat-865-admin-halt-surface/` |
| Machine state | `.feature/state.json` |

## Current position

- Step 2 SETUP: **done.** `scripts/arm-check.sh` reports **ARMED**.
- Step 3 PLAN: plan written, **revision 2** after adversarial review.
- Plan review rounds used: see `.feature/state.json` `planReviewRounds`. The
  cap is 3; after round 3 the remaining disagreement goes to the owner, whose
  call substitutes for APPROVED. **Run `bash scripts/feature-state.sh incr-round
  plan` BEFORE dispatching any further plan review** — an uncounted round is how
  #628 reached a round-5 review under a "max 3" cap.
- Step 4 EXECUTE: **not started.** No implementation commit exists.

## Codex review thread

Round 1 and round 2 run in **one** codex session so round 2 can verify its own
prior findings:

```
thread id: 01a01308-efa1-7542-81f3-3a974d3b1c5d
```

**Invocation gotcha, learned the hard way.** Global flags must precede the
`resume` subcommand. This fails with `error: unexpected argument '--sandbox'`:

```
codex exec resume <id> --sandbox read-only --json …     # WRONG
```

This is correct:

```
codex exec --sandbox read-only --json --cd "$W" resume <id> "$(cat brief.md)"
```

Briefs live in the session scratchpad (`codex-865-plan-review-brief.md`,
`codex-865-plan-round2-brief.md`). Reports are extracted from the JSONL by
concatenating every `item.completed` event whose `item.type` is `agent_message`
— the final message alone is NOT the report; the substantive findings arrive in
earlier messages.

## The four owner-locked decisions

Do **not** re-litigate these. Full reasoning in the plan's §2 (D1–D11).

1. `halted_by` = the acting admin's `users.id`.
2. Tenant ids body-supplied (`accountId` + `businessId` + `batchId`).
3. #858 landed (PR #868); canonicalise at the public entry point anyway.
4. The surface is a panel on `/admin/businesses/[id]`.

## Cross-branch obligation

`feat-860-ask-regeneration-surface` overlaps `approval.ts` and `batch-view.ts`.
**Agreed order: #860 merges FIRST; this branch rebases onto `main` and re-runs
the full gate before review round 1 counts.** See deviations D1. The counterpart
note is in #860's own deviations file, left uncommitted there on purpose so its
green gate record is not disturbed.

## Two things that must not be lost

1. **Task 0 forbids `.todo` and `.skip`.** All 30 tests must execute and fail,
   and the red run must be recorded in the deviations file. A `.todo` satisfies
   the gate's `promised-tests` row while asserting nothing — that is the hole
   round 1 opened with.
2. **The owner-arm `pending` defect is a scheduled follow-up, not a silent
   drop.** `haltBatch` permits halting a batch with `built_at IS NULL`, which
   makes `batch-builder.ts:782-786` violate `091:176` later. The admin arm
   refuses it (D11); the owner arm is carved out in `non_goals` and must be
   filed as a ticket at step 8. Plan §7 owns this.

## Next action

Read the round-2 verdict in `docs/reviews/feat-865-admin-halt-surface/`.

- `APPROVED` → `bash scripts/feature-state.sh set-phase plan_approved`, then
  step 4: dispatch Task 0 alone, and run the first-task enforcement spot check
  (`git status --porcelain` against `allowed_edit_surface`) before dispatching
  anything else.
- `REVISE` → revise, `incr-round plan`, resume the codex thread for round 3.
