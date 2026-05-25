# Step 1 Keystone Slice Design

Status: approved for spec review

Date: 2026-05-25

## Context

`docs/sass_ready/README.md` defines Step 1 as the SaaS readiness keystone layer. The first slice, secret-free GitHub Actions CI plus branch protection, is already shipped. This design covers the remaining Step 1 keystones as one implementation slice:

- `accounts.past_due_at`, owned by Spec 05.
- Worker-side PostHog activation capture, owned by Spec 01.
- Generalized account audit foundation, owned by Spec 04.

The goal is to unblock the dependent readiness waves without pulling in full downstream work such as dunning UX, MFA/team UI, retention dashboards, or specialized CI gates.

## Selected Approach

Ship one Step 1 keystone slice. The three parts share migration numbering, worker paths, and verification, so doing them together reduces coordination overhead while keeping the behavior surface bounded.

Rejected alternatives:

- Three separate slices: lower per-change blast radius, but more migration coordination and a slower path to Step 1 completion.
- Keystone plus dependent polish: more visible product changes, but it would mix foundation work with Spec 05/06/11/14 downstream behavior.

## Scope

In scope:

- Migration `043` for `accounts.past_due_at`.
- Migration `043` for phase-A `account_memberships` schema and owner backfill.
- Migration `043` for `account_audit_log` metadata columns: `entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`.
- A typed account audit helper in `src/lib/audit/log.ts`.
- Stripe webhook updates that set and clear `past_due_at` in the existing transactions.
- Worker-safe PostHog capture for `activation_completed` on the publisher path.
- Focused unit and migration structure tests.

Out of scope:

- Day-variant past-due banner, modal, and read-only route layer.
- Branded dunning cadence and grant-extension UI.
- Retention dashboards and full event taxonomy CI audit.
- MFA enrollment, Settings -> Security, Settings -> Team, invites, or middleware membership enforcement.
- Specialized CI gates beyond the already shipped base gate.

## Architecture

### Migration Foundation

Migration `043` adds:

- `accounts.past_due_at TIMESTAMPTZ NULL`.
- `account_memberships` with `account_id`, `user_id`, `role`, optional `business_id`, timestamps, and `deactivated_at`.
- A backfill that inserts one owner membership per account from `accounts.owner_user_id`.
- RLS enabled on `account_memberships` using the existing account-owner access model.
- Audit metadata columns on `account_audit_log`: `entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`.
- Supporting indexes for account membership lookup and audit metadata queries.

`account_memberships` is inert in this slice. Middleware and UI continue to use the current `users.role` and `users.account_id` model.

### Audit Helper

Add `src/lib/audit/log.ts` as a small Postgres.js helper. It accepts either the default SQL client or an existing transaction client so callers can make audit writes atomic with state changes.

The helper owns:

- UUID generation.
- JSONB serialization through the existing `jsonb()` helper.
- Required fields: `account_id`, `event_type`, `payload`.
- Optional fields: `location_id`, `actor_user_id`, `entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`.

The helper does not own business rules. Callers choose event types and payload shape. Step 1 changed paths use it first; unrelated existing direct inserts can be migrated later when touched.

### Billing Webhooks

Update `worker/ingress/stripe/invoice-payment-failed.ts`:

- Keep the existing `inbound_events` dedup, account lookup, row lock, and advisory lock behavior.
- If the account is `active`, update `accounts.subscription_status` to `past_due`, set `past_due_at = NOW()`, mirror the deprecated `businesses.subscription_status`, and write the audit event in the same transaction.
- If the account is already `past_due`, leave `past_due_at` unchanged. The countdown should preserve the first failure time.

Update `worker/ingress/stripe/invoice-paid.ts`:

- For each recovered `past_due` account, update `accounts.subscription_status` to `active`, clear `past_due_at`, mirror `businesses.subscription_status`, and write the audit event in the same transaction.
- Keep the existing backfill-resume behavior after the transaction.

### PostHog Activation Capture

Add `src/lib/analytics/posthog.ts` for server/worker usage:

- Lazily initializes `posthog-node`.
- Requires `POSTHOG_API_KEY`; defaults to no-op when unset so local tests and builds do not require secrets.
- Supports explicit flush/shutdown where useful for tests and worker lifecycle.

Update `worker/jobs/publisher/ResponsePublisherWorker.ts` after the durable `responses.status = 'posted'` update:

- Join through `responses -> businesses -> accounts`.
- Determine whether this is the account's first posted response.
- Determine whether the first posted response happened within 7 days of `accounts.created_at`.
- Capture `activation_completed` with `account_id` as `distinctId` and safe properties: `business_id`, `response_id`, `review_id`, `days_to_activation`.

Analytics capture is best-effort. A PostHog error logs with job correlation context and does not fail the publish or outbox completion.

## Data Flow

Payment failure:

1. Stripe sends `invoice.payment_failed`.
2. Existing webhook entry claims the event through `inbound_events`.
3. The handler locks the account by `stripe_customer_id`.
4. `active` accounts transition to `past_due` and get `past_due_at = NOW()`.
5. The audit helper writes `subscription_status_changed` in the same transaction.
6. Deprecated `businesses.subscription_status` mirrors the account status.

Payment recovery:

1. Stripe sends `invoice.paid`.
2. Existing webhook entry claims the event through `inbound_events`.
3. The handler locks matching accounts.
4. `past_due` accounts transition to `active` and clear `past_due_at`.
5. The audit helper writes `subscription_status_changed` in the same transaction.
6. Existing backfill-resume behavior runs afterward.

Activation:

1. The publisher posts the approved response through Zernio.
2. The worker updates the response to `status = 'posted'` and `posted_at = NOW()`.
3. The worker checks whether the account has any earlier posted response.
4. If this is the first posted response within 7 days of account creation, the worker emits `activation_completed`.
5. PostHog failure is logged and does not change response or outbox state.

## Error Handling

Billing and audit state are strict. If `past_due_at` or the audit row cannot be written, the webhook transaction fails and the existing retry behavior handles it.

Analytics is non-critical. PostHog capture failures must not block publishing, owner approvals, or outbox completion.

Migration behavior is additive and zero-downtime:

- New columns are nullable.
- New table is backfilled without changing runtime authorization behavior.
- No columns are dropped.
- No existing required paths depend on `account_memberships`.

## Testing Plan

Add focused tests:

- Migration structure test for `043`: `accounts.past_due_at`, `account_memberships`, audit metadata columns, indexes, RLS/policies, owner backfill SQL.
- Stripe webhook tests for `invoice.payment_failed` and `invoice.paid`: first failure sets `past_due_at`, repeated failure preserves it, recovery clears it.
- Audit helper tests for transaction/client injection, JSONB payloads, optional metadata, and required fields.
- Publisher worker tests for `activation_completed`: emits for first posted response within 7 days, skips outside 7 days, skips when a prior posted response exists, and does not fail publish when PostHog capture errors.

Verification commands after implementation:

- Narrow Vitest targets for the changed units.
- `pnpm build`.

## Acceptance Criteria

- `accounts.past_due_at` exists and is set only on the first active-to-past-due transition.
- `accounts.past_due_at` is cleared on past-due recovery.
- `account_memberships` exists, has RLS, and is backfilled with one owner row per account.
- `account_audit_log` has the new metadata columns.
- Step 1 changed paths write audit rows through the helper.
- `activation_completed` is emitted from the worker publisher path only for the first account-level posted response within 7 days.
- Publishing still succeeds when analytics is unavailable.
- Focused tests and `pnpm build` pass before claiming implementation complete.

## Open Implementation Notes

- Use `posthog-node` as a new dependency. Do not install or initialize `posthog-js` in this slice unless a client-side event is added later.
- Do not put PostHog capture in Next.js API routes. Activation happens in the Railway worker.
- Keep `account_memberships` behind the current behavior boundary. This migration is a foundation for later auth work, not a behavior switch.
- Preserve the first `past_due_at` timestamp across repeated failed invoices while the account is already `past_due`.
