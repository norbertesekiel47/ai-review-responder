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
  claimAutonomySuspendedNoticeDelivery,
  finalizeDeliverySent,
  failDelivery,
} from '../delivery';

describe('claimAutonomySuspendedNoticeDelivery', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlQueue.length = 0;
    mockSql.mockClear();
  });

  it('self-reaps stale pending claims, then claims with the migration-076 predicate and NULL response_id', async () => {
    sqlQueue.push([]);
    sqlQueue.push([{ id: 'delivery-1' }]);

    const id = await claimAutonomySuspendedNoticeDelivery(mockSql, {
      accountId: 'acct-1',
      businessId: 'biz-1',
      entityId: 'event-1',
      channel: 'email',
      recipient: 'owner@example.com',
    });

    expect(id).toEqual({ kind: 'claimed', deliveryId: expect.any(String) });
    expect(sqlCalls).toHaveLength(2);
    const reap = sqlCalls[0]!;
    expect(reap.template).toContain("template = 'autonomy_suspended_notice'");
    expect(reap.template).toContain('entity_id =');
    expect(reap.template).toContain('sent_at IS NULL');
    expect(reap.template).toContain('failed_at IS NULL');
    expect(reap.template).toContain("created_at < NOW() - INTERVAL '15 minutes'");
    // The unique key is entity/channel/recipient, not business_id. Scope the
    // reap to the account so a primary-location change cannot leave the old
    // business row permanently blocking this event's retry.
    expect(reap.template).toContain('account_id =');
    expect(reap.template).not.toContain('business_id =');
    expect(reap.values).toEqual(['event-1', 'acct-1', 'email', 'owner@example.com']);

    const insert = sqlCalls[1]!;
    expect(insert.template).toContain('response_id');
    expect(insert.template).toContain('entity_id');
    expect(insert.template).toContain(
      "ON CONFLICT (entity_id, channel, recipient)\n      WHERE entity_id IS NOT NULL AND template = 'autonomy_suspended_notice'",
    );
    expect(insert.values).toContain(null);
  });

  it('distinguishes a sent existing row as settled', async () => {
    sqlQueue.push([]);
    sqlQueue.push([]);
    sqlQueue.push([{ id: 'delivery-sent', sent_at: new Date(), failed_at: null }]);

    await expect(claimAutonomySuspendedNoticeDelivery(mockSql, {
      accountId: 'acct-1', businessId: 'biz-1', entityId: 'event-1',
      channel: 'telegram', recipient: '123',
    })).resolves.toEqual({ kind: 'settled', deliveryId: 'delivery-sent' });
  });

  it('distinguishes a terminally failed existing row as settled', async () => {
    sqlQueue.push([], [], [{ id: 'delivery-failed', sent_at: null, failed_at: new Date() }]);
    await expect(claimAutonomySuspendedNoticeDelivery(mockSql, {
      accountId: 'acct-1', businessId: 'biz-1', entityId: 'event-1',
      channel: 'email', recipient: 'owner@example.com',
    })).resolves.toEqual({ kind: 'settled', deliveryId: 'delivery-failed' });
  });

  it('distinguishes a live unfinalized existing row as pending', async () => {
    sqlQueue.push([], [], [{ id: 'delivery-pending', sent_at: null, failed_at: null }]);
    await expect(claimAutonomySuspendedNoticeDelivery(mockSql, {
      accountId: 'acct-1', businessId: 'biz-2', entityId: 'event-1',
      channel: 'email', recipient: 'owner@example.com',
    })).resolves.toEqual({ kind: 'pending', deliveryId: 'delivery-pending' });
  });
});

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
    sqlQueue.push([]);              // self-reap DELETE
    sqlQueue.push([{ id: 'ignored' }]); // claim INSERT
    await claim();

    const call = sqlCalls[1]!; // call 0 is the self-reap DELETE
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
    sqlQueue.push([]);           // self-reap DELETE
    sqlQueue.push([{ id: 'row' }]); // claim INSERT
    const id = await claim();
    expect(typeof id).toBe('string');
  });

  it('returns null when a fresh live claim already exists (ON CONFLICT DO NOTHING)', async () => {
    sqlQueue.push([]); // self-reap DELETE (fresh claim survives — see guard test below)
    sqlQueue.push([]); // claim INSERT hits the conflict
    const id = await claim();
    expect(id).toBeNull();
  });

  // ── Self-reap of stale unfinalized claims (known follow-up #3b) ─────────
  // The reap DELETE runs BEFORE the claim INSERT so a dispatcher that crashed
  // between claim and finalize/release can't dedup-block this veto-critical
  // notice forever. The guards make it surgical: only rows that are neither
  // sent nor terminally failed AND older than 15 minutes are removed.

  it('self-reaps stale unfinalized claims BEFORE claiming, scoped to the claim key + staleness guards', async () => {
    sqlQueue.push([]);           // self-reap DELETE (reaped the orphan)
    sqlQueue.push([{ id: 'row' }]); // claim INSERT re-acquires
    const id = await claim();
    expect(typeof id).toBe('string'); // reaped orphan ⇒ re-claimable

    const reap = sqlCalls[0]!;
    const flatReap = reap.template.replace(/\s+/g, ' ');
    expect(flatReap).toMatch(/^\s*DELETE FROM notification_deliveries/);
    expect(flatReap).toContain("template = 'pending_post_notice'");
    // Finalized (sent) and terminally-failed rows are NEVER reaped.
    expect(flatReap).toContain('sent_at IS NULL');
    expect(flatReap).toContain('failed_at IS NULL');
    // Fresh claims (an in-flight concurrent send) are NEVER reaped.
    expect(flatReap).toContain("created_at < NOW() - INTERVAL '15 minutes'");
    // Scoped to exactly this claim key (+ tenant scope).
    expect(reap.values).toEqual(['resp-1', 'biz-1', 'email', 'owner@example.com']);

    const insert = sqlCalls[1]!;
    expect(insert.template).toMatch(/INSERT INTO notification_deliveries/);
  });
});

// ── Reaped-row no-ops (finalize-after-reap) ────────────────────────────────
// A >15-minute hung send can be reaped by claimPendingPostNoticeDelivery's
// self-reap and re-claimed; the original's finalize/fail then UPDATEs a
// deleted row. That must WARN (ids-only) and NOT throw — the provider send
// succeeded, so throwing would retry and double-send.

describe('finalizeDeliverySent / failDelivery reaped-row handling', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlQueue.length = 0;
    mockSql.mockClear();
  });

  const warnLogger = () => ({ warn: vi.fn() });

  it('finalizeDeliverySent warns and does not throw when the claim row was reaped (0 rows)', async () => {
    sqlQueue.push(Object.assign([], { count: 0 }));
    const logger = warnLogger();

    await expect(
      finalizeDeliverySent(mockSql, 'del-1', 'msg-ext-1', logger),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0]![0] as string;
    expect(message).toContain('del-1');
    expect(message).toContain('msg-ext-1');
  });

  it('finalizeDeliverySent stays silent when the row was updated', async () => {
    sqlQueue.push(Object.assign([], { count: 1 }));
    const logger = warnLogger();

    await finalizeDeliverySent(mockSql, 'del-1', 'msg-ext-1', logger);

    expect(logger.warn).not.toHaveBeenCalled();
    const call = sqlCalls[0]!;
    expect(call.template).toMatch(/UPDATE notification_deliveries/);
    expect(call.values).toContain('del-1');
    expect(call.values).toContain('msg-ext-1');
  });

  it('failDelivery warns and does not throw when the claim row was reaped (0 rows)', async () => {
    sqlQueue.push(Object.assign([], { count: 0 }));
    const logger = warnLogger();

    await expect(
      failDelivery(mockSql, 'del-2', 'send_error:test', logger),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0]![0] as string;
    expect(message).toContain('del-2');
    // ids-only: the failure reason is not echoed into the warn line.
    expect(message).not.toContain('send_error:test');
  });

  it('failDelivery stays silent when the row was updated', async () => {
    sqlQueue.push(Object.assign([], { count: 1 }));
    const logger = warnLogger();

    await failDelivery(mockSql, 'del-2', 'send_error:test', logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
