// Streaming fallback while the dashboard segment loads. Mirrors the in-page
// skeleton DashboardContent shows during client data fetches (console.css).
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading dashboard">
      <div className="dashboard-skeleton">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
        <div className="skeleton-card-lg" />
        <div className="skeleton-card-lg" />
      </div>
    </div>
  );
}
