import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

export const dynamic = 'force-dynamic';

// TODO Sprint 4: debounce view_count with Redis INCR instead of direct Postgres write

interface DemoRow {
  id: string;
  business_name: string;
  generation_status: string;
  generation_error: string | null;
  reviews_snapshot: NormalizedReview[] | null;
  generated_responses: (GenerationResult | null)[] | null;
  view_count: number;
  expires_at: Date;
}

async function getDemo(slug: string): Promise<DemoRow | null> {
  const [row] = await sql<DemoRow[]>`
    SELECT id, business_name, generation_status, generation_error,
           reviews_snapshot, generated_responses, view_count, expires_at
    FROM prospect_demos
    WHERE demo_url_slug = ${slug}
  `;
  return row ?? null;
}

export default async function DemoViewerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const demo = await getDemo(slug);

  if (!demo || demo.expires_at < new Date()) {
    notFound();
  }

  if (
    demo.generation_status === 'queued' ||
    demo.generation_status === 'running'
  ) {
    return <LoadingState businessName={demo.business_name} />;
  }

  if (demo.generation_status === 'failed') {
    return <ErrorState businessName={demo.business_name} />;
  }

  // Only count views of completed demos — loading state auto-refreshes
  // every 5s and would inflate the count otherwise
  // TODO Sprint 4: debounce with Redis INCR
  sql`
    UPDATE prospect_demos
    SET view_count = view_count + 1, last_viewed_at = NOW()
    WHERE id = ${demo.id}
  `.catch((err) => console.error('[demo-viewer] Failed to increment view count:', err));

  // Postgres.js may return JSONB as a string — parse if needed
  const reviews: NormalizedReview[] =
    typeof demo.reviews_snapshot === 'string'
      ? JSON.parse(demo.reviews_snapshot)
      : demo.reviews_snapshot ?? [];
  const responses: (GenerationResult | null)[] =
    typeof demo.generated_responses === 'string'
      ? JSON.parse(demo.generated_responses)
      : demo.generated_responses ?? [];
  const successCount = responses.filter((r) => r !== null).length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-2xl mx-auto px-4 py-8">
          <p className="text-sm font-medium text-blue-600 mb-1">
            RepWorth Demo
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            {demo.business_name}
          </h1>
          <div className="mt-4 flex flex-wrap gap-4 text-sm text-gray-600">
            <span className="inline-flex items-center gap-1">
              <span className="font-semibold text-gray-900">
                {reviews.length}
              </span>{' '}
              reviews analyzed
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="font-semibold text-green-600">
                {successCount}
              </span>{' '}
              AI responses generated
            </span>
          </div>
        </div>
      </header>

      {/* Review cards */}
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {reviews.map((review, index) => (
          <ReviewCard
            key={index}
            review={review}
            response={responses[index] ?? null}
          />
        ))}

        {/* CTA */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 text-center">
          <h2 className="text-xl font-bold text-gray-900 mb-2">
            Want AI-powered responses for your business?
          </h2>
          <p className="text-gray-600 mb-6 max-w-md mx-auto">
            RepWorth generates personalized, multilingual responses to every
            review — saving you hours each week.
          </p>
          <a
            href={`mailto:${process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'hello@repworth.com'}`}
            className="inline-block bg-blue-600 text-white font-medium px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Get Started with RepWorth
          </a>
          <p className="text-sm text-gray-400 mt-2">
            Contact us to set up AI-powered review responses for your business.
          </p>
        </div>
      </main>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function LoadingState({ businessName }: { businessName: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <meta httpEquiv="refresh" content="5" />
      <div className="text-center px-4">
        <div className="inline-block w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6" />
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          {businessName}
        </h1>
        <p className="text-gray-600">
          Your demo is being generated...
        </p>
        <p className="text-sm text-gray-400 mt-2">
          This usually takes about 30-60 seconds.
        </p>
      </div>
    </div>
  );
}

function ErrorState({ businessName }: { businessName: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center px-4">
        <div className="text-4xl mb-4">!</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          {businessName}
        </h1>
        <p className="text-gray-600">
          We encountered an issue generating this demo. Please contact us.
        </p>
      </div>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={i < rating ? 'text-yellow-400' : 'text-gray-300'}
        >
          ★
        </span>
      ))}
    </span>
  );
}

function ReviewCard({
  review,
  response,
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
}) {
  const isMultilingual =
    review.detectedLanguage !== 'en' ||
    (response && response.language !== 'en');

  const formattedDate = new Date(review.reviewDate).toLocaleDateString(
    'en-US',
    { year: 'numeric', month: 'short', day: 'numeric' },
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Review */}
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-2">
          <div>
            <span className="font-semibold text-gray-900">
              {review.reviewerName}
            </span>
            <span className="text-sm text-gray-400 ml-2">{formattedDate}</span>
          </div>
          {isMultilingual && (
            <span className="text-xs font-medium bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
              Multilingual
            </span>
          )}
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-2 text-gray-700 text-sm leading-relaxed">
            {review.reviewText}
          </p>
        ) : (
          <p className="mt-2 text-gray-400 text-sm italic">
            Rating only — no written review
          </p>
        )}
      </div>

      {/* AI Response */}
      {response && (
        <div className="bg-blue-50 border-t border-blue-100 p-4 sm:p-5">
          <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-2">
            AI Response
          </p>
          <p className="text-gray-700 text-sm leading-relaxed">
            {response.responseText}
          </p>
        </div>
      )}
    </div>
  );
}
