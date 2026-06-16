# RepWorth Whitehat Security Audit — 2026-06-15 Refresh & Delta

**Audit date:** 2026-06-15 (multi-round, single session)
**Provenance:** This doc **consolidates and supersedes** the prior 6-round audit (2026-04-26): rounds 1–6 + `findings-summary`. Those per-round files were merged into this one and **removed on 2026-06-15** — every item that was still OPEN/PARTIAL against current code is carried forward in §7 (with its original R-ID for traceability). The four prior High findings (all fixed) are recorded in §2; rejected false-positives in §4. Fixed/obsolete Mediums and Lows are intentionally not repeated.
**Methodology:** Whitebox source review of current `main`-tracked code. Parallel read-only recon sub-agents across five attack surfaces (Round 1), then **direct adversarial verification of every candidate against actual source** (Round 2), then dependency/secrets/CSRF/admin-control-plane review and reconciliation against the prior audit (Round 3). Every High/Medium claim was read and confirmed in source before being recorded; refuted candidates are listed in §4 so they are not re-litigated.

**Why a refresh:** The baseline audit predates ~4 weeks of feature work — owner-facing channels (Telegram/WhatsApp), multi-location, admin impersonation, account offboarding, the auto-post FYI. This pass re-runs the core rounds against current code, confirms the baseline remediations, and probes the new surfaces.

**Scope added vs. baseline §7:** dependency CVE pass (`pnpm audit --prod`) was run this time. Still out of scope (need live/cloud access): Supabase RLS per-policy audit, Vercel/Railway/Upstash config, DNS/email auth (SPF/DKIM/DMARC), live exploitation, Stripe console config.

---

## 1. Headline

**Posture is strong and has improved since the baseline.** All **four** prior High findings are remediated (§2). No Critical or High issues found in current code. Most of the sub-agents' initial "High" candidates were **false positives** disproved on source read (§4) — the same pattern the baseline noted, which is the expected signal for a hardened codebase.

Current open items: **12 Medium**, **12 Low**, **2 Info** — F-1–F-8 found in this pass (detailed in §3); F-9–F-26 carried forward from the 2026-04-26 audit (§7). All are defense-in-depth / hardening; none is an exploitable hole against an un-compromised session or without observability-platform access.

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 12 | F-1, F-7 (§3); F-9–F-18 (§7) |
| Low | 12 | F-2, F-3, F-4, F-8 (§3); F-19–F-26 (§7) |
| Info | 2 | F-5, F-6 (§3) |

---

## 2. Baseline remediation — all 4 prior Highs CLOSED

| Prior | Finding | Status | Evidence (current code) |
|---|---|---|---|
| **R3 H-1** | `MOCK_EXTERNAL_APIS=true` in prod disables webhook signature verification | ✅ **FIXED** | `worker/config/startup-assert.ts:34-38` `assertProductionMockModeEnv()` hard-fails boot when `NODE_ENV==='production' && MOCK_EXTERNAL_APIS==='true'`; wired into `assertWorkerStartupEnv()` (line 134). The fail-open branch in `resend.ts:32` / twilio-verify is now unreachable in prod. |
| **R3 H-2** | Stripe webhook secret / price envs not asserted at boot | ✅ **FIXED** | `startup-assert.ts:49-56` `assertStripeWorkerEnv()` requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, + all `STRIPE_PRICE_*`. |
| **R1 H-1** | `sales_partner` role had unscoped access to every business | ✅ **FIXED (role removed)** | `sales_partner` made DB-impossible by migration 053 (`callback.test.ts:311` "now DB-impossible via migration 053"); only `owner`/`admin` remain. The cross-partner IDOR class is closed at the root — `onboarded_by` scoping is now moot. |
| **R2 H-1** | Owner-edited text not sanitized before storage | ✅ **FIXED** | `sanitizePublicResponseText()` (`src/lib/shared/sanitize.ts:31-51`) strips control + zero-width + **bidi** (U+202A-202E) chars; called at *every* edit boundary: `approval/session-mode.ts:113`, `approval/token-mode.ts:81`, dashboard `edit/route.ts:19` (zod `.transform`), approve `edit/route.ts:45`. Exactly the Pattern B recommendation. |

**Cross-round patterns:** Pattern A (boot assertions) — broadly implemented (Stripe, mock-mode, admin-email, channel, offboarding, Zernio asserts all present). Pattern B (sanitize at persistence boundary) — implemented for owner edit text. **Pattern C — PARTIAL (verified 2026-06-15):** a `beforeSend → scrubSentryEvent` scrubber now runs in all three runtimes and redacts sensitive *keys* in `extra`/`headers`/`data` (the log-PII half is done; channel inbound redaction is solid — see F-8 for the one exception), **but the breadcrumb + URL-value half of R5 M-3 is still open → F-7.**

---

## 3. Current open findings

### F-1 — [MEDIUM] AAL2 (MFA step-up) enforced inconsistently across admin mutation routes
**Where:** Gated WITH step-up (`requireAdminWithAal2`, `src/lib/auth/admin-mfa-gate.ts`): `impersonation/{start,end}`, `offboardings`, `offboardings/[id]/provider-disposition`, `billing/grant-extension`, `flagged`, `businesses/[id]/zernio-queue`.
Gated WITHOUT step-up (plain `requireRole('admin')` + `withSameOrigin`): `businesses/[id]` PATCH, `businesses` POST, `locations/csv-import` (bulk + writes billing outbox), `demos/generate` (triggers LLM spend), `payment-success` (writes `job_outbox`), `businesses/[id]/{channels,keywords}`.

**Assessment:** Since `sales_partner` was removed, `admin` is now a single **global super-role** with no per-tenant scoping — so AAL2 is the *primary compensating control* for high-impact admin actions. It is applied to the newest control-plane routes but not to several pre-existing state-mutating ones of comparable impact (bulk location/billing import, LLM-spend trigger, payment confirmation). **Not exploitable against an un-compromised session** — all routes are admin-role + same-origin (CSRF-protected), and there is **no** admin hard-DELETE of businesses (the route exposes only GET + PATCH; directory.md's "DELETE" is stale). The risk is a hijacked/stolen admin session performing high-impact mutations without re-proving possession of the second factor.

**Fix:** Define an admin route impact tier and route every destructive / billing / bulk / spend-triggering mutation through `requireAdminWithAal2`. Highest priority: `locations/csv-import`, `demos/generate`, `payment-success`.

### F-2 — [LOW] Voice-settings route regresses the safe dynamic-column pattern
**Where:** `src/app/api/settings/voice/route.ts:166-182`.
**What:** Hand-builds the `UPDATE … SET` clause by string-interpolating column names and runs `sql.unsafe(query, values)` — without the `COLUMN_RE` guard, and unlike the sibling `src/app/api/settings/route.ts` which uses the Postgres.js `sql(updates)` dynamic-identifier helper (`runScopedUpdate`).
**Assessment:** **Not exploitable today** — `voiceFields` keys come from a Zod `.object()` that strips unknown keys, so `field` is always one of 4 literals mapping to safe columns; the query is correctly account-scoped (`WHERE id=$1 AND account_id=$N AND archived_at IS NULL`) and ownership is pre-validated. But it reintroduces the exact latent pattern the baseline downgraded as R4 M-3 — a future switch to `.passthrough()` / schema drift would make it injectable.
**Fix:** Use `sql(updates)` (as `runScopedUpdate` does) or add the `COLUMN_RE` check + a schema/map-sync unit test.

### F-3 — [LOW] Build-time transitive dependency CVE (esbuild)
**What:** `pnpm audit --prod` → **1 high** (`GHSA-gv7w-rqvm-qjhr`, esbuild <0.28.1, missing binary-integrity verification → RCE via `NPM_CONFIG_REGISTRY`) + 1 low (Windows dev-server file read — **N/A**, darwin/Linux). Path: `@sentry/nextjs → @sentry/webpack-plugin → webpack → terser-webpack-plugin → esbuild`.
**Assessment:** **Build-time only** (not in the runtime/Vercel-function bundle). The RCE requires an attacker to control the package registry / module fetch during your build. Practical risk **Low** given pinned lockfile + trusted CI. Closes the baseline's deferred CVE-pass item (§7).
**Fix:** pin via pnpm `overrides`: `"esbuild": ">=0.28.1"`, or bump `@sentry/nextjs`. Re-run `pnpm audit --prod` to confirm 0 high.

### F-4 — [LOW] Invariant #3 (no unapproved posting) is code-enforced but not schema-enforced
**Where:** `responses.approval_method` is nullable; the publisher (`ResponsePublisherWorker.ts`) + `mark-posted.ts` transition `status IN ('approved','edited','awaiting_owner_connect') → posted` without asserting `approval_method IS NOT NULL`.
**Assessment:** No active bypass — all approval transitions set `approval_method` atomically, and the auto-policy kill-switch downgrade runs before any external call (`ResponsePublisherWorker.ts:76-89`). But the core invariant has no DB backstop against a future code path that sets an approved status without a method.
**Fix:** `CHECK (status NOT IN ('approved','edited','awaiting_owner_connect') OR approval_method IS NOT NULL)`.

### F-5 — [INFO] Moderation veto on the publish path is implicit
**Where:** `worker/jobs/publisher/load-context.ts` does not join `flagged_responses`.
**Assessment:** Sound today — moderation-held drafts stay `pending_approval`, which the publishable-state gate (`ResponsePublisherWorker.ts:66-73`) excludes, and they never get a publish outbox row. A belt-and-suspenders publisher-side check on open `flagged_responses` holds would harden against a flagged row ever being manually advanced to `approved`.

### F-6 — [INFO] Settings `businesses` UPDATE lacks a redundant account_id constraint
**Where:** `src/app/api/settings/route.ts` `runScopedUpdate('businesses')` filters `WHERE id = ${locationId}` only.
**Assessment:** Safe — `locationId` is server-derived in `getCurrentUser` (`auth.ts:78-82`, the account's primary location), not attacker-controlled. Adding `AND account_id = ${accountId}` is cheap defense-in-depth and matches the voice route's scoping.

### F-7 — [MEDIUM] Sentry scrubber misses breadcrumbs and URL values (residual of baseline R5 M-3)
**Where:** `src/lib/shared/sentry-scrub.ts` (`scrubSentryEvent`); wired via `beforeSend` in `worker/sentry.ts:8`, `src/instrumentation.ts:20,46`, `src/instrumentation-client.ts:14`.
**What:** The scrubber recursively redacts **keys** matching `/key|secret|token|password|authorization/i` in `event.extra`, `event.request.headers`, and (server) `event.request.data` — good for structured `extra`/auth-header leakage. But it **never iterates `event.breadcrumbs`** and **never scrubs URL *values*** (it matches by key-name, not value). There is no `beforeBreadcrumb` hook and no `redactSensitivePathsAndQueries(url)` helper.
**Impact:** A captured event still carries raw `/approve/<token>` in `event.request.url`, the transaction name, and (especially in the **browser** SDK on the `/approve/[token]` page) the default navigation/fetch/console **breadcrumbs**. This is the exact mechanism baseline R5 M-3 flagged, still open. Requires Sentry-platform access to exploit; tokens are single-use, 48h TTL, and the email/session flow is device-bound, which caps practical impact.
**Fix:** (a) add a `redactSensitivePathsAndQueries(url)` helper that masks the `/approve/<token>` path segment + sensitive query params; (b) apply it in `scrubSentryEvent` to `event.request.url`, `event.transaction`, and over `event.breadcrumbs[*].data.url` / `.message`; (c) add a `beforeBreadcrumb` (or breadcrumb pass inside `beforeSend`) in all three runtimes. Add a unit test that a breadcrumb carrying `/approve/<token>` is masked.

### F-8 — [LOW] WhatsApp delivery-status callback persists raw `params` (To/From phone) unredacted
**Where:** `worker/ingress/twilio/twilio-delivery-status.ts:58` passes raw `params` into `claimInboundEvent`, whereas the inbound handler (`twilio-whatsapp-inbound.ts:85`) and Telegram (`telegram.ts:58`) apply `redactWhatsAppPayload` / `redactForAudit` first.
**Assessment:** Status-callback `params` include `To`/`From` (`whatsapp:+<number>`), so the owner's phone number lands raw in `inbound_events.payload` — the same status-vs-inbound asymmetry the baseline noted (R3 L-3) for the now-removed SMS path. Low (the number is already stored in `channel_enrollments`; no token/body here).
**Fix:** Run delivery-status `params` through a redactor (drop/normalize `To`/`From`) before persistence, mirroring the inbound path.

---

## 4. False positives (verified against source, rejected — do not re-litigate)

- **Settings route "missing account_id scope → cross-tenant write" (HIGH claim)** — REFUTED. `user.locationId` is server-derived (`db/auth.ts:78-82`), not from any client cookie; the agent hallucinated an `rw_location_scope` cookie.
- **Voice route "SQL injection" (HIGH claim)** — REFUTED as exploitable (downgraded to F-2). Zod `.object()` strips unknown keys; columns can only be the 4 mapped literals; query is account-scoped.
- **Auth callback "open redirect" (MEDIUM claim)** — REFUTED. Downstream role-prefix allowlist (`callback/route.ts:197-208`) constrains every honored `next` to `/dashboard|/settings|/onboarding` (owner) or `/admin` (admin), plus exact-match reset/finish branches. (Same conclusion as baseline §6.)
- **Resend/Twilio "mock-mode fail-open in prod" (LOW claim)** — REFUTED. `assertProductionMockModeEnv()` makes the worker un-bootable in that state.
- **Admin "IDOR / account takeover via arbitrary accountId" (HIGH claims)** — REFUTED. `admin` is an intentional global role; cross-account reach is by-design. The real residual is F-1 (step-up consistency), not IDOR.
- **Publisher "unapproved/ flagged response can be posted" (MODERATE claims)** — REFUTED as active bypass (downgraded to F-4/F-5). Publishable-state gate + flagged-stays-pending make it non-exploitable; recorded as defense-in-depth.

---

## 5. Recommended next steps

**Quick wins (≈ half a day):**
1. F-3 — add `esbuild ≥0.28.1` pnpm override; re-run `pnpm audit --prod`.
2. F-2 — switch the voice route to `sql(updates)` (delete the `sql.unsafe` string build).
3. F-4 — add the `approval_method` CHECK constraint (next migration).

**This sprint:**
4. F-1 — classify admin routes by impact; apply `requireAdminWithAal2` to `csv-import`, `demos/generate`, `payment-success` (+ business POST/PATCH).
5. F-7 — close the verified Pattern C residual: add URL-value + breadcrumb scrubbing (`redactSensitivePathsAndQueries` + breadcrumb pass) across all three Sentry runtimes; unit-test that a `/approve/<token>` breadcrumb is masked. (Channel inbound log redaction is already solid — only F-8's delivery-status path needs the redactor applied.)

**Backlog (carried forward from the prior audit — §7):** ~10 Mediums + ~8 Lows survive from the 2026-04-26 rounds. Highest-value: F-9/F-10 (prompt-injection + stored-text sanitization), F-13 (`WORKER_PUBLIC_URL` normalization — can silently break Twilio sig verify), F-16 (`SESSION_COOKIE_SECRET` length assert), F-11/F-12 (CSP nonce + COOP/CORP). Bundle the small ones (F-17 EXPIRE, F-22 `.gitignore`, F-23 HSTS preload) into a single hardening PR.

**External (need live/cloud access — not source-fixable):** Supabase RLS per-policy audit, Vercel/Railway/Upstash config review, DNS/email auth (SPF/DKIM/DMARC), Stripe console webhook config, live exploitation pass against a staging deploy.

---

## 6. New surfaces since baseline — coverage notes

- **Telegram/WhatsApp inbound (approve/edit/regenerate):** Reviewed. Well-defended — provider signature/secret verified before side effects, inbound action bound to a *verified* enrollment + a live `approval_links` row whose `channel` must match, opaque UUIDv7 link ids, SHA-256-hashed enrollment tokens, payload redaction before `inbound_events`. No approval-forgery path found.
- **Admin impersonation & account offboarding:** Both gated by `requireAdminWithAal2` + same-origin; offboarding destructive auth uses HMAC fresh-auth stamps + `safeHexCompare` (`timingSafeEqual`). In good shape.
- **Multi-location:** Voice route is account-scoped; only residual is F-2 (pattern hygiene). The known digest-toggle "account-presented / primary-only-stored" issue is a functional bug, not a security one.

---

## 7. Carried-forward open backlog (consolidated from the 2026-04-26 6-round audit)

The six per-round files were deleted after this consolidation. Every item below was still **OPEN** or **PARTIAL** against current code as of 2026-06-15 (verified by per-round reconciliation). Severity is the original audit's rating; mitigations are noted where practical impact is now lower. The four prior Highs (all fixed) are in §2; rejected false-positives in §4; fixed/obsolete Mediums and Lows are intentionally omitted.

| ID | Prior | Sev | Title | Location | Status & fix |
|---|---|---|---|---|---|
| F-9 | R4 M-1 | Med | Voice-learning few-shot interpolates raw owner edits into the LLM prompt (poisoning vector) | `src/lib/responses/prompt-builder.ts:287-288` (`buildVoiceSection`) | PARTIAL — review *text* is tagged + `escapeForReviewBlock`'d, but owner `originalDraft`/`editedVersion` examples are interpolated raw/untagged. Wrap examples in tagged sections + anti-injection language; exclude/sanitize poisoned edits. |
| F-10 | R4 M-2 | Med | Review text + reviewer name stored unsanitized at ingestion | `src/lib/reviews/serpapi-normalize.ts` (text ~:48, name ~:46), `zernio-normalize.ts` (~:47/:41) | PARTIAL — text sanitized only at prompt read-time (`load-context.ts:204`); reviewer name never. Stored bidi/zero-width can spoof dashboard/CSV/PDF rendering. Call `sanitizeText()` at the normalize boundary for both. |
| F-11 | R5 M-1 | Med | CSP allows `'unsafe-inline'` for script/style | `src/lib/security/csp.mjs:31-32` | OPEN — nonce migration deferred. Move to nonce-based CSP. |
| F-12 | R5 M-2 | Med | COOP + CORP response headers missing | `next.config.mjs` `headers()` | ✅ FIXED (Phase 7a) — `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Resource-Policy: same-origin` added to the global `/(.*)` header block; guarded by `src/lib/security/__tests__/next-config-headers.test.ts`. |
| F-13 | R3 M-1/L-2 | Med | `WORKER_PUBLIC_URL` not normalized/asserted (https, no trailing slash) | `worker/ingress/twilio/whatsapp-shared.ts:11`; `worker/config/startup-assert.ts` (presence-only) | OPEN — a trailing slash silently breaks the Twilio signature base URL. Normalize + assert `^https://[^/]+$` at boot. |
| F-14 | R3 M-2 | Med | Stripe handler doesn't reject stale events via `event.created` | `worker/ingress/stripe/` | OPEN — add a staleness threshold on `event.created`. |
| F-15 | R3 M-3 | Med | `inbound_events` 2-min reclaim can double-process a slow handler | `worker/ingress/shared.ts:39` | OPEN (mitigated by app-layer idempotency). Add lease extension or widen window for slow handlers. |
| F-16 | R2 M-3 | Med | `SESSION_COOKIE_SECRET` length never validated | `src/lib/approval/cookies.ts:33-37`; startup-assert (presence-only) | OPEN — assert min length (≥32 bytes) at boot. |
| F-17 | R6 M-2 | Med | `ADJUST_COST_LUA` missing `EXPIRE` → TTL-less Redis ghost key | `src/lib/costs/tracker.ts:220-225` | OPEN (self-correcting). Add `EXPIRE` mirroring `RESERVE_COST_LUA`. |
| F-18 | R1 M-1 | Med | Cancelled-owner read gate not centralized | `src/proxy.ts:76-84` (`readSelf` omits `subscription_status`); enforced per-route in `dashboard/route.ts:122-167` | OPEN — centralize the subscription-state read gate, or document the per-route model as intentional. |
| F-19 | R1 M-2 / R5 L-3 | Low | `signup-status` is an enumeration oracle (401/404 vs 200) | `src/app/api/auth/signup-status/route.ts:102,154-157,192` | OPEN — unify to `200 { state }`. |
| F-20 | R1 M-3 | Low | No per-admin daily quota on demo generation | `src/app/api/admin/demos/generate/route.ts:38,47` | OPEN (blast radius reduced — `sales_partner` removed; global + per-IP caps exist). Add per-`user.id` daily cap. |
| F-21 | R3 L-1 | Low | No rate limit on `/ingress/*` | `worker/index.ts` route registration | OPEN — add a per-IP limiter (signature verify already gates forgery). |
| F-22 | R5 L-1 | Low | `.gitignore` `.env*.local` misses `.env.production/.staging` | `.gitignore` | OPEN — broaden to `.env*` + `!.env.example`. |
| F-23 | R5 L-2 | Low | HSTS header missing `preload` | `next.config.mjs:16` | HELD (Phase 7a, owner-gated 2026-06-16) — header change deliberately NOT shipped. Submitting `repworth.net` (+ all subdomains) to the HSTS preload list is effectively irreversible; adding the `; preload` token is itself a consent signal. Awaiting explicit owner sign-off before the token + list submission. Tracked with the F-3 dependency follow-up. |
| F-24 | R4 L-2 | Low | `/api/approve/[token]/edit` uses manual validation, not Zod | `src/app/api/approve/[token]/edit/route.ts:31-50` | OPEN (validation is correct; stylistic). Adopt `z.object` like the dashboard edit route. |
| F-25 | R4 L-4 | Low | `PlaceAutocomplete` clears via `innerHTML=''` | `src/components/places/PlaceAutocomplete.tsx:124` | OPEN (safe empty-string assign; stylistic). Use `replaceChildren()`. |
| F-26 | R1 L-1 | Low | Proxy path matching not case-normalized | `src/proxy.ts` / `src/lib/shared/protected-routes.ts` | OPEN (near-zero impact — App Router is case-sensitive). Optional lowercase normalize. |

**Accepted / won't-fix (recorded so they aren't re-flagged):** R6 L-4 (cancelled jobs dequeue before the subscription check — wasted DB query, not a bypass); R2 L-1 (no User-Agent allowlist on `/session` POST — audit-log noise, mooted by the now-atomic device-bind); the prior audit's Informational comment-only items (intent comments, `.env.example` placeholders).
