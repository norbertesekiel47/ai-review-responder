---
paths:
  - "src/lib/locations/**"
  - "src/lib/accounts/**"
  - "src/lib/payments/**"
  - "worker/jobs/billing/**"
  - "worker/ingress/stripe/**"
  - "worker/ingress/stripe.ts"
  - "worker/background/pollers/billing-reconciliation/**"
  - "src/app/api/billing/**"
  - "src/app/api/locations/**"
---

# Locations and billing rules

## Read first

- Multi-location (locations lifecycle, per-location overage billing, account-level digests, channel overrides) or the two-location full-loop: spec `docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md` + plan `docs/superpowers/plans/2026-06-09-multi-location-hardening.md` + runbook `docs/runbooks/multi-location-e2e-full-loop.md`.
- Lab notes: `.claude/reference/lab-notes/billing-multi-location.md` (stored-quota vs `TIER_CONFIG`, base price not grandfathered, channel account-scope desync), `.claude/reference/lab-notes/stripe.md` (inbound_events payload shape, overage idempotency, reconciliation from stored quota, the stripe-node retry-once behaviour).
- File map: `docs/directory/lib-dashboard-locations-accounts.md` § `locations/` and § `accounts/`; `docs/directory/lib-admin-onboarding-payments.md` § `payments/`; `docs/directory/worker-jobs-*.md` (billing/); `docs/directory/worker-ingress.md` (stripe); `docs/directory/worker-background.md` (billing-reconciliation/).
- Tier prices: change them via the procedure in `.claude/reference/env-vars.md`, never by editing a Stripe Price `unit_amount` (`.claude/CLAUDE.md` § Tech stack, Stripe).

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md` for this area; the binding constraints stay there: invariant #9 (`businesses` = location, `accounts` = billing parent; stored quota + price, never live `TIER_CONFIG`; the three distinct multi-location checks), invariant #11 (`subscriptionGrantsFullAccess`, never a raw `=== 'active'`; `apply-subscription-state.ts` is the single status applier), and the Stripe client-factory rule (`getStripe()`, never `new Stripe()`).

## Rules

- Nothing was moved from `.claude/CLAUDE.md`.
