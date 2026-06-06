'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';

type OffboardingStatusResponse = {
  enabled: boolean;
  activeOffboarding: ActiveOffboarding | null;
};

type ActiveOffboarding = {
  id: string;
  mode: string;
  status: string;
  accessEndsAt?: string | Date | null;
};

type ReasonCode = 'too_expensive' | 'missing_features' | 'switched_service' | 'unused' | 'other';

const REASON_OPTIONS: Array<{ value: ReasonCode; label: string }> = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'missing_features', label: 'Missing features' },
  { value: 'switched_service', label: 'Switched service' },
  { value: 'unused', label: 'Not using it enough' },
  { value: 'other', label: 'Other' },
];

interface AccountOffboardingPanelProps {
  accountTimeZone?: string | null;
  onAccountRefetch: () => void;
}

export function AccountOffboardingPanel({
  accountTimeZone,
  onAccountRefetch,
}: AccountOffboardingPanelProps) {
  const [statusResponse, setStatusResponse] = useState<OffboardingStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    idempotencyKey: string;
    reasonCode: ReasonCode | null;
    submitting: boolean;
    error: string | null;
  } | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const res = await fetch('/api/account/offboarding/status');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail ?? body.error ?? 'Unable to load cancellation status');
        }
        const body = await res.json() as OffboardingStatusResponse;
        if (!cancelled) setStatusResponse(body);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Unable to load cancellation status');
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
        <div style={{ fontSize: 13, color: '#B91C1C' }}>{loadError}</div>
      </div>
    );
  }

  if (!statusResponse?.enabled) return null;

  const active = statusResponse.activeOffboarding;
  const isScheduledCancelOnly = active?.mode === 'cancel_only' && active.status === 'scheduled';
  const isPendingCancelOnly = active?.mode === 'cancel_only' && active.status === 'pending';
  const accessEndLabel = isScheduledCancelOnly
    ? formatAccessEnd(active.accessEndsAt, accountTimeZone)
    : null;

  function openConfirmModal() {
    setConfirmState({
      idempotencyKey: createIdempotencyKey(),
      reasonCode: null,
      submitting: false,
      error: null,
    });
  }

  async function confirmCancellation() {
    if (!confirmState) return;
    setConfirmState({ ...confirmState, submitting: true, error: null });

    try {
      const res = await fetch('/api/account/offboarding/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': confirmState.idempotencyKey,
        },
        body: JSON.stringify({
          mode: 'cancel_only',
          ...(confirmState.reasonCode ? { reasonCode: confirmState.reasonCode } : {}),
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.detail ?? body.error ?? 'Unable to schedule cancellation');
      }

      setStatusResponse({
        enabled: true,
        activeOffboarding: body.offboarding ?? { id: 'pending', mode: 'cancel_only', status: 'pending' },
      });
      setConfirmState(null);
      onAccountRefetch();
    } catch (err) {
      setConfirmState((current) => current
        ? {
          ...current,
          submitting: false,
          error: err instanceof Error ? err.message : 'Unable to schedule cancellation',
        }
        : current);
    }
  }

  async function reactivate() {
    setReactivating(true);
    setReactivateError(null);

    try {
      const res = await fetch('/api/account/offboarding/reactivate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': createIdempotencyKey(),
        },
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.detail ?? body.error ?? 'Unable to reactivate subscription');
      }

      setStatusResponse({ enabled: true, activeOffboarding: null });
      onAccountRefetch();
    } catch (err) {
      setReactivateError(err instanceof Error ? err.message : 'Unable to reactivate subscription');
    } finally {
      setReactivating(false);
    }
  }

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon amber">
          <Icon name="alert" size={18} />
        </div>
        <div>
          <div className="set-section-title">Cancel RepWorth</div>
          <div className="set-section-sub">
            Schedule cancellation for the end of your current paid period.
          </div>
        </div>
      </div>

      {isScheduledCancelOnly ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
            Access stays active until {accessEndLabel}. You can keep your subscription active before that time.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void reactivate()}
              disabled={reactivating}
            >
              {reactivating ? 'Reactivating…' : 'Keep subscription active'}
            </button>
            {reactivateError && (
              <span style={{ fontSize: 12, color: '#DC2626' }}>{reactivateError}</span>
            )}
          </div>
        </div>
      ) : isPendingCancelOnly ? (
        <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
          Cancellation is being scheduled with Stripe. Your account remains active while we confirm the paid-through date.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0 }}>
            You keep full access through the paid-through period. At the end, RepWorth stops processing reviews and keeps your account data retained.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ alignSelf: 'flex-start' }}
            onClick={openConfirmModal}
          >
            Cancel subscription
          </button>
        </div>
      )}

      {confirmState && (
        <SettingsModal
          title="Cancel subscription"
          closeLabel="Close cancellation dialog"
          onClose={() => {
            if (!confirmState.submitting) setConfirmState(null);
          }}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Cancel at period end?
          </div>
          <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.5, marginBottom: 12 }}>
            You keep normal access until the paid-through date from Stripe. You can reactivate before access ends.
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
            <legend style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
              Main reason
            </legend>
            <div style={{ display: 'grid', gap: 6 }}>
              {REASON_OPTIONS.map((option) => (
                <label key={option.value} style={{ display: 'flex', gap: 8, fontSize: 13, color: '#374151' }}>
                  <input
                    type="radio"
                    name="offboarding-reason"
                    value={option.value}
                    checked={confirmState.reasonCode === option.value}
                    onChange={() => setConfirmState({ ...confirmState, reasonCode: option.value })}
                    disabled={confirmState.submitting}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          {confirmState.error && (
            <div style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>
              {confirmState.error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmState(null)}
              disabled={confirmState.submitting}
            >
              Keep account
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void confirmCancellation()}
              disabled={confirmState.submitting}
            >
              {confirmState.submitting ? 'Scheduling…' : 'Confirm cancellation'}
            </button>
          </div>
        </SettingsModal>
      )}
    </div>
  );
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `offboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatAccessEnd(value: string | Date | null | undefined, timeZone?: string | null): string {
  if (!value) return 'the paid-through date';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the paid-through date';

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timeZone || 'UTC',
    timeZoneName: 'short',
  }).format(date);
}
