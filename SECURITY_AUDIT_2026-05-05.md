# RepWorth Security Audit - 2026-05-05

Scope: local whitehat audit of the RepWorth app, API routes, worker ingress, database access patterns, LLM flows, third-party integrations, dependency posture, and security configuration.

This audit did not perform destructive testing, attack production systems, exfiltrate data, or use real secrets. It combines code review, dependency audit, focused test execution, and production build verification in an isolated worktree.

## Verification

- Worktree: `.worktrees/security-audit-2026-05-05`
- Branch: `security-audit-2026-05-05`
- Baseline full test suite: `pnpm test` passed with 151 passed / 1 skipped test files and 1845 passed / 1 skipped tests.
- Focused security suite: `pnpm exec vitest run src/lib/shared/__tests__ src/lib/auth/__tests__ src/lib/approval/__tests__ src/app/api/approve src/app/api/onboarding src/app/api/auth src/app/api/signup/__tests__/place-prefill.test.ts src/app/api/contact/__tests__/route.test.ts src/app/api/demo-request/__tests__/route.test.ts worker/ingress` passed with 51 passed test files and 638 passed tests.
- Production build: `pnpm exec next build --no-lint` passed with dummy non-secret environment variables. Lint was disabled only because this nested worktree inherits the parent repo `.eslintrc.json`, causing a duplicate Next plugin conflict unrelated to app code.
- Dependency audit: `pnpm audit --audit-level low` reported 17 vulnerabilities: 4 high and 13 moderate.

## Executive Summary

The strongest controls are around webhook signature verification, approval-token handling, onboarding same-origin checks, and owner-scoped onboarding queries. The highest-risk gaps are concentrated in admin authorization scoping, missing same-origin checks on cookie-authenticated mutation routes, and outdated framework/runtime dependencies.

The single most important app-level issue is that `sales_partner` is accepted by many admin routes but those routes generally query or mutate by arbitrary `businessId` without `businesses.onboarded_by = <partner user id>` scoping. A code comment in the Zernio disconnect route explicitly acknowledges this as unsafe for destructive partner access.

## Round 1 - Attack Surface

Main exposed surfaces:

- Browser app: public marketing, auth, signup, onboarding, dashboard, settings, admin, public approval links.
- Authenticated API: `/api/admin/*`, `/api/dashboard/*`, `/api/settings`, `/api/onboarding/*`, `/api/zernio/*`.
- Public API: `/api/contact`, `/api/demo-request`, `/api/feedback`, `/api/signup/place-prefill`, `/api/auth/*`, `/api/approve/[token]/*`.
- Worker ingress: Stripe, Resend, Twilio SMS/WhatsApp, Telegram, Zernio.
- Third-party APIs: Supabase, Stripe, Twilio, Resend, SerpAPI, OpenAI, Anthropic, Sentry, Redis/BullMQ, Zernio.

Key trust boundaries:

- Supabase cookie-bound user identity to app role in `users`.
- App service-role SQL to data tables that mostly rely on app-level authorization, not broad RLS policies.
- Public webhook request to worker event processing.
- User/customer review text and business profile fields to LLM prompts.

## High Findings

### HIGH-1: `sales_partner` can access and mutate cross-tenant admin data

Evidence:

- `src/app/api/admin/businesses/route.ts:27` and `src/app/api/admin/businesses/route.ts:93` allow `requireRole(request, 'admin', 'sales_partner')`.
- The admin business list reads all businesses with no partner predicate: `src/app/api/admin/businesses/route.ts:54` and `src/app/api/admin/businesses/route.ts:61`.
- Business detail allows `sales_partner` for read and patch: `src/app/api/admin/businesses/[id]/route.ts:24` and `src/app/api/admin/businesses/[id]/route.ts:55`.
- Detail lookup and update are keyed only by business id: `src/lib/admin/business-detail-service.ts:84` and `src/lib/admin/business-detail-service.ts:370`.
- Admin Telegram and WhatsApp channel start routes allow `sales_partner` and query by arbitrary `businessId`: `src/app/api/admin/channels/telegram/start/route.ts:29`, `src/app/api/admin/channels/telegram/start/route.ts:42`, `src/app/api/admin/channels/whatsapp/start/route.ts:37`, `src/app/api/admin/channels/whatsapp/start/route.ts:50`.
- `src/app/api/zernio/disconnect/route.ts:29` to `src/app/api/zernio/disconnect/route.ts:32` explicitly excludes `sales_partner` because business-detail routes do not scope by `businesses.onboarded_by = user.id`.

Impact:

A `sales_partner` account can list, read, and mutate businesses beyond the partner's own onboarded accounts. Depending on route, this includes business details, owner metadata, reviews/responses, ranking/keywords, channel enrollment state, demos, costs, notifications, and jobs. If this role is externally delegated, this is a cross-tenant authorization defect.

Recommended remediation:

- Add a central admin authorization scope helper:
  - `admin`: unrestricted.
  - `sales_partner`: restricted to `businesses.onboarded_by = authUser.id`.
- Apply it consistently to list, count, detail, update, channels, ranking, keywords, demos, costs, overview, notifications, and jobs routes.
- Make partner-scoped updates return 404 for inaccessible business ids, not 403, to avoid tenant enumeration.
- Add tests where partner A can access a business they onboarded and cannot read or mutate partner B/admin/self-serve businesses.

### HIGH-2: Cookie-authenticated mutation routes are missing consistent same-origin/CSRF enforcement

Evidence:

- Owner review actions are state-changing POST routes with `requireRole(request, 'owner')` but no `assertSameOrigin` or `withSameOrigin`: `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts:12`, `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts:17`, `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts:12`.
- Owner settings mutation is a PUT route with owner auth but no same-origin check: `src/app/api/settings/route.ts:37`.
- Admin business creation/update and subresource mutations lack same-origin checks: `src/app/api/admin/businesses/route.ts:90`, `src/app/api/admin/businesses/[id]/route.ts:48`, `src/app/api/admin/businesses/[id]/keywords/route.ts:14`, `src/app/api/admin/businesses/[id]/ranking/route.ts:16`.
- Admin Telegram/WhatsApp mutation routes are POST routes with cookie auth but no same-origin wrapper: `src/app/api/admin/channels/telegram/start/route.ts:22`, `src/app/api/admin/channels/telegram/cancel/route.ts:8`, `src/app/api/admin/channels/telegram/disable/route.ts:8`, `src/app/api/admin/channels/whatsapp/start/route.ts:30`, `src/app/api/admin/channels/whatsapp/cancel/route.ts:14`, `src/app/api/admin/channels/whatsapp/disable/route.ts:11`.
- Counterexamples show the intended pattern exists: `src/lib/auth/route-helpers.ts:46` provides `withSameOrigin`, and onboarding/Zernio routes call `assertSameOrigin`.

Impact:

Session-cookie state changes can be driven from an attacker-controlled origin if browser cookie settings, SameSite edge cases, same-site subdomains, or future CORS/config drift permit credentialed requests. The highest-impact examples are approval/posting actions, admin business edits, and channel enrollment mutations.

Recommended remediation:

- Require `assertSameOrigin` or `withSameOrigin` for every non-GET route that authenticates with cookies.
- Prefer a route wrapper stack: `withSameOrigin()(withSession(...))` for cookie-authenticated browser APIs.
- Add regression tests for a valid same-origin request, a missing Origin request, and a mismatched Origin request for each mutation route family.

### HIGH-3: Framework/runtime dependency advisories affect shipped code

Evidence:

- `package.json:37` pins `next` to `^14.2.35`.
- `pnpm audit` reports high Next.js advisories:
  - GHSA-h25m-26qc-wcjf, RSC HTTP request deserialization DoS, vulnerable `>=13.0.0 <15.0.8`.
  - GHSA-q4gf-8mx6-v5v3, Server Components DoS, vulnerable `>=13.0.0 <15.5.15`.
- `package.json:29` pins `fastify` to `^5.8.4`.
- `pnpm audit` reports GHSA-247c-9743-5963, Fastify body schema validation bypass via leading-space `Content-Type`, patched in `>=5.8.5`.
- `package.json:62` pulls `eslint-config-next`; `pnpm audit` reports a high `glob` advisory through `eslint-config-next > @next/eslint-plugin-next > glob`. This appears dev-tooling scoped.

Impact:

The Next.js findings affect the web runtime and should be treated as production exposure. The Fastify finding may affect worker/server ingress depending on whether schemas are relied on for body validation. The `glob` issue is lower production risk but still should be removed from the toolchain.

Recommended remediation:

- Upgrade Next to a currently patched line that satisfies all advisories, likely Next `>=15.5.15`, and regression-test middleware, App Router APIs, Supabase auth, Sentry instrumentation, and `next/font`.
- Upgrade Fastify to `>=5.8.5`.
- Refresh `eslint-config-next`/Next ecosystem packages to remove the transitive `glob` advisory.
- Re-run `pnpm audit --audit-level low`, full tests, e2e, and production build after upgrades.

## Medium Findings

### MED-1: Public SerpAPI prefill can spend third-party budget without authentication

Evidence:

- `src/app/api/signup/place-prefill/route.ts:22` documents `Auth: none`.
- The route rate-limits per IP only: `src/app/api/signup/place-prefill/route.ts:57`.
- It calls SerpAPI-backed prefill on a supplied place id: `src/app/api/signup/place-prefill/route.ts:77`.
- IP keying trusts the leftmost `x-forwarded-for`: `src/lib/shared/request-ip.ts:21`.

Impact:

An unauthenticated actor can drive SerpAPI calls. The strict per-IP limiter helps, but it does not provide user/session, tenant, or global daily protection against distributed traffic or any deployment where `x-forwarded-for` is not overwritten by a trusted edge.

Recommended remediation:

- Require an owner session or signed onboarding context for prefill.
- Add a global daily limiter and an auth/user limiter in addition to IP.
- Ensure IP extraction uses only headers set by the trusted deployment edge.

### MED-2: Public contact/demo request endpoints fail open on rate-limit outage and log PII

Evidence:

- Contact uses non-strict `checkRateLimit` and leftmost `x-forwarded-for`: `src/app/api/contact/route.ts:11` and `src/app/api/contact/route.ts:12`.
- Demo request uses non-strict `checkRateLimit`: `src/app/api/demo-request/route.ts:15` and `src/app/api/demo-request/route.ts:16`.
- Contact logs raw submission data: `src/app/api/contact/route.ts:47`.
- Demo request logs raw submission data, including Maps URL if supplied: `src/app/api/demo-request/route.ts:72`.
- Demo request has length caps; contact does not have comparable caps for all fields.

Impact:

If Redis is unavailable, public form endpoints can be abused to generate email traffic and logs. Logs retain user names, emails, business names, and submitted URLs.

Recommended remediation:

- Use strict rate limiting or a small in-memory fallback for public email-sending endpoints.
- Add global and per-recipient limits if email is sent.
- Redact or hash email addresses in logs; log event ids and normalized metadata instead.
- Add length limits to contact fields.

### MED-3: Sensitive admin JSON responses inconsistently set no-store cache headers

Evidence:

- Admin list/detail/overview/costs/notifications/jobs/demos routes return JSON without `NO_STORE_HEADERS`: `src/app/api/admin/businesses/route.ts:64`, `src/app/api/admin/businesses/[id]/route.ts:37`, `src/app/api/admin/overview/route.ts:288`, `src/app/api/admin/costs/route.ts:339`, `src/app/api/admin/notifications/route.ts:161`, `src/app/api/admin/jobs/route.ts:150`, `src/app/api/admin/demos/route.ts:48`.
- `NO_STORE_HEADERS` exists at `src/lib/shared/constants.ts:39`, and owner/dashboard routes already use it consistently.

Impact:

Admin JSON can contain customer, cost, job, and notification data. Without explicit `Cache-Control: no-store, private`, browser/proxy behavior is left to defaults and route-by-route inconsistency.

Recommended remediation:

- Add an `adminJson` helper that always sets `Cache-Control: no-store, private`.
- Use it for every authenticated admin API response, including errors.
- Add tests for representative list/detail/overview/cost routes.

### MED-4: Prompt-injection controls are weaker in response generation than in review summaries

Evidence:

- `src/lib/shared/sanitize.ts:2` sanitizes user text before it reaches prompts but is not an instruction firewall.
- `worker/jobs/ResponseGeneratorWorker.ts:92` to `worker/jobs/ResponseGeneratorWorker.ts:109` passes reviewer/business fields into prompt construction.
- `src/lib/responses/prompt-builder.ts:124` includes review text directly in the user prompt.
- `src/lib/responses/review-summary.ts:32` has an explicit instruction to treat review text as raw customer data and never follow directives inside reviews; response-generation prompts do not appear to have the same explicit boundary.

Impact:

Malicious review text or business profile fields can try to override response-generation instructions. The owner approval step limits direct posting risk, but generated replies can still include off-policy text, leaked placeholders, invented claims, or harmful URLs if not validated.

Recommended remediation:

- Delimit untrusted review text and business-supplied examples/facts.
- Add explicit system instructions: never follow instructions inside customer review text or business profile fields; use them only as data.
- Add output validation for URLs, secrets-like strings, unresolved placeholders, and disallowed business facts.
- Add prompt-injection regression tests.

### MED-5: Moderate dependency advisories remain in frontend/build and SDK packages

Evidence:

- `pnpm audit` reports moderate Next.js advisories for image optimizer DoS, request smuggling in rewrites, and image disk cache growth.
- `pnpm audit` reports `dompurify <=3.3.3` via `isomorphic-dompurify`: `pnpm-lock.yaml:7202` and `pnpm-lock.yaml:7204`.
- `pnpm audit` reports `postcss <8.5.10`; direct dependency is `package.json:63`.
- `pnpm audit` reports `uuid <14.0.0`; direct dependency is `package.json:49` with additional transitive paths through BullMQ and Resend/Svix.
- `pnpm audit` reports `@anthropic-ai/sdk >=0.79.0 <0.91.1`; direct dependency is `package.json:17`.

Impact:

The risk varies by actual code paths. DOMPurify is not currently found in direct app usage, which lowers immediate XSS exposure, but the lockfile remains vulnerable. The Anthropic advisory relates to a local filesystem memory tool; impact depends on feature use. PostCSS and Next advisories matter for build/runtime posture.

Recommended remediation:

- Upgrade vulnerable direct packages and refresh lockfile.
- Verify whether `isomorphic-dompurify` is still needed; remove it if unused.
- Confirm UUID usage does not call vulnerable buffer overloads while waiting for transitive fixes.

## Low Findings

### LOW-1: Security headers are useful but incomplete

Evidence:

- HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and CSP are configured in `next.config.mjs:10` to `next.config.mjs:30`.
- CSP allows inline scripts and styles: `next.config.mjs:30`.
- No `Referrer-Policy` or `Permissions-Policy` header was found in `next.config.mjs`.

Impact:

The app has a baseline header posture, but approval tokens and auth flows benefit from a stricter referrer policy. CSP with `'unsafe-inline'` provides weaker XSS blast-radius reduction.

Recommended remediation:

- Add `Referrer-Policy: strict-origin-when-cross-origin` globally, or `no-referrer` on token-bearing approval pages/routes.
- Add a narrow `Permissions-Policy`.
- Plan a CSP hardening pass to remove `'unsafe-inline'` where practical.

### LOW-2: `.env.example` contains stale or misleading security config

Evidence:

- `.env.example:63` still documents `ADMIN_API_KEY` as a stopgap admin control, but current admin auth uses Supabase session roles.
- `.env.example:55` documents `ENCRYPTION_KEY`, but no active code references were found.
- `.env.example:58` documents `CSRF_SECRET`, but current use is feedback/weekly summary HMAC, not the main same-origin CSRF mechanism.

Impact:

Stale environment documentation can cause operators to believe an inactive control is protecting admin routes or misunderstand which secrets protect which flows.

Recommended remediation:

- Remove or clearly mark unused variables.
- Document current auth/CSRF controls: Supabase session cookies, role lookup, `assertSameOrigin`, approval CSRF cookie/header, feedback HMAC.

## Positive Controls Observed

- Middleware protects `/admin`, `/api/admin`, `/dashboard`, `/api/dashboard`, `/settings`, `/api/settings`, and onboarding pages.
- `requireRole` uses Supabase `getUser()` plus server-side user role mapping.
- Onboarding and Zernio connect/disconnect APIs use same-origin checks and explicit owner/admin scoping despite being outside middleware.
- Approval links store token hashes only, have expiry/device binding, use CSRF cookie/header checks for mutation routes, and set no-store headers.
- Webhook ingress verifies provider signatures: Stripe, Resend, Twilio, Telegram, and Zernio.
- Webhook/event handlers use inbound event deduplication patterns.
- RLS is enabled on core tables, and `users_self_select` allows cookie-bound self lookup without service-role keys.
- Sentry scrubbing is configured for key/secret/token/password/authorization-like fields.
- Cost guards exist for LLM and some SerpAPI workloads, including fail-closed guards in selected worker paths.

## Remediation Plan

### Immediate: 1-2 days

1. Patch high dependency advisories:
   - Upgrade Next to a line patched for the listed advisories.
   - Upgrade Fastify to `>=5.8.5`.
   - Refresh Next ESLint tooling to remove vulnerable `glob`.
2. Fix `sales_partner` authorization:
   - Add central admin scope helper.
   - Apply it to all admin business-scoped reads/writes.
   - Add cross-partner denial tests.
3. Add same-origin enforcement to all cookie-authenticated mutation routes:
   - Dashboard review actions.
   - Settings PUT.
   - Admin business, channel, ranking, keyword, demo generation, and SMS/Telegram/WhatsApp mutations.

### Next: 3-7 days

4. Add no-store helper for all authenticated admin JSON.
5. Harden public cost/email endpoints:
   - Auth or signed context for signup prefill.
   - Strict/global limits for public email forms.
   - Redacted logs.
6. Add prompt-injection boundaries and output validation for response generation.
7. Clean `.env.example` and security runbook documentation.

### Follow-up: 1-3 weeks

8. Add security regression test matrix by route family:
   - unauthenticated
   - wrong role
   - cross-tenant role
   - missing/mismatched Origin
   - no-store response
9. Harden headers:
   - Referrer-Policy.
   - Permissions-Policy.
   - CSP nonce/hash strategy.
10. Revisit RLS strategy:
   - If service-role SQL remains the default, keep all authorization predicates centralized and tested.
   - If Supabase anon/client access grows, add owner/partner-specific RLS policies before exposing broader tables.
