import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isAuthFlow, loginUrlForFlow, type AuthFlow } from '@/lib/shared/auth-flow';

/**
 * Supabase auth callback handler.
 *
 * Exchanges the auth code for a session and sets the cookie. Serves three
 * distinct flows, distinguished by `flow=` and `next=` query params:
 *
 *  1. **Email confirmation** (signup `emailRedirectTo`) — `flow=owner|admin`
 *     + `next=/onboarding/pay`. Normal role-lookup-then-redirect flow.
 *  2. **Password recovery** (resetPasswordForEmail `redirectTo`) — `flow=...`
 *     + `next=/reset-password` or `/admin/reset-password`. We skip the role
 *     lookup entirely and just land on the reset page, which reads the
 *     session directly via `supabase.auth.getUser()`.
 *  3. **Google OAuth signup** — `flow=owner` + `next=/signup/finish`. The
 *     Supabase Auth user exists (Google just confirmed it) but there's no
 *     app `users` row yet. Land on `/signup/finish` so the owner can finish
 *     provisioning their business, instead of signing out.
 *
 * Failure redirect target is derived from `flow` via `loginUrlForFlow` so
 * owners land on `/login` and admins on `/admin/login`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawFlow = searchParams.get('flow');
  const flow: AuthFlow | undefined = isAuthFlow(rawFlow) ? rawFlow : undefined;
  const rawNext = searchParams.get('next') ?? '';
  // Restrict redirect to safe internal paths (no //, no external URLs).
  const nextIsSafe =
    rawNext.startsWith('/') && !rawNext.startsWith('//');
  const requestedNext = nextIsSafe ? rawNext : '';
  const loginUrl = loginUrlForFlow(flow);

  if (!code) {
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

  const { error, data } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL(`${loginUrl}?error=auth_callback_failed`, origin),
    );
  }

  // Recovery branches — reset page reads session directly, no role lookup.
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

  // Role-aware post-callback redirect. An owner arriving via an email link
  // must go to /dashboard, not /admin/overview (which they can't access).
  // If `next` points to a role-appropriate path, honor it; otherwise fall
  // back to the role's home page.
  const authId = data.user?.id;
  let role: string | null = null;
  if (authId) {
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', authId)
      .limit(1)
      .single();
    if (userErr && userErr.code === 'PGRST116') {
      // PGRST116 = "Expected a single row. Got 0 or >1." We can't distinguish
      // here, but log both possibilities. >1 would be a data-integrity bug
      // (duplicate users.auth_id) that should page someone — auth_id is
      // UNIQUE per migration 001, so this would only happen mid-restore or
      // mid-migration. 0 rows is the expected Google-signup case.
      console.warn(
        `[callback] PGRST116 for auth_id=${authId} — either missing users row or duplicate auth_id. Investigate if duplicate.`,
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
  if (role === null) {
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL(`${loginUrl}?error=account_incomplete`, origin),
    );
  }

  // Role-aware destination resolution.
  const nextIsAdmin = requestedNext.startsWith('/admin');
  const nextIsOwner =
    requestedNext.startsWith('/dashboard') ||
    requestedNext.startsWith('/settings') ||
    requestedNext.startsWith('/onboarding');

  let destination: string;
  if (role === 'owner') {
    destination = nextIsOwner ? requestedNext : '/dashboard';
  } else if (role === 'admin' || role === 'sales_partner') {
    destination = nextIsAdmin ? requestedNext : '/admin/overview';
  } else {
    // Unknown role — treat as account_incomplete. Same signOut path as the
    // no-users-row branch above.
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL(`${loginUrl}?error=account_incomplete`, origin),
    );
  }

  // Build a fresh redirect response with the resolved destination, copying
  // the session cookies that `exchangeCodeForSession` wrote via setAll above.
  const finalResponse = NextResponse.redirect(new URL(destination, origin));
  for (const cookie of response.cookies.getAll()) {
    finalResponse.cookies.set(cookie);
  }
  return finalResponse;
}
