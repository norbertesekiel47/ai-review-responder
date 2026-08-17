# feat-860 — Adversarial approach review

Scope: approach, design choices and assumptions only. Line-level defects,
naming and style belong to the two parallel reviewers and are deliberately
absent.

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface`
- Base: `f28451ee` (merge-base with `origin/main`)
- Inputs read: `.feature/intake.json`, `docs/adr/0020-regeneration-refused-after-approval.md`,
  `docs/superpowers/plans/2026-08-17-860-ask-regeneration-surface.md`,
  `docs/superpowers/plans/feat-860-ask-regeneration-surface-deviations.md` (D1–D14),
  `CONTEXT.md` (Ask regeneration / Owner approval / Ask exclusion / Halt latch).
- Second model: `/codex:adversarial-review --background --base f28451ee` ran to
  completion (verdict `needs-attention`). Its two runtime findings are folded in
  below as A3 and A5, both independently re-derived here. Its third finding
  (intake schema) is in the low-confidence appendix with the reason.

---

## Findings (≥80% confidence)

| # | Severity | Area | Finding |
|---|---|---|---|
| A1 | high | ADR 0020 — consequences | The prescribed post-approval recourse forfeits the whole cohort for 30 days, not just the batch; for 7 of 8 verticals the visit goes stale first, so the loss is permanent. |
| A2 | high | ADR 0020 — alternatives | The ADR never considers post-approval per-ask *withdrawal*, which answers the same ergonomic problem at the cost of one contact and needs no machinery the lane does not already have. |
| A3 | high | Client state model | Exclusions and the pending-regeneration marker live below a boundary every write crosses; each accepted regeneration unmounts the panel and silently re-selects every deselected ask. |
| A4 | medium | Lock ordering | Enqueue-before-validate resolves the deadlock on the wrong side; inverting two statements in `regenerateAsk`'s swap dissolves it at the source and is inside this feature's own edit surface. |
| A5 | medium | Tenant isolation | `already_in_flight` is decided from a bare batch id before ownership is proven, breaking the uniform-404 contract and the intake's own tenant invariant. |
| A6 | medium | Budget shape | The owner-visible "N of 3 today" counts attempts *charged*, not versions *produced* — refusals consume budget and report one undifferentiated sentence. |
| A7 | medium | Outbox dedup key | "One regeneration in flight per batch" and "regenerate all is impossible" are artifacts of reusing the `generate_solicitation_asks` topic, now recorded in `CONTEXT.md` as domain law. |
| A8 | low | Read-path layering | `readSendLane` awaits an Upstash `MGET` inside the read model's `READ ONLY REPEATABLE READ` transaction, holding a pooled connection across a cross-provider round-trip on every page load. |

---

## A1 — the Halt-latch recourse costs the cohort, not the batch (high)

**The claim under test.** ADR 0020, Consequences: *"An owner who dislikes one
message after approving must stop the whole batch, then build and approve a new
one. That is a real ergonomic cost and it is accepted."* The intake's non-goals
repeat it, and `CONTEXT.md` → **Owner approval** now records it as the owner's
recourse.

**Why it is wrong.** Rebuilding does not recover the people. The build's
candidate query keys the `over_contacted` withhold on a prior *decision*, not a
prior *send*:

`src/lib/solicitation/batch-builder.ts:501-513`

```sql
SELECT DISTINCT ON (send_ask.contact_id)
  send_ask.contact_id, send_ask.batch_id, send_ask.decided_at
FROM solicitation_asks send_ask
WHERE send_ask.business_id = ${businessId}::uuid
  AND send_ask.contact_id = ANY(${contactIds}::uuid[])
  AND send_ask.status = 'send'
```

There is no join to `solicitation_outreach`, no `delivery_status` filter and no
`halted_at IS NULL` filter. `haltBatch` writes `solicitation_batches` and
`solicitation_outreach` only — the sole `UPDATE solicitation_asks` in the repo
is in `batch-builder.ts:656`, at build time. So a halted batch leaves every one
of its contacts carrying `status='send'` with today's `decided_at`.

`restraint-policy.ts:95` sets `MIN_GAP_DAYS = 30`, and `:405-415` withholds any
candidate whose prior decision is inside that gap. The rebuilt batch therefore
contains none of them for 30 days.

**And 30 days is longer than they survive.** `FRESHNESS_WINDOW_DAYS`
(`restraint-policy.ts:75-84`) is 14 (food_and_drink, retail), 21 (personal_care,
fitness), 30 (medical_dental, automotive, other), 45 (home_services), and
`stale_visit` has *higher* precedence than `over_contacted` (`:346`). For every
vertical except `home_services`, a contact blocked by the 30-day gap is
`stale_visit` before the gap expires.

**The realistic owner journey**, which is what the brief asked for. Owner
approves a 25-person batch, reads message 12 thirty seconds later, and hates it.
Their actual options are:

1. Let it send. The bad message goes out.
2. Stop the batch. Nothing sends. All 25 people are locked out of solicitation
   for 30 days, and — for a restaurant, a shop, a salon, a gym — their visit has
   gone stale by then, so they are lost outright, not delayed.

There is no third option. The ADR prices this as an ergonomic cost; it is a
cohort-loss cost, and the owner discovers it only after halting.

**Approach conclusion — this is a plan/ADR revision, not a code patch.** The
decision to refuse regeneration after approval may well still be right: the
byte-for-byte argument is sound and the alternatives the ADR *did* consider are
correctly rejected. What is not defensible is shipping the Consequences section
as written. At minimum it has to state the true price. Better, it should be
re-decided against A2, which was never on the table.

---

## A2 — the ADR omits the cheap alternative: post-approval per-ask withdrawal (high)

The ADR weighs three alternatives — per-ask re-approval state, UI-only hiding,
and refusing only in `sending` — and rejects all three correctly. It never
considers the option that sits between "refuse everything" and "re-open
approval": **let the owner withdraw one already-approved ask during the veto
window.** Cancel the row; do not replace it.

That option costs almost nothing the lane does not already own:

- **It does not touch byte-for-byte at all.** Nothing approved is replaced, only
  withdrawn. This is exactly the argument `CONTEXT.md` → **Ask exclusion**
  already makes for why exclusion needs no re-lint and no re-moderation: *"It
  only ever moves toward restraint — it removes a message, never adds or alters
  one."* Withdrawal one minute after approval is the same act as exclusion one
  minute before it.
- **It needs no per-ask approval state.** The ADR's first objection to
  alternative (a) is that `approved_at` is a batch column. A withdrawn ask is
  not un-approved; it is cancelled. The batch stays approved and its veto clock
  keeps running, so objection (2) — "a partial-approval state machine with the
  veto clock running" — does not arise either.
- **It needs no new coordination class for #630.** The ADR's third consequence
  claims the releaser "never has to coordinate with a live swap." True for
  regeneration — but `haltBatch` already cancels `rendered`/`queued` rows after
  approval, so the releaser must already tolerate a row vanishing under it.
  Per-ask withdrawal is the same hazard at smaller granularity, not a new one.
- **It needs no migration.** `delivery_status='cancelled'` with
  `disposition_reason='owner_excluded'` shipped in migration 108 (#629).
  `closeBatchIfSettled` is already the single terminal-writer join.

Its cost is one contact instead of twenty-five, and that one contact is the one
the owner actually wanted to drop.

I am not asserting it should ship in #860 — it is out of this ticket's surface.
I am asserting that ADR 0020 decided "refuse, and the recourse is halt" without
that option on the page, and that A1 shows the recourse it chose is far more
expensive than it believed. **Revisit the ADR: add the alternative, price A1
honestly, and either accept the recourse knowingly or open a follow-up ticket
for withdrawal before `SOLICITATION_SEND_ENABLED` is flipped.**

---

## A3 — owner intent lives below the refetch boundary (high)

Independently found by Codex (its finding 1) and re-derived here.

Two individually reasonable decisions are jointly wrong:

1. `RequestsClient` owns `phase`, and every settled write hands the refetch back
   to it — `onLaneChanged` → `retry()` (`RequestsClient.tsx:92-97`).
2. `retry()` sets `phase` to `LOADING` (`:421-424`), and `BatchStage`'s
   `case 'loading'` renders `<LoadingCard />` (`:165-166`).

Different component at the same position means `ApprovalPanel` **unmounts**. Its
`excludedAsks` state and its `pendingRegen` ref are per-instance, so both are
destroyed. When the poll returns a built view, a fresh panel mounts with
`useState(() => new Set<string>())`.

Two consequences:

- **Every accepted regeneration silently clears the owner's deselections.**
  Deselect three people, regenerate a fourth, and the panel comes back with all
  three re-selected and the Approve button's count restored. Approving then
  sends to people the owner explicitly deselected. This is precisely the
  finding-6 symptom D14 §1 mutation-checked against ("Approve and send **2**
  messages" after the regeneration) — the fix was applied to the exclusion *key*
  (`askId` over `outreachId`) while the state itself does not survive the write.
  The panel's own comment asserts the opposite: *"there is deliberately no
  pruning effect: an ask's identity survives a regeneration, so a deselection
  does too"* (`ApprovalPanel.tsx:589-596`). It survives a re-render; it does not
  survive the refetch that every regeneration triggers.
- **The promised unchanged-copy report can never fire.** `pendingRegen` is set
  in `onRegenerate` and read by the settle effect (`:637-651`), but it is
  destroyed by the same unmount. Intake `user_visible_behavior[7]` — *"When a
  rewrite settles without changing the copy … the panel says so rather than
  silently showing the same text"* — does not hold in production.

**Why the tests do not catch it.** `approval-panel.test.tsx:812-850` (`keeps an
ask excluded when a regeneration replaces its outreach id`) uses `rerender` on a
live instance. `rerender` preserves the mount; production does not. The test is
correct about the key and blind to the lifecycle.

**Approach conclusion.** The state placement is the design error, not the
symptom. Either exclusions and pending-regeneration tracking move above the
loading boundary (keyed by scope + batch id, like `lane` already is), or the
refetch stops blanking a built view it is only refreshing. The second is
probably right — `retry()` blanking the screen is what makes a 2-second poll
feel like a page reload — but that is a decision for the plan, not a patch.

---

## A4 — the deadlock was resolved on the wrong side (medium)

`requestAskRegeneration`'s docstring argues the lock order carefully and reaches
the wrong conclusion. It observes that `regenerateAsk`'s swap opens with
`markOutboxCompletedIfOwned` (a `job_outbox` row lock) and only then calls
`acquireSolicitationBatchLock`, concludes that amendment B11 is "INCOMPLETE for
any writer that owns an outbox attempt," and inverts the *request* path to
enqueue-before-validate. That buys a second abort sentinel
(`RegenRequestAbort`), a validate-after-mutate transaction, and A5.

But the worker's ordering is a convention, not a necessity. The comment at
`ask-generation.ts:1410` says only *"CAS-before-mutation: the transaction's
FIRST statement."* Moving `acquireSolicitationBatchLock` ahead of it puts both
sides in B11's stated advisory-first order and the ABBA dissolves: whoever takes
the per-business advisory lock first proceeds, the other waits. A stale attempt
would hold the advisory lock for one extra statement before failing its CAS,
which is not a cost worth this much structure.

And it was available. `regenerateAsk` lives in
`src/lib/solicitation/ask-generation.ts`, which matches
`allowed_edit_surface`'s `src/lib/solicitation/*` and which this feature already
edits (`isRegenerableBatchState`). The `worker/` non-goal did not block it — the
worker file is a 20-line dispatcher.

**Approach conclusion.** Worth revisiting before this reaches prod, because the
cost is not local: `requestAskRegeneration` is now the in-repo precedent for
"enqueue first, validate after," and the docstring instructs the next reader
*"Do not 'tidy' this back into validate-first."* If the premise it rests on is a
movable convention, that instruction outlives the reason for it.

---

## A5 — `already_in_flight` is decided from a bare batch id (medium)

Independently found by Codex (its finding 2) and re-derived here.

`approval.ts:573-585`: the transaction's first statement is
`enqueueGenerateSolicitationAsks`, whose `ON CONFLICT (topic, aggregate_id)`
carries no tenant discriminator (`job-outbox-helpers.ts:661-677`). A `null`
return is *"the ONE refusal that may still return normally rather than throw"* —
so it returns before `lockBatchForAction` proves ownership.

Result, for a batch id the caller does not own:

- in-flight generation exists → 409 `already_in_flight`
- no in-flight generation → insert succeeds, `lockBatchForAction` returns null,
  abort → 404 `not_found`

That is a cross-tenant state oracle, and it contradicts two things this branch
wrote itself: the intake invariant *"a bare batch or ask id is no tenant
proof"*, and the function's own comment *"An ask id from another batch or
another tenant produces no row and is indistinguishable from an unknown one —
the uniform 404."*

Practical exploitability is low: batch ids are UUIDv7 and are never rendered
(ADR 0012). The plausible case is same-account, cross-location — an owner
re-scoped to location A who still holds a batch id from location B. The existing
foreign-tenant test only covers the no-conflict branch, so the leak is untested
in both directions.

Fixing A4 removes this for free: with validate-first ordering the dedup probe
never runs before ownership is proven.

---

## A6 — the counter counts charges, not versions (medium)

`checkAskRegenBudget` is the first thing `regenerateAsk` does after the flag gate
(`ask-generation.ts:1337-1345`) — before `loadBatchContext`, before the
subscription gate, before the state check, before the render check, before
`assembleInterpolation`, and before the LLM call. Every refusal downstream of it
has already consumed one of the three.

The route's pre-validation removes most of those, but not all. Still reachable
and charged:

- `daily_cost_budget_exhausted` — the *account's* daily LLM ceiling. While it is
  exhausted, every regenerate refuses after charging, so an owner can walk one
  message from 0/3 to 3/3 with nothing produced.
- `subscription_inactive`, `batch_not_regenerable` (the owner approved
  mid-flight — the intake's own edge case 1), `current_attempt_not_rendered`,
  `ask_has_no_visit`, and every `RegenSwapAbort`.

The owner sees one sentence for all of them — *"We could not write a new
version. The message below is unchanged."* — with no reason and no indication
that the attempt was counted. On the next poll the counter beside the control
has silently ticked down.

The brief asked whether the advisory-peek/authoritative-INCR split produces a
surprising experience. The split itself is handled well: the route peeks and
fails open, the panel detects an unchanged `attemptNo`, and the copy says so
rather than showing stale text silently. What is surprising is the *charge
point*. "Charged per logical request" is stated as the design; charging before
validating means refusals are billed to a budget the owner is watching.

**Approach conclusion.** Either move the charge after the cheap pre-checks
(keeping the SET-NX idempotency marker where it is, so replays stay free), or
have the refusal sentence say the attempt was counted. The second is a copy
change; the first is the honest one.

---

## A7 — the dedup key is an artifact promoted to domain law (medium)

The intake states `"regenerate all"` is *"structurally impossible without
re-keying the dedup"*, and `CONTEXT.md` → **Ask regeneration** now records *"At
most one regeneration is in flight per batch, because the enqueue dedups on
`(topic, aggregate_id = batchId)`; that is also why 'regenerate all' cannot
exist as a fan-out."*

Both sentences describe an implementation choice, not a domain fact. The choice
is reusing the `generate_solicitation_asks` topic with an optional `ask_id`
discriminator in the payload (`job-outbox-helpers.ts:645-678`,
`worker/jobs/solicitation-batch/generate.ts:25-33`). A dedicated topic keyed on
the ask — `(topic='regenerate_solicitation_ask', aggregate_id=askId)` — gives
per-ask dedup, makes fan-out natural, and stops regeneration contending with a
batch rebuild for the same slot.

ADR 0020 in fact asserts that topic exists: *"#860 builds that entry point — the
Requests panel's per-ask Regenerate control, the `POST` route, and the
`regenerate_solicitation_ask` topic."* `rg` finds no such topic anywhere in
`src/` or `worker/`; `QUEUE_NAMES` has only `GENERATE_SOLICITATION_ASKS`. The
ADR is describing a design the branch did not build.

Consequences the owner feels, at `BATCH_CAP = 25` asks per batch:

- Regenerations are strictly serial per batch, each an LLM round-trip, and
  `ApprovalActions` is `unavailable` for the whole of each one — so reviewing a
  batch with several weak messages is a sequence of blocking waits.
- A regeneration and a batch rebuild cannot be in flight together.

**Approach conclusion.** This is the finding most worth acting on *now*, because
of where it was recorded. Re-keying later is not a refactor: it means amending a
LOCKED `CONTEXT.md` term that carries a causal claim, plus the ADR that repeats
it. Either build the dedicated topic while the flag is still off, or rewrite
both sentences to say "we chose one in flight per batch" rather than "one in
flight per batch is what the mechanism permits."

---

## A8 — external I/O inside the read model's transaction (low)

`readSendLane` is called inside `readLatestBatch`'s `READ ONLY REPEATABLE READ`
transaction (`batch-view.ts:726`, `:679`), and now awaits
`peekAskRegenBudgetBatch` — an Upstash `MGET` — while that transaction is open
(`:565-573`). Every Requests page load with the send flag on holds a pooled
Postgres connection and an open snapshot across a cross-provider round-trip.

The peek's own comment says the data is *"ADVISORY presentation facts, not
inputs to any gate"* and that it is *"read AFTER the tenant-scoped statements
rather than woven into them."* It gains nothing from the snapshot and could be
read after the transaction closes.

Under the #773 admission chokepoint, pool occupancy is the scarce resource by
design — `DB_POOL_MAX` caps connections, not concurrency, and the gate trades
latency for never wedging. Adding an Upstash RTT to every Requests transaction
spends that resource on data the transaction does not need. On an Upstash
*slowdown* (not an outage — the outage path fails open promptly) the cost is
paid on every page load.

Low severity today because the flag is off everywhere and Requests is a
low-traffic surface. Worth moving before the flip.

---

## Questions from the brief, answered directly

**Does the feature ship inert safely?** Yes — I found no path reachable before
the flag flip. `requireSolicitationSendWriteAccess` gates the route on both
`SOLICITATION_WATCH_ENABLED` and `SOLICITATION_SEND_ENABLED`, and it runs
*outside* the `try` in `withScopedBatch` so it cannot be flattened into a 500.
`readSendLane` is never called with the flag off (`batch-view.ts:673-679`), so
`sendLane` is `null`, so no control renders and no Redis peek is issued.
`regenerateAsk` re-checks `solicitationSendEnabled()` before anything else. The
ADR's narrowing changes `regenerateAsk`'s behaviour for existing batches, but
there are none. Nothing to report.

**What assumption is most likely to be wrong in six months?** That `built` is a
state an owner *sits in*. The entire surface — the control, the 3/day pacing,
the serial one-at-a-time constraint of A7, the polling loop — assumes a human
lingering in `built` with time to iterate. Once #630's releaser and #631's auto
lane land, Autopilot batches pass through `built` in seconds with no human, and
a regeneration surface reachable only in `built` becomes a Copilot-only
affordance. If Autopilot is where the product is going, the interesting question
is not "may the owner re-roll before approving" but "what may the owner do to a
batch nobody approved" — and this design has no answer, because it deliberately
made `built` the only door.

Runner-up: `MIN_GAP_DAYS = 30` and `FRESHNESS_WINDOW_DAYS` are documented as
*"day-one constants … replaced by learned curves later behind the same gates."*
A1's severity is a pure function of those two numbers. When they move, the true
cost of ADR 0020's recourse moves with them, and nothing links the ADR to them.

---

## Appendix — below the confidence bar (not in the table)

- **Codex finding 3 — `.feature/intake.json` fails `validate-intake.mjs`
  (15 errors: missing `version`, `size`, `risk`, `risk_reasons`, `test_seams`,
  `required_approvals`; unknown `classification`; string-valued line
  estimates).** Not reported as a finding. `.feature/gate-status.json` records a
  `full` gate with 26 checks all PASS, including `feature-surface` and
  `promised-tests`, so the repo's own `/feature` flow accepted this intake
  shape. The validator Codex ran appears to belong to a different (newer or
  plugin-shipped) intake schema. If the two really are meant to be the same
  contract, that is a tooling-drift ticket, not an approach finding about #860.
- **`ask_has_no_visit` as a permanent budget sink.** An ask whose visit row was
  deleted after render would refuse every regenerate while charging the counter,
  burning 3/3 with no output. Folded into A6 rather than reported separately —
  I could not establish that the visit row is deletable independently of the
  ask, so the standalone scenario is unproven.
- **`pendingRegen` does not survive a page reload**, so an owner who reloads
  during a regeneration never sees the unchanged-copy report. Subsumed by A3,
  which destroys it far more often.
- **Poll ceiling interaction.** `POLL_CEILING_MS` is 5 minutes measured from
  loop start, and `retry()` restarts the loop, so a regeneration gets a fresh 5
  minutes. Checked and clean — noted only because it looked like a hazard.
- **Withheld replacement ends the ask permanently.** A regeneration whose
  replacement is itself `withheld` leaves the ask with no live render, terminal
  for the batch — so "3 tries" can end after one. Documented as intended in
  `CONTEXT.md` → **Ask regeneration** and in the intake's edge cases; I disagree
  with it mildly but it is a recorded decision I cannot argue is wrong.
