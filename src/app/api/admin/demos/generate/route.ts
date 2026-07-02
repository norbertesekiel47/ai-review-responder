import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { nanoid } from 'nanoid';
import { sql, jsonb } from '@/lib/db/server';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { isPlaceId, extractPlaceId } from '@/lib/reviews/url-parser';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import type { DemoJobPayload } from '@/lib/demos/types';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getServerConfig } from '@/lib/config/server';

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

/**
 * Cost-sensitive rate limits for demo generation, fail-CLOSED (Redis down → 503,
 * never uncapped). Three tiers: global daily (50), per-admin daily (20, F-20 — so
 * one admin can't drain the global budget), per-IP minute (5). Returns a response
 * to short-circuit on limit-hit/unavailable, or null when the caller may proceed.
 */
async function enforceDemoGenerationRateLimits(
  request: NextRequest,
  adminId: string,
): Promise<NextResponse | null> {
  if (!getServerConfig().REDIS_CACHE_URL) {
    return NextResponse.json(
      { error: 'Rate limiting unavailable — try again later' },
      { status: 503 },
    );
  }

  // strict:true → a Redis runtime error propagates and is mapped to 503 below,
  // instead of fail-OPEN-allowing uncapped, cost-sensitive demo generation. This
  // route is a deliberate fail-CLOSED exception (the general API limiters fail open
  // because a worker reservation guards spend — see CLAUDE.md); the per-admin cap
  // would otherwise be silently bypassed during an Upstash outage.
  const STRICT = { strict: true } as const;

  try {
    const dailyLimit = await checkRateLimit('demo:generate:daily', 50, 86400, STRICT);
    if (!dailyLimit.allowed) {
      return NextResponse.json(
        { error: 'Daily demo generation limit reached (50/day)' },
        { status: 429 },
      );
    }

    const adminDailyLimit = await checkRateLimit(`demo:generate:daily:admin:${adminId}`, 20, 86400, STRICT);
    if (!adminDailyLimit.allowed) {
      return NextResponse.json(
        { error: 'Per-admin daily demo limit reached (20/day)' },
        { status: 429 },
      );
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const minuteLimit = await checkRateLimit(`demo:generate:minute:${ip}`, 5, 60, STRICT);
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

  return null;
}

async function generateDemo(request: NextRequest): Promise<NextResponse> {
  // Auth-before-spend: gate must be first — non-AAL2 callers are rejected
  // before any rate-limit budget is consumed or LLM/outbox path is entered.
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const limited = await enforceDemoGenerationRateLimits(request, gate.admin.id);
  if (limited) return limited;

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
        VALUES (${outboxId}, ${QUEUE_NAMES.GENERATE_DEMO}, 'demo', ${demoId}, ${jsonb(payload)}, 'pending')
      `;
    });
  } catch (error) {
    reportCaughtError('api/demos/generate', error, { failure: 'outbox_transaction', demoId });
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

export const POST = withSameOrigin()(generateDemo);
