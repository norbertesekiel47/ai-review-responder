import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import {
  cleanupOwnerOffboardingSeed,
  getE2eSql,
  isE2eConfigured,
  seedOwnerOffboardingAccount,
  type OwnerOffboardingSeedData,
} from './seed';

const hasSupabaseBrowserEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

type LifecycleModules = {
  confirmCancelOnlyOffboarding: typeof import('../src/lib/account-offboarding/confirm').confirmCancelOnlyOffboarding;
  confirmDeleteDataOffboarding: typeof import('../src/lib/account-offboarding/confirm').confirmDeleteDataOffboarding;
  requestCancelOnlyReactivation: typeof import('../src/lib/account-offboarding/reactivation-request').requestCancelOnlyReactivation;
  keepMyDataWithToken: typeof import('../src/lib/account-offboarding/keep-my-data').keepMyDataWithToken;
  hashAccountOffboardingToken: typeof import('../src/lib/account-offboarding/tokens').hashAccountOffboardingToken;
  runAccountOffboardingPurgeOnce: typeof import('../worker/background/pollers/AccountOffboardingPurgePoller').runAccountOffboardingPurgeOnce;
  handleAccountOffboardingPurge: typeof import('../worker/jobs/account-offboarding/PurgeWorker').handleAccountOffboardingPurge;
};

let lifecycleModulesPromise: Promise<LifecycleModules> | null = null;

function configureOwnerOffboardingE2eRuntime(): void {
  if (!process.env.TEST_DATABASE_POOL_URL) return;
  process.env.DATABASE_POOL_URL = process.env.TEST_DATABASE_POOL_URL;
  process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';
  process.env.ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS ??= String(2 * 60 * 60 * 1000);
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.RESEND_FROM_EMAIL ??= 'noreply@repworth.test';
  process.env.SUPABASE_URL ??= process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY ??= 'e2e-service-key';
}

async function lifecycleModules(): Promise<LifecycleModules> {
  configureOwnerOffboardingE2eRuntime();
  lifecycleModulesPromise ??= Promise.all([
    import('../src/lib/account-offboarding/confirm'),
    import('../src/lib/account-offboarding/reactivation-request'),
    import('../src/lib/account-offboarding/keep-my-data'),
    import('../src/lib/account-offboarding/tokens'),
    import('../worker/background/pollers/AccountOffboardingPurgePoller'),
    import('../worker/jobs/account-offboarding/PurgeWorker'),
  ]).then(([
    confirm,
    reactivationRequest,
    keepMyData,
    tokens,
    purgePoller,
    purgeWorker,
  ]) => ({
    confirmCancelOnlyOffboarding: confirm.confirmCancelOnlyOffboarding,
    confirmDeleteDataOffboarding: confirm.confirmDeleteDataOffboarding,
    requestCancelOnlyReactivation: reactivationRequest.requestCancelOnlyReactivation,
    keepMyDataWithToken: keepMyData.keepMyDataWithToken,
    hashAccountOffboardingToken: tokens.hashAccountOffboardingToken,
    runAccountOffboardingPurgeOnce: purgePoller.runAccountOffboardingPurgeOnce,
    handleAccountOffboardingPurge: purgeWorker.handleAccountOffboardingPurge,
  }));
  return lifecycleModulesPromise;
}

test.describe('Owner offboarding — unauthenticated', () => {
  test.skip(!hasSupabaseBrowserEnv, 'Supabase browser env not set');

  test('status page redirects unauthenticated owners to login', async ({ page }) => {
    await page.goto('/account/offboarding/status');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10_000 });
  });
});

test.describe.serial('Owner offboarding — DB-backed lifecycle', () => {
  test.skip(!isE2eConfigured, 'TEST_DATABASE_POOL_URL not set');

  test.beforeAll(() => {
    configureOwnerOffboardingE2eRuntime();
  });

  test('cancel_only confirm creates pending offboarding and billing-schedule outbox', async () => {
    const seed = await seedOwnerOffboardingAccount();
    try {
      const { confirmCancelOnlyOffboarding } = await lifecycleModules();

      const result = await confirmCancelOnlyOffboarding({
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        requestId: 'e2e-cancel-only',
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

  test('pre-teardown reactivation queues same-subscription reversal work', async () => {
    const seed = await seedOwnerOffboardingAccount();
    try {
      const { confirmCancelOnlyOffboarding, requestCancelOnlyReactivation } = await lifecycleModules();
      const created = await confirmCancelOnlyOffboarding({
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        requestId: 'e2e-reactivation-create',
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

      const result = await requestCancelOnlyReactivation({
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        requestId: 'e2e-reactivation',
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

  test('delete_data confirm schedules teardown and keep-my-data email', async () => {
    const seed = await seedOwnerOffboardingAccount();
    try {
      const { confirmDeleteDataOffboarding } = await lifecycleModules();
      const result = await confirmDeleteDataOffboarding({
        accountId: seed.accountId,
        actorUserId: seed.userId,
        idempotencyKey: randomUUID(),
        reasonCode: 'unused',
        requestId: 'e2e-delete-data',
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

  test('keep-my-data token cancels pending purge without persisting raw token', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const rawToken = 'seeded-raw-keep-my-data-token';
    try {
      const { hashAccountOffboardingToken, keepMyDataWithToken } = await lifecycleModules();
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

      const result = await keepMyDataWithToken({
        rawToken,
        requestId: 'e2e-keep-my-data',
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

  test('purge worker completes with shortened non-production window', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    try {
      const { runAccountOffboardingPurgeOnce, handleAccountOffboardingPurge } = await lifecycleModules();
      const sql = getE2eSql();
      const offboardingId = randomUUID();
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
        await tx`
          INSERT INTO notification_deliveries (
            business_id,
            account_id,
            channel,
            recipient,
            template
          ) VALUES (
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

      await handleAccountOffboardingPurge({
        id: outbox!.id,
        data: {
          ...parsePayload(outbox!.payload),
          outbox_id: outbox!.id,
          outbox_attempt: 1,
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as Parameters<typeof handleAccountOffboardingPurge>[0]);

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

      const [completedOutbox] = await sql<{ status: string; aggregate_id: string | null; payload: Record<string, unknown> | string }[]>`
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

function parsePayload(value: Record<string, unknown> | string | undefined): Record<string, unknown> | undefined {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value;
}
