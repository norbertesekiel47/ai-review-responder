# Investor theses and validation plan

Originally recorded 2026-08-29. **Revised 2026-09-07** after the founder interview.
The filename is retained so existing references continue to work.

The founder heard three themes at investor events: sell outcomes, build for
agents, and explore work that recent AI advances make possible. **No investor
has assessed RepWorth yet.** These themes are hypotheses to test with actual
buyers and relevant investors; event advice and broad adoption statistics do
not establish a funding commitment or a roadmap priority.

The immediate constraint is cash within the founder-reported one-to-two-month
runway. Actual available cash, required amount and binding date are unknown.
The next month combines beta learning, one useful product improvement and
funding discovery. Work beyond that month depends on affordable continuation.

## 1. Sell owner work handled; validate the price

Lead with the job: reputation work handled with less effort from the owner.
The first outcome to prove is **recurring owner time returned**. Count upload
preparation, approvals, edits, supervision and failures; report onboarding
separately. Work the owner previously ignored is additional coverage, not time
saved. Keep founder/co-founder support separate so manual service does not
masquerade as product automation.

Bookings and revenue can support the story when there is traceable evidence.
Distinguish a source-linked booking from proof that RepWorth caused an
incremental sale. QR scans, review counts and replies are not revenue.

Keep the understandable **Copilot / Autopilot subscription shape**: different
amounts of owner supervision, with clearly defined work, included usage and
locations. Exact price and willingness to pay remain validation questions.
Current code prices are recorded in the [cost baseline](2026-08-30-operating-cost-baseline.md);
this document does not change billing or existing-account snapshots. Honor
beta promises and founding terms when seeking a paid continuation decision.

Outcome positioning does not require outcome-contingent billing. Credits or
fees tied to outcomes are optional later experiments, conditional on buyer
demand, clear definitions, reliable attribution, viable delivery costs and
appropriate review. Support-ticket resolution fees are not evidence of what
a reputation customer will pay. No Billing Meters project is committed here.

Promise only work within an agreed scope and verified operating conditions.
Consent, suppression, policy holds, owner decisions and platform availability
can prevent an action. Do not promise every review answered, every job sent an
ask, a universal response SLA, guaranteed reviews or guaranteed revenue.

Start impact evidence now with a worksheet and existing records; do not wait
for the P7 dashboard. Observe baseline effort before selecting thresholds and
before evaluating the change. Track eligible work, completed work, owner
interventions, corrections, unresolved cases and support effort with their
denominators. Any calculated time-saving estimate stays labeled until checked
against observed work. A short beta does not establish long-term retention.

## 2. Build reusable operations; require demand for agent access

The [architecture](2026-08-26-agentic-architecture.md) supports keeping domain
operations reusable behind typed, validated interfaces. Apply that pattern to
the operation actually being built; avoid speculative public-tool inventories.
Internal reuse is useful whether the next caller is a worker, an owner-facing
interface or an external agent.

An MCP or authenticated API pilot requires a **named prospective user and a
recurring task**, access to the needed data, and a bounded capacity decision.
It is not automatically scheduled after P2. Start with the smallest useful
read surface if that meets the demand. Draft generation changes state and can
incur cost; it is not a read-only operation.

Existing approval policies and action records are foundations, not a complete
external-agent identity system. Machine authentication, tenant scope,
revocation, permissions, quotas and actor attribution need their own design
and verification. Any write inherits the same approval and policy rules as
other callers.

An integration does not guarantee marketplace acceptance or distribution. An
MCP listing does not prove that agents will choose or pay for RepWorth.
Permissioned business context may become valuable, but neither a connector
nor stored action history establishes a data moat by itself.

No AI-answer visibility/AEO monitoring program is committed. A proposed
probe needs named customer demand, a useful and reproducible measurement,
an action the result would inform, and an approved cost/capacity allowance.

## 3. Use new capabilities to remove an observed burden

“Go where AI could not go six months ago” is a prompt to investigate a
specific capability change. It is not a reason to switch industries or build
a broad front-office suite. The test is whether a newly feasible operation
removes a meaningful burden for the current buyer, with acceptable quality,
cost and supervision.

Select **one customer type from actual beta users** for the coming month; the
roster, workload and shared software are still unknown. Keep reputation as
the starting job. Observe the existing journey and discuss a concrete paid
offer in parallel. The [forward roadmap](2026-08-26-forward-roadmap.md) owns
the provisional engineering/discovery limits. A limit is not an allocation:
hold the hours in reserve until the forward roadmap's paid-decision or
existing-beta quality test justifies a selected improvement.

P1–P8 remain stable roadmap topic identifiers, not a fixed delivery order.
Observe impact immediately. If recovery becomes the justified slice, establish
the minimum verified business facts and permissions from P4 before enabling
recovery actions; do not wait for a complete business-knowledge platform.
Parallel research can inform the decision, but only one product slice is
active.

Governed automation is useful positioning, not an exclusive claim competitors
cannot copy. Competitors already market automation and outcomes; for example,
[Birdeye's pricing page](https://birdeye.com/pricing/) itself uses outcome
positioning. Differentiation must be demonstrated through a buyer's specific
workflow, effort, quality, paid preference and repeated use. “AI-native” and
“AI employee” alone do not establish it.

## 4. Cash and investor evidence run alongside the beta

The CFO leads cash reconciliation and the financial ask. The COO prepares
the pitch and owns the investor process, pitching alongside the CEO/CTO;
the CMO supplies buyer, market and distribution evidence, with CFO support.
The four founders report 40–60 hours each per week; the [role assignment draft](2026-09-08-founder-90-day-plan/README.md)
plans around 40 and confirms weekly commitments. A new feature,
public launch or polished deck is not a prerequisite for private investor
discovery.

Follow the forward roadmap's September 8 cash sheet and September 14/21
gates, bringing them forward if actual obligations require it. The cash sheet
names possible sources, amounts, decision-makers, conditions and clearing
dates; it also costs funded, smaller-scope and pause options for the founders
to decide. If no source can credibly clear in time, bring the continuation
choice forward. Missing inputs or a missing decision do not authorize
discretionary building or spending. Use the forward roadmap's dated decision
and escalation rules. These dates are planning targets, not completed work.

In week 1, prepare an honest brief with zero paying customers, founder-reported
beta participation, current product scope, evidence gaps and a costed funding
ask once cash inputs arrive. Obtain permission before messaging anyone,
submitting an application or spending money. The COO records actual
responses, decisions, conditions and next dates; CFO verifies financial
figures and received cash. Researched names are not
investor interest, and signed commitments are not cleared funds.

Run only three active learning questions this month:

1. Does the chosen customer have enough recurring work and value to pay?
2. What credible funding route and requested proof could fit the cash date?
3. Would the proposed product slice materially change either answer?

Record each investor objection with the investor's fit, evidence requested,
owner and next decision date. In week 1, use concrete feedback to decide what
proof to collect or which funding route to pursue. Three independent repeated
objections trigger investigation; one factual blocker can trigger it sooner.
Neither automatically changes the roadmap. A change needs a causal reason,
customer evidence or an explicit strategic hypothesis, financing relevance,
effort impact and founder decision. Preserve paying-customer evidence when
weighing investor preferences.

Calculate the cash decision date from dated obligations and founder support
needs, with an explicitly agreed buffer. Compare actual receipts and
obligations at day 7 and day 14, or earlier if required. Financing, paid
continuation and lower outflows are distinct options; none is assumed
available. Preserve beta commitments. Do not call continuation affordable
while its cash amount, horizon or deadline remains unknown.

At each major checkpoint/workstream end, run the requested two-round Claude
challenge and revision before the next major commitment. Evidence and
decisions, rather than feature count, determine the next step.

## 5. What changed on September 7

This refresh replaces the August overlay's mandatory hybrid-credit direction,
automatic post-P2 MCP timing, immediate AEO probe, fixed phase sequence,
universal service promises and exclusive-governance claim. The original social
research is historical context, not current proof of demand or investor fit.
Use the [roadmap index](README.md) and [forward roadmap](2026-08-26-forward-roadmap.md)
for the coordinated plan, with the cost snapshot's stated limits when making
cash decisions.
