'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface SettingsModalProps {
  /** Accessible name for the dialog, announced when focus enters it. */
  title: string;
  /** Accessible label for the dismiss backdrop button. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Shared scaffold for settings confirmation dialogs. The native `<dialog>` is
 * the full-viewport interaction surface, so its backdrop remains clickable after
 * showModal() makes the rest of the document inert.
 */
export function SettingsModal({ title, closeLabel, onClose, children }: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();

  // The component is mounted only while open, so mount = open. showModal() puts
  // the element into the top layer and exposes the implicit dialog role.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  // Dismissal listeners are attached to the dialog node imperatively: the
  // backdrop click is a pointer-only redundancy of the native Escape path
  // (`cancel`), not the element's interactive affordance — keyboard and
  // screen-reader users dismiss via Escape or the dialog's own buttons.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClick = (event: globalThis.MouseEvent) => {
      if (event.target === dialog) onClose();
    };
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('click', handleClick);
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('click', handleClick);
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-modal="true"
      aria-label={title}
      aria-describedby={descriptionId}
    >
      <div className="modal-content">
        <span id={descriptionId} className="sr-only">{closeLabel}. Press Escape to close.</span>
        {children}
      </div>
    </dialog>
  );
}
