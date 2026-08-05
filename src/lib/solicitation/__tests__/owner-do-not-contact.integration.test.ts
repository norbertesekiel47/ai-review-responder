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
  deleteContact,
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
/** A second tenant, for the two cross-account proofs (invariant #8). */
let otherTenant: TenantSeed | undefined;
const businessId = randomUUID();
const uploadId = randomUUID();
/** A second user inside the SAME account, so attribution can be proven to
 *  follow the acting user rather than defaulting to the account owner. */
const staffUserId = randomUUID();

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

function foreignSeed(): TenantSeed {
  if (!otherTenant) throw new Error('do-not-contact integration foreign tenant was not seeded');
  return otherTenant;
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
      otherTenant = await seedTenantAccount(db, {
        userName: 'Do Not Contact Foreign Owner',
        accountDisplayName: 'Do Not Contact Foreign Account',
      });
      // A non-owner member of the SAME account. `account_audit_log.actor_user_id`
      // is an FK to `users`, so the actor a clear attributes to must really exist.
      await db`
        INSERT INTO users (id, name, email, role, account_id)
        VALUES (${staffUserId}::uuid, 'Do Not Contact Staff',
                ${`staff-${staffUserId}@test.local`}, 'owner', ${tenant.accountId}::uuid)
      `;
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
          if (otherTenant) {
            await db`DELETE FROM solicitation_suppressions WHERE account_id = ${otherTenant.accountId}::uuid`;
          }
          await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
          await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
          // The extra account member goes before the account it belongs to.
          await db`DELETE FROM users WHERE id = ${staffUserId}::uuid`;
          if (tenant) await cleanupTenantAccount(db, tenant);
          if (otherTenant) await cleanupTenantAccount(db, otherTenant);
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

    it('repeating owner do-not-contact is a no-op against the account partial unique index', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Repeat Marker',
        email: contactEmail,
        visitDates: ['2026-03-04'],
      });
      const input = ownerInput(contactId);

      expect(await markContactDoNotContact(sql(), input)).toBe('marked');
      // First-write-wins (§2.1) reaches this wrapper through recordSuppression's
      // ON CONFLICT path — a second click is a no-op success, not an error and
      // not a second row.
      expect(await markContactDoNotContact(sql(), input)).toBe('already_marked');

      const rows = await sql()<{ id: string }[]>`
        SELECT id FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(rows).toHaveLength(1);
    });

    it('attributes owner do-not-contact to the authenticated owner user', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Attributed Contact',
        email: contactEmail,
        visitDates: ['2026-03-05'],
      });

      // Acted on by a member who is NOT the account owner: attribution must
      // follow the actor the route authenticated, never the account's owner row.
      expect(await markContactDoNotContact(sql(), {
        ...ownerInput(contactId),
        actorUserId: staffUserId,
      })).toBe('marked');

      const [row] = await sql()<{ created_by_user_id: string | null }[]>`
        SELECT created_by_user_id FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(row?.created_by_user_id).toBe(staffUserId);
      expect(row?.created_by_user_id).not.toBe(seed().userId);
    });

    it('a foreign account can neither mark nor clear another account contact', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Someone Else Customer',
        email: contactEmail,
        visitDates: ['2026-03-06'],
      });
      expect(await markContactDoNotContact(sql(), ownerInput(contactId))).toBe('marked');

      const foreignInput = {
        accountId: foreignSeed().accountId,
        businessId,
        contactId,
        actorUserId: foreignSeed().userId,
      };

      // The `businesses` join IS the account-scope check, so the foreign caller
      // cannot tell this contact from one that does not exist.
      expect(await markContactDoNotContact(sql(), foreignInput)).toBe('not_found');
      expect(await clearContactDoNotContact(sql(), foreignInput)).toBe('not_found');

      const rows = await sql()<{ account_id: string | null }[]>`
        SELECT account_id FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(rows).toEqual([{ account_id: seed().accountId }]);
      const audit = await sql()<{ id: string }[]>`
        SELECT id FROM account_audit_log
        WHERE event_type = 'solicitation_do_not_contact_cleared'
      `;
      expect(audit).toHaveLength(0);
    });

    it('clearing one account row leaves the global row and every other account row untouched', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Shared Handle Customer',
        email: contactEmail,
        visitDates: ['2026-03-07'],
      });

      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'global',
        channel: 'email',
        normalizedHandle: contactEmail,
        accountId: null,
        source: 'complaint',
      }));
      // A second tenant's own do-not-contact on the same Normalized handle:
      // three independent rows, three independent facts.
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'account',
        channel: 'email',
        normalizedHandle: contactEmail,
        accountId: foreignSeed().accountId,
        source: 'owner_manual',
        createdByUserId: foreignSeed().userId,
      }));
      expect(await markContactDoNotContact(sql(), ownerInput(contactId))).toBe('marked');

      expect(await clearContactDoNotContact(sql(), ownerInput(contactId))).toBe('cleared');

      const remaining = await sql()<{ scope: string; account_id: string | null }[]>`
        SELECT scope, account_id FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
        ORDER BY scope
      `;
      // §7.6's predicate carries `account_id = <the caller's>`, so one owner's
      // control can never reach another tenant's row or the recipient's own.
      expect(remaining).toEqual([
        { scope: 'account', account_id: foreignSeed().accountId },
        { scope: 'global', account_id: null },
      ]);
    });

    it('a global-only suppression returns not_marked and writes no owner-clear audit row', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Globally Opted Out',
        email: contactEmail,
        visitDates: ['2026-03-08'],
      });
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'global',
        channel: 'email',
        normalizedHandle: contactEmail,
        accountId: null,
        source: 'unsubscribe_one_click',
      }));

      // The REAL SQL proof that an owner cannot clear a global row: the DELETE's
      // `scope = 'account' AND account_id = <caller's>` predicate matches
      // nothing, so there is no input to this function that reaches one.
      expect(await clearContactDoNotContact(sql(), ownerInput(contactId))).toBe('not_marked');

      const remaining = await sql()<{ scope: string }[]>`
        SELECT scope FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(remaining).toEqual([{ scope: 'global' }]);
      // Nothing was removed, so nothing is audited — an audit row here would
      // record a removal that never happened.
      const audit = await sql()<{ id: string }[]>`
        SELECT id FROM account_audit_log WHERE account_id = ${seed().accountId}::uuid
      `;
      expect(audit).toHaveLength(0);
    });

    it('owner clear writes the exact audit actor account location entity and payload without the normalized handle', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Audited Clear',
        email: contactEmail,
        visitDates: ['2026-03-09'],
      });
      const input = { ...ownerInput(contactId), actorUserId: staffUserId };
      expect(await markContactDoNotContact(sql(), input)).toBe('marked');
      const [marked] = await sql()<{ id: string; suppressed_at: string }[]>`
        SELECT id, suppressed_at::text AS suppressed_at FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;

      expect(await clearContactDoNotContact(sql(), input)).toBe('cleared');

      const entries = await sql()<{
        account_id: string;
        location_id: string | null;
        actor_user_id: string | null;
        event_type: string;
        entity_type: string | null;
        entity_id: string | null;
        payload: unknown;
      }[]>`
        SELECT account_id, location_id, actor_user_id, event_type,
               entity_type, entity_id, payload
        FROM account_audit_log
        WHERE account_id = ${seed().accountId}::uuid
      `;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        account_id: seed().accountId,
        location_id: businessId,
        actor_user_id: staffUserId,
        event_type: 'solicitation_do_not_contact_cleared',
        entity_type: 'solicitation_suppression',
        // The removed row's id is the correlation key (§9.5) — it is what lets
        // an investigator join back to the ledger without the record itself
        // naming a person.
        entity_id: marked!.id,
      });
      // PgBouncer can hand JSONB back as a string; either way the assertion is
      // on the serialized text, which is the shape §9.5 constrains.
      const payload = entries[0]!.payload;
      const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
      expect(JSON.parse(serialized)).toEqual({
        channel: 'email',
        scope: 'account',
        markedByUserId: staffUserId,
        markedAt: marked!.suppressed_at,
      });
      // The whole point of §9.5: the entry names users, an account and a
      // location — never the recipient.
      expect(serialized).not.toContain(contactEmail);
    });

    it('owner clear records who marked the suppression, not only who cleared it', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Two Actor Clear',
        email: contactEmail,
        visitDates: ['2026-03-15'],
      });

      // Marked by the staff member, cleared by the account owner. The DELETE is
      // the last read of the removed row, so if the audit entry does not carry
      // the marker forward nothing in the system can say who put it there —
      // exactly the evidence the Correction path snapshots (D-A11).
      expect(await markContactDoNotContact(sql(), {
        ...ownerInput(contactId),
        actorUserId: staffUserId,
      })).toBe('marked');
      const [marked] = await sql()<{ id: string; suppressed_at: string }[]>`
        SELECT id, suppressed_at::text AS suppressed_at FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;

      expect(await clearContactDoNotContact(sql(), ownerInput(contactId))).toBe('cleared');

      const [entry] = await sql()<{ actor_user_id: string | null; payload: unknown }[]>`
        SELECT actor_user_id, payload FROM account_audit_log
        WHERE account_id = ${seed().accountId}::uuid
          AND event_type = 'solicitation_do_not_contact_cleared'
      `;
      const payload = entry!.payload;
      const parsed = JSON.parse(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      ) as { markedByUserId: string | null; markedAt: string };

      // Two different users, and the entry keeps them apart: the actor cleared,
      // the payload names the one who marked.
      expect(entry!.actor_user_id).toBe(seed().userId);
      expect(parsed.markedByUserId).toBe(staffUserId);
      expect(parsed.markedByUserId).not.toBe(entry!.actor_user_id);
      expect(parsed.markedAt).toBe(marked!.suppressed_at);
    });

    it('owner clear rolls back the suppression delete when the audit insert fails', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Rollback Customer',
        email: contactEmail,
        visitDates: ['2026-03-10'],
      });
      expect(await markContactDoNotContact(sql(), ownerInput(contactId))).toBe('marked');

      // `account_audit_log.actor_user_id` is an FK to `users`, so an actor that
      // does not exist makes the audit insert fail AFTER the DELETE. Failing
      // safe on this path means KEEPING the suppression: a lost opt-out is the
      // one outcome §7.6 must never produce.
      await expect(clearContactDoNotContact(sql(), {
        ...ownerInput(contactId),
        actorUserId: randomUUID(),
      })).rejects.toThrow();

      const remaining = await sql()<{ scope: string }[]>`
        SELECT scope FROM solicitation_suppressions
        WHERE channel = 'email' AND normalized_handle = ${contactEmail}
      `;
      expect(remaining).toEqual([{ scope: 'account' }]);
    });

    it('deleting and re-uploading the same handle does not clear its suppression', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Churned Customer',
        email: contactEmail,
        visitDates: ['2026-03-11'],
      });
      expect(await markContactDoNotContact(sql(), ownerInput(contactId))).toBe('marked');

      expect(await deleteContact(sql(), seed().accountId, businessId, contactId)).toBe(true);
      // Re-ingested tomorrow as a brand-new contact row with the same address.
      const rebuiltContactId = await seedContact({
        name: 'Churned Customer',
        email: contactEmail,
        visitDates: ['2026-03-12'],
      });
      expect(rebuiltContactId).not.toBe(contactId);

      // The ledger keys on the Normalized handle, never the contact row id
      // (#535 §6), so delete-and-re-upload cannot launder an opt-out back into
      // contactability. Attestation never overrides suppression.
      const { contacts } = await listContacts(
        sql(), seed().accountId, businessId, { limit: 50, offset: 0 },
      );
      expect(contacts.find((contact) => contact.id === rebuiltContactId)?.suppression)
        .toMatchObject({ state: 'account', clearableByOwner: true });
    });

    it('listContacts ignores an account suppression owned by another account for the same handle', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Other Tenant Customer Too',
        email: contactEmail,
        visitDates: ['2026-03-13'],
      });
      await sql().begin((tx) => recordSuppression(tx, {
        scope: 'account',
        channel: 'email',
        normalizedHandle: contactEmail,
        accountId: foreignSeed().accountId,
        source: 'owner_manual',
        createdByUserId: foreignSeed().userId,
      }));

      const { contacts } = await listContacts(
        sql(), seed().accountId, businessId, { limit: 50, offset: 0 },
      );
      // Another tenant's do-not-contact is that tenant's preference, not a
      // recipient's revocation — surfacing it here would leak that a different
      // business marked this person (invariant #8, §7.4).
      expect(contacts.find((contact) => contact.id === contactId)?.suppression).toBeNull();
    });

    it('listContacts returns only the suppression display shape and never source or account provenance', async () => {
      const contactEmail = freshHandle();
      const contactId = await seedContact({
        name: 'Shape Check',
        email: contactEmail,
        visitDates: ['2026-03-14'],
      });
      expect(await markContactDoNotContact(sql(), {
        ...ownerInput(contactId),
        actorUserId: staffUserId,
      })).toBe('marked');

      const { contacts } = await listContacts(
        sql(), seed().accountId, businessId, { limit: 50, offset: 0 },
      );
      const listed = contacts.find((contact) => contact.id === contactId);
      expect(Object.keys(listed!.suppression!).sort())
        .toEqual(['clearableByOwner', 'detail', 'label', 'state']);

      // The API response is where §7.4's cross-tenant prohibition and FU-3 are
      // actually load-bearing: a component test cannot catch the route shipping
      // provenance to the browser.
      const serialized = JSON.stringify(contacts);
      for (const forbidden of [
        'account_id', 'accountId', 'accountName', 'source', 'note',
        seed().accountId, staffUserId, 'owner_manual',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  },
);
