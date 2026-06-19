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
        <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
          Proposed reply
        </div>
        <div className="mb-3 rounded-md px-3 py-2 text-xs" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-sage-soft)', color: 'var(--rw-app-text-muted)' }}>
          {AI_DRAFT_DISCLOSURE}
        </div>
        <p className="rounded-md p-3 text-sm" style={{ border: '1px solid var(--rw-hair)', background: 'var(--rw-card)', color: 'var(--rw-app-text)' }}>
          {text}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-secondary"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onEditFurther}
          className="btn btn-secondary"
        >
          Edit further
        </button>
        <button
          type="button"
          onClick={onPublish}
          className="btn btn-primary"
        >
          Update on Google
        </button>
      </div>
    </div>
  );
}
