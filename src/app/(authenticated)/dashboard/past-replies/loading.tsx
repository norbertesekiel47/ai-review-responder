// Streaming fallback for the past-replies list (data-heavy segment).
export default function PastRepliesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading past replies">
      <div className="dashboard-skeleton">
        <div className="skeleton-card" />
        <div className="skeleton-card-lg" />
        <div className="skeleton-card-lg" />
      </div>
    </div>
  );
}
