// The Refusal ledger's write path — live-Postgres eval (#1009 slice 2, T1, RED).
//
// Titles 12-15, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// WHY THIS FILE EXISTS BESIDE `write.test.ts`. The unit suite proves the helper
// EMITS the right statement text. Only a real database proves the two claims
// text cannot reach:
//
//   * the byte-for-byte `ON CONFLICT` predicate actually INFERS
//     `refusal_events_subject_uniq` — a clause that reads right and infers
//     nothing raises 23505 and poisons the transaction the decision lives in
//     (titles 12 and 13); and
//   * `'transaction_time'` takes the DECIDING transaction's clock, to the
//     microsecond, which is the substitute join #1006 accepted in place of a
//     `suspension_event_id` column (titles 14 and 15).
//
// Applies NO migration SQL and executes NO DDL. `pnpm test:db:setup` provisions
// the schema; this file asserts it with `assertSchemaReady` and seeds with
// `INSERT` only — run-time DDL deadlocks (40P01) across concurrent suites, and
// `ci:live-db-suites` R2 enforces that.
//
// It DOES hold the cross-process live-DB lock. `refusal_events_subject_uniq` is
// a GLOBAL partial unique index with no tenant column in it, and the
// ArchivalPoller's retention arm sweeps this table platform-wide — so a live-DB
// writer in another vitest process is exactly the false-green risk the lock
// exists for. Same reasoning as #1008's migration-116 suite.
//
// Migration 116's five CHECKs, C1's fall-through and both partial-index
// idempotency cases are proven by that suite already. What is proven HERE is
// the same behaviour THROUGH the helper — which is the untested claim.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
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
import { writeRefusalEvent, type WriteRefusalEventInput } from '../write';

/**
 * Declared locally rather than added to `schema-ready.ts`: that helper lives
 * outside this branch's `allowed_edit_surface`, and #1008's own 116 suite
 * declares its requirement inline for the same reason.
 */
const MIGRATION_116_REFUSAL_EVENTS: SchemaRequirement = {
  migration: '116_refusal_events',
  tables: ['refusal_events'],
  indexes: [
    'idx_refusal_events_archival',
    'idx_refusal_events_account_window',
    'refusal_events_subject_uniq',
  ],
};

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
let seededBusinessId: string | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('refusal write integration database was not initialized');
  return db;
}

function accountId(): string {
  if (!tenant) throw new Error('refusal write integration tenant was not seeded');
  return tenant.accountId;
}

function locationId(): string {
  if (!seededBusinessId) throw new Error('refusal write integration location was not seeded');
  return seededBusinessId;
}

/** The account-wide lane: `business_id` NULL (C3), no subject (C1/C2). */
function autonomySuspended(
  overrides: Partial<WriteRefusalEventInput> = {},
): WriteRefusalEventInput {
  return {
    accountId: accountId(),
    businessId: null,
    refusalSource: 'autonomy_suspended',
    refusalCode: 'judge_flag',
    allRefusalCodes: null,
    refusalCategory: 'autonomy_paused',
    subjectType: null,
    subjectId: null,
    occurredAt: 'transaction_time',
    ...overrides,
  };
}

/** A per-location lane WITH a subject — the only shape the partial index sees. */
function heldDraft(subjectId: string): WriteRefusalEventInput {
  return {
    accountId: accountId(),
    businessId: locationId(),
    refusalSource: 'held_draft',
    refusalCode: null,
    allRefusalCodes: null,
    refusalCategory: 'unsafe_content',
    subjectType: 'response',
    subjectId,
    occurredAt: 'transaction_time',
  };
}

async function countRefusals(
  where: postgresType.PendingQuery<postgresType.Row[]>,
): Promise<number> {
  const [row] = await sql()<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM refusal_events WHERE ${where}
  `;
  return Number(row?.count ?? -1);
}

describeWithDb(
  'writeRefusalEvent against live local Postgres',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
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
        userName: 'Refusal Write Owner',
        accountDisplayName: 'Refusal Write Account',
      });
      const location = await seedLocation(db, tenant.accountId, {
        name: 'Refusal Write Location',
      });
      seededBusinessId = location.businessId;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      // The kill switch is default-ON; every case here is about the ENABLED
      // path, so a leaked 'false' from another suite must not silently turn
      // them all into no-ops that still pass.
      delete process.env.REFUSAL_LEDGER_ENABLED;
    });

    afterEach(async () => {
      await sql()`DELETE FROM refusal_events WHERE account_id = ${accountId()}::uuid`;
    }, 60_000);

    afterAll(async () => {
      try {
        if (db) {
          if (tenant) {
            await db`DELETE FROM refusal_events WHERE account_id = ${tenant.accountId}::uuid`;
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

    it('the helper writing the same (refusal_source, subject_id) twice leaves one row and lets the caller transaction commit', async () => {
      const subjectId = randomUUID();

      // BOTH writes inside ONE transaction, and a read AFTER them in the same
      // transaction. That third statement is the actual proof: if the
      // `ON CONFLICT` predicate failed to infer the partial index, the second
      // INSERT raises 23505, the transaction is poisoned, and this read cannot
      // run at all. A helper whose clause merely READS byte-for-byte right
      // fails here and passes the unit suite's text assertion.
      const survivors = await sql().begin(async (tx) => {
        await writeRefusalEvent(tx, heldDraft(subjectId));
        await writeRefusalEvent(tx, heldDraft(subjectId));
        const [row] = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM refusal_events WHERE subject_id = ${subjectId}::uuid
        `;
        return Number(row?.count ?? -1);
      });

      expect(survivors).toBe(1);

      // …and the transaction COMMITTED, so the surviving row is durable rather
      // than rolled back with a swallowed error.
      expect(await countRefusals(sql()`subject_id = ${subjectId}::uuid`)).toBe(1);
    });

    it('the helper writing two autonomy_suspended rows for one account leaves two rows, because the partial index excludes a null subject', async () => {
      // The index predicate is `WHERE subject_id IS NOT NULL`, so a NULL subject
      // is never deduplicated. An account suspended twice is two separate
      // decisions, and collapsing them would erase the second suspension from
      // the ledger entirely.
      await sql().begin((tx) => writeRefusalEvent(tx, autonomySuspended()));
      await sql().begin((tx) => writeRefusalEvent(tx, autonomySuspended()));

      expect(
        await countRefusals(
          sql()`account_id = ${accountId()}::uuid AND refusal_source = 'autonomy_suspended'`,
        ),
      ).toBe(2);
    });

    it("occurredAt 'transaction_time' stamps occurred_at from the deciding transaction, never from insert time", async () => {
      // `NOW()` in Postgres IS `transaction_timestamp()` — transaction START,
      // not statement time. That is the whole reason #1006 could decline a
      // `suspension_event_id` column and take an exact equality join against
      // `account_audit_log.created_at` instead. This case measures it rather
      // than asserting it from memory.
      const clocks = await sql().begin(async (tx) => {
        const [before] = await tx<{ tx_time: string; clock_time: string }[]>`
          SELECT transaction_timestamp()::text AS tx_time, clock_timestamp()::text AS clock_time
        `;
        // Move the wall clock WITHIN the transaction. Without this the two
        // clocks agree and the case is vacuous.
        await tx`SELECT pg_sleep(0.25)`;
        await writeRefusalEvent(tx, autonomySuspended());
        const [after] = await tx<{ clock_time: string }[]>`
          SELECT clock_timestamp()::text AS clock_time
        `;
        return {
          txTime: before!.tx_time,
          clockBefore: before!.clock_time,
          clockAfter: after!.clock_time,
        };
      });

      // The fixture did what it claimed: statement/wall time really moved.
      expect(clocks.clockAfter).not.toBe(clocks.clockBefore);

      // Read as ::text on purpose. postgres.js decodes timestamptz to a JS Date
      // and TRUNCATES microseconds (#520) — the six digits `NOW()` carries are
      // exactly what a Date round trip destroys, and the #1006 join dies with
      // them.
      const [row] = await sql()<{ occurred_at: string }[]>`
        SELECT occurred_at::text AS occurred_at
        FROM refusal_events WHERE account_id = ${accountId()}::uuid
      `;

      expect(row?.occurred_at).toBe(clocks.txTime);
      // A helper stamping insert time — or opening its OWN connection instead of
      // using the caller's `tx` — lands on the later clock and fails here.
      expect(row?.occurred_at).not.toBe(clocks.clockAfter);
    });

    it('occurredAt as a Date stamps occurred_at with that exact Date, read back without microsecond truncation', async () => {
      // The lane that decides BEFORE it persists — `outreach_withheld` decides
      // during the LLM round trip — passes the decision time explicitly. The
      // stored value must be that instant and not a rounded neighbour.
      const decidedAt = new Date('2026-03-04T05:06:07.123Z');

      await sql().begin((tx) =>
        writeRefusalEvent(tx, autonomySuspended({ occurredAt: decidedAt })),
      );

      const [row] = await sql()<{
        occurred_at: string;
        expected_at: string;
        now_at: string;
        exact: boolean;
        epoch_ms: string;
      }[]>`
        SELECT occurred_at::text AS occurred_at,
               (${decidedAt}::timestamptz)::text AS expected_at,
               NOW()::text AS now_at,
               (occurred_at = ${decidedAt}::timestamptz) AS exact,
               (EXTRACT(EPOCH FROM occurred_at) * 1000)::bigint::text AS epoch_ms
        FROM refusal_events WHERE account_id = ${accountId()}::uuid
      `;

      expect(row?.exact).toBe(true);
      // Compared against a DB-RENDERED reference rather than a hand-written
      // string: `timestamptz::text` renders in the session's TimeZone, so a
      // literal expectation would pin the suite to one server setting.
      expect(row?.occurred_at).toBe(row?.expected_at);
      // The millisecond survives the round trip in BOTH directions: the epoch
      // read matches the JS instant, and the rendered text still carries `.123`
      // rather than a truncated `.12` or a bare second.
      expect(row?.epoch_ms).toBe(String(decidedAt.getTime()));
      expect(row?.occurred_at).toContain('.123');

      // And the value is not silently the transaction clock: a helper that
      // ignored the `Date` arm and always emitted `NOW()` would land on today.
      expect(row?.occurred_at).not.toBe(row?.now_at);
    });
  },
);
