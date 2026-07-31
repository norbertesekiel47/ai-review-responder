/**
 * Ingest lane for the contacts/visits CSV (#541, contract #535 §1.2/§1.3/§3):
 * match/merge/upsert of contacts + visits, terminal report, raw CSV clearing.
 *
 * Concurrency contract: ALL DB work happens inside ONE transaction that opens
 * by taking the per-business csv_ingest advisory lock — `acquireCsvIngestLock`
 * below owns that lock's mechanics, and EVERY writer of `contact_csv_uploads`
 * holds it. Four writers today: this ingest transaction, the failed-hook
 * terminalizer (worker/jobs/csv-ingest/failed-hook.ts),
 * `terminalizeUploadForInactiveSubscription`, and — since #582 — the offboarding
 * content purge (worker/jobs/account-offboarding/purge-stages.ts), which takes
 * it per business under the account before hard-DELETEing these rows. So
 * read-then-write matching cannot double-create a contact, terminalization
 * cannot race an in-flight retry, and a purge cannot delete a row out from
 * under a running ingest. Plain FOR UPDATE cannot
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
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { enqueueBuildSolicitationBatch } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  MAX_UPLOAD_BYTES,
  parseContactsCsv,
  type ContactCandidate,
  type RejectedRow,
  type StructuralFailure,
} from './contacts-csv';
import { solicitationWatchEnabled } from './flags';
import {
  UPLOAD_STATUSES,
  type ContactUploadStatus,
  type TerminalUploadStatus,
} from './upload-status';

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

/** Terminal error markers, distinct from per-file structural failures:
 *  `ingest_failed` — the failed-hook exhausted BullMQ retries;
 *  `subscription_inactive` — the account stopped passing the route's
 *  writable-subscription predicate before the worker could process. */
export type IngestErrorMarker = 'ingest_failed' | 'subscription_inactive';

export interface IngestReport {
  contactsCreated: number; contactsMerged: number; visitsAdded: number;
  duplicateVisits: number; rejected: RejectedRow[];
  structuralFailure: StructuralFailure | null;
  /** Set only on non-structural terminal failures (see IngestErrorMarker) —
   *  lets the UI render each terminal state distinctly. */
  error?: IngestErrorMarker;
}

interface UploadRow {
  id: string;
  business_id: string;
  /** contact_csv_uploads.account_id (migration 086) — read straight off the
   *  upload row for the analytics rows below. */
  account_id: string;
  status: ContactUploadStatus;
  byte_size: number;
  raw_csv: string | null;
  report: unknown;
  /** Arrives as a JS Date from postgres.js. Kept OPAQUE: passed straight back
   *  into SQL for the §4.2 guard, never stringified or compared in JS. */
  attested_at: Date;
  attestation_version: string;
  attested_by_user_id: string;
}

interface UploadTerminalization {
  report: IngestReport;
  solicitationBatchesCreated: number;
  buildJobsEnqueued: number;
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

  // One-pass locked ingest transaction.
  return sql.begin(async (tx) => {
    // Lock FIRST, before any status read — a pre-lock peek could see a stale
    // 'pending' that a concurrent run terminalizes before we acquire the lock.
    await acquireCsvIngestLock(tx, expectedBusinessId);

    // business_id is bound into the read (tenant-scoped by construction,
    // mirroring handleCsvIngest's gate query): a payload/row pairing mismatch
    // yields no row, hitting the missing-row branch below. The `!==` assert
    // right after stays as defense-in-depth — belt-and-braces in case a
    // future caller ever re-reads without the bound predicate — but is
    // unreachable through this bound query today.
    const [upload] = await tx<UploadRow[]>`
      SELECT upload.id, upload.business_id, upload.account_id, upload.status,
             upload.byte_size, upload.raw_csv, upload.report,
             upload.attested_at, upload.attestation_version, upload.attested_by_user_id
      FROM contact_csv_uploads upload
      WHERE upload.id = ${uploadId} AND upload.business_id = ${expectedBusinessId}
    `;
    if (!upload) {
      logger.warn('upload row missing — nothing to ingest', { upload_id: uploadId });
      return null;
    }
    if (upload.status !== UPLOAD_STATUSES.PENDING) {
      // Idempotent retry / lost race against a concurrent run: both are the
      // same no-op — return the stored terminal report.
      return parseStoredReport(upload);
    }

    const rawCsv = assertProcessableUpload(upload, expectedBusinessId);

    // Defensive boundary re-check — the route already enforces the cap.
    if (upload.byte_size > MAX_UPLOAD_BYTES) {
      const terminalization = await terminalizeUpload(
        tx,
        uploadId,
        expectedBusinessId,
        UPLOAD_STATUSES.FAILED,
        structuralReport('byte_size_over_cap'),
      );
      return terminalization.report;
    }

    const parsed = parseContactsCsv(rawCsv, todayUtc);
    if ('structuralFailure' in parsed) {
      const terminalization = await terminalizeUpload(
        tx,
        uploadId,
        expectedBusinessId,
        UPLOAD_STATUSES.FAILED,
        structuralReport(parsed.structuralFailure),
      );
      return terminalization.report;
    }

    // Bounded memory: MAX_DATA_ROWS (5,000) caps the candidate list, so
    // whole-file in-memory processing is fine.
    const report = await upsertCandidates(tx, expectedBusinessId, upload, parsed.candidates, parsed.rejected);
    const terminalization = await terminalizeUpload(
      tx,
      uploadId,
      expectedBusinessId,
      UPLOAD_STATUSES.COMPLETED,
      report,
    );

    logger.log('csv ingest completed', {
      upload_id: uploadId,
      contacts_created: report.contactsCreated,
      contacts_merged: report.contactsMerged,
      visits_added: report.visitsAdded,
      duplicate_visits: report.duplicateVisits,
      rejected_total: report.rejected.length,
      solicitation_batches_created: terminalization.solicitationBatchesCreated,
      build_solicitation_batch_jobs_enqueued: terminalization.buildJobsEnqueued,
      ...rejectionHistogram(report.rejected),
    });
    return report;
  });
}

/** Match + upsert every candidate row. Runs inside the caller's locked tx. */
async function upsertCandidates(
  tx: TransactionSql,
  businessId: string,
  upload: UploadRow,
  candidates: ContactCandidate[],
  parseRejected: RejectedRow[],
): Promise<IngestReport> {
  let contactsCreated = 0;
  let contactsMerged = 0;
  let visitsAdded = 0;
  let duplicateVisits = 0;
  const rejected: RejectedRow[] = [...parseRejected];

  for (const candidate of candidates) {
    const { byEmail, byPhone } = await findMatches(tx, businessId, candidate);
    const decision = resolveContactMatch(candidate, byEmail, byPhone);
    if (decision.action === 'reject') {
      rejected.push({ row: candidate.rowIndex, reason: decision.reason });
      continue;
    }

    const contact = decision.action === 'create'
      ? await createContact(tx, businessId, upload.id, candidate)
      : await updateMatchedContact(tx, businessId, decision);
    if (contact.outcome === 'created') contactsCreated += 1;
    if (contact.outcome === 'merged') contactsMerged += 1;

    if (await upsertVisit(tx, businessId, upload.id, contact.contactId, candidate)) {
      visitsAdded += 1;
    } else {
      duplicateVisits += 1;
    }

    if (candidate.email !== null) {
      await upsertConsent(tx, businessId, upload, candidate.email);
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

async function createContact(
  tx: TransactionSql,
  businessId: string,
  uploadId: string,
  candidate: ContactCandidate,
): Promise<{ contactId: string; outcome: 'created' }> {
  const contactId = uuidv7();
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
  return { contactId, outcome: 'created' };
}

/** Applies an update decision. Report semantics (§1.2, PR #564 review):
 *  `merged` = a HANDLE was merged into the matched contact; a name-only
 *  refresh updates the row but is deliberately NOT counted as a merge. */
async function updateMatchedContact(
  tx: TransactionSql,
  businessId: string,
  decision: Extract<ContactMatchDecision, { action: 'update' }>,
): Promise<{ contactId: string; outcome: 'merged' | 'name_refreshed' | 'unchanged' }> {
  const { contactId, set } = decision;
  const mergesHandle = set.email !== undefined || set.phone !== undefined;
  if (set.name === undefined && !mergesHandle) return { contactId, outcome: 'unchanged' };

  // COALESCE keeps unmentioned fields; `set` values are always non-empty.
  await tx`
    UPDATE solicitation_contacts
    SET name = COALESCE(${set.name ?? null}, name),
        email = COALESCE(${set.email ?? null}, email),
        phone = COALESCE(${set.phone ?? null}, phone),
        updated_at = NOW()
    WHERE id = ${contactId} AND business_id = ${businessId}
  `;
  return { contactId, outcome: mergesHandle ? 'merged' : 'name_refreshed' };
}

/** Visit upsert (§1.3): unique on (contact_id, visit_date); a non-empty
 *  incoming note refreshes the stored note, an empty/absent one keeps it.
 *  Returns true when the visit row was freshly inserted. `xmax = 0` ⇔ the row
 *  version was freshly inserted (never deleted/updated in-place by the
 *  ON CONFLICT branch) — the one non-obvious SQL trick that distinguishes
 *  visitsAdded from duplicateVisits in a single statement. */
async function upsertVisit(
  tx: TransactionSql,
  businessId: string,
  uploadId: string,
  contactId: string,
  candidate: ContactCandidate,
): Promise<boolean> {
  const [visit] = await tx<{ inserted: boolean }[]>`
    INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, note, upload_id)
    VALUES (${uuidv7()}, ${contactId}, ${businessId}, ${candidate.visitDate},
            ${candidate.note}, ${uploadId})
    ON CONFLICT (contact_id, visit_date)
    DO UPDATE SET note = COALESCE(NULLIF(EXCLUDED.note, ''), solicitation_visits.note)
    RETURNING (xmax = 0) AS inserted
  `;
  return visit?.inserted === true;
}

/** §4.2 guarded monotone upsert — the consent ledger's ONLY writer (D8). Email
 *  rows only (DR3): a phone-only candidate mints no row. Serialized per
 *  business by the caller's advisory lock, so the pre-read for event
 *  derivation cannot race the upsert (contrast createContact's no-ON CONFLICT
 *  comment: here the upsert is wanted — the upgrade semantics ARE the
 *  feature). Last attestation wins, and "last" is attested_at, not arrival
 *  order: an in-flight pre-deploy v1 job must not overwrite a v2 row. The
 *  postgres.js microsecond gotcha does not apply — both guard operands sit in
 *  one SQL statement. */
async function upsertConsent(
  tx: TransactionSql,
  businessId: string,
  upload: Pick<UploadRow, 'id' | 'account_id' | 'attested_at' | 'attestation_version' | 'attested_by_user_id'>,
  normalizedEmail: string,
): Promise<void> {
  const [existing] = await tx<{ id: string; attestation_version: string }[]>`
    SELECT id, attestation_version FROM solicitation_consent
    WHERE channel = 'email' AND normalized_handle = ${normalizedEmail}
      AND business_id = ${businessId}
  `;
  const [written] = await tx<{ id: string }[]>`
    INSERT INTO solicitation_consent
      (id, channel, normalized_handle, business_id, basis,
       attestation_version, attested_at, attested_by_user_id, source_upload_id)
    VALUES
      (${uuidv7()}, 'email', ${normalizedEmail}, ${businessId}, 'owner_attested',
       ${upload.attestation_version}, ${upload.attested_at},
       ${upload.attested_by_user_id}, ${upload.id})
    ON CONFLICT (channel, normalized_handle, business_id)
    DO UPDATE SET
      basis               = EXCLUDED.basis,
      attestation_version = EXCLUDED.attestation_version,
      attested_at         = EXCLUDED.attested_at,
      attested_by_user_id = EXCLUDED.attested_by_user_id,
      source_upload_id    = EXCLUDED.source_upload_id,
      updated_at          = NOW()
    WHERE EXCLUDED.attested_at > solicitation_consent.attested_at
    RETURNING id
  `;
  // Guard rejected the update (older or equal attestation): deliberate no-op,
  // no event — a replayed csv_ingest job must not churn the ledger (§4.3).
  if (written === undefined) return;

  // §8.1 events, idempotent on event_key — NEVER the handle in properties.
  if (existing === undefined) {
    await enqueueAnalyticsEvent(tx, {
      eventName: 'solicitation_consent_recorded',
      eventKey: `solicitation_consent_recorded_${written.id}`,
      distinctId: upload.account_id,
      accountId: upload.account_id,
      businessId,
      properties: {
        channel: 'email',
        basis: 'owner_attested',
        attestation_version: upload.attestation_version,
      },
    });
    return;
  }
  if (existing.attestation_version !== upload.attestation_version) {
    await enqueueAnalyticsEvent(tx, {
      eventName: 'solicitation_consent_upgraded',
      eventKey: `solicitation_consent_upgraded_${written.id}_${upload.attestation_version}`,
      distinctId: upload.account_id,
      accountId: upload.account_id,
      businessId,
      properties: {
        channel: 'email',
        from_version: existing.attestation_version,
        to_version: upload.attestation_version,
      },
    });
  }
}

/** Impossible-state guards for a pending upload row (the route wrote row +
 *  outbox payload in one transaction; the terminal-consistency CHECK makes a
 *  pending row without raw CSV unrepresentable). Returns the non-null raw CSV. */
function assertProcessableUpload(upload: UploadRow, expectedBusinessId: string): string {
  if (upload.business_id !== expectedBusinessId) {
    throw new Error(
      `csv_ingest business mismatch: upload ${upload.id} belongs to ${upload.business_id}, job expected ${expectedBusinessId}`,
    );
  }
  if (upload.raw_csv === null) {
    throw new Error(`csv_ingest impossible state: pending upload ${upload.id} has NULL raw_csv`);
  }
  return upload.raw_csv;
}

/** Looks up the candidate's normalized handles. Sequential on purpose: both
 *  SELECTs ride the single transaction connection. */
async function findMatches(
  tx: TransactionSql,
  businessId: string,
  candidate: ContactCandidate,
): Promise<{ byEmail: ExistingContact | null; byPhone: ExistingContact | null }> {
  const byEmail = candidate.email === null
    ? null
    : await findContactByHandle(tx, businessId, 'email', candidate.email);
  const byPhone = candidate.phone === null
    ? null
    : await findContactByHandle(tx, businessId, 'phone', candidate.phone);
  return { byEmail, byPhone };
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

/** THE owner of the csv_ingest advisory lock: the `csv_ingest_<businessId>`
 *  key, its `pg_advisory_xact_lock(hashtext(…))` wrapping, and the rule that it
 *  must be the FIRST statement of the surrounding transaction. Every
 *  `contact_csv_uploads` STATUS TRANSITION — here and in the csv-ingest
 *  failed-hook — goes through this function; a caller that rebuilt the key
 *  itself would still have to remember the other two facts. */
export async function acquireCsvIngestLock(
  tx: TransactionSql,
  businessId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`csv_ingest_${businessId}`}))`;
}

export interface TerminalUploadWrite {
  uploadId: string;
  businessId: string;
  status: TerminalUploadStatus;
  report: IngestReport;
}

/**
 * THE single writer of a `contact_csv_uploads` terminal state (§3): the
 * `status='pending'`-guarded UPDATE, the report encoding, `raw_csv = NULL` and
 * `completed_at = NOW()`, all in the caller's transaction. Callers own the
 * advisory lock (`acquireCsvIngestLock`) and any follow-on work.
 *
 * Matching 0 rows is a tolerated, silent no-op on every path — deliberately NOT
 * asserted. Only advisory-lock holders change `status`, so for a row that still
 * exists the predicate cannot change the outcome.
 *
 * The row could also be GONE: `worker/jobs/account-offboarding/purge-stages.ts`
 * hard-DELETEs `contact_csv_uploads` by `account_id`. As of #582 that stage
 * takes this same lock for every business under the account, so it can no
 * longer commit between an ingest's pending read and this write — a purge now
 * waits for the in-flight ingest instead of racing it.
 *
 * Do NOT turn that into an assert on the strength of the closed race. This
 * function returning void is load-bearing: an assert converts any future 0-row
 * path into throw → BullMQ retries → exhaustion → failed-hook noise, and the
 * caller has nothing useful to do with the distinction. An earlier draft of
 * #565 specified exactly that assert and was caught in review.
 */
export async function writeTerminalUploadState(
  tx: TransactionSql,
  { uploadId, businessId, status, report }: TerminalUploadWrite,
): Promise<void> {
  await tx`
    UPDATE contact_csv_uploads
    SET status = ${status}, report = ${tx.json(report as never)},
        raw_csv = NULL, completed_at = NOW()
    WHERE id = ${uploadId} AND business_id = ${businessId}
      AND status = ${UPLOAD_STATUSES.PENDING}
  `;
}

/** Writes the terminal report AND clears raw_csv in the surrounding tx (§3). */
// #543 adds the completed-ingest batch trigger here; complexity is inherent
// one-pass terminalization orchestration.
async function terminalizeUpload(
  tx: TransactionSql,
  uploadId: string,
  businessId: string,
  status: TerminalUploadStatus,
  report: IngestReport,
): Promise<UploadTerminalization> {
  await writeTerminalUploadState(tx, { uploadId, businessId, status, report });
  const batchCreated =
    status === UPLOAD_STATUSES.COMPLETED &&
    solicitationWatchEnabled() &&
    await createSolicitationBatchTrigger(tx, uploadId, businessId);
  if (status === UPLOAD_STATUSES.FAILED) {
    logger.warn('csv ingest terminally failed', {
      upload_id: uploadId,
      structural_failure: report.structuralFailure,
    });
  }
  return {
    report,
    solicitationBatchesCreated: batchCreated ? 1 : 0,
    buildJobsEnqueued: batchCreated ? 1 : 0,
  };
}

/** Creates the unbuilt batch and its durable build job as one paired write.
 *  The source-upload unique constraint makes an upload replay a no-op; only a
 *  newly-returned batch is eligible to enqueue work. */
async function createSolicitationBatchTrigger(
  tx: TransactionSql,
  uploadId: string,
  businessId: string,
): Promise<boolean> {
  const batchId = uuidv7();
  const rows = await tx<{ id: string }[]>`
    INSERT INTO solicitation_batches
      (id, account_id, business_id, source_upload_id, built_at)
    SELECT
      ${batchId}, upload.account_id, upload.business_id, upload.id, NULL
    FROM contact_csv_uploads upload
    WHERE upload.id = ${uploadId}
      AND upload.business_id = ${businessId}
      AND upload.status = ${UPLOAD_STATUSES.COMPLETED}
    ON CONFLICT (source_upload_id) DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) return false;

  await enqueueBuildSolicitationBatch(tx, { batchId, businessId });
  return true;
}

/**
 * Terminal 'failed' write for an upload whose account no longer passes the
 * upload route's writable-subscription predicate by the time the worker runs
 * (route admits past_due-in-grace; mid-flight transitions to cancelled /
 * pending_payment / expired grace / blocking offboarding land here). Mirrors
 * the failed-hook's coupled shape: advisory lock FIRST, then a
 * status='pending'-guarded UPDATE that writes the zero-count
 * `subscription_inactive` report AND NULLs raw_csv in the SAME transaction —
 * the raw blob's lifetime stays bounded (§3) on every path, never stranded
 * 'pending'. Idempotent: a retry (or a lost race against a concurrent
 * terminal write) finds status != 'pending' and no-ops.
 */
export async function terminalizeUploadForInactiveSubscription(
  sql: Sql,
  uploadId: string,
  businessId: string,
): Promise<void> {
  const report: IngestReport = {
    contactsCreated: 0,
    contactsMerged: 0,
    visitsAdded: 0,
    duplicateVisits: 0,
    rejected: [],
    structuralFailure: null,
    error: 'subscription_inactive',
  };
  await sql.begin(async (tx) => {
    await acquireCsvIngestLock(tx, businessId);
    await writeTerminalUploadState(tx, {
      uploadId,
      businessId,
      status: UPLOAD_STATUSES.FAILED,
      report,
    });
  });
  logger.warn('csv ingest terminalized: subscription inactive', { upload_id: uploadId });
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

/**
 * THE `contact_csv_uploads.report` production JSONB field-to-parser site —
 * the single shared parser cited in the CLAUDE.md allowlist: Postgres.js
 * behind PgBouncer may return JSONB as a string (sanctioned carve-out).
 * Returns null on a non-object value; callers pick their failure posture
 * (worker impossible-state throw vs read-side tolerance). The cast is against
 * a single-owner, code-controlled shape: the only writers are this module and
 * the csv-ingest failed-hook.
 */
export function parseIngestReportValue(value: unknown): IngestReport | null {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as IngestReport;
}

/** Terminal rows always carry a report (DB CHECK); anything else is impossible. */
function parseStoredReport(upload: UploadRow): IngestReport {
  const report = parseIngestReportValue(upload.report);
  if (report === null) {
    throw new Error(
      `csv_ingest impossible state: terminal upload ${upload.id} (status=${upload.status}) has no report object`,
    );
  }
  return report;
}

function rejectionHistogram(rejected: RejectedRow[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const { reason } of rejected) {
    const key = `rejected_${reason}`;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return histogram;
}
