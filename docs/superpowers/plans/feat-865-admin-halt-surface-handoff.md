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
| Plan | `docs/superpowers/plans/feat-865-admin-halt-surface.md` (**revision 3, LOCKED**) |
| Deviations | `docs/superpowers/plans/feat-865-admin-halt-surface-deviations.md` (D1–D5) |
| Review reports | `docs/reviews/feat-865-admin-halt-surface/` (plan rounds 1, 2, 3) |
| Machine state | `.feature/state.json` |
| Glossary excerpt | `CONTEXT.md` — **Halt latch**, **Batch state**, **Send batch parent**, **Settled batch**, **Outreach row**, **Ask**, **Lazy child**. Re-read these before any task; do not paraphrase them. |

## Current position

- Step 2 SETUP: **done.** `scripts/arm-check.sh` reports **ARMED**.
- Step 3 PLAN: **done and LOCKED.** Plan is revision 3.
  - `planReviewRounds: 3` — the cap is spent. **No round 4 may run.**
  - Round 3 returned `REVISE` on two documentation-only defects in deviations
    D1; both are fixed in the committed file.
  - Per feature.md's round-3 rule the position was surfaced to the owner on
    resume, and **the owner's call (2026-08-18) substitutes for `APPROVED`**.
    Recorded in the plan's §6 — that record, not this line, is the artifact.
- Step 4 EXECUTE: **in progress.** See the task ledger below.

## Task ledger — the one place that says what is done

Plan §4 owns the task definitions. This table owns their STATE. Update it in
the same commit as the task it describes; a resumed session trusts git over
this table, but a table that disagrees with git is itself a finding.

| Task | What | Blocking edges | State |
|---|---|---|---|
| 0 | eval — all 30 `tests_to_add` titles as executable failing tests | none | see git log |
| 1 | `latchHalt` extraction + `adminHaltBatch` | 0 | **done** — 16 titles green |
| 2 | the admin route | 1 | **done** — the 7 `the admin halt route …` titles green |
| 3 | `readAdminBatchSummary` + the panel + page wiring | 2 | not started |
| 4 | docs sweep (`CONTEXT.md`, `docs/directory.md`) | 1 | not started |

Tasks 3 and 4 are marked mutually independent by the plan and may be dispatched
in parallel once Tasks 1 and 2 have landed.

## Codex review thread

Rounds 1–3 ran in **one** codex session so each round could verify its own prior
findings:

```
thread id: 01a01308-efa1-7542-81f3-3a974d3b1c5d
```

That thread is CLOSED for plan review — the cap is spent. It is the correct
thread to resume for a **branch** review at step 7, which has its own counter
(`branchReviewRounds`, currently 0).

**Invocation gotcha, learned the hard way.** Global flags must precede the
`resume` subcommand. This fails with `error: unexpected argument '--sandbox'`:

```
codex exec resume <id> --sandbox read-only --json …     # WRONG
```

This is correct:

```
codex exec --sandbox read-only --json --cd "$W" resume <id> "$(cat brief.md)"
```

Reports are extracted from the JSONL by concatenating every `item.completed`
event whose `item.type` is `agent_message` — the final message alone is NOT the
report; the substantive findings arrive in earlier messages.

## The four owner-locked decisions

Do **not** re-litigate these. Full reasoning in the plan's §2 (D1–D11).

1. `halted_by` = the acting admin's `users.id`.
2. Tenant ids body-supplied (`accountId` + `businessId` + `batchId`).
3. #858 landed (PR #868); canonicalise at the public entry point anyway.
4. The surface is a panel on `/admin/businesses/[id]`.

## Cross-branch obligation — STILL OPEN

`feat-860-ask-regeneration-surface` overlaps `approval.ts` and `batch-view.ts`.
**Agreed order: #860 merges FIRST; this branch rebases onto `main` and re-runs
the full gate before review round 1 counts.** See deviations D1.

- #860's PR is **#873, OPEN** as of 2026-08-18. Re-check with
  `gh pr view 873 --json state`.
- The overlap is mechanical (a shared file-header comment and a shared append
  point), not semantic — which is why #865 implements in parallel rather than
  idling. D1 has the file-by-file evidence.
- The counterpart note lives on the sibling branch, committed at `db89a700`,
  section "Surface overlap with feat-865". It is unresolvable from THIS review
  root by construction.

## Two things that must not be lost

1. **Task 0 forbids `.todo` and `.skip`.** All 30 tests must execute and fail,
   and the red run must be recorded in the deviations file. A `.todo` satisfies
   the gate's `promised-tests` row while asserting nothing — that is the hole
   round 1 opened with. The final gate additionally requires recorded
   **`30 passed / 0 skipped / 0 todo`** evidence, because `diff-coverage` does
   NOT gate a test-only commit (`scripts/diff-coverage.ts:62-65` excludes test
   paths; `104-106` exits PASS when no production line changed).
2. **The owner-arm `pending` defect is a scheduled follow-up, not a silent
   drop.** `haltBatch` permits halting a batch with `built_at IS NULL`, which
   makes `batch-builder.ts:782-786` violate `091:176` later. The admin arm
   refuses it (D11); the owner arm is carved out in `non_goals` and must be
   filed as a ticket at step 8. Plan §7 owns this.

## Next action

Read the task ledger above, then `git log --oneline` to confirm it.

- Task 0 not yet committed → dispatch Task 0 **alone**, then run the first-task
  enforcement spot check (`git status --porcelain` against
  `allowed_edit_surface`) before dispatching anything else.
- Task 0 committed → continue down the ledger under the blocking edges.
- All tasks committed → step 5, `scripts/verify-gate.sh`.
