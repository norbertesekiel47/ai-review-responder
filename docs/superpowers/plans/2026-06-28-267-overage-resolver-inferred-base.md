# Plan — #267: Unify the reconcile poller's base-item resolution into the overage resolver (inferred fallback)

Branch: `refactor/267-overage-resolver-inferred-base` · Billing path · Behavior-preserving.

## Problem

`worker/background/pollers/billing-reconciliation/reconcile-account.ts` derives the
base subscription item NEGATIVELY:

```ts
const baseItem = subscriptionItems.find((item) => item.id !== overageItem?.id);
```

while `subscription-updated` resolves it POSITIVELY via the price-tier-map
(`tierForBasePriceId`). The poller's negative `find` is INTENTIONALLY weaker — it
must tolerate rotated / legacy / grandfathered base prices (which are NOT in the
env price-tier-map) so the `price_mismatch` drift signal can still fire — but that
intent currently lives as an unlabeled `find`, i.e. folklore, not a documented type.

## Critical constraint

The poller MUST keep producing `price_mismatch` for a legacy/rotated/grandfathered
base price. A naive "positive-only" resolution would return no base item for an
unmapped price and silently swallow that drift. The fix must make the tolerance
explicit in the type — without losing it.

## Decision: add a sibling `resolveSubscriptionBilling` (do NOT change `resolveOverageItem`)

`resolveOverageItem` returns `OverageItemResolution` and is the single owner of the
overage predicate, depended on by FOUR call sites (overage-sync worker,
tier-change route, subscription-updated ingress, reconcile poller) plus a full
test suite. Changing its return type to `{ base, overage }` would force churn on
the positive callers and risk the behavior-preserving constraint.

Instead add a deeper sibling that COMPOSES `resolveOverageItem` (preserving the
single owner) and adds positive base resolution + the documented inferred fallback:

```ts
export type BaseItemResolution =
  | { item: Stripe.SubscriptionItem; tier: SubscriptionTierValue }       // positive (price known)
  | { item: Stripe.SubscriptionItem; tier: null; inferred: true };       // fallback (price unknown/legacy/rotated)

export interface SubscriptionBillingResolution {
  base: BaseItemResolution | undefined;   // undefined when there is no non-overage item
  overage: OverageItemResolution;         // delegated to resolveOverageItem (unchanged)
}

export function resolveSubscriptionBilling(
  items: Stripe.SubscriptionItem[],
  options: ResolveOverageItemOptions,
): SubscriptionBillingResolution;
```

Base resolution algorithm (positive-first, fallback-second):
1. Resolve overage via `resolveOverageItem`; exclude the resolved overage item id.
2. POSITIVE: first non-overage item whose `price.id` maps via `tierForBasePriceId`
   → `{ item, tier }`.
3. INFERRED FALLBACK: else the FIRST non-overage item → `{ item, tier: null, inferred: true }`.
   This is byte-equivalent to the poller's old `find(item => item.id !== overageItem?.id)`.
4. else `base: undefined`.

Behavior preservation note: in the canonical RepWorth subscription shape (base +
optional overage), positive-first === first-non-overage, so the resolved base item
is identical to the old negative `find`. In the unit-test harness env is unset →
`tierForBasePriceId` always returns null → base is ALWAYS the inferred fallback →
identical item to the old `find`. The only theoretical divergence (a non-base,
non-overage item sorted before a mapped base) does not occur in RepWorth and would
be strictly more correct anyway.

## Poller change

- Import `resolveSubscriptionBilling` instead of `resolveOverageItem`.
- `const billing = resolveSubscriptionBilling(items, { storedOveragePriceCents })`.
- `overageResolution = billing.overage` (everything downstream unchanged).
- Replace `subscriptionItems.find(...)` with `const baseItem = billing.base?.item`,
  documenting that the inferred fallback is the load-bearing tolerance for a
  rotated base price.

Positive callers (subscription-updated, tier-change, overage-sync) are NOT touched —
strictly behavior-preserving.

## TDD order

1. RED→GREEN — resolver unit tests (`src/lib/payments/__tests__/overage-item.test.ts`):
   add a `resolveSubscriptionBilling` describe. RED because the symbol does not exist
   yet; GREEN after implementing it. Covers: positive (tier known), inferred fallback
   (legacy price), fallback excludes the overage item, base undefined for overage-only
   and empty subs.
2. SAFETY LOCK — poller regression test (`worker/.../__tests__/reconcile-account.test.ts`):
   "still flags price_mismatch for a legacy/rotated/grandfathered base price". Per the
   issue, confirm it PASSES against the current (old) poller BEFORE switching — proving
   the drift currently fires and the refactor must not regress it.
3. Implement `resolveSubscriptionBilling`; rerun resolver tests → GREEN.
4. Switch the poller; rerun poller suites (`reconcile-account*.test.ts`,
   `StripeLocationsReconcilePoller.test.ts`) → all GREEN (drift preserved).

## Verify gate (end)

`pnpm lint && pnpm typecheck && pnpm test`; billing/DB-touching →
`pnpm ci:tenant-scope && pnpm ci:rls-audit`. All green, then commit referencing #267.

## Files

- `src/lib/payments/overage-item.ts` — add `resolveSubscriptionBilling` + types.
- `worker/background/pollers/billing-reconciliation/reconcile-account.ts` — consume it.
- `src/lib/payments/__tests__/overage-item.test.ts` — resolver tests.
- `worker/background/pollers/__tests__/reconcile-account.test.ts` — safety-lock test.
- `docs/superpowers/plans/2026-06-28-267-overage-resolver-inferred-base.md` — this plan.
