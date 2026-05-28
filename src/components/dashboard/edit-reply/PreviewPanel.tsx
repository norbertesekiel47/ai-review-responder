'use client';
import { AI_DRAFT_DISCLOSURE } from '@/lib/ui/disclosures';

export function PreviewPanel({
  text,
  onPublish,
  onEditFurther,
  onCancel,
}: {
  text: string;
  onPublish: () => void;
  onEditFurther: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">
          Proposed reply
        </div>
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {AI_DRAFT_DISCLOSURE}
        </div>
        <p className="rounded-md border border-gray-200 bg-white p-3 text-sm text-[#2a2a2a]">
          {text}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onEditFurther}
          className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
        >
          Edit further
        </button>
        <button
          type="button"
          onClick={onPublish}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Update on Google
        </button>
      </div>
    </div>
  );
}
