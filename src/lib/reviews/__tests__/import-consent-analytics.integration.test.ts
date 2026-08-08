// src/lib/reviews/__tests__/import-consent-analytics.integration.test.ts
//
// #679 T2 — the two Import offer analytics events (`import_offer_created`,
// `import_decision_recorded`), deferred out of #677 (deviations D7) because
// they need the `analytics_events.event_name` CHECK extended, which needed a
// migration that ticket's non-goals forbade.
//
// WHY ITS OWN FILE (review round 1, Medium). These eight titles are a distinct
// feature slice appended to `import-consent.integration.test.ts`, which they
// pushed from 790 to 1039 lines. The branch had already set the precedent by
// opening a separate file for the migration-102 shape slice. Splitting also
// shrinks the blast radius of the abort injection below, which is the one test
// in the feature area that deliberately makes a transaction fail. Every title
// moved VERBATIM — the `promised-tests` gate greps them wherever they live.
//
// WHY LIVE POSTGRES: every property that matters here is a transaction
// boundary or an `ON CONFLICT`. Both events are emitted from INSIDE the writing
// transaction, so an event can never outlive the fact it reports — and a mocked
// `sql` tag can prove the call was made and nothing else.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema via
// assertSchemaReady, and NEVER applies migration SQL. No statement in this file
// changes the schema, on any path — including the abort injection below, which
// is where the previous version of this slice broke that rule.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
import {
  createImportOffer,
  IMPORT_OFFER_WINDOW_DAYS,
  recordImportDecisionAndEnqueue,
} from '../import-consent';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-consent analytics integration database was not initialized');
  return db;
}

// ── Fixture controls ────────────────────────────────────────────────────────
//
// Every helper writes through SQL rather than through the module under test, so
// a broken writer cannot set up its own passing precondition.

/**
 * Set the three consent columns directly.
 *
 * The deadline and decision timestamp are passed as SQL EXPRESSIONS (`null` =>
 * SQL NULL), never JS Dates: postgres.js truncates timestamptz microseconds to
 * milliseconds (CLAUDE.md gotcha). Values are test-controlled literals, so
 * `unsafe` interpolation is appropriate here and keeps the helper legible. It
 * is ordinary DML — this suite issues no DDL anywhere.
 */
async function setConsent(opts: {
  decision?: 'pending' | 'accepted' | 'declined';
  /** e.g. `now() + interval '3 days'`. `null` => SQL NULL. */
  expiresAtSql?: string | null;
  /** e.g. `now()`. `null` => SQL NULL. */
  decidedAtSql?: string | null;
}): Promise<void> {
  const decision = opts.decision ?? 'pending';
  const expires = opts.expiresAtSql ? `(${opts.expiresAtSql})` : 'NULL';
  const decided = opts.decidedAtSql ? `(${opts.decidedAtSql})` : 'NULL';
  await sql().unsafe(
    `UPDATE businesses
        SET import_decision = '${decision}',
            import_decision_at = ${decided},
            import_offer_expires_at = ${expires}
      WHERE id = '${businessId}'::uuid`,
  );
}

/** The junction: activation + an active connection. */
async function atJunction(): Promise<void> {
  await sql()`
    UPDATE accounts SET subscription_activated_at = now()
    WHERE id = ${tenant!.accountId}::uuid
  `;
  await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
  await sql()`
    INSERT INTO zernio_connections (
      id, business_id, zernio_profile_id, zernio_account_id,
      zernio_location_id, status, connected_at
    ) VALUES (
      ${randomUUID()}::uuid, ${businessId}::uuid, 'prof-import-analytics',
      'acct-import-analytics', 'loc-import-analytics', 'active', now()
    )
  `;
}

async function readRaw() {
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

async function outboxCount(): Promise<number> {
  const [row] = await sql()<{ n: string }[]>`
    SELECT count(*)::text AS n FROM job_outbox
    WHERE aggregate_id = ${businessId}::uuid
      AND topic = 'zernio_initial_backfill'
  `;
  return Number(row!.n);
}

async function clearOutbox(): Promise<void> {
  await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
}

async function clearRuns(): Promise<void> {
  await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
}

interface AnalyticsRow {
  event_key: string;
  event_name: string;
  account_id: string | null;
  distinct_id: string;
  properties: unknown;
}

/** Postgres.js + PgBouncer can hand JSONB back as a string (CLAUDE.md gotcha). */
function analyticsProperties(row: AnalyticsRow): Record<string, unknown> {
  const { properties } = row;
  return (
    typeof properties === 'string' ? JSON.parse(properties) : properties
  ) as Record<string, unknown>;
}

async function readAnalytics(
  eventName: 'import_offer_created' | 'import_decision_recorded',
  exec: postgresType.Sql | postgresType.TransactionSql = sql(),
): Promise<AnalyticsRow[]> {
  return exec<AnalyticsRow[]>`
    SELECT event_key, event_name, account_id, distinct_id, properties
    FROM analytics_events
    WHERE account_id = ${tenant!.accountId}::uuid
      AND event_name = ${eventName}
    ORDER BY event_key
  `;
}

async function clearAnalytics(): Promise<void> {
  await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant!.accountId}::uuid`;
}

// ── The abort injection ─────────────────────────────────────────────────────

/** `analytics_events_business_id_fkey`. Asserted, so a lock timeout cannot pass for it. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * A `Sql` that lets `recordImportDecisionAndEnqueue` run its whole transaction
 * and then aborts it with a REAL Postgres error, raised on the writer's own
 * connection, inside the writer's own `sql.begin`.
 *
 * NON-DDL BY CONSTRUCTION, and that is the whole point (review round 1, High).
 * The previous version of this test forced its abort by adding a temporary
 * CHECK constraint to `job_outbox` and dropping it in a `finally`. A vitest
 * TIMEOUT skips the `finally`, so the constraint stranded on the shared
 * container and blocked every sibling suite that enqueues
 * `zernio_initial_backfill` — 14 spurious failures across three suites, already
 * observed (deviations D20). It also took ACCESS EXCLUSIVE on the most
 * contended relation in the live-DB set, against suites in other vitest
 * processes that nothing serializes it against. This injection holds no schema,
 * takes no ACCESS EXCLUSIVE lock, and leaves nothing behind whether the test
 * passes, fails, or times out.
 *
 * THE FAILURE MUST ORIGINATE IN POSTGRES, not in JS. A plain JS throw does not
 * poison a Postgres transaction, so a test built on one proves nothing about a
 * transaction that is actually in aborted state — which is the state the real
 * hazard produces. The injected statement is an INSERT whose `business_id`
 * points at a uuid that does not exist, tripping
 * `analytics_events_business_id_fkey` at statement time: SQLSTATE 23503, the
 * same class of in-transaction constraint failure as the `23514` this test
 * stands in for (an `analytics_events_event_name_check` rejection on a database
 * that never got migration 102). It lands AFTER the emission and AFTER the
 * enqueue, so it survives a refactor that moves either.
 *
 * A `Proxy` over a REAL `Sql`, never a `{ begin } as unknown as Sql` cast: a
 * bare object cast would typecheck the test against a local restatement of the
 * interface (deviations D22's failure class) instead of the shipped one. A
 * `get`-only trap does not intercept `apply`, so the tagged-template call form
 * forwards untouched.
 */
function abortingExecutor(base: postgresType.Sql): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const callback = args[args.length - 1] as (
          tx: postgresType.TransactionSql,
        ) => Promise<unknown>;
        return target.begin(async (tx) => {
          const result = await callback(tx);
          // The event name is one migration 102 registered (asserted in
          // beforeAll), so the ONLY constraint this row violates is the
          // foreign key — the SQLSTATE is deterministic. `account_id` is left
          // NULL, so the row could not satisfy `readAnalytics`'s account
          // predicate even if it somehow survived.
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
          return result;
        });
      };
    },
  });
}

describeWithDb('import consent analytics against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // max:4, not max:1 — the executor-identity mutation this suite exists to
    // catch (an emission written against the OUTER `sql` instead of `tx`) needs
    // a SECOND connection to be observable at all; on a single-connection pool
    // it queues in JS forever and the failure reads as an unexplained timeout.
    //
    // lock_timeout, for the same mutation. That outer-`sql` INSERT into
    // analytics_events takes FOR KEY SHARE on the businesses row via
    // `analytics_events_business_id_fkey`, against the FOR UPDATE the
    // acceptance transaction is already holding on another pooled connection —
    // an application-level deadlock Postgres cannot detect. Bounded, it
    // surfaces as a named 55P03 that fails the 23503 assertion in seconds;
    // unbounded, as a 30s vitest timeout. Nothing in the happy path waits on a
    // lock, so the bound never fires on green.
    db = postgres(testDatabaseUrl!, {
      max: 4,
      prepare: false,
      // Milliseconds — postgres.js forwards `connection` entries as startup
      // parameters and `lock_timeout` is a USERSET GUC whose bare unit is ms.
      connection: { lock_timeout: 5_000 },
    });
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    // The precondition `assertSchemaReady` structurally cannot carry (review
    // round 1, Medium): migration 102 adds no relation, column or index, and
    // its constraint NAME has existed since 046 — so it correctly exports no
    // SchemaRequirement, and a presence check would prove nothing. Every title
    // below asserts that an event row EXISTS; on a database at 101 the emission
    // is rejected, swallowed by its savepoint, and the whole suite fails as
    // "expected length 1, received 0" instead of the loud, named "DB is behind
    // head" the convention exists to give.
    await assertAnalyticsEventNamesRegistered(db, MIGRATION_102_IMPORT_CONSENT_EVENTS);
    tenant = await seedTenantAccount(db, {
      userName: 'Import Analytics Owner',
      accountDisplayName: 'Import Analytics Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${businessId}::uuid, 'Import Analytics Location', 'Import Analytics Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id::text = ${businessId}`;
      await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  // ── #679 T2: the two Import offer analytics events ──────────────────────────
  //
  // The offer-created → decision-recorded ratio is the offer-to-answer churn
  // signal #677's intake named and D7 deferred here (`observability` item 2).
  // Both events are emitted from INSIDE the writing transaction, so an event
  // can never outlive the fact it reports.

  it('createImportOffer records import_offer_created in the same transaction', async () => {
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await clearAnalytics();

    const seen = await sql().begin(async (tx) => {
      const result = await createImportOffer(tx, businessId, tenant!.accountId);
      // Read INSIDE the same transaction. Reading after the commit would pass
      // just as well for an emission that used the OUTER `sql` handle and
      // therefore committed independently of the offer write.
      return { result, rows: await readAnalytics('import_offer_created', tx) };
    });

    expect(seen.result).toBe('created');
    expect(seen.rows).toHaveLength(1);
    const event = seen.rows[0]!;
    // distinct_id is the account id, matching every other account-scoped event.
    expect(event.distinct_id).toBe(tenant!.accountId);
    expect(event.account_id).toBe(tenant!.accountId);
    expect(analyticsProperties(event)).toEqual({ window_days: IMPORT_OFFER_WINDOW_DAYS });
  });

  it('createImportOffer records no analytics event when the offer already exists', async () => {
    // The idempotent re-entry. `createImportOffer` runs on EVERY dashboard mount
    // through the GET self-heal, so an emission on the `unchanged` branch would
    // re-mint an offer-created event on every render and destroy the ratio the
    // event exists to measure.
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '6 days'" });
    await clearAnalytics();

    const seen = await sql().begin(async (tx) => {
      const result = await createImportOffer(tx, businessId, tenant!.accountId);
      return { result, rows: await readAnalytics('import_offer_created', tx) };
    });

    expect(seen.result).toBe('unchanged');
    expect(seen.rows).toHaveLength(0);
  });

  it('recordImportDecisionAndEnqueue records import_decision_recorded on an accepted decision', async () => {
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');

    const rows = await readAnalytics('import_decision_recorded');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.distinct_id).toBe(tenant!.accountId);
    expect(analyticsProperties(rows[0]!)).toEqual({ decision: 'accepted' });
  });

  it('recordImportDecisionAndEnqueue records import_decision_recorded on a declined decision', async () => {
    // A decline is an ANSWER, not a rejection: it is the denominator half of the
    // churn ratio, and it takes the early-return branch before the enqueue — the
    // branch an emission placed next to `enqueueInitialImport` would miss.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'declined'))
      .toBe('recorded');

    const rows = await readAnalytics('import_decision_recorded');
    expect(rows).toHaveLength(1);
    expect(analyticsProperties(rows[0]!)).toEqual({ decision: 'declined' });
    expect(await outboxCount()).toBe(0);
  });

  it('recordImportDecisionAndEnqueue records no analytics event when the decision is rejected', async () => {
    // All three rejection classes, because the value of the event is that its
    // count equals the number of decisions that actually landed.
    await atJunction();
    await clearRuns();

    const cases: Array<{ rejection: string; arrange: () => Promise<void> }> = [
      { rejection: 'no_offer', arrange: () => setConsent({ decision: 'pending', expiresAtSql: null }) },
      {
        rejection: 'expired',
        arrange: () => setConsent({ decision: 'pending', expiresAtSql: "now() - interval '1 second'" }),
      },
      {
        rejection: 'already_answered',
        arrange: () => setConsent({
          decision: 'declined',
          expiresAtSql: "now() + interval '3 days'",
          decidedAtSql: 'now()',
        }),
      },
    ];

    for (const testCase of cases) {
      await testCase.arrange();
      await clearOutbox();
      await clearAnalytics();

      expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
        .toBe(testCase.rejection);

      expect(await readAnalytics('import_decision_recorded'), testCase.rejection).toHaveLength(0);
    }
  });

  it('recordImportDecisionAndEnqueue rolls back import_decision_recorded when the decision transaction aborts', async () => {
    // THE EXECUTOR-IDENTITY BUG, pinned BEHAVIOURALLY. `recordImportDecision-
    // AndEnqueue` has both `sql` and `tx` in scope; an emission written against
    // the outer `sql` passes every happy-path test above while COMMITTING
    // independently of a decision that later rolls back — a recorded decision
    // that never happened. Observing a committed event after a successful call
    // cannot tell the two apart, so force the abort instead.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    // The writer runs its whole transaction and Postgres then rejects a real
    // foreign key inside it — no schema change, nothing left behind. See
    // `abortingExecutor` for why the failure must come from Postgres and why
    // this replaced the temporary-constraint pair it used to force.
    await expect(
      recordImportDecisionAndEnqueue(
        abortingExecutor(sql()), businessId, tenant!.accountId, 'accepted',
      ),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

    expect(await readAnalytics('import_decision_recorded')).toHaveLength(0);
    // And the decision itself did not survive either — the event and the fact
    // it reports live and die together.
    expect((await readRaw()).import_decision).toBe('pending');
    expect(await outboxCount()).toBe(0);
  });

  it('import_offer_created uses a business-scoped event key so a replayed offer mints once', async () => {
    // Both events are at-most-once per business by construction (the offer write
    // requires a NULL deadline; the decision write requires `pending`), so the
    // key needs no discriminator — and a replay must drop on
    // `ON CONFLICT (event_key) DO NOTHING` rather than double-count.
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await clearAnalytics();

    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId)))
      .toBe('created');
    const first = await readAnalytics('import_offer_created');
    expect(first).toHaveLength(1);
    expect(first[0]!.event_key).toContain(businessId);

    // The replay: the deadline is cleared and the offer written a second time.
    // The WRITE succeeds again; the EVENT must not.
    await setConsent({ decision: 'pending', expiresAtSql: null });
    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId)))
      .toBe('created');

    const after = await readAnalytics('import_offer_created');
    expect(after).toHaveLength(1);
    expect(after[0]!.event_key).toBe(first[0]!.event_key);
  });

  it('import_decision_recorded uses a business-scoped event key so a replayed decision mints once', async () => {
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');
    const first = await readAnalytics('import_decision_recorded');
    expect(first).toHaveLength(1);
    expect(first[0]!.event_key).toContain(businessId);

    // The replay: the row is put back to `pending` and answered again. Nothing
    // in production does this, which is the point — the key, not the caller, is
    // what makes the count right.
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearOutbox();
    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');

    const after = await readAnalytics('import_decision_recorded');
    expect(after).toHaveLength(1);
    expect(after[0]!.event_key).toBe(first[0]!.event_key);
  });
});
