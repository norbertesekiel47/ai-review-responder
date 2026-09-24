import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  cleanupTenantAccount,
  cleanupLocation,
  seedLocation,
  seedTenantAccount,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_074_TRUST_DIAL_VETO_WINDOW,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { resetServerConfigForTests } from '@/lib/config/server';
import {
  patchAutoApprovalSettings,
  patchAutoApprovalSettingsInTransaction,
} from '../settings';
import { POLICY_ACTION_POSTING, POLICY_PERSONA_REPLY } from '../types';
import type { RestoreReplyPolicyRequest } from '../types';

// Live-DB suite for the WS4 Task 12 settings writers: migration 074 rebuilt
// the two partial unique indexes on auto_approval_policies to include
// (persona, action_class), which broke the previous upserts' ON CONFLICT
// inference (documented apply-window breakage in 074's header). These tests
// run the REAL upserts against the rebuilt indexes — insert AND the
// DO UPDATE conflict path for both scopes — proving the breakage is over.
//
// Run C T1 adds the transaction-aware writer cases at the end. Each one seeds
// its own scratch location, resets the account default it reads, and deletes
// its policy + audit rows + location in `finally`, so it assumes nothing from
// the other tests. The lock case uses the suite connection as its
// holder/probe and one extra writer connection.
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

function restorePolicy(locationId: string | null, state: RestoreReplyPolicyRequest['state']) {
  return sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
    ...actor,
    operation: 'restore_reply_policy',
    locationId,
    state,
    confirmationLevel: 'standard',
  }));
}

type SqlExecutor = postgresType.Sql | postgresType.TransactionSql;

const WRITER_APPLICATION_NAME = 'run_c_t1_settings_writer';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function seedScratchLocation(): Promise<string> {
  const { businessId } = await seedLocation(sql(), tenant.accountId, {
    name: 'Run C T1 Scratch Location',
    isPrimary: false,
  });
  return businessId;
}

async function cleanupScratchLocation(locationId: string): Promise<void> {
  await sql()`
    DELETE FROM auto_approval_policies
    WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
  `;
  // account_audit_log.location_id references businesses without a cascade.
  await sql()`
    DELETE FROM account_audit_log
    WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
  `;
  await cleanupLocation(sql(), locationId);
}

async function resetAccountDefault(dials: {
  threshold: 4 | 5 | null;
  vetoWindowMinutes: 15 | 30;
  dailyAutoPostCap: number | null;
}): Promise<void> {
  await sql()`
    INSERT INTO auto_approval_policies (
      id, account_id, location_id, persona, action_class,
      auto_approve_min_star, veto_window_minutes, daily_auto_post_cap
    ) VALUES (
      ${randomUUID()}::uuid, ${tenant.accountId}::uuid, NULL,
      ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING},
      ${dials.threshold}, ${dials.vetoWindowMinutes}, ${dials.dailyAutoPostCap}
    )
    ON CONFLICT (account_id, persona, action_class) WHERE location_id IS NULL
    DO UPDATE SET
      auto_approve_min_star = EXCLUDED.auto_approve_min_star,
      veto_window_minutes = EXCLUDED.veto_window_minutes,
      daily_auto_post_cap = EXCLUDED.daily_auto_post_cap,
      suspended_at = NULL,
      suspended_reason = NULL
  `;
}

async function countScratchRows(
  executor: SqlExecutor,
  locationId: string,
): Promise<{ policies: number; audits: number }> {
  const [row] = await executor<{ policies: number; audits: number }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM auto_approval_policies
        WHERE account_id = ${tenant.accountId}::uuid
          AND location_id = ${locationId}::uuid) AS policies,
      (SELECT COUNT(*)::int FROM account_audit_log
        WHERE account_id = ${tenant.accountId}::uuid
          AND location_id = ${locationId}::uuid
          AND event_type = 'auto_approval_policy_changed') AS audits
  `;
  return { policies: row?.policies ?? -1, audits: row?.audits ?? -1 };
}

async function readScratchOverride(locationId: string) {
  const [row] = await sql()<{
    id: string;
    auto_approve_min_star: number | null;
    veto_window_minutes: number;
    daily_auto_post_cap: number | null;
  }[]>`
    SELECT id, auto_approve_min_star, veto_window_minutes, daily_auto_post_cap
    FROM auto_approval_policies
    WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
  `;
  return row ?? null;
}

// Observes the writer backend parked on a lock that the holder backend owns
// (pg_blocking_pids). The holder transaction also probes, so only two
// connections are needed. The deadline bounds failure; the observed lock is
// the proof, with no sleep establishing the race.
async function waitForWriterBlockedBy(tx: postgresType.TransactionSql, holderPid: number): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // pg_stat_activity is cached within a transaction. Refresh its statistics
    // snapshot so this holder can observe the writer entering its lock wait.
    await tx`SELECT pg_stat_clear_snapshot()`;
    const [blocked] = await tx<{ query: string }[]>`
      SELECT query
      FROM pg_stat_activity
      WHERE application_name = ${WRITER_APPLICATION_NAME}
        AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
      LIMIT 1
    `;
    if (blocked) return blocked.query;
  }
  throw new Error('settings writer never blocked on the holder-owned lock');
}

describeWithDb('auto-approval settings writers — live upserts against the 074 indexes', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
    vi.stubEnv('AUTOPILOT_PURCHASABLE', 'true');
    vi.stubEnv('OPENAI_MODERATION_ENABLED', 'true');
    vi.stubEnv('AUTO_APPROVAL_PROVIDER_MODERATION_READY', 'true');
    vi.stubEnv('VERCEL_TARGET_ENV', 'test');
    resetServerConfigForTests();
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    // 074 is provisioned by `pnpm test:db:setup` and the lane lease has already
    // validated the provision marker (#958) — assert, never apply.
    await assertSchemaReady(db, [MIGRATION_074_TRUST_DIAL_VETO_WINDOW]);
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
    await resetAccountDefault({ threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 25 });
    const [accountRow] = await sql()<{ id: string }[]>`
      SELECT id FROM auto_approval_policies
      WHERE account_id = ${tenant.accountId}::uuid AND location_id IS NULL
        AND persona = ${POLICY_PERSONA_REPLY} AND action_class = ${POLICY_ACTION_POSTING}
    `;
    expect(accountRow).toBeDefined();
    const locationId = await seedScratchLocation();
    const overrideId = randomUUID();

    try {
      await sql()`
        INSERT INTO auto_approval_policies (
          id, account_id, location_id, persona, action_class,
          auto_approve_min_star, veto_window_minutes, daily_auto_post_cap
        ) VALUES (
          ${overrideId}::uuid, ${tenant.accountId}::uuid, ${locationId}::uuid,
          ${POLICY_PERSONA_REPLY}, ${POLICY_ACTION_POSTING}, 5, 30, 5
        )
      `;

      const afterManual = await patch({ ...actor, operation: 'set_account_manual' });
      expect(afterManual.accountDefault).toMatchObject({
        policyId: accountRow!.id,
        threshold: null,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 25,
      });

      const afterLocationManual = await patch({
        ...actor,
        operation: 'set_location_manual',
        locationId,
      });
      const override = afterLocationManual.locations.find(
        (entry) => entry.locationId === locationId,
      )?.override;
      expect(override).toMatchObject({
        policyId: overrideId,
        threshold: null,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 5,
      });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('clear on a suspended account default preserves the row; unsuspended clear deletes it', async () => {
    await resetAccountDefault({ threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 25 });
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

  it('tx writer: a caller throw after the writer returns rolls back both the policy row and its audit row', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 7 });

    try {
      await expect(sql().begin(async (tx) => {
        const result = await patchAutoApprovalSettingsInTransaction(tx, {
          ...actor,
          operation: 'set_location_veto_window',
          locationId,
          minutes: 15,
        });
        expect(result.locations.find((entry) => entry.locationId === locationId)?.override)
          .toMatchObject({ exists: true, threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: 7 });
        // Both writes are visible on the caller's transaction before the throw.
        expect(await countScratchRows(tx, locationId)).toEqual({ policies: 1, audits: 1 });
        throw new Error('run-c-t1 deliberate caller failure');
      })).rejects.toThrow('run-c-t1 deliberate caller failure');

      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 0, audits: 0 });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('tx writer: a first dial write seeds manual + the inherited dial with one audit; a later dial write keeps untouched fields', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 7 });

    try {
      const created = await sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
        ...actor,
        operation: 'set_location_daily_cap',
        locationId,
        cap: 2,
      }));
      const createdOverride = created.locations.find((entry) => entry.locationId === locationId)?.override;
      expect(createdOverride).toMatchObject({
        exists: true,
        threshold: null,
        vetoWindowMinutes: 30,
        dailyAutoPostCap: 2,
      });
      expect(await readScratchOverride(locationId)).toMatchObject({
        id: createdOverride?.policyId,
        auto_approve_min_star: null,
        veto_window_minutes: 30,
        daily_auto_post_cap: 2,
      });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 1 });

      // A non-null threshold on the existing row makes its preservation observable.
      await sql()`
        UPDATE auto_approval_policies
        SET auto_approve_min_star = 5
        WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
      `;

      const updated = await sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
        ...actor,
        operation: 'set_location_daily_cap',
        locationId,
        cap: 1,
      }));
      expect(updated.locations.find((entry) => entry.locationId === locationId)?.override)
        .toMatchObject({
          policyId: createdOverride?.policyId,
          threshold: 5,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 1,
        });
      expect(await readScratchOverride(locationId)).toMatchObject({
        id: createdOverride?.policyId,
        auto_approve_min_star: 5,
        veto_window_minutes: 30,
        daily_auto_post_cap: 1,
      });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 2 });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('tx writer: an impersonated actor is rejected on the caller transaction with zero writes', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 7 });

    try {
      await expect(sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
        ...actor,
        impersonated: true,
        operation: 'set_location_manual',
        locationId,
      }))).rejects.toMatchObject({ blockReasons: ['impersonation_not_allowed'] });

      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 0, audits: 0 });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('tx writer: waits on an owner-held account row lock, then reads the account default the holder committed', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 7 });
    const writer = postgres(testDatabaseUrl!, {
      max: 1,
      prepare: false,
      connection: { application_name: WRITER_APPLICATION_NAME },
    });
    const holderReady = deferred<{ pid: number; tx: postgresType.TransactionSql }>();
    const releaseHolder = deferred<void>();
    const pending: Promise<unknown>[] = [];

    try {
      const holderTx = sql().begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '15s'`;
        await tx`SELECT id FROM accounts WHERE id = ${tenant.accountId}::uuid FOR UPDATE`;
        // Changed under the lock and committed on release: a writer that read
        // the account default BEFORE taking the lock would seed cap 7, not 3.
        await tx`
          UPDATE auto_approval_policies
          SET daily_auto_post_cap = 3, updated_at = NOW()
          WHERE account_id = ${tenant.accountId}::uuid
            AND location_id IS NULL
            AND persona = ${POLICY_PERSONA_REPLY}
            AND action_class = ${POLICY_ACTION_POSTING}
        `;
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error('holder backend pid unavailable');
        holderReady.resolve({ pid: backend.pid, tx });
        await releaseHolder.promise;
      });
      pending.push(holderTx);
      void holderTx.catch((error: unknown) => holderReady.reject(error));

      const locked = await holderReady.promise;

      const writerTx = writer.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        return patchAutoApprovalSettingsInTransaction(tx, {
          ...actor,
          operation: 'set_location_veto_window',
          locationId,
          minutes: 15,
        });
      });
      // Observe rejection immediately and rethrow it when the writer is
      // joined below; cleanup can safely await this outcome on either path.
      const writerOutcome = writerTx.then(
        (result) => ({ ok: true, result } as const),
        (error: unknown) => ({ ok: false, error } as const),
      );
      pending.push(writerOutcome);

      const blockedQuery = await waitForWriterBlockedBy(locked.tx, locked.pid);
      expect(blockedQuery).toMatch(/FROM\s+accounts/i);
      expect(blockedQuery).toMatch(/FOR\s+UPDATE/i);

      releaseHolder.resolve();
      await holderTx;
      const outcome = await writerOutcome;
      if (!outcome.ok) throw outcome.error;
      const result = outcome.result;

      expect(result.locations.find((entry) => entry.locationId === locationId)?.override)
        .toMatchObject({ exists: true, threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: 3 });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 1 });
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled(pending);
      await writer.end({ timeout: 5 });
      await cleanupScratchLocation(locationId);
    }
  });

  it.each([2, null])('restore round-trips a cleared exact 5/30/%s override and returns to absence', async (cap) => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 10 });
    const state = { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: cap } as const;
    try {
      await restorePolicy(locationId, state);
      await patch({ ...actor, operation: 'delete_location_override', locationId, confirmationLevel: 'standard' });
      expect(await readScratchOverride(locationId)).toBeNull();

      const restored = await restorePolicy(locationId, state);
      expect(restored.locations.find((entry) => entry.locationId === locationId)?.override)
        .toMatchObject({ exists: true, ...state });
      expect(await readScratchOverride(locationId)).toMatchObject({
        auto_approve_min_star: 5, veto_window_minutes: 30, daily_auto_post_cap: cap,
      });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 3 });

      // Exercise the conflict path as well: every owner-controlled column is
      // replaced, and the existing policy identity survives the full restore.
      const policyId = (await readScratchOverride(locationId))?.id;
      await restorePolicy(locationId, { threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 50 });
      await restorePolicy(locationId, state);
      expect(await readScratchOverride(locationId)).toMatchObject({
        id: policyId, auto_approve_min_star: 5, veto_window_minutes: 30, daily_auto_post_cap: cap,
      });

      await patch({ ...actor, operation: 'delete_location_override', locationId, confirmationLevel: 'standard' });
      expect(await readScratchOverride(locationId)).toBeNull();
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 0, audits: 6 });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('atomic policy restore rolls back after a post-write error and records one audit', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 10 });
    const state = { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 } as const;
    try {
      await expect(sql().begin(async (tx) => {
        await patchAutoApprovalSettingsInTransaction(tx, {
          ...actor, operation: 'restore_reply_policy', locationId, state,
        });
        expect(await countScratchRows(tx, locationId)).toEqual({ policies: 1, audits: 1 });
        throw new Error('injected post-write restore failure');
      })).rejects.toThrow('injected post-write restore failure');
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 0, audits: 0 });

      await restorePolicy(locationId, state);
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 1 });
      const [audit] = await sql()<{ payload: { operation: string; afterRow: unknown; exposureClassification: string } }[]>`
        SELECT payload FROM account_audit_log
        WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
          AND event_type = 'auto_approval_policy_changed'
      `;
      expect(audit?.payload).toMatchObject({
        operation: 'restore_reply_policy', exposureClassification: 'contraction',
        afterRow: { exists: true, ...state },
      });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('restore recreates and updates an account default while preserving an originally absent default', async () => {
    await patch({ ...actor, operation: 'clear_account_default', confirmationLevel: 'standard' });
    const created = await restorePolicy(null, { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
    expect(created.accountDefault).toMatchObject({ exists: true, threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
    const updated = await restorePolicy(null, { threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null });
    expect(updated.accountDefault).toMatchObject({
      policyId: created.accountDefault.policyId, exists: true, threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null,
    });
    const cleared = await patch({ ...actor, operation: 'clear_account_default', confirmationLevel: 'standard' });
    expect(cleared.accountDefault.exists).toBe(false);
  });

  it('restore retains current suspension columns and refuses to expand a suspended row', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 10 });
    try {
      await restorePolicy(locationId, { threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 10 });
      await sql()`
        UPDATE auto_approval_policies SET suspended_at = NOW(), suspended_reason = 'test governor suspension'
        WHERE account_id = ${tenant.accountId}::uuid AND location_id = ${locationId}::uuid
      `;
      const restored = await restorePolicy(locationId, { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
      expect(restored.locations.find((entry) => entry.locationId === locationId)?.override).toMatchObject({
        threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2,
        suspended: true, suspendedReason: 'test governor suspension',
      });
      await expect(restorePolicy(locationId, { threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 2 }))
        .rejects.toMatchObject({ blockReasons: ['policy_suspended'] });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 2 });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('restore rejects foreign locations, impersonation, missing confirmation and unready expansion before writes', async () => {
    const locationId = await seedScratchLocation();
    const foreign = await seedTenantAccount(sql());
    await resetAccountDefault({ threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null });
    const input = {
      ...actor, operation: 'restore_reply_policy', locationId,
      state: { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 },
      confirmationLevel: 'standard',
    } as const;
    try {
      // Catch inside the caller transaction and commit the read-only outcome:
      // rejection must happen before writes, rather than relying on rollback.
      await sql().begin(async (tx) => {
        await expect(patchAutoApprovalSettingsInTransaction(tx, { ...input, accountId: foreign.accountId }))
          .rejects.toMatchObject({ code: 'location_not_found' });
        await expect(patchAutoApprovalSettingsInTransaction(tx, { ...input, impersonated: true }))
          .rejects.toMatchObject({ blockReasons: ['impersonation_not_allowed'] });
        await expect(patchAutoApprovalSettingsInTransaction(tx, { ...input, confirmationLevel: undefined }))
          .rejects.toMatchObject({ confirmationLevel: 'standard' });
        vi.stubEnv('AUTO_APPROVAL_ENABLED', 'false');
        await expect(patchAutoApprovalSettingsInTransaction(tx, input))
          .rejects.toMatchObject({ blockReasons: expect.arrayContaining(['auto_approval_disabled']) });
        expect(await countScratchRows(tx, locationId)).toEqual({ policies: 0, audits: 0 });
      });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 0, audits: 0 });
      const [foreignRows] = await sql()<{ policies: number; audits: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM auto_approval_policies WHERE account_id = ${foreign.accountId}::uuid) AS policies,
          (SELECT COUNT(*)::int FROM account_audit_log WHERE account_id = ${foreign.accountId}::uuid) AS audits
      `;
      expect(foreignRows).toEqual({ policies: 0, audits: 0 });
    } finally {
      vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
      await cleanupScratchLocation(locationId);
      await cleanupTenantAccount(sql(), foreign);
    }
  });

  it('restore cannot rearm an archived location even when the restored threshold contracts', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 15, dailyAutoPostCap: 10 });
    try {
      await sql()`UPDATE businesses SET archived_at = NOW() WHERE account_id = ${tenant.accountId}::uuid AND id = ${locationId}::uuid`;
      await expect(restorePolicy(locationId, { threshold: 5, vetoWindowMinutes: 30, dailyAutoPostCap: 2 }))
        .rejects.toMatchObject({ code: 'location_inactive' });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 0, audits: 0 });
    } finally {
      await cleanupScratchLocation(locationId);
    }
  });

  it('restore classifies the final manual state once and still gates dial widening on an already-manual row', async () => {
    const locationId = await seedScratchLocation();
    await resetAccountDefault({ threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 2 });
    const state = { threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null } as const;
    try {
      vi.stubEnv('AUTO_APPROVAL_ENABLED', 'false');
      const restored = await sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
        ...actor, operation: 'restore_reply_policy', locationId, state,
      }));
      expect(restored.locations.find((entry) => entry.locationId === locationId)?.effective)
        .toMatchObject({ ...state, source: 'location_override' });

      // Tighten the stored manual dials, then attempt to widen them again.
      await sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
        ...actor, operation: 'restore_reply_policy', locationId,
        state: { threshold: null, vetoWindowMinutes: 30, dailyAutoPostCap: 2 },
      }));
      await expect(sql().begin((tx) => patchAutoApprovalSettingsInTransaction(tx, {
        ...actor, operation: 'restore_reply_policy', locationId, state,
      }))).rejects.toMatchObject({ confirmationLevel: 'standard' });
      await expect(restorePolicy(locationId, state))
        .rejects.toMatchObject({ blockReasons: expect.arrayContaining(['auto_approval_disabled']) });
      expect(await countScratchRows(sql(), locationId)).toEqual({ policies: 1, audits: 2 });
      expect(await readScratchOverride(locationId)).toMatchObject({
        auto_approve_min_star: null, veto_window_minutes: 30, daily_auto_post_cap: 2,
      });
    } finally {
      vi.stubEnv('AUTO_APPROVAL_ENABLED', 'true');
      await cleanupScratchLocation(locationId);
    }
  });
});
