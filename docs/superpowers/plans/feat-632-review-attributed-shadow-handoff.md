# Handoff — feat-632-review-attributed-shadow

**Ticket:** #632 · **Map:** #617 · **Branch:** `feat-632-review-attributed-shadow`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-632-review-attributed-shadow`

## Current step

**Step 3 — round 4 is in flight under an explicit OWNER OVERRIDE of the cap.**
`planReviewRounds=4`. The branch is UN-PARKED and `arm-check.sh` reports ARMED.

| Round | Verdict | Record |
|---|---|---|
| 1 | `REVISE` | `docs/reviews/.../plan-round1-triage.md` — 22 accepted, 2 rejected |
| 2 | `REVISE` | `plan-round2-triage.md` — 6 accepted, all verification failures |
| 3 | `REVISE` | `plan-round3-triage.md` — 4 accepted, all mechanical |
| 4 | in flight | verification-only, scoped to commit `b2cf606b` |

Rounds 1–3 are fixed and committed. Round 4 exists because **round 3's fixes
carried no reviewer verification** — they landed after the last review. Round 4
does not re-review the plan. It verifies exactly four things: that C1–C4 landed,
that each fix closes the defect it names, and that no fix broke an adjacent
part of the same document.

The plan grew `tests_to_add` 26 → **54** and `allowed_edit_surface` 24 → **28**
across the three rounds.

> **Counter note.** Round 2's first dispatch died on a codex CLI syntax error
> (`--sandbox` must precede `resume`) and produced no review, so it was retried
> **without** a second increment. Correct form:
> `codex exec --sandbox read-only --json --cd <dir> resume <thread-id> "<prompt>"`.

> **The cap is 3. Round 4 is an owner override, not a precedent.** There is no
> round 5. If round 4 returns `REVISE`, the findings are fixed and the remaining
> position goes to the owner, or it surfaces in step 5's gate.

## Surface amendments spent: 1 of 2

`src/lib/shared/worker-types.ts` plus three new test files were added to
`allowed_edit_surface` in the round-1 revision. One file inside `src/lib/shared/`
— a tree the surface already covered — so it is auto-approved under step 2's
rule. **A SECOND amendment triggers re-classification (step 5).** Both intake
copies are in sync; re-sync `.feature/intake.json` from the committed copy after
any further edit.

## Superseded by later rounds — do NOT act on an older copy

Two facts in this doc's earlier drafts were later overturned. They are recorded
here because a resumed session that acts on the old version does real damage:

1. **"Enqueue in BOTH entry points" was WRONG.** `processReview` (line 36) is the
   live lane; `importReview` (line 515) is the Zernio backfill lane the intake's
   non-goals **exclude**. The enqueue goes in `processReview` **only**
   (round-1 finding A2), and `importReview: never enqueues …` pins it.
2. **The guard's marker is `attributed_at`, not `attributed_review_id`**
   (round-2 finding B3). The review-delete FK nulls the review id but never the
   timestamp, so keying on the id resurrects an already-attributed row and lets
   the next match overwrite retained provenance. **Four sites must agree**: the
   candidate query, the enqueue guard, the index predicate, and the final CAS.

The plan on disk is correct on both. This doc is the summary; **the plan wins**.

## Locked decisions the plan must not reopen

From the grilling (owner-answered, all eight):

1. Evidence lives in **columns on `solicitation_outreach`**, not a spine step.
2. Owner surface is a **standalone 30-day section on Requests**, not a per-batch badge.
3. Coupling is an **outbox topic + worker**, never inline in the ingest transaction.
4. **`already_reviewed` stays inert.** `batch-builder.ts:366` keeps `matchedReview: null`.
5. Match rule: **full name, or first + last initial**. Bare first names never match.
6. Two or more matches → **attribute nothing**, log `ambiguous`.
7. Candidates exclude **bounced** and **complained**; **unsubscribed stays eligible**.
8. **Sentiment-blind** — a one-star review attributes like a five-star one.

Two schema calls made at plan time, recorded as deviations:
- `attribution_rule TEXT` replaces the intake preview's `attribution_score NUMERIC(4,3)` — the locked rule is boolean, so a score column would ship with no writer.
- `attribution_detail` carries **no PII** — no reviewer name, no contact name. Both survive the review's deletion otherwise, which the **Body redaction** discipline exists to prevent.

## Owner-flagged item — CLOSED 2026-08-24

**The owner chose the BROAD reading. Rule B stands as the plan already writes it.**

`compatible(firstA, firstB)` **keeps** its `isInitial` arm, so `m. okafor`
~ `michael okafor` matches with rule `first_last_initial`. The locked preview's
literal wording was "first tokens equal", but its stated rejection rationale was
"no shared full token", and the owner ruled the rationale is the contract.

**No plan edit follows from this call.** The narrowing — dropping the `isInitial`
arm from `compatible(firstA, firstB)` — is now a rejected alternative, not a
pending follow-up. Delete it from the follow-ups list below if it is still there.

Locked behaviour, for the record:

| Contact | Reviewer | Result |
|---|---|---|
| `M. Okafor` | `Michael Okafor` | MATCH `first_last_initial` |
| `Michael O.` | `Michael Okafor` | MATCH `first_last_initial` |
| `Mike Okafor` | `Michael Okafor` | no match — `mike` ≠ `michael`, neither is an initial |
| `D. Rodriguez` | `Dana R.` | no match — no full-token match on either position |
| `Okafor` | `Michael Okafor` | no match — fewer than 2 tokens |

## Out-of-band at ship time (orchestrator, not a subagent)

Map #617's migration-queue line must record that **#632 is migration-bearing
(114)**. The map lives on the issue tracker. The map's own rule: the session
that discovers it updates it.

## Follow-ups to file, deliberately not in this PR

1. `already_reviewed` wiring in the batch builder.

> The mirror-rule narrowing was the second item here. The owner rejected it on
> 2026-08-24. It is not a follow-up. Do not re-file it.

## THE BRANCH IS PARKED — un-park before doing anything else

`.feature/intake.json` is renamed to `.feature/intake.parked.json`.

**Un-park:**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-632-review-attributed-shadow
mv .feature/intake.parked.json .feature/intake.json
bash scripts/arm-check.sh     # any DISARMED output means STOP and report
```

**Why the park keeps happening at this boundary.** The verify gate CANNOT go
green before Task 1, because `feature-surface` requires production files that do
not exist yet. 21 of 22 rows pass; `feature-surface` is the only red, by design.
The Stop hook skips any worktree with no `.feature/intake.json`, so the rename is
the sanctioned way to end a turn while the gate is legitimately red. Every turn
end before Task 1 needs it.

**Discipline while parked: make no edits.** The rename also disarms the
edit-surface guard. Un-park FIRST, confirm ARMED, then edit.

Do not re-run `feature-setup.sh` — it would re-install the intake from the
parent checkout, where no draft exists any more, and reset the round counter.

**`state.json` repair, done on resume.** `headSha` read `d852482c` while HEAD was
`f6d6c8b1`, and `intakeSha256` predated surface amendment #1. `incr-round` does
not refresh either field; `set-phase` does. Both are now correct. Re-run
`set-phase` after any commit run that does not change phase.

## Next actions

1. **Round 4 is in flight.** Wait for it. Write the report to
   `docs/reviews/feat-632-review-attributed-shadow/plan-round4-codex.md` and the
   triage to `plan-round4-triage.md`, matching the rounds 1–3 format.
2. `APPROVED` → go to action 4. `REVISE` → fix every accepted finding, commit,
   then the remaining position goes to the OWNER. **There is no round 5.**
3. On the owner's go: `bash scripts/feature-state.sh set-phase plan_approved`.
4. Then step 4 — `subagent-driven-development`. **Task 0 runs ALONE first.** After
   it completes, diff `git status --porcelain` against `allowed_edit_surface`; an
   out-of-surface path means enforcement did not bind for subagent tool calls —
   STOP and report, do not dispatch further tasks.
5. After Task 0 passes, Task 1 → Task 2 → then **Task 3 and Task 4 may run as
   concurrent subagents** (no blocking edge, disjoint files) → Task 5 → Task 6 →
   Task 7 → Task 8.
6. `feature-surface` stays RED until Task 1 creates the first production file.
   That is expected, not a defect. A WIP push before then needs
   `git push --no-verify` (#867).
