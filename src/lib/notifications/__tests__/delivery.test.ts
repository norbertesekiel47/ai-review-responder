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

import { insertFailedDelivery } from '../delivery';

describe('insertFailedDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    mockSql.mockClear();
  });

  it('inserts a notification_deliveries row with failed_at, failure_reason, null external_message_id', async () => {
    await insertFailedDelivery('biz-1', 'resp-1', 'sms', '+15551234567', 'send_error:test');

    expect(mockSql).toHaveBeenCalledTimes(1);
    const call = sqlCalls[0]!;
    expect(call.template).toMatch(/INSERT INTO notification_deliveries/);
    expect(call.template).toMatch(/failed_at/);
    expect(call.template).toMatch(/failure_reason/);
    // Verify the bound values include the right business_id, response_id, channel, recipient, failure_reason
    expect(call.values).toContain('biz-1');
    expect(call.values).toContain('resp-1');
    expect(call.values).toContain('sms');
    expect(call.values).toContain('+15551234567');
    expect(call.values).toContain('send_error:test');
  });

  it('defaults template to approval_request when not provided', async () => {
    await insertFailedDelivery('biz-1', 'resp-1', 'sms', '+15551234567', 'cap_hit');
    const call = sqlCalls[0]!;
    expect(call.values).toContain('approval_request');
  });

  it('accepts custom template override', async () => {
    await insertFailedDelivery('biz-1', 'resp-1', 'email', 'owner@example.com', 'bounced', 'weekly_value_report');
    const call = sqlCalls[0]!;
    expect(call.values).toContain('weekly_value_report');
    expect(call.values).not.toContain('approval_request');
  });

  it('accepts null response_id for admin-directed deliveries', async () => {
    await insertFailedDelivery('biz-1', null, 'email', 'admin@example.com', 'bounced', 'admin_manual_post');
    const call = sqlCalls[0]!;
    expect(call.values).toContain(null);
  });
});
