// Shape + behaviour assertions for migration 116 — the Refusal ledger
// (`refusal_events`): twelve locked columns, five named CHECK constraints,
// three indexes, deny-all RLS, and the tenant-registry row the table forces.
//
// Task 0 of the #1008 plan authors every promised title RED; Task 1 lands the
// migration and turns titles 1–18 green, Task 2 turns title 19 green. The
// runnable form follows
// `migration-114-solicitation-attribution.integration.test.ts` for shape and
// for the cross-process live-DB lock, and asserts the schema with
// `assertSchemaReady` rather than applying any DDL at run time
// (`ci:live-db-suites` R2).
//
// ── what this suite deliberately does NOT do ────────────────────────────────
//
// It executes NO DDL. `pnpm test:db:setup` provisions the container to head and
// every case here either reads the catalogue (`information_schema`,
// `pg_class`, `pg_policies`, `pg_indexes`, `pg_constraint`, `pg_description`),
// reads the checked-in migration file, or writes rows under its own seeded
// tenant. That is why the file is absent from `MIGRATION_SHAPE_FILES` in
// `scripts/ci/live-db-suites-audit.ts`: that allowlist exists for suites where
// APPLYING the migration is the subject (074 and 088 re-execute the checked-in
// SQL through `db.unsafe()`), and adding a read-only suite to it would widen a
// sanctioned-DDL escape hatch over a file that needs no escape.
//
// It DOES take the cross-process lock: titles 16–18 prove GLOBAL index
// behaviour (a partial UNIQUE index keyed on `(refusal_source, subject_id)`
// with no tenant column in it), so serializing one fast suite costs nothing
// next to a false green.
//
// ── the three assertion styles, and why each title uses the one it does ─────
//
// structural (1, 2, 3, 4, 5, 7) — reads the catalogue. Title 7 CANNOT be
//   behavioural: the standalone `refusal_source` CHECK rejects every unmapped
//   lane BEFORE C1 is reached, so no insertable row exercises C1's CASE
//   fall-through. A C1 carrying the correct seven arms and NO `IS TRUE`
//   wrapper would pass every behavioural case in this file. The wrapper is
//   therefore asserted on the constraint DEFINITION or not at all.
// file text (6) — reads `supabase/migrations/116_refusal_events.sql`. The read
//   is inside the case, never at module scope: a module-scope read would throw
//   at collection time and take the whole file down with it.
// module import (19) — reads `TENANT_TABLES` / `TENANT_SCOPE_COLUMNS`. Needs no
//   database, so it lives OUTSIDE `describeWithDb`; gating it on the live DB
//   would make it a silent skip rather than a failure on a keyless run.
// behavioural (8–18) — an INSERT succeeds, or is rejected by a NAMED
//   constraint. Every rejection asserts `constraint_name`, never merely that
//   something threw.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  TENANT_SCOPE_COLUMNS,
  TENANT_TABLES,
} from '../../../../scripts/ci/tenant-tables';

const MIGRATION_FILE = 'supabase/migrations/116_refusal_events.sql';

// ── the LOCKED vocabulary ───────────────────────────────────────────────────
//
// Declared locally, exactly as 114's suite declares `RULE_FULL_NAME`: the
// TypeScript owner (`src/lib/refusals/vocabulary.ts`) arrives with the insert
// helper in #1009, and until then the CHECKs — not this suite — are the
// authority. The moment that module exists these lists must be DERIVED from it
// rather than re-typed here.

/** Seven lanes. `policy_gate_held` joined the six of the parent effort (#1003). */
const REFUSAL_SOURCES = [
  'held_draft',
  'auto_post_revoked',
  'autonomy_suspended',
  'ask_withheld',
  'outreach_withheld',
  'batch_halted',
  'policy_gate_held',
] as const;
type RefusalSource = (typeof REFUSAL_SOURCES)[number];

/** Eight categories. `owner_review_required` joined the closed seven (#998). */
const REFUSAL_CATEGORIES = [
  'unsafe_content',
  'watchdog_unavailable',
  'below_our_bar',
  'no_permission',
  'wrong_moment',
  'autonomy_paused',
  'missing_information',
  'owner_review_required',
] as const;

const SUBJECT_TYPES = [
  'response',
  'solicitation_ask',
  'solicitation_outreach',
  'solicitation_batch',
] as const;

const VOCABULARY_VERSION = 'refusal_vocabulary_v1';

// ── the five named CHECKs, the two enum CHECKs and the three indexes ────────

const C1_SOURCE_SUBJECT = 'refusal_events_source_subject_pairing';
const C2_SUBJECT_COMPLETENESS = 'refusal_events_subject_completeness';
const C3_BUSINESS_PAIRING = 'refusal_events_business_pairing';
const C4_CODE_PAIRING = 'refusal_events_code_pairing';
const C5_ALL_CODES_PAIRING = 'refusal_events_all_codes_pairing';

/**
 * The three column-level CHECKs are UNNAMED in the locked DDL, so Postgres
 * derives `<table>_<column>_check`. Naming them here pins that the vocabulary
 * lives on the COLUMN rather than inside one of the five pairing constraints.
 */
const SOURCE_ENUM_CHECK = 'refusal_events_refusal_source_check';
const CATEGORY_ENUM_CHECK = 'refusal_events_refusal_category_check';
const SUBJECT_TYPE_ENUM_CHECK = 'refusal_events_subject_type_check';

const ARCHIVAL_INDEX = 'idx_refusal_events_archival';
const ACCOUNT_WINDOW_INDEX = 'idx_refusal_events_account_window';
const SUBJECT_UNIQ_INDEX = 'refusal_events_subject_uniq';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const UNDEFINED_TABLE = '42P01';

const MIGRATION_116_REFUSAL_EVENTS: SchemaRequirement = {
  migration: '116_refusal_events',
  tables: ['refusal_events'],
  indexes: [ARCHIVAL_INDEX, ACCOUNT_WINDOW_INDEX, SUBJECT_UNIQ_INDEX],
  constraints: [
    C1_SOURCE_SUBJECT,
    C2_SUBJECT_COMPLETENESS,
    C3_BUSINESS_PAIRING,
    C4_CODE_PAIRING,
    C5_ALL_CODES_PAIRING,
  ].map((name) => ({ table: 'refusal_events', name })),
};

/**
 * Either client, because title 16 runs its INSERT inside `sql.begin` — the only
 * place the `ON CONFLICT` inference can be shown NOT to poison a transaction.
 */
type SqlExecutor = postgresType.Sql | postgresType.TransactionSql;

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let seededBusinessId: string | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 116 integration database was not initialized');
  return db;
}

function seededTenant(): TenantSeed {
  if (!tenant) throw new Error('migration 116 integration tenant was not seeded');
  return tenant;
}

function accountId(): string {
  return seededTenant().accountId;
}

function locationId(): string {
  if (!seededBusinessId) throw new Error('migration 116 integration location was not seeded');
  return seededBusinessId;
}

// ── fixtures ────────────────────────────────────────────────────────────────

interface CanonicalLane {
  refusalCode: string | null;
  allRefusalCodes: readonly string[] | null;
  refusalCategory: string;
  subjectType: string | null;
  /** `autonomy_suspended` alone is account-wide: C3 forces `business_id IS NULL`. */
  accountWide: boolean;
}

/**
 * One legal row per lane. Every field is exactly what the five CHECKs demand,
 * so a case that overrides ONE field isolates the constraint it targets.
 *
 * `refusal_code` and the `all_refusal_codes` members are verbatim strings under
 * no CHECK at all — their vocabulary is owned by TypeScript (see title 13), so
 * the values here are illustrative and the schema must not care.
 */
const CANONICAL: Record<RefusalSource, CanonicalLane> = {
  held_draft: {
    refusalCode: null,
    allRefusalCodes: null,
    refusalCategory: 'unsafe_content',
    subjectType: 'response',
    accountWide: false,
  },
  auto_post_revoked: {
    refusalCode: 'judge_unavailable',
    allRefusalCodes: null,
    refusalCategory: 'watchdog_unavailable',
    subjectType: 'response',
    accountWide: false,
  },
  autonomy_suspended: {
    refusalCode: 'governor_suspended',
    allRefusalCodes: null,
    refusalCategory: 'autonomy_paused',
    subjectType: null,
    accountWide: true,
  },
  ask_withheld: {
    refusalCode: 'suppressed_recipient',
    allRefusalCodes: null,
    refusalCategory: 'no_permission',
    subjectType: 'solicitation_ask',
    accountWide: false,
  },
  outreach_withheld: {
    refusalCode: 'missing_contact_channel',
    allRefusalCodes: null,
    refusalCategory: 'missing_information',
    subjectType: 'solicitation_outreach',
    accountWide: false,
  },
  batch_halted: {
    refusalCode: 'owner_halt',
    allRefusalCodes: null,
    refusalCategory: 'wrong_moment',
    subjectType: 'solicitation_batch',
    accountWide: false,
  },
  policy_gate_held: {
    refusalCode: 'rating_band',
    allRefusalCodes: ['rating_band'],
    refusalCategory: 'below_our_bar',
    subjectType: 'response',
    accountWide: false,
  },
};

/**
 * The shape an UNMAPPED lane borrows (title 15's `refusal_source` probe).
 * Deliberately C3/C4/C5-clean so the ONLY thing wrong with that row is its
 * lane, and the rejection names the source CHECK rather than a pairing one.
 */
const UNMAPPED_LANE_SHAPE: CanonicalLane = {
  refusalCode: 'code_for_a_lane_that_does_not_exist',
  allRefusalCodes: null,
  refusalCategory: 'wrong_moment',
  subjectType: 'response',
  accountWide: false,
};

function canonicalFor(source: string): CanonicalLane {
  return (
    (CANONICAL as Record<string, CanonicalLane | undefined>)[source] ?? UNMAPPED_LANE_SHAPE
  );
}

interface RefusalInput {
  id?: string;
  accountId?: string;
  businessId?: string | null;
  refusalSource: string;
  refusalCode?: string | null;
  allRefusalCodes?: readonly (string | null)[] | null;
  refusalCategory?: string;
  vocabularyVersion?: string;
  subjectType?: string | null;
  subjectId?: string | null;
  occurredAt?: Date;
}

interface ResolvedRefusalRow {
  id: string;
  accountId: string;
  businessId: string | null;
  refusalSource: string;
  refusalCode: string | null;
  allRefusalCodes: readonly (string | null)[] | null;
  refusalCategory: string;
  vocabularyVersion: string;
  subjectType: string | null;
  subjectId: string | null;
  occurredAt: Date;
}

/**
 * Fills every field the caller left out from the lane's canonical row. An
 * explicit `null` is HONOURED (that is how a case removes a field); only
 * `undefined` falls back — which is why no call site ever passes `undefined`.
 */
function resolveRefusalRow(input: RefusalInput): ResolvedRefusalRow {
  const canonical = canonicalFor(input.refusalSource);
  return {
    id: input.id ?? uuidv7(),
    accountId: input.accountId ?? accountId(),
    businessId:
      input.businessId !== undefined
        ? input.businessId
        : canonical.accountWide
          ? null
          : locationId(),
    refusalSource: input.refusalSource,
    refusalCode: input.refusalCode !== undefined ? input.refusalCode : canonical.refusalCode,
    allRefusalCodes:
      input.allRefusalCodes !== undefined ? input.allRefusalCodes : canonical.allRefusalCodes,
    refusalCategory: input.refusalCategory ?? canonical.refusalCategory,
    vocabularyVersion: input.vocabularyVersion ?? VOCABULARY_VERSION,
    subjectType: input.subjectType !== undefined ? input.subjectType : canonical.subjectType,
    subjectId:
      input.subjectId !== undefined
        ? input.subjectId
        : canonical.subjectType === null
          ? null
          : uuidv7(),
    occurredAt: input.occurredAt ?? new Date(),
  };
}

/**
 * `created_at` is deliberately absent from the column list: letting the DEFAULT
 * fire is what proves the default exists (title 14 reads it back).
 */
async function insertRefusal(
  input: RefusalInput,
  exec: SqlExecutor = sql(),
): Promise<string> {
  const row = resolveRefusalRow(input);
  await exec`
    INSERT INTO refusal_events (
      id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes,
      refusal_category, vocabulary_version, subject_type, subject_id, occurred_at
    ) VALUES (
      ${row.id}::uuid, ${row.accountId}::uuid, ${row.businessId}::uuid,
      ${row.refusalSource}, ${row.refusalCode}, ${row.allRefusalCodes}::text[],
      ${row.refusalCategory}, ${row.vocabularyVersion},
      ${row.subjectType}, ${row.subjectId}::uuid, ${row.occurredAt}
    )
  `;
  return row.id;
}

/**
 * The same INSERT under the idempotency clause #1009's helper will ship. The
 * predicate is re-spelled BYTE-FOR-BYTE from the migration — `ON CONFLICT`
 * cannot infer a partial index any other way, and that inference is what
 * titles 16–18 are about.
 */
async function insertRefusalIgnoringConflict(
  input: RefusalInput,
  exec: SqlExecutor = sql(),
): Promise<string> {
  const row = resolveRefusalRow(input);
  await exec`
    INSERT INTO refusal_events (
      id, account_id, business_id, refusal_source, refusal_code, all_refusal_codes,
      refusal_category, vocabulary_version, subject_type, subject_id, occurred_at
    ) VALUES (
      ${row.id}::uuid, ${row.accountId}::uuid, ${row.businessId}::uuid,
      ${row.refusalSource}, ${row.refusalCode}, ${row.allRefusalCodes}::text[],
      ${row.refusalCategory}, ${row.vocabularyVersion},
      ${row.subjectType}, ${row.subjectId}::uuid, ${row.occurredAt}
    )
    ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING
  `;
  return row.id;
}

/** Asserts the DATABASE rejected the row, and names the constraint that did it. */
async function expectRejectedBy(
  attempt: Promise<unknown>,
  constraintName: string,
  code: string = CHECK_VIOLATION,
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ code, constraint_name: constraintName });
}

/**
 * `where` is a Postgres.js FRAGMENT — created but never awaited on its own, the
 * same composition `statusArraySql` uses. Building it at the call site keeps
 * every predicate visible in the case that depends on it.
 */
async function countRefusals(
  where: postgresType.PendingQuery<postgresType.Row[]>,
): Promise<number> {
  const [row] = await sql()<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM refusal_events WHERE ${where}
  `;
  return Number(row?.count ?? -1);
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function constraintDefinition(constraintName: string): Promise<string> {
  const [row] = await sql()<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'refusal_events'::regclass AND conname = ${constraintName}
  `;
  if (!row) throw new Error(`constraint ${constraintName} is absent from refusal_events`);
  return squash(row.definition);
}

async function indexDefinition(indexName: string): Promise<string> {
  const [row] = await sql()<{ definition: string }[]>`
    SELECT indexdef AS definition FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ${indexName}
  `;
  if (!row) throw new Error(`index ${indexName} is absent`);
  return squash(row.definition);
}

/**
 * The quoted `::text` members of a rendered `= ANY (ARRAY[…])` CHECK, IN ORDER.
 * Members and order together are what pin a closed vocabulary.
 */
function checkMembers(definition: string): string[] {
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1] ?? '');
}

// ── title 19 + title 6: no database required ────────────────────────────────
//
// Both live outside `describeWithDb` on purpose. `scripts/ci/__tests__/
// tenant-tables.integration.test.ts` is not in this PR's edit surface and
// widening it for one assertion would spend an amendment, so title 19 is
// rehomed here beside the schema it describes (plan D10) — and a keyless run
// must FAIL it rather than skip it.

describe('migration 116 refusal_events (no database required)', () => {
  it('migration 116 runs as one transaction and bounds its lock acquisition with SET LOCAL lock_timeout', () => {
    // Read INSIDE the case: at module scope a missing file would throw during
    // collection and take titles 1–19 down with it, hiding which one failed.
    const migrationSql = readFileSync(join(process.cwd(), MIGRATION_FILE), 'utf8');
    const withoutComments = migrationSql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .trim();

    // ONE transaction, 110's and 114's reasoning: psql autocommits each
    // statement, so a partial re-run must never leave the table without its
    // constraints, its indexes or its RLS switch.
    expect(withoutComments.startsWith('BEGIN;')).toBe(true);
    expect(withoutComments.endsWith('COMMIT;')).toBe(true);
    expect(withoutComments.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(withoutComments.match(/\bCOMMIT;/g)).toHaveLength(1);
    expect(withoutComments).not.toMatch(/\bROLLBACK\b/);

    // The bound on lock acquisition: without it the migration waits behind any
    // long-running reader and holds the queue behind IT.
    expect(withoutComments).toContain("SET LOCAL lock_timeout = '10s';");

    // CONCURRENTLY cannot run inside a transaction block, and the table holds
    // zero rows in every environment at merge (112's precedent).
    expect(migrationSql).not.toMatch(/\bCONCURRENTLY\b/);
  });

  it('TENANT_TABLES scopes refusal_events by account_id and business_id', () => {
    // Cast through `readonly string[]` / `Record<string, …>`: `TenantTable` is
    // derived from the array itself, so before Task 2 the literal is not a
    // member of the union and a direct `.includes` would fail TYPECHECK rather
    // than fail the test. The eval must be red at run time, not at build time.
    const tenantTables: readonly string[] = TENANT_TABLES;
    const scopeColumns: Record<string, readonly string[] | undefined> = TENANT_SCOPE_COLUMNS;

    expect(tenantTables).toContain('refusal_events');
    // Both columns, in `solicitation_batches`' shape: `account_id` is the purge
    // and owner-read scope, `business_id` is the per-location one, and an
    // `autonomy_suspended` row carries the second as NULL.
    expect(scopeColumns.refusal_events).toEqual(['account_id', 'business_id']);
  });
});

describeWithDb(
  'migration 116 refusal_events',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 4,
        prepare: false,
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_116_REFUSAL_EVENTS]);
      tenant = await seedTenantAccount(db, {
        userName: 'Refusal 116 Owner',
        accountDisplayName: 'Refusal 116 Account',
      });
      const location = await seedLocation(db, tenant.accountId, {
        name: 'Refusal 116 Location',
      });
      seededBusinessId = location.businessId;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          if (tenant) {
            try {
              await db`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
            } catch (error) {
              // Before Task 1 the relation does not exist. Swallowing ONLY
              // 42P01 keeps the seeded tenant from being stranded without
              // hiding a real cleanup failure.
              if ((error as { code?: string }).code !== UNDEFINED_TABLE) throw error;
            }
          }
          if (seededBusinessId) {
            await db`DELETE FROM businesses WHERE id = ${seededBusinessId}::uuid`;
          }
          if (tenant) await cleanupTenantAccount(db, tenant);
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

    // ── structural ──────────────────────────────────────────────────────────

    it('migration 116 enables row level security on refusal_events and defines zero policies', async () => {
      const [relation] = await sql()<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE oid = 'refusal_events'::regclass
      `;
      expect(relation?.relrowsecurity).toBe(true);

      // Deny-all is the guarantee, not a convention: `all_refusal_codes` is
      // never owner-facing (ADR 0023), and RLS filters ROWS rather than
      // columns — so an owner-readable policy could not withhold that column.
      // Zero policies is the only posture that keeps the promise.
      const policies = await sql()<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'refusal_events'
      `;
      expect(policies).toEqual([]);
    });

    it('migration 116 creates the twelve locked columns with their exact types, nullability and defaults, and no others', async () => {
      const columns = await sql()<
        {
          column_name: string;
          data_type: string;
          udt_name: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`
        SELECT column_name, data_type, udt_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'refusal_events'
         ORDER BY column_name
      `;

      const shape = columns.map((column) => ({
        name: column.column_name,
        type: column.udt_name,
        nullable: column.is_nullable === 'YES',
        hasDefault: column.column_default !== null,
      }));

      // Twelve, and no others — an extra column here is a second authority for
      // something the locked vocabulary already owns. `origin` in particular is
      // deliberately absent, now and later: #1002 decided there is never a
      // backfill, so there is nothing for it to distinguish.
      expect(shape).toEqual([
        // policy_gate_held ONLY, and never owner-facing (ADR 0023).
        { name: 'account_id', type: 'uuid', nullable: false, hasDefault: false },
        { name: 'all_refusal_codes', type: '_text', nullable: true, hasDefault: false },
        // NULL exactly for the account-wide lane (C3).
        { name: 'business_id', type: 'uuid', nullable: true, hasDefault: false },
        // The insert stamp, and NOT the retention clock.
        { name: 'created_at', type: 'timestamptz', nullable: false, hasDefault: true },
        // Worker-supplied UUIDv7 — no DB default, deliberately.
        { name: 'id', type: 'uuid', nullable: false, hasDefault: false },
        // The single retention clock, supplied by the writer.
        { name: 'occurred_at', type: 'timestamptz', nullable: false, hasDefault: false },
        { name: 'refusal_category', type: 'text', nullable: false, hasDefault: false },
        // NULL exactly for held_draft (C4).
        { name: 'refusal_code', type: 'text', nullable: true, hasDefault: false },
        { name: 'refusal_source', type: 'text', nullable: false, hasDefault: false },
        // A bare uuid: NULL (this lane points at nothing) must stay
        // distinguishable from non-null-but-unresolvable (the subject aged away).
        { name: 'subject_id', type: 'uuid', nullable: true, hasDefault: false },
        { name: 'subject_type', type: 'text', nullable: true, hasDefault: false },
        { name: 'vocabulary_version', type: 'text', nullable: false, hasDefault: false },
      ]);

      // `data_type` is asserted separately for the array column: `udt_name`
      // alone would not distinguish `text[]` from a domain over it.
      const allCodes = columns.find((column) => column.column_name === 'all_refusal_codes');
      expect(allCodes?.data_type).toBe('ARRAY');
    });

    it('migration 116 creates foreign keys only to accounts and businesses, both with no referential action, and leaves subject_id unreferenced', async () => {
      const foreignKeys = await sql()<
        {
          conname: string;
          column_name: string;
          referenced_table: string;
          on_update: string;
          on_delete: string;
        }[]
      >`
        SELECT con.conname,
               (SELECT attname FROM pg_attribute
                 WHERE attrelid = con.conrelid AND attnum = con.conkey[1]) AS column_name,
               (SELECT relname FROM pg_class WHERE oid = con.confrelid) AS referenced_table,
               con.confupdtype AS on_update,
               con.confdeltype AS on_delete
          FROM pg_constraint con
         WHERE con.conrelid = 'refusal_events'::regclass AND con.contype = 'f'
         ORDER BY column_name
      `;

      // `a` is NO ACTION. Both parents are retain_deidentified (tombstoned,
      // never deleted), so neither may take a Refusal away on another table's
      // clock — a CASCADE here would make the ledger lie about what we refused.
      expect(
        foreignKeys.map((fk) => ({
          column: fk.column_name,
          referenced: fk.referenced_table,
          onUpdate: fk.on_update,
          onDelete: fk.on_delete,
        })),
      ).toEqual([
        { column: 'account_id', referenced: 'accounts', onUpdate: 'a', onDelete: 'a' },
        { column: 'business_id', referenced: 'businesses', onUpdate: 'a', onDelete: 'a' },
      ]);

      // Named explicitly rather than left to the length: the whole point of
      // `subject_id` is that it survives its subject.
      expect(foreignKeys.map((fk) => fk.column_name)).not.toContain('subject_id');
    });

    it('migration 116 creates the archival, account-window and partial-unique indexes with their exact keys, ordering, uniqueness and predicate', async () => {
      const indexes = await sql()<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'refusal_events'
         ORDER BY indexname
      `;
      // Three plus the primary key, and nothing else — an unclaimed index on a
      // no-TTL table is write cost nobody is measuring.
      expect(indexes.map((index) => index.indexname)).toEqual([
        ACCOUNT_WINDOW_INDEX,
        ARCHIVAL_INDEX,
        'refusal_events_pkey',
        SUBJECT_UNIQ_INDEX,
      ]);

      // Retention. The ArchivalPoller's ORDER BY must match an index or the
      // sweep is unbounded; `id` breaks ties so the scan is total.
      const archival = await indexDefinition(ARCHIVAL_INDEX);
      expect(archival).not.toContain('CREATE UNIQUE INDEX');
      expect(archival).toContain('ON public.refusal_events USING btree (occurred_at, id)');
      expect(archival).not.toContain('WHERE');

      // The owner read and the offboarding purge. account_id LEADS: PG16 has no
      // skip scan and the purge DELETE filters account-first. Unpartial on
      // purpose — it must cover the account-wide rows (business_id IS NULL)
      // without a second index.
      const accountWindow = await indexDefinition(ACCOUNT_WINDOW_INDEX);
      expect(accountWindow).not.toContain('CREATE UNIQUE INDEX');
      expect(accountWindow).toContain(
        'ON public.refusal_events USING btree (account_id, occurred_at DESC)',
      );
      expect(accountWindow).not.toContain('WHERE');

      // Idempotency. PARTIAL, so autonomy_suspended's NULL subject is never
      // deduplicated, and #1009's ON CONFLICT re-spells this predicate
      // byte-for-byte (title 16).
      const subjectUniq = await indexDefinition(SUBJECT_UNIQ_INDEX);
      expect(subjectUniq).toContain('CREATE UNIQUE INDEX');
      expect(subjectUniq).toContain(
        'ON public.refusal_events USING btree (refusal_source, subject_id)',
      );
      expect(subjectUniq).toContain('WHERE (subject_id IS NOT NULL)');
    });

    it('migration 116 comments the table and all twelve columns, and names occurred_at as the only retention clock', async () => {
      const [table] = await sql()<{ comment: string | null }[]>`
        SELECT obj_description('refusal_events'::regclass, 'pg_class') AS comment
      `;
      expect((table?.comment ?? '').length).toBeGreaterThan(0);

      const comments = await sql()<{ column_name: string; comment: string | null }[]>`
        SELECT a.attname AS column_name,
               col_description(a.attrelid, a.attnum) AS comment
          FROM pg_attribute a
         WHERE a.attrelid = 'refusal_events'::regclass
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attname
      `;
      expect(comments).toHaveLength(12);
      const uncommented = comments
        .filter((row) => (row.comment ?? '').trim().length === 0)
        .map((row) => row.column_name);
      expect(uncommented).toEqual([]);

      const byColumn = new Map(comments.map((row) => [row.column_name, row.comment ?? '']));

      // The two timestamps are the pair a future reader is most likely to
      // confuse, so each comment must name WHICH ONE the sweep uses. The skew
      // between them is also the only measurement that would catch a writer
      // stamping occurred_at with insert time instead of decision time.
      const occurredAt = byColumn.get('occurred_at') ?? '';
      expect(occurredAt).toMatch(/retention/i);
      expect(occurredAt).toContain('occurred_at');

      const createdAt = byColumn.get('created_at') ?? '';
      expect(createdAt).toMatch(/retention/i);
      expect(createdAt).toContain('occurred_at');
    });

    it('C1 wraps its total source-to-subject CASE in IS TRUE so a fall-through rejects instead of passing on NULL', async () => {
      const definition = await constraintDefinition(C1_SOURCE_SUBJECT);

      // STRUCTURAL, and it has to be. The standalone refusal_source CHECK
      // rejects every unmapped lane BEFORE C1 is reached, so no insertable row
      // can exercise the CASE fall-through — a C1 with all seven arms correct
      // and NO wrapper would pass every behavioural case in this file.
      expect(definition).toContain('CASE refusal_source');

      const arms: [RefusalSource, string][] = [
        ['held_draft', "subject_type = 'response'::text"],
        ['policy_gate_held', "subject_type = 'response'::text"],
        ['auto_post_revoked', "subject_type = 'response'::text"],
        ['ask_withheld', "subject_type = 'solicitation_ask'::text"],
        ['outreach_withheld', "subject_type = 'solicitation_outreach'::text"],
        ['batch_halted', "subject_type = 'solicitation_batch'::text"],
        ['autonomy_suspended', 'subject_type IS NULL'],
      ];
      for (const [source, expectation] of arms) {
        // Parens are how pg_get_constraintdef renders the THEN expression and
        // are not the subject here, so the pairing is matched around them.
        const escaped = expectation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(definition).toMatch(
          new RegExp(`WHEN '${source}'::text THEN \\(?${escaped}\\)?`),
        );
      }

      // No ELSE arm — which is exactly why the wrapper is load-bearing. An
      // eighth lane admitted by the source CHECK falls through to NULL, and a
      // CHECK is SATISFIED by NULL. `IS TRUE` is what turns that into a
      // rejection.
      expect(definition).not.toContain('ELSE');
      expect(definition).toMatch(/END\)?\s*IS TRUE/);
    });

    // ── behavioural ─────────────────────────────────────────────────────────

    it('C1 rejects every lane paired with a subject_type the locked mapping does not give it', async () => {
      // Each pairing is legal vocabulary on both sides and illegal together —
      // the only thing C1 rejects, and the only thing it should.
      const mismatches: [RefusalSource, string][] = [
        ['held_draft', 'solicitation_ask'],
        ['auto_post_revoked', 'solicitation_outreach'],
        ['policy_gate_held', 'solicitation_batch'],
        ['ask_withheld', 'response'],
        ['outreach_withheld', 'response'],
        ['batch_halted', 'response'],
        // The account-wide lane points at nothing at all, so ANY subject_type
        // is wrong for it.
        ['autonomy_suspended', 'response'],
      ];

      for (const [refusalSource, subjectType] of mismatches) {
        await expectRejectedBy(
          insertRefusal({ refusalSource, subjectType, subjectId: uuidv7() }),
          C1_SOURCE_SUBJECT,
        );
      }

      expect(await countRefusals(sql()`account_id = ${accountId()}::uuid`)).toBe(0);
    });

    it('C2 rejects a typed subject with no id, and an id with no subject_type', async () => {
      // A typed subject with no id slips past the PARTIAL unique index — the
      // predicate excludes NULL subject_ids — so the same held draft could be
      // recorded twice.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'held_draft', subjectId: null }),
        C2_SUBJECT_COMPLETENESS,
      );

      // An id with no type is unresolvable at read: nothing says which table to
      // look in. `autonomy_suspended` is the lane whose C1 arm ADMITS a NULL
      // subject_type, so C2 is the only constraint this row violates.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'autonomy_suspended', subjectId: uuidv7() }),
        C2_SUBJECT_COMPLETENESS,
      );
    });

    it('C3 rejects an account-wide row that is not autonomy_suspended, and an autonomy_suspended row pinned to a location', async () => {
      // C3 is BICONDITIONAL. Half one: a per-location lane may not go
      // account-wide, or the owner read cannot attribute it to a location.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'held_draft', businessId: null }),
        C3_BUSINESS_PAIRING,
      );

      // Half two, and the exact defect the parent effort shipped: a suspension
      // is an ACCOUNT-level act, so pinning it to one location misrepresents
      // what the Governor did.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'autonomy_suspended', businessId: locationId() }),
        C3_BUSINESS_PAIRING,
      );
    });

    it('C4 rejects a held_draft row carrying a refusal_code, and a non-held_draft row carrying none', async () => {
      // held_draft's reason is unrecordable as a single winning code — #1003
      // records it in all_refusal_codes server-side instead — so a code here
      // would be an invented one.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'held_draft', refusalCode: 'moderation_high' }),
        C4_CODE_PAIRING,
      );

      // And every OTHER lane has a real code, so a missing one is a writer bug,
      // not an absence worth recording.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'ask_withheld', refusalCode: null }),
        C4_CODE_PAIRING,
      );
    });

    it('C5 rejects policy_gate_held rows whose all_refusal_codes is null, empty, contains NULL, or omits refusal_code, and any other lane carrying an array', async () => {
      // policy_gate_held is the ONE lane that lost on more than one ground, so
      // an absent array loses the evidence the winner was picked from.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'policy_gate_held', allRefusalCodes: null }),
        C5_ALL_CODES_PAIRING,
      );

      // NULL and '{}' must never become the same value: an empty array claims
      // "we looked and found nothing", which cannot be true of a held row.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'policy_gate_held', allRefusalCodes: [] }),
        C5_ALL_CODES_PAIRING,
      );

      // THE D4 CORRECTION, and the reason C5 carries two clauses #1001 did not
      // have. Under the original expression `refusal_code = ANY(ARRAY['different',
      // NULL])` returns NULL, that collapses the whole CHECK to NULL, and a
      // CHECK is SATISFIED by NULL — so Postgres ACCEPTS exactly the row C5
      // exists to forbid. `array_position(all_refusal_codes, NULL) IS NULL`
      // plus the outer `IS TRUE` wrapper are what make this a rejection.
      await expectRejectedBy(
        insertRefusal({
          refusalSource: 'policy_gate_held',
          refusalCode: 'winner',
          allRefusalCodes: ['different', null],
        }),
        C5_ALL_CODES_PAIRING,
      );

      // The winner must be IN the array it won, or the two columns disagree
      // about what happened.
      await expectRejectedBy(
        insertRefusal({
          refusalSource: 'policy_gate_held',
          refusalCode: 'winner',
          allRefusalCodes: ['different'],
        }),
        C5_ALL_CODES_PAIRING,
      );

      // And no other lane may carry one: they lost on exactly one ground, so an
      // array would imply a decomposition that never happened.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'ask_withheld', allRefusalCodes: ['suppressed_recipient'] }),
        C5_ALL_CODES_PAIRING,
      );

      expect(await countRefusals(sql()`account_id = ${accountId()}::uuid`)).toBe(0);
    });

    it('C5 admits a policy_gate_held row whose all_refusal_codes carries codes the database does not know, because the member vocabulary is owned by TypeScript', async () => {
      // The members are deliberately NOT CHECKed against AutoApprovalBlockReason.
      // That enum's owner is TypeScript; a CHECK here would create a second
      // authority that drifts, and adding a block reason would become
      // migration-bearing.
      const id = await insertRefusal({
        refusalSource: 'policy_gate_held',
        refusalCode: 'rating_band',
        allRefusalCodes: ['rating_band', 'a_reason_this_database_has_never_heard_of'],
      });

      const [row] = await sql()<{ all_refusal_codes: string[]; refusal_code: string }[]>`
        SELECT all_refusal_codes, refusal_code FROM refusal_events WHERE id = ${id}::uuid
      `;
      expect(row?.refusal_code).toBe('rating_band');
      expect(row?.all_refusal_codes).toEqual([
        'rating_band',
        'a_reason_this_database_has_never_heard_of',
      ]);
    });

    it('a canonical valid row for every one of the seven lanes satisfies all five CHECK constraints', async () => {
      for (const refusalSource of REFUSAL_SOURCES) {
        await insertRefusal({ refusalSource });
      }

      const rows = await sql()<
        {
          refusal_source: string;
          business_id: string | null;
          subject_type: string | null;
          created_at: Date;
        }[]
      >`
        SELECT refusal_source, business_id::text AS business_id, subject_type, created_at
          FROM refusal_events
         WHERE account_id = ${accountId()}::uuid
         ORDER BY refusal_source
      `;
      // Sorted in JS on BOTH sides: a glibc/ICU database collation ignores `_`
      // at the primary level, so `ORDER BY refusal_source` and JS `.sort()`
      // disagree about `auto_post_revoked` vs `autonomy_suspended`. The claim
      // here is the SET of lanes, not their order.
      expect([...rows.map((row) => row.refusal_source)].sort()).toEqual(
        [...REFUSAL_SOURCES].sort(),
      );

      // The account-wide lane, and only it, carries a NULL business_id and a
      // NULL subject_type.
      const accountWide = rows.filter((row) => row.business_id === null);
      expect(accountWide.map((row) => row.refusal_source)).toEqual(['autonomy_suspended']);
      const unsubjected = rows.filter((row) => row.subject_type === null);
      expect(unsubjected.map((row) => row.refusal_source)).toEqual(['autonomy_suspended']);

      // `created_at` was never written by the INSERT — the DEFAULT filled it,
      // which is what makes it the insert stamp rather than a writer-supplied
      // value that could be confused with `occurred_at`.
      expect(rows.every((row) => row.created_at instanceof Date)).toBe(true);
    });

    it('the refusal_source, refusal_category and subject_type CHECKs admit exactly the seven lanes, eight categories and four subject types, and reject an unknown member', async () => {
      // Members AND order, read off the rendered `= ANY (ARRAY[…])`: a closed
      // vocabulary is only closed if nothing extra is in it.
      expect(checkMembers(await constraintDefinition(SOURCE_ENUM_CHECK))).toEqual([
        ...REFUSAL_SOURCES,
      ]);
      expect(checkMembers(await constraintDefinition(CATEGORY_ENUM_CHECK))).toEqual([
        ...REFUSAL_CATEGORIES,
      ]);
      expect(checkMembers(await constraintDefinition(SUBJECT_TYPE_ENUM_CHECK))).toEqual([
        ...SUBJECT_TYPES,
      ]);

      // Every category is reachable: the eighth (owner_review_required) is the
      // one #998 added, and a stale CHECK would reject it here.
      for (const refusalCategory of REFUSAL_CATEGORIES) {
        await insertRefusal({ refusalSource: 'auto_post_revoked', refusalCategory });
      }
      expect(await countRefusals(sql()`account_id = ${accountId()}::uuid`)).toBe(
        REFUSAL_CATEGORIES.length,
      );

      await expectRejectedBy(
        insertRefusal({ refusalSource: 'a_lane_that_does_not_exist' }),
        SOURCE_ENUM_CHECK,
      );
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'held_draft', refusalCategory: 'a_category_we_never_named' }),
        CATEGORY_ENUM_CHECK,
      );

      // The subject_type probe cannot name ONE constraint, and that is a
      // property of the schema rather than a weakness here: no row can violate
      // ONLY the subject_type vocabulary, because every lane's C1 arm pins the
      // subject_type it accepts, so C1 is violated too. Which of the two
      // Postgres reports depends on evaluation order, and the two plausible
      // orders disagree — by constraint NAME, C1 (`…_source_subject_pairing`)
      // comes first; by creation order, the column CHECK does. The vocabulary
      // itself is pinned structurally above; what this adds is that the row is
      // REJECTED, by a named constraint, under either order.
      //
      // The two probes above have no such ambiguity: the category row violates
      // its CHECK and nothing else, and for the unknown lane both orders put
      // `…_refusal_source_check` ahead of C1.
      await expect(
        insertRefusal({ refusalSource: 'held_draft', subjectType: 'a_subject_we_never_named' }),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint_name: expect.stringMatching(
          new RegExp(`^(${C1_SOURCE_SUBJECT}|${SUBJECT_TYPE_ENUM_CHECK})$`),
        ),
      });
    });

    it('an ON CONFLICT clause re-spelling the partial predicate byte-for-byte infers refusal_events_subject_uniq and does not abort the caller transaction', async () => {
      const subjectId = uuidv7();
      await insertRefusal({ refusalSource: 'held_draft', subjectId });

      // The whole point: `ON CONFLICT` cannot infer a PARTIAL index unless the
      // predicate matches byte-for-byte. A failed inference raises 23505 and
      // poisons the caller's transaction — so the second statement inside the
      // SAME transaction is the proof that DO NOTHING actually did nothing.
      const survivors = await sql().begin(async (tx) => {
        await insertRefusalIgnoringConflict({ refusalSource: 'held_draft', subjectId }, tx);
        const [row] = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM refusal_events WHERE subject_id = ${subjectId}::uuid
        `;
        return Number(row?.count ?? -1);
      });

      expect(survivors).toBe(1);
    });

    it('the same (refusal_source, subject_id) inserted twice yields one row, and the same subject under a different refusal_source yields two', async () => {
      const subjectId = uuidv7();
      await insertRefusalIgnoringConflict({ refusalSource: 'held_draft', subjectId });
      await insertRefusalIgnoringConflict({ refusalSource: 'held_draft', subjectId });
      expect(
        await countRefusals(sql()`subject_id = ${subjectId}::uuid AND refusal_source = 'held_draft'`),
      ).toBe(1);

      // Without the guard clause the duplicate is a hard error — named, so a
      // future writer that forgets ON CONFLICT fails loudly rather than
      // silently double-recording.
      await expectRejectedBy(
        insertRefusal({ refusalSource: 'held_draft', subjectId }),
        SUBJECT_UNIQ_INDEX,
        UNIQUE_VIOLATION,
      );

      // The key is (refusal_source, subject_id), not subject_id alone: one
      // response can be held AND later have its auto-post revoked, and both are
      // real, separate refusals.
      await insertRefusalIgnoringConflict({ refusalSource: 'auto_post_revoked', subjectId });
      expect(await countRefusals(sql()`subject_id = ${subjectId}::uuid`)).toBe(2);
    });

    it('two autonomy_suspended rows for one account both persist because the unique index is partial on subject_id IS NOT NULL', async () => {
      // The predicate excludes NULL subjects, so a NULL subject is never
      // deduplicated — an account suspended twice is two separate facts, and
      // collapsing them would erase the second suspension from the ledger.
      await insertRefusalIgnoringConflict({
        refusalSource: 'autonomy_suspended',
        occurredAt: new Date(Date.now() - 60_000),
      });
      await insertRefusalIgnoringConflict({ refusalSource: 'autonomy_suspended' });

      expect(
        await countRefusals(
          sql()`account_id = ${accountId()}::uuid AND refusal_source = 'autonomy_suspended'`,
        ),
      ).toBe(2);
    });
  },
);
