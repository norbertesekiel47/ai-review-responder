// Streaming fallback while the dashboard segment loads. Renders the SAME
// component as DashboardContent's in-page loading branches
// (`components/dashboard/shell/DashboardSkeleton`), so the streaming skeleton
// and the client-fetch skeleton cannot drift apart.
import { DashboardSkeleton } from '@/components/dashboard/shell/DashboardSkeleton';

export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <DashboardSkeleton />
    </div>
  );
}
