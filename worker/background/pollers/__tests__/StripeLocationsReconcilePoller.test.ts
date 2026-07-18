// worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
//
// TDD assertions for StripeLocationsReconcilePoller.
// Hourly drift detection: compares actual non-archived location count
// against Stripe subscription_items[overage].quantity. Emits Sentry
// alert (or a warn-level structured JSON log line when Sentry DSN unset)
// when drift > 0. Does NOT auto-correct — manual investigation only.
//
// The structured logger is NOT mocked here on purpose: the drift-alert
// fallback contract is "one JSON line via console.warn", so the console
// spies assert the real emitted line.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ─────────────────────────────────────────────

const { sqlReturnQueue, mockSql, sqlCalls } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const mockSql: any = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ template: strings.join('?'), values });
      const result = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(result);
    },
  );
  return { sqlReturnQueue, mockSql, sqlCalls };
});

const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));

// Mock Sentry — always returns a captureMessage function.
// The poller checks process.env.SENTRY_DSN at runtime to decide
// whether to call Sentry or fall back to a warn-level structured log.
vi.mock('../../../../worker/sentry', () => ({
  Sentry: {
    init: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureMessage: mockCaptureMessage,
    captureException: vi.fn(),
  },
}));

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

// Mock Stripe SDK — returns a lazy getter the poller can use
const { mockStripeRetrieve, mockStripeList, mockStripeCreatePreview } = vi.hoisted(() => ({
  mockStripeRetrieve: vi.fn(),
  mockStripeList: vi.fn(),
  mockStripeCreatePreview: vi.fn(),
}));

vi.mock('stripe', () => {
  return {
    __esModule: true,
    default: class MockStripe {
      subscriptions = {
        retrieve: mockStripeRetrieve,
        list: mockStripeList,
      };
      invoices = {
        createPreview: mockStripeCreatePreview,
      };
    },
  };
});

// Import AFTER mocks are wired
import { TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';
import { expectedInvoiceForAccount } from '../billing-reconciliation/expected-invoice';
import {
  compareUpcomingInvoice,
  isExpectedStatusWindow,
  recurringSubscriptionLineTotalCents,
} from '../billing-reconciliation/drift';
import {
  runOnce,
  reconcileCycle,
  resetAccountCursorForTests,
  beginCursorLoadForTests,
  startStripeLocationsReconcilePoller,
  stopStripeLocationsReconcilePoller,
} from '../StripeLocationsReconcilePoller';
import { emitDriftAlert } from '../billing-reconciliation/drift-alert';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';

// ── Helpers ────────────────────────────────────────────────────────

/** Build a Stripe subscription object with overage item. */
function makeStripeSubscription(
  overageQuantity: number,
  overagePriceId = 'price_overage_copilot',
  overageUnitAmount = 1500,
) {
  return {
    id: 'sub_test',
    customer: 'cus_123',
    status: 'active',
    items: {
      data: [
        { id: 'si_base', price: { id: 'price_base', unit_amount: 2900 }, quantity: 1 },
        {
          id: 'si_overage',
          price: { id: overagePriceId, unit_amount: overageUnitAmount },
          quantity: overageQuantity,
        },
      ],
    },
  };
}

/** Build a Stripe subscription with no overage item. */
function makeStripeSubscriptionNoOverage(baseUnitAmount = 2900) {
  return {
    id: 'sub_test',
    customer: 'cus_123',
    status: 'active',
    items: {
      data: [
        { id: 'si_base', price: { id: 'price_base', unit_amount: baseUnitAmount }, quantity: 1 },
      ],
    },
  };
}

interface InvoicePreviewOptions {
  baseCents?: number;
  overageUnits?: number;
  overageUnitCents?: number;
  totalCents?: number;
  prorationCents?: number;
  lineAmountDiscountCents?: number;
  overagePriceId?: string;
}

function makeInvoicePreview(options: InvoicePreviewOptions = {}) {
  const baseCents = options.baseCents ?? 2900;
  const overageUnits = options.overageUnits ?? 2;
  const overageUnitCents = options.overageUnitCents ?? 1500;
  const recurringTotal = baseCents + overageUnits * overageUnitCents;
  const totalCents = options.totalCents
    ?? recurringTotal
      + (options.prorationCents ?? 0)
      - (options.lineAmountDiscountCents ?? 0);
  const lines = [
    {
      id: 'il_base',
      amount: baseCents,
      subtotal: baseCents,
      quantity: 1,
      price: { id: 'price_base', unit_amount: baseCents },
      pricing: { unit_amount_decimal: String(baseCents) },
      parent: {
        subscription_item_details: {
          proration: false,
          subscription_item: 'si_base',
        },
      },
    },
  ];

  if (overageUnits > 0) {
    lines.push({
      id: 'il_overage',
      amount: overageUnits * overageUnitCents - (options.lineAmountDiscountCents ?? 0),
      subtotal: overageUnits * overageUnitCents,
      quantity: overageUnits,
      price: {
        id: options.overagePriceId ?? 'price_overage_copilot',
        unit_amount: overageUnitCents,
      },
      pricing: { unit_amount_decimal: String(overageUnitCents) },
      parent: {
        subscription_item_details: {
          proration: false,
          subscription_item: 'si_overage',
        },
      },
    });
  }

  if (options.prorationCents) {
    lines.push({
      id: 'il_proration',
      amount: options.prorationCents,
      subtotal: options.prorationCents,
      quantity: 1,
      price: { id: 'price_overage_copilot', unit_amount: options.prorationCents },
      pricing: { unit_amount_decimal: String(options.prorationCents) },
      parent: {
        subscription_item_details: {
          proration: true,
          subscription_item: 'si_overage',
        },
      },
    });
  }

  return {
    total: totalCents,
    lines: { data: lines },
  };
}

interface AccountRow {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  locations_included: number;
  locations_paid: number;
  locations_overage_price_cents: number;
  base_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown> | string;
}

function makeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  const tier = overrides.subscription_tier ?? 'copilot';
  return {
    id: 'acct-1',
    subscription_tier: tier,
    subscription_status: 'active',
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    locations_included: 1,
    locations_paid: 2,
    locations_overage_price_cents: tier === 'autopilot' ? 2000 : 1500,
    base_price_cents: TIER_CONFIG[tier as keyof typeof TIER_CONFIG]?.baseByVariant.list ?? 2900,
    active_location_count: 3,
    past_due_at: null,
    flags: {},
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('billing reconciliation helpers', () => {
  it('derives all invoice math from the stored Copilot snapshot, never the registry', () => {
    const invoice = expectedInvoiceForAccount({
      id: 'acct-stored-only',
      subscription_tier: 'copilot',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      base_price_cents: 2711, // deliberately differs from canonical 2900
      locations_included: 2, // deliberately differs from canonical 1
      locations_overage_price_cents: 1333, // differs from canonical 1500
      active_location_count: 5,
      past_due_at: null,
      flags: {},
    });

    expect(invoice).toEqual({
      baseCents: 2711,
      overageUnits: 3,
      overageUnitPriceCents: 1333,
      totalCents: 2711 + 3 * 1333,
    });
  });

  it('uses stored overage price instead of live tier overage config', () => {
    const invoice = expectedInvoiceForAccount({
      id: 'acct-grandfathered',
      subscription_tier: 'copilot',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      base_price_cents: 7900,
      locations_included: 1,
      locations_overage_price_cents: 3000,
      active_location_count: 3,
      past_due_at: null,
      flags: {},
    });

    expect(invoice.overageUnits).toBe(2);
    expect(invoice.overageUnitPriceCents).toBe(3000);
    expect(invoice.totalCents).toBe(7900 + 2 * 3000);
  });

  it('uses stored base price instead of live tier base config (founding price-lock)', () => {
    const invoice = expectedInvoiceForAccount({
      id: 'acct-grandfathered-base',
      subscription_tier: 'copilot',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_123',
      base_price_cents: 1500, // stored differs from the current founding Copilot price
      locations_included: 1,
      locations_overage_price_cents: 2500,
      active_location_count: 3,
      past_due_at: null,
      flags: {},
    });

    expect(invoice.baseCents).toBe(1500);
    expect(invoice.totalCents).toBe(1500 + 2 * 2500);
  });

  it('does not flag one-cent invoice rounding differences', () => {
    expect(compareUpcomingInvoice('acct-1', 12900, 12901)).toEqual([]);
  });

  it('flags invoice drift above one cent', () => {
    expect(compareUpcomingInvoice('acct-1', 12900, 12902)[0]).toMatchObject({
      severity: 'unsafe',
      type: 'upcoming_invoice_mismatch',
    });
  });

  it('treats past_due inside grace as expected status window', () => {
    const now = new Date('2026-05-25T00:00:00.000Z');
    expect(isExpectedStatusWindow({
      id: 'acct-past-due',
      subscription_tier: 'copilot',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      base_price_cents: 7900,
      active_location_count: 1,
      past_due_at: new Date('2026-05-22T00:00:00.000Z'),
      flags: {},
    }, 'past_due', now)).toBe(true);
  });

  it('does not treat past_due outside grace as expected status window', () => {
    const now = new Date('2026-05-25T00:00:00.000Z');
    expect(isExpectedStatusWindow({
      id: 'acct-past-due',
      subscription_tier: 'copilot',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      base_price_cents: 7900,
      active_location_count: 1,
      past_due_at: new Date('2026-05-10T00:00:00.000Z'),
      flags: {},
    }, 'past_due', now)).toBe(false);
  });

  it('treats past_due past the 7d grace but within an active grant-extension as expected (deep-scan §6.3/§6.5)', () => {
    // 15 days past due (past the default 7d grace) but an admin grant-extension
    // pushes the effective deadline to 2026-05-30 — Stripe sitting in 'unpaid'
    // must NOT false-alert while the customer legitimately still has access.
    const now = new Date('2026-05-25T00:00:00.000Z');
    expect(isExpectedStatusWindow({
      id: 'acct-extended',
      subscription_tier: 'copilot',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      base_price_cents: 7900,
      active_location_count: 1,
      past_due_at: new Date('2026-05-10T00:00:00.000Z'),
      flags: { past_due_extension: { days: 7, expires_at: '2026-05-30T00:00:00.000Z' } },
    }, 'unpaid', now)).toBe(true);
  });

  it('does not treat past_due past grace with an EXPIRED extension as expected (deep-scan §6.3/§6.5)', () => {
    // Extension already lapsed (expires_at < now) → access is cut → real drift.
    const now = new Date('2026-05-25T00:00:00.000Z');
    expect(isExpectedStatusWindow({
      id: 'acct-extended-expired',
      subscription_tier: 'copilot',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      base_price_cents: 7900,
      active_location_count: 1,
      past_due_at: new Date('2026-05-10T00:00:00.000Z'),
      flags: { past_due_extension: { days: 3, expires_at: '2026-05-20T00:00:00.000Z' } },
    }, 'unpaid', now)).toBe(false);
  });

  it('does not treat missing past_due_at as expected status window', () => {
    expect(isExpectedStatusWindow({
      id: 'acct-past-due',
      subscription_tier: 'copilot',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      base_price_cents: 7900,
      active_location_count: 1,
      past_due_at: null,
      flags: {},
    }, 'past_due')).toBe(false);
  });

  it('does not treat unexpected Stripe status as expected status window', () => {
    const now = new Date('2026-05-25T00:00:00.000Z');
    expect(isExpectedStatusWindow({
      id: 'acct-past-due',
      subscription_tier: 'copilot',
      subscription_status: 'past_due',
      stripe_subscription_id: 'sub_123',
      locations_included: 1,
      locations_overage_price_cents: 2500,
      base_price_cents: 7900,
      active_location_count: 1,
      past_due_at: new Date('2026-05-22T00:00:00.000Z'),
      flags: {},
    }, 'active', now)).toBe(false);
  });

  it('normalizes preview invoices to undiscounted non-proration subscription lines', () => {
    expect(recurringSubscriptionLineTotalCents(makeInvoicePreview({
      totalCents: 11900,
      lineAmountDiscountCents: 1000,
      prorationCents: 500,
    }))).toBe(5900);
  });

  it('normalizes Stripe 22 invoice line pricing without legacy price objects', () => {
    expect(recurringSubscriptionLineTotalCents({
      lines: {
        data: [
          {
            amount: 6900,
            subtotal: 7900,
            quantity: 1,
            pricing: { unit_amount_decimal: '7900' },
            parent: {
              subscription_item_details: {
                proration: false,
                subscription_item: 'si_base',
              },
            },
          },
        ],
      },
    })).toBe(7900);
  });
});

describe('StripeLocationsReconcilePoller', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    sqlCalls.length = 0;
    // The keyset resume cursor is module state; reset so tests are independent.
    resetAccountCursorForTests();
    mockCaptureMessage.mockClear();
    mockStripeRetrieve.mockClear();
    mockStripeList.mockClear();
    mockStripeCreatePreview.mockClear();
    mockStripeList.mockResolvedValue({ data: [] });
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview());

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: SENTRY_DSN unset
    delete process.env.SENTRY_DSN;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED;
    delete process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
    delete process.env.MOCK_EXTERNAL_APIS;
    // Set env vars for Stripe price IDs
    process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_overage_copilot';
    process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_overage_autopilot';
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    // drift-alert.ts now reads SENTRY_DSN via the memoized getWorkerConfig(); clear
    // the worker memo so each test's SENTRY_DSN override (set after this beforeEach)
    // is parsed fresh (#6). Does not affect getServerConfig() (STRIPE_SECRET_KEY).
    resetWorkerConfigForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopStripeLocationsReconcilePoller();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_COPILOT_OVERAGE;
    delete process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE;
  });

  // ── No drift ────────────────────────────────────────────────────

  it('no alert when Stripe overage quantity matches DB expectation', async () => {
    // Copilot: 1 included, 3 active → expected overage = 2
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-match',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // Stripe returns overage quantity = 2 (matches DB)
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_copilot'),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(0);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no alert for a custom stored included quota when active locations equal included quota', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-custom-within',
        subscription_tier: 'copilot',
        locations_included: 3,
        active_location_count: 3,
        locations_paid: 0,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(0, 'price_overage_std'),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnits: 0,
    }));

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(0);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no alert for a custom stored included quota when Stripe overage matches stored quota math', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-custom-overage',
        subscription_tier: 'copilot',
        locations_included: 3,
        active_location_count: 5,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(0);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses stored overage price for upcoming invoice comparison', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-grandfathered',
        subscription_tier: 'copilot',
        locations_included: 1,
        locations_overage_price_cents: 3000,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_std', 3000),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnitCents: 3000,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(0);
  });

  it('recognizes retired overage price IDs by stored unit amount', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-legacy-price',
        subscription_tier: 'copilot',
        locations_included: 1,
        locations_overage_price_cents: 3000,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_std_legacy', 3000),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overagePriceId: 'price_overage_std_legacy',
      overageUnitCents: 3000,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not classify base price location wording as an overage item', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-base-location-wording',
        subscription_tier: 'copilot',
        locations_included: 1,
        locations_overage_price_cents: 3000,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue({
      id: 'sub_test',
      customer: 'cus_123',
      status: 'active',
      items: {
        data: [
          {
            id: 'si_base',
            price: {
              id: 'price_base',
              nickname: 'Copilot plan with 1 location',
              unit_amount: 2900,
            },
            quantity: 1,
          },
          {
            id: 'si_overage',
            price: {
              id: 'price_overage_std_legacy',
              nickname: 'Legacy extra location',
              unit_amount: 3000,
            },
            quantity: 2,
          },
        ],
      },
    });
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overagePriceId: 'price_overage_std_legacy',
      overageUnitCents: 3000,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not alert when preview total is lower because of a discount', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-discounted',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_copilot'),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      totalCents: 4900,
      lineAmountDiscountCents: 1000,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not alert when preview total includes pending proration lines', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-proration',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_copilot'),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      prorationCents: 500,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('alerts when upcoming invoice total differs by more than one cent', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-invoice-drift',
        subscription_tier: 'copilot',
        locations_included: 1,
        locations_overage_price_cents: 2500,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_copilot', 2500),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnitCents: 2501,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // upcoming_invoice_mismatch is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Upcoming invoice drift'),
    );
  });

  it('does not alert for Stripe past_due status during DB past_due grace', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-past-due-grace',
        subscription_status: 'past_due',
        locations_included: 1,
        active_location_count: 3,
        past_due_at: new Date('2026-05-22T00:00:00.000Z'),
      }),
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T00:00:00.000Z'));
    mockStripeRetrieve.mockResolvedValue({
      ...makeStripeSubscription(2, 'price_overage_std'),
      status: 'past_due',
    });

    const result = await runOnce();

    expect(result.driftsFound).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('alerts status_mismatch when DB is active but Stripe is trialing (PLAN §15)', async () => {
    // Trials are now a real feature. The steady state is DB-`trialing` ↔
    // Stripe-`trialing` (handled with scoped correction in reconcile-account).
    // DB `active` while Stripe says `trialing` is a genuine anomaly (e.g. a missed
    // or incorrect conversion) and MUST surface — the old no-trials-era blanket
    // suppression of Stripe-`trialing` drift was removed (deep-scan §6.5 revisited).
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-trialing',
        subscription_tier: 'copilot',
        subscription_status: 'active',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue({
      ...makeStripeSubscription(2, 'price_overage_std'),
      status: 'trialing',
    });

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // status_mismatch is a genuine entitlement drift (only emitted after the
    // expected-status-window filter) → error level, not warning (CONFIG-1).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-trialing'),
    );
  });

  // ── Drift detected ──────────────────────────────────────────────

  it('emits alert when Stripe overage quantity exceeds DB expectation', async () => {
    // Copilot: 1 included, 3 active → expected overage = 2
    // locations_paid=5 matches Stripe so mirror drift doesn't fire; the
    // quantity_mismatch (DB expects 2, Stripe has 5) is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-drift-high',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
        locations_paid: 5,
      }),
    ]);

    // Stripe returns overage quantity = 5 (drift = +3)
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(5, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(1);
    // quantity_mismatch is revenue-affecting → error level (CONFIG-1); fallback
    // path uses console.error when SENTRY_DSN is unset
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-drift-high'),
    );
  });

  it('emits alert when DB overage exceeds Stripe quantity', async () => {
    // Copilot: 1 included, 5 active → expected overage = 4
    // locations_paid=1 matches Stripe so mirror drift doesn't fire; the
    // quantity_mismatch (DB expects 4, Stripe has 1) is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-drift-low',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 5,
        locations_paid: 1,
      }),
    ]);

    // Stripe returns overage quantity = 1 (drift = -3, DB has 4 but Stripe says 1)
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(1, 'price_overage_std'),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnits: 4,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // quantity_mismatch is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-drift-low'),
    );
  });

  it('alert includes account_id, expected (from DB), and actual (from Stripe)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-detail',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 4,
      }),
    ]);

    // DB says overage = 3, Stripe says overage = 7
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(7, 'price_overage_std'),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnits: 3,
    }));

    await runOnce();

    // The warn JSON line should carry the account_id and both quantities
    // quantity_mismatch is revenue-affecting → logger.error (CONFIG-1); the
    // structured log line uses level 'error' in the JSON output
    const errorCall = errorSpy.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('acct-detail'),
    );
    expect(errorCall).toBeDefined();
    expect(errorCall!.length).toBe(1); // one JSON line per log call
    const record = JSON.parse(errorCall![0] as string);
    expect(record.level).toBe('error');
    expect(record.logger).toBe('StripeLocationsReconcilePoller');
    expect(record.message).toContain('Stripe billing drift detected');
    expect(record.data.account_id).toBe('acct-detail');
    expect(record.data.db_expected_overage).toBe(3); // expected from DB
    expect(record.data.stripe_overage_quantity).toBe(7); // actual from Stripe
  });

  // ── Sentry path when DSN is set ─────────────────────────────────

  it('uses Sentry.captureMessage when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';

    // locations_paid=10 matches Stripe so mirror drift doesn't fire; quantity_mismatch
    // (DB expects 2, Stripe has 10) is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-sentry',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
        locations_paid: 10,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(10, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // quantity_mismatch is revenue-affecting → error level (CONFIG-1)
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('acct-sentry'),
      expect.objectContaining({ level: 'error' }),
    );
    // Should NOT also emit the fallback log line when Sentry is active
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('adds typed Sentry metadata for invoice drift alerts', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';

    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-sentry-invoice',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_copilot'),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnitCents: 1501,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('Upcoming invoice drift'),
      expect.objectContaining({
        tags: expect.objectContaining({
          drift_type: 'upcoming_invoice_mismatch',
          account_id: 'acct-sentry-invoice',
        }),
        extra: expect.objectContaining({
          expectedCents: 5900,
          actualCents: 5902,
          dbStatus: 'active',
          stripeStatus: 'active',
          stripeSubscriptionId: 'sub_test',
          stripeCustomerId: 'cus_123',
        }),
      }),
    );
  });

  // ── CONFIG-1: drift alert level depends on drift type ───────────
  // Revenue-affecting drifts must emit at `error` (reaches Sentry high-priority
  // classification + any future error route). Benign/observability drifts stay
  // at `warning`. Fail-safe: unknown/future types default to `error`.

  const revenueAffectingDriftTypes = [
    'quantity_mismatch',
    'price_mismatch',
    'upcoming_invoice_mismatch',
    'missing_subscription',
    'duplicate_subscription',
    // status_mismatch is only pushed after the expected-status-window filter, so
    // any that reaches emitDriftAlert is a genuine entitlement drift → error (CONFIG-1).
    'status_mismatch',
  ] as const;

  const benignDriftTypes = [
    // locations_paid_mirror is pure observability (RECONCILE-F1 — locations_paid
    // is never billed; it is a denormalized mirror column). It is the ONLY benign type.
    'locations_paid_mirror',
  ] as const;

  const basePayload = {
    dbExpectedOverage: 2,
    stripeOverageQuantity: 5,
    activeLocations: 3,
    locationsIncluded: 1,
    tier: 'copilot',
  };

  for (const driftType of revenueAffectingDriftTypes) {
    it(`emitDriftAlert emits level 'error' for revenue-affecting drift type '${driftType}'`, () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      mockCaptureMessage.mockClear();

      emitDriftAlert('acct-level-test', { ...basePayload, driftType });

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ level: 'error' }),
      );
    });
  }

  for (const driftType of benignDriftTypes) {
    it(`emitDriftAlert emits level 'warning' for benign drift type '${driftType}'`, () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      mockCaptureMessage.mockClear();

      emitDriftAlert('acct-level-test', { ...basePayload, driftType });

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ level: 'warning' }),
      );
    });
  }

  it('emitDriftAlert fails safe to error level for unknown drift type (undefined)', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';
    mockCaptureMessage.mockClear();

    emitDriftAlert('acct-level-test', { ...basePayload, driftType: undefined });

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ level: 'error' }),
    );
  });

  // ── Subscription-level drift ────────────────────────────────────

  it('alerts when a paid DB account is missing stripe_subscription_id', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-no-subscription-id',
        stripe_subscription_id: null,
      }),
    ]);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(1);
    expect(mockStripeRetrieve).not.toHaveBeenCalled();
    // missing_subscription is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing Stripe subscription id'),
    );
  });

  it('alerts when Stripe no longer has the DB subscription id', async () => {
    const missingSubscriptionError = Object.assign(
      new Error('No such subscription: sub_missing'),
      { code: 'resource_missing', statusCode: 404 },
    );
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-sub-missing-in-stripe',
        stripe_subscription_id: 'sub_missing',
      }),
    ]);
    mockStripeRetrieve.mockRejectedValueOnce(missingSubscriptionError);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.driftsFound).toBe(1);
    // missing_subscription is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stripe subscription sub_missing is missing'),
    );
  });

  it('alerts when a Stripe customer has duplicate active subscriptions', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-duplicate-subscriptions',
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_std'),
    );
    mockStripeList.mockResolvedValue({
      data: [
        { id: 'sub_123', status: 'active' },
        { id: 'sub_duplicate', status: 'active' },
        { id: 'sub_canceled', status: 'canceled' },
      ],
    });

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // duplicate_subscription is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate active Stripe subscriptions'),
    );
  });

  it('alerts when an overage item uses the wrong stored account price', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-overage-price-drift',
        locations_overage_price_cents: 2500,
        active_location_count: 3,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(2, 'price_overage_copilot', 3000),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnitCents: 2500,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // price_mismatch is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stripe overage price 3000 differs from stored account price 2500'),
    );
  });

  it('includes the pilot invoice-review flag in Sentry drift metadata', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';

    // locations_paid=5 matches Stripe so mirror drift doesn't fire; quantity_mismatch
    // (DB expects 2, Stripe has 5) is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-pilot-drift',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
        locations_paid: 5,
        flags: { is_pilot: true },
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(5, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('acct-pilot-drift'),
      expect.objectContaining({
        tags: expect.objectContaining({
          account_id: 'acct-pilot-drift',
          is_pilot: 'true',
        }),
        extra: expect.objectContaining({
          isPilot: true,
        }),
      }),
    );
  });

  it('parses JSONB string account flags for pilot drift metadata', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/123';

    // locations_paid=5 matches Stripe so mirror drift doesn't fire; quantity_mismatch
    // (DB expects 2, Stripe has 5) is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-pilot-jsonb-string',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
        locations_paid: 5,
        flags: JSON.stringify({ is_pilot: true }),
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(5, 'price_overage_std'),
    );

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('acct-pilot-jsonb-string'),
      expect.objectContaining({
        tags: expect.objectContaining({
          account_id: 'acct-pilot-jsonb-string',
          is_pilot: 'true',
        }),
        extra: expect.objectContaining({
          isPilot: true,
        }),
      }),
    );
  });

  // ── Skips non-active subscriptions ─────────────────────────────

  it('skips accounts with non-active subscription status', async () => {
    // Simulate the SQL query returning empty results (the real query
    // filters WHERE subscription_status = 'active', so non-active
    // accounts never appear in the result set)
    sqlReturnQueue.push([]);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(0);
    expect(mockStripeRetrieve).not.toHaveBeenCalled();
  });

  // ── Handles subscription with no overage item ────────────────────

  it('handles a Copilot subscription with no overage item inside its included quota', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-without-overage',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 1,
        locations_paid: 0,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscriptionNoOverage(2900),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      baseCents: 2900,
      overageUnits: 0,
    }));

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    // One included location and no overage item → no drift.
    expect(result.driftsFound).toBe(0);
  });

  it('detects drift when overage item is missing but DB expects overage', async () => {
    // locations_paid=0 matches Stripe (no overage item → stripeOverageQuantity=0)
    // so mirror drift doesn't fire; quantity_mismatch is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-missing-overage',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 4,
        locations_paid: 0,
      }),
    ]);

    // Stripe subscription has no overage item but DB expects 3 overage
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscriptionNoOverage(),
    );
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      overageUnits: 3,
    }));

    const result = await runOnce();

    expect(result.driftsFound).toBe(1);
    // quantity_mismatch is revenue-affecting → error level (CONFIG-1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('acct-missing-overage'),
    );
  });

  // ── No drift when overage quantity is 0 and DB expects 0 ─────────

  it('no alert when overage quantity is 0 and DB expects 0 (within included quota)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-within',
        subscription_tier: 'autopilot',
        locations_included: 5,
        locations_overage_price_cents: 2000,
        active_location_count: 3,
        locations_paid: 0,
      }),
    ]);

    mockStripeRetrieve.mockResolvedValue({
      ...makeStripeSubscription(0, 'price_overage_autopilot', 2000),
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_base_autopilot', unit_amount: 6900 }, quantity: 1 },
          {
            id: 'si_overage',
            price: { id: 'price_overage_autopilot', unit_amount: 2000 },
            quantity: 0,
          },
        ],
      },
    });
    mockStripeCreatePreview.mockResolvedValue(makeInvoicePreview({
      baseCents: 6900,
      overageUnits: 0,
      overageUnitCents: 2000,
      overagePriceId: 'price_overage_autopilot',
    }));

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(0);
  });

  // ── Does NOT auto-correct ───────────────────────────────────────

  it('does NOT auto-correct Stripe quantity (no stripe.subscriptionItems.update call)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-no-autocorrect',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // Stripe says 10 but DB says 2 overage — big drift
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(10, 'price_overage_std'),
    );

    await runOnce();

    // No subscriptionItems.update should be called — manual investigation only
    const updateCalls = sqlCalls.filter(
      (c) => c.template.includes('subscriptionItems') || c.template.includes('UPDATE accounts'),
    );
    expect(updateCalls.length).toBe(0);
  });

  // ── Multiple accounts ───────────────────────────────────────────

  it('processes multiple accounts and reports per-account drift', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-ok',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
        locations_paid: 2,
      }),
      makeAccountRow({
        id: 'acct-drift',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 5,
        locations_paid: 1,
      }),
    ]);

    // First account: no drift (3 locations - 1 included = 2 overage, locations_paid=2 ✓)
    // Second account: quantity_mismatch (DB expects 4, Stripe has 1); locations_paid=1
    // matches Stripe so mirror drift doesn't also fire → driftsFound stays at 1.
    mockStripeRetrieve
      .mockResolvedValueOnce(makeStripeSubscription(2, 'price_overage_std'))
      .mockResolvedValueOnce(makeStripeSubscription(1, 'price_overage_std'));
    mockStripeCreatePreview
      .mockResolvedValueOnce(makeInvoicePreview())
      .mockResolvedValueOnce(makeInvoicePreview({ overageUnits: 4 }));

    const result = await runOnce();

    expect(result.accountsChecked).toBe(2);
    expect(result.driftsFound).toBe(1);
  });

  // ── Stripe API error handling ────────────────────────────────────

  it('continues processing after Stripe API error on one account', async () => {
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-fail',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
      makeAccountRow({
        id: 'acct-ok',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
      }),
    ]);

    // First account: Stripe API error
    mockStripeRetrieve
      .mockRejectedValueOnce(new Error('Stripe API timeout'))
      .mockResolvedValueOnce(makeStripeSubscription(2, 'price_overage_std'));

    const result = await runOnce();

    // First account errored out, second succeeded — only 1 checked
    expect(result.accountsChecked).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.driftsFound).toBe(0); // second account matches
  });

  it('still reports quantity drift when invoice preview fails', async () => {
    // locations_paid=5 matches Stripe so mirror drift doesn't fire; quantity_mismatch
    // (DB expects 2, Stripe has 5) is the single drift under test.
    sqlReturnQueue.push([
      makeAccountRow({
        id: 'acct-preview-fails',
        subscription_tier: 'copilot',
        locations_included: 1,
        active_location_count: 3,
        locations_paid: 5,
      }),
    ]);
    mockStripeRetrieve.mockResolvedValue(
      makeStripeSubscription(5, 'price_overage_std'),
    );
    mockStripeCreatePreview.mockRejectedValue(new Error('preview timeout'));

    const result = await runOnce();

    expect(result.accountsChecked).toBe(1);
    expect(result.driftsFound).toBe(1);
    expect(result.errors).toBe(1);
    // quantity_mismatch is revenue-affecting → error level (CONFIG-1)
    // Both the drift alert and the preview-failure error land on errorSpy
    const errorLines = errorSpy.mock.calls.map((c: any[]) => c[0]);
    expect(errorLines.some(
      (line: unknown): boolean => typeof line === 'string' && line.includes('acct-preview-fails'),
    )).toBe(true);
    const previewErrorLine = errorLines.find(
      (line: unknown): line is string =>
        typeof line === 'string'
        && line.includes('Invoice-preview reconciliation UNAVAILABLE'),
    );
    expect(previewErrorLine).toBeDefined();
    expect(previewErrorLine).toContain('acct-preview-fails');
  });

  // ── No accounts to check ────────────────────────────────────────

  it('returns zero counts when no accounts have Stripe subscriptions', async () => {
    sqlReturnQueue.push([]);

    const result = await runOnce();

    expect(result.accountsChecked).toBe(0);
    expect(result.driftsFound).toBe(0);
    expect(result.errors).toBe(0);
  });

  // ── Poller start/stop ───────────────────────────────────────────

  it('start creates interval timer and stop clears it', async () => {
    startStripeLocationsReconcilePoller();
    // Timer should be created (poller is running)
    // Stop should clear it
    stopStripeLocationsReconcilePoller();
    // No assertion on internals — just verify no crash
  });

  it('idempotent start ignores duplicate calls', async () => {
    startStripeLocationsReconcilePoller();
    startStripeLocationsReconcilePoller(); // duplicate
    stopStripeLocationsReconcilePoller();
  });

  it('delays the first run past the boot-storm window (does not query immediately)', async () => {
    vi.useFakeTimers();
    sqlReturnQueue.push([]); // boot cursor-load: no persisted cursor
    sqlReturnQueue.push([]); // if/when the reconcile runs, no accounts

    startStripeLocationsReconcilePoller();
    // start() kicks the durable cursor boot-load, but the reconcile CYCLE (the
    // accounts query with ORDER BY a.id) must NOT fire immediately.
    const accountsQueriedAtBoot = sqlCalls.some((c) => c.template.includes('ORDER BY a.id ASC'));
    expect(accountsQueriedAtBoot).toBe(false);

    // After the boot-delay, the initial reconcile run fires the accounts query.
    await vi.advanceTimersByTimeAsync(45_000 + 100); // past INITIAL_RUN_DELAY_MS
    const accountsQueriedAfterDelay = sqlCalls.some((c) => c.template.includes('ORDER BY a.id ASC'));
    expect(accountsQueriedAfterDelay).toBe(true);

    stopStripeLocationsReconcilePoller();
    vi.useRealTimers();
  });

  // ── Disabled in mock mode ───────────────────────────────────────

  it('does not start when MOCK_EXTERNAL_APIS=true', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    startStripeLocationsReconcilePoller();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('MOCK_EXTERNAL_APIS=true'),
    );
    stopStripeLocationsReconcilePoller();
    delete process.env.MOCK_EXTERNAL_APIS;
  });

  // ── Disabled with env flag ──────────────────────────────────────

  it('does not start when STRIPE_LOCATIONS_RECONCILE_DISABLED=true', () => {
    process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED = 'true';
    startStripeLocationsReconcilePoller();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('STRIPE_LOCATIONS_RECONCILE_DISABLED=true'),
    );
    stopStripeLocationsReconcilePoller();
    delete process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED;
  });

  // ── Single-flight guard ─────────────────────────────────────────

  it('skips tick when previous run is still in progress', async () => {
    // First call: return accounts but don't resolve Stripe yet
    sqlReturnQueue.push([
      makeAccountRow({ id: 'acct-slow' }),
    ]);

    let resolveStripe: (value: unknown) => void;
    const stripePromise = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    mockStripeRetrieve.mockReturnValueOnce(stripePromise);

    // Start first runOnce
    const firstRun = runOnce();

    // Try to start a second run concurrently
    const secondRun = runOnce();

    // Resolve the Stripe call
    resolveStripe!(makeStripeSubscription(2, 'price_overage_std'));

    const [first, second] = await Promise.all([firstRun, secondRun]);

    // First run should have checked the account
    expect(first.accountsChecked).toBe(1);
    // Second run should have been skipped (single-flight)
    expect(second.accountsChecked).toBe(0);
  });

  // ── Hard deadline: a stuck run must NOT wedge the poller ─────────
  // Regression for the staging finding (2026-06-22): the deployed runOnce
  // parked on Postgres pool acquisition, logged 'Starting' but never completed,
  // and held inProgress=true forever — every later tick skipped, silently
  // disabling the missed-webhook backstop. The cycle/account timeouts fix that.

  it('cycle timeout releases inProgress so the next tick is not wedged forever', async () => {
    vi.useFakeTimers();
    // The accounts query parks forever (simulates pool-acquisition starvation).
    mockSql.mockImplementationOnce(() => new Promise(() => {}));

    const firstRun = runOnce();
    await vi.advanceTimersByTimeAsync(240_000 + 1_000); // past CYCLE_TIMEOUT_MS
    const first = await firstRun;

    expect(first.errors).toBe(1);
    const deadlineLine = errorSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('exceeded its deadline'));
    expect(deadlineLine).toBeDefined();

    // inProgress MUST be reset: a second tick actually RUNS (not the skip path).
    logSpy.mockClear();
    sqlReturnQueue.push([]); // second run sees no accounts
    const second = await runOnce();

    expect(second).toEqual({ accountsChecked: 0, driftsFound: 0, errors: 0 });
    const skipLine = logSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Previous run still in progress'));
    expect(skipLine).toBeUndefined();
    vi.useRealTimers();
  });

  it('an aborted cycle signal stops the loop before launching any per-account work', async () => {
    // RECONCILE-F5: when runOnce's cycle deadline fires, it aborts the controller
    // so the DETACHED cycle stops launching NEW per-account work (it cannot cancel
    // the in-flight HTTP call — Stripe SDK v22 has no request AbortSignal). Drive
    // reconcileCycle directly with an already-aborted signal: it must process ZERO
    // accounts even though the query returns one.
    sqlReturnQueue.push([
      makeAccountRow({ id: 'acct-should-not-run', subscription_tier: 'copilot', locations_included: 1, active_location_count: 3 }),
    ]);

    const result = await reconcileCycle(AbortSignal.abort());

    expect(result).toEqual({ accountsChecked: 0, driftsFound: 0, errors: 0 });
    expect(mockStripeRetrieve).not.toHaveBeenCalled();
    const abortLine = logSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Cycle aborted'));
    expect(abortLine).toBeDefined();
  });

  it('per-account timeout errors that account and continues the cycle', async () => {
    vi.useFakeTimers();
    sqlReturnQueue.push([
      makeAccountRow({ id: 'acct-hang', subscription_tier: 'copilot', locations_included: 1, active_location_count: 3 }),
      makeAccountRow({ id: 'acct-ok', subscription_tier: 'copilot', locations_included: 1, active_location_count: 3 }),
    ]);
    // First account parks on the Stripe retrieve; second resolves normally.
    mockStripeRetrieve.mockReturnValueOnce(new Promise(() => {}));
    mockStripeRetrieve.mockResolvedValue(makeStripeSubscription(2, 'price_overage_std'));

    const run = runOnce();
    await vi.advanceTimersByTimeAsync(60_000 + 1_000); // past ACCOUNT_TIMEOUT_MS
    const result = await run;

    expect(result.errors).toBe(1); // acct-hang timed out
    expect(result.accountsChecked).toBe(1); // acct-ok still processed
    const hangLine = errorSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('acct-hang'));
    expect(hangLine).toBeDefined();
    vi.useRealTimers();
  });

  // ── Keyset resume cursor (100-business perf pass) ────────────────

  it('deadline abort mid-list stores a cursor; the next cycle resumes after it and a drained tail wraps to the top', async () => {
    // 4 accounts with fan-out concurrency 3: the three workers claim
    // acct-a/b/c synchronously, the abort fires during their Stripe work,
    // so acct-d is never claimed this cycle.
    sqlReturnQueue.push([
      makeAccountRow({ id: 'acct-a' }),
      makeAccountRow({ id: 'acct-b' }),
      makeAccountRow({ id: 'acct-c' }),
      makeAccountRow({ id: 'acct-d' }),
    ]);
    const controller = new AbortController();
    // Abort on a macrotask so all three pool workers have claimed their
    // account (and parked on the Stripe retrieve) before the signal flips.
    mockStripeRetrieve.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            controller.abort();
            resolve(makeStripeSubscription(2, 'price_overage_copilot'));
          }, 0);
        }),
    );

    await reconcileCycle(controller.signal);

    const firstQuery = sqlCalls[0]!;
    expect(firstQuery.template).toContain('ORDER BY a.id ASC');
    // Fresh rotation: the cursor param is bound as null.
    expect(firstQuery.values).toContain(null);

    // Next cycle resumes after the last CLAIMED account (acct-c).
    sqlCalls.length = 0;
    sqlReturnQueue.push([]);
    mockStripeRetrieve.mockResolvedValue(makeStripeSubscription(2, 'price_overage_copilot'));
    await reconcileCycle(new AbortController().signal);
    expect(sqlCalls[0]!.values).toContain('acct-c');

    // The empty tail completed the rotation — the cycle after starts from the top.
    sqlCalls.length = 0;
    sqlReturnQueue.push([]);
    await reconcileCycle(new AbortController().signal);
    expect(sqlCalls[0]!.values).toContain(null);
    expect(sqlCalls[0]!.values).not.toContain('acct-c');
  });

  it('a fully-drained cycle leaves no cursor (next cycle scans from the top)', async () => {
    sqlReturnQueue.push([
      makeAccountRow({ id: 'acct-a', locations_included: 1, active_location_count: 3 }),
      makeAccountRow({ id: 'acct-b', locations_included: 1, active_location_count: 3 }),
    ]);
    mockStripeRetrieve.mockResolvedValue(makeStripeSubscription(2, 'price_overage_copilot'));

    await reconcileCycle(new AbortController().signal);

    sqlCalls.length = 0;
    sqlReturnQueue.push([]);
    await reconcileCycle(new AbortController().signal);
    expect(sqlCalls[0]!.values).toContain(null);
    expect(sqlCalls[0]!.values).not.toContain('acct-b');
  });

  // ── Durable cursor persistence (T1, migration 079 + ADR 0006) ────

  it('boot-load seeds accountCursor before the first cycle reads it', async () => {
    // Persisted cursor from a prior rotation; boot must seed it so the first
    // cycle resumes AFTER it rather than re-walking the head.
    sqlReturnQueue.push([{ cursor: 'acct-boot', write_seq: 12 }]); // cursor load
    await beginCursorLoadForTests();

    sqlReturnQueue.push([]); // accounts query → empty (end of resumed rotation)
    await reconcileCycle(new AbortController().signal);

    const accountsQuery = sqlCalls.find((c) => c.template.includes('ORDER BY a.id ASC'))!;
    expect(accountsQuery.values).toContain('acct-boot');
  });

  it('boot-load seeds writeSeq so the first post-restart save carries a higher seq (not CAS-rejected)', async () => {
    sqlReturnQueue.push([{ cursor: 'acct-seed', write_seq: 42 }]); // cursor load
    await beginCursorLoadForTests();

    sqlReturnQueue.push([]); // accounts query → empty
    await runOnce();

    const persist = sqlCalls.find((c) => c.template.includes('INSERT INTO poller_cursors'))!;
    expect(persist).toBeDefined();
    // values = [POLLER_NAME, cursor, writeSeq]; seq must be loaded (42) + 1 = 43,
    // strictly greater than the persisted seq → the CAS accepts it.
    expect(persist.values[2]).toBe(43);
  });

  it('a never-settling boot-load does not wedge the poller — inProgress is released and the next tick runs', async () => {
    vi.useFakeTimers();
    // Boot cursor-load parks forever; its own withTimeout settles cursorLoaded so
    // the cycle proceeds and the finally releases inProgress. (The cycle deadline
    // is a further backstop.)
    mockSql.mockImplementationOnce(() => new Promise(() => {})); // cursor SELECT parks
    beginCursorLoadForTests();
    sqlReturnQueue.push([]); // accounts query once the load settles

    const firstRun = runOnce();
    await vi.advanceTimersByTimeAsync(240_000 + 1_000); // past every bound
    await firstRun;

    // inProgress MUST be released: a second tick actually RUNS (not the skip path).
    logSpy.mockClear();
    sqlReturnQueue.push([]);
    await runOnce();
    const skipLine = logSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Previous run still in progress'));
    expect(skipLine).toBeUndefined();
    vi.useRealTimers();
  });

  it('a cursor persist timeout in finally is swallowed and inProgress is still released', async () => {
    vi.useFakeTimers();
    // call 1: accounts query → empty; call 2: the finally saveCursor INSERT parks
    // forever → its withTimeout(CURSOR_SAVE_TIMEOUT_MS) rejects → .catch swallows.
    mockSql
      .mockImplementationOnce(() => Promise.resolve([])) // accounts query
      .mockImplementationOnce(() => new Promise(() => {})); // saveCursor parks

    const run = runOnce();
    await vi.advanceTimersByTimeAsync(10_000 + 100); // past CURSOR_SAVE_TIMEOUT_MS
    const result = await run;

    // The persist failure must NOT fail the run.
    expect(result.errors).toBe(0);
    const persistFail = errorSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Cursor persist failed'));
    expect(persistFail).toBeDefined();

    // inProgress released → the next tick runs (not skipped).
    logSpy.mockClear();
    sqlReturnQueue.push([]);
    await runOnce();
    const skipLine = logSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Previous run still in progress'));
    expect(skipLine).toBeUndefined();
    vi.useRealTimers();
  });
});
