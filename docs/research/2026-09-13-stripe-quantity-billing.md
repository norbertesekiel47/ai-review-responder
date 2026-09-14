# Stripe: billing locations as quantity on one base item

**Status: kept for the facts only.** This was researched for a three-tier repricing
plan (Copilot / Navigator / Autopilot, per-location quantity billing). The owner
cancelled that plan on 2026-09-13 and kept the two tiers Copilot and Autopilot. The
map and tickets it cites (#1280–#1287) were deleted; do not look them up. The Stripe
behaviour below still applies to today's billing code — in particular finding 3, which
describes a live under-billing risk in `src/lib/accounts/tier-change.ts`.

- API version checked: `2026-05-27.dahlia` (pin in `src/lib/payments/stripe-client.ts`; stripe-node 22.2.0). API reference pages were read with `?api-version=2026-05-27.dahlia`.
- Sources: docs.stripe.com only, read 2026-09-13. No Stripe account data was read. Nothing was tested against a sandbox.
- UNCONFIRMED means the docs do not state it. Test it with a test clock before relying on it.

## Answer table

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Checkout, `quantity > 1` | One line, billed as `quantity × unit_amount`. Quantity is fixed unless you pass `adjustable_quantity` with `enabled: true` (when enabled: min 0, max 99). `payment_method_collection` defaults to `always`, so the card is still collected on a trial. The trial-start invoice is 0. How the hosted page draws the quantity: UNCONFIRMED. | [Checkout create](https://docs.stripe.com/api/checkout/sessions/create?api-version=2026-05-27.dahlia), [Adjustable quantity](https://docs.stripe.com/payments/checkout/adjustable-quantity), [Free trials](https://docs.stripe.com/billing/subscriptions/trials/free-trials) |
| 2 | `subscriptionItems.update({ quantity })` | A quantity change prorates. `create_prorations` (default): pending proration items go on the next invoice. They are billed now only if the billing cycle anchor resets. `always_invoice`: invoice now. `none`: no proration; the next renewal bills the new quantity in full. This endpoint has no `billing_cycle_anchor` parameter. A same-Price quantity change keeps billing dates. Idempotency: the first result is replayed for 24h or more; a reused key with different params errors. | [Update item](https://docs.stripe.com/api/subscription_items/update?api-version=2026-05-27.dahlia), [Prorations](https://docs.stripe.com/billing/subscriptions/prorations), [Change price](https://docs.stripe.com/billing/subscriptions/change-price), [Idempotent requests](https://docs.stripe.com/api/idempotent_requests?api-version=2026-05-27.dahlia) |
| 3 | Swap `items[0].price`, keep quantity | **Quantity resets to 1 unless you send `quantity` again.** You must pass the item `id`, or Stripe adds a second item. The price change prorates (credit old, debit new). Billing dates stay put if the interval is the same. | [Update subscription](https://docs.stripe.com/api/subscriptions/update?api-version=2026-05-27.dahlia), [Change price](https://docs.stripe.com/billing/subscriptions/change-price) |
| 4 | `customer.subscription.updated`, quantity-only | `previous_attributes` holds the old value of each changed attribute. A changed array comes back whole. The dahlia Subscription has no top-level `quantity`, so the change can only appear under `items`. Exact shape (list object or bare array): UNCONFIRMED. Our ingress does not read `previous_attributes` today. | [Event object](https://docs.stripe.com/api/events/object?api-version=2026-05-27.dahlia), [Subscription object](https://docs.stripe.com/api/subscriptions/object?api-version=2026-05-27.dahlia) |
| 5 | `automatic_tax` with `quantity > 1` | No per-unit rounding is documented. Stripe Tax totals the amounts that share a rate, rounds that total half-up, then spreads it back over the lines (a line can move by 1 minor unit). No quantity-specific rule. `tax_behavior` must be set on the Price or as an account default, and it cannot change once set. | [Calculate tax](https://docs.stripe.com/tax/calculating), [Tax behavior](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior), [Manage prices](https://docs.stripe.com/products-prices/manage-prices) |
| 6 | Archived Price (`active: false`) | Subscriptions on it keep billing until they are cancelled. It "can't be used for new purchases" or added to new subscriptions. The exact Checkout error: UNCONFIRMED. Whether a quantity update works on an item with an archived Price: UNCONFIRMED. You can unarchive a Price. | [Manage prices](https://docs.stripe.com/products-prices/manage-prices), [Update price](https://docs.stripe.com/api/prices/update?api-version=2026-05-27.dahlia) |

## Detail

### 1. Checkout Session, `mode: subscription`, `line_items[].quantity > 1`

- `line_items.quantity` is "the quantity of the line item being purchased". Leave it out only for metered prices. A subscription session allows up to 20 recurring line items.
- `adjustable_quantity` is optional. If you leave it out, the customer cannot change the quantity. If you set it, `enabled` is required. Default `minimum` is 0 and default `maximum` is 99 (up to 999999). If `quantity` is over 99, `maximum` must be at least that high. Checkout will not let the customer remove the last item.
- Since `2026-01-28.clover`, the line-items response includes `adjustable_quantity` ([changelog](https://docs.stripe.com/changelog/clover/2026-01-28/line-items-adjustable-quantity)).
- Invoice lines: Stripe's preview-invoice example writes a subscription line as `"1 × Gold product (at $32.52 / month)"` with a `quantity` field. That is the `N × Product (at $X / month)` pattern ([Prorations](https://docs.stripe.com/billing/subscriptions/prorations)). A Product `unit_label` (up to 12 chars, for example "location") is shown in Checkout, on invoices and receipts, and in the portal ([Manage prices](https://docs.stripe.com/products-prices/manage-prices)). The exact look of the hosted Checkout page with quantity N: UNCONFIRMED.
- Trial: `subscription_data.trial_period_days` must be at least 1. `payment_method_collection` "defaults to `always`". `if_required` skips the card when the total is 0. Our code sets `always`, so the card is still collected up front. The trial-start invoice "is still created, but the amount is 0" and says "Free trial". When the trial ends, Stripe invoices the full recurring amount and a new period starts ([Free trials](https://docs.stripe.com/billing/subscriptions/trials/free-trials)).
- Quantity during a trial: "You can update subscriptions in a trial normally." Adding items during a trial produces a 0-amount invoice. The prorations table says an update during a free trial that keeps the trial creates a non-proration debit. A 0 charge for a quantity-only change during a trial is implied but not stated: UNCONFIRMED.
- Near the pin: Checkout creates the subscription only after the customer pays, since `2025-03-31.basil` ([Basil changelog](https://docs.stripe.com/changelog/basil)). `subscription_data.billing_mode.type` "defaults to `flexible`" ([Checkout create](https://docs.stripe.com/api/checkout/sessions/create?api-version=2026-05-27.dahlia)). Our code never sets `billing_mode`.

### 2. `subscriptionItems.update({ quantity })`

- The API reference says `proration_behavior` covers the case "if an item's `quantity` changes". The default is `create_prorations`.
  - `create_prorations`: creates proration invoice items that "will only be invoiced immediately under certain conditions". The condition is a billing cycle anchor reset ("Stripe immediately attempts payment when a subscription's billing cycle anchor is reset"). Otherwise "positive prorations aren't immediately billed" and the items wait for the next invoice.
  - `always_invoice`: "calculates the proration, then immediately generates an invoice".
  - `none`: no proration items. "Customers are billed the full amount at the new price when the next invoice is generated."
- `billing_cycle_anchor` is not a parameter on `POST /v1/subscription_items/:id`. It is on `subscriptions.update`, with values `now` or `unchanged`.
- Flexible billing mode (the default for new API subscriptions from `2025-09-30.clover`) "never automatically" resets the anchor. Classic resets it when the interval changes or a zero-amount price becomes non-zero ([Compare billing modes](https://docs.stripe.com/billing/subscriptions/billing-mode/compare), [Billing mode](https://docs.stripe.com/billing/subscriptions/billing-mode)). A quantity change on the same Price does neither, so billing dates stay the same.
- Going from quantity 0 to a non-zero quantity on a non-zero price "doesn't generate an invoice or reset the billing period" ([Change price](https://docs.stripe.com/billing/subscriptions/change-price)).
- Credit prorations (a lower quantity) depend on billing mode. Flexible credits "based on the last price billed". Classic credits at the current price, even for time that was never paid ([Prorations](https://docs.stripe.com/billing/subscriptions/prorations)). `2026-05-27.dahlia` added `proration_details.credited_items` on invoice items ([Dahlia changelog](https://docs.stripe.com/changelog/dahlia)). Which mode our existing live subscriptions use was not checked (that needs an account read): UNCONFIRMED.
- Stripe prorates to the second. Pass `proration_date` to make a preview match the real update.
- `payment_behavior` default: `allow_incomplete`. If a payment fails, the subscription goes `past_due`. `pending_if_incomplete` applies the update only after payment succeeds.
- Idempotency: Stripe saves the status and body of the first request "regardless of whether it succeeds or fails", 500s included. It compares params and "errors if they're not the same". Keys can be pruned once they are at least 24h old; after that the same key runs as a new request. Validation failures and requests that clash with a concurrent request are not saved, so they are safe to retry. `overage-sync.ts` already puts the target quantity in its key, so keys differ when quantities differ.

### 3. `subscriptions.update` swapping `items[0].price`, keeping quantity

- `items.price`: "When changing a subscription item's price, `quantity` is set to 1 unless a `quantity` parameter is provided." `subscription_items/update` says the same. The guide says to "include it in the update".
- `items.id`: "If you omit `id`, the API adds a new subscription item rather than updating the existing one."
- A price change triggers proration (credit for unused time on the old price, debit for the rest of the period on the new one). The same `proration_behavior` options apply. With the same `interval` and `interval_count`, "the subscription retains the same billing dates".
- The docs show no multi-quantity proration example. That the prorated amounts scale with quantity is implied but not shown: UNCONFIRMED.
- Codebase note: `src/lib/accounts/tier-change.ts:401-412` calls `subscriptionItems.update` with `price` and `proration_behavior` but **no `quantity`**. Under quantity billing, that call would drop the account to 1 billed location.

### 4. `customer.subscription.updated` for a quantity-only change

- `data.previous_attributes`: "Object containing the names of the updated attributes and their values prior to the event… If an array attribute has any updated elements, this object contains the entire array." Stripe has sent whole arrays since `2017-05-25` ([changelog](https://docs.stripe.com/changelog/2017-05-25/events-previous-attributes-render-complete-sub-array)).
- The dahlia Subscription object has no top-level `quantity` or `plan`. Quantity exists only as `items.data[].quantity`. So a quantity-only change can only show up under `previous_attributes.items`.
- Not documented, so UNCONFIRMED: whether `previous_attributes.items` is the full list object (`{ object, data, … }`) or just `data`, and which other keys come with it on a proration update (for example `latest_invoice`).
- Codebase check at this branch's base: `rg previous_attributes src worker` (excluding tests) finds nothing. `worker/ingress/stripe/subscription-updated.ts` checks `data.object.items.data` through `resolveSubscriptionBilling`. The premise that "the ingress validator relies on `previous_attributes`" does not match the current code.

### 5. Stripe Tax `automatic_tax` with quantity > 1

- Line amount: when a Price uses `unit_amount_decimal`, rounding happens per line item "after multiplying the quantity by the decimal amount". With an integer `unit_amount`, `quantity × unit_amount` is already exact ([Manage prices](https://docs.stripe.com/products-prices/manage-prices)).
- Tax: "For automatic tax, Stripe calculates tax across amounts that have the same applicable tax rate before rounding the total tax. Stripe then allocates the rounded tax total back to each line item. A line item might receive an adjustment of the smallest currency unit." Rounding is half-up ([Calculate tax](https://docs.stripe.com/tax/calculating)). Tax is not rounded per unit.
- With automatic tax, invoices always sum first and then round. The line-level rounding setting applies only to manual tax rates ([Tax rates](https://docs.stripe.com/tax/tax-rates)).
- `tax_behavior`: "You must specify a `tax_behavior` on a price, or a default tax behavior in the tax settings". It "can't [be] change[d] after it's been set to exclusive or inclusive". To change it, create a new Price and archive the old one.
- Discounts come off before tax. Stripe only calculates tax where you are registered; elsewhere tax is 0.
- The docs state no quantity-specific tax rule.

### 6. Archiving a Price that a subscription still uses

- "If you archive a price, any existing subscriptions that use the price remain active until they're canceled and any existing payment links that use the product are deactivated." Archiving stops the Price being "added to new invoices or subscriptions" ([Manage prices](https://docs.stripe.com/products-prices/manage-prices)).
- `active`: "Whether the price can be used for new purchases." You can set it back to `true` ([Update price](https://docs.stripe.com/api/prices/update?api-version=2026-05-27.dahlia)).
- Prices created with `price_data` are `active=false` from the start and still bill. So an inactive Price on an existing item is a supported state.
- Not documented, so UNCONFIRMED:
  - the exact error when a Checkout Session uses an archived Price (the docs only say it can't be used for new purchases);
  - whether `subscriptionItems.update({ quantity })` works on an item whose Price is archived;
  - whether a swap *to* an archived Price is rejected.

## Near-pin version notes

- `2025-09-30.clover`: new API subscriptions (Checkout included) default to `billing_mode: flexible`. That changes credit prorations and stops automatic anchor resets. Migrating to flexible is one-way ([changelog](https://docs.stripe.com/changelog/clover/2025-09-30/billing-mode-default-flexible)).
- `2026-03-25.dahlia` (first Dahlia version, breaking): renamed the Checkout `ui_mode` values (default is now `hosted_page`) and added decimal quantities on Invoice Items. No change to subscription-item quantity or proration was found.
- `2026-05-27.dahlia` (the pin): added `proration_details.credited_items`. It also stopped returning subscription item `billed_until` by default.
- `2026-06-24.dahlia` (after the pin, not available to us): added billing cycle anchor config for Checkout Sessions.

## Implications for the quantity-billing decision (#1285)

- Every Price swap must send `quantity` again. `tier-change.ts:401-412` omits it today and would reset billed locations to 1.
- `proration_behavior` stays a per-call choice. `create_prorations` defers charges to the next invoice, `always_invoice` charges now, `none` is a clean contraction. One item does not force a single policy.
- Ingress can keep reading `data.object.items.data[0].quantity`. Do not build a validator on `previous_attributes.items` until a test-clock event confirms its shape.
- Quantity keys: keep the target quantity in the idempotency key, as `overage-sync.ts` does. A reused key with different params errors; it does not apply a new quantity.
- Stripe Tax adds no quantity constraint. Set `tax_behavior` explicitly on the new tier Prices, because it cannot change later.
- New Prices can replace old ones safely: archiving leaves existing subscriptions billing. Before relying on it, confirm with a test clock that quantity updates still work on an archived-Price item, and confirm the billing mode of live subscriptions.
