# Run-engine gap analysis — spine as-built vs run-engine spec (ticket #529)

Research capture for wayfinder map #528. Verifies the run-engine spec (design
doc `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §3.2 /
§4 / §9 + May doc `docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md`
§3 / §6) against the current run-spine schema and writer. Facts only — the
design decisions belong to grilling ticket #534.

All refs are against `main` @ `c8fd0b05` (2026-07-23).

---

## 1. Verified facts — what exists today

### 1.1 Tables (migrations 071, 074, 075, 079)

**`agent_runs`** (`supabase/migrations/071_agent_run_spine.sql:15-36`):

| Column | Notes |
|---|---|
| `id UUID PK` | app-generated UUIDv7 |
| `account_id`, `business_id` | tenant scoping, `business_id` nullable |
| `kind` | CHECK `IN ('review_handler', 'weekly_insights')` — 071:19 |
| `subject_type` | CHECK `IN ('review', 'account_week')` — 071:20 |
| `subject_id TEXT` | polymorphic, no FK by design (071:94-95) |
| `status` | CHECK `IN ('running', 'completed', 'failed')` — 071:22-23. **No** `pending` / `held_for_approval` / `cancelled` / waiting states |
| `correlation_id TEXT` | free-form log-join string (071:96-97) |
| `started_at`, `ended_at`, `error JSONB` | `agent_runs_terminal_consistency` CHECK: `(status='running') = (ended_at IS NULL)` — 071:28-29 |

Cross-column CHECK `agent_runs_kind_subject_type_pairing` pins each kind to
exactly one subject_type (071:30-33). Partial unique index
`agent_runs_one_active_per_subject ON (kind, subject_type, subject_id) WHERE
status='running'` (071:40-42) — this is the writer's ON CONFLICT target and
must stay byte-for-byte with it. Plus `idx_agent_runs_subject
(subject_type, subject_id, started_at DESC)` for historical reads
(`075_agent_runs_subject_index.sql:6-7`) and archival index
`idx_agent_runs_archival (ended_at) WHERE ended_at IS NOT NULL`
(`079_agent_run_spine_archival_indexes.sql:20-21`).

**`agent_run_steps`** (071:49-62): `agent_run_id FK CASCADE`, `step_index`
(UNIQUE per run), `step_key TEXT` (free-form; persona map is TS-side),
`attributed_agent` CHECK `IN ('reply','guardian','insights','system')`,
`status` CHECK `IN ('completed','failed','skipped')` — steps are **appended
after the fact**, never scheduled: there is no `pending`/`running` step state,
no `input`/`output`, no `step_kind` (tool_call/llm_call/policy_gate/…), no
`cost_cents`, no `tool_authorization_id` (all of which the May doc §3.1 step
table specified).

**`agent_outcomes`** (071:67-87 + 074:98-107): `outcome_kind` CHECK currently
(after 074) `IN ('reply_drafted','reply_posted','reply_auto_posted',
'reply_approved_no_edit','reply_edited_by_owner','reply_vetoed_by_owner',
'review_escalated','escalation_resolved','digest_sent')`. Dedup partial
unique `agent_outcomes_once_per_run_kind (agent_run_id, outcome_kind) WHERE
agent_run_id IS NOT NULL` (071:85-87). No billing columns
(`billing_period_*`, `pricing_version`, `metered_to_stripe_at` from May doc
§3.1 were deliberately dropped — design doc §8.2: "`billable_outcomes`
shipped as `agent_outcomes`").

**Posture:** all three tables deny-all RLS (071:109-113); retention 180 days
via ArchivalPoller (079 header). Migration head is 083; next number 084.

### 1.2 Writer lib — `src/lib/agents/run-spine.ts`

The ONLY module that writes the three tables (file header, :1-8). Contract:
every writer takes a `TransactionSql` and runs in the SAME transaction as the
pipeline state change (attribution, not execution — :2-7). Surface:

- `startOrGetActiveRun(tx, input)` (:84-120) — INSERT … ON CONFLICT on the
  partial index, race-safe "at most one running run per subject".
  `StartRunInput` is a discriminated union pinning kind↔subject_type (:68-72).
- `findActiveReviewRun(tx, reviewId)` (:127-139) — hardcoded to
  `kind='review_handler'`.
- `recordStep(tx, input)` (:159-183) — locks the run row FOR UPDATE, computes
  `MAX(step_index)+1` in a follow-up statement, persona derived from the
  authoritative `STEP_PERSONA` map (:38-50; 11 step keys today).
- `recordOutcome(tx, input)` (:206-218) — ON CONFLICT DO NOTHING dedup per
  (run, kind).
- `completeRun(tx, runId, 'completed'|'failed', error?)` (:226-252) —
  idempotent terminal transition; only `running → completed|failed` exists.

Documented lock-ordering rule (:9-17): review-row lock FIRST, then spine rows.

### 1.3 Reader — `src/lib/agents/read.ts`

- `RunDisplayState` (:9-14): `in_progress | waiting_on_owner | stalled |
  completed | failed` — **derived at read time** (`deriveRunDisplayState`
  :84-105, stalled = running >48h), not stored. "Waiting" is inferred from
  the latest response's status, not a run state.
- `getReviewTimeline` (:277-395) reads runs by `(account_id, kind='review_handler',
  subject_type='review', subject_id)` — kind is hardcoded; a new run kind needs
  its own read path or a widened one.
- `getAgentTeamSummary` (:397-424) counts outcomes by persona; `mapTeamSummary`
  (:251-275) has a hardwired persona→outcome_kind mapping (reply→reply_posted,
  guardian→review_escalated, insights→digest_sent).

### 1.4 Adjacent substrate already in place

- **Policy scoping is Solicitation-ready:** `auto_approval_policies` gained
  `persona` + `action_class` columns in 074 (:32-42) with single-valued CHECKs
  (`persona IN ('reply')`, 074:49-50) whose comments explicitly say
  "Solicitation widens the CHECK in its own migration — design §3.3".
- **Run-linked side tables exist as a pattern:** `review_escalations.agent_run_id`
  (073:26) and `judge_verdicts.agent_run_id` (076:21), both
  `ON DELETE SET NULL`.
- **Outbox/queue registry:** `src/lib/shared/queue-names.ts` `QUEUE_NAMES`
  (single source of truth for job_outbox topics AND BullMQ queue names,
  enforced strict by `scripts/ci/outbox-topics-audit.ts`). ~30 topics today;
  **none** are run-engine or solicitation topics.
- **Feature flag:** `SOLICITATION_WATCH_ENABLED` is named in design doc §9.1
  decision 4 but does not exist in code yet (no hits in src/worker).

### 1.5 What the specs ask for (run-engine side)

- Design doc §3.2 (:182-197): v1.1 builds the executor — "run lifecycle:
  start/advance/halt/resume; parent/child fan-out" — Solicitation first
  tenant, Reply migrates one cycle later. §9.2: "Run engine executor
  (parent/child lifecycle on the run spine) with `solicitation_batch`
  watch-mode as first tenant."
- May doc §3.1 `agent_runs` reference design: `parent_run_id` (nullable),
  `coordination_key` (nullable + partial unique active-claim index — V2
  consumer), status enum `pending/running/held_for_approval/completed/failed/
  cancelled`, `trigger_event_id`, `outcome_summary jsonb`.
- May doc §6.2 Batch Agent step graph needs: policy_gate on the batch,
  `throttled_fan_out` (spawn N children, ≤N/min), `wait_for_children`,
  `aggregate_outcomes`, batch-level `record_outcome`, halt/resume around
  human approval.
- May doc §6.3 Outreach Agent (child): spawned-by-parent trigger with payload,
  `wait_for_event` (async signals / approval), halt. In watch-mode (§9.2 of
  design doc) the send steps don't execute — decisions are shown, nothing sent.
- May doc §3.2 Solicitation tables (`customer_contacts`, `solicitation_lists`,
  `solicitation_list_members`, `solicitation_outreach`, `consent_records`):
  **none exist** in supabase/migrations (verified by grep).

Everything in §1 above is confirmed still-absent by design doc §8.5
("Deliberately still NOT built: run engine/executor … Solicitation agent …
cross-agent coordination keys, outcome billing").

---

## 2. Gap list — spine as-built vs run-engine needs

### Reusable unchanged

| Existing asset | Why it carries over |
|---|---|
| `agent_runs` identity + tenant columns (`id`/`account_id`/`business_id`/`correlation_id`/`started_at`/`ended_at`/`error`) | shape-agnostic; nothing engine-specific to change |
| `agent_runs_one_active_per_subject` partial unique + `startOrGetActiveRun` ON CONFLICT idiom | exactly the "one active run per subject" primitive a batch run needs (subject = batch id) |
| `agent_run_steps` append + `recordStep` lock-then-index serialization | engine step recording can keep the same append discipline |
| `agent_outcomes` + `recordOutcome` per-(run,kind) dedup | batch-level and per-child outcome emission reuse it; unit_count already exists for aggregates |
| `completeRun` idempotent terminal transition | terminal semantics unchanged |
| Same-transaction write contract + review-lock ordering doc (run-spine.ts:5-17) | outbox discipline is the engine's persistence substrate too |
| `auto_approval_policies.persona`/`action_class` (074) | policy scoping for solicitation slots in by widening two CHECKs, per the migration's own comments |
| `agent_run_id` side-table pattern (073/076) | solicitation tables can FK the same way |
| Deny-all RLS + archival indexes (071/079) posture | new spine rows inherit it |
| `QUEUE_NAMES` registry + outbox-topics CI audit | new engine topics have a single place to land |

### Missing — schema

1. **No parent/child linkage.** No `parent_run_id` column anywhere
   (grep-verified across src/, worker/, supabase/migrations/). Fan-out
   (May §6.2 step 5) has no representation.
2. **No batch-capable run kind/subject.** `kind` CHECK admits only
   `review_handler`/`weekly_insights`; `subject_type` only
   `review`/`account_week`; the `agent_runs_kind_subject_type_pairing` CHECK
   must be extended in lockstep for `solicitation_batch` (+ per-candidate
   child kind, if children are runs).
3. **No non-terminal lifecycle states.** Status enum is
   `running/completed/failed`; the reference design needs some subset of
   `pending`, `held_for_approval`/waiting, `cancelled`/halted. Two CHECKs
   couple to the current enum: `agent_runs_terminal_consistency`
   (`running ⇔ ended_at IS NULL`) and the `WHERE status='running'` predicate
   of the one-active-per-subject index (byte-for-byte coupled to the writer's
   ON CONFLICT — any new "active" state silently escapes the uniqueness
   guarantee unless the predicate and writer change together).
4. **Steps are attribution-only.** No scheduled/pending step state, no
   `step_kind` taxonomy, no input/output payloads, no `cost_cents`; step_key
   values are TS-side (`STEP_PERSONA`) and every key must map to a persona —
   `solicitation` is not in the `attributed_agent` CHECK (071:54-55) or
   `AGENT_PERSONAS` (run-spine.ts:24).
5. **No solicitation outcome kinds.** `agent_outcomes_outcome_kind_check`
   (074) has no `solicitation_*` kinds; watch-mode presumably needs at least a
   batch-evaluated/decision-recorded kind (May §6.4 kinds are send-mode).
6. **No solicitation domain tables.** `customer_contacts`,
   `solicitation_lists`, `solicitation_list_members`, `consent_records`
   (attestation) all absent; watch-mode needs at least the CSV-ingest +
   batch/member tables to have subjects to run over.
7. **No coordination_key** (May §3.1) — explicitly deferred by design doc
   §8.5; probably still out of scope for watch-mode, listed for completeness.

### Missing — writer/executor code

8. **No lifecycle verbs.** Writer exposes start/step/outcome/complete only —
   no halt, resume, cancel, wait; `completeRun` only transitions from
   `running`.
9. **No fan-out/join primitives.** Nothing spawns children, throttles
   spawning, or aggregates child terminal states (`wait_for_children`,
   May §6.2 steps 5–7).
10. **No trigger/driver.** Runs today are started inline by existing workers
    at their natural checkpoints; there is no component that owns advancing a
    run (worker? poller? — layout decision per CLAUDE.md: pollers are
    Postgres-state-driven, schedulers cadence-driven).
11. **No outbox topics/queues for the engine.** `QUEUE_NAMES` has no
    solicitation/engine entries; any new async hop needs a topic + queue +
    handler under the outbox pattern.
12. **No flag.** `SOLICITATION_WATCH_ENABLED` (design §9.1) not yet defined
    (env-vars.md / config coverage / static-policy allowlists untouched).

### Missing — read side

13. `getReviewTimeline` hardcodes `kind='review_handler'`; batch runs need
    their own read model (batch UI, §9.2). `RunDisplayState` derives
    "waiting_on_owner" from `responses` status — a batch's "held for
    approval" has no equivalent signal source.
14. `mapTeamSummary` counts only the three launch personas; a solicitation
    persona/outcome would be invisible until extended.

---

## 3. Open questions for grilling ticket #534

1. **Are children runs at all?** Watch-mode evaluates candidates but sends
   nothing — do per-candidate decisions justify one `agent_runs` row each
   (May §6.3 shape), or are they rows in a solicitation-members table with
   the batch as the only run? This decides whether `parent_run_id` ships now.
2. **New lifecycle states vs derived display.** WS5 deliberately derived
   `waiting_on_owner`/`stalled` at read time instead of storing them. Does
   the engine store `held_for_approval`/`waiting` as DB states (May doc) or
   keep the spine's 3-state enum and derive? Storing states forces the
   coupled changes in gap #3.
3. **Extend `agent_runs` vs new batch table.** `solicitation_lists` (May
   §3.2) already looks like a batch entity with status + totals; is the
   "batch lifecycle" the run's, the list's, or both (and which is
   authoritative)?
4. **Executor placement and trigger.** In-tx inline advancement (spine
   style) vs outbox-driven step hops vs a dedicated poller; and where the
   "one module owns writes" rule lands when the engine needs to write runs
   from a new worker.
5. **Persona value for solicitation** (`attributed_agent` CHECK + TS
   `AGENT_PERSONAS` + STEP_PERSONA extension), and which watch-mode outcome
   kinds are worth recording given outcome billing is explicitly deferred.
6. **Tripwire budget:** design doc risk table caps the in-house run layer at
   ~2–3k LOC before "buy Inngest/Temporal" triggers — the watch-mode executor
   design should state its expected size against that tripwire.
7. **Reply migration compatibility** (Phase 3): whatever lifecycle/fan-out
   columns land must be nullable/no-op for existing `review_handler` rows so
   months of recorded runs stay replayable (design §3.2's binding mitigation).
