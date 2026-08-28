# Vertical commitment (owner decision, 2026-08-26)

RepWorth commits to three verticals:

1. **Home services** — HVAC, plumbing, electrical, roofing, landscaping,
   cleaning, pest control, garage doors, general contractors.
2. **Food & beverage** — restaurants, cafes, bars, quick-service, bakeries.
3. **Beauty & personal care** — hair salons, nail salons, facial/skin
   clinics, massage and spa centers, barbershops.

"Vertical" here means: which ontology (Phase 3), which connector adapters
(Phase 1), which policy defaults (Phase 4), and which marketing pages a
customer gets. The core pipeline stays vertical-agnostic; the vertical is
configuration (`businesses.vertical`, closed enum — see forward-roadmap
§ Cross-cutting), never a code fork.

## 1. Why these three

All three share the properties that make the RepWorth loop work:

- Reviews heavily influence local customer acquisition (Google-first
  discovery).
- There is a completion moment (job done / meal served / appointment
  finished) that can trigger a request.
- Owners are operators, not marketers — they want the work done, not a
  dashboard.
- Local, multi-location expansion paths exist (franchises, small chains).

They differ in ways that stress different parts of the product, which is
healthy: home services and beauty are appointment-shaped (identified
customers, natural Phase 1 fit); F&B is walk-in-shaped (high review velocity,
anonymous customers — stresses QR + reservation integrations instead).

## 2. Recommended rollout order (recommendation, not locked)

**Home services → Beauty & personal care → Food & beverage.**

Rationale: home services and beauty share the appointment/job-completion
model, so one connector architecture serves both — and **Square Appointments
(beauty) + Housecall Pro (home services) are already the two integrations
named in the design of record (§9.4)**. Home services goes first because
ticket sizes are highest (one review is worth the most, software budget
tolerance is highest) and each account's review volume is low enough that the
veto/caps machinery is never stressed early. F&B goes last because its wedge
(reservation platforms, QR, POS) is a different integration shape and its
review velocity makes it the best stress test *after* the machinery is
proven.

## 3. Per-vertical review-topic ontologies (draft — Phase 3 spec freezes these)

Closed vocabularies, one per vertical. Rules: ≤12 topics, mutually
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

Staff attribution note: beauty and home services reviews frequently name the
practitioner/technician. `businesses.staff_names` already exists — Phase 3
should record a `mentioned_staff` extraction alongside topics (feeds the
Phase 7 staff-level graph queries). F&B rarely names staff; skip there.

## 4. Per-vertical connector targets (Phase 1)

Selection criteria: OAuth + webhook quality, SMB market share in the
vertical, app-marketplace distribution value. First adapter per vertical in
**bold**.

| Vertical | Systems (candidates) | Trigger events | Notes |
|---|---|---|---|
| Home services | **Housecall Pro** or **Jobber**, ServiceTitan (upmarket, later), Workiz | `job.completed`, `invoice.paid` | §9.4 names Housecall Pro. Jobber has a strong app marketplace (distribution). ServiceTitan is enterprise-ish — defer. |
| Beauty & personal care | **Square Appointments**, Fresha, Booksy, Vagaro, GlossGenius, Mindbody (upmarket) | `appointment.completed` | §9.4 names Square Appointments. Square OAuth likely reusable later for F&B POS — shared platform investment. |
| Food & beverage | Reservation layer first: OpenTable / Resy / SevenRooms; POS later: **Square POS**, Toast, Clover; ordering: (defer) | `order.fulfilled` (POS), reservation-completed | Walk-ins have no contact handle — the F&B wedge is **QR** (no contact needed) + reservation platforms (identified diners). POS events mostly lack contact info; treat POS as volume signal, not candidate source, unless loyalty data present. |

Consent reminder (applies to every connector): candidate eligibility still
flows through the consent attestation semantics + `evaluateAsk` + suppression
ledgers. The open consent-basis question for continuous sources is a Phase 1
grill item and a counsel touchpoint (forward-roadmap Phase 1).

## 5. Per-vertical platform posture (Phase 6 input)

| Platform | Home services | F&B | Beauty |
|---|---|---|---|
| Google | Primary (today) | Primary | Primary |
| Yelp | High reader influence — **monitor + deep-link only; never solicit** (Yelp policy) | Same, influence highest here | Same |
| Facebook | Secondary | Secondary | Secondary |
| Tripadvisor | — | Monitoring value (tourist-heavy locations) | — |
| Trustpilot | Low fit (local trades) | Low fit | Low fit |

## 6. Per-vertical compliance & tone notes (Phase 2/4 input)

- **Home services**: disputes often involve money/damage claims — the
  legal-threat escalation trigger (never auto-post) matters most here.
  Warranty language in drafts must come from the Business Truth layer, never
  improvised.
- **F&B**: health-department mentions (illness claims) are a mandatory
  escalation trigger, never auto-posted, never argued with publicly. High
  review velocity means daily caps and cadence jitter get stressed first
  here.
- **Beauty & personal care**: some services sit near medical territory
  (medspa, facials, massage) — injury/reaction claims are
  medical-safety-class escalations (existing trigger class in invariant
  lists); drafts never make outcome/health claims. Repeat-visit
  relationships make recovery (Phase 2) highest-value in this vertical.
- All three: FTC Consumer Reviews Rule + Google fake-engagement policy
  invariants from forward-roadmap Phase 2 apply identically — no sentiment
  gating, no incentives, no destination steering.

## 7. Marketing implications (Track C)

Vertical landing pages ("Reputation on autopilot for home services" etc.) —
before building any, follow the standing rule: list existing marketing routes
and what each covers (see `docs/marketing/` and the 2026-07-22
marketing-pages-agentic-refresh spec); extend, don't duplicate. Vertical
proof points should use that vertical's ontology vocabulary once Phase 3
ships ("arrival-time complaints down 40%"), not generic copy.
