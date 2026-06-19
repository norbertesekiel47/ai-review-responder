'use client';
import { useState } from 'react';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';

const MAX_REPLY_CHARS = 2000;

export function ManualEditor({
  initialText,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const remaining = MAX_REPLY_CHARS - text.length;
  const overLimit = remaining < 0;

  return (
    <div className="space-y-2">
      <label
        htmlFor="reply-textarea"
        className="text-xs uppercase tracking-wider"
        style={{ color: 'var(--rw-sage-deep)' }}
      >
        New reply
      </label>
      <div className="rounded-md px-3 py-2 text-xs" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-sage-soft)', color: 'var(--rw-app-text-muted)' }}>
        {AI_DRAFT_DISCLOSURE}
      </div>
      <textarea
        id="reply-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_REPLY_CHARS}
        rows={8}
        className="textarea"
      />
      <div className="flex items-center justify-between">
        <span
          className="text-xs"
          style={{ color: overLimit ? 'var(--rw-danger)' : 'var(--rw-app-text-muted)' }}
        >
          {text.length} / {MAX_REPLY_CHARS}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(text)}
            disabled={!text.trim() || overLimit}
            className="btn btn-primary"
          >
            Update on Google
          </button>
        </div>
      </div>
    </div>
  );
}
