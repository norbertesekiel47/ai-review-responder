import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { nanoid } from 'nanoid';
import { sql } from '@/lib/db/server';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import { requireRole, AuthError } from '@/lib/db/auth';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import type { DemoJobPayload } from '@/lib/demos/types';

const GenerateDemoSchema = z.object({
  googleMapsUrl: z.string().min(1, 'Google Maps URL is required'),
  businessName: z.string().min(1, 'Business name is required').max(255),
  category: z.string().max(100).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Rate limit: 50 demos per day globally (cost-sensitive — triggers SerpAPI + LLM)
  const dailyLimit = await checkRateLimit('demo:generate:daily', 50, 86400);
  if (!dailyLimit.allowed) {
    return NextResponse.json(
      { error: 'Daily demo generation limit reached (50/day)' },
      { status: 429 },
    );
  }

  // Rate limit: 5 per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const minuteLimit = await checkRateLimit(`demo:generate:minute:${ip}`, 5, 60);
  if (!minuteLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many demo generations. Try again in a minute.' },
      { status: 429 },
    );
  }

  const body = await request.json();

  const parsed = GenerateDemoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const { googleMapsUrl, businessName, category } = parsed.data;

  const placeId = extractPlaceId(googleMapsUrl);
  if (!placeId) {
    return NextResponse.json(
      { error: 'Could not extract Google Place ID from URL' },
      { status: 400 },
    );
  }

  const demoId = uuidv7();
  const outboxId = uuidv7();
  const slug = nanoid(10);

  const payload: DemoJobPayload = {
    demoId,
    googlePlaceId: placeId,
    businessName,
    category,
  };

  // Transactional outbox: demo + outbox entry in ONE transaction
  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO prospect_demos (id, business_name, google_place_id, demo_url_slug, generation_status)
        VALUES (${demoId}, ${businessName}, ${placeId}, ${slug}, 'queued')
      `;

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${outboxId}, 'generate_demo', 'demo', ${demoId}, ${JSON.stringify(payload)}::jsonb, 'pending')
      `;
    });
  } catch (error) {
    console.error('[api/demos/generate] Transaction failed:', error);
    return NextResponse.json(
      { error: 'Failed to queue demo generation' },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { id: demoId, slug, status: 'queued' },
    { status: 201 },
  );
}
