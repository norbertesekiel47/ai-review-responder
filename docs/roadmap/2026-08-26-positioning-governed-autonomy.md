# Positioning: governed autonomy (owner decision, 2026-08-26)

Decision: RepWorth markets itself around **governed autonomy** now — not as a
future layer. The trust infrastructure is the most-built part of the product
and the one thing direct competitors (NiceJob, GatherUp, Podium's SMB tier)
do not have. "AI-powered reputation management" is a category claim every
competitor makes; "an AI reputation manager you can actually govern" is a
claim only RepWorth can currently evidence.

## 1. The core claim

> **RepWorth is the governed autonomous reputation manager for local
> businesses. It earns reviews, replies in your voice, and catches unhappy
> customers — and every autonomous action runs inside rules you set, is
> checked by an independent AI Judge, can be vetoed before it goes live, and
> is permanently auditable.**

Short forms:

- Owner-facing: **"AI that does the work. Rules that you set. A record you
  can check."**
- Category line: **"The reputation agent with a governor on it."**
- Contrast line: **"Everyone has AI agents now. Ask them who watches theirs."**

## 2. Proof points (each one is TRUE in code today)

Marketing may only use claims from this table; each has a verifiable anchor.

| Claim (customer language) | What makes it true | Anchor |
|---|---|---|
| "Nothing posts without an approval — yours, or a policy you set" | `approval_method` = `owner` \| `auto_policy` is a hard posting precondition | invariant #3 |
| "An independent AI Judge reviews 100% of automatic posts — and if the Judge is down, automatic posting stops" | `JudgeSweepPoller` + judge availability as posting precondition | WS6; design §8.2 |
| "You get a veto window before any automatic reply goes live" | 15/30-minute veto window on auto-approved responses | WS4 |
| "A Governor suspends autonomy on its own if quality slips" | `AutonomyGovernorScheduler` per-account suspension + owner notification | WS6 |
| "Unsafe drafts are held for human review — always" | moderation absolute veto; high-severity → `flagged_responses`, never notified | invariant #4 |
| "Every action is on a permanent audit trail" | run spine (`agent_runs`/`agent_run_steps`/`agent_outcomes`) + account audit log | WS1 |
| "It refuses harmful requests — and shows you why" | `evaluateAsk` withhold decisions with reasons, visible at batch approval | design §9.2 restraint policy |
| "Review requests respect consent and opt-outs, permanently" | consent ledger, suppression ledgers, global-wins unsubscribe | send-mode specs |
| "Daily limits and rating rules keep the volume sane" | trust dial: rating bands + daily caps | WS4 |
| "Our safety checks run in CI before any release" | `llm-eval` release gate | WS7 |

## 3. Message architecture

- **Copilot** = "It drafts, you approve." The governed ladder's first rung —
  position it as how RepWorth *learns your voice and your rules* (voice
  learning + edit tracking are real), not as the cheap tier.
- **Autopilot** = "It runs inside your rules." Lead with the governance stack
  (Judge, veto window, Governor, caps), not with "hands-free." The upgrade
  story is *earned trust*: Copilot's approval data is what makes Autopilot
  safe for your account.
- When Phase 5 (per-action autonomy matrix) ships, the settings screen itself
  becomes the flagship marketing asset: a picture of autonomy you can dial
  per action is the whole pitch in one screenshot.

Competitive framing (use sparingly, never name-calling): incumbents describe
autonomous AI agents; RepWorth describes the *supervision* of one. The FTC/
platform-policy climate makes "the compliance-conscious choice you can safely
put on autopilot" a durable wedge, especially for franchise/multi-location
buyers later.

## 4. Claims to NEVER make

- No promised star ratings ("we'll get you to 4.9") — outcome depends on the
  business's actual service.
- No revenue attribution without defensible causality (the Phase 7 Impact
  page is deliberately conservative).
- No "we filter which customers get asked" — RepWorth never gates by
  predicted sentiment, never incentivizes, never steers destinations (FTC
  Consumer Reviews Rule; Google policy; already binding on candidate
  selection per design §9.3).
- No implying reviews alone move Google ranking (relevance/distance/
  prominence all factor).
- Nothing that overstates autonomy while prod flags are off — see §5.

## 5. Honesty gate: what may be said WHEN

Production autonomy flags are currently **OFF** and the prod stack is not
stood up (design §8.4). Until the ordered prod flips happen:

- ✅ May say: how the governance system works, that it is built, that it is
  proven in live end-to-end testing (staging evidence exists), Copilot
  claims (launchable now).
- ⛔ May not say: "customers' replies are being auto-posted today," or any
  present-tense Autopilot-in-production claim.
- The flag-flip runbook (`flag-flip` skill) is the gate: when
  `AUTO_APPROVAL_ENABLED` + `AUTOPILOT_PURCHASABLE` flip in prod, the
  present-tense claims unlock. Tie the marketing-copy update to that flip's
  checklist so the two cannot drift.

## 6. Where this lands (execution checklist, Track C)

1. **Marketing pages** — the agentic refresh spec
   (`docs/superpowers/specs/2026-07-22-marketing-pages-agentic-refresh-design.md`)
   is the existing surface; audit its copy against §1–§3 here and adjust.
   Standing rules apply: list existing routes before adding pages; any UI
   work routes through the `repworth-brand-design` skill; prove changes with
   390px/1440px before/after screenshots.
2. **Pricing page** — reframe tier copy per §3 (Copilot = learn your rules,
   Autopilot = run inside them). Pricing *amounts* are a separate open
   decision (README).
3. **Onboarding + product copy** — approval screens should name the
   safeguards in-line ("Judge-checked · veto window open until 3:42pm") —
   the product surface is the most credible marketing.
4. **Sales/investor narrative** — open with the governed-agent structural
   story; the autonomy-rate metric (% of reputation work completed without
   human intervention, alongside falling correction rate) is the headline
   chart once real usage accumulates. The run spine + `agent_outcomes`
   already record what's needed to compute it.
5. **Vertical landing pages** — after Phase 1 per vertical, using that
   vertical's vocabulary (verticals doc §7).
