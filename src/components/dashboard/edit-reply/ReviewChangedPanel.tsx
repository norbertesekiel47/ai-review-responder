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
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm text-amber-900">
        The customer updated this review. Refresh to see the latest version
        before editing again.
      </p>
      {currentText && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">
            Updated review text
          </div>
          <p className="rounded-md bg-white p-3 text-sm text-[#2a2a2a]">{currentText}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-full bg-[#97B3AE] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-[#7c9994]"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-[#2a2a2a] hover:bg-gray-50"
        >
          Close
        </button>
      </div>
    </div>
  );
}
