# Plan — F2/P8: bound Stripe calls under tier-change locks

Intake: `.feature/intake.json` (RISK=high, backend, not db-touching).
Ticket: `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md` §F2.

## Locked design (owner-signed 2026-07-16 + deltas 2026-07-20)

- **Mechanism:** per-call Stripe `RequestOptions` overrides (NOT a second client).
- **Bound:** `{ timeout: 8_000, maxNetworkRetries: 0 }` per call. Worst case 3
  sequential calls ⇒ ~24s lock hold (down from ~60s+).
- **Recovery on timeout:** none added. tx rolls back → route 502
  `tier_change_failed` → caller retries same `Idempotency-Key` (Stripe replays via
  the unchanged per-step idempotency keys); `customer.subscription.updated`
  webhook reconciles any Stripe-side mutation that landed. Pre-existing behavior.

## Seam (codebase-design)

Deepen the existing `stripeOptions()` helper in `src/lib/accounts/tier-change.ts`.
One new authoritative constant owns the bound; two consumers read it:

```
const STRIPE_UNDER_LOCK_REQUEST_OPTIONS = { timeout: 8_000, maxNetworkRetries: 0 } as const;

// mutations (POST): idempotency key + bound
function stripeOptions(accountId, operationKey, step) {
  return { ...STRIPE_UNDER_LOCK_REQUEST_OPTIONS, idempotencyKey: `tier-change:${accountId}:${operationKey}:${step}` };
}

// read (GET, no idempotency key): bound only
await getStripe().subscriptions.retrieve(account.stripe_subscription_id, STRIPE_UNDER_LOCK_REQUEST_OPTIONS);
```

No new module, no new interface, `getStripe()` stays the sole client.

## In-scope Stripe calls (all inside applyTierChangeInTx, under both locks)

1. `subscriptions.retrieve` — tier-change.ts:612 (currently NO options arg).
2. base `subscriptionItems.update` — :384 (via `stripeOptions(...,'base')`).
3. overage `update`/`create`/`del` — :399/409/419 (via `stripeOptions`).

Out of scope: `synchronizeBusinessTierMirror` runs AFTER the main tx (line 718)
in its OWN separate transaction and is DB-only (no Stripe call) — untouched.
(It does take an entitlement lock in tier-snapshot.ts, but a short DB-only one
in a distinct tx, so it is irrelevant to the Stripe-call bound.)

## Tasks (single tracer bullet; no blocking edges)

### T1 — bound all under-lock Stripe calls (TDD)

- **Red:** new `src/lib/accounts/__tests__/tier-change-stripe-timeout.test.ts`
  (reuse the `getStripe()` vi.fn mock pattern from `tier-change.test.ts`):
  - example per overage kind (update/create/delete/none): base update + overage
    call each carry `{ timeout: 8000, maxNetworkRetries: 0 }`.
  - example: `subscriptions.retrieve` carries the same bound.
  - example: per-step idempotency keys unchanged.
  - **fast-check property** (`invariants` describe block, sentiment.test.ts style):
    over arbitrary active-location counts / overage shapes, every recorded Stripe
    mock call's RequestOptions has `timeout===8000 && maxNetworkRetries===0`.
- **Green:** add the constant, spread into `stripeOptions()`, pass to `retrieve`.
- **Refactor:** confirm no literal bound values leak to call sites (one owner).

## Verification (step 5 gate)

Standard gate: `pnpm lint && pnpm typecheck && pnpm test` + every `ci:*` audit.
No `verification_commands` beyond standard (backend, not db-touching, not ui).

## Risks / explicitly accepted

- 8s could time out a legitimately-slow proration write (rare; p99 < 3s).
  Accepted by owner 2026-07-20 — caller retry + webhook reconcile cover it.
- `maxNetworkRetries: 0` removes in-call network-blip resilience under lock.
  Accepted: retries balloon lock hold; op is caller-retryable + Stripe-idempotent.
- Drift-until-webhook window on caller abandonment is pre-existing (the current
  20s/2-retry client has the same rollback-after-Stripe-mutation window); not new.
