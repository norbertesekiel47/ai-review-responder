'use client';

import { useState } from 'react';

const TONE_CLASSES = {
  /** On a light surface — the view page's session card. */
  dark: 'bg-gray-900 text-white hover:bg-gray-800 focus:ring-gray-900 focus:ring-offset-white',
  /** On the red view-as banner. */
  inverse: 'bg-white text-red-800 hover:bg-red-50 focus:ring-white focus:ring-offset-red-700',
} as const;

/**
 * Ends the current view-as session via `/api/admin/impersonation/end`, which
 * clears the signed cookie. Rendered on the view page AND in the shell banner,
 * so it lives with the shell rather than under one route.
 *
 * Successful termination leaves this app with a full document navigation to
 * the trusted server-provided Admin app home. The endpoint still clears the
 * same signed cookie; no session or termination behavior changes.
 */
export function EndImpersonationButton({
  tone = 'dark',
  compact = false,
  adminAppUrl,
}: {
  tone?: keyof typeof TONE_CLASSES;
  compact?: boolean;
  adminAppUrl: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function endSession() {
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/admin/impersonation/end', {
        method: 'POST',
      });
      const json = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      window.location.assign(adminAppUrl);
    } catch (err) {
      console.error('[EndImpersonationButton] end failed:', err);
      setError('Failed to end impersonation session.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => { void endSession(); }}
        disabled={submitting}
        className={`rounded-md font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
          compact ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm'
        } ${TONE_CLASSES[tone]}`}
      >
        {submitting ? 'Ending...' : 'End session'}
      </button>
      {error && (
        <p className={`text-sm font-medium ${tone === 'inverse' ? 'text-white' : 'text-red-700'}`}>
          {error}
        </p>
      )}
    </div>
  );
}
