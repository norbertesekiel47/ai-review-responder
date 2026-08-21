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
  MIGRATION_110_SEND_GOVERNORS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedLocation,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { insertOutreach } from '@/lib/shared/__tests__/helpers/outreach-fixture';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';

// Live-DB contract suite for migration 110 (#898). Three things only a real
// database can prove:
//
//  1. THE CHECK ARMS. `solicitation_outreach_status_reason_consistency` has
//     existed under that NAME since 091 and is REPLACED by 108, 109 and now
//     110, so presence proves nothing (the same trap `schema-ready.ts`
//     documents for analytics_events_event_name_check). Only the DEFINITION
//     can be tested, and only by pushing a value at it.
//  2. THE ONE-OPEN INDEX. "At most one trip is open" lives in a partial unique
//     index, not in application code, precisely so no future caller can
//     violate it. A test that only exercised the module would never see it.
//  3. DENY-ALL RLS. A missing `ENABLE ROW LEVEL SECURITY` does not fail to
//     compile; it silently exposes platform operational state.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions the schema
// to head and this suite ASSERTS it with `assertSchemaReady`. Every write runs
// inside a transaction that is ALWAYS rolled back.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;

/** The committed account → business → upload → batch chain every probe hangs off. */
interface Fixture {
  accountId: string;
  userId: string;
  businessId: string;
  uploadId: string;
  batchId: string;
}
let fixture: Fixture | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class Rollback extends Error {
  override readonly name = 'Rollback';
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 110 integration database was not initialized');
  return db;
}

function chain(): Fixture {
  if (!fixture) throw new Error('migration 110 fixture chain was not seeded');
  return fixture;
}

/**
 * One fresh contact + ask under the committed batch.
 *
 * Each Outreach row needs its OWN ask: `solicitation_outreach_one_live_per_ask`
 * admits a single live attempt per ask, and `solicitation_asks_batch_contact_uniq`
 * a single ask per (batch, contact).
 */
async function seedAskChain(
  tx: postgresType.TransactionSql,
): Promise<{ contactId: string; askId: string }> {
  const contactId = randomUUID();
  const askId = randomUUID();
  await tx`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${chain().businessId}::uuid, 'Migration 110 Customer',
            ${`m110-${contactId}@test.local`}, ${chain().uploadId}::uuid)
  `;
  await tx`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    ) VALUES (
      ${askId}::uuid, ${chain().accountId}::uuid, ${chain().businessId}::uuid,
      ${chain().batchId}::uuid, ${contactId}::uuid, 'send', NULL,
      ${tx.json({ decision: 'send' })}, NOW()
    )
  `;
  return { contactId, askId };
}

/**
 * One `solicitation_outreach` row in the requested lifecycle state, with a
 * fresh ask + contact behind it.
 *
 * Delegates the fifteen NOT NULL columns 091 declares to the shared fixture
 * (`outreach-fixture.ts`) rather than re-spelling them — that helper exists
 * precisely so a sixteenth column is one edit, not four. The dispatch stamps
 * are resolved in SQL off NOW() so a JS `Date`'s truncated microseconds can
 * never mis-order against a NOW()-defaulted sibling (#520).
 */
async function insertOutreachRow(
  tx: postgresType.TransactionSql,
  overrides: { deliveryStatus: string; dispositionReason?: string | null },
): Promise<string> {
  const { contactId, askId } = await seedAskChain(tx);
  const status = overrides.deliveryStatus;
  const dispatched = status === 'queued' || status === 'sending' || status === 'sent';
  return insertOutreach(tx, {
    accountId: chain().accountId,
    businessId: chain().businessId,
    batchId: chain().batchId,
    askId,
    contactId,
    deliveryStatus: status,
    dispositionReason: overrides.dispositionReason ?? null,
    queuedAt: dispatched ? tx`NOW() - INTERVAL '2 seconds'` : null,
    sendingAt: status === 'sending' ? tx`NOW() - INTERVAL '1 second'` : null,
    sentAt: status === 'sent' ? tx`NOW()` : null,
  });
}

async function readBounceKind(
  tx: postgresType.TransactionSql,
  outreachId: string,
): Promise<string | null> {
  const [row] = await tx<{ bounce_kind: string | null }[]>`
    SELECT bounce_kind FROM solicitation_outreach WHERE id = ${outreachId}::uuid
  `;
  if (!row) throw new Error(`outreach row ${outreachId} vanished`);
  return row.bounce_kind;
}

/** One `solicitation_send_breaker` trip row, returned so a caller can reset it. */
async function insertTrip(
  tx: postgresType.TransactionSql,
  overrides: { trip_reason: string },
): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    INSERT INTO solicitation_send_breaker (id, trip_reason, metrics)
    VALUES (
      ${randomUUID()}::uuid, ${overrides.trip_reason},
      ${tx.json({ sends: 100, hard_bounces: 3, complaints: 0 })}
    )
    RETURNING id
  `;
}

describeWithDb(
  'migration 110 — solicitation send governors',
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
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_110_SEND_GOVERNORS,
      ]);

      tenant = await seedTenantAccount(db, { accountDisplayName: 'Migration 110 Fixture' });
      const { businessId } = await seedLocation(db, tenant.accountId, {
        name: 'Migration 110 Location',
      });
      const uploadId = randomUUID();
      const batchId = randomUUID();
      await db`
        INSERT INTO contact_csv_uploads (
          id, account_id, business_id, filename, byte_size, content_sha256,
          raw_csv, status, report, attested_by_user_id, attested_at,
          attestation_version, completed_at
        ) VALUES (
          ${uploadId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
          ${`migration-110-${uploadId}.csv`}, 1,
          ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
          NULL, 'completed', ${db.json({ accepted: 1 })},
          ${tenant.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
        )
      `;
      await db`
        INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id, built_at)
        VALUES (${batchId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
                ${uploadId}::uuid, NOW())
      `;
      fixture = {
        accountId: tenant.accountId,
        userId: tenant.userId,
        businessId,
        uploadId,
        batchId,
      };
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db && tenant) {
          // Every probe rolls back, so this should sweep nothing; deleting the
          // business first cascades the whole solicitation chain, and the
          // account/user pair goes last because the FKs point at it.
          if (fixture) await db`DELETE FROM businesses WHERE id = ${fixture.businessId}::uuid`;
          await cleanupTenantAccount(db, {
            accountId: tenant.accountId,
            userId: tenant.userId,
          });
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

    it('migration 110 admits no_postal_address and postal_address_mismatch on the withheld arm', async () => {
      for (const reason of ['no_postal_address', 'postal_address_mismatch']) {
        await expect(
          sql().begin(async (tx) => {
            await insertOutreachRow(tx, {
              deliveryStatus: 'withheld',
              dispositionReason: reason,
            });
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
      }
    });

    it('migration 110 still rejects an unknown withheld disposition_reason', async () => {
      // Deliberately a reason the Dispatch gate does NOT get (amendment B6
      // item 3 defers instead of withholding), so the CHECK must stay a
      // whitelist rather than becoming "any text".
      await expect(
        sql().begin(async (tx) => {
          await insertOutreachRow(tx, {
            deliveryStatus: 'withheld',
            dispositionReason: 'subscription_lapsed',
          });
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('migration 110 leaves the cancelled, failed and unknown arms of the reason CHECK unchanged', async () => {
      const arms: [string, string][] = [
        ['cancelled', 'owner_veto'],
        ['cancelled', 'owner_halt'],
        ['cancelled', 'admin_halt'],
        ['cancelled', 'owner_excluded'],
        ['cancelled', 'owner_withdrawn'],
        ['cancelled', 'batch_expired'],
        ['cancelled', 'send_window_elapsed'],
        ['cancelled', 'superseded'],
        ['failed', 'send_failed'],
        ['failed', 'send_exhausted'],
        ['unknown', 'send_indeterminate'],
      ];
      for (const [status, reason] of arms) {
        await expect(
          sql().begin(async (tx) => {
            await insertOutreachRow(tx, {
              deliveryStatus: status,
              dispositionReason: reason,
            });
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
      }
    });

    it('bounce_kind accepts only hard or soft and defaults to NULL', async () => {
      // NULL default on insert.
      let defaulted: string | null = 'unset';
      await expect(
        sql().begin(async (tx) => {
          const outreachId = await insertOutreachRow(tx, { deliveryStatus: 'rendered' });
          defaulted = await readBounceKind(tx, outreachId);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(defaulted).toBeNull();

      // 'stale' is rejected by the value CHECK.
      await expect(
        sql().begin(async (tx) => {
          const outreachId = await insertOutreachRow(tx, { deliveryStatus: 'sent' });
          await tx`
            UPDATE solicitation_outreach
               SET bounced_at = NOW(), bounce_kind = 'stale'
             WHERE id = ${outreachId}::uuid
          `;
        }),
      ).rejects.toMatchObject({ code: '23514' });

      // A kind without a bounce is rejected by the pairing CHECK.
      await expect(
        sql().begin(async (tx) => {
          const outreachId = await insertOutreachRow(tx, { deliveryStatus: 'sent' });
          await tx`
            UPDATE solicitation_outreach SET bounce_kind = 'hard' WHERE id = ${outreachId}::uuid
          `;
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('solicitation_send_breaker permits at most one open trip row', async () => {
      await expect(
        sql().begin(async (tx) => {
          await insertTrip(tx, { trip_reason: 'hard_bounce_rate' });
          await insertTrip(tx, { trip_reason: 'complaint_rate' });
        }),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('solicitation_send_breaker admits a second trip once the prior trip is reset', async () => {
      let firstId = '';
      let secondId = '';
      await expect(
        sql().begin(async (tx) => {
          const [first] = await insertTrip(tx, { trip_reason: 'hard_bounce_rate' });
          firstId = first!.id;
          await tx`
            UPDATE solicitation_send_breaker
               SET reset_at = NOW(), reset_by = ${chain().userId}::uuid,
                   reset_note = 'cap rolled back'
             WHERE id = ${firstId}::uuid
          `;
          const [second] = await insertTrip(tx, { trip_reason: 'complaint_rate' });
          secondId = second!.id;
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(secondId).not.toBe('');
      expect(secondId).not.toBe(firstId);
    });

    it('solicitation_send_breaker has row level security enabled and denies the anon role', async () => {
      const [row] = await sql()<{ relrowsecurity: boolean }[]>`
        SELECT c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'solicitation_send_breaker'
      `;
      expect(row?.relrowsecurity).toBe(true);
      const policies = await sql()<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'solicitation_send_breaker'
      `;
      // deny-all: RLS on, no policies (096 precedent).
      expect(policies).toHaveLength(0);
    });
  },
);
