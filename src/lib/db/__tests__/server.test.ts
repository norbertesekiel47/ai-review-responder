import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllPostgresClients, createDedicatedPostgresClient, sql, sqlRead, SHARED_POOL_MAX } from '../server';

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
      connection: { statement_timeout: 5_000, application_name: 'custom-app-name' },
    });
    expect(client.options.connection.statement_timeout).toBe(5_000);
    expect(client.options.connection.application_name).toBe('custom-app-name');
    void client.end({ timeout: 0 });
  });
});

// The shutdown close-order contract used by worker/index.ts's `closeDb` dep.
// `sql.end` is stubbed so no real connection is opened; combined with the
// health-alert bulkhead's own leaf tests (that closeHealthSql actually
// .end()s its client), this proves the dedicated client is ended from the
// shutdown path.
describe('closeAllPostgresClients', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes every dedicated closer and then the shared sql.end()', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockResolvedValue(undefined);
    const healthClose = vi.fn().mockResolvedValue(undefined);

    await closeAllPostgresClients([healthClose]);

    expect(healthClose).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('still closes the shared pool when a dedicated closer REJECTS (resilience — load-bearing)', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockResolvedValue(undefined);
    const wedgedHealthClose = vi.fn().mockRejectedValue(new Error('dedicated .end() wedged'));

    // Must not throw — allSettled absorbs the rejection.
    await expect(closeAllPostgresClients([wedgedHealthClose])).resolves.toBeUndefined();

    // The rejecting closer still ran, AND the shared pool was still closed.
    expect(wedgedHealthClose).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the dedicated closers BEFORE sql.end() (close-order)', async () => {
    const order: string[] = [];
    const endSpy = vi.spyOn(sql, 'end').mockImplementation(async () => {
      order.push('sql.end');
      return undefined as never;
    });
    const healthClose = vi.fn().mockImplementation(async () => {
      order.push('health');
    });

    await closeAllPostgresClients([healthClose]);

    expect(order).toEqual(['health', 'sql.end']);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  // sqlRead lifecycle (#477 Task 1 step 3): it joins the best-effort closers
  // (its rejection can't skip sql.end()), but sql.end() stays awaited
  // DIRECTLY so its own rejection still propagates out of the function.
  it('invokes sqlRead.end() alongside the dedicated closers', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockResolvedValue(undefined);
    const sqlReadEndSpy = vi.spyOn(sqlRead, 'end').mockResolvedValue(undefined);
    const healthClose = vi.fn().mockResolvedValue(undefined);

    await closeAllPostgresClients([healthClose]);

    expect(sqlReadEndSpy).toHaveBeenCalledTimes(1);
    // Bounds its own close so a wedged read pool can't stall sql.end() (matches closeHealthSql).
    expect(sqlReadEndSpy).toHaveBeenCalledWith({ timeout: 5 });
    expect(healthClose).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('a rejecting sql.end() still propagates out of closeAllPostgresClients (shutdown contract preserved)', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockRejectedValue(new Error('shared pool wedged'));
    const sqlReadEndSpy = vi.spyOn(sqlRead, 'end').mockResolvedValue(undefined);

    await expect(closeAllPostgresClients([])).rejects.toThrow('shared pool wedged');

    // sqlRead's best-effort close still ran even though sql.end() ultimately rejects.
    expect(sqlReadEndSpy).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});

// Read bulkhead: distinct client, right-sized + wedge-safe-floored (#477 Task 1).
describe('sqlRead read bulkhead', () => {
  it('is a distinct client instance from the write singleton', () => {
    expect(sqlRead).not.toBe(sql);
  });

  it('is sized >= the moved KPI fan-out and carries the tight read statement_timeout', () => {
    // postgres.js exposes `.options` publicly (types/index.d.ts).
    const opts = (sqlRead as unknown as { options: { max: number; connection: { statement_timeout?: number } } }).options;
    expect(opts.max).toBeGreaterThanOrEqual(8);
    expect(opts.connection.statement_timeout).toBe(8000);
  });

  it('exposes the shared write-pool max as a positive number', () => {
    expect(SHARED_POOL_MAX).toBeGreaterThan(0);
  });

  it('floors DB_READ_POOL_MAX at the wedge-safe minimum — a mis-set 1 cannot reintroduce the #505 wedge (codex #6)', async () => {
    try {
      vi.resetModules();
      vi.stubEnv('DB_READ_POOL_MAX', '1');
      const fresh = await import('../server');
      expect((fresh.sqlRead as unknown as { options: { max: number } }).options.max).toBe(fresh.WEDGE_SAFE_READ_MIN);
    } finally {
      // cleanup in finally so a failed assertion can't leave the env stubbed / modules reset (codex nit)
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('caps DB_READ_POOL_MAX at the reviewed ceiling — an oversized value cannot blow the ADR-0009 connection budget (codex adversarial #1)', async () => {
    try {
      vi.resetModules();
      vi.stubEnv('DB_READ_POOL_MAX', '800');
      const fresh = await import('../server');
      expect((fresh.sqlRead as unknown as { options: { max: number } }).options.max).toBe(fresh.READ_POOL_MAX_CEILING);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
