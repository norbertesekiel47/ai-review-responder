import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  listGovernorCandidates,
  revalidateGovernorCandidate,
  type GovernorBreach,
} from '@/lib/auto-approval/governor';
import {
  suspendAccountAutonomy,
  unsuspendAccountAutonomy,
} from '@/lib/auto-approval/suspension';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import {
  runAutonomyGovernorCycle,
  suspendGovernorCandidateIfCurrent,
} from '../AutonomyGovernorScheduler';

const LOCAL_TEST_DATABASE_URL = 'postgresql://test:test@localhost:5499/test_ws4';
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const reviewIds = Array.from({ length: 5 }, () => randomUUID());
const responseIds = Array.from({ length: 5 }, () => randomUUID());
const EDIT_RATE_BREACH: GovernorBreach = {
  trigger: 'governor_edit_rate',
  evidence: { rate: 0.6, numer: 3, denom: 5, windowDays: 7 },
};

interface FleetSeed {
  accountId: string;
  userId: string;
  ownerEmail: string;
}

const FLEET_SIZE = 51;
const FLEET_CURSOR_START = 'ffffffff-ffff-4fff-8ffe-ffffffffffff';

const fleetSeeds: FleetSeed[] = Array.from({ length: FLEET_SIZE }, (_, index) => {
  const suffix = String(index + 1).padStart(12, '0');
  return {
    accountId: `ffffffff-ffff-4fff-8fff-${suffix}`,
    userId: `eeeeeeee-eeee-4eee-8eee-${suffix}`,
    ownerEmail: `governor-fleet-${index + 1}@test.local`,
  };
});

function sql(): postgresType.Sql {
  if (!db) throw new Error('governor integration database was not initialized');
  return db;
}

function requireTenant(): TenantSeed {
  if (!tenant) throw new Error('governor integration tenant was not seeded');
  return tenant;
}

function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  if (databaseUrl !== LOCAL_TEST_DATABASE_URL) {
    throw new Error('governor integration requires the exact local test_ws4 database');
  }
  return databaseUrl;
}

async function cleanupGovernorRows(): Promise<void> {
  if (!tenant) return;
  await sql()`
    DELETE FROM job_outbox
    WHERE topic IN (
      ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
      ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
    )
      AND payload->>'account_id' = ${tenant.accountId}
  `;
  await sql()`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
  await sql()`DELETE FROM judge_verdicts WHERE account_id = ${tenant.accountId}::uuid`;
  await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
  await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
  await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
}

async function seedGovernorFleet(): Promise<void> {
  await sql().begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    for (const [index, seed] of fleetSeeds.entries()) {
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (
          ${seed.userId}::uuid,
          ${`Governor Fleet Owner ${index + 1}`},
          ${seed.ownerEmail},
          'owner',
          ${seed.accountId}::uuid
        )
      `;
      await tx`
        INSERT INTO accounts (
          id, owner_user_id, display_name, subscription_tier, subscription_status
        ) VALUES (
          ${seed.accountId}::uuid,
          ${seed.userId}::uuid,
          ${`Governor Fleet Account ${index + 1}`},
          'standard',
          'active'
        )
      `;
      await tx`
        INSERT INTO auto_approval_policies (
          id, account_id, location_id, persona, action_class, auto_approve_min_star
        ) VALUES (
          ${randomUUID()}::uuid,
          ${seed.accountId}::uuid,
          NULL,
          'reply',
          'posting',
          5
        )
      `;
    }
  });
}

async function cleanupGovernorFleet(): Promise<void> {
  const laterAccount = fleetSeeds.at(-1)!.accountId;
  await sql()`
    DELETE FROM job_outbox
    WHERE payload->>'account_id' = ${laterAccount}
  `;
  await sql().begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    for (const seed of fleetSeeds) {
      await tx`DELETE FROM account_audit_log WHERE account_id = ${seed.accountId}::uuid`;
      await tx`DELETE FROM agent_outcomes WHERE account_id = ${seed.accountId}::uuid`;
      await tx`DELETE FROM auto_approval_policies WHERE account_id = ${seed.accountId}::uuid`;
      await tx`DELETE FROM accounts WHERE id = ${seed.accountId}::uuid`;
      await tx`DELETE FROM users WHERE id = ${seed.userId}::uuid`;
    }
  });
}

describeWithDb('autonomy governor against live local Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Governor Integration Owner',
      accountDisplayName: 'Governor Integration Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (
        ${businessId}::uuid,
        'Governor Integration Business',
        'Governor Owner',
        ${tenant.ownerEmail},
        ${tenant.accountId}::uuid,
        'active'
      )
    `;
  });

  afterEach(() => {
    delete process.env.GOVERNOR_ENABLED;
  });

  afterAll(async () => {
    if (!db || !tenant) return;
    delete process.env.GOVERNOR_ENABLED;
    await cleanupGovernorRows();
    await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });

  it('includes override-only armed accounts and excludes unarmed or suspended-default accounts', async () => {
    const overrideOnly = requireTenant();
    const unarmed = await seedTenantAccount(sql(), {
      userName: 'Governor Unarmed Owner',
      accountDisplayName: 'Governor Unarmed Account',
    });
    const suspended = await seedTenantAccount(sql(), {
      userName: 'Governor Suspended Owner',
      accountDisplayName: 'Governor Suspended Account',
    });

    try {
      await cleanupGovernorRows();
      await sql()`
        INSERT INTO auto_approval_policies (
          id, account_id, location_id, persona, action_class, auto_approve_min_star
        ) VALUES
          (${randomUUID()}::uuid, ${overrideOnly.accountId}::uuid, ${businessId}::uuid,
           'reply', 'posting', 5),
          (${randomUUID()}::uuid, ${unarmed.accountId}::uuid, NULL,
           'reply', 'posting', NULL),
          (${randomUUID()}::uuid, ${suspended.accountId}::uuid, NULL,
           'reply', 'posting', 5)
      `;
      await sql()`
        UPDATE auto_approval_policies
        SET suspended_at = NOW(), suspended_reason = 'test suspension'
        WHERE account_id = ${suspended.accountId}::uuid
          AND location_id IS NULL
      `;

      const candidates = await listGovernorCandidates(sql(), 100);
      const candidateIds = new Set(candidates.map((candidate) => candidate.account_id));

      expect(candidateIds.has(overrideOnly.accountId)).toBe(true);
      expect(candidateIds.has(unarmed.accountId)).toBe(false);
      expect(candidateIds.has(suspended.accountId)).toBe(false);
    } finally {
      await sql()`
        DELETE FROM auto_approval_policies
        WHERE account_id IN (
          ${unarmed.accountId}::uuid,
          ${suspended.accountId}::uuid
        )
      `;
      await cleanupGovernorRows();
      await cleanupTenantAccount(sql(), unarmed);
      await cleanupTenantAccount(sql(), suspended);
    }
  });

  it('rotates a bounded page so account 51 is evaluated and suspended on the next cycle', async () => {
    const laterAccount = fleetSeeds.at(-1)!.accountId;
    await cleanupGovernorFleet();
    await seedGovernorFleet();

    try {
      await sql()`
        INSERT INTO agent_outcomes (
          id, account_id, business_id, attributed_agent, outcome_kind, unit_count
        ) VALUES
          (${randomUUID()}::uuid, ${laterAccount}::uuid, NULL,
           'reply', 'reply_edited_by_owner', 3),
          (${randomUUID()}::uuid, ${laterAccount}::uuid, NULL,
           'reply', 'reply_approved_no_edit', 2)
      `;

      process.env.GOVERNOR_ENABLED = 'true';
      const cursor = { afterAccountId: FLEET_CURSOR_START };
      await runAutonomyGovernorCycle(sql(), cursor);

      const [beforeWrap] = await sql()<[{ suspended: boolean }]>`
        SELECT suspended_at IS NOT NULL AS suspended
        FROM auto_approval_policies
        WHERE account_id = ${laterAccount}::uuid
          AND location_id IS NULL
      `;
      expect(beforeWrap?.suspended).toBe(false);
      expect(cursor.afterAccountId).toBe(fleetSeeds[49]!.accountId);

      await runAutonomyGovernorCycle(sql(), cursor);

      const [afterWrap] = await sql()<{
        suspended: boolean;
        audit_count: number;
        outbox_count: number;
      }[]>`
        SELECT
          suspended_at IS NOT NULL AS suspended,
          (SELECT COUNT(*)::int FROM account_audit_log
           WHERE account_id = ${laterAccount}::uuid
             AND event_type = 'autonomy_suspended') AS audit_count,
          (SELECT COUNT(*)::int FROM job_outbox
           WHERE payload->>'account_id' = ${laterAccount}
             AND topic IN (
               ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
               ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
             )) AS outbox_count
        FROM auto_approval_policies
        WHERE account_id = ${laterAccount}::uuid
          AND location_id IS NULL
      `;
      expect(afterWrap).toEqual({ suspended: true, audit_count: 1, outbox_count: 2 });
    } finally {
      await cleanupGovernorFleet();
    }
  });

  it('does not suspend or emit facts when the account disarms after the scan', async () => {
    const seeded = requireTenant();
    await cleanupGovernorRows();
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${seeded.accountId}::uuid,
        NULL,
        'reply',
        'posting',
        5
      )
    `;
    const candidates = await listGovernorCandidates(sql(), 100);
    const candidate = candidates.find((item) => item.account_id === seeded.accountId);
    expect(candidate).toBeDefined();

    await sql()`
      UPDATE auto_approval_policies
      SET auto_approve_min_star = NULL, updated_at = NOW()
      WHERE account_id = ${seeded.accountId}::uuid
        AND location_id IS NULL
    `;

    await expect(suspendGovernorCandidateIfCurrent(
      sql(),
      candidate!,
      EDIT_RATE_BREACH,
    )).resolves.toBe(false);

    const [facts] = await sql()<{
      suspended: boolean;
      audit_count: number;
      outbox_count: number;
    }[]>`
      SELECT
        suspended_at IS NOT NULL AS suspended,
        (SELECT COUNT(*)::int FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended') AS audit_count,
        (SELECT COUNT(*)::int FROM job_outbox
         WHERE payload->>'account_id' = ${seeded.accountId}) AS outbox_count
      FROM auto_approval_policies
      WHERE account_id = ${seeded.accountId}::uuid
        AND location_id IS NULL
    `;
    expect(facts).toEqual({ suspended: false, audit_count: 0, outbox_count: 0 });
  });

  it('does not re-suspend from a stale scan after another suspension is admin-unsuspended', async () => {
    const seeded = requireTenant();
    await cleanupGovernorRows();
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${seeded.accountId}::uuid,
        NULL,
        'reply',
        'posting',
        5
      )
    `;
    const candidates = await listGovernorCandidates(sql(), 100);
    const staleCandidate = candidates.find((item) => item.account_id === seeded.accountId);
    expect(staleCandidate).toBeDefined();

    await sql().begin((tx) => suspendAccountAutonomy(tx, {
      accountId: seeded.accountId,
      trigger: EDIT_RATE_BREACH.trigger,
      suspensionEventId: randomUUID(),
      evidence: EDIT_RATE_BREACH.evidence,
    }));
    await sql().begin((tx) => unsuspendAccountAutonomy(tx, {
      accountId: seeded.accountId,
      actorUserId: seeded.userId,
      note: 'race-test unsuspend',
    }));

    await expect(suspendGovernorCandidateIfCurrent(
      sql(),
      staleCandidate!,
      EDIT_RATE_BREACH,
    )).resolves.toBe(false);

    const [facts] = await sql()<{
      suspended: boolean;
      suspension_audits: number;
      unsuspend_audits: number;
      outbox_count: number;
    }[]>`
      SELECT
        suspended_at IS NOT NULL AS suspended,
        (SELECT COUNT(*)::int FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended') AS suspension_audits,
        (SELECT COUNT(*)::int FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_unsuspended') AS unsuspend_audits,
        (SELECT COUNT(*)::int FROM job_outbox
         WHERE payload->>'account_id' = ${seeded.accountId}) AS outbox_count
      FROM auto_approval_policies
      WHERE account_id = ${seeded.accountId}::uuid
        AND location_id IS NULL
    `;
    expect(facts).toEqual({
      suspended: false,
      suspension_audits: 1,
      unsuspend_audits: 1,
      outbox_count: 2,
    });
  });

  it('serializes the override-only gap so suspend and admin unsuspend cannot cross governor revalidation', async () => {
    const seeded = requireTenant();
    await cleanupGovernorRows();
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${seeded.accountId}::uuid,
        ${businessId}::uuid,
        'reply',
        'posting',
        5
      )
    `;
    const candidates = await listGovernorCandidates(sql(), 100);
    const candidate = candidates.find((item) => item.account_id === seeded.accountId);
    expect(candidate).toBeDefined();

    const contender = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), {
      max: 1,
      prepare: false,
    });
    let releaseGovernor!: () => void;
    let reportGovernorLocked!: () => void;
    const governorRelease = new Promise<void>((resolve) => {
      releaseGovernor = resolve;
    });
    const governorLocked = new Promise<void>((resolve) => {
      reportGovernorLocked = resolve;
    });
    const governorRun = sql().begin(async (tx) => {
      const current = await revalidateGovernorCandidate(
        tx,
        seeded.accountId,
        candidate!.window_start,
      );
      expect(current).toBe(true);
      reportGovernorLocked();
      await governorRelease;
      return suspendAccountAutonomy(tx, {
        accountId: seeded.accountId,
        trigger: EDIT_RATE_BREACH.trigger,
        suspensionEventId: randomUUID(),
        evidence: EDIT_RATE_BREACH.evidence,
      });
    });
    const governorOutcome = governorRun.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    let governorReleased = false;
    const releaseGovernorOnce = () => {
      if (governorReleased) return;
      governorReleased = true;
      releaseGovernor();
    };
    let primaryFailure: unknown;
    try {
      const readiness = await Promise.race([
        governorLocked.then(() => ({ status: 'locked' as const })),
        governorOutcome.then((outcome) => ({ status: 'settled' as const, outcome })),
      ]);
      if (readiness.status === 'settled') {
        if (readiness.outcome.status === 'rejected') throw readiness.outcome.reason;
        throw new Error('governor transaction settled before reporting its account lock');
      }

      await expect(contender.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        return suspendAccountAutonomy(tx, {
          accountId: seeded.accountId,
          trigger: 'judge_flag',
          suspensionEventId: randomUUID(),
          evidence: { verdict_id: randomUUID() },
        });
      })).rejects.toMatchObject({ code: '55P03' });
      await expect(contender.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        return unsuspendAccountAutonomy(tx, {
          accountId: seeded.accountId,
          actorUserId: seeded.userId,
          note: 'must wait for governor serialization',
        });
      })).rejects.toMatchObject({ code: '55P03' });

      releaseGovernorOnce();
      const completedGovernor = await governorOutcome;
      if (completedGovernor.status === 'rejected') throw completedGovernor.reason;
      expect(completedGovernor.value).toEqual({ newlySuspended: true });
      await expect(contender.begin((tx) => unsuspendAccountAutonomy(tx, {
        accountId: seeded.accountId,
        actorUserId: seeded.userId,
        note: 'serialized after governor commit',
      }))).resolves.toEqual({ unsuspended: true, rearmed: false });

      const [facts] = await sql()<{
        suspended: boolean;
        suspension_audits: number;
        unsuspend_audits: number;
        outbox_count: number;
      }[]>`
        SELECT
          suspended_at IS NOT NULL AS suspended,
          (SELECT COUNT(*)::int FROM account_audit_log
           WHERE account_id = ${seeded.accountId}::uuid
             AND event_type = 'autonomy_suspended') AS suspension_audits,
          (SELECT COUNT(*)::int FROM account_audit_log
           WHERE account_id = ${seeded.accountId}::uuid
             AND event_type = 'autonomy_unsuspended') AS unsuspend_audits,
          (SELECT COUNT(*)::int FROM job_outbox
           WHERE payload->>'account_id' = ${seeded.accountId}) AS outbox_count
        FROM auto_approval_policies
        WHERE account_id = ${seeded.accountId}::uuid
          AND location_id IS NULL
      `;
      expect(facts).toEqual({
        suspended: false,
        suspension_audits: 1,
        unsuspend_audits: 1,
        outbox_count: 2,
      });
    } catch (error: unknown) {
      primaryFailure = error;
      throw error;
    } finally {
      releaseGovernorOnce();
      await governorOutcome;
      try {
        await contender.end({ timeout: 5 });
      } catch (closeError: unknown) {
        if (primaryFailure === undefined) throw closeError;
      }
    }
  });

  it('suspends once with audit and two outboxes when the rolling judge rate breaches', async () => {
    const seeded = requireTenant();
    await cleanupGovernorRows();
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class, auto_approve_min_star
      ) VALUES (
        ${randomUUID()}::uuid,
        ${seeded.accountId}::uuid,
        NULL,
        'reply',
        'posting',
        5
      )
    `;
    await sql()`
      INSERT INTO agent_outcomes (
        id, account_id, business_id, attributed_agent, outcome_kind, unit_count
      ) VALUES
        (${randomUUID()}::uuid, ${seeded.accountId}::uuid, ${businessId}::uuid,
         'reply', 'reply_approved_no_edit', 5),
        (${randomUUID()}::uuid, ${seeded.accountId}::uuid, ${businessId}::uuid,
         'reply', 'reply_auto_posted', 5)
    `;

    for (let index = 0; index < reviewIds.length; index++) {
      const reviewId = reviewIds[index]!;
      const responseId = responseIds[index]!;
      await sql()`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id, provider_review_name,
          provider_location_name, reviewer_name, star_rating, review_text, status
        ) VALUES (
          ${reviewId}::uuid,
          ${businessId}::uuid,
          'zernio',
          ${`governor-${reviewId}`},
          ${`zernio://governor/reviews/${reviewId}`},
          'zernio://governor/location',
          'Governor Reviewer',
          5,
          'Safe integration fixture.',
          'posted'
        )
      `;
      await sql()`
        INSERT INTO responses (
          id, review_id, business_id, response_text, original_draft_text,
          version, status, approval_method, posted_at
        ) VALUES (
          ${responseId}::uuid,
          ${reviewId}::uuid,
          ${businessId}::uuid,
          'Thank you.',
          'Thank you.',
          1,
          'posted',
          'auto_policy',
          NOW()
        )
      `;
      await sql()`
        INSERT INTO judge_verdicts (
          id, account_id, business_id, review_id, response_id, verdict,
          reasons, rationale, model, prompt_version
        ) VALUES (
          ${randomUUID()}::uuid,
          ${seeded.accountId}::uuid,
          ${businessId}::uuid,
          ${reviewId}::uuid,
          ${responseId}::uuid,
          ${index < 2 ? 'warn' : 'pass'},
          '[]'::jsonb,
          NULL,
          'gpt-4o-mini-2024-07-18',
          '2026-07-13.1'
        )
      `;
    }

    process.env.GOVERNOR_ENABLED = 'true';
    await runAutonomyGovernorCycle(sql());
    await runAutonomyGovernorCycle(sql());

    const [facts] = await sql()<{
      suspended: boolean;
      audit_count: number;
      outbox_count: number;
      trigger: string | null;
      rate: number | null;
      numer: number | null;
      denom: number | null;
    }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM auto_approval_policies
          WHERE account_id = ${seeded.accountId}::uuid
            AND location_id IS NULL
            AND suspended_at IS NOT NULL
        ) AS suspended,
        (SELECT COUNT(*)::int FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended') AS audit_count,
        (SELECT COUNT(*)::int FROM job_outbox
         WHERE payload->>'account_id' = ${seeded.accountId}
           AND topic IN (
             ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
             ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT}
           )) AS outbox_count,
        (SELECT payload->>'trigger' FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended' LIMIT 1) AS trigger,
        (SELECT (payload->'evidence'->>'rate')::float FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended' LIMIT 1) AS rate,
        (SELECT (payload->'evidence'->>'numer')::int FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended' LIMIT 1) AS numer,
        (SELECT (payload->'evidence'->>'denom')::int FROM account_audit_log
         WHERE account_id = ${seeded.accountId}::uuid
           AND event_type = 'autonomy_suspended' LIMIT 1) AS denom
    `;

    expect(facts).toEqual({
      suspended: true,
      audit_count: 1,
      outbox_count: 2,
      trigger: 'governor_judge_signal_rate',
      rate: 0.4,
      numer: 2,
      denom: 5,
    });
  });
});
