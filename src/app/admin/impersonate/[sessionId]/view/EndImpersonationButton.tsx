'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function EndImpersonationButton() {
  const router = useRouter();
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
      router.push('/admin/overview');
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
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? 'Ending...' : 'End session'}
      </button>
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
