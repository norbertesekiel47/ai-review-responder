# ADR 0020 — Ask regeneration is refused once the batch is approved

## Status

Accepted — 2026-08-17 (#860). Narrows amendment **B2**
(`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` §B2,
second bullet, last sentence). Resolves deviation **D3** of #629
(`docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md`), which
recorded the question and made answering it binding on #860.

## Context

Amendment B2 kept the per-ask LLM re-roll after #619 D22 struck owner editing,
and it drew the boundary generously: "regeneration is possible only while the
batch is un-approved or (post-approval) for `rendered` rows the owner has not
excluded — a released (`queued`/`sending`/`sent`) row is never superseded."

#628 implemented exactly that. `regenerateAsk` accepted four batch states —
`built`, `approved`, `veto_window`, `sending` — at both its pre-check and its
locked re-check inside the swap transaction.

#629 built the **Owner approval** lane on top of that code and hit the clash
head-on. Approval's whole promise is that what the owner approved is
byte-for-byte what sends: the batch is frozen at approval, the veto window runs,
and the releaser (#630) sends the stored rows verbatim. B2's post-approval
clause contradicts it — a regeneration landing after approval replaces the
approved bytes with copy no owner ever saw. #629 accepted the contradiction as
**deviation D3** on one specific ground: *no owner entry point enqueued a
per-ask regenerate*. The domain function existed; nothing reachable called it.
The guarantee was conditional on paper and unconditional in the shipped product,
and D3 said the next ticket to build that entry point owns the decision.

#860 builds that entry point — the Requests panel's per-ask **Regenerate**
control, the `POST` route, and the `regenerate_solicitation_ask` topic. The
choice can no longer be inherited.

## Decision

**Regeneration is refused once `approved_at` is set. `built` is the only
regenerable batch state.**

The four-member `REGENERABLE_BATCH_STATES` set is replaced by the predicate
`isRegenerableBatchState(state)` in `src/lib/solicitation/ask-generation.ts`,
which returns `state === 'built'`. Both call sites ask it:

- the **pre-check**, which refuses with `batch_not_regenerable` and completes
  the outbox attempt (a refusal is a SUCCESS);
- the **locked re-check** inside the swap transaction, after the advisory lock
  and the batch row's `FOR UPDATE`, which raises `RegenSwapAbort` and rolls the
  swap back. This is the one that matters under concurrency: an owner may
  approve between the pre-check and the swap, and the row lock is what makes
  the refusal authoritative rather than advisory.

A predicate rather than a one-member `ReadonlySet`: with one member a Set is a
lookup table for an equality check, and both call sites want the same question
asked the same way.

## Alternatives considered

### Re-open approval for the regenerated ask — rejected

The obvious "have both" answer: let the owner regenerate after approval, and
un-approve just that ask until they look at it again. It needs three things the
system does not have.

1. **Per-ask approval state.** `approved_at`, `approval_method` and
   `approved_by_user_id` are columns on `solicitation_batches` — a BATCH is
   approved, never an ask. Per-ask approval is a migration plus a new state
   machine, and 091's approval-consistency CHECK and its
   one-active-send-per-business partial index are both written against the
   batch-level columns.
2. **A partial-approval state machine with the veto clock running.** The veto
   window is a batch-level deadline. "Approved except one ask, which is
   pending" has no defined behaviour when the deadline elapses: does the batch
   release without it, wait for it, or halt?
3. **A release predicate that honours it.** The releaser is #630 and is not
   written. Whatever it becomes would have to coordinate its row locks with a
   swap that can cancel a row it is about to release — the exact hazard the
   send lane's B11 lock order exists to avoid.

That is a large, speculative amount of machinery bought for a case the **Halt
latch** already answers.

### Keep B2 as written and let the UI hide the control after approval — rejected

Server-authoritative or it is not a rule (invariant #13's posture, applied to
domain state rather than a flag). A hidden button is not a refusal: the outbox
topic is replayable, a stale tab still holds the control, and a direct POST
bypasses the UI entirely. The gate belongs at the locked re-check, which is
where the row lock is.

### Refuse only in `sending`, allow `approved` / `veto_window` — rejected

Superficially attractive because nothing has been dispatched yet. But the veto
window is precisely the interval in which the owner is trusting the approved
bytes — that is what the window is FOR. Allowing a rewrite during it makes the
guarantee "byte-for-byte, unless someone regenerates during the window", which
is not a guarantee anyone can reason about.

## Consequences

- **The byte-for-byte guarantee becomes unconditional.** No code path replaces
  approved bytes. It is a property of the domain module now, not of which entry
  points happen to exist — which is what D3 was actually complaining about.
- **The owner's post-approval recourse is the Halt latch.** An owner who
  dislikes one message after approving must stop the whole batch, then build
  and approve a new one. That is a real ergonomic cost and it is accepted: the
  alternative is a weaker approval, and approval is the product's safety story.
- **#630's releaser never has to coordinate with a live swap.** Once a batch is
  approved, `regenerateAsk` cannot touch its rows, so the releaser's row locks
  contend with nothing that could cancel a row it is about to release. The
  send-lane lock order gets simpler, not harder, by this decision.
- **Two layers guard the same thing, deliberately.** The
  `current_attempt_not_rendered` refusal still rejects `queued`/`sending`/`sent`
  rows. Since this ADR that branch is unreachable for released rows — a `built`
  batch has released nothing — and it is kept as the second layer rather than
  the first.
- **No migration, no schema change.** Backout is reverting the PR;
  `SOLICITATION_SEND_ENABLED` is off in every environment, so neither the
  shipped nor the reverted behaviour is customer-reachable today.
- **Glossary**: the term **Ask regeneration** is coined in `CONTEXT.md`
  alongside **Owner approval** and **Ask exclusion**, and **Owner approval**'s
  conditional sentence is replaced by the unconditional one.
