# Handoff — feat-632-review-attributed-shadow

**Ticket:** #632 · **Map:** #617 · **Branch:** `feat-632-review-attributed-shadow`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-632-review-attributed-shadow`

## Current step

**Step 3 — plan review, round 1 in flight.** Not yet approved. Do not start Task 0
until the verdict lands and the corrections below are folded in.

## Read these, in this order — never the prior transcript

| What | Path |
|---|---|
| Locked intake contract | `.feature/intake.json` (audit copy in `docs/superpowers/plans/feat-632-review-attributed-shadow-intake.json`) |
| The plan | `docs/superpowers/plans/2026-08-24-feat-632-review-attributed-shadow.md` |
| Governing spec (D14/D16) | `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` |
| Reference design | `docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md` §6.3–6.4 |
| Binding amendments | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` |
| Glossary | `CONTEXT.md` → **Solicitation (send-mode)** |
| Machine state | `.feature/state.json` |
| Deviations | `docs/superpowers/plans/feat-632-review-attributed-shadow-deviations.md` |

## Gate status at the start of this run

- #900 (the blocker) CLOSED 2026-08-23. Map #617's execution gate OPEN since 2026-07-28.
- Migration head 113; **114 is free and this ticket claims it**.
- Enforcement ARMED. No cross-worktree surface overlap.

## Plan review — round 1

- Counter: `planReviewRounds=1` (`.feature/state.json`).
- Dispatched via direct `codex exec --sandbox read-only --json`.
- **Codex thread id: `01a0353b-3877-78d3-858a-c36c8fc5b35a`**
- Brief: `<scratchpad>/632-plan-review-brief.md`
- Raw output: `<scratchpad>/632-plan-round1.jsonl`
- A first foreground attempt was killed by the 10-minute cap. The background
  re-run is the authoritative one.

## Corrections found by the orchestrator before the verdict — fold ALL FOUR into the revision

These are confirmed against the code, not guesses. The plan on disk still
carries the defective versions.

1. **`reviewTimeAnchor(sql, prefix)` takes `'' | 'r.'`, not `'bare'`.**
   `src/lib/kpi/fragments.ts:44`. The plan's candidate CTE aliases the review
   row as `r_outer`, which neither value serves. Alias it `r` and pass `'r.'`.

2. **Migration 114 must add `job_outbox_solicitation_attribution_inflight`.**
   The `job_outbox` in-flight unique indexes are **per topic**, not generic —
   `job_outbox_solicitation_send_inflight` (091:541),
   `job_outbox_generate_solicitation_asks_inflight` (091:546),
   `job_outbox_solicitation_veto_notice_inflight` (113:24). Without one, the
   helper's `ON CONFLICT … WHERE topic = 'solicitation_attribution' AND status
   IN (…)` has no constraint to infer and the INSERT throws. Copy 113's shape
   byte-for-byte and re-spell the status set by hand (`ci:outbox-status` checks
   members AND order).

3. **`accountId` is NOT in scope at the enqueue site.** In
   `src/lib/reviews/process-review.ts` the account id is resolved inside
   `startReviewRun` (line 203), not at the caller. Therefore:
   - Drop `account_id` from `SolicitationAttributionPayload`. It carries
     `review_id` + `business_id` only.
   - `attributeReview` resolves `accountId` from `businesses` inside its own
     transaction, exactly as `startReviewRun` and
     `maybeEnqueueFirstReviewIngested` already do. This also removes any way a
     wrong account id could arrive on a payload.
   - The file has **TWO** new-review entry points (the enqueue site near line 87
     and the one near line 540). Both call `maybeEnqueueFirstReviewIngested`.
     **The enqueue must land beside it in BOTH**, or one ingest lane silently
     never attributes.

4. **The helper's `WHERE EXISTS` guard as planned is NOT a superset — it drops
   real matches.** The candidate window is anchor-relative; the guard was
   `NOW()`-relative. Counter-example: a review whose `review_date` is 13 days
   old but which we only detect today has an anchor 13 days back, so an ask
   sent 20 days ago IS a legitimate candidate — while the guard's
   `sent_at > NOW() - 14 days` is false and no job is ever enqueued. Silent
   data loss.
   **Fix: drop the time bound from the guard entirely.**

   ```sql
   WHERE EXISTS (
     SELECT 1 FROM solicitation_outreach o
      WHERE o.business_id = ${input.businessId}
        AND o.delivery_status = 'sent'
        AND o.attributed_review_id IS NULL
   )
   ```

   Now provably a superset: every candidate satisfies all three arms. It also
   removes the `eligibilityWindowDays` parameter, so
   `src/lib/shared/job-outbox-helpers.ts` needs no window constant and no
   domain import — the layering problem the plan spent a section on dissolves.
   Keep the header comment explaining that over-enqueueing is harmless and that
   the guard must never be tightened into a second copy of the candidate query.

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

1. Read the round-1 verdict from `<scratchpad>/632-plan-round1.jsonl` (last `agent_message`).
2. Fold in the four corrections above **plus** every accepted finding.
3. If `REVISE`: `bash scripts/feature-state.sh incr-round plan` **before** re-dispatching, and re-submit only the findings-and-fixes delta to the SAME codex thread.
4. On `APPROVED` (or the owner's call after round 3):
   `bash scripts/feature-state.sh set-phase plan_approved`, then step 4 —
   `subagent-driven-development`, Task 0 alone first, with the first-task
   enforcement spot check before any further dispatch.
