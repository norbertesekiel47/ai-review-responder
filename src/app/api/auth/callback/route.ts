import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import {
  isAuthFlow,
  loginUrlForFlow,
  resolveCallbackDestination,
  type AuthFlow,
} from '@/lib/shared/auth-flow';

/**
 * Supabase auth callback handler.
 *
 * Two entry shapes — same role-aware exit:
 *
 *  - **`?code=...`** (PKCE / OAuth) — Google OAuth uses this. We call
 *    `exchangeCodeForSession`. The browser SDK stores the code_verifier in a
 *    cookie before redirecting out, so the cookie-aware server client here
 *    can complete the exchange.
 *
 *  - **`?token_hash=...&type=email|recovery|invite`** (verifyOtp) — Email
 *    confirmation + password reset use this. The server-side `signUp()` call
 *    can't do PKCE (no browser to stash a verifier), so we use the SSR-safe
 *    `verifyOtp` flow instead. Email template emits a URL pointing here with
 *    the raw `token_hash`; we verify it server-side and the same setAll
 *    adapter persists session cookies as `exchangeCodeForSession` does.
 *
 * After authentication, three sub-flows fork on `next=` — all resolved by
 * `resolveCallbackDestination` (the single source of truth for redirect
 * safety + role/path allowlisting):
 *
 *  1. **Email confirmation** — `next=/onboarding/pay`. Role-lookup → owner
 *     redirect. (Pending-payment routing happens in `/api/auth/signup-status`
 *     once the page mounts.)
 *  2. **Password recovery** — `next=/reset-password` or `/admin/reset-password`.
 *     The reset page reads the session directly via `supabase.auth.getUser()`.
 *  3. **Google OAuth signup** — `flow=owner` + `next=/signup/finish`. The
 *     Supabase Auth user exists (Google just confirmed it) but there's no app
 *     `users` row yet. Land on `/signup/finish` to finish provisioning instead
 *     of signing out.
 *
 * Failure redirect target is derived from `flow` via `loginUrlForFlow` so
 * owners land on `/login` and admins on `/admin/login`.
 */

const VALID_EMAIL_OTP_TYPES: ReadonlySet<EmailOtpType> = new Set<EmailOtpType>([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]);

type CallbackClient = ReturnType<typeof createServerClient>;

// SSR Supabase client whose cookie adapter writes session cookies into the
// up-front `response` jar; the caller copies them onto the final redirect.
function createCallbackClient(
  request: NextRequest,
  response: NextResponse,
): CallbackClient {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );
}

// Completes whichever exchange the entry shape implies and returns the
// authenticated auth-user id. `ok: false` means the exchange failed (bad OTP
// type, expired link, etc.) and the caller should bounce to the failure page.
async function exchangeForUserId(
  supabase: CallbackClient,
  params: { code: string | null; tokenHash: string | null; rawType: string | null },
): Promise<{ ok: true; userId: string | undefined } | { ok: false }> {
  const { code, tokenHash, rawType } = params;
  if (tokenHash) {
    if (!rawType || !VALID_EMAIL_OTP_TYPES.has(rawType as EmailOtpType)) {
      return { ok: false };
    }
    const { error, data } = await supabase.auth.verifyOtp({
      type: rawType as EmailOtpType,
      token_hash: tokenHash,
    });
    return error ? { ok: false } : { ok: true, userId: data.user?.id };
  }
  const { error, data } = await supabase.auth.exchangeCodeForSession(code!);
  return error ? { ok: false } : { ok: true, userId: data.user?.id };
}

// Resolves the app `users.role` for an authenticated auth-user, or `null` when
// there is no users row yet (the Google-signup case) — which the resolver maps
// to the finish/sign-out branches.
async function lookupUserRole(
  supabase: CallbackClient,
  userId: string,
): Promise<string | null> {
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('role')
    .eq('auth_id', userId)
    .limit(1)
    .single();
  if (userErr && userErr.code === 'PGRST116') {
    // PGRST116 = "Expected a single row. Got 0 or >1." We can't distinguish
    // here, but log both possibilities. >1 would be a data-integrity bug
    // (duplicate users.auth_id) that should page someone — auth_id is UNIQUE
    // per migration 001, so this would only happen mid-restore or mid-migration.
    // 0 rows is the expected Google-signup case.
    console.warn(
      `[callback] PGRST116 for auth_id=${userId} — either missing users row or duplicate auth_id. Investigate if duplicate.`,
    );
    return null;
  }
  return (userRow as { role: string } | null)?.role ?? null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const rawType = searchParams.get('type');
  const rawFlow = searchParams.get('flow');
  const flow: AuthFlow | undefined = isAuthFlow(rawFlow) ? rawFlow : undefined;
  // The raw `next` param — sanitization lives inside resolveCallbackDestination
  // (the single source of truth for redirect safety); callers never pre-sanitize.
  const rawNext = searchParams.get('next') ?? '';
  const loginUrl = loginUrlForFlow(flow);
  const failRedirect = (): NextResponse =>
    NextResponse.redirect(new URL(`${loginUrl}?error=auth_callback_failed`, origin));

  if (!code && !tokenHash) {
    return NextResponse.redirect(new URL(loginUrl, origin));
  }

  // Temporary redirect target — rewritten after role lookup below. We still need
  // a response up-front so createCallbackClient's setAll adapter has a cookie jar.
  const response = NextResponse.redirect(new URL(loginUrl, origin));
  const supabase = createCallbackClient(request, response);

  const exchanged = await exchangeForUserId(supabase, { code, tokenHash, rawType });
  if (!exchanged.ok) return failRedirect();

  const role = exchanged.userId
    ? await lookupUserRole(supabase, exchanged.userId)
    : null;

  const resolution = resolveCallbackDestination({ role, rawNext, flow });

  // A `signout-redirect` means "no users row in any non-finish flow, or an
  // unsupported role" → sign out so the user can retry cleanly. signOut writes
  // cleared session cookies into the `response` jar; the cookie copy below
  // carries them onto the redirect — without that, the browser keeps the bad
  // session and bounces in a redirect loop on the next protected request.
  if (resolution.kind === 'signout-redirect') {
    await supabase.auth.signOut();
  }

  // Build the final redirect with the resolved destination, copying the session
  // cookies that the token exchange (or signOut) wrote via setAll.
  const finalResponse = NextResponse.redirect(
    new URL(resolution.destination, origin),
  );
  for (const cookie of response.cookies.getAll()) {
    finalResponse.cookies.set(cookie);
  }
  return finalResponse;
}
