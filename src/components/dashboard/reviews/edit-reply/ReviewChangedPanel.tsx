'use client';

export function ReviewChangedPanel({
  currentText,
  onRefresh,
  onClose,
}: {
  currentText: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-recess)' }}>
      <p className="text-sm" style={{ color: 'var(--rw-app-text-muted)' }}>
        The customer updated this review. Refresh to see the latest version
        before editing again.
      </p>
      {currentText && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider" style={{ color: 'var(--rw-sage-deep)' }}>
            Updated review text
          </div>
          <p className="rounded-md p-3 text-sm" style={{ background: 'var(--rw-card)', color: 'var(--rw-app-text)' }}>{currentText}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="btn btn-primary"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-secondary"
        >
          Close
        </button>
      </div>
    </div>
  );
}
