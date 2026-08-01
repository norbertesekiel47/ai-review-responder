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
} from '@/lib/shared/__tests__/helpers/schema-ready';

// Shape suite for migration 093 — the consent ledger `solicitation_consent`
// (#625; locked spec docs/superpowers/specs/2026-07-28-consent-ledger-design.md
// Part I §3). Current-state rows, monotone forward (D3): granted, then upgraded
// to a newer attestation version — never backward, because revocation lives in
// the suppression ledger, never here (D7). The governing asymmetry: consent
// fails closed; suppression fails open (DR1).
//
// The single sharpest fact this suite protects is an ABSENCE: 086 declared
// `contact_csv_uploads.attested_by_user_id` as `REFERENCES users(id) ON DELETE
// CASCADE`, so with FK provenance, offboarding one staff member would silently
// destroy the consent record for every list they ever uploaded (§3.4). The
// ledger's `attested_by_user_id` is therefore a PLAIN UUID with NO FK — an
// invariant no positive introspection query implies, so it is asserted
// explicitly below.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with assertSchemaReady, then introspects shape.

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(process.cwd(), 'supabase/migrations/093_solicitation_consent.sql');

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

describe('migration 093 checked-in SQL contract', () => {
  const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
  const statements = rawSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('exists', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('never references users(id) — 086’s staff-user cascade must not reach the ledger', () => {
    // §3.4: capture, do not join. A `REFERENCES users` here would make
    // deleting a staff member revoke consent nobody meant to revoke.
    expect(statements).not.toContain('REFERENCES users');
  });

  it('carries no revoked_at — revocation is the suppression ledger’s, permanently (D7)', () => {
    expect(statements).not.toContain('revoked_at');
  });

  it('carries no account_id — business-scoped only, per 086’s denormalization warning (§3.2)', () => {
    expect(statements).not.toContain('account_id');
  });
});

describeWithDb(
  'migration 093 live schema shape',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_093_SOLICITATION_CONSENT]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── columns: names, types, nullability, defaults ─────────────────────────

    it('has exactly the spec §3.1 columns with the locked types and nullability', async () => {
      const rows = await db!<
        { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'solicitation_consent'
        ORDER BY column_name
      `;
      const byName = new Map(rows.map((row) => [row.column_name, row]));

      expect([...byName.keys()].sort()).toEqual([
        'attestation_version',
        'attested_at',
        'attested_by_user_id',
        'basis',
        'business_id',
        'channel',
        'created_at',
        'id',
        'normalized_handle',
        'source_upload_id',
        'updated_at',
      ]);

      const expectShape = (column: string, dataType: string, nullable: 'YES' | 'NO') => {
        expect(byName.get(column)?.data_type, column).toBe(dataType);
        expect(byName.get(column)?.is_nullable, column).toBe(nullable);
      };
      expectShape('id', 'uuid', 'NO');
      expectShape('channel', 'text', 'NO');
      expectShape('normalized_handle', 'text', 'NO');
      expectShape('business_id', 'uuid', 'NO');
      expectShape('basis', 'text', 'NO');
      expectShape('attestation_version', 'text', 'NO');
      expectShape('attested_at', 'timestamp with time zone', 'NO');
      expectShape('attested_by_user_id', 'uuid', 'YES');
      expectShape('source_upload_id', 'uuid', 'YES');
      expectShape('created_at', 'timestamp with time zone', 'NO');
      expectShape('updated_at', 'timestamp with time zone', 'NO');

      expect(byName.get('created_at')?.column_default).toMatch(/now\(\)/i);
      expect(byName.get('updated_at')?.column_default).toMatch(/now\(\)/i);
      // UUIDv7 is worker-supplied (repo convention) — no DB default on the PK.
      expect(byName.get('id')?.column_default).toBeNull();
    });

    // ── constraints: PK, CHECKs, and the exact FK set ────────────────────────

    it('has a primary key on id and the two single-value CHECKs (email-only per DR3)', async () => {
      const constraints = await db!<{ conname: string; contype: string; definition: string }[]>`
        SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_consent'::regclass
      `;

      const primaryKey = constraints.find((c) => c.contype === 'p');
      expect(primaryKey?.definition).toBe('PRIMARY KEY (id)');

      const checks = constraints.filter((c) => c.contype === 'c').map((c) => c.definition);
      // Channel is widened per channel per DR3 — never by default: a contact
      // with a phone number gets NO sms row until an attestation names SMS.
      expect(checks.some((d) => /channel/.test(d) && d.includes("'email'"))).toBe(true);
      expect(checks.some((d) => /basis/.test(d) && d.includes("'owner_attested'"))).toBe(true);
    });

    it('has exactly two FKs — businesses CASCADE and contact_csv_uploads SET NULL — and NONE on attested_by_user_id', async () => {
      const foreignKeys = await db!<{ conname: string; definition: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_consent'::regclass AND contype = 'f'
      `;
      const definitions = foreignKeys.map((fk) => fk.definition);

      expect(
        definitions.some(
          (d) =>
            d.includes('FOREIGN KEY (business_id)') &&
            d.includes('REFERENCES businesses(id)') &&
            d.includes('ON DELETE CASCADE'),
        ),
      ).toBe(true);
      expect(
        definitions.some(
          (d) =>
            d.includes('FOREIGN KEY (source_upload_id)') &&
            d.includes('REFERENCES contact_csv_uploads(id)') &&
            d.includes('ON DELETE SET NULL'),
        ),
      ).toBe(true);

      // The absence assertion (§3.4): deleting a staff user must not cascade
      // into the consent ledger. Exactly-two makes a third, later-added FK as
      // loud as a wrong one.
      expect(definitions.some((d) => d.includes('attested_by_user_id'))).toBe(false);
      expect(foreignKeys).toHaveLength(2);
    });

    // ── indexes ──────────────────────────────────────────────────────────────

    it('has the TOTAL unique scope index (channel, normalized_handle, business_id)', async () => {
      const [row] = await db!<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'solicitation_consent_scope_uniq'
      `;
      expect(row).toBeDefined();
      expect(row!.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(row!.indexdef).toContain('(channel, normalized_handle, business_id)');
      // Total, not partial: no predicate, so the byte-for-byte ON CONFLICT
      // hazard (CLAUDE.md gotcha) cannot arise for §4.2's guarded upsert.
      expect(row!.indexdef).not.toContain(' WHERE ');
    });

    it('has the source_upload_id audit-pointer index', async () => {
      const [row] = await db!<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_solicitation_consent_source_upload'
      `;
      expect(row).toBeDefined();
      expect(row!.indexdef).toContain('(source_upload_id)');
    });

    // ── RLS posture ──────────────────────────────────────────────────────────

    it('has RLS enabled with ZERO policies — deny-all, invariant #14 posture', async () => {
      const [relation] = await db!<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity FROM pg_class
        WHERE oid = 'public.solicitation_consent'::regclass
      `;
      expect(relation?.relrowsecurity).toBe(true);

      const policies = await db!<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'solicitation_consent'
      `;
      // Server-owned, same posture as auto_approval_policies: owner-facing
      // consent state reaches the UI only as a withhold reason on an ask
      // (§6.1), never as a direct table read.
      expect(policies).toHaveLength(0);
    });
  },
);
