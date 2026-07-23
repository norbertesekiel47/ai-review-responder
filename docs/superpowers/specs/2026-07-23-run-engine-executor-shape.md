# Run-engine executor shape — watch-mode decisions (ticket #534)

Locked in the 2026-07-23 grilling session. Part of wayfinder map #528
(Solicitation watch-mode). Seeded by the #529 gap analysis
(`docs/research/2026-07-23-run-engine-gap.md`, branch `research/run-engine-gap`)
and bound by design doc §9.1
(`docs/future-plans/2026-07-01-agentic-reputation-platform-design.md`).
Rationale for the two reference-design deviations: ADR 0011.

These decisions bind the implementation tickets on map #528 (restraint policy
module, CSV ingestion, executor, batch UI). Vocabulary is canonical per
`CONTEXT.md` ("Solicitation (watch-mode)" section): **batch** and **ask**;
"list"/"member" (May doc §3.2) are superseded, "outreach" is reserved for
send-mode sends.

## Decisions

### D1 — Children are full runs, created now

- Parent run: `kind='solicitation_batch'`, `subject_type='solicitation_batch'`,
  `subject_id` = batch UUID.
- One child run per candidate: `kind='solicitation_ask'`,
  `subject_type='solicitation_ask'`, `subject_id` = ask UUID.
- New nullable `agent_runs.parent_run_id UUID` self-FK,
  `ON DELETE SET NULL` (archival-safe: the ArchivalPoller may delete a parent
  before its children in the same sweep window).
- `agent_runs_kind_subject_type_pairing` CHECK extended with both new pairs,
  additively. The `agent_runs_one_active_per_subject` partial unique index and
  the writer's ON CONFLICT are **unchanged** — batch and ask subjects are
  unique per run by construction.

### D2 — Logical fan-out (watch-mode)

One `build_solicitation_batch` worker job executes the whole graph: it starts
the parent run, then for each candidate creates the child run, records its
policy-gate step (`evaluateAsk`, the #533 restraint policy module), persists
the ask row, and completes the child inline. The parent records the aggregate
step + outcome and completes in the same job. Candidate count is bounded by
the CSV ingest cap.

Deliberately NOT built: `throttled_fan_out`, `wait_for_children` /
join primitives, per-child retry, physical per-candidate jobs. Those arrive
with send-mode, where children genuinely run asynchronously and can
individually fail.

### D3 — Batch lifecycle lives on the domain entity, not the spine

- New `solicitation_batches` table is authoritative for batch lifecycle.
- `agent_runs.status` keeps the 3-state enum (`running/completed/failed`);
  the `agent_runs_terminal_consistency` CHECK and the active-index predicate
  are untouched. The run records the *work of building* the batch and is
  terminal when the batch is built.
- Spine lifecycle states (`pending`, `held_for_approval`, `cancelled`,
  halt/resume/wait verbs) are a send-mode grilling — watch-mode never waits
  on anyone.

### D4 — Expiry is derived, never stored

`solicitation_batches` stores `built_at NOT NULL` and `reviewed_at`
(nullable, set when the owner opens the batch). `expired` is derived at read
time from `built_at` age against a code-constant window (not a flag, not an
env var). No status column, no expiry poller. Send-mode revisits when expiry
has behavioral force (blocking sends from stale batches).

### D5 — `solicitation_asks` rows are the authoritative decisions

Per-candidate decision record, written in the SAME transaction as its child
run (outbox discipline; lock ordering mirrors run-spine.ts: domain row first,
then spine rows):

- `status` — `send | withhold`. In watch-mode `send` means "would send";
  nothing is transmitted.
- `withheld_reason` — closed enum owned by the #533 restraint policy module.
- `evidence JSONB` — the policy inputs that justify the decision (spoilage
  report substrate).
- `agent_run_id` FK to the child run, `ON DELETE SET NULL`
  (`judge_verdicts` pattern) — decisions survive the 180-day run archival.

### D6 — One batch-level outcome

`agent_outcomes` gains one kind: `solicitation_batch_built`, recorded on the
parent run with `unit_count` = candidates evaluated. Children get steps, no
outcomes. Per-child value events (`sent`, `review_attributed`) are send-mode
kinds. Outcome billing columns remain deferred (design §8.5).

### D7 — Trigger, topic, persona, flag

- **Trigger:** the transaction that completes a CSV ingest (#535) also
  INSERTs the `solicitation_batches` row and the `build_solicitation_batch`
  `job_outbox` row — one tx, standard outbox pattern. A manual "rebuild"
  verb may ride the batch UI ticket later; it reuses the same topic.
- **Topic/queue:** `build_solicitation_batch` added to `QUEUE_NAMES`
  (`src/lib/shared/queue-names.ts`; `ci:outbox-topics` enforces the pairing).
  The only new engine topic in watch-mode.
- **Persona:** `solicitation` added to the `attributed_agent` CHECK,
  `AGENT_PERSONAS`, and `STEP_PERSONA` (new step keys map to it).
- **Flag:** everything behind server-side `SOLICITATION_WATCH_ENABLED`
  (design §9.1 decision 4): the trigger site checks it (no batch rows, no
  outbox rows when off) and the UI hides the surface. No autonomy-flag
  ceremony — watch-mode takes no public action. Worker gates on
  `subscriptionGrantsFullAccess` per invariant #11.

## Constraints carried from research

- **Reply-migration compatibility (#529 Q7):** every schema change is
  additive/nullable — `parent_run_id` NULL for all existing rows, CHECK
  widenings additive. Existing `review_handler` rows stay valid and
  replayable; Phase 3 Reply migration inherits the same columns.
- **Tripwire budget (#529 Q6):** estimated ~600–800 production LOC
  (spine migration ~150, run-spine.ts widening ~150, worker job ~300,
  read model ~200) against the ~2–3k "buy Inngest/Temporal" tripwire in the
  design-doc risk table. Send-mode's fan-out/join spend is budgeted
  separately when that map opens.

## Deliberately NOT built until send-mode

Physical fan-out + join primitives; halt/resume/cancel/wait lifecycle verbs
and any spine status-enum extension; `coordination_key`; consent-ledger
semantics beyond the upload attestation; suppression; veto window on batches;
outcome billing; Judge auditing of withhold decisions; Governor per-gate
suspension; `auto_approval_policies` persona/action_class widening (watch-mode
auto-approves nothing).
