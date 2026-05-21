# RepWorth Whitehat Security Audit — Synthesis & Remediation Roadmap

**Audit dates:** 2026-04-26 (single-session, six rounds)
**Methodology:** Whitebox source review across `src/`, `worker/`, `supabase/migrations/`, root config, and dependency manifest. Two parallel sub-agents per round followed by direct verification of every Critical/High claim against actual source. Several agent findings were rejected as false positives — those are explicitly documented in the per-round reports.

**What was audited:** 49 Next.js API routes, 7 Fastify worker webhook ingress endpoints, the approval token state machine, all 4 notification channels (email/SMS/Telegram/WhatsApp), Supabase Auth flows, Stripe payment + webhook integration, subscription state machine, outbox + idempotency plumbing, cost guards, secrets handling, HTTP headers, race-condition surfaces, and business-logic abuse paths.

**What was NOT audited:** Live exploitation, dependency CVE deep-dive (`pnpm audit` not run), Vercel/Railway/Supabase/Upstash account configuration, DNS / email auth (SPF/DKIM/DMARC), Supabase RLS policies beyond `users_self_select`, Stripe console webhook configuration. These are scoped as follow-ups in §7.

---

## 1. Headline numbers

| Round | Title | C | H | M | L | I |
|---|---|---|---|---|---|---|
| 1 | Auth & Authorization | 0 | 1 | 3 | 2 | 1 |
| 2 | Approval Flow & Token Security | 0 | 1 | 3 | 1 | 3 |
| 3 | Webhook Ingress | 0 | 2 | 4 | 3 | 3 |
| 4 | Injection / XSS / SSRF | 0 | 0 | 4 | 4 | 5 |
| 5 | Secrets / Logging / Headers | 0 | 0 | 4 | 3 | 5 |
| 6 | Race / Idempotency / Business Logic | 0 | 0 | 4 | 4 | 0 |
| **Total** | | **0** | **4** | **22** | **17** | **17** |

**Zero Critical findings.** No unauthenticated state mutation, no secret in client bundle, no SQL injection, no auth bypass, no broken approval invariant.

The four High-severity findings below are the realistic attacker entry points. Everything else is hardening, defense-in-depth, or future-proofing.

---

## 2. Top 4 attacker entry points (ranked by exploitability × impact)

If I were attacking this app on Monday, here's where I'd start. In rank order:

### #1 — `MOCK_EXTERNAL_APIS=true` in production silently disables Twilio + Resend signature verification
**[R3 H-1]** — `worker/ingress/twilio-verify.ts:28-39`, `worker/ingress/resend.ts:24-34`, `worker/startup-assert.ts:33,54,76`

**Why this is #1:** It's the only finding in the entire audit where a single env-var mistake removes ALL signature verification on production webhooks. The startup assertions that would catch the missing secret are themselves gated behind the same flag. Two layers of defense overlap into one.

**What an attacker does:** POSTs `/ingress/twilio/inbound` with `From=<victim_phone>&Body=STOP&MessageSid=SM00…` to opt the victim out of all SMS notifications. Or POSTs `/ingress/resend` with a forged hard-bounce to flag the owner's email as bouncing, killing their notification stream. Or POSTs `/ingress/twilio/whatsapp-inbound` with `ButtonPayload=a:<known-link-uuid>` to trigger an approval — combined with #2 below, this enables silent forged response publication.

**Probability of activation:** Low (requires operator misconfiguration). **Cost of activation:** Catastrophic — TCPA-recordable forged opt-outs, forged approvals publishing to Google.

**Fix scope:** Three layers: (a) hard-fail at boot if `NODE_ENV === 'production' && MOCK_EXTERNAL_APIS === 'true'`; (b) remove `MOCK_EXTERNAL_APIS` early-returns from channel asserts; (c) check `NODE_ENV` in verify functions. ~30 lines total.

---

### #2 — Email approval link confers full edit/approve/regenerate authority; `editedText` is not sanitized before storage
**[R2 H-1]** — `src/app/api/approve/[token]/edit/route.ts:12,66`; `src/lib/approval/token-mode.ts:74-112`

**Why this is #2:** Anyone who possesses the email approval URL — lock-screen SMS preview, intercepted email, an attacker who beats the legitimate owner to the device-bind race, or a future XSS that can read approval URLs — can edit a response to arbitrary 2000-char text and approve it. The text flows to `awaiting_manual_post` where the sales partner copies it to Google. Today the partner is the manual gate; once GBP API auto-post ships (Phase 5), this becomes the only gate.

**What an attacker does:** Captures the URL via lock-screen preview on owner's phone, opens it in their browser before owner does (winning the device-bind race per **R2 M-2**), submits a 2000-char defamatory or off-brand reply, the partner pastes it to Google.

**Probability of activation:** Medium for the lock-screen-preview path; high once GBP API auto-posts. **Cost of activation:** Reputational damage — published as the business's own reply on Google.

**Fix scope:** Sanitize `editedText` on storage (strip HTML, reject bidi/zero-width unicode, normalize). Add the same sanitization at the GBP API publish boundary (defense in depth). ~50 lines + 1 helper.

---

### #3 — `sales_partner` role has unscoped access to every business
**[R1 H-1]** — `src/app/api/admin/businesses/route.ts:25-84`, `src/app/api/admin/businesses/[id]/route.ts:17-113`, `src/app/api/admin/businesses/[id]/channels/route.ts:15-62`, `src/app/api/admin/businesses/[id]/mark-posted/route.ts:5-62`

**Why this is #3:** Every per-business admin route checks `requireRole('admin', 'sales_partner')` but does NOT scope queries by `onboarded_by = currentUser.id` for sales_partner callers. The schema has the `onboarded_by` column expressly for this; no route uses it. Latent today (Norbert is sole partner) — explosive the moment a second sales_partner is added.

**What an attacker does:** A second hired sales_partner immediately has full read + write to every business onboarded by every other partner. Lists all customers. Reads business details. Modifies settings via PATCH. Marks any response as posted. Views masked SMS/Telegram/WhatsApp handles.

**Probability of activation:** 100% the day a second sales_partner logs in. **Cost of activation:** Cross-tenant data exposure inside the admin tier; depending on partner trust, ranges from "minor leak" to "full customer-list exfiltration."

**Fix scope:** Single helper `getScopedBusinessFilter(role, userId)` that returns either an empty fragment (admin) or `AND b.onboarded_by = ${userId}` (sales_partner). Apply to every per-business route. Verify `keywords` and `ranking` routes too (not directly read this round). ~30 lines.

---

### #4 — Stripe webhook secret + Payment Link envs are not asserted at boot
**[R3 H-2]** — `worker/startup-assert.ts` (no `assertStripeEnv()`); `worker/ingress/stripe.ts:208-213`

**Why this is #4:** Less attacker-driven than the others — it's a silent-failure operational risk. If `STRIPE_WEBHOOK_SECRET` is missing or rotated incorrectly, the worker boots cleanly and every `checkout.session.completed` event for paying customers is rejected. Stripe retries for ~3 days. Owners pay but their subscription_status never flips to active. Notifications and publishing silently stop for new customers. Detection requires noticing the missed activations hours/days later.

**Fix scope:** Add `assertStripeEnv()` checking `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` are non-empty unconditionally. Five-line addition.

---

## 3. Cross-round patterns

Three patterns surfaced across multiple rounds — each is a systemic gap rather than a one-off finding.

### Pattern A: Defense-in-depth boot assertions are inconsistently applied
- R3 H-1: Three channel asserts gated behind `MOCK_EXTERNAL_APIS=true`
- R3 H-2: No Stripe boot assert at all
- R3 M-1 / L-2: `WORKER_PUBLIC_URL` never validated for trailing slash or `https://` prefix
- R2 M-3: `SESSION_COOKIE_SECRET` never validated for minimum length
- R5 L-1: `.gitignore` `.env*.local` pattern doesn't catch `.env.production`

**Recommendation:** A single `worker/startup-assert.ts` pass that defines an `assertEnv(varName, validator?)` helper, and a `validators.ts` with `httpsUrl()`, `minLength(n)`, `nonEmpty()`, etc. Then add asserts for every secret/URL/length-sensitive var. One-shot hardening across the whole boot sequence.

### Pattern B: Owner-controlled text flows into output paths with inconsistent sanitization
- R2 H-1: `editedText` not sanitized before storage
- R4 M-1: Voice-learning examples interpolate raw `editedText` into LLM prompts
- R4 M-2: `sanitizeText()` exists but is not called in the review-ingestion pipeline at all

**Recommendation:** Adopt a "sanitize at the persistence boundary" rule. Every entry point that writes user-controlled text to the DB calls `sanitizeText()` first. Extend `sanitizeText` to also strip bidi-override + zero-width unicode. Document the contract in a comment header on the function. Single PR closes all three.

### Pattern C: Sentry / log breadcrumbs not aware of approval-token URLs
- R5 M-3: Sentry `beforeBreadcrumb` not configured — approval tokens land in breadcrumbs in plaintext
- R3 L-3: SMS inbound logs full phone numbers; WhatsApp masks them (inconsistency)
- R2 (verified safe): raw tokens never written to outbox / audit / Sentry capture — but breadcrumbs are a separate code path

**Recommendation:** Add a single `redactSensitivePathsAndQueries(url: string): string` helper. Apply it in (a) Sentry `beforeBreadcrumb` for both Next.js and worker, (b) any `console.log`/`logger` call that includes a request URL. Pair with a CI lint rule that flags any new code emitting URLs to logs without going through the helper.

---

## 4. Remediation roadmap

Ordered by impact-per-effort, grouped into commit-able batches.

### Sprint 0 — "fix this week" (high impact, ~1 day total)

1. **R3 H-1** — Three-layer fix on `MOCK_EXTERNAL_APIS=true` in production. ~30 lines. Highest ROI in the audit.
2. **R3 H-2** — Add `assertStripeEnv()`. ~5 lines.
3. **R3 M-1 + L-2** — Normalize + assert `WORKER_PUBLIC_URL` (strip trailing slash, require `https://`, no path). ~10 lines.
4. **R5 M-3** — Add Sentry `beforeBreadcrumb` URL scrubber. ~30 lines, applied in two places.
5. **R5 L-1** — Replace `.gitignore` `.env*.local` with `.env*` + `!.env.example`. Two lines.

### Sprint 1 — "fix this sprint" (real risk, 1-2 weeks)

6. **R2 H-1 + R4 M-1 + R4 M-2** — Single PR that introduces `sanitizeOwnerText()`, applies it at every owner-text persistence boundary (review normalize, edit text, business onboarding fields), wraps voice-learning examples in tagged sections with anti-injection system-prompt language. Closes Pattern B.
7. **R1 H-1** — Add `getScopedBusinessFilter(role, userId)` helper, apply to every per-business admin route. Verify `keywords` and `ranking` routes too. Hardening required before adding a second sales_partner.
8. **R2 M-2** — Make device-bind atomic with `WHERE device_cookie_hash IS NULL` + clear error message on second binder. Prevents the device-race attack.
9. **R5 M-2** — Add the four missing security headers (`Permissions-Policy`, `Referrer-Policy`, COOP, CORP) to `next.config.mjs`. Five-line change.
10. **R5 M-4** — Verify production CSP works with Maps API enabled in a staging environment. Either it's already broken (functional bug) or there's a path I missed; either way document the required allowlist.
11. **R3 M-2 + M-3 + M-4** — Stripe `event.created` staleness, `inbound_events` reclaim window, WhatsApp ButtonPayload bounds. Each is small.
12. **R4 M-3** — Mirror the admin route's `COLUMN_RE` check in `/api/settings`. Five-line change. Add unit test asserting schema/map sync.
13. **R6 M-2 + M-3** — Add EXPIRE to `ADJUST_COST_LUA`; convert SMS-tracker refund to Lua. Two small Lua scripts.

### Sprint 2 — "track in backlog" (lower urgency)

14. **R6 M-1** — `subscription_status_changed_at` column. Bundle with the next billing sprint as already planned.
15. **R5 M-1** — Migrate to nonce-based CSP. 1-2 day project; significant XSS defense-in-depth uplift.
16. **R1 M-1** — Add `subscription_status='active'` check at the owner middleware gate.
17. **R1 M-2** — Unify `signup-status` to always return 200 with state in body.
18. **R1 M-3** — Per-partner daily quota on demo generation.
19. **R6 M-4** — When GBP API ships, mark-posted goes away. Until then, optionally add post-sync hash comparison.
20. **R4 M-4** — Add Zod schemas to the seven SMS admin routes.
21. **All Low + Informational findings** — Bundle into a "small fixes" PR once the above ship.

---

## 5. Defense-in-depth wins (close categories at once)

These structural changes close whole classes of bug rather than individual findings. Higher cost, much higher ROI.

- **Pattern A solution: standardized boot assertions** — closes R3 H-1, H-2, M-1, L-2; R2 M-3; R5 L-1. Single helper module. ~1 day.
- **Pattern B solution: sanitization at persistence boundary** — closes R2 H-1; R4 M-1, M-2. Single helper + ~5 call-site additions. ~half a day.
- **Pattern C solution: URL/PII redaction helper for logs + Sentry** — closes R5 M-3; R3 L-3. Single helper + two integration points. ~half a day.
- **R1 H-1 fix (`onboarded_by` scoping helper)** — closes the entire class of cross-partner IDOR before it activates with a second hire.
- **Sentry / observability hygiene pass** — combine the `beforeBreadcrumb` scrubber with a one-time review of every `Sentry.captureException` call site to confirm `extra` payloads don't include raw tokens, full request bodies, or auth headers. Likely ~2h.

---

## 6. False positives encountered (and rejected)

For the record — sub-agents flagged these as Critical or High, but verification against actual source disproved them. Listed so future reviewers don't re-litigate them:

- **OAuth callback open redirect** (R1) — strict role-prefix whitelist after the `nextIsSafe` check covers all path-traversal attempts.
- **`SUPABASE_SERVICE_KEY` in Edge middleware** (R1) — middleware comment at line 7-9 documents that the key was deliberately removed; verified only `NEXT_PUBLIC_SUPABASE_ANON_KEY` is used.
- **Cross-business approval token swap** (R2) — `lockValidLink` reads both `business_id` and `response_id` from the same `approval_links` row; no parameter manipulation surface.
- **Telegram `callback_data` not signed** (R2) — webhook secret + enrollment binding is the correct trust boundary; signing inside an already-signed envelope adds nothing.
- **Cross-channel link revocation as a bug** (R2) — intended behavior; once a response is approved on any channel, other channels' links should not act on it.
- **Historical enrollment reuse across business transfers** (R2) — `archived_at IS NULL` + `business_id = link.business_id` combination prevents this.
- **SMS disable cross-tenant access** (R1) — that endpoint is `requireRole('admin')` only; sales_partner returns 403.
- **`AuthError.message` leakage** (R5) — actual messages are literal `'Unauthorized'` / `'Forbidden'`. Agent hallucinated specifics.
- **Settings route "Critical SQL injection"** (R4) — `Object.keys(data)` is bounded by the Zod schema, so column names can only come from the FIELD_TO_COLUMN map. Real concern is the missing defense-in-depth `COLUMN_RE` check (downgraded to M-3).
- **Outbox dual-dispatch** (R6) — atomic UPDATE + attempt-guarded completion correctly prevents.
- **Admin onboarding cost-abuse** (R6) — by-design per CLAUDE.md, bounded by cost guards.

---

## 7. Out-of-scope follow-up engagements

Mentioned briefly in each round's coverage notes — collated here for your roadmap planning.

- **Dependency CVE pass** — Run `pnpm audit --prod` and `pnpm dlx [email protected]`. Out of scope for source-only review.
- **Supabase RLS policy audit** — Only `users_self_select` was examined. Every table with RLS deserves a per-policy review for completeness, especially around the multi-tenant data model.
- **Cloud config audit** — Vercel build env, Railway env, Supabase service-role rotation, Upstash auth. Needs account access.
- **DNS / email auth** — SPF/DKIM/DMARC for `repworth.net` and the Resend sending domain. CAA records. HSTS preload submission. Domain takeover for any subdomains pointing at decommissioned services.
- **Live exploitation pass** — Probe against `pnpm dev` for any of the High findings to confirm exploitability end-to-end. Useful as confirmation before/after the Sprint 0 fixes ship.
- **Stripe console verification** — Confirm webhook URL is HTTPS, signature secret matches what the worker expects, registered events match what the handler dispatches on, retry policy is sane.
- **Per-template email-rendering review** — R4 confirmed escaping coverage on the templates the sub-agent visited; a per-template eyeball pass would close the loop on any template that ships in the future.
- **Penetration test of the production deployment** — only static review of what would deploy was performed. A live pentest against a staging or canary deployment would surface deployment-only issues (load balancer misconfig, header injection at the proxy layer, etc.).

---

## 8. What I would do first

If I had one day to spend on RepWorth security: **Sprint 0 above** — five fixes, all small, total maybe 1-2 hours of work plus testing. Eliminates the highest-impact attacker entry point (R3 H-1), removes a silent revenue-failure risk (R3 H-2), and patches the most concrete data-leak channel (R5 M-3). Then schedule Sprint 1 for the next week.

If I had one architectural decision to make: **invest in Pattern A** (standardized boot assertions). It closes six findings across three rounds and prevents a whole class of "missed env var → silent failure" bugs from being added in the future.

Per-round detailed reports are in `docs/security-audit/round-{1-6}-*.md` for everything mentioned above plus all Medium / Low / Informational items not in this synthesis.
