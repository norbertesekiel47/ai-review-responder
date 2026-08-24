# Handoff — feat-632-review-attributed-shadow

**Ticket:** #632 · **Map:** #617 · **Branch:** `feat-632-review-attributed-shadow`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-632-review-attributed-shadow`

## Current step

**Step 3 complete — the plan-review loop hit its three-round cap.**
`planReviewRounds=3`. Awaiting the OWNER'S CALL, which substitutes for
`APPROVED`. On that call: `bash scripts/feature-state.sh set-phase plan_approved`,
then step 4.

| Round | Verdict | Record |
|---|---|---|
| 1 | `REVISE` | `docs/reviews/.../plan-round1-triage.md` — 22 accepted, 2 rejected |
| 2 | `REVISE` | `plan-round2-triage.md` — 6 accepted, all verification failures |
| 3 | `REVISE` | `plan-round3-triage.md` — 4 accepted, all mechanical |

Every finding is fixed and committed. **Round 3's fixes carry no reviewer
verification** — they landed after the last round, which is the cap working as
designed. Task 0's eval-contract test is the practical check on them: it fails
loudly on the first run if the parked scan or the title budget is wrong.

The plan grew `tests_to_add` 26 → **54** and `allowed_edit_surface` 24 → **28**
across the three rounds.

> **Counter note.** Round 2's first dispatch died on a codex CLI syntax error
> (`--sandbox` must precede `resume`) and produced no review, so it was retried
> **without** a second increment. Correct form:
> `codex exec --sandbox read-only --json --cd <dir> resume <thread-id> "<prompt>"`.

> **Do not open a round 4.** The workflow forbids it. If something is still
> wrong, it is an owner decision, or it surfaces in step 5's gate.

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

## Owner-flagged item, still open

The plan reads rule B as "one position is a full-token match, the other is
initial-compatible", which makes `m. okafor` ~ `michael okafor` a match. The
locked preview's literal wording was "first tokens equal", but its stated
rejection rationale was "no shared full token". The plan takes the rationale as
the contract and flags it. If the owner prefers the narrower literal reading,
drop the `isInitial` arm from `compatible(firstA, firstB)` — one line, one test.

## Out-of-band at ship time (orchestrator, not a subagent)

Map #617's migration-queue line must record that **#632 is migration-bearing
(114)**. The map lives on the issue tracker. The map's own rule: the session
that discovers it updates it.

## Follow-ups to file, deliberately not in this PR

1. `already_reviewed` wiring in the batch builder.
2. The mirror-rule narrowing, if the owner chooses it.

## Next actions

1. Get the owner's call on the capped review loop. It substitutes for `APPROVED`.
2. Then: `bash scripts/feature-state.sh set-phase plan_approved`.
3. Then step 4 — `subagent-driven-development`. **Task 0 runs ALONE first.** After
   it completes, diff `git status --porcelain` against `allowed_edit_surface`; an
   out-of-surface path means enforcement did not bind for subagent tool calls —
   STOP and report, do not dispatch further tasks.
4. After Task 0 passes, Task 1 → Task 2 → then **Task 3 and Task 4 may run as
   concurrent subagents** (no blocking edge, disjoint files) → Task 5 → Task 6 →
   Task 7 → Task 8.
5. `feature-surface` stays RED until Task 1 creates the first production file.
   That is expected, not a defect. A WIP push before then needs
   `git push --no-verify` (#867).
