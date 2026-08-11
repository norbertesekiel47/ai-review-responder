# RepWorth multi-agent architecture research

**Research date:** 2026-08-09  
**Scope:** Architecture assessment only; no implementation proposal or code changes.  
**Method:** RepWorth's design of record was compared with official vendor documentation, standards, and original research. Vendor guidance is treated as experience-based guidance, not neutral proof; benchmark results are treated as task-specific evidence, not universal laws.

## Verdict

The proposed direction is **mostly right, with one important correction**:

> Build a hierarchy of domain ownership, not a mandatory hierarchy of LLM calls.

RepWorth should have isolated Reviews, Solicitation, Social, and—if it eventually owns independent CRM workflows—CRM domains. Each domain should own its prompts, tools, policy additions, evals, and run attribution. But known webhook topics, cron jobs, and queue events should be dispatched by deterministic code. A global LLM “RepWorth Agent” is justified later for an ambiguous, conversational, genuinely cross-domain request; it is not justified as a toll booth in front of every background job.

That is consistent with both the research and RepWorth's accepted design. Anthropic distinguishes workflows (predefined code paths) from agents (the model dynamically controls process and tool use), recommends adding complexity only when simpler approaches fall short, and reserves orchestrator-workers for tasks whose subtasks cannot be predicted in advance. Routing is appropriate only when categories are distinct and classification can be accurate. [Anthropic, *Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents). OpenAI similarly recommends maximizing a single agent first and splitting only when complicated instructions or tool confusion produce measured failures. [OpenAI, *A practical guide to building agents*](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/).

## What this means for RepWorth

| Capability | Recommended runtime shape | Why |
|---|---|---|
| Review ingest, Reply, Guardian | Keep the shipped `review_handler`-shaped deterministic workflow; permit bounded model calls inside steps | Reply and Guardian share a trigger and subject. The design record already concluded that separate concurrent agents add coordination and profile-write races for no product benefit. |
| Guardian triage | Deterministic star routing plus one bounded classifier where needed | The as-built design already improved on “LLM every time”: only the negative lane invokes triage. |
| Insights | Scheduled workflow; an LLM may summarize bounded inputs | Cadence and steps are known; there is no open-ended plan to discover. |
| Solicitation | Its own domain/run kind; workflow in watch/send paths, agentic only where step selection genuinely varies | It has independent triggers, state, consent/suppression policy, long waits, and fan-out, so domain separation is real. |
| CRM lookup for a review | Initially a read-only Reviews tool, not automatically a top-level CRM agent | Looking up an order to draft one reply is a Reviews subtask. CRM becomes a peer domain only when RepWorth owns independent CRM outcomes/triggers. |
| Social publishing | Separate domain specialist when built | It has distinct channels, content policy, cadence, APIs, side effects, and eval distribution. |
| Future “chat with RepWorth” | Thin manager/router over domain specialists | This is where intent can be ambiguous, cross-domain synthesis matters, and one user-facing agent should retain context. |

OpenAI's orchestration documentation explicitly says code orchestration is more deterministic and predictable in speed, cost, and performance; model orchestration is for open-ended tasks. It distinguishes manager/agents-as-tools (one agent owns the final answer) from handoffs (a specialist takes over the conversation). [OpenAI Agents SDK, *Agent orchestration*](https://openai.github.io/openai-agents-js/guides/multi-agent/). For RepWorth's event plane, the event type already supplies the routing label, so adding an LLM router would manufacture nondeterminism. For a future conversational surface, the manager pattern is a good fit.

This preserves the core conclusion in the [design of record §§1, 3, 5, and 8](../future-plans/2026-07-01-agentic-reputation-platform-design.md): event-driven bursts over the outbox/BullMQ substrate; personas as attributed steps over trigger-shaped graphs; no free-form model control over public side effects; and Judge/Governor above the persona layer. The July as-built overlay also matters: Reviews safety and run attribution are already shipped and staging-proven, while the Solicitation run engine is shipped in watch mode. A new global supervisor should not replace those working boundaries.

## Routing reliability and failure modes

A router is a new prediction surface, not plumbing. OpenAI's evaluation guidance says multi-agent triage and handoff introduce additional nondeterminism and that the choice to adopt multi-agent architecture should be driven by evals. It calls out handoff accuracy, tool selection, and tool-argument precision as distinct evaluation targets. [OpenAI, *Evaluation best practices*](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

Therefore:

- Route typed events by an exhaustive, versioned domain/topic map. Unknown topics fail closed to a dead-letter/manual lane.
- If a conversational model router is added, give it `unknown`/`needs_clarification` and `multi_domain` outcomes. Do not force every request into exactly one specialist.
- Evaluate the router independently with a domain confusion matrix, abstention precision/recall, ambiguous multi-domain cases, out-of-distribution inputs, prompt injection, and specialist-unavailable cases.
- Carry structured dispatch context, not a prose-only handoff: tenant, account/location, subject, requested action, source event, authorization context, and causal run ID.
- Bound delegation depth, turns, fan-out, retries, and total run spend. Detect loops and duplicate work.

The risk is material. In Anthropic's production research system, early orchestrators spawned excessive workers, duplicated searches, left gaps, chose wrong tools, and over-invested in simple tasks; detailed delegation contracts and explicit effort limits were required. That system succeeds specifically on breadth-first, parallelizable research, while Anthropic says dependent/shared-context domains are a poor fit. [Anthropic, *How we built our multi-agent research system*](https://www.anthropic.com/engineering/multi-agent-research-system). A controlled 2025 benchmark study likewise found topology-dependent error amplification and reported that multi-agent variants degraded sequential reasoning tasks by 39–70%; centralized coordination helped parallelizable tasks. These are benchmark results, not a RepWorth forecast, but they argue against treating “more agents” as a default. [Kim et al., *Towards a Science of Scaling Agent Systems*](https://arxiv.org/abs/2512.08296).

## Guardrails: separate assurance from enforcement

“Watchdogs wrap every outward action” is the right intuition, but Judge and Governor should not be treated as two interchangeable guardrail agents:

- **Deterministic enforcement plane:** authentication/authorization, tenant scope, tier and feature gates, moderation hard veto, action-risk tier, daily/autonomy budgets, approval state, freshness/current-state checks, and idempotency. This plane decides whether an action intent may be committed.
- **Judge:** semantic assurance evidence. It can review draft/action quality and trigger a hold or suspension, but it is probabilistic and must be calibrated against humans.
- **Governor:** deterministic actuator over measured outcomes. It changes autonomy state when frozen thresholds are crossed.
- **Human control:** approval for high-risk actions, veto/undo where feasible, and escalation when a model or dependency is inconclusive.

OpenAI recommends layered guardrails alongside ordinary authentication, authorization, access control, and software security, and recommends human oversight for sensitive, irreversible, or high-stakes tools. [OpenAI, *A practical guide to building agents*](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/). A useful concrete warning is in OpenAI's own SDK: chain input guardrails apply only to the first agent, output guardrails only to the final agent, and tool guardrails do not automatically cover handoffs, hosted/built-in tools, or agents-as-tools. [OpenAI Agents SDK, *Guardrails*](https://openai.github.io/openai-agents-python/guardrails/). Thus “every agent has the guardrail prompt” is not non-bypassable. Every external write needs one narrow, code-owned policy/enqueue gateway with scoped credentials; model workers should only propose actions.

Also, the as-built Judge is stronger on **availability** than the original design—unavailability halts new auto-posting—but its verdict is still post-hoc. Availability as a posting precondition is not the same as approving the particular content before it posts. Riskier future actions (negative-review recovery, consequential CRM writes, social campaigns) need an explicit action-class policy deciding whether review is pre-action, post-action, owner-approved, or prohibited. Not every CRM field update needs an LLM Judge; action risk should determine the guardrail set.

Finally, an LLM Judge is not ground truth. The MT-Bench paper found position, verbosity, self-enhancement, and reasoning biases in model judges, despite strong aggregate human agreement. [Zheng et al., *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*](https://arxiv.org/abs/2306.05685). Judge false-negative/false-positive rates and human agreement must therefore be measured by action class and model/prompt version.

## Durable side effects and outbox semantics

The plan is correct that side-effecting tools must enqueue through `job_outbox`, but the exact guarantee matters:

> The transaction atomically commits business state plus the **intent** to perform an external action. It cannot atomically commit the external provider's side effect.

The relay can crash or retry after the provider acted, so delivery remains at-least-once in practice. AWS's transactional-outbox guidance explicitly requires the domain update and outbox row in one transaction, warns that duplicate messages can occur, and requires idempotent consumers and preserved ordering. [AWS Prescriptive Guidance, *Transactional outbox pattern*](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). Provider-supported idempotency should be used where available; Stripe, for example, documents idempotency keys specifically for safely retrying writes without duplicating operations. [Stripe API, *Idempotent requests*](https://docs.stripe.com/api/idempotent_requests).

For every new domain action, define: stable action/idempotency key; dedupe scope; retry classification and limit; ordering key; stale-intent/current-state recheck; reconciliation after ambiguous provider responses; compensation/undo where possible; and immutable linkage from proposal → policy decision → outbox intent → provider receipt. A specialist never receives provider write credentials except through the constrained executor.

## Evals, observability, and cost

The existing run spine is the correct foundation. Extend the conceptual trace across:

`source event → dispatch decision → domain run/step → model/tool calls → policy/Judge/Governor/approval decisions → outbox intent → delivery attempts → provider receipt → outcome`

At minimum, record versioned domain kind, router version and confidence/abstention, prompt/policy/model versions, tool and action class, guardrail outcomes, parent/child causal IDs, token/cost reservation and finalization, retry/latency, outbox key, and external receipt—without logging customer content or secrets.

Evaluation should have four layers:

1. Router/handoff contract evals.
2. Per-domain capability and regression suites.
3. Deterministic policy/outbox/idempotency/tenant-isolation tests.
4. End-to-end outcome and safety evals against production-shaped cases.

OpenAI recommends trace grading specifically to test tool choice, handoff correctness, instruction/policy violations, and routing changes, followed by repeatable datasets. [OpenAI, *Evaluate agent workflows*](https://developers.openai.com/api/docs/guides/agent-evals). Anthropic recommends combining code-, model-, and human-based graders; it notes that model graders require human calibration and that evals establish baselines for latency, token use, cost per task, and errors. [Anthropic, *Demystifying evals for AI agents*](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

Cost must be hierarchical as well as per-call. Every LLM call should retain RepWorth's reserve/finalize guard, but a parent run also needs a total budget covering router, specialist, Judge, retries, and fan-out. Otherwise individually valid reservations can still create an unbounded aggregate run. Anthropic reports roughly 4× chat-token use for agents and 15× for its multi-agent research system; the comparison is to chat, not to RepWorth's current pipeline, but it demonstrates the magnitude that parallel delegation can create. [Anthropic, *How we built our multi-agent research system*](https://www.anthropic.com/engineering/multi-agent-research-system). The existing Upstash dependency consequently becomes more stressed, not less, if every event gains router and reviewer calls.

## Recommended adoption rule

Adopt the user's proposal in this form:

1. Keep one deterministic application control plane and one non-bypassable write-policy/outbox gateway.
2. Create domain-owned specialist modules as each real domain ships; do not pre-build empty agents.
3. Promote a workflow node to a tool-looping agent only when its steps cannot be predicted and an ablation/eval shows it beats the simpler workflow on quality enough to pay for added cost, latency, and failure surface.
4. Keep Reviews' Reply/Guardian/Insights personas as internal attributed capabilities, as the design record specifies.
5. Add a user-facing cross-domain “RepWorth Agent” only when real conversational, cross-domain tasks exist. It should route and synthesize, never authorize side effects.

So: **yes to hierarchical domain specialization, least agency per node, and cross-cutting guardrails; no to a universal LLM supervisor on the event plane.** That refinement preserves feature isolation without weakening the deterministic safety architecture RepWorth has already built and proven.
