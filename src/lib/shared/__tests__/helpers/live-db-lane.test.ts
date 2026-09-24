// DB-free tests for the lane lease's lifecycle contract (#958, requirements 4
// and 5). The lock SEMANTICS against a real server — shared lease vs an
// exclusive provisioner, the two keys not deadlocking — are covered by
// live-db-lane.integration.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLaneLease,
  LaneLeaseTimeoutError,
  LIVE_DB_LANE_ACQUISITION_TIMEOUT_MS,
  LIVE_DB_LANE_HOOK_TIMEOUT_MS,
  openLiveDbLaneLease,
  type LaneLeaseOptions,
  type LaneLeaseSession,
} from './live-db-lane';

type Handler = (query: string) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

interface FakeSession extends LaneLeaseSession {
  calls: string[];
  ended: number;
}

function fakeSession(handler: Handler, endError?: Error): FakeSession {
  const session: FakeSession = {
    calls: [],
    ended: 0,
    sql: async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const query = strings
        .reduce((text, part, index) => text + part + (index < params.length ? String(params[index]) : ''), '')
        .replace(/\s+/g, ' ')
        .trim();
      session.calls.push(query);
      return handler(query);
    },
    end: async () => {
      session.ended += 1;
      if (endError) throw endError;
    },
  };
  return session;
}

function pgError(code: string): Error {
  return Object.assign(new Error(`fake ${code}`), { code });
}

const HASH = 'a'.repeat(64);

/** A server at head: grants the lock, returns the expected marker, unlocks. */
function atHead(query: string): Record<string, unknown>[] {
  if (query.includes('test_meta.provision')) return [{ content_hash: HASH }];
  if (query.includes('pg_advisory_unlock_shared')) return [{ unlocked: true }];
  return [];
}

function options(session: LaneLeaseSession, overrides: Partial<LaneLeaseOptions> = {}): LaneLeaseOptions {
  return {
    lockKey: 'scratch_lane_key',
    applicationName: 'repworth_livedb_lane_test',
    acquisitionTimeoutMs: 1_000,
    hookTimeoutMs: 2_000,
    expectedHash: HASH,
    open: () => session,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('lane lease — timeout ordering', () => {
  it('the production hook timeout exceeds the database-side acquisition timeout', () => {
    expect(LIVE_DB_LANE_HOOK_TIMEOUT_MS).toBeGreaterThan(LIVE_DB_LANE_ACQUISITION_TIMEOUT_MS);
  });

  it('refuses a hook timeout that does not exceed the acquisition timeout — before opening a session', async () => {
    const open = vi.fn();
    await expect(
      acquireLaneLease({ ...options(fakeSession(atHead)), hookTimeoutMs: 1_000, open }),
    ).rejects.toThrow('hook timeout must exceed');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('lane lease — acquisition then marker validation', () => {
  it('takes the lock SHARED before it reads the marker, on the same session', async () => {
    const session = fakeSession(atHead);
    const lease = await acquireLaneLease(options(session));
    expect(session.calls[0]).toBe('SELECT pg_advisory_lock_shared(hashtext(scratch_lane_key))');
    expect(session.calls[1]).toBe('SELECT content_hash FROM test_meta.provision');
    expect(session.ended).toBe(0);
    expect(lease.applicationName).toBe('repworth_livedb_lane_test');
    await lease.release();
  });

  it.each([
    ['an absent test_meta SCHEMA (3F000)', () => Promise.reject(pgError('3F000'))],
    ['an absent provision TABLE (42P01)', () => Promise.reject(pgError('42P01'))],
    ['a missing marker ROW', () => []],
    ['a MISMATCHED hash', () => [{ content_hash: 'b'.repeat(64) }]],
  ] as const)('%s fails the lane with one actionable line, unlocks, and closes the session', async (_label, marker) => {
    const session = fakeSession((query) =>
      query.includes('test_meta.provision') ? marker() : atHead(query),
    );
    await expect(acquireLaneLease(options(session))).rejects.toThrow(
      'test DB provisioning incomplete or behind head — run pnpm test:db:setup',
    );
    expect(session.calls.at(-1)).toBe('SELECT pg_advisory_unlock_shared(hashtext(scratch_lane_key))');
    expect(session.ended).toBe(1);
  });

  it('a marker read failing for any OTHER reason propagates, still closing the session', async () => {
    const session = fakeSession((query) =>
      query.includes('test_meta.provision') ? Promise.reject(pgError('57014')) : atHead(query),
    );
    await expect(acquireLaneLease(options(session))).rejects.toThrow('fake 57014');
    expect(session.ended).toBe(1);
  });

  it('a database-side acquisition timeout (57014) closes the session and propagates', async () => {
    const session = fakeSession((query) =>
      query.includes('pg_advisory_lock_shared') ? Promise.reject(pgError('57014')) : atHead(query),
    );
    await expect(acquireLaneLease(options(session))).rejects.toThrow('fake 57014');
    expect(session.ended).toBe(1);
  });

  it('the client-side hook timeout fires when the server never answers, and closes the session', async () => {
    vi.useFakeTimers();
    const session = fakeSession((query) =>
      query.includes('pg_advisory_lock_shared') ? new Promise(() => undefined) : atHead(query),
    );
    const pending = acquireLaneLease(options(session));
    const assertion = expect(pending).rejects.toBeInstanceOf(LaneLeaseTimeoutError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(session.ended).toBe(1);
  });

  it('a lock granted AFTER the client-side timeout is not leaked — the closed session released it', async () => {
    vi.useFakeTimers();
    let grant: (() => void) | undefined;
    const session = fakeSession((query) =>
      query.includes('pg_advisory_lock_shared')
        ? new Promise((resolve) => {
            grant = () => resolve([]);
          })
        : atHead(query),
    );
    const pending = acquireLaneLease(options(session));
    const assertion = expect(pending).rejects.toBeInstanceOf(LaneLeaseTimeoutError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    grant?.();
    await vi.runAllTimersAsync();
    // Ended exactly once, by the failure path; nothing re-opened or re-used it.
    expect(session.ended).toBe(1);
  });

  it('a cleanup failure is reported TOGETHER with the acquisition failure', async () => {
    const session = fakeSession(
      (query) => (query.includes('pg_advisory_lock_shared') ? Promise.reject(pgError('57014')) : []),
      new Error('end failed'),
    );
    const error = await acquireLaneLease(options(session)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((inner: Error) => inner.message)).toEqual([
      'fake 57014',
      'end failed',
    ]);
  });
});

describe('lane lease — release', () => {
  it('unlocks shared and closes the session, exactly once however often it is called', async () => {
    const session = fakeSession(atHead);
    const lease = await acquireLaneLease(options(session));
    await lease.release();
    await lease.release();
    expect(session.calls.filter((call) => call.includes('pg_advisory_unlock_shared'))).toHaveLength(1);
    expect(session.ended).toBe(1);
  });

  it('reports a lease that was no longer held — the lane ran unprotected — and still closes the session', async () => {
    const session = fakeSession((query) =>
      query.includes('pg_advisory_unlock_shared') ? [{ unlocked: false }] : atHead(query),
    );
    const lease = await acquireLaneLease(options(session));
    await expect(lease.release()).rejects.toThrow('was not held at release');
    expect(session.ended).toBe(1);
  });
});

describe('openLiveDbLaneLease — when there is nothing to protect', () => {
  it('skips without a configured test database', async () => {
    await expect(openLiveDbLaneLease(undefined)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no test database configured',
    });
  });

  it('never locks a database that is not the shared LOCAL one (the staging deep-auth tier)', async () => {
    await expect(
      openLiveDbLaneLease('postgresql://user:pw@db.example.supabase.co:5432/postgres'),
    ).resolves.toEqual({ kind: 'skipped', reason: 'the test database is not the shared local one' });
  });

  it('skips a local server that refuses the connection outright', async () => {
    // Port 1 on loopback: nothing listens there, so the connect is refused
    // immediately rather than timing out.
    await expect(openLiveDbLaneLease('postgresql://u:p@127.0.0.1:1/test')).resolves.toEqual({
      kind: 'skipped',
      reason: 'the local test database refused the connection',
    });
  });
});

describe('lane lease wiring — every lane that reaches the shared DB holds it', () => {
  const ROOT = resolve(__dirname, '../../../../..');

  it('the vitest integration project declares the lane globalSetup, and only that project', async () => {
    const { default: config } = await import('../../../../../vitest.config');
    const projects = (config.test?.projects ?? []) as { test?: { name?: string; globalSetup?: unknown } }[];
    const byName = new Map(projects.map((project) => [project.test?.name, project.test]));
    expect(byName.get('integration')?.globalSetup).toEqual(['./vitest.integration-lane.ts']);
    // The parallel project never reaches the database (ci:live-db-suites R1),
    // so a lease there would only couple unit runs to the container.
    expect(byName.get('parallel')?.globalSetup).toBeUndefined();
  });

  it('the vitest lane resolves the database exactly the way its suites do', () => {
    const setup = readFileSync(resolve(ROOT, 'vitest.integration-lane.ts'), 'utf8');
    expect(setup).toContain('openLiveDbLaneLease(resolveTestDatabaseUrl())');
  });

  it('Playwright holds the lease from globalSetup to its returned teardown', () => {
    const config = readFileSync(resolve(ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toContain("globalSetup: './e2e/live-db-lease.ts'");
    const setup = readFileSync(resolve(ROOT, 'e2e/live-db-lease.ts'), 'utf8');
    expect(setup).toContain('openLiveDbLaneLease(process.env.TEST_DATABASE_POOL_URL)');
    expect(setup).toContain('return () => lease.release();');
  });
});
