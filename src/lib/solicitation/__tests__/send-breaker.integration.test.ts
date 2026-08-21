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
import {
  BREAKER_COMPLAINT_RATE,
  BREAKER_WINDOW_DAYS,
  evaluateSendBreaker,
  readSendBreaker,
  resetSendBreaker,
} from '../send-breaker';

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
//  5. THE RESET-BOUNDED WINDOW, which is TWO floors and not one. The rolling
//     7-day signal floor dates the numerators; the last reset dates rows by
//     their SEND on BOTH sides. Whether the pre-reset cohort really leaves the
//     measurement — its late-landing signals included — is a fact about SQL,
//     not about TypeScript.
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
  /**
   * The next N carry `bounced_at` with `bounce_kind` **NULL** — an
   * UNCLASSIFIED bounce (#898, B1.4), the row the Solicitation lane writes
   * when the provider hands it a type this codebase does not recognise.
   *
   * Distinct from "no bounce" and from "soft": 110's bounce_kind_pairing CHECK
   * (`bounce_kind IS NULL OR bounced_at IS NOT NULL`) admits exactly this shape
   * so the bounce FACT can be recorded without asserting a kind, and
   * readBreakerWindow counts it WITH the hard bounces.
   */
  unclassifiedBounced?: number;
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
  const unclassifiedBounced = opts.unclassifiedBounced ?? 0;
  const complained = opts.complained ?? 0;
  const sentDaysAgo = opts.sentDaysAgo ?? 1;
  const bouncedDaysAgo = opts.bouncedDaysAgo ?? 1;
  // The four ordinal bands, as running totals: [1, hardBounced] hard,
  // then soft, then unclassified (bounced_at set, kind NULL), then complained.
  // Named here rather than re-spelled as sums inside three CASE arms, where the
  // unclassified band's arithmetic would have to be repeated and could drift.
  const softThrough = hardBounced + softBounced;
  const bouncedThrough = softThrough + unclassifiedBounced;
  const complainedThrough = bouncedThrough + complained;

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
      CASE WHEN g <= ${bouncedThrough}::int
           THEN NOW() - make_interval(days => ${bouncedDaysAgo}::int) END,
      -- No ELSE arm: the unclassified band falls through to NULL, which is the
      -- point of that band and what 110's pairing CHECK deliberately admits.
      CASE WHEN g <= ${hardBounced}::int THEN 'hard'
           WHEN g <= ${softThrough}::int THEN 'soft' END,
      CASE WHEN g > ${bouncedThrough}::int AND g <= ${complainedThrough}::int
           THEN NOW() - make_interval(days => ${bouncedDaysAgo}::int) END
      FROM generate_series(1, ${opts.sent}::int) AS g
  `;
}

interface BreakerCounts {
  sends: number;
  hardBounces: number;
  complaints: number;
}

/**
 * The window counters AS THE PRE-FIX QUERY COMPUTED THEM — one floor, applied
 * to the denominator only, with neither numerator conditioned on `sent_at`.
 *
 * A frozen record of round-2 adversarial R2-1, not a mirror of anything live:
 * this shape no longer exists in `send-breaker.ts`, so it cannot drift out of
 * step with production. Its only job is to stand next to the shipped numbers
 * over the SAME rows and show that the fixture below discriminates — without
 * it, "the breaker did not trip" is unfalsifiable, because a fixture that never
 * had a trailing signal in it would not trip either.
 */
async function measureOneFloorShape(tx: postgresType.TransactionSql): Promise<BreakerCounts> {
  const [row] = await tx<{ sends: number; hard_bounces: number; complaints: number }[]>`
    WITH bounds AS (
      SELECT GREATEST(
               NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS}::int),
               (SELECT MAX(reset_at) FROM solicitation_send_breaker)
             ) AS window_start
    )
    SELECT
      COUNT(*) FILTER (WHERE o.sent_at >= b.window_start)::int AS sends,
      COUNT(*) FILTER (
        WHERE o.bounced_at >= b.window_start
          AND (o.bounce_kind = 'hard' OR o.bounce_kind IS NULL)
      )::int AS hard_bounces,
      COUNT(*) FILTER (WHERE o.complained_at >= b.window_start)::int AS complaints
    FROM solicitation_outreach o
    CROSS JOIN bounds b
    WHERE o.sent_at >= b.window_start
       OR o.bounced_at >= b.window_start
       OR o.complained_at >= b.window_start
  `;
  return {
    sends: row?.sends ?? 0,
    hardBounces: row?.hard_bounces ?? 0,
    complaints: row?.complaints ?? 0,
  };
}

/**
 * The shipped two-floor shape, run over the same rows so the two counts can be
 * read side by side.
 *
 * DELIBERATELY NOT THE LOAD-BEARING ASSERTION — `evaluateSendBreaker` is, and
 * every case here asserts on it. If `readBreakerWindow` ever changes and this
 * copy does not, the production assertion still governs the verdict and this
 * one degrades to stale documentation rather than to a false pass.
 */
async function measureTwoFloorShape(tx: postgresType.TransactionSql): Promise<BreakerCounts> {
  const [row] = await tx<{ sends: number; hard_bounces: number; complaints: number }[]>`
    WITH bounds AS (
      SELECT
        NOW() - make_interval(days => ${BREAKER_WINDOW_DAYS}::int) AS signal_floor,
        COALESCE(
          (SELECT MAX(reset_at) FROM solicitation_send_breaker),
          '-infinity'::timestamptz
        ) AS reset_floor
    )
    SELECT
      COUNT(*) FILTER (
        WHERE o.sent_at >= GREATEST(b.signal_floor, b.reset_floor)
      )::int AS sends,
      COUNT(*) FILTER (
        WHERE o.bounced_at >= b.signal_floor
          AND o.sent_at >= b.reset_floor
          AND (o.bounce_kind = 'hard' OR o.bounce_kind IS NULL)
      )::int AS hard_bounces,
      COUNT(*) FILTER (
        WHERE o.complained_at >= b.signal_floor
          AND o.sent_at >= b.reset_floor
      )::int AS complaints
    FROM solicitation_outreach o
    CROSS JOIN bounds b
    WHERE o.sent_at >= GREATEST(b.signal_floor, b.reset_floor)
       OR (o.sent_at >= b.reset_floor
             AND (o.bounced_at >= b.signal_floor OR o.complained_at >= b.signal_floor))
  `;
  return {
    sends: row?.sends ?? 0,
    hardBounces: row?.hard_bounces ?? 0,
    complaints: row?.complaints ?? 0,
  };
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

    it('the breaker counts an unclassified bounce with the hard bounces', async () => {
      // HALF TWO of the fail-CLOSED unclassified-bounce path (#898, B1.4). Half
      // one is in worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts:
      // the Solicitation lane leaves bounce_kind NULL rather than asserting a
      // kind it cannot know. NEITHER HALF IS SAFE ALONE — half one WITHOUT this
      // FILTER branch makes the breaker strictly MORE fail-open than the `soft`
      // default it replaced, because a NULL kind matches neither 'hard' nor
      // 'soft' and the bounce disappears from the measurement entirely.
      //
      // THE ONLY BOUNCES HERE ARE UNCLASSIFIED. Zero rows carry
      // bounce_kind='hard' — a fixture that seeded 'hard' would prove nothing
      // about this branch, since the plain `bounce_kind = 'hard'` FILTER passes
      // it. 3 unclassified over 100 sends is 3% > 2%.
      //
      // Delete `OR o.bounce_kind IS NULL` from readBreakerWindow's hard-bounce
      // FILTER and hard_bounces falls to 0, the rate to 0, classifyBreach to
      // null, and `finding` to null: this case is the only one in the suite
      // that goes red, which is exactly the "tidy the NULL branch away"
      // refactor it exists to stop.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100, unclassifiedBounced: 3 });

          // Fixture guard: assert the seeded shape before asserting behaviour,
          // so this can never pass because the fixture quietly stamped a kind.
          const [seeded] = await tx<{ unclassified: number; classified: number }[]>`
            SELECT
              COUNT(*) FILTER (WHERE bounced_at IS NOT NULL AND bounce_kind IS NULL)::int
                AS unclassified,
              COUNT(*) FILTER (WHERE bounce_kind IS NOT NULL)::int AS classified
              FROM solicitation_outreach
             WHERE business_id = ${businessId()}::uuid
          `;
          expect(seeded).toMatchObject({ unclassified: 3, classified: 0 });

          const finding = await evaluateSendBreaker(tx);
          expect(finding?.key).toBe('solicitation_send_breaker_tripped');
          expect(finding?.level).toBe('error');
          expect(finding?.detail).toMatchObject({
            trip_reason: 'hard_bounce_rate',
            sends: 100,
            hard_bounces: 3,
            // Nothing else could have tripped it: the complaint numerator is
            // empty, so 'hard_bounce_rate' can only have come from the three
            // unclassified rows.
            complaints: 0,
          });
          // The latch really closed — the finding is not the whole effect.
          const [trip] = await tx<{ trip_reason: string }[]>`
            SELECT trip_reason FROM solicitation_send_breaker WHERE reset_at IS NULL
          `;
          expect(trip?.trip_reason).toBe('hard_bounce_rate');
          expect(await countOpenTrips(tx)).toBe(1);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('evaluateSendBreaker is idempotent while a trip is already open', async () => {
      // IDEMPOTENCE CONSTRAINS THE ROW, NOT THE FINDING. This test used to
      // assert the second evaluation returned null, which encoded the
      // edge-triggered paging bug (round-1 adversarial-3 / std-2) as a promise:
      // one dropped Sentry event then left sending halted platform-wide with no
      // notification, indefinitely. What must stay idempotent is the WRITE — the
      // one-open partial index makes a second trip a 23505 unless the insert
      // tolerates it — so two evaluations against a breached window still leave
      // exactly ONE row. The finding is now level-triggered and repeats.
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100, hardBounced: 3 });
          const first = await evaluateSendBreaker(tx);
          const second = await evaluateSendBreaker(tx);
          expect(first).not.toBeNull();
          expect(second).not.toBeNull();
          expect(second?.key).toBe('solicitation_send_breaker_tripped');
          expect(second?.detail).toMatchObject({ still_open: true });
          expect(await countOpenTrips(tx)).toBe(1);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('the breaker keeps paging while a trip is open even after the window falls back under the threshold', async () => {
      // The halt OUTLIVES the breach that caused it: nothing self-clears, so a
      // trip whose breaching signals have aged out is still halting every
      // account's sending. An empty window here (zero sends, zero signals) is
      // the extreme form — classifyBreach would call it healthy — and the check
      // must still page, because a level-trigger reports STATE, not an edge.
      await sql()
        .begin(async (tx) => {
          await tx`
            INSERT INTO solicitation_send_breaker (id, trip_reason, metrics)
            VALUES (${randomUUID()}::uuid, 'complaint_rate',
                    ${tx.json({
                      sends: 1000,
                      hardBounces: 0,
                      complaints: 9,
                      hardBounceRate: 0,
                      complaintRate: 0.009,
                    })})
          `;
          const finding = await evaluateSendBreaker(tx);
          expect(finding?.key).toBe('solicitation_send_breaker_tripped');
          expect(finding?.level).toBe('error');
          expect(finding?.title).toContain('STILL halted');
          expect(finding?.detail).toMatchObject({
            trip_reason: 'complaint_rate',
            still_open: true,
          });
          expect(await countOpenTrips(tx)).toBe(1);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('a reset bounds the window so recovery is reachable and post-reset sends are still measured', async () => {
      // ROUND-1 adversarial-1 / B2.1, end to end. Before the reset bound, the
      // window was a pure function of history that no operator action could
      // move: halting stopped the denominator while late-landing signals kept
      // arriving, so the ratio got WORSE while halted and every reset re-tripped
      // within one poll interval. Runbook §8.3's procedure could not work.
      //
      // Both halves are asserted on purpose, because each alone would be a
      // different bug: the reset must actually clear (or there is no recovery),
      // and post-reset sends must still be measured (or the reset is a way to
      // switch the platform's reputation governor off).
      await sql()
        .begin(async (tx) => {
          await seedSends(tx, { sent: 100, hardBounced: 3 });
          expect(await evaluateSendBreaker(tx)).not.toBeNull();

          await resetSendBreaker(tx, {
            actorUserId: tenant!.userId,
            note: 'bad list purged; ramp rolled back to stage 1',
          });

          // The window's lower edge is now the reset, so the breaching cohort —
          // its sends AND its bounces — is out of the measurement entirely. The
          // BREAKER_MIN_SENDS floor then suppresses a re-trip until 100 fresh
          // sends accumulate: the intended half-open probe, not a hole.
          expect(await evaluateSendBreaker(tx)).toBeNull();
          expect(await countOpenTrips(tx)).toBe(0);

          // 100 sends AFTER the reset at the same 3% hard bounce rate re-trip at
          // once, which is what bounds the abuse: a reset buys at most 100 sends
          // of ungoverned volume, never a disabled breaker. NOW() is fixed for
          // the whole transaction, so `sentDaysAgo: 0` lands exactly on the
          // window start, which the `>=` boundary includes.
          await seedSends(tx, { sent: 100, hardBounced: 3, sentDaysAgo: 0, bouncedDaysAgo: 0 });
          const reTrip = await evaluateSendBreaker(tx);
          expect(reTrip?.detail).toMatchObject({
            trip_reason: 'hard_bounce_rate',
            sends: 100,
            hard_bounces: 3,
          });
          expect(await countOpenTrips(tx)).toBe(1);
          throw new Rollback();
        })
        .catch(expectRollback);
    });

    it('a signal that lands after a reset for a send made before it counts on neither side', async () => {
      // ROUND-2 adversarial R2-1. The sibling case above seeds `bouncedDaysAgo:
      // 1` on every row, so its signals are always as old as their sends and it
      // CANNOT see this: the first reset bound conditioned the DENOMINATOR on
      // `sent_at` and left both numerators dated by their signal alone, so a
      // send from BEFORE the reset whose complaint landed AFTER it was dropped
      // from the denominator while still counting in the numerator. One
      // trailing complaint then read as 1.00% against a fresh 100-send
      // denominator — over three times the 0.3% bar — and re-tripped the very
      // recovery the reset bound was added to make reachable.
      //
      // Signals lag their sends by minutes to days, so this is the NORMAL shape
      // of a reset, not a corner: an operator resets while the tail of the bad
      // cohort is still in flight, by construction.
      await sql()
        .begin(async (tx) => {
          // A pre-reset cohort bad enough to halt the platform.
          await seedSends(tx, { sent: 100, hardBounced: 3, sentDaysAgo: 3, bouncedDaysAgo: 3 });
          expect(await evaluateSendBreaker(tx)).not.toBeNull();

          // The operator purges the list and resets. reset_at = NOW(), which is
          // FIXED for the whole transaction — every "days ago" below is an
          // offset from that same instant.
          await resetSendBreaker(tx, {
            actorUserId: tenant!.userId,
            note: 'bad list purged; ramp rolled back to stage 1',
          });
          expect(await evaluateSendBreaker(tx)).toBeNull();

          // THEN the tail lands: one complaint, for a send made before the
          // reset. Written here rather than in the fixture precisely so the
          // ordering is the statement order — the signal arrives after the
          // operator has already accounted for that cohort.
          const late = await tx`
            UPDATE solicitation_outreach
               SET complained_at = NOW(), updated_at = NOW()
             WHERE id = (
               SELECT id FROM solicitation_outreach
                WHERE business_id = ${businessId()}::uuid
                  AND bounced_at IS NULL
                  AND complained_at IS NULL
                LIMIT 1
             )
          `;
          expect(late.count).toBe(1);

          // Fixture guard: the complaint is not before the reset, and its send
          // is. Assert the SHAPE before asserting behaviour, so this can never
          // pass because the fixture quietly stopped straddling the reset.
          const [straddle] = await tx<{ signal_not_before: boolean; send_before: boolean }[]>`
            SELECT bool_and(o.complained_at >= b.reset_at) AS signal_not_before,
                   bool_and(o.sent_at < b.reset_at)        AS send_before
              FROM solicitation_outreach o
              CROSS JOIN (SELECT MAX(reset_at) AS reset_at FROM solicitation_send_breaker) b
             WHERE o.complained_at IS NOT NULL
          `;
          expect(straddle).toMatchObject({ signal_not_before: true, send_before: true });

          // The legitimate recovery: 100 clean sends after the reset.
          await seedSends(tx, { sent: 100, sentDaysAgo: 0 });

          // THE TWO NUMBERS, over the same rows in the same transaction. The
          // one-floor shape sees a 1% complaint rate and would halt the
          // platform again; the shipped shape sees none, because the send that
          // produced that complaint is on the far side of the reset.
          const oneFloor = await measureOneFloorShape(tx);
          const twoFloor = await measureTwoFloorShape(tx);
          expect(oneFloor).toMatchObject({ sends: 100, hardBounces: 0, complaints: 1 });
          expect(oneFloor.complaints / oneFloor.sends).toBeGreaterThan(BREAKER_COMPLAINT_RATE);
          expect(twoFloor).toMatchObject({ sends: 100, hardBounces: 0, complaints: 0 });

          // And the verdict that actually governs: production does not re-trip.
          expect(await evaluateSendBreaker(tx)).toBeNull();
          expect(await countOpenTrips(tx)).toBe(0);
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
