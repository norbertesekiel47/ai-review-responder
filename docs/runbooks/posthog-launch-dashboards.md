# PostHog Launch Dashboards

Build-by-hand spec for the four launch dashboards. Every insight below maps to
an event RepWorth **actually emits today** — each event name is cited to its
source file. Where a desired metric has **no backing event**, it is flagged as a
**GAP** (with what would have to be added) rather than invented. Owner builds
these in the PostHog UI; there is no PostHog MCP.

> Owner action only. This doc does not create anything in PostHog.

## How events reach PostHog (read first — it constrains every insight)

- **Authoritative event allowlist:** `src/lib/analytics/events.ts` →
  `ANALYTICS_EVENT_NAMES` (kept in lockstep with the `analytics_events`
  `event_name` CHECK constraint). The PostHog event name **equals** the
  `event_name` value — no renaming in transit.
- **Two emit paths, both server-side (`posthog-node`, never the browser):**
  1. **Durable** — most events INSERT a row into `analytics_events`
     (`src/lib/analytics/enqueue.ts`) and are shipped by
     `worker/background/pollers/AnalyticsDispatchPoller.ts`, which calls
     `captureAnalyticsEvent({ event: event_name, distinctId: distinct_id,
     properties: { ...properties, $insert_id: event_key } })`. PostHog dedups on
     `$insert_id`.
  2. **Direct** — `activation_completed` is captured straight from the worker
     (`worker/jobs/publisher/activation.ts:102` via
     `src/lib/analytics/activation-event.ts`), dedup key `uuid = responseId`
     (not `$insert_id`).
- **Two distinct-id namespaces — there is NO identity stitch.** The codebase
  calls `capture` only; it never calls PostHog `identify`/`alias` (verified: no
  match in `src/lib/analytics/*`). Consequences:
  - **Pre-auth / client-intent events** are keyed by an **anonymous cookie**
    `distinct_id` (`/api/analytics/enqueue` → `src/app/api/analytics/enqueue/route.ts`).
    These are the `CLIENT_ENQUEUEABLE_EVENT_NAMES`
    (`src/lib/analytics/events.ts:77`): `signup_started`, `sample_demo_started`,
    `sample_demo_to_signup`, `gbp_connect_started`, `gbp_connect_failed`.
  - **Post-auth durable facts** are keyed by **`account_id`** as `distinct_id`.
  - A single PostHog **funnel** insight cannot stitch a pre-auth anonymous event
    to a post-auth `account_id` event. Build cross-stage funnels on the
    `account_id`-keyed events only; treat the anonymous top-of-funnel as a
    separate Trends insight. (GAP to close later: emit a PostHog `identify`/
    `alias` linking the anon cookie to `account_id` at signup confirmation.)

---

## Dashboard 1 — Activation funnel

Goal: how many accounts get from email-verified to first posted response, and
where they drop. All stages below are `account_id`-keyed → they stitch in one
PostHog Funnel insight.

| Insight | Type | Events / steps (ordered) | Filters / breakdown | Math |
|---|---|---|---|---|
| Activation funnel (core) | Funnel | 1. `email_verified` → 2. `gbp_connected` → 3. `first_review_ingested` → 4. `first_response_drafted` → 5. `activation_completed` | Conversion window 7 days; breakdown by `gbp_connected.location_count` (single vs multi) optional | Unique users (`distinct_id` = account_id) |
| Time to first draft | Trends | `first_response_drafted` | — | Property value **average** of `minutes_to_first_draft` (numeric; null-skipped) |
| Time to activation | Trends | `activation_completed` | — | Property value **average** + p90 of `days_to_activation` (numeric; event only fires inside the 0–7 day window) |
| Activation rate | Trends/Formula | `activation_completed` ÷ `email_verified` | weekly | Unique-user ratio |

Source citations: `email_verified` `src/app/api/auth/verify-otp/route.ts:203`
(props `account_id`, `user_id`, `signup_source:'self_serve'`); `gbp_connected`
`src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:157` (props
`account_id`, `business_id`, `location_count`); `first_review_ingested`
`src/lib/reviews/process-review.ts:169` (props `account_id`, `business_id`,
`review_id`); `first_response_drafted`
`worker/jobs/response-generation/analytics.ts:50` (props `account_id`,
`business_id`, `response_id`, `review_id`, `minutes_to_first_draft`);
`activation_completed` `src/lib/analytics/activation-event.ts:45` (props
`account_id`, `business_id`, `response_id`, `review_id`, `days_to_activation`).

**Top-of-funnel (separate insight — anonymous-keyed, do NOT chain into the funnel above):**

| Insight | Type | Event | Filter/breakdown | Math |
|---|---|---|---|---|
| Signups started | Trends | `signup_started` | — | Total count (anon `distinct_id`) |
| Sample-demo started → signup | Trends | `sample_demo_started`, `sample_demo_to_signup` | — | Total count each |
| Connect-start failures | Trends | `gbp_connect_failed` | breakdown by any error prop the client posts | Total count |

Source: `SignupForm.tsx:307`, `StartLocationClient.tsx:292`,
`PaywallWithDemoClient.tsx:269`, all via `/api/analytics/enqueue`
(`route.ts:61`). `gbp_connect_started` is emitted **both** client-side (anon)
and server-side keyed by `account_id` (`connect/start/route.ts:316`, props
`account_id`, `business_id`, `location_scope`) — use the **server** one for the
account-keyed funnel, the client one only for top-of-funnel counts.

---

## Dashboard 2 — Approval-loop latency

Goal: how fast the owner-approval loop turns (notification → owner approval →
posted to Google).

**GAP — no direct approval-loop events exist today.** The
`ANALYTICS_EVENT_NAMES` allowlist contains **no** `notification_sent`,
`response_approved`, or `response_posted` event. So the literal
"notification→approve→post" latency cannot be built as a PostHog funnel right
now. What IS available as a proxy:

| Insight | Type | Event | Math | Note |
|---|---|---|---|---|
| First-draft latency (proxy) | Trends | `first_response_drafted` | average + p90 of `minutes_to_first_draft` | Time from `email_verified` to first draft, per `response-generation/analytics.ts:50`. Proxies generation latency, not the approval round-trip. |
| First-activation latency (proxy) | Trends | `activation_completed` | average + p90 of `days_to_activation` | End-to-end signup→first-posted, the closest existing approximation of the full loop. |

**To make this a real dashboard (gap to add later):** emit durable analytics
events at the approval lifecycle boundaries (e.g. `approval_notification_sent`
with `response_id`/`channel`/timestamp, `response_approved` with
`approval_method`, `response_posted` with `posted_at`) — added to
`ANALYTICS_EVENT_NAMES` + the DB CHECK constraint, enqueued via
`enqueueAnalyticsEvent` in the same tx as the corresponding state change. Until
then this dashboard is proxy-only; the authoritative approval-loop latency lives
in Postgres (`responses` timestamps), not PostHog.

---

## Dashboard 3 — Channel health

Goal: WhatsApp / Telegram / email notification delivery health.

**GAP — no channel send/deliver events in PostHog.** No notification-channel
event exists in `ANALYTICS_EVENT_NAMES`; channel delivery is observed via the
worker's structured logs (`createWorkerLogger`) and provider status callbacks
(Twilio/Telegram), not PostHog. Building a "channel health" board purely from
today's PostHog events is **not possible** without inventing events.

What weakly relates today (NOT channel health, list only to avoid false
confidence): none of the 19 allowlisted events carry a channel dimension.

**To make this a real dashboard (gap to add later):** emit a durable
`notification_dispatched` event (props: `channel` ∈ email|whatsapp|telegram,
`outcome` ∈ sent|failed|blocked|unsubscribed, `response_id`) from the
notification worker, and a `notification_button_action` event for inbound
WhatsApp/Telegram button taps. Then: Trends by `channel` breakdown for send
volume, and a failure-rate Formula (`outcome=failed` ÷ all) by `channel`. Until
those land, monitor channels via Railway worker logs + Twilio/Telegram consoles.

---

## Dashboard 4 — Cost guardrails

Goal: LLM / paid-API spend vs caps, margin signal.

**GAP — cost data is NOT in PostHog.** Spend is recorded in the Postgres
`api_costs` table and surfaced admin-only, aggregate-on-read, via
`src/lib/admin/margin-service.ts` (see CLAUDE.md "Finance/margin signals"). There
is **no** cost-related event in `ANALYTICS_EVENT_NAMES`, so a PostHog cost
dashboard cannot be built from existing events.

Trial-economics proxies that DO exist in PostHog (revenue-adjacent, not cost):

| Insight | Type | Events | Math | Source |
|---|---|---|---|---|
| Trial conversion funnel | Funnel | `trial_started` → `trial_converted` | unique users | `src/lib/analytics/trial-events.ts` (`trial_started` props `status:'trialing'`; `trial_converted` `status:'active'`) |
| Trial failure / churn | Trends | `trial_payment_failed`, `trial_cancelled` | total count | `trial-events.ts` (props `status:'past_due'` / `'cancelled'`) |
| Offboarding volume | Trends | `offboarding_started` → `offboarding_teardown_completed` | count, breakdown by `mode` | `src/lib/account-offboarding/analytics.ts` (props `mode`, `status`) |

**To make a real cost-guardrail dashboard (gap to add later):** either (a) keep
cost in Postgres and build the guardrail view in the admin margin surface (not
PostHog — the existing single owner of cost truth), or (b) emit a periodic
`cost_rollup` event (props: `window`, `spend_cents`, `cap_cents`, `pct_of_cap`)
from a scheduler if cost must live in PostHog. Recommendation: keep cost in
Postgres/`margin-service`; do not duplicate the source of truth into PostHog.

---

## Summary of grounding

- **Fully buildable today (real events):** Dashboard 1 (activation funnel) and
  the trial/offboarding proxies in Dashboard 4.
- **Proxy-only today:** Dashboard 2 (approval-loop latency) — only
  `minutes_to_first_draft` / `days_to_activation` exist.
- **Not buildable from PostHog today (explicit gaps):** Dashboard 3 (channel
  health) and the cost portion of Dashboard 4 — no backing events; the data
  lives in worker logs / provider consoles (channels) and `api_costs` /
  `margin-service` (cost).

All event names above appear in `src/lib/analytics/events.ts`
(`ANALYTICS_EVENT_NAMES`). If an event is not in that list, it is not emitted —
do not add it to an insight.
