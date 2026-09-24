import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Unit coverage for the shared Twilio delivery-status state machine, in
// particular the terminal branch (finalizeTerminalDeliveryStatus): row not yet
// present (503 reclaim), already terminal (no-op 200), delivered, and failed.
const {
  sqlQueue,
  sqlCalls,
  mockClaimInboundEvent,
  mockMarkInboundEventFailed,
  mockMarkInboundEventProcessed,
  mockVerifyTwilioSignature,
} = vi.hoisted(() => ({
  sqlQueue: [] as unknown[],
  sqlCalls: [] as { sql: string; values: unknown[] }[],
  mockClaimInboundEvent: vi.fn(async (): Promise<'claimed' | 'duplicate'> => 'claimed'),
  mockMarkInboundEventFailed: vi.fn(async () => undefined),
  mockMarkInboundEventProcessed: vi.fn(async () => undefined),
  mockVerifyTwilioSignature: vi.fn(() => true),
}));

vi.mock('../twilio-verify', () => ({
  verifyTwilioSignature: mockVerifyTwilioSignature,
  parseTwilioBody: vi.fn((raw: string) => {
    const params: Record<string, string> = {};
    new URLSearchParams(raw).forEach((v, k) => {
      params[k] = v;
    });
    return params;
  }),
}));

vi.mock('../../shared', () => ({
  claimInboundEvent: mockClaimInboundEvent,
  markInboundEventFailed: mockMarkInboundEventFailed,
  markInboundEventProcessed: mockMarkInboundEventProcessed,
}));

vi.mock('../../../../src/lib/config/worker', () => ({
  getWorkerConfig: () => ({ TWILIO_AUTH_TOKEN: 'test-token' }),
}));

vi.mock('../../../../src/lib/db/server', () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    const next = sqlQueue.shift();
    return Array.isArray(next) ? next : [];
  },
}));

import { handleTwilioDeliveryStatus } from '../twilio-delivery-status';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

function makeRequest(params: Record<string, string>): FastifyRequest {
  return {
    rawBody: new URLSearchParams(params).toString(),
    headers: { 'x-twilio-signature': 'sig' },
  } as unknown as FastifyRequest;
}

const OPTIONS = {
  channel: 'whatsapp' as const,
  fullUrl: () => 'https://worker.example/twilio/status',
  invalidSignatureMessage: 'invalid signature',
  logPrefix: 'test:twilio-status',
};

async function run(params: Record<string, string>) {
  const reply = makeReply();
  await handleTwilioDeliveryStatus(
    makeRequest(params),
    reply as unknown as FastifyReply,
    OPTIONS,
  );
  return reply;
}

describe('handleTwilioDeliveryStatus', () => {
  beforeEach(() => {
    sqlQueue.length = 0;
    sqlCalls.length = 0;
    vi.clearAllMocks();
    mockVerifyTwilioSignature.mockReturnValue(true);
    mockClaimInboundEvent.mockResolvedValue('claimed');
  });

  it('rejects an invalid signature with 401 and touches nothing', async () => {
    mockVerifyTwilioSignature.mockReturnValue(false);
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(reply.statusCode).toBe(401);
    expect(mockClaimInboundEvent).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('returns 400 when MessageSid or MessageStatus is missing', async () => {
    const reply = await run({ MessageSid: 'SM1' });
    expect(reply.statusCode).toBe(400);
    expect(mockClaimInboundEvent).not.toHaveBeenCalled();
  });

  it('acks a duplicate claim with 200 and does no delivery work', async () => {
    mockClaimInboundEvent.mockResolvedValue('duplicate');
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ received: true, duplicate: true });
    expect(sqlCalls).toHaveLength(0);
  });

  it('marks a non-terminal status processed without reading the delivery row', async () => {
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'sent' });
    expect(reply.statusCode).toBe(200);
    expect(mockMarkInboundEventProcessed).toHaveBeenCalledWith('SM1:sent');
    expect(sqlCalls).toHaveLength(0);
  });

  it('returns 503 and marks the event failed when the delivery row is not yet present', async () => {
    sqlQueue.push([]);
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(reply.statusCode).toBe(503);
    expect(reply.body).toEqual({ received: true, retry: 'delivery_row_not_yet_present' });
    expect(mockMarkInboundEventFailed).toHaveBeenCalledWith('SM1:delivered', 'delivery_row_not_yet_present');
    expect(mockMarkInboundEventProcessed).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it('preserves an already-terminal row (first terminal wins) and issues no UPDATE', async () => {
    sqlQueue.push([{ id: 'd1', delivered_at: new Date(), failed_at: null }]);
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'failed', ErrorCode: '63016' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ received: true, terminal_state_preserved: true });
    expect(mockMarkInboundEventProcessed).toHaveBeenCalledWith('SM1:failed');
    expect(sqlCalls).toHaveLength(1);
  });

  it('stamps delivered_at for a delivered status', async () => {
    sqlQueue.push([{ id: 'd1', delivered_at: null, failed_at: null }]);
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(reply.statusCode).toBe(200);
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1]!.sql).toContain('SET delivered_at = NOW()');
    expect(sqlCalls[1]!.sql).toContain('delivered_at IS NULL AND failed_at IS NULL');
    expect(mockMarkInboundEventProcessed).toHaveBeenCalledWith('SM1:delivered');
  });

  it('stamps failed_at with the Twilio error code for a failed status', async () => {
    sqlQueue.push([{ id: 'd1', delivered_at: null, failed_at: null }]);
    const reply = await run({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '63016' });
    expect(reply.statusCode).toBe(200);
    expect(sqlCalls[1]!.sql).toContain('SET failed_at = NOW(), failure_reason = ?');
    expect(sqlCalls[1]!.values).toContain('twilio:63016');
  });

  it("records 'twilio:unknown' when a failed status carries no error code", async () => {
    sqlQueue.push([{ id: 'd1', delivered_at: null, failed_at: null }]);
    await run({ MessageSid: 'SM1', MessageStatus: 'failed' });
    expect(sqlCalls[1]!.values).toContain('twilio:unknown');
  });
});
