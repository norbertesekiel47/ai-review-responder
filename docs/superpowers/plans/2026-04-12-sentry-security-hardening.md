# Prompt 16: Sentry + Security Headers + Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sentry error tracking to both Vercel and Railway, security headers on all responses, rate limiting on demo generation, and shared Zod validation schemas for business settings.

**Architecture:** Sentry is initialized separately for Next.js (3 config files) and the Railway worker (init in worker/index.ts before anything else). Security headers are set via `next.config.mjs` headers() for Vercel and Fastify onSend hook for worker. Shared Zod schemas replace the inline schemas in the onboarding and PATCH routes.

**Tech Stack:** `@sentry/nextjs`, `@sentry/node`, Zod, `checkRateLimit()` (already exists)

---

## Already done in Sprint 2 (do NOT rebuild)
- Approval route rate limiting (3/token/min POST, 10/IP/min GET)
- CSRF double-submit pattern
- Approval actions audit-logged
- Input sanitization (sanitizeText + escapeHtml)
- Resend webhook signature verification
- Regeneration budget (3/review/day)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `sentry.client.config.ts` | **CREATE** | Sentry init for browser |
| `sentry.server.config.ts` | **CREATE** | Sentry init for Next.js server |
| `sentry.edge.config.ts` | **CREATE** | Sentry init for Edge Runtime (middleware) |
| `next.config.mjs` | **REWRITE** | Wrap with withSentryConfig + add security headers |
| `worker/index.ts` | **MODIFY** | Sentry.init() for worker + security headers on Fastify |
| `src/lib/shared/schemas.ts` | **CREATE** | Shared Zod schemas for business settings |
| `src/app/api/admin/businesses/route.ts` | **MODIFY** | Import shared schema, add rate limit to POST |
| `src/app/api/admin/businesses/[id]/route.ts` | **MODIFY** | Import shared schema for PATCH |
| `src/app/api/admin/demos/generate/route.ts` | **MODIFY** | Add rate limits (50/day global + 5/min per user) |
| `.env.example` | **MODIFY** | Add SENTRY_DSN, SENTRY_AUTH_TOKEN |

---

## Task 1: Install Sentry packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Sentry**

```bash
pnpm add @sentry/nextjs @sentry/node
```

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: install @sentry/nextjs and @sentry/node"
```

---

## Task 2: Sentry config files for Next.js

**Files:**
- Create: `sentry.client.config.ts`
- Create: `sentry.server.config.ts`
- Create: `sentry.edge.config.ts`

- [ ] **Step 1: Create sentry.client.config.ts** (project root)

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  beforeSend(event) {
    return scrubSensitiveData(event);
  },
});

function scrubSensitiveData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (sensitiveKeys.test(key)) {
        event.extra[key] = '[REDACTED]';
      }
    }
  }
  if (event.request?.headers) {
    for (const key of Object.keys(event.request.headers)) {
      if (sensitiveKeys.test(key)) {
        event.request.headers[key] = '[REDACTED]';
      }
    }
  }
  return event;
}
```

- [ ] **Step 2: Create sentry.server.config.ts** (project root)

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend(event) {
    return scrubSensitiveData(event);
  },
});

function scrubSensitiveData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (sensitiveKeys.test(key)) {
        event.extra[key] = '[REDACTED]';
      }
    }
  }
  if (event.request?.headers) {
    for (const key of Object.keys(event.request.headers)) {
      if (sensitiveKeys.test(key)) {
        event.request.headers[key] = '[REDACTED]';
      }
    }
  }
  return event;
}
```

- [ ] **Step 3: Create sentry.edge.config.ts** (project root)

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add sentry.client.config.ts sentry.server.config.ts sentry.edge.config.ts
git commit -m "feat: add Sentry config files for Next.js (client, server, edge)"
```

---

## Task 3: Wrap next.config.mjs with Sentry + add security headers

**Files:**
- Rewrite: `next.config.mjs`

- [ ] **Step 1: Rewrite next.config.mjs**

Replace `next.config.mjs`:

```javascript
import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['postgres'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Content-Security-Policy',
            value: process.env.NODE_ENV === 'production'
              ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://*.sentry.io https://o*.ingest.sentry.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
              : '',  // Relaxed in dev — Next.js dev tooling needs eval/websockets
          },
        ].filter((h) => h.value !== ''),
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Upload source maps for readable stack traces in production
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress source map upload warnings when auth token is not set (local dev)
  silent: !process.env.SENTRY_AUTH_TOKEN,

  // Disable Sentry telemetry
  telemetry: false,
});
```

- [ ] **Step 2: Verify build**

```bash
pnpm build
```

If CSP blocks anything in production, change `Content-Security-Policy` to `Content-Security-Policy-Report-Only` temporarily.

- [ ] **Step 3: Commit**

```bash
git add next.config.mjs
git commit -m "feat: wrap next.config with Sentry + add security headers (HSTS, CSP, X-Frame-Options)"
```

---

## Task 4: Sentry init + security headers in worker

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add Sentry init and security headers to worker/index.ts**

Add Sentry import and init right after the `import './env'` line (BEFORE any other imports):

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend(event) {
    const sensitiveKeys = /key|secret|token|password|authorization/i;
    if (event.extra) {
      for (const key of Object.keys(event.extra)) {
        if (sensitiveKeys.test(key)) {
          event.extra[key] = '[REDACTED]';
        }
      }
    }
    if (event.request?.headers) {
      for (const key of Object.keys(event.request.headers)) {
        if (sensitiveKeys.test(key)) {
          event.request.headers[key] = '[REDACTED]';
        }
      }
    }
    return event;
  },
});
```

Add security headers as a Fastify `onSend` hook inside the `main()` function, after `app.register(rawBody, ...)` and before route definitions:

```typescript
  // Security headers on all worker responses
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "feat: add Sentry init + security headers to Railway worker"
```

---

## Task 5: Shared Zod schemas for business settings

**Files:**
- Create: `src/lib/shared/schemas.ts`
- Modify: `src/app/api/admin/businesses/route.ts`
- Modify: `src/app/api/admin/businesses/[id]/route.ts`

- [ ] **Step 1: Create shared Zod schemas**

Create `src/lib/shared/schemas.ts`:

```typescript
import { z } from 'zod';

// ── Reusable field schemas ──────────────────────────────────────────

export const businessNameSchema = z.string().min(1, 'Business name is required').max(255);
export const categorySchema = z.string().max(100);
export const toneSchema = z.string().max(100);
export const ownerNameSchema = z.string().min(1, 'Owner name is required').max(255);
export const ownerEmailSchema = z.string().email('Valid email is required').max(255);
export const ownerPhoneSchema = z.string().max(20);
export const staffNamesArraySchema = z.array(z.string().max(100));
export const highlightFactsArraySchema = z.array(z.string().max(500));
export const avoidFactsArraySchema = z.array(z.string().max(500));

// ── Onboarding schema (POST /api/admin/businesses) ─────────────────

export const OnboardBusinessSchema = z.object({
  name: businessNameSchema,
  category: categorySchema.optional(),
  googleMapsUrl: z.string().min(1, 'Google Maps URL is required'),
  ownerName: ownerNameSchema,
  ownerEmail: ownerEmailSchema,
  ownerPhone: ownerPhoneSchema.optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']).default('email'),
  tone: toneSchema.default('professional and friendly'),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']).default('standard'),
});

// ── Update schema (PATCH /api/admin/businesses/:id) ─────────────────

export const UpdateBusinessSchema = z
  .object({
    name: businessNameSchema.optional(),
    category: categorySchema.nullable().optional(),
    tone: toneSchema.optional(),
    productsServices: z.string().max(5000).nullable().optional(),
    staffNames: staffNamesArraySchema.optional(),
    highlightFacts: highlightFactsArraySchema.optional(),
    avoidFacts: avoidFactsArraySchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
```

- [ ] **Step 2: Update onboarding route to import shared schema**

In `src/app/api/admin/businesses/route.ts`:

Replace the import section — add:
```typescript
import { OnboardBusinessSchema } from '@/lib/shared/schemas';
```

Delete the inline `OnboardSchema` definition (the `z.object({...})` block). Replace all references from `OnboardSchema` to `OnboardBusinessSchema`.

- [ ] **Step 3: Update PATCH route to import shared schema**

In `src/app/api/admin/businesses/[id]/route.ts`:

Add:
```typescript
import { UpdateBusinessSchema } from '@/lib/shared/schemas';
```

Delete the inline `UpdateSchema` definition. Replace all references from `UpdateSchema` to `UpdateBusinessSchema`.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/schemas.ts src/app/api/admin/businesses/route.ts "src/app/api/admin/businesses/[id]/route.ts"
git commit -m "feat: extract shared Zod schemas for business validation"
```

---

## Task 6: Rate limit on demo generation

**Files:**
- Modify: `src/app/api/admin/demos/generate/route.ts`

- [ ] **Step 1: Add rate limits to demo generation**

In `src/app/api/admin/demos/generate/route.ts`, add import:
```typescript
import { checkRateLimit } from '@/lib/shared/rate-limit';
```

After the `requireRole()` check and before the Zod validation, add two rate limit checks:

```typescript
  // Rate limit: 50 demos per day globally (cost-sensitive — triggers SerpAPI + LLM)
  const dailyLimit = await checkRateLimit('demo:generate:daily', 50, 86400);
  if (!dailyLimit.allowed) {
    return NextResponse.json(
      { error: 'Daily demo generation limit reached (50/day)' },
      { status: 429 },
    );
  }

  // Rate limit: 5 per minute per IP
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const minuteLimit = await checkRateLimit(`demo:generate:minute:${ip}`, 5, 60);
  if (!minuteLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many demo generations. Try again in a minute.' },
      { status: 429 },
    );
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/demos/generate/route.ts
git commit -m "feat: add rate limits to demo generation (50/day global + 5/min per IP)"
```

---

## Task 7: Update .env.example + build verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add Sentry env vars to .env.example**

Add after the existing `SENTRY_DSN=` line (or if it exists, add the missing ones nearby):

```
NEXT_PUBLIC_SENTRY_DSN=                       # Same DSN, exposed to browser for client-side error reporting
SENTRY_ORG=                                   # Sentry org slug (for source map upload)
SENTRY_PROJECT=                               # Sentry project slug (for source map upload)
SENTRY_AUTH_TOKEN=                            # Sentry auth token (for source map upload, CI only)
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Run tests**

```bash
pnpm test
```

Expected: 189/189 tests pass.

- [ ] **Step 4: Run build**

```bash
pnpm build
```

Expected: compiles successfully with Sentry wrapping.

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "chore: add Sentry env vars to .env.example"
```

---

## Verification Checklist

- [ ] `pnpm build` succeeds with Sentry wrapping (withSentryConfig)
- [ ] `pnpm test` — 189/189 tests pass
- [ ] Security headers visible in browser DevTools Network tab (HSTS, X-Content-Type-Options, X-Frame-Options, CSP in production)
- [ ] Worker responses include HSTS + X-Content-Type-Options headers
- [ ] Demo generation: 51st request in a day → 429 with "Daily demo generation limit reached"
- [ ] Demo generation: 6th request in a minute from same IP → 429
- [ ] Invalid business settings (e.g. name > 255 chars) → 400 with Zod error
- [ ] Sentry DSN set → errors appear in Sentry dashboard (test with a deliberate throw)
- [ ] Sentry scrubs sensitive keys (no API keys/tokens in error payloads)
- [ ] CSP does not break Next.js pages or Supabase auth in production (if it does, switch to Report-Only)
