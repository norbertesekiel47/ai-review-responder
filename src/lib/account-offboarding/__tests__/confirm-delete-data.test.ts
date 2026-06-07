import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockJsonb } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn();
  sqlFn.json = vi.fn((value: unknown) => value);
  return {
    mockSql: sqlFn,
    mockJsonb: vi.fn((value: unknown) => value),
  };
});

const { mockWriteAccountAuditLog } = vi.hoisted(() => ({
  mockWriteAccountAuditLog: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: mockJsonb,
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
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
  });

  it('creates a pending delete-data offboarding, marks Zernio disconnected, and enqueues only the confirmation email in one transaction', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding({
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
      tx,
    );

    const outboxCalls = calls.filter((call) => call.text.includes('INSERT INTO job_outbox'));
    expect(outboxCalls).toHaveLength(1);
    const outboxValues = outboxCalls.flatMap((call) => call.values);
    expect(outboxValues).toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL);
    expect(outboxValues).not.toContain(QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE);

    const payloads = outboxValues.filter(
      (value): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value),
    );
    expect(payloads).toContainEqual(expect.objectContaining({
      account_offboarding_id: result.offboarding.id,
      account_id: ACCOUNT_ID,
      email_type: 'delete_data_confirmation',
    }));
    expect(JSON.stringify(payloads)).not.toContain('keep_my_data_token');
    expect(JSON.stringify(payloads)).not.toContain('raw_token');
  });

  it('aborts before inserts and Zernio disconnect when the snapshot is incomplete', async () => {
    const { tx, calls } = makeTx({
      account: {
        stripe_customer_id: 'cus_test',
        stripe_subscription_id: null,
      },
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await confirmDeleteDataOffboarding({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      reasonCode: 'switched_service',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'snapshot_incomplete',
      missingFields: ['stripe_subscription_id'],
    });
    expect(sqlText(calls)).not.toContain('INSERT INTO account_offboardings');
    expect(sqlText(calls)).not.toContain('UPDATE zernio_connections');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
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

    const result = await confirmDeleteDataOffboarding({
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

    const result = await confirmDeleteDataOffboarding({
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
  });
});
