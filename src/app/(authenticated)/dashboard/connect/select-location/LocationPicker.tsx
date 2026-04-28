'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ZernioLocationOption } from '@/lib/zernio/types';

interface Props {
  locations: ZernioLocationOption[];
}

/**
 * Client form for picking the Google Business location to bind to the active
 * Zernio connect session. POSTs to /api/zernio/connect/select-location which
 * runs the full finalize choreography (CSRF / auth / Redis CAS / Zernio call /
 * DB insert). Friendly messages map known error codes; everything else falls
 * back to a generic display.
 */
export function LocationPicker({ locations }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/zernio/connect/select-location', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationId: selected }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(friendlyMessage(body.error ?? `select_location_failed_${res.status}`));
        setBusy(false);
        return;
      }
      router.push('/dashboard');
    } catch {
      setError('Network error — please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-gray-900">
        Pick a Google Business location
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Select the location RepWorth should publish responses for. You can
        change this later by reconnecting.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          {locations.map((loc) => (
            <label
              key={loc.id}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                selected === loc.id
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <input
                type="radio"
                name="location"
                value={loc.id}
                checked={selected === loc.id}
                onChange={() => setSelected(loc.id)}
                disabled={busy}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-gray-900">{loc.name}</div>
                <div className="text-sm text-gray-500">{loc.address}</div>
              </div>
            </label>
          ))}
        </div>

        {error && (
          <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!selected || busy}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect this location'}
          </button>
          <Link
            href="/dashboard/connect"
            className="text-sm text-gray-600 hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function friendlyMessage(code: string): string {
  switch (code) {
    case 'connect_session_missing':
    case 'connect_session_expired':
      return 'Your connect session expired. Please start over.';
    case 'invalid_location_id':
      return 'That location isn’t recognized — please pick one from the list.';
    case 'finalize_in_progress':
      return 'Another tab is already finalizing this connection — please wait a moment and refresh.';
    case 'finalize_unknown_admin_required':
      return 'This connection needs manual review by our support team.';
    case 'already_connected_by_parallel_flow':
      return 'This business was just connected from another tab.';
    case 'flow_changed':
      return 'The connection flow changed — please start over from the dashboard.';
    case 'connect_pending_missing':
      return 'Your connect session expired. Please start over.';
    case 'malformed_pending_marker':
      return 'Something went wrong with this connect session. Please start over.';
    case 'business_mismatch':
    case 'user_mismatch':
      return 'This connect session doesn’t match your account. Please start over.';
    case 'zernio_auth_error':
      return 'Google authorization expired before you finished. Please reconnect.';
    case 'zernio_validation_error':
      return 'Google rejected that selection — please pick a different location.';
    case 'feature_disabled':
      return 'Google Business publishing isn’t available right now.';
    case 'forbidden':
    case 'unauthorized':
      return 'You don’t have permission to do that.';
    default:
      return `Unable to connect (${code}).`;
  }
}
