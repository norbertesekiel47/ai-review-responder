import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** A tagged-template client stand-in that resolves every query to `rows`. */
function fakeClient(rows: unknown[]) {
  return Object.assign((..._args: unknown[]) => Promise.resolve(rows), {
    end: vi.fn().mockResolvedValue(undefined),
  });
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

  it('disables, alerts, and closes the client when application_name does not echo back (Supavisor route)', async () => {
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

describe('startPoolWedgeReaperPoller — enable gate', () => {
  it('skips entirely (no client built) when POOL_WEDGE_REAPER_ENABLED is not "true"', async () => {
    mockGetWorkerConfig.mockReturnValue({ POOL_WEDGE_REAPER_ENABLED: 'false' });
    const { startPoolWedgeReaperPoller } = await import('../PoolWedgeReaperPoller');

    expect(() => startPoolWedgeReaperPoller()).not.toThrow();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
