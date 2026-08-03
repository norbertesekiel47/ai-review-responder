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

    // Both causes, interleaved: dimensioning the counter must not buy a second line.
    for (let index = 0; index < 5_000; index += 1) {
      rig.reporter.record(index % 2 === 0 ? 'gate' : 'ledger');
    }
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

    for (let index = 0; index < 17; index += 1) rig.reporter.record('gate');
    for (let index = 0; index < 3; index += 1) rig.reporter.record('ledger');
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();

    expect(rig.warn).toHaveBeenCalledTimes(1);
    const [, fields] = rig.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({
      event: 'unsubscribe_unknown_token_window',
      gate_count: 17,
      ledger_count: 3,
      window_start: new Date(START_MS).toISOString(),
      window_end: new Date(START_MS + UNKNOWN_TOKEN_WINDOW_MS).toISOString(),
      replica_id: 'replica-7',
      deployment_id: 'deploy-42',
    });
  });

  it('counts a gate rejection and a ledger miss in separate buckets', () => {
    // The whole point of the split: `gate` is a string we never minted (scanner
    // noise), `ledger` is a token that passed our own HMAC and still failed to
    // resolve — the mint race. A responder must be able to tell them apart.
    const rig = buildRig();

    rig.reporter.record('ledger');
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();

    const [, fields] = rig.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields).toMatchObject({ gate_count: 0, ledger_count: 1 });
  });

  it('opens a fresh window after one expires', () => {
    const rig = buildRig();

    rig.reporter.record('gate');
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();
    rig.reporter.record('gate');
    rig.reporter.record('gate');
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();

    expect(rig.warn).toHaveBeenCalledTimes(2);
    expect((rig.warn.mock.calls[1] as [string, { gate_count: number }])[1].gate_count).toBe(2);
  });

  it('emits nothing at all when no unknown token arrives', () => {
    const rig = buildRig();

    rig.reporter.stop();
    rig.expire();

    expect(rig.warn).not.toHaveBeenCalled();
  });

  it('a throwing sink cannot escape the timer callback', () => {
    // The scheduled emit runs from a bare timer callback, where an escaping throw
    // is an uncaughtException — which worker/index.ts treats as ALWAYS fatal. The
    // realistic trigger is an EPIPE on console.warn during Railway log-stream
    // teardown, i.e. exactly when the container is already unhappy.
    const rig = buildRig();
    rig.warn.mockImplementation(() => {
      throw new Error('EPIPE: broken pipe');
    });

    rig.reporter.record('gate');
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    expect(() => rig.expire()).not.toThrow();
    // And the same swallow protects the shutdown flush.
    rig.reporter.record('gate');
    expect(() => rig.reporter.stop()).not.toThrow();
  });

  it('stop disarms the counter so a drain-window token cannot arm a dead timer', () => {
    // stopBackgroundLoops runs BEFORE closeServer, so requests keep arriving after
    // the flush. Re-arming there would leave an unref'd 60s window that can never
    // fire before process.exit — counts lost AND the "final" flush not final.
    const rig = buildRig();

    rig.reporter.record('gate');
    rig.reporter.stop();
    expect(rig.warn).toHaveBeenCalledTimes(1);

    rig.reporter.record('gate');
    rig.advance(UNKNOWN_TOKEN_WINDOW_MS);
    rig.expire();
    expect(rig.warn).toHaveBeenCalledTimes(1);
  });

  it('a partial unknown token window is flushed on graceful shutdown', async () => {
    // Drives the REAL module-level reporter through the REAL shutdown
    // orchestrator, then pins that worker/index.ts actually wires it in — an
    // ungraceful crash may lose <=60s of counts, but a SIGTERM must not.
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warned.push(String(line));
    });

    recordUnknownUnsubscribeToken('gate');
    recordUnknownUnsubscribeToken('gate');
    recordUnknownUnsubscribeToken('ledger');

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
    const parsed = JSON.parse(line ?? '{}') as {
      data?: { gate_count?: number; ledger_count?: number };
    };
    expect(parsed.data).toMatchObject({ gate_count: 2, ledger_count: 1 });

    const indexSource = readFileSync(path.join(REPO_ROOT, 'worker/index.ts'), 'utf8');
    expect(indexSource).toContain('stopUnknownUnsubscribeTokenWindow()');
  });
});
