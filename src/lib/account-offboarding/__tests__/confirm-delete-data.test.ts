import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn();
  sqlFn.json = vi.fn((value: unknown) => value);
  return {
    mockSql: sqlFn,
  };
});

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
}));

const { mockEnqueueOffboardingStarted } = vi.hoisted(() => ({
  mockEnqueueOffboardingStarted: vi.fn(),
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

vi.mock('../analytics', () => ({
  enqueueOffboardingStarted: mockEnqueueOffboardingStarted,
}));

import { confirmDeleteDataOffboarding } from '../confirm';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const AUTH_USER_ID = 'auth-user-1';
const LOCATION_ID = '99999999-8888-7777-8666-555555555555';
const IDEMPOTENCY_KEY = 'delete-data-key-1';

interface QueryCall {
  text: string;
  values: unknown[];
}

interface TxOptions {
  account?: {
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  } | null;
  owner?: { auth_id: string | null; email: string | null } | null;
  locationIds?: string[] | null;
  zernio?: {
    zernio_account_ids: string[];
    zernio_profile_ids: string[];
  };
  active?: {
    id: string;
    mode: 'cancel_only' | 'delete_data';
    status: 'pending';
    idempotency_key_matches: boolean;
  } | null;
}

function makeTx(options: TxOptions = {}) {
  const calls: QueryCall[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });

    if (text.includes('FROM accounts') && text.includes('FOR UPDATE')) {
      return options.account === null
        ? []
        : [options.account ?? {
          stripe_customer_id: 'cus_test',
          stripe_subscription_id: 'sub_test',
        }];
    }

    if (text.includes('FROM account_offboardings') && text.includes('terminal_at IS NULL')) {
      return options.active ? [options.active] : [];
    }

    if (text.includes('FROM users')) {
      return options.owner === null
        ? []
        : [options.owner ?? { auth_id: AUTH_USER_ID, email: 'owner@example.com' }];
    }

    if (text.includes('FROM businesses') && text.includes('location_ids')) {
      return [{ location_ids: options.locationIds ?? [LOCATION_ID] }];
    }

    if (text.includes('FROM zernio_connections')) {
      return [options.zernio ?? {
        zernio_account_ids: ['zacct-1'],
        zernio_profile_ids: ['zprof-1'],
      }];
    }

    return [];
  });

  (tx as any).json = mockSql.json;
  return { tx, calls };
}

function sqlText(calls: QueryCall[]): string {
  return calls.map((call) => call.text).join('\n');
}

describe('confirmDeleteDataOffboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.begin.mockReset();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
    mockEnqueueOffboardingStarted.mockResolvedValue(undefined);
  });

  it('creates a pending delete-data offboarding, marks Zernio disconnected, and enqueues teardown plus confirmation email in one transaction', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      reasonCode: 'switched_service',
      requestId: 'req-delete-1',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.status).toBe('created');
    expect(result.offboarding.mode).toBe('delete_data');
    expect(result.offboarding.status).toBe('pending');
    expect(mockSql.begin).toHaveBeenCalledOnce();

    const combinedSql = sqlText(calls);
    expect(combinedSql).toContain('FROM accounts');
    expect(combinedSql).toContain('FOR UPDATE');
    expect(combinedSql).toContain('INSERT INTO account_offboardings');
    expect(combinedSql).toContain('delete_data');
    expect(combinedSql).toContain('purge_after');
    expect(combinedSql).toContain("interval '30 days'");
    expect(combinedSql).toContain('UPDATE zernio_connections');
    expect(combinedSql).toContain("status = 'disconnected'");
    expect(combinedSql).toContain('account_offboarding_delete_data');

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        eventType: 'account_offboarding_requested',
        entityType: 'account_offboarding',
        ip: '203.0.113.10',
        userAgent: 'vitest',
        requestId: 'req-delete-1',
        payload: expect.objectContaining({
          mode: 'delete_data',
          status: 'pending',
          reason_code: 'switched_service',
        }),
      }),
    );

    expect(mockEnqueueOffboardingStarted).toHaveBeenCalledWith(tx, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      offboardingId: result.offboarding.id,
      mode: 'delete_data',
    });

    const outboxCalls = calls.filter((call) => call.text.includes('INSERT INTO job_outbox'));
    expect(outboxCalls).toHaveLength(2);
    const outboxValues = outboxCalls.flatMap((call) => call.values);
    expect(outboxValues).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL);
    expect(outboxValues).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN);
    expect(outboxValues).not.toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE);

    const payloads = outboxValues.filter(
      (value): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value),
    );
    expect(payloads).toContainEqual(expect.objectContaining({
      account_offboarding_id: result.offboarding.id,
      account_id: ACCOUNT_ID,
    }));
    expect(payloads).toContainEqual(expect.objectContaining({
      account_offboarding_id: result.offboarding.id,
      account_id: ACCOUNT_ID,
      email_type: 'delete_data_confirmation',
    }));
    expect(JSON.stringify(payloads)).not.toContain('keep_my_data_token');
    expect(JSON.stringify(payloads)).not.toContain('raw_token');
  });

  it('fails the transaction when the teardown outbox insert fails so state change and enqueue stay atomic', async () => {
    const calls: QueryCall[] = [];
    const persistedState = {
      offboardings: [] as Array<{ id: string; accountId: string }>,
      disconnectedBusinessIds: new Set<string>(),
      outboxTopics: [] as string[],
    };

    const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });

      if (text.includes('FROM accounts') && text.includes('FOR UPDATE')) {
        return [{
          stripe_customer_id: 'cus_test',
          stripe_subscription_id: 'sub_test',
        }];
      }

      if (text.includes('FROM users')) {
        return [{ auth_id: AUTH_USER_ID, email: 'owner@example.com' }];
      }

      if (text.includes('FROM businesses') && text.includes('location_ids')) {
        return [{ location_ids: [LOCATION_ID] }];
      }

      if (text.includes('FROM zernio_connections')) {
        return [{ zernio_account_ids: ['zacct-1'], zernio_profile_ids: ['zprof-1'] }];
      }

      if (text.includes('INSERT INTO account_offboardings')) {
        persistedState.offboardings.push({
          id: String(values[0]),
          accountId: String(values[1]),
        });
        return [];
      }

      if (text.includes('UPDATE zernio_connections')) {
        persistedState.disconnectedBusinessIds.add(LOCATION_ID);
        return [];
      }

      if (text.includes('INSERT INTO job_outbox')) {
        const topic = values.find((value): value is string =>
          typeof value === 'string' && value.startsWith('account_offboarding_'),
        ) ?? '';
        if (topic === QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN) {
          throw new Error('job_outbox_teardown_insert_failed');
        }
        if (topic.length > 0) {
          persistedState.outboxTopics.push(topic);
        }
        return [];
      }

      return [];
    });
    (tx as any).json = mockSql.json;
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => {
      const snapshot = {
        offboardings: [...persistedState.offboardings],
        disconnectedBusinessIds: new Set(persistedState.disconnectedBusinessIds),
        outboxTopics: [...persistedState.outboxTopics],
      };
      try {
        return await cb(tx);
      } catch (err) {
        persistedState.offboardings = snapshot.offboardings;
        persistedState.disconnectedBusinessIds = snapshot.disconnectedBusinessIds;
        persistedState.outboxTopics = snapshot.outboxTopics;
        throw err;
      }
    });

    await expect(confirmDeleteDataOffboarding(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      reasonCode: 'switched_service',
    })).rejects.toThrow('job_outbox_teardown_insert_failed');

    expect(sqlText(calls)).toContain('INSERT INTO account_offboardings');
    expect(sqlText(calls)).toContain('UPDATE zernio_connections');
    expect(sqlText(calls)).toContain('INSERT INTO job_outbox');
    expect(mockSql.begin).toHaveBeenCalledOnce();
    expect(persistedState.offboardings).toEqual([]);
    expect([...persistedState.disconnectedBusinessIds]).toEqual([]);
    expect(persistedState.outboxTopics).toEqual([]);
  });

  it('creates delete-data offboarding when billing and provider snapshots are absent', async () => {
    const { tx, calls } = makeTx({
      account: {
        stripe_customer_id: null,
        stripe_subscription_id: null,
      },
      zernio: {
        zernio_account_ids: [],
        zernio_profile_ids: [],
      },
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      reasonCode: 'closing_business',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.offboarding.mode).toBe('delete_data');
    const insertCall = calls.find((call) => call.text.includes('INSERT INTO account_offboardings'));
    expect(insertCall?.values).toContain(null);
    expect(sqlText(calls)).toContain('INSERT INTO job_outbox');
    expect(sqlText(calls)).toContain('account_offboarding_delete_data');
    expect(mockEnqueueOffboardingStarted).toHaveBeenCalledWith(tx, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      offboardingId: result.offboarding.id,
      mode: 'delete_data',
    });
  });

  it('aborts before inserts and Zernio disconnect when the snapshot is incomplete', async () => {
    const { tx, calls } = makeTx({
      owner: null,
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      reasonCode: 'switched_service',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'snapshot_incomplete',
      missingFields: ['auth_user_id', 'recipient_email'],
    });
    expect(sqlText(calls)).not.toContain('INSERT INTO account_offboardings');
    expect(sqlText(calls)).not.toContain('UPDATE zernio_connections');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockEnqueueOffboardingStarted).not.toHaveBeenCalled();
  });

  it('returns the active delete-data row as an idempotent retry when the key matches durable audit metadata', async () => {
    const { tx, calls } = makeTx({
      active: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        mode: 'delete_data',
        status: 'pending',
        idempotency_key_matches: true,
      },
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      reasonCode: 'switched_service',
    });

    expect(result).toEqual({
      ok: true,
      status: 'idempotent',
      offboarding: {
        id: 'bbbbbbbb-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'pending',
      },
    });
    expect(sqlText(calls)).not.toContain('INSERT INTO account_offboardings');
    expect(sqlText(calls)).not.toContain('UPDATE zernio_connections');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockEnqueueOffboardingStarted).not.toHaveBeenCalled();
  });

  it('returns duplicate_active when any active offboarding exists for a different key', async () => {
    const { tx, calls } = makeTx({
      active: {
        id: 'cccccccc-2222-7333-8444-555555555555',
        mode: 'cancel_only',
        status: 'pending',
        idempotency_key_matches: false,
      },
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: 'different-key',
      reasonCode: 'switched_service',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'duplicate_active',
      activeOffboarding: {
        id: 'cccccccc-2222-7333-8444-555555555555',
        accountId: ACCOUNT_ID,
        mode: 'cancel_only',
        status: 'pending',
      },
    });
    expect(sqlText(calls)).not.toContain('INSERT INTO account_offboardings');
    expect(mockEnqueueOffboardingStarted).not.toHaveBeenCalled();
  });
});
