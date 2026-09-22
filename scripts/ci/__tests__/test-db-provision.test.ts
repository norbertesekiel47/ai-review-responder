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

  it('the CI composite action delegates to test-db-setup.sh and carries no psql loop of its own', () => {
    const action = readFileSync(join(ROOT, '.github/actions/test-db/action.yml'), 'utf8');
    expect(action).toContain('scripts/test-db-setup.sh');
    expect(action).not.toMatch(/for .*supabase\/migrations/);
  });
});

describe('PostgreSQL major drift guard (#1379)', () => {
  // Read as TEXT, not imported: importing a live-DB helper module would make
  // ci:live-db-suites classify this DB-free file as a live-DB suite.
  const script = readFileSync(join(ROOT, 'scripts/test-db-setup.sh'), 'utf8');
  const ownerMatch = /^REQUIRED_PG_MAJOR=(\d+)$/m.exec(script);
  const REQUIRED_PG_MAJOR = Number(ownerMatch?.[1]);

  it('test-db-setup.sh owns the major, and schema-ready.ts spells the SAME value', () => {
    expect(ownerMatch, 'REQUIRED_PG_MAJOR=<n> in test-db-setup.sh').not.toBeNull();
    // Path built from segments: the joined spelling is a ci:live-db-suites marker.
    const helper = readFileSync(
      join(ROOT, 'src/lib/shared/__tests__', 'helpers', 'schema-ready.ts'),
      'utf8',
    );
    expect(helper).toContain(`export const REQUIRED_PG_MAJOR = ${REQUIRED_PG_MAJOR};`);
  });

  it.each(['.github/workflows/ci.yml', '.github/workflows/e2e.yml'])(
    '%s runs every postgres service on the required major',
    (workflow) => {
      const yaml = readFileSync(join(ROOT, workflow), 'utf8');
      const images = [...yaml.matchAll(/image:\s*postgres:(\S+)/g)].map((match) => match[1]);
      expect(images.length).toBeGreaterThan(0);
      expect(images).toEqual(images.map(() => String(REQUIRED_PG_MAJOR)));
    },
  );

  it('the driver refuses a server below the major BEFORE any DDL', () => {
    const driver = readDriver();
    const guard = driver.indexOf(
      `IF current_setting('server_version_num')::int < ${REQUIRED_PG_MAJOR * 10_000} THEN RAISE EXCEPTION`,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(driver.indexOf('DROP SCHEMA'));
  });
});

describe('provisioning driver generator (--print-driver)', () => {
  const driver = readDriver();
  const lines = driver.split('\n');
  const migrationFiles = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  it('acquires the exclusive advisory lock before any DDL, under a bounded timeout', () => {
    const statements = lines.filter((line) => line && !line.startsWith('--'));
    expect(statements[0]).toBe("SET statement_timeout = '240s';");
    expect(statements[1]).toBe(
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
