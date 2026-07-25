// worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts
//
// HARD-GATE integration coverage for the owner-offboarding lifecycle against
// a REAL Postgres database. Ported verbatim from the quarantined Playwright
// suite in `e2e/owner-offboarding.spec.ts` (issue #283): that suite's dynamic
// `import('../src/...')` calls died under Playwright's CJS transform, so the
// five DB-backed scenarios never ran anywhere. Vitest imports app code
// natively, and CI's `test` job provides TEST_DATABASE_POOL_URL — so this
// lane actually executes in the PR gate.
//
// Scenarios (same assertions as the Playwright originals):
//   1. cancel_only confirm → pending offboarding + billing-schedule outbox
//   2. pre-teardown reactivation → queued reversal outbox
//   3. delete_data confirm → teardown + keep-my-data email + zernio disconnect
//   4. keep-my-data token → purge cancelled, token consumed, no raw token
//   5. purge poller + worker → purged row, scrubbed PII, anonymized analytics
//
// Gating: SKIPS only when TEST_DATABASE_POOL_URL is absent. With the URL
// present it is a HARD MERGE GATE — it must run, not skip.
//
// MOCK_EXTERNAL_APIS=true (same as the Playwright original): the delete_data
// confirm path disconnects Zernio and the purge path touches Stripe — the
// mock transport short-circuits both. All env mutations are restored in
// afterAll so later files in the same worker see the original values.

import { it, expect, afterAll, beforeAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Point the production `sql` singleton at the test DB BEFORE app imports ───
// Mirrors integration-edit-existing-reply.test.ts: `src/lib/db/server.ts`
// builds `sql` from DATABASE_POOL_URL at module-load time, so the override
// must land in a hoisted block.
const { testDbUrl, originalEnv } = vi.hoisted(() => {
  const originalEnv = {
    DATABASE_POOL_URL: process.env.DATABASE_POOL_URL,
    ALLOW_E2E_DB_WRITES: process.env.ALLOW_E2E_DB_WRITES,
    ACCOUNT_OFFBOARDING_ENABLED: process.env.ACCOUNT_OFFBOARDING_ENABLED,
    ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS:
      process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS,
    MOCK_EXTERNAL_APIS: process.env.MOCK_EXTERNAL_APIS,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    TEST_DATABASE_POOL_URL: process.env.TEST_DATABASE_POOL_URL,
  };

  // vitest.setup.ts does NOT load .env.local — minimal KEY=VALUE parse so
  // `pnpm test` picks up a locally exported test DB too.
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
    process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS ??= String(2 * 60 * 60 * 1000);
    process.env.MOCK_EXTERNAL_APIS = 'true';
    process.env.RESEND_FROM_EMAIL ??= 'noreply@repworth.test';
    process.env.SUPABASE_URL ??= 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_KEY ??= 'integration-test-service-key';
  }
  return { testDbUrl, originalEnv };
});

import {
  confirmCancelOnlyOffboarding,
  confirmDeleteDataOffboarding,
} from '../../../../src/lib/account-offboarding/confirm';
import { requestCancelOnlyReactivation } from '../../../../src/lib/account-offboarding/reactivation-request';
import { keepMyDataWithToken } from '../../../../src/lib/account-offboarding/keep-my-data';
import { hashAccountOffboardingToken } from '../../../../src/lib/account-offboarding/tokens';
import { runAccountOffboardingPurgeOnce } from '../../../../worker/background/pollers/AccountOffboardingPurgePoller';
import { handleAccountOffboardingPurge } from '../PurgeWorker';
import { supabaseServerBounded } from '../../../../src/lib/db/server';
import {
  cleanupOwnerOffboardingSeed,
  closeSeedDb,
  getE2eSql,
  seedOwnerOffboardingAccount,
} from '../../../../e2e/seed';
import { describeWithDb } from '../../../../src/__tests__/helpers/describe-with-db';

// The hoisted block above already parsed .env.local and set DATABASE_POOL_URL,
// so `RUN` is the authoritative gate — passed to describeWithDb as `enabled`.
// It is also read in afterAll below, so it stays a named const.
const RUN = !!testDbUrl;

beforeAll(async () => {
  if (!RUN) return;
  const parsed = new URL(testDbUrl!);
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
  ) {
    throw new Error('offboarding migration 088 setup requires a local test database');
  }
  await getE2eSql().unsafe(
    readFileSync(
      resolve(process.cwd(), 'supabase/migrations/088_solicitation_batch_executor.sql'),
      'utf8',
    ),
  );
});

afterAll(async () => {
  if (RUN) await closeSeedDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function outboxTopicsForOffboarding(offboardingId: string): Promise<string[]> {
  const sql = getE2eSql();
  const rows = await sql<{ topic: string }[]>`
    SELECT topic
    FROM job_outbox
    WHERE aggregate_id = ${offboardingId}::uuid
    ORDER BY topic
  `;
  return rows.map((row) => row.topic);
}

async function expectAnalyticsEvent(
  offboardingId: string,
  eventName: string,
  accountId: string,
): Promise<void> {
  const sql = getE2eSql();
  const [event] = await sql<{ account_id: string | null; event_key: string }[]>`
    SELECT account_id, event_key
    FROM analytics_events
    WHERE event_name = ${eventName}
      AND event_key = ${`${eventName}:${offboardingId}`}
  `;
  expect(event?.account_id).toBe(accountId);
}

function parsePayload(
  value: Record<string, unknown> | string | undefined,
): Record<string, unknown> | undefined {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value;
}

// 30s per test: TEST_DATABASE_POOL_URL may be a remote Supabase pooler where
// the purge's fan-out of DELETEs pays per-round-trip latency (local container
// runs finish in <1s).
describeWithDb('owner offboarding — DB-backed lifecycle (integration)', { enabled: RUN, timeout: 30_000 }, () => {
  it('cancel_only confirm creates pending offboarding and billing-schedule outbox', async () => {
    const seed = await seedOwnerOffboardingAccount();
    try {
      const result = await confirmCancelOnlyOffboarding(getE2eSql(), {
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        requestId: 'int-cancel-only',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`unexpected cancel_only result: ${result.reason}`);

      const sql = getE2eSql();
      const [offboarding] = await sql<{
        id: string;
        mode: string;
        status: string;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        location_count: number | string | bigint;
      }[]>`
        SELECT id, mode, status, stripe_customer_id, stripe_subscription_id,
               cardinality(location_ids) AS location_count
        FROM account_offboardings
        WHERE id = ${result.offboarding.id}::uuid
      `;
      expect(offboarding).toMatchObject({
        mode: 'cancel_only',
        status: 'pending',
        stripe_customer_id: seed.stripeCustomerId,
        stripe_subscription_id: seed.stripeSubscriptionId,
      });
      expect(Number(offboarding?.location_count ?? 0)).toBe(1);

      const topics = await outboxTopicsForOffboarding(result.offboarding.id);
      expect(topics).toContain('account_offboarding_billing_schedule');
      await expectAnalyticsEvent(result.offboarding.id, 'offboarding_started', seed.accountId);
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('pre-teardown reactivation queues same-subscription reversal work', async () => {
    const seed = await seedOwnerOffboardingAccount();
    try {
      const created = await confirmCancelOnlyOffboarding(getE2eSql(), {
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        requestId: 'int-reactivation-create',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(`unexpected cancel_only result: ${created.reason}`);

      const sql = getE2eSql();
      await sql`
        UPDATE account_offboardings
        SET status = 'scheduled',
            access_ends_at = NOW() + INTERVAL '7 days',
            updated_at = NOW()
        WHERE id = ${created.offboarding.id}::uuid
      `;

      const result = await requestCancelOnlyReactivation(getE2eSql(), {
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        requestId: 'int-reactivation',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`unexpected reactivation result: ${result.reason}`);
      expect(result.status).toBe('queued');
      expect(result.offboarding.id).toBe(created.offboarding.id);

      const [outbox] = await sql<{ topic: string; payload: Record<string, unknown> | string }[]>`
        SELECT topic, payload
        FROM job_outbox
        WHERE aggregate_id = ${created.offboarding.id}::uuid
          AND topic = 'account_offboarding_reactivation'
      `;
      expect(outbox?.topic).toBe('account_offboarding_reactivation');
      const payload = parsePayload(outbox?.payload);
      expect(payload).toMatchObject({
        account_offboarding_id: created.offboarding.id,
        account_id: seed.accountId,
        actor_user_id: seed.userId,
      });
      expect(payload?.idempotency_key_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('delete_data confirm schedules teardown and keep-my-data email', async () => {
    const seed = await seedOwnerOffboardingAccount();
    try {
      const result = await confirmDeleteDataOffboarding(getE2eSql(), {
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        reasonCode: 'unused',
        requestId: 'int-delete-data',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`unexpected delete_data result: ${result.reason}`);

      const sql = getE2eSql();
      const [offboarding] = await sql<{
        mode: string;
        status: string;
        purge_after: Date | string | null;
      }[]>`
        SELECT mode, status, purge_after
        FROM account_offboardings
        WHERE id = ${result.offboarding.id}::uuid
      `;
      expect(offboarding?.mode).toBe('delete_data');
      expect(offboarding?.status).toBe('pending');
      expect(offboarding?.purge_after).toBeTruthy();

      const [connection] = await sql<{ status: string; disconnect_reason: string | null }[]>`
        SELECT status, disconnect_reason
        FROM zernio_connections
        WHERE business_id = ${seed.businessId}::uuid
      `;
      expect(connection).toMatchObject({
        status: 'disconnected',
        disconnect_reason: 'account_offboarding_delete_data',
      });

      const topics = await outboxTopicsForOffboarding(result.offboarding.id);
      expect(topics).toContain('account_offboarding_teardown');
      expect(topics).toContain('account_offboarding_email');
      await expectAnalyticsEvent(result.offboarding.id, 'offboarding_started', seed.accountId);
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('keep-my-data token cancels pending purge without persisting raw token', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const rawToken = 'seeded-raw-keep-my-data-token';
    try {
      const sql = getE2eSql();
      const offboardingId = randomUUID();
      const tokenId = randomUUID();
      const tokenHash = hashAccountOffboardingToken(rawToken);
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO account_offboardings (
            id,
            account_id,
            mode,
            status,
            purge_after,
            teardown_completed_at,
            location_ids,
            recipient_email
          ) VALUES (
            ${offboardingId}::uuid,
            ${seed.accountId}::uuid,
            'delete_data',
            'purge_scheduled',
            NOW() + INTERVAL '1 day',
            NOW(),
            ${[seed.businessId]}::uuid[],
            ${seed.ownerEmail}
          )
        `;
        await tx`
          INSERT INTO account_offboarding_tokens (
            id,
            account_offboarding_id,
            token_hash,
            expires_at,
            created_by_user_id
          ) VALUES (
            ${tokenId}::uuid,
            ${offboardingId}::uuid,
            ${tokenHash},
            NOW() + INTERVAL '1 day',
            ${seed.userId}::uuid
          )
        `;
      });

      const result = await keepMyDataWithToken(getE2eSql(), {
        rawToken,
        requestId: 'int-keep-my-data',
      });
      expect(result.ok).toBe(true);

      const [row] = await sql<{
        purge_cancelled_at: Date | string | null;
        status: string;
        consumed_at: Date | string | null;
        has_raw_token_column: boolean;
      }[]>`
        SELECT ao.purge_cancelled_at,
               ao.status,
               t.consumed_at,
               EXISTS (
                 SELECT 1
                 FROM information_schema.columns
                 WHERE table_name = 'account_offboarding_tokens'
                   AND column_name = 'raw_token'
               ) AS has_raw_token_column
        FROM account_offboardings ao
        JOIN account_offboarding_tokens t ON t.account_offboarding_id = ao.id
        WHERE ao.id = ${offboardingId}::uuid
      `;
      expect(row?.purge_cancelled_at).toBeTruthy();
      expect(row?.status).toBe('churned');
      expect(row?.consumed_at).toBeTruthy();
      expect(row?.has_raw_token_column).toBe(false);

      const topics = await outboxTopicsForOffboarding(offboardingId);
      expect(topics).toContain('account_offboarding_email');
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('account offboarding purge cascades from contact uploads through Solicitation batches and asks', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    try {
      const sql = getE2eSql();
      const offboardingId = randomUUID();
      // #541 contacts CSV ingestion (migration 086): seed one upload + contact
      // + visit so this real-DB purge run exercises the write-side DELETE
      // (purge-stages.ts) against the read-side verification
      // (purge-verification.ts) for real — a unit test with a mocked
      // verifyAccountOffboardingPurge can't catch a divergence between them.
      const contactsCsvUploadId = randomUUID();
      const contactsCsvContactId = randomUUID();
      const contactsCsvVisitId = randomUUID();
      const solicitationBatchId = randomUUID();
      const solicitationAskId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO contact_csv_uploads (
            id, account_id, business_id, filename, byte_size, content_sha256,
            raw_csv, status, report, attested_by_user_id, attested_at,
            attestation_version, completed_at
          ) VALUES (
            ${contactsCsvUploadId}::uuid,
            ${seed.accountId}::uuid,
            ${seed.businessId}::uuid,
            'purge-fixture.csv',
            42,
            ${'a'.repeat(64)},
            NULL,
            'completed',
            ${tx.json({ contactsCreated: 1, contactsMerged: 0, visitsAdded: 1, duplicateVisits: 0, rejectedRows: [] } as never)},
            ${seed.userId}::uuid,
            NOW(),
            'v1',
            NOW()
          )
        `;
        await tx`
          INSERT INTO solicitation_contacts (
            id, business_id, name, email, created_by_upload_id
          ) VALUES (
            ${contactsCsvContactId}::uuid,
            ${seed.businessId}::uuid,
            'Purge Fixture Contact',
            'purge-fixture@example.com',
            ${contactsCsvUploadId}::uuid
          )
        `;
        await tx`
          INSERT INTO solicitation_visits (
            id, contact_id, business_id, visit_date, upload_id
          ) VALUES (
            ${contactsCsvVisitId}::uuid,
            ${contactsCsvContactId}::uuid,
            ${seed.businessId}::uuid,
            CURRENT_DATE,
            ${contactsCsvUploadId}::uuid
          )
        `;
        await tx`
          INSERT INTO solicitation_batches (
            id, account_id, business_id, source_upload_id, built_at
          ) VALUES (
            ${solicitationBatchId}::uuid,
            ${seed.accountId}::uuid,
            ${seed.businessId}::uuid,
            ${contactsCsvUploadId}::uuid,
            NOW()
          )
        `;
        await tx`
          INSERT INTO solicitation_asks (
            id, account_id, business_id, batch_id, contact_id,
            status, evidence, decided_at
          ) VALUES (
            ${solicitationAskId}::uuid,
            ${seed.accountId}::uuid,
            ${seed.businessId}::uuid,
            ${solicitationBatchId}::uuid,
            ${contactsCsvContactId}::uuid,
            'send',
            ${tx.json({
              contact_id: contactsCsvContactId,
              policy_version: 'purge-fixture',
              decided_at: '2026-07-24T00:00:00.000Z',
              decision: 'send',
            } as never)},
            NOW()
          )
        `;
      });
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO account_offboardings (
            id,
            account_id,
            mode,
            status,
            teardown_completed_at,
            purge_after,
            location_ids,
            recipient_email,
            stripe_customer_id,
            stripe_subscription_id
          ) VALUES (
            ${offboardingId}::uuid,
            ${seed.accountId}::uuid,
            'delete_data',
            'purge_scheduled',
            NOW(),
            NOW() + INTERVAL '1 hour',
            ${[seed.businessId]}::uuid[],
            ${seed.ownerEmail},
            ${seed.stripeCustomerId},
            ${seed.stripeSubscriptionId}
          )
        `;
        // id supplied explicitly — notification_deliveries has no DB default
        // (UUIDv7 is generated app-side). The Playwright original omitted it,
        // a latent bug it never lived long enough to hit (issue #283).
        await tx`
          INSERT INTO notification_deliveries (
            id,
            business_id,
            account_id,
            channel,
            recipient,
            template
          ) VALUES (
            ${randomUUID()}::uuid,
            ${seed.businessId}::uuid,
            ${seed.accountId}::uuid,
            'email',
            ${seed.ownerEmail},
            'account_offboarding_test'
          )
        `;
      });

      await runAccountOffboardingPurgeOnce();

      const [outbox] = await sql<{ id: string; payload: Record<string, unknown> | string }[]>`
        SELECT id, payload
        FROM job_outbox
        WHERE aggregate_id = ${offboardingId}::uuid
          AND topic = 'account_offboarding_purge'
          AND status = 'pending'
      `;
      expect(outbox?.id).toBeTruthy();

      await sql`
        UPDATE job_outbox
        SET status = 'dispatched',
            dispatched_at = NOW(),
            attempts = 1
        WHERE id = ${outbox!.id}::uuid
      `;

      await handleAccountOffboardingPurge(sql, supabaseServerBounded, {
        id: outbox!.id,
        data: {
          ...parsePayload(outbox!.payload),
          outbox_id: outbox!.id,
          outbox_attempt: 1,
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as Parameters<typeof handleAccountOffboardingPurge>[2]);

      const [purged] = await sql<{
        status: string;
        terminal_at: Date | string | null;
        purged_at: Date | string | null;
        recipient_email: string | null;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
      }[]>`
        SELECT status, terminal_at, purged_at, recipient_email, stripe_customer_id, stripe_subscription_id
        FROM account_offboardings
        WHERE id = ${offboardingId}::uuid
      `;
      expect(purged).toMatchObject({
        status: 'purged',
        recipient_email: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
      });
      expect(purged?.terminal_at).toBeTruthy();
      expect(purged?.purged_at).toBeTruthy();

      const [completedOutbox] = await sql<{
        status: string;
        aggregate_id: string | null;
        payload: Record<string, unknown> | string;
      }[]>`
        SELECT status, aggregate_id, payload
        FROM job_outbox
        WHERE id = ${outbox!.id}::uuid
      `;
      expect(completedOutbox?.status).toBe('completed');
      expect(completedOutbox?.aggregate_id).toBeNull();
      expect(parsePayload(completedOutbox?.payload)).toEqual({});

      const [deliveryRetention] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count
        FROM notification_deliveries
        WHERE account_id = ${seed.accountId}::uuid
           OR business_id = ${seed.businessId}::uuid
      `;
      expect(Number(deliveryRetention?.count ?? 0)).toBe(0);

      const [contactsCsvUploadsRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM contact_csv_uploads WHERE account_id = ${seed.accountId}::uuid
      `;
      expect(Number(contactsCsvUploadsRemaining?.count ?? 0)).toBe(0);
      const [solicitationContactsRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_contacts WHERE business_id = ${seed.businessId}::uuid
      `;
      expect(Number(solicitationContactsRemaining?.count ?? 0)).toBe(0);
      const [solicitationVisitsRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_visits WHERE business_id = ${seed.businessId}::uuid
      `;
      expect(Number(solicitationVisitsRemaining?.count ?? 0)).toBe(0);
      const [solicitationBatchesRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_batches WHERE account_id = ${seed.accountId}::uuid
      `;
      expect(Number(solicitationBatchesRemaining?.count ?? 0)).toBe(0);
      const [solicitationAsksRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_asks WHERE account_id = ${seed.accountId}::uuid
      `;
      expect(Number(solicitationAsksRemaining?.count ?? 0)).toBe(0);

      const offboardingHash = createHash('sha256').update(offboardingId).digest('hex');
      const [purgedEvent] = await sql<{
        distinct_id: string;
        account_id: string | null;
        business_id: string | null;
        user_id: string | null;
        properties: Record<string, unknown> | string;
      }[]>`
        SELECT distinct_id, account_id, business_id, user_id, properties
        FROM analytics_events
        WHERE event_name = 'offboarding_purged'
          AND event_key = ${`offboarding_purged:${offboardingHash}`}
      `;
      expect(purgedEvent).toMatchObject({
        distinct_id: `offboarding:${offboardingHash}`,
        account_id: null,
        business_id: null,
        user_id: null,
      });
      expect(parsePayload(purgedEvent?.properties)).toEqual({});
    } finally {
      await cleanupOwnerOffboardingSeed(seed);
    }
  });
});
