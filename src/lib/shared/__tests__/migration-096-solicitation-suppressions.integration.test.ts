import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedTenantAccount } from '@/lib/shared/__tests__/live-db-tenant';

// Shape suite for migration 096 — the Suppression ledger
// (`solicitation_suppressions`) and the Unsubscribe token table
// (`solicitation_unsubscribe_tokens`) (#643; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §2.1/§2.2).
//
// The ledger records what the RECIPIENT revoked, and that outranks what the
// owner attested, permanently. Two facts carry the whole design and both are
// asserted behaviourally below, not just introspected:
//
//  1. The Suppression scope records WHO AUTHORED the opt-out, not how widely it
//     applies. `owner_manual` is the only account-authored source; every other
//     source is recipient- or ecosystem-authored and therefore global. Without
//     the DB CHECK pairing them, `owner_manual` + `global` inserts cleanly and
//     one owner silently degrades every other tenant's reach with no recipient
//     having spoken.
//
//  2. An Unsubscribe token outlives the account that minted it — CAN-SPAM
//     requires the link keep working — so the offboarding purge scrubs
//     provenance instead of deleting the row. The one-way implication CHECK is
//     what lets the purge verifier prove scrub completeness from `account_id`
//     alone.
//
// Asserting that a CHECK merely EXISTS would be worth nothing here: a malformed
// predicate is present and wrong, which is exactly the defect this plan's own
// first revision shipped. Every constraint is therefore asserted twice — once
// on `pg_get_constraintdef()` semantics, once by exercising the tuples through
// an EXHAUSTIVE generated matrix (14 scope x source, 8 provenance nullability).
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with assertSchemaReady, then introspects shape.
// Every behavioural insert runs inside a transaction that is always rolled
// back, so the ledger is never left holding a row.

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/096_solicitation_suppressions.sql',
);

const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
// Executable SQL only — the header comment discusses columns and clauses this
// migration deliberately does NOT create, so absence assertions must not read
// it.
const statements = rawSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/**
 * The closed value sets, read out of the migration's own column CHECKs rather
 * than re-typed here. Re-typing is what lets a future source be added to the
 * schema while the matrix silently keeps testing six of seven; parsing means
 * the Cartesian product below grows with the schema. A live test further down
 * asserts these agree with `pg_get_constraintdef()` on the database, so a
 * parse that quietly matched nothing cannot pass as an empty matrix.
 */
function parseColumnCheckValues(column: string): readonly string[] {
  const pattern = new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)`);
  const match = pattern.exec(statements);
  if (!match) throw new Error(`096 has no CHECK list for column "${column}"`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((literal) => literal[1]!);
}

const SUPPRESSION_SCOPES = parseColumnCheckValues('scope');
const SUPPRESSION_SOURCES = parseColumnCheckValues('source');

interface ScopeSourceCase {
  label: string;
  scope: string;
  source: string;
  accepted: boolean;
}

/**
 * §3.1's source -> scope mapping, stated as the domain rule rather than as a
 * copy of the SQL: the Suppression scope names the AUTHOR, so a scope is
 * account-scoped exactly when its source is the owner's own do-not-contact.
 */
const SCOPE_SOURCE_MATRIX: readonly ScopeSourceCase[] = SUPPRESSION_SCOPES.flatMap((scope) =>
  SUPPRESSION_SOURCES.map((source) => {
    const accepted = (scope === 'account') === (source === 'owner_manual');
    return {
      label: `${accepted ? 'accepts' : 'rejects'} scope=${scope} source=${source}`,
      scope,
      source,
      accepted,
    };
  }),
);

interface ProvenanceCase {
  label: string;
  accountIdSet: boolean;
  businessIdSet: boolean;
  askIdSet: boolean;
  accepted: boolean;
}

/**
 * G12's one-way implication over the three scrubbed provenance columns: all
 * eight nullability permutations, with acceptance stated as the implication
 * itself — a scrubbed `account_id` guarantees the rest are scrubbed, while a
 * live row may carry any subset of the optional ones.
 */
const PROVENANCE_MATRIX: readonly ProvenanceCase[] = [false, true].flatMap((accountIdSet) =>
  [false, true].flatMap((businessIdSet) =>
    [false, true].map((askIdSet) => {
      const accepted = accountIdSet || (!businessIdSet && !askIdSet);
      const shape = [
        `account_id=${accountIdSet ? 'set' : 'NULL'}`,
        `business_id=${businessIdSet ? 'set' : 'NULL'}`,
        `ask_id=${askIdSet ? 'set' : 'NULL'}`,
      ].join(' ');
      return {
        label: `${accepted ? 'accepts' : 'rejects'} ${shape}`,
        accountIdSet,
        businessIdSet,
        askIdSet,
        accepted,
      };
    }),
  ),
);

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let accountId: string | undefined;
let userId: string | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class RollbackProbe extends Error {
  override readonly name = 'RollbackProbe';
}

interface InsertOutcome {
  accepted: boolean;
  code?: string;
  constraint?: string;
}

/**
 * Runs one write attempt inside a transaction that is ALWAYS rolled back, and
 * reports whether the database accepted it. Rollback (rather than delete-after)
 * is what keeps a rejected probe from leaving the ledger holding a row: a
 * Suppression ledger row has no expiry and no ordinary delete path, so a test
 * that leaked one would be leaking a permanent record.
 */
async function probeWrite(
  run: (tx: postgresType.TransactionSql) => Promise<unknown>,
): Promise<InsertOutcome> {
  let outcome: InsertOutcome = { accepted: false };
  try {
    await db!.begin(async (tx) => {
      try {
        await run(tx);
        outcome = { accepted: true };
      } catch (error) {
        const pgError = error as { code?: string; constraint_name?: string };
        outcome = { accepted: false, code: pgError.code, constraint: pgError.constraint_name };
      }
      throw new RollbackProbe();
    });
  } catch (error) {
    if ((error as { name?: string })?.name !== 'RollbackProbe') throw error;
  }
  return outcome;
}

/**
 * Runs multi-step work inside a transaction that is ALWAYS rolled back and
 * returns its result. Unlike `probeWrite` this NEVER swallows an error —
 * rejection is not the subject of the tests that use it, so a constraint
 * violation here must surface as itself rather than as a false negative.
 */
async function inRolledBackTx<T>(
  run: (tx: postgresType.TransactionSql) => Promise<T>,
): Promise<T> {
  let result!: T;
  try {
    await db!.begin(async (tx) => {
      result = await run(tx);
      throw new RollbackProbe();
    });
  } catch (error) {
    if ((error as { name?: string })?.name !== 'RollbackProbe') throw error;
  }
  return result;
}

function insertSuppression(
  tx: postgresType.TransactionSql,
  row: { scope: string; source: string; accountId: string | null; handle: string },
): Promise<unknown> {
  return tx`
    INSERT INTO solicitation_suppressions (id, channel, normalized_handle, scope, account_id, source)
    VALUES (
      ${randomUUID()}::uuid,
      'email',
      ${row.handle},
      ${row.scope},
      ${row.accountId}::uuid,
      ${row.source}
    )
  `;
}

function insertToken(
  tx: postgresType.TransactionSql,
  row: { accountId: string | null; businessId: string | null; askId: string | null },
): Promise<unknown> {
  return tx`
    INSERT INTO solicitation_unsubscribe_tokens
      (id, token_hash, normalized_handle, channel, account_id, business_id, ask_id, sent_at)
    VALUES (
      ${randomUUID()}::uuid,
      ${randomUUID().replaceAll('-', '').padEnd(64, '0')},
      ${`token-${randomUUID()}@test.local`},
      'email',
      ${row.accountId}::uuid,
      ${row.businessId}::uuid,
      ${row.askId}::uuid,
      NOW()
    )
  `;
}

describe('migration 096 checked-in SQL contract', () => {
  it('exists', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('gives account_id NO ON DELETE action — global rows survive the purge, never cascade', () => {
    // §6.3: retention through offboarding is an explicit, verified purge stage
    // with `account_id` left INTACT. A CASCADE or SET NULL here would make that
    // guarantee a silent side effect of deleting the accounts row, and nothing
    // downstream could tell a retained row from a mangled one.
    expect(statements).toContain('account_id UUID REFERENCES accounts(id)');
    expect(statements).not.toMatch(/account_id UUID REFERENCES accounts\(id\)\s+ON DELETE/);
  });

  it('gives the Unsubscribe token no expiry column — CAN-SPAM requires the link keep working', () => {
    // A TTL on an opt-out mechanism is a compliance violation with a cron job
    // attached; there is no expiry value better than none.
    expect(statements).not.toContain('expires_at');
    expect(statements).not.toContain('revoked_at');
  });

  it('keeps the token provenance columns FK-free so no cascade can reach a retained row', () => {
    // account_id / business_id / ask_id are provenance the purge scrubs to
    // NULL. An FK on any of them would delete the token instead of scrubbing
    // it — and the whole point is that redemption still works after the sender
    // is gone. `outreach_id` is the sanctioned exception (G1) and is SET NULL,
    // never CASCADE.
    expect(statements).toContain(
      'outreach_id UUID REFERENCES solicitation_outreach(id) ON DELETE SET NULL',
    );
    expect(statements).not.toContain('REFERENCES solicitation_asks');
    expect(statements).not.toContain('REFERENCES businesses');
  });
});

describe('migration 096 constraint matrices', () => {
  it('covers the full Suppression scope x source Cartesian product — 14 cases, 7 accepted', () => {
    expect(SUPPRESSION_SCOPES).toEqual(['global', 'account']);
    expect(SUPPRESSION_SOURCES).toHaveLength(7);
    expect(SCOPE_SOURCE_MATRIX).toHaveLength(14);
    expect(SCOPE_SOURCE_MATRIX.filter((row) => row.accepted)).toHaveLength(7);
    expect(SCOPE_SOURCE_MATRIX.filter((row) => !row.accepted)).toHaveLength(7);
  });

  it('covers all 8 token provenance nullability permutations — 5 accepted', () => {
    expect(PROVENANCE_MATRIX).toHaveLength(8);
    expect(PROVENANCE_MATRIX.filter((row) => row.accepted)).toHaveLength(5);
    expect(PROVENANCE_MATRIX.filter((row) => !row.accepted)).toHaveLength(3);
  });
});

describeWithDb(
  'migration 096 live schema shape',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_096_SOLICITATION_SUPPRESSIONS]);
      const seed = await seedTenantAccount(db, { accountDisplayName: 'Suppression Ledger Fixture' });
      accountId = seed.accountId;
      userId = seed.userId;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db && accountId) {
          // `solicitation_suppressions.account_id` is a NO-ACTION FK, so a
          // single leaked row would make the account undeletable and strand
          // the fixture. Every probe rolls back, so this must sweep nothing —
          // it is here because the cost of being wrong is a wedged test DB.
          await db`DELETE FROM solicitation_unsubscribe_tokens WHERE account_id = ${accountId}::uuid`;
          await db`DELETE FROM solicitation_suppressions WHERE account_id = ${accountId}::uuid`;
          await cleanupTenantAccount(db, { accountId, userId: userId! });
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

    // ── the matrices' source of truth ────────────────────────────────────────

    it('drives both matrices from the value sets the DATABASE actually enforces', async () => {
      // The matrices are parsed from the migration file. If that parse ever
      // drifts from the deployed CHECK — a widened source list in a later
      // migration, a typo'd literal — the Cartesian products above would keep
      // passing while testing the wrong world. This is the pin.
      const constraints = await db!<{ conname: string; definition: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_suppressions'::regclass AND contype = 'c'
      `;
      const literalsOf = (conname: string): string[] => {
        const definition = constraints.find((c) => c.conname === conname)?.definition;
        expect(definition, conname).toBeDefined();
        return [...definition!.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
      };
      expect(new Set(literalsOf('solicitation_suppressions_scope_check'))).toEqual(
        new Set(SUPPRESSION_SCOPES),
      );
      expect(new Set(literalsOf('solicitation_suppressions_source_check'))).toEqual(
        new Set(SUPPRESSION_SOURCES),
      );
    });

    // ── columns ──────────────────────────────────────────────────────────────

    it('has exactly the spec §2.1 Suppression ledger columns with the locked nullability', async () => {
      const rows = await db!<
        { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'solicitation_suppressions'
        ORDER BY column_name
      `;
      const byName = new Map(rows.map((row) => [row.column_name, row]));

      expect([...byName.keys()].sort()).toEqual([
        'account_id',
        'channel',
        'created_at',
        'created_by_user_id',
        'id',
        'normalized_handle',
        'note',
        'scope',
        'source',
        'suppressed_at',
      ]);

      const expectShape = (column: string, dataType: string, nullable: 'YES' | 'NO') => {
        expect(byName.get(column)?.data_type, column).toBe(dataType);
        expect(byName.get(column)?.is_nullable, column).toBe(nullable);
      };
      expectShape('id', 'uuid', 'NO');
      expectShape('channel', 'text', 'NO');
      expectShape('normalized_handle', 'text', 'NO');
      expectShape('scope', 'text', 'NO');
      // NULLABLE on purpose: a `global` row authored by the recipient belongs
      // to no tenant, and the CHECK pairing is one-directional.
      expectShape('account_id', 'uuid', 'YES');
      expectShape('source', 'text', 'NO');
      expectShape('suppressed_at', 'timestamp with time zone', 'NO');
      expectShape('created_by_user_id', 'uuid', 'YES');
      expectShape('note', 'text', 'YES');
      expectShape('created_at', 'timestamp with time zone', 'NO');

      // UUIDv7 is worker-supplied (repo convention) — no DB default on the PK.
      expect(byName.get('id')?.column_default).toBeNull();
      expect(byName.get('suppressed_at')?.column_default).toMatch(/now\(\)/i);
    });

    it('has exactly the spec §2.2 Unsubscribe token columns with the locked nullability', async () => {
      const rows = await db!<
        { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'solicitation_unsubscribe_tokens'
        ORDER BY column_name
      `;
      const byName = new Map(rows.map((row) => [row.column_name, row]));

      expect([...byName.keys()].sort()).toEqual([
        'account_id',
        'ask_id',
        'business_id',
        'channel',
        'created_at',
        'id',
        'normalized_handle',
        'outreach_id',
        'redeemed_at',
        'sent_at',
        'token_hash',
      ]);

      const expectShape = (column: string, dataType: string, nullable: 'YES' | 'NO') => {
        expect(byName.get(column)?.data_type, column).toBe(dataType);
        expect(byName.get(column)?.is_nullable, column).toBe(nullable);
      };
      // What survives the purge scrub is exactly the NOT NULL set: the hash,
      // the redemption target, its channel and when it was sent.
      expectShape('token_hash', 'text', 'NO');
      expectShape('normalized_handle', 'text', 'NO');
      expectShape('channel', 'text', 'NO');
      expectShape('sent_at', 'timestamp with time zone', 'NO');
      // What gets scrubbed must therefore be nullable.
      expectShape('account_id', 'uuid', 'YES');
      expectShape('business_id', 'uuid', 'YES');
      expectShape('ask_id', 'uuid', 'YES');
      expectShape('outreach_id', 'uuid', 'YES');
      expectShape('redeemed_at', 'timestamp with time zone', 'YES');
      expect(byName.get('id')?.column_default).toBeNull();
    });

    // ── constraint DEFINITIONS (not mere presence) ───────────────────────────

    it('spells the source/scope pairing as the exact §3.1 biconditional', async () => {
      const [row] = await db!<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_suppressions'::regclass
          AND conname = 'solicitation_suppressions_source_scope_pairing'
      `;
      expect(row).toBeDefined();
      // Both arms, spelled out: a predicate that only guarded one direction
      // would be present and wrong.
      expect(row!.definition).toContain("(scope = 'account'::text) AND (source = 'owner_manual'::text)");
      expect(row!.definition).toContain("(scope = 'global'::text) AND (source <> 'owner_manual'::text)");
    });

    it('spells the account/scope pairing as a ONE-directional requirement', async () => {
      const [row] = await db!<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_suppressions'::regclass
          AND conname = 'solicitation_suppressions_account_scope_pairing'
      `;
      expect(row).toBeDefined();
      // `account` REQUIRES account_id; `global` MAY still carry it as
      // provenance. A symmetric predicate would forbid that provenance.
      expect(row!.definition).toContain("(scope <> 'account'::text)");
      expect(row!.definition).toContain('(account_id IS NOT NULL)');
      expect(row!.definition).not.toContain("scope = 'global'");
    });

    it('spells the token provenance rule as an implication, not an all-or-none', async () => {
      const [row] = await db!<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_unsubscribe_tokens'::regclass
          AND conname = 'solicitation_unsubscribe_tokens_provenance_scrub_implication'
      `;
      expect(row).toBeDefined();
      expect(row!.definition).toContain('(account_id IS NOT NULL)');
      expect(row!.definition).toContain('(business_id IS NULL) AND (ask_id IS NULL)');
      // outreach_id is deliberately OUT: ON DELETE SET NULL may null it on its
      // own while the account is still live.
      expect(row!.definition).not.toContain('outreach_id');
    });

    it('has one FK on the ledger — accounts(id) with NO referential action', async () => {
      const foreignKeys = await db!<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_suppressions'::regclass AND contype = 'f'
      `;
      expect(foreignKeys).toHaveLength(1);
      expect(foreignKeys[0]!.definition).toBe(
        'FOREIGN KEY (account_id) REFERENCES accounts(id)',
      );
    });

    it('has one FK on the token table — outreach SET NULL, and none on the scrubbed columns', async () => {
      const foreignKeys = await db!<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.solicitation_unsubscribe_tokens'::regclass AND contype = 'f'
      `;
      const definitions = foreignKeys.map((fk) => fk.definition);
      expect(definitions).toEqual([
        'FOREIGN KEY (outreach_id) REFERENCES solicitation_outreach(id) ON DELETE SET NULL',
      ]);
      // The absence is the assertion: solicitation_outreach cascades from
      // solicitation_batches from contact_csv_uploads, so an FK on account_id,
      // business_id or ask_id would delete a token the purge promised to keep.
      expect(definitions.some((d) => d.includes('account_id'))).toBe(false);
      expect(definitions.some((d) => d.includes('business_id'))).toBe(false);
      expect(definitions.some((d) => d.includes('ask_id'))).toBe(false);
    });

    // ── indexes ──────────────────────────────────────────────────────────────

    it('has both PARTIAL uniques with the §1.2 key shapes and predicates', async () => {
      const rows = await db!<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'solicitation_suppressions_global_uniq',
            'solicitation_suppressions_account_uniq'
          )
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

      const globalIndex = byName.get('solicitation_suppressions_global_uniq');
      expect(globalIndex).toBeDefined();
      expect(globalIndex).toContain('CREATE UNIQUE INDEX');
      expect(globalIndex).toContain('(channel, normalized_handle)');
      expect(globalIndex).toContain("WHERE (scope = 'global'::text)");

      const accountIndex = byName.get('solicitation_suppressions_account_uniq');
      expect(accountIndex).toBeDefined();
      expect(accountIndex).toContain('CREATE UNIQUE INDEX');
      expect(accountIndex).toContain('(channel, normalized_handle, account_id)');
      expect(accountIndex).toContain("WHERE (scope = 'account'::text)");
    });

    it('has the G4 account-leading indexes both partial uniques cannot serve', async () => {
      const rows = await db!<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_solicitation_suppressions_account',
            'idx_solicitation_unsubscribe_tokens_account'
          )
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

      // Column ORDER is the point: both partial uniques lead with
      // (channel, normalized_handle), while the purge delete, the retained-row
      // count and the token scrub all filter account-first — and PG16 has no
      // skip scan.
      expect(byName.get('idx_solicitation_suppressions_account')).toContain('(account_id, scope)');
      expect(byName.get('idx_solicitation_unsubscribe_tokens_account')).toContain('(account_id)');
    });

    it('has the B4 idempotent mint key as a PARTIAL unique on outreach_id', async () => {
      const [row] = await db!<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'solicitation_unsubscribe_tokens_outreach_uniq'
      `;
      expect(row).toBeDefined();
      expect(row!.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(row!.indexdef).toContain('(outreach_id)');
      // Partial, so the purge's scrubbed NULLs never collide with each other.
      expect(row!.indexdef).toContain('WHERE (outreach_id IS NOT NULL)');
    });

    // ── RLS posture ──────────────────────────────────────────────────────────

    it.each([
      { table: 'solicitation_suppressions' },
      { table: 'solicitation_unsubscribe_tokens' },
    ])('has RLS enabled with ZERO policies on $table — deny-all, invariant #14 posture', async ({ table }) => {
      const [relation] = await db!<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity FROM pg_class WHERE oid = ${`public.${table}`}::regclass
      `;
      expect(relation?.relrowsecurity).toBe(true);

      const policies = await db!<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}
      `;
      // Not decorative: a direct client read of a `global` row would expose the
      // account_id provenance §7.4 forbids surfacing.
      expect(policies).toHaveLength(0);
    });

    // ── behaviour: the 14-case Suppression scope x source matrix ─────────────

    it.each(SCOPE_SOURCE_MATRIX)('$label', async ({ scope, source, accepted }) => {
      // `account` rows always carry a valid account_id so the one-directional
      // account/scope pairing is satisfied and the ONLY constraint that can
      // reject is the source/scope pairing under test.
      const outcome = await probeWrite((tx) =>
        insertSuppression(tx, {
          scope,
          source,
          accountId: scope === 'account' ? accountId! : null,
          handle: `matrix-${randomUUID()}@test.local`,
        }),
      );

      expect(outcome.accepted).toBe(accepted);
      if (!accepted) {
        expect(outcome.code).toBe('23514');
        expect(outcome.constraint).toBe('solicitation_suppressions_source_scope_pairing');
      }
    });

    it('requires account_id on an account-scoped row', async () => {
      const outcome = await probeWrite((tx) =>
        insertSuppression(tx, {
          scope: 'account',
          source: 'owner_manual',
          accountId: null,
          handle: `no-account-${randomUUID()}@test.local`,
        }),
      );
      expect(outcome.accepted).toBe(false);
      expect(outcome.constraint).toBe('solicitation_suppressions_account_scope_pairing');
    });

    it('permits account_id on a global row as provenance — the pairing is one-directional', async () => {
      const outcome = await probeWrite((tx) =>
        insertSuppression(tx, {
          scope: 'global',
          source: 'complaint',
          accountId: accountId!,
          handle: `provenance-${randomUUID()}@test.local`,
        }),
      );
      expect(outcome.accepted).toBe(true);
    });

    // ── behaviour: first-write-wins on both partial uniques ──────────────────

    it('infers the global partial unique from a byte-for-byte ON CONFLICT and keeps the FIRST row', async () => {
      const handle = `first-write-${randomUUID()}@test.local`;
      const rows = await inRolledBackTx(async (tx) => {
        await insertSuppression(tx, {
          scope: 'global',
          source: 'unsubscribe_link',
          accountId: null,
          handle,
        });
        // The predicate is re-spelled byte-for-byte; anything else and Postgres
        // does not infer the index, turning DO NOTHING into a duplicate-key
        // error at the first repeated opt-out signal.
        await tx`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source)
          VALUES (${randomUUID()}::uuid, 'email', ${handle}, 'global', NULL, 'complaint')
          ON CONFLICT (channel, normalized_handle) WHERE scope = 'global' DO NOTHING
        `;
        return tx<{ source: string }[]>`
          SELECT source FROM solicitation_suppressions WHERE normalized_handle = ${handle}
        `;
      });
      // A later `complaint` leaves the earlier row alone: the state is already
      // correct, and the signal history belongs to the provider webhook
      // records #622 §5 stores.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('unsubscribe_link');
    });

    it('infers the account partial unique from a byte-for-byte ON CONFLICT and keeps the FIRST row', async () => {
      const handle = `first-write-account-${randomUUID()}@test.local`;
      const firstNote = 'original entry';
      const rows = await inRolledBackTx(async (tx) => {
        await tx`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source, note)
          VALUES (
            ${randomUUID()}::uuid, 'email', ${handle}, 'account', ${accountId!}::uuid,
            'owner_manual', ${firstNote}
          )
        `;
        await tx`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source, note)
          VALUES (
            ${randomUUID()}::uuid, 'email', ${handle}, 'account', ${accountId!}::uuid,
            'owner_manual', 'second entry'
          )
          ON CONFLICT (channel, normalized_handle, account_id) WHERE scope = 'account' DO NOTHING
        `;
        return tx<{ note: string | null }[]>`
          SELECT note FROM solicitation_suppressions WHERE normalized_handle = ${handle}
        `;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.note).toBe(firstNote);
    });

    it('lets a global row and this account row coexist for the same handle', async () => {
      // The two partial uniques are disjoint by predicate, so both key shapes
      // can hold a row for one handle. Which one the lookup reports is the
      // domain module's concern (global wins); the schema's job is only to
      // permit the pair.
      const handle = `coexist-${randomUUID()}@test.local`;
      const scopes = await inRolledBackTx(async (tx) => {
        await insertSuppression(tx, {
          scope: 'global',
          source: 'bounce_permanent',
          accountId: null,
          handle,
        });
        await insertSuppression(tx, {
          scope: 'account',
          source: 'owner_manual',
          accountId: accountId!,
          handle,
        });
        return tx<{ scope: string }[]>`
          SELECT scope FROM solicitation_suppressions
          WHERE normalized_handle = ${handle} ORDER BY scope
        `;
      });
      expect(scopes.map((row) => row.scope)).toEqual(['account', 'global']);
    });

    // ── behaviour: the 8-case token provenance matrix ────────────────────────

    it.each(PROVENANCE_MATRIX)('$label', async ({ accountIdSet, businessIdSet, askIdSet, accepted }) => {
      const outcome = await probeWrite((tx) =>
        insertToken(tx, {
          accountId: accountIdSet ? accountId! : null,
          businessId: businessIdSet ? randomUUID() : null,
          askId: askIdSet ? randomUUID() : null,
        }),
      );

      expect(outcome.accepted).toBe(accepted);
      if (!accepted) {
        expect(outcome.code).toBe('23514');
        expect(outcome.constraint).toBe(
          'solicitation_unsubscribe_tokens_provenance_scrub_implication',
        );
      }
    });

    it('accepts the fully scrubbed shape the offboarding purge leaves behind', async () => {
      // The row an owner-offboarding purge produces: provenance gone, the
      // redemption facts kept. If the implication CHECK rejected this, the
      // purge itself could not run.
      const tokenHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
      const handle = `scrubbed-${randomUUID()}@test.local`;
      const rows = await inRolledBackTx(async (tx) => {
        await tx`
          INSERT INTO solicitation_unsubscribe_tokens
            (id, token_hash, normalized_handle, channel, account_id, business_id, ask_id, sent_at)
          VALUES (
            ${randomUUID()}::uuid, ${tokenHash}, ${handle}, 'email',
            ${accountId!}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, NOW()
          )
        `;
        await tx`
          UPDATE solicitation_unsubscribe_tokens
          SET account_id = NULL, business_id = NULL, ask_id = NULL
          WHERE token_hash = ${tokenHash}
        `;
        return tx<{ normalized_handle: string; account_id: string | null }[]>`
          SELECT normalized_handle, account_id FROM solicitation_unsubscribe_tokens
          WHERE token_hash = ${tokenHash}
        `;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.account_id).toBeNull();
      // The redemption target survives — the Unsubscribe token outlives the
      // account that minted it.
      expect(rows[0]!.normalized_handle).toBe(handle);
    });
  },
);
