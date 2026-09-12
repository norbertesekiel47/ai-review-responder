# Candidate industries (created 2026-08-26; revised 2026-09-11)

These three industries remain longer-term markets to explore. The owner
approved focusing the next month's improvement on **one customer type**,
chosen from the actual beta cohort. The choice is still open; this document
does not commit three parallel product or integration efforts.

1. **Home services** — HVAC, plumbing, electrical, roofing, landscaping,
   cleaning, pest control, garage doors, general contractors.
2. **Food & beverage** — restaurants, cafes, bars, quick-service, bakeries.
3. **Beauty & personal care** — hair salons, nail salons, facial/skin
   clinics, massage and spa centers, barbershops.

"Vertical" means a type of business. In the later product it can determine
which review-topic categories (Phase 3), connector adapters (Phase 1), policy
defaults (Phase 4), and marketing pages a customer gets. Keep shared behavior
in the core pipeline. A future `businesses.vertical` configuration field is
a proposal, not a prerequisite for choosing whom to serve this month.
Phase numbers are stable roadmap references, not chronological requirements.
Specialization should also define a complete recurring job: signal → verified
context → owner-authorized action → follow-up → observed outcome. Topics and
defaults support execution; they do not establish industry value by themselves.

## 1. Why these three

These are working reasons to consider them, to be checked with owners:

- Owners may rely on Google reviews when winning local customers.
- A completed job, meal, or appointment may provide a useful request moment,
  if the system exposes the event and eligible contact data.
- Owners may value having repetitive reputation work handled for them.
- Local, multi-location expansion paths exist (franchises, small chains).

Home services and beauty often have appointments or jobs associated with
identified customers. Walk-in food/beverage businesses may have no customer
contact record, making the existing QR feature more useful than a connector.
Confirm the actual workflow rather than assuming an industry label guarantees
review volume, identifiable contacts, or software access.

## 2. Choose the first customer type from the beta

Record each active beta account's buyer/operator, business type and location
count, recurring job/current workaround, country, owner/customer languages,
platforms/channels, software, actual activity, owner effort and acquisition
route in the shared COO record. Favor a group where:

- More than one accessible owner describes the same recurring problem.
- There is enough real activity this month to observe the workflow.
- The owners can use and evaluate the improvement during the beta.
- The necessary data and access are available within the engineering limit.
- Owners will discuss a concrete paid offer or explain why they would decline.

**Provisional buyer hypothesis (this section owns it; other pages link
here):** an independent owner with roughly 1–5 locations, subject to roster
evidence. A regional operations manager needs delegation across managers and
locations; an agency needs repeated client onboarding, client-specific
approvals and reporting. Those are separate buyer/workflow hypotheses, not
tiers of the same pilot. Existing customers keep their promised access
regardless of the discovery focus.

For the chosen group, write one operational example. An illustrative salon
case: recurring scheduling complaints → owner-confirmed context → approved
follow-up → a check on the unresolved case and later recurrence. Customer
linkage, permissions and any booking integration must exist first; fewer
later complaints alone do not prove RepWorth caused the improvement.

Use a simple account list and conversation notes; do not build a scoring
tool. If only one account is available, label its findings as a single case
and seek confirmation before expanding to the whole industry. If the beta
has no common type, choose the best-supported case rather than building
three versions. This development focus does not withdraw existing beta
access or promises from other users.

The August recommendation was home services → beauty → food/beverage. It is
superseded by this selection process. Higher job prices do not prove that a
review is worth more, that owners will pay more, or that workloads will be
safe. Square Appointments and Housecall Pro remain candidates named in the
earlier design; neither is a confirmed first build.

The [forward roadmap](2026-08-26-forward-roadmap.md) owns the first
improvement's capacity limit and review points. Keep other industries as
later options until the selected workflow earns continued use or payment.

## 3. Per-vertical review-topic ontologies (draft — Phase 3 spec freezes these)

Later candidate vocabularies, one per industry; do not implement all three
now. Select topic analysis only when there are enough reviews and an owner
decision it can help. Rules: ≤12 topics, mutually
distinguishable by an LLM at low token cost, each mappable to an operational
owner action. Polarity is recorded separately (a topic can be praise or
complaint).

### Home services

```text
scheduling            (booking friction, availability)
arrival_time          (late/no-show/window accuracy)
technician_conduct    (professionalism, courtesy)
communication         (updates, callbacks, explanations)
price_transparency    (quote vs invoice, surprise charges)
work_quality          (did the fix hold, craftsmanship)
cleanup               (site left clean)
warranty_followup     (callbacks honored, warranty service)
billing               (invoicing, payment friction)
office_staff          (phone/admin experience)
```

### Food & beverage

```text
food_quality          (taste, freshness, temperature)
order_accuracy        (right items, allergens respected)
service_speed         (wait to seat, wait to serve)
staff_friendliness
cleanliness
price_value
ambiance              (noise, seating, atmosphere)
reservations_seating  (booking honored, walk-in handling)
delivery_takeout      (packaging, courier handoff, accuracy)
menu_availability     (out-of-stock items)
```

### Beauty & personal care

```text
booking_ease          (online booking, rescheduling)
punctuality           (appointment started on time)
practitioner_skill    (cut/color/facial/massage quality)
consultation          (listened to what was asked for)
results_satisfaction  (outcome matched expectation)
hygiene_cleanliness   (tools, stations, premises)
pricing_transparency  (menu vs charged, upsell pressure)
product_pressure      (retail push during service)
ambiance
front_desk            (reception, checkout experience)
```

Staff attribution is optional. `businesses.staff_names` already exists;
only add extraction if actual reviews name staff often enough to support a
useful owner decision. Confirm ambiguous names and avoid ranking staff from
sparse or uncertain matches. Do not assume food/beverage reviews never name
staff, or that every industry needs a staff-level report.

## 4. Per-vertical connector targets (Phase 1)

Choose at most one first adapter for the selected customer type, based on
their actual software. The table records research candidates, not verified
provider capabilities, access, or promised integrations. Event names express
the intended normalized business events; verify the provider's native events
and semantics. The discovery budget and stop rule live in the forward roadmap.

| Vertical | Systems (candidates) | Trigger events | Notes |
|---|---|---|---|
| Home services | Housecall Pro, Jobber, ServiceTitan, Workiz | `job.completed`, `invoice.paid` | Check the beta account's product/plan, API eligibility, completed-job semantics, and contact fields. A marketplace listing does not guarantee distribution. |
| Beauty & personal care | Square Appointments, Fresha, Booksy, Vagaro, GlossGenius, Mindbody | `appointment.completed` | Confirm that completion can be distinguished from booking/cancellation, and that customer contact/permission data is available. |
| Food & beverage | OpenTable, Resy, SevenRooms, Square POS, Toast, Clover | `order.fulfilled`, reservation-completed | Use existing QR for anonymous visitors. Reservation/POS candidates need confirmed contact linkage and API access; a sale count alone is not an eligible recipient. |

Consent reminder (applies to every connector): candidate eligibility still
flows through the consent attestation semantics + `evaluateAsk` + suppression
ledgers. The open consent-basis question for continuous sources is a Phase 1
grill item and a counsel touchpoint (forward-roadmap Phase 1).

## 5. Per-vertical platform posture (Phase 6 input)

The table below records earlier market assumptions, not worldwide platform
relevance or verified access. Check them for the selected country and cohort.

| Platform | Home services | F&B | Beauty |
|---|---|---|---|
| Google | Primary (today) | Primary | Primary |
| Yelp | High reader influence — **monitor + deep-link only; never solicit** (Yelp policy) | Same, influence highest here | Same |
| Facebook | Secondary | Secondary | Secondary |
| Tripadvisor | — | Monitoring value (tourist-heavy locations) | — |
| Trustpilot | Low fit (local trades) | Low fit | Low fit |

### Market capability evidence

For each selected pilot market, maintain one compact entry in the shared
customer evidence record using these fields; this document owns the definition.

| Dimension | Evidence required before claiming support |
|---|---|
| Country and languages | Named market, owner language, customer language(s), owner-reviewed output quality |
| Source platform | Real access and supported read/publish operations for that account |
| Request/notification channel | Provider availability, eligible recipients, applicable permission and sending constraints |
| Local operation | Timezone, sending hours and support path for exceptions |
| Complete journey | Dated setup, eligible event, approved action, verified result and follow-up evidence; identify manual steps |

An international signup, translated interface and generated Japanese text are
different capabilities from operating a complete workflow in Japan. This
revision declares no new country supported. After the first workflow earns
continued use and an affordable expansion decision, test transferability by
keeping the industry and job stable while changing one market. The
[competitor evidence](../plans/2026-09-11-reputation-competitor-landscape.md)
shows the incumbents already sell outside North America by capability, not
by country count.

## 6. Per-vertical compliance & tone notes (Phase 2/4 input)

These are product constraints and questions for counsel, not a legal opinion
or a claim that each named trigger is verified live. Minimum approved facts
and rules from Phase 4 must precede recovery outreach that depends on them.
Check the implementation and intended environment for current trigger coverage.

- **Home services**: disputes often involve money/damage claims — the
  legal-threat escalation trigger (never auto-post) matters most here.
  Warranty language must come from current owner-approved facts, never
  improvised.
- **F&B**: health-department mentions (illness claims) are a mandatory
  escalation trigger, never auto-posted, never argued with publicly. High
  review velocity can stress daily caps and cadence jitter if actual
  activity reaches those limits; industry alone does not establish workload.
- **Beauty & personal care**: some services sit near medical territory
  (medspa, facials, massage) — injury/reaction claims are
  medical-safety-class escalations (existing trigger class in invariant
  lists); drafts never make outcome/health claims. Repeat-visit
  relationships make recovery (Phase 2) worth testing when owners report
  unresolved complaints; its value is not established in advance.
- All three: FTC Consumer Reviews Rule + Google fake-engagement policy
  invariants from forward-roadmap Phase 2 apply identically — no sentiment
  gating, no incentives, no destination steering.

## 7. Marketing implications (Track C)

Use the selected customer type's own language and observed problem in the
first demonstration and sales draft. Additional industry pages are optional
later work. Before building any, follow the standing rule: list existing marketing routes
and what each covers (see `docs/brand-asset-library/brand-kit/` and the 2026-07-22
marketing-pages-agentic-refresh spec); extend, don't duplicate. Vertical
proof points should use that vertical's ontology vocabulary once Phase 3
ships. A claim such as "arrival-time complaints down 40%" needs an actual
sample, dates, denominator, and permission to share; it is not a promised
result or something to infer from shipping topic classification.
