# Owner Offboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement owner-initiated RepWorth offboarding in two v1 modes:
`cancel_only` and `delete_data`, with durable lifecycle state, a single guard
gate, explicit owner safety checks, staged teardown/purge, service-only
offboarding tables, and no accidental product access or auto-posting after an
account starts destructive offboarding.

**Architecture:** Add schema, table-disposition inventory, and a no-op gate
first. Then build `cancel_only`, wire the gate everywhere, add `delete_data`,
ship shared teardown, ship staged purge/admin reconciliation, and only then run
the staging dry-run and enable the server-only flag. Every state change that
schedules async work writes `job_outbox` in the same Postgres.js transaction.
All long-running/provider work stays on the Railway worker.

**Tech Stack:** Next.js App Router API/UI, Railway worker jobs and pollers,
Postgres.js transactions, Supabase Auth/RLS, Stripe, Zernio, Resend, BullMQ via
transactional `job_outbox`, Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md`

**Branch/worktree:** `owner-offboarding-plan` in
`.claude/worktrees/owner-offboarding-plan`.

---

## Non-Negotiable Constraints

- Work from a fresh branch/worktree per PR. `main` is protected; every phase
  lands by GitHub PR with lint, typecheck, test, and build green.
- Do not enable `ACCOUNT_OFFBOARDING_ENABLED` before PR7. Earlier PRs may land
  schema, helpers, routes, workers, admin visibility, and tests behind the dark
  server-only flag.
- No `NEXT_PUBLIC_*` companion flag. Browser code learns offboarding state only
  through server responses.
- Migration 056 creates `account_offboardings` and
  `account_offboarding_tokens`; both are deny-all RLS / service-only. Migration
  057 is allowed only if implementation proves a tombstone column must become
  nullable.
- Migrations run staging-first across the staging and production Supabase
  projects in lockstep. Apply to staging first, verify, then apply to production
  during promotion; never leave one Supabase project ahead of the other.
- `account_offboarding_tokens` follows the approval-security pattern: raw tokens
  exist only in memory and the sent email; Postgres stores only SHA-256 hashes.
  No raw token in `job_outbox`, logs, analytics, audit payloads, or Sentry.
- New queue topics require all three pieces in the same PR that can enqueue
  them: `QUEUE_NAMES`, `worker/queues.ts` queue/topic mapping, and
  `worker/index.ts` Worker registration.
- Route handlers remain thin. They validate/authenticate, call one focused
  module function, and map the result to a response.
- Reuse existing helpers: `withSameOrigin`, `requireWritableOwner`,
  `requireOwnerWithAccount`, `assertWritableSubscriptionForAccount`,
  `assertWritableSubscriptionForBusiness`, and `archiveLocationTransaction`.
- The Stripe invoice-cleanup behavior is a required PR5 spike/test before
  implementing teardown semantics.
- Do not plan v2+ items: `stop_now`, cancel-to-delete escalation,
  dunning/webhook-origin offboarding creation, rich churn dashboard,
  self-serve data export, admin-initiated deletion/reactivation, automatic
  deletion of churned accounts, or per-location erasure.

## Status-Machine Clarification

The approved spec defines an 8-status machine:
`pending | scheduled | tearing_down | purge_scheduled | purged | churned |
reactivated | failed`.

The purge section also mentions `status='purging'`; do **not** add a ninth
status in v1. Use `status='purge_scheduled'` plus `purge_started_at IS NOT NULL`
and stage stamps as the in-progress purge marker unless the spec is explicitly
amended before implementation.

## File Structure Map

Expected new areas:

- `src/lib/account-offboarding/`
  - `flags.ts`, `types.ts`, `gate.ts`
  - `confirm.ts`, `reactivate.ts`, `keep-my-data.ts`
  - `snapshot.ts`, `status.ts`
  - `table-disposition.ts`, `purge-verification.ts`
  - `teardown.ts`, `stripe-invoices.ts`, `provider-disposition.ts`
  - `__tests__/*`
- `src/app/api/account/offboarding/*`
  - `status/route.ts`
  - `confirm/route.ts`
  - `reactivate/route.ts`
  - `keep-my-data/route.ts`
- `src/app/(authenticated)/account/offboarding/status/page.tsx`
- `src/components/dashboard/settings/*Offboarding*.tsx`
- `src/components/dashboard/account-state/*Offboarding*.tsx`
- `worker/jobs/account-offboarding/*`
- `worker/background/pollers/AccountOffboardingAccessEndPoller.ts`
- `worker/background/pollers/AccountOffboardingPurgePoller.ts`
- `src/app/admin/offboardings/*`
- `docs/runbooks/owner-offboarding-staging-dry-run.md`

Expected existing files to modify:

- `supabase/migrations/056_account_offboarding.sql`
- Optional: `supabase/migrations/057_account_offboarding_tombstone_nullability.sql`
- `.claude/reference/migrations-log.md`
- `.claude/reference/env-vars.md`
- `.env.example`
- `docs/eservices-variables.md`
- `docs/security/rls-inventory.md`
- `scripts/ci/tenant-tables.ts`
- `scripts/ci/static-policy-audit.ts`
- `src/lib/shared/queue-names.ts`
- `worker/queues.ts`
- `worker/index.ts`
- `worker/config/startup-assert.ts`
- `src/lib/shared/protected-routes.ts`
- `src/lib/auth/route-helpers.ts`
- `src/lib/shared/writable-subscription.ts`
- `src/lib/shared/subscription-guard.ts`
- `src/app/api/billing/{portal,checkout,tier-change}/route.ts`
- `src/app/api/zernio/connect/{start,select-location,cancel}/route.ts`
- `src/app/api/zernio/connect/callback/route.ts`
- `src/app/api/zernio/disconnect/route.ts`
- Approval/session/callback modules under `src/lib/approval/*`
- Dashboard review action routes under `src/app/api/dashboard/reviews/*`
- Past replies mutation routes under `src/app/api/dashboard/past-replies/*`
- Location mutation routes under `src/app/api/locations/*`
- Auto-approval settings/runtime under `src/lib/auto-approval/*`,
  `src/app/api/settings/auto-approval/route.ts`, and
  `worker/jobs/response-generation/auto-approval.ts`
- `worker/jobs/{ResponseGeneratorWorker,notification/NotificationWorker,publisher/ResponsePublisherWorker}.ts`
- `worker/ingress/stripe/subscription-{updated,deleted}.ts`
- `worker/ingress/zernio/zernio.ts`
- `worker/background/pollers/CancellationGracePoller.ts`

---

## PR1: Schema 056, Inventory, Static Policy, No-Op Gate

Purpose: add the database shape and compile-time policy surfaces with no runtime
behavior change. After PR1, no account can start offboarding because routes and
workers do not exist yet.

### Task 1.1: Add Migration 056

**Files:**
- Create: `supabase/migrations/056_account_offboarding.sql`
- Create: `src/lib/shared/__tests__/migration-056-account-offboarding.test.ts`
- Modify: `.claude/reference/migrations-log.md`
- Modify: `docs/security/rls-inventory.md`
- Modify: `scripts/ci/tenant-tables.ts`

- [ ] Read `.claude/reference/migrations-log.md` and confirm current head is
  055 before creating 056.
- [ ] Create `account_offboardings` with app-generated UUIDv7 IDs and the
  approved columns: identity, mode, system origin, lifecycle/status columns,
  snapshot fields, per-step outcomes, retry/error fields, transient recipient
  and reason-code fields, and `terminal_at`.
- [ ] Include a `provider_dispositions jsonb not null default '[]'` column (or a
  similarly named deletion-safe JSONB column) inside `account_offboardings` for
  PR6 admin provider-disposition overrides. Do not add a third table unless the
  spec is amended.
- [ ] Add CHECK constraints for:
  - `mode in ('cancel_only', 'delete_data')`
  - `system_origin = 'owner'` in v1
  - the 8 statuses only
  - `failed_step in ('billing', 'teardown', 'purge')` only when failed
  - terminal statuses require `terminal_at IS NOT NULL`
  - non-terminal statuses require `terminal_at IS NULL`
  - step columns are `success | failed | not_applicable`
- [ ] Add partial indexes:
  - `UNIQUE (account_id) WHERE terminal_at IS NULL`
  - `(purge_after) WHERE status = 'purge_scheduled'`
  - `(access_ends_at) WHERE status = 'scheduled'`
- [ ] Index FK/snapshot lookup columns used by workers and admin views:
  `account_id`, `stripe_subscription_id`, and any provider-disposition lookup
  keys that are not JSON-only.
- [ ] Create `account_offboarding_tokens` with SHA-256 `token_hash`,
  `token_type='keep_my_data'`, expiry, consumed/revoked stamps, audit metadata,
  and FK to `account_offboardings`.
- [ ] Enable RLS on both tables and add no authenticated owner policies. Access
  is service-role/Postgres.js only, with app-level scope checks in routes.
- [ ] Update `docs/security/rls-inventory.md` and `scripts/ci/tenant-tables.ts`
  so RLS and tenant-scope audits include both new tables.
- [ ] Update the migration log current head to 056 and summarize the schema.
- [ ] Add migration structure tests for exact table names, RLS enabled,
  deny-all policy shape, indexes, constraints, partial predicates, and no raw
  token column.

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-056-account-offboarding.test.ts scripts/ci/__tests__/rls-audit.test.ts scripts/ci/__tests__/tenant-scope-audit.test.ts
pnpm ci:rls-audit
pnpm ci:tenant-scope
pnpm build
```

Deployment note for PR1: apply 056 to staging Supabase first, run the RLS and
tenant audits against staging, then apply the same migration to production
Supabase during promotion. Record both project applications in the PR or
runbook notes.

### Task 1.2: Add Table-Disposition Inventory

**Files:**
- Create: `src/lib/account-offboarding/table-disposition.ts`
- Create: `src/lib/account-offboarding/__tests__/table-disposition.test.ts`
- Modify: `scripts/ci/tenant-tables.ts` only if the inventory exposes a shared
  list helper

- [ ] Define a code-owned inventory that classifies every account-linked table
  as exactly one of: `hard_delete`, `scrub_in_place`,
  `retain_deidentified`, `retain_compliance_limited_pii`, or
  `not_applicable` with reason.
- [ ] Include every table from the spec's minimum list and reconcile against
  `TENANT_TABLES` plus explicit payload/control tables:
  `inbound_events`, `job_outbox`, `analytics_events`, `flagged_responses`,
  `impersonation_sessions`, and future account-linked additions.
- [ ] Add tests that fail when any tenant/account-linked table is unclassified
  or classified more than once.
- [ ] Add tests that expose purge-verification expectations from the same
  inventory so PR6 cannot drift from PR1 classifications.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/table-disposition.test.ts
pnpm ci:tenant-scope
pnpm build
```

### Task 1.3: Add Server-Only Flag And No-Op Gate

**Files:**
- Create: `src/lib/account-offboarding/flags.ts`
- Create: `src/lib/account-offboarding/types.ts`
- Create: `src/lib/account-offboarding/gate.ts`
- Create: `src/lib/account-offboarding/__tests__/flags.test.ts`
- Create: `src/lib/account-offboarding/__tests__/gate.test.ts`
- Modify: `.env.example`
- Modify: `.claude/reference/env-vars.md`
- Modify: `docs/eservices-variables.md`
- Modify: `worker/config/startup-assert.ts`

- [ ] Add `ACCOUNT_OFFBOARDING_ENABLED`, defaulting off unless the exact string
  `'true'` is present.
- [ ] Do not add any `NEXT_PUBLIC_ACCOUNT_OFFBOARDING_*` variable.
- [ ] Add the flag to env docs and startup logging/assertions as optional and
  server-only.
- [ ] Add domain types for mode, status, failed step, step outcome, and active
  offboarding state.
- [ ] Implement `getOffboardingState(accountId)` returning `null` before any
  rows exist, with per-request caching where existing request-cache patterns are
  available.
- [ ] Implement no-op intent checks with the approved public names:
  `isProcessingBlocked`, `isBillingMutationBlocked`, `isConnectBlocked`,
  `isOperationalUIBlocked`, `canReactivate`, and `purgeEligible`.
- [ ] Add tests proving env values such as `TRUE`, `1`, missing, and empty do
  not enable the flag.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/flags.test.ts src/lib/account-offboarding/__tests__/gate.test.ts
pnpm ci:static-policy
pnpm build
```

### Task 1.4: Extend Static Policy For Offboarding Tables

**Files:**
- Modify: `scripts/ci/static-policy-audit.ts`
- Modify: `scripts/ci/__tests__/static-policy-audit.test.ts`

- [ ] Extend the existing client-component table access ban from
  `auto_approval_policies` to also ban direct browser/client access to
  `account_offboardings` and `account_offboarding_tokens`.
- [ ] Keep tests precise: server modules may reference the tables; client
  components must not.
- [ ] Keep the `NEXT_PUBLIC_*` allowlist unchanged.

Run:

```bash
pnpm exec vitest run scripts/ci/__tests__/static-policy-audit.test.ts
pnpm ci:static-policy
pnpm build
```

---

## PR2: `cancel_only` Route/UI, Billing Schedule, Reactivation

Purpose: build the non-destructive owner cancellation flow behind the dark flag.
After PR2, the flag must still remain off in production.

### Task 2.1: Add `cancel_only` Confirm Service And Route

**Files:**
- Create: `src/lib/account-offboarding/snapshot.ts`
- Create: `src/lib/account-offboarding/confirm.ts`
- Create: `src/lib/account-offboarding/status.ts`
- Create: `src/lib/account-offboarding/__tests__/confirm-cancel-only.test.ts`
- Create: `src/app/api/account/offboarding/confirm/route.ts`
- Create: `src/app/api/account/offboarding/status/route.ts`
- Create: `src/app/api/account/offboarding/__tests__/confirm.test.ts`
- Modify: `src/lib/shared/protected-routes.ts`

- [ ] Route uses `withSameOrigin()` and owner auth. Use
  `requireWritableOwner` for initial `cancel_only` confirmation because the
  account is still writable before offboarding starts.
- [ ] Parse `{ mode: 'cancel_only', reasonCode? }` and an `Idempotency-Key`
  header. No free-text feedback field.
- [ ] In one `sql.begin()` transaction: lock `accounts`, assert no active
  `account_offboardings`, capture snapshot fields, insert `status='pending'`,
  write `account_audit_log` via `writeAccountAuditLog`, and insert outbox rows
  for billing schedule and confirmation email.
- [ ] If snapshot capture is incomplete, abort before inserting the row and
  return a support-oriented error.
- [ ] Add route tests for flag off, cross-origin, unauthenticated, duplicate
  active row, idempotent retry, and snapshot failure.
- [ ] Add status route for read-only status UI using `requireOwnerWithAccount`,
  not the writable guard.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/confirm-cancel-only.test.ts src/app/api/account/offboarding/__tests__/confirm.test.ts
pnpm build
```

### Task 2.2: Add Billing-Schedule Worker And Email Worker

**Files:**
- Modify: `src/lib/shared/queue-names.ts`
- Modify: `worker/queues.ts`
- Modify: `worker/index.ts`
- Modify: `src/lib/shared/worker-types.ts`
- Create: `worker/jobs/account-offboarding/BillingScheduleWorker.ts`
- Create: `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts`
- Create: `worker/jobs/account-offboarding/__tests__/BillingScheduleWorker.test.ts`
- Create: `worker/jobs/account-offboarding/__tests__/AccountOffboardingEmailWorker.test.ts`
- Create: `src/lib/notifications/email/templates/account-offboarding.ts`

- [ ] Add queue topics for `account_offboarding_billing_schedule` and
  `account_offboarding_email` with Queue instances, topic mapping, and Worker
  registration.
- [ ] Billing schedule worker loads the snapshot row, calls Stripe with a
  deterministic idempotency key, sets `cancel_at_period_end=true`, reads
  `current_period_end`, and updates `access_ends_at`, `status='scheduled'`,
  `billing_cancel_confirmed_at`, and `stripe_step='success'`.
- [ ] Missing or malformed Stripe `current_period_end` keeps the offboarding
  "in progress", alerts/retries, and never guesses locally.
- [ ] Worker failures set `status='failed'`, `failed_step='billing'`, and a
  scrubbed `last_error` only on terminal exhaustion; normal BullMQ attempts
  retry.
- [ ] Dedicated email worker reads by `account_offboarding_id`, uses
  `recipient_email`, dedupes by `account_offboarding_id + email_type`, and does
  not depend on active `businesses` rows or `OwnerEmailWorker` subscription
  checks.
- [ ] Add confirmation email tests and claim-before-send/rollback tests mirroring
  existing notification workers.

Run:

```bash
pnpm exec vitest run worker/jobs/account-offboarding/__tests__/BillingScheduleWorker.test.ts worker/jobs/account-offboarding/__tests__/AccountOffboardingEmailWorker.test.ts
pnpm build
```

### Task 2.3: Add Reactivation Before Teardown

**Files:**
- Create: `src/lib/account-offboarding/reactivate.ts`
- Create: `src/lib/account-offboarding/__tests__/reactivate.test.ts`
- Create: `src/app/api/account/offboarding/reactivate/route.ts`
- Extend: `src/app/api/account/offboarding/__tests__/confirm.test.ts`
- Extend: `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts`

- [ ] Route uses `withSameOrigin()` and `requireOwnerWithAccount`; it must be an
  explicit exception to "cancelled/read-only cannot write".
- [ ] Lock the active offboarding row; require mode `cancel_only`,
  `status='scheduled'`, `teardown_started_at IS NULL`, and no terminal stamp.
- [ ] Reverse `cancel_at_period_end` on the same snapshot subscription. If
  Stripe cannot reverse the same subscription, return a response that points the
  owner to existing checkout/reconnect paths rather than reopening the row.
- [ ] In one transaction after Stripe success, set `status='reactivated'`,
  `reactivated_at`, `terminal_at`, write audit, and enqueue a reactivation
  confirmation email.
- [ ] Add concurrency tests proving reactivation and access-end teardown cannot
  both win the row.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/reactivate.test.ts src/app/api/account/offboarding/__tests__/confirm.test.ts
pnpm build
```

### Task 2.4: Add Account UI And Remove Portal Cancellation

**Files:**
- Modify: `src/components/dashboard/settings/AccountPanel.tsx`
- Create: `src/components/dashboard/settings/AccountOffboardingPanel.tsx`
- Extend: `src/app/(authenticated)/settings/SettingsClient.tsx`
- Extend: `src/app/(authenticated)/settings/__tests__/SettingsClient.test.tsx`
- Extend: `src/components/dashboard/__tests__/SettingsTabs.test.tsx` only if
  tab behavior changes
- Modify: `src/app/api/billing/portal/route.ts`
- Extend: `src/app/api/billing/__tests__/portal.test.ts`

- [ ] Add a `cancel_only` panel in the existing Account tab. It shows the
  paid-through access behavior, confirmation modal, reason-code options, and
  idempotent submit.
- [ ] When `status='scheduled'`, show the access-end timestamp from the server
  in the account timezone and a reactivation CTA.
- [ ] Remove Stripe Customer Portal self-serve cancellation by creating/listing a
  portal configuration that allows payment-method update and invoice history but
  disables subscription cancellation. Keep "Manage billing" for invoices/cards.
- [ ] Add tests proving the portal route does not create a config with
  `subscription_cancel.enabled=true`.

Run:

```bash
pnpm exec vitest run src/app/api/billing/__tests__/portal.test.ts src/app/(authenticated)/settings/__tests__/SettingsClient.test.tsx
pnpm build
```

---

## PR3: Guard Gate Wired Everywhere And Status Page

Purpose: centralize offboarding policy and make all owner writes, worker entry
points, publishing/notification paths, connect flows, billing mutations, and
operational UI respect it.

### Task 3.1: Deepen The Gate Module

**Files:**
- Modify: `src/lib/account-offboarding/gate.ts`
- Extend: `src/lib/account-offboarding/__tests__/gate.test.ts`

- [ ] Implement the approved policy matrix:
  - `delete_data` non-terminal blocks processing, approval callbacks,
    notifications, publishing, checkout, connect, billing mutations, and
    operational UI.
  - `cancel_only scheduled` allows normal product behavior but blocks
    billing-expanding mutations.
  - `tearing_down` and later block all product behavior.
  - offboarding status, keep-my-data, and reactivation routes use dedicated
    offboarding guards, not `requireWritableOwner`.
- [ ] Keep the gate cohesive; do not scatter duplicated predicates across
  routes/workers.
- [ ] Add table-driven tests for every mode/status/intent combination.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/gate.test.ts
pnpm build
```

### Task 3.2: Wire Owner And Billing Routes

**Files:**
- Modify: `src/lib/auth/route-helpers.ts`
- Modify: `src/lib/shared/writable-subscription.ts`
- Modify: `src/app/api/billing/checkout/route.ts`
- Modify: `src/app/api/billing/tier-change/route.ts`
- Modify: `src/app/api/billing/portal/route.ts`
- Modify: `src/app/api/locations/{add,archive,reactivate,promote-primary}/route.ts`
- Modify: `src/app/api/settings/auto-approval/route.ts`
- Extend related route tests under `src/app/api/**/__tests__`

- [ ] Make `requireWritableOwner` and
  `assertWritableSubscriptionFor{Account,Business}` consult the gate for
  offboarding blocks.
- [ ] Billing checkout/tier-change/add-location are billing-expanding mutations;
  block during `cancel_only scheduled` and all `delete_data` states.
- [ ] Billing portal remains available for invoice/card management only when the
  gate allows it; no portal cancellation.
- [ ] Auto-approval settings are blocked for `delete_data` and
  `tearing_down+`; policy edits are also blocked for `cancel_only scheduled` if
  the change expands behavior or future billing.
- [ ] Location archive/reactivate/promote/add all consult the gate and keep using
  existing location transaction modules.

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/writable-subscription.test.ts src/app/api/billing/__tests__/checkout.test.ts src/app/api/billing/tier-change/__tests__/route.test.ts src/app/api/locations/__tests__/add.test.ts src/app/api/settings/auto-approval/__tests__/route.test.ts
pnpm build
```

### Task 3.3: Wire Approval, Dashboard, Past Replies, Connect, And Workers

**Files:**
- Modify approval modules under `src/lib/approval/{token-mode,session-mode,callback-mode,service}.ts`
- Modify approval route tests under `src/lib/approval/__tests__`
- Modify dashboard review action routes:
  `src/app/api/dashboard/reviews/[reviewId]/{approve,edit,regenerate}/route.ts`
- Modify past-replies routes:
  `src/app/api/dashboard/past-replies/{publish,draft}/route.ts`,
  `src/app/api/dashboard/past-replies/[responseId]/{retry,restore-original}/route.ts`
- Modify Zernio connect routes:
  `src/app/api/zernio/connect/{start,select-location,cancel}/route.ts`,
  `src/app/api/zernio/connect/callback/route.ts`,
  `src/app/api/zernio/disconnect/route.ts`
- Modify workers:
  `worker/jobs/ResponseGeneratorWorker.ts`,
  `worker/jobs/notification/NotificationWorker.ts`,
  `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Extend tests for all touched paths

- [ ] Approval callback/session/token paths return blocked/deleted-account
  responses when offboarding blocks approval or publishing.
- [ ] Dashboard and past-replies mutation routes block with a consistent JSON
  error while preserving existing same-origin and ownership checks.
- [ ] Zernio connect start/select/finalize/cancel/disconnect consult
  `isConnectBlocked`, except cleanup/cancel actions that are required to unwind
  an already-started flow.
- [ ] Worker entry points check offboarding state early after loading account
  context. Blocked notification/publish jobs mark their outbox rows completed
  when the correct outcome is "skip", not failed.
- [ ] Response generation is blocked for `delete_data` and `tearing_down+`, but
  keeps current subscription behavior for normal `cancel_only scheduled`.

Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__ worker/jobs/__tests__/ResponseGeneratorWorker.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts src/app/api/dashboard/past-replies/__tests__
pnpm build
```

### Task 3.4: Add Operational Status Page

**Files:**
- Create: `src/app/(authenticated)/account/offboarding/status/page.tsx`
- Create: `src/app/(authenticated)/account/offboarding/status/OffboardingStatusClient.tsx`
- Modify: `src/components/dashboard/account-state/AccountStateScreens.tsx`
- Modify: `src/components/dashboard/account-state/SubscriptionStatusBanner.tsx`
- Extend dashboard/settings page tests

- [ ] For `delete_data` and `tearing_down+`, hide operational dashboard UI and
  show the status page only.
- [ ] Status copy uses the honest deletion promise: data is deleted or
  anonymized after the waiting period; limited billing, security, and compliance
  records may be retained where required.
- [ ] Deadlines come from server-owned UTC timestamps and render in the account
  timezone.
- [ ] Do not expose raw provider IDs or business/review content on post-purge
  receipt/status surfaces.

Run:

```bash
pnpm exec vitest run src/components/dashboard/__tests__ src/app/(authenticated)/settings/__tests__/SettingsClient.test.tsx
pnpm build
```

---

## PR4: `delete_data` Route/UI, Fresh Auth, Keep-My-Data, Mark-Then-Call

Purpose: add the destructive owner request path and keep-my-data cancellation
mechanisms behind the dark flag. The production flag remains off.

### Task 4.1: Add Fresh Re-Auth And AAL2 Guard

**Files:**
- Create: `src/lib/account-offboarding/destructive-auth.ts`
- Create: `src/lib/account-offboarding/__tests__/destructive-auth.test.ts`
- Extend: `src/app/api/auth/mfa/challenge/route.ts` only if a fresh-auth stamp
  must be written after successful verification
- Extend: `src/lib/auth/mfa.ts` if a reusable current-AAL2 helper is needed

- [ ] Build a dedicated guard for `delete_data`: owner session, same-origin,
  fresh re-auth timestamp, and current AAL2 when Supabase reports MFA enrolled.
- [ ] If no existing fresh-auth timestamp contract exists, add a small
  server-owned cookie/session stamp after password or MFA verification and test
  expiry. Do not trust browser-provided timestamps.
- [ ] Add tests for no session, stale fresh-auth, MFA enrolled but current AAL1,
  MFA backend failure, and current AAL2 success.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/destructive-auth.test.ts src/lib/auth/__tests__/mfa.test.ts src/app/api/auth/__tests__/mfa-challenge.test.ts
pnpm build
```

### Task 4.2: Add `delete_data` Confirm Service And UI

**Files:**
- Modify: `src/lib/account-offboarding/confirm.ts`
- Create: `src/lib/account-offboarding/__tests__/confirm-delete-data.test.ts`
- Extend: `src/app/api/account/offboarding/confirm/route.ts`
- Extend: `src/app/api/account/offboarding/__tests__/confirm.test.ts`
- Create: `src/components/dashboard/settings/DeleteDataOffboardingModal.tsx`
- Extend: `src/components/dashboard/settings/AccountOffboardingPanel.tsx`

- [ ] UI copy covers immediate processing stop, billing/Google teardown,
  30-day purge window, retained-data exceptions, forfeiture/non-refundable
  disclosure, and lack of self-serve export.
- [ ] Require type-to-confirm and reason-code only, no free-text.
- [ ] In one `sql.begin()` transaction: lock account, assert no active
  offboarding, capture snapshot, set `purge_after = now() + interval '30 days'`,
  insert `status='pending'`, mark `zernio_connections` disconnected
  mark-then-call, write audit, and enqueue the dedicated confirmation email.
  PR5 completes this transaction by adding the immediate teardown outbox insert
  after the teardown topic and worker are registered.
- [ ] Do not put raw keep-my-data token in the outbox. The email worker creates
  the raw token at send time, stores only its hash, sends it, and keeps the raw
  value only in memory.
- [ ] Because teardown is implemented in PR5, keep production disabled and add
  tests that `delete_data` cannot run when the server flag is off.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/confirm-delete-data.test.ts src/app/api/account/offboarding/__tests__/confirm.test.ts
pnpm build
```

### Task 4.3: Keep-My-Data Authenticated And Token Paths

**Files:**
- Create: `src/lib/account-offboarding/keep-my-data.ts`
- Create: `src/lib/account-offboarding/tokens.ts`
- Create: `src/lib/account-offboarding/__tests__/keep-my-data.test.ts`
- Create: `src/lib/account-offboarding/__tests__/tokens.test.ts`
- Create: `src/app/api/account/offboarding/keep-my-data/route.ts`
- Create: `src/app/api/account/offboarding/__tests__/keep-my-data.test.ts`
- Extend: `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts`

- [ ] Authenticated keep-my-data route uses `withSameOrigin()` and
  `requireOwnerWithAccount`, not `requireWritableOwner`.
- [ ] Token route accepts only a raw token for `token_type='keep_my_data'`,
  hashes with Node `node:crypto`, checks expiry/consumed/revoked, and consumes
  atomically.
- [ ] Both paths lock the offboarding row, require `purge_started_at IS NULL`,
  set `purge_cancelled_at`, revoke outstanding tokens, write audit, and enqueue
  a confirmation email.
- [ ] If teardown is already complete, transition to `churned` and set
  `terminal_at`; otherwise leave the row non-terminal and let teardown completion
  land `churned`.
- [ ] Add tests that expired/revoked/consumed tokens fail and raw tokens are not
  persisted or logged.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/tokens.test.ts src/lib/account-offboarding/__tests__/keep-my-data.test.ts src/app/api/account/offboarding/__tests__/keep-my-data.test.ts worker/jobs/account-offboarding/__tests__/AccountOffboardingEmailWorker.test.ts
pnpm ci:static-policy
pnpm build
```

---

## PR5: Stripe Invoice Spike, Shared Teardown, Provider Reconciliation

Purpose: make both modes converge on one snapshot-driven teardown worker and
prove Stripe invoice cleanup semantics before implementing them.

### Task 5.1: Required Stripe Invoice Spike/Test

**Files:**
- Create: `docs/runbooks/owner-offboarding-stripe-invoice-spike.md`
- Create: `src/lib/account-offboarding/stripe-invoices.ts`
- Create: `src/lib/account-offboarding/__tests__/stripe-invoices.test.ts`

- [ ] In Stripe test mode or an isolated mocked contract test, prove behavior
  for draft, open/finalized, uncollectible, voided, and paid invoices tied to a
  cancelled subscription.
- [ ] Document which invoice states can be voided, which draft states require a
  different operation, which states must be retained, and what errors are
  retryable/permanent.
- [ ] Only after the spike is documented, implement a pure
  `cleanupSubscriptionInvoices` helper with tests for every discovered state.
- [ ] Use deterministic Stripe idempotency keys and bounded retry semantics.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/stripe-invoices.test.ts
pnpm build
```

### Task 5.2: Add Shared Teardown Worker

**Files:**
- Modify: `src/lib/shared/queue-names.ts`
- Modify: `worker/queues.ts`
- Modify: `worker/index.ts`
- Modify: `src/lib/shared/worker-types.ts`
- Modify: `src/lib/account-offboarding/confirm.ts`
- Extend: `src/lib/account-offboarding/__tests__/confirm-delete-data.test.ts`
- Create: `worker/jobs/account-offboarding/TeardownWorker.ts`
- Create: `worker/jobs/account-offboarding/teardown-stripe.ts`
- Create: `worker/jobs/account-offboarding/teardown-zernio.ts`
- Create: `worker/jobs/account-offboarding/teardown-locations.ts`
- Create: `worker/jobs/account-offboarding/teardown-outbox.ts`
- Create: `worker/jobs/account-offboarding/__tests__/TeardownWorker.test.ts`

- [ ] Add `account_offboarding_teardown` queue topic, Queue instance, topic
  mapping, and Worker registration in the same PR.
- [ ] Extend `delete_data` confirm so the same transaction that inserts the
  offboarding row and marks `zernio_connections` disconnected also inserts the
  immediate teardown outbox row. Add a regression test proving state change and
  teardown enqueue are atomic.
- [ ] Worker loads only the snapshot from `account_offboardings`; do not read
  live mutable provider/account fields to decide what to tear down.
- [ ] Stripe step cancels the snapshot subscription with no proration, runs the
  invoice cleanup helper, and verifies natural cancellation for `cancel_only` at
  access end.
- [ ] Zernio step deletes snapshot account/profile IDs; 404 and 410 classify as
  idempotent success; empty snapshots become `not_applicable`.
- [ ] Location step archives all snapshot location IDs by reusing
  `archiveLocationTransaction` or a narrow shared variant that preserves its
  invariants.
- [ ] Job terminalization step closes eligible pending `job_outbox` rows for the
  account so stale publish/notification jobs cannot fire after teardown.
- [ ] Completion is derived only when every required step is
  `success`/`not_applicable`; never stamp `teardown_completed_at`
  optimistically.
- [ ] Terminal exhaustion sets `status='failed'`, `failed_step='teardown'`,
  scrubbed `last_error`, and an ops alert.
- [ ] If `purge_cancelled_at` exists for `delete_data`, teardown completion lands
  `churned`; otherwise it lands `purge_scheduled`.

Run:

```bash
pnpm exec vitest run worker/jobs/account-offboarding/__tests__/TeardownWorker.test.ts src/lib/locations/__tests__/archive-location-tx.test.ts
pnpm build
```

### Task 5.3: Add Access-End Poller For `cancel_only`

**Files:**
- Create: `worker/background/pollers/AccountOffboardingAccessEndPoller.ts`
- Create: `worker/background/pollers/__tests__/AccountOffboardingAccessEndPoller.test.ts`
- Modify: `worker/index.ts`

- [ ] Poller claims `status='scheduled' AND access_ends_at <= now()` using
  `FOR UPDATE SKIP LOCKED`.
- [ ] Inside the transaction, revalidate the row, set `status='tearing_down'`,
  stamp `teardown_started_at`, write audit, and enqueue teardown outbox.
- [ ] Concurrency tests prove reactivation and teardown claim cannot both win.
- [ ] Poller is gated by `ACCOUNT_OFFBOARDING_ENABLED` and remains inactive
  while the flag is off.

Run:

```bash
pnpm exec vitest run worker/background/pollers/__tests__/AccountOffboardingAccessEndPoller.test.ts
pnpm build
```

### Task 5.4: Stripe, Zernio, And CancellationGrace Reconciliation

**Files:**
- Modify: `worker/ingress/stripe/subscription-updated.ts`
- Modify: `worker/ingress/stripe/subscription-deleted.ts`
- Extend: `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`
- Modify: `worker/ingress/zernio/zernio.ts`
- Extend: `worker/ingress/zernio/__tests__/*`
- Modify: `worker/background/pollers/CancellationGracePoller.ts`
- Extend: `worker/background/pollers/__tests__/CancellationGracePoller.test.ts`

- [ ] Stripe webhook reconciliation is subscription-scoped: ignore
  `customer.subscription.*` events whose subscription ID does not match either
  `accounts.stripe_subscription_id` or the active offboarding snapshot.
- [ ] Add stale old-subscription webhook tests after reactivation/new checkout.
- [ ] Zernio `account.disconnected` during active teardown reconciles/stamps the
  Zernio step; outside active teardown, existing connection-lost behavior stays.
- [ ] `CancellationGracePoller` skips any account with an active or terminal
  offboarding row so it does not double-archive owner-initiated offboarding.
- [ ] No webhook-origin offboarding creation in v1.

Run:

```bash
pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts worker/background/pollers/__tests__/CancellationGracePoller.test.ts
pnpm build
```

---

## PR6: Staged Purge, Auth Delete Revalidation, Admin Provider Disposition

Purpose: finish `delete_data` with short, resumable purge stages and minimal
admin visibility for stuck offboardings. The production flag still remains off
until PR7.

### Task 6.1: Add Purge Stage Engine And Poller

**Files:**
- Modify: `src/lib/shared/queue-names.ts`
- Modify: `worker/queues.ts`
- Modify: `worker/index.ts`
- Modify: `src/lib/shared/worker-types.ts`
- Create: `worker/background/pollers/AccountOffboardingPurgePoller.ts`
- Create: `worker/background/pollers/__tests__/AccountOffboardingPurgePoller.test.ts`
- Create: `worker/jobs/account-offboarding/PurgeWorker.ts`
- Create: `worker/jobs/account-offboarding/purge-stages.ts`
- Create: `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts`
- Create: `src/lib/account-offboarding/purge-verification.ts`
- Create: `src/lib/account-offboarding/__tests__/purge-verification.test.ts`

- [ ] Add `account_offboarding_purge` queue topic, Queue instance, topic
  mapping, and Worker registration in the same PR.
- [ ] Poller claims eligible rows with `FOR UPDATE SKIP LOCKED`: mode
  `delete_data`, `status='purge_scheduled'`, `purge_after <= now()`,
  `purge_cancelled_at IS NULL`, teardown complete or admin provider disposition
  recorded, and `purge_started_at IS NULL`.
- [ ] Claim stamps `purge_started_at`, revokes keep-my-data tokens, writes audit,
  and enqueues purge. Do not add `status='purging'`.
- [ ] Add a server-only non-production purge-window override for staging tests.
  Never expose it to browser code and never allow it in production.
- [ ] Purge worker stages are restartable and use short transactions; no locks
  span external calls.
- [ ] Auth-user deletion revalidates immediately before `deleteUser()`:
  captured `auth_user_id` still matches the `users` row, the user still belongs
  to the account, and no future multi-account binding exists. Treat auth-user
  not-found as success only after revalidation passes.
- [ ] Scrub/delete in the approved order: auth binding, dependent refs, content,
  raw payloads, analytics, SMS opt-out data, provider identifiers, audit/cost
  payloads, parent tombstones, verification queries, terminal scrub.
- [ ] Final verification is generated from `table-disposition.ts`; do not stamp
  `purged_at` until every table is empty, scrubbed, or retained under an
  approved compliance-limited disposition.
- [ ] Terminal scrub nulls `recipient_email`, raw snapshot provider IDs, and
  `auth_user_id` after auth deletion succeeds.

Run:

```bash
pnpm exec vitest run worker/background/pollers/__tests__/AccountOffboardingPurgePoller.test.ts worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts src/lib/account-offboarding/__tests__/purge-verification.test.ts
pnpm ci:tenant-scope
pnpm ci:rls-audit
pnpm build
```

### Task 6.2: Add Optional Migration 057 Only If Tombstoning Requires It

**Files:**
- Optional create:
  `supabase/migrations/057_account_offboarding_tombstone_nullability.sql`
- Optional create:
  `src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.test.ts`
- Modify: `.claude/reference/migrations-log.md` only if 057 exists

- [ ] Prefer deterministic non-PII tombstone values for NOT NULL/unique parent
  columns.
- [ ] Create 057 only when a concrete parent column cannot be tombstoned safely
  without becoming nullable.
- [ ] If 057 exists, make it additive/idempotent, test it, and apply
  staging-first to both Supabase projects in lockstep like 056.

Run only if 057 exists:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.test.ts
pnpm ci:rls-audit
pnpm ci:tenant-scope
pnpm build
```

### Task 6.3: Admin Stuck-Offboarding Visibility And Provider Disposition

**Files:**
- Create: `src/lib/account-offboarding/provider-disposition.ts`
- Create: `src/lib/account-offboarding/__tests__/provider-disposition.test.ts`
- Create: `src/app/api/admin/offboardings/route.ts`
- Create: `src/app/api/admin/offboardings/[offboardingId]/provider-disposition/route.ts`
- Create: `src/app/api/admin/offboardings/__tests__/route.test.ts`
- Create: `src/app/admin/offboardings/page.tsx`
- Create: `src/app/admin/offboardings/OffboardingsClient.tsx`
- Modify: admin navigation if needed

- [ ] Admin list shows active/failed/stuck offboardings, mode, status,
  failed_step, scrubbed last_error, due timestamps, and provider step states.
- [ ] Provider disposition route requires admin AAL2 via existing admin gates and
  records provider, resource type, scrubbed resource reference, admin actor,
  reason, timestamp, and optional ticket.
- [ ] Provider disposition writes `account_offboardings.provider_dispositions`
  and `account_audit_log` in one transaction.
- [ ] Admin override cannot blind force-purge. Purge eligibility checks for a
  concrete disposition record before treating blocked provider teardown as
  force-terminalized.
- [ ] UI never displays raw review/response text, raw tokens, or raw provider
  secrets.

Run:

```bash
pnpm exec vitest run src/lib/account-offboarding/__tests__/provider-disposition.test.ts src/app/api/admin/offboardings/__tests__/route.test.ts
pnpm build
```

---

## PR7: End-To-End Hardening, Staging Dry-Run, Launch Gate, Production Flag

Purpose: prove the whole feature in staging, complete legal/launch gates, and
enable production only after evidence is recorded.

### Task 7.1: End-To-End And Edge-Account Tests

**Files:**
- Create: `e2e/owner-offboarding.spec.ts`
- Extend worker/route tests from PR2-PR6
- Create or extend fixtures under `src/lib/__fixtures__`

- [ ] Add E2E coverage for `cancel_only`, pre-teardown reactivation,
  `delete_data`, keep-my-data, and purge using the server-only shortened
  non-production window.
- [ ] Add edge-account coverage for `pending_payment`, never-activated, trial,
  and `past_due` accounts. Absent provider/billing steps must become
  `not_applicable` and never hang teardown completion.
- [ ] Add approval-callback tests for blocked/deleted accounts.
- [ ] Add dedicated email dedup and purge receipt tests.
- [ ] Add analytics tests for durable server-side events:
  `offboarding_started`, `offboarding_reactivated`,
  `offboarding_teardown_completed`, and `offboarding_purged`, plus purge-time
  scrubbing of identifiers/properties.

Run:

```bash
pnpm exec playwright test e2e/owner-offboarding.spec.ts --workers=1
pnpm exec vitest run src/lib/account-offboarding worker/jobs/account-offboarding worker/background/pollers
pnpm ci:analytics-events
pnpm build
```

### Task 7.2: Staging Dry-Run Runbook

**Files:**
- Create: `docs/runbooks/owner-offboarding-staging-dry-run.md`
- Update: `docs/runbooks/deployment-guide.md` only if deployment steps need a
  pointer

- [ ] Document exact staging prerequisites: staging Supabase has 056 and
  optional 057, Railway staging worker deployed, Vercel staging custom env
  deployed, Stripe/Zernio test creds configured, and server-only purge override
  set only in staging.
- [ ] Dry-run a test account through:
  - `cancel_only` confirmation
  - same-subscription reactivation before access end
  - `delete_data` confirmation
  - keep-my-data before purge
  - `delete_data` confirmation again on a separate account
  - teardown and purge with shortened staging window
- [ ] Record observed Stripe invoice cleanup behavior from the PR5 spike and the
  staging run.
- [ ] Record RLS/static/tenant/analytics audit results.
- [ ] Record any provider disposition override exercise or explicitly state why
  none was needed in the dry-run.

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ci:tenant-scope
pnpm ci:rls-audit
pnpm ci:analytics-events
pnpm ci:static-policy
pnpm build
```

Do not run the final CI gate from a nested worktree. Push the PR branch and read
the GitHub Actions runner results.

### Task 7.3: Launch Gate And Production Enablement

**Files:**
- Modify: `src/lib/legal/content.ts`
- Extend: `src/lib/legal/__tests__/content.test.ts`
- Modify: `.claude/reference/env-vars.md`
- Modify: `docs/eservices-variables.md`
- Modify: `docs/runbooks/owner-offboarding-staging-dry-run.md`

- [ ] Add the required ToS non-refundable clause for mid-cycle `delete_data` and
  update point-of-action forfeiture disclosure copy. Legal review must cover the
  jurisdictions RepWorth sells into before production enablement.
- [ ] Confirm no product copy promises absolute deletion. Copy must say RepWorth
  deletes or anonymizes customer data while retaining limited billing, security,
  and compliance records where required.
- [ ] Confirm 056 and optional 057 have been applied to both Supabase projects
  in lockstep, staging first.
- [ ] Confirm production Railway and Vercel envs have
  `ACCOUNT_OFFBOARDING_ENABLED=true` only after the staging dry-run evidence and
  legal launch gate are recorded.
- [ ] After production enablement, smoke-test status route, `cancel_only`
  confirmation, and cancellation reversal on a controlled test/customer account
  only; do not test destructive purge on a real customer account.

Run:

```bash
pnpm exec vitest run src/lib/legal/__tests__/content.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm ci:tenant-scope
pnpm ci:rls-audit
pnpm ci:analytics-events
pnpm ci:static-policy
pnpm build
```

---

## Final Verification Contract

Before any implementation PR is called done:

- The narrowest relevant route/module/worker tests pass.
- `pnpm build` passes for behavior-affecting changes.
- DB-touching PRs also run `pnpm ci:tenant-scope` and `pnpm ci:rls-audit`.
- Analytics changes run `pnpm ci:analytics-events`.
- Static policy changes run `pnpm ci:static-policy`.
- PRs touching migrations, worker, webhook, publisher, or billing ride staging
  first, then land on `main` by PR.
- The production flag is enabled only in PR7 after staging dry-run and legal
  launch-gate evidence is recorded.
