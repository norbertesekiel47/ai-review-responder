# Security-Audit Remediation — Phase 4 Design (Observability Redaction)

**Date:** 2026-06-15
**Source audit:** `docs/security-audit/2026-06-15-refresh-delta.md` (§3 F-7/F-8, §2 "Pattern C")
**Status:** Design approved; ready for implementation plan.

## 1. Context

Phase 4 of the 7-phase security-audit remediation (roadmap in
`…-phase-1-design.md` §1). Phases 1–3 are merged to `main` (PRs #325/#326/#327;
`main` HEAD `5da6a67b`). This phase closes the **observability-redaction**
findings — the residual half of the audit's "Pattern C" (redact PII before it
leaves the process into a third-party observability platform).

| # | Sev | Finding | Surface |
|---|---|---|---|
| F-7 | Medium | Sentry scrubber misses breadcrumbs + URL **values** | `src/lib/shared/sentry-scrub.ts` (3 runtimes) |
| F-8 | Low | Twilio WhatsApp delivery-status persists raw `params` (To/From phone) | `worker/ingress/twilio/twilio-delivery-status.ts` |

Both are defense-in-depth: F-7 requires Sentry-platform access to exploit and
approval tokens are single-use / 48h-TTL / device-bound; F-8's phone number is
already stored in `channel_enrollments`. Neither is an exploitable hole against
an un-compromised session. The goal is to stop sensitive values reaching Sentry
and `inbound_events.payload` in the first place.

**Lane:** staging. The Sentry scrubber runs in the Railway **worker** runtime
(and the Next.js node/edge/client runtimes), and the Twilio delivery-status
handler is a worker ingress endpoint — so Phase 4 rides `staging` first per the
promotion rules. No migration, no env var, no boot guard, no prod-env read.

## 2. F-7 — Sentry breadcrumb + URL-value redaction

### 2.1 Current state

`scrubSentryEvent` (`src/lib/shared/sentry-scrub.ts`) recursively redacts object
**keys** matching `/key|secret|token|password|authorization/i` in `event.extra`,
`event.request.headers`, and (server-only, `scrubRequestData`) `event.request.data`.
It is wired identically via `beforeSend` in all three runtimes:

- `worker/sentry.ts:8` — `scrubSentryEvent(event, { scrubRequestData: true })`
- `src/instrumentation.ts:20,46` — node + edge, `{ scrubRequestData: true }`
- `src/instrumentation-client.ts:14` — browser, no request-data scrub

**Gaps (audit F-7):** it never iterates `event.breadcrumbs`, never scrubs URL
**values** (it matches by key-name, not value), and never touches
`event.request.url` or `event.transaction`. So a captured event still carries
raw `/approve/<token>` in `event.request.url` / the transaction name, and — in
the **browser** SDK on the `/approve/[token]` page — the default
navigation/fetch/console breadcrumbs.

### 2.2 Where the fix lives — one function, all three runtimes

All three runtimes already route through `scrubSentryEvent` via `beforeSend`.
**Extending that single function closes the gap for all three with zero changes
to the init files** — no new `beforeBreadcrumb` hook on four `Sentry.init`
sites. This is the deep-module / single-owner choice (design.md): one place owns
"what we strip before an event leaves the process," and the smallest possible
deploy blast radius (the init files, which gate production error capture, are
untouched).

> A `beforeSend` breadcrumb pass is sufficient for the leak: a breadcrumb only
> reaches Sentry **attached to an event**, and at `beforeSend` time those
> breadcrumbs are already on `event.breadcrumbs`. `beforeBreadcrumb` (capture
> time) would also work but requires editing all four init sites; the audit
> explicitly allows "a breadcrumb pass inside `beforeSend`".

### 2.3 New helper — `redactSensitivePathsAndQueries(url)`

A pure string transform (exported for unit testing) that:

1. **Path:** masks the path segment immediately after `/approve/` —
   `/(\/approve\/)[^/?#\s]+/gi` → `$1[REDACTED]`. Covers the owner approval page
   `/approve/<token>`, the API route `/api/approve/<token>/edit`, and any future
   `/approve/<token>/…`. (`\s` is excluded so the redaction stops at the token
   boundary inside a console-message breadcrumb like `GET /approve/<token> 200`.)
2. **Query:** masks the **value** of any query parameter whose key matches
   `SENSITIVE_QUERY_KEY_RE = /token|secret|key|password|authorization|code|otp|signature|access_token/i`.
   (Generous by decision: Supabase PKCE/OTP flows surface `?code=`/`?token=` in
   URLs; Sentry data is diagnostic-only, so over-redacting a query value never
   breaks the app — it only costs some debugging detail.)

**Implementation constraints:**
- **Never throws.** String-based: split off `#fragment`, then split the first
  `?` into path + query; rebuild. No `new URL()` (which throws on relative URLs
  and would force a leaky fail-open catch).
- **Handles absolute and relative** URLs (browser breadcrumbs store absolute;
  `event.request.url` may be either). Path redaction runs on the path portion of
  both.
- **Idempotent and value-preserving** for non-matching inputs (a plain string
  with no `/approve/` and no sensitive query key returns unchanged).

```ts
const SENSITIVE_QUERY_KEY_RE =
  /token|secret|key|password|authorization|code|otp|signature|access_token/i;

export function redactSensitivePathsAndQueries(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  const hashIdx = url.indexOf('#');
  const fragment = hashIdx === -1 ? '' : url.slice(hashIdx);
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);

  const qIdx = beforeHash.indexOf('?');
  const path = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? '' : beforeHash.slice(qIdx + 1);

  const redactedPath = path.replace(/(\/approve\/)[^/?#\s]+/gi, '$1[REDACTED]');

  let redactedQuery = '';
  if (query) {
    redactedQuery =
      '?' +
      query
        .split('&')
        .map((pair) => {
          const eq = pair.indexOf('=');
          if (eq === -1) return pair;
          const rawKey = pair.slice(0, eq);
          return SENSITIVE_QUERY_KEY_RE.test(decodeURIComponent(rawKey))
            ? `${rawKey}=[REDACTED]`
            : pair;
        })
        .join('&');
  }
  return `${redactedPath}${redactedQuery}${fragment}`;
}
```

### 2.4 Extend `scrubSentryEvent`

After the existing key-scrub passes, add URL-value + breadcrumb scrubbing
(the request passes are factored into a `scrubRequest` helper to keep
`scrubSentryEvent` thin):

- `event.request.url` (string) → `redactSensitivePathsAndQueries(...)`.
- `event.request.query_string` → Sentry carries the query **separately** from
  `url`, in three SDK/runtime-dependent shapes — a raw string, an object map, or
  an array of `[key, value]` pairs. Scrub all three (`redactRequestQueryString`):
  a string via the shared `redactQueryString`, an object/array by masking values
  whose key matches `SENSITIVE_QUERY_KEY_RE`. **Ungated** (URL-equivalent;
  `scrubRequestData` gates only the request *body*, `request.data`), so a
  `?code=`/`?token=` can't leak via `query_string` even after `url` is masked.
- `event.transaction` (string) → `redactSensitivePathsAndQueries(...)`.
- `event.breadcrumbs` (array) → for each breadcrumb:
  - run the existing `scrubObject` over `breadcrumb.data` (catches a sensitive
    **key** like `token` in fetch/xhr breadcrumb data), then
  - redact the URL-bearing string fields via the helper:
    `breadcrumb.data.url`, `.from`, `.to`, and `data["http.url"]` (navigation
    breadcrumbs use `from`/`to`; fetch/xhr use `url`; otel/http instrumentation
    uses `http.url`), plus `data["http.query"]` (a bare query string) via
    `redactQueryString`, and
  - `breadcrumb.message` (console breadcrumbs / generic messages).

Extend `ScrubbableSentryEvent` with `transaction?: unknown`,
`breadcrumbs?: unknown`, `request.url?: unknown`, and
`request.query_string?: unknown`. All field reads stay defensive
(`typeof === 'string'` / `Array.isArray` / `typeof === 'object'` guards) — Sentry
event shapes vary by SDK and runtime.

### 2.5 Tests (extend `src/lib/shared/__tests__/sentry-scrub.test.ts`)

New `redactSensitivePathsAndQueries` describe block:
- masks the segment after `/approve/`: `/approve/abc.def.ghi` → `/approve/[REDACTED]`.
- masks `/api/approve/<token>/edit` token segment, keeps the trailing `/edit`.
- masks sensitive query values (`?code=xyz&token=t` → both `[REDACTED]`),
  keeps non-sensitive (`?page=2`).
- leaves a plain path unchanged; preserves `#fragment`; handles a relative URL.

New `scrubSentryEvent` cases:
- `event.request.url` carrying `/approve/<token>` is masked.
- `event.transaction` carrying `/approve/<token>` is masked.
- a **navigation** breadcrumb (`{ category:'navigation', data:{ from:'/approve/T', to:'/dashboard' } }`) has `from` masked.
- a **fetch** breadcrumb (`data:{ url:'/api/approve/T/edit' }`) has `url` masked.
- a **console** breadcrumb (`message:'GET /approve/T 200'`) has `message` masked.
- the **audit's required assertion**: a breadcrumb carrying `/approve/<token>` is masked.
- `event.request.query_string` is masked in all three shapes (string, object,
  array-of-pairs) and even without `scrubRequestData`.
- a breadcrumb's `data["http.url"]` + `data["http.query"]` are masked.
- existing key-scrub behavior (extra/headers/data/arrays/null-safety) still passes.

## 3. F-8 — Twilio delivery-status payload redaction

### 3.1 Current state

`handleTwilioDeliveryStatus` (`worker/ingress/twilio/twilio-delivery-status.ts:58`)
passes the **raw** parsed `params` into `claimInboundEvent(...)`, which persists
them to `inbound_events.payload`. Twilio status callbacks include `To`/`From`
(`whatsapp:+<number>`), so the owner's phone lands raw in the audit table.

By contrast the **inbound** handler applies `redactWhatsAppPayload` first
(`twilio-whatsapp-inbound.ts:85`) and Telegram applies `redactForAudit`. This is
the status-vs-inbound asymmetry the audit flags (mirrors the prior R3 L-3).

### 3.2 Decision — dedicated redactor, inbound untouched

`redactWhatsAppPayload` (`whatsapp-shared.ts:17`) **intentionally keeps `From`**
— it redacts `Body`/`ButtonPayload`, drops `ProfileName`/`WaId`, but preserves
`From` as a "forensic field," asserted by
`twilio-whatsapp.test.ts:218` (`expect(out.From).toBe('whatsapp:+155…')`). The
audit rates the inbound path "solid." Consolidating the redactor to drop To/From
everywhere would contradict that tested, accepted design and re-open an
audit-accepted item — out of scope for Phase 4.

The status path differs: To/From add nothing for audit/replay there (the
delivery row is found by `external_message_id = MessageSid`, not by phone). So a
**dedicated `redactDeliveryStatusPayload`** drops them for the status path only.

```ts
// whatsapp-shared.ts — colocated with redactWhatsAppPayload
export function redactDeliveryStatusPayload(
  params: Record<string, string>,
): Record<string, string> {
  const out = redactWhatsAppPayload(params); // base PII redaction (Body, WaId, …)
  delete out.To;   // whatsapp:+<business number>
  delete out.From; // whatsapp:+<owner number>
  return out;
}
```

Composing on `redactWhatsAppPayload` keeps a single owner of "base WhatsApp-param
PII" and makes the status-specific delta (drop phone numbers) explicit — no
near-duplicate redactor (engineering.md).

### 3.3 Wire via the existing options seam

`twilio-delivery-status.ts` is the **channel-agnostic** shared module; the
redactor is WhatsApp-specific. To keep the shared module free of WhatsApp
imports (matching how `fullUrl` is already injected via `DeliveryStatusOptions`):

- Add `redactPayload?: (params: Record<string, string>) => Record<string, string>`
  to `DeliveryStatusOptions`.
- In `handleTwilioDeliveryStatus`, apply it before `claimInboundEvent`:
  `const auditPayload = options.redactPayload ? options.redactPayload(params) : params;`
  then `claimInboundEvent('twilio', dedupKey, \`status:${MessageStatus}\`, auditPayload)`.
  (Default-to-identity keeps the seam optional and the change minimal; the live
  state machine keeps reading the raw `params` for `MessageSid`/`MessageStatus`/
  `ErrorCode` — only the **persisted audit copy** is redacted.)
- In `twilio-whatsapp-status.ts`, pass `redactPayload: redactDeliveryStatusPayload`
  (import from `./whatsapp-shared`).

### 3.4 Tests (extend `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`)

- `redactDeliveryStatusPayload` unit test: To/From dropped; non-PII fields
  (`MessageSid`, `MessageStatus`, `ErrorCode`) preserved; `Body` redacted if present.
- status handler test: assert the 4th arg to `claimInboundEvent` has **no**
  `To`/`From` (tighten the existing `expect.any(Object)` assertion at
  `twilio-whatsapp.test.ts:195` for the relevant case, or add a focused case
  with To/From in the request body).
- existing inbound `redactWhatsAppPayload` test (From preserved) stays green —
  proof inbound is untouched.

## 4. Verification plan

Run before claiming done (repworth "Always do"):
- `pnpm lint && pnpm typecheck && pnpm test`
- `pnpm ci:static-policy` (no `NEXT_PUBLIC_*` / crypto-js / client-table changes —
  should pass unchanged). `ci:tenant-scope` / `ci:rls-audit` are unaffected (no
  new DB queries) but cheap to run for the worker-touching change.
- `pnpm build`
- New unit tests pass; existing sentry-scrub + twilio tests stay green.

## 5. Lane & rollout

Staging lane (worker-touching), single PR to `main` via the 4-check CI gate.

**Operator-gated (NOT autonomous — owner approves):**
- Pushing `staging` (auto-deploys the shared staging stack) for the staging soak.
- Merging the PR to `main` (auto-deploys the prod worker + Vercel).

No migration, no env var, no boot guard, no prod-env read — so the
"new-guard-breaks-prod-on-deploy" risk class from Phases 2–3 does **not** apply
here. Each fix (F-7, F-8) is independently revertable within the PR.

## 6. Out of scope (this phase)

F-9–F-26 (Phases 5–8 per roadmap §1) and the deferred F-3 + transitive CVEs
(2026-06-18 dependency follow-up). Inbound/Telegram redaction is **not** changed
(F-8 is delivery-status only, by decision §3.2). No new `beforeBreadcrumb` hook
and no init-file changes (F-7 is contained in `scrubSentryEvent`, §2.2).
