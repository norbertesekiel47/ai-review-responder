// src/lib/channels/__tests__/override.test.ts
//
// Contract tests for the per-location override module: typed result unions,
// in-tx pre-checks (eligibility, location ownership, verified org-default,
// duplicate), revive-vs-insert, in-tx audit, 23505 race mapping, and the
// commit-then-invalidate ordering.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { WriteAccountAuditLogInput } from '@/lib/audit/log';

const { sqlQueue, sqlCalls, callOrder, mockSql } = vi.hoisted(() => {
  const queue: unknown[] = [];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const order: string[] = [];
  const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    const next = queue.shift();
    if (next && typeof next === 'object' && '__throw' in (next as object)) {
      throw (next as { __throw: unknown }).__throw;
    }
    return Array.isArray(next) ? next : [];
  };
  const sql = Object.assign(tagged, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(tagged);
      order.push('commit');
      return result;
    },
  });
  return { sqlQueue: queue, sqlCalls: calls, callOrder: order, mockSql: sql };
});
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));

const mockWriteAccountAuditLog = vi.fn(
  async (_tx: unknown, _input: WriteAccountAuditLogInput) => {},
);
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

import { createOrReviveOverride, removeOverride } from '../override';

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const LOCATION_ID = 'b1111111-0000-4000-8000-000000000001';
const ORG_ENROLLMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const OVERRIDE_ID = 'e0000000-0000-4000-8000-000000000002';

const INPUT = {
  accountId: ACCOUNT_ID,
  actorUserId: 'user-1',
  locationId: LOCATION_ID,
  channel: 'telegram' as const,
};

const VERIFIED_AT = new Date('2025-01-01');
const ORG_DEFAULT_ROW = {
  id: ORG_ENROLLMENT_ID,
  handle: '@org_bot',
  status: 'verified',
  verified_at: VERIFIED_AT,
};

/** Queue the in-tx pre-check results up to (not including) the INSERT/UPDATE. */
function queuePreChecks({
  activeLocations = 2,
  locationFound = true,
  orgDefault = ORG_DEFAULT_ROW as typeof ORG_DEFAULT_ROW | null,
  existing = null as { id: string; status: string } | null,
} = {}) {
  sqlQueue.push([{ count: activeLocations }]);
  sqlQueue.push(locationFound ? [{ id: LOCATION_ID }] : []);
  sqlQueue.push(orgDefault ? [orgDefault] : []);
  sqlQueue.push(existing ? [existing] : []);
}

const ORIGINAL_FLAG = process.env.MULTI_LOCATION_ENABLED;

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  callOrder.length = 0;
  mockWriteAccountAuditLog.mockClear();
  mockWriteAccountAuditLog.mockResolvedValue(undefined);
  mockSafeInvalidateChannelCache.mockClear();
  process.env.MULTI_LOCATION_ENABLED = 'true';
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.MULTI_LOCATION_ENABLED;
  else process.env.MULTI_LOCATION_ENABLED = ORIGINAL_FLAG;
});

describe('createOrReviveOverride — eligibility (server-side tightening)', () => {
  it('returns not_eligible when MULTI_LOCATION_ENABLED is off, before any further check', async () => {
    process.env.MULTI_LOCATION_ENABLED = 'false';
    sqlQueue.push([{ count: 5 }]); // count alone cannot make it eligible

    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({ kind: 'not_eligible' });
    expect(sqlCalls).toHaveLength(1); // only the count query ran
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('returns not_eligible for a single-location account even with the flag on', async () => {
    sqlQueue.push([{ count: 1 }]);

    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({ kind: 'not_eligible' });
    expect(sqlCalls).toHaveLength(1);
  });

  it('counts only active (non-archived) locations scoped by account_id, inside the tx', async () => {
    queuePreChecks();
    sqlQueue.push([{ id: OVERRIDE_ID }]); // INSERT
    await createOrReviveOverride(INPUT);

    const countQuery = sqlCalls[0]!;
    expect(countQuery.text).toContain('COUNT(*)');
    expect(countQuery.text).toContain('FROM businesses');
    expect(countQuery.text).toContain('account_id =');
    expect(countQuery.text).toContain('archived_at IS NULL');
    expect(countQuery.values).toContain(ACCOUNT_ID);
  });
});

describe('createOrReviveOverride — pre-checks (all inside the tx)', () => {
  it('returns location_not_found when the location is not owned/active', async () => {
    queuePreChecks({ locationFound: false });
    // queue holds extra entries; the module must stop at the location check
    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({ kind: 'location_not_found' });
    expect(sqlCalls).toHaveLength(2);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('returns no_org_default when no VERIFIED org-default exists (lookup filters status)', async () => {
    queuePreChecks({ orgDefault: null });
    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({ kind: 'no_org_default' });

    // The org-default lookup must require a verified row so non-verified
    // statuses can never be cloned into override rows.
    const orgLookup = sqlCalls[2]!;
    expect(orgLookup.text).toContain("status = 'verified'");
    expect(orgLookup.text).toContain('location_id IS NULL');
    expect(orgLookup.values).toContain(ACCOUNT_ID);
    expect(orgLookup.values).toContain('telegram');
  });

  it('returns conflict when an ACTIVE (non-disabled) override already exists', async () => {
    queuePreChecks({ existing: { id: OVERRIDE_ID, status: 'verified' } });
    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({ kind: 'conflict' });
    expect(sqlCalls).toHaveLength(4); // no INSERT/UPDATE attempted
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });
});

describe('createOrReviveOverride — created', () => {
  it('INSERTs a clone of the org-default, audits in-tx, invalidates cache after commit', async () => {
    queuePreChecks();
    sqlQueue.push([{ id: OVERRIDE_ID }]); // INSERT RETURNING

    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({
      kind: 'created',
      override: {
        id: OVERRIDE_ID,
        locationId: LOCATION_ID,
        channel: 'telegram',
        handle: '@org_bot',
        status: 'verified',
      },
    });

    const insert = sqlCalls[4]!;
    expect(insert.text).toContain('INSERT INTO channel_enrollments');
    expect(insert.values).toEqual(
      expect.arrayContaining([ACCOUNT_ID, LOCATION_ID, 'telegram', '@org_bot', 'verified', VERIFIED_AT]),
    );

    // Audit rides the SAME tx handle (rolls back with the enrollment).
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [auditTx, auditInput] = mockWriteAccountAuditLog.mock.calls[0]!;
    expect(auditInput.eventType).toBe('channel_override_created');
    expect(auditInput.accountId).toBe(ACCOUNT_ID);
    expect(auditInput.locationId).toBe(LOCATION_ID);
    expect(auditInput.actorUserId).toBe('user-1');
    expect(auditInput.entityType).toBe('channel_enrollment');
    expect(auditInput.entityId).toBe(OVERRIDE_ID);
    expect(auditInput.payload).toMatchObject({
      channel: 'telegram',
      override_enrollment_id: OVERRIDE_ID,
      cloned_handle: '@org_bot',
      cloned_status: 'verified',
      revived: false,
    });
    expect(auditTx).toBe(mockSql);

    expect(mockSafeInvalidateChannelCache).toHaveBeenCalledTimes(1);
    expect(mockSafeInvalidateChannelCache).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'settings.channels.override.upsert',
    );
    expect(callOrder).toEqual(['commit', 'invalidate']);
  });

  it('throws when the INSERT returns no rows (impossible state surfaced, not swallowed)', async () => {
    queuePreChecks();
    sqlQueue.push([]); // INSERT returns nothing
    await expect(createOrReviveOverride(INPUT)).rejects.toThrow(
      'Override INSERT/revive returned no rows',
    );
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });
});

describe('createOrReviveOverride — revived', () => {
  it('revives a cascade-disabled override via UPDATE (never a second INSERT)', async () => {
    queuePreChecks({ existing: { id: OVERRIDE_ID, status: 'disabled' } });
    sqlQueue.push([{ id: OVERRIDE_ID }]); // revive UPDATE RETURNING

    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({
      kind: 'revived',
      override: {
        id: OVERRIDE_ID,
        locationId: LOCATION_ID,
        channel: 'telegram',
        handle: '@org_bot',
        status: 'verified',
      },
    });

    // The mutation must be an UPDATE that re-clones + clears disabled_at —
    // never a second INSERT for the same (account, location, channel).
    const revive = sqlCalls[4]!;
    expect(revive.text).toContain('UPDATE channel_enrollments');
    expect(revive.text).toContain('disabled_at = NULL');
    expect(revive.text).toContain("status = 'disabled'");
    expect(revive.text).not.toContain('INSERT');
    expect(revive.values).toEqual(
      expect.arrayContaining([OVERRIDE_ID, ACCOUNT_ID, '@org_bot', 'verified', VERIFIED_AT]),
    );

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAccountAuditLog.mock.calls[0]![1].payload).toMatchObject({ revived: true });
    expect(mockSafeInvalidateChannelCache).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'settings.channels.override.upsert',
    );
  });
});

describe('createOrReviveOverride — failure modes', () => {
  it('maps a 23505 race on INSERT to conflict; cache NOT invalidated', async () => {
    queuePreChecks();
    sqlQueue.push({ __throw: { code: '23505', constraint: 'uniq' } });

    const result = await createOrReviveOverride(INPUT);
    expect(result).toEqual({ kind: 'conflict' });
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('propagates non-23505 errors unchanged', async () => {
    queuePreChecks();
    sqlQueue.push({ __throw: new Error('connection reset') });
    await expect(createOrReviveOverride(INPUT)).rejects.toThrow('connection reset');
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('audit write failure rejects the tx (enrollment rolls back); cache NOT invalidated', async () => {
    queuePreChecks();
    sqlQueue.push([{ id: OVERRIDE_ID }]);
    mockWriteAccountAuditLog.mockRejectedValueOnce(new Error('audit DB error'));

    await expect(createOrReviveOverride(INPUT)).rejects.toThrow('audit DB error');
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });
});

describe('removeOverride', () => {
  it('archives the override, audits in-tx, invalidates cache after commit', async () => {
    sqlQueue.push([{ id: OVERRIDE_ID }]); // UPDATE … SET archived_at RETURNING

    const result = await removeOverride(INPUT);
    expect(result).toEqual({ kind: 'ok' });

    const archive = sqlCalls[0]!;
    expect(archive.text).toContain('archived_at = NOW()');
    expect(archive.text).toContain('account_id =');
    expect(archive.text).toContain('archived_at IS NULL');
    expect(archive.values).toEqual(
      expect.arrayContaining([ACCOUNT_ID, LOCATION_ID, 'telegram']),
    );

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [auditTx, auditInput] = mockWriteAccountAuditLog.mock.calls[0]!;
    expect(auditInput.eventType).toBe('channel_override_removed');
    expect(auditInput.accountId).toBe(ACCOUNT_ID);
    expect(auditInput.locationId).toBe(LOCATION_ID);
    expect(auditInput.actorUserId).toBe('user-1');
    expect(auditInput.entityId).toBe(OVERRIDE_ID);
    expect(auditInput.payload).toMatchObject({
      channel: 'telegram',
      archived_enrollment_id: OVERRIDE_ID,
    });
    expect(auditTx).toBe(mockSql);

    expect(mockSafeInvalidateChannelCache).toHaveBeenCalledTimes(1);
    expect(mockSafeInvalidateChannelCache).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'settings.channels.override.delete',
    );
    expect(callOrder).toEqual(['commit', 'invalidate']);
  });

  it('returns not_found (no sentinel throw) when nothing matched; no audit, no invalidation', async () => {
    sqlQueue.push([]); // UPDATE matches nothing

    const result = await removeOverride(INPUT);
    expect(result).toEqual({ kind: 'not_found' });
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('audit write failure rejects the tx; cache NOT invalidated', async () => {
    sqlQueue.push([{ id: OVERRIDE_ID }]);
    mockWriteAccountAuditLog.mockRejectedValueOnce(new Error('audit DB error'));

    await expect(removeOverride(INPUT)).rejects.toThrow('audit DB error');
    expect(mockSafeInvalidateChannelCache).not.toHaveBeenCalled();
  });
});
