'use client';

// src/components/dashboard/settings/ConfirmDialog.tsx
//
// The one confirmation-dialog body the owner settings surfaces share: a
// question as the section title, the consequence spelled out under it, and a
// right-aligned "keep" / "do it" pair. Four surfaces (remove authenticator,
// leave with unsaved changes, disconnect a mobile channel, remove a per-location
// override) rendered this same markup by hand inside SettingsModal; this owns it
// so the markup — and the disabled-while-busy behaviour — cannot drift apart.

import type { ReactNode } from 'react';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';

export interface ConfirmDialogProps {
  /** Accessible name for the dialog (SettingsModal `title`). */
  title: string;
  /** Accessible label for the dismiss backdrop (SettingsModal `closeLabel`). */
  closeLabel: string;
  /** The question, rendered as the section title. */
  heading: ReactNode;
  /** The consequence, spelled out under the heading. */
  body: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  /** `danger` for destructive verbs (remove / disconnect); `primary` for a plain commit (leave the page). */
  confirmTone?: 'danger' | 'primary';
  /** Disables both buttons while the confirmed action is in flight. */
  busy?: boolean;
  /** Backdrop click, Escape, and the cancel button all land here. */
  onCancel: () => void;
  onConfirm: () => void;
}

const CONFIRM_CLASS: Record<NonNullable<ConfirmDialogProps['confirmTone']>, string> = {
  danger: 'btn-danger',
  primary: 'btn btn-primary',
};

export function ConfirmDialog({
  title,
  closeLabel,
  heading,
  body,
  cancelLabel,
  confirmLabel,
  confirmTone = 'danger',
  busy,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <SettingsModal title={title} closeLabel={closeLabel} onClose={onCancel}>
      <div className="set-section-title" style={{ marginBottom: 8 }}>
        {heading}
      </div>
      <p className="settings-body-copy" style={{ marginBottom: 16 }}>
        {body}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button type="button" className={CONFIRM_CLASS[confirmTone]} onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </SettingsModal>
  );
}
