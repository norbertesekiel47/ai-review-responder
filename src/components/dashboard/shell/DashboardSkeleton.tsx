// src/components/dashboard/shell/DashboardSkeleton.tsx
//
// The dashboard's loading skeleton — a 3-up stat row over two large cards — in
// ONE place. Three verbatim copies existed: the route's streaming fallback
// (`dashboard/loading.tsx`) and DashboardContent's two client-fetch loading
// branches (the offboarding gate and the payload fetch). The streaming fallback
// is supposed to be indistinguishable from the in-page skeleton, and three
// copies is how that quietly stops being true.
//
// Deliberately NOT routed through `renderDashboardStatePanel`: that panel's
// skeleton is N × `skeleton-card-lg` with no stat row, so reusing it would
// change what the owner sees while the dashboard loads. It owns the
// analytics/reviews scaffold; this owns the dashboard's.
//
// No 'use client' directive on purpose — pure markup, so the server-rendered
// `loading.tsx` and the client `DashboardContent` can both render it.

export function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <div className="skeleton-card" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
      <div className="skeleton-card-lg" />
      <div className="skeleton-card-lg" />
    </div>
  );
}
