# Public Launch Gate Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `repworth.net` coming-soon launch gate so the public domain uses the same public/protected routing behavior as every other host.

**Architecture:** Add regression coverage around middleware host behavior first, then delete the hostname short-circuit and simplify the public marketing components that consumed `x-coming-soon`. Keep this change design-neutral: do not redesign page layouts, copy, colors, spacing, or component structure beyond removing the launch-gate conditionals.

**Tech Stack:** Next.js 14 App Router, Edge middleware, React Server Components, client React components, Vitest, TypeScript.

---

## File Map

- Create: `src/__tests__/middleware.test.ts`
  - Regression tests for `repworth.net` host behavior after launch-gate removal.
- Modify: `src/middleware.ts`
  - Remove only the `repworth.net` / `www.repworth.net` coming-soon block.
- Modify: `src/app/(public)/page.tsx`
  - Stop reading `x-coming-soon`; keep `SELF_SERVE_SIGNUP_ENABLED`.
- Modify: `src/app/(public)/features/page.tsx`
  - Stop reading `x-coming-soon`.
- Modify: `src/app/(public)/how-it-works/page.tsx`
  - Stop reading `x-coming-soon`.
- Modify: `src/app/(public)/privacy/page.tsx`
  - Stop reading `x-coming-soon`.
- Modify: `src/app/(public)/terms/page.tsx`
  - Stop reading `x-coming-soon`.
- Modify: `src/components/ui/SiteNav.tsx`
  - Remove `comingSoon`; always include "Book a Demo"; keep `selfServeEnabled`.
- Modify: `src/components/sections/landing/LandingContent.tsx`
  - Remove `comingSoon`; always render normal Book a Demo/contact-form experience.
- Modify: `src/components/sections/features/FeaturesContent.tsx`
  - Remove `comingSoon`; always render normal CTA.
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx`
  - Remove `comingSoon`; always render normal CTA.

Do not modify dashboard channel "Coming soon" rows, pricing tier badges, or roadmap copy. Those are product placeholders, not the public launch gate.

---

### Task 1: Add Middleware Regression Tests

**Files:**
- Create: `src/__tests__/middleware.test.ts`

- [ ] **Step 1: Create failing middleware tests**

Create `src/__tests__/middleware.test.ts` with this complete content:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { middleware } from '../middleware';

const { getUser } = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser,
    },
  })),
}));

function request(url: string): NextRequest {
  return new NextRequest(url);
}

function hasComingSoonMiddlewareHeader(response: Response): boolean {
  return Array.from(response.headers.entries()).some(([key, value]) => {
    return key.toLowerCase().includes('coming-soon') || value.toLowerCase().includes('x-coming-soon');
  });
}

describe('middleware public launch host behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it('does not inject coming-soon headers for repworth.net public pages', async () => {
    const response = await middleware(request('https://repworth.net/'));

    expect(response.headers.get('location')).toBeNull();
    expect(hasComingSoonMiddlewareHeader(response)).toBe(false);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('allows repworth.net owner login to pass through as a public route', async () => {
    const response = await middleware(request('https://repworth.net/login'));

    expect(response.headers.get('location')).toBeNull();
    expect(hasComingSoonMiddlewareHeader(response)).toBe(false);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('uses normal admin auth redirect behavior on repworth.net protected pages', async () => {
    const response = await middleware(request('https://repworth.net/admin/overview'));
    const location = response.headers.get('location');

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.origin).toBe('https://repworth.net');
    expect(redirect.pathname).toBe('/admin/login');
    expect(redirect.searchParams.get('from')).toBe('/admin/overview');
  });
});
```

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```powershell
pnpm exec vitest run src/__tests__/middleware.test.ts
```

Expected: FAIL. At least one failure should show current coming-soon behavior, such as a redirect to `https://repworth.net/` or middleware headers containing `x-coming-soon`.

- [ ] **Step 3: Commit the failing test**

Run:

```powershell
git add src/__tests__/middleware.test.ts
git commit -m "test: cover public launch host routing"
```

Expected: commit succeeds with only `src/__tests__/middleware.test.ts` staged.

---

### Task 2: Remove Hostname Coming-Soon Middleware Gate

**Files:**
- Modify: `src/middleware.ts`
- Test: `src/__tests__/middleware.test.ts`

- [ ] **Step 1: Delete the launch-gate block**

In `src/middleware.ts`, replace the top of `middleware`:

```ts
export async function middleware(request: NextRequest) {
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');

  // ── repworth.net: short-circuit before any Supabase work ─────────
  // Also handle www.repworth.net in case Vercel's www→apex redirect isn't in place.
  if (host === 'www.repworth.net') {
    return NextResponse.redirect(new URL(`https://repworth.net${request.nextUrl.pathname}${request.nextUrl.search}`), 301);
  }

  if (host === 'repworth.net') {
    const { pathname } = request.nextUrl;
    const normalised = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;

    if (normalised === '/' || normalised === '/privacy' || normalised === '/terms' || normalised === '/features' || normalised === '/how-it-works') {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-coming-soon', '1');
      return NextResponse.next({ request: { headers: requestHeaders } });
    }

    return NextResponse.redirect(new URL('https://repworth.net/'), 307);
  }

  // ── All other hosts: skip Supabase for public paths ───────────────
  const { pathname } = request.nextUrl;
```

with:

```ts
export async function middleware(request: NextRequest) {
  // ── Public paths: skip Supabase work ──────────────────────────────
  const { pathname } = request.nextUrl;
```

Leave all auth branches below that point unchanged.

- [ ] **Step 2: Run the middleware test and confirm GREEN**

Run:

```powershell
pnpm exec vitest run src/__tests__/middleware.test.ts
```

Expected: PASS. The three middleware tests should pass.

- [ ] **Step 3: Run protected-route tests**

Run:

```powershell
pnpm exec vitest run src/lib/shared/__tests__/protected-routes.test.ts src/__tests__/middleware.test.ts
```

Expected: PASS. This confirms the public/protected route classifier still matches the middleware behavior.

- [ ] **Step 4: Commit middleware removal**

Run:

```powershell
git add src/middleware.ts src/__tests__/middleware.test.ts
git commit -m "fix: remove public domain coming soon middleware gate"
```

Expected: commit succeeds. The diff should not include public component changes yet.

---

### Task 3: Simplify Public Page Wrappers And SiteNav

**Files:**
- Modify: `src/app/(public)/page.tsx`
- Modify: `src/app/(public)/features/page.tsx`
- Modify: `src/app/(public)/how-it-works/page.tsx`
- Modify: `src/app/(public)/privacy/page.tsx`
- Modify: `src/app/(public)/terms/page.tsx`
- Modify: `src/components/ui/SiteNav.tsx`

- [ ] **Step 1: Simplify the landing page wrapper**

Replace all content in `src/app/(public)/page.tsx` with:

```tsx
import { LandingContent } from '@/components/sections/landing/LandingContent';

export default function LandingPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <LandingContent selfServeEnabled={selfServeEnabled} />;
}
```

- [ ] **Step 2: Simplify the features page wrapper**

Replace all content in `src/app/(public)/features/page.tsx` with:

```tsx
import { FeaturesContent } from '@/components/sections/features/FeaturesContent';

export default function FeaturesPage() {
  return <FeaturesContent />;
}
```

- [ ] **Step 3: Simplify the how-it-works page wrapper**

Replace all content in `src/app/(public)/how-it-works/page.tsx` with:

```tsx
import { HowItWorksContent } from '@/components/sections/how-it-works/HowItWorksContent';

export default function HowItWorksPage() {
  return <HowItWorksContent />;
}
```

- [ ] **Step 4: Remove comingSoon from legal pages**

In `src/app/(public)/privacy/page.tsx`, delete:

```tsx
import { headers } from 'next/headers';
```

Delete this line inside `PrivacyPage`:

```tsx
  const comingSoon = headers().get('x-coming-soon') === '1';
```

Replace:

```tsx
      <SiteNav comingSoon={comingSoon} />
```

with:

```tsx
      <SiteNav />
```

Make the same three edits in `src/app/(public)/terms/page.tsx`.

- [ ] **Step 5: Simplify SiteNav props and nav links**

Replace all content in `src/components/ui/SiteNav.tsx` with:

```tsx
import Link from 'next/link';

interface SiteNavProps {
  selfServeEnabled?: boolean;
}

export function SiteNav({ selfServeEnabled = false }: SiteNavProps) {
  const navLinks = [
    { label: 'Features', href: '/features' },
    { label: 'How it works', href: '/how-it-works' },
    { label: 'Book a Demo', href: '/book-a-demo' },
  ];

  return (
    <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
      <Link href="/" className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
        <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
      </Link>
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
        {selfServeEnabled && (
          <>
            <Link href="/login" className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors">
              Log In
            </Link>
            <Link
              href="/signup"
              className="text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
            >
              Sign Up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
```

- [ ] **Step 6: Run TypeScript/build check for wrapper changes**

Run:

```powershell
pnpm build
```

Expected: PASS. If it fails, the failure should identify remaining `comingSoon` prop mismatches; fix only those mismatches in this task.

- [ ] **Step 7: Commit wrapper and nav simplification**

Run:

```powershell
git add "src/app/(public)/page.tsx" "src/app/(public)/features/page.tsx" "src/app/(public)/how-it-works/page.tsx" "src/app/(public)/privacy/page.tsx" "src/app/(public)/terms/page.tsx" src/components/ui/SiteNav.tsx
git commit -m "refactor: remove coming soon props from public wrappers"
```

Expected: commit succeeds. Do not stage marketing component CTA changes in this commit.

---

### Task 4: Simplify Marketing Component CTAs

**Files:**
- Modify: `src/components/sections/landing/LandingContent.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx`

- [ ] **Step 1: Remove `comingSoon` from LandingContent props**

In `src/components/sections/landing/LandingContent.tsx`, replace:

```tsx
interface LandingContentProps {
  comingSoon: boolean;
  selfServeEnabled?: boolean;
}

export function LandingContent({ comingSoon, selfServeEnabled = false }: LandingContentProps) {
```

with:

```tsx
interface LandingContentProps {
  selfServeEnabled?: boolean;
}

export function LandingContent({ selfServeEnabled = false }: LandingContentProps) {
```

- [ ] **Step 2: Always include the landing Book a Demo dot**

In `LandingContent.tsx`, replace:

```tsx
  const dotNavItems = [
    { ref: heroRef, label: 'Hero' },
    { ref: featuresRef, label: 'Features' },
    { ref: howItWorksRef, label: 'How it works' },
    ...(comingSoon ? [] : [{ ref: ctaRef, label: 'Book a Demo' }]),
  ];
```

with:

```tsx
  const dotNavItems = [
    { ref: heroRef, label: 'Hero' },
    { ref: featuresRef, label: 'Features' },
    { ref: howItWorksRef, label: 'How it works' },
    { ref: ctaRef, label: 'Book a Demo' },
  ];
```

- [ ] **Step 3: Remove `comingSoon` from the landing nav call**

In `LandingContent.tsx`, replace:

```tsx
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
```

with:

```tsx
          <SiteNav selfServeEnabled={selfServeEnabled} />
```

- [ ] **Step 4: Always render the landing hero Book a Demo button**

In `LandingContent.tsx`, replace the whole conditional block inside the hero `motion.div`:

```tsx
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
```

with:

```tsx
              <motion.button
                onClick={() => scrollTo(ctaRef)}
                className="px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg"
                whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
                whileTap={{ scale: 0.98 }}
              >
                Book a Demo
              </motion.button>
```

- [ ] **Step 5: Always render the landing contact-form CTA**

In `LandingContent.tsx`, replace the full CTA conditional from:

```tsx
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
```

to:

```tsx
          {/* CTA */}
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
```

- [ ] **Step 6: Simplify FeaturesContent props and CTA**

In `src/components/sections/features/FeaturesContent.tsx`, replace:

```tsx
export function FeaturesContent({ comingSoon = false }: { comingSoon?: boolean }) {
```

with:

```tsx
export function FeaturesContent() {
```

Replace:

```tsx
      <SiteNav comingSoon={comingSoon} />
```

with:

```tsx
      <SiteNav />
```

Replace the CTA conditional:

```tsx
          {comingSoon ? (
            <span className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium opacity-60 cursor-default select-none">
              Coming Soon
            </span>
          ) : (
            <Link href="/book-a-demo">
              <motion.span
                className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
                whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
                whileTap={{ scale: 0.98 }}
              >
                Book a Demo
              </motion.span>
            </Link>
          )}
```

with:

```tsx
          <Link href="/book-a-demo">
            <motion.span
              className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
              whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
              whileTap={{ scale: 0.98 }}
            >
              Book a Demo
            </motion.span>
          </Link>
```

- [ ] **Step 7: Simplify HowItWorksContent props and CTA**

In `src/components/sections/how-it-works/HowItWorksContent.tsx`, replace:

```tsx
export function HowItWorksContent({ comingSoon = false }: { comingSoon?: boolean }) {
```

with:

```tsx
export function HowItWorksContent() {
```

Replace:

```tsx
      <SiteNav comingSoon={comingSoon} />
```

with:

```tsx
      <SiteNav />
```

Replace the CTA conditional:

```tsx
          {comingSoon ? (
            <span className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium opacity-60 cursor-default select-none">
              Coming Soon
            </span>
          ) : (
            <Link href="/book-a-demo">
              <motion.span
                className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
                whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
                whileTap={{ scale: 0.98 }}
              >
                Book a Demo
              </motion.span>
            </Link>
          )}
```

with:

```tsx
          <Link href="/book-a-demo">
            <motion.span
              className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
              whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
              whileTap={{ scale: 0.98 }}
            >
              Book a Demo
            </motion.span>
          </Link>
```

- [ ] **Step 8: Confirm launch-gate identifiers are gone from public launch scope**

Run:

```powershell
rg -n "x-coming-soon|comingSoon|host === 'repworth.net'|www\\.repworth\\.net" src/middleware.ts "src/app/(public)" src/components/ui/SiteNav.tsx src/components/sections/landing src/components/sections/features src/components/sections/how-it-works
```

Expected: no matches. Product placeholders outside this scope may still contain visible "Coming soon" copy and must not be removed in this task.

- [ ] **Step 9: Run focused tests and build**

Run:

```powershell
pnpm exec vitest run src/__tests__/middleware.test.ts src/lib/shared/__tests__/protected-routes.test.ts
pnpm build
```

Expected: both commands pass.

- [ ] **Step 10: Commit marketing component simplification**

Run:

```powershell
git add src/components/sections/landing/LandingContent.tsx src/components/sections/features/FeaturesContent.tsx src/components/sections/how-it-works/HowItWorksContent.tsx
git commit -m "refactor: remove coming soon public marketing branches"
```

Expected: commit succeeds.

---

### Task 5: Final Verification And Handoff

**Files:**
- Read-only verification across `src`

- [ ] **Step 1: Confirm branch and unrelated worktree state**

Run:

```powershell
git branch --show-current
git status --short
```

Expected: current branch is `feat/public-launch-gate-removal`. Existing unrelated `.claude/*` modifications may still be present and must not be staged or committed.

- [ ] **Step 2: Run final launch-gate search**

Run:

```powershell
rg -n "x-coming-soon|comingSoon|host === 'repworth.net'|www\\.repworth\\.net" src
```

Expected: no matches for launch-gate code. If matches appear only in unrelated product copy such as dashboard channel placeholders, verify the term is not `comingSoon` or `x-coming-soon` before leaving it.

- [ ] **Step 3: Run final verification commands**

Run:

```powershell
pnpm exec vitest run src/__tests__/middleware.test.ts src/lib/shared/__tests__/protected-routes.test.ts
pnpm build
```

Expected: both commands pass.

- [ ] **Step 4: Review final diff**

Run:

```powershell
git diff --stat HEAD~4..HEAD
git log --oneline -4
```

Expected: the four implementation commits are:

```text
test: cover public launch host routing
fix: remove public domain coming soon middleware gate
refactor: remove coming soon props from public wrappers
refactor: remove coming soon public marketing branches
```

No unrelated `.claude/*` files should appear in these commits.

- [ ] **Step 5: Report production environment reminder**

In the handoff message, include this exact reminder:

```text
The code no longer blocks repworth.net routes, but production owner login/signup/onboarding still depends on SELF_SERVE_SIGNUP_ENABLED=true in the deployment environment.
```
