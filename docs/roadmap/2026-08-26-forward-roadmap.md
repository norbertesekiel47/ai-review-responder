# Forward roadmap (locked order, 2026-08-26)

Owner decision 2026-08-26: the next four product efforts run in this order —
**(1) event-triggered review requests → (2) reputation recovery workflows →
(3) review-topic ontology → (4) Business Truth + policy layer.** Phases 5–8
are sequenced after them and may be re-ordered later. Launch enablement
(Phase 0) is not owned here — it is the existing §8.4 gate list in the design
of record and runs on its own track.

Each phase below states: goal, why this position in the order, what it builds
on (existing seams — reuse, don't rebuild), a scope sketch, explicit
non-goals, open design questions to settle in the grill, and success metrics.
Every phase starts with its own spec under `docs/superpowers/specs/` before
code.

---

## Phase 0 (parallel track): launch enablement — owned by design §8.4

Not roadmap work, listed for completeness: production bring-up (worker, Redis,
env matrix, webhooks, Vercel prod), prod WS8 cutover (`ws8-tier-cutover.md`,
resume at §6), owner UAT, ordered autonomy flag flips, solicitation prod flip
(needs counsel sign-off on the #620 Part II brief), GBP API application
follow-up. Copilot is launchable now with zero autonomy flags.

**Plus one product item pulled forward (owner decision 2026-08-26): QR review
requests ship BEFORE the production launch.** Scope: a per-location QR code
the owner can download/print, resolving through a RepWorth-owned redirect
route (same pattern as the existing `/r/google/<id>` redirect) to that
location's Google write-review link
(`https://search.google.com/local/writereview?placeid=…`). The RepWorth-owned
hop matters: it lets us count scans as an analytics event and re-point the
destination later (platform policy engine, Phase 6) without reprinting.
No contact capture in v1; every customer gets the same code (inherently free
of sentiment gating). Serves walk-in traffic — the F&B wedge — from day one.

---

## Phase 1 — Event-triggered review requests (connector layer)

**Goal.** A completed job/appointment/order in the customer's operational
system automatically becomes an eligible solicitation candidate, with no CSV
step. This is the wedge feature for all three verticals: "connect your booking
system once; RepWorth handles the rest."

**Why first.** (a) It removes the biggest friction in the highest-retention
loop (request → review → response → attribution — all of which already work
end-to-end on staging). (b) It is the embedding that creates switching costs.
(c) The design of record already names it as the CSV successor (§9.4). (d) It
is a prerequisite for good recovery (Phase 2) and graph (Phase 7) data:
customer/job linkage starts here.

**Builds on (do not rebuild).**
- Contacts/visits ledger + CSV contract (migrations 086/087, spec
  2026-07-23-contacts-csv-contract) — connectors write into the same ledger.
- `evaluateAsk` restraint policy + consent/suppression ledgers — eligibility
  and refusal logic is already the chokepoint; connectors only add candidates.
- Transactional outbox (invariant #2) + webhook ingress conventions
  (invariant #6: ingress terminates on Railway, signature first, raw payload +
  provider event ID persisted for replay).
- The `NormalizedReview` precedent (invariant #7): define an analogous
  **NormalizedVisitEvent** DTO so no connector-specific field leaks past the
  adapter.

**Scope sketch.**
1. Connector architecture: `worker/ingress/<provider>/` per provider, one
   adapter per system, each publishing a capability manifest
   (`can_receive_webhooks`, `can_poll`, event types supported).
2. Normalized event vocabulary (from the research memo, trimmed to what we
   consume now): `appointment.completed`, `job.completed`, `invoice.paid`,
   `order.fulfilled`; carry-through fields: customer name, contact handle,
   completion timestamp, optional staff/service note (exactly the CSV
   contract's columns — the ledger schema should not fork by source).
3. First adapters, one per vertical, chosen for OAuth + webhook quality and
   SMB share (verticals doc §4 has the full candidate tables): **Square
   Appointments** (beauty; already named in design §9.4), **Housecall Pro or
   Jobber** (home services), F&B deferred to a later adapter wave (see
   verticals doc — walk-in traffic makes POS events weaker candidates; the
   F&B wedge is reservation platforms + QR).
4. Owner connect flow (OAuth) + per-location mapping (provider location →
   `business_id`), following the Zernio connect precedent (ADR 0001 for the
   short synchronous OAuth-handshake carve-out).
5. Configurable delay between completion event and ask (waits ride the
   existing batch/drip machinery).
6. ~~QR-code review request page~~ — **pulled forward to the pre-launch
   track** (owner decision 2026-08-26); see Phase 0 above for the scope.

**Explicit non-goals.** Two-way sync into the CRM; generic Zapier surface
(candidate for later, not the wedge); F&B POS adapters in wave 1; SMS asks.

**Open design questions (settle in the grill).**
- **Consent basis for integration-sourced contacts.** CSV has an explicit
  owner attestation per upload. What is the equivalent for a continuous
  connector — a one-time attestation at connect, per-batch re-attestation, or
  provider-consent passthrough? Counsel touchpoint; this extends the #620
  brief. Suppression/unsubscribe semantics are unchanged (global wins).
- Poll vs webhook per provider; replay/idempotency key per provider event.
- Does a connector-sourced candidate auto-enter a batch, or accumulate for the
  owner's existing approval lane? (Interacts with
  `SOLICITATION_AUTO_APPROVAL_ENABLED` and, later, Phase 5 per-action grants.)
- Provider app-store listing requirements (Square/Jobber app marketplaces are
  also distribution channels — treat listing approval as part of the phase).

**Success metrics.** % of solicitation candidates that are integration-sourced
(target: overtakes CSV); median time from completion event to ask; request →
review conversion by source; # of connected locations per vertical.

---

## Phase 2 — Reputation recovery workflows

**Goal.** A negative review (or triaged complaint) becomes a tracked
**recovery case**: classified, linked to the customer/job where possible,
private follow-up drafted, resolution recorded, outcome measured. Public
replies stay what they are; recovery is the private, operational half.

**Why second.** It is the clearest differentiation against NiceJob/GatherUp
(they request and respond; they do not recover), it compounds with Phase 1
(customer/job linkage makes recovery personal), and it moves RepWorth from
marketing tool to operating workflow — the retention thesis.

**Builds on.**
- Guardian triage (severity classification already exists on the negative
  lane) and `review_escalations` (raise → notify → acknowledge/resolve) — a
  recovery case is the natural extension of an escalation, not a parallel
  system.
- Contacts/visits ledger + solicitation attribution (permanent
  `attributed_review_id` marker) — reviewer ↔ customer matching reuses the
  attribution machinery in reverse.
- Run spine outcomes — add recovery outcome kinds alongside
  `review_attributed`.
- Channels (email now; Telegram/WhatsApp owner notification already built).

**Scope sketch.**
1. `recovery_cases` table: opened from an escalation (or manually by owner);
   states `open → outreach_drafted → outreach_sent → awaiting_customer →
   resolved | unresolved | abandoned`; optional link to contact/visit row;
   complaint category (Phase 3's ontology slots in here later — v1 can use
   the triage severity + a small closed category enum).
2. Private outreach drafting (same generator seam, new prompt task in
   `LLM_TASKS`, cost-guarded) — always owner-approved in v1 (autonomy for
   recovery outreach is Phase 5 territory).
3. Owner surface: recovery inbox (cases needing action), case timeline.
4. Outcome recording: resolved/unresolved + free "what fixed it" note +
   whether the customer relationship was saved; spine outcome rows.
5. Compliance rails baked into the spec: RepWorth never asks the customer to
   change or remove the review, never conditions anything on sentiment, never
   routes happy/unhappy customers to different review destinations (FTC
   Consumer Reviews Rule + Google fake-engagement policy). The customer
   independently deciding to update their review is observed, never
   solicited. These are product invariants, same class as invariant #3.

**Explicit non-goals.** Compensation execution (refunds/vouchers — record that
the owner did it, don't do it); multi-assignee ticketing; SLA timers beyond a
simple stale-case nudge.

**Open design questions.**
- Guardian extension vs a fourth persona ("Recovery"). Lean: extend Guardian's
  graph with recovery steps and keep persona attribution honest (`guardian`
  raises, a distinct attributed step kind acts) — Guardian's "never acts
  publicly" invariant survives because recovery outreach is private. Decide in
  the grill; if a new persona wins, it needs run-spine + design-doc §8.3
  amendments.
- Reviewer↔customer matching confidence: exact contact-handle match vs fuzzy
  name match. v1 should probably be exact-or-manual to avoid wrong-customer
  outreach (worse than none).
- Where recovery lives in the tier packaging (Copilot vs Autopilot vs both).

**Success metrics.** % of ≤3★ reviews with an opened case; case resolution
rate; median open→resolved time; owner-reported saves; repeat-customer signal
where Phase 1 data allows.

---

## Phase 3 — Review-topic ontology (operational intelligence)

**Goal.** Every review's content is classified into a small per-vertical
ontology of operational topics with polarity, so the product can say "your
rating is 4.6, but arrival-time sentiment fell for the third straight month —
seven of the last 28 negative reviews mention lateness; the North location
accounts for five."

**Why third.** Recovery (Phase 2) creates the demand for classification;
doing ontology after recovery means one classification design serves both
(complaint category on cases = topic from the same taxonomy). It is also the
substance behind the Insights persona — today's digest is counts and
competitor gap; topics make it operational.

**Builds on.**
- The LLM task seam: one new `LLM_TASKS` entry (pinned model, cost-guarded,
  bounded tokens — same discipline as triage's ~200-token call).
- Review-content write sites (the same choke points that call
  `classifySentiment` — status-only writes stay untouched).
- `WeeklySummaryWorker` digest + dashboard KPI stack for surfacing.
- Verticals doc §3 — the three ontologies are drafted there; the spec freezes
  them as closed enums per vertical (a `businesses.vertical` column is a
  prerequisite — see cross-cutting below).

**Scope sketch.**
1. Storage: `review_topics` rows (review_id, topic, polarity, confidence) —
   multi-topic per review; append-only at review-content write time; batch
   backfill job for existing reviews (cost-bounded, per-account opt-in).
2. Classification call: single LLM call per review returning topics from the
   closed vocabulary only (schema-validated); deterministic fallback = no
   topics (fail-open, like moderation's posture — never block ingestion on
   classification).
3. Surfacing v1: digest section (top rising/falling topic per location) +
   dashboard topic-trend module (respect the Review-time anchor convention,
   ADR 0019).
4. Recovery integration: case category = topic (replaces the Phase 2 stopgap
   enum).

**Explicit non-goals.** Free-text theme discovery/clustering (closed ontology
first — it is comparable across customers within a vertical, which is also
the aggregate-data moat); cross-account benchmarks (later, and only
aggregate + anonymized).

**Open design questions.** Ontology governance (who can add a topic — treat
like the withhold-reason enum: closed, versioned); minimum review volume
before trend lines show (avoid noise for 5-review accounts); multilingual
reviews.

**Success metrics.** Topic coverage (% of text reviews with ≥1 topic); owner
engagement with topic digest lines; % of recovery cases auto-categorized;
LLM cost per classified review.

---

## Phase 4 — Business Truth + policy layer

**Goal.** Upgrade the Brand Brain from voice parameters to a structured
**Business Truth** (facts) + **Reputation Policy** (rules) layer, and attach a
per-draft "**why RepWorth wrote this**" explanation. This is what makes
autonomy explainable and drafts factually safe.

**Why fourth.** Phases 1–3 generate the operational context this layer
consumes (jobs, cases, topics). It is also the direct enabler of Phase 5:
per-action autonomy is only trustworthy when the policy the agent followed is
inspectable.

**Builds on.**
- Existing brand columns (`tone`, `products_services`, `staff_names`,
  `highlight_facts`, `avoid_facts`, `sample_responses`) — migrate/absorb, do
  not run two brand systems.
- Voice learning + edit-distance loop (unchanged — voice is HOW it sounds;
  truth/policy is WHAT it may say).
- Prompt policy versioning (`prompt-policy.ts` hash on `api_costs`) — the
  truth/policy snapshot used per draft should be versioned the same way.
- Judge — verdicts get the same policy context the generator had.

**Scope sketch.**
1. `business_facts`: services (structured), hours, cancellation/refund/
   warranty policy text, promotions (with expiry), customer-service contacts.
2. `reputation_policies`: tone, forbidden phrases, customer-name usage,
   apology policy, compensation-mention limit (drafts never offer
   compensation unless policy authorizes a bounded offer), per-category
   approval requirements, legal/medical/safety escalation triggers.
3. Explanation: generated with each draft, stored on the `responses` row
   (NOT in run-spine detail — the spine carries no raw text), rendered in the
   approval UI and the auto-post FYI.
4. Settings surface for owners; sensible defaults so an empty Truth layer
   degrades to today's behavior.
5. Feed points: prompt builder, Judge context, `evaluateAsk` context,
   recovery outreach drafts.

**Explicit non-goals.** Auto-ingesting facts from the website/GBP profile
(nice later); fact-checking drafts against the web; per-staff policies.

**Open design questions.** Fact staleness (promotions expire — expiry field +
digest nudge vs hard TTL); how much of the ontology (Phase 3) seeds default
policies per vertical; whether explanation generation is a second LLM call or
same-call structured output (cost).

**Success metrics.** Edit distance trend after truth/policy adoption (should
fall); % of drafts carrying an explanation; policy-violation Judge flags
(should fall); owner activation of the settings surface.

---

## Phase 5 — Per-action autonomy levels

Extend the trust dial from "rating band + daily cap" to an autonomy matrix:
positive-review replies / negative-review replies / review requests /
recovery outreach each get **full autonomy | ask me** per account. Builds on
`auto_approval_policies` (server-owned, invariant #14), `tierGrantsAutopilot`,
and the existing flag-level lane split (`SOLICITATION_AUTO_APPROVAL_ENABLED`
becomes a per-account grant behind the same runtime flag). Includes the two
items design §9.4 already sequences: **Judge auditing of withhold decisions**
and **Governor per-gate suspension** (the Governor suspends one action class,
not the whole account). This is also the marketing artifact: the autonomy
matrix screenshot IS the governed-autonomy pitch.

## Phase 6 — Platform expansion + platform policy engine

Second `ReviewSource` + second `ReviewPublisher` adapter (the seam was built
for this). Direct **GBP adapter** when API access lands (application pending;
`google_review_name` capture since migration 070 keeps the path open) —
reduces Zernio dependency and its pay-per-use posting cost. Then per-vertical
platform priorities (verticals doc §5): Yelp as **monitor + deep-link only**
(Yelp prohibits solicitation — encode that), Facebook selectively, Tripadvisor
monitoring for F&B. Ship the **platform policy engine** with the first new
platform: every adapter declares capabilities AND solicitation policy, and
`evaluateAsk` consumes it (a Yelp destination is a withhold reason).

## Phase 7 — Reputation graph queries + Impact page

No new collection infra — read models over what Phases 1–4 accumulated:
staff-level feedback (staff_names × topics), service-level sentiment,
location comparisons, request→review→recovery funnels. Plus the owner-facing
**Impact page** with conservative attribution only (reviews received,
velocity, response coverage, median response time, requests sent/converted,
cases opened/resolved, customers recovered, time saved). No revenue claims
without defensible causality.

## Phase 8 / later

Competitor-intelligence expansion (snapshots + digest line exist — add
trends/alerts), website social-proof widgets, AI-search visibility, public
API + **MCP server** (read-first, action-classed authorization; explicitly
after the internal tool layer is clean — MCP is an interface, not the agent),
agency/white-label. From design §8.5: calibrated-confidence router,
conversational surface, cross-agent coordination keys, outcome billing.
The agentic subset of this list (API/MCP, confidence router, conversational
surface, A2A) is sequenced with rationale in
`2026-08-26-agentic-architecture.md` §3–§4.

---

## Cross-cutting items (not phases)

- **`businesses.vertical` column** (closed enum: `home_services`,
  `food_beverage`, `beauty_personal_care`, `other`) — prerequisite for
  Phase 3 ontologies, vertical defaults in Phase 4, and vertical analytics.
  Small migration; do it with Phase 1 (connectors also want it for adapter
  suggestions). Follow the `new-migration` skill.
- **Pricing decision** (open, see README): live $29/$69 per account vs the
  memo's $79/$149 per location. Inputs to the decision: Phase 1–2 shipped
  value, founding-customer runway (deadline 2027-01-01), competitor anchors
  (GatherUp $60/loc, NiceJob $75, Reputation $80/loc). Grandfathering
  infrastructure makes repricing safe for existing accounts.
- **Free reputation-audit funnel** (acquisition, sequence anytime): rating vs
  nearby competitors, review volume/velocity, unanswered reviews, response
  time. Most ingredients exist (SerpAPI local pack via competitor snapshots,
  KPI fragments). Marketing-owned; respect the existing-routes rule before
  building pages.
- **Per-vertical counsel review** rides each phase that touches outreach
  (Phase 1 consent basis; Phase 2 recovery language; F&B/beauty specifics in
  the verticals doc).
- **Cadence jitter** (design §8.2 open item) — pre-scale, before any account
  posts at volume.
- **Positioning rollout** (owner-approved 2026-08-26) — see
  `2026-08-26-positioning-governed-autonomy.md`; copy changes are gated on
  the prod autonomy flips for any "live autonomy" claim.

## Sequencing picture

```text
Track A (launch):   QR review requests → §8.4 bring-up → flag flips → solicitation prod flip
Track B (product):  P1 connectors ─→ P2 recovery ─→ P3 ontology ─→ P4 truth/policy ─→ P5 autonomy matrix
                                                                             │
                                                                             └── P6 platforms → P7 graph/impact → P8 later
Track C (market):   governed-autonomy positioning → free audit funnel → vertical landing pages
```

Tracks run in parallel; Track B order is the locked owner decision.
