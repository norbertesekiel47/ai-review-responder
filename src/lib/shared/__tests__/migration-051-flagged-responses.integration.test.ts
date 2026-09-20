// Execute migration 051 under the exclusive local DB lock; never infer its
// safety from SQL text.
//
// Migration 051 creates `flagged_responses`: high-confidence unsafe generated
// drafts held OUT of the owner approval-notification path until an admin
// dispositions them (architecture invariant #4). Deny-all RLS, admin-only. Its
// partial unique index `idx_flagged_responses_open_response ON (response_id)
// WHERE status = 'open'` is what stops idempotent re-runs of response
// generation from stacking duplicate open flags.
//
// The predecessor suite (`migration-051-structure.test.ts`, deleted by this
// change) proved the migration by pattern-matching its SQL TEXT and lost five
// red-team passes on #1171. This suite stops parsing the file and starts
// running it, on the shared `migration-guard.ts` helper: PostgreSQL is the
// parser now.
//
// ── the two oracles ──────────────────────────────────────────────────────────
//
// ORACLE A (title 2) is a full pinned head posture — literals captured
// independently of the migration file (`.feature/oracle-a-literals.txt`). This
// is what catches a WEAKENED migration on a freshly provisioned container:
// `pnpm test:db:setup` provisions the container FROM the migration under test,
// so oracle B alone is circular — a weakened migration yields a weakened
// BEFORE reading and `AFTER == BEFORE` would pass regardless. Title 2 carries
// the full 051 contract: both guarded `pg_get_indexdef` strings, the complete
// 14-column inventory (type + nullability), all SIX `pg_get_constraintdef`
// foreign-key strings (`response_id`, `account_id`, `business_id`, `review_id`
// all ON DELETE CASCADE; `api_cost_id` ON DELETE SET NULL; `reviewed_by_user_id`
// with no action — an earlier draft of the plan said five and omitted the
// last; the catalogue says six), and the three CHECK definitions on `source`,
// `severity` and `status`.
//
// A sibling suite's 048 head-posture case carries a combined title
// (`head posture pins migration 048 defaults and foreign keys and migration
// 051 columns and foreign keys`) for ITS half of the contract; this file does
// not create that title. Title 2 below is 051's own, independent home for the
// same literals.
//
// ORACLE B (titles 3-4) degrades `flagged_responses` to the pre-051 posture —
// both guarded indexes dropped and RLS disabled — inside a transaction that
// ALWAYS rolls back, proves the degrade landed so the case cannot pass
// vacuously against a no-op migration, applies the checked-in file VERBATIM,
// and diffs the whole `public` catalogue against the before-read — including
// every OTHER table, because a migration may harden the one table it names
// while doing arbitrary damage elsewhere (migration 119's off-target
// `GRANT ALL ON admin_audit_log TO anon;` red-team round).
//
// The fifth case (row preservation) seeds one real `flagged_responses` row —
// with its four NOT NULL parents (`accounts`, `businesses`, `reviews`,
// `responses`) inserted first under fixed fixture ids — and asserts the whole
// record (`SELECT *`, not selected fields) is byte-identical after a verbatim
// re-apply. A row COUNT cannot see this: unchanged by an UPDATE that rewrites
// every value, and vacuous on an empty container where a DELETE has nothing to
// delete. `api_cost_id` and `reviewed_by_user_id` stay NULL — both nullable,
// so no `api_costs` or extra `users` row is needed for them; the one `users`
// row seeded here backs `accounts.owner_user_id`, an unavoidable structural
// requirement of inserting any `accounts` row, not a parent of
// `flagged_responses` itself.
//
// ── stated limits ───────────────────────────────────────────────────────────
//
// The three inline CHECK constraints and the column definitions live in the
// `CREATE TABLE` body, which `IF NOT EXISTS` skips at head — a re-apply cannot
// restore them if they were dropped, so oracle B does not attempt to guard
// them (dropping them would make the guard fail for a reason that is not a
// regression). Oracle A pins them instead, independently of the migration
// file. The DB-free registry case is the only one that cannot silently skip;
// the other four sit behind `describeWithDb` and need a database.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  assertDegradeLanded,
  assertOnlyTablesMoved,
  readMigrationSql,
  readPublicCatalogue,
  withRolledBackTransaction,
  type CatalogueEntry,
  type PublicCatalogue,
} from '@/lib/shared/__tests__/helpers/migration-guard';
import { auditLiveDbFile } from '../../../../scripts/ci/live-db-suites-audit';

const TABLE = 'flagged_responses';
const MIGRATION_FILE = '051_flagged_responses.sql';
const SUITE_FILE =
  'src/lib/shared/__tests__/migration-051-flagged-responses.integration.test.ts';
const BEHIND_HEAD =
  'flagged_responses posture is not at migration head — run pnpm test:db:setup';

// Fixed fixture ids for the row-preservation case. Everything here rolls
// back, so these never persist and never collide with another suite's data —
// "fixed" so the fixture is readable and reproducible, not derived from a
// lookup.
const FIXTURE_USER_ID = '00000000-0000-4000-8000-000000000151';
const FIXTURE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000251';
const FIXTURE_BUSINESS_ID = '00000000-0000-4000-8000-000000000351';
const FIXTURE_REVIEW_ID = '00000000-0000-4000-8000-000000000451';
const FIXTURE_RESPONSE_ID = '00000000-0000-4000-8000-000000000551';
const FIXTURE_FLAGGED_RESPONSE_ID = '00000000-0000-4000-8000-000000000651';

const TABLE_COMMENT =
  'High-confidence unsafe drafts held out of the owner approval path until admin disposition (Wave 3 PR 3a/3b). Admin-only (deny-all RLS).';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 051 integration database was not initialized');
  return db;
}

// ── registry: no database needed, so this one can never silently skip ───────

describe('migration 051 registries', () => {
  it('migration 051 suite is registered in MIGRATION_SHAPE_FILES', () => {
    // `MIGRATION_SHAPE_FILES` is a module-private `const` in
    // `scripts/ci/live-db-suites-audit.ts` (outside this suite's lease, not
    // exported) — so this reads the EFFECT through the audit's exported entry
    // point instead of the set membership directly. Running `auditLiveDbFile`
    // against this suite's own real source text yields zero findings ONLY
    // because this exact path is a `MIGRATION_SHAPE_FILES` member AND this
    // file's text names the cross-process lock marker
    // (`acquireLiveDbLock`, imported and called above). Drop the entry, typo
    // this path, or rename the lock call away, and this reports a
    // `runtime-ddl` or `unlocked-ddl` finding — so this catches every
    // regression a direct membership read would, plus the lock one.
    const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
    expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
  });
});

describeWithDb(
  'migration 051 flagged_responses deny-all RLS and guarded indexes',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        // max: 1, not 2 — every case here runs the checked-in migration
        // verbatim through `unsafe` inside a transaction it also owns
        // (`withRolledBackTransaction`), and postgres.js refuses a
        // transaction-bearing `unsafe` on a pooled client
        // (`UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`)
        // because it cannot guarantee the statements land on one backend.
        // Every case here is sequential, so a single connection costs
        // nothing.
        max: 1,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) await db.end({ timeout: 5 });
      } finally {
        await featureDatabaseLock?.release();
        featureDatabaseLock = undefined;
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── ORACLE A: pinned head posture, independent of the migration file ────

    it('head posture pins the flagged_responses table comment', async () => {
      // #1301 RT-12. No suite in this family pinned its table comment, and
      // deleting 117's `COMMENT ON TABLE` survived 13 of 13 red-team runs.
      // Oracle B cannot carry it either: the comment is re-applied by the
      // migration, so a weakened file yields a weakened `before` and
      // `after === before` still passes. Only a literal pinned HERE breaks
      // that circle. Migration 118 already pinned its own, with a written
      // rationale; this is the missed sibling case.
      await withRolledBackTransaction(sql(), async (tx) => {
        const catalogue = await readPublicCatalogue(tx);
        expect(catalogue.tables[TABLE]?.comment, BEHIND_HEAD).toBe(TABLE_COMMENT);
      });
    });

    it('flagged_responses carries row security enabled and no policy at head', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        const catalogue = await readPublicCatalogue(tx);
        const table = catalogue.tables[TABLE];
        expect(table, BEHIND_HEAD).toBeDefined();

        expect(table?.rowSecurity, BEHIND_HEAD).toBe(true);
        expect(table?.forceRowSecurity, BEHIND_HEAD).toBe(false);
        // Zero policies IS the guarantee, not an omission: deny-all is the
        // design, so any policy at all would be a wider door than the
        // product needs.
        expect(table?.policies, BEHIND_HEAD).toEqual([]);

        // The full column inventory — types and nullability — pinned from
        // .feature/oracle-a-literals.txt, independent of the migration file.
        const expectedColumns: CatalogueEntry[] = [
          { name: 'account_id', definition: 'uuid NOT NULL identity=none generated=none' },
          { name: 'api_cost_id', definition: 'uuid NULL identity=none generated=none' },
          { name: 'business_id', definition: 'uuid NOT NULL identity=none generated=none' },
          {
            name: 'created_at',
            definition: 'timestamp with time zone NOT NULL identity=none generated=none',
          },
          { name: 'id', definition: 'uuid NOT NULL identity=none generated=none' },
          { name: 'reason', definition: 'text NULL identity=none generated=none' },
          { name: 'response_id', definition: 'uuid NOT NULL identity=none generated=none' },
          { name: 'review_id', definition: 'uuid NOT NULL identity=none generated=none' },
          {
            name: 'reviewed_at',
            definition: 'timestamp with time zone NULL identity=none generated=none',
          },
          { name: 'reviewed_by_user_id', definition: 'uuid NULL identity=none generated=none' },
          { name: 'severity', definition: 'text NOT NULL identity=none generated=none' },
          { name: 'source', definition: 'text NOT NULL identity=none generated=none' },
          { name: 'status', definition: 'text NOT NULL identity=none generated=none' },
          {
            name: 'updated_at',
            definition: 'timestamp with time zone NOT NULL identity=none generated=none',
          },
        ];
        expect(table?.columns, BEHIND_HEAD).toEqual(expectedColumns);

        const constraint = (name: string): string | undefined =>
          table?.constraints.find((entry) => entry.name === name)?.definition;

        // The six FK pg_get_constraintdef strings. An earlier draft of this
        // plan said five and omitted reviewed_by_user_id; the catalogue says
        // six.
        expect(constraint('flagged_responses_response_id_fkey'), BEHIND_HEAD).toBe(
          'FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE',
        );
        expect(constraint('flagged_responses_account_id_fkey'), BEHIND_HEAD).toBe(
          'FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE',
        );
        expect(constraint('flagged_responses_business_id_fkey'), BEHIND_HEAD).toBe(
          'FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE',
        );
        expect(constraint('flagged_responses_review_id_fkey'), BEHIND_HEAD).toBe(
          'FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE',
        );
        expect(constraint('flagged_responses_api_cost_id_fkey'), BEHIND_HEAD).toBe(
          'FOREIGN KEY (api_cost_id) REFERENCES api_costs(id) ON DELETE SET NULL',
        );
        expect(constraint('flagged_responses_reviewed_by_user_id_fkey'), BEHIND_HEAD).toBe(
          'FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id)',
        );

        // The three CHECK definitions — the guard oracle B cannot provide,
        // since IF NOT EXISTS skips the CREATE TABLE body on a re-apply.
        expect(constraint('flagged_responses_source_check'), BEHIND_HEAD).toBe(
          "CHECK ((source = ANY (ARRAY['local_regex'::text, 'openai_moderation'::text, " +
            "'eval'::text, 'admin'::text])))",
        );
        expect(constraint('flagged_responses_severity_check'), BEHIND_HEAD).toBe(
          "CHECK ((severity = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))",
        );
        expect(constraint('flagged_responses_status_check'), BEHIND_HEAD).toBe(
          "CHECK ((status = ANY (ARRAY['open'::text, 'approved_for_owner_review'::text, " +
            "'dismissed_false_positive'::text, 'requires_regeneration'::text])))",
        );

        const index = (name: string): string | undefined =>
          table?.indexes.find((entry) => entry.name === name)?.definition;

        // Both guarded pg_get_indexdef strings, including the partial
        // predicate that stops idempotent re-runs of response generation
        // from stacking duplicate open flags.
        expect(index('idx_flagged_responses_status_created'), BEHIND_HEAD).toBe(
          'CREATE INDEX idx_flagged_responses_status_created ON public.flagged_responses ' +
            'USING btree (status, created_at DESC)',
        );
        expect(index('idx_flagged_responses_open_response'), BEHIND_HEAD).toBe(
          'CREATE UNIQUE INDEX idx_flagged_responses_open_response ON ' +
            "public.flagged_responses USING btree (response_id) WHERE (status = 'open'::text)",
        );
      });
    });

    // ── ORACLE B: degrade, prove it landed, apply verbatim, diff ─────────────

    /**
     * Shared degrade-then-apply cycle for titles 3-4. Each caller gets its
     * own rolled-back transaction (`withRolledBackTransaction` always rolls
     * back), so running this cycle once per `it` is safe for the shared
     * container: later migrations layer on `public`, so a persistent degrade
     * would corrupt it for every other suite.
     */
    async function degradeAndApply(
      assert: (before: PublicCatalogue, after: PublicCatalogue) => void,
    ): Promise<void> {
      await withRolledBackTransaction(sql(), async (tx) => {
        const before = await readPublicCatalogue(tx);
        await tx.unsafe(
          'DROP INDEX idx_flagged_responses_status_created;' +
            ' DROP INDEX idx_flagged_responses_open_response;' +
            ' ALTER TABLE flagged_responses DISABLE ROW LEVEL SECURITY;',
        );
        const degraded = await readPublicCatalogue(tx);

        // Prove the degrade LANDED for both properties — without this the
        // case could pass vacuously against a no-op migration.
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          property: 'indexes',
          absent: [
            'idx_flagged_responses_status_created',
            'idx_flagged_responses_open_response',
          ],
        });
        assertDegradeLanded(before, degraded, {
          table: TABLE,
          // Boolean property: no name list applies, so it has its own
          // selector-free variant — the value comparison inside
          // assertDegradeLanded IS the proof.
          property: 'rowSecurity',
        });

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));
        const after = await readPublicCatalogue(tx);
        assert(before, after);
      });
    }

    it('re-applying 051 restores the guarded indexes after they are dropped', async () => {
      await degradeAndApply((before, after) => {
        expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
      });
    });

    it('re-applying 051 moves no other table in public', async () => {
      await degradeAndApply((before, after) => {
        // A migration may harden the one table it names while doing
        // arbitrary damage elsewhere (migration 119's off-target
        // `GRANT ALL ON admin_audit_log TO anon;` red-team round). Every
        // table outside [flagged_responses] must come out byte-identical.
        assertOnlyTablesMoved(before, after, [TABLE]);
      });
    });

    // ── ROW PRESERVATION: catalogue equality cannot see row loss ────────────

    it('re-applying 051 preserves every existing flagged_responses row unchanged', async () => {
      await withRolledBackTransaction(sql(), async (tx) => {
        // users.account_id <-> accounts.owner_user_id are mutually
        // referential, so both inserts need FK checks deferred to commit —
        // same shape as live-db-tenant.ts' seedTenantAccount, spelled out
        // here rather than imported so this fixture uses fixed literals
        // rather than seed-generated random ids.
        await tx`SET CONSTRAINTS ALL DEFERRED`;
        await tx`
          INSERT INTO users (id, name, email, role, account_id)
          VALUES (${FIXTURE_USER_ID}::uuid, 'Migration 051 Fixture Owner',
                  'migration-051-fixture-owner@test.local', 'owner',
                  ${FIXTURE_ACCOUNT_ID}::uuid)
        `;
        await tx`
          INSERT INTO accounts (id, owner_user_id, display_name)
          VALUES (${FIXTURE_ACCOUNT_ID}::uuid, ${FIXTURE_USER_ID}::uuid,
                  'Migration 051 Fixture Account')
        `;
        await tx`
          INSERT INTO businesses (id, account_id, name, owner_name, owner_email)
          VALUES (${FIXTURE_BUSINESS_ID}::uuid, ${FIXTURE_ACCOUNT_ID}::uuid,
                  'Migration 051 Fixture Business', 'Fixture Owner',
                  'migration-051-fixture-business@test.local')
        `;
        await tx`
          INSERT INTO reviews (
            id, business_id, provider_review_id, provider_review_name, provider_location_name
          )
          VALUES (${FIXTURE_REVIEW_ID}::uuid, ${FIXTURE_BUSINESS_ID}::uuid,
                  'migration-051-fixture-review-id', 'migration-051-fixture-review-name',
                  'migration-051-fixture-location-name')
        `;
        await tx`
          INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text)
          VALUES (${FIXTURE_RESPONSE_ID}::uuid, ${FIXTURE_REVIEW_ID}::uuid,
                  ${FIXTURE_BUSINESS_ID}::uuid, 'Migration 051 fixture response text',
                  'Migration 051 fixture original draft text')
        `;
        // api_cost_id and reviewed_by_user_id stay NULL — both nullable, so
        // no api_costs or extra users row is needed for this fixture.
        await tx`
          INSERT INTO flagged_responses (
            id, response_id, account_id, business_id, review_id, source, severity
          )
          VALUES (${FIXTURE_FLAGGED_RESPONSE_ID}::uuid, ${FIXTURE_RESPONSE_ID}::uuid,
                  ${FIXTURE_ACCOUNT_ID}::uuid, ${FIXTURE_BUSINESS_ID}::uuid,
                  ${FIXTURE_REVIEW_ID}::uuid, 'local_regex', 'high')
        `;

        const [before] = await tx`
          SELECT * FROM flagged_responses WHERE id = ${FIXTURE_FLAGGED_RESPONSE_ID}::uuid
        `;
        expect(before).toBeDefined();

        await tx.unsafe(readMigrationSql(MIGRATION_FILE));

        const [after] = await tx`
          SELECT * FROM flagged_responses WHERE id = ${FIXTURE_FLAGGED_RESPONSE_ID}::uuid
        `;

        // The WHOLE record, not selected fields — a future UPDATE added to
        // 051 then fails here on whatever column it touches.
        expect(after).toEqual(before);
      });
    });
  },
);
