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

  // ── Contact list fetch ────────────────────────────────────────────────────

  const listKey = `${currentScope}:${offset}:${epoch}`;
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
        onRefresh();
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
            onClick={onRefresh}
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
