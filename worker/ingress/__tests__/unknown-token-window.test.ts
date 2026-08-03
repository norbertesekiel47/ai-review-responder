import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readReplicaIdentity, replicaIdentityFields } from '../../config/replica-identity';
import { createGracefulShutdown, type GracefulShutdownDeps } from '../../shutdown';
import {
  createUnknownTokenReporter,
  recordUnknownUnsubscribeToken,
  stopUnknownUnsubscribeTokenWindow,
  UNKNOWN_TOKEN_WINDOW_MS,
  type UnknownTokenReporter,
} from '../unsubscribe';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const START_MS = Date.UTC(2026, 7, 3, 12, 0, 0);

interface Rig {
  reporter: UnknownTokenReporter;
  warn: ReturnType<typeof vi.fn>;
  advance: (ms: number) => void;
  expire: () => void;
}

/**
 * Fake clock + fake timer. A real 60s wait would make the suite useless, and
 * `vi.useFakeTimers()` would reach into every other timer the module graph owns.
 */
function buildRig(): Rig {
  let nowMs = START_MS;
  let pending: (() => void) | null = null;
  const warn = vi.fn();

  const reporter = createUnknownTokenReporter({
    windowMs: UNKNOWN_TOKEN_WINDOW_MS,
    clock: {
      now: () => nowMs,
      schedule: (onExpiry) => {
        pending = onExpiry;
        return () => {
          pending = null;
        };
      },
    },
    warn,
    identityFields: () => replicaIdentityFields(readReplicaIdentity()),
  });

  return {
    reporter,
    warn,
    advance: (ms) => {
      nowMs += ms;
    },
    expire: () => {
      const fire = pending;
      pending = null;
      fire?.();
    },
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('unknown unsubscribe token window', () => {
  it('hostile unknown token traffic emits at most one warning per window', () => {
    const rig = buildRig();

    for (let index = 0; index < 5_000; index += 1) rig.reporter.record();
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();

    // The hard bound: one line per 60s per process, regardless of traffic volume.
    expect(rig.warn).toHaveBeenCalledTimes(1);
  });

  it('the aggregated unknown token line carries the replica id and an accurate count', () => {
    // Replica tagging is what makes the series SUMMABLE: a cross-deployment
    // overlap during a zero-downtime deploy produces two tagged series that add
    // up rather than one that silently under-reports.
    vi.stubEnv('RAILWAY_REPLICA_ID', 'replica-7');
    vi.stubEnv('RAILWAY_DEPLOYMENT_ID', 'deploy-42');
    const rig = buildRig();

    for (let index = 0; index < 17; index += 1) rig.reporter.record();
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();

    expect(rig.warn).toHaveBeenCalledTimes(1);
    const [, fields] = rig.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({
      event: 'unsubscribe_unknown_token_window',
      count: 17,
      window_start: new Date(START_MS).toISOString(),
      window_end: new Date(START_MS + UNKNOWN_TOKEN_WINDOW_MS).toISOString(),
      replica_id: 'replica-7',
      deployment_id: 'deploy-42',
    });
  });

  it('opens a fresh window after one expires', () => {
    const rig = buildRig();

    rig.reporter.record();
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();
    rig.reporter.record();
    rig.reporter.record();
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();

    expect(rig.warn).toHaveBeenCalledTimes(2);
    expect((rig.warn.mock.calls[1] as [string, { count: number }])[1].count).toBe(2);
  });

  it('emits nothing at all when no unknown token arrives', () => {
    const rig = buildRig();

    rig.reporter.stop();
    rig.expire();

    expect(rig.warn).not.toHaveBeenCalled();
  });

  it('a partial unknown token window is flushed on graceful shutdown', async () => {
    // Drives the REAL module-level reporter through the REAL shutdown
    // orchestrator, then pins that worker/index.ts actually wires it in — an
    // ungraceful crash may lose <=60s of counts, but a SIGTERM must not.
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warned.push(String(line));
    });

    recordUnknownUnsubscribeToken();
    recordUnknownUnsubscribeToken();
    recordUnknownUnsubscribeToken();

    const noop = async (): Promise<void> => {};
    const deps: GracefulShutdownDeps = {
      graceMs: 1_000,
      isFatalExitInProgress: () => false,
      stopBackgroundLoops: () => stopUnknownUnsubscribeTokenWindow(),
      drainAnalyticsDispatch: noop,
      flushAnalytics: noop,
      flushSentry: noop,
      closeWorkers: noop,
      closeQueues: noop,
      closeServer: noop,
      shutdownAnalytics: noop,
      closeDb: noop,
      exit: vi.fn(),
      armWatchdog: () => () => {},
      log: () => {},
      logError: () => {},
    };

    await createGracefulShutdown(deps)();

    const line = warned.find((entry) => entry.includes('unsubscribe_unknown_token_window'));
    expect(line).toBeDefined();
    expect((JSON.parse(line ?? '{}') as { data?: { count?: number } }).data?.count).toBe(3);

    const indexSource = readFileSync(path.join(REPO_ROOT, 'worker/index.ts'), 'utf8');
    expect(indexSource).toContain('stopUnknownUnsubscribeTokenWindow()');
  });
});
