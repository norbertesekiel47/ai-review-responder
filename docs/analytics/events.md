# Analytics Events

RepWorth does not use `posthog-js` and Next.js routes do not call PostHog
directly. Client and Vercel-owned events are written to `analytics_events`;
the Railway `AnalyticsDispatchPoller` ships them to PostHog.

This file is the canonical event taxonomy. The CI audit
(`pnpm ci:analytics-events`, `scripts/ci/analytics-events-audit.ts`) fails the
build if a code allowlist event (`ANALYTICS_EVENT_NAMES` in
`src/lib/analytics/events.ts`) is undocumented here, or if an event documented
as `live` is missing from the code allowlist.

**Status values:** `live` (emitted today), `planned` (designed, not yet
emitted), `external_only` (delivered by an external system, never in the code
allowlist).

**Privacy rule (applies to every event):** never include review text, response
text, raw approval tokens, Zernio tokens, MFA codes, provider secrets, or raw
CSV content.

## Event Catalog

### `signup_started`
- **Status:** live
- **Description:** Visitor began the signup flow.
- **Owner:** first-party enqueue route (`src/app/api/analytics/enqueue/route.ts`)
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** anonymous ID
- **Event key:** `signup_started:<anonymous_id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** anonymous ID only; no PII.

### `email_verified`
- **Status:** live
- **Description:** User confirmed their email via OTP.
- **Owner:** verify-OTP route
- **Source:** server-side after OTP confirmation (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `email_verified:<user_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only.

### `sample_demo_started`
- **Status:** live
- **Description:** Visitor started the sample-data demo.
- **Owner:** first-party enqueue route
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** anonymous ID or account ID
- **Event key:** `sample_demo_started:<id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** IDs only.

### `sample_demo_to_signup`
- **Status:** live
- **Description:** Visitor converted from the demo into signup.
- **Owner:** first-party enqueue route
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** anonymous ID or account ID
- **Event key:** `sample_demo_to_signup:<id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** IDs only.

### `gbp_connect_started`
- **Status:** live
- **Description:** Owner started connecting a Google Business Profile location.
- **Owner:** first-party enqueue route
- **Source:** browser intent → `/api/analytics/enqueue`
- **Distinct ID:** account ID
- **Event key:** `gbp_connect_started:<business_id>:<client_event_id>`
- **Required properties:** none
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** IDs only.

### `gbp_connect_failed`
- **Status:** live
- **Description:** A GBP connect attempt failed at a known stage.
- **Owner:** connect UI/API
- **Source:** browser/API intent → `/api/analytics/enqueue`
- **Distinct ID:** account ID
- **Event key:** `gbp_connect_failed:<business_id>:<stage>:<client_event_id>`
- **Required properties:** `stage` (string)
- **Optional properties:** `client_event_id` (string)
- **Privacy notes:** stage is a fixed enum label; no PII.

### `gbp_connected`
- **Status:** live
- **Description:** A GBP location finished connecting.
- **Owner:** Zernio finalize / select-location transaction
- **Source:** server-side, in the connect transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `gbp_connected:<business_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only.

### `first_review_ingested`
- **Status:** live
- **Description:** First review ever ingested for an account.
- **Owner:** Zernio ingest worker
- **Source:** worker-side after ingest commit (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `first_review_ingested:<account_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only; no review content.

### `first_response_drafted`
- **Status:** live
- **Description:** First AI response drafted for an account.
- **Owner:** response generator worker
- **Source:** worker-side after draft commit (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `first_response_drafted:<account_id>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only; no response content.

### `activation_completed`
- **Status:** live
- **Description:** Account reached activation (first response posted).
- **Owner:** publisher worker
- **Source:** worker-side on posted transition (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** existing Step 1 activation key
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** IDs only.
