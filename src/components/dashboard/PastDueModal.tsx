'use client';

import { useEffect, useMemo, useState } from 'react';

interface PastDueModalProps {
  accountId: string;
  daysRemaining: number | null;
  isReadOnly: boolean;
  deadline: string | null;
}

export function PastDueModal({
  accountId,
  daysRemaining,
  isReadOnly,
  deadline,
}: PastDueModalProps) {
  const [dismissed, setDismissed] = useState(true);
  const dismissalKey = useMemo(
    () => `rw:past_due_modal:${accountId}:${new Date().toISOString().slice(0, 10)}`,
    [accountId],
  );
  const shouldShow = daysRemaining !== null && daysRemaining <= 2 && !isReadOnly;
  const deadlineCopy = deadline
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(deadline))
    : null;

  useEffect(() => {
    if (!shouldShow) {
      setDismissed(true);
      return;
    }
    setDismissed(window.localStorage.getItem(dismissalKey) === 'dismissed');
  }, [dismissalKey, shouldShow]);

  if (!shouldShow || dismissed) {
    return null;
  }

  function dismiss() {
    window.localStorage.setItem(dismissalKey, 'dismissed');
    setDismissed(true);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="past-due-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(17, 24, 39, 0.42)',
        padding: 16,
      }}
    >
      <div
        style={{
          width: 'min(420px, 100%)',
          borderRadius: 8,
          border: '1px solid #FCD34D',
          background: '#FFFBEB',
          boxShadow: '0 20px 45px rgba(17, 24, 39, 0.18)',
          padding: 20,
        }}
      >
        <h2
          id="past-due-modal-title"
          style={{ margin: 0, fontSize: 18, lineHeight: 1.3, color: '#92400E' }}
        >
          Payment update needed{deadlineCopy ? ` by ${deadlineCopy}` : ''}
        </h2>
        <p style={{ margin: '10px 0 18px', fontSize: 14, lineHeight: 1.5, color: '#78350F' }}>
          Update your payment method to keep approvals, edits, and publishing available.
        </p>
        <button
          type="button"
          aria-label="Dismiss payment reminder"
          className="btn-secondary"
          onClick={dismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
