# Prompt 14a: Supabase Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stopgap API key auth with Supabase Auth (email/password), enforcing role-based access for admin, sales_partner, and owner routes.

**Architecture:** The existing `ADMIN_API_KEY` cookie middleware is replaced by `@supabase/ssr`'s cookie-based session management. A `createServerClient` helper reads/writes Supabase auth cookies. Middleware refreshes the session on every request and checks user roles by looking up the app `users` table via `auth_id`. Route handlers perform a second `requireRole()` check as defense-in-depth.

**Tech Stack:** `@supabase/ssr`, `@supabase/supabase-js` (already installed), Next.js 14 middleware, Postgres.js (`sql`)

---

## Prerequisites (manual — do before any coding)

1. In Supabase dashboard: Authentication -> Providers -> enable Email provider (should already be on)
2. In Supabase dashboard: Authentication -> Users -> Add User (email/password) for admin account
3. In Supabase dashboard: Authentication -> Users -> Add User (email/password) for sales_partner account
4. Run seed SQL in Supabase SQL Editor:
   ```sql
   UPDATE users SET auth_id = '<admin-auth-user-uuid>' WHERE email = 'norbertesekiel@gmail.com';
   UPDATE users SET auth_id = '<sales-partner-auth-user-uuid>' WHERE email = 'partner@email.com';
   ```
5. Run RLS migration (Task 1 below creates the file, you apply it)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/db/auth.ts` | **CREATE** | Server-side auth helpers: `getCurrentUser`, `requireAuth`, `requireRole` |
| `src/lib/db/supabase-server.ts` | **CREATE** | `createSupabaseServerClient(cookieStore)` — cookie-aware server client for route handlers/server components |
| `src/lib/db/supabase-middleware.ts` | **CREATE** | `createSupabaseMiddlewareClient(request)` — cookie-aware client for middleware (read+write cookies on request/response) |
| `src/lib/db/browser.ts` | **MODIFY** | Replace bare `createClient` with `createBrowserClient` from `@supabase/ssr` |
| `src/middleware.ts` | **REWRITE** | Supabase session refresh + role-based route protection |
| `src/app/admin/login/page.tsx` | **REWRITE** | Email+password login via `supabaseClient.auth.signInWithPassword()` |
| `src/app/api/auth/callback/route.ts` | **CREATE** | Supabase auth code exchange for cookie sessions |
| `src/app/api/admin/auth/route.ts` | **DELETE** | Old API key auth route — no longer needed |
| `supabase/migrations/006_users_rls_policy.sql` | **CREATE** | Minimal RLS policy for user self-lookup |
| `src/app/api/admin/demos/generate/route.ts` | **MODIFY** | Add `requireRole()` call (defense-in-depth) |
| `src/app/api/admin/demos/route.ts` | **MODIFY** | Add `requireRole()` call |
| `src/app/api/admin/businesses/[id]/mark-posted/route.ts` | **MODIFY** | Add `requireRole()` call |

---

## Task 1: Install `@supabase/ssr` + create RLS migration

**Files:**
- Modify: `package.json`
- Create: `supabase/migrations/006_users_rls_policy.sql`

- [ ] **Step 1: Install @supabase/ssr**

```bash
pnpm add @supabase/ssr
```

- [ ] **Step 2: Create RLS migration file**

Create `supabase/migrations/006_users_rls_policy.sql`:

```sql
-- Minimal RLS policy: authenticated users can read their own users row.
-- auth_id is VARCHAR(255), auth.uid() returns UUID — cast to text for comparison.
-- This is the ONLY policy needed for Sprint 3. Browser clients do NOT query
-- business/review/response tables directly — admin data flows through server
-- API routes using the service-role client.

CREATE POLICY users_self_select ON users
  FOR SELECT
  TO authenticated
  USING (auth_id = auth.uid()::text);
```

- [ ] **Step 3: Verify installation**

```bash
pnpm list @supabase/ssr
```

Expected: `@supabase/ssr` version appears in output.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml supabase/migrations/006_users_rls_policy.sql
git commit -m "chore: install @supabase/ssr, add users self-select RLS policy"
```

**Note:** Apply migration 006 in Supabase SQL Editor before testing auth flows.

---

## Task 2: Create Supabase server client helpers

**Files:**
- Create: `src/lib/db/supabase-server.ts`
- Create: `src/lib/db/supabase-middleware.ts`

- [ ] **Step 1: Create the server-component/route-handler client**

Create `src/lib/db/supabase-server.ts`:

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Creates a Supabase client for use in Server Components and Route Handlers.
 * Uses the ANON key (not service role) so RLS policies apply.
 * Must be called inside a request context (server component or route handler).
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // setAll called from a Server Component — can't write cookies.
            // The middleware handles the session refresh instead.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 2: Create the middleware client**

Create `src/lib/db/supabase-middleware.ts`:

```typescript
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
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/supabase-server.ts src/lib/db/supabase-middleware.ts
git commit -m "feat: add @supabase/ssr server + middleware client helpers"
```

---

## Task 3: Create server-side auth helpers

**Files:**
- Create: `src/lib/db/auth.ts`

- [ ] **Step 1: Create auth.ts with getCurrentUser, requireAuth, requireRole**

Create `src/lib/db/auth.ts`:

```typescript
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: string;
  businessId: string | null;
}

/**
 * Reads the Supabase session from request cookies and maps the auth identity
 * to the app `users` table. Returns null if unauthenticated or no matching user row.
 *
 * Uses getUser() (not getSession()) — getUser() validates the token with the
 * Supabase Auth server on every call, which is required for server-side trust.
 */
export async function getCurrentUser(
  request: NextRequest,
): Promise<AppUser | null> {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Route handlers can't set cookies on a request object.
          // Session refresh is handled by middleware.
        },
      },
    },
  );

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) return null;

  // Map Supabase Auth identity to app user
  const rows = await sql`
    SELECT id, name, email, role, business_id
    FROM users
    WHERE auth_id = ${authUser.id}
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    role: row.role as string,
    businessId: (row.business_id as string) ?? null,
  };
}

/**
 * Throws a structured error if the user is not authenticated.
 */
export async function requireAuth(request: NextRequest): Promise<AppUser> {
  const user = await getCurrentUser(request);
  if (!user) {
    throw new AuthError('Unauthorized', 401);
  }
  return user;
}

/**
 * Throws a structured error if the user doesn't have one of the required roles.
 */
export async function requireRole(
  request: NextRequest,
  ...roles: string[]
): Promise<AppUser> {
  const user = await requireAuth(request);
  if (!roles.includes(user.role)) {
    throw new AuthError('Forbidden', 403);
  }
  return user;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/auth.ts
git commit -m "feat: add server-side auth helpers (getCurrentUser, requireAuth, requireRole)"
```

---

## Task 4: Update browser client to use @supabase/ssr

**Files:**
- Modify: `src/lib/db/browser.ts`

- [ ] **Step 1: Rewrite browser.ts**

Replace the contents of `src/lib/db/browser.ts`:

```typescript
import { createBrowserClient } from '@supabase/ssr';

/**
 * Supabase browser client — auth-aware, manages cookies automatically.
 * Uses the anon key. Safe for browser bundles.
 *
 * Call this function (not a singleton) so @supabase/ssr manages cookies correctly.
 * The library deduplicates internally — multiple calls return the same instance.
 */
export function createBrowserSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/**
 * @deprecated Use createBrowserSupabaseClient() instead.
 * Kept temporarily for any existing client-component imports.
 */
export const supabaseClient = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
```

- [ ] **Step 2: Check for existing imports of supabaseClient**

```bash
grep -r "supabaseClient" src/ --include="*.ts" --include="*.tsx" -l
```

If any files import `supabaseClient`, they still work via the deprecated export. No changes needed now.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/browser.ts
git commit -m "feat: update browser client to use @supabase/ssr createBrowserClient"
```

---

## Task 5: Rewrite middleware with Supabase Auth

**Files:**
- Rewrite: `src/middleware.ts`

- [ ] **Step 1: Rewrite middleware.ts**

Replace the contents of `src/middleware.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseMiddlewareClient } from '@/lib/db/supabase-middleware';

/**
 * Next.js middleware: refreshes Supabase auth session on every matched request,
 * then enforces role-based access.
 *
 * - /admin/* (except /admin/login): require admin or sales_partner role
 * - /api/admin/*: require admin or sales_partner role (returns 401 JSON)
 * - /dashboard/*, /settings/*: require owner role with non-null business_id
 * - /api/approve/*: NO auth (token-based approval flow)
 * - /(public)/* pages: NO auth
 */
export async function middleware(request: NextRequest) {
  const { supabase, response: getResponse } =
    createSupabaseMiddlewareClient(request);

  // Always refresh the session — even for public routes — so the cookie stays alive
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // ---- Admin pages (except /admin/login) ----
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const role = await lookupRole(authUser.id);
    if (!role || !['admin', 'sales_partner'].includes(role)) {
      return redirectToLogin(request);
    }
  }

  // ---- Admin API routes ----
  if (pathname.startsWith('/api/admin')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const role = await lookupRole(authUser.id);
    if (!role || !['admin', 'sales_partner'].includes(role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // ---- Owner pages ----
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings')) {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const userRow = await lookupUserRow(authUser.id);
    if (!userRow || userRow.role !== 'owner' || !userRow.business_id) {
      return redirectToLogin(request);
    }
  }

  return getResponse();
}

// --- Helpers (lightweight queries, run in middleware edge context via service client) ---

import { sql } from '@/lib/db/server';

async function lookupRole(authId: string): Promise<string | null> {
  const rows = await sql`
    SELECT role FROM users WHERE auth_id = ${authId} LIMIT 1
  `;
  return (rows[0]?.role as string) ?? null;
}

async function lookupUserRow(
  authId: string,
): Promise<{ role: string; business_id: string | null } | null> {
  const rows = await sql`
    SELECT role, business_id FROM users WHERE auth_id = ${authId} LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    role: rows[0].role as string,
    business_id: (rows[0].business_id as string) ?? null,
  };
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL('/admin/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
    '/dashboard/:path*',
    '/settings/:path*',
  ],
};
```

**Important note on runtime:** Next.js middleware runs in the Edge Runtime by default, but `postgres` (Postgres.js) uses Node.js TCP sockets which are not available in the Edge Runtime. We must opt into the Node.js runtime for middleware:

Add at the top of `src/middleware.ts` (before any imports):

```typescript
export const runtime = 'nodejs';
```

If Next.js 14 doesn't support `runtime` export in middleware, an alternative is to use the Supabase service-role client for the role lookup instead of `sql`. Let me check — actually, Next.js 14 middleware does NOT support the `runtime` export. The middleware always runs on Edge.

**Revised approach:** Use `supabaseServer` (service-role client via `@supabase/supabase-js` — HTTP-based, works on Edge) for the role lookup in middleware instead of `sql` (Postgres.js — TCP-based, Node.js only).

- [ ] **Step 1 (revised): Rewrite middleware.ts using supabaseServer for role lookups**

Replace the contents of `src/middleware.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

// Service-role client for role lookups (HTTP-based, Edge-compatible).
// Middleware can't use Postgres.js (TCP sockets not available on Edge Runtime).
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

export async function middleware(request: NextRequest) {
  // 1. Create a Supabase client that reads/writes auth cookies
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
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // 2. Refresh the session (validates token with Supabase Auth server)
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // 3. Admin pages (except /admin/login)
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const role = await lookupRole(authUser.id);
    if (!role || !['admin', 'sales_partner'].includes(role)) {
      return redirectToLogin(request);
    }
  }

  // 4. Admin API routes
  if (pathname.startsWith('/api/admin')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const role = await lookupRole(authUser.id);
    if (!role || !['admin', 'sales_partner'].includes(role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // 5. Owner pages (future — not built yet, but guard is in place)
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings')) {
    if (!authUser) {
      return redirectToLogin(request);
    }
    const { data } = await supabaseAdmin
      .from('users')
      .select('role, business_id')
      .eq('auth_id', authUser.id)
      .limit(1)
      .single();
    if (!data || data.role !== 'owner' || !data.business_id) {
      return redirectToLogin(request);
    }
  }

  return response;
}

async function lookupRole(authId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('auth_id', authId)
    .limit(1)
    .single();
  return data?.role ?? null;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL('/admin/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/admin/:path((?!login).*)',  // /admin/* except /admin/login
    '/api/admin/:path*',
    '/dashboard/:path*',
    '/settings/:path*',
  ],
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: rewrite middleware with Supabase Auth session refresh + role-based protection"
```

---

## Task 6: Rewrite login page

**Files:**
- Rewrite: `src/app/admin/login/page.tsx`

- [ ] **Step 1: Rewrite the login page to use Supabase Auth**

Replace the contents of `src/app/admin/login/page.tsx`:

```tsx
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          RepWorth Admin
        </h1>
        <div className="bg-white rounded-lg border border-gray-200 p-6 h-48 animate-pulse" />
      </div>
    </div>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();
  const from = searchParams.get('from') ?? '/admin/overview';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const supabase = createBrowserSupabaseClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
        return;
      }

      // Session cookie is set automatically by @supabase/ssr.
      // Redirect to the originally requested page.
      router.push(from);
      router.refresh(); // Force middleware to re-evaluate with new session
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">
          RepWorth Admin
        </h1>
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/login/page.tsx
git commit -m "feat: rewrite admin login page with Supabase Auth email/password"
```

---

## Task 7: Create auth callback route + delete old auth route

**Files:**
- Create: `src/app/api/auth/callback/route.ts`
- Delete: `src/app/api/admin/auth/route.ts`

- [ ] **Step 1: Create the auth callback route**

Create `src/app/api/auth/callback/route.ts`:

```typescript
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
  const next = searchParams.get('next') ?? '/admin/overview';

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
```

- [ ] **Step 2: Delete the old API key auth route**

```bash
rm src/app/api/admin/auth/route.ts
```

If the directory `src/app/api/admin/auth/` is now empty, remove it too:

```bash
rmdir src/app/api/admin/auth 2>/dev/null || true
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/auth/callback/route.ts
git rm src/app/api/admin/auth/route.ts
git commit -m "feat: add Supabase auth callback route, delete old API key auth route"
```

---

## Task 8: Add requireRole() defense-in-depth to existing admin API routes

**Files:**
- Modify: `src/app/api/admin/demos/generate/route.ts`
- Modify: `src/app/api/admin/demos/route.ts`
- Modify: `src/app/api/admin/businesses/[id]/mark-posted/route.ts`

Every `/api/admin/*` route must call `requireRole()` even though middleware also checks. Middleware is the coarse gate; the route handler is the authorization boundary.

- [ ] **Step 1: Add requireRole to POST /api/admin/demos/generate**

In `src/app/api/admin/demos/generate/route.ts`, add the import and auth check at the top of the POST handler:

```typescript
// Add to imports at top of file:
import { requireRole, AuthError } from '@/lib/db/auth';
```

Add as the FIRST lines inside the `POST` function body:

```typescript
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
```

Remove the comment `// Auth handled by src/middleware.ts — Sprint 3 replaces with Supabase Auth role check`.

- [ ] **Step 2: Read and update GET /api/admin/demos**

Read `src/app/api/admin/demos/route.ts`. Add the same pattern:

```typescript
import { requireRole, AuthError } from '@/lib/db/auth';
```

Add as the FIRST lines inside the `GET` function body:

```typescript
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
```

- [ ] **Step 3: Read and update POST /api/admin/businesses/[id]/mark-posted**

Read `src/app/api/admin/businesses/[id]/mark-posted/route.ts`. Add the same pattern:

```typescript
import { requireRole, AuthError } from '@/lib/db/auth';
```

Add as the FIRST lines inside the `POST` function body:

```typescript
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/demos/generate/route.ts src/app/api/admin/demos/route.ts src/app/api/admin/businesses/\[id\]/mark-posted/route.ts
git commit -m "feat: add requireRole() defense-in-depth to all admin API routes"
```

---

## Task 9: Update admin layout comment + cleanup

**Files:**
- Modify: `src/app/admin/layout.tsx`

- [ ] **Step 1: Update the layout comment**

In `src/app/admin/layout.tsx`, replace the old comment:

```typescript
// Auth handled by src/middleware.ts (ADMIN_API_KEY cookie check)
// Sprint 3: replace with Supabase Auth role check (admin/sales_partner)
```

with:

```typescript
// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)
```

- [ ] **Step 2: Verify build succeeds**

```bash
pnpm build
```

Expected: build completes successfully, all pages compile.

- [ ] **Step 3: Verify existing tests still pass**

```bash
pnpm test
```

Expected: 189/189 tests pass (no auth-related unit tests were broken — auth is middleware + route handler concern, not business logic).

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/layout.tsx
git commit -m "chore: update admin layout auth comment for Supabase Auth"
```

---

## Task 10: Manual verification

This task is NOT automated — it requires the user to have applied the RLS migration and created Supabase Auth accounts.

- [ ] **Step 1: Apply migration 006 in Supabase SQL Editor**

Run the contents of `supabase/migrations/006_users_rls_policy.sql` in the Supabase dashboard SQL Editor.

- [ ] **Step 2: Create Supabase Auth accounts and link them**

In Supabase dashboard -> Authentication -> Users -> Add User:
- Create admin account (email + password)
- Create sales_partner account (email + password)

Then run seed SQL to link:
```sql
UPDATE users SET auth_id = '<admin-auth-uuid>' WHERE email = 'norbertesekiel@gmail.com';
UPDATE users SET auth_id = '<partner-auth-uuid>' WHERE email = 'partner@email.com';
```

- [ ] **Step 3: Start dev server and verify**

```bash
pnpm dev
```

Test these scenarios:
1. Visit `/admin/overview` without logging in -> redirected to `/admin/login`
2. Visit `/admin/login` -> see email+password form
3. Log in with admin credentials -> redirected to `/admin/overview`
4. Visit `/admin/demos` -> page loads (session active)
5. Visit `/approve/{any-valid-token}` -> page loads without auth (public)
6. Visit `/demo/{any-slug}` -> page loads without auth (public)
7. Call `GET /api/admin/demos` without session -> 401
8. Call `GET /api/admin/demos` with session -> 200

- [ ] **Step 4: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: any verification fixes for Supabase Auth"
```

---

## Verification Checklist

- [ ] Login works with Supabase credentials (email/password)
- [ ] Admin pages protected — unauthenticated users redirected to /admin/login
- [ ] Admin API routes return 401 for unauthenticated requests
- [ ] Public pages (demo viewer at /demo/[slug], approval page at /approve/[token]) work without auth
- [ ] Approval token-based flow is unaffected (no auth required)
- [ ] Old `__admin_key` cookie auth is fully removed
- [ ] `src/app/api/admin/auth/route.ts` is deleted
- [ ] Every `/api/admin/*` route has `requireRole()` defense-in-depth
- [ ] RLS policy exists: users can SELECT their own row
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` — 189/189 tests pass
