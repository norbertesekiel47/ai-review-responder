# Pilot Invoice Review Template

Month: YYYY-MM
Reviewer:
Review date:

## Scope

- Include every multi-location account with `accounts.flags.is_pilot = true`.
- Run after at least one successful `StripeLocationsReconcilePoller` cycle for the account.
- Complete before launching a new paid multi-location pilot.

## Accounts Reviewed

| Account ID | Stripe customer | Tier | Active locations | Included locations | Stored overage cents | Stripe preview total | RepWorth expected total | Result |
|---|---|---|---:|---:|---:|---:|---:|---|
|  |  |  |  |  |  |  |  | Pending |

## Reconciliation Evidence

- Last clean reconciliation cycle timestamp:
- Sentry drift event links reviewed:
- Stripe upcoming invoice preview links reviewed:
- Notes on any waived, expected, or grandfathered differences:

## Sign-off

- [ ] No quantity drift above one cent remains unexplained.
- [ ] Overage quantity uses stored `accounts.locations_included`.
- [ ] Overage price uses stored `accounts.locations_overage_price_cents`.
- [ ] Base price matches current `TIER_CONFIG.baseCents`.
- [ ] Any pilot drift has an owner and follow-up date.

Decision:
