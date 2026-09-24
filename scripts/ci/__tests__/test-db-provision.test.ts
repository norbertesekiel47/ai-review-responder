// DB-free tests for the #877 provisioning lock: the driver that
// scripts/test-db-setup.sh generates, the cross-language lock-key drift
// guard, the CI composite action's delegation, and the marker helpers in
// rls-audit.ts. The live lock SEMANTICS are covered separately by
// test-db-lock.integration.test.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIVE_DB_LOCK_KEY,
  PROVISION_MARKER_MISSING,
  computeProvisionHash,
  expectedProvisionHash,
  findProvisionFailure,
  readProvisionMarker,
  withSharedLiveDbLock,
  type LiveSql,
} from '../rls-audit';
import { LIVE_DB_LANE_KEY } from '../../../src/lib/shared/__tests__/helpers/live-db-lane';

const ROOT = resolve(__dirname, '../../..');

function readDriver(): string {
  const result = spawnSync('bash', ['scripts/test-db-setup.sh', '--print-driver'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('lock-key drift guard', () => {
  it('test-db-setup.sh spells the SAME advisory key as live-db-lock.ts', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-db-setup.sh'), 'utf8');
    expect(script).toContain(`LOCK_KEY='${LIVE_DB_LOCK_KEY}'`);
  });

  it('test-db-setup.sh spells the SAME lane key as live-db-lane.ts (#958)', () => {
    const script = readFileSync(join(ROOT, 'scripts/test-db-setup.sh'), 'utf8');
    expect(script).toContain(`LANE_KEY='${LIVE_DB_LANE_KEY}'`);
  });

  it('the lane key and the suite key are DIFFERENT keys — one key would self-deadlock a lane (#958)', () => {
    // A lane holds the lane key shared for its whole run while its own suites
    // take the suite key exclusive from other sessions of the same process. On
    // one key that exclusive request waits on the lane's own shared hold.
    expect(LIVE_DB_LANE_KEY).not.toBe(LIVE_DB_LOCK_KEY);
  });

  it('the CI composite action delegates to test-db-setup.sh and carries no psql loop of its own', () => {
    const action = readFileSync(join(ROOT, '.github/actions/test-db/action.yml'), 'utf8');
    expect(action).toContain('scripts/test-db-setup.sh');
    expect(action).not.toMatch(/for .*supabase\/migrations/);
  });
});

describe('provisioning driver generator (--print-driver)', () => {
  const driver = readDriver();
  const lines = driver.split('\n');
  const migrationFiles = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  it('acquires the lane key, THEN the suite key, exclusive, before any DDL, under a bounded timeout', () => {
    const statements = lines.filter((line) => line && !line.startsWith('--'));
    expect(statements[0]).toBe("SET statement_timeout = '240s';");
    // Lane key first (#958): it is what a lane BETWEEN two files still holds.
    // One fixed order for the pair is what keeps the two keys deadlock-free.
    expect(statements[1]).toBe(
      `SELECT pg_advisory_lock(hashtext('${LIVE_DB_LANE_KEY}'));`,
    );
    expect(statements[2]).toBe(
      `SELECT pg_advisory_lock(hashtext('${LIVE_DB_LOCK_KEY}'));`,
    );
    const lockIndex = driver.indexOf('pg_advisory_lock');
    expect(lockIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(driver.indexOf('DROP SCHEMA'));
  });

  it('drops test_meta before public, so an interrupted run leaves no stale marker', () => {
    expect(driver.indexOf('DROP SCHEMA IF EXISTS test_meta CASCADE;')).toBeLessThan(
      driver.indexOf('DROP SCHEMA IF EXISTS public CASCADE;'),
    );
  });

  it('emits RESET ALL after the bootstrap and after EVERY migration include', () => {
    const includeIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith('\\i '));
    expect(includeIndexes.length).toBe(1 + migrationFiles.length);
    for (const { line, index } of includeIndexes) {
      expect(lines[index + 1], `after ${line}`).toBe('RESET ALL;');
    }
  });

  it('covers the 103→104 boundary (migration 103 leaves a session-level search_path)', () => {
    const i103 = lines.findIndex((line) => /^\\i supabase\/migrations\/103_/.test(line));
    const i104 = lines.findIndex((line) => /^\\i supabase\/migrations\/104_/.test(line));
    expect(i103).toBeGreaterThan(-1);
    expect(i104).toBe(i103 + 2);
    expect(lines[i103 + 1]).toBe('RESET ALL;');
  });

  it('includes every migration exactly once, in order', () => {
    const included = lines
      .filter((line) => line.startsWith('\\i supabase/migrations/'))
      .map((line) => line.replace('\\i supabase/migrations/', ''));
    expect(included).toEqual(migrationFiles);
  });

  it('writes the marker as the LAST statement, with the hash rls-audit recomputes', () => {
    const statements = lines.filter((line) => line && !line.startsWith('--'));
    expect(statements[statements.length - 1]).toMatch(
      /^VALUES \('[0-9a-f]{64}', '\d+_.+\.sql'\);$/,
    );
    const hashMatch = driver.match(/VALUES \('([0-9a-f]{64})'/);
    expect(hashMatch?.[1]).toBe(expectedProvisionHash());
  });

  it('hash parity: shell shasum concatenation === computeProvisionHash', () => {
    const bootstrap = readFileSync(join(ROOT, 'scripts/ci/test-db-bootstrap.sql'), 'utf8');
    const contents = migrationFiles.map((file) =>
      readFileSync(join(ROOT, 'supabase/migrations', file), 'utf8'),
    );
    const nodeHash = createHash('sha256')
      .update(bootstrap + contents.join(''))
      .digest('hex');
    expect(computeProvisionHash([bootstrap, ...contents])).toBe(nodeHash);
    expect(driver).toContain(`'${nodeHash}'`);
  });
});

type QueryLogSql = LiveSql & { calls: string[] };

function fakeSql(handler: (query: string) => Record<string, unknown>[]): QueryLogSql {
  const calls: string[] = [];
  const sql = (async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const query = strings.join(params.map(String).join(''));
    calls.push(query.trim());
    return handler(query);
  }) as QueryLogSql;
  sql.calls = calls;
  return sql;
}

function throwingSql(code: string): LiveSql {
  return async () => {
    const error = new Error(`fake ${code}`) as Error & { code: string };
    error.code = code;
    throw error;
  };
}

describe('provision marker helpers', () => {
  it('an absent test_meta SCHEMA (3F000) reads as marker missing', async () => {
    await expect(readProvisionMarker(throwingSql('3F000'))).resolves.toBe(
      PROVISION_MARKER_MISSING,
    );
  });

  it('an absent provision TABLE (42P01) reads as marker missing', async () => {
    await expect(readProvisionMarker(throwingSql('42P01'))).resolves.toBe(
      PROVISION_MARKER_MISSING,
    );
  });

  it('an empty marker table reads as marker missing', async () => {
    await expect(readProvisionMarker(fakeSql(() => []))).resolves.toBe(
      PROVISION_MARKER_MISSING,
    );
  });

  it('any other database error propagates — never swallowed into "missing"', async () => {
    await expect(readProvisionMarker(throwingSql('57014'))).rejects.toThrow('fake 57014');
  });

  it('a matching hash passes; a mismatch and a missing marker fail with ONE actionable line', () => {
    expect(findProvisionFailure({ contentHash: 'abc' }, 'abc')).toBeUndefined();
    expect(findProvisionFailure({ contentHash: 'abc' }, 'def')).toContain(
      'run pnpm test:db:setup',
    );
    expect(findProvisionFailure(PROVISION_MARKER_MISSING, 'abc')).toContain(
      'run pnpm test:db:setup',
    );
  });
});

describe('withSharedLiveDbLock', () => {
  it('acquires shared, runs the body, releases shared', async () => {
    const sql = fakeSql(() => []);
    const result = await withSharedLiveDbLock(sql, async () => 'body-ran');
    expect(result).toBe('body-ran');
    expect(sql.calls[0]).toContain('pg_advisory_lock_shared');
    expect(sql.calls[sql.calls.length - 1]).toContain('pg_advisory_unlock_shared');
  });

  it('GUARANTEES the unlock when the body throws, and propagates the error', async () => {
    const sql = fakeSql(() => []);
    await expect(
      withSharedLiveDbLock(sql, async () => {
        throw new Error('body exploded');
      }),
    ).rejects.toThrow('body exploded');
    expect(sql.calls[sql.calls.length - 1]).toContain('pg_advisory_unlock_shared');
  });
});
