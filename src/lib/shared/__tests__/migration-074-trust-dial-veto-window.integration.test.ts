import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { cleanupTenantAccount, seedTenantAccount } from './live-db-tenant';
import {
  applyMigration074IfMissing,
  readMigration074Sql,
  withMigration074ApplyLock,
} from './helpers/apply-migration-074';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';

// Live-DB shape suite for migration 074 (WS4 trust dial + veto window, spec
// 2026-07-07-ws4-trust-dial-veto-window-design.md §2.1/§2.3/§2.7/§2.8).
// Mirrors migration-055-auto-approval-policy.integration.test.ts: every failure
// case asserts the SPECIFIC constraint/index by name so a test can never pass
// for the wrong reason. beforeAll applies the migration only if it isn't
// already on the shared test DB (avoids ACCESS EXCLUSIVE lock contention with
// parallel suites); the double-apply test proves re-runnability for real.
//
// Gated on TEST_DATABASE_POOL_URL; skips cleanly without one.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

const tenant = {
  userId: randomUUID(),
  accountId: randomUUID(),
  businessId: randomUUID(),
};
const ownerEmail = `ws4-074-${tenant.accountId}@test.local`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 074 integration database was not initialized');
  return db;
}

async function insertPolicy(
  locationId: string | null,
  minStar: number | null,
): Promise<string> {
  const id = uuidv7();
  await sql()`
    INSERT INTO auto_approval_policies (id, account_id, location_id, auto_approve_min_star)
    VALUES (${id}::uuid, ${tenant.accountId}::uuid, ${locationId}::uuid, ${minStar})
  `;
  return id;
}

async function insertOutcome(outcomeKind: string): Promise<string> {
  const id = uuidv7();
  await sql()`
    INSERT INTO agent_outcomes (id, account_id, business_id, attributed_agent, outcome_kind)
    VALUES (${id}::uuid, ${tenant.accountId}::uuid, ${tenant.businessId}::uuid, 'reply', ${outcomeKind})
  `;
  return id;
}

describeWithDb('migration 074 trust dial + veto window — shape', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // Guarded apply shared with the other 074-dependent suites; the guard's
    // rationale lives in helpers/apply-migration-074.ts. The double-apply
    // test below still re-applies unconditionally.
    await applyMigration074IfMissing(db);
    await seedTenantAccount(db, {
      userId: tenant.userId,
      accountId: tenant.accountId,
      ownerEmail,
      userName: 'WS4 074 Owner',
      accountDisplayName: 'WS4 074 Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${tenant.businessId}::uuid, 'WS4 074 Biz', 'WS4 074 Owner', ${ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
  });

  afterEach(async () => {
    if (!db) return;
    await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
    await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
  });

  afterAll(async () => {
    if (!db) return;
    await sql()`DELETE FROM businesses WHERE id = ${tenant.businessId}::uuid`;
    await cleanupTenantAccount(sql(), tenant);
    await db.end({ timeout: 5 });
  });

  it('auto_approval_policies has the six new columns with expected types/nullability/defaults', async () => {
    const columns = await sql()<
      { column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'auto_approval_policies'
        AND column_name IN (
          'persona', 'action_class', 'veto_window_minutes',
          'daily_auto_post_cap', 'suspended_at', 'suspended_reason'
        )
    `;
    const byName = new Map(columns.map((column) => [column.column_name, column]));

    expect(byName.get('persona')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName.get('persona')!.column_default).toContain('reply');
    expect(byName.get('action_class')).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(byName.get('action_class')!.column_default).toContain('posting');
    expect(byName.get('veto_window_minutes')).toMatchObject({
      data_type: 'smallint',
      is_nullable: 'NO',
      column_default: '15',
    });
    expect(byName.get('daily_auto_post_cap')).toMatchObject({
      data_type: 'smallint',
      is_nullable: 'YES',
      column_default: null,
    });
    expect(byName.get('suspended_at')).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    });
    expect(byName.get('suspended_reason')).toMatchObject({
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
    });
  });

  it('a bare policy insert lands on the reply/posting scope with the 15-minute window and no cap', async () => {
    const policyId = await insertPolicy(null, 5);
    const [row] = await sql()<
      {
        persona: string;
        action_class: string;
        veto_window_minutes: number;
        daily_auto_post_cap: number | null;
        suspended_at: Date | null;
        suspended_reason: string | null;
      }[]
    >`
      SELECT persona, action_class, veto_window_minutes, daily_auto_post_cap, suspended_at, suspended_reason
      FROM auto_approval_policies WHERE id = ${policyId}::uuid
    `;
    expect(row).toMatchObject({
      persona: 'reply',
      action_class: 'posting',
      veto_window_minutes: 15,
      daily_auto_post_cap: null,
      suspended_at: null,
      suspended_reason: null,
    });
  });

  it('auto_approve_min_star CHECK accepts 4/5/NULL and rejects 3 (positive quadrant)', async () => {
    await insertPolicy(null, 4);
    await insertPolicy(tenant.businessId, 5);
    await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
    await insertPolicy(null, null);

    await expect(insertPolicy(tenant.businessId, 3)).rejects.toThrow(
      /auto_approval_policies_auto_approve_min_star_check/,
    );
  });

  it('scope + dial CHECKs reject out-of-domain persona, action_class, veto window and cap values', async () => {
    const policyId = await insertPolicy(null, 5);

    await expect(
      sql()`UPDATE auto_approval_policies SET persona = 'solicitation' WHERE id = ${policyId}::uuid`,
    ).rejects.toThrow(/auto_approval_policies_persona_check/);
    await expect(
      sql()`UPDATE auto_approval_policies SET action_class = 'sending' WHERE id = ${policyId}::uuid`,
    ).rejects.toThrow(/auto_approval_policies_action_class_check/);
    await expect(
      sql()`UPDATE auto_approval_policies SET veto_window_minutes = 20 WHERE id = ${policyId}::uuid`,
    ).rejects.toThrow(/auto_approval_policies_veto_window_check/);
    await sql()`UPDATE auto_approval_policies SET veto_window_minutes = 30 WHERE id = ${policyId}::uuid`;
    await expect(
      sql()`UPDATE auto_approval_policies SET daily_auto_post_cap = 0 WHERE id = ${policyId}::uuid`,
    ).rejects.toThrow(/auto_approval_policies_daily_cap_check/);
    await expect(
      sql()`UPDATE auto_approval_policies SET daily_auto_post_cap = 51 WHERE id = ${policyId}::uuid`,
    ).rejects.toThrow(/auto_approval_policies_daily_cap_check/);
    await sql()`UPDATE auto_approval_policies SET daily_auto_post_cap = 50 WHERE id = ${policyId}::uuid`;
  });

  it('rebuilt partial unique indexes enforce one default / one override per (account, persona, action_class)', async () => {
    await insertPolicy(null, 4);
    await expect(insertPolicy(null, 5)).rejects.toThrow(
      /auto_approval_policies_one_account_default/,
    );

    await insertPolicy(tenant.businessId, 5);
    await expect(insertPolicy(tenant.businessId, 4)).rejects.toThrow(
      /auto_approval_policies_one_location_override/,
    );

    // persona/action_class are single-valued today (CHECK-locked), so index
    // membership of the new scope columns is asserted structurally.
    const indexes = await sql()<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'auto_approval_policies'
        AND indexname IN (
          'auto_approval_policies_one_account_default',
          'auto_approval_policies_one_location_override'
        )
      ORDER BY indexname
    `;
    expect(indexes).toHaveLength(2);
    expect(indexes[0]!.indexdef).toContain('(account_id, persona, action_class)');
    expect(indexes[0]!.indexdef).toContain('location_id IS NULL');
    expect(indexes[1]!.indexdef).toContain('(account_id, location_id, persona, action_class)');
    expect(indexes[1]!.indexdef).toContain('location_id IS NOT NULL');
  });

  it('agent_outcomes accepts reply_vetoed_by_owner and rejects unknown kinds', async () => {
    const outcomeId = await insertOutcome('reply_vetoed_by_owner');
    const [row] = await sql()<{ outcome_kind: string }[]>`
      SELECT outcome_kind FROM agent_outcomes WHERE id = ${outcomeId}::uuid
    `;
    expect(row?.outcome_kind).toBe('reply_vetoed_by_owner');

    await expect(insertOutcome('bogus_kind')).rejects.toThrow(
      /agent_outcomes_outcome_kind_check/,
    );
    // A pre-071 kind still passes: the CHECK swap is a strict superset.
    await insertOutcome('reply_posted');
  });

  it('responses.auto_post_scheduled_at exists as nullable timestamptz', async () => {
    const [column] = await sql()<
      { data_type: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'responses' AND column_name = 'auto_post_scheduled_at'
    `;
    expect(column).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
      column_default: null,
    });
  });

  it('both pending_post_notice partial unique indexes exist with their ON CONFLICT predicates', async () => {
    const [inflight] = await sql()<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'job_outbox' AND indexname = 'idx_jo_pending_post_notice_inflight'
    `;
    expect(inflight).toBeDefined();
    expect(inflight!.indexdef).toContain('UNIQUE');
    expect(inflight!.indexdef).toContain('(topic, aggregate_id)');
    expect(inflight!.indexdef).toContain("'pending_post_notice'");

    const [claim] = await sql()<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'notification_deliveries'
        AND indexname = 'notification_deliveries_pending_post_notice_claim'
    `;
    expect(claim).toBeDefined();
    expect(claim!.indexdef).toContain('UNIQUE');
    expect(claim!.indexdef).toContain('(response_id, channel, recipient)');
    expect(claim!.indexdef).toContain('response_id IS NOT NULL');
    expect(claim!.indexdef).toContain("'pending_post_notice'");
  });

  it('applying the migration a second time is a clean no-op', async () => {
    // The re-apply runs inside a transaction that is ALWAYS rolled back, and
    // the end-state assertions run inside it so they still observe the
    // twice-applied schema. Committing it would leave the shared test DB
    // BELOW head: 074 re-adds `agent_outcomes_outcome_kind_check` without
    // `solicitation_batch_built`, which migration 088 later widened — so a
    // committed re-apply silently reverts 088 for every suite that follows
    // (#573; it was masked while batch-builder re-applied 088 on every run).
    // The advisory lock still serializes the ACCESS EXCLUSIVE index rebuilds
    // against parallel DB suites.
    await withMigration074ApplyLock(sql(), async () => {
      await sql().unsafe('BEGIN');
      try {
        await expect(sql().unsafe(readMigration074Sql())).resolves.not.toThrow();

        // End state is identical: each rebuilt/new index exists exactly once,
        // on its expected table in the public schema.
        const [count] = await sql()<{ count: string }[]>`
          SELECT count(*)::text AS count FROM pg_indexes
          WHERE schemaname = 'public'
            AND (tablename, indexname) IN (
              ('auto_approval_policies', 'auto_approval_policies_one_account_default'),
              ('auto_approval_policies', 'auto_approval_policies_one_location_override'),
              ('job_outbox', 'idx_jo_pending_post_notice_inflight'),
              ('notification_deliveries', 'notification_deliveries_pending_post_notice_claim')
            )
        `;
        expect(count?.count).toBe('4');

        // The responses-side cap index was superseded by the audit-row count
        // (spec §6): the migration's guarded DROP must have removed it.
        const [supersededCapIndex] = await sql()<{ count: string }[]>`
          SELECT count(*)::text AS count FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'responses'
            AND indexname = 'idx_responses_auto_policy_daily_cap'
        `;
        expect(supersededCapIndex?.count).toBe('0');
      } finally {
        await sql().unsafe('ROLLBACK');
      }
    });
  });
});
