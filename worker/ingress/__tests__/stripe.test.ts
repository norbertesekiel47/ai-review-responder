import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockSql,
  mockClaimInboundEvent,
  mockConstructEvent,
} = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  return {
    mockSql: sqlFn,
    mockClaimInboundEvent: vi.fn(),
    mockConstructEvent: vi.fn(),
  };
});

vi.mock('../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('../shared', () => ({
  claimInboundEvent: mockClaimInboundEvent,
}));

// Mock Stripe SDK so we don't pull in the real one. The handler grabs a
// lazy singleton via getStripe() — we substitute its webhooks.constructEvent.
vi.mock('stripe', () => {
  return {
    default: class FakeStripe {
      webhooks = { constructEvent: mockConstructEvent };
    },
  };
});

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';

import { handleStripeWebhook } from '../stripe';

// ── Helpers ─────────────────────────────────────────────────────────

function mkRequest(eventType: string, sig = 't=1,v1=fake'): FastifyRequest {
  return {
    headers: { 'stripe-signature': sig },
    rawBody: '{"type":"' + eventType + '"}',
  } as unknown as FastifyRequest;
}

function mkReply(): {
  reply: FastifyReply;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  const send = vi.fn();
  status.mockReturnValue({ send });
  return {
    reply: { status, send } as unknown as FastifyReply,
    status,
    send,
  };
}

// Convenience: extract the SQL fragments that fired during the handler.
function sqlTexts(): string[] {
  return mockSql.mock.calls.map((c: unknown[]) =>
    (c[0] as TemplateStringsArray).join('?'),
  );
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

  mockClaimInboundEvent.mockReset();
  mockClaimInboundEvent.mockResolvedValue('claimed');

  mockConstructEvent.mockReset();
});

describe('handleStripeWebhook — unhandled event types are safely ignored', () => {
  it('charge.updated returns 200 + logs "Unhandled" + does NOT touch businesses table', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_charge_updated_1',
      type: 'charge.updated',
      data: { object: { id: 'ch_test_1' } },
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { reply, status, send } = mkReply();
    await handleStripeWebhook(mkRequest('charge.updated'), reply);

    // 200 OK, signaling Stripe NOT to retry.
    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ received: true }));

    // The "Unhandled" log line is what the user asked us to validate.
    const logged = consoleSpy.mock.calls.flat().join(' ');
    expect(logged).toMatch(/Unhandled event type: charge\.updated.*ignoring/);

    // CRITICAL: no business state mutation — only the inbound_events
    // bookkeeping UPDATE at the tail end of the handler should fire.
    const businessTouches = sqlTexts().filter((t) =>
      /UPDATE\s+businesses|DELETE\s+FROM\s+businesses|INSERT\s+INTO\s+businesses/i.test(t),
    );
    expect(businessTouches).toEqual([]);

    // The inbound_events row is closed out as 'processed'.
    expect(
      sqlTexts().some((t) =>
        /UPDATE\s+inbound_events[\s\S]*processed/i.test(t),
      ),
    ).toBe(true);

    consoleSpy.mockRestore();
  });

  it('charge.succeeded — same no-op behavior (defensive coverage)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_charge_succeeded_1',
      type: 'charge.succeeded',
      data: { object: { id: 'ch_test_2' } },
    });

    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('charge.succeeded'), reply);

    expect(status).toHaveBeenCalledWith(200);
    const businessTouches = sqlTexts().filter((t) =>
      /UPDATE\s+businesses|DELETE\s+FROM\s+businesses|INSERT\s+INTO\s+businesses/i.test(t),
    );
    expect(businessTouches).toEqual([]);
  });

  it('payment_intent.created — same no-op behavior', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_pi_created_1',
      type: 'payment_intent.created',
      data: { object: { id: 'pi_test_1' } },
    });

    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('payment_intent.created'), reply);

    expect(status).toHaveBeenCalledWith(200);
    const businessTouches = sqlTexts().filter((t) =>
      /UPDATE\s+businesses|DELETE\s+FROM\s+businesses|INSERT\s+INTO\s+businesses/i.test(t),
    );
    expect(businessTouches).toEqual([]);
  });

  it('positive control: checkout.session.completed DOES UPDATE businesses', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: '019dc366-29ce-736d-ae75-d19dc561e58f',
          customer: 'cus_test_1',
          subscription: 'sub_test_1',
        },
      },
    });
    // The activation tx reads the current subscription_status, then UPDATEs.
    mockSql.mockImplementation((tpl: TemplateStringsArray) => {
      const text = tpl.join('?');
      if (/SELECT\s+subscription_status/i.test(text)) {
        return Promise.resolve([{ subscription_status: 'pending_payment' }]);
      }
      if (/UPDATE\s+businesses/i.test(text)) {
        return Object.assign(Promise.resolve([]), { count: 1 });
      }
      return Promise.resolve([]);
    });

    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('checkout.session.completed'), reply);

    expect(status).toHaveBeenCalledWith(200);
    const businessUpdates = sqlTexts().filter((t) =>
      /UPDATE\s+businesses/i.test(t),
    );
    // At minimum one UPDATE businesses fired (proves test harness flows
    // through to the dispatch + handler path correctly).
    expect(businessUpdates.length).toBeGreaterThan(0);
  });

  it('returns 401 when stripe-signature header is missing', async () => {
    const req = {
      headers: {},
      rawBody: '{"type":"charge.updated"}',
    } as unknown as FastifyRequest;
    const { reply, status } = mkReply();
    await handleStripeWebhook(req, reply);
    expect(status).toHaveBeenCalledWith(401);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature verification throws', async () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error('Invalid signature');
    });
    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('charge.updated'), reply);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 200 duplicate when claimInboundEvent returns "duplicate"', async () => {
    mockClaimInboundEvent.mockResolvedValueOnce('duplicate');
    mockConstructEvent.mockReturnValue({
      id: 'evt_dup_1',
      type: 'charge.updated',
      data: { object: { id: 'ch_test_3' } },
    });

    const { reply, status, send } = mkReply();
    await handleStripeWebhook(mkRequest('charge.updated'), reply);

    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ received: true, duplicate: true }),
    );
    // No further SQL should fire (no inbound_events UPDATE either, since
    // we short-circuit before the dispatch).
    expect(mockSql).not.toHaveBeenCalled();
  });
});
