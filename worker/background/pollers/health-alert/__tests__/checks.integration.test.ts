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
  assertSchemaReady,
  MIGRATION_071_RUN_SPINE,
  MIGRATION_083_OUTBOX_OWNER_UNREACHABLE,
  MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { startOrGetActiveRun } from '@/lib/agents/run-spine';
import {
  checkOwnerUnreachable,
  checkStalledSendBatches,
  checkStrandedAccountOffboardings,
  checkZeroDeliveryNotifications,
  STRANDED_OFFBOARDING_FINDING_PREFIX,
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
  // Wedge check has its own live suite (wedge-check.integration.test.ts); the
  // defaults here just keep it quiet for the other probes.
  wedgedClientReadAgeS: 10,
  wedgedClientReadThreshold: 0,
  pendingAgeThresholdS: 900,
  failedWindowS: 3600,
  failedThreshold: 0,
  staleDispatchingThresholdS: 600,
  flaggedOpenThreshold: 5,
  zeroDeliveryWindowS: 3600,
  backlogDepthThreshold: 1500,
  ownerUnreachableAgeS: 14400,
  ownerUnreachableThreshold: -1,
  staleIgnoredWindowS: 3600,
  staleIgnoredThreshold: 5,
};

async function ownerUnreachableCount(): Promise<number> {
  const finding = await checkOwnerUnreachable(sql(), PROBE_CFG);
  return (finding?.detail.count as number | undefined) ?? 0;
}

// checkStalledSendBatches scans agent_runs GLOBALLY (it has no tenant filter by
// design), so these assertions are DELTAS around a baseline rather than absolute
// counts or a bare null — a sibling live-DB suite in a concurrent vitest process
// may legitimately hold send-batch runs of its own.
async function stalledSendBatchCount(): Promise<number> {
  const finding = await checkStalledSendBatches(sql());
  return (finding?.detail.count as number | undefined) ?? 0;
}

// Seeds a send-batch parent run through the REAL spine writer, so this test also
// proves the kind the probe's predicate matches is the kind the writer produces
// — the one thing a mocked `sql` can never tell us. The age is applied in SQL
// (NOW() - make_interval), never by passing a JS Date back in: postgres.js
// truncates timestamptz microseconds to millisecond precision, so a JS-Date-seeded
// fixture carries zero µs and cannot exercise the threshold boundary honestly.
async function seedSendBatchRun(ageDays: number): Promise<string> {
  const seed = tenant;
  if (!seed) throw new Error('stalled send-batch fixture requires a seeded tenant');
  let runId = '';
  await sql().begin(async (tx) => {
    const started = await startOrGetActiveRun(tx, {
      kind: 'solicitation_send_batch',
      subjectType: 'solicitation_batch',
      subjectId: randomUUID(),
      accountId: seed.accountId,
      businessId: liveBusinessId,
    });
    runId = started.runId;
  });
  await sql()`
    UPDATE agent_runs
    SET started_at = NOW() - make_interval(days => ${ageDays})
    WHERE id = ${runId}::uuid
  `;
  return runId;
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

// #1413 path 3 fixture: an offboarding beside its outbox rows. The finding is
// keyed by the offboarding id, so a sibling live-DB suite's rows can never
// collide with these assertions; the delete below is by that id too.
const strandedOffboardingId = randomUUID();

async function seedStrandedOffboarding(status: string): Promise<void> {
  const seed = tenant;
  if (!seed) throw new Error('stranded offboarding fixture requires a seeded tenant');
  // `account_offboardings_failed_step_check`: a `failed` row must name its step.
  const failedStep = status === 'failed' ? 'purge' : null;
  await sql()`
    INSERT INTO account_offboardings (
      id, account_id, mode, status, failed_step, purge_after, teardown_completed_at,
      purge_started_at, location_ids, recipient_email
    ) VALUES (
      ${strandedOffboardingId}::uuid, ${seed.accountId}::uuid, 'delete_data', ${status}, ${failedStep},
      NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour',
      ${[liveBusinessId]}::uuid[], ${seed.ownerEmail}
    )
  `;
}

async function seedOffboardingOutboxRow(
  topic: string,
  status: 'failed' | 'pending' | 'completed',
  ageMinutes: number,
): Promise<string> {
  const outboxId = randomUUID();
  await sql()`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, status, attempts, max_attempts,
      last_error, completed_at, created_at
    ) VALUES (
      ${outboxId}::uuid, ${topic}, 'account_offboarding', ${strandedOffboardingId}::uuid,
      ${sql().json({ account_offboarding_id: strandedOffboardingId })}, ${status}, 5, 5,
      ${status === 'failed' ? 'Stale dispatched entry exceeded max_attempts' : null},
      ${status === 'pending' ? null : sql()`NOW()`},
      NOW() - make_interval(mins => ${ageMinutes})
    )
  `;
  return outboxId;
}

async function strandedFindingKeys(): Promise<string[]> {
  const findings = await checkStrandedAccountOffboardings(sql());
  return findings.map((f) => f.key).filter((k) => k.endsWith(strandedOffboardingId));
}

async function clearSeededRows(): Promise<void> {
  await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${strandedOffboardingId}::uuid`;
  await sql()`DELETE FROM account_offboardings WHERE id = ${strandedOffboardingId}::uuid`;
  await sql()`DELETE FROM agent_runs WHERE business_id IN (${liveBusinessId}::uuid, ${archivedBusinessId}::uuid)`;
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

// The probe fires one day past a send batch's ≤10-day construction bound.
const STALLED_SEND_BATCH_DAYS = 12; // past the 11-day threshold
const LIVE_SEND_BATCH_DAYS = 9; // inside it — a legitimately long-lived batch

const registerSuite = testDatabaseUrl ? describe : describe.skip;

registerSuite('owner-unreachable health checks against live local Postgres', () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    // Assert, never apply (#573): agent_runs itself (071), the 091 widening that
    // makes 'solicitation_send_batch' a legal kind, and 083's
    // job_outbox.completion_reason that the owner-unreachable check reads. A DB
    // behind head fails loudly here instead of as a mystifying CHECK violation
    // or undefined-column error in the fixture.
    await assertSchemaReady(db, [
      MIGRATION_071_RUN_SPINE,
      MIGRATION_091_SEND_MODE_SPINE_LIFECYCLE,
      MIGRATION_083_OUTBOX_OWNER_UNREACHABLE,
    ]);
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

  it('counts a real solicitation_send_batch run seeded past the 11-day threshold', async () => {
    const before = await stalledSendBatchCount();
    await seedSendBatchRun(STALLED_SEND_BATCH_DAYS);

    const finding = await checkStalledSendBatches(sql());

    expect(finding?.detail.count).toBe(before + 1);
    // MAX(age) over the matched set, so the seeded 12-day run puts a hard floor
    // under it regardless of what a concurrent sibling suite may also hold.
    expect(finding?.detail.oldest_age_s as number).toBeGreaterThanOrEqual(
      STALLED_SEND_BATCH_DAYS * 86_400 - 60,
    );
    expect(finding?.detail.oldest_run_id).toEqual(expect.any(String));
  });

  it('does not count a send batch still inside the 11-day threshold', async () => {
    const before = await stalledSendBatchCount();
    await seedSendBatchRun(LIVE_SEND_BATCH_DAYS);
    expect(await stalledSendBatchCount()).toBe(before);
  });

  it('does not count a send batch that already terminalized', async () => {
    const before = await stalledSendBatchCount();
    const runId = await seedSendBatchRun(STALLED_SEND_BATCH_DAYS);
    await sql()`
      UPDATE agent_runs SET status = 'completed', ended_at = NOW() WHERE id = ${runId}::uuid
    `;
    expect(await stalledSendBatchCount()).toBe(before);
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
  // ── #1413 path 3: a watchdog-terminalized offboarding row names its offboarding ──
  //
  // Real-Postgres coverage for the JOIN and the newest-row `NOT EXISTS`, which a
  // mocked `sql` can never prove. The finding key carries the offboarding id, so
  // the assertions are exact rather than deltas.

  it('names an offboarding whose newest purge outbox row failed while the offboarding was left purge_scheduled', async () => {
    await seedStrandedOffboarding('purge_scheduled');
    const outboxId = await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE, 'failed', 30);

    const findings = await checkStrandedAccountOffboardings(sql());
    const finding = findings.find((f) => f.key === `${STRANDED_OFFBOARDING_FINDING_PREFIX}:${strandedOffboardingId}`);

    expect(finding).toBeDefined();
    expect(finding?.level).toBe('error');
    expect(finding?.title).toContain(strandedOffboardingId);
    expect(finding?.detail).toEqual({
      account_offboarding_id: strandedOffboardingId,
      account_id: tenant?.accountId,
      topic: QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE,
      outbox_id: outboxId,
      offboarding_status: 'purge_scheduled',
      last_error: 'Stale dispatched entry exceeded max_attempts',
    });
  });

  it('stays quiet when the handler itself marked the offboarding failed (rules 16-18 already paged)', async () => {
    await seedStrandedOffboarding('failed');
    await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE, 'failed', 30);

    expect(await strandedFindingKeys()).toEqual([]);
  });

  it('stays quiet once a NEWER row for the same topic supersedes the failed one (a re-drive is in flight)', async () => {
    await seedStrandedOffboarding('tearing_down');
    await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN, 'failed', 30);
    expect(await strandedFindingKeys()).toHaveLength(1);

    await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN, 'pending', 1);

    expect(await strandedFindingKeys()).toEqual([]);
  });

  it('ignores a completed row and a failed row of another topic than the one it supersedes', async () => {
    await seedStrandedOffboarding('purge_scheduled');
    await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN, 'completed', 60);
    expect(await strandedFindingKeys()).toEqual([]);

    // A failed TEARDOWN row is not superseded by a newer PURGE row: the
    // newest-row guard is per topic.
    await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN, 'failed', 30);
    await seedOffboardingOutboxRow(QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE, 'pending', 1);
    expect(await strandedFindingKeys()).toHaveLength(1);
  });

});
