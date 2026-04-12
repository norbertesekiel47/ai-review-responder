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
  const rawNext = searchParams.get('next') ?? '/admin/overview';
  // Restrict redirect to safe internal paths to prevent open redirects
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/admin/overview';

  if (!code) {
    return NextResponse.redirect(new URL('/admin/login', origin));
  }

  const response = NextResponse.redirect(new URL(next, origin));

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/admin/login', origin));
  }

  return response;
}
