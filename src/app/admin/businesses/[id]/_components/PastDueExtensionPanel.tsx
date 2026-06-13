'use client';

import { FormEvent, useReducer } from 'react';

interface PastDueExtensionPanelProps {
  accountId: string;
  subscriptionStatus: string;
  onGranted: () => void;
}

const EXTENSION_DEADLINE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

interface ExtensionState {
  days: string;
  ticketId: string;
  reason: string;
  message: string | null;
  error: string | null;
  submitting: boolean;
}

type ExtensionAction =
  | { type: 'setDays'; value: string }
  | { type: 'setTicketId'; value: string }
  | { type: 'setReason'; value: string }
  | { type: 'submitReset' }
  | { type: 'validationError'; error: string }
  | { type: 'submitStart' }
  | { type: 'submitError'; error: string }
  | { type: 'submitSuccess'; message: string }
  | { type: 'submitDone' };

const initialState: ExtensionState = {
  days: '3',
  ticketId: '',
  reason: '',
  message: null,
  error: null,
  submitting: false,
};

function reducer(state: ExtensionState, action: ExtensionAction): ExtensionState {
  switch (action.type) {
    case 'setDays':
      return { ...state, days: action.value };
    case 'setTicketId':
      return { ...state, ticketId: action.value };
    case 'setReason':
      return { ...state, reason: action.value };
    case 'submitReset':
      return { ...state, message: null, error: null };
    case 'validationError':
      return { ...state, error: action.error };
    case 'submitStart':
      return { ...state, submitting: true };
    case 'submitError':
      return { ...state, error: action.error };
    case 'submitSuccess':
      return { ...state, message: action.message, ticketId: '', reason: '' };
    case 'submitDone':
      return { ...state, submitting: false };
  }
}

export function PastDueExtensionPanel({
  accountId,
  subscriptionStatus,
  onGranted,
}: PastDueExtensionPanelProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { days, ticketId, reason, message, error, submitting } = state;

  if (subscriptionStatus !== 'past_due') {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: 'submitReset' });

    const parsedDays = Number(days);
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 7) {
      dispatch({ type: 'validationError', error: 'Use 1 to 7 days.' });
      return;
    }

    dispatch({ type: 'submitStart' });
    try {
      const res = await fetch('/api/admin/billing/grant-extension', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          days: parsedDays,
          ticketId: ticketId.trim(),
          reason: reason.trim(),
        }),
      });
      const json = await res.json().catch(() => ({})) as {
        extension?: { expires_at?: string };
        error?: string;
      };

      if (!res.ok) {
        dispatch({ type: 'submitError', error: json.error ?? `HTTP ${res.status}` });
        return;
      }

      const expiresAt = json.extension?.expires_at;
      const formatted = expiresAt
        ? EXTENSION_DEADLINE_FORMATTER.format(new Date(expiresAt))
        : 'the updated deadline';
      dispatch({ type: 'submitSuccess', message: `Extension granted until ${formatted}.` });
      onGranted();
    } catch (err) {
      console.error('[PastDueExtensionPanel] grant extension failed:', err);
      dispatch({ type: 'submitError', error: 'Failed to grant extension.' });
    } finally {
      dispatch({ type: 'submitDone' });
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
      <div>
        <div>
          <h2 className="text-sm font-semibold text-blue-900">Grant past-due extension</h2>
          <p className="mt-1 text-sm text-blue-800">
            Requires AAL2 and writes an account audit log entry.
          </p>
          <p className="mt-1 text-sm text-blue-800">
            Days are added <strong>on top of</strong> any grace the account still
            has — for an account early in its window a full 7-day grant can extend
            total access up to ~14 days from when it went past due. The exact new
            deadline is shown below after you grant.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-4 grid gap-3 sm:grid-cols-[100px_140px_1fr_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Days
          <input
            type="number"
            min={1}
            max={7}
            value={days}
            onChange={(event) => dispatch({ type: 'setDays', value: event.target.value })}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Ticket ID
          <input
            type="text"
            value={ticketId}
            onChange={(event) => dispatch({ type: 'setTicketId', value: event.target.value })}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(event) => dispatch({ type: 'setReason', value: event.target.value })}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Granting...' : 'Grant extension'}
        </button>
      </form>

      {message && <p className="mt-3 text-sm font-medium text-emerald-700">{message}</p>}
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}
