import { TableSkeleton } from '@/components/admin/ui/states';

// Streaming fallback for admin list pages while a segment loads. Uses the
// shared TableSkeleton (spec §3) so every per-page loading.tsx renders the
// same skeleton rather than a bespoke one.
export default function AdminLoading() {
  return (
    <div className="min-h-screen bg-gray-50" aria-busy="true" aria-label="Loading admin page">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-200" />
        <TableSkeleton />
      </div>
    </div>
  );
}
