import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
  MIGRATION_098_SUPPRESSION_CORRECTIONS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { SUPPRESSION_SCOPES, SUPPRESSION_SOURCES } from '@/lib/solicitation/suppression';

// Shape suite for migration 098 — `solicitation_suppression_corrections`, the
// Correction path's audit sink (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §8.2).
//
// The table records one sentence per admin-removed Suppression ledger row:
// WHICH opt-out was removed, by WHOM, and WHY. Three facts about its shape carry
// the whole design, and each is asserted here against the LIVE schema rather
// than against the checked-in SQL text:
//
//  1. It has NO `account_id` and no foreign keys (plan P-2). The suppression row
//     is gone by the time the record is written — that is the point — so an FK
//     to it is impossible, and an FK to `accounts` would let an offboarding
//     purge CASCADE away a compliance record. Copying the deleted row's
//     `account_id` in would additionally make the table account-linked to
//     `accountLinkedTablesFromMigrations()` in
//     `src/lib/account-offboarding/__tests__/table-disposition.test.ts`, which
//     then demands `TENANT_TABLES` / `TABLE_DISPOSITIONS` / purge-verification
//     entries for a record that has no tenant.
//
//  2. `normalized_handle` STAYS (plan P-3). `suppression_id` points at a deleted
//     row, so without the handle the record cannot identify its own subject —
//     and an audit record that cannot do that is not one.
//
//  3. `reason` cannot be blank. It is the "WHY", and the CHECK is what makes a
//     blank one abort the single data-modifying CTE that both deletes the ledger
//     row and writes this record — so an unexplained correction cannot commit
//     the delete either.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with `assertSchemaReady`, then introspects shape
// and exercises the constraints. Every row inserted carries this run's handle
// prefix and is swept in `afterAll` — the table has no FKs and no tenant, so
// there is no `seedTenantAccount` to hang the fixtures off.

const testDatabaseUrl = resolveTestDatabaseUrl();

/** Unique per run, so the `afterAll` sweep can never touch another run's rows. */
const HANDLE_PREFIX = `correction-${randomUUID()}`;

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

interface CorrectionOverrides {
  channel?: string;
  scope?: string;
  source?: string;
  reason?: string;
}

/**
 * Inserts one correction record over a known-valid row, so a rejection can only
 * ever come from the overridden column. Every fixture pairs `scope` and `source`
 * the way migration 096's own CHECK requires: 098 deliberately does NOT
 * re-enforce that pairing (it copies whatever the deleted ledger row held, and
 * the ledger could not have held an illegal pair), but a fixture describing a
 * row the ledger could never have contained would be testing a fiction.
 */
function insertCorrection(overrides: CorrectionOverrides = {}): Promise<unknown> {
  const scope = overrides.scope ?? 'global';
  const source = overrides.source ?? (scope === 'account' ? 'owner_manual' : 'complaint');
  return db!`
    INSERT INTO solicitation_suppression_corrections
      (id, suppression_id, channel, normalized_handle, scope, source,
       suppressed_at, removed_by_user_id, reason)
    VALUES (
      ${randomUUID()}::uuid,
      ${randomUUID()}::uuid,
      ${overrides.channel ?? 'email'},
      ${`${HANDLE_PREFIX}-${randomUUID()}@test.local`},
      ${scope},
      ${source},
      NOW(),
      ${randomUUID()}::uuid,
      ${overrides.reason ?? 'admin typo on a mailbox reply'}
    )
    RETURNING id
  `;
}

describeWithDb(
  'migration 098 live schema shape',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_098_SUPPRESSION_CORRECTIONS]);
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          await db`
            DELETE FROM solicitation_suppression_corrections
            WHERE normalized_handle LIKE ${`${HANDLE_PREFIX}-%`}
          `;
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── columns ──────────────────────────────────────────────────────────────

    it('has exactly the correction audit columns with the locked types nullability and defaults', async () => {
      const columns = await db!<
        {
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'solicitation_suppression_corrections'
        ORDER BY column_name
      `;
      expect(columns.map((c) => c.column_name)).toEqual([
        'channel',
        'created_at',
        'id',
        'normalized_handle',
        'reason',
        'removed_by_user_id',
        'scope',
        'source',
        'suppressed_at',
        'suppression_id',
      ]);

      // Every column is NOT NULL: this record has no optional facts.
      expect(columns.filter((c) => c.is_nullable === 'YES')).toEqual([]);

      const byName = new Map(columns.map((column) => [column.column_name, column]));
      const expectType = (column: string, dataType: string) => {
        expect(byName.get(column)?.data_type, column).toBe(dataType);
      };
      expectType('id', 'uuid');
      // NO FK, but still a uuid: the referent is gone, not untyped.
      expectType('suppression_id', 'uuid');
      expectType('channel', 'text');
      expectType('normalized_handle', 'text');
      expectType('scope', 'text');
      expectType('source', 'text');
      expectType('suppressed_at', 'timestamp with time zone');
      expectType('removed_by_user_id', 'uuid');
      expectType('reason', 'text');
      expectType('created_at', 'timestamp with time zone');

      // id has NO database default — UUIDv7 is app-supplied (repo convention).
      expect(byName.get('id')?.column_default).toBeNull();
      // suppressed_at is COPIED from the removed row, so it must not default to
      // now(): defaulting would silently restamp the record with the moment of
      // the correction and lose when the opt-out was actually made.
      expect(byName.get('suppressed_at')?.column_default).toBeNull();
      expect(byName.get('created_at')?.column_default).toMatch(/now\(\)/i);
    });

    it('has no account-linked column, so the offboarding inventory correctly excludes it', async () => {
      // P-2 asserted against the schema rather than the plan: if a later change
      // adds account_id/business_id here, table-disposition.test.ts starts
      // failing and THIS test says why before anyone goes looking.
      const columns = await db!<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'solicitation_suppression_corrections'
      `;
      const names = columns.map((column) => column.column_name);
      expect(names).not.toContain('account_id');
      expect(names).not.toContain('business_id');
      // `removed_by_user_id` is deliberately spelled so it does NOT match
      // accountLinkedTablesFromMigrations()'s `\buser_id\b` — the leading
      // underscore blocks the word boundary. Named here so a future rename to
      // `user_id` is understood as a schema change with an inventory
      // consequence, not a tidy-up.
      expect(names).toContain('removed_by_user_id');
      expect(names).not.toContain('user_id');
    });

    // ── the closed value sets, exercised ─────────────────────────────────────

    it('enforces the authoritative suppression channel scope and source value sets', async () => {
      // Driven from the exported enums (the single authoritative owner of the
      // §3.1 value sets) so a divergence between TS and the DB fails HERE rather
      // than at the first production correction of a newly-added source.
      for (const source of SUPPRESSION_SOURCES) {
        await expect(insertCorrection({ source }), source).resolves.toBeDefined();
      }
      for (const scope of SUPPRESSION_SCOPES) {
        await expect(insertCorrection({ scope }), scope).resolves.toBeDefined();
      }

      // And the closed sets are closed: a value the ledger's own CHECKs would
      // have rejected cannot be smuggled in through the audit record either.
      await expect(insertCorrection({ channel: 'sms' })).rejects.toThrow(/check constraint/i);
      await expect(insertCorrection({ scope: 'everyone', source: 'complaint' })).rejects.toThrow(
        /check constraint/i,
      );
      await expect(insertCorrection({ source: 'unsubscribed' })).rejects.toThrow(
        /check constraint/i,
      );
    });

    // ── the deliberate absences ──────────────────────────────────────────────

    it('has no foreign keys to suppressions accounts or users so correction history survives its referents', async () => {
      const foreignKeys = await db!<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.solicitation_suppression_corrections'::regclass
          AND contype = 'f'
      `;
      // The absence IS the assertion. `suppression_id`'s referent is DELETEd by
      // the same statement that writes this row; an FK to `accounts` would let a
      // purge CASCADE away a compliance record; and `removed_by_user_id` follows
      // 096's `created_by_user_id` posture because the record must outlive the
      // user row it names.
      expect(foreignKeys).toEqual([]);
    });

    // ── index ────────────────────────────────────────────────────────────────

    it('indexes corrections by channel normalized handle and created_at descending', async () => {
      const [index] = await db!<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_solicitation_suppression_corrections_handle'
      `;
      expect(index).toBeDefined();
      // Column ORDER is the point: the admin lookup is handle-keyed and
      // newest-first, and it is the only way this table is ever queried.
      expect(index!.indexdef).toMatch(/\(channel, normalized_handle, created_at DESC\)/);
    });

    // ── behaviour: "why" is not optional ─────────────────────────────────────

    it('rejects every empty-or-whitespace reason and accepts a nonblank reason', async () => {
      // NOT NULL alone would have accepted every one of these. The CHECK is what
      // makes an unexplained correction abort the single data-modifying CTE —
      // and therefore abort the DELETE it is paired with.
      for (const blank of ['', ' ', '\t', '\n', '   ']) {
        await expect(insertCorrection({ reason: blank }), JSON.stringify(blank)).rejects.toThrow(
          /check constraint/i,
        );
      }
      await expect(
        insertCorrection({ reason: 'admin typo on a mailbox reply' }),
      ).resolves.toBeDefined();
    });

    // ── RLS posture ──────────────────────────────────────────────────────────

    it('is deny-all: RLS is enabled with zero policies', async () => {
      const [relation] = await db!<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity FROM pg_class
        WHERE oid = 'public.solicitation_suppression_corrections'::regclass
      `;
      expect(relation?.relrowsecurity).toBe(true);

      const policies = await db!<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'solicitation_suppression_corrections'
      `;
      // Not decorative (invariant #14's auto_approval_policies posture, matching
      // 096): a row here names a recipient's Normalized handle, so a direct
      // client read would expose that an identified person's opt-out was
      // removed.
      expect(policies).toHaveLength(0);
    });
  },
);
