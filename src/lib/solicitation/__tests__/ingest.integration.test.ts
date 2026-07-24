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
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { ingestContactsCsvUpload, type IngestReport } from '../ingest';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('csv ingest integration database was not initialized');
  return db;
}

// Local-host refusal guard (mirrors the governor integration suite): any
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
    throw new Error('csv ingest integration requires a local (localhost) test database');
  }
  return databaseUrl;
}

async function seedUpload(csvText: string): Promise<string> {
  const uploadId = randomUUID();
  await sql()`
    INSERT INTO contact_csv_uploads
      (id, account_id, business_id, filename, byte_size, content_sha256,
       raw_csv, status, attested_by_user_id, attested_at, attestation_version)
    VALUES
      (${uploadId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
       'customers.csv', ${Buffer.byteLength(csvText, 'utf8')},
       ${'0'.repeat(64)}, ${csvText}, 'pending',
       ${tenant!.userId}::uuid, NOW(), ${CONSENT_ATTESTATION_VERSION})
  `;
  return uploadId;
}

async function runIngest(uploadId: string): Promise<IngestReport> {
  const report = await ingestContactsCsvUpload(sql(), uploadId, businessId);
  if (report === null) throw new Error(`expected a report for upload ${uploadId}`);
  return report;
}

async function countRows(table: 'solicitation_contacts' | 'solicitation_visits'): Promise<number> {
  const [row] = table === 'solicitation_contacts'
    ? await sql()<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM solicitation_contacts WHERE business_id = ${businessId}::uuid
      `
    : await sql()<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM solicitation_visits WHERE business_id = ${businessId}::uuid
      `;
  return Number(row!.count);
}

const HEADER = 'name,email,phone,last_visit_date,note';

describeWithDb('contacts CSV ingest against live local Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    tenant = await seedTenantAccount(db, {
      userName: 'CSV Ingest Integration Owner',
      accountDisplayName: 'CSV Ingest Integration Account',
    });
    await db`
      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
      VALUES (
        ${businessId}::uuid,
        'CSV Ingest Integration Business',
        'CSV Owner',
        ${tenant.ownerEmail},
        ${tenant.accountId}::uuid,
        'active'
      )
    `;
  });

  afterEach(async () => {
    await sql()`DELETE FROM solicitation_visits WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
  });

  afterAll(async () => {
    if (!db) return;
    await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
    if (tenant) await cleanupTenantAccount(db, tenant);
    await db.end();
  });

  it('re-uploading an overlapping export adds no new visits and reports duplicate_visit', async () => {
    const firstCsv = [
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
      'Bob Byrne,,4155552671,2026-01-06,',
    ].join('\n');
    const firstReport = await runIngest(await seedUpload(firstCsv));
    expect(firstReport).toMatchObject({
      contactsCreated: 2, visitsAdded: 2, duplicateVisits: 0, rejected: [],
    });

    const overlappingCsv = [
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
      'Bob Byrne,,4155552671,2026-01-06,',
      'Bob Byrne,,4155552671,2026-02-01,Brake pads',
    ].join('\n');
    const secondReport = await runIngest(await seedUpload(overlappingCsv));

    expect(secondReport).toMatchObject({
      contactsCreated: 0, visitsAdded: 1, duplicateVisits: 2, rejected: [],
    });
    expect(await countRows('solicitation_contacts')).toBe(2);
    expect(await countRows('solicitation_visits')).toBe(3);
  });

  it('a non-empty note on a duplicate visit refreshes the stored note', async () => {
    await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Original note',
    ].join('\n')));

    const report = await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Refreshed note',
    ].join('\n')));
    expect(report).toMatchObject({ visitsAdded: 0, duplicateVisits: 1 });

    const [visit] = await sql()<{ note: string | null }[]>`
      SELECT note FROM solicitation_visits WHERE business_id = ${businessId}::uuid
    `;
    expect(visit!.note).toBe('Refreshed note');

    // An empty incoming note on the same duplicate keeps the stored note.
    await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,',
    ].join('\n')));
    const [kept] = await sql()<{ note: string | null }[]>`
      SELECT note FROM solicitation_visits WHERE business_id = ${businessId}::uuid
    `;
    expect(kept!.note).toBe('Refreshed note');
  });

  it('partial accept: valid rows land while invalid rows are reported', async () => {
    // Seed two distinct contacts so a later row can straddle them.
    await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,',
      'Bob Byrne,,4155552671,2026-01-06,',
    ].join('\n')));

    const report = await runIngest(await seedUpload([
      HEADER,
      'Cara Chen,cara@example.com,,2026-03-01,New customer',
      ',missing-name@example.com,,2026-03-02,',
      'Ada Or Bob,ada@example.com,4155552671,2026-03-03,',
    ].join('\n')));

    expect(report.contactsCreated).toBe(1);
    expect(report.visitsAdded).toBe(1);
    expect(report.structuralFailure).toBeNull();
    expect(report.rejected).toEqual([
      { row: 2, reason: 'missing_name' },
      { row: 3, reason: 'ambiguous_identity' },
    ]);
    expect(await countRows('solicitation_contacts')).toBe(3);
    expect(await countRows('solicitation_visits')).toBe(3);
  });

  it('clears raw CSV text in the same transaction as the terminal report', async () => {
    const uploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
    ].join('\n'));
    const report = await runIngest(uploadId);

    // The contact_csv_uploads_terminal_consistency CHECK makes a terminal row
    // with raw CSV (or a cleared pending row) unrepresentable, so observing
    // status + report + NULL raw_csv on one row proves the single-transaction
    // write — there is no committed intermediate state to race.
    const [row] = await sql()<{
      status: string; raw_csv: string | null; report: unknown; completed_at: string | null;
    }[]>`
      SELECT status, raw_csv, report, completed_at::text AS completed_at
      FROM contact_csv_uploads
      WHERE id = ${uploadId}::uuid
    `;
    expect(row!.status).toBe('completed');
    expect(row!.raw_csv).toBeNull();
    expect(row!.completed_at).not.toBeNull();
    const storedReport: unknown = typeof row!.report === 'string'
      ? JSON.parse(row!.report)
      : row!.report;
    expect(storedReport).toEqual(report);

    // Idempotent retry: a re-run of the terminal upload no-ops and returns
    // the stored report without touching contacts or visits.
    const retried = await ingestContactsCsvUpload(sql(), uploadId, businessId);
    expect(retried).toEqual(report);
    expect(await countRows('solicitation_visits')).toBe(1);
  });
});
