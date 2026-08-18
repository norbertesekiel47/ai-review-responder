'use client';

// The admin arm of the Halt latch, on /admin/businesses/[id] (#865, plan §3.4).
// Modelled on PastDueExtensionPanel: useReducer, one form submit, an onChanged
// callback so the page re-reads rather than this panel guessing the new state.
//
// COPY DISCIPLINE (CONTEXT.md **Halt latch**). "stop" is the ONE carved-out
// owner-facing synonym for `halt`; `pause`, `resume` and `cancel batch` are
// banned everywhere INCLUDING copy, because each implies a reversibility the
// latch does not have. Code-level names stay on the term — the mode member
// below is `haltable`, not `stoppable`.
//
// The three counts are rendered SEPARATELY and never summed. A stop cancels the
// `rendered` and `queued` rows and does NOT recall a row already `sending`; a
// single folded "live outreach" number (plan round 1, finding 8) would have
// presented the in-flight row as part of the stop's reach, which is the one
// thing the latch deliberately cannot do.

import { FormEvent, ReactNode, useReducer } from 'react';
import { formatAdminDateTime } from '@/components/admin/ui/format';
import type { AdminBatchSummary, HaltReason } from '@/lib/solicitation/batch-view';

interface SolicitationBatchPanelProps {
  accountId: string;
  businessId: string;
  /** `null` when the location has never built a batch. */
  summary: AdminBatchSummary | null;
  /** Fired after any 2xx — the panel's data is stale either way. */
  onHalted: () => void;
}

/**
 * Exhaustive over the read side's five reasons, so a reason added to
 * `HaltReason` is a compile error here rather than a blank cell. Three of the
 * five are not owner-caused, which is why none of these say "you".
 */
const HALT_REASON_LABELS: Record<HaltReason, string> = {
  owner_veto: 'Owner stopped it inside the veto window',
  owner_halt: 'Owner stopped it',
  admin_halt: 'RepWorth support stopped it',
  send_window_elapsed: 'Send window elapsed',
  batch_expired: 'Approval window expired',
};

/**
 * The states `adminHaltBatch` refuses, mirrored so the panel never offers a
 * control whose only outcome is a 409.
 *
 * `pending` is D11 and is the non-obvious member: latching an unbuilt batch
 * satisfies migration 091's halt-consistency CHECK through its
 * `built_at IS NULL` arm, and then collides with the builder's later
 * `built_at` stamp. `halted` and `closed` are the ordinary terminal pair.
 */
const NON_ACTIONABLE_COPY: Partial<Record<AdminBatchSummary['batchState'], string>> = {
  pending: 'This batch is still building. The stop control appears once it is built.',
  halted: 'This batch is already stopped. There is no way back — reaching these contacts again means building a new batch.',
  closed: 'This batch is closed. Every message in it has settled.',
};

interface HaltState {
  note: string;
  message: string | null;
  error: string | null;
  submitting: boolean;
}

type HaltAction =
  | { type: 'setNote'; value: string }
  | { type: 'submitReset' }
  | { type: 'validationError'; error: string }
  | { type: 'submitStart' }
  | { type: 'submitError'; error: string }
  | { type: 'submitSuccess'; message: string }
  | { type: 'submitDone' };

const initialState: HaltState = {
  note: '',
  message: null,
  error: null,
  submitting: false,
};

function reducer(state: HaltState, action: HaltAction): HaltState {
  switch (action.type) {
    case 'setNote':
      return { ...state, note: action.value };
    case 'submitReset':
      return { ...state, message: null, error: null };
    case 'validationError':
      return { ...state, error: action.error };
    case 'submitStart':
      return { ...state, submitting: true };
    case 'submitError':
      return { ...state, error: action.error };
    case 'submitSuccess':
      return { ...state, message: action.message, note: '' };
    case 'submitDone':
      return { ...state, submitting: false };
  }
}

/** Exactly the route's `strictObject`. A fifth field is a 400, and no field of
 *  it may name the halt reason — that is fixed by the route's identity. */
interface AdminHaltRequest {
  accountId: string;
  businessId: string;
  batchId: string;
  note: string;
}

/** The route's `toWire` projection, narrowed to what this panel reads. */
interface AdminHaltResponse {
  status?: string;
  cancelledCount?: number;
  error?: string;
}

export function SolicitationBatchPanel({
  accountId,
  businessId,
  summary,
  onHalted,
}: SolicitationBatchPanelProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { note, message, error, submitting } = state;

  if (!summary) {
    return (
      <PanelShell>
        <p className="mt-1 text-sm text-gray-700">
          No send batch on file for this location.
        </p>
      </PanelShell>
    );
  }

  // `haltable`, not `stoppable`: the copy carve-out is one word wide and does
  // not reach identifiers (CONTEXT.md **Halt latch**).
  const whyNotHaltable = NON_ACTIONABLE_COPY[summary.batchState] ?? null;
  const haltable = whyNotHaltable === null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: 'submitReset' });

    const trimmed = note.trim();
    if (trimmed.length === 0) {
      dispatch({ type: 'validationError', error: 'Say why you are stopping this batch.' });
      return;
    }
    // Unreachable — the form only renders for a haltable batch — but the body
    // needs a batch id and narrowing it here beats a non-null assertion.
    if (!summary) return;

    const body: AdminHaltRequest = {
      accountId,
      businessId,
      batchId: summary.batchId,
      note: trimmed,
    };

    dispatch({ type: 'submitStart' });
    try {
      const res = await fetch('/api/admin/solicitation/batch/halt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as AdminHaltResponse;

      if (!res.ok) {
        dispatch({ type: 'submitError', error: json.error ?? json.status ?? `HTTP ${res.status}` });
        return;
      }

      dispatch({
        type: 'submitSuccess',
        message:
          json.status === 'already_halted'
            ? 'This batch was already stopped; nothing changed.'
            : `Batch stopped. ${json.cancelledCount ?? 0} queued message(s) cancelled.`,
      });
      onHalted();
    } catch (err) {
      console.error('[SolicitationBatchPanel] halt failed:', err);
      dispatch({ type: 'submitError', error: 'Failed to stop the batch.' });
    } finally {
      dispatch({ type: 'submitDone' });
    }
  }

  return (
    <PanelShell>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1">
          <dt className="text-gray-500">State</dt>
          <dd className="font-medium text-gray-900">
            {summary.batchState.replace(/_/g, ' ')}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-gray-500">Built</dt>
          <dd className="text-gray-900">{formatAdminDateTime(summary.builtAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-gray-500">Approved</dt>
          <dd className="text-gray-900">{formatAdminDateTime(summary.approvedAt)}</dd>
        </div>
        {summary.haltedAt && (
          <div className="flex gap-1">
            <dt className="text-gray-500">Stopped</dt>
            <dd className="text-gray-900">
              {formatAdminDateTime(summary.haltedAt)}
              {summary.haltReason && ` — ${HALT_REASON_LABELS[summary.haltReason]}`}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <CountTile
          testId="admin-batch-cancellable-count"
          label="A stop cancels"
          value={summary.cancellableCount}
          hint="Rendered and queued messages."
        />
        <CountTile
          testId="admin-batch-sending-count"
          label="In flight"
          value={summary.sendingCount}
          hint="Already handed to the provider. A stop does not reach these."
        />
        <CountTile
          testId="admin-batch-sent-count"
          label="Delivered"
          value={summary.sentCount}
          hint="Already sent. Nothing can take these back."
        />
      </div>

      {!haltable ? (
        <p className="mt-4 text-sm text-gray-700">{whyNotHaltable}</p>
      ) : (
        <>
          <p className="mt-4 text-sm text-gray-700">
            Stopping ends this batch permanently — there is no way back, and reaching
            these contacts again means building a new batch. It cancels the{' '}
            {summary.cancellableCount} rendered and queued message(s) only; the{' '}
            {summary.sendingCount} already in flight will still arrive, and the{' '}
            {summary.sentCount} already delivered are untouched.
          </p>
          <form
            onSubmit={handleSubmit}
            className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
          >
            <label className="grid gap-1 text-sm font-medium text-gray-700">
              Note (why support is stopping this batch)
              <input
                type="text"
                value={note}
                onChange={(event) => dispatch({ type: 'setNote', value: event.target.value })}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
                required
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Stopping…' : 'Stop this batch'}
            </button>
          </form>
        </>
      )}

      {message && <p className="mt-3 text-sm font-medium text-emerald-700">{message}</p>}
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </PanelShell>
  );
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-900">Send batch</h2>
      <p className="mt-1 text-sm text-gray-500">
        The most recent solicitation send batch for this location. Requires AAL2 and
        writes an account audit log entry.
      </p>
      {children}
    </section>
  );
}

/** The count and nothing else inside the test-id element — the panel must never
 *  be readable as "2 + 1 = 3 messages a stop reaches". */
function CountTile({
  testId,
  label,
  value,
  hint,
}: {
  testId: string;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div
        data-testid={testId}
        className="mt-1 text-xl font-semibold tabular-nums text-gray-900"
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-gray-500">{hint}</div>
    </div>
  );
}
