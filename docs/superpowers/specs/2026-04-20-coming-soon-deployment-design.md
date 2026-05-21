# Coming-Soon Deployment to repworth.net

**Date:** 2026-04-20  
**Status:** Approved (rev 3 — post second review)  
**Purpose:** Publish a public-facing landing page at `repworth.net` for Google GBP API and Twilio ADP applications, while the full product remains in development at `rep-worth.vercel.app`.

---

## Goal

- `repworth.net` serves only the homepage in "coming soon" mode — all "Book a Demo" CTAs replaced with "Coming Soon", all other routes redirect to `/`
- `repworth.net/privacy` and `repworth.net/terms` are accessible (required by API applications)
- `rep-worth.vercel.app` is completely unaffected — existing app behaviour unchanged, all auth protections preserved

---

## Architecture

Single Vercel project, single build. `repworth.net` and `www.repworth.net` are added as custom domains in the Vercel dashboard alongside the existing `rep-worth.vercel.app` domain. No new repo, no new Vercel project.

### DNS (GoDaddy → Vercel)

| Type  | Name | Value                  |
|-------|------|------------------------|
| A     | @    | 76.76.21.21            |
| CNAME | www  | cname.vercel-dns.com   |

### www canonical redirect (Vercel dashboard)

In the Vercel project's Domains settings, configure `www.repworth.net` to **redirect to `repworth.net`** (apex redirect). This redirect happens at Vercel's CDN layer before any Next.js middleware runs, so middleware only needs to check for host `repworth.net`.

---

## Middleware (`src/middleware.ts`)

**Modify the existing `src/middleware.ts`** — do NOT create a new root-level file. The coming-soon hostname check is added as a **short-circuit at the very top** of the `middleware` function, before any Supabase client construction or `auth.getUser()` call.

### Matcher

The existing matcher covers only protected paths. It must be expanded to catch all requests, while excluding Next.js internals to prevent breaking static asset loading:

```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

This is the standard Next.js exclusion pattern. `/_next/static/*`, `/_next/image/*`, and `/favicon.ico` are never intercepted — they pass through to the CDN unconditionally.

This expands the surface, so the middleware must guard against Supabase overhead on unprotected paths (see logic below).

### Middleware logic

```
1. Check host header
   ├─ host === 'repworth.net'
   │   ├─ path === '/' or '/privacy' or '/terms'
   │   │       → set x-coming-soon: 1 request header, NextResponse.next()
   │   └─ anything else
   │           → 307 redirect to https://repworth.net/
   │
   └─ any other host
       ├─ path is NOT a protected route → NextResponse.next() immediately (no Supabase work)
       └─ path IS a protected route     → existing Supabase auth logic (unchanged)
```

The "protected route" check uses **segment-safe boundaries** (required because the matcher now runs on every non-asset path):

```ts
function isProtectedRoute(pathname: string): boolean {
  return (
    (pathname === '/admin' || pathname.startsWith('/admin/')) && pathname !== '/admin/login' ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/') ||
    pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/') ||
    pathname === '/api/settings' || pathname.startsWith('/api/settings/') ||
    pathname === '/dashboard' || pathname.startsWith('/dashboard/') ||
    pathname === '/settings' || pathname.startsWith('/settings/')
  );
}
```

Using `/admin/` (with trailing slash) rather than raw `/admin` prevents a hypothetical `/administration` path from being treated as protected.

**Clarification:** "all other hosts pass through unchanged" means no coming-soon behaviour is applied — it does NOT mean auth middleware is skipped. Existing auth checks run as before for protected paths on any non-repworth.net host.

**Clarification:** "all other hosts pass through unchanged" means no coming-soon behaviour is applied — it does NOT mean auth middleware is skipped. Existing auth checks run as before for protected paths on any non-repworth.net host.

### Setting x-coming-soon as a request header

To make the header readable by server components via `headers()`, it must be set on the **request**, not the response:

```ts
const requestHeaders = new Headers(request.headers);
requestHeaders.set('x-coming-soon', '1');
return NextResponse.next({ request: { headers: requestHeaders } });
```

---

## Landing Page Refactor

### Files changed

**`src/app/(public)/page.tsx`** — converted from `'use client'` to a Server Component:

```tsx
import { headers } from 'next/headers';
import { LandingContent } from './components/landing/LandingContent';

export default function LandingPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  return <LandingContent comingSoon={comingSoon} />;
}
```

**`src/app/(public)/components/landing/LandingContent.tsx`** — new file containing the existing landing page code (moved verbatim from `page.tsx`), with `'use client'` directive and one new prop:

```tsx
interface LandingContentProps {
  comingSoon: boolean;
}
export function LandingContent({ comingSoon }: LandingContentProps) { ... }
```

### UI changes when `comingSoon === true`

| Element | Normal | Coming Soon |
|---------|--------|-------------|
| Hero button | "Book a Demo" (scrolls to CTA) | "Coming Soon" — `onClick` removed, `cursor-default opacity-60` |
| Nav link | "Book a Demo" link to `/book-a-demo` | Hidden |
| Dot nav (desktop) | Last dot labelled "Book a Demo" | Last dot hidden |
| CTA section | `<ContactForm />` with copy | Replaced with centred text: *"Launching soon — we'll be in touch."* |

---

## Privacy & Terms Pages

Two new server-component pages under `src/app/(public)/`:

- `src/app/(public)/privacy/page.tsx` → `repworth.net/privacy`
- `src/app/(public)/terms/page.tsx` → `repworth.net/terms`

Both pages read the `x-coming-soon` header and pass `comingSoon` to `SiteNav`.

### SiteNav update

`SiteNav` receives a new optional prop `comingSoon?: boolean`. When `true`, the "Book a Demo" nav entry is hidden. This prevents the broken demo link appearing on legal pages when visited at `repworth.net`.

### Page structure (both legal pages)

```tsx
export default function PrivacyPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  return (
    <PageShell ...>
      <SiteNav comingSoon={comingSoon} />
      {/* legal content */}
    </PageShell>
  );
}
```

### Content

Substantive placeholder copy generated for both pages, covering:
- **Privacy:** data collected, how it's used, third-party services (Google, Stripe, Resend), data retention, user rights, contact info
- **Terms:** service description, acceptable use, payment terms, limitation of liability, termination, governing law

Written to satisfy API application reviewers (Google GBP, Twilio ADP). **Owner must review and customise before submitting applications.**

These pages are also accessible at `rep-worth.vercel.app/privacy` and `/terms` with the normal nav (no coming-soon suppression).

---

## Files Created / Modified

| File | Action |
|------|--------|
| `src/middleware.ts` | **Modified** — add repworth.net short-circuit at top; expand matcher to `/:path*`; guard Supabase work behind protected-path check |
| `src/app/(public)/page.tsx` | **Modified** — thin server component wrapper |
| `src/app/(public)/components/landing/LandingContent.tsx` | **New** — existing landing code + `comingSoon` prop |
| `src/app/(public)/components/shared/SiteNav.tsx` | **Modified** — add optional `comingSoon` prop, hide Book a Demo when true |
| `src/app/(public)/privacy/page.tsx` | **New** — Privacy Policy page (server component) |
| `src/app/(public)/terms/page.tsx` | **New** — Terms of Service page (server component) |

---

## Out of Scope

- Email capture / waitlist on the coming-soon landing
- Any changes to `/book-a-demo`, `/features`, `/pricing`, `/how-it-works` pages
- Automated redirect from `www.repworth.net` to apex (handled in Vercel dashboard, not middleware)
