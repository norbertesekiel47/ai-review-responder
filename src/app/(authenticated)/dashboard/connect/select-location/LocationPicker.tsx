'use client';

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
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  /**
   * Cancel is a real cancel (UX audit D22): it POSTs the cancel route so the
   * pending marker is cleared, THEN returns to /dashboard/connect — which then
   * shows the connect button rather than the same pending screen the owner was
   * trying to leave. `cancelled:false` (marker already gone) is a fine outcome:
   * the destination is right either way. Only a 409 (finalize already running)
   * keeps the owner here, with the reason.
   */
  async function handleCancel() {
    if (busy || cancelling) return;
    setCancelling(true);
    setError(null);
    const failure = await postConnectRoute('/api/zernio/connect/cancel', 'cancel_failed');
    if (failure !== null) {
      setError(failure);
      setCancelling(false);
      return;
    }
    router.push('/dashboard/connect');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const failure = await postConnectRoute(
      '/api/zernio/connect/select-location',
      'select_location_failed',
      { locationId: selected },
    );
    if (failure !== null) {
      setError(failure);
      setBusy(false);
      return;
    }
    router.push('/dashboard');
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
              disabled={!selected || busy || cancelling}
              className="btn btn-primary"
            >
              {busy ? 'Connecting…' : 'Connect this location'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={busy || cancelling}
              className="btn btn-secondary"
            >
              {cancelling ? 'Cancelling…' : 'Cancel and start over'}
            </button>
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
  ['invalid_location_id', 'That location isn’t recognized. Please pick one from the list.'],
  ['finalize_in_progress', 'Another tab is already finalizing this connection. Please wait a moment and refresh.'],
  ['finalize_unknown_admin_required', 'This connection needs manual review by our support team.'],
  ['already_connected_by_parallel_flow', 'This business was just connected from another tab.'],
  ['flow_changed', 'The connection flow changed. Please start over from the dashboard.'],
  ['malformed_pending_marker', 'Something went wrong with this connect session. Please start over.'],
  ['business_mismatch', ACCOUNT_MISMATCH],
  ['user_mismatch', ACCOUNT_MISMATCH],
  ['zernio_auth_error', 'Google authorization expired before you finished. Please reconnect.'],
  ['zernio_validation_error', 'Google rejected that selection. Please pick a different location.'],
  ['feature_disabled', 'Google Business publishing isn’t available right now.'],
  ['forbidden', NO_PERMISSION],
  ['unauthorized', NO_PERMISSION],
]);

function friendlyMessage(code: string): string {
  return FRIENDLY_MESSAGES.get(code) ?? `Unable to connect (${code}).`;
}

/**
 * POST to one connect route. Resolves to null on success, otherwise to the
 * owner-facing message: the API's error code mapped through `friendlyMessage`
 * (`<fallbackCode>_<status>` when the body carries none), or the network line.
 */
async function postConnectRoute(
  path: string,
  fallbackCode: string,
  body?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.ok) return null;
    const payload: { error?: string } = await res.json().catch(() => ({}));
    return friendlyMessage(payload.error ?? `${fallbackCode}_${res.status}`);
  } catch {
    return 'Network error. Please try again.';
  }
}
