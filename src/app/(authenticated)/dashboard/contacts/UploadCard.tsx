'use client';

import { useEffect, useState } from 'react';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { useLocationScope } from '@/contexts/LocationContext';
import type { UploadStatus } from '@/lib/solicitation/uploads';
import type { IngestReport } from '@/lib/solicitation/ingest';
import { UPLOAD_STATUSES } from '@/lib/solicitation/upload-status';
import type {
  RowRejectionReason,
  StructuralFailure,
} from '@/lib/solicitation/contacts-csv';

/**
 * Upload lane of /dashboard/contacts (#541): file + attestation form, submit,
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

  // Upload state is keyed by the scope it was started for: switching location
  // reads as idle without an effect-driven reset.
  const [uploadState, setUploadState] = useState<{
    scope: string;
    phase: UploadPhase;
  }>({ scope: currentScope, phase: IDLE });
  const upload = uploadState.scope === currentScope ? uploadState.phase : IDLE;

  const [file, setFile] = useState<File | null>(null);
  const [attested, setAttested] = useState(false);
  // Bumped to remount the file input (clears the browser's chosen-file state).
  const [fileInputKey, setFileInputKey] = useState(0);

  const setPhase = (phase: UploadPhase) =>
    setUploadState({ scope: currentScope, phase });

  // ── Upload submit ─────────────────────────────────────────────────────────

  async function handleUpload() {
    if (!file || !attested || currentScope === 'all') return;
    setPhase({ kind: 'submitting' });
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('attestationAccepted', 'true');
      formData.set('businessId', currentScope);
      const res = await fetch('/api/dashboard/contacts/uploads', {
        method: 'POST',
        body: formData,
      });
      if (res.status === 201) {
        const body = (await res.json()) as { uploadId: string };
        setPhase({
          kind: 'processing',
          uploadId: body.uploadId,
          startedAt: Date.now(),
        });
        return;
      }
      const body: { error?: string } = await res.json().catch(() => ({}));
      if (res.status === 413 || body.error === 'file_too_large') {
        setPhase({ kind: 'error', message: 'File exceeds 5 MB.', field: 'file' });
      } else if (body.error === 'attestation_required') {
        setPhase({
          kind: 'error',
          message: 'You must confirm the attestation before uploading.',
          field: 'attestation',
        });
      } else if (body.error === 'empty_file') {
        setPhase({ kind: 'error', message: 'The selected file is empty.', field: 'file' });
      } else {
        setPhase({
          kind: 'error',
          message: body.error ?? `Upload failed (${res.status}).`,
          field: 'generic',
        });
      }
    } catch {
      setPhase({
        kind: 'error',
        message: 'Could not reach the server. Check your connection and try again.',
        field: 'generic',
      });
    }
  }

  function resetUpload() {
    setPhase(IDLE);
    setFile(null);
    setAttested(false);
    setFileInputKey((key) => key + 1);
  }

  // ── Status polling (bounded ~2s cadence, 5-minute ceiling) ────────────────

  // False positive: the timer is armed inside the async poll closure (rule
  // docs pattern D); the returned teardown clears it and `cancelled` stops
  // re-arming.
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (upload.kind !== 'processing' || currentScope === 'all') return;
    const { uploadId, startedAt } = upload;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > UPLOAD_POLL_TIMEOUT_MS) {
        setUploadState({
          scope: currentScope,
          phase: { kind: 'timed_out', uploadId },
        });
        return;
      }
      try {
        const res = await fetch(
          `/api/dashboard/contacts/uploads/${uploadId}?scope=${currentScope}`,
        );
        if (cancelled) return;
        if (res.status === 404) {
          setUploadState({
            scope: currentScope,
            phase: {
              kind: 'error',
              message: 'Upload not found — it may belong to another location.',
              field: 'generic',
            },
          });
          return;
        }
        if (res.ok) {
          const status = (await res.json()) as UploadStatus;
          if (cancelled) return;
          if (status.status !== UPLOAD_STATUSES.PENDING) {
            setUploadState({
              scope: currentScope,
              phase: { kind: 'report', status },
            });
            if (status.status === UPLOAD_STATUSES.COMPLETED) onIngestCompleted();
            return;
          }
        }
        // Non-OK (transient 5xx) falls through to the next bounded attempt.
      } catch {
        // Transient network failure — the deadline above bounds total waiting.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [upload, currentScope, onIngestCompleted]);

  const busy = upload.kind === 'submitting' || upload.kind === 'processing';

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
        <>
          <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: '0 0 16px' }}>
            Columns: name, email and/or phone, visit date, optional note.
            Up to 5,000 rows / 5&nbsp;MB per file.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                style={{ fontSize: 13, fontFamily: 'var(--rw-font-body)' }}
              />
              {upload.kind === 'error' && upload.field === 'file' && (
                <p role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)', margin: '6px 0 0' }}>
                  {upload.message}
                </p>
              )}
            </div>
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
                onChange={(event) => setAttested(event.target.checked)}
                style={{ marginTop: 2, accentColor: 'var(--rw-sage-deep)' }}
              />
              <label
                htmlFor="contacts-attestation"
                style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--rw-app-text)' }}
              >
                {attestationText}
              </label>
            </div>
            {upload.kind === 'error' && upload.field === 'attestation' && (
              <p role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)', margin: 0 }}>
                {upload.message}
              </p>
            )}
            {upload.kind === 'error' && upload.field === 'generic' && (
              <div
                role="alert"
                style={{
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
                }}
              >
                <span>{upload.message}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleUpload()}
                  disabled={!file || !attested}
                >
                  Try again
                </button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!file || !attested || busy}
                onClick={() => void handleUpload()}
              >
                {upload.kind === 'submitting'
                  ? 'Uploading…'
                  : upload.kind === 'processing'
                    ? 'Processing…'
                    : 'Upload CSV'}
              </button>
              {upload.kind === 'processing' && (
                <span style={{ fontSize: 13, color: 'var(--rw-app-text-muted)' }}>
                  Processing {file?.name ?? 'your file'} — this usually takes a
                  few seconds.
                </span>
              )}
            </div>
            <p style={{ fontSize: 11, color: 'var(--rw-app-text-soft)', margin: 0 }}>
              Attestation {attestationVersion} is recorded with every upload.
            </p>
          </div>
        </>
      )}
    </div>
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <StatTile label="Contacts created" value={report?.contactsCreated ?? 0} />
        <StatTile label="Contacts merged" value={report?.contactsMerged ?? 0} />
        <StatTile label="Visits added" value={report?.visitsAdded ?? 0} />
        <StatTile label="Duplicate visits" value={report?.duplicateVisits ?? 0} />
      </div>
      {report && report.rejected.length > 0 && (
        <RejectedRows report={report} filename={status.filename} />
      )}
      <button type="button" className="btn btn-secondary" onClick={onReset}>
        Upload another file
      </button>
    </div>
  );
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
  // Terminal failure (#541): 'subscription_inactive' — the account stopped
  // passing the writable-subscription gate before processing; 'ingest_failed'
  // — retries exhausted; otherwise a structural rejection of the whole file.
  const message =
    report?.error === 'subscription_inactive'
      ? `Your subscription is no longer active, so ${status.filename} was not imported. Reactivate your subscription and upload the file again.`
      : report?.error === 'ingest_failed'
        ? `Something went wrong while processing ${status.filename}. Nothing was imported.`
        : report?.structuralFailure
          ? `${STRUCTURAL_LABELS[report.structuralFailure]} Nothing was imported.`
          : `Processing ${status.filename} failed. Nothing was imported.`;

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

function RejectedRows({
  report,
  filename,
}: {
  report: IngestReport;
  filename: string;
}) {
  function downloadRejectedCsv() {
    // Client-side Blob download (no extra endpoint): row numbers and reason
    // codes are enum tokens, so no CSV escaping is needed.
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

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          Rejected rows ({report.rejected.length})
        </h3>
        <button type="button" className="btn btn-tertiary" onClick={downloadRejectedCsv}>
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
