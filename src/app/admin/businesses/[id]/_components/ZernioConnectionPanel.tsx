'use client';

import { useReducer, useCallback } from 'react';
import type {
  ZernioPanelData,
  ZernioConnectionSummary,
  AwaitingOwnerConnectResponse,
  ZernioFinalizeIncident,
} from '../types';

interface ZernioConnectionPanelProps {
  businessId: string;
  zernio: ZernioPanelData;
  onChanged: () => void;
}

const LAST_ERROR_PREVIEW_LIMIT = 120;

const STATUS_BADGE_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  pending: 'bg-gray-100 text-gray-700',
  disconnected: 'bg-red-100 text-red-800',
  not_connected: 'bg-gray-100 text-gray-700',
};

const STATUS_BADGE_LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending',
  disconnected: 'Disconnected',
  not_connected: 'Not connected',
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function truncate(text: string | null, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function StatusBadge({ status }: { status: 'pending' | 'active' | 'disconnected' | 'not_connected' }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_BADGE_STYLES[status] ?? STATUS_BADGE_STYLES.not_connected
      }`}
    >
      {STATUS_BADGE_LABELS[status] ?? status}
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
            <p className="mt-0.5 text-gray-800">{formatTimestamp(connection.connectedAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Disconnected at
            </p>
            <p className="mt-0.5 text-gray-800">
              {formatTimestamp(connection.disconnectedAt)}
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
                    {formatTimestamp(connection.lastErrorAt)}
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
          <li
            key={r.responseId}
            className="rounded border border-gray-200 bg-white p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-rw-teal">{formatStars(r.starRating)}</span>
              <span className="font-medium text-gray-700">{r.reviewerName}</span>
              <span className="text-xs text-gray-400">
                Queued {formatTimestamp(r.createdAt)}
              </span>
              <button
                type="button"
                onClick={() => onDismiss(r.responseId)}
                disabled={dismissingId === r.responseId}
                className="ml-auto rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {dismissingId === r.responseId ? 'Dismissing…' : 'Dismiss'}
              </button>
            </div>
            {r.reviewText && (
              <p className="mt-1 line-clamp-2 text-xs text-gray-500">{r.reviewText}</p>
            )}
            {r.draftText && (
              <p className="mt-2 line-clamp-3 rounded bg-blue-50 p-2 text-xs text-blue-900">
                {r.draftText}
              </p>
            )}
          </li>
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
                {formatTimestamp(i.finalizeUnknownAt)}
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
      if (!confirm('Permanently discard this queued reply? It will not post to Google.')) return;
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
    if (
      !confirm(
        'Manually disconnect this business from Zernio? The owner will need to reconnect before any future approvals can post automatically.',
      )
    )
      return;
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
          <StatusBadge status={status} />
        </div>
        {status === 'active' && (
          <button
            type="button"
            onClick={() => {
              void handleDisconnect();
            }}
            disabled={disconnecting}
            className="rounded border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {disconnecting ? 'Disconnecting…' : 'Manually disconnect'}
          </button>
        )}
      </div>

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
