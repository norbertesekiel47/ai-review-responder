import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { OUTBOX_COMPLETION_REASON } from '@/lib/shared/outbox-completion-reason';
import {
  checkOwnerUnreachable,
  checkZeroDeliveryNotifications,
  type HealthAlertConfig,
} from '../checks';

// Real-Postgres coverage for the F1 owner-unreachable health signals. Gated on
// TEST_DATABASE_POOL_URL: mirrors suspension.integration.test.ts — SKIPS cleanly
// (no error) when the local test DB is absent (expected locally, runs in CI).
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const liveBusinessId = randomUUID();
const archivedBusinessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('owner-unreachable integration database was not initialized');
  return db;
}

function requireTenant(): TenantSeed {
  if (!tenant) throw new Error('owner-unreachable integration tenant was not seeded');
  return tenant;
}

// Local-host refusal guard (copied from suspension.integration.test.ts): accept
// only localhost/127.0.0.1 Postgres (dev + CI service container), refuse any
// remote/pooler host. Never widen to remote hosts.
function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }
  const isLocalPostgres =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (databaseUrl === undefined || !isLocalPostgres) {
    throw new Error('owner-unreachable integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

// Base config; the age floor is 4h. ownerUnreachableThreshold is -1 so
// checkOwnerUnreachable ALWAYS returns a finding — the test reads the raw
// detail.count for delta assertions rather than testing the threshold gate
// (the mock-sql suite already covers the gate). checkZeroDeliveryNotifications
// has no threshold param and returns null at count 0, handled by its helper.
const PROBE_CFG: HealthAlertConfig = {
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
  backlogDepthThreshold: 1500,
  ownerUnreachableAgeS: 14400,
  ownerUnreachableThreshold: -1,
};

async function ownerUnreachableCount(): Promise<number> {
  const finding = await checkOwnerUnreachable(sql(), PROBE_CFG);
  return (finding?.detail.count as number | undefined) ?? 0;
}

async function zeroDeliveryCount(): Promise<number> {
  const finding = await checkZeroDeliveryNotifications(sql(), PROBE_CFG);
  return (finding?.detail.count as number | undefined) ?? 0;
}

// Seeds a review + response under a business. ageSeconds sets created_at into
// the past so the response can sit above (or below) the 4h age floor.
async function seedResponse(businessId: string, ageSeconds: number): Promise<string> {
  const reviewId = randomUUID();
  const responseId = randomUUID();
  const marker = randomUUID();
  await sql()`
    INSERT INTO reviews (
      id, business_id, provider, provider_review_id, provider_review_name,
      provider_location_name, reviewer_name, star_rating, review_text, status
    ) VALUES (
      ${reviewId}::uuid, ${businessId}::uuid, 'zernio',
      ${`ou-${marker}`}, ${`zernio://ou/reviews/${marker}`}, 'zernio://ou/locations/primary',
      'Owner Unreachable Reviewer', 5, 'Safe fixture review.', 'pending_approval'
    )
  `;
  await sql()`
    INSERT INTO responses (
      id, review_id, business_id, response_text, original_draft_text,
      version, status, created_at
    ) VALUES (
      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
      'Safe fixture reply.', 'Safe fixture reply.', 1, 'pending_approval',
      NOW() - make_interval(secs => ${ageSeconds})
    )
  `;
  return responseId;
}

// Inserts a completed send_notification outbox row for a response. createdAtOffsetS
// backdates created_at so a later row can supersede an earlier marker (latest-by-
// created_at-DESC). completionReason null = a plain completed send_notification.
async function seedCompletedSendNotification(
  responseId: string,
  completionReason: string | null,
  createdAtOffsetS: number,
): Promise<void> {
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status,
      completion_reason, completed_at, created_at
    ) VALUES (
      ${randomUUID()}::uuid, ${QUEUE_NAMES.SEND_NOTIFICATION}, 'response',
      ${responseId}::uuid, ${sql().json({ response_id: responseId })}, 'completed',
      ${completionReason}, NOW() - make_interval(secs => ${createdAtOffsetS}),
      NOW() - make_interval(secs => ${createdAtOffsetS})
    )
  `;
}

async function seedDelivery(
  businessId: string,
  responseId: string,
  template: string,
): Promise<void> {
  await sql()`
    INSERT INTO notification_deliveries (
      id, business_id, response_id, channel, recipient, template, sent_at
    ) VALUES (
      ${randomUUID()}::uuid, ${businessId}::uuid, ${responseId}::uuid,
      'email', 'owner@test.local', ${template}, NOW()
    )
  `;
}

async function clearSeededRows(): Promise<void> {
  for (const businessId of [liveBusinessId, archivedBusinessId]) {
    await sql()`
      DELETE FROM job_outbox
      WHERE aggregate_id IN (SELECT id FROM responses WHERE business_id = ${businessId}::uuid)
    `;
    await sql()`DELETE FROM notification_deliveries WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
  }
}

const AGED = 5 * 3600; // above the 4h floor
const FRESH = 60; // below the 4h floor
const OLD_MARKER = 7200; // older marker created_at
const NEW_COMPLETION = 60; // superseding completion created_at (more recent)

const registerSuite = testDatabaseUrl ? describe : describe.skip;

registerSuite('owner-unreachable health checks against live local Postgres', () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Owner Unreachable Integration Owner',
      accountDisplayName: 'Owner Unreachable Integration Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status, is_primary
      ) VALUES
        (${liveBusinessId}::uuid, 'OU Live', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', TRUE)
    `;
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status, is_primary, archived_at
      ) VALUES
        (${archivedBusinessId}::uuid, 'OU Archived', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', FALSE, NOW())
    `;
  }, 30_000);

  afterEach(async () => {
    await clearSeededRows();
  });

  afterAll(async () => {
    if (!db || !tenant) return;
    await clearSeededRows();
    await sql()`DELETE FROM businesses WHERE id IN (${liveBusinessId}::uuid, ${archivedBusinessId}::uuid)`;
    await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });

  it('counts an aged pending draft whose latest completed send_notification is owner_unreachable', async () => {
    const before = await ownerUnreachableCount();
    const responseId = await seedResponse(liveBusinessId, AGED);
    await seedCompletedSendNotification(responseId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, OLD_MARKER);
    expect(await ownerUnreachableCount()).toBe(before + 1);
  });

  it('still counts when only an admin-template delivery exists (no self-erase)', async () => {
    const before = await ownerUnreachableCount();
    const responseId = await seedResponse(liveBusinessId, AGED);
    await seedCompletedSendNotification(responseId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, OLD_MARKER);
    await seedDelivery(liveBusinessId, responseId, 'admin_notification_owner_unreachable');
    expect(await ownerUnreachableCount()).toBe(before + 1);
  });

  it('clears once a real approval_request delivery exists (self-clearing)', async () => {
    const before = await ownerUnreachableCount();
    const responseId = await seedResponse(liveBusinessId, AGED);
    await seedCompletedSendNotification(responseId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, OLD_MARKER);
    await seedDelivery(liveBusinessId, responseId, 'approval_request');
    expect(await ownerUnreachableCount()).toBe(before);
  });

  it('clears when a later NULL-reason completion supersedes the marker', async () => {
    const before = await ownerUnreachableCount();
    const responseId = await seedResponse(liveBusinessId, AGED);
    await seedCompletedSendNotification(responseId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, OLD_MARKER);
    await seedCompletedSendNotification(responseId, null, NEW_COMPLETION);
    expect(await ownerUnreachableCount()).toBe(before);
  });

  it('does not count below the age floor', async () => {
    const before = await ownerUnreachableCount();
    const responseId = await seedResponse(liveBusinessId, FRESH);
    await seedCompletedSendNotification(responseId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, OLD_MARKER);
    expect(await ownerUnreachableCount()).toBe(before);
  });

  it('does not count a draft on an archived business', async () => {
    const before = await ownerUnreachableCount();
    const responseId = await seedResponse(archivedBusinessId, AGED);
    await seedCompletedSendNotification(responseId, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, OLD_MARKER);
    expect(await ownerUnreachableCount()).toBe(before);
  });

  it('does not count when there is no completed send_notification marker', async () => {
    const before = await ownerUnreachableCount();
    await seedResponse(liveBusinessId, AGED); // aged pending, but no outbox marker at all
    expect(await ownerUnreachableCount()).toBe(before);
  });

  it('de-conflates zero-delivery: owner_unreachable-marked rows are excluded, unmarked zero-delivery rows are counted', async () => {
    // A marked owner-unreachable row must NOT inflate the zero-delivery signal.
    const beforeMarked = await zeroDeliveryCount();
    const markedResponse = await seedResponse(liveBusinessId, AGED);
    await seedCompletedSendNotification(markedResponse, OUTBOX_COMPLETION_REASON.OWNER_UNREACHABLE, NEW_COMPLETION);
    expect(await zeroDeliveryCount()).toBe(beforeMarked);

    // An unmarked completed send_notification with no delivery IS a zero-delivery.
    const before = await zeroDeliveryCount();
    const plainResponse = await seedResponse(liveBusinessId, AGED);
    await seedCompletedSendNotification(plainResponse, null, NEW_COMPLETION);
    expect(await zeroDeliveryCount()).toBe(before + 1);
  });
});
