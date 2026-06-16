# Security-Audit Remediation — Phase 6 Implementation Plan (Webhook/Ingress Hardening)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land F-14 (Stripe `event.created` staleness guard), F-15 (widen the `inbound_events` reclaim window), and F-21 (`/ingress/*` per-IP rate limit) as one PR; staging soak + merge operator-gated after green CI.

**Architecture:** F-14 adds a generous pre-dispatch staleness check in the Stripe handler. F-15 turns the reclaim interval into a named constant and widens it via a parameterized `make_interval`. F-21 reuses the existing `checkRateLimit` (no new dep) in a small `worker/ingress/rate-limit.ts` module, wired via one path-scoped `onRequest` hook in `worker/index.ts`.

**Tech Stack:** TypeScript (strict), Vitest, Fastify v5 worker, Postgres.js, ioredis/Upstash (`checkRateLimit`), Stripe SDK.

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-6-design.md`
**Branch:** `security/audit-remediation-phase-6` (already created off `main` @ `b58ede7c`).

---

## File Structure

**Created:**
- `worker/ingress/rate-limit.ts` — `ingressClientIp` + `enforceIngressRateLimit` (F-21).
- `worker/ingress/__tests__/rate-limit.test.ts` — unit tests for both (F-21).

**Modified:**
- `worker/ingress/stripe.ts` — pre-dispatch staleness guard + `STALE_EVENT_THRESHOLD_SECONDS` (F-14).
- `worker/ingress/__tests__/stripe.test.ts` — stale/fresh/within-window cases (F-14).
- `worker/ingress/shared.ts` — `RECLAIM_AFTER_MINUTES` constant + `make_interval` reclaim (F-15).
- `worker/index.ts` — register the `/ingress/*` `onRequest` rate-limit hook (F-21).

---

## Task 1: F-14 — Stripe `event.created` staleness guard

TDD: add stale/fresh/within-window tests (red), then the guard (green).

**Files:**
- Test: `worker/ingress/__tests__/stripe.test.ts`
- Modify: `worker/ingress/stripe.ts`

- [ ] **Step 1: Write the failing tests**

Read `worker/ingress/__tests__/stripe.test.ts` first for the existing request/reply builders and how `mockConstructEvent` / `mockClaimInboundEvent` are used (the harness is hoisted at the top of the file). Add these tests (adapt the request/reply builder names to the file's existing helpers — they build a `FastifyRequest` with a `stripe-signature` header + `rawBody`, and a reply spy with `.status()`/`.send()`):

```ts
  it('rejects an event whose created is older than the stale threshold', async () => {
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;
    mockConstructEvent.mockReturnValue({
      id: 'evt_stale',
      type: 'invoice.paid',
      created: eightDaysAgo,
      data: { object: {} },
    });
    const reply = buildReply();
    await handleStripeWebhook(buildRequest(), reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ stale: true }));
    // Stale events are dropped BEFORE claim/dispatch.
    expect(mockClaimInboundEvent).not.toHaveBeenCalled();
  });

  it('processes a recent event (created = now)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_fresh',
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    });
    mockClaimInboundEvent.mockResolvedValue('claimed');
    const reply = buildReply();
    await handleStripeWebhook(buildRequest(), reply);

    expect(mockClaimInboundEvent).toHaveBeenCalledTimes(1);
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('processes a legitimately-retried event within the retry window (created ~2 days ago)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_retry',
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
      data: { object: {} },
    });
    mockClaimInboundEvent.mockResolvedValue('claimed');
    const reply = buildReply();
    await handleStripeWebhook(buildRequest(), reply);

    expect(mockClaimInboundEvent).toHaveBeenCalledTimes(1);
  });
```

If the file lacks reusable `buildRequest`/`buildReply` helpers, copy the inline request/reply construction the existing tests use (a `FastifyRequest` cast with `headers['stripe-signature']='sig'` + `rawBody:'{}'`, and a reply with `vi.fn()` `status`/`send` returning the reply). `mockConstructEvent` already substitutes signature verification, so a dummy `rawBody` + `sig` is enough.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- worker/ingress/__tests__/stripe.test.ts`
Expected: FAIL — the stale test's `mockClaimInboundEvent` IS called today (no guard), and no `stale:true` is sent.

- [ ] **Step 3: Add the staleness guard**

In `worker/ingress/stripe.ts`, add a module constant near the top (after the imports):
```ts
// Stripe retries a failed webhook for up to ~3 days (fresh signature each time,
// but the original event.created). Reject only events far beyond that window —
// a generous anomaly guard that never drops a legitimate retry. Replay within
// the window is already blocked by constructEvent's 5-min signature tolerance +
// idempotency (claimInboundEvent).
const STALE_EVENT_THRESHOLD_SECONDS = 7 * 24 * 60 * 60; // 7 days
```
Then, in `handleStripeWebhook`, immediately AFTER the `event = getStripe().webhooks.constructEvent(...)` try/catch block succeeds and BEFORE the `// Dedup + reclaim` / `claimInboundEvent` call, insert:
```ts
  const eventAgeSeconds = Math.floor(Date.now() / 1000) - event.created;
  if (eventAgeSeconds > STALE_EVENT_THRESHOLD_SECONDS) {
    console.warn(
      `${LOG_PREFIX} Rejecting stale event ${event.id} (${event.type}) — age ${eventAgeSeconds}s exceeds ${STALE_EVENT_THRESHOLD_SECONDS}s`,
    );
    reply.status(200).send({ received: true, stale: true });
    return;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- worker/ingress/__tests__/stripe.test.ts`
Expected: PASS (new cases + all existing stripe handler tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add worker/ingress/stripe.ts worker/ingress/__tests__/stripe.test.ts
git commit -m "fix(ingress): reject stale Stripe events past the retry window (F-14)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: F-15 — widen the inbound-event reclaim window

No behavior-assertion test change is required: `shared.test.ts`'s reclaim test
drives `claimInboundEvent` through a mocked `sql` queue and does NOT assert the
SQL text/interval, so it stays green. The reclaim path is DB-backed and
exercised by CI's integration run, which validates the `make_interval` form parses.

**Files:**
- Modify: `worker/ingress/shared.ts`

- [ ] **Step 1: Add the constant**

In `worker/ingress/shared.ts`, add near the top (after the imports, before `claimInboundEvent`):
```ts
// A 'received' row is reclaimable after this long — covers worker crashes +
// transient retry windows. Widened from 2min (F-15): if an ingress handler runs
// longer than the window, a concurrent provider retry could reclaim the row and
// double-process. Providers retry on non-200 regardless, so the slower
// crash-recovery is harmless; idempotency backstops any residual double-process.
const RECLAIM_AFTER_MINUTES = 10;
```

- [ ] **Step 2: Use it in the reclaim UPDATE**

In `claimInboundEvent`, replace the reclaim predicate line:
```ts
      AND (status = 'failed' OR (status = 'received' AND received_at < NOW() - INTERVAL '2 minutes'))
```
with:
```ts
      AND (status = 'failed' OR (status = 'received'
            AND received_at < NOW() - make_interval(mins => ${RECLAIM_AFTER_MINUTES})))
```
(Postgres.js binds `${RECLAIM_AFTER_MINUTES}` as a parameter to `make_interval(mins => $n)` — no string-interpolated SQL. Also update the JSDoc above `claimInboundEvent` that says "> 2min" to "> RECLAIM_AFTER_MINUTES (10min)".)

- [ ] **Step 3: Run the shared + ingress tests**

Run: `pnpm test -- worker/ingress/__tests__/shared.test.ts worker/ingress/__tests__`
Expected: PASS (mocked-sql reclaim tests are unaffected by the SQL-text change).

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add worker/ingress/shared.ts
git commit -m "fix(ingress): widen inbound_events reclaim window 2m->10m (F-15)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: F-21 — ingress rate-limit module

TDD: write `rate-limit.test.ts` (red), then create the module (green). Reuses the existing `checkRateLimit` — no new dependency.

**Files:**
- Create: `worker/ingress/rate-limit.ts`, `worker/ingress/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `worker/ingress/__tests__/rate-limit.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const { mockCheckRateLimit } = vi.hoisted(() => ({ mockCheckRateLimit: vi.fn() }));
vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));

import { ingressClientIp, enforceIngressRateLimit } from '../rate-limit';

function buildReq(headers: Record<string, string | string[]>, ip = '9.9.9.9'): FastifyRequest {
  return { headers, ip } as unknown as FastifyRequest;
}
function buildReply() {
  const reply = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
  return reply as unknown as FastifyReply & { status: any; send: any };
}

beforeEach(() => mockCheckRateLimit.mockReset());

describe('ingressClientIp', () => {
  it('uses the X-Forwarded-For first hop', () => {
    expect(ingressClientIp(buildReq({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });
  it('falls back to request.ip when XFF is absent', () => {
    expect(ingressClientIp(buildReq({}, '5.6.7.8'))).toBe('5.6.7.8');
  });
  it('returns "unknown" when neither is present', () => {
    expect(ingressClientIp(buildReq({}, ''))).toBe('unknown');
  });
});

describe('enforceIngressRateLimit', () => {
  it('sends 429 when the limiter denies', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const reply = buildReply();
    await enforceIngressRateLimit(buildReq({ 'x-forwarded-for': '1.2.3.4' }), reply);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('ingress:1.2.3.4', 120, 60);
  });
  it('does not respond when the limiter allows', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
    const reply = buildReply();
    await enforceIngressRateLimit(buildReq({ 'x-forwarded-for': '1.2.3.4' }), reply);
    expect(reply.status).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- worker/ingress/__tests__/rate-limit.test.ts`
Expected: FAIL — `../rate-limit` does not exist.

- [ ] **Step 3: Create the module**

Create `worker/ingress/rate-limit.ts`:
```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from '@/lib/shared/rate-limit';

// Generous per-IP DoS/abuse backstop. Providers (Stripe/Twilio/Telegram/Zernio)
// burst many webhooks from the same source IP, so the ceiling is high — this
// bounds flood/work-amplification, NOT per-tenant traffic (signature verify
// already gates forgery). checkRateLimit fails open on a Redis error, so a
// blip never drops a legitimate webhook.
const INGRESS_MAX_PER_MINUTE = 120;
const INGRESS_WINDOW_SECONDS = 60;

// Fastify runs without trustProxy, so request.ip is the Railway edge proxy.
// Read the X-Forwarded-For first hop (the real client) for keying, scoped to
// this limiter — avoids a global trustProxy change. Falls back to request.ip.
export function ingressClientIp(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  const firstHop = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return firstHop || request.ip || 'unknown';
}

export async function enforceIngressRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { allowed } = await checkRateLimit(
    `ingress:${ingressClientIp(request)}`,
    INGRESS_MAX_PER_MINUTE,
    INGRESS_WINDOW_SECONDS,
  );
  if (!allowed) {
    reply.status(429).send({ error: 'rate_limited' });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- worker/ingress/__tests__/rate-limit.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add worker/ingress/rate-limit.ts worker/ingress/__tests__/rate-limit.test.ts
git commit -m "feat(ingress): per-IP rate-limit helper reusing checkRateLimit (F-21)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: F-21 — wire the `/ingress/*` rate-limit hook

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add the import**

In `worker/index.ts`, with the other `./ingress/*` imports (near line 35-39), add:
```ts
import { enforceIngressRateLimit } from './ingress/rate-limit';
```

- [ ] **Step 2: Register the onRequest hook**

In the startup function, register the hook alongside the existing `app.addHook('onSend', …)` (around line 304) — place it right after `await app.register(rawBody, {…})` so it is registered before the routes:
```ts
  // Per-IP DoS/abuse backstop on every /ingress/* route (F-21). onRequest runs
  // before body parsing + signature verification; a 429 short-circuits the
  // lifecycle so the handler never runs. checkRateLimit fails open.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/ingress/')) return;
    await enforceIngressRateLimit(request, reply);
  });
```

- [ ] **Step 3: Typecheck + boot-safety check**

Run: `pnpm typecheck` → PASS.
Run: `pnpm test -- worker` (run the worker test suite to confirm nothing in the worker boot/route tests regressed). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts
git commit -m "feat(ingress): apply per-IP rate limit to all /ingress/* routes (F-21)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification gate + PR

**Files:** none.

- [ ] **Step 1: Lint + typecheck + full test suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS. (`pnpm lint` scans `src` only; also run `npx eslint worker/ingress/stripe.ts worker/ingress/shared.ts worker/ingress/rate-limit.ts worker/ingress/__tests__/rate-limit.test.ts worker/index.ts` → exit 0.)

- [ ] **Step 2: Audits + complexity gate**

Run: `pnpm ci:fallow && pnpm ci:static-policy && pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: all PASS. (No new tenant table queries — the `inbound_events` reclaim is unchanged in shape, only the interval value. If `ci:fallow` flags a function over threshold, extract a helper and note it.)

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Confirm clean tree + branch log**

Run: `git status --short && git --no-pager log --oneline origin/main..HEAD`
Expected: clean; spec/plan doc commits + 4 finding commits (F-14, F-15, F-21 module, F-21 wiring).

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin security/audit-remediation-phase-6
gh pr create --base main \
  --title "Security audit Phase 6: webhook/ingress hardening (F-14/15/21)" \
  --body "Implements Phase 6 (docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-6-design.md).

F-14 [MED]: Stripe handler rejects events whose event.created is older than 7 days (generous anomaly guard beyond Stripe's ~3-day retry window — never drops a legitimate retry; replay within the window is already blocked by constructEvent's 5-min signature tolerance + idempotency). 200 + stale:true so Stripe stops retrying.
F-15 [MED]: inbound_events reclaim window widened 2m->10m (named constant + make_interval) so a slow handler isn't double-processed; providers retry on non-200 regardless.
F-21 [LOW]: per-IP rate limit on all /ingress/* routes, reusing checkRateLimit (no new dep), keyed on the X-Forwarded-For first hop, ~120/min/IP, fail-open, via one path-scoped onRequest hook.

Staging lane (worker ingress): no migration, no env var, no boot guard, no prod-env read. Staging soak + merge are operator-gated."
```
Expected: CI green. Staging deploy + merge remain **operator-gated**.

> **Operator-gated (NOT part of this PR's automation):** after green CI, the owner decides on the staging soak (push `staging`) and the merge to `main` (auto-deploys prod worker + Vercel).

---

## Self-Review

**Spec coverage:** F-14 §2.2 guard (Task 1) + §2.3 tests (Task 1) ✓; F-15 §3.2 constant + make_interval (Task 2), §3.3 "no test update needed, mocked-sql reclaim test stays green" ✓; F-21 §4.1 module (Task 3) + §4.2 wiring (Task 4) + §4.3 tests (Task 3) ✓; §5 verification (Task 5) ✓; §6 operator-gated lane (Task 5 note) ✓.

**Placeholder scan:** code shown in full. Task 1 Step 1's "adapt to the file's existing request/reply builders" is intentional — the exact helper names live in the existing test file and must be matched verbatim rather than guessed; the assertions + event shapes are fully specified.

**Type/name consistency:** `STALE_EVENT_THRESHOLD_SECONDS` (Task 1), `RECLAIM_AFTER_MINUTES` (Task 2), `ingressClientIp`/`enforceIngressRateLimit` (Tasks 3-4) are consistent across definition, tests, and wiring. `enforceIngressRateLimit(request, reply)` signature matches the `onRequest` hook call in Task 4. The `checkRateLimit('ingress:<ip>', 120, 60)` call asserted in Task 3's test matches the module's `INGRESS_MAX_PER_MINUTE=120` / `INGRESS_WINDOW_SECONDS=60`.

**Decision fidelity:** F-14 generous 7-day threshold (never drops retries); F-15 window-widening (not lease); F-21 reuse checkRateLimit + per-IP-via-XFF + fail-open — all match the owner's approved options.
