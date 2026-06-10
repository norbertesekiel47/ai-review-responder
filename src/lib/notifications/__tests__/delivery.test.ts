import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlCalls, mockSql } = vi.hoisted(() => {
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const mockSql: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ template: strings.join('?'), values });
    return Promise.resolve([]);
  });
  return { sqlCalls, mockSql };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

import { recordNotificationDelivery, insertFailedDelivery } from '../delivery';

describe('recordNotificationDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    mockSql.mockClear();
  });

  it('inserts a notification_deliveries row with account_id, sent_at, external_message_id', async () => {
    await recordNotificationDelivery({
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
    await recordNotificationDelivery({
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
    await recordNotificationDelivery({
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
    await insertFailedDelivery('acct-1', 'biz-1', 'resp-1', 'telegram', '@ownerbot', 'send_error:test');

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
    await insertFailedDelivery('acct-1', 'biz-1', 'resp-1', 'telegram', '@ownerbot', 'cap_hit');
    const call = sqlCalls[0]!;
    expect(call.values).toContain('approval_request');
    expect(call.values).toContain('acct-1');
  });

  it('accepts custom template override', async () => {
    await insertFailedDelivery('acct-1', 'biz-1', 'resp-1', 'email', 'owner@example.com', 'bounced', 'weekly_value_report');
    const call = sqlCalls[0]!;
    expect(call.values).toContain('weekly_value_report');
    expect(call.values).not.toContain('approval_request');
    expect(call.values).toContain('acct-1');
  });

  it('accepts null response_id for admin-directed deliveries', async () => {
    await insertFailedDelivery('acct-1', 'biz-1', null, 'email', 'admin@example.com', 'bounced', 'admin_exception');
    const call = sqlCalls[0]!;
    expect(call.values).toContain(null);
    expect(call.values).toContain('admin_exception');
    expect(call.values).toContain('acct-1');
  });

  it('includes account_id in the INSERT column list for failed delivery', async () => {
    await insertFailedDelivery('acct-99', 'biz-1', 'resp-1', 'telegram', '@ownerbot', 'cap_hit');
    const call = sqlCalls[0]!;
    expect(call.template).toMatch(/account_id/);
    expect(call.values).toContain('acct-99');
  });
});
