# Follow-up: retire the `accounts.locations_paid` mirror

**Source:** 2026-06-23 core-billing-audit RECONCILE-F1; deferred from PR B (spec §5/B4).
**Status:** tracked, not scheduled.

`accounts.locations_paid` is written from Stripe (`worker/ingress/stripe/subscription-updated.ts`)
and read ONLY for the dashboard "billing pending" badge
(`src/lib/dashboard/aggregate-service.ts` — `locationsIncluded + locationsPaid`).
No billing math reads it: `src/lib/accounts/quota.ts` derives overage from a live
`COUNT(*)` of non-archived `businesses`. PR B (RECONCILE-F1/B4) added a
drift-observability check (`locations_paid_mirror`) that flags when the mirror
diverges from the live Stripe overage quantity — but it did NOT remove the column.
It remains a second representation of a fact whose authoritative owner is the live
count + Stripe, i.e. a "one owner per fact" violation worth retiring.

## To retire ("one owner per fact")

1. Rederive the dashboard "billing pending" badge from the live active-location
   count vs the Stripe overage quantity (or `locations_included` + live overage),
   removing the `locations_paid` read in `aggregate-service.ts`.
2. Drop the write in `subscription-updated.ts` and the `locations_paid_mirror`
   drift check in `worker/background/pollers/billing-reconciliation/reconcile-account.ts`
   (+ remove `locations_paid` from `AccountWithLocations`, the reconcile SELECT/GROUP BY,
   and the `DriftFinding['type']` union — all added in PR B/B4).
3. Migration: drop `accounts.locations_paid` (and any audit references).
4. Update `.claude/reference/migrations-log.md` and `docs/directory.md`.

No behavior depends on the column for billing today, so retirement is a clean,
low-risk simplification once the dashboard badge is rederived.
