import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllPostgresClients, createDedicatedPostgresClient, sql } from '../server';

// Constructing a postgres.js client does NOT open a connection (it connects
// lazily on the first query), so these assertions are offline and side-effect
// free — no real DB is touched. We assert against the client's parsed `.options`,
// which postgres.js exposes.
describe('createDedicatedPostgresClient', () => {
  it('returns a NEW client distinct from the shared sql singleton', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', { max: 2 });
    expect(client).not.toBe(sql);
    // A postgres.js client is a callable tagged-template function.
    expect(typeof client).toBe('function');
    void client.end({ timeout: 0 });
  });

  it('honors the requested max (pool size) override', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', { max: 2 });
    expect(client.options.max).toBe(2);
    void client.end({ timeout: 0 });
  });

  it('defaults max to 2 when no override is given (dedicated clients are small)', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db');
    expect(client.options.max).toBe(2);
    void client.end({ timeout: 0 });
  });

  it('inherits the pinned base config (prepare:false + 30s statement_timeout default)', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', { max: 2 });
    expect(client.options.prepare).toBe(false);
    expect(client.options.connection.statement_timeout).toBe(30_000);
    void client.end({ timeout: 0 });
  });

  it('lets a caller override statement_timeout and application_name via connection', () => {
    const client = createDedicatedPostgresClient('postgres://u:p@localhost:5432/db', {
      max: 2,
      connection: { statement_timeout: 5_000, application_name: 'rw-wedge-reaper' },
    });
    expect(client.options.connection.statement_timeout).toBe(5_000);
    expect(client.options.connection.application_name).toBe('rw-wedge-reaper');
    void client.end({ timeout: 0 });
  });
});

// The shutdown close-order contract used by worker/index.ts's `closeDb` dep.
// `sql.end` is stubbed so no real connection is opened; combined with T1/T2's
// leaf tests (that closeReaperClient/closeHealthSql actually .end() their
// clients), this proves both dedicated clients are ended from the shutdown path.
describe('closeAllPostgresClients', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes every dedicated closer and then the shared sql.end()', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockResolvedValue(undefined);
    const reaperClose = vi.fn().mockResolvedValue(undefined);
    const healthClose = vi.fn().mockResolvedValue(undefined);

    await closeAllPostgresClients([reaperClose, healthClose]);

    expect(reaperClose).toHaveBeenCalledTimes(1);
    expect(healthClose).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('still closes the shared pool when a dedicated closer REJECTS (resilience — load-bearing)', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockResolvedValue(undefined);
    const wedgedClose = vi.fn().mockRejectedValue(new Error('dedicated .end() wedged'));
    const healthClose = vi.fn().mockResolvedValue(undefined);

    // Must not throw — allSettled absorbs the rejection.
    await expect(closeAllPostgresClients([wedgedClose, healthClose])).resolves.toBeUndefined();

    // The OTHER closer still ran, AND the shared pool was still closed.
    expect(wedgedClose).toHaveBeenCalledTimes(1);
    expect(healthClose).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the dedicated closers BEFORE sql.end() (close-order)', async () => {
    const order: string[] = [];
    const endSpy = vi.spyOn(sql, 'end').mockImplementation(async () => {
      order.push('sql.end');
      return undefined as never;
    });
    const reaperClose = vi.fn().mockImplementation(async () => {
      order.push('reaper');
    });
    const healthClose = vi.fn().mockImplementation(async () => {
      order.push('health');
    });

    await closeAllPostgresClients([reaperClose, healthClose]);

    expect(order).toEqual(['reaper', 'health', 'sql.end']);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
