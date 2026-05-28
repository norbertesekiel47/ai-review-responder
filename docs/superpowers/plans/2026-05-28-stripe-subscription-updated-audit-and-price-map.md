# Stripe `subscription-updated` Audit + Tier/Price-Map Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #40 — stop the Stripe `customer.subscription.updated` handler from writing noisy no-op audit rows, remove the `?? ''` price-map collision, and give the tier↔Stripe-price-ID mapping a single owner used by all 5 duplicating call sites, while switching the handler to the mandated `writeAccountAuditLog` helper.

**Architecture:** A new pure module `src/lib/payments/price-tier-map.ts` owns the SubscriptionTier↔Stripe-price-ID mapping (forward, reverse, and overage-set), reading env at call time. Five files that currently inline this mapping import from it. The webhook handler additionally dedups its audit payload against the prior `locations_paid` and writes via `writeAccountAuditLog(input, tx)`.

**Tech Stack:** TypeScript (strict), Vitest, Postgres.js (`sql`/`tx`), Stripe SDK types, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-stripe-subscription-updated-audit-and-price-map-design.md`

---

## Worktree validation note (read first)

This branch lives in a worktree nested under `.claude/worktrees/`. Per CLAUDE.md, **local lint/test from a nested worktree can be unreliable** (module resolution can leak into the parent `node_modules`/eslintrc). Targeted `vitest run <file>` is used below for fast TDD feedback and is generally trustworthy for these pure unit tests, but the **authoritative gate is the pushed PR + GitHub CI** (Task 7). If a local run behaves strangely (phantom lint/resolution errors), that is the known leak — push and trust CI rather than chasing it locally.

Targeted test command used throughout: `pnpm exec vitest run <path>`.

## File structure (what changes)

| File | Responsibility | Action |
|---|---|---|
| `src/lib/payments/price-tier-map.ts` | Single owner of tier↔price mapping | **Create** |
| `src/lib/payments/__tests__/price-tier-map.test.ts` | Unit tests incl. collision regression | **Create** |
| `worker/ingress/stripe/subscription-updated.ts` | Webhook handler: use helper, dedup audit, `writeAccountAuditLog` | Modify |
| `worker/ingress/__tests__/stripe-webhook-handlers.test.ts` | Handler tests: queue helper + dedup cases | Modify |
| `scripts/ci/tenant-scope-allowlist.ts` | Update SELECT snippet (adds `locations_paid`) | Modify |
| `src/lib/payments/create-checkout-session.ts` | Use helper, delete local maps | Modify |
| `src/app/api/billing/tier-change/route.ts` | Use helper, delete local maps | Modify |
| `worker/jobs/billing/UpdateStripeOverageWorker.ts` | Use helper, delete local map + inline Set | Modify |
| `worker/background/pollers/billing-reconciliation/stripe-overage.ts` | Remove `getOveragePriceIds()` | Modify |
| `worker/background/pollers/StripeLocationsReconcilePoller.ts` | Import `overagePriceIdSet()` from helper | Modify |

---

## Task 1: Create the `price-tier-map` module (TDD)

**Files:**
- Create: `src/lib/payments/price-tier-map.ts`
- Test: `src/lib/payments/__tests__/price-tier-map.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/payments/__tests__/price-tier-map.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  basePriceIdForTier,
  overagePriceIdForTier,
  tierForBasePriceId,
  isOveragePriceId,
  overagePriceIdSet,
} from '../price-tier-map';

const PRICE_KEYS = [
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
] as const;

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PRICE_KEYS) original[k] = process.env[k];
  process.env.STRIPE_PRICE_BASIC = 'price_basic';
  process.env.STRIPE_PRICE_FOUNDING = 'price_founders';
  process.env.STRIPE_PRICE_STANDARD = 'price_standard';
  process.env.STRIPE_PRICE_PREMIUM = 'price_premium';
  process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_standard_overage';
  process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_premium_overage';
  process.env.STRIPE_PRICE_FOUNDERS_OVERAGE = 'price_founders_overage';
});

afterEach(() => {
  for (const k of PRICE_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe('price-tier-map', () => {
  describe('basePriceIdForTier', () => {
    it('maps each tier to its base price ID', () => {
      expect(basePriceIdForTier('basic')).toBe('price_basic');
      expect(basePriceIdForTier('standard')).toBe('price_standard');
      expect(basePriceIdForTier('premium')).toBe('price_premium');
      expect(basePriceIdForTier('founders')).toBe('price_founders');
    });
    it('returns null when the env var is unset', () => {
      delete process.env.STRIPE_PRICE_STANDARD;
      expect(basePriceIdForTier('standard')).toBeNull();
    });
  });

  describe('overagePriceIdForTier', () => {
    it('maps non-basic tiers to overage price IDs; basic is null', () => {
      expect(overagePriceIdForTier('basic')).toBeNull();
      expect(overagePriceIdForTier('standard')).toBe('price_standard_overage');
      expect(overagePriceIdForTier('premium')).toBe('price_premium_overage');
      expect(overagePriceIdForTier('founders')).toBe('price_founders_overage');
    });
  });

  describe('tierForBasePriceId (reverse map)', () => {
    it('maps each base price ID back to its tier', () => {
      expect(tierForBasePriceId('price_basic')).toBe('basic');
      expect(tierForBasePriceId('price_standard')).toBe('standard');
      expect(tierForBasePriceId('price_premium')).toBe('premium');
      expect(tierForBasePriceId('price_founders')).toBe('founders');
    });
    it('returns null for an unknown price ID', () => {
      expect(tierForBasePriceId('price_unknown')).toBeNull();
    });
    it('returns null for empty/undefined/null input (no empty-string key collision)', () => {
      expect(tierForBasePriceId('')).toBeNull();
      expect(tierForBasePriceId(undefined)).toBeNull();
      expect(tierForBasePriceId(null)).toBeNull();
    });
    it('does not collide when multiple base price vars are unset', () => {
      delete process.env.STRIPE_PRICE_BASIC;
      delete process.env.STRIPE_PRICE_STANDARD;
      expect(tierForBasePriceId('')).toBeNull();
      expect(tierForBasePriceId('price_premium')).toBe('premium');
    });
  });

  describe('overagePriceIdSet / isOveragePriceId', () => {
    it('contains the configured overage IDs only', () => {
      const set = overagePriceIdSet();
      expect(set.has('price_standard_overage')).toBe(true);
      expect(set.has('price_premium_overage')).toBe(true);
      expect(set.has('price_founders_overage')).toBe(true);
      expect(set.has('')).toBe(false);
      expect(set.size).toBe(3);
    });
    it('isOveragePriceId reflects membership', () => {
      expect(isOveragePriceId('price_standard_overage')).toBe(true);
      expect(isOveragePriceId('price_basic')).toBe(false);
      expect(isOveragePriceId('')).toBe(false);
      expect(isOveragePriceId(undefined)).toBe(false);
    });
    it('excludes unset overage vars from the set', () => {
      delete process.env.STRIPE_PRICE_STANDARD_OVERAGE;
      const set = overagePriceIdSet();
      expect(set.has('price_standard_overage')).toBe(false);
      expect(set.size).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/payments/__tests__/price-tier-map.test.ts`
Expected: FAIL — cannot resolve `../price-tier-map` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/payments/price-tier-map.ts`:

```ts
// src/lib/payments/price-tier-map.ts
//
// Single owner of the SubscriptionTier <-> Stripe price-ID mapping. Every
// tier/price lookup (checkout, tier-change, the subscription webhook, the
// overage worker, the reconciliation poller) sources from here so the mapping
// has one authoritative representation.
//
// Env is read at call time (not memoized at import) so tests can stub
// process.env per case; presence-validation stays with the worker's boot-time
// env assertions (worker/config/startup-assert.ts).
//
// Validation contract: VAL-BILLING-009, VAL-BILLING-030, VAL-BILLING-032,
//   VAL-BILLING-055.

import { type SubscriptionTierValue } from '@/lib/accounts/tier-config';

function baseEnvMap(): Record<SubscriptionTierValue, string | undefined> {
  return {
    basic: process.env.STRIPE_PRICE_BASIC,
    standard: process.env.STRIPE_PRICE_STANDARD,
    premium: process.env.STRIPE_PRICE_PREMIUM,
    // The 'founders' tier uses the STRIPE_PRICE_FOUNDING env var (naming quirk
    // documented in tier-config.ts).
    founders: process.env.STRIPE_PRICE_FOUNDING,
  };
}

function overageEnvMap(): Record<SubscriptionTierValue, string | undefined> {
  return {
    basic: undefined, // basic tier has no overage
    standard: process.env.STRIPE_PRICE_STANDARD_OVERAGE,
    premium: process.env.STRIPE_PRICE_PREMIUM_OVERAGE,
    founders: process.env.STRIPE_PRICE_FOUNDERS_OVERAGE,
  };
}

/** tier -> base price ID, or null when the env var is unset/empty. */
export function basePriceIdForTier(tier: SubscriptionTierValue): string | null {
  const id = baseEnvMap()[tier];
  return id && id.length > 0 ? id : null;
}

/** tier -> overage price ID, or null. `basic` is always null. */
export function overagePriceIdForTier(tier: SubscriptionTierValue): string | null {
  const id = overageEnvMap()[tier];
  return id && id.length > 0 ? id : null;
}

/**
 * base price ID -> tier. The reverse map is built ONLY from non-empty IDs, so
 * an empty/undefined price ID can never collide on a shared '' key. Unknown or
 * empty input returns null.
 */
export function tierForBasePriceId(
  priceId: string | null | undefined,
): SubscriptionTierValue | null {
  if (!priceId) return null;
  const entries = Object.entries(baseEnvMap()) as [SubscriptionTierValue, string | undefined][];
  for (const [tier, id] of entries) {
    if (id && id.length > 0 && id === priceId) return tier;
  }
  return null;
}

/** The set of configured (non-empty) overage price IDs. */
export function overagePriceIdSet(): Set<string> {
  return new Set(
    Object.values(overageEnvMap()).filter(
      (id): id is string => Boolean(id && id.length > 0),
    ),
  );
}

/** True when priceId is one of the configured overage price IDs. */
export function isOveragePriceId(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  return overagePriceIdSet().has(priceId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/payments/__tests__/price-tier-map.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/payments/price-tier-map.ts src/lib/payments/__tests__/price-tier-map.test.ts
git commit -m "feat(billing): add price-tier-map single-owner module for tier<->price IDs"
```

---

## Task 2: Rewire the webhook handler (helper + audit dedup + writeAccountAuditLog)

**Files:**
- Modify: `worker/ingress/stripe/subscription-updated.ts` (whole body)
- Modify: `scripts/ci/tenant-scope-allowlist.ts:1534-1538` (SELECT snippet)
- Test: `worker/ingress/__tests__/stripe-webhook-handlers.test.ts` (queue helper + new cases)

- [ ] **Step 1: Update the tenant-scope allowlist snippet**

In `scripts/ci/tenant-scope-allowlist.ts`, find the entry for `worker/ingress/stripe/subscription-updated.ts` (around line 1534) and change ONLY its `sqlSnippet` to add `locations_paid`:

```ts
  {
    file: "worker/ingress/stripe/subscription-updated.ts",
    table: "accounts",
    sqlSnippet: "SELECT id, subscription_tier, subscription_status, locations_paid FROM accounts WHERE stripe_customer_id = ${customerId} FOR UPDATE",
    reason: "Provider ingress resolves tenant rows from signed provider identifiers before tenant ids are available.",
  },
```

(The audit-log INSERT is account-scoped and is not — and must not be — allowlisted.)

- [ ] **Step 2: Update the test queue helper + add failing dedup tests**

In `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`:

**(a)** Replace the `queueSubscriptionUpdated` helper (currently ~lines 155-177). The audit write is now the mocked `writeAccountAuditLog`, so it is NO LONGER a `tx` SQL call — remove that queue push and add a `locationsPaid` option for the prior row value:

```ts
// Queue helper: standard subscription.updated tx flow.
// NOTE: the audit write now goes through the mocked writeAccountAuditLog, so it
// is NOT a tx SQL call and is asserted via mockWriteAccountAuditLog (not the queue).
function queueSubscriptionUpdated(opts: {
  tier?: string;
  status?: string;
  locationsPaid?: number;
  updateBiz?: boolean;
} = {}) {
  const tier = opts.tier ?? 'standard';
  const status = opts.status ?? 'active';
  const locationsPaid = opts.locationsPaid ?? 0;
  // Inside sql.begin -> tx calls in order:
  // 1. SELECT id, subscription_tier, subscription_status, locations_paid ... FOR UPDATE
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_tier: tier, subscription_status: status, locations_paid: locationsPaid }]);
  // 2. pg_advisory_xact_lock
  sqlReturnQueue.push([]);
  // 3. UPDATE accounts SET subscription_tier, locations_paid, updated_at WHERE id
  const updateAcctResult: any = []; updateAcctResult.count = 1;
  sqlReturnQueue.push(updateAcctResult);
  // 4. UPDATE businesses SET subscription_tier, updated_at WHERE account_id
  const updateBizResult: any = []; updateBizResult.count = opts.updateBiz !== false ? 1 : 0;
  sqlReturnQueue.push(updateBizResult);
}
```

**(b)** Existing `customer.subscription.updated` cases that expect an audit row must now ensure the prior `locations_paid` differs from the event's overage quantity so the audit still fires. For the two cases at lines ~232 and ~265 (overage quantity 3 and 5), the default `locationsPaid: 0` already differs — no change needed to their `queueSubscriptionUpdated(...)` calls. Verify each existing updated-case call site: if a case has overage quantity 0 AND no tier change, it is now a no-op (no audit) — adjust that case's assertion (none currently assert the audit INSERT directly; they assert `UPDATE accounts` values via `sqlCalls.find`, which still holds).

**(c)** Add three new cases at the end of the `describe('customer.subscription.updated — two-item subscription', ...)` block (before its closing `});`):

```ts
  it('writes NO audit row on a true no-op (same tier, same locations_paid)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_noop',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' == computed; prior locations_paid 2 == overage qty 2.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('writes a tier-only audit payload when tier changes but locations_paid does not', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_tier_only',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' -> 'premium'; prior locations_paid 2 == overage qty 2.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [input] = mockWriteAccountAuditLog.mock.calls[0];
    expect(input).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      eventType: 'subscription_updated',
      payload: { fromTier: 'standard', toTier: 'premium' },
    });
    expect(input.payload).not.toHaveProperty('locationsPaid');
  });

  it('writes a locations-only audit payload when locations_paid changes but tier does not', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_loc_only',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 5 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' == computed; prior locations_paid 2 -> overage qty 5.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [input] = mockWriteAccountAuditLog.mock.calls[0];
    expect(input).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      eventType: 'subscription_updated',
      payload: { locationsPaid: 5 },
    });
    expect(input.payload).not.toHaveProperty('fromTier');
  });
```

- [ ] **Step 3: Run the handler tests to verify the new cases fail**

Run: `pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts -t "customer.subscription.updated"`
Expected: FAIL — current handler always writes the audit row via a raw tx INSERT (not `writeAccountAuditLog`), so `mockWriteAccountAuditLog` is never called and the no-op/payload assertions fail.

- [ ] **Step 4: Rewrite the handler**

Replace the ENTIRE contents of `worker/ingress/stripe/subscription-updated.ts` with:

```ts
import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { tierForBasePriceId, isOveragePriceId } from '../../../src/lib/payments/price-tier-map';
import { LOG_PREFIX, extractCustomerId } from './shared';

export async function processSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return;
  }

  const items = sub.items?.data ?? [];

  // VAL-BILLING-009: resolve base item -> tier via the single-owner price map.
  const baseItem = items.find(
    (item) => item.price?.id && !isOveragePriceId(item.price.id),
  );
  if (!baseItem?.price?.id) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing base price ID for customer=${customerId} — skipping tier update`);
    return;
  }

  const tier: SubscriptionTierValue | null = tierForBasePriceId(baseItem.price.id);
  if (!tier) {
    console.warn(`${LOG_PREFIX} Unknown base price ID ${baseItem.price.id} for customer=${customerId} — skipping tier update`);
    return;
  }

  // VAL-BILLING-010: overage item quantity -> accounts.locations_paid.
  // VAL-BILLING-011: tolerate legacy single-item subscriptions (quantity 0).
  const overageItem = items.find(
    (item) => item.price?.id && isOveragePriceId(item.price.id),
  );
  const locationsPaid = overageItem?.quantity ?? 0;

  // VAL-BILLING-062: advisory lock prevents concurrent tier/overage writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{
      id: string;
      subscription_tier: string;
      subscription_status: string;
      locations_paid: number;
    }[]>`
      SELECT id, subscription_tier, subscription_status, locations_paid
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} customer.subscription.updated no account found for customer=${customerId} — skipping tier update`);
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':subscription_update'}))`;

    const tierChanged = acctRow.subscription_tier !== tier;
    const locationsPaidChanged = acctRow.locations_paid !== locationsPaid;

    // Update accounts (source of truth)
    await tx`
      UPDATE accounts
      SET
        subscription_tier = ${tier},
        locations_paid = ${locationsPaid},
        locations_included = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].included} ELSE locations_included END,
        updated_at = NOW()
      WHERE id = ${acctRow.id}::uuid
    `;

    // VAL-LOC-029 / VAL-LOC-058: audit only real changes. Setting locationsPaid
    // only when it changed lets the guard below skip no-op deliveries entirely.
    const auditPayload: Record<string, unknown> = {};
    if (tierChanged) {
      auditPayload.fromTier = acctRow.subscription_tier;
      auditPayload.toTier = tier;
    }
    if (locationsPaidChanged) {
      auditPayload.locationsPaid = locationsPaid;
    }

    if (Object.keys(auditPayload).length > 0) {
      await writeAccountAuditLog(
        {
          accountId: acctRow.id,
          eventType: 'subscription_updated',
          payload: auditPayload,
        },
        tx,
      );
    }

    // Also update businesses deprecated column
    await tx`
      UPDATE businesses
      SET subscription_tier = ${tier}, updated_at = NOW()
      WHERE account_id = ${acctRow.id}::uuid
    `;

    console.log(`${LOG_PREFIX} Account ${acctRow.id} tier updated to ${tier}, locations_paid=${locationsPaid}`);
  });
}
```

Note: the `uuid` (`v7`) and `jsonb` imports are intentionally dropped — they were only used by the removed raw INSERT.

- [ ] **Step 5: Run the handler tests to verify they pass**

Run: `pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts`
Expected: PASS — all `customer.subscription.updated` cases (existing + 3 new) green, plus the unchanged invoice/subscription-deleted/checkout suites.

- [ ] **Step 6: Run the tenant-scope audit**

Run: `pnpm ci:tenant-scope`
Expected: PASS — no "unused" entry and no new un-allowlisted cross-account SELECT. (If it flags the subscription-updated SELECT, re-check the Step 1 snippet matches the new column list exactly.)

- [ ] **Step 7: Commit**

```bash
git add worker/ingress/stripe/subscription-updated.ts worker/ingress/__tests__/stripe-webhook-handlers.test.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "fix(billing): dedup subscription_updated audit rows + use price-tier-map and writeAccountAuditLog (#40)"
```

---

## Task 3: Rewire `create-checkout-session.ts` to the helper

**Files:**
- Modify: `src/lib/payments/create-checkout-session.ts`
- Test (verify only): `src/app/api/billing/__tests__/checkout.test.ts`, `src/app/api/billing/checkout/__tests__/route.test.ts`

- [ ] **Step 1: Replace the local price functions with the helper import**

Delete the local `getBasePriceId` (lines ~32-45) and `getOveragePriceId` (lines ~47-60). Add the import near the existing tier-config import (line 14):

```ts
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { basePriceIdForTier, overagePriceIdForTier } from '@/lib/payments/price-tier-map';
```

Then update the two call sites inside `createCheckoutSession`:
- Line ~97: `const basePriceId = getBasePriceId(tier);` → `const basePriceId = basePriceIdForTier(tier);`
- Line ~109: `const overagePriceId = getOveragePriceId(tier);` → `const overagePriceId = overagePriceIdForTier(tier);`

Leave the `CheckoutUnavailableError` throws and all other logic unchanged.

- [ ] **Step 2: Run the checkout tests to verify they pass**

Run: `pnpm exec vitest run src/app/api/billing/__tests__/checkout.test.ts src/app/api/billing/checkout/__tests__/route.test.ts`
Expected: PASS (behavior preserved; same env reads).

- [ ] **Step 3: Commit**

```bash
git add src/lib/payments/create-checkout-session.ts
git commit -m "refactor(billing): create-checkout-session uses price-tier-map (#40)"
```

---

## Task 4: Rewire `tier-change/route.ts` to the helper

**Files:**
- Modify: `src/app/api/billing/tier-change/route.ts`
- Test (verify only): `src/app/api/billing/tier-change/__tests__/route.test.ts`

- [ ] **Step 1: Replace local maps; re-source the Set builders from the helper**

Add the import (near line 20, next to `getStripe`):

```ts
import { basePriceIdForTier, overagePriceIdForTier, overagePriceIdSet } from '@/lib/payments/price-tier-map';
```

Delete the local `getBasePriceId` (lines ~39-47) and `getOveragePriceId` (lines ~49-57). Rewrite the two Set builders (lines ~59-73) to source from the single owner:

```ts
function configuredBasePriceIds(): Set<string> {
  return new Set(
    (Object.keys(TIER_CONFIG) as SubscriptionTierValue[])
      .map(basePriceIdForTier)
      .filter((priceId): priceId is string => Boolean(priceId)),
  );
}

function configuredOveragePriceIds(): Set<string> {
  return overagePriceIdSet();
}
```

The call sites at lines ~186-187 (`configuredBasePriceIds()` / `configuredOveragePriceIds()`) are unchanged.

- [ ] **Step 2: Run the route test to verify it passes**

Run: `pnpm exec vitest run src/app/api/billing/tier-change/__tests__/route.test.ts`
Expected: PASS (behavior preserved).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/billing/tier-change/route.ts
git commit -m "refactor(billing): tier-change route uses price-tier-map (#40)"
```

---

## Task 5: Rewire `UpdateStripeOverageWorker.ts` to the helper

**Files:**
- Modify: `worker/jobs/billing/UpdateStripeOverageWorker.ts`
- Test (verify only): `worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`

- [ ] **Step 1: Replace local `getOveragePriceId` and the inline overage Set**

Add the import (near line 18, next to the tier-config import):

```ts
import { overagePriceIdForTier, overagePriceIdSet } from '../../../src/lib/payments/price-tier-map';
```

Delete the local `getOveragePriceId` (lines ~40-49). Update its single call site (line ~153):
- `const overagePriceId = getOveragePriceId(tier);` → `const overagePriceId = overagePriceIdForTier(tier);`

Replace the inline overage Set (lines ~169-172) with the helper:

```ts
    const overagePriceIds = overagePriceIdSet();
```

(The subsequent `subscription.items.data.find((item) => item.price?.id && overagePriceIds.has(item.price.id))` is unchanged.)

- [ ] **Step 2: Run the overage worker test to verify it passes**

Run: `pnpm exec vitest run worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts`
Expected: PASS (the test sets the same `STRIPE_PRICE_*_OVERAGE` env vars the helper reads).

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/billing/UpdateStripeOverageWorker.ts
git commit -m "refactor(billing): UpdateStripeOverageWorker uses price-tier-map (#40)"
```

---

## Task 6: Consolidate the poller's overage-set source

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/stripe-overage.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts`
- Test (verify only): `worker/background/pollers/__tests__/stripe-overage.test.ts`

- [ ] **Step 1: Remove `getOveragePriceIds()` from the poller helper module**

In `worker/background/pollers/billing-reconciliation/stripe-overage.ts`, delete the exported function (lines ~10-17):

```ts
// DELETE this block:
export function getOveragePriceIds(): Set<string> {
  return new Set([
    process.env.STRIPE_PRICE_STANDARD_OVERAGE ?? '',
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE ?? '',
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE ?? '',
  ].filter(Boolean));
}
```

Leave `findOverageItem`/`isOverageItem` and their `overagePriceIds: Set<string>` parameters unchanged — they consume the set, they do not own it.

- [ ] **Step 2: Point the caller at the helper**

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`:
- Remove the import `import { getOveragePriceIds } from './billing-reconciliation/stripe-overage';` (line 27). Keep any OTHER imports from that module on the same import line — if `getOveragePriceIds` was imported alone, replace the whole line; if grouped, remove just the `getOveragePriceIds` name.
- Add: `import { overagePriceIdSet } from '../../../src/lib/payments/price-tier-map';`
- Line ~104: `const overagePriceIds = getOveragePriceIds();` → `const overagePriceIds = overagePriceIdSet();`

- [ ] **Step 3: Verify no other references to the removed function remain**

Run: `grep -rn "getOveragePriceIds" worker src`
Expected: no matches (the definition and its only caller are both gone). If the `stripe-overage.test.ts` file matches, see Step 4.

- [ ] **Step 4: Run the poller tests to verify they pass**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/stripe-overage.test.ts worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
Expected: PASS. `stripe-overage.test.ts` has no `getOveragePriceIds` describe block, so removing the function does not break it. If a stray import of `getOveragePriceIds` exists in a test, delete that import.

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/billing-reconciliation/stripe-overage.ts worker/background/pollers/StripeLocationsReconcilePoller.ts
git commit -m "refactor(billing): reconciliation poller sources overage set from price-tier-map (#40)"
```

---

## Task 7: Full verification + PR

**Files:** none (validation + delivery)

- [ ] **Step 1: Type-check and full test (best-effort local)**

Run: `pnpm typecheck`
Run: `pnpm exec vitest run`
Expected: typecheck clean; all tests pass. If local results look anomalous (phantom resolution/lint issues), this is the nested-worktree leak — rely on Step 4 CI rather than debugging locally.

- [ ] **Step 2: DB-touching audits**

Run: `pnpm ci:tenant-scope`
Run: `pnpm ci:rls-audit`
Expected: both PASS.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin worktree-fix+40-stripe-price-tier-map
```

- [ ] **Step 4: Open the PR and confirm the 4 CI checks (authoritative gate)**

```bash
gh pr create \
  --base main \
  --title "fix(billing): subscription_updated audit dedup + tier/price-map single owner (#40)" \
  --body "$(cat <<'EOF'
Closes #40.

## What
- New single-owner module `src/lib/payments/price-tier-map.ts` for the tier<->Stripe-price-ID mapping (forward, reverse, overage set), read from env at call time.
- `worker/ingress/stripe/subscription-updated.ts`: collision-safe reverse map, audit payload deduped against prior `locations_paid` (no row on no-op deliveries), and raw `INSERT INTO account_audit_log` replaced with `writeAccountAuditLog(input, tx)` (matches siblings + CLAUDE.md rule).
- 4 other sites (`create-checkout-session`, `tier-change/route`, `UpdateStripeOverageWorker`, `stripe-overage` poller + its caller) now source the mapping from the new module — removing 5-way duplication.
- tenant-scope allowlist SELECT snippet updated for the added `locations_paid` column.

## Tests
- New `price-tier-map.test.ts` incl. empty-string collision regression.
- New handler cases: no-op writes no audit row; tier-only and locations-only payload shapes.

Spec: `docs/superpowers/specs/2026-05-28-stripe-subscription-updated-audit-and-price-map-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then watch CI: `gh pr checks --watch`
Expected: `lint`, `typecheck`, `test`, `build` all green before merge.

---

## Self-Review (completed during planning)

- **Spec coverage:** §3 module → Task 1; §4.1 handler (3 fixes) → Task 2; §4.2 → Task 3; §4.3 → Task 4; §4.4 → Task 5; §4.5 → Task 6; §5 (no startup-assert change) → no task by design; §8 testing → embedded per task; §9 allowlist → Task 2 Step 1/6; §11 packaging → Task 7. No gaps.
- **Placeholder scan:** none — every code/step shows real content.
- **Type/name consistency:** `basePriceIdForTier`, `overagePriceIdForTier`, `tierForBasePriceId`, `isOveragePriceId`, `overagePriceIdSet` are used identically in Tasks 1-6. Handler row type adds `locations_paid: number`; queue helper pushes `locations_paid`; allowlist snippet adds `locations_paid` — consistent.
