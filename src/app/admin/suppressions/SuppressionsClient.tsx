'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminSuppressionCorrectionRow,
  AdminSuppressionRow,
  LookupSuppressionsResult,
} from '@/lib/admin/suppressions-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';

/**
 * The §7.2 daily mailbox-servicing surface (#645). Three regions, in the order
 * the ritual uses them: look an address up, record a manual opt-out for it
 * (§7.3), and — only for a record that is factually wrong — take the audited
 * Correction path (§8.2).
 *
 * The copy in this file is load-bearing, not decoration. The Correction path is
 * error correction and NEVER a re-subscribe, so the affordance is "Correct this
 * record" and the confirm step says so in full; an admin who reads this screen
 * as an unsubscribe-undo button is the exact failure §8.2's framing exists to
 * prevent. A failed correction therefore leaves the row on screen — believing an
 * opt-out was removed when it was not is the inverse hazard.
 */

const INVALID_HANDLE_COPY = 'That is not a valid email address';

/** Verbatim from the spec §8.2 framing — do not soften, shorten, or reword. */
const CORRECTION_CONFIRM_COPY =
  'Error correction only. This removes a suppression that was recorded in error — it is not a re-subscribe, and it does not give anyone permission to contact this person again.';

/**
 * A 404 from the Correction path means the row was ALREADY gone — another admin
 * corrected it between this admin's lookup and their confirm. Nobody is
 * suppressed by that record any more. Rendering this as "the suppression is
 * still in place" tells an admin they are protected when the recipient is in
 * fact mailable again, which is the worst sentence this screen can produce.
 */
const CORRECTION_ALREADY_REMOVED_COPY =
  'This record was already removed — another admin corrected it first. It is no longer suppressing anyone.';

/**
 * Every server error code these three endpoints can return, mapped to a
 * sentence. A raw API token must never reach an admin's screen: it is
 * unreadable at best, and — as `not_found` proved — a token carries no
 * statement at all about who is still suppressed. Clause-shaped, no trailing
 * period, because the Correction path composes onto it.
 *
 * A Map, not an object literal: `code` is server-supplied, and an object lookup
 * on `'constructor'` or `'toString'` resolves to a prototype member — rendering
 * a function where a sentence belongs. Unreachable today; unreachable by
 * construction now.
 */
const ERROR_COPY = new Map<string, string>([
  ['invalid_handle', INVALID_HANDLE_COPY],
  ['invalid_body', 'The request was malformed — reload the page and try again'],
  ['forbidden', 'That request was refused — reload the page and try again'],
  ['mfa_required', 'Your admin session needs a fresh MFA step-up'],
  ['internal_error', 'Something went wrong on our side'],
]);

/**
 * Never render `body.error` directly: an unrecognised code falls back to a
 * sentence rather than leaking the token itself.
 */
function errorSentence(code: string | undefined, fallback: string): string {
  if (code === undefined) return fallback;
  return ERROR_COPY.get(code) ?? fallback;
}

const ENTRY_NOTE_HELPER =
  "Where this opt-out came from — the reply's subject, date, or message id. Required: this is the audit trail.";

const PRIMARY_BUTTON =
  'min-h-11 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
  'min-h-11 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50';
const FIELD =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200';
const SECTION = 'rounded-md border border-gray-200 bg-white p-5';
const SECTION_TITLE = 'text-sm font-semibold text-gray-900';

/**
 * `suppressed_at`/`created_at` arrive as Postgres `::text`, whose format Date
 * parsing treats as implementation-defined. Falling back to the raw value keeps
 * a servicing admin looking at a timestamp rather than "Invalid Date".
 */
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

async function lookupAddress(email: string): Promise<LookupSuppressionsResult> {
  // A POST for a read, on purpose: §9.5 forbids logging the raw handle, and an
  // address in a query string is logged by construction — access logs, log
  // drains, browser history. It travels in the body instead.
  const response = await fetch('/api/admin/suppressions/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    handle?: string;
    rows?: AdminSuppressionRow[];
    corrections?: AdminSuppressionCorrectionRow[];
  };

  // A 400 `invalid_handle` is an answer about the INPUT, not a transport
  // failure, so it is returned rather than thrown: it renders as "that is not a
  // valid email address" and never as "not found". Reporting a typo as
  // not-suppressed is how a live opt-out gets mailed anyway.
  if (response.status === 400 && body.error === 'invalid_handle') {
    return { ok: false, error: 'invalid_handle' };
  }
  if (
    !response.ok ||
    typeof body.handle !== 'string' ||
    !Array.isArray(body.rows) ||
    !Array.isArray(body.corrections)
  ) {
    throw new Error(errorSentence(body.error, `Lookup failed (${response.status})`));
  }
  return { ok: true, handle: body.handle, rows: body.rows, corrections: body.corrections };
}

async function recordManualEntry(input: {
  email: string;
  note: string;
}): Promise<{ created: boolean; handle: string }> {
  const response = await fetch('/api/admin/suppressions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as {
    created?: boolean;
    handle?: string;
    error?: string;
  };
  if (!response.ok || typeof body.created !== 'boolean' || typeof body.handle !== 'string') {
    throw new Error(errorSentence(body.error, `Entry failed (${response.status})`));
  }
  return { created: body.created, handle: body.handle };
}

/**
 * `corrected` — the row was live and this admin removed it.
 * `already_removed` — the row was already gone (404). NOT a failure, and above
 * all not a suppression that is "still in place".
 */
type CorrectionOutcome = 'corrected' | 'already_removed';

async function submitCorrection(input: {
  suppressionId: string;
  reason: string;
}): Promise<CorrectionOutcome> {
  const response = await fetch('/api/admin/suppressions/correct', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as {
    corrected?: boolean;
    error?: string;
  };
  // A 404 is a concurrent correction, not a failed one. It is returned rather
  // than thrown so the caller can say the true thing and re-read the ledger,
  // instead of inheriting the genuine-failure branch's "still in place".
  if (response.status === 404 && body.error === 'not_found') return 'already_removed';
  if (!response.ok || body.corrected !== true) {
    throw new Error(errorSentence(body.error, `Correction failed (${response.status})`));
  }
  return 'corrected';
}

function LookupResults({
  result,
  onSelect,
  selectedId,
}: {
  result: LookupSuppressionsResult;
  onSelect: (row: AdminSuppressionRow) => void;
  selectedId: string | null;
}) {
  if (!result.ok) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
        {INVALID_HANDLE_COPY}
      </p>
    );
  }

  const liveColumns: DataTableColumn<AdminSuppressionRow>[] = [
    {
      key: 'scope',
      header: 'Scope',
      render: (row) => <StatusBadge status={row.scope} />,
      sortValue: (row) => row.scope,
    },
    {
      key: 'source',
      header: 'Source',
      render: (row) => <StatusBadge status={row.source} />,
      sortValue: (row) => row.source,
    },
    {
      key: 'suppressedAt',
      header: 'Recorded',
      render: (row) => formatTimestamp(row.suppressedAt),
      sortValue: (row) => row.suppressedAt,
    },
    {
      key: 'account',
      header: 'Account',
      // Only an `account`-scoped row (or a global row carrying provenance) names
      // one; a mailbox-reply entry has none, and an em dash says so honestly.
      render: (row) => row.accountName ?? '—',
    },
    { key: 'note', header: 'Note', render: (row) => row.note ?? '—' },
    {
      key: 'correct',
      header: '',
      className: 'text-right',
      render: (row) => (
        <button
          type="button"
          onClick={() => onSelect(row)}
          aria-pressed={selectedId === row.id}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Correct this record
        </button>
      ),
    },
  ];

  const correctionColumns: DataTableColumn<AdminSuppressionCorrectionRow>[] = [
    {
      key: 'createdAt',
      header: 'Corrected',
      render: (row) => formatTimestamp(row.createdAt),
      sortValue: (row) => row.createdAt,
    },
    { key: 'scope', header: 'Scope', render: (row) => <StatusBadge status={row.scope} /> },
    { key: 'source', header: 'Source', render: (row) => <StatusBadge status={row.source} /> },
    { key: 'reason', header: 'Reason', render: (row) => row.reason },
    {
      key: 'removedBy',
      header: 'Removed by',
      render: (row) => <span className="font-mono text-xs">{row.removedByUserId}</span>,
    },
  ];

  return (
    <div className="mt-4 space-y-6">
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
          Live suppressions for {result.handle}
        </h3>
        <DataTable
          columns={liveColumns}
          rows={result.rows}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="Not suppressed"
              detail={`No live Suppression ledger row for ${result.handle}.`}
            />
          }
        />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
          Prior corrections for {result.handle}
        </h3>
        <DataTable
          columns={correctionColumns}
          rows={result.corrections}
          rowKey={(row) => row.id}
          emptyState={
            <EmptyState
              title="No corrections recorded"
              detail="No suppression for this address has been removed on the Correction path."
            />
          }
        />
      </div>
    </div>
  );
}

function CorrectionPanel({
  target,
  reason,
  onReasonChange,
  onCancel,
  onConfirm,
  pending,
}: {
  target: AdminSuppressionRow | null;
  reason: string;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  if (target === null) {
    return (
      <EmptyState
        title="No record selected"
        detail="Choose a record from the lookup results above to begin."
      />
    );
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (reason.trim() === '') return;
    onConfirm();
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800">
        {target.normalizedHandle} · {target.scope} · {target.source} ·{' '}
        {formatTimestamp(target.suppressedAt)}
      </p>
      <p className="text-sm font-medium text-gray-900">{CORRECTION_CONFIRM_COPY}</p>
      <label htmlFor="correction-reason" className="text-xs font-semibold text-gray-900">
        Why is this record wrong?
      </label>
      <textarea
        id="correction-reason"
        value={reason}
        onChange={(event) => onReasonChange(event.target.value)}
        maxLength={1_000}
        rows={3}
        required
        className={`min-h-20 resize-y ${FIELD}`}
      />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || reason.trim() === ''} className={PRIMARY_BUTTON}>
          {pending ? 'Correcting…' : 'Confirm correction'}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className={SECONDARY_BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SuppressionsClient() {
  const queryClient = useQueryClient();

  const [emailInput, setEmailInput] = useState('');
  const [lookupHandle, setLookupHandle] = useState('');
  const [entryEmail, setEntryEmail] = useState('');
  const [entryNote, setEntryNote] = useState('');
  const [correctionTarget, setCorrectionTarget] = useState<AdminSuppressionRow | null>(null);
  const [correctionReason, setCorrectionReason] = useState('');

  const lookup = useQuery<LookupSuppressionsResult>({
    queryKey: ['admin-suppressions', lookupHandle],
    queryFn: () => lookupAddress(lookupHandle),
    enabled: lookupHandle !== '',
    staleTime: 30_000,
  });

  const entry = useMutation({
    mutationFn: recordManualEntry,
    onSuccess: () => {
      setEntryEmail('');
      setEntryNote('');
      void queryClient.invalidateQueries({ queryKey: ['admin-suppressions'] });
    },
  });

  const correction = useMutation({
    mutationFn: submitCorrection,
    onSuccess: () => {
      // Cleared on a confirmed removal AND on an already-removed 404 — in both
      // cases the row on screen is stale. A genuine failure deliberately leaves
      // the panel and the row exactly where they were.
      setCorrectionTarget(null);
      setCorrectionReason('');
      // The re-read is what makes the already-removed message trustworthy: the
      // admin ends up looking at current ledger state, not at the row they just
      // acted on.
      void queryClient.invalidateQueries({ queryKey: ['admin-suppressions'] });
    },
  });

  function runLookup(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next = emailInput.trim();
    if (next === '') return;
    setCorrectionTarget(null);
    setCorrectionReason('');
    setLookupHandle(next);
  }

  function submitEntry(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const email = entryEmail.trim();
    const note = entryNote.trim();
    if (email === '' || note === '') return;
    entry.mutate({ email, note });
  }

  return (
    <AdminPage
      group="Safety"
      title="Suppressions"
      description="Service the opt-out mailbox: look an address up, record a manual opt-out, or correct a record entered in error"
    >
      <div className="space-y-6">
        <section aria-labelledby="lookup-heading" className={SECTION}>
          <h2 id="lookup-heading" className={SECTION_TITLE}>
            Look up an address
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">
            There is no list of every opted-out recipient — start from the address in the
            forwarded reply.
          </p>
          <form onSubmit={runLookup} className="mt-3 flex flex-wrap items-end gap-2">
            <div className="grow">
              <label htmlFor="lookup-email" className="text-xs font-semibold text-gray-900">
                Email address
              </label>
              <input
                id="lookup-email"
                type="text"
                inputMode="email"
                autoComplete="off"
                value={emailInput}
                onChange={(event) => setEmailInput(event.target.value)}
                maxLength={320}
                className={`mt-1 ${FIELD}`}
              />
            </div>
            <button type="submit" disabled={emailInput.trim() === ''} className={PRIMARY_BUTTON}>
              Look up
            </button>
          </form>

          {lookup.isLoading ? (
            <div className="mt-4">
              <TableSkeleton rows={3} />
            </div>
          ) : lookup.isError ? (
            <div className="mt-4">
              <ErrorState
                title="Couldn't look up that address"
                detail="POST /api/admin/suppressions/lookup failed"
                onRetry={() => void lookup.refetch()}
              />
            </div>
          ) : lookup.data ? (
            <LookupResults
              result={lookup.data}
              onSelect={(row) => {
                setCorrectionTarget(row);
                setCorrectionReason('');
                correction.reset();
              }}
              selectedId={correctionTarget?.id ?? null}
            />
          ) : null}
        </section>

        <section aria-labelledby="entry-heading" className={SECTION}>
          <h2 id="entry-heading" className={SECTION_TITLE}>
            Enter a manual opt-out
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Records a global opt-out for an address that asked to stop by reply. Takes effect
            immediately and applies everywhere.
          </p>
          <form onSubmit={submitEntry} className="mt-3 grid max-w-xl gap-3">
            <div>
              <label htmlFor="entry-email" className="text-xs font-semibold text-gray-900">
                Email address
              </label>
              <input
                id="entry-email"
                type="text"
                inputMode="email"
                autoComplete="off"
                value={entryEmail}
                onChange={(event) => setEntryEmail(event.target.value)}
                maxLength={320}
                required
                className={`mt-1 ${FIELD}`}
              />
            </div>
            <div>
              <label htmlFor="entry-note" className="text-xs font-semibold text-gray-900">
                Originating message reference
              </label>
              <p id="entry-note-help" className="mt-0.5 text-xs text-gray-500">
                {ENTRY_NOTE_HELPER}
              </p>
              <textarea
                id="entry-note"
                aria-describedby="entry-note-help"
                value={entryNote}
                onChange={(event) => setEntryNote(event.target.value)}
                maxLength={1_000}
                rows={2}
                required
                className={`mt-1 min-h-16 resize-y ${FIELD}`}
              />
            </div>
            <div>
              <button
                type="submit"
                disabled={
                  entry.isPending || entryEmail.trim() === '' || entryNote.trim() === ''
                }
                className={PRIMARY_BUTTON}
              >
                {entry.isPending ? 'Recording…' : 'Record opt-out'}
              </button>
            </div>
          </form>

          {entry.isSuccess && (
            <p
              role="status"
              className="mt-3 rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800"
            >
              {entry.data.created
                ? `Opt-out recorded for ${entry.data.handle}.`
                : // First-write-wins (§2.1): the state is already correct, so a
                  // repeat entry is a no-op SUCCESS and must not read as failure.
                  `Already suppressed — no change. ${entry.data.handle} was already opted out.`}
            </p>
          )}
          {entry.isError && (
            <p
              role="alert"
              className="mt-3 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
            >
              {entry.error instanceof Error ? entry.error.message : 'Entry failed'}
            </p>
          )}
        </section>

        <section aria-labelledby="correction-heading" className={SECTION}>
          <h2 id="correction-heading" className={SECTION_TITLE}>
            Correction path
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Admin-only and audited. Every removal writes a record naming who removed it and why.
          </p>
          <div className="mt-3">
            <CorrectionPanel
              target={correctionTarget}
              reason={correctionReason}
              onReasonChange={setCorrectionReason}
              onCancel={() => {
                setCorrectionTarget(null);
                setCorrectionReason('');
              }}
              onConfirm={() => {
                if (correctionTarget === null) return;
                correction.mutate({
                  suppressionId: correctionTarget.id,
                  reason: correctionReason.trim(),
                });
              }}
              pending={correction.isPending}
            />
          </div>
          {correction.isSuccess && correction.data === 'corrected' && (
            <p
              role="status"
              className="mt-3 rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800"
            >
              Record corrected. The removal is in the audit trail.
            </p>
          )}
          {correction.isSuccess && correction.data === 'already_removed' && (
            // Not green: nothing this admin did took effect, and the recipient
            // is mailable again. Not red either — no failure occurred.
            <p
              role="alert"
              className="mt-3 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
            >
              {CORRECTION_ALREADY_REMOVED_COPY}
            </p>
          )}
          {correction.isError && (
            <p
              role="alert"
              className="mt-3 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
            >
              {correction.error instanceof Error
                ? `${correction.error.message} — the suppression is still in place.`
                : 'Correction failed — the suppression is still in place.'}
            </p>
          )}
        </section>
      </div>
    </AdminPage>
  );
}
