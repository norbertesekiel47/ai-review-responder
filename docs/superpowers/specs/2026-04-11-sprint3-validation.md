# Sprint 3 Validation: Architecture & Logic Review

## Summary

Sprint 3 (Prompts 14-16) is architecturally sound. The three prompts cover the right things in the right order: auth + admin UI first, then payments, then hardening. However, there are redundancies with Sprint 2 work already done, sizing concerns with Prompt 14 (too large for one prompt), and a few logical issues that need correction before implementation.

---

## Prompt 14 — Admin Dashboard + Authentication

### What's right

- **Auth-first approach is correct.** Building Supabase Auth before the admin pages ensures every page is protected from day one. The stopgap API key auth from Sprint 1 audit was always temporary.
- **Identity mapping is explicit.** `auth.users.id` → `users.auth_id` is the correct pattern. The plan correctly separates Supabase Auth (identity) from the app `users` table (roles + business scope).
- **Onboarding triggers one initial sync.** This is the right UX — the customer sees their reviews during the sales call, creating an immediate "wow" moment. The ReconciliationPoller correctly skips `pending_payment` businesses for recurring polls.
- **Pagination from the start.** The plan correctly requires pagination on all list views. This prevents the "works at 5 businesses, breaks at 50" problem.
- **ROI baseline NOT captured during onboarding.** Correct — ReviewSyncWorker handles this automatically on first sync when `baseline_captured_at IS NULL`.

### Issues to fix

**1. Prompt 14 is too large for a single prompt (HIGH)**

It bundles 8 distinct deliverables:
- Supabase Auth setup + auth helpers + middleware rewrite
- Login page
- Admin overview page (complex aggregation queries)
- Business detail page (already partially built in Sprint 2)
- Business onboarding form (most complex admin page)
- Costs page
- Notifications page
- Jobs page

This should be split into 2-3 prompts:
- **Prompt 14a:** Supabase Auth + middleware + login + auth helpers
- **Prompt 14b:** Admin pages (overview, costs, notifications, jobs)
- **Prompt 14c:** Business onboarding form + business detail page upgrade

**2. Business detail page already exists (MEDIUM)**

Sprint 2 Prompt 13 already built `src/app/admin/businesses/[id]/page.tsx` with the manual posting workflow (awaiting_manual_post list, copy-to-clipboard, mark-as-posted). Prompt 14 says "Business profile + settings (inline editable) + Review list with color-coded response status" — this needs to EXTEND the existing page, not replace it. The prompt should explicitly say "extend the existing business detail page."

**3. Missing API routes for admin pages (MEDIUM)**

The admin pages need API routes for data fetching, but the prompt only mentions building the pages. The `04-final-plan.md` defines these endpoints:
- `GET /api/admin/businesses` — list with status summary
- `POST /api/admin/businesses` — onboard new business
- `PATCH /api/admin/businesses/:id` — update settings
- `GET /api/admin/overview` — aggregated CRM view
- `GET /api/admin/costs` + `GET /api/admin/costs/alerts`
- `GET /api/admin/jobs`
- `GET /api/admin/notifications`

These should be called out explicitly in the prompt.

**4. Onboarding form needs Stripe customer creation (MEDIUM)**

The prompt says "create business + create user + write sync_reviews outbox entry" but doesn't mention creating a Stripe customer. Prompt 15 later says "Update business onboarding to include Stripe customer creation" — but the onboarding form is built in Prompt 14. Either:
- Add Stripe customer creation to Prompt 14's onboarding form (requires Stripe SDK already set up)
- Or build the onboarding form in Prompt 14 without Stripe, then add it in Prompt 15 (requires revisiting the form)

The second approach is more practical — build the form first, add Stripe after.

**5. Admin route group mismatch (LOW)**

The prompt references `(admin)/*` route group notation, but Sprint 1 audit already changed the admin pages from `(admin)/` (parenthesized route group, invisible in URL) to `admin/` (real route segment, visible in URL at `/admin/*`). The prompt should reference `admin/*` not `(admin)/*`.

### Recommended changes

```
Split into 3 sub-prompts:

Prompt 14a — Auth infrastructure:
- Supabase Auth setup
- src/lib/db/auth.ts helpers
- Rewrite middleware.ts (replace API key with Supabase Auth)
- Login page at /login
- RLS policies or server-only data access

Prompt 14b — Admin pages (read-only):
- /admin/overview (system health + business table)
- /admin/costs (cost breakdown)
- /admin/notifications (delivery log)
- /admin/jobs (outbox + queue health)
- API routes for each page
- Pagination on all list views

Prompt 14c — Business management:
- /admin/businesses/new (onboarding form)
- Extend /admin/businesses/[id] (add profile editing, review list)
- POST /api/admin/businesses (onboard)
- PATCH /api/admin/businesses/:id (update settings)
```

---

## Prompt 15 — Stripe Integration

### What's right

- **Webhook terminates on Railway.** Correct per architecture invariant — Stripe webhooks hit `worker/ingress/stripe.ts` directly, not proxied through Vercel.
- **Deduplication via inbound_events.** Correct — same pattern as Resend webhook handler.
- **Raw body for signature verification.** The Fastify raw-body plugin was set up in Sprint 1 Prompt 3 specifically for this.
- **checkout.session.completed → active.** This is the key transition that unlocks recurring polling by the ReconciliationPoller.
- **Payment Links instead of in-app checkout.** Correct for MVP — zero frontend code needed. The sales partner just sends a link after the onboarding call.

### Issues to fix

**1. Missing Stripe customer_id linkage in webhook handler (MEDIUM)**

The `checkout.session.completed` handler needs to extract `customer` from the session object and update `businesses.stripe_customer_id` and `businesses.stripe_subscription_id`. The prompt mentions setting `subscription_status='active'` but doesn't specify HOW to link the Stripe session to the business. Options:
- Use `client_reference_id` in the Payment Link (set to business_id during onboarding)
- Or use `customer_email` to match against `businesses.owner_email`

The `client_reference_id` approach is more reliable. The onboarding form should generate the Payment Link URL with `?client_reference_id={business_id}`.

**2. Missing subscription lifecycle events (LOW)**

The prompt handles 4 events but misses `invoice.paid` (confirms recurring payment succeeded — important for `past_due` → `active` recovery). Add:
- `invoice.paid` → if `subscription_status = 'past_due'`, set back to `active`

### Recommended changes

```
Add to Prompt 15:
- Specify client_reference_id linkage strategy
- Add invoice.paid handler for past_due recovery
- Onboarding form sets client_reference_id on Payment Link URL
```

---

## Prompt 16 — Security Hardening

### What's right

- **Security headers.** HSTS, CSP, X-Frame-Options, X-Content-Type-Options are all correct for the approval page which renders user-generated review text.
- **Sentry with beforeSend scrubbing.** Correct — API keys and tokens must never reach Sentry.
- **Webhook signature verification.** Both Stripe and Resend handlers are correctly specified.

### Issues — significant redundancy with Sprint 2

**1. Rate limiting already implemented (ALREADY DONE)**

Sprint 2 already added `checkRateLimit` to:
- All 4 POST approval routes (3 per token per minute, using SHA-256 of token as key)
- GET approval route (10 per IP per minute)

The regeneration budget (`checkRegenBudget`, max 3 per review per day) is already enforced in `ResponseGeneratorWorker`.

The only item NOT yet done: rate limiting on `/api/admin/demos/generate` (50 per day).

**2. CSRF already implemented (ALREADY DONE)**

Sprint 2 already built CSRF double-submit pattern in `src/lib/approval/cookies.ts`:
- `setCsrfCookie()` on GET
- `validateCsrf()` on all POST routes

**3. Audit logging already implemented (ALREADY DONE)**

Sprint 2 already logs all approval actions to `approval_audit_log` with token_hash, device_cookie_hash, action, ip_address, metadata.

**4. Input sanitization already implemented (ALREADY DONE)**

Sprint 2 already has:
- `sanitizeText()` in `src/lib/shared/sanitize.ts` (strips control chars, null bytes)
- `escapeHtml()` in `src/lib/shared/html.ts` (used in all email templates)
- `ResponseGeneratorWorker` sanitizes review text before passing to LLM

**5. Resend webhook verification already implemented (ALREADY DONE)**

Sprint 2 already built svix signature verification in `worker/ingress/resend.ts`.

### What's actually new in Prompt 16

After removing the redundancies, Prompt 16 reduces to:
1. **Sentry setup** (new — not built yet)
2. **Security headers** in next.config.mjs and Fastify (new)
3. **Rate limiting on demo generation** endpoint (new — the only endpoint missing rate limiting)
4. **Stripe webhook signature verification** (new — the placeholder needs the real handler)
5. **Zod schemas for business settings inputs** (new — onboarding form validation)

### Recommended changes

```
Rewrite Prompt 16 to remove redundant items and focus on what's new:

Prompt 16 (revised) — Sentry + security headers + remaining hardening:
1. Sentry setup (Next.js + Railway worker, beforeSend scrubbing)
2. Security headers (HSTS, CSP, X-Frame-Options, nosniff) in next.config.mjs
3. Rate limit on /api/admin/demos/generate (50/day)
4. Zod validation schemas for business onboarding form inputs
5. DOMPurify for rendering review text in approval page (defense-in-depth)

Remove from Prompt 16 (already done in Sprint 2):
- Approval route rate limiting ✅
- CSRF protection ✅
- Audit logging ✅
- Review text sanitization in worker ✅
- Resend webhook verification ✅
```

---

## Cross-Sprint Dependency Issues

**1. Stripe webhook handler blocks on Prompt 14's onboarding form**

The Stripe `checkout.session.completed` handler needs to link to a business. If the onboarding form doesn't exist yet when Prompt 15 runs, there's no business to link to. The current prompt order (14 → 15) is correct, but the onboarding form MUST be complete before testing Stripe end-to-end.

**2. The admin business detail page has two authors**

Sprint 2 Prompt 13 built the manual-posting version. Sprint 3 Prompt 14 wants to extend it with profile editing and review lists. The prompt should explicitly reference "extend the existing page at `src/app/admin/businesses/[id]/page.tsx`" rather than implying a rebuild.

**3. WeeklySummaryWorker is referenced in Sprint 3 done-when but not built until Sprint 4**

The Sprint 3 done-when checklist doesn't mention weekly summaries, which is correct. But the `workers` array in `worker/index.ts` doesn't include a WeeklySummaryWorker yet — this is fine for Sprint 3 but should be noted.

---

## Final Assessment

Sprint 3 is architecturally sound and follows the right sequence. The main optimizations:

1. **Split Prompt 14** into 3 sub-prompts (auth, read-only admin pages, business management) — it's too large for one prompt and will produce better results in smaller pieces
2. **Remove redundancies from Prompt 16** — 5 of 7 items are already done from Sprint 2
3. **Add client_reference_id strategy to Prompt 15** — needed to link Stripe sessions to businesses
4. **Add invoice.paid handler to Prompt 15** — needed for past_due recovery
5. **Reference existing Sprint 2 code** — Prompt 14 should extend, not replace, the existing business detail page

No architectural changes needed. The invariants (Vercel = UI only, transactional outbox, webhook termination on Railway, no auto-posting) are preserved throughout Sprint 3.
