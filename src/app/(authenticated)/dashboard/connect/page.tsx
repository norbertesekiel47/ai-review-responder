'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';

/**
 * /dashboard/connect — Zernio Google Business connect entry point.
 *
 * State matrix (spec §3.3.5, six states). The dashboard data API exposes the
 * coarse-grained `zernioConnection.status` (none | pending | active |
 * disconnected | finalize_unknown) AND, when a Redis pending marker exists,
 * a `pendingFlow.status` (`oauth_in_progress` | `finalizing` | `starting` |
 * `finalize_unknown`). We use the marker's substatus to differentiate the
 * pending UI: `oauth_in_progress` shows a Cancel button (owner can abort),
 * `finalizing` shows a spinner only (cancel during finalize would 409 from
 * the API anyway — see spec §3.3.5).
 *
 * Respects the selected location scope via LocationContext so that the
 * Zernio connection status shown corresponds to the currently selected
 * location (or the primary location when scope is "all").
 */
export default function ConnectPage() {
  const { currentScope, setLocationScope } = useLocationScope();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedLocationId = searchParams.get('locationId');
  const requestedScope =
    requestedLocationId && requestedLocationId !== 'all'
      ? (requestedLocationId as LocationId)
      : null;
  const effectiveScope = requestedScope ?? currentScope;
  const { data, error, refresh } = useDashboardData(effectiveScope, {
    // VAL-DASH-029: When the API detects the selected location is archived,
    // fall back to primary and update the LocationContext switcher.
    onScopeFallback: (fallback) => {
      setLocationScope(fallback.fallbackLocationId as LocationId);
    },
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const urlError = searchParams.get('error');

  useEffect(() => {
    if (requestedScope && currentScope !== requestedScope) {
      setLocationScope(requestedScope);
    }
  }, [currentScope, requestedScope, setLocationScope]);

  // SSR-equivalent redirect: if the connection is already active, send the
  // owner back to the dashboard. Done in an effect so we can also `return null`
  // to suppress the flash of UI while the navigation happens.
  useEffect(() => {
    if (data && 'zernioConnection' in data && data.zernioConnection?.status === 'active') {
      router.replace('/dashboard');
    }
  }, [data, router]);

  useEffect(() => {
    if (urlError) {
      setActionError(friendlyErrorMessage(urlError));
    }
  }, [urlError]);

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="rounded-lg border border-red-300 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Error</h2>
          <p className="mt-1 text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading…</p>
      </div>
    );
  }

  // Only the active variant of DashboardData carries zernioConnection. Other
  // subscription states (pending_payment, etc.) shouldn't reach this page in
  // practice; if they do, fall back to a generic message.
  if (!('zernioConnection' in data)) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-gray-700">
          Finish setting up your account before connecting Google Business.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block text-blue-600 hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  const zernio = data.zernioConnection;

  // Active: redirect already issued in effect; render nothing to avoid flash.
  if (zernio.status === 'active') return null;

  async function handleConnect() {
    setBusy(true);
    setActionError(null);
    setRedirectUrl(null);
    void enqueueConnectAnalytics('gbp_connect_started', {
      source: 'dashboard_connect',
      locationScope: effectiveScope === 'all' ? 'all' : 'location',
    });
    try {
      const res = await fetch('/api/zernio/connect/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(effectiveScope === 'all'
          ? {}
          : { body: JSON.stringify({ locationId: effectiveScope }) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.authUrl) {
        const reason = body.error ?? `connect_failed_${res.status}`;
        setActionError(friendlyErrorMessage(reason));
        void enqueueConnectAnalytics('gbp_connect_failed', {
          source: 'dashboard_connect',
          reason,
          status: res.status,
        });
        setBusy(false);
        return;
      }
      setRedirectUrl(body.authUrl);
      window.setTimeout(() => {
        setActionError('If the connection window did not open, use the manual link below.');
        setBusy(false);
        void enqueueConnectAnalytics('gbp_connect_failed', {
          source: 'dashboard_connect',
          reason: 'redirect_timeout',
        });
      }, 2500);
      window.location.href = body.authUrl;
    } catch {
      setActionError('Network error — please try again.');
      void enqueueConnectAnalytics('gbp_connect_failed', {
        source: 'dashboard_connect',
        reason: 'network_error',
      });
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch('/api/zernio/connect/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(effectiveScope === 'all'
          ? {}
          : { body: JSON.stringify({ locationId: effectiveScope }) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(friendlyErrorMessage(body.error ?? `cancel_failed_${res.status}`));
        return;  // finally clears busy
      }
      await refresh();
    } catch {
      setActionError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {actionError && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          {actionError}
        </div>
      )}

      {zernio.status === 'finalize_unknown' || zernio.hasUnresolvedIncident ? (
        <FinalizeUnknownView />
      ) : urlError && zernio.status === 'pending' ? (
        <InterruptedPendingView onCancel={handleCancel} busy={busy} />
      ) : zernio.status === 'pending' ? (
        zernio.pendingFlow?.status === 'finalizing' ||
        zernio.pendingFlow?.status === 'starting' ? (
          <FinalizingView />
        ) : (
          <PendingView onCancel={handleCancel} busy={busy} />
        )
      ) : zernio.status === 'disconnected' ? (
        <ReconnectView
          onConnect={handleConnect}
          busy={busy}
          lastDisconnectReason={zernio.lastDisconnectReason}
          queuedReconnectCount={zernio.queuedReconnectCount}
        />
      ) : (
        <ConnectView onConnect={handleConnect} busy={busy} />
      )}

      {redirectUrl ? (
        <div className="mt-4">
          <a className="text-sm text-blue-600 hover:underline" href={redirectUrl}>
            Open connection manually
          </a>
        </div>
      ) : null}

      <div className="mt-6">
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
          ← Back to dashboard
        </Link>
      </div>
      <div className="mt-2">
        <Link href="/help/contact" className="text-sm text-blue-600 hover:underline">
          Get help connecting Google Business
        </Link>
      </div>
    </div>
  );
}

type ConnectAnalyticsEventName = 'gbp_connect_started' | 'gbp_connect_failed';

function enqueueConnectAnalytics(
  eventName: ConnectAnalyticsEventName,
  properties: Record<string, unknown>,
): Promise<void> {
  return fetch('/api/analytics/enqueue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventName,
      clientEventId: makeClientEventId(),
      properties,
    }),
  }).then(
    () => undefined,
    () => undefined,
  );
}

function makeClientEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ConnectView({
  onConnect,
  busy,
}: {
  onConnect: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h1 className="text-2xl font-semibold text-gray-900">
        Connect Google Business
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Connect your Google Business Profile so RepWorth can publish approved
        responses for you. You&apos;ll be redirected to Google to grant access.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="mt-6 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Connect Google Business'}
      </button>
    </div>
  );
}

function ReconnectView({
  onConnect,
  busy,
  lastDisconnectReason,
  queuedReconnectCount,
}: {
  onConnect: () => void;
  busy: boolean;
  lastDisconnectReason?: string;
  queuedReconnectCount: number;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h1 className="text-2xl font-semibold text-gray-900">
        Reconnect Google Business
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Auto-publishing is currently disconnected. Reconnect to resume posting
        approved responses.
      </p>
      {queuedReconnectCount > 0 && (
        <p className="mt-2 text-sm text-orange-700">
          {queuedReconnectCount} approved{' '}
          {queuedReconnectCount === 1 ? 'response is' : 'responses are'} waiting
          to publish.
        </p>
      )}
      {lastDisconnectReason && (
        <p className="mt-2 text-xs text-gray-500">
          Last disconnect reason: {lastDisconnectReason}
        </p>
      )}
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="mt-6 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Reconnect Google Business'}
      </button>
    </div>
  );
}

function PendingView({
  onCancel,
  busy,
}: {
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex items-center gap-3">
        <Spinner />
        <h1 className="text-2xl font-semibold text-gray-900">Connecting…</h1>
      </div>
      <p className="mt-2 text-sm text-gray-600">
        We&apos;re finishing the connection with Google. If you closed the
        Google window before authorizing, you can cancel and start over.
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="mt-6 rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  );
}

function InterruptedPendingView({
  onCancel,
  busy,
}: {
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h1 className="text-2xl font-semibold text-gray-900">
        Connection could not be completed
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        This connection attempt is no longer valid. Clear it, then start a new
        Google Business connection.
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="mt-6 rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? 'Clearing…' : 'Clear attempt'}
      </button>
    </div>
  );
}

function FinalizingView() {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="flex items-center gap-3">
        <Spinner />
        <h1 className="text-2xl font-semibold text-gray-900">
          Finishing connection…
        </h1>
      </div>
      <p className="mt-2 text-sm text-gray-600">
        We&apos;re saving your Google Business connection. This usually takes
        a few seconds — please don&apos;t close this tab.
      </p>
    </div>
  );
}

function FinalizeUnknownView() {
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-6">
      <h1 className="text-2xl font-semibold text-yellow-900">
        Connection requires manual review
      </h1>
      <p className="mt-2 text-sm text-yellow-800">
        Something unexpected happened while finishing your connection. Our
        support team has been alerted and will resolve this within 24 hours —
        you don&apos;t need to do anything.
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600"
    />
  );
}

function friendlyErrorMessage(code: string): string {
  switch (code) {
    case 'feature_disabled':
      return 'Google Business publishing isn’t available yet — please contact support.';
    case 'forbidden':
    case 'unauthorized':
      return 'You don’t have permission to do that.';
    case 'unscoped_owner':
      return 'Your account isn’t linked to a business yet — please contact support.';
    case 'connect_in_progress':
      return 'A connection is already in progress.';
    case 'oauth_denied':
      return 'Google did not finish authorizing the connection. Cancel this attempt and start again.';
    case 'missing_params':
    case 'state_expired':
    case 'pending_missing':
    case 'flow_mismatch':
    case 'user_mismatch':
      return 'The Google authorization session expired or no longer matches this browser session. Cancel this attempt and start again.';
    case 'zernio_listlocations_failed':
      return 'Google authorization finished, but we could not load your business locations. Cancel this attempt and start again.';
    case 'finalize_in_progress':
      return 'We’re finishing your connection — please wait a moment and refresh.';
    case 'finalize_unknown_admin_required':
      return 'This connection needs manual review by our support team.';
    case 'already_connected':
      return 'Google Business is already connected.';
    default:
      return `Unable to continue (${code}).`;
  }
}
