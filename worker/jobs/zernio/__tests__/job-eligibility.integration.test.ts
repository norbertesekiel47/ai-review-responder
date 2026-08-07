// worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts
//
// T0 EVAL suite for #679 — the ONE title that cannot be expressed against a
// mocked `sql` tag, authored FAILING before any implementation.
//
// THE DEFECT (round-1 blocking finding). Without serialization this interleaving
// loses an accepted Review import permanently:
//
//   1. The guard reads `pending` from an in-flight hand-inserted
//      zernio_initial_backfill row.
//   2. The owner accepts. `recordImportDecisionAndEnqueue` locks the businesses
//      row, writes `accepted`, and calls `enqueueInitialImport` — whose
//      `NOT EXISTS (… status IN ('pending','dispatching','dispatched'))`
//      (import-consent.ts:467-472) sees the guard's row still in flight and
//      inserts NO replacement.
//   3. The guard completes the old row as a consent skip.
//
// Final state: `import_decision = 'accepted'`, no completed initial run, and NO
// runnable outbox row — spec §5.1's accepted-but-incomplete retryability
// violated by silent permanent data loss, for a customer who said yes. Nothing
// retries it; the banner polls `importing` forever (the A4 class #677 fixed).
//
// A lock interaction is not something a mock can model: the mock returns what it
// was told and has no visibility into another session's uncommitted rows. So
// this suite forces the interleaving against real Postgres and asserts the
// invariant directly — NEVER accepted consent with zero runnable
// zernio_initial_backfill rows.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema via
// assertSchemaReady, and NEVER applies migration SQL.

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
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { recordImportDecisionAndEnqueue } from '@/lib/reviews/import-consent';
import type { WorkerLogger } from '@/lib/shared/logger';
import * as jobEligibility from '../job-eligibility';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

/** T3's return type. Declared locally so this file typechecks BEFORE T3. */
type ImportConsentGate = { kind: 'proceed' } | { kind: 'skipped' };

type GuardImportConsent = (
  sql: postgresType.Sql,
  input: {
    businessId: string;
    outboxId: string;
    attempt: number | undefined;
    logger: WorkerLogger;
  },
) => Promise<ImportConsentGate>;

// T3 adds `guardImportConsent` to job-eligibility.ts. Reached through a widened
// namespace view so this file typechecks both before and after that lands, while
// FAILING at run time today.
const { guardImportConsent } = jobEligibility as unknown as {
  guardImportConsent: GuardImportConsent;
};

/** Silent stand-in — the block line's shape is pinned by the unit suite. */
const silentLogger: WorkerLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('job-eligibility integration database was not initialized');
  return db;
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

describeWithDb('import consent guard against live Postgres', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    // max:4, not max:1 — this whole suite is one race. A single-connection pool
    // serializes the two callers inside the CLIENT, the interleaving can never
    // occur, and a green run proves nothing.
    db = postgres(testDatabaseUrl!, { max: 4, prepare: false });
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
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
      await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('an acceptance racing a pending-job consent skip leaves one runnable zernio_initial_backfill job', async () => {
    // Part 1 — the two orderings, forced. Both are legal resolutions and both
    // must end with the import still runnable; running them explicitly means
    // the suite does not depend on the scheduler happening to produce each.
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

    // Part 2 — genuinely concurrent, on separate sessions. Whichever way the
    // two transactions interleave, the businesses row lock serializes them into
    // one of the two resolutions above. THE INVARIANT: accepted consent never
    // ends with zero runnable zernio_initial_backfill rows. An unserialized
    // guard fails here by completing the row it read as pending AFTER the
    // acceptance already decided not to replace it.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await resetToLivePendingOffer();
      const handRowId = randomUUID();
      await insertHandRow(handRowId);

      const [gate, outcome] = await Promise.all([
        guardImportConsent(sql(), {
          businessId,
          outboxId: handRowId,
          attempt: undefined,
          logger: silentLogger,
        }),
        recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
      ]);

      expect(outcome, `attempt ${attempt}`).toBe('recorded');
      expect(await importDecision(), `attempt ${attempt}`).toBe('accepted');

      const runnable = await runnableImportRows();
      expect(
        runnable,
        `attempt ${attempt}: accepted consent left ${runnable.length} runnable import rows ` +
          `(gate=${gate.kind}) — the accepted import is unrecoverable`,
      ).toHaveLength(1);

      if (gate.kind === 'skipped') {
        expect(await outboxStatus(handRowId), `attempt ${attempt}`).toBe('completed');
        expect(runnable[0]!.id, `attempt ${attempt}`).not.toBe(handRowId);
      } else {
        expect(runnable[0]!.id, `attempt ${attempt}`).toBe(handRowId);
      }
    }
  });
});
