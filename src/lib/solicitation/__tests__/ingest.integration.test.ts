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
  assertLocalTestDatabaseUrl,
  LIVE_DB_LOCK_HOOK_TIMEOUT_MS,
  resolveTestDatabaseUrl,
  type LiveDbLock,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_093_SOLICITATION_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { CONSENT_ATTESTATION_VERSION } from '../attestation';
import { deleteContact } from '../contacts-repo';
import {
  ingestContactsCsvUpload,
  parseIngestReportValue,
  terminalizeUploadForInactiveSubscription,
  type IngestReport,
} from '../ingest';

const testDatabaseUrl = resolveTestDatabaseUrl();

let db: postgresType.Sql | undefined;
let featureDatabaseLock: LiveDbLock | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('csv ingest integration database was not initialized');
  return db;
}

interface SeedUploadOptions {
  attestationVersion?: string;
  /** Postgres interval subtracted from NOW() for attested_at — seeded in SQL
   *  so ordering never depends on a JS Date round-trip. */
  attestedAgo?: string;
  /** Exact ISO timestamp (millisecond precision) for attested_at — lets two
   *  uploads share a byte-identical attested_at across transactions, which
   *  NOW()-relative seeding cannot. Takes precedence over attestedAgo. */
  attestedAt?: string;
}

async function seedUpload(csvText: string, options: SeedUploadOptions = {}): Promise<string> {
  const uploadId = randomUUID();
  const attestationVersion = options.attestationVersion ?? CONSENT_ATTESTATION_VERSION;
  const attestedAtExpr = options.attestedAt !== undefined
    ? sql()`${options.attestedAt}::timestamptz`
    : options.attestedAgo === undefined
      ? sql()`NOW()`
      : sql()`NOW() - ${options.attestedAgo}::interval`;
  await sql()`
    INSERT INTO contact_csv_uploads
      (id, account_id, business_id, filename, byte_size, content_sha256,
       raw_csv, status, attested_by_user_id, attested_at, attestation_version)
    VALUES
      (${uploadId}::uuid, ${tenant!.accountId}::uuid, ${businessId}::uuid,
       'customers.csv', ${Buffer.byteLength(csvText, 'utf8')},
       ${'0'.repeat(64)}, ${csvText}, 'pending',
       ${tenant!.userId}::uuid, ${attestedAtExpr}, ${attestationVersion})
  `;
  return uploadId;
}

interface ConsentRow {
  channel: string;
  normalized_handle: string;
  attestation_version: string;
  attested_at: string;
  source_upload_id: string | null;
  updated_at: string;
}

/** Timestamps read `::text` end-to-end so microsecond precision survives —
 *  updated_at churn assertions must not be blurred by the JS Date truncation. */
async function readConsentRows(): Promise<ConsentRow[]> {
  return sql()<ConsentRow[]>`
    SELECT channel, normalized_handle, attestation_version,
           attested_at::text AS attested_at,
           source_upload_id::text AS source_upload_id,
           updated_at::text AS updated_at
    FROM solicitation_consent
    WHERE business_id = ${businessId}::uuid
    ORDER BY normalized_handle
  `;
}

async function readConsentAnalyticsEvents(): Promise<{ event_name: string; event_key: string; properties: unknown }[]> {
  return sql()<{ event_name: string; event_key: string; properties: unknown }[]>`
    SELECT event_name, event_key, properties
    FROM analytics_events
    WHERE business_id = ${businessId}::uuid
      AND event_name IN ('solicitation_consent_recorded', 'solicitation_consent_upgraded')
    ORDER BY event_name, event_key
  `;
}

function parseEventProperties(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('analytics_events.properties was not an object');
  }
  return parsed as Record<string, unknown>;
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

describeWithDb('contacts CSV ingest against live local Postgres', {
  enabled: Boolean(testDatabaseUrl),
  timeout: 30_000,
}, () => {
  beforeAll(async () => {
    const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
    featureDatabaseLock = await acquireLiveDbLock(databaseUrl);
    db = postgres(databaseUrl, { max: 1, prepare: false });
    await assertSchemaReady(db, [MIGRATION_093_SOLICITATION_CONSENT]);
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
  }, LIVE_DB_LOCK_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await sql()`
      DELETE FROM job_outbox
      WHERE aggregate_type = 'solicitation_batch'
        AND payload->>'business_id' = ${businessId}
    `;
    await sql()`DELETE FROM analytics_events WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_consent WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_visits WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM solicitation_contacts WHERE business_id = ${businessId}::uuid`;
    await sql()`DELETE FROM contact_csv_uploads WHERE business_id = ${businessId}::uuid`;
    delete process.env.SOLICITATION_WATCH_ENABLED;
  });

  afterAll(async () => {
    try {
      if (db) {
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
  }, 120_000);

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

  it('counts contactsMerged only for handle merges — a name-only refresh is uncounted', async () => {
    await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,',
    ].join('\n')));

    // Name-only refresh: matched by email, no new handle. The row updates
    // (latest non-empty name wins) but is NOT a merge (§1.2, PR #564 review).
    const nameOnly = await runIngest(await seedUpload([
      HEADER,
      'Ada L.,ada@example.com,,2026-01-06,',
    ].join('\n')));
    expect(nameOnly).toMatchObject({
      contactsCreated: 0, contactsMerged: 0, visitsAdded: 1,
    });
    const [renamed] = await sql()<{ name: string }[]>`
      SELECT name FROM solicitation_contacts WHERE business_id = ${businessId}::uuid
    `;
    expect(renamed!.name).toBe('Ada L.');

    // Handle merge: the phone lands on the matched contact — counted.
    const handleMerge = await runIngest(await seedUpload([
      HEADER,
      'Ada L.,ada@example.com,4155552671,2026-01-07,',
    ].join('\n')));
    expect(handleMerge).toMatchObject({
      contactsCreated: 0, contactsMerged: 1, visitsAdded: 1,
    });
    const [merged] = await sql()<{ phone: string | null }[]>`
      SELECT phone FROM solicitation_contacts WHERE business_id = ${businessId}::uuid
    `;
    expect(merged!.phone).toBe('+14155552671');
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

  it('completed CSV ingest creates exactly one unbuilt batch and build_solicitation_batch outbox row when watch-mode is enabled', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const uploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
    ].join('\n'));

    const report = await runIngest(uploadId);

    const rows = await sql()<{
      batch_id: string;
      source_upload_id: string;
      built_at: string | null;
      topic: string;
      aggregate_id: string;
      payload: unknown;
    }[]>`
      SELECT
        batch.id::text AS batch_id,
        batch.source_upload_id::text AS source_upload_id,
        batch.built_at::text AS built_at,
        outbox.topic,
        outbox.aggregate_id::text AS aggregate_id,
        outbox.payload
      FROM solicitation_batches batch
      JOIN job_outbox outbox
        ON outbox.aggregate_id = batch.id
       AND outbox.aggregate_type = 'solicitation_batch'
      WHERE batch.source_upload_id = ${uploadId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_upload_id: uploadId,
      built_at: null,
      topic: QUEUE_NAMES.BUILD_SOLICITATION_BATCH,
      aggregate_id: rows[0]!.batch_id,
    });
    expect(rows[0]!.payload).toMatchObject({
      batch_id: rows[0]!.batch_id,
      business_id: businessId,
    });

    expect(await ingestContactsCsvUpload(sql(), uploadId, businessId)).toEqual(report);
    const [counts] = await sql()<{
      batch_count: string;
      outbox_count: string;
    }[]>`
      SELECT
        (SELECT COUNT(*) FROM solicitation_batches
         WHERE source_upload_id = ${uploadId}::uuid)::text AS batch_count,
        (SELECT COUNT(*) FROM job_outbox
         WHERE aggregate_type = 'solicitation_batch'
           AND aggregate_id = ${rows[0]!.batch_id}::uuid)::text AS outbox_count
    `;
    expect(counts).toEqual({ batch_count: '1', outbox_count: '1' });
  });

  it('completed CSV ingest creates no batch or build outbox when watch-mode is disabled', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'false';
    const uploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
    ].join('\n'));

    await runIngest(uploadId);

    const [counts] = await sql()<{
      batch_count: string;
      outbox_count: string;
    }[]>`
      SELECT
        (SELECT COUNT(*) FROM solicitation_batches
         WHERE source_upload_id = ${uploadId}::uuid)::text AS batch_count,
        (SELECT COUNT(*) FROM job_outbox
         WHERE aggregate_type = 'solicitation_batch'
           AND payload->>'business_id' = ${businessId})::text AS outbox_count
    `;
    expect(counts).toEqual({ batch_count: '0', outbox_count: '0' });
  });

  it('failed and subscription-inactive uploads create no batch or build outbox', async () => {
    process.env.SOLICITATION_WATCH_ENABLED = 'true';
    const structurallyFailedUploadId = await seedUpload([
      'name,email',
      'Ada Lovelace,ada@example.com',
    ].join('\n'));
    const inactiveUploadId = await seedUpload([
      HEADER,
      'Bob Byrne,,4155552671,2026-01-06,',
    ].join('\n'));

    const failedReport = await runIngest(structurallyFailedUploadId);
    await terminalizeUploadForInactiveSubscription(sql(), inactiveUploadId, businessId);

    expect(failedReport.structuralFailure).not.toBeNull();
    const uploads = await sql()<{ id: string; status: string }[]>`
      SELECT id::text AS id, status
      FROM contact_csv_uploads
      WHERE id IN (${structurallyFailedUploadId}::uuid, ${inactiveUploadId}::uuid)
      ORDER BY id
    `;
    expect(uploads).toEqual(
      [
        { id: structurallyFailedUploadId, status: 'failed' },
        { id: inactiveUploadId, status: 'failed' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const [counts] = await sql()<{
      batch_count: string;
      outbox_count: string;
    }[]>`
      SELECT
        (SELECT COUNT(*) FROM solicitation_batches
         WHERE source_upload_id IN (
           ${structurallyFailedUploadId}::uuid,
           ${inactiveUploadId}::uuid
         ))::text AS batch_count,
        (SELECT COUNT(*) FROM job_outbox
         WHERE aggregate_type = 'solicitation_batch'
           AND payload->>'business_id' = ${businessId})::text AS outbox_count
    `;
    expect(counts).toEqual({ batch_count: '0', outbox_count: '0' });
  });

  it('terminalizes a pending upload with a subscription_inactive report and clears the raw CSV', async () => {
    const uploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
    ].join('\n'));

    await terminalizeUploadForInactiveSubscription(sql(), uploadId, businessId);

    const [row] = await sql()<{
      status: string; raw_csv: string | null; report: unknown; completed_at: string | null;
    }[]>`
      SELECT status, raw_csv, report, completed_at::text AS completed_at
      FROM contact_csv_uploads
      WHERE id = ${uploadId}::uuid
    `;
    expect(row!.status).toBe('failed');
    expect(row!.raw_csv).toBeNull();
    expect(row!.completed_at).not.toBeNull();
    expect(parseIngestReportValue(row!.report)).toEqual({
      contactsCreated: 0,
      contactsMerged: 0,
      visitsAdded: 0,
      duplicateVisits: 0,
      rejected: [],
      structuralFailure: null,
      error: 'subscription_inactive',
    });
    expect(await countRows('solicitation_contacts')).toBe(0);

    // Idempotent + terminal-state safe: a second call is a status='pending'
    // guarded no-op that leaves the terminal row untouched.
    await terminalizeUploadForInactiveSubscription(sql(), uploadId, businessId);
    const [after] = await sql()<{ status: string }[]>`
      SELECT status FROM contact_csv_uploads WHERE id = ${uploadId}::uuid
    `;
    expect(after!.status).toBe('failed');
  });

  it('the §1.2 re-upload trap: re-uploading the identical CSV under v2 inserts zero visits AND upgrades the consent row', async () => {
    const csv = [
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
    ].join('\n');

    const uploadA = await seedUpload(csv, {
      attestationVersion: 'consent_attestation_v1',
      attestedAgo: '2 hours',
    });
    const firstReport = await runIngest(uploadA);
    expect(firstReport).toMatchObject({ contactsCreated: 1, visitsAdded: 1, duplicateVisits: 0 });

    const [seeded] = await readConsentRows();
    expect(seeded).toMatchObject({
      channel: 'email',
      normalized_handle: 'ada@example.com',
      attestation_version: 'consent_attestation_v1',
      source_upload_id: uploadA,
    });

    // The identical CSV re-uploaded under v2: every visit is a duplicate, yet
    // the consent ledger is exactly what makes the re-upload effective (§1.2).
    const uploadB = await seedUpload(csv, { attestationVersion: CONSENT_ATTESTATION_VERSION });
    const secondReport = await runIngest(uploadB);
    expect(secondReport.visitsAdded).toBe(0);
    expect(secondReport.duplicateVisits).toBeGreaterThan(0);

    const rows = await readConsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'email',
      normalized_handle: 'ada@example.com',
      attestation_version: CONSENT_ATTESTATION_VERSION,
      source_upload_id: uploadB,
    });

    // One recorded (upload A inserted the row) + one upgraded (upload B's
    // §4.2 DO UPDATE branch fired across a version change), never the handle.
    const events = await readConsentAnalyticsEvents();
    expect(events.map((event) => event.event_name)).toEqual([
      'solicitation_consent_recorded',
      'solicitation_consent_upgraded',
    ]);
    const upgraded = parseEventProperties(events[1]!.properties);
    expect(upgraded).toEqual({
      channel: 'email',
      from_version: 'consent_attestation_v1',
      to_version: CONSENT_ATTESTATION_VERSION,
    });
    for (const event of events) {
      expect(JSON.stringify(event.properties)).not.toContain('ada@example.com');
    }
  });

  it('monotonicity guard: a v1 write with an earlier attested_at cannot downgrade a v2 consent row', async () => {
    await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,',
    ].join('\n')));
    const [v2Row] = await readConsentRows();
    expect(v2Row!.attestation_version).toBe(CONSENT_ATTESTATION_VERSION);

    // The in-flight pre-deploy v1 job (§4.2): stamped before the v2 upload,
    // dispatched after it. Different visit date so its visits DO insert —
    // proving the guard rejected only the consent write, not the ingest.
    const v1Report = await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-02-14,Belated visit',
    ].join('\n'), {
      attestationVersion: 'consent_attestation_v1',
      attestedAgo: '3 hours',
    }));
    expect(v1Report.visitsAdded).toBe(1);

    const rows = await readConsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attestation_version).toBe(CONSENT_ATTESTATION_VERSION);
    expect(rows[0]!.attested_at).toBe(v2Row!.attested_at);
    // No churn: the guarded upsert must not touch the row at all.
    expect(rows[0]!.updated_at).toBe(v2Row!.updated_at);
    expect(rows[0]!.source_upload_id).toBe(v2Row!.source_upload_id);
  });

  it('monotone upsert idempotency: replaying the same csv_ingest job re-writes identical values as a no-op without updated_at churn', async () => {
    const uploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,Oil change',
    ].join('\n'));
    const report = await runIngest(uploadId);
    const [before] = await readConsentRows();
    expect(before).toBeDefined();

    // A BullMQ retry of the same job: the terminal upload no-ops and the
    // consent ledger must be byte-identical afterwards.
    const replay = await ingestContactsCsvUpload(sql(), uploadId, businessId);
    expect(replay).toEqual(report);

    const rows = await readConsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updated_at).toBe(before!.updated_at);
    expect(rows[0]!.attested_at).toBe(before!.attested_at);

    const events = await readConsentAnalyticsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event_name).toBe('solicitation_consent_recorded');
    expect(parseEventProperties(events[0]!.properties)).toEqual({
      channel: 'email',
      basis: 'owner_attested',
      attestation_version: CONSENT_ATTESTATION_VERSION,
    });
  });

  it('duplicate emails within one CSV hit the equal-attested_at guard: one consent row, one recorded event, no updated_at churn', async () => {
    // Millisecond precision on purpose: the upload row's attested_at
    // round-trips through a JS Date before the consent write, so microseconds
    // would be truncated anyway; ms keeps the seeded value byte-identical to
    // the bound one.
    const attestedAt = '2026-07-29T12:00:00.000Z';
    const uploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,First visit',
      'Ada Lovelace,ada@example.com,,2026-01-06,Second visit',
    ].join('\n'), { attestedAt });
    const report = await runIngest(uploadId);
    expect(report).toMatchObject({ contactsCreated: 1, visitsAdded: 2, rejected: [] });

    // The second row's write carried EXCLUDED.attested_at equal to the stored
    // one, so the §4.2 `>` guard rejected it: one row, one recorded event.
    const rows = await readConsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      normalized_handle: 'ada@example.com',
      source_upload_id: uploadId,
    });
    const firstUpdatedAt = rows[0]!.updated_at;
    const events = await readConsentAnalyticsEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event_name).toBe('solicitation_consent_recorded');

    // NOW() is transaction-pinned, so updated_at churn from the in-file
    // duplicate is unobservable above (a fired DO UPDATE would stamp the same
    // timestamp the INSERT defaulted to). A second upload sharing the SAME
    // attested_at — a distinct transaction — is what makes a `>` → `>=`
    // regression ship red: on equality the DO UPDATE must not fire.
    const replayUploadId = await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-03-01,',
    ].join('\n'), { attestedAt });
    await runIngest(replayUploadId);

    const after = await readConsentRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.updated_at).toBe(firstUpdatedAt);
    expect(after[0]!.source_upload_id).toBe(uploadId);
    expect(await readConsentAnalyticsEvents()).toHaveLength(1);
  });

  it('phone-matched rows whose email is not retained mint no consent row: the ledger stays deletable by contact sweep', async () => {
    const uploadA = await seedUpload([
      HEADER,
      'Priya Patel,priya@example.com,4155550100,2026-01-05,',
    ].join('\n'));
    await runIngest(uploadA);

    // Same person by phone, different email: §1.2 never overwrites an existing
    // handle, so the matched contact keeps priya@example.com and the incoming
    // email is discarded by matching.
    const uploadB = await seedUpload([
      HEADER,
      'Priya Patel,priya.new@example.com,4155550100,2026-02-01,',
    ].join('\n'));
    const report = await runIngest(uploadB);
    expect(report).toMatchObject({ contactsCreated: 0, visitsAdded: 1, rejected: [] });

    // §7.1 deletability: a consent row for the discarded handle would be
    // unreachable from any retained contact — deleteContact sweeps by the
    // contact's STORED email, so that row could never be deleted (orphaned
    // PII in a no-TTL ledger). The retained handle keeps its provenance:
    // upload B attested nothing the contact retains, so upload A stays the
    // source.
    const rows = await readConsentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'email',
      normalized_handle: 'priya@example.com',
      source_upload_id: uploadA,
    });

    const [contact] = await sql()<{ id: string }[]>`
      SELECT id::text AS id FROM solicitation_contacts
      WHERE business_id = ${businessId}::uuid
    `;
    expect(await deleteContact(sql(), tenant!.accountId, businessId, contact!.id)).toBe(true);
    const [remaining] = await sql()<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM solicitation_consent
      WHERE business_id = ${businessId}::uuid
    `;
    expect(remaining!.count).toBe('0');
  });

  it("no SMS rows: a CSV with phone handles produces zero channel='sms' consent rows", async () => {
    const report = await runIngest(await seedUpload([
      HEADER,
      'Ada Lovelace,ada@example.com,,2026-01-05,',
      'Bob Byrne,,4155552671,2026-01-06,',
      'Cara Chen,cara@example.com,4155559999,2026-01-07,',
    ].join('\n')));
    expect(report).toMatchObject({ contactsCreated: 3, visitsAdded: 3, rejected: [] });

    // DR3: consent rows exist for exactly the two email handles; the
    // phone-only contact (Bob) mints no row on any channel.
    const rows = await readConsentRows();
    expect(rows.map((row) => row.normalized_handle)).toEqual([
      'ada@example.com',
      'cara@example.com',
    ]);
    expect(rows.every((row) => row.channel === 'email')).toBe(true);

    const [smsCount] = await sql()<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM solicitation_consent
      WHERE business_id = ${businessId}::uuid AND channel = 'sms'
    `;
    expect(smsCount!.count).toBe('0');
  });
});
