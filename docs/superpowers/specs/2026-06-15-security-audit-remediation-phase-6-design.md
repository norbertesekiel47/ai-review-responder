# Security-Audit Remediation — Phase 6 Design (Webhook/Ingress Hardening)

**Date:** 2026-06-15 (authored 2026-06-16)
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md` (§7 F-14, F-15, F-21)
**Status:** Design approved; ready for implementation plan.

## 1. Context

Phase 6 of the 7-phase security-audit remediation (roadmap in
`…-phase-1-design.md` §1). Phases 1–5 are merged to `main` (PRs
#325/#326/#327/#328/#329; `main` HEAD `b58ede7c`). This phase hardens the
worker webhook/ingress surface.

| # | Sev | Finding | Surface |
|---|---|---|---|
| F-14 | Medium | Stripe handler doesn't reject stale events via `event.created` | `worker/ingress/stripe.ts` |
| F-15 | Medium | `inbound_events` 2-min reclaim can double-process a slow handler | `worker/ingress/shared.ts` |
| F-21 | Low | No rate limit on `/ingress/*` | `worker/ingress/rate-limit.ts` (new) + `worker/index.ts` |

All three are defense-in-depth: signature verification already gates forgery on
every ingress route, and app-layer idempotency already mitigates F-15's harm.

**Lane:** staging — all three touch the Railway worker's ingress path. No
migration, no env var, no boot guard, no prod-env read.

## 2. F-14 — Stripe `event.created` staleness guard

### 2.1 Current state + the constraint

`handleStripeWebhook` (`worker/ingress/stripe.ts`) verifies the signature with
`getStripe().webhooks.constructEvent(...)`, then claims + dispatches. It never
inspects `event.created`.

**Two facts shape the fix:**
1. `constructEvent` **already enforces a default 5-minute tolerance** on the
   `Stripe-Signature` `t=` timestamp — a replayed/old *request* is already
   rejected at signature verification. So the residual replay surface is small.
2. Stripe **legitimately retries** a failed webhook for **up to ~3 days**, each
   retry carrying a *fresh* signature (passes tolerance) but the *original*
   `event.created`. A staleness threshold smaller than the retry window would
   therefore **drop legitimate retries** — a real availability bug.

**Decision (owner-approved):** add a *generous anomaly guard* — reject only
events whose `event.created` is older than a threshold comfortably beyond
Stripe's retry window. This never drops a legitimate retry; it catches only
absurdly-old events (a captured-event replay that somehow passed signature
tolerance, or a Stripe/config anomaly).

### 2.2 Fix

In `worker/ingress/stripe.ts`, after `constructEvent` succeeds and **before**
`claimInboundEvent`, add:

```ts
// Stripe retries a failed webhook for up to ~3 days (fresh signature each time,
// but the original event.created). Reject only events far beyond that window —
// a generous anomaly guard that never drops a legitimate retry. Replay within
// the window is already blocked by constructEvent's 5-min signature tolerance +
// idempotency (claimInboundEvent). Respond 200 so Stripe stops retrying a
// permanently-stale event; do not create an inbound_events row for it.
const STALE_EVENT_THRESHOLD_SECONDS = 7 * 24 * 60 * 60; // 7 days
const eventAgeSeconds = Math.floor(Date.now() / 1000) - event.created;
if (eventAgeSeconds > STALE_EVENT_THRESHOLD_SECONDS) {
  console.warn(
    `${LOG_PREFIX} Rejecting stale event ${event.id} (${event.type}) — age ${eventAgeSeconds}s exceeds ${STALE_EVENT_THRESHOLD_SECONDS}s`,
  );
  reply.status(200).send({ received: true, stale: true });
  return;
}
```

`event.created` is a Unix timestamp in **seconds** (Stripe convention), compared
against `Date.now()/1000`. 200 (not 4xx) because a stale event is permanently
stale — a non-200 would make Stripe retry it for 3 days to no purpose.

### 2.3 Tests (`worker/ingress/__tests__/stripe.test.ts`)

- a fresh event (`event.created = now`) is dispatched + claimed as today.
- an event with `event.created` ~8 days old → handler responds 200 with
  `stale: true`, and **neither** `claimInboundEvent` **nor** any
  `process*` dispatcher is called.
- an event ~2 days old (within the retry window) → processed normally (proves
  the guard doesn't drop legitimate retries).

(Mock `getStripe().webhooks.constructEvent` to return a crafted `event` with the
chosen `created`; mock `claimInboundEvent` + the dispatchers, mirroring the
existing stripe test setup. Read the existing test file for the mock harness.)

## 3. F-15 — widen the inbound-event reclaim window

### 3.1 Current state

`claimInboundEvent` (`worker/ingress/shared.ts:35-41`) reclaims a row stuck in
`status='received'` for `> INTERVAL '2 minutes'` (or `status='failed'`). If a
handler legitimately runs longer than 2 minutes, a concurrent provider retry can
reclaim the row and double-process. App-layer idempotency mitigates the *harm*;
this widens the window to shrink the *opportunity*.

### 3.2 Fix

Extract the interval into a named constant and widen it 2 → 10 minutes:

```ts
// A 'received' row is reclaimable after this long — covers worker crashes +
// transient retry windows. Widened from 2min (F-15): if an ingress handler runs
// longer than the window, a concurrent provider retry could reclaim the row and
// double-process. Providers retry on non-200 regardless, so the slower
// crash-recovery is harmless; idempotency backstops any residual double-process.
const RECLAIM_AFTER_MINUTES = 10;
```

In the reclaim `UPDATE`, replace `received_at < NOW() - INTERVAL '2 minutes'`
with a parameterized interval:

```ts
      AND (status = 'failed' OR (status = 'received'
            AND received_at < NOW() - make_interval(mins => ${RECLAIM_AFTER_MINUTES})))
```

`make_interval(mins => $n)` binds the constant as a value (Postgres.js
parameter) — no string-interpolated SQL.

### 3.3 Tests

If an existing integration/unit test asserts the 2-minute reclaim timing (search
`worker/ingress/__tests__` + any `shared` test for `2 minutes` / reclaim
fixtures), update it to the new window. The reclaim path is DB-backed; CI's test
DB exercises it. If no timing test exists, no new test is required for the
constant change beyond confirming the existing claim/dedup tests stay green
(the `make_interval` form must parse — CI integration run validates it).

## 4. F-21 — `/ingress/*` rate limiter

### 4.1 Design

Reuse the existing `checkRateLimit` (`src/lib/shared/rate-limit.ts`) — a
fixed-window Redis (Upstash cache) limiter with a fail-open default. **No new
dependency** (repworth bias). The worker already uses the Upstash cache instance
(cost-reserve/idempotency), so `getCacheRedis()` resolves there; if
`REDIS_CACHE_URL` is unset, `checkRateLimit` fails open (allows) — a Redis blip
must never drop a legitimate webhook.

New module `worker/ingress/rate-limit.ts` (module owns the decision; `index.ts`
only wires it — invariant #12):

```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from '@/lib/shared/rate-limit';

// Generous per-IP DoS/abuse backstop. Providers (Stripe/Twilio/Telegram/Zernio)
// burst many webhooks from the same source IP, so the ceiling is high — this
// bounds flood/work-amplification, NOT per-tenant traffic (signature verify
// already gates forgery). Fail-open via checkRateLimit's default.
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

### 4.2 Wiring (`worker/index.ts`)

A single `onRequest` hook scoped by path prefix — DRY across all six
`/ingress/*` routes, and it rejects before body parsing / signature work:

```ts
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/ingress/')) return;
  await enforceIngressRateLimit(request, reply);
});
```

`onRequest` sending a 429 short-circuits the lifecycle (the route handler never
runs). `/api/health` + `/ready` are unaffected (not under `/ingress/`).

### 4.3 Tests (`worker/ingress/__tests__/rate-limit.test.ts`)

- `ingressClientIp`: XFF `"1.2.3.4, 10.0.0.1"` → `"1.2.3.4"`; XFF absent →
  `request.ip`; both absent → `"unknown"`.
- `enforceIngressRateLimit`: mock `checkRateLimit` → `{allowed:false}` ⇒
  `reply.status(429)` called; `{allowed:true}` ⇒ no status/send call. Assert the
  limiter key is `ingress:<ip>` and the limit/window args are passed.

## 5. Verification plan

- `pnpm lint && pnpm typecheck && pnpm test` (+ eslint the changed `worker/`
  files); `pnpm ci:fallow`; `pnpm ci:static-policy && pnpm ci:tenant-scope &&
  pnpm ci:rls-audit` (no new tenant queries — `inbound_events` reclaim is
  unchanged in scope, only the interval value; should pass); `pnpm build`.
- New + updated tests pass; existing stripe/shared/ingress tests stay green.

## 6. Lane & rollout

Staging lane, single PR to `main` via the 4-check CI gate.

**Operator-gated (NOT autonomous — owner approves):** staging soak (push
`staging`) and merge to `main` (auto-deploys prod worker + Vercel). No migration,
no env var, no boot guard, no prod-env read.

## 7. Out of scope (this phase)

Phase 7 (F-12/23 headers, then F-11 CSP nonce) and Phase 8 (F-5/18/19/20
fold-ins), plus the deferred F-3 + transitive CVEs (2026-06-18 follow-up). F-15
uses window-widening, not a lease/heartbeat (owner decision — YAGNI for a
defense-in-depth item). F-14 adds a runtime guard (not doc-only), at a generous
threshold that cannot drop legitimate retries.
