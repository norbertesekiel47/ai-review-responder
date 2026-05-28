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
        className="text-xs uppercase tracking-wider text-[#97B3AE]"
      >
        New reply
      </label>
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        {AI_DRAFT_DISCLOSURE}
      </div>
      <textarea
        id="reply-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_REPLY_CHARS}
        rows={8}
        className="w-full rounded-md border border-gray-300 p-3 text-sm text-[#2a2a2a] focus:border-[#97B3AE] focus:outline-none focus:ring-1 focus:ring-[#97B3AE]"
      />
      <div className="flex items-center justify-between">
        <span
          className={`text-xs ${
            overLimit ? 'text-red-600' : 'text-[#6a6a6a]'
          }`}
        >
          {text.length} / {MAX_REPLY_CHARS}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(text)}
            disabled={!text.trim() || overLimit}
            className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update on Google
          </button>
        </div>
      </div>
    </div>
  );
}
