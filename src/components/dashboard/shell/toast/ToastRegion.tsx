'use client';

import { Icon, type IconName } from '@/components/dashboard/shell/Icon';
import type { Toast, ToastTone } from '@/components/dashboard/shell/toast/ToastProvider';

/** Each tone keeps a shape cue beside its wash — colour never carries the
 *  outcome alone (The Evidence Color Rule). */
const TONE_ICON: Record<ToastTone, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'sparkle',
};

/** Screen-reader urgency follows the tone: a failure interrupts, a
 *  confirmation waits its turn. */
const TONE_LIVE: Record<ToastTone, 'polite' | 'assertive'> = {
  success: 'polite',
  error: 'assertive',
  info: 'polite',
};

export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-region">
      {toasts.map((entry) => (
        <div
          key={entry.id}
          className={`toast toast--${entry.tone}`}
          role={entry.tone === 'error' ? 'alert' : 'status'}
          aria-live={TONE_LIVE[entry.tone]}
        >
          <span className="toast-dot" aria-hidden="true">
            <Icon name={TONE_ICON[entry.tone]} size={13} />
          </span>
          <span className="toast-copy">
            <span className="toast-title">{entry.title}</span>
            {entry.body && <span className="toast-body">{entry.body}</span>}
          </span>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(entry.id)}
            aria-label={`Dismiss: ${entry.title}`}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
