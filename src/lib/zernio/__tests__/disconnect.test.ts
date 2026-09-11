import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectZernioConnection } from '../disconnect';

const { deleteAccount, reportError } = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock('../client', () => ({ zernioClient: { deleteAccount } }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: reportError }));

const businessId = '11111111-1111-4111-8111-111111111111';
const accountId = 'selected-provider-account';

function database() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return { count: 1 };
  });
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    calls.push({ text: strings.join('?'), values });
    return strings.join(' ').includes('JOIN accounts')
      ? []
      : [{ zernio_account_id: accountId }];
  });
  const begin = vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx));
  const sql = Object.assign(query, { begin }) as unknown as Sql;
  return { sql, query, tx, begin, calls };
}

describe('shared manual Disconnect', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deleteAccount.mockResolvedValue(undefined);
  });

  it('checks admin offboarding before selecting and updating only the chosen account', async () => {
    const db = database();
    expect(await disconnectZernioConnection(db.sql, businessId, 'admin')).toEqual({
      status: 200, body: { ok: true },
    });
    expect(db.calls[0]?.text).toContain('ao.account_id = a.id');
    expect(db.calls[0]?.text).toContain('b.archived_at IS NULL');
    expect(db.calls[0]?.values).toEqual([businessId]);
    expect(db.calls[1]?.values).toEqual([businessId]);
    expect(db.calls[2]?.text).toMatch(/business_id = \?\s+AND zernio_account_id = \?\s+AND status = 'active'/);
    expect(db.calls[2]?.values).toEqual(['manual_admin', businessId, accountId]);
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(accountId);
    expect(db.begin.mock.invocationCallOrder[0]).toBeLessThan(deleteAccount.mock.invocationCallOrder[0] ?? -1);
  });

  it('retains the owner reason after the route has established writable location scope', async () => {
    const db = database();
    await disconnectZernioConnection(db.sql, businessId, 'owner');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.calls[1]?.values).toEqual(['manual_owner', businessId, accountId]);
  });

  it('refuses an offboarding admin target without a connection read or provider call', async () => {
    const db = database();
    db.query.mockResolvedValueOnce([{
      offboarding_id: 'offboarding', offboarding_account_id: 'account',
      offboarding_mode: 'delete_data', offboarding_status: 'pending',
    }]);
    expect(await disconnectZernioConnection(db.sql, businessId, 'admin')).toEqual({
      status: 403, body: { error: 'account_offboarding_blocked' },
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.begin).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('returns no-active-connection without starting a mutation', async () => {
    const db = database();
    db.query.mockResolvedValueOnce([]);
    expect(await disconnectZernioConnection(db.sql, businessId, 'owner')).toEqual({
      status: 404, body: { error: 'no_active_connection' },
    });
    expect(db.begin).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('skips provider deletion when a concurrent writer wins the selected-account update', async () => {
    const db = database();
    db.tx.mockResolvedValueOnce({ count: 0 });
    expect(await disconnectZernioConnection(db.sql, businessId, 'owner')).toEqual({
      status: 200, body: { ok: true, note: 'connection_already_disconnected' },
    });
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('does not call the provider when the database transaction fails', async () => {
    const db = database();
    db.begin.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(disconnectZernioConnection(db.sql, businessId, 'owner')).rejects.toThrow('database unavailable');
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('reports one failed provider attempt and preserves local success', async () => {
    const db = database();
    const error = new Error('provider unavailable');
    deleteAccount.mockRejectedValueOnce(error);
    expect(await disconnectZernioConnection(db.sql, businessId, 'owner')).toEqual({
      status: 200, body: { ok: true },
    });
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledExactlyOnceWith('api/zernio/disconnect', error, {
      businessId, kind: 'zernio_delete_account',
    });
  });
});
