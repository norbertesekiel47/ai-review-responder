import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * Stripe webhook handlers — two-item subscription support.
 *
 * Tests for: customer.subscription.updated (base + overage item mapping),
 * invoice.payment_failed, invoice.paid, customer.subscription.deleted.
 * Covers: two-item subscriptions, legacy single-item tolerance,
 * advisory lock / idempotency, price reverse-map completeness.
 *
 * Validation contract:
 *   VAL-BILLING-007  checkout.session.completed activates account
 *   VAL-BILLING-008  checkout.session.completed idempotent
 *   VAL-BILLING-009  customer.subscription.updated maps base price → tier
 *   VAL-BILLING-010  customer.subscription.updated reads overage item quantity
 *   VAL-BILLING-011  customer.subscription.updated tolerates legacy single-item
 *   VAL-BILLING-012  invoice.payment_failed → past_due
 *   VAL-BILLING-013  invoice.paid → active recovery from past_due
 *   VAL-BILLING-014  invoice.paid no-op for already-active
 *   VAL-BILLING-015  customer.subscription.deleted → cancelled
 *   VAL-BILLING-016  Webhook verifies Stripe signature
 *   VAL-BILLING-050  Webhook writes locations_paid from overage item
 *   VAL-BILLING-051  Webhook + outbox both writing locations_paid is idempotent
 *   VAL-BILLING-055  Stripe reverse-map includes all 7 price IDs
 *   VAL-BILLING-060  Checkout Session uses client_reference_id as account ID
 *   VAL-BILLING-062  Webhook handler uses advisory lock
 *   VAL-BILLING-067  Webhook processing failure returns non-2xx
 */

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockClaimInboundEvent,
  mockConstructEvent,
  mockWriteAccountAuditLog,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const text = Array.from(_s).join('?');
    sqlCalls.push({ text, values: _v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });

  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    return callback(mockSql);
  });

  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockClaimInboundEvent: vi.fn(),
    mockConstructEvent: vi.fn(),
    mockWriteAccountAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('../../../src/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

vi.mock('../shared', () => ({
  claimInboundEvent: mockClaimInboundEvent,
}));

vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

vi.mock('stripe', () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

const _origStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const _origStripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';

// Set up price env vars for reverse-map tests
const PRICE_ENV_VARS = {
  STRIPE_PRICE_BASIC: 'price_basic_test',
  STRIPE_PRICE_FOUNDING: 'price_founders_test',
  STRIPE_PRICE_STANDARD: 'price_standard_test',
  STRIPE_PRICE_PREMIUM: 'price_premium_test',
  STRIPE_PRICE_FOUNDERS_OVERAGE: 'price_founders_overage_test',
  STRIPE_PRICE_STANDARD_OVERAGE: 'price_standard_overage_test',
  STRIPE_PRICE_PREMIUM_OVERAGE: 'price_premium_overage_test',
};

const _origPriceEnvVars: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(PRICE_ENV_VARS)) {
  _origPriceEnvVars[key] = process.env[key];
  process.env[key] = value;
}

import { handleStripeWebhook } from '../stripe';

afterAll(() => {
  if (_origStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = _origStripeSecretKey;
  if (_origStripeWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = _origStripeWebhookSecret;
  for (const [key, orig] of Object.entries(_origPriceEnvVars)) {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function mkRequest(rawBody = '{}', sig = 't=1,v1=fake'): any {
  return { headers: { 'stripe-signature': sig }, rawBody };
}

function mkReply() {
  const status = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  return { status, send };
}

const TEST_ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const TEST_CUSTOMER_ID = 'cus_test_123';
const TEST_SUBSCRIPTION_ID = 'sub_test_456';

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  // Don't call mockClear/mockReset on mockSql — it would wipe the
  // queue-based implementation. Just clear our custom tracking arrays.
  mockClaimInboundEvent.mockClear();
  mockClaimInboundEvent.mockResolvedValue('claimed');
  mockConstructEvent.mockReset();
  mockWriteAccountAuditLog.mockClear();
  mockWriteAccountAuditLog.mockResolvedValue(undefined);

  // Re-apply price env vars in case a test modified them
  for (const [key, value] of Object.entries(PRICE_ENV_VARS)) {
    process.env[key] = value;
  }
});

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

// Queue helper: invoice.payment_failed tx flow (active → past_due)
function queueInvoicePaymentFailed(opts: {
  status?: string;
  updateAccount?: boolean;
} = {}) {
  const status = opts.status ?? 'active';
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status }]);
  sqlReturnQueue.push([]);
  if (status === 'active') {
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);
  }
}

// Queue helper: invoice.paid tx flow (past_due → active)
function queueInvoicePaid(opts: {
  status?: string;
} = {}) {
  const status = opts.status ?? 'past_due';
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status }]);
  if (status === 'past_due') {
    sqlReturnQueue.push([]);
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);
    sqlReturnQueue.push([{ id: '019dc366-29ce-7000-a000-000000000099' }]); // primary business lookup
    sqlReturnQueue.push([]); // zernio predicate (no match by default)
  }
}

// Queue helper: customer.subscription.deleted tx flow
function queueSubscriptionDeleted(opts: {
  status?: string;
} = {}) {
  const status = opts.status ?? 'active';
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status }]);
  sqlReturnQueue.push([]);
  if (status !== 'cancelled') {
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);
  }
}

// ───────────────────────────────────────────────────────────────────────
// customer.subscription.updated
// ───────────────────────────────────────────────────────────────────────

describe('customer.subscription.updated — two-item subscription', () => {
  it('maps standard base price → tier "standard" and overage quantity → locations_paid', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 3 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('standard');
    expect(updateAcct!.values).toContain(3);
  });

  it('maps premium base price → tier "premium" and overage quantity → locations_paid', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_2',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 5 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'premium' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('premium');
    expect(updateAcct!.values).toContain(5);
  });

  it('refreshes locations_included to premium default when Stripe changes tier from standard to premium', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_standard_to_premium',
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

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toContain('locations_included');
    expect(updateAcct!.values).toContain('premium');
    expect(updateAcct!.values).toContain(2);
    expect(updateAcct!.values).toContain(5);
  });

  it('preserves custom locations_included when Stripe sends same-tier overage-only update', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_standard_overage_only',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 4 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/locations_included\s*=\s*CASE\s+WHEN\s+\?\s+THEN\s+\?\s+ELSE\s+locations_included\s+END/);
    expect(updateAcct!.values).toContain(false);
    expect(updateAcct!.values).toContain(4);
  });

  it('maps founders base price → tier "founders" with overage', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_3',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_founders_test' }, quantity: 1 },
              { price: { id: 'price_founders_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'founders' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('founders');
    expect(updateAcct!.values).toContain(2);
  });

  it('VAL-BILLING-011: legacy single-item subscription — tier updated, locations_paid stays 0, no crash', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_legacy',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              // No overage item — legacy single-item subscription
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('standard');
    expect(updateAcct!.values).toContain(0); // locations_paid = 0 for legacy
  });

  it('maps basic base price → tier "basic" with no overage item', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_basic',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_basic_test' }, quantity: 1 },
              // Basic has no overage item
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'basic' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('basic');
    expect(updateAcct!.values).toContain(0);
  });

  it('unknown base price ID → warns and skips tier update', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_unknown',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_unknown_tier' }, quantity: 1 },
            ],
          },
        },
      },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No accounts UPDATE should fire for unknown price
    const updateAcct = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );
    expect(updateAcct).toEqual([]);

    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/Unknown base price ID/);

    consoleSpy.mockRestore();
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_no_cust',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: null,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
            ],
          },
        },
      },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/missing customer/);

    consoleSpy.mockRestore();
  });

  it('uses advisory lock before updating account (VAL-BILLING-062)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_lock',
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

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const updateIdx = sqlCalls.findIndex(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });

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

  it('writes a combined audit payload when both tier and locations_paid change', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_both',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 4 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' -> 'premium'; prior locations_paid 2 -> overage qty 4.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [input] = mockWriteAccountAuditLog.mock.calls[0];
    expect(input).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      eventType: 'subscription_updated',
      payload: { fromTier: 'standard', toTier: 'premium', locationsPaid: 4 },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// invoice.payment_failed
// ───────────────────────────────────────────────────────────────────────

describe('invoice.payment_failed — sets account to past_due', () => {
  it('VAL-BILLING-012: active → past_due', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_1', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaymentFailed({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('past_due'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NOW\(\)/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'active', toStatus: 'past_due' },
      }),
      mockSql,
    );
  });

  it('already past_due → no-op (idempotent)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_dup',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_dup', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaymentFailed({ status: 'past_due' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No accounts UPDATE should fire since status is already past_due
    const updateAcct = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('past_due') && !c.text.includes('inbound_events'),
    );
    expect(updateAcct).toEqual([]);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    // Log should indicate already past_due
    const logText = consoleSpy.mock.calls.flat().join(' ');
    expect(logText).toMatch(/already/);

    consoleSpy.mockRestore();
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_no_cust',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_no_cust', customer: null } },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/missing customer/);

    consoleSpy.mockRestore();
  });

  it('uses advisory lock before status update (VAL-BILLING-062)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_lock',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_lock', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaymentFailed({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const updateIdx = sqlCalls.findIndex(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });
});

// ───────────────────────────────────────────────────────────────────────
// invoice.paid
// ───────────────────────────────────────────────────────────────────────

describe('invoice.paid — active recovery from past_due', () => {
  it('VAL-BILLING-013: past_due → active', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_1',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_1', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'past_due', toStatus: 'active' },
      }),
      mockSql,
    );
  });

  it('VAL-BILLING-014: already active → no-op', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_active',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_active', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaid({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No accounts UPDATE should fire since status is already active
    const updateAcct = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'") && !c.text.includes('inbound_events'),
    );
    expect(updateAcct).toEqual([]);
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_no_cust',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_no_cust', customer: null } },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/missing customer/);

    consoleSpy.mockRestore();
  });

  it('uses advisory lock before status update (VAL-BILLING-062)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_lock',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_lock', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const updateIdx = sqlCalls.findIndex(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });
});

// ───────────────────────────────────────────────────────────────────────
// customer.subscription.deleted
// ───────────────────────────────────────────────────────────────────────

describe('customer.subscription.deleted — sets account to cancelled', () => {
  it('VAL-BILLING-015: sets cancelled regardless of prior status', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID } },
    });

    queueSubscriptionDeleted({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/cancelled_at\s*=\s*NOW\(\)/i);
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'active', toStatus: 'cancelled' },
      }),
      mockSql,
    );
  });

  it('cancelled → cancelled is idempotent (no UPDATE fires)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_dup',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID } },
    });

    queueSubscriptionDeleted({ status: 'cancelled' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const updateAcct = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'") && !c.text.includes('inbound_events'),
    );
    expect(updateAcct).toEqual([]);
    const logText = consoleSpy.mock.calls.flat().join(' ');
    expect(logText).toMatch(/already cancelled/);

    consoleSpy.mockRestore();
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_no_cust',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: null } },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/missing customer/);

    consoleSpy.mockRestore();
  });

  it('uses advisory lock before status update (VAL-BILLING-062)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_lock',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID } },
    });

    queueSubscriptionDeleted({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const updateIdx = sqlCalls.findIndex(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });
});

// ───────────────────────────────────────────────────────────────────────
// checkout.session.completed (account-scoped)
// ───────────────────────────────────────────────────────────────────────

describe('checkout.session.completed — account activation (VAL-BILLING-007, VAL-BILLING-008)', () => {
  it('activates pending_payment account with stripe_customer_id and subscription_id', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_activate',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: TEST_ACCOUNT_ID,
          customer: TEST_CUSTOMER_ID,
          subscription: TEST_SUBSCRIPTION_ID,
        },
      },
    });

    // Account lookup
    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID }]);
    // Inside tx:
    sqlReturnQueue.push([]);  // pg_advisory_xact_lock
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);
    const updateResult: any = []; updateResult.count = 1;
    sqlReturnQueue.push(updateResult);
    // INSERT account_audit_log (subscription_status_changed)
    const auditResult: any = []; auditResult.count = 1;
    sqlReturnQueue.push(auditResult);
    const bizResult: any = []; bizResult.count = 1;
    sqlReturnQueue.push(bizResult);

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain(TEST_CUSTOMER_ID);
    expect(updateAcct!.values).toContain(TEST_SUBSCRIPTION_ID);
  });

  it('VAL-BILLING-008: already active → idempotent no-op', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_dup',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_dup',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: TEST_ACCOUNT_ID,
          customer: TEST_CUSTOMER_ID,
          subscription: TEST_SUBSCRIPTION_ID,
        },
      },
    });

    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ subscription_status: 'active' }]);
    const noUpdate: any = []; noUpdate.count = 0;
    sqlReturnQueue.push(noUpdate);
    // No audit log INSERT because the status didn't change (count = 0)
    const noBiz: any = []; noBiz.count = 0;
    sqlReturnQueue.push(noBiz);

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
  });

  it('VAL-BILLING-060: uses client_reference_id as account ID', async () => {
    const customAccountId = '019dc366-aaaa-bbbb-cccc-dddddddddddd';
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_crid',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_crid',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: customAccountId,
          customer: 'cus_custom',
          subscription: 'sub_custom',
        },
      },
    });

    // Account lookup
    sqlReturnQueue.push([{ id: customAccountId }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    // INSERT account_audit_log (subscription_status_changed)
    const auditR: any = []; auditR.count = 1;
    sqlReturnQueue.push(auditR);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // The SELECT accounts query contains the customAccountId as a parameter value
    const lookupCall = sqlCalls.find(
      (c) => c.text.includes('SELECT') && c.text.includes('accounts') && c.text.includes('id'),
    );
    expect(lookupCall).toBeDefined();
    expect(lookupCall!.values).toContain(customAccountId);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Reverse-map completeness (VAL-BILLING-055)
// ───────────────────────────────────────────────────────────────────────

describe('Stripe reverse-map includes all 7 price IDs (VAL-BILLING-055)', () => {
  const basePriceTestCases = [
    { priceId: 'price_basic_test', expectedTier: 'basic' },
    { priceId: 'price_founders_test', expectedTier: 'founders' },
    { priceId: 'price_standard_test', expectedTier: 'standard' },
    { priceId: 'price_premium_test', expectedTier: 'premium' },
  ];

  for (const tc of basePriceTestCases) {
    it(`maps base price ${tc.priceId} → tier "${tc.expectedTier}"`, async () => {
      sqlReturnQueue.length = 0;
      sqlCalls.length = 0;
      mockConstructEvent.mockReturnValue({
        id: `evt_reverse_map_${tc.expectedTier}`,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: TEST_SUBSCRIPTION_ID,
            customer: TEST_CUSTOMER_ID,
            items: {
              data: [
                { price: { id: tc.priceId }, quantity: 1 },
              ],
            },
          },
        },
      });

      queueSubscriptionUpdated({ tier: tc.expectedTier });

      const { status, send } = mkReply();
      await handleStripeWebhook(mkRequest(), { status, send } as any);

      expect(status).toHaveBeenCalledWith(200);

      const updateAcct = sqlCalls.find(
        (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
      );
      expect(updateAcct).toBeDefined();
      expect(updateAcct!.values).toContain(tc.expectedTier);
    });
  }

  const overageTestCases = [
    { basePriceId: 'price_standard_test', overagePriceId: 'price_standard_overage_test', overageQty: 4, expectedTier: 'standard' },
    { basePriceId: 'price_premium_test', overagePriceId: 'price_premium_overage_test', overageQty: 7, expectedTier: 'premium' },
    { basePriceId: 'price_founders_test', overagePriceId: 'price_founders_overage_test', overageQty: 3, expectedTier: 'founders' },
  ];

  for (const tc of overageTestCases) {
    it(`overage price ${tc.overagePriceId} → locations_paid=${tc.overageQty} for ${tc.expectedTier}`, async () => {
      sqlReturnQueue.length = 0;
      sqlCalls.length = 0;
      mockConstructEvent.mockReturnValue({
        id: `evt_overage_${tc.expectedTier}`,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: TEST_SUBSCRIPTION_ID,
            customer: TEST_CUSTOMER_ID,
            items: {
              data: [
                { price: { id: tc.basePriceId }, quantity: 1 },
                { price: { id: tc.overagePriceId }, quantity: tc.overageQty },
              ],
            },
          },
        },
      });

      queueSubscriptionUpdated({ tier: tc.expectedTier });

      const { status, send } = mkReply();
      await handleStripeWebhook(mkRequest(), { status, send } as any);

      expect(status).toHaveBeenCalledWith(200);

      // Use a specific pattern to avoid matching "SELECT ... FOR UPDATE"
      const updateAcct = sqlCalls.find(
        (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
      );
      expect(updateAcct).toBeDefined();
      expect(updateAcct!.values).toContain(tc.expectedTier);
      expect(updateAcct!.values).toContain(tc.overageQty);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Idempotency (VAL-BILLING-051, VAL-BILLING-067)
// ───────────────────────────────────────────────────────────────────────

describe('Webhook idempotency and error handling', () => {
  it('VAL-BILLING-051: duplicate event ID is short-circuited by claimInboundEvent dedup', async () => {
    mockClaimInboundEvent.mockResolvedValueOnce('duplicate');
    mockConstructEvent.mockReturnValue({
      id: 'evt_idem_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 3 },
            ],
          },
        },
      },
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No SQL should have fired for the duplicate — short-circuited at claimInboundEvent
    const acctUpdates = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text),
    );
    expect(acctUpdates).toEqual([]);
  });

  it('VAL-BILLING-067: processing failure returns 500 so Stripe retries', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_fail_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_fail_1', customer: TEST_CUSTOMER_ID } },
    });

    // Make the first SQL call inside tx throw
    mockSql.mockImplementationOnce(() => { throw new Error('Connection lost'); });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('successfully processed event returns 200', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_success_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_success_1', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaymentFailed({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit logging for subscription status changes (VAL-LOC-029, VAL-LOC-058)
// ───────────────────────────────────────────────────────────────────────

describe('subscription_status_changed audit logging', () => {
  it('VAL-LOC-029: logs subscription_status_changed on checkout activation (pending_payment → active)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_activate',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_audit',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: TEST_ACCOUNT_ID,
          customer: TEST_CUSTOMER_ID,
          subscription: TEST_SUBSCRIPTION_ID,
        },
      },
    });

    sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID }]);
    sqlReturnQueue.push([]); // advisory lock
    sqlReturnQueue.push([{ subscription_status: 'pending_payment' }]);
    const updateR: any = []; updateR.count = 1;
    sqlReturnQueue.push(updateR);
    const auditR: any = []; auditR.count = 1;
    sqlReturnQueue.push(auditR);
    const bizR: any = []; bizR.count = 1;
    sqlReturnQueue.push(bizR);

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const auditInsert = sqlCalls.find(
      (c) => /\bINSERT INTO account_audit_log\b/.test(c.text),
    );
    expect(auditInsert).toBeDefined();
    // Event type is a SQL literal, not a parameter — check the text
    expect(auditInsert!.text).toMatch(/subscription_status_changed/);
    // Verify payload contains fromStatus and toStatus
    const payloadIdx = auditInsert!.values.findIndex((v: unknown) =>
      typeof v === 'object' && v !== null && 'fromStatus' in (v as Record<string, unknown>),
    );
    expect(payloadIdx).toBeGreaterThanOrEqual(0);
    const payload = auditInsert!.values[payloadIdx] as Record<string, unknown>;
    expect(payload.fromStatus).toBe('pending_payment');
    expect(payload.toStatus).toBe('active');
  });

  it('VAL-LOC-058: logs subscription_status_changed on cancellation (active → cancelled)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_cancel',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID } },
    });

    queueSubscriptionDeleted({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'active', toStatus: 'cancelled' },
      }),
      mockSql,
    );
  });

  it('logs subscription_status_changed on past_due recovery', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_recover',
      type: 'invoice.paid',
      data: { object: { id: 'in_audit_recover', customer: TEST_CUSTOMER_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'past_due', toStatus: 'active' },
      }),
      mockSql,
    );
  });

  it('does not log audit when status unchanged (idempotent no-op)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_noop',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID } },
    });

    queueSubscriptionDeleted({ status: 'cancelled' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // No audit INSERT for cancelled → cancelled (no transition)
    const auditInsert = sqlCalls.find(
      (c) => /\bINSERT INTO account_audit_log\b/.test(c.text),
    );
    expect(auditInsert).toBeUndefined();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
