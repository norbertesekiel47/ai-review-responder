import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import { setFreshAuthCookie } from '@/lib/account-offboarding/destructive-auth';
import {
  jsonResponse,
  requireOwnerWithAccount,
  withSameOrigin,
} from '@/lib/auth/route-helpers';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { getIpKey } from '@/lib/shared/request-ip';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const RETRY_AFTER_SECONDS = 15 * 60;

const FreshAuthSchema = z.object({
  password: z.string().min(1).max(1024),
}).strict();

async function freshAuth(req: NextRequest): Promise<NextResponse> {
  if (!accountOffboardingEnabled()) {
    return jsonResponse({ error: 'account_offboarding_disabled' }, 404);
  }

  const owner = await requireOwnerWithAccount(req);
  if (!owner.ok) return owner.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const parsed = FreshAuthSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'invalid_body', issues: parsed.error.issues },
      400,
    );
  }

  try {
    const limit = await checkRateLimit(
      getIpKey(req, `account-offboarding:fresh-auth:${owner.user.id}`),
      5,
      RETRY_AFTER_SECONDS,
      { strict: true },
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'rate_limited' },
        {
          status: 429,
          headers: {
            ...NO_STORE_HEADERS,
            'Retry-After': String(RETRY_AFTER_SECONDS),
          },
        },
      );
    }
  } catch (err) {
    console.error('[account-offboarding/fresh-auth] rate-limit strict failure:', err);
    return jsonResponse({ error: 'rate_limit_unavailable' }, 503);
  }

  const response = NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll() {
          // Re-auth verifies credentials only. Do not rotate the active
          // browser session or downgrade an existing AAL2 session to AAL1.
        },
      },
    },
  );

  const { data, error } = await supabase.auth.signInWithPassword({
    email: owner.user.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return jsonResponse({ error: 'invalid_credentials' }, 401);
  }

  setFreshAuthCookie(response, {
    userId: owner.user.id,
    accountId: owner.accountId,
  });
  return response;
}

export const POST = withSameOrigin()(freshAuth);
