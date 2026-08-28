# Agentic architecture & MCP strategy (roadmap view)

This file does three things: (1) states the agent-architecture **principles**
RepWorth already follows, so future phases don't violate them; (2) maps the
2026-08-26 research memo's proposed architecture onto what exists — the memo
proposed, almost box-for-box, the system that is already built; (3) owns the
sequencing of the **future** agentic work (the run-engine expansion, autonomy
routing, and the public API/MCP layer) that the forward-roadmap compresses
into Phases 5 and 8.

Engineering source of truth remains the design of record
(`docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §3, §8)
and `.claude/CLAUDE.md` invariants. This file is the strategy view.

## 1. Architecture principles (already true — treat as invariants)

1. **Agents reason; deterministic services act.** No LLM ever invents an API
   request or writes freely to the database. LLM output flows into narrow,
   validated seams (generator → moderation → approval → `ReviewPublisher`;
   triage → columns; `evaluateAsk` consumes context, never sends). Each seam
   independently enforces auth, tenancy, consent, policy, schema validation,
   rate limits, idempotency, logging, and approval requirements — this is
   invariants #2/#3/#7/#15 plus the cost guard, restated as strategy.
2. **Event-driven, not chat-driven.** The agent reacts to events (webhook
   ingest, Postgres-state pollers, time schedulers) — never waits to be
   chatted with. A conversational surface is deliberately late (§4).
3. **One orchestration spine; personas are attribution, not processes.**
   Reply/Guardian/Insights are trigger-shaped graphs over one pipeline, with
   persona attribution on run-spine steps — not free-running agents passing
   messages. New specialists are added only when specialization measurably
   improves reliability (design Decision 5 agrees with the memo here).
4. **Human-in-the-loop is a modeled state, not an interrupt hack.** Approval
   lanes, the veto window, the halt latch, and escalation acknowledge/resolve
   are all durable DB states a workflow can wait in for hours or days.
5. **Watchdogs sit above personas.** The Judge (100% of auto-posts;
   availability is a posting precondition) and the Governor (autonomous
   suspension) are structurally separate from the agents they police.
6. **Model independence.** All completions route through `runLlmTask`
   (pinned per-task models, provider fallback, circuit breaker). No customer
   record, policy, prompt, or workflow definition couples to one vendor's
   agent framework. **We do not adopt a vendor Agents SDK** — the custom
   orchestration (outbox + BullMQ + run spine) already provides durable
   execution, handoffs, and human approval, without the lock-in. The moat
   lives above the foundation models.

## 2. Memo architecture → as-built map

The memo's diagram, box by box:

| Memo box | RepWorth as built | Future extension |
|---|---|---|
| Event / Workflow layer | `job_outbox` (transactional) + BullMQ + `worker/ingress/*` + pollers/schedulers | Phase 1 adds external business events (`job.completed`, `appointment.completed`) as first-class inputs |
| Reputation Manager Agent | The persona pipeline + the **run-engine executor** (parent/child lifecycle on the run spine, Solicitation as first tenant) | New run-engine tenants per phase (recovery cases in Phase 2) |
| Brand Brain + Memory | Brand columns + voice learning from owner edits + edit-distance log | Phase 4: Business Truth + policy layer, per-draft explanations |
| Policy Engine + Permissions | `auto_policy` gate stack, trust dial, veto window, `evaluateAsk` restraint enum, `auto_approval_policies` (server-owned) | Phase 5: per-action autonomy matrix, Judge-on-withhold, Governor per-gate |
| Reputation Graph | The data accumulates already: run spine, outcomes, contacts/visits ledger, permanent review attribution, competitor snapshots | Phase 7: query layer + Impact page (read models, no new collection) |
| Deterministic tools (`reviews.list`, `responses.publish`, …) | Worker jobs + `ReviewPublisher`/`ReviewSource` seams + solicitation verbs (`approveBatch`, `haltBatch`, …) | Tool inventory hardens into the public API surface (§4) |
| Internal product ↔ MCP/API split | Internal only today | §4 below |

Conclusion the roadmap already acts on: the memo's architecture section
required **no redesign** — its genuinely new agentic work is the autonomy
routing (Phase 5) and the external interface (§4).

## 3. Future agentic work — sequence and rationale

In order, with the phase that owns each:

1. **External business events into the spine** (Phase 1). Connectors make the
   agent's world bigger: `job.completed` becomes as native a trigger as
   `new_review`. This is agentic work, not just integration work — the event
   vocabulary is the agent's future sensory input.
2. **Recovery as a run-engine tenant** (Phase 2). Long-running,
   approval-gated, multi-step workflows (open → outreach → await customer →
   resolve) exercise the executor's parent/child lifecycle beyond
   solicitation batches.
3. **Per-action autonomy matrix + Judge-on-withhold + Governor per-gate**
   (Phase 5). Autonomy stops being one dial and becomes a policy surface.
   Prerequisite: Phase 4's policy layer, so every autonomous act can cite the
   rule it followed.
4. **Calibrated-confidence router** (design §8.5 leftover; after Phase 5).
   Route each draft to the auto lane or the owner lane by calibrated
   confidence rather than category alone. Needs accumulated Judge verdicts +
   edit-distance history as ground truth — which is why it waits.
5. **Public API, then MCP server** (Phase 8; see §4).
6. **Conversational surface** ("ask RepWorth") — after the tool layer exists,
   a chat surface is a thin client over it. Not before.
7. **Agent-to-agent protocols** — explicitly deferred. MCP (agent↔tools)
   unlocks the near-term value; A2A returns only when a concrete
   RepWorth-agent ↔ customer-agent case exists.
8. **Cross-agent coordination keys, outcome billing** (design §8.5) — remain
   parked; outcome billing waits on `agent_outcomes` accumulating enough
   history to price against (design Decision 2).

## 4. Public API + MCP strategy (Phase 8 detail)

**MCP is an interface, not the agent** — and not a differentiator (Yext
shipped an MCP server 2026-06; agent access is becoming expected
infrastructure). The order is fixed: **clean internal tool layer → public
API → MCP server that wraps it.** Never expose MCP tools that don't exist as
governed internal seams first.

**Read-first exposure.** Launch tool list (draft):

```text
repworth.locations.list
repworth.reviews.list / get
repworth.insights.summary
repworth.reputation.report
repworth.responses.draft        (reversible: creates a draft, posts nothing)
```

Write operations arrive later, classed by consequence — and the classes map
onto approval machinery that already exists:

| Action class | Example | Gate (existing mechanism) |
|---|---|---|
| Read | list reviews, get report | OAuth scope only |
| Reversible / low risk | draft response, open internal task | Allowed; run-spine attributed |
| External consequential | publish response, send request | Same `auto_policy`/owner-approval lane as internal actions — an MCP caller gets **no more autonomy than the account's own policy grants** |
| High consequence | anything touching money, profile data | Explicit owner approval, always |

That last column is the strategic point: the governed-autonomy stack is what
makes a public agent surface *sellable* — an external agent inherits the
Judge, the veto window, the caps, and the audit trail for free. Auth follows
current MCP spec conventions (OAuth 2.1); every MCP-initiated action lands on
the run spine with a distinct actor attribution (extends the Channel-actor
pattern).

**Explicitly not planned:** exposing solicitation sends or publishing to
third-party agents before the internal lanes have production history; any
MCP tool that bypasses `evaluateAsk` or the approval lanes.

## 5. What we will NOT build (standing refusals)

- A vendor agent-framework migration (principle 6).
- LLMs with direct DB or external-API access (principle 1).
- Multi-agent choreography for its own sake (principle 3).
- A chat interface before the tool layer (principle 2, §3 item 6).
- Any agent capability that skips the policy engine, moderation veto, or
  audit spine — including our own future MCP tools (§4).
