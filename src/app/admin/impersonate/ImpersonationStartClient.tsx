'use client';

import { FormEvent, useReducer } from 'react';
import { useRouter } from 'next/navigation';

interface ImpersonationState {
  accountId: string;
  impersonatedUserId: string;
  ticketId: string;
  reason: string;
  error: string | null;
  submitting: boolean;
}

type ImpersonationAction =
  | { type: 'setAccountId'; value: string }
  | { type: 'setImpersonatedUserId'; value: string }
  | { type: 'setTicketId'; value: string }
  | { type: 'setReason'; value: string }
  | { type: 'submitStart' }
  | { type: 'submitError'; error: string }
  | { type: 'submitDone' };

const initialState: ImpersonationState = {
  accountId: '',
  impersonatedUserId: '',
  ticketId: '',
  reason: '',
  error: null,
  submitting: false,
};

function reducer(state: ImpersonationState, action: ImpersonationAction): ImpersonationState {
  switch (action.type) {
    case 'setAccountId':
      return { ...state, accountId: action.value };
    case 'setImpersonatedUserId':
      return { ...state, impersonatedUserId: action.value };
    case 'setTicketId':
      return { ...state, ticketId: action.value };
    case 'setReason':
      return { ...state, reason: action.value };
    case 'submitStart':
      return { ...state, error: null, submitting: true };
    case 'submitError':
      return { ...state, error: action.error };
    case 'submitDone':
      return { ...state, submitting: false };
  }
}

export function ImpersonationStartClient() {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, initialState);
  const { accountId, impersonatedUserId, ticketId, reason, error, submitting } = state;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: 'submitStart' });

    try {
      const res = await fetch('/api/admin/impersonation/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: accountId.trim(),
          impersonatedUserId: impersonatedUserId.trim(),
          ticketId: ticketId.trim(),
          reason: reason.trim(),
        }),
      });
      const json = await res.json().catch(() => ({})) as {
        viewUrl?: string;
        error?: string;
      };

      if (!res.ok || !json.viewUrl) {
        dispatch({ type: 'submitError', error: json.error ?? `HTTP ${res.status}` });
        return;
      }

      router.push(json.viewUrl);
    } catch (err) {
      console.error('[ImpersonationStartClient] start failed:', err);
      dispatch({ type: 'submitError', error: 'Failed to start impersonation session.' });
    } finally {
      dispatch({ type: 'submitDone' });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="rounded-md border border-blue-200 bg-blue-50 p-4">
        <h2 className="text-sm font-semibold text-blue-900">Read-only admin view</h2>
        <p className="mt-1 text-sm text-blue-800">
          Creates an audited one-hour session for support diagnostics. The owner auth session is not reused.
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Account ID
          <input
            type="text"
            value={accountId}
            onChange={(event) => dispatch({ type: 'setAccountId', value: event.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Owner user ID
          <input
            type="text"
            value={impersonatedUserId}
            onChange={(event) => dispatch({ type: 'setImpersonatedUserId', value: event.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Ticket ID
          <input
            type="text"
            value={ticketId}
            onChange={(event) => dispatch({ type: 'setTicketId', value: event.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(event) => dispatch({ type: 'setReason', value: event.target.value })}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Starting...' : 'Start view-as session'}
        </button>
        {error && <p className="text-sm font-medium text-red-700">{error}</p>}
      </div>
    </form>
  );
}
