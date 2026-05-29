# Prospect Demo Page Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand `src/app/(public)/demo/[slug]` (the prospect lead-gen demo page) onto the RepWorth island design system across all four states — completed, loading, failed, and a new branded expired/not-found — without changing any data behavior.

**Architecture:** Keep `page.tsx` as a server component that owns the query, expiry check, view-count increment, and state branching. Move all presentation into client components: a rich `DemoViewerContent` (completed feed) and a shared `DemoStatusIsland` (loading/error/expired). The loading state replaces the invalid `<meta refresh>` with a `router.refresh()` poller. A new server `not-found.tsx` renders the expired island.

**Tech Stack:** Next.js 16 App Router, React, `motion/react`, Tailwind (RepWorth tokens), existing `PageShell` + `SiteNav`. Tests: Vitest + `@testing-library/react` (jsdom per-file).

**Spec:** `docs/superpowers/specs/2026-05-28-demo-page-redesign-design.md`

**Reference patterns already in repo:**
- Island shell usage: `src/app/(public)/book-a-demo/BookADemoContent.tsx`
- jsdom + `next/navigation` + fake-timer test pattern: `src/components/dashboard/__tests__/TopBar.test.tsx`, `src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx`
- Brand tokens/rules: `~/.claude/skills/repworth-brand-design/SKILL.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/app/(public)/demo/[slug]/page.tsx` | modify | Server: query, expiry → `notFound()`, view-count, JSONB parse, branch to client components, `robots: noindex` metadata. No presentation. |
| `src/app/(public)/demo/[slug]/DemoStatusIsland.tsx` | create (`'use client'`) | Shared centered island for `loading` / `error` / `expired`. Loading variant runs the `router.refresh()` poller. |
| `src/app/(public)/demo/[slug]/DemoViewerContent.tsx` | create (`'use client'`) | Completed island: hero + stat chips + review/reply feed + teal CTA footer. Houses `StatChip`, `Stars`, `ReviewCard`. |
| `src/app/(public)/demo/[slug]/not-found.tsx` | create (server) | Reads `SELF_SERVE_SIGNUP_ENABLED`, renders `<DemoStatusIsland variant="expired" />`. |
| `src/app/(public)/demo/[slug]/__tests__/DemoStatusIsland.test.tsx` | create | Poller behavior + recovery CTAs. |
| `src/app/(public)/demo/[slug]/__tests__/DemoViewerContent.test.tsx` | create | Card count, language chip, CTA href, reply label. |

Build order: leaf components first (`DemoStatusIsland`, `DemoViewerContent`), then wire `page.tsx`, then `not-found.tsx`, then full verification. `page.tsx` and `not-found.tsx` have no unit tests (they are thin server components calling `sql`/`process.env`; the existing demo page has none) — they are verified by typecheck, build, and a manual visual pass, consistent with the rest of the repo.

---

## Task 0: Confirm clean baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm worktree + branch**

Run: `git -C /private/tmp/repworth-demo-page rev-parse --abbrev-ref HEAD`
Expected: `fix/launch-p0-demo-page`

- [ ] **Step 2: Typecheck the untouched tree**

Run: `pnpm typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Run the existing test suite as a baseline**

Run: `pnpm test -- --run`
Expected: all tests pass (0 failures). If anything fails before changes, STOP and report — do not start implementing on a red baseline.

---

## Task 1: `DemoStatusIsland` (loading / error / expired)

**Files:**
- Create: `src/app/(public)/demo/[slug]/DemoStatusIsland.tsx`
- Test: `src/app/(public)/demo/[slug]/__tests__/DemoStatusIsland.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(public)/demo/[slug]/__tests__/DemoStatusIsland.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createElement } from 'react';

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// Mock the heavy island shell so these tests exercise DemoStatusIsland's own
// behavior (poller + CTAs), not PageShell's scroll internals.
vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { 'data-testid': 'page-shell' }, children),
}));
vi.mock('@/components/ui/SiteNav', () => ({
  SiteNav: () => createElement('nav', { 'data-testid': 'site-nav' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

const { DemoStatusIsland } = await import('../DemoStatusIsland');

describe('DemoStatusIsland', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('loading variant refreshes the route on an interval and clears it on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      createElement(DemoStatusIsland, {
        variant: 'loading',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    unmount();
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('loading variant shows the business name and generating copy', () => {
    render(
      createElement(DemoStatusIsland, {
        variant: 'loading',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText("Joe's Coffee")).toBeInTheDocument();
    expect(screen.getByText(/being generated/i)).toBeInTheDocument();
  });

  it('error variant renders a recovery CTA to /book-a-demo and does not poll', () => {
    vi.useFakeTimers();
    render(
      createElement(DemoStatusIsland, {
        variant: 'error',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByRole('link', { name: /book a demo/i })).toHaveAttribute('href', '/book-a-demo');
    expect(screen.getByRole('link', { name: /back to repworth/i })).toHaveAttribute('href', '/');
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('expired variant renders the expired message and recovery CTA', () => {
    render(
      createElement(DemoStatusIsland, {
        variant: 'expired',
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText(/this demo link has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /book a demo/i })).toHaveAttribute('href', '/book-a-demo');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --run src/app/\(public\)/demo/\[slug\]/__tests__/DemoStatusIsland.test.tsx`
Expected: FAIL — cannot resolve `../DemoStatusIsland`.

- [ ] **Step 3: Implement `DemoStatusIsland`**

Create `src/app/(public)/demo/[slug]/DemoStatusIsland.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';

type DemoStatusVariant = 'loading' | 'error' | 'expired';

interface DemoStatusIslandProps {
  variant: DemoStatusVariant;
  /** Shown for loading/error; absent for expired (no demo row to name). */
  businessName?: string;
  selfServeEnabled: boolean;
}

const REFRESH_INTERVAL_MS = 5000;

const MESSAGES: Record<'error' | 'expired', { title: string; body: (name?: string) => string }> = {
  error: {
    title: "We couldn't generate this demo",
    body: (name) =>
      `Something went wrong creating the demo${name ? ` for ${name}` : ''}. We'd still love to show you RepWorth.`,
  },
  expired: {
    title: 'This demo link has expired',
    body: () =>
      'Demo links are only active for a short time. Request a fresh look at RepWorth for your business.',
  },
};

export function DemoStatusIsland({ variant, businessName, selfServeEnabled }: DemoStatusIslandProps) {
  const router = useRouter();

  useEffect(() => {
    if (variant !== 'loading') return;
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [variant, router]);

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />
      <div role="status" className="px-8 py-20 md:py-28 flex flex-col items-center text-center">
        {variant === 'loading' ? (
          <LoadingBody businessName={businessName} />
        ) : (
          <MessageBody variant={variant} businessName={businessName} />
        )}
      </div>
    </PageShell>
  );
}

function LoadingBody({ businessName }: { businessName?: string }) {
  return (
    <>
      <div
        aria-hidden="true"
        className="w-12 h-12 rounded-full border-4 border-[#97B3AE]/20 border-t-[#97B3AE] animate-spin mb-6"
      />
      {businessName && (
        <h1 className="text-2xl md:text-3xl font-medium text-[#2a2a2a] mb-2">{businessName}</h1>
      )}
      <p className="text-lg text-[#6a6a6a]">Your demo is being generated…</p>
      <p className="text-sm text-[#97B3AE] italic mt-2">This usually takes about 30–60 seconds.</p>
    </>
  );
}

function MessageBody({ variant, businessName }: { variant: 'error' | 'expired'; businessName?: string }) {
  const { title, body } = MESSAGES[variant];
  return (
    <>
      <div
        aria-hidden="true"
        className="w-16 h-16 rounded-full bg-[#97B3AE]/15 flex items-center justify-center mb-6"
      >
        <svg className="w-7 h-7 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {variant === 'error' ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"
            />
          )}
        </svg>
      </div>
      <h1 className="text-2xl md:text-3xl font-medium text-[#2a2a2a] mb-3">{title}</h1>
      <p className="text-lg text-[#6a6a6a] max-w-md mb-8">{body(businessName)}</p>
      <motion.div whileHover={{ scale: 1.05, y: -2 }} whileTap={{ scale: 0.98 }} className="inline-block">
        <Link href="/book-a-demo" className="inline-block px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg font-medium">
          Book a demo
        </Link>
      </motion.div>
      <Link href="/" className="text-sm text-[#97B3AE] underline mt-6">
        Back to RepWorth
      </Link>
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- --run src/app/\(public\)/demo/\[slug\]/__tests__/DemoStatusIsland.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/demo/[slug]/DemoStatusIsland.tsx" "src/app/(public)/demo/[slug]/__tests__/DemoStatusIsland.test.tsx"
git commit -m "feat(demo): branded DemoStatusIsland for loading/error/expired states"
```

---

## Task 2: `DemoViewerContent` (completed feed)

**Files:**
- Create: `src/app/(public)/demo/[slug]/DemoViewerContent.tsx`
- Test: `src/app/(public)/demo/[slug]/__tests__/DemoViewerContent.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(public)/demo/[slug]/__tests__/DemoViewerContent.test.tsx`:

```tsx
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

// jsdom lacks IntersectionObserver, which motion's whileInView relies on.
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { 'data-testid': 'page-shell' }, children),
}));
vi.mock('@/components/ui/SiteNav', () => ({
  SiteNav: () => createElement('nav', { 'data-testid': 'site-nav' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

const { DemoViewerContent } = await import('../DemoViewerContent');

function makeResult(overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    responseText: 'Thank you for the kind words!',
    language: 'en',
    provider: 'openai',
    model: 'gpt-4o-mini-2024-07-18',
    usage: { promptTokens: 0, completionTokens: 0 },
    costUsd: 0,
    apiCostId: null,
    ...overrides,
  };
}

const enReview: NormalizedReview = {
  reviewerName: 'Dan P.',
  starRating: 4,
  reviewText: 'Great coffee.',
  reviewDate: '2026-02-28',
  detectedLanguage: 'en',
};
const esReview: NormalizedReview = {
  reviewerName: 'Maria G.',
  starRating: 5,
  reviewText: '¡El mejor latte!',
  reviewDate: '2026-03-03',
  detectedLanguage: 'es',
};

describe('DemoViewerContent', () => {
  it('renders one card per review', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview, esReview],
        responses: [makeResult(), makeResult({ language: 'es', responseText: '¡Gracias!' })],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText('Dan P.')).toBeInTheDocument();
    expect(screen.getByText('Maria G.')).toBeInTheDocument();
  });

  it('CTA links to /book-a-demo, not a mailto', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview],
        responses: [makeResult()],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByRole('link', { name: /book a demo/i })).toHaveAttribute('href', '/book-a-demo');
  });

  it('hides the languages chip when every review and reply is English', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview],
        responses: [makeResult()],
        selfServeEnabled: false,
      }),
    );
    expect(screen.queryByText(/languages handled/i)).not.toBeInTheDocument();
  });

  it('shows the languages chip when a non-English language is present', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview, esReview],
        responses: [makeResult(), makeResult({ language: 'es' })],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText('2 languages handled')).toBeInTheDocument();
  });

  it('labels the reply "RepWorth reply" and not "AI Response"', () => {
    render(
      createElement(DemoViewerContent, {
        businessName: "Joe's Coffee",
        reviews: [enReview],
        responses: [makeResult()],
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText(/repworth reply/i)).toBeInTheDocument();
    expect(screen.queryByText(/ai response/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- --run src/app/\(public\)/demo/\[slug\]/__tests__/DemoViewerContent.test.tsx`
Expected: FAIL — cannot resolve `../DemoViewerContent`.

- [ ] **Step 3: Implement `DemoViewerContent`**

Create `src/app/(public)/demo/[slug]/DemoViewerContent.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { PageShell } from '@/components/ui/PageShell';
import { SiteNav } from '@/components/ui/SiteNav';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';

interface DemoViewerContentProps {
  businessName: string;
  reviews: NormalizedReview[];
  responses: (GenerationResult | null)[];
  selfServeEnabled: boolean;
}

export function DemoViewerContent({ businessName, reviews, responses, selfServeEnabled }: DemoViewerContentProps) {
  const successCount = responses.filter((r) => r !== null).length;

  const languages = new Set<string>();
  for (const review of reviews) languages.add(review.detectedLanguage);
  for (const response of responses) if (response) languages.add(response.language);
  const languageCount = languages.size;

  return (
    <PageShell sections={[]}>
      <SiteNav selfServeEnabled={selfServeEnabled} />

      {/* Hero */}
      <div className="px-8 pt-12 pb-8 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-3xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <p className="text-sm tracking-wider uppercase text-[#97B3AE] mb-3">RepWorth demo</p>
            <h1 className="text-4xl md:text-5xl font-medium leading-tight text-[#2a2a2a] mb-5">
              {businessName}
            </h1>
            <div className="flex flex-wrap gap-2">
              <StatChip>{reviews.length} reviews</StatChip>
              <StatChip>{successCount} replies drafted</StatChip>
              {languageCount > 1 && <StatChip>{languageCount} languages handled</StatChip>}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Feed */}
      <div className="px-8 pb-12 bg-white">
        <div className="max-w-3xl mx-auto space-y-6">
          {reviews.map((review, index) => (
            <ReviewCard key={index} review={review} response={responses[index] ?? null} index={index} />
          ))}
        </div>
      </div>

      {/* CTA */}
      <section className="px-8 py-14 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6 }}
          className="max-w-xl mx-auto"
        >
          <h2 className="text-2xl md:text-3xl font-medium mb-3">Want replies like these for your reviews?</h2>
          <p className="text-white/85 mb-8">RepWorth drafts every reply — you approve before it posts.</p>
          <motion.div whileHover={{ scale: 1.05, y: -2 }} whileTap={{ scale: 0.98 }} className="inline-block">
            <Link
              href="/book-a-demo"
              className="inline-block px-8 py-4 bg-white text-[#97B3AE] rounded-full shadow-lg font-medium"
            >
              Book a demo
            </Link>
          </motion.div>
        </motion.div>
      </section>
    </PageShell>
  );
}

function StatChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-sm text-[#6a6a6a] bg-[#F0EEEA] border border-[#97B3AE]/25 rounded-full px-4 py-1.5">
      {children}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-[#97B3AE]' : 'text-[#2a2a2a]/15'}>
          ★
        </span>
      ))}
    </span>
  );
}

function ReviewCard({
  review,
  response,
  index,
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
  index: number;
}) {
  const isMultilingual =
    review.detectedLanguage !== 'en' || (response !== null && response.language !== 'en');

  const formattedDate = new Date(review.reviewDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <motion.div
      className="bg-white rounded-2xl border border-[#97B3AE]/10 shadow-lg"
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.6, delay: index * 0.1 }}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between mb-2 gap-3">
          <div>
            <span className="font-medium text-[#2a2a2a]">{review.reviewerName}</span>
            <span className="text-sm text-[#97B3AE] ml-2">{formattedDate}</span>
          </div>
          {isMultilingual && (
            <span className="text-xs font-medium bg-[#97B3AE]/15 text-[#97B3AE] px-2.5 py-0.5 rounded-full shrink-0">
              Multilingual
            </span>
          )}
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-3 text-[#6a6a6a] leading-relaxed">{review.reviewText}</p>
        ) : (
          <p className="mt-3 text-[#6a6a6a]/70 italic">Rating only — no written review</p>
        )}
      </div>

      {response && (
        <div className="bg-[#F0EEEA] border-t border-[#97B3AE]/20 p-5 sm:p-6 rounded-b-2xl">
          <p className="text-xs font-semibold text-[#97B3AE] uppercase tracking-wider mb-2">RepWorth reply</p>
          <p className="text-[#6a6a6a] leading-relaxed">{response.responseText}</p>
        </div>
      )}
    </motion.div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- --run src/app/\(public\)/demo/\[slug\]/__tests__/DemoViewerContent.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/demo/[slug]/DemoViewerContent.tsx" "src/app/(public)/demo/[slug]/__tests__/DemoViewerContent.test.tsx"
git commit -m "feat(demo): branded DemoViewerContent completed-state island feed"
```

---

## Task 3: Wire `page.tsx` to the new components

**Files:**
- Modify: `src/app/(public)/demo/[slug]/page.tsx`

- [ ] **Step 1: Replace the file contents**

Overwrite `src/app/(public)/demo/[slug]/page.tsx` with:

```tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import type { NormalizedReview } from '@/lib/reviews/types';
import type { GenerationResult } from '@/lib/responses/types';
import { DemoViewerContent } from './DemoViewerContent';
import { DemoStatusIsland } from './DemoStatusIsland';

export const dynamic = 'force-dynamic';

// Per-prospect tokenized content exposing a business's reviews — must not be
// crawled or cached by search engines.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// TODO Sprint 4: debounce view_count with Redis INCR instead of direct Postgres write

interface DemoRow {
  id: string;
  business_name: string;
  generation_status: string;
  generation_error: string | null;
  reviews_snapshot: NormalizedReview[] | null;
  generated_responses: (GenerationResult | null)[] | null;
  view_count: number;
  expires_at: Date;
}

async function getDemo(slug: string): Promise<DemoRow | null> {
  const [row] = await sql<DemoRow[]>`
    SELECT id, business_name, generation_status, generation_error,
           reviews_snapshot, generated_responses, view_count, expires_at
    FROM prospect_demos
    WHERE demo_url_slug = ${slug}
  `;
  return row ?? null;
}

export default async function DemoViewerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  const demo = await getDemo(slug);

  if (!demo || demo.expires_at < new Date()) {
    notFound();
  }

  if (demo.generation_status === 'queued' || demo.generation_status === 'running') {
    return (
      <DemoStatusIsland
        variant="loading"
        businessName={demo.business_name}
        selfServeEnabled={selfServeEnabled}
      />
    );
  }

  if (demo.generation_status === 'failed') {
    return (
      <DemoStatusIsland
        variant="error"
        businessName={demo.business_name}
        selfServeEnabled={selfServeEnabled}
      />
    );
  }

  // Only count views of completed demos — the loading state polls and would
  // inflate the count otherwise.
  // TODO Sprint 4: debounce with Redis INCR
  sql`
    UPDATE prospect_demos
    SET view_count = view_count + 1, last_viewed_at = NOW()
    WHERE id = ${demo.id}
  `.catch((err) => console.error('[demo-viewer] Failed to increment view count:', err));

  // Postgres.js may return JSONB as a string — parse if needed
  const reviews: NormalizedReview[] =
    typeof demo.reviews_snapshot === 'string'
      ? JSON.parse(demo.reviews_snapshot)
      : demo.reviews_snapshot ?? [];
  const responses: (GenerationResult | null)[] =
    typeof demo.generated_responses === 'string'
      ? JSON.parse(demo.generated_responses)
      : demo.generated_responses ?? [];

  return (
    <DemoViewerContent
      businessName={demo.business_name}
      reviews={reviews}
      responses={responses}
      selfServeEnabled={selfServeEnabled}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0. (`notFound()` returns `never`, so `demo` is non-null afterward; `Metadata` typing validates the `robots` shape.)

- [ ] **Step 3: Confirm no `<meta refresh>` / blue / mailto remain in the route**

Run: `grep -RnE "meta http|httpEquiv|bg-blue|text-blue|mailto:|text-yellow|bg-purple" "src/app/(public)/demo/[slug]/"`
Expected: no matches (exit 1 / empty output).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(public)/demo/[slug]/page.tsx"
git commit -m "refactor(demo): page.tsx renders branded state components + robots noindex"
```

---

## Task 4: Branded `not-found.tsx` (expired / invalid demo links)

**Files:**
- Create: `src/app/(public)/demo/[slug]/not-found.tsx`

- [ ] **Step 1: Implement**

Create `src/app/(public)/demo/[slug]/not-found.tsx`:

```tsx
import { DemoStatusIsland } from './DemoStatusIsland';

export default function DemoNotFound() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <DemoStatusIsland variant="expired" selfServeEnabled={selfServeEnabled} />;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(public)/demo/[slug]/not-found.tsx"
git commit -m "feat(demo): branded not-found island for expired/invalid demo links"
```

---

## Task 5: Full verification + manual visual pass

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: exit 0, no errors/warnings in the demo files.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test -- --run`
Expected: all tests pass, including the 9 new demo tests.

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: build succeeds; `/demo/[slug]` compiles with no errors.

- [ ] **Step 5: Manual visual pass (all four states)**

Run: `pnpm dev`, then verify each state in the browser against the brand rubric and the companion mockups in `.superpowers/brainstorm/`:
- Completed: island, sage bg, teal CTA → `/book-a-demo`, teal stars, teal "Multilingual" + "RepWorth reply" labels, motion on cards/CTA.
- Loading: teal spinner, copy, and the route refreshing every ~5s (DevTools → Network shows RSC refetches; no full-page reload).
- Failed: sage icon circle, heading, "Book a demo" + "Back to RepWorth".
- Expired: visit an unknown/expired slug → branded expired island (not the default Next 404).

Confirm none of the four states show gray/blue/purple/yellow, and there is no `overflow-hidden` clipping on iOS-width viewports.

- [ ] **Step 6: Final commit (only if Step 5 surfaced tweaks)**

```bash
git add -A
git commit -m "fix(demo): visual-pass adjustments for demo page redesign"
```

---

## Done criteria

- All four demo states render on the RepWorth island system; no gray/blue/purple/yellow, no `<meta refresh>`, no `mailto:` CTA.
- `robots: noindex` on the route; branded `not-found.tsx` for expired/invalid links.
- 9 new tests green; `lint`, `typecheck`, `test`, `build` all pass locally.
- No changes to the demo query, view-count logic, or expiry semantics.
- Branch `fix/launch-p0-demo-page` ready to push and open a PR (4 CI checks must pass — final validation runs on the GitHub runner, not the worktree).
```
