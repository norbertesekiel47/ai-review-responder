// Unit coverage for the PostgreSQL major floor `assertSchemaReady` enforces
// before its schema checks (#1379).
//
// DELIBERATELY DB-FREE: it exercises the pure `serverMajorShortfall` over
// hand-built server rows, never names the test-database env var and opens no
// connection, so `ci:live-db-suites` does not classify it as a live-DB file.
// The query half (`assertServerMajor`) runs in every live-DB suite that calls
// `assertSchemaReady`, on CI's postgres:17 service.

import { describe, expect, it } from 'vitest';
import { REQUIRED_PG_MAJOR, serverMajorShortfall } from './schema-ready';

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
