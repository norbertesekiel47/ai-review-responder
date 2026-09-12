# Owner Operator: architecture and framework posture

_Written 2026-09-11. Companion to [README.md](README.md) (the v1 spec) and [vision.md](vision.md)._

## 1. The durable commitment

RepWorth owns business state, authorization, execution policy, and evidence
of outcomes. Everything else is replaceable tooling. Concretely:

- **Business state** lives in Postgres: settings, facts, proposals, receipts, conversations.
- **Authorization** is checked at every protected boundary and revalidated inside the transaction that applies a change (spec §7).
- **Execution policy** is the existing engine: outbox, worker jobs, approval gates, moderation veto, Judge, Governor, cost guard.
- **Evidence** is the receipt and the run spine, never the assistant's prose.

The model proposes and interprets. The server authorizes and executes. The
owner holds the ceiling.

## 2. The operation catalog

`src/lib/agents/operator/catalog.ts` is the one place operations are
defined. Three kinds, separated by TypeScript type and validated at runtime:

| Kind | Model may call | Effect |
|---|---|---|
| Read | yes | Returns authorized, scoped information. |
| Proposable change | yes | Describes one permitted mutation and produces a stored proposal. Never executes. |
| Apply | **no** | Consumes independently established owner approval and executes a stored proposal. |

The catalog has versioned contracts, not a frozen shape. Each operation
declares a `contract_version`; a stored proposal carries it and is rejected
as `contract_changed` after a deploy that bumps it. Settings freshness is a
separate token (spec §6.2). The catalog and lifecycle may change in later
phases; nothing here promises otherwise.
The same domain operations serve settings forms today, proposal cards in
v1, conversational tools later, and an external MCP surface if one is
justified. Each consumer gets its own actor model and permission check.

## 3. Framework posture

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

Repo precedents: architecture principle 6 (model independence, no vendor
Agents SDK by default) and the August 2026 research
(`docs/plans/2026-08-09-multi-agent-architecture-research.md`): promote a
workflow to a tool-looping agent only when its steps cannot be predicted and
an eval shows it beats the simpler workflow enough to pay for cost, latency,
and failure surface.

## 4. What a later loop would need

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

## 5. The LLM seam

Today `runLlmTask` accepts system plus user and returns a simplified
completion. Tool calls, streaming, and multi-turn loops are deliberately
absent. v1 keeps that path intact and adds one task, `owner_operator`.

A future tool-call contract must round-trip: tool-call IDs, results, stop
reasons, usage, and provider-specific continuation blocks. Provider fallback
mid-conversation is untested and the two providers' conversation formats are
not interchangeable by default. That extension is real work. Add it when a
demonstrated workflow requires it.

## 6. History versus context

Store an append-only event history for audit and recovery. Build the model
context from it deliberately and bounded, preserving any provider-required
data. Prompt caching depends on a stable serialized prefix, not on
append-only rows. Long conversations must not grow cost and latency without
limit.

## 7. What changes, and what does not, when a loop arrives

Unchanged: the catalog, proposals and receipts, the lifecycle, authorization
at every boundary, the outbox and worker, cost guard, provider fallback, the
run spine, the Operator screen and its polling contract.

Changed: the turn handler (one call becomes a bounded loop), the seam
(tool-call contract), context construction (events plus bounded context per
step), plus the runtime requirements in §4. The loop changes how the model
reasons between calls; it does not change who is allowed to write. The
size of that work is estimated when the loop is specified against §4, not
here.
