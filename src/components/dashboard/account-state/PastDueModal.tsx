'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import Link from 'next/link';

interface PastDueModalProps {
  accountId: string;
  daysRemaining: number | null;
  isReadOnly: boolean;
  deadline: string | null;
}

const PAST_DUE_DEADLINE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// Full-screen dimmed overlay for the native <dialog> (UA defaults neutralized).
const PAST_DUE_DIALOG_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--rw-overlay)',
  padding: 16,
  border: 'none',
  maxWidth: 'none',
  maxHeight: 'none',
  width: '100%',
  height: '100%',
  margin: 0,
};

export function PastDueModal({
  accountId,
  daysRemaining,
  isReadOnly,
  deadline,
}: PastDueModalProps) {
  const dismissalKey = `rw:past_due_modal:${accountId}:${new Date().toISOString().slice(0, 10)}`;
  const shouldShow = daysRemaining !== null && daysRemaining <= 2 && !isReadOnly;
  const deadlineCopy = deadline
    ? PAST_DUE_DEADLINE_FORMATTER.format(new Date(deadline))
    : null;

  const persistedDismissed = useSyncExternalStore(
    () => () => {},
    () => window.localStorage.getItem(dismissalKey) === 'dismissed',
    () => true,
  );
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const dismissed = persistedDismissed || sessionDismissed;
  const isOpen = shouldShow && !dismissed;

  const dialogRef = useRef<HTMLDialogElement>(null);

  // Rendered only while open, so this effect runs when the dialog mounts.
  // showModal() promotes it to the top layer and exposes the dialog role.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  function dismiss() {
    window.localStorage.setItem(dismissalKey, 'dismissed');
    setSessionDismissed(true);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="past-due-modal-title"
      // ESC is intentionally inert: this reminder has no dismiss-on-Escape
      // path, only the explicit Dismiss button. preventDefault keeps the
      // native dialog from auto-closing on ESC.
      onCancel={(event) => event.preventDefault()}
      style={PAST_DUE_DIALOG_STYLE}
    >
      <div
        style={{
          width: 'min(420px, 100%)',
          borderRadius: 8,
          border: '1px solid var(--rw-blush)',
          background: 'var(--rw-blush-soft)',
          boxShadow: 'var(--rw-shadow-pop)',
          padding: 20,
        }}
      >
        <h2
          id="past-due-modal-title"
          style={{ margin: 0, fontSize: 18, lineHeight: 1.3, color: 'var(--rw-blush-deep)' }}
        >
          Payment update needed{deadlineCopy ? ` by ${deadlineCopy}` : ''}
        </h2>
        <p style={{ margin: '10px 0 18px', fontSize: 14, lineHeight: 1.5, color: 'var(--rw-app-text)' }}>
          Update your payment method to keep approvals, edits, and publishing available.
        </p>
        <Link
          href="/help/contact"
          style={{ display: 'inline-block', marginBottom: 16, fontSize: 14, color: 'var(--rw-sage-deep)' }}
        >
          Contact support
        </Link>
        <br />
        <button
          type="button"
          aria-label="Dismiss payment reminder"
          className="btn-secondary"
          onClick={dismiss}
        >
          Dismiss
        </button>
      </div>
    </dialog>
  );
}
