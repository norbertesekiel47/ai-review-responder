# Roadmap review and revision evidence

Date: **2026-09-07**. Scope: the ten existing files in this folder, updated
after the owner's approval. This file records the mandatory two-round Claude
challenge and the documentation checks.

The [forward roadmap](2026-08-26-forward-roadmap.md) owns the resulting plan.
The [index](README.md) links all updated documents. Source checks were
targeted, using repository revision `4aa132bac9e3d7f6f2eb72e669b57885ba16c6e5`; this is
not a full implementation or launch-readiness audit.

## Claude review method

Both rounds used the installed Claude CLI and existing Claude subscription.
The main returned model was `claude-opus-5`; CLI metadata also lists
`claude-haiku-4-5-20251001`. Both returned successful results. Tools and
external MCP servers were disabled for the reviewer.

Each permitted review received the agreed bottleneck and the complete
forward plan for that iteration. Round 2 also received the previous objections
and a description of the revisions. The nine accompanying documents were
checked by Codex and the three workstream agents, not sent to Claude.
Automatic approval review rejected the initial wider packet before execution;
the narrower plan-only request was then permitted. No repository source,
credentials, customer records or invoices were included in the review inputs.

Bottleneck provided: securing capital within a founder-reported one-to-two-month
runway while choosing features without direct evidence of what would persuade
investors to fund RepWorth. Actual cash, founder capacity and beta makeup are
unknown. Owner time saved is the chosen primary product outcome.

## Both rounds: objection → what changed

| Round | Strongest objection | Resulting change |
|---|---|---|
| 1 | Funding preparation lacked named routes, amounts and money dates. | September 8 cash sheet: actual obligations, minimum continuation amount, possible sources, decision-makers, conditions and credible clearing dates. A subscription is not assumed to cover the cash gap. |
| 1 | October 7 was too late for the first cash decision; no smaller-scope option was ready. | September 14 paid-decision target and September 21 cash gate, brought forward if obligations require. Prepare costed funded, smaller-scope and pause options for founder decisions. |
| 1 | Engineering and measurement could consume scarce time before a paid decision. | No feature is preselected. Reserve the provisional engineering hours; use a few real observations and a paid offer, with a reference appendix for later features. Preserve measured time as the owner's chosen outcome and label recalled effort separately. |
| 2 | The plan did not force a decision when no source could clear in time. | Add an explicit credible-cash line; an empty line brings the continuation decision forward. Beta/prospect roster due September 8; first brief/demo preparation has a provisional two-hour combined ceiling. |
| 2 | Gates could report trouble without producing a dated continuation decision. | Cofounder proposes and both founders record the decision date and buffer on September 8; September 21 is a provisional meeting date if inputs remain missing. Default to holding new discretionary commitments, with immediate escalation, rather than automatic service cuts. |
| 2 | Building and process still leaned toward “on.” | Keep engineering in reserve until a paid decision, a named payment blocker, or a blocking failure against an existing beta promise justifies it. Keep the user's required five-line reports and two-round debates; reduce ceremony around them. |

Round 1 requested revision. Round 2 said “Approve with the amendments above.”
The final documents incorporate the compatible amendments, with these explicit
limits: a funding route's speed remains unverified; missing cash inputs do not
justify waiting; no automatic reductions/cancellations are authorized; the
owner's time-savings outcome, reports and two-round debates remain. The final
amendments were checked locally, not submitted for a third Claude round.
This record does not claim unconditional Claude approval.

## Review input fingerprints

These identify the exact plan-only inputs used for the two successful runs.
They do not establish that any future task, financing or feature is complete.

| Round | SHA-256 of input packet |
|---|---|
| 1 | `abe0729ef36a4ae50a4405e39748c98f310afe31be3fe5c0436301cd57babcc8` |
| 2 | `6e5ecfa8b565d487402e9e80913db5f33a73f21bc8d42ad173b270a21422d7f7` |

## Full reviewer responses

The text below is Claude's critique, preserved as received. Its suggestions
and market/timing opinions are not automatically adopted facts. The table
above states what changed and which user requirements were retained.

<details>
<summary>Round 1 response</summary>

## Objection 1 — There is no fundraising plan inside the "cash and funding" row

The confirmed bottleneck is capital, and the plan's answer is one table cell: record cash, prepare a demo, prepare questions. That is preparation, not a raise. No target list, no number, no ask size, no sequence, no first-meeting date. Meanwhile the plan itself says no investor has looked at RepWorth. Starting cold investor conversations with zero paying customers, inside 1–2 months, is the least likely of the available money sources — and the plan never names the others.

**Revision.** Replace that cell with a one-page money sheet the cofounder fills in this week: (a) exact cash on hand, monthly burn, and the date money runs out; (b) the smallest amount that buys three more months; (c) a named list of every realistic source — the ~5 interested prospects paying now, prepaid annual or paid pilots, angels already known to either founder, deferred founder pay, cutting fixed costs, part-time income; (d) for each, who decides and how fast money could arrive. Bring that list to you for approval as one batch. Treat "close one paying customer" as the primary capital path and investors as the slower parallel one, not the reverse.

## Objection 2 — The dates do not fit the runway, and the escape branch is missing

Everything reviews on **October 7**. If the runway is one month, that review lands after the money is gone. The plan also states it "does not authorize an automatic shutdown" but never says what *does* happen if there is no cash — so the hardest decision arrives late, unplanned, and under panic.

**Revision.** Put two dated gates in writing now, while nobody is desperate. **Sept 21:** cash sheet complete, at least one prospect has been asked for money, at least one investor or angel conversation booked or explicitly ruled out. **Oct 5** (or the cash-out date minus one week, whichever is earlier): if no paid decision and no funding commitment with a date, execute a pre-written reduce-or-pause option. Write the three options today — cut costs to X, founder goes part-time, pause development and keep beta accounts running — and pick the trigger for each. A pre-committed branch is not pessimism; it is what stops a forced choice later.

## Objection 3 — Scarce founder hours are aimed at the wrong things

In a cash emergency the plan still commits 20 engineering hours to a bounded improvement, a Phase 0 launch/legal track, a spec before any code, five-line weekly reports per workstream, two Claude challenge rounds per workstream completion, and roughly five pages of Phase 1–8 sketches. None of that produces cash. Worse, the improvement is selected from "an observed workflow" rather than from a stated reason someone will not pay. The likely 30-day output is a careful null result — the plan even pre-writes the phrase "report insufficient evidence."

**Revision.** Three changes. First, move Phases 1–8 and the cross-cutting list into a separate appendix file so the operating plan is one page. Second, pick the improvement only if a named prospect or beta user has said, in their own words, that this specific thing is why they will not pay — otherwise spend those hours on the demo and the conversations. Third, drop measured before/after time savings as the month's evidence bar; it needs volume you may not have. Replace it with a direct paid-decision test: owner-recalled current effort, a price, and an ask. A "no, because ___" is faster evidence than a clean baseline, and it is what an investor will ask about anyway.

## Verdict

The plan is honest and well-disciplined about what it does not know, which is rare and worth keeping. But it is a product-learning plan wearing a funding plan's title. It rehearses rigor while the clock runs out. Fix three things before anything else: name the money sources and ask for money, set the Sept 21 / cash-out-minus-a-week gates with pre-written reduce options, and cut the operating plan to one page aimed at a paid decision. Revise, then bring it back for round 2.

</details>

<details>
<summary>Round 2 response</summary>

## Objection 1 — The funding track is still the thinnest part of a plan whose bottleneck is funding

The cash sheet is well specified, but the investor route is one line ("booked, declined, or still unavailable") and this week's founder work includes preparing a demonstration and investor questions. No investor has evaluated RepWorth, and the runway is founder-reported at one to two months. A first-contact process almost certainly cannot produce cleared cash inside that window, yet the plan gives it equal billing with sources that can. The plan also asks the cofounder to rank by "cash arriving before the deadline" without forcing the conclusion that ranking implies.

**Changes:** (a) On the September 8 sheet, add a required line: *"Sources that can credibly clear before the cash-needed date."* If that line is empty, the smaller-scope and pause options move from optional to the live decision, on the sheet, that day. (b) Time-box investor preparation to a fixed small allowance (state hours, not "a short demonstration") and treat it as relationship-building for a later raise, not as this month's runway solution. (c) Make the beta/prospect roster due September 8 alongside the cash sheet, not "first action, undated" — it is the input list for the September 14 paid-decision target, and five interested prospects plus an unknown beta roster is too thin to leave unscheduled.

## Objection 2 — Gates without a dated decision point or a default

The plan correctly refuses to let a missed target authorize cancellations. But the result is a structure where every gate reports and nothing decides. "Make the continuation decision before cash runs out" has no date, because the cash-needed date is unknown; "choose a decision buffer" has no owner or deadline; and there is no stated default if the founders do not decide.

**Changes:** (a) On September 8, write a single dated line: *continuation decision date = cash-needed date minus chosen buffer.* If the cash-needed date cannot be established on September 8, fix September 21 as the decision date by default. (b) Name both founders as the deciders and record the decision in writing on that date, decided or explicitly deferred with a reason. (c) State the default action if no decision is made: the smaller operating scope, not continuation. A plan that defaults to spending is the failure mode a short runway punishes.

## Objection 3 — Engineering and process still default to "on" before any paid evidence

The 20-hour ceiling and the "choose no new feature" clause are real improvements, but the framing still assumes an improvement will be selected: discovery, integration discovery hours, specification, weekly review, October 7 review. Alongside that, the plan mandates three workstream reports weekly and two Claude challenge rounds per completion or checkpoint. With founder hours unknown and no paying customer, this is a meaningful draw on the only person who can also demonstrate the product and answer a prospect's objection.

**Changes:** (a) Invert the default: hold the 20 hours in reserve, unlocked only by a paid decision or a named prospect stating a specific blocker to paying. Until then, no engineering slice is selected. (b) Reduce mandatory process for this month to one weekly consolidated report and one challenge round at the September 21 cash gate. (c) Keep the four-hour integration discovery cap but do not start it this month unless the unlock condition above is met — a connector cannot plausibly be the thing that produces cash inside the runway.

## Verdict

**Approve with the amendments above.** The rewrite fixed the substance of my round-1 objections: the cash sheet has named sources, amounts, conditions and clearing dates; the September 14 and 21 gates precede the October 7 product review; costed funded/smaller/pause branches exist; engineering is capped and conditional. What remains is that the plan reports rather than decides, and still leans toward building. Add a dated continuation decision with a stated default, force the "can clear in time" test on the cash sheet, and hold engineering hours in reserve. With those three changes I would run this plan as written.

</details>

## Documentation verification

- All ten original roadmap files updated; one review-evidence file added.
- All 43 local Markdown links resolve; code fences are balanced and files
  have final newlines.
- All 32 original vendor inventory amounts are preserved, totaling $729.17
  in the dated snapshot. This is not a fresh invoice or cash verification.
- `git diff --check` passes. Tracked changes are limited to the ten roadmap
  documents.
- Cross-document review reconciled phase order, MCP timing and action scope,
  Judge timing, QR/report implementation, price configuration, the savings
  estimate, and future product-explanation claims.

No application behavior changed. Tests, build, browser journeys, database
state, production flags, Stripe configuration and the expense tracker were
not exercised by this documentation update. Browser testing does not apply
to these Markdown edits. Implementation status remains bounded by the dated
evidence in the current-state document. No billing settings, deployments,
outreach, purchases or commits were made.
