import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Supabase auth callback handler.
 * Exchanges the auth code for a session and sets the cookie.
 * Required by @supabase/ssr for OAuth flows and email confirmation links.
 * For email/password sign-in, the browser client handles the session directly,
 * but this route is still needed if Supabase sends confirmation/reset emails.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawNext = searchParams.get('next') ?? '';
  // Restrict redirect to safe internal paths (no //, no external URLs).
  // Do NOT default to /admin/overview — we don't know the user's role yet.
  // The role-aware fallback below picks /dashboard vs /admin/overview AFTER
  // the session is established and we can look up the user's role.
  const nextIsSafe =
    rawNext.startsWith('/') && !rawNext.startsWith('//');
  const requestedNext = nextIsSafe ? rawNext : '';

  if (!code) {
    return NextResponse.redirect(new URL('/admin/login', origin));
  }

  // Temporary redirect target — will be rewritten after role lookup below.
  const response = NextResponse.redirect(new URL('/admin/overview', origin));

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
    return NextResponse.redirect(new URL('/admin/login', origin));
  }

  // Role-aware post-callback redirect. An owner arriving via an email link
  // must go to /dashboard, not /admin/overview (which they can't access).
  // If `next` points to a role-appropriate path, honor it; otherwise fall
  // back to the role's home page.
  const authId = data.user?.id;
  let role: string | null = null;
  if (authId) {
    const { data: userRow } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', authId)
      .limit(1)
      .single();
    role = (userRow as { role: string } | null)?.role ?? null;
  }

  const nextIsAdmin = requestedNext.startsWith('/admin');
  const nextIsOwner =
    requestedNext.startsWith('/dashboard') ||
    requestedNext.startsWith('/settings');
  let destination: string;
  if (role === 'owner') {
    destination = nextIsOwner ? requestedNext : '/dashboard';
  } else if (role === 'admin' || role === 'sales_partner') {
    destination = nextIsAdmin ? requestedNext : '/admin/overview';
  } else {
    // Authenticated with Supabase but no app `users` row / unknown role.
    // Redirecting anywhere causes a middleware-redirect loop. Send them
    // back to the login page with an account_incomplete flag so the page
    // can surface a user-facing error. Sign them out first so they can
    // retry cleanly with a different account if needed.
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL('/admin/login?error=account_incomplete', origin),
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
