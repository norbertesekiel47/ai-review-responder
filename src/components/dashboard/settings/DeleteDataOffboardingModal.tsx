'use client';

import { useState } from 'react';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { apiErrorMessage, readJsonObject, type JsonObject } from '@/lib/client-response';

type ReasonCode = 'too_expensive' | 'missing_features' | 'switched_service' | 'unused' | 'other';

const REASON_OPTIONS: Array<{ value: ReasonCode; label: string }> = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'missing_features', label: 'Missing features' },
  { value: 'switched_service', label: 'Switched service' },
  { value: 'unused', label: 'Not using it enough' },
  { value: 'other', label: 'Other' },
];

interface DeleteDataOffboardingModalProps {
  idempotencyKey: string;
  onClose: () => void;
  onConfirmed: (offboarding: { id: string; mode: string; status: string }) => void;
}

function readConfirmedOffboarding(body: JsonObject): { id: string; mode: string; status: string } | null {
  const value = body.offboarding;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as JsonObject;
  if (typeof record.id !== 'string' || typeof record.mode !== 'string' || typeof record.status !== 'string') {
    return null;
  }
  return { id: record.id, mode: record.mode, status: record.status };
}

export function DeleteDataOffboardingModal({
  idempotencyKey,
  onClose,
  onConfirmed,
// Three of the five states are independent controlled inputs; per-field useState is clearer than a reducer for this small deletion-confirmation form.
// react-doctor-disable-next-line react-doctor/prefer-useReducer
}: DeleteDataOffboardingModalProps) {
  const [password, setPassword] = useState('');
  const [reasonCode, setReasonCode] = useState<ReasonCode | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = Boolean(password) && Boolean(reasonCode) && confirmationText === 'DELETE DATA';

  async function submit() {
    if (!canSubmit || !reasonCode) return;
    setSubmitting(true);
    setError(null);

    try {
      const freshAuth = await fetch('/api/account/offboarding/fresh-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!freshAuth.ok) {
        const freshBody = await readJsonObject(freshAuth);
        throw new Error(apiErrorMessage(freshBody, 'Unable to verify password', freshAuth.status));
      }

      const confirm = await fetch('/api/account/offboarding/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          mode: 'delete_data',
          reasonCode,
          confirmationText: 'DELETE DATA',
        }),
      });
      if (!confirm.ok) {
        const confirmBody = await readJsonObject(confirm);
        throw new Error(apiErrorMessage(confirmBody, 'Unable to request data deletion', confirm.status));
      }

      const confirmBody = await readJsonObject(confirm);
      onConfirmed(
        readConfirmedOffboarding(confirmBody)
          ?? { id: 'pending', mode: 'delete_data', status: 'pending' },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to request data deletion');
      setSubmitting(false);
    }
  }

  return (
    <SettingsModal
      title="Delete data"
      closeLabel="Close delete data dialog"
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="set-section-title" style={{ marginBottom: 8 }}>
        Delete RepWorth data?
      </div>
      <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
        <p className="settings-body-copy">
          This stops review processing immediately.
        </p>
        <p className="settings-body-copy">
          RepWorth cancels billing and disconnects Google publishing before deletion.
        </p>
        <p className="settings-body-copy">
          Data enters a 30-day deletion window. During that window, you can keep your data but product access is not restored.
        </p>
        <p className="settings-body-copy">
          We retain records we are legally required to keep, including billing, audit, security, and abuse-prevention records.
        </p>
        <p className="settings-body-copy">
          The current billing period is forfeited and non-refundable.
        </p>
        <p className="settings-body-copy">
          There is no self-serve export. Contact support before deleting data if you need records.
        </p>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend style={{ fontSize: 13, fontWeight: 600, color: 'var(--rw-app-text)', marginBottom: 8 }}>
          Main reason
        </legend>
        <div style={{ display: 'grid', gap: 6 }}>
          {REASON_OPTIONS.map((option) => (
            <label key={option.value} style={{ display: 'flex', gap: 8, fontSize: 13, color: 'var(--rw-app-text)' }}>
              <input
                type="radio"
                name="delete-data-reason"
                value={option.value}
                checked={reasonCode === option.value}
                onChange={() => setReasonCode(option.value)}
                disabled={submitting}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label style={{ display: 'grid', gap: 6, fontSize: 13, color: 'var(--rw-app-text)', marginBottom: 12 }}>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          className="set-input"
        />
      </label>

      <label style={{ display: 'grid', gap: 6, fontSize: 13, color: 'var(--rw-app-text)', marginBottom: 12 }}>
        Type DELETE DATA
        <input
          type="text"
          value={confirmationText}
          onChange={(event) => setConfirmationText(event.target.value)}
          disabled={submitting}
          className="set-input"
        />
      </label>

      {error && (
        <div className="settings-error-copy settings-error-copy--compact settings-error-copy--modal">
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={submitting}
        >
          Keep account
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void submit()}
          disabled={submitting || !canSubmit}
        >
          {submitting ? 'Deleting…' : 'Confirm delete data'}
        </button>
      </div>
    </SettingsModal>
  );
}
