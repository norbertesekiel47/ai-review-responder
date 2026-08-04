'use client';

import { useEffect, useState } from 'react';
import { useLocationScope } from '@/contexts/LocationContext';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { ContactListItem } from '@/lib/solicitation/contacts-repo';

/**
 * Contact-list lane of /dashboard/requests/contacts (#541): paginated tenant-scoped
 * list, confirm-step hard delete, and the §7.4 suppression state with its
 * do-not-contact controls (#645). Split from ContactsClient so each concern
 * stays independently scannable; `epoch` (bumped by the parent when an ingest
 * completes) and `onRefresh` (bumps the same counter after a delete, a
 * suppression change, or a retry) are the only integration points with the
 * upload lane.
 *
 * Two mutations that must never be confused live in this file: DELETE
 * `/contacts/<id>` erases a customer record and their visit history, while
 * POST/DELETE `/contacts/<id>/suppression` only changes whether we may mail a
 * handle. Their call sites are deliberately separate functions with separate
 * URL builders so a copy-paste cannot silently swap one for the other.
 */

const PAGE_LIMIT = 50;

interface ListData {
  contacts: ContactListItem[];
  total: number;
}

interface ContactListProps {
  /** Refetch counter owned by the parent — bumped on ingest completion. */
  epoch: number;
  /** Bumps `epoch` (delete success, error retry). */
  onRefresh: () => void;
}

export function ContactList({ epoch, onRefresh }: ContactListProps) {
  const { currentScope } = useLocationScope();

  // Contact list paging, keyed by scope so a location switch reads offset 0.
  const [pageState, setPageState] = useState<{ scope: string; offset: number }>(
    { scope: currentScope, offset: 0 },
  );
  const offset = pageState.scope === currentScope ? pageState.offset : 0;

  const list = useContactListFetch(currentScope, offset, epoch);
  const deletion = useContactDelete(currentScope, onRefresh);
  const suppression = useContactSuppression(currentScope, onRefresh);

  return (
    <div className="card section-enter section-enter-2">
      <h2 className="card-h2">
        Contacts
        {list?.data && (
          <span style={{ fontSize: 13, fontFamily: 'var(--rw-font-body)', color: 'var(--rw-app-text-muted)', marginLeft: 10 }}>
            {list.data.total} total
          </span>
        )}
      </h2>
      <ContactListBody
        list={list}
        offset={offset}
        deletion={deletion}
        suppression={suppression}
        onRefresh={onRefresh}
        onPage={(nextOffset) =>
          setPageState({ scope: currentScope, offset: nextOffset })
        }
      />
    </div>
  );
}

function ContactListBody({
  list,
  offset,
  deletion,
  suppression,
  onRefresh,
  onPage,
}: {
  list: ListResult | null;
  offset: number;
  deletion: ContactDeletion;
  suppression: ContactSuppression;
  onRefresh: () => void;
  onPage: (offset: number) => void;
}) {
  if (list == null) {
    return (
      <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: 0 }}>
        Loading contacts…
      </p>
    );
  }
  if (list.error != null) {
    return (
      <div
        role="alert"
        style={{ fontSize: 13, color: 'var(--rw-danger)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
      >
        <span>{list.error}</span>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onRefresh}
        >
          Retry
        </button>
      </div>
    );
  }
  if (list.data == null) return null;
  if (list.data.contacts.length === 0) {
    return (
      <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', margin: 0 }}>
        No contacts yet — upload a CSV above to get started.
      </p>
    );
  }
  return (
    <>
      <ContactTable
        contacts={list.data.contacts}
        deletion={deletion}
        suppression={suppression}
      />
      <Pagination
        offset={offset}
        total={list.data.total}
        shown={list.data.contacts.length}
        onPage={onPage}
      />
    </>
  );
}

// ── Contact list fetch ───────────────────────────────────────────────────────

interface ListResult {
  data?: ListData;
  error?: string;
}

/** Fetches one page; the result is keyed by scope/offset/epoch so a stale
 *  response for a previous key renders as loading, never as wrong data. */
function useContactListFetch(
  currentScope: string,
  offset: number,
  epoch: number,
): ListResult | null {
  const listKey = `${currentScope}:${offset}:${epoch}`;
  const [listResult, setListResult] = useState<({ key: string } & ListResult) | null>(null);

  useEffect(() => {
    if (currentScope === 'all') return;
    let cancelled = false;
    void fetchContactPage(currentScope, offset).then((result) => {
      // Single post-await state write, guarded against unmount/key change.
      if (!cancelled) setListResult({ key: listKey, ...result });
    });
    return () => {
      cancelled = true;
    };
  }, [listKey, currentScope, offset]);

  return listResult?.key === listKey ? listResult : null;
}

/** Never throws — network/HTTP failures come back as `{ error }` copy. */
async function fetchContactPage(scope: string, offset: number): Promise<ListResult> {
  try {
    const res = await fetch(
      withSolicitationScope(
        `/api/dashboard/contacts?limit=${PAGE_LIMIT}&offset=${offset}`,
        scope,
      ),
    );
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      return { error: body.error ?? `Failed to load contacts (${res.status}).` };
    }
    return { data: (await res.json()) as ListData };
  } catch {
    return { error: 'Could not reach the server.' };
  }
}

// ── Delete flow (confirm step, then DELETE + refetch) ────────────────────────

interface ContactDeletion {
  confirmingId: string | null;
  deletingId: string | null;
  deleteError: string | null;
  requestDelete: (contactId: string) => void;
  cancelDelete: () => void;
  confirmDelete: (contactId: string) => void;
}

function useContactDelete(currentScope: string, onRefresh: () => void): ContactDeletion {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(contactId: string) {
    if (currentScope === 'all') return;
    setDeletingId(contactId);
    setDeleteError(null);
    const error = await requestContactDelete(contactId, currentScope);
    if (error === null) {
      setConfirmingId(null);
      onRefresh();
    } else {
      setDeleteError(error);
    }
    setDeletingId(null);
  }

  return {
    confirmingId,
    deletingId,
    deleteError,
    requestDelete: (contactId) => {
      setConfirmingId(contactId);
      setDeleteError(null);
    },
    cancelDelete: () => {
      setConfirmingId(null);
      setDeleteError(null);
    },
    confirmDelete: (contactId) => void handleDelete(contactId),
  };
}

/** DELETEs one contact; returns null on success or the error copy to show. */
async function requestContactDelete(contactId: string, scope: string): Promise<string | null> {
  try {
    const res = await fetch(
      withSolicitationScope(`/api/dashboard/contacts/${contactId}`, scope),
      { method: 'DELETE' },
    );
    if (res.status === 204) return null;
    const body: { error?: string } = await res.json().catch(() => ({}));
    return body.error ?? `Delete failed (${res.status}).`;
  } catch {
    return 'Could not reach the server. Try again.';
  }
}

// ── Do-not-contact flow (§7.5 mark, §7.6 clear) ─────────────────────────────

interface ContactSuppression {
  /** Row whose "Don't contact" confirm step is open. */
  confirmingId: string | null;
  /** Row with a suppression mutation in flight. */
  pendingId: string | null;
  /** The row a failure belongs to, and its copy — never a global banner, so an
   *  error can never read as if it applied to a different contact. */
  errorId: string | null;
  error: string | null;
  requestMark: (contactId: string) => void;
  cancelMark: () => void;
  confirmMark: (contactId: string) => void;
  clear: (contactId: string) => void;
}

/**
 * §7.5 marking rides the same confirm step as the delete control; §7.6 clearing
 * does not, because it removes a preference this account set rather than
 * creating one.
 *
 * A FAILED mutation deliberately does not call `onRefresh`. Bumping the epoch
 * would refetch a page the server never changed and re-render the row as
 * though the change landed — the owner would believe a contact was suppressed
 * when they are still mailable, which is the inverse of the hazard this whole
 * surface exists to prevent.
 */
function useContactSuppression(currentScope: string, onRefresh: () => void): ContactSuppression {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);

  async function mutate(contactId: string, method: 'POST' | 'DELETE') {
    if (currentScope === 'all') return;
    setPendingId(contactId);
    setFailure(null);
    const error = await requestSuppressionChange(contactId, currentScope, method);
    if (error === null) {
      setConfirmingId(null);
      onRefresh();
    } else {
      setFailure({ id: contactId, message: error });
    }
    setPendingId(null);
  }

  return {
    confirmingId,
    pendingId,
    errorId: failure?.id ?? null,
    error: failure?.message ?? null,
    requestMark: (contactId) => {
      setConfirmingId(contactId);
      setFailure(null);
    },
    cancelMark: () => {
      setConfirmingId(null);
      setFailure(null);
    },
    confirmMark: (contactId) => void mutate(contactId, 'POST'),
    clear: (contactId) => void mutate(contactId, 'DELETE'),
  };
}

/**
 * The ONLY caller of the suppression endpoint. `/contacts/<id>/suppression`
 * changes whether we may mail a handle; the sibling `/contacts/<id>` erases the
 * customer record. Keeping the two URL builders apart is what stops a
 * do-not-contact control ever hard-deleting somebody's history.
 *
 * Returns null on success or the error copy to show.
 */
async function requestSuppressionChange(
  contactId: string,
  scope: string,
  method: 'POST' | 'DELETE',
): Promise<string | null> {
  try {
    const res = await fetch(
      withSolicitationScope(`/api/dashboard/contacts/${contactId}/suppression`, scope),
      { method },
    );
    if (res.ok) return null;
    const body: { error?: string } = await res.json().catch(() => ({}));
    return body.error ?? `Could not update this contact (${res.status}).`;
  } catch {
    return 'Could not reach the server. Try again.';
  }
}

// ── Contact list pieces ─────────────────────────────────────────────────────

const TABLE_HEADERS = ['Name', 'Email', 'Phone', 'Last visit', 'Visits', ''] as const;

const headerCellStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--rw-app-text-soft)',
  padding: '6px 10px',
  borderBottom: '1px solid var(--rw-hair-2)',
};

function ContactTable({
  contacts,
  deletion,
  suppression,
}: {
  contacts: ContactListItem[];
  deletion: ContactDeletion;
  suppression: ContactSuppression;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {TABLE_HEADERS.map((header) => (
              <th
                key={header}
                scope="col"
                style={{
                  ...headerCellStyle,
                  textAlign: header === 'Visits' ? 'right' : 'left',
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contacts.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              deletion={deletion}
              suppression={suppression}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  padding: '10px 10px',
  borderBottom: '1px solid var(--rw-hair)',
  verticalAlign: 'top',
};

function ContactRow({
  contact,
  deletion,
  suppression,
}: {
  contact: ContactListItem;
  deletion: ContactDeletion;
  suppression: ContactSuppression;
}) {
  const confirmingDelete = deletion.confirmingId === contact.id;
  const confirmingMark = suppression.confirmingId === contact.id;
  const suppressionError = suppression.errorId === contact.id ? suppression.error : null;

  return (
    <>
      <tr>
        <td style={{ ...cellStyle, fontWeight: 600 }}>{contact.name}</td>
        <td style={{ ...cellStyle, color: 'var(--rw-app-text-muted)' }}>
          <div>{contact.email ?? '—'}</div>
          {contact.suppression !== null && (
            <div style={{ marginTop: 5 }}>
              <SuppressionBadge display={contact.suppression} />
            </div>
          )}
        </td>
        <td style={{ ...cellStyle, color: 'var(--rw-app-text-muted)' }}>
          {contact.phone ?? '—'}
        </td>
        <td style={cellStyle}>{formatVisitDate(contact.lastVisitDate)}</td>
        <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {contact.visitCount}
        </td>
        <td style={{ ...cellStyle, textAlign: 'right' }}>
          <div
            style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}
          >
            {!confirmingMark && (
              <SuppressionControl contact={contact} suppression={suppression} />
            )}
            {!confirmingDelete && (
              <button
                type="button"
                className="btn btn-tertiary"
                onClick={() => deletion.requestDelete(contact.id)}
                aria-label={`Delete ${contact.name}`}
              >
                Delete
              </button>
            )}
          </div>
          {/* While the confirm step is open its own row owns the error, so it
              is never shown twice. */}
          {suppressionError !== null && !confirmingMark && (
            <p
              role="alert"
              style={{ fontSize: 12, color: 'var(--rw-danger)', margin: '6px 0 0' }}
            >
              {suppressionError}
            </p>
          )}
        </td>
      </tr>
      {confirmingMark && (
        <MarkDoNotContactRow
          name={contact.name}
          pending={suppression.pendingId === contact.id}
          error={suppressionError}
          onConfirm={() => suppression.confirmMark(contact.id)}
          onCancel={suppression.cancelMark}
        />
      )}
      {confirmingDelete && (
        <DeleteConfirmRow
          deleting={deletion.deletingId === contact.id}
          deleteError={deletion.deleteError}
          onConfirmDelete={() => deletion.confirmDelete(contact.id)}
          onCancelDelete={deletion.cancelDelete}
        />
      )}
    </>
  );
}

/** §7.4 state, keyed on the display seam's closed scope enum. Neither wash is
 *  danger: an opt-out is a fact about a person, not a fault. */
const SUPPRESSION_BADGE_STYLE: Record<
  NonNullable<ContactListItem['suppression']>['state'],
  React.CSSProperties
> = {
  // The recipient spoke. Neutral cream — stated, not alarmed.
  global: { background: 'var(--rw-cream)', color: 'var(--rw-app-text-muted)' },
  // The owner's own setting, in the accent that reads as "yours".
  account: { background: 'var(--rw-accent-100)', color: 'var(--rw-accent-800)' },
};

function SuppressionBadge({
  display,
}: {
  display: NonNullable<ContactListItem['suppression']>;
}) {
  return (
    <span
      className="badge"
      // `detail` is the seam's own copy; it carries no account name and no
      // source, so a tooltip cannot leak provenance (§7.4, invariant #8).
      title={display.detail}
      style={SUPPRESSION_BADGE_STYLE[display.state]}
    >
      {display.label}
    </span>
  );
}

/**
 * §7.4/§7.6, three states — and the third is the one that is easy to get
 * subtly wrong. A global row gets **no control at all**, not a disabled one:
 * a greyed-out "Allow requests again" would present clearing a recipient's own
 * revocation and clearing the owner's own preference as the same act with one
 * temporarily unavailable, which is exactly what §7.6 forbids. The two are
 * different acts, and only one of them belongs to the owner.
 */
function SuppressionControl({
  contact,
  suppression,
}: {
  contact: ContactListItem;
  suppression: ContactSuppression;
}) {
  const pending = suppression.pendingId === contact.id;

  if (contact.suppression === null) {
    return (
      <button
        type="button"
        className="btn btn-tertiary"
        disabled={pending}
        onClick={() => suppression.requestMark(contact.id)}
        aria-label={`Don't contact ${contact.name}`}
      >
        Don&apos;t contact
      </button>
    );
  }

  if (!contact.suppression.clearableByOwner) return null;

  return (
    <button
      type="button"
      className="btn btn-tertiary"
      disabled={pending}
      onClick={() => suppression.clear(contact.id)}
      aria-label={`Allow requests again for ${contact.name}`}
    >
      {pending ? 'Saving…' : 'Allow requests again'}
    </button>
  );
}

/** §7.5 confirm step — the delete control's pattern, in the accent wash rather
 *  than the danger one, because nothing is destroyed here. */
function MarkDoNotContactRow({
  name,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  name: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <tr>
      <td colSpan={6} style={{ padding: 0, borderBottom: '1px solid var(--rw-hair)' }}>
        <div
          style={{
            background: 'var(--rw-accent-50)',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--rw-app-text)', fontWeight: 600 }}>
            We will stop sending {name} review requests. Their visit history stays.
          </span>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={onConfirm}>
            {pending ? 'Saving…' : 'Stop sending requests'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
          {error !== null && (
            <span role="alert" style={{ fontSize: 13, color: 'var(--rw-danger)' }}>
              {error}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function DeleteConfirmRow({
  deleting,
  deleteError,
  onConfirmDelete,
  onCancelDelete,
}: {
  deleting: boolean;
  deleteError: string | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  return (
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

/** Module-scope formatter: constructing Intl formatters per render is the
 *  no-locale-format-in-render hotspot. Viewer's locale, UTC calendar date. */
const VISIT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** visit_date arrives as canonical YYYY-MM-DD (UTC date, no time component). */
function formatVisitDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return VISIT_DATE_FORMATTER.format(parsed);
}
