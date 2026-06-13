// Streaming fallback for admin list pages while a segment loads.
export default function AdminLoading() {
  return (
    <div className="min-h-screen bg-gray-50" aria-busy="true" aria-label="Loading admin page">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-200" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="h-24 animate-pulse rounded-lg bg-gray-200" />
          <div className="h-24 animate-pulse rounded-lg bg-gray-200" />
          <div className="h-24 animate-pulse rounded-lg bg-gray-200" />
        </div>
        <div className="h-64 animate-pulse rounded-lg bg-gray-200" />
      </div>
    </div>
  );
}
