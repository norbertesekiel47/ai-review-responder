import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ─── Hoisted mock primitives ────────────────────────────────────────────────
// All vi.fn() references hoisted so vi.mock() factory closures can capture
// them before module evaluation. Same pattern as telegram.test.ts.
const {
  sqlQueue,
  sqlCalls,
  mockClaimInboundEvent,
  mockVerifyTwilioSignature,
  mockSendFreeform,
  mockApproveViaCallback,
  mockRegenerateViaCallback,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: { sql: string }[] = [];
  return {
    sqlQueue,
    sqlCalls,
    mockClaimInboundEvent: vi.fn(async (): Promise<'claimed' | 'duplicate'> => 'claimed'),
    mockVerifyTwilioSignature: vi.fn(() => true),
    mockSendFreeform: vi.fn(),
    mockApproveViaCallback: vi.fn(),
    mockRegenerateViaCallback: vi.fn(),
  };
});

vi.mock('../twilio-verify', () => ({
  verifyTwilioSignature: mockVerifyTwilioSignature,
  parseTwilioBody: vi.fn((raw: string) => {
    const params: Record<string, string> = {};
    new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });
    return params;
  }),
}));
vi.mock('../../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared')>();
  return { ...actual, claimInboundEvent: mockClaimInboundEvent };
});

// sql mock: tagged-template function that reads from sqlQueue for sequential
// return values; `.begin` wraps a tx function that reads from the same queue.
vi.mock('../../../../src/lib/db/server', () => {
  const sqlFn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?') });
    const next = sqlQueue.shift();
    if (next instanceof Error) throw next;
    if (Array.isArray(next)) return next;
    const arr: unknown[] & { count?: number } = [];
    arr.count = typeof next === 'number' ? next : 0;
    return arr;
  };
  const beginFn = async (fn: (tx: typeof sqlFn) => Promise<unknown>) => {
    const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ sql: strings.join('?') });
      const next = sqlQueue.shift();
      if (next instanceof Error) throw next;
      if (Array.isArray(next)) return next;
      const arr: unknown[] & { count?: number } = [];
      arr.count = typeof next === 'number' ? next : 0;
      return arr;
    };
    return fn(tx as unknown as typeof sqlFn);
  };
  const sql = Object.assign(sqlFn, { begin: beginFn });
  return { sql, jsonb: (v: unknown) => v };
});

vi.mock('../../../../src/lib/notifications/channels/whatsapp-client', () => ({
  // Use a regular function so `new WhatsAppClient()` works (arrow functions
  // cannot be constructors). Same pattern as MockTelegramClient in telegram.test.ts.
  WhatsAppClient: function MockWhatsAppClient() {
    return { sendFreeform: mockSendFreeform };
  },
}));

vi.mock('../../../../src/lib/approval/service', () => ({
  approveViaCallback: mockApproveViaCallback,
  regenerateViaCallback: mockRegenerateViaCallback,
}));

// Mock invalidateChannelCache — must use vi.hoisted so the vi.mock factory
// closures can reference the mock function.
const { mockInvalidateChannelCache } = vi.hoisted(() => ({
  mockInvalidateChannelCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../src/lib/notifications/resolve-channels', () => ({
  invalidateChannelCache: mockInvalidateChannelCache,
  safeInvalidateChannelCache: mockInvalidateChannelCache,
}));
vi.mock('../../../../src/lib/shared/ids', () => ({
  asAccountId: vi.fn((id: string) => id),
}));

import { handleTwilioWhatsAppStatus, handleTwilioWhatsAppInbound, redactWhatsAppPayload } from '../twilio-whatsapp';
import { verifyTwilioSignature } from '../twilio-verify';
import { claimInboundEvent } from '../../shared';
import { createHash } from 'node:crypto';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
  ResponseNotPendingError,
  ArchivedLocationError,
} from '../../../../src/lib/approval/errors';
import { SubscriptionReadOnlyError } from '../../../../src/lib/shared/writable-subscription';

function buildRequest(body: Record<string, string>, url = '/ingress/twilio/whatsapp-inbound'): FastifyRequest {
  const raw = new URLSearchParams(body).toString();
  return {
    url,
    headers: { 'x-twilio-signature': 'sig' },
    rawBody: raw,
    ip: '1.2.3.4',
  } as unknown as FastifyRequest;
}

function buildStatusRequest(body: Record<string, string>): FastifyRequest {
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
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  mockClaimInboundEvent.mockReset();
  mockVerifyTwilioSignature.mockReset();
  mockSendFreeform.mockReset();
  mockApproveViaCallback.mockReset();
  mockRegenerateViaCallback.mockReset();
  mockInvalidateChannelCache.mockClear();

  // Default: signature valid, claim succeeds, sendFreeform resolves
  mockVerifyTwilioSignature.mockReturnValue(true);
  mockClaimInboundEvent.mockResolvedValue('claimed');
  mockSendFreeform.mockResolvedValue({ externalMessageId: 'SM_ok' });

  process.env.WORKER_PUBLIC_URL = 'https://worker.example.com';
  process.env.TWILIO_AUTH_TOKEN = 'auth';
});

// ─── Status handler tests ────────────────────────────────────────────────────

describe('handleTwilioWhatsAppStatus', () => {
  it('returns 401 on signature mismatch', async () => {
    mockVerifyTwilioSignature.mockReturnValueOnce(false);
    const req = buildStatusRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 on missing MessageSid or MessageStatus', async () => {
    const req = buildStatusRequest({ MessageSid: 'SM1' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 with duplicate:true on repeat', async () => {
    mockClaimInboundEvent.mockResolvedValueOnce('duplicate');
    const req = buildStatusRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
  });

  it('uses dedup key MessageSid:MessageStatus and eventType status:<status>', async () => {
    // Non-terminal so it short-circuits after markProcessed (one sql call)
    const req = buildStatusRequest({ MessageSid: 'SM1', MessageStatus: 'queued' });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);
    expect(mockClaimInboundEvent).toHaveBeenCalledWith(
      'twilio', 'SM1:queued', expect.stringMatching(/^status:/), expect.any(Object),
    );
  });
});

// ─── Inbound handler: redaction ──────────────────────────────────────────────

describe('redactWhatsAppPayload', () => {
  it('redacts Body and ButtonPayload, drops PII fields, keeps forensic fields', () => {
    const input = {
      From: 'whatsapp:+15551234567',
      MessageSid: 'SMabc',
      Body: 'start-SECRET_TOKEN',
      ButtonPayload: 'a:LINK',
      ProfileName: 'Jane',
      WaId: '15551234567',
    };
    const out = redactWhatsAppPayload(input);
    expect(out.Body).toBe('[redacted]');
    expect(out.ButtonPayload).toBe('[redacted]');
    expect(out.ProfileName).toBeUndefined();
    expect(out.WaId).toBeUndefined();
    expect(out.From).toBe('whatsapp:+15551234567');
    expect(out.MessageSid).toBe('SMabc');
  });
});

// ─── Inbound handler: signature + missing fields ─────────────────────────────

describe('handleTwilioWhatsAppInbound — signature + missing fields', () => {
  it('401 on signature mismatch', async () => {
    mockVerifyTwilioSignature.mockReturnValueOnce(false);
    const req = buildRequest({ MessageSid: 'SM1', From: 'whatsapp:+15551234567', Body: 'hi' });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('400 when MessageSid or From missing', async () => {
    const req = buildRequest({ Body: 'hi' });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('200 duplicate on repeat dedup', async () => {
    mockClaimInboundEvent.mockResolvedValueOnce('duplicate');
    const req = buildRequest({ MessageSid: 'SM1', From: 'whatsapp:+15551234567', Body: 'anything' });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
  });
});

// ─── Inbound handler: enrollment path (start-<token>) ────────────────────────

describe('handleTwilioWhatsAppInbound — enrollment path (start-<token>)', () => {
  it('hashes inbound token, UPDATEs the matching pending_verification row, confirms success', async () => {
    const rawToken = 'RAW123';
    // enrollment SELECT returns a match (with account_id); UPDATE returns nothing
    sqlQueue.push([{ id: 'enroll-1', account_id: 'acct-wa-1' }]);
    sqlQueue.push([]); // UPDATE
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_inbound1',
      From: 'whatsapp:+15551234567',
      Body: `start-${rawToken}`,
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      to: 'whatsapp:+15551234567',
      body: expect.stringMatching(/connected to RepWorth/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
    // Cache must be invalidated after enrollment verification
    expect(mockInvalidateChannelCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateChannelCache).toHaveBeenCalledWith('acct-wa-1', 'worker.twilio.whatsapp.verify');
  });

  it('sends "invalid or expired" when no matching token', async () => {
    sqlQueue.push([]); // SELECT returns nothing
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_inbound2',
      From: 'whatsapp:+15551234567',
      Body: 'start-BADTOKEN',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/invalid or expired/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
    // No enrollment matched — no invalidation
    expect(mockInvalidateChannelCache).not.toHaveBeenCalled();
  });
});

// ─── Inbound handler: button tap path ────────────────────────────────────────

describe('handleTwilioWhatsAppInbound — button tap path', () => {
  it('invokes approveViaCallback with viaChannel=whatsapp and twilioMessageSid populated', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]); // link lookup
    sqlQueue.push([{ handle: '+15551234567' }]);               // enrollment lookup
    mockApproveViaCallback.mockResolvedValueOnce(undefined);
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_button1',
      From: 'whatsapp:+15551234567',
      ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockApproveViaCallback).toHaveBeenCalledWith(expect.objectContaining({
      approvalLinkId: '019db8c1-c3f4-7668-b353-2b8b718ec603',
      chatHandle: '+15551234567',
      viaChannel: 'whatsapp',
      audit: expect.objectContaining({
        providerEventId: 'SM_button1',
        twilioMessageSid: 'SM_button1',
      }),
    }));
    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/approved/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('classifies ResponseNotPendingError as permanent (markProcessed, friendly message, 200)', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]);
    sqlQueue.push([{ handle: '+15551234567' }]);
    mockApproveViaCallback.mockRejectedValueOnce(new ResponseNotPendingError('approved'));
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_rnp', From: 'whatsapp:+15551234567', ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/handled on another channel|no longer valid/i),
    }));
    // Plain ResponseNotPendingError keeps the "handled" copy — the
    // archived-specific copy is reserved for ArchivedLocationError.
    expect(mockSendFreeform).not.toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/archived/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('classifies ArchivedLocationError as permanent with archived-specific copy, NOT the handled copy', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]);
    sqlQueue.push([{ handle: '+15551234567' }]);
    mockRegenerateViaCallback.mockRejectedValueOnce(new ArchivedLocationError());
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_arch', From: 'whatsapp:+15551234567', ButtonPayload: 'r:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockSendFreeform).toHaveBeenCalledTimes(1);
    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/archived/i),
    }));
    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/approval actions are no longer available/i),
    }));
    // ArchivedLocationError extends ResponseNotPendingError — it must NOT
    // fall through to the parent's "handled on another channel" copy.
    expect(mockSendFreeform).not.toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/handled on another channel/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('classifies ConsumedLinkError as permanent', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]);
    sqlQueue.push([{ handle: '+15551234567' }]);
    mockApproveViaCallback.mockRejectedValueOnce(new ConsumedLinkError());
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_cl', From: 'whatsapp:+15551234567', ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('classifies SubscriptionReadOnlyError as permanent', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]);
    sqlQueue.push([{ handle: '+15551234567' }]);
    mockApproveViaCallback.mockRejectedValueOnce(new SubscriptionReadOnlyError());
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_ro', From: 'whatsapp:+15551234567', ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/Billing recovery has ended/),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['offboarding-blocked', new SubscriptionReadOnlyError('account_offboarding_blocked', 403)],
    ['deleted-account', new SubscriptionReadOnlyError('no_business', 403)],
  ])('classifies %s SubscriptionReadOnlyError as permanent offboarding copy', async (_label, err) => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]);
    sqlQueue.push([{ handle: '+15551234567' }]);
    mockApproveViaCallback.mockRejectedValueOnce(err);
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_ob',
      From: 'whatsapp:+15551234567',
      ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/offboarded|can no longer be completed/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('unexpected error routes to failed + 503 for reclaim', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]);
    sqlQueue.push([{ handle: '+15551234567' }]);
    mockApproveViaCallback.mockRejectedValueOnce(new Error('db timeout'));
    sqlQueue.push([]); // markFailed

    const req = buildRequest({
      MessageSid: 'SM_err', From: 'whatsapp:+15551234567', ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
  });

  it('rejects when no live approval_link matches (valid UUID, no DB row)', async () => {
    sqlQueue.push([]); // link lookup empty
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      // Valid UUID shape but no DB row matches — the link-lookup SELECT
      // returns [], which routes to the "handled on another channel" message.
      MessageSid: 'SM_nolink',
      From: 'whatsapp:+15551234567',
      ButtonPayload: 'a:00000000-0000-7000-8000-000000000000',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(mockApproveViaCallback).not.toHaveBeenCalled();
    expect(mockSendFreeform).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringMatching(/handled on another channel|no longer valid/i),
    }));
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('rejects button tap when sender handle does not match any verified enrollment', async () => {
    sqlQueue.push([{ id: '019db8c1-c3f4-7668-b353-2b8b718ec603', business_id: 'biz-1' }]); // link found
    sqlQueue.push([]);                                          // no matching enrollment

    const req = buildRequest({
      MessageSid: 'SM_forged', From: 'whatsapp:+19999999999', ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);
    expect(mockApproveViaCallback).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(200);
  });
});

// ─── Inbound handler: STOP keyword ───────────────────────────────────────────

describe('handleTwilioWhatsAppInbound — STOP keyword', () => {
  it('flips enrollment to unsubscribed with whatsapp_stop reason', async () => {
    sqlQueue.push([{ account_id: 'acct-stop-1' }]); // UPDATE channel_enrollments RETURNING
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_stop', From: 'whatsapp:+15551234567', Body: 'STOP',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    // The tx must have run (UPDATE channel_enrollments)
    const unsubCall = sqlCalls.find((c) => c.sql.includes('unsubscribed'));
    expect(unsubCall).toBeDefined();
    // TCPA-critical: cache must be invalidated after STOP
    expect(mockInvalidateChannelCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateChannelCache).toHaveBeenCalledWith('acct-stop-1', 'worker.twilio.whatsapp.stop');
  });

  it('STOP invalidates cache for each unique affected account (deduped)', async () => {
    sqlQueue.push([{ account_id: 'acct-a' }, { account_id: 'acct-b' }, { account_id: 'acct-a' }]); // 3 rows, 2 unique
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_stop_multi', From: 'whatsapp:+15551234567', Body: 'STOP',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    // Should invalidate once per unique account_id (deduped)
    expect(mockInvalidateChannelCache).toHaveBeenCalledTimes(2);
    expect(mockInvalidateChannelCache).toHaveBeenCalledWith('acct-a', 'worker.twilio.whatsapp.stop');
    expect(mockInvalidateChannelCache).toHaveBeenCalledWith('acct-b', 'worker.twilio.whatsapp.stop');
  });

  it('STOP with no matching enrollments still succeeds without cache invalidation', async () => {
    sqlQueue.push([]); // UPDATE RETURNING (0 rows)
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_stop_none', From: 'whatsapp:+15551234567', Body: 'STOP',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(mockInvalidateChannelCache).not.toHaveBeenCalled();
  });
});

describe('handleTwilioWhatsAppInbound — UUID validation on button payload', () => {
  it('treats non-UUID link id as malformed (processed 200, no DB lookup)', async () => {
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_bad_uuid', From: 'whatsapp:+15551234567',
      ButtonPayload: 'a:not-a-uuid',  // malformed — no DB query should happen
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(mockApproveViaCallback).not.toHaveBeenCalled();
    // Only markProcessed should have run — no approval_links SELECT
    const linkLookup = sqlCalls.find((c) => c.sql.includes('approval_links'));
    expect(linkLookup).toBeUndefined();
  });

  it('treats empty link id as malformed (a: with no suffix)', async () => {
    sqlQueue.push([]); // markProcessed

    const req = buildRequest({
      MessageSid: 'SM_empty_uuid', From: 'whatsapp:+15551234567',
      ButtonPayload: 'a:',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(mockApproveViaCallback).not.toHaveBeenCalled();
  });
});

describe('handleTwilioWhatsAppInbound — post-claim safety net', () => {
  it('routes SQL failure during link lookup to markFailed + 503 (not stuck received)', async () => {
    // Push an Error into the queue — the sql mock throws Errors instead of returning rows
    sqlQueue.push(new Error('db timeout on approval_links SELECT'));
    sqlQueue.push([]); // markFailed

    const req = buildRequest({
      MessageSid: 'SM_sqlfail',
      From: 'whatsapp:+15551234567',
      ButtonPayload: 'a:019db8c1-c3f4-7668-b353-2b8b718ec603',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(mockApproveViaCallback).not.toHaveBeenCalled();
    // markFailed must have run (post_claim_unexpected:...)
    const failCall = sqlCalls.find((c) =>
      c.sql.includes('inbound_events') && c.sql.includes('failed')
    );
    expect(failCall).toBeDefined();
  });

  it('routes SQL failure during STOP UPDATE to markFailed + 503', async () => {
    sqlQueue.push(new Error('db timeout on channel_enrollments UPDATE'));
    sqlQueue.push([]); // markFailed

    const req = buildRequest({
      MessageSid: 'SM_stopfail', From: 'whatsapp:+15551234567', Body: 'STOP',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppInbound(req, reply);

    expect(reply.status).toHaveBeenCalledWith(503);
    const failCall = sqlCalls.find((c) =>
      c.sql.includes('inbound_events') && c.sql.includes('failed')
    );
    expect(failCall).toBeDefined();
  });
});
