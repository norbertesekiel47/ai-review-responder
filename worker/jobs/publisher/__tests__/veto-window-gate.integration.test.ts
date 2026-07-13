// Live-Postgres suite for the publisher's elapsed-veto-window gate (spec
// §2.11): proves the push transaction against the REAL in-flight partial
// index `idx_jo_publish_response_inflight` (migration 026) — the current
// 'dispatched' outbox row is completed and the fresh delayed publish row is
// inserted in ONE tx (completion must precede the insert or the partial
// index blocks it), and a re-run recomputes the SAME absolute deadline
// (idempotent — no drift, at most one effective push per response).
//
// Gated on TEST_DATABASE_POOL_URL (skips cleanly without one). Migration 074
// is applied idempotently in beforeAll via the shared advisory-lock helper.

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { applyMigration074IfMissing } from '@/lib/shared/__tests__/helpers/apply-migration-074';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { AUDIT_ACTION_AUTO_APPROVED_BY_POLICY } from '@/lib/approval/audit';
import { enforceElapsedVetoWindow } from '../veto-window-gate';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;

const businessId = randomUUID();
const reviewId = randomUUID();
const responseId = randomUUID();
const VETO_WINDOW_MINUTES = 15;
const NOOP_LOGGER = { log: () => {} };

function sql(): postgresType.Sql {
  if (!db) throw new Error('veto-window-gate integration database was not initialized');
  return db;
}

async function insertDispatchedPublishRow(): Promise<string> {
  const outboxId = uuidv7();
  await sql()`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, attempts, dispatched_at)
    VALUES (
      ${outboxId}, ${QUEUE_NAMES.PUBLISH_RESPONSE}, 'response', ${responseId},
      ${sql().json({ response_id: responseId, business_id: businessId })},
      'dispatched', 1, NOW()
    )
  `;
  return outboxId;
}

async function publishOutboxRows(): Promise<{ id: string; status: string; available_at: Date }[]> {
  return sql()<{ id: string; status: string; available_at: Date }[]>`
    SELECT id, status, available_at FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND aggregate_id = ${responseId}
    ORDER BY created_at
  `;
}

function gateInput(outboxId: string) {
  return {
    responseId,
    businessId,
    outboxId,
    outboxAttempt: 1,
    correlationId: 'veto-gate-int-corr',
    logger: NOOP_LOGGER,
  };
}

describeWithDb('elapsed-veto-window gate against live Postgres (deadline push tx)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 2, prepare: false });
    await applyMigration074IfMissing(db);
    tenant = await seedTenantAccount(db, {
      userName: 'Veto Gate Owner',
      accountDisplayName: 'Veto Gate Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${businessId}::uuid, 'Veto Gate Biz', 'Veto Gate Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
    await db`
      INSERT INTO reviews (id, business_id, provider, provider_review_id, provider_review_name, provider_location_name, reviewer_name, star_rating, review_text, status)
      VALUES (${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`veto-gate-int-${reviewId}`}, ${`zernio://veto-gate-int/reviews/${reviewId}`}, 'zernio://veto-gate-int/locations/1', 'Reviewer', 5, 'Wonderful service', 'responded')
    `;
    // Approved 20 minutes ago with a 15-minute window → original deadline
    // passed 5 minutes ago; the notice below was only delivered 5 minutes ago.
    await db`
      INSERT INTO responses (
        id, review_id, business_id, response_text, original_draft_text, response_language,
        status, approval_method, approved_at, approved_text, auto_post_scheduled_at
      ) VALUES (
        ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
        'Thanks for visiting!', 'Thanks for visiting!', 'en',
        'approved', 'auto_policy', NOW() - INTERVAL '20 minutes', 'Thanks for visiting!', NOW() - INTERVAL '5 minutes'
      )
    `;
    // The immutable window grant the gate derives from (persist.ts writes this
    // in the same tx as the approval).
    await db`
      INSERT INTO approval_audit_log (id, response_id, business_id, account_id, action, metadata, auth_method, response_text_at_approval)
      VALUES (
        ${uuidv7()}, ${responseId}::uuid, ${businessId}::uuid, ${tenant.accountId}::uuid,
        ${AUDIT_ACTION_AUTO_APPROVED_BY_POLICY},
        ${db.json({ veto_window_minutes: VETO_WINDOW_MINUTES })},
        'auto_policy', 'Thanks for visiting!'
      )
    `;
    // Late-delivered notice: first (and only) delivery 5 minutes ago.
    await db`
      INSERT INTO notification_deliveries (id, business_id, response_id, channel, recipient, template, sent_at)
      VALUES (${uuidv7()}, ${businessId}::uuid, ${responseId}::uuid, 'email', ${tenant.ownerEmail}, 'pending_post_notice', NOW() - INTERVAL '5 minutes')
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM approval_audit_log WHERE response_id = ${responseId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${responseId}`;
      await sql()`DELETE FROM notification_deliveries WHERE response_id = ${responseId}::uuid`;
      await sql()`DELETE FROM responses WHERE id = ${responseId}::uuid`;
      await sql()`DELETE FROM reviews WHERE id = ${reviewId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  it('pushes the deadline in one tx: current row completed, fresh delayed row inserted past the real in-flight index', async () => {
    const outboxId = await insertDispatchedPublishRow();

    const outcome = await enforceElapsedVetoWindow(sql(), gateInput(outboxId));
    expect(outcome).toBe('completed');

    const rows = await publishOutboxRows();
    expect(rows).toHaveLength(2);
    const current = rows.find((row) => row.id === outboxId);
    const fresh = rows.find((row) => row.id !== outboxId);
    expect(current!.status).toBe('completed');
    expect(fresh!.status).toBe('pending');

    // New deadline = first_sent + granted window (≈ NOW() + 10 minutes), on
    // both the outbox delay and the owner-visible response deadline.
    const [expected] = await sql()<{ anchored: Date }[]>`
      SELECT MIN(sent_at) + make_interval(mins => ${VETO_WINDOW_MINUTES}) AS anchored
      FROM notification_deliveries WHERE response_id = ${responseId}::uuid AND sent_at IS NOT NULL
    `;
    expect(Math.abs(fresh!.available_at.getTime() - expected!.anchored.getTime())).toBeLessThan(2_000);
    const [resp] = await sql()<{ auto_post_scheduled_at: Date }[]>`
      SELECT auto_post_scheduled_at FROM responses WHERE id = ${responseId}::uuid
    `;
    expect(resp!.auto_post_scheduled_at.getTime()).toBe(fresh!.available_at.getTime());
  });

  it('re-running the gate before the pushed deadline recomputes the SAME absolute deadline — no drift', async () => {
    const [before] = await sql()<{ auto_post_scheduled_at: Date }[]>`
      SELECT auto_post_scheduled_at FROM responses WHERE id = ${responseId}::uuid
    `;
    // Simulate the pending pushed row being claimed + the job redelivered
    // before its deadline (crash between tx commit and BullMQ ack).
    const [claimed] = await sql()<{ id: string }[]>`
      UPDATE job_outbox SET status = 'dispatched', attempts = 1, dispatched_at = NOW()
      WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND aggregate_id = ${responseId} AND status = 'pending'
      RETURNING id
    `;

    const outcome = await enforceElapsedVetoWindow(sql(), gateInput(claimed!.id));
    expect(outcome).toBe('completed');

    const [after] = await sql()<{ auto_post_scheduled_at: Date }[]>`
      SELECT auto_post_scheduled_at FROM responses WHERE id = ${responseId}::uuid
    `;
    expect(after!.auto_post_scheduled_at.getTime()).toBe(before!.auto_post_scheduled_at.getTime());

    const rows = await publishOutboxRows();
    const pending = rows.filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(Math.abs(pending[0]!.available_at.getTime() - before!.auto_post_scheduled_at.getTime())).toBeLessThan(2);
  });

  it('proceeds without touching the outbox once a full window has elapsed since first delivery', async () => {
    // Age the delivery past the window: first_sent 16 minutes ago.
    await sql()`
      UPDATE notification_deliveries SET sent_at = NOW() - INTERVAL '16 minutes'
      WHERE response_id = ${responseId}::uuid
    `;
    const [claimed] = await sql()<{ id: string }[]>`
      UPDATE job_outbox SET status = 'dispatched', attempts = 1, dispatched_at = NOW()
      WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND aggregate_id = ${responseId} AND status = 'pending'
      RETURNING id
    `;

    const rowsBefore = await publishOutboxRows();
    const outcome = await enforceElapsedVetoWindow(sql(), gateInput(claimed!.id));
    expect(outcome).toBe('proceed');

    // Gate proceeds without completing the current row or inserting new ones —
    // the worker's publish path owns the rest of the lifecycle.
    const rowsAfter = await publishOutboxRows();
    expect(rowsAfter).toHaveLength(rowsBefore.length);
    const [current] = await sql()<{ status: string }[]>`
      SELECT status FROM job_outbox WHERE id = ${claimed!.id}
    `;
    expect(current!.status).toBe('dispatched');
  });

  it('downgrades when zero delivered notices exist', async () => {
    await sql()`DELETE FROM notification_deliveries WHERE response_id = ${responseId}::uuid`;
    // Terminalize the previous test's in-flight row so the fresh insert
    // clears the partial in-flight index.
    await sql()`
      UPDATE job_outbox SET status = 'completed', completed_at = NOW()
      WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE} AND aggregate_id = ${responseId}
        AND status IN ('pending', 'dispatching', 'dispatched')
    `;
    const outboxId = await insertDispatchedPublishRow();

    const outcome = await enforceElapsedVetoWindow(sql(), gateInput(outboxId));
    expect(outcome).toBe('downgrade');
  });
});
