# Founders price-lock column (`accounts.base_price_cents`) + read path

**Date:** 2026-05-28
**Branch:** `feat/launch-p1-base-price-cents`
**Source task:** `docs/launch-ready-part1.md` — Suggested order, item 4
**Architecture invariant:** CLAUDE.md #9(a) — billing snapshot reads STORED quota from
`accounts` (point-in-time, grandfathered). Base price is currently the *lone un-stored
exception*. This spec closes that exception.

## Problem

`accounts` already stores point-in-time quota values (`locations_included`,
`locations_overage_price_cents`) snapshotted from `TIER_CONFIG` at tier-commit time, so
existing accounts are grandfathered against future config changes. **Base price is the
one value still read live** from `TIER_CONFIG[tier].baseCents` in every billing-math
consumer. Three sites carry TODOs documenting this gap:

- `src/lib/accounts/quota.ts:90` — `currentBillingSnapshot` (customer-facing)
- `src/lib/admin/margin-service.ts:64` — `monthlyMrrCents` (admin MRR/margin)
- `worker/background/pollers/billing-reconciliation/expected-invoice.ts:24` —
  `expectedInvoiceForAccount` (Stripe drift detection)

Stripe grandfathers the original base Price ID on existing subscriptions. So if a tier's
base price ever changes in `TIER_CONFIG` (most relevantly the **`founders`** tier, whose
marketing copy promises *"Rate locked for life"*), these reads drift from the actual
charge. The reconciliation consequence is worst: `expectedInvoiceForAccount` would compute
the wrong expected base and raise a **false `price_mismatch` drift alert** against the
(correct) locked Stripe amount.

## Decisions (confirmed during brainstorming)

1. **Read-path scope:** all three live consumers (snapshot + MRR + expected-invoice).
   `validateTierChange` is intentionally **excluded** — it previews the *new* tier at
   *current* prices, so it must keep reading `TIER_CONFIG`.
2. **Snapshot source:** `TIER_CONFIG[tier].baseCents`, mirroring exactly how the sibling
   columns are already captured. The point-in-time write *is* the grandfathering.
3. **Column shape:** strict `NOT NULL` with a backfill (matches the siblings). Rejected
   the nullable + `COALESCE(base_price_cents, TIER_CONFIG…)` fallback — it leaves the
   drift hazard live for any un-backfilled row and contradicts invariant #9(a).

## Design

### 1. Migration `054_accounts_base_price_cents.sql`

Mirror the migration-053 pattern (add column, backfill, constrain) and bump the registry.

```sql
ALTER TABLE accounts ADD COLUMN base_price_cents INTEGER;

-- Backfill existing rows from the CURRENT TIER_CONFIG base prices. Safe now:
-- prices have not drifted yet, so this capture equals what each account is charged.
-- This snapshot IS the grandfathering for the founders "rate locked for life" promise.
UPDATE accounts SET base_price_cents = CASE subscription_tier
  WHEN 'basic'    THEN 2900
  WHEN 'standard' THEN 7900
  WHEN 'premium'  THEN 19900
  WHEN 'founders' THEN 1900
  ELSE 7900            -- defensive: unknown legacy tier → standard base
END
WHERE base_price_cents IS NULL;

ALTER TABLE accounts ALTER COLUMN base_price_cents SET NOT NULL;
ALTER TABLE accounts ALTER COLUMN base_price_cents SET DEFAULT 7900;  -- mirrors subscription_tier DEFAULT 'standard'
ALTER TABLE accounts ADD CONSTRAINT accounts_base_price_cents_nonneg CHECK (base_price_cents >= 0);
```

- Registry: `.claude/reference/migrations-log.md` — add the 054 entry, advance head
  053→054, next 055. Also update the `## Database` head pointer in `.claude/CLAUDE.md`
  if it names the current head (head **053**, next **054**).
- **TDD red first:** `src/lib/shared/__tests__/migration-054-structure.test.ts` parsing
  the SQL to assert the column add, NOT NULL, DEFAULT, CHECK, and backfill CASE are
  present (mirror `migration-034-structure.test.ts` / the 053 structure test).

### 2. Write sites — snapshot `base_price_cents = TIER_CONFIG[tier].baseCents`

Add the column to the same INSERT/UPDATE statements that already write the siblings:

- `src/lib/onboarding/create-business.ts`
  - `runAdminTx` INSERT (~line 199): add `base_price_cents` column + `${tierConfig?.baseCents ?? 7900}`
  - `runSelfServeTx` INSERT (~line 327): same (self-serve hardcodes `standard` → 7900)
- `src/app/api/onboarding/select-plan/route.ts` (~line 206): add
  `base_price_cents = ${tierConfig?.baseCents ?? 7900}` to the `UPDATE accounts SET …`
- `worker/ingress/stripe/subscription-updated.ts` (~line 72): re-snapshot **only on tier
  change**, mirroring the `locations_included` clause:
  `base_price_cents = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].baseCents} ELSE base_price_cents END`
  This preserves the lock on non-tier updates (quantity-only changes leave it untouched).

### 3. Read sites — consume the stored column

- `src/lib/accounts/quota.ts` `currentBillingSnapshot`: add `base_price_cents` to the
  account SELECT; use `account.base_price_cents` for `basePriceCents` and in the
  `totalCents` math for both the no-overage and overage branches. Delete the TODO block.
- `src/lib/admin/margin-service.ts` `monthlyMrrCents`: add a `basePriceCents: number`
  param; use it instead of `config.baseCents` in both branches. Update its caller
  `getMarginReport` to SELECT `a.base_price_cents` and pass it; update the local
  `AccountRow` interface. Delete the TODO.
- `worker/background/pollers/billing-reconciliation/expected-invoice.ts`
  `expectedInvoiceForAccount`: use `Number(account.base_price_cents)` for `baseCents` and
  in `totalCents`. Delete the TODO. (`config` is still needed for `multiLocAllowed`.)

`config.baseCents` stays the source only inside `validateTierChange` (by design).

### 4. Supporting surface (types, fixtures, queries threaded to the read sites)

- `src/lib/accounts/repo.ts`: add `base_price_cents: number` to `AccountRow`; add the
  column to the `getAccountById` SELECT.
- `worker/background/pollers/billing-reconciliation/types.ts`: add `base_price_cents:
  number` to `BillingReconciliationAccount` and `AccountWithLocations`.
- `worker/background/pollers/StripeLocationsReconcilePoller.ts`: add `a.base_price_cents`
  to the SELECTs (~lines 79–80, 93–94) that hydrate those types.
- `src/lib/__fixtures__/account-location.ts`: add a per-tier `base_price_cents` default
  (basic 2900 / standard 7900 / premium 19900 / founders 1900), mirroring the existing
  per-tier `locations_included` / `locations_overage_price_cents` switches.
- `docs/runbooks/multi-location.md`: mark the "Base price not grandfathered" Known-Issues
  row resolved (reference migration 054 + this spec).

## Testing (TDD)

Write the failing test first at each layer, then implement:

1. **Migration structure test** (above) — red until the SQL exists.
2. **`currentBillingSnapshot`**: set `base_price_cents` to a value that **differs** from
   `TIER_CONFIG[tier].baseCents` (e.g. stored 1500 for a `founders` row while config says
   1900) and assert the snapshot returns the **stored** value in both `basePriceCents`
   and `totalCents`. This is the regression guard that proves the read no longer uses
   `TIER_CONFIG`.
3. **`monthlyMrrCents`**: update existing cases to pass `basePriceCents`; add a case where
   `basePriceCents` ≠ the tier's config base and assert the stored value wins.
4. **`expectedInvoiceForAccount`**: add a case where stored base ≠ config base and assert
   the expected invoice uses the stored base (guards against false drift alerts).
5. **Write sites**: extend `create-business` / select-plan / subscription-updated tests to
   assert `base_price_cents` is persisted, and that the webhook leaves it **unchanged** on
   a non-tier (quantity-only) update but **re-snapshots** it on a tier change.
6. **Fixtures**: `account-location` fixture test asserts the new per-tier default.

## Verification

Run in the sibling worktree (NOT a nested one — project rule):
`pnpm lint && pnpm typecheck && pnpm test`, plus the DB-touching gates
`pnpm ci:tenant-scope && pnpm ci:rls-audit`. Land via PR (main is protected); the 4 CI
checks must be green.

## Out of scope

- Reading the live Stripe `unit_amount` as the snapshot source (considered, rejected —
  deviates from the established pattern and only exists at the webhook site).
- Any change to `validateTierChange` semantics.
- Opening the currently-waitlisted Basic/Standard/Premium tiers or any pricing-page copy.
- Changing actual Stripe prices or Price IDs.

## Risks & mitigations

- **Backfill correctness:** valid only while `TIER_CONFIG` base prices equal what existing
  accounts are charged — true today. Mitigation: ship before any base-price change; the
  migration comment states this assumption.
- **Missed write site → NOT NULL violation:** the `DEFAULT 7900` backstops any INSERT path
  that forgets the column, preventing a hard failure (at the cost of a wrong-but-safe
  standard base). All four known write sites set it explicitly; tenant-scope/RLS audits
  and the write-site tests catch regressions.
- **Type drift across the three reconciliation/query layers:** `typecheck` enforces the
  added `base_price_cents` field end-to-end once it's on the interfaces.
