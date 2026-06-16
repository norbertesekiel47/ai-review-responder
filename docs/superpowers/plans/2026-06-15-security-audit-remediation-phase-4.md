# Security-Audit Remediation — Phase 4 Implementation Plan (Observability Redaction)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land F-7 (Sentry breadcrumb + URL-value redaction) and F-8 (Twilio WhatsApp delivery-status payload redaction) as one PR; staging soak + merge are operator-gated after green CI.

**Architecture:** F-7 is contained entirely in `scrubSentryEvent` (extended) — all three Sentry runtimes already route through it via `beforeSend`, so no init-file changes. F-8 adds a dedicated `redactDeliveryStatusPayload` (composing the canonical `redactWhatsAppPayload`) and injects it into the channel-agnostic delivery-status handler via the existing `DeliveryStatusOptions` seam. Both are pure-function-first and unit-tested; the inbound path is intentionally untouched.

**Tech Stack:** TypeScript (strict), Vitest, Fastify worker, `@sentry/{node,nextjs}`, Postgres.js (`inbound_events`).

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-4-design.md`
**Branch:** `security/audit-remediation-phase-4` (already created off `main` @ `5da6a67b`).

---

## File Structure

**Modified:**
- `src/lib/shared/sentry-scrub.ts` — add `redactSensitivePathsAndQueries` + `scrubBreadcrumb`; extend `scrubSentryEvent` to redact `request.url`, `transaction`, `breadcrumbs`; extend `ScrubbableSentryEvent` type. (F-7)
- `src/lib/shared/__tests__/sentry-scrub.test.ts` — helper tests + breadcrumb/url/transaction event tests. (F-7)
- `worker/ingress/twilio/whatsapp-shared.ts` — add `redactDeliveryStatusPayload`. (F-8)
- `worker/ingress/twilio/twilio-whatsapp.ts` — re-export `redactDeliveryStatusPayload` from the barrel. (F-8)
- `worker/ingress/twilio/twilio-delivery-status.ts` — add optional `redactPayload` to `DeliveryStatusOptions`; apply it to the persisted audit copy before `claimInboundEvent`. (F-8)
- `worker/ingress/twilio/twilio-whatsapp-status.ts` — pass `redactPayload: redactDeliveryStatusPayload`. (F-8)
- `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts` — `redactDeliveryStatusPayload` unit test + status-handler To/From-dropped test. (F-8)

**Created:** none (extends existing files — repworth bias: no new file).

---

## Task 1: F-7 — `redactSensitivePathsAndQueries` helper

TDD: write the pure-function tests (red), then add the helper (green). The helper masks the path segment after `/approve/` and the values of sensitive query params, never throws, and handles absolute + relative URLs.

**Files:**
- Test: `src/lib/shared/__tests__/sentry-scrub.test.ts`
- Modify: `src/lib/shared/sentry-scrub.ts`

- [ ] **Step 1: Write the failing helper tests**

In `src/lib/shared/__tests__/sentry-scrub.test.ts`, update the import line to also pull in the new helper:
```ts
import { scrubSentryEvent, redactSensitivePathsAndQueries } from '../sentry-scrub';
```
Then add this describe block (after the existing `describe('scrubSentryEvent', …)` block, at top level):
```ts
describe('redactSensitivePathsAndQueries', () => {
  it('masks the path segment after /approve/', () => {
    expect(redactSensitivePathsAndQueries('/approve/abc.def.ghi')).toBe('/approve/[REDACTED]');
  });

  it('masks the token in /api/approve/<token>/edit and keeps the trailing segment', () => {
    expect(redactSensitivePathsAndQueries('/api/approve/abc123/edit')).toBe(
      '/api/approve/[REDACTED]/edit',
    );
  });

  it('masks the token in an absolute URL and preserves the origin', () => {
    expect(redactSensitivePathsAndQueries('https://app.example.com/approve/secrettoken')).toBe(
      'https://app.example.com/approve/[REDACTED]',
    );
  });

  it('masks sensitive query param VALUES, keeps non-sensitive ones', () => {
    expect(redactSensitivePathsAndQueries('/cb?code=xyz&token=t&page=2')).toBe(
      '/cb?code=[REDACTED]&token=[REDACTED]&page=2',
    );
  });

  it('leaves a plain path unchanged', () => {
    expect(redactSensitivePathsAndQueries('/dashboard/reviews')).toBe('/dashboard/reviews');
  });

  it('preserves a #fragment', () => {
    expect(redactSensitivePathsAndQueries('/approve/tok#section')).toBe('/approve/[REDACTED]#section');
  });

  it('stops redaction at whitespace (console-message form)', () => {
    expect(redactSensitivePathsAndQueries('GET /approve/tok 200')).toBe('GET /approve/[REDACTED] 200');
  });

  it('returns non-string / empty input unchanged', () => {
    expect(redactSensitivePathsAndQueries('')).toBe('');
    expect(redactSensitivePathsAndQueries(undefined as unknown as string)).toBe(undefined);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/lib/shared/__tests__/sentry-scrub.test.ts`
Expected: FAIL — `redactSensitivePathsAndQueries` is not exported.

- [ ] **Step 3: Add the helper**

In `src/lib/shared/sentry-scrub.ts`, add at the top (after the existing `SENSITIVE_KEY_RE` constant):
```ts
const SENSITIVE_QUERY_KEY_RE =
  /token|secret|key|password|authorization|code|otp|signature|access_token/i;

/**
 * Mask sensitive values inside a URL string before it reaches Sentry. The
 * key-based object scrubber can't reach these because they are VALUES, not keys:
 *   - the path segment after `/approve/` (single-use approval tokens), and
 *   - query-param values whose key looks sensitive (token/code/otp/…).
 *
 * Pure + total: never throws (no `new URL()`, which rejects relative inputs),
 * handles absolute and relative URLs, and returns non-matching input unchanged.
 */
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
          let decodedKey = rawKey;
          try {
            decodedKey = decodeURIComponent(rawKey);
          } catch {
            // malformed percent-encoding — match against the raw key instead
          }
          return SENSITIVE_QUERY_KEY_RE.test(decodedKey)
            ? `${rawKey}=[REDACTED]`
            : pair;
        })
        .join('&');
  }

  return `${redactedPath}${redactedQuery}${fragment}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/lib/shared/__tests__/sentry-scrub.test.ts`
Expected: PASS (all `redactSensitivePathsAndQueries` cases + the unchanged `scrubSentryEvent` cases).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add src/lib/shared/sentry-scrub.ts src/lib/shared/__tests__/sentry-scrub.test.ts
git commit -m "feat(observability): redactSensitivePathsAndQueries URL helper (F-7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: F-7 — wire URL/transaction/breadcrumb redaction into `scrubSentryEvent`

TDD: add event-level tests that a `/approve/<token>` in `request.url`, `transaction`, and breadcrumbs (navigation `from`/`to`, fetch `data.url`, console `message`) is masked (red), then extend `scrubSentryEvent` + its type (green). No init-file changes — all three runtimes already call `scrubSentryEvent`.

**Files:**
- Test: `src/lib/shared/__tests__/sentry-scrub.test.ts`
- Modify: `src/lib/shared/sentry-scrub.ts`

- [ ] **Step 1: Write the failing event tests**

In `src/lib/shared/__tests__/sentry-scrub.test.ts`, add inside the existing `describe('scrubSentryEvent', …)` block:
```ts
  it('masks an approval token in event.request.url', () => {
    const event = { request: { url: 'https://app.example.com/approve/SECRETTOKEN?foo=bar' } };
    scrubSentryEvent(event, { scrubRequestData: true });
    expect(event.request.url).toBe('https://app.example.com/approve/[REDACTED]?foo=bar');
  });

  it('masks an approval token in event.transaction', () => {
    const event = { transaction: 'GET /approve/SECRETTOKEN' };
    scrubSentryEvent(event);
    expect(event.transaction).toBe('GET /approve/[REDACTED]');
  });

  it('masks a navigation breadcrumb (data.from / data.to)', () => {
    const event = {
      breadcrumbs: [
        { category: 'navigation', data: { from: '/approve/TOKENA', to: '/dashboard' } },
      ],
    };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.from).toBe('/approve/[REDACTED]');
    expect(event.breadcrumbs[0]!.data.to).toBe('/dashboard');
  });

  it('masks an approval token in a fetch breadcrumb (data.url)', () => {
    const event = {
      breadcrumbs: [{ category: 'fetch', data: { url: '/api/approve/TOKENB/edit', method: 'POST' } }],
    };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.url).toBe('/api/approve/[REDACTED]/edit');
    expect(event.breadcrumbs[0]!.data.method).toBe('POST');
  });

  it('masks an approval token in a console breadcrumb message', () => {
    const event = { breadcrumbs: [{ category: 'console', message: 'GET /approve/TOKENC 200' }] };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.message).toBe('GET /approve/[REDACTED] 200');
  });

  it('redacts a sensitive KEY inside breadcrumb data (not just URLs)', () => {
    const event = { breadcrumbs: [{ category: 'fetch', data: { authorization: 'Bearer x' } }] };
    scrubSentryEvent(event);
    expect(event.breadcrumbs[0]!.data.authorization).toBe('[REDACTED]');
  });

  it('does not crash on null / non-object breadcrumbs', () => {
    const event = { breadcrumbs: [null, { category: 'navigation' }] };
    expect(() => scrubSentryEvent(event)).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/lib/shared/__tests__/sentry-scrub.test.ts`
Expected: FAIL — `scrubSentryEvent` does not yet touch `request.url`, `transaction`, or `breadcrumbs`.

- [ ] **Step 3: Extend the event type**

In `src/lib/shared/sentry-scrub.ts`, replace the `ScrubbableSentryEvent` type:
```ts
type ScrubbableSentryEvent = {
  extra?: unknown;
  transaction?: unknown;
  breadcrumbs?: unknown;
  request?: {
    url?: unknown;
    headers?: unknown;
    data?: unknown;
  };
};
```

- [ ] **Step 4: Add the breadcrumb scrubber**

In `src/lib/shared/sentry-scrub.ts`, add after the `scrubObject` function (and after the `redactSensitivePathsAndQueries` helper from Task 1):
```ts
// Navigation breadcrumbs carry URLs in data.from / data.to; fetch/xhr in data.url.
const BREADCRUMB_URL_FIELDS = ['url', 'from', 'to'] as const;

function scrubBreadcrumb(breadcrumb: Record<string, unknown>): void {
  const data = breadcrumb.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const dataObj = data as Record<string, unknown>;
    scrubObject(dataObj); // key-based redaction (e.g. an `authorization` field)
    for (const field of BREADCRUMB_URL_FIELDS) {
      const value = dataObj[field];
      if (typeof value === 'string') {
        dataObj[field] = redactSensitivePathsAndQueries(value);
      }
    }
  }
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = redactSensitivePathsAndQueries(breadcrumb.message);
  }
}
```

- [ ] **Step 5: Extend `scrubSentryEvent`**

In `src/lib/shared/sentry-scrub.ts`, replace the body of `scrubSentryEvent` — keep the three existing passes, add the URL/transaction/breadcrumb passes before `return event;`:
```ts
export function scrubSentryEvent<T extends ScrubbableSentryEvent>(
  event: T,
  options: ScrubSentryEventOptions = {},
): T {
  if (event.extra) {
    scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.request?.headers) {
    scrubObject(event.request.headers as Record<string, unknown>);
  }
  if (
    options.scrubRequestData &&
    event.request?.data &&
    typeof event.request.data === 'object'
  ) {
    scrubObject(event.request.data as Record<string, unknown>);
  }

  // F-7: redact sensitive VALUES the key-scrub can't reach. Sentry omits these
  // on many events, so every read is defensive.
  if (event.request && typeof event.request.url === 'string') {
    event.request.url = redactSensitivePathsAndQueries(event.request.url);
  }
  if (typeof event.transaction === 'string') {
    event.transaction = redactSensitivePathsAndQueries(event.transaction);
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb && typeof crumb === 'object') {
        scrubBreadcrumb(crumb as Record<string, unknown>);
      }
    }
  }

  return event;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test -- src/lib/shared/__tests__/sentry-scrub.test.ts`
Expected: PASS (all new event cases + Task 1 helper cases + the original key-scrub cases).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` → PASS. (Confirms the three `beforeSend(event) => scrubSentryEvent(event, …)` call sites in `worker/sentry.ts`, `src/instrumentation.ts`, `src/instrumentation-client.ts` still type-check against the widened `ScrubbableSentryEvent`.)
```bash
git add src/lib/shared/sentry-scrub.ts src/lib/shared/__tests__/sentry-scrub.test.ts
git commit -m "fix(observability): scrub URL values + breadcrumbs in scrubSentryEvent (F-7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: F-8 — `redactDeliveryStatusPayload`

TDD: unit-test the new redactor (drops To/From on top of the base WhatsApp redaction) — red, then add it + the barrel re-export — green. Inbound's `redactWhatsAppPayload` is untouched (its existing "keeps From" test stays green).

**Files:**
- Test: `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
- Modify: `worker/ingress/twilio/whatsapp-shared.ts`, `worker/ingress/twilio/twilio-whatsapp.ts`

- [ ] **Step 1: Write the failing redactor test**

In `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`, update the barrel import (currently line ~105) to add the new symbol:
```ts
import {
  handleTwilioWhatsAppStatus,
  handleTwilioWhatsAppInbound,
  redactWhatsAppPayload,
  redactDeliveryStatusPayload,
} from '../twilio-whatsapp';
```
Then add a new describe block (after the existing `describe('redactWhatsAppPayload', …)`):
```ts
describe('redactDeliveryStatusPayload', () => {
  it('drops To/From phone numbers and keeps delivery-status fields', () => {
    const input = {
      MessageSid: 'SM1',
      MessageStatus: 'delivered',
      ErrorCode: '',
      To: 'whatsapp:+15550000000',
      From: 'whatsapp:+15551234567',
    };
    const out = redactDeliveryStatusPayload(input);
    expect(out.To).toBeUndefined();
    expect(out.From).toBeUndefined();
    expect(out.MessageSid).toBe('SM1');
    expect(out.MessageStatus).toBe('delivered');
    expect(out.ErrorCode).toBe('');
  });

  it('still applies the base redaction (Body) if present', () => {
    const out = redactDeliveryStatusPayload({ MessageSid: 'SM1', Body: 'leak', From: 'whatsapp:+1' });
    expect(out.Body).toBe('[redacted]');
    expect(out.From).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
Expected: FAIL — `redactDeliveryStatusPayload` is not exported.

- [ ] **Step 3: Add the redactor**

In `worker/ingress/twilio/whatsapp-shared.ts`, add directly after `redactWhatsAppPayload`:
```ts
// Delivery-status callbacks carry To/From phone numbers but no message body or
// button payload. On top of the base WhatsApp-param redaction, drop the phone
// numbers — the delivery row is keyed by MessageSid (not phone), so they add
// nothing to the audit copy. Inbound deliberately KEEPS From as a forensic
// field (see redactWhatsAppPayload); this is the status-only delta.
export function redactDeliveryStatusPayload(
  params: Record<string, string>,
): Record<string, string> {
  const out = redactWhatsAppPayload(params);
  delete out.To;
  delete out.From;
  return out;
}
```

- [ ] **Step 4: Re-export from the barrel**

In `worker/ingress/twilio/twilio-whatsapp.ts`, replace the `redactWhatsAppPayload` export line:
```ts
export { redactWhatsAppPayload, redactDeliveryStatusPayload } from './whatsapp-shared';
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
Expected: PASS (new redactor cases + the unchanged `redactWhatsAppPayload` "keeps From" test).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add worker/ingress/twilio/whatsapp-shared.ts worker/ingress/twilio/twilio-whatsapp.ts worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts
git commit -m "feat(ingress): redactDeliveryStatusPayload drops To/From (F-8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: F-8 — apply the redactor in the delivery-status handler

TDD: add a status-handler test asserting the persisted (claimed) payload has To/From dropped (red), then wire `redactPayload` through the options seam (green).

**Files:**
- Test: `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
- Modify: `worker/ingress/twilio/twilio-delivery-status.ts`, `worker/ingress/twilio/twilio-whatsapp-status.ts`

- [ ] **Step 1: Write the failing handler test**

In `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`, add inside `describe('handleTwilioWhatsAppStatus', …)` (after the existing dedup-key test ~line 198):
```ts
  it('persists the inbound_event payload with To/From dropped', async () => {
    // Non-terminal status short-circuits after markProcessed (one sql call).
    const req = buildStatusRequest({
      MessageSid: 'SM1',
      MessageStatus: 'queued',
      To: 'whatsapp:+15550000000',
      From: 'whatsapp:+15551234567',
    });
    const reply = buildReply();
    await handleTwilioWhatsAppStatus(req, reply);

    expect(mockClaimInboundEvent).toHaveBeenCalledTimes(1);
    const payloadArg = mockClaimInboundEvent.mock.calls[0]![3] as Record<string, string>;
    expect(payloadArg.To).toBeUndefined();
    expect(payloadArg.From).toBeUndefined();
    expect(payloadArg.MessageSid).toBe('SM1');
    expect(payloadArg.MessageStatus).toBe('queued');
  });
```
(`buildStatusRequest` and `mockClaimInboundEvent` already exist in this file — see the existing status describe block and the mock setup near the top.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
Expected: FAIL — the handler still passes raw `params`, so `payloadArg.From` is the phone number, not `undefined`.

- [ ] **Step 3: Add the `redactPayload` option + apply it**

In `worker/ingress/twilio/twilio-delivery-status.ts`, add the field to `DeliveryStatusOptions` (after `logUnknownNonTerminal?`):
```ts
  /**
   * Optional redactor applied to the parsed params before they are persisted to
   * inbound_events.payload. The live state machine keeps reading the raw params
   * (MessageSid/MessageStatus/ErrorCode); only the audit copy is redacted.
   * Defaults to identity (no redaction) when omitted.
   */
  redactPayload?: (params: Record<string, string>) => Record<string, string>;
```
Then replace the `dedupKey` / `claimInboundEvent` lines (currently lines ~57-58):
```ts
  const dedupKey = `${MessageSid}:${MessageStatus}`;
  const auditPayload = options.redactPayload ? options.redactPayload(params) : params;
  const claim = await claimInboundEvent('twilio', dedupKey, `status:${MessageStatus}`, auditPayload);
```

- [ ] **Step 4: Pass the redactor from the WhatsApp adapter**

In `worker/ingress/twilio/twilio-whatsapp-status.ts`, update the import and the options object:
```ts
import { fullUrl, redactDeliveryStatusPayload } from './whatsapp-shared';
```
```ts
  return handleTwilioDeliveryStatus(request, reply, {
    channel: 'whatsapp',
    fullUrl,
    invalidSignatureMessage: 'invalid signature on status callback',
    logPrefix: LOG_PREFIX,
    redactPayload: redactDeliveryStatusPayload,
  });
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
Expected: PASS (new handler test + all existing status/inbound tests, incl. the dedup-key test whose `expect.any(Object)` still holds).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck` → PASS.
```bash
git add worker/ingress/twilio/twilio-delivery-status.ts worker/ingress/twilio/twilio-whatsapp-status.ts worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts
git commit -m "fix(ingress): redact To/From from WhatsApp delivery-status audit payload (F-8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification gate + PR

**Files:** none.

- [ ] **Step 1: Lint + typecheck + full test suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all PASS.

- [ ] **Step 2: Static-policy + scope audits**

Run: `pnpm ci:static-policy && pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: all PASS. (No `NEXT_PUBLIC_*` / crypto-js / client-table / new-DB-query changes — these should pass unchanged; run them because the change touches the worker.)

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Confirm clean tree + branch log**

Run: `git status --short && git --no-pager log --oneline origin/main..HEAD`
Expected: clean; the spec/plan doc commits + 4 finding commits (F-7 helper, F-7 wire, F-8 redactor, F-8 apply).

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin security/audit-remediation-phase-4
gh pr create --base main \
  --title "Security audit Phase 4: observability redaction (F-7/F-8)" \
  --body "Implements Phase 4 (docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-4-design.md).

F-7 [MED]: scrubSentryEvent now redacts URL VALUES (/approve/<token> path + sensitive query params), event.transaction, and breadcrumbs (navigation/fetch/console) across all three Sentry runtimes — contained in the one function all runtimes already wire via beforeSend (no init-file changes).
F-8 [LOW]: WhatsApp delivery-status callback now redacts To/From phone numbers from the inbound_events audit payload via a dedicated redactDeliveryStatusPayload (inbound path unchanged — it intentionally keeps From as a forensic field).

Staging lane (worker-touching): no migration, no env var, no boot guard, no prod-env read. Staging soak + merge are operator-gated."
```
Expected: CI green (lint, typecheck, test, build). Staging deploy (push `staging`) + merge to `main` remain **operator-gated**.

> **Operator-gated (NOT part of this PR's automation):** after green CI, the owner decides on the staging soak (push to `staging` auto-deploys the shared staging stack) and the merge to `main` (auto-deploys the prod worker + Vercel). No prod-env read or migration is involved.

---

## Self-Review

**Spec coverage:** F-7 §2.3 helper (Task 1) ✓; F-7 §2.4 scrubSentryEvent extension + §2.2 "one function, no init changes" (Task 2) ✓; F-7 §2.5 tests (Tasks 1-2) ✓; F-8 §3.2 dedicated redactor (Task 3) ✓; F-8 §3.3 options-seam wiring (Task 4) ✓; F-8 §3.4 tests (Tasks 3-4) ✓; §4 verification (Task 5) ✓; §5 operator-gated lane (Task 5 note) ✓.

**Placeholder scan:** all code shown in full. The two "already exists in this file" notes (Task 4 Step 1 `buildStatusRequest`/`mockClaimInboundEvent`) reference verified existing helpers (test lines 130-137 and the mock at line 39) — the new assertion is fully specified.

**Type/name consistency:** `redactSensitivePathsAndQueries` (helper, export, breadcrumb caller) consistent across Tasks 1-2. `SENSITIVE_QUERY_KEY_RE` distinct from the existing `SENSITIVE_KEY_RE`. `redactDeliveryStatusPayload` consistent across whatsapp-shared.ts, the barrel, the adapter, and tests (Tasks 3-4). `DeliveryStatusOptions.redactPayload` signature `(params: Record<string,string>) => Record<string,string>` matches `redactDeliveryStatusPayload`'s signature. The `ScrubbableSentryEvent` widening (`transaction?`, `breadcrumbs?`, `request.url?`) supports the new assignments and keeps the three `beforeSend` call sites compiling.

**Decision fidelity:** F-8 leaves inbound `redactWhatsAppPayload` untouched (its `expect(out.From)` test stays green) — matches spec §3.2 and the owner's "delivery-status only" decision. F-7 query redaction is generous (`code|otp|signature|access_token` added) — matches the owner's "generous" decision.
