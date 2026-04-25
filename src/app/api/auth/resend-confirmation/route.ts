import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { ResendConfirmationSchema } from '@/lib/shared/schemas';
import { getIpKey } from '@/lib/shared/request-ip';

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
  const { email } = parsed.data;

  // Owner-only route — admins are manually provisioned and never need resend.
  // See ResendConfirmationSchema (literal 'owner') for the rationale.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

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
      getIpKey(req, 'resend-conf'),
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
  const emailRedirectTo = `${appUrl}/api/auth/callback?flow=owner&next=/onboarding/pay`;

  await supabaseServer.auth
    .resend({ type: 'signup', email, options: { emailRedirectTo } })
    .catch((err) => {
      console.error('[resend-confirmation] supabase resend failed:', err);
    });

  return NextResponse.json({ ok: true });
}
