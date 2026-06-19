'use client';

export function RecoveryPanel({
  onRetry,
  onRestore,
  restoreAvailable,
}: {
  onRetry: () => void;
  onRestore: () => void;
  restoreAvailable: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid var(--rw-sage-line)', background: 'var(--rw-recess)' }}>
      <p className="text-sm" style={{ color: 'var(--rw-app-text-muted)' }}>
        {restoreAvailable
          ? 'The previous edit didn’t complete and your old reply is no longer on Google. Retry the edit, or restore the original reply.'
          : 'The previous edit didn’t complete. The original reply is still live on Google. Retry to re-attempt the edit.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="btn btn-primary"
        >
          Retry posting
        </button>
        {restoreAvailable && (
          <button
            type="button"
            onClick={onRestore}
            className="btn btn-secondary"
          >
            Restore original
          </button>
        )}
      </div>
    </div>
  );
}
