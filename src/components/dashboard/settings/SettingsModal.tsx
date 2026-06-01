'use client';

import { useEffect, type ReactNode } from 'react';

interface SettingsModalProps {
  /** Accessible name for the dialog, announced when focus enters it. */
  title: string;
  /** Accessible label for the dismiss backdrop button. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Shared scaffold for settings confirmation dialogs: a click-to-dismiss backdrop
 * button plus a labelled `role="dialog"` content box. Owns the keyboard-dismiss
 * contract (Escape) so every settings modal behaves the same. Full focus
 * trap/restore is intentionally out of scope for now.
 */
export function SettingsModal({ title, closeLabel, onClose, children }: SettingsModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={title}>
        {children}
      </div>
    </div>
  );
}
