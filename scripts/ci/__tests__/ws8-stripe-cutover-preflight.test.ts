import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import {
  LEGACY_STRIPE_PRICE_ENV_VARS,
  parseWs8StripePreflightArgs,
  prepareWs8StripePreflightCli,
  readLegacyStripePriceIds,
  readWs8LaunchStripePriceIds,
  runWs8StripeCutoverPreflight,
  safeStripeErrorSummary,
  safeWs8StripePreflightErrorSummary,
  ws8StripePreflightExitCode,
  type AccountProjection,
  type StripeCheckoutSessionProjection,
  type StripeLineItemProjection,
  type StripePage,
  type StripeSubscriptionProjection,
  type Ws8StripePreflightStripe,
  type Ws8StripePreflightResult,
} from '../../ws8-stripe-cutover-preflight';

const LEGACY_PRICE = 'price_legacy';

function configuredCliEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_POOL_URL: 'postgresql://local-test',
    ...Object.fromEntries(
      LEGACY_STRIPE_PRICE_ENV_VARS.map((name, index) => [name, `price_${index}`]),
    ),
    ...Object.fromEntries(
      STRIPE_PRICE_ENV_VARS.map((name, index) => [name, `price_launch_${index}`]),
    ),
    ...overrides,
  };
}

function account(
  overrides: Partial<AccountProjection> = {},
): AccountProjection {
  return {
    id: 'account-1',
    stripe_customer_id: 'cus-1',
    stripe_subscription_id: 'sub-1',
    subscription_status: 'cancelled',
    ...overrides,
  };
}

function subscription(
  overrides: Partial<StripeSubscriptionProjection> = {},
): StripeSubscriptionProjection {
  return {
    id: 'sub-1',
    status: 'canceled',
    customer: 'cus-1',
    ...overrides,
  };
}

function stripeMock(input: {
  subscriptions?: StripePage<StripeSubscriptionProjection>[];
  sessions?: StripePage<StripeCheckoutSessionProjection>[];
  lineItems?: Record<string, StripePage<StripeLineItemProjection>[]>;
} = {}): Ws8StripePreflightStripe {
  const subscriptionPages = input.subscriptions ?? [{ data: [], has_more: false }];
  const sessionPages = input.sessions ?? [{ data: [], has_more: false }];
  const lineItemPages = input.lineItems ?? {};
  let subscriptionPageIndex = 0;
  let sessionPageIndex = 0;
  const lineItemPageIndex = new Map<string, number>();
  return {
    listSubscriptions: vi.fn(async () =>
      subscriptionPages[subscriptionPageIndex++] ?? { data: [], has_more: false }),
    listOpenCheckoutSessions: vi.fn(async () =>
      sessionPages[sessionPageIndex++] ?? { data: [], has_more: false }),
    listCheckoutSessionLineItems: vi.fn(async (sessionId) => {
      const index = lineItemPageIndex.get(sessionId) ?? 0;
      lineItemPageIndex.set(sessionId, index + 1);
      return lineItemPages[sessionId]?.[index] ?? { data: [], has_more: false };
    }),
    expireCheckoutSession: vi.fn(async () => undefined),
  };
}

describe('runWs8StripeCutoverPreflight', () => {
  it('uses status=all and accepts only reconciled terminal subscriptions', async () => {
    const stripe = stripeMock({
      subscriptions: [{
        data: [
          subscription(),
          subscription({ id: 'sub-2', customer: { id: 'cus-2' }, status: 'incomplete_expired' }),
        ],
        has_more: false,
      }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [account(), account({
        id: 'account-2',
        stripe_customer_id: 'cus-2',
        stripe_subscription_id: 'sub-2',
        subscription_status: 'past_due',
      })],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(stripe.listSubscriptions).toHaveBeenCalledTimes(1);
    expect(stripe.listSubscriptions).toHaveBeenCalledWith({ status: 'all', limit: 100 });
  });

  it('reports stale local status for a terminal provider subscription without blocking', async () => {
    const stripe = stripeMock({
      subscriptions: [{ data: [subscription()], has_more: false }],
    });
    const lines: string[] = [];

    const result = await runWs8StripeCutoverPreflight({
      accounts: [account({ subscription_status: 'active' })],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
      log: (line) => lines.push(line),
    });

    expect(result.blockers).toEqual([]);
    expect(result.notices).toEqual([{
      kind: 'subscription_status_disagreement',
      subscriptionId: 'sub-1',
      accountId: 'account-1',
      providerStatus: 'canceled',
      projectedStatus: 'active',
      resolution: 'requires_status_applier',
    }]);
    expect(lines).toContain(
      'WARN subscription_status_disagreement subscription=sub-1 account=account-1 provider_status=canceled projected_status=active resolution=requires_status_applier',
    );
    expect(lines.at(-1)).toBe('WS8_PREFLIGHT_PASS blockers=0');
  });

  it.each(['pending_payment', 'cancelled'])(
    'classifies incomplete_expired from %s as a safe applier no-op fixed point',
    async (localStatus) => {
      const lines: string[] = [];
      const result = await runWs8StripeCutoverPreflight({
        accounts: [account({ subscription_status: localStatus })],
        stripe: stripeMock({
          subscriptions: [{
            data: [subscription({ status: 'incomplete_expired' })],
            has_more: false,
          }],
        }),
        legacyPriceIds: new Set([LEGACY_PRICE]),
        requireStatusConvergence: true,
        log: (line) => lines.push(line),
      });

      expect(result.blockers).toEqual([]);
      expect(result.notices).toEqual([{
        kind: 'subscription_status_disagreement',
        subscriptionId: 'sub-1',
        accountId: 'account-1',
        providerStatus: 'incomplete_expired',
        projectedStatus: localStatus,
        resolution: 'applier_noop_fixed_point',
      }]);
      expect(lines.at(-1)).toBe(
        'WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0 fixed_point_notices=1',
      );
      expect(ws8StripePreflightExitCode(
        result,
        null,
        'require_status_convergence',
      )).toBe(0);
    },
  );

  it.each(['active', 'trialing'])(
    'classifies incomplete_expired from %s as requiring the status applier',
    async (localStatus) => {
      const lines: string[] = [];
      const result = await runWs8StripeCutoverPreflight({
        accounts: [account({ subscription_status: localStatus })],
        stripe: stripeMock({
          subscriptions: [{
            data: [subscription({ status: 'incomplete_expired' })],
            has_more: false,
          }],
        }),
        legacyPriceIds: new Set([LEGACY_PRICE]),
        requireStatusConvergence: true,
        log: (line) => lines.push(line),
      });

      expect(result.blockers).toEqual([]);
      expect(result.notices[0]).toMatchObject({
        providerStatus: 'incomplete_expired',
        projectedStatus: localStatus,
        resolution: 'requires_status_applier',
      });
      expect(lines.at(-1)).toBe(
        'WS8_STATUS_CONVERGENCE_FAIL blockers=0 actionable_notices=1 fixed_point_notices=0',
      );
      expect(ws8StripePreflightExitCode(
        result,
        null,
        'require_status_convergence',
      )).toBe(1);
      expect(ws8StripePreflightExitCode(result)).toBe(0);
    },
  );

  it('requires canceled provider status to pass through the applier from a stale status', async () => {
    const result = await runWs8StripeCutoverPreflight({
      accounts: [account({ subscription_status: 'pending_payment' })],
      stripe: stripeMock({
        subscriptions: [{ data: [subscription({ status: 'canceled' })], has_more: false }],
      }),
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toEqual([]);
    expect(result.notices[0]).toMatchObject({
      providerStatus: 'canceled',
      projectedStatus: 'pending_payment',
      resolution: 'requires_status_applier',
    });
  });

  it('stops convergence for an unrecognized projected status', async () => {
    const result = await runWs8StripeCutoverPreflight({
      accounts: [account({ subscription_status: 'legacy_unknown' })],
      stripe: stripeMock({
        subscriptions: [{ data: [subscription({ status: 'canceled' })], has_more: false }],
      }),
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.notices[0]).toMatchObject({
      resolution: 'requires_manual_resolution',
    });
    expect(ws8StripePreflightExitCode(
      result,
      null,
      'require_status_convergence',
    )).toBe(1);
  });

  it('blocks a nonterminal provider subscription while separately reporting stale local status', async () => {
    const stripe = stripeMock({
      subscriptions: [{ data: [subscription({ status: 'active' })], has_more: false }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [account({ subscription_status: 'past_due' })],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toContainEqual({
      kind: 'nonterminal_subscription',
      subscriptionId: 'sub-1',
      status: 'active',
      accountId: 'account-1',
    });
    expect(result.notices).toEqual([{
      kind: 'subscription_status_disagreement',
      subscriptionId: 'sub-1',
      accountId: 'account-1',
      providerStatus: 'active',
      projectedStatus: 'past_due',
      resolution: 'requires_status_applier',
    }]);
  });

  it.each([
    ['incomplete', 'past_due'],
    ['trialing', 'trialing'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['paused', 'past_due'],
    ['unpaid', 'past_due'],
  ])('blocks Stripe status %s regardless of a projected account', async (status, localStatus) => {
    const stripe = stripeMock({
      subscriptions: [{ data: [subscription({ status })], has_more: false }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [account({ subscription_status: localStatus })],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toContainEqual({
      kind: 'nonterminal_subscription',
      subscriptionId: 'sub-1',
      status,
      accountId: 'account-1',
    });
  });

  it('blocks an unprojected provider subscription even when it is terminal', async () => {
    const stripe = stripeMock({
      subscriptions: [{ data: [subscription()], has_more: false }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toEqual([{
      kind: 'unprojected_subscription',
      subscriptionId: 'sub-1',
      customerId: 'cus-1',
    }]);
  });

  it('blocks duplicate local subscription projections and proves the branch ran', async () => {
    const stripe = stripeMock({
      subscriptions: [{ data: [subscription()], has_more: false }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [
        account(),
        account({ id: 'account-2', stripe_customer_id: 'cus-2' }),
      ],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toContainEqual({
      kind: 'subscription_projection_conflict',
      subscriptionId: 'sub-1',
      accountIds: ['account-1', 'account-2'],
    });
    expect(result.notices).toEqual([]);
    expect(stripe.listSubscriptions).toHaveBeenCalledTimes(1);
    expect(stripe.listOpenCheckoutSessions).toHaveBeenCalledTimes(1);
    expect(stripe.listCheckoutSessionLineItems).not.toHaveBeenCalled();
  });

  it('blocks duplicate local customer projections and proves the branch ran', async () => {
    const stripe = stripeMock({
      subscriptions: [{ data: [subscription()], has_more: false }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [
        account(),
        account({ id: 'account-2', stripe_subscription_id: null }),
      ],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toContainEqual({
      kind: 'customer_projection_conflict',
      subscriptionId: 'sub-1',
      customerId: 'cus-1',
      accountIds: ['account-1', 'account-2'],
    });
    expect(result.notices).toEqual([]);
    expect(stripe.listSubscriptions).toHaveBeenCalledTimes(1);
    expect(stripe.listOpenCheckoutSessions).toHaveBeenCalledTimes(1);
    expect(stripe.listCheckoutSessionLineItems).not.toHaveBeenCalled();
  });

  it('blocks a database subscription projection that is absent from provider enumeration', async () => {
    const stripe = stripeMock();

    const result = await runWs8StripeCutoverPreflight({
      accounts: [account()],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toEqual([{
      kind: 'database_subscription_missing_from_provider',
      accountId: 'account-1',
      projectedSubscriptionId: 'sub-1',
    }]);
  });

  it('reports subscription, customer, and provider-authoritative status disagreements', async () => {
    const stripe = stripeMock({
      subscriptions: [{
        data: [
          subscription({ id: 'sub-provider', customer: 'cus-known' }),
          subscription({ id: 'sub-customer', customer: 'cus-provider' }),
          subscription({ id: 'sub-status', customer: 'cus-status', status: 'canceled' }),
        ],
        has_more: false,
      }],
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [
        account({ id: 'account-id', stripe_customer_id: 'cus-known', stripe_subscription_id: 'sub-db' }),
        account({ id: 'account-customer', stripe_customer_id: 'cus-db', stripe_subscription_id: 'sub-customer' }),
        account({ id: 'account-status', stripe_customer_id: 'cus-status', stripe_subscription_id: 'sub-status', subscription_status: 'active' }),
      ],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toContainEqual({
      kind: 'subscription_id_disagreement',
      subscriptionId: 'sub-provider',
      accountId: 'account-id',
      projectedSubscriptionId: 'sub-db',
    });
    expect(result.blockers).toContainEqual({
      kind: 'customer_projection_disagreement',
      subscriptionId: 'sub-customer',
      accountId: 'account-customer',
      providerCustomerId: 'cus-provider',
      projectedCustomerId: 'cus-db',
    });
    expect(result.notices).toContainEqual({
      kind: 'subscription_status_disagreement',
      subscriptionId: 'sub-status',
      accountId: 'account-status',
      providerStatus: 'canceled',
      projectedStatus: 'active',
      resolution: 'requires_status_applier',
    });
  });

  it('detects legacy Prices independently of valid, missing, or malformed client_reference_id', async () => {
    const sessions = [
      { id: 'cs-valid', client_reference_id: 'account-1' },
      { id: 'cs-missing', client_reference_id: null },
      { id: 'cs-malformed', client_reference_id: 'not-a-uuid' },
    ];
    const stripe = stripeMock({
      sessions: [{ data: sessions, has_more: false }],
      lineItems: Object.fromEntries(sessions.map((sessionItem) => [sessionItem.id, [{
        data: [{ id: `li-${sessionItem.id}`, price: { id: LEGACY_PRICE } }],
        has_more: false,
      }]])),
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.blockers).toEqual(sessions.map((sessionItem) => ({
      kind: 'legacy_checkout_session',
      sessionId: sessionItem.id,
      legacyPriceIds: [LEGACY_PRICE],
    })));
    expect(stripe.expireCheckoutSession).not.toHaveBeenCalled();
  });

  it('expires only legacy Sessions in explicit apply mode with stable idempotency keys', async () => {
    const stripe = stripeMock({
      sessions: [{
        data: [
          { id: 'cs-legacy', client_reference_id: null },
          { id: 'cs-new', client_reference_id: null },
        ],
        has_more: false,
      }],
      lineItems: {
        'cs-legacy': [{ data: [{ id: 'li-legacy', price: LEGACY_PRICE }], has_more: false }],
        'cs-new': [{ data: [{ id: 'li-new', price: 'price_new' }], has_more: false }],
      },
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
      expireLegacySessions: true,
    });

    expect(result.blockers).toEqual([]);
    expect(result.legacySessionsExpired).toBe(1);
    expect(stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
    expect(stripe.expireCheckoutSession).toHaveBeenCalledWith(
      'cs-legacy',
      'ws8_expire_legacy_session_cs-legacy',
    );
  });

  it('converges after partial Session-expiration failure without replaying the closed Session', async () => {
    const firstAttempt = stripeMock({
      sessions: [{
        data: [
          { id: 'cs-first', client_reference_id: null },
          { id: 'cs-second', client_reference_id: null },
        ],
        has_more: false,
      }],
      lineItems: {
        'cs-first': [{ data: [{ id: 'li-first', price: LEGACY_PRICE }], has_more: false }],
        'cs-second': [{ data: [{ id: 'li-second', price: LEGACY_PRICE }], has_more: false }],
      },
    });
    firstAttempt.expireCheckoutSession = vi.fn(async (sessionId) => {
      if (sessionId === 'cs-second') throw new Error('transient expiration failure');
    });

    await expect(runWs8StripeCutoverPreflight({
      accounts: [],
      stripe: firstAttempt,
      legacyPriceIds: new Set([LEGACY_PRICE]),
      expireLegacySessions: true,
    })).rejects.toThrow('transient expiration failure');
    expect(firstAttempt.expireCheckoutSession).toHaveBeenNthCalledWith(
      1,
      'cs-first',
      'ws8_expire_legacy_session_cs-first',
    );
    expect(firstAttempt.expireCheckoutSession).toHaveBeenNthCalledWith(
      2,
      'cs-second',
      'ws8_expire_legacy_session_cs-second',
    );

    const replay = stripeMock({
      sessions: [{
        data: [{ id: 'cs-second', client_reference_id: null }],
        has_more: false,
      }],
      lineItems: {
        'cs-second': [{ data: [{ id: 'li-second', price: LEGACY_PRICE }], has_more: false }],
      },
    });
    const result = await runWs8StripeCutoverPreflight({
      accounts: [],
      stripe: replay,
      legacyPriceIds: new Set([LEGACY_PRICE]),
      expireLegacySessions: true,
    });

    expect(result.blockers).toEqual([]);
    expect(result.legacySessionsExpired).toBe(1);
    expect(replay.expireCheckoutSession).toHaveBeenCalledTimes(1);
    expect(replay.expireCheckoutSession).toHaveBeenCalledWith(
      'cs-second',
      'ws8_expire_legacy_session_cs-second',
    );
  });

  it('emits identifiers and counts without logging client_reference_id PII', async () => {
    const stripe = stripeMock({
      sessions: [{
        data: [{ id: 'cs-safe-id', client_reference_id: 'owner@example.com' }],
        has_more: false,
      }],
      lineItems: {
        'cs-safe-id': [{
          data: [{ id: 'li-safe-id', price: LEGACY_PRICE }],
          has_more: false,
        }],
      },
    });
    const lines: string[] = [];

    await runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
      log: (line) => lines.push(line),
    });

    expect(lines.join('\n')).toContain('session=cs-safe-id');
    expect(lines.join('\n')).toContain(`prices=${LEGACY_PRICE}`);
    expect(lines.join('\n')).not.toContain('owner@example.com');
    expect(lines.join('\n')).not.toContain('client_reference_id');
  });

  it('fully paginates subscriptions, open Sessions, and each Session line-item list', async () => {
    const stripe = stripeMock({
      subscriptions: [
        { data: [subscription()], has_more: true },
        { data: [subscription({ id: 'sub-2', customer: 'cus-2' })], has_more: false },
      ],
      sessions: [
        { data: [{ id: 'cs-1', client_reference_id: null }], has_more: true },
        { data: [{ id: 'cs-2', client_reference_id: null }], has_more: false },
      ],
      lineItems: {
        'cs-1': [
          { data: [{ id: 'li-1', price: 'price_new' }], has_more: true },
          { data: [{ id: 'li-2', price: LEGACY_PRICE }], has_more: false },
        ],
        'cs-2': [{ data: [], has_more: false }],
      },
    });

    const result = await runWs8StripeCutoverPreflight({
      accounts: [account(), account({
        id: 'account-2',
        stripe_customer_id: 'cus-2',
        stripe_subscription_id: 'sub-2',
      })],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    });

    expect(result.subscriptionsScanned).toBe(2);
    expect(result.openSessionsScanned).toBe(2);
    expect(result.lineItemsScanned).toBe(2);
    expect(stripe.listSubscriptions).toHaveBeenNthCalledWith(2, {
      status: 'all', limit: 100, starting_after: 'sub-1',
    });
    expect(stripe.listOpenCheckoutSessions).toHaveBeenNthCalledWith(2, {
      status: 'open', limit: 100, starting_after: 'cs-1',
    });
    expect(stripe.listCheckoutSessionLineItems).toHaveBeenNthCalledWith(
      2,
      'cs-1',
      { limit: 100, starting_after: 'li-1' },
    );
    expect(result.blockers).toContainEqual({
      kind: 'legacy_checkout_session',
      sessionId: 'cs-1',
      legacyPriceIds: [LEGACY_PRICE],
    });
  });

  it('propagates Stripe API failures and redacts the provider message from error summaries', async () => {
    const stripe = stripeMock();
    const providerError = Object.assign(new Error('customer owner@example.com failed'), {
      type: 'StripeAPIError',
      code: 'api_error',
      requestId: 'req-safe-id',
    });
    stripe.listSubscriptions = vi.fn(async () => { throw providerError; });

    await expect(runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    })).rejects.toBe(providerError);
    const summary = safeStripeErrorSummary(providerError);
    expect(summary).toBe('type=StripeAPIError code=api_error request_id=req-safe-id');
    expect(summary).not.toContain('owner@example.com');
  });

  it('cannot report a pass when open-Session enumeration fails', async () => {
    const stripe = stripeMock();
    stripe.listOpenCheckoutSessions = vi.fn(async () => {
      throw new Error('session listing failed');
    });

    await expect(runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    })).rejects.toThrow('session listing failed');
  });

  it('cannot report a pass when line-item retrieval fails', async () => {
    const stripe = stripeMock({
      sessions: [{ data: [{ id: 'cs-1', client_reference_id: null }], has_more: false }],
    });
    stripe.listCheckoutSessionLineItems = vi.fn(async () => {
      throw new Error('line items failed');
    });

    await expect(runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
    })).rejects.toThrow('line items failed');
  });

  it('cannot report a pass when explicit Session expiration fails', async () => {
    const stripe = stripeMock({
      sessions: [{ data: [{ id: 'cs-1', client_reference_id: null }], has_more: false }],
      lineItems: {
        'cs-1': [{ data: [{ id: 'li-1', price: LEGACY_PRICE }], has_more: false }],
      },
    });
    stripe.expireCheckoutSession = vi.fn(async () => {
      throw new Error('expiration failed');
    });

    await expect(runWs8StripeCutoverPreflight({
      accounts: [],
      stripe,
      legacyPriceIds: new Set([LEGACY_PRICE]),
      expireLegacySessions: true,
    })).rejects.toThrow('expiration failed');
    expect(stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed when retained legacy Price configuration is missing', () => {
    const env = Object.fromEntries(
      LEGACY_STRIPE_PRICE_ENV_VARS.map((name, index) => [name, `price_${index}`]),
    );
    delete env.STRIPE_PRICE_PREMIUM_OVERAGE;

    expect(() => readLegacyStripePriceIds(env)).toThrow(
      'Missing retained legacy Stripe Price configuration: STRIPE_PRICE_PREMIUM_OVERAGE',
    );
  });

  it('dedupes repeated retained legacy IDs while preserving Session detection', async () => {
    const env = configuredCliEnv({
      STRIPE_PRICE_PREMIUM_OVERAGE: 'price_0',
    });
    const legacyPriceIds = prepareWs8StripePreflightCli(env, []).legacyPriceIds;
    const stripe = stripeMock({
      sessions: [{ data: [{ id: 'cs-deduped', client_reference_id: null }], has_more: false }],
      lineItems: {
        'cs-deduped': [{ data: [{ id: 'li-deduped', price: 'price_0' }], has_more: false }],
      },
    });

    expect(legacyPriceIds.size).toBe(6);
    expect(legacyPriceIds.has('price_0')).toBe(true);
    const result = await runWs8StripeCutoverPreflight({
      accounts: [], stripe, legacyPriceIds,
    });
    expect(result.blockers).toContainEqual({
      kind: 'legacy_checkout_session',
      sessionId: 'cs-deduped',
      legacyPriceIds: ['price_0'],
    });
  });
});

function preflightResult(
  overrides: Partial<Ws8StripePreflightResult> = {},
): Ws8StripePreflightResult {
  return {
    blockers: [],
    notices: [],
    subscriptionsScanned: 0,
    openSessionsScanned: 0,
    lineItemsScanned: 0,
    legacySessionsExpired: 0,
    ...overrides,
  };
}

describe('WS8 Stripe preflight CLI preparation', () => {
  it('defaults to dry-run and accepts only one explicit mode flag', () => {
    expect(parseWs8StripePreflightArgs([])).toBe('dry_run');
    expect(parseWs8StripePreflightArgs(['--expire-legacy-sessions']))
      .toBe('expire_legacy_sessions');
    expect(parseWs8StripePreflightArgs(['--require-status-convergence']))
      .toBe('require_status_convergence');
    expect(() => parseWs8StripePreflightArgs(['--execute'])).toThrow(
      'Usage: pnpm ws8:stripe-preflight [--expire-legacy-sessions | --require-status-convergence]',
    );
    expect(() => parseWs8StripePreflightArgs([
      '--expire-legacy-sessions', '--require-status-convergence',
    ])).toThrow(
      'Usage: pnpm ws8:stripe-preflight [--expire-legacy-sessions | --require-status-convergence]',
    );
  });

  it('prepares explicit, disjoint process configuration for every mode', () => {
    const env = configuredCliEnv();
    const dryRun = prepareWs8StripePreflightCli(env, []);
    const apply = prepareWs8StripePreflightCli(env, ['--expire-legacy-sessions']);
    const convergence = prepareWs8StripePreflightCli(env, ['--require-status-convergence']);

    expect(dryRun.databaseUrl).toBe('postgresql://local-test');
    expect(dryRun.launchPriceIds.size).toBe(6);
    expect(dryRun.legacyPriceIds.size).toBe(7);
    expect(dryRun.expireLegacySessions).toBe(false);
    expect(dryRun.requireStatusConvergence).toBe(false);
    expect(dryRun.mode).toBe('dry_run');
    expect(apply.expireLegacySessions).toBe(true);
    expect(apply.requireStatusConvergence).toBe(false);
    expect(convergence.expireLegacySessions).toBe(false);
    expect(convergence.requireStatusConvergence).toBe(true);
    expect(convergence.mode).toBe('require_status_convergence');
    expect([...dryRun.launchPriceIds].some((id) => dryRun.legacyPriceIds.has(id))).toBe(false);
  });

  it.each([undefined, '', '   '])('fails closed for DATABASE_POOL_URL=%s', (databaseUrl) => {
    expect(() => prepareWs8StripePreflightCli(
      configuredCliEnv({ DATABASE_POOL_URL: databaseUrl }),
      [],
    )).toThrow('DATABASE_POOL_URL is required');
  });

  it('requires every new launch Price by exact environment name', () => {
    const env = configuredCliEnv({ STRIPE_PRICE_AUTOPILOT_FOUNDING: '   ' });

    expect(() => readWs8LaunchStripePriceIds(env)).toThrow(
      'Missing WS8 launch Stripe Price configuration: STRIPE_PRICE_AUTOPILOT_FOUNDING',
    );
    expect(() => prepareWs8StripePreflightCli(env, [])).toThrow(
      'Missing WS8 launch Stripe Price configuration: STRIPE_PRICE_AUTOPILOT_FOUNDING',
    );
  });

  it('rejects duplicate new launch Prices without exposing the configured ID', () => {
    const env = configuredCliEnv({
      STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_launch_1',
    });

    expect(() => prepareWs8StripePreflightCli(env, [])).toThrow(
      'WS8 launch Stripe Price IDs must be unique: STRIPE_PRICE_COPILOT_FOUNDING duplicates STRIPE_PRICE_AUTOPILOT_FOUNDING',
    );
    try {
      prepareWs8StripePreflightCli(env, []);
    } catch (error) {
      expect((error as Error).message).not.toContain('price_launch_1');
    }
  });

  it('rejects overlap between founding Copilot and the retained founding Price', () => {
    const env = configuredCliEnv({
      STRIPE_PRICE_COPILOT_FOUNDING: 'price_1',
    });

    expect(() => prepareWs8StripePreflightCli(env, [])).toThrow(
      'WS8 launch and retained legacy Stripe Price IDs must be disjoint: STRIPE_PRICE_COPILOT_FOUNDING overlaps STRIPE_PRICE_FOUNDING',
    );
    try {
      prepareWs8StripePreflightCli(env, []);
    } catch (error) {
      expect(safeWs8StripePreflightErrorSummary(error)).toBe(
        'type=configuration message=WS8 launch and retained legacy Stripe Price IDs must be disjoint: STRIPE_PRICE_COPILOT_FOUNDING overlaps STRIPE_PRICE_FOUNDING',
      );
      expect(safeWs8StripePreflightErrorSummary(error)).not.toContain('price_1');
    }
  });

  it('maps pass, blocker, missing result, and error paths to fail-closed exit codes', () => {
    expect(ws8StripePreflightExitCode(preflightResult())).toBe(0);
    expect(ws8StripePreflightExitCode(preflightResult({
      notices: [{
        kind: 'subscription_status_disagreement',
        subscriptionId: 'sub-1',
        accountId: 'account-1',
        providerStatus: 'canceled',
        projectedStatus: 'active',
        resolution: 'requires_status_applier',
      }],
    }))).toBe(0);
    expect(ws8StripePreflightExitCode(preflightResult({
      notices: [{
        kind: 'subscription_status_disagreement',
        subscriptionId: 'sub-1',
        accountId: 'account-1',
        providerStatus: 'canceled',
        projectedStatus: 'active',
        resolution: 'requires_status_applier',
      }],
    }), null, 'require_status_convergence')).toBe(1);
    expect(ws8StripePreflightExitCode(preflightResult({
      blockers: [{
        kind: 'nonterminal_subscription',
        subscriptionId: 'sub-1',
        status: 'active',
        accountId: 'account-1',
      }],
    }))).toBe(1);
    expect(ws8StripePreflightExitCode(null)).toBe(1);
    expect(ws8StripePreflightExitCode(preflightResult(), new Error('Stripe failed'))).toBe(1);
  });

  it('has no implicit dotenv or .env.local loading in either operator CLI', () => {
    const preflightSource = readFileSync(
      new URL('../../ws8-stripe-cutover-preflight.ts', import.meta.url),
      'utf8',
    );
    const paritySource = readFileSync(
      new URL('../../verify-stripe-price-parity.ts', import.meta.url),
      'utf8',
    );
    for (const source of [preflightSource, paritySource]) {
      expect(source).not.toContain("from 'dotenv'");
      expect(source).not.toContain('.env.local');
    }
  });

  it('keeps retained legacy Price variables out of runtime Price resolution', () => {
    const priceMapSource = readFileSync(
      new URL('../../../src/lib/payments/price-tier-map.ts', import.meta.url),
      'utf8',
    );
    for (const name of LEGACY_STRIPE_PRICE_ENV_VARS) {
      expect(priceMapSource).not.toContain(`'${name}'`);
    }
  });
});
