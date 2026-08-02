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
import { runContentPurgeStage, type AccountOffboardingPurgeRow } from '../purge-stages';
import { acquireCsvIngestLock } from '../../../../src/lib/solicitation/ingest';
import { acquireSolicitationBatchLock } from '../../../../src/lib/solicitation/batch-builder';
import { supabaseServerBounded } from '../../../../src/lib/db/server';
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
} from '../../../../src/lib/shared/__tests__/helpers/schema-ready';
import { verifyAccountOffboardingPurge } from '../../../../src/lib/account-offboarding/purge-verification';
// Type-only: the closed enums are owned by suppression.ts, so no source or
// Suppression scope value is re-spelled as a bare literal in this file.
import type {
  SuppressionScope,
  SuppressionSource,
} from '../../../../src/lib/solicitation/suppression';

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
    throw new Error('offboarding integration setup requires a local test database');
  }
  // This suite used to re-apply 088 here. That DDL took ACCESS EXCLUSIVE locks
  // on agent_runs / solicitation_* and deadlocked (40P01) against sibling
  // live-DB suites running in a CONCURRENT vitest process — #573. The schema is
  // provisioned once by `pnpm test:db:setup`; assert it instead.
  await assertSchemaReady(getE2eSql(), [
    MIGRATION_088_SOLICITATION_BATCH_EXECUTOR,
    MIGRATION_093_SOLICITATION_CONSENT,
    MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  ]);
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

// ── Suppression ledger / Unsubscribe token fixtures (#643, spec §6.3) ────────

/** A fresh Normalized handle per test, so no two tests contend on one key. */
function freshSuppressionHandle(): string {
  return `offboarding-suppression-${randomUUID()}@test.local`;
}

/**
 * Seeds one Suppression ledger row directly. A raw INSERT on purpose: these
 * tests are about what the offboarding purge does to rows that ALREADY exist,
 * and `recordSuppression`'s own first-write-wins contract is proven against the
 * partial unique indexes by
 * `src/lib/solicitation/__tests__/suppression.integration.test.ts`.
 */
async function seedSuppressionRow(input: {
  scope: SuppressionScope;
  handle: string;
  accountId: string | null;
  source: SuppressionSource;
  createdByUserId?: string | null;
}): Promise<string> {
  const sql = getE2eSql();
  const id = randomUUID();
  await sql`
    INSERT INTO solicitation_suppressions (
      id, channel, normalized_handle, scope, account_id, source, created_by_user_id
    ) VALUES (
      ${id}::uuid, 'email', ${input.handle}, ${input.scope},
      ${input.accountId}::uuid, ${input.source},
      ${input.createdByUserId ?? null}::uuid
    )
  `;
  return id;
}

async function readSuppressionRows(
  handle: string,
): Promise<{ scope: string; account_id: string | null; source: string }[]> {
  const sql = getE2eSql();
  return sql<{ scope: string; account_id: string | null; source: string }[]>`
    SELECT scope, account_id, source
    FROM solicitation_suppressions
    WHERE normalized_handle = ${handle}
    ORDER BY scope
  `;
}

/**
 * `solicitation_suppressions.account_id` is a NO-ACTION FK to `accounts`, and
 * `cleanupOwnerOffboardingSeed` DELETEs the accounts row — so a RETAINED global
 * row wedges teardown unless it goes first. Retention is the whole point of
 * these tests, so every one of them leaves exactly such a row behind. Keyed on
 * the handle rather than the account so it also sweeps rows whose `account_id`
 * is NULL.
 */
async function cleanupSuppressionFixtures(handles: readonly string[]): Promise<void> {
  const sql = getE2eSql();
  await sql`DELETE FROM solicitation_suppressions WHERE normalized_handle = ANY(${[...handles]}::text[])`;
  await sql`DELETE FROM solicitation_unsubscribe_tokens WHERE normalized_handle = ANY(${[...handles]}::text[])`;
}

interface UnsubscribeTokenFixture {
  tokenId: string;
  outreachId: string;
  askId: string;
  handle: string;
  tokenHash: string;
  sentAt: string;
}

/**
 * Seeds the whole provenance chain an Unsubscribe token is minted from —
 * upload → contact → batch → ask → outreach → token — so the purge exercises
 * both mechanisms at once: the explicit provenance scrub, and `outreach_id`'s
 * ON DELETE SET NULL firing as the outreach row cascades away with the upload.
 */
async function seedUnsubscribeTokenFixture(
  seed: OwnerOffboardingSeedData,
): Promise<UnsubscribeTokenFixture> {
  const sql = getE2eSql();
  const uploadId = randomUUID();
  const contactId = randomUUID();
  const batchId = randomUUID();
  const askId = randomUUID();
  const outreachId = randomUUID();
  const tokenId = randomUUID();
  const handle = freshSuppressionHandle();
  const tokenHash = createHash('sha256').update(tokenId).digest('hex');

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO contact_csv_uploads (
        id, account_id, business_id, filename, byte_size, content_sha256,
        raw_csv, status, report, attested_by_user_id, attested_at,
        attestation_version, completed_at
      ) VALUES (
        ${uploadId}::uuid, ${seed.accountId}::uuid, ${seed.businessId}::uuid,
        'token-fixture.csv', 42, ${'d'.repeat(64)}, NULL, 'completed',
        ${tx.json({
          contactsCreated: 1,
          contactsMerged: 0,
          visitsAdded: 0,
          duplicateVisits: 0,
          rejectedRows: [],
        } as never)},
        ${seed.userId}::uuid, NOW(), 'v1', NOW()
      )
    `;
    await tx`
      INSERT INTO solicitation_contacts (
        id, business_id, name, email, created_by_upload_id
      ) VALUES (
        ${contactId}::uuid, ${seed.businessId}::uuid, 'Token Fixture Contact',
        ${handle}, ${uploadId}::uuid
      )
    `;
    await tx`
      INSERT INTO solicitation_batches (
        id, account_id, business_id, source_upload_id, built_at
      ) VALUES (
        ${batchId}::uuid, ${seed.accountId}::uuid, ${seed.businessId}::uuid,
        ${uploadId}::uuid, NOW()
      )
    `;
    await tx`
      INSERT INTO solicitation_asks (
        id, account_id, business_id, batch_id, contact_id, status, evidence, decided_at
      ) VALUES (
        ${askId}::uuid, ${seed.accountId}::uuid, ${seed.businessId}::uuid,
        ${batchId}::uuid, ${contactId}::uuid, 'send',
        ${tx.json({
          contact_id: contactId,
          policy_version: 'token-fixture',
          decided_at: '2026-08-01T00:00:00.000Z',
          decision: 'send',
        } as never)},
        NOW()
      )
    `;
    await tx`
      INSERT INTO solicitation_outreach (
        id, account_id, business_id, batch_id, ask_id, contact_id,
        rendered_subject, rendered_body, prompt_version, prompt_hash,
        interpolation_inputs, rendered_at, ask_lint_version, lint_detail,
        moderation_status, moderation_detail, delivery_status,
        queued_at, sending_at, sent_at
      ) VALUES (
        ${outreachId}::uuid, ${seed.accountId}::uuid, ${seed.businessId}::uuid,
        ${batchId}::uuid, ${askId}::uuid, ${contactId}::uuid,
        'Token fixture subject', 'Token fixture body',
        'solicitation_ask_v1', ${'0'.repeat(64)},
        ${tx.json({} as never)}, NOW(), 'ask_lint_v1', ${tx.json([] as never)},
        'clean', ${tx.json({} as never)}, 'sent',
        NOW(), NOW(), NOW()
      )
    `;
    await tx`
      INSERT INTO solicitation_unsubscribe_tokens (
        id, token_hash, normalized_handle, channel,
        account_id, business_id, ask_id, outreach_id, sent_at
      ) VALUES (
        ${tokenId}::uuid, ${tokenHash}, ${handle}, 'email',
        ${seed.accountId}::uuid, ${seed.businessId}::uuid, ${askId}::uuid,
        ${outreachId}::uuid, NOW()
      )
    `;
  });

  // `::text` end-to-end: postgres.js truncates timestamptz MICROSECONDS into a
  // JS Date, so a Date round-trip could report "kept" for a value that moved.
  const [row] = await sql<{ sent_at: string }[]>`
    SELECT sent_at::text AS sent_at FROM solicitation_unsubscribe_tokens WHERE id = ${tokenId}::uuid
  `;
  return { tokenId, outreachId, askId, handle, tokenHash, sentAt: row!.sent_at };
}

/**
 * Drives the FULL production purge path — poller, then outbox dispatch, then
 * the worker — and reports the offboarding's terminal state.
 * `finalizePurgeInTransaction` runs `verifyAccountOffboardingPurge` inside its
 * own transaction and refuses to stamp `purged` on any violation, so a
 * `'purged'` status is the assertion that purge verification passed.
 */
async function runFullProductionPurge(
  seed: OwnerOffboardingSeedData,
): Promise<{ status: string; failed_step: string | null; last_error: string | null }> {
  const sql = getE2eSql();
  const offboardingId = randomUUID();
  await sql`
    INSERT INTO account_offboardings (
      id, account_id, mode, status, teardown_completed_at, purge_after,
      location_ids, recipient_email, stripe_customer_id, stripe_subscription_id
    ) VALUES (
      ${offboardingId}::uuid, ${seed.accountId}::uuid, 'delete_data',
      'purge_scheduled', NOW(), NOW() + INTERVAL '1 hour',
      ${[seed.businessId]}::uuid[], ${seed.ownerEmail},
      ${seed.stripeCustomerId}, ${seed.stripeSubscriptionId}
    )
  `;

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
    SET status = 'dispatched', dispatched_at = NOW(), attempts = 1
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

  const [row] = await sql<
    { status: string; failed_step: string | null; last_error: string | null }[]
  >`
    SELECT status, failed_step, last_error
    FROM account_offboardings
    WHERE id = ${offboardingId}::uuid
  `;
  return row!;
}

async function readUnsubscribeToken(tokenId: string): Promise<
  | {
      token_hash: string;
      normalized_handle: string;
      channel: string;
      sent_at: string;
      account_id: string | null;
      business_id: string | null;
      ask_id: string | null;
      outreach_id: string | null;
    }
  | undefined
> {
  const sql = getE2eSql();
  const [row] = await sql<
    {
      token_hash: string;
      normalized_handle: string;
      channel: string;
      sent_at: string;
      account_id: string | null;
      business_id: string | null;
      ask_id: string | null;
      outreach_id: string | null;
    }[]
  >`
    SELECT token_hash, normalized_handle, channel, sent_at::text AS sent_at,
           account_id, business_id, ask_id, outreach_id
    FROM solicitation_unsubscribe_tokens
    WHERE id = ${tokenId}::uuid
  `;
  return row;
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
    // Bystander tenant: its consent row must SURVIVE the other account's purge
    // — the sweep is business-scoped, not global (#625 spec §3.2).
    const bystander = await seedOwnerOffboardingAccount({ zernioConnection: false });
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
        // Consent ledger (migration 093, #625): businesses are TOMBSTONED at
        // purge (never DELETEd), so 093's business_id ON DELETE CASCADE never
        // fires on this path, and the upload delete only nulls
        // source_upload_id — the explicit purge-stage sweep is the ONLY
        // deleter. Seed one row for the purged tenant (pointing at the upload
        // being deleted, to prove the sweep handles the SET NULL ordering) and
        // one for the bystander tenant.
        await tx`
          INSERT INTO solicitation_consent (
            id, channel, normalized_handle, business_id, basis,
            attestation_version, attested_at, attested_by_user_id, source_upload_id
          ) VALUES (
            ${randomUUID()}::uuid,
            'email',
            'purge-fixture@example.com',
            ${seed.businessId}::uuid,
            'owner_attested',
            'consent_attestation_v2',
            NOW(),
            ${seed.userId}::uuid,
            ${contactsCsvUploadId}::uuid
          )
        `;
        await tx`
          INSERT INTO solicitation_consent (
            id, channel, normalized_handle, business_id, basis,
            attestation_version, attested_at, attested_by_user_id, source_upload_id
          ) VALUES (
            ${randomUUID()}::uuid,
            'email',
            'bystander-fixture@example.com',
            ${bystander.businessId}::uuid,
            'owner_attested',
            'consent_attestation_v2',
            NOW(),
            ${bystander.userId}::uuid,
            NULL
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
      // The explicit consent sweep (purge-stages.ts) removed the purged
      // tenant's ledger row — no cascade does this, see the seeding comment.
      const [consentRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_consent WHERE business_id = ${seed.businessId}::uuid
      `;
      expect(Number(consentRemaining?.count ?? 0)).toBe(0);
      // …and only that tenant's: the bystander's consent row survives.
      const [bystanderConsentRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_consent WHERE business_id = ${bystander.businessId}::uuid
      `;
      expect(Number(bystanderConsentRemaining?.count ?? 0)).toBe(1);

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
      await cleanupOwnerOffboardingSeed(bystander);
    }
  });

  // #582: the csv_ingest advisory-lock contract used to be honoured by three of
  // its four contact_csv_uploads writers. This stage was the fourth. Two live
  // connections are the only way to show the lock actually contends — a mocked
  // sql can assert the statement was ISSUED, never that anything blocked on it.
  it('content purge waits for an in-flight contacts-CSV ingest rather than deleting its upload row (#582)', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const sql = getE2eSql();
    const uploadId = randomUUID();
    let releaseIngest: (() => void) | undefined;

    try {
      await sql`
        INSERT INTO contact_csv_uploads (
          id, account_id, business_id, filename, byte_size, content_sha256,
          raw_csv, status, attested_by_user_id, attested_at, attestation_version
        ) VALUES (
          ${uploadId}::uuid, ${seed.accountId}::uuid, ${seed.businessId}::uuid,
          'lock-fixture.csv', 42, ${'b'.repeat(64)}, 'name,email', 'pending',
          ${seed.userId}::uuid, NOW(), 'v1'
        )
      `;

      // Stand in for an ingest transaction: hold the lock, then park.
      let signalLockHeld: (() => void) | undefined;
      const lockHeld = new Promise<void>((resolve) => { signalLockHeld = resolve; });
      const ingestMayFinish = new Promise<void>((resolve) => { releaseIngest = resolve; });
      const ingest = sql.begin(async (tx) => {
        await acquireCsvIngestLock(tx, seed.businessId);
        signalLockHeld?.();
        await ingestMayFinish;
      });
      await lockHeld;

      const purgeRow = { account_id: seed.accountId } as AccountOffboardingPurgeRow;
      const purge = runContentPurgeStage(sql, purgeRow);
      const settled = Symbol('settled');
      const outcome = await Promise.race([
        purge.then(() => settled),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 750)),
      ]);
      expect(outcome).toBe('blocked');

      // Still blocked means still present — the exact row the race used to eat.
      const [duringIngest] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM contact_csv_uploads WHERE id = ${uploadId}::uuid
      `;
      expect(Number(duringIngest?.count ?? 0)).toBe(1);

      releaseIngest?.();
      releaseIngest = undefined;
      await ingest;
      await purge;

      const [afterIngest] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM contact_csv_uploads WHERE id = ${uploadId}::uuid
      `;
      expect(Number(afterIngest?.count ?? 0)).toBe(0);
    } finally {
      releaseIngest?.();
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  // #624 T8. The lock is per-BUSINESS and this stage is per-ACCOUNT, so the
  // claim under test is coverage of EVERY business — the second location is
  // the one a single-business shortcut would miss. Two live connections again:
  // only a real block proves the key contends.
  it('the offboarding purge takes the solicitation batch advisory lock for every business under the account', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const sql = getE2eSql();
    const secondBusinessId = randomUUID();
    const uploadId = randomUUID();
    let releaseBuild: (() => void) | undefined;

    try {
      await sql`
        INSERT INTO businesses (
          id, name, owner_name, owner_email, account_id,
          subscription_status, category
        ) VALUES (
          ${secondBusinessId}::uuid, 'Second Offboarding Location', 'Owner Offboarding',
          ${seed.ownerEmail}, ${seed.accountId}::uuid, 'active', 'restaurant'
        )
      `;
      // Under the FIRST business: it is deleted by the same stage, so its
      // survival while blocked shows nothing was purged behind the held lock.
      await sql`
        INSERT INTO contact_csv_uploads (
          id, account_id, business_id, filename, byte_size, content_sha256,
          raw_csv, status, attested_by_user_id, attested_at, attestation_version
        ) VALUES (
          ${uploadId}::uuid, ${seed.accountId}::uuid, ${seed.businessId}::uuid,
          'batch-lock-fixture.csv', 42, ${'c'.repeat(64)}, 'name,email', 'pending',
          ${seed.userId}::uuid, NOW(), 'v1'
        )
      `;

      // Stand in for a batch-construction transaction on the SECOND business:
      // hold that business's key, then park.
      let signalLockHeld: (() => void) | undefined;
      const lockHeld = new Promise<void>((resolve) => { signalLockHeld = resolve; });
      const buildMayFinish = new Promise<void>((resolve) => { releaseBuild = resolve; });
      const build = sql.begin(async (tx) => {
        await acquireSolicitationBatchLock(tx, secondBusinessId);
        signalLockHeld?.();
        await buildMayFinish;
      });
      await lockHeld;

      const purgeRow = { account_id: seed.accountId } as AccountOffboardingPurgeRow;
      const purge = runContentPurgeStage(sql, purgeRow);
      const settled = Symbol('settled');
      const outcome = await Promise.race([
        purge.then(() => settled),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 750)),
      ]);
      expect(outcome).toBe('blocked');

      const [duringBuild] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM contact_csv_uploads WHERE id = ${uploadId}::uuid
      `;
      expect(Number(duringBuild?.count ?? 0)).toBe(1);

      releaseBuild?.();
      releaseBuild = undefined;
      await build;
      await purge;

      const [afterBuild] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM contact_csv_uploads WHERE id = ${uploadId}::uuid
      `;
      expect(Number(afterBuild?.count ?? 0)).toBe(0);
    } finally {
      releaseBuild?.();
      await sql`DELETE FROM businesses WHERE id = ${secondBusinessId}::uuid`;
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  // ── #643 Suppression ledger retention + Unsubscribe token scrub (§6.3) ─────
  //
  // Retention splits on the Suppression scope axis (D7): global rows are the
  // RECIPIENT's revocation against our one shared sending identity and survive
  // with account_id intact; account rows are the owner's own preference and are
  // deleted. G13 is why the survival half is proven HERE and nowhere else —
  // `verifyAccountOffboardingPurge` counts violations, so "correctly retained"
  // and "every row wrongly deleted" both return 0 and it structurally cannot
  // tell them apart. The runtime arm's job is narrowed to what it can do: catch
  // surviving account-scoped rows, and an invalid retained global row that
  // named one of this account's users as its actor.

  it('purge verification fails when an account-scoped suppression row survives', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const handle = freshSuppressionHandle();
    try {
      await seedSuppressionRow({
        scope: 'account',
        handle,
        accountId: seed.accountId,
        source: 'owner_manual',
        createdByUserId: seed.userId,
      });

      const result = await verifyAccountOffboardingPurge(
        { accountId: seed.accountId, offboardingId: randomUUID() },
        getE2eSql(),
      );

      // The whole sweep is failing here (the account is not purged at all), so
      // the load-bearing assertion is the SPECIFIC issue and its exact count.
      expect(result.ok).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          table: 'solicitation_suppressions',
          disposition: 'retain_compliance_limited_pii',
          purgeVerification: 'allowed_limited_retention',
          violationCount: 1,
        }),
      );
    } finally {
      await cleanupSuppressionFixtures([handle]);
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it("purge verification fails when a retained global row still references one of the account's users", async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const handle = freshSuppressionHandle();
    try {
      // account_id is NULL on purpose: the ONLY thing that can detect this row
      // is created_by_user_id, so the branch under test is the one that fires.
      // G14 types the actor as a plain string and cannot prove it belongs to an
      // admin, which is exactly the caller mistake this branch exists to catch.
      await seedSuppressionRow({
        scope: 'global',
        handle,
        accountId: null,
        source: 'admin_manual',
        createdByUserId: seed.userId,
      });

      const result = await verifyAccountOffboardingPurge(
        { accountId: seed.accountId, offboardingId: randomUUID() },
        getE2eSql(),
      );

      expect(result.issues).toContainEqual(
        expect.objectContaining({
          table: 'solicitation_suppressions',
          violationCount: 1,
        }),
      );
    } finally {
      await cleanupSuppressionFixtures([handle]);
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('purge verification passes when a global suppression row survives with its account_id intact', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    const handle = freshSuppressionHandle();
    try {
      await seedSuppressionRow({
        scope: 'global',
        handle,
        accountId: seed.accountId,
        source: 'complaint',
      });

      const purged = await runFullProductionPurge(seed);

      // `finalizePurgeInTransaction` runs verification inside its transaction
      // and refuses to stamp `purged` on any violation, so this status IS the
      // "verification passed" assertion.
      expect(purged.last_error).toBeNull();
      expect(purged.status).toBe('purged');

      // …and, per G13, verification passing is NOT evidence of retention: a
      // purge that deleted every row would also report zero violations. Read
      // the row back.
      const rows = await readSuppressionRows(handle);
      expect(rows).toEqual([
        expect.objectContaining({
          scope: 'global',
          source: 'complaint',
          account_id: seed.accountId,
        }),
      ]);
    } finally {
      await cleanupSuppressionFixtures([handle]);
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('a global suppression row survives the purge with its account_id intact', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    // ONE handle, BOTH Suppression scopes: the two rows are indistinguishable
    // to any sweep keyed on the handle or on account_id alone, so only a delete
    // that discriminates on `scope` can pass this.
    const handle = freshSuppressionHandle();
    try {
      await seedSuppressionRow({
        scope: 'global',
        handle,
        accountId: seed.accountId,
        source: 'unsubscribe_one_click',
      });
      await seedSuppressionRow({
        scope: 'account',
        handle,
        accountId: seed.accountId,
        source: 'owner_manual',
        createdByUserId: seed.userId,
      });

      await runContentPurgeStage(
        getE2eSql(),
        { account_id: seed.accountId } as AccountOffboardingPurgeRow,
      );

      const rows = await readSuppressionRows(handle);
      expect(rows).toEqual([
        expect.objectContaining({
          scope: 'global',
          source: 'unsubscribe_one_click',
          // Intact, pointing at the accounts row the purge only tombstones —
          // 096 gives that FK no ON DELETE action for exactly this reason.
          account_id: seed.accountId,
        }),
      ]);
    } finally {
      await cleanupSuppressionFixtures([handle]);
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('the purge scrubs account_id, business_id, ask_id and outreach_id from token rows and keeps token_hash, normalized_handle, channel and sent_at', async () => {
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    let fixture: UnsubscribeTokenFixture | undefined;
    try {
      fixture = await seedUnsubscribeTokenFixture(seed);

      await runContentPurgeStage(
        getE2eSql(),
        { account_id: seed.accountId } as AccountOffboardingPurgeRow,
      );

      const token = await readUnsubscribeToken(fixture.tokenId);
      expect(token).toBeDefined();
      // Provenance gone — all four columns. G12's implication CHECK is what
      // makes the first three inseparable: nulling account_id alone throws.
      expect(token).toMatchObject({
        account_id: null,
        business_id: null,
        ask_id: null,
        outreach_id: null,
      });
      // Mechanism kept: redemption after the sender is gone still has to work
      // (§5.2), and every field it needs is here.
      expect(token).toMatchObject({
        token_hash: fixture.tokenHash,
        normalized_handle: fixture.handle,
        channel: 'email',
        sent_at: fixture.sentAt,
      });
    } finally {
      if (fixture) await cleanupSuppressionFixtures([fixture.handle]);
      await cleanupOwnerOffboardingSeed(seed);
    }
  });

  it('a token row survives the purge that deletes its outreach row', async () => {
    // The regression test for G1. A CASCADE FK from solicitation_outreach would
    // delete the retained token through the
    // outreach -> batches -> contact_csv_uploads chain and silently break §5.2;
    // no FK at all would leave the row carrying a stale pointer nothing could
    // detect. ON DELETE SET NULL is the only shape that passes this.
    const seed = await seedOwnerOffboardingAccount({ zernioConnection: false });
    let fixture: UnsubscribeTokenFixture | undefined;
    try {
      fixture = await seedUnsubscribeTokenFixture(seed);
      const sql = getE2eSql();

      await runContentPurgeStage(
        sql,
        { account_id: seed.accountId } as AccountOffboardingPurgeRow,
      );

      const [outreachRemaining] = await sql<{ count: number | string | bigint }[]>`
        SELECT COUNT(*) AS count FROM solicitation_outreach WHERE id = ${fixture.outreachId}::uuid
      `;
      expect(Number(outreachRemaining?.count ?? 0)).toBe(0);

      const token = await readUnsubscribeToken(fixture.tokenId);
      expect(token).toBeDefined();
      // Nulled by the FK's SET NULL as the outreach row cascaded away, not by
      // the explicit provenance scrub — outreach_id is deliberately absent from
      // that UPDATE and from G12's CHECK.
      expect(token?.outreach_id).toBeNull();
      expect(token?.token_hash).toBe(fixture.tokenHash);
    } finally {
      if (fixture) await cleanupSuppressionFixtures([fixture.handle]);
      await cleanupOwnerOffboardingSeed(seed);
    }
  });
});
