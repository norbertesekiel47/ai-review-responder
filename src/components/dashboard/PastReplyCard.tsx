// src/components/dashboard/PastReplyCard.tsx
//
// Presentational server-renderable component for one row in the Past
// Replies list — READ-ONLY view.
//
// Renders the customer's review on the left and the currently-posted Google
// reply on the right. Provenance label distinguishes:
//   - "Imported from Google · YYYY-MM-DD" — external_reply_ingested_at set
//     (we discovered an existing reply during ingestion, not authored here).
//   - "Posted via RepWorth · YYYY-MM-DD" — published through our publisher.
//
// No Edit affordances. The full edit / regenerate / publish flow is parked
// on tag wip/edit-existing-replies-zernio-v1 pending direct GBP API
// approval — see docs/runbooks/zernio-launch-runbook.md §10.

export interface PastReplyRow {
  review_id: string;
  review_text: string | null;
  review_date: string;
  reviewer_name: string | null;
  star_rating: number | null;
  response_id: string;
  approved_text: string | null;
  posted_at: string | null;
  external_reply_ingested_at: string | null;
}

interface PastReplyCardProps {
  row: PastReplyRow;
  isImported: boolean;
}

function renderStars(rating: number | null): string {
  if (rating == null) return '';
  const filled = Math.round(Math.max(0, Math.min(5, rating)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function PastReplyCard({ row, isImported }: PastReplyCardProps) {
  const provenanceLabel = isImported
    ? `Imported from Google · ${formatDate(row.posted_at)}`
    : `Posted via RepWorth · ${formatDate(row.posted_at)}`;

  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="grid gap-4 md:grid-cols-2">
        {/* Customer review */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {row.star_rating != null ? (
              <span
                className="text-sm text-yellow-500"
                aria-label={`${row.star_rating} stars`}
              >
                {renderStars(row.star_rating)}
              </span>
            ) : (
              <span className="text-xs text-gray-400">No rating</span>
            )}
            <span className="text-sm font-medium text-[#2a2a2a]">
              {row.reviewer_name ?? 'Anonymous'}
            </span>
            <span className="text-xs text-[#6a6a6a]">
              {formatDate(row.review_date)}
            </span>
          </div>
          {row.review_text ? (
            <p className="text-sm text-[#2a2a2a]">{row.review_text}</p>
          ) : (
            <p className="text-sm italic text-[#6a6a6a]">
              No review text — rating only.
            </p>
          )}
        </div>

        {/* Current Google reply */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wider text-[#97B3AE]">
              Current Google reply
            </span>
          </div>
          <p className="rounded-md bg-[#F0EEEA]/60 p-3 text-sm text-[#2a2a2a]">
            {row.approved_text ?? <em className="text-[#6a6a6a]">(empty)</em>}
          </p>
          <p className="text-xs text-[#6a6a6a]">{provenanceLabel}</p>
        </div>
      </div>
    </article>
  );
}
