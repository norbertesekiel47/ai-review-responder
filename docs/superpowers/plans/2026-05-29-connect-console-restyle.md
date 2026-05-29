# Connect Page Console Restyle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `src/app/(authenticated)/dashboard/connect/page.tsx` into the owner Console design system (reuse `.card` / `.btn-primary` / `.btn-secondary`, remove all amber/orange/yellow), with no behavior, copy, routing, or analytics changes.

**Architecture:** Presentational-only edit of one page component plus one generic reusable CSS variant (`.banner-red`). A new render-level contract test locks in "no warm-tone classes + Console `.btn`/`.card` primitives". The 8 existing behavior tests assert by role + visible text and stay green untouched.

**Tech Stack:** Next.js 16 App Router (client component), React, the Console CSS system (`src/app/(authenticated)/_styles/console.css` + `tokens.css`), Tailwind utilities (already compiled for this file), Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-05-29-connect-console-restyle-design.md`

---

## File Structure

- **Modify:** `src/app/(authenticated)/_styles/console.css` — add one `.banner-red` variant (~6 lines) after the existing `.banner-blue` block. Generic reusable red inline-alert; the Console lacks one.
- **Modify:** `src/app/(authenticated)/dashboard/connect/page.tsx` — replace presentational JSX/classes across all 8 view sub-components + the shell + error/loading/fallback branches + the spinner. All logic (`handleConnect`, `handleCancel`, effects, `friendlyErrorMessage`, `enqueueConnectAnalytics`, `makeClientEventId`, the `ConnectAnalyticsEventName` type, the state-routing JSX conditions, every heading/body/label string) stays verbatim.
- **Create:** `src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx` — render-level contract test (no warm classes in any state; CTAs use `.btn`; view content sits in `.content .card`).
- **Leave untouched:** `src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx` — the 8 behavior tests. They must pass with zero edits.
- **Modify (docs):** `docs/launch-ready-part2.md` — annotate the audit item as done.

Validation note: this worktree is nested in the repo; per CLAUDE.md, local `lint`/`test` can be poisoned by the parent's `node_modules`/eslintrc. Use targeted `pnpm vitest run <file>` for fast feedback, but treat **CI (lint/typecheck/test/build)** as the authoritative gate.

---

## Task 1: Add the `.banner-red` Console variant

**Files:**
- Modify: `src/app/(authenticated)/_styles/console.css` (after line 449, the `.banner-blue .b-sub` rule)

- [ ] **Step 1: Add the CSS variant**

In `src/app/(authenticated)/_styles/console.css`, find the existing banner color variants:

```css
.banner-orange { border-color: #FED7AA; background: #FFF7ED; }
.banner-blue { border-color: #BFDBFE; background: #EFF6FF; }
.banner .b-title { font-weight: 600; color: #9A3412; font-size: 14px; }
.banner-blue .b-title { color: #1E3A8A; }
.banner .b-sub { font-size: 13px; color: #9A3412cc; margin-top: 2px; }
.banner-blue .b-sub { color: #1E40AFcc; }
```

Immediately **after** the `.banner-blue .b-sub` line, insert:

```css
/* Red inline alert (errors). Cool/utility red — mirrors .banner-blue. */
.banner-red { border-color: var(--rw-red-300); background: var(--rw-red-50); }
.banner-red .b-title { color: var(--rw-red-700); }
.banner-red .b-sub { color: #B91C1Ccc; }
.banner-red .b-icon { background: var(--rw-red-100); color: var(--rw-red-700); }
```

- [ ] **Step 2: Verify it parses (no test framework for CSS — confirm via the page test in Task 2)**

Run: `node -e "const c=require('fs').readFileSync('src/app/(authenticated)/_styles/console.css','utf8'); if(!c.includes('.banner-red')) process.exit(1); console.log('banner-red present')"`
Expected: prints `banner-red present`

- [ ] **Step 3: Commit**

```bash
git add "src/app/(authenticated)/_styles/console.css"
git commit -m "feat(console): add .banner-red inline-alert variant"
```

---

## Task 2: Restyle the connect page (TDD)

**Files:**
- Create: `src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx`
- Modify: `src/app/(authenticated)/dashboard/connect/page.tsx`

- [ ] **Step 1: Write the failing contract test**

Create `src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx` with exactly:

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';

const { mockUseDashboardData, mockSearchParams } = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
  mockSearchParams: { value: new URLSearchParams() },
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));

vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({
    currentScope: PRIMARY_LOCATION_ID,
    setLocationScope: vi.fn(),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => mockSearchParams.value,
}));

import ConnectPage from '../page';

const WARM_SELECTOR = '[class*="amber"], [class*="orange"], [class*="yellow"]';

function activeData(zernio: Record<string, unknown>) {
  return { data: { zernioConnection: zernio }, error: null, refresh: vi.fn() };
}

describe('/dashboard/connect Console restyle contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.value = new URLSearchParams();
  });

  const states: Array<[string, ReturnType<typeof activeData>]> = [
    ['connect (none)', activeData({ status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false })],
    ['reconnect (disconnected)', activeData({ status: 'disconnected', queuedReconnectCount: 2, hasUnresolvedIncident: false, lastDisconnectReason: 'revoked' })],
    ['pending', activeData({ status: 'pending', pendingFlow: { status: 'oauth_in_progress' }, queuedReconnectCount: 0, hasUnresolvedIncident: false })],
    ['finalizing', activeData({ status: 'pending', pendingFlow: { status: 'finalizing' }, queuedReconnectCount: 0, hasUnresolvedIncident: false })],
    ['finalize_unknown', activeData({ status: 'finalize_unknown', queuedReconnectCount: 0, hasUnresolvedIncident: false })],
  ];

  it.each(states)('renders %s with no amber/orange/yellow classes', (_label, value) => {
    mockUseDashboardData.mockReturnValue(value);
    const { container } = render(<ConnectPage />);
    expect(container.querySelectorAll(WARM_SELECTOR)).toHaveLength(0);
  });

  it('renders the read-only billing state with no warm classes', () => {
    mockUseDashboardData.mockReturnValue({
      data: {
        subscriptionStatus: 'past_due',
        isReadOnly: true,
        zernioConnection: { status: 'disconnected', queuedReconnectCount: 1, hasUnresolvedIncident: false, lastDisconnectReason: 'revoked' },
      },
      error: null,
      refresh: vi.fn(),
    });
    const { container } = render(<ConnectPage />);
    expect(container.querySelectorAll(WARM_SELECTOR)).toHaveLength(0);
  });

  it('renders the page-load error with no warm classes', () => {
    mockUseDashboardData.mockReturnValue({ data: null, error: 'boom', refresh: vi.fn() });
    const { container } = render(<ConnectPage />);
    expect(container.querySelectorAll(WARM_SELECTOR)).toHaveLength(0);
  });

  it('uses Console .btn primitives for the connect CTA', () => {
    mockUseDashboardData.mockReturnValue(activeData({ status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { getByRole } = render(<ConnectPage />);
    expect(getByRole('button', { name: /connect google business/i })).toHaveClass('btn', 'btn-primary');
  });

  it('uses Console .btn-secondary for the pending cancel control', () => {
    mockUseDashboardData.mockReturnValue(activeData({ status: 'pending', pendingFlow: { status: 'oauth_in_progress' }, queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { getByRole } = render(<ConnectPage />);
    expect(getByRole('button', { name: /^cancel$/i })).toHaveClass('btn', 'btn-secondary');
  });

  it('wraps view content in a Console .card', () => {
    mockUseDashboardData.mockReturnValue(activeData({ status: 'none', queuedReconnectCount: 0, hasUnresolvedIncident: false }));
    const { container } = render(<ConnectPage />);
    expect(container.querySelector('.content .card')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the contract test to verify it FAILS**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx"`
Expected: FAIL — the read-only/reconnect/finalize_unknown cases match warm-tone classes (`amber-*`/`orange-700`/`yellow-*`); the CTA has `bg-blue-600` not `btn`; there is no `.content .card`.

- [ ] **Step 3: Replace `page.tsx` with the restyled version**

Overwrite `src/app/(authenticated)/dashboard/connect/page.tsx` with exactly the following. Only JSX class/`style` attributes and the wrapper elements changed — every hook, effect, handler, string, the routing `? :` chain, and the helper functions are identical to the original.

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import type { LocationId } from '@/lib/shared/ids';

// Console text tokens reused across the connect views (no warm tones).
const MUTED = { color: 'var(--rw-app-text-muted)' } as const;
const FINE = { color: 'var(--rw-app-text-soft)', fontSize: 12 } as const;
const CTA = { marginTop: 16 } as const;
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
        <div className="banner banner-red" role="alert">
          <div>
            <div className="b-title">Couldn’t load this page</div>
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
      {actionError && (
        <div className="banner banner-red" role="alert">
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
      <h1 className="card-h2">{heading}</h1>
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
      <h1 className="card-h2">Connect Google Business</h1>
      <p style={MUTED}>
        Connect your Google Business Profile so RepWorth can publish approved
        responses for you. You&apos;ll be redirected to Google to grant access.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="btn btn-primary disabled:opacity-50"
        style={CTA}
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
      <h1 className="card-h2">Reconnect Google Business</h1>
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
        style={CTA}
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
        <h1 className="card-h2" style={{ margin: 0 }}>Connecting…</h1>
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
        style={CTA}
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
      <h1 className="card-h2">Connection could not be completed</h1>
      <p style={MUTED}>
        This connection attempt is no longer valid. Clear it, then start a new
        Google Business connection.
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="btn btn-secondary disabled:opacity-50"
        style={CTA}
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
        <h1 className="card-h2" style={{ margin: 0 }}>Finishing connection…</h1>
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
      <h1 className="card-h2">Connection requires manual review</h1>
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
```

- [ ] **Step 4: Run the contract test to verify it PASSES**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx"`
Expected: PASS — all states render with zero warm-tone classes; CTAs carry `btn btn-primary` / `btn btn-secondary`; `.content .card` exists.

- [ ] **Step 5: Run the existing behavior tests to verify they STILL PASS (no edits)**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx"`
Expected: PASS — all 8 tests green. They assert by role + visible text, which are unchanged.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authenticated)/dashboard/connect/page.tsx" "src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx"
git commit -m "fix(connect): restyle dashboard/connect into the Console (P0 #10)

Reuse Console primitives (.card/.btn-primary/.btn-secondary) and the
.content shell; remove all amber/orange/yellow (read-only billing,
reconnect queued-count, finalize-unknown -> cool tokens); errors use the
new .banner-red. Spinner uses Console tokens. Behavior, copy, routing,
and analytics unchanged. Adds a render-level no-warm-tones contract test."
```

---

## Task 3: Annotate the launch-readiness audit

**Files:**
- Modify: `docs/launch-ready-part2.md`

- [ ] **Step 1: Mark the prioritized-list item done**

Replace line 143:

```markdown
10. **Restyle `dashboard/connect`** with Console classes; remove amber/orange.
```

with:

```markdown
10. ✅ **Restyle `dashboard/connect`** with Console classes; remove amber/orange. — **DONE (PR #__):** all 8 view states (`Connect`/`Reconnect`/`Pending`/`Finalizing`/`Interrupted`/`FinalizeUnknown`/`ReadOnly` + the data-load/loading/fallback branches) reskinned onto the Console shell (`.content` + `.card`); CTAs → `.btn-primary`/`.btn-secondary`; spinner → Console tokens; amber/orange/yellow gone (read-only billing, reconnect queued-count, finalize-unknown → cool `--rw-app-*` tokens); errors use a new generic `.banner-red`. Presentational-only — connect/cancel/analytics/routing/copy verbatim; 8 existing behavior tests untouched + a new no-warm-tones contract test.
```

- [ ] **Step 2: Annotate the detail line**

Replace line 86:

```markdown
- **Connect page (`dashboard/connect/page.tsx`)** — raw Tailwind prototype (`rounded-lg border-gray-200`, `bg-blue-600`), not Console classes; looks like a different product. `ReadOnlyConnectView` uses `amber-*`, `ReconnectView` uses `text-orange-700`. **P0.**
```

with:

```markdown
- ✅ **Connect page (`dashboard/connect/page.tsx`)** — raw Tailwind prototype (`rounded-lg border-gray-200`, `bg-blue-600`), not Console classes; looks like a different product. `ReadOnlyConnectView` uses `amber-*`, `ReconnectView` uses `text-orange-700`. **P0.** → **DONE (PR #__):** rebuilt on Console `.content`/`.card`/`.btn-*` primitives; all warm tones removed.
```

(The `#__` placeholders are filled with the real PR number during the finishing-a-development-branch step.)

- [ ] **Step 3: Commit**

```bash
git add docs/launch-ready-part2.md
git commit -m "docs(launch-audit): mark P0 #10 connect-page Console restyle done"
```

---

## Final verification (authoritative gate = CI)

- [ ] Push the branch and open a PR to `main`.
- [ ] Confirm the 4 CI checks pass: **lint, typecheck, test, build**.
- [ ] (Local sanity, non-authoritative) `pnpm vitest run "src/app/(authenticated)/dashboard/connect/__tests__/"` — both files green.

---

## Self-Review

**Spec coverage:**
- "Reuse Console primitives" → Task 2 uses `.card`/`.btn-primary`/`.btn-secondary`/`.content`/`.card-h2`; only new CSS is the generic `.banner-red` (Task 1). ✅
- "Fully cool palette" → `ReadOnlyConnectView` (amber→muted), `ReconnectView` queued-count (orange→muted), `FinalizeUnknownView` (yellow→neutral) all converted; contract test asserts zero `amber|orange|yellow`. ✅
- "Green `.btn-primary`" → Connect/Reconnect CTAs use `btn btn-primary`. ✅
- "Errors red, not warm" → page-load + inline `actionError` use `.banner-red`; red is `--rw-red-*`. ✅
- "No behavior/copy/logic change" → all hooks/handlers/strings/routing identical; 8 behavior tests untouched (Step 5). ✅
- "No TopBar" → not added. ✅
- "New regression test" → Task 2 Step 1. ✅

**Placeholder scan:** Only intentional `#__` PR-number placeholders in Task 3, explicitly flagged to fill at PR time. No code placeholders. ✅

**Type/name consistency:** `ConnectAnalyticsEventName`, `friendlyErrorMessage`, `enqueueConnectAnalytics`, `makeClientEventId`, `ReadOnlyConnectView`/`ConnectView`/`ReconnectView`/`PendingView`/`InterruptedPendingView`/`FinalizingView`/`FinalizeUnknownView`/`Spinner`, and props (`onConnect`/`onCancel`/`busy`/`lastDisconnectReason`/`queuedReconnectCount`/`zernio`) all match the original signatures. The `MUTED`/`FINE`/`CTA`/`SPINNER_ROW` style consts are defined once at module scope and referenced consistently. ✅
