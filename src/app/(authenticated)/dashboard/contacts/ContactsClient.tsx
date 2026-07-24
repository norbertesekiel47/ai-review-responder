'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { useLocationScope } from '@/contexts/LocationContext';
import type { ContactListItem } from '@/lib/solicitation/contacts-repo';
import type { UploadStatus } from '@/lib/solicitation/uploads';
import type { IngestReport } from '@/lib/solicitation/ingest';
import type {
  RowRejectionReason,
  StructuralFailure,
} from '@/lib/solicitation/contacts-csv';

/**
 * /dashboard/contacts — contacts/visits CSV upload + report + contact list
 * (#541, contract #535). Client island: the server component (page.tsx) owns
 * the flag gate and the attestation constants; every read/write here goes
 * through the Task 4/6 API routes, scoped by the LocationContext scope
 * (mirrors ReviewsContent's useLocationScope idiom).
 */

const PAGE_LIMIT = 50;
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

interface ContactsClientProps {
  /** Server-authoritative attestation copy (#535 §4) — never bundled client-side. */
  attestationText: string;
  attestationVersion: string;
}

export function ContactsClient({
  attestationText,
  attestationVersion,
}: ContactsClientProps) {
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

  // Contact list paging, keyed by scope so a location switch reads offset 0.
  const [pageState, setPageState] = useState<{ scope: string; offset: number }>(
    { scope: currentScope, offset: 0 },
  );
  const offset = pageState.scope === currentScope ? pageState.offset : 0;
  // Bumped after a completed ingest or a delete to refetch the list.
  const [listEpoch, setListEpoch] = useState(0);

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
          if (status.status !== 'pending') {
            setUploadState({
              scope: currentScope,
              phase: { kind: 'report', status },
            });
            if (status.status === 'completed') setListEpoch((epoch) => epoch + 1);
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
  }, [upload, currentScope]);

  // ── Contact list fetch ────────────────────────────────────────────────────

  interface ListData {
    contacts: ContactListItem[];
    total: number;
  }
  const listKey = `${currentScope}:${offset}:${listEpoch}`;
  const [listResult, setListResult] = useState<{
    key: string;
    data?: ListData;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (currentScope === 'all') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/contacts?scope=${currentScope}&limit=${PAGE_LIMIT}&offset=${offset}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          const body: { error?: string } = await res.json().catch(() => ({}));
          setListResult({
            key: listKey,
            error: body.error ?? `Failed to load contacts (${res.status}).`,
          });
          return;
        }
        const data = (await res.json()) as ListData;
        if (!cancelled) setListResult({ key: listKey, data });
      } catch {
        if (!cancelled) {
          setListResult({ key: listKey, error: 'Could not reach the server.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listKey, currentScope, offset]);

  const list = listResult?.key === listKey ? listResult : null;

  // ── Delete flow (confirm step, then DELETE + refetch) ─────────────────────

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(contactId: string) {
    if (currentScope === 'all') return;
    setDeletingId(contactId);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/dashboard/contacts/${contactId}?scope=${currentScope}`,
        { method: 'DELETE' },
      );
      if (res.status === 204) {
        setConfirmingId(null);
        setListEpoch((epoch) => epoch + 1);
      } else {
        const body: { error?: string } = await res.json().catch(() => ({}));
        setDeleteError(body.error ?? `Delete failed (${res.status}).`);
      }
    } catch {
      setDeleteError('Could not reach the server. Try again.');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Aggregate scope has no meaning for per-location contacts ──────────────

  if (currentScope === 'all') {
    return (
      <>
        <TopBar title="Contacts" subtitle="Customer visit history for review-request evaluation." />
        <div className="content">
          <div className="card section-enter section-enter-1">
            <h2 className="card-h2">Choose a location</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: 0 }}>
              Contacts are kept per location. Pick a location from the switcher to
              upload a CSV or browse its contacts.
            </p>
          </div>
        </div>
      </>
    );
  }

  const busy = upload.kind === 'submitting' || upload.kind === 'processing';

  return (
    <>
      <TopBar
        title="Contacts"
        subtitle="Upload customer visit history — watch-mode only, no review requests are sent."
      />
      <div className="content">
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

        <div className="card section-enter section-enter-2">
          <h2 className="card-h2">
            Contacts
            {list?.data && (
              <span style={{ fontSize: 13, fontFamily: 'var(--rw-font-body)', color: 'var(--rw-app-text-muted)', marginLeft: 10 }}>
                {list.data.total} total
              </span>
            )}
          </h2>
          {list == null ? (
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: 0 }}>
              Loading contacts…
            </p>
          ) : list.error != null ? (
            <div
              role="alert"
              style={{ fontSize: 13, color: 'var(--rw-danger)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
            >
              <span>{list.error}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setListEpoch((epoch) => epoch + 1)}
              >
                Retry
              </button>
            </div>
          ) : list.data && list.data.contacts.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: 0 }}>
              No contacts yet — upload a CSV above to get started.
            </p>
          ) : list.data ? (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Name', 'Email', 'Phone', 'Last visit', 'Visits', ''].map(
                        (header) => (
                          <th
                            key={header}
                            scope="col"
                            style={{
                              textAlign: header === 'Visits' ? 'right' : 'left',
                              fontSize: 11,
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              color: 'var(--rw-app-text-soft)',
                              padding: '6px 10px',
                              borderBottom: '1px solid var(--rw-hair-2)',
                            }}
                          >
                            {header}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.contacts.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        contact={contact}
                        confirming={confirmingId === contact.id}
                        deleting={deletingId === contact.id}
                        deleteError={confirmingId === contact.id ? deleteError : null}
                        onRequestDelete={() => {
                          setConfirmingId(contact.id);
                          setDeleteError(null);
                        }}
                        onCancelDelete={() => {
                          setConfirmingId(null);
                          setDeleteError(null);
                        }}
                        onConfirmDelete={() => void handleDelete(contact.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                offset={offset}
                total={list.data.total}
                shown={list.data.contacts.length}
                onPage={(nextOffset) =>
                  setPageState({ scope: currentScope, offset: nextOffset })
                }
              />
            </>
          ) : null}
        </div>
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

  if (status.status === 'failed') {
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
  // Terminal failure (#541): retries exhausted → error: 'ingest_failed';
  // otherwise a structural rejection of the whole file.
  const message =
    report?.error === 'ingest_failed'
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

// ── Contact list pieces ─────────────────────────────────────────────────────

function ContactRow({
  contact,
  confirming,
  deleting,
  deleteError,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  contact: ContactListItem;
  confirming: boolean;
  deleting: boolean;
  deleteError: string | null;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const cellStyle: React.CSSProperties = {
    padding: '10px 10px',
    borderBottom: '1px solid var(--rw-hair)',
    verticalAlign: 'top',
  };
  return (
    <>
      <tr>
        <td style={{ ...cellStyle, fontWeight: 600 }}>{contact.name}</td>
        <td style={{ ...cellStyle, color: 'var(--rw-app-text-muted)' }}>
          {contact.email ?? '—'}
        </td>
        <td style={{ ...cellStyle, color: 'var(--rw-app-text-muted)' }}>
          {contact.phone ?? '—'}
        </td>
        <td style={cellStyle}>{formatVisitDate(contact.lastVisitDate)}</td>
        <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {contact.visitCount}
        </td>
        <td style={{ ...cellStyle, textAlign: 'right' }}>
          {!confirming && (
            <button
              type="button"
              className="btn btn-tertiary"
              onClick={onRequestDelete}
              aria-label={`Delete ${contact.name}`}
            >
              Delete
            </button>
          )}
        </td>
      </tr>
      {confirming && (
        <tr>
          <td colSpan={6} style={{ padding: 0, borderBottom: '1px solid var(--rw-hair)' }}>
            <div
              style={{
                background: 'var(--rw-danger-soft)',
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--rw-danger)', fontWeight: 600 }}>
                Hard delete — removes this person and all their visits permanently.
              </span>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--rw-danger)', color: '#FDFBF7' }}
                disabled={deleting}
                onClick={onConfirmDelete}
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deleting}
                onClick={onCancelDelete}
              >
                Cancel
              </button>
              {deleteError && (
                <span role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)' }}>
                  {deleteError}
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Pagination({
  offset,
  total,
  shown,
  onPage,
}: {
  offset: number;
  total: number;
  shown: number;
  onPage: (offset: number) => void;
}) {
  if (total <= PAGE_LIMIT) return null;
  const from = offset + 1;
  const to = offset + shown;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={offset === 0}
        onClick={() => onPage(Math.max(0, offset - PAGE_LIMIT))}
      >
        Previous
      </button>
      <span style={{ fontSize: 13, color: 'var(--rw-app-text-muted)' }}>
        {from}–{to} of {total}
      </span>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={offset + PAGE_LIMIT >= total}
        onClick={() => onPage(offset + PAGE_LIMIT)}
      >
        Next
      </button>
    </div>
  );
}

/** visit_date arrives as canonical YYYY-MM-DD (UTC date, no time component). */
function formatVisitDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
