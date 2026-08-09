# Plan: feat-726-legacy-hold-gates (v2 — post codex round 1)

Ticket: #726 (map #710, item 1 server half). Intake:
`docs/superpowers/plans/feat-726-legacy-hold-gates-intake.json` (signed off
2026-08-09; tests_to_add revised v2 per round-1 review — deviations D2).
RISK = high · SURFACE = ui · db_touching = false.
Round-1 review: `.feature/plan-review-round1.log` → VERDICT: REVISE; triage in
`docs/superpowers/plans/feat-726-legacy-hold-gates-deviations.md` (D1).

## Design note (codebase-design consult)

No new module, no new seam, no interface change. `src/lib/moderation/held-draft.ts`
is the deep module owning "is this draft held"; its interface (`hasOpenFlag(tx,
responseId)` — in-tx, post-`FOR UPDATE`) is consumed as-is by the three tx
handlers. The read-only poller cannot hold a tx, so it uses the sanctioned D6
spelling: the `EXISTS` predicate inline in the read query, with the
semantic-owner comment pointing at `held-draft.ts` (precedent
`src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:56-88`).
Call sites at the same locus as the publish gate
(`src/app/api/dashboard/past-replies/publish/route.ts:159`) — nothing else.

Glossary (CONTEXT.md, verbatim): a **moderation-held draft** (invariant #4)
"surfaces neither its text nor any button"; `held_for_review` is the existing
owner-visible refusal vocabulary (publish 409, `HeldForReviewError`).

## Locked behavior (intake sign-off 2026-08-09)

| Handler | Held behavior |
|---|---|
| GET `draft-status` | `{ status: 'failed', error: 'held_for_review' }` (200), never `response_id`/`response_text` |
| POST `draft` (existing-draft branch) | 409 `{ error: 'held_for_review' }`, NO `existing` payload |
| DELETE `draft/[responseId]` | 409 `{ error: 'held_for_review' }`, row untouched; 204 idempotency preserved for all non-held cases |
| PATCH `draft/[responseId]` | 409 `{ error: 'held_for_review' }`, no UPDATE (approved ticket delta) |

Closed flag (`status != 'open'`) → all handlers behave exactly as today.
Tenant guards always run BEFORE any held branching.

**Precedence clarification (round-1 MED)**: the held gate is evaluated at its
locus; earlier business refusals (tenant, rate-limit, offboarding,
optimistic-conflict) may win. All of those are text-free, so invariant #4
holds under every precedence — the locked table describes the held branch,
not a claim that it outranks every other refusal.

**Serialization note (round-1 MED)**: the admin disposition route locks
`flagged_responses` always but locks the response row only for
`requires_regeneration` (`src/app/api/admin/flagged/route.ts:97,139`). The
post-lock placement therefore serializes against the one disposition that
mutates the response row; approve/dismiss dispositions only close the flag,
and the residual race direction is fail-safe (worst case: refuse a
just-released draft; the owner retries). Flags are only ever OPENED at
generation persist, before any owner surfacing — so no open-after-check race
exists.

## Task 1 — Eval task (the spec in executable form)

**Files**: the three test files only.
**Precedents**: `publish.test.ts:301` (held test shape);
`src/lib/moderation/__tests__/held-draft.test.ts` (SQL-text assertion
technique — the house answer to mock-fidelity risk);
`src/lib/reviews/__tests__/sentiment.test.ts` invariants block (fast-check).

Author these eight tests, titles VERBATIM. Tests 1, 3–8 must be RED against
current routes; test 2 is a deliberate GREEN characterization test locking
the release path. Commit before any implementation.

**Assertion discipline (applies throughout, from round-1 findings):**
- Seed draft text and response ids as UNIQUE SENTINELS; assert heldness
  refusals via `JSON.stringify(body)` — the sentinel appears NOWHERE, and the
  refusal body is exactly the safe shape (`{"error":"held_for_review"}` /
  `{"status":"failed","error":"held_for_review"}`).
- Where the gate's SQL is new, assert the executed template TEXT (join the
  mock call's strings): the poller lookup must contain a correlated
  `EXISTS` on `flagged_responses` with `f.status = 'open'`; the POST
  existing-draft SELECT must contain `FOR UPDATE`; the `hasOpenFlag` call's
  bound parameter must equal the target response id.

In `__tests__/draft-status.test.ts` (sqlRead queue):
1. `returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag`
2. `returns the draft text when the resolved response's moderation flag is closed`
   — seed `held: false`; today's `{ response_id, status, response_text }` shape (green characterization).
3. `spells the correlated open-flag EXISTS with status open inside the tenant-scoped response lookup`
   — SQL-text assertion on the completed-branch response query.
4. `returns 403 with no heldness signal when the held response belongs to another tenant`
   — seed `held: true` AND `business_id` ≠ caller's location; assert 403
   `forbidden`, serialized body contains neither sentinel nor any held marker
   (tenant refusal wins).

In `__tests__/draft.test.ts` (tx queue: lock-review, existing-draft, hasOpenFlag):
5. `returns 409 held_for_review without the existing draft payload when the existing draft has an open moderation flag`
   — exact-body + sentinel-absence; also assert the existing-draft SELECT
   template contains `FOR UPDATE` and the `flagged_responses` query's bound
   value is the existing response id.
6. `invariants: no non-terminal status ever leaks existing draft text or response id while an open flag exists`
   — fast-check property, `fc.constantFrom(...NON_TERMINAL_STATUSES)`
   (imported from `@/lib/shared/response-status`, never literals); assert
   exact refusal body per run.

In `__tests__/draft-id.test.ts` (tx queue per handler):
7. `DELETE returns 409 held_for_review and does not supersede a held draft`
   — queue `[{ status: 'pending_approval' }]`, `[{ one: 1 }]`; assert 409
   exact body; assert NO executed tx template contains `UPDATE responses`;
   assert the `flagged_responses` query bound the target response id.
8. `PATCH returns 409 held_for_review and does not update a held draft`
   — queue through lock-review, optimistic OK, lock-response, `[{ one: 1 }]`;
   same no-`UPDATE responses` + bound-id assertions.

Constraint: do NOT touch existing tests in this task (routes unchanged →
they stay green). Only add.

## Task 2 — Gate the poller (blocked by Task 1; runs ALONE first — enforcement spot check)

**Files**: `draft-status/route.ts` + `__tests__/draft-status.test.ts`.
**Turns green**: tests 1, 3, 4 (test 2 stays green).

In the `completed` branch, add the `held` column to the response lookup
(D6 precedent, copy the comment discipline from
`reviews/[reviewId]/draft-status/route.ts:56-75`):

```sql
EXISTS (SELECT 1 FROM flagged_responses f
        WHERE f.response_id = responses.id AND f.status = 'open') AS held
```

AFTER the existing `business_id !== locationId` tenant re-check (order is
load-bearing: tenant refusal must win — test 4), branch:
`if (response.held) return NextResponse.json({ status: 'failed', error: 'held_for_review' }, { status: 200 })`.
Update the route header comment's state table. Reconcile any existing tests
whose seeded rows now flow through the held column (absent/`false` →
release path — expected no-op, verify).

## Task 3 — Gate POST /draft (blocked by Task 1; parallel with Task 4)

**Files**: `draft/route.ts` + `__tests__/draft.test.ts`.
**Turns green**: tests 5–6.

1. Add `FOR UPDATE` to the step-2a existing-draft SELECT (round-1 HIGH: the
   gate must be post-lock on the response row per the `held-draft.ts`
   contract; lock order review→response matches publish/PATCH — no deadlock).
2. When `existingDraft` exists: `if (await hasOpenFlag(tx,
   existingDraft.response_id)) return NextResponse.json({ error: 'held_for_review' },
   { status: 409 })` BEFORE building the `draft_already_exists` payload.
   Import `hasOpenFlag` from `@/lib/moderation/held-draft` (publish
   precedent line 44).
3. Reconcile existing `draft_already_exists` tests: tx queues gain one entry
   (`[]` → not held).

## Task 4 — Gate PATCH + DELETE (blocked by Task 1; parallel with Task 3)

**Files**: `draft/[responseId]/route.ts` + `__tests__/draft-id.test.ts`.
**Turns green**: tests 7–8.

- PATCH: after the response `FOR UPDATE` lock + `pending_approval` status
  check, add `hasOpenFlag` → 409 `held_for_review` (see Serialization note).
- DELETE: inside the `pending_approval` branch, immediately after the lock
  and BEFORE the offboarding gate (publish precedent: moderation refusal
  directly after locks), add `hasOpenFlag` → 409 `held_for_review`. Update
  the DELETE doc comment: idempotent-204 for missing/terminal rows; held
  rows refuse explicitly.
- Reconcile existing PATCH/DELETE success-path tests: one added queue entry
  (`[]` → not held).

## Blocking edges & dispatch

- Task 1 → commits first (eval).
- Task 2 runs alone (first-task enforcement spot check per step 4).
- Tasks 3 and 4: mutually independent (disjoint file sets), parallel dispatch.

## Verification

Standard gate (`scripts/verify-gate.sh`); no `verification_commands`; the
three touched test files are queue-mock unit tests (no live-DB suites);
`pnpm build` runs (surface = ui). Final pre-review run with `--review`
(diff coverage ≥ 80%).

## Review appendix (round-1 rejected findings, recorded)

- Live-DB correlation/closed-flag matrix: rejected — lane change; predicate
  ownership + SQL-text assertions (held-draft.test.ts technique) close the
  named mock-fidelity gap; publish gate precedent shipped with queue mocks.
- `last_error` draft-text sentinel: rejected — speculative; `last_error` is
  worker error text, a failed outbox never persisted a draft, and draft text
  in error strings would violate the logging invariant at its source.
- Replace fc property with `it.each`: rejected — workflow mandates a
  fast-check property per approval-path invariant; strengthened to
  exact-body assertions instead (miss probability ≈ 3e-13).
