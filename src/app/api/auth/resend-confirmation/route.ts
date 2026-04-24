import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { ResendConfirmationSchema } from '@/lib/shared/schemas';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = ResendConfirmationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { email, flow } = parsed.data;

  if (flow === 'owner' && process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  try {
    const emailRl = await checkRateLimit(
      `resend-conf:email:${email}`,
      2,
      3600,
      { strict: true },
    );
    if (!emailRl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }

    const ipRl = await checkRateLimit(
      `resend-conf:ip:${ip}`,
      5,
      3600,
      { strict: true },
    );
    if (!ipRl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    console.error('[resend-confirmation] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const emailRedirectTo = `${appUrl}/api/auth/callback?flow=${flow}&next=/onboarding/pay`;

  await supabaseServer.auth
    .resend({ type: 'signup', email, options: { emailRedirectTo } })
    .catch((err) => {
      console.error('[resend-confirmation] supabase resend failed:', err);
    });

  return NextResponse.json({ ok: true });
}
