# 0011 — Watch-mode executor: children are runs, but lifecycle and fan-out stay off the spine

Date: 2026-07-23
Status: accepted
Context: ticket #534 (wayfinder map #528); spec
`docs/superpowers/specs/2026-07-23-run-engine-executor-shape.md`; gap analysis
`docs/research/2026-07-23-run-engine-gap.md` (#529).

## Context

The run engine (design doc §3.2/§9.2) makes Solicitation watch-mode the first
tenant of parent/child lifecycle on the run spine. The May reference design
(§3.1/§6.2–6.3) specifies a 6-state `agent_runs` status enum
(`pending/held_for_approval/cancelled/…`), physical `throttled_fan_out`,
`wait_for_children`, and halt/resume verbs. The as-built spine (WS1–WS8) has a
3-state enum with two coupled constraints (terminal-consistency CHECK; the
one-active-per-subject partial index whose `WHERE status='running'` predicate
must stay byte-for-byte with the writer's ON CONFLICT), and WS5 deliberately
derives display states (`waiting_on_owner`, `stalled`) at read time instead of
storing them. Watch-mode evaluates candidates through a pure policy function
and sends nothing.

## Decision

1. **Per-candidate children ARE `agent_runs` rows, shipped now**, linked by a
   new nullable `parent_run_id` (`ON DELETE SET NULL`). The parent/child graph
   send-mode and the Reply migration will read is real from day one.
2. **Fan-out is logical in watch-mode**: one worker job creates, steps, and
   completes all child runs inline. Before any parent mutation, preparation
   locks the exact dispatched outbox attempt, then the batch. Construction is
   atomic: after starting or reusing the parent, one ownership-checked,
   per-location-serialized transaction bulk-writes every completed child
   run/step and ask, records the parent terminal attribution, sets `built_at`,
   and completes the outbox row. No per-candidate jobs, no join primitive, no
   throttled spawn. The existing run-spine module owns a focused set-based
   bulk-child interface so the 5,000-candidate bound does not become thousands
   of sequential queries.
3. **Batch lifecycle (`built → reviewed → expired`) lives on
   `solicitation_batches`**, not on `agent_runs.status`. The spine's 3-state
   enum and both coupled constraints are untouched. The ingest transaction
   creates the batch with nullable `built_at`; NULL means construction is
   pending, not a stored lifecycle state. The executor sets `built_at`
   atomically with the parent run's terminal attribution, and owner reads
   expose only built rows. `expired` is derived at read time from `built_at`
   (WS5 precedent), and per-candidate decisions are authoritative in
   `solicitation_asks` (which outlive 180-day run archival).

## Consequences

- Deviates from the May reference design in two ways a future reader will
  question: the status enum does not grow, and `wait_for_children` is not
  built despite "parent/child lifecycle" being the ticket's headline. Both
  are deferred to send-mode, which has the first real requirement for them
  (asynchronous children that can individually fail; batches that block on
  approval). Building them against synchronously-completing children would
  test the machinery against nothing.
- One spine migration covers both modes' schema (`parent_run_id`, new
  kinds/pairings, persona, outcome kind); send-mode adds states/verbs, not
  columns-plus-rework.
- `built_at` is the completion fact, not the row-creation timestamp. Keeping
  it nullable during construction lets the CSV-ingest transaction own batch
  identity and outbox enqueue without claiming unfinished work is built.
- Atomic construction keeps retries simple and prevents owner-visible partial
  batches. The parent is committed before construction so an exhausted
  failure remains attributable; a rolled-back construction leaves that parent
  running for retry or terminal failure handling.
- Feature and full-access subscription gates are checked on every attempt. A
  closed gate removes owned unbuilt work without creating a failed run when no
  parent exists; when a prior attempt already started the parent, the same
  terminal transaction completes the owned outbox and marks that parent failed
  with bounded `gate_closed` attribution.
- All widenings are additive/nullable, so months of `review_handler` rows
  stay valid and replayable (design §3.2 binding mitigation).
- Cost of reversal: `parent_run_id` and the new kinds are cheap to carry if
  send-mode never ships; moving batch lifecycle ONTO the spine later would
  require the coupled CHECK/index/writer change this ADR avoided, plus a
  backfill — that is the deliberate trade.
