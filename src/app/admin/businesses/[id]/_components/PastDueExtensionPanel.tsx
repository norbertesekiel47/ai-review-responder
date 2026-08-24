'use client';

import { FormEvent } from 'react';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { ADMIN_TIME_ZONE_LABEL, formatAdminDate } from '@/components/admin/ui/format';
import { useAdminActionForm } from '@/hooks/useAdminActionForm';

interface PastDueExtensionPanelProps {
  accountId: string;
  subscriptionStatus: string;
  onGranted: () => void;
}


interface ExtensionFields {
  days: string;
  ticketId: string;
  reason: string;
}

export function PastDueExtensionPanel({
  accountId,
  subscriptionStatus,
  onGranted,
}: PastDueExtensionPanelProps) {
  // The success carries a formatted deadline, so `TOutcome` is `string`.
  const form = useAdminActionForm<ExtensionFields, string>({
    days: '3',
    ticketId: '',
    reason: '',
  });
  const { days, ticketId, reason } = form.fields;
  const { error, outcome: message, busy: submitting } = form;

  if (subscriptionStatus !== SubscriptionStatus.PAST_DUE) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Cleared BEFORE validating, exactly as `submitReset` was: a refusal must be
    // visible while the button still reads "Grant extension".
    form.clearOutcome();

    const parsedDays = Number(days);
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 7) {
      form.fail('Use 1 to 7 days.');
      return;
    }

    await form.run(async () => {
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
          form.fail(json.error ?? `HTTP ${res.status}`);
          return;
        }

        const expiresAt = json.extension?.expires_at;
        const formatted = expiresAt
          ? `${formatAdminDate(expiresAt)} ${ADMIN_TIME_ZONE_LABEL}`
          : 'the updated deadline';
        form.succeed(`Extension granted until ${formatted}.`);
        form.patch({ ticketId: '', reason: '' });
        onGranted();
      } catch (err) {
        console.error('[PastDueExtensionPanel] grant extension failed:', err);
        form.fail('Failed to grant extension.');
      }
    });
  }

  return (
    <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Grant past-due extension</h2>
          <p className="mt-1 text-sm text-gray-700">
            Requires AAL2 and writes an account audit log entry.
          </p>
          <p className="mt-1 text-sm text-gray-700">
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
            onChange={(event) => form.set('days', event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Ticket ID
          <input
            type="text"
            value={ticketId}
            onChange={(event) => form.set('ticketId', event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            required
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-gray-700">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(event) => form.set('reason', event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            required
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Granting...' : 'Grant extension'}
        </button>
      </form>

      {message && <p className="mt-3 text-sm font-medium text-emerald-700">{message}</p>}
      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}
