import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { trialEnabled as isTrialEnabled } from '@/lib/payments/flags';
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { recordDemoView } from '@/lib/demos/view-tracking';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';
import { DemoViewerContent } from './DemoViewerContent';
import { DemoStatusIsland } from './DemoStatusIsland';

export const dynamic = 'force-dynamic';

// Per-prospect tokenized content exposing a business's reviews; must not be
// crawled or cached by search engines.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

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
  const selfServeEnabled = selfServeSignupEnabled();
  const trialOn = selfServeEnabled && isTrialEnabled();
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
        trialEnabled={trialOn}
      />
    );
  }

  if (demo.generation_status === 'failed') {
    return (
      <DemoStatusIsland
        variant="error"
        businessName={demo.business_name}
        selfServeEnabled={selfServeEnabled}
        trialEnabled={trialOn}
      />
    );
  }

  // Any status other than 'completed' that reaches here is unexpected
  // (prospect_demos only uses queued/running/failed/completed). Fail safe
  // to the branded not-found island rather than rendering an empty viewer.
  if (demo.generation_status !== 'completed') {
    notFound();
  }

  // Only count views of completed demos; the loading state polls and would
  // inflate the count otherwise. Debounced via Redis INCR (#1369) — no
  // Postgres write happens on this unauthenticated page anymore;
  // `DemoViewFlushPoller` (Railway) periodically drains the counters into a
  // single batched UPDATE. recordDemoView is fail-open and never throws.
  await recordDemoView(demo.id);

  // Postgres.js may return JSONB as a string; parse if needed
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
      trialEnabled={trialOn}
    />
  );
}
