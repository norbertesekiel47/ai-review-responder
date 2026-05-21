import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import { isAuthFlow, loginUrlForFlow, type AuthFlow } from '@/lib/shared/auth-flow';

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
 * After authentication, three sub-flows fork on `next=`:
 *
 *  1. **Email confirmation** — `next=/onboarding/pay`. Role-lookup → owner
 *     redirect. (Pending-payment routing happens in `/api/auth/signup-status`
 *     once the page mounts.)
 *  2. **Password recovery** — `next=/reset-password` or `/admin/reset-password`.
 *     We skip the role lookup entirely; the reset page reads the session
 *     directly via `supabase.auth.getUser()`.
 *  3. **Google OAuth signup** — `flow=owner` + `next=/signup/finish`. The
 *     Supabase Auth user exists (Google just confirmed it) but there's no
 *     app `users` row yet. Land on `/signup/finish` so the owner can finish
 *     provisioning their business, instead of signing out.
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const rawType = searchParams.get('type');
  const rawFlow = searchParams.get('flow');
  const flow: AuthFlow | undefined = isAuthFlow(rawFlow) ? rawFlow : undefined;
  const rawNext = searchParams.get('next') ?? '';
  // Restrict redirect to safe internal paths (no //, no external URLs).
  const nextIsSafe =
    rawNext.startsWith('/') && !rawNext.startsWith('//');
  const requestedNext = nextIsSafe ? rawNext : '';
  const loginUrl = loginUrlForFlow(flow);

  if (!code && !tokenHash) {
    return NextResponse.redirect(new URL(loginUrl, origin));
  }

  // Temporary redirect target — will be rewritten after role lookup below.
  // We still need a response up-front so createServerClient's setAll adapter
  // has a cookie jar to write session cookies into.
  const response = NextResponse.redirect(new URL(loginUrl, origin));

  const supabase = createServerClient(
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

  let userId: string | undefined;
  if (tokenHash) {
    if (!rawType || !VALID_EMAIL_OTP_TYPES.has(rawType as EmailOtpType)) {
      return NextResponse.redirect(
        new URL(`${loginUrl}?error=auth_callback_failed`, origin),
      );
    }
    const { error, data } = await supabase.auth.verifyOtp({
      type: rawType as EmailOtpType,
      token_hash: tokenHash,
    });
    if (error) {
      return NextResponse.redirect(
        new URL(`${loginUrl}?error=auth_callback_failed`, origin),
      );
    }
    userId = data.user?.id;
  } else {
    const { error, data } = await supabase.auth.exchangeCodeForSession(code!);
    if (error) {
      return NextResponse.redirect(
        new URL(`${loginUrl}?error=auth_callback_failed`, origin),
      );
    }
    userId = data.user?.id;
  }

  // Role-aware post-callback redirect. An owner arriving via an email link
  // must go to /dashboard, not /admin/overview (which they can't access).
  // If `next` points to a role-appropriate path, honor it; otherwise fall
  // back to the role's home page.
  let role: string | null = null;
  if (userId) {
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', userId)
      .limit(1)
      .single();
    if (userErr && userErr.code === 'PGRST116') {
      // PGRST116 = "Expected a single row. Got 0 or >1." We can't distinguish
      // here, but log both possibilities. >1 would be a data-integrity bug
      // (duplicate users.auth_id) that should page someone — auth_id is
      // UNIQUE per migration 001, so this would only happen mid-restore or
      // mid-migration. 0 rows is the expected Google-signup case.
      console.warn(
        `[callback] PGRST116 for auth_id=${userId} — either missing users row or duplicate auth_id. Investigate if duplicate.`,
      );
      role = null;
    } else {
      role = (userRow as { role: string } | null)?.role ?? null;
    }
  }

  // Google-signup branch: session exists but no users row yet → let the
  // owner finish provisioning instead of signing them out. Only applies
  // when next explicitly points at /signup/finish; any other "no users
  // row" case still signs out below.
  if (role === null && requestedNext === '/signup/finish') {
    const final = NextResponse.redirect(new URL('/signup/finish', origin));
    for (const cookie of response.cookies.getAll()) {
      final.cookies.set(cookie);
    }
    return final;
  }

  // "No users row" in any other flow → sign out + account_incomplete.
  // Redirecting anywhere else causes a middleware-redirect loop. Sign
  // them out so they can retry cleanly with a different account.
  //
  // signOut writes cleared session cookies into the `response` jar via
  // the setAll adapter on lines 80–84. We MUST copy those cookies onto
  // the redirect we return — without that, the browser keeps the bad
  // session and bounces in a redirect loop on the next protected request.
  if (role === null) {
    await supabase.auth.signOut();
    const incomplete = NextResponse.redirect(
      new URL(`${loginUrl}?error=account_incomplete`, origin),
    );
    for (const cookie of response.cookies.getAll()) {
      incomplete.cookies.set(cookie);
    }
    return incomplete;
  }

  if (role === 'sales_partner') {
    await supabase.auth.signOut();
    const unsupported = NextResponse.redirect(
      new URL(`${loginUrl}?error=unsupported_role`, origin),
    );
    for (const cookie of response.cookies.getAll()) {
      unsupported.cookies.set(cookie);
    }
    return unsupported;
  }

  if (role !== 'owner' && role !== 'admin') {
    await supabase.auth.signOut();
    const incomplete = NextResponse.redirect(
      new URL(`${loginUrl}?error=account_incomplete`, origin),
    );
    for (const cookie of response.cookies.getAll()) {
      incomplete.cookies.set(cookie);
    }
    return incomplete;
  }

  if (
    requestedNext === '/reset-password' ||
    requestedNext === '/admin/reset-password'
  ) {
    const final = NextResponse.redirect(new URL(requestedNext, origin));
    for (const cookie of response.cookies.getAll()) {
      final.cookies.set(cookie);
    }
    return final;
  }

  // Role-aware destination resolution for supported runtime roles.
  const nextIsAdmin = requestedNext.startsWith('/admin');
  const nextIsOwner =
    requestedNext.startsWith('/dashboard') ||
    requestedNext.startsWith('/settings') ||
    requestedNext.startsWith('/onboarding');

  let destination: string;
  if (role === 'owner') {
    destination = nextIsOwner ? requestedNext : '/dashboard';
  } else {
    destination = nextIsAdmin ? requestedNext : '/admin/overview';
  }

  // Build a fresh redirect response with the resolved destination, copying
  // the session cookies that `exchangeCodeForSession` wrote via setAll above.
  const finalResponse = NextResponse.redirect(new URL(destination, origin));
  for (const cookie of response.cookies.getAll()) {
    finalResponse.cookies.set(cookie);
  }
  return finalResponse;
}
