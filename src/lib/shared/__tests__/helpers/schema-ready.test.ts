// Unit coverage for the PostgreSQL major floor `assertSchemaReady` enforces
// before its schema checks (#1379), plus the drift guard that keeps the one
// owner — `REQUIRED_PG_MAJOR` in scripts/test-db-setup.sh — in step with this
// module's copy and with CI's `postgres:<major>` service images.
//
// DELIBERATELY DB-FREE: it exercises the pure `serverMajorShortfall` over
// hand-built server rows and reads the script/workflows as TEXT; it never
// names the test-database env var and opens no connection, so
// `ci:live-db-suites` does not classify it as a live-DB file. The query half
// (`assertServerMajor`) runs in every live-DB suite that calls
// `assertSchemaReady`, on CI's postgres:17 service.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_PG_MAJOR, serverMajorShortfall } from './schema-ready';

const ROOT = resolve(__dirname, '../../../../..');

describe('serverMajorShortfall — the test DB PostgreSQL major floor', () => {
  it('requires PostgreSQL 17, the major CI and both Supabase projects run', () => {
    expect(REQUIRED_PG_MAJOR).toBe(17);
  });

  it('admits the first PG17 release and anything later', () => {
    expect(serverMajorShortfall({ versionNum: 170000, version: '17.0' })).toBeNull();
    expect(serverMajorShortfall({ versionNum: 170006, version: '17.6 (Debian 17.6-1.pgdg13+1)' })).toBeNull();
    expect(serverMajorShortfall({ versionNum: 180001, version: '18.1' })).toBeNull();
  });

  it('refuses the last PG16 release, naming the version it found and the fix', () => {
    const message = serverMajorShortfall({ versionNum: 169999, version: '16.99' });
    expect(message).not.toBeNull();
    expect(message).toContain('behind the required PostgreSQL major');
    expect(message).toContain('it runs 16.99');
    expect(message).toContain('postgres:17');
    expect(message).toContain('pnpm test:db:setup');
  });

  it('refuses a real PG16 container version string', () => {
    expect(serverMajorShortfall({ versionNum: 160010, version: '16.10 (Debian 16.10-1.pgdg13+1)' })).toContain(
      'it runs 16.10',
    );
  });

  it('refuses when the server returned no row, rather than passing vacuously', () => {
    expect(serverMajorShortfall(undefined)).toContain('an unknown version');
  });
});

describe('PostgreSQL major drift guard — scripts/test-db-setup.sh is the owner', () => {
  const script = readFileSync(join(ROOT, 'scripts/test-db-setup.sh'), 'utf8');

  it('the script declares REQUIRED_PG_MAJOR, and this module spells the SAME value', () => {
    const owner = /^REQUIRED_PG_MAJOR=(\d+)$/m.exec(script);
    expect(owner, 'REQUIRED_PG_MAJOR=<n> in test-db-setup.sh').not.toBeNull();
    expect(Number(owner?.[1])).toBe(REQUIRED_PG_MAJOR);
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

  it('the provisioning driver refuses a server below the major BEFORE any DDL', () => {
    const result = spawnSync('bash', ['scripts/test-db-setup.sh', '--print-driver'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const guard = result.stdout.indexOf(
      `IF current_setting('server_version_num')::int < ${REQUIRED_PG_MAJOR * 10_000} THEN RAISE EXCEPTION`,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(result.stdout.indexOf('DROP SCHEMA'));
  });
});
