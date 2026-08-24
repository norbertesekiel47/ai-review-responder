'use client';

import { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminActionForm } from '@/hooks/useAdminActionForm';

interface ImpersonationFields {
  accountId: string;
  impersonatedUserId: string;
  ticketId: string;
  reason: string;
}

export function ImpersonationStartClient() {
  const router = useRouter();
  // No success channel, and the default `TOutcome = never` says so in the type
  // rather than in a comment: this form navigates away on success, so there is
  // nothing for it to announce and `succeed` is uncallable.
  const form = useAdminActionForm<ImpersonationFields>({
    accountId: '',
    impersonatedUserId: '',
    ticketId: '',
    reason: '',
  });
  const { accountId, impersonatedUserId, ticketId, reason } = form.fields;
  const { error, busy: submitting } = form;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await form.run(async () => {
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
          form.fail(json.error ?? `HTTP ${res.status}`);
          return;
        }

        router.push(json.viewUrl);
      } catch (err) {
        console.error('[ImpersonationStartClient] start failed:', err);
        form.fail('Failed to start impersonation session.');
      }
    });
  }

  return (
    // `max-w-2xl` is a form-legibility measure, not the deleted page shell:
    // AdminPage owns the max-w-7xl page measure (CF-5 — form pages max-w-2xl).
    <form onSubmit={handleSubmit} className="max-w-2xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
        <h2 className="text-sm font-semibold text-gray-900">Read-only admin view</h2>
        <p className="mt-1 text-sm text-gray-600">
          Creates an audited one-hour session for support diagnostics. The owner auth session is not reused.
        </p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Account ID
          <input
            type="text"
            value={accountId}
            onChange={(event) => form.set('accountId', event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Owner user ID
          <input
            type="text"
            value={impersonatedUserId}
            onChange={(event) => form.set('impersonatedUserId', event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Ticket ID
          <input
            type="text"
            value={ticketId}
            onChange={(event) => form.set('ticketId', event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(event) => form.set('reason', event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            required
          />
        </label>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Starting...' : 'Start view-as session'}
        </button>
        {error && <p className="text-sm font-medium text-red-700">{error}</p>}
      </div>
    </form>
  );
}
