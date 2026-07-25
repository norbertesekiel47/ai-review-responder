import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const FEATURE_543_DATABASE_LOCK_KEY = 'repworth_feature_543_integration';
const FEATURE_543_DATABASE_LOCK_ACQUISITION_TIMEOUT_MS = 4 * 60_000;
const FEATURE_543_DATABASE_LOCK_SESSION_PREFIX = 'repworth_f543_lock_';

export const FEATURE_543_DATABASE_LOCK_HOOK_TIMEOUT_MS = 5 * 60_000;

export interface Feature543DatabaseLock {
  release(): Promise<void>;
}

interface Feature543DatabaseLockTestOptions {
  lockKey: string;
  acquisitionTimeoutMs: number;
}

export function resolveFeature543TestDatabaseUrl(): string | undefined {
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

export function assertFeature543LocalTestDatabaseUrl(
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
    throw new Error('feature 543 integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

export function feature543DatabaseLockSessionNameForTest(lockKey: string): string {
  return `${FEATURE_543_DATABASE_LOCK_SESSION_PREFIX}${lockKey.slice(-40)}`;
}

async function acquireFeature543DatabaseLockWithOptions(
  databaseUrl: string,
  options: Feature543DatabaseLockTestOptions,
): Promise<Feature543DatabaseLock> {
  if (
    !Number.isInteger(options.acquisitionTimeoutMs) ||
    options.acquisitionTimeoutMs <= 0 ||
    options.acquisitionTimeoutMs >= FEATURE_543_DATABASE_LOCK_HOOK_TIMEOUT_MS
  ) {
    throw new Error(
      'feature 543 database lock acquisition timeout must be positive and shorter than its hook timeout',
    );
  }

  const lockClient = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: {
      application_name: feature543DatabaseLockSessionNameForTest(options.lockKey),
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
        'feature 543 database lock acquisition and client cleanup both failed',
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
          throw new Error('feature 543 database lock was not held by its session');
        }
      } finally {
        await lockClient.end({ timeout: 5 });
      }
    },
  };
}

export async function acquireFeature543DatabaseLock(
  databaseUrl: string,
): Promise<Feature543DatabaseLock> {
  return acquireFeature543DatabaseLockWithOptions(databaseUrl, {
    lockKey: FEATURE_543_DATABASE_LOCK_KEY,
    acquisitionTimeoutMs: FEATURE_543_DATABASE_LOCK_ACQUISITION_TIMEOUT_MS,
  });
}

export async function acquireFeature543DatabaseLockForTest(
  databaseUrl: string,
  options: Feature543DatabaseLockTestOptions,
): Promise<Feature543DatabaseLock> {
  return acquireFeature543DatabaseLockWithOptions(databaseUrl, options);
}
