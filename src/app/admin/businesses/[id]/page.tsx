import { sql } from '@/lib/db/server';
import ManualPostSection from './manual-post-section';

// Auth handled by src/middleware.ts — Sprint 3 replaces with Supabase Auth role check

export default async function BusinessDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: businessId } = await params;

  const [business] = await sql<
    {
      id: string;
      name: string;
      subscription_status: string;
      google_place_id: string | null;
      category: string | null;
    }[]
  >`
    SELECT id, name, subscription_status, google_place_id, category
    FROM businesses WHERE id = ${businessId}
  `;

  if (!business) {
    return (
      <div className="p-8 text-center text-gray-500">Business not found</div>
    );
  }

  const pendingResponses = await sql<
    {
      id: string;
      approved_text: string;
      reviewer_name: string;
      star_rating: number;
      review_text: string | null;
      created_at: string;
    }[]
  >`
    SELECT resp.id, resp.approved_text, r.reviewer_name, r.star_rating,
           r.review_text, resp.created_at
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.business_id = ${businessId}
      AND resp.status = 'awaiting_manual_post'
    ORDER BY resp.created_at DESC
  `;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900">{business.name}</h1>
      <div className="mt-2 flex gap-3 text-sm text-gray-500">
        <span className="rounded bg-gray-100 px-2 py-0.5">
          {business.subscription_status}
        </span>
        {business.category && <span>{business.category}</span>}
        {business.google_place_id && (
          <a
            href={`https://www.google.com/maps/place/?q=place_id:${business.google_place_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            Google Maps
          </a>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">
          Awaiting Manual Post ({pendingResponses.length})
        </h2>
        {pendingResponses.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400">
            No responses awaiting manual posting.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {pendingResponses.map((resp) => (
              <ManualPostSection
                key={resp.id}
                responseId={resp.id}
                businessId={businessId}
                reviewerName={resp.reviewer_name}
                starRating={resp.star_rating}
                reviewText={resp.review_text}
                approvedText={resp.approved_text}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
