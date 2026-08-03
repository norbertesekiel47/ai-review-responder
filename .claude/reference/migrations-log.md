# RepWorth — Migration Inventory

Base schema: `supabase/migrations/001_initial_schema.sql`
Current head: **097** — next migration is **098**
All tables use UUIDv7 (time-ordered primary keys).

> **Lab note — verifying "is migration N applied?" (2026-06-20):** the Supabase
> `list_migrations` MCP (reads `supabase_migrations.schema_migrations`) does **not**
> track RepWorth's `0xx` migrations — they're applied outside the Supabase CLI. It
> returned a single timestamped row on prod and **zero** on staging despite head
> being 068. → **Always verify against the actual schema** (introspect
> `information_schema.columns` / `pg_indexes` for the objects the migration created),
> never the migration ledger. Example: migration 031 = presence of
> `reviews.external_reply_ingested_at`, `zernio_backfill_runs.external_reply_ingested_count`,
> and the `responses_one_posted_per_review` partial index.

## Data retention policy

One authoritative statement of what gets deleted, what is kept, and why.
Enforcement is `worker/background/pollers/ArchivalPoller.ts` (daily cycle;
LIMIT-5000 batches + saturation warning) unless noted. Decided 2026-06-12
(production-readiness deep-scan §3.2/§3.6/§3.9).

| Table | Retention | Enforcement |
|---|---|---|
| `job_outbox` | `completed` > 7 days → deleted | ArchivalPoller |
| `inbound_events` | `processed` > 30 days → deleted | ArchivalPoller (index `idx_ie_archival`, migration 065) |
| `prospect_demos` | completed demos > 30 days past expiry → deleted | ArchivalPoller |
| `api_costs` | > 90 days → aggregated into `api_costs_daily_rollups`, then deleted | ArchivalPoller |
| `notification_deliveries` | > 90 days → deleted | ArchivalPoller |
| `analytics_events` | `completed` > 30 days and `failed` > 90 days (by `occurred_at`) → deleted | ArchivalPoller (served by existing `idx_analytics_events_status`) |
| `account_audit_log` | **keep forever** — deliberate | none (compliance/audit surface) |
| `approval_audit_log` | **keep forever** — deliberate | none (backs invariant #3's recorded-approval evidence chain) |
| `reviews` / `responses` | **deliberately exempt** — core tenant data | none |
| `solicitation_batches` | No time-based expiry deletion in watch-mode; hard-delete with the source upload on account purge | account-offboarding purge via `contact_csv_uploads` cascade |
| `solicitation_asks` | No time-based expiry deletion in watch-mode; authoritative decisions outlive 180-day run archival and hard-delete with their batch on account purge | `solicitation_batches` cascade |
| `solicitation_consent` | **No TTL — consent rows never expire (§7.3)**; a consent row outliving or predeceasing its contact would desynchronize the two. Hard-deleted with the contact on per-contact delete (same transaction, by handle — the ledger has no FK to `solicitation_contacts`) and on offboarding purge (`must_be_absent`) — consent fails closed; suppression fails open (DR1), which is why these rows are destroyed where #621's suppression rows are retained | contact-delete path (#625) + `businesses` `ON DELETE CASCADE`; purge verification via `TABLE_DISPOSITIONS` (`hard_delete`, `direct_business_id`) |
| `solicitation_outreach` | **Row kept; body redacted.** `rendered_subject`/`rendered_body` NULLed and `interpolation_inputs` emptied to `'{}'`, with `body_redacted_at` stamped, 90 days after the body existed — the send *fact* (status, disposition, provider id, bounce/complaint signals) is retained indefinitely for suppression, over-contact history and the daily cap, while the *content* ages out. **One window, two clocks (092):** a `sent` row ages from `sent_at`; a row that went terminal WITHOUT sending (`withheld`/`cancelled`/`failed`/`unknown`) has no `sent_at` and ages from `rendered_at`. A live row (`rendered`/`queued`/`sending`) is never redactable at any age — a bodyless live attempt can neither send nor settle. Hard-deletes with its batch on account purge | ArchivalPoller arms 9 + 10 (migrations 091/092, indexes `idx_solicitation_outreach_redaction_sweep` and `idx_solicitation_outreach_unsent_terminal_redaction_sweep`); purge via `solicitation_batches` cascade |
| `solicitation_suppressions` | **No TTL — an opt-out never expires (§2.1)**; a time limit on an opt-out is a violation with a cron job attached. Splits on **Suppression scope** at offboarding purge (D7): `scope='global'` rows are **retained** with `account_id` intact — the recipient's revocation against our one shared sending identity is not the account's data, and deleting one would let us mail a person who opted out (#535 §6 through a different door) — while `scope='account'` (`owner_manual`) rows hard-delete with the account. The only removal path for a retained row is the admin-only, audited **Correction path** (#645) | ArchivalPoller deliberately untouched; offboarding purge content stage + `TABLE_DISPOSITIONS` (`retain_compliance_limited_pii`, `compliance_handle_hash`, `allowed_limited_retention` — ONE entry for both scopes, #643 G2) |
| `solicitation_unsubscribe_tokens` | **No TTL, no expiry** (§2.2): CAN-SPAM §7704(a)(3) requires the link operate ≥30 days, and there is no expiry value better than none. **Row kept; provenance scrubbed.** The offboarding purge NULLs `account_id`/`business_id`/`ask_id` and keeps `token_hash`, `normalized_handle`, `channel` and `sent_at`, so redemption still works after the sender is gone (§5.2). `outreach_id` nulls independently via `ON DELETE SET NULL` (#643 G1) whenever its outreach row is deleted, account alive or not | ArchivalPoller deliberately untouched; offboarding purge token scrub + `TABLE_DISPOSITIONS` (`retain_compliance_limited_pii`, `compliance_handle_hash`, `allowed_limited_retention`) |

Revisit triggers:

- **Audit tables (keep-forever):** revisit if a documented compliance retention
  ceiling ever applies (e.g. a data-protection regime with a maximum retention
  period), or if either table exceeds ~10M rows.
- **`reviews`/`responses` exemption:** revisit (pruning of `status='deleted'`
  tombstones and/or partitioning) before hot KPI/dashboard queries degrade at
  scale — the deep-scan frames this as a pre-multi-location-scale item, not a
  launch item.

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
- **053** — retire the legacy `sales_partner` role (issue #50, deferred from
  #43). Defensive one-time `UPDATE users SET role='admin' WHERE
  role='sales_partner'` (prod has 0 such rows), then **adds** the first-ever role
  constraint `users_role_check` CHECK (`role IN ('owner','admin')`) — guarded
  idempotently by a `pg_constraint` catalog lookup **scoped to the users
  relation** (`conname` is unique only per-table). No enum/CHECK previously
  existed on `users.role` (bare `VARCHAR(20)`); role had been app-enforced only.
  Additive + re-runnable. Completes #43's runtime removal at the DB layer.

- **054** — `accounts.base_price_cents` founders price-lock (2026-05 launch audit,
  doc retired → ops follow-ups in issues #286–#291). **Adds** nullable `base_price_cents` (INTEGER), backfills existing rows
  per current tier from `TIER_CONFIG` base prices (basic 2900 / standard 7900 /
  premium 19900 / founders 1900; `WHERE base_price_cents IS NULL`, so re-running
  is a no-op), then `SET DEFAULT 7900` (mirrors `subscription_tier DEFAULT
  'standard'`) and `SET NOT NULL`, plus a non-negative CHECK
  (`accounts_base_price_cents_nonneg`, guarded idempotently by a `pg_constraint`
  lookup **scoped to the accounts relation**). Closes CLAUDE.md #9a's lone
  un-stored exception: base price is now grandfathered/point-in-time like
  `locations_included` / `locations_overage_price_cents`, read in
  `currentBillingSnapshot`, `monthlyMrrCents`, and `expectedInvoiceForAccount`.
  Additive + re-runnable.

- **055** — Auto-approval policy schema + approval attribution (PR1 scaffolding
  only; no runtime auto-approval branch). Creates `auto_approval_policies` with
  app-generated UUIDv7 IDs, account default rows (`location_id IS NULL`) and
  per-location override rows (`location_id IS NOT NULL`), nullable
  `auto_approve_min_star` constrained to 1..5 when present, timestamps, deny-by-
  default RLS, and partial unique indexes
  `auto_approval_policies_one_account_default` / `auto_approval_policies_one_location_override`
  whose predicates must match future `ON CONFLICT` clauses byte-for-byte. Adds
  `businesses_id_account_id_key` and a composite FK
  `(location_id, account_id) -> businesses(id, account_id)` with default
  `MATCH SIMPLE`, allowing account-default policy rows. Adds nullable
  `responses.approval_method` constrained to `owner` / `auto_policy`, backfills
  clear owner-approved rows conservatively, and leaves external/ambiguous posted
  rows NULL unless approval audit evidence exists. Extends
  `approval_audit_log.auth_method` to include `auto_policy`.

- **056** — Owner offboarding lifecycle schema (PR1 Task 1.1 only; no routes,
  workers, feature flag, or purge logic). Creates service-only deny-all RLS
  tables `account_offboardings` and `account_offboarding_tokens`.
  `account_offboardings` uses app-generated UUIDv7 IDs, an account FK, v1
  `mode` (`cancel_only` / `delete_data`), `system_origin='owner'`, the approved
  8-status machine, failed-step/terminal consistency checks, lifecycle stamps,
  snapshot fields (`stripe_*`, Zernio ids, location ids, auth user id), per-step
  outcomes, retry/error fields, transient recipient field, and
  `provider_dispositions JSONB NOT NULL DEFAULT '[]'::jsonb` for later admin
  provider-disposition overrides. Reason-code storage is deferred until the
  confirm route defines the canonical predefined code set. Adds the active-row
  partial unique index `(account_id) WHERE terminal_at IS NULL`, claim indexes for
  `purge_after WHERE status = 'purge_scheduled'` and
  `access_ends_at WHERE status = 'scheduled'`, plus lookup indexes on
  `account_id` and non-null `stripe_subscription_id`. `account_offboarding_tokens`
  stores only SHA-256 hex `token_hash` values for `token_type='keep_my_data'`,
  expiry/consume/revoke stamps, and audit metadata; no raw token column exists.

- **057** — Owner offboarding tombstone nullability (PR6 Task 6.2). Drops
  `NOT NULL` from `account_offboardings.zernio_account_ids` and
  `account_offboardings.zernio_profile_ids` so the purge terminal scrub can
  null raw provider snapshot identifiers while retaining the lifecycle receipt.
  Drops `NOT NULL` from `approval_audit_log.response_id` so scrubbed audit rows
  can be detached before hard-deleting response content. Drops `NOT NULL` from
  `impersonation_sessions.account_id` and
  `impersonation_sessions.impersonated_user_id` so retained admin-control rows
  can scrub purged account/user references. No new tables, policies, statuses,
  indexes, or browser-visible flags.

- **058** — Owner offboarding analytics event allowlist (PR7 Task 7.1).
  Replaces `analytics_events_event_name_check` so the durable, server-side
  owner offboarding lifecycle events can be enqueued:
  `offboarding_started`, `offboarding_reactivated`,
  `offboarding_teardown_completed`, and `offboarding_purged`. Fresh databases
  get the same event list from migration 046; existing staging/prod databases
  must receive 058 staging-first, then production. No new tables, policies,
  indexes, browser-visible flags, or client-postable analytics events.

- **059** — Owner offboarding purge-reminder marker (H1b). Adds
  `account_offboardings.purge_reminder_sent_at TIMESTAMPTZ` (nullable, additive)
  so the `AccountOffboardingPurgeReminderPoller` sends the T-3d "your data will
  be deleted soon" last-chance email at most once per `delete_data` offboarding.
  No backfill. Apply staging-first, then production, both Supabase projects in
  lockstep. No new tables, policies, indexes, or browser-visible flags.

- **060** — Owner offboarding reactivation claim columns (M1/M2). Adds
  `account_offboardings.reactivation_claimed_at TIMESTAMPTZ` and
  `reactivation_claim_token TEXT` (both nullable, additive) so the cancel_only
  reactivation flow stops overloading `last_error`/`reactivated_at` as the claim
  mutex. `reactivated_at` now stamps only at terminal success. Adds partial index
  `idx_account_offboardings_reactivation_claim ON (reactivation_claimed_at) WHERE
  reactivation_claimed_at IS NOT NULL AND terminal_at IS NULL` backing
  `AccountOffboardingReactivationResetPoller`, which clears stale claims (a dead
  reactivation process) after compensating Stripe back to
  `cancel_at_period_end=true`. No backfill (NULL = no active claim). Apply
  staging-first, then production, both Supabase projects in lockstep.

- **061** — SMS channel schema removal. Archives any stray `channel_enrollments`
  rows with `channel = 'sms'` (sets `archived_at = NOW()` where `archived_at IS NULL`
  so they are no longer active). Drops `idx_channel_enrollments_sms_handle` and
  replaces it with `idx_channel_enrollments_whatsapp_handle` (same
  `(handle) WHERE channel = 'whatsapp' AND status = 'verified'` shape). Rebuilds
  `channel_enrollments_one_mobile_per_scope` unique index to cover only
  `('telegram','whatsapp')` — SMS is removed from the predicate. Drops
  `sms_sender_opt_out_events` then `sms_sender_opt_outs` (RLS policies drop
  implicitly). Apply staging-first, then production, both Supabase projects in
  lockstep. **Pre-flight gate (documented in migration header):** confirm
  `channel_enrollments WHERE channel = 'sms' AND archived_at IS NULL` returns
  0 rows before running against production — the archive step is defensive but
  verify clean state first.

- **062** — Server-side duplicate `google_place_id` enforcement (multi-location
  hardening Fix 7). Adds partial UNIQUE index `businesses_account_place_uniq` on
  `businesses (account_id, google_place_id) WHERE archived_at IS NULL AND
  google_place_id IS NOT NULL` — an account cannot hold two ACTIVE locations with
  the same Google place (a duplicate double-ingests every review → double LLM
  spend + double notifications). **`CREATE INDEX CONCURRENTLY`** → apply
  NON-transactionally (uncheck "single transaction"), staging-first then prod, both
  Supabase projects in lockstep. **Pre-flight gate (in the migration header):** run
  the active-duplicate `(account_id, google_place_id)` query against staging AND
  prod; expect 0 rows. A pre-existing active duplicate aborts the CONCURRENTLY build
  and leaves an INVALID index (recover: `DROP INDEX businesses_account_place_uniq;`
  resolve the dup, re-run). No `ON CONFLICT` is added (callers only catch error
  code 23505), so the byte-for-byte predicate gotcha does not apply. URL-mode adds
  (NULL place_id) bypass the index, so `addLocationTransaction` enqueues the
  existing `validate_place_id` topic and the validation worker treats a 23505 on
  the resolved-place_id UPDATE as `duplicate_location` (leaves the location
  unverified, no job failure). Verified against a local postgres:16 (all migrations
  applied): active dup rejected, archived dup + NULL place_ids allowed.

- **063** — Account-level digest toggles + backfill (multi-location hardening PR E,
  `feat/multi-loc-E-digests-channels`). **Adds** `accounts.weekly_summary_enabled`
  and `accounts.monthly_impact_enabled` (both `BOOLEAN NOT NULL DEFAULT TRUE`,
  `ADD COLUMN IF NOT EXISTS` → additive + idempotent in shape). Moves the digest
  opt-out from per-location (`businesses`, migration 014, written only to the
  primary location, read per-location — so secondaries can never opt out and
  archived locations keep emailing) to account-level. The per-business
  `businesses.weekly_summary_enabled` / `monthly_impact_enabled` columns are
  **DEPRECATED** (read fallback during the cutover) and **NOT dropped**; the
  write/read path moves to the new account columns in later PR-E tasks (E2/E3).
  **Backfill (spec contract, three explicit branches via `CASE WHEN EXISTS`)**:
  (1) account HAS an active primary (`is_primary AND archived_at IS NULL`) →
  `COALESCE(activePrimary.<col>, TRUE)` (NULL→TRUE; does NOT fall through to the
  aggregate even when the primary's stored value is NULL); (2) no active primary
  row → `bool_and(COALESCE(<col>, TRUE))` over ALL the account's businesses rows
  (active OR archived) so any recorded opt-out anywhere survives ("former primary"
  is not identifiable — archiving sets `is_primary = FALSE`); (3) no businesses
  rows → `bool_and` over zero rows is NULL → outer `COALESCE` yields TRUE (the
  column default). Deliberately NOT a flat `COALESCE(primary, aggregate, TRUE)`
  chain (that wrongly falls through to the aggregate when an active primary has a
  NULL value). **Pre-flight (run against staging AND prod BEFORE applying):**
  `SELECT account_id, id FROM businesses WHERE (weekly_summary_enabled = FALSE
  OR monthly_impact_enabled = FALSE) AND is_primary = FALSE AND archived_at IS
  NULL;` — any rows mean an active non-primary location carries an opt-out the
  active-primary backfill branch ignores; carry those opt-outs forward manually
  (`bool_and` over the account's businesses rows). **Post-deploy re-run (spec
  Fix 5) is NOT the backfill UPDATE** — by then `accounts` is live source of
  truth and a full re-derive could re-enable an account-level opt-out recorded
  after the migration. The re-run (exact SQL in the migration header) only
  PROPAGATES NEW OPT-OUTS: per column, `SET <col> = FALSE WHERE <col> = TRUE
  AND <derived-from-businesses> = FALSE` — TRUE→FALSE tightening only, never
  re-enables. Transactional (the `accounts` table is
  small — no CONCURRENTLY). Apply staging-first, then production, both Supabase
  projects in lockstep. No RLS change (new columns inherit the `accounts` SELECT
  policy); no index. Verified against a local postgres:16 (migrations 001→062
  applied) inside a rolled-back tx: active-primary FALSE → FALSE; active-primary
  NULL + archived FALSE → TRUE; no-active-primary archived FALSE → FALSE (aggregate
  path); no-businesses → TRUE.

- **064** — Explicit wizard-completion stamp. **Adds**
  `accounts.onboarding_wizard_completed_at TIMESTAMPTZ` (nullable,
  `ADD COLUMN IF NOT EXISTS` → additive + idempotent). Replaces the
  `/api/auth/signup-status` timestamp proxy (`businesses.updated_at >
  accounts.subscription_activated_at + 2s`), which could false-positive when
  the `PlaceIdValidationWorker`'s UPDATE landed after Stripe activation.
  **Writer**: `/api/onboarding/business` stamps
  `COALESCE(onboarding_wizard_completed_at, NOW())` in the SAME tx as the
  wizard's businesses UPDATE (both legacy and post-pay branches; first
  completion wins). **Reader**: signup-status's `ONBOARDING_DEMO_ENABLED=true`
  branch reads the column directly (legacy branch still reads
  `place_id_verified`/`google_maps_url` — unchanged). **Backfill**: copies
  `b.updated_at` for accounts whose primary business satisfies the old proxy
  predicate, preserving every pre-migration `businessOnboarded` answer.
  No RLS change (inherits `accounts` policy); no index (only read via the
  already-indexed account row). Apply staging-first, then production, in
  lockstep.

- **065** — Archival + watchdog covering indexes (deep-scan §3.1/§3.3).
  **Adds** two partial indexes, both `CREATE INDEX CONCURRENTLY IF NOT EXISTS`:
  `idx_ie_archival ON inbound_events (processed_at) WHERE status = 'processed'`
  (the ArchivalPoller's daily DELETE predicate — the existing `idx_ie_status`
  is partial `WHERE status != 'processed'` and excludes exactly those rows) and
  `idx_jo_recovery ON job_outbox (dispatched_at) WHERE status IN ('dispatched',
  'dispatching')` (the OutboxPoller watchdog's per-cycle recovery scans; all
  three watchdog predicates imply the index predicate, and btree stores the
  NULL `dispatched_at` rows the stale-`dispatching` arm needs). **CONCURRENTLY
  ⇒ non-transactional**: uncheck "single transaction" in the Supabase SQL
  editor; on partial failure check `pg_index WHERE NOT indisvalid`, drop the
  invalid index, re-run. No table/RLS changes. Apply staging-first, then
  production, in lockstep.

- **066** — RLS on `inbound_events`, `prospect_demos`, `google_connections`
  (deep-scan §4.1). Three pre-existing tables (created in 001) held tenant / PII /
  secret-shaped data with **no `ENABLE ROW LEVEL SECURITY`** and were absent from
  `scripts/ci/tenant-tables.ts`, so `ci:rls-audit` was structurally blind to them
  (a public-schema table without RLS is anon-readable via PostgREST). Enables
  **deny-all RLS** (enable RLS, NO policy) on all three — server reaches them only
  via the RLS-bypassing Postgres.js `postgres` role, exactly like
  `analytics_events` (049) / `flagged_responses` (051) / `impersonation_sessions`
  (048). Lands **together with** the matching `TENANT_TABLES` entries +
  `docs/security/rls-inventory.md` rows + `scripts/ci/tenant-scope-allowlist.ts`
  exemptions (17 entries; baseline 340→357) so `ci:rls-audit` and
  `ci:tenant-scope` both stay green. `google_connections` was NOT dropped (the
  deep-scan's "dead table, drop it" advice is stale): owner-offboarding references
  it as a `hard_delete` purge target in `table-disposition.ts`,
  `purge-stages.ts`, `purge-helpers.ts`, `purge-verification.ts`. No
  table/column/data change. **Transactional — safe to apply in a SINGLE
  transaction** (no CONCURRENTLY). Apply staging-first, then production, both
  Supabase projects in lockstep. Verification after apply:
  `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN
  ('inbound_events','prospect_demos','google_connections');` → all `t`.

- **067** — Auto-approved post FYI backing indexes (channels-rollout Workstream B).
  Two PARTIAL UNIQUE indexes, both transactional (each predicate matches ZERO
  existing rows — `auto_post_notice` is a brand-new outbox topic AND a brand-new
  notification template, so the builds are instant; no CONCURRENTLY):
  - `idx_jo_auto_post_notice_inflight ON job_outbox (topic, aggregate_id) WHERE
    topic = 'auto_post_notice' AND status IN ('pending','dispatching','dispatched')`
    — in-flight dedup mirroring `idx_jo_publish_response_inflight` (026). The
    predicate matches `enqueueAutoPostNotice`'s `ON CONFLICT` byte-for-byte
    (`src/lib/shared/job-outbox-helpers.ts`) — the documented gotcha; a full
    `(topic, aggregate_id)` unique index would over-constrain other topics.
  - `notification_deliveries_auto_post_notice_claim ON notification_deliveries
    (response_id, channel, recipient) WHERE response_id IS NOT NULL AND template
    = 'auto_post_notice'` — claim-before-send dedup. Keyed on channel+recipient
    (not just `(response_id, template)` like 024/026) because the FYI fans out to
    multiple channels per response. Backs the dispatcher's claim `ON CONFLICT`
    byte-for-byte. No table/column/data/RLS change. Apply staging-first, then
    production, both Supabase projects in lockstep.

- **068** — `responses_approval_method_required` CHECK constraint (security audit
  F-4, 2026-06-15). Schema backstop for invariant #3 ("no unapproved posting").
  `responses.approval_method` was nullable with only a value-check
  (`responses_approval_method_check`: NULL or in `('owner','auto_policy')`); no
  constraint tied an *approved* status to a non-null method. Adds:
  `CHECK (status NOT IN ('approved','edited','awaiting_owner_connect') OR
  approval_method IS NOT NULL)`. `'posted'` is intentionally OMITTED: migration
  055 left some legacy `'posted'` rows with NULL `approval_method`, and a row can
  only reach `'posted'` THROUGH `approved`/`edited` (now guarded by this
  constraint), so the invariant holds without rejecting grandfathered rows. Safety:
  migration 055 exhaustively backfilled `approved`/`edited`/`awaiting_owner_connect`
  rows to `'owner'`, so the constraint applies cleanly. Transactional (no
  CONCURRENTLY). Apply staging-first, then production, both Supabase projects in
  lockstep. **Preflight BEFORE applying (run on each project; expect 0 rows):**
  `SELECT status, count(*) FROM responses WHERE status IN
  ('approved','edited','awaiting_owner_connect') AND approval_method IS NULL GROUP
  BY status;`

- **069** — Card-up-front Stripe-native 30-day free trial (PLAN.md rev 6). Two
  additive, idempotent, non-destructive changes — **NO new column, NO data
  backfill**. (1) Clarifying `COMMENT ON COLUMN accounts.subscription_activated_at`
  documenting it as the **service-start anchor** (set at TRIAL START for trialing
  accounts, at first payment otherwise — NOT necessarily first-payment date; ~47
  downstream consumers reuse it). Rev-3's separate `entitlement_started_at` column
  was rejected (Codex round 4 concurred). The explicit `'trialing'`
  `subscription_status` is a new VARCHAR value; `accounts.subscription_status` has
  **no CHECK constraint** (confirmed by sweep), so nothing to alter there.
  `accounts.trial_ends_at` already exists (migration 034). (2) Replaces
  `analytics_events_event_name_check` (from 058) to add the four durable
  server-side trial lifecycle events: `trial_started`, `trial_converted`,
  `trial_payment_failed`, `trial_cancelled` — keep in lockstep with
  `ANALYTICS_EVENT_NAMES` (drift-guard: `pnpm ci:analytics-events`). Transactional
  (no CONCURRENTLY). Apply staging-first, then production, both Supabase projects
  in lockstep.

- **070** — `reviews.google_review_name` Google-native resource-name capture
  (GBP-readiness; agentic-platform design 2026-07-01 §4 launch-track item 2).
  Adds nullable `google_review_name TEXT` + column comment. Populated at ingest
  from `ZernioReview.name` when it matches the canonical
  `accounts/{a}/locations/{l}/reviews/{r}` shape (`normalizeGoogleReviewName`,
  fail-open to NULL — capture is provenance, never a reason to fail ingest).
  Write sites: `process-review.ts` new-review INSERT + content-changed UPDATE
  (`COALESCE` — converges NULLs, never clobbers a stored value), and
  `insertImportedReview` INSERT + conflict-arm backfill
  (`COALESCE(reviews.google_review_name, EXCLUDED.google_review_name)`).
  **NOT part of dedup identity** — that remains `(provider,
  provider_review_name)`. Additive + idempotent, transactional (no
  CONCURRENTLY), no index, no RLS change, no in-migration backfill (historical
  rows recoverable from `inbound_events` raw payloads if/when the GBP adapter
  ships). Apply staging-first, then production, both Supabase projects in
  lockstep.

- **071** — Agent run spine: `agent_runs` / `agent_run_steps` / `agent_outcomes`
  (agentic-platform design 2026-07-01 §3.2, WS1). Attribution data written by
  the EXISTING pipeline in the same transactions as the state changes it
  describes — NOT an execution engine, no lifecycle machinery. Two partial
  unique indexes are ON CONFLICT targets whose predicates must stay
  **byte-for-byte** with their writers in `src/lib/agents/run-spine.ts`
  (enforced by a drift-guard test): `agent_runs_one_active_per_subject`
  (`WHERE status = 'running'`) ↔ `startOrGetActiveRun`, and
  `agent_outcomes_once_per_run_kind` (`WHERE agent_run_id IS NOT NULL`) ↔
  `recordOutcome`. CHECKs: `agent_runs_kind_subject_type_pairing`
  (`review_handler`↔`review`, `weekly_insights`↔`account_week`),
  `agent_runs_terminal_consistency` (`status='running'` ⟺ `ended_at IS NULL`)
  + `agent_runs_ended_after_started`. Deny-all RLS on all three (enabled, NO
  policies — same posture as `analytics_events`, migration 049); server
  reaches them via the RLS-bypassing `postgres` role only. IDs are
  app-supplied UUIDv7 (no DB default). Additive, transactional (no
  CONCURRENTLY — new tables, instant index builds). Apply staging-first, then
  production, both Supabase projects in lockstep.

- **072** — WS2 Guardian triage: seven nullable `triage_*` columns on `reviews`
  (`triage_severity`, `triage_issues`, `triage_suggested_action`,
  `triage_source`, `triage_model`, `triage_content_hash`, `triaged_at`) +
  `reviews_triage_consistency` CHECK — all-NULL (never triaged) or the
  mandatory quartet present: severity, source, suggested_action, triaged_at
  (every writer sets suggested_action and WS3 reads it, so a triaged row
  without it is unrepresentable); issues/model/hash stay individually
  nullable. Constraint is re-runnable (`DROP CONSTRAINT IF EXISTS` before
  ADD — migration-069 precedent). Vocabulary (severities, issue taxonomy,
  suggested actions, sources) is owned by `src/lib/reviews/triage-schema.ts`
  — keep it in lockstep with the column CHECKs. Hash invalidation:
  `triage_content_hash` stamps the hash of the text actually classified
  (the generation job's LOADED `review_content_hash`, not a re-read);
  mismatch with the current `review_content_hash` → re-triage. Fallback rows
  (`triage_source='fallback_high_v1'`) and `mock_v1` rows outside mock mode
  are re-attempted on the next generation job. No new index — WS3 defines
  its query shape. Columns ride `reviews`' existing RLS/offboarding posture
  (no new table, no policy changes). Additive, transactional. Apply staging
  first, then production, both Supabase projects in lockstep.

- **073** — WS3 Guardian escalation: `review_escalations` + escalation-notice
  dedup (agentic-platform design 2026-07-01, WS3 spec
  `docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md` §2.3).
  Creates `review_escalations` — one row per raised escalation, forward-only
  state machine `escalated → acknowledged → resolved` (direct
  `escalated → resolved` allowed, stamping BOTH timestamps). FKs to
  `accounts`/`businesses`/`reviews` (no cascade — offboarding purge deletes
  these rows explicitly before the `reviews` delete) and `agent_run_id` FK to
  `agent_runs` `ON DELETE SET NULL` (captured at raise so
  `escalation_resolved` can be attributed after the run row is gone).
  `triage_severity`/`triage_source`/`triage_suggested_action`/`triage_issues`
  are a SNAPSHOT of what Guardian acted on at raise time — NOT a live read of
  `reviews.triage_*`, which is rewritable by re-triage. CHECKs:
  `review_escalations_status` (`escalated`/`acknowledged`/`resolved`),
  `review_escalations_severity` (`low`/`medium`/`high`),
  `review_escalations_suggested_action` (`escalate`/`respond_and_escalate` —
  narrower than 072's full triage action set, since `respond` alone never
  raises an escalation), `review_escalations_state_timestamps` (forward-only
  state/timestamp pairing — `resolved` always implies
  `acknowledged_at IS NOT NULL`). All four guarded re-runnable via `DROP
  CONSTRAINT IF EXISTS` before `ADD CONSTRAINT` (migration-069 precedent).
  Indexes: `review_escalations_one_open_per_review` — partial UNIQUE on
  `(review_id) WHERE status <> 'resolved'`, backing `raiseEscalation`'s
  ON CONFLICT byte-for-byte (`src/lib/escalations/raise.ts`, lands in a later
  WS3 task) — dedups the cost-cap fallback burst and the concurrent-generation
  duplicate-triage race, while allowing a fresh escalation once the prior one
  resolves; `idx_review_escalations_account_status` — plain
  `(account_id, status)` for the dashboard's open-escalations-per-account
  read; `idx_review_escalations_agent_run` — partial
  `(agent_run_id) WHERE agent_run_id IS NOT NULL`, RI support for the
  `agent_run_id ON DELETE SET NULL` FK trigger (without it every
  `agent_runs` delete would seq-scan `review_escalations` — same reasoning
  as `idx_nd_escalation`). Deny-all RLS (enabled, NO policies — `agent_outcomes`/migration-071
  posture); server reaches it only via the RLS-bypassing `postgres` role.
  Also adds `notification_deliveries.escalation_id UUID REFERENCES
  review_escalations(id) ON DELETE SET NULL` (nullable — NULL for every
  template except `escalation_notice`, mirroring `auto_post_notice`'s
  `response_id` keying from migration 067) plus two more partial UNIQUE
  indexes: `notification_deliveries_escalation_notice_claim` on
  `(escalation_id, channel, recipient) WHERE escalation_id IS NOT NULL AND
  template = 'escalation_notice'` — claim-before-send dedup backing
  `claimEscalationNoticeDelivery`'s ON CONFLICT byte-for-byte
  (`src/lib/notifications/delivery.ts`); `idx_jo_escalation_notice_inflight`
  on `job_outbox (topic, aggregate_id) WHERE topic = 'escalation_notice' AND
  status IN ('pending', 'dispatching', 'dispatched')` — in-flight outbox
  dedup mirroring `idx_jo_auto_post_notice_inflight` (067), backing
  `enqueueEscalationNotice`'s ON CONFLICT byte-for-byte
  (`src/lib/shared/job-outbox-helpers.ts`); and `idx_nd_escalation` on
  `notification_deliveries (escalation_id) WHERE escalation_id IS NOT NULL`
  — plain RI-support index for the `ON DELETE SET NULL` FK (the claim
  index's `template = 'escalation_notice'` predicate is unusable by the FK
  trigger's equality lookup; without it, every escalation delete would
  seq-scan `notification_deliveries` — mirrors `idx_nd_response` in 001).
  All three ON CONFLICT writers land in later WS3 tasks on this branch —
  this migration is the schema foundation only.
  Additive, fully re-runnable (`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE]
  INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF
  EXISTS` before every `ADD CONSTRAINT`); no CONCURRENTLY (brand-new table +
  zero-row predicates, instant builds). Verified via double-apply against the
  test Supabase database: first apply creates all objects, second apply is a
  clean no-op (NOTICE-level skips only, zero errors). Apply staging first,
  then production, both Supabase projects in lockstep.

- **074** — WS4 trust dial + veto window schema (spec
  `docs/superpowers/specs/2026-07-07-ws4-trust-dial-veto-window-design.md`
  §2.1/§2.2/§2.3/§2.7/§2.8). Six new `auto_approval_policies` columns:
  `persona` (TEXT NOT NULL DEFAULT `'reply'`) + `action_class` (TEXT NOT NULL
  DEFAULT `'posting'`) — deliberately single-valued CHECKs today, widened (not
  redesigned) when Solicitation lands; `veto_window_minutes` (SMALLINT NOT
  NULL DEFAULT 15, CHECK `IN (15, 30)`); `daily_auto_post_cap` (SMALLINT NULL,
  CHECK 1..50 — NULL = platform default 10, owned by
  `DEFAULT_DAILY_AUTO_POST_CAP` in `src/lib/auto-approval/policy.ts`);
  `suspended_at`/`suspended_reason` (governor kill switch — columns + gate
  ship now, the WRITER lands in WS6, mirroring how 072 shipped triage columns
  ahead of WS3's consumer). **Ordering subtlety:** the positive-quadrant data
  raise (`UPDATE ... SET auto_approve_min_star = 4 WHERE ... < 4` — product
  unlaunched, user-confirmed, no grandfathering) runs BEFORE the
  `auto_approve_min_star` CHECK tightens from 1..5 to 4..5; reversing them
  would fail the ADD CONSTRAINT validation scan on any sub-4 row. Both partial
  unique indexes are REBUILT (`DROP INDEX IF EXISTS` + CREATE) to include the
  new scope: `auto_approval_policies_one_account_default` →
  `(account_id, persona, action_class) WHERE location_id IS NULL`,
  `auto_approval_policies_one_location_override` →
  `(account_id, location_id, persona, action_class) WHERE location_id IS NOT
  NULL` — the ON CONFLICT writers in `src/lib/auto-approval/settings.ts` are
  updated to match byte-for-byte later in the SAME PR (WS4 Task 12); the
  rebuild only widens the key, so no existing row can collide. **Apply
  window (both directions):** apply 074 in the same maintenance window as
  deploying its PR's code. *074-before-code:* the rebuild drops the indexes
  the PREVIOUS `settings.ts` upserts' ON CONFLICT clauses infer on, so during
  the gap `auto_approval_policies` upserts (owner settings save) fail with a
  no-matching-constraint error; reads and the auto-approval evaluator are
  unaffected. *Code-before-074:* safe ONLY while `AUTO_APPROVAL_ENABLED` is
  off — `persist.ts` short-circuits structural non-candidates before any
  074-column read (no policy SELECT, no runtime-state projection), so a
  flag-off deploy never touches the new columns; with the flag ON, candidate
  persists read them and would error against a pre-074 schema. **Staging runs
  the flag ON — apply 074 to staging BEFORE deploying the code there.**
  Pre-launch accepted tradeoff — documented explicitly rather than keeping
  redundant transition indexes. Adds nullable
  `responses.auto_post_scheduled_at` TIMESTAMPTZ — the veto-window publish
  deadline, single source of truth for the notice copy, approve-page scheduled
  state, and veto guard (stamped by `persist.ts` in WS4 Task 5; cleared by the
  veto downgrade in `src/lib/approval/veto.ts`. The publisher's kill-switch
  downgrade deliberately does NOT clear it — every consumer keys on
  `status='approved' AND approval_method='auto_policy'` plus a future
  deadline, so the stale value is inert). **Cap accounting (spec §2.3, amended
  §6):** the daily-cap count reads `approval_audit_log` rows
  (`action='auto_approved_by_policy'`, `created_at >=` UTC day start) —
  durable, never mutated, written same-tx as the grant — NOT the mutable
  `responses.approval_method/approved_at` columns, which the veto downgrade
  NULLs (a responses-based count refunded the slot on every veto). Served by
  the existing `idx_aal_business (business_id, created_at)` from 002; the
  originally-planned responses-side partial index
  `idx_responses_auto_policy_daily_cap` is reader-less and 074 now carries a
  guarded `DROP INDEX IF EXISTS` for it (cleans DBs that applied an earlier
  revision of this re-runnable migration). Swaps `agent_outcomes_outcome_kind_check`
  (`DROP CONSTRAINT IF EXISTS` + ADD, 069 precedent) replicating 071's exact
  kind list with `'reply_vetoed_by_owner'` appended after its edit sibling — a
  strict superset, paired with `AGENT_OUTCOME_KINDS` in
  `src/lib/agents/run-spine.ts` (WS4 Task 8). Two more partial UNIQUE indexes
  for the `pending_post_notice` topic-clone:
  `idx_jo_pending_post_notice_inflight` on `job_outbox (topic, aggregate_id)
  WHERE topic = 'pending_post_notice' AND status IN ('pending', 'dispatching',
  'dispatched')` ↔ `enqueuePendingPostNotice`'s ON CONFLICT
  (`src/lib/shared/job-outbox-helpers.ts`, Task 4), and
  `notification_deliveries_pending_post_notice_claim` on
  `(response_id, channel, recipient) WHERE response_id IS NOT NULL AND
  template = 'pending_post_notice'` ↔ `claimPendingPostNoticeDelivery`
  (`src/lib/notifications/delivery.ts`, Task 6) — both byte-for-byte with
  their writers, mirroring 067/073; no RI-support index needed (the claim
  keys on `response_id`, whose plain index exists since 001). No new table →
  columns ride their tables' existing RLS/offboarding posture. Fully
  re-runnable (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before
  every ADD, `DROP INDEX IF EXISTS` before the rebuilds, `CREATE [UNIQUE]
  INDEX IF NOT EXISTS`, naturally-idempotent guarded UPDATE); transactional,
  no CONCURRENTLY (the new partial indexes have zero-row predicates —
  `pending_post_notice` is a brand-new topic/template — and the
  policies/responses tables are small pre-launch). Verified via double-apply
  against the test Supabase database: second apply is a clean no-op
  (NOTICE-level skips only, zero errors; shape suite
  `src/lib/shared/__tests__/migration-074-trust-dial-veto-window.integration.test.ts`).
  Apply staging first, then production, both Supabase projects in lockstep.

- **075** — Agent-run subject lookup index (WS5 persona surfaces, spec
  `docs/superpowers/specs/2026-07-12-ws5-persona-surfaces-design.md` §6.1).
  Adds `idx_agent_runs_subject` on
  `(subject_type, subject_id, started_at DESC)` so the per-review timeline can
  read all runs for a subject, including completed and failed runs. Migration
  071's subject index is partial to `status = 'running'`, while its other run
  indexes lead on `business_id` or `account_id`, so none serve this lookup.
  Index-only and transactional (no `CONCURRENTLY`); no table, data, RLS, or
  authorization changes. **WS5 execution status:** applied and verified only
  against the local `test_ws4` container database; not applied to staging or
  production. At promotion time, the user applies it staging first, then
  production, both Supabase projects in lockstep.

- **076** — WS6 judge verdicts + governor support objects (spec
  `docs/superpowers/specs/2026-07-13-ws6-judge-governor-design.md` §2.3).
  Creates server-only `judge_verdicts`: app-supplied UUIDv7 id; account,
  business, review, and response FKs with `ON DELETE CASCADE`; nullable
  `agent_run_id ON DELETE SET NULL`; four-value verdict CHECK
  (`pass`/`warn`/`flag`/`error`); category-enum `reasons` JSONB, bounded-at-the-
  app-layer `rationale`, pinned model/prompt-version provenance, and one verdict
  per response. Deny-all RLS (enabled, zero policies) plus explicit
  authenticated write revocation matches the migration-071 spine posture.
  `idx_judge_verdicts_account_created (account_id, created_at DESC)` serves
  per-account governor windows; `idx_judge_verdicts_created (created_at DESC)`
  serves global judge-health windows. Three child-FK RI-support indexes prevent
  delete-trigger scans: `idx_judge_verdicts_business (business_id)` and
  `idx_judge_verdicts_review (review_id)` support `ON DELETE CASCADE`, while
  partial `idx_judge_verdicts_agent_run (agent_run_id) WHERE agent_run_id IS NOT
  NULL` supports `ON DELETE SET NULL`; `account_id` and `response_id` are already
  covered by the governor index and response UNIQUE respectively (WS6 §6 Task 1
  amendment). Adds
  `idx_responses_auto_policy_posted` for the bounded posted-auto-policy sweep
  and staleness scan. Adds partial UNIQUE in-flight outbox indexes for
  `judge_verdict`, `autonomy_suspended_notice`, and `autonomy_admin_alert`, each
  on `(topic, aggregate_id)` with the exact
  `status IN ('pending', 'dispatching', 'dispatched')` predicate their later
  `ON CONFLICT` writers must repeat byte-for-byte. Adds nullable
  `notification_deliveries.entity_id` plus the
  `notification_deliveries_autonomy_suspended_claim` partial UNIQUE claim on
  `(entity_id, channel, recipient) WHERE entity_id IS NOT NULL AND template =
  'autonomy_suspended_notice'`; suspension notices remain non-response-
  anchored (`response_id` stays NULL). Purely additive, transactional, fully
  re-runnable, and intentionally has no `CONCURRENTLY`: the verdict table is
  new, the topic/template predicates have zero rows before WS6 code, and
  responses remain pre-launch-sized. Verified by two clean applications and
  the exact live-catalog shape suite against the local `test_ws4` container
  only. **Apply window:** 076-before-code is always safe. Code-before-076 is
  safe only while `JUDGE_ENABLED` and `GOVERNOR_ENABLED` remain off; once
  enabled, workers read/write these objects. Apply staging first, then
  production, both Supabase projects in lockstep.

- **077** — WS8 Copilot/Autopilot expand + quiesced normalization (spec
  `docs/superpowers/specs/2026-07-14-ws8-tier-wiring-design.md` §7.2). Adds
  `accounts.price_variant TEXT NOT NULL DEFAULT 'list'`, constrained exactly to
  `list`/`founding`, plus a column-scoped immutable-update trigger. Also adds the
  account-scoped authoritative pending Checkout lease: attempt UUID, Session id
  and state, tier, variant, both Price ids, base/overage cents, included/paid
  quotas, provisional overage quantity, trial-period days, tax-enabled shape,
  customer email, success/cancel URLs, and update timestamp. These columns freeze
  every caller/environment-dependent Stripe create parameter so exact retries do
  not reuse one idempotency key with drifted inputs. The named
  complete-tuple CHECK permits only `creating`/`open`/`completed`/`remediated`
  full snapshots (or an all-NULL absent lease), and the partial unique
  `accounts_checkout_session_id_uniq` index prevents one Stripe Session from
  being bound to multiple accounts. Changes the
  account launch defaults to Copilot/list (`subscription_tier='copilot'`, base
  `2900`, overage `1500`, one included location) and the deprecated businesses
  tier-mirror default to `copilot`. The first-apply sentinel is whether
  `accounts.price_variant` existed before expansion: only when absent, one
  direct-SQL account UPDATE unconditionally writes the complete canonical
  snapshot (including `locations_paid=0`) to every then-existing account and a
  second UPDATE normalizes every businesses mirror. Reapplication repairs the
  defaults/CHECK/function/trigger plus Checkout CHECK/index only and never rewrites account or business
  data, so post-cutover founding Autopilot rows survive byte-for-byte. One
  atomic statement; no TypeScript/provider/Redis dependency, outbox row, or
  reconciliation enqueue. Apply only inside the quiesced rollout after the
  provider-wide Stripe subscription + open-Checkout preflight reaches zero
  blockers; apply staging first, then production, both projects in lockstep.
  Exact operator sequence and rollback boundary:
  `docs/runbooks/ws8-tier-cutover.md`.

- **078** — WS8 Copilot/Autopilot strict tier contract (spec
  `docs/superpowers/specs/2026-07-14-ws8-tier-wiring-design.md` §7.4). Runs
  NULL-safe preflights against both `accounts.subscription_tier` and the
  deprecated write-only `businesses.subscription_tier` mirror, aborting before
  any schema change when either table contains NULL or any value outside
  `copilot`/`autopilot`. On a clean preflight it preserves the accounts NOT NULL
  contract, makes the businesses mirror NOT NULL, and replaces the exact named
  CHECK on each table with the strict two-tier domain. Constraint replacement is
  scoped by both `conname` and `conrelid`, so reapplication repairs a stale or
  widened same-name definition instead of trusting it. One atomic direct-SQL
  statement, transactional and re-runnable. Apply only after 077, the strict-code
  deploy, and controlled smoke; staging first, then production, both projects in
  lockstep. Verified by NULL/every-legacy blocker cases, catalog/behavior checks,
  stale-definition repair, and repeated application against the local `test_ws4`
  database only; no staging or production migration was run during WS8 execution.
  Exact operator sequence and post-contract recovery boundary:
  `docs/runbooks/ws8-tier-cutover.md`.

> This feature (#479) originally planned two migrations. **079**
> (`agent_run_spine_archival_indexes`) and **080** (`scheduler_outbox_dedup_indexes`)
> are claimed by parallel works that rode staging first, so #479's cursor table was
> renumbered 079→**081**. The second planned migration — a composite
> `(subscription_status, id)` reconcile index (would have been 082) — was
> **evaluated and dropped at the mandatory staging EXPLAIN gate**: the planner
> prefers the existing `accounts_pkey` for the keyset query even with seq-scan
> disabled, and both prod and staging are empty pre-launch, so there is no evidence
> the index helps (see the #479 deviations file). It is a one-line CONCURRENTLY
> migration, re-addable later if a future prod EXPLAIN shows need. That is why this
> log jumps 078 → 081 on this branch — the 079/080 entries arrive with the staging merge.

- **097** — `suppression_analytics_events`: extends the
  `analytics_events.event_name` DB CHECK allowlist with
  `solicitation_suppressed` + `solicitation_suppressed_at_dispatch` (#643, spec
  `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` §9.4).
  The first is emitted by `recordSuppression` in the SAME transaction as the
  ledger row; the second belongs to #630's dispatch-time re-check and is
  registered here so #644 and #630 both stay migration-free. **Constraint-only:
  no new relation, column or index**, and the constraint name
  (`analytics_events_event_name_check`) has existed since 046 — hence **no
  `SchemaRequirement` export and no `assertSchemaReady` entry**, because a
  presence check on that name would pass against a 094-era database and prove
  nothing; 094, the exact analogue, likewise has none. No retention-policy row
  either. Same DROP + re-ADD under `lock_timeout` as 046 → 058 → 069 → 089 →
  094; the new list is a strict superset of 094's, so existing rows always pass.
  Why its own file and not part of 096 (#643 G8): the swap takes a brief ACCESS
  EXCLUSIVE lock on `analytics_events` and re-validates every row. Registering
  the names only in `ANALYTICS_EVENT_NAMES` would not have been enough (089's
  lesson) — without the CHECK entry every emitting transaction rolls back, and
  `ci:analytics-events` cannot catch it (it compares the TS allowlist against
  `docs/analytics/events.md`, never the database). Shape suite:
  `src/lib/shared/__tests__/migration-097-suppression-analytics-events.integration.test.ts`
  — text-only (it never calls `assertSchemaReady`) and the new owner of the live
  CHECK ⟺ `ANALYTICS_EVENT_NAMES` drift guard, handed off from 094's suite,
  which now pins its own historical 21-name list (the 089 → 094 precedent).
  **Applied to STAGING 2026-08-02 and PRODUCTION 2026-08-03** (immediately after
  096 in both, same change window), verified by schema introspection in both: the
  live `analytics_events_event_name_check` carries both `solicitation_suppressed`
  and `solicitation_suppressed_at_dispatch`. Lockstep complete (PR #647). Prod
  `analytics_events` held 0 rows at apply time, so the CHECK swap had nothing to
  validate against.

- **096** — `solicitation_suppressions`: the **Suppression ledger** and the
  **Unsubscribe token** table (#643, split from #626; locked spec
  `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md`
  §2.1/§2.2). Two new tables, five explicit indexes (three unique, two
  account-leading lookup), RLS enabled with zero policies on both.

  **`solicitation_suppressions` — keyed on the Normalized handle per channel,
  never on `contact_id`** (§1.1), so delete-and-re-upload cannot launder an
  opt-out (#535 §6). The two **Suppression scopes** (§1.2) give it TWO PARTIAL
  unique indexes — `(channel, normalized_handle) WHERE scope = 'global'` and
  `(channel, normalized_handle, account_id) WHERE scope = 'account'` — so every
  writer must re-spell its `ON CONFLICT` predicate BYTE-FOR-BYTE or Postgres
  will not infer the constraint (086 is the in-repo pattern). Writers are
  `ON CONFLICT … DO NOTHING`: **first write wins** (§2.1). `suppressed_at` is
  never compared against a window — both evaluation points are existence
  checks, which deliberately sidesteps the postgres.js microsecond-truncation
  class. `account_id` is the SCOPE, not a denormalization (086's warning does
  not apply — the row hangs off no business), and carries **no `ON DELETE`
  action** (§6.3): global rows survive the offboarding purge with `account_id`
  intact, pointing at the already-tombstoned `accounts` row. Two CHECKs pair
  scope and source, and the pairing is **one-directional**: `scope='account'`
  requires `account_id NOT NULL` while a `global` row MAY carry it as
  provenance; and **G11** pairs the closed seven-member source enum to scope,
  because `owner_manual` + `global` would otherwise insert cleanly and let one
  owner suppress a recipient across every tenant with no recipient having
  spoken. Handle stored **raw, not hashed** (§6.4) — a bare SHA-256 of an email
  is dictionary-attackable, and a real HMAC pepper is a catastrophic SPOF on a
  compliance record.

  **`solicitation_unsubscribe_tokens`** — SHA-256 `token_hash` only (invariants
  #5/#10), and that is **enforced, not merely asserted in a comment**: a named
  CHECK `token_hash ~ '^[a-f0-9]{64}$'` (mirroring 056's
  `account_offboarding_tokens`), because `TEXT NOT NULL UNIQUE` on its own would
  have stored a raw token as readily as a digest and every reader downstream
  would still have worked. Lowercase-only is deliberate — it is what
  `node:crypto`'s `digest('hex')` emits, and admitting uppercase would let two
  spellings of one digest past the UNIQUE index. `account_id`, `business_id`
  and `ask_id` are plain UUIDs with no FK,
  scrubbed to NULL by the purge. `outreach_id` is
  `REFERENCES solicitation_outreach(id) ON DELETE SET NULL` with a PARTIAL
  unique index (`WHERE outreach_id IS NOT NULL`, so purge-scrubbed NULLs never
  collide) — **#643 G1, amending B9**: CASCADE would have deleted retained token
  rows through the `solicitation_outreach` → `solicitation_batches` →
  `contact_csv_uploads` chain and broken §5.2, while no FK at all would have
  left a scrubbed row carrying a stale pointer nothing could detect. A CHECK
  enforces the one-way provenance-scrub implication (**G12**),
  `account_id IS NOT NULL OR (business_id IS NULL AND ask_id IS NULL)`,
  deliberately EXCLUDING `outreach_id` — SET NULL may null that one
  independently while the account is still live.

  **`account_id`-leading indexes on BOTH tables (G4).** The partial uniques lead
  with `(channel, normalized_handle)`, but the purge delete, the retained-row
  count and the token scrub all filter account-first and PG16 has no skip scan
  — migration 095's lesson applied up front. PKs are UUIDv7, worker-supplied.
  RLS deny-all is the `auto_approval_policies` posture (invariant #14), not
  decorative: a direct client read of a global row would expose the `account_id`
  provenance §7.4 forbids surfacing. **Both tables get a retention-policy row
  (above)** — they are the first solicitation tables that are not
  `hard_delete`-on-purge. Shape suite:
  `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts`
  (columns/nullability, both CHECK matrices driven from the `as const` arrays in
  `src/lib/solicitation/suppression.ts` and pinned against
  `pg_get_constraintdef()`, the token_hash format matrix — raw token, uppercase
  hex, off-by-one lengths and hex-length non-hex all rejected, a real digest
  accepted — exact FK set including the no-FK absences, both
  partial uniques, RLS-with-zero-policies); schema-ready entry
  `MIGRATION_096_SOLICITATION_SUPPRESSIONS`. **Applied to STAGING 2026-08-02 and
  PRODUCTION 2026-08-03 (PR #647) — lockstep complete**, verified by schema
  introspection in BOTH (never the Supabase migration ledger, which does not track
  RepWorth's `0xx` migrations): both tables present; all 8 indexes present (2 PKs,
  the 2 partial uniques, the 2 account-leading lookups, the partial `outreach_id`
  unique, the `token_hash` UNIQUE); `relrowsecurity=true` on both with **0** rows
  in `pg_policies`; the two FKs exactly `accounts(id)` with no referential action
  and `solicitation_outreach(id) ON DELETE SET NULL`; and
  `solicitation_unsubscribe_tokens_token_hash_sha256_hex` live as
  `CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))`. The two environments were
  diffed field-by-field on that introspection output and came back **identical**,
  which is the evidence for lockstep — not the fact that both `psql` runs exited 0.

  Prod schema deliberately landed **before** the merge: `loadCandidateWindow`'s
  LATERAL join and the purge stages both reference these tables, so code deploying
  ahead of the schema would have failed. Schema-ahead-of-code is the safe
  direction for an additive migration; code-ahead-of-schema is not.

- **095** — `consent_business_index`: one business-leading index
  `idx_solicitation_consent_business_handle` on
  `solicitation_consent (business_id, normalized_handle)` (#625 review round;
  Codex adversarial finding, 2026-07-30). The offboarding purge DELETE and the
  §7.1 contact-delete sweep filter by `business_id` (+ handle), but 093's scope
  unique leads with `channel` — PG16 has no skip scan, so those compliance
  deletes were full-table scans on a no-TTL table. Index-only: no data change,
  no new relation → no retention-policy row. Shape suite:
  `src/lib/shared/__tests__/migration-095-consent-business-index.integration.test.ts`;
  schema-ready entry `MIGRATION_095_CONSENT_BUSINESS_INDEX`.
  **Applied with 093+094, in order, to staging Supabase (`kubdiqdhqbhwmqfditeg`)
  2026-07-31 and production (`udeyaqnvpojbwgoaxwdg`) 2026-08-01 at the PR #640
  promotion** — both verified by schema introspection (columns / pg_indexes /
  RLS-with-zero-policies / CHECK contents), never the Supabase migration ledger.

- **094** — `consent_analytics_events`: extends the `analytics_events.event_name`
  DB CHECK allowlist with `solicitation_consent_recorded` +
  `solicitation_consent_upgraded` (#625 spec §8.1) — the consent ledger's two
  durable server-side events, emitted by `upsertConsent` in the csv_ingest
  transaction. Constraint-only (046 → 058 → 069 → 089 precedent: DROP + re-ADD
  under `lock_timeout`; the new list is a strict superset, so existing rows
  always pass); no new relation → no retention-policy row. Why not part of 093:
  the gap surfaced after 093 was the recorded head, and registering names only
  in `ANALYTICS_EVENT_NAMES` is not enough — without the CHECK entries every
  consent-recording csv_ingest transaction rolls back (089's lesson). Shape
  suite:
  `src/lib/shared/__tests__/migration-094-consent-analytics-events.integration.test.ts`
  — also the new owner of the live CHECK⟺allowlist drift guard, handed off
  from migration-089's suite (069 → 089 precedent).

- **093** — `solicitation_consent`: the consent ledger (#625; locked spec
  `docs/superpowers/specs/2026-07-28-consent-ledger-design.md` Part I §3).
  One new table, two indexes, RLS enabled with zero policies. One current-state
  row per `(channel, normalized_handle, business_id)` answering "which
  attestation covers this handle, for this channel, at this location."

  **Current-state rows, monotone forward (D3).** Granted, then upgraded to a
  newer attestation version by the guarded upsert (§4.2) — never backward.
  Point-in-time "what the sender relied upon" proof is stamped on
  `solicitation_outreach` at dispatch, never folded from an event log.
  **Revocation is not in this table** (D7 — no `revoked_at`, ever): #621's
  suppression ledger owns it entirely. The governing asymmetry is DR1 —
  consent fails closed; suppression fails open — so consent rows hard-delete
  with their contact and on offboarding purge, while suppression rows are
  retained through purge.

  **Email-only channel, one basis value (DR3, §3.3).** `CHECK (channel IN
  ('email'))` and `CHECK (basis IN ('owner_attested'))` — both widen per
  channel/basis alongside a new attestation text and counsel's answer, never
  by default.

  **Business-scoped, deliberately NO `account_id` (§3.2)** — 086's
  denormalization warning applies verbatim; purge joins through `businesses`.
  **`attested_by_user_id` is a plain UUID with NO FK (§3.4)**: 086's
  `contact_csv_uploads.attested_by_user_id` is `REFERENCES users(id) ON DELETE
  CASCADE`, and that staff-user cascade must never reach the ledger —
  attestation fields are point-in-time CAPTURES (the invariant-#9a pattern),
  with `source_upload_id` a nullable `ON DELETE SET NULL` audit pointer only.
  The scope unique is TOTAL (not partial), so the byte-for-byte
  `ON CONFLICT`/predicate gotcha does not arise for the upsert. PK is UUIDv7
  worker-supplied.

  Shape suite:
  `src/lib/shared/__tests__/migration-093-solicitation-consent.integration.test.ts`
  (columns/nullability, CHECKs, exact FK set + the attested_by_user_id
  FK-ABSENCE, total unique, RLS-with-zero-policies).

- **092** — Outreach body redaction reaches every TERMINAL row, not just `sent`
  (#636, deferred from #624 by the step-7 spec/correctness review as finding
  S2). Two objects: `solicitation_outreach_body_presence` is replaced with a
  wider arm, and one partial index is added.

  **The defect was true by construction, not by oversight.** 091's
  `body_presence` required `sent_at IS NOT NULL` of any row carrying
  `body_redacted_at`, and its `status_timestamp_consistency` made
  `sent_at IS NOT NULL` equivalent to `delivery_status = 'sent'`. So the
  redaction stamp was UNREPRESENTABLE on a `withheld`, `cancelled`, `failed` or
  `unknown` row — and the ArchivalPoller sweep, keyed on `sent_at`, could not
  have selected one even if the constraint had allowed it. Those rows kept their
  `rendered_subject`/`rendered_body` **and** their NOT NULL
  `interpolation_inputs` (`contact_first_name`, `visit_note` — third-party PII
  held on the contact's behalf) permanently. `unknown` is the sharp case: it
  pairs exclusively with `send_indeterminate`, meaning the provider never
  confirmed, so those messages may well have been delivered.

  **Widening, so it cannot reject a stored row — a proof, not a data check.**
  091 gives `sent_at IS NOT NULL` = `status = 'sent'`, and `'sent'` is a member
  of the new list, so the old arm implies the new one for every row satisfying
  both constraints. Exposure was zero anyway and only by sequencing: nothing
  writes those statuses until #630 builds the send worker, which is why this
  had to land BEFORE it rather than after.

  **The terminal set is spelled positively, and the direction is the point.**
  Under the explicit five-member list a future status is non-redactable until
  someone adds it — a retention gap, loud at test time. Under
  `NOT IN ('rendered','queued','sending')` a future LIVE status would be
  redactable the day it is added, silently reopening the wedge the arm exists to
  prevent (a bodyless live row can neither send nor settle, and pins its batch
  behind `solicitation_outreach_one_live_per_ask`).

  **`rendered_at` keys the new sweep arm, not `updated_at`.** `sent_at` is NULL
  on exactly the rows the arm is for. `rendered_at` is NOT NULL, no writer
  updates it, and it is when the body and its inputs came into existence — so
  the retention clock cannot be restarted by a late touch (a bounce signal, a
  backfill), which `updated_at` would allow, and it redacts no later than a
  terminalization-time key would. The same 90-day `BODY_RETENTION_DAYS`
  governs both arms: one window, two clocks.

  The status list is re-spelled literally in `ArchivalPoller`'s arm 10 rather
  than bound, because a bind parameter defeats the planner's partial-index
  implication proof — the same failure mode as a parameterized `ON CONFLICT`
  predicate. That the CHECK, the index predicate and the poller agree is
  asserted by the shape suite, since it is a fact with no single owner.

  Shape suite: `src/lib/shared/__tests__/migration-092-terminal-body-redaction.integration.test.ts`
  (constraint + index + planner). Sweep behaviour:
  `worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts`.

- **091** — Send-mode spine lifecycle + physical fan-out primitives (#624 of
  wayfinder map #617). Additive and re-runnable. Seven parts: `agent_runs` gains
  the terminal status `'cancelled'` and the parent kind
  `'solicitation_send_batch'` (pairing with the existing `solicitation_batch`
  subject type, so that subject now legitimately pairs with two kinds);
  `agent_outcomes` gains `'solicitation_sent'` and `'review_attributed'`;
  `solicitation_asks` gains the `(id, account_id, business_id)` unique the new
  ask FK requires; `solicitation_batches` gains the approval/send/halt lifecycle
  columns plus D8's one-active-send-per-Business partial unique;
  **`solicitation_outreach`** is created as the single send artifact table (B1);
  `auto_approval_policies` gains the solicitation lane and `daily_send_cap`; and
  `job_outbox` gains two in-flight partial uniques.

  **Frozen on purpose, and asserted as such by the integration suite:**
  `agent_runs_terminal_consistency` and `agent_runs_one_active_per_subject` keep
  their **071** definitions (the former reads `(status='running') = (ended_at IS
  NULL)`, which a terminal `cancelled` row with `ended_at` set satisfies as
  `FALSE = FALSE`; the latter is `WHERE status='running'` and never covered
  terminal rows). `agent_outcomes_unit_count_check` keeps its **088** definition —
  both new outcome kinds carry `unit_count = 1`, so the "zero is legal only for
  `solicitation_batch_built`" carve-out is untouched. The kind/subject/pairing and
  outcome-kind constraints are replicated from **088**, not 071; 088 had already
  widened all four.

  **Every multi-arm CHECK is wrapped in `IS TRUE`, and that is load-bearing.** A
  Postgres CHECK rejects only `FALSE` and *passes on NULL*, so the `IN (...)`
  idiom this lane inherited admits a NULL reason: 088's own
  `solicitation_asks_status_reason_consistency` accepts `('withhold', NULL)`
  today, because that arm evaluates to NULL and `FALSE OR NULL` is NULL. Verified
  empirically against the test DB before 091 was written. Over
  `delivery_status`'s eight values the same hole would have been much wider. (This
  is the same class of defect 090 closed with `IS NOT DISTINCT FROM`; the shipped
  088 hole is pre-existing and out of scope here.)

  Two subtleties a future reader will trip on. **"Terminal" and "reason-bearing"
  are different partitions** — the terminal set is `sent, withheld, cancelled,
  failed, unknown`, but `sent` takes a NULL `disposition_reason` because a
  successful send has nothing to explain. And the
  `auto_approval_policies_persona_consistency` CHECK pins action class *and* veto
  window per persona rather than widening the three columns independently, which
  would have silently loosened the already-live Reply lane from 074's `(15,30)` to
  allow 60. That CHECK cannot reject an existing row: 074 already enforced
  `persona='reply'`, `action_class='posting'` and `veto_window_minutes IN (15,30)`,
  so every pre-091 row satisfies the reply arm by construction — a proof, not a
  data check.

  The two `job_outbox` indexes are keyed `(topic, aggregate_id)` — the table has
  **no `batch_id` column**. They ship without a `QUEUE_NAMES` entry or typed
  helper per amendment B10, which moves that obligation to the producers
  (#628/#630), each discharging it in the same PR as its first raw insert or
  `ci:outbox-seam` fails them. Safe because `ci:outbox-topics` scans `src/lib`,
  `src/app` and `worker` only, never migrations.

  Plan: `docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md`.
  ADR: `docs/adr/0014-send-mode-spine-lifecycle.md`.
  Shape suite: `src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts`.

- **090** — `solicitation_asks.evidence` decision discriminant enforced at WRITE
  time (#593, from the 2026-07-27 architecture review). 088 created
  `evidence JSONB NOT NULL` with no CHECK; the discriminant was enforced only by
  a throw in `src/lib/solicitation/batch-view.ts`'s `parseEvidence`, at read
  time — and that read builds the whole Requests view from ONE statement, so a
  single malformed row failed the view for the entire account rather than its
  own line.

  The constraint pins the JSONB to its neighbouring columns rather than merely
  asserting a discriminant exists: `batch-builder.ts` stores the whole decision
  object as `evidence` and DERIVES `status` (= `decision.decision`) and
  `withheld_reason` (= `decision.reason` on a withhold, else NULL) from it, so
  the three are views of one fact with one writer. 088's
  `solicitation_asks_status_reason_consistency` already constrains the column
  pair; 090 ties the JSONB to that same pair, which makes the discriminant check
  fall out.

  **Both comparisons are `IS NOT DISTINCT FROM`, and that is load-bearing.** A
  CHECK rejects only FALSE and PASSES on NULL, so `evidence->>'decision' =
  status` yields NULL for an evidence object with no `decision` key — the exact
  #593 row would still have been accepted. The first draft had that hole;
  `migration-090-solicitation-ask-evidence.integration.test.ts` caught it before
  the migration was applied anywhere. Proven three ways against the local test
  DB: shipped form REJECTS the row, the `=` draft ACCEPTS it, no constraint
  ACCEPTS it.

  Split `ADD CONSTRAINT … NOT VALID` (brief ACCESS EXCLUSIVE, no scan) +
  `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE, does not block reads or
  writes), under `lock_timeout = '5s'`, so a populated table never blocks the
  solicitation lane mid-build. The header carries the preflight count to run on
  each environment before applying — a non-zero result is a real malformed row
  to fix, never a reason to weaken the constraint. No new table, column or
  index, so **no RLS change and no retention change**; the schema-ready harness
  gained a `constraints` requirement kind, since a constraint-only migration has
  nothing else to point at.

  **Applied to staging Supabase (`kubdiqdhqbhwmqfditeg`) 2026-07-27.** Preflight
  first: 80 `solicitation_asks` rows, **0** violating, constraint absent — so
  VALIDATE had nothing to reject. Verified by schema introspection, not the
  migration ledger: one `pg_constraint` row named
  `solicitation_asks_evidence_matches_columns` with `convalidated = true`, and
  its `pg_get_constraintdef` reads `NOT ((evidence ->> 'decision') IS DISTINCT
  FROM status)` — Postgres's rendering of `IS NOT DISTINCT FROM`, which is what
  distinguishes the shipped constraint from the `=` draft that would have let
  the #593 row through.

  **Applied to production Supabase (`udeyaqnvpojbwgoaxwdg`) 2026-07-27**, same
  day, closing the lockstep. Preflight first: `to_regclass` confirmed 088's
  `solicitation_asks` present (090 is meaningless without it), **0** rows, **0**
  violating, constraint absent — an empty table, so VALIDATE was instant and the
  ACCESS EXCLUSIVE window nil. Verified the same way as staging, and the
  definition came back byte-identical to it, `convalidated = true`, carrying the
  `IS DISTINCT FROM` spelling that separates the shipped constraint from the `=`
  draft. **Both projects now in lockstep at 090.**

- **089** — Owner-picked Named rival for the Competitor Delta line (#546, map
  #528; semantics locked in #532 item 2). Adds three nullable columns to
  `businesses` — `rival_place_id`, `rival_title_snapshot`, `rival_picked_at` —
  following 014's precedent that per-location ranking/competitor config lives on
  `businesses`; a location has at most one pick, so a 1:1 column set beats a side
  table and the digest's existing `businesses` SELECT picks them up at zero extra
  query cost. No backfill, no default: existing rows keep NULL and fall back to
  the Auto-default rival exactly as today. **Deliberately no FK to
  `competitor_snapshots`** — 084 replaces packs wholesale on every ranking run, so
  an FK would cascade-delete a pick the owner explicitly made; pack membership is
  a read-side question answered per-digest by `resolveNamedRival`.
  `rival_title_snapshot` is server-derived from the matched pack row at pick time
  (never client-supplied — it reaches a rendered email) and is read only for the
  dropout note and the settings UI's absent-pick entry.

  **Not additive-only.** The migration also DROPs and re-ADDs
  `analytics_events_event_name_check` to register `competitor_rival_picked`
  (constraint introduced in 046, last extended by 069) — that takes a brief
  ACCESS EXCLUSIVE lock on `analytics_events` and re-validates every existing
  row, hence `lock_timeout = '5s'`. The end state is idempotent on re-run, but
  the execution is not a no-op. Registering the name in `ANALYTICS_EVENT_NAMES`
  alone would not work: every pick transaction would ROLL BACK on the constraint,
  and `ci:analytics-events` would not catch it (it compares the TS allowlist
  against `docs/analytics/events.md`, never the database). 089 is now the latest
  constraint-extending migration, so it also carries the "effective CHECK list ⊇
  `ANALYTICS_EVENT_NAMES`" drift-guard, handed off from
  `migration-069-trial-subscription.test.ts`. No RLS change (`businesses`'
  existing policies cover the new columns) and no retention change (no new
  table).

  **Applied to staging Supabase (`kubdiqdhqbhwmqfditeg`) 2026-07-25**, ahead of
  the deploy — the lane query SELECTs `rival_place_id`/`rival_title_snapshot`, so
  the branch cannot run anywhere 089 is absent. Verified by schema introspection,
  not the migration ledger: the three columns exist as nullable
  (`text`/`text`/`timestamptz`), and `analytics_events_event_name_check` contains
  `competitor_rival_picked` with `convalidated = true`. Preflight found zero
  `analytics_events` rows outside the new allowlist, so the re-ADD validated
  clean. **Not yet applied to prod** — apply at promotion, in lockstep.

- **088** — Solicitation batch executor persistence foundation (#543 plan T1;
  ADR 0011). Adds nullable `agent_runs.parent_run_id` with `ON DELETE SET NULL`
  plus its partial RI-support index. Widens only the run kind/subject pairing,
  attributed-agent, and outcome/unit-count CHECKs for the
  `solicitation_batch` parent, `solicitation_ask` completed children,
  `solicitation` persona, and `solicitation_batch_built` outcome. The
  three-state run status enum and `agent_runs_one_active_per_subject WHERE
  status = 'running'` remain unchanged. Zero `agent_outcomes.unit_count` is
  legal only for an empty `solicitation_batch_built` aggregate; every prior
  outcome kind remains strictly positive.

  Creates `solicitation_batches` (one per source upload) and
  `solicitation_asks` (one authoritative send/withhold decision per candidate
  per batch), with app-supplied UUIDv7 ids, composite account/Business/source
  upload/contact FKs, source-upload idempotency, the closed six-reason withhold
  domain, and archival-safe `solicitation_asks.agent_run_id ON DELETE SET
  NULL`. Candidate-window indexes cover the accumulated Business pool and
  latest visit; separate any-decision and partial `status = 'send'` history
  indexes ensure simulated contact history never starts from
  `velocity_banked` or another withhold. Owner-read-only RLS covers both
  tables, and the `solicitation_batches_owner_select` policy itself requires
  `built_at IS NOT NULL`. Account offboarding hard-deletes both through the
  `contact_csv_uploads → solicitation_batches → solicitation_asks` cascade and
  verifies both tables fail-closed before stamping purge complete. Additive,
  transactional, and re-runnable; not remotely applied by T1. Apply staging
  first only when #543 reaches its high-risk staging migration step, then
  production at promotion in lockstep.

- **087** — Covering indexes for the three un-indexed FK columns from 086
  (#541, PR #564 review): `solicitation_contacts (created_by_upload_id)`,
  `solicitation_visits (upload_id)`, `contact_csv_uploads
  (attested_by_user_id)`. The `ON DELETE CASCADE` triggers behind these FKs
  seq-scan the referencing table per deleted parent row during the
  offboarding purge sweep. Purely additive `CREATE INDEX IF NOT EXISTS`
  (plain columns — no expression/partial-index gotchas); **no RLS or
  retention change** — indexes only. Staging first, then prod, in lockstep.

- **086** — Contacts/visits CSV ingestion + consent attestation schema (#541,
  map #528; contract locked in #535:
  `docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md`).
  Creates three new tables. `contact_csv_uploads` — one row per CSV upload:
  account/business FKs (`ON DELETE CASCADE`), transport fields (`filename`,
  `byte_size`, `content_sha256`, nullable `raw_csv`), status machine
  (`pending`/`completed`/`failed`), terminal `report JSONB`, and the consent
  attestation (attesting user FK, `attested_at`, `attestation_version`) — no
  per-row consent columns (counsel guidance, §4). `contact_csv_uploads_terminal_consistency`
  CHECK pairs status with `raw_csv`/`report`/`completed_at` presence so a
  pending-without-raw-CSV or terminal-with-raw-CSV row is unrepresentable; the
  worker NULLs `raw_csv` in the SAME transaction that writes the terminal
  report (§3) — there is deliberately NO individual-upload delete path
  (upload-undo is contractually impossible, §1.3), so the CASCADE off this
  table exists only for account/business offboarding sweeps.
  `solicitation_contacts` — Contact = deduped identity of one person at one
  location, keyed `(business_id, normalized handle)` (§1.2). Deliberately
  **business-scoped only** (no denormalized `account_id`; `businesses.account_id`
  stays the single authoritative owner of that pairing — RLS and offboarding
  purge join through `businesses`). `solicitation_contacts_handle_present`
  CHECK requires email or phone; identity is enforced as **two partial unique
  indexes** (`solicitation_contacts_email_uniq`, `_phone_uniq`, both
  `(business_id, <handle>) WHERE <handle> IS NOT NULL`) rather than one
  composite unique, because either handle alone identifies the contact.
  Ingest never writes `ON CONFLICT` against these indexes (a per-business
  advisory lock serializes read-then-write instead), so the byte-for-byte
  `ON CONFLICT`/predicate gotcha does not apply here. Also carries
  `solicitation_contacts_id_business_uniq UNIQUE (id, business_id)` as the
  composite-FK target for visits. `solicitation_visits` — Visit = append-only
  ledger row unique on `(contact_id, visit_date)` (§1.3), so re-uploads are
  idempotent by construction (`solicitation_visits_contact_date_uniq`).
  `solicitation_visits_contact_business_fk` is a **composite FK**
  `(contact_id, business_id) REFERENCES solicitation_contacts (id,
  business_id)` — DB-enforced (not just app-enforced) proof that a visit can
  only reference a contact at the same location. RLS: owner read-only on all
  three, mirroring `competitor_snapshots` (084) — `contact_csv_uploads` keys
  directly on `account_id = owner_account_id()`; the other two join through
  `businesses`. All writes come from the Railway worker / server routes over
  the direct Postgres connection. Additive, transactional (no
  `CONCURRENTLY` — brand-new tables, zero-row predicates, instant builds),
  fully re-runnable (`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF
  NOT EXISTS`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`). Schema
  facts (`accounts`/`businesses`/`users` table names and UUID PKs,
  `owner_account_id()` shape) verified against migrations 001/034/035 before
  writing — no adjustment needed. `pnpm ci:rls-audit` and `pnpm
  ci:tenant-scope` both pass unchanged (no registry/allowlist entries
  required by either script for this migration). **Applied to staging
  2026-07-24** (verified by introspection: 3 tables + 3 indexes + 5
  constraints + 3 owner-select policies present, RLS enabled); **prod applies
  at promotion** of feat/541-contacts-csv in lockstep.

- **085** — `competitor_snapshots.rating` REAL → NUMERIC(2,1) (`USING
  round(rating::numeric, 1)`; PR #554 pre-merge review). float4 drifts
  (4.8 → 4.80000019…) and would silently mis-match future Delta-line band
  comparisons; NUMERIC is exact. New migration rather than an 084 amend
  because 084 was already applied to staging (immutability). Read-side:
  Postgres.js returns NUMERIC as a JS string — column is write-only until
  #539, which must parse it. No new table/index — no RLS/retention change.
- **084** — Competitor pack persistence (#538, map #528, semantics #532). New
  `competitor_snapshots` table (full ~20 local-pack rows per
  business+keyword+snapshot_date incl. is_self row; nullable place_id/rating/
  review_count; data_cid write-only rotation insurance). Replace-pack idempotency
  (DELETE+INSERT in the RankingTrackingWorker tx) — deliberately no per-row unique
  key. RLS owner_select mirror of 035 §2f. Retention: exempt (core competitor
  history, ~20 rows/business/week); revisit if table exceeds ~5M rows or when the
  Competitor Delta digest line ships.
- **083** — Owner-unreachable outbox marker (F1, plan
  `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md`). Adds
  nullable `job_outbox.completion_reason TEXT` so a `send_notification` job that
  completes with zero verified channel enrollments records
  `completion_reason='owner_unreachable'`, letting `HealthAlertPoller` and the
  `NotificationFailoverPoller` owner-unreachable arm observe + escalate the
  outcome (T3/T4). Written via `markOutboxOwnerUnreachable`
  (`src/lib/shared/outbox.ts`) with the same attempt-guarded CAS as the sibling
  outbox writers; value owned by `OUTBOX_COMPLETION_REASON`
  (`src/lib/shared/outbox-completion-reason.ts`). **No new index** — the lookups
  reuse `idx_responses_pending_approval_created` and
  `idx_jo_send_notification_by_aggregate` from migration 082. Additive
  (`ADD COLUMN IF NOT EXISTS`, no default, existing rows stay NULL);
  transactional with `SET LOCAL lock_timeout = '3s'` to bound the brief ACCESS
  EXCLUSIVE lock on the hot `job_outbox` table. **Applied: staging 2026-07-21,
  production 2026-07-21 (owner-confirmed), in lockstep.**
- **082** — NotificationFailoverPoller lookup indexes (scalability-verification
  item 8). Two partial indexes so the failover poller stops seq-scanning at
  scale: `idx_jo_send_notification_by_aggregate` on `job_outbox
  (aggregate_id, created_at DESC) WHERE topic = 'send_notification'` serves the
  `recoverFailoverCorrelationId` lookup
  (`worker/background/pollers/NotificationFailoverPoller.ts` — topic +
  aggregate_id, `ORDER BY created_at DESC LIMIT 1`; exact mirror of 018's
  `idx_jo_generate_response_by_review` for the generate_response twin), and
  `idx_responses_pending_approval_created` on `responses (created_at)
  WHERE status = 'pending_approval'` serves both global sweeps (all-failed and
  stale: `status = 'pending_approval' AND created_at < NOW() - INTERVAL '4
  hours' ORDER BY created_at ASC`, cross-tenant by design). No INCLUDE columns
  yet — staging `EXPLAIN (ANALYZE, BUFFERS)` evidence for the three target
  queries is captured at ship BEFORE any INCLUDE-column refinement (evidence
  rule). Both use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, so this migration
  is **non-transactional** (uncheck the Supabase SQL editor's
  single-transaction box) and the two statements are **NOT atomic** — the first
  can succeed and the second fail. Recovery for an interrupted build (062
  lesson: `IF NOT EXISTS` silently skips an INVALID index): check
  `pg_index.indisvalid` for each; if false, `DROP INDEX CONCURRENTLY <name>;`
  and re-run. Apply staging first, then production, both projects in lockstep.
- **081** — `poller_cursors` durable keyset resume cursor for
  `StripeLocationsReconcilePoller` (#479, map #472; ADR
  `docs/adr/0006-poller-cursor-persistence-ordering.md`). Creates
  `poller_cursors (poller_name TEXT PRIMARY KEY, cursor UUID, write_seq BIGINT
  NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())` — one row
  per poller. Persists the in-memory keyset cursor added in #487 so a worker
  restart resumes the rotation instead of re-walking the head. `write_seq` is the
  ordering guard: the poller holds an in-memory `writeSeq` seeded at boot from
  this column and stamps a fresh monotonic seq per save; `saveCursor`'s UPSERT
  applies only `WHERE EXCLUDED.write_seq > poller_cursors.write_seq`, so a
  stale/detached/reordered save (withTimeout races rather than cancels — a
  timed-out save can land late) is a DB no-op. **Deny-all RLS** (enabled, NO
  policies — same posture as `impersonation_sessions`/048, `agent_runs`/071);
  holds NO tenant data (no `account_id` — just a poller name + an opaque
  last-claimed account id), so server reaches it via the RLS-bypassing
  `postgres` role only and it is NOT a tenant table. Additive, transactional (no
  CONCURRENTLY — brand-new table, instant build), re-runnable
  (`CREATE TABLE IF NOT EXISTS`). Apply staging first, then production, both
  Supabase projects in lockstep.
- **080** — Scheduler set-based outbox dedup indexes + race-safe preflight
  (ticket #484, parent #472 audit item 10). Renumbered 079→080: migration 079
  (`079_agent_run_spine_archival_indexes.sql`, agent-run-spine archival) rode
  `staging` first and claimed 079; this migration takes 080. Both land on `main`
  via separate PRs (archival's 079 must precede this 080). Two PARTIAL UNIQUE indexes on
  `job_outbox` so the weekly/monthly summary schedulers can collapse their
  per-row insert loop into one `INSERT…SELECT…ON CONFLICT DO NOTHING` (Task 2)
  with the dedup guarantee owned by the DB instead of a JS-side `WHERE NOT
  EXISTS` (which cannot close the concurrent-scheduler / restart race):
  `uniq_outbox_weekly_summary_week` on `(aggregate_id, (payload->>'week_start_date'))
  WHERE topic = 'weekly_summary' AND status IN ('pending','dispatching','dispatched')`
  and `uniq_outbox_monthly_impact_month` on `(aggregate_id, (payload->>'month_start_date'))
  WHERE topic = 'send_monthly_impact' AND status IN ('pending','dispatching','dispatched')`.
  **Predicate is in-flight-only, NOT `<> 'failed'`** (deliberate divergence from
  ranking's `uniq_outbox_track_ranking_run`, which is untouched): weekly/monthly
  have a `sent_at` completion guard, and the worker `markOutboxCompleted`'s a row
  WITHOUT `sent_at` in three skip cases (archived / subscription-not-allowed /
  bounced email), so a `<> 'failed'` predicate would wrongly block those
  legitimate re-enqueues. The in-flight-only predicate EXACTLY mirrors the
  existing NOT EXISTS → behavior preserved; a `completed`/`failed` row never
  blocks re-enqueue. Each index is preceded by a **race-safe preflight**: rank
  in-flight rows per `(aggregate_id, period)` most-advanced-then-oldest
  (`dispatched` > `dispatching` > `pending`, then `created_at`) and fail ONLY
  currently-`pending` extras via a LIVE compare-and-swap (the outer UPDATE's
  `AND status = 'pending'`, re-checked under EvalPlanQual after row-lock) — an
  actively-dispatched row is NEVER overwritten and the OutboxPoller cannot lose a
  concurrent dispatch. NULL-period rows excluded. If two non-pending in-flight
  duplicates for one key coexist (near-impossible under the single-flight
  guarded-poll), the CREATE UNIQUE INDEX fails LOUDLY rather than killing an
  active job — surfaced staging-first. Additive, transactional (non-CONCURRENTLY;
  sub-second ACCESS EXCLUSIVE at 100-business scale). Apply staging-first, then
  production, both Supabase projects in lockstep.

  > **Deliberate deviation — `gen_random_uuid()` (UUIDv4) for the set-based
  > INSERT path (Task 2):** the collapsed schedulers supply `job_outbox.id` and
  > `payload.correlation_id` via SQL `gen_random_uuid()` instead of the app-side
  > JS UUIDv7 generator. Justification: prod Postgres has no `uuidv7()` function,
  > and a set-based `INSERT…SELECT` cannot call the per-row JS generator.
  > `job_outbox.id` has NO ordering contract — migration 002 DROPPED its DEFAULT,
  > the INSERT supplies `id` explicitly, and the OutboxPoller orders by
  > `available_at`, never `id`. `correlation_id` is an opaque trace string. Rows
  > are 7-day pruned. This is the RepWorth-wide "all tables use UUIDv7" note's
  > one sanctioned exception, scoped to these two set-based scheduler INSERTs.
- **079** — Agent-run-spine archival-scan indexes. Adds two archival indexes so
  the ArchivalPoller's new 180-day retention arms
  (`worker/background/pollers/ArchivalPoller.ts`, arms 7 and 8) can prune the
  migration-071 run spine without seq-scanning: `idx_agent_outcomes_archival`
  on `agent_outcomes (occurred_at)` serves the `occurred_at < NOW() -
  make_interval(days => 180)` claim, and the partial
  `idx_agent_runs_archival` on `agent_runs (ended_at) WHERE ended_at IS NOT
  NULL` serves the `ended_at < …` claim (the predicate implies non-NULL, same
  pattern as 065's `idx_jo_recovery`). `agent_run_steps` needs no arm of its
  own — its `agent_run_id` FK is `ON DELETE CASCADE`, so steps prune with their
  parent run. Both use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, so this
  migration is **non-transactional** (uncheck the Supabase SQL editor's single-
  transaction box); a partial failure can leave an INVALID index — check
  `pg_index WHERE NOT indisvalid`, DROP, and re-run. Apply staging first, then
  production, both projects in lockstep. Supports the 180-day retention arms
  added in the same PR.

## Key Tables Reference

| Table | Purpose |
|---|---|
| `users` | App users with `auth_id` → Supabase Auth mapping |
| `businesses` | Owner businesses: `subscription_status`, `subscription_tier`, `place_id_verified`, `onboarded_by`, `stripe_customer_id`, `last_sync_at` |
| `google_connections` | Legacy direct-GBP OAuth token store (`*_encrypted`, `encrypted_dek`), superseded by Zernio. Not populated on the live path; retained as an owner-offboarding `hard_delete` purge target. Deny-all RLS (migration 066). |
| `reviews` | Ingested reviews from all sources |
| `responses` | AI-drafted responses — see status values below |
| `approval_links` | SHA-256 hashed tokens only — raw tokens never stored |
| `approval_audit_log` | Every approval action logged. `response_text_at_approval` (migration 044) is an immutable snapshot of the exact owner-approved text, written in-tx via `insertAuditLog`/`insertAuditLogSession` across all publish paths — dispute evidence (Spec 29 Gap 1) |
| `review_exceptions` | Dedup collisions, pagination cap exhaustions, not-found signals |
| `job_outbox` | Transactional outbox — all async work dispatched through here |
| `inbound_events` | Webhook dedup — always write here first before business logic |
| `notification_deliveries` | Per-channel delivery records |
| `channel_enrollments` | Multi-channel owner enrollments (email/telegram/whatsapp) |
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
| `account_offboardings` | Service-only owner offboarding lifecycle rows. One active non-terminal row per account; terminal outcomes are `purged`, `churned`, or `reactivated`. |
| `account_offboarding_tokens` | Service-only keep-my-data token metadata for delete-data offboarding. Stores SHA-256 token hashes only; raw tokens are never persisted. |
| `owner_leads` | Marketing capture from contact + demo-request endpoints (independent of authenticated paths). |
| `agent_runs` | One attributed agent run per pipeline pass over a subject (review or account-week). Written only by `src/lib/agents/run-spine.ts` in-pipeline-tx; at most one `running` run per subject (partial unique index = `startOrGetActiveRun` ON CONFLICT target). Deny-all RLS (migration 071). |
| `agent_run_steps` | Ordered attribution steps within an agent run (`step_index` unique per run; `attributed_agent` from the `STEP_PERSONA` map). `detail` JSONB is ids/enums/counts only — never raw review/response text. Deny-all RLS (migration 071). |
| `agent_outcomes` | Durable per-agent outcome facts (drafted/posted/escalated/…) for attribution and reporting; deduped per `(agent_run_id, outcome_kind)` via partial unique index = `recordOutcome` ON CONFLICT target. Deny-all RLS (migration 071). |
| `review_escalations` | Guardian escalations (WS3): one row per raised escalation, forward-only state machine `escalated → acknowledged → resolved`; triage columns snapshot what Guardian acted on at raise time. At most one open (non-resolved) row per review (partial unique index = `raiseEscalation` ON CONFLICT target). Deny-all RLS (migration 073). |
| `contact_csv_uploads` | One row per Contacts/visits CSV upload (#541, migration 086): transport fields (`raw_csv`, NULLed at terminal state), status machine, terminal `report JSONB`, and the per-upload consent attestation. Owner-read-only RLS keyed on `account_id`. |
| `solicitation_contacts` | Deduped contact identity keyed `(business_id, normalized handle)` (migration 086); two partial unique indexes (email, phone) enforce identity. Business-scoped only — no denormalized `account_id`. Owner-read-only RLS via `businesses`. |
| `solicitation_visits` | Append-only visit ledger, unique on `(contact_id, visit_date)` (migration 086) — re-uploads are idempotent by construction. Composite FK to `solicitation_contacts (id, business_id)` enforces same-location integrity. Owner-read-only RLS via `businesses`. |
| `solicitation_batches` | Evaluated Solicitation cohort + lifecycle parent (migration 088). One row per source upload; `built_at IS NULL` is pending construction and is hidden by owner RLS. |
| `solicitation_asks` | Authoritative per-candidate send/withhold decisions (migration 088). Child run is attribution only; `agent_run_id ON DELETE SET NULL` preserves asks through run archival. |

## Response Status Values

`'pending_approval'` | `'approved'` | `'edited'` | `'superseded'` |
`'awaiting_owner_connect'` | `'posted'` | `'failed'`

- **`superseded`** — terminal. Owner requested regeneration; this draft was
  replaced. At most one non-terminal response per review at any time.
- **`awaiting_owner_connect`** — non-terminal. Approved but cannot post because
  the business has no active Zernio connection. `DrainOwnerConnectWorker` flips
  these back to `approved` on successful (re)connect.

## Business Subscription Lifecycle

`'pending_payment'` (default) → `'trialing'` (card-up-front trial) → `'active'`
→ `'past_due'` | `'cancelled'`
(or `'pending_payment'` → `'active'` directly for pay-now / non-trial.)

Stripe `checkout.session.completed` transitions to `active` (pay-now) or
`trialing` (when the Checkout Session carried `subscription_data.trial_period_days`
and Stripe returns the subscription `status='trialing'`). Conversion
`trialing → active` happens via `customer.subscription.updated`/`invoice.paid`
only when the retrieved Stripe status is `active` (the $0 trial-start invoice does
NOT convert). DB status is a projection written by ONE applier
(`applyStripeSubscriptionState`, `worker/ingress/stripe/apply-subscription-state.ts`)
and backstopped by the billing reconcile poller, which has scoped corrective
authority for stuck `trialing` rows. Invariant: `trial_ends_at IS NOT NULL ⟺
status='trialing'`.

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

### 4. No `accounts.base_price_cents` — base price is not grandfathered (RESOLVED, migration 054 / PR #157)
> **RESOLVED (2026-05-29, migration 054, PR #157 — 2026-05 launch-audit item):**
> `accounts.base_price_cents` now exists (backfilled per current tier, `NOT NULL`,
> non-negative CHECK). `currentBillingSnapshot`, `monthlyMrrCents`, and
> `expectedInvoiceForAccount` read the **stored** column instead of live
> `TIER_CONFIG[tier].baseCents`, so the founders "rate locked for life" base no
> longer drifts when a tier's price changes. Closes CLAUDE.md #9a's lone un-stored
> exception. The original deferred-fix writeup below is retained for history.

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
- ~~Admin **SMS** still locks per business (`withMobileEnrollmentLock`) and prechecks cross-channel by `business_id`~~ — **MOOT: SMS removed (migration 061, 2026-06-09).**
- **Dispatcher** failure-handling writes (`worker/jobs/notification/dispatch.ts`)
  flip enrollment status by `business_id = ctx.businessId` — can miss the org-default
  row on multi-location.
- Admin per-business **status read** (`admin/businesses/[id]/channels`) lists by
  `business_id` — display-only mismatch.

Design: `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`.
