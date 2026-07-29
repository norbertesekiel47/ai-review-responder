# Send-mode executor gap analysis — May §6 step graphs + ADR 0011's deferred set vs the as-built spine (ticket #618)

> **AMENDED 2026-07-28 — read `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` first.** Facts here
> stand; S9's proposed parent-join index was declined (#619 D11), and S10's
> send-topic guard shipped per #619 §9.

Research capture for wayfinder map #617 (Solicitation SEND-MODE, Phase 2b §9.3).
Verifies the May reference design
(`docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md`
§3.1/§3.2/§6.2–6.3) and ADR 0011's deferred list against the spine and executor
as they actually shipped in WS1–WS8 + #543 (watch-mode).

Facts only. The design decisions belong to grilling ticket #619; §8 is the list
handed to it. Map #617's "Decisions so far" are LOCKED and are treated here as
requirements, not options.

Precedent for format: #529 (`docs/research/2026-07-23-run-engine-gap.md`, branch
`research/run-engine-gap` — not on `main`; read via `git show 8fdffab9:<path>`).

All refs are against `main` @ `a2bc6f60` (2026-07-28). Migrations head is **090**;
next number **091**. Reminder from #617 Notes: ONE migration ticket in flight at
a time.

---

## 1. Verified facts — what exists today

### 1.1 `agent_runs` after 071 + 088

| Column | State on `main` |
|---|---|
| `id UUID PK` | app-supplied UUIDv7 |
| `account_id`, `business_id` | `business_id` still **nullable** (071:17) |
| `kind` | `('review_handler','weekly_insights','solicitation_batch','solicitation_ask')` — 088 §1 |
| `subject_type` | `('review','account_week','solicitation_batch','solicitation_ask')` — 088 §1 |
| `subject_id TEXT` | polymorphic, no FK by design |
| `status` | **still 3-state** `('running','completed','failed')` — 071:22-23. 088 explicitly does **not** replace `agent_runs_status_check` |
| `parent_run_id UUID` | shipped by 088, nullable |
| `correlation_id`, `started_at`, `ended_at`, `error JSONB` | unchanged |

New in 088 and load-bearing for send-mode:

- `agent_runs_account_business_id_uniq UNIQUE (account_id, business_id, id)` — the
  composite FK target.
- `agent_runs_parent_run_tenant_fkey FOREIGN KEY (account_id, business_id, parent_run_id)
  REFERENCES agent_runs (account_id, business_id, id) ON DELETE SET NULL (parent_run_id)` —
  tenant-validated parent link.
- `agent_runs_parent_business_required CHECK (parent_run_id IS NULL OR business_id IS NOT NULL)` —
  because MATCH SIMPLE composite FKs skip validation on any NULL column. **A parented
  run must be Business-scoped.**
- `idx_agent_runs_parent_run ON (parent_run_id) WHERE parent_run_id IS NOT NULL` —
  parent→children lookup exists, but carries **no `status` column**.

### 1.2 The two coupled constraints — exact text

These are the byte-for-byte contracts #618 was asked to trace.

**(a) Terminal consistency** (071:28-29, untouched by 088):

```sql
CONSTRAINT agent_runs_terminal_consistency
  CHECK ((status = 'running') = (ended_at IS NULL))
```

Written as an **equivalence on `'running'`**, not as a list of terminal states.
Consequence, verified by reading the predicate: a NEW **terminal** state
(`cancelled`, `halted`) satisfies it unchanged (`FALSE = FALSE`). A NEW **active**
state (`pending`, `held_for_approval`) **violates** it (`FALSE = TRUE`) and forces
a CHECK rewrite. The cost of a status-enum change is therefore asymmetric — see §4.

**(b) One active per subject** (071:40-42, explicitly *not* replaced by 088):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_subject
  ON agent_runs (kind, subject_type, subject_id)
  WHERE status = 'running';
```

Its writer counterpart (`run-spine.ts:120`):

```sql
ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'running'
DO NOTHING
```

Postgres infers the partial index by comparing predicate text, so index and writer
move together or not at all (CLAUDE.md: "`ON CONFLICT` must match partial-index
predicate BYTE-FOR-BYTE"). A new **active** state silently escapes the uniqueness
guarantee — the index stops covering it and a second concurrent run for the same
subject becomes insertable, with no error.

Third and fourth constraints 088 touched, both now in the coupled set:

**(c)** `agent_outcomes_unit_count_check CHECK (unit_count > 0 OR (outcome_kind = 'solicitation_batch_built' AND unit_count = 0))`
— a zero-legal outcome kind is now enumerated *inside the CHECK*. Any second
zero-legal kind rewrites it.

**(d)** `agent_outcomes_once_per_run_kind ON (agent_run_id, outcome_kind) WHERE agent_run_id IS NOT NULL`
— one outcome per (run, kind). Per-child value events (`solicitation_sent`,
`review_attributed`) must therefore land on **child** runs; emitting them on the
parent collapses N sends into one row.

### 1.3 `solicitation_asks` after 088 + 090 — the tightest weld in the lane

```sql
CONSTRAINT solicitation_asks_status_reason_consistency CHECK (
  (status = 'send' AND withheld_reason IS NULL) OR
  (status = 'withhold' AND withheld_reason IN (
    'no_consent','suppressed','already_reviewed',
    'stale_visit','over_contacted','velocity_banked'))
)
```

and (090, `NOT VALID` + `VALIDATE`):

```sql
CONSTRAINT solicitation_asks_evidence_matches_columns CHECK (
  jsonb_typeof(evidence) = 'object'
  AND evidence->>'decision' IS NOT DISTINCT FROM status
  AND evidence->>'reason'   IS NOT DISTINCT FROM withheld_reason
)
```

**`solicitation_asks.status` is now welded to `evidence->>'decision'`, and
`evidence` is the frozen restraint-policy decision object** (`batch-builder.ts:497`
stores `evidence: decision` wholesale; `decision.decision ∈ {send, withhold}`,
plus `policy_version: RESTRAINT_POLICY_VERSION` at `restraint-policy.ts:146`).

Also note the status column has **no standalone CHECK** — `send`/`withhold` are
enforced only as a side effect of the two constraints above. There is no third
value that passes.

This is the single most consequential finding in this document and it is developed
in §2.2 (#S3) and §4.

Other facts on the table:

- `solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id)`.
- `agent_run_id` linked via composite tenant FK, `ON DELETE SET NULL (agent_run_id)` —
  decisions outlive 180-day run archival.
- RLS: `solicitation_asks_owner_select USING (account_id = owner_account_id())` —
  **no `built_at`/lifecycle gate**, unlike `solicitation_batches` whose policy adds
  `AND built_at IS NOT NULL`. An ask row is owner-readable the instant it commits.
- `evidence` is deliberately PII-free (`batch-builder.ts:9`, `:474`); `contact_id` is
  the only candidate reference it carries.

### 1.4 `solicitation_batches` (088)

`id`, `account_id`, `business_id`, `source_upload_id` (UNIQUE), `built_at`,
`reviewed_at`, `created_at`. Ordering CHECKs: `built_at >= created_at`,
`reviewed_at >= built_at AND built_at IS NOT NULL`. Owner SELECT RLS requires
`built_at IS NOT NULL`. **No approval, halt, veto-deadline, or send-lifecycle
column of any kind.** ADR 0011 D3/D4: lifecycle lives here, `expired` is derived
from `built_at` age at read time, no status column, no expiry poller.

### 1.5 Run-spine writer surface (`src/lib/agents/run-spine.ts`, 493 lines)

Public verbs, complete list:

| Verb | Transition |
|---|---|
| `startOrGetActiveRun` / `startOrGetSolicitationBatchRun` | ∅ → `running` (ON CONFLICT race-safe) |
| `recordCompletedChildRuns` | ∅ → `completed` **directly** (set-based) |
| `recordStep` | append-only; locks the run row FOR UPDATE, then computes `MAX(step_index)+1` in a **separate statement** (snapshot-after-lock; the two-statement split is load-bearing) |
| `recordOutcome` | insert with ON CONFLICT dedup |
| `completeRun` / `completeSolicitationBatchRun` / `failSolicitationBatchRun` | `running` → `completed`\|`failed`, idempotent |
| `findActiveReviewRun` | read-only, `kind='review_handler'` hardcoded |

`STEP_PERSONA` has 13 keys; the two Solicitation ones are `ask_evaluated` and
`batch_built`, both → persona `solicitation`. `AGENT_OUTCOME_KINDS` has 10; the
only Solicitation one is `solicitation_batch_built`.

**`recordCompletedChildRuns` cannot create a *running* child.** It hardcodes
`'completed', ..., NOW(), NOW()` in the INSERT … SELECT (`:222-223`) and asserts
`insertedRuns.count === children.length`. It also bypasses the ON CONFLICT path
entirely — legal today only because a completed row never enters the
`WHERE status='running'` partial index.

### 1.6 Watch-mode executor shape (`batch-builder.ts` 705 LOC + `worker/jobs/solicitation-batch/`)

Two transactions, one job, no async hop:

1. `prepareBatch` — lock the exact `dispatched` outbox attempt
   (`lockDispatchedOutboxAttemptIfOwned`) → lock the batch row → `evaluateBatchGate`
   (takes the `accounts` lock **first**; documented lock order accounts → agent_runs)
   → lock/or start the parent run. Returns `stale|missing|already_built|gate_closed|ready`.
2. `constructBatch` — completion-CAS the same attempt **as the first statement** →
   re-lock batch → `pg_advisory_xact_lock(hashtext('solicitation_batch_<business>'))`
   (namespace deliberately distinct from `csv_ingest_<business>`) → **re-evaluate the
   gate (the load-bearing check)** → `loadCandidateWindow` (≤ `MAX_DATA_ROWS`, ordered
   least-recently-evaluated first) → `evaluateBatch` (pure) → `commitAskDecisions`
   (asks first, then bulk child runs+steps, then link) → `completeSolicitationBatchRun`
   → set `built_at`. One rollback unit.

Send-mode-relevant holes visible in this code:

- `toCandidate` passes `suppression: null` and `matchedReview: null`
  (`batch-builder.ts:300-301`) — the `suppressed` and `already_reviewed` withhold
  reasons are in the CHECK enum and the policy contract but **cannot fire today**.
- `consent_attested` is derived from the *upload* (`u.status='completed' AND
  u.attested_at IS NOT NULL AND u.attestation_version IS NOT NULL`), not from any
  per-contact ledger.
- The whole executor is synchronous and PII-free by construction; nothing renders,
  stores, or transmits message content.

### 1.7 Pacing / dispatch substrate — what actually exists

- `job_outbox.available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (001:309), index
  `idx_jo_pending ON (available_at) WHERE status='pending'` (001:320).
- `OutboxPoller` claim (`OutboxPoller.ts:194-199`):
  `WHERE status='pending' AND available_at <= NOW() ORDER BY available_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`.
  **Topic-agnostic, global FIFO.** `OUTBOX_BATCH_SIZE` default 50, clamped [1,500];
  `OUTBOX_POLL_INTERVAL_MS` default 5000. Global ceiling ≈ 600 rows/min shared by
  every topic. Watchdog re-pends `dispatched` rows older than 15 min if
  `attempts < max_attempts` (default `max_attempts` 5).
- **Delayed dispatch precedent exists and is the outbox, not BullMQ:**
  `enqueuePublishResponse({ availableAt })` (`job-outbox-helpers.ts:270`,
  `COALESCE(${availableAt}, NOW())`), driven by
  `worker/jobs/publisher/veto-window-gate.ts` — it completes the current outbox row
  and enqueues a **fresh delayed row** at the absolute instant `first_sent + window`.
  That file also documents the one-push/idempotent-recompute discipline.
- In-flight enqueue guards are **per-topic partial unique indexes** with byte-for-byte
  `ON CONFLICT`, e.g. `publish_response` and `auto_post_notice` (migration 067).
  **`enqueueBuildSolicitationBatch` has no such guard and no `availableAt` parameter**
  (`job-outbox-helpers.ts:591-620`) — the caller relies on the `source_upload_id`
  UNIQUE insert for idempotency instead.
- **Outbox status vocabulary is closed and CI-guarded.** In-flight set
  `('pending','dispatching','dispatched')` is a byte-for-byte contract owned by
  `src/lib/shared/job-outbox-status.ts`, checked by `ci:outbox-status` for **members
  and order**. Terminal statuses in use are `completed` and `failed`. **There is no
  `cancelled` outbox status.**
- Health alerting: `checkOldestPendingOutbox` filters `available_at <= NOW()`, so
  future-dated rows do **not** trip the backlog warning (verified,
  `health-alert/checks.ts:95`). `checkFailedOutboxByTopic` alerts on `status='failed'`
  for an allowlist that already includes `BUILD_SOLICITATION_BATCH`.

### 1.8 Approval / veto / judge precedents send-mode must mirror

- **Judge availability as a posting precondition:** `worker/jobs/publisher/judge-gate.ts`
  — `judgeEnabled()` false **or** `isJudgeHealthy()` false ⇒
  `downgradeAutoApprovedResponseForManualReview` with reason `judge_disabled` /
  `judge_unhealthy`. Never a silent send. Map #617 decision 7 imports this shape verbatim.
- **Veto window as an elapsed-since-first-*delivered*-notice guarantee**, not a bare
  existence check (`veto-window-gate.ts:33-56`); the granted window is read from the
  immutable `approval_audit_log` metadata, never derived from a mutable deadline delta.
- **Policy scoping is pre-widened:** `auto_approval_policies.persona` /
  `.action_class` exist (074:32-33) with single-valued CHECKs
  (`persona IN ('reply')`, `action_class IN ('posting')`) whose own comments say
  Solicitation widens them. Uniqueness indexes already include the scope
  (074:76, :80).
- `tierGrantsAutopilot` (`src/lib/accounts/tier-config.ts`) is the tier gate, already
  consumed by `auto-policy-publish.ts` and `response-generation/auto-approval.ts`.
- `worker/jobs/{publisher,zernio}/…-failed-hook.ts` is the sanctioned `'failed'`
  exhaustion-hook pattern; `worker/jobs/solicitation-batch/failed-hook.ts` already
  exists for the batch parent.

### 1.9 What May §6.2–6.3 actually asks for

**§6.2 Batch Agent:** `load_batch_context` → `subscription_guard` →
`compliance_pre_check` → `batch_policy_gate` (auto_pass / hold_for_approval → resume /
deny → halt) → **`throttled_fan_out`** (one child per eligible member, ≤N/min "to
protect deliverability") → **`wait_for_children`** → `aggregate_outcomes` →
batch-level `record_outcome` → `complete_run`.

**§6.3 Outreach Agent (per recipient, reusable):** `load_recipient_context` →
`subscription_guard` → **`consent_recheck`** ("could have unsubscribed since batch
start") → `personalize_message` (llm_call) → `outreach_policy_gate` →
{auto_pass: `send_via_channel` (gated tool, `MessagingAdapter`) → `record_outcome`
(`solicitation_sent`) → `wait_for_async_signals` (14d attribution window) →
`record_attribution` (`review_attributed`) → complete | hold_for_approval:
enqueue for edit+approval → `wait_for_event` → send | deny: `record_outcome`
(`solicitation_skipped_policy`) → **`halt_run`**}.

**§3.1 reference `agent_runs`:** `parent_run_id` ✅ shipped, `coordination_key`
❌ absent (design §8.5 defers it), status enum
`pending/running/held_for_approval/completed/failed/cancelled` ❌ 3-state today,
`trigger_event_id` ❌, `outcome_summary jsonb` ❌.

**§3.1 reference `agent_run_steps`:** `step_kind` taxonomy
(`tool_call`/`llm_call`/`policy_gate`/`outcome_emit`/`wait_for_event`/
`human_approval`/`spawn_child_run`), `input`/`output jsonb`, `cost_cents`,
`tool_authorization_id` — **none exist.** Steps are append-after-the-fact
attribution with `status ∈ ('completed','failed','skipped')`, free-form `step_key`,
`detail JSONB`, `latency_ms`. There is no `pending`/`running` step state, so a step
cannot represent work *in progress* — only work that already happened.

**§3.2 reference Solicitation tables:** superseded by the #534 vocabulary
(batch/ask). `solicitation_outreach` (per-send row: channel, template version,
`agent_run_id`, send result, opened/clicked) and `consent_records` (append-only
per-contact ledger) have **no as-built equivalent**.

---

## 2. Gap list

### 2.1 Reusable unchanged — the ADR-0011 dividend

| Asset | Why it carries into send-mode with zero change |
|---|---|
| `parent_run_id` + tenant-composite FK + `agent_runs_parent_business_required` | the parent/child graph is real and tenant-safe from day one |
| `solicitation_batch` / `solicitation_ask` kinds + pairing CHECK | no CHECK widening needed for the two run kinds themselves |
| persona `solicitation` in both `attributed_agent` CHECKs + `AGENT_PERSONAS` | new step keys attach without a migration |
| `suppressed` / `already_reviewed` withhold reasons already in the 088 CHECK and in `WITHHOLD_REASONS` | wiring #626's suppression ledger and an attribution source needs **no schema change on `solicitation_asks.withheld_reason`** |
| `auto_approval_policies.persona`/`action_class` + scoped uniqueness (074) | Autopilot batch policy slots in by widening two single-valued CHECKs |
| `agent_run_id` side-table pattern, `ON DELETE SET NULL` | send/attribution rows survive 180-day run archival the same way |
| `job_outbox.available_at` + `enqueuePublishResponse({availableAt})` + `veto-window-gate.ts` | **a durable delayed-dispatch primitive already exists and is proven in production** |
| `judge-gate.ts` downgrade shape | Judge-as-dispatch-precondition (#617 decision 7) is a direct port |
| Two-phase attempt ownership (`lockDispatchedOutboxAttemptIfOwned` → `markOutboxCompletedIfOwned`) + per-Business advisory lock | the retry-safety idiom transfers to a per-child dispatcher unchanged |
| `recordStep`'s lock-then-index two-statement split | the serialization primitive a join needs already exists (§2.4) |

### 2.2 Missing — schema

**S1. No non-terminal run states.** `pending`, `held_for_approval` absent. Needed by
May §6.2 step [4a] and §6.3 step [7b]. Cost is asymmetric — see §1.2(a) and §4.

**S2. No cancelled/halted terminal state.** Map #617 decision 2 makes halt *mandatory
machinery*. With the 3-state enum, an un-sent child killed by a halt must be recorded
as `completed` (dishonest: it did not do its work) or `failed` (pollutes failure
alerting for a deliberate owner action). No third option exists today.

**S3. `solicitation_asks.status` cannot carry a send lifecycle.** Migration 090 welds
`status` to `evidence->>'decision'`, and `evidence` is the frozen restraint-policy
decision. A status of `queued`/`sent`/`bounced`/`halted` would require rewriting
`evidence` on every transition — destroying the decision provenance 090 was written
to protect, and breaking `policy_version` attributability. **Send lifecycle needs a
separate column or, per May §3.2, a separate per-send table.** Any change here touches
*three* constraints in lockstep: `solicitation_asks_status_reason_consistency`,
`solicitation_asks_evidence_matches_columns`, and `parseEvidence`'s read-time throw in
`src/lib/solicitation/batch-view.ts`.

**S4. No storage for rendered message content.** #617 decision 4 (generate-then-approve,
"byte-for-byte what sends") requires rendered asks stored at rest pre-send. Nothing
holds a body today, and `evidence` is deliberately PII-free. New storage is PII-bearing
⇒ RLS posture, logging-rule exclusion, retention policy, and the offboarding purge
path all in scope. Note `solicitation_asks`' RLS has **no lifecycle gate** (§1.3), so
attaching bodies there makes them owner-readable pre-approval unless a gate is added.

**S5. No per-send record.** May §3.2 `solicitation_outreach` (channel, template/prompt
version, provider message id, send result, bounce/complaint, opened/clicked) has no
equivalent. Needed for suppression feedback (#626), deliverability (#622), and
`review_attributed` (#632).

**S6. No consent ledger.** Consent is a *derived boolean off the upload row*
(§1.6). May §3.2 `consent_records` (append-only, per-contact, channel-scoped,
basis + provenance) is #620/#625's subject. Corollary worth flagging to #619:
because the upload attestation is immutable, **re-reading it at dispatch time is an
inert recheck** — the only thing that can actually change between approval and send
is suppression and address-on-file. May §6.3's `consent_recheck` therefore has real
content in v1 only if it reads the suppression ledger.

**S7. No batch approval/veto/halt columns.** No `approved_at`, `approval_method`,
`veto_deadline_at`, `halted_at`, `halt_reason` on `solicitation_batches`. #617
decision 2 needs all of them somewhere. `approval_method` in particular is invariant
#3 vocabulary (`owner` | `auto_policy`) and today lives only on `responses`.

**S8. No solicitation outcome kinds beyond `solicitation_batch_built`.**
`solicitation_sent`, `review_attributed`, `solicitation_skipped_policy` (May §6.4)
all absent from `AGENT_OUTCOME_KINDS` and the CHECK. Adding a second zero-legal kind
also rewrites `agent_outcomes_unit_count_check` (§1.2(c)).

**S9. No parent-join index.** `idx_agent_runs_parent_run` has no `status`, so "are all
children terminal?" is an index scan plus heap fetch per child. A partial composite
`(parent_run_id, status)` is the obvious shape.

**S10. No in-flight guard on the send topic.** The per-child send enqueue is the one
place where a duplicate row means a **duplicate email**. `publish_response` /
`auto_post_notice` show the required shape (partial unique index + byte-for-byte
`ON CONFLICT`); `enqueueBuildSolicitationBatch` shows the shape that was *not* used.

**S11. Steps cannot represent in-flight work.** No `pending`/`running` step status, no
`step_kind`, no `input`/`output`, no `cost_cents`. May §6.2/§6.3 step graphs assume a
step is a scheduled unit. As-built, a step is a receipt. This is a real divergence, but
see §4 — it may not need closing.

### 2.3 Missing — spine verbs

**V1. No halt/cancel/resume/wait verbs.** `completeRun` transitions only from
`running` and only to `completed|failed`; its TS signature closes the union.

**V2. No writer that creates a *running* child.** `recordCompletedChildRuns` hardcodes
`completed` + `NOW()/NOW()` and skips ON CONFLICT (§1.5). Send-mode children are
`running` for hours-to-days, therefore **enter the `WHERE status='running'` partial
index** — so the running-child writer must go through the ON CONFLICT path, unlike
today's bulk writer. A bulk *running*-child writer is a genuinely different query,
not a parameter on the existing one.

**V3. No join verb.** Nothing counts child terminal states or closes a parent on
exhaustion.

**V4. No per-child terminal attribution seam.** `failSolicitationBatchRun` takes a
closed union (`gate_closed` with 3 gates | `build_failed`) scoped to the batch parent.
Children need their own bounded vocabulary (`send_failed`, `moderation_withheld`,
`lint_failed`, `consent_revoked`, `suppressed_at_dispatch`, `budget_exceeded`,
`halted`).

**V5. Read-side kind hardcoding.** `findActiveReviewRun` pins `review_handler`;
`getReviewTimeline` likewise; `mapTeamSummary`'s persona→outcome map has no
solicitation entry. `deriveRunDisplayState` marks any run `running` > 48 h as
**`stalled`** — a multi-day drip parent is *legitimately* running > 48 h, so any read
model or alert reusing that helper will mis-report a healthy drip.

### 2.4 Missing — primitives (fan-out / join / halt)

**P1. Physical fan-out.** Watch-mode's fan-out is one INSERT … SELECT inside one
transaction. Physical fan-out means N durable outbox rows + N BullMQ jobs + N child
runs, created transactionally with the approval. The 5,000-candidate bound is not the
constraint here — `BATCH_CAP = 25` (`restraint-policy.ts:78`) bounds a send batch, and
#617 decision 7 keeps it. **Fan-out width is ~25, not thousands.** That materially
lowers the cost of the naive shapes (per-child rows, parent-row serialization).

**P2. Throttled spawn.** May §6.2 [5] wants ≤N/min. Two mechanisms are available and
both already exist in the codebase; see §5.

**P3. Join.** `wait_for_children` needs (a) a serialization point and (b) a trigger.
The serialization point already exists: `recordStep` locks the parent run row
`FOR UPDATE` in its own statement, then reads in a later statement whose READ COMMITTED
snapshot is taken after the lock wait (`run-spine.ts:294-315`). A child that records a
step on the *parent* inside its terminal transaction inherits exactly that
serialization — which is what makes a last-child-closes-parent join safe without a
poller. Without such a lock, two children committing concurrently each see the other
as non-terminal and the parent never closes.

**P4. Exhaustion propagation.** An outbox row that exhausts `max_attempts` goes to
`status='failed'` with **no run-spine consequence today**. The per-worker `failed-hook`
pattern is the sanctioned bridge, but a child failed-hook must *also* re-evaluate the
join or the parent hangs forever. There is currently no path from "outbox row died" to
"parent run terminalizes".

**P5. Halt.** Nothing exists. Not a flag, not a column, not a verb. See §6.

**P6. Per-child cost guard.** #617 decision 3 makes every ask an LLM call, so each child
needs its own `withCostGuard` reserve→finalize. Retry classification is already
specified by CLAUDE.md and must be honoured per child: pre-LLM Redis transport failure
⇒ **retryable** (`CostInfraUnavailableError`); budget-exceeded ⇒ **terminal**, and a
terminal budget-exceeded child must still count toward the join (P3).

### 2.5 Missing — read side

**R1.** No send-lane read model. `batch-view.ts` (`readLatestBatch`, `markBatchReviewed`,
`AskRow`, `WithholdGroup`) is a watch-mode spoilage view over `send`/`withhold` groups.

**R2.** `parseEvidence` throws on a non-object / discriminant-less value, and
`readLatestBatch` builds the whole view in one statement — a single malformed row
fails the account's entire view (the #593 lesson that produced migration 090). Any
evidence-shape change inherits this blast radius.

**R3.** No owner-visible drip progress (sent / queued / halted / failed per batch), no
halt affordance, no per-child status. #629/#630's UI surface.

---

## 3. Coupled-constraint impact matrix

What each candidate change actually touches. "Byte-for-byte" marks pairs that must
move in the same migration + same PR or the guarantee silently disappears.

| Change | `agent_runs_terminal_consistency` | `agent_runs_one_active_per_subject` (+ writer ON CONFLICT) | Other |
|---|---|---|---|
| Add terminal state `cancelled` | **untouched** (equivalence on `'running'` passes) | **untouched** (terminal ⇒ outside predicate) | `agent_runs_status_check` widened; `completeRun` union + `transitionRunToTerminal` guard |
| Add active state `held_for_approval` / `pending` | **REWRITE** — `(status='running') = (ended_at IS NULL)` is false for an active non-running row | **REWRITE both, byte-for-byte** — else a second active run per subject becomes insertable with no error | `agent_runs_status_check`; every `WHERE status='running'` reader (`findActiveReviewRun`, `prepareBatch`'s parent lock at `batch-builder.ts:240`, `read.ts`) |
| Add `solicitation_sent` / `review_attributed` outcome kinds | — | — | `agent_outcomes_outcome_kind_check`; `AGENT_OUTCOME_KINDS`; **must land on child runs** (`agent_outcomes_once_per_run_kind`) |
| Add a zero-legal outcome kind | — | — | `agent_outcomes_unit_count_check` rewritten (kind currently enumerated inside it) |
| Add a value to `solicitation_asks.status` | — | — | **THREE in lockstep**: `solicitation_asks_status_reason_consistency`, `solicitation_asks_evidence_matches_columns` (090), `parseEvidence` in `batch-view.ts` — and it rewrites frozen decision provenance. See S3 |
| New send-lifecycle column/table instead | — | — | none of the above; new RLS policy + purge path + retention |
| Per-child send outbox topic | — | — | new partial unique index `(topic, aggregate_id) WHERE topic='…' AND status IN ('pending','dispatching','dispatched')` **byte-for-byte** with the helper's ON CONFLICT; `QUEUE_NAMES` + `ci:outbox-topics`; helper required by `ci:outbox-seam` (#568) |
| Any new outbox status (e.g. `cancelled`) | — | — | `OUTBOX_IN_FLIGHT_STATUSES` is members-**and-order** guarded by `ci:outbox-status`; ~26 SQL sites + ~19 migrations re-spell the literal. Treat as effectively closed |
| Autopilot batch policy | — | — | `auto_approval_policies_persona_check` and `_action_class_check` widened (074's own comments sanction this) |
| Parent-join query | — | — | new partial index `(parent_run_id, status)`; `idx_agent_runs_parent_run` may become redundant |

---

## 4. Does ADR 0011's promise hold?

ADR 0011 Consequences: *"One spine migration covers both modes' schema
(`parent_run_id`, new kinds/pairings, persona, outcome kind); send-mode adds
**states/verbs, not columns-plus-rework**."*

**Verdict: it holds on the spine, and it does not hold on the domain tables. The
rework send-mode faces was not deferred by ADR 0011 — it was created by migration 090.**

Where it holds (the ADR was right):

1. `parent_run_id` + the tenant-composite FK + `agent_runs_parent_business_required`
   are exactly what physical fan-out needs. No column added, no backfill.
2. Both run kinds, both subject types, the pairing CHECK, the `solicitation` persona
   in both `attributed_agent` CHECKs — all pre-widened. Send-mode adds step *keys*
   (TS-side only) and outcome *kinds*, not structure.
3. `suppressed` and `already_reviewed` are already in the `withheld_reason` CHECK —
   the two gates that were inert in watch-mode wire up with **zero migration**.
4. Batch lifecycle sitting on `solicitation_batches` (D3) is vindicated: adding
   approval/veto/halt there is additive nullable columns on a table with no coupled
   predicates, versus the three-constraint cascade a spine-status approach triggers.
5. **The terminal-consistency CHECK's asymmetry is a genuine, unclaimed win.** Because
   it is written as an equivalence on `'running'` rather than a terminal-state list, a
   new *terminal* state (`cancelled`) costs one CHECK widening and a TS union — the
   coupled pair never moves. ADR 0011's "adds states, not rework" is literally true
   for halt-as-terminal-state.

Where it does not hold:

6. **`held_for_approval` / `pending` as *stored spine states* is precisely the
   "columns-plus-rework" the ADR said would be avoided** — it rewrites the
   terminal-consistency CHECK, rebuilds the partial unique index, and edits the
   writer's ON CONFLICT byte-for-byte, plus every `WHERE status='running'` reader. The
   ADR's own escape hatch is D3/D4 (WS5 derived-display precedent): keep the enum and
   put approval state on `solicitation_batches`. That escape hatch is still open, and
   #617 decision 4 (approval attaches to rendered messages, which live on the domain
   side anyway) makes it the natural fit. **The ADR's promise survives only if #619
   takes the domain-table route.**
7. **Migration 090 (#593, 2026-07-27 — four days *after* ADR 0011) welded
   `solicitation_asks.status` to `evidence->>'decision'`.** ADR 0011 could not have
   anticipated it. It was correct for watch-mode (it closed a real read-time-only
   enforcement hole where one malformed row broke an account's whole view), but it
   means the ask table's status column is now a *decision* column with a provenance
   contract, not a lifecycle column. **Send-mode's per-ask lifecycle needs new
   structure regardless of what #619 decides about the spine.** This is the one place
   where "columns-plus-rework" is genuinely unavoidable.
8. **Step-shape divergence is real but arguably shouldn't be closed.** May §3.1's
   `step_kind`/`input`/`output`/`cost_cents`/`tool_authorization_id` presume steps are
   scheduled units of an execution engine. As-built steps are receipts. Closing that
   gap is the "buy Inngest/Temporal" direction, and #529 recorded the design-doc
   tripwire at ~2–3k LOC for the in-house run layer, with watch-mode having spent
   ~600–800. §8 asks #619 to decide explicitly rather than let it drift.

---

## 5. Drip pacing — what BullMQ/outbox actually offer

Constraints from the facts: (a) invariant #2 requires state change + follow-up work in
**one Postgres transaction**, which rules out a bare BullMQ delayed job as the schedule
of record — a delayed job that isn't in `job_outbox` is exactly the "write Postgres then
separately enqueue" failure mode; (b) `available_at` + `enqueuePublishResponse` is a
proven delayed-dispatch primitive; (c) the OutboxPoller is global FIFO with no per-topic
or per-account fairness; (d) fan-out width is **~25** (`BATCH_CAP`), not thousands;
(e) future-dated pending rows do not trip the backlog health check.

**Shape A — pre-computed schedule.** At approval, in the approval transaction, write N
child outbox rows with staggered `available_at = anchor + i × interval`.

- Pros: one transaction; no new background loop; reuses `availableAt` verbatim; N ≈ 25
  so the poller's global FIFO is never stressed; health-alert-safe (§1.7).
- Cons: **the schedule is frozen at approval**, so provider backpressure or a
  deliverability signal cannot re-pace it without rewriting rows. **Halt has nowhere to
  go**: there is no `cancelled` outbox status, and `ci:outbox-status` makes adding one
  expensive; marking pending rows `completed` is a lie, and `failed` would trip
  `checkFailedOutboxByTopic` for a deliberate owner action (the send topic would be
  added to that allowlist). The workaround — let each child wake up and no-op on a halt
  flag — means a halted 3-day batch keeps waking workers for 3 days, and leaves 25
  `completed` outbox rows that never did work.

**Shape B — releaser loop.** One Postgres-state-driven poller (CLAUDE.md: pollers are
state-driven, schedulers cadence-driven) that each tick selects the next K due asks for
active batches and enqueues one send outbox row each.

- Pros: **halt is free** — stop releasing; pacing is adaptive (per-account daily cap,
  #617 decision 6, is a live query not a frozen arithmetic); no bulk cancel; only
  released children hold outbox rows, so in-flight population is small and bounded.
- Cons: a new poller — and CLAUDE.md's single-replica caveat applies, with the P2
  poller list in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`
  growing by one; needs its own cursor/claim discipline (`poller_cursors` from
  migration 081 is the existing substrate); one more moving part in the boot lifecycle.

**Hybrid worth naming:** Shape B for release + `available_at` for the *within-tick*
spread, and Shape A's `availableAt` for the single deferred hop the veto window already
needs (first child not before `approved_at + veto_window`) — which is exactly what
`veto-window-gate.ts` does today for a single response.

Either way, per-child rows are required (S10) and the send topic needs a partial unique
in-flight guard byte-for-byte with a new helper (`ci:outbox-seam` #568 forces the
helper: once `enqueueSolicitationSend` exists, no raw INSERT for that topic may remain).

---

## 6. How halt interacts with in-flight children

Reachability at halt time T, by child state:

| Child state at T | Reachable by halt? | Mechanism |
|---|---|---|
| Not yet released (Shape B) | **Yes, cleanly** | releaser reads the halt latch; never enqueues |
| Outbox row `pending`, `available_at` future (Shape A) | Only by neutralising the row | no `cancelled` outbox status exists — this is Shape A's core problem (§5) |
| Outbox `dispatched`, BullMQ job queued/running, **before** the provider call | **Yes** | child re-reads the halt latch inside its send transaction, under the batch lock, as the statement before the adapter call |
| Provider call in flight | **No** | cannot be recalled |
| Already sent | **No — and must not be** | terminal; halt is a no-op for it |

Therefore the honest contract is: **halt is a monotone latch meaning "no further sends",
not an undo.** The residual exposure is one child's send-transaction duration. That is
the same contract the owner veto already has on the Reply lane — the veto NULLs the
scheduled deadline and the publisher re-reads status under lock — so it is a precedent,
not a novelty.

Consequences #619 must settle:

- Halt must be **idempotent and monotone** (a second halt is a no-op; un-halt is a
  separate decision — #617 decision 2 says "halt-able", not "resumable").
- Halt must terminalize **both** the un-sent children and the parent, or the join (P3)
  never fires and the parent runs forever — which also trips `deriveRunDisplayState`'s
  48 h `stalled` threshold (V5).
- Un-sent children terminalized by halt need an *honest* status. With the 3-state enum,
  `failed` is the only non-lying option and it pollutes failure alerting. This is the
  strongest argument in the document for a `cancelled` terminal state — which, per §4
  point 5, is the **cheap** kind of enum growth.
- Halt interacts with the veto window: a veto **before the first child dispatches** is
  functionally "halt at zero sends", so they should be one mechanism with two entry
  points, not two mechanisms.
- Halt must survive worker restart and be visible to the failed-hook path (P4), so it
  is durable state (a `halted_at` column), never in-memory or Redis-only.

---

## 7. Join and exhaustion attribution

Requirements, given children can individually fail:

1. **Every child must reach a terminal run state on every path** — success, moderation
   withhold, compliance-lint fail, consent/suppression revoked at dispatch,
   budget-exceeded (terminal per the cost-guard matrix), provider hard-bounce, BullMQ
   retry exhaustion, and halt. Any path that can leave a child `running` forever is a
   parent that never closes.
2. **The exhaustion path is the weak one.** Outbox `status='failed'` has no run-spine
   consequence today (P4). The `failed-hook` pattern is the bridge, and the child hook
   must both terminalize the child *and* re-evaluate the join. Belt-and-braces: a
   reaper for children whose outbox row died without their hook running (worker killed
   between the two).
3. **Serialization is already available** (P3): a child that records its parent-facing
   step inside its own terminal transaction inherits `recordStep`'s lock-then-count
   discipline, making last-child-closes-parent safe. At ~25 children the contention is
   negligible.
4. **Attribution shape.** The parent's terminal record should distinguish
   *all-children-succeeded* from *partial* from *halted* from *exhausted*. Today the
   parent has one outcome kind and a 3-state status, so "12 sent, 8 withheld at
   dispatch, 3 failed, 2 cancelled by halt" has nowhere to live except a step `detail`
   JSONB — which is the same shape `completeSolicitationBatchRun` already uses for
   `withheld_by_reason`, so it is a precedent rather than an invention.
5. `agent_outcomes_once_per_run_kind` forces per-child value events onto child runs
   (§1.2(d)); the parent gets aggregates only.
6. `review_attributed` (May §6.3 [8a]/[9a], a **14-day** async window) is a second,
   much longer-lived wait that outlives the drip entirely. #632 must decide whether
   the child run stays `running` for 14 days (guaranteeing `stalled` misreads and
   delaying archival) or completes at send with attribution recorded later against the
   ask/send row. **The as-built `ON DELETE SET NULL` + "decisions outlive archival"
   pattern points at the latter.**

---

## 8. OPEN DECISIONS for the #619 grilling

Each is a real fork where the two branches produce materially different schema, and
none is settled by map #617's locked decisions.

1. **Where does batch approval state live — `solicitation_batches` columns, or new
   spine states?** ADR 0011 D3/D4 and WS5's derived-display precedent point at the
   domain table; May §3.1 points at the enum. Choosing the enum rewrites the
   terminal-consistency CHECK, rebuilds the one-active-per-subject index, and edits the
   writer's ON CONFLICT byte-for-byte (§3). Choosing the table keeps all three frozen.
   *This decision determines whether ADR 0011's promise survives (§4 point 6).*

2. **Does the spine gain a `cancelled` terminal state?** Cheap by construction (§4
   point 5) and it is the only honest terminal for a halted un-sent child (§6).
   Alternative: `failed` with bounded `halted` attribution and an alerting carve-out.
   Note this is separable from decision 1 — terminal growth is cheap, active growth is
   not.

3. **Where does the per-ask send lifecycle live?** Migration 090 forecloses reusing
   `solicitation_asks.status` (S3, §4 point 7). Options: (a) new nullable
   `delivery_status` column on `solicitation_asks` + its own CHECK; (b) a new
   `solicitation_sends` table (May §3.2 `solicitation_outreach`), one row per send
   attempt, `ON DELETE SET NULL` to the child run. (b) also answers S5 and gives
   bounces/complaints a home.

4. **Where do rendered message bodies live, and under what RLS/retention?** (S4)
   Sub-questions: on the ask row or the send row; is the body owner-readable before
   approval (today's ask RLS has no lifecycle gate); does it survive send (needed for
   "what was approved is what sent" disputes) or get redacted after the attribution
   window; and how does the offboarding purge reach it.

5. **Drip pacing: Shape A (pre-computed `available_at` schedule) or Shape B (releaser
   poller)?** (§5) The decision hinges almost entirely on halt: Shape A has no clean
   way to cancel scheduled rows because `ci:outbox-status` makes the outbox status
   vocabulary effectively closed. Naming it as a halt-driven decision rather than a
   pacing-preference one is the point.

6. **Join trigger: last-child-closes-parent (in the child's terminal tx, serialized by
   the existing parent-row lock) or a dedicated join poller?** (P3) The primitive
   already exists for the former; the latter adds a second P2-list poller alongside
   whatever decision 5 produces.

7. **Exhaustion coverage: is a per-child `failed-hook` sufficient, or is a reaper
   required?** (P4) Concretely: what terminalizes a child whose worker was killed
   between outbox failure and hook execution, and what stops its parent hanging?

8. **Does `review_attributed`'s 14-day window keep the child run open, or does the child
   complete at send with attribution recorded against the send/ask row?** (§7 point 6)
   Interacts with 180-day archival, `deriveRunDisplayState`'s 48 h `stalled` threshold,
   and #632's shadow-metric scope.

9. **Do steps grow toward the May §3.1 shape (`step_kind`, `input`/`output`,
   `cost_cents`) or stay receipts?** (S11, §4 point 8) Per-child LLM cost has to be
   recorded *somewhere* — `api_costs` already exists and is the cost system of record,
   so "steps stay receipts" is defensible, but it should be a decision rather than
   drift. Restate the tripwire budget (#529 Q6: ~2–3k LOC before buying
   Inngest/Temporal; watch-mode spent ~600–800) with send-mode's estimate.

10. **What is the bounded child failure vocabulary?** (V4) `failSolicitationBatchRun`'s
    closed union is the precedent to extend, deliberately, rather than opening a generic
    escape hatch. Candidate members: `send_failed`, `moderation_withheld`, `lint_failed`,
    `consent_revoked`, `suppressed_at_dispatch`, `budget_exceeded`, `halted`.

11. **Is halt one mechanism with two entry points (owner veto pre-first-dispatch, owner
    halt mid-drip) or two?** (§6) And is un-halt/resume in scope at all — #617 decision 2
    says "halt-able", not "resumable", and May §6.2 has `resume` only as approval-gate
    resumption.

12. **Does `consent_recheck` (May §6.3 [3]) have real content in v1?** (S6) Upload
    attestation is immutable, so re-reading it at dispatch is inert; the recheck is
    meaningful only against the suppression ledger (#621/#626) and the postal-address
    send precondition (#617 decision 6). If so, #630 hard-depends on #626 for
    correctness, not just for the unsubscribe link — worth confirming against the map's
    blocking edges.

13. **Does the Autopilot lane widen `auto_approval_policies` (persona `solicitation`,
    action_class `sending`) or get its own policy table?** 074's own column comments
    sanction the widening and the uniqueness indexes already carry the scope — but the
    batch trust dial (per-batch cap 25, per-account daily cap, veto window) is a
    different rule shape from the reply trust dial (rating band + daily cap).

14. **Does the parent run stay `running` for the whole multi-day drip?** If yes,
    `deriveRunDisplayState`'s 48 h `stalled` rule mis-reports every healthy batch (V5) —
    so either the threshold becomes kind-aware, the read model stops reusing the helper,
    or the parent completes at approval and the drip is attributed to children only.
