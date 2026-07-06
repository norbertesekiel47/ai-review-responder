import { createHash } from 'node:crypto';
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

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));

import { keepMyDataForAccount, keepMyDataWithToken } from '../keep-my-data';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';
const OFFBOARDING_ID = '22222222-2222-7333-8444-555555555555';
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const RAW_TOKEN = 'raw-keep-my-data-token';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const IDEMPOTENCY_KEY = 'keep-data-key-1';
const IDEMPOTENCY_HASH = createHash('sha256').update(IDEMPOTENCY_KEY).digest('hex');

interface QueryCall {
  text: string;
  values: unknown[];
}

interface TxOptions {
  active?: ReturnType<typeof activeRow> | null;
  token?: ReturnType<typeof tokenRow> | null;
  idempotent?: {
    id: string;
    mode: 'delete_data';
    status: 'pending' | 'tearing_down' | 'purge_scheduled' | 'churned';
    terminal_at: Date | string | null;
  } | null;
  updateWins?: boolean;
  consumeWins?: boolean;
}

function makeTx(options: TxOptions = {}) {
  const calls: QueryCall[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });

    if (text.includes('FROM account_offboarding_tokens t')) {
      return options.token === null ? [] : [options.token ?? tokenRow()];
    }

    if (text.includes('FROM account_offboardings') && text.includes('FOR UPDATE')) {
      return options.active === null ? [] : [options.active ?? activeRow()];
    }

    if (text.includes('account_offboarding_keep_my_data') && text.includes('FROM account_audit_log')) {
      return options.idempotent ? [options.idempotent] : [];
    }

    if (text.includes('UPDATE account_offboarding_tokens') && text.includes('SET consumed_at')) {
      return options.consumeWins === false ? [] : [{ id: TOKEN_ID }];
    }

    if (text.includes('UPDATE account_offboardings') && text.includes('purge_cancelled_at')) {
      if (options.updateWins === false) return [];
      const source = options.token ?? options.active ?? activeRow();
      const completed = source.teardown_completed_at !== null;
      return [{
        id: source.id,
        account_id: source.account_id,
        mode: 'delete_data',
        status: completed ? 'churned' : source.status,
      }];
    }

    return [];
  });

  (tx as any).json = mockSql.json;
  return { tx, calls };
}

function activeRow(overrides: Partial<{
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'pending' | 'tearing_down' | 'purge_scheduled';
  teardown_completed_at: Date | string | null;
  purge_started_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  terminal_at: Date | string | null;
}> = {}) {
  return {
    id: OFFBOARDING_ID,
    account_id: ACCOUNT_ID,
    mode: 'delete_data' as const,
    status: 'purge_scheduled' as const,
    teardown_completed_at: null,
    purge_started_at: null,
    purge_cancelled_at: null,
    terminal_at: null,
    ...overrides,
  };
}

function tokenRow(overrides: Partial<ReturnType<typeof activeRow> & {
  token_id: string;
  token_hash: string;
  token_type: 'keep_my_data';
  expires_at: Date | string;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
}> = {}) {
  return {
    ...activeRow(),
    token_id: TOKEN_ID,
    token_hash: TOKEN_HASH,
    token_type: 'keep_my_data' as const,
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function sqlText(calls: QueryCall[]): string {
  return calls.map((call) => call.text).join('\n');
}

function outboxPayloads(calls: QueryCall[]) {
  return calls
    .flatMap((call) => call.values)
    .filter((value): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value),
    );
}

describe('keepMyDataForAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.begin.mockReset();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
  });

  it('sets purge_cancelled_at, revokes outstanding tokens, audits, and enqueues confirmation email in one transaction', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataForAccount(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: 'req-keep-1',
      ip: '203.0.113.20',
      userAgent: 'vitest',
    });

    expect(result).toEqual({
      ok: true,
      status: 'kept',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'purge_scheduled',
      },
    });
    expect(mockSql.begin).toHaveBeenCalledOnce();
    const combinedSql = sqlText(calls);
    expect(combinedSql).toContain('FOR UPDATE');
    expect(combinedSql).toContain('purge_started_at IS NULL');
    expect(combinedSql).toContain('purge_cancelled_at IS NULL');
    expect(combinedSql).toContain('SET purge_cancelled_at');
    expect(combinedSql).toContain('UPDATE account_offboarding_tokens');
    expect(combinedSql).toContain("revoked_reason = 'keep_my_data'");

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: USER_ID,
        eventType: 'account_offboarding_keep_my_data',
        entityType: 'account_offboarding',
        entityId: OFFBOARDING_ID,
        ip: '203.0.113.20',
        userAgent: 'vitest',
        requestId: 'req-keep-1',
        payload: expect.objectContaining({
          mode: 'delete_data',
          status: 'purge_scheduled',
          auth_method: 'owner_session',
          idempotency_key_hash: IDEMPOTENCY_HASH,
        }),
      }),
    );

    const outboxCalls = calls.filter((call) => call.text.includes('INSERT INTO job_outbox'));
    expect(outboxCalls).toHaveLength(1);
    expect(outboxCalls.flatMap((call) => call.values)).toContain(
      QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL,
    );
    expect(outboxPayloads(calls)).toContainEqual(expect.objectContaining({
      account_offboarding_id: OFFBOARDING_ID,
      account_id: ACCOUNT_ID,
      email_type: 'keep_my_data_confirmation',
    }));
    expect(JSON.stringify({
      values: calls.flatMap((call) => call.values),
      audit: mockWriteAccountAuditLog.mock.calls[0]?.[1],
    })).not.toContain(RAW_TOKEN);
  });

  it('terminalizes as churned when teardown has already completed', async () => {
    const { tx, calls } = makeTx({
      active: activeRow({
        status: 'purge_scheduled',
        teardown_completed_at: new Date('2026-07-01T00:00:00.000Z'),
      }),
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataForAccount(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.offboarding.status).toBe('churned');
    expect(sqlText(calls)).toContain("THEN 'churned'");
    expect(sqlText(calls)).toContain('terminal_at = CASE');
  });

  it('returns an idempotent success for a repeated authenticated request', async () => {
    const { tx, calls } = makeTx({
      active: activeRow({ purge_cancelled_at: new Date('2026-07-01T00:00:00.000Z') }),
      idempotent: {
        id: OFFBOARDING_ID,
        mode: 'delete_data',
        status: 'purge_scheduled',
        terminal_at: null,
      },
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataForAccount(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({
      ok: true,
      status: 'idempotent',
      offboarding: {
        id: OFFBOARDING_ID,
        accountId: ACCOUNT_ID,
        mode: 'delete_data',
        status: 'purge_scheduled',
      },
    });
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('rejects keep-my-data after purge has started without mutating state', async () => {
    const { tx, calls } = makeTx({
      active: activeRow({
        purge_started_at: new Date('2026-07-02T00:00:00.000Z'),
      }),
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataForAccount(mockSql, {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: 'not_available' });
    expect(sqlText(calls)).not.toContain('SET purge_cancelled_at');
    expect(sqlText(calls)).not.toContain('UPDATE account_offboarding_tokens');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});

describe('keepMyDataWithToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.begin.mockReset();
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
  });

  it('consumes the raw token atomically and never persists the raw token', async () => {
    const { tx, calls } = makeTx();
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataWithToken(mockSql, {
      rawToken: RAW_TOKEN,
      requestId: 'req-token-1',
      ip: '203.0.113.21',
      userAgent: 'vitest',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.offboarding.status).toBe('purge_scheduled');

    const combinedSql = sqlText(calls);
    expect(combinedSql).toContain('FOR UPDATE OF t, ao');
    expect(combinedSql).toContain('SET consumed_at = NOW()');
    expect(combinedSql).toContain('SET purge_cancelled_at');
    expect(combinedSql).toContain('AND t.id <>');
    expect(combinedSql).toContain("revoked_reason = 'keep_my_data'");
    expect(JSON.stringify(calls.flatMap((call) => call.values))).not.toContain(RAW_TOKEN);
    expect(calls.flatMap((call) => call.values)).toContain(TOKEN_HASH);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: null,
        eventType: 'account_offboarding_keep_my_data',
        payload: expect.objectContaining({
          auth_method: 'token',
          token_hash: TOKEN_HASH,
        }),
      }),
    );
    expect(outboxPayloads(calls)).toContainEqual(expect.objectContaining({
      account_offboarding_id: OFFBOARDING_ID,
      account_id: ACCOUNT_ID,
      email_type: 'keep_my_data_confirmation',
    }));
    expect(JSON.stringify({
      values: calls.flatMap((call) => call.values),
      audit: mockWriteAccountAuditLog.mock.calls[0]?.[1],
    })).not.toContain(RAW_TOKEN);
  });

  it.each([
    ['expired', tokenRow({ expires_at: new Date(Date.now() - 60_000) }), 'token_expired'],
    ['consumed', tokenRow({ consumed_at: new Date() }), 'token_consumed'],
    ['revoked', tokenRow({ revoked_at: new Date() }), 'token_revoked'],
  ] as const)('rejects a %s token before mutations', async (_label, row, reason) => {
    const { tx, calls } = makeTx({ token: row });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataWithToken(mockSql, { rawToken: RAW_TOKEN });

    expect(result).toEqual({ ok: false, reason });
    expect(sqlText(calls)).not.toContain('SET consumed_at = NOW()');
    expect(sqlText(calls)).not.toContain('SET purge_cancelled_at');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    const { tx } = makeTx({ token: null });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    await expect(keepMyDataWithToken(mockSql, { rawToken: RAW_TOKEN })).resolves.toEqual({
      ok: false,
      reason: 'token_invalid',
    });
  });

  it('rejects a token after purge has started before consuming it', async () => {
    const { tx, calls } = makeTx({
      token: tokenRow({
        purge_started_at: new Date('2026-07-02T00:00:00.000Z'),
      }),
    });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataWithToken(mockSql, { rawToken: RAW_TOKEN });

    expect(result).toEqual({ ok: false, reason: 'not_available' });
    expect(sqlText(calls)).not.toContain('SET consumed_at = NOW()');
    expect(sqlText(calls)).not.toContain('SET purge_cancelled_at');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('does not apply keep-my-data when atomic token consumption loses the race', async () => {
    const { tx, calls } = makeTx({ consumeWins: false });
    mockSql.begin.mockImplementationOnce(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await keepMyDataWithToken(mockSql, { rawToken: RAW_TOKEN });

    expect(result).toEqual({ ok: false, reason: 'not_available' });
    expect(sqlText(calls)).toContain('SET consumed_at = NOW()');
    expect(sqlText(calls)).not.toContain('SET purge_cancelled_at');
    expect(sqlText(calls)).not.toContain('INSERT INTO job_outbox');
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
