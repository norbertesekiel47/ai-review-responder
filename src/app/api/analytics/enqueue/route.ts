import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { v7 as uuidv7 } from 'uuid';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { isAnalyticsEventName, makeAnalyticsEventKey } from '@/lib/analytics/events';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const ANON_COOKIE = 'rw_analytics_id';

interface Body {
  eventName?: unknown;
  clientEventId?: unknown;
  properties?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  if (typeof body.eventName !== 'string' || !isAnalyticsEventName(body.eventName)) {
    return NextResponse.json({ error: 'invalid_event' }, { status: 400, headers: NO_STORE });
  }

  const cookieStore = await cookies();
  let anonymousId = cookieStore.get(ANON_COOKIE)?.value;
  if (!anonymousId) {
    anonymousId = uuidv7();
  }

  const rate = await checkRateLimit(`analytics:${anonymousId}`, 120, 60, { strict: false });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } });
  }

  const clientEventId = typeof body.clientEventId === 'string' && body.clientEventId.length <= 80
    ? body.clientEventId
    : uuidv7();
  const eventKey = makeAnalyticsEventKey(body.eventName, [anonymousId, clientEventId]);
  const properties = body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties)
    ? body.properties as Record<string, unknown>
    : {};

  await enqueueAnalyticsEvent({
    eventName: body.eventName,
    eventKey,
    distinctId: anonymousId,
    anonymousId,
    properties,
  });

  const res = NextResponse.json({ ok: true }, { status: 202, headers: NO_STORE });
  res.cookies.set(ANON_COOKIE, anonymousId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
