// src/lib/channels/__tests__/disable-enrollment.test.ts
//
// Single owner of the mobile-channel disconnect contract, parameterized over
// channel: the disableChannelEnrollment cascade (org-default + override
// UPDATEs, per-row audit) and the disconnectChannel orchestration (own tx,
// post-commit cache invalidation, not_found mapping).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { WriteAccountAuditLogInput } from '@/lib/audit/log';

const { sqlQueue, callOrder, mockSql } = vi.hoisted(() => {
  const queue: unknown[] = [];
  const order: string[] = [];
  const tagged = async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const next = queue.shift();
    return Array.isArray(next) ? next : [];
  };
  const sql = Object.assign(tagged, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(tagged);
      order.push('commit');
      return result;
    },
  });
  return { sqlQueue: queue, callOrder: order, mockSql: sql };
});
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));

const mockWriteAccountAuditLog = vi.fn(async (_tx: unknown, _input: WriteAccountAuditLogInput) => {});
vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: (tx: unknown, input: WriteAccountAuditLogInput) =>
    mockWriteAccountAuditLog(tx, input),
}));

const mockSafeInvalidateChannelCache = vi.fn(async (_accountId: string, _context: string) => {
  callOrder.push('invalidate');
});
vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: (accountId: string, context: string) =>
    mockSafeInvalidateChannelCache(accountId, context),
}));

import {
  disableChannelEnrollment,
  disconnectChannel,
  type DisableableChannel,
} from '../disable-enrollment';

const CHANNELS: DisableableChannel[] = ['telegram', 'whatsapp'];

/** Tagged-template tx mock: returns queued result arrays in call order, records SQL text + bound values. */
function makeTx(results: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(results.shift() ?? []);
  };
  return { tx: tx as unknown as postgres.TransactionSql, calls };
}

beforeEach(() => {
  sqlQueue.length = 0;
  callOrder.length = 0;
  mockWriteAccountAuditLog.mockClear();
  mockSafeInvalidateChannelCache.mockClear();
});

describe.each(CHANNELS)('disableChannelEnrollment (%s)', (channel) => {
  it('returns ok + audits the org-default when only the org-default UPDATE affects rows', async () => {
    const { tx } = makeTx([[{ id: 'org-1' }], []]);
    const result = await disableChannelEnrollment(tx, { accountId: 'acct-1', channel });
    expect(result).toEqual({ kind: 'ok' });

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const audit = mockWriteAccountAuditLog.mock.calls[0]![1];
    expect(audit.eventType).toBe('channel_disabled');
    expect(audit.locationId).toBeNull();
    expect(audit.payload).toEqual({ channel });
  });

  it('returns not_found + writes no audit only when BOTH UPDATEs affect 0 rows', async () => {
    const { tx } = makeTx([[], []]);
    const result = await disableChannelEnrollment(tx, { accountId: 'acct-1', channel });
    expect(result).toEqual({ kind: 'not_found' });
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('cascades + audits overrides even when the org-default is already disabled (0 org rows)', async () => {
    const { tx } = makeTx([
      [],
      [{ id: 'ov-1', location_id: 'loc-1' }, { id: 'ov-2', location_id: 'loc-2' }],
    ]);
    const result = await disableChannelEnrollment(tx, { accountId: 'acct-1', channel });
    expect(result).toEqual({ kind: 'ok' }); // something changed → NOT not_found

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(2);
    const inputs = mockWriteAccountAuditLog.mock.calls.map((call) => call[1]);
    expect(inputs.map((input) => input.eventType)).toEqual([
      'channel_override_disabled',
      'channel_override_disabled',
    ]);
    expect(inputs.map((input) => input.locationId)).toEqual(['loc-1', 'loc-2']);
  });

  it('full cascade: audits the org-default AND each override row, with actor attribution', async () => {
    const { tx } = makeTx([
      [{ id: 'org-1' }],
      [{ id: 'ov-1', location_id: 'loc-1' }, { id: 'ov-2', location_id: 'loc-2' }],
    ]);
    const result = await disableChannelEnrollment(tx, {
      accountId: 'acct-1',
      channel,
      actorUserId: 'user-9',
    });
    expect(result).toEqual({ kind: 'ok' });

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(3);
    const inputs = mockWriteAccountAuditLog.mock.calls.map((call) => call[1]);

    const orgAudit = inputs.find((input) => input.eventType === 'channel_disabled')!;
    expect(orgAudit.locationId).toBeNull();

    const overrideAudits = inputs.filter((input) => input.eventType === 'channel_override_disabled');
    expect(overrideAudits).toHaveLength(2);
    expect(overrideAudits.map((input) => input.locationId)).toEqual(['loc-1', 'loc-2']);
    expect(overrideAudits.map((input) => input.entityId)).toEqual(['ov-1', 'ov-2']);
    expect(overrideAudits[0]!.entityType).toBe('channel_enrollment');
    expect(overrideAudits[0]!.payload).toEqual({ channel });

    for (const input of inputs) {
      expect(input.actorUserId).toBe('user-9');
    }
  });

  it('defaults actorUserId to null when omitted', async () => {
    const { tx } = makeTx([[{ id: 'org-1' }], []]);
    await disableChannelEnrollment(tx, { accountId: 'acct-1', channel });
    expect(mockWriteAccountAuditLog.mock.calls[0]![1].actorUserId).toBeNull();
  });

  it('ordering pin: call 0 is the org-default UPDATE, call 1 the override cascade; SQL + bound channel', async () => {
    const { tx, calls } = makeTx([[{ id: 'org-1' }], [{ id: 'ov-1', location_id: 'loc-1' }]]);
    await disableChannelEnrollment(tx, { accountId: 'acct-1', channel });

    const orgUpdate = calls[0]!;
    expect(orgUpdate.text).toContain('UPDATE channel_enrollments');
    expect(orgUpdate.text).toContain("status = 'disabled'");
    expect(orgUpdate.text).toContain('handle = NULL');
    expect(orgUpdate.text).toContain('account_id =');
    expect(orgUpdate.text).toContain('location_id IS NULL');
    expect(orgUpdate.text).toContain("status = 'verified'");
    expect(orgUpdate.text).toContain('archived_at IS NULL');
    expect(orgUpdate.text).not.toMatch(/business_id = /);
    // Channel is a parameter in the shared cascade — assert the bound value.
    expect(orgUpdate.values).toContain(channel);
    expect(orgUpdate.values).toContain('acct-1');

    const overrideUpdate = calls[1]!;
    expect(overrideUpdate.text).toContain('UPDATE channel_enrollments');
    expect(overrideUpdate.text).toContain('account_id =');
    expect(overrideUpdate.text).toContain('location_id IS NOT NULL');
    // The cascade must catch pending/pending_verification clones too — the
    // only excluded statuses are already-disabled (and archived rows).
    expect(overrideUpdate.text).toContain("status != 'disabled'");
    expect(overrideUpdate.text).not.toContain("status = 'verified'");
    expect(overrideUpdate.text).toContain('archived_at IS NULL');
    expect(overrideUpdate.text).toContain('RETURNING id, location_id');
    expect(overrideUpdate.values).toContain(channel);
    expect(overrideUpdate.values).toContain('acct-1');
  });
});

describe.each(CHANNELS)('disconnectChannel (%s)', (channel) => {
  it.each(['dashboard', 'admin'] as const)(
    'ok: runs the cascade in its own tx, invalidates the cache AFTER commit with the %s label',
    async (surface) => {
      sqlQueue.push([{ id: 'org-1' }]); // org-default UPDATE
      sqlQueue.push([]); // override cascade UPDATE

      const result = await disconnectChannel({
        channel,
        accountId: 'acct-1',
        actorUserId: 'user-9',
        surface,
      });
      expect(result).toEqual({ kind: 'ok' });

      expect(mockSafeInvalidateChannelCache).toHaveBeenCalledTimes(1);
      expect(mockSafeInvalidateChannelCache).toHaveBeenCalledWith(
        'acct-1',
        `${surface}.${channel}.disable`,
      );
      // Commit-then-invalidate: the begin callback must fully resolve first.
      expect(callOrder).toEqual(['commit', 'invalidate']);
    },
  );

  it('not_found: nothing changed → cache NOT invalidated', async () => {
    sqlQueue.push([]); // org-default UPDATE
    sqlQueue.push([]); // override cascade UPDATE

    const result = await disconnectChannel({
      channel,
      accountId: 'acct-1',
      actorUserId: null,
      surface: 'dashboard',
    });
    expect(result).toEqual({ kind: 'not_found' });
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('audit write failure inside the tx propagates and the cache is NOT invalidated', async () => {
    sqlQueue.push([{ id: 'org-1' }]);
    sqlQueue.push([]);
    mockWriteAccountAuditLog.mockRejectedValueOnce(new Error('audit DB error'));

    await expect(
      disconnectChannel({ channel, accountId: 'acct-1', actorUserId: 'user-9', surface: 'admin' }),
    ).rejects.toThrow('audit DB error');
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });
});
