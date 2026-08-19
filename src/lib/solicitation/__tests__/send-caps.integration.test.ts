import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { countAccountDispatchAttemptsToday } from '../send-caps';

// Live-DB suite for the account daily send cap's counter (#898, amendment B3).
// Two things only the real database can prove:
//
//  1. THE COUNTING BASIS. The cap counts DISPATCH ATTEMPTS — outreach rows whose
//     `queued_at` falls in the current UTC day — never `sent_at`. A bounce still
//     spent reputation, so #619 D9's sent_at counting is superseded, and only a
//     row set carrying both stamps in disagreement can tell the two apart.
//  2. THE UTC DAY BOUNDARY. `date_trunc('day', NOW() AT TIME ZONE 'UTC')` is the
//     same expression `worker/jobs/response-generation/auto-approval.ts` uses;
//     a local-time boundary is invisible to a unit test and wrong for half the
//     day in every timezone but one.
//
// Applies NO migration SQL (#573). Every write runs inside a transaction that
// is ALWAYS rolled back.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let otherTenant: TenantSeed | undefined;

/** One committed account → business → upload → batch chain. */
interface Chain {
  accountId: string;
  userId: string;
  businessId: string;
  uploadId: string;
  batchId: string;
}
let chain: Chain | undefined;
let otherChain: Chain | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class Rollback extends Error {
  override readonly name = 'Rollback';
}

function expectRollback(error: unknown): void {
  if ((error as { name?: string })?.name !== 'Rollback') throw error;
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('send caps integration database was not initialized');
  return db;
}

function primary(): Chain {
  if (!chain) throw new Error('send caps primary chain was not seeded');
  return chain;
}

function neighbour(): Chain {
  if (!otherChain) throw new Error('send caps neighbour chain was not seeded');
  return otherChain;
}

/**
 * Where a stamp falls relative to the UTC day the counter reads.
 *
 * Named rather than passed as raw SQL text so every value is resolved IN
 * POSTGRES: the counter's boundary is derived from NOW(), and a JS `Date`
 * round-tripped through postgres.js loses its microseconds, which is exactly
 * the comparison that mis-orders by <1ms (#520).
 */
type QueuedStamp = 'utc_day_start' | 'now' | 'two_days_ago' | null;
type SentStamp = 'now' | null;

function queuedFragment(
  tx: postgresType.TransactionSql,
  spec: QueuedStamp,
): postgresType.PendingQuery<postgresType.Row[]> | null {
  switch (spec) {
    case 'utc_day_start':
      return tx`date_trunc('day', NOW() AT TIME ZONE 'UTC')`;
    case 'now':
      return tx`NOW()`;
    case 'two_days_ago':
      return tx`NOW() - INTERVAL '2 days'`;
    case null:
      return null;
  }
}

/**
 * One Outreach row on `chain`, with its own Ask and Contact.
 *
 * The lifecycle status is DERIVED from the stamps rather than passed: 091's
 * status/timestamp CHECK makes `(delivery_status = 'sent') = (sent_at IS NOT
 * NULL)` and requires `queued_at` of every dispatched status, so a fixture that
 * let a caller set them independently would be rejected for a reason no case
 * here is about.
 */
async function seedOutreachRow(
  tx: postgresType.TransactionSql,
  on: Chain,
  stamps: { queuedAt: QueuedStamp; sentAt: SentStamp },
): Promise<string> {
  const contactId = randomUUID();
  const askId = randomUUID();
  await tx`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${on.businessId}::uuid, 'Send Caps Customer',
            ${`send-caps-${contactId}@test.local`}, ${on.uploadId}::uuid)
  `;
  await tx`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${on.accountId}::uuid, ${on.businessId}::uuid,
      ${on.batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${tx.json({ decision: 'send' })}, NOW()
    )
  `;

  const deliveryStatus =
    stamps.sentAt !== null ? 'sent' : stamps.queuedAt !== null ? 'queued' : 'rendered';
  return insertOutreach(tx, {
    accountId: on.accountId,
    businessId: on.businessId,
    batchId: on.batchId,
    askId,
    contactId,
    deliveryStatus,
    queuedAt: queuedFragment(tx, stamps.queuedAt),
    sendingAt: null,
    sentAt: stamps.sentAt === null ? null : tx`NOW()`,
  });
}

async function seedChain(
  exec: postgresType.Sql,
  seed: TenantSeed,
  label: string,
): Promise<Chain> {
  const { businessId } = await seedLocation(exec, seed.accountId, { name: label });
  const uploadId = randomUUID();
  const batchId = randomUUID();
  await exec`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${seed.accountId}::uuid, ${businessId}::uuid,
      ${`send-caps-${uploadId}.csv`}, 1,
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${exec.json({ accepted: 1 })},
      ${seed.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  await exec`
    INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id, built_at)
    VALUES (${batchId}::uuid, ${seed.accountId}::uuid, ${businessId}::uuid,
            ${uploadId}::uuid, NOW())
  `;
  return { accountId: seed.accountId, userId: seed.userId, businessId, uploadId, batchId };
}

describeWithDb(
  'solicitation send caps (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        // PgBouncer's ~8s default is below what a chain-seeding probe needs.
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE]);

      // BOTH tenants are seeded here rather than inside a probe transaction:
      // `seedTenantAccount` opens its own `sql.begin` for the deferred
      // users <-> accounts cycle, and postgres.js's TransactionSql exposes
      // `savepoint`, not `begin`.
      tenant = await seedTenantAccount(db, { accountDisplayName: 'Send Caps Fixture' });
      otherTenant = await seedTenantAccount(db, {
        accountDisplayName: 'Send Caps Neighbour',
      });
      chain = await seedChain(db, tenant, 'Send Caps Location');
      otherChain = await seedChain(db, otherTenant, 'Send Caps Neighbour Location');
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db) {
          for (const seeded of [chain, otherChain]) {
            if (seeded) await db`DELETE FROM businesses WHERE id = ${seeded.businessId}::uuid`;
          }
          for (const seed of [tenant, otherTenant]) {
            if (seed) {
              await cleanupTenantAccount(db, {
                accountId: seed.accountId,
                userId: seed.userId,
              });
            }
          }
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

    it('countAccountDispatchAttemptsToday counts outreach rows by queued_at in the UTC day and ignores sent_at', async () => {
      // Amendment B3: the counting basis is DISPATCH ATTEMPTS, not successes —
      // a bounce still spent reputation, so #619 D9's sent_at counting is
      // superseded. UTC day boundary mirrors auto-approval.ts.
      await sql()
        .begin(async (tx) => {
          await seedOutreachRow(tx, primary(), { queuedAt: 'utc_day_start', sentAt: null });
          await seedOutreachRow(tx, primary(), { queuedAt: 'now', sentAt: 'now' });
          await seedOutreachRow(tx, primary(), { queuedAt: 'two_days_ago', sentAt: 'now' });
          await seedOutreachRow(tx, primary(), { queuedAt: null, sentAt: null });
          expect(await countAccountDispatchAttemptsToday(tx, primary().accountId)).toBe(2);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('countAccountDispatchAttemptsToday excludes dispatch attempts belonging to another account', async () => {
      // Without a second tenant in the fixture, an implementation that DROPS the
      // account_id filter returns exactly the same number and every other test
      // stays green — while every account on the platform shares one cap.
      await sql()
        .begin(async (tx) => {
          await seedOutreachRow(tx, primary(), { queuedAt: 'now', sentAt: null });
          await seedOutreachRow(tx, neighbour(), { queuedAt: 'now', sentAt: null });
          expect(await countAccountDispatchAttemptsToday(tx, primary().accountId)).toBe(1);
          expect(await countAccountDispatchAttemptsToday(tx, neighbour().accountId)).toBe(1);
          throw new Rollback();
        })
        .catch(expectRollback);
    });
  },
);
