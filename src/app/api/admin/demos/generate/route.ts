import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { nanoid } from 'nanoid';
import { sql, jsonb } from '@/lib/db/server';
import { isPlaceId, extractPlaceId } from '@/lib/reviews/url-parser';
import { requireRole, AuthError } from '@/lib/db/auth';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import type { DemoJobPayload } from '@/lib/demos/types';

const GenerateDemoSchema = z
  .object({
    googlePlaceId: z.string().min(1).optional(),
    googleMapsUrl: z.string().min(1).optional(),
    businessName: z.string().min(1, 'Business name is required').max(255),
    category: z.string().max(100).optional(),
  })
  .refine(
    (data) => Boolean(data.googlePlaceId) || Boolean(data.googleMapsUrl),
    { message: 'Either a Place ID or Google Maps URL is required', path: ['googlePlaceId'] },
  );

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Rate limits: fail CLOSED for cost-sensitive demo generation.
  // If Redis is unavailable, return 503 instead of allowing uncapped generation.
  if (!process.env.REDIS_CACHE_URL) {
    return NextResponse.json(
      { error: 'Rate limiting unavailable — try again later' },
      { status: 503 },
    );
  }

  try {
    const dailyLimit = await checkRateLimit('demo:generate:daily', 50, 86400);
    if (!dailyLimit.allowed) {
      return NextResponse.json(
        { error: 'Daily demo generation limit reached (50/day)' },
        { status: 429 },
      );
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const minuteLimit = await checkRateLimit(`demo:generate:minute:${ip}`, 5, 60);
    if (!minuteLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many demo generations. Try again in a minute.' },
        { status: 429 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Rate limiting unavailable — try again later' },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = GenerateDemoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const { businessName, category } = parsed.data;

  let placeId: string;
  let googleMapsUrl: string | undefined;

  if (parsed.data.googlePlaceId) {
    if (!isPlaceId(parsed.data.googlePlaceId)) {
      return NextResponse.json({ error: 'Invalid Place ID format' }, { status: 400 });
    }
    placeId = parsed.data.googlePlaceId;
  } else {
    // URL fallback — extract what we can for now, worker will resolve
    const extracted = extractPlaceId(parsed.data.googleMapsUrl!);
    placeId = extracted ?? 'pending_resolution';
    googleMapsUrl = parsed.data.googleMapsUrl;
  }

  const demoId = uuidv7();
  const outboxId = uuidv7();
  const slug = nanoid(10);

  const payload: DemoJobPayload = {
    demoId,
    googlePlaceId: placeId,
    businessName,
    category,
    googleMapsUrl,
    correlation_id: uuidv7(),
  };

  // Transactional outbox: demo + outbox entry in ONE transaction
  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO prospect_demos (id, business_name, google_place_id, google_maps_url, demo_url_slug, generation_status)
        VALUES (${demoId}, ${businessName}, ${placeId}, ${googleMapsUrl ?? null}, ${slug}, 'queued')
      `;

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${outboxId}, 'generate_demo', 'demo', ${demoId}, ${jsonb(payload)}, 'pending')
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
