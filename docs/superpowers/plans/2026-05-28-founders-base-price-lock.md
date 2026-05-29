# Founders price-lock column (`accounts.base_price_cents`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the monthly base price on `accounts` so it is grandfathered/point-in-time, removing the last live-`TIER_CONFIG` read from the billing-math paths (CLAUDE.md invariant #9a) and making the `founders` "rate locked for life" promise real.

**Architecture:** Mirror the existing stored-quota pattern (`locations_included`, `locations_overage_price_cents`) exactly. Add a NOT-NULL `base_price_cents` column (backfilled from current `TIER_CONFIG`), snapshot it from `TIER_CONFIG[tier].baseCents` at the four tier-commit sites, and read it back in the three billing-math consumers. `validateTierChange` intentionally stays on live `TIER_CONFIG` (it previews the *new* tier at *current* prices).

**Tech Stack:** TypeScript (strict), Next.js 16 route handlers, Postgres.js tagged-template `sql`, Vitest, Supabase SQL migrations. pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-founders-base-price-lock-design.md`

**Working directory:** sibling worktree `/Users/norbertesekiel/Developer/startups/repworth-wt/base-price-cents` on branch `feat/launch-p1-base-price-cents`. Run all commands from there. NEVER run lint/test from a nested worktree (project rule).

**Conventions for every task below:**
- Tests mock the Postgres.js `sql` tagged template (`vi.mock('@/lib/db/server')`); they feed row arrays and inspect captured templates via `(call[0] as TemplateStringsArray).join('?')` and bound values via `call.slice(1)`.
- TIER_CONFIG base prices (ground truth): `basic 2900`, `standard 7900`, `premium 19900`, `founders 1900`.
- Run a single test file with: `pnpm exec vitest run <path>`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/054_accounts_base_price_cents.sql` | Add + backfill + constrain the column | **Create** |
| `src/lib/shared/__tests__/migration-054-structure.test.ts` | Assert migration SQL shape | **Create** |
| `.claude/reference/migrations-log.md` | Migration registry | Modify (entry + head) |
| `.claude/CLAUDE.md` | Head pointer line | Modify (053→054) |
| `src/lib/accounts/quota.ts` | `currentBillingSnapshot` read | Modify |
| `src/lib/accounts/__tests__/quota.test.ts` | Snapshot tests | Modify |
| `worker/background/pollers/billing-reconciliation/types.ts` | Reconciliation account types | Modify |
| `worker/background/pollers/billing-reconciliation/expected-invoice.ts` | Expected-invoice read | Modify |
| `worker/background/pollers/StripeLocationsReconcilePoller.ts` | Account SELECTs | Modify |
| `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts` | expected-invoice + factory | Modify |
| `worker/background/pollers/__tests__/reconcile-account.test.ts` | `makeAccount` factory | Modify |
| `src/lib/admin/margin-service.ts` | `monthlyMrrCents` + `getMarginReport` | Modify |
| `src/lib/admin/__tests__/margin-service.test.ts` | MRR tests | Modify |
| `src/lib/onboarding/create-business.ts` | Two account INSERTs | Modify |
| `src/lib/onboarding/__tests__/create-business.test.ts` | INSERT assertions | Modify |
| `src/app/api/onboarding/select-plan/route.ts` | Account UPDATE | Modify |
| `src/app/api/onboarding/__tests__/select-plan.test.ts` | UPDATE assertion | Modify |
| `worker/ingress/stripe/subscription-updated.ts` | Webhook UPDATE (CASE WHEN) | Modify |
| `worker/ingress/__tests__/stripe-webhook-handlers.test.ts` | Webhook assertions | Modify |
| `src/lib/accounts/repo.ts` | `AccountRow` + `getAccountById` | Modify |
| `src/lib/accounts/__tests__/repo.test.ts` | repo assertions | Modify |
| `src/lib/__fixtures__/account-location.ts` | Fixture factory | Modify |
| `src/lib/__fixtures__/__tests__/account-location.test.ts` | Fixture test | Modify |
| `docs/runbooks/multi-location.md` | Known-issue → resolved | Modify |

---

## Task 1: Migration 054 — add, backfill, and constrain `base_price_cents`

**Files:**
- Create: `supabase/migrations/054_accounts_base_price_cents.sql`
- Test: `src/lib/shared/__tests__/migration-054-structure.test.ts`
- Modify: `.claude/reference/migrations-log.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: Write the failing structure test**

Create `src/lib/shared/__tests__/migration-054-structure.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/054_accounts_base_price_cents.sql',
);

let sql: string;
let normalized: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
  normalized = sql.replace(/\s+/g, ' ');
});

describe('migration 054 — accounts.base_price_cents founders price-lock', () => {
  it('adds the base_price_cents column idempotently', () => {
    expect(normalized).toMatch(
      /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS base_price_cents INTEGER/,
    );
  });

  it('backfills existing rows per current tier from TIER_CONFIG values', () => {
    expect(normalized).toMatch(/UPDATE accounts SET base_price_cents = CASE subscription_tier/);
    expect(normalized).toMatch(/WHEN 'basic' THEN 2900/);
    expect(normalized).toMatch(/WHEN 'standard' THEN 7900/);
    expect(normalized).toMatch(/WHEN 'premium' THEN 19900/);
    expect(normalized).toMatch(/WHEN 'founders' THEN 1900/);
    expect(normalized).toContain('WHERE base_price_cents IS NULL');
  });

  it('sets a standard default and NOT NULL after backfill', () => {
    expect(normalized).toMatch(/ALTER COLUMN base_price_cents SET DEFAULT 7900/);
    expect(normalized).toMatch(/ALTER COLUMN base_price_cents SET NOT NULL/);
  });

  it('adds a non-negative CHECK constraint guarded idempotently and scoped to accounts', () => {
    expect(normalized).toContain('accounts_base_price_cents_nonneg');
    expect(normalized).toMatch(/CHECK \(base_price_cents >= 0\)/);
    expect(normalized).toContain("conname = 'accounts_base_price_cents_nonneg'");
    expect(normalized).toContain("t.relname = 'accounts'");
  });

  it('does not drop or mutate unrelated structure', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP CONSTRAINT/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/shared/__tests__/migration-054-structure.test.ts`
Expected: FAIL — `ENOENT` (migration file does not exist yet).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/054_accounts_base_price_cents.sql`:

```sql
-- 054_accounts_base_price_cents.sql
-- Founders price-lock: store the monthly base price (cents) on accounts so it is
-- grandfathered/point-in-time, closing the last live-TIER_CONFIG read in the
-- billing snapshot (CLAUDE.md invariant #9a). Mirrors locations_included /
-- locations_overage_price_cents. Additive + idempotent + re-runnable.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS base_price_cents INTEGER;

-- Backfill existing rows from the CURRENT TIER_CONFIG base prices. Safe now:
-- prices have not drifted, so this capture equals what each account is charged
-- (Stripe grandfathers the original base Price ID). This snapshot IS the
-- grandfathering for the founders "rate locked for life" promise. Re-running is
-- a no-op (WHERE base_price_cents IS NULL).
UPDATE accounts SET base_price_cents = CASE subscription_tier
  WHEN 'basic'    THEN 2900
  WHEN 'standard' THEN 7900
  WHEN 'premium'  THEN 19900
  WHEN 'founders' THEN 1900
  ELSE 7900            -- defensive: unknown legacy tier -> standard base
END
WHERE base_price_cents IS NULL;

-- Default mirrors subscription_tier's DEFAULT 'standard'; backstops any INSERT
-- path that omits the column (wrong-but-safe rather than a NOT NULL failure).
ALTER TABLE accounts ALTER COLUMN base_price_cents SET DEFAULT 7900;
ALTER TABLE accounts ALTER COLUMN base_price_cents SET NOT NULL;

-- Non-negative guard, idempotent via catalog lookup scoped to the accounts
-- relation (conname is unique only per-table, not globally).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'accounts_base_price_cents_nonneg'
      AND t.relname = 'accounts'
      AND n.nspname = 'public'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_base_price_cents_nonneg
      CHECK (base_price_cents >= 0);
  END IF;
END $$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/lib/shared/__tests__/migration-054-structure.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Update the migration registry and head pointers**

In `.claude/reference/migrations-log.md`, change line 4 from:
`Current head: **053** — next migration is **054**`
to:
`Current head: **054** — next migration is **055**`

Then append after the `- **053** …` entry (after line 352):

```markdown
- **054** — `accounts.base_price_cents` founders price-lock (launch-ready-part1
  item 4). **Adds** nullable `base_price_cents` (INTEGER), backfills existing rows
  per current tier from `TIER_CONFIG` base prices (basic 2900 / standard 7900 /
  premium 19900 / founders 1900; `WHERE base_price_cents IS NULL`, so re-running
  is a no-op), then `SET DEFAULT 7900` (mirrors `subscription_tier DEFAULT
  'standard'`) and `SET NOT NULL`, plus a non-negative CHECK
  (`accounts_base_price_cents_nonneg`, guarded idempotently by a `pg_constraint`
  lookup **scoped to the accounts relation**). Closes CLAUDE.md #9a's lone
  un-stored exception: base price is now grandfathered/point-in-time like
  `locations_included` / `locations_overage_price_cents`, read in
  `currentBillingSnapshot`, `monthlyMrrCents`, and `expectedInvoiceForAccount`.
  Additive + re-runnable.
```

In `.claude/CLAUDE.md`, find the `## Database` line `Base schema: …; current head: migration **053** (next: **054**)` and change it to `current head: migration **054** (next: **055**)`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/054_accounts_base_price_cents.sql \
        src/lib/shared/__tests__/migration-054-structure.test.ts \
        .claude/reference/migrations-log.md .claude/CLAUDE.md
git commit -m "feat(billing): migration 054 add accounts.base_price_cents (founders price-lock)"
```

---

## Task 2: Read path — `currentBillingSnapshot` reads the stored base

**Files:**
- Modify: `src/lib/accounts/quota.ts` (SELECT ~line 62-72; usage ~line 83-126)
- Test: `src/lib/accounts/__tests__/quota.test.ts` (helper ~line 95-107; new test in the `currentBillingSnapshot` describe)

- [ ] **Step 1: Write the failing test (stored ≠ config guard) and extend the mock helper**

In `src/lib/accounts/__tests__/quota.test.ts`, replace the `mockAccountRow` helper (lines 95-107) with a version that includes `base_price_cents` (defaulting to the tier's config base so existing assertions stay valid):

```typescript
function mockAccountRow(
  tier: SubscriptionTierValue,
  locationsIncluded: number,
  locationsPaid: number,
  locationsOveragePriceCents: number = tier === 'premium' ? 2000 : tier === 'basic' ? 0 : 2500,
  basePriceCents: number = tier === 'basic' ? 2900 : tier === 'premium' ? 19900 : tier === 'founders' ? 1900 : 7900,
) {
  return {
    subscription_tier: tier,
    locations_included: locationsIncluded,
    locations_paid: locationsPaid,
    locations_overage_price_cents: locationsOveragePriceCents,
    base_price_cents: basePriceCents,
  };
}
```

Then add this test at the end of the `describe('currentBillingSnapshot', …)` block (after line 274, before the closing `});`):

```typescript
  it('reads stored base_price_cents, not live TIER_CONFIG (founders price-lock)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Founders row whose STORED base (1500) differs from TIER_CONFIG.founders.baseCents (1900).
    mockSql.mockResolvedValueOnce([
      mockAccountRow('founders', 1, 0, 2500, 1500),
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(3)); // 2 overage units

    const snapshot = await currentBillingSnapshot(accountId);

    expect(snapshot.basePriceCents).toBe(1500);
    expect(snapshot.totalCents).toBe(1500 + 2 * 2500);
  });

  it('reads stored base_price_cents for a no-overage (basic) snapshot', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Basic row with a stored base (2600) different from config (2900).
    mockSql.mockResolvedValueOnce([
      mockAccountRow('basic', 1, 0, 0, 2600),
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(1));

    const snapshot = await currentBillingSnapshot(accountId);

    expect(snapshot.basePriceCents).toBe(2600);
    expect(snapshot.totalCents).toBe(2600);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/accounts/__tests__/quota.test.ts -t "stored base_price_cents"`
Expected: FAIL — both new tests get `1900` / `2900` (live config) instead of `1500` / `2600`.

- [ ] **Step 3: Implement — SELECT and use the stored column in `quota.ts`**

In `src/lib/accounts/quota.ts`, change the account SELECT row type + columns (lines 62-72) to include `base_price_cents`:

```typescript
  const [account] = await sql<{
    subscription_tier: string;
    locations_included: number;
    locations_paid: number;
    locations_overage_price_cents: number;
    base_price_cents: number;
  }[]>`
    SELECT subscription_tier, locations_included, locations_paid,
           locations_overage_price_cents, base_price_cents
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;
```

Replace the TODO block (lines 86-96) with a one-line comment and read the stored value. Change the block from line 83 onward so it reads:

```typescript
  const config = TIER_CONFIG[tier];
  const includedLocations = account.locations_included;
  const overagePriceCents = account.locations_overage_price_cents;
  // Base price, included count, and overage price are all read from the stored
  // account columns (point-in-time, grandfathered per CLAUDE.md #9a). config is
  // used only for the multiLocAllowed / overageCents shape decisions below.
  const basePriceCents = account.base_price_cents;

  // Basic tier: no overage at all
  if (!config.multiLocAllowed || config.overageCents === 0) {
    return {
      basePriceCents,
      includedLocations,
      overagePriceCents: 0,
      overageUnits: 0,
      totalCents: basePriceCents,
    };
  }
```

And the final return (lines 120-126):

```typescript
  return {
    basePriceCents,
    includedLocations,
    overagePriceCents,
    overageUnits,
    totalCents: basePriceCents + overageUnits * overagePriceCents,
  };
```

- [ ] **Step 4: Run the full quota test file to verify all pass**

Run: `pnpm exec vitest run src/lib/accounts/__tests__/quota.test.ts`
Expected: PASS (all existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounts/quota.ts src/lib/accounts/__tests__/quota.test.ts
git commit -m "feat(billing): currentBillingSnapshot reads stored base_price_cents"
```

---

## Task 3: Read path — reconciliation `expectedInvoiceForAccount` reads the stored base

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/types.ts` (both account interfaces)
- Modify: `worker/background/pollers/billing-reconciliation/expected-invoice.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts` (SELECTs ~line 79-80, 93-94)
- Test: `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts` (local `AccountRow` ~line 208-235; `makeAccountRow` factory; the "uses stored overage price" test ~line 240; new test)
- Test: `worker/background/pollers/__tests__/reconcile-account.test.ts` (`makeAccount` factory ~line 9-23)

- [ ] **Step 1: Write the failing test and update typed account literals**

In `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`:

1. Add `base_price_cents: number;` to the local `AccountRow` interface (after `locations_overage_price_cents: number;`, ~line 215).
2. In `makeAccountRow` (line 221-235) add `base_price_cents: 7900,` to the returned object (after `locations_overage_price_cents: 2500,`).
3. In the existing "uses stored overage price instead of live tier overage config" test (line 241-251), add `base_price_cents: 7900,` to the inline literal passed to `expectedInvoiceForAccount`.
4. Add this new test immediately after that one (after line 256):

```typescript
  it('uses stored base price instead of live tier base config (founders price-lock)', () => {
    const invoice = expectedInvoiceForAccount({
      id: 'acct-grandfathered-base',
      subscription_tier: 'founders',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      base_price_cents: 1500, // stored != TIER_CONFIG.founders.baseCents (1900)
      locations_included: 1,
      locations_overage_price_cents: 2500,
      active_location_count: 3,
      past_due_at: null,
      flags: {},
    });

    expect(invoice.baseCents).toBe(1500);
    expect(invoice.totalCents).toBe(1500 + 2 * 2500);
  });
```

In `worker/background/pollers/__tests__/reconcile-account.test.ts`, add `base_price_cents: 7900,` to the `makeAccount` factory return object (after `locations_overage_price_cents: 2500,`, ~line 17).

- [ ] **Step 2: Run the tests to verify the new one fails (and confirm the type literals still compile via the run)**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts -t "stored base price"`
Expected: FAIL — `invoice.baseCents` is `1900` (live config) not `1500`. (TypeScript will not error yet because the inline literals carry an extra `base_price_cents` field; that is allowed against the not-yet-extended type at runtime, but we add the type field next.)

- [ ] **Step 3: Implement — add to types, expected-invoice, and poller SELECTs**

In `worker/background/pollers/billing-reconciliation/types.ts`, add `base_price_cents: number;` to BOTH `AccountWithLocations` (after `locations_overage_price_cents: number;`, ~line 8) and `BillingReconciliationAccount` (after `locations_overage_price_cents: number;`, ~line 20).

In `worker/background/pollers/billing-reconciliation/expected-invoice.ts`, change the return (lines 23-28) to read the stored base:

```typescript
  const baseCents = Number(account.base_price_cents);

  return {
    baseCents,
    overageUnits,
    overageUnitPriceCents,
    totalCents: baseCents + overageUnits * overageUnitPriceCents,
  };
```

(Delete the `config.baseCents` usages in the return and the TODO if present; `config` is still used above for `multiLocAllowed`.)

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`, add `a.base_price_cents,` to both account SELECT column lists (after `a.locations_overage_price_cents,` at ~line 80 and ~line 94).

- [ ] **Step 4: Run both reconciliation test files to verify all pass**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts worker/background/pollers/__tests__/reconcile-account.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/billing-reconciliation/types.ts \
        worker/background/pollers/billing-reconciliation/expected-invoice.ts \
        worker/background/pollers/StripeLocationsReconcilePoller.ts \
        worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts \
        worker/background/pollers/__tests__/reconcile-account.test.ts
git commit -m "feat(billing): reconciliation expected-invoice reads stored base_price_cents"
```

---

## Task 4: Read path — admin `monthlyMrrCents` reads the stored base

**Files:**
- Modify: `src/lib/admin/margin-service.ts` (`monthlyMrrCents` ~line 64-83; `getMarginReport` SELECT ~line 129-137; local `AccountRow` ~line 104-112; call site ~line 165-170)
- Test: `src/lib/admin/__tests__/margin-service.test.ts` (`monthlyMrrCents` describe ~line 37-53)

- [ ] **Step 1: Write the failing test and update existing MRR calls**

In `src/lib/admin/__tests__/margin-service.test.ts`, update every `monthlyMrrCents({...})` call in the `describe('monthlyMrrCents …')` block to pass `basePriceCents` (the tier's base). The block becomes:

```typescript
describe('monthlyMrrCents (mirrors currentBillingSnapshot)', () => {
  it('standard tier base only when at included count', () => {
    expect(monthlyMrrCents({ tier: 'standard', basePriceCents: 7900, includedLocations: 1, overagePriceCents: 2500, activeLocations: 1 })).toBe(7900);
  });
  it('standard tier adds overage per extra active location', () => {
    expect(monthlyMrrCents({ tier: 'standard', basePriceCents: 7900, includedLocations: 1, overagePriceCents: 2500, activeLocations: 3 })).toBe(7900 + 2 * 2500);
  });
  it('basic tier never adds overage', () => {
    expect(monthlyMrrCents({ tier: 'basic', basePriceCents: 2900, includedLocations: 1, overagePriceCents: 0, activeLocations: 5 })).toBe(2900);
  });
  it('premium tier includes 5 before overage', () => {
    expect(monthlyMrrCents({ tier: 'premium', basePriceCents: 19900, includedLocations: 5, overagePriceCents: 2000, activeLocations: 6 })).toBe(19900 + 2000);
  });
  it('unknown tier → 0 (excluded from margin)', () => {
    expect(monthlyMrrCents({ tier: 'mystery', basePriceCents: 7900, includedLocations: 1, overagePriceCents: 0, activeLocations: 1 })).toBe(0);
  });
  it('reads stored basePriceCents, not live tier config (founders price-lock)', () => {
    // founders stored base 1500 differs from TIER_CONFIG.founders.baseCents (1900)
    expect(monthlyMrrCents({ tier: 'founders', basePriceCents: 1500, includedLocations: 1, overagePriceCents: 2500, activeLocations: 3 })).toBe(1500 + 2 * 2500);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/admin/__tests__/margin-service.test.ts -t "monthlyMrrCents"`
Expected: FAIL — TypeScript/runtime: `basePriceCents` is not yet a parameter (the founders case returns `1900 + 2*2500`, others may still pass since they equal config). The founders case fails.

- [ ] **Step 3: Implement — add the param and read it**

In `src/lib/admin/margin-service.ts`, replace the TODO (lines 64-65) and `monthlyMrrCents` (lines 66-83) with:

```typescript
/** Monthly recurring revenue in cents. Mirrors currentBillingSnapshot's formula. */
export function monthlyMrrCents(input: {
  tier: string;
  basePriceCents: number;
  includedLocations: number;
  overagePriceCents: number;
  activeLocations: number;
}): number {
  if (!isSubscriptionTier(input.tier)) return 0;
  const config = TIER_CONFIG[input.tier];
  if (!config.multiLocAllowed || config.overageCents === 0) {
    return input.basePriceCents;
  }
  const overageUnits = computeOverageQuantity(
    input.activeLocations,
    input.includedLocations,
  );
  return input.basePriceCents + overageUnits * input.overagePriceCents;
}
```

Add `base_price_cents: number;` to the local `AccountRow` interface (after `locations_overage_price_cents: number;`, ~line 110).

Add `a.base_price_cents,` to the `getMarginReport` account SELECT (after `a.locations_included, a.locations_overage_price_cents,` at ~line 131).

Update the call site (lines 165-170) to pass the stored base:

```typescript
    const mrrCents = monthlyMrrCents({
      tier: acct.subscription_tier,
      basePriceCents: acct.base_price_cents,
      includedLocations: acct.locations_included,
      overagePriceCents: acct.locations_overage_price_cents,
      activeLocations: acct.active_locations,
    });
```

- [ ] **Step 4: Run the full margin test file**

Run: `pnpm exec vitest run src/lib/admin/__tests__/margin-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/margin-service.ts src/lib/admin/__tests__/margin-service.test.ts
git commit -m "feat(billing): monthlyMrrCents reads stored base_price_cents"
```

---

## Task 5: Write site — `create-business` snapshots base at signup

**Files:**
- Modify: `src/lib/onboarding/create-business.ts` (`runAdminTx` INSERT ~line 199-213; `runSelfServeTx` INSERT ~line 327-341)
- Test: `src/lib/onboarding/__tests__/create-business.test.ts` (the `describe('createBusinessTx — tier config fields …')` block ~line 249-301)

- [ ] **Step 1: Write the failing test additions**

In `src/lib/onboarding/__tests__/create-business.test.ts`, add base-price assertions:

- To the standard admin test (after line 256): `expect(accountsCall.some((a: unknown) => a === 7900)).toBe(true);`
- To the premium test (after line 269): `expect(accountsCall.some((a: unknown) => a === 19900)).toBe(true);`
- To the basic test (after line 282): `expect(accountsCall.some((a: unknown) => a === 2900)).toBe(true);`
- To the self_serve standard test (after line 291): `expect(accountsCall.some((a: unknown) => a === 7900)).toBe(true);`
- To the column-presence test (after line 300): `expect(template).toContain('base_price_cents');`

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/onboarding/__tests__/create-business.test.ts -t "tier config fields"`
Expected: FAIL — `base_price_cents` not in the INSERT; the new `some(... === 7900/19900/2900)` and `toContain('base_price_cents')` assertions fail.

- [ ] **Step 3: Implement — add the column + value to both INSERTs**

In `src/lib/onboarding/create-business.ts` `runAdminTx` (lines 199-213), change the column list and VALUES:

```typescript
    await tx`
      INSERT INTO accounts (
        id, owner_user_id, display_name,
        subscription_tier, subscription_status,
        locations_included, locations_overage_price_cents, base_price_cents
      ) VALUES (
        ${accountId}::uuid,
        ${userId}::uuid,
        ${adminInput.businessName},
        ${adminInput.subscriptionTier},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${tierConfig?.included ?? 1},
        ${tierConfig?.overageCents ?? 2500},
        ${tierConfig?.baseCents ?? 7900}
      )
    `;
```

In `runSelfServeTx` (lines 327-341), the same addition (self-serve uses the `standard` `tierConfig`):

```typescript
    await tx`
      INSERT INTO accounts (
        id, owner_user_id, display_name,
        subscription_tier, subscription_status,
        locations_included, locations_overage_price_cents, base_price_cents
      ) VALUES (
        ${accountId}::uuid,
        ${userId}::uuid,
        ${PLACEHOLDER_BUSINESS_NAME},
        ${selfServeTier},
        ${SubscriptionStatus.PENDING_PAYMENT},
        ${tierConfig?.included ?? 1},
        ${tierConfig?.overageCents ?? 2500},
        ${tierConfig?.baseCents ?? 7900}
      )
    `;
```

Also update the two `VAL-BILLING-064` comments above each INSERT to mention `base_price_cents` (append `, base_price_cents` to the existing "Snapshots locations_included and locations_overage_price_cents" line).

- [ ] **Step 4: Run the full create-business test file**

Run: `pnpm exec vitest run src/lib/onboarding/__tests__/create-business.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding/create-business.ts src/lib/onboarding/__tests__/create-business.test.ts
git commit -m "feat(billing): snapshot base_price_cents at signup (create-business)"
```

---

## Task 6: Write site — `select-plan` snapshots base on plan choice

**Files:**
- Modify: `src/app/api/onboarding/select-plan/route.ts` (UPDATE ~line 205-214)
- Test: `src/app/api/onboarding/__tests__/select-plan.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/app/api/onboarding/__tests__/select-plan.test.ts`, find the test that drives a successful plan selection (the one asserting the `UPDATE businesses` / founders tier — around line 334). Add an assertion that the `UPDATE accounts` template carries the column and the bound founders base value. Add, in that test body:

```typescript
    const updateAcctCall = mockSql.mock.calls.find((c: unknown[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('UPDATE accounts'),
    );
    expect(updateAcctCall).toBeDefined();
    const updateAcctText = (updateAcctCall![0] as TemplateStringsArray).join('?');
    expect(updateAcctText).toContain('base_price_cents');
    // founders base = 1900 is bound into the UPDATE
    expect(updateAcctCall!.slice(1)).toContain(1900);
```

(If the success test uses a tier other than `founders`, use that tier's base value instead: standard 7900 / premium 19900 / basic 2900.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/app/api/onboarding/__tests__/select-plan.test.ts`
Expected: FAIL — `base_price_cents` not present in the UPDATE; bound value absent.

- [ ] **Step 3: Implement — add the column to the UPDATE**

In `src/app/api/onboarding/select-plan/route.ts` (lines 206-214), add `base_price_cents` to the `SET`:

```typescript
    const tierConfig = TIER_CONFIG[tier as SubscriptionTierValue];
    const update = await tx`
      UPDATE accounts
      SET subscription_tier = ${tier},
          locations_included = ${tierConfig?.included ?? 1},
          locations_overage_price_cents = ${tierConfig?.overageCents ?? 2500},
          base_price_cents = ${tierConfig?.baseCents ?? 7900},
          updated_at = NOW()
      WHERE id = (SELECT account_id FROM businesses WHERE id = ${businessId}::uuid)
        AND subscription_status = ${SubscriptionStatus.PENDING_PAYMENT}
    `;
```

Also append `, base_price_cents` to the `VAL-BILLING-065` comment above the UPDATE (lines 202-204).

- [ ] **Step 4: Run the full select-plan test file**

Run: `pnpm exec vitest run src/app/api/onboarding/__tests__/select-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/onboarding/select-plan/route.ts src/app/api/onboarding/__tests__/select-plan.test.ts
git commit -m "feat(billing): snapshot base_price_cents on select-plan"
```

---

## Task 7: Write site — Stripe webhook re-snapshots base only on tier change

**Files:**
- Modify: `worker/ingress/stripe/subscription-updated.ts` (UPDATE ~line 67-75)
- Test: `worker/ingress/__tests__/stripe-webhook-handlers.test.ts` (same-tier test ~line 334-363; tier-change test ~line 299-328)

- [ ] **Step 1: Write the failing test additions**

In `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`:

- In the "preserves custom locations_included when Stripe sends same-tier overage-only update" test (the assertion at line 363), add right after it:

```typescript
    expect(updateAcct!.text).toMatch(/base_price_cents\s*=\s*CASE\s+WHEN\s+\?\s+THEN\s+\?\s+ELSE\s+base_price_cents\s+END/);
```

- In the "refreshes locations_included to premium default when Stripe changes tier from standard to premium" test (after the `expect(updateAcct!.text).toContain('locations_included');` at line 328), add:

```typescript
    expect(updateAcct!.text).toContain('base_price_cents');
    // tier changed standard -> premium, so the premium base (19900) is bound
    expect(updateAcct!.values).toContain(19900);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts -t "premium default"`
and `pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts -t "overage-only update"`
Expected: FAIL — `base_price_cents` not present in the UPDATE.

- [ ] **Step 3: Implement — add the CASE WHEN clause**

In `worker/ingress/stripe/subscription-updated.ts` (lines 67-75), add the `base_price_cents` line to the `SET`, mirroring `locations_included`:

```typescript
    await tx`
      UPDATE accounts
      SET
        subscription_tier = ${tier},
        locations_paid = ${locationsPaid},
        locations_included = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].included} ELSE locations_included END,
        base_price_cents = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].baseCents} ELSE base_price_cents END,
        updated_at = NOW()
      WHERE id = ${acctRow.id}::uuid
    `;
```

- [ ] **Step 4: Run the full webhook test file**

Run: `pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/ingress/stripe/subscription-updated.ts worker/ingress/__tests__/stripe-webhook-handlers.test.ts
git commit -m "feat(billing): re-snapshot base_price_cents on Stripe tier change (lock preserved otherwise)"
```

---

## Task 8: Supporting — `repo.ts` exposes `base_price_cents`

**Files:**
- Modify: `src/lib/accounts/repo.ts` (`AccountRow` ~line 22-38; `getAccountById` SELECT ~line 57-76)
- Test: `src/lib/accounts/__tests__/repo.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/accounts/__tests__/repo.test.ts`, add `base_price_cents: 7900,` to the mock account row literal (the object near line 36 that includes `locations_included: 1`). Then, in the first `getAccountById` success test (the one asserting `result!.locations_included` near line 67), add:

```typescript
    expect(result!.base_price_cents).toBe(7900);
```

Also add a SELECT-column assertion in the test that inspects the template (the one with `expect(template).toContain('FROM accounts')` near line 95):

```typescript
    expect(template).toContain('base_price_cents');
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/accounts/__tests__/repo.test.ts`
Expected: FAIL — `result!.base_price_cents` is `undefined` and the template lacks `base_price_cents`.

- [ ] **Step 3: Implement**

In `src/lib/accounts/repo.ts`, add `base_price_cents: number;` to `AccountRow` (after `locations_overage_price_cents: number;`, ~line 34). Add `base_price_cents,` to the `getAccountById` SELECT column list (after `locations_overage_price_cents,`, ~line 70).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/lib/accounts/__tests__/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounts/repo.ts src/lib/accounts/__tests__/repo.test.ts
git commit -m "feat(billing): expose base_price_cents from accounts repo"
```

---

## Task 9: Supporting — fixture factory provides `base_price_cents`

**Files:**
- Modify: `src/lib/__fixtures__/account-location.ts` (`AccountRow` ~line 14-30; `createAccountRow` ~line 41-89)
- Test: `src/lib/__fixtures__/__tests__/account-location.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/__fixtures__/__tests__/account-location.test.ts`, add a test asserting per-tier base defaults (place near the existing account-row tier tests):

```typescript
  it('defaults base_price_cents per tier', () => {
    expect(createAccountRow({ subscription_tier: 'basic' }).base_price_cents).toBe(2900);
    expect(createAccountRow({ subscription_tier: 'standard' }).base_price_cents).toBe(7900);
    expect(createAccountRow({ subscription_tier: 'premium' }).base_price_cents).toBe(19900);
    expect(createAccountRow({ subscription_tier: 'founders' }).base_price_cents).toBe(1900);
  });

  it('respects an explicit base_price_cents override', () => {
    expect(createAccountRow({ subscription_tier: 'founders', base_price_cents: 1500 }).base_price_cents).toBe(1500);
  });
```

(Ensure `createAccountRow` is imported in this test file — it already is for the existing tier tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/__fixtures__/__tests__/account-location.test.ts`
Expected: FAIL — `base_price_cents` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/__fixtures__/account-location.ts`, add `base_price_cents: number;` to the `AccountRow` interface (after `locations_overage_price_cents: number;`, ~line 26). In `createAccountRow`, add a derivation mirroring the existing switches (after the `locations_overage_price_cents` block, ~line 70):

```typescript
  let base_price_cents = overrides.base_price_cents;

  if (base_price_cents === undefined) {
    switch (tier) {
      case 'basic': base_price_cents = 2900; break;
      case 'standard': base_price_cents = 7900; break;
      case 'premium': base_price_cents = 19900; break;
      case 'founders': base_price_cents = 1900; break;
      default: base_price_cents = 7900;
    }
  }
```

Then add `base_price_cents,` to the returned object (after `locations_overage_price_cents,`, ~line 84).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/lib/__fixtures__/__tests__/account-location.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/__fixtures__/account-location.ts src/lib/__fixtures__/__tests__/account-location.test.ts
git commit -m "test(billing): account fixture provides base_price_cents per tier"
```

---

## Task 10: Docs — mark the runbook known-issue resolved

**Files:**
- Modify: `docs/runbooks/multi-location.md` (Known Issues & Tech Debt table, the "Base price not grandfathered" row ~line 459)

- [ ] **Step 1: Update the Known-Issues row**

Replace the "Base price not grandfathered in billing snapshot" table row content so it reads as RESOLVED, e.g.:

```markdown
| Base price not grandfathered in billing snapshot | RESOLVED (migration 054) | `accounts.base_price_cents` now stores the point-in-time base price, snapshotted from `TIER_CONFIG` at signup / select-plan / Stripe tier-change and read in `currentBillingSnapshot`, `monthlyMrrCents`, and `expectedInvoiceForAccount`. Base price is grandfathered like `locations_included` / `locations_overage_price_cents`, so the `founders` "rate locked for life" promise holds even if `TIER_CONFIG` base prices change later. See `docs/superpowers/specs/2026-05-28-founders-base-price-lock-design.md`. |
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/multi-location.md
git commit -m "docs(billing): mark base-price grandfathering resolved (migration 054)"
```

---

## Task 11: Full verification + PR

- [ ] **Step 1: Run the full local gate**

Run (from the worktree, NOT a nested one):
```bash
pnpm lint && pnpm typecheck && pnpm test
```
Expected: all green. If typecheck flags a missing `base_price_cents` on any account literal not covered above, add the field there (value = the tier's base) — this is the cross-layer type-drift backstop the spec calls out.

- [ ] **Step 2: Run the DB-touching CI gates**

Run:
```bash
pnpm ci:tenant-scope && pnpm ci:rls-audit
```
Expected: pass. We added `base_price_cents` only to existing, already-allowlisted SELECTs (no new cross-account query), so no allowlist change is expected. If `ci:tenant-scope` flags a query, inspect — do NOT broaden the allowlist without confirming the query is an existing aggregate-on-read path.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/launch-p1-base-price-cents
gh pr create --title "feat(billing): accounts.base_price_cents founders price-lock + read path" \
  --body "$(cat <<'EOF'
Closes the lone un-stored billing exception (CLAUDE.md #9a): base price moves
from live TIER_CONFIG reads to a stored, grandfathered column, mirroring
locations_included / locations_overage_price_cents.

- Migration 054: add + backfill + NOT NULL/DEFAULT/CHECK
- Snapshot at 4 write sites (signup x2, select-plan, Stripe tier-change — re-snapshot only on tierChanged so the lock is preserved)
- Read in 3 consumers (currentBillingSnapshot, monthlyMrrCents, expectedInvoiceForAccount); validateTierChange intentionally stays on live config
- TDD guards prove the stored value wins over TIER_CONFIG

Spec: docs/superpowers/specs/2026-05-28-founders-base-price-lock-design.md
Plan: docs/superpowers/plans/2026-05-28-founders-base-price-lock.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the 4 CI checks (lint, typecheck, test, build) run on the PR. Confirm all green before merge.

---

## Self-Review (completed by plan author)

**Spec coverage:** migration (Task 1) ✓; read scope = all 3 consumers — snapshot (Task 2), expected-invoice (Task 3), MRR (Task 4) ✓; 4 write sites — create-business x2 (Task 5), select-plan (Task 6), webhook CASE WHEN tierChanged (Task 7) ✓; supporting surface — repo (Task 8), reconciliation types/poller (Task 3), fixtures (Task 9), runbook (Task 10) ✓; `validateTierChange` deliberately untouched ✓; verification incl. tenant-scope/rls (Task 11) ✓.

**Placeholder scan:** none — every code/SQL/test block is concrete; line anchors are "~" because they shift as edits land, but the surrounding code is quoted.

**Type consistency:** `base_price_cents` (snake_case DB/row field) vs `basePriceCents` (camelCase TS param in `monthlyMrrCents`/`BillingSnapshot`) used consistently; `TIER_CONFIG[tier].baseCents` is the single snapshot source at all write sites; backfill values (2900/7900/19900/1900) match `TIER_CONFIG` and the fixture/test defaults everywhere.
