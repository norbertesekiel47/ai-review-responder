# Owner Offboarding — v1 Design Spec

_Status: approved for implementation (v1). Converged via brainstorming from the
grilled + Codex-approved plan at `~/.claude/grill-codex/20260605-214141/PLAN.md`._
_Date: 2026-06-05._

> **This spec is the v1 scope.** It is specced and queued, not yet coded.
> Deferred capabilities and their execution order live in `PLAN.md`
> ("v1 vs future versions").

## Goal

Give an account owner a single, safe, durable way to stop using RepWorth, in two
explicit modes, with no half-states and a precise data-deletion promise. v1
delivers owner-initiated offboarding behind a server-authoritative flag.

### v1 scope (in)

- **`cancel_only`** — schedule Stripe `cancel_at_period_end`, keep full normal
  access until period end, allow same-subscription reactivation; at access-end
  run teardown and land `churned` (data retained).
- **`delete_data`** — immediate teardown (cancel billing, revoke Zernio/Google,
  archive locations now), schedule purge at +30 days, allow keep-my-data (cancels
  the purge only); land `purged`, or `churned` if kept.
- The `account_offboardings` lifecycle record + 8-status machine.
- A single guard module wired across all owner write / worker / connect surfaces.
- Snapshot-driven shared teardown worker; staged, resumable purge.
- A code-owned, test-enforced table-disposition inventory.
- Minimal admin visibility for stuck offboardings + provider-disposition override.

### Out of v1 (deferred — see `PLAN.md` for the phased backlog)

`stop_now`; `cancel→delete` escalation; dunning/webhook-origin offboarding; rich
read-only churn dashboard; self-serve data export; admin-initiated
deletion/reactivation; automatic deletion of churned accounts; per-location
erasure.

### Honest data-deletion promise

Product copy must not promise absolute deletion. RepWorth deletes or anonymizes
review, response, business, and contact data after the waiting period, while
limited billing, security, and compliance records may be retained where required,
stripped of personal content where possible.

## Data model

Do not overload `subscription_status` (keep `pending_payment|active|past_due|cancelled`).
Model offboarding separately.

### `account_offboardings` (migration 056; current head is 055) — deny-all / service-only RLS

- **Identity:** `id` (uuidv7), `account_id` FK, `mode` (`cancel_only|delete_data`),
  `system_origin` (`owner` only in v1; column kept for future origins).
- **State:** `status` (8-enum, below), `failed_step` (`billing|teardown|purge`,
  null unless `status='failed'`), `terminal_at` (set only for
  `purged|churned|reactivated`).
- **Lifecycle stamps:** `requested_at`, `access_ends_at` (cancel_only, from Stripe
  `current_period_end`), `billing_cancel_confirmed_at`, `teardown_started_at`,
  `teardown_completed_at` (derived), `purge_after` (delete_data),
  `purge_started_at`, `purged_at`, `purge_cancelled_at`, `reactivated_at`.
- **Snapshot (captured in the confirm tx, before any external call):**
  `stripe_customer_id`, `stripe_subscription_id`, `zernio_account_ids[]`,
  `zernio_profile_ids[]`, `location_ids[]`, `auth_user_id`. Workers act only on
  the snapshot, never on live mutable account/provider fields. If snapshot capture
  fails or is incomplete, abort owner confirmation before inserting the row;
  return a support-oriented error and alert internally.
- **Per-step teardown outcomes:** `stripe_step`, `zernio_accounts_step`,
  `zernio_profiles_step`, `location_archival_step`, `job_terminalization_step` —
  each `success|failed|not_applicable`; plus `retry_count`, `last_error`
  (scrubbed). `teardown_completed_at` is stamped only when all required steps are
  `success`/`not_applicable`; never optimistically.
- **Transient:** `recipient_email` (stored only while lifecycle emails are
  pending; nulled once the final lifecycle email for the row is delivered — the
  email worker nulls it after sending a terminal-state email, and the purge
  terminal scrub always nulls it. It cannot be nulled synchronously at
  `terminal_at` because the cancel_only access-end and reactivation emails are
  enqueued in the same transaction that stamps `terminal_at` and still need the
  recipient to send). `feedback_reason_code` is deferred until
  the confirm route defines the canonical predefined code set; v1 still forbids
  free-text feedback to avoid a PII-scrub surface.
- **Indexes:** `UNIQUE (account_id) WHERE terminal_at IS NULL` (one active
  offboarding per account); partial index on `purge_after WHERE
  status='purge_scheduled'`; partial index on `access_ends_at WHERE
  status='scheduled'`.

`terminal_at` is the concurrency/uniqueness marker; `status` is the
human-readable outcome. Code + tests enforce consistency: terminal statuses
require `terminal_at`; non-terminal rows must not have it. Ordinary failures stay
non-terminal (`status='failed'`, `terminal_at NULL`) so no duplicate offboarding
can start on unresolved work.

### `account_offboarding_tokens` (same migration) — deny-all / service-only RLS

Approval-security pattern: `id`, `account_offboarding_id` FK, `token_hash`
(SHA-256), `token_type='keep_my_data'`, `expires_at` (≤ `purge_after`),
`consumed_at`, `revoked_at`, audit metadata. Raw token exists only in memory + the
sent email. Revoked when `purge_started_at` stamps. Keep-my-data is the only
tokenized action; cancel and reactivation require an authenticated owner session.

### 8-status machine

| Status | Mode | Terminal | Meaning |
|---|---|---|---|
| `pending` | both | no | row created, first async work enqueued (pre-Stripe) |
| `scheduled` | cancel_only | no | `cancel_at_period_end` set, access active, riding to period end |
| `tearing_down` | both | no | teardown executing (delete_data immediate; cancel_only at access-end) |
| `purge_scheduled` | delete_data | no | teardown done, awaiting `purge_after` |
| `purged` | delete_data | **yes** | erased |
| `churned` | both | **yes** | data retained, account inactive |
| `reactivated` | cancel_only | **yes** | pre-teardown reversal; account active again |
| `failed` | both | no | any failed step; `failed_step` says which |

Paths: `pending → scheduled → tearing_down → churned|reactivated` (cancel_only);
`pending → tearing_down → purge_scheduled → purged`, or `→ churned` via
keep-my-data (delete_data).

## The guard gate

A single cohesive module `src/lib/account-offboarding/gate.ts` owns the policy
(a deep module, not scattered helpers):

- `getOffboardingState(accountId)` — loads the active row (or null), per-request cached.
- Intent checks: `isProcessingBlocked`, `isBillingMutationBlocked`,
  `isConnectBlocked`, `isOperationalUIBlocked`, `canReactivate`, `purgeEligible`.

Policy:

- `delete_data` (any non-terminal): processing, approval callbacks,
  notifications, publishing, checkout, connect, billing mutations **all blocked**;
  operational UI hidden (status page only).
- `cancel_only scheduled` (paid-through access): normal product behavior; block
  only billing-expanding mutations (tier change, add-location — even within quota).
- Once `tearing_down`+: full block.
- Offboarding's own status / keep-my-data / reactivation routes are **explicit
  exceptions** to the "cancelled account cannot write" guards — they authorize
  through dedicated offboarding guards, never `requireWritableOwner`.

Integration points to wire: `requireWritableOwner`;
`assertWritableSubscriptionFor{Account,Business}`; billing checkout / tier-change
/ portal routes; Zernio connect start/select/finalize; approval
token/session/callback routes; dashboard review-action + past-replies
publish/restore/retry; worker subscription guards + publisher/notification/
generator entry points; location add/archive/reactivate/promote; auto-approval
settings; admin impersonation start.

Owner POST actions (confirm, keep-my-data, reactivation) carry an
`Idempotency-Key`; row locks + the unique index remain the source of truth for
double-click/retry safety. Deadlines display from server-owned UTC timestamps in
the account timezone ("scheduled for [date/time]").

## Flows

### `cancel_only`

1. **Confirm route** — owner auth + `withSameOrigin` (no fresh re-auth). One tx:
   lock account, assert no active offboarding, insert `status='pending'`, capture
   snapshot, write audit, enqueue billing-schedule + confirmation-email outbox
   rows. Returns immediately. Optional reason code (non-blocking).
2. **Billing-schedule worker** — set Stripe `cancel_at_period_end=true` on the
   snapshot subscription → set `access_ends_at` from `current_period_end`,
   `status='scheduled'`, `billing_cancel_confirmed_at`, `stripe_step=success`.
   Missing/malformed `current_period_end` → keep "in progress", alert/retry, do
   not guess locally. Failure → `failed`/`billing`, BullMQ retry.
3. **During `scheduled`** — normal behavior; only billing-expanding mutations
   blocked. UI shows access-end date + reactivation CTA.
4. **Reactivation (pre-teardown)** — lock row, require `teardown_started_at IS
   NULL`, reverse `cancel_at_period_end` on the same subscription → `reactivated`,
   `terminal_at`. If Stripe can't reverse the same subscription, fall through to
   checkout (post-teardown reactivation via existing signup/reconnect path; do not
   reopen the old row). Exactly one of {reactivation, teardown} wins the row.
5. **Access-end poller** — claims `status='scheduled' AND access_ends_at<=now` via
   `FOR UPDATE SKIP LOCKED`, revalidates, sets `tearing_down`, enqueues teardown.
6. Teardown done → `churned`, `terminal_at`; enqueue access-end/churn email.

### `delete_data`

1. **Confirm route** — owner auth + `withSameOrigin` + **fresh re-auth + AAL2 if
   MFA enrolled** + type-to-confirm. Copy explains immediate processing stop,
   billing/Google teardown, 30-day purge window, retained-data exceptions, and
   lack of self-serve export (direct to support for records). One tx: lock
   account, assert no active offboarding, insert `status='pending'`, capture
   snapshot, set `purge_after=now+30d`, mark `zernio_connections` disconnected
   (**mark-then-call** so the inbound webhook is a no-op), write audit, enqueue
   teardown + confirmation-email (with keep-my-data link). Operational UI hidden
   immediately; keep the current session usable for offboarding status +
   keep-my-data.
2. **Teardown worker (immediate)** — see Shared teardown; → `purge_scheduled`.
3. **Keep-my-data** — authed banner (owner + same-origin) or hashed single-use
   token; lock row, require `purge_started_at IS NULL`, set `purge_cancelled_at`;
   once teardown complete → `churned`. Does not restore product access
   (re-subscribe + reconnect required).
4. **Purge poller** → `purged` (see Purge model).

## Shared teardown worker

Both modes converge here — `delete_data` immediately, `cancel_only` at
access-end. Snapshot-driven only; each step idempotent + stamped:

1. **Stripe** — cancel the snapshot subscription (`prorate:false`; list + void
   finalized open/uncollectible invoices, handle draft invoices per Stripe API
   constraints — a **required pre-implementation spike/test**, not a best-effort
   detail). For `cancel_only` at access-end, verify the natural cancellation.
2. **Zernio** — delete account ids + profile ids; classify 404/410 as idempotent
   success; empty snapshot lists → `not_applicable`.
3. **Location archival** — archive all snapshot locations (reuse the
   `archive-location-tx` pattern).
4. **Job terminalization** — terminalize eligible pending `job_outbox` rows for
   the account so stale publishes/notifications cannot fire later; worker guards
   remain the backstop for already-running/dispatched jobs.

Completion derived when all required steps are `success`/`not_applicable` →
`cancel_only`: `churned`; `delete_data`: `purge_scheduled`. Failure = throw →
BullMQ retry/backoff; terminal exhaustion → `failed` + `failed_step` + scrubbed
`last_error` + ops alert.

**Stripe webhooks** are subscription-scoped: ignore `customer.subscription.*`
events whose subscription id does not match `accounts.stripe_subscription_id` or
the active offboarding snapshot, so a stale old-subscription webhook after
reactivation cannot clobber a new subscription under the same customer. Inbound
Zernio `account.disconnected` during an active teardown reconciles/stamps the
Zernio step; otherwise the existing connection-lost path runs.

## Purge model (`delete_data` only)

Staged, resumable, short transactions, no locks across external calls, durable
stage stamps. Production timing fixed at 30 days; a **server-only non-production
override** shortens the window for end-to-end verification (never a public/browser
flag).

1. **Claim** — lock row; require `purge_cancelled_at IS NULL`, `purge_after<=now`,
   and teardown complete (or admin-recorded provider disposition); set
   `purge_started_at` (status stays `purge_scheduled` — there is no `purging`
   status in the 8-status machine; `purge_started_at IS NOT NULL` is the
   in-progress marker); revoke keep-my-data tokens.
2. Clear app-auth binding and revoke/sign out sessions (Supabase tokens may remain
   valid until expiry, so guards must not rely on sign-out alone).
3. **Auth-user delete** — short tx revalidates the `users` row: `auth_id` still
   equals the captured `auth_user_id`, `account_id` still the offboarded account,
   and no other active account/membership binding (fail closed if a future
   multi-account model exists). Call `deleteUser()` outside DB locks; treat
   not-found as success only after revalidation passes.
4. Null/delete dependent refs before content (`api_costs.response_id`,
   `notification_deliveries.response_id`).
5. Scrub/delete content per the inventory (reviews, responses, approval-links,
   notifications, channels, demos, exceptions).
6. Redact account-related raw payloads in `inbound_events` + `job_outbox`;
   terminalize any remaining account jobs.
7. Scrub analytics identifiers/properties (`distinct_id`, `anonymous_id`,
   `properties`, `last_error`, FK columns).
8. Scrub SMS opt-out data to minimal keyed-hash suppression/compliance records.
   If raw phone retention is legally required, document and disclose it.
9. Purge Google/Zernio provider identifiers from deleted account records.
10. Scrub audit + cost records to deletion-safe allowlisted shapes (including
    `api_costs.output_excerpt`).
11. **Tombstone** parents (`accounts`, `users`, `businesses`) with deterministic
    non-PII values for NOT NULL/unique columns; null `stripe_customer_id` (no raw
    id on a de-identified record).
12. **Final verification queries generated from the inventory** — stamp
    `purged_at` only when every account-linked table is empty for the account,
    scrubbed to the approved shape, or explicitly retained under a
    compliance-limited disposition.
13. Scrub terminal `account_offboardings` fields (`recipient_email`, raw ids,
    `auth_user_id` after auth deletion succeeds), enqueue the generic receipt →
    `purged`, `terminal_at`.

**Admin override** cannot blind force-purge. It must record concrete provider
disposition (provider, resource type/id or scrubbed reference, admin actor,
reason, timestamp, optional ticket) before a blocked purge can be
force-terminalized.

## Table-disposition inventory

A code-owned deliverable: `src/lib/account-offboarding/table-disposition.ts` +
tests, reconciled against `scripts/ci/tenant-tables.ts` (`TENANT_TABLES`) **plus**
explicit payload/control tables not fully captured by the tenant-scope audit
(`inbound_events`, `job_outbox`, `analytics_events`, `flagged_responses`,
`impersonation_sessions`, and any future account-linked tables).

Every account-linked table is classified as exactly one of: `hard delete` ·
`scrub in place` · `retain de-identified` · `retain compliance-limited PII` ·
`not applicable (+reason)`. The inventory test **fails if any tenant/account-linked
table is unclassified**; the purge-completion test reuses the inventory to verify
no raw account-linked content remains before `purged_at`.

Minimum tables to classify (all verified to exist): `accounts`, `businesses`,
`users`, `reviews`, `responses`, `approval_links`, `approval_audit_log`,
`account_audit_log`, `notification_deliveries`, `channel_enrollments`,
`zernio_connections`, `zernio_finalize_incidents`, `zernio_backfill_runs`,
`weekly_summaries`, `monthly_impact_emails`, `review_exceptions`,
`ranking_snapshots`, `onboarding_drip_log`, `onboarding_demos`,
`satisfaction_responses`, `auto_approval_policies`, `api_costs`,
`api_costs_daily_rollups`, `analytics_events`, `inbound_events`, `job_outbox`,
`sms_sender_opt_outs`, `sms_sender_opt_out_events`, `flagged_responses`,
`impersonation_sessions`, `google_connections`, `prospect_demos`.

## CancellationGracePoller reconciliation (v1)

Offboarding owns owner-initiated cancellation archival. `CancellationGracePoller`
keeps owning involuntary/dunning/external cancellations, but is **gated to skip
any account with an active or terminal `account_offboardings` row** so the two
never double-archive on different clocks. No webhook-origin offboarding creation
in v1. While the offboarding flag is dark, `CancellationGracePoller` is unchanged.

## Emails, analytics, audit

- **Emails** — dedicated `account_offboarding_email` topic/queue/worker (NOT
  `OwnerEmailWorker`, which depends on business rows and blocks cancelled
  accounts), keyed by `account_offboarding_id`, recipient from `recipient_email`,
  deduped by `account_offboarding_id + email_type`. v1 set: cancel_only
  confirmation/access-end · cancel_only reactivation confirmation · delete_data
  confirmation (keep-my-data link) · delete_data T-3d reminder · generic
  post-purge receipt (purge date + support only — no business names, locations,
  review counts, or ids).
- **Analytics** — server-side only, durable: `offboarding_started`,
  `offboarding_reactivated`, `offboarding_teardown_completed`,
  `offboarding_purged`. Identifiers/properties scrubbed at purge.
- **Audit** — `account_audit_log` events written in the same tx as each state
  change: requested · Stripe cancellation scheduled · reactivation ·
  keep-my-data/purge cancelled · teardown completed · purge started · purge
  completed · admin provider disposition. Purge scrubs payloads to an allowlisted
  deletion-safe shape.

## Feature flag, migrations, rollout, launch gate

- Server-authoritative env flag `ACCOUNT_OFFBOARDING_ENABLED` (the
  `AUTO_APPROVAL_ENABLED` pattern). **No `NEXT_PUBLIC_*` companion** — browser
  learns state via server responses (`ci:static-policy` enforces this).
- Owner routes/workers gated until the staging dry-run passes; schema, inventory,
  gate, admin visibility, and tests may land before the flag is enabled.
- **Migrations staging-first across BOTH Supabase projects in lockstep** —
  migration 056 (`account_offboardings` + `account_offboarding_tokens` + RLS +
  indexes); migration 057 only if a column needs nullability for tombstoning
  (migrate-nullable vs deterministic-tombstone decided per column).
- **Launch gate (non-code, required before enabling the production flag):** a
  non-refundable clause covering mid-cycle `delete_data` in the Terms of Service,
  plus the point-of-action forfeiture disclosure copy, reviewed for the
  jurisdictions RepWorth sells into.

## Staged PR sequence

Each PR lands behind the dark flag, is mergeable to `main`, and is CI-green.

1. Schema 056 + table-disposition inventory module + tests + no-op gate module +
   service-only/RLS/static-policy tests for the two new tables.
2. `cancel_only` route/UI + billing-schedule worker + same-subscription
   reactivation + remove Stripe Customer Portal self-serve cancellation.
3. Gate wired into all integration points + guard-off behavior + status page.
4. `delete_data` route/UI + fresh re-auth/AAL2 + keep-my-data tokens +
   mark-then-call.
5. Stripe invoice spike/test + shared teardown worker + Zernio teardown +
   subscription-scoped webhook reconciliation + CancellationGracePoller gating.
6. Purge poller (staged + auth-delete revalidation) + admin stuck-offboarding
   visibility + provider disposition.
7. End-to-end hardening + staging dry-run runbook + production flag enablement
   (gated on the launch gate).

## Test / verification contract

- migration-structure tests: RLS, indexes, partial uniqueness on `terminal_at IS NULL`
- deny-all RLS + static/client-access tests proving browser code cannot read or
  mutate `account_offboardings` / `account_offboarding_tokens` (`ci:static-policy`
  extended to both tables)
- table-disposition inventory test (fails on any unclassified account-linked table)
- route tests: both modes, fresh re-auth (delete_data), reactivation,
  keep-my-data, guard behavior, idempotency
- worker tests: Stripe schedule/cancel, teardown idempotency, Zernio 404/410,
  dedicated email dedup, job terminalization, purge stages
- explicit Stripe invoice behavior spike/test before claiming delete_data invoice
  cleanup semantics
- Stripe webhook tests: subscription-scoped reconciliation + stale old-sub ignore
- approval-callback tests for blocked/deleted accounts
- CancellationGracePoller reconciliation test (skips offboarding accounts; no
  double-archival)
- edge-account coverage: `pending_payment`/never-activated and trial/`past_due`
  accounts choosing offboarding stamp absent steps `not_applicable` and never hang
  teardown completion
- staging dry-run with a test account covering `cancel_only`, pre-teardown
  reactivation, `delete_data`, keep-my-data, and purge (with the server-only
  shortened window), recorded in the runbook
- server-only feature-flag tests (routes/workers disabled until enabled; no
  `NEXT_PUBLIC_*` companion)
- the four CI audits green: `ci:tenant-scope`, `ci:rls-audit`,
  `ci:analytics-events`, `ci:static-policy`
- `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm build`
