import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Creates a Supabase client for use in Next.js middleware.
 * Reads cookies from the request and writes refreshed tokens to both
 * the request (for downstream server components) and the response (for the browser).
 *
 * Returns { supabase, response } — caller must return this response.
 */
export function createSupabaseMiddlewareClient(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Forward refreshed cookies to the request (for server components)
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          // Rebuild response with updated request so downstream sees new cookies
          response = NextResponse.next({ request });
          // Forward refreshed cookies to the response (for the browser)
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  return { supabase, response: () => response };
}
