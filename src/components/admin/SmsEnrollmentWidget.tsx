'use client';

import { useCallback, useEffect, useState } from 'react';

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
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [awaitingOptIn, setAwaitingOptIn] = useState(false);
  const [phoneInput, setPhoneInput] = useState('+1');
  const [codeInput, setCodeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async (): Promise<EnrollmentState | null> => {
    const res = await fetch(`/api/admin/channels/sms/status?business_id=${businessId}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { enrollment: EnrollmentState | null };
    setEnrollment(json.enrollment);
    return json.enrollment;
  }, [businessId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Poll every 3s while awaiting START — stop once sender_opt_in_cleared flips to true.
  useEffect(() => {
    if (!awaitingOptIn) return;
    if (enrollment?.sender_opt_in_cleared) return;
    const interval = setInterval(() => {
      void loadStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [awaitingOptIn, enrollment?.sender_opt_in_cleared, loadStatus]);

  const state = deriveState(enrollment, awaitingOptIn);

  const call = useCallback(async (path: string, body: unknown): Promise<unknown | null> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/channels/sms/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; reason?: string };
      if (!res.ok) {
        setError(json.reason ?? `HTTP ${res.status}`);
        return null;
      }
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network_error');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  async function onSendCode() {
    const body = state.kind === 'empty' ? { business_id: businessId, phone: phoneInput } : { business_id: businessId };
    if (await call('verify', body)) await loadStatus();
  }

  async function onConfirm() {
    if (await call('confirm', { business_id: businessId, code: codeInput })) {
      setCodeInput('');
      setAwaitingOptIn(false);
      await loadStatus();
    }
  }

  async function onCancel() {
    await call('cancel', { business_id: businessId });
    setCodeInput('');
    setAwaitingOptIn(false);
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
    setAwaitingOptIn(false);
    await loadStatus();
  }

  // Render branches
  return (
    <div className="sms-enrollment-widget" style={{ padding: '1rem', border: '1px solid #ddd', borderRadius: '0.5rem' }}>
      <h4 style={{ marginTop: 0 }}>SMS</h4>

      {state.kind === 'empty' && (
        <div>
          <label>
            Phone (US, E.164){' '}
            <input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="+1 415 555 2671"
              disabled={busy}
            />
          </label>
          <button onClick={onSendCode} disabled={busy}>
            Send code
          </button>
        </div>
      )}

      {state.kind === 'sent' && (
        <div>
          <p>Code sent to {state.maskedPhone}. Ask the owner to read it back.</p>
          <label>
            6-digit code{' '}
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="123456"
              disabled={busy}
            />
          </label>
          <button onClick={onConfirm} disabled={busy}>
            Verify
          </button>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      {state.kind === 'verified' && (
        <div>
          <p>✅ SMS verified: {state.maskedPhone}</p>
          <button onClick={onDisable} disabled={busy}>
            Disable
          </button>
          <button onClick={onDelete} disabled={busy}>
            Delete enrollment
          </button>
        </div>
      )}

      {state.kind === 'disabled' && (
        <div>
          <p>⛔ SMS disabled: {state.maskedPhone}</p>
          <button onClick={onSendCode} disabled={busy}>
            Re-enable — send code to {state.maskedPhone}
          </button>
          <button onClick={onDelete} disabled={busy}>
            Delete enrollment
          </button>
        </div>
      )}

      {state.kind === 'unsubscribed' && (
        <div>
          <p>
            🚫 SMS unsubscribed: {state.maskedPhone}
            {state.reason ? ` (${state.reason})` : ''}
          </p>
          <button onClick={() => setAwaitingOptIn(true)} disabled={busy}>
            Start re-enable
          </button>
          <button onClick={onDelete} disabled={busy}>
            Delete enrollment
          </button>
        </div>
      )}

      {state.kind === 'awaiting_sender_opt_in' && (
        <div>
          <p>
            Ask the owner at {state.maskedPhone} to text <strong>START</strong> to our RepWorth number. We&rsquo;ll
            detect it automatically.
          </p>
          <button onClick={() => setAwaitingOptIn(false)} disabled={busy}>
            Cancel waiting
          </button>
        </div>
      )}

      {state.kind === 'opt_in_received' && (
        <div>
          <p>✅ Opt-in detected for {state.maskedPhone}. Send the verification code now.</p>
          <button
            onClick={async () => {
              await onSendCode();
              setAwaitingOptIn(false);
            }}
            disabled={busy}
          >
            Send verification code
          </button>
          <button onClick={() => setAwaitingOptIn(false)} disabled={busy}>
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
