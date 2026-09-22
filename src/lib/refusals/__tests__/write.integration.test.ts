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
import {
  writeRefusalEvent,
  type RefusalOccurredAt,
  type WriteRefusalEventInput,
} from '../write';
// NAMESPACE import for the SET-BASED arm (#1010 T2). A named import of an
// export that does not exist yet fails the whole FILE at collection, which at
// the RED phase would take the four pre-existing single-row cases down with it.
// Same reason `approval.integration.test.ts` reaches its admin arm this way.
import * as refusalWrite from '../write';

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
    'refusal_events_subject_uniq',
  ],
};

/**
 * Migration 123 (#1081) SUPERSEDED 116's `idx_refusal_events_account_window`
 * with `idx_refusal_events_account_window_covering` — the same leading keys
 * plus `id DESC` and an `INCLUDE (business_id)`. It is asserted as its OWN
 * requirement rather than folded into 116's: a database carrying the 116 index
 * and not this one is BEHIND head, and the failure must name the migration
 * that fixes it.
 */
const MIGRATION_123_REFUSAL_READ_INDEXES: SchemaRequirement = {
  migration: '123_refusal_read_indexes',
  indexes: ['idx_refusal_events_account_window_covering'],
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

/**
 * The account-wide lane: `business_id` NULL (C3), no subject (C1/C2).
 *
 * The override is `occurredAt` ALONE, and deliberately not a
 * `Partial<WriteRefusalEventInput>`: the input is now a discriminated union with
 * one arm per lane, so a partial over it would let a case override this lane's
 * shape into another lane's — exactly the pairing the union exists to make
 * unspellable. The decision time is the only axis these cases vary.
 */
function autonomySuspended(
  overrides: { occurredAt?: RefusalOccurredAt } = {},
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

/**
 * The `ask_withheld` lane, exactly as `commitAskDecisions` proposes it (#1010):
 * per-location, pointing at one `solicitation_asks` row, the withheld reason
 * verbatim as the code, and the batch's own `decidedAt` as the decision time.
 *
 * `subject_id` carries NO foreign key (migration 116's own comment says why), so
 * these cases can mint subject ids without seeding the solicitation chain.
 */
function askWithheld(subjectId: string, occurredAt: Date = ASK_DECIDED_AT): WriteRefusalEventInput {
  return {
    accountId: accountId(),
    businessId: locationId(),
    refusalSource: 'ask_withheld',
    refusalCode: 'no_consent',
    allRefusalCodes: null,
    refusalCategory: 'no_permission',
    subjectType: 'solicitation_ask',
    subjectId,
    occurredAt,
  };
}

/** One batch's decision time — every row a build proposes shares it. */
const ASK_DECIDED_AT = new Date('2026-08-30T09:08:07.006Z');

/** Every `ask_withheld` row this account carries, newest subject order-stable. */
async function readAskRefusals(): Promise<{ subject_id: string; refusal_code: string }[]> {
  return sql()<{ subject_id: string; refusal_code: string }[]>`
    SELECT subject_id::text AS subject_id, refusal_code
    FROM refusal_events
    WHERE account_id = ${accountId()}::uuid
      AND refusal_source = 'ask_withheld'
    ORDER BY subject_id
  `;
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
      await assertSchemaReady(db, [MIGRATION_116_REFUSAL_EVENTS, MIGRATION_123_REFUSAL_READ_INDEXES]);
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

    // ── #1010 T2: the SET-BASED arm, against real Postgres ──────────────────
    //
    // The three claims about this arm that only a database can settle: that the
    // second spelling of the `ON CONFLICT` predicate actually INFERS
    // `refusal_events_subject_uniq` (both within one statement and ACROSS
    // calls), and that a successful set write belongs to the CALLER's
    // transaction rather than to a connection of its own.

    it('the set-based arm writes one row per input and leaves one row when the same subject appears twice in one call', async () => {
      const first = randomUUID();
      const second = randomUUID();

      // BOTH duplicates in the SAME call, deliberately. `ON CONFLICT DO NOTHING`
      // resolves a conflict against a row the statement ITSELF is inserting;
      // `DO UPDATE` raises 21000 on exactly this shape. Two calls would prove a
      // different, weaker thing — that case is the one below.
      const survivors = await sql().begin(async (tx) => {
        await refusalWrite.writeRefusalEvents(tx, [
          askWithheld(first),
          askWithheld(second),
          askWithheld(first),
        ]);
        // Read INSIDE the transaction: a clause that reads right and infers
        // nothing raises 23505, the transaction is poisoned, and this statement
        // cannot run at all. That failure is the whole point of the case.
        const [row] = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM refusal_events
          WHERE account_id = ${accountId()}::uuid
        `;
        return Number(row?.count ?? -1);
      });

      // Three inputs, two subjects, two rows.
      expect(survivors).toBe(2);

      // …and the transaction COMMITTED, so both rows are durable and each names
      // the subject it was proposed for.
      expect(await readAskRefusals()).toEqual(
        [first, second]
          .map((subjectId) => ({ subject_id: subjectId, refusal_code: 'no_consent' }))
          .sort((left, right) => left.subject_id.localeCompare(right.subject_id)),
      );
    });

    it('the set-based arm commits when an input subject already exists from an earlier call', async () => {
      // Round-1 plan review R1-7. `commitAskDecisions` — the set-insert idiom
      // this arm follows — asserts `inserted.count === input.length`, which
      // holds there because it has no `ON CONFLICT`. Copying that assertion here
      // is a BUG: a subject stored by an EARLIER call legitimately lowers the
      // count, and the throw would land inside a decision transaction, with the
      // ledger breaking the very thing it records.
      //
      // De-duplicating within the call does NOT hide this. The duplicate is
      // cross-call, so only the affected-row count can see it.
      const carriedOver = randomUUID();
      const fresh = randomUUID();

      await sql().begin((tx) => refusalWrite.writeRefusalEvents(tx, [askWithheld(carriedOver)]));

      // Two inputs, one of them already stored: ONE row is inserted, the call
      // does NOT reject — an affected-count assertion would throw right here —
      // and the durable rows below are what prove the transaction committed.
      await expect(
        sql().begin((tx) =>
          refusalWrite.writeRefusalEvents(tx, [askWithheld(carriedOver), askWithheld(fresh)]),
        ),
      ).resolves.toBeUndefined();

      expect(await readAskRefusals()).toHaveLength(2);
      expect(
        await countRefusals(sql()`subject_id = ${carriedOver}::uuid`),
        'the carried-over subject stays ONE row, not two',
      ).toBe(1);
      expect(await countRefusals(sql()`subject_id = ${fresh}::uuid`)).toBe(1);
    });

    it("a set-based ledger write does not survive its caller's deciding transaction rolling back after the insert succeeds", async () => {
      // Round-1 plan review R1-3, and the ONLY case that discriminates
      // invariant #15 for this arm. Every other case here would pass against a
      // helper that opened its own connection: a FAILED insert leaves nothing
      // behind on either connection, so the two are indistinguishable when the
      // statement raises. Here the write SUCCEEDS first and the caller aborts
      // afterwards for a reason that has nothing to do with the ledger — a
      // private connection has already COMMITTED its rows independently, and
      // they are still there at the last assertion.
      //
      // Nothing else catches this shape: `ci:db-imports` matches the
      // `@/lib/db/server` specifier only, so a bare `postgres(…)` constructed
      // inside `src/lib/refusals/` is invisible to it.
      const abort = new Error('caller aborted after the ledger wrote — unrelated to the ledger');
      const subjects = [randomUUID(), randomUUID()];

      await expect(
        sql().begin(async (tx) => {
          await refusalWrite.writeRefusalEvents(tx, subjects.map((id) => askWithheld(id)));

          // Read inside the transaction, BEFORE aborting it. A helper that
          // silently wrote nothing would otherwise satisfy the zero-rows
          // assertion below by vacuum.
          const [written] = await tx<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM refusal_events
            WHERE account_id = ${accountId()}::uuid
          `;
          expect(Number(written?.count ?? -1)).toBe(subjects.length);

          throw abort;
        }),
      ).rejects.toBe(abort);

      // The rows went down with the decision they recorded.
      expect(await readAskRefusals()).toEqual([]);
    });
  },
);
