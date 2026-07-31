import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_093_SOLICITATION_CONSENT,
  MIGRATION_095_CONSENT_BUSINESS_INDEX,
} from '@/lib/shared/__tests__/helpers/schema-ready';

// Shape suite for migration 095 — the business-leading compliance-delete index
// on solicitation_consent (#625 review round; Codex adversarial finding,
// 2026-07-30). The purge/offboarding DELETEs and the §7.1 contact-delete sweep
// filter by business_id (+ normalized_handle); 093's scope unique leads with
// channel and PG16 has no skip scan, so without this index those compliance
// deletes degrade to full-table scans on a no-TTL table.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with assertSchemaReady, then introspects shape.

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/095_consent_business_index.sql',
);

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

describe('migration 095 checked-in SQL contract', () => {
  const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
  const statements = rawSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('exists and creates only the business-leading index', () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS idx_solicitation_consent_business_handle',
    );
    expect(statements).toContain('(business_id, normalized_handle)');
  });
});

describeWithDb(
  'migration 095 live schema shape',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_093_SOLICITATION_CONSENT,
        MIGRATION_095_CONSENT_BUSINESS_INDEX,
      ]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    it('leads with business_id then normalized_handle, total and non-unique', async () => {
      const [row] = await db!<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_solicitation_consent_business_handle'
      `;
      expect(row).toBeDefined();
      expect(row!.indexdef).toContain('ON public.solicitation_consent');
      // Column ORDER is the finding: a handle-leading or channel-leading index
      // leaves the business-scoped compliance deletes unindexed under PG16.
      expect(row!.indexdef).toContain('(business_id, normalized_handle)');
      expect(row!.indexdef).not.toContain('UNIQUE');
      // Total, not partial: every compliance delete must be able to use it.
      expect(row!.indexdef).not.toContain(' WHERE ');
    });
  },
);
