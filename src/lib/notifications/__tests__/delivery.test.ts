import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlCalls, sqlQueue, mockSql } = vi.hoisted(() => {
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const sqlQueue: unknown[] = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ template: strings.join('?'), values });
    return Promise.resolve(sqlQueue.length > 0 ? sqlQueue.shift() : []);
  });
  return { sqlCalls, sqlQueue, mockSql };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

import {
  recordNotificationDelivery,
  insertFailedDelivery,
  claimEscalationNoticeDelivery,
  claimPendingPostNoticeDelivery,
} from '../delivery';

describe('recordNotificationDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    mockSql.mockClear();
  });

  it('inserts a notification_deliveries row with account_id, sent_at, external_message_id', async () => {
    await recordNotificationDelivery(mockSql, {
      accountId: 'acct-1',
      businessId: 'biz-1',
      responseId: 'resp-1',
      channel: 'email',
      recipient: 'owner@example.com',
      template: 'approval_request',
      externalMessageId: 'msg-123',
    });

    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = sqlCalls[0]!;
    expect(call.template).toMatch(/INSERT INTO notification_deliveries/);
    expect(call.template).toMatch(/account_id/);
    expect(call.template).toMatch(/sent_at/);
    expect(call.template).toMatch(/external_message_id/);
    expect(call.values).toContain('acct-1');
    expect(call.values).toContain('biz-1');
    expect(call.values).toContain('resp-1');
    expect(call.values).toContain('email');
    expect(call.values).toContain('owner@example.com');
    expect(call.values).toContain('approval_request');
    expect(call.values).toContain('msg-123');
  });

  it('includes account_id in the INSERT column list', async () => {
    await recordNotificationDelivery(mockSql, {
      accountId: 'acct-42',
      businessId: 'biz-1',
      channel: 'telegram',
      recipient: '@testbot',
      template: 'weekly_value_report',
      externalMessageId: 'ext-999',
    });

    const call = sqlCalls[0]!;
    // Column list must include account_id
    expect(call.template).toMatch(/account_id/);
    expect(call.values).toContain('acct-42');
  });

  it('accepts null responseId for owner email delivery paths', async () => {
    await recordNotificationDelivery(mockSql, {
      accountId: 'acct-1',
      businessId: 'biz-1',
      responseId: null,
      channel: 'email',
      recipient: 'owner@example.com',
      template: 'owner_nudge',
      externalMessageId: 'msg-456',
    });

    const call = sqlCalls[0]!;
    expect(call.values).toContain(null);
    expect(call.values).toContain('owner_nudge');
  });
});

describe('insertFailedDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    mockSql.mockClear();
  });

  it('inserts a notification_deliveries row with account_id, failed_at, failure_reason', async () => {
    await insertFailedDelivery(mockSql, 'acct-1', 'biz-1', 'resp-1', 'telegram', '@ownerbot', 'send_error:test');

    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = sqlCalls[0]!;
    expect(call.template).toMatch(/INSERT INTO notification_deliveries/);
    expect(call.template).toMatch(/account_id/);
    expect(call.template).toMatch(/failed_at/);
    expect(call.template).toMatch(/failure_reason/);
    expect(call.values).toContain('acct-1');
    expect(call.values).toContain('biz-1');
    expect(call.values).toContain('resp-1');
    expect(call.values).toContain('telegram');
    expect(call.values).toContain('@ownerbot');
    expect(call.values).toContain('send_error:test');
  });

  it('defaults template to approval_request when not provided', async () => {
    await insertFailedDelivery(mockSql, 'acct-1', 'biz-1', 'resp-1', 'telegram', '@ownerbot', 'cap_hit');
    const call = sqlCalls[0]!;
    expect(call.values).toContain('approval_request');
    expect(call.values).toContain('acct-1');
  });

  it('accepts custom template override', async () => {
    await insertFailedDelivery(mockSql, 'acct-1', 'biz-1', 'resp-1', 'email', 'owner@example.com', 'bounced', 'weekly_value_report');
    const call = sqlCalls[0]!;
    expect(call.values).toContain('weekly_value_report');
    expect(call.values).not.toContain('approval_request');
    expect(call.values).toContain('acct-1');
  });

  it('accepts null response_id for admin-directed deliveries', async () => {
    await insertFailedDelivery(mockSql, 'acct-1', 'biz-1', null, 'email', 'admin@example.com', 'bounced', 'admin_exception');
    const call = sqlCalls[0]!;
    expect(call.values).toContain(null);
    expect(call.values).toContain('admin_exception');
    expect(call.values).toContain('acct-1');
  });

  it('includes account_id in the INSERT column list for failed delivery', async () => {
    await insertFailedDelivery(mockSql, 'acct-99', 'biz-1', 'resp-1', 'telegram', '@ownerbot', 'cap_hit');
    const call = sqlCalls[0]!;
    expect(call.template).toMatch(/account_id/);
    expect(call.values).toContain('acct-99');
  });
});

describe('claimEscalationNoticeDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlQueue.length = 0;
    mockSql.mockClear();
  });

  const claim = () => claimEscalationNoticeDelivery(mockSql, {
    accountId: 'acct-1',
    businessId: 'biz-1',
    escalationId: 'esc-1',
    channel: 'email',
    recipient: 'owner@example.com',
  });

  it('INSERTs with the escalation_id column and the migration-073 ON CONFLICT predicate byte-for-byte', async () => {
    sqlQueue.push([{ id: 'ignored' }]);
    await claim();

    const call = sqlCalls[0]!;
    const flatTemplate = call.template.replace(/\s+/g, ' ');
    expect(flatTemplate).toMatch(/INSERT INTO notification_deliveries/);
    // escalation_id in the column list; NO response_id (left NULL).
    expect(flatTemplate).toContain('escalation_id');
    expect(flatTemplate).not.toContain('response_id');
    // ON CONFLICT must match notification_deliveries_escalation_notice_claim
    // (migration 073) BYTE-FOR-BYTE, template literal included.
    expect(flatTemplate).toContain(
      "ON CONFLICT (escalation_id, channel, recipient) WHERE escalation_id IS NOT NULL AND template = 'escalation_notice' DO NOTHING",
    );
    expect(call.values).toContain('acct-1');
    expect(call.values).toContain('biz-1');
    expect(call.values).toContain('esc-1');
    expect(call.values).toContain('email');
    expect(call.values).toContain('owner@example.com');
    // 'escalation_notice' stays a literal in the template, never a bound param.
    expect(call.values).not.toContain('escalation_notice');
  });

  it('returns the new delivery id when the claim wins', async () => {
    sqlQueue.push([{ id: 'row' }]);
    const id = await claim();
    expect(typeof id).toBe('string');
  });

  it('returns null when a live claim already exists (ON CONFLICT DO NOTHING)', async () => {
    sqlQueue.push([]);
    const id = await claim();
    expect(id).toBeNull();
  });
});

describe('claimPendingPostNoticeDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlQueue.length = 0;
    mockSql.mockClear();
  });

  const claim = () => claimPendingPostNoticeDelivery(mockSql, {
    accountId: 'acct-1',
    businessId: 'biz-1',
    responseId: 'resp-1',
    channel: 'email',
    recipient: 'owner@example.com',
  });

  it('INSERTs with the response_id column and the migration-074 ON CONFLICT predicate byte-for-byte', async () => {
    sqlQueue.push([{ id: 'ignored' }]);
    await claim();

    const call = sqlCalls[0]!;
    const flatTemplate = call.template.replace(/\s+/g, ' ');
    expect(flatTemplate).toMatch(/INSERT INTO notification_deliveries/);
    expect(flatTemplate).toContain('response_id');
    // ON CONFLICT must match notification_deliveries_pending_post_notice_claim
    // (migration 074) BYTE-FOR-BYTE, template literal included.
    expect(flatTemplate).toContain(
      "ON CONFLICT (response_id, channel, recipient) WHERE response_id IS NOT NULL AND template = 'pending_post_notice' DO NOTHING",
    );
    expect(call.values).toContain('acct-1');
    expect(call.values).toContain('biz-1');
    expect(call.values).toContain('resp-1');
    expect(call.values).toContain('email');
    expect(call.values).toContain('owner@example.com');
    // 'pending_post_notice' stays a literal in the template, never a bound param.
    expect(call.values).not.toContain('pending_post_notice');
  });

  it('returns the new delivery id when the claim wins', async () => {
    sqlQueue.push([{ id: 'row' }]);
    const id = await claim();
    expect(typeof id).toBe('string');
  });

  it('returns null when a live claim already exists (ON CONFLICT DO NOTHING)', async () => {
    sqlQueue.push([]);
    const id = await claim();
    expect(id).toBeNull();
  });
});
