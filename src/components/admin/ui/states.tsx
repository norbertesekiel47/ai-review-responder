interface EmptyStateProps {
  title: string;
  detail?: string;
}

export function EmptyState({ title, detail }: EmptyStateProps) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-8 text-center">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      {detail && <div className="mt-1 text-sm text-gray-500">{detail}</div>}
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  /** Name the failed request, e.g. "GET /api/admin/jobs failed (500)" (spec §6). */
  detail: string;
  onRetry?: () => void;
}

export function ErrorState({ title, detail, onRetry }: ErrorStateProps) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-4">
      <div className="text-sm font-semibold text-red-800">{title}</div>
      <div className="mt-0.5 text-sm text-red-700">{detail}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="animate-pulse rounded-md border border-gray-200 bg-white p-4" aria-hidden="true">
      <div className="mb-3 h-3 w-2/5 rounded bg-gray-200" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mb-2 h-3 w-full rounded bg-gray-100" />
      ))}
    </div>
  );
}
