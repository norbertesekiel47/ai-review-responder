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
  resetTruncationStateForTests,
  beginCursorLoadForTests,
  simulateBootLoadedForTests,
  startStripeLocationsReconcilePoller,
  stopStripeLocationsReconcilePoller,
} from '../StripeLocationsReconcilePoller';
import { emitDriftAlert } from '../billing-reconciliation/drift-alert';
import { resetWorkerConfigForTests } from '../../../../src/lib/config/worker';
import { resetServerConfigForTests } from '../../../../src/lib/config/server';
import { resetStripeClientForTests } from '../../../../src/lib/payments/stripe-client';

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
    // Default posture for the many runOnce-driving tests: pretend the durable
    // boot-load already completed (empty cursor, seeded writeSeq) so runOnce does
    // NOT issue a first-tick cursor-load (FIX 3) or an unseeded re-seed (FIX 1a)
    // that would steal a mock-`sql` FIFO entry. Boot-load-specific tests below
    // reset back to the null/unseeded state explicitly.
    simulateBootLoadedForTests();
    // The sustained-truncation counter is also module state.
    resetTruncationStateForTests();
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

  it('defers the cursor boot-load past the boot-storm — start() queries NOTHING; the first tick kicks the load AND the accounts query (FIX 3)', async () => {
    vi.useFakeTimers();
    // Undo the default simulated boot-load so runOnce genuinely lazily kicks it.
    resetAccountCursorForTests();
    sqlReturnQueue.push([]); // first-tick cursor-load: no persisted cursor
    sqlReturnQueue.push([]); // reconcile accounts query: no accounts

    startStripeLocationsReconcilePoller();
    // FIX 3: start() no longer kicks the cursor boot-load — it is deferred to the
    // first tick so its SELECT lands post boot-storm. So NOTHING queries at boot:
    // neither the cursor load nor the reconcile CYCLE (ORDER BY a.id) fires yet.
    expect(sqlCalls.length).toBe(0);

    // After the boot-delay, the first tick lazily kicks the cursor-load (SELECT
    // cursor, write_seq) AND fires the accounts query.
    await vi.advanceTimersByTimeAsync(45_000 + 100); // past INITIAL_RUN_DELAY_MS
    expect(sqlCalls.some((c) => c.template.includes('SELECT cursor, write_seq'))).toBe(true);
    expect(sqlCalls.some((c) => c.template.includes('ORDER BY a.id ASC'))).toBe(true);

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

  // ── Durable cursor persistence (T1, migration 081 + ADR 0006) ────

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

  it('a FAILED boot-load re-seeds writeSeq in the persist path so a valid save is not CAS-rejected (FIX 1a)', async () => {
    // Boot-load rejects (writeSeq left UNSEEDED at its module default 0) while the
    // store already holds write_seq=5. Blindly saving seq 1 would be CAS-rejected
    // (1 < 5), silently disabling persistence. The persist path must re-seed from
    // the durable write_seq (5) first, so THIS cycle's save carries seq 6 (> 5).
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('boot-load transport blip')));
    await beginCursorLoadForTests(); // its .catch swallows → cursorLoaded resolves, unseeded

    sqlReturnQueue.push([]); // accounts query → empty (drained)
    sqlReturnQueue.push([{ cursor: null, write_seq: 5 }]); // re-seed loadCursor sees the durable seq
    // saveCursor INSERT falls through to the default [] return.

    await runOnce();

    const reseedSelect = sqlCalls.filter((c) => c.template.includes('SELECT cursor, write_seq'));
    // Two cursor SELECTs total: the rejected boot-load is a mockImplementationOnce
    // (not a real SELECT template call), so this counts the accounts-side loads:
    // the re-seed load in the persist path is the one that returned write_seq=5.
    expect(reseedSelect.length).toBeGreaterThanOrEqual(1);

    const persist = sqlCalls.find((c) => c.template.includes('INSERT INTO poller_cursors'))!;
    expect(persist).toBeDefined();
    // Re-seeded to 5, then bumped to 6 — strictly greater than the durable seq, so
    // the CAS accepts it instead of silently no-op'ing.
    expect(persist.values[2]).toBe(6);
  });

  it('a failed boot-load re-seed restores the durable cursor FRONTIER, not just writeSeq (FIX 1a)', async () => {
    // Boot-load rejects → unseeded, accountCursor defaults to null (top of rotation).
    // The persist-path re-seed must recover BOTH the durable write_seq AND the durable
    // cursor frontier the failed boot-load never observed — deterministically, so the
    // persisted value is race-free w.r.t. the detached truncation tail (ADR 0006 lag).
    // Recovering the frontier is safe under never-skip and preferable to discarding
    // durable progress (which resuming from null would do). This locks the intent:
    // dropping the accountCursor re-seed would persist null here instead.
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('boot-load blip')));
    await beginCursorLoadForTests(); // .catch → unseeded, accountCursor=null

    sqlReturnQueue.push([]); // accounts query → empty (drained); in-memory cursor stays null
    sqlReturnQueue.push([{ cursor: 'acct-frontier', write_seq: 7 }]); // re-seed sees the durable frontier

    await runOnce();

    const persist = sqlCalls.find((c) => c.template.includes('INSERT INTO poller_cursors'))!;
    expect(persist).toBeDefined();
    // values = [POLLER_NAME, cursor, writeSeq]: the durable frontier is recovered
    // (not the null in-memory cursor), seq re-seeded 7 → 8.
    expect(persist.values[1]).toBe('acct-frontier');
    expect(persist.values[2]).toBe(8);
  });

  it('a failed boot-load AND a failed re-seed skip the persist this cycle (no save) but still release inProgress', async () => {
    vi.useFakeTimers();
    // Boot-load rejects → unseeded. Then the re-seed load in the persist path also
    // parks forever → its withTimeout rejects → the persist is skipped entirely.
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('boot-load blip')));
    await beginCursorLoadForTests();

    mockSql
      .mockImplementationOnce(() => Promise.resolve([])) // accounts query → empty
      .mockImplementationOnce(() => new Promise(() => {})); // re-seed load parks

    const run = runOnce();
    await vi.advanceTimersByTimeAsync(10_000 + 100); // past CURSOR_LOAD_TIMEOUT_MS
    const result = await run;

    expect(result.errors).toBe(0); // the skipped persist must not fail the run
    const reseedFail = errorSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Cursor re-seed failed'));
    expect(reseedFail).toBeDefined();
    // No save was attempted this cycle.
    const persist = sqlCalls.find((c) => c.template.includes('INSERT INTO poller_cursors'));
    expect(persist).toBeUndefined();

    // inProgress released → the next tick runs (not skipped). It is still unseeded,
    // so this tick's persist path re-seeds again (successfully now).
    logSpy.mockClear();
    sqlReturnQueue.push([]); // accounts query → empty
    sqlReturnQueue.push([{ cursor: null, write_seq: 9 }]); // re-seed load succeeds now
    await runOnce();
    const skipLine = logSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Previous run still in progress'));
    expect(skipLine).toBeUndefined();
    vi.useRealTimers();
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

  // ── Sustained-truncation alert (T3, ADR 0006 + #479) ─────────────
  // Classification wiring driven through runOnce: a cycle that hits the 240s
  // deadline before draining its batch is a truncation; three consecutive
  // truncations (no full drain in between) fire ONE warning-level alert. With
  // SENTRY_DSN unset the alert lands on console.warn as a structured log line.

  const SUSTAINED_TRUNCATION = 'Sustained reconcile truncation';
  const truncationAlertCount = (): number =>
    warnSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes(SUSTAINED_TRUNCATION),
    ).length;

  // Park every Stripe retrieve forever. reconcileAccount reaches the retrieve
  // before any DB read, so a parked retrieve means the per-account withTimeout is
  // the only thing that ever settles the account — the cycle can never drain its
  // batch before the 240s cycle deadline.
  function parkStripeRetrieveForever(): void {
    mockStripeRetrieve.mockImplementation(() => new Promise(() => {}));
  }

  // One deadline-truncated cycle: 100 parked accounts, so at the 240s cycle
  // deadline only a handful (~12) have been CLAIMED (dispatched << total) → the
  // finally classifies `truncated`. Requires fake timers + parked Stripe.
  async function runTruncatedCycle(): Promise<void> {
    sqlReturnQueue.push(
      Array.from({ length: 100 }, (_, i) =>
        makeAccountRow({ id: `trunc-${String(i).padStart(3, '0')}` }),
      ),
    );
    const run = runOnce();
    await vi.advanceTimersByTimeAsync(240_000 + 1_000); // past CYCLE_TIMEOUT_MS
    await run;
  }

  // One drained cycle via an empty account list (queryCompleted && total === 0).
  // Resolves on microtasks — no timer advance needed.
  async function runEmptyDrainedCycle(): Promise<void> {
    sqlReturnQueue.push([]);
    await runOnce();
  }

  it('a single truncated cycle stays log-only — no sustained-truncation alert', async () => {
    vi.useFakeTimers();
    parkStripeRetrieveForever();

    await runTruncatedCycle();

    expect(truncationAlertCount()).toBe(0);
    vi.useRealTimers();
  });

  it('emits exactly one alert after 3 consecutive truncations and never re-fires', async () => {
    vi.useFakeTimers();
    parkStripeRetrieveForever();

    await runTruncatedCycle(); // consecutive = 1
    expect(truncationAlertCount()).toBe(0);
    await runTruncatedCycle(); // consecutive = 2
    expect(truncationAlertCount()).toBe(0);
    await runTruncatedCycle(); // consecutive = 3 → alert
    expect(truncationAlertCount()).toBe(1);

    // A 4th truncation is clamped and must NOT re-fire.
    await runTruncatedCycle();
    expect(truncationAlertCount()).toBe(1);

    vi.useRealTimers();
  });

  it('a fully-dispatched cycle (dispatched === total) is drained — no alert', async () => {
    vi.useFakeTimers();
    parkStripeRetrieveForever();
    // 3 accounts == fan-out concurrency: all claimed in one wave (dispatched ===
    // total), each parks and hits its 60s per-account timeout, then the cycle
    // RETURNS normally (before the 240s cycle deadline) with dispatched === total
    // → the finally classifies `drained`, not `truncated`.
    sqlReturnQueue.push([
      makeAccountRow({ id: 'full-a' }),
      makeAccountRow({ id: 'full-b' }),
      makeAccountRow({ id: 'full-c' }),
    ]);

    const run = runOnce();
    await vi.advanceTimersByTimeAsync(60_000 + 1_000); // past ACCOUNT_TIMEOUT_MS
    await run;

    expect(truncationAlertCount()).toBe(0);
    vi.useRealTimers();
  });

  it('a boot/query stall is classified stalled — it RESETS the truncation streak (FIX 2b: "consecutive" is literal)', async () => {
    vi.useFakeTimers();
    parkStripeRetrieveForever();

    await runTruncatedCycle(); // consecutive = 1
    await runTruncatedCycle(); // consecutive = 2
    expect(truncationAlertCount()).toBe(0);

    // A stall: the accounts query itself never returns (queryCompleted stays
    // false). The cycle deadline fires → classified `stalled`.
    mockSql.mockImplementationOnce(() => new Promise(() => {})); // accounts SELECT parks
    const stalled = runOnce();
    await vi.advanceTimersByTimeAsync(240_000 + 1_000);
    await stalled;

    // The stall broke the run: the counter reset to 0, so no alert.
    expect(truncationAlertCount()).toBe(0);

    // Because the stall RESET the streak, it now takes a FRESH run of 3
    // truncations to alert — two more alone must NOT fire...
    await runTruncatedCycle(); // 1
    await runTruncatedCycle(); // 2
    expect(truncationAlertCount()).toBe(0);
    // ...the third fresh truncation reaches the threshold and fires exactly once,
    // proving the stall reset the pre-stall run of 2.
    await runTruncatedCycle(); // 3 → alert
    expect(truncationAlertCount()).toBe(1);

    vi.useRealTimers();
  });

  it('an empty account list is a drain that resets the truncation counter', async () => {
    vi.useFakeTimers();
    parkStripeRetrieveForever();

    await runTruncatedCycle(); // consecutive = 1
    await runTruncatedCycle(); // consecutive = 2
    expect(truncationAlertCount()).toBe(0);

    await runEmptyDrainedCycle(); // drained → counter reset to 0
    expect(truncationAlertCount()).toBe(0);

    // After the reset it takes a FRESH run of 3 truncations to alert.
    await runTruncatedCycle(); // 1
    await runTruncatedCycle(); // 2
    expect(truncationAlertCount()).toBe(0);
    await runTruncatedCycle(); // 3 → alert
    expect(truncationAlertCount()).toBe(1);

    vi.useRealTimers();
  });

  it('a NON-timeout error after the accounts query does NOT increment the truncation counter (FIX 2a)', async () => {
    // Force getStripe() to throw AFTER the accounts query returns: STRIPE_SECRET_KEY
    // unset + fresh memos → getStripe() throws a NON-timeout error, so reconcileCycle
    // rejects with queryCompleted=true (the query ran) but dispatched=0. Without the
    // outcome thread this snapshot reads as `truncated`; three such cycles would page.
    // With FIX 2a it is `error → stalled`, so the counter never advances → no alert.
    delete process.env.STRIPE_SECRET_KEY;
    resetServerConfigForTests();
    resetStripeClientForTests();
    try {
      const runErrorCycle = async (): Promise<void> => {
        sqlReturnQueue.push([
          makeAccountRow({ id: 'err-a' }),
          makeAccountRow({ id: 'err-b' }),
        ]);
        const result = await runOnce();
        // The cycle threw a non-timeout error → counted as one cycle error.
        expect(result.errors).toBe(1);
      };

      await runErrorCycle();
      await runErrorCycle();
      await runErrorCycle();

      // Under the pre-fix classification these three would be truncations → alert;
      // as errors they are stalls → the counter stayed at 0 → never pages.
      expect(truncationAlertCount()).toBe(0);
    } finally {
      // Restore so getStripe() works for every later test (server memo + singleton).
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      resetServerConfigForTests();
      resetStripeClientForTests();
    }
  });

  it('runOnce re-entered immediately after a truncating timeout runs cleanly (inProgress released)', async () => {
    vi.useFakeTimers();
    parkStripeRetrieveForever();

    await runTruncatedCycle(); // cycle deadline fired; finally released inProgress

    // Immediately re-enter with a clean empty cycle: it must actually RUN (not hit
    // the single-flight skip path) and return a zero result.
    logSpy.mockClear();
    sqlReturnQueue.push([]);
    const second = await runOnce();

    expect(second).toEqual({ accountsChecked: 0, driftsFound: 0, errors: 0 });
    const skipLine = logSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((l: unknown): l is string => typeof l === 'string' && l.includes('Previous run still in progress'));
    expect(skipLine).toBeUndefined();

    vi.useRealTimers();
  });
});
