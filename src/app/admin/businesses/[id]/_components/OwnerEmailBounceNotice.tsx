'use client';

import { useState } from 'react';
import type { BounceFlagState } from '../_hooks/useBusinessDetail';

interface OwnerEmailBounceNoticeProps {
  ownerEmail: string | null;
  state: BounceFlagState;
  /** Performs the PATCH; the confirm step is owned here. */
  onClear: () => void;
}

/**
 * The bouncing-owner-email notice and its clear action (X3).
 *
 * Clearing the flag re-enables EVERY owner email for the address, so the act
 * gets the same shape as the other admin writes on this page
 * (`PastDueExtensionPanel`, `SolicitationBatchPanel`): the consequence stated
 * inline, a required one-line reason as the deliberate-action gate, and the
 * outcome rendered where the button is — never `confirm()`/`alert()`, which
 * block the whole tab and leave no trace on screen.
 *
 * The reason is a client-side gate only. The PATCH contract is
 * `{ownerEmailBounced: false}` and has no note field; do not send the reason
 * into a schema that strips it — wire it through when the route records one.
 */
export function OwnerEmailBounceNotice({ ownerEmail, state, onClear }: OwnerEmailBounceNoticeProps) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState('');
  const reasonMissing = reason.trim().length === 0;

  function disarm() {
    setArmed(false);
    setReason('');
  }

  return (
    <section
      aria-labelledby="owner-email-bounce-title"
      className="mt-4 mb-4 rounded-lg border border-red-300 bg-red-50 p-4"
    >
      <p id="owner-email-bounce-title" className="text-sm font-semibold text-red-800">
        ⚠ Owner email is bouncing
      </p>
      <p className="mt-1 text-sm text-red-700">
        Approval emails, weekly reports, monthly impact, drip emails, and owner nudges are skipped
        for <code className="rounded bg-red-100 px-1">{ownerEmail ?? 'this owner'}</code>.
        Partner/admin alerts still send.
      </p>
      <p className="mt-2 text-sm text-red-700">
        Verify the email address with the owner. If it changed, update it in the Business Profile
        section below (Edit → Owner Email), then clear the flag. See{' '}
        <code>docs/email-deliverability.md</code> for the full runbook.
      </p>

      {armed ? (
        <div className="mt-3 rounded-md border border-red-300 bg-white p-3">
          <p className="text-sm text-gray-800">
            Clearing the flag resumes every owner email to{' '}
            <span className="font-medium">{ownerEmail ?? 'this address'}</span> from the next send.
            If the address is still bad, each send bounces again and the flag comes back.
          </p>
          <label htmlFor="owner-email-bounce-reason" className="mt-3 block text-sm font-medium text-gray-700">
            How was the address verified? (one line, required)
            <input
              id="owner-email-bounce-reason"
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              autoFocus
              required
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onClear}
              disabled={reasonMissing || state.submitting}
              className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.submitting ? 'Clearing…' : 'Clear flag and resume owner email'}
            </button>
            <button
              type="button"
              onClick={disarm}
              disabled={state.submitting}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {state.error && (
            <p role="alert" className="mt-3 text-sm font-medium text-red-700">
              {state.error}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Clear bounce flag…
        </button>
      )}
    </section>
  );
}
