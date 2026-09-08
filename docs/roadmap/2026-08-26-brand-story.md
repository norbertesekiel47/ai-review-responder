# RepWorth brand story (source of truth for marketing narrative)

Refreshed 2026-09-07 after the roadmap review; original filename retained.
The immediate story is owner time returned in one beta customer type,
which has not yet been selected. Production availability and customer
results were not verified during this documentation refresh.

This file is the single source for the RepWorth story across marketing
campaigns, social media, videos, landing pages, and the website. Copy teams
and future sessions pull from here; they do not invent a parallel narrative.
It is consistent with `2026-08-26-positioning-governed-autonomy.md` (the
claims discipline lives there) and with the current-state doc (what is true
today vs vision).

Rules for using this file:

1. Every public claim must come from the proof-point table in the positioning
   doc §2 and pass its availability gate, or be clearly framed as vision
   (see §8 below, the honesty ledger).
2. Never fabricate reviews, testimonials, or customer results in creative.
   Demo data is labeled demo. (FTC Consumer Reviews Rule discipline is part
   of the brand, not just the product.)
3. UI/page work that carries this story still routes through the
   `repworth-brand-design` skill and the existing-routes rule.

---

## 1. The story in one line

> **RepWorth helps local businesses spend less time managing Google reviews.**

Supporting tagline (owner-facing):

> **AI that does the work. Rules that you set. A record you can check.**

Brand-values banner line:

> **Earn trust. Never manufacture it.**

## 2. The story in one paragraph (boilerplate, ~60 words)

> RepWorth helps local businesses handle Google reviews with less owner
> effort. It drafts replies in your voice, prepares review requests and
> brings exceptions to your attention. Copilot lets you approve replies;
> Autopilot can post eligible replies within your rules. You can inspect
> completed work, stop an automatic reply during its veto window and see
> what still needs you.

This is outcome-led product copy, not a quantified savings result. Apply
§8 to the feature claims before publication.

## 3. The full narrative (the master story — landing pages, videos, decks)

**Act 1: The problem.** Reviews are part of a local business's public
reputation. Handling them takes work: drafting replies, checking what was
sent and following up when something goes wrong. Owners fit that work
around fixing the furnace, plating the dish or finishing the appointment.
Nobody opened a plumbing company to spend evenings on Google. The actual
burden differs by business; our beta needs to establish who has enough of
it to value help.

**Act 2: The turn.** Writing a draft is one part of that workload. An owner
still has to approve it, fix mistakes, prepare customer lists and handle
exceptions. RepWorth needs to reduce the work across that journey. The
owner should be able to see what was handled and decide when to step in.

**Act 3: RepWorth's answer.** RepWorth combines reply drafts and review
requests with approval controls and records of the work. You choose which
eligible reviews may receive automatic replies, the daily cap and a veto
window. Copilot keeps replies under your approval; Autopilot adds bounded
automatic posting. Voice examples start contributing after five replies
that the owner has edited and posted for the location. Complaint triage
brings issues to a human; it does not mean the customer has been recovered.
Review-request checks record reasons for withholding ineligible asks.

The controls support that delegation. A separate AI Judge audits automatic
review replies **after publication**. The publisher checks Judge
availability **before** an automatic post; when the Judge is disabled or
unavailable, it sends the reply to owner review. A Governor can pause the
account's automatic posting when quality thresholds are breached. The
15/30-minute veto window applies to automatic review replies; other actions
have their own rules. Recorded workflow actions can be inspected through
the product's available views. These controls do not guarantee perfect
output, remove all owner work or establish a competitor-proof advantage.

**Act 4: The vision** *(always future-framed)*. We want a business owner to
start the day with one useful report: what RepWorth handled, what remains
unresolved, which recurring service issues deserve attention and what
happened after a complaint was followed up. Completed-job integrations,
recovery and topic intelligence could make that report more useful. Each
needs an observed customer problem and its own delivery evidence. A future
illustration may show these capabilities, clearly labeled as a concept;
it must not invent a customer's results or imply recovered revenue.

## 4. Brand pillars (the five values — public wording)

These reinforce the category; use them verbatim in About pages, decks, and
culture content.

1. **Earn trust. Never manufacture it.** Real reputations are earned. We
   make real customer experiences visible — we never fake, filter, or buy
   sentiment. *(Product: no review gating, no incentives, no fabricated
   engagement.)*
2. **Humans set the rules. AI does the work.** Automation should give owners
   clear control. You define the voice, policies, and boundaries;
   RepWorth handles the repetition. *(Product: Copilot/Autopilot, trust
   dial, veto window.)*
3. **Help owners improve the experience.** A complaint can point to a
   service problem. Bring it to the owner and make the follow-up clear.
   *(Product: escalation is implemented; recovery workflows and topic
   intelligence remain roadmap topics.)*
4. **Treat customer data with care.** Collect the data the work requires,
   control access and explain its use and retention. Public privacy claims
   must match the reviewed terms and actual product behavior. *(Product:
   consent and suppression ledgers, tenant isolation, audit logs and
   offboarding workflows.)*
5. **Be measurably useful.** Measure the owner's actual effort, including
   approvals, uploads, corrections and supervision. Keep founder support
   visible in delivery cost. *(Product events support task counts; the
   existing `timeSaved` estimate is not an observed baseline. Bookings need
   separate business records and cautious attribution.)*

## 5. Voice and tone

- **Operator-to-operator.** Plain words, short sentences, zero martech
  jargon. Say "review requests," not "reputation acquisition funnels."
- **Calm confidence.** Show work completed, remaining exceptions and
  control the owner can exercise. Explain limits when they affect a buying
  or approval decision.
- **Specific beats superlative.** "A separate AI Judge audits automatic
  replies after posting" explains more than an unqualified safety claim.
- **Honest about autonomy.** We say "runs inside your rules," never "set it
  and forget it."
- **Use agent language when it helps.** Governance, automated replies and
  agent access also appear in competitors' offerings. See the dated,
  first-party evidence in the positioning doc §3. Explain RepWorth's
  particular workflow and show measured owner value.

## 6. Channel playbook

### Landing page (hero → arc)

Hero: one-liner (§1) + tagline. Show a completed owner journey, what still
needs attention, measured value when available, then approval choices and
supporting controls. Keep the vision separate and labeled. Primary CTA:
"See how RepWorth works." Any trial or purchase CTA must reflect the
currently available offer. The first asset is a short recording of the real
product, not a broad website redesign.

### Social media (recurring post formats)

1. **"The agent said no."** Restraint stories: show a (demo-labeled)
   withhold decision and its reason. Explain the particular rule; do not
   call the scene proof of an exclusive feature or a moat.
2. **Reply makeovers.** Demo review → generic AI reply vs RepWorth reply in
   a learned voice, with editorial commentary explaining the difference
   (label demo). A product-generated "why RepWorth wrote this" explanation
   remains a future feature; do not fabricate that UI.
3. **Governance explainers.** 30-second "what is the veto window / who is
   the Judge / what does the Governor do" series.
4. **Operator empathy.** The 9pm-on-Google owner moment; problem-first
   posts with no product until the last line.
5. **Vertical vocabulary posts** (if P3 is built and verified): explain a
   service pattern from supported topic data, with permission and visible
   sample size. Select one beta customer type first; do not lock the
   company to restaurants because a creative example uses one.

### Video scripts (skeletons)

**First, a 60–90s real-product demo:** follow one review from arrival to
draft, owner edit/approval and confirmed publication, then show the actual
record and remaining work. Label the environment and demo data. An
owner-approved reply does not receive the automatic-reply Judge treatment
merely because it appears in this film.

**Later, a 30s cut:** an owner closes up, checks a draft, approves it and
sees completion. Show the owner action honestly; do not fake instant voice
learning or imply zero supervision.

**Later, the longer film:** retain the day-in-the-life arc in the launch
explainer. If a verified automatic-reply example is available, show its
veto window, final posting checks including Judge availability, publication,
then Judge audit. Future recovery/topic scenes remain labeled concepts.

### Ads / short hooks

- "See what was handled and what still needs you."
- "Review replies in your voice, ready for your approval."
- "Routine replies within your rules."
- "Spend less of your evening on Google reviews." *(Outcome hypothesis;
  quantified savings need measured evidence.)*

## 7. Audience variants

- **Owner (default):** start with recurring work and effort returned. Show
  how an owner keeps control and handles exceptions.
- **Investor:** identify the selected buyer, observed workload, paid
  decisions, delivery cost and distribution hypothesis. Explain how
  permissioned context and dependable execution might compound into an
  advantage. Memory, retention and moat claims need their own evidence;
  a planned reputation graph is not a current asset. Report absolute owner
  minutes, completion/correction rates and founder support together. Zero
  paying customers and unknown beta cohort details remain explicit until
  actual evidence changes them.
- **Agency/white-label (later, P8):** explain the supported agency workflow
  only once the offer exists. External-agent access can be a small,
  governed pilot when a named partner needs it; it is neither an automatic
  next feature nor dependent on completing P2.

## 8. Honesty ledger — which story elements may be used WHEN

Extends the positioning doc §5 gate. Check before publishing; no deployment
or live journey was verified in this refresh.

| Bucket | Elements | Usable |
|---|---|---|
| **Implemented in code** | Copilot, voice examples after five posted+edited replies, TL;DR, triage/escalation, approval controls, Judge/Governor, consent/suppression, requests and [Review QR](../context/review-qr.md) | Describe implemented design; source presence alone is not a customer-availability claim. QR is no longer a pre-launch build item. |
| **Verified in staging** | Only the specific journey covered by a dated build/environment/test record | Say exactly what was demonstrated. Do not carry an old "live-tested" label across unverified changes. |
| **Verified in production** | Only features confirmed in the deployed version, flags, account configuration and actual completed journey | Present-tense availability claims with linked evidence. Checked-in context reports autonomy flags off; live state must be checked. A flip alone is insufficient. |
| **Vision (P1–P8 topics)** | Job-completion integrations, recovery, topic intelligence, Business Truth, finer autonomy controls, expanded impact evidence, multi-platform and external-agent access | Future-framed until delivered and verified. Topic IDs preserve references, not mandatory order; minimum approved business facts must precede any recovery action. |

The Act 4 report stays vision-framed until its depicted capabilities are
delivered and verified. Then rebuild it from permitted, anonymized evidence.
Do not replace a missing measured baseline with the dashboard's fixed
seven-minute estimate, or turn review/QR counts into revenue. AI-discovery
experiments are optional research, not a required launch proof point.

## 9. Boilerplates (copy-paste blocks)

**Short:** RepWorth helps local businesses handle Google review replies and
requests with less owner effort, clear approval choices and a record they
can check.

**Medium (§2 paragraph).**

**About-page long:** Act 1–3 of §3 verbatim, then pillars (§4) as the
closing block.
