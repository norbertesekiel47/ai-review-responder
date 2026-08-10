'use client';

import { useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { useOffboardingStatus } from '@/hooks/useOffboardingStatus';
import { DeleteDataOffboardingModal } from '@/components/dashboard/settings/DeleteDataOffboardingModal';

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `offboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DeleteDataPanel() {
  const { status, loadError, setStatus } = useOffboardingStatus();
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  if (loadError) {
    return (
      <div className="set-section set-section--error">
        <div className="settings-error-copy">{loadError}</div>
      </div>
    );
  }
  if (!status?.enabled) return null;

  const active = status.activeOffboarding;
  const isDeleting = active?.mode === 'delete_data' || active?.mode === 'purge';
  const isCancelScheduled = active?.mode === 'cancel_only';

  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon amber">
          <Icon name="alert" size={18} />
        </div>
        <div>
          <div className="set-section-title">Danger zone</div>
          <div className="set-section-sub">Permanently delete your RepWorth data.</div>
        </div>
      </div>

      {isDeleting ? (
        <p style={{ fontSize: 13, color: 'var(--rw-app-text)', lineHeight: 1.5, margin: 0 }}>
          Data deletion is in progress. We&apos;ll email you when it completes.
        </p>
      ) : isCancelScheduled ? (
        <p style={{ fontSize: 13, color: 'var(--rw-app-text)', lineHeight: 1.5, margin: 0 }}>
          You have a scheduled cancellation. Reactivate it, or wait until it completes, before deleting data.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 13, color: 'var(--rw-app-text)', lineHeight: 1.5, margin: 0 }}>
            This removes your account data and cannot be undone.
          </p>
          <button
            type="button"
            className="btn btn-danger"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setIdempotencyKey(createIdempotencyKey())}
          >
            Delete data
          </button>
        </div>
      )}

      {idempotencyKey && (
        <DeleteDataOffboardingModal
          idempotencyKey={idempotencyKey}
          onClose={() => setIdempotencyKey(null)}
          onConfirmed={(offboarding) => {
            setStatus({
              enabled: true,
              activeOffboarding: { id: offboarding.id, mode: offboarding.mode, status: offboarding.status },
            });
            setIdempotencyKey(null);
          }}
        />
      )}
    </div>
  );
}
