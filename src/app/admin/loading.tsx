import { TableSkeleton } from '@/components/admin/ui/states';

// Streaming fallback for the surviving support pages while a segment loads.
// Keeps the shared TableSkeleton used by the legacy shell.
//
// This renders INSIDE AdminShellFrame's main
// column, so it owns neither the viewport height nor the page background — it
// only stands in for an <AdminPage> body, and therefore mirrors AdminPage's own
// measure (`mx-auto max-w-7xl px-4 py-6 sm:px-6`) so the skeleton lands where
// the real content will.
export default function AdminLoading() {
  return (
    <div
      className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6"
      aria-busy="true"
      aria-label="Loading admin page"
    >
      <div className="h-8 w-48 animate-pulse rounded bg-gray-200" />
      <TableSkeleton />
    </div>
  );
}
