'use client';

import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';

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

  function handleDialogClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-modal="true"
      aria-label={title}
      aria-describedby={descriptionId}
      onClick={handleDialogClick}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-content">
        <span id={descriptionId} className="sr-only">{closeLabel}. Press Escape to close.</span>
        {children}
      </div>
    </dialog>
  );
}
