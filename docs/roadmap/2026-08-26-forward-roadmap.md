# Forward roadmap (created 2026-08-26; revised 2026-09-20)

The owner approved the September 7 focus and the September 11 operator revision.
The September 20 revision folds the former `owner-operator/vision.md` into
[the last section](#owner-operator-stages-beyond-version-1) and corrects
operator status statements; it changes no priority or gate above.
The next month focuses on proving one useful workflow for one customer type.
The Phase 1–8 labels below stay stable for existing references. They identify
areas of work, not a mandatory order or a pre-launch feature checklist.

## Immediate priorities: September 7–October 7

**Start here this week:** establish the cash deadline, prepare a concrete
paid offer for owner-approved conversations, and observe one actual beta
workflow. Further building depends on what those steps reveal. The feature
sketches below are a reference appendix, not this week's task list.

The owner clarified four founders on September 7: CEO/CTO owns product and
engineering; COO prepares the pitch, pitches with the CEO and owns customer
operations; CFO owns finance and supports CMO; CMO owns marketing. Each is
available 40–60 hours weekly; the [role assignment draft](2026-09-08-founder-90-day-plan/README.md)
plans around 40. Actual beta composition and the
amount/date of cash needed are still unknown. The owner reported a one to
two month runway and wants owner time saved as the primary customer outcome,
with bookings/revenue evidence where it can be supported.

| Work | First action | Evidence and decision |
|---|---|---|
| Cash and funding: CFO owns cash/model; COO owns pitch/process with CEO | Record cash, obligations, minimum founder support, cash-needed date, and available hours. Prepare a short product demonstration and investor questions. | Track actual paid decisions and investor feedback, including who can decide and when money could arrive. Interest alone is not cash. The owner approves outreach and spending. |
| Beta value: COO owns delivery/evidence; CMO owns buyer discovery; CEO joins product observations | List active beta accounts, their business type/software, review volume, and the work they currently do. Select one customer type for this month's improvement. | Compare owner effort before and with RepWorth, including review/correction/support time. Record continued use, reasons for leaving, and willingness to pay while honoring beta promises. |
| Product delivery, led by founder | Observe an actual workflow and select the single problem that most blocks its usefulness or paid adoption. | Deliver one bounded improvement with evidence from the affected journey and backend where applicable. Continue only if it addresses the observed problem. |

**Cash decision sheet, due September 8 or sooner if obligations require it.**
The CFO records unrestricted cash, dated obligations, minimum founder
support, and the smallest amount needed for an explicitly chosen continuation
period (start by calculating three months). List candidate sources separately:
paid continuation/pilots that honor existing beta promises, known angels or
investors, reduced outflows, and optional founder income. Each row needs a
named prospect or decision-maker, amount, conditions, earliest credible
clearing date, owner, and next action. Unknowns stay unknown. Rank paths by
cash arriving before the deadline and amount covered; one subscription does
not necessarily fund continuation, and cold fundraising has no assumed close
date. Add a required line: **sources that can credibly clear before the
cash-needed date**, with the amount each covers. If it is empty, bring the
smaller-scope/pause decision to the CEO and founding team that day. If the cash date is
unknown, label the funding test unresolved and seek the missing input that
day. Investor conversations can build a later pipeline; include them in the
near-term cash case only when evidence supports their timing and amount.
Prepare one batch of specific outreach drafts for the owner's approval.

The active beta/prospect roster is also due September 8. Separate interested
prospects, participating beta accounts, and paying customers. Cap the first
pass of investor brief/demo preparation at **two combined CEO/COO
hours**, provisionally, using existing material; lower it if capacity
requires. Record any need to exceed it as a decision, not an automatic deck
or film project. Conversations and follow-up use separately confirmed
capacity; this preparation cap is not a forecast of fundraising effort.

**Early gates:** by September 14, seek at least one actual paid decision
from a suitable prospect or beta user, within the promised beta terms, and
record whether an appropriate investor conversation is booked, declined, or
still unavailable. These are targets, not reported results or permission to
send. Review cash again September 21. Bring either gate forward if the cash
sheet requires it; October 7 is the product review, not the first cash review.
Choose a decision buffer based on the lead time needed to reduce commitments
or arrange income/support, and make the continuation decision before cash
runs out. A week is only a starting assumption, not a sufficient buffer in
every case. On September 8 the CFO proposes, and the CEO records with the founding team,
one continuation decision date: cash-needed date minus the chosen buffer.
If those inputs remain unavailable, use September 21 as the provisional
decision meeting date and surface the unresolved cash risk immediately;
that date is not evidence the company can afford to wait until then.

Prepare three costed options on the same sheet: funded continuation, a
smaller operating scope, or a development pause with an explicit beta-support
and data-handling plan. Specify which obligations change, the amounts/dates,
who would carry the work, and the trigger for requesting the decision. The
founders choose and approve the action; no service cancellation, outreach,
spending, or shutdown is authorized by a missed target. At the decision date,
record the chosen option or an explicit deferral, its reason, owner and next
date. If no decision is made, keep new discretionary feature work and new
spending commitments on hold; continue only existing authorized obligations
and surface the unresolved decision. Do not automatically cancel services
or change beta promises. Missing cash inputs mean continuation is unresolved,
not implicitly affordable.

Use the first week for the baseline, customer and investor feedback, and
scope selection. Work on cash and beta learning can run in parallel. Keep
engineering to one active improvement; UI fixes enter that scope when they
block setup, trust, or completion of the chosen workflow.

**One improvement was selected (2026-09-11) and is built:** the
[owner-operator v1](2026-09-11-owner-operator.md), under its named
60-hour exception. Its status line owns build, environment and pilot state;
the owner pilot, not the build, is the customer proof. For any other
candidate, hold the 20 default hours in
reserve until a paid decision or a named account's stated barrier to paying
identifies the work, an observed blocking quality failure prevents delivery
of an existing beta promise, or the CEO selects a bounded hypothesis
experiment against a repeated observed owner burden. The experiment must name affected
customers, the current workaround, a falsifiable expected improvement, its
cost/capacity ceiling, and a stop/continue decision. Customers need not request
chat, but a generic wish for modern features does not qualify. If nothing
meets this test, choose no new feature and use available
time for the demonstration, customer learning, and funding work. Baseline
observation need not delay a
paid-offer discussion. Owner-recalled effort can guide the choice, clearly
labeled as recollection; it cannot establish measured savings.

Use **20 founder engineering hours total** as a provisional planning cap for
the first improvement, including discovery, implementation, tests, and
browser/backend verification. Confirm capacity first and lower the cap if
needed. Integration discovery starts only after the same selection test and
uses at most four of those hours; it must
establish real API access, usable customer/contact data, and an eligible
trigger before connector implementation is selected. This is a ceiling, not
a commitment to use the hours or an estimate that a connector fits. A failed
discovery ends that candidate rather than expanding the month's workload.
A planning, memory and tool-execution platform does not fit this cap.
**Named exception (approved 2026-09-11):** the
[owner-operator v1](2026-09-11-owner-operator.md) carries its own
60-hour ceiling, 30 committed and 30 conditional on its checkpoint. The
20-hour default stays for every other improvement. **Hours actually used
are not recorded (noted 2026-09-20).** The spec's own estimate was 70–85
hours and the post-checkpoint items were also built, so this page does not
claim the ceiling held. The CEO records the figure when known; no number is
inferred here.

At selection, write down the affected accounts, baseline problem, expected
change, acceptance criteria, owner, and review date. Review weekly and at
October 7. If review volume is too low, report insufficient evidence; a
simulated demo or the dashboard's fixed seven-minute estimate does not prove
customer savings. Use a few comparable real observations and a simple
worksheet; do not build a measurement system. Record a paid yes/no and the
reason alongside the effort evidence. Work previously ignored counts as
additional coverage, not time saved. Measure onboarding effort separately
and show it alongside ongoing effort and RepWorth's support time. Do not
infer saved bookings from a QR scan or a resolved case.

Each workstream's weekly report has five lines: **done / blocked / next /
evidence / risk**. Link the evidence; document preparation is distinct from
customer value or funding achieved. Re-run two Claude challenge rounds at
each workstream's completion or major strategy checkpoint, recording the
three strongest objections per round and what changed.

## Dependencies and later decisions

- Start collecting customer-value evidence now. A full Phase 7 dashboard
  can wait; a simple scorecard or existing report may be enough.
- Pull the minimum approved business facts and rules from Phase 4 forward
  before any recovery message depends on them. Unknown refund, warranty, or
  compensation terms must not be invented. Keep first recovery outreach
  owner-approved and customer identity confirmed.
- Select a Phase 1 connector only when beta evidence supports it. A
  connector can help identify jobs and contacts, but manual owner-confirmed
  links may be sufficient for an early recovery test.
- Add Phase 3 topic analysis when there are enough reviews and a recurring
  owner decision it can improve. More categories do not by themselves prove
  a defensible data advantage.
- After the first month, select further work at the 60- and 90-day
  checkpoints using customer evidence, cash availability, and capacity.
  Additional integrations, industries, and platforms are options, not
  advance commitments. If funding or affordable continuation is uncertain,
  the founders decide what to reduce or pause; this plan does not authorize
  an automatic shutdown.

### Bounded owner-operator experiment

**Selected 2026-09-11; built, with status owned by the
[Owner Operator spec](2026-09-11-owner-operator.md).** Test
whether a suitable owner will delegate one recurring reputation job through
ordinary language and continue using it with less coordination and
correction. The customer profile and
market capabilities belong in [verticals](2026-08-26-verticals.md#2-choose-the-first-customer-type-from-the-beta).
This is one possible first improvement, not a parallel project.

The complete hypothesis has five steps:

1. The owner describes one recurring job, desired result and constraints.
2. RepWorth proposes a concrete operating plan using supported operations;
   missing facts, scope and decisions are visible to the owner.
3. A labeled historical demonstration shows expected handling and one
   exception.
4. With explicit authorization through the applicable controls, the existing
   workflow completes an eligible real task and verifies its external result.
5. Subsequent eligible events follow the agreed plan. An owner correction
   changes later comparable work; unresolved items stay visible and receive
   an agreed next action or a recorded reason they cannot proceed.

**Selected form (2026-09-11): a software v1.** The spec is the
[Owner Operator spec](2026-09-11-owner-operator.md). One model
call per turn produces typed proposal cards; the owner applies each card;
the existing engine does the work. The model calls no tools and writes no
settings. The spec's §4 owns the operation catalog; this page does not copy
it. Steps 1–3 are the staging checkpoint at 30 hours; steps 4–5 are the
owner pilot with a real account from the COO roster. Step 3 is delivered as
the spec's consequence line (§3.5): a server-computed count over the
account's last 30 days of live-ingested reviews, stated as "eligible". It
shows expected handling from real history; it is not a worked example of an
exception, and no fabricated review is used.

First-party conversation uses the owner's scoped identity and narrow domain
operations; it does not depend on a public API/MCP platform. Events and
schedules continue the work after the conversation ends.

Use the existing COO customer record and shared scorecard. Record baseline
effort, accepted scope/rules, eligible and correctly completed work, missed or
unresolved work, owner corrections, founder rescue, delivery cost, and paid
decisions. Label each result as simulated, manual, automated, or externally
verified. Start observation with the first case; measure setup separately
from ongoing effort. Agree comparison periods and success thresholds from the
actual workload before interpreting results.

Continue only when observations support useful delegation within the quality,
cost and support limits. Stop or revise if owners will not grant the required
authority, the job lacks recurring activity, data/access are unavailable,
repeated correction cancels the benefit, or scope cannot fit the approved
allowance. Low activity means insufficient evidence, not success or churn.
Onboarding satisfaction alone does not justify autonomous recovery, more
countries, or a general agent platform.

Every selected feature gets its own specification under
`docs/superpowers/specs/` before code. **Named exception:** the Owner
Operator spec lives in this folder as
[2026-09-11-owner-operator.md](2026-09-11-owner-operator.md), because it
was written with the roadmap decision and its run records cite that path.
The sketches below preserve useful future scope; selecting a small slice
does not commit the whole phase.

## Reference appendix: future feature areas

Use these sketches after a problem is selected. They do not add work to the
immediate plan or delay a customer/investor conversation.

---

## Phase 0 (parallel track): launch enablement — owned by design §8.4

Use the current launch runbooks and dated evidence to determine remaining
production setup, cutover, owner UAT, legal review, and feature-flag work.
The August snapshot is not a current launch-readiness check. Copilot can
operate without automatic posting, but its own launch requirements still
need verification. Product learning and legal/launch preparation can run
alongside each other; adding roadmap features is not a reason to postpone
the legal review again.

**QR remains part of launch verification, not a new connector task.** Code
now exists for the owner QR surface and `/q/[businessId]` redirect; see
[Review QR](../context/review-qr.md) and the
[current-state inventory](2026-08-26-current-state.md). Verify the intended
environment before calling it live. Scan counts are activity signals; they
do not identify a customer or prove a resulting review or booking. V1 gives
customers the same destination without sentiment screening.

---

## Phase 1 — Event-triggered review requests (connector layer)

**Goal.** A completed job/appointment/order in the customer's operational
system automatically becomes an eligible solicitation candidate, with no CSV
step. Requests still depend on consent, suppression, account settings, and
the applicable approval lane.

**When to select it.** Beta users show that repeated CSV preparation blocks
use or payment, they use the same supported system, and access to suitable
events/contact data is confirmed. Reduced manual work and better customer/job
linkage are hypotheses to measure. An integration alone does not establish
retention, switching costs, or exclusive distribution.

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
3. One first adapter for the selected beta customer type, chosen from the
   software those users use. Square Appointments, Housecall Pro, and Jobber
   are candidates, not approved builds or verified API-access commitments.
   The verticals document keeps the later options.
4. Owner connect flow (OAuth) + per-location mapping (provider location →
   `business_id`), following the Zernio connect precedent (ADR 0001 for the
   short synchronous OAuth-handshake carve-out).
5. Configurable delay between completion event and ask (waits ride the
   existing batch/drip machinery).
6. Reuse the existing QR feature where useful; its launch verification is
   in Phase 0.

**Explicit non-goals.** Two-way sync into the CRM; generic Zapier surface;
multiple adapters in the first improvement; SMS asks. An industry label does
not choose or exclude the first adapter; observed need and feasibility do.

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
- Provider access and app-store requirements: establish whether private
  beta use requires approval before committing. A public marketplace listing
  is a separate distribution experiment unless required for the selected use.

**Success metrics.** Owner preparation time before/after, eligible events
successfully processed, duplicates/incorrect sends, support burden, continued
use, and paid decisions. Record request-to-review attribution limits and
event-to-ask time. Integration volume alone is not customer value.

---

## Phase 2 — Reputation recovery workflows

**Goal.** A negative review (or triaged complaint) becomes a tracked
**recovery case**: classified, linked to the customer/job where possible,
private follow-up drafted, resolution recorded, outcome measured. Public
replies stay what they are; recovery is the private, operational half.

**When to select it.** Owners have recurring unresolved complaints and want
help following through. First confirm customer identity, approved business
facts/rules, contact eligibility, and owner willingness to approve follow-up.
GatherUp already documents [feedback tickets and customer follow-up](https://gatherup.com/blog/inbox/)
(checked 2026-09-07). RepWorth's opportunity is to complete a useful workflow
with less owner effort; a claim that competitors do not recover customers
is not established.

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

**When to select it.** There are enough real reviews to support a useful
pattern and owners can name a decision they would make from it. Recovery
categories and topic analysis can share a vocabulary when both are needed;
neither requires building all three industries' taxonomies first. The goal
example above is illustrative, not a result achieved by RepWorth.

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
first so results can be compared within the selected industry);
cross-account benchmarks. Any later cross-account use needs a defined
purpose, appropriate data permissions, privacy review, and enough data to
support the comparison. A shared taxonomy alone is not a data moat.

**Open design questions.** Ontology governance (who can add a topic — treat
like the withhold-reason enum: closed, versioned); minimum review volume
before trend lines show (avoid noise for 5-review accounts); multilingual
reviews.

**Success metrics.** Lead with whether classification improves the selected
owner decision or intervention: useful actions taken, correctly handled cases,
unresolved work and owner effort. Also track topic coverage (% of text reviews
with ≥1 topic), corrections, digest engagement, auto-categorized cases and LLM
cost per classified review. Classification or engagement alone is not value.

---

## Phase 4 — Business Truth + policy layer

**Goal.** Upgrade the Brand Brain from voice parameters to a structured
**Business Truth** (facts) + **Reputation Policy** (rules) layer, and attach a
per-draft "**why RepWorth wrote this**" explanation. This is what makes
autonomy explainable and drafts factually safe.

**Dependency, not fourth in time.** The minimum facts and policies needed
for a selected workflow come before messages that depend on them, especially
recovery outreach. Use existing brand fields where they safely suffice;
specify any missing structured fields in the bounded feature. Broader
settings, explanations, and topic-specific defaults can follow later.

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
4. Settings surface for owners; missing facts produce a neutral draft or a
   request for clarification, never invented policy terms. Do not let an
   empty configuration grant compensation or additional autonomy.
5. Feed points: prompt builder, Judge context, `evaluateAsk` context,
   recovery outreach drafts.

**Memory needed for the selected job.** Distinguish confirmed business facts
and rules, owner corrections/preferences, and actions with observed outcomes.
Record source, confirmation/version and expiry where relevant; an inference
or imported suggestion is not an owner-confirmed fact. Corrections may improve
later comparable work but never silently expand permissions. Keep raw content
out of the run spine; use existing authorized domain records and the customer
evidence record before proposing a general memory system. Cross-business
learning is a separate permission and evidence question.

**Explicit non-goals.** Automatically treating website/GBP content as business
truth; fact-checking drafts against the web; per-staff policies. A separately
scoped setup experiment may propose sourced facts for owner confirmation;
extraction is not included in the initial operator candidate by default.

**Open design questions.** Fact staleness (promotions expire — expiry field +
digest nudge vs hard TTL); how much of the ontology (Phase 3) seeds default
policies per vertical; whether explanation generation is a second LLM call or
same-call structured output (cost).

**Success metrics.** Factual corrections, repeated owner corrections, stale
facts, policy violations and ongoing supervision after adoption. Compare
equivalent eligible work and report the sample. Edit distance, explanation
coverage and settings use remain diagnostic measures; they cannot establish
that memory improved the job on their own.

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
not the whole account). Select this when owners need different permissions
for working features. Judge coverage, existing mandatory escalation rules,
and approval requirements still apply; the matrix cannot grant arbitrary
authority or substitute for measured reliability.

## Phase 6 — Platform expansion + platform policy engine

Second `ReviewSource` + second `ReviewPublisher` adapter, subject to the
provider's actual read/write permissions. Direct **GBP adapter** when API
access is confirmed (the August inventory records a pending application;
`google_review_name` capture since migration 070 keeps the path open).
It may reduce provider dependency; compare real costs and support effort.
Then consider per-vertical priorities (verticals doc §5): Yelp as **monitor + deep-link only**
(Yelp prohibits solicitation — encode that), Facebook selectively, Tripadvisor
monitoring for F&B. Ship the **platform policy engine** with the first new
platform: every adapter declares capabilities AND solicitation policy, and
`evaluateAsk` consumes it (a Yelp destination is a withhold reason).

## Phase 7 — Reputation graph queries + Impact page

Basic owner-value measurement starts in the immediate plan above. Select a
full owner-facing page when it would help a customer decide to keep using
RepWorth, and verify that the required data exists before promising it.
For the operator candidate, link the agreed job and rule version to the
action, owner correction, verified completion or unresolved state, and any
later observed outcome. Existing records and a worksheet may suffice. A run
record proves recorded activity, not a causal business effect.
Later read models can use what the selected workflows accumulated:
staff-level feedback (staff_names × topics), service-level sentiment,
location comparisons, request→review→recovery funnels. Plus the owner-facing
**Impact page** with conservative attribution only (reviews received,
velocity, response coverage, median response time, requests sent/converted,
cases opened/resolved, owner-reported customer recovery, measured or clearly
labeled estimated time saved). Reports must separate observed events,
owner reports, estimates, and outcomes attributable to RepWorth. No revenue
claims without defensible causality.

## Phase 8 / later

Competitor-intelligence expansion (snapshots + digest line exist — add
trends/alerts), website social-proof widgets, AI-search visibility, public
API and MCP tools, agency/white-label. A narrowly scoped read-only MCP pilot
may be selected earlier when a named user needs it and it fits capacity;
there is no automatic pilot after Phase 2. Write tools need separate access,
cost, and approval design. From design §8.5: calibrated-confidence router,
cross-agent coordination keys, outcome billing. The owner-operator candidate
above is independently selectable; a general conversational agent platform
is not committed. `2026-08-26-agentic-architecture.md` §3–§4 separates owner
interaction from external API/MCP and A2A work.

---

## Cross-cutting items (not phases)

- **`businesses.vertical` column** (closed enum: `home_services`,
  `food_beverage`, `beauty_personal_care`, `other`) — prerequisite for
  Phase 3 ontologies, vertical defaults in Phase 4, and vertical analytics.
  Add only when the selected feature needs it; do not create schema merely
  to record an interview choice. Follow the `new-migration` skill.
- **Pricing decision:** keep the current Copilot/Autopilot packages while
  testing paid decisions and cost to serve. The
  [current-state inventory](2026-08-26-current-state.md) points to configured
  prices; the [investor overlay](2026-08-29-investor-theses-overlay.md) owns
  the pricing hypothesis. Outcome billing is an optional later experiment,
  dependent on a measurable billable event and customer agreement.
- **Service promises and measurement:** define eligible work, the clock's
  start/end, owner approval delays, outages, and escalation behavior before
  promising a response time. Use the existing event records where sufficient,
  verify denominators, and collect missing evidence manually before building
  another dashboard. Automatic-action rate is useful only alongside owner
  effort, correction rates, missed work, and quality failures.
- **MCP pilot:** require a named user or integration, a repeatable job that
  needs agent access, and an agreed success test. Authentication, account
  scope, revocation, quotas, and verification are implementation work.
  Draft creation is excluded from a read-only pilot. Details:
  [agentic architecture](2026-08-26-agentic-architecture.md) §4.
- **AI-search visibility:** keep as a later option. Select a probe only if
  it would answer a customer decision and its cost and interpretation are
  understood. Agent-related market attention alone does not justify it.
- **Free reputation-audit funnel** (acquisition option): rating vs
  nearby competitors, review volume/velocity, unanswered reviews, response
  time. Most ingredients exist (SerpAPI local pack via competitor snapshots,
  KPI fragments). Use existing reports or a manual draft first. A new funnel
  competes with direct beta learning and fundraising preparation; respect
  the existing-routes rule before building pages.
- **Per-vertical counsel review** rides each phase that touches outreach
  (Phase 1 consent basis; Phase 2 recovery language; F&B/beauty specifics in
  the verticals doc).
- **Cadence jitter** (design §8.2 open item) — pre-scale, before any account
  posts at volume.
- **Positioning rollout** (revised 2026-09-07) — see
  `docs/brand-asset-library/brand-guidelines/positioning.md`; copy changes are gated on
  the prod autonomy flips for any "live autonomy" claim.

## Sequencing picture

```text
Cash/market:  actual cash dates + approved customer/investor conversations → paid decisions
Beta:         one customer type → baseline effort → observed problem → measure change
Engineering:  one selected improvement, including required facts/rules and verification
Launch:       current runbook gaps + legal review + environment verification
Later:        select from P1–P8 using evidence, dependencies, cash, and capacity
```

Cash/market, beta learning, and launch preparation can run in parallel.
Engineering stays sequential within the selected scope. The August fixed
order is superseded by the September 7 revision.

---

## Owner Operator: stages beyond version 1

_Written 2026-09-11 as `owner-operator/vision.md`; folded into this page
and reconciled with it 2026-09-20. Aspiration, not a plan, and no stage is
scheduled. The v1 spec is [2026-09-11-owner-operator.md](2026-09-11-owner-operator.md)._

**The vision in one line.** RepWorth becomes the reputation department a
small business cannot afford to hire. The owner talks to it like a trusted
manager. It does the work, shows the results, and earns more autonomy over
time.

**The gate every stage shares.** A stage's own signal below is necessary,
not sufficient. Each stage is also selected the way this page selects any
work: the stage before it shows useful delegation within the quality, cost
and support limits, with a recorded paid decision; and cash and founder
capacity are available at the 60- or 90-day checkpoint. Interest, usage or
onboarding satisfaction alone opens no stage.

### Stage 1 (v1): set up, adjust, and check on review replies by talking

The owner explains the job and the rules. RepWorth proposes cards. The owner
applies them. The existing engine runs. Unsupported requests are named and
recorded. Scope and status: the spec.

### Stage 2: the operator runs the whole job

- The model reads live state through tools and works in bounded steps.
- It covers three jobs: reply to reviews and ask customers for reviews (both exist in the engine; asks never depend on a customer's sentiment, per the Phase 2 compliance rails), and follow up privately with customers who complained (the recovery lifecycle is future Phase 2 work, not an existing job).
- It comes to the owner instead of waiting: a short morning message with what was done, what needs one decision, and what is still open.
- Corrections carry forward. "Never mention pricing" changes every later draft. Facts and rules become confirmed, sourced and versioned (Phase 4's memory for the selected job), not a general memory store, and a correction never expands permissions.

Gate: the v1 owner pilot shows continued use and fewer repeated corrections;
**and** an eval shows a tool-looping turn beats the one-call turn enough to
pay for its cost, latency and failure surface, with a loop spec that answers
[agentic architecture](2026-08-26-agentic-architecture.md) §6.4.
Architecture: a bounded loop and the tool-call seam (same page, §6.4–§6.5).

### Stage 3: the operator in the owner's pocket

- Telegram and WhatsApp already terminate on the worker. The owner approves, corrects, and asks from their phone.
- Requires: conversation delivery, sender-to-scope resolution, channel-appropriate confirmation. Sharing the turn handler is not enough.

Gate: owners ask for it, and the in-app operator has proven approval and receipt behavior.

### Stage 4: the operator understands the business, not only its reviews

- Connects to booking, point of sale, and the customer list. A complaint links to a customer, a visit, and an outcome.
- Spots repetition: "Scheduling complaints doubled on Tuesdays this month. Want me to flag it to your manager and follow up with the three customers?"
- Proposes fixes outside reputation.

Gate: a connector justified by observed owner burden and real access (the Phase 1 and Phase 3 selection tests above).

### Stage 5: RepWorth among other agents

- An MCP surface lets the owner's other tools and agents ask RepWorth questions, under scoped permissions and its own identity model. It starts as the read-only pilot in agentic architecture §4. Handing RepWorth work is a write surface: it needs its own access, cost and approval design, gives an MCP caller no extra autonomy, and does not expose sends or publishing before the internal lanes have production history.
- Agency mode: one operator manages many client businesses. Each business keeps its own account scope, rules and approvals; agency access is a separate grant per account, never a merged scope.
- New platforms and markets arrive as adapters to the same job, but none is a drop-in: each needs the Phase 6 access and policy check, and each market needs evidence for the full workflow ([verticals](2026-08-26-verticals.md): market capability evidence). Today `ReviewSource` and the publisher are still Google/Zernio-shaped.

Gate: for MCP, the §4 pilot conditions (a named user or integration with a
repeated task, a test client, acceptance criteria, capacity); for agency
mode, agency demand with paid continuation.

### The sky: earned autonomy

- Autopilot today is bounded: rating band, daily cap, veto window, Judge review of every auto-post, Governor per account. That structure is the ladder, not the limit.
- **Decided 2026-09-20: autonomy may widen automatically, but only inside a ceiling the owner set explicitly.** The owner's ceiling is the permission; RepWorth moving up to it on a good track record is not RepWorth granting itself more. It never passes the ceiling, it tells the owner when it moves, the Governor can still suspend, and the owner can pull it back in one sentence. This needs its own safety design under Phase 5 and representative reliability evidence first; accumulated logs alone do not establish it. Until then every widening is an explicit owner action, as in v1.
- A bet to test, not an established moat: with each owner's permission, what works for one salon could inform the next. Cross-business learning is a separate permission, privacy and evidence question (Phases 3–4), and no data yet supports the claim.
- Pricing could follow outcomes: recovered customers, reviews earned, hours returned. Design of record §8.5 reserves this and parks it; it stays an optional later experiment until a billable event, its attribution, costs and customer agreement are established. No revenue claim without defensible causality (Phase 7).

### What never moves, at any stage

- No public action without a recorded approval method: owner, or a server-owned policy. Never a conversation.
- Moderation stays an absolute veto. Judge availability stays a posting precondition; its verdict reviews every auto-post after publication.
- Every read and write stays scoped to the account it belongs to. Agency mode and cross-business learning add separately granted access; they never merge scopes.
- The model proposes and interprets. The server authorizes and executes. The owner holds the ceiling.

### Why the ceiling is high

The claim to test: incumbents sell a dashboard with AI features inside it,
and this path sells a colleague. The competitor evidence
(`docs/plans/2026-09-11-reputation-competitor-landscape.md`) shows the
incumbents already automate replies and offer self-serve setup, so the
difference must be proven on the complete delegated job, not asserted. The
dashboard becomes the receipt, not the product. The engine, the approval
gates, and the watchdogs already built are what make the colleague safe to
trust. v1 is the first rung, and it is the rung that tests whether owners
want to climb.
