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
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { evaluateSendBreaker, readSendBreaker, resetSendBreaker } from '../send-breaker';

// Live-DB suite for the reputation circuit breaker's read model and latch
// (#898; #622 §3.2B). Four things only the real database can prove:
//
//  1. THE WINDOW BASIS. The denominator is send-dated (`sent_at`) and the
//     numerators are signal-dated (`bounced_at` / `complained_at`). A cohort
//     measure — the intuitive one — dilutes a fresh bad batch with sends whose
//     bounces have not landed, which is the fail-OPEN direction on a governor
//     specified to fail closed.
//  2. THE ONE-OPEN INDEX. Idempotence-while-open is enforced by a partial
//     unique index, so a second breached tick either no-ops or throws 23505 —
//     and only a real index can tell the two apart.
//  3. THE hard/soft SPLIT. The Solicitation lane stamps `bounced_at` for soft
//     bounces too, so `bounced_at` alone cannot serve as the numerator.
//  4. THE RESET ARM. 110's reset_consistency CHECK makes "who cleared this and
//     why" unanswerable-by-omission impossible; only the DB enforces it.
//
// Applies NO migration SQL (#573): `pnpm test:db:setup` provisions the schema
// to head and this suite ASSERTS it. Every write runs inside a transaction that
// is ALWAYS rolled back — the breaker is platform-scoped, so a leaked trip row
// would halt sending for every account in the shared test database.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let seededBusinessId: string | undefined;

/** Thrown to roll a probe transaction back; never escapes this file. */
class Rollback extends Error {
  override readonly name = 'Rollback';
}

/** Swallows the deliberate rollback and re-throws anything else. */
function expectRollback(error: unknown): void {
  if ((error as { name?: string })?.name !== 'Rollback') throw error;
}

function sql(): postgresType.Sql {
  if (!db) throw new Error('send breaker integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('send breaker integration tenant was not seeded');
  return tenant.accountId;
}

function businessId(): string {
  if (!seededBusinessId) throw new Error('send breaker integration location was not seeded');
  return seededBusinessId;
}

interface SeedSendsOptions {
  /** Outreach rows written as `delivery_status='sent'`. */
  sent: number;
  /** The first N of them carry `bounce_kind='hard'`. */
  hardBounced?: number;
  /** The next N carry `bounce_kind='soft'`. */
  softBounced?: number;
  /** The next N carry `complained_at`. */
  complained?: number;
  /** Age of `sent_at`, in days. Defaults to 1 — inside the 7-day window. */
  sentDaysAgo?: number;
  /** Age of `bounced_at` / `complained_at`, in days. Defaults to 1. */
  bouncedDaysAgo?: number;
}

/**
 * `opts.sent` dispatched Outreach rows, each with its own Ask and Contact.
 *
 * Batched as ONE `INSERT … SELECT … FROM generate_series` per table rather than
 * a round trip per row: the smallest meaningful fixture here is 100 rows and
 * the complaint case needs 1,000. The three tables agree on their ids because
 * each derives them from the same nonce and ordinal (`md5(nonce || ':c:' || g)`),
 * so no id has to be threaded between statements.
 *
 * Every timestamp is computed IN POSTGRES off NOW(). A JS `Date` round-tripped
 * through postgres.js loses its microseconds, and these rows are compared
 * against a window boundary derived from NOW() — the #520 mis-ordering.
 */
async function seedSends(
  tx: postgresType.TransactionSql,
  opts: SeedSendsOptions,
): Promise<void> {
  const nonce = randomUUID();
  const uploadId = randomUUID();
  const batchId = randomUUID();
  const hardBounced = opts.hardBounced ?? 0;
  const softBounced = opts.softBounced ?? 0;
  const complained = opts.complained ?? 0;
  const sentDaysAgo = opts.sentDaysAgo ?? 1;
  const bouncedDaysAgo = opts.bouncedDaysAgo ?? 1;

  await tx`
    INSERT INTO contact_csv_uploads (
      id, account_id, business_id, filename, byte_size, content_sha256,
      raw_csv, status, report, attested_by_user_id, attested_at,
      attestation_version, completed_at
    ) VALUES (
      ${uploadId}::uuid, ${accountId()}::uuid, ${businessId()}::uuid,
      ${`send-breaker-${uploadId}.csv`}, 1,
      ${uploadId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)},
      NULL, 'completed', ${tx.json({ accepted: opts.sent })},
      ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION}, NOW()
    )
  `;
  await tx`
    INSERT INTO solicitation_batches (id, account_id, business_id, source_upload_id, built_at)
    VALUES (${batchId}::uuid, ${accountId()}::uuid, ${businessId()}::uuid,
            ${uploadId}::uuid, NOW())
  `;

  await tx`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    SELECT md5(${nonce}::text || ':c:' || g)::uuid,
           ${businessId()}::uuid,
           'Send Breaker Customer',
           'breaker-' || ${nonce}::text || '-' || g || '@test.local',
           ${uploadId}::uuid
      FROM generate_series(1, ${opts.sent}::int) AS g
  `;
  await tx`
    INSERT INTO solicitation_asks (
      id, account_id, business_id, batch_id, contact_id, status,
      withheld_reason, evidence, decided_at
    )
    SELECT md5(${nonce}::text || ':a:' || g)::uuid,
           ${accountId()}::uuid, ${businessId()}::uuid, ${batchId}::uuid,
           md5(${nonce}::text || ':c:' || g)::uuid,
           'send', NULL, jsonb_build_object('decision', 'send'), NOW()
      FROM generate_series(1, ${opts.sent}::int) AS g
  `;
  await tx`
    INSERT INTO solicitation_outreach (
      id, account_id, business_id, batch_id, ask_id, contact_id,
      rendered_subject, rendered_body, prompt_version, prompt_hash,
      interpolation_inputs, rendered_at, ask_lint_version, lint_detail,
      moderation_status, moderation_detail, delivery_status,
      queued_at, sent_at, bounced_at, bounce_kind, complained_at
    )
    SELECT
      md5(${nonce}::text || ':o:' || g)::uuid,
      ${accountId()}::uuid, ${businessId()}::uuid, ${batchId}::uuid,
      md5(${nonce}::text || ':a:' || g)::uuid,
      md5(${nonce}::text || ':c:' || g)::uuid,
      'How did we do?', 'Would you mind leaving a review?',
      'solicitation_ask_v1',
      md5(${nonce}::text || ':h:' || g) || md5(${nonce}::text || ':k:' || g),
      '{}'::jsonb,
      NOW() - make_interval(days => ${sentDaysAgo}::int),
      'ask_lint_v1', '{}'::jsonb, 'clean', '{}'::jsonb, 'sent',
      NOW() - make_interval(days => ${sentDaysAgo}::int) - INTERVAL '1 minute',
      NOW() - make_interval(days => ${sentDaysAgo}::int),
      CASE WHEN g <= ${hardBounced}::int + ${softBounced}::int
           THEN NOW() - make_interval(days => ${bouncedDaysAgo}::int) END,
      CASE WHEN g <= ${hardBounced}::int THEN 'hard'
           WHEN g <= ${hardBounced}::int + ${softBounced}::int THEN 'soft' END,
      CASE WHEN g > ${hardBounced}::int + ${softBounced}::int
            AND g <= ${hardBounced}::int + ${softBounced}::int + ${complained}::int
           THEN NOW() - make_interval(days => ${bouncedDaysAgo}::int) END
      FROM generate_series(1, ${opts.sent}::int) AS g
  `;
}

async function countOpenTrips(tx: postgresType.TransactionSql): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM solicitation_send_breaker WHERE reset_at IS NULL
  `;
  return row?.count ?? 0;
}

describeWithDb(
  'solicitation send breaker (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 180_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        // The 1,000-row complaint fixture outruns PgBouncer's ~8s default.
        connection: { statement_timeout: 30_000 },
      });
      await assertSchemaReady(db, [
        MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
        MIGRATION_110_SEND_GOVERNORS,
      ]);
      tenant = await seedTenantAccount(db, { accountDisplayName: 'Send Breaker Fixture' });
      const location = await seedLocation(db, tenant.accountId, {
        name: 'Send Breaker Location',
      });
      seededBusinessId = location.businessId;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db && tenant) {
          if (seededBusinessId) {
            await db`DELETE FROM businesses WHERE id = ${seededBusinessId}::uuid`;
          }
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

    it('the breaker does not trip below the 100-send minimum however bad the rate', async () => {
      // 99 sends, 99 hard bounces = 100% — still no trip. Small-N noise must
      // not halt sending for the whole platform.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 99, hardBounced: 99 });
          const finding = await evaluateSendBreaker(tx);
          expect(finding).toBeNull();
          expect(await countOpenTrips(tx)).toBe(0);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('the breaker trips when the hard bounce rate exceeds 2 percent over 100 or more sends', async () => {
      // 100 sends, 3 hard bounces = 3% > 2%.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100, hardBounced: 3 });
          const finding = await evaluateSendBreaker(tx);
          expect(finding?.key).toBe('solicitation_send_breaker_tripped');
          expect(finding?.level).toBe('error');
          expect(finding?.detail).toMatchObject({ trip_reason: 'hard_bounce_rate', sends: 100 });
          const [trip] = await tx<{ trip_reason: string }[]>`
            SELECT trip_reason FROM solicitation_send_breaker WHERE reset_at IS NULL
          `;
          expect(trip?.trip_reason).toBe('hard_bounce_rate');
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('the breaker trips when the complaint rate exceeds 0.3 percent over 100 or more sends', async () => {
      // 1000 sends, 4 complaints = 0.4% > 0.3%, zero bounces.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 1000, complained: 4 });
          const finding = await evaluateSendBreaker(tx);
          expect(finding?.detail).toMatchObject({ trip_reason: 'complaint_rate' });
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('the breaker counts a bounce by bounced_at and a send by sent_at over the same 7 day window', async () => {
      // The locked window basis: numerator signal-dated, denominator
      // send-dated. A row sent 9 days ago whose bounce landed TODAY still
      // counts in the numerator, and is absent from the denominator. 100
      // in-window sends, zero in-window bounces, plus 3 old sends that bounced
      // today -> 3/100 = 3%.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100 });
          await seedSends(tx, { sent: 3, hardBounced: 3, sentDaysAgo: 9, bouncedDaysAgo: 0 });
          const finding = await evaluateSendBreaker(tx);
          expect(finding?.detail).toMatchObject({
            trip_reason: 'hard_bounce_rate',
            sends: 100,
            hard_bounces: 3,
          });
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('the breaker ignores soft bounces when computing the hard bounce rate', async () => {
      // 100 sends, 50 SOFT bounces, zero hard. No trip: a full mailbox is not
      // a reputation event, and bounced_at alone cannot tell the two apart.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100, softBounced: 50 });
          expect(await evaluateSendBreaker(tx)).toBeNull();
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('evaluateSendBreaker is idempotent while a trip is already open', async () => {
      // The one-open partial index makes a second trip a 23505 unless the
      // insert tolerates it. Two evaluations against a breached window must
      // leave ONE row and page ONCE, not every five minutes.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100, hardBounced: 3 });
          const first = await evaluateSendBreaker(tx);
          const second = await evaluateSendBreaker(tx);
          expect(first).not.toBeNull();
          expect(second).toBeNull();
          expect(await countOpenTrips(tx)).toBe(1);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('readSendBreaker reports open while a trip is unreset and clear once it is reset', async () => {
      await sql()
        .begin(async (tx) => {
          expect((await readSendBreaker(tx)).open).toBe(false);
          await seedSends(tx, { sent: 100, hardBounced: 3 });
          await evaluateSendBreaker(tx);
          const tripped = await readSendBreaker(tx);
          expect(tripped.open).toBe(true);
          expect(tripped.trip?.tripReason).toBe('hard_bounce_rate');
          await resetSendBreaker(tx, {
            actorUserId: tenant!.userId,
            note: 'ramp rolled back to stage 1',
          });
          expect((await readSendBreaker(tx)).open).toBe(false);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('the breaker reports hard_bounce_rate when both thresholds breach in the same window', async () => {
      // classifyBreach checks hard bounce FIRST. Without this test that
      // precedence is unobservable, and a reversed implementation passes every
      // other test — then pages the wrong metric on the one night both go bad
      // at once.
      await sql()
        .begin(async (tx) => {
          // 3% hard bounce and 1% complaint.
          await seedSends(tx, { sent: 1000, hardBounced: 30, complained: 10 });
          const finding = await evaluateSendBreaker(tx);
          expect(finding?.detail).toMatchObject({ trip_reason: 'hard_bounce_rate' });
          const [trip] = await tx<{ trip_reason: string }[]>`
            SELECT trip_reason FROM solicitation_send_breaker WHERE reset_at IS NULL
          `;
          expect(trip?.trip_reason).toBe('hard_bounce_rate');
          throw new Rollback();
        })
        .catch(expectRollback);
    });
  },
);
