'use client';

// ReplyEditor — the one textarea every reply-editing surface renders (UX audit
// D35): the queue's inline edit, the Reviews list's inline Generate panel, and
// the Edit-reply drawer's manual editor. Owns the shared 2000-character limit
// and the length counter, so no surface can edit a reply without showing how
// much room is left.

import { MAX_REPLY_LENGTH } from '@/lib/responses/limits';

interface Props {
  /** Element id; the counter is bound to it via aria-describedby. */
  id: string;
  value: string;
  onChange: (text: string) => void;
  /** Accessible name when no visible <label htmlFor={id}> is rendered. */
  label?: string;
  rows?: number;
  /** Surface-specific textarea class (`textarea` for Console cards, `pr-gen-textarea` in the Reviews list). */
  className?: string;
}

export function ReplyEditor({
  id,
  value,
  onChange,
  label,
  rows = 4,
  className = 'textarea',
}: Props) {
  const remaining = MAX_REPLY_LENGTH - value.length;
  const overLimit = remaining < 0;
  const counterId = `${id}-count`;

  return (
    <div className="space-y-1">
      <textarea
        id={id}
        aria-label={label}
        aria-describedby={counterId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={MAX_REPLY_LENGTH}
        rows={rows}
        className={className}
      />
      <div
        id={counterId}
        className="text-xs"
        style={{ color: overLimit ? 'var(--rw-danger)' : 'var(--rw-app-text-muted)' }}
      >
        {value.length} / {MAX_REPLY_LENGTH}
      </div>
    </div>
  );
}
