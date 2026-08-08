// src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts
//
// NAMED FOR THE **Import offer**, not for Import consent — originally to dodge
// a harness bug, now simply because it is the accurate name. HISTORICAL: at
// #679 `scripts/verify-gate.sh` derived each integration row's name AND its
// coverage directory from `tr -c 'a-zA-Z0-9' '-' | cut -c1-40`, and the obvious
// name `import-consent-analytics.integration.test.ts` truncated to exactly the
// same 40 characters as `import-consent.integration.test.ts`. The two rows then
// shared a status file and a coverage directory, which surfaced as one spurious
// FAIL and could just as easily have surfaced as a PASS reported for a suite
// that failed. **Fixed at #696 (PR #701)**: `row_slug` in `scripts/gate-rows.sh`
// appends a hash of the full path, so the 40-character prefix is no longer an
// identifier and this file's name carries no constraint.
//
// #679 T2 — the two Import offer analytics events (`import_offer_created`,
// `import_decision_recorded`), deferred out of #677 (deviations D7) because
// they need the `analytics_events.event_name` CHECK extended, which needed a
// migration that ticket's non-goals forbade.
//
// WHY ITS OWN FILE (review round 1, Medium). The first eight titles are a
// distinct feature slice appended to `import-consent.integration.test.ts`, which
// they pushed from 790 to 1039 lines. The branch had already set the precedent by
// opening a separate file for the migration-102 shape slice. Splitting also
// shrinks the blast radius of the two failure injections below, the only tests in
// the feature area that deliberately make a statement fail. Every moved title
// moved VERBATIM — the `promised-tests` gate greps them wherever they live.
//
// Three titles below are NOT among the moved eight. Two arrived in review round 2
// and pin the `emitConsentEvent` savepoint's own property — a FAILING emission
// rolls back only itself — which the moved eight did not cover: deleting the
// savepoint outright left all of them green, so a revert of the connect-outage
// fix was invisible to CI. The third arrived in review round 3 and pins the
// BOUND on that swallow: round 2 narrowed the catch to errors carrying a string
// `code`, and then tested the narrowing with two `23514`s — which carry one, and
// are therefore swallowed with or without the narrowing. Deleting the rethrow
// left all ten green. See `codelessPoison`.
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
    name: string;
    import_decision: string;
    import_decision_at: Date | null;
    import_offer_expires_at: Date | null;
  }[]>`
    SELECT name, import_decision, import_decision_at, import_offer_expires_at
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

// ── The failed-emission injection ───────────────────────────────────────────

/** `analytics_events_event_name_check`, the constraint migration 102 rewrites. */
const CHECK_VIOLATION = '23514';
const EVENT_NAME_CONSTRAINT = 'analytics_events_event_name_check';

/**
 * An event name the live CHECK does NOT admit.
 *
 * This is the FAITHFUL injection for `emitConsentEvent`: the production hazard is
 * emitting code that reached a database whose `analytics_events_event_name_check`
 * does not admit the name because migration 102 has not landed, which raises
 * `23514` at statement time inside the caller's transaction. Same table, same
 * constraint, same SQLSTATE — reproduced by offering the constraint a name it
 * rejects rather than by narrowing the constraint, because narrowing it is DDL on
 * the most contended analytics relation in the live-DB set (the round-1 High this
 * suite already paid for; see `abortingExecutor`).
 *
 * It is also why the `23503` foreign-key injection above could not be reused
 * here: `enqueueAnalyticsEvent` derives `business_id` and `account_id` from the
 * SAME ids that gate the consent write, so an id that fails the FK also fails the
 * write and nothing is ever emitted to break.
 */
const UNREGISTERED_EVENT_NAME = 'import_consent_emission_poison';

/** True for `enqueueAnalyticsEvent`'s INSERT, false for every other statement. */
function isAnalyticsEmission(first: unknown): boolean {
  const raw: unknown = (first as { raw?: unknown } | undefined)?.raw;
  if (!Array.isArray(raw)) return false;
  const fragments: unknown[] = raw;
  return fragments
    .filter((fragment): fragment is string => typeof fragment === 'string')
    .join('')
    .includes('INSERT INTO analytics_events');
}

/**
 * How the emission is made to fail, injected at the point `enqueueAnalyticsEvent`
 * writes. Two implementations, and the DIFFERENCE BETWEEN THEM is the property
 * `emitConsentEvent`'s catch is narrowed on: whether the error carries a string
 * `code`.
 */
type EmissionPoison = (handle: postgresType.TransactionSql) => Promise<void>;

/**
 * The default: a REAL Postgres `23514`, i.e. the schema-drift class the catch is
 * SUPPOSED to swallow. See `UNREGISTERED_EVENT_NAME` for why this name and this
 * constraint.
 */
const checkViolationPoison: EmissionPoison = async (handle) => {
  await handle`
    INSERT INTO analytics_events (id, event_key, event_name, distinct_id)
    VALUES (
      ${randomUUID()}::uuid,
      ${`emission-poison-${randomUUID()}`},
      ${UNREGISTERED_EVENT_NAME},
      'emission-poison'
    )
  `;
};

/** The message the real class-2 wiring bug produces, asserted verbatim below. */
const CODELESS_EMISSION_MESSAGE = 'tx.savepoint is not a function';

/**
 * The other side of the narrowing: an error with NO `code`, which the catch must
 * RETHROW rather than swallow.
 *
 * WHY THIS EXISTS AT ALL (review round 3). Round 2 bounded the catch —
 * `if (errorStringProperty(error, 'code') === undefined) throw error;` — and then
 * pinned it with two `23514` injections. A `23514` carries a string `code`, so it
 * is swallowed whether or not the bound is there; deleting that line left the
 * whole suite green. An untested guard on the highest-risk path is exactly the
 * defect this branch keeps producing, so the code-less half needs its own
 * injection.
 *
 * A `TypeError` carrying the real wiring bug's message, because that is the
 * documented class-2 hazard `import-consent.ts` names: a handle without
 * `.savepoint` (root `sql`, `sql.reserve()`, a `Sql`-shaped mock) is not schema
 * drift, and swallowing it kills both events forever behind a warn that reads
 * like a missing migration. Round 2 found it had ALREADY happened —
 * `import-offer-junction.test.ts`'s `mockTx` had no `savepoint`.
 *
 * FABRICATED IN JS, DELIBERATELY, and that inverts this file's other doctrine
 * rather than breaking it. The `23514`/`23503` injections must originate in
 * Postgres because they assert the caller SURVIVES an aborted transaction, and a
 * JS throw leaves the transaction perfectly healthy — it would prove nothing.
 * Here the assertion is the opposite one: the caller must DIE. A JS throw is the
 * whole hazard, and the rollback it produces can only have come from the rethrow,
 * because the savepoint's own `ROLLBACK TO SAVEPOINT` left Postgres with a usable
 * transaction. Injecting it here rather than by hiding `savepoint` keeps the
 * throw INSIDE the savepoint, so that ordering is what the test actually
 * exercises.
 */
const codelessPoison: EmissionPoison = () =>
  Promise.reject(new TypeError(CODELESS_EMISSION_MESSAGE));

/**
 * A `TransactionSql` on which the analytics emission — and ONLY the analytics
 * emission — fails, at the exact point `enqueueAnalyticsEvent` writes. By default
 * it fails with a REAL Postgres error raised on the caller's own connection;
 * `poison` swaps in the code-less variant.
 *
 * WHY IT SNIFFS THE STATEMENT RATHER THAN HOOKING `savepoint`. The mutation this
 * exists to kill is deleting the savepoint, and an injection that fires only
 * inside `tx.savepoint` cannot see that deletion — with the savepoint gone the
 * hook is never reached, the emission succeeds, and the test proves only that a
 * method was called. Keying on the statement makes the injection fire on BOTH
 * shapes, so what the test observes is the actual difference between them: with
 * the savepoint the parent transaction survives, without it Postgres has aborted
 * it and everything downstream dies.
 *
 * THE FAILURE ORIGINATES IN POSTGRES, never in JS — a plain JS throw does not
 * poison a transaction, so a test built on one passes with or without the guard
 * (deviations D26 records this being demonstrated by hand). The injected
 * statement is an INSERT whose `event_name` the live CHECK rejects; the test
 * asserts that rejection directly as a precondition, so an injection that
 * silently stopped firing cannot masquerade as a savepoint that worked.
 *
 * The savepoint handle is wrapped EXPLICITLY: postgres.js mints it from a fresh
 * `Sql` inside `scope()` (`src/index.js:251-256`), so it does not inherit this
 * proxy, and without the wrap the shipped path escapes the injection entirely.
 * Non-DDL, no lock stronger than the caller already holds, and the poison row
 * never commits on any path.
 */
function failingEmission(
  base: postgresType.TransactionSql,
  poison: EmissionPoison = checkViolationPoison,
): postgresType.TransactionSql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'savepoint') {
        return (callback: (sp: postgresType.TransactionSql) => Promise<unknown>) =>
          target.savepoint((sp) => callback(failingEmission(sp, poison)));
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    // Every other statement forwards untouched, and forwards the postgres.js
    // `Query` object itself rather than a wrapper — callers destructure its rows.
    apply(target: postgresType.TransactionSql, _thisArg: unknown, args: unknown[]) {
      const forwarded = (target as unknown as (...call: unknown[]) => unknown)(...args);
      if (!isAnalyticsEmission(args[0])) return forwarded;
      return (async () => {
        // The real emission runs FIRST, so the poison lands where a `23514` from
        // the event name itself would have: after the row is written, inside
        // whatever scope wrote it.
        await forwarded;
        await poison(target);
      })();
    },
  });
}

/** `failingEmission`, reached through the `sql.begin` that owns the decision. */
function failingEmissionExecutor(
  base: postgresType.Sql,
  poison: EmissionPoison = checkViolationPoison,
): postgresType.Sql {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'begin') {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback: (tx: postgresType.TransactionSql) => Promise<unknown>) =>
        target.begin((tx) => callback(failingEmission(tx, poison)));
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

  // ── The other direction: a FAILING emission must not take the caller with it ──
  //
  // The abort test above pins the arrow that points from the caller INTO the
  // event. These two pin the arrow that must NOT exist — from a failed event back
  // onto the caller — which is the `emitConsentEvent` savepoint's entire reason to
  // exist. Unguarded, `createImportOffer`'s emission raises `23514` inside
  // `finalizeConnectionTx` and no owner with an activated subscription can connect
  // a Google Business Profile at all (deviations D26). The savepoint is
  // one-directional by construction, so both directions need their own title.

  it('createImportOffer keeps the caller transaction usable when the emission fails', async () => {
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await clearAnalytics();

    // PRECONDITION, not decoration: the injected statement is rejected BY
    // POSTGRES, on the real constraint, with the SQLSTATE an unmigrated database
    // raises. Everything below asserts an ABSENCE, and an injection that quietly
    // stopped firing produces the same absences as a savepoint that worked.
    await expect(
      sql()`
        INSERT INTO analytics_events (id, event_key, event_name, distinct_id)
        VALUES (
          ${randomUUID()}::uuid,
          ${`emission-poison-precondition-${randomUUID()}`},
          ${UNREGISTERED_EVENT_NAME},
          'emission-poison-precondition'
        )
      `,
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint_name: EVENT_NAME_CONSTRAINT,
    });

    const postEmissionName = `Import Analytics Location ${randomUUID()}`;
    const result = await sql().begin(async (tx) => {
      const outcome = await createImportOffer(failingEmission(tx), businessId, tenant!.accountId);
      // A statement issued AFTER the failed emission, on the caller's OWN handle
      // — this is `finalizeConnectionTx` carrying on past the offer. Postgres
      // rejects it with 25P02 in an aborted transaction, so reaching the commit
      // at all is the property.
      await tx`
        UPDATE businesses SET name = ${postEmissionName} WHERE id = ${businessId}::uuid
      `;
      return outcome;
    });

    // The emission failed and the caller never learned about it.
    expect(result).toBe('created');

    const row = await readRaw();
    // The caller's own write, issued BEFORE the failed emission, committed …
    expect(row.import_offer_expires_at).not.toBeNull();
    // … and so did the one issued after it.
    expect(row.name).toBe(postEmissionName);
    // Only the metric was lost — the savepoint rolled back the emission alone.
    expect(await readAnalytics('import_offer_created')).toHaveLength(0);
  });

  it('recordImportDecisionAndEnqueue commits the decision and still enqueues when the emission fails', async () => {
    // The same property one layer deeper, and the statement after the failed
    // emission is PRODUCTION code rather than the test's: `enqueueInitialImport`
    // runs after `emitConsentEvent`, so an aborted transaction loses the owner's
    // answer AND never starts the Review import.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(
      await recordImportDecisionAndEnqueue(
        failingEmissionExecutor(sql()), businessId, tenant!.accountId, 'accepted',
      ),
    ).toBe('recorded');

    // The owner's answer survived the metric that failed while reporting it …
    expect((await readRaw()).import_decision).toBe('accepted');
    // … and the enqueue downstream of the emission still ran.
    expect(await outboxCount()).toBe(1);
    expect(await readAnalytics('import_decision_recorded')).toHaveLength(0);
  });

  it('recordImportDecisionAndEnqueue rethrows a code-less emission failure instead of swallowing it as schema drift', async () => {
    // THE BOUND ON THE SWALLOW, which the two titles above structurally cannot
    // reach (review round 3). They inject a `23514`; a `23514` carries a string
    // `code`, so `emitConsentEvent`'s
    // `if (errorStringProperty(error, 'code') === undefined) throw error;` is
    // dead weight for them and deleting it leaves them green. Only an error
    // WITHOUT a code can tell the guarded catch from an unbounded one.
    //
    // The distinction is not academic. A code-less error here means a wiring bug
    // — a handle that is not a `TransactionSql` at all — and an unbounded catch
    // converts it into a permanent, silent loss of BOTH events behind a warn
    // line that reads like a missing migration. Round 2 found that exact state
    // already shipped in `import-offer-junction.test.ts`'s `mockTx`.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    // `.then(reject, identity)` rather than `expect(...).rejects`, because the
    // load-bearing assertion is an ABSENCE on the thrown value — `rejects` can
    // match a shape but cannot show that `code` is missing, and missing `code` is
    // the entire discriminator under test.
    const thrown: unknown = await recordImportDecisionAndEnqueue(
      failingEmissionExecutor(sql(), codelessPoison), businessId, tenant!.accountId, 'accepted',
    ).then(
      (outcome) => { throw new Error(`expected a rejection, got outcome '${outcome}'`); },
      (error: unknown) => error,
    );

    // The injected error reached the caller UNCHANGED, and it is the code-less
    // shape — not something Postgres minted on the way out.
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty('message', CODELESS_EMISSION_MESSAGE);
    expect(thrown).not.toHaveProperty('code');

    // And the rethrow took the whole transaction with it: the owner's answer did
    // not land, and the Review import was never enqueued. This is the assertion
    // that inverts the two titles above — there the caller COMMITS, here it must
    // not — so the pair cannot both pass under one behaviour.
    expect((await readRaw()).import_decision).toBe('pending');
    expect((await readRaw()).import_decision_at).toBeNull();
    expect(await outboxCount()).toBe(0);
    expect(await readAnalytics('import_decision_recorded')).toHaveLength(0);
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
