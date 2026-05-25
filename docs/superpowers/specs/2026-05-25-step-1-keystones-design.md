# Step 1 Keystone Slice Design

Status: ready for user review

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
- `account_memberships` phase-A schema/backfill. The README Step 1 keystone is audit foundation only; membership schema moves to the later Spec 04 auth hardening slice.
- Specialized CI gates beyond the already shipped base gate.

## Architecture

### Migration Foundation

Migration `043` adds:

- `accounts.past_due_at TIMESTAMPTZ NULL`.
- Audit metadata columns on `account_audit_log`: `entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`.
- No new audit indexes in this slice unless implementation introduces a matching query. Existing `idx_account_audit` and `idx_account_audit_event` stay unchanged.

`account_memberships` is deliberately excluded. Pulling it into this slice would add an inert table, backfill, and RLS surface that does not unblock the Step 1 audit keystone.

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
- If the account is `active`, update `accounts.subscription_status` to `past_due`, set `past_due_at = NOW()`, mirror the deprecated `businesses.subscription_status`, and write the audit event through `src/lib/audit/log.ts` in the same transaction.
- If the account is already `past_due`, leave `past_due_at` unchanged. The countdown should preserve the first failure time.

Update `worker/ingress/stripe/invoice-paid.ts`:

- For each recovered `past_due` account, update `accounts.subscription_status` to `active`, clear `past_due_at`, mirror `businesses.subscription_status`, and write the audit event through `src/lib/audit/log.ts` in the same transaction.
- Keep the existing backfill-resume behavior after the transaction.

Update `worker/ingress/stripe/subscription-deleted.ts`:

- When an account transitions to `cancelled`, clear `past_due_at` in the same transaction. `past_due_at` represents the current past-due interval, not billing history.
- Write the cancellation audit event through `src/lib/audit/log.ts` because this slice touches the same subscription-status audit path.

### PostHog Activation Capture

Add `src/lib/analytics/posthog.ts` for server/worker usage:

- Lazily initializes `posthog-node`.
- Requires `POSTHOG_API_KEY`; defaults to no-op when unset so local tests and builds do not require secrets.
- Supports explicit flush/shutdown where useful for tests and worker lifecycle.

Update the publisher posted-transition paths:

- Do not attach activation capture only to the main-path `UPDATE responses SET status = 'posted'`.
- Add a shared publisher activation chokepoint used by every current posted transition:
  - `worker/jobs/publisher/ResponsePublisherWorker.ts` main publish success path.
  - `worker/jobs/publisher/edit-publish.ts` edit-then-publish success path.
  - `worker/jobs/publisher/edit-publish.ts` `409_matches` path.
  - `worker/jobs/publisher/publisher-error-handlers.ts` idempotent 409 reconciliation path.
- The chokepoint joins through `responses -> businesses -> accounts`, determines whether this is the account's first posted response, determines whether it happened within 7 days of `accounts.created_at`, and captures `activation_completed`.
- Capture with `account_id` as `distinctId` and safe properties: `business_id`, `response_id`, `review_id`, `days_to_activation`.

Analytics capture is best-effort. A PostHog error logs with job correlation context and does not fail the publish or outbox completion.

Implementation note: DB updates that run inside transactions should not call PostHog before commit. The shared path can return an activation candidate from the posting update and run the best-effort capture after the transaction commits, but all posted transitions must go through the same activation decision logic.

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

Cancellation:

1. Stripe sends `customer.subscription.deleted`.
2. Existing webhook entry claims the event through `inbound_events`.
3. The handler locks the account by `stripe_customer_id`.
4. Any non-cancelled account transitions to `cancelled`, sets `cancelled_at = NOW()`, and clears `past_due_at`.
5. The audit helper writes `subscription_status_changed` in the same transaction.

Activation:

1. The publisher posts the approved response through Zernio.
2. The relevant posted-transition path updates the response to `status = 'posted'` and `posted_at = NOW()`.
3. The shared activation chokepoint checks whether the account has any earlier posted response.
4. If this is the first posted response within 7 days of account creation, the worker emits `activation_completed`.
5. PostHog failure is logged and does not change response or outbox state.

## Error Handling

Billing and audit state are strict. If `past_due_at` or the audit row cannot be written, the webhook transaction fails and the existing retry behavior handles it.

Analytics is non-critical. PostHog capture failures must not block publishing, owner approvals, or outbox completion.

Migration behavior is additive and zero-downtime:

- New columns are nullable.
- No columns are dropped.
- No runtime authorization behavior changes.

## Testing Plan

Add focused tests:

- Migration structure test for `043`: `accounts.past_due_at` and audit metadata columns.
- Stripe webhook tests for `invoice.payment_failed`, `invoice.paid`, and `customer.subscription.deleted`: first failure sets `past_due_at`, repeated failure preserves it, recovery clears it, and cancellation clears it.
- Audit helper tests for transaction/client injection, JSONB payloads, optional metadata, and required fields.
- Billing webhook tests assert the touched subscription-status paths write audit rows through the helper rather than raw inserts.
- Publisher worker tests for `activation_completed`: emits for first posted response within 7 days, skips outside 7 days, skips when a prior posted response exists, covers all current posted transitions, and does not fail publish when PostHog capture errors.

Verification commands after implementation:

- Narrow Vitest targets for the changed units.
- `pnpm build`.

## Acceptance Criteria

- `accounts.past_due_at` exists and is set only on the first active-to-past-due transition.
- `accounts.past_due_at` is cleared on past-due recovery.
- `accounts.past_due_at` is cleared on cancellation.
- `account_audit_log` has the new metadata columns.
- Step 1 changed billing status paths write audit rows through the helper.
- `activation_completed` is emitted from a shared publisher activation chokepoint only for the first account-level posted response within 7 days.
- The activation chokepoint covers the main publish success path, edit-publish success path, edit-publish `409_matches` path, and idempotent 409 reconciliation path.
- Publishing still succeeds when analytics is unavailable.
- Focused tests and `pnpm build` pass before claiming implementation complete.

## Open Implementation Notes

- Use `posthog-node` as a new dependency. Do not install or initialize `posthog-js` in this slice unless a client-side event is added later.
- Do not put PostHog capture in Next.js API routes. Activation happens in the Railway worker.
- Keep `account_memberships` out of this migration. It belongs to a later Spec 04 auth hardening slice.
- Preserve the first `past_due_at` timestamp across repeated failed invoices while the account is already `past_due`.
