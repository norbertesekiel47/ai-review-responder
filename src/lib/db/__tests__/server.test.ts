import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeAllPostgresClients,
  createDedicatedPostgresClient,
  sql,
  sqlRead,
  sqlUnsubscribe,
  SHARED_POOL_MAX,
  UNSUBSCRIBE_POOL_MAX,
} from '../server';
import { admissionStats } from '../admission';

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

  it('a rejecting unsubscribe-client close cannot skip shared sql shutdown', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockResolvedValue(undefined);
    vi.spyOn(sqlRead, 'end').mockResolvedValue(undefined);
    const sqlUnsubscribeEndSpy = vi
      .spyOn(sqlUnsubscribe, 'end')
      .mockRejectedValue(new Error('unsubscribe pool wedged'));

    await expect(closeAllPostgresClients([])).resolves.toBeUndefined();

    expect(sqlUnsubscribeEndSpy).toHaveBeenCalledWith({ timeout: 5 });
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the redemption client during closeAllPostgresClients without weakening shared-client shutdown failure propagation', async () => {
    const endSpy = vi.spyOn(sql, 'end').mockRejectedValue(new Error('shared pool wedged'));
    const sqlReadEndSpy = vi.spyOn(sqlRead, 'end').mockResolvedValue(undefined);
    const sqlUnsubscribeEndSpy = vi.spyOn(sqlUnsubscribe, 'end').mockResolvedValue(undefined);

    await expect(closeAllPostgresClients([])).rejects.toThrow('shared pool wedged');

    // Both dedicated best-effort closes still ran even though sql.end() ultimately rejects.
    expect(sqlReadEndSpy).toHaveBeenCalledTimes(1);
    expect(sqlUnsubscribeEndSpy).toHaveBeenCalledWith({ timeout: 5 });
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

  // Without this, unwrapping either singleton in server.ts would pass every
  // other test in the repo — admission.test.ts exercises the wrapper, nothing
  // asserted it was actually APPLIED (#773).
  it('gates BOTH singletons at their own pool size', () => {
    expect(admissionStats(sql)).toMatchObject({ cap: SHARED_POOL_MAX });
    const readMax = (sqlRead as unknown as { options: { max: number } }).options.max;
    expect(admissionStats(sqlRead)).toMatchObject({ cap: readMax });
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

describe('sqlUnsubscribe redemption bulkhead', () => {
  it('exports a fixed two-connection unsubscribe pool distinct from sql and sqlRead', () => {
    expect(sqlUnsubscribe).not.toBe(sql);
    expect(sqlUnsubscribe).not.toBe(sqlRead);
    expect(UNSUBSCRIBE_POOL_MAX).toBe(2);
    expect((sqlUnsubscribe as unknown as { options: { max: number } }).options.max).toBe(
      UNSUBSCRIBE_POOL_MAX,
    );
  });

  it('gates the unsubscribe client at its fixed pool size', () => {
    expect(admissionStats(sqlUnsubscribe)).toMatchObject({ cap: UNSUBSCRIBE_POOL_MAX });
  });

  it('pins the revised 15-isolate steady-state and 13-isolate rollout ADR-0009 Max-Clients bounds, the roughly 54-of-57 compound backend case, and the fixed redemption-pool maximum', () => {
    const adr = readFileSync(
      path.join(process.cwd(), 'docs/adr/0009-split-postgres-pools.md'),
      'utf8',
    );

    expect(UNSUBSCRIBE_POOL_MAX).toBe(2);
    expect(adr).toContain('**15 warm isolates**');
    expect(adr).toContain('`24 + 15×11 = 189`');
    expect(adr).toContain('**13 aggregate warm Vercel isolates**');
    expect(adr).toContain('`48 + 13×11 = 191`');
    expect(adr).toContain('**54/57 (~95%)**');
    expect(adr).toContain('fixed local maximum is **2**');
  });
});
