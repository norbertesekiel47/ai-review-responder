# Spec 20 — API, Integrations & Extensibility

> **Goal:** REST API on Scale tier with auto-generated OpenAPI 3.1 spec, customer webhooks via Svix, official Zapier app by month 9, native Slack + HubSpot integrations, scoped API tokens with rate limits.

---

## 1. Why this matters

API + Zapier = free distribution to the long tail of SMB integrations RepWorth can't ship natively. Skipping GraphQL is the right call for SMB customers. Skipping rolled-your-own webhook infrastructure prevents 2 years of reliability hell.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- No public API, no `api_tokens` table, no bearer-token auth — internal routes use **session + `withSameOrigin` CSRF + `resolveOwnerScope`** (`src/lib/auth/route-helpers.ts`).
- ✅ **Zod is already used** in route handlers (schemas in `src/lib/shared/schemas`) — so `zod-to-openapi` is viable without retrofitting validation.
- **No customer-facing webhooks / Svix.** RepWorth only *receives* webhooks (`worker/ingress/*`, dedup via `inbound_events`). Sending is net-new.
- No Zapier/Slack/Make. Approval-required verified: draft → `/approve` → publish via outbox; **no auto-publish path** (invariant holds).
- "API on Scale tier" maps to the live **Premium** tier ([Spec 02](./02-pricing-packaging.md)) — there is no "Scale" tier.

## 3. Target state

### Public REST API
- **REST on Scale tier** (gating drives upsell).
- Versioned at `/api/v1/`.
- **OpenAPI 3.1** spec auto-generated from route handler types using `zod-to-openapi` (assumes Zod schemas already used) or `tsoa`.
- Sunset policy: **12-month notice** for breaking changes. Document on `/changelog/api`.

### Endpoint set (v1 launch)
- `GET /api/v1/businesses` — list locations (account-scoped).
- `GET /api/v1/reviews?business_id=&since=&star=` — list reviews.
- `GET /api/v1/responses?review_id=` — list responses for a review.
- `POST /api/v1/responses` — create draft (subject to approval flow — no auto-publish).
- `POST /api/v1/responses/:id/approve` — owner-equivalent approval; requires `x-on-behalf-of` user ID for audit.
- `GET /api/v1/responses/:id` — get response.
- `GET /api/v1/audit-events?since=&type=` — audit log read on Scale tier.

### Customer-facing webhooks
**Event types**:
- `review.received`
- `response.drafted`
- `response.approved`
- `response.published`
- `response.flagged`
- `subscription.changed`

**Use a managed webhook platform** — do NOT roll your own. **Svix** is the SaaS standard. Handles retries, signing, deliverability.

### API key management
- Settings → API page.
- Scoped tokens:
  - **read-only** (GET endpoints)
  - **read-write** (GET + POST except destructive)
  - **admin** (everything except billing destroy)
- Rotatable: generate new token, old one continues to work for 24h.
- Audit log every API token use (sampled if high-volume): record `token_id`, `endpoint`, `method`, `account_id`, `actor_user_id`, `at`.

### Rate limits
- 100 req/min default per account.
- Per-endpoint overrides documented.
- 429 with `Retry-After`.

### Zapier app (month 9)
- Official Zapier app, certified.
- Common Zaps:
  - `review.received` → Slack channel
  - `response.flagged` → email
  - `subscription.changed` → CRM (HubSpot, Salesforce)
- Build → submit → certify → list publicly.

### Make.com (after Zapier)
- Custom Make module mirrors Zapier triggers/actions.
- n8n via raw webhook (no native module).

### Native integrations roadmap
Priority order (each unlocks a vertical):
1. **Slack** (notifications) — universal SMB tool.
2. **Microsoft Teams** (notifications) — clinic / dental customers.
3. **HubSpot CRM** (review-to-CRM sync) — sales teams.
4. **Google Sheets** (export) — owners who report up.
5. **Vertical POS**: Square, Toast, Mindbody — links review to customer transaction.

Don't build until **5+ customers ask for the same integration**.

### OpenAPI docs
- Auto-generated from route handler types (zod-to-openapi).
- Hosted at `docs.repworth.com/api`.
- Mintlify renders "Try it" via OpenAPI playground (already part of Mintlify Pro).

### API authentication
- Bearer token in `Authorization: Bearer rpw_live_...`.
- Tokens prefixed by environment (`rpw_test_` vs `rpw_live_`).
- Format: `rpw_{env}_{random28}`. Stored hashed (SHA-256, similar to approval token pattern).

## 4. Implementation tasks

1. Migration (next free number; head 042 — coordinate per README): `api_tokens(id, account_id, name, token_hash, scope, last_used_at, created_at, revoked_at)`. Hash with SHA-256, mirroring the approval-token pattern.
2. Build API token middleware: extract bearer, look up hash, set `req.account_id` + `req.token_scope`.
3. Build `/api/v1/*` routes per §3 endpoint set.
4. Wire `zod-to-openapi` or `tsoa` to generate `openapi.json` at build time.
5. Subscribe Svix. Create event source per RepWorth event type. Wire enqueue calls from worker (`worker/jobs/notification/*`).
6. Build Settings → API page:
   - Generate token UI (one-time-show with copy button).
   - Token list with scope, last-used, revoke.
   - Webhook endpoint UI: add endpoint, choose events, see delivery log (Svix-rendered iframe).
7. Apply per-`account_id` rate limiting at 100/min default using the existing **Redis-Lua `src/lib/shared/rate-limit.ts`** (not `@upstash/ratelimit` — see [Spec 04](./04-auth-identity.md)).
8. Build Mintlify API reference site at `docs.repworth.com/api`.
9. **Month 9**: build Zapier app per Zapier Platform docs. Submit for certification.
10. Native Slack integration: OAuth install, channel selector, post review-received messages.

## 5. Acceptance criteria

- [ ] OpenAPI 3.1 spec auto-generates on every build; matches actual route behavior.
- [ ] `/api/v1/*` endpoints functional and rate-limited.
- [ ] API tokens generatable, scoped, rotatable; old token grace = 24h.
- [ ] Svix-managed webhooks: customer can subscribe to events, deliveries visible, signature verifiable.
- [ ] Mintlify API reference live with "Try it" playground.
- [ ] Audit log captures API calls (sampled at high volume).
- [ ] Zapier app (month 9 milestone): certified and listed.

## 6. Metrics

| Metric | Target |
|---|---|
| API uptime | 99.9% |
| Webhook delivery success (after retries) | ≥ 99.5% |
| API token adoption (Scale tier accounts) | ≥ 50% |
| OpenAPI spec drift (CI guard) | 0 (auto-generated) |
| Zapier app installs (month 12) | ≥ 50 |

## 7. Risks & mitigations

- **Risk:** Customer's API integration auto-publishes responses (bypasses approval invariant). **Mitigation:** API has no auto-publish endpoint — `POST /responses` creates a draft requiring `POST /responses/:id/approve` with audit. `x-on-behalf-of` header documented and audited.
- **Risk:** Webhook receivers leak data (HTTP not HTTPS, public URL). **Mitigation:** Svix enforces HTTPS; signing prevents tampering; document customer obligations in API ToS.
- **Risk:** OpenAPI drift if route handlers change without type updates. **Mitigation:** spec is the type-derived artifact; CI fails if hand-edited.

## 8. Dependencies & cross-links

- [Spec 02 — Pricing](./02-pricing-packaging.md) (API on Scale tier)
- [Spec 04 — Auth & Identity](./04-auth-identity.md) (scoped roles map to scoped tokens)
- [Spec 07 — Observability](./07-observability.md) (API call audit)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (token rotation, hashed storage)
- [Spec 17 — Legal](./17-legal-compliance-docs.md) (API ToS — customer obligations)
- [Spec 25 — Documentation](./25-documentation.md) (Mintlify API site)
- Code anchors: `src/app/api/*` (15 route groups), `src/lib/auth/route-helpers.ts` (`withSameOrigin`/`resolveOwnerScope`), `src/lib/shared/schemas` (Zod), `src/lib/shared/rate-limit.ts`, `worker/ingress/*` (inbound webhooks), approval-token hashing pattern
- Invariant: "No auto-posting" — preserved by approval-required endpoint design

## 9. Implementation in the current repo

- **Zod is already pervasive** in routes — `zod-to-openapi` can generate the spec from existing schemas in `src/lib/shared/schemas` with minimal retrofit. This is the spec's strongest "already-aligned" point.
- **Token auth is net-new** but mirrors what exists: SHA-256 hashed storage (approval-token pattern), and `resolveOwnerScope` is the model for setting `req.account_id`/scope from a bearer token instead of a session.
- **Outbound webhooks (Svix) are net-new** — RepWorth's `inbound_events` ingress is the *receiving* side; sending is a separate Svix integration, enqueued from the worker notification path.
- **Rate limiting reuses `rate-limit.ts`** (Redis-Lua), not a new Upstash SDK.
- **Approval invariant is safe by design**: the v1 API exposes `POST /responses` (draft) + `POST /responses/:id/approve` (audited) — no auto-publish endpoint.
- **Mintlify API docs** depend on the docs site stood up in [Spec 13](./13-customer-support.md)/[Spec 25](./25-documentation.md); OpenAPI drift-check is CI-gated ([Spec 24](./24-devops-deployment.md)).

---
_Verified 2026-05-23 against migration head 042. Confirmed Zod is already used (OpenAPI viable); corrected "Scale"→Premium tier, the Upstash→Redis-Lua rate-limit, inbound-vs-outbound webhook distinction, and migration numbering._
