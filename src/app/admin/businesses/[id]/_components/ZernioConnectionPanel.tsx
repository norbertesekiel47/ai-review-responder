'use client';

import { useReducer, useCallback, useState } from 'react';
import type {
  ZernioPanelData,
  ZernioConnectionSummary,
  AwaitingOwnerConnectResponse,
  ZernioFinalizeIncident,
} from '../types';
import { formatAdminDateTime } from '@/components/admin/ui/format';

interface ZernioConnectionPanelProps {
  businessId: string;
  zernio: ZernioPanelData;
  onChanged: () => void;
}

const LAST_ERROR_PREVIEW_LIMIT = 120;

// Deliberately NOT the shared `StatusBadge` (src/components/admin/ui/StatusBadge.tsx):
// this is a Zernio-connection vocabulary, not a console status. `pending` means
// "connection handshake outstanding" here and "outbox row not yet dispatched"
// there — one key, two meanings, no correct single color (the shared map paints
// it yellow, this one gray). It also renders friendly labels ("Not connected")
// where the shared badge deliberately renders the raw status string. Named
// distinctly so it no longer shadows the shared primitive.
const ZERNIO_CONNECTION_BADGE_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  pending: 'bg-gray-100 text-gray-700',
  disconnected: 'bg-red-100 text-red-800',
  not_connected: 'bg-gray-100 text-gray-700',
};

const ZERNIO_CONNECTION_BADGE_LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending',
  disconnected: 'Disconnected',
  not_connected: 'Not connected',
};

function truncate(text: string | null, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function ZernioConnectionBadge({ status }: { status: 'pending' | 'active' | 'disconnected' | 'not_connected' }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ZERNIO_CONNECTION_BADGE_STYLES[status] ?? ZERNIO_CONNECTION_BADGE_STYLES.not_connected
      }`}
    >
      {ZERNIO_CONNECTION_BADGE_LABELS[status] ?? status}
    </span>
  );
}

function formatStars(rating: number): string {
  // Defensive clamp: bad data (negative, NaN, > 5) shouldn't render 0 or
  // 100 stars. Floor handles fractional inputs from any future schema drift.
  const clamped = Math.min(5, Math.max(0, Number.isFinite(rating) ? Math.floor(rating) : 0));
  return '★'.repeat(clamped) + '☆'.repeat(5 - clamped);
}

function ConnectionDetails({ connection }: { connection: ZernioConnectionSummary | null }) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
      {connection ? (
        <>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Connected at
            </p>
            <p className="mt-0.5 text-gray-800">{formatAdminDateTime(connection.connectedAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Disconnected at
            </p>
            <p className="mt-0.5 text-gray-800">
              {formatAdminDateTime(connection.disconnectedAt)}
            </p>
          </div>
          {connection.disconnectReason && (
            <div className="sm:col-span-2">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Disconnect reason
              </p>
              <p className="mt-0.5 text-gray-800">{connection.disconnectReason}</p>
            </div>
          )}
          {connection.lastError && (
            <div className="sm:col-span-2">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Last error
                {connection.lastErrorAt && (
                  <span className="ml-2 font-normal normal-case text-gray-400">
                    {formatAdminDateTime(connection.lastErrorAt)}
                  </span>
                )}
              </p>
              <p className="mt-0.5 break-words text-gray-800">
                {truncate(connection.lastError, LAST_ERROR_PREVIEW_LIMIT)}
              </p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Zernio account
            </p>
            <p className="mt-0.5 break-all font-mono text-xs text-gray-700">
              {connection.zernioAccountId}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Zernio location
            </p>
            <p className="mt-0.5 break-all font-mono text-xs text-gray-700">
              {connection.zernioLocationId}
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-500 sm:col-span-2">
          This business has never started a Zernio connect flow. Approved responses will stay
          queued in the dashboard until the owner connects Google via Zernio.
        </p>
      )}
    </div>
  );
}

const DANGER_BUTTON =
  'rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50';
const CANCEL_BUTTON =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * One queued reply and its Dismiss action (X4). Dismiss permanently discards
 * an APPROVED reply, so it arms into an inline confirm — consequence stated,
 * one-line reason required — instead of a native `confirm()` an operator
 * clicks through by reflex. The reason is a client-side gate: the route's
 * body is `{action: 'dismiss', responseId}` with no note field, so it is not
 * sent into a schema that would strip it.
 */
function QueuedResponseRow({
  response: r,
  dismissing,
  onDismiss,
}: {
  response: AwaitingOwnerConnectResponse;
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState('');
  const reasonMissing = reason.trim().length === 0;
  const reasonId = `zernio-dismiss-${r.responseId}-reason`;

  function disarm() {
    setArmed(false);
    setReason('');
  }

  return (
    <li className="rounded border border-gray-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-rw-teal">{formatStars(r.starRating)}</span>
        <span className="font-medium text-gray-700">{r.reviewerName}</span>
        <span className="text-xs text-gray-400">Queued {formatAdminDateTime(r.createdAt)}</span>
        {!armed && (
          <button
            type="button"
            onClick={() => setArmed(true)}
            disabled={dismissing}
            className="ml-auto rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        )}
      </div>
      {r.reviewText && <p className="mt-1 line-clamp-2 text-xs text-gray-500">{r.reviewText}</p>}
      {r.draftText && (
        <p className="mt-2 line-clamp-3 rounded bg-gray-50 p-2 text-xs text-gray-700">{r.draftText}</p>
      )}
      {armed && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-gray-800">
            Permanently discards this approved reply. It will never post to Google, and the owner is
            not told.
          </p>
          <label htmlFor={reasonId} className="mt-3 block text-sm font-medium text-gray-700">
            Reason (one line, required)
            <input
              id={reasonId}
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
              onClick={() => {
                onDismiss();
                disarm();
              }}
              disabled={reasonMissing || dismissing}
              className={DANGER_BUTTON}
            >
              Discard reply
            </button>
            <button type="button" onClick={disarm} disabled={dismissing} className={CANCEL_BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

interface AwaitingQueueSectionProps {
  awaitingOwnerConnect: AwaitingOwnerConnectResponse[];
  status: 'pending' | 'active' | 'disconnected' | 'not_connected';
  draining: boolean;
  dismissingId: string | null;
  queueError: string | null;
  onForceDrain: () => void;
  onDismiss: (responseId: string) => void;
}

function AwaitingQueueSection({
  awaitingOwnerConnect,
  status,
  draining,
  dismissingId,
  queueError,
  onForceDrain,
  onDismiss,
}: AwaitingQueueSectionProps) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800">
          Responses queued for reconnect ({awaitingOwnerConnect.length})
        </h3>
        {status === 'active' ? (
          <button
            type="button"
            onClick={onForceDrain}
            disabled={draining}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {draining ? 'Draining…' : 'Force drain queue'}
          </button>
        ) : (
          <span className="text-xs text-gray-400">
            Drain becomes available once the owner reconnects Zernio.
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        These approved responses cannot publish until the owner reconnects Zernio. After
        reconnect, the worker drains them automatically.
      </p>
      {queueError && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {queueError}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {awaitingOwnerConnect.map((r) => (
          <QueuedResponseRow
            key={r.responseId}
            response={r}
            dismissing={dismissingId === r.responseId}
            onDismiss={() => onDismiss(r.responseId)}
          />
        ))}
      </ul>
    </div>
  );
}

function IncidentsSection({
  unresolvedIncidents,
}: {
  unresolvedIncidents: ZernioFinalizeIncident[];
}) {
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-red-800">
        Unresolved finalize incidents ({unresolvedIncidents.length})
      </h3>
      <p className="mt-1 text-xs text-gray-600">
        New connect/start attempts are blocked while any incident is unresolved. See{' '}
        <code className="rounded bg-gray-100 px-1">docs/runbook</code> for the
        reconciliation procedure.
      </p>
      <ul className="mt-3 space-y-2">
        {unresolvedIncidents.map((i) => (
          <li
            key={i.id}
            className="rounded border border-red-200 bg-red-50 p-3 text-xs"
          >
            <div className="flex flex-wrap gap-3">
              <span className="text-red-700">
                <span className="font-medium">Opened:</span>{' '}
                {formatAdminDateTime(i.finalizeUnknownAt)}
              </span>
              <span className="text-red-700">
                <span className="font-medium">Flow:</span>{' '}
                <span className="font-mono">{i.flowId}</span>
              </span>
              <span className="text-red-700">
                <span className="font-medium">Zernio profile:</span>{' '}
                <span className="font-mono">{i.zernioProfileId}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface PanelState {
  disconnecting: boolean;
  error: string | null;
  draining: boolean;
  dismissingId: string | null;
  queueError: string | null;
}

const initialPanelState: PanelState = {
  disconnecting: false,
  error: null,
  draining: false,
  dismissingId: null,
  queueError: null,
};

type PanelAction =
  | { type: 'drainStart' }
  | { type: 'drainEnd' }
  | { type: 'dismissStart'; dismissingId: string }
  | { type: 'dismissEnd' }
  | { type: 'queueError'; error: string }
  | { type: 'disconnectStart' }
  | { type: 'disconnectEnd' }
  | { type: 'disconnectError'; error: string };

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'drainStart':
      return { ...state, draining: true, queueError: null };
    case 'drainEnd':
      return { ...state, draining: false };
    case 'dismissStart':
      return { ...state, dismissingId: action.dismissingId, queueError: null };
    case 'dismissEnd':
      return { ...state, dismissingId: null };
    case 'queueError':
      return { ...state, queueError: action.error };
    case 'disconnectStart':
      return { ...state, disconnecting: true, error: null };
    case 'disconnectEnd':
      return { ...state, disconnecting: false };
    case 'disconnectError':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

export function ZernioConnectionPanel({
  businessId,
  zernio,
  onChanged,
}: ZernioConnectionPanelProps) {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const { disconnecting, error, draining, dismissingId, queueError } = state;
  // Manual disconnect severs the owner's Google connection, so the header
  // button arms an inline confirm rather than firing on a reflex click (X4).
  const [disconnectArmed, setDisconnectArmed] = useState(false);

  const handleForceDrain = useCallback(async () => {
    dispatch({ type: 'drainStart' });
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/zernio-queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'force_drain' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      dispatch({
        type: 'queueError',
        error: err instanceof Error ? err.message : 'Failed to drain queue',
      });
    } finally {
      dispatch({ type: 'drainEnd' });
    }
  }, [businessId, onChanged]);

  const handleDismiss = useCallback(
    async (responseId: string) => {
      dispatch({ type: 'dismissStart', dismissingId: responseId });
      try {
        const res = await fetch(`/api/admin/businesses/${businessId}/zernio-queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'dismiss', responseId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        onChanged();
      } catch (err) {
        dispatch({
          type: 'queueError',
          error: err instanceof Error ? err.message : 'Failed to dismiss',
        });
      } finally {
        dispatch({ type: 'dismissEnd' });
      }
    },
    [businessId, onChanged],
  );

  const handleDisconnect = useCallback(async () => {
    dispatch({ type: 'disconnectStart' });
    try {
      const res = await fetch('/api/zernio/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      dispatch({
        type: 'disconnectError',
        error: err instanceof Error ? err.message : 'Failed to disconnect',
      });
    } finally {
      dispatch({ type: 'disconnectEnd' });
    }
  }, [businessId, onChanged]);

  const { connection, awaitingOwnerConnect, unresolvedIncidents } = zernio;
  const status: 'pending' | 'active' | 'disconnected' | 'not_connected' =
    connection?.status ?? 'not_connected';

  return (
    <section className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-900">Zernio Connection</h2>
          <ZernioConnectionBadge status={status} />
        </div>
        {status === 'active' && !disconnectArmed && (
          <button
            type="button"
            onClick={() => setDisconnectArmed(true)}
            disabled={disconnecting}
            className="rounded border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {disconnecting ? 'Disconnecting…' : 'Manually disconnect'}
          </button>
        )}
      </div>

      {disconnectArmed && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-gray-800">
            Severs this business&apos;s Google connection. Approved replies queue here until the owner
            reconnects; nothing posts in the meantime, and only the owner can reconnect.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setDisconnectArmed(false);
                void handleDisconnect();
              }}
              disabled={disconnecting}
              className={DANGER_BUTTON}
            >
              Disconnect from Zernio
            </button>
            <button
              type="button"
              onClick={() => setDisconnectArmed(false)}
              disabled={disconnecting}
              className={CANCEL_BUTTON}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {/* Connection details */}
      <ConnectionDetails connection={connection} />

      {/* Counts */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded border border-gray-200 bg-gray-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Awaiting owner reconnect
          </p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">
            {awaitingOwnerConnect.length}
          </p>
        </div>
        <div
          className={`rounded border p-3 ${
            unresolvedIncidents.length > 0
              ? 'border-red-200 bg-red-50'
              : 'border-gray-200 bg-gray-50'
          }`}
        >
          <p
            className={`text-xs font-medium uppercase tracking-wide ${
              unresolvedIncidents.length > 0 ? 'text-red-700' : 'text-gray-500'
            }`}
          >
            Unresolved finalize incidents
          </p>
          <p
            className={`mt-1 text-2xl font-semibold ${
              unresolvedIncidents.length > 0 ? 'text-red-800' : 'text-gray-900'
            }`}
          >
            {unresolvedIncidents.length}
          </p>
        </div>
      </div>

      {/* Awaiting list */}
      {awaitingOwnerConnect.length > 0 && (
        <AwaitingQueueSection
          awaitingOwnerConnect={awaitingOwnerConnect}
          status={status}
          draining={draining}
          dismissingId={dismissingId}
          queueError={queueError}
          onForceDrain={() => {
            void handleForceDrain();
          }}
          onDismiss={(responseId) => {
            void handleDismiss(responseId);
          }}
        />
      )}

      {/* Incidents list */}
      {unresolvedIncidents.length > 0 && (
        <IncidentsSection unresolvedIncidents={unresolvedIncidents} />
      )}
    </section>
  );
}
