import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  acquireLiveDbLock,
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_096_SOLICITATION_SUPPRESSIONS,
  MIGRATION_098_SUPPRESSION_CORRECTIONS,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { recordSuppression } from '@/lib/solicitation/suppression';
import {
  correctSuppression,
  lookupSuppressions,
  recordAdminManualSuppression,
} from '../suppressions-service';

// Live-DB suite for admin manual entry (§7.3) and the Correction path (§8.2)
// of the Suppression ledger (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md).
//
// `../suppressions-service` lands in Task 4 and
// `MIGRATION_098_SUPPRESSION_CORRECTIONS` in Task 2, so this file is red at
// import time — the intended state of the eval task.
//
// Three things can only be proven here, never by a type or a fake `sql`:
//
//  1. FIRST-WRITE-WINS against the real global partial unique index. A repeat
//     admin entry must be a no-op success, not a duplicate row and not a throw
//     from a mis-inferred ON CONFLICT.
//  2. THE CORRECTION PATH'S ATOMICITY (plan P-9). `correctSuppression` is ONE
//     data-modifying CTE, so the delete and its audit record cannot separate
//     even when the caller opens no transaction — which is exactly how the
//     production route calls it. A test that supplies its own `sql.begin` would
//     prove nothing about that call site, so these tests deliberately do not.
//  3. THE NULL-ACCOUNT CASE. A `global` / `admin_manual` row entered from a
//     forwarded mailbox reply has no account to attribute, which is precisely
//     the shape `account_audit_log` structurally cannot hold (P-1).
//
// The Correction path is error correction, NEVER re-subscribe: there is no
// owner entry point and no recipient entry point anywhere in this module.
//
// No migration SQL is applied (#573): `pnpm test:db:setup` provisions to head
// and this suite ASSERTS with assertSchemaReady. Rows are swept per test
// instead of rolled back, because the single-statement CTE under test must run
// on the POOLED client with no outer transaction.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
/**
 * A SECOND account, so the admin lookup can be shown reading across tenants:
 * one handle can carry a global row whose provenance names account A and an
 * account-scoped row owned by account B, and the servicing view must show both.
 */
let secondaryTenant: TenantSeed | undefined;

/** Every Normalized handle this suite touched, swept in `afterEach`. */
const handles: string[] = [];

function sql(): postgresType.Sql {
  if (!db) throw new Error('suppression correction integration database was not initialized');
  return db;
}

/** The admin actor. A plain UUID on both tables — neither carries an FK. */
function adminUserId(): string {
  if (!tenant) throw new Error('suppression correction integration tenant was not seeded');
  return tenant.userId;
}

function primaryTenant(): TenantSeed {
  if (!tenant) throw new Error('suppression correction integration tenant was not seeded');
  return tenant;
}

function otherTenant(): TenantSeed {
  if (!secondaryTenant) {
    throw new Error('suppression correction integration second tenant was not seeded');
  }
  return secondaryTenant;
}

const PRIMARY_ACCOUNT_NAME = 'Suppression Correction Fixture';
const SECONDARY_ACCOUNT_NAME = 'Suppression Lookup Second Tenant';

/** A fresh Normalized handle per test, so no two tests contend on one key. */
function freshHandle(): string {
  const handle = `corrected-${randomUUID()}@test.local`;
  handles.push(handle);
  return handle;
}

/** Runs the real §7.3 entry path and returns the id of the row it left behind. */
async function seedGlobalAdminRow(handle: string, note: string): Promise<string> {
  await sql().begin((tx) => recordAdminManualSuppression(tx, {
    rawEmail: handle,
    adminUserId: adminUserId(),
    note,
  }));
  const [row] = await sql()<{ id: string }[]>`
    SELECT id FROM solicitation_suppressions
    WHERE channel = 'email' AND normalized_handle = ${handle}
  `;
  if (!row) throw new Error(`admin manual entry wrote no row for ${handle}`);
  return row.id;
}

describeWithDb(
  'admin suppression entry and the Correction path (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      // Serialises against the sibling solicitation live-DB suites, which write
      // the same `solicitation_*` tables from other vitest processes.
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [
        MIGRATION_096_SOLICITATION_SUPPRESSIONS,
        MIGRATION_098_SUPPRESSION_CORRECTIONS,
      ]);
      tenant = await seedTenantAccount(db, {
        userName: 'Suppression Correction Admin',
        accountDisplayName: PRIMARY_ACCOUNT_NAME,
      });
      secondaryTenant = await seedTenantAccount(db, {
        userName: 'Suppression Lookup Owner',
        accountDisplayName: SECONDARY_ACCOUNT_NAME,
      });
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db) return;
      // Nothing here rolls back, so sweep by handle. Correction records are
      // collected FIRST: they name the suppression ids of rows this suite
      // already deleted, which is the only way to reach their analytics events.
      const suppressionIds = new Set<string>();
      for (const handle of handles) {
        const live = await db<{ id: string }[]>`
          SELECT id FROM solicitation_suppressions WHERE normalized_handle = ${handle}
        `;
        for (const row of live) suppressionIds.add(row.id);
        const corrected = await db<{ suppression_id: string }[]>`
          SELECT suppression_id FROM solicitation_suppression_corrections
          WHERE normalized_handle = ${handle}
        `;
        for (const row of corrected) suppressionIds.add(row.suppression_id);
      }
      for (const id of suppressionIds) {
        await db`DELETE FROM analytics_events WHERE event_key = ${`solicitation_suppressed_${id}`}`;
      }
      for (const handle of handles) {
        await db`DELETE FROM solicitation_suppression_corrections WHERE normalized_handle = ${handle}`;
        await db`DELETE FROM solicitation_suppressions WHERE normalized_handle = ${handle}`;
      }
      handles.length = 0;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // Release in the reverse of acquisition order, and on every path: a
    // `beforeAll` that failed after taking the lock still holds it, and a leaked
    // advisory lock blocks every other live-DB suite until the session dies.
    afterAll(async () => {
      try {
        if (db && secondaryTenant) {
          await cleanupTenantAccount(db, {
            accountId: secondaryTenant.accountId,
            userId: secondaryTenant.userId,
          });
          secondaryTenant = undefined;
        }
        if (db && tenant) {
          await cleanupTenantAccount(db, { accountId: tenant.accountId, userId: tenant.userId });
        }
      } finally {
        try {
          if (db) await db.end({ timeout: 5 });
        } finally {
          await featureDatabaseLock?.release();
          featureDatabaseLock = undefined;
        }
      }
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // ── §7.3 admin manual entry ──────────────────────────────────────────────

    it('is idempotent against the global partial unique index — a repeat admin entry writes no second row', async () => {
      const handle = freshHandle();

      const first = await sql().begin((tx) => recordAdminManualSuppression(tx, {
        rawEmail: `  ${handle.toUpperCase()}  `,
        adminUserId: adminUserId(),
        note: 'mailbox ref 1',
      }));
      const second = await sql().begin((tx) => recordAdminManualSuppression(tx, {
        rawEmail: handle,
        adminUserId: adminUserId(),
        note: 'mailbox ref 2',
      }));

      // Both inputs normalize to the same Normalized handle, so the second
      // entry collides with the first — a no-op success, not an error and not
      // a second row.
      expect(first).toEqual({ ok: true, created: true, handle });
      expect(second).toEqual({ ok: true, created: false, handle });

      const rows = await sql()<{ id: string; note: string | null }[]>`
        SELECT id, note FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${handle}
      `;
      expect(rows).toHaveLength(1);
      // First write wins (§2.1): the earlier note survives, because the state
      // is already correct and history belongs where it is already recorded.
      expect(rows[0]?.note).toBe('mailbox ref 1');
    });

    it('admin manual entry persists the authenticated admin actor required note global scope and null account provenance', async () => {
      const handle = freshHandle();

      await sql().begin((tx) => recordAdminManualSuppression(tx, {
        rawEmail: handle,
        adminUserId: adminUserId(),
        note: 'forwarded mailbox reply 2026-08-03',
      }));

      // Every persisted column, not just the call arguments: §7.3's entry is a
      // compliance record, so what is ON the row is what has to be right.
      const rows = await sql()<{
        channel: string;
        normalized_handle: string;
        scope: string;
        source: string;
        account_id: string | null;
        created_by_user_id: string | null;
        note: string | null;
      }[]>`
        SELECT channel, normalized_handle, scope, source, account_id,
               created_by_user_id, note
        FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${handle}
      `;
      expect(rows).toEqual([
        {
          channel: 'email',
          normalized_handle: handle,
          scope: 'global',
          source: 'admin_manual',
          // A mailbox reply names no account; guessing one would write false
          // provenance into a compliance record.
          account_id: null,
          created_by_user_id: adminUserId(),
          note: 'forwarded mailbox reply 2026-08-03',
        },
      ]);
    });

    it('admin manual entry writes a global row when only an account-scoped row already exists', async () => {
      const handle = freshHandle();

      // An owner already marked this contact do-not-contact for their own
      // account. That row lives under a DIFFERENT partial unique index.
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'account',
        channel: 'email',
        normalizedHandle: handle,
        accountId: primaryTenant().accountId,
        source: 'owner_manual',
        createdByUserId: primaryTenant().userId,
      }));

      const result = await sql().begin((tx) => recordAdminManualSuppression(tx, {
        rawEmail: handle,
        adminUserId: adminUserId(),
        note: 'mailbox ref 6',
      }));

      // The global writer must infer its OWN index rather than colliding with
      // the account row — an account-scoped opt-out is not a global one.
      expect(result).toEqual({ ok: true, created: true, handle });
      const rows = await sql()<{ scope: string; source: string }[]>`
        SELECT scope, source FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${handle}
        ORDER BY scope
      `;
      expect(rows).toEqual([
        { scope: 'account', source: 'owner_manual' },
        { scope: 'global', source: 'admin_manual' },
      ]);
    });

    it('admin manual no-op preserves the first global row source actor note and account provenance', async () => {
      const handle = freshHandle();

      // A machine-authored global row with account provenance: the recipient
      // complained about a send from this account.
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'global',
        channel: 'email',
        normalizedHandle: handle,
        accountId: primaryTenant().accountId,
        source: 'complaint',
      }));

      const result = await sql().begin((tx) => recordAdminManualSuppression(tx, {
        rawEmail: handle,
        adminUserId: adminUserId(),
        note: 'mailbox ref 7',
      }));

      expect(result).toEqual({ ok: true, created: false, handle });

      // §2.1 is first-write-wins across SOURCES, not merely across repeated
      // admin entries: the state is already correct, so NOT ONE column moves.
      const rows = await sql()<{
        source: string;
        account_id: string | null;
        created_by_user_id: string | null;
        note: string | null;
      }[]>`
        SELECT source, account_id, created_by_user_id, note
        FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${handle}
      `;
      expect(rows).toEqual([
        {
          source: 'complaint',
          account_id: primaryTenant().accountId,
          created_by_user_id: null,
          note: null,
        },
      ]);
    });

    // ── §8.2 the Correction path ─────────────────────────────────────────────

    it('deletes the suppression row and writes the correction record in the same transaction', async () => {
      const handle = freshHandle();
      const suppressionId = await seedGlobalAdminRow(handle, 'mailbox ref 3');
      const [seeded] = await sql()<{ suppressed_at: Date }[]>`
        SELECT suppressed_at FROM solicitation_suppressions WHERE id = ${suppressionId}::uuid
      `;

      // The POOLED client, no outer transaction: the single statement is what
      // makes the pair atomic (P-9), and the production route opens none.
      const outcome = await correctSuppression(sql(), {
        suppressionId,
        adminUserId: adminUserId(),
        reason: 'admin typo on a mailbox reply',
      });

      expect(outcome).toBe('corrected');

      const remaining = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppressions WHERE id = ${suppressionId}::uuid
      `;
      expect(remaining).toHaveLength(0);

      const records = await sql()<{
        suppression_id: string;
        channel: string;
        normalized_handle: string;
        scope: string;
        source: string;
        suppressed_at: Date;
        removed_by_user_id: string;
        reason: string;
      }[]>`
        SELECT suppression_id, channel, normalized_handle, scope, source,
               suppressed_at, removed_by_user_id, reason
        FROM solicitation_suppression_corrections
        WHERE suppression_id = ${suppressionId}::uuid
      `;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        suppression_id: suppressionId,
        channel: 'email',
        // The Normalized handle is what identifies WHICH opt-out was removed
        // (P-3): suppression_id points at a row that no longer exists.
        normalized_handle: handle,
        scope: 'global',
        source: 'admin_manual',
        removed_by_user_id: adminUserId(),
        reason: 'admin typo on a mailbox reply',
      });
      // Copied from the DELETE's RETURNING, so the record describes the row
      // this call actually removed rather than one read earlier.
      expect(records[0]?.suppressed_at).toEqual(seeded?.suppressed_at);
    });

    it('rolls back the delete when the correction record write fails', async () => {
      const handle = freshHandle();
      const suppressionId = await seedGlobalAdminRow(handle, 'mailbox ref 4');

      // A blank reason violates the CHECK. The whole statement aborts, so the
      // ledger row must survive: failing safe on this path means KEEPING the
      // opt-out. Supplying our own `db.begin` here would prove nothing about
      // production, which does not open one.
      await expect(
        correctSuppression(sql(), {
          suppressionId,
          adminUserId: adminUserId(),
          reason: '   ',
        }),
      ).rejects.toThrow(/check constraint/i);

      const still = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppressions WHERE id = ${suppressionId}::uuid
      `;
      expect(still).toHaveLength(1);

      const orphans = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppression_corrections
        WHERE suppression_id = ${suppressionId}::uuid
      `;
      expect(orphans).toHaveLength(0);
    });

    it('corrects a global row whose account_id is NULL', async () => {
      // The §8.2 case account_audit_log structurally cannot hold (P-1): its
      // account_id is NOT NULL REFERENCES accounts(id), and a manual entry
      // taken from a forwarded mailbox reply names no account.
      const handle = freshHandle();
      const suppressionId = await seedGlobalAdminRow(handle, 'mailbox ref 5');

      const [seeded] = await sql()<{ account_id: string | null }[]>`
        SELECT account_id FROM solicitation_suppressions WHERE id = ${suppressionId}::uuid
      `;
      expect(seeded?.account_id).toBeNull();

      const outcome = await correctSuppression(sql(), {
        suppressionId,
        adminUserId: adminUserId(),
        reason: 'entered against the wrong address',
      });

      expect(outcome).toBe('corrected');
      const records = await sql()<{
        scope: string;
        source: string;
        normalized_handle: string;
      }[]>`
        SELECT scope, source, normalized_handle
        FROM solicitation_suppression_corrections
        WHERE suppression_id = ${suppressionId}::uuid
      `;
      expect(records).toEqual([
        { scope: 'global', source: 'admin_manual', normalized_handle: handle },
      ]);
    });

    it('reports not-found instead of writing an orphan correction record when the row is already gone', async () => {
      const result = await correctSuppression(sql(), {
        suppressionId: randomUUID(),
        adminUserId: adminUserId(),
        reason: 'already removed',
      });

      expect(result).toBe('not_found');
      // Zero rows out of the DELETE means nothing was removed, so nothing may
      // be recorded: an audit record naming an opt-out this call did not touch
      // is worse than no record at all.
      const corrections = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppression_corrections
        WHERE removed_by_user_id = ${adminUserId()}::uuid
      `;
      expect(corrections).toHaveLength(0);
    });

    it('two concurrent corrections remove one suppression and write exactly one correction record', async () => {
      const handle = freshHandle();
      const suppressionId = await seedGlobalAdminRow(handle, 'mailbox ref 8');

      // The single statement is what makes this safe: there is no
      // read-then-write window to lose. Exactly one DELETE matches the row;
      // the other returns zero rows and therefore writes nothing.
      const outcomes = await Promise.all([
        correctSuppression(sql(), {
          suppressionId,
          adminUserId: adminUserId(),
          reason: 'first admin correction',
        }),
        correctSuppression(sql(), {
          suppressionId,
          adminUserId: adminUserId(),
          reason: 'second admin correction',
        }),
      ]);

      expect([...outcomes].sort()).toEqual(['corrected', 'not_found']);

      const remaining = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppressions WHERE id = ${suppressionId}::uuid
      `;
      expect(remaining).toHaveLength(0);

      const records = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppression_corrections
        WHERE suppression_id = ${suppressionId}::uuid
      `;
      expect(records).toHaveLength(1);
    });

    // ── §7.3 the servicing lookup ────────────────────────────────────────────

    it('lookupSuppressions normalizes raw email and returns every matching live row global first with the account display name', async () => {
      const handle = freshHandle();

      // A global row whose provenance names account A…
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'global',
        channel: 'email',
        normalizedHandle: handle,
        accountId: primaryTenant().accountId,
        source: 'complaint',
      }));
      // …and an account-scoped row owned by account B. Servicing must show both.
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'account',
        channel: 'email',
        normalizedHandle: handle,
        accountId: otherTenant().accountId,
        source: 'owner_manual',
        createdByUserId: otherTenant().userId,
      }));

      const result = await lookupSuppressions(sql(), `  ${handle.toUpperCase()}  `);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The raw input is normalized before it is matched, so an admin pasting a
      // capitalized address out of a mailbox reply still finds the row.
      expect(result.handle).toBe(handle);
      expect(result.rows.map((row) => ({
        scope: row.scope,
        source: row.source,
        accountId: row.accountId,
        accountName: row.accountName,
      }))).toEqual([
        // Global first — the servicing view leads with the row that binds
        // every tenant.
        {
          scope: 'global',
          source: 'complaint',
          accountId: primaryTenant().accountId,
          accountName: PRIMARY_ACCOUNT_NAME,
        },
        {
          scope: 'account',
          source: 'owner_manual',
          accountId: otherTenant().accountId,
          accountName: SECONDARY_ACCOUNT_NAME,
        },
      ]);
      expect(result.rows.every((row) => row.normalizedHandle === handle)).toBe(true);
    });

    it('lookupSuppressions returns only corrections for the normalized handle newest first and capped at twenty', async () => {
      const handle = freshHandle();
      const otherHandle = freshHandle();

      // 21 records for the handle under test, plus records on a second handle
      // that must not leak into its history. created_at is set explicitly:
      // NOW() is transaction time, so a single statement would stamp every row
      // identically and make "newest first" unassertable.
      for (let index = 0; index < 21; index++) {
        await sql()`
          INSERT INTO solicitation_suppression_corrections
            (id, suppression_id, channel, normalized_handle, scope, source,
             suppressed_at, removed_by_user_id, reason, created_at)
          VALUES
            (${randomUUID()}::uuid, ${randomUUID()}::uuid, 'email', ${handle},
             'global', 'admin_manual', NOW(), ${adminUserId()}::uuid,
             ${`correction ${index}`}, NOW() - make_interval(secs => ${index}))
        `;
      }
      for (let index = 0; index < 3; index++) {
        await sql()`
          INSERT INTO solicitation_suppression_corrections
            (id, suppression_id, channel, normalized_handle, scope, source,
             suppressed_at, removed_by_user_id, reason, created_at)
          VALUES
            (${randomUUID()}::uuid, ${randomUUID()}::uuid, 'email',
             ${otherHandle}, 'global', 'admin_manual', NOW(),
             ${adminUserId()}::uuid, ${`other handle ${index}`}, NOW())
        `;
      }

      const result = await lookupSuppressions(sql(), handle);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.corrections).toHaveLength(20);
      expect(result.corrections.map((record) => record.reason)).toEqual(
        Array.from({ length: 20 }, (_unused, index) => `correction ${index}`),
      );
      expect(result.corrections.some((record) => record.reason.startsWith('other handle')))
        .toBe(false);
    });
  },
);
