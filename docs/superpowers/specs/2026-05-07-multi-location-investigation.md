# Multi-Location Investigation — Codebase Surface Map

**Date:** 2026-05-07
**Author:** Worker subagent (read-only investigation)
**Source spec:** `c:\Users\norbe\Desktop\RepWorth\docs\superpowers\specs\2026-05-06-multi-location-design.md`

This report inventories every surface that the multi-location mission must touch. It is read-only — no code or schema is modified.

---

## 1. Migrations and constraints

### 1.1 Migration head

- **Latest migration is `033_owner_leads.sql`** — confirmed by listing `c:\Users\norbe\Desktop\RepWorth\supabase\migrations\`. The proposed migration **034** is therefore correct as the next number.
- File: `c:\Users\norbe\Desktop\RepWorth\supabase\migrations\033_owner_leads.sql` (creates the `owner_leads` table; unrelated to the mission).

### 1.2 `channel_enrollments` constraint timeline (literal names in DDL)

| Migration | What it does | Literal name |
|---|---|---|
| `021_channel_enrollments.sql:41` | Inline `UNIQUE (business_id, channel)` inside `CREATE TABLE` | Postgres auto-named: `channel_enrollments_business_id_channel_key` |
| `022_sms_channel_infra.sql:58–62` | `DROP CONSTRAINT IF EXISTS channel_enrollments_business_id_channel_key;` then creates a partial unique INDEX (not a constraint) | `channel_enrollments_business_channel_active_key` (a UNIQUE INDEX, predicate `WHERE archived_at IS NULL`) |
| `027_one_mobile_channel_per_business.sql:22–26` | Adds defense-in-depth "at most one mobile channel per business" partial unique index | `channel_enrollments_one_mobile_per_biz` (predicate `channel IN ('sms','telegram','whatsapp') AND status IN ('pending_verification','verified') AND archived_at IS NULL`) |

**What's actually live after running 021 → 022 → 027:**
- The `UNIQUE (business_id, channel)` constraint (`channel_enrollments_business_id_channel_key`) is **dropped** in 022 and replaced by a partial unique INDEX named `channel_enrollments_business_channel_active_key`.
- The mobile-channel unique INDEX `channel_enrollments_one_mobile_per_biz` is also live.

The spec's `DROP CONSTRAINT IF EXISTS channel_enrollments_business_channel_active_key` will **not work** — that name is a UNIQUE INDEX (built with `CREATE UNIQUE INDEX`), not a CONSTRAINT. It must be dropped via `DROP INDEX IF EXISTS channel_enrollments_business_channel_active_key`. The spec's commentary correctly anticipates this ambiguity but the SQL it shows is wrong.

The spec also writes `DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_biz` — that **is** correct (matches 027).

### 1.3 Other `business_id` partial / unique indexes (rewrite candidates)

| File | Constraint / index | Notes |
|---|---|---|
| `001_initial_schema.sql:188` | `UNIQUE (provider, provider_review_name)` on `reviews` | Not business-scoped — fine. |
| `001_initial_schema.sql:236` | `UNIQUE (review_id, version)` on `responses` | Per-location — fine. |
| `001_initial_schema.sql:399` | `unique_business_week UNIQUE (business_id, week_start_date)` on `weekly_summaries` | Per-location — spec keeps this scoped to location, so fine. |
| `004_sync_reviews_dedup_constraint.sql` | per-business review dedup | Per-location — fine. |
| `005_nullable_review_exception_review_id.sql:11` | partial unique on `review_exceptions(business_id, type, payload->>'provider_review_id')` | Per-location — fine. |
| `008_retention_core.sql:12` | `UNIQUE (business_id, month_start_date)` on `monthly_impact_emails` | Per-location — fine. |
| `008_retention_core.sql:22` | partial unique on `notification_deliveries` `(business_id, template, sent_at DESC)` | Per-location — fine. |
| `011_engagement_alert_dedup.sql` | engagement-alert dedup keyed by `(business_id, ...)` | Per-location — fine. |
| `014_retention_expansion.sql:31, 54, 150` | onboarding_drip / satisfaction / ranking unique constraints keyed by `business_id` | Per-location — fine. |
| `017_sprint6_scale.sql:30` | `UNIQUE NULLS NOT DISTINCT (business_id, provider, rollup_date)` on `api_costs_daily_rollups` | Per-location — fine; spec doesn't move this rollup table to account scope. |
| `023_non_terminal_response_uniqueness.sql` | `responses_non_terminal_review_uniq` keyed on `review_id` | Per-location (review_id → business_id). Multi-location-safe per spec §7.4. |
| `025_signup_schema.sql:5–14` | `idx_businesses_pending_unpaid_self_serve_cleanup`, `idx_users_owner_auth_by_business` | Both partial; the second indexes `users(business_id)` for the cleanup poller's JOIN. Spec drops `users.business_id` in 034 → **this index will need to be dropped or rewritten**. |
| `026_zernio_publishing.sql:99–155` | partial unique on `zernio_connections(business_id)` and `zernio_finalize_incidents` indexes | Per-location — fine (spec keeps zernio_connections scoped to location). |
| `028_zernio_backfill_runs.sql:37` | `idx_zernio_backfill_runs_business` | Per-location — fine. |
| `031_edit_existing_replies.sql:55` | `reviews(business_id, review_date DESC)` index | Per-location — fine. |
| `032_onboarding_demos.sql:5, 40` | `onboarding_demos.business_id` + supporting index | Per-location — fine. |

**Index requiring rewrite in 034 (beyond what the spec calls out):** `idx_users_owner_auth_by_business` from migration 025. Because spec §3.3 drops `users.business_id`, this index disappears with the column. The cleanup-poller JOIN (`worker/background/pollers/CleanupAbandonedSignupsPoller.ts`) currently relies on it and will need a new `users(account_id)` index.

### 1.4 RLS policies referencing `business_id`

Searched all migrations for `CREATE POLICY` / `CREATE OR REPLACE POLICY` / `ALTER POLICY`. Result:

- **`006_users_rls_policy.sql:10`** — `users_self_select` on `users`: `auth_id = auth.uid()::text`. **Does not reference `business_id`.**

That is the **only `CREATE POLICY` in the entire migrations directory**. RLS is `ENABLED` on many tables (see §2 below) but **no policies are defined** — so all browser-bound queries fail closed and all writes/reads happen via the service-role connection (`src/lib/db/server.ts`). The middleware re-affirms this in a comment (`src/middleware.ts:5–8`):

> Role lookups use the cookie-bound anon client below, relying on the `users_self_select` RLS policy (migration 006) that lets any authenticated user read their own row. Removes `SUPABASE_SERVICE_KEY` from Edge middleware.

**Implication for the mission:** the orchestrator's "RLS rewrites" item is real: there are essentially **no per-table RLS predicates today**. The mission would need to invent the predicate pattern from scratch (e.g., a `auth.uid() → users.auth_id → users.account_id → table.account_id` lookup chain) for every protected table, not "rewrite" existing ones.

---

## 2. RLS policy patterns

### 2.1 Tables with RLS enabled (no policies, service-role-only access)

From `ENABLE ROW LEVEL SECURITY` matches across migrations:

| Table | Migration enabling RLS | Policy? |
|---|---|---|
| `users` | `006_users_rls_policy.sql:8` | **YES** — `users_self_select` (only policy in repo) |
| `businesses` | `001_initial_schema.sql:479` | None |
| `reviews` | `001_initial_schema.sql:480` | None |
| `responses` | `001_initial_schema.sql:481` | None |
| `approval_links` | `001_initial_schema.sql:482` | None |
| `notification_deliveries` | `001_initial_schema.sql:483` | None |
| `weekly_summaries` | `001_initial_schema.sql:484` | None |
| `api_costs` | `001_initial_schema.sql:485` | None |
| `review_exceptions` | `001_initial_schema.sql:486` | None |
| `ranking_snapshots` | `001_initial_schema.sql:487` | None |
| `approval_audit_log` | `001_initial_schema.sql:488` (and re-enabled in `003_fix_audit_log_rls.sql:4`) | None |
| `monthly_impact_emails` | `008_retention_core.sql:15` | None |
| `onboarding_drip_log` | `014_retention_expansion.sql:34` | None |
| `satisfaction_responses` | `014_retention_expansion.sql:57` | None |
| `api_costs_daily_rollups` | `017_sprint6_scale.sql:33` | None |
| `channel_enrollments` | `021_channel_enrollments.sql:71` | None |
| `sms_sender_opt_outs` | `022_sms_channel_infra.sql:49` | None |
| `sms_sender_opt_out_events` | `022_sms_channel_infra.sql:50` | None |
| `zernio_connections` | `026_zernio_publishing.sql:123` | None |
| `zernio_finalize_incidents` | `026_zernio_publishing.sql:163` | None |
| `zernio_backfill_runs` | `028_zernio_backfill_runs.sql:39` | None |
| `owner_leads` | `033_owner_leads.sql:23` | None |

**Tables with RLS NOT enabled at the migration layer** (best read of file dumps): `inbound_events`, `job_outbox`, `prospect_demos`, `google_connections`, `onboarding_demos`. These are service-role-only by design.

### 2.2 The lone existing predicate

```sql
-- 006_users_rls_policy.sql
CREATE POLICY users_self_select ON users
  FOR SELECT
  TO authenticated
  USING (auth_id = auth.uid()::text);
```

The middleware path uses this to read its own `users.role` + `users.business_id` row through the cookie-bound anon Supabase client. After the spec's drop of `users.business_id`, the middleware (`src/middleware.ts:50–58`) **must** be updated to read `account_id` instead — this is code, not RLS.

---

## 3. Subscription guard pattern

### 3.1 Canonical helper

`c:\Users\norbe\Desktop\RepWorth\src\lib\shared\subscription-guard.ts` — `checkSubscription(status, businessUpdatedAt, workerType)` returns `{ allowed: true } | { allowed: false; reason }`. Workers pass it `business.subscription_status` and `business.updated_at`. This is the chokepoint the spec recommends migrating to "hop business → account.subscription_status."

### 3.2 Workers calling `checkSubscription`

| File | Line | Worker type passed |
|---|---|---|
| `worker/jobs/zernio/ZernioReviewIngestWorker.ts:96` | 96 | `'generator'` |
| `worker/jobs/zernio/ZernioBackfillWorker.ts:85` | 85 | `'generator'` |
| `worker/jobs/WeeklySummaryWorker.ts:47` | 47 | `'summary'` |
| `worker/jobs/ResponseGeneratorWorker.ts:78` | 78 | `'generator'` |
| `worker/jobs/publisher/ResponsePublisherWorker.ts:101` | 101 | `'publisher'` |
| `worker/jobs/OwnerEmailWorker.ts:71` | 71 | `'owner_email'` |
| `worker/jobs/notification/eligibility.ts:54` | 54 | `'notification'` |
| `worker/jobs/MonthlyImpactWorker.ts:46` | 46 | `'summary'` |
| `worker/jobs/EngagementAlertWorker.ts:43` | 43 | `'notification'` |

`worker/jobs/RankingTrackingWorker.ts:39` deliberately reads `subscription_status` directly (status === `'active'` only — strict, no grace).

`worker/jobs/OnboardingDemoWorker.ts:74` reads `business.subscription_status === 'pending_payment'` directly to invert the guard (demo is only relevant pre-pay).

### 3.3 Direct `subscription_status` reads — server / API / SSR

| File | Purpose |
|---|---|
| `src/middleware.ts:110` | Comment only — middleware does NOT read `subscription_status` itself |
| `src/lib/auth/require-owner-access.ts:47–57` | SSR guard for `/dashboard`, `/settings/*`. JOINs `users → businesses` and rejects unless `subscription_status = 'active'` |
| `src/lib/onboarding/create-business.ts:201, 306` | INSERTs `subscription_status = 'pending_payment'` (admin + self-serve flows) |
| `src/lib/admin/business-detail-service.ts:80, 235` | Admin business detail page reads tier + status |
| `src/app/onboarding/start/page.tsx:36–46` | Self-serve start page guard |
| `src/app/onboarding/pay/page.tsx:54–81` | Self-serve pay page guard |
| `src/app/onboarding/business/page.tsx:41` and `guard.ts:42` | Post-pay business-details wizard guard (requires `'active'`) |
| `src/app/onboarding/demo/page.tsx:46–56` | Self-serve onboarding-demo page guard |
| `src/app/api/onboarding/start/route.ts:59–72, 177` | Verifies status is `pending_payment` |
| `src/app/api/onboarding/select-plan/route.ts:198` | UPDATEs `subscription_tier` (in-tx, FOR UPDATE) |
| `src/app/api/onboarding/business/route.ts` | Verifies status is `'active'` after pay |
| `src/app/api/zernio/connect/start/route.ts:66–68` | Worker-style guard, `'active'` only |
| `src/app/api/zernio/connect/select-location/route.ts` | Reads status |
| `src/app/api/dashboard/route.ts:42–104` | Reads `subscription_status, subscription_tier, onboarded_by` and branches: `pending_payment` → admin_handoff variant or self-serve payment link; `active` + missing place → `active_pending_business`; otherwise full dashboard |
| `src/app/api/auth/signup-status/route.ts` | Reads to drive UI hints |
| `src/app/api/admin/payment-success/route.ts:48–56` | Admin lookup for activation |
| `src/app/api/admin/businesses/route.ts` | Admin business listing |
| `src/app/api/admin/overview/route.ts` | Admin overview tile |

### 3.4 Stripe webhook writes

`worker/ingress/stripe.ts` is the **only** writer of `subscription_status` outside the create-business INSERT path:
- `processCheckoutSessionCompleted` (line 110+): `pending_payment | past_due` → `active` inside an advisory-locked tx. Also flips `stripe_customer_id`, `stripe_subscription_id`, `subscription_activated_at`.
- `processInvoicePaymentFailed`: `active` → `past_due`.
- `processInvoicePaid`: `past_due` → `active` (recovery).
- `processSubscriptionDeleted`: any → `cancelled`.
- `processSubscriptionUpdated` (line 281–293): maps single-item `price_id` → tier name and `UPDATE businesses SET subscription_tier = ${tier}`.

### 3.5 Literal status checks

Every `pending_payment` / `cancelled` / `past_due` / `active` literal hit appears in code paths above. There is no central enum module — status strings are sprinkled. Tests in `worker/jobs/__tests__/*.test.ts` mock `subscription_status` heavily.

---

## 4. Stripe integration

### 4.1 Webhook handler

`c:\Users\norbe\Desktop\RepWorth\worker\ingress\stripe.ts` is the single entry point. It is mounted on the Fastify worker process (NOT the Next.js app), routed via `worker/index.ts`. Signature is verified with `stripe.webhooks.constructEvent` reading `process.env.STRIPE_WEBHOOK_SECRET` (line 312).

Events handled (line 326–352):
- `checkout.session.completed` → activates business by `client_reference_id`.
- `invoice.payment_failed` → flips to `past_due`.
- `invoice.paid` → recovers to `active`.
- `customer.subscription.deleted` → `cancelled`.
- `customer.subscription.updated` → tier remap from `price_id`.

### 4.2 Stripe price/payment-link env vars

| Env var | Used in | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | `worker/ingress/stripe.ts:13` | Stripe SDK init (lazy singleton) |
| `STRIPE_WEBHOOK_SECRET` | `worker/ingress/stripe.ts:312` | `constructEvent` HMAC verification |
| `STRIPE_PRICE_FOUNDING` / `_STANDARD` / `_PREMIUM` | `worker/ingress/stripe.ts:283–285` | Reverse-map `price_id` → tier name in `customer.subscription.updated` |
| `STRIPE_PAYMENT_LINK_FOUNDING` / `_STANDARD` / `_PREMIUM` | `src/lib/payments/payment-link.ts:1–4` | Self-serve checkout redirect URLs |

**Self-serve flow does NOT use Stripe Checkout Sessions or Customer Portal sessions on the server side.** It uses pre-configured Stripe Payment Links (configured in the Stripe Dashboard) — the server only constructs URLs with `client_reference_id` + `prefilled_email` query params (`src/lib/payments/payment-link.ts`). This is critical for the spec's two-item subscription approach: today there is **no Checkout Session creation code** at all. Adding `tier_base` + `location_overage` items will require either:
- A new server-side Checkout Session creation flow, OR
- Re-configuring Payment Links in Stripe Dashboard with two prices each (and trusting Payment Link metadata to carry the location count).

### 4.3 Current subscription shape

One-item flat. Confirmed at `worker/ingress/stripe.ts:280`:
```ts
const priceId = sub.items?.data?.[0]?.price?.id;
```
The webhook reads only the first subscription item. There is no concept of multiple line items in code today.

`subscription_status` is set today by:
1. Initial INSERT in `create-business.ts` (always `'pending_payment'`).
2. Stripe webhook flips on `checkout.session.completed`, `invoice.payment_failed`, `invoice.paid`, `customer.subscription.deleted`.

### 4.4 Tier-name → price-ID mapping

The mapping is **inverted only** (price → tier) in `worker/ingress/stripe.ts:282–285`. The forward mapping (tier → price-ID for creating subscriptions) **does not exist**, because the codebase never creates subscriptions server-side.

The forward mapping for Payment-Link redirects lives in `src/lib/payments/payment-link.ts:1–4` as `TIER_ENV: { founding | standard | premium }` mapping to env-var names that hold full URLs (not price IDs).

**Tiers in code today: `'founding' | 'standard' | 'premium'`** (admin can choose `founding | standard` per `AdminBusinessTxInput.subscriptionTier`; self-serve hardcodes `'standard'` per `create-business.ts:130–134`). The spec adds `'basic'` and changes the default tier table — every tier-typed `'founding' | 'standard' | 'premium'` literal in the codebase will need to expand.

---

## 5. Notification dispatch

### 5.1 NotificationWorker — channel resolution path

`worker/jobs/notification/NotificationWorker.ts` orchestrates:
1. `loadNotificationContext` → loads `responses` + `businesses` rows (`worker/jobs/notification/context.ts`).
2. `getEligibleChannels` (`worker/jobs/notification/eligibility.ts`):
   - `checkSubscription` (subscription guard).
   - `getVerifiedEnrollments(businessId)` (`src/lib/notifications/enrollments.ts:18–32`):
     ```sql
     SELECT channel, handle FROM channel_enrollments
     WHERE business_id = $1 AND status='verified'
       AND unsubscribed_at IS NULL AND archived_at IS NULL
     ORDER BY created_at ASC
     ```
   - Per-channel feature-flag filter (`CHANNELS_SMS_ENABLED`, `CHANNELS_TELEGRAM_ENABLED`, `CHANNELS_WHATSAPP_ENABLED`).
3. `dispatchAll` (`worker/jobs/notification/dispatch.ts`) iterates the filtered list, sends per channel, records deliveries via `recordNotificationDelivery` / `insertFailedDelivery` from `src/lib/notifications/delivery.ts`.

**Today's resolver is implicit and per-business.** The spec calls for a brand-new `src/lib/notifications/resolve-channels.ts` that takes `(accountId, locationId)` and resolves org-default vs per-location override. That file does not exist today — it's net-new.

### 5.2 SMS STOP/START handler

`c:\Users\norbe\Desktop\RepWorth\worker\ingress\twilio\twilio.ts:81–197` (`handleTwilioInbound`). Behavior:
- STOP → upserts `sms_sender_opt_outs(messaging_service_sid, handle)`, writes `sms_sender_opt_out_events`, **flips ALL `channel_enrollments` rows where `handle = From AND channel = 'sms' AND archived_at IS NULL`** to `unsubscribed`. Already sender-wide across businesses today (line 145–151).
- START → updates `sms_sender_opt_outs.opted_in_at`, writes audit event. **Does NOT re-enable `channel_enrollments`** — admin must re-verify via /verify (line 158–167).

Intent classification: `worker/ingress/twilio/twilio-intent.ts`.

### 5.3 Approval inbound callback

There is **no SMS callback-mode approval handler today**. Approvals come exclusively through the web (`/approve/[token]` page → `/api/approve/[token]/*` API routes). Token-mode is the only mode. The spec's "token-mode and callback-mode" wording does not apply to the current codebase.

The existing approval flow correlates phone → business → response **only via the token**: `approval_links.token_hash → response_id → responses.business_id`. No phone-number lookup is needed today.

### 5.4 `delivery.ts` and `enrollments.ts` responsibilities

- `c:\Users\norbe\Desktop\RepWorth\src\lib\notifications\delivery.ts`:
  - `recordNotificationDelivery(params)` — INSERT a successful row.
  - `insertFailedDelivery(...)` — INSERT a failed row with `failure_reason`.
  - Both INSERT into `notification_deliveries` keyed by `business_id`.
- `c:\Users\norbe\Desktop\RepWorth\src\lib\notifications\enrollments.ts`:
  - Single export: `getVerifiedEnrollments(businessId)` — the query reproduced above. **No location/account awareness.** This is the single function the spec's resolver needs to subsume or replace.

### 5.5 Channel implementations + factory

`src/lib/notifications/channels/index.ts` (barrel) → `getChannel(channelId)` factory. Per-channel files:
- `email-channel.ts` (always allowed)
- `sms-channel.ts` (gated `CHANNELS_SMS_ENABLED`)
- `telegram-channel.ts` (gated `CHANNELS_TELEGRAM_ENABLED`)
- `whatsapp-channel.ts` (gated `CHANNELS_WHATSAPP_ENABLED`)

---

## 6. Approval flow

### 6.1 Page

`c:\Users\norbe\Desktop\RepWorth\src\app\(public)\approve\[token]\page.tsx`. Flow:
1. SHA-256 the raw token.
2. `SELECT response_id, business_id, expires_at, consumed_at, revoked_at FROM approval_links WHERE token_hash = ...`.
3. Render error states for missing / consumed / revoked / expired.
4. `SELECT name FROM businesses WHERE id = $business_id` for the page header.
5. Render `<ApprovalClient token={rawToken} />` (client component).

### 6.2 API routes

Under `c:\Users\norbe\Desktop\RepWorth\src\app\api\approve\[token]\`:
- `route.ts` — GET: returns review + response + business name (re-validates token, sets device + CSRF cookies).
- `session/route.ts` — POST: device-binds the token via cookie.
- `approve/route.ts` — POST: approve.
- `edit/route.ts` — POST: approve with edits.
- `regenerate/route.ts` — POST: regenerate (mark current `superseded`, enqueue new draft).

`business_id` derivation: pulled from `approval_links.business_id` (set when the link is created). Then JOINed downstream to surface `businesses.name`. The chain `approval_links.business_id → businesses.id` is denormalized in the row, not derived from `responses.business_id`.

### 6.3 What's displayed on the approval page

- Business name (from `businesses.name`).
- Review (reviewer name, star rating, review text, review date).
- Generated draft response (with version, status).
- Approve / Edit / Regenerate buttons.

The spec adds a "location chip" — the approval page would need to render `display_label` from `businesses` (or fall back to `name`). The page already has `business_id` available — adding the chip is straightforward.

---

## 7. Dashboard and settings UI

### 7.1 `src/app/(authenticated)/` directory map

```
src/app/(authenticated)/
├── layout.tsx                                   — auth check + OwnerNav rendering
├── dashboard/
│   ├── page.tsx                                 — renders <DashboardContent />
│   ├── connect/
│   │   ├── page.tsx                             — Zernio connect (`/dashboard/connect`)
│   │   └── select-location/page.tsx             — Zernio location picker
│   └── past-replies/page.tsx                    — gated by PAST_REPLIES_VIEW_ENABLED
└── settings/
    ├── page.tsx                                 — renders <SettingsTabs activeTab="general"/>
    ├── SettingsGeneralForm.tsx                  — voice / business profile form
    └── channels/
        ├── page.tsx                             — renders <SettingsTabs activeTab="channels"/>
        └── ChannelsClient.tsx                   — client component
```

### 7.2 Scoping mechanism per page

| Page | Scopes by `business_id` how |
|---|---|
| `layout.tsx` | Reads `users.business_id` via JOIN against `auth_id` from Supabase session cookie. Used only for showing `businessName` in nav. |
| `dashboard/page.tsx` | Delegates to `<DashboardContent>` which calls `useDashboardData()` (fetches `/api/dashboard` — server resolves business via session, no URL param). |
| `dashboard/connect/page.tsx` | Same — `useDashboardData()`. |
| `dashboard/past-replies/page.tsx` | Server-rendered, calls `requireOwnerAccess()` and uses `owner.businessId` directly. |
| `settings/page.tsx` | Server-rendered, calls `requireOwnerAccess()`; client form calls `/api/settings`. |
| `settings/channels/page.tsx` | Server-rendered, calls `requireOwnerAccess()`, queries `channel_enrollments WHERE business_id = access.businessId`. |

**There is no URL-based or cookie-based location selection today.** Every owner page resolves a single `business_id` from the Supabase session via `requireOwnerAccess()` (`src/lib/auth/require-owner-access.ts`) or via the `/api/dashboard` server logic (`src/app/api/dashboard/route.ts`). Adding a location switcher requires:
1. New cookie / URL param convention (spec says cookie).
2. Refactoring `requireOwnerAccess` to return `{ accountId, currentLocationId }`.
3. Plumbing `locationId` into every authenticated route handler.

### 7.3 `useDashboardData` hook

`c:\Users\norbe\Desktop\RepWorth\src\hooks\useDashboardData.ts`. Current signature:

```ts
export function useDashboardData(): UseDashboardDataResult { ... }
```

It takes **no arguments** — fetches `/api/dashboard` with no query params. The server uses session cookies to resolve business. Spec proposes `useDashboardData(scope: 'all' | LocationId)`. This is a single-file refactor on the hook plus matching `/api/dashboard` server changes.

### 7.4 Settings page — tabbed?

Yes. `src/components/dashboard/SettingsTabs.tsx` renders two tabs:
- **General** → `/settings`
- **Notification channels** → `/settings/channels`

Each tab is a separate route segment, NOT a client-side tab; navigation is `<Link>`-based. Spec proposes adding **Account**, **Locations**, **Voice** tabs. The `SettingsTabs` component would need expansion + new route segments.

---

## 8. Onboarding and user creation

### 8.1 `src/lib/onboarding/create-business.ts`

Two paths via discriminated union `CreateBusinessOptions = { mode: 'admin'; onboardedBy } | { mode: 'self_serve'; authId }`.

**Admin tx** (`runAdminTx`):
1. INSERT `businesses` with full profile fields, `subscription_status='pending_payment'`, `onboarded_by = $admin`.
2. INSERT `users` with `auth_id = NULL`, `role='owner'`, `business_id = $newBiz`.
3. INSERT `channel_enrollments` (email channel, `'verified'` status).
4. Conditionally INSERT `job_outbox` row for `validate_place_id` (only when there's a Maps URL but no verified Place ID).

**Self-serve tx** (`runSelfServeTx`):
1. INSERT `businesses` with PLACEHOLDER fields, `subscription_tier='standard'`, `subscription_status='pending_payment'`, `onboarded_by = NULL`.
2. INSERT `users` with `auth_id = $supabaseAuthId`, `role='owner'`, `business_id = $newBiz`.
3. **No `channel_enrollments` row** (deferred to `/api/auth/verify-otp`).
4. **No outbox row** (deferred to `/api/onboarding/business` once owner provides real place).

### 8.2 User-business linkage today

`users.business_id UUID` (FK to `businesses.id`). Inserted in both modes inside the same tx as the business INSERT. Self-serve also writes `auth_id` here — admin path writes NULL `auth_id` and the owner can later be invited.

### 8.3 Self-serve vs admin entry points

| Path | Entry route | Internal flow |
|---|---|---|
| Self-serve signup | `POST /api/auth/signup` (and `POST /api/auth/finish-signup` after email confirmation) | calls `createBusinessTx({ mode: 'self_serve', authId })`, then redirects to `/onboarding/start` → `/onboarding/select-plan` → Stripe Payment Link → `/onboarding/payment-success` → `/onboarding/business` (post-pay wizard) |
| Admin onboarding | `POST /api/admin/businesses` | calls `createBusinessTx({ mode: 'admin', onboardedBy })`, returns `paymentUrl` for the partner to forward |

The spec's "add-location wizard" is a NEW flow distinct from both — it must reuse some of the admin path's place-id verification + voice-config UI without creating a new `users` row.

---

## 9. Workers

### 9.1 Job workers (`worker/jobs/`)

| Worker | One-line description | Scopes by `business_id`? | Reads sub status via |
|---|---|---|---|
| `DemoGenerationWorker.ts` | Generates prospect demo responses | No (per `prospect_demos.id`) | n/a |
| `OnboardingDemoWorker.ts` | Generates self-serve onboarding demo | Yes (joins via `onboarding_demos.business_id`) | direct read (must be `'pending_payment'`) |
| `ResponseGeneratorWorker.ts` | Generates AI draft for one review | Yes | `checkSubscription('generator')` |
| `notification/NotificationWorker.ts` | Sends approval notification via verified channels | Yes | `checkSubscription('notification')` |
| `publisher/ResponsePublisherWorker.ts` | Posts approved response to Google via Zernio | Yes | `checkSubscription('publisher')` |
| `WeeklySummaryWorker.ts` | Sends weekly summary email | Yes | `checkSubscription('summary')` |
| `MonthlyImpactWorker.ts` | Sends monthly impact email | Yes | `checkSubscription('summary')` |
| `EngagementAlertWorker.ts` | Sends owner-nudge / partner-engagement alerts | Yes | `checkSubscription('notification')` |
| `OnboardingDripWorker.ts` | Sends day-1/7/30 drip emails | Yes | `checkSubscription` (mocked in test) |
| `OwnerEmailWorker.ts` | Owner-directed transactional emails (reconnect, connection lost) | Yes | `checkSubscription('owner_email')` |
| `RankingTrackingWorker.ts` | Ranks Google Maps for a keyword | Yes | direct read, strict `'active'` only |
| `PlaceIdValidationWorker.ts` | Validates Place ID from Maps URL | Yes | n/a (runs pre-pay) |
| `DrainOwnerConnectWorker.ts` | Drains owner-connect events post-disconnect | Yes | n/a |
| `AdminExceptionWorker.ts` | Sends admin exception emails | Yes | n/a |
| `zernio/ZernioReviewIngestWorker.ts` | Ingests one review from Zernio webhook | Yes | `checkSubscription('generator')` |
| `zernio/ZernioBackfillWorker.ts` | Initial 75-review backfill from Zernio | Yes | `checkSubscription('generator')` |

### 9.2 Background pollers (`worker/background/pollers/`)

| Poller | One-line description | Scopes by `business_id`? |
|---|---|---|
| `OutboxPoller.ts` | Dispatches `job_outbox` rows to BullMQ | No |
| `NotificationFailoverPoller.ts` | Detects all-deliveries-failed responses, re-enqueues notification | Yes |
| `EngagementMonitorPoller.ts` | Computes 30-day engagement metrics, fires alerts | Yes |
| `EmailChannelReconcilePoller.ts` | Reconciles email channel state | Yes |
| `CleanupAbandonedSignupsPoller.ts` | Deletes 7-day-old abandoned self-serve signups | Yes (gated by `SELF_SERVE_SIGNUP_ENABLED`) |
| `ArchivalPoller.ts` | Archives stale records | Yes |

### 9.3 Schedulers (`worker/background/schedulers/`)

| Scheduler | One-line description |
|---|---|
| `WeeklySummaryScheduler.ts` | Enqueues weekly summary jobs every Monday |
| `MonthlyImpactScheduler.ts` | Enqueues monthly impact jobs on the 1st |
| `OnboardingDripScheduler.ts` | Enqueues day-1/7/30 drip jobs |
| `RankingTrackingScheduler.ts` | Enqueues ranking jobs |

Every worker that calls `checkSubscription` reads `businesses.subscription_status` from the row. Spec requires migrating each call site to read from `accounts.subscription_status`. The proposed `getLocationContext(locationId)` helper in spec §10 would be the chokepoint.

---

## 10. Branded ID types and shared types

### 10.1 Branded types

**None.** Searched for `type (BusinessId|UserId|AccountId|LocationId|Brand)` across `src/` — no matches. Every ID is `string` (validated as UUID at runtime via Zod where it crosses a boundary, but no compile-time brand).

The mission's `src/lib/shared/ids.ts` (`AccountId`, `LocationId`, `BusinessId = LocationId`) is therefore brand-new.

### 10.2 Type-safe DB rows

There are **no generated Supabase types** in the repo (no `database.types.ts`, no `supabase gen types` artifact). Every query in `src/lib/db/server.ts` (the `postgres` library) types its return inline:

```ts
const rows = await sql<{ subscription_status: string; updated_at: Date }[]>`...`;
```

Per-domain types live near their consumers (e.g., `src/lib/admin/business-detail-types.ts`, `src/lib/dashboard/types.ts`). There is no central row-shape catalog.

### 10.3 Shared modules

`src/lib/shared/` contains:
- `subscription-guard.ts`, `worker-types.ts`, `outbox.ts`, `queue-names.ts`, `response-status.ts`, `schemas.ts`, `sentry-scrub.ts`, `protected-routes.ts`, `rate-limit.ts`, `csrf.ts`, `feedback-hmac.ts`, `request-ip.ts`, `auth-flow.ts`, `auth-responses.ts`, `mock-mode.ts`, `db-array.ts`, `logger.ts`, `sanitize.ts`, `html.ts`, `churn-score.ts`, `constants.ts`.

This is the natural home for the new `ids.ts` module.

`src/lib/db/` contains:
- `server.ts` (the `postgres` client + `sql`/`jsonb` helpers).
- `auth.ts` (the `requireRole(...)` helper used by API routes).
- `browser.ts` (Supabase browser client).
- `redis-cache.ts`.

The spec's proposed `src/lib/db/account-guard.ts` would land alongside `auth.ts` here.

---

## 11. Test patterns

### 11.1 vitest config

`c:\Users\norbe\Desktop\RepWorth\vitest.config.ts`:
- `environment: 'node'`
- `include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'worker/**/__tests__/**/*.test.{ts,tsx}']`
- alias `@` → `./src`
- uses **`oxc`** JSX runtime (not the default vitest TS pipeline). Note this is unusual.

`c:\Users\norbe\Desktop\RepWorth\vitest.setup.ts`:
- Stubs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DATABASE_POOL_URL` for tests that transitively import `db/server`.

**No worker-thread / pool config.** No special `poolOptions` (e.g., `forks` vs `threads`) or `testTimeout`. The Windows EPERM worker spawn issue mentioned in project memory is **not addressed in this config**.

### 11.2 Test organization

Colocated `__tests__/` directories. Confirmed by ~150 test files all under `**/__tests__/*.test.ts(x)`. No top-level `src/__tests__/` aggregate (there is one file `src/__tests__/middleware.test.ts` colocating with `src/middleware.ts`).

### 11.3 Shared fixtures / factories

**No shared fixture factory** for `businesses` / `users` rows that I could find. Tests roll their own. Examples:
- `src/lib/demos/__tests__/fixtures.ts` — demo-specific fixtures only.
- `worker/jobs/__tests__/*.test.ts` use a per-file `mockBusinessRow({ subscription_status })` pattern (defined inline).
- `worker/jobs/notification/__tests__/NotificationWorker.test.ts` and similar files mock `sql` returns via a queue (`sqlReturnQueue.push([...])`).

This means the multi-location mission will need to invent the fixtures-for-account/location pattern, or live with the existing `mockBusinessRow` style scaled out per worker.

### 11.4 Playwright

`c:\Users\norbe\Desktop\RepWorth\playwright.config.ts`:
- `testDir: './e2e'` (separate from unit test tree).
- `webServer.command: 'pnpm dev'`, `port: 3000`, `reuseExistingServer: true`.
- Optional `TEST_DATABASE_POOL_URL` env override is forwarded to the dev server so e2e tests can seed approval tokens.
- No auth fixture file in the config. Each test sets up its own session cookies.

### 11.5 Lint / typecheck / build

`package.json` scripts:
- `"lint": "next lint"`
- `"test": "vitest run"`
- `"build": "next build"` (worker is `tsc`-checked transitively via `next build`?)
- `"worker": "tsx worker/index.ts"`

There is no separate `tsc --noEmit` script, but `tsbuildinfo` (`tsconfig.tsbuildinfo` 870KB) suggests TS is running incrementally as part of `next build`.

---

## 12. Owner-facing surfaces (full surface map)

### 12.1 `(authenticated)` route group (owner pages)

Pages:
- `/dashboard` — `src/app/(authenticated)/dashboard/page.tsx`
- `/dashboard/past-replies` — `src/app/(authenticated)/dashboard/past-replies/page.tsx` (gated `PAST_REPLIES_VIEW_ENABLED`)
- `/dashboard/connect` — `src/app/(authenticated)/dashboard/connect/page.tsx`
- `/dashboard/connect/select-location` — `src/app/(authenticated)/dashboard/connect/select-location/page.tsx`
- `/settings` — `src/app/(authenticated)/settings/page.tsx`
- `/settings/channels` — `src/app/(authenticated)/settings/channels/page.tsx`

API routes (owner-callable, gated by middleware `pathname.startsWith('/api/dashboard') || '/api/settings'`):
- `GET /api/dashboard` — main dashboard data (subscription branching)
- `GET /api/dashboard/channels` — channels for owner
- `POST /api/dashboard/channels/telegram/start|cancel|disable` — telegram lifecycle (owner-callable)
- `GET /api/dashboard/reviews` (no folder shown in glob, but route file exists?) — actually the listings live under `dashboard/reviews/[reviewId]/(approve|edit|regenerate)/route.ts`
- `POST /api/dashboard/reviews/[reviewId]/approve` — owner approval action
- `POST /api/dashboard/reviews/[reviewId]/edit`
- `POST /api/dashboard/reviews/[reviewId]/regenerate`
- `GET/POST /api/settings` — settings read/write

Onboarding API routes (authenticated owner pre-active):
- `POST /api/onboarding/start`
- `POST /api/onboarding/select-plan`
- `POST /api/onboarding/business`
- `GET /api/onboarding/demo/status`
- `POST /api/onboarding/demo/regenerate`

Zernio connect routes (owner-callable):
- `POST /api/zernio/connect/start`
- `POST /api/zernio/connect/cancel`
- `POST /api/zernio/connect/select-location`
- `GET/POST /api/zernio/connect/callback`
- `POST /api/zernio/disconnect`

Auth routes (owner-callable):
- `POST /api/auth/signup`
- `POST /api/auth/finish-signup`
- `POST /api/auth/verify-otp`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/resend-confirmation`
- `GET /api/auth/signup-status`
- `GET /api/auth/callback`

### 12.2 `(public)` route group (unauthenticated)

Pages:
- `/` (landing) — `src/app/(public)/page.tsx`
- `/login`, `/signup`, `/signup/check-email`, `/signup/finish`
- `/forgot-password`, `/reset-password`
- `/pricing`, `/features`, `/how-it-works`
- `/book-a-demo`, `/feedback/thanks`, `/privacy`, `/terms`
- `/demo/[slug]` — prospect demo page
- `/approve/[token]` — approval page (entry from notification)

Public API routes (no auth):
- `POST /api/contact`
- `POST /api/lead-intake`
- `POST /api/demo-request`
- `POST /api/feedback`
- `POST /api/signup/place-prefill`
- All `/api/approve/[token]/...` routes (token-gated, not auth-gated)

### 12.3 `admin` (admin/sales_partner)

Pages:
- `/admin/login`, `/admin/forgot-password`, `/admin/reset-password`
- `/admin/overview`
- `/admin/businesses`, `/admin/businesses/new`, `/admin/businesses/[id]`
- `/admin/demos`
- `/admin/jobs`
- `/admin/notifications`
- `/admin/costs`
- `/admin/runbook`
- `/admin/payment-success`

API routes (admin-gated, `pathname.startsWith('/api/admin')`):
- `GET /api/admin/overview`
- `GET/POST /api/admin/businesses`, `/api/admin/businesses/[id]`, `/api/admin/businesses/[id]/channels|keywords|ranking`
- `POST /api/admin/businesses/prefill`
- `GET/POST /api/admin/channels/sms/(verify|status|disable|delete|confirm|cancel)`
- `GET/POST /api/admin/channels/telegram/(start|disable|cancel)`
- `GET/POST /api/admin/channels/whatsapp/(start|cancel|disable)`
- `GET /api/admin/costs`, `/api/admin/jobs`, `/api/admin/notifications`, `/api/admin/demos`
- `POST /api/admin/demos/generate`
- `GET /api/admin/payment-success` (called from `/admin/payment-success` page)

---

## 13. Feature flags

### 13.1 `SELF_SERVE_SIGNUP_ENABLED`

Read in (gates the entire self-serve flow):

| Location | Treatment |
|---|---|
| `src/app/(public)/signup/page.tsx`, `.../check-email/page.tsx`, `.../finish/page.tsx`, `.../login/page.tsx`, `.../forgot-password/page.tsx` (implicit), `.../reset-password/page.tsx` | `notFound()` if not `'true'` |
| `src/app/(public)/page.tsx`, `.../privacy/page.tsx`, `.../terms/page.tsx`, `.../pricing/page.tsx` | Conditional UI flag (`selfServeEnabled` boolean) |
| `src/app/onboarding/start|pay|business|payment-success/page.tsx` | `notFound()` if not `'true'` |
| `src/app/api/signup/place-prefill/route.ts`, `src/app/api/onboarding/{start,select-plan,business}/route.ts` | 404 if not `'true'` |
| `worker/config/startup-assert.ts:14–22` | Boot assert: requires `REDIS_CACHE_URL`, `NEXT_PUBLIC_APP_URL`, all 3 `STRIPE_PAYMENT_LINK_*` |
| `worker/index.ts:206` | Logs flag state at boot |
| `worker/background/pollers/CleanupAbandonedSignupsPoller.ts:274` | Poller only starts if flag is `'true'` |

### 13.2 Other env-flag patterns

| Flag | Where read |
|---|---|
| `CHANNELS_SMS_ENABLED` | `eligibility.ts:39`, `factory.ts`, settings/channels page |
| `CHANNELS_TELEGRAM_ENABLED` | same |
| `CHANNELS_WHATSAPP_ENABLED` | same |
| `MOCK_EXTERNAL_APIS` | `src/lib/shared/mock-mode.ts` (centralized helper `isMockMode()`) |
| `ZERNIO_PUBLISHING_ENABLED` | `worker/ingress/stripe.ts:60` and elsewhere |
| `PAST_REPLIES_VIEW_ENABLED` | `src/app/(authenticated)/layout.tsx:48` (server-only — passed as prop, no `NEXT_PUBLIC_*` companion) |
| `NOTIFICATION_FAILOVER_DISABLED` | `worker/index.ts:60` |
| Tier env: `STRIPE_PAYMENT_LINK_*`, `STRIPE_PRICE_*` | covered in §4 |

### 13.3 App Router pattern: server-only

All flag reads above are on the server side (Server Components, route handlers, worker process). The single counter-example is the public marketing pages (`(public)/page.tsx` etc.) where `process.env.SELF_SERVE_SIGNUP_ENABLED === 'true'` is evaluated at server-render time and the result is passed as a prop. **No `NEXT_PUBLIC_*` env vars are used for these flags** — they never reach the browser bundle.

The new `MULTI_LOCATION_ENABLED` flag should follow this pattern: read in server components / route handlers only, hide UI by gating route-segment renders or returning `notFound()` from page components.

---

## 14. Anomalies / risks

### 14.1 The `users.business_id` drop is more invasive than spec acknowledges

Spec text says drop in 035; orchestrator overrides to drop in 034. But:
- `users.business_id` is the join key for `requireOwnerAccess` (`src/lib/auth/require-owner-access.ts:48`). That entire helper must be rewritten in the same PR that drops the column.
- The middleware (`src/middleware.ts:50–57`) reads `business_id` from the cookie-bound Supabase client and uses it to gate `/api/dashboard` and `/api/settings` (lines 86–104). That gate currently rejects when `!self.business_id` — must be replaced by `!self.account_id`.
- The `users_self_select` RLS policy (006) is the only thing letting that anon-cookie read succeed; it doesn't reference `business_id`, so the policy itself is fine — but every consumer of the SELECT must be updated.
- `idx_users_owner_auth_by_business` (migration 025) becomes invalid the instant `business_id` is dropped. The cleanup poller (`CleanupAbandonedSignupsPoller`) currently relies on the JOIN this index covers. Will need a replacement `idx_users_owner_auth_by_account`.
- Self-serve signup (`finish-signup`, `verify-otp`) and admin-onboarding both write `users.business_id` directly today (`create-business.ts:225, 339`). Both must be changed to write `account_id` only.

### 14.2 Constraint name in the spec is wrong

Spec §3.4 says `DROP CONSTRAINT IF EXISTS channel_enrollments_business_channel_active_key` — but that name is a UNIQUE INDEX, not a constraint. The correct DDL is `DROP INDEX IF EXISTS channel_enrollments_business_channel_active_key`. (And the legacy `channel_enrollments_business_id_channel_key` constraint was already dropped in migration 022, so the spec's `DROP CONSTRAINT IF EXISTS` for that name is a no-op — safe but misleading.)

### 14.3 `tier` enum is `'founding' | 'standard' | 'premium'` today

Spec adds `'basic'`. Every literal-typed function signature and Zod schema currently using the 3-tier union must be expanded:
- `src/lib/payments/payment-link.ts:1` — `Record<'founding' | 'standard' | 'premium', string>`
- `worker/ingress/stripe.ts:282` — `Record<string, 'founding' | 'standard' | 'premium'>`
- `src/lib/onboarding/create-business.ts:53` — `subscriptionTier: 'founding' | 'standard'`
- Zod plan schemas in `src/lib/shared/schemas.ts`

Also: spec says **default tier is `'standard'`** but admin path requires explicit choice. Self-serve hardcodes `'standard'`. The introduction of `'basic'` (cheapest tier, $29) may surface a UI ergonomics question: does self-serve let users pick `'basic'`? Spec implies yes via the pricing table.

### 14.4 No central status enum

`'pending_payment' | 'active' | 'past_due' | 'cancelled'` is sprinkled as bare literals across 25+ files. There's no `SubscriptionStatus` const or type. Renaming will be search-and-replace.

(Note: `src/lib/shared/constants.ts` recently had a `SubscriptionStatus` type **removed** as dead code — see fallow cleanup commit `6c272c5`. So if the mission re-introduces a centralized enum, the prior file is gone.)

### 14.5 The "two-item Stripe subscription" requires server-side Checkout creation

Today the codebase **never creates a Stripe Subscription server-side** — Payment Links handle that. Migrating to two items (`tier_base` + `location_overage`) means either:
- Re-configure Payment Links with two prices each (and store quantity in metadata at click time — Stripe Payment Links don't support arbitrary line-item quantities), OR
- Replace Payment Links with server-built Checkout Sessions (`stripe.checkout.sessions.create({ line_items: [...] })`). This is a real architectural change with new env vars (`STRIPE_PRICE_TIER_BASE_*`, `STRIPE_PRICE_OVERAGE_*`) and a new client-side redirect surface.

The spec does not discuss this trade-off explicitly — it assumes two-item subscriptions are achievable. Resolve before implementation.

### 14.6 SMS STOP fan-out is already account-wide

The current Twilio inbound handler (`worker/ingress/twilio/twilio.ts:140–152`) flips **every** `channel_enrollments` row matching `(handle, channel='sms', archived_at IS NULL)` — it's already cross-business by handle. Spec §6.3's "STOP unsubscribes ALL enrollments where handle = phone for that account" is a NARROWING (account scope) of today's broader behavior (sender scope). Make sure the fan-out scope reduction doesn't accidentally break TCPA compliance — Twilio expects one phone to opt out the sender, not the account.

### 14.7 Spec mentions `SETTINGS` redesign but `SettingsTabs` only has 2 tabs

Adding 3 new tabs (Account, Locations, Voice) to `SettingsTabs` (`src/components/dashboard/SettingsTabs.tsx`) means a full redesign of that component plus 3 new route segments under `src/app/(authenticated)/settings/`. The component is hand-rolled (not a primitive lib), so this is straightforward but cosmetic-touch heavy.

### 14.8 `useDashboardData()` is called from at least two pages

`/dashboard` and `/dashboard/connect` both call `useDashboardData()`. If the hook signature changes to `useDashboardData(scope)`, both call sites need updating, plus the (currently inferred) shape of `DashboardData` (in `src/lib/dashboard/types.ts`) which discriminates on `subscriptionStatus`. Adding a third "all locations" variant means a new union arm.

### 14.9 Approve page already does the dual-query pattern the spec needs

`src/app/(public)/approve/[token]/page.tsx` already SELECTs `business_id` from `approval_links` and then a second SELECT for `businesses.name`. Adding `display_label` to that second SELECT is a one-line change. **This is one of the cheapest spec items.**

### 14.10 No `accounts` precedent in the codebase

A grep for `accounts` (table/word) returns only Stripe-customer references. There is **no** stub, type, or column that anticipates the multi-location world today. Greenfield in spirit.

### 14.11 Test config does not handle the Windows EPERM issue

The project memory notes vitest had EPERM worker-spawn issues on Windows. The `vitest.config.ts` does NOT set `pool: 'forks'` or any worker-pool ergonomics. If the multi-location work expands the test count significantly (the spec promises unit + integration + property + e2e + migration tests), Windows test runs may need the pool config tightened up first.

### 14.12 Branded ID adoption requires touching every API route handler

The mission's `AccountId` / `LocationId` brand types (spec §10.1) are aspirational against today's "every ID is `string`" reality. If introduced, **every API route handler** that deserializes `params.token`, `params.id`, `body.business_id`, etc. must explicitly cast to the branded type at the boundary. This is a large surface — ~60 route.ts files. Either commit to it everywhere, or skip the brand and document that decision.

---

## Surface inventory summary (for validation contract)

For the orchestrator's validation contract:

- **30** owner-facing pages (counted across `(authenticated)`, `(public)`, `admin`, `onboarding`).
- **~60** API route handlers under `src/app/api/`.
- **15** BullMQ workers under `worker/jobs/`.
- **6** background pollers + **4** schedulers under `worker/background/`.
- **9** workers calling `checkSubscription`.
- **~25** files reading `subscription_status` literals directly.
- **1** RLS policy in production code (`users_self_select`).
- **4** Stripe webhook event handlers.
- **3** notification channel feature flags (`CHANNELS_*_ENABLED`) + `MOCK_EXTERNAL_APIS`.

These numbers are conservative — they reflect grep-confirmed surfaces, not transitive callers.
