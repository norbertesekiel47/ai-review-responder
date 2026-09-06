# RepWorth Brand Kit — for marketing content generation

> **What this file is.** The single reference an AI assistant needs to write
> on-brand RepWorth marketing copy. Upload it to a Claude Project as knowledge.
> It is condensed from `PRODUCT.md`, `docs/design/brand-story.md`,
> `src/components/sections/landing/*/*-copy.ts`, and
> `src/lib/accounts/tier-config.ts`.
>
> **Authority order.** `PRODUCT.md` wins over this file. This file wins over
> anything a model remembers. If they disagree, stop and ask.
>
> **Last verified against the codebase:** 2026-08-21.

---

## 1. What RepWorth is

RepWorth tends a small business's online reputation continuously, so the owner
does not have to. It watches for new Google reviews, triages the negative ones,
drafts a reply in the owner's voice, and brings that reply to a gate before
anything becomes public.

It is sold as two subscription tiers: **Copilot** (the owner approves every
reply) and **Autopilot** (bounded autonomy inside a policy the owner sets).

Success for the owner is **relief**: every review answered, nothing
embarrassing published, and their evenings back.

---

## 2. Positioning

**The first true AI agent for reputation — not a reply tool.**

- **Commodity claim (never lead with this):** "AI writes your review replies."
  Dozens of tools say this.
- **Differentiated claim (always lead with this):** **trusted autonomy.** A
  tireless agent works while the owner runs the business, and *nothing goes
  public without passing a gate*. The gated pipeline — draft → moderate →
  judge → approve or veto — is the part no competitor can honestly copy.

**Tagline of record:** *The AI agent for your reputation*

**Emotional register:** relief and trust. Never speed. Never tech.

---

## 3. Who we write for

Owner-operators of small and medium businesses that live on their Google
reputation — a café, a salon, a dental office, an auto shop. They work the
floor, not a desk. Reviews arrive while they serve customers. Replying is the
task that slips. Some run one location; some run several under one bill.

Secondary audience for public surfaces: investors and partners evaluating
RepWorth as an agent platform rather than a reply tool.

**Write to a person, not a segment.** "A café at 8 AM" beats "SMB owners."

---

## 4. Fixed vocabulary — do not rename, pluralize, or invent synonyms

> RepWorth · Copilot · Autopilot · Reply · Guardian · Insights · Solicitor ·
> Judge · Governor · trust dial · veto window · run spine ·
> **persona** (an acting agent) · **watchdog** (a supervising agent)

Capitalize agent names so they read as named characters, not verbs.

**Naming traps:**

- Guardian is a **persona**, not a tier. The tiers are Copilot and Autopilot
  only. Never write "the Guardian tier."
- The Judge is **not** "a second model." Every LLM task shares the same pinned
  model roster, so the Judge often runs on the same model that wrote the reply.
  The claim we can stand behind is that it is **a separate check, with its own
  prompt, that had no hand in writing the reply**.
- RepWorth is **not a chatbot**. Never use a chat bubble or assistant-avatar
  metaphor.

---

## 5. The fleet — what each agent does, and what may never be claimed

### Acting agents (personas)

| Agent | What it does | Can it reach the public? | Status |
|---|---|---|---|
| **Reply** | Drafts a response to every review as it lands, in the owner's voice. On Autopilot it can post the safe, positive ones inside the owner's rating band and daily cap. | The **only** agent that can publish, and only inside the owner's bounds. | Live |
| **Guardian** | Triages the negative lane by severity. Flags and escalates critical reviews to the owner. | **Never acts publicly.** That is its whole identity. | Live |
| **Insights** | A short weekly digest in plain language, every Monday. | Reports only. | Live |
| **Solicitor** | *Will* ask past customers for reviews in managed batches, honouring every opt-out. Never posts publicly. | Outbound only, never posts. | **NOT SHIPPED — future tense only** |

**Guardian trap:** never soften "never acts publicly" into "handles negative
reviews." That implies it responds to them. It does not.

### Supervising agents (watchdogs)

| Agent | What it does | Rule |
|---|---|---|
| **Judge** | Independently assesses every reply that posts without the owner. A run of poor verdicts is what the Governor watches for. | Reviews 100% of auto-posts. |
| **Governor** | Suspends an account's autonomy on its own if the picture stops looking right. Everything reverts to needing approval. | Suspends autonomy per account. |

**Judge trap:** the Judge governs **auto-posting only**. On Copilot the owner
approves and the Judge is not in that path. Never write "reviews everything
that goes out." The precise, true, strong version is:

> **If the supervisor is down, nothing posts on its own.**

### The run spine

Every action every agent takes is recorded on an auditable trail. "What did the
system do, and why?" always has an answer. Not a black box.

---

## 6. Shipped vs. not shipped — the one genuinely damaging mistake

Present tense is reserved for what ships today. Everything else is "will."

### Shipped today (may be stated in present tense)

- Google Business Profile reviews only. One provider integration.
- Reply, Guardian, Insights.
- The run spine (full audit trail).
- Both human-in-the-loop and machine-in-the-loop supervision.
- Judge and Governor.
- Copilot and Autopilot tiers. Autopilot is bounded by an owner-set rating
  band, a daily cap, and a 15- or 30-minute veto window.
- Negative reviews are never auto-posted. High-severity moderation flags are
  held, never notified.
- Multi-location, per-location overage billing, account-level digests.
- Approval by email, Telegram, or WhatsApp. No login required to approve.
- Card-up-front 30-day trial — **flag-gated, confirm before advertising.**

### NOT shipped — never claim in present tense

- **Solicitor.** Substantially built but **inert in every environment**. The
  send flag exists in no environment file. Future tense only, always.
- **Committed future direction** (frame as future, may be described
  concretely): CRM Manager agent, Social Media Manager agent, Fake Review
  Detection & Dispute agent, multi-platform expansion beyond Google.
- **Proposed only, not committed** (do not put in marketing copy at all):
  competitor benchmarks, voice-of-customer insights, review-bombing detection,
  local SEO agent, POS/booking triggers, staff recognition, agency
  white-label tier, shareable reputation score.

### Autonomy flags in production

All autonomy flags are **OFF in production**. Autopilot behaviour is real in
code and gated at runtime. Do not write copy implying customers are
auto-posting today. Describe Autopilot as what the owner can move to, not as
what is running.

### Launch posture

The stated public posture is **early access / waitlist**, not open self-serve.
Confirm the production flag state before any surface promises instant signup or
a free trial. The landing CTA label comes from the server, not from copy.

---

## 7. The three guarantees you may state flatly, unhedged

These are enforced in the system. No hedging needed.

1. **Nothing unapproved ever posts.**
2. **Unsafe drafts are held, never sent.**
3. **Autonomy can be suspended, automatically.**

---

## 8. The pipeline (use this when explaining how it works)

> ingest → Guardian triages → Reply drafts → moderation (unsafe drafts held) →
> approval (owner on Copilot, or every automated gate plus the veto window on
> Autopilot) → posted → Judge verdict

Four of those seven steps are safety steps. **That ratio is itself a message.**

---

## 9. Pricing and tiers

| Tier | List | Founding | Locations included | Extra location |
|---|---|---|---|---|
| **Copilot** | $29/mo | $19/mo | 1 | $15/mo |
| **Autopilot** | $69/mo | $49/mo | 1 | $20/mo |

- Copilot = the owner approves every reply.
- Autopilot = bounded autonomy: owner-set rating band, daily cap, veto window.
- Card-up-front 30-day trial exists in code but is **flag-gated**.

**Do not publish prices without confirming them first.** Stripe prices are
grandfathered per account and the tier cutover is not complete in production.

---

## 10. Voice

**Plain, warm, direct, specific. Owner-to-owner.**

### Banned outright

> unlock · supercharge · seamless · AI-powered · next-generation ·
> revolutionize · transform your workflow · leverage · robust · powerful ·
> game-changing · effortless · elevate

### Rules

1. **One thing per piece.** Prove the core story deeply, then widen at the end.
   A piece that says "we do everything" says nothing.
2. **Specific beats abstract.** Real review text, real states, a real trade-off.
   Never a generic business, dashboard, or metric.
3. **No fabricated proof.** There are no customers, testimonials, case studies,
   press mentions, partner logos, or publishable metrics to cite. **Do not
   invent any.** Credibility comes from showing the mechanism honestly.
4. **Roadmap items as verbs, not icons.** "Get reviews · Flag fakes · Watch
   everywhere" — verbs read as agency; icon grids read as a pricing page.
5. **No em-dash pileups, no rhetorical questions, no "Here's the thing."**
6. **Numbers only when true.** "100% of auto-posts" is true. Anything about
   customer counts, hours saved, or rating lift is not.

### We say X, not Y

| Say | Not |
|---|---|
| Use the product | Leverage the platform |
| Nothing posts without your say-so | You stay in control |
| Every review gets a response | Never miss a review again |
| A café at 8 AM | Businesses of all sizes |
| Reviews answer themselves at 3 AM | 24/7 automated coverage |
| The gate | The approval workflow engine |

---

## 11. Approved copy — real lines from the live site

Match this register. These are shipped, reviewed, and accurate.

**Hero**
> One fleet of agents. Your whole reputation.
> Each agent has one job. Independent watchdogs supervise the ones that act.
> Google reviews, end to end, today. Growing to everywhere else you show up.

**The fleet**
> The two above supervise the ones below. Nothing posts on its own unless they
> are watching.

**The trust statement (the strongest line RepWorth owns)**
> If the supervisor is down, nothing posts on its own.
> Judge availability is a precondition for posting without you, not a
> nice-to-have. When it cannot run, replies wait for your approval instead.

**Personas**
> Reply — Every review gets a response, in your voice.
> Guardian — The bad ones reach a human. Always.
> Insights — Every Monday, you know exactly what happened.

**Watchdogs**
> Judge — Reviews the machine's work, not yours.
> Governor — The kill switch that does not wait for you.

**Vision**
> The AI reputation department every business deserves.
> No small business can staff a review team, a CRM, a social manager and a
> fraud-dispute process. The ambition is to be all of it.

**Closing CTA**
> Hand your reviews to a fleet that answers to you.
> Start on Copilot, where nothing reaches Google without your say-so.
> Move to Autopilot when you want to, not before.

**Footer blurb**
> A supervised fleet of agents for your business's reputation. Every action
> recorded, nothing published outside the bounds you set.

---

## 12. The story arc (use for any narrative piece)

1. **Chaos** — reviews pile up unanswered while the owner works.
2. **The agent steps in** — each review answered, in the owner's voice.
3. **Care and control** — the gate moment: checked, approved, released.
   *This is the signature beat. Give it stillness and weight.*
4. **Public reply** — answered publicly; replies are a public act.
5. **Compounding** — reputation assembles into an owned asset.
6. **Widening (final ~20% only)** — other platforms and capabilities warming up.
7. **Close.**

Audience variants:

- **Cold audience (outcome-weighted):** the owner gets their evenings back;
  reviews answer themselves at 3 AM; reply rate climbs while the lights are off.
- **Investors/partners (vision-weighted):** the first true reputation *agent* —
  perceives every review, decides with judgment gates, acts only with earned
  autonomy.

---

## 13. Format playbooks

### 13a. Ads and social posts

- **One claim per ad.** Pick one: the gate, the voice match, the 3 AM reply,
  Guardian escalation, or the Judge. Never combine.
- **Lead with the gate**, not with drafting. Drafting is the commodity claim.
- Headline length: 30 characters for Google Ads headlines, 40 for descriptions.
  Write to the limit; do not pad.
- **LinkedIn** converts best for SMB owners. Write owner-to-owner, first person,
  no thread-bait hooks, no "🧵", no numbered listicles.
- **No fabricated social proof.** No "join 1,000+ businesses." None exist.
- Ban: fake urgency, countdown language, "limited spots" unless literally true
  of the early-access list.
- End on a concrete next step matching the current posture (early access /
  waitlist), not "Sign up free" unless the flags are confirmed on.

### 13b. Email sequences

- **Subject lines: 4–7 words, lower-case-natural, no emoji, no "Re:" fakery.**
- First line must earn the open. No "I hope this finds you well."
- **One ask per email.** One link.
- Owner-to-owner voice, first person singular from a founder, not "the
  RepWorth team."
- Sequence shapes that fit the product:
  - *Cold outreach:* the 1-star that sat unanswered → the gate → early access.
  - *Onboarding:* connect Google → first draft arrives → approve one → set the
    trust dial.
  - *Nurture:* one agent per email (Reply, Guardian, Insights, Judge).
  - *Beta invite:* what is live today, what is not, what we want feedback on.
- **Compliance:** every non-transactional email needs a physical address, an
  unsubscribe link, and a privacy-policy link. Support address of record is
  `support@repworth.net`.
- Never imply the email is transactional when it is marketing.

### 13c. Long-form and SEO

- **Minimum 1,500 words for a blog post.** One post per week is the cadence.
- Programmatic page templates in plan:
  - `/respond-to-google-reviews-for-{vertical}`
  - `/{city}-reputation-management`
  - `/alternatives-to-{competitor}` (Birdeye, Podium, NiceJob, GoSite,
    Reputation.com)
- **Every programmatic page must have genuinely unique content** — a
  vertical- or city-specific intro and a vertical-specific FAQ. Spun content
  gets the whole domain flagged. If you cannot write something true and
  specific for a vertical, skip that vertical.
- **Comparison pages:** describe competitors factually from their public
  material. Never invent a competitor limitation. Our honest differentiator is
  the gate and the audit trail, not a feature-count table.
- Structure: one H1, descriptive H2s, answer the query in the first 100 words,
  then earn the rest.
- Include a real product screenshot or an explicitly labelled "illustrative"
  figure. Never an unlabelled mock.

---

## 14. Pre-publish checklist

Run this on every piece before it ships.

- [ ] No banned word from §10.
- [ ] No present-tense claim about Solicitor, CRM, Social, disputes, or
      non-Google platforms.
- [ ] No invented metric, customer count, testimonial, or logo.
- [ ] Agent names capitalized and used per §4. Guardian not called a tier.
- [ ] Judge described as governing auto-posts only.
- [ ] Guardian described as never acting publicly.
- [ ] Any price or trial claim confirmed against the current production flags.
- [ ] The CTA matches the current launch posture (early access / waitlist).
- [ ] One claim, not five.
- [ ] Reads like one person talking to another person.
