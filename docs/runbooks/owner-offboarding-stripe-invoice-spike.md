# Owner Offboarding Stripe Invoice Spike

## Scope

PR5 Task 5.1 verifies how account-offboarding teardown should clean up Stripe
invoices that remain attached to a cancelled subscription. This is encoded as
an isolated mocked contract test around Stripe-compatible invoice API calls,
not as a live Stripe mutation. The helper introduced by this task is pure: it
does not read env, construct Stripe, log, touch the database, or enqueue work.

## Stripe Findings

Stripe invoice listing supports filtering by `subscription`; invoice `status`
is one of `draft`, `open`, `paid`, `uncollectible`, or `void`.
Source: https://docs.stripe.com/api/invoices/list

Stripe invoice workflow transitions show:

- `draft` can be finalized with `POST /v1/invoices/:id/finalize`, normally
  ending as `open`.
- `open` can be voided with `POST /v1/invoices/:id/void`.
- `uncollectible` can be voided with `POST /v1/invoices/:id/void`.
- `paid` is terminal for this cleanup path and must be retained.
- `void` is terminal and already retained.

Source: https://docs.stripe.com/invoicing/integration/workflow-transitions

Stripe's delete-draft endpoint permanently deletes one-off draft invoices, but
it explicitly says invoices that are finalized or are for a subscription must
be voided instead. For subscription draft cleanup, do not delete. Finalize the
draft invoice with `auto_advance: false`, then void it if the finalized result
is `open` or `uncollectible`.
Sources:

- https://docs.stripe.com/api/invoices/delete
- https://docs.stripe.com/api/invoices/finalize
- https://docs.stripe.com/api/invoices/void

Voiding applies only to finalized invoices, preserves an audit paper trail, and
cannot be undone.
Source: https://docs.stripe.com/api/invoices/void

## Cleanup Policy

For each invoice returned by `stripe.invoices.list({ subscription, limit,
starting_after })`, process only invoices whose `subscription` still matches
the requested subscription ID. The list endpoint should already filter, but the
helper checks defensively before mutating.

| Starting status | Operation | Result classification |
| --- | --- | --- |
| `draft` | `finalizeInvoice(id, { auto_advance: false })`, then `voidInvoice(id)` if finalized status is `open` or `uncollectible` | `finalized_and_voided`, `already_void`, or `retained_paid` |
| `open` | `voidInvoice(id)` | `voided` |
| `uncollectible` | `voidInvoice(id)` | `voided` |
| `void` | No mutation | `already_void` |
| `paid` | No mutation | `retained_paid` |
| `null` / unknown | No mutation | Permanent cleanup error |

If a draft finalize response is still `draft` or returns an unknown status, the
helper treats that as a permanent cleanup error because the next safe operation
is ambiguous. If finalization returns `paid`, retain it. If it returns `void`,
treat it as already void.

Pagination is bounded. If Stripe still reports `has_more` after `maxPages`, the
helper raises a retryable bounded-pagination error so the later teardown worker
can reschedule instead of looping indefinitely.

## Error Classification

Use deterministic idempotency keys for every Stripe `POST` mutation and retry
network-uncertain operations with the same key. Stripe documents that network
errors are indeterminate and should be retried with the same idempotency key,
and that official client libraries support bounded automatic retries with
exponential backoff.
Sources:

- https://docs.stripe.com/error-low-level
- https://docs.stripe.com/error-handling?lang=node

Retryable errors:

- `StripeAPIConnectionError` / network connection failures
- `StripeAPIError` / Stripe server errors
- `StripeRateLimitError` or HTTP `429`
- HTTP `5xx`
- Local bounded-pagination exhaustion

Permanent until fixed:

- `StripeInvalidRequestError`
- `StripeAuthenticationError`
- `StripePermissionError`
- `StripeIdempotencyError`
- Other Stripe `4xx` content/auth/permission/idempotency errors, except `429`
- Unknown or invalid invoice state returned by Stripe

Request options:

- List calls pass `{ maxNetworkRetries }` when supplied by the caller.
- `finalizeInvoice` and `voidInvoice` pass `{ idempotencyKey,
  maxNetworkRetries }`.
- `maxNetworkRetries` is normalized to a finite non-negative integer and capped
  at 2; `0` is preserved for tests or intentionally no-retry callers.
- Idempotency keys are stable, deterministic, operation-scoped, and kept under
  Stripe's 255-character key limit.

## Test Evidence

The isolated mocked contract test
`src/lib/account-offboarding/__tests__/stripe-invoices.test.ts` proves behavior
for subscription invoices in `draft`, `open`, `uncollectible`, `void`, and
`paid` states, exact idempotency keys, bounded pagination, defensive
subscription filtering, and retryable versus permanent error classification.
