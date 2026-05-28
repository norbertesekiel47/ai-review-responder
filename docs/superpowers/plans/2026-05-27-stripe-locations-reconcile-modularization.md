# StripeLocationsReconcilePoller Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 617-LOC `worker/background/pollers/StripeLocationsReconcilePoller.ts` into a thin orchestrator plus focused `billing-reconciliation/` modules, preserving behavior byte-for-byte.

**Architecture:** Extend the existing `billing-reconciliation/` pattern (pure, single-concern modules). Lift pure Stripe-item helpers (`stripe-overage.ts`), flag parsing (`account-flags.ts`), the alert sink (`drift-alert.ts`), and the per-account reconcile step (`reconcile-account.ts`, which returns a structured outcome) out of the poller. The poller keeps only orchestration (SQL query, single-flight guard, alert emission, tally, lifecycle). `reconcileAccount` receives the Stripe client by injection so the outbound-Stripe failure path is a named, independently testable unit.

**Tech Stack:** TypeScript (strict), Vitest, Stripe SDK, Postgres.js, Sentry. Package manager: pnpm.

**Safety net:** `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts` (~40 tests through the public surface) is the characterization net. It must stay **green and untouched** after every task. Public surface (`runOnce`, `startStripeLocationsReconcilePoller`, `stopStripeLocationsReconcilePoller`) and `worker/index.ts`'s import path do not change.

**Targeted test command:** `pnpm exec vitest run <path>` (the bare `pnpm test -- <path>` form does not filter and runs the whole suite).

---

## Task 1: Extract pure helpers (`stripe-overage.ts`, `account-flags.ts`)

**Files:**
- Create: `worker/background/pollers/__tests__/stripe-overage.test.ts`
- Create: `worker/background/pollers/billing-reconciliation/stripe-overage.ts`
- Create: `worker/background/pollers/billing-reconciliation/account-flags.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts` (delete inline helpers, add imports)

- [ ] **Step 1: Write the failing unit test**

Create `worker/background/pollers/__tests__/stripe-overage.test.ts`:

```ts
// worker/background/pollers/__tests__/stripe-overage.test.ts
import { describe, it, expect } from 'vitest';
import {
  isMissingStripeSubscriptionError,
  activeStripeSubscriptions,
  extractStripeCustomerId,
  findOverageItem,
  isOverageItem,
} from '../billing-reconciliation/stripe-overage';

describe('stripe-overage helpers', () => {
  describe('extractStripeCustomerId', () => {
    it('returns the string customer id directly', () => {
      expect(extractStripeCustomerId('cus_123')).toBe('cus_123');
    });
    it('returns the id from a customer object', () => {
      expect(extractStripeCustomerId({ id: 'cus_obj' } as any)).toBe('cus_obj');
    });
    it('returns null for a null customer', () => {
      expect(extractStripeCustomerId(null)).toBeNull();
    });
  });

  describe('isMissingStripeSubscriptionError', () => {
    it('detects the resource_missing code', () => {
      expect(isMissingStripeSubscriptionError({ code: 'resource_missing' })).toBe(true);
    });
    it('detects a 404 statusCode', () => {
      expect(isMissingStripeSubscriptionError({ statusCode: 404 })).toBe(true);
    });
    it('detects an invalid-request "no such subscription" message', () => {
      expect(isMissingStripeSubscriptionError({
        type: 'StripeInvalidRequestError',
        message: 'No such subscription: sub_x',
      })).toBe(true);
    });
    it('is false for unrelated errors', () => {
      expect(isMissingStripeSubscriptionError(new Error('timeout'))).toBe(false);
    });
    it('is false for null', () => {
      expect(isMissingStripeSubscriptionError(null)).toBe(false);
    });
  });

  describe('activeStripeSubscriptions', () => {
    it('keeps active/trialing/past_due/unpaid and drops canceled', () => {
      const result = activeStripeSubscriptions({
        data: [
          { id: 'a', status: 'active' },
          { id: 't', status: 'trialing' },
          { id: 'p', status: 'past_due' },
          { id: 'u', status: 'unpaid' },
          { id: 'c', status: 'canceled' },
        ] as any,
      });
      expect(result.map((s) => s.id)).toEqual(['a', 't', 'p', 'u']);
    });
    it('handles a missing data array', () => {
      expect(activeStripeSubscriptions({} as any)).toEqual([]);
    });
  });

  describe('isOverageItem', () => {
    const overageIds = new Set(['price_overage_std']);
    it('matches by a known overage price id', () => {
      expect(isOverageItem(
        { price: { id: 'price_overage_std', unit_amount: 2500 } } as any,
        overageIds, 2500, 2,
      )).toBe(true);
    });
    it('matches by a descriptor keyword', () => {
      expect(isOverageItem(
        { price: { id: 'price_x', nickname: 'Extra location', unit_amount: 2500 } } as any,
        overageIds, 0, 2,
      )).toBe(true);
    });
    it('matches a legacy price by stored unit amount when more than one item', () => {
      expect(isOverageItem(
        { price: { id: 'price_legacy', unit_amount: 3000 } } as any,
        overageIds, 3000, 2,
      )).toBe(true);
    });
    it('does not match the sole item by unit amount', () => {
      expect(isOverageItem(
        { price: { id: 'price_base', unit_amount: 3000 } } as any,
        overageIds, 3000, 1,
      )).toBe(false);
    });
    it('returns false when the item has no price', () => {
      expect(isOverageItem({} as any, overageIds, 2500, 2)).toBe(false);
    });
  });

  describe('findOverageItem', () => {
    const overageIds = new Set(['price_overage_std']);
    it('finds the overage item among subscription items', () => {
      const sub = {
        items: { data: [
          { id: 'si_base', price: { id: 'price_base', unit_amount: 7900 } },
          { id: 'si_over', price: { id: 'price_overage_std', unit_amount: 2500 } },
        ] },
      };
      expect(findOverageItem(sub as any, overageIds, 2500)?.id).toBe('si_over');
    });
    it('returns undefined when no overage item exists', () => {
      const sub = { items: { data: [
        { id: 'si_base', price: { id: 'price_base', unit_amount: 7900 } },
      ] } };
      expect(findOverageItem(sub as any, overageIds, 2500)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/stripe-overage.test.ts`
Expected: FAIL — module resolution error (`Failed to resolve import "../billing-reconciliation/stripe-overage"` / cannot find module).

- [ ] **Step 3: Create `stripe-overage.ts`**

Create `worker/background/pollers/billing-reconciliation/stripe-overage.ts`:

```ts
// worker/background/pollers/billing-reconciliation/stripe-overage.ts
//
// Pure Stripe-item helpers for billing reconciliation: identifying the overage
// subscription item, classifying missing-subscription errors, filtering active
// subscriptions, and reading the customer id. No I/O — these operate on
// already-retrieved Stripe objects and environment-configured price IDs.

import Stripe from 'stripe';

// Overage price IDs — used to identify the overage subscription item
export function getOveragePriceIds(): Set<string> {
  return new Set([
    process.env.STRIPE_PRICE_STANDARD_OVERAGE ?? '',
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE ?? '',
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE ?? '',
  ].filter(Boolean));
}

export function extractStripeCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

export function isMissingStripeSubscriptionError(err: unknown): boolean {
  const maybeStripeError = err as {
    code?: string;
    statusCode?: number;
    type?: string;
    message?: string;
  } | null;
  if (!maybeStripeError) return false;

  return maybeStripeError.code === 'resource_missing'
    || maybeStripeError.statusCode === 404
    || maybeStripeError.type === 'StripeInvalidRequestError'
      && /no such subscription/i.test(maybeStripeError.message ?? '');
}

export function activeStripeSubscriptions(
  subscriptions: Stripe.ApiList<Stripe.Subscription> | { data?: Stripe.Subscription[] },
): Stripe.Subscription[] {
  const data = subscriptions.data ?? [];
  return data.filter((subscription) =>
    ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status),
  );
}

export function findOverageItem(
  subscription: Stripe.Subscription,
  overagePriceIds: Set<string>,
  expectedOverageUnitPriceCents: number,
): Stripe.SubscriptionItem | undefined {
  const items = subscription.items?.data ?? [];
  return items.find((item) =>
    isOverageItem(item, overagePriceIds, expectedOverageUnitPriceCents, items.length),
  );
}

export function isOverageItem(
  item: Stripe.SubscriptionItem,
  overagePriceIds: Set<string>,
  expectedOverageUnitPriceCents: number,
  itemCount: number,
): boolean {
  const price = item.price;
  if (!price) return false;
  if (price.id && overagePriceIds.has(price.id)) return true;

  const priceDescriptor = [
    price.lookup_key,
    price.nickname,
    price.metadata?.billing_role,
    price.metadata?.role,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(overage|additional|extra|add-on|addon)\b/.test(priceDescriptor)) {
    return true;
  }

  return itemCount > 1
    && expectedOverageUnitPriceCents > 0
    && price.unit_amount === expectedOverageUnitPriceCents;
}
```

- [ ] **Step 4: Create `account-flags.ts`**

Create `worker/background/pollers/billing-reconciliation/account-flags.ts`:

```ts
// worker/background/pollers/billing-reconciliation/account-flags.ts
//
// Parses the accounts.flags JSONB column (which Postgres.js + PgBouncer may
// return as a string) and derives pilot status used in drift-alert metadata.

export function parseAccountFlags(
  flags: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (!flags) return {};
  if (typeof flags === 'string') {
    try {
      const parsed = JSON.parse(flags);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return flags;
}

export function isPilotAccount(
  flags: Record<string, unknown> | string | null | undefined,
): boolean {
  const parsedFlags = parseAccountFlags(flags);
  return parsedFlags.is_pilot === true || parsedFlags.pilot === true;
}
```

- [ ] **Step 5: Run the new unit test to verify it passes**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/stripe-overage.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 6: Wire the helpers into the poller (delete inline copies, add imports)**

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`:

(a) Add these two imports immediately after the existing `import type { BillingReconciliationAccount, DriftFinding } from './billing-reconciliation/types';` line:

```ts
import {
  getOveragePriceIds,
  extractStripeCustomerId,
  isMissingStripeSubscriptionError,
  activeStripeSubscriptions,
  findOverageItem,
  isOverageItem,
} from './billing-reconciliation/stripe-overage';
import { parseAccountFlags, isPilotAccount } from './billing-reconciliation/account-flags';
```

(b) Delete the eight now-duplicated inline helper definitions — the contiguous block that starts with the `// Overage price IDs — used to identify the overage subscription item` comment + `function getOveragePriceIds()` and ends with the closing brace of `function isOverageItem(...)`. This removes, in order: `getOveragePriceIds`, `extractStripeCustomerId`, `isMissingStripeSubscriptionError`, `activeStripeSubscriptions`, `parseAccountFlags`, `isPilotAccount`, `findOverageItem`, `isOverageItem`.

Leave everything else (the `getStripe` singleton, `LOG_PREFIX`, `runOnce`, `emitDriftAlert`, lifecycle) untouched. `runOnce`'s body still calls these names — now resolved via the new imports.

- [ ] **Step 7: Run the full suite to verify nothing broke**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
Expected: PASS — all ~40 characterization tests green.

- [ ] **Step 8: Commit**

```bash
git add worker/background/pollers/billing-reconciliation/stripe-overage.ts \
        worker/background/pollers/billing-reconciliation/account-flags.ts \
        worker/background/pollers/__tests__/stripe-overage.test.ts \
        worker/background/pollers/StripeLocationsReconcilePoller.ts
git commit -m "refactor(billing): extract stripe-overage + account-flags helpers from poller"
```

---

## Task 2: Extract the alert sink (`constants.ts`, `drift-alert.ts`)

**Files:**
- Create: `worker/background/pollers/billing-reconciliation/constants.ts`
- Create: `worker/background/pollers/billing-reconciliation/drift-alert.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts` (delete inline `LOG_PREFIX`, `DriftAlertPayload`, `emitDriftAlert`; add imports)

No new unit-test file here — `emitDriftAlert` is exercised by the existing characterization suite (Sentry path and console.warn fallback). The suite is the regression gate.

- [ ] **Step 1: Create `constants.ts`**

Create `worker/background/pollers/billing-reconciliation/constants.ts`:

```ts
// worker/background/pollers/billing-reconciliation/constants.ts
//
// Shared log namespace for the Stripe locations reconciliation subsystem.
// Single owner so the poller orchestrator, drift-alert sink, and per-account
// reconcile step all emit under the same prefix.

export const LOG_PREFIX = '[StripeLocationsReconcilePoller]';
```

- [ ] **Step 2: Create `drift-alert.ts`**

Create `worker/background/pollers/billing-reconciliation/drift-alert.ts`:

```ts
// worker/background/pollers/billing-reconciliation/drift-alert.ts
//
// Drift alert sink: emits a Sentry warning when SENTRY_DSN is set, otherwise
// falls back to console.warn. Owns the DriftAlertPayload shape produced by
// reconcileAccount and consumed by the poller orchestrator.

import { Sentry } from '../../../sentry';
import { LOG_PREFIX } from './constants';
import type { DriftFinding } from './types';

export interface DriftAlertPayload {
  driftType?: DriftFinding['type'];
  dbExpectedOverage: number;
  stripeOverageQuantity: number;
  activeLocations: number;
  locationsIncluded: number;
  tier: string;
  isPilot?: boolean;
  expectedCents?: number;
  actualCents?: number;
  dbStatus?: string;
  stripeStatus?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string | null;
  driftMessage?: string;
}

/**
 * Emits a drift alert. Uses Sentry when SENTRY_DSN is set,
 * falls back to console.warn otherwise.
 */
export function emitDriftAlert(
  accountId: string,
  payload: DriftAlertPayload,
): void {
  const message = payload.driftMessage ??
    `Stripe location drift detected for account ${accountId}: ` +
    `expected_overage=${payload.dbExpectedOverage} (from DB: ${payload.activeLocations} active - ${payload.locationsIncluded} included), ` +
    `stripe_overage=${payload.stripeOverageQuantity}, ` +
    `tier=${payload.tier}`;

  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: {
        feature: 'stripe_reconciliation',
        account_id: accountId,
        drift_type: payload.driftType ?? 'quantity_mismatch',
        is_pilot: String(payload.isPilot === true),
      },
      extra: {
        accountId,
        driftMessage: payload.driftMessage,
        dbExpectedOverage: payload.dbExpectedOverage,
        stripeOverageQuantity: payload.stripeOverageQuantity,
        activeLocations: payload.activeLocations,
        locationsIncluded: payload.locationsIncluded,
        tier: payload.tier,
        isPilot: payload.isPilot === true,
        expectedCents: payload.expectedCents,
        actualCents: payload.actualCents,
        dbStatus: payload.dbStatus,
        stripeStatus: payload.stripeStatus,
        stripeSubscriptionId: payload.stripeSubscriptionId,
        stripeCustomerId: payload.stripeCustomerId,
      },
    });
  } else {
    console.warn(`${LOG_PREFIX} ${message}`);
  }
}
```

> Note: `../../../sentry` from `billing-reconciliation/` resolves to `worker/sentry` — the same module the test mocks via `../../../../worker/sentry`. Vitest mocks by resolved path, so the existing Sentry mock still applies.

- [ ] **Step 3: Wire the alert sink into the poller (delete inline copies, adjust imports)**

In `worker/background/pollers/StripeLocationsReconcilePoller.ts`:

(a) Delete the import line:

```ts
import { Sentry } from '../../sentry';
```

(b) Change the types import from:

```ts
import type { BillingReconciliationAccount, DriftFinding } from './billing-reconciliation/types';
```

to:

```ts
import type { BillingReconciliationAccount } from './billing-reconciliation/types';
```

(c) Add these two imports (e.g. directly below the account-flags import added in Task 1):

```ts
import { LOG_PREFIX } from './billing-reconciliation/constants';
import { emitDriftAlert } from './billing-reconciliation/drift-alert';
```

(d) Delete the inline `const LOG_PREFIX = '[StripeLocationsReconcilePoller]';` declaration near the top of the file.

(e) Delete the inline `interface DriftAlertPayload { ... }` declaration and the entire inline `function emitDriftAlert(accountId, payload): void { ... }` definition (including its `/** Emits a drift alert ... */` doc comment).

Leave `getStripe`, `runOnce` (its body still calls `emitDriftAlert` and uses `LOG_PREFIX`), and the lifecycle functions untouched.

- [ ] **Step 4: Run the full suite to verify nothing broke**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts`
Expected: PASS — all ~40 characterization tests green (Sentry path + console.warn fallback both still verified).

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/billing-reconciliation/constants.ts \
        worker/background/pollers/billing-reconciliation/drift-alert.ts \
        worker/background/pollers/StripeLocationsReconcilePoller.ts
git commit -m "refactor(billing): extract drift-alert sink + shared LOG_PREFIX from poller"
```

---

## Task 3: Extract the per-account step (`reconcile-account.ts`) and slim the orchestrator

**Files:**
- Modify: `worker/background/pollers/billing-reconciliation/types.ts` (add `AccountWithLocations`)
- Create: `worker/background/pollers/__tests__/reconcile-account.test.ts`
- Create: `worker/background/pollers/billing-reconciliation/reconcile-account.ts`
- Modify: `worker/background/pollers/StripeLocationsReconcilePoller.ts` (full rewrite to orchestrator)

- [ ] **Step 1: Add `AccountWithLocations` to `types.ts`**

Append to `worker/background/pollers/billing-reconciliation/types.ts`:

```ts
export interface AccountWithLocations {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  locations_included: number;
  locations_overage_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown> | null;
}
```

- [ ] **Step 2: Write the failing unit test**

Create `worker/background/pollers/__tests__/reconcile-account.test.ts`:

```ts
// worker/background/pollers/__tests__/reconcile-account.test.ts
//
// Unit tests for the per-account reconcile step. The Stripe client is injected,
// so no module mock is needed — a hand-rolled fake covers each outbound call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reconcileAccount } from '../billing-reconciliation/reconcile-account';
import type { AccountWithLocations } from '../billing-reconciliation/types';

function makeAccount(overrides: Partial<AccountWithLocations> = {}): AccountWithLocations {
  return {
    id: 'acct-1',
    subscription_tier: 'standard',
    subscription_status: 'active',
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    locations_included: 1,
    locations_overage_price_cents: 2500,
    active_location_count: 3,
    past_due_at: null,
    flags: {},
    ...overrides,
  };
}

function makeSubscription(overageQuantity: number, overageUnitAmount = 2500) {
  return {
    id: 'sub_test',
    customer: 'cus_123',
    status: 'active',
    items: { data: [
      { id: 'si_base', price: { id: 'price_base', unit_amount: 7900 }, quantity: 1 },
      { id: 'si_over', price: { id: 'price_overage_std', unit_amount: overageUnitAmount }, quantity: overageQuantity },
    ] },
  };
}

function makePreview(overageUnits = 2, overageUnitCents = 2500, baseCents = 7900) {
  const lines: any[] = [
    { id: 'il_base', amount: baseCents, subtotal: baseCents, quantity: 1,
      price: { id: 'price_base', unit_amount: baseCents },
      parent: { subscription_item_details: { proration: false, subscription_item: 'si_base' } } },
  ];
  if (overageUnits > 0) {
    lines.push({ id: 'il_over', amount: overageUnits * overageUnitCents, subtotal: overageUnits * overageUnitCents,
      quantity: overageUnits, price: { id: 'price_overage_std', unit_amount: overageUnitCents },
      parent: { subscription_item_details: { proration: false, subscription_item: 'si_over' } } });
  }
  return { total: baseCents + overageUnits * overageUnitCents, lines: { data: lines } };
}

function makeStripe(opts: {
  retrieve?: unknown; list?: unknown; createPreview?: unknown;
  retrieveError?: unknown; createPreviewError?: unknown; listError?: unknown;
}) {
  return {
    subscriptions: {
      retrieve: opts.retrieveError
        ? vi.fn().mockRejectedValue(opts.retrieveError)
        : vi.fn().mockResolvedValue(opts.retrieve),
      list: opts.listError
        ? vi.fn().mockRejectedValue(opts.listError)
        : vi.fn().mockResolvedValue(opts.list ?? { data: [] }),
    },
    invoices: {
      createPreview: opts.createPreviewError
        ? vi.fn().mockRejectedValue(opts.createPreviewError)
        : vi.fn().mockResolvedValue(opts.createPreview ?? makePreview()),
    },
  } as any;
}

const OVERAGE_IDS = new Set(['price_overage_std']);

describe('reconcileAccount', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns checked:1 with no drift for a matching account', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    const outcome = await reconcileAccount(stripe, makeAccount(), OVERAGE_IDS);
    expect(outcome).toEqual({ accountsChecked: 1, drifts: [], errors: 0 });
  });

  it('returns errors:1 checked:0 for an unknown tier', async () => {
    const stripe = makeStripe({});
    const outcome = await reconcileAccount(stripe, makeAccount({ subscription_tier: 'nope' }), OVERAGE_IDS);
    expect(outcome.accountsChecked).toBe(0);
    expect(outcome.errors).toBe(1);
    expect(outcome.drifts).toEqual([]);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('reports missing_subscription when stripe_subscription_id is null', async () => {
    const stripe = makeStripe({});
    const outcome = await reconcileAccount(stripe, makeAccount({ stripe_subscription_id: null }), OVERAGE_IDS);
    expect(outcome.accountsChecked).toBe(1);
    expect(outcome.errors).toBe(0);
    expect(outcome.drifts).toHaveLength(1);
    expect(outcome.drifts[0].driftType).toBe('missing_subscription');
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('reports missing_subscription (handled) when Stripe 404s the subscription', async () => {
    const err = Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
    const stripe = makeStripe({ retrieveError: err });
    const outcome = await reconcileAccount(stripe, makeAccount(), OVERAGE_IDS);
    expect(outcome).toMatchObject({ accountsChecked: 1, errors: 0 });
    expect(outcome.drifts[0].driftType).toBe('missing_subscription');
  });

  it('re-throws a non-missing Stripe retrieve error', async () => {
    const stripe = makeStripe({ retrieveError: new Error('Stripe API timeout') });
    await expect(reconcileAccount(stripe, makeAccount(), OVERAGE_IDS)).rejects.toThrow('Stripe API timeout');
  });

  it('counts a duplicate-list failure as a handled error and still checks the account', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2), createPreview: makePreview(2),
      listError: new Error('list failed'),
    });
    const outcome = await reconcileAccount(stripe, makeAccount(), OVERAGE_IDS);
    expect(outcome.accountsChecked).toBe(1);
    expect(outcome.errors).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error listing Stripe subscriptions'));
  });

  it('still reports quantity drift when the invoice preview fails', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(5),
      createPreviewError: new Error('preview timeout'),
    });
    const outcome = await reconcileAccount(stripe, makeAccount({ active_location_count: 3, locations_included: 1 }), OVERAGE_IDS);
    expect(outcome.accountsChecked).toBe(1);
    expect(outcome.errors).toBe(1);
    expect(outcome.drifts.some((d) => d.driftType === 'quantity_mismatch')).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error reconciling invoice preview'));
  });

  it('reports a duplicate_subscription drift', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2), createPreview: makePreview(2),
      list: { data: [ { id: 'sub_123', status: 'active' }, { id: 'sub_dup', status: 'active' } ] },
    });
    const outcome = await reconcileAccount(stripe, makeAccount(), OVERAGE_IDS);
    expect(outcome.drifts.some((d) => d.driftType === 'duplicate_subscription')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/reconcile-account.test.ts`
Expected: FAIL — module resolution error (`Failed to resolve import "../billing-reconciliation/reconcile-account"`).

- [ ] **Step 4: Create `reconcile-account.ts`**

Create `worker/background/pollers/billing-reconciliation/reconcile-account.ts`:

```ts
// worker/background/pollers/billing-reconciliation/reconcile-account.ts
//
// Reconciles ONE account against Stripe: retrieves the subscription, checks for
// duplicate subscriptions, status/price/quantity drift, and upcoming-invoice
// drift. Each outbound Stripe call has explicit failure handling. Returns a
// structured outcome — the orchestrator (runOnce) emits the collected drifts and
// tallies the counts. A non-missing retrieve error is re-thrown so the
// orchestrator's per-account catch records it without marking the account checked.

import Stripe from 'stripe';
import { isSubscriptionTier, TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';
import {
  compareUpcomingInvoice,
  isExpectedStatusWindow,
  recurringSubscriptionLineTotalCents,
} from './drift';
import { expectedInvoiceForAccount } from './expected-invoice';
import { parseAccountFlags, isPilotAccount } from './account-flags';
import {
  activeStripeSubscriptions,
  extractStripeCustomerId,
  findOverageItem,
  isMissingStripeSubscriptionError,
} from './stripe-overage';
import { LOG_PREFIX } from './constants';
import type { DriftAlertPayload } from './drift-alert';
import type { AccountWithLocations, BillingReconciliationAccount } from './types';

export interface AccountReconcileOutcome {
  accountsChecked: 0 | 1;
  drifts: DriftAlertPayload[];
  errors: number;
}

export async function reconcileAccount(
  stripe: Stripe,
  account: AccountWithLocations,
  overagePriceIds: Set<string>,
): Promise<AccountReconcileOutcome> {
  const drifts: DriftAlertPayload[] = [];
  let errors = 0;

  const tier = account.subscription_tier;
  if (!isSubscriptionTier(tier)) {
    console.error(`${LOG_PREFIX} Unknown tier ${tier} for account ${account.id} — skipping`);
    return { accountsChecked: 0, drifts, errors: 1 };
  }

  const config = TIER_CONFIG[tier];
  const activeLocations = Number(account.active_location_count);
  const expectedAccount: BillingReconciliationAccount = {
    ...account,
    active_location_count: activeLocations,
    flags: parseAccountFlags(account.flags),
  };
  const expectedInvoice = expectedInvoiceForAccount(expectedAccount);
  const isPilot = isPilotAccount(expectedAccount.flags);

  if (!account.stripe_subscription_id) {
    drifts.push({
      driftType: 'missing_subscription',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity: 0,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeCustomerId: account.stripe_customer_id,
      driftMessage: `Missing Stripe subscription id for paid account ${account.id}`,
    });
    return { accountsChecked: 1, drifts, errors };
  }

  // Retrieve Stripe subscription
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(
      account.stripe_subscription_id,
    );
  } catch (err) {
    if (!isMissingStripeSubscriptionError(err)) {
      throw err;
    }

    drifts.push({
      driftType: 'missing_subscription',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity: 0,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeSubscriptionId: account.stripe_subscription_id,
      stripeCustomerId: account.stripe_customer_id,
      driftMessage: `Stripe subscription ${account.stripe_subscription_id} is missing for paid account ${account.id}`,
    });
    return { accountsChecked: 1, drifts, errors };
  }
  const stripeCustomerId = extractStripeCustomerId(subscription.customer);

  if (stripeCustomerId) {
    try {
      const customerSubscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'all',
        limit: 100,
      });
      const activeSubscriptions = activeStripeSubscriptions(customerSubscriptions);
      if (activeSubscriptions.length > 1) {
        drifts.push({
          driftType: 'duplicate_subscription',
          dbExpectedOverage: expectedInvoice.overageUnits,
          stripeOverageQuantity: 0,
          activeLocations,
          locationsIncluded: account.locations_included,
          tier,
          isPilot,
          dbStatus: account.subscription_status,
          stripeStatus: subscription.status,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId,
          driftMessage: `Duplicate active Stripe subscriptions for account ${account.id}: ${activeSubscriptions.map((sub) => sub.id).join(',')}`,
        });
      }
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG_PREFIX} Error listing Stripe subscriptions for account ${account.id}: ${message}`,
      );
    }
  }

  if (
    subscription.status !== account.subscription_status
    && !isExpectedStatusWindow(expectedAccount, subscription.status)
  ) {
    drifts.push({
      driftType: 'status_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity: 0,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `Stripe status ${subscription.status} differs from DB status ${account.subscription_status}`,
    });
  }

  const overageItem = findOverageItem(
    subscription,
    overagePriceIds,
    expectedInvoice.overageUnitPriceCents,
  );
  const stripeOverageQuantity = overageItem?.quantity ?? 0;

  const subscriptionItems = subscription.items?.data ?? [];
  const baseItem = subscriptionItems.find((item) => item.id !== overageItem?.id);
  const baseUnitAmount = baseItem?.price?.unit_amount;
  if (typeof baseUnitAmount === 'number' && baseUnitAmount !== expectedInvoice.baseCents) {
    drifts.push({
      driftType: 'price_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      expectedCents: expectedInvoice.baseCents,
      actualCents: baseUnitAmount,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `Stripe base price ${baseUnitAmount} differs from expected ${expectedInvoice.baseCents} for account ${account.id}`,
    });
  }

  const overageUnitAmount = overageItem?.price?.unit_amount;
  if (
    typeof overageUnitAmount === 'number'
    && expectedInvoice.overageUnitPriceCents > 0
    && overageUnitAmount !== expectedInvoice.overageUnitPriceCents
  ) {
    drifts.push({
      driftType: 'price_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      expectedCents: expectedInvoice.overageUnitPriceCents,
      actualCents: overageUnitAmount,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
      driftMessage: `Stripe overage price ${overageUnitAmount} differs from stored account price ${expectedInvoice.overageUnitPriceCents} for account ${account.id}`,
    });
  }

  // Basic tier has no overage concept
  if (!config.multiLocAllowed || config.overageCents === 0) {
    if (overageItem && (overageItem.quantity ?? 0) > 0) {
      // Basic tier should never have overage items with quantity > 0
      drifts.push({
        driftType: 'quantity_mismatch',
        dbExpectedOverage: expectedInvoice.overageUnits,
        stripeOverageQuantity,
        activeLocations,
        locationsIncluded: account.locations_included,
        tier,
        isPilot,
        dbStatus: account.subscription_status,
        stripeStatus: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId,
      });
    }
  } else if (stripeOverageQuantity !== expectedInvoice.overageUnits) {
    drifts.push({
      driftType: 'quantity_mismatch',
      dbExpectedOverage: expectedInvoice.overageUnits,
      stripeOverageQuantity,
      activeLocations,
      locationsIncluded: account.locations_included,
      tier,
      isPilot,
      dbStatus: account.subscription_status,
      stripeStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId,
    });
  }

  try {
    if (!stripeCustomerId) {
      throw new Error('Stripe subscription is missing a customer ID');
    }

    const upcoming = await stripe.invoices.createPreview({
      customer: stripeCustomerId,
      subscription: account.stripe_subscription_id,
    });
    const actualRecurringCents = recurringSubscriptionLineTotalCents(upcoming);

    if (actualRecurringCents === null) {
      throw new Error('Stripe invoice preview returned no recurring subscription lines');
    }

    for (const drift of compareUpcomingInvoice(account.id, expectedInvoice.totalCents, actualRecurringCents)) {
      drifts.push({
        driftType: drift.type,
        dbExpectedOverage: expectedInvoice.overageUnits,
        stripeOverageQuantity,
        activeLocations,
        locationsIncluded: account.locations_included,
        tier,
        isPilot,
        expectedCents: drift.expectedCents,
        actualCents: drift.actualCents,
        dbStatus: account.subscription_status,
        stripeStatus: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId,
        driftMessage: drift.message,
      });
    }
  } catch (err) {
    errors++;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `${LOG_PREFIX} Error reconciling invoice preview for account ${account.id}: ${message}`,
    );
  }

  return { accountsChecked: 1, drifts, errors };
}
```

- [ ] **Step 5: Run the new unit test to verify it passes**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/reconcile-account.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewrite the poller as the orchestrator**

Replace the **entire** contents of `worker/background/pollers/StripeLocationsReconcilePoller.ts` with:

```ts
// worker/background/pollers/StripeLocationsReconcilePoller.ts
//
// Hourly drift detection: compares actual non-archived location count
// against Stripe subscription_items[overage].quantity. Drift > 0
// emits Sentry alert (or console.warn when SENTRY_DSN unset).
//
// Does NOT auto-correct — manual investigation only.
//
// Scope conditions:
//   - Checks paid accounts whether stripe_subscription_id is present or missing
//   - Only checks accounts with subscription_status = 'active' or 'past_due'
//   - Skips accounts with no overage item in Stripe (basic tier, legacy)
//   - Uses the stored billing snapshot to determine expected overage/invoice totals
//
// Default cadence: every 60 minutes (3_600_000 ms).
// Override via STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS.
// Set STRIPE_LOCATIONS_RECONCILE_DISABLED=true to skip entirely
// (mock mode does too).
//
// Per-account reconciliation lives in billing-reconciliation/reconcile-account.ts;
// this file owns orchestration (query, single-flight, alert emission, tally) and
// the poller lifecycle.

import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { getOveragePriceIds } from './billing-reconciliation/stripe-overage';
import { emitDriftAlert } from './billing-reconciliation/drift-alert';
import { reconcileAccount } from './billing-reconciliation/reconcile-account';
import { LOG_PREFIX } from './billing-reconciliation/constants';
import type { AccountWithLocations } from './billing-reconciliation/types';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour

let timer: ReturnType<typeof setInterval> | null = null;
// Single-flight guard. Same pattern as EmailChannelReconcilePoller —
// prevents two scheduled ticks from running concurrently.
let inProgress = false;

// Lazy singleton — avoids crashing on import when STRIPE_SECRET_KEY is absent
let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

interface ReconcileResult {
  accountsChecked: number;
  driftsFound: number;
  errors: number;
}

/**
 * Runs one reconciliation cycle. For each active account with a Stripe
 * subscription, compares the expected overage quantity (from DB) with
 * the actual overage quantity (from Stripe). Emits alert on drift.
 */
export async function runOnce(): Promise<ReconcileResult> {
  if (inProgress) {
    console.log(`${LOG_PREFIX} Previous run still in progress — skipping this tick`);
    return { accountsChecked: 0, driftsFound: 0, errors: 0 };
  }
  inProgress = true;

  try {
    // Fetch all active paid accounts and their
    // active location counts in a single query.
    const accounts = await sql<AccountWithLocations[]>`
      SELECT
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.stripe_customer_id,
        a.stripe_subscription_id,
        a.locations_included,
        a.locations_overage_price_cents,
        a.past_due_at,
        a.flags,
        COUNT(b.id) AS active_location_count
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL
      WHERE a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.PAST_DUE})
      GROUP BY
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.stripe_customer_id,
        a.stripe_subscription_id,
        a.locations_included,
        a.locations_overage_price_cents,
        a.past_due_at,
        a.flags
    `;

    if (accounts.length === 0) {
      console.log(`${LOG_PREFIX} No paid accounts to reconcile`);
      return { accountsChecked: 0, driftsFound: 0, errors: 0 };
    }

    const overagePriceIds = getOveragePriceIds();
    const stripe = getStripe();

    let accountsChecked = 0;
    let driftsFound = 0;
    let errors = 0;

    for (const account of accounts) {
      try {
        const outcome = await reconcileAccount(stripe, account, overagePriceIds);
        accountsChecked += outcome.accountsChecked;
        errors += outcome.errors;
        for (const payload of outcome.drifts) {
          emitDriftAlert(account.id, payload);
          driftsFound++;
        }
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `${LOG_PREFIX} Error reconciling account ${account.id}: ${message}`,
        );
      }
    }

    if (driftsFound > 0 || errors > 0) {
      console.log(
        `${LOG_PREFIX} Run complete: accountsChecked=${accountsChecked} driftsFound=${driftsFound} errors=${errors}`,
      );
    } else {
      console.log(
        `${LOG_PREFIX} Run complete: ${accountsChecked} accounts checked, no drift detected`,
      );
    }

    return { accountsChecked, driftsFound, errors };
  } finally {
    inProgress = false;
  }
}

/**
 * Starts the hourly reconciliation poller.
 */
export function startStripeLocationsReconcilePoller(): void {
  if (process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED === 'true') {
    console.log(
      `${LOG_PREFIX} STRIPE_LOCATIONS_RECONCILE_DISABLED=true — not starting`,
    );
    return;
  }
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    console.log(
      `${LOG_PREFIX} MOCK_EXTERNAL_APIS=true — not starting`,
    );
    return;
  }

  // Idempotent start
  if (timer !== null) {
    console.log(
      `${LOG_PREFIX} Already started — ignoring duplicate startStripeLocationsReconcilePoller() call`,
    );
    return;
  }

  const envInterval = process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
  const parsed = envInterval ? parseInt(envInterval, 10) : NaN;
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  console.log(`${LOG_PREFIX} Starting (interval=${interval}ms)`);
  runOnce().catch((err) =>
    console.error(`${LOG_PREFIX} Initial run failed:`, err),
  );
  timer = setInterval(() => {
    runOnce().catch((err) =>
      console.error(`${LOG_PREFIX} Scheduled run failed:`, err),
    );
  }, interval);
}

/**
 * Stops the reconciliation poller.
 */
export function stopStripeLocationsReconcilePoller(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
  // Do NOT reset inProgress. If stop() fires mid-runOnce (graceful
  // shutdown), the in-flight run's finally{} clears the flag itself.
  // Same pattern as EmailChannelReconcilePoller.
}
```

- [ ] **Step 7: Run the full poller suite + both new unit suites**

Run: `pnpm exec vitest run worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts worker/background/pollers/__tests__/stripe-overage.test.ts worker/background/pollers/__tests__/reconcile-account.test.ts`
Expected: PASS — all suites green (the ~40 characterization tests + the new unit tests).

- [ ] **Step 8: Commit**

```bash
git add worker/background/pollers/billing-reconciliation/types.ts \
        worker/background/pollers/billing-reconciliation/reconcile-account.ts \
        worker/background/pollers/__tests__/reconcile-account.test.ts \
        worker/background/pollers/StripeLocationsReconcilePoller.ts
git commit -m "refactor(billing): extract per-account reconcile step; slim poller to orchestrator"
```

---

## Task 4: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS (0 errors). If lint flags the `as any` casts in the new test files, confirm the project's ESLint test override allows them (the existing `StripeLocationsReconcilePoller.test.ts` already uses `any`); only adjust if lint actually errors.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (0 errors).

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS — same baseline as before the refactor (4251 passed, 3 skipped) **plus** the new `stripe-overage` and `reconcile-account` unit tests.

- [ ] **Step 4: Tenant-scope audit (the poller runs a cross-account query)**

Run: `pnpm ci:tenant-scope`
Expected: PASS. The cross-account `SELECT ... FROM accounts` query is unchanged and still lives in `StripeLocationsReconcilePoller.ts`, so the existing allowlist entry remains valid. If the audit fails because it keys on the moved/renamed structure, re-point the existing allowlist entry to the unchanged query in the poller (do not broaden it).

- [ ] **Step 5: Commit any fixups**

If Steps 1–4 required changes:

```bash
git add -A
git commit -m "refactor(billing): verification-gate fixups"
```

Otherwise no commit needed — the refactor is complete.

---

## Self-Review

**Spec coverage:**
- Module layout (stripe-overage, account-flags, drift-alert, reconcile-account, types `AccountWithLocations`, thin orchestrator) → Tasks 1–3. ✓
- `reconcileAccount` contract (`AccountReconcileOutcome`, injected `stripe`) → Task 3, Step 4. ✓
- Orchestrator shape (collect-then-emit loop, per-account catch) → Task 3, Step 6. ✓
- Behavior-preservation map (unknown tier, missing sub, 404 handled, non-missing re-throw, dup-list handled, invoice-preview handled, checked/errors timing) → encoded in `reconcile-account.ts` (Task 3 Step 4) and asserted in `reconcile-account.test.ts` (Task 3 Step 2). ✓
- Emission-order deviation (documented-safe) → realized by the collect-then-emit loop; characterization suite (order-independent) guards it. ✓
- Testing plan (regression net untouched + 2 new unit files) → Tasks 1, 3. ✓
- Public surface unchanged (`runOnce`/`start`/`stop`) → Task 3 Step 6 keeps all three exports; `worker/index.ts` untouched. ✓
- Out-of-scope `past-due-recovery.ts` duplicate `parseAccountFlags` → not touched by any task. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows complete code; every run step shows command + expected result. ✓

**Type consistency:** `AccountWithLocations` (types.ts) is the input to `reconcileAccount`; `AccountReconcileOutcome { accountsChecked, drifts, errors }` is produced in Task 3 Step 4 and consumed in Task 3 Step 6 with matching field names. `DriftAlertPayload` is defined in `drift-alert.ts` (Task 2) and imported as a type by `reconcile-account.ts` (Task 3). `LOG_PREFIX` is defined once in `constants.ts` (Task 2) and imported by `drift-alert.ts`, `reconcile-account.ts`, and the poller. `getOveragePriceIds` stays imported by the poller in the final rewrite; the other stripe-overage helpers move to `reconcile-account.ts` only. ✓
```
