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
  acquireLiveDbLock,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { deleteContact, listContacts } from '../contacts-repo';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
let otherTenant: TenantSeed | undefined;
// Serialises against the sibling solicitation live-DB suites, which write the
// same `solicitation_*` tables. Without it they deadlock one another.
let featureDatabaseLock: LiveDbLock | undefined;
const businessId = randomUUID();
const uploadId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('contacts repo integration database was not initialized');
  return db;
}

// Local-host refusal guard (mirrors the ingest integration suite): any
// localhost/127.0.0.1 Postgres is accepted, everything else — notably any
// Supabase/pooler host — is refused. Never widen this to remote hosts.
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
    throw new Error('contacts repo integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

async function seedContact(input: {
  name: string;
  email: string;
  visitDates: string[];
}): Promise<string> {
  const contactId = randomUUID();
  await sql()`
    INSERT INTO solicitation_contacts (id, business_id, name, email, created_by_upload_id)
    VALUES (${contactId}::uuid, ${businessId}::uuid, ${input.name}, ${input.email}, ${uploadId}::uuid)
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

async function countVisitsForContact(contactId: string): Promise<number> {
  const [row] = await sql()<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM solicitation_visits WHERE contact_id = ${contactId}::uuid
  `;
  return Number(row!.count);
}

async function contactExists(contactId: string): Promise<boolean> {
  const rows = await sql()<{ id: string }[]>`
    SELECT id FROM solicitation_contacts WHERE id = ${contactId}::uuid
  `;
  return rows.length > 0;
}

describeWithDb('contacts repo against live local Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const databaseUrl = assertExactLocalDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'Contacts Repo Integration Owner',
      accountDisplayName: 'Contacts Repo Integration Account',
    });
    otherTenant = await seedTenantAccount(db, {
      userName: 'Contacts Repo Foreign Owner',
      accountDisplayName: 'Contacts Repo Foreign Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (
        ${businessId}::uuid,
        'Contacts Repo Integration Business',
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
    await sql()`DELETE FROM solicitation_visits WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
  });

  // Release in the reverse of acquisition order, and on every path: a
  // `beforeAll` that failed after taking the lock still holds it, and a leaked
  // advisory lock blocks every other live-DB suite until the session dies.
  afterAll(async () => {
    try {
      if (db) {
        await db`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
        await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
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

  it('hard delete removes the contact and cascades its visits', async () => {
    const targetId = await seedContact({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      visitDates: ['2026-01-05', '2026-02-01'],
    });
    const bystanderId = await seedContact({
      name: 'Bob Byrne',
      email: 'bob@example.com',
      visitDates: ['2026-01-06'],
    });

    // Cross-tenant: a different account's delete attempt returns false and
    // deletes nothing — the businesses join is the account-scope check.
    const foreignAttempt = await deleteContact(
      sql(), otherTenant!.accountId, businessId, targetId,
    );
    expect(foreignAttempt).toBe(false);
    expect(await contactExists(targetId)).toBe(true);
    expect(await countVisitsForContact(targetId)).toBe(2);

    const deleted = await deleteContact(sql(), tenant!.accountId, businessId, targetId);
    expect(deleted).toBe(true);
    expect(await contactExists(targetId)).toBe(false);
    expect(await countVisitsForContact(targetId)).toBe(0);

    // The bystander contact and its visits are untouched.
    expect(await contactExists(bystanderId)).toBe(true);
    expect(await countVisitsForContact(bystanderId)).toBe(1);

    // Deleting an already-deleted contact reports false (uniform 404 upstream).
    expect(await deleteContact(sql(), tenant!.accountId, businessId, targetId)).toBe(false);
  });

  it('lists a bounded page ordered by most recent visit', async () => {
    const adaId = await seedContact({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      visitDates: ['2026-01-05', '2026-03-01'],
    });
    const bobId = await seedContact({
      name: 'Bob Byrne',
      email: 'bob@example.com',
      visitDates: ['2026-02-10'],
    });
    const caraId = await seedContact({
      name: 'Cara Chen',
      email: 'cara@example.com',
      visitDates: ['2026-01-20'],
    });

    const firstPage = await listContacts(
      sql(), tenant!.accountId, businessId, { limit: 2, offset: 0 },
    );
    expect(firstPage.total).toBe(3);
    expect(firstPage.contacts.map((contact) => contact.id)).toEqual([adaId, bobId]);
    expect(firstPage.contacts[0]).toEqual({
      id: adaId,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: null,
      lastVisitDate: '2026-03-01',
      visitCount: 2,
    });

    const secondPage = await listContacts(
      sql(), tenant!.accountId, businessId, { limit: 2, offset: 2 },
    );
    expect(secondPage.total).toBe(3);
    expect(secondPage.contacts.map((contact) => contact.id)).toEqual([caraId]);

    // Cross-tenant read: the wrong account sees nothing at all.
    const foreignPage = await listContacts(
      sql(), otherTenant!.accountId, businessId, { limit: 2, offset: 0 },
    );
    expect(foreignPage).toEqual({ contacts: [], total: 0 });
  });
});
