'use client';

import { useEffect, useState } from 'react';
import { useLocationScope } from '@/contexts/LocationContext';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { ContactListItem } from '@/lib/solicitation/contacts-repo';
import './contacts.css';

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
 * handle. They share the confirm-step MACHINE (`useRowConfirmAction`) and the
 * confirm-row CHROME (`RowConfirmBanner`), because those are genuinely the same
 * interaction — but their URL builders stay deliberately separate functions, so
 * a copy-paste cannot silently swap one endpoint for the other. What the shared
 * pieces carry is exactly what must differ: the copy and the wash.
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
  // Two controllers, one machine. Neither knows about the other, so a row can
  // never confirm a delete and a suppression change with a single click.
  const deletion = useRowConfirmAction<DeleteAction>(
    currentScope !== 'all',
    (contactId) => requestContactDelete(contactId, currentScope),
    onRefresh,
  );
  const suppression = useRowConfirmAction<SuppressionAction>(
    currentScope !== 'all',
    (contactId, action) =>
      requestSuppressionChange(contactId, currentScope, SUPPRESSION_METHOD[action]),
    onRefresh,
  );

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
  deletion: RowConfirmController<DeleteAction>;
  suppression: RowConfirmController<SuppressionAction>;
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

// ── The confirm-step machine both row mutations ride ─────────────────────────

/** The delete flow's single direction. Spelled as a one-member union rather
 *  than collapsed away, so both call sites read the same and the row is always
 *  asked WHICH mutation it is confirming. */
type DeleteAction = 'delete';

/** The two do-not-contact directions, never collapsed to a boolean: every place
 *  that branches on direction has to name which one it means. */
type SuppressionAction = 'mark' | 'clear';

const SUPPRESSION_METHOD = { mark: 'POST', clear: 'DELETE' } as const;

interface RowConfirmController<TAction extends string> {
  /** The one open confirm step: which row, and which direction. */
  open: { rowId: string; action: TAction } | null;
  /** Row with a mutation in flight. */
  pendingId: string | null;
  /** The row a failure belongs to, and its copy — never a page-level banner, so
   *  an error can never read as if it applied to a different contact. */
  errorId: string | null;
  error: string | null;
  /** Opens the confirm step for one row in one direction. */
  request: (rowId: string, action: TAction) => void;
  cancel: () => void;
  /** Sends exactly the mutation the OPEN confirm step describes — it takes no
   *  arguments, so a confirm can never fire against a row or a direction other
   *  than the one the owner is looking at. */
  confirm: () => void;
}

/**
 * Both row mutations ride a confirm step (D-A8) with the same state machine:
 * open on one row in one direction, send, keep the step open on failure. The
 * guard matters most on the §7.6 clearing side — it resumes review requests to
 * a contact the owner deliberately marked and leaves no visible trace
 * afterwards — but the machine itself is direction-agnostic.
 *
 * A FAILED mutation deliberately does not call `onSuccess`. Bumping the epoch
 * would refetch a page the server never changed and re-render the row as
 * though the change landed — the owner would believe a contact was suppressed
 * when they are still mailable, which is the inverse of the hazard this whole
 * surface exists to prevent.
 *
 * `send` is the ONLY thing the two callers vary at the network boundary, and it
 * is supplied per-controller precisely so the delete URL and the suppression
 * URL are built by two different functions that never meet.
 */
function useRowConfirmAction<TAction extends string>(
  enabled: boolean,
  send: (rowId: string, action: TAction) => Promise<string | null>,
  onSuccess: () => void,
): RowConfirmController<TAction> {
  const [open, setOpen] = useState<{ rowId: string; action: TAction } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);

  async function mutate(rowId: string, action: TAction) {
    if (!enabled) return;
    setPendingId(rowId);
    setFailure(null);
    const error = await send(rowId, action);
    if (error === null) {
      setOpen(null);
      onSuccess();
    } else {
      setFailure({ id: rowId, message: error });
    }
    setPendingId(null);
  }

  return {
    open,
    pendingId,
    errorId: failure?.id ?? null,
    error: failure?.message ?? null,
    request: (rowId, action) => {
      setOpen({ rowId, action });
      setFailure(null);
    },
    cancel: () => {
      setOpen(null);
      setFailure(null);
    },
    confirm: () => {
      if (open === null) return;
      void mutate(open.rowId, open.action);
    },
  };
}

/** Maps a mutation response onto null (success) or the error copy to show.
 *  Shared because reading `{ error }` off a failed body is not where the two
 *  mutations differ; the URL each one calls is, and that stays split below. */
async function mutationErrorCopy(
  res: Response,
  fallback: (status: number) => string,
): Promise<string | null> {
  if (res.ok) return null;
  const body: { error?: string } = await res.json().catch(() => ({}));
  return body.error ?? fallback(res.status);
}

/** The ONLY caller of the contact endpoint, which erases a customer record and
 *  their visit history. Returns null on success or the error copy to show. */
async function requestContactDelete(contactId: string, scope: string): Promise<string | null> {
  try {
    const res = await fetch(
      withSolicitationScope(`/api/dashboard/contacts/${contactId}`, scope),
      { method: 'DELETE' },
    );
    return await mutationErrorCopy(res, (status) => `Delete failed (${status}).`);
  } catch {
    return 'Could not reach the server. Try again.';
  }
}

/**
 * The ONLY caller of the suppression endpoint. `/contacts/<id>/suppression`
 * changes whether we may mail a handle; the sibling `/contacts/<id>` erases the
 * customer record. Keeping the two URL builders apart is what stops a
 * do-not-contact control ever hard-deleting somebody's history — it is the one
 * thing the shared confirm machine above deliberately does not absorb.
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
    return await mutationErrorCopy(
      res,
      (status) => `Could not update this contact (${status}).`,
    );
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
  deletion: RowConfirmController<DeleteAction>;
  suppression: RowConfirmController<SuppressionAction>;
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
  deletion: RowConfirmController<DeleteAction>;
  suppression: RowConfirmController<SuppressionAction>;
}) {
  const confirmingDelete = deletion.open !== null && deletion.open.rowId === contact.id;
  const openConfirm =
    suppression.open !== null && suppression.open.rowId === contact.id
      ? suppression.open.action
      : null;
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
            {openConfirm === null && (
              <SuppressionControl contact={contact} suppression={suppression} />
            )}
            {!confirmingDelete && (
              <button
                type="button"
                className="btn btn-tertiary"
                onClick={() => deletion.request(contact.id, 'delete')}
                aria-label={`Delete ${contact.name}`}
              >
                Delete
              </button>
            )}
          </div>
          {/* While the confirm step is open its own row owns the error, so it
              is never shown twice. */}
          {suppressionError !== null && openConfirm === null && (
            <p
              role="alert"
              style={{ fontSize: 12, color: 'var(--rw-danger)', margin: '6px 0 0' }}
            >
              {suppressionError}
            </p>
          )}
        </td>
      </tr>
      {openConfirm !== null && (
        <RowConfirmBanner
          // Accent, not danger: a do-not-contact change in either direction
          // destroys nothing — it only changes whether we may mail a handle.
          tone="accent"
          message={SUPPRESSION_CONFIRM_COPY[openConfirm].prompt(contact.name)}
          actionLabel={SUPPRESSION_CONFIRM_COPY[openConfirm].action}
          pendingLabel="Saving…"
          pending={suppression.pendingId === contact.id}
          error={suppressionError}
          onConfirm={suppression.confirm}
          onCancel={suppression.cancel}
        />
      )}
      {confirmingDelete && (
        <RowConfirmBanner
          tone="danger"
          message="Hard delete — removes this person and all their visits permanently."
          actionLabel="Delete permanently"
          pendingLabel="Deleting…"
          pending={deletion.pendingId === contact.id}
          error={deletion.errorId === contact.id ? deletion.error : null}
          onConfirm={deletion.confirm}
          onCancel={deletion.cancel}
        />
      )}
    </>
  );
}

/** §7.4 state → its Console badge variant, keyed on the display seam's closed
 *  scope enum. The washes themselves live in `contacts.css` beside the rest of
 *  the design system, not in an inline style object here. */
const SUPPRESSION_BADGE_CLASS: Record<
  NonNullable<ContactListItem['suppression']>['state'],
  string
> = {
  global: 'badge suppression-badge suppression-badge--global',
  account: 'badge suppression-badge suppression-badge--account',
};

function SuppressionBadge({
  display,
}: {
  display: NonNullable<ContactListItem['suppression']>;
}) {
  return (
    <span
      className={SUPPRESSION_BADGE_CLASS[display.state]}
      // `detail` is the seam's own copy; it carries no account name and no
      // source, so a tooltip cannot leak provenance (§7.4, invariant #8).
      title={display.detail}
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
  suppression: RowConfirmController<SuppressionAction>;
}) {
  const pending = suppression.pendingId === contact.id;

  if (contact.suppression === null) {
    return (
      <button
        type="button"
        className="btn btn-tertiary"
        disabled={pending}
        onClick={() => suppression.request(contact.id, 'mark')}
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
      onClick={() => suppression.request(contact.id, 'clear')}
      aria-label={`Allow requests again for ${contact.name}`}
    >
      Allow requests again
    </button>
  );
}

/**
 * The two confirm steps, and they deliberately do not read the same (D-A8).
 * Now that both directions render through the shared `RowConfirmBanner`, THIS
 * table is the whole of the distinction — the chrome is common, the words are
 * not, and that is the correct split.
 *
 * §7.6 requires the two controls not be presented as the same thing, so two
 * identical dialogs differing only in a verb would themselves be the defect —
 * each names what actually changes: marking says what STOPS, clearing says what
 * RESUMES. Clearing is the consequential direction, which is why it is guarded
 * at all: it restarts review requests to somebody the owner deliberately
 * marked, and leaves nothing behind to notice afterwards.
 */
const SUPPRESSION_CONFIRM_COPY = {
  mark: {
    prompt: (name: string) =>
      `We will stop sending ${name} review requests. Their visit history stays.`,
    action: 'Stop sending requests',
  },
  clear: {
    prompt: (name: string) => `We will start including ${name} in review requests again.`,
    action: 'Start sending requests',
  },
} as const satisfies Record<
  SuppressionAction,
  { prompt: (name: string) => string; action: string }
>;

/**
 * The two washes, and the distinction is the point. `danger` belongs to the
 * hard delete, which is the only irreversible act on this surface; `accent`
 * belongs to a do-not-contact change, which destroys nothing. Collapsing the
 * chrome into one component is safe precisely because the tone stays an
 * explicit per-call-site choice rather than something inferred from the row.
 */
type RowConfirmTone = 'danger' | 'accent';

const ROW_CONFIRM_TONE: Record<
  RowConfirmTone,
  {
    wash: string;
    messageColor: string;
    confirmClassName: string;
    confirmStyle?: React.CSSProperties;
  }
> = {
  danger: {
    wash: 'var(--rw-danger-soft)',
    messageColor: 'var(--rw-danger)',
    confirmClassName: 'btn',
    confirmStyle: { background: 'var(--rw-danger)', color: 'var(--rw-on-accent)' },
  },
  accent: {
    wash: 'var(--rw-accent-50)',
    messageColor: 'var(--rw-app-text)',
    confirmClassName: 'btn btn-primary',
  },
};

/**
 * The in-table confirm step, shared by both row mutations: it spans the whole
 * row, states what is about to happen, and offers exactly one confirm and one
 * cancel. Every word of the prompt and both button labels arrive as props —
 * §7.6 requires the marking and clearing controls not read as the same thing,
 * and the delete confirm must not read like either, so this component owns the
 * anatomy and none of the copy.
 */
function RowConfirmBanner({
  tone,
  message,
  actionLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  tone: RowConfirmTone;
  message: string;
  actionLabel: string;
  pendingLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const palette = ROW_CONFIRM_TONE[tone];
  return (
    <tr>
      <td
        colSpan={TABLE_HEADERS.length}
        style={{ padding: 0, borderBottom: '1px solid var(--rw-hair)' }}
      >
        <div
          style={{
            background: palette.wash,
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, color: palette.messageColor, fontWeight: 600 }}>
            {message}
          </span>
          <button
            type="button"
            className={palette.confirmClassName}
            style={palette.confirmStyle}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? pendingLabel : actionLabel}
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
