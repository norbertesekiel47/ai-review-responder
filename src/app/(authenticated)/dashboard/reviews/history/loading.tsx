// Streaming fallback for the Reviews list (data-heavy segment). Named the way
// the tab is named — "All reviews" — so the announced state and the destination
// carry one name (UX audit D16).
export default function PastRepliesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading all reviews">
      <div className="dashboard-skeleton">
        <div className="skeleton-card" />
        <div className="skeleton-card-lg" />
        <div className="skeleton-card-lg" />
      </div>
    </div>
  );
}
