# RepWorth — portable brand kit

Prepared from the checked-in brand and product references on 2026-09-08. This is writing context, not a live production audit. For visual work, attach the appropriate Style Reference and actual logo/media files as well.

## The message

RepWorth helps local businesses spend less time managing Google reviews.

Supporting line: **AI that does the work. Rules that you set. A record you can check.**

Brand-values line: **Earn trust. Never manufacture it.**

Start with the owner's recurring work and explain what gets handled, what still needs attention, and how the owner keeps control. Less effort is the outcome to demonstrate; it is not a measured customer result. Do not revive the older “first true AI agent” or competitor-proof claims.

## Audience and voice

Write operator-to-operator: plain, warm, calm, direct, specific. A café, salon, dental practice, or plumbing business can supply illustrative context; the initial beta customer type has not been selected in the source narrative. Do not silently turn an example into the company's chosen market.

Use agent names when they explain the work. Avoid hype, jargon, unqualified safety promises, and “set it and forget it.” Avoid “unlock,” “supercharge,” “seamless,” “AI-powered,” and “next-generation.”

## Product vocabulary

| Name | Meaning |
|---|---|
| RepWorth | Product name; the graphic wordmark is uppercase REPWORTH |
| Copilot | Owner-approved replies |
| Autopilot | Eligible automatic replies within owner-defined rules and posting gates; availability requires verification |
| Reply | Drafts review replies |
| Guardian | Triages and escalates; never acts publicly and is not a subscription tier |
| Insights | Reporting and briefs |
| Solicitor | Consented email review requests; separate from public reply posting |
| Judge | Audits automatic replies after publication; availability is checked before automatic posting |
| Governor | Can pause an account's automatic posting when quality thresholds are breached |

Keep names capitalized. A separate Judge check does not mean a different model or a pre-publication verdict. The automatic-reply veto window is 15 or 30 minutes; do not apply that promise to every action. Voice examples begin contributing after five posted, owner-edited replies for a location.

## Claims discipline

Describe implemented behavior with a source reference. Describe staging demonstrations as staging. Customer-availability claims need a current deployed version, account/configuration check, and completed journey. This kit has not verified production flags, prices, trials, enrollment, or customer outcomes.

- Keep future capabilities explicitly future-framed; Google is the implemented platform reference.
- Never invent customer quotes, reviews, names, logos, activity, usage numbers, rating gains, time savings, or revenue attribution.
- Label synthetic data and concept UI as demo or illustrative. Historical screenshots are not current product proof.
- Price, trial, channel, and signup language must match the verified offer and CTA. Use “See how RepWorth works” for a general explainer without a confirmed commercial offer.
- Show the actual approval path. An owner-approved reply does not receive the automatic-post Judge treatment.

## Visual direction

Reuse the actual logo. Choose one visual system per surface: Landing for `/`, Island for other public/auth/admin surfaces, Console for the authenticated owner app. Use that system's typography, token palette, motion, and accessibility rules. Do not invent a blended “master palette.”

The emotional tone is relief and trust. Show concrete owner work and visible control. Avoid generic chatbot imagery, fabricated dashboards, neon glows, and purple-blue AI gradients. Fonts and exact colors come from the linked Style References and implementation, not model memory.

## Story shape

Owner workload → work handled with clear approval choices → visible record and remaining exceptions → a concrete next step. If showing the longer-term vision, separate and label it. For a real-product demo, follow arrival → draft → edit/approval → confirmed publication → record of what happened.

## Present tense and future tense

Present tense is for what ships in code today. Everything else is "will" or "planned". Source inspection does not prove a feature is on for production accounts; the [positioning guide](../brand-guidelines/positioning.md) §2 and §5 own the full proof-point table and the evidence gate.

**Ships today (present tense allowed, with a source reference):**

- Google Business Profile reviews only. One provider integration.
- Reply, Guardian, Insights, Solicitor. Judge and Governor supervise them. The run spine records every action.
- Copilot and Autopilot tiers. Autopilot is bounded by an owner-set rating band, a daily cap, and a 15- or 30-minute veto window.
- Negative reviews are never auto-posted. High-severity moderation flags are held, never notified.
- Multi-location, per-location overage billing, account-level digests.
- Approval by email. No login required to approve.
- Review QR: one printable code per location that redirects a scan to the Google review form.
- Solicitor: email review requests in owner-approved batches, with consent attestation, per-ask withhold reasons, one-click unsubscribe, and permanent opt-outs. Email only. Never say SMS or WhatsApp for asks.
- The owner dashboard: Rep Pulse (0–100), rating and volume trends, review velocity, weekly recap, agent activity, and the Restraint tab.
- Briefs: the Monday weekly report and the monthly impact report, by email.

**Confirm the production flag before you name it:** Telegram and WhatsApp channels, the card-up-front 30-day trial, self-serve signup, and every autonomy flag. Checked-in context reports all autonomy flags off in production. Describe Autopilot as what the owner can move to, not as what runs for customers today.

**Not shipped:**

- Committed direction, frame as future: CRM Manager, Social Media Manager, Fake Review Detection and Dispute, platforms beyond Google.
- Proposed only, keep out of marketing copy: competitor benchmarks, voice-of-customer insights, review-bombing detection, local SEO agent, POS/booking triggers, staff recognition, agency white-label tier, shareable reputation score.

## Three guarantees you may state without hedging

The system enforces these (architecture invariants #3 and #4, and the Governor).

1. Nothing unapproved ever posts.
2. Unsafe drafts are held, never sent.
3. Autonomy can be suspended, automatically.

## The pipeline

> ingest → Guardian triages → Reply drafts → moderation (unsafe drafts held) → approval (owner on Copilot, or every automated gate plus the veto window on Autopilot) → posted → Judge verdict

Four of the seven steps are safety steps. That ratio is itself a message.

## Pricing and tiers

Values below match `TIER_CONFIG` in `src/lib/accounts/tier-config.ts` on 2026-09-08. Stripe prices are grandfathered per account. **Do not publish a price without confirming the live offer first.**

| Tier | List | Founding | Locations included | Extra location |
|---|---|---|---|---|
| Copilot | $29/mo | $19/mo | 1 | $15/mo |
| Autopilot | $69/mo | $49/mo | 1 | $20/mo |

The card-up-front 30-day trial exists in code behind `TRIAL_ENABLED`. Confirm it before advertising it.

## Say this, not that

| Say | Not |
|---|---|
| Use the product | Leverage the platform |
| Nothing posts without your say-so | You stay in control |
| Every review gets a response | Never miss a review again |
| A café at 8 AM | Businesses of all sizes |
| Reviews answer themselves at 3 AM | 24/7 automated coverage |
| The gate | The approval workflow engine |

Also banned: revolutionize, transform your workflow, leverage, robust, powerful, game-changing, effortless, elevate. No em-dash pileups, no rhetorical questions, no "Here's the thing." Numbers only when true: "100% of auto-posts" is true; customer counts, hours saved, and rating lift are not.

## Copy live on the site

Verified against the landing copy files on 2026-09-08. These lines predate the owner-effort narrative above. Match their register; new pieces lead with the owner's work, not with the fleet.

**Hero** (`hero-copy.ts`)
> One fleet of agents. Your whole reputation.
> Each agent has one job. Independent watchdogs supervise the ones that act.
> Google reviews: answered, requested, and measured, today. Growing to everywhere else you show up.

**The trust statement** (`watchdogs-copy.ts`)
> If the supervisor is down, nothing posts on its own.
> Judge availability is a precondition for posting without you. When the Judge cannot run, replies wait for your approval instead.

**Personas** (`personas-copy.ts`)
> Reply — Every review gets a response, in your voice.
> Guardian — The bad ones reach a human. Always.
> Insights — Every Monday, you know exactly what happened.
> Solicitor — Asking your customers, so more reviews arrive.

**Watchdogs** (`watchdogs-copy.ts`)
> Judge — Reviews the machine's work, not yours.
> Governor — The kill switch that does not wait for you.

**The five jobs** (`jobs-copy.ts`)
> Respond · Protect · Request · Brief · Measure

**Closing CTA** (`cta-copy.ts`)
> Hand your reputation to a fleet that answers to you.
> Start on Copilot, where nothing reaches Google without your say-so. Move to Autopilot when you want to, not before.

**Page description** (`src/app/(public)/page.tsx`)
> A supervised fleet of AI agents answers your Google reviews in your voice, asks your customers for new ones, briefs you every week, and never posts outside the bounds you set.

## Format playbooks

The [brand story](../brand-guidelines/brand-story.md) §6 owns the landing, social, video, and short-hook playbooks. The rules below cover what it does not.

**Ads and social posts**

- One claim per ad. Pick one: the gate, the voice match, the 3 AM reply, Guardian escalation, or the Judge. Never combine.
- Lead with the gate, not with drafting. Drafting is the commodity claim.
- Google Ads: 30 characters for headlines, 40 for descriptions. Write to the limit; do not pad.
- LinkedIn: owner-to-owner, first person, no thread-bait hooks, no "🧵", no numbered listicles.
- No fabricated social proof. No "join 1,000+ businesses." None exist.
- No fake urgency, countdown language, or "limited spots" unless literally true of the early-access list.
- End on the concrete next step that matches the current posture. Use "See how RepWorth works" unless the signup and trial flags are confirmed on.

**Email sequences**

- Subject lines: 4–7 words, natural lower-case, no emoji, no fake "Re:".
- The first line must earn the open. No "I hope this finds you well."
- One ask per email. One link.
- Owner-to-owner, first person singular from a founder, not "the RepWorth team."
- Sequence shapes that fit the product: cold outreach (the 1-star that sat unanswered → the gate → early access); onboarding (connect Google → first draft arrives → approve one → set the trust dial); nurture (one agent per email); beta invite (what is live, what is not, what we want feedback on).
- Compliance: every non-transactional email needs a physical address, an unsubscribe link, and a privacy-policy link. Support address of record: `support@repworth.net`.
- Never imply an email is transactional when it is marketing.

**Long-form and SEO**

- Minimum 1,500 words per blog post. One post per week.
- Programmatic page templates in plan: `/respond-to-google-reviews-for-{vertical}`, `/{city}-reputation-management`, `/alternatives-to-{competitor}` (Birdeye, Podium, NiceJob, GoSite, Reputation.com).
- Every programmatic page needs genuinely unique content: a vertical- or city-specific intro and FAQ. If you cannot write something true and specific for a vertical, skip that vertical.
- Comparison pages describe competitors factually from their public material. Never invent a competitor limitation. The honest differentiator is the gate and the audit trail, not a feature-count table.
- One H1, descriptive H2s, answer the query in the first 100 words.
- Include a real product screenshot or an explicitly labelled "illustrative" figure. Never an unlabelled mock.

## Pre-publish checklist

Run this on every piece before it ships.

- [ ] No banned word from "Audience and voice" or "Say this, not that".
- [ ] No present-tense claim about CRM, Social, disputes, or non-Google platforms. Solicitor and the Review QR are present tense; Solicitor's asks are email only.
- [ ] A piece longer than a line names at least two of: request, brief, measure. Review replies are not the only job.
- [ ] No invented metric, customer count, testimonial, logo, or quote.
- [ ] Agent names capitalized and used per "Product vocabulary". Guardian is not called a tier.
- [ ] Judge described as auditing automatic replies only. Guardian described as never acting publicly.
- [ ] Any price, trial, channel, or signup claim confirmed against the current production flags.
- [ ] The CTA matches the current launch posture.
- [ ] Demo data and concept UI labelled as such.
- [ ] One claim, not five.
- [ ] Reads like one person talking to another person.

## Sources to attach or consult

- [Brand story, voice, channel playbooks, and boilerplates](../brand-guidelines/brand-story.md)
- [Positioning, proof points, and availability gate](../brand-guidelines/positioning.md)
- [Visual identity](../../../DESIGN.md) and [system router](../design-systems/README.md)
- [Product reference](../../../PRODUCT.md)
- [Logo and asset entry points](README.md)

When uploading this kit to an external assistant, attach the relevant source documents too; relative repository links will not automatically become available there. Refresh that upload when the source changes.
