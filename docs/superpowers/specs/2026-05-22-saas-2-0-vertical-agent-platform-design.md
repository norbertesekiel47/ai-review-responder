# SaaS 2.0: Vertical AI Agent Platform — Meta-Mission Design

**Status:** Draft for review (revised 2026-05-23 — single committed program; Reply first, Solicitation built and kept launch-ready)
**Author:** Orchestrator (brainstorming session)
**Date:** 2026-05-22
**Scope:** Meta-design covering V1 (substrate + Reply + Solicitation + outcome pricing), V1.5 (WhatsApp + QR), and V2 (POS connectors + Complaint-Recovery). Each sub-mission listed in Section 9 will have its own spec → plan → mission cycle.

**One committed program** (see §0.1). We are converting RepWorth into a team of per-outcome-billed agents and committing to the forced pricing migration (§8) as the destination — not running it as a reversible experiment. Sequencing within the program:
- **Reply agent is the spine.** It migrates RepWorth's existing strength onto the agent substrate first, with golden-replay tests as the safety net.
- **Solicitation agent is built in V1 alongside Reply and kept launch-ready**, but its customer rollout is sequenced *after* the Reply agent is stable in production — so V1 still forces a multi-agent substrate without splitting launch focus across two new behaviors at once.
- **Pricing is de-risked operationally** via the shadow-metering + founders-ring phases in §8.B (every bill is computed against real traffic before money moves), not via an off-ramp that shelves the platform.

---

## 0. Why this exists

RepWorth today is a classic SaaS: per-location tier subscriptions, owner-in-the-loop hard invariant ("no auto-post"), manual copy-paste posting, single-agent-shaped product. Mechanically the AI already does the work (response generation, voice learning, churn detection, weekly value reports), but the product is *packaged and priced* as a tool the owner operates.

The goal of this meta-mission is to convert RepWorth into a **Vertical AI Agent Platform**: a system where specialized agents (Reply, Solicitation, later Complaint-Recovery / Insights / Ranking) each deliver one outcome, share a common runtime substrate, and are individually billable per delivered outcome. The owner sets a per-agent **trust dial** (default-autonomous in safe quadrants; held for approval otherwise); the agent platform replaces the labor a small chain would otherwise pay a VA or reputation agency to do.

This is a multi-quarter program, not a single mission. Sections 1-8 describe the architectural design and migration plan; Section 9 decomposes the work into ten sub-missions across three phases.

### 0.1 Strategic framing (read before sequencing decisions)

**The moat is the vertical, not the pricing model.** Outcome-priced vertical AI agents are an established category (Sierra, Decagon, Intercom Fin, 11x). We are not first to outcome pricing and don't need to be. What is hard to copy is the *depth*: local-SMB Google reputation, Zernio ingestion, voice learning, an existing paying base, and the hardened approval/compliance machinery. Strategy bets on being deep in a niche the horizontal players won't chase. The novelty we *are* claiming is the **packaging** — a team of specialized reputation agents, billed per delivered outcome, with an owner-set trust dial — applied to this vertical.

**One committed program, de-risked operationally — not an experiment with an off-ramp.** We are committing to the destination: a team of agents and the forced pricing migration in §8. The willingness-to-pay hypothesis is real but is de-risked the way every risky migration in this codebase is — by running the new path in production against real customers *before* money moves:

- The agent runtime runs in the transitional `(agent, tier)` shadow state (§8.A) for weeks, computing every customer's outcome bill without charging it.
- The founders ring (§8.B Phase 2) validates at real load with a benefited offer.
- If shadow data shows the pricing is wrong, we **tune prices / floor / allotments before T-0** — we do not abandon the agent platform. The pricing-tuning success targets (e.g. median projected bill within ±X% of today's tier revenue) are frozen before the founders ring, so "is the price right?" has a numeric answer, not a vibe.

This replaces the earlier two-program / validation-gate framing. There is no separate "Program A add-on experiment" that can shelve the migration; there is one V1, sequenced below.

**Sequencing: Reply first, Solicitation built and kept launch-ready.**
- **Reply agent is the spine.** It migrates RepWorth's existing strength (review responses, voice learning, approval machinery) onto the agent substrate first. Proving the substrate against behavior we already understand — with golden-replay tests vs. today's outputs — is the cheapest possible substrate validation.
- **Solicitation agent is built in V1 and kept launch-ready**, but its *customer* rollout is sequenced after the Reply agent is stable in production. Building it in V1 forces the substrate to be genuinely multi-agent (channel abstraction, parent/child fan-out, consent ledger) from day one; deferring its launch keeps us from putting two new customer-facing behaviors in front of owners simultaneously.

---

## 1. Locked-in decisions (the constraint set that bounds the design)

| Decision | Locked answer | Rationale |
|---|---|---|
| Mode | Vertical AI agent platform | User chose over outcome-priced-only / fully-autonomous-reputation-manager / something-else |
| V1 agent roster | Reply + Solicitation | Reply has near-complete existing infra; Solicitation is greenfield. Two agents on day one forces the substrate to handle multi-agent, but stays scope-bounded. |
| Autonomy model | Per-owner trust dial; policy is single source of truth, architecturally enforced; default-autonomous in safe quadrant | Only model that scales to future agents without re-litigating autonomy per agent. Strictly stronger than today's `no auto-post` invariant. |
| Posting bridge | `PostingAdapter` interface; `ZernioPostingAdapter` V1, `GbpPostingAdapter` later via flag | Hybrid: ships V1 without waiting on GBP; clean adapter swap when GBP arrives. Zernio confirmed to support outbound posting. |
| Solicitation V1 scope | Owner-initiated batches, email only | WhatsApp + QR deferred to V1.5; POS event triggers deferred to V2. Forces V1 channel + parent/child run abstractions without compliance complexity. |
| Phasing | V1 (~3-4mo) → V1.5 (~2-3mo) → V2 (~3-4mo) | Phased rollout with customer-visible value at each gate. |
| Pricing | Subscription floor + outcome overage | Predictable revenue + outcome narrative. Industry-standard for outcome-priced AI agents (Sierra/Decagon). |
| Migration | Forced migrate, ~60-day notice, founders ring first — **committed; de-risked via shadow metering (§8.A), not gated by a willingness-to-pay off-ramp** | Cleanest code; no indefinite dual-pricing tech debt. Founders-first ring de-risks the broader rollout. The forced migration is the destination; shadow data tunes pricing before T-0 rather than deciding whether to ship. |
| Substrate architecture | Approach 1: tool-using agents over an explicit step graph. **Open sub-decision: build the durable run engine in-house vs. host it on Temporal/Inngest — see §10 item 1a and the §11 M1 spike.** | Honors existing outbox/BullMQ/Postgres backbone; architecturally enforces trust dial via graph topology; scales to future agents without rework. **Caveat: run lifecycle (start/advance/halt/resume) + replay + parent/child is a durable-workflow engine — the single largest hidden build in the program.** |

---

## 2. Architecture (Section 1 of original brainstorm)

The agent runtime is **not** a separate service. It is a thin set of new modules that sit alongside the existing Next.js + Railway worker code, reusing the outbox / BullMQ / Postgres substrate already trusted by the team.

### 2.1 Module map

```
src/lib/
├── agents/                     ← NEW: agent runtime (the substrate)
│   ├── runtime/
│   │   ├── step-executor.ts    Executes one step of an agent run (dispatched per outbox row)
│   │   ├── run-engine.ts       Lifecycle: start_run, advance_run, halt_run, resume_run
│   │   ├── graph-loader.ts     Loads + validates a step graph definition for an agent kind
│   │   └── replay.ts           Re-runs a historical run with new policy/model (for eval)
│   │
│   ├── policy/
│   │   ├── trust-dial.ts       Pure function: (action, context, policy) → permit | hold | deny
│   │   ├── policy-repo.ts      Loads/writes policy rows, scoped by account/location/agent
│   │   └── audit.ts            Records every gate decision (immutable)
│   │
│   ├── tools/
│   │   ├── registry.ts         Registers tools with typed input/output, scopes, rate limits
│   │   ├── tool-runner.ts      Single chokepoint that invokes a tool (auth, log, retry, cost)
│   │   └── tools/              One file per tool — each one a tiny module
│   │       ├── post-reply.ts            (calls PostingAdapter)
│   │       ├── send-email.ts            (Resend)
│   │       ├── fetch-voice-profile.ts
│   │       ├── generate-reply-text.ts   (wraps existing ResponseGenerator)
│   │       ├── load-customer-list.ts
│   │       ├── personalize-message.ts   (LLM)
│   │       ├── record-outcome.ts        (writes billable_outcomes)
│   │       ├── request-human-approval.ts
│   │       └── …
│   │
│   ├── outcomes/
│   │   ├── emitter.ts          Single API for emitting a billable outcome from a step
│   │   ├── meter.ts            Aggregates outcomes per account/period for Stripe sync
│   │   └── reconcile.ts        Drift detection between outcomes and Stripe usage records
│   │
│   ├── kinds/                  ← Agent definitions (one folder per agent kind)
│   │   ├── reply/
│   │   │   ├── graph.ts        The Reply Agent step graph
│   │   │   └── triggers.ts     review_inserted / review_updated
│   │   └── solicitation/
│   │       ├── batch-graph.ts        Solicitation Batch Agent (V1-specific)
│   │       ├── outreach-graph.ts     Solicitation Outreach Agent (reusable)
│   │       └── triggers.ts
│   │
│   └── observability/
│       ├── run-inspector.ts    Owner-facing API: list runs, view run timeline, view step IO
│       └── metrics.ts          Per-agent KPIs (success rate, p50 latency, cost/run)
│
worker/jobs/agents/             ← NEW: BullMQ workers that execute agent steps
├── AgentStepWorker.ts          Generic step executor — picks step kind from outbox payload
├── AgentRunStarterWorker.ts    Starts a new agent run when a trigger event fires
└── AgentOutcomeMeterWorker.ts  Hourly batch — meters new outcomes to Stripe
```

### 2.2 Substrate principles (load-bearing)

1. **All side effects flow through `tool-runner.ts`.** No worker writes to Google, sends an email, emits a billable outcome, or charges Stripe except via a registered tool. This is the single chokepoint where policy gates, rate limits, cost guards, idempotency keys, and audit logs are enforced. It is load-bearing for every agent: `post_reply_via_adapter` (Reply), `send_via_channel` (Solicitation), and `record_outcome` (both) all pass through the same chokepoint.

2. **`step-executor.ts` is the only place outbox-driven step advancement happens.** A step's effects (next steps, outcomes, gate decisions) are written in *one* Postgres transaction with the step's completion — same outbox pattern the rest of the codebase uses.

3. **Agent kinds are pure declarations** (step graph + trigger predicate). Adding an *independent* agent in V2 = drop in `kinds/<name>/`, register any new tools, done. **This drop-in claim holds only for agents that don't coordinate with other agents.** Coordinated agents (e.g. V2 Complaint-Recovery must suppress Reply on the same review) use the **coordination-key primitive shipped in V1** (§3.1 `agent_runs.coordination_key`) — every agent that handles the coordinated subject claims the same subject key at run start, and mutual exclusion falls out of a partial unique index, not new substrate code. We design the *primitive* in V1 precisely so the one feature that would otherwise reopen the substrate is already there.

4. **Trust dial logic lives in *one* file** (`trust-dial.ts`), called from one place (a `policy_gate` step). Pure function; exhaustively unit-testable; replayable against new policy.

5. **Existing workers are wrapped, not deleted.** `ResponseGeneratorWorker`, `NotificationWorker`, `ResponsePublisherWorker`, `ReviewSyncWorker` continue to exist; they become tool implementations. Migration is gradual behind `AGENT_RUNTIME_ENABLED`; when off, world looks exactly like today.

6. **`job_outbox` is the only event substrate.** No second event bus. Step transitions, run starts, outcome emissions, and trigger events all flow through it.

7. **Parent/child runs** are first-class via `agent_runs.parent_run_id`. Required by Solicitation Batch → Outreach fan-out; reusable by every future fan-out agent.

### 2.3 What is explicitly NOT in the substrate at V1

- No vector store / embedding table (deferred to V2's Insights Agent if needed).
- No generic key/value "memory" store (run state lives on `agent_runs` + domain tables).
- No LLM-driven policy decisions (gates are deterministic; classifications can be LLM-generated but the gate logic is a pure function).
- No second event bus beyond `job_outbox`.

---

## 3. Data model (Section 2 of original brainstorm)

All new tables follow existing conventions: UUIDv7 IDs, `account_id` + `business_id` scoping, transactional writes via Postgres.js, partial unique indexes for dedup, RLS enforced.

### 3.1 New tables — substrate

| Table | Purpose | Key fields |
|---|---|---|
| `agent_kinds` | Static registry of agent definitions. One row per kind. | `id`, `slug`, `graph_version`, `trigger_events[]`, `is_enabled` |
| `agent_runs` | First-class agent run entity. Core observability surface. One row per agent invocation. | `id`, `account_id`, `business_id`, `agent_kind`, `parent_run_id` (nullable), `coordination_key` (nullable text — see below), `status` (`pending`/`running`/`held_for_approval`/`completed`/`failed`/`cancelled`), `trigger_event_id`, `started_at`, `ended_at`, `outcome_summary jsonb` |
| `agent_run_steps` | Per-step history within a run. Append-only. | `id`, `agent_run_id`, `step_index`, `step_kind` (`tool_call`/`llm_call`/`policy_gate`/`outcome_emit`/`wait_for_event`/`human_approval`/`spawn_child_run`), `tool_slug`, `tool_authorization_id` (FK, nullable except for gated side effects; see §4.1 layer 3), `input jsonb`, `output jsonb`, `cost_cents`, `latency_ms`, `started_at`, `completed_at`, `error jsonb` |
| `agent_policies` | Trust dial configuration. Scoped at `(account_id, business_id_or_null, agent_kind)`. | `id`, `account_id`, `business_id` (nullable), `agent_kind`, `rules jsonb`, `kill_switch`, `updated_by`, `updated_at` |
| `agent_policies_history` | Append-only audit of policy edits. | `id`, `agent_policy_id`, `before jsonb`, `after jsonb`, `changed_by`, `changed_at` |
| `policy_decisions` | Immutable audit of every `policy_gate` step. | `id`, `agent_run_id`, `agent_run_step_id`, `policy_id`, `decision` (`auto_pass`/`hold_for_approval`/`deny`), `matched_rule jsonb`, `inputs jsonb`, `decided_at` |
| `tool_authorizations` | Immutable authorization row consumed by side-effecting tool calls. Separates policy decisions from human approvals. | `id`, `agent_run_id`, `authorizing_step_id`, `action_category`, `source` (`policy_auto_pass`/`policy_hold_request`/`human_approval`/`system_internal`), `policy_decision_id` (nullable), `approval_audit_log_id` (nullable), `approval_link_id` (nullable), `inputs_hash`, `expires_at`, `authorized_at` |
| `tool_invocations` | Single audit table for every tool call. Powers cost dashboards, rate-limit checks, run inspector. | `id`, `agent_run_id`, `agent_run_step_id`, `tool_slug`, `account_id`, `input_redacted jsonb`, `output_redacted jsonb`, `status`, `cost_cents`, `latency_ms`, `error jsonb`, `invoked_at` |
| `billable_outcomes` | Outcome events emitted by `outcome_emit` steps. Source of truth for metering. | `id`, `account_id`, `business_id` (nullable), `agent_kind`, `outcome_kind`, `agent_run_id`, `unit_count`, `billing_period_start`, `billing_period_end`, `pricing_version`, `metered_to_stripe_at` (nullable), `created_at` |
| `outcome_meter_state` | Per-account per-period running totals for idempotent Stripe sync. | `account_id`, `billing_period_start`, `billing_period_end`, `outcome_kind`, `count_total`, `count_metered_to_stripe`, `last_synced_at`, `stripe_subscription_item_id` |
| `outcome_meter_events` | Local ledger of outbound Stripe meter submissions. Prevents "Stripe accepted, DB update failed, retry double-submits" ambiguity. | `id`, `account_id`, `outcome_kind`, `billing_period_start`, `billing_period_end`, `pricing_version`, `chargeable_count`, `idempotency_key`, `stripe_meter_event_id` (nullable), `status` (`pending`/`submitted`/`confirmed`/`failed`), `submitted_at`, `confirmed_at`, `last_error` |

**`coordination_key` (cross-agent mutual exclusion, V1 primitive / V2 consumer).** A nullable key naming a *subject* that at most one active run may hold — e.g. `review:{review_id}`. A partial unique index (§3.4) enforces "one active run per subject." V1 agents leave it null (no coordination needed). In V2, both Complaint-Recovery and Reply claim `review:{id}` at run start inside the trigger transaction; the loser suppresses itself before any side effects. A read-only "check for a conflicting active claim" is not sufficient because it races. The *logic* is V2; the *column + index* ship in V1's migration 042 so V2 is a true drop-in.

### 3.2 New tables — Solicitation Agent V1

| Table | Purpose |
|---|---|
| `customer_contacts` | One row per `(account, email-or-phone)` contact ledger. Holds source, consent record, suppression flags, `last_solicited_at`. WhatsApp/SMS phone columns present from V1 for forward-compat. |
| `solicitation_lists` | One row per owner-initiated batch. Source (`csv_upload`/`paste`/`stripe_customers_connector`), upload metadata, target_business_id, status, totals. |
| `solicitation_list_members` | Junction: `(list_id, customer_contact_id)`. Per-member status (`pending`/`sent`/`bounced`/`replied`/`suppressed`). |
| `solicitation_outreach` | One row per actual send. Channel (`email` V1; `whatsapp` V1.5), template version, `agent_run_id`, send result, opened/clicked timestamps. |
| `consent_records` | Append-only consent ledger. One row per consent event (`granted`/`revoked`). FK to `customer_contacts`. Required for TCPA/CASL/WhatsApp opt-in proofs. |

### 3.3 Evolved tables

| Table | Added columns |
|---|---|
| `accounts` | `pricing_model` (`'tier'` \| `'outcome'`), `execution_path` (`'legacy'` \| `'agent'`), `outcome_floor_cents`, `outcome_floor_allotments jsonb` (e.g. `{"reply_posted": 30, "solicitation_sent": 50}`), `migration_to_outcome_at` |
| `responses` | `agent_run_id` (nullable FK) |
| `notification_deliveries` | `agent_run_id` (nullable), `tool_invocation_id` (nullable) |
| `job_outbox` | `agent_run_id` (nullable), `agent_run_step_id` (nullable) |
| `account_pricing_history` | NEW audit table; one row per pricing-state transition. `id`, `account_id`, `from_model`, `to_model`, `changed_by`, `changed_at`, `notes jsonb` |

### 3.4 Indexes & constraints worth flagging now

- `agent_run_steps`: composite `(agent_run_id, step_index)`; partial index for in-flight runs.
- `tool_invocations`: composite `(account_id, invoked_at desc)` for cost/usage queries.
- `billable_outcomes`: composite `(account_id, billing_period_start, billing_period_end, outcome_kind)`; partial unique on `(agent_run_id, outcome_kind)` to prevent double-emission on retry.
- `outcome_meter_events`: unique on `(idempotency_key)` and composite `(account_id, billing_period_start, billing_period_end, outcome_kind, status)`.
- `policy_decisions`: append-only via revoked UPDATE/DELETE grants.
- `tool_authorizations`: append-only via revoked UPDATE/DELETE grants; composite `(agent_run_id, action_category, expires_at)`.
- `agent_policies`: partial unique on `(account_id, business_id, agent_kind)` — at most one policy per scope.
- `agent_runs`: partial unique on `(business_id, coordination_key)` `WHERE coordination_key IS NOT NULL AND status IN ('pending','running','held_for_approval')` — enforces at-most-one active run per coordinated subject. Inert in V1 (key always null); load-bearing for V2 cross-agent suppression.
- `customer_contacts`: partial unique on `(account_id, lower(email))` and `(account_id, e164_phone)`.
- `accounts`: CHECK constraint forbids `(execution_path='legacy' AND pricing_model='outcome')` — see §8.A.

### 3.5 Migration sequence

6-8 new Supabase migrations (042 onward):

| # | Concern |
|---|---|
| 042 | Substrate core (`agent_kinds`, `agent_runs`, `agent_run_steps`) |
| 043 | Policy + audit (`agent_policies`, `agent_policies_history`, `policy_decisions`, `tool_authorizations`, `tool_invocations`) |
| 044 | Outcomes + metering (`billable_outcomes`, `outcome_meter_state`, `outcome_meter_events`, `accounts.pricing_model`, `accounts.execution_path`, `accounts.outcome_*` columns) |
| 045 | Solicitation tables (`customer_contacts`, `solicitation_lists`, `solicitation_list_members`, `solicitation_outreach`, `consent_records`) |
| 046 | Foreign-key columns on existing tables (`responses.agent_run_id`, `notification_deliveries.*`, `job_outbox.*`) |
| 047 | Indexes / RLS tightening pass |
| 048 | `account_pricing_history` audit table |
| 049 (if needed) | Backfill helpers |

Each migration ships individually behind `AGENT_RUNTIME_ENABLED`.

---

## 4. Trust dial enforcement (Section 3 of original brainstorm)

This section *replaces* the current load-bearing invariant: *"No code path from response generation to Google posting without an explicit approval step."* The replacement is **architecturally stronger** (it generalizes to every agent and every tool) and **conditionally permissive** (policy can authorize auto-pass in the safe quadrant).

### 4.1 Four-layer enforcement model

Bypassing the trust dial requires defeating all four layers independently.

**Layer 1 — Step graph topology (compile-time).**
Every side-effecting tool is registered with an `authorization_policy`: the action category it performs and the accepted authorization sources for that action. Examples:
- `post_reply_via_adapter`: accepts `policy_auto_pass` or `human_approval`.
- `request_human_approval`: accepts `policy_hold_request`.
- `send_via_channel`: accepts the Solicitation outreach policy's configured source.
- `record_outcome`: accepts `system_internal` only when emitted by a completed, idempotent outcome step.

`graph-loader.ts` statically validates that every side-effecting tool is preceded by a step capable of issuing a matching `tool_authorizations` row. Graphs that fail this check error at substrate boot. Developers cannot ship an agent that posts, emails, or bills without an authorization path.

**Layer 2 — Step executor runtime check.**
Before running a `tool_call` for a side-effecting tool, `step-executor.ts` requires a matching, unexpired `tool_authorizations` row tied to the same `agent_run_id`, action category, and authorizing source accepted by the tool registry. If absent, the step is marked `failed` with reason `missing_tool_authorization`; the run halts.

**Layer 3 — Database constraint (trigger, not `CHECK`).**
The cross-row invariant — "a gated `tool_call` step's `tool_authorization_id` must reference a valid `tool_authorizations` row *in the same run*, for the same action category, with a source accepted by that tool" — **cannot be a `CHECK` constraint**, because `CHECK` may only reference columns of the same row (no subqueries / cross-row lookups). It is enforced as:
- A **`NOT NULL` + FK** on `agent_run_steps.tool_authorization_id` for rows where `step_kind = 'tool_call'` AND `tool_slug` ∈ gated-tools allowlist (the NOT-NULL half *is* expressible via a `CHECK` against local columns), plus
- A **`BEFORE INSERT/UPDATE` trigger** that re-validates the referenced `tool_authorizations` row belongs to the same `agent_run_id`, is unexpired, matches the tool's action category, and carries an accepted source. For `source = 'policy_auto_pass'`, the trigger also verifies the linked `policy_decisions` row has `decision = 'auto_pass'`. For `source = 'policy_hold_request'`, it verifies the linked policy decision has `decision = 'hold_for_approval'`. For `source = 'human_approval'`, it verifies the linked approval audit row records an approved/edit-approved action for the same response/run. The trigger raises on violation; Postgres rejects the row.

This split matters: the spec's "defeat all four layers independently" claim depends on Layer 3 being real. A `CHECK` here would silently no-op the cross-row half.

**Layer 4 — RLS + role grants.**
The `tool_runner` role has `EXECUTE` on a small set of tool-execution functions. Database RLS and grants prevent direct table mutation, while application-level boundaries prevent direct provider calls:
- provider credentials for Zernio, Resend, Stripe meter writes, and future messaging adapters are available only to worker/tool modules, never browser code;
- side-effecting provider clients are wrapped behind adapter/tool modules;
- `no-restricted-imports`/dependency-boundary tests fail if non-tool modules import side-effect clients directly;
- tool SQL functions re-verify `tool_authorizations` before durable state changes.

Existing direct clients are wrapped during migration; the "four-layer enforcement" claim is not considered true until the direct-import boundary tests pass.

### 4.2 Policy structure

A policy is a list of rules, evaluated in order; first match wins. Each rule:
- **Scope predicate** (e.g. `agent_kind = 'reply'`, `rating <= 3`, `has_competitor_mention = true`, `language != 'en'`, `business_id IN [...]`)
- **Autonomy decision** (`auto_pass` / `hold_for_approval` / `deny`)
- **Reason code** (for audit)
- Optional **window override** (e.g. business hours only)

Implicit catch-all final rule: `hold_for_approval` for anything unmatched. New categories never accidentally auto-pass.

### 4.3 Failure modes & kill switches

| Failure mode | Behavior |
|---|---|
| `agent_policies.kill_switch = true` | Short-circuits gate to `hold_for_approval` for that scope. One-click owner pause. |
| Env var `AGENT_KILL_SWITCH=true` | Global; every gate denies. Operations override. |
| Policy load failure (malformed rules) | Halts runs at the gate with `decision = 'deny'`. Never auto-pass by accident. |
| Stale policy decision (> N minutes) | Rejected by Layer 2; gate must re-evaluate. |

### 4.4 Pre-existing approval flow

When policy decides `hold_for_approval`, the existing approval flow (token generation, email, device-bound cookies, CSRF, approval page) runs unchanged. Conservative owners experience exactly today's flow.

### 4.5 What this layer does NOT include

- No LLM-driven policy decisions (gate logic is pure-function).
- No per-action "force-post" override token.
- No retroactive trust decisions (a held run can only be released via the `human_approval` step, distinct from `auto_pass`).

---

## 5. Reply Agent V1 step graph (Section 4 of original brainstorm)

### 5.1 Triggers

| Event | Source | Result |
|---|---|---|
| `review_inserted` | `ReviewSyncWorker` — emits trigger event in same tx as review insert | Spawns Reply Agent run |
| `review_updated` (text changed by reviewer) | `ReviewSyncWorker` | Spawns Reply Agent run with `regenerate=true` if posted response exists |
| `regenerate_requested` | Owner action via approval page | Resumes existing run; loops back to `generate_reply_text` |

Trigger events written in same Postgres transaction as the underlying state change.

### 5.2 Step graph

```
[1] load_context                   tool_call
[2] subscription_guard             policy_gate (subscription)
[3] cost_guard_reserve             tool_call
[4] generate_reply_text            llm_call   ← wraps ResponseGeneratorWorker
[5] cost_guard_reconcile           tool_call
[6] voice_learning_hook            tool_call (best-effort, non-blocking)
[7] trust_dial_gate                policy_gate (autonomy)   ← THE gate

    ├── auto_pass ─────────────────────────────────────────┐
    │   [8a]  post_reply_via_adapter  tool_call (gated)    │
    │   [9a]  record_outcome          outcome_emit         │
    │   [10a] complete_run            terminal             │
    │                                                       │
    ├── hold_for_approval ──────────────────────────────────┤
    │   [8b]  request_human_approval  tool_call (gated)    │
    │   [9b]  wait_for_event          wait_for_event       │
    │   [10b] post_reply_via_adapter  tool_call (gated)    │
    │   [11b] record_outcome          outcome_emit         │
    │   [12b] complete_run            terminal             │
    │                                                       │
    └── deny ───────────────────────────────────────────────┤
       [8c] record_outcome (reply_skipped_policy)          │
       [9c] halt_run                                        │
```

Key implementation notes:
- `post_reply_via_adapter` is gated by either `trust_dial_gate=auto_pass` OR `human_approval` step resolving as `approved`/`edit_approved`. The policy path creates a `policy_decisions` row plus a `tool_authorizations(source='policy_auto_pass')` row. The human path creates/links the approval audit row plus a `tool_authorizations(source='human_approval')` row. Layer-2/Layer-3 enforcement accepts only the `tool_authorizations` row, which removes the ambiguity between policy decisions and human approvals.
- Edit+approve mirrors today's flow: owner edits draft text on the approval page; run resumes at `[10b]` with edited text; `responses.edited_text` and `edit_distance` populated as today.
- Regenerate loops back to `[4]` with regen budget guard (3-per-day-per-review limit preserved).
- Review-edited-after-post (`AdminExceptionWorker`) becomes a tool but workflow is unchanged.
- `held_for_approval` runs are stable and resumable; no CPU burn while waiting.

### 5.3 Preserved behaviors (unchanged from today)

| Existing behavior | How preserved |
|---|---|
| Approval tokens (SHA-256 hashed, raw never persisted) | `request_human_approval` calls existing `createApprovalLink()` |
| Approval email (Resend, device-bound cookies, CSRF) | `request_human_approval` enqueues existing notification outbox |
| Approval page UI | Unchanged; reads same `approval_links` rows |
| Notification failover (4h stale + bounced reattempt) | `NotificationFailoverPoller` continues; agent runs receive resume event from new token |
| Subscription guard | `subscription_guard` policy_gate step |
| Cost guard + regen budget | Explicit gate / tool steps |
| Voice learning | `voice_learning_hook` non-blocking step |
| Past-replies view, external-reply ingestion | Independent; no changes |
| Weekly value report + monthly impact email | Read `responses` + `agent_runs`; nothing breaks |
| Engagement / churn detection | Reads remain `responses`-based; unchanged |
| Multi-location scoping (`account_id` + `business_id`) | Every run carries both; tools enforce |

### 5.4 UX additions for owners

- Trust dial UI: per-location autonomy rules. Default policy at migration: `hold_for_approval everywhere`.
- Run timeline page: recent runs, status, auto-passed vs. held vs. denied.
- Approval emails include a one-line footer indicating policy decision.

### 5.5 UX additions for admin

- Agent runs cross-account view: filterable by status / kind / outcome / cost.
- Policy editor: admin override; mutations require admin role; audited to `agent_policies_history`.

### 5.6 Not in V1 Reply Agent

- Cross-agent coordination (deferred to V2 when Complaint-Recovery exists).
- Multi-language translation step (policy can match on language; no translation yet).
- A/B testing of generated text.

---

## 6. Solicitation Agent V1 step graph (Section 5 of original brainstorm)

V1 scope: owner-initiated batches, email only. Designed as **two cooperating agents** so V1.5 (WhatsApp + QR) and V2 (POS triggers) are cheap to add.

### 6.1 Two-agent shape

```
Solicitation Batch Agent (V1-specific, owner-initiated)
    ↓ orchestrates a whole batch
    └── spawns N children
         ↓
         Solicitation Outreach Agent (per recipient — REUSABLE)
             ↓ does the actual personalize + send for one recipient
             ↓ also reused later by event-triggered Solicitation in V2
             ↓ also reused for WhatsApp in V1.5 (different channel, same agent)
```

The Batch Agent is V1-specific; the Outreach Agent is the durable reusable unit.

### 6.2 Solicitation Batch Agent — step graph

```
Trigger: solicitation_batch_started   ← owner clicks "Send to N customers"

[1] load_batch_context             tool_call
[2] subscription_guard             policy_gate (subscription)
[3] compliance_pre_check           tool_call
    ↓ filters: invalid email, no consent, suppressed, cooldown, unsubscribed
[4] batch_policy_gate              policy_gate (autonomy on batch)
    ↓ rule examples: "auto_pass batches ≤100",
                     "hold_for_approval >100",
                     "deny if >3 batches this week"
    ├── hold_for_approval ─→ [4a] request_human_approval (batch-level) → resume at [5]
    └── deny ──────────────→ [4b] record_outcome → halt
[5] throttled_fan_out              tool_call (special)
    ↓ creates one child Outreach run per eligible member
    ↓ throttled (≤N/min) to protect deliverability
[6] wait_for_children              wait_for_event
[7] aggregate_outcomes             tool_call
[8] record_outcome                 outcome_emit (batch-level, informational)
[9] complete_run                   terminal
```

### 6.3 Solicitation Outreach Agent — step graph (reusable unit)

```
Trigger: spawned by parent (Batch Agent V1; POS event V2)
                            payload: customer_contact_id, business_id, channel

[1] load_recipient_context         tool_call
[2] subscription_guard             policy_gate
[3] consent_recheck                tool_call
    ↓ re-validates at send-time (could have unsubscribed since batch start)
[4] personalize_message            llm_call
    ↓ wraps existing prompt builder; injects {first_name}, {business_name}, review_url
[5] outreach_policy_gate           policy_gate (autonomy on send)
    ↓ rule examples: "deny if empty message",
                     "hold if spam-like classifier triggers",
                     "auto_pass otherwise"

    ├── auto_pass ─────────────────────────────────────────┐
    │   [6a]  send_via_channel       tool_call (gated)     │
    │         ↓ uses MessagingAdapter (EmailAdapter V1)     │
    │   [7a]  record_outcome         outcome_emit          │
    │         ↓ outcome_kind='solicitation_sent', count=1  │
    │   [8a]  wait_for_async_signals wait_for_event       │
    │         ↓ background: opens/clicks/replies            │
    │         ↓ resolves on attribution window expiry (14d)│
    │   [9a]  record_attribution     tool_call (best-effort)│
    │         ↓ fuzzy-match new review to this solicitation │
    │         ↓ emits 'review_attributed' (billable only   │
    │           after attribution precision gate clears;   │
    │           otherwise shadow/no-charge)                │
    │   [10a] complete_run           terminal              │
    │                                                       │
    ├── hold_for_approval ──────────────────────────────────┤
    │   [6b] enqueue for batch-level edit + approval        │
    │   [7b] wait_for_event → on approve → [6a]            │
    │                                                       │
    └── deny ───────────────────────────────────────────────┤
       [6c] record_outcome (solicitation_skipped_policy)    │
       [7c] halt_run                                        │
```

### 6.4 Billable outcome decisions (V1)

**Principle: the headline billed unit must be the outcome the customer wants, not our activity.** Billing per *delivered email* (`solicitation_sent`) makes us a mailing-list vendor and makes our own incentive "send more" — the exact misalignment outcome-pricing is supposed to fix. So:

- **`review_attributed`** → **the headline billable unit.** One unit per new review fuzzy-matched to a solicitation within the attribution window (§6.3 `record_attribution`, 14d). This is what the owner is buying. *Billing-quality gate:* we do not *charge* on this unit until M3 defines and validates a billable-grade attribution bar — target precision, minimum manually reviewed sample, evidence shown to the owner, duplicate-review handling, organic-review false-positive handling, and the dispute/credit path. Until that bar is cleared, Solicitation emits `review_attributed` in **shadow / no-charge** mode (the outcome is recorded and shown to the owner, just not metered to Stripe), and solicitation billing falls back to a flat add-on price. Clearing the bar flips it to metered. This gates *how Solicitation bills*, not *whether the agent platform ships*.
- **`solicitation_sent`** → metered for *floor consumption and deliverability caps only*; **not** the headline overage unit. May be included in the floor allotment so a reasonable send volume is "free," with overage charged on `review_attributed`. This keeps a sane cost ceiling without turning sends into the revenue driver.
- **`solicitation_skipped_policy`** → never billed.
- **`solicitation_batch_completed`** → never billed (informational summary).

> Contrast with Reply: `reply_posted` *is* a defensible headline unit, because the owner's desired outcome genuinely is "every review answered." Solicitation's desired outcome is reviews *gained*, not emails *sent* — hence the different billing unit.

### 6.5 Compliance & deliverability (V1, email-only)

- Consent capture at list import (`existing_customer` / `direct_consent` / `prior_relationship`) recorded as `consent_records`.
- Suppression list per account. Unsubscribe links in every email; landing page writes suppression row.
- RFC 8058 one-touch unsubscribe header. Required for Gmail bulk-sender requirements.
- DKIM/SPF/DMARC aligned with Resend.
- Per-account, per-day send caps as policy rules.
- Content-class checks in `personalize_message` (no empty bodies, no competitor mentions, no price quotes).

### 6.6 Substrate gains forced by Solicitation

- **Channel abstraction.** `send_via_channel` tool with `MessagingAdapter` interface (`EmailAdapter` V1, `WhatsAppAdapter` V1.5).
- **Parent/child runs.** Reply alone wouldn't need them; every future fan-out agent gets them free.
- **Consent infrastructure.** Reply doesn't need it; building it now enables V1.5/V2.
- **Customer contact ledger.** Foundation for future Complaint-Recovery / loyalty agents.

### 6.7 Not in V1 Solicitation

- Scheduled / recurring sends (V1.5).
- Multi-channel single-recipient orchestration (V1.5+).
- A/B testing templates (V2).
- POS connectors (V2).
- QR landing page flow (V1.5).
- Reply-handling (V2).

---

## 7. Outcome metering & Stripe (Section 6 of original brainstorm)

### 7.1 Stripe object model

Each post-migration account has **one Stripe subscription** with **multiple subscription items**:

| Subscription item | Stripe product | Stripe price | Purpose |
|---|---|---|---|
| `floor_item` | `repworth-agent-floor` | Recurring flat (~$49/mo) | Monthly retainer; includes floor allotments. Always present. |
| `reply_overage_item` | `repworth-reply-overage` | Metered usage, per-unit | `reply_posted` beyond floor allotment. |
| `solicitation_overage_item` | `repworth-solicitation-overage` | Metered usage, per-unit | `review_attributed` beyond floor allotment once the attribution precision gate clears (§6.4). `solicitation_sent` is metered for floor/deliverability caps only, not charged here. |
| *(future)* `complaint_recovery_overage_item` | … | Metered, per-unit | V2 drop-in. Pattern: new outcome kind = new subscription item. |

### 7.2 Metering pipeline

```
agent_run completes a step that emits an outcome
        ↓ (in same Postgres tx as step completion)
    INSERT INTO billable_outcomes (...)
    UPDATE outcome_meter_state SET count_total = count_total + 1
        ↓ (no Stripe call yet — DB is source of truth)
        ↓
    AgentOutcomeMeterWorker runs hourly:
        1. SELECT outcomes since last_synced_at, grouped by
           (account_id, outcome_kind, billing_period_start, billing_period_end, pricing_version)
        2. chargeable_count = max(0, count_total - floor_allotment - count_metered_to_stripe)
        3. If chargeable_count > 0:
            INSERT outcome_meter_events(status='pending', idempotency_key=...)
            POST to Stripe Meter Events API
            idempotency_key = sha256(account_id + outcome_kind + billing_period_start + billing_period_end + pricing_version + window_id)
        4. Mark outcome_meter_events submitted/confirmed with Stripe event id
           and update count_metered_to_stripe + last_synced_at
        5. Mark source billable_outcomes rows metered
```

### 7.3 Design calls

- **DB is source of truth; Stripe is recipient.** Never read usage from Stripe to make decisions. Reconciliation reads Stripe to detect drift, never to advance state.
- **Hourly batch sync.** Customer-visible meter reads from `outcome_meter_state` directly (up-to-the-second); only Stripe sync is hourly.
- **Floor allotment enforced in meter, not in agent.** A reply that uses up the floor still emits a `reply_posted` outcome. Meter decides chargeability.
- **Billing period is explicit.** Store `billing_period_start` + `billing_period_end` from the account's active subscription anchor, not just `YYYY-MM`. A display `period_key` may exist in UI, but metering logic must use the explicit bounds so mid-period downgrades, grandfathering, and price migrations can split cleanly.

### 7.4 Idempotency layers

1. **Outcome insert dedup.** `billable_outcomes` partial unique on `(agent_run_id, outcome_kind)`; `INSERT ... ON CONFLICT DO NOTHING`.
2. **Meter sync dedup.** `count_metered_to_stripe` monotonically increases; worker reports delta only.
3. **Local Stripe event ledger.** `outcome_meter_events` records each outbound Stripe meter submission before the API call. If Stripe accepts the event but the DB update fails, retry resumes from the local ledger instead of recomputing an ambiguous delta.
4. **Stripe-side dedup.** Deterministic idempotency key per Meter Event. This is the last line of defense, not the primary ledger.

### 7.5 Drift reconciliation

`OutcomeDriftReconcilePoller` runs daily. Compares `SUM(billable_outcomes.unit_count)` (adjusted by floor allotment) vs. Stripe's reported usage. Drift > $1 OR > 5% triggers admin alert (Sentry + email). **Never auto-corrects.**

### 7.6 Customer-visible meter

Dashboard widget reads `outcome_meter_state` directly: floor consumption, overage units + dollar estimate, projected month-end bill, "trust dial impact" footnote (e.g. "Auto-passing saved ~12 minutes this month"). Renders differently per `pricing_model` value during migration.

### 7.7 Floor allotment logic

`accounts.outcome_floor_allotments` is JSONB map per outcome_kind. Mutable from admin (audited to `account_pricing_history`). Resets on subscription anchor (not calendar month). Carryover OFF by default. Per-outcome-kind, not pooled.

### 7.8 Edge cases (V1)

| Scenario | Behavior |
|---|---|
| `cancelled` mid-period | Subscription guard halts new runs; already-metered usage stays; final invoice charges only metered. |
| `past_due` | 7-day grace continues; outcomes still emit; meter sync continues. |
| `pending_payment` | New runs blocked at subscription_guard step; no outcomes emit. |
| Plan downgrade mid-period | Stripe handles proration; metering splits into two explicit billing-period/pricing-version slices if needed. |
| Refund / credit | Operations issues credit in Stripe directly; `billable_outcomes` untouched; `account_pricing_history` row captures decision. |
| Tax / VAT | Stripe Tax. |
| Multi-currency | USD only V1; CAD/GBP/EUR in V1.5 via separate price IDs. |

### 7.9 Scale properties

- New agent in V2 = one new Stripe product + one new outcome_kind. Substrate untouched.
- Swapping Stripe to Lago/Metronome = one-file swap of meter worker. Outcome model provider-agnostic.
- Finance audit: a single SQL query traces every dollar billed back to `billable_outcomes` → `agent_run_steps` → `tool_invocations` → actual API call.

---

## 8. Migration plan (Section 7 of original brainstorm)

> **This is the committed destination of the single program (§0.1), not a gated optional phase.** The migration runs after the Reply agent is stable on the substrate. Its risk is managed by the transitional `(agent, tier)` shadow state below — the runtime executes in production and computes every bill before money moves — and by tuning pricing/floor/allotments before T-0. The Solicitation agent, built and launch-ready in V1, is rolled out to customers ahead of (or alongside) the founders-ring phase; it does not block the migration timeline.

### 8.A Two-axis model with one forbidden combination

| Execution | Pricing | Permitted? | Meaning |
|---|---|---|---|
| `legacy` | `tier` | ✅ | Today's world. Default at flag flip. |
| `agent` | `tier` | ✅ | Transitional. Agent runtime executes; outcomes emitted to DB only ("shadow metering"). No Stripe sync. |
| `legacy` | `outcome` | ❌ **Forbidden by DB CHECK constraint.** |
| `agent` | `outcome` | ✅ | Fully migrated. Outcomes meter to Stripe; tier subscription items deleted. |

The transitional `(agent, tier)` state is the de-risking mechanism: agent runtime runs in production for weeks against real customers without touching their bill. Drift, bugs, and cost issues surface in shadow mode before money moves.

### 8.B Code migration phases (execution path)

| Phase | Scope | Goal |
|---|---|---|
| 0 | All accounts `(legacy, tier)`; `AGENT_RUNTIME_ENABLED=false` globally; substrate code merged | Substrate boots; zero behavior change |
| 1 | Internal dogfood; staff accounts on `(agent, tier)`; outcomes emit to DB only | Bake real Reply runs through substrate |
| 2 | Founders ring ~5-10 accounts on `(agent, tier)` | Validate at real customer load |
| 3 | All customers on `(agent, tier)`; tier subscription unchanged | Validate at full volume before flipping pricing |
| 4 | Pricing migration (see §8.C) | |
| 5 | Decommission legacy path (~60-90 days after Phase 3 stable) | Delete legacy worker code |

Rollback is not just `UPDATE accounts SET execution_path = 'legacy' WHERE id = ?`. That update is the routing switch, but the rollback procedure must also:
- pause new trigger creation for the affected account(s);
- stop Stripe meter sync for the affected account(s) before any pricing rollback;
- drain or cancel active agent runs according to run status;
- rely on stable side-effect idempotency keys (`send_via_channel`, `post_reply_via_adapter`, `record_outcome`) so legacy reprocessing cannot duplicate emails, replies, or billable outcomes;
- resume legacy triggers only after the drain/cancel audit is clean.

Default rollback behavior: no new agent runs start after the routing switch; already-authorized side effects complete only if their tool idempotency ledger proves they have not already been performed. Otherwise the run is marked `cancelled` or `superseded` with an audit row.

### 8.C Customer pricing migration phases (forced migrate, 60-day notice)

| Time | Action |
|---|---|
| T-60d | Public announcement (email + dashboard banner + blog post); in-app calculator with real shadow-metered data |
| T-50d | Founders ring opt-in with benefited offer (lower floor / larger allotments / price-protected overage for 12 months) |
| T-30d | Standard tier opt-in window; early-migrate incentive |
| T-15d | Final reminder; support flags pre-staged |
| T-0 | Forced cut-over (per-account idempotent operation); failures retry daily with admin alerts |
| T+7d | Reconciliation pass: audit `pricing_model`, current Stripe items, last invoice |
| T+30d | First full outcome-billed cycle; compare projected vs. actual; alert on > 20% delta |

### 8.D Communication & UX

- **Dashboard banner**: tier countdown + "Preview your new bill" button. Removed at T+30d.
- **Email cadence per account**: T-60, T-30, T-15, T-7, T-1, T+0, T+30.
- **Trust dial defaults at migration**: every account starts `hold_for_approval everywhere`. Owners explicitly turn on auto-pass per rating band. Zero auto-posts as a migration side-effect.
- **In-app calculator** uses real shadow-metered data (Phases 2-3); fallback to 90-day projection from `responses` history.
- **Support runbook** pre-staged for top 5 expected complaints with canned responses.

### 8.E One-time backfills

| Backfill | When | What |
|---|---|---|
| Default `agent_policies` per account | Phase 1 entry | "hold_for_approval everywhere" |
| `customer_contacts` from existing data | Phase 1 entry | Normalize into ledger (may be no-op) |
| Stripe product/price catalog | Pre-Phase 0 | Floor + per-outcome overage products + Meters |
| `account_pricing_history` baseline | Phase 0 | One row per account with `pricing_model='tier'`, `migration_to_outcome_at=null` |

### 8.F Rollback strategies

| Phase | Rollback action | Time | Customer-visible? |
|---|---|---|---|
| 0 → 1 | Flip `AGENT_RUNTIME_ENABLED=false` | < 5 min | No |
| 1 → 0 | UPDATE accounts SET execution_path='legacy' | < 5 min | No (staff) |
| 2 → 1 | Per-account UPDATE | < 1 min/account | Yes — slight UX revert |
| 3 → 2 | Bulk UPDATE for opted-out accounts | < 30 min | Yes — slight UX revert |
| 4 → 3 | Cancel new Stripe items, reinstate tier items, UPDATE pricing_model='tier' | ~5 min/account | Major. Pre-staged scripts required. |
| 5 → 4 | Restore deleted legacy worker code from tagged release | ~1 day eng | No |

Every rollback script includes a preflight that checks active `agent_runs`, pending `job_outbox` rows, unconfirmed `outcome_meter_events`, and already-performed tool idempotency keys. If any check is red, the script refuses the bulk rollback and requires per-account operator review.

### 8.G Risks specific to forced migration

| Risk | Mitigation |
|---|---|
| Higher bill → churn | Shadow-metering pre-computes every bill; tune prices/floor before T-0 |
| Auto-posting starts unexpectedly | Trust dial defaults to "hold everywhere"; owners opt in per rating band |
| Outcome metering double-bills | Outcome dedup + monotonic meter state + local Stripe event ledger + Stripe idempotency (§7.4) |
| Founders feel forced out of "founders" identity | Founders ring gets benefited offer |
| Stripe ops fails for some accounts at T-0 | Per-account idempotent + retry job + admin alert |
| In-flight `held_for_approval` runs at T-0 | Freeze new triggers, let explicitly approved runs finish on agent path, and meter under pricing model active at emission time; rollback scripts cancel/supersede unapproved runs before legacy resumes |
| Support can't keep up | Pre-staged FAQ + canned responses + 30-day price-match for unfair-feeling bills |

### 8.H Not doing in migration

- No "self-service downgrade back to tier" post-migration.
- No new tier-pricing acquisition flow after Phase 0.
- No mid-period pricing changes for existing customers during migration window.

---

## 9. Meta-mission decomposition (Section 8 of original brainstorm)

### 9.0 Single-program structure (Reply first, Solicitation built and kept ready)

Per §0.1, V1 is **one committed program**, not two gated halves. M1 is the substrate gate; everything else builds on it; the forced pricing migration (M6) is the committed destination, de-risked by shadow metering rather than by an off-ramp.

- **M1 builds the substrate to the level the Reply agent needs up front** — including the full four-layer `tool_authorizations` enforcement (Reply posts to Google, so this can't be deferred), run lifecycle, replay, and parent/child. Because the substrate is built complete, the Solicitation agent inherits it for free.
- **Reply (M2) is the spine and goes first**, validated by golden-replay against today's outputs.
- **Solicitation (M3) is built in V1 and kept launch-ready**, but its customer rollout is sequenced after Reply is stable in production. It still ships in V1, forcing channel abstraction + fan-out + consent infrastructure into the substrate.
- **Solicitation billing degrades gracefully**: until the §6.4 attribution bar is cleared it bills as a flat add-on with `review_attributed` in shadow; clearing the bar flips it to metered. No part of the platform is gated on this.

### 9.1 Mission lattice (single committed program)

```
╔═══════════════════════ V1 — one committed program ═══════════════════════╗
                    ┌──────────────────────────┐
                    │ M1 Agent Substrate        │  6-8 wks
                    │ Foundation (FULL:         │  (gate: nothing else
                    │  4-layer tool_auth,       │   starts until stable)
                    │  replay, parent/child)    │
                    └────────────┬──────────────┘
                                 │
              ┌──────────────────┼──────────────────────┐
              ▼                  ▼                       ▼
   ┌──────────────────┐ ┌──────────────────┐  ┌──────────────────────┐
   │ M2 Reply Agent   │ │ M5 Trust Dial    │  │ M3 Solicitation V1   │
   │ Migration        │ │ UX + Settings    │  │ (Email) — BUILT &    │
   │ ── THE SPINE ──   │ │ 3-4 wks          │  │ KEPT LAUNCH-READY    │
   │ 3-4 wks          │ │                  │  │ 5-6 wks              │
   └────────┬─────────┘ └────────┬─────────┘  └──────────┬───────────┘
            │  Reply stable in prod │                     │
            └───────────┬───────────┘                     │
                        │   ◄── Solicitation customer ─────┘
                        │       rollout gated on Reply
                        │       stable (built earlier,
                        │       launched here)
                        ▼
             ┌──────────────────────────┐
             │ M4 Outcome Metering +     │  4 wks
             │ Stripe (Reply + Solic.;   │  (local event ledger;
             │  Solic. shadow until §6.4 │   explicit billing periods)
             │  attribution bar clears)  │
             └────────────┬──────────────┘
                          ▼
             ┌──────────────────────────┐
             │ M6 Migration Cut-Over     │  3-4 wks
             │ Operations (FORCED,       │  (de-risked by §8.A
             │  COMMITTED)               │   shadow metering)
             └────────────┬──────────────┘
                          │
                     ═════╪═════ V1 SHIPS HERE ═════
                          │
╚══════════════════════════╪═══════════════════════════════════════════════╝
                       ┌───┴───────────────┐
                       ▼                   ▼
            ┌──────────────────┐  ┌──────────────────┐
            │ M7 WhatsApp      │  │ M8 QR + Tap-to-  │  V1.5
            │ Channel +        │  │ Rate Landing     │  parallel
            │ Compliance       │  │ Flow             │
            │ 5-6 wks          │  │ 3-4 wks          │
            └────────┬─────────┘  └────────┬─────────┘
                     └─────────┬───────────┘
                               │
                          ═════╪═════ V1.5 SHIPS HERE ═════
                               │
                       ┌───────┴───────┐
                       ▼               ▼
            ┌──────────────────┐  ┌──────────────────┐
            │ M9 POS / Booking │  │ M10 Complaint-   │  V2
            │ Event Connectors │  │ Recovery Agent   │  parallel
            │ 6-8 wks          │  │ 4-6 wks          │
            └──────────────────┘  └──────────────────┘
```

Note: M2/M3/M5 build in parallel after M1. The dashed link marks the one *launch* dependency — Solicitation is built early but its customer rollout waits for the Reply agent to be stable in production. M4 meters both agents; Solicitation outcomes stay in shadow/flat-price until the §6.4 attribution bar clears.

### 9.2 Mission scopes

> Per §9.0/§9.1, this is **one committed program**. M1 is built complete up front (Reply posts to Google, so the four-layer enforcement can't be deferred). M2 (Reply) is the spine and ships first; M3 (Solicitation) is built in V1 but its customer rollout waits for Reply to be stable; M6 (forced cut-over) is the committed destination.

| # | Mission | Duration | Customer-visible at end? | Validation contract centerpiece |
|---|---|---|---|---|
| **M1** | Agent Substrate Foundation | 6-8 wks | No | Full four-layer `tool_authorizations` enforcement + replay + parent/child boot; trust-dial 4-layer test suite passes; `AGENT_RUNTIME_ENABLED=false` keeps legacy behavior identical |
| **M2** | Reply Agent Migration | 3-4 wks | No (shadow) | Legacy Reply paths produce byte-identical outputs as agent runs (golden replay); auto-pass posts via Zernio with full audit |
| **M3** | Solicitation Agent V1 (Email) | 5-6 wks | Yes (limited) | Owner can upload list, send batch, see deliveries, track opens/clicks; consent + suppression + unsubscribe enforced |
| **M4** | Outcome Metering + Stripe | 4 wks | No (until M6) | Outcomes emit; meter calculates correctly; local event ledger survives Stripe-accepted/DB-failed retries; drift reconcile detects synthetic drift; in-app widget accurate |
| **M5** | Trust Dial UX + Owner Settings | 3-4 wks | Yes | Owner edits per-location policy; rules apply within seconds; run timeline renders historical runs with full step trace; kill-switch instant |
| **M6** | Migration Cut-Over Operations | 3-4 wks | Yes (forced migrate) | Per-account migration idempotent + retryable; comms automated; calculator accurate from shadow data |
| **M7** | WhatsApp Channel + Compliance | 5-6 wks (V1.5) | Yes | New `WhatsAppAdapter`; Meta business verification + template approval; 24h conversation window; STOP keyword + opt-in proofs |
| **M8** | QR + Tap-to-Rate Landing | 3-4 wks (V1.5) | Yes | Per-location QR + landing page; intent router (positive→Google review, negative→inbox / future Complaint-Recovery hook); no contact info required |
| **M9** | POS / Booking Event Connectors | 6-8 wks (V2) | Yes | Stripe / Square / Toast / Calendly / Acuity connectors; consent inheritance from upstream; event-triggered Outreach runs |
| **M10** | Complaint-Recovery Agent | 4-6 wks (V2) | Yes | New agent kind drops into substrate without changes; auto-detects negative reviews; orchestrates recovery offers; cross-agent suppression of Reply when active |

### 9.3 Required worker types per mission

| Worker type | Used in | Responsibility |
|---|---|---|
| `backend-substrate-worker` | M1, M2, M4, M9, M10 | TS/Node, BullMQ, Postgres.js, outbox, agent runtime internals |
| `migrations-worker` | M1, M3, M4 | Supabase migrations, RLS, partial unique indexes, gotcha-aware |
| `frontend-owner-ui-worker` | M3, M5, M6 | Next.js 14, RHF + Zod, Tailwind, Tanstack Query, owner-facing surfaces |
| `frontend-admin-worker` | M1, M5 | Admin dashboard, run inspector, policy editor |
| `billing-integration-worker` | M4, M6 | Stripe Meters API, idempotency keys, drift reconciliation, comms automation |
| `compliance-worker` | M3, M7 | Consent ledger, suppression, unsubscribe, TCPA/CASL/RFC 8058, WhatsApp templates |
| `posting-adapter-worker` | M2 (and later GBP swap) | `PostingAdapter` interface, `ZernioPostingAdapter`, error semantics, retry/idempotency |
| `messaging-adapter-worker` | M3, M7 | `MessagingAdapter` interface, `EmailAdapter` (Resend), `WhatsAppAdapter` (Meta/Twilio) |
| `connector-worker` | M9 | One connector per upstream (Stripe / Square / Toast / Calendly / Acuity) |
| `qa-validator-worker` | every mission | Programmatic + manual validation per validation contract |

### 9.4 Validation contract surfaces by mission

| Mission | Programmatic surface | Manual / browser surface |
|---|---|---|
| M1 | Vitest unit + integration on substrate; outbox-driven flow tests | Admin run inspector (Playwright) |
| M2 | Golden-replay tests vs. legacy responses; subscription guard semantic tests | Approval page flow (existing E2E suite extended) |
| M3 | Email send/bounce/unsubscribe lifecycle; consent enforcement | List import wizard, batch composer, owner sees deliveries |
| M4 | Idempotent meter sync with synthetic drift; allotment math exhaustive | In-app meter widget across `pricing_model` values |
| M5 | Policy rule evaluation matrix; kill-switch instant | Trust dial editor, run timeline page |
| M6 | Per-account migration idempotency + rollback | Comms preview pages, calculator widget |

### 9.5 Critical mission interlocks

1. **M1 (full substrate) before M2/M3/M5.** Substrate is the gate; it's built complete because Reply posting needs the four-layer enforcement on day one.
2. **M2 (Reply) is the spine and reaches production-stable before M3 (Solicitation) is rolled out to customers.** M3 is *built* in parallel but its customer launch waits for Reply stability — don't put two new behaviors in front of owners at once.
3. **M2 + M3 emitting outcomes before M4 meters them.** Otherwise the meter is a forecast, not data.
4. **M4 live in shadow ≥30 days before M6.** Per §8.A two-axis migration — this shadow window *is* the willingness-to-pay de-risking; pricing is tuned here, not gated.
5. **M5 (trust dial UI) live before M6.** Owners need it to set policy before auto-pass becomes meaningful.
6. **Solicitation `review_attributed` billing stays in shadow/flat-price until the §6.4 attribution bar clears** — independent of the migration timeline.
7. **M7-M10 strictly post-V1.** No early WhatsApp work — that's how V1 scope creeps.

### 9.6 Optional missions / known follow-ups

- **GBP API integration** when GBP access granted. Likely 2-3 weeks; PostingAdapter interface from M2 makes this straightforward.
- **Insights Agent** (V3): review-theme analysis + operational suggestions. Needs vector store, intentionally deferred.
- **Ranking Agent** (V3): Google Maps ranking influence. Distinct enough to deserve its own substrate-eval round.
- **Marketplace / SDK** (V4+): third-party agents on the platform. Massive; revisit after V2 with three durable first-party agents in production.

### 9.7 Mission-level governance

- **M1 first, then M2 (Reply) as the spine.** Parallelism increases after M1 is stable; M3/M5 build alongside M2 but M2 reaches production-stable first.
- **Each sub-mission gets its own brainstorming + writing-plans cycle.**
- **Validation contract assertions per-sub-mission.** No mission inherits another's assertions.
- **Cross-mission shared knowledge** lives in `docs/superpowers/saas-2-0/`: architecture diagrams, glossary, decisions log, integration test fixtures.

---

## 10. Decisions log (for downstream missions)

Distilled list of architectural decisions made during this brainstorm that downstream sub-mission plans MUST honor:

0. **One committed program (§0.1).** V1 converts RepWorth into a team of per-outcome-billed agents and commits to the forced pricing migration (§8) as the destination. Reply is built first (the spine); Solicitation is built in V1 and kept launch-ready but rolled out to customers after Reply is stable. The willingness-to-pay risk is de-risked operationally through the §8.A shadow-metering + founders-ring phases (tune pricing before T-0), **not** by an off-ramp that shelves the platform. The moat is the vertical, not being first to outcome pricing. (Supersedes the earlier two-program / validation-gate framing.)
1. Substrate is Approach 1 (tool-using agents over explicit step graph) — not Approach 2 (free-form LLM loops) or Approach 3 (workers + outbox + policy table).
   - **1a. (OPEN) In-house run engine vs. hosted durable execution.** Approach 1's run lifecycle (start/advance/halt/resume) + replay + parent/child is a durable-workflow engine. Early in M1, run the §11 spike comparing in-house (BullMQ + outbox) vs. Temporal/Inngest hosting the step graph while Postgres outbox keeps side-effect transactionality. Resolve 1a before committing the bulk of M1's run-engine build.
2. Every side effect flows through `tool-runner.ts` — single chokepoint.
3. `job_outbox` is the only event substrate (no second event bus).
4. Trust dial is the **single source of truth** for autonomy; enforced through `tool_authorizations` at four layers (graph topology, runtime check, DB **trigger** — not a `CHECK`, since the invariant is cross-row, see §4.1 Layer 3 — and RLS / provider-boundary controls). The full four-layer enforcement ships in M1 up front, because the Reply agent posts to Google on day one. Solicitation email sends and outcome emission run through the same enforced tool-runner path.
5. Default policy at migration: `hold_for_approval everywhere`.
6. Pricing: subscription floor + outcome overage. Single column toggle `accounts.pricing_model` + audit table `account_pricing_history`.
7. Migration: two-axis state model with `(legacy, outcome)` forbidden by DB CHECK constraint.
8. DB is source of truth for outcomes; Stripe is recipient. Never read usage from Stripe to make decisions.
9. Hourly Stripe meter sync; customer-visible widget reads DB directly; outbound Stripe submissions are tracked in `outcome_meter_events`.
10. Parent/child agent runs supported from V1 via `agent_runs.parent_run_id`.
11. Solicitation V1 = two agents (Batch + Outreach). Outreach is the reusable durable unit.
12. Solicitation V1 headline billable outcome: **`review_attributed`** (the outcome the owner buys), subject to a billing-quality gate on attribution precision (§6.4, §11 M3). `solicitation_sent` is metered for floor/deliverability caps only — **not** the overage unit — so our incentive is reviews gained, not emails sent. Until the attribution bar clears, Solicitation bills as a flat add-on with `review_attributed` recorded in shadow; clearing the bar flips it to metered. This affects *how Solicitation bills*, not *whether the platform ships*. (Reverses the original brainstorm, which billed `solicitation_sent`.)
12a. Cross-agent coordination primitive (`agent_runs.coordination_key` + partial unique index, §3.1/§3.4) ships in V1's migration 042 but is inert until V2 Complaint-Recovery consumes it. Coordinated agents must claim the same subject key at run start; read-only conflict checks are not sufficient. The "drop-in new agent, no substrate change" claim (principle #3) holds for independent agents; coordinated agents use this primitive.
13. `PostingAdapter` interface with `ZernioPostingAdapter` V1. `GbpPostingAdapter` later via flag.
14. `MessagingAdapter` interface with `EmailAdapter` V1. `WhatsAppAdapter` in V1.5.
15. No LLM-driven policy decisions in gates (gate logic pure-function; classifications may be LLM-generated).
16. No vector store, no generic memory store, no "force-post" override token in V1.
17. Existing workers (`ResponseGeneratorWorker`, `NotificationWorker`, `ResponsePublisherWorker`, `ReviewSyncWorker`, `NotificationFailoverPoller`, `EngagementMonitorPoller`, etc.) are wrapped, not deleted. Decommissioned only in Phase 5 (~60-90 days after Phase 3 stable).
18. Forced migration with 60-day notice, founders ring first. No "self-service downgrade back to tier" post-migration.
19. UUIDv7 IDs, `account_id` + `business_id` scoping, Postgres.js for writes, `@supabase/supabase-js` for reads/auth — existing conventions inherited.
20. Each sub-mission has its own spec → plan → mission cycle; this document is the meta-design, not a single mission spec.

---

## 11. Open questions for sub-mission planning

These are deliberately not resolved here — they belong in the sub-mission brainstorming for the specific mission they affect.

- **M1**: Exact API shape for the `tool` registration interface. Whether `policy_gate` decisions are cached per-run or always re-queried.
- **M1 (one-week spike, decision 1a)**: In-house run engine on BullMQ+outbox vs. hosting the step graph on Temporal/Inngest (keeping Postgres outbox for side-effect transactionality). Evaluate specifically against the held-for-approval → resume flow and replay. Run early in M1, before committing the bulk of the run-engine build.
- **M3 (Solicitation billing quality)**: Is the `review_attributed` fuzzy-match model trustworthy enough to *bill* on? Define the precision bar, minimum manual-review sample, owner-facing evidence, duplicate/organic-review handling, and dispute/credit path. Until it's billable-grade, Solicitation bills as a flat add-on with attribution in shadow — never a silent fallback to billing sends.
- **M2**: Whether the golden-replay test harness compares full response text or normalized text (the LLM may produce slightly different output run-to-run; replay tests need a similarity threshold).
- **M3**: Exact CSV format for list import. Whether `paste` import requires a CAPTCHA / rate limit. Whether the `personalize_message` LLM call uses a separate cheaper model than Reply.
- **M4**: Stripe Meters vs. legacy Usage Records API (depending on Stripe version available). Exact idempotency-key window granularity.
- **M5**: Whether the run timeline supports filtering by step kind / tool slug / policy decision in V1 or just shows a chronological list.
- **M6**: Whether the calculator widget shows a confidence interval on projected bills, or just a point estimate.

---

## 12. Acceptance criteria for this meta-design

This document is considered accepted when:

1. The user has reviewed Sections 0-10 and signed off (no outstanding pushback), **including the §0.1 single-program framing: committed forced migration, Reply first, Solicitation built and kept launch-ready.**
2. Section 11 is acknowledged as the correct set of open questions to defer to sub-missions (not as blockers to starting M1).
3. The user has confirmed the next step is the **M1 (Agent Substrate Foundation)** implementation plan — the full substrate that unblocks M2 (Reply, the spine), with M3 (Solicitation) and M5 (Trust Dial) building alongside. The forced migration (M6) is committed as the destination, not re-decided later.
4. The pricing-tuning success targets used in the §8.A shadow window (e.g. median projected bill within ±X% of today's tier revenue) are flagged for freezing before the founders ring — they tune pricing, they do not gate whether the platform ships.

Once accepted, this document becomes the source of truth for downstream sub-mission specs. Subsequent specs reference Section 10 (decisions log) and Section 9 (mission decomposition) as inputs.
