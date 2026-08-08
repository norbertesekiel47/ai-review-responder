// src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts
//
// T0 EVAL suite for #677 — titles 31–33 and 61 of the intake's 69, authored
// VERBATIM before implementation.
//
// The LIVE half of the decision API. Every title here is one a mocked `sql` tag
// structurally cannot express:
//
//  - 31 is a ROLLBACK. Proving the consent write disappears when the outbox
//    INSERT fails requires a real transaction boundary; a mock can only prove
//    the calls were made in order.
//  - 32 is a BYTE-IDENTICAL row comparison after a rejected write, across five
//    facts (decision, decision_at, expires_at, zero new outbox rows, zero new
//    analytics rows). Round 1 set this bar precisely because "the offer row was
//    written" is the assertion that passes while the feature is still wrong.
//  - 33 and 61 are RACES. Two concurrent accepts, and an acceptance racing
//    connect-finalize, must each yield exactly one zernio_initial_backfill row.
//
// A fifth title lived here until 2026-08-07 — "GET import-offer self-heal records
// import_offer_created in the same transaction" — and moved to #679 with the rest
// of the analytics slice (deviations D7): the event name needs the
// analytics_events.event_name CHECK extended, which needs a migration this
// ticket's non-goals forbid. #679 must restore it as a SAME-TRANSACTION
// assertion, because the self-healed offer is precisely the one that would
// otherwise vanish from the offer-created → decision-recorded ratio.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema, and
// NEVER applies migration SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertAnalyticsEventNamesRegistered,
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
  MIGRATION_102_IMPORT_CONSENT_EVENTS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { abortingExecutor } from '@/lib/shared/__tests__/helpers/abort-injection';
import {
  createImportOffer,
  recordImportDecisionAndEnqueue,
} from '@/lib/reviews/import-consent';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-offer route integration database was not initialized');
  return db;
}

async function setOffer(expiresAtSql: string | null): Promise<void> {
  await sql().unsafe(
    `UPDATE businesses
        SET import_decision = 'pending', import_decision_at = NULL,
            import_offer_expires_at = ${expiresAtSql ? `(${expiresAtSql})` : 'NULL'}
      WHERE id = '${businessId}'::uuid`,
  );
}

async function consentRow() {
  const [row] = await sql()<{
    import_decision: string;
    import_decision_at: Date | null;
    import_offer_expires_at: Date | null;
  }[]>`
    SELECT import_decision, import_decision_at, import_offer_expires_at
    FROM businesses WHERE id = ${businessId}::uuid
  `;
  return row!;
}

async function outboxRows() {
  return sql()<{ id: string }[]>`
    SELECT id FROM job_outbox
    WHERE aggregate_id = ${businessId}::uuid
      AND topic = 'zernio_initial_backfill'
  `;
}

async function analyticsCount(): Promise<number> {
  const [row] = await sql()<{ n: string }[]>`
    SELECT count(*)::text AS n FROM analytics_events
    WHERE account_id = ${tenant!.accountId}::uuid
  `;
  return Number(row!.n);
}

/**
 * `job_outbox`'s constraint count — the relation the replaced temporary CHECK
 * constraint used to strand on. Read-only over `pg_constraint`; issues no DDL.
 */
async function jobOutboxConstraintCount(): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'job_outbox'::regclass
  `;
  return row!.n;
}

// ── The abort injection ─────────────────────────────────────────────────────

/** `analytics_events_business_id_fkey`. Asserted, so a lock timeout cannot pass for it. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * THIS SUITE'S POISON for the shared `abortingExecutor`
 * (`@/lib/shared/__tests__/helpers/abort-injection`): the writer runs its whole
 * transaction and Postgres then aborts it with a REAL error, raised on the
 * writer's own connection, inside the writer's own `sql.begin`.
 *
 * IT REPLACED A TEMPORARY CHECK CONSTRAINT (#694). The rollback title below used
 * to force its abort with `ALTER TABLE job_outbox ADD CONSTRAINT
 * tmp_block_import_topic … / DROP CONSTRAINT` in a `finally`. A vitest TIMEOUT
 * skips the `finally`, so the constraint strands on the shared container and
 * blocks every sibling suite that enqueues `zernio_initial_backfill` — the
 * sibling copy of exactly this pair produced 14 spurious failures across three
 * suites (#679 deviations D20). It also took ACCESS EXCLUSIVE on `job_outbox`,
 * the most contended relation in the live-DB set, against suites in other
 * vitest processes that nothing serializes it against. The helper header carries
 * the full reasoning; the poison stays here because a deterministic SQLSTATE
 * depends on this fixture's own constraints.
 *
 * THE FAILURE MUST ORIGINATE IN POSTGRES, not in JS. A plain JS throw does not
 * poison a Postgres transaction, so a test built on one proves nothing about a
 * transaction that is actually in aborted state — which is the state the real
 * hazard produces. The statement is an INSERT whose `business_id` points at a
 * uuid that does not exist, tripping `analytics_events_business_id_fkey` at
 * statement time: SQLSTATE 23503. It lands AFTER the consent write and AFTER the
 * enqueue, so it survives a refactor that moves either.
 *
 * The event name is one migration 102 registers and `beforeAll` asserts that
 * registration, so the CHECK admits the row and the foreign key is the only
 * constraint it violates — the SQLSTATE is deterministic. `account_id` is left
 * NULL, so the row could not satisfy `analyticsCount`'s account predicate even
 * if it somehow survived.
 */
const foreignKeyPoison = async (tx: postgresType.TransactionSql): Promise<void> => {
  await tx`
    INSERT INTO analytics_events (id, event_key, event_name, distinct_id, business_id)
    VALUES (
      ${randomUUID()}::uuid,
      ${`forced-abort-${randomUUID()}`},
      'import_decision_recorded',
      'forced-abort',
      ${randomUUID()}::uuid
    )
  `;
};

describeWithDb('import-offer decision API against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // max:4 — titles 33 and 61 are races and need genuinely separate sessions.
    db = postgres(testDatabaseUrl!, { max: 4, prepare: false });
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    // The precondition `assertSchemaReady` structurally cannot carry (#679
    // review round 1): migration 102 adds no relation, column or index, and its
    // constraint NAME has existed since 046 — so it correctly exports no
    // SchemaRequirement. "…self-heal records import_offer_created in the same
    // transaction" ASSERTS the event row exists; on a database at 101 the
    // emission is rejected, swallowed by its savepoint, and that title fails as
    // "expected length 1, received 0" instead of naming the behind-head DB.
    await assertAnalyticsEventNamesRegistered(db, MIGRATION_102_IMPORT_CONSENT_EVENTS);
    tenant = await seedTenantAccount(db, {
      userName: 'Decision Owner',
      accountDisplayName: 'Decision Account',
    });
    await sql()`
      UPDATE accounts SET subscription_activated_at = now()
      WHERE id = ${tenant.accountId}::uuid
    `;
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Decision Location', 'Decision Owner',
              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await sql()`
      INSERT INTO zernio_connections (
        id, business_id, zernio_profile_id, zernio_account_id,
        zernio_location_id, status, connected_at
      ) VALUES (
        ${randomUUID()}::uuid, ${businessId}::uuid, 'prof-decision',
        'acct-decision', 'loc-decision', 'active', now()
      )
    `;
  });

  beforeEach(async () => {
    await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
    await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant!.accountId}::uuid`;
  });

  afterAll(async () => {
    if (!db) return;
    await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant!.accountId}::uuid`;
    await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
    await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    if (tenant) await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });
  it('live DB: accept rolls back the import consent write when the job_outbox INSERT fails', async () => {
    await setOffer("now() + interval '3 days'");

    // Force a statement to fail INSIDE the acceptance transaction, without
    // touching production code and without DDL: the writer runs to completion —
    // consent write and outbox INSERT included — and Postgres then rejects a
    // real foreign key on the same transaction, leaving it in the aborted state
    // a failing outbox INSERT produces. A mocked sql tag cannot prove rollback at
    // all — it has no transaction to roll back. See `foreignKeyPoison` for why
    // this replaced the temporary `tmp_block_import_topic` CHECK constraint it
    // used to add and drop in a `finally` (#694).
    await expect(
      recordImportDecisionAndEnqueue(
        abortingExecutor(sql(), foreignKeyPoison), businessId, tenant!.accountId, 'accepted',
      ),
    ).rejects.toThrow();

    // The consent write must NOT have survived. If it had, the owner would be
    // recorded as having consented to an import that was never queued — and the
    // banner would sit at "importing" forever with nothing to do it.
    const row = await consentRow();
    expect(row.import_decision).toBe('pending');
    expect(row.import_decision_at).toBeNull();
    expect(await outboxRows()).toHaveLength(0);
  });

  it('the shared abort injection raises a real Postgres error without executing any DDL', async () => {
    // The rollback title above asserts three ABSENCES, and an injection that
    // quietly stopped firing produces the same absences as a rollback that
    // worked. This pins the injection itself: the mechanism is the shared
    // helper's, the poison is this suite's, and neither may reintroduce the
    // temporary constraint the pair replaced.
    await setOffer("now() + interval '3 days'");
    const constraintsBefore = await jobOutboxConstraintCount();

    // Originates in Postgres — a JS throw would not poison the transaction.
    await expect(
      recordImportDecisionAndEnqueue(
        abortingExecutor(sql(), foreignKeyPoison), businessId, tenant!.accountId, 'accepted',
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

    // AND IT STRANDED NOTHING on the shared container, which is the property the
    // "without executing any DDL" half of the title is actually for. This is the
    // exact regression the temporary-constraint approach caused: a vitest TIMEOUT
    // skipped its `finally` and `tmp_block_import_topic` survived on `job_outbox`,
    // blocking every sibling suite that enqueues `zernio_initial_backfill` (#679
    // deviations D20). Counting the relation's constraints across the aborted
    // transaction pins the COMMITTED-leak half of that: if the injection ever
    // starts leaving an object behind on a normal run, this goes red. It cannot
    // pin the TIMEOUT case itself — a timeout means this line never executes.
    // What rules that case out is structural, not assertive: the injection holds
    // no schema on any path, so there is nothing for a skipped `finally` to
    // strand. The assertion guards the property; the design is what guarantees
    // it under a timeout. Preferred over the previous grep of the poison's
    // `Function.toString()` for DDL keywords inspected the wrong thing (the
    // poison, not the shared mechanism), duplicated `ci:live-db-suites` in a
    // strictly weaker place, and failed OPEN on any refactor that moved the
    // statement out of the function body (review round 1, B3).
    expect(await jobOutboxConstraintCount()).toBe(constraintsBefore);
  });

  it('live DB: a rejected late POST leaves decision, decision_at, expires_at, outbox rows and analytics rows unchanged', async () => {
    // Deadline already passed → the guarded UPDATE matches nothing.
    await setOffer("now() - interval '1 second'");
    const before = await consentRow();
    const analyticsBefore = await analyticsCount();

    const outcome = await recordImportDecisionAndEnqueue(
      sql(), businessId, tenant!.accountId, 'accepted',
    );

    expect(outcome).toBe('expired');
    // Byte-identical across all three columns — round 1 set this bar because
    // "the offer row was written" is the assertion that passes while the feature
    // is still wrong.
    expect(await consentRow()).toEqual(before);
    expect(await outboxRows()).toHaveLength(0);
    expect(await analyticsCount()).toBe(analyticsBefore);
  });

  it('live DB: two concurrent accept requests commit one transition and exactly one zernio_initial_backfill row', async () => {
    await setOffer("now() + interval '3 days'");

    const [a, b] = await Promise.all([
      recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
      recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
    ]);

    // One wins, one is refused. Both reporting 'recorded' would mean the guarded
    // UPDATE matched twice — a lost update.
    expect([a, b].filter((r) => r === 'recorded')).toHaveLength(1);
    expect([a, b].filter((r) => r === 'already_answered')).toHaveLength(1);
    expect((await consentRow()).import_decision).toBe('accepted');
    // The row lock is what makes this exactly one rather than two.
    expect(await outboxRows()).toHaveLength(1);
  });

  // Title 61 — the cross-producer race, and note WHICH producers: acceptance vs
  // connect-finalize. Reactivation is deliberately EXCLUDED from this assertion:
  // it enqueues with backfill_reason 'reactivation' and the worker's
  // ON CONFLICT … WHERE run_reason = 'initial' does not dedup it, because the
  // archived-period catch-up is supposed to recur. Round 3 flagged the earlier
  // unqualified wording for exactly this reason — read across all four
  // producers it contradicted reactivation's intended behaviour.
  it('concurrent acceptance and connect finalize under the businesses row lock create exactly one zernio_initial_backfill row', async () => {
    await setOffer("now() + interval '3 days'");

    // Producer A: the acceptance transaction. Producer B: a stand-in for connect
    // finalize — the same row lock, then the same guarded INSERT … WHERE NOT
    // EXISTS. Reactivation is deliberately EXCLUDED from this assertion: it
    // enqueues with backfill_reason 'reactivation' and the worker's
    // ON CONFLICT … WHERE run_reason = 'initial' does not dedup it, because the
    // archived-period catch-up is supposed to recur.
    async function finalizeLikeProducer(): Promise<void> {
      await sql().begin(async (tx) => {
        await tx`
          SELECT id FROM businesses
          WHERE id = ${businessId}::uuid AND account_id = ${tenant!.accountId}::uuid
          FOR UPDATE
        `;
        const [row] = await tx<{ state: string }[]>`
          SELECT import_decision AS state FROM businesses WHERE id = ${businessId}::uuid
        `;
        if (row?.state !== 'accepted') return;
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT ${randomUUID()}, 'zernio_initial_backfill', 'business',
                 ${businessId}::uuid, ${tx.json({ business_id: businessId })}, 'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.aggregate_id = ${businessId}::uuid
              AND jo.topic = 'zernio_initial_backfill'
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;
      });
    }

    await Promise.all([
      recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
      finalizeLikeProducer(),
    ]);

    // Whichever order they interleave in, the lock serializes them and the
    // WHERE NOT EXISTS sees a committed view. Without the lock this is a
    // check-then-insert race and both can insert.
    expect(await outboxRows()).toHaveLength(1);
    expect((await consentRow()).import_decision).toBe('accepted');
  });

  // The title #677 parked here and moved to #679 with the rest of the analytics
  // slice (deviations D7). Restored as a SAME-TRANSACTION assertion, because the
  // self-healed offer is precisely the one that would otherwise vanish from the
  // offer-created → decision-recorded ratio: its junction-time write FAILED, so
  // if the event rode the junction instead of the writer it was never emitted.
  it('GET import-offer self-heal records import_offer_created in the same transaction', async () => {
    // The state the self-heal exists for: pending, no deadline, at the junction.
    await setOffer(null);

    const seen = await sql().begin(async (tx) => {
      // The route's self-heal transaction, reproduced rather than imported —
      // `route.ts` reads the `sql` singleton at module scope, which this suite
      // cannot point at the test database (same reason as finalizeLikeProducer
      // above). Row lock, then createImportOffer, one transaction
      // (`route.ts:93-101`).
      await tx`
        SELECT id FROM businesses
        WHERE id = ${businessId}::uuid AND account_id = ${tenant!.accountId}::uuid
        FOR UPDATE
      `;
      const result = await createImportOffer(tx, businessId, tenant!.accountId);
      // Read INSIDE the transaction: an event written against the outer client
      // would commit even if the repair rolled back, reporting an offer the
      // owner never received.
      const rows = await tx<{ event_key: string; distinct_id: string }[]>`
        SELECT event_key, distinct_id FROM analytics_events
        WHERE account_id = ${tenant!.accountId}::uuid
          AND event_name = 'import_offer_created'
      `;
      return { result, rows };
    });

    expect(seen.result).toBe('created');
    expect(seen.rows).toHaveLength(1);
    // Business-scoped key: two tabs racing the self-heal mint one event.
    expect(seen.rows[0]!.event_key).toContain(businessId);
    expect(seen.rows[0]!.distinct_id).toBe(tenant!.accountId);
  });

  it('createImportOffer under concurrency stamps exactly one deadline', async () => {
    // Not one of the 69 titles: it closes the offer-creation half of the same race
    // the enqueue titles cover. Four producers can reach createImportOffer at once
    // (connect finalize, the Stripe resume, and the GET self-heal on two tabs), and
    // its `import_offer_expires_at IS NULL` guard is also check-then-write. If two
    // succeeded, the second would overwrite the first owner-visible deadline.
    await setOffer(null);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        sql().begin(async (tx) => {
          await tx`
            SELECT id FROM businesses
            WHERE id = ${businessId}::uuid AND account_id = ${tenant!.accountId}::uuid
            FOR UPDATE
          `;
          return createImportOffer(tx, businessId, tenant!.accountId);
        }),
      ),
    );

    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'unchanged')).toHaveLength(3);
    expect((await consentRow()).import_offer_expires_at).not.toBeNull();
  });
});
