import { describe, it, expect, vi, beforeEach } from 'vitest';

// Tx mocking: push expected row sets into the queue; the mock consumes them in order.
const txQueue: unknown[] = [];
type TxCall = { sql: string; params: unknown[] };
const txCalls: TxCall[] = [];

const mockTx = Object.assign(
  async (strings: TemplateStringsArray, ...params: unknown[]) => {
    txCalls.push({ sql: strings.join('?'), params });
    const next = txQueue.shift();
    return next ?? [];
  },
  { begin: vi.fn() },
) as unknown;

vi.mock('../../db/server', () => ({
  sql: {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
  },
  jsonb: (v: unknown) => v,
}));

vi.mock('../correlation', () => ({
  recoverCorrelationId: vi.fn(async () => 'upstream-corr-id'),
}));

import { approveViaCallback, regenerateViaCallback } from '../service';
import {
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from '../errors';

function liveLinkRow(overrides: Partial<Record<string, unknown>> = {}) {
  return [{
    id: 'link-1',
    response_id: 'resp-1',
    business_id: 'biz-1',
    token_hash: 'hash-1',
    channel: 'telegram',
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    revoked_at: null,
    device_cookie_hash: null,
    created_at: new Date(),
    ...overrides,
  }];
}

function pendingResponseRow() {
  return [{ status: 'pending_approval', original_draft_text: 'draft', version: 1, review_id: 'rev-1' }];
}

describe('approveViaCallback', () => {
  beforeEach(() => { txQueue.length = 0; txCalls.length = 0; });

  it('happy path: consumes link, revokes siblings, approves response, inserts publish_response + audit', async () => {
    txQueue.push(liveLinkRow());             // SELECT approval_links FOR UPDATE
    txQueue.push(pendingResponseRow());      // lockPendingResponse
    txQueue.push([]);                        // consumeLink UPDATE
    txQueue.push([]);                        // UPDATE responses status=approved
    txQueue.push([]);                        // revokeSiblings UPDATE
    txQueue.push([]);                        // INSERT job_outbox publish_response
    txQueue.push([{ account_id: 'acc-1' }]); // resolveAccountIdFromBusiness: SELECT account_id FROM businesses
    txQueue.push([]);                        // insertAuditLog INSERT
    await approveViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123456789',
      viaChannel: 'telegram',
      audit: { providerEventId: '999', ipAddress: '1.2.3.4', telegramUpdateId: 999 },
    });
    const auditCall = txCalls.find((c) => c.sql.includes('approval_audit_log'));
    expect(auditCall).toBeDefined();
    const metadata = auditCall!.params.find((p) => p && typeof p === 'object' && 'chat_handle_hash' in (p as object));
    expect(metadata).toMatchObject({
      via_channel: 'telegram',
      update_id: 999,
      provider_event_id: '999',
      correlation_id: 'upstream-corr-id',
    });
    expect((metadata as { chat_handle_hash: string }).chat_handle_hash).toMatch(/^[a-f0-9]{64}$/);
    // "Never both" invariant: Telegram rows must not carry a WhatsApp message_sid.
    expect(metadata).not.toHaveProperty('message_sid');
  });

  it('throws ConsumedLinkError when consumed_at is set', async () => {
    txQueue.push(liveLinkRow({ consumed_at: new Date() }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { providerEventId: '1', ipAddress: null, telegramUpdateId: 1 },
    })).rejects.toBeInstanceOf(ConsumedLinkError);
  });

  it('throws RevokedLinkError when revoked_at is set', async () => {
    txQueue.push(liveLinkRow({ revoked_at: new Date() }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { providerEventId: '1', ipAddress: null, telegramUpdateId: 1 },
    })).rejects.toBeInstanceOf(RevokedLinkError);
  });

  it('throws ExpiredLinkError when expires_at is past', async () => {
    txQueue.push(liveLinkRow({ expires_at: new Date(Date.now() - 60_000) }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { providerEventId: '1', ipAddress: null, telegramUpdateId: 1 },
    })).rejects.toBeInstanceOf(ExpiredLinkError);
  });

  it('throws ChannelMismatchError when link.channel != viaChannel', async () => {
    txQueue.push(liveLinkRow({ channel: 'sms' }));
    await expect(approveViaCallback({
      approvalLinkId: 'link-1', chatHandle: 'h', viaChannel: 'telegram',
      audit: { providerEventId: '1', ipAddress: null, telegramUpdateId: 1 },
    })).rejects.toBeInstanceOf(ChannelMismatchError);
  });
});

describe('regenerateViaCallback', () => {
  beforeEach(() => { txQueue.length = 0; txCalls.length = 0; });

  it('marks response superseded and enqueues generate_response outbox', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(pendingResponseRow());
    txQueue.push([]); // consumeLink
    txQueue.push([]); // revokeSiblings
    txQueue.push([]); // UPDATE responses superseded
    txQueue.push([]); // INSERT outbox
    txQueue.push([{ account_id: 'acc-1' }]); // resolveAccountIdFromBusiness
    txQueue.push([]); // audit
    await regenerateViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123',
      viaChannel: 'telegram',
      audit: { providerEventId: '7', ipAddress: null, telegramUpdateId: 7 },
    });
    const outboxCall = txCalls.find((c) => c.sql.includes('job_outbox') && c.sql.includes('generate_response'));
    expect(outboxCall).toBeDefined();
  });
});
