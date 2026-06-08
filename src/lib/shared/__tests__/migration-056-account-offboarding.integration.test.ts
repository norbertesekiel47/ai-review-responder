import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

// Behavioral (live-DB) companion to migration-056-account-offboarding.test.ts,
// which only asserts the migration SQL *text*. This proves the runtime lifecycle
// CHECK constraints actually REJECT forbidden rows instead of merely existing in
// the DDL string: failed_step legality, terminal_at consistency, and mode/status
// legality. Each insert is valid except for the single field that should trip the
// target constraint, and each rejection asserts the *specific* constraint by name,
// so a test can never pass for the wrong reason.
//
// Gated on a real test database (TEST_DATABASE_POOL_URL), like the repo's other
// integration tests; skips cleanly without one (e.g. in the no-DB CI test job).
// The database is expected to already have all migrations applied.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
const RUN = Boolean(testDatabaseUrl);
const d = RUN ? describe : describe.skip;

let db: postgresType.Sql | undefined;

const tenant = {
  userId: randomUUID(),
  accountId: randomUUID(),
};
const ownerEmail = `offboarding-056-${tenant.accountId}@test.local`;

function sql(): postgresType.Sql {
  if (!db) throw new Error('migration 056 integration database was not initialized');
  return db;
}

async function insertOffboarding(fields: {
  mode: string;
  status: string;
  failedStep?: string | null;
  terminalAt?: string | null;
}): Promise<void> {
  await sql()`
    INSERT INTO account_offboardings (id, account_id, mode, status, failed_step, terminal_at)
    VALUES (
      ${uuidv7()}::uuid,
      ${tenant.accountId}::uuid,
      ${fields.mode},
      ${fields.status},
      ${fields.failedStep ?? null},
      ${fields.terminalAt ?? null}::timestamptz
    )
  `;
}

d('migration 056 account_offboardings — lifecycle CHECK constraints (behavioral)', () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    await sql().begin(async (tx) => {
      // users.account_id <-> accounts.owner_user_id are mutually referential.
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${tenant.userId}::uuid, 'Offboarding 056 Owner', ${ownerEmail}, 'owner', ${tenant.accountId}::uuid)
      `;
      await tx`
        INSERT INTO accounts (id, owner_user_id, display_name, subscription_tier, subscription_status)
        VALUES (${tenant.accountId}::uuid, ${tenant.userId}::uuid, 'Offboarding 056 Account', 'standard', 'active')
      `;
    });
  });

  afterEach(async () => {
    if (!db) return;
    await sql()`DELETE FROM account_offboardings WHERE account_id = ${tenant.accountId}::uuid`;
  });

  afterAll(async () => {
    if (!db) return;
    await sql().begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM account_offboardings WHERE account_id = ${tenant.accountId}::uuid`;
      await tx`DELETE FROM accounts WHERE id = ${tenant.accountId}::uuid`;
      await tx`DELETE FROM users WHERE id = ${tenant.userId}::uuid`;
    });
    await db.end({ timeout: 5 });
  });

  it('admits a legal pending delete_data row', async () => {
    await insertOffboarding({ mode: 'delete_data', status: 'pending' });
    const [row] = await sql()<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM account_offboardings
      WHERE account_id = ${tenant.accountId}::uuid
    `;
    expect(row?.count).toBe('1');
  });

  it('rejects a non-failed row carrying a failed_step (failed_step_check)', async () => {
    await expect(
      insertOffboarding({ mode: 'delete_data', status: 'pending', failedStep: 'teardown' }),
    ).rejects.toThrow(/account_offboardings_failed_step_check/);
  });

  it('rejects a failed row with no failed_step (failed_step_check)', async () => {
    await expect(
      insertOffboarding({ mode: 'delete_data', status: 'failed', failedStep: null }),
    ).rejects.toThrow(/account_offboardings_failed_step_check/);
  });

  it('rejects a terminal status without terminal_at (terminal_status_check)', async () => {
    await expect(
      insertOffboarding({ mode: 'delete_data', status: 'churned', terminalAt: null }),
    ).rejects.toThrow(/account_offboardings_terminal_status_check/);
  });

  it('rejects a non-terminal status with terminal_at set (terminal_status_check)', async () => {
    await expect(
      insertOffboarding({
        mode: 'delete_data',
        status: 'pending',
        terminalAt: '2026-06-06T12:00:00.000Z',
      }),
    ).rejects.toThrow(/account_offboardings_terminal_status_check/);
  });

  it('rejects a status illegal for the mode (mode_status_check)', async () => {
    // purge_scheduled is a valid status overall but only legal for delete_data.
    await expect(
      insertOffboarding({ mode: 'cancel_only', status: 'purge_scheduled' }),
    ).rejects.toThrow(/account_offboardings_mode_status_check/);
  });
});
