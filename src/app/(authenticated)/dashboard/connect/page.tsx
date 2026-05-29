'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import { LiveRegion } from '@/components/ui/LiveRegion';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import type { LocationId } from '@/lib/shared/ids';

// Console text tokens reused across the connect views (no warm tones).
const MUTED = { color: 'var(--rw-app-text-muted)' } as const;
const FINE = { color: 'var(--rw-app-text-soft)', fontSize: 12 } as const;
const HEADING = { font: 'var(--rw-app-h1)', margin: '0 0 14px', letterSpacing: '-0.01em' } as const;
const CTA_SPACING = { marginTop: 16 } as const;
const SPINNER_ROW = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 } as const;

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
  const redirectTimerRef = useRef<number | null>(null);
  const urlError = searchParams.get('error');

  // The redirect-timeout fallback timer must not outlive the page. If the
  // browser navigates to Zernio (or restores this page from bfcache), clear it
  // so it can't fire a spurious gbp_connect_failed for a connect that succeeded.
  useEffect(() => {
    function clearRedirectTimer() {
      if (redirectTimerRef.current !== null) {
        window.clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
    }
    window.addEventListener('pagehide', clearRedirectTimer);
    return () => {
      window.removeEventListener('pagehide', clearRedirectTimer);
      clearRedirectTimer();
    };
  }, []);

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
      <div className="content">
        <LiveRegion message={error} level="assertive" />
        <div className="banner banner-red">
          <div>
            <div className="b-title">Couldn&apos;t load this page</div>
            <div className="b-sub">{error}</div>
          </div>
        </div>
        <div>
          <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
            ← Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="content">
        <p style={{ ...MUTED, textAlign: 'center', padding: '48px 0' }}>Loading…</p>
      </div>
    );
  }

  // Only the active variant of DashboardData carries zernioConnection. Other
  // subscription states (pending_payment, etc.) shouldn't reach this page in
  // practice; if they do, fall back to a generic message.
  if (!('zernioConnection' in data)) {
    return (
      <div className="content">
        <div className="card">
          <p style={MUTED}>
            Finish setting up your account before connecting Google Business.
          </p>
          <Link
            href="/dashboard"
            className="text-sm text-blue-600 hover:underline"
            style={{ display: 'inline-block', marginTop: 16 }}
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const zernio = data.zernioConnection;
  const isReadOnly =
    data.subscriptionStatus === 'past_due' && 'isReadOnly' in data && data.isReadOnly === true;

  // Active: redirect already issued in effect; render nothing to avoid flash.
  if (zernio.status === 'active') return null;

  async function handleConnect() {
    setBusy(true);
    setActionError(null);
    setRedirectUrl(null);
    // One correlation id for the whole attempt so its events share a stable
    // client event key and a retried POST of the same event dedups server-side.
    const attemptId = makeClientEventId();
    // gbp_connect_started is captured server-side (account-scoped) in
    // /api/zernio/connect/start so the funnel joins gbp_connected; the client
    // only reports failures. business_id lets a property-based funnel attribute
    // failures to the same location as the server-side started/connected events.
    const scopeProps = effectiveScope === 'all'
      ? { source: 'dashboard_connect', location_scope: 'all' as const }
      : { source: 'dashboard_connect', location_scope: 'location' as const, business_id: effectiveScope };
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
          ...scopeProps,
          reason,
          status: res.status,
        }, attemptId);
        setBusy(false);
        return;
      }
      setRedirectUrl(body.authUrl);
      redirectTimerRef.current = window.setTimeout(() => {
        redirectTimerRef.current = null;
        setActionError('If the connection window did not open, use the manual link below.');
        setBusy(false);
        void enqueueConnectAnalytics('gbp_connect_failed', {
          ...scopeProps,
          reason: 'redirect_timeout',
        }, attemptId);
      }, 2500);
      window.location.href = body.authUrl;
    } catch {
      setActionError('Network error — please try again.');
      void enqueueConnectAnalytics('gbp_connect_failed', {
        ...scopeProps,
        reason: 'network_error',
      }, attemptId);
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
    <div className="content">
      <LiveRegion message={actionError ?? ''} level="assertive" />
      {actionError && (
        <div className="banner banner-red">
          <div className="b-sub">{actionError}</div>
        </div>
      )}

      {zernio.status === 'finalize_unknown' || zernio.hasUnresolvedIncident ? (
        <FinalizeUnknownView />
      ) : isReadOnly ? (
        <ReadOnlyConnectView zernio={zernio} />
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

      {!isReadOnly && redirectUrl ? (
        <div>
          <a className="text-sm text-blue-600 hover:underline" href={redirectUrl}>
            Open connection manually
          </a>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
          ← Back to dashboard
        </Link>
        <Link href="/help/contact" className="text-sm text-blue-600 hover:underline">
          Get help connecting Google Business
        </Link>
      </div>
    </div>
  );
}

function ReadOnlyConnectView({
  zernio,
}: {
  zernio: DashboardDataActive['zernioConnection'];
}) {
  const heading =
    zernio.status === 'disconnected'
      ? 'Reconnect Google Business'
      : zernio.status === 'pending'
        ? 'Google Business connection pending'
        : 'Connect Google Business';
  const detail =
    zernio.status === 'disconnected'
      ? 'Google Business is disconnected. Update billing before reconnecting this location.'
      : zernio.status === 'pending'
        ? 'A Google Business connection is in progress, but account changes are paused until billing is updated.'
        : 'Google Business is not connected. Update billing before connecting this location.';

  return (
    <div className="card">
      <h1 style={HEADING}>{heading}</h1>
      <p style={MUTED}>{detail}</p>
      <p style={{ color: 'var(--rw-app-text)', fontWeight: 600, marginTop: 12 }}>
        Update billing to connect or change Google Business.
      </p>
      {zernio.queuedReconnectCount > 0 ? (
        <p style={{ ...MUTED, marginTop: 8 }}>
          {zernio.queuedReconnectCount} approved{' '}
          {zernio.queuedReconnectCount === 1 ? 'response is' : 'responses are'} waiting
          to publish after reconnect.
        </p>
      ) : null}
      {zernio.lastDisconnectReason ? (
        <p style={{ ...FINE, marginTop: 8 }}>
          Last disconnect reason: {zernio.lastDisconnectReason}
        </p>
      ) : null}
    </div>
  );
}

type ConnectAnalyticsEventName = 'gbp_connect_failed';

function enqueueConnectAnalytics(
  eventName: ConnectAnalyticsEventName,
  properties: Record<string, unknown>,
  clientEventId: string,
): Promise<void> {
  return fetch('/api/analytics/enqueue', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventName,
      clientEventId,
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
    <div className="card">
      <h1 style={HEADING}>Connect Google Business</h1>
      <p style={MUTED}>
        Connect your Google Business Profile so RepWorth can publish approved
        responses for you. You&apos;ll be redirected to Google to grant access.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="btn btn-primary disabled:opacity-50"
        style={CTA_SPACING}
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
    <div className="card">
      <h1 style={HEADING}>Reconnect Google Business</h1>
      <p style={MUTED}>
        Auto-publishing is currently disconnected. Reconnect to resume posting
        approved responses.
      </p>
      {queuedReconnectCount > 0 && (
        <p style={{ ...MUTED, marginTop: 8 }}>
          {queuedReconnectCount} approved{' '}
          {queuedReconnectCount === 1 ? 'response is' : 'responses are'} waiting
          to publish.
        </p>
      )}
      {lastDisconnectReason && (
        <p style={{ ...FINE, marginTop: 8 }}>
          Last disconnect reason: {lastDisconnectReason}
        </p>
      )}
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="btn btn-primary disabled:opacity-50"
        style={CTA_SPACING}
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
    <div className="card">
      <div style={SPINNER_ROW}>
        <Spinner />
        <h1 style={{ ...HEADING, margin: 0 }}>Connecting…</h1>
      </div>
      <p style={MUTED}>
        We&apos;re finishing the connection with Google. If you closed the
        Google window before authorizing, you can cancel and start over.
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="btn btn-secondary disabled:opacity-50"
        style={CTA_SPACING}
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
    <div className="card">
      <h1 style={HEADING}>Connection could not be completed</h1>
      <p style={MUTED}>
        This connection attempt is no longer valid. Clear it, then start a new
        Google Business connection.
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="btn btn-secondary disabled:opacity-50"
        style={CTA_SPACING}
      >
        {busy ? 'Clearing…' : 'Clear attempt'}
      </button>
    </div>
  );
}

function FinalizingView() {
  return (
    <div className="card">
      <div style={SPINNER_ROW}>
        <Spinner />
        <h1 style={{ ...HEADING, margin: 0 }}>Finishing connection…</h1>
      </div>
      <p style={MUTED}>
        We&apos;re saving your Google Business connection. This usually takes
        a few seconds — please don&apos;t close this tab.
      </p>
    </div>
  );
}

function FinalizeUnknownView() {
  return (
    <div className="card">
      <h1 style={HEADING}>Connection requires manual review</h1>
      <p style={MUTED}>
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
      className="inline-block h-5 w-5 animate-spin rounded-full border-2"
      style={{ borderColor: 'var(--rw-app-border)', borderTopColor: 'var(--rw-teal)' }}
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
    case 'past_due_read_only':
    case 'subscription_inactive':
    case 'subscription_required':
      return 'Update billing before connecting Google Business.';
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
