import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * `tx.depth` is shared between the sql double and the crypto spy so a test can
 * ask "was the token minted while a transaction was open?".
 *
 * This indirection is load-bearing. Asserting the token HASH SHAPE cannot pin
 * token-outside-tx: a sha256 hex string looks identical whether it was produced
 * before `sql.begin` or inside it, so a regression that moved minting into the
 * transaction would keep such a test green. Only the call-time depth answers it.
 */
const { txState, cryptoCalls } = vi.hoisted(() => ({
  txState: { depth: 0 },
  cryptoCalls: [] as Array<{ fn: 'randomUUID' | 'createHash'; txDepth: number }>,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (...a: Parameters<typeof actual.randomUUID>) => {
      cryptoCalls.push({ fn: 'randomUUID', txDepth: txState.depth });
      return actual.randomUUID(...a);
    },
    createHash: (...a: Parameters<typeof actual.createHash>) => {
      cryptoCalls.push({ fn: 'createHash', txDepth: txState.depth });
      return actual.createHash(...a);
    },
  };
});

const startEnrollmentMock = vi.fn();
const cancelEnrollmentMock = vi.fn();
vi.mock('@/lib/channels/mobile-enrollment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/channels/mobile-enrollment')>();
  return {
    ...actual,
    startMobileEnrollment: (...a: unknown[]) => startEnrollmentMock(...(a as [])),
    cancelMobileEnrollment: (...a: unknown[]) => cancelEnrollmentMock(...(a as [])),
  };
});

const disconnectMock = vi.fn();
vi.mock('@/lib/channels/disable-enrollment', () => ({
  disconnectChannel: (...a: unknown[]) => disconnectMock(...(a as [])),
}));

const invalidateMock = vi.fn(async () => {});
vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: (...a: unknown[]) => invalidateMock(...(a as [])),
}));

const reportMock = vi.fn();
vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: (...a: unknown[]) => reportMock(...(a as [])),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') },
}));

import { runChannelStart } from '../start';
import { runChannelCancel, runChannelDisable } from '../action';
import type { ChannelActorResolver } from '../resolve-actor';

/**
 * Recording sql double. `log` captures every statement with its bound values and
 * whether it ran inside sql.begin, so tests assert the COMPLETE statement list —
 * order, nesting and all — rather than probing for the presence of one query.
 *
 * Strictness here comes from exhaustive assertion, not from a fixture queue:
 * every enrollment helper the runners call (startMobileEnrollment,
 * cancelMobileEnrollment, disconnectChannel) is mocked in this suite, so the
 * only statement a runner issues on its own is the advisory lock. That makes the
 * expected log short enough to assert with toEqual, which is what makes an added
 * or reordered statement a failure instead of a silent pass. Do NOT relax these
 * to `toContain` — the exhaustiveness is the point.
 */
function mkSql() {
  const log: Array<{ raw: string; values: unknown[]; inTx: boolean }> = [];
  let beginCount = 0;
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    log.push({
      raw: strings.join('?').replace(/\s+/g, ' ').trim(),
      values,
      inTx: txState.depth > 0,
    });
    return Promise.resolve([]);
  };
  const sql = Object.assign(record, {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      beginCount += 1;
      txState.depth += 1;
      try {
        return await fn(Object.assign(record, { json: (v: unknown) => v }));
      } finally {
        txState.depth -= 1;
      }
    },
  });
  return { sql: sql as never, log, beginCount: () => beginCount };
}

/** The one statement a runner issues on its own, with helpers mocked. */
const LOCK_STATEMENT = 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))';
const lockedTx = (accountId = 'acct-1') => ({
  raw: LOCK_STATEMENT,
  values: [`mobile_enroll:${accountId}`],
  inTx: true,
});

function mkReq() {
  return new Request('http://localhost/api/admin/channels/telegram/start', {
    method: 'POST',
    body: JSON.stringify({ businessId: 'biz-1' }),
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  }) as never;
}

const okActor: ChannelActorResolver = async () => ({
  ok: true,
  actor: { businessId: 'biz-1', accountId: 'acct-1', actorUserId: 'admin-1', surface: 'admin' },
});

/** A resolver that fails the test if it is ever reached. */
const neverResolve: ChannelActorResolver = () => {
  throw new Error('resolveActor must not be called — a gate should have short-circuited');
};

function cfg(over: Partial<Parameters<typeof runChannelStart>[2]> = {}) {
  return {
    channel: 'telegram' as const,
    isEnabled: () => true,
    assertEnvReady: () => null,
    resolveActor: okActor,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cryptoCalls.length = 0;
  txState.depth = 0;
  startEnrollmentMock.mockResolvedValue({ kind: 'ok' });
  cancelEnrollmentMock.mockResolvedValue({ kind: 'ok' });
  disconnectMock.mockResolvedValue({ kind: 'ok' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.TELEGRAM_BOT_USERNAME = 'RepWorthBot';
});

describe('runChannelStart transaction protocol', () => {
  // WIRING GUARD — run this first. There is no precedent in this repo for
  // mocking a `node:` builtin, so prove the spy actually intercepts the runner's
  // `import { createHash, randomUUID } from 'node:crypto'` before any test
  // relies on it. If this fails, the crypto spy is not wired and the
  // token-timing test below would pass vacuously — see the fallback note under
  // this code block.
  it('the node:crypto spy intercepts the runner token mint', async () => {
    const { sql } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());
    expect(cryptoCalls.length).toBeGreaterThan(0);
  });

  it('runChannelStart mints the enrollment token outside the transaction', async () => {
    const { sql } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());

    // Both randomUUID (the raw token) and createHash (its sha256) must run at
    // txDepth 0. If either moved inside sql.begin, the secret would depend on a
    // transaction that may roll back. Asserting the hash's SHAPE cannot catch
    // that regression — only its call-time depth can.
    expect(cryptoCalls.map((c) => c.fn)).toEqual(['randomUUID', 'createHash']);
    expect(cryptoCalls.every((c) => c.txDepth === 0)).toBe(true);
  });

  it('runChannelStart opens exactly one transaction', async () => {
    const { sql, beginCount } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());
    expect(beginCount()).toBe(1);
  });

  it('runChannelStart takes the account-scoped advisory lock as the first statement in the transaction', async () => {
    const { sql, log } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());

    // Exhaustive: with startMobileEnrollment mocked, the lock is the ONLY
    // statement the runner issues. An added or reordered query fails here.
    expect(log).toEqual([lockedTx()]);
  });

  it('runChannelStart takes the advisory lock before calling startMobileEnrollment', async () => {
    const logAtEnrollment: Array<{ raw: string; values: unknown[]; inTx: boolean }> = [];
    const { sql, log } = mkSql();
    startEnrollmentMock.mockImplementation(async () => {
      logAtEnrollment.push(...log);
      return { kind: 'ok' };
    });

    await runChannelStart(sql, mkReq(), cfg());

    // The lock had already run when startMobileEnrollment was entered, and it
    // was the only thing that had.
    expect(logAtEnrollment).toEqual([lockedTx()]);
  });

  it('runChannelStart passes the same account id to the lock and to startMobileEnrollment', async () => {
    const { sql, log } = mkSql();
    await runChannelStart(sql, mkReq(), cfg());

    const [, channel, businessId, accountId, tokenHash] = startEnrollmentMock.mock.calls[0]!;
    expect(log[0]!.values).toEqual([`mobile_enroll:${accountId}`]);
    expect(channel).toBe('telegram');
    expect(businessId).toBe('biz-1');
    expect(accountId).toBe('acct-1');
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runChannelCancel takes the same account-scoped advisory lock before cancelling', async () => {
    const logAtCancel: Array<{ raw: string; values: unknown[]; inTx: boolean }> = [];
    const { sql, log } = mkSql();
    cancelEnrollmentMock.mockImplementation(async () => {
      logAtCancel.push(...log);
      return { kind: 'ok' };
    });

    await runChannelCancel(sql, mkReq(), cfg());

    expect(logAtCancel).toEqual([lockedTx()]);
    expect(log).toEqual([lockedTx()]);
    expect(cancelEnrollmentMock).toHaveBeenCalledWith(expect.anything(), 'telegram', 'acct-1');
  });

  it('runChannelDisable issues no statement of its own and delegates the transaction to disconnectChannel', async () => {
    const { sql, log, beginCount } = mkSql();
    await runChannelDisable(sql, mkReq(), cfg());

    // disconnectChannel owns its own tx, lock-free cascade and audit rows. The
    // runner must not open a second transaction around it.
    expect(log).toEqual([]);
    expect(beginCount()).toBe(0);
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});

describe('runner gate ordering', () => {
  it.each([
    ['runChannelStart', runChannelStart],
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s returns the flag-off 404 before auth and before any query', async (_name, run) => {
    const { sql, log } = mkSql();
    const res = await run(sql, mkReq(), cfg({ isEnabled: () => false, resolveActor: neverResolve }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(log).toHaveLength(0);
  });

  it.each([
    ['runChannelStart', runChannelStart],
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s returns the env 503 before auth and before any query', async (_name, run) => {
    const envErr = NextResponse.json({ ok: false, reason: 'telegram_env_not_ready' }, { status: 503 });
    const { sql, log } = mkSql();
    const res = await run(sql, mkReq(), cfg({ assertEnvReady: () => envErr, resolveActor: neverResolve }));

    expect(res.status).toBe(503);
    expect(log).toHaveLength(0);
  });
});

describe('runner actor pass-through', () => {
  it.each([
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s surfaces a blocked 402 past_due_read_only rather than mapping it to 404', async (_name, run) => {
    const blocked: ChannelActorResolver = async () => ({
      ok: false,
      response: NextResponse.json({ error: 'past_due_read_only' }, { status: 402 }),
    });
    const { sql } = mkSql();

    const res = await run(sql, mkReq(), cfg({ resolveActor: blocked }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
  });

  it.each([
    ['runChannelCancel', runChannelCancel],
    ['runChannelDisable', runChannelDisable],
  ])('%s surfaces a blocked 403 subscription_not_active rather than mapping it to 404', async (_name, run) => {
    const blocked: ChannelActorResolver = async () => ({
      ok: false,
      response: NextResponse.json({ error: 'subscription_not_active' }, { status: 403 }),
    });
    const { sql } = mkSql();

    const res = await run(sql, mkReq(), cfg({ resolveActor: blocked }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'subscription_not_active' });
  });

  it('runChannelDisable forwards the resolved surface to disconnectChannel', async () => {
    const { sql } = mkSql();
    await runChannelDisable(sql, mkReq(), cfg());

    expect(disconnectMock).toHaveBeenCalledWith(expect.anything(), {
      channel: 'telegram',
      accountId: 'acct-1',
      actorUserId: 'admin-1',
      surface: 'admin',
    });
  });
});

describe('runChannelStart error mapping', () => {
  it('runChannelStart maps EnrollmentDatabaseError to a no-store 500 internal', async () => {
    const { EnrollmentDatabaseError } = await import('@/lib/channels/unique-violation');
    startEnrollmentMock.mockRejectedValue(new EnrollmentDatabaseError());
    const { sql } = mkSql();

    const res = await runChannelStart(sql, mkReq(), cfg());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('the EnrollmentDatabaseError report carries no raw token or token hash', async () => {
    const { EnrollmentDatabaseError } = await import('@/lib/channels/unique-violation');
    startEnrollmentMock.mockRejectedValue(new EnrollmentDatabaseError());
    const { sql } = mkSql();

    await runChannelStart(sql, mkReq(), cfg());

    const [, , context] = reportMock.mock.calls[0]!;
    const serialized = JSON.stringify(context);
    // Invariant #5 applied to enrollment tokens: neither the raw uuid nor its
    // sha256 hash may reach a log sink.
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(context).toMatchObject({ channel: 'telegram', businessId: 'biz-1', accountId: 'acct-1' });
  });

  it('runChannelStart maps MultipleMobileChannelsError to a no-store 409', async () => {
    const { MultipleMobileChannelsError } = await import('@/lib/channels/unique-violation');
    startEnrollmentMock.mockRejectedValue(new MultipleMobileChannelsError());
    const { sql } = mkSql();

    const res = await runChannelStart(sql, mkReq(), cfg());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'multiple_mobile_channels' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('runChannelStart rethrows an unrecognised error rather than masking it as a 500', async () => {
    startEnrollmentMock.mockRejectedValue(new Error('something else entirely'));
    const { sql } = mkSql();

    await expect(runChannelStart(sql, mkReq(), cfg())).rejects.toThrow('something else entirely');
  });
});
