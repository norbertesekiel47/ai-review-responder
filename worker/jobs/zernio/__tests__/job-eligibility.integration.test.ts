// worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts
//
// T0 EVAL suite for #679 — the ONE title that cannot be expressed against a
// mocked `sql` tag.
//
// THE DEFECT (round-1 blocking finding). Without serialization this interleaving
// loses an accepted Review import permanently:
//
//   1. The guard reads `pending` from an in-flight hand-inserted
//      zernio_initial_backfill row.
//   2. The owner accepts. `recordImportDecisionAndEnqueue` locks the businesses
//      row, writes `accepted`, and calls `enqueueInitialImport` — whose
//      `NOT EXISTS (… status IN ('pending','dispatching','dispatched'))`
//      sees the guard's row still in flight and inserts NO replacement.
//   3. The guard completes the old row as a consent skip.
//
// Final state: `import_decision = 'accepted'`, no completed initial run, and NO
// runnable outbox row — spec §5.1's accepted-but-incomplete retryability
// violated by silent permanent data loss, for a customer who said yes. Nothing
// retries it; the banner polls `importing` forever (the A4 class #677 fixed).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE DOES NOT USE `Promise.all` (T6 repair, 2026-08-07)
//
// The first cut raced the guard against the acceptance with `Promise.all` over a
// pooled client and looped it ten times. That removes CLIENT-side serialization
// but not statement-level interleaving: on single-node Postgres one side
// consistently reaches its colliding statement after the other has finished, so
// the losing order never occurred. T3 proved it by mutation — stripping the
// transaction out of `guardImportConsent` turned the unit suite red on its
// `inTransaction` assertion while THIS suite stayed green. A test that cannot
// fail is worse than none, because the next engineer will trust it.
//
// The interleaving is now FORCED rather than hoped for, using real lock
// contention on three separate sessions (three `postgres` clients, each `max: 1`
// and each with its own `application_name` so `pg_blocking_pids` can name who is
// waiting on whom):
//
//   blocker  BEGIN; SELECT … FOR UPDATE on the hand-inserted job_outbox row.
//            Held. This is the pause point BETWEEN the guard's consent read and
//            its `markOutboxCompleted` — the window the bug lives in, and a
//            window no production code exposes.
//   guard    guardImportConsent(). Under EITHER implementation it stalls on the
//            blocker's row lock at `markOutboxCompleted`. The difference is what
//            it holds while stalled: the correct one holds the `businesses` row
//            lock it took with `SELECT … FOR UPDATE` inside `sql.begin`; an
//            unserialized one holds nothing.
//   accept   recordImportDecisionAndEnqueue(). Its first statement is
//            `SELECT … FOR UPDATE` on that same `businesses` row.
//
// So the guard's own lock is the ONLY thing that can stop the acceptance, and
// the two outcomes are fully determined:
//
//   correct     → accept blocks ON the guard's session; blocker releases; the
//                 guard completes the hand row and commits; accept then commits
//                 `accepted` and its NOT EXISTS — now seeing a COMPLETED row —
//                 inserts a fresh runnable one.  1 runnable row.
//   unserialized→ accept is never blocked, commits `accepted` while the hand row
//                 is still `dispatched`, inserts nothing; blocker releases; the
//                 guard completes the hand row.  0 runnable rows: the accepted
//                 import is unrecoverable.
//
// MUTATION-TESTED, both directions (T6, 2026-08-07). Removing `FOR UPDATE` from
// `guardImportConsent`'s read, and separately splitting its `sql.begin` into two
// autocommit statements, each turn this test RED — on the runnable-row invariant
// first (the real defect) and on the blocked-by-the-guard tripwire second. The
// implementation file was reverted afterwards and is unmodified.
//
// A lock interaction is not something a mock can model: the mock returns what it
// was told and has no visibility into another session's uncommitted rows.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema via
// assertSchemaReady, and NEVER applies migration SQL.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { recordImportDecisionAndEnqueue } from '@/lib/reviews/import-consent';
import type { WorkerLogger } from '@/lib/shared/logger';
import { guardImportConsent, type ImportConsentGate } from '../job-eligibility';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// A real named import, deliberately — see the note in job-eligibility.test.ts.
// The eval-commit namespace cast (deviations D11) was removed once T3 landed so
// this suite is type-coupled to the shipped signature rather than to a local
// restatement of it.

/** Silent stand-in — the block line's shape is pinned by the unit suite. */
const silentLogger: WorkerLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// Every session in the forced interleaving is labelled, because the assertion
// that matters is not "something is blocked" but "the ACCEPTANCE is blocked BY
// THE GUARD" — and `pg_blocking_pids` can only name that if the sessions are
// distinguishable. Distinct clients (never one pool) so the client cannot
// serialize them for us and hand back a green run that proves nothing.
const APP_BLOCKER = 'repworth-679-blocker';
const APP_GUARD = 'repworth-679-guard';
const APP_ACCEPT = 'repworth-679-accept';

let db: postgresType.Sql | undefined;
let blockerDb: postgresType.Sql | undefined;
let guardDb: postgresType.Sql | undefined;
let acceptDb: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('job-eligibility integration database was not initialized');
  return db;
}

/** One connection, one identity. `max: 1` makes "the session" unambiguous. */
function connectAs(applicationName: string): postgresType.Sql {
  return postgres(testDatabaseUrl!, {
    max: 1,
    prepare: false,
    connection: { application_name: applicationName },
  });
}

/** A live Import offer on a `pending` row — the state a hand-insert races. */
async function resetToLivePendingOffer(): Promise<void> {
  await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
  await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
  await sql()`
    UPDATE businesses
    SET import_decision = 'pending',
        import_decision_at = NULL,
        import_offer_expires_at = now() + interval '3 days'
    WHERE id = ${businessId}::uuid
  `;
}

/**
 * The hole this ticket closes: a zernio_initial_backfill row that no consent
 * gate ever produced. `dispatched` is the status a worker actually runs under,
 * and it is one of the three in-flight statuses `enqueueInitialImport`'s
 * NOT EXISTS treats as "an import is already queued".
 */
async function insertHandRow(outboxId: string): Promise<void> {
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status, dispatched_at
    ) VALUES (
      ${outboxId}::uuid, 'zernio_initial_backfill', 'business',
      ${businessId}::uuid, ${sql().json({ business_id: businessId })}, 'dispatched', now()
    )
  `;
}

async function importDecision(): Promise<string> {
  const [row] = await sql()<{ import_decision: string }[]>`
    SELECT import_decision FROM businesses WHERE id = ${businessId}::uuid
  `;
  return row!.import_decision;
}

/**
 * Rows a worker can still pick up. The invariant is stated over THIS set, not
 * over "an outbox row exists": a completed row is exactly what the lost-import
 * bug leaves behind, and it looks like a row until you read its status.
 */
async function runnableImportRows(): Promise<{ id: string; status: string }[]> {
  return sql()<{ id: string; status: string }[]>`
    SELECT id, status FROM job_outbox
    WHERE aggregate_id = ${businessId}::uuid
      AND topic = 'zernio_initial_backfill'
      AND status IN ('pending', 'dispatching', 'dispatched')
    ORDER BY id
  `;
}

async function outboxStatus(outboxId: string): Promise<string | null> {
  const [row] = await sql()<{ status: string }[]>`
    SELECT status FROM job_outbox WHERE id = ${outboxId}::uuid
  `;
  return row?.status ?? null;
}

// ── Forcing machinery ───────────────────────────────────────────────────────

/**
 * True when a session running under `blockedApp` is waiting on a lock that a
 * session running under `blockerApp` holds.
 *
 * Observed from the SUITE's own connection, so it reports on the two live
 * sessions without touching either. `pg_blocking_pids` rather than a bare
 * `wait_event_type = 'Lock'` count because the whole question is WHO is holding
 * the thing — "somebody is blocked" would still be true if the acceptance were
 * stuck behind the blocker's outbox lock instead of the guard's businesses lock,
 * and that is a different (passing) story.
 */
async function blockedBy(blockedApp: string, blockerApp: string): Promise<boolean> {
  const [row] = await sql()<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM pg_stat_activity blocked
    JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocking(pid) ON true
    JOIN pg_stat_activity blocker ON blocker.pid = blocking.pid
    WHERE blocked.application_name = ${blockedApp}
      AND blocker.application_name = ${blockerApp}
  `;
  return (row?.n ?? 0) > 0;
}

async function waitUntil(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await delay(20);
  }
}

interface Tracked<T> {
  promise: Promise<T>;
  /** Whether the underlying work has resolved OR rejected. Never blocks. */
  settled: () => boolean;
}

/**
 * Wraps in-flight work so the test can ask "has this finished yet?" without
 * awaiting it. That question IS the tripwire: under a correctly serialized guard
 * the acceptance cannot have finished, and under an unserialized one it already
 * has.
 */
function track<T>(work: Promise<T>): Tracked<T> {
  let done = false;
  const promise = work.then(
    (value) => {
      done = true;
      return value;
    },
    (err: unknown) => {
      done = true;
      throw err;
    },
  );
  // The poll loops below deliberately do not await this promise, so a rejection
  // would otherwise surface as an unhandledRejection and kill the worker before
  // the assertion that explains it can run.
  void promise.catch(() => undefined);
  return { promise, settled: () => done };
}

interface HeldLock {
  release: () => void;
  done: Promise<void>;
}

/**
 * Open a transaction that takes `SELECT … FOR UPDATE` on one job_outbox row and
 * HOLDS it until released — the pause point between the guard's consent read and
 * its `markOutboxCompleted`.
 *
 * A row lock, not an advisory one, because the guard must block on the exact
 * statement the bug hinges on. This session never touches `businesses`, so it
 * can never participate in a lock cycle with the other two.
 */
async function holdOutboxRowLock(outboxId: string): Promise<HeldLock> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  const isAcquired = new Promise<void>((resolve) => {
    acquired = resolve;
  });

  const done = blockerDb!.begin(async (tx) => {
    await tx`SELECT id FROM job_outbox WHERE id = ${outboxId}::uuid FOR UPDATE`;
    acquired();
    await released;
  }).then(() => undefined);
  void done.catch(() => undefined);

  // A failure inside the transaction must surface here rather than hang the
  // suite on a lock that was never taken.
  await Promise.race([
    isAcquired,
    done.then(() =>
      Promise.reject(new Error('blocker transaction ended before it acquired the outbox row lock')),
    ),
  ]);

  return { release, done };
}

describeWithDb('import consent guard against live Postgres', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 4, prepare: false });
    blockerDb = connectAs(APP_BLOCKER);
    guardDb = connectAs(APP_GUARD);
    acceptDb = connectAs(APP_ACCEPT);
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    tenant = await seedTenantAccount(db, {
      userName: 'Consent Guard Owner',
      accountDisplayName: 'Consent Guard Account',
    });
    await sql()`
      UPDATE accounts SET subscription_activated_at = now()
      WHERE id = ${tenant.accountId}::uuid
    `;
    await sql()`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Consent Guard Location', 'Consent Guard Owner',
              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await sql()`
      INSERT INTO zernio_connections (
        id, business_id, zernio_profile_id, zernio_account_id,
        zernio_location_id, status, connected_at
      ) VALUES (
        ${randomUUID()}::uuid, ${businessId}::uuid, 'prof-consent-guard',
        'acct-consent-guard', 'loc-consent-guard', 'active', now()
      )
    `;
  });

  beforeEach(async () => {
    await resetToLivePendingOffer();
  });

  afterAll(async () => {
    if (db && tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
      await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    // Every client, whatever happened above — a leaked session holding a row
    // lock wedges every sibling live-DB suite, not just this one.
    await Promise.all(
      [db, blockerDb, guardDb, acceptDb].map((client) => client?.end({ timeout: 5 })),
    );
  });

  it('an acceptance racing a pending-job consent skip leaves one runnable zernio_initial_backfill job', async () => {
    // ── Part 1 — the two orderings, run sequentially ─────────────────────────
    // Both are legal resolutions of the race and both must end with the import
    // still runnable. Running them explicitly means the suite does not depend on
    // the scheduler happening to produce each.
    //
    //   guard-first : guard reads `pending`, completes the hand row, commits →
    //                 acceptance's NOT EXISTS sees nothing in flight and inserts
    //                 a fresh runnable row.
    //   accept-first: acceptance commits `accepted` and inserts nothing (the
    //                 hand row is still in flight) → guard reads `accepted` and
    //                 PROCEEDS, leaving that row runnable for the worker.
    for (const order of ['guard-first', 'accept-first'] as const) {
      await resetToLivePendingOffer();
      const handRowId = randomUUID();
      await insertHandRow(handRowId);

      let gate: ImportConsentGate;
      if (order === 'guard-first') {
        gate = await guardImportConsent(sql(), {
          businessId,
          outboxId: handRowId,
          attempt: undefined,
          logger: silentLogger,
        });
        expect(
          await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
        ).toBe('recorded');
      } else {
        expect(
          await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
        ).toBe('recorded');
        gate = await guardImportConsent(sql(), {
          businessId,
          outboxId: handRowId,
          attempt: undefined,
          logger: silentLogger,
        });
      }

      expect(await importDecision(), `${order}: acceptance did not commit`).toBe('accepted');
      const runnable = await runnableImportRows();
      expect(runnable, `${order}: accepted consent with no runnable import`).toHaveLength(1);

      if (gate.kind === 'skipped') {
        // The guard refused the row it read as pending — so it must have
        // completed it, and the runnable row must be the acceptance's fresh one.
        expect(await outboxStatus(handRowId)).toBe('completed');
        expect(runnable[0]!.id).not.toBe(handRowId);
      } else {
        // The guard read `accepted` and proceeded — the hand row is the import.
        expect(runnable[0]!.id).toBe(handRowId);
      }
    }

    // ── Part 2 — the losing interleaving, FORCED ─────────────────────────────
    // Part 1 proves both resolutions are safe once they are ordered. It cannot
    // prove they are the only two reachable, because it never lets the guard's
    // read and its write straddle the acceptance. This does — see the file
    // header for why `Promise.all` could not.
    await resetToLivePendingOffer();
    const handRowId = randomUUID();
    await insertHandRow(handRowId);

    const blocker = await holdOutboxRowLock(handRowId);
    let accept: Tracked<Awaited<ReturnType<typeof recordImportDecisionAndEnqueue>>> | undefined;
    let guard: Tracked<ImportConsentGate> | undefined;

    try {
      // 1. The guard runs. It reads consent — `pending` — and then stalls inside
      //    `markOutboxCompleted` on the blocker's row lock. Both implementations
      //    stall identically here; the difference is invisible until step 3.
      guard = track(
        guardImportConsent(guardDb!, {
          businessId,
          outboxId: handRowId,
          attempt: undefined,
          logger: silentLogger,
        }),
      );
      await waitUntil(
        'the guard to stall on the held zernio_initial_backfill outbox row',
        () => blockedBy(APP_GUARD, APP_BLOCKER),
      );

      // Nothing of the guard's has landed yet: it is parked precisely between
      // its consent read and its completion write, which is the window the
      // acceptance has to arrive in for the import to be lost.
      expect(await outboxStatus(handRowId)).toBe('dispatched');
      expect(await importDecision()).toBe('pending');

      // 2. The owner accepts, on a third session, while the guard is parked.
      accept = track(
        recordImportDecisionAndEnqueue(acceptDb!, businessId, tenant!.accountId, 'accepted'),
      );

      // Settle the ordering deterministically instead of sleeping: the
      // acceptance either commits (nothing held it back) or comes to rest behind
      // the guard's `businesses` row lock. Exactly one of those is true, and
      // waiting on the disjunction means neither implementation can time out.
      await waitUntil(
        'the acceptance to either block on the guard or commit outright',
        async () => accept!.settled() || (await blockedBy(APP_ACCEPT, APP_GUARD)),
      );
      const acceptanceWasBlockedByTheGuard = !accept.settled();

      // 3. Release the pause point and let both finish.
      blocker.release();
      await blocker.done;

      const gate = await guard.promise;
      expect(await accept.promise).toBe('recorded');
      expect(await importDecision()).toBe('accepted');

      // THE INVARIANT, and the assertion that dies when the guard stops being
      // one transaction: accepted consent NEVER ends with zero runnable
      // zernio_initial_backfill rows. An unserialized guard lands here with 0 —
      // the acceptance already decided not to replace a row the guard then
      // completed, and nothing else will ever queue that customer's import.
      const runnable = await runnableImportRows();
      expect(
        runnable,
        `accepted consent left ${runnable.length} runnable import rows (gate=${gate.kind}) — ` +
          'the accepted import is unrecoverable',
      ).toHaveLength(1);

      // The guard read `pending` (step 1 asserted it), so it must have skipped
      // and completed the hand row, and the survivor must be the acceptance's
      // fresh replacement — not the row the guard just retired.
      expect(gate.kind).toBe('skipped');
      expect(await outboxStatus(handRowId)).toBe('completed');
      expect(runnable[0]!.id).not.toBe(handRowId);
      expect(runnable[0]!.status).toBe('pending');

      // THE TRIPWIRE. The only thing that can stop the acceptance is the
      // `businesses` row lock the guard takes with `SELECT … FOR UPDATE` inside
      // `sql.begin`. Drop the `FOR UPDATE`, or split the transaction into two
      // autocommit statements, and the acceptance sails past — which is exactly
      // how the runnable-row invariant above gets violated.
      expect(
        acceptanceWasBlockedByTheGuard,
        'the acceptance was never blocked by the guard — guardImportConsent is not holding the ' +
          'businesses row lock across its consent read and its markOutboxCompleted',
      ).toBe(true);
    } finally {
      // Releasing twice is a no-op; leaving the blocker's transaction open is
      // not — it would wedge afterAll and every sibling live-DB suite.
      blocker.release();
      await blocker.done.catch(() => undefined);
      await guard?.promise.catch(() => undefined);
      await accept?.promise.catch(() => undefined);
    }
  });
});
