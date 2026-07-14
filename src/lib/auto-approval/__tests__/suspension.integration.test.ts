import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { getAutoApprovalSettings, patchAutoApprovalSettings } from '../settings';
import {
  AUTONOMY_SUSPENSION_REASONS,
  listSuspendedPolicies,
  suspendAccountAutonomy,
  unsuspendAccountAutonomy,
} from '../suspension';

const LOCAL_TEST_DATABASE_URL = 'postgresql://test:test@localhost:5499/test_ws4';
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const primaryBusinessId = randomUUID();
const secondaryBusinessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('suspension integration database was not initialized');
  return db;
}

function requireTenant(): TenantSeed {
  if (!tenant) throw new Error('suspension integration tenant was not seeded');
  return tenant;
}

function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  if (databaseUrl !== LOCAL_TEST_DATABASE_URL) {
    throw new Error('suspension integration requires the exact local test_ws4 database');
  }
  return databaseUrl;
}

async function cleanTaskRows(): Promise<void> {
  const accountId = requireTenant().accountId;
  await sql()`
    DELETE FROM job_outbox
    WHERE topic IN (
      ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
      ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
    )
      AND payload->>'account_id' = ${accountId}
  `;
  await sql()`DELETE FROM account_audit_log WHERE account_id = ${accountId}::uuid`;
  await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${accountId}::uuid`;
}

async function suspend(trigger: 'judge_flag' | 'governor_edit_rate' = 'judge_flag') {
  const evidence = trigger === 'judge_flag'
    ? { verdict_id: randomUUID() } as const
    : { rate: 0.6, numer: 3, denom: 5, windowDays: 7 } as const;
  return sql().begin((tx) => suspendAccountAutonomy(tx, {
    accountId: requireTenant().accountId,
    trigger,
    suspensionEventId: randomUUID(),
    evidence,
  }));
}

describeWithDb('autonomy suspension against live local Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Suspension Integration Owner',
      accountDisplayName: 'Suspension Integration Account',
    });
    await db`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status, is_primary
      ) VALUES
        (${primaryBusinessId}::uuid, 'Suspension Primary', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', TRUE),
        (${secondaryBusinessId}::uuid, 'Suspension Secondary', 'Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active', FALSE)
    `;
  });

  beforeEach(async () => {
    await cleanTaskRows();
  });

  afterAll(async () => {
    if (!db || !tenant) return;
    await cleanTaskRows();
    await sql()`DELETE FROM businesses WHERE id IN (${primaryBusinessId}::uuid, ${secondaryBusinessId}::uuid)`;
    await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });

  it('creates a suspended account-default row plus one audit and both outboxes', async () => {
    await expect(suspend()).resolves.toEqual({ newlySuspended: true });

    const [policy] = await sql()<{
      auto_approve_min_star: number | null;
      suspended_at: Date | null;
      suspended_reason: string | null;
    }[]>`
      SELECT auto_approve_min_star, suspended_at, suspended_reason
      FROM auto_approval_policies
      WHERE account_id = ${requireTenant().accountId}::uuid
        AND location_id IS NULL
    `;
    expect(policy).toMatchObject({
      auto_approve_min_star: null,
      suspended_reason: AUTONOMY_SUSPENSION_REASONS.judge_flag,
    });
    expect(policy?.suspended_at).not.toBeNull();

    const [facts] = await sql()<{ audit_count: number; outbox_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM account_audit_log
         WHERE account_id = ${requireTenant().accountId}::uuid
           AND event_type = 'autonomy_suspended') AS audit_count,
        (SELECT COUNT(*)::int FROM job_outbox
         WHERE aggregate_id IN (
           SELECT (payload->>'suspension_event_id')::uuid
           FROM job_outbox
           WHERE payload->>'account_id' = ${requireTenant().accountId}
         )
           AND topic IN (
             ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
             ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
           )) AS outbox_count
    `;
    expect(facts).toEqual({ audit_count: 1, outbox_count: 2 });
  });

  it('projects the account suspension across every location including an override', async () => {
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${requireTenant().accountId}::uuid,
        ${secondaryBusinessId}::uuid,
        'reply',
        'posting',
        5
      )
    `;

    await suspend('governor_edit_rate');
    const settings = await getAutoApprovalSettings(sql(), {
      accountId: requireTenant().accountId,
      impersonated: false,
    });

    expect(settings.locations).toHaveLength(2);
    expect(settings.locations.every((location) => location.effective.suspended)).toBe(true);
    expect(settings.locations.find((location) => location.locationId === secondaryBusinessId))
      .toMatchObject({ effective: { source: 'location_override', threshold: 5, suspended: true } });
  });

  it('preserves manual mode through suspended clear and admin unsuspend', async () => {
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${requireTenant().accountId}::uuid,
        NULL,
        'reply',
        'posting',
        4
      )
    `;
    await suspend();

    const cleared = await patchAutoApprovalSettings(sql(), {
      accountId: requireTenant().accountId,
      actorUserId: requireTenant().userId,
      impersonated: false,
      operation: 'clear_account_default',
    });
    expect(cleared.accountDefault).toMatchObject({
      exists: true,
      threshold: null,
      suspended: true,
    });

    const unsuspended = await sql().begin((tx) => unsuspendAccountAutonomy(tx, {
      accountId: requireTenant().accountId,
      actorUserId: requireTenant().userId,
      note: 'Safety review completed.',
    }));
    expect(unsuspended).toEqual({ unsuspended: true, rearmed: false });

    const settings = await getAutoApprovalSettings(sql(), {
      accountId: requireTenant().accountId,
      impersonated: false,
    });
    expect(settings.accountDefault).toMatchObject({
      exists: true,
      threshold: null,
      suspended: false,
      suspendedReason: null,
    });
    expect(settings.locations.every((location) => !location.effective.suspended)).toBe(true);

    const [audit] = await sql()<{ previous_reason: string | null }[]>`
      SELECT payload->>'previous_reason' AS previous_reason
      FROM account_audit_log
      WHERE account_id = ${requireTenant().accountId}::uuid
        AND event_type = 'autonomy_unsuspended'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(audit?.previous_reason).toBe(AUTONOMY_SUSPENSION_REASONS.judge_flag);
  });

  it('returns only the newest five flags and tolerates non-array reasons JSONB', async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      reviewId: randomUUID(),
      responseId: randomUUID(),
      verdictId: randomUUID(),
      createdAt: new Date(Date.UTC(2026, 6, 13, 12, 0, index)),
    }));

    try {
      await suspend();
      await sql().begin(async (tx) => {
        for (const [index, row] of rows.entries()) {
          await tx`
            INSERT INTO reviews (
              id, business_id, provider, provider_review_id, provider_review_name,
              provider_location_name, reviewer_name, star_rating, review_text, status
            ) VALUES (
              ${row.reviewId}::uuid,
              ${primaryBusinessId}::uuid,
              'zernio',
              ${`suspension-flag-${row.reviewId}`},
              ${`zernio://suspension/reviews/${row.reviewId}`},
              'zernio://suspension/locations/primary',
              'Safety Reviewer',
              5,
              'Safe fixture review.',
              'posted'
            )
          `;
          await tx`
            INSERT INTO responses (
              id, review_id, business_id, response_text, original_draft_text,
              version, status, approval_method, posted_at
            ) VALUES (
              ${row.responseId}::uuid,
              ${row.reviewId}::uuid,
              ${primaryBusinessId}::uuid,
              'Safe fixture reply.',
              'Safe fixture reply.',
              1,
              'posted',
              'auto_policy',
              ${row.createdAt}
            )
          `;
          await tx`
            INSERT INTO judge_verdicts (
              id, account_id, business_id, review_id, response_id,
              verdict, reasons, rationale, model, prompt_version, created_at
            ) VALUES (
              ${row.verdictId}::uuid,
              ${requireTenant().accountId}::uuid,
              ${primaryBusinessId}::uuid,
              ${row.reviewId}::uuid,
              ${row.responseId}::uuid,
              'flag',
              ${tx.json(index === 6 ? { malformed: true } : ['fabricated_fact'])},
              'Enum-only fixture rationale.',
              'gpt-4o-mini-2024-07-18',
              '2026-07-13.1',
              ${row.createdAt}
            )
          `;
        }
      });

      const [suspension] = await listSuspendedPolicies(sql());
      expect(suspension?.recentFlagVerdicts.map((verdict) => verdict.id)).toEqual(
        rows.slice(2).reverse().map((row) => row.verdictId),
      );
      expect(suspension?.recentFlagVerdicts[0]?.reasons).toEqual([]);
    } finally {
      const responseIds = rows.map((row) => row.responseId);
      const reviewIds = rows.map((row) => row.reviewId);
      await sql()`DELETE FROM judge_verdicts WHERE response_id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM responses WHERE id = ANY(${responseIds}::uuid[])`;
      await sql()`DELETE FROM reviews WHERE id = ANY(${reviewIds}::uuid[])`;
    }
  });
});
