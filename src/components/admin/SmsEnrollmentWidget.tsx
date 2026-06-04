'use client';

import { useCallback, useEffect, useReducer } from 'react';

interface EnrollmentState {
  status: 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed';
  handle: string;
  verified_at: string | null;
  disabled_at: string | null;
  unsubscribed_at: string | null;
  unsubscribed_reason: string | null;
  archived_at: string | null;
  sender_opt_in_cleared: boolean;
}

type WidgetState =
  | { kind: 'empty' }
  | { kind: 'sent'; maskedPhone: string }
  | { kind: 'verified'; maskedPhone: string }
  | { kind: 'disabled'; maskedPhone: string }
  | { kind: 'unsubscribed'; maskedPhone: string; reason: string | null }
  | { kind: 'awaiting_sender_opt_in'; maskedPhone: string }
  | { kind: 'opt_in_received'; maskedPhone: string };

function maskPhoneForDisplay(e164: string): string {
  const rest = e164.replace(/^\+1/, '');
  if (rest.length !== 10) return e164;
  return `+1 ${rest.slice(0, 3)}-XXX-${rest.slice(6)}`;
}

interface WidgetReducerState {
  enrollment: EnrollmentState | null;
  awaitingOptIn: boolean;
  phoneInput: string;
  codeInput: string;
  busy: boolean;
  error: string | null;
}

const initialWidgetState: WidgetReducerState = {
  enrollment: null,
  awaitingOptIn: false,
  phoneInput: '+1',
  codeInput: '',
  busy: false,
  error: null,
};

type WidgetAction =
  | { type: 'setEnrollment'; enrollment: EnrollmentState | null }
  | { type: 'setAwaitingOptIn'; awaitingOptIn: boolean }
  | { type: 'setPhoneInput'; phoneInput: string }
  | { type: 'setCodeInput'; codeInput: string }
  | { type: 'callStart' }
  | { type: 'callError'; error: string | null }
  | { type: 'callFinish' };

function widgetReducer(state: WidgetReducerState, action: WidgetAction): WidgetReducerState {
  switch (action.type) {
    case 'setEnrollment':
      return { ...state, enrollment: action.enrollment };
    case 'setAwaitingOptIn':
      return { ...state, awaitingOptIn: action.awaitingOptIn };
    case 'setPhoneInput':
      return { ...state, phoneInput: action.phoneInput };
    case 'setCodeInput':
      return { ...state, codeInput: action.codeInput };
    case 'callStart':
      return { ...state, busy: true, error: null };
    case 'callError':
      return { ...state, error: action.error };
    case 'callFinish':
      return { ...state, busy: false };
  }
}

function deriveState(enrollment: EnrollmentState | null, awaitingOptIn: boolean): WidgetState {
  if (!enrollment) return { kind: 'empty' };
  const maskedPhone = maskPhoneForDisplay(enrollment.handle);
  if (enrollment.status === 'pending_verification') return { kind: 'sent', maskedPhone };
  if (enrollment.status === 'verified') return { kind: 'verified', maskedPhone };
  if (enrollment.status === 'disabled') return { kind: 'disabled', maskedPhone };
  // unsubscribed — UI-local awaitingOptIn + derived sender_opt_in_cleared decide presentation
  if (awaitingOptIn) {
    return enrollment.sender_opt_in_cleared
      ? { kind: 'opt_in_received', maskedPhone }
      : { kind: 'awaiting_sender_opt_in', maskedPhone };
  }
  return { kind: 'unsubscribed', maskedPhone, reason: enrollment.unsubscribed_reason };
}

export function SmsEnrollmentWidget({ businessId }: { businessId: string }) {
  const [state, dispatch] = useReducer(widgetReducer, initialWidgetState);
  const { enrollment, awaitingOptIn, phoneInput, codeInput, busy, error } = state;

  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<EnrollmentState | null> => {
    try {
      const res = await fetch(`/api/admin/channels/sms/status?business_id=${businessId}`, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { enrollment: EnrollmentState | null };
      if (signal?.aborted) return null;
      dispatch({ type: 'setEnrollment', enrollment: json.enrollment });
      return json.enrollment;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return null;
      // Transient network errors shouldn't break the widget — the next tick
      // of the polling interval (or a user action) will try again.
      console.warn('[SmsEnrollmentWidget] loadStatus failed:', err);
      return null;
    }
  }, [businessId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  // Poll every 3s while awaiting START — stop once sender_opt_in_cleared flips to true.
  useEffect(() => {
    if (!awaitingOptIn) return;
    if (enrollment?.sender_opt_in_cleared) return;
    const controller = new AbortController();
    const interval = setInterval(() => {
      void loadStatus(controller.signal);
    }, 3000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [awaitingOptIn, enrollment?.sender_opt_in_cleared, loadStatus]);

  const widgetState = deriveState(enrollment, awaitingOptIn);

  const call = useCallback(async (path: string, body: unknown): Promise<unknown | null> => {
    dispatch({ type: 'callStart' });
    try {
      const res = await fetch(`/api/admin/channels/sms/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok) {
        dispatch({ type: 'callError', error: json.reason ?? `HTTP ${res.status}` });
        return null;
      }
      return json;
    } catch (err) {
      dispatch({ type: 'callError', error: err instanceof Error ? err.message : 'network_error' });
      return null;
    } finally {
      dispatch({ type: 'callFinish' });
    }
  }, []);

  async function onSendCode() {
    const body = widgetState.kind === 'empty' ? { business_id: businessId, phone: phoneInput } : { business_id: businessId };
    if (await call('verify', body)) await loadStatus();
  }

  async function onConfirm() {
    if (await call('confirm', { business_id: businessId, code: codeInput })) {
      dispatch({ type: 'setCodeInput', codeInput: '' });
      dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: false });
      await loadStatus();
    }
  }

  async function onCancel() {
    await call('cancel', { business_id: businessId });
    dispatch({ type: 'setCodeInput', codeInput: '' });
    dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: false });
    await loadStatus();
  }

  async function onDisable() {
    await call('disable', { business_id: businessId });
    await loadStatus();
  }

  async function onDelete() {
    const ok = window.confirm(
      'This soft-deletes the enrollment while preserving audit history. A new enrollment can then be created with a different phone number. Continue?'
    );
    if (!ok) return;
    await call('delete', { business_id: businessId, confirm: true });
    dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: false });
    await loadStatus();
  }

  // Render branches
  return (
    <div className="sms-enrollment-widget" style={{ padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem' }}>
      <h4 style={{ marginTop: 0 }}>SMS</h4>

      {widgetState.kind === 'empty' && (
        <div>
          <label>
            Phone (US, E.164){' '}
            <input
              value={phoneInput}
              onChange={(e) => dispatch({ type: 'setPhoneInput', phoneInput: e.target.value })}
              placeholder="+1 415 555 2671"
              disabled={busy}
            />
          </label>
          <button type="button" onClick={onSendCode} disabled={busy}>
            Send code
          </button>
        </div>
      )}

      {widgetState.kind === 'sent' && (
        <div>
          <p>Code sent to {widgetState.maskedPhone}. Ask the owner to read it back.</p>
          <label>
            6-digit code{' '}
            <input
              value={codeInput}
              onChange={(e) => dispatch({ type: 'setCodeInput', codeInput: e.target.value })}
              placeholder="123456"
              disabled={busy}
            />
          </label>
          <button type="button" onClick={onConfirm} disabled={busy}>
            Verify
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {widgetState.kind === 'verified' && (
        <div>
          <p>✅ SMS verified: {widgetState.maskedPhone}</p>
          <button type="button" onClick={onDisable} disabled={busy}>
            Disable
          </button>
          <button type="button" onClick={onDelete} disabled={busy}>
            Delete enrollment
          </button>
        </div>
      )}

      {widgetState.kind === 'disabled' && (
        <div>
          <p>⛔ SMS disabled: {widgetState.maskedPhone}</p>
          <button type="button" onClick={onSendCode} disabled={busy}>
            Re-enable: send code to {widgetState.maskedPhone}
          </button>
          <button type="button" onClick={onDelete} disabled={busy}>
            Delete enrollment
          </button>
        </div>
      )}

      {widgetState.kind === 'unsubscribed' && (
        <div>
          <p>
            🚫 SMS unsubscribed: {widgetState.maskedPhone}
            {widgetState.reason ? ` (${widgetState.reason})` : ''}
          </p>
          <button type="button" onClick={() => dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: true })} disabled={busy}>
            Start re-enable
          </button>
          <button type="button" onClick={onDelete} disabled={busy}>
            Delete enrollment
          </button>
        </div>
      )}

      {widgetState.kind === 'awaiting_sender_opt_in' && (
        <div>
          <p>
            Ask the owner at {widgetState.maskedPhone} to text <strong>START</strong> to our RepWorth number. We&rsquo;ll
            detect it automatically.
          </p>
          <button type="button" onClick={() => dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: false })} disabled={busy}>
            Cancel waiting
          </button>
        </div>
      )}

      {widgetState.kind === 'opt_in_received' && (
        <div>
          <p>✅ Opt-in detected for {widgetState.maskedPhone}. Send the verification code now.</p>
          <button type="button"
            onClick={async () => {
              await onSendCode();
              dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: false });
            }}
            disabled={busy}
          >
            Send verification code
          </button>
          <button type="button" onClick={() => dispatch({ type: 'setAwaitingOptIn', awaitingOptIn: false })} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p style={{ color: 'red' }} role="alert">
          Error: {error}
        </p>
      )}
    </div>
  );
}
