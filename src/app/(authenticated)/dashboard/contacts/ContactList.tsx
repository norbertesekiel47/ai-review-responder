'use client';

import { useEffect, useState } from 'react';
import { useLocationScope } from '@/contexts/LocationContext';
import type { ContactListItem } from '@/lib/solicitation/contacts-repo';

/**
 * Contact-list lane of /dashboard/contacts (#541): paginated tenant-scoped
 * list, confirm-step hard delete. Split from ContactsClient so each concern
 * stays independently scannable; `epoch` (bumped by the parent when an ingest
 * completes) and `onRefresh` (bumps the same counter after a delete or a
 * retry) are the only integration points with the upload lane.
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
  onRefresh,
  onPage,
}: {
  list: ListResult | null;
  offset: number;
  deletion: ContactDeletion;
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
      <ContactTable contacts={list.data.contacts} deletion={deletion} />
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
      `/api/dashboard/contacts?scope=${scope}&limit=${PAGE_LIMIT}&offset=${offset}`,
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
      `/api/dashboard/contacts/${contactId}?scope=${scope}`,
      { method: 'DELETE' },
    );
    if (res.status === 204) return null;
    const body: { error?: string } = await res.json().catch(() => ({}));
    return body.error ?? `Delete failed (${res.status}).`;
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
}: {
  contacts: ContactListItem[];
  deletion: ContactDeletion;
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
              confirming={deletion.confirmingId === contact.id}
              deleting={deletion.deletingId === contact.id}
              deleteError={deletion.confirmingId === contact.id ? deletion.deleteError : null}
              onRequestDelete={() => deletion.requestDelete(contact.id)}
              onCancelDelete={deletion.cancelDelete}
              onConfirmDelete={() => deletion.confirmDelete(contact.id)}
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
        <DeleteConfirmRow
          deleting={deleting}
          deleteError={deleteError}
          onConfirmDelete={onConfirmDelete}
          onCancelDelete={onCancelDelete}
        />
      )}
    </>
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
