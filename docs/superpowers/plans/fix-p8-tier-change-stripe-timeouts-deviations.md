# P8 tier-change Stripe timeout — deviations

## `subscriptions.retrieve` argument position

The plan specified the two-argument form:

```ts
getStripe().subscriptions.retrieve(account.stripe_subscription_id, STRIPE_UNDER_LOCK_REQUEST_OPTIONS)
```

This does not typecheck against `stripe@22.2.0`. `Subscriptions.retrieve` exposes a
single overload — `retrieve(id, params?: SubscriptionRetrieveParams, options?: RequestOptions)` —
so the second positional argument is bound to `SubscriptionRetrieveParams`, not
`RequestOptions` (TS2559: the bound object has no properties in common with the params type).

Fix applied: pass empty params and put the bound in the third (RequestOptions) slot:

```ts
getStripe().subscriptions.retrieve(account.stripe_subscription_id, {}, STRIPE_UNDER_LOCK_REQUEST_OPTIONS)
```

Still a GET with no idempotency key; behavior and the bound are unchanged.

## Existing `tier-change.test.ts` options assertions

Six `toHaveBeenCalledWith(..., { idempotencyKey })` exact-match assertions on the
Stripe options object broke once the object also carried `timeout`/`maxNetworkRetries`.
Wrapped each in `expect.objectContaining(...)` so the idempotency key stays verified
byte-for-byte while tolerating the added bound fields. Within the allowed edit surface.
