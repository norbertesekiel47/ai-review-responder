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
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import {
  clearContactDoNotContact,
  listContacts,
  markContactDoNotContact,
} from '../contacts-repo';
import { recordSuppression } from '../suppression';

// Live-DB suite for the owner-authored Suppression ledger paths (#645; locked
// spec docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md
// §7.5 owner do-not-contact and §7.6 owner clearing).
//
// `markContactDoNotContact` and `clearContactDoNotContact` land in Task 5, so
// this file is red at import time — the intended state of the eval task.
//
// Three things can only be proven against the real schema:
//
//  1. THE SUPPRESSION SCOPE THE OWNER WRITES. `scope='account'` with
//     `source='owner_manual'`, keyed on the Normalized handle and never on the
//     contact row id (#535 §6). A `global` row here would let one owner
//     silently degrade every other tenant's reach with no recipient having
//     spoken (§1.2), and the one-directional pairing CHECK is what refuses it.
//  2. THE CLEAR PREDICATE'S REACH. §7.6 removes only `scope='account' AND
//     account_id = <the caller's>`; a matching global row is untouched, and the
//     contact stays suppressed afterwards. An owner may NEVER clear a global
//     row — removing one is the admin-only audited Correction path.
//  3. THE NO-HANDLE REFUSAL. A phone-only contact has no email Normalized
//     handle, so there is nothing to key a row on and nothing is written.
//
// Attestation never overrides suppression: nothing in this file re-attests a
// contact back into contactability, and no owner control here reaches a global
// row.
//
// No migration SQL is applied (#573): `pnpm test:db:setup` provisions to head
// and this suite ASSERTS with assertSchemaReady.

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();
const uploadId = randomUUID();

/** Every Normalized handle this suite touched, swept in `afterEach`. */
const handles: string[] = [];

function sql(): postgresType.Sql {
  if (!db) throw new Error('do-not-contact integration database was not initialized');
  return db;
}

function seed(): TenantSeed {
  if (!tenant) throw new Error('do-not-contact integration tenant was not seeded');
  return tenant;
}

/** A fresh Normalized handle per test, so no two tests contend on one key. */
function freshHandle(): string {
  const handle = `contact-${randomUUID()}@test.local`;
  handles.push(handle);
  return handle;
}

async function seedContact(input: {
  name: string;
  email: string | null;
  phone?: string | null;
  visitDates: string[];
}): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, phone, created_by_upload_id)
    VALUES (${contactId}::uuid, ${businessId}::uuid, ${input.name}, ${input.email},
            ${input.phone ?? null}, ${uploadId}::uuid)
  `;
  for (const visitDate of input.visitDates) {
    await sql()`
      INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, upload_id)
      VALUES (${randomUUID()}::uuid, ${contactId}::uuid, ${businessId}::uuid,
              ${visitDate}::date, ${uploadId}::uuid)
    `;
  }
  return contactId;
}

function ownerInput(contactId: string) {
  return {
    accountId: seed().accountId,
    businessId,
    contactId,
    actorUserId: seed().userId,
  };
}

describeWithDb(
  'owner do-not-contact and clearing (live DB)',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      // Serialises against the sibling solicitation live-DB suites, which write
      // the same `solicitation_*` tables from other vitest processes.
      featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_096_SOLICITATION_SUPPRESSIONS]);
      tenant = await seedTenantAccount(db, {
        userName: 'Do Not Contact Integration Owner',
        accountDisplayName: 'Do Not Contact Integration Account',
      });
      await db`
        INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
        VALUES (
          ${businessId}::uuid,
          'Do Not Contact Integration Business',
          'Contacts Owner',
          ${tenant.ownerEmail},
          ${tenant.accountId}::uuid,
          'active'
        )
      `;
      await db`
        INSERT INTO contact_csv_uploads
          (id, account_id, business_id, filename, byte_size, content_sha256,
           raw_csv, status, attested_by_user_id, attested_at, attestation_version)
        VALUES
          (${uploadId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
           'customers.csv', 1, ${'0'.repeat(64)}, 'x', 'pending',
           ${tenant.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION})
      `;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      if (!db) return;
      // A Suppression ledger row has no expiry and no ordinary delete path, so
      // a leaked one is a permanent record — sweep by handle, and take the
      // analytics rows recordSuppression wrote in the same transaction.
      for (const handle of handles) {
        const rows = await db<{ id: string }[]>`
          SELECT id FROM solicitation_suppressions WHERE normalized_handle = ${handle}
        `;
        for (const row of rows) {
          await db`DELETE FROM analytics_events WHERE event_key = ${`solicitation_suppressed_${row.id}`}`;
        }
        await db`DELETE FROM solicitation_suppressions WHERE normalized_handle = ${handle}`;
      }
      handles.length = 0;
      await db`DELETE FROM account_audit_log WHERE account_id = ${seed().accountId}::uuid`;
      await db`DELETE FROM solicitation_visits WHERE business_id = ${businessId}::uuid`;
      await db`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

    // Release in the reverse of acquisition order, and on every path: a
    // `beforeAll` that failed after taking the lock still holds it, and a leaked
    // advisory lock blocks every other live-DB suite until the session dies.
    afterAll(async () => {
      try {
        if (db) {
          // `solicitation_suppressions.account_id` is a NO-ACTION FK to
          // `accounts`, so any stray ledger row MUST go before the account.
          if (tenant) {
            await db`DELETE FROM solicitation_suppressions WHERE account_id = ${tenant.accountId}::uuid`;
          }
          await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
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

    // ── §7.5 owner do-not-contact ────────────────────────────────────────────

    it("writes an owner_manual account-scoped row for the caller's own account", async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Ada Lovelace',
        email: contactEmail,
        visitDates: ['2026-03-01'],
      });

      const result = await markContactDoNotContact(sql(), ownerInput(contactId));

      expect(result).toBe('marked');
      const rows = await sql()<{
        scope: string;
        source: string;
        account_id: string | null;
        created_by_user_id: string | null;
        normalized_handle: string;
      }[]>`
        SELECT scope, source, account_id, created_by_user_id, normalized_handle
        FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scope: 'account',
        source: 'owner_manual',
        account_id: seed().accountId,
        created_by_user_id: seed().userId,
        // Keyed on the Normalized handle, never the contact row id: delete and
        // re-upload must not launder it (#535 §6).
        normalized_handle: contactEmail,
      });
    });

    it('refuses an owner do-not-contact on a contact with no email handle', async () => {
      const phoneOnlyId = await seedContact({
        name: 'Phone Only',
        email: null,
        phone: '+15555550123',
        visitDates: ['2026-03-02'],
      });

      const result = await markContactDoNotContact(sql(), ownerInput(phoneOnlyId));

      expect(result).toBe('no_email_handle');
      // The email channel is the only one the ledger holds today, so there is
      // no handle to key a row on — and a row keyed on anything else would be
      // an opt-out on record that suppresses nobody.
      const rows = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppressions WHERE account_id = ${seed().accountId}::uuid
      `;
      expect(rows).toHaveLength(0);
    });

    // ── §7.6 owner clearing ──────────────────────────────────────────────────

    it("clears only the account row owned by the caller's account, leaving a matching global row in place", async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Grace Hopper',
        email: contactEmail,
        visitDates: ['2026-03-03'],
      });
      const input = ownerInput(contactId);

      // The recipient's own opt-out and the owner's do-not-contact are
      // independent records of independent facts, on two different partial
      // unique indexes.
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'global',
        channel: 'email',
        normalizedHandle: contactEmail,
        accountId: null,
        source: 'complaint',
      }));
      expect(await markContactDoNotContact(sql(), input)).toBe('marked');

      expect(await clearContactDoNotContact(sql(), input)).toBe('cleared');

      // §7.6's predicate can only ever reach the caller's own account row. The
      // global row survives, because removing one is the admin-only audited
      // Correction path and this control is not it.
      const remaining = await sql()<{ scope: string }[]>`
        SELECT scope FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(remaining).toEqual([{ scope: 'global' }]);

      // And the owner sees the contact stay suppressed afterwards — G3's
      // global-wins reported honestly rather than as a control that did nothing.
      const { contacts } = await listContacts(
        sql(), seed().accountId, businessId, { limit: 50, offset: 0 },
      );
      expect(contacts.find((contact) => contact.id === contactId)?.suppression?.state)
        .toBe('global');
    });
  },
);
