import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedTenantAccount } from '@/lib/shared/__tests__/live-db-tenant';

// Shape suite for migration 099 — the Attested postal address on `businesses`
// (#656; locked spec docs/superpowers/specs/2026-07-28-sender-deliverability-design.md
// §7.5). Written as pending placeholders by T1 (the eval task) and filled in by
// T2, once 099 exists and `pnpm test:db:setup` has provisioned it.
//
// The subject is TWO constraints, and only the second is load-bearing:
//
//  1. All-or-nothing over the five columns, so no reader ever branches on "is
//     this attested" — a stored address always carries its attestation.
//
//  2. The attested-bytes digest. Completeness is NOT coverage: an address-only
//     UPDATE by any writer keeps all four attestation columns non-NULL, passes
//     constraint 1, and leaves an attestation dated before bytes it never saw —
//     the precise defect this feature exists to prevent. Only the digest CHECK
//     catches it, and it must fail closed for EVERY writer, not just for
//     `attestPostalAddress`.
//
// Asserting that either CHECK merely EXISTS would be worth nothing: a malformed
// predicate is present and wrong. Case 1 is therefore an EXHAUSTIVE generated
// matrix over the five columns' 2^5 = 32 nullability combinations — exactly two
// legal (all-NULL, and all-present with a MATCHING digest), the other 30
// rejected. Follow migration-096-solicitation-suppressions.integration.test.ts:
// its import block and its rolled-back-probe discipline are the template, and
// it holds the cross-process live-DB lock because a migration-shape suite is
// the sanctioned exception to the no-run-time-DDL rule (#573).
//
// The no-FK case is asserted twice — by introspection (no `pg_constraint` row
// of contype 'f' referencing the attested-by column) and behaviourally (an
// arbitrary UUID inserts fine, and the tuple survives the attesting user's
// deletion). Migration 093's written lesson is why: 086's ON DELETE CASCADE
// meant deleting a staff member deleted their uploads.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions to
// head and this suite ASSERTS with assertSchemaReady, then introspects shape.
// Every behavioural write runs inside a transaction that is always rolled back,
// so the fixture location is never left holding an attestation.

const testDatabaseUrl = resolveTestDatabaseUrl();
const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/099_solicitation_postal_address.sql',
);

const rawSql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf-8') : '';
// Executable SQL only — the header comment discusses the FK this migration
// deliberately does NOT create, so absence assertions must not read it.
const statements = rawSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const ALL_OR_NOTHING_CONSTRAINT = 'businesses_solicitation_postal_address_attested';
const DIGEST_CONSTRAINT = 'businesses_solicitation_postal_address_digest';

const FIXTURE_ADDRESS = '123 Main St\nAustin, TX 78701';
const REPLACEMENT_ADDRESS = '999 Other Rd\nAustin, TX 78702';
const ATTESTATION_VERSION = 'postal_address_attestation_v1';

/**
 * The digest the writer is required to produce (invariant #10: `node:crypto`,
 * never `crypto-js`). `convert_to(x, 'UTF8')` on the SQL side hashes the same
 * bytes Node's default utf8 encoding produces, which is the whole reason the
 * CHECK can be recomputed client-side at all.
 */
function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface TupleShape {
  label: string;
  address: boolean;
  attestedAt: boolean;
  attestedBy: boolean;
  version: boolean;
  digest: boolean;
  accepted: boolean;
}

/**
 * All 2^5 nullability permutations of the attestation tuple. Acceptance is
 * stated as the DOMAIN rule rather than as a copy of the SQL: a location either
 * has no attested address at all, or has every part of one. Anything between is
 * an attestation that covers nothing, or an address nobody attested — and both
 * are states a reader would have to branch on.
 */
const NULLABILITY_MATRIX: readonly TupleShape[] = Array.from({ length: 32 }, (_, bits) => {
  const address = (bits & 1) !== 0;
  const attestedAt = (bits & 2) !== 0;
  const attestedBy = (bits & 4) !== 0;
  const version = (bits & 8) !== 0;
  const digest = (bits & 16) !== 0;
  const setCount = [address, attestedAt, attestedBy, version, digest].filter(Boolean).length;
  const shape = [
    `address=${address ? 'set' : 'NULL'}`,
    `attested_at=${attestedAt ? 'set' : 'NULL'}`,
    `attested_by=${attestedBy ? 'set' : 'NULL'}`,
    `version=${version ? 'set' : 'NULL'}`,
    `digest=${digest ? 'set' : 'NULL'}`,
  ].join(' ');
  const accepted = setCount === 0 || setCount === 5;
  return {
    label: `${accepted ? 'accepts' : 'rejects'} ${shape}`,
    address,
    attestedAt,
    attestedBy,
    version,
    digest,
    accepted,
  };
});

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let accountId: string | undefined;
let userId: string | undefined;
const businessId = randomUUID();

/** Thrown to roll a probe transaction back; never escapes this file. */
class RollbackProbe extends Error {
  override readonly name = 'RollbackProbe';
}

interface WriteOutcome {
  accepted: boolean;
  code?: string;
  constraint?: string;
}

/**
 * Runs one write attempt inside a transaction that is ALWAYS rolled back, and
 * reports whether the database accepted it. Rollback rather than delete-after
 * is what keeps a probe from leaving the fixture location carrying a sender
 * address: a committed attestation here would silently make the location
 * send-eligible for every suite that shares this database.
 */
async function probeWrite(
  run: (tx: postgresType.TransactionSql) => Promise<unknown>,
): Promise<WriteOutcome> {
  let outcome: WriteOutcome = { accepted: false };
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
async function inRolledBackTx<T>(run: (tx: postgresType.TransactionSql) => Promise<T>): Promise<T> {
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

/** Writes all five columns explicitly, so a permutation's NULLs are asserted rather than left over. */
function writeTuple(
  tx: postgresType.TransactionSql,
  row: {
    address: string | null;
    attestedAt: Date | null;
    attestedBy: string | null;
    version: string | null;
    digest: string | null;
  },
): Promise<unknown> {
  return tx`
    UPDATE businesses SET
      solicitation_postal_address                      = ${row.address},
      solicitation_postal_address_attested_at          = ${row.attestedAt}::timestamptz,
      solicitation_postal_address_attested_by_user_id  = ${row.attestedBy}::uuid,
      solicitation_postal_address_attestation_version  = ${row.version},
      solicitation_postal_address_attested_digest      = ${row.digest}
    WHERE id = ${businessId}::uuid
  `;
}

/** The complete, self-consistent tuple a well-behaved writer produces. */
function attestTuple(
  tx: postgresType.TransactionSql,
  address: string,
  attester: string,
): Promise<unknown> {
  return writeTuple(tx, {
    address,
    attestedAt: new Date(),
    attestedBy: attester,
    version: ATTESTATION_VERSION,
    digest: sha256Hex(address),
  });
}

interface AttestationRow {
  solicitation_postal_address: string | null;
  solicitation_postal_address_attested_at: Date | null;
  solicitation_postal_address_attested_by_user_id: string | null;
  solicitation_postal_address_attestation_version: string | null;
  solicitation_postal_address_attested_digest: string | null;
}

function readTuple(tx: postgresType.TransactionSql): Promise<AttestationRow[]> {
  return tx<AttestationRow[]>`
    SELECT solicitation_postal_address,
           solicitation_postal_address_attested_at,
           solicitation_postal_address_attested_by_user_id,
           solicitation_postal_address_attestation_version,
           solicitation_postal_address_attested_digest
    FROM businesses
    WHERE id = ${businessId}::uuid
  `;
}

describeWithDb(
  'migration 099 solicitation postal address',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_099_SOLICITATION_POSTAL_ADDRESS]);
      const seed = await seedTenantAccount(db, {
        userName: 'Postal Address Shape Owner',
        accountDisplayName: 'Postal Address Shape Fixture',
      });
      accountId = seed.accountId;
      userId = seed.userId;
      await db`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id, subscription_status, category
        ) VALUES (
          ${businessId}::uuid, 'Postal Address Shape Business',
          'Shape Owner', ${seed.ownerEmail}, ${seed.accountId}::uuid,
          'active', 'automotive'
        )
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db && accountId) {
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
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

    it('migration 099 rejects every partially populated postal-address attestation tuple', async () => {
      // The matrix is the assertion. Hand-writing three cases would leave 27
      // permutations untested, and the interesting ones are exactly the
      // permutations nobody thinks to write down.
      expect(NULLABILITY_MATRIX).toHaveLength(32);
      expect(NULLABILITY_MATRIX.filter((shape) => shape.accepted)).toHaveLength(2);

      for (const shape of NULLABILITY_MATRIX) {
        const outcome = await probeWrite((tx) =>
          writeTuple(tx, {
            address: shape.address ? FIXTURE_ADDRESS : null,
            attestedAt: shape.attestedAt ? new Date() : null,
            attestedBy: shape.attestedBy ? userId! : null,
            version: shape.version ? ATTESTATION_VERSION : null,
            // A "set" digest is always the MATCHING one, so the only constraint
            // that can reject a partial tuple is the all-or-nothing CHECK —
            // which is what makes the constraint-name assertion below meaningful
            // rather than a coin flip between the two.
            digest: shape.digest ? sha256Hex(FIXTURE_ADDRESS) : null,
          }),
        );

        expect(outcome.accepted, shape.label).toBe(shape.accepted);
        if (!shape.accepted) {
          expect(outcome.code, shape.label).toBe('23514');
          expect(outcome.constraint, shape.label).toBe(ALL_OR_NOTHING_CONSTRAINT);
        }
      }

      // "All five present" is legal only WITH A MATCHING DIGEST. Without this
      // the matrix above would still pass against a schema that had the
      // all-or-nothing CHECK and no digest CHECK at all.
      const mismatched = await probeWrite((tx) =>
        writeTuple(tx, {
          address: FIXTURE_ADDRESS,
          attestedAt: new Date(),
          attestedBy: userId!,
          version: ATTESTATION_VERSION,
          digest: sha256Hex(REPLACEMENT_ADDRESS),
        }),
      );
      expect(mismatched.accepted).toBe(false);
      expect(mismatched.code).toBe('23514');
      expect(mismatched.constraint).toBe(DIGEST_CONSTRAINT);
    });

    it('migration 099 rejects replacing an attested address without replacing its attestation', async () => {
      // Non-vacuity first: the fixture attestation must actually land, or the
      // rejection below could be the attest failing rather than the edit.
      const attested = await probeWrite((tx) => attestTuple(tx, FIXTURE_ADDRESS, userId!));
      expect(attested.accepted).toBe(true);

      // Address-only UPDATE: all four attestation columns stay non-NULL, so the
      // all-or-nothing CHECK is satisfied. Only the digest CHECK catches it —
      // and it must catch it for ANY writer, which is why this goes through raw
      // SQL rather than through the domain module.
      const outcome = await probeWrite(async (tx) => {
        await attestTuple(tx, FIXTURE_ADDRESS, userId!);
        await tx`
          UPDATE businesses
          SET solicitation_postal_address = ${REPLACEMENT_ADDRESS}
          WHERE id = ${businessId}::uuid
        `;
      });

      expect(outcome.accepted).toBe(false);
      expect(outcome.code).toBe('23514');
      expect(outcome.constraint).toBe(DIGEST_CONSTRAINT);
    });

    it('migration 099 adds no foreign key on solicitation_postal_address_attested_by_user_id', async () => {
      // The checked-in SQL, then the deployed schema, then the behaviour. 093's
      // lesson is the reason: 086 declared attested_by_user_id REFERENCES
      // users(id) ON DELETE CASCADE, so offboarding one staff member deleted
      // their uploads.
      expect(existsSync(migrationPath)).toBe(true);
      expect(statements).not.toContain('REFERENCES users');

      const foreignKeys = await db!<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.businesses'::regclass AND contype = 'f'
      `;
      // `businesses` legitimately carries the account FK (034); the assertion is
      // that NO foreign key mentions any of the attestation columns.
      expect(
        foreignKeys.filter((fk) => fk.definition.includes('solicitation_postal_address')),
      ).toHaveLength(0);

      // Behaviourally: a UUID belonging to no user at all is accepted, because
      // nothing in the schema checks it. That is the load-bearing consequence —
      // the WRITER carries the account-membership predicate instead.
      const outcome = await probeWrite((tx) => attestTuple(tx, FIXTURE_ADDRESS, randomUUID()));
      expect(outcome.accepted).toBe(true);
    });

    it('migration 099 keeps the complete attestation tuple after the attesting user is deleted', async () => {
      const attesterId = randomUUID();
      const rows = await inRolledBackTx(async (tx) => {
        await tx`
          INSERT INTO users (id, name, email, role, account_id)
          VALUES (
            ${attesterId}::uuid, 'Departing Attester',
            ${`departing-${attesterId}@test.local`}, 'owner', ${accountId!}::uuid
          )
        `;
        await attestTuple(tx, FIXTURE_ADDRESS, attesterId);
        await tx`DELETE FROM users WHERE id = ${attesterId}::uuid`;
        return readTuple(tx);
      });

      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // The whole tuple survives, still complete and still self-consistent: the
      // attestation is a point-in-time capture of who asserted what, and a
      // compliance record that vanishes when its author offboards is not one.
      expect(row.solicitation_postal_address).toBe(FIXTURE_ADDRESS);
      expect(row.solicitation_postal_address_attested_by_user_id).toBe(attesterId);
      expect(row.solicitation_postal_address_attestation_version).toBe(ATTESTATION_VERSION);
      expect(row.solicitation_postal_address_attested_digest).toBe(sha256Hex(FIXTURE_ADDRESS));
      expect(row.solicitation_postal_address_attested_at).toBeInstanceOf(Date);
    });
  },
);
