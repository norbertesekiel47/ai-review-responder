import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  cleanupTenantAccount,
  seedTenantAccount,
} from '@/lib/shared/__tests__/live-db-tenant';
import { applyMigration074IfMissing } from '@/lib/shared/__tests__/helpers/apply-migration-074';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { resetServerConfigForTests } from '@/lib/config/server';
import { patchAutoApprovalSettings } from '../settings';
import { POLICY_ACTION_POSTING, POLICY_PERSONA_REPLY } from '../types';

// Live-DB suite for the WS4 Task 12 settings writers: migration 074 rebuilt
// the two partial unique indexes on auto_approval_policies to include
// (persona, action_class), which broke the previous upserts' ON CONFLICT
// inference (documented apply-window breakage in 074's header). These tests
// run the REAL upserts against the rebuilt indexes — insert AND the
// DO UPDATE conflict path for both scopes — proving the breakage is over.
//
// Gated on TEST_DATABASE_POOL_URL; skips cleanly without one.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;

const tenant = {
  userId: randomUUID(),
  accountId: randomUUID(),
  businessId: randomUUID(),
};
const ownerEmail = `ws4-settings-${tenant.accountId}@test.local`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('settings integration database was not initialized');
  return db;
}

function patch(
  input: Parameters<typeof patchAutoApprovalSettings>[1],
): ReturnType<typeof patchAutoApprovalSettings> {
  return patchAutoApprovalSettings(sql(), input);
}

const actor = {
  accountId: tenant.accountId,
  actorUserId: null,
  impersonated: false,
} as const;

describeWithDb('auto-approval settings writers — live upserts against the 074 indexes', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    vi.stubEnv('AUTOPILOT_PURCHASABLE', 'true');
    vi.stubEnv('OPENAI_MODERATION_ENABLED', 'true');
    vi.stubEnv('AUTO_APPROVAL_PROVIDER_MODERATION_READY', 'true');
    vi.stubEnv('VERCEL_TARGET_ENV', 'test');
    resetServerConfigForTests();
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await applyMigration074IfMissing(db);
    await seedTenantAccount(db, {
      userId: tenant.userId,
      accountId: tenant.accountId,
      ownerEmail,
      userName: 'WS4 Settings Owner',
      accountDisplayName: 'WS4 Settings Account',
      subscriptionTier: 'autopilot',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (${tenant.businessId}::uuid, 'WS4 Settings Biz', 'WS4 Settings Owner', ${ownerEmail}, ${tenant.accountId}::uuid, 'active')
    `;
  });

  afterAll(async () => {
    try {
      if (!db) return;
      await sql()`DELETE FROM auto_approval_policies WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM account_audit_log WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${tenant.businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
      await db.end({ timeout: 5 });
    } finally {
      vi.unstubAllEnvs();
      resetServerConfigForTests();
    }
  });

  it('account-default upserts insert then conflict-update against the rebuilt index', async () => {
    // Fresh insert via a dial op: creates the row with a NULL threshold.
    const afterCap = await patch({
      ...actor,
      operation: 'set_account_daily_cap',
      cap: 25,
      confirmationLevel: 'standard',
    });
    expect(afterCap.accountDefault).toMatchObject({
      exists: true,
      threshold: null,
      dailyAutoPostCap: 25,
      effectiveDailyCap: 25,
    });

    // Second upsert MUST take the ON CONFLICT DO UPDATE path of
    // auto_approval_policies_one_account_default — a mismatched conflict
    // target would fail with a no-matching-constraint error, a missed match
    // would violate the unique index instead of updating.
    const afterVeto = await patch({ ...actor, operation: 'set_account_veto_window', minutes: 30 });
    expect(afterVeto.accountDefault).toMatchObject({
      policyId: afterCap.accountDefault.policyId,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 25,
      threshold: null,
    });

    const [row] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
    `;
    expect(row?.count).toBe(1);
  });

  it('location-override upserts insert then conflict-update against the rebuilt index', async () => {
    const afterVeto = await patch({
      ...actor,
      operation: 'set_location_veto_window',
      locationId: tenant.businessId,
      minutes: 30,
    });
    const created = afterVeto.locations.find((entry) => entry.locationId === tenant.businessId);
    expect(created?.override).toMatchObject({
      exists: true,
      threshold: null,
      vetoWindowMinutes: 30,
    });

    // Conflict path of auto_approval_policies_one_location_override.
    const afterCap = await patch({
      ...actor,
      operation: 'set_location_daily_cap',
      locationId: tenant.businessId,
      cap: 5,
    });
    const updated = afterCap.locations.find((entry) => entry.locationId === tenant.businessId);
    expect(updated?.override).toMatchObject({
      policyId: created?.override.policyId,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 5,
      effectiveDailyCap: 5,
    });

    const [row] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${tenant.businessId}::uuid
    `;
    expect(row?.count).toBe(1);
  });

  it('threshold upserts hit the same rows without clobbering the dial values', async () => {
    const afterManual = await patch({ ...actor, operation: 'set_account_manual' });
    expect(afterManual.accountDefault).toMatchObject({
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 25,
    });

    const afterLocationManual = await patch({
      ...actor,
      operation: 'set_location_manual',
      locationId: tenant.businessId,
    });
    const override = afterLocationManual.locations.find(
      (entry) => entry.locationId === tenant.businessId,
    )?.override;
    expect(override).toMatchObject({
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 5,
    });
  });

  it('clear on a suspended account default preserves the row; unsuspended clear deletes it', async () => {
    // Governor-owned suspension survives a clear (finding-1 fix): the clear
    // degrades to a threshold-NULL UPDATE, keeping suspended_at and the dials.
    await sql()`
      UPDATE auto_approval_policies
      SET suspended_at = NOW(), suspended_reason = 'governor_negative_feedback'
      WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
    `;

    const cleared = await patch({ ...actor, operation: 'clear_account_default' });
    expect(cleared.accountDefault).toMatchObject({
      exists: true,
      threshold: null,
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 25,
      suspended: true,
      suspendedReason: 'governor_negative_feedback',
    });

    const [row] = await sql()<{ suspended_at: Date | null }[]>`
      SELECT suspended_at FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
    `;
    expect(row?.suspended_at).not.toBeNull();

    // Lift the suspension: the clear reverts to today's DELETE semantics.
    await sql()`
      UPDATE auto_approval_policies
      SET suspended_at = NULL, suspended_reason = NULL
      WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
    `;
    const deleted = await patch({
      ...actor,
      operation: 'clear_account_default',
      confirmationLevel: 'standard',
    });
    expect(deleted.accountDefault).toMatchObject({ exists: false });

    const [count] = await sql()<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
    `;
    expect(count?.count).toBe(0);
  });

  it('gates NULL-to-50 for Copilot but permits NULL-to-1 and projects the contraction', async () => {
    await sql()`
      UPDATE accounts
      SET subscription_tier = 'copilot'
      WHERE id = ${tenant.accountId}::uuid
    `;
    await sql()`
      DELETE FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid
        AND location_id = ${tenant.businessId}::uuid
    `;
    await sql()`
      INSERT INTO auto_approval_policies (
        id, account_id, location_id, persona, action_class,
        auto_approve_min_star, veto_window_minutes, daily_auto_post_cap
      ) VALUES (
        ${randomUUID()}::uuid, ${tenant.accountId}::uuid, NULL,
        ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING}, 5, 15, NULL
      )
      ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
      DO UPDATE SET
        auto_approve_min_star = EXCLUDED.auto_approve_min_star,
        veto_window_minutes = EXCLUDED.veto_window_minutes,
        daily_auto_post_cap = EXCLUDED.daily_auto_post_cap,
        suspended_at = NULL,
        suspended_reason = NULL
    `;

    try {
      await expect(patch({
        ...actor,
        operation: 'set_account_daily_cap',
        cap: 50,
        confirmationLevel: 'standard',
      })).rejects.toMatchObject({ blockReasons: ['autopilot_unavailable'] });

      const [blockedRow] = await sql()<{ daily_auto_post_cap: number | null }[]>`
        SELECT daily_auto_post_cap
        FROM auto_approval_policies
        WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
      `;
      expect(blockedRow?.daily_auto_post_cap).toBeNull();

      const contracted = await patch({
        ...actor,
        operation: 'set_account_daily_cap',
        cap: 1,
      });
      expect(contracted.accountDefault).toMatchObject({
        dailyAutoPostCap: 1,
        effectiveDailyCap: 1,
      });
      expect(
        contracted.locations.find((location) => location.locationId === tenant.businessId)?.effective,
      ).toMatchObject({ inherited: true, dailyAutoPostCap: 1, effectiveDailyCap: 1 });
    } finally {
      await sql()`
        UPDATE accounts
        SET subscription_tier = 'autopilot'
        WHERE id = ${tenant.accountId}::uuid
      `;
    }
  });
});
