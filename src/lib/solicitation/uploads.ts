/**
 * Upload lane for the contacts/visits CSV (#541, contract #535 §3/§4):
 * persists the raw CSV + consent attestation and enqueues the csv_ingest
 * follow-up in ONE transaction (transactional outbox, invariant #2).
 * Domain module — receives its DB client explicitly (invariant #15).
 */

import { createHash } from 'node:crypto'; // invariant #10: node:crypto only
import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import { MAX_UPLOAD_BYTES } from './contacts-csv';
import { CONSENT_ATTESTATION_VERSION } from './attestation';
import { parseIngestReportValue, type IngestReport } from './ingest';
import { UPLOAD_STATUSES, type ContactUploadStatus } from './upload-status';
import { enqueueCsvIngest } from '@/lib/shared/job-outbox-helpers';

export type CreateUploadResult =
  | { ok: true; uploadId: string }
  | { ok: false; error: 'attestation_required' | 'file_too_large' | 'empty_file' };

/** Persists the upload row (raw CSV + consent attestation) AND the csv_ingest
 *  outbox row in ONE transaction (invariants #1/#2). The route has already
 *  authenticated the owner and resolved businessId to their account. */
export async function createContactsCsvUpload(sql: Sql, input: {
  accountId: string;
  businessId: string;
  attestedByUserId: string;
  attestationAccepted: boolean;
  filename: string;
  csvText: string;
}): Promise<CreateUploadResult> {
  if (!input.attestationAccepted) return { ok: false, error: 'attestation_required' };

  const byteSize = Buffer.byteLength(input.csvText, 'utf8');
  if (byteSize === 0) return { ok: false, error: 'empty_file' };
  if (byteSize > MAX_UPLOAD_BYTES) return { ok: false, error: 'file_too_large' };

  const uploadId = uuidv7();
  const sha256 = createHash('sha256').update(input.csvText).digest('hex');

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO contact_csv_uploads
        (id, account_id, business_id, filename, byte_size, content_sha256,
         raw_csv, status, attested_by_user_id, attested_at, attestation_version)
      VALUES
        (${uploadId}, ${input.accountId}, ${input.businessId}, ${input.filename},
         ${byteSize}, ${sha256}, ${input.csvText}, ${UPLOAD_STATUSES.PENDING},
         ${input.attestedByUserId}, NOW(), ${CONSENT_ATTESTATION_VERSION})
    `;
    await enqueueCsvIngest(tx, { uploadId, businessId: input.businessId });
  });

  return { ok: true, uploadId };
}

/** Terminal ingest report as stored JSONB. IngestReport (ingest.ts) is the
 *  authoritative shape; the only writers are ingestContactsCsvUpload and the
 *  csv-ingest failed-hook, so the read-side cast below is against a
 *  single-owner, code-controlled shape. */
export type UploadStatusReport = IngestReport | null;

export interface UploadStatus {
  id: string;
  status: ContactUploadStatus;
  filename: string;
  createdAt: string;
  completedAt: string | null;
  report: UploadStatusReport;
}

/** Tenant-scoped status/report read (never returns raw_csv). Scoped by BOTH
 *  account_id AND business_id (invariant #8 — per-location data): the route
 *  passes the business resolved from its location context, so a
 *  location-scoped user cannot read another location's upload. */
export async function getUploadStatus(
  sql: Sql,
  accountId: string,
  businessId: string,
  uploadId: string,
): Promise<UploadStatus | null> {
  const rows = await sql<{
    id: string;
    status: ContactUploadStatus;
    filename: string;
    created_at: string;
    completed_at: string | null;
    report: unknown;
  }[]>`
    SELECT id, status, filename,
           created_at::text AS created_at,
           completed_at::text AS completed_at,
           report
    FROM contact_csv_uploads
    WHERE id = ${uploadId}
      AND account_id = ${accountId}
      AND business_id = ${businessId}
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    filename: row.filename,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    // Stored-report JSONB parsing has ONE owner: parseIngestReportValue in
    // ingest.ts (the CLAUDE.md-allowlisted PgBouncer carve-out site). Null on
    // a non-object value is this read side's tolerance posture.
    report: parseIngestReportValue(row.report),
  };
}
