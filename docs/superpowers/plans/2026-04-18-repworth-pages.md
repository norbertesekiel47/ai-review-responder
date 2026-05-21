# RepWorth Marketing Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build four new marketing pages (Features, How It Works, Pricing, Book a Demo) that match the RepWorth island design system, update the landing page nav to link to them, and remove the Platforms nav entry.

**Architecture:** Approach C+ — extract two shared layout components (`PageShell`, `SiteNav`) used by all four new pages. Each page is a standalone `'use client'` Next.js App Router page. The Book a Demo form gets its own API route (`/api/demo-request`) separate from the existing `/api/contact`. The landing page nav is updated to use `<Link>` elements pointing to the new pages; its own scroll-nav and section structure is left intact.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, `motion/react` (Framer Motion v12), Tailwind CSS (hex literals), Resend v6, Vitest

---

## Spec Reference

User message (2026-04-18): Features, How It Works, Pricing, and Book a Demo page specifications.
Brand system: `~/.claude/skills/repworth-brand-design/SKILL.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/app/(public)/components/shared/PageShell.tsx` | Create | `'use client'` — parallax bg, dot nav, island wrapper; reused by all 4 pages |
| `src/app/(public)/components/shared/SiteNav.tsx` | Create | Nav bar with Links to all 4 pages + RepWorth logo |
| `src/app/(public)/components/landing/BookDemoForm.tsx` | Create | `'use client'` — controlled form (name/email/businessName/googleMapsUrl), POSTs to /api/demo-request |
| `src/app/api/demo-request/route.ts` | Create | POST handler — validates 4 fields, rate limits, optional Resend notification |
| `src/app/api/demo-request/__tests__/route.test.ts` | Create | Vitest tests for validation, rate limit, Resend integration |
| `src/app/(public)/features/page.tsx` | Create | Features page — 7 feature blocks + CTA |
| `src/app/(public)/how-it-works/page.tsx` | Create | How It Works page — 4 steps + sample review + FAQ + CTA |
| `src/app/(public)/pricing/page.tsx` | Create | Pricing page — 3 cards + included list + comparison table + FAQ + CTA |
| `src/app/(public)/book-a-demo/page.tsx` | Create | Book a Demo page — left pitch + right BookDemoForm + trust signals |
| `src/app/(public)/page.tsx` | Modify | Update top nav: remove Platforms, switch scroll-buttons to Link elements |

**Not changed:** `HowItWorksCarousel.tsx`, `ContactForm.tsx`, `/api/contact/route.ts`, approval/demo/feedback routes.

---

## Task 1: Git Branch + Shared Components

**Files:**
- Create: `src/app/(public)/components/shared/PageShell.tsx`
- Create: `src/app/(public)/components/shared/SiteNav.tsx`

- [ ] **Step 1.1: Create branch**

```bash
git checkout -b feat/repworth-pages
```

Expected: `Switched to a new branch 'feat/repworth-pages'`

- [ ] **Step 1.2: Create directory**

```bash
mkdir -p "src/app/(public)/components/shared"
```

- [ ] **Step 1.3: Create `src/app/(public)/components/shared/PageShell.tsx`**

```typescript
'use client';

import { useRef } from 'react';
import { motion, useScroll, useTransform } from 'motion/react';

export interface PageSection {
  ref: React.RefObject<HTMLDivElement | null>;
  label: string;
}

interface PageShellProps {
  sections: PageSection[];
  children: React.ReactNode;
}

export function PageShell({ sections, children }: PageShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const bgY1 = useTransform(scrollYProgress, [0, 1], [0, -300]);
  const bgY2 = useTransform(scrollYProgress, [0, 1], [0, -500]);
  const bgY3 = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const bgY4 = useTransform(scrollYProgress, [0, 1], [0, -400]);

  return (
    <div ref={containerRef} className="min-h-screen bg-[#D2E0D3] relative">
      {/* Parallax background */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
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

      {/* Right dot navigation (desktop only) */}
      {sections.length > 0 && (
        <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-[#97B3AE]/20">
          {sections.map(({ ref, label }) => (
            <button
              key={label}
              onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              aria-label={`Go to ${label}`}
              className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
            />
          ))}
        </div>
      )}

      {/* Island wrapper */}
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <motion.div
          className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}
```

- [ ] **Step 1.4: Create `src/app/(public)/components/shared/SiteNav.tsx`**

```typescript
import Link from 'next/link';

const NAV_LINKS = [
  { label: 'Features', href: '/features' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Book a Demo', href: '/book-a-demo' },
] as const;

export function SiteNav() {
  return (
    <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
      <div className="flex items-center gap-6">
        {NAV_LINKS.map(({ label, href }) => (
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

- [ ] **Step 1.5: Verify TypeScript compiles**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 1.6: Commit**

```bash
git add "src/app/(public)/components/shared/PageShell.tsx" "src/app/(public)/components/shared/SiteNav.tsx"
git commit -m "feat(shared): PageShell + SiteNav — reusable island layout and nav"
```

---

## Task 2: `/api/demo-request` Route — Test First

**Files:**
- Create: `src/app/api/demo-request/__tests__/route.test.ts`
- Create: `src/app/api/demo-request/route.ts`

- [ ] **Step 2.1: Write failing tests**

Create `src/app/api/demo-request/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockResendSend, mockCheckRateLimit } = vi.hoisted(() => ({
  mockResendSend: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () {
    return { emails: { send: mockResendSend } };
  }),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/demo-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/demo-request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  it('returns 400 when email is malformed', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'bad', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
  });

  it('returns 400 when businessName is missing', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', googleMapsUrl: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/business/i);
  });

  it('returns 200 without email when RESEND_API_KEY is unset', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('sends email with googleMapsUrl when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice', email: 'a@b.com', businessName: 'Acme',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    }));
    expect(res.status).toBe(200);
    const callArg = mockResendSend.mock.calls[0]?.[0] as Parameters<typeof mockResendSend>[0];
    expect(callArg.to).toBe('norbertesekiel@gmail.com');
    expect(callArg.subject).toContain('Demo Request');
    expect(callArg.text).toContain('Alice');
    expect(callArg.text).toContain('https://maps.google.com/?cid=123');
  });

  it('returns 429 when rate limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(429);
  });

  it('returns 500 when Resend returns error', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'fail' } });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2.2: Run tests — confirm they fail**

```bash
pnpm test src/app/api/demo-request
```

Expected: all fail with "Cannot find module '../route'"

- [ ] **Step 2.3: Create `src/app/api/demo-request/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateCheck = await checkRateLimit(`demo-request:hour:${ip}`, 5, 3600);
  if (!rateCheck.allowed) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, email, businessName, googleMapsUrl } = body as Record<string, unknown>;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    return NextResponse.json({ error: 'businessName is required' }, { status: 400 });
  }

  const submission = {
    name: name.trim(),
    email: email.trim(),
    businessName: businessName.trim(),
    googleMapsUrl: typeof googleMapsUrl === 'string' ? googleMapsUrl.trim() : '',
    timestamp: new Date().toISOString(),
  };

  console.log('[demo-request]', submission);

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL ?? 'noreply@repworth.com';

    const text = [
      'New demo request — RepWorth',
      '',
      `Name:           ${submission.name}`,
      `Email:          ${submission.email}`,
      `Business:       ${submission.businessName}`,
      `Google Maps:    ${submission.googleMapsUrl || '(not provided)'}`,
      `Submitted at:   ${submission.timestamp}`,
    ].join('\n');

    const { error } = await resend.emails.send({
      from,
      to: NOTIFY_TO,
      subject: 'New Demo Request — RepWorth',
      text,
    });

    if (error) {
      console.error('[demo-request] Resend error:', error.message);
      return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2.4: Run tests — confirm all pass**

```bash
pnpm test src/app/api/demo-request
```

Expected: 7 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/app/api/demo-request/route.ts src/app/api/demo-request/__tests__/route.test.ts
git commit -m "feat(demo-request): POST /api/demo-request — demo booking with Google Maps URL field"
```

---

## Task 3: `BookDemoForm` Component

**Files:**
- Create: `src/app/(public)/components/landing/BookDemoForm.tsx`

- [ ] **Step 3.1: Create `src/app/(public)/components/landing/BookDemoForm.tsx`**

```typescript
'use client';

import { useState } from 'react';
import { motion } from 'motion/react';

type FormState = 'idle' | 'loading' | 'success' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function BookDemoForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const validate = (): string | null => {
    if (!name.trim()) return 'Please enter your name.';
    if (!EMAIL_RE.test(email.trim())) return 'Please enter a valid email address.';
    if (!businessName.trim()) return 'Please enter your business name.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setErrorMsg(validationError);
      setState('error');
      return;
    }

    setState('loading');
    setErrorMsg('');

    try {
      const res = await fetch('/api/demo-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          businessName: businessName.trim(),
          googleMapsUrl: googleMapsUrl.trim(),
        }),
      });

      if (res.ok) {
        setState('success');
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg((data as { error?: string }).error ?? 'Something went wrong. Please try again.');
        setState('error');
      }
    } catch {
      setErrorMsg('Network error. Please check your connection and try again.');
      setState('error');
    }
  };

  if (state === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white border border-[#97B3AE]/20 shadow-lg p-8 text-center"
      >
        <div className="text-4xl mb-4">🎉</div>
        <h3 className="text-2xl text-[#2a2a2a] font-medium mb-2">You're booked!</h3>
        <p className="text-[#6a6a6a]">We'll reach out within a few hours to confirm your demo time.</p>
      </motion.div>
    );
  }

  const inputClass =
    'w-full rounded-lg bg-[#F0EEEA]/50 border border-[#97B3AE]/20 px-4 py-3 text-[#2a2a2a] placeholder-[#6a6a6a]/60 focus:outline-none focus:ring-2 focus:ring-[#97B3AE]/40 transition-all text-sm';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="name"
      />
      <input
        type="email"
        placeholder="Email address"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="email"
      />
      <input
        type="text"
        placeholder="Business name"
        value={businessName}
        onChange={(e) => setBusinessName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="organization"
      />
      <input
        type="url"
        placeholder="Google Maps link (optional — helps us prep your demo)"
        value={googleMapsUrl}
        onChange={(e) => setGoogleMapsUrl(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="url"
      />

      {state === 'error' && errorMsg && (
        <p className="text-sm text-red-500">{errorMsg}</p>
      )}

      <motion.button
        type="submit"
        disabled={state === 'loading'}
        whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
        whileTap={{ scale: 0.98 }}
        className="w-full px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
      >
        {state === 'loading' ? 'Sending…' : 'Book My Demo'}
      </motion.button>
    </form>
  );
}
```

- [ ] **Step 3.2: Verify TypeScript**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 3.3: Commit**

```bash
git add "src/app/(public)/components/landing/BookDemoForm.tsx"
git commit -m "feat(landing): BookDemoForm — 4-field demo booking form with Google Maps URL"
```

---

## Task 4: Book a Demo Page

**Files:**
- Create: `src/app/(public)/book-a-demo/page.tsx`

- [ ] **Step 4.1: Create directory and page**

```bash
mkdir -p "src/app/(public)/book-a-demo"
```

Create `src/app/(public)/book-a-demo/page.tsx`:

```typescript
'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';
import { BookDemoForm } from '../components/landing/BookDemoForm';

const DEMO_BULLETS = [
  'We pull your actual Google reviews live',
  'AI generates personalized responses for each one',
  'We walk through the one-tap approval flow together',
  'You ask any questions — no sales pressure',
];

const TRUST_SIGNALS = [
  'Trusted by local businesses across the US',
  'Your data is never shared or sold',
  'No contracts — cancel anytime',
];

export default function BookADemoPage() {
  const formRef = useRef<HTMLDivElement>(null);
  const sections = [{ ref: formRef, label: 'Book' }];

  return (
    <PageShell sections={sections}>
      <SiteNav />

      {/* Main content */}
      <div ref={formRef} className="px-8 py-16 md:py-24 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-start">
            {/* Left: pitch */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <p className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4">Free demo</p>
              <h1 className="text-4xl md:text-5xl font-medium leading-tight text-[#2a2a2a] mb-6">
                See your reviews answered in 60 seconds
              </h1>
              <p className="text-[#6a6a6a] mb-8 italic text-sm">
                Takes 15 minutes. No commitment.
              </p>

              <ul className="space-y-4 mb-10">
                {DEMO_BULLETS.map((bullet, i) => (
                  <motion.li
                    key={i}
                    className="flex items-start gap-3"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 + i * 0.1 }}
                  >
                    <div className="w-6 h-6 rounded-full bg-[#97B3AE]/20 flex items-center justify-center shrink-0 mt-0.5">
                      <svg className="w-3.5 h-3.5 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <span className="text-[#6a6a6a]">{bullet}</span>
                  </motion.li>
                ))}
              </ul>

              {/* Testimonial */}
              <motion.div
                className="bg-[#F0EEEA]/60 rounded-2xl p-6 border border-[#97B3AE]/10"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.7 }}
              >
                <p className="text-[#2a2a2a] italic mb-3 leading-relaxed">
                  &ldquo;RepWorth responds to our reviews faster than we ever could. Our response rate went from 12% to 100% in the first week.&rdquo;
                </p>
                <p className="text-sm text-[#97B3AE]">— Local restaurant owner (placeholder)</p>
              </motion.div>
            </motion.div>

            {/* Right: form */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              <div className="bg-white rounded-2xl border border-[#97B3AE]/10 shadow-lg p-8">
                <h2 className="text-xl font-medium text-[#2a2a2a] mb-6">Book your demo</h2>
                <BookDemoForm />
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      {/* Trust signals */}
      <section className="px-8 py-12 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem]">
        <motion.div
          className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-6 justify-center items-center text-center sm:text-left"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          {TRUST_SIGNALS.map((signal, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-white/90">
              <svg className="w-4 h-4 text-white/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {signal}
            </div>
          ))}
        </motion.div>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 4.2: Verify TypeScript + build**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 4.3: Commit**

```bash
git add "src/app/(public)/book-a-demo/page.tsx"
git commit -m "feat(pages): Book a Demo page — split pitch + form layout with trust signals"
```

---

## Task 5: Pricing Page

**Files:**
- Create: `src/app/(public)/pricing/page.tsx`

- [ ] **Step 5.1: Create directory and page**

```bash
mkdir -p "src/app/(public)/pricing"
```

Create `src/app/(public)/pricing/page.tsx`:

```typescript
'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

const PLANS = [
  {
    name: 'Founding Member',
    price: '$99',
    badge: 'Limited — 10 slots',
    badgeColor: '#F2C3B9',
    badgeText: '#2a2a2a',
    description: 'Rate locked for life.',
    highlight: true,
    cta: 'Claim Your Slot',
    features: [
      'Google review monitoring (hourly)',
      'AI-powered personalized responses',
      'One-tap email approval',
      'Weekly review intelligence brief',
      'ROI dashboard',
      'Dedicated onboarding call',
      'Rate locked for life',
    ],
  },
  {
    name: 'Standard',
    price: '$149',
    badge: 'After founding slots fill',
    badgeColor: '#97B3AE',
    badgeText: '#ffffff',
    description: 'Everything you need to dominate your reviews.',
    highlight: false,
    cta: 'Get Started',
    features: [
      'Everything in Founding Member',
      'Priority support',
      'Advanced analytics',
      'Custom response style guide',
    ],
  },
  {
    name: 'Premium',
    price: '$199',
    badge: 'Coming soon',
    badgeColor: '#D6CBBF',
    badgeText: '#2a2a2a',
    description: 'Multi-platform domination.',
    highlight: false,
    cta: 'Join Waitlist',
    comingSoon: true,
    features: [
      'Everything in Standard',
      'Yelp & TripAdvisor monitoring',
      'SMS review generation campaigns',
      'Competitor monitoring',
      'Multi-location support',
    ],
  },
] as const;

const INCLUDED = [
  'Unlimited reviews monitored',
  'AI responses in any language',
  'Email notifications with one-tap approval',
  'Weekly review intelligence brief',
  'ROI dashboard',
  'Dedicated onboarding call',
];

const COMPARISON = [
  { name: 'RepWorth', price: '$99/mo', aiResponses: '✓', approval: '✓', multilingual: '✓', setup: 'None' },
  { name: 'Birdeye', price: '$300+/mo', aiResponses: '✓', approval: '✗', multilingual: '~', setup: 'Complex' },
  { name: 'Podium', price: '$300+/mo', aiResponses: '✓', approval: '✗', multilingual: '✗', setup: 'Complex' },
  { name: 'DIY', price: '10+ hrs/wk', aiResponses: '✗', approval: 'Manual', multilingual: 'If fluent', setup: 'N/A' },
];

const FAQ = [
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. No contracts, no cancellation fees. Cancel from your account dashboard and billing stops at the end of your current period.',
  },
  {
    q: 'Is there a free trial?',
    a: 'We\'ll generate sample responses for your actual reviews during the demo — no credit card, no commitment. You see the product working on your real business before you pay a cent.',
  },
  {
    q: 'What happens if I get a lot of reviews?',
    a: 'There\'s no limit. Your plan covers unlimited reviews monitored and responded to every month — flat price regardless of volume.',
  },
];

export default function PricingPage() {
  const plansRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const faqRef = useRef<HTMLDivElement>(null);

  const sections = [
    { ref: plansRef, label: 'Plans' },
    { ref: compareRef, label: 'Compare' },
    { ref: faqRef, label: 'FAQ' },
  ];

  return (
    <PageShell sections={sections}>
      <SiteNav />

      {/* Hero */}
      <section className="px-8 py-16 md:py-20 text-center bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <motion.p
          className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          Simple pricing
        </motion.p>
        <motion.h1
          className="text-5xl md:text-6xl font-medium leading-tight text-[#2a2a2a] mb-6 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          One flat price. Unlimited reviews.
        </motion.h1>
        <motion.p
          className="text-lg text-[#6a6a6a] max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          No per-response charges. No hidden fees. Just results.
        </motion.p>
      </section>

      {/* Pricing cards */}
      <section ref={plansRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-3 gap-6">
          {PLANS.map((plan, i) => (
            <motion.div
              key={plan.name}
              className={`relative rounded-2xl p-7 border shadow-lg flex flex-col ${
                plan.highlight
                  ? 'border-[#97B3AE]/40 bg-gradient-to-br from-[#F0EEEA]/60 to-white'
                  : 'border-[#97B3AE]/10 bg-white'
              } ${plan.comingSoon ? 'opacity-75' : ''}`}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: plan.comingSoon ? 0.75 : 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              whileHover={plan.comingSoon ? {} : { y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
            >
              {/* Badge */}
              <div
                className="absolute -top-3 left-6 px-3 py-1 rounded-full text-xs font-medium"
                style={{ background: plan.badgeColor, color: plan.badgeText }}
              >
                {plan.badge}
              </div>

              <h3 className="text-xl font-medium text-[#2a2a2a] mt-2 mb-1">{plan.name}</h3>
              <p className="text-sm text-[#6a6a6a] mb-4">{plan.description}</p>
              <div className="mb-6">
                <span className="text-4xl font-medium text-[#2a2a2a]">{plan.price}</span>
                <span className="text-[#6a6a6a] text-sm">/month</span>
              </div>

              <Link href="/book-a-demo">
                <motion.span
                  className={`block w-full text-center py-3 rounded-full font-medium text-sm mb-6 cursor-pointer ${
                    plan.highlight
                      ? 'bg-[#97B3AE] text-white shadow-lg'
                      : 'bg-[#F0EEEA] text-[#2a2a2a] border border-[#97B3AE]/10'
                  }`}
                  whileHover={plan.comingSoon ? {} : { scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {plan.cta}
                </motion.span>
              </Link>

              <ul className="space-y-3 flex-1">
                {plan.features.map((f, j) => (
                  <li key={j} className="flex items-start gap-2 text-sm text-[#6a6a6a]">
                    <svg className="w-4 h-4 text-[#97B3AE] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </section>

      {/* What's included in every plan */}
      <section className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-10 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            What&apos;s included in every plan
          </motion.h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {INCLUDED.map((item, i) => (
              <motion.div
                key={i}
                className="flex items-start gap-3 bg-white rounded-xl p-4 border border-[#97B3AE]/10 shadow-sm"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: i * 0.07 }}
              >
                <div className="w-8 h-8 rounded-full bg-[#97B3AE]/10 flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span className="text-[#2a2a2a] text-sm font-medium pt-1">{item}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison table */}
      <section ref={compareRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            How RepWorth compares
          </motion.h2>
          <motion.p
            className="text-[#6a6a6a] text-center mb-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            The facts speak for themselves.
          </motion.p>
          <motion.div
            className="overflow-x-auto rounded-2xl border border-[#97B3AE]/10 shadow-lg"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F0EEEA]/60 border-b border-[#97B3AE]/10">
                  <th className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Solution</th>
                  <th className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Cost</th>
                  <th className="text-left px-6 py-4 font-medium text-[#2a2a2a]">AI responses</th>
                  <th className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Owner approval</th>
                  <th className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Multilingual</th>
                  <th className="text-left px-6 py-4 font-medium text-[#2a2a2a]">Setup</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row, i) => (
                  <tr
                    key={row.name}
                    className={`border-b border-[#97B3AE]/10 last:border-0 ${
                      i === 0 ? 'bg-[#97B3AE]/5' : 'bg-white'
                    }`}
                  >
                    <td className={`px-6 py-4 font-medium ${i === 0 ? 'text-[#97B3AE]' : 'text-[#2a2a2a]'}`}>
                      {row.name}
                    </td>
                    <td className="px-6 py-4 text-[#2a2a2a]">{row.price}</td>
                    <td className={`px-6 py-4 ${row.aiResponses === '✓' ? 'text-[#97B3AE]' : 'text-[#6a6a6a]'}`}>
                      {row.aiResponses}
                    </td>
                    <td className={`px-6 py-4 ${row.approval === '✓' ? 'text-[#97B3AE]' : 'text-[#6a6a6a]'}`}>
                      {row.approval}
                    </td>
                    <td className={`px-6 py-4 ${row.multilingual === '✓' ? 'text-[#97B3AE]' : 'text-[#6a6a6a]'}`}>
                      {row.multilingual}
                    </td>
                    <td className="px-6 py-4 text-[#6a6a6a]">{row.setup}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </motion.div>
        </div>
      </section>

      {/* FAQ */}
      <section ref={faqRef} className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-10 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            Common questions
          </motion.h2>
          <div className="space-y-4">
            {FAQ.map((item, i) => (
              <motion.div
                key={i}
                className="bg-white rounded-xl border border-[#97B3AE]/10 p-6 shadow-sm"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
              >
                <h3 className="font-medium text-[#2a2a2a] mb-2">{item.q}</h3>
                <p className="text-[#6a6a6a] leading-relaxed text-sm">{item.a}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-8 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.h2
          className="text-4xl md:text-5xl font-medium mb-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          Book a Demo — see your own reviews answered in 60 seconds
        </motion.h2>
        <motion.p
          className="text-lg opacity-90 mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          15 minutes. No commitment. No credit card.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <Link href="/book-a-demo">
            <motion.span
              className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
              whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
              whileTap={{ scale: 0.98 }}
            >
              Book My Demo
            </motion.span>
          </Link>
        </motion.div>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 5.2: TypeScript check**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 5.3: Commit**

```bash
git add "src/app/(public)/pricing/page.tsx"
git commit -m "feat(pages): Pricing page — 3 cards, comparison table, FAQ, CTA"
```

---

## Task 6: How It Works Page

**Files:**
- Create: `src/app/(public)/how-it-works/page.tsx`

- [ ] **Step 6.1: Create directory and page**

```bash
mkdir -p "src/app/(public)/how-it-works"
```

Create `src/app/(public)/how-it-works/page.tsx`:

```typescript
'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

const STEPS = [
  {
    number: '01',
    title: 'We connect to your Google reviews',
    description:
      'We monitor your Google Business Profile every hour for new reviews. No app to download, no login to share, no setup required on your end.',
    color: '#D2E0D3',
  },
  {
    number: '02',
    title: 'AI drafts a personalized response',
    description:
      'Within an hour of a new review, our AI writes a response that sounds like you — referencing specific details from the review, in whatever language it was written.',
    color: '#F0DDD6',
  },
  {
    number: '03',
    title: 'You approve with one tap',
    description:
      'You get an email with the review and the AI draft side-by-side. Tap approve and you\'re done. Edit the draft or request a new one if you want. Takes 30 seconds.',
    color: '#F2C3B9',
  },
  {
    number: '04',
    title: 'We post it to Google',
    description:
      'Your approved response goes live on Google. Your response rate hits 100%. Google rewards active responders with better local ranking — more visibility, more customers.',
    color: '#D6CBBF',
  },
];

const FAQ = [
  {
    q: "What if I don't like the response?",
    a: 'You can edit the draft directly in the email, or tap "Regenerate" to get a fresh version. Nothing is ever posted without your explicit approval.',
  },
  {
    q: "What if I'm too busy to approve?",
    a: "We send a reminder after 24 hours. Reviews stay queued until you're ready — there's no deadline. Your response rate catches up whenever you do.",
  },
  {
    q: 'Do I need to install anything?',
    a: 'No. RepWorth works entirely through email notifications. No app, no dashboard login required, no browser extension.',
  },
  {
    q: 'What languages do you support?',
    a: 'Any language. Our AI detects the language of the review and responds in kind — Spanish, Vietnamese, Chinese, Tagalog, Korean, and more.',
  },
];

export default function HowItWorksPage() {
  const stepsRef = useRef<HTMLDivElement>(null);
  const exampleRef = useRef<HTMLDivElement>(null);
  const faqRef = useRef<HTMLDivElement>(null);

  const sections = [
    { ref: stepsRef, label: 'Steps' },
    { ref: exampleRef, label: 'Example' },
    { ref: faqRef, label: 'FAQ' },
  ];

  return (
    <PageShell sections={sections}>
      <SiteNav />

      {/* Hero */}
      <section className="px-8 py-16 md:py-20 text-center bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <motion.p
          className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          How it works
        </motion.p>
        <motion.h1
          className="text-5xl md:text-6xl font-medium leading-tight text-[#2a2a2a] mb-6 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          Done-for-you in four steps
        </motion.h1>
        <motion.p
          className="text-lg text-[#6a6a6a] max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          You spend 30 seconds per review. We handle everything else.
        </motion.p>
      </section>

      {/* Steps */}
      <section ref={stepsRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto space-y-6">
          {STEPS.map((step, i) => (
            <motion.div
              key={step.number}
              className="flex gap-6 items-start rounded-2xl p-8 border border-[#97B3AE]/10 shadow-sm"
              style={{ background: `linear-gradient(135deg, ${step.color}20 0%, ${step.color}08 100%)` }}
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
            >
              <div
                className="text-5xl font-medium shrink-0 opacity-20 leading-none"
                style={{ color: '#2a2a2a' }}
              >
                {step.number}
              </div>
              <div>
                <h3 className="text-xl md:text-2xl font-medium text-[#2a2a2a] mb-3">{step.title}</h3>
                <p className="text-[#6a6a6a] leading-relaxed">{step.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Example: sample review + response */}
      <section ref={exampleRef} className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            What it looks like in practice
          </motion.h2>
          <motion.p
            className="text-[#6a6a6a] text-center mb-10"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            A real review from a restaurant. A RepWorth response, ready in under an hour.
          </motion.p>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Customer review */}
            <motion.div
              className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#D2E0D3] to-[#D2E0D3]/50" />
                <div>
                  <p className="font-medium text-[#2a2a2a] text-sm">Maria G.</p>
                  <div className="flex gap-0.5">
                    {[0, 1, 2, 3, 4].map((j) => (
                      <svg key={j} className="w-3.5 h-3.5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    ))}
                  </div>
                </div>
                <div className="ml-auto">
                  <svg className="w-5 h-5 text-[#6a6a6a]/40" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                  </svg>
                </div>
              </div>
              <p className="text-[#2a2a2a] text-sm leading-relaxed">
                &ldquo;El ceviche estaba increíble — fresco y lleno de sabor. El servicio fue muy atento. Mi familia y yo definitivamente volveremos. ¡Gracias por la experiencia tan especial!&rdquo;
              </p>
              <p className="text-xs text-[#6a6a6a] mt-3">Google review · 2 hours ago</p>
              <div className="mt-4 pt-4 border-t border-[#97B3AE]/10">
                <p className="text-xs font-medium text-[#6a6a6a] uppercase tracking-wide mb-1">Customer review</p>
              </div>
            </motion.div>

            {/* AI response */}
            <motion.div
              className="bg-white rounded-2xl p-6 border border-[#97B3AE]/20 shadow-lg"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              <div className="flex items-center gap-2 mb-4">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
                <p className="text-sm font-medium text-[#97B3AE]">Owner response — via RepWorth</p>
                <span className="ml-auto text-xs text-[#6a6a6a] italic">posted 38 min later</span>
              </div>
              <p className="text-[#2a2a2a] text-sm leading-relaxed">
                &ldquo;¡Muchas gracias, María! Nos alegra mucho que hayan disfrutado el ceviche — lo preparamos con pescado fresco todos los días, así que su comentario significa mucho para nuestro equipo. Fue un placer atenderlos y esperamos volver a verlos pronto a usted y a su familia. ¡Hasta la próxima!&rdquo;
              </p>
              <div className="mt-4 pt-4 border-t border-[#97B3AE]/10 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#97B3AE]" />
                <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide">AI-generated, owner-approved</p>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section ref={faqRef} className="px-8 py-16 bg-white">
        <div className="max-w-3xl mx-auto">
          <motion.h2
            className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-10 text-center"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            Questions
          </motion.h2>
          <div className="space-y-4">
            {FAQ.map((item, i) => (
              <motion.div
                key={i}
                className="bg-[#F0EEEA]/40 rounded-xl border border-[#97B3AE]/10 p-6"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
              >
                <h3 className="font-medium text-[#2a2a2a] mb-2">{item.q}</h3>
                <p className="text-[#6a6a6a] leading-relaxed text-sm">{item.a}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-8 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.h2
          className="text-4xl md:text-5xl font-medium mb-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          Ready to try it on your actual reviews?
        </motion.h2>
        <motion.p
          className="text-lg opacity-90 mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          15-minute demo. No credit card. No commitment.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <Link href="/book-a-demo">
            <motion.span
              className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
              whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
              whileTap={{ scale: 0.98 }}
            >
              Book a Demo
            </motion.span>
          </Link>
        </motion.div>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 6.2: TypeScript check**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 6.3: Commit**

```bash
git add "src/app/(public)/how-it-works/page.tsx"
git commit -m "feat(pages): How It Works page — 4 steps, Spanish example, FAQ, CTA"
```

---

## Task 7: Features Page

**Files:**
- Create: `src/app/(public)/features/page.tsx`

- [ ] **Step 7.1: Create directory and page**

```bash
mkdir -p "src/app/(public)/features"
```

Create `src/app/(public)/features/page.tsx`:

```typescript
'use client';

import { useRef } from 'react';
import { motion } from 'motion/react';
import Link from 'next/link';
import { PageShell } from '../components/shared/PageShell';
import { SiteNav } from '../components/shared/SiteNav';

export default function FeaturesPage() {
  const aiRef = useRef<HTMLDivElement>(null);
  const multiRef = useRef<HTMLDivElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const voiceRef = useRef<HTMLDivElement>(null);
  const briefRef = useRef<HTMLDivElement>(null);
  const roiRef = useRef<HTMLDivElement>(null);

  const sections = [
    { ref: aiRef, label: 'AI' },
    { ref: multiRef, label: 'Languages' },
    { ref: approvalRef, label: 'Approval' },
    { ref: voiceRef, label: 'Voice' },
    { ref: briefRef, label: 'Brief' },
    { ref: roiRef, label: 'ROI' },
  ];

  return (
    <PageShell sections={sections}>
      <SiteNav />

      {/* Hero */}
      <section className="px-8 py-16 md:py-20 text-center bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <motion.p
          className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          Features
        </motion.p>
        <motion.h1
          className="text-5xl md:text-6xl font-medium leading-tight text-[#2a2a2a] mb-6 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          Everything your reviews need, nothing you don&apos;t
        </motion.h1>
        <motion.p
          className="text-lg text-[#6a6a6a] max-w-xl mx-auto"
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          RepWorth is a done-for-you service — not another dashboard to learn.
        </motion.p>
      </section>

      {/* Feature 1: AI-powered response generation */}
      <section ref={aiRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #97B3AE, #97B3AEcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">AI-powered response generation</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              Every response is written from scratch — never from a template. Our AI reads the actual review, references specific details the customer mentioned, and writes a reply that sounds like you wrote it yourself. No "thanks for your feedback" filler.
            </p>
          </motion.div>
          {/* Before/After mockup */}
          <motion.div
            className="space-y-4"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="rounded-xl border border-red-100 bg-red-50/40 p-5">
              <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">Generic (without RepWorth)</p>
              <p className="text-sm text-[#6a6a6a] italic">&ldquo;Thank you for your feedback! We appreciate your business and hope to see you again soon.&rdquo;</p>
            </div>
            <div className="flex justify-center">
              <svg className="w-5 h-5 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
            <div className="rounded-xl border border-[#97B3AE]/30 bg-[#97B3AE]/5 p-5">
              <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide mb-2">Personalized (RepWorth)</p>
              <p className="text-sm text-[#2a2a2a]">&ldquo;Sarah, thank you so much! We&apos;re thrilled the al pastor tacos hit the spot — our team makes the achiote marinade from scratch every morning. Looking forward to your next visit!&rdquo;</p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Feature 2: Multilingual */}
      <section ref={multiRef} className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          {/* Visual first on this alternating row */}
          <motion.div
            className="order-2 md:order-1 space-y-3"
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="rounded-xl border border-[#97B3AE]/10 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#D2E0D3] to-[#D2E0D3]/50" />
                <div>
                  <p className="text-xs font-medium text-[#2a2a2a]">Carlos M.</p>
                  <div className="flex gap-0.5">
                    {[0,1,2,3,4].map(j => <svg key={j} className="w-3 h-3 text-yellow-400" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>)}
                  </div>
                </div>
              </div>
              <p className="text-sm text-[#2a2a2a]">&ldquo;La mejor enchilada que he comido en años. El mole es auténtico. Volvería todos los fines de semana si pudiera.&rdquo;</p>
            </div>
            <div className="ml-6 rounded-xl border border-[#97B3AE]/20 bg-[#97B3AE]/5 p-5">
              <p className="text-xs font-medium text-[#97B3AE] mb-2">Owner response — in Spanish, automatically</p>
              <p className="text-sm text-[#2a2a2a]">&ldquo;Carlos, ¡muchísimas gracias! El mole es la receta de mi abuela — tardan tres días en prepararlo. Nos alegra mucho que lo hayas disfrutado. ¡Hasta pronto!&rdquo;</p>
            </div>
          </motion.div>
          <motion.div
            className="order-1 md:order-2"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #F2C3B9, #F2C3B9cc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">Multilingual, automatically</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              RepWorth detects the language of every review and responds in the same language — no setup needed. Spanish, Vietnamese, Chinese, Tagalog, Korean — your customers feel heard in their own words.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Feature 3: One-tap approval */}
      <section ref={approvalRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #D6CBBF, #D6CBBFcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">One-tap approval</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              You get an email showing the customer&apos;s review and the AI draft side-by-side. Tap approve, edit it, or ask for a fresh draft. Nothing is ever posted without your explicit sign-off. Most owners spend under 30 seconds per review.
            </p>
          </motion.div>
          {/* Mobile email mockup */}
          <motion.div
            className="flex justify-center"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="w-64 rounded-3xl border-2 border-[#2a2a2a]/10 bg-[#F0EEEA] shadow-2xl overflow-hidden">
              {/* Phone top bar */}
              <div className="bg-[#2a2a2a] px-4 py-2 flex justify-between items-center">
                <p className="text-white text-xs">9:41</p>
                <div className="w-16 h-4 bg-[#2a2a2a] rounded-full border border-white/20" />
              </div>
              <div className="p-4 space-y-3">
                <div className="bg-white rounded-xl p-3 text-xs text-[#2a2a2a] shadow-sm">
                  <p className="font-medium mb-1">New review — Mama Rosa&apos;s 🍽️</p>
                  <p className="text-[#6a6a6a]">★★★★★ &ldquo;Best enchiladas I&apos;ve had in years...&rdquo;</p>
                </div>
                <div className="bg-[#97B3AE]/10 rounded-xl p-3 text-xs border border-[#97B3AE]/20">
                  <p className="font-medium text-[#97B3AE] mb-1">Draft response</p>
                  <p className="text-[#6a6a6a]">&ldquo;Carlos, thank you so much! The mole is our abuela&apos;s recipe...&rdquo;</p>
                </div>
                <div className="space-y-2">
                  <div className="bg-[#97B3AE] rounded-full py-2.5 text-center text-white text-xs font-medium shadow">
                    ✓ Approve &amp; Post
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-white rounded-full py-2 text-center text-[#6a6a6a] text-xs border border-[#97B3AE]/20">
                      Edit
                    </div>
                    <div className="flex-1 bg-white rounded-full py-2 text-center text-[#6a6a6a] text-xs border border-[#97B3AE]/20">
                      Regenerate
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Feature 4: Voice learning */}
      <section ref={voiceRef} className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          {/* Chart visual */}
          <motion.div
            className="order-2 md:order-1"
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg">
              <p className="text-sm font-medium text-[#6a6a6a] mb-4">Edit rate over time</p>
              <div className="flex items-end gap-2 h-24">
                {[85, 72, 61, 48, 35, 28, 18, 12].map((h, i) => (
                  <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: `rgba(151, 179, 174, ${0.3 + (8-i) * 0.08})` }} />
                ))}
              </div>
              <div className="flex justify-between text-xs text-[#6a6a6a] mt-2">
                <span>Week 1</span>
                <span>Week 8</span>
              </div>
              <p className="text-xs text-[#97B3AE] mt-3 italic">Owners edit fewer responses as the AI learns their voice.</p>
            </div>
          </motion.div>
          <motion.div
            className="order-1 md:order-2"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #97B3AE, #97B3AEcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">Voice learning</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              Every time you edit a response, RepWorth learns. Over 4-8 weeks, it picks up your phrasing, your warmth level, your way of handling negative reviews. By week 8, most owners approve drafts without changes.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Feature 5: Review intelligence brief */}
      <section ref={briefRef} className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #F2C3B9, #F2C3B9cc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">Weekly review intelligence brief</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              Every Monday morning, you get a brief summarizing what customers actually said this week — what they loved, what they complained about, and what topics are trending. Operational intelligence from your reviews, not just star counts.
            </p>
          </motion.div>
          {/* Sample brief */}
          <motion.div
            className="bg-[#F0EEEA]/50 rounded-2xl border border-[#97B3AE]/10 p-6 shadow-lg"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide mb-4">Weekly brief — Apr 14–20</p>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-[#2a2a2a] mb-1">Reviews this week</p>
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-medium text-[#2a2a2a]">14</span>
                  <span className="text-xs text-[#97B3AE] bg-[#97B3AE]/10 px-2 py-0.5 rounded-full">↑ 3 vs last week</span>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-[#2a2a2a] mb-2">Top mentions</p>
                <div className="space-y-1.5">
                  {[
                    { topic: 'al pastor tacos', count: 7, sentiment: 'positive' },
                    { topic: 'wait time', count: 4, sentiment: 'negative' },
                    { topic: 'friendly staff', count: 6, sentiment: 'positive' },
                  ].map(({ topic, count, sentiment }) => (
                    <div key={topic} className="flex items-center gap-2 text-xs">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${sentiment === 'positive' ? 'bg-[#97B3AE]' : 'bg-[#F2C3B9]'}`} />
                      <span className="text-[#2a2a2a]">{topic}</span>
                      <span className="text-[#6a6a6a] ml-auto">{count}×</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t border-[#97B3AE]/10 pt-3">
                <p className="text-xs text-[#6a6a6a] italic">&ldquo;Wait time came up in 4 reviews this week — worth looking at staffing on Saturday evenings.&rdquo;</p>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Feature 6: ROI dashboard */}
      <section ref={roiRef} className="px-8 py-16 bg-gradient-to-b from-white to-[#F0EEEA]/30">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          {/* Dashboard mockup */}
          <motion.div
            className="order-2 md:order-1 bg-white rounded-2xl border border-[#97B3AE]/10 shadow-lg p-6"
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <div className="grid grid-cols-2 gap-4 mb-6">
              {[
                { label: 'Response rate', before: '12%', after: '100%', color: '#97B3AE' },
                { label: 'Avg response time', before: '4 days', after: '58 min', color: '#F2C3B9' },
              ].map(({ label, before, after, color }) => (
                <div key={label} className="rounded-xl p-4 border border-[#97B3AE]/10" style={{ background: `${color}15` }}>
                  <p className="text-xs text-[#6a6a6a] mb-2">{label}</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs line-through text-[#6a6a6a]/60">{before}</span>
                    <span className="text-lg font-medium text-[#2a2a2a]">{after}</span>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <p className="text-xs text-[#6a6a6a] mb-3">Google ranking trend (placeholder)</p>
              <div className="flex items-end gap-1 h-16">
                {[3, 4, 3.5, 5, 6, 7, 8, 9, 8.5, 10, 9, 11].map((v, i) => (
                  <div key={i} className="flex-1 rounded-t" style={{ height: `${v * 9}%`, background: `rgba(151, 179, 174, ${0.3 + i * 0.05})` }} />
                ))}
              </div>
              <p className="text-xs text-[#97B3AE] mt-2 italic text-right">↑ Local search position over 3 months</p>
            </div>
          </motion.div>
          <motion.div
            className="order-1 md:order-2"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #D6CBBF, #D6CBBFcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a] mb-4">ROI dashboard</h2>
            <p className="text-[#6a6a6a] leading-relaxed">
              See your response rate before and after RepWorth, your average response time, and how your Google Maps ranking has moved. Concrete numbers, not vanity metrics — so you can show the value to your accountant or business partner.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Feature 7: Competitor monitoring */}
      <section className="px-8 py-16 bg-white">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6 }}
          >
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-6 shadow-md" style={{ background: 'linear-gradient(135deg, #97B3AE, #97B3AEcc)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-3xl md:text-4xl font-medium text-[#2a2a2a]">Competitor monitoring</h2>
              <span className="text-xs bg-[#D6CBBF]/40 text-[#6a6a6a] px-2 py-0.5 rounded-full border border-[#D6CBBF]/60">Coming soon</span>
            </div>
            <p className="text-[#6a6a6a] leading-relaxed">
              Know how your reviews stack up against the business next door. Track competitor response rates, star rating trends, and what customers are saying about them — so you always know where you stand in your local market.
            </p>
          </motion.div>
          {/* Placeholder mockup */}
          <motion.div
            className="bg-[#F0EEEA]/50 rounded-2xl border border-[#97B3AE]/10 p-6 shadow-lg opacity-70"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 0.7, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <p className="text-xs font-medium text-[#97B3AE] uppercase tracking-wide mb-4">Area comparison — placeholder</p>
            <div className="space-y-3">
              {[
                { name: 'Your business', rate: '100%', stars: '4.8', color: '#97B3AE' },
                { name: 'Competitor A', rate: '23%', stars: '4.2', color: '#D6CBBF' },
                { name: 'Competitor B', rate: '8%', stars: '4.0', color: '#D6CBBF' },
              ].map(({ name, rate, stars, color }) => (
                <div key={name} className="flex items-center gap-4 text-sm">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-[#2a2a2a] flex-1">{name}</span>
                  <span className="text-[#6a6a6a]">★ {stars}</span>
                  <span className="text-xs text-[#6a6a6a]">{rate} responses</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-8 py-20 bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem] text-center">
        <motion.h2
          className="text-4xl md:text-5xl font-medium mb-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          See it in action with your own reviews
        </motion.h2>
        <motion.p
          className="text-lg opacity-90 mb-8"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.1 }}
        >
          We&apos;ll pull your real Google reviews and show you AI responses live during the demo.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          <Link href="/book-a-demo">
            <motion.span
              className="inline-block px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium cursor-pointer"
              whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
              whileTap={{ scale: 0.98 }}
            >
              Book a Demo
            </motion.span>
          </Link>
        </motion.div>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 7.2: TypeScript check**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 7.3: Commit**

```bash
git add "src/app/(public)/features/page.tsx"
git commit -m "feat(pages): Features page — 7 feature blocks with mockups, before/after, CTA"
```

---

## Task 8: Update Landing Page Nav

**Files:**
- Modify: `src/app/(public)/page.tsx`

The landing page nav currently has scroll-buttons for Features/How it works/Platforms and a link to /pricing. Replace with `<Link>` elements for all 4 nav items and remove Platforms. The right-side dot nav and all landing page sections remain unchanged.

- [ ] **Step 8.1: Read the current nav section of `src/app/(public)/page.tsx`**

Look for the `<nav>` element (approximately line 150-175) and the dot nav refs array (approximately lines 126-141). Read those sections.

- [ ] **Step 8.2: Replace the top nav**

Find this block in the island's nav:
```tsx
<div className="flex items-center gap-8">
  {[
    { label: 'Features', ref: featuresRef },
    { label: 'How it works', ref: howItWorksRef },
    { label: 'Platforms', ref: platformsRef },
  ].map(({ label, ref }) => (
    <button
      key={label}
      onClick={() => scrollTo(ref)}
      className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
    >
      {label}
    </button>
  ))}
  <a href="/pricing" className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors">
    Pricing
  </a>
</div>
```

Replace with:
```tsx
<div className="flex items-center gap-8">
  {[
    { label: 'Features', href: '/features' },
    { label: 'How it works', href: '/how-it-works' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Book a Demo', href: '/book-a-demo' },
  ].map(({ label, href }) => (
    <Link
      key={label}
      href={href}
      className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
    >
      {label}
    </Link>
  ))}
</div>
```

- [ ] **Step 8.3: Add `Link` import to `page.tsx`**

Add at the top (after the motion import line):
```tsx
import Link from 'next/link';
```

- [ ] **Step 8.4: Remove `platformsRef` from the dot nav**

Find the dot nav sections array:
```tsx
{ ref: platformsRef, label: 'Platforms' },
```

Delete that entry. Also remove its ref declaration:
```tsx
const platformsRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 8.5: TypeScript check + run tests**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
pnpm test
```

Expected: no new TypeScript errors, all tests pass.

- [ ] **Step 8.6: Commit**

```bash
git add "src/app/(public)/page.tsx"
git commit -m "feat(landing): update nav — Link elements to new pages, remove Platforms"
```

---

## Task 9: Visual Smoke Test

**Goal:** Verify all 5 pages (landing + 4 new) render correctly in browser.

- [ ] **Step 9.1: Start dev server**

```bash
pnpm dev
```

Expected: server starts on `http://localhost:3000`

- [ ] **Step 9.2: Check each page**

| URL | Key checks |
|---|---|
| `http://localhost:3000` | Nav now shows Features/How it works/Pricing/Book a Demo links; no Platforms button; right dot nav still works |
| `http://localhost:3000/features` | Island layout, 7 feature blocks visible, before/after mockup, mobile approval mockup, Spanish example, voice chart, weekly brief, ROI chart, competitor placeholder; CTA scrolls to /book-a-demo |
| `http://localhost:3000/how-it-works` | 4 numbered steps, Spanish review + response side-by-side, 4 FAQ items, CTA |
| `http://localhost:3000/pricing` | 3 pricing cards (Founding/Standard/Premium with "coming soon" badge), included list, comparison table, FAQ, CTA |
| `http://localhost:3000/book-a-demo` | Left pitch with bullets + testimonial, right form with 4 fields, trust signals in green CTA footer |
| `/book-a-demo` form: empty submit | "Please enter your name." error |
| `/book-a-demo` form: valid submit | Success state "You're booked!" |

- [ ] **Step 9.3: Fix any visual issues, then commit**

```bash
git add -p
git commit -m "fix(pages): visual smoke test corrections"
```

---

## Task 10: Build Check + PR

- [ ] **Step 10.1: Run full test suite**

```bash
pnpm test
```

Expected: all pass.

- [ ] **Step 10.2: Production build**

```bash
pnpm build
```

Expected: build succeeds with all 5 pages compiled.

- [ ] **Step 10.3: Push and open PR**

```bash
git push -u origin feat/repworth-pages

gh pr create \
  --title "feat: Features, How It Works, Pricing, Book a Demo pages" \
  --body "$(cat <<'EOF'
## Summary
- Adds 4 new marketing pages: /features, /how-it-works, /pricing, /book-a-demo
- Extracts PageShell + SiteNav shared components (used by all 4 new pages)
- Updates landing page nav: Links to new pages, removes Platforms, adds Book a Demo
- New /api/demo-request route (7 Vitest tests) with Google Maps URL field for demo prep
- BookDemoForm component with 4-field controlled form + loading/success/error states
- All pages follow repworth-brand-design system: island layout, sage green palette, motion/react

## Test plan
- [x] pnpm test passes (7 demo-request route tests + all pre-existing)
- [x] pnpm build succeeds
- [x] Visual smoke test: all 5 pages verified in browser
- [ ] /book-a-demo form submit: confirmation email received at norbertesekiel@gmail.com

🤖 Generated with [Claude Code](https://claude.ai/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Features page hero "Everything your reviews need..." | Task 7 |
| 7 feature blocks in order (AI, multilingual, approval, voice, brief, ROI, competitor) | Task 7 |
| Before/after response comparison visual | Task 7 — styled div mockup |
| Spanish review example | Task 7 |
| Mobile approval screen mockup | Task 7 — phone shape div |
| Voice learning edit-rate chart | Task 7 — bar chart |
| Weekly brief sample card | Task 7 |
| ROI dashboard before/after + ranking trend | Task 7 |
| Competitor monitoring (placeholder, coming soon) | Task 7 |
| Features CTA → /book-a-demo | Task 7 |
| How It Works 4 numbered steps | Task 6 |
| Sample restaurant review + response side-by-side | Task 6 — Spanish example |
| FAQ (4 questions) | Task 6 |
| How It Works CTA | Task 6 |
| Pricing 3 cards ($99/$149/$199 coming soon) | Task 5 |
| "What's included in every plan" section | Task 5 |
| Comparison table (RepWorth vs Birdeye vs Podium vs DIY) | Task 5 |
| Pricing FAQ (3 questions) | Task 5 |
| Pricing CTA "see your own reviews in 60 seconds" | Task 5 |
| Book a Demo — left pitch + 4 bullets | Task 4 |
| Testimonial placeholder | Task 4 |
| "15 minutes, no commitment" | Task 4 |
| Right side: form with name/email/business/Google Maps | Tasks 3 + 4 |
| Trust signals below form | Task 4 |
| Remove Platforms from nav | Task 8 |
| Nav: Features/How it works/Pricing/Book a Demo | Tasks 1 + 8 |
| PageShell shared component | Task 1 |
| SiteNav shared component | Task 1 |
| /api/demo-request with Google Maps URL | Task 2 |
| 7 Vitest tests for /api/demo-request | Task 2 |

**Placeholder scan:** No TBDs. All code blocks are complete.

**Type consistency:** `PageSection` interface from `PageShell.tsx` used consistently. `BookDemoForm` imports match `motion/react`. All `Link` imports from `next/link`. `SiteNav` is a non-client component (no hooks) — correctly omits `'use client'`.
