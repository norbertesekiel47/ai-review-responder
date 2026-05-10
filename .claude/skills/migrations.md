---
name: migrations
description: Full Supabase migration inventory (001–032) for the RepWorth project, plus known residual risks tied to schema decisions. Read this before writing any migration, querying migration state, debugging schema issues, or planning work that touches the database.
---

# RepWorth — Migration Inventory

Base schema: `supabase/migrations/001_initial_schema.sql`
Current head: **041** — next migration is **042**
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

## Key Tables Reference

| Table | Purpose |
|---|---|
| `users` | App users with `auth_id` → Supabase Auth mapping |
| `businesses` | Owner businesses: `subscription_status`, `subscription_tier`, `place_id_verified`, `onboarded_by`, `stripe_customer_id`, `last_sync_at` |
| `google_connections` | Future GBP OAuth tokens (populated in Phase 5) |
| `reviews` | Ingested reviews from all sources |
| `responses` | AI-drafted responses — see status values below |
| `approval_links` | SHA-256 hashed tokens only — raw tokens never stored |
| `approval_audit_log` | Every approval action logged |
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
| `account_audit_log` | Lifecycle events on accounts: location create / archive / promote / tier-change / CSV import. |
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

### 3. Zernio backfill gap-window uses `subscription_activated_at`, not `connected_at`
`ZernioBackfillWorker` classifies "gap" as `createTime ≥ subscription_activated_at`.
A customer activating Stripe in January but connecting Zernio in July gets all
6 months classified as "gap" (capped at 25), leaving the rest as "historical"
(skipped for non-premium). Ops will get "where are my reviews?" tickets.

**Workaround:** Explain in onboarding that gap = "since you started paying."
**Deferred fix:** use `zernio_connections.connected_at` as gap boundary.
Requires snapshotting `connected_at` into `zernio_backfill_runs`.
