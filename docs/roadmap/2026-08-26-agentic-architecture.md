# Agentic architecture, owner operator & MCP strategy (roadmap view)

Updated **2026-09-20**; filename remains stable. This page maps the August
research memo onto existing architectural seams and states the dependencies
for future agentic work. P1–P8 are stable topic identifiers, not a fixed
chronological build sequence. The forward roadmap owns current priorities.

The 2026-09-20 revision folds the former `owner-operator/architecture.md`
into §6, so framework posture has one owner. Owner Operator build and
environment status is owned by the [spec](2026-09-11-owner-operator.md)
status line; this page does not restate it.

The September 7 targeted source inspection at `4aa132b` supports extending the
existing worker/outbox system; no framework rewrite is justified. It does not prove
runtime behavior, scalability, customer value or a moat. No deployed flags,
credentials, providers or browser journeys were checked in this refresh.

Engineering source of truth remains the design of record
(`docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §3, §8)
and `.claude/CLAUDE.md` invariants. This file is the strategy view.

## 1. Architecture principles and boundaries

1. **Agents reason; deterministic services act.** No LLM ever invents an API
   request or writes freely to the database. LLM output flows into narrow,
   validated seams (generator → moderation → approval → `ReviewPublisher`;
   triage → columns; `evaluateAsk` consumes context, never sends). Auth,
   tenancy, consent, policy, validation, cost bounds, idempotency and approval
   checks belong at their applicable boundaries. A pure policy evaluator
   does not itself implement every control. Preserve invariants #2/#3/#7/#15
   and the cost-guard contract when adding entry points.
2. **Owners delegate through conversation; events and schedules drive
   execution.** A proposed owner surface turns an instruction into a visible,
   bounded operating plan using supported operations. Once authorized, work
   continues through webhook ingest, pollers and schedulers without another
   chat message. The discovery experiment is independently selectable and
   does not wait for public API/MCP demand. The first bounded form is built:
   Owner Operator v1 makes one model call per turn and produces stored
   proposals the owner applies (status: the
   [spec](2026-09-11-owner-operator.md)). No tool loop or general
   conversational runtime exists.
3. **One durable workflow system; personas are attribution, not processes.**
   Reply/Guardian/Insights are trigger-shaped graphs over one pipeline, with
   persona attribution on run-spine steps — not free-running agents passing
   messages. New specialists are added only when specialization measurably
   improves reliability (design Decision 5 agrees with the memo here).
   `src/lib/agents/run-spine.ts` explicitly owns attribution records, not a
   generic execution engine. Jobs and domain modules own execution;
   `src/lib/solicitation/outreach.ts` owns batch lifecycle. Keep new domain
   entry points typed and validate untrusted inputs at the boundary, without
   building abstractions for hypothetical callers. Reusable services reduce
   future API work; they do not supply public authentication or transport.
4. **Human-in-the-loop is a modeled state, not an interrupt hack.** Approval
   lanes, the veto window, the halt latch, and escalation acknowledge/resolve
   are all durable DB states a workflow can wait in for hours or days.
5. **Watchdogs sit above personas.** Judge review targets every auto-post
   after publication; its availability is a posting precondition, not a
   pre-publication verdict on every draft. The Governor can suspend autonomy.
   Refusal records expose decisions not to act, with coverage qualifications.
   These controls govern behavior; they do not establish an external agent's
   identity or permission to read an account's data.
6. **Model independence.** All completions route through `runLlmTask`
   (pinned per-task models, provider fallback, circuit breaker). No customer
   record, policy, prompt, or workflow definition couples to one vendor's
   agent framework. **No vendor Agents SDK by default, and none in v1** — the
   custom workflow system already provides durable jobs and human approval.
   A framework becomes a candidate only when a loop is specified, and is then
   compared against a custom bounded runner under §6.3–§6.4. The current LLM
   seam is single-shot; `src/lib/llm/types.ts` deliberately excludes tool
   calls and multi-turn loops, and carries a per-task structured-output
   contract to both providers. Add bounded planning only for a measured
   unmet task. Defensibility would need permissioned context, reliable
   delegated work and retention evidence, not an architecture label.

## 2. Memo architecture → as-built map

The memo's diagram, box by box:

| Memo box | RepWorth as built | Future extension |
|---|---|---|
| Event / Workflow layer | `job_outbox` (transactional) + BullMQ + `worker/ingress/*` + pollers/schedulers | P1 may add one justified external event source with durable event identity, replay and consent provenance |
| Reputation Manager Agent | Persona-attributed workflows; run-spine parent/child records; solicitation-specific batch/send lifecycle | P2 recovery requires its own domain lifecycle; do not claim a generic executor already exists |
| Brand Brain + Memory | Brand columns + voice learning from owner edits + edit-distance log | P4: confirmed facts/rules, owner corrections/preferences, and action/outcome evidence for the selected job; minimum context before dependent actions |
| Policy Engine + Permissions | `auto_policy` gates, trust dial, veto window, `evaluateAsk`, server-owned policies; Refusal ledger writer/read model | P5: justified per-action matrix, Judge-on-withhold, Governor per-gate |
| Reputation Graph | Run records, outcomes, contacts/visits, review attribution and competitor snapshots | P7: queries only when data answers useful questions; current records do not establish complete sales attribution |
| Deterministic tools (`reviews.list`, `responses.publish`, …) | Worker jobs + `ReviewPublisher`/`ReviewSource` seams + solicitation verbs (`approveBatch`, `haltBatch`, …); these names are conceptual, not a public tool inventory | Public authentication, API contracts, quotas and audit actors still require implementation (§4) |
| Owner-facing operator | Owner Operator v1: conversation → stored proposal cards → owner Apply → receipts, over the existing domain operations ([spec](2026-09-11-owner-operator.md) owns status). Customer value is not yet established | A loop only under §6.4; external machine access is a separate §4 decision |
| Internal product ↔ MCP/API split | Internal only today | §4 below |

Retain these seams. The system already supports bounded event-driven
automation; the next useful feature is selected from beta evidence, not from
completing every box in the memo.

## 3. Future agentic work — sequence and rationale

The [forward roadmap](2026-08-26-forward-roadmap.md) owns the immediate
selection process, provisional engineering/discovery limits, and cash gates.
Choose at most one improvement from an observed beta burden or barrier to
paying; choosing no new feature is valid. Measurement can use a worksheet
and existing records. Cash/funding preparation proceeds alongside learning.

Owner-facing work and later dependencies:

**Owner-operator v1:** specified in the
[Owner Operator spec](2026-09-11-owner-operator.md), which owns the
operation catalog (its §4) and build status. §6 below owns the durable
commitments, framework posture and seam extension. The rules here are the
summary. Add only the planning/context capability that
job requires. A model proposes a typed plan; scoped services
validate supported actions and required decisions. Store confirmed
instructions and pending decisions durably, with a version. Recheck authority
and current state at execution. A conversation is not an approval token;
inferred preferences cannot enlarge permissions.

Keep business facts, corrections and observed outcomes distinct and sourced.
Treat reviews and imported content as untrusted data. Missing facts produce a
question or a bounded refusal. Preserve cost reservations, attempt limits,
idempotency, tenant scope and action-specific approvals. Workers keep long
work and provider calls; execution stays in jobs/domain modules, not the run
spine. The selected spec defines verified completion, pending work and
failure handling. No general memory store, open-ended model loop or public
tool inventory is required.

1. **P1, external events:** only when multiple participating businesses share
   a provider and observed input burden justifies it. API access, event
   identity, tenant mapping, replay and consent must be established; existing
   CSV attestation cannot stand in for provider-event provenance.
2. **P4 minimum facts/policies → P2 recovery:** collect the verified policy and
   business facts needed before outreach, promises or compensation depending
   on them. A bounded recovery workflow needs durable states and approval,
   not a general run-engine rewrite. Full Business Truth and topic ontology
   wait for evidence; P3 need not block a simple owner-approved recovery case.
3. **P4 policy → P5 finer autonomy:** expand only the action class whose
   delegation has value and reliable failure handling. Confidence calibration
   requires representative, quality-checked verdict/edit evidence and testing;
   accumulating logs alone does not establish calibrated confidence. Owner
   decision 2026-09-20: a later stage may widen autonomy automatically, but
   only inside a ceiling the owner set explicitly. That ceiling is the
   permission, so this is not an inferred preference enlarging permissions;
   it still needs its own P5 safety design and that evidence first
   ([forward roadmap](2026-08-26-forward-roadmap.md#owner-operator-stages-beyond-version-1)).
4. **P7 reporting/query expansion:** wait for sufficient usable operational
   data. The current fixed seven-minute-per-reply estimate is not measured
   net owner savings. Inquiries, bookings and revenue need separate records;
   reviews or QR scans are not substitutes.
5. **P8 API/MCP:** conditional read-only pilot under §4, with no automatic
   trigger after P2. A2A remains a separate demand/capacity decision. The
   owner-operator candidate does not wait for external machine access; a
   software slice still needs its own interaction, authorization and failure
   handling, and a complete conversational platform does not fit the first cap.
6. **Scale and billing:** outcome billing remains parked until definitions,
   attribution, costs and commercial terms support it. Wider worker
   replication/concurrency requires coordination and load evidence; the
   existing guard in `worker/config/startup-assert.ts` is per process and
   assumes one replica.

Non-Google support is a separate P6 implementation/access decision.
`ReviewSource` still takes `placeId`, `ReviewIdentity` lists only SerpAPI/Zernio,
and the publisher constructs Zernio while retaining provider-specific errors.
Monitoring, requesting and replying must each be checked against the target
platform's current access and policy requirements before promising support.

## 4. Public API + MCP strategy (P8 detail)

**MCP is an interface, not the agent.** Interface compatibility does not
establish customer demand or defensibility. The dependency is **governed
internal services → authenticated public API → MCP adapter**. Neither the
API nor its authentication is a free wrapper around owner browser routes.

**Timing (revised 2026-09-07):** a strictly read-only pilot needs a named user
or integration with a repeated task, accessible test client, acceptance
criteria and available capacity. P2 completion is not authorization or a
scheduling trigger. No current need is established by this page. Validate the
current MCP transport/authorization specification when implementation is chosen;
generic ecosystem statistics do not decide this investment.

**Identity is missing work.** Current `src/lib/auth/resolve-owner-scope.ts`
resolves an owner session and selected-location cookie. External agents need
distinct machine-actor credentials, owner-authorized account-scoped OAuth
grants, explicit tenant/location/resource scope, token validation and
lifecycle, revocation, quotas and audit attribution. Add negative tenant/access
tests before any pilot. Do not pass owner cookies or service-role credentials
to a third-party agent. Judge, veto windows and policy grants govern an
authorized action; none authenticates the caller or authorizes a data read.

**Candidate read-only pilot tools** (not implemented/public commitments):

```text
repworth.locations.list
repworth.reviews.list / get
repworth.insights.summary
repworth.reputation.report
```

Summary/report reads return existing authorized data, without triggering new
generation. **`responses.draft` is a write and can incur LLM cost** even if it
publishes nothing, so it is excluded from the read-only pilot.

Future action classes retain both new external-access controls and applicable
internal controls; this table is a requirement, not an as-built claim:

| Action class | Example | Required gate |
|---|---|---|
| Read | list reviews, get existing report | Valid machine identity, account/resource grants, tenant checks, revocation, quotas and access audit |
| State-changing, internal | draft response, open internal task | Separate write scope, schema validation, idempotency and actor attribution; drafting also respects subscription and cost reservation |
| External consequential | publish response, send request | All external-access controls plus applicable owner/auto-policy approval, moderation, consent, veto, caps and watchdog checks; no extra autonomy for an MCP caller |
| High consequence | money or profile changes | Explicit owner approval plus a separately designed and reviewed capability; absent from the pilot |

Existing governance is reusable only after each external entry point is wired
and tested against it. Define machine actor attribution deliberately; do not
confuse persona attribution on the run spine with caller identity, or invent
business outcomes for read requests. Evidence must include access revocation,
wrong-account/location attempts, retries and applicable cost/publish gates.

**Explicitly not planned:** exposing solicitation sends or publishing to
third-party agents before the internal lanes have production history; any
MCP action that bypasses controls applicable to it. Reads require access
checks and access records, not solicitation eligibility or reply moderation.

## 5. What we will NOT build (standing refusals)

- A vendor agent-framework migration for its own sake, or any framework
  adopted without the §6.3–§6.4 comparison (principle 6).
- LLMs with direct DB or external-API access (principle 1).
- Multi-agent choreography for its own sake (principle 3).
- A conversational action without a governed domain operation and applicable
  authorization. An external API/MCP layer is not a prerequisite for the
  internal experiment.
- Any agent capability that skips the access, policy, moderation, or audit
  requirements applicable to that action, including future MCP tools (§4).

## 6. Owner Operator: durable commitments and framework posture

_Written 2026-09-11 as `owner-operator/architecture.md`; folded into this
page 2026-09-20. Companion to the [v1 spec](2026-09-11-owner-operator.md)._

### 6.1 The durable commitment

RepWorth owns business state, authorization, execution policy, and evidence
of outcomes. Everything else is replaceable tooling. Concretely:

- **Business state** lives in Postgres: settings, facts, proposals, receipts, conversations.
- **Authorization** is checked at every protected boundary and revalidated inside the transaction that applies a change (spec §7).
- **Execution policy** is the existing engine: outbox, worker jobs, approval gates, moderation veto, Judge, Governor, cost guard.
- **Evidence** is the receipt and the run spine, never the assistant's prose.

The model proposes and interprets. The server authorizes and executes. The
owner holds the ceiling.

### 6.2 The operation catalog

`src/lib/agents/operator/catalog.ts` is the one place operations are
defined, and spec §4 owns the inventory; this page does not copy it. The
durable rule is the split, not the list: the model may call operations that
read, propose, prepare or capture; it may never call the owner commands
(Apply, Decline) that consume independently established owner approval and
execute a stored proposal. Kinds are separated by TypeScript type and
validated at runtime.

The catalog has versioned contracts, not a frozen shape. Each operation
declares a `contract_version`; a stored proposal carries it and is rejected
as `contract_changed` after a deploy that bumps it. Settings freshness is a
separate token (spec §6.2). The catalog and lifecycle may change in later
phases for their own reasons; nothing here promises otherwise.
The same domain operations serve settings forms, v1 proposal cards,
conversational tools later, and an external MCP surface if one is
justified (§4). Each consumer gets its own actor model and permission check.

### 6.3 Framework posture

"No framework for v1" is a decision, not a claim that frameworks cannot
fit. v1 needs one model call that produces a proposal, then an
owner-authorized operation. It does not need an agent loop.

| Option | What is true | Position for RepWorth |
|---|---|---|
| Custom bounded runner | Smallest surface. Everything integrates with existing fallback, cost guard, outbox. | v1 has no loop at all. First candidate when a loop is needed. |
| OpenAI Agents SDK | Runs inside the app. Supports non-OpenAI models through adapters. Tracing is configurable. | Legitimate candidate when a loop is needed. Compare integration cost against the custom runner then. Fallback, accounting, and approvals still need deliberate integration. |
| LangGraph | Graph execution and checkpointing. Checkpoints can live in Postgres. Different purpose from the outbox (delivers work) and the run spine (records attribution). | Defer. Consider if durable branching, interruptions, and multi-step recovery become substantial. Decide explicitly which system owns execution progress. |
| Claude Managed Agents | Anthropic hosts orchestration and a per-session container. Custom tools can execute in the app and return results. | Defer. Changes the Railway execution boundary and adds a vendor-managed session lifecycle. Larger decision than v1 needs. |
| Vercel eve | Durable sessions and workflow runtime. Can self-host. | Defer. A substantial runtime; not required by v1. |

Whatever is chosen, principle 6 holds: no customer record, policy, prompt or
workflow definition couples to one vendor's framework. Repo precedent, the
August 2026 research
(`docs/plans/2026-08-09-multi-agent-architecture-research.md`): promote a
workflow to a tool-looping agent only when its steps cannot be predicted and
an eval shows it beats the simpler workflow enough to pay for cost, latency,
and failure surface.

### 6.4 What a later loop would need

A reliable runtime is more than its loop. Before any loop ships, the spec
for it must answer:

- Persisted progress and tool-result recovery after a crash.
- Idempotent operations and accurate receipts per step.
- Step, time, and spend limits that survive job retries.
- Accounting for failed and fallback model attempts.
- A durable waiting state while approval is pending.
- A policy for overlapping owner messages and cancellation.

Those are the requirements a framework comparison measures against. RepWorth
owns the business rules; it need not hand-write every orchestration
mechanism.

### 6.5 The LLM seam

`runLlmTask` accepts system plus user and returns one completion. Since
Run C (#1278) a task may register an output schema, which reaches OpenAI
(`response_format`) and Anthropic (`output_config.format`) and is validated
again locally. Tool calls, streaming, and multi-turn loops are deliberately
absent. v1 added one task, `owner_operator`, on that path.

A future tool-call contract must round-trip: tool-call IDs, results, stop
reasons, usage, and provider-specific continuation blocks. Provider fallback
mid-conversation is untested and the two providers' conversation formats are
not interchangeable by default. That extension is real work. Add it when a
demonstrated workflow requires it.

### 6.6 History versus context

Store an append-only event history for audit and recovery. Build the model
context from it deliberately and bounded, preserving any provider-required
data. Prompt caching depends on a stable serialized prefix, not on
append-only rows. Long conversations must not grow cost and latency without
limit.

### 6.7 What a loop changes, and what it does not

A loop by itself requires no change to: the catalog, proposals and receipts,
the lifecycle, authorization at every boundary, the outbox and worker, cost
guard, provider fallback, the run spine, the Operator screen and its polling
contract. (Each may still change for its own reasons under §6.2's versioned
contracts.)

A loop does change: the turn handler (one call becomes a bounded loop), the
seam (tool-call contract), context construction (events plus bounded context
per step), plus the runtime requirements in §6.4. The loop changes how the
model reasons between calls; it does not change who is allowed to write. The
size of that work is estimated when the loop is specified against §6.4, not
here.
