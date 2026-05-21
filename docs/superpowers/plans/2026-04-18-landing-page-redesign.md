# Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current amber/stone landing page with the Figma "island" layout — sage green palette, Framer Motion animations, island card container, and a sales-led contact form replacing the old pricing CTA.

**Architecture:** Approach C (hybrid) — `page.tsx` is the layout shell for all static sections and animation markup; two stateful pieces (`HowItWorksCarousel`, `ContactForm`) are extracted as `'use client'` components; the form submits to a new Next.js App Router API route at `/api/contact`.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript strict, `motion` (Framer Motion v11), Tailwind CSS (hex literals — no custom theme tokens), Resend v6, Vitest

---

## Spec Reference

`docs/superpowers/specs/2026-04-18-landing-page-redesign.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/app/(public)/page.tsx` | Rewrite | Layout shell — parallax bg, dot nav, island container, all static sections |
| `src/app/(public)/components/landing/HowItWorksCarousel.tsx` | Create | `'use client'` — AnimatePresence 3D card slider, 4 RepWorth steps |
| `src/app/(public)/components/landing/ContactForm.tsx` | Create | `'use client'` — controlled form (name/email/business), POST to /api/contact |
| `src/app/api/contact/route.ts` | Create | POST handler — validates fields, logs, optionally sends via Resend |
| `src/app/api/contact/__tests__/route.test.ts` | Create | Unit tests for API route validation and Resend integration |

**Not changed:** `src/app/(public)/layout.tsx`, approval routes, demo routes, feedback routes, `tailwind.config.ts`, `vitest.config.ts`

---

## Task 1: Git Branch + Install `motion`

**Files:** none (setup only)

- [ ] **Step 1.1: Create and checkout the feature branch**

```bash
git checkout -b feat/landing-page-redesign
```

Expected output: `Switched to a new branch 'feat/landing-page-redesign'`

- [ ] **Step 1.2: Install the `motion` package**

```bash
pnpm add motion
```

Expected: `motion` appears in `package.json` dependencies. The package exports from `motion/react` (Framer Motion v11).

- [ ] **Step 1.3: Verify import resolves**

```bash
node -e "require('motion/react'); console.log('ok')"
```

Expected output: `ok`

- [ ] **Step 1.4: Commit setup**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: install motion (Framer Motion v11) for landing page redesign"
```

---

## Task 2: `/api/contact` Route — Test First

**Files:**
- Create: `src/app/api/contact/__tests__/route.test.ts`
- Create: `src/app/api/contact/route.ts`

### Step 2.1 — Write the failing tests

- [ ] Create `src/app/api/contact/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ────────────────────────────────────────────────────

const { mockResendSend } = vi.hoisted(() => ({
  mockResendSend: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockResendSend },
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it('returns 400 when email is missing', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it('returns 400 when email is malformed', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'not-an-email', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it('returns 400 when businessName is missing', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/business/i);
  });

  it('returns 200 without sending email when RESEND_API_KEY is unset', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('sends email via Resend when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockResendSend).toHaveBeenCalledOnce();

    const callArg = mockResendSend.mock.calls[0][0];
    expect(callArg.to).toBe('norbertesekiel@gmail.com');
    expect(callArg.subject).toContain('Demo Request');
    expect(callArg.text).toContain('Alice');
    expect(callArg.text).toContain('a@b.com');
    expect(callArg.text).toContain('Acme');
  });

  it('returns 500 when Resend throws', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'send failed' } });

    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2.2: Run tests — confirm they all fail**

```bash
pnpm test src/app/api/contact
```

Expected: 6 failures — `Cannot find module '../route'`

- [ ] **Step 2.3: Create `src/app/api/contact/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTIFY_TO = 'norbertesekiel@gmail.com';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, email, businessName } = body as Record<string, unknown>;

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
    timestamp: new Date().toISOString(),
  };

  console.log('[contact]', submission);

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL ?? 'noreply@repworth.com';

    const text = [
      `New demo request — RepWorth`,
      ``,
      `Name:          ${submission.name}`,
      `Email:         ${submission.email}`,
      `Business:      ${submission.businessName}`,
      `Submitted at:  ${submission.timestamp}`,
    ].join('\n');

    const { error } = await resend.emails.send({
      from,
      to: NOTIFY_TO,
      subject: `New Demo Request — RepWorth`,
      text,
    });

    if (error) {
      console.error('[contact] Resend error:', error.message);
      return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2.4: Run tests — confirm all pass**

```bash
pnpm test src/app/api/contact
```

Expected: 6 tests pass, 0 failures.

- [ ] **Step 2.5: Commit**

```bash
git add src/app/api/contact/route.ts src/app/api/contact/__tests__/route.test.ts
git commit -m "feat(contact): POST /api/contact — lead capture with optional Resend notification"
```

---

## Task 3: `HowItWorksCarousel` Component

**Files:**
- Create: `src/app/(public)/components/landing/HowItWorksCarousel.tsx`

> **Note:** Vitest is configured with `environment: 'node'`. React component unit tests require jsdom, which is not set up in this project. This component is tested visually in Task 6 by running the dev server. The logic is simple enough (increment/decrement index, boundary guards) that correctness is evident from code review.

- [ ] **Step 3.1: Create the directory**

```bash
mkdir -p src/app/\(public\)/components/landing
```

- [ ] **Step 3.2: Create `src/app/(public)/components/landing/HowItWorksCarousel.tsx`**

```typescript
'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

export interface CarouselStep {
  step: string;
  title: string;
  description: string;
  color: string;
}

interface HowItWorksCarouselProps {
  steps: CarouselStep[];
}

export function HowItWorksCarousel({ steps }: HowItWorksCarouselProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState(0);

  const goNext = () => {
    if (currentStep < steps.length - 1) {
      setDirection(1);
      setCurrentStep((s) => s + 1);
    }
  };

  const goPrev = () => {
    if (currentStep > 0) {
      setDirection(-1);
      setCurrentStep((s) => s - 1);
    }
  };

  const goTo = (index: number) => {
    setDirection(index > currentStep ? 1 : -1);
    setCurrentStep(index);
  };

  return (
    <div>
      <div
        className="relative flex items-center justify-center"
        style={{ perspective: '1200px' }}
      >
        {/* Previous Arrow */}
        <button
          onClick={goPrev}
          disabled={currentStep === 0}
          aria-label="Previous step"
          className={`absolute left-4 z-10 w-12 h-12 rounded-full bg-white/60 backdrop-blur-md border border-[#97B3AE]/20 flex items-center justify-center transition-all ${
            currentStep === 0
              ? 'opacity-30 cursor-not-allowed'
              : 'opacity-80 hover:opacity-100 hover:scale-110'
          }`}
        >
          <svg className="w-6 h-6 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Card Container */}
        <div className="w-96 h-[28rem] relative">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div
              key={currentStep}
              custom={direction}
              initial={{
                rotateY: direction > 0 ? 90 : -90,
                opacity: 0,
                x: direction > 0 ? 100 : -100,
              }}
              animate={{ rotateY: 0, opacity: 1, x: 0 }}
              exit={{
                rotateY: direction > 0 ? -90 : 90,
                opacity: 0,
                x: direction > 0 ? -100 : 100,
              }}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
              className="absolute inset-0"
              style={{ transformStyle: 'preserve-3d' }}
            >
              <div
                className="w-full h-full rounded-3xl p-8 shadow-2xl border border-white/60 flex flex-col justify-between"
                style={{
                  background: `linear-gradient(135deg, ${steps[currentStep].color}40 0%, ${steps[currentStep].color}20 100%)`,
                  backdropFilter: 'blur(10px)',
                }}
              >
                <div>
                  <div className="text-6xl font-bold mb-6 opacity-20 text-[#2a2a2a]">
                    {steps[currentStep].step}
                  </div>
                  <h3 className="text-2xl mb-4 text-[#2a2a2a]">
                    {steps[currentStep].title}
                  </h3>
                  <p className="text-[#6a6a6a] leading-relaxed">
                    {steps[currentStep].description}
                  </p>
                </div>
                <div className="mt-8 h-32 rounded-2xl bg-white/40 flex items-center justify-center border border-white/60">
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-white to-white/60 flex items-center justify-center">
                    <div
                      className="w-8 h-8 rounded-full"
                      style={{ backgroundColor: steps[currentStep].color }}
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Next Arrow */}
        <button
          onClick={goNext}
          disabled={currentStep === steps.length - 1}
          aria-label="Next step"
          className={`absolute right-4 z-10 w-12 h-12 rounded-full bg-white/60 backdrop-blur-md border border-[#97B3AE]/20 flex items-center justify-center transition-all ${
            currentStep === steps.length - 1
              ? 'opacity-30 cursor-not-allowed'
              : 'opacity-80 hover:opacity-100 hover:scale-110'
          }`}
        >
          <svg className="w-6 h-6 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Step Indicators */}
      <div className="flex justify-center mt-8 gap-2">
        {steps.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Go to step ${i + 1}`}
            className={`h-2 rounded-full transition-all ${
              i === currentStep
                ? 'w-8 bg-[#97B3AE]'
                : 'w-2 bg-[#97B3AE]/30 hover:bg-[#97B3AE]/50'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3.3: Verify TypeScript compiles**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no errors for this file (ignore pre-existing errors if any).

- [ ] **Step 3.4: Commit**

```bash
git add src/app/\(public\)/components/landing/HowItWorksCarousel.tsx
git commit -m "feat(landing): HowItWorksCarousel — 3D AnimatePresence card slider"
```

---

## Task 4: `ContactForm` Component

**Files:**
- Create: `src/app/(public)/components/landing/ContactForm.tsx`

> Tested visually in Task 6. API integration is covered by the route tests in Task 2.

- [ ] **Step 4.1: Create `src/app/(public)/components/landing/ContactForm.tsx`**

```typescript
'use client';

import { useState } from 'react';
import { motion } from 'motion/react';

type FormState = 'idle' | 'loading' | 'success' | 'error';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
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
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), businessName: businessName.trim() }),
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
        className="rounded-2xl bg-white/10 border border-white/30 p-8 text-center"
      >
        <div className="text-4xl mb-4">🎉</div>
        <h3 className="text-2xl text-white mb-2">Request received!</h3>
        <p className="text-white/80">We&apos;ll be in touch within 24 hours.</p>
      </motion.div>
    );
  }

  const inputClass =
    'w-full rounded-lg bg-white/20 border border-white/30 px-4 py-3 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/40 transition-all';

  return (
    <form onSubmit={handleSubmit} noValidate className="max-w-md mx-auto space-y-4">
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

      {state === 'error' && errorMsg && (
        <p className="text-sm text-red-200">{errorMsg}</p>
      )}

      <motion.button
        type="submit"
        disabled={state === 'loading'}
        whileHover={{ scale: 1.05, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}
        whileTap={{ scale: 0.98 }}
        className="w-full px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
      >
        {state === 'loading' ? 'Sending…' : 'Book a Demo'}
      </motion.button>
    </form>
  );
}
```

- [ ] **Step 4.2: Verify TypeScript compiles**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 4.3: Commit**

```bash
git add src/app/\(public\)/components/landing/ContactForm.tsx
git commit -m "feat(landing): ContactForm — controlled form with loading/success/error states"
```

---

## Task 5: Rewrite `page.tsx`

**Files:**
- Modify: `src/app/(public)/page.tsx`

- [ ] **Step 5.1: Replace the entire contents of `src/app/(public)/page.tsx`**

```typescript
'use client';

import { useRef } from 'react';
import { motion, useScroll, useTransform } from 'motion/react';
import { HowItWorksCarousel } from './components/landing/HowItWorksCarousel';
import type { CarouselStep } from './components/landing/HowItWorksCarousel';
import { ContactForm } from './components/landing/ContactForm';

// ── Data ─────────────────────────────────────────────────────────────

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

// ── Page ─────────────────────────────────────────────────────────────

export default function LandingPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const howItWorksRef = useRef<HTMLDivElement>(null);
  const platformsRef = useRef<HTMLDivElement>(null);
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

  return (
    <div ref={containerRef} className="min-h-screen bg-[#D2E0D3] relative overflow-hidden">
      {/* ── Parallax Background ───────────────────────────────────── */}
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

      {/* ── Right-side dot navigation (desktop) ──────────────────── */}
      <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-[#97B3AE]/20">
        {[
          { ref: heroRef, label: 'Hero' },
          { ref: featuresRef, label: 'Features' },
          { ref: howItWorksRef, label: 'How it works' },
          { ref: platformsRef, label: 'Platforms' },
          { ref: ctaRef, label: 'Book a Demo' },
        ].map(({ ref, label }) => (
          <button
            key={label}
            onClick={() => scrollTo(ref)}
            aria-label={`Go to ${label}`}
            className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
          />
        ))}
      </div>

      {/* ── Island Container ─────────────────────────────────────── */}
      <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
        <motion.div
          className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {/* Nav */}
          <nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
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
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
              <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
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
              <motion.button
                onClick={() => scrollTo(ctaRef)}
                className="px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg"
                whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
                whileTap={{ scale: 0.98 }}
              >
                Book a Demo
              </motion.button>
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
          <section ref={platformsRef} className="px-12 py-20 bg-gradient-to-b from-white to-[#F0EEEA]/30">
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

                {/* Floating stat cards */}
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

          {/* CTA + Contact Form */}
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
        </motion.div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5.2: Verify TypeScript compiles**

```bash
pnpm exec tsc --noEmit --project tsconfig.json 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 5.3: Run all tests to confirm nothing regressed**

```bash
pnpm test
```

Expected: all existing tests pass (contact route tests pass; no other tests broken).

- [ ] **Step 5.4: Commit**

```bash
git add src/app/\(public\)/page.tsx
git commit -m "feat(landing): rewrite landing page — Figma island design, sage green palette, Framer Motion"
```

---

## Task 6: Visual Smoke Test

**Goal:** Verify the page renders correctly in the browser — animations play, carousel navigates, form validates and submits.

- [ ] **Step 6.1: Start the dev server**

```bash
pnpm dev
```

Expected: server starts on `http://localhost:3000`

- [ ] **Step 6.2: Open `http://localhost:3000` and verify**

Check each of the following:

| Check | Expected |
|---|---|
| Page background | Sage green `#D2E0D3` |
| Parallax cards visible | 4 glassmorphism floating cards on background |
| Island entrance | Fades + scales in on load |
| Nav links | "Features / How it works / Platforms / Pricing" + RepWorth teal logo |
| Hero heading | "Every review gets the reply it deserves" |
| "Book a Demo" button | Scrolls to CTA/form section |
| Feature cards | 3 cards with teal/blush/beige icons, lift on hover |
| How It Works | Card shows "01 Monitor"; Next arrow flips to "02 Generate"; dots update |
| Platforms | Google wordmark only; dashboard mockup with floating stat cards |
| CTA section | Sage green background, "Start responding smarter today" |
| Contact form | Name/email/businessName fields; "Book a Demo" submit button |
| Form: empty submit | Error message appears, no network request |
| Form: valid submit | Loading state → success state "We'll be in touch within 24 hours" |
| Right dot nav | Visible on wide screens; clicking dots scrolls to section |
| `/pricing` link | Navigates (will 404 — expected until Pricing page is built) |

- [ ] **Step 6.3: Fix any visual regressions, then commit final state**

```bash
git add -p  # stage any fixes
git commit -m "fix(landing): visual smoke test corrections"
```

---

## Task 7: Final Checks + PR

- [ ] **Step 7.1: Run full test suite one last time**

```bash
pnpm test
```

Expected: all pass.

- [ ] **Step 7.2: Build production bundle to catch type/import errors**

```bash
pnpm build
```

Expected: build succeeds with no errors. Ignore warnings about `viewport` metadata or other pre-existing warnings.

- [ ] **Step 7.3: Push branch**

```bash
git push -u origin feat/landing-page-redesign
```

- [ ] **Step 7.4: Open PR**

```bash
gh pr create \
  --title "feat: landing page redesign — Figma island layout + sage green palette" \
  --body "$(cat <<'EOF'
## Summary
- Replaces amber/stone landing page with Figma-designed island layout
- Adopts sage green palette (#97B3AE primary, #F2C3B9 accent, #D2E0D3 bg)
- Adds Framer Motion: parallax background, scroll reveals, 3D carousel, hover lifts
- Drops inline Pricing section; Pricing nav link points to /pricing (future sprint)
- Adds contact form (name/email/business) → POST /api/contact → Resend notification

## Test plan
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds
- [ ] Visual smoke test: all checks in Task 6 verified in browser
- [ ] Contact form submit: success state + email received at norbertesekiel@gmail.com (requires RESEND_API_KEY in env)

🤖 Generated with [Claude Code](https://claude.ai/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Sage green palette — all hex values in page.tsx
- ✅ Island layout — `rounded-[3rem]` container with `max-w-5xl`
- ✅ Parallax background — 4 `motion.div` cards with `useTransform`
- ✅ Right-side dot nav — fixed, desktop only, 5 dots
- ✅ Nav: Features, How it works, Platforms, Pricing link, RepWorth wordmark
- ✅ Hero: heading, subtitle, "Book a Demo" scrolls to CTA
- ✅ Features: 3 cards with correct titles/colors, `whileInView` + `whileHover`
- ✅ How It Works: 4 RepWorth steps (Monitor/Generate/Approve/Post), `AnimatePresence` 3D flip
- ✅ Platforms: Google only, dashboard mockup, floating stat cards, "More platforms coming soon"
- ✅ CTA: sage green gradient, `ContactForm` embedded
- ✅ ContactForm: 3 fields, loading/success/error states, POSTs to /api/contact
- ✅ /api/contact: validates, logs, Resend optional, notifies norbertesekiel@gmail.com
- ✅ `motion` package installed in Task 1
- ✅ Git branch created in Task 1
- ✅ 6 API route tests with full coverage (missing fields, bad email, no key, success, Resend error)

**Placeholder scan:** No TBDs. All code blocks are complete. All commands include expected output.

**Type consistency:** `CarouselStep` interface exported from `HowItWorksCarousel.tsx` and imported in `page.tsx` — consistent. `scrollTo` accepts `React.RefObject<HTMLDivElement | null>` — matches all `useRef<HTMLDivElement>(null)` declarations.
