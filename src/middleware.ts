import { NextRequest, NextResponse } from 'next/server';

/**
 * Protects /admin/* pages and /api/admin/* API routes.
 *
 * - ADMIN_API_KEY unset + NODE_ENV=development → open access (local dev)
 * - ADMIN_API_KEY unset + production → all admin access blocked (fail-closed)
 * - ADMIN_API_KEY set → requires __admin_key cookie matching the key
 *
 * Replaced by Supabase Auth in Sprint 3.
 */
export function middleware(request: NextRequest) {
  const secret = process.env.ADMIN_API_KEY;
  const isDev = process.env.NODE_ENV === 'development';

  // No key configured: open in dev, blocked in prod
  if (!secret) {
    if (isDev) return NextResponse.next();
    return blockRequest(request);
  }

  // Check cookie (sent automatically by browser on every request)
  const cookieKey = request.cookies.get('__admin_key')?.value;
  if (cookieKey === secret) {
    return NextResponse.next();
  }

  // Check header (for programmatic API access)
  const headerKey = request.headers.get('x-admin-key');
  if (headerKey === secret) {
    return NextResponse.next();
  }

  return blockRequest(request);
}

function blockRequest(request: NextRequest): NextResponse {
  const isApi = request.nextUrl.pathname.startsWith('/api/');
  if (isApi) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Redirect pages to login
  const loginUrl = new URL('/admin/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/admin/:path((?!login).*)', // all /admin/* except /admin/login
    '/api/admin/:path*',         // all /api/admin/*
  ],
};
