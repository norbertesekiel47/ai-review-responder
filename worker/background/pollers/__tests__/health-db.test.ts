import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildHealthClient } from '../health-alert/health-db';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as const;

/** A dedicated-client stand-in with a controllable `end()`. Distinct identities
 *  distinguish the pre- and post-rebuild clients. */
function makeClient(end = vi.fn().mockResolvedValue(undefined)) {
  return { end } as unknown as ReturnType<BuildHealthClient>;
}

/** A builder spy returning the given clients in order (last one repeats). */
function builderReturning(...clients: ReturnType<BuildHealthClient>[]) {
  const build = vi.fn<BuildHealthClient>();
  for (const c of clients) build.mockReturnValueOnce(c);
  if (clients.length > 0) build.mockReturnValue(clients[clients.length - 1]!);
  return build;
}

// Fresh module state (module-level `healthSql`) per test.
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('health-db — getHealthSql', () => {
  it('builds lazily on first use and memoizes (one client, not one per call)', async () => {
    const client = makeClient();
    const build = builderReturning(client);
    const { getHealthSql } = await import('../health-alert/health-db');

    expect(build).not.toHaveBeenCalled(); // no client until first getHealthSql

    expect(getHealthSql(build)).toBe(client);
    expect(getHealthSql(build)).toBe(client); // memoized
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('health-db — recycleHealthSql', () => {
  it('ends the current client and rebuilds; the next getHealthSql returns the fresh one', async () => {
    const first = makeClient();
    const second = makeClient();
    const build = builderReturning(first, second);
    const { getHealthSql, recycleHealthSql } = await import('../health-alert/health-db');

    expect(getHealthSql(build)).toBe(first);
    await recycleHealthSql(build, logger);

    expect(first.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(getHealthSql(build)).toBe(second); // reclaimed onto a fresh client
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds UNCONDITIONALLY even when end() rejects (log-swallow)', async () => {
    const first = makeClient(vi.fn().mockRejectedValue(new Error('end failed')));
    const second = makeClient();
    const build = builderReturning(first, second);
    const { getHealthSql, recycleHealthSql } = await import('../health-alert/health-db');
    getHealthSql(build);

    await expect(recycleHealthSql(build, logger)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled(); // logged, not silent, not rethrown
    expect(getHealthSql(build)).toBe(second); // rebuilt despite the failed end
  });

  it('rebuilds UNCONDITIONALLY even when end() hangs (bounded by withTimeout)', async () => {
    const first = makeClient(vi.fn(() => new Promise<void>(() => {}))); // never settles
    const second = makeClient();
    const build = builderReturning(first, second);
    const { getHealthSql, recycleHealthSql } = await import('../health-alert/health-db');
    getHealthSql(build);

    vi.useFakeTimers();
    try {
      const recycled = recycleHealthSql(build, logger);
      await vi.advanceTimersByTimeAsync(2_000); // trip the end() withTimeout deadline
      await expect(recycled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(getHealthSql(build)).toBe(second); // rebuilt despite the hung end
  });

  it('still builds a client when recycle is called before any getHealthSql (defensive)', async () => {
    const client = makeClient();
    const build = builderReturning(client);
    const { getHealthSql, recycleHealthSql } = await import('../health-alert/health-db');

    await expect(recycleHealthSql(build, logger)).resolves.toBeUndefined(); // no prior build

    expect(getHealthSql(build)).toBe(client);
    expect(build).toHaveBeenCalledTimes(1); // built by the recycle finally
  });
});

describe('health-db — closeHealthSql (shutdown)', () => {
  it('ends the client WITHOUT rebuilding; a later getHealthSql builds a new one', async () => {
    const first = makeClient();
    const second = makeClient();
    const build = builderReturning(first, second);
    const { getHealthSql, closeHealthSql } = await import('../health-alert/health-db');
    getHealthSql(build);

    await closeHealthSql();

    expect(first.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(build).toHaveBeenCalledTimes(1); // close does NOT rebuild
    expect(getHealthSql(build)).toBe(second); // a fresh boot builds anew
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when nothing was ever built', async () => {
    const { closeHealthSql } = await import('../health-alert/health-db');
    await expect(closeHealthSql()).resolves.toBeUndefined();
  });

  it('swallows an end() rejection so shutdown proceeds', async () => {
    const first = makeClient(vi.fn().mockRejectedValue(new Error('end failed')));
    const build = builderReturning(first);
    const { getHealthSql, closeHealthSql } = await import('../health-alert/health-db');
    getHealthSql(build);

    await expect(closeHealthSql()).resolves.toBeUndefined();
  });
});
