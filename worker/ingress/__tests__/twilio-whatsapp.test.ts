import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

vi.mock('../twilio-verify', () => ({
  verifyTwilioSignature: vi.fn(() => true),
  parseTwilioBody: vi.fn((raw: string) => {
    const params: Record<string, string> = {};
    new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
    return params;
  }),
}));
vi.mock('../shared', () => ({
  claimInboundEvent: vi.fn(async () => 'claimed' as const),
}));
vi.mock('../../../src/lib/db/server', () => ({
  sql: Object.assign(vi.fn(async () => []), { begin: vi.fn(async (fn: any) => fn(vi.fn())) }),
  jsonb: (v: unknown) => v,
}));

import { handleTwilioWhatsAppStatus } from '../twilio-whatsapp';
import { verifyTwilioSignature } from '../twilio-verify';
import { claimInboundEvent } from '../shared';

function buildRequest(body: Record<string, string>): FastifyRequest {
  const raw = new URLSearchParams(body).toString();
  return {
    url: '/ingress/twilio/whatsapp-status',
    headers: { 'x-twilio-signature': 'sig' },
    rawBody: raw,
  } as unknown as FastifyRequest;
}
function buildReply() {
  const reply = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
  return reply as unknown as FastifyReply & { status: any; send: any };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
  process.env.TWILIO_AUTH_TOKEN = 'auth';
});

describe('handleTwilioWhatsAppStatus', () => {
  it('returns 401 on signature mismatch', async () => {
    (verifyTwilioSignature as any).mockReturnValueOnce(false);
    const req = buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 on missing MessageSid or MessageStatus', async () => {
    const req = buildRequest({ MessageSid: 'SM1' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 with duplicate:true on repeat', async () => {
    (claimInboundEvent as any).mockResolvedValueOnce('duplicate');
    const req = buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
  });

  it('uses dedup key MessageSid:MessageStatus and eventType status:<status>', async () => {
    const req = buildRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(claimInboundEvent).toHaveBeenCalledWith(
      'twilio', 'SM1:delivered', expect.stringMatching(/^status:/), expect.any(Object),
    );
  });
});
