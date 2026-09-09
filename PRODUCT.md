# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owner-operators of small and medium businesses that live on their Google
reputation — a café, a salon, a dental office, an auto shop. They are working
the floor, not sitting at a desk: reviews arrive while they are serving
customers, and replying is the task that slips. Some run a single location;
some run several under one billing account.

Secondary audience for the same public surfaces: investors and partners
evaluating RepWorth as an agent platform rather than a reply tool.

## Product Purpose

RepWorth tends a business's online reputation continuously so the owner does
not have to. It watches for new Google reviews, triages the negative ones,
drafts a reply in the owner's voice, and brings that reply to a gate before
anything becomes public. Sold as two subscription tiers: **Copilot** (the owner
approves every reply) and **Autopilot** (bounded autonomy inside a policy the
owner sets).

Success for the owner is relief: every review answered, nothing embarrassing
published, and their evenings back.

## Positioning

**The first true AI agent for reputation — not a reply tool.**

The commodity claim ("AI writes your review replies") is available to dozens of
tools and must not lead. The differentiated claim is **trusted autonomy**: a
tireless agent works while the owner runs the business, and *nothing goes
public without passing a gate*. The gated pipeline — draft → moderate →
judge → approve or veto — is the part no competitor can honestly copy.

Tagline of record: **The AI agent for your reputation**

Emotional register: **relief and trust**, never speed or tech.

## Operating Context

- Reviews arrive from Google via provider webhook in near real time, with a
  safety-net poll roughly every five minutes.
- The owner is reached on the channel they chose — email, Telegram, or WhatsApp
  — with the review and the draft side by side, and approves, edits, or
  regenerates in one tap. No login required to approve.
- On Autopilot, a reply that clears policy posts itself after a veto window the
  owner sets (15 or 30 minutes); one tap stops it until the window closes.
- Insights delivers a short plain-language weekly summary on Mondays.
- Multi-location accounts have one billing parent and per-location settings.

## Capabilities and Constraints

**Fixed vocabulary — do not rename, pluralize, or invent synonyms:**
RepWorth · Copilot · Autopilot · Reply · Guardian · Insights · Solicitor ·
Judge · Governor · trust dial · veto window · run spine · **persona** (an
acting agent) · **watchdog** (a supervising agent). Capitalize agent names so
they read as named characters, not verbs.

**Shipped today**

- Google Business Profile reviews only. One provider integration.
- Four acting personas: **Reply** (drafts every response; the only agent that
  can ever publish, and only inside bounds), **Guardian** (triages the negative
  lane by severity and escalates critical reviews to the owner; never acts
  publicly — that is its whole identity), **Insights** (Monday weekly digest
  and monthly impact report; reports only), **Solicitor** (email review
  requests to the business's own customers in batches the owner approves —
  consent attested at upload, send-or-withhold decided per ask with a reason,
  one-click unsubscribe, permanent opt-outs; outbound only, never posts).
  **Solicitor's present tense is an owner decision of 2026-09-06**, made on
  the commitment to flip `SOLICITATION_WATCH_ENABLED` and
  `SOLICITATION_SEND_ENABLED` on in production (both on in staging; see
  `docs/runbooks/launch-flag-readiness.md`). Until that flip lands, the
  marketing describes staging-proven behaviour.
- The **Review QR**: one printable code per location that redirects a scan
  straight to the Google review form. No landing page, no contact capture,
  re-pointable server-side. Live in production, deliberately un-flagged.
- The owner dashboard: **Rep Pulse** (0–100, `rating/5·70 + responseRate·30`,
  no score while ramping), rating and volume trends, review velocity, weekly
  recap, agent activity, and the **Restraint tab** (the refusal ledger: what
  the system decided not to do, when, and why).
- The **run spine** — every action every agent takes is recorded on an
  auditable trail, so "what did the system do, and why?" always has an answer.
  Not a black box.
- Both **human-in-the-loop and machine-in-the-loop** supervision. Most tools
  have one or neither.
- Two watchdogs: the **Judge** (independent LLM review of 100% of auto-posts;
  its availability is a hard precondition for posting without owner approval)
  and the **Governor** (per-account autonomy suspension when verdicts slip).
- Two tiers: **Copilot** and **Autopilot**. Autopilot is bounded by an owner-set
  rating band, a daily cap, and the veto window. Negative reviews are never
  auto-posted; high-severity moderation flags are held, never notified.
- Multi-location, per-location overage billing, account-level digests.
- Card-up-front 30-day trial, flag-gated (`TRIAL_ENABLED`).

**Not shipped — must never be claimed present-tense**

- **Telegram and WhatsApp** as owner channels. Built; both flags off in
  production. Marketing says "by email" until they flip.
- **SMS** for anything. There is no SMS adapter; Solicitor sends email only.
- **Committed future direction** (frame as future, never as available): CRM
  Manager agent, Social Media Manager agent, False/Fake Review Detection &
  Dispute agent, multi-platform expansion beyond a single review source.
- **Proposed only, not committed** — directional texture, and only ever in a
  clearly labelled "exploring" treatment: competitor and benchmark
  intelligence, voice-of-customer → operations insights, crisis and
  review-bombing detection, local SEO / profile optimization agent,
  right-moment solicitation triggers (POS/booking integration), staff
  recognition signals, agency white-label tier, reputation score and
  shareable report.
- All autonomy flags are OFF in production. Autopilot behavior is real in code
  and gated at runtime.

**Three guarantees that may be stated flatly, unhedged, because they are
enforced in the system:** nothing unapproved ever posts · unsafe drafts are
held, never sent · autonomy can be suspended, automatically.

**The pipeline as it actually runs:** ingest → Guardian triages → Reply drafts
→ moderation (unsafe drafts held, not sent) → approval (owner on Copilot, or
every automated gate plus the veto window on Autopilot) → posted → Judge
verdict. Four of those seven steps are safety steps; that ratio is itself a
message.

**Naming to keep straight:** Guardian is a *persona*, not a tier. The tiers are
Copilot and Autopilot only. The older three-step autonomy ladder is historical;
current narrative and vocabulary live in the Brand Asset Library.

**Launch posture:** self-serve signup is flag-gated
(`SELF_SERVE_SIGNUP_ENABLED`, on in local dev). As of 2026-08-03 the owner's
stated public posture is **early access / waitlist**, not open self-serve.
Confirm the production flag state before any surface promises instant signup.

## Brand Commitments

Start with the [Brand Asset Library](docs/brand-asset-library/README.md) for
brand documents, reusable assets, and content-generation references. Current
marketing positioning and claim limits are owned by its
[positioning guide](docs/brand-asset-library/brand-guidelines/positioning.md).

- Name **RepWorth**; wordmark set uppercase with tracking.
- **Voice:** plain, warm, specific. No hype vocabulary — "unlock",
  "supercharge", "seamless", "AI-powered", "next-generation", "revolutionize",
  "transform your workflow" are banned outright.
- **SMB texture is concrete, not abstract** — a café at 8 AM, a salon, a dental
  office. Never a generic "business owner".
- **One thing per piece.** Prove the core story deeply, then widen at the end.
- **Roadmap honesty.** Unshipped capabilities may be *visually* gestured at
  (dim, "warming up") but never named in copy as present-tense. If roadmap
  items appear as text, use two-word verb phrases — "Get reviews · Flag fakes ·
  Watch everywhere" — because verbs read as agency while icon grids read as a
  pricing page.
- **Visual system:** the Island system (`docs/brand-asset-library/design-systems/island/DESIGN.md` —
  sage/teal/peach tokens, white `rounded-[3rem]` island on sage) is
  authoritative for every public surface, and the Warm Editorial Console
  (`docs/brand-asset-library/design-systems/console/DESIGN.md`) for the authenticated owner app; which
  system a file belongs to is routed by `docs/brand-asset-library/design-systems/README.md`. **Exception
  agreed 2026-08-03: the landing page (`/`) is deliberately unlocked** and may
  establish its own world; the rest of the site does not follow it unless the
  owner later says so.
- **Anti-slop guardrails** in `docs/brand-asset-library/design-systems/island/DESIGN.md` apply everywhere: no fabricated
  metrics, testimonials, logos, avatars, or customer names; no external icon
  libraries (inline SVG only); no purple/blue AI gradients, orb/blob
  backgrounds, or black-glass dashboards.

**Story of record:** the September 7 owner-effort narrative, channel playbooks,
and evidence requirements now live in the
[brand story](docs/brand-asset-library/brand-guidelines/brand-story.md).
The earlier agent-first arc remains archived for historical creative references.

## Evidence on Hand

**Nothing citable.** Confirmed by the owner 2026-08-03: there are no named
customers, testimonials, case studies, press mentions, partner logos, or
publishable usage metrics. Any customer-facing surface must earn belief from
the product itself, not from social proof, and must not invent proof to fill
the gap.

Real assets that do exist:

- The working product and its interactive demo route (`/demo`).
- **`/Users/norbertesekiel/Desktop/RepWorth-website-design-reference.md`** —
  the owner's authoritative content brief for the marketing site: the fleet
  framing, the vocabulary, the shipped-vs-future table, the tone rules, the
  narrative spine, and the pinned visual metaphors (a fleet of named roles, a
  pipeline with gates, a dial between control and autonomy, an oversight layer
  above an action layer) plus the one that is ruled out (a chat bubble or
  assistant avatar — RepWorth is explicitly not a chatbot). Its Solicitor
  shipped-status claim is corrected above; everything else stands.
  Source of that doc: `~/Desktop/RepWorth-overview-and-vision.md`.
- Hero video masters at `~/Developer/startups/RepWorth-media/masters/`
  (`heroVideo`, `hero2Video`, `hero3Video`, `hero3reverseVideo`,
  `landing-hero`) — moved out of `public/` on 2026-08-04, because everything
  under `public/` is uploaded and served on every deploy and nothing in the
  code referenced them. Only the served transcodes and posters remain in
  `public/video/`. `heroVideo.mp4` is 1920×1080, ~12s:
  retro-futurist solarpunk CG — a mint-green CRT-television character with
  antennae and a gold RW mark on its screen, perched on a mossy outcrop above a
  white terraced garden-city. Mint, gold, teal glow, verdant. A **third**
  register, distinct from both the Island system and the paper-collage video
  script, and it supplies a named agent character.
- Two site-ready lines from the owner's brief: *"The AI reputation department
  you could never afford to hire"* and *"We are not bolting on features. We are
  growing the fleet — while keeping the safety architecture that makes trusting
  AI with a business's public reputation actually defensible."*
- A 13-block hero video script, `RepWorth-hero-video-script.md` — currently in
  a warm-yellow / navy / coral / gold paper-collage register that is *not* the
  Island system and is not yet a brand commitment.
- Illustrative product figures already used on `/features` and
  `/how-it-works`, each carrying an explicit "illustrative" disclaimer. They
  are legitimate only with that disclaimer attached.

## Product Principles

1. **Lead with trusted autonomy, not with drafting.** "AI writes your replies"
   is the commodity claim; the gate is the claim that is ours.
2. **The gate is the signature beat.** Wherever the story is told, the moment of
   check-approve-release gets stillness and weight.
3. **Gesture at the roadmap; never claim it.** Present tense is reserved for
   what ships today.
4. **Proof comes from the mechanism, not from social proof.** With no citable
   customers, credibility is earned by showing the pipeline honestly.
5. **Specific beats abstract.** Real review text, real states, a real trade —
   never a generic business, a generic dashboard, or a generic metric.

## Accessibility & Inclusion

No product-specific standard has been set beyond the existing engineering
practice, which is binding: honor `prefers-reduced-motion` (the codebase has a
`usePrefersReducedMotion` hook and all reveal/scroll motion branches on it),
keep all content reachable without motion, provide accessible names for
interactive controls, mark decorative layers `aria-hidden`, and keep text
contrast and mobile layout usable.
