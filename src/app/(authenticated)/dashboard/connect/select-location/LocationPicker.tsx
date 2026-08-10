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

const SESSION_EXPIRED = 'Your connect session expired. Please start over.';
const ACCOUNT_MISMATCH = 'This connect session doesn’t match your account. Please start over.';
const NO_PERMISSION = 'You don’t have permission to do that.';

// Map (not a plain object) so an attacker-influenced code like 'toString'
// can never resolve through the prototype chain.
const FRIENDLY_MESSAGES = new Map<string, string>([
  ['connect_session_missing', SESSION_EXPIRED],
  ['connect_session_expired', SESSION_EXPIRED],
  ['connect_pending_missing', SESSION_EXPIRED],
  ['invalid_location_id', 'That location isn’t recognized — please pick one from the list.'],
  ['finalize_in_progress', 'Another tab is already finalizing this connection — please wait a moment and refresh.'],
  ['finalize_unknown_admin_required', 'This connection needs manual review by our support team.'],
  ['already_connected_by_parallel_flow', 'This business was just connected from another tab.'],
  ['flow_changed', 'The connection flow changed — please start over from the dashboard.'],
  ['malformed_pending_marker', 'Something went wrong with this connect session. Please start over.'],
  ['business_mismatch', ACCOUNT_MISMATCH],
  ['user_mismatch', ACCOUNT_MISMATCH],
  ['zernio_auth_error', 'Google authorization expired before you finished. Please reconnect.'],
  ['zernio_validation_error', 'Google rejected that selection — please pick a different location.'],
  ['feature_disabled', 'Google Business publishing isn’t available right now.'],
  ['forbidden', NO_PERMISSION],
  ['unauthorized', NO_PERMISSION],
]);

function friendlyMessage(code: string): string {
  return FRIENDLY_MESSAGES.get(code) ?? `Unable to connect (${code}).`;
}
