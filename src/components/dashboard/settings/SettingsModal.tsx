'use client';

import type { ReactNode } from 'react';

interface SettingsModalProps {
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsModal({ closeLabel, onClose, children }: SettingsModalProps) {
  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <div className="modal-content">
        {children}
      </div>
    </div>
  );
}
