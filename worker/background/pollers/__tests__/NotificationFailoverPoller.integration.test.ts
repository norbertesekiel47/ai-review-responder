// Live-Postgres suite for the NotificationFailoverPoller owner-unreachable arm
// (F1 Task 4). The unit suite pins control flow against a mock sql; this proves
// the real predicate + advisory-locked at-most-once re-enqueue + admin escalation
// against a real schema, plus the markOutboxCompletedWithReason attempt-guarded
// CAS (Step 6b).
//
// processOwnerUnreachable is module-private, so the suite drives the public
// runFailoverPollerOnce entry and asserts ONLY the owner-unreachable effects
// (scoped by aggregate_id/response_id). The all-failed and stale arms are kept
// inert for the seeded rows: none carry an approval_request delivery, so neither
// arm's predicate matches them.
//
// The poller reads the module-level `sql` singleton from @/lib/db/server, which
// binds DATABASE_POOL_URL at import time — so a vi.hoisted() block points it at
// TEST_DATABASE_POOL_URL BEFORE the static import. Only the email transport is
// mocked; tryClaimAlert's notification_deliveries claim row is written for real.
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one).

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

// vi.mock is hoisted above module init, so the email mock fn must live in a
// vi.hoisted() block. The same block binds DATABASE_POOL_URL to the local test DB
// BEFORE @/lib/db/server evaluates its `sql` singleton.
const { mockSendInternalEmail } = vi.hoisted(() => {
  const url = process.env.TEST_DATABASE_POOL_URL;
  if (url) {
    process.env.DATABASE_POOL_URL = url;
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.example.com';
  }
  return {
    // Mock ONLY the email transport — the real tryClaimAlert still writes the
    // notification_deliveries claim row via the real sql singleton.
    mockSendInternalEmail: vi.fn(async () => ({ messageId: 'int-owner-unreach-msg' })),
  };
});
vi.mock('../../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));

import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_083_OUTBOX_OWNER_UNREACHABLE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { OUTBOX_COMPLETION_REASON } from '@/lib/shared/outbox-completion-reason';
import { markOutboxCompletedWithReason } from '@/lib/shared/outbox';
import { sql } from '@/lib/db/server';
import { runFailoverPollerOnce, tryClaimAlert } from '../NotificationFailoverPoller';
import { createWorkerLogger } from '@/lib/shared/logger';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// Local-host refusal guard — never point this suite at a remote/pooler host.
function assertLocalDatabaseUrl(databaseUrl: string | undefined): void {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }
  const isLocal =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (!isLocal) {
    throw new Error('owner-unreachable integration requires a local (localhost) test database');
  }
}

let tenant: TenantSeed | undefined;
const activeBusinessId = randomUUID();
const archivedBusinessId = randomUUID();

const AGED = "NOW() - INTERVAL '5 hours'"; // past the 4h floor
const FRESH = 'NOW()'; // below the 4h floor

async function seedDraft(opts: {
  businessId: string;
  createdAtExpr: string; // raw SQL expression for responses.created_at
}): Promise<{ reviewId: string; responseId: string }> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  await sql`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, status
    ) VALUES (
      ${reviewId}::uuid, ${opts.businessId}::uuid, 'zernio',
      ${`ou-int-${reviewId}`}, ${`zernio://ou-int/reviews/${reviewId}`},
      'zernio://ou-int/locations/1', 'Casey', 5, 'Great service', 'pending_approval'
    )
  `;
  await sql.unsafe(
    `INSERT INTO responses (id, review_id, business_id, response_text, original_draft_text, version, status, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Draft reply', 'Draft reply', 1, 'pending_approval', ${opts.createdAtExpr})`,
    [responseId, reviewId, opts.businessId],
  );
  return { reviewId, responseId };
}

async function insertSendNotifOutbox(opts: {
  responseId: string;
  status: string;
  completionReason?: string | null;
  createdAtExpr: string;
  attempts?: number;
}): Promise<string> {
  const id = randomUUID();
  await sql.unsafe(
    `INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, completion_reason, attempts, created_at)
     VALUES ($1::uuid, $2, 'response', $3::uuid, '{}'::jsonb, $4, $5, $6, ${opts.createdAtExpr})`,
    [
      id,
      QUEUE_NAMES.SEND_NOTIFICATION,
      opts.responseId,
      opts.status,
      opts.completionReason ?? null,
      opts.attempts ?? 0,
    ],
  );
  return id;
}

async function insertApprovalRequestDelivery(businessId: string, responseId: string): Promise<void> {
  await sql`
    INSERT INTO notification_deliveries
      (id, business_id, response_id, channel, recipient, template, sent_at)
    VALUES (${randomUUID()}::uuid, ${businessId}::uuid, ${responseId}::uuid, 'email',
            'owner@example.com', 'approval_request', NOW())
  `;
}

async function countPendingRetries(responseId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.SEND_NOTIFICATION}
      AND aggregate_id = ${responseId}::uuid
      AND status = 'pending'
  `;
  return row?.n ?? 0;
}

async function countAdminAlertDeliveries(responseId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM notification_deliveries
    WHERE response_id = ${responseId}::uuid
      AND template = 'admin_notification_owner_unreachable'
  `;
  return row?.n ?? 0;
}

async function cleanupDomainRows(): Promise<void> {
  const bizIds = [activeBusinessId, archivedBusinessId];
  await sql`DELETE FROM job_outbox WHERE aggregate_id IN (
    SELECT id FROM responses WHERE business_id = ANY(${bizIds}::uuid[])
  )`;
  await sql`DELETE FROM notification_deliveries WHERE business_id = ANY(${bizIds}::uuid[])`;
  await sql`DELETE FROM responses WHERE business_id = ANY(${bizIds}::uuid[])`;
  await sql`DELETE FROM reviews WHERE business_id = ANY(${bizIds}::uuid[])`;
}

describeWithDb('NotificationFailoverPoller owner-unreachable arm (live Postgres)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    assertLocalDatabaseUrl(testDatabaseUrl);
    // Assert, never apply (#573): migration 083 owns job_outbox.completion_reason,
    // which every owner-unreachable assertion in this suite reads. A DB behind
    // head fails loudly here instead of as an undefined-column error mid-fixture.
    await assertSchemaReady(sql as unknown as Sql, [MIGRATION_083_OUTBOX_OWNER_UNREACHABLE]);
    tenant = await seedTenantAccount(sql as unknown as Sql, {
      userName: 'Owner-Unreachable Integration Owner',
      accountDisplayName: 'Owner-Unreachable Integration Account',
    });
    await sql`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at)
      VALUES
        (${activeBusinessId}::uuid, 'OU Active', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', TRUE, NULL),
        (${archivedBusinessId}::uuid, 'OU Archived', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', FALSE, NOW())
    `;
  });

  beforeEach(async () => {
    mockSendInternalEmail.mockClear();
    await cleanupDomainRows();
  });

  afterAll(async () => {
    if (!tenant) return;
    await cleanupDomainRows();
    await sql`DELETE FROM businesses WHERE id IN (${activeBusinessId}::uuid, ${archivedBusinessId}::uuid)`;
    await cleanupTenantAccount(sql as unknown as Sql, tenant);
    await sql.end({ timeout: 5 });
  });

  it('positive: re-enqueues exactly one send_notification and records one admin alert', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: AGED,
    });

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(1);
    expect(await countAdminAlertDeliveries(responseId)).toBe(1);

    const retry = mockSendInternalEmail.mock.calls.find((call) => {
      const arg = (call as unknown[])[0] as { subject: string } | undefined;
      return arg?.subject.includes('Owner unreachable') ?? false;
    });
    expect(retry).toBeDefined();

    // Assert the re-enqueued payload carries the owner_unreachable_retry reason.
    const [outbox] = await sql<{ reason: string | null }[]>`
      SELECT payload->'failover'->>'reason' AS reason FROM job_outbox
      WHERE aggregate_id = ${responseId}::uuid AND status = 'pending'
    `;
    expect(outbox?.reason).toBe('owner_unreachable_retry');
  });

  it('(a) an approval_request delivery already exists → no retry, no alert', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: AGED,
    });
    await insertApprovalRequestDelivery(activeBusinessId, responseId);

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(0);
    expect(await countAdminAlertDeliveries(responseId)).toBe(0);
  });

  it('(b) completed owner_unreachable marker AND a newer in-flight send_notification → excluded from candidate, no retry, no alert', async () => {
    // The candidate now excludes any draft with a live in-flight send_notification
    // (matching the all-failed/stale arms), so a stuck in-flight retry can't
    // monopolize the batch and starve newer drafts. Seed a genuine owner-unreachable
    // draft (LATEST completed send_notification = owner_unreachable) PLUS a newer
    // in-flight (dispatched) retry: the completed-reason subquery still matches, but
    // the in-flight NOT EXISTS excludes the row at the candidate level → no retry,
    // no email. (The excluded draft's admin email waits ~1 retry cycle; the durable
    // Sentry checkOwnerUnreachable finding covers it meanwhile.)
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: "NOW() - INTERVAL '5 hours'",
    });
    await insertSendNotifOutbox({
      responseId,
      status: 'dispatched',
      createdAtExpr: "NOW() - INTERVAL '1 hour'", // newer, in-flight retry
    });

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(0);
    expect(await countAdminAlertDeliveries(responseId)).toBe(0);
  });

  it('(c) running twice yields exactly one in-flight retry and one admin alert (at-most-once)', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: AGED,
    });

    await runFailoverPollerOnce();
    // Second pass: the pending retry from pass 1 is now in-flight, so the candidate
    // SELECT excludes the draft entirely — no second retry INSERT and no second
    // admin alert (it would also be 24h-deduped had the row been re-selected).
    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(1);
    expect(await countAdminAlertDeliveries(responseId)).toBe(1);
  });

  it('(d) a newer completed send_notification with NULL reason supersedes the marker → no retry', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: "NOW() - INTERVAL '3 hours'", // older marker
    });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: null,
      createdAtExpr: "NOW() - INTERVAL '1 hour'", // newer, supersedes
    });

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(0);
    expect(await countAdminAlertDeliveries(responseId)).toBe(0);
  });

  it('(e) no completed send_notification at all → no retry', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(0);
    expect(await countAdminAlertDeliveries(responseId)).toBe(0);
  });

  it('(f) below the 4h age floor → no retry', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: FRESH });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: FRESH,
    });

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(0);
    expect(await countAdminAlertDeliveries(responseId)).toBe(0);
  });

  it('(g) archived business → no retry', async () => {
    const { responseId } = await seedDraft({ businessId: archivedBusinessId, createdAtExpr: AGED });
    await insertSendNotifOutbox({
      responseId,
      status: 'completed',
      completionReason: OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE,
      createdAtExpr: AGED,
    });

    await runFailoverPollerOnce();

    expect(await countPendingRetries(responseId)).toBe(0);
    expect(await countAdminAlertDeliveries(responseId)).toBe(0);
  });

  it('markOutboxCompletedWithReason preserves owner_unreachable against live Postgres and rejects a superseded attempt', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    const attempt = 2;
    const outboxId = await insertSendNotifOutbox({
      responseId,
      status: 'dispatched',
      createdAtExpr: AGED,
      attempts: attempt,
    });

    // Exercise the STALE attempt FIRST while the row is still 'dispatched' — this
    // proves the attempts guard, not just status gating.
    await markOutboxCompletedWithReason(
      sql, outboxId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, attempt - 1,
    );
    const [stale] = await sql<{ status: string; completion_reason: string | null }[]>`
      SELECT status, completion_reason FROM job_outbox WHERE id = ${outboxId}::uuid
    `;
    expect(stale?.status).toBe('dispatched');
    expect(stale?.completion_reason).toBeNull();

    // The winning attempt transitions it to completed + owner_unreachable.
    await markOutboxCompletedWithReason(
      sql, outboxId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, attempt,
    );
    const [won] = await sql<{ status: string; completion_reason: string | null }[]>`
      SELECT status, completion_reason FROM job_outbox WHERE id = ${outboxId}::uuid
    `;
    expect(won?.status).toBe('completed');
    expect(won?.completion_reason).toBe(OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE);
  });

  // ── tryClaimAlert: claim-before-send against real Postgres (#415) ──────────
  // Drives the exported helper directly. The claim row is committed before the
  // provider call; the provider call runs outside any tx; a failed send keeps
  // the claim; two concurrent claimers produce exactly one send.
  const CLAIM_TEMPLATE = 'approval_responsiveness_alert';
  const CLAIM_RECIPIENT = 'admin@repworth.example.com';
  const claimLogger = createWorkerLogger('[tryClaimAlert-int]');

  async function claimRows(responseId: string): Promise<Array<{
    id: string; sent_at: Date | null; failed_at: Date | null;
    failure_reason: string | null; external_message_id: string | null;
  }>> {
    return sql<Array<{
      id: string; sent_at: Date | null; failed_at: Date | null;
      failure_reason: string | null; external_message_id: string | null;
    }>>`
      SELECT id, sent_at, failed_at, failure_reason, external_message_id
      FROM notification_deliveries
      WHERE response_id = ${responseId}::uuid AND template = ${CLAIM_TEMPLATE}
      ORDER BY created_at ASC
    `;
  }

  it('claim (a) success → exactly one row with sent_at and the provider message id', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    const ctx = { accountId: tenant!.accountId, businessId: activeBusinessId, responseId };
    const sendFn = vi.fn(async (claimId: string) => `msg-${claimId}`);

    const outcome = await tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, sendFn, ctx, claimLogger);

    expect(outcome).toBe('sent');
    const rows = await claimRows(responseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).not.toBeNull();
    expect(rows[0]!.external_message_id).toBe(`msg-${rows[0]!.id}`);
    expect(sendFn).toHaveBeenCalledWith(rows[0]!.id);
  });

  it('claim (b) send failure → the claim row is KEPT with failed_at (never deleted)', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    const ctx = { accountId: tenant!.accountId, businessId: activeBusinessId, responseId };
    const sendFn = vi.fn(async () => { throw new Error('Resend API error: boom'); });

    const outcome = await tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, sendFn, ctx, claimLogger);

    expect(outcome).toBe('send_error');
    const rows = await claimRows(responseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).toBeNull();
    expect(rows[0]!.failed_at).not.toBeNull();
    expect(rows[0]!.failure_reason).toContain('Resend API error');

    // (c) the failed claim suppresses a retry inside the 24h window.
    const retry = vi.fn(async () => 'never');
    expect(await tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, retry, ctx, claimLogger)).toBe('deduped');
    expect(retry).not.toHaveBeenCalled();
    expect(await claimRows(responseId)).toHaveLength(1);
  });

  it('claim (d) a pre-existing UNSENT claim (1 min old) dedups; one aged past 24h does not and the new claim gets a new id', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    const ctx = { accountId: tenant!.accountId, businessId: activeBusinessId, responseId };
    const staleId = randomUUID();
    await sql.unsafe(
      `INSERT INTO notification_deliveries (id, account_id, business_id, response_id, channel, recipient, template, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'email', $5, $6, NOW() - INTERVAL '1 minute')`,
      [staleId, tenant!.accountId, activeBusinessId, responseId, CLAIM_RECIPIENT, CLAIM_TEMPLATE],
    );
    const sendFn = vi.fn(async () => 'never');
    expect(await tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, sendFn, ctx, claimLogger)).toBe('deduped');
    expect(sendFn).not.toHaveBeenCalled();

    // Age the unsent claim past the window → a NEW claim is inserted with a new id.
    await sql`UPDATE notification_deliveries SET created_at = NOW() - INTERVAL '25 hours' WHERE id = ${staleId}::uuid`;
    const sendFn2 = vi.fn(async (claimId: string) => `msg-${claimId}`);
    expect(await tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, sendFn2, ctx, claimLogger)).toBe('sent');
    const rows = await claimRows(responseId);
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id !== staleId)!;
    expect(fresh.sent_at).not.toBeNull();
    expect(sendFn2).toHaveBeenCalledWith(fresh.id);
    expect(fresh.id).not.toBe(staleId);
  });

  it('claim (e) two concurrent claimers → loser dedups while the winner is still sending; exactly one send, one row', async () => {
    const { responseId } = await seedDraft({ businessId: activeBusinessId, createdAtExpr: AGED });
    const ctx = { accountId: tenant!.accountId, businessId: activeBusinessId, responseId };
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendFn = vi.fn(async (claimId: string) => { await sendGate; return `msg-${claimId}`; });

    const p1 = tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, sendFn, ctx, claimLogger);
    const p2 = tryClaimAlert(responseId, CLAIM_TEMPLATE, CLAIM_RECIPIENT, sendFn, ctx, claimLogger);

    // The loser settles FIRST — the winner's claim is committed (lock released)
    // while its send is still pending on the gate.
    const first = await Promise.race([p1, p2]);
    expect(first).toBe('deduped');
    expect(sendFn).toHaveBeenCalledOnce();

    releaseSend();
    const results = await Promise.all([p1, p2]);
    expect(results.sort()).toEqual(['deduped', 'sent']);
    expect(sendFn).toHaveBeenCalledOnce();
    const rows = await claimRows(responseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).not.toBeNull();
  });
});
