'use client';
import { useState } from 'react';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';
import { MAX_REPLY_LENGTH } from '@/lib/responses/limits';
import { ReplyEditor } from '@/components/dashboard/reviews/ReplyEditor';

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
  const overLimit = text.length > MAX_REPLY_LENGTH;

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
      <ReplyEditor id="reply-textarea" value={text} onChange={setText} rows={8} />
      <div className="flex justify-end gap-2">
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
  );
}
