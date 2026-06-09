# ADR 0002: Next.js routes may run the Vercel BotID server-side check

## Status

Accepted — 2026-06-09

## Context

The "Vercel = UI only" invariant (invariant #1, ADR 0001) requires LLM calls,
third-party API calls, and long-running operations to run on Railway workers,
never in Next.js routes. ADR 0001 already carved out one exception: short,
user-blocking OAuth-handshake calls that must set/clear cookies or return a
redirect synchronously.

Slice 2 of the rate-limiting hardening adds Vercel BotID to six hot,
abuse-prone POST routes (`/api/auth/signup`, `/api/onboarding/start`,
`/api/auth/login-attempt`, `/api/lead-intake`, `/api/demo-request`,
`/api/contact`). BotID's server-side classification, `checkBotId()` from
`botid/server`, makes a short request-blocking call to Vercel's bot-protection
platform API and returns `{ isBot, isHuman, ... }`. The route then accepts the
request or rejects it with a 403 in the same response.

This is technically an outbound call from a Next.js route, so it needs a
deliberate decision against invariant #1.

## Decision

Next.js routes MAY call the Vercel BotID server-side check (`checkBotId()`)
inline. It is treated as a **platform security primitive**, in the same class as
the ADR-0001 OAuth-handshake carve-out — not as a general-purpose external API
call.

Why it must run in the route and cannot move to a worker:

- It is **synchronous to the request decision**: the route must accept or reject
  (403) the very request being handled. There is no durable follow-up work to
  hand to a worker.
- It depends on **per-request context that only exists in the route**: the
  invisible challenge solution the client (`initBotId`) attaches to the request
  headers, plus the Vercel request context (OIDC token, response-header
  mutation) that `checkBotId()` reads. A worker has none of this.
- It is **short and platform-managed** (a single Vercel bot-protection API call
  with Vercel-managed latency), not an LLM or long-running operation.

Scope and guardrails:

- This carve-out covers ONLY the BotID classification call. It does NOT permit
  LLM calls, third-party integrations, batch/long-running work, or
  fire-and-forget side effects in Next.js routes.
- The check is invoked through one server-only helper,
  `botIdBlockResponse(path)` (`src/lib/security/botid.ts`), so the policy lives
  in one place. Per-route detection level (Deep Analysis vs Basic) is derived
  from a single source of truth (`src/lib/security/botid-routes.ts`) shared with
  the client `initBotId` config, so client and server `checkLevel` cannot drift.
- **Failure posture: fail open.** If the BotID platform call itself errors
  (bot-protection API blip, missing OIDC token), the helper logs and allows the
  request through to the route's own rate limits and the Vercel WAF layers,
  rather than 500-ing signup/login/onboarding for every real user during a BotID
  outage. The positive bot signal (`isBot: true`) still rejects. This mirrors
  the app-wide "rate limits fail open" posture (CLAUDE.md "Non-obvious
  gotchas"). A misconfigured (unregistered) path is a programmer error and
  throws loudly instead — it is not swallowed as a fail-open.
- **Cost placement.** Deep Analysis is billed per call ($1 / 1000). The check is
  placed AFTER each route's cheap deterministic guards (feature-flag 404s,
  same-origin/CSRF checks) so disabled or cross-origin requests don't incur a
  billed Deep Analysis call, and BEFORE rate limits / DB work so a detected bot
  is rejected before doing real work.

## Consequences

- The six listed routes run `checkBotId()` inline on Vercel. No worker change.
- App-layer per-route rate limits (Slice 1) and the Vercel WAF per-IP/per-path
  rules (Slice 2 components 1 & 3) remain in place underneath — BotID is an
  additional layer, not a replacement.
- A BotID platform outage degrades to "no bot filtering" (fail open), not "site
  down"; abuse during that window is still capped by the rate-limit + WAF
  layers. This trade-off is deliberate and should be revisited if a future route
  has no volumetric backstop of its own.
