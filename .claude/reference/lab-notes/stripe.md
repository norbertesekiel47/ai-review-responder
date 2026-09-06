# Lab notes — Stripe

## Summary

- **Stripe** — inbound_events payload shape, overage idempotency, billing reconciliation from stored quota; `maxNetworkRetries: 0` still retries ONCE on ECONNRESET/EPIPE (stripe-node 22.2.0 `_shouldRetry` — under-lock worst case ≈ 2× the per-call timeout, #514)

## Canonical entries

### Changing a tier price = new Stripe Price ID + env lockstep; existing customers are grandfathered
A Stripe Price `unit_amount` is immutable, so a price change means a **new Price object**. RepWorth
grandfathers via the stored snapshot on `accounts` (`base_price_cents` / `locations_included` /
`locations_overage_price_cents`, migration 054, invariant #9a) — billing reads those, not live
`TIER_CONFIG`. **Correct approach:** the documented procedure in `env-vars.md` — new Price → point
`STRIPE_PRICE_*` at it in dev+staging+prod lockstep → match `TIER_CONFIG` → `pnpm verify:stripe-prices`.
New signups/tier-changers get the new price; existing subs keep theirs. Repricing *existing* customers
is a separate cohort migration + ARL §17602(g) notice (out of scope). `TIER_CONFIG` and the Stripe
`unit_amount` are two copies of one fact with no runtime assertion — `verify:stripe-prices` is the guard.

## History

- history/2026-04.md § "Stripe `inbound_events.payload` structure"
- history/2026-05.md § "Stripe overage: same-account serialization is the in-tx lock, not the replica count"
- history/2026-05.md § "CSV bulk-import: enqueue ONE aggregate Stripe overage job, not one-per-row"
- history/2026-05.md § "Billing reconciliation must compute expected invoice from STORED quota, not live `TIER_CONFIG`"
- history/2026-06.md § "Stripe Basil/Dahlia: `current_period_end` is on the subscription ITEM, not the top level"
- history/2026-06.md § "A pinned Stripe `apiVersion` does NOT pin webhook payload shapes"
- history/2026-06.md § "Stripe `tax_behavior` is immutable once set; `tax_code` lives on the Product, not the Price"
- history/2026-06.md § "Dahlia preview-invoice lines expose `pricing.unit_amount_decimal`, not `price.unit_amount`"
- history/2026-06.md § "A $0 card-up-front trial Checkout reports `payment_status='paid'`, NOT `'no_payment_required'`"
- history/2026-06.md § "Staging Stripe webhook was missing `invoice.payment_action_required` (the SCA event)"
- history/2026-06.md § "Stripe converts a trial (`trialing→active`) BEFORE the renewal charge fails → `trial_payment_failed` is effectively unreachable for a card decline"
- history/2026-07.md § "[2026-07-21] `maxNetworkRetries: 0` is NOT a single-attempt guarantee — stripe-node retries ONCE on a first-attempt ECONNRESET/EPIPE before the maxRetries guard"
- history/2026-08-21-to-31.md § "[2026-08-31] Created a live Stripe coupon under a fresh id → the environment already named a different one"
- history/2026-08-21-to-31.md § "[2026-08-31] A 3-month coupon's 4th cycle cannot be rendered from a real Checkout → prove it from the discount's `end`, and say so"
- history/2026-08-21-to-31.md § "2026-08-31 — WS8 Phase F.4: the first live Checkout, and two commissioning gaps"
