# RepWorth product roadmap

Last revised: **2026-09-20** (operator pages consolidated into this folder
and reconciled; see Decision history). The September 11 revision followed
the owner's approval of the conversational operator recommendations. Filenames keep their original dates so
existing references remain usable.

RepWorth should handle reputation work for business owners and show what it
achieved. The immediate product goal is to prove one useful workflow for one
customer type during the beta, with measured owner effort and evidence of
willingness to pay. Funding work runs alongside the beta because the owner
reported only one to two months of runway; the actual cash requirement and
deadline still need to be recorded.

**Product direction (a hypothesis, not a shipped capability):** an owner
explains a recurring reputation job and the rules of their business.
RepWorth proposes an operating plan, performs approved work, follows up on
unresolved items, and shows what happened. The owner adjusts the plan in
ordinary language. The problem to observe is the effort owners still spend
configuring, coordinating, correcting, and checking work whose individual
steps are already automated.

The immediate commitment is a bounded software v1, specified and now built
(status: the spec's first line) in the
[Owner Operator spec](2026-09-11-owner-operator.md): one model call per
turn, typed proposal cards, explicit Apply, existing domain operations, a
60-hour named exception with a 30-hour checkpoint. The
[forward roadmap](2026-08-26-forward-roadmap.md#bounded-owner-operator-experiment)
owns the evidence rules and stop criteria. It commits no general agent
platform and no simultaneous international launch.

The [forward roadmap](2026-08-26-forward-roadmap.md) owns the current order of
work. Its Phase 1–8 labels identify areas of future work; they are no longer
a mandatory sequence or a checklist that must be finished before launch.

**Four-founder assignment draft (September 7):** the owner clarified a
CEO/CTO, COO, CFO and CMO, each available 40–60 hours weekly, with the CFO
also helping marketing. The [90-day founder plan](2026-09-08-founder-90-day-plan/README.md)
contains separate role briefs for September 8–December 6, a marketing
strategy, milestones and conditions for faster growth. It adds operating
assignments; its numeric targets are proposed, not achieved results.

## Files

| File | Purpose |
|---|---|
| [Current state](2026-08-26-current-state.md) | Implementation inventory, dated evidence, and remaining uncertainty about deployment |
| [Forward roadmap](2026-08-26-forward-roadmap.md) | Immediate priorities, dependencies, and longer-term feature options |
| [Verticals](2026-08-26-verticals.md) | Candidate industries, how to choose the first customer type, and later integration/topic options |
| [Positioning](../brand-asset-library/brand-guidelines/positioning.md) | Customer promise, supporting controls, and limits on public claims |
| [Brand story](../brand-asset-library/brand-guidelines/brand-story.md) | Plain-language story and evidence requirements for marketing |
| [Agentic architecture](2026-08-26-agentic-architecture.md) | Conversational delegation over governed execution, existing foundation, and separate conditions for external agent access |
| [Investor theses](2026-08-29-investor-theses-overlay.md) | Ideas to test with buyers and investors; pricing and funding decisions |
| [Launch explainer](2026-08-29-launch-explainer-script.md) | A short demonstration first, with a longer film concept for later |
| [Operating costs](2026-08-30-operating-cost-baseline.md) | Dated service-cost inventory and the missing inputs for a cash plan |
| [Owner operator](2026-09-11-owner-operator.md) | The v1 spec (conversation → proposal cards → Apply → receipts) and its build status. Its architecture and framework posture are [agentic architecture §6](2026-08-26-agentic-architecture.md#6-owner-operator-durable-commitments-and-framework-posture); the stages beyond v1 close the [forward roadmap](2026-08-26-forward-roadmap.md#owner-operator-stages-beyond-version-1) |
| [Competitor evidence](../plans/2026-09-11-reputation-competitor-landscape.md) | Desk review of NiceJob, TrueReview and GatherUp (checked Sep 11): documented AI replies, automation and international coverage |
| [Roadmap review](2026-09-07-roadmap-review.md) | Two Claude review rounds, changes made, and documentation checks |

## Current decisions

1. **Focus the next month.** Choose one customer type from the actual beta
   cohort. Home services, beauty/personal care, and food/beverage remain
   candidate markets. The provisional buyer hypothesis is owned by
   [verticals §2](2026-08-26-verticals.md#2-choose-the-first-customer-type-from-the-beta);
   the roster must support it. Record the recurring job, market, languages,
   software and acquisition route as well as industry. The first cohort and
   connector remain undecided.
2. **Measure value from the start.** Record the owner's time spent doing the
   work, reviewing drafts, correcting mistakes, and getting help. Label
   estimates as estimates. Track commercial decisions alongside usage.
3. **Choose one engineering improvement.** Use observed beta problems to
   select a payment/beta blocker or an explicitly chosen, bounded hypothesis
   experiment addressing a repeated observed burden. Customers need not ask
   for chat. Until selection, keep engineering hours in reserve. The forward
   roadmap defines its provisional limits, early cash gates and continuation
   decision.
4. **Put necessary facts before dependent automation.** Recovery messages
   must use approved business facts and rules. The minimum needed from
   Phase 4 comes before that recovery work; it need not wait for topic analysis.
5. **Lead with the owner's result.** Approval controls, Judge, Governor,
   and audit records support that promise. They do not establish an exclusive
   or uncopyable advantage by themselves.
6. **Keep Copilot and Autopilot as the working packages.** Test willingness
   to pay and cost to serve. This documentation update changes no billing
   configuration, prices, or existing account agreements.
7. **Build external agent access when there is a user for it.** An MCP pilot,
   AI-search experiment, additional platform, or new industry competes for
   capacity with the beta's demonstrated needs.
8. **Test continuing delegation and transferability.** A chat that completes
   setup alone does not establish the operator hypothesis. Measure subsequent
   eligible work, corrections and paid continuation. International support
   needs evidence for the full workflow in each selected market; language
   generation or an international signup alone does not establish it.

## What remains open

- Beta account count, customer types, software used, review volume, and
  baseline effort; the five interested prospects are not automatically five
  active beta users or paying customers.
- A current reconciled cash/obligation view, minimum founder support,
  cash-needed date and week-specific founder allocation. The September 10
  [decision log](2026-09-08-founder-90-day-plan/ceo-cto/decision-log.md) records
  private finance inputs supplied, with obligations/final deadline still
  pending; this page does not re-audit those figures.
- The owner-operator v1 is built and its pilot owner is named (the spec
  owns that status). Still open: the pilot's observation window and
  eligible review activity, the hours actually used, and the customer
  evidence needed to continue, change direction, or stop it.
- Actual investor feedback on RepWorth and any financing timeline.
- Current launch gates, legal review, and deployed feature availability.

## Relationship to engineering documents

This folder owns product priorities. The
[agentic design of record](../future-plans/2026-07-01-agentic-reputation-platform-design.md),
[feature specs](../superpowers/specs/), [plans](../superpowers/plans/), and
[runbooks](../runbooks/) own implementation requirements and operating
procedures. A roadmap entry does not override a safety invariant, authorize
a deployment, or prove that a feature is live. Features still follow the
repository's normal specification and implementation workflow.

## Decision history and maintenance

The August 26 plan selected three industries and the sequence connectors →
recovery → topics → business facts. The August 29 overlay pulled MCP and
AI-search experiments forward. The September 7 owner-approved revision
supersedes that fixed sequence with the priorities above. The longer-term
feature sketches remain available for later decisions.

The September 11 owner-approved update makes the owner-facing operator a
bounded software v1 under a named 60-hour exception, separates it from
external API/MCP access, and adds tests for business memory and
international transferability. Cash gates, existing beta promises and the
20-hour default cap for other improvements remain in force. The September 7
review predates this revision and did not evaluate it.

The September 20 consolidation removes the `2026-09-11-owner-operator/`
subfolder. The spec is now `2026-09-11-owner-operator.md`; its architecture
page is agentic architecture §6; its vision page closes the forward
roadmap. One exception keeps the old path: applied migration
`120_owner_operator.sql` cites it in a stored table comment and is not
edited. Owner decisions recorded that day: no vendor agent framework by
default (a candidate only when a loop is specified); review asks never
depend on sentiment; cross-business learning is a bet, not a moat; later
stages use the forward roadmap's paid, cash and capacity tests; autonomy
may later widen automatically only inside an owner-set ceiling; operator
hours used are unrecorded; the September 11 revision has not had its
two-round challenge.

Update the relevant document when evidence or a decision changes, record the
date, and fix references in the same change. Keep deployment claims tied to
dated environment evidence. At major checkpoints, repeat the two-round
Claude challenge and record objections and resulting changes. Ask the owner
before spending money or messaging anyone.
