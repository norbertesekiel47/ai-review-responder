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
  ArchivedLocationError,
  ResponseNotPendingError,
} from '../errors';
import { SubscriptionReadOnlyError } from '@/lib/shared/writable-subscription';

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
  return [{ status: 'pending_approval', original_draft_text: 'draft', response_text: 'Callback approved draft', version: 1, review_id: 'rev-1' }];
}

function activeAccountRow() {
  return [{ subscription_status: 'active', past_due_at: null, flags: {} }];
}

function notArchivedBusinessRow() {
  return [{ archived_at: null }];
}

function archivedBusinessRow() {
  return [{ archived_at: new Date('2026-06-01T00:00:00Z') }];
}

function readOnlyAccountRow() {
  return [{ subscription_status: 'past_due', past_due_at: '2020-01-01T00:00:00.000Z', flags: {} }];
}

function offboardingAccountRow() {
  return [{
    id: 'acc-1',
    subscription_status: 'active',
    past_due_at: null,
    flags: {},
    offboarding_id: 'offboarding-1',
    offboarding_account_id: 'acc-1',
    offboarding_mode: 'delete_data',
    offboarding_status: 'pending',
    offboarding_failed_step: null,
    offboarding_access_ends_at: null,
    offboarding_teardown_started_at: null,
    offboarding_purge_after: null,
    offboarding_purge_started_at: null,
    offboarding_purge_cancelled_at: null,
  }];
}

function expectNoCallbackMutation() {
  expect(txCalls.some((call) => call.sql.includes('UPDATE approval_links SET consumed_at'))).toBe(false);
  expect(txCalls.some((call) => call.sql.includes('UPDATE responses'))).toBe(false);
  expect(txCalls.some((call) => call.sql.includes('job_outbox'))).toBe(false);
  expect(txCalls.some((call) => call.sql.includes('approval_audit_log'))).toBe(false);
}

describe('approveViaCallback', () => {
  beforeEach(() => { txQueue.length = 0; txCalls.length = 0; });

  it('happy path: consumes link, revokes siblings, approves response, inserts publish_response + audit', async () => {
    txQueue.push(liveLinkRow());             // SELECT approval_links FOR UPDATE
    txQueue.push(activeAccountRow());        // assertWritableSubscriptionForBusiness
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
    const updateCall = txCalls.find((c) => c.sql.includes("SET status = 'approved'"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain('approval_method');
    expect(updateCall!.params).toContain('owner');
    const auditCall = txCalls.find((c) => c.sql.includes('approval_audit_log'));
    expect(auditCall).toBeDefined();
    expect(auditCall!.params).toContain('Callback approved draft');
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

  it('blocks read-only accounts before consuming links or enqueueing publish work', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(readOnlyAccountRow());

    await expect(approveViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123456789',
      viaChannel: 'telegram',
      audit: { providerEventId: '999', ipAddress: '1.2.3.4', telegramUpdateId: 999 },
    })).rejects.toBeInstanceOf(SubscriptionReadOnlyError);

    expectNoCallbackMutation();
  });

  it('blocks offboarding accounts before consuming links or enqueueing publish work', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(offboardingAccountRow());

    await expect(approveViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123456789',
      viaChannel: 'telegram',
      audit: { providerEventId: '999', ipAddress: '1.2.3.4', telegramUpdateId: 999 },
    })).rejects.toMatchObject({
      name: 'SubscriptionReadOnlyError',
      message: 'account_offboarding_blocked',
      status: 403,
    });

    expectNoCallbackMutation();
  });

  it('blocks deleted business/account rows before consuming links or enqueueing publish work', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push([]);

    await expect(approveViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123456789',
      viaChannel: 'telegram',
      audit: { providerEventId: '999', ipAddress: '1.2.3.4', telegramUpdateId: 999 },
    })).rejects.toMatchObject({
      name: 'SubscriptionReadOnlyError',
      message: 'no_business',
      status: 403,
    });

    expectNoCallbackMutation();
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
    txQueue.push(activeAccountRow());
    txQueue.push(pendingResponseRow());
    txQueue.push([]); // consumeLink
    txQueue.push(notArchivedBusinessRow()); // assertLocationNotArchived (after claim)
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
    const outboxCall = txCalls.find((c) => c.sql.includes('job_outbox') && c.params.includes('generate_response'));
    expect(outboxCall).toBeDefined();
    const payload = outboxCall!.params.find(
      (param): param is Record<string, unknown> =>
        !!param && typeof param === 'object' && !Array.isArray(param) && 'review_id' in param,
    );
    expect(payload).toMatchObject({
      review_id: 'rev-1',
      business_id: 'biz-1',
      version: 2,
      origin_lane: 'regenerate',
      correlation_id: 'upstream-corr-id',
    });
  });

  it('blocks read-only accounts before consuming links or enqueueing regeneration work', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(readOnlyAccountRow());

    await expect(regenerateViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123',
      viaChannel: 'telegram',
      audit: { providerEventId: '7', ipAddress: null, telegramUpdateId: 7 },
    })).rejects.toBeInstanceOf(SubscriptionReadOnlyError);

    expectNoCallbackMutation();
  });

  it('blocks offboarding accounts before consuming links or enqueueing regeneration work', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(offboardingAccountRow());

    await expect(regenerateViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123',
      viaChannel: 'telegram',
      audit: { providerEventId: '7', ipAddress: null, telegramUpdateId: 7 },
    })).rejects.toMatchObject({
      name: 'SubscriptionReadOnlyError',
      message: 'account_offboarding_blocked',
      status: 403,
    });

    expectNoCallbackMutation();
  });

  it('blocks deleted business/account rows before consuming links or enqueueing regeneration work', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push([]);

    await expect(regenerateViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123',
      viaChannel: 'telegram',
      audit: { providerEventId: '7', ipAddress: null, telegramUpdateId: 7 },
    })).rejects.toMatchObject({
      name: 'SubscriptionReadOnlyError',
      message: 'no_business',
      status: 403,
    });

    expectNoCallbackMutation();
  });

  // Archived-location gate (regenerate only — PR B extends to all approval
  // actions): the guard runs AFTER the claim, inside the same sql.begin, so
  // the throw rolls the whole transaction back — the consume is never
  // committed, the draft is never superseded, nothing is enqueued. The
  // mocked tx cannot model the rollback of the consume statement itself, so
  // we assert the throw plus the absence of every statement issued after
  // the guard (supersede, outbox, audit).
  it('rejects regenerate for an archived location and issues no post-guard mutations', async () => {
    txQueue.push(liveLinkRow());
    txQueue.push(activeAccountRow());
    txQueue.push(pendingResponseRow()); // lockPendingResponse (claim)
    txQueue.push([]);                   // consumeLink (claim — rolled back with the tx)
    txQueue.push(archivedBusinessRow()); // assertLocationNotArchived → throws

    await expect(regenerateViaCallback({
      approvalLinkId: 'link-1',
      chatHandle: '123',
      viaChannel: 'telegram',
      audit: { providerEventId: '7', ipAddress: null, telegramUpdateId: 7 },
    })).rejects.toBeInstanceOf(ArchivedLocationError);

    expect(txCalls.some((call) => call.sql.includes("'superseded'"))).toBe(false);
    expect(txCalls.some((call) => call.sql.includes('job_outbox'))).toBe(false);
    expect(txCalls.some((call) => call.sql.includes('approval_audit_log'))).toBe(false);
  });

  // The callback ingress classifies permanent errors via instanceof
  // ResponseNotPendingError — the archived rejection must inherit that so
  // Telegram/WhatsApp treat it as terminal (no reclaim retry loop).
  it('archived rejection is classified as a permanent ResponseNotPendingError', () => {
    expect(new ArchivedLocationError()).toBeInstanceOf(ResponseNotPendingError);
  });
});
