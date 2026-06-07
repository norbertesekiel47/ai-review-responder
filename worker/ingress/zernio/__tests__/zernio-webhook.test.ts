import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, mockClaimInboundEvent } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];

  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: Array.from(strings).join('?'), values });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });

  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => callback(mockSql));

  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockClaimInboundEvent: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../shared', () => ({
  claimInboundEvent: mockClaimInboundEvent,
}));

import { handleZernioWebhook } from '../zernio';

const SECRET = 'test-zernio-webhook-secret';
const origZernioPublishingEnabled = process.env.ZERNIO_PUBLISHING_ENABLED;
const origZernioWebhookSecret = process.env.ZERNIO_WEBHOOK_SECRET;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function mkRequest(body: Record<string, unknown>, eventId = 'evt_zernio_1'): any {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: {
      'x-zernio-signature': sign(rawBody),
      'x-zernio-event-id': eventId,
    },
  };
}

function mkReply() {
  const status = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  return { status, send };
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  vi.clearAllMocks();
  mockClaimInboundEvent.mockResolvedValue('claimed');
  process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (origZernioPublishingEnabled === undefined) delete process.env.ZERNIO_PUBLISHING_ENABLED;
  else process.env.ZERNIO_PUBLISHING_ENABLED = origZernioPublishingEnabled;

  if (origZernioWebhookSecret === undefined) delete process.env.ZERNIO_WEBHOOK_SECRET;
  else process.env.ZERNIO_WEBHOOK_SECRET = origZernioWebhookSecret;
});

describe('Zernio account.disconnected webhook', () => {
  it('stamps active teardown offboarding zernio accounts step without connection-lost notification', async () => {
    const teardownUpdate: any = [];
    teardownUpdate.count = 1;
    sqlReturnQueue.push(teardownUpdate);
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest({
        event: 'account.disconnected',
        id: 'evt_zernio_teardown_disconnect',
        account: { id: 'zernio-account-1' },
      }),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const offboardingUpdate = sqlCalls.find((call) =>
      call.text.includes('UPDATE account_offboardings') &&
      call.text.includes("zernio_accounts_step = 'success'"),
    );
    expect(offboardingUpdate).toBeDefined();
    expect(offboardingUpdate!.text).toContain("status = 'tearing_down'");
    expect(offboardingUpdate!.text).toContain('teardown_started_at IS NOT NULL');
    expect(offboardingUpdate!.text).toContain('teardown_completed_at IS NULL');
    expect(offboardingUpdate!.text).toContain('terminal_at IS NULL');
    expect(offboardingUpdate!.text).toContain('zernio_accounts_step <>');
    expect(offboardingUpdate!.text).toContain('cardinality(zernio_account_ids) = 1');
    expect(offboardingUpdate!.text).toContain('zernio_account_ids');
    expect(offboardingUpdate!.values).toContain('zernio-account-1');

    expect(
      sqlCalls.some((call) => call.text.includes('notify_owner_connection_lost')),
    ).toBe(false);
  });

  it('preserves connection-lost notification behavior outside active teardown', async () => {
    const noTeardownMatch: any = [];
    noTeardownMatch.count = 0;
    sqlReturnQueue.push(noTeardownMatch);
    sqlReturnQueue.push([]); // active teardown membership check
    sqlReturnQueue.push([]); // existing connection-lost transaction
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'account.disconnected',
          id: 'evt_zernio_normal_disconnect',
          reason: 'revoked',
          account: { id: 'zernio-account-2' },
        },
        'evt_zernio_normal_disconnect',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);
    expect(
      sqlCalls.some((call) => call.text.includes('notify_owner_connection_lost')),
    ).toBe(true);
    expect(
      sqlCalls.some((call) => call.text.includes('UPDATE zernio_connections') && call.text.includes("status = 'disconnected'")),
    ).toBe(true);
  });

  it('does not mark a multi-account teardown snapshot success from one account.disconnected webhook', async () => {
    const multiAccountTeardownNotSatisfied: any = [];
    multiAccountTeardownNotSatisfied.count = 0;
    sqlReturnQueue.push(multiAccountTeardownNotSatisfied);
    sqlReturnQueue.push([{ id: 'offboarding-multi-account' }]); // active teardown membership check
    sqlReturnQueue.push([]); // inbound_events processed

    const { status, send } = mkReply();
    await handleZernioWebhook(
      mkRequest(
        {
          event: 'account.disconnected',
          id: 'evt_zernio_multi_teardown_disconnect',
          account: { id: 'zernio-account-3' },
        },
        'evt_zernio_multi_teardown_disconnect',
      ),
      { status, send } as any,
    );

    expect(status).toHaveBeenCalledWith(200);

    const offboardingUpdate = sqlCalls.find((call) =>
      call.text.includes('UPDATE account_offboardings') &&
      call.text.includes("zernio_accounts_step = 'success'"),
    );
    expect(offboardingUpdate).toBeDefined();
    expect(offboardingUpdate!.text).toContain('cardinality(zernio_account_ids) = 1');
    expect(
      sqlCalls.some((call) => call.text.includes('notify_owner_connection_lost')),
    ).toBe(false);
    expect(
      sqlCalls.some((call) => call.text.includes('UPDATE zernio_connections') && call.text.includes("status = 'disconnected'")),
    ).toBe(false);
  });
});
