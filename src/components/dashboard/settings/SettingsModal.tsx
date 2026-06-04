'use client';

import { useEffect, useRef, type ReactNode } from 'react';

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
 * button plus a labelled native `<dialog>` content box. Owns the keyboard-dismiss
 * contract (Escape) so every settings modal behaves the same. Full focus
 * trap/restore is intentionally out of scope for now.
 */
export function SettingsModal({ title, closeLabel, onClose, children }: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // The component is mounted only while open, so mount = open. showModal() puts
  // the element into the top layer and exposes the implicit dialog role.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  // Escape stays on the document keydown listener (the single authoritative
  // close path). onCancel below suppresses the native ESC auto-close so this
  // listener is not double-invoked in a real browser.
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
      <dialog
        ref={dialogRef}
        className="modal-content"
        aria-modal="true"
        aria-label={title}
        onCancel={(event) => event.preventDefault()}
      >
        {children}
      </dialog>
    </div>
  );
}
