# Owner Lead Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable public lead-intake flow that captures current waitlist interest in `owner_leads` and can later capture demo requests without renaming the database model.

**Architecture:** Add a dedicated `owner_leads` table, then route all public lead submissions through `POST /api/lead-intake`. Replace the landing and `/book-a-demo` forms with one shared `LeadIntakeForm` that submits `intent` and `source` as explicit props.

**Tech Stack:** Next.js App Router, React client components, Vitest, Postgres.js through `src/lib/db/server.ts`, Supabase migrations, Resend, existing public rate-limit helper.

---

## Scope Check

The approved spec covers one coherent vertical slice: persistence, API, shared form, and public-page copy. It does not need to be split into separate plans because every task supports the same shippable owner-lead intake path.

## File Structure

- Create `supabase/migrations/033_owner_leads.sql`
  - Owns the `owner_leads` table, constraints, and indexes.
- Create `src/app/api/lead-intake/route.ts`
  - Owns public request validation, rate limiting, upsert persistence, and internal notification email.
- Create `src/app/api/lead-intake/__tests__/route.test.ts`
  - Covers request validation, rate limit behavior, DB upsert shape, email notification, and failure behavior.
- Create `src/components/sections/lead-intake/LeadIntakeForm.tsx`
  - Owns reusable owner-lead form state, validation, fetch payload, loading state, success state, and visual tone.
- Create `src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx`
  - Covers waitlist copy and rendered hidden `intent`/`source` values.
- Modify `src/components/sections/landing/LandingContent.tsx`
  - Swaps landing CTA copy and replaces `ContactForm` with `LeadIntakeForm`.
- Create `src/components/sections/landing/__tests__/LandingContent.test.tsx`
  - Covers landing waitlist copy and landing source wiring.
- Modify `src/app/(public)/book-a-demo/BookADemoContent.tsx`
  - Repurposes page copy and replaces `BookDemoForm` with `LeadIntakeForm`.
- Create `src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx`
  - Covers waitlist page copy and `book-a-demo` source wiring.

Leave `src/app/api/contact/route.ts`, `src/app/api/demo-request/route.ts`, `src/components/sections/landing/ContactForm.tsx`, and `src/components/sections/book-a-demo/BookDemoForm.tsx` in place during this implementation. They become unused public-lead remnants after callers move, but removing them is separate cleanup.

---

### Task 1: Add Owner Leads Migration

**Files:**
- Create: `supabase/migrations/033_owner_leads.sql`

- [ ] **Step 1: Create the migration**

Use this exact SQL:

```sql
CREATE TABLE IF NOT EXISTS owner_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  business_name TEXT NOT NULL,
  google_maps_url TEXT,
  intent TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT owner_leads_intent_check
    CHECK (intent IN ('waitlist', 'demo')),
  CONSTRAINT owner_leads_status_check
    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_leads_email_intent_key
  ON owner_leads (email_normalized, intent);

CREATE INDEX IF NOT EXISTS owner_leads_status_created_idx
  ON owner_leads (status, created_at DESC);

CREATE INDEX IF NOT EXISTS owner_leads_source_created_idx
  ON owner_leads (source, created_at DESC);

COMMENT ON TABLE owner_leads IS
  'Public owner interest captured from marketing pages. Supports waitlist and demo lead intake.';

COMMENT ON COLUMN owner_leads.intent IS
  'Current lead intent. waitlist is used during early access; demo can be used when demo booking returns.';
```

- [ ] **Step 2: Inspect the migration file**

Run:

```bash
Get-Content -LiteralPath 'supabase/migrations/033_owner_leads.sql'
```

Expected: the output contains `CREATE TABLE IF NOT EXISTS owner_leads`, `email_normalized`, and `owner_leads_email_intent_key`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/033_owner_leads.sql
git commit -m "feat: add owner leads table"
```

---

### Task 2: Write Failing Lead Intake API Tests

**Files:**
- Create: `src/app/api/lead-intake/__tests__/route.test.ts`

- [ ] **Step 1: Create the API test file**

Use this exact test file:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockCheckRateLimit,
  mockResendSend,
  mockSqlCalls,
  mockSqlShouldThrow,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockResendSend: vi.fn(),
  mockSqlCalls: [] as Array<{ text: string; values: unknown[] }>,
  mockSqlShouldThrow: { value: false },
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () {
    return { emails: { send: mockResendSend } };
  }),
}));

vi.mock('@/lib/db/server', () => ({
  jsonb: (value: unknown) => value,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    mockSqlCalls.push({ text: strings.join('?'), values });
    if (mockSqlShouldThrow.value) {
      return Promise.reject(new Error('synthetic database failure'));
    }
    return Promise.resolve([{ id: '018f0000-0000-7000-8000-000000000001' }]);
  },
}));

function makeRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/lead-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function makeRawRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/lead-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Alice Owner',
    email: 'OWNER@Example.COM ',
    businessName: 'Alice Bakery',
    googleMapsUrl: 'https://maps.google.com/maps?cid=123',
    intent: 'waitlist',
    source: 'landing',
    ...overrides,
  };
}

async function post(req: NextRequest) {
  const { POST } = await import('../route');
  return POST(req);
}

describe('POST /api/lead-intake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlCalls.length = 0;
    mockSqlShouldThrow.value = false;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.CONTACT_NOTIFY_TO;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await post(makeRawRequest('{bad-json'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid json/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('returns 400 when name is missing', async () => {
    const res = await post(makeRequest(validBody({ name: '' })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('returns 400 when email is malformed', async () => {
    const res = await post(makeRequest(validBody({ email: 'not-an-email' })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('returns 400 when businessName is missing', async () => {
    const res = await post(makeRequest(validBody({ businessName: '' })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/business/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('returns 400 when googleMapsUrl is not https', async () => {
    const res = await post(makeRequest(validBody({ googleMapsUrl: 'http://maps.google.com' })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('persists a valid waitlist lead with normalized email and upsert conflict target', async () => {
    const res = await post(makeRequest(validBody()));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockSqlCalls).toHaveLength(1);
    expect(mockSqlCalls[0].text).toContain('INSERT INTO owner_leads');
    expect(mockSqlCalls[0].text).toContain('ON CONFLICT (email_normalized, intent)');
    expect(mockSqlCalls[0].values).toEqual(expect.arrayContaining([
      'Alice Owner',
      'owner@example.com',
      'Alice Bakery',
      'https://maps.google.com/maps?cid=123',
      'waitlist',
      'landing',
    ]));
  });

  it('defaults missing intent and source to waitlist and unknown', async () => {
    const res = await post(makeRequest(validBody({ intent: undefined, source: undefined })));

    expect(res.status).toBe(200);
    expect(mockSqlCalls[0].values).toEqual(expect.arrayContaining(['waitlist', 'unknown']));
  });

  it('preserves demo intent for the future demo-request phase', async () => {
    const res = await post(makeRequest(validBody({ intent: 'demo', source: 'book-a-demo' })));

    expect(res.status).toBe(200);
    expect(mockSqlCalls[0].values).toEqual(expect.arrayContaining(['demo', 'book-a-demo']));
  });

  it('returns 400 for unsupported intent', async () => {
    const res = await post(makeRequest(validBody({ intent: 'newsletter' })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/intent/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('returns 400 for unsupported source', async () => {
    const res = await post(makeRequest(validBody({ source: 'sidebar' })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const res = await post(makeRequest(validBody()));

    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/too many/i);
    expect(mockSqlCalls).toHaveLength(0);
  });

  it('sends a waitlist notification email after persistence when Resend is configured', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    process.env.CONTACT_NOTIFY_TO = 'ops@repworth.com';

    const res = await post(makeRequest(validBody()));

    expect(res.status).toBe(200);
    expect(mockResendSend).toHaveBeenCalledOnce();
    const message = mockResendSend.mock.calls[0]?.[0] as {
      from: string;
      to: string;
      subject: string;
      text: string;
    };
    expect(message.from).toBe('noreply@repworth.com');
    expect(message.to).toBe('ops@repworth.com');
    expect(message.subject).toContain('waitlist');
    expect(message.text).toContain('Alice Owner');
    expect(message.text).toContain('owner@example.com');
    expect(message.text).toContain('Alice Bakery');
  });

  it('returns 500 and skips email when persistence fails', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockSqlShouldThrow.value = true;

    const res = await post(makeRequest(validBody()));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed/i);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('returns 500 when Resend returns an error after persistence', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'send failed' } });

    const res = await post(makeRequest(validBody()));

    expect(res.status).toBe(500);
    expect(mockSqlCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the API tests to verify they fail**

Run:

```bash
pnpm exec vitest run "src/app/api/lead-intake/__tests__/route.test.ts"
```

Expected: FAIL because `src/app/api/lead-intake/route.ts` does not exist.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/lead-intake/__tests__/route.test.ts
git commit -m "test: cover owner lead intake api"
```

---

### Task 3: Implement Lead Intake API Route

**Files:**
- Create: `src/app/api/lead-intake/route.ts`
- Test: `src/app/api/lead-intake/__tests__/route.test.ts`

- [ ] **Step 1: Create the API route**

Use this exact route:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { jsonb, sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_NOTIFY_TO = 'norbertesekiel@gmail.com';

const MAX_NAME_LEN = 200;
const MAX_BUSINESS_NAME_LEN = 300;
const MAX_URL_LEN = 2048;

const VALID_INTENTS = ['waitlist', 'demo'] as const;
const VALID_SOURCES = ['landing', 'book-a-demo', 'pricing', 'unknown'] as const;

type LeadIntent = (typeof VALID_INTENTS)[number];
type LeadSource = (typeof VALID_SOURCES)[number];

function isLeadIntent(value: string): value is LeadIntent {
  return (VALID_INTENTS as readonly string[]).includes(value);
}

function isLeadSource(value: string): value is LeadSource {
  return (VALID_SOURCES as readonly string[]).includes(value);
}

function resolveIntent(value: unknown): LeadIntent | null {
  if (value === undefined || value === null || value === '') return 'waitlist';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return isLeadIntent(normalized) ? normalized : null;
}

function resolveSource(value: unknown): LeadSource | null {
  if (value === undefined || value === null || value === '') return 'unknown';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return isLeadSource(normalized) ? normalized : null;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rateCheck = await checkRateLimit(`lead-intake:hour:${ip}`, 5, 3600);
  if (!rateCheck.allowed) {
    return jsonError('Too many submissions. Try again later.', 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError('Invalid JSON', 400);
  }

  const { name, email, businessName, googleMapsUrl } = body as Record<string, unknown>;
  const intent = resolveIntent((body as Record<string, unknown>).intent);
  const source = resolveSource((body as Record<string, unknown>).source);

  if (!name || typeof name !== 'string' || !name.trim()) {
    return jsonError('name is required', 400);
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return jsonError('A valid email is required', 400);
  }
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    return jsonError('businessName is required', 400);
  }
  if (!intent) {
    return jsonError('intent must be waitlist or demo', 400);
  }
  if (!source) {
    return jsonError('source is invalid', 400);
  }

  const trimmedName = name.trim();
  const emailNormalized = email.trim().toLowerCase();
  const trimmedBusinessName = businessName.trim();

  if (trimmedName.length > MAX_NAME_LEN) {
    return jsonError('name is too long', 400);
  }
  if (trimmedBusinessName.length > MAX_BUSINESS_NAME_LEN) {
    return jsonError('businessName is too long', 400);
  }

  const rawUrl = typeof googleMapsUrl === 'string' ? googleMapsUrl.trim() : '';
  if (rawUrl) {
    if (rawUrl.length > MAX_URL_LEN) {
      return jsonError('googleMapsUrl is too long', 400);
    }
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:') throw new Error('expected https');
    } catch {
      return jsonError('googleMapsUrl must be a valid https URL', 400);
    }
  }

  const timestamp = new Date().toISOString();
  const metadata = {
    ip,
    userAgent: req.headers.get('user-agent'),
    referer: req.headers.get('referer'),
    submittedAt: timestamp,
  };

  try {
    await sql`
      INSERT INTO owner_leads (
        name,
        email,
        email_normalized,
        business_name,
        google_maps_url,
        intent,
        source,
        metadata
      )
      VALUES (
        ${trimmedName},
        ${emailNormalized},
        ${emailNormalized},
        ${trimmedBusinessName},
        ${rawUrl || null},
        ${intent},
        ${source},
        ${jsonb(metadata)}
      )
      ON CONFLICT (email_normalized, intent)
      DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        business_name = EXCLUDED.business_name,
        google_maps_url = EXCLUDED.google_maps_url,
        source = EXCLUDED.source,
        metadata = owner_leads.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `;
  } catch (error) {
    console.error('[lead-intake] database error:', error);
    return jsonError('Failed to save lead', 500);
  }

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM_EMAIL ?? 'noreply@repworth.com';
    const notifyTo = process.env.CONTACT_NOTIFY_TO ?? DEFAULT_NOTIFY_TO;
    const text = [
      `New owner lead - ${intent} - RepWorth`,
      '',
      `Name:         ${trimmedName}`,
      `Email:        ${emailNormalized}`,
      `Business:     ${trimmedBusinessName}`,
      `Intent:       ${intent}`,
      `Source:       ${source}`,
      `Google Maps:  ${rawUrl || '(not provided)'}`,
      `Submitted at: ${timestamp}`,
    ].join('\n');

    const { error } = await resend.emails.send({
      from,
      to: notifyTo,
      subject: `New owner lead - ${intent} - RepWorth`,
      text,
    });

    if (error) {
      console.error('[lead-intake] Resend error:', error.message);
      return jsonError('Failed to send notification', 500);
    }
  }

  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Run the API tests**

Run:

```bash
pnpm exec vitest run "src/app/api/lead-intake/__tests__/route.test.ts"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/lead-intake/route.ts src/app/api/lead-intake/__tests__/route.test.ts
git commit -m "feat: add owner lead intake api"
```

---

### Task 4: Write Failing Lead Intake Form Tests

**Files:**
- Create: `src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx`

- [ ] **Step 1: Create the component test**

Use this exact test file:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeadIntakeForm } from '../LeadIntakeForm';

describe('LeadIntakeForm', () => {
  it('renders waitlist copy and carries landing source', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, {
        intent: 'waitlist',
        source: 'landing',
        tone: 'onTeal',
      }),
    );

    expect(html).toContain('Join waitlist');
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('name="source"');
    expect(html).toContain('value="landing"');
    expect(html).not.toContain('Book a Demo');
    expect(html).not.toContain('Book My Demo');
  });

  it('renders demo intent when the future demo phase opts in', () => {
    const html = renderToStaticMarkup(
      createElement(LeadIntakeForm, {
        intent: 'demo',
        source: 'book-a-demo',
        tone: 'light',
        copy: {
          button: 'Request demo',
          successHeading: 'Request received.',
          successBody: 'We will reach out to coordinate a demo.',
        },
      }),
    );

    expect(html).toContain('Request demo');
    expect(html).toContain('value="demo"');
    expect(html).toContain('value="book-a-demo"');
  });
});
```

- [ ] **Step 2: Run the form tests to verify they fail**

Run:

```bash
pnpm exec vitest run "src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx"
```

Expected: FAIL because `src/components/sections/lead-intake/LeadIntakeForm.tsx` does not exist.

- [ ] **Step 3: Commit**

```bash
git add src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx
git commit -m "test: cover lead intake form rendering"
```

---

### Task 5: Implement Shared Lead Intake Form

**Files:**
- Create: `src/components/sections/lead-intake/LeadIntakeForm.tsx`
- Test: `src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx`

- [ ] **Step 1: Create the shared form component**

Use this exact component:

```tsx
'use client';

import { useState } from 'react';
import { motion } from 'motion/react';

export type LeadIntent = 'waitlist' | 'demo';
export type LeadSource = 'landing' | 'book-a-demo' | 'pricing' | 'unknown';
type FormState = 'idle' | 'loading' | 'success' | 'error';
type LeadIntakeTone = 'onTeal' | 'light';

interface LeadIntakeCopy {
  button: string;
  loading: string;
  successHeading: string;
  successBody: string;
}

interface LeadIntakeFormProps {
  intent: LeadIntent;
  source: LeadSource;
  tone?: LeadIntakeTone;
  copy?: Partial<LeadIntakeCopy>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_COPY: LeadIntakeCopy = {
  button: 'Join waitlist',
  loading: 'Joining...',
  successHeading: "You're on the waitlist.",
  successBody: "We'll reach out when early access opens for your area.",
};

export function LeadIntakeForm({
  intent,
  source,
  tone = 'onTeal',
  copy,
}: LeadIntakeFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const labels = { ...DEFAULT_COPY, ...copy };

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
      const res = await fetch('/api/lead-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          businessName: businessName.trim(),
          googleMapsUrl: googleMapsUrl.trim(),
          intent,
          source,
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

  const isOnTeal = tone === 'onTeal';
  const inputClass = isOnTeal
    ? 'w-full rounded-lg bg-white/20 border border-white/30 px-4 py-3 text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/40 transition-all'
    : 'w-full rounded-lg bg-[#F0EEEA]/50 border border-[#97B3AE]/20 px-4 py-3 text-[#2a2a2a] placeholder-[#6a6a6a]/60 focus:outline-none focus:ring-2 focus:ring-[#97B3AE]/40 transition-all text-sm';
  const buttonClass = isOnTeal
    ? 'w-full px-10 py-4 bg-white text-[#97B3AE] rounded-full shadow-xl font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity'
    : 'w-full px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-opacity';
  const errorClass = isOnTeal ? 'text-sm text-red-200' : 'text-sm text-red-500';
  const successClass = isOnTeal
    ? 'rounded-2xl bg-white/10 border border-white/30 p-8 text-center'
    : 'rounded-2xl bg-white border border-[#97B3AE]/20 shadow-lg p-8 text-center';
  const successHeadingClass = isOnTeal
    ? 'text-2xl text-white mb-2'
    : 'text-2xl text-[#2a2a2a] font-medium mb-2';
  const successBodyClass = isOnTeal ? 'text-white/80' : 'text-[#6a6a6a]';

  if (state === 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={successClass}
      >
        <h3 className={successHeadingClass}>{labels.successHeading}</h3>
        <p className={successBodyClass}>{labels.successBody}</p>
      </motion.div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="max-w-md mx-auto space-y-4">
      <input type="hidden" name="intent" value={intent} readOnly />
      <input type="hidden" name="source" value={source} readOnly />
      <input
        type="text"
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="name"
        aria-label="Your name"
        name="name"
      />
      <input
        type="email"
        placeholder="Email address"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="email"
        aria-label="Email address"
        name="email"
      />
      <input
        type="text"
        placeholder="Business name"
        value={businessName}
        onChange={(e) => setBusinessName(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="organization"
        aria-label="Business name"
        name="organization"
      />
      <input
        type="text"
        placeholder="Google Maps link (optional)"
        value={googleMapsUrl}
        onChange={(e) => setGoogleMapsUrl(e.target.value)}
        disabled={state === 'loading'}
        className={inputClass}
        autoComplete="url"
        aria-label="Google Maps link"
        name="url"
      />

      {state === 'error' && errorMsg && (
        <p className={errorClass}>{errorMsg}</p>
      )}

      <motion.button
        type="submit"
        disabled={state === 'loading'}
        whileHover={{ scale: 1.05, boxShadow: isOnTeal ? '0 20px 40px rgba(0,0,0,0.2)' : '0 20px 40px rgba(151,179,174,0.3)' }}
        whileTap={{ scale: 0.98 }}
        className={buttonClass}
      >
        {state === 'loading' ? labels.loading : labels.button}
      </motion.button>
    </form>
  );
}
```

- [ ] **Step 2: Run the form tests**

Run:

```bash
pnpm exec vitest run "src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/sections/lead-intake/LeadIntakeForm.tsx src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx
git commit -m "feat: add shared lead intake form"
```

---

### Task 6: Convert Landing CTA to Waitlist

**Files:**
- Modify: `src/components/sections/landing/LandingContent.tsx`
- Create: `src/components/sections/landing/__tests__/LandingContent.test.tsx`
- Uses: `src/components/sections/lead-intake/LeadIntakeForm.tsx`

- [ ] **Step 1: Write the failing landing test**

Use this exact test file:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingContent } from '../LandingContent';

describe('LandingContent lead intake copy', () => {
  it('uses waitlist copy and submits landing source', () => {
    const html = renderToStaticMarkup(createElement(LandingContent));

    expect(html).toContain('Join waitlist');
    expect(html).toContain('Join the early access waitlist.');
    expect(html).toContain('value="landing"');
    expect(html).toContain('value="waitlist"');
    expect(html).not.toContain('personalised demo within 24 hours');
    expect(html).not.toContain('Book a demo');
  });
});
```

- [ ] **Step 2: Run the landing test to verify it fails**

Run:

```bash
pnpm exec vitest run "src/components/sections/landing/__tests__/LandingContent.test.tsx"
```

Expected: FAIL because landing still renders demo copy.

- [ ] **Step 3: Update `LandingContent.tsx` imports**

Replace:

```ts
import { ContactForm } from './ContactForm';
```

with:

```ts
import { LeadIntakeForm } from '@/components/sections/lead-intake/LeadIntakeForm';
```

- [ ] **Step 4: Update section label and hero CTA**

Replace:

```ts
{ id: 'rw-cta', label: 'Book a demo' },
```

with:

```ts
{ id: 'rw-cta', label: 'Join waitlist' },
```

Replace:

```tsx
primaryCtaLabel={comingSoon ? 'Coming soon' : 'Book a demo'}
```

with:

```tsx
primaryCtaLabel={comingSoon ? 'Coming soon' : 'Join waitlist'}
```

- [ ] **Step 5: Replace the landing CTA section body**

Replace the non-coming-soon CTA section:

```tsx
<section ref={ctaRef} className="rw-cta" id="rw-cta">
  <h2>Start responding smarter today.</h2>
  <p>
    Tell us about your business and we&apos;ll set you up with a
    personalised demo within 24 hours.
  </p>
  <ContactForm />
</section>
```

with:

```tsx
<section ref={ctaRef} className="rw-cta" id="rw-cta">
  <h2>Join the early access waitlist.</h2>
  <p>
    Tell us about your business and we&apos;ll reach out when early access
    opens for your area.
  </p>
  <LeadIntakeForm intent="waitlist" source="landing" tone="onTeal" />
</section>
```

- [ ] **Step 6: Run landing and form tests**

Run:

```bash
pnpm exec vitest run "src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx" "src/components/sections/landing/__tests__/LandingContent.test.tsx"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/sections/landing/LandingContent.tsx src/components/sections/landing/__tests__/LandingContent.test.tsx
git commit -m "feat: convert landing cta to waitlist"
```

---

### Task 7: Repurpose Book A Demo Page as Waitlist

**Files:**
- Modify: `src/app/(public)/book-a-demo/BookADemoContent.tsx`
- Create: `src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx`
- Uses: `src/components/sections/lead-intake/LeadIntakeForm.tsx`

- [ ] **Step 1: Write the failing book-a-demo page test**

Use this exact test file:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BookADemoContent } from '../BookADemoContent';

vi.mock('@/components/ui/PageShell', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    PageShell: ({ children }: { children: import('react').ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('BookADemoContent waitlist repurpose', () => {
  it('uses waitlist copy and submits book-a-demo source', () => {
    const html = renderToStaticMarkup(createElement(BookADemoContent));

    expect(html).toContain('Join the RepWorth early access waitlist');
    expect(html).toContain('value="book-a-demo"');
    expect(html).toContain('value="waitlist"');
    expect(html).toContain('Join waitlist');
    expect(html).not.toContain('Book your demo');
    expect(html).not.toContain('Takes 15 minutes');
  });
});
```

- [ ] **Step 2: Run the book-a-demo test to verify it fails**

Run:

```bash
pnpm exec vitest run "src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx"
```

Expected: FAIL because `/book-a-demo` still renders demo copy.

- [ ] **Step 3: Update `BookADemoContent.tsx` imports**

Replace:

```ts
import { BookDemoForm } from '@/components/sections/book-a-demo/BookDemoForm';
```

with:

```ts
import { LeadIntakeForm } from '@/components/sections/lead-intake/LeadIntakeForm';
```

- [ ] **Step 4: Replace page constants**

Replace:

```ts
const DEMO_BULLETS = [
  'We pull your actual Google reviews live',
  'AI generates personalized responses for each one',
  'We walk through the one-tap approval flow together',
  'You ask any questions - no sales pressure',
];
```

with:

```ts
const WAITLIST_BULLETS = [
  'Get notified when early access opens for your area',
  'Help us prioritize your business and location',
  'Share your Google Maps listing so setup is faster later',
  'Move cleanly into a demo request when bookings reopen',
];
```

Replace:

```ts
const TRUST_SIGNALS = [
  'Trusted by local businesses across the US',
  'Your data is never shared or sold',
  'No contracts - cancel anytime',
];
```

with:

```ts
const TRUST_SIGNALS = [
  'Built for local business owners',
  'Your data is never shared or sold',
  'No commitment while you wait',
];
```

If the file currently contains an em dash in these strings, use the ASCII hyphen version above.

- [ ] **Step 5: Update page labels and copy**

Replace:

```ts
const sections = [{ ref: formRef, label: 'Book' }];
```

with:

```ts
const sections = [{ ref: formRef, label: 'Waitlist' }];
```

Replace the left-side copy block:

```tsx
<p className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4">Free demo</p>
<h1 className="text-4xl md:text-5xl font-medium leading-tight text-[#2a2a2a] mb-6">
  See your reviews answered in 60 seconds
</h1>
<p className="text-[#6a6a6a] mb-8 italic text-sm">
  Takes 15 minutes. No commitment.
</p>
```

with:

```tsx
<p className="text-sm tracking-wider uppercase text-[#97B3AE] mb-4">Early access</p>
<h1 className="text-4xl md:text-5xl font-medium leading-tight text-[#2a2a2a] mb-6">
  Join the RepWorth early access waitlist
</h1>
<p className="text-[#6a6a6a] mb-8 italic text-sm">
  We will reach out when your area opens.
</p>
```

Replace:

```tsx
{DEMO_BULLETS.map((bullet, i) => (
```

with:

```tsx
{WAITLIST_BULLETS.map((bullet, i) => (
```

- [ ] **Step 6: Replace the form card copy and component**

Replace:

```tsx
<h2 className="text-xl font-medium text-[#2a2a2a] mb-6">Book your demo</h2>
<BookDemoForm />
```

with:

```tsx
<h2 className="text-xl font-medium text-[#2a2a2a] mb-6">Join waitlist</h2>
<LeadIntakeForm intent="waitlist" source="book-a-demo" tone="light" />
```

- [ ] **Step 7: Run book-a-demo and form tests**

Run:

```bash
pnpm exec vitest run "src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx" "src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(public)/book-a-demo/BookADemoContent.tsx" "src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx"
git commit -m "feat: repurpose demo page for waitlist"
```

---

### Task 8: Final Verification

**Files:**
- Verify all files changed in Tasks 1 through 7.

- [ ] **Step 1: Run all targeted tests**

Run:

```bash
pnpm exec vitest run "src/app/api/lead-intake/__tests__/route.test.ts" "src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx" "src/components/sections/landing/__tests__/LandingContent.test.tsx" "src/app/(public)/book-a-demo/__tests__/BookADemoContent.test.tsx"
```

Expected: PASS.

- [ ] **Step 2: Run nearby legacy form endpoint tests**

Run:

```bash
pnpm exec vitest run "src/app/api/contact/__tests__/route.test.ts" "src/app/api/demo-request/__tests__/route.test.ts"
```

Expected: PASS. These routes remain in the repo and should not regress.

- [ ] **Step 3: Run production build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: no unstaged changes except generated artifacts from test/build tooling. If generated artifacts appear under `playwright-report` or `test-results`, restore only those generated artifacts after verifying they are unrelated to the feature.

- [ ] **Step 5: Commit final verification notes only if files changed**

If Step 4 shows code or migration files changed after the prior commits, inspect them and commit the intentional changes:

```bash
git add supabase/migrations/033_owner_leads.sql src/app/api/lead-intake src/components/sections/lead-intake src/components/sections/landing/LandingContent.tsx "src/app/(public)/book-a-demo/BookADemoContent.tsx"
git commit -m "chore: verify owner lead intake"
```

Expected: a commit is created only when intentional feature files changed after earlier task commits.

---

## Self-Review Notes

- Spec coverage:
  - `owner_leads` table: Task 1.
  - `/api/lead-intake`: Tasks 2 and 3.
  - Shared public form: Tasks 4 and 5.
  - Landing page waitlist copy and `source="landing"`: Task 6.
  - `/book-a-demo` repurposed as waitlist and `source="book-a-demo"`: Task 7.
  - Existing contact/demo routes left untouched: File Structure and Task 8.
  - Verification: Task 8.
- Type consistency:
  - `LeadIntent` values are `waitlist` and `demo` in the API, form, tests, and migration.
  - `LeadSource` values are `landing`, `book-a-demo`, `pricing`, and `unknown` in the API, form, and tests.
  - Form payload uses `businessName`; database column uses `business_name`.
- Plan hygiene:
  - Every created or modified path is listed.
  - Every code step includes exact code or exact replacement snippets.
  - Every verification step includes the exact command and expected result.
