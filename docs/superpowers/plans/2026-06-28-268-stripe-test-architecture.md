# Plan — #268 Stripe webhook test architecture (de-dupe mock-sql + per-handler split)

Status: in progress
Branch: `test/268-stripe-suite`
Risk: ZERO production risk — test-only relocation + de-duplication. No source under
`worker/ingress/stripe/**` or `src/**` is touched.

## Problem

`worker/__tests__/helpers/mock-sql.ts` is the repo-canonical Postgres.js mock
(`mockSql / sqlReturnQueue / sqlCalls / resetMockSql`, plus `createMockSql`,
`mkTaggedResult`, fragment-aware lazy thenables). Two Stripe ingress suites
hand-roll their own inline copy:

- `worker/ingress/__tests__/stripe-webhook-handlers.test.ts` (1859 lines, 9
  top-level describes, 53 runtime tests)
- `worker/ingress/__tests__/stripe-activation-enqueue.test.ts` (460 lines, 11
  tests)

## Brainstorm findings (decisions locked, self-resolved)

1. **The local copies are NOT byte-identical to the shared helper** (the issue
   said "byte-identical" — it is wrong on the detail, right on the intent). Both
   suites use an EAGER mock: every ``sql`…` `` call synchronously records to
   `sqlCalls` and shifts `sqlReturnQueue`, computing text as
   `Array.from(strings).join('?')`. The shared helper is a LAZY, fragment-aware
   mock: it records/shifts only on `await`, and inlines nested ``sql`…` ``
   fragments into the parent text.

2. **The two mocks are behaviorally equivalent for these suites.** Verified the
   Stripe handlers (`worker/ingress/stripe/*.ts`, `shared.ts`) use ZERO nested
   ``sql`/`tx` `` fragments and `await` every flat query. With no fragments and
   only flat awaited queries:
   - text: `join('?')` produces exactly one `?` per bound value, identical to the
     lazy mock's interleave (`#strings === #values + 1`).
   - values: raw values === flattened values (no fragments to flatten).
   - queue consumption + `sqlCalls` order: identical (one shift per awaited query).
   `jsonb` is mocked to identity in both suites, so object payloads land as plain
   `?` values in both mocks. Therefore the swap is behavior-preserving; the verify
   gate (full `pnpm test`) is the proof.

3. **`mockSql.mockImplementationOnce(throw)`** (VAL-BILLING-067) works identically:
   the shared `mockSql` is a real `vi.fn`, so a one-shot throwing impl fires on the
   first ``sql`…` `` call inside the tx (same as eager). `sql.begin` is a separate
   `vi.fn` and is not consumed by `mockImplementationOnce`.

4. **The shared helper does NOT need extending.** Its surface
   (`createMockSql` → `{ mockSql, sqlReturnQueue, sqlCalls, resetMockSql }` +
   `mkTaggedResult`) covers everything both suites need. No change to
   `worker/__tests__/helpers/mock-sql.ts`.

5. **The webhook-handlers queue helpers are shared across describes**
   (`queueSubscriptionUpdated` → describes 1/6/9; `queueSubscriptionDeleted` →
   4/8; `queueInvoicePaid` → 3/8; `queueInvoicePaymentFailed` → 2/7;
   `queueCheckoutActivate` → 5/8). Splitting per-handler therefore requires a
   shared fixtures module, or ~250 lines of scaffolding duplicated across 9 files
   (which would re-create the very duplication this issue removes). Decision: add
   one shared fixtures module that builds the mock graph from the canonical
   `createMockSql` and exports the queue helpers bound to that graph.

## New shared fixtures module

`worker/ingress/__tests__/helpers/stripe-webhook-harness.ts` (a `*.ts`, not
`*.test.ts`, so invisible to the vitest include glob `**/__tests__/**/*.test.{ts,tsx}`).

Exports:
- Constants `TEST_ACCOUNT_ID`, `TEST_CUSTOMER_ID`, `TEST_SUBSCRIPTION_ID`,
  `PRICE_ENV_VARS`.
- Pure helpers `mkRequest`, `mkReply`.
- `installStripeWebhookEnv()` — sets the Stripe secret/webhook + price env vars
  the handlers read at call time, returns a restore fn for `afterAll`.
- `createStripeWebhookHarness()` — builds `createMockSql()` + the three extra
  `vi.fn` mocks (`mockClaimInboundEvent`, `mockConstructEvent`,
  `mockWriteAccountAuditLog`), a `resetStripeWebhookMocks()` (verbatim of the
  original `beforeEach` body), and the five queue helpers bound to its own queue.
  Queue-helper bodies are transcribed VERBATIM from the original file (incl. their
  SQL-sequence comments) so the queued return sequences are byte-for-byte the same.

Per test file wiring (the canonical mock-sql async-hoisted pattern):
```ts
const { mockSql, sqlReturnQueue, sqlCalls, mockClaimInboundEvent,
        mockConstructEvent, mockWriteAccountAuditLog, resetStripeWebhookMocks,
        queue… } = await vi.hoisted(async () => {
  const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
  return createStripeWebhookHarness();
});
vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v) => v }));
vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));
vi.mock('stripe', () => ({ default: class FakeStripe { webhooks = { constructEvent: mockConstructEvent }; } }));
```
Each file imports only the symbols its describe body uses (lint: no-unused-vars on
`**/*.ts`).

## Per-handler file-split mapping (from `stripe-webhook-handlers.test.ts`)

Mirrors `worker/ingress/stripe/*` for the per-handler describes; cross-cutting
describes (reverse-map / idempotency / audit / out-of-order) keep their own files
1:1 with the original describe (verbatim describe + it titles).

| New file | Source describe (lines) | Runtime tests |
|---|---|---|
| `stripe-subscription-updated.test.ts` | `customer.subscription.updated — two-item subscription` (316–914) | 17 |
| `stripe-invoice-payment-failed.test.ts` | `invoice.payment_failed — sets account to past_due` (920–1021) | 4 |
| `stripe-invoice-paid.test.ts` | `invoice.paid — active recovery from past_due` (1027–1167) | 6 |
| `stripe-subscription-deleted.test.ts` | `customer.subscription.deleted — sets account to cancelled` (1173–1322) | 6 |
| `stripe-checkout-completed.test.ts` | `checkout.session.completed — account activation` (1368–1466) | 3 |
| `stripe-reverse-map.test.ts` | `Stripe reverse-map includes all 7 price IDs` (1472–1558) | 7 (2 loop-`it`s → 4+3) |
| `stripe-idempotency.test.ts` | `Webhook idempotency and error handling` (1564–1625) | 3 |
| `stripe-audit.test.ts` | `subscription_status_changed audit logging` (1631–1744) | 4 |
| `stripe-out-of-order.test.ts` | `out-of-order delivery …` (1754–1859) | 3 |
| (delete) `stripe-webhook-handlers.test.ts` | — | — |

Split subtotal: 17+4+6+6+3+7+3+4+3 = **53** (== original webhook-handlers runtime).

`stripe-activation-enqueue.test.ts` stays in place; only its inline mock-sql block
is swapped for `createMockSql` (keeps its own env/resetModules/local helpers).
It keeps **11** tests.

## Before/after test-count guarantee

- Before: 64 (`stripe-webhook-handlers` 53 + `stripe-activation-enqueue` 11).
- After: 53 (9 split files) + 11 (activation-enqueue) = **64**. Zero loss.

## Verify gate

`pnpm lint && pnpm typecheck && pnpm test` from the worktree root — all green.
Re-run the count proof:
`pnpm vitest run worker/ingress/__tests__/stripe-*.test.ts` must show 64 tests.

## Files

- Add: `worker/ingress/__tests__/helpers/stripe-webhook-harness.ts`
- Add: 9 `worker/ingress/__tests__/stripe-*.test.ts` files (table above)
- Change: `worker/ingress/__tests__/stripe-activation-enqueue.test.ts` (mock-sql swap only)
- Remove: `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`
- Unchanged: `worker/__tests__/helpers/mock-sql.ts`
