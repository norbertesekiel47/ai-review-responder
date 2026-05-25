# Wave 2 Activation Design

Status: ready for user review

Date: 2026-05-25

## Context

`docs/sass_ready/README.md` defines Wave 2 as the activation wave after Step 0 decisions, Step 1 keystones, and Wave 1 foundation launch-risk work. Step 0, Step 1, and Wave 1 are complete. Wave 2 should now close the risks that can cause a paying customer to stall, churn, or need unsupported founder-only intervention during the first activation window.

This design covers the exact Wave 2 scope from the readiness README:

- Spec 06: onboarding measurement, Zernio-connect polish, demo entry, and CSV polish.
- Spec 05 plus Spec 29 Gap 5 and Gap 6: past-due UX, countdown, read-only layer, and grant-extension support path.
- Spec 04: MFA, auth hardening, and audit consistency needed for paid owners and support powers.
- Spec 13: support spine, activation KB, macros, and admin impersonation.

It deliberately does not implement the full contents of those source specs. Later-wave work stays later.

## Selected Approach

Use an activation-spine design. A new paying owner should be able to:

1. Try or start RepWorth with enough confidence to continue.
2. Connect their Google Business Profile through the existing Zernio-mediated path.
3. Reach first AI-drafted response quickly enough to feel value.
4. Recover from payment trouble without surprise lockout.
5. Secure billing/admin-sensitive actions with MFA.
6. Get help through documented support paths.
7. Allow founder/admin diagnosis through audited, time-boxed impersonation only when needed.

This order follows the customer's activation journey and keeps billing, auth, and support from becoming disconnected implementation islands.

Rejected approaches:

- Subsystem-first: finish all of Spec 06, then all of Spec 05/29, then Spec 04, then Spec 13. This is easier to review but slower to produce a complete activation path.
- Risk-first: ship past-due recovery and MFA first, then onboarding. This reduces security and billing risk quickly but delays the TTFV and funnel instrumentation needed to know whether activation is improving.
- Full-source-spec sweep: implement every item in specs 06, 05, 29, 04, and 13. This would pull in teams UI, cancellation surveys, Stripe Tax, API tokens, data export/delete, and other later-wave work.

## Scope

In scope:

- `docs/analytics/events.md` as the Wave 2 activation event taxonomy source of truth.
- Worker-dispatched PostHog activation funnel instrumentation for signup, Zernio connect, first review, first draft, sample demo, and demo-to-signup conversion.
- TTFV measurement from email verification to first AI draft.
- Zernio connect help link, redirect timeout fallback, and funnel events on the existing `/dashboard/connect` flow.
- Logged-out sample-demo entry point that reuses the existing onboarding demo infrastructure rather than building a parallel demo system.
- CSV template, CSV README, client-side validation, and UI surfacing of existing row-level import failures.
- Day-aware past-due banner, day-5 modal, day-8 read-only UI layer, and account recovery copy.
- Admin/founder grant-extension action for past-due accounts, AAL2-gated and audit-logged.
- Support macro and runbook for "past_due and cannot pay".
- Settings -> Security page for Supabase TOTP MFA enrollment, challenge, verification, factor listing, and unenrollment.
- AAL2 enforcement for billing owner sensitive flows, Scale/Premium policy, admin grant-extension, and impersonation.
- Rate-limit hardening for password reset, login failures, and MFA challenge attempts using the existing Redis-Lua helper.
- Audit consistency for touched actor actions through `writeAccountAuditLog`.
- Help/contact page, activation-critical KB docs, support macros, and Help Scout operating setup.
- Admin impersonation table, admin UI, AAL2 gate, TTL, banner, audit rows, and destructive-action block.

Out of scope:

- Dashboard onboarding checklist and `account_onboarding_state`; these were deliberately removed and must not be reintroduced.
- Direct Google OAuth. GBP connect remains Zernio-mediated.
- `posthog-js` or any browser/Next.js direct call to PostHog.
- Full PostHog BI dashboards owned by Spec 11 beyond lightweight dashboard definitions in docs.
- Full branded dunning automation, cancellation survey, Stripe Tax, chargeback tabletop, and Stripe Tax runbook.
- Full Settings -> Team invite UI.
- `account_memberships` migration unless implementation planning proves it is necessary for the selected Wave 2 auth gates.
- Microsoft SSO, passkeys, SAML/SCIM, and custom recovery-code system.
- Full Trust Center, API tokens, data export/delete flows, GBP-direct fallback, LLM cost rollup, and broader Wave 3+ analytics.
- A new Stripe event dedup table or a parallel billing reconciliation system.

## Architecture

Wave 2 is one umbrella design with four deep sub-specs:

1. Onboarding and activation measurement.
2. Past-due recovery UX.
3. Auth, MFA, and audit hardening.
4. Support, KB, and impersonation.

The implementation should be sequenced in the same order:

1. Activation measurement and onboarding polish. This creates the data needed to see whether the wave is improving activation.
2. Past-due recovery UX and the shared recovery helper. `accounts.past_due_at` already exists, so this closes the visible customer recovery gap with limited schema work. The grant-extension action itself lands after AAL2 exists.
3. MFA/security/audit hardening. Support powers and billing extensions should not exist without stronger admin and owner auth.
4. Grant extension, support tooling, and impersonation. These depend on audit and MFA foundations.

Implementation PR granularity:

- Prefer one PR per sub-spec slice unless implementation planning finds an even smaller natural boundary.
- Keep schema migrations small and independently reviewable.
- The next migration number after the current repository head `045` is `046`; if parallel work lands first, renumber before implementation.
- Each PR updates only the readiness spec checkboxes it actually closes.

### Analytics Dispatch Boundary

RepWorth's architecture invariant still applies: Vercel is UI only. Next.js routes should not make blocking server-side PostHog calls.

Wave 2 analytics should use this boundary:

- No `posthog-js` and no direct PostHog calls from browser code or Next.js routes.
- Worker-owned state changes may call `captureAnalyticsEvent` directly after the durable state change commits, as the Step 1 `activation_completed` path already does.
- Browser/client intent events submit to a first-party same-origin analytics enqueue route that writes to Postgres only. The route does not call PostHog.
- Next.js route-owned durable state changes insert into the same first-party analytics queue in the route's existing transaction when one exists, or enqueue a best-effort analytics row after the durable write when transactional coupling is not required.
- A Railway worker dispatches queued analytics rows to PostHog.
- No customer workflow should wait on PostHog.

Design the first-party analytics queue explicitly in Sub-Spec 06. Do not leave "analytics outbox" as an undefined escape hatch.

## Sub-Spec 06: Onboarding And Activation

Source spec: `docs/sass_ready/06-onboarding-activation.md`.

### Current Repo Anchors

- Existing worker-side PostHog capture: `src/lib/analytics/posthog.ts`.
- Existing activation event: `worker/jobs/publisher/activation.ts`.
- Existing demo page: `src/app/onboarding/demo/page.tsx`.
- Existing demo UI: `src/app/onboarding/demo/PaywallWithDemoClient.tsx`.
- Existing onboarding start: `src/app/onboarding/start/page.tsx`.
- Existing public demo route: `src/app/(public)/demo/[slug]/page.tsx`.
- Existing Zernio connect UI: `src/app/(authenticated)/dashboard/connect/page.tsx`.
- Existing Zernio start route: `src/app/api/zernio/connect/start/route.ts`.
- Existing location picker: `src/app/(authenticated)/dashboard/connect/select-location/LocationPicker.tsx`.
- Existing CSV import route: `src/app/api/admin/locations/csv-import/route.ts`.
- Existing CSV import core: `src/lib/admin/csv-import.ts`.
- Existing onboarding demo table: `onboarding_demos`, migrations `032` and `045`.

### Design

#### Activation Event Taxonomy

Add `docs/analytics/events.md` as the source of truth for activation events.

Wave 2 standard events:

| Event | Owner | Trigger | Required properties |
|---|---|---|---|
| `signup_started` | First-party analytics enqueue route | User starts self-serve signup | `signup_source`, `email_domain`, `plan_intent` when known |
| `email_verified` | Verify OTP route enqueues analytics row after success | Email verification succeeds | `account_id`, `user_id`, `signup_source` |
| `sample_demo_started` | First-party analytics enqueue route or demo-start route | Prospect starts sample/demo flow | `signup_source`, `business_query` if non-sensitive |
| `sample_demo_to_signup` | First-party analytics enqueue route or signup route | Demo user starts real signup | `demo_id` if present, `business_id` only for authenticated demo |
| `gbp_connect_started` | `/dashboard/connect` client posts to first-party enqueue route | Owner requests Zernio connect | `account_id`, `business_id`, `location_scope` |
| `gbp_connect_failed` | Connect UI/API | Zernio start/redirect/select fails | `account_id`, `business_id`, `error_code`, `stage` |
| `gbp_connected` | Finalize/select-location transaction enqueues analytics row | Connection becomes active | `account_id`, `business_id`, `location_count` |
| `first_review_ingested` | Worker ingest path | First review for account is persisted | `account_id`, `business_id`, `review_id`, `source` |
| `first_response_drafted` | Response generator worker | First AI response draft for account is committed | `account_id`, `business_id`, `response_id`, `review_id`, `minutes_to_first_draft` |
| `activation_completed` | Publisher worker | First posted response within 7 days | Already shipped; keep properties stable |

Event ownership rules:

- Durable state-change events belong where the state changes, usually workers or route handlers after the database transaction commits.
- Client events are allowed for intent and UI failure states, such as `gbp_connect_started` or redirect timeout, but the client only posts to RepWorth's first-party enqueue route.
- If a durable state change happens in a Next.js route, do not call PostHog directly from the route. Enqueue an analytics row for worker dispatch.
- Do not emit first-review, first-draft, or publish events purely from dashboard render state.
- Event properties must not include review text, response text, raw tokens, owner PII beyond stable internal IDs, or provider secrets.

#### First-Party Analytics Queue

Add a minimal analytics dispatch table instead of using `posthog-js` or calling PostHog from Vercel routes.

Schema concept:

```sql
CREATE TABLE analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- application should pass UUIDv7
  event_key TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  anonymous_id TEXT,
  account_id UUID,
  user_id UUID,
  business_id UUID,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Implementation rules:

- Use UUIDv7 for `id`, matching repo convention; the database default is only a fallback.
- `event_key` is the idempotency key. Examples: `signup_started:<anonymous_id>:<client_event_id>`, `email_verified:<user_id>`, `first_response_drafted:<account_id>`, `gbp_connected:<business_id>`.
- The first-party enqueue route accepts only same-origin requests, validates an allowlist of event names, rate-limits by IP and anonymous ID, and writes to `analytics_events`. It is a short first-party database append only: no external API calls, no LLM calls, and no long-running work in Vercel.
- Pre-account events use an anonymous first-party cookie ID for `distinct_id` until an account/user exists.
- Account events use `account_id` as `distinct_id` unless the event is explicitly user-scoped.
- A Railway worker or poller claims pending rows and calls `captureAnalyticsEvent`.
- PostHog receives `event_key` as `$insert_id` to provide provider-side deduplication in addition to the database unique key.
- Analytics dispatch failures retry asynchronously and never block signup, connect, or publishing.

This is net-new infrastructure, but it is intentionally small and local: a Postgres queue plus a Railway dispatcher. It preserves the "Vercel = UI only" invariant because Vercel/client code records first-party facts only and never contacts PostHog.

#### TTFV Measurement

Define:

```text
time_to_first_draft = first_response_drafted_at - email_verified_at
```

`email_verified_at` can come from the `analytics_events.occurred_at` timestamp for the account's `email_verified` event, or from a durable auth/user timestamp if one already exists. Do not add a broad onboarding-state table for this.

The `first_response_drafted` capture should happen in the response-generation worker after the response row is committed. It should determine whether the response is the account's first committed draft by joining `responses -> businesses -> accounts` and checking for an earlier response draft on the same account while explicitly excluding the current `response_id`.

The event must be idempotent across BullMQ retries after commit:

- Use `event_key = first_response_drafted:<account_id>`.
- Insert into `analytics_events` with `ON CONFLICT (event_key) DO NOTHING`.
- Include `$insert_id = event_key` when dispatching to PostHog.
- If the worker retries after the response commit, the second analytics insert is a no-op.

Properties:

- `account_id`
- `business_id`
- `response_id`
- `review_id`
- `minutes_to_first_draft`
- `signup_source` when available
- `tier` or account tier when available
- `source = zernio | seed | demo` when available

Do not build a heavy custom BI dashboard in Wave 2. Document PostHog dashboard definitions in `docs/analytics/events.md`:

- TTFV median and p95 by signup cohort week.
- Zernio connect started -> connected conversion.
- Email verified -> first draft conversion.
- Demo started -> signup conversion.
- Seven-day activation rate using existing `activation_completed`.

#### Zernio Connect Polish

Keep the existing route and state machine:

```text
/dashboard/connect
  -> /api/zernio/connect/start
  -> Zernio consent/connect
  -> /api/zernio/connect/callback
  -> /dashboard/connect/select-location when needed
```

Wave 2 additions:

- Add a help link from `ConnectView`, `ReconnectView`, and relevant failure states to a GBP/Zernio connection screenshot guide.
- Add a manual retry/timeout state when `/api/zernio/connect/start` returns `authUrl` but browser redirect does not happen within a short interval.
- Add a visible fallback link that the user can click when automatic redirect fails.
- Capture `gbp_connect_started` before leaving RepWorth.
- Capture `gbp_connect_failed` with `stage = start | redirect | callback | select_location` where practical.
- Capture `gbp_connected` when the connection becomes active.

The help guide can start in `docs/help/connect-google-business.md` and be surfaced through a simple app route or link. It should describe the Zernio-mediated connection accurately. Do not call it direct Google OAuth.

#### Logged-Out Demo Entry

The existing `/onboarding/demo` page is authenticated and reads the current user's `onboarding_demos` row. Wave 2 should add a logged-out entry point without creating a parallel demo system.

Preferred design:

- Add a public "try sample data" entry on the logged-out homepage and signup page.
- Route prospects into the existing start/demo pipeline where possible.
- If authentication is still required to generate a personalized demo, make that explicit in the entry flow and measure the step.
- Reuse `onboarding_demos`, existing cost guard, existing worker job, and curated fallback.
- CTA from demo to real signup captures `sample_demo_to_signup`.

Demo safety:

- Demo mode must remain read-only.
- Demo UI must clearly distinguish sample/demo data from connected customer data.
- No demo path can publish or enqueue real customer responses.
- Demo expiry semantics should be clarified against the live implementation. The current shared demo lifecycle has `STALE_THRESHOLD_MS = 5 * 60 * 1000` in `src/lib/demos/lifecycle.ts`, which is stale-running worker recovery, not a user-facing demo-session expiry. Wave 2 should decide whether a 60-minute user-facing demo session expiry is still desired; if not, update Spec 06 to match the actual product behavior.

#### CSV Template And Partial-Success UI

The server already returns `CsvImportReport`:

```ts
{
  created: number;
  failedCount: number;
  failed: Array<{ row: number; reason: string }>;
}
```

Wave 2 should surface that report rather than recomputing row outcomes.

Add:

- `public/csv-templates/locations.csv`.
- `public/csv-templates/README.md`.
- Public or help route link to download the template.
- Client-side validation matching server rules:
  - Required columns: `name`, `placeId`.
  - 5 MB max file size.
  - 100 data rows max.
  - No empty required fields.
  - Optional columns documented but not required.
- Partial-success UI:
  - "X of Y imported" summary.
  - Row-numbered failure list.
  - Clear retry instructions.
  - Billing-update failure state that preserves the import report.

Audit:

- When touching CSV import, migrate the audit write to `writeAccountAuditLog`.
- Add per-row outcome detail to the audit payload at a bounded size; avoid storing full CSV content.
- If the payload could become large, store summary counts and top failure reasons only.

### Data Flow

First draft:

1. Email is verified and `email_verified` is captured.
2. Owner connects Zernio; `gbp_connect_started` and `gbp_connected` are captured around the existing flow.
3. Worker ingests first review and captures `first_review_ingested`.
4. Response generator commits first AI draft.
5. After commit, it checks account-level first-draft status excluding the current response and inserts `first_response_drafted` into `analytics_events` with `minutes_to_first_draft`.
6. Publisher capture for `activation_completed` remains unchanged.

CSV import:

1. Admin selects CSV and client validates basic structure before upload.
2. Existing admin API processes rows best-effort.
3. API returns `CsvImportReport`.
4. UI displays created/failed counts and per-row failures.
5. Audit row records bounded summary.
6. Stripe overage update remains enqueued through existing outbox behavior.

### Error Handling

- Analytics enqueue/dispatch is best-effort and must not block state changes.
- Zernio connect redirect fallback should favor clear retry over hidden failure.
- CSV client-side validation prevents obvious bad uploads, but server remains authoritative.
- CSV billing enqueue failure can return `500` with the import report; UI must show the report and clearly explain that support/admin attention is needed.

### Testing Plan

- Event taxonomy structure test or lint check for duplicate event names in `docs/analytics/events.md`.
- Analytics queue tests for event allowlist, same-origin validation, anonymous ID handling, event-key uniqueness, and retryable dispatch.
- PostHog wrapper tests for no-op without key and property shape at dispatch time.
- Response generator worker tests:
  - captures first draft for first account-level response,
  - skips if a prior draft exists,
  - computes `minutes_to_first_draft`,
  - does not fail generation when analytics fails.
- Zernio connect UI tests:
  - help link visible,
  - redirect timeout fallback visible,
  - retry link works,
  - error states capture/fill stable error codes.
- CSV tests:
  - template includes required headers,
  - client rejects missing required columns,
  - client rejects more than 100 rows,
  - partial success report renders row failures,
  - audit payload is bounded.

### Acceptance Criteria

- `docs/analytics/events.md` exists and defines the Wave 2 activation event taxonomy.
- `time_to_first_draft` is measurable for new signups.
- `first_response_drafted` is enqueued only after the response row is committed.
- `first_response_drafted` uses a deterministic event key so retry-after-commit cannot double-count it.
- Zernio-connect started, failed, and connected states are measurable.
- Zernio-connect UI includes help and manual retry/redirect fallback.
- Logged-out users have a sample/demo entry point that reuses existing demo infrastructure.
- `sample_demo_to_signup` is captured.
- CSV template and README are public.
- CSV client validation matches the 100-row cap and required fields.
- CSV UI renders "X of Y imported" and row-level failures.
- The removed dashboard checklist and `account_onboarding_state` are not reintroduced.

### Risks

- Client-originated enqueue events can overcount intent. Mitigation: use them for funnel starts only; durable state events drive activation metrics.
- Demo flow can become confusing if public and authenticated demo paths diverge. Mitigation: reuse the existing demo system and keep demo labels explicit.
- CSV validation can drift from server rules. Mitigation: share validation schema where practical, or test the client rules against documented server rules.

## Sub-Spec 05/29: Past-Due Recovery UX

Source specs:

- `docs/sass_ready/05-billing-subscription.md`.
- `docs/sass_ready/29-repworth-specific-gaps.md` Gap 5 and Gap 6.

### Current Repo Anchors

- Past-due timestamp migration: `supabase/migrations/043_step_1_keystones.sql`.
- Existing dashboard banner: `src/components/dashboard/SubscriptionStatusBanner.tsx`.
- Dashboard render path: `src/components/DashboardContent.tsx`.
- Dashboard data types: `src/lib/dashboard/types.ts`.
- Dashboard API route/helpers: `src/app/api/dashboard/route.ts` and related dashboard data modules.
- Billing portal route: `src/app/api/billing/portal/route.ts`.
- Subscription guard: `src/lib/shared/subscription-guard.ts`.
- Edge proxy: `src/proxy.ts` plus `src/lib/shared/protected-routes.ts`. The repo does not have `src/middleware.ts`; Next's edge entry exports `proxy()` and a matcher from `src/proxy.ts`.
- Audit helper: `src/lib/audit/log.ts`.

Proxy constraints:

- `src/proxy.ts` deliberately uses the cookie-bound Supabase anon client and `users_self_select` RLS. Do not introduce `SUPABASE_SERVICE_KEY` into the edge proxy.
- AAL checks can use the cookie-bound Supabase client.
- Any read-only or impersonation enforcement placed in the edge proxy must rely only on data safely available through RLS or on signed first-party cookies.
- The implementation plan should confirm how Next registers `src/proxy.ts` in this repo before assuming standard `middleware.ts` behavior.

### Design

#### Day-Aware Banner

Pass `accounts.past_due_at` through the dashboard data model into `DashboardDataPastDue`, then into `PastDueBanner`.

Banner variants:

| Age from `past_due_at` | UX | Behavior |
|---|---|---|
| Day 0-2 | Dismissible payment warning | Payment portal CTA, features still available |
| Day 3-4 | Persistent countdown banner | Shows days remaining before read-only |
| Day 5-7 | Persistent stronger warning | Payment portal CTA and support-extension copy |
| Day 8+ | Read-only notice | Write actions disabled; billing/support/security remain reachable |

The copy should avoid ambiguity:

- Use absolute dates where possible, such as "Update payment by May 31, 2026".
- Explain that payment recovery restores access automatically after Stripe confirms payment.
- Link directly to Stripe Customer Portal when available.
- Provide support contact path if the portal cannot open.

Dismissal:

- Day 0-2 may be dismissible.
- Day 3+ is not dismissible.
- Dismissal should be scoped to the current past-due interval; a later `past_due_at` should reset dismissal.

#### Day-5 Modal

Show a full-screen modal on dashboard/login visit when:

- `past_due_at` age is at least 5 days,
- read-only has not started,
- the user has not dismissed the modal today.

Preferred persistence:

- Use local storage keyed by account ID and UTC date for Wave 2.
- If implementation planning identifies a cross-device requirement, use `accounts.flags` or a small table instead.

The modal must include:

- Days remaining.
- Payment portal CTA.
- "Need a few more days?" support-extension link or contact path.
- Dismiss for today.

#### Shared Recovery State And Read-Only Layer

The worker subscription guard remains the authoritative backstop, but it must not keep its own fixed grace formula. Wave 2 should introduce one shared recovery-state helper and adopt it in both UI/route code and `src/lib/shared/subscription-guard.ts`.

Define:

```text
read_only_starts_at = past_due_at + 7 days + active_extension_days
```

Read-only begins when `now >= read_only_starts_at`.

Helper boundary:

- Add `computePastDueRecoveryState(account)` or similar under `src/lib/shared/`.
- Inputs include `subscription_status`, `past_due_at`, and the parsed active extension from `accounts.flags.past_due_extension`.
- Returns `ageDays`, `deadline`, `daysRemaining`, `isReadOnly`, `extension`, and worker-guard allowance semantics.
- Dashboard data, UI components, route handlers, and `checkSubscription` consume this helper.
- The worker guard should stop using `businesses.updated_at` as its past-due clock and instead use `accounts.past_due_at` plus any active extension.

This avoids a two-source-of-truth failure where the UI grants an extension but workers still block sends at day 7.

Block or hide:

- approve,
- edit,
- publish/retry,
- regenerate,
- channel enrollment or changes that cause sends,
- new location add flows,
- brand voice changes that would affect generation,
- actions that enqueue response generation or publishing.

Allow:

- dashboard reads,
- past replies reads,
- Settings -> Billing,
- Stripe Customer Portal,
- support/contact,
- Settings -> Security and MFA,
- logout,
- non-destructive account reads.

Do not duplicate date math across components.

#### Grant Extension

Add an admin/founder grant-extension action for past-due accounts.

Recommended Wave 2 data model:

- Store current extension in `accounts.flags.past_due_extension`.
- Shape:

```json
{
  "granted_at": "2026-05-25T12:00:00.000Z",
  "granted_by_user_id": "uuid",
  "days": 7,
  "reason": "customer requested card replacement window",
  "expires_at": "2026-06-01T12:00:00.000Z"
}
```

Use a dedicated table only if implementation planning identifies reporting, multiple-extension history, or revocation requirements that cannot be handled by `account_audit_log`.

Rules:

- Admin role required.
- AAL2 required from day one. Do not ship grant extension before the MFA/AAL2 helper exists.
- Ticket ID or support reason required.
- Maximum extension defaults to 7 days unless an explicit admin override is added later.
- Extension must not mutate `past_due_at`; it changes the shared recovery cutoff used by both UI and worker subscription guards.
- Every grant and revoke/expiry action writes `account_audit_log` through `writeAccountAuditLog`.

Support docs:

- `docs/support/macros/past-due-extension.md`.
- `docs/runbooks/support-extension.md`.

Macro content should include:

- Payment portal link.
- Explanation that successful payment auto-recovers the account.
- Offer for a 7-day extension while waiting for a replacement card.
- Internal checks before granting.

### Data Flow

Past-due banner:

1. Stripe webhook sets `accounts.past_due_at` on first transition to `past_due`.
2. Dashboard API includes `past_due_at`.
3. Shared recovery helper computes current phase and deadline.
4. UI renders the appropriate banner/modal/read-only state.

Grant extension:

1. Admin opens past-due account action.
2. Admin enters ticket ID/reason/days.
3. Route verifies admin role and AAL2.
4. Route updates `accounts.flags.past_due_extension`.
5. Route writes `account_audit_log`.
6. Shared recovery helper includes the extension in deadline math for UI and worker guards.

### Error Handling

- Missing `past_due_at` for a `past_due` account should fall back to conservative copy and log a warning; it should not crash the dashboard.
- Billing portal open failure should show Settings/Billing fallback and support contact.
- Invalid extension JSON in `accounts.flags` should be ignored with a logged warning, not grant unexpected access.
- Extension grant failures must not partially write flags without audit row. Use one transaction.

### Testing Plan

- Unit tests for recovery helper:
  - no `past_due_at`,
  - day 1,
  - day 3,
  - day 5,
  - day 7 boundary,
  - day 8 read-only,
  - extension pushes deadline,
  - expired extension ignored.
- Banner/component tests for day variants.
- Dashboard API tests that `past_due_at` is included for `past_due` accounts.
- Route/helper tests that blocked write actions are denied in read-only mode while billing/support/security routes remain reachable.
- Subscription guard tests that `checkSubscription` uses `past_due_at` plus active extension instead of `businesses.updated_at`.
- Admin extension tests:
  - admin role required,
  - AAL2 required,
  - reason/ticket required,
  - audit row written,
  - extension included in deadline math.
- E2E or focused component test for once-per-day modal dismissal.

### Acceptance Criteria

- A test account with `past_due_at = now - 1 day` shows day-1 warning.
- A test account with `past_due_at = now - 3 days` shows persistent countdown.
- A test account with `past_due_at = now - 5 days` shows day-5 modal eligibility.
- A test account with `past_due_at = now - 8 days` is read-only in owner UI and write routes.
- Billing, support, and security remain reachable in read-only mode.
- Grant extension changes the read-only cutoff used by both UI and worker guards, and is audit-logged.
- Support macro and runbook exist.
- No new Stripe dedup table or parallel dunning engine is introduced.

### Risks

- Read-only UI could hide a path the owner needs for recovery. Mitigation: keep billing, support, and security explicitly allowed.
- Extension data in JSON flags can become hard to query if support volume grows. Mitigation: audit log stores history; promote to a table only when reporting needs appear.
- Time zone confusion can create disputes. Mitigation: use UTC internally and render absolute dates in customer copy.

## Sub-Spec 04: Auth, MFA, And Audit Hardening

Source spec: `docs/sass_ready/04-auth-identity.md`.

### Current Repo Anchors

- Signup route: `src/app/api/auth/signup/route.ts`.
- Verify OTP route: `src/app/api/auth/verify-otp/route.ts`.
- Auth callback route: `src/app/api/auth/callback/route.ts`.
- Google OAuth hook: `src/components/auth/hooks/useGoogleOAuth.ts`.
- Existing settings shell: `src/components/dashboard/settings/SettingsShell.tsx`.
- Existing settings tabs: `src/components/dashboard/SettingsTabs.tsx`.
- Current settings pages: `src/app/(authenticated)/settings/*`.
- Existing rate limiter: `src/lib/shared/rate-limit.ts`.
- Edge proxy: `src/proxy.ts` plus `src/lib/shared/protected-routes.ts`.
- Audit helper: `src/lib/audit/log.ts`.

### External API Boundary

Use Supabase Auth MFA rather than custom TOTP crypto.

Current Supabase docs state:

- TOTP enrollment uses `supabase.auth.mfa.enroll()`.
- Challenge and verification use `supabase.auth.mfa.challenge()` and `supabase.auth.mfa.verify()`, or `challengeAndVerify()`.
- AAL checks use `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`.
- Factor listing and unenrollment use `supabase.auth.mfa.listFactors()` and `supabase.auth.mfa.unenroll()`.
- Supabase supports TOTP and phone verification as second factors.
- Supabase recovery codes are not supported; users can enroll multiple factors, with an upper limit of 10.

Sources:

- https://supabase.com/docs/guides/auth/auth-mfa/totp
- https://supabase.com/docs/reference/javascript/auth-mfa-api

Wave 2 must not promise downloadable recovery codes unless RepWorth deliberately builds a custom backup-code system. This design does not include custom recovery codes.

### Design

#### Settings -> Security

Add a new Settings -> Security tab.

Capabilities:

- Show current MFA status.
- Start TOTP enrollment.
- Display Supabase-provided QR code and manual secret.
- Verify the factor with a TOTP code.
- List enrolled factors.
- Unenroll a factor only after re-authentication or current AAL2 verification.
- Encourage a second enrolled factor as backup because recovery codes are not supported.

UI states:

- No factor enrolled: explain security benefit and allow enrollment.
- Unverified factor in progress: show QR/secret and verify form.
- Verified factor enrolled: show active status and factor list.
- MFA required by policy but not enrolled: blocking prompt for billing owner/admin-sensitive access.
- MFA challenge required: code-entry screen before protected app/admin access.

#### Login Challenge Flow

After first-factor login or callback:

1. Call `getAuthenticatorAssuranceLevel()`.
2. If `nextLevel = aal2` and `currentLevel = aal1`, route to an MFA challenge screen.
3. Challenge the selected factor.
4. Verify code.
5. Let Supabase refresh the session to AAL2.
6. Continue to intended destination.

Sensitive routes must check AAL where required. Do not rely only on "has a factor enrolled"; the current session must be AAL2.

Recommended helper boundaries:

- `src/lib/auth/mfa.ts` or similar wrapper for Supabase MFA calls and AAL checks.
- `requireAal2(req)` for route handlers.
- `getMfaPolicyForAccount(account)` for owner tier/billing policy.
- Component-level hooks can call the wrapper but should not duplicate policy.

#### MFA Enforcement Policy

Wave 2 enforcement:

- Billing owner sensitive flows require MFA enrollment and AAL2:
  - Stripe portal open if billing-owner policy is active,
  - plan/tier changes,
  - location add/remove when it changes billing,
  - past-due grant-extension for admins.
- Scale/Premium owners require MFA before normal dashboard use once policy is enabled.
- In the current single-owner model, "billing owner" means the account owner represented by `accounts.owner_user_id` and the owner user on `users.account_id`.
- Admin support powers require AAL2:
  - impersonation start,
  - grant extension,
  - destructive admin/account actions.

Rollout:

- Add an env-var kill switch for enforcement, such as `MFA_ENFORCEMENT_ENABLED`.
- Enrollment UI can ship before blocking enforcement.
- Blocking enforcement should be enabled after owner/admin regression tests pass.

#### Rate-Limit Hardening

Extend `src/lib/shared/rate-limit.ts` callers. Do not add `@upstash/ratelimit`.

Add limits:

- Password reset: 5 requests per email per hour.
- Login failures: stepped cooldown after 5 failures per email/IP pair.
- MFA challenge attempts: bounded attempts per factor/session window.
- MFA enrollment attempts: bounded starts per user/day.
- Sensitive admin/support actions: strict/fail-closed rate limit mode.

Responses:

- Return `429` with `Retry-After` where possible.
- Avoid account enumeration; email-specific failure copy must remain generic.
- Log threshold events with IP and user agent where available.

#### Audit Consistency

Wire touched actor actions through `writeAccountAuditLog`.

Wave 2 event names:

- `mfa_factor_enrolled`
- `mfa_factor_unenrolled`
- `mfa_challenge_failed`
- `mfa_policy_blocked`
- `past_due_extension_granted`
- `past_due_extension_revoked`
- `csv_bulk_import`
- `impersonation_started`
- `impersonation_ended`
- `impersonated_action_blocked`

Payloads should include enough detail for investigation without secrets:

- Factor type, not TOTP secret.
- IP/user agent/request ID when available.
- Ticket ID/reason for support actions.
- Account ID and entity IDs.
- No raw tokens, no MFA codes, no provider secrets.

#### Account Memberships Boundary

Do not include Settings -> Team invite UI in Wave 2. Do not add `account_memberships` unless implementation planning proves it is required for the selected MFA policy or impersonation gates.

The current live model remains:

- `users.role` for platform role (`owner`, `sales_partner`, `admin`).
- `accounts.owner_user_id` for single-owner account ownership.
- `users.account_id` for owner scoping.

### Data Flow

TOTP enrollment:

1. Owner opens Settings -> Security.
2. UI calls enrollment wrapper.
3. Supabase creates unverified factor and returns QR/secret.
4. Owner enters code.
5. UI challenges and verifies.
6. Supabase promotes current session to AAL2.
7. Route writes `mfa_factor_enrolled` audit row.

MFA login challenge:

1. Owner/admin completes first factor.
2. App checks AAL.
3. If challenge required, user is routed to MFA challenge page.
4. User verifies code.
5. Session becomes AAL2.
6. User returns to intended route.

Sensitive route:

1. Request reaches route handler.
2. Auth role is verified.
3. `requireAal2(req)` verifies current assurance.
4. Action proceeds or returns a clear MFA-required response.
5. Sensitive action writes account audit row in the same transaction as state change where applicable.

### Error Handling

- Supabase MFA enrollment errors should be shown without exposing internals.
- A failed MFA challenge should not reveal whether email/password was correct beyond existing first-factor session state.
- Lost factor support is manual in Wave 2: admin can help after identity verification and full audit; no custom recovery-code system.
- Rate-limit Redis failure on sensitive admin actions should fail closed.
- Rate-limit Redis failure on lower-risk public actions may keep current fail-open behavior if already established.

### Testing Plan

- MFA wrapper tests with mocked Supabase:
  - enroll success,
  - verify success,
  - list factors,
  - AAL1 -> AAL2 challenge required,
  - AAL2 allowed,
  - unenroll requires AAL2.
- Settings -> Security component tests:
  - no factor,
  - enrollment in progress,
  - verified factor,
  - required-by-policy prompt,
  - errors.
- Route tests:
  - billing sensitive action blocked at AAL1,
  - allowed at AAL2,
  - admin support action blocked at AAL1,
  - audit row written at AAL2.
- Rate-limit tests:
  - reset request limit,
  - login failure stepped cooldown,
  - MFA challenge attempts,
  - `Retry-After` response.
- Regression tests:
  - email/password login still works,
  - Google OAuth still routes correctly,
  - magic link/OTP callback still routes correctly.

### Acceptance Criteria

- Settings -> Security page is live.
- Owners can enroll and verify TOTP.
- Enrolled users complete an MFA challenge before protected access when AAL is insufficient.
- Billing-owner sensitive flows require AAL2 when enforcement is enabled.
- Admin support actions require AAL2.
- Rate limits exist for password reset, login failures, and MFA challenge attempts.
- New sensitive actor actions write `account_audit_log` through `writeAccountAuditLog`.
- Existing email/password, Google OAuth, and magic-link flows are not broken.
- No custom recovery-code system is introduced.
- No teams/invite UI is introduced.

### Risks

- MFA enforcement can lock out an owner. Mitigation: ship enrollment UI before enforcement, keep a documented audited support recovery path, and allow multiple factors.
- AAL checks can be applied inconsistently. Mitigation: centralize policy helpers and test route-level gates.
- Support recovery without recovery codes can become subjective. Mitigation: require ticket ID, documented identity-verification steps, admin AAL2, and audit rows for every intervention.

## Sub-Spec 13: Support, KB, And Impersonation

Source spec: `docs/sass_ready/13-customer-support.md`.

### Current Repo Anchors

- Admin shell: `src/app/admin/layout.tsx`.
- Existing admin pages: `src/app/admin/*`.
- Existing settings shell: `src/components/dashboard/settings/SettingsShell.tsx`.
- Existing account audit table: `account_audit_log`, migrations `034` and `043`.
- Existing audit helper: `src/lib/audit/log.ts`.
- Edge proxy: `src/proxy.ts` plus `src/lib/shared/protected-routes.ts`.

### Design

#### Support Operating Spine

Use Help Scout as the source of truth for tickets and support workflow.

Configuration:

- Inboxes:
  - `support@`
  - `billing@`
  - `security@`
  - `report@`
- Tags:
  - `tier:basic`
  - `tier:standard`
  - `tier:premium`
  - `billing`
  - `connect`
  - `activation`
  - `bug`
  - `security`
  - `feature-request`
- Workflows:
  - Premium/Scale tier messages alert founder/CSM queue.
  - Billing past-due messages route to billing queue.
  - Security/report messages route to security queue.
- Auto-responder:
  - includes ticket ID,
  - includes expected SLA,
  - points to `/help/contact` and relevant KB.

Wave 2 code should not depend on Help Scout APIs unless implementation planning identifies a hard need. Initial setup can be config, docs, and app links.

#### Help And KB Surface

Add `/help/contact` as a public-safe route or app route reachable from both public and authenticated surfaces.

Content:

- Support channels.
- Business hours.
- Tier SLA.
- Billing recovery link.
- Security/reporting contact.
- Links to activation-critical KB docs.

Add version-controlled help docs under `docs/help/`:

- `connect-google-business.md`
- `response-pending.md`
- `brand-voice.md`
- `billing-past-due.md`
- `csv-import.md`

Recommended Wave 2 approach:

- Use repository Markdown plus simple app routes/links first.
- Defer Mintlify or separate docs hosting unless implementation planning decides it is low-cost and clearly useful.

Link `/help/contact` from stuck states:

- Zernio connect error/fallback.
- Past-due banner and modal.
- CSV import partial failure.
- Dashboard error state.
- Settings -> Security support/recovery copy.

#### Macro Library

Create `docs/support/macros/`.

Initial macros:

- `past-due-extension.md`
- `connect-google-business.md`
- `response-pending.md`
- `brand-voice.md`
- `csv-import.md`
- `security-report.md`

Each macro includes:

- When to use.
- Customer reply.
- Internal checks.
- Escalation path.
- Links to KB/help docs.

The past-due macro is shared with Sub-Spec 05/29 and must match grant-extension behavior.

#### Admin Impersonation

Add a dedicated session table:

```sql
CREATE TABLE impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- application should pass UUIDv7
  actor_user_id UUID NOT NULL REFERENCES users(id),
  impersonated_user_id UUID NOT NULL REFERENCES users(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  ticket_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Indexes:

- `(actor_user_id, started_at DESC)`.
- `(impersonated_user_id, started_at DESC)`.
- `(account_id, started_at DESC)`.
- partial active-session index where `ended_at IS NULL`.

RLS:

- Service/admin-only writes.
- Add an authenticated select policy only if `src/proxy.ts` needs to validate active sessions at the edge; the policy must be limited to `actor_user_id = current user` and platform `admin`.
- Owner users should not read this table directly unless a later audit-log export flow exposes a sanitized view.

Mechanism:

- Do not swap the Supabase Auth session and do not make the browser "become" the owner.
- The admin remains authenticated as the admin user.
- Start impersonation sets a signed, httpOnly first-party cookie containing an opaque impersonation session token or session ID.
- Customer view lives under an admin-owned route namespace, such as `/admin/impersonate/[sessionId]/view`, wrapped in a visible impersonation shell.
- Server-side impersonation loaders validate: admin session, AAL2, active impersonation session, TTL, ticket/reason presence, and account scope.
- Data access for the view uses server-only service-role helpers scoped by `account_id`; the service key never reaches the browser or `src/proxy.ts`.
- Owner RLS routes under `/dashboard` and `/settings` are not reused by pretending the admin is an owner. Shared UI components may be reused only behind server loaders that supply scoped data.
- Impersonated writes go through admin-prefixed impersonation APIs with an explicit allowlist and full audit metadata.

Edge proxy constraints:

- `src/proxy.ts` can verify the admin Supabase session and AAL using the cookie-bound anon client.
- It must not read arbitrary customer data and must not use `SUPABASE_SERVICE_KEY`.
- If proxy-level impersonation validation is needed, use only a signed cookie and/or a narrowly RLS-readable active-session row for the actor admin.

Start workflow:

1. Admin opens `src/app/admin/impersonate` or an action from admin business detail.
2. Admin selects/searches customer user or account.
3. Admin enters Help Scout ticket ID and reason.
4. Route requires platform admin role.
5. Route requires AAL2.
6. Route creates `impersonation_sessions` with max one-hour `expires_at`.
7. Route writes `account_audit_log` event `impersonation_started`.
8. Route sets the signed httpOnly impersonation cookie.
9. UI redirects to the admin-owned impersonation view with a visible banner.

End workflow:

1. Admin clicks end impersonation, or TTL expires.
2. Session is marked `ended_at`.
3. Route writes `impersonation_ended`.
4. App clears the signed impersonation cookie.

Session rules:

- Maximum TTL: 1 hour.
- No extension; start a new audited session with a new reason if needed.
- Only one active impersonation session per actor by default.
- Impersonation must be visually obvious on every page inside the admin-owned impersonation view.
- Every allowed write during impersonation should include `impersonating: true` in audit payload where practical.

#### Destructive-Action Block

During impersonation, block:

- account deletion,
- billing cancellation,
- payment method changes,
- plan downgrades/upgrades,
- password changes,
- MFA unenroll,
- owner email changes,
- approval/publish actions unless the owner has explicitly approved through the normal approval path,
- anything that bypasses the no-auto-posting invariant.

Allow:

- read-only diagnosis,
- navigation,
- viewing connection state,
- viewing billing state,
- support/contact pages,
- non-destructive settings inspection.

Implementation should use an allowlist for impersonated write actions. Unknown write actions should be blocked by default.

#### In-App Chat

Wave 2 may add an in-app support launcher if low-cost. It is not required for the first implementation plan if Help Scout, `/help/contact`, KB docs, and macros cover activation-critical support.

If added:

- Hide outside business hours or route to email.
- Do not expose sensitive account context to a third-party widget without confirming sub-processor and legal docs are accurate.
- Link from dashboard/connect/billing states.

### Data Flow

Support request:

1. Customer hits `/help/contact` or email.
2. Help Scout creates ticket and auto-responder.
3. Macro/KB guides initial response.
4. If diagnosis needs customer view, admin starts impersonation with ticket ID.
5. Impersonation session and audit rows record access.

Impersonated request:

1. Admin requests an admin-owned impersonation route.
2. Server loader validates admin auth, AAL2, signed impersonation cookie, active session, TTL, and account scope.
3. Server loader reads customer data through server-only service helpers scoped to the impersonated `account_id`.
4. UI shows impersonation banner inside the impersonation shell.
5. Write action calls an admin-prefixed impersonation API.
6. API guard blocks destructive/unknown writes by default.
7. Allowed write actions include impersonation metadata in audit payload.

### Error Handling

- Expired impersonation session should end cleanly, clear the signed cookie, and redirect admin to admin context.
- Missing/invalid ticket ID should block session creation.
- AAL1 admin should be sent to MFA challenge before impersonation.
- Failed audit write on start/end should fail the impersonation state change; do not create an unaudited impersonation session.
- Help Scout outage should not block `/help/contact`; show email fallback.

### Testing Plan

- Migration structure test for `impersonation_sessions`.
- Admin route tests:
  - non-admin blocked,
  - admin AAL1 blocked,
  - admin AAL2 allowed,
  - ticket ID required,
  - reason required,
  - TTL capped at one hour,
  - audit row written.
- Impersonation helper tests:
  - active session recognized,
  - expired session ignored/ended,
  - signed cookie required,
  - server-only scoped loader refuses mismatched account IDs,
  - one active session per actor behavior.
- Edge proxy tests:
  - admin-owned impersonation routes stay admin-authenticated,
  - no service-role data is required at the edge.
- Destructive-action guard tests:
  - blocked actions denied,
  - allowed read routes pass,
  - unknown write action blocked.
- Banner component tests.
- `/help/contact` page test.
- Macro/docs existence test if a docs lint/test pattern exists.

### Acceptance Criteria

- Help Scout setup is documented and ready with inboxes, tags, workflows, and auto-responder copy.
- `/help/contact` is live and linked from activation, billing, and support-relevant stuck states.
- `docs/help/` contains activation-critical KB docs.
- `docs/support/macros/` contains at least the six initial macros.
- Admin impersonation can start only with admin role, AAL2, ticket ID, and reason.
- Impersonation expires after one hour and cannot be extended.
- Impersonation banner is visible across the admin-owned impersonation view.
- Destructive actions are blocked during impersonation.
- Start/end are written to `account_audit_log`.
- Impersonation session state is stored in `impersonation_sessions`.
- Admin impersonation does not swap the Supabase Auth session and does not reuse owner RLS routes by pretending the admin is the customer.

### Risks

- Impersonation can become a security liability. Mitigation: AAL2, ticket/reason, one-hour TTL, visible banner, audit rows, destructive-action block, and monthly review.
- KB docs can drift. Mitigation: version docs in repo and refresh top support macros monthly.
- Third-party support widgets can create sub-processor/legal drift. Mitigation: Help Scout links/docs first; add chat only after vendor/legal update.

## Cross-Slice Dependencies

```text
activation events
  -> TTFV and funnel metrics
  -> support KB priorities and activation fixes

past_due_at
  -> shared recovery helper
  -> day-aware banner
  -> read-only cutoff
  -> worker subscription guard
  -> grant-extension cutoff

MFA/AAL2
  -> grant extension
  -> admin impersonation
  -> destructive-action guard

account_audit_log + writeAccountAuditLog
  -> CSV import audit
  -> extension audit
  -> MFA audit
  -> impersonation audit
```

Implementation order should respect these dependencies:

1. Event taxonomy, first-party analytics queue, and activation helper updates.
2. Past-due recovery helper and dashboard data changes.
3. Settings -> Security and AAL2 helper.
4. Grant-extension admin route once AAL2 helper exists.
5. Help/contact docs and macro library.
6. Impersonation table and route once AAL2 and audit paths are ready.

## Error Handling Summary

- Analytics enqueue/dispatch failures are best-effort and must not block customer workflows.
- Billing recovery state and grant-extension audit are strict; state change and audit must be atomic.
- MFA route errors should be clear but not leak sensitive details.
- Rate-limit failures on sensitive support/admin actions should fail closed.
- Impersonation cannot start or end without audit.
- Unknown impersonated write actions are blocked by default.

## Testing Strategy

Each slice should include focused tests plus a final build:

- Onboarding:
  - event taxonomy docs test,
  - worker event capture tests,
  - Zernio connect UI tests,
  - CSV client/UI tests.
- Billing recovery:
  - recovery helper tests,
  - dashboard data tests,
  - banner/modal tests,
  - read-only route/action tests,
  - grant-extension tests.
- Auth/MFA:
  - Supabase MFA wrapper tests,
  - Settings -> Security tests,
  - AAL2 route-gate tests,
  - rate-limit tests,
  - auth regression tests.
- Support/impersonation:
  - migration structure tests,
  - admin impersonation route tests,
  - destructive-action guard tests,
  - banner tests,
  - help/contact route tests.

Verification commands after implementation should include the narrowest changed Vitest targets and `pnpm build`, per repo instructions.

## Wave 2 Acceptance Criteria

- TTFV from email verification to first AI draft is measurable.
- Zernio connect drop-off is measurable and connect UI has help/retry fallback.
- Logged-out demo entry exists and demo-to-signup conversion is measurable.
- CSV template, client validation, and partial-success UI are shipped.
- Past-due banner is day-aware and uses `accounts.past_due_at`.
- Day-5 modal and day-8 read-only UI behavior work for controlled test accounts.
- Admin grant extension exists, changes the shared UI/worker recovery cutoff, and is audit-logged.
- Settings -> Security supports Supabase TOTP MFA enrollment and verification.
- AAL2 is required for billing-owner sensitive actions, grant extension, and impersonation.
- Password reset, login failure, and MFA challenge rate limits exist.
- Sensitive Wave 2 actor actions write `account_audit_log`.
- `/help/contact`, activation KB docs, and support macros exist.
- Admin impersonation is time-boxed, AAL2-gated, ticket/reason-gated, audited, and visibly bannered inside the admin-owned view-as shell.
- Destructive actions are blocked during impersonation.
- No removed checklist, direct Google OAuth, custom recovery-code system, full teams UI, or later-wave billing/legal/AI features are introduced.

## Follow-Up Boundaries

The implementation plan should split this design into reviewable tasks. It should not start coding until this written spec is reviewed and approved.

Likely follow-up specs or later waves:

- Spec 11: BI dashboards beyond lightweight PostHog activation dashboard definitions.
- Spec 05 later slice: full dunning emails, cancellation survey, Stripe Tax, and chargeback tabletop.
- Spec 04 later slice: teams, invites, account memberships, Microsoft SSO, passkeys.
- Spec 13 later slice: full docs site/Mintlify, in-app chat vendor, SLA reporting automation.
- Spec 29 later gaps: GBP-direct fallback, LLM margin rollups, Trust Center.
