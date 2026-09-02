// src/components/dashboard/shell/DashboardSkeleton.tsx
//
// The dashboard's loading skeleton in ONE place. Three verbatim copies existed:
// the route's streaming fallback (`dashboard/loading.tsx`) and DashboardContent's
// two client-fetch loading branches (the offboarding gate and the payload
// fetch). The streaming fallback is supposed to be indistinguishable from the
// in-page skeleton, and three copies is how that quietly stops being true.
//
// It mirrors the page's real zones (UX audit D32) using the SAME layout classes
// the loaded page uses — `.hero-row` for the hero + Rep Pulse pair and
// `.dash-pair` for the two doorways — so the skeleton collapses to one column
// at the same breakpoints as the content it stands in for, instead of showing
// three narrow columns on a phone.
//
// Deliberately NOT routed through `renderDashboardStatePanel`: that panel's
// skeleton is N × `skeleton-card-lg` with no zones, so reusing it would change
// what the owner sees while the dashboard loads. It owns the analytics/reviews
// scaffold; this owns the dashboard's.
//
// No 'use client' directive on purpose — pure markup, so the server-rendered
// `loading.tsx` and the client `DashboardContent` can both render it.

export function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" data-testid="dashboard-skeleton">
      {/* Zone 1 — hero band + Rep Pulse gauge */}
      <div className="hero-row">
        <div className="skeleton-card-lg" />
        <div className="skeleton-card-lg" />
      </div>
      {/* Zone 2 — the weekly recap */}
      <div className="skeleton-card" />
      {/* Zone 3 — the agent team strip */}
      <div className="skeleton-card" />
      {/* Zone 6 — the two doorways */}
      <div className="dash-pair">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </div>
  );
}
