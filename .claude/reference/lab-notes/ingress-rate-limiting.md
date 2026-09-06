# Lab notes — Ingress / rate limiting

## Summary

- **Ingress / rate limiting** — the limiter's ingress-scope test needs BOTH arms: `request.routeOptions.url` (post-routing, resolved) and `decodeIngressPath(request.url)` (raw, decoded). Percent-encoded paths (`/%69ngress/resend`) defeat a raw check and absolute-form request targets (RFC 9112 §3.2.2) defeat the decoded one — either alone bypassed the limiter for Stripe, Resend, Telegram, Twilio and Zernio alike. A statutory opt-out route is exempt by design (§9.2), and the exemption must be read from the RESOLVED route config so an unmatched path under the prefix cannot inherit it (#644). **Turning a failing ingress path into an acking one silently retires a pager** — `checkFailedInboundEvents` keys on `inbound_events.status='failed'`, so any such change owes a replacement alert at the source in the SAME PR, and no mechanical gate can see the gap (#967, 2026-08-26)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-04.md § "Vercel serverless can't reach local Docker Redis"
- history/2026-05.md § "`ON CONFLICT DO NOTHING` + an unconditional alert = alert spam on every re-ingest"
- history/2026-06.md § "Get a webhook-signing secret from dotenv, not `grep`/`cut` — and sign in-process"
- history/2026-08-01-to-07.md § "2026-08-03 — #644 unsubscribe opt-out ship promotions"
- history/2026-08-01-to-07.md § "[2026-08-03] `app.inject()` normalises the request target, so it cannot falsify a claim about the raw request line — and absolute-form targets bypassed the ingress limiter for ALL FIVE providers"
- history/2026-08-21-to-31.md § "2026-08-26 — #967 post-purge global opt-out"
- history/2026-08-21-to-31.md § "[2026-08-26] turning a failing ingress path into an acking one silently retired a pager → `checkFailedInboundEvents` keys on `inbound_events.status='failed'` → any such change owes a replacement alert AT THE SOURCE, in the same PR"
- history/2026-08-21-to-31.md § "2026-08-31 — WS8 Phase E: provider webhooks, and a secrets-CLI incident"
- history/2026-08-21-to-31.md § "[2026-08-31] Both providers expose webhook CRUD over their APIs — the runbook's dashboard steps were never necessary"
- history/2026-08-21-to-31.md § "[2026-08-31] Webhook subscriptions are per-USER, not per-environment → every event fans out to both workers"
