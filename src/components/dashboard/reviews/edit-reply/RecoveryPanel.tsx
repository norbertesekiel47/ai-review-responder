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
    <div className="space-y-3 rounded-lg border border-[#97B3AE]/40 bg-[#F0EEEA]/40 p-4">
      <p className="text-sm text-[#6a6a6a]">
        {restoreAvailable
          ? 'The previous edit didn’t complete and your old reply is no longer on Google. Retry the edit, or restore the original reply.'
          : 'The previous edit didn’t complete. The original reply is still live on Google. Retry to re-attempt the edit.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Retry posting
        </button>
        {restoreAvailable && (
          <button
            type="button"
            onClick={onRestore}
            className="rounded-full border border-[#97B3AE]/40 bg-white px-5 py-2 text-sm font-medium text-[#97B3AE] hover:bg-[#F0EEEA]/40"
          >
            Restore original
          </button>
        )}
      </div>
    </div>
  );
}
