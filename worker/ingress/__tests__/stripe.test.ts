import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockSql,
  mockClaimInboundEvent,
  mockConstructEvent,
} = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  // writeAccountAuditLog (real implementation, not mocked in this file) now
  // calls the injected client's `.json()` directly instead of the removed
  // `jsonb()` helper — the mock client needs the method too.
  sqlFn.json = vi.fn((v: unknown) => v);
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

// Snapshot + restore the env vars we mutate so this test file can't pollute
// downstream files in the same Vitest worker. STRIPE_SECRET_KEY +
// STRIPE_WEBHOOK_SECRET need to be set before the dynamic import below
// (the handler module reads them at import time via a lazy singleton).
const _origStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const _origStripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';

import { handleStripeWebhook } from '../stripe';

afterAll(() => {
  if (_origStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = _origStripeSecretKey;
  if (_origStripeWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = _origStripeWebhookSecret;
});

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

  // B23 — malformed client_reference_id used to trigger the
  // `${refId}::uuid` cast inside the tx, raising a Postgres "invalid
  // input syntax for type uuid" error → handler 500 → inbound_events
  // marked failed → Stripe retries the event for ~3 days. The UUID_RE
  // guard returns early (200, no SQL writes, log warn) so Stripe stops
  // retrying and oncall sees a clean breadcrumb.
  it('checkout.session.completed with malformed client_reference_id → 200 + no SQL writes + log warn', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_bad_id_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_bad',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: 'not-a-uuid', // malformed
          customer: 'cus_test_bad',
          subscription: 'sub_test_bad',
        },
      },
    });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('checkout.session.completed'), reply);

    // Stripe gets 200 — stops retrying.
    expect(status).toHaveBeenCalledWith(200);

    // Critical: no account or business-table SQL fires.
    const dataTouches = sqlTexts().filter((t) =>
      /UPDATE\s+(accounts|businesses)|SELECT\s+subscription_status[\s\S]*FROM\s+(accounts|businesses)|DELETE\s+FROM\s+(accounts|businesses)/i.test(t),
    );
    expect(dataTouches).toEqual([]);

    // The advisory-lock template should also not fire (we returned before
    // entering the tx).
    const lockTouches = sqlTexts().filter((t) =>
      /pg_advisory_xact_lock/i.test(t),
    );
    expect(lockTouches).toEqual([]);

    // Log line tells oncall the event was dropped intentionally.
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/malformed ref_id/);
    expect(warnedText).toMatch(/"not-a-uuid"/);

    // inbound_events still gets marked processed at the tail of the
    // handler (so future replays of the same event id are deduped).
    expect(
      sqlTexts().some((t) =>
        /UPDATE\s+inbound_events[\s\S]*processed/i.test(t),
      ),
    ).toBe(true);

    consoleSpy.mockRestore();
  });

  it('checkout.session.completed with empty-string client_reference_id → 200 + no SQL writes (handled by the existing !refId guard)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_empty_id_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_empty',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: '',
          customer: 'cus_test',
          subscription: 'sub_test',
        },
      },
    });
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('checkout.session.completed'), reply);

    expect(status).toHaveBeenCalledWith(200);
    const dataTouches = sqlTexts().filter((t) =>
      /UPDATE\s+(accounts|businesses)|SELECT\s+subscription_status[\s\S]*FROM\s+(accounts|businesses)/i.test(t),
    );
    expect(dataTouches).toEqual([]);
    consoleSpy.mockRestore();
  });

  it('positive control: checkout.session.completed DOES UPDATE accounts', async () => {
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
    // After B1.4: paid activation routes through the applier (checkout mode).
    // SQL sequence:
    //   1. Pre-tx: SELECT id FROM accounts WHERE id=? (account lookup)
    //   2. In-tx: pg_advisory_xact_lock
    //   3. In-tx: Applier resolveAccount — SELECT a.id, a.subscription_status,
    //             (SELECT b.id …) AS primary_business_id FROM accounts a … FOR UPDATE
    //   4. In-tx: Applier writeStatusColumns — UPDATE accounts SET subscription_status='active'…
    //   5. In-tx: Applier writeBusinessesMirror — UPDATE businesses SET subscription_status='active'…
    //   6. writeAccountAuditLog — NOT mocked in this file, but the module-level mock
    //             of audit/log is not set up here; the real call will use the mocked sql
    //             for its INSERT INTO account_audit_log.
    //   7. In-tx: enqueueStripeOverageRecompute — INSERT INTO job_outbox
    mockSql.mockImplementation((tpl: TemplateStringsArray) => {
      const text = tpl.join('?');
      // 1. Pre-tx account lookup: SELECT id FROM accounts WHERE id = ?
      if (/SELECT\s+id\s+FROM\s+accounts/i.test(text)) {
        return Promise.resolve([{ id: '019dc366-29ce-736d-ae75-d19dc561e58f' }]);
      }
      // 3. Applier's resolveAccount: SELECT a.id, a.subscription_status, … FROM accounts a …
      //    Matches the broader "SELECT … FROM accounts" that includes 'a.subscription_status'
      if (/FROM\s+accounts/i.test(text) && /subscription_status/i.test(text)) {
        return Promise.resolve([{
          id: '019dc366-29ce-736d-ae75-d19dc561e58f',
          subscription_status: 'pending_payment',
          primary_business_id: null,
        }]);
      }
      // 4/5. UPDATE accounts or businesses
      if (/UPDATE\s+(accounts|businesses)/i.test(text)) {
        const result: any[] = [];
        (result as any).count = 1;
        return Promise.resolve(result);
      }
      return Promise.resolve([]);
    });

    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('checkout.session.completed'), reply);

    expect(status).toHaveBeenCalledWith(200);
    const accountUpdates = sqlTexts().filter((t) =>
      /UPDATE\s+accounts/i.test(t),
    );
    // At minimum one UPDATE accounts fired (proves the handler now
    // targets the accounts table as source of truth).
    expect(accountUpdates.length).toBeGreaterThan(0);
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

  it('rejects an event whose created is older than the stale threshold', async () => {
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    mockConstructEvent.mockReturnValue({ id: 'evt_stale', type: 'invoice.paid', created: eightDaysAgo, data: { object: {} } });
    const { reply, status, send } = mkReply();
    await handleStripeWebhook(mkRequest('invoice.paid'), reply);
    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ stale: true }));
    expect(mockClaimInboundEvent).not.toHaveBeenCalled();
  });

  it('processes a recent event (created = now)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_fresh', type: 'charge.updated', created: Math.floor(Date.now() / 1000), data: { object: {} } });
    mockClaimInboundEvent.mockResolvedValue('claimed');
    const { reply, status } = mkReply();
    await handleStripeWebhook(mkRequest('charge.updated'), reply);
    expect(mockClaimInboundEvent).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(200);
  });

  it('processes a legitimately-retried event within the retry window (~2 days old)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_retry', type: 'charge.updated', created: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60, data: { object: {} } });
    mockClaimInboundEvent.mockResolvedValue('claimed');
    const { reply } = mkReply();
    await handleStripeWebhook(mkRequest('charge.updated'), reply);
    expect(mockClaimInboundEvent).toHaveBeenCalledTimes(1);
  });
});
