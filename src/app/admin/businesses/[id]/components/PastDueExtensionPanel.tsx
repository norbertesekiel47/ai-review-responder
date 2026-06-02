'use client';

import { FormEvent, useState } from 'react';

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

export function PastDueExtensionPanel({
  accountId,
  subscriptionStatus,
  onGranted,
}: PastDueExtensionPanelProps) {
  const [days, setDays] = useState('3');
  const [ticketId, setTicketId] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (subscriptionStatus !== 'past_due') {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    const parsedDays = Number(days);
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 7) {
      setError('Use 1 to 7 days.');
      return;
    }

    setSubmitting(true);
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
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }

      const expiresAt = json.extension?.expires_at;
      const formatted = expiresAt
        ? EXTENSION_DEADLINE_FORMATTER.format(new Date(expiresAt))
        : 'the updated deadline';
      setMessage(`Extension granted until ${formatted}.`);
      setTicketId('');
      setReason('');
      onGranted();
    } catch (err) {
      console.error('[PastDueExtensionPanel] grant extension failed:', err);
      setError('Failed to grant extension.');
    } finally {
      setSubmitting(false);
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
            onChange={(event) => setDays(event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Ticket ID
          <input
            type="text"
            value={ticketId}
            onChange={(event) => setTicketId(event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
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
