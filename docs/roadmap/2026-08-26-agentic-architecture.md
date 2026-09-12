# Agentic architecture, owner operator & MCP strategy (roadmap view)

Updated **2026-09-11**; filename remains stable. This page maps the August
research memo onto existing architectural seams and states the dependencies
for future agentic work. P1–P8 are stable topic identifiers, not a fixed
chronological build sequence. The forward roadmap owns current priorities.

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
   does not wait for public API/MCP demand. This is a direction; no
   conversational runtime exists today.
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
   agent framework. **We do not adopt a vendor Agents SDK** — the custom
   workflow system already provides durable jobs and human approval. The
   current LLM seam is single-shot; `src/lib/llm/types.ts` deliberately excludes
   tool calls and multi-turn loops. Add bounded planning only for a measured
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
| Owner-facing operator | Existing owner UI and domain operations; the proposed conversational journey is not established as built | Bounded internal experiment under §3; external machine access is a separate §4 decision |
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

**Owner-operator v1:** specified in
[owner-operator/README.md](2026-09-11-owner-operator/README.md) with its
[architecture page](2026-09-11-owner-operator/architecture.md) as the
detailed owner of catalog kinds, framework posture and seam extension. The
rules below are the summary. Add only the planning/context capability that
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
   accumulating logs alone does not establish calibrated confidence.
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

- A vendor agent-framework migration (principle 6).
- LLMs with direct DB or external-API access (principle 1).
- Multi-agent choreography for its own sake (principle 3).
- A conversational action without a governed domain operation and applicable
  authorization. An external API/MCP layer is not a prerequisite for the
  internal experiment.
- Any agent capability that skips the access, policy, moderation, or audit
  requirements applicable to that action, including future MCP tools (§4).
