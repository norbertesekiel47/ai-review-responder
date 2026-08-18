# ADR 0020 — Ask regeneration is refused once the batch is approved

## Status

Accepted — 2026-08-17 (#860). Narrows amendment **B2**
(`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` §B2,
second bullet, last sentence). Resolves deviation **D3** of #629
(`docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md`), which
recorded the question and made answering it binding on #860.

**Amended 2026-08-17, same ticket, after #860's round-1 review.** The decision
is unchanged. Two corrections: the Consequences understated the cost of the
recourse this ADR prescribes — see § Consequences → "Cost, as verified" and the
follow-up #872 — and the Context named a queue topic that does not exist.

## Context

Amendment B2 kept the per-ask LLM regeneration after #619 D22 struck owner
editing, and it drew the boundary generously: "regeneration is possible only
while the batch is un-approved or (post-approval) for `rendered` rows the owner
has not excluded — a released (`queued`/`sending`/`sent`) row is never
superseded."

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
control, the `POST` route, and an enqueue onto the topic
`QUEUE_NAMES.GENERATE_SOLICITATION_ASKS` (`generate_solicitation_asks`)
carrying an `ask_id` discriminator in the payload. The choice can no longer be
inherited.

There is **no** `regenerate_solicitation_ask` topic; an earlier draft of this
ADR named one and was wrong (#860 round-1 review, standards finding 8). The
correction matters because the SHARING is load-bearing: reusing
`generate_solicitation_asks` is exactly why the `(topic, aggregate_id =
batchId)` partial unique index (migration 091,
`job_outbox_generate_solicitation_asks_inflight`) yields "at most one
regeneration in flight per batch", and why "regenerate all" cannot exist as a
fan-out. That is the causal claim `CONTEXT.md` → **Ask regeneration** records as
LOCKED, and this ADR must not contradict it. The string
`regenerate_solicitation_ask` survives in the repo only as a `requireAttempt`
diagnostic label and as a deliberately fictitious test-fixture topic — neither
is a queue topic.

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
bytes — that is what the window is FOR. Allowing new bytes to land during it
makes the guarantee "byte-for-byte, unless someone regenerates during the
window", which is not a guarantee anyone can reason about.

## Consequences

- **The byte-for-byte guarantee becomes unconditional.** No code path replaces
  approved bytes. It is a property of the domain module now, not of which entry
  points happen to exist — which is what D3 was actually complaining about.
- **The owner's post-approval recourse is the Halt latch.** An owner who
  dislikes one message after approving must stop the whole batch, then build
  and approve a new one. **This ADR originally priced that as "a real ergonomic
  cost." That was wrong, and the true price is recorded below in
  "Cost, as verified". The decision stands; the price does not.**
  *Amended by ADR 0021 (#872, 2026-08-18): the Halt latch is no longer the
  ONLY recourse — **Ask withdrawal** cancels one approved row without touching
  bytes. "Never new bytes" is what this bullet protects, and it still holds.*
- **#630's releaser never has to coordinate with a live swap.** Once a batch is
  approved, `regenerateAsk` cannot touch its rows, so the releaser's row locks
  contend with nothing that could *replace* a row it is about to release. The
  send-lane lock order gets simpler, not harder, by this decision. *(Rows can
  still be **cancelled** under it — by the Halt latch since #629 and by Ask
  withdrawal since #872 — which is why the releaser re-checks a row under the
  batch lock before dispatch; ADR 0021 § claim 3.)*
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

### Cost, as verified — #860 round-1 review (2026-08-17)

**The decision above is unchanged. This subsection corrects the price the
Consequences originally recorded.** #860's round-1 adversarial review (finding
A1) claimed the prescribed recourse costs far more than "an ergonomic cost";
the owner verified the mechanism against the code and accepted the claim.

Halting does not release the contacts, so a rebuild does not recover them:

1. **The Halt latch never clears an ask.** `haltBatch`
   (`src/lib/solicitation/approval.ts:409`) writes `solicitation_batches` and
   cancels `solicitation_outreach` rows in `rendered`/`queued`. It does not
   touch `solicitation_asks` — the only production `UPDATE solicitation_asks`
   in the repo is `src/lib/solicitation/batch-builder.ts:656`, at build time.
   Every ask in a halted batch therefore keeps `status = 'send'` with its
   `decided_at` intact.
2. **The rebuild's candidate query keys on exactly that row.**
   `src/lib/solicitation/batch-builder.ts:501` populates `priorBatch` from a
   query filtering `AND send_ask.status = 'send'` — no join to
   `solicitation_outreach`, no `delivery_status` filter, no `halted_at IS NULL`
   filter. It keys on a prior *decision*, not a prior *send*.
3. **`MIN_GAP_DAYS = 30`** (`src/lib/solicitation/restraint-policy.ts:95`)
   then withholds each of those contacts as `over_contacted` on any rebuild
   inside 30 days (`restraint-policy.ts:405-415`).
4. **Waiting out the gap outlives the visit.** `stale_visit` is checked
   *before* `over_contacted` in the precedence chain
   (`restraint-policy.ts:346`), and `FRESHNESS_WINDOW_DAYS`
   (`restraint-policy.ts:75-84`) is `food_and_drink` 14, `retail` 14,
   `personal_care` 21, `fitness` 21, `medical_dental` 30, `automotive` 30,
   `home_services` 45, `other` 30. Only `home_services` clears a 30-day gap
   with the visit still fresh. The three 30-day verticals survive on the exact
   boundary alone — `daysSinceVisit > windowDays` is false at exactly 30, so it
   takes a visit and a decision on the same day and a rebuild on day 30
   precisely, which is not a realistic owner journey.

**Therefore: the cohort is lost for that visit, not merely delayed.** An owner
who approves a 25-person batch, reads one message and dislikes it has two
options — let it send, or halt and forfeit all 25 contacts for the visit that
made them candidates. The original wording ("stop the whole batch, then build
and approve a new one") implied the rebuild recovers them. It does not.

**Why the decision still stands.** The alternative is a weaker approval, and
approval is the product's safety story: the three alternatives above are still
correctly rejected, and nothing in this cost argues for replacing approved
bytes. What the cost does argue for is a *cheaper recourse than halting*, which
is a different act.

**Follow-up: #872 — post-approval per-ask withdrawal.** Cancelling ONE outreach
row inside the veto window is not post-approval regeneration: it removes a
message, it never replaces bytes, so it collides with neither this ADR nor
#860's `non_goals`. It moves only toward restraint — the same argument
`CONTEXT.md` → **Ask exclusion** already makes for pre-approval deselection.
#872 records the reviewer's claims (no per-ask approval state, no migration, no
coordination class `haltBatch` does not already force) as claims **to be
validated, not assumed**, and it needs its own grill and plan before any code.
**Resolved by ADR 0021** (`0021-ask-withdrawal-is-restraint-not-reapproval.md`,
2026-08-18): claims 1 and 3 hold; claim 2 was set aside by choice — a distinct
`owner_withdrawn` reason (migration 109) keeps **Ask exclusion**'s stored value
honest.

**Watch item.** The severity of this cost is a pure function of two day-one
constants — `MIN_GAP_DAYS` and `FRESHNESS_WINDOW_DAYS` — both documented as
"replaced by learned curves later behind the same gates"
(`restraint-policy.ts:70-73`). When either moves, re-derive this subsection.
