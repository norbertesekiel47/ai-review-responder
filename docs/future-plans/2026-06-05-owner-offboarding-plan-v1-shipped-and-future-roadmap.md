# Plan: Owner offboarding for RepWorth
_Revised after Claude + Norbert grill and Codex adversarial review._

> ✅ **STATUS — v1 DONE (2026-06-09).** Implemented across the 7-PR sequence,
> staging-dry-run-tested (3 launch-blockers D1/D2/D3 found + fixed), live-E2E-verified
> on staging via Chrome DevTools, and **merged to `main` flag-OFF** (feature PR #244 +
> fix PR #245; `main` commit `22ba46c2`). `ACCOUNT_OFFBOARDING_ENABLED` stays unset in
> production pending the legal launch gate (ToS non-refundable mid-cycle clause +
> forfeiture disclosure). The **v2–v5 roadmap** at the bottom of this file is the
> future-improvement backlog.

## Goal

Give an account owner a single, safe, durable, user-friendly way to stop using
RepWorth. Offboarding must be convenient for the owner, protect RepWorth from
half-states, and keep the data-deletion promise precise.

The UX has two explicit choices:

1. **Cancel service, keep my data** (`mode='cancel_only'`)
   - Cancel renewal through RepWorth, not through Stripe Customer Portal.
   - Keep normal product access until the paid-through `access_ends_at`, unless
     the owner chooses "stop now."
   - Keep Google/Zernio connected and processing active until access ends.
   - Allow reactivation before teardown starts, preserving the existing Google
     connection.
   - After access ends, archive locations and run teardown.

2. **Close account and delete my data** (`mode='delete_data'`)
   - Stop processing immediately.
   - Cancel billing and revoke Google/Zernio immediately.
   - Archive all locations immediately at teardown-start.
   - Schedule a purge after 30 days.
   - In production, the purge window is fixed at 30 days. Local/staging may use a
     server-only override to shorten the window for end-to-end verification.
   - Allow "keep my data" during the purge window, but only to cancel the
     purge. Billing/Zernio teardown remains irreversible once confirmed.

Do not promise absolute deletion. Product copy must say RepWorth deletes or
anonymizes review, response, business, and contact data after the waiting
period, while limited billing, security, and compliance records may be retained
where required, stripped of personal content where possible.

## Core data model: `account_offboardings`

Do not overload `subscription_status`. Keep the existing status contract
(`pending_payment|active|past_due|cancelled`) and model offboarding separately.

Create `account_offboardings`, service-only / deny-all RLS, one active blocking
row per account across both modes. The active uniqueness rule must include any
row that can still block behavior or complete work, including `cancelled`
keep-my-data rows whose teardown is not complete. Confirm routes must lock and
inspect existing rows before insert; the partial unique index is the backstop,
not the primary race-control mechanism.

Use a `terminal_at` column to represent "no offboarding work remains." The
active partial unique index should be `UNIQUE (account_id) WHERE terminal_at IS
NULL`, rather than encoding every intermediate status in the predicate.
Keep both `status` and `terminal_at`: `terminal_at` is the concurrency/indexing
marker, while `status` records the human-readable lifecycle outcome. Code and
tests must enforce consistency: terminal statuses require `terminal_at`, and
nonterminal rows must not have it.
Ordinary failures stay nonterminal with `terminal_at NULL` so duplicate
offboardings cannot start while work is unresolved. Prefer statuses like
`billing_failed`, `teardown_failed`, or `purge_blocked`. A terminal failure
requires an explicit admin final disposition and should be rare.

### Required columns

- `id`, `account_id`, `mode` (`cancel_only|delete_data`), `system_origin`
  (`owner|stripe_webhook|admin|system`).
- Lifecycle status, for example:
  `requested`, `billing_pending`, `access_active`, `teardown_pending`,
  `tearing_down`, `teardown_complete`, `purge_pending`, `purging`, `purged`,
  `cancelled`, `reactivated`, `billing_failed`, `teardown_failed`,
  `purge_blocked`, `terminal_failed`.
- Timestamps:
  `requested_at`, `billing_cancel_requested_at`,
  `billing_cancel_confirmed_at`, `access_ends_at`, `stop_now_at`,
  `teardown_started_at`, `teardown_completed_at`, `purge_after`,
  `purge_started_at`, `purged_at`, `purge_cancelled_at`, `reactivated_at`,
  `terminal_at`.
- Snapshot fields captured at confirmation:
  `stripe_customer_id`, `stripe_subscription_id`, `zernio_account_ids`,
  `zernio_profile_ids`, `location_ids`, `auth_user_id`.
  Capture these in the same transaction that creates the active offboarding row,
  before any external calls happen. External workers must act on the snapshot,
  never on live mutable account/provider fields.
  If required snapshot capture fails or is incomplete, abort owner confirmation
  before creating the offboarding row. Return a clear support-oriented error and
  alert/log internally; do not create partial deletion/teardown snapshots.
- Active lifecycle email field:
  `recipient_email`. This may be stored only while lifecycle emails are pending
  and must be nulled at terminal completion.
- Feedback:
  predefined `feedback_reason_code`, optional `feedback_text`.
  For `delete_data`, free-form feedback is scrubbed at purge. Reason codes may
  remain as aggregate-safe product signals.
- Observability:
  per-step stamps for Stripe, Zernio accounts, Zernio profiles, location
  archival, job terminalization, auth deletion, raw-payload redaction,
  analytics scrub, parent tombstones, retry counts, terminal error fields, and
  admin provider-disposition flags.
- Teardown step outcomes must be explicit: `success`, `failed`, or
  `not_applicable`. Missing snapshot resources, absent subscriptions, already
  archived locations, or already-deleted provider resources should stamp
  `not_applicable`/idempotent success rather than leaving completion fields null.
  Store `teardown_completed_at` for query/UI convenience, but derive whether
  teardown is complete from all required per-step outcomes before stamping it.
  Never set it optimistically.

### Retention of the offboarding row

Retain terminal `account_offboardings` rows as scrubbed control/audit records.
At terminal completion, scrub `recipient_email`, raw Stripe/Zernio/Profile IDs,
raw provider errors, `auth_user_id` after auth deletion succeeds, and any
free-form PII-bearing fields.

For deleted accounts, do not keep raw `accounts.stripe_customer_id` on the
tombstoned account if retained records are described as de-identified. Keep only
internal ledger facts or a non-reversible digest if reconciliation truly needs
one.

## Derived guards

Add shared helpers rather than scattering ad hoc SQL:

- `hasActiveOffboarding(accountId)`
- `processingBlocked(accountId)`
- `billingMutationBlocked(accountId)`
- `connectBlocked(accountId)`
- `teardownBlocking(accountId)`
- `purgeEligible(accountId)`
- explicit offboarding action guards for status, keep-my-data, reactivation,
  stop-now, and escalation

Guard behavior:

- `delete_data`: processing, approval callbacks, notifications, publishing,
  checkout, Zernio connect, and billing mutations block immediately. Archive all
  locations at teardown-start so selectors, dashboards, and worker queries
  converge on "not operational" before purge.
- `cancel_only` during paid-through access: normal product behavior continues,
  including approvals, edits, notifications, review processing, and Google
  posting.
- `cancel_only` during paid-through access blocks billing-expanding mutations:
  tier changes, add-location, and any Stripe-affecting account expansion.
- All location adds are blocked during `cancel_only`, even within included
  quota.
- At `access_ends_at` or "stop now," `cancel_only` transitions to processing
  blocked, approval-link revocation, job terminalization, location archival,
  and teardown.
- During scheduled `cancel_only`, suppress non-essential growth/engagement
  emails, but keep operational review-response notifications active until access
  ends.
- After `delete_data` confirmation, suppress all outbound notifications except
  offboarding lifecycle emails.
- Offboarding status and action routes are intentional exceptions to broad
  "cancelled account cannot write" guards. They must not use generic writable
  owner helpers; authorize each action through dedicated offboarding guards.
- Block admin impersonation/session start for accounts in `delete_data` or
  post-access `cancel_only`; use admin offboarding views instead.

Must cover at least:

- `assertWritableSubscriptionForAccount` and `assertWritableSubscriptionForBusiness`
- `requireWritableOwner`
- billing checkout, tier-change, and billing portal routes
- Zernio connect start/select/finalize routes
- approval token/session/callback routes
- dashboard review action routes and past-replies publish/restore/retry routes
- worker subscription guards and publisher/notification/generator entry points
- location add/archive/reactivate/promote routes
- auto-approval settings
- admin impersonation start/session routes

## UX and routes

Settings/offboarding UI presents two choices:

Owner-facing entry points and offboarding workers ship behind a
server-authoritative feature flag until the staging dry run passes. Schema,
admin visibility, helpers, and tests may land before the flag is enabled. Do not
add a `NEXT_PUBLIC_*` companion flag; expose any enabled/disabled state through
server responses only.

Offboarding is account-scoped for v1. Both choices apply to the whole billing
account and all locations. The UI must state this clearly and list affected
locations before confirmation. Per-location deletion/offboarding remains out of
scope and continues through existing archival paths.

Only the billing/account owner can self-serve `cancel_only`, `stop_now`,
escalation to `delete_data`, keep-my-data, and reactivation. Non-owner team
members may see offboarding status where relevant but must not see mutation
controls.

1. **Cancel service, keep my data**
   - Optional reason code and optional feedback text, non-blocking.
   - Owner auth + same-origin CSRF.
   - Does not require fresh re-auth unless the owner chooses "stop now."
   - Cancellation feedback failure must never block cancellation.
   - Show honest state: "billing cancellation in progress" until Stripe confirms.
   - During paid-through access, show access end date and reactivation CTA.
   - After access ends, show a narrower read-only churn dashboard: affected
     businesses/locations, high-level review/response history, billing/offboarding
     state, and reactivate/reconnect CTAs. Do not show operational queues,
     approval/edit/publish controls, or settings that imply processing is active.
     Post-teardown reactivation must use the existing checkout/signup/reconnect
     path with fresh Stripe/Zernio resources. Do not reopen the old offboarding
     row or reuse old teardown snapshots.

2. **Close account and delete my data**
   - Fresh re-auth required before confirmation.
   - If MFA is enrolled, require current AAL2.
   - Type-to-confirm destructive modal.
   - Same-origin CSRF.
   - Copy must explain immediate processing stop, billing/Google teardown,
     30-day purge window, retained-data exceptions, and lack of self-serve data
     export in v1. If the owner needs records before deletion, direct them to
     support.
   - After confirmation, keep the current session usable for offboarding status
     and keep-my-data. Product actions are blocked by server-side offboarding
     guards. Revoke/expire other sessions where practical, but do not rely on
     session revocation for enforcement.
   - After confirmation, hide operational dashboards and show only offboarding
     status. Do not show full historical reviews/responses during the purge
     window; keep-my-data restores retained historical access if selected before
     purge starts.

Escalation/downgrade:

- `cancel_only` can escalate to `delete_data` during paid-through access with
  fresh re-auth. Set `access_ends_at=now()`, start teardown now, set
  `purge_after=now()+30 days`.
- `delete_data` can downgrade via "keep my data" during the purge window.
  This cancels purge and changes the outcome to retained-data churn, but does
  not undo billing/Zernio teardown. Keep the offboarding row active with
  `terminal_at NULL` until teardown has completed; once teardown is complete and
  no purge remains, terminalize it as retained-data churn. Keep-my-data does not
  restore product access; access remains churned/offboarded until the owner
  completes reactivation/checkout/reconnect.
- Destructive actions require fresh re-auth: `delete_data`, `cancel_only stop_now`,
  and escalation from `cancel_only` to `delete_data`.

Owner POST actions that create or mutate offboarding state should accept an
`Idempotency-Key` header: confirm, stop-now, escalation, keep-my-data, and
reactivation. Store or audit the key with the action. The key is advisory; row
locks plus `UNIQUE (account_id) WHERE terminal_at IS NULL` remain the source of
truth for double-click/retry safety.

Deadline display must come from server-owned UTC timestamps. The UI should show
exact access-end and purge timestamps in the account's timezone, using
server-calculated dates or explicit timezone metadata rather than client-side
deadline guessing. Once confirmed, copy should say "scheduled for [date/time]"
instead of only "in 30 days."

## Dedicated lifecycle emails

Do not use the existing `OwnerEmailWorker`; it depends on business rows and
blocks cancelled accounts.

Add a dedicated `account_offboarding_email` outbox topic/queue/worker keyed by
`account_offboarding_id`, with recipient from `account_offboardings.recipient_email`.

Emails:

- cancel-only confirmation / access-end notice
- cancel-only reactivation confirmation if applicable
- delete-data confirmation with keep-my-data link
- delete-data reminder about 3 days before `purge_after`
- generic post-purge receipt after successful purge

Deduplicate lifecycle email delivery by `account_offboarding_id + email_type`,
separate from general outbox idempotency. Poller retries may enqueue only the
missing email type; worker retries may resend only when the prior delivery did
not succeed. This is especially important for purge reminders and post-purge
receipts.

Post-purge receipt must be generic: purge completion date and support contact
only. Do not include business names, locations, review counts, Stripe IDs, or
retained ledger identifiers.

## Analytics

Capture offboarding analytics server-side only. Do not accept browser-posted
offboarding facts.

Suggested durable events:

- `offboarding_started`
- `offboarding_reactivated`
- `offboarding_escalated_to_delete`
- `offboarding_teardown_completed`
- `offboarding_purged`

For `delete_data`, scrub analytics identifiers and properties during purge,
retaining only aggregate-safe facts if needed.

## Audit logging

`account_offboardings` is the lifecycle/control record; `account_audit_log`
remains the account-wide audit trail. Write audit events in the same transaction
as their state change.

Required audit events include:

- owner offboarding requested
- Stripe cancellation schedule confirmed
- reactivation
- stop-now requested
- escalation from `cancel_only` to `delete_data`
- keep-my-data / purge cancelled
- teardown completed
- purge started
- purge completed
- admin provider disposition

For `delete_data`, purge must scrub audit payloads to an allowlisted
deletion-safe shape.

## Offboarding tokens

Do not reuse `approval_links` for keep-my-data links. Add a dedicated
`account_offboarding_tokens` table with deny-all RLS/service-only access.
In v1 these tokens are only for keep-my-data. Cancellation, reactivation, and
billing-affecting actions require an authenticated owner session.

Use the approval-security pattern:

- raw token exists only in memory and in the sent email
- store only SHA-256 token hashes
- token scope references `account_offboarding_id`
- include token type, TTL, consumed/revoked timestamps, and audit metadata
- email GET renders a read-only page only
- mutation is POST-only with token + CSRF, and single-use
- authenticated banner action uses owner session + same-origin instead
- keep-my-data token TTL must end no later than `purge_after`
- revoke all unconsumed keep-my-data tokens when `purge_started_at` is stamped
- POST handlers must re-check under lock that purge has not started before
  accepting keep-my-data

## Stripe behavior

Remove self-serve cancellation from Stripe Customer Portal configuration. Keep
the portal for invoice history and payment method updates.

`cancel_only`:

- Schedule cancellation at period end in Stripe.
- Keep `accounts.subscription_status='active'` during paid-through access. Set
  `cancelled` and stamp `cancelled_at` when access ends or stop-now teardown
  begins, before external teardown has necessarily completed.
- Do not locally mark the subscription cancelled until access actually ends.
- Set `access_ends_at` from Stripe's `current_period_end` on the subscription
  object. Stripe is the billing source of truth; if the value is missing or
  malformed, keep cancellation "in progress" and alert/retry instead of guessing
  locally.
- If Stripe scheduling fails, keep the account active, show "billing
  cancellation in progress," retry through the worker, and alert ops on
  terminal failure.
- Reactivation before teardown starts first attempts to undo
  `cancel_at_period_end` on the same active Stripe subscription, cancels the
  pending offboarding, and keeps the existing Zernio connection. If Stripe cannot
  reverse the same subscription or the subscription changed, fall back to checkout
  and treat it as post-teardown reactivation.
- Resolve the reactivation-vs-teardown-start race symmetrically to
  keep-my-data-vs-purge: the reactivation action must lock the offboarding row
  and require `teardown_started_at IS NULL` before reversing Stripe and
  terminalizing the row. If the access-end poller has already claimed the row and
  started teardown (it claims with `FOR UPDATE SKIP LOCKED` and revalidates under
  lock), reactivation fails closed and falls through to the post-teardown
  checkout/reconnect path. Exactly one of {reactivation, teardown} wins the row.
- Successful pre-teardown reactivation marks the offboarding terminal with
  `status='reactivated'` and `terminal_at=now()`. Future cancellation attempts
  create a new offboarding row with a fresh snapshot.

`delete_data` and `cancel_only stop_now`:

- Cancel the snapshot `stripe_subscription_id` immediately.
- Do not use live account subscription ids for teardown.
- Use idempotency keys scoped to offboarding id and step.
- `cancel_only stop_now` is self-serve but secondary/advanced in the UI, requires
  fresh re-auth, and does not automatically refund or credit unused paid time in
  v1. Link to support for billing exceptions.
- Invoice policy must be implementation-tested against current Stripe behavior:
  list invoices for the snapshot subscription, void finalized open/uncollectible
  invoices, and handle draft subscription invoices according to Stripe API
  constraints before claiming they are voided/deleted. Treat this as a required
  pre-implementation spike/test for the teardown worker, not a best-effort detail.

Stripe webhooks:

- `customer.subscription.deleted` and relevant `customer.subscription.updated`
  handling must be subscription-scoped. Ignore events whose subscription id does
  not match `accounts.stripe_subscription_id` or the active offboarding snapshot.
- External/manual Stripe cancellations create or reconcile a
  `system_origin='stripe_webhook'`, `mode='cancel_only'` offboarding, with
  owner notification and the same access-end teardown path.
- Stale old-subscription webhooks after reactivation must not clobber a new
  subscription under the same customer.

### Reconciliation with existing cancellation/dunning (`CancellationGracePoller`)

The offboarding lifecycle is the single owner of post-cancellation teardown and
location archival. It supersedes `CancellationGracePoller` and the ad hoc
`subscription.deleted` -> `cancelled` -> archive-after-30-days path. They must
never run on the same account on different clocks.

- While the offboarding feature flag is disabled, `CancellationGracePoller`
  remains authoritative and unchanged (offboarding ships dark first).
- Once the flag is enabled, route every cancellation through offboarding:
  - Owner-initiated cancel -> `cancel_only` offboarding.
  - External/Stripe-initiated cancellation, including involuntary
    dunning/`past_due` -> `customer.subscription.deleted`, reconciles into a
    `system_origin='stripe_webhook'`, `mode='cancel_only'` offboarding that owns
    archival at `access_ends_at`, with owner notification.
- During rollout, gate `CancellationGracePoller` to skip any account that has an
  active or terminal offboarding row, so the two never double-archive. After the
  flag is fully enabled and existing `cancelled` accounts are backfilled into
  offboarding rows (or explicitly grandfathered), retire the poller.
- Involuntary dunning lapses map to `cancel_only` (data preserved, reactivation
  possible), never `delete_data`. For an already-past-due cancellation set
  `access_ends_at` from the cancelled subscription's period end, not `now()`.
  **Decision to confirm before PR 5:** whether an involuntary lapse should revoke
  Zernio/Google at `access_ends_at` like a voluntary cancel (v1 default: yes,
  since reactivation reconnects) or hold the connection through a softer
  non-payment grace.

## Zernio/Google behavior

Teardown uses snapshot ids only:

- delete Zernio account ids
- delete Zernio profile ids
- classify 404/410 as idempotent success for deletion endpoints
- stamp per-resource success/failure
- stamp `not_applicable` for empty snapshot lists so teardown completion cannot
  hang on absent external resources

Inbound Zernio `account.disconnected` does not create an offboarding. If an
active offboarding teardown exists, reconcile/stamp the Zernio step. Otherwise
use the existing connection-lost path for active accounts.

For `delete_data`, revoke approval links and block approval callbacks
immediately with a terminal "account closing" response. For `cancel_only`, keep
links valid until access ends or stop-now teardown begins.

## Job terminalization

At the moment processing stops:

- `delete_data`: immediately on confirmation.
- `cancel_only`: at `access_ends_at` or stop-now.

Terminalize eligible pending account jobs in `job_outbox` so stale notifications,
publishes, and processing jobs do not fire later. Worker guards remain the
backstop for jobs already running, already dispatched, or re-dispatched by the
watchdog.

## Async orchestration

Use `job_outbox` for immediate async follow-up work and Postgres state-driven
pollers/schedulers for time-based transitions.

- Confirmation transactions insert outbox rows for immediate lifecycle email and
  immediate Stripe/Zernio work where applicable.
- Access-end teardown, reminder emails, and purge eligibility are driven by
  pollers over `account_offboardings.access_ends_at` and `purge_after`.
- Those pollers insert concrete worker/email outbox rows transactionally with
  their claim/update state changes.
- Pollers must claim eligible rows with `SELECT ... FOR UPDATE SKIP LOCKED`,
  revalidate predicates under the lock, stamp claim/status fields such as
  `teardown_claimed_at`, `purge_claimed_at`, or reminder-specific claim stamps,
  and insert idempotent outbox rows in the same short transaction.
- Do not rely on 30-day delayed BullMQ jobs; durable timing state belongs in
  Postgres.

## Purge model for `delete_data`

Purge is staged and resumable. Do not process the whole account in one long
transaction. Use short transactions, no locks across external calls, and durable
stage stamps.

Production purge timing is fixed at 30 days. Add a server-only non-production
configuration override for local/staging tests so end-to-end purge verification
does not require waiting a month. Never expose this as a browser/public feature
flag.

High-level stages:

1. Claim purge: lock offboarding row, require `purge_cancelled_at IS NULL`,
   `purge_after <= now()`, and teardown complete or admin-recorded provider
   disposition.
2. At purge claim, clear app-auth binding and revoke/sign out sessions where
   possible. Supabase access tokens may remain valid until expiry, so server
   guards must not rely only on sign-out.
3. Before deleting the Supabase Auth user, revalidate identity ownership in a
   short transaction: lock the `users` row, require its `auth_id` to still equal
   the captured `auth_user_id`, require its `account_id` to still be the
   offboarded account, and require no other active account/membership binding for
   that auth identity. If a future multi-account membership model exists, fail
   closed until this step is redesigned. Call `deleteUser()` outside DB locks.
   Treat not-found as success only after the ownership revalidation passed.
4. Null or delete dependent references before content deletion, including
   `api_costs.response_id` and `notification_deliveries.response_id`.
5. Scrub/delete review, response, approval-link, notification, channel, demo,
   and exception content according to the table-disposition inventory.
6. Redact/delete account-related raw payloads in `inbound_events` and
   `job_outbox`; terminalize any remaining account jobs.
7. Scrub analytics identifiers and properties, retaining only aggregate-safe
   event facts if needed.
8. Scrub SMS opt-out data to minimal suppression/compliance records, preferably
   keyed hashes. If raw phone retention is legally required, document and
   disclose it.
9. Purge Google/Zernio provider identifiers from deleted account records.
10. Scrub audit and cost records to deletion-safe allowlisted shapes.
11. Tombstone parent rows (`accounts`, `users`, `businesses`) with deterministic
    non-PII values for NOT NULL/unique columns.
12. Run final verification queries generated from the table-disposition inventory.
    Only stamp `purged_at` when every account-linked table is empty for that
    account, scrubbed to the approved shape, or explicitly retained under a
    compliance-limited disposition.
13. Scrub terminal `account_offboardings` fields and enqueue generic receipt.

Admin cannot blind force-purge. Admin override must record concrete external
resource disposition first, such as `stripe_manually_cancelled`,
`zernio_manually_revoked`, or `provider_unreachable_after_ops_review`.
The recorded disposition must include provider, resource type/id or scrubbed
reference, admin actor, reason, timestamp, and optional ticket/external reference
before a blocked purge can be force-terminalized.

## Table-disposition inventory

The disposition inventory is a code-owned deliverable, not prose only. Add a
module such as `src/lib/account-offboarding/table-disposition.ts` and tests that
compare it against:

- `scripts/ci/tenant-tables.ts`
- explicit payload/control tables not fully captured by tenant-scope audit:
  `inbound_events`, `job_outbox`, `analytics_events`, `flagged_responses`,
  `impersonation_sessions`, and any future account-linked tables.

Every table must be classified as one of:

- hard delete
- scrub in place
- retain de-identified
- retain compliance-limited PII
- not applicable, with explicit reason

At minimum classify:

`accounts`, `businesses`, `users`, `reviews`, `responses`, `approval_links`,
`approval_audit_log`, `account_audit_log`, `notification_deliveries`,
`channel_enrollments`, `zernio_connections`, `zernio_finalize_incidents`,
`zernio_backfill_runs`, `weekly_summaries`, `monthly_impact_emails`,
`review_exceptions`, `ranking_snapshots`, `onboarding_drip_log`,
`onboarding_demos`, `satisfaction_responses`, `auto_approval_policies`,
`api_costs`, `api_costs_daily_rollups`, `analytics_events`, `inbound_events`,
`job_outbox`, `sms_sender_opt_outs`, `sms_sender_opt_out_events`,
`flagged_responses`, `impersonation_sessions`, `google_connections`,
`prospect_demos`.

Tests must fail if any tenant/account-linked table is unclassified.
Purge completion tests must also use this inventory to verify that no raw
account-linked content remains before `purged_at` can be stamped.

## Admin visibility

V1 needs minimal admin visibility before launch:

- list/detail for offboardings stuck in billing cancellation, teardown,
  purge hold, or terminal failure
- retry metadata and last safe error
- provider disposition recording with reason, actor, resource, and optional
  ticket/reference
- documented manual override path

Admin-initiated deletion/reactivation remains out of scope except for provider
disposition needed to unblock a user-requested purge.

## Out of scope for v1

- Self-serve data export/download.
- Admin-initiated account deletion.
- Automatic deletion of ordinary churned accounts.
- Per-location deletion beyond existing location archival.
- Full retention/legal policy automation beyond the explicit table inventory.

## Implementation sequence

Split implementation across staged PRs; do not land this as one large change.

1. Schema + table-disposition inventory + no-op shared offboarding helpers +
   service-only/RLS/static-access tests for offboarding tables.
2. Cancel-only offboarding route/UI + Stripe schedule/reverse + Stripe Customer
   Portal cancellation removal.
3. Offboarding-aware guards and paid-through/read-only dashboard behavior.
4. Delete-data flow + fresh re-auth + keep-my-data tokens.
5. Stripe invoice behavior spike/test + teardown workers + Zernio/Stripe webhook
   reconciliation.
6. Purge worker + admin stuck-offboarding visibility.
7. End-to-end hardening, staging runbook, and production flag enablement.
   **Launch gate (non-code, required before enabling the production flag):** a
   non-refundable clause covering mid-cycle `stop_now`/`delete_data` in the Terms
   of Service, plus the point-of-action forfeiture disclosure copy, reviewed for
   the jurisdictions RepWorth sells into. Do not flag-enable in production until
   this is confirmed.

## Verification requirements

Before implementation is complete:

- migration structure tests for `account_offboardings`, RLS, indexes, and
  partial uniqueness on `terminal_at IS NULL`
- deny-all RLS and static/client-access tests proving browser code cannot read
  or mutate `account_offboardings` or `account_offboarding_tokens` directly
- table-disposition inventory test
- route tests for both offboarding modes, fresh re-auth, escalation, keep-my-data,
  and guard behavior
- worker tests for Stripe scheduling, immediate teardown, Zernio idempotent
  deletion, dedicated email worker, job terminalization, and purge stages
- explicit Stripe invoice behavior test/spike before claiming delete-data invoice
  cleanup semantics
- Stripe webhook tests for subscription-scoped reconciliation and stale old-sub
  ignore behavior
- approval callback tests for blocked/deleted accounts
- staging dry run with a test account covering `cancel_only`, pre-teardown
  reactivation, `delete_data`, keep-my-data, and purge, with expected DB states
  and Stripe/Zernio/Supabase Auth/email outcomes recorded in the runbook
- server-only feature-flag tests verifying owner-facing routes/workers stay
  disabled until explicitly enabled, with no `NEXT_PUBLIC_*` flag companion
- migrations applied staging-first against BOTH Supabase projects (staging and
  prod) in lockstep — "applied to prod, not staging" is a bug
- edge-account coverage: `pending_payment`/never-activated and trial/`past_due`
  accounts choosing offboarding must stamp absent Stripe/Zernio steps
  `not_applicable` (never hang teardown completion) and behave correctly
- `CancellationGracePoller` reconciliation tests: while the flag is off the poller
  is unchanged; while on, it skips accounts with an active/terminal offboarding
  row and offboarding owns archival (no double-archival on either clock)
- the four CI audits green — `ci:tenant-scope`, `ci:rls-audit`,
  `ci:analytics-events`, `ci:static-policy`; the last must ban client/browser
  access to `account_offboardings` and `account_offboarding_tokens`
- launch gate confirmed (ToS non-refundable clause + forfeiture disclosure copy)
  before the production feature flag is enabled
- `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm build` plus the
  narrowest relevant unit/integration suites

---

## v1 (current) vs future versions

The converged, implementation-ready **v1 spec** lives at
`docs/superpowers/specs/2026-06-05-owner-offboarding-design.md` (derived from this
plan via the brainstorming skill). This section records what v1 covers and the
phased backlog for later versions, ordered for efficient execution.

> ✅ **v1 is DONE** — implemented, staging-verified end-to-end, and merged to `main`
> **flag-OFF** (feature PR #244 + fix PR #245; commit `22ba46c2`; 2026-06-09). The list
> below records what v1 delivered; the **v2–v5 phased backlog** is the future roadmap.

### v1 — DONE (shipped to `main` flag-OFF, 2026-06-09)

- Two owner-initiated modes: **`cancel_only`** (ride to period end, same-sub
  reactivation, churn with data retained) and **`delete_data`** (immediate
  teardown + 30-day purge + keep-my-data).
- **`account_offboardings`** lifecycle + the minimized **8-status machine**
  (`pending|scheduled|tearing_down|purge_scheduled|purged|churned|reactivated|failed`
  + `failed_step`) + `account_offboarding_tokens`.
- A single **guard gate** (`src/lib/account-offboarding/gate.ts`) wired across all
  owner-write / worker / connect / billing surfaces.
- **Snapshot-driven shared teardown** worker; **staged, resumable purge** with
  auth-delete revalidation.
- **Test-enforced table-disposition inventory** (fails on any unclassified
  account-linked table).
- **CancellationGracePoller gating** (skip accounts with an active/terminal
  offboarding) — no double-archival.
- Dedicated lifecycle emails, server-side analytics, in-tx audit.
- Minimal admin visibility + provider-disposition override.
- Server-only flag (`ACCOUNT_OFFBOARDING_ENABLED`), staging dry-run, ToS launch gate.
- Fresh re-auth + AAL2 for `delete_data`.

### Future versions — phased for execution

Each wave reuses v1 primitives with minimal rework; sequenced by
dependency, blast radius, and value.

**v2 — convenience paths on the v1 machine (small, high-value, low-risk):**
- **`stop_now`** (immediate exit, keep data) — reuses the shared teardown worker;
  adds a `cancel_only → tearing_down` "now" transition + fresh re-auth. Mid-cycle
  forfeiture is already covered by the `delete_data` ToS clause.
- **`cancel → delete` escalation** — a guarded transition reusing both existing
  flows + the snapshot; fresh re-auth.
- **Rich read-only churn dashboard** — frontend over the existing `churned` state
  (historical reviews/responses, reactivate/reconnect CTAs).
- _Why now:_ purely additive to v1's state machine + workers; no schema redesign.

**v3 — data portability + ops maturity:**
- **Self-serve data export** ("download my data") — the GDPR-portability sibling
  of erasure; offered before `delete_data`. New: export format, async generation,
  download link.
- **Teardown/purge monitoring + alerting** — dashboards/alerts over `failed_step`,
  purge holds, stuck offboardings (builds directly on v1's per-step observability
  columns).
- **Admin-initiated deletion + reactivation** — beyond the v1 provider-disposition
  override.
- _Why now:_ export depends on nothing new in v1; monitoring matures the
  observability v1 already stamps.

**v4 — billing-lifecycle integration (larger blast radius, do after v1 beds in):**
- **Dunning/webhook-origin offboarding** — map involuntary/external Stripe
  cancellations into `system_origin='stripe_webhook'` offboarding rows; **retire
  `CancellationGracePoller`** after backfill. v1 deliberately keeps these separate.
- _Why later:_ touches the dunning path and retires an existing poller; needs v1
  fully validated first.

**v5 — product offramps + policy (deliberate, partly non-engineering):**
- **Pause/hibernate account** — lighter alternative to cancel/delete (stop billing,
  retain data, one-click resume); can divert churn.
- **Automatic deletion of churned accounts** — data-minimization policy; a
  legal/comms decision, not just code.
- **Per-location erasure** — true per-location data deletion (vs existing archival).
- **Configurable grace window** — make the 30-day purge window config/region/tier-aware.
- **Full retention/legal-policy automation** + a documented retention schedule.
- _Why later:_ product/legal-weighted and mutually independent; sequence by demand.
