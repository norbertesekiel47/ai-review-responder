import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: `TimeoutError` is imported DYNAMICALLY inside the F2 tests, not statically
// here. `vi.resetModules()` (below) gives the module-under-test a FRESH copy of
// `with-timeout`, so a statically-imported `TimeoutError` would be a different
// class than the one the source's `err instanceof TimeoutError` checks against —
// the recycle-on-timeout branch would never match. Importing it after the reset,
// from the same fresh graph, keeps the identity aligned.

const { mockGetWorkerConfig, mockCreateClient, mockCaptureMessage } = vi.hoisted(() => ({
  mockGetWorkerConfig: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../../../../src/lib/config/worker', () => ({ getWorkerConfig: mockGetWorkerConfig }));
vi.mock('../../../../src/lib/db/server', () => ({ createDedicatedPostgresClient: mockCreateClient }));
vi.mock('@sentry/node', () => ({ captureMessage: mockCaptureMessage }));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logUnhandledPollError: () => vi.fn(),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// Fresh module state (module-level `disabled`/`reaperSql`) per test.
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

/** A tagged-template client stand-in whose callable is a spy that resolves every
 *  query to `rows`. The callable is a `vi.fn` so tests can assert query counts
 *  (used to prove a client was — or was NOT — swept on). */
function fakeClient(rows: unknown[]) {
  const query = vi.fn((..._args: unknown[]) => Promise.resolve(rows));
  return Object.assign(query, { end: vi.fn().mockResolvedValue(undefined) });
}

/** Drain any fire-and-forget poll `initPoolWedgeReaper` kicks off. The immediate
 *  poll (and any client end it triggers) settles on the microtask queue; a
 *  macrotask hop guarantees it has fully run before the test asserts. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const DISABLED_MESSAGE = expect.stringContaining('disabled');
const WARNING_ARG = expect.objectContaining({
  level: 'warning',
  tags: { subsystem: 'pool_wedge_reaper' },
});

describe('PoolWedgeReaperPoller — disabled (fail-safe) path', () => {
  it('disables and raises a Sentry warning when no direct URL is configured — no client, no throw', async () => {
    mockGetWorkerConfig.mockReturnValue({ POOL_WEDGE_REAPER_ENABLED: 'true' });
    const { initPoolWedgeReaper } = await import('../PoolWedgeReaperPoller');

    await expect(initPoolWedgeReaper()).resolves.toBeUndefined();

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(DISABLED_MESSAGE, WARNING_ARG);
  });

  it('disables, alerts, and closes the client on a DEFINITIVE pooler echo (application_name swallowed to Supavisor)', async () => {
    const client = fakeClient([{ app_name: 'Supavisor' }]); // pooler swallowed the app name
    mockGetWorkerConfig.mockReturnValue({
      POOL_WEDGE_REAPER_ENABLED: 'true',
      DATABASE_URL: 'postgres://direct:5432/db',
    });
    mockCreateClient.mockReturnValue(client);
    const { initPoolWedgeReaper } = await import('../PoolWedgeReaperPoller');

    await expect(initPoolWedgeReaper()).resolves.toBeUndefined();

    expect(mockCaptureMessage).toHaveBeenCalledWith(DISABLED_MESSAGE, WARNING_ARG);
    expect(client.end).toHaveBeenCalled(); // never left open to run on the pooler
  });

  it('does not disable or alert once the route is verified-direct (application_name echoes back)', async () => {
    const client = fakeClient([{ app_name: 'rw-wedge-reaper' }]);
    mockGetWorkerConfig.mockReturnValue({
      POOL_WEDGE_REAPER_ENABLED: 'true',
      DIRECT_URL: 'postgres://direct:5432/db',
      POOL_WEDGE_REAPER_INTERVAL_MS: '60000',
    });
    mockCreateClient.mockReturnValue(client);
    const { initPoolWedgeReaper, stopPoolWedgeReaperPoller } = await import('../PoolWedgeReaperPoller');

    await expect(initPoolWedgeReaper()).resolves.toBeUndefined();
    stopPoolWedgeReaperPoller(); // clear the scheduled interval so the test leaks no timer

    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe('PoolWedgeReaperPoller — lifecycle verification (F1 + F2)', () => {
  it('F1: a TRANSIENT verify error at boot does NOT permanently disable — it schedules the loop, and a later poll acquires a verified client and sweeps', async () => {
    const rejectingClient = Object.assign(
      vi.fn(() => Promise.reject(new Error('ECONNRESET during boot verify'))),
      { end: vi.fn().mockResolvedValue(undefined) },
    );
    const verifiedClient = fakeClient([{ app_name: 'rw-wedge-reaper' }]);
    mockGetWorkerConfig.mockReturnValue({
      POOL_WEDGE_REAPER_ENABLED: 'true',
      DIRECT_URL: 'postgres://direct:5432/db',
      POOL_WEDGE_REAPER_INTERVAL_MS: '60000',
    });
    mockCreateClient
      .mockReturnValueOnce(rejectingClient) // boot acquire → transient
      .mockReturnValue(verifiedClient); // subsequent poll acquire → verified
    const { initPoolWedgeReaper, stopPoolWedgeReaperPoller } = await import('../PoolWedgeReaperPoller');

    await initPoolWedgeReaper();
    stopPoolWedgeReaperPoller(); // stop the interval; the immediate poll is already dispatched
    await drainMicrotasks(); // let the fire-and-forget immediate poll re-acquire + sweep

    // F1 core: a transient boot blip must NOT have permanently disabled the backstop.
    expect(mockCaptureMessage).not.toHaveBeenCalledWith(DISABLED_MESSAGE, WARNING_ARG);
    expect(rejectingClient.end).toHaveBeenCalled(); // the discarded transient client was ended
    // The subsequent poll acquired a verified-direct client and swept on it.
    expect(verifiedClient).toHaveBeenCalled(); // verify + sweep queries ran
    expect(verifiedClient.end).not.toHaveBeenCalled(); // the verified client is kept, not discarded
  });

  it('F2(a): after a sweep TIMEOUT recycles the client, the next poll RE-VERIFIES — a definitive pooler echo disables instead of sweeping the unverified client', async () => {
    const { TimeoutError } = await import('../../../../src/lib/shared/with-timeout');
    const bootClient = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ app_name: 'rw-wedge-reaper' }]) // boot verify → verified
        .mockRejectedValueOnce(new TimeoutError('sweep stalled')), // sweep → TimeoutError → recycle
      { end: vi.fn().mockResolvedValue(undefined) },
    );
    const poolerClient = fakeClient([{ app_name: 'Supavisor' }]); // re-acquire routes through the pooler
    mockGetWorkerConfig.mockReturnValue({
      POOL_WEDGE_REAPER_ENABLED: 'true',
      DIRECT_URL: 'postgres://direct:5432/db',
      POOL_WEDGE_REAPER_INTERVAL_MS: '60000',
    });
    mockCreateClient
      .mockReturnValueOnce(bootClient) // boot: verified then sweep-timeout
      .mockReturnValue(poolerClient); // post-recycle re-acquire: pooler echo
    const { initPoolWedgeReaper, pollPoolWedgeReaper, stopPoolWedgeReaperPoller } = await import(
      '../PoolWedgeReaperPoller'
    );

    await initPoolWedgeReaper();
    stopPoolWedgeReaperPoller();
    await drainMicrotasks(); // immediate poll sweeps → times out → recycles (ends+nulls bootClient)

    expect(bootClient.end).toHaveBeenCalled(); // recycle ended the wedged client

    await pollPoolWedgeReaper(); // next tick re-acquires: pooler → disable, no sweep

    expect(mockCaptureMessage).toHaveBeenCalledWith(DISABLED_MESSAGE, WARNING_ARG);
    expect(poolerClient).toHaveBeenCalledTimes(1); // verify only — never swept on
    expect(poolerClient.end).toHaveBeenCalled(); // discarded after the pooler verdict
  });

  it('F2(b): after a sweep TIMEOUT recycles the client, the next poll re-verifies and sweeps on a FRESH verified client', async () => {
    const { TimeoutError } = await import('../../../../src/lib/shared/with-timeout');
    const bootClient = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ app_name: 'rw-wedge-reaper' }]) // boot verify → verified
        .mockRejectedValueOnce(new TimeoutError('sweep stalled')), // sweep → TimeoutError → recycle
      { end: vi.fn().mockResolvedValue(undefined) },
    );
    const freshClient = fakeClient([{ app_name: 'rw-wedge-reaper' }]); // re-acquire is verified-direct again
    mockGetWorkerConfig.mockReturnValue({
      POOL_WEDGE_REAPER_ENABLED: 'true',
      DIRECT_URL: 'postgres://direct:5432/db',
      POOL_WEDGE_REAPER_INTERVAL_MS: '60000',
    });
    mockCreateClient
      .mockReturnValueOnce(bootClient)
      .mockReturnValue(freshClient);
    const { initPoolWedgeReaper, pollPoolWedgeReaper, stopPoolWedgeReaperPoller } = await import(
      '../PoolWedgeReaperPoller'
    );

    await initPoolWedgeReaper();
    stopPoolWedgeReaperPoller();
    await drainMicrotasks(); // immediate poll times out → recycles

    expect(bootClient.end).toHaveBeenCalled();

    await pollPoolWedgeReaper(); // re-acquires a verified client and sweeps

    expect(mockCaptureMessage).not.toHaveBeenCalledWith(DISABLED_MESSAGE, WARNING_ARG);
    expect(freshClient).toHaveBeenCalled(); // verify + sweep ran on the fresh verified client
    expect(freshClient.end).not.toHaveBeenCalled(); // kept as the live reaper connection
  });
});

describe('startPoolWedgeReaperPoller — enable gate', () => {
  it('skips entirely (no client built) when POOL_WEDGE_REAPER_ENABLED is unset — dormant by default', async () => {
    mockGetWorkerConfig.mockReturnValue({});
    const { startPoolWedgeReaperPoller } = await import('../PoolWedgeReaperPoller');

    expect(() => startPoolWedgeReaperPoller()).not.toThrow();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('skips entirely (no client built) when POOL_WEDGE_REAPER_ENABLED is not "true"', async () => {
    mockGetWorkerConfig.mockReturnValue({ POOL_WEDGE_REAPER_ENABLED: 'false' });
    const { startPoolWedgeReaperPoller } = await import('../PoolWedgeReaperPoller');

    expect(() => startPoolWedgeReaperPoller()).not.toThrow();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
