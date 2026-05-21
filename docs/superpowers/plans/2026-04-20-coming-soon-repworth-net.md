# Coming-Soon Deployment to repworth.net — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a "coming soon" variant of the landing page at `repworth.net` (privacy + terms accessible, all other routes blocked) while leaving the existing app at `rep-worth.vercel.app` completely unchanged.

**Architecture:** The existing Vercel project gains `repworth.net` as a custom domain. A short-circuit at the top of the existing `src/middleware.ts` intercepts all `repworth.net` traffic before Supabase auth runs — setting an `x-coming-soon` request header for `/`, `/privacy`, and `/terms`, and issuing a 307 for everything else. The landing page `page.tsx` becomes a thin server-component wrapper that reads that header and passes `comingSoon: boolean` to the extracted `LandingContent` client component. Legal pages are new server components that do the same for `SiteNav`.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Vitest, Tailwind CSS, Framer Motion (`motion/react`), Supabase SSR middleware.

**Worker / backend are untouched.** All changes are in `src/middleware.ts` and `src/app/(public)/`.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/shared/protected-routes.ts` | **Create** | Pure `isProtectedRoute(pathname)` helper — testable with no Next.js imports |
| `src/lib/shared/protected-routes.test.ts` | **Create** | Vitest unit tests for `isProtectedRoute` |
| `src/middleware.ts` | **Modify** | Import helper; add repworth.net short-circuit; expand matcher; guard Supabase behind `isProtectedRoute` |
| `src/app/(public)/page.tsx` | **Modify** | Thin server component wrapper — reads `x-coming-soon`, passes `comingSoon` to `LandingContent` |
| `src/app/(public)/components/landing/LandingContent.tsx` | **Create** | Current landing page code, extracted to client component, `comingSoon` prop wires 4 UI changes |
| `src/app/(public)/components/shared/SiteNav.tsx` | **Modify** | Add optional `comingSoon?: boolean` prop — hides "Book a Demo" when true |
| `src/app/(public)/privacy/page.tsx` | **Create** | Privacy Policy — server component, reads `x-coming-soon`, passes to SiteNav |
| `src/app/(public)/terms/page.tsx` | **Create** | Terms of Service — server component, reads `x-coming-soon`, passes to SiteNav |

---

## Task 1: Extract `isProtectedRoute` helper and unit tests

**Files:**
- Create: `src/lib/shared/protected-routes.ts`
- Create: `src/lib/shared/protected-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/shared/protected-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isProtectedRoute } from './protected-routes';

describe('isProtectedRoute', () => {
  it('matches /admin and sub-paths', () => {
    expect(isProtectedRoute('/admin')).toBe(true);
    expect(isProtectedRoute('/admin/businesses')).toBe(true);
    expect(isProtectedRoute('/admin/businesses/123')).toBe(true);
  });

  it('does not match /admin/login', () => {
    expect(isProtectedRoute('/admin/login')).toBe(false);
  });

  it('does not match /administration (segment boundary)', () => {
    expect(isProtectedRoute('/administration')).toBe(false);
  });

  it('matches /api/admin paths', () => {
    expect(isProtectedRoute('/api/admin')).toBe(true);
    expect(isProtectedRoute('/api/admin/users')).toBe(true);
  });

  it('matches /api/dashboard and /api/settings paths', () => {
    expect(isProtectedRoute('/api/dashboard')).toBe(true);
    expect(isProtectedRoute('/api/dashboard/reviews')).toBe(true);
    expect(isProtectedRoute('/api/settings')).toBe(true);
    expect(isProtectedRoute('/api/settings/profile')).toBe(true);
  });

  it('matches /dashboard and /settings paths', () => {
    expect(isProtectedRoute('/dashboard')).toBe(true);
    expect(isProtectedRoute('/dashboard/reviews')).toBe(true);
    expect(isProtectedRoute('/settings')).toBe(true);
    expect(isProtectedRoute('/settings/notifications')).toBe(true);
  });

  it('does not match public paths', () => {
    expect(isProtectedRoute('/')).toBe(false);
    expect(isProtectedRoute('/privacy')).toBe(false);
    expect(isProtectedRoute('/terms')).toBe(false);
    expect(isProtectedRoute('/features')).toBe(false);
    expect(isProtectedRoute('/pricing')).toBe(false);
    expect(isProtectedRoute('/book-a-demo')).toBe(false);
    expect(isProtectedRoute('/how-it-works')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
pnpm test src/lib/shared/protected-routes.test.ts
```

Expected: FAIL — `Cannot find module './protected-routes'`

- [ ] **Step 3: Create the helper**

Create `src/lib/shared/protected-routes.ts`:

```ts
export function isProtectedRoute(pathname: string): boolean {
  if (pathname === '/admin/login') return false;
  return (
    pathname === '/admin' || pathname.startsWith('/admin/') ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/') ||
    pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/') ||
    pathname === '/api/settings' || pathname.startsWith('/api/settings/') ||
    pathname === '/dashboard' || pathname.startsWith('/dashboard/') ||
    pathname === '/settings' || pathname.startsWith('/settings/')
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
pnpm test src/lib/shared/protected-routes.test.ts
```

Expected: all 7 test cases PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/protected-routes.ts src/lib/shared/protected-routes.test.ts
git commit -m "feat(middleware): extract isProtectedRoute helper with segment-safe boundaries"
```

---

## Task 2: Refactor `src/middleware.ts`

**Files:**
- Modify: `src/middleware.ts`

Changes: (1) import `isProtectedRoute`, (2) add repworth.net short-circuit at the very top before any Supabase work, (3) guard Supabase auth behind `isProtectedRoute` so non-protected paths on other hosts skip Supabase overhead, (4) expand matcher to `/((?!_next/static|_next/image|favicon.ico).*)`.

- [ ] **Step 1: Replace `src/middleware.ts` with the updated version**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { isProtectedRoute } from '@/lib/shared/protected-routes';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

export async function middleware(request: NextRequest) {
  const host = request.headers.get('host') ?? '';

  // ── repworth.net: short-circuit before any Supabase work ─────────
  if (host === 'repworth.net') {
    const { pathname } = request.nextUrl;

    if (pathname === '/' || pathname === '/privacy' || pathname === '/terms') {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-coming-soon', '1');
      return NextResponse.next({ request: { headers: requestHeaders } });
    }

    return NextResponse.redirect(new URL('https://repworth.net/'), 307);
  }

  // ── All other hosts: skip Supabase for public paths ───────────────
  const { pathname } = request.nextUrl;
  if (!isProtectedRoute(pathname)) {
    return NextResponse.next({ request });
  }

  // ── Protected paths: existing Supabase auth logic ─────────────────
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

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

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

  // 5. Owner API routes
  if (pathname.startsWith('/api/dashboard') || pathname.startsWith('/api/settings')) {
    const noStoreHeaders = { 'Cache-Control': 'no-store, private' };
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders });
    }
    const { data } = await supabaseAdmin
      .from('users')
      .select('role, business_id')
      .eq('auth_id', authUser.id)
      .limit(1)
      .single();
    if (!data || data.role !== 'owner' || !data.business_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: noStoreHeaders });
    }
  }

  // 6. Owner pages
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: build succeeds with no TypeScript errors. The worker output is irrelevant — only watch for errors in `src/middleware.ts` and `src/lib/shared/protected-routes.ts`.

- [ ] **Step 3: Smoke test locally**

```bash
pnpm dev
```

Visit `http://localhost:3000` — landing page loads normally (no coming-soon mode, `host` header is `localhost:3000`).
Visit `http://localhost:3000/admin` — redirects to `/admin/login` as before.

- [ ] **Step 4: Commit**

```bash
git add src/middleware.ts
git commit -m "feat(middleware): add repworth.net short-circuit + expand matcher + guard Supabase to protected routes"
```

---

## Task 3: Extract `LandingContent.tsx` and convert `page.tsx` to server component

**Files:**
- Create: `src/app/(public)/components/landing/LandingContent.tsx`
- Modify: `src/app/(public)/page.tsx`

- [ ] **Step 1: Create `LandingContent.tsx`**

This is the full landing page code moved from `page.tsx` into a named export, with `comingSoon: boolean` prop wired to four UI changes (hero button, nav links, dot nav, CTA section).

Create `src/app/(public)/components/landing/LandingContent.tsx`:

```tsx
'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { motion, useScroll, useTransform } from 'motion/react';
import { HowItWorksCarousel } from './HowItWorksCarousel';
import type { CarouselStep } from './HowItWorksCarousel';
import { ContactForm } from './ContactForm';

const STEPS: CarouselStep[] = [
  {
    step: '01',
    title: 'Monitor',
    description: 'We poll your Google reviews every 60 minutes automatically.',
    color: '#D2E0D3',
  },
  {
    step: '02',
    title: 'Generate',
    description: 'AI drafts a personalised response that sounds like you wrote it.',
    color: '#F0DDD6',
  },
  {
    step: '03',
    title: 'Approve',
    description: 'You get an email. Tap approve, edit, or regenerate. 30 seconds.',
    color: '#F2C3B9',
  },
  {
    step: '04',
    title: 'Post',
    description: 'The approved response is posted to Google on your behalf.',
    color: '#D6CBBF',
  },
];

const FEATURES = [
  {
    color: '#97B3AE',
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    title: 'Your voice, automated',
    description: 'Trained on your best responses',
  },
  {
    color: '#F2C3B9',
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
    title: 'Instant responses',
    description: 'Reply within minutes, not days',
  },
  {
    color: '#D6CBBF',
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    title: 'Always on brand',
    description: 'Consistent tone across all platforms',
  },
];

interface LandingContentProps {
  comingSoon: boolean;
}

export function LandingContent({ comingSoon }: LandingContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const howItWorksRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const bgY1 = useTransform(scrollYProgress, [0, 1], [0, -300]);
  const bgY2 = useTransform(scrollYProgress, [0, 1], [0, -500]);
  const bgY3 = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const bgY4 = useTransform(scrollYProgress, [0, 1], [0, -400]);

  const scrollTo = (ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const navLinks = [
    { label: 'Features', href: '/features' },
    { label: 'How it works', href: '/how-it-works' },
    { label: 'Pricing', href: '/pricing' },
    ...(comingSoon ? [] : [{ label: 'Book a Demo', href: '/book-a-demo' }]),
  ];

  const dotNavItems = [
    { ref: heroRef, label: 'Hero' },
    { ref: featuresRef, label: 'Features' },
    { ref: howItWorksRef, label: 'How it works' },
    ...(comingSoon ? [] : [{ ref: ctaRef, label: 'Book a Demo' }]),
  ];

  return (
    <div ref={containerRef} className="min-h-screen bg-[#D2E0D3] relative">
      {/* Parallax Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 backdrop-blur-sm bg-[#D2E0D3]/80" />
        {[
          { style: { y: bgY1 }, className: 'absolute top-20 left-10 w-64 h-80', dots: 5 },
          { style: { y: bgY2 }, className: 'absolute top-[500px] right-20 w-72 h-64', dots: 4 },
          { style: { y: bgY3 }, className: 'absolute top-[1000px] left-[15%] w-56 h-72', dots: 5 },
          { style: { y: bgY4 }, className: 'absolute top-[1400px] right-[10%] w-64 h-56', dots: 5 },
        ].map((card, i) => (
          <motion.div
            key={i}
            style={card.style}
            className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
          >
            <div className="flex gap-1 mb-3">
              {Array.from({ length: card.dots }).map((_, j) => (
                <div key={j} className="w-4 h-4 bg-[#F2C3B9]/60 rounded-full" />
              ))}
            </div>
            <div className="space-y-2">
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-full" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-5/6" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-4/6" />
            </div>
          </motion.div>
        ))}
      </div>

      {/* Right-side dot navigation (desktop) */}
      <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-[#97B3AE]/20">
        {dotNavItems.map(({ ref, label }) => (
          <button
            key={label}
            onClick={() => scrollTo(ref)}
            aria-label={`Go to ${label}`}
            className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
          />
        ))}
      </div>

      {/* Island Container */}
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <motion.div
          className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {/* Nav */}
          <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
              <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
            </div>
            <div className="hidden sm:flex items-center gap-8">
              {navLinks.map(({ label, href }) => (
                <Link
                  key={label}
                  href={href}
                  className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
                >
                  {label}
                </Link>
              ))}
            </div>
          </nav>

          {/* Hero */}
          <section ref={heroRef} className="px-12 py-20 text-center relative">
            <motion.p
              className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              RepWorth
            </motion.p>
            <motion.h1
              className="text-5xl md:text-6xl lg:text-7xl mb-6 text-[#2a2a2a] max-w-4xl mx-auto font-medium leading-tight"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              Every review gets the reply it deserves
            </motion.h1>
            <motion.p
              className="text-lg text-[#6a6a6a] mb-8 max-w-2xl mx-auto"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              Automated responses that sound authentically human, crafted in your brand voice.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.5 }}
            >
              {comingSoon ? (
                <span className="inline-block px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg cursor-default opacity-60 select-none">
                  Coming Soon
                </span>
              ) : (
                <motion.button
                  onClick={() => scrollTo(ctaRef)}
                  className="px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg"
                  whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
                  whileTap={{ scale: 0.98 }}
                >
                  Book a Demo
                </motion.button>
              )}
            </motion.div>
          </section>

          {/* Features */}
          <section ref={featuresRef} className="px-12 py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30">
            <div className="max-w-4xl mx-auto">
              <motion.div
                className="text-center mb-16"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-100px' }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="text-4xl md:text-5xl mb-6 text-[#2a2a2a] font-medium">
                  Save 15 hours every week
                </h2>
                <p className="text-lg text-[#6a6a6a] leading-relaxed max-w-2xl mx-auto">
                  RepWorth learns your brand voice and responds to reviews instantly. No templates,
                  no generic messages — just thoughtful replies that build customer loyalty.
                </p>
              </motion.div>
              <div className="grid md:grid-cols-3 gap-8">
                {FEATURES.map((f, i) => (
                  <motion.div
                    key={f.title}
                    className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: '-100px' }}
                    transition={{ duration: 0.6, delay: i * 0.1 }}
                    whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
                  >
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center mb-4 shadow-md"
                      style={{ background: `linear-gradient(135deg, ${f.color}, ${f.color}cc)` }}
                    >
                      {f.icon}
                    </div>
                    <h3 className="text-xl mb-2 text-[#2a2a2a] font-medium">{f.title}</h3>
                    <p className="text-[#6a6a6a]">{f.description}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          {/* How It Works */}
          <section ref={howItWorksRef} className="py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30 overflow-hidden">
            <div className="text-center mb-12 px-12">
              <h2 className="text-4xl md:text-5xl mb-4 text-[#2a2a2a] font-medium">How it works</h2>
              <p className="text-sm text-[#97B3AE] italic">Use arrows to explore</p>
            </div>
            <HowItWorksCarousel steps={STEPS} />
          </section>

          {/* Platforms */}
          <section className="px-12 py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-12">
                <motion.h2
                  className="text-4xl md:text-5xl mb-6 text-[#2a2a2a] font-medium"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-100px' }}
                  transition={{ duration: 0.6 }}
                >
                  Works where your customers review you
                </motion.h2>
                <motion.p
                  className="text-lg text-[#6a6a6a] mb-2 max-w-2xl mx-auto"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-100px' }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  Connect your Google account. One dashboard, all your reviews.
                </motion.p>
                <p className="text-sm text-[#97B3AE] italic mb-8">More platforms coming soon</p>
                <motion.div
                  className="flex justify-center mb-16"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-100px' }}
                  transition={{ duration: 0.6, delay: 0.2 }}
                >
                  <motion.div
                    className="text-2xl text-[#2a2a2a] opacity-40"
                    whileHover={{ opacity: 0.7, scale: 1.05 }}
                    transition={{ duration: 0.2 }}
                  >
                    Google
                  </motion.div>
                </motion.div>
              </div>

              {/* Dashboard Mockup */}
              <motion.div
                className="relative"
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-100px' }}
                transition={{ duration: 0.6, delay: 0.3 }}
              >
                <div className="bg-gradient-to-br from-[#F0EEEA] to-white rounded-2xl p-6 border border-[#97B3AE]/20 shadow-xl">
                  <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#97B3AE]/10">
                    <div className="flex gap-2">
                      <div className="w-3 h-3 rounded-full bg-[#F2C3B9]/50" />
                      <div className="w-3 h-3 rounded-full bg-[#D6CBBF]/50" />
                      <div className="w-3 h-3 rounded-full bg-[#97B3AE]/50" />
                    </div>
                    <div className="text-xs text-[#6a6a6a]">Dashboard Preview</div>
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    {[
                      { label: 'Total Reviews', value: '1,234', color: '#D2E0D3' },
                      { label: 'Replied', value: '1,180', color: '#F2C3B9' },
                      { label: 'Avg Response', value: '8 min', color: '#97B3AE' },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="p-4 rounded-xl border border-[#97B3AE]/10"
                        style={{ background: `linear-gradient(135deg, ${stat.color}20 0%, ${stat.color}10 100%)` }}
                      >
                        <div className="text-xs text-[#6a6a6a] mb-1">{stat.label}</div>
                        <div className="text-2xl text-[#2a2a2a]">{stat.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="bg-white rounded-xl p-4 border border-[#97B3AE]/10 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#D2E0D3] to-[#D2E0D3]/50 shrink-0" />
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="h-2 bg-[#2a2a2a]/10 rounded w-24" />
                            <div className="flex gap-1">
                              {[0, 1, 2, 3, 4].map((j) => (
                                <div key={j} className="w-3 h-3 rounded-full bg-[#F2C3B9]/40" />
                              ))}
                            </div>
                          </div>
                          <div className="h-2 bg-[#2a2a2a]/10 rounded w-full" />
                          <div className="h-2 bg-[#2a2a2a]/10 rounded w-3/4" />
                          <div className="mt-3 pl-4 border-l-2 border-[#97B3AE]/30">
                            <div className="h-2 bg-[#97B3AE]/20 rounded w-5/6" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <motion.div
                  className="absolute -top-6 -right-6 w-32 h-24 bg-gradient-to-br from-[#F2C3B9]/40 to-[#F2C3B9]/20 rounded-xl backdrop-blur-sm border border-white/60 shadow-lg p-3"
                  initial={{ opacity: 0, scale: 0.8, rotate: -5 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: 5 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.5 }}
                >
                  <div className="text-xs text-[#6a6a6a] mb-1">Response Rate</div>
                  <div className="text-xl text-[#2a2a2a]">96%</div>
                </motion.div>

                <motion.div
                  className="absolute -bottom-6 -left-6 w-32 h-24 bg-gradient-to-br from-[#97B3AE]/40 to-[#97B3AE]/20 rounded-xl backdrop-blur-sm border border-white/60 shadow-lg p-3"
                  initial={{ opacity: 0, scale: 0.8, rotate: 5 }}
                  whileInView={{ opacity: 1, scale: 1, rotate: -5 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.6 }}
                >
                  <div className="text-xs text-[#6a6a6a] mb-1">This Week</div>
                  <div className="text-xl text-[#2a2a2a]">+127</div>
                </motion.div>
              </motion.div>
            </div>
          </section>

          {/* CTA — full form or coming-soon message */}
          {comingSoon ? (
            <section
              ref={ctaRef}
              className="px-12 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem]"
            >
              <div className="max-w-3xl mx-auto text-center">
                <motion.h2
                  className="text-4xl md:text-5xl mb-6 font-medium"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6 }}
                >
                  Launching soon
                </motion.h2>
                <motion.p
                  className="text-lg opacity-90"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  We&apos;ll be in touch.
                </motion.p>
              </div>
            </section>
          ) : (
            <section
              ref={ctaRef}
              className="px-12 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem]"
            >
              <div className="max-w-3xl mx-auto text-center">
                <motion.h2
                  className="text-4xl md:text-5xl mb-6 font-medium"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6 }}
                >
                  Start responding smarter today
                </motion.h2>
                <motion.p
                  className="text-lg mb-10 opacity-90"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  Tell us about your business and we&apos;ll set you up with a personalised demo.
                </motion.p>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.2 }}
                >
                  <ContactForm />
                </motion.div>
              </div>
            </section>
          )}
        </motion.div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `src/app/(public)/page.tsx` to a server component wrapper**

Replace the entire file with:

```tsx
import { headers } from 'next/headers';
import { LandingContent } from './components/landing/LandingContent';

export default function LandingPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';
  return <LandingContent comingSoon={comingSoon} />;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: build succeeds. If you see a TypeScript error about `headers()` being async, your version of `@types/react` may have pulled in Next.js 15 types — check the error message. In Next.js 14 `headers()` is synchronous; the function signature should match.

- [ ] **Step 4: Smoke test**

```bash
pnpm dev
```

Visit `http://localhost:3000` — landing page renders identically to before (hero "Book a Demo" button present, full CTA section visible). The refactor is transparent to non-`repworth.net` visitors.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(public\)/page.tsx src/app/\(public\)/components/landing/LandingContent.tsx
git commit -m "refactor(landing): extract LandingContent client component, convert page.tsx to server wrapper"
```

---

## Task 4: Update `SiteNav` with `comingSoon` prop

**Files:**
- Modify: `src/app/(public)/components/shared/SiteNav.tsx`

- [ ] **Step 1: Update `SiteNav.tsx`**

Replace the entire file with:

```tsx
import Link from 'next/link';

interface SiteNavProps {
  comingSoon?: boolean;
}

export function SiteNav({ comingSoon = false }: SiteNavProps) {
  const navLinks = [
    { label: 'Features', href: '/features' },
    { label: 'How it works', href: '/how-it-works' },
    { label: 'Pricing', href: '/pricing' },
    ...(comingSoon ? [] : [{ label: 'Book a Demo', href: '/book-a-demo' }]),
  ];

  return (
    <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
      <div className="hidden sm:flex items-center gap-6">
        {navLinks.map(({ label, href }) => (
          <Link
            key={label}
            href={href}
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
          >
            {label}
          </Link>
        ))}
      </div>
      <Link href="/" className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
        <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
      </Link>
    </nav>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: build succeeds. No callers pass `comingSoon` yet; the prop is optional with a default of `false`, so all existing usages of `<SiteNav />` remain valid.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(public\)/components/shared/SiteNav.tsx
git commit -m "feat(nav): add optional comingSoon prop to SiteNav — hides Book a Demo when true"
```

---

## Task 5: Privacy Policy page

**Files:**
- Create: `src/app/(public)/privacy/page.tsx`

- [ ] **Step 1: Create `src/app/(public)/privacy/page.tsx`**

```tsx
import { headers } from 'next/headers';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

export default function PrivacyPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';

  return (
    <PageShell sections={[]}>
      <SiteNav comingSoon={comingSoon} />
      <div className="px-8 md:px-16 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-medium text-[#2a2a2a] mb-2">Privacy Policy</h1>
          <p className="text-sm text-[#97B3AE] mb-10">Last updated: April 20, 2026</p>

          <div className="prose prose-sm max-w-none text-[#4a4a4a] space-y-8">
            <section>
              <p className="leading-relaxed">
                RepWorth (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the
                RepWorth service at repworth.net. This policy describes what data we collect, how
                we use it, and your rights.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">1. Data We Collect</h2>
              <ul className="space-y-2 list-none pl-0">
                <li><strong className="text-[#2a2a2a]">Account data.</strong> Your name, email address, and business name when you register.</li>
                <li><strong className="text-[#2a2a2a]">Review data.</strong> Google Business reviews associated with your business, fetched via SerpAPI on your behalf.</li>
                <li><strong className="text-[#2a2a2a]">Response data.</strong> AI-generated review response drafts and any edits you make before approving them.</li>
                <li><strong className="text-[#2a2a2a]">Usage data.</strong> Approval actions, response edits, and settings changes.</li>
                <li><strong className="text-[#2a2a2a]">Payment data.</strong> Handled entirely by Stripe. We store only your Stripe customer ID and subscription status — never raw card numbers.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">2. How We Use Your Data</h2>
              <ul className="space-y-2 list-none pl-0">
                <li>To generate AI response drafts for your Google reviews.</li>
                <li>To send approval, notification, and weekly summary emails to your address.</li>
                <li>To process subscription billing via Stripe.</li>
                <li>To improve service reliability and detect misuse.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">3. Third-Party Processors</h2>
              <ul className="space-y-2 list-none pl-0">
                <li><strong className="text-[#2a2a2a]">Google (via SerpAPI)</strong> — review data retrieval.</li>
                <li><strong className="text-[#2a2a2a]">OpenAI / Anthropic</strong> — AI response generation. Review text is sent to these APIs for processing.</li>
                <li><strong className="text-[#2a2a2a]">Stripe</strong> — payment processing and subscription management.</li>
                <li><strong className="text-[#2a2a2a]">Resend</strong> — transactional email delivery.</li>
                <li><strong className="text-[#2a2a2a]">Supabase</strong> — database hosting. Data is stored in the United States.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">4. Data Retention</h2>
              <p className="leading-relaxed">
                Account and review data is retained while your subscription is active. Upon
                cancellation or account deletion, personal data is removed within 30 days.
                Anonymised aggregate statistics may be retained indefinitely to improve the service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">5. Your Rights</h2>
              <p className="leading-relaxed">
                You may request access to, correction of, or deletion of your personal data at any
                time. Email us at{' '}
                <a href="mailto:norbertesekiel@gmail.com" className="text-[#97B3AE] hover:underline">
                  norbertesekiel@gmail.com
                </a>{' '}
                and we will respond within 30 days.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">6. Security</h2>
              <p className="leading-relaxed">
                All data is encrypted in transit (TLS 1.2+) and at rest. Approval tokens are stored
                as one-way SHA-256 hashes and never in plaintext.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">7. Changes to This Policy</h2>
              <p className="leading-relaxed">
                We will notify registered users by email of material changes to this policy at
                least 14 days before they take effect.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">8. Contact</h2>
              <p className="leading-relaxed">
                RepWorth<br />
                Email:{' '}
                <a href="mailto:norbertesekiel@gmail.com" className="text-[#97B3AE] hover:underline">
                  norbertesekiel@gmail.com
                </a>
              </p>
            </section>
          </div>

          <div className="mt-12 pt-8 border-t border-[#97B3AE]/20">
            <Link href="/" className="text-sm text-[#97B3AE] hover:underline">
              ← Back to home
            </Link>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: build succeeds.

- [ ] **Step 3: Smoke test**

```bash
pnpm dev
```

Visit `http://localhost:3000/privacy` — privacy page renders with SiteNav (including "Book a Demo" link, since `host` is `localhost:3000`, not `repworth.net`). Verify the page looks correct and the back-to-home link works.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(public\)/privacy/page.tsx
git commit -m "feat(legal): add Privacy Policy page at /privacy"
```

---

## Task 6: Terms of Service page

**Files:**
- Create: `src/app/(public)/terms/page.tsx`

- [ ] **Step 1: Create `src/app/(public)/terms/page.tsx`**

```tsx
import { headers } from 'next/headers';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

export default function TermsPage() {
  const comingSoon = headers().get('x-coming-soon') === '1';

  return (
    <PageShell sections={[]}>
      <SiteNav comingSoon={comingSoon} />
      <div className="px-8 md:px-16 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-medium text-[#2a2a2a] mb-2">Terms of Service</h1>
          <p className="text-sm text-[#97B3AE] mb-10">Last updated: April 20, 2026</p>

          <div className="prose prose-sm max-w-none text-[#4a4a4a] space-y-8">
            <section>
              <p className="leading-relaxed">
                By creating an account or using the RepWorth service at repworth.net
                (&ldquo;Service&rdquo;), you agree to these Terms. If you do not agree, do not use
                the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">1. The Service</h2>
              <p className="leading-relaxed">
                RepWorth monitors your Google Business Profile reviews, generates AI-drafted
                response suggestions in your business voice, and emails those drafts for your
                review. No response is published to Google without your explicit approval. You
                remain solely responsible for all content posted under your business accounts.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">2. Eligibility</h2>
              <p className="leading-relaxed">
                You must be at least 18 years old and have authority to act on behalf of the
                business you register. One account per business. You are responsible for keeping
                your login credentials secure.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">3. Acceptable Use</h2>
              <p className="leading-relaxed">
                You may not use RepWorth to generate misleading, defamatory, or harassing content;
                to violate Google&apos;s Terms of Service or any applicable law; or to circumvent
                these Terms. We reserve the right to suspend accounts that violate this section
                without notice.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">4. Subscription and Billing</h2>
              <p className="leading-relaxed">
                Subscriptions are charged monthly in advance via Stripe. Prices are displayed at
                checkout and may change with 30 days&apos; written notice. You may cancel at any
                time from your account Settings; cancellation takes effect at the end of the current
                billing period. No refunds are issued for partial months.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">5. AI-Generated Content</h2>
              <p className="leading-relaxed">
                Response drafts are suggestions only. We make no warranty regarding their accuracy,
                appropriateness, tone, or fitness for any purpose. You are responsible for reviewing
                all drafts before approving them for posting to Google.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">6. Intellectual Property</h2>
              <p className="leading-relaxed">
                You retain ownership of your review data and any response content you produce. You
                grant RepWorth a limited, non-exclusive licence to process that data solely to
                operate the Service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">7. Disclaimer of Warranties</h2>
              <p className="leading-relaxed">
                The Service is provided &ldquo;as is&rdquo; without warranty of any kind, express
                or implied, including implied warranties of merchantability, fitness for a
                particular purpose, or non-infringement.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">8. Limitation of Liability</h2>
              <p className="leading-relaxed">
                To the maximum extent permitted by applicable law, RepWorth&apos;s total liability
                for any claim arising out of or related to the Service is limited to the fees you
                paid in the three months preceding the claim. We are not liable for indirect,
                incidental, consequential, or punitive damages.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">9. Termination</h2>
              <p className="leading-relaxed">
                Either party may terminate the agreement at any time. We may suspend or terminate
                your account for cause immediately, or without cause on 30 days&apos; notice. Upon
                termination, your access ends and your data is deleted per our{' '}
                <Link href="/privacy" className="text-[#97B3AE] hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">10. Governing Law</h2>
              <p className="leading-relaxed">
                These Terms are governed by the laws of the State of California, without regard to
                conflict-of-law principles. Any dispute shall be resolved in the courts of Los
                Angeles County, California.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-medium text-[#2a2a2a] mb-3">11. Contact</h2>
              <p className="leading-relaxed">
                RepWorth<br />
                Email:{' '}
                <a href="mailto:norbertesekiel@gmail.com" className="text-[#97B3AE] hover:underline">
                  norbertesekiel@gmail.com
                </a>
              </p>
            </section>
          </div>

          <div className="mt-12 pt-8 border-t border-[#97B3AE]/20">
            <Link href="/" className="text-sm text-[#97B3AE] hover:underline">
              ← Back to home
            </Link>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm build
```

Expected: build succeeds.

- [ ] **Step 3: Smoke test**

```bash
pnpm dev
```

Visit `http://localhost:3000/terms` — terms page renders with full nav. Privacy policy link in section 9 points to `/privacy` and works.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(public\)/terms/page.tsx
git commit -m "feat(legal): add Terms of Service page at /terms"
```

---

## Task 7: Deploy to Vercel and configure DNS

This task is entirely in dashboards — no code changes.

- [ ] **Step 1: Add domain to Vercel project**

1. Go to your Vercel project dashboard → **Settings → Domains**
2. Add `repworth.net` — Vercel will show you the required DNS records
3. Add `www.repworth.net` — then toggle **"Redirect to repworth.net"** (apex redirect) so `www` users land on the canonical apex domain

- [ ] **Step 2: Update GoDaddy DNS**

Log in to GoDaddy DNS Manager for `repworth.net` and add:

| Type  | Name | Value                 | TTL  |
|-------|------|-----------------------|------|
| A     | @    | 76.76.21.21           | 600  |
| CNAME | www  | cname.vercel-dns.com  | 3600 |

DNS propagation typically takes 2–10 minutes with GoDaddy's default TTL.

- [ ] **Step 3: Confirm SSL certificate**

Back in Vercel → Settings → Domains — wait for both `repworth.net` and `www.repworth.net` to show a green ✓ (SSL issued). This can take up to 5 minutes after DNS propagates.

- [ ] **Step 4: Smoke test the live deployment**

| Check | Expected |
|-------|---------|
| `https://repworth.net/` | Landing page loads; hero button reads "Coming Soon" (dimmed, not clickable); "Book a Demo" absent from nav |
| `https://repworth.net/privacy` | Privacy Policy page loads; nav has no "Book a Demo" link |
| `https://repworth.net/terms` | Terms of Service page loads; nav has no "Book a Demo" link |
| `https://repworth.net/features` | 307 redirects to `https://repworth.net/` |
| `https://repworth.net/book-a-demo` | 307 redirects to `https://repworth.net/` |
| `https://www.repworth.net/` | Redirects to `https://repworth.net/` (Vercel apex redirect) |
| `https://rep-worth.vercel.app/` | Landing page loads normally; hero button reads "Book a Demo"; full nav intact |
| `https://rep-worth.vercel.app/admin` | Redirects to `/admin/login` as before |
| `https://rep-worth.vercel.app/dashboard` | Redirects to `/admin/login` as before |

---

## Self-Review

**Spec coverage:**
- ✅ `repworth.net` homepage in coming-soon mode — Task 2 (middleware), Task 3 (LandingContent)
- ✅ Hero button → "Coming Soon", nav "Book a Demo" hidden, dot nav last dot hidden, CTA replaced — Task 3 (LandingContent)
- ✅ `/privacy` and `/terms` accessible at `repworth.net` — Tasks 2, 5, 6
- ✅ All other routes redirect to `/` — Task 2 (middleware 307)
- ✅ `/_next/static`, `/_next/image`, `favicon.ico` excluded — Task 2 (matcher)
- ✅ SiteNav hides "Book a Demo" on legal pages at `repworth.net` — Task 4 (SiteNav), Tasks 5, 6 (pages read header)
- ✅ `rep-worth.vercel.app` unchanged — middleware short-circuits only on `repworth.net` host
- ✅ Supabase not called for public paths on other hosts — Task 2 (`isProtectedRoute` guard)
- ✅ Segment-safe protected-route boundaries — Task 1
- ✅ DNS + Vercel setup — Task 7
- ✅ Worker / backend untouched — no tasks touch `worker/`
