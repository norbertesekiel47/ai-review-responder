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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
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
    <div className="content content--narrow">
      <section className="card connection-selection" aria-labelledby="connection-location-title">
        <h2 className="account-state-title" id="connection-location-title">
          Pick a Google Business location
        </h2>
        <p className="account-state-copy">
          Select the location RepWorth should publish responses for. You can
          change this later by reconnecting.
        </p>

        <form onSubmit={handleSubmit} className="connection-selection-form">
          <fieldset className="connection-options">
            <legend className="sr-only">Google Business locations</legend>
            {locations.map((loc) => (
              <label
                key={loc.id}
                className={`connection-option ${selected === loc.id ? 'connection-option--selected' : ''}`}
              >
                <input
                  type="radio"
                  name="location"
                  value={loc.id}
                  checked={selected === loc.id}
                  onChange={() => setSelected(loc.id)}
                  disabled={busy}
                  className="connection-option-radio"
                />
                <div className="connection-option-copy">
                  <strong>{loc.name}</strong>
                  <span>{loc.address}</span>
                </div>
              </label>
            ))}
          </fieldset>

          {error && (
            <p className="connection-error" role="alert">
              {error}
            </p>
          )}

          <div className="connection-actions">
            <button
              type="submit"
              disabled={!selected || busy}
              className="btn btn-primary"
            >
              {busy ? 'Connecting…' : 'Connect this location'}
            </button>
            <Link href="/dashboard/connect" className="btn btn-secondary">
              Cancel
            </Link>
          </div>
        </form>
      </section>
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
