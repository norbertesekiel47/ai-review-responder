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

### `offboarding_started`
- **Status:** live
- **Description:** Owner confirmed an account offboarding request.
- **Owner:** account offboarding confirm transaction
- **Source:** server-side, in the offboarding creation transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `offboarding_started:<offboarding_id>`
- **Required properties:** `mode` (`cancel_only` or `delete_data`), `status` (`pending`)
- **Optional properties:** none
- **Privacy notes:** IDs only; no raw tokens, provider identifiers, or free-text reason.

### `offboarding_reactivated`
- **Status:** live
- **Description:** Owner reactivated a cancel-only offboarding before teardown began.
- **Owner:** account offboarding reactivation transaction
- **Source:** server-side, in the reactivation transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `offboarding_reactivated:<offboarding_id>`
- **Required properties:** `mode` (`cancel_only`), `status` (`reactivated`)
- **Optional properties:** none
- **Privacy notes:** IDs only; no Stripe subscription identifiers.

### `offboarding_teardown_completed`
- **Status:** live
- **Description:** Worker finished all offboarding teardown steps.
- **Owner:** Railway account offboarding teardown worker
- **Source:** worker-side, in the teardown completion transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `offboarding_teardown_completed:<offboarding_id>`
- **Required properties:** `mode`, `status` (`churned` or `purge_scheduled`)
- **Optional properties:** none
- **Privacy notes:** IDs only; provider resource identifiers stay out of analytics.

### `offboarding_purged`
- **Status:** live
- **Description:** Worker completed delete-data purge and retained only the lifecycle receipt.
- **Owner:** Railway account offboarding purge worker
- **Source:** worker-side, in the purge finalization transaction (durable; not client-postable)
- **Distinct ID:** SHA-256 pseudonymous offboarding key
- **Event key:** `offboarding_purged:<sha256(offboarding_id)>`
- **Required properties:** none
- **Optional properties:** none
- **Privacy notes:** no account, user, business, provider, or raw offboarding identifier is retained.

### `trial_started`
- **Status:** live
- **Description:** A card-up-front free trial began (account entered `trialing`).
- **Owner:** `applyStripeSubscriptionState` (Stripe webhook ingress)
- **Source:** worker-side, in the subscription-status applier transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `trial_started:<account_id>` (one per account — lean-abuse posture)
- **Required properties:** `status` (`trialing`)
- **Optional properties:** none
- **Privacy notes:** IDs only; no Stripe customer/subscription identifiers in properties.

### `trial_converted`
- **Status:** live
- **Description:** A trial converted to a paid subscription (`trialing` → `active`).
- **Owner:** `applyStripeSubscriptionState` (Stripe webhook ingress)
- **Source:** worker-side, in the subscription-status applier transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `trial_converted:<account_id>:<stripe_subscription_id>`
- **Required properties:** `status` (`active`)
- **Optional properties:** none
- **Privacy notes:** the Stripe subscription id appears only in the dedup event key, never in properties.

### `trial_payment_failed`
- **Status:** live
- **Description:** A trial's first charge failed at trial end (`trialing` → `past_due`).
- **Owner:** `applyStripeSubscriptionState` (Stripe webhook ingress)
- **Source:** worker-side, in the subscription-status applier transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `trial_payment_failed:<account_id>:<stripe_subscription_id>`
- **Required properties:** `status` (`past_due`)
- **Optional properties:** none
- **Privacy notes:** the Stripe subscription id appears only in the dedup event key, never in properties.

### `trial_cancelled`
- **Status:** live
- **Description:** A trial was cancelled before converting (`trialing` → `cancelled`).
- **Owner:** `applyStripeSubscriptionState` (Stripe webhook ingress)
- **Source:** worker-side, in the subscription-status applier transaction (durable; not client-postable)
- **Distinct ID:** account ID
- **Event key:** `trial_cancelled:<account_id>:<stripe_subscription_id>`
- **Required properties:** `status` (`cancelled`)
- **Optional properties:** none
- **Privacy notes:** the Stripe subscription id appears only in the dedup event key, never in properties.

### `competitor_rival_picked`
- **Status:** live
- **Description:** An owner set or cleared the Named rival for one location's Competitor Delta line. The probe-engagement signal for wayfinder map #528 — it measures whether owners actually steer the competitive comparison rather than leaving the Auto-default rival in place.
- **Owner:** `setNamedRivalPick` (`src/lib/competitors/named-rival.ts`), called by the owner-scoped competitors settings route (`PUT /api/settings/competitors`)
- **Source:** server-side, in the same transaction as the `businesses` pick write (durable; **not** client-postable)
- **Distinct ID:** account ID
- **Event key:** `competitor_rival_picked:<business_id>:<place_id | "cleared">:<rival_picked_at | cleared_at>` — the timestamp comes from the write's `RETURNING`, never a JS clock, so a retried identical request re-mints the same key and `ON CONFLICT` drops it.
- **Required properties:** `action` (`set` or `cleared`), `placeId` (the picked Place ID; `null` on clear), `businessId`
- **Optional properties:** none
- **Privacy notes:** IDs only. `businessId` is duplicated into properties on purpose — `AnalyticsDispatchPoller` forwards only the properties blob to PostHog, so the `analytics_events.business_id` column never leaves Postgres and the location dimension would otherwise be unavailable. No rival display name is sent (it is third-party business content, not our fact to publish).

### `solicitation_consent_recorded`
- **Status:** live
- **Description:** A consent ledger row was inserted for an email handle at one location — the first attestation covering that `(channel, normalized_handle, business_id)` scope (#625, consent-ledger spec §8.1).
- **Owner:** `upsertConsent` (`src/lib/solicitation/ingest.ts`), inside the csv_ingest advisory-locked transaction
- **Source:** server-side, same transaction as the consent-row insert (durable; **not** client-postable — a client-postable variant would let anyone forge consent)
- **Distinct ID:** account ID
- **Event key:** `solicitation_consent_recorded_<consent_row_id>` — the whole ingest is one transaction, so a replayed job either short-circuits on the terminal upload or rolls the event back with the row; the key never double-mints.
- **Required properties:** `channel` (`email`), `basis` (`owner_attested`), `attestation_version`
- **Optional properties:** none
- **Privacy notes:** never the handle — IDs and version strings only (spec §8.1).

### `solicitation_consent_upgraded`
- **Status:** live
- **Description:** The §4.2 guarded monotone upsert's DO UPDATE branch fired across an attestation-version change. The metric that shows whether the v1→v2 re-upload migration is actually happening — #633 flip evidence, not a vanity number.
- **Owner:** `upsertConsent` (`src/lib/solicitation/ingest.ts`), inside the csv_ingest advisory-locked transaction
- **Source:** server-side, same transaction as the consent-row update (durable; **not** client-postable)
- **Distinct ID:** account ID
- **Event key:** `solicitation_consent_upgraded_<consent_row_id>_<to_version>` — the consent row id is stable across upgrades, so replaying the same version upgrade re-mints the same key and `ON CONFLICT` drops it.
- **Required properties:** `channel` (`email`), `from_version`, `to_version`
- **Optional properties:** none
- **Privacy notes:** never the handle.

### `solicitation_suppressed`
- **Status:** planned
- **Description:** A Suppression ledger row was inserted — one opt-out, keyed on the Normalized handle for its channel (#643, suppression/unsubscribe spec §9.4). Rows are first-write-wins, so a `DO NOTHING` that hit an existing row emits nothing: the count is opt-outs created, never opt-out signals received.
- **Owner:** `recordSuppression` (`src/lib/solicitation/suppression.ts`), inside the caller's transaction
- **Source:** server-side, same transaction as the ledger insert (durable; **not** client-postable — a client-postable variant would let anyone forge a compliance record)
- **Distinct ID:** account ID **when one is known**, else the suppression row id (`input.accountId ?? row.id`). The `accountId: null` path is not an accident — §5.2 post-purge redemption and unresolvable webhook sources both mint global rows with no account — and `analytics_events.distinct_id` is NOT NULL, so it needs *some* value. The consequence, stated because the fallback ships before its first caller: an accountless global suppression mints a one-off PostHog person per row. Harmless at today's zero callers; **#644/#645/#627 own picking a stable sentinel** if accountless volume turns out to be non-trivial.
- **Event key:** `solicitation_suppressed_<suppression_row_id>` — the row id comes from the insert's `RETURNING`, so a rolled-back or conflict-skipped write mints no key at all.
- **Required properties:** `source` (one of the seven §3.1 sources), `scope` (`global` or `account`), `channel` (`email`)
- **Optional properties:** none
- **Privacy notes:** **never the handle**, and never the `note` (§7.5 manual entries can quote an originating message). IDs and closed enum values only.
- **Status note:** `planned` rather than `live` because `recordSuppression` ships with zero production callers (#643 G6) — its consumer today is the live-DB suite. #644/#645/#627 supply the first real callers.

### `solicitation_suppressed_at_dispatch`
- **Status:** planned
- **Description:** The last-moment suppression re-check refused a send that the batch build had already marked sendable — the window between build and dispatch closing on a handle that opted out in between. Emitted by **#630**, not by #643; registered here so #630 needs no migration of its own.
- **Owner:** #630's dispatch path (not yet built)
- **Source:** server-side, in the dispatch transaction (durable; **not** client-postable)
- **Distinct ID:** account ID
- **Event key:** `solicitation_suppressed_at_dispatch_<ask_id>` — one refusal per Ask.
- **Required properties:** `source` (the source of the matched Suppression ledger row), `ask_id`
- **Optional properties:** none
- **Privacy notes:** never the handle. `scope` is deliberately absent: reporting which scope matched would surface the `account_id` provenance §7.4 forbids exposing.
