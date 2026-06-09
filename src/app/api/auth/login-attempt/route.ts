import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { getIpKey } from '@/lib/shared/request-ip';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { botIdBlockResponse } from '@/lib/security/botid';

export const dynamic = 'force-dynamic';

const RETRY_AFTER_SECONDS = 15 * 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  // Vercel BotID (Basic) — reject bots before the per-email/IP rate limit.
  // Fails open on a BotID infra error.
  const botBlock = await botIdBlockResponse('/api/auth/login-attempt');
  if (botBlock) return botBlock;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const email =
    body && typeof body === 'object' && typeof (body as { email?: unknown }).email === 'string'
      ? (body as { email: string }).email.trim().toLowerCase()
      : '';
  if (!email) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    const limit = await checkRateLimit(
      getIpKey(req, `login:${email}`),
      5,
      RETRY_AFTER_SECONDS,
      { strict: true },
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) } },
      );
    }
  } catch (err) {
    console.error('[login-attempt] rate-limit strict failure:', err);
    return NextResponse.json(
      { error: 'rate_limit_unavailable' },
      { status: 503 },
    );
  }

  return new NextResponse(null, { status: 204 });
}
