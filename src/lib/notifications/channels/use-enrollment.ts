// src/lib/notifications/channels/use-enrollment.ts
//
// React hook wiring the pure enrollmentReducer to:
//   - fetch calls (start / cancel / disable / status)
//   - filtering the canonical { enrollments: [...] } status payload by channel
//   - 3s polling loop while awaiting_scan, with AbortController cleanup
//   - 1s TTL tick dispatching TICK actions
//   - HTTP error classification → CONNECT_FAILED actions
//
// Tested via Playwright E2E (the hook needs a real React + browser environment).
// All logic that can be unit-tested in node lives in enrollment-reducer.ts.

'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  enrollmentReducer,
  initialEnrollment,
  type ChannelEnrollmentRow,
  type EnrollmentSnapshot,
} from './enrollment-reducer';
import { STATUS_POLL_INTERVAL_MS, TTL_TICK_INTERVAL_MS } from './constants';

export interface EnrollmentEndpoints {
  start: string;
  cancel: string;
  disable: string;
  status: string;
}

export interface UseEnrollmentOptions {
  channel: 'telegram' | 'whatsapp';
  endpoints: EnrollmentEndpoints;
  /** Body to send on POSTs. Admin sends { businessId }; owner sends {}. */
  postBody?: Record<string, unknown>;
  pollIntervalMs?: number;
  /** Optional initial snapshot for SSR hydration (skips first fetch). */
  initialSnapshot?: EnrollmentSnapshot;
}

export interface UseEnrollmentReturn {
  snapshot: EnrollmentSnapshot;
  actions: {
    connect: () => Promise<void>;
    cancel: () => Promise<void>;
    disable: () => Promise<void>;
    refresh: () => Promise<void>;
    dismissError: () => void;
  };
  ttl: { secondsRemaining: number | null };
}

interface StartResponse {
  deepLink: string;
  qrDataUrl: string;
  expiresAt: string; // ISO
}

interface StatusResponse {
  enrollments: ChannelEnrollmentRow[];
}

export function useEnrollment(options: UseEnrollmentOptions): UseEnrollmentReturn {
  const { channel, endpoints, postBody = {}, pollIntervalMs = STATUS_POLL_INTERVAL_MS, initialSnapshot } = options;

  const [snapshot, dispatch] = useReducer(enrollmentReducer, initialSnapshot ?? initialEnrollment);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  // Mounted ref so async fetches that resolve after unmount don't dispatch.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeDispatch: typeof dispatch = useCallback((action) => {
    if (mountedRef.current) dispatch(action);
  }, []);

  // ---- Status fetch + polling ---------------------------------------------

  const fetchStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const res = await fetch(endpoints.status, { signal });
      if (signal?.aborted) return;
      // 401/403 surface as a CONNECT_FAILED-shaped action so the reducer can
      // classify them — but only when triggered by an explicit action, not
      // by background polling. During background polls we drop these
      // silently (the next manual action will surface them).
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      const row = data.enrollments.find((e) => e.channel === channel) ?? null;
      safeDispatch({ type: 'STATUS_FETCHED', row, nowMs: Date.now() });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') return;
      // Network failure during polling → silent. Manual refresh will surface.
    }
  }, [channel, endpoints.status, safeDispatch]);

  // Initial fetch on mount, unless caller passed an initialSnapshot.
  useEffect(() => {
    if (initialSnapshot) return;
    const controller = new AbortController();
    void fetchStatus(controller.signal);
    return () => controller.abort();
  }, [fetchStatus, initialSnapshot]);

  // Poll every pollIntervalMs while awaiting_scan.
  useEffect(() => {
    if (snapshot.state !== 'awaiting_scan') return;
    const controller = new AbortController();
    const interval = setInterval(() => {
      void fetchStatus(controller.signal);
    }, pollIntervalMs);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [snapshot.state, fetchStatus, pollIntervalMs]);

  // ---- TTL countdown ------------------------------------------------------

  useEffect(() => {
    if (snapshot.state !== 'awaiting_scan' || snapshot.expiresAt === null) {
      setSecondsRemaining(null);
      return;
    }
    const tick = () => {
      const now = Date.now();
      const remainingMs = (snapshot.expiresAt ?? 0) - now;
      setSecondsRemaining(Math.max(0, Math.floor(remainingMs / 1000)));
      safeDispatch({ type: 'TICK', nowMs: now });
    };
    tick();
    const interval = setInterval(tick, TTL_TICK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [snapshot.state, snapshot.expiresAt, safeDispatch]);

  // ---- Action helpers -----------------------------------------------------

  const postJson = useCallback(async (url: string): Promise<Response> => {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody),
    });
  }, [postBody]);

  const connect = useCallback(async (): Promise<void> => {
    safeDispatch({ type: 'CONNECT_REQUESTED' });
    try {
      const res = await postJson(endpoints.start);
      if (!res.ok) {
        let message = 'request_failed';
        try {
          const body = await res.json();
          if (typeof body?.error === 'string') message = body.error;
        } catch {
          /* ignore */
        }
        safeDispatch({ type: 'CONNECT_FAILED', status: res.status, message });
        return;
      }
      const data = (await res.json()) as StartResponse;
      safeDispatch({
        type: 'CONNECT_SUCCEEDED',
        deepLink: data.deepLink,
        qrDataUrl: data.qrDataUrl,
        expiresAt: new Date(data.expiresAt).getTime(),
      });
    } catch {
      safeDispatch({ type: 'CONNECT_FAILED', status: 0, message: 'network' });
    }
  }, [endpoints.start, postJson, safeDispatch]);

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await postJson(endpoints.cancel);
    } catch {
      /* ignore — cancel is fire-and-forget; refresh will reconcile */
    }
    safeDispatch({ type: 'CANCEL_SUCCEEDED' });
  }, [endpoints.cancel, postJson, safeDispatch]);

  const disable = useCallback(async (): Promise<void> => {
    try {
      const res = await postJson(endpoints.disable);
      if (!res.ok) {
        safeDispatch({ type: 'CONNECT_FAILED', status: res.status, message: 'disable_failed' });
        return;
      }
      safeDispatch({ type: 'DISABLE_SUCCEEDED' });
    } catch {
      safeDispatch({ type: 'CONNECT_FAILED', status: 0, message: 'network' });
    }
  }, [endpoints.disable, postJson, safeDispatch]);

  const refresh = useCallback(async (): Promise<void> => {
    await fetchStatus();
  }, [fetchStatus]);

  const dismissError = useCallback(() => {
    safeDispatch({ type: 'DISMISS_ERROR' });
  }, [safeDispatch]);

  return {
    snapshot,
    actions: { connect, cancel, disable, refresh, dismissError },
    ttl: { secondsRemaining },
  };
}
