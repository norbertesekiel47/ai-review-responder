'use client';

import { useCallback, useEffect, useState } from 'react';

type ChannelEnrollment = {
  channel: string;
  handle: string | null;
  status: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed';
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
};

type StartResponse = { deepLink: string; qrDataUrl: string; expiresAt: string };

type WidgetState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'awaiting_scan'; deepLink: string; qrDataUrl: string; expiresAt: string }
  | { kind: 'verified'; maskedHandle: string }
  | { kind: 'disabled' }
  | { kind: 'unsubscribed'; reason: string | null }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

function maskChatId(chatId: string): string {
  if (chatId.length <= 4) return '•••';
  return `••• ${chatId.slice(-4)}`;
}

// Three-way result so callers can distinguish "no telegram enrollment"
// from "session expired / server error" (M5). Previously any non-OK
// response collapsed into `null` and silently reset the widget to idle.
type FetchResult =
  | { kind: 'ok'; enrollment: ChannelEnrollment | null }
  | { kind: 'auth_expired' }
  | { kind: 'error'; status: number };

async function fetchTelegramEnrollment(
  businessId: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  try {
    const res = await fetch(`/api/admin/businesses/${businessId}/channels`, { signal });
    if (res.status === 401 || res.status === 403) return { kind: 'auth_expired' };
    if (!res.ok) return { kind: 'error', status: res.status };
    const data = await res.json() as { enrollments: ChannelEnrollment[] };
    return { kind: 'ok', enrollment: data.enrollments.find((e) => e.channel === 'telegram') ?? null };
  } catch (err) {
    // AbortError is expected on unmount — map to a no-op status so callers
    // can ignore it. Other transient errors reuse the existing error shape.
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      return { kind: 'error', status: 0 };
    }
    console.warn('[TelegramEnrollmentWidget] fetch failed:', err);
    return { kind: 'error', status: 0 };
  }
}

export function TelegramEnrollmentWidget({ businessId }: { businessId: string }) {
  const [state, setState] = useState<WidgetState>({ kind: 'idle' });
  const [, setEnrollment] = useState<ChannelEnrollment | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchTelegramEnrollment(businessId, signal);
    if (signal?.aborted) return;
    if (result.kind === 'auth_expired') {
      setState({ kind: 'error', message: 'Session expired — please reload the page.' });
      return;
    }
    if (result.kind === 'error') {
      // status=0 indicates AbortError or network failure — do not surface,
      // the next interaction will retry.
      if (result.status === 0) return;
      setState({ kind: 'error', message: `Could not load Telegram enrollment (${result.status}).` });
      return;
    }
    const e = result.enrollment;
    setEnrollment(e);
    if (!e) { setState({ kind: 'idle' }); return; }
    if (e.status === 'verified') {
      setState({ kind: 'verified', maskedHandle: e.handle ? maskChatId(e.handle) : '•••' });
    } else if (e.status === 'disabled') {
      setState({ kind: 'disabled' });
    } else if (e.status === 'unsubscribed') {
      setState({ kind: 'unsubscribed', reason: e.unsubscribed_reason });
    }
  }, [businessId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // Poll every 3s while awaiting scan
  useEffect(() => {
    if (state.kind !== 'awaiting_scan') return;
    const controller = new AbortController();
    const interval = setInterval(async () => {
      const result = await fetchTelegramEnrollment(businessId, controller.signal);
      // During polling, ignore transient errors — the manual "Refresh
      // status" button will surface them and the QR countdown handles
      // expiry independently.
      if (result.kind !== 'ok') return;
      const e = result.enrollment;
      if (e?.status === 'verified') {
        setEnrollment(e);
        setState({ kind: 'verified', maskedHandle: e.handle ? maskChatId(e.handle) : '•••' });
      }
    }, 3000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [state.kind, businessId]);

  // Expire the QR when TTL elapses
  useEffect(() => {
    if (state.kind !== 'awaiting_scan') return;
    const ms = new Date(state.expiresAt).getTime() - Date.now();
    if (ms <= 0) { setState({ kind: 'expired' }); return; }
    const t = setTimeout(() => setState({ kind: 'expired' }), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind === 'awaiting_scan' ? state.expiresAt : null]);

  const onConnect = async () => {
    setState({ kind: 'generating' });
    const res = await fetch('/api/admin/channels/telegram/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId }),
    });
    if (res.status === 409) {
      setState({ kind: 'error', message: 'Telegram is already connected. Disable it first to re-enroll.' });
      return;
    }
    if (!res.ok) {
      setState({ kind: 'error', message: `Server returned ${res.status}` });
      return;
    }
    const data = (await res.json()) as StartResponse;
    setState({ kind: 'awaiting_scan', deepLink: data.deepLink, qrDataUrl: data.qrDataUrl, expiresAt: data.expiresAt });
  };

  const onCancel = async () => {
    await fetch('/api/admin/channels/telegram/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId }),
    });
    await refresh();
  };

  const onDisable = async () => {
    if (!confirm('Disable Telegram notifications for this business?')) return;
    await fetch('/api/admin/channels/telegram/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessId }),
    });
    await refresh();
  };

  return (
    <div className="telegram-enrollment-widget border rounded-md p-4 bg-white">
      <h3 className="font-medium mb-2">Telegram</h3>
      {state.kind === 'idle' && (
        <button onClick={onConnect} className="px-3 py-1.5 bg-blue-600 text-white rounded">Connect</button>
      )}
      {state.kind === 'generating' && <p>Generating link…</p>}
      {state.kind === 'awaiting_scan' && (
        <div>
          <p className="text-sm mb-2">Scan the QR with Telegram or share this link. The owner taps Start to verify.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.qrDataUrl} alt="Telegram deep link QR" width={256} height={256} />
          <p className="mt-2"><a href={state.deepLink} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{state.deepLink}</a></p>
          <p className="text-xs text-gray-500 mt-1">Expires {new Date(state.expiresAt).toLocaleTimeString()}</p>
          <button onClick={onCancel} className="mt-3 px-3 py-1 border rounded">Cancel</button>
          <button onClick={() => refresh()} className="mt-3 ml-2 px-3 py-1 border rounded">Refresh status</button>
        </div>
      )}
      {state.kind === 'verified' && (
        <div>
          <p className="text-sm text-green-700">✅ Connected — Telegram chat {state.maskedHandle}</p>
          <button onClick={onDisable} className="mt-2 px-3 py-1 border rounded text-red-600">Disable</button>
        </div>
      )}
      {state.kind === 'disabled' && (
        <div>
          <p className="text-sm text-gray-600">Disabled</p>
          <button onClick={onConnect} className="mt-2 px-3 py-1 border rounded">Reconnect</button>
        </div>
      )}
      {state.kind === 'unsubscribed' && (
        <div>
          <p className="text-sm text-orange-600">Unsubscribed ({state.reason ?? 'unknown'})</p>
          <button onClick={onConnect} className="mt-2 px-3 py-1 border rounded">Re-enroll</button>
        </div>
      )}
      {state.kind === 'expired' && (
        <div>
          <p className="text-sm text-gray-600">Verification link expired.</p>
          <button onClick={onConnect} className="mt-2 px-3 py-1 border rounded">Generate new link</button>
        </div>
      )}
      {state.kind === 'error' && (
        <div>
          <p className="text-sm text-red-600">{state.message}</p>
          <button onClick={() => setState({ kind: 'idle' })} className="mt-2 px-3 py-1 border rounded">Back</button>
        </div>
      )}
    </div>
  );
}
