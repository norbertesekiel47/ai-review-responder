# Positioning: owner time returned through governed autonomy

Refreshed 2026-09-07 after the roadmap review; original filename retained for
existing links. This updates the 2026-08-26 positioning decision.

Lead with the owner's work: fewer minutes spent drafting replies, preparing
review requests, checking progress and handling exceptions. Governance
explains how an owner can delegate that work and retain control. It is an
implemented foundation and a reason to test RepWorth, not an exclusive
feature or a proven moat. Measure the value with beta owners before making
quantified promises.

## 1. The core claim

> **RepWorth helps local businesses spend less time managing Google reviews.
> It drafts replies in your voice, prepares review requests and brings
> exceptions to your attention. You choose what needs your approval and
> what eligible replies may post automatically, with a record you can check.**

Use the production-status gate in §5 before publishing present-tense claims
about a particular feature. "Spend less time" is the outcome to demonstrate;
it is not yet a measured customer result.

Short forms:

- Owner-facing: **"AI that does the work. Rules that you set. A record you
  can check."**
- Category line: **"A reputation manager that works within your rules."**
- Proof line: **"See what was handled and what still needs you."**

## 2. Proof points and their limits

These are code-backed descriptions, subject to §5. Source inspection does
not establish that a feature is enabled or working for production accounts.

| Claim (customer language) | What makes it true | Anchor |
|---|---|---|
| "Nothing posts without an approval — yours, or a policy you set" | `approval_method` = `owner` \| `auto_policy` is a hard posting precondition | invariant #3 |
| "Automatic replies are audited after posting by a separate AI Judge" | The sweep schedules verdicts for posted automatic replies. Judge availability is checked **before** an automatic post; disabled/unavailable Judge downgrades the reply to owner review. This is not a pre-publication Judge verdict or a guarantee that no bad reply can publish. | [Judge sweep](../../worker/background/pollers/JudgeSweepPoller.ts); [posting gate](../../worker/jobs/publisher/judge-gate.ts) |
| "You can stop an automatic reply during its veto window" | 15/30-minute window on auto-approved review replies. This duration does not describe every action or review-request workflow. | WS4; [reply policy settings](../../src/app/(authenticated)/settings/auto-approval/AutoApprovalClient.tsx) |
| "A Governor can pause an account's automatic posting when its quality thresholds are breached" | Per-account suspension and owner notification; human approval remains available subject to normal checks. | WS6 |
| "Drafts flagged as high severity are held for administrator review" | `flagged_responses` hold; notification to the owner is withheld until cleared for owner review. Do not claim perfect unsafe-content detection. | invariant #4 |
| "Recorded workflow actions have an audit trail" | Run spine (`agent_runs`/`agent_run_steps`/`agent_outcomes`) and account audit log. Access and retention follow product policy; do not promise permanent storage or an owner screen for every internal event. | WS1 |
| "Review requests withheld by policy have a reason you can inspect" | `evaluateAsk` withhold decisions with reasons, visible at batch approval | design §9.2 restraint policy |
| "Review requests check consent and recorded opt-outs before sending" | Consent and suppression ledgers, global-wins unsubscribe; neither this claim nor automation replaces a business's consent obligations. | send-mode specs |
| "Daily limits and rating rules keep the volume sane" | trust dial: rating bands + daily caps | WS4 |
| "Reply drafts can use your previous edits" | Voice examples activate after **five posted, owner-edited replies** for the location. One edit does not activate voice learning. | [voice-learning.ts](../../src/lib/responses/voice-learning.ts) |
| "Print a QR code that takes customers to your Google review form" | Implemented per-location QR download/print and direct redirect; scans do not establish reviews or sales. | [Review QR](../context/review-qr.md) |
| "LLM safety evaluations form part of the applicable release checks" | Path-filtered `llm-eval` gate; a passing evaluation does not prove all real-world output is safe. | WS7 |

## 3. Message architecture

- **Copilot** = "It drafts, you approve." Show the actual steps and owner
  effort for a completed reply. Voice examples can incorporate edits once
  the five-post threshold is met; business policies are not learned
  automatically from a single approval.
- **Autopilot** = "Routine replies within your rules, exceptions brought to
  you." Demonstrate the extra owner effort removed, alongside corrections,
  supervision, vetoes and failures. Copilot usage is useful evidence of
  preferences, not a safety guarantee or an automatic upgrade prerequisite.
- P5's proposed per-action autonomy matrix can become a supporting demo if
  customer evidence justifies building it. The P1–P8 labels identify roadmap
  topics; they do not impose a mandatory implementation order.

Competitive evidence checked 2026-09-07: Birdeye documents
[review-response approvals](https://support.birdeye.com/en/articles/12829765-how-to-set-up-and-use-review-response-approvals)
and [MCP tools](https://docs.birdeye.com/mcp/tools/overview). GatherUp's
[Inbox](https://gatherup.com/blog/inbox/) documents tickets for managing
feedback. These are specific public product claims, not proof that every
competitor has RepWorth's implementation. They are enough to rule out
"only us," "no one else supervises agents," and "MCP is our moat."

The differentiation hypothesis is reliable execution of one business type's
recurring work with less owner supervision. Select that initial type from
the actual beta cohort; it is not yet known. Measure absolute minutes
returned, corrections, completed work and willingness to pay. Include
onboarding, uploads, exception handling and founder support. Retain negative
results and label recalled/modelled savings. The existing seven-minutes-per-
reply estimate cannot establish measured ROI. Bookings are supporting
evidence only when reconciled with business records; association is not
causation. Neither agent terminology nor a feature count proves retention,
defensibility or investor demand.

## 4. Claims to NEVER make

- No promised star ratings ("we'll get you to 4.9") — outcome depends on the
  business's actual service.
- No revenue attribution without defensible causality (the P7 Impact
  page is deliberately conservative).
- No "we filter which customers get asked" — RepWorth never gates by
  predicted sentiment, never incentivizes, never steers destinations (FTC
  Consumer Reviews Rule; Google policy; already binding on candidate
  selection per design §9.3).
- No implying reviews alone move Google ranking (relevance/distance/
  prominence all factor).
- Nothing that overstates autonomy while prod flags are off — see §5.
- No universal claim that each unanswered review loses revenue, guarantees
  better AI recommendations, or that one competitor cannot copy a feature.

## 5. Honesty gate: what may be said WHEN

This refresh inspected source and documentation, not live production flags
or customer journeys. Checked-in context reports autonomy flags off in
production; re-check deployment and configuration before publication. The
old statement that the production stack is not stood up is withdrawn.

| Evidence level | What it permits |
|---|---|
| Built in code | Explain the implemented design with a source reference; no live-customer claim. |
| Verified in staging | Describe the exact tested journey, linked to its dated build, environment and evidence. An older staging report is not verification of the current release. |
| Verified in production | State what the confirmed deployed version and account configuration support, backed by a completed journey. A flag flip alone is insufficient. |
| Vision | Label as proposed/future and show no fabricated current usage or outcomes. |

Autopilot copy depends on the ordered rollout, tier availability, all
posting gates and live evidence. Use the `flag-flip` workflow for changes;
tie copy updates to verified rollout evidence. Copilot and QR claims also
need a current product check before a public demo. Do not manufacture a
"Judge-checked" label while a reply is still in its pre-publication veto
window.

## 6. Where this lands (execution checklist, Track C)

1. **Marketing pages** — the agentic refresh spec
   (`docs/superpowers/specs/2026-07-22-marketing-pages-agentic-refresh-design.md`)
   is the existing surface; audit its copy against §1–§3 here and adjust.
   Standing rules apply: list existing routes before adding pages; any UI
   work routes through the `repworth-brand-design` skill; prove changes with
   390px/1440px before/after screenshots.
2. **Pricing page** — explain supervision choices and included work per §3.
   Respect existing terms; price changes are a separate decision (README).
3. **Onboarding + product copy** — show actual state: pending owner review,
   an automatic reply's veto deadline, posted, then Judge audit status when
   available. Keep internal controls out of the owner's way unless they
   help a decision.
4. **Sales/investor narrative** — first capture a short real-product demo
   and the beta measurement method. Add customer outcomes only when
   evidenced. Run-spine events support completion counts; measuring net
   owner effort also needs observation or diaries. Report automated work,
   corrections and founder assistance together.
5. **Vertical landing pages and launch film** — use the selected beta
   type's vocabulary after validating the offer. Defer an elaborate film
   and broad page expansion until the short demo and commercial learning
   justify the work. Observe owner effort and seek a paid decision; use the
   forward roadmap's selection process and provisional capacity limits.
