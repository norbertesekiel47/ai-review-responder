'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { useLocationScope } from '@/contexts/LocationContext';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { UploadStatus } from '@/lib/solicitation/uploads';
import type { IngestReport } from '@/lib/solicitation/ingest';
import { UPLOAD_STATUSES } from '@/lib/solicitation/upload-status';
import type {
  RowRejectionReason,
  StructuralFailure,
} from '@/lib/solicitation/contacts-csv';

/**
 * Upload lane of /dashboard/requests/contacts (#541): file + attestation form, submit,
 * bounded status polling, and terminal report/failure rendering. Split from
 * ContactsClient so each concern stays independently scannable; the only
 * integration point with the contact list is `onIngestCompleted`.
 */

const UPLOAD_POLL_INTERVAL_MS = 2_000;
/** §Task 7: polling is bounded — after 5 minutes show "still processing". */
const UPLOAD_POLL_TIMEOUT_MS = 5 * 60 * 1_000;

// ── Copy tables (single owner of the reason → human label mapping) ──────────

const REJECTION_LABELS: Record<RowRejectionReason, string> = {
  missing_name: 'Missing name',
  missing_handle: 'No email or phone',
  invalid_email: 'Invalid email',
  invalid_phone: 'Invalid phone',
  invalid_date: 'Invalid visit date',
  future_date: 'Visit date is in the future',
  ambiguous_identity: 'Email and phone match different contacts',
  note_too_long: 'Note is too long',
};

const STRUCTURAL_LABELS: Record<StructuralFailure, string> = {
  missing_required_header:
    'The CSV is missing a required column (name, email or phone, visit date).',
  row_count_over_cap: 'The CSV has more than 5,000 data rows.',
  byte_size_over_cap: 'File exceeds 5 MB.',
  undecodable_encoding: 'The file could not be read as UTF-8 text.',
};

function rejectionLabel(reason: string): string {
  return (REJECTION_LABELS as Record<string, string>)[reason] ?? reason;
}

// ── Upload state machine ────────────────────────────────────────────────────

type UploadPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'processing'; uploadId: string; startedAt: number }
  | { kind: 'timed_out'; uploadId: string }
  | { kind: 'report'; status: UploadStatus }
  | { kind: 'error'; message: string; field: 'file' | 'attestation' | 'generic' };

const IDLE: UploadPhase = { kind: 'idle' };

/** Upload state keyed by the scope it was started for: switching location
 *  reads as idle without an effect-driven reset. */
interface ScopedUploadPhase {
  scope: string;
  phase: UploadPhase;
}

interface UploadCardProps {
  /** Server-authoritative attestation copy (#535 §4) — never bundled client-side. */
  attestationText: string;
  attestationVersion: string;
  /** Called once when an upload reaches the 'completed' terminal state. */
  onIngestCompleted: () => void;
}

export function UploadCard({
  attestationText,
  attestationVersion,
  onIngestCompleted,
}: UploadCardProps) {
  const { currentScope } = useLocationScope();

  const [uploadState, setUploadState] = useState<ScopedUploadPhase>({
    scope: currentScope,
    phase: IDLE,
  });
  const upload = uploadState.scope === currentScope ? uploadState.phase : IDLE;

  const [file, setFile] = useState<File | null>(null);
  const [attested, setAttested] = useState(false);
  // Bumped to remount the file input (clears the browser's chosen-file state).
  const [fileInputKey, setFileInputKey] = useState(0);

  const setPhase = (phase: UploadPhase) =>
    setUploadState({ scope: currentScope, phase });

  useUploadStatusPolling(upload, currentScope, setUploadState, onIngestCompleted);

  async function handleUpload() {
    if (!file || !attested || currentScope === 'all') return;
    setPhase({ kind: 'submitting' });
    setPhase(await submitUpload(file, currentScope));
  }

  function resetUpload() {
    setPhase(IDLE);
    setFile(null);
    setAttested(false);
    setFileInputKey((key) => key + 1);
  }

  return (
    <div className="card section-enter section-enter-1">
      <h2 className="card-h2">Upload a contacts CSV</h2>
      {upload.kind === 'report' ? (
        <UploadReport status={upload.status} onReset={resetUpload} />
      ) : upload.kind === 'timed_out' ? (
        <StillProcessing
          onCheckAgain={() =>
            setPhase({
              kind: 'processing',
              uploadId: upload.uploadId,
              startedAt: Date.now(),
            })
          }
        />
      ) : (
        <UploadForm
          upload={upload}
          fileName={file?.name ?? null}
          canSubmit={file !== null && attested}
          attested={attested}
          fileInputKey={fileInputKey}
          attestationText={attestationText}
          attestationVersion={attestationVersion}
          onFileChange={setFile}
          onAttestedChange={setAttested}
          onUpload={() => void handleUpload()}
        />
      )}
    </div>
  );
}

// ── Upload submit ────────────────────────────────────────────────────────────

/** POSTs the file + attestation and maps the response onto the next phase. */
async function submitUpload(file: File, businessId: string): Promise<UploadPhase> {
  try {
    const formData = new FormData();
    formData.set('file', file);
    formData.set('attestationAccepted', 'true');
    formData.set('businessId', businessId);
    const res = await fetch('/api/dashboard/contacts/uploads', {
      method: 'POST',
      body: formData,
    });
    if (res.status === 201) {
      const body = (await res.json()) as { uploadId: string };
      return { kind: 'processing', uploadId: body.uploadId, startedAt: Date.now() };
    }
    const body: { error?: string } = await res.json().catch(() => ({}));
    return submitErrorPhase(res.status, body);
  } catch {
    return {
      kind: 'error',
      message: 'Could not reach the server. Check your connection and try again.',
      field: 'generic',
    };
  }
}

function submitErrorPhase(status: number, body: { error?: string }): UploadPhase {
  if (status === 413 || body.error === 'file_too_large') {
    return { kind: 'error', message: 'File exceeds 5 MB.', field: 'file' };
  }
  if (body.error === 'attestation_required') {
    return {
      kind: 'error',
      message: 'You must confirm the attestation before uploading.',
      field: 'attestation',
    };
  }
  if (body.error === 'empty_file') {
    return { kind: 'error', message: 'The selected file is empty.', field: 'file' };
  }
  return {
    kind: 'error',
    message: body.error ?? `Upload failed (${status}).`,
    field: 'generic',
  };
}

// ── Status polling (bounded ~2s cadence, 5-minute ceiling) ──────────────────

/** The interval is armed synchronously and cleared in the effect teardown;
 *  `cancelled` guards every post-await state write (set on teardown AND on any
 *  terminal outcome, so a stray tick between state write and effect re-run
 *  cannot re-fetch), and `inFlight` prevents overlapping polls when one
 *  response outlives a tick. */
function useUploadStatusPolling(
  upload: UploadPhase,
  currentScope: string,
  setUploadState: Dispatch<SetStateAction<ScopedUploadPhase>>,
  onIngestCompleted: () => void,
): void {
  useEffect(() => {
    if (upload.kind !== 'processing' || currentScope === 'all') return;
    const { uploadId, startedAt } = upload;
    let cancelled = false;
    let inFlight = false;
    const setPhase = (phase: UploadPhase) =>
      setUploadState({ scope: currentScope, phase });

    const poll = async () => {
      if (cancelled || inFlight) return;
      if (Date.now() - startedAt > UPLOAD_POLL_TIMEOUT_MS) {
        cancelled = true;
        setPhase({ kind: 'timed_out', uploadId });
        return;
      }
      inFlight = true;
      try {
        const outcome = await fetchPollOutcome(uploadId, currentScope);
        if (cancelled || outcome === null) return;
        cancelled = true;
        setPhase(outcome.phase);
        if (outcome.completed) onIngestCompleted();
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [upload, currentScope, setUploadState, onIngestCompleted]);
}

/** One status fetch. Returns the terminal outcome, or null when the upload is
 *  still pending or the failure is transient (non-OK 5xx, network error) —
 *  the caller keeps polling; the deadline above bounds total waiting. */
async function fetchPollOutcome(
  uploadId: string,
  scope: string,
): Promise<{ phase: UploadPhase; completed: boolean } | null> {
  try {
    const res = await fetch(
      withSolicitationScope(`/api/dashboard/contacts/uploads/${uploadId}`, scope),
    );
    if (res.status === 404) {
      return {
        phase: {
          kind: 'error',
          message: 'Upload not found — it may belong to another location.',
          field: 'generic',
        },
        completed: false,
      };
    }
    if (!res.ok) return null;
    const status = (await res.json()) as UploadStatus;
    if (status.status === UPLOAD_STATUSES.PENDING) return null;
    return {
      phase: { kind: 'report', status },
      completed: status.status === UPLOAD_STATUSES.COMPLETED,
    };
  } catch {
    return null;
  }
}

// ── Upload form ──────────────────────────────────────────────────────────────

function UploadForm({
  upload,
  fileName,
  canSubmit,
  attested,
  fileInputKey,
  attestationText,
  attestationVersion,
  onFileChange,
  onAttestedChange,
  onUpload,
}: {
  upload: UploadPhase;
  fileName: string | null;
  canSubmit: boolean;
  attested: boolean;
  fileInputKey: number;
  attestationText: string;
  attestationVersion: string;
  onFileChange: (file: File | null) => void;
  onAttestedChange: (attested: boolean) => void;
  onUpload: () => void;
}) {
  const busy = upload.kind === 'submitting' || upload.kind === 'processing';
  const error = upload.kind === 'error' ? upload : null;
  return (
    <>
      <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: '0 0 16px' }}>
        Columns: name, email and/or phone, visit date, optional note.
        Up to 5,000 rows / 5&nbsp;MB per file.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FileField
          fileInputKey={fileInputKey}
          busy={busy}
          error={error?.field === 'file' ? error.message : null}
          onFileChange={onFileChange}
        />
        <AttestationField
          attested={attested}
          busy={busy}
          attestationText={attestationText}
          onAttestedChange={onAttestedChange}
        />
        {error?.field === 'attestation' && (
          <p role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)', margin: 0 }}>
            {error.message}
          </p>
        )}
        <UploadActions
          upload={upload}
          fileName={fileName}
          canSubmit={canSubmit}
          onUpload={onUpload}
        />
        <p style={{ fontSize: 11, color: 'var(--rw-app-text-soft)', margin: 0 }}>
          Attestation {attestationVersion} is recorded with every upload.
        </p>
      </div>
    </>
  );
}

function FileField({
  fileInputKey,
  busy,
  error,
  onFileChange,
}: {
  fileInputKey: number;
  busy: boolean;
  error: string | null;
  onFileChange: (file: File | null) => void;
}) {
  return (
    <div>
      <label
        htmlFor="contacts-csv-file"
        style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}
      >
        CSV file
      </label>
      <input
        key={fileInputKey}
        id="contacts-csv-file"
        type="file"
        accept=".csv,text/csv"
        disabled={busy}
        onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        style={{ fontSize: 13, fontFamily: 'var(--rw-font-body)' }}
      />
      {error !== null && (
        <p role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)', margin: '6px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}

function AttestationField({
  attested,
  busy,
  attestationText,
  onAttestedChange,
}: {
  attested: boolean;
  busy: boolean;
  attestationText: string;
  onAttestedChange: (attested: boolean) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        background: 'var(--rw-recess)',
        border: '1px solid var(--rw-hair-2)',
        borderRadius: 'var(--rw-radius-md)',
        padding: '12px 14px',
      }}
    >
      <input
        id="contacts-attestation"
        type="checkbox"
        checked={attested}
        disabled={busy}
        onChange={(event) => onAttestedChange(event.target.checked)}
        style={{ marginTop: 2, accentColor: 'var(--rw-sage-deep)' }}
      />
      <label
        htmlFor="contacts-attestation"
        style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--rw-app-text)' }}
      >
        {attestationText}
      </label>
    </div>
  );
}

const genericErrorStyle: React.CSSProperties = {
  background: 'var(--rw-danger-soft)',
  border: '1px solid var(--rw-danger)',
  borderRadius: 'var(--rw-radius-md)',
  padding: '10px 14px',
  fontSize: 13,
  color: 'var(--rw-danger)',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

function UploadActions({
  upload,
  fileName,
  canSubmit,
  onUpload,
}: {
  upload: UploadPhase;
  fileName: string | null;
  canSubmit: boolean;
  onUpload: () => void;
}) {
  const busy = upload.kind === 'submitting' || upload.kind === 'processing';
  return (
    <>
      {upload.kind === 'error' && upload.field === 'generic' && (
        <div role="alert" style={genericErrorStyle}>
          <span>{upload.message}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onUpload}
            disabled={!canSubmit}
          >
            Try again
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit || busy}
          onClick={onUpload}
        >
          {upload.kind === 'submitting'
            ? 'Uploading…'
            : upload.kind === 'processing'
              ? 'Processing…'
              : 'Upload CSV'}
        </button>
        {upload.kind === 'processing' && (
          <span style={{ fontSize: 13, color: 'var(--rw-app-text-muted)' }}>
            Processing {fileName ?? 'your file'} — this usually takes a
            few seconds.
          </span>
        )}
      </div>
    </>
  );
}

// ── Upload report (terminal states) ─────────────────────────────────────────

function UploadReport({
  status,
  onReset,
}: {
  status: UploadStatus;
  onReset: () => void;
}) {
  const report = status.report;

  if (status.status === UPLOAD_STATUSES.FAILED) {
    return <FailedReport status={status} report={report} onReset={onReset} />;
  }

  return (
    <div>
      <LiveRegion message={`Finished processing ${status.filename}.`} />
      <p style={{ fontSize: 14, margin: '0 0 16px' }}>
        Finished processing <strong>{status.filename}</strong>.
      </p>
      <ReportStatTiles report={report} />
      {report && report.rejected.length > 0 && (
        <RejectedRows report={report} filename={status.filename} />
      )}
      <button type="button" className="btn btn-secondary" onClick={onReset}>
        Upload another file
      </button>
    </div>
  );
}

/** Zero counts for the (impossible-by-CHECK, still typed-nullable) missing
 *  report — keeps the tiles render branch-free. */
const ZERO_REPORT_COUNTS = {
  contactsCreated: 0,
  contactsMerged: 0,
  visitsAdded: 0,
  duplicateVisits: 0,
} as const;

function ReportStatTiles({ report }: { report: IngestReport | null }) {
  const counts = report ?? ZERO_REPORT_COUNTS;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
        marginBottom: 16,
      }}
    >
      <StatTile label="Contacts created" value={counts.contactsCreated} />
      <StatTile label="Contacts merged" value={counts.contactsMerged} />
      <StatTile label="Visits added" value={counts.visitsAdded} />
      <StatTile label="Duplicate visits" value={counts.duplicateVisits} />
    </div>
  );
}

/** Terminal failure copy (#541): 'subscription_inactive' — the account stopped
 *  passing the writable-subscription gate before processing; 'ingest_failed'
 *  — retries exhausted; otherwise a structural rejection of the whole file. */
function failedReportMessage(filename: string, report: IngestReport | null): string {
  if (report === null) {
    return `Processing ${filename} failed. Nothing was imported.`;
  }
  if (report.error === 'subscription_inactive') {
    return `Your subscription is no longer active, so ${filename} was not imported. Reactivate your subscription and upload the file again.`;
  }
  if (report.error === 'ingest_failed') {
    return `Something went wrong while processing ${filename}. Nothing was imported.`;
  }
  if (report.structuralFailure !== null) {
    return `${STRUCTURAL_LABELS[report.structuralFailure]} Nothing was imported.`;
  }
  return `Processing ${filename} failed. Nothing was imported.`;
}

function FailedReport({
  status,
  report,
  onReset,
}: {
  status: UploadStatus;
  report: IngestReport | null;
  onReset: () => void;
}) {
  const message = failedReportMessage(status.filename, report);

  return (
    <div>
      <LiveRegion message={message} level="assertive" />
      <div
        role="alert"
        style={{
          background: 'var(--rw-danger-soft)',
          border: '1px solid var(--rw-danger)',
          borderRadius: 'var(--rw-radius-md)',
          padding: '12px 16px',
          fontSize: 13,
          color: 'var(--rw-danger)',
          marginBottom: 16,
        }}
      >
        {message}
      </div>
      <button type="button" className="btn btn-secondary" onClick={onReset}>
        Try another upload
      </button>
    </div>
  );
}

/** Client-side Blob download (no extra endpoint): row numbers and reason
 *  codes are enum tokens, so no CSV escaping is needed. */
function downloadRejectedRowsCsv(report: IngestReport, filename: string): void {
  const lines = [
    'row,reason',
    ...report.rejected.map((row) => `${row.row},${row.reason}`),
  ];
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rejected-rows-${filename.replace(/\.csv$/i, '')}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function RejectedRows({
  report,
  filename,
}: {
  report: IngestReport;
  filename: string;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          Rejected rows ({report.rejected.length})
        </h3>
        <button
          type="button"
          className="btn btn-tertiary"
          onClick={() => downloadRejectedRowsCsv(report, filename)}
        >
          Download rejected rows
        </button>
      </div>
      <div
        style={{
          maxHeight: 260,
          overflowY: 'auto',
          border: '1px solid var(--rw-hair-2)',
          borderRadius: 'var(--rw-radius-md)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th scope="col" style={rejectedHeaderStyle}>Row</th>
              <th scope="col" style={rejectedHeaderStyle}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {report.rejected.map((row) => (
              <tr key={`${row.row}-${row.reason}`}>
                <td style={rejectedCellStyle}>{row.row}</td>
                <td style={rejectedCellStyle}>{rejectionLabel(row.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const rejectedHeaderStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--rw-app-text-soft)',
  padding: '6px 12px',
  borderBottom: '1px solid var(--rw-hair-2)',
  position: 'sticky',
  top: 0,
  background: 'var(--rw-card)',
};

const rejectedCellStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderBottom: '1px solid var(--rw-hair)',
  color: 'var(--rw-app-text)',
};

function StillProcessing({ onCheckAgain }: { onCheckAgain: () => void }) {
  return (
    <div>
      <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: '0 0 14px' }}>
        Still processing — this file is taking longer than usual. Check back in a
        few minutes; the import keeps running in the background.
      </p>
      <button type="button" className="btn btn-secondary" onClick={onCheckAgain}>
        Check again
      </button>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        background: 'var(--rw-recess)',
        border: '1px solid var(--rw-hair)',
        borderRadius: 'var(--rw-radius-md)',
        padding: '12px 14px',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rw-app-text-soft)' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontFamily: 'var(--rw-font-display)', marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}
