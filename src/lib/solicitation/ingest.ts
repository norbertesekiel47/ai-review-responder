/**
 * Ingest lane for the contacts/visits CSV (#541, contract #535 §1.2/§1.3/§3):
 * match/merge/upsert of contacts + visits, terminal report, raw CSV clearing.
 *
 * Concurrency contract: ALL DB work happens inside ONE transaction whose FIRST
 * statement takes `pg_advisory_xact_lock(hashtext('csv_ingest_' || businessId))`.
 * The per-business advisory lock serializes concurrent ingests AND the
 * failed-hook terminalizer (worker/jobs/csv-ingest/failed-hook.ts takes the
 * SAME lock), so read-then-write matching cannot double-create a contact and
 * terminalization cannot race an in-flight retry. Plain FOR UPDATE cannot
 * cover not-yet-existing contact rows; the PgBouncer FOR-UPDATE gotcha does
 * not apply because the lock is xact-scoped INSIDE sql.begin. Holding the
 * lock across the whole ≤5,000-row transaction is the intended semantics:
 * one ingest per business at a time, bounded by the row cap.
 *
 * PII contract: this module NEVER logs names, emails, phones, notes, or raw
 * CSV text — counts and reason histograms only.
 *
 * Domain module — receives its DB client explicitly (invariant #15).
 */

import { v7 as uuidv7 } from 'uuid'; // invariant #10 posture: uuid lib is the repo-standard UUIDv7 source
import type { Sql, TransactionSql } from 'postgres';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  MAX_UPLOAD_BYTES,
  parseContactsCsv,
  type ContactCandidate,
  type RejectedRow,
  type StructuralFailure,
} from './contacts-csv';

export interface ExistingContact { id: string; name: string; email: string | null; phone: string | null; }

export type ContactMatchDecision =
  | { action: 'create' }
  | { action: 'reject'; reason: 'ambiguous_identity' }
  | { action: 'update'; contactId: string; set: Partial<{ name: string; email: string; phone: string }> };

/** Pure §1.2 matching decision: byEmail/byPhone are the lookup results for the
 *  candidate's normalized handles (null when handle absent or no match).
 *  NEVER merges two existing contacts — distinct matches reject. */
export function resolveContactMatch(
  candidate: { name: string; email: string | null; phone: string | null },
  byEmail: ExistingContact | null,
  byPhone: ExistingContact | null,
): ContactMatchDecision {
  if (byEmail === null && byPhone === null) return { action: 'create' };
  if (byEmail !== null && byPhone !== null && byEmail.id !== byPhone.id) {
    return { action: 'reject', reason: 'ambiguous_identity' };
  }

  const matched = byEmail ?? byPhone!;
  const set: Partial<{ name: string; email: string; phone: string }> = {};
  // §1.2: a matched contact merges in a handle it lacked. An existing handle
  // is never overwritten — replacing it would silently change an identity.
  if (candidate.email !== null && matched.email === null) set.email = candidate.email;
  if (candidate.phone !== null && matched.phone === null) set.phone = candidate.phone;
  // §1.2: latest non-empty name wins. A name identical to the stored one is
  // only written when a handle merge updates the row anyway — a name-only
  // no-change row must produce an empty `set` so the caller skips the UPDATE.
  const merging = set.email !== undefined || set.phone !== undefined;
  if (candidate.name.length > 0 && (candidate.name !== matched.name || merging)) {
    set.name = candidate.name;
  }
  return { action: 'update', contactId: matched.id, set };
}

export interface IngestReport {
  contactsCreated: number; contactsMerged: number; visitsAdded: number;
  duplicateVisits: number; rejected: RejectedRow[];
  structuralFailure: StructuralFailure | null;
  /** Set only by the failed-hook when BullMQ retries are exhausted — lets the
   *  UI render a terminal failure state distinct from structural rejection. */
  error?: 'ingest_failed';
}

interface UploadRow {
  id: string;
  business_id: string;
  status: string;
  byte_size: number;
  raw_csv: string | null;
  report: unknown;
}

const logger = createWorkerLogger('[csv-ingest]');

/** Worker-facing single entry point: loads the upload row, parses, matches,
 *  upserts Contacts + Visits, writes the terminal report AND NULLs raw_csv in
 *  ONE transaction. Idempotent: a retried job re-processing an upload finds
 *  visits/handles already present (visit unique key + handle merge are natural
 *  upserts) and terminal uploads (status != 'pending') no-op immediately. */
export async function ingestContactsCsvUpload(
  sql: Sql,
  uploadId: string,
  expectedBusinessId: string,
): Promise<IngestReport | null> {
  // Computed ONCE per ingest so every row is validated against the same day.
  const todayUtc = new Date().toISOString().slice(0, 10);

  return sql.begin(async (tx) => {
    // Lock FIRST, before any status read — a pre-lock peek could see a stale
    // 'pending' that a concurrent run terminalizes before we acquire the lock.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`csv_ingest_${expectedBusinessId}`}))`;

    const [upload] = await tx<UploadRow[]>`
      SELECT id, business_id, status, byte_size, raw_csv, report
      FROM contact_csv_uploads
      WHERE id = ${uploadId}
    `;
    if (!upload) {
      logger.warn('upload row missing — nothing to ingest', { upload_id: uploadId });
      return null;
    }
    if (upload.status !== 'pending') {
      // Idempotent retry / lost race against a concurrent run: both are the
      // same no-op — return the stored terminal report.
      return parseStoredReport(upload);
    }

    if (upload.business_id !== expectedBusinessId) {
      // The route wrote upload row + outbox payload in one transaction, so a
      // mismatch is an impossible state, not a branch to tolerate.
      throw new Error(
        `csv_ingest business mismatch: upload ${uploadId} belongs to ${upload.business_id}, job expected ${expectedBusinessId}`,
      );
    }
    if (upload.raw_csv === null) {
      // Unrepresentable per the contact_csv_uploads_terminal_consistency CHECK.
      throw new Error(`csv_ingest impossible state: pending upload ${uploadId} has NULL raw_csv`);
    }

    // Defensive boundary re-check — the route already enforces the cap.
    if (upload.byte_size > MAX_UPLOAD_BYTES) {
      return terminalizeUpload(tx, uploadId, 'failed', structuralReport('byte_size_over_cap'));
    }

    const parsed = parseContactsCsv(upload.raw_csv, todayUtc);
    if ('structuralFailure' in parsed) {
      return terminalizeUpload(tx, uploadId, 'failed', structuralReport(parsed.structuralFailure));
    }

    // Bounded memory: MAX_DATA_ROWS (5,000) caps the candidate list, so
    // whole-file in-memory processing is fine.
    const report = await upsertCandidates(tx, expectedBusinessId, uploadId, parsed.candidates, parsed.rejected);
    await terminalizeUpload(tx, uploadId, 'completed', report);

    logger.log('csv ingest completed', {
      upload_id: uploadId,
      contacts_created: report.contactsCreated,
      contacts_merged: report.contactsMerged,
      visits_added: report.visitsAdded,
      duplicate_visits: report.duplicateVisits,
      rejected_total: report.rejected.length,
      ...rejectionHistogram(report.rejected),
    });
    return report;
  });
}

/** Match + upsert every candidate row. Runs inside the caller's locked tx. */
async function upsertCandidates(
  tx: TransactionSql,
  businessId: string,
  uploadId: string,
  candidates: ContactCandidate[],
  parseRejected: RejectedRow[],
): Promise<IngestReport> {
  let contactsCreated = 0;
  let contactsMerged = 0;
  let visitsAdded = 0;
  let duplicateVisits = 0;
  const rejected: RejectedRow[] = [...parseRejected];

  for (const candidate of candidates) {
    const byEmail = candidate.email === null ? null : await findContactByHandle(tx, businessId, 'email', candidate.email);
    const byPhone = candidate.phone === null ? null : await findContactByHandle(tx, businessId, 'phone', candidate.phone);

    const decision = resolveContactMatch(candidate, byEmail, byPhone);
    if (decision.action === 'reject') {
      rejected.push({ row: candidate.rowIndex, reason: decision.reason });
      continue;
    }

    let contactId: string;
    if (decision.action === 'create') {
      contactId = uuidv7();
      // Deliberately NOT an ON CONFLICT upsert: the advisory lock serializes
      // read-then-write per business, so a conflicting concurrent create is
      // impossible and a surprise conflict should fail loudly, not merge.
      await tx`
        INSERT INTO solicitation_contacts
          (id, business_id, name, email, phone, created_by_upload_id)
        VALUES
          (${contactId}, ${businessId}, ${candidate.name}, ${candidate.email},
           ${candidate.phone}, ${uploadId})
      `;
      contactsCreated += 1;
    } else {
      contactId = decision.contactId;
      const { set } = decision;
      if (set.name !== undefined || set.email !== undefined || set.phone !== undefined) {
        // COALESCE keeps unmentioned fields; `set` values are always non-empty.
        await tx`
          UPDATE solicitation_contacts
          SET name = COALESCE(${set.name ?? null}, name),
              email = COALESCE(${set.email ?? null}, email),
              phone = COALESCE(${set.phone ?? null}, phone),
              updated_at = NOW()
          WHERE id = ${contactId} AND business_id = ${businessId}
        `;
        contactsMerged += 1;
      }
    }

    // Visit upsert (§1.3): unique on (contact_id, visit_date); a non-empty
    // incoming note refreshes the stored note, an empty/absent one keeps it.
    // `xmax = 0` ⇔ the row version was freshly inserted (never deleted/updated
    // in-place by the ON CONFLICT branch) — the one non-obvious SQL trick that
    // distinguishes visitsAdded from duplicateVisits in a single statement.
    const [visit] = await tx<{ inserted: boolean }[]>`
      INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, note, upload_id)
      VALUES (${uuidv7()}, ${contactId}, ${businessId}, ${candidate.visitDate},
              ${candidate.note}, ${uploadId})
      ON CONFLICT (contact_id, visit_date)
      DO UPDATE SET note = COALESCE(NULLIF(EXCLUDED.note, ''), solicitation_visits.note)
      RETURNING (xmax = 0) AS inserted
    `;
    if (visit?.inserted === true) {
      visitsAdded += 1;
    } else {
      duplicateVisits += 1;
    }
  }

  rejected.sort((a, b) => a.row - b.row);
  return {
    contactsCreated,
    contactsMerged,
    visitsAdded,
    duplicateVisits,
    rejected,
    structuralFailure: null,
  };
}

async function findContactByHandle(
  tx: TransactionSql,
  businessId: string,
  handleColumn: 'email' | 'phone',
  handle: string,
): Promise<ExistingContact | null> {
  const rows = handleColumn === 'email'
    ? await tx<ExistingContact[]>`
        SELECT id, name, email, phone FROM solicitation_contacts
        WHERE business_id = ${businessId} AND email = ${handle}
      `
    : await tx<ExistingContact[]>`
        SELECT id, name, email, phone FROM solicitation_contacts
        WHERE business_id = ${businessId} AND phone = ${handle}
      `;
  return rows[0] ?? null;
}

/** Writes the terminal report AND clears raw_csv in the surrounding tx (§3). */
async function terminalizeUpload(
  tx: TransactionSql,
  uploadId: string,
  status: 'completed' | 'failed',
  report: IngestReport,
): Promise<IngestReport> {
  await tx`
    UPDATE contact_csv_uploads
    SET status = ${status}, report = ${tx.json(report as never)},
        raw_csv = NULL, completed_at = NOW()
    WHERE id = ${uploadId}
  `;
  if (status === 'failed') {
    logger.warn('csv ingest terminally failed', {
      upload_id: uploadId,
      structural_failure: report.structuralFailure,
    });
  }
  return report;
}

function structuralReport(structuralFailure: StructuralFailure): IngestReport {
  return {
    contactsCreated: 0,
    contactsMerged: 0,
    visitsAdded: 0,
    duplicateVisits: 0,
    rejected: [],
    structuralFailure,
  };
}

/** Terminal rows always carry a report (DB CHECK); anything else is impossible. */
function parseStoredReport(upload: UploadRow): IngestReport {
  // `contact_csv_uploads.report` is a production JSONB field-to-parser site:
  // Postgres.js behind PgBouncer may return JSONB as a string (sanctioned
  // carve-out — see the CLAUDE.md allowlist).
  const parsed: unknown = typeof upload.report === 'string'
    ? JSON.parse(upload.report)
    : upload.report;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `csv_ingest impossible state: terminal upload ${upload.id} (status=${upload.status}) has no report object`,
    );
  }
  return parsed as IngestReport;
}

function rejectionHistogram(rejected: RejectedRow[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const { reason } of rejected) {
    const key = `rejected_${reason}`;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return histogram;
}
