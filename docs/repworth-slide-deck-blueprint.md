# RepWorth Slide Deck Blueprint

Prepared: 2026-05-06  
Purpose: master slide blueprint for co-founders, sales, and investors  
Recommended use: turn this markdown into a polished deck, then trim by audience

## What This Deck Must Accomplish

The deck needs to make three groups believe three related but different things:

- Co-founders need to see the product strategy, launch sequence, operational risks, and what decisions are needed now.
- Sales needs a clear story they can repeat: who we sell to, what pain we solve, how to demo it, and how to handle objections.
- Investors need to see a credible company: sharp problem, focused wedge, working product, economic logic, go-to-market path, and a believable roadmap.

The core message should be:

> RepWorth is a done-for-you review response system for local businesses. It monitors Google reviews, drafts personal replies in the owner's voice, gets explicit owner approval, posts approved responses back to Google, and turns review activity into useful business intelligence.

## Deck Tone

Use a serious but practical tone. This is not a "future AI magic" deck. It should feel like a real operating system for a painful small-business workflow.

Avoid:

- Claiming traction we do not have.
- Presenting demo numbers as measured business outcomes.
- Overloading slides with implementation details.
- Making it sound like RepWorth auto-posts without owner control.
- Positioning the product as "another dashboard." The product promise is workflow relief.

Use:

- Real product screenshots.
- A live review-to-response demo.
- Clear before/after comparisons.
- Honest launch status.
- Simple unit-economics math.
- Specific pilot metrics to prove or disprove the business.

## Important Claim Guardrails

Some numbers and statements appear in marketing UI as illustrative examples. Do not present them as company traction unless you have measured proof:

- "96% response rate"
- "+127 replies"
- "58 min average time from review posted to response"
- "100% response rate across all reviews"
- "30 sec owner time per approval"
- "86% fewer drafts edited by week 8"
- "#14 to top 3 in the neighborhood"
- "You save about fifteen hours a week"

These can be used as example visuals only if labeled as example data. For investor slides, replace them with real pilot data or remove them.

Any claim about Google ranking impact, market size, competitor pricing, or review behavior should be sourced before final deck production.

## Recommended Deck Versions

Use this file as the master. Then create three cuts:

- Investor version: 12 to 14 slides plus appendix. Focus on problem, market, product proof, differentiation, GTM, economics, traction/status, ask.
- Internal founder version: 16 to 18 slides. Add roadmap, risk register, launch gates, operational readiness, and decisions needed.
- Sales version: 8 to 10 slides plus demo script. Focus on pain, workflow, proof, pricing, objections, and close.

## Current Product Snapshot To Ground The Deck

As of 2026-05-06, the application has meaningful product surface beyond marketing pages:

- Public pages: landing, features, how-it-works, pricing, book-a-demo, demo viewer, login, signup, terms, privacy.
- Self-serve signup and onboarding: email signup, check-email flow, plan selection, Stripe payment link handoff, business profile and voice setup.
- Pre-paywall demo flow: business lookup, review sample generation, demo response preview, paywall fallback if generation fails or cost ceiling is reached.
- Owner dashboard: response-rate/value summary, review velocity, ranking chart, recent reviews, approval actions, latest weekly/monthly brief, Zernio connection status.
- Approval flow: secure approval links, owner can approve, edit, or regenerate before anything is posted.
- Zernio integration: connect Google Business Profile through Zernio, select location, ingest reviews, backfill, publish approved replies, handle disconnected states.
- Background worker system: BullMQ queues, outbox poller, LLM response generation, notifications, publishing, demo generation, weekly/monthly reports, ranking tracking, engagement alerts.
- Admin operations: admin overview, businesses, demos, job health, costs, notifications, runbook, channel enrollment widgets.
- Multi-channel work: email is core; Telegram owner channel exists; SMS and WhatsApp code paths exist but require real-world setup and flag-gated rollout.
- Cost and reliability controls: LLM cost guard, onboarding demo cost guard, SMS cost guard, idempotent outbox, Sentry, redaction, retries, failure hooks, admin exception paths.

The slide deck should present this as "working product plus launch gates," not as a vague prototype.

## Slide 1: Cover

### Job Of The Slide

Make the audience immediately understand the category and ambition.

### Suggested Headline

RepWorth

### Suggested Subheadline

Owner-approved AI replies for every Google review.

### Supporting Line

We help local businesses respond faster, sound more personal, and turn reviews into weekly operating insight.

### Visual

Use a strong product-first image:

- Left or center: a real product screenshot showing a review, AI draft, and approval actions.
- Background motif: drifting review cards from the marketing design can work if subtle.
- Brand mark: RepWorth logo from `/public`.

### Speaker Note

"RepWorth sits between the customer's public review and the owner's response. We draft the reply, keep the owner in control, and handle the operational follow-through."

### Proof Needed

No external proof needed on this slide.

## Slide 2: The Company In One Sentence

### Job Of The Slide

Give every audience member a simple mental model.

### Suggested Headline

RepWorth turns customer reviews into owner-approved public responses.

### Slide Content

Use a simple five-part sentence:

1. A customer leaves a Google review.
2. RepWorth detects it.
3. RepWorth drafts a personalized response in the business's voice.
4. The owner approves, edits, or regenerates.
5. RepWorth posts the approved reply and summarizes what customers are saying.

### Visual

One horizontal workflow:

`New Google review -> AI draft -> Owner approval -> Posted reply -> Weekly insight`

### Speaker Note

"The important distinction is approval. This is not an uncontrolled auto-responder. It is a workflow that makes the right response easy enough that owners actually do it."

### Proof Needed

Use product screenshots for each workflow step if possible.

## Slide 3: The Problem

### Job Of The Slide

Make the pain obvious, especially to investors who may not run local businesses.

### Suggested Headline

Reviews are a sales channel, but most local businesses treat them like a chore.

### Slide Content

Use three pain columns:

- Time: owners are busy, reviews arrive unpredictably, and writing thoughtful replies gets pushed to nights or weekends.
- Quality: generic replies feel fake, multilingual reviews are hard, and negative reviews require careful tone.
- Consistency: unanswered reviews accumulate publicly, response rate falls, and the business loses a visible trust signal.

### Visual

Show a "before" inbox or review list:

- Multiple unanswered reviews.
- A generic copy-paste reply.
- A foreign-language review with no response.
- A negative review waiting too long.

### Speaker Note

"Every review is public proof. But the people best positioned to answer them are also the least available. That creates a gap between what customers expect and what owners can consistently do."

### Proof Needed

Collect one or more of:

- Screenshots of real businesses with many unanswered Google reviews.
- Prospect quotes from sales calls.
- A small manual audit: 20 businesses, percent of recent reviews answered, average response delay.

## Slide 4: Why Now

### Job Of The Slide

Explain why this product is possible and urgent now.

### Suggested Headline

AI made good replies cheap. Workflow is still the missing piece.

### Slide Content

Use three timing points:

- Review expectations are rising: customers expect businesses to acknowledge feedback publicly.
- LLMs can now draft specific, multilingual, brand-aware responses at low marginal cost.
- The winner is not the model alone. The winner is the approval, posting, reminder, cost-control, and reporting workflow around the model.

### Visual

Stack three layers:

- Model layer: OpenAI / Anthropic.
- Workflow layer: approval, edit, regenerate, post, retry, notify.
- Business layer: response rate, time saved, weekly brief, retention.

### Speaker Note

"Anyone can generate a reply in a chat window. The hard part is making the reply appear at the right moment, in the right channel, with the right approval guardrails, and then getting it posted."

### Proof Needed

If using outside market claims, source them before final slides. Otherwise keep this slide qualitative.

## Slide 5: Ideal Customer Profile

### Job Of The Slide

Show focus. Investors and sales both need to know who this is for first.

### Suggested Headline

The wedge: high-review local businesses where the owner still controls reputation.

### Slide Content

Primary ICP:

- Single-location or small multi-location local businesses.
- Owner-operated or manager-operated.
- Enough review volume that responding is painful, but not enough back-office staff to own it.
- Categories where tone and personal service matter: restaurants, salons, med spas, hotels, clinics, dental, home services, specialty retail.

Buying triggers:

- Recent negative review.
- Competitor has better response presence.
- Owner already spends nights replying.
- Business is investing in local SEO or reputation.
- New location launch or ownership change.

### Visual

Persona card:

- "Busy local owner"
- "10-80 new reviews per month"
- "Wants control, not software homework"
- "Will pay for done-for-you reliability"

### Speaker Note

"We should not sell this first to everyone with reviews. We should sell it to businesses where a thoughtful public reply matters and the owner feels the pain personally."

### Proof Needed

Add prospect examples or target-account list before presenting to investors.

## Investor Insert: Market Opportunity

### Job Of The Slide

Show that the wedge can become a meaningful business without inventing unsourced market numbers.

### Suggested Headline

Local reputation management is large, fragmented, and still workflow-heavy.

### Slide Content

Use a bottoms-up model, not a generic giant TAM number:

- TAM logic: number of review-dependent local businesses * annual review-response/reputation budget.
- SAM logic: target verticals in the first sales geography or first national vertical * expected annual contract value.
- SOM logic: first realistic milestone, such as 100, 1,000, and 5,000 paying accounts at blended ARPA.

Example model structure:

| Layer | Formula | Fill With Real Data |
|---|---|---|
| TAM | review-dependent businesses * annual spend | Source business count and spend assumption |
| SAM | target vertical accounts * $99-$199/mo | Source target account list or vertical count |
| SOM | accounts we can reach in 24 months * blended ARPA | Use GTM capacity and conversion assumptions |

### Visual

Use a bottoms-up stack or three nested circles:

- Local businesses with public reviews.
- High-review verticals where fast replies matter.
- Initial reachable market through founder-led and salesperson-led outbound.

### Speaker Note

"We should not lead with a vague reputation-management TAM. The credible market story is bottoms-up: this many review-dependent businesses, this much monthly willingness to pay, this many accounts we can reach through the first sales motion."

### Proof Needed

Collect and cite:

- Number of businesses in first target geography or vertical.
- Manual audit of how many have recent unanswered reviews.
- Current spend benchmarks from reputation platforms, agencies, VAs, or SEO vendors.
- Target ARPA based on pricing tests.

## Slide 6: The Solution Workflow

### Job Of The Slide

Make the product concrete.

### Suggested Headline

From new review to posted response in one controlled loop.

### Slide Content

Four-step workflow:

1. Connect reviews: RepWorth connects to the business's Google review source through the Zernio flow.
2. Draft response: AI uses review content, business profile, tone, avoid-facts, and prior edits.
3. Owner approves: owner receives a review and draft, then approves, edits, or regenerates.
4. RepWorth posts and reports: approved responses are posted; dashboards and briefs track outcomes.

### Visual

Use a product workflow diagram with icons:

- Google review
- AI draft
- Owner approval
- Google post
- Dashboard / weekly brief

### Speaker Note

"The workflow is intentionally conservative: humans stay in control, but the system removes the blank page, the follow-up, and the posting work."

### Proof Needed

Screenshots from:

- `/onboarding/business` connect step.
- `/approve/[token]` approval page.
- `/dashboard`.
- Zernio connection page.

## Slide 7: Product Demo Moment

### Job Of The Slide

Set up the live demo or make the demo feel real if you cannot run it live.

### Suggested Headline

We can show value before the customer pays.

### Slide Content

Use the pre-paywall demo as a conversion story:

- Prospect enters or selects their real business.
- RepWorth pulls recent Google reviews or falls back gracefully if live data is unavailable.
- RepWorth shows AI-written replies before asking for payment.
- Prospect chooses a plan after seeing the product on their own reviews.

### Visual

Show a three-screen sequence:

1. Business lookup screen.
2. Demo responses screen.
3. Plan selection screen.

### Speaker Note

"This matters for sales because the demo is not abstract. We do not ask owners to imagine the value. We show them what RepWorth would write for their own customers."

### Proof Needed

Use a real, permission-safe demo business or a clearly labeled sample business. Do not expose private customer data.

## Slide 8: Feature Pillars

### Job Of The Slide

Summarize what the product includes without drowning the audience.

### Suggested Headline

Seven pieces, one weekly rhythm.

### Slide Content

Feature pillars:

- AI drafting: specific replies written from scratch, not templates.
- Multilingual response: detect review language and reply in kind.
- Owner approval: approve, edit, or regenerate before posting.
- Voice learning: use owner edits and samples to improve future drafts.
- Weekly brief: plain-language summary of what customers loved, disliked, and mentioned.
- ROI dashboard: reviews handled, time saved, response rate, ranking trends.
- Competitive insight: future/private-beta local scorecard for competitors' review behavior.

### Visual

Use a clean feature index. Do not make this a crowded grid of cards if turning into slides. Consider splitting into two slides if needed:

- Slide 8A: response workflow features.
- Slide 8B: intelligence and reporting features.

### Speaker Note

"The product is not just generation. It is a recurring operating cadence around reputation: drafts, approvals, posting, and business insight."

### Proof Needed

For "voice learning" and "competitor insight," clarify status:

- Voice learning code and prompt support exist, but measured improvement needs pilot data.
- Competitor monitoring is positioned as coming Q3/private beta in current product copy.

## Slide 9: Owner Control And Trust

### Job Of The Slide

Address the biggest AI concern: "Will this post something wrong?"

### Suggested Headline

Nothing goes live without the owner's explicit approval.

### Slide Content

Trust controls:

- Drafts are sent to the owner with review context.
- Owner can approve, edit, or regenerate.
- Avoid-facts settings prevent known unsafe topics.
- Approval links use security controls, token checks, device binding, CSRF protection, and audit logging.
- Publishing handles disconnected or uncertain states instead of silently failing.

### Visual

Use the approval screen or phone-like approval mockup:

- Customer review on one side.
- Draft response on the other.
- Approve / Edit / Regenerate actions.

### Speaker Note

"The trust model is the product. Owners want speed, but they also want to protect their voice. We designed the system around explicit approval and recoverable failure states."

### Proof Needed

No external proof needed. Use product screenshots and internal security notes if asked in appendix.

## Slide 10: The Technical System Behind The Workflow

### Job Of The Slide

Show investors and technical co-founders that this is engineered as an operating system, not a prototype.

### Suggested Headline

A workflow engine, not a wrapper around a chat prompt.

### Slide Content

Keep this high-level:

- Web app: Next.js on Vercel for marketing, onboarding, owner dashboard, admin, and API routes.
- Worker service: Railway Fastify worker with BullMQ queues for slow, retryable, and external-provider work.
- Data layer: Supabase/Postgres for durable state, Redis for queues, rate limits, cost guards, and idempotency.
- AI layer: OpenAI primary generation with Anthropic fallback; prompt builder uses business profile, tone, avoid-facts, samples, and voice examples.
- Review and posting layer: Zernio webhooks, Zernio connect flow, initial backfill, review ingestion, approved-response publishing.
- Ops layer: outbox pattern, retry handling, Sentry, redaction, admin job health, cost dashboard, exception notifications.

### Visual

Use a simple architecture diagram:

`Owner / Admin UI -> API routes -> Postgres job_outbox -> Worker queues -> LLM / Zernio / Resend / Stripe / Twilio / Telegram -> Postgres -> Dashboard`

### Speaker Note

"This architecture matters because review response is an asynchronous workflow. External providers fail, owners delay approval, billing changes, connections disconnect, and jobs need to be idempotent. The system is built for that."

### Proof Needed

Use this only in investor appendix if the main deck is too long. For technical investors, include it in the core deck.

## Slide 11: Operational Readiness

### Job Of The Slide

Show that the company can support real customers.

### Suggested Headline

Built-in admin ops: demos, job health, costs, notifications, runbooks.

### Slide Content

Admin and ops capabilities:

- Admin can create and manage businesses.
- Admin can generate and review demos.
- Job page tracks BullMQ/outbox health.
- Cost page tracks AI/API spend.
- Notification logs help debug delivery.
- Runbooks exist for signup, Zernio, smoke testing, onboarding demo launch, and operational recovery.
- Sentry and redaction are wired into app and worker paths.

### Visual

Use an admin dashboard screenshot or a multi-panel screenshot strip:

- Admin businesses page.
- Jobs health page.
- Costs page.
- Demos page.

### Speaker Note

"A lot of early SMB SaaS products fail in support, not in the happy path. RepWorth already has admin surfaces and runbooks for the workflows that will break in production."

### Proof Needed

Screenshot current admin pages. Make sure no secrets or real customer PII are visible.

## Slide 12: Competitive Positioning

### Job Of The Slide

Make it clear why RepWorth is not just another reputation platform.

### Suggested Headline

RepWorth wins where owners need outcomes, not another tool to manage.

### Slide Content

Comparison dimensions:

| Option | What they do | Gap RepWorth exploits |
|---|---|---|
| DIY / ChatGPT | Owner manually copies reviews, writes prompts, posts replies | Too much owner time, no workflow, no reminders, no reporting |
| Virtual assistant / agency | Human writes or posts replies | Expensive, inconsistent, slower, hard to scale |
| Reputation platforms | Broad review management suites | Often complex, expensive, dashboard-heavy, not built around owner-approved AI posting |
| RepWorth | Done-for-you draft, approval, posting, and weekly insight | Specific workflow relief with owner control |

### Visual

Use a 2x2:

- X-axis: manual to automated.
- Y-axis: owner control low to high.
- RepWorth sits in automated plus high owner control.

### Speaker Note

"The wedge is not broad reputation management. The wedge is the repeat workflow every owner knows they should do and still avoids: write a good public reply fast."

### Proof Needed

If naming competitors like Birdeye or Podium, verify pricing and feature claims from current sources before investor use.

## Slide 13: Business Model And Pricing

### Job Of The Slide

Show how the product becomes a business.

### Suggested Headline

Flat monthly pricing, high perceived value, controlled variable cost.

### Slide Content

Current pricing in product surfaces:

- Founding Member: $99/month, limited founding slots, rate locked for life.
- Standard: $149/month.
- Premium: $199/month, intended for high-volume or extended backfill customers.

Included value themes:

- Unlimited reviews monitored.
- AI responses in any language.
- One-tap approval notifications.
- Weekly review intelligence brief.
- ROI dashboard.
- Dedicated onboarding call.

### Important Pricing Note

Current product surfaces are not fully aligned:

- Public pricing page labels Premium as "Coming soon" with Yelp/TripAdvisor/SMS/competitor features.
- Onboarding plan picker offers Premium checkout as an active tier with extended historical backfill and priority support.

Before presenting this deck externally, decide the public Premium story and update the deck accordingly.

### Visual

Show three pricing tiers or one simple price anchor:

- "Founding 10: $99/mo"
- "Standard: $149/mo"
- "Premium: $199/mo"

For investors, add a unit-economics strip:

`Gross margin = subscription revenue - LLM cost - review API cost - messaging cost - infra allocation - support time`

### Speaker Note

"Flat pricing matters for the buyer. The owner does not want to think in per-review charges. Internally, we control variable cost through cost guards, caching, queue discipline, and tier limits."

### Proof Needed

Before investor use, fill in:

- Actual average LLM cost per response.
- Average review volume per target account.
- SerpAPI/Zernio cost assumptions.
- Email/SMS/WhatsApp cost assumptions.
- Expected gross margin by tier.

## Slide 14: Go-To-Market

### Job Of The Slide

Give sales a repeatable wedge and investors a path to distribution.

### Suggested Headline

The sales motion starts with the prospect's own reviews.

### Slide Content

Sales motion:

1. Identify local businesses with recent unanswered or generic reviews.
2. Generate a RepWorth demo using their actual reviews.
3. Show before/after responses on a call.
4. Offer founding-member pricing for a limited number of early accounts.
5. Onboard with Zernio connection, tone setup, and first approval.

Initial channels:

- Founder-led outbound to local businesses.
- Salesperson-led vertical lists.
- Local business associations and chambers.
- Agencies that serve local businesses.
- Website/SEO consultants that already sell reputation improvement.

### Visual

Use a funnel:

`Review audit -> live demo -> founding offer -> onboarding -> first posted reply -> weekly retention`

### Speaker Note

"Our demo creates the sales conversation. Instead of 'here is software,' the pitch is 'here are three replies we would have written for your real customers.'"

### Proof Needed

Build a target account list and track:

- Audited businesses.
- Demos generated.
- Demo calls booked.
- Close rate.
- Time from signup to first approved response.

## Slide 15: Current Status And Launch Gates

### Job Of The Slide

Be honest about what is built versus what must happen before full launch.

### Suggested Headline

Product is substantially built; launch work is now operational.

### Slide Content

Built or code-complete:

- Public marketing pages and shared navigation.
- Self-serve signup and Stripe plan selection.
- Pre-paywall demo generation flow.
- Owner onboarding profile, voice, and Zernio connect steps.
- Owner dashboard with reviews, value summary, ranking, briefs, and approval actions.
- Secure approve/edit/regenerate flows.
- Zernio ingestion, backfill, connection, publishing, and reconnect handling.
- Admin dashboards for businesses, demos, jobs, costs, notifications, and runbooks.
- Email notifications; Telegram/SMS/WhatsApp code paths and enrollment surfaces exist with rollout dependencies.
- Cost guards, Sentry, retries, outbox pattern, failure hooks, and runbooks.

Launch gates to resolve:

- Apply and verify latest Supabase migrations in staging/production.
- Confirm production env vars for Stripe, Zernio, Resend, Redis, Sentry, and cost limits.
- Complete custom SMTP / Resend setup and email templates.
- Run signup, Zernio, and onboarding-demo smoke test runbooks.
- Decide and align Premium pricing across marketing and checkout.
- Complete external registration for SMS/WhatsApp if those channels are included in launch.
- Pilot one business end-to-end before broader founding-member push.

### Visual

Use a status board with three columns:

- Built.
- Needs operational setup.
- Next product bets.

### Speaker Note

"This is the stage investors should understand: the risk is shifting from 'can we build it?' to 'can we activate and retain customers through a reliable operational launch?'"

### Proof Needed

Add latest test/build status if presenting internally. For investors, summarize without too much engineering detail.

## Slide 16: Pilot Plan And Success Metrics

### Job Of The Slide

Turn uncertainty into a concrete validation plan.

### Suggested Headline

The next milestone: prove activation, approval behavior, and willingness to pay.

### Slide Content

Pilot structure:

- 5 to 10 local businesses.
- 30-day pilot.
- Founding-member pricing or explicit beta terms.
- White-glove onboarding call.
- Weekly customer check-in for first month.

Success metrics:

- Activation: business connects reviews and completes voice setup.
- Time to value: first AI draft generated and shown.
- Approval behavior: percent of drafts approved, edited, regenerated, ignored.
- Time to approval: median owner time from notification to action.
- Posting reliability: percent of approved replies successfully posted.
- Outcome signal: response rate before versus after.
- Retention signal: owner reads weekly brief or keeps approval flow active.
- Economics: AI/API cost per account versus subscription revenue.
- Support burden: tickets or manual interventions per account per month.

### Visual

Use a dashboard-style validation table:

| Metric | Target | Actual | Decision |
|---|---:|---:|---|
| Activation rate | Fill target | Fill actual | Continue/change |
| First draft time | Fill target | Fill actual | Continue/change |
| Approval rate | Fill target | Fill actual | Continue/change |
| Gross margin | Fill target | Fill actual | Continue/change |

### Speaker Note

"We do not need to prove every long-term roadmap item in the pilot. We need to prove that owners connect, approve, pay, and keep using the workflow."

### Proof Needed

Fill targets before presenting. Do not leave this as a generic metric slide.

## Slide 17: Roadmap

### Job Of The Slide

Show ambition without looking unfocused.

### Suggested Headline

Roadmap: win Google reviews first, then expand the reputation operating layer.

### Slide Content

0 to 30 days:

- Pilot first businesses end-to-end.
- Tighten onboarding, email deliverability, Zernio connection, and demo reliability.
- Align pricing and packaging.
- Add basic analytics instrumentation if still missing.
- Capture customer quotes and before/after data.

31 to 60 days:

- Scale founding-member sales motion.
- Expand notification channels where external setup is complete.
- Improve demo conversion and category-specific fallback demos.
- Make support and admin workflows faster.
- Package weekly brief as a retention moment.

61 to 90 days:

- Private beta competitor monitoring.
- Premium tier refinement.
- More robust ranking/ROI reporting.
- Partner channel experiments.

Longer horizon:

- Direct Google Business Profile API if approved.
- Reply editing/replacement for historical responses when API path supports it cleanly.
- Multi-location workflows.
- Broader platform support only after Google workflow is proven.

### Visual

Use a roadmap with four lanes:

- Product.
- Reliability/Ops.
- GTM.
- Data/Intelligence.

### Speaker Note

"The roadmap is deliberately sequenced. We do not start by becoming every reputation platform. We first own the highest-frequency workflow: Google review response."

### Proof Needed

Confirm dates and ownership before using internally.

## Slide 18: Risks And Mitigations

### Job Of The Slide

Show mature thinking. Investors trust teams that know their risks.

### Suggested Headline

Known risks are operational, measurable, and mitigable.

### Slide Content

| Risk | Why it matters | Mitigation |
|---|---|---|
| Owner trust in AI | A bad public reply can damage reputation | Explicit approval, edit/regenerate, avoid-facts, audit logs |
| Review provider dependency | Google/Zernio/API changes can affect ingestion or posting | Zernio handling, reconnect flows, exception alerts, future direct GBP path |
| SMB churn | Small businesses can be price-sensitive and inconsistent | Done-for-you onboarding, weekly brief, clear ROI dashboard, founding-member support |
| CAC uncertainty | Local SMB outbound can be inefficient | Demo-led selling, vertical focus, partner experiments, track funnel metrics early |
| Gross margin uncertainty | Review/API/message costs vary by volume | Cost guards, caching, tier limits, cost dashboard, flat pricing validation |
| Support burden | External connections and owner approvals create edge cases | Admin ops, runbooks, job health, Sentry, failure queues, pilot before scale |
| Overbroad roadmap | Platform expansion can dilute focus | Google-first wedge, Premium only where justified, roadmap gated by pilot data |

### Visual

Use a risk matrix or clean table.

### Speaker Note

"The goal is not to pretend there is no risk. The goal is to show that the first milestone is designed to expose the right risks with a small number of customers."

### Proof Needed

No external proof needed. Keep it concise in investor version.

## Investor Insert: Team And Unfair Advantage

### Job Of The Slide

Answer why this team can win the wedge.

### Suggested Headline

The advantage is speed, product depth, and proximity to the buyer.

### Slide Content

Use three proof points:

- Product velocity: the current application already includes onboarding, demo generation, approval, posting, dashboards, admin ops, cost controls, and runbooks.
- Workflow depth: the team has solved the unglamorous parts that AI demos usually skip: retries, approval security, provider disconnects, cost ceilings, admin exception handling, and launch runbooks.
- Sales proximity: the GTM motion is designed around real local-business reviews, so each sales call creates concrete product proof.

If co-founders have relevant background, add:

- Founder/customer insight.
- Technical execution experience.
- Sales or local-business distribution advantage.
- Any advisor or partner access.

### Visual

Use a simple team slide:

- Headshots and roles if available.
- Under each person: one line of relevant proof, not generic biography.
- Side rail: "Built product depth before scaling sales."

### Speaker Note

"The product is not a thin demo. A lot of the work is invisible reliability and workflow handling. That is part of the team's advantage."

### Proof Needed

Fill in real team bios, prior wins, domain access, and advisor names. Do not invent credentials.

## Slide 19: The Ask

### Job Of The Slide

Tell each audience exactly what decision you need.

### Suggested Headline

What we need to unlock the next milestone.

### Slide Content

For co-founders:

- Approve the pilot scope and launch gate checklist.
- Decide final pricing and Premium packaging.
- Assign owners for ops, sales, customer onboarding, and product polish.
- Agree on success metrics for the first 30 days.

For sales:

- Build the first target list.
- Run review audits.
- Book demo calls using the prospect's own reviews.
- Track objections and conversion metrics.

For investors:

- If fundraising: state the amount, runway, use of funds, and milestone unlocked.
- If not fundraising yet: state what proof you will bring back after the pilot.

### Visual

Use three columns:

- Product/ops ask.
- Sales ask.
- Capital/advisor ask.

### Speaker Note

"The immediate goal is not abstract growth. It is a controlled pilot that gives us activation, retention, unit economics, and sales conversion data."

### Proof Needed

Fill in fundraising amount and use-of-funds only if you are actually raising.

## Slide 20: Closing

### Job Of The Slide

Leave the audience with one memorable belief.

### Suggested Headline

Every local business deserves a thoughtful public reply to every customer.

### Slide Content

Short closing:

- Reviews are public, permanent, and high-intent.
- Owners want to respond well, but the workflow is too heavy.
- RepWorth makes the right response fast, controlled, and measurable.

### Visual

Show a final before/after:

- Before: unanswered review or generic response.
- After: specific owner-approved response, posted quickly, with weekly insight.

### Speaker Note

"RepWorth is not selling AI text. We are selling reputation follow-through."

### Proof Needed

Use a real or clearly labeled sample review/response pair.

---

# Appendix A: One-Minute Demo Script

Use this when the deck turns into a live presentation.

1. Open with a real or sample Google review.
2. Show the AI draft.
3. Point out specificity: reviewer name, actual details, language matching, tone.
4. Click or show Approve, Edit, and Regenerate.
5. Show the owner dashboard: reviews handled, time saved, response rate, recent reviews.
6. Show the weekly brief: not just replies, but insight.
7. End with pricing: "This is why a business pays monthly."

Suggested words:

"Here is the whole product in one loop. A customer leaves a review. RepWorth writes a reply that references the actual experience. The owner approves it in seconds. Then it gets posted and the business gets a weekly read on what customers are saying."

# Appendix B: Sales Talk Track

## Opening

"I looked at your recent Google reviews. You have customers saying specific things that deserve thoughtful replies, but those replies take time. RepWorth writes the first draft, sends it to you, and posts only after you approve."

## Pain Questions

- "Who replies to your Google reviews today?"
- "How long does it usually take?"
- "Do you respond in Spanish or other languages when customers do?"
- "Do you ever copy-paste replies because you are busy?"
- "Would it help if you could approve a good reply from your phone in 30 seconds?"

## Demo Pivot

"Rather than talk about AI generally, let me show you what RepWorth would write for your actual reviews."

## Close

"The founding-member offer is simple: flat monthly price, setup help, and we handle the review-response workflow with your approval on every post."

# Appendix C: Common Objections

## "I do not want AI posting for me."

Response:

"It does not post without you. RepWorth drafts, you approve. You can edit or regenerate before anything goes live."

## "I can just use ChatGPT."

Response:

"You can use ChatGPT for one reply. RepWorth handles the workflow: detecting reviews, using your business context, sending approvals, posting approved replies, tracking status, and summarizing patterns every week."

## "I already have a reputation platform."

Response:

"Most platforms still leave the owner with a dashboard and a task list. RepWorth is focused on done-for-you reply workflow with owner approval."

## "What if the reply says something wrong?"

Response:

"You approve every reply. We also store avoid-facts and business context so the system knows what not to mention."

## "I do not want another dashboard."

Response:

"You do not need to live in a dashboard. The core loop happens through approval notifications. The dashboard is there when you want the bigger picture."

## "What if my Google connection breaks?"

Response:

"The system tracks connection state, queues approved replies if needed, and alerts you to reconnect. It is built for provider edge cases."

# Appendix D: Screenshot Checklist

Capture clean, non-sensitive screenshots from these surfaces:

- Landing hero with live review/reply demo.
- Features page AI drafting comparison.
- How-it-works four-step workflow.
- Business lookup / onboarding start.
- Pre-paywall demo response preview.
- Plan selection.
- Approval page with approve/edit/regenerate.
- Owner dashboard value summary and recent reviews.
- Weekly or monthly intelligence brief.
- Zernio connect or select-location flow.
- Past Replies page if enabled and populated with safe sample data.
- Settings channels page, especially Telegram if ready.
- Admin jobs page.
- Admin costs page.
- Admin demos page.

Before using screenshots externally:

- Remove customer PII.
- Remove private API keys, IDs, tokens, internal URLs, and debug text.
- Label sample data if it is sample data.
- Use the same sample business across the whole deck if possible.

# Appendix E: Investor Data To Collect Before Final Deck

Do not fake these. If the data does not exist yet, present the plan to measure it.

## Market And Customer

- Number of target businesses in first geography or vertical.
- Percent with unanswered recent reviews from manual audit.
- Average review volume by target segment.
- Existing spend on reputation, SEO, agencies, or review tools.
- Prospect quotes.

## Product And Activation

- Demo generation success rate.
- Average time to generate demo.
- Signup to payment conversion.
- Payment to connected reviews conversion.
- Time to first draft.
- Time to first approved reply.
- Approval, edit, regenerate, and ignore rates.

## Economics

- Average LLM cost per response.
- Average review-source cost per account.
- Messaging cost by channel.
- Infrastructure cost per active account.
- Manual support minutes per account.
- Gross margin by tier.

## Retention And Outcome

- Weekly active approval rate.
- Response rate before and after.
- Owner satisfaction quote.
- Weekly brief read or click behavior.
- Renewal or cancellation intent after pilot.

# Appendix F: Financial Model Inputs

Use these formulas in a simple model:

## Revenue

`MRR = active accounts * average subscription price`

`Average subscription price = weighted average of Founding, Standard, Premium`

## Variable Cost

`Monthly variable cost per account = LLM generation cost + review ingestion cost + publishing/provider cost + email/SMS/WhatsApp cost + storage/infra allocation`

## Gross Margin

`Gross margin = (subscription price - monthly variable cost per account) / subscription price`

## Support Load

`Support cost per account = manual minutes per account per month * hourly support cost / 60`

## Payback

`CAC payback months = CAC / gross profit per account per month`

## Expansion

Potential expansion levers:

- Premium tier for high-volume accounts.
- Multi-location accounts.
- Competitor monitoring.
- Ranking and local market reports.
- Agency/partner bundles.

# Appendix G: Technical Due Diligence Summary

Use this only when investors or technical advisors ask.

## Architecture

- Next.js App Router web app.
- Supabase/Postgres for durable product state.
- Redis/BullMQ for async jobs.
- Railway worker with Fastify ingress routes.
- `job_outbox` pattern for durable work dispatch.
- Zernio for Google Business Profile connection, ingestion, and publishing.
- OpenAI primary generation with Anthropic fallback.
- Resend for email.
- Stripe for payment.
- Twilio/Telegram paths for notification channels.
- Sentry for error tracking.

## Reliability Patterns

- Idempotent outbox entries.
- Queue retries.
- Failure hooks for terminal provider errors.
- Cost reservation/finalization.
- Reconnect flows for Zernio.
- Admin exception notifications.
- Runbooks for smoke tests and launch.

## Security And Trust

- Owner approval before posting.
- Tokenized approval links.
- Device and CSRF protections.
- Redaction in Sentry paths.
- PII-aware webhook handling.
- Terms and privacy pages.

# Appendix H: Audience-Specific Slide Cuts

## Investor Cut

Use:

1. Cover.
2. Company in one sentence.
3. Problem.
4. Why now.
5. ICP.
6. Market opportunity.
7. Solution workflow.
8. Product demo.
9. Differentiation.
10. Business model.
11. GTM.
12. Status and pilot metrics.
13. Team.
14. Roadmap or Ask, depending on meeting length.
15. Appendix as needed.

## Co-Founder Cut

Use:

1. Cover.
2. Company in one sentence.
3. Product workflow.
4. Current product snapshot.
5. Status and launch gates.
6. Pilot plan.
7. Pricing decision.
8. GTM plan.
9. Roadmap.
10. Risks.
11. Decisions needed.
12. Appendix with technical and ops details.

## Sales Cut

Use:

1. Cover.
2. Problem.
3. Before/after review response.
4. How it works.
5. Live demo.
6. Owner control.
7. Pricing.
8. Objections.
9. Close.

# Final Recommendation

Build the first deck as a 14-slide investor/core narrative, then add appendix slides for technical depth and internal launch planning. The live demo should carry the product proof. The slides should carry the business logic.

The strongest version of this deck is not "AI writes review replies." It is:

> RepWorth owns the entire review-response workflow for local businesses, from detection to draft to owner approval to posting to weekly insight.
