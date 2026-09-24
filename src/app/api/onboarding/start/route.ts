import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';
import { startOnboarding } from '@/lib/onboarding/start';
import { botIdBlockResponse } from '@/lib/security/botid';
import { invalidBodyResponse } from '@/lib/shared/invalid-body-response';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

/**
 * POST /api/onboarding/start
 *
 * Guard: `ONBOARDING_DEMO_ENABLED` (the demo lane's own kill switch) + same
 * origin + authenticated session + `u.role = 'owner'` at the SQL boundary +
 * `subscription_status = 'pending_payment'`. The former
 * `SELF_SERVE_SIGNUP_ENABLED` check is gone — the flag now means only
 * "strangers may mint accounts"
 * (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`),
 * and an admin-invited owner walks this same funnel while it is off. The
 * double gate becomes a single demo gate.
 *
 * Orchestration only: the gates below, then `startOnboarding`
 * (`src/lib/onboarding/start.ts`, #1368) owns the account read, the rate
 * limits, the demo cost reservation and the activation transaction.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!onboardingDemoEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Vercel BotID (Deep Analysis) — gate the pre-pay LLM demo behind bot
  // detection. Placed AFTER the auth check on purpose: this route is auth-gated,
  // and Deep Analysis is billed per call, so running it only for an authenticated
  // session (not session-less scripted noise that 401s anyway, and not behind the
  // forgeable same-origin header) avoids paying for Deep on traffic the cheap 401
  // already rejects. Authenticated bots are still checked. Fails open on a BotID
  // infra error.
  const botBlock = await botIdBlockResponse('/api/onboarding/start');
  if (botBlock) return botBlock;

  const outcome = await startOnboarding(sql, {
    authId: user.id,
    clientIp: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
    // Read lazily: the module reads the body only after its subscription,
    // idempotency and outer rate-limit gates, as before #1368.
    readJsonBody: () => req.json(),
  });
  if (outcome.kind === 'invalid_body') {
    return invalidBodyResponse(outcome.error, { headers: NO_STORE });
  }
  return NextResponse.json(outcome.body, { status: outcome.status, headers: NO_STORE });
}
