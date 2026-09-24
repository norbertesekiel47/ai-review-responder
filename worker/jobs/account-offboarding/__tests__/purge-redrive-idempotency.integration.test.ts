// worker/jobs/account-offboarding/__tests__/purge-redrive-idempotency.integration.test.ts
//
// HARD-GATE integration coverage for #1411: an admin "retry purge" action has
// no per-stage checkpoint to lean on — `PurgeWorker.handleAccountOffboardingPurge`
// replays EVERY stage in `purge-stages.ts` from
// `runStripeCustomerRedactionPurgeStage` (first) through
// `finalizePurgeInTransaction` on every attempt, automatic or admin-driven.
// Before this suite, no test proved that replaying an already-partially-run
// purge against real Postgres is safe.
//
// Three scenarios against a REAL Postgres database:
//
//   A. Every purge stage function, called TWICE back to back against the same
//      row (the "half-purged, replay from stage 1" case #1411 asks for),
//      completes without error and a subsequent `finalizePurgeInTransaction`
//      still reaches `purged`. Stubbed Stripe + Supabase clients assert the
//      SECOND pass makes no redundant provider call — `customers.update` and
//      `auth.admin.deleteUser` are each called exactly once across both
//      passes, proving the two stages that talk to a live provider detect an
//      already-applied change rather than re-applying it.
//   B. The admin flow end to end: a genuine terminal purge failure (a
//      simulated Stripe outage on the FIRST attempt, with nothing else
//      destroyed — the stage runs first precisely so a failure here leaves a
//      clean row) lands `status='failed'`/`failed_step='purge'`;
//      `retryAccountOffboardingPurge` resets it and enqueues a fresh purge
//      job through the outbox; the redriven attempt reaches `purged`.
//   C. Concurrency: two simultaneous `retryAccountOffboardingPurge` calls
//      against the SAME failed row — Postgres's own row lock means exactly
//      one wins (enqueues once), the other gets the `409
//      account_offboarding_purge_not_retryable` refusal.
//
// Gating: SKIPS only when TEST_DATABASE_POOL_URL is absent; otherwise a hard
// merge gate. Mirrors the env/mock setup in
// `offboarding-lifecycle.integration.test.ts` (MOCK_EXTERNAL_APIS short-
// circuits Zernio; a stub Stripe client is passed directly to the stage
// functions under test rather than through `getStripe()`, so this suite does
// NOT need to mock `src/lib/payments/stripe-client` at all).

import { it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// `PurgeWorker.handleAccountOffboardingPurge` resolves `getStripe()` at its
// own module boundary (invariant #15 — the worker resolves the client and
// passes it DOWN, `purge-stages.ts` never imports the singleton). Scenario B
// below is the only test in this file that drives the full worker rather than
// calling stage functions directly, so it is the only one that needs this
// mocked; Scenarios A and C never import `PurgeWorker`'s Stripe dependency
// path at all. A mutable holder lets Scenario B swap in a client whose FIRST
// call fails (simulating a Stripe outage) without a second mock per test.
const { stripeClientHolder } = vi.hoisted(() => ({
  stripeClientHolder: { current: null as unknown },
}));
vi.mock('../../../../src/lib/payments/stripe-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/lib/payments/stripe-client')>();
  return {
    ...actual,
    getStripe: () => stripeClientHolder.current,
  };
});

const { testDbUrl, originalEnv } = vi.hoisted(() => {
  const originalEnv = {
    DATABASE_POOL_URL: process.env.DATABASE_POOL_URL,
    ALLOW_E2E_DB_WRITES: process.env.ALLOW_E2E_DB_WRITES,
    ACCOUNT_OFFBOARDING_ENABLED: process.env.ACCOUNT_OFFBOARDING_ENABLED,
    MOCK_EXTERNAL_APIS: process.env.MOCK_EXTERNAL_APIS,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    TEST_DATABASE_POOL_URL: process.env.TEST_DATABASE_POOL_URL,
  };

  if (!process.env.TEST_DATABASE_POOL_URL) {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const raw = fs.readFileSync('.env.local', 'utf8');
      for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        const key = match?.[1];
        const rawValue = match?.[2];
        if (!key || rawValue === undefined) continue;
        if (!(key in process.env)) process.env[key] = rawValue.replace(/^["']|["']$/g, '');
      }
    } catch {
      // No .env.local — the suite skip-gates below.
    }
  }
  const testDbUrl = process.env.TEST_DATABASE_POOL_URL;
  if (testDbUrl) {
    process.env.DATABASE_POOL_URL = testDbUrl;
    process.env.ALLOW_E2E_DB_WRITES = 'true';
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    process.env.SUPABASE_URL ??= 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_KEY ??= 'integration-test-service-key';
  }
  return { testDbUrl, originalEnv };
});

import {
  finalizePurgeInTransaction,
  loadPurgeOffboarding,
  markPurgeTerminalFailure,
  runAnalyticsPurgeStage,
  runAuditAndCostPayloadPurgeStage,
  runAuthBindingPurgeStage,
  runContentPurgeStage,
  runDependentReferencePurgeStage,
  runParentTombstonePurgeStage,
  runProviderIdentifierPurgeStage,
  runRawPayloadPurgeStage,
  runStripeCustomerRedactionPurgeStage,
  validatePurgeableOffboarding,
  type AccountOffboardingPurgeRow,
} from '../purge-stages';
import { handleAccountOffboardingPurge } from '../PurgeWorker';
import {
  PurgeRetryError,
  retryAccountOffboardingPurge,
} from '../../../../src/lib/account-offboarding/retry-purge';
import type {
  StripeCustomerRedactionClient,
  StripeCustomerLike,
} from '../../../../src/lib/account-offboarding/stripe-customer-redaction';
import {
  cleanupOwnerOffboardingSeed,
  closeSeedDb,
  getE2eSql,
  seedOwnerOffboardingAccount,
  type OwnerOffboardingSeedData,
} from '../../../../e2e/seed';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';
import {
  assertSchemaReady,
  MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
  MIGRATION_093_SOLICITATION_CONSENT,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
} from '../../../../src/lib/shared/__tests__/helpers/schema-ready';

const RUN = !!testDbUrl;

/**
 * `account_audit_log.actor_user_id` is a real (`NO ACTION`) FK to `users(id)`
 * (migration 014), so `writeAccountAuditLog` inside `retryAccountOffboardingPurge`
 * needs a genuine row — a fixed placeholder UUID fails at INSERT time. Seeded
 * standalone (no account), mirroring an admin's real `account_id IS NULL`
 * (039 dropped the NOT NULL migration 034 had added).
 */
async function seedFakeAdminUser(): Promise<string> {
  const sql = getE2eSql();
  const id = randomUUID();
  await sql`
    INSERT INTO users (id, name, email, role, account_id)
    VALUES (${id}::uuid, 'Purge Redrive Test Admin', ${`purge-redrive-admin-${id}@test.local`}, 'admin', NULL)
  `;
  return id;
}

async function cleanupFakeAdminUser(adminUserId: string): Promise<void> {
  const sql = getE2eSql();
  // account_audit_log rows this admin wrote must go first — the FK is NO ACTION.
  await sql`DELETE FROM account_audit_log WHERE actor_user_id = ${adminUserId}::uuid`;
  await sql`DELETE FROM users WHERE id = ${adminUserId}::uuid`;
}

beforeAll(async () => {
  if (!RUN) return;
  const parsed = new URL(testDbUrl!);
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
  ) {
    throw new Error('purge-redrive-idempotency integration setup requires a local test database');
  }
  await assertSchemaReady(getE2eSql(), [
    MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
    MIGRATION_093_SOLICITATION_CONSENT,
    MIGRATION_096_SOLICITATION_SUPPRESSIONS,
    MIGRATION_099_SOLICITATION_POSTAL_ADDRESS,
  ]);
});

afterAll(async () => {
  if (RUN) await closeSeedDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * A stateful stand-in for `StripeCustomerRedactionClient`: `update` actually
 * applies Stripe's clear/merge semantics to an in-memory Customer, so a SECOND
 * `retrieve` sees the redacted state and `isAlreadyRedacted` can genuinely
 * short-circuit — this is what makes the "called once across two passes"
 * assertion meaningful rather than trivially true.
 */
function makeFakeStripeClient(options: { failFirstRetrieve?: boolean } = {}): {
  client: StripeCustomerRedactionClient;
  calls: { retrieve: number; update: number; list: number; detach: number };
} {
  let customer: StripeCustomerLike & Record<string, unknown> = {
    id: 'cus_fake',
    name: 'Jane Doe',
    email: 'jane@example.test',
    phone: '+15555550100',
    description: null,
    address: { line1: '123 Main St' },
    shipping: null,
    business_name: null,
    individual_name: null,
    metadata: {},
  };
  const calls = { retrieve: 0, update: 0, list: 0, detach: 0 };
  const REDACTED_FIELDS = [
    'name', 'email', 'phone', 'description', 'address', 'shipping', 'business_name', 'individual_name',
  ] as const;
  let retrieveShouldFail = options.failFirstRetrieve ?? false;

  const client: StripeCustomerRedactionClient = {
    customers: {
      retrieve: async () => {
        calls.retrieve += 1;
        if (retrieveShouldFail) {
          retrieveShouldFail = false;
          const err = new Error('simulated Stripe outage') as Error & { statusCode: number };
          err.statusCode = 500;
          throw err;
        }
        return { ...customer };
      },
      update: async (_id, params) => {
        calls.update += 1;
        for (const field of REDACTED_FIELDS) {
          if (field in params) {
            (customer as Record<string, unknown>)[field] = params[field] === '' ? null : params[field];
          }
        }
        const metadataParam = (params.metadata ?? {}) as Record<string, string>;
        const nextMetadata: Record<string, string> = { ...(customer.metadata ?? {}) };
        for (const [key, value] of Object.entries(metadataParam)) {
          if (value === '') delete nextMetadata[key];
          else nextMetadata[key] = value;
        }
        customer = { ...customer, metadata: nextMetadata };
        return { ...customer };
      },
    },
    paymentMethods: {
      list: async () => {
        calls.list += 1;
        return { data: [], has_more: false };
      },
      detach: async (id: string) => {
        calls.detach += 1;
        return { id };
      },
    },
  };
  return { client, calls };
}

function fakeSupabaseServer(): {
  supabase: { auth: { admin: { deleteUser: ReturnType<typeof vi.fn> } } };
  deleteUser: ReturnType<typeof vi.fn>;
} {
  const deleteUser = vi.fn(async () => ({ error: null }));
  return { supabase: { auth: { admin: { deleteUser } } }, deleteUser };
}

async function insertPurgeScheduledOffboarding(
  seed: OwnerOffboardingSeedData,
  overrides: { authUserId?: string | null } = {},
): Promise<string> {
  const sql = getE2eSql();
  const offboardingId = randomUUID();
  await sql`
    INSERT INTO account_offboardings (
      id, account_id, mode, status, teardown_completed_at, purge_after,
      purge_started_at, location_ids, recipient_email, auth_user_id,
      stripe_customer_id, stripe_subscription_id
    ) VALUES (
      ${offboardingId}::uuid, ${seed.accountId}::uuid, 'delete_data',
      'purge_scheduled', NOW(), NOW() + INTERVAL '1 hour',
      NOW(),
      ${[seed.businessId]}::uuid[], ${seed.ownerEmail},
      ${overrides.authUserId === undefined ? null : overrides.authUserId},
      ${seed.stripeCustomerId}, ${seed.stripeSubscriptionId}
    )
  `;
  return offboardingId;
}

async function readOffboarding(offboardingId: string): Promise<{
  status: string;
  failed_step: string | null;
  last_error: string | null;
  retry_count: number;
}> {
  const sql = getE2eSql();
  const [row] = await sql<{
    status: string;
    failed_step: string | null;
    last_error: string | null;
    retry_count: number;
  }[]>`
    SELECT status, failed_step, last_error, retry_count
    FROM account_offboardings
    WHERE id = ${offboardingId}::uuid
  `;
  return row!;
}

describeWithDb('purge redrive idempotency (#1411)', { enabled: RUN, timeout: 60_000 }, () => {
  beforeEach(() => {
    stripeClientHolder.current = null;
  });

  // ── Scenario A: every stage tolerates a full replay ───────────────────────
  it('every purge stage is a no-op-safe replay: two full passes make exactly one redaction and one auth delete, and finalize still reaches purged', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    try {
      const offboardingId = await insertPurgeScheduledOffboarding(seed, {
        authUserId: seed.authUserId,
      });
      const { client: stripeClient, calls: stripeCalls } = makeFakeStripeClient();
      const { supabase, deleteUser } = fakeSupabaseServer();

      const runAllStagesOnce = async (outboxId: string): Promise<AccountOffboardingPurgeRow> => {
        const sql = getE2eSql();
        const row = await loadPurgeOffboarding(sql, offboardingId, seed.accountId);
        expect(row).not.toBeNull();
        expect(validatePurgeableOffboarding(row!)).toBeNull();

        await runStripeCustomerRedactionPurgeStage(sql, () => stripeClient, row!);
        await runAuthBindingPurgeStage(sql, supabase as never, row!);
        await runDependentReferencePurgeStage(sql, row!);
        await runRawPayloadPurgeStage(sql, row!, outboxId);
        await runContentPurgeStage(sql, row!);
        await runAnalyticsPurgeStage(sql, row!);
        await runProviderIdentifierPurgeStage(sql, row!);
        await runAuditAndCostPayloadPurgeStage(sql, row!);
        await runParentTombstonePurgeStage(sql, row!);
        return row!;
      };

      // Pass 1: simulates the FIRST attempt, which (in production) failed
      // somewhere after every stage above but before finalize — e.g. a crash,
      // or `finalizePurgeInTransaction`'s own verification failing once and
      // then being fixed. Nothing here should throw.
      await runAllStagesOnce(randomUUID());

      // Pass 2: simulates the admin-retry replay — `retryAccountOffboardingPurge`
      // resets the row and PurgeWorker starts again from stage 1. Every stage
      // runs a SECOND time against a row that is already (mostly) purged.
      // This must not throw, and the provider-facing stages must not repeat
      // their side effect.
      const rowAfterSecondPass = await runAllStagesOnce(randomUUID());

      expect(stripeCalls.update).toBe(1);
      expect(stripeCalls.retrieve).toBe(2);
      expect(deleteUser).toHaveBeenCalledTimes(1);

      // finalize runs once, as it would on the attempt that actually succeeds.
      const outboxId = randomUUID();
      await getE2eSql()`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, dispatched_at, attempts)
        VALUES (${outboxId}::uuid, 'account_offboarding_purge', 'account_offboarding', ${offboardingId}::uuid, '{}'::jsonb, 'dispatched', NOW(), 1)
      `;
      await finalizePurgeInTransaction(getE2eSql(), rowAfterSecondPass, outboxId, 1);

      const final = await readOffboarding(offboardingId);
      expect(final.status).toBe('purged');
      expect(final.last_error).toBeNull();
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  // ── Scenario B: the admin flow end to end ─────────────────────────────────
  it('resets a terminally-failed purge, redrives it through the outbox, and reaches purged', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const adminUserId = await seedFakeAdminUser();
    try {
      const offboardingId = await insertPurgeScheduledOffboarding(seed);
      const { client: stripeClient } = makeFakeStripeClient({ failFirstRetrieve: true });
      stripeClientHolder.current = stripeClient;
      const supabase = fakeSupabaseServer().supabase;

      const sql = getE2eSql();

      // First attempt: the Stripe stage runs FIRST and fails, so nothing else
      // is touched — exactly the property #1411 relies on ("the Stripe
      // Customer redaction stage runs first"). Force it terminal (no BullMQ
      // retries left) so it lands status='failed'/failed_step='purge'.
      const firstOutboxId = randomUUID();
      await sql`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, dispatched_at, attempts)
        VALUES (
          ${firstOutboxId}::uuid, 'account_offboarding_purge', 'account_offboarding',
          ${offboardingId}::uuid,
          ${sql.json({ account_offboarding_id: offboardingId, account_id: seed.accountId } as never)},
          'dispatched', NOW(), 1
        )
      `;
      await handleAccountOffboardingPurge(sql, supabase as never, {
        id: firstOutboxId,
        data: {
          account_offboarding_id: offboardingId,
          account_id: seed.accountId,
          outbox_id: firstOutboxId,
          outbox_attempt: 1,
        },
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as Parameters<typeof handleAccountOffboardingPurge>[2]);

      const failed = await readOffboarding(offboardingId);
      expect(failed.status).toBe('failed');
      expect(failed.failed_step).toBe('purge');

      // The admin retry: reset + re-enqueue in one transaction.
      const retryResult = await retryAccountOffboardingPurge(sql, {
        offboardingId,
        adminUserId,
      });
      expect(retryResult.status).toBe('purge_scheduled');
      expect(retryResult.retryCount).toBe(failed.retry_count + 1);

      const [enqueued] = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM job_outbox WHERE id = ${retryResult.outboxId}::uuid
      `;
      expect(enqueued?.status).toBe('pending');

      const reset = await readOffboarding(offboardingId);
      expect(reset.status).toBe('purge_scheduled');
      expect(reset.failed_step).toBeNull();
      expect(reset.last_error).toBeNull();

      // Dispatch the redrive's outbox row and run the worker again — the
      // Stripe stub no longer fails, so this attempt should complete the
      // WHOLE replay (every stage a second time) and reach purged.
      await sql`
        UPDATE job_outbox SET status = 'dispatched', dispatched_at = NOW(), attempts = 1
        WHERE id = ${retryResult.outboxId}::uuid
      `;
      await handleAccountOffboardingPurge(sql, supabase as never, {
        id: retryResult.outboxId,
        data: {
          account_offboarding_id: offboardingId,
          account_id: seed.accountId,
          outbox_id: retryResult.outboxId,
          outbox_attempt: 1,
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as Parameters<typeof handleAccountOffboardingPurge>[2]);

      const purged = await readOffboarding(offboardingId);
      expect(purged.status).toBe('purged');
      expect(purged.last_error).toBeNull();

      // Once purged, the row is no longer eligible for another retry.
      await expect(
        retryAccountOffboardingPurge(sql, { offboardingId, adminUserId }),
      ).rejects.toMatchObject({ status: 409, code: 'account_offboarding_purge_not_retryable' });
    } finally {
      stripeClientHolder.current = null;
      await cleanupOwnerOffboardingSeed(seed);
      await cleanupFakeAdminUser(adminUserId);
    }
  });

  // ── Scenario C: concurrent admin retries enqueue exactly once ─────────────
  it('two simultaneous retries on the same failed row: exactly one wins and enqueues, the other is refused', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const adminUserId = await seedFakeAdminUser();
    try {
      const offboardingId = await insertPurgeScheduledOffboarding(seed);
      const sql = getE2eSql();
      await markPurgeTerminalFailure(
        sql,
        { id: offboardingId, account_id: seed.accountId },
        'simulated_terminal_purge_failure_for_concurrency_test',
      );

      const [settledA, settledB] = await Promise.allSettled([
        retryAccountOffboardingPurge(sql, { offboardingId, adminUserId }),
        retryAccountOffboardingPurge(sql, { offboardingId, adminUserId }),
      ]);

      const outcomes = [settledA, settledB];
      const wins = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const losses = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(PurgeRetryError);
      expect((losses[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        code: 'account_offboarding_purge_not_retryable',
      });

      const outboxRows = await sql<{ id: string }[]>`
        SELECT id FROM job_outbox
        WHERE aggregate_id = ${offboardingId}::uuid AND topic = 'account_offboarding_purge'
      `;
      expect(outboxRows).toHaveLength(1);

      const row = await readOffboarding(offboardingId);
      expect(row.status).toBe('purge_scheduled');
      expect(row.retry_count).toBe(2); // markPurgeTerminalFailure (+1) then the one winning retry (+1)
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
      await cleanupFakeAdminUser(adminUserId);
    }
  });
});
