import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';
import { DemoViewerContent } from './DemoViewerContent';
import { DemoStatusIsland } from './DemoStatusIsland';

export const dynamic = 'force-dynamic';

// Per-prospect tokenized content exposing a business's reviews — must not be
// crawled or cached by search engines.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

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
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  const demo = await getDemo(slug);

  if (!demo || demo.expires_at < new Date()) {
    notFound();
  }

  if (demo.generation_status === 'queued' || demo.generation_status === 'running') {
    return (
      <DemoStatusIsland
        variant="loading"
        businessName={demo.business_name}
        selfServeEnabled={selfServeEnabled}
      />
    );
  }

  if (demo.generation_status === 'failed') {
    return (
      <DemoStatusIsland
        variant="error"
        businessName={demo.business_name}
        selfServeEnabled={selfServeEnabled}
      />
    );
  }

  // Any status other than 'completed' that reaches here is unexpected
  // (prospect_demos only uses queued/running/failed/completed). Fail safe
  // to the branded not-found island rather than rendering an empty viewer.
  if (demo.generation_status !== 'completed') {
    notFound();
  }

  // Only count views of completed demos — the loading state polls and would
  // inflate the count otherwise.
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

  return (
    <DemoViewerContent
      businessName={demo.business_name}
      reviews={reviews}
      responses={responses}
      selfServeEnabled={selfServeEnabled}
    />
  );
}
