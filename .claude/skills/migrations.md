---
name: migrations
description: Full Supabase migration inventory (001–052) for the RepWorth project, plus known residual risks tied to schema decisions. Read this before writing any migration, querying migration state, debugging schema issues, or planning work that touches the database.
---

# RepWorth — Migration Inventory

Base schema: `supabase/migrations/001_initial_schema.sql`
Current head: **052** — next migration is **053**
All tables use UUIDv7 (time-ordered primary keys).

> **Worker file paths (as of 2026-05-05):** Class names below are
> stable; file paths changed during the worker reorg, and per PR #18
> the BullMQ `'failed'` exhaustion handlers (the code that writes the
> final `review_exceptions` rows after retries are exhausted) now live
> in dedicated `failed-hook.ts` modules colocated with their workers.
> For any worker mentioned here, look at how it's imported in
> `worker/index.ts` or read `docs/directory.md`. Quick map:
> - `NotificationWorker` → `worker/jobs/notification/NotificationWorker.ts`
> - `ResponsePublisherWorker` → `worker/jobs/publisher/ResponsePublisherWorker.ts`
>   - Writes to `review_exceptions` on retry exhaustion: `worker/jobs/publisher/failed-hook.ts`
> - `ZernioBackfillWorker` → `worker/jobs/zernio/ZernioBackfillWorker.ts`
> - `ZernioReviewIngestWorker` → `worker/jobs/zernio/ZernioReviewIngestWorker.ts`
>   - Writes to `review_exceptions` on retry exhaustion: `worker/jobs/zernio/ingest-failed-hook.ts`

## Migration Log

- **001–019** — Core schema through Sprint 6. Covers `users`, `businesses`,
  `reviews`, `responses`, `approval_links`, `approval_audit_log`,
  `review_exceptions`, `job_outbox`, `inbound_events`,
  `notification_deliveries`, `prospect_demos`, `api_costs`,
  `weekly_summaries`, `monthly_impact_emails`, `ranking_snapshots`,
  `onboarding_drip_log`, `satisfaction_responses`.

- **020** — JSONB scalar-string repair.
  `payload = (payload#>>'{}')::jsonb WHERE jsonb_typeof(payload)='string'`
  applied across all JSONB columns. Background: Postgres.js v3 was
  double-encoding JSONB inserts that used `${JSON.stringify(x)}::jsonb`.

- **021** — `channel_enrollments` table + email enrollment backfill for
  existing businesses. Establishes the `NotificationChannel` interface
  foundation. Removes `notification_preference`.

- **022** — SMS Phase 1.
  - Drops `notification_preference`
  - Soft-delete on `channel_enrollments` (adds `archived_at`)
  - Partial unique index for active enrollments
  - `sms_sender_opt_outs` + `sms_sender_opt_out_events` (TCPA audit trail)

- **023** — Non-terminal response uniqueness.
  Partial unique index: at most one non-terminal response per review at a time.
  Terminal statuses: `superseded`, `posted`, `failed`.

- **024** — `notification_deliveries` dedup unique index.
  Prevents send-before-record race (notification sent, worker crashes before
  recording delivery row, retry resends).

- **025** — Owner self-serve signup.
  - Two partial indexes for signup deduplication
  - Email lowercase backfill
  - `onboarded_by` backfill
  Both backfills are collision-guarded.

- **026** — Zernio publishing integration.
  - Widens `responses.status` → TEXT (was ENUM)
  - Recreates non-terminal-uniqueness index including `awaiting_owner_connect`
  - Adds `zernio_connections` table
  - Adds `zernio_finalize_incidents` table
  - Two dedup indexes on `notification_deliveries`
  - In-flight `publish_response` outbox uniqueness index

- **027** — Channels Phase 4 (owner channel dashboard).
  Partial unique index `channel_enrollments_one_mobile_per_biz`: at most one
  pending/verified mobile channel (sms/telegram/whatsapp) per business.
  Predicate excludes `disabled`/`unsubscribed`/`archived` rows so enrollment
  history is preserved across channel switches.

- **028** — Zernio first-connect backfill.
  `zernio_backfill_runs` table: per-business summary of gap/historical
  processed + skipped counts. Snapshots tier and `subscription_activated_at`.
  Partial unique index `zernio_backfill_runs_one_per_business`.

- **029** — Decommission manual-post workflow.
  - Bulk-fails orphan `awaiting_manual_post` rows with
    `posting_error='manual_post_deprecated_2026_04'`
  - Rebuilds `responses_one_non_terminal_per_review` without the dead status
  - Drops stale `notification_deliveries_response_template_uniq` index from 024
  **Must be applied AFTER migration 028.**

- **030** — Zernio ingest outbox dedup.
  Partial unique index `job_outbox_ingest_zernio_review_inflight` on
  `(aggregate_id, (payload->>'zernio_review_id'))` for non-terminal rows of
  `topic='ingest_zernio_review'`. Enables webhook fan-out's
  `INSERT ... ON CONFLICT DO NOTHING` to dedup against in-flight rows when
  Zernio retries a delivery mid-processing.

- **031** — Past Replies (read-only) + external-reply ingestion. Three
  schema additions:
  1. `reviews.external_reply_ingested_at TIMESTAMPTZ NULL` — marks reviews
     ingested via the external-reply branches in
     `reconcileExternallyAnsweredReview` (pre-RepWorth replies discovered
     during webhook / backfill). Drives the dashboard's
     "Imported from Google · YYYY-MM-DD" provenance label.
  2. `zernio_backfill_runs.external_reply_ingested_count INTEGER NOT NULL DEFAULT 0`
     — counter bumped only when `insertImportedResponse` actually INSERTs
     (not on `ON CONFLICT DO NOTHING`). Per-business audit metric.
  3. `responses_one_posted_per_review` — partial unique index on
     `responses (review_id) WHERE status = 'posted'`. Enforces the invariant
     that at most one `'posted'` row exists per review at any time. Defense
     against publisher bugs that could double-post.
  4. `idx_reviews_business_review_date` — `(business_id, review_date DESC)`.
     Supports the Past Replies page query.

- **032** — Pre-pay onboarding demo table (PR #2,
  `feat/pre-paywall-demo-pr2`). Creates `onboarding_demos` for the SerpAPI-
  driven demo shown between signup and paywall. Schema:
  `id UUID PRIMARY KEY` (UUIDv7 app-side), `user_id`/`business_id` FK with
  `ON DELETE CASCADE`, snapshot fields (`reviews_snapshot`,
  `generated_responses` JSONB), state machine
  (`generation_status IN ('queued','running','completed','failed','archived')`),
  partial unique index `onboarding_demos_one_completed_per_user` on
  `(user_id) WHERE generation_status='completed'` (one completed demo per
  user; failed/queued/archived rows allowed for retry/regenerate).
  CHECK constraint enforces `source IS NOT NULL` whenever
  `generation_status='completed'`. Indexes on user/business lookup +
  in-flight status filter + a partial cleanup index
  `onboarding_demos_completed_for_cleanup` on `(completed_at) WHERE
  generation_status='completed'` to support the daily 30-day stale
  cleanup pass in `CleanupAbandonedSignupsPoller` (without it, the
  poller does a full table scan as completed-demo volume grows).
  Sister table to `prospect_demos` (admin-side); shared lifecycle
  helpers in `src/lib/demos/lifecycle.ts` (PR #1).

  **Race-loser invariant:** the partial unique index combined with the
  23505 recovery in `lifecycle.completeDemo` means concurrent regenerates
  for the same user produce at most one `completed` row. The losing
  worker archives THIS row in a single tx (status='archived', outbox
  closed). Any reads ordered by `created_at DESC LIMIT 1` against this
  table MUST filter `generation_status <> 'archived'` — the loser's
  archive can be newer than the winner's complete (`/onboarding/demo/page.tsx`,
  `/api/onboarding/demo/status/route.ts` already do this).

  **Apply non-transactionally** (file mixes transactional DDL with
  `CREATE INDEX CONCURRENTLY` — uncheck "single transaction" in the
  Supabase SQL editor). Pre-flight check is REQUIRED:

  ```sql
  SELECT review_id, count(*) FROM responses
    WHERE status = 'posted'
    GROUP BY review_id
    HAVING count(*) > 1;
  -- expect: 0 rows
  ```

  Any pre-existing duplicate `posted` rows would abort the CONCURRENTLY
  index build mid-way (leaving an INVALID index that requires `DROP INDEX`
  + retry). See `docs/runbooks/zernio-launch-runbook.md` §10 for the full
  Phase A / B1 / B2 rollout playbook.

  Migration ships on `feat/past-replies-view`. Same migration file appears
  on parked tag `wip/edit-existing-replies-zernio-v1` (introduced there
  first). Apply only once.

- **033** — `owner_leads` table for the public contact + demo-request
  endpoints. Stores `name`, `email`, `email_normalized`, `business_name`,
  optional `google_maps_url`, `intent` (CHECK-constrained set), `source`,
  `status` (`new` default), `metadata JSONB`. Independent of all
  authenticated paths — pure marketing capture.

- **034** — Multi-location schema (`feature/multi-location`).
  - Creates `accounts` table — the billing parent / org. Owns
    `subscription_tier`, `subscription_status`, `stripe_customer_id`,
    `stripe_subscription_id`, `subscription_activated_at`,
    `locations_included`, `locations_paid`,
    `locations_overage_price_cents`, `flags JSONB`.
  - `businesses` gains `account_id NOT NULL FK`, `display_label`,
    `is_primary BOOL`, `archived_at`. Partial unique index
    `businesses_account_primary_uniq` on `(account_id) WHERE is_primary
    AND archived_at IS NULL` — exactly one primary per active account.
  - `users.business_id` is **dropped outright** (no dual-read window).
    Auth now reads `users.account_id` and resolves the primary location
    via JOIN. Anywhere reading `users.business_id` will not compile.
  - Denormalized `account_id` added to `api_costs`,
    `notification_deliveries`, `approval_audit_log`,
    `channel_enrollments` (with new `location_id` for per-location
    overrides).
  - New `account_audit_log` table for lifecycle events
    (`location_created`, `location_archived`, `primary_promoted`,
    `tier_changed`, `csv_bulk_import`, …).
  - `channel_enrollments` uniqueness moves from
    `(business_id, channel)` to per-scope `(account_id, channel,
    COALESCE(location_id, '00000000-…'))`. Same shape for
    `one_mobile_per_scope`. Old `_one_mobile_per_biz` dropped.

- **035** — Row-Level Security policies on 22 tables. Adds
  `owner_account_id()` helper that resolves the calling auth user's
  `account_id` via `users.auth_id = auth.uid()::text`. Every owner-scoped
  table gets a policy enforcing `account_id = owner_account_id()`. RLS
  is the second layer of defense after the app-level scope check —
  service-role queries bypass RLS, so app-level checks remain mandatory.

- **036** — Defers the circular `accounts ↔ users` FK references so the
  combined backfill in 034 can commit. `DEFERRABLE INITIALLY DEFERRED`
  on `accounts.owner_user_id` and `users.account_id`.

- **037** — Adds `accounts.cancelled_at TIMESTAMPTZ`. Stripe
  `customer.subscription.deleted` webhook stamps this. The dashboard
  grace-period computation now uses `cancelled_at + 30 days` (with
  `subscription_activated_at` fallback for legacy rows that lack
  `cancelled_at`). Replaces a long-standing bug where grace was computed
  off `subscription_activated_at` directly — which gave months-long
  grace to old subscriptions.

- **038** — Partial unique index on `accounts(owner_user_id) WHERE
  owner_user_id IS NOT NULL`. Prevents two `accounts` rows sharing the
  same owner.

- **039** — Corrective: drops `NOT NULL` on `users.account_id`,
  `api_costs.account_id`, `notification_deliveries.account_id`. Reasons:
  admin / sales_partner users have no account; platform-level cost rows
  (e.g. demo lane) have no account; some legacy notification deliveries
  predate the column. Adds partial index
  `idx_api_costs_account_partial` on `(account_id) WHERE account_id IS
  NOT NULL`.

- **040** — RLS tightening on `businesses` and `channel_enrollments`.
  - **`businesses`**: table-level `REVOKE UPDATE`, then explicit `GRANT
    UPDATE` only on safe columns (tone, products_services, staff_names,
    highlight_facts, avoid_facts, sample_responses, owner_name,
    owner_email, last_sync_at, display_label, name, archive_reason).
    Subscription / Stripe / `is_primary` / `archived_at` columns become
    write-protected from direct owner UPDATEs — only service-role +
    application code go through the dedicated transactions.
  - **`channel_enrollments`**: `REVOKE INSERT` entirely (only
    application code inserts via service-role); `REVOKE UPDATE` table-
    level then `GRANT UPDATE` only on `(unsubscribed_at,
    unsubscribed_reason, updated_at)`.
  - **Important learning:** column-level REVOKEs alone do nothing if
    the table-level grant still exists — Postgres treats the broader
    grant as authoritative. You MUST `REVOKE UPDATE ON TABLE` first,
    then re-`GRANT UPDATE (col1, col2, …)`.

- **041** — Follow-up to 040: adds REVOKEs on columns missed during
  the first sweep — `subscription_activated_at`, `place_id_verified`,
  `google_maps_url` on `businesses`, and `archived_at`,
  `archive_reason` on `channel_enrollments`. Same table-level-revoke-
  then-explicit-grant pattern as 040.

- **042** — Zernio backfill run reasons (reactivation catch-up runs).
  Relaxes the one-row-per-business model so reactivated locations can
  record later catch-up runs without overwriting the first-connect run.
  - Adds `zernio_backfill_runs.run_reason TEXT NOT NULL DEFAULT 'initial'`
    (`'initial'` = first-connect one-shot; `'reactivation'` = later
    archive/restore catch-up) and `correlation_id UUID` (idempotency key
    for non-initial runs, usually copied from the outbox payload).
  - Drops `zernio_backfill_runs_one_per_business` (from 028) and replaces
    it with `zernio_backfill_runs_one_initial_per_business` on
    `(business_id) WHERE run_reason = 'initial'` — still exactly one
    initial run per business, but reactivation runs are now unconstrained.
  - `zernio_backfill_runs_correlation_id_uniq` on `(correlation_id) WHERE
    correlation_id IS NOT NULL` — dedup key for reactivation runs.
  - `zernio_backfill_runs_business_reason_started_idx` on
    `(business_id, run_reason, started_at DESC)` for latest-run lookups.

- **043** — Step 1 SaaS-readiness keystones (`codex/step-1-keystones`, PR #81).
  Additive + idempotent (`ADD COLUMN IF NOT EXISTS` only); no drops, no data
  mutation, no authorization-behavior change.
  - Adds `accounts.past_due_at TIMESTAMPTZ NULL` — the past-due **countdown
    source** for Spec 05 / 29 Gap 5. Set when an account first flips
    `active → past_due` (`invoice.payment_failed`), preserved across repeated
    failures while still `past_due`, cleared on recovery (`invoice.paid`) AND
    on cancellation (`customer.subscription.deleted`). Represents the *current*
    past-due interval, not billing history.
  - Adds five generic metadata columns to `account_audit_log` for the Spec 04
    audit helper: `entity_type`, `entity_id` (both TEXT so internal UUIDs and
    provider IDs coexist), `ip`, `user_agent`, `request_id` — all nullable.
  - **No new indexes** (existing `idx_account_audit` / `idx_account_audit_event`
    cover current queries) and **deliberately NO `account_memberships`** — the
    Step 1 keystone is the audit foundation only; the membership/role schema
    moves to a later Spec 04 auth-hardening slice. See
    `docs/superpowers/specs/2026-05-25-step-1-keystones-design.md`.

- **044** — Wave 1 approval audit snapshot (`codex/wave-1-foundation-launch-risk`,
  PR #85). Additive (`ADD COLUMN IF NOT EXISTS`), no drops/data mutation, no
  index.
  - Adds `approval_audit_log.response_text_at_approval TEXT NULL` — an
    **immutable snapshot of the exact text the owner approved**, written in the
    SAME transaction as the response-status mutation + outbox enqueue, across
    all content-publishing paths (token approve/edit, callback, owner session,
    dashboard publish/retry/restore). Plain `TEXT` (not JSONB). Dispute-evidence
    column for Spec 29 Gap 1; later mutation of `responses.approved_text` does
    NOT change it. No HTML snapshot column (text is the canonical artifact).

- **045** — Wave 1 RLS coverage for `onboarding_demos`
  (`codex/wave-1-foundation-launch-risk`, PR #85). Enables RLS on the
  tenant-scoped `onboarding_demos` table (added in 032 without RLS) and adds an
  `onboarding_demos_owner_select` policy keyed to `owner_account_id()` so
  authenticated reads are constrained to the owning account's locations. Mutations
  still go through owner-authenticated routes / service-role workers. Brought the
  table into `scripts/ci/tenant-tables.ts` so the RLS audit + tenant-scope audit
  now cover it.

- **046–049** — Wave 2 Activation (`codex-wave-2-activation`, PR #87). All four
  are additive / idempotent (`CREATE TABLE IF NOT EXISTS`, `ENABLE RLS`, a guarded
  backfill `UPDATE`); no drops, no type changes, no table rewrites, safe to run in
  order against prod. Design: `docs/superpowers/specs/2026-05-25-wave-2-activation-design.md`.
  - **046** — `analytics_events`: the first-party analytics dispatch queue. Vercel/
    client code records first-party event rows here; the Railway
    `AnalyticsDispatchPoller` ships them to PostHog (preserving "Vercel = UI only").
    `event_key TEXT NOT NULL UNIQUE` is the idempotency key (`ON CONFLICT DO
    NOTHING`); `event_name` is CHECK-constrained to the Wave 2 taxonomy (keep in
    sync with `ANALYTICS_EVENT_NAMES` in `src/lib/analytics/events.ts` — a
    drift-guard test enforces it); `status`/`attempts`/`available_at`/`locked_at`
    drive the claim + retry loop (partial index `WHERE status = 'pending'`). FKs to
    accounts/users/businesses are `ON DELETE SET NULL` (events survive entity
    deletion). **RLS added in 049, not here** (see below).
  - **047** — backfill `accounts.past_due_at = updated_at WHERE subscription_status
    = 'past_due' AND past_due_at IS NULL`. A one-time data migration so accounts
    already `past_due` before 043 (which added the column nullable) keep a grace
    window instead of flipping straight to read-only once the Wave 2 recovery
    helper ships. Idempotent (the `IS NULL` guard), narrow row lock only. Caveat:
    `updated_at` is a proxy — a legacy past-due account may get a one-time,
    ≤7-day-generous (never shorter, never unbounded) grace window.
  - **048** — `impersonation_sessions`: admin-owned, time-boxed view-as session
    state (actor/impersonated user, account, ticket_id, reason, expires_at,
    ended_at). RLS enabled with **no policy** (deny-all; server reaches it only via
    the RLS-bypassing `postgres` role — same lockdown as `account_audit_log`).
    `idx_impersonation_active_actor` is a **partial UNIQUE index on
    `(actor_user_id) WHERE ended_at IS NULL`** — the hard backstop for "one active
    session per actor." NB: nothing sets `ended_at` on TTL expiry, so
    `startImpersonationSession` reaps expired-but-unended rows
    (`SET ended_at = expires_at WHERE expires_at <= NOW()`) before the active-session
    pre-check; without that reap a lapsed session would permanently block new starts.
  - **049** — enable RLS on `analytics_events` (deny-all, no policy). Closes the gap
    where 046 created the table without RLS — the only table-creating migration that
    had skipped it, leaving the table anon-readable via PostREST. Server access is
    unaffected (Postgres.js `postgres` role bypasses RLS).

- **050** — `api_costs` AI-safety metadata (Wave 3 PR 2). Adds `system_prompt_hash`,
  `prompt_version`, `latency_ms`, `moderation_score`, `moderation_categories`,
  `flagged` (NOT NULL DEFAULT FALSE), `flag_reason`, `output_excerpt` to `api_costs`.
  All additive/idempotent (`ADD COLUMN IF NOT EXISTS`). PR 2 populates
  hash/version/latency + `account_id`; the moderation columns are populated by PR 3.
  No RLS/index change (`api_costs` already has both).
- **051** — `flagged_responses` (Wave 3 PR 3a). Admin-only table (deny-all RLS,
  server reads via the postgres role) holding high-confidence unsafe drafts out of
  the owner approval-notification path until admin disposition. FKs to
  `responses`/`accounts`/`businesses`/`reviews`/`api_costs` (cascade on tenant
  parents); CHECK constraints on `source`/`severity`/`status`; partial unique index
  on `(response_id) WHERE status='open'`; index on `(status, created_at DESC)`.
  PR 3b adds the admin queue + disposition.
- **052** — `reviews` sentiment (Wave 3 PR 5a). Adds nullable `sentiment_score`
  (NUMERIC), `sentiment_label` (TEXT), `sentiment_classified_at` (TIMESTAMPTZ),
  `sentiment_source` (TEXT) to `reviews`; a label-domain CHECK
  (`reviews_sentiment_label_check`, guarded idempotently by a `pg_constraint`
  catalog lookup **scoped to the reviews relation** — `conname` is unique only
  per-table, not globally); and a one-time, bounded, star-based deterministic
  backfill (`WHERE sentiment_label IS NULL`, so re-running is a no-op). Additive.
  No RLS change (`reviews` already has it; new columns inherit the SELECT policy).
  Star→label/score mapping mirrors `src/lib/reviews/sentiment.ts` so backfilled
  and newly-ingested rows agree. LLM-ready via `sentiment_source`.
  PR 6 (finance) adds **no migration** — its margin signals aggregate `api_costs`
  on read.

## Key Tables Reference

| Table | Purpose |
|---|---|
| `users` | App users with `auth_id` → Supabase Auth mapping |
| `businesses` | Owner businesses: `subscription_status`, `subscription_tier`, `place_id_verified`, `onboarded_by`, `stripe_customer_id`, `last_sync_at` |
| `google_connections` | Future GBP OAuth tokens (populated in Phase 5) |
| `reviews` | Ingested reviews from all sources |
| `responses` | AI-drafted responses — see status values below |
| `approval_links` | SHA-256 hashed tokens only — raw tokens never stored |
| `approval_audit_log` | Every approval action logged. `response_text_at_approval` (migration 044) is an immutable snapshot of the exact owner-approved text, written in-tx via `insertAuditLog`/`insertAuditLogSession` across all publish paths — dispute evidence (Spec 29 Gap 1) |
| `review_exceptions` | Dedup collisions, pagination cap exhaustions, not-found signals |
| `job_outbox` | Transactional outbox — all async work dispatched through here |
| `inbound_events` | Webhook dedup — always write here first before business logic |
| `notification_deliveries` | Per-channel delivery records |
| `channel_enrollments` | Multi-channel owner enrollments (email/sms/telegram/whatsapp) |
| `sms_sender_opt_outs` + `sms_sender_opt_out_events` | TCPA audit trail |
| `prospect_demos` | Sales demo generation state |
| `api_costs` + `api_costs_daily_rollups` | LLM cost audit trail |
| `weekly_summaries` + `monthly_impact_emails` | Owner retention emails |
| `ranking_snapshots` | Ranking tracking over time |
| `onboarding_drip_log` | Day 1/7/30 drip state |
| `satisfaction_responses` | HMAC feedback link responses |
| `zernio_connections` | Active Zernio OAuth connections per business |
| `zernio_finalize_incidents` | Zernio publish finalization errors |
| `zernio_backfill_runs` | First-connect backfill state per business |
| `accounts` | Billing parent / org. Owns subscription state, Stripe IDs, location quota. One per owner. |
| `account_audit_log` | Append-only account events: location create / archive / promote / tier-change / CSV import / `subscription_status_changed`. Generic metadata cols (`entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`) added in 043. Write via `src/lib/audit/log.ts` (`writeAccountAuditLog`), never raw INSERT. |
| `owner_leads` | Marketing capture from contact + demo-request endpoints (independent of authenticated paths). |

## Response Status Values

`'pending_approval'` | `'approved'` | `'edited'` | `'superseded'` |
`'awaiting_owner_connect'` | `'posted'` | `'failed'`

- **`superseded`** — terminal. Owner requested regeneration; this draft was
  replaced. At most one non-terminal response per review at any time.
- **`awaiting_owner_connect`** — non-terminal. Approved but cannot post because
  the business has no active Zernio connection. `DrainOwnerConnectWorker` flips
  these back to `approved` on successful (re)connect.

## Business Subscription Lifecycle

`'pending_payment'` (default) → `'active'` → `'past_due'` | `'cancelled'`

Stripe `checkout.session.completed` transitions to `active`.
ReconciliationPoller only polls `active` businesses.

**`pending_payment` trial scope:** ONE initial sync fires. Reviews ingested,
responses generated (visible in admin). But `NotificationWorker` and
`ResponsePublisherWorker` MUST skip — no emails or posting until payment
confirms.

## Critical Schema Gotchas

- **`ON CONFLICT` must match partial-index predicate BYTE-FOR-BYTE.**
  Example: `idx_review_exceptions_collision_dedup` predicate uses
  `(payload->>'provider_review_id')` — using bare `provider_review_id` as the
  conflict key returns "no matching unique constraint" at runtime even though
  the values are semantically equivalent.

- **Expression indexes must be IMMUTABLE.**
  `timestamptz::date` is `STABLE` (depends on session timezone) and Postgres
  rejects it in partial-index predicates (ERROR 42P17). Fix: wrap in
  `AT TIME ZONE 'UTC'` first — `((created_at AT TIME ZONE 'UTC')::date)` is
  `IMMUTABLE`. The `ON CONFLICT` clause must use this exact same expression.

- **Postgres rejects STABLE expressions in index predicates.**
  Always verify with `\d indexname` that the index was created as expected.

## Known Residual Risks

### 1. Approval email crash-after-send race
`NotificationWorker` creates the approval link → sends via Resend → records
delivery row. If it crashes between Resend ack and `recordNotificationDelivery`,
the retry revokes the "orphaned" token, creates a fresh one, and sends a second
email. Owner gets two emails; first token shows "expired", second works.

**Mitigation:** Covered by `NotificationFailoverPoller` for the symmetric
lost-email case. **Deferred fix:** insert provisional delivery row BEFORE
Resend call, update `external_message_id` after success.

### 2. `past_due` grace period uses mutable `businesses.updated_at`
`checkSubscription` computes the 7-day grace window from `businessUpdatedAt`,
but any unrelated write to the businesses row resets `updated_at` and extends
grace indefinitely.

**Planned fix (next billing sprint):** add `subscription_status_changed_at`
column, written only in the Stripe webhook on real status transitions. Update
all `checkSubscription` callers to use it instead of `updated_at`.

> **Update (043):** `accounts.past_due_at` now exists — set only on the real
> `active → past_due` transition and cleared on recovery/cancellation, so it is
> exactly the immutable anchor this risk wants. It was added for the countdown
> UX (Spec 05) and is NOT yet wired into `checkSubscription`'s grace math —
> doing so (or adding the broader `subscription_status_changed_at`) closes this
> risk. Until then `checkSubscription` still reads `updated_at`.

### 3. Zernio backfill gap-window uses `subscription_activated_at`, not `connected_at`
`ZernioBackfillWorker` classifies "gap" as `createTime ≥ subscription_activated_at`.
A customer activating Stripe in January but connecting Zernio in July gets all
6 months classified as "gap" (capped at 25), leaving the rest as "historical"
(skipped for non-premium). Ops will get "where are my reviews?" tickets.

**Workaround:** Explain in onboarding that gap = "since you started paying."
**Deferred fix:** use `zernio_connections.connected_at` as gap boundary.
Requires snapshotting `connected_at` into `zernio_backfill_runs`.

### 4. No `accounts.base_price_cents` — base price is not grandfathered
[2026-05-22, PR #51/#52] `accounts` snapshots `locations_included` and
`locations_overage_price_cents` at signup / select-plan / tier change, and
`currentBillingSnapshot` reads both (point-in-time, grandfathered). But there is
**no stored column for the base monthly price** — `basePriceCents` still comes
from live `TIER_CONFIG[tier].baseCents`. So if a tier's base price ever changes,
existing accounts' displayed/preview base will drift from their actual Stripe
charge (Stripe keeps the original base Price ID on existing subscriptions).
Most consequential for the `founders` tier ("Rate locked for life").

This PR added **no migration** — it reused existing columns. The deferred fix is
a future migration: add `accounts.base_price_cents`, snapshot it everywhere the
other quota columns are written (`create-business.ts`, `select-plan/route.ts`,
`subscription-updated.ts`), and read it in `currentBillingSnapshot`.
See the TODO in `src/lib/accounts/quota.ts` and `docs/runbooks/multi-location.md` §6.

### 5. `channel_enrollments` org-default scoping — `business_id` vs 034's `(account_id, location_id)` indexes (MOSTLY RESOLVED)
[2026-05-22] Migration 034 made `channel_enrollments` account-scoped: `account_id`
+ nullable `location_id` (NULL = org-level default), with uniqueness on
`channel_enrollments_account_channel_scope_uniq` and
`channel_enrollments_one_mobile_per_scope`, both keyed
`(account_id, channel, COALESCE(location_id, sentinel))`. The owner self-service
runtime paths originally still keyed org-default rows by `business_id`, causing a
multi-location desync (display connected, runtime 404 on disconnect, 500 on
re-connect).

**RESOLVED (PR #54, `fix/owner-channel-account-scope` — no migration, query-only):**
the shared `/api/dashboard/channels` status GET, the Telegram + WhatsApp enrollment
helpers (start SELECT + cancel/disable, signatures `(sql, accountId)`), the owner
Telegram + WhatsApp routes, AND the admin Telegram + WhatsApp routes now key
org-default rows by `(account_id, channel, location_id IS NULL)`; the
`mobile_enroll` advisory lock is account-scoped for those channels. `business_id`
stays the legacy FK on INSERT only.

**STILL OPEN (deferred, tracked in `docs/known-issues.md`):**
- Admin **SMS** still locks per business (`withMobileEnrollmentLock`) and prechecks
  cross-channel by `business_id` — can waste a Twilio Verify SMS + late-409 and
  does not serialize vs TG/WA start. (`one_mobile_per_scope` still prevents dupes.)
- **Dispatcher** failure-handling writes (`worker/jobs/notification/dispatch.ts`)
  flip enrollment status by `business_id = ctx.businessId` — can miss the org-default
  row on multi-location.
- Admin per-business **status read** (`admin/businesses/[id]/channels`) lists by
  `business_id` — display-only mismatch.

Design: `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`.
