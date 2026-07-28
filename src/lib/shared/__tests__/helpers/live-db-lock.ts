// The cross-PROCESS mutex for live-DB suites.
//
// vitest's `integration` project serializes suites within one process
// (`fileParallelism: false` + `groupOrder`), but nothing in vitest spans
// processes — and `scripts/verify-gate.sh` runs the intake's
// verification_commands as separate concurrent vitest processes. A Postgres
// SESSION advisory lock is the only mechanism that covers both, so any suite
// whose work cannot safely interleave with another suite's takes this lock for
// its whole lifetime (acquire in `beforeAll`, release in `afterAll`).
//
// Enrol a suite here when it applies DDL (migration-shape suites) or otherwise
// holds locks that a sibling suite could invert. Suites that merely read and
// write rows under their own tenant do not need it. `ci:live-db-suites`
// enforces the DDL half of that rule.
//
// Named `feature-543-*` until #573 — it was introduced for one feature and
// became the shared protocol.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const LIVE_DB_LOCK_KEY = 'repworth_live_db_integration';
const LIVE_DB_LOCK_ACQUISITION_TIMEOUT_MS = 4 * 60_000;
const LIVE_DB_LOCK_SESSION_PREFIX = 'repworth_livedb_lock_';

export const LIVE_DB_LOCK_HOOK_TIMEOUT_MS = 5 * 60_000;

export interface LiveDbLock {
  release(): Promise<void>;
}

interface LiveDbLockTestOptions {
  lockKey: string;
  acquisitionTimeoutMs: number;
}

/**
 * Set to '1' to force every live-DB suite to skip, whatever `.env.local` says.
 *
 * `env -u TEST_DATABASE_POOL_URL` alone does NOT disable these suites: the
 * `.env.local` fallback below re-supplies the URL from disk, so the six suites
 * that gate on `resolveTestDatabaseUrl()` wake up anyway. A full-suite run that
 * wakes them is the #563 failure — whichever file initializes the
 * `src/lib/db/server` singleton first wins, and the rest get ECONNREFUSED.
 * The full-suite row of scripts/verify-gate.sh needs a way to guarantee they
 * stay asleep; this is it.
 */
const DISABLE_LIVE_DB_ENV = 'REPWORTH_DISABLE_LIVE_DB_SUITES';

export function liveDbSuitesDisabled(): boolean {
  return process.env[DISABLE_LIVE_DB_ENV] === '1';
}

export function resolveTestDatabaseUrl(): string | undefined {
  if (liveDbSuitesDisabled()) return undefined;
  if (process.env.TEST_DATABASE_POOL_URL) return process.env.TEST_DATABASE_POOL_URL;

  try {
    const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const line = raw.split('\n').find((candidate) =>
      /^\s*TEST_DATABASE_POOL_URL\s*=/.test(candidate),
    );
    return line
      ?.replace(/^\s*TEST_DATABASE_POOL_URL\s*=\s*/, '')
      .trim()
      .replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

export function assertLocalTestDatabaseUrl(
  databaseUrl: string | undefined,
): string {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }

  const isLocalPostgres =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!databaseUrl || !isLocalPostgres) {
    throw new Error('live-DB integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

export function liveDbLockSessionNameForTest(lockKey: string): string {
  return `${LIVE_DB_LOCK_SESSION_PREFIX}${lockKey.slice(-40)}`;
}

async function acquireLiveDbLockWithOptions(
  databaseUrl: string,
  options: LiveDbLockTestOptions,
): Promise<LiveDbLock> {
  if (
    !Number.isInteger(options.acquisitionTimeoutMs) ||
    options.acquisitionTimeoutMs <= 0 ||
    options.acquisitionTimeoutMs >= LIVE_DB_LOCK_HOOK_TIMEOUT_MS
  ) {
    throw new Error(
      'live-DB lock acquisition timeout must be positive and shorter than its hook timeout',
    );
  }

  const lockClient = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: {
      application_name: liveDbLockSessionNameForTest(options.lockKey),
      statement_timeout: options.acquisitionTimeoutMs,
    },
  });

  try {
    await lockClient`
      SELECT pg_advisory_lock(hashtext(${options.lockKey}))
    `;
  } catch (error) {
    try {
      await lockClient.end({ timeout: 5 });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'live-DB lock acquisition and client cleanup both failed',
      );
    }
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const [result] = await lockClient<{ unlocked: boolean }[]>`
          SELECT pg_advisory_unlock(hashtext(${options.lockKey})) AS unlocked
        `;
        if (!result?.unlocked) {
          throw new Error('live-DB lock was not held by its session');
        }
      } finally {
        await lockClient.end({ timeout: 5 });
      }
    },
  };
}

export async function acquireLiveDbLock(
  databaseUrl: string,
): Promise<LiveDbLock> {
  return acquireLiveDbLockWithOptions(databaseUrl, {
    lockKey: LIVE_DB_LOCK_KEY,
    acquisitionTimeoutMs: LIVE_DB_LOCK_ACQUISITION_TIMEOUT_MS,
  });
}

export async function acquireLiveDbLockForTest(
  databaseUrl: string,
  options: LiveDbLockTestOptions,
): Promise<LiveDbLock> {
  return acquireLiveDbLockWithOptions(databaseUrl, options);
}
