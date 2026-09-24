// The LANE half of the live-DB coordination protocol (#958).
//
// The shared local test database is coordinated by two Postgres advisory keys:
//
//   LIVE_DB_LANE_KEY  ('repworth_live_db_lane') — the DATABASE-LIFETIME key.
//       Every process that uses the schema holds it SHARED for its whole run:
//       the vitest `integration` project (globalSetup → teardown, so the lease
//       spans every file of the lane, not one suite at a time) and Playwright
//       (globalSetup → teardown). `scripts/test-db-setup.sh` takes it
//       EXCLUSIVE, first, in the same psql session as its DDL — so provisioning
//       waits for every running lane, and no lane starts while it runs.
//
//   LIVE_DB_LOCK_KEY  ('repworth_live_db_integration', live-db-lock.ts) — the
//       SUITE key, unchanged since #573. Suites that must not interleave with a
//       sibling suite in another process (every DDL suite, plus the suites that
//       opted in) hold it EXCLUSIVE for their lifetime; provisioning also takes
//       it exclusive, second, and `ci:rls-audit` holds it shared.
//
// Why two keys and not one: a lane holding the suite key shared while one of
// its own suites asks for it exclusive, from a different session of the same
// process, waits on ITSELF until the acquisition timeout — the self-deadlock the
// #877 review predicted. The lane key is therefore never taken by anything
// running INSIDE a lane; `ci:live-db-suites` flags any lane file that names it.
//
// Why a lane lease and not a per-suite one: the integration project runs its
// FILES serially, so a lease acquired per suite is released between files, and
// that window is exactly where a sibling worktree's provisioning slipped in.
//
// Every shared acquisition validates the `test_meta.provision` marker (a hash
// of the ordered bootstrap + migrations) immediately after the lock is granted:
// a lane that starts after an interrupted or behind-head provision fails once,
// with one actionable line, instead of running every suite against the wrong
// schema.
//
// Test-helper only — never imported by production code.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

export const LIVE_DB_LANE_KEY = 'repworth_live_db_lane';

/** Database-side bound on the shared-lock wait (statement_timeout). */
export const LIVE_DB_LANE_ACQUISITION_TIMEOUT_MS = 4 * 60_000;

/**
 * Client-side bound on the whole acquisition hook — deliberately LONGER than
 * the database-side timeout, so a slow provision surfaces as Postgres's own
 * statement-timeout error, and this one fires only when the server stops
 * answering at all (a hung connect, a dead socket).
 */
export const LIVE_DB_LANE_HOOK_TIMEOUT_MS = 5 * 60_000;

const LANE_SESSION_PREFIX = 'repworth_livedb_lane_';

// ---------------------------------------------------------------------------
// Provision marker (#877). One owner: ci:rls-audit re-exports these.

/** A minimal tagged-template query surface — what the marker helpers need. */
export type LiveSql = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Record<string, unknown>[]>;

export const PROVISION_MARKER_MISSING = 'provision_marker_missing';

/**
 * Hash of the ordered bootstrap + migration file contents — byte-for-byte the
 * value scripts/test-db-setup.sh records in `test_meta.provision`
 * (`cat bootstrap migrations… | shasum -a 256`). Hashing CONTENT rather than
 * the head filename means an edit to an existing migration or to the
 * bootstrap also reads as not-at-head.
 */
export function computeProvisionHash(orderedSqlContents: readonly string[]): string {
  const hash = createHash('sha256');
  for (const content of orderedSqlContents) hash.update(content);
  return hash.digest('hex');
}

export function expectedProvisionHash(root: string = process.cwd()): string {
  const migrationsDir = resolve(root, 'supabase/migrations');
  const bootstrap = readFileSync(resolve(root, 'scripts/ci/test-db-bootstrap.sql'), 'utf8');
  const migrations = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), 'utf8'));
  return computeProvisionHash([bootstrap, ...migrations]);
}

/**
 * Reads the provisioning marker. An absent `test_meta` schema (3F000), absent
 * table (42P01), or empty table all mean the same thing: no completed
 * provision — an interrupted run clears the marker before touching `public`
 * and rewrites it only as its final statement.
 */
export async function readProvisionMarker(
  sql: LiveSql,
): Promise<{ contentHash: string } | typeof PROVISION_MARKER_MISSING> {
  let rows: Record<string, unknown>[];
  try {
    rows = await sql`SELECT content_hash FROM test_meta.provision`;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '3F000' || code === '42P01') return PROVISION_MARKER_MISSING;
    throw error;
  }
  const contentHash = rows[0]?.content_hash;
  return typeof contentHash === 'string' ? { contentHash } : PROVISION_MARKER_MISSING;
}

export function findProvisionFailure(
  marker: { contentHash: string } | typeof PROVISION_MARKER_MISSING,
  expectedHash: string,
): string | undefined {
  if (marker === PROVISION_MARKER_MISSING || marker.contentHash !== expectedHash) {
    return 'test DB provisioning incomplete or behind head — run pnpm test:db:setup';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The lane lease and its lifecycle contract.

/** One dedicated session: the lease lives exactly as long as it does. */
export interface LaneLeaseSession {
  sql: LiveSql;
  end(): Promise<void>;
}

export interface LaneLease {
  /** `application_name` of the holding session — how a suite can see the lease in pg_locks. */
  readonly applicationName: string;
  readonly lockKey: string;
  release(): Promise<void>;
}

export interface LaneLeaseOptions {
  lockKey: string;
  applicationName: string;
  /** Database-side bound; enforced by the session's statement_timeout. */
  acquisitionTimeoutMs: number;
  /** Client-side bound on the whole hook; must exceed `acquisitionTimeoutMs`. */
  hookTimeoutMs: number;
  expectedHash: string;
  open(applicationName: string): LaneLeaseSession;
}

export class LaneLeaseTimeoutError extends Error {
  constructor(hookTimeoutMs: number) {
    super(
      `live-DB lane lease: no answer from the test database within ${hookTimeoutMs}ms — ` +
        'the session was closed; is the container up?',
    );
    this.name = 'LaneLeaseTimeoutError';
  }
}

async function closeAfterFailure(session: LaneLeaseSession, error: unknown): Promise<never> {
  try {
    await session.end();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      'live-DB lane lease acquisition and session cleanup both failed',
    );
  }
  throw error;
}

/**
 * Takes the lane key SHARED on a dedicated session, then validates the
 * provision marker on that same session before returning.
 *
 * Contract (each clause is pinned by live-db-lane.test.ts):
 *  - `hookTimeoutMs` > `acquisitionTimeoutMs`, or it refuses before connecting;
 *  - a marker that is missing or stale unlocks, closes the session, and throws
 *    the one actionable line — the caller's suites never start;
 *  - ANY acquisition failure, including the client-side timeout, closes the
 *    session (which is also what releases a lock granted late);
 *  - `release()` is idempotent, and a lease that was no longer held when it was
 *    released — the session dropped mid-lane, so the lane ran UNPROTECTED — is
 *    reported as an error rather than passing silently, as is a provision
 *    marker that changed while the lane held the lease (a provisioner that
 *    bypassed the lane key rebuilt the schema under it).
 */
export async function acquireLaneLease(options: LaneLeaseOptions): Promise<LaneLease> {
  if (
    !Number.isInteger(options.acquisitionTimeoutMs) ||
    options.acquisitionTimeoutMs <= 0 ||
    options.hookTimeoutMs <= options.acquisitionTimeoutMs
  ) {
    throw new Error(
      'live-DB lane lease: the hook timeout must exceed the positive database-side acquisition timeout',
    );
  }

  const { lockKey, applicationName } = options;
  const session = options.open(applicationName);

  const work = (async (): Promise<void> => {
    await session.sql`SELECT pg_advisory_lock_shared(hashtext(${lockKey}))`;
    const failure = findProvisionFailure(
      await readProvisionMarker(session.sql),
      options.expectedHash,
    );
    if (failure !== undefined) {
      await session.sql`SELECT pg_advisory_unlock_shared(hashtext(${lockKey}))`;
      throw new Error(failure);
    }
  })();
  // The race below may settle first; the losing branch must not surface later
  // as an unhandled rejection once the session is closed underneath it.
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LaneLeaseTimeoutError(options.hookTimeoutMs)), options.hookTimeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } catch (error) {
    return closeAfterFailure(session, error);
  } finally {
    clearTimeout(timer);
  }

  let released = false;
  return {
    applicationName,
    lockKey,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        // Re-read the marker BEFORE unlocking: a provisioner that does not take
        // the lane key — a worktree still on the pre-#958 test-db-setup.sh —
        // can rebuild the schema mid-lane, and that must not pass as green.
        const markerAtRelease = findProvisionFailure(
          await readProvisionMarker(session.sql),
          options.expectedHash,
        );
        const [row] = await session.sql`
          SELECT pg_advisory_unlock_shared(hashtext(${lockKey})) AS unlocked
        `;
        if (row?.unlocked !== true) {
          throw new Error(
            'live-DB lane lease was not held at release — its session dropped mid-lane, ' +
              'so the lane ran unprotected against provisioning',
          );
        }
        if (markerAtRelease !== undefined) {
          throw new Error(
            'live-DB lane: the test DB was re-provisioned DURING this lane by a process that ' +
              'does not take the lane key (a worktree on the pre-#958 test-db-setup.sh?) — ' +
              'results are unreliable; rebase that worktree, then re-run',
          );
        }
      } finally {
        await session.end();
      }
    },
  };
}

/** A postgres.js session tuned to hold a lock for the life of a lane. */
export function openPostgresLeaseSession(
  databaseUrl: string,
  applicationName: string,
  statementTimeoutMs: number,
): LaneLeaseSession {
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    // postgres.js recycles a connection after a RANDOM 30–60 minutes by default
    // (max_lifetime) — for a lease that is a silent release mid-lane. 0 disables
    // the timer; idle_timeout is already off by default and stays off.
    max_lifetime: 0,
    idle_timeout: 0,
    onnotice: () => undefined,
    connection: {
      application_name: applicationName,
      statement_timeout: statementTimeoutMs,
    },
  });
  return {
    // postgres.js's Sql is structurally a LiveSql at runtime (tagged template →
    // thenable rows); its declared parameter types are narrower, hence the cast.
    sql: client as unknown as LiveSql,
    end: () => client.end({ timeout: 5 }),
  };
}

function isLocalPostgresUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return (
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function isConnectionRefused(error: unknown): boolean {
  const candidate = error as { code?: string; errors?: unknown[] } | null;
  if (candidate?.code === 'ECONNREFUSED') return true;
  // `localhost` resolves to both ::1 and 127.0.0.1; Node reports a refusal on
  // every address as an AggregateError whose members carry the code.
  return Array.isArray(candidate?.errors) && candidate.errors.length > 0
    && candidate.errors.every(isConnectionRefused);
}

export type LaneLeaseDecision =
  | { kind: 'held'; lease: LaneLease }
  | { kind: 'skipped'; reason: string };

/**
 * The lease a whole test lane (vitest `integration` project, Playwright run)
 * holds on `databaseUrl` — the caller passes the URL its own suites resolve
 * (vitest: `resolveTestDatabaseUrl()`, Playwright: `TEST_DATABASE_POOL_URL`).
 *
 * Skips — returning why — only when there is nothing to protect: no test
 * database configured (or `REPWORTH_DISABLE_LIVE_DB_SUITES=1`), a database that
 * is not the shared LOCAL one this protocol governs (the Playwright deep-auth
 * tier points at staging, which has no marker and must never be locked from
 * here), or a local server that refuses the connection outright — nothing can
 * touch a database that is not listening, and every suite that tries fails on
 * its own. Everything else (a stale marker, a lock timeout) THROWS.
 */
export async function openLiveDbLaneLease(
  databaseUrl: string | undefined,
  root: string = process.cwd(),
): Promise<LaneLeaseDecision> {
  if (!databaseUrl) return { kind: 'skipped', reason: 'no test database configured' };
  if (!isLocalPostgresUrl(databaseUrl)) {
    return { kind: 'skipped', reason: 'the test database is not the shared local one' };
  }
  try {
    const lease = await acquireLaneLease({
      lockKey: LIVE_DB_LANE_KEY,
      applicationName: `${LANE_SESSION_PREFIX}${process.pid}`,
      acquisitionTimeoutMs: LIVE_DB_LANE_ACQUISITION_TIMEOUT_MS,
      hookTimeoutMs: LIVE_DB_LANE_HOOK_TIMEOUT_MS,
      expectedHash: expectedProvisionHash(root),
      open: (applicationName) =>
        openPostgresLeaseSession(databaseUrl, applicationName, LIVE_DB_LANE_ACQUISITION_TIMEOUT_MS),
    });
    return { kind: 'held', lease };
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { kind: 'skipped', reason: 'the local test database refused the connection' };
    }
    throw error;
  }
}
