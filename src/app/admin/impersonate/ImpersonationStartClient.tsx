'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export function ImpersonationStartClient() {
  const router = useRouter();
  const [accountId, setAccountId] = useState('');
  const [impersonatedUserId, setImpersonatedUserId] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

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
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }

      router.push(json.viewUrl);
    } catch (err) {
      console.error('[ImpersonationStartClient] start failed:', err);
      setError('Failed to start impersonation session.');
    } finally {
      setSubmitting(false);
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
            onChange={(event) => setAccountId(event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Owner user ID
          <input
            type="text"
            value={impersonatedUserId}
            onChange={(event) => setImpersonatedUserId(event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Ticket ID
          <input
            type="text"
            value={ticketId}
            onChange={(event) => setTicketId(event.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
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
