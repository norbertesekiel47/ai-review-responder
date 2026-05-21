# Owner Self-Serve Signup + Auth — Design Spec

_Design spec — RepWorth MVP — 2026-04-23_

## Goal

Let a prospective business owner sign up for RepWorth directly from the public landing page, pay via Stripe, confirm their email, and log in to their dashboard — without any sales-partner involvement. Today the only way a business gets into the system is through the admin onboarding form at `/admin/businesses/new`, and the resulting `users` row has no Supabase Auth credential, so owners cannot actually log in.

## Problem context

**Today:**

- `/admin/login` is the only login page. It's branded "RepWorth Admin" and is used only by staff.
- Onboarding is admin-only: sales partner fills `/admin/businesses/new` → `POST /api/admin/businesses` creates `businesses` (subscription_status='pending_payment') + `users` (role='owner', auth_id=NULL) + an email channel enrollment + a sync outbox entry in one transaction.
- Owners cannot log in because `users.auth_id` is never populated and no Supabase Auth credential exists.
- Admin/sales_partner Supabase Auth users are created manually in the Supabase dashboard, with `users.auth_id` wired up by hand.
- Stripe integration uses pre-built Payment Links (`STRIPE_PAYMENT_LINK_FOUNDING` / `STRIPE_PAYMENT_LINK_STANDARD`). The admin form builds a URL with `client_reference_id=businessId` and `prefilled_email=ownerEmail`. `worker/ingress/stripe.ts` flips `subscription_status` to `'active'` on `checkout.session.completed`.
- The middleware at `src/middleware.ts` already enforces role-based access: `/admin/*` → admin/sales_partner, `/dashboard` + `/settings` → owner + `business_id`.

**Constraint: admin onboarding stays unchanged.** Admin auth users continue to be created manually in Supabase. The admin onboarding form does NOT get a password field. This spec adds a parallel self-serve flow; it does not rework the admin flow.

## Decisions

| #   | Question                                                 | Decision                                                                                                             |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Admin onboarding — add password field?                   | **No.** Leave as-is. Admin auth users created manually in Supabase dashboard.                                        |
| 2   | Keep `/admin/login` or merge into `/login`?              | **Keep `/admin/login`.** Staff-only URL; not linked from the public site.                                            |
| 3   | Tier selection on signup form?                           | **Yes.** Radio group on the signup form (founding / standard).                                                       |
| 4   | Email confirmation step?                                 | **Yes.** Placed **before** payment — catches typo'd emails before money changes hands.                               |
| 5   | Social login (Google)?                                   | **Yes.** Two-phase signup: Google OAuth → return to a "finish your profile" form for the remaining business fields.  |
| 6   | Separate "owner forgot password" vs "admin"?             | **Yes — two URLs, same Supabase backend, role-appropriate `redirectTo`.** Single shared Supabase email template.     |

---

## 1. Architecture overview

The self-serve signup flow adds a public signup path, an email-confirm gate, and a payment gate on top of the existing business-creation transaction and Stripe webhook. The core invariants are preserved:

- **Single source of truth for business activation:** `businesses.subscription_status='active'` is flipped only by the Stripe webhook (`worker/ingress/stripe.ts`). This spec does not touch that.
- **Single source of truth for onboarding atomicity:** the tx that inserts `businesses` + `users` + `channel_enrollments` runs inside one `sql.begin`. This spec extracts that tx into a shared helper so both the admin route and the new self-serve routes use it identically.
- **Auth scope stays app-enforced:** `users.auth_id` maps to Supabase Auth. Every owner read/write is scoped by `business_id`. RLS `users_self_select` policy (migration 006) lets the cookie-bound anon client read the caller's own `users` row, but there is **no equivalent owner-scoped policy on `businesses`** today — owner reads of business data go through server routes that use the service-role `sql` client with explicit `auth_id` scoping (matching the existing `/api/dashboard/route.ts` pattern). This spec follows that pattern; it does not add new RLS policies.
- **No pre-payment SerpAPI/LLM spend on self-serve.** The admin onboarding flow enqueues an initial sync at signup time (deliberate — it powers the demo drafts a sales partner shows during the call). Self-serve signups are different: there is no sales call to demo to, and a malicious or abandoned signup would otherwise burn SerpAPI quota + LLM budget for free. The shared `createBusinessTx` helper enqueues the initial sync **only** when `onboardedBy !== null` (admin path). Self-serve signups defer the first sync; the **Stripe webhook enqueues it on `checkout.session.completed`** instead, gated by an idempotent INSERT against `job_outbox` so duplicate webhook deliveries do not stack syncs.

### 1.1 The two signup paths

**Password signup (primary):**

```
[Landing nav] → "Sign up" → /signup
[/signup]  email + password + name + phone + business name + Google Maps URL
           + voice context + tier radio + "Continue with Google" button
   ↓ submit
[POST /api/auth/signup]
   • supabase.auth.signUp({ email, password, options: {
       emailRedirectTo: APP_URL + '/api/auth/callback?flow=owner&next=/onboarding/pay'
     } })
     → creates auth.users row (unconfirmed), sends confirmation email
   • createBusinessTx(input, { mode: 'self_serve', authId: newAuthUserId })
     → one sql.begin: businesses (pending_payment) + users (auth_id set) + email enrollment
     → NO outbox entry — first sync is deferred until Stripe activation (see §1.6)
   • Redirect to /signup/check-email
[/signup/check-email]  "Check your inbox to confirm your email"
   ↓ owner clicks confirmation link
[GET /api/auth/callback?code=...&flow=owner&next=/onboarding/pay]
   • exchangeCodeForSession → session cookie set
   • Route by users.auth_id → users row exists → role='owner' → redirect to next=/onboarding/pay
   • On any failure: redirect to owner-branded /login (flow=owner discriminator)
[/onboarding/pay]  "Welcome! Click to complete your payment"
   → Stripe Payment Link (existing STRIPE_PAYMENT_LINK_<TIER> + client_reference_id + prefilled_email)
   ↓ owner pays on Stripe-hosted checkout
[Stripe] → /ingress/stripe (Railway — EXTENDED, see §1.6)
           flips subscription_status='active' via webhook
           AND enqueues initial validate_place_id or sync_reviews
           (idempotent — pg_advisory_xact_lock per business id +
            WHERE NOT EXISTS check against job_outbox; matches existing
            MonthlyImpactScheduler / WeeklySummaryScheduler pattern)
[Stripe success_url] → /onboarding/payment-success?session_id=cs_...
   • Polls /api/auth/signup-status every 2s (exponential backoff, max 30s)
   • Once subscription_status='active', shows "Go to dashboard" CTA
[/dashboard]  fully unlocked
```

**Google signup (secondary):**

```
[/signup] → "Continue with Google" button
   ↓ supabase.auth.signInWithOAuth({ provider: 'google',
       options: { redirectTo: APP_URL + '/api/auth/callback?flow=owner&next=/signup/finish' } })
[Google OAuth screen] → back to /api/auth/callback?code=...&flow=owner&next=/signup/finish
   • exchangeCodeForSession → session cookie set (Google-verified email = auto-confirmed)
   • Callback detects: auth.users exists, but no users row yet → redirect to /signup/finish
[/signup/finish]  pre-filled name + email (disabled) from session
   + phone + business name + Google Maps URL + voice context + tier radio
   ↓ submit
[POST /api/auth/finish-signup]  (cookie-authenticated; Origin header check)
   • createBusinessTx(input, { mode: 'self_serve', authId: session.user.id })
   • Redirect to /onboarding/pay  ← skips /signup/check-email (email already Google-verified)
   ↓ same as password path from /onboarding/pay onwards
```

### 1.2 The login side

```
[Landing nav] → "Log In" → /login  (RepWorth consumer brand, new)
[/login]  email + password form + "Continue with Google" button + "Forgot password?" link
   ↓ password flow: supabase.auth.signInWithPassword → session cookie
   ↓ Google flow: supabase.auth.signInWithOAuth → /api/auth/callback → session cookie
[Role routing after login]
   • role='owner'
       AND subscription_status='active'         → /dashboard
       AND subscription_status='pending_payment'
         AND email_confirmed_at IS NOT NULL     → /onboarding/pay
       AND email_confirmed_at IS NULL           → /signup/check-email
   • role='admin' OR 'sales_partner'            → /login shows "wrong portal, use /admin/login"
                                                  (signOut, redirect)
   • no users row, unknown role                 → signOut, show "account not set up" error
```

`/admin/login` stays unchanged. Staff URL, not linked from public site. Non-staff role submitted to `/admin/login` → signOut + "wrong portal, use /login" (inverse of the owner branch above).

**Role lookup client invariant:** the role read on both `/login` and `/admin/login` MUST use the browser anon Supabase client (the existing `createBrowserSupabaseClient()` from `src/lib/db/browser.ts`) and rely on the `users_self_select` RLS policy from migration 006. Service-role MUST NOT appear in any browser-rendered code path. The current `/admin/login` page already follows this pattern (`src/app/admin/login/page.tsx:81-87`) — the new `/login` page does the same. The middleware-side service-role usage was already removed in a separate fix (now uses cookie-bound anon + RLS); these client-side login pages must not reintroduce it.

**Email-not-confirmed login UX.** When an owner whose `auth.users.email_confirmed_at IS NULL` attempts password login on `/login`, Supabase's `signInWithPassword` returns the error message `Email not confirmed`. The login form MUST detect this specific error and route the user to `/signup/check-email?from=login` rather than displaying the raw error. Without this branch, owners see a generic "Invalid credentials" which is misleading — the credentials are valid, the email simply isn't confirmed yet. The check-email page reads the `from=login` query param and adjusts copy: "Almost there — confirm your email at [masked address] to log in." Same handling on `/admin/login` is unnecessary because admin auth users are created manually with `email_confirm: true` per existing convention.

### 1.3 Forgot password — two URLs, one Supabase backend

| URL | `redirectTo` param passed to Supabase | Used by |
|-----|---------------------------------------|---------|
| `/forgot-password` | `APP_URL + '/api/auth/callback?flow=owner&next=/reset-password'` | owners |
| `/admin/forgot-password` | `APP_URL + '/api/auth/callback?flow=admin&next=/admin/reset-password'` | admin / sales_partner |

`redirectTo` MUST point at `/api/auth/callback` (not directly at the reset page) so the existing callback handler exchanges Supabase's recovery code for a session BEFORE the user lands on the reset page. The reset page reads the established session and accepts the new password (§3.6). See §3.4 for the full contract — server-side cross-portal protection ensures owners can't trigger admin-branded links and vice versa.

Both forms POST to a single handler that calls `supabase.auth.resetPasswordForEmail(email, { redirectTo })` only after the role matches. Both return the same generic response regardless of whether the email matches an account ("If an account exists for that email, we've sent a reset link") — no user-enumeration leak. Supabase's default email template is shared; migrating to Resend-sent custom templates is out of scope for this spec.

### 1.4 Dashboard payment-pending state

Two coupled changes — both client AND server enforce the gate, because client-only hiding still ships sensitive owner data over the wire:

**Server side** (`src/app/api/dashboard/route.ts`): branch on `business.subscription_status` early. For `pending_payment`, return a minimal payload — `{ businessId, businessName, subscriptionStatus, paymentUrl }` and nothing else. Skip the 8-query `Promise.all` block entirely. This prevents an owner who somehow bypasses the client-side hiding (devtools, cached page, etc.) from seeing review data, ranking history, or any other dashboard content for an unpaid account.

The `paymentUrl` cannot be built inline in this route — the existing payment-link builder is in `src/app/api/admin/businesses/route.ts:105` (`buildPaymentLinkUrl(tier, businessId, ownerEmail)`). To avoid duplicating logic across signup, admin onboarding, and dashboard, this spec extracts it into `src/lib/payments/payment-link.ts` (new file). All three callers import from there. No behavior change to the existing admin path beyond the import swap.

**Client side** (`src/app/(authenticated)/dashboard/.../page.tsx`): when the API returns a minimal payload, render only the banner card linking to the Stripe Payment Link:

> **Your subscription isn't active yet.** Complete your payment to unlock automated review responses. → `[Pay now]`

When the Stripe webhook flips status to `active`, the client polls or the user refreshes; the API returns the full payload and the normal dashboard renders.

Note: `subscription_guard` (`src/lib/shared/subscription-guard.ts`) explicitly **allows** the generator worker to run for `pending_payment` businesses (the comment there says "admin-visible demo drafts"). For self-serve, that allowance does not become a problem because we never enqueue the initial sync until activation (§1.6) — there is no triggering event that would drive the generator. The dashboard hides content because there's no content to show, not because workers are blocked from creating it.

For `past_due` (existing customers, separate flow): banner copy branches to "update payment method" linking to the Stripe customer portal — out of scope for this spec but documented for the implementation plan.

### 1.5 Abandoned-signup cleanup

A new interval-driven poller (matching the repo's existing `*Poller.ts` pattern — `NotificationFailoverPoller`, `ArchivalPoller`, etc.) removes dormant rows to keep the `users.email` unique constraint from permanently blocking re-signup attempts:

- `CleanupAbandonedSignupsPoller` — exported as `startCleanupAbandonedSignupsPoller()` from `worker/jobs/CleanupAbandonedSignupsPoller.ts`. Registered from `worker/index.ts` only when `SELF_SERVE_SIGNUP_ENABLED === 'true'`. Default interval `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS = 86_400_000` (24h); env-overridable. Default per-run batch size `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE = 100`; env-overridable so an unexpected ramp in abandon rate can be cleared without a code deploy. No new BullMQ queue.
- **Cleanup is scoped to self-serve only** using the combined `onboarded_by IS NULL AND auth_id IS NOT NULL` predicate (see §1.6 "Background — discriminator integrity" for the full rationale). Admin-onboarded businesses (sales partner fills the form, sends owner the Payment Link) sit in `pending_payment` with no `stripe_customer_id` for as long as the owner takes to pay — sometimes weeks. Deleting those would cause real production data loss.
- Selection query (uses the partial indexes from §2.2 — `idx_businesses_pending_unpaid_self_serve_cleanup` covers the businesses scan; `idx_users_owner_auth_by_business` covers the join):
  ```sql
  SELECT b.id AS business_id, u.id AS user_id, b.owner_email, u.auth_id
  FROM businesses b
  JOIN users u ON u.business_id = b.id AND u.role = 'owner'
  WHERE b.subscription_status = 'pending_payment'
    AND b.stripe_customer_id IS NULL
    AND b.onboarded_by IS NULL
    AND u.auth_id IS NOT NULL
    AND b.created_at < NOW() - INTERVAL '7 days'
  LIMIT ${CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE}
  ```
- The `u.auth_id IS NOT NULL` guard is belt-and-suspenders — self-serve always sets `auth_id` at signup, but a defensive predicate prevents the cleanup from ever touching an admin-style row that somehow has `onboarded_by=NULL`.
- **Important — `users.business_id` FK does NOT cascade.** Migration 001 line 111 defines `fk_users_business` without `ON DELETE CASCADE`. A naïve `DELETE FROM businesses WHERE id = ?` would fail with a foreign-key violation while the owner `users` row exists. The cleanup must delete the `users` row FIRST, then the `businesses` row, both inside one DB transaction so a failure between deletes doesn't leave a half-cleaned state. This spec does NOT add `ON DELETE CASCADE` to the FK because that would silently weaken protection against accidental business deletes from any future code path; cleanup is the only intentional deletion path and it can be explicit.
- For each match, run inside `sql.begin`. The tx is bracketed by an advisory lock keyed on the email hash so a concurrent re-signup attempt from the same owner serializes against the cleanup instead of seeing a "row exists then doesn't" flicker:
  1. **Take advisory lock + safety check.** Two pre-conditions before any delete:
     ```ts
     await tx`SELECT pg_advisory_xact_lock(hashtext(${owner_email} || ':signup'))`;

     // Defense against future invariant changes: owner users rows must NOT
     // be referenced by businesses.onboarded_by or prospect_demos.created_by.
     // For self-serve owners this is true by construction (role='owner', not
     // an admin/sales_partner who would appear in those columns). If the
     // invariant ever changes, fail loudly here rather than throwing FK
     // errors mid-batch.
     const [refs] = await tx<{ has_onboarded: boolean; has_demos: boolean }[]>`
       SELECT
         EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${user_id}) AS has_onboarded,
         EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${user_id}) AS has_demos
     `;
     if (refs.has_onboarded || refs.has_demos) {
       logger.warn(
         `[cleanup] Skipping ${user_id} — referenced by businesses.onboarded_by or prospect_demos.created_by (invariant violation; investigate)`,
       );
       return; // skip this candidate; tx auto-rolls back, lock releases
     }
     ```
  2. `supabaseServer.auth.admin.deleteUser(auth_id)` (service-role client from `src/lib/db/server.ts`). Failure handling per Supabase response:
     - **Success** → proceed.
     - **404 / "user not found"** → treat as success and proceed. This handles the case where a previous poll succeeded at the Supabase delete but the DB delete failed; without this branch the business row would be stuck forever (next poll sees "user not found" and skips).
     - **Any other error** → log a warning with correlation id, ROLLBACK the tx (no partial cleanup; advisory lock releases on rollback), continue to the next candidate. Orphan-business is recoverable on a future poll; orphan-auth-user is not.
  3. `DELETE FROM users WHERE id = ${user_id}` — explicit, since the FK doesn't cascade.
  4. `DELETE FROM businesses WHERE id = ${business_id}` — `channel_enrollments`, `responses`, `reviews`, etc. all have `ON DELETE CASCADE` on the businesses FK, so they go away automatically.
  5. Commit. If steps 3 or 4 throw, the tx rolls back and the auth-user-already-deleted state will be picked up on the next poll's 404 branch.

The advisory lock on `hashtext(owner_email || ':signup')` is namespaced disjoint from the activation lock (`hashtext(business_id || ':activation')` in §1.6) — different qualifier suffix, different key shape (email vs business_id). A `POST /api/auth/signup` for the same owner_email takes the same lock at its own pre-check (§3.1 — see "Concurrent re-signup serialization" addition there) so cleanup-vs-resignup race resolves cleanly: whichever holds the lock finishes first, the loser sees consistent post-state.
- 7 days chosen so an owner who signs up Friday and pays Monday is not cleaned up mid-flow.
- Each run logs counts (candidates / deleted / supabase-failed) so admin observability surfaces ramp-up problems.

### 1.6 Stripe activation extended — enqueue initial sync

Today `worker/ingress/stripe.ts` `processCheckoutSessionCompleted` only updates `subscription_status` + `stripe_customer_id` + `stripe_subscription_id`. With self-serve deferring the initial sync, the webhook becomes responsible for kicking off the first review fetch on payment success. Without this change, paid self-serve businesses would sit waiting for `ReconciliationPoller` to pick them up on its next 60-min cycle, OR (for unverified Place IDs) never start at all because the reconciliation poller only handles `validate_place_id` indirectly.

**Background — discriminator integrity (combined predicate):**

Self-serve signup needs an unambiguous "is this a self-serve business?" predicate, used by both this webhook (§1.6) and the cleanup poller (§1.5). Two facts must be true together:

- `businesses.onboarded_by IS NULL` — admin onboarding populates this with the requesting admin's user id (NEW behavior — see "Admin onboarding update" below). Self-serve always leaves it NULL.
- `users.auth_id IS NOT NULL` (joined on the owner row) — self-serve always sets this at signup time. Admin onboarding leaves it NULL because admin auth users are created manually in the Supabase dashboard later.

Either predicate alone is insufficient. `onboarded_by IS NULL` alone matches legacy admin businesses (the column was never previously populated). `auth_id IS NOT NULL` alone matches admin businesses whose admins later linked an auth user via the dashboard. Combined they uniquely identify self-serve, and the answer is stable over time (auth_id can later be added to admin rows for login, but those rows still have `onboarded_by` set).

**Admin onboarding update (small, behavior-preserving):**

`POST /api/admin/businesses` is updated to populate `businesses.onboarded_by` from the authenticated admin's `users.id` (read via the existing `requireRole` path). No other admin behavior changes.

A one-time backfill runs as part of migration 025, **gated by a precondition that fails the migration loudly if no eligible admin/sales user exists** (otherwise the placeholder subquery returns NULL and the backfill silently does nothing, leaving the discriminator broken):

```sql
DO $$
DECLARE
  placeholder_admin_id UUID;
  affected_businesses INTEGER;
BEGIN
  SELECT id INTO placeholder_admin_id
  FROM users
  WHERE role IN ('admin', 'sales_partner')
  ORDER BY created_at
  LIMIT 1;

  -- Count businesses that would need backfill
  SELECT COUNT(*) INTO affected_businesses
  FROM businesses
  WHERE onboarded_by IS NULL;

  IF affected_businesses > 0 AND placeholder_admin_id IS NULL THEN
    RAISE EXCEPTION
      'Cannot backfill onboarded_by: % business(es) need a value but no users.role IN (admin, sales_partner) exist. Create an admin user first, then re-run.',
      affected_businesses;
  END IF;

  IF placeholder_admin_id IS NOT NULL THEN
    UPDATE businesses SET onboarded_by = placeholder_admin_id WHERE onboarded_by IS NULL;
  END IF;
END $$;
```

The placeholder admin id is informational — the column's purpose is "non-NULL = admin-created", not auditing who specifically. Operators who want a more accurate backfill (e.g., per-business attribution) can edit the SQL before running. After the backfill, `onboarded_by IS NULL` is a reliable self-serve signal for all future inserts.

**Extension to `processCheckoutSessionCompleted`:**

1. **Scope to self-serve only**, using the combined predicate above:
   ```sql
   AND EXISTS (
     SELECT 1 FROM businesses b
     JOIN users u ON u.business_id = b.id AND u.role = 'owner'
     WHERE b.id = ${businessId}
       AND b.onboarded_by IS NULL
       AND u.auth_id IS NOT NULL
   )
   ```
2. **Transition-gated, not state-gated.** The enqueue must fire ONLY on the actual `pending_payment → active` transition, not whenever the business happens to be `pending_payment` or whenever a webhook fires for an already-active business. Without this gate, edge cases would re-enqueue an "initial" sync:
   - A self-serve business that went `pending_payment → active → past_due → active` would re-enqueue if its original sync row had been archived out of the non-terminal status set.
   - A duplicate `checkout.session.completed` (already-active business, fresh webhook delivery that slipped past `inbound_events` dedup) would re-enqueue.
   The fix is to capture the OLD status under `FOR UPDATE` lock, perform the UPDATE, and gate the enqueue on `oldStatus === 'pending_payment'`. Past-due recovery (`past_due → active`) is update-only — no enqueue. Already-active webhook (`active → active`) is no-op.

3. **Idempotency** — `WHERE NOT EXISTS` over the non-terminal status set (`'pending', 'dispatching', 'dispatched'`) is defense-in-depth on top of the transition gate, in case two concurrent `pending_payment → active` transitions race past the lock. Pattern matches `MonthlyImpactScheduler` / `WeeklySummaryScheduler`.

4. **Concurrent-webhook race protection.** Stripe delivers webhooks at-least-once. Even though `inbound_events.external_event_key` deduplicates retries of the same event, two DIFFERENT Stripe events for the same business arriving close together (e.g., `checkout.session.completed` + `customer.subscription.updated`) could both run and both observe "old status was pending_payment" if neither has committed yet → double-insert. The entire activation block runs inside a `sql.begin` transaction that takes a Postgres advisory lock keyed by business id BEFORE the FOR UPDATE read:

   ```ts
   await sql.begin(async (tx) => {
     // Serialize concurrent activation tx for the same business. Tx-scoped
     // lock auto-releases on commit/rollback. hashtext(...) keeps the lock
     // space disjoint from any other code path; ':activation' suffix
     // qualifies further.
     await tx`SELECT pg_advisory_xact_lock(hashtext(${businessId} || ':activation'))`;

     // Capture old status under FOR UPDATE so concurrent tx serialize.
     // google_maps_url is needed below to build a valid ValidatePlaceIdPayload
     // when the owner provided a URL instead of a verified place id at signup.
     const [bizRow] = await tx<{
       subscription_status: string;
       google_place_id: string | null;
       google_maps_url: string | null;
       place_id_verified: boolean;
     }[]>`
       SELECT subscription_status, google_place_id, google_maps_url, place_id_verified
       FROM businesses
       WHERE id = ${businessId}
       FOR UPDATE
     `;
     if (!bizRow) return; // Business deleted between webhook and tx start — no-op.

     const oldStatus = bizRow.subscription_status;

     // Existing activation UPDATE (unchanged behavior).
     await tx`
       UPDATE businesses
       SET subscription_status = 'active',
           stripe_customer_id = ${customerId},
           stripe_subscription_id = ${subscriptionId},
           subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
           updated_at = NOW()
       WHERE id = ${businessId}
         AND subscription_status IN ('pending_payment', 'past_due')
     `;

     // Transition gate: only enqueue on pending_payment → active.
     // past_due → active is intentionally update-only (existing customer
     // recovery — they already have an active sync history).
     // active → active (duplicate webhook) is no-op for the enqueue.
     if (oldStatus !== 'pending_payment') return;

     // Build the topic + payload explicitly. Each topic has a distinct
     // payload shape per src/lib/shared/worker-types.ts.
     const correlationId = uuidv7();
     let topic: 'sync_reviews' | 'validate_place_id';
     let payload: SyncReviewsPayload | ValidatePlaceIdPayload;

     if (bizRow.place_id_verified && bizRow.google_place_id) {
       topic = 'sync_reviews';
       payload = {
         business_id: businessId,
         google_place_id: bizRow.google_place_id,
         correlation_id: correlationId,
       };
     } else if (bizRow.google_maps_url) {
       topic = 'validate_place_id';
       payload = {
         business_id: businessId,
         google_maps_url: bizRow.google_maps_url,
         correlation_id: correlationId,
       };
     } else {
       // Defensive: self-serve `SignupSchema` requires one of (verified placeId,
       // googleMapsUrl) via the existing XOR refine, and `createBusinessTx`
       // persists both into businesses. Reaching this branch can only happen
       // via direct DB tampering or a future code path that nulls the columns
       // — neither in scope today. Log loudly and skip the enqueue rather than
       // producing a malformed outbox row. Activation already succeeded; admin
       // can manually requeue once the row is fixed.
       console.error(
         `[stripe-activation] business ${businessId} has neither verified place_id nor google_maps_url; skipping initial sync enqueue. correlation=${correlationId}`,
       );
       return;
     }

     // Self-serve scope check + non-terminal-row dedup.
     await tx`
       INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
       SELECT
         ${uuidv7()},
         ${topic},
         'business',
         ${businessId},
         ${jsonb(payload)},
         'pending'
       WHERE NOT EXISTS (
         SELECT 1 FROM job_outbox jo
         WHERE jo.aggregate_id = ${businessId}
           AND jo.topic IN ('sync_reviews', 'validate_place_id')
           AND jo.status IN ('pending', 'dispatching', 'dispatched')
       )
       AND EXISTS (
         SELECT 1 FROM businesses b
         JOIN users u ON u.business_id = b.id AND u.role = 'owner'
         WHERE b.id = ${businessId}
           AND b.onboarded_by IS NULL
           AND u.auth_id IS NOT NULL
       )
     `;
   });
   ```

5. **Test coverage for transition-gated enqueue** (`worker/__tests__/stripe-activation-enqueue.test.ts`):
   - `pending_payment → active` for self-serve with `place_id_verified=true` + `google_place_id` set → enqueue `sync_reviews` with `{ business_id, google_place_id, correlation_id }`.
   - `pending_payment → active` for self-serve with `place_id_verified=false` + `google_maps_url` set → enqueue `validate_place_id` with `{ business_id, google_maps_url, correlation_id }`. **Asserts the payload includes `google_maps_url` and matches `ValidatePlaceIdPayload`** — this is the regression guard for the persisted-URL path.
   - `pending_payment → active` for self-serve with neither verified place_id nor `google_maps_url` (data-integrity defense) → no enqueue, error logged.
   - `pending_payment → active` for admin-onboarded business → no enqueue (scope predicate blocks).
   - `past_due → active` for self-serve → update only, no enqueue (transition gate blocks).
   - `active → active` (duplicate webhook delivery) → no UPDATE row count, no enqueue.
   - `pending_payment → active` for self-serve with an existing in-flight sync row → no duplicate enqueue (defense-in-depth).
   - Concurrent `pending_payment → active` from two webhook events for the same business → second tx sees `oldStatus='active'` after waiting on the advisory lock → no enqueue.

---

## 2. Data model

### 2.1 No new tables, one migration for indexes

Two onboarding paths now write the same atomic tx with one critical difference in `job_outbox` behavior:

- **Admin path** (`POST /api/admin/businesses` → `createBusinessTx(input, { mode: 'admin', onboardedBy: <adminId> })`) — inserts `businesses` + `users` + `channel_enrollments` **+ `job_outbox` (sync_reviews or validate_place_id)** in one `sql.begin`. Behavior unchanged from today.
- **Self-serve path** (`POST /api/auth/signup` and `POST /api/auth/finish-signup` → `createBusinessTx(input, { mode: 'self_serve', authId: <newAuthUserId> })`) — inserts `businesses` + `users` + `channel_enrollments` in one `sql.begin`. **No `job_outbox` row.** The Stripe webhook (§1.6) inserts the initial sync row on `checkout.session.completed`.

The existing schema already supports everything:

- `users.auth_id VARCHAR(255) NULL` — populated for self-serve signups (stays NULL for admin-only-created owners, which this spec leaves untouched).
- `businesses.subscription_status` — the existing `'pending_payment' | 'active' | 'past_due' | 'cancelled'` enum. No new states.
- `businesses.stripe_customer_id` / `businesses.stripe_subscription_id` — populated by the webhook on payment, unchanged.
- `channel_enrollments` — the signup flow inserts the owner's email as a verified email channel row, same as admin onboarding today.
- `job_outbox` — for the **admin path**, the sync_reviews or validate_place_id entry is inserted in the same `createBusinessTx`. For the **self-serve path**, no entry is inserted at signup — the Stripe webhook (§1.6) inserts it on `checkout.session.completed`.

### 2.2 Migration 025 — two indexes, no new tables

| Index                                                      | Purpose                                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idx_businesses_pending_unpaid_self_serve_cleanup`         | Partial: `(created_at) WHERE subscription_status='pending_payment' AND stripe_customer_id IS NULL AND onboarded_by IS NULL`. Covers the businesses-side scan in the cleanup poller's WHERE clause. The query still has to join `users` for the `auth_id IS NOT NULL` check + the explicit user-row delete; that join is covered by the second index below. **Implementation plan must run `EXPLAIN ANALYZE` on the cleanup query against a populated dev DB to confirm the planner picks this index** — Postgres sometimes prefers a sequential scan for small partial-index targets, in which case adding `INCLUDE (id, owner_email)` for an index-only scan may be warranted. |
| `idx_users_owner_auth_by_business`                         | Partial: `(business_id) WHERE role = 'owner' AND auth_id IS NOT NULL`. Speeds the cleanup join (and the dashboard payment-status path that also joins users by business_id). No prior index exists on `users(business_id)` — Postgres does not auto-index FK columns — so without this index the join would fall back to a sequential scan as the table grows. |

**No new column needed — `businesses.google_maps_url` already exists** from migration 007 (`007_place_id_verification.sql:5`), and the admin route already persists it on every insert (`src/app/api/admin/businesses/route.ts:191,210`). The webhook (§1.6) reads this existing column to build a valid `ValidatePlaceIdPayload` (`{ business_id, google_maps_url, correlation_id }` per `src/lib/shared/worker-types.ts:54`) hours or days after signup. The behavior change introduced by this spec is purely on the call-site side: `createBusinessTx` writes `input.googleMapsUrl ?? NULL` on every insert, matching what the admin route already does inline today. Self-serve writes via the same code path. Column stays NULL when the owner provided a verified `googlePlaceId` instead of a URL.

**`google_maps_url` is intentionally NOT cleared after `PlaceIdValidationWorker` resolves it** (`worker/jobs/PlaceIdValidationWorker.ts` sets `place_id_verified=TRUE` + populates `google_place_id` but leaves `google_maps_url` as audit trail of the original URL the owner submitted). Future code reading this column for routing decisions MUST check `place_id_verified` first — a row with `place_id_verified=TRUE` AND non-NULL `google_maps_url` represents a successfully-resolved business, not a re-resolution candidate. The webhook at §1.6 already follows this rule (resolves `place_id_verified && google_place_id` first, falls through to `google_maps_url` only when verification is incomplete).

**No global `(aggregate_id, topic)` unique index on `job_outbox`.** An earlier draft proposed one to back an `ON CONFLICT` in the Stripe webhook, but several existing schedulers intentionally insert multiple non-terminal rows per `(aggregate_id, topic)` pair distinguished by payload dimensions:
- `MonthlyImpactScheduler` — same business + `'send_monthly_impact'`, distinct `payload->>'month_start_date'`
- `OnboardingDripScheduler` — same business + `'onboarding_drip'`, three drip events distinguished by `drip_type`
- `RankingTrackingScheduler` — same business + `'track_ranking'`, ranks per day
- `EngagementMonitorPoller` — same business + `'engagement_alert'`, distinct alert types
- `WeeklySummaryScheduler` — same business + `'weekly_summary'`, distinct weeks

A global unique index would block all of these and break production. The Stripe webhook's idempotency uses a `WHERE NOT EXISTS` guard pattern instead (see §1.6), matching the existing `MonthlyImpactScheduler` / `WeeklySummaryScheduler` / `NotificationFailoverPoller` pattern.

### 2.3 Email canonicalization (case-folding + trim)

`users.email` is a Postgres TEXT column with a case-sensitive unique constraint (migration 001). Without app-level normalization, `Owner@x.com` and `owner@x.com` would be treated as distinct — the pre-check in `POST /api/auth/signup` (§3.1 step 3) would not match an existing record entered with different casing, the Supabase `signUp` would either succeed (creating a duplicate identity) or fail with a confusing error, and Stripe's `prefilled_email` could disagree with the eventual login email.

**Fix — normalize at TWO layers:**

1. **Schema layer (every email-accepting auth schema):** normalize BEFORE email validation so a value like `"  Owner@X.com  "` becomes `"owner@x.com"` first and only then is validated as a valid email. Use Zod's `.preprocess`:
   ```ts
   const emailSchema = z.preprocess(
     (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
     z.string().email(),
   );
   ```
   Used by `SignupSchema`, `FinishSignupSchema`, login body, forgot-password body, reset-password body. This guarantees self-serve never inserts a non-lowercased email AND that a trailing-space typo doesn't fail validation that would have passed after normalization.

2. **`createBusinessTx` defense-in-depth:** the helper itself applies `input.ownerEmail = input.ownerEmail.trim().toLowerCase()` at the top of the function. This catches the admin path too — admin onboarding's existing `OnboardBusinessSchema` does NOT currently lowercase emails, and ANY future caller that bypasses schema validation (tests, scripts, future code paths) inherits the protection. One enforcement point covers all current and future callers.

This also matches Supabase Auth's own internal normalization (Supabase lowercases emails before storing in `auth.users`), so the post-normalization value is what Supabase will see — uniqueness checks on our side and Supabase's side agree.

**Backfill — required, with collision check that BLOCKS deployment if any conflict exists:**

**Migration 025 block execution order** is significant — implementations MUST run blocks in this sequence so each subsequent block reads consistent, normalized data:

1. `CREATE INDEX` for `idx_businesses_pending_unpaid_self_serve_cleanup` and `idx_users_owner_auth_by_business` (§2.2). Indexes don't depend on data state.
2. Email normalization: collision check + `UPDATE users SET email = lower(trim(email))` (§2.3 block below). Runs BEFORE the admin-presence check in step 3 because that check reads `users.role` (not email), but downstream code paths that join on email expect normalized values immediately after this block runs.
3. `onboarded_by` backfill with admin-presence precondition (§1.6 "Admin onboarding update"). Reads `users.role` (unaffected by step 2) and writes to `businesses.onboarded_by`.

Migration 025 (`025_signup_schema.sql`) runs the following block as step 3:

```sql
-- 1. Detect collisions BEFORE attempting backfill — fails the migration if any exist.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT COUNT(*) INTO collisions FROM (
    SELECT lower(trim(email)) AS norm_email
    FROM users
    GROUP BY lower(trim(email))
    HAVING COUNT(*) > 1
  ) c;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'Email normalization would create % duplicate(s). Resolve manually before re-running.', collisions;
  END IF;
END $$;

-- 2. Normalize.
UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));
```

If the deployment fails on step 1, the operator runs the diagnostic query (`SELECT lower(trim(email)) AS norm, array_agg(id) FROM users GROUP BY lower(trim(email)) HAVING COUNT(*) > 1`) and either merges the duplicates manually or deletes the dormant ones, then re-runs the migration. Failing-loud is correct here — silently dropping a conflicting row would lose business data.

A case-insensitive unique index is NOT added in this migration. The schema-layer + `createBusinessTx`-layer normalization makes future inserts uniformly lowercased, which is sufficient. Adding `CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email))` is a defensible follow-up if a future incident shows non-normalized inserts sneaking in via some unexpected path, but YAGNI for MVP.

### 2.4 The `users.email` uniqueness edge case

`users.email` has a unique constraint (migration 001). Today, an admin attempting to onboard a business with an email that already exists gets a 409. Self-serve signup needs the same behavior: `POST /api/auth/signup` returns 409 "An account with this email already exists" when the pre-tx check finds a hit, OR when the tx fails on the `23505` constraint violation (race between two concurrent signups with the same email).

If an abandoned signup's email lingers past the 7-day cleanup threshold, a re-signup attempt within that window hits the 409. The user sees "An account already exists — try logging in, or use forgot password." This is acceptable for MVP (dormant-within-7-days is a narrow window); if it becomes a real support burden the cleanup interval can be tightened.

---

## 3. API routes

### 3.1 `POST /api/auth/signup` (public, rate-limited)

**SignupSchema** — defined explicitly in `src/lib/shared/schemas.ts`, NOT reused from `OnboardBusinessSchema` (the admin schema's `name` field means business name; conflating that with owner name in this route would be the easiest implementation bug to ship). Field names are unambiguous on the wire:

```ts
{
  ownerEmail: string;            // RFC 5322-ish (reuse ownerEmailSchema)
  ownerName: string;
  ownerPhone?: string;
  password: string;              // min 8 chars (form + server enforce; Supabase default is 6)
  businessName: string;          // maps to businesses.name
  googlePlaceId?: string;        // OR googleMapsUrl required (xor refine, same as OnboardBusinessSchema)
  googleMapsUrl?: string;
  tone?: string;                 // defaults applied server-side
  productsServices?: string;
  staffNames?: string;
  highlightFacts?: string;
  avoidFacts?: string;
  sampleResponses?: string;
  subscriptionTier: 'founding' | 'standard';
  website?: string | null;
}
```

`createBusinessTx` accepts a normalized `BusinessTxInput` domain object that uses `businessName` + `ownerName` everywhere. The two callers (admin route and signup route) each adapt their respective form schema into that shape. No internal callsite ever sees the ambiguous bare `name`.

**Flow:**

1. Rate-limit by IP (`checkRateLimit` with `strict: true` — see §8.1; the existing fail-open default is unsafe for a public abuse-prone endpoint). Suggest 5 signups per IP per hour.
2. Validate body against `SignupSchema`. Reject 400 on schema failure.
3. **Concurrent re-signup serialization.** Open a short-lived `sql.begin` and take `pg_advisory_xact_lock(hashtext(${ownerEmail} || ':signup'))` BEFORE the email pre-check, then perform the pre-check inside the same tx and commit. Cleanup poller (§1.5) takes the same lock during candidate processing, so a re-signup attempt that arrives while cleanup is mid-batch waits until cleanup finishes (or rolls back) before reading `users.email`. Without this, a narrow race produced a confusing UX: signup → 409 ("account exists") → cleanup deletes the row 50ms later → user re-tries → succeeds. With the lock, the second attempt sees consistent post-state.
4. Pre-check inside the locked tx: `SELECT 1 FROM users WHERE email = $1 LIMIT 1` → 409 `"An account with this email already exists. Try logging in or use forgot password."` if hit. This catches admin-created owners (who have `auth_id=NULL` and would otherwise only fail at the late `23505` step inside the createBusinessTx). Commit the lock-tx after the pre-check (the lock has done its job).
5. `supabase.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL + '/api/auth/callback?flow=owner&next=/onboarding/pay' } })`.
   - On Supabase 422 "User already registered": return the same 409 message as step 4 (don't leak which check failed).
   - On success: capture `data.user.id` as `authId`.
6. Call `createBusinessTx({ authId, input: <normalized>, mode: 'self_serve' })` — shared helper (see §6 for the discriminated `mode` union).
   - If the tx throws `DuplicateEmailError` (mapped from PG `23505` — race against a concurrent signup that snuck in between step 4 and here, despite the lock — possible if two requests arrive simultaneously and both queue on the lock with no row visible at pre-check time): run the **compensating cleanup** in step 7, then return 409.
   - If the tx throws any other DB error: run the compensating cleanup in step 7, then return 500.
7. **Compensating cleanup on tx failure** (orphan-auth-user is the worst outcome — it permanently blocks the owner's email from re-signup):
   ```ts
   await supabaseServer.auth.admin.deleteUser(authId).catch((err) => {
     // Log with correlation id for manual cleanup. Do NOT swallow silently —
     // an orphan auth user is a real ops issue.
     logger.error(`[signup-cleanup] Failed to delete orphan auth user ${authId} after tx failure: ${err.message}`);
   });
   ```
   `supabaseServer` is the service-role client from `src/lib/db/server.ts:45`. `auth.admin.deleteUser` requires service-role; the cookie-bound anon client cannot do this.
8. On success: return `{ redirectTo: '/signup/check-email' }` (201).

Note: we do NOT log the Supabase session in via `signUp` — Supabase's default is to return no session until email is confirmed, which is exactly the gate we want. The browser will acquire a session via `/api/auth/callback` when the owner clicks the confirmation email.

### 3.2 `POST /api/auth/finish-signup` (cookie-authenticated, Google path)

The owner has already authenticated via Google OAuth; their session cookie is set but no `users` row exists.

Body: `FinishSignupSchema` — same fields as `SignupSchema` MINUS `ownerEmail` + `password` (email comes from session, no password — Google-delegated).

**Flow:**

1. Read session via `supabase.auth.getUser()` from cookie-bound server client. If no session → 401.
2. Extract `authId = session.user.id` and `email = session.user.email`. If email is missing or unverified at the Supabase level (defensive — Google always provides verified email, but a misconfigured provider could change this) → 401 with `account_incomplete`.
3. Rate-limit: 3 per `authId` per hour.
4. **Two guard checks** (in this order — the second covers admin-created collisions):
   a. `SELECT 1 FROM users WHERE auth_id = $1 LIMIT 1` → 409 `"signup already complete"` if hit (double-submit defense).
   b. `SELECT 1 FROM users WHERE email = $1 AND auth_id IS DISTINCT FROM $2 LIMIT 1` → 409 `"An account with this email already exists. Use forgot password to recover access."` if hit. This catches the case where an admin pre-created a `users` row with the same email but `auth_id=NULL` (which would otherwise only surface as a late `23505` after we'd done all the validation work).
5. Validate body against `FinishSignupSchema`.
6. `createBusinessTx({ authId, input: <normalized: business fields + ownerEmail from session + ownerName from body>, onboardedBy: null })`.
   - On `DuplicateEmailError` from a race: return 409. **No auth-user cleanup here** — the auth user came from Google and is shared with `auth.users` regardless of our outcome; deleting it would log the user out of every other Supabase-using site and lock them out of recovery.
   - On other DB error: return 500. Same reasoning — leave the auth user alone.
7. On success: return `{ redirectTo: '/onboarding/pay' }` (201).

### 3.3 `GET /api/auth/signup-status` (cookie-authenticated)

Used by `/onboarding/payment-success` to poll subscription status.

**Important:** RLS migration 006 only defines `users_self_select` on the `users` table. There is **no owner-scoped policy on `businesses`**. The cookie-bound anon client cannot read businesses for its owner. This route therefore uses the **service-role `sql` client** from `src/lib/db/server.ts` with explicit `auth_id` scoping in the WHERE clause — the same pattern `/api/dashboard/route.ts` already uses.

**Flow:**

1. Read session via cookie-bound `supabase.auth.getUser()`. If no session → 401.
2. Look up business via service-role `sql`, scoped explicitly by `auth_id`:
   ```sql
   SELECT b.subscription_status, u.role
   FROM users u
   JOIN businesses b ON b.id = u.business_id
   WHERE u.auth_id = ${authUser.id}
   LIMIT 1
   ```
3. If no row: 404 `account_incomplete` (treat same as missing users row at login — sign out, surface error).
4. Return `{ subscriptionStatus, role }`.

The poll page uses 2-second intervals with exponential backoff up to 30s, max poll duration 5 minutes. If the webhook hasn't fired by then, show a "This is taking longer than usual — contact support" fallback (Stripe webhooks are usually sub-second).

**Payment Link URL inclusion is not a secret leak.** When the dashboard pending-payment branch (§1.4) returns `paymentUrl` in its minimal payload, the URL is built from `STRIPE_PAYMENT_LINK_*` env vars but the URL itself is not a secret per Stripe's threat model — Payment Links are designed to be publicly shareable; security comes from Stripe's session signing on actual checkout, not from URL secrecy. Including the URL in cookie-authenticated owner responses is safe.

### 3.4 `POST /api/auth/forgot-password` (public, rate-limited)

Body: `{ email, role: 'owner' | 'admin' }` — `role` picks the recovery-flow target.

**Recovery flow contract** (single explicit path so the user is guaranteed to land on the reset page WITH a valid session):

1. Supabase `resetPasswordForEmail` sends an email containing a link to a Supabase-hosted recovery URL. After Supabase processes the link it redirects the browser to OUR `redirectTo` URL with a recovery `code` in the query string.
2. We MUST point `redirectTo` at `/api/auth/callback?flow=<role>&next=<reset-page>` so the existing callback handler exchanges the code for a session, sets the cookie, and only THEN redirects to the reset page. If we pointed `redirectTo` directly at `/reset-password`, the reset page would receive a `code` query param but no session — and our callback handler would never run.
3. The reset page (§4 + §3.6) reads the established session and lets the user set a new password via `/api/auth/reset-password`.

**Flow:**

1. Rate-limit by IP (3/hour) and by email (2/hour) — prevents enumeration-style abuse. `strict: true`.
2. Normalize `email = email.trim().toLowerCase()` (defense — schema already does this; redundant guard prevents regressions if the schema is bypassed).
3. **Cross-portal protection.** Look up the email's actual role server-side (service-role `sql`):
   ```sql
   SELECT role FROM users WHERE email = ${email} LIMIT 1
   ```
   - If no row → return generic 200 (no enumeration leak; do NOT call Supabase).
   - If `actualRole === 'owner'` and submitted `role === 'admin'` → return generic 200 without calling Supabase. An owner submitting their email through `/admin/forgot-password` MUST NOT receive an admin-branded reset link, regardless of flag state. The submitting user sees the same generic success message either way.
   - If `actualRole IN ('admin','sales_partner')` and submitted `role === 'owner'` → return generic 200 without calling Supabase.
   - If roles match → proceed to step 4.
4. Compute `redirectTo`:
   - `role === 'owner'` → `APP_URL + '/api/auth/callback?flow=owner&next=/reset-password'`
   - `role === 'admin'` → `APP_URL + '/api/auth/callback?flow=admin&next=/admin/reset-password'`
5. `supabase.auth.resetPasswordForEmail(email, { redirectTo })`.
6. Return generic 200 `{ ok: true }`.

**Tests covering the cross-portal guard:** assert `supabase.auth.resetPasswordForEmail` is NOT called when (a) the email belongs to no user, (b) an owner email is submitted with `role='admin'`, (c) an admin email is submitted with `role='owner'`. Assert it IS called when the role matches the actual role.

### 3.5 Extended: `GET /api/auth/callback` (existing, extended)

Today the callback at `src/app/api/auth/callback/route.ts` redirects every failure (missing code, exchange error, account_incomplete) to `/admin/login`. With owner-facing flows live, that surfaces admin branding to confused owners. This extension adds **flow context**.

**New `flow` query param** (URL signal added by every caller — signup confirmation links carry `flow=owner&next=/onboarding/pay`, owner recovery carries `flow=owner&next=/reset-password`, admin recovery carries `flow=admin&next=/admin/reset-password`, no param means legacy admin behavior).

The callback uses the explicit `next` param to decide where to land — it does NOT branch on Supabase's `type=recovery` query string. This keeps the contract self-described in our URLs and avoids relying on Supabase emitting a parameter that may change between SDK versions.

1. Parse `flow` (`'owner' | 'admin' | undefined`) and `next` (validated as a safe internal path) from URL. Compute `loginUrl = flow === 'owner' ? '/login' : '/admin/login'`.
2. If `code` missing: redirect to `loginUrl`.
3. `exchangeCodeForSession` — on error, redirect to `loginUrl + '?error=auth_callback_failed'`.
4. After session is set, dispatch on `next`:
   - `next === '/reset-password'` → redirect there (owner reset page reads the session). No role lookup — recovery flow doesn't yet know the role.
   - `next === '/admin/reset-password'` → redirect there.
   - `next === '/signup/finish'` AND no `users` row for `auth_id` → redirect to `/signup/finish` (Google signup, business fields not yet captured).
   - `next === '/onboarding/pay'` → role-route per §1.2 (owner role + email-confirmed → there; otherwise the role-default).
   - `next` is some other safe path → role-route to `next` if the role can reach it; otherwise role-default.
   - `next` missing or unsafe → role-default (`/dashboard` for owner, `/admin/overview` for admin).
5. The "authenticated but no `users` row" branch (other than the explicit Google-signup case above) signs the user out and shows `account_incomplete` — redirect target is `loginUrl` (owner-branded if `flow=owner`, admin-branded otherwise).
6. Role-routing logic continues to work as today for confirmed users with a `users` row.

### 3.6 New: `POST /api/auth/reset-password` (cookie-authenticated)

Body: `{ password: string }`.

**Auth-id uniqueness invariant.** The reset-password role lookup uses `LIMIT 1` on `users.auth_id`. This is safe because `users.auth_id` has a UNIQUE constraint from migration 001 (`001_initial_schema.sql:53`): `auth_id VARCHAR(255) UNIQUE`. Postgres UNIQUE permits multiple NULLs (standard behavior), which correctly allows admin-created owner rows with `auth_id=NULL` while still preventing two non-NULL entries for the same auth identity. No additional index needed.

**Flow:**

1. Read session via cookie-bound `supabase.auth.getUser()`. If no session → 401 (the recovery callback in §3.5 step 4 sets the cookie before redirecting; if it's missing here the user opened the page directly).
2. Validate password (min 8 chars).
3. `supabase.auth.updateUser({ password })` against the cookie-bound client (writes to the authenticated user only — service-role not needed and would be unsafe here).
4. Look up role: `SELECT role FROM users WHERE auth_id = ${session.user.id} LIMIT 1` (the new unique index makes this lookup deterministic; absent the index the result would be undefined-order on collision).
5. On success: return `{ redirectTo: <role-appropriate login URL> }` — owner role → `/login`, admin/sales_partner → `/admin/login`. Browser navigates; user signs in with the new password.
6. On Supabase error (weak password, expired session): return 400 with the message.

The page is a simple form (`/reset-password` and `/admin/reset-password`, see §4) that posts to this single shared route. Two URLs, one backend — same shape as the forgot-password split (§3.4).

---

## 4. Page inventory

### 4.1 New public pages (under `src/app/(public)/`)

| Path | Purpose | State |
|------|---------|-------|
| `signup/page.tsx` | Main signup form. Password fields + Google button. Tier radio (founding / standard) with brief descriptions. Client form validation + server error surfacing. | Public |
| `signup/check-email/page.tsx` | Static page: "Check your inbox at `<masked email>`." Minimal — no polling. Owner returns via email link. | Public |
| `signup/finish/page.tsx` | Google post-OAuth form. Email field disabled (pre-filled from session). Pre-fills `name` from Google profile. Same business fields as `/signup`. | Public at the middleware layer; the page reads the Supabase session server-side and redirects to `/signup` if absent (§5.1 explains why middleware can't gate this) |
| `login/page.tsx` | Owner login. Email + password + Google button + "Forgot password?" link. RepWorth consumer brand (not "RepWorth Admin"). | Public |
| `forgot-password/page.tsx` | Owner-branded reset request form. Posts to `/api/auth/forgot-password` with `role: 'owner'`. | Public |
| `reset-password/page.tsx` | Owner-branded "set a new password" form. Reads the recovery session set by the callback (§3.5 step 4). Posts to `/api/auth/reset-password`. | Public at the middleware layer; the page reads the Supabase session server-side and shows an "expired link" state if absent. |

### 4.2 New protected pages (under `src/app/onboarding/`)

| Path | Purpose | Gate |
|------|---------|------|
| `onboarding/pay/page.tsx` | "Welcome! Click to complete your payment." Shows the Stripe Payment Link URL as a primary button. | Auth + email confirmed + subscription_status='pending_payment' |
| `onboarding/payment-success/page.tsx` | Post-Stripe return URL. Client-side polling until status flips. "Processing your payment…" → "Welcome to RepWorth → [Go to dashboard]". | Auth + email confirmed |

### 4.3 New admin page

| Path | Purpose | Gate |
|------|---------|------|
| `admin/forgot-password/page.tsx` | Admin-branded reset request form. Posts to `/api/auth/forgot-password` with `role: 'admin'`. | Public |
| `admin/reset-password/page.tsx` | Admin-branded "set a new password" form. Same shape as the owner reset page; posts to the same `/api/auth/reset-password` route. | Public at the middleware layer; page self-gates on session presence. |

### 4.4 Modified pages

| Path | Change |
|------|--------|
| `src/app/(public)/page.tsx` (landing) | Nav header gets "Log In" and "Sign Up" links. Hero gets a "Sign Up" CTA alongside existing "Book a demo". |
| `src/app/admin/login/page.tsx` | Add "Forgot password?" link → `/admin/forgot-password`. No other change. |
| `src/app/(authenticated)/dashboard/.../page.tsx` (existing owner dashboard layout) | When `business.subscription_status='pending_payment'`, render the payment-pending banner card at the top and hide the main dashboard content. |

---

## 5. Middleware + protected-route classifier changes

Two coupled files change together: `src/middleware.ts` (the actual gate) and `src/lib/shared/protected-routes.ts` (the classifier `isProtectedRoute` that middleware calls to decide whether to even invoke Supabase auth). Today `protected-routes.ts:2` exempts only `/admin/login`; the new public surfaces under `/admin/*` (forgot-password, reset-password) need to be exempted too, otherwise they'll require auth and 404-bounce non-logged-in admins trying to reset their password.

### 5.1 New public paths

Added to `protected-routes.ts` exemption list (return `false` for these even though they share a `/admin` prefix):

- `/admin/forgot-password`
- `/admin/reset-password`

Added to the matcher's public list (no auth required, not protected):

- `/signup`, `/signup/check-email`, `/signup/finish` (see note below)
- `/login`
- `/forgot-password`, `/reset-password`
- `/api/auth/signup` (POST)
- `/api/auth/forgot-password` (POST)
- `/api/auth/reset-password` (POST — but cookie-authenticated; "public" here means `isProtectedRoute` returns false so middleware doesn't enforce role gates. The route's own handler reads the session.)

Note on `/signup/finish` and `/reset-password`: these are served to a user who has a Supabase session (from Google OAuth or recovery callback) but in some cases no `users` row yet. Middleware treats them as public (no `users` row lookup required); the page itself calls `supabase.auth.getUser()` to read the session and redirects appropriately if absent.

### 5.2 New gated paths

The current middleware at `src/middleware.ts` only has two categories: protected (role-checked) and public. `/api/auth/finish-signup` is a third category — it requires an authenticated Supabase session but explicitly NO `users` row exists yet (that's the whole point of the route — finishing signup creates the row). Marking it protected would route the cookie holder to an `account_incomplete` sign-out before the route ever sees the request.

**Resolution:** classify these new endpoints as **route-level auth only** — `isProtectedRoute` returns `false` for them, middleware does not enforce role gates, and each handler reads `supabase.auth.getUser()` itself and returns 401 if the session is missing. Same pattern as `/signup/finish` and `/reset-password` pages (§4.1) which also have no `users` row at the time they're served.

| Path | Middleware classification | Handler-level enforcement |
| ---- | ------------------------- | ------------------------- |
| `/onboarding/pay`, `/onboarding/payment-success` | Protected — requires authenticated owner with a `users` row (role='owner'). Does NOT require `subscription_status='active'`. The page itself shows the "email not confirmed yet" state if `auth.users.email_confirmed_at` is NULL. | Standard `requireRole` |
| `/api/auth/finish-signup` | **Public at middleware layer.** | Handler reads session + asserts no existing `users` row + asserts no auth_id collision + Origin header check (§8.5) |
| `/api/auth/signup-status` | Protected — requires authenticated owner with a `users` row. | Standard `requireRole` |
| `/api/auth/reset-password` | **Public at middleware layer.** | Handler reads session + Origin header check (§8.5) |
| `/api/auth/signup` | Public. | Handler validates body, rate-limits, no auth needed |
| `/api/auth/forgot-password` | Public. | Handler validates body, rate-limits, no auth needed |

### 5.3 No change to existing gates

- `/admin/*` (except `/admin/login`, `/admin/forgot-password`, `/admin/reset-password`) — admin/sales_partner only.
- `/dashboard`, `/settings`, `/api/dashboard`, `/api/settings` — owner + `business_id`.

### 5.4 Tests

`src/lib/shared/__tests__/protected-routes.test.ts` (new) — table-driven test covering every path from §5.1 + §5.2 + §5.3, asserting `isProtectedRoute` returns the expected value. Prevents future drift.

---

## 6. Shared helper: `createBusinessTx`

New file: `src/lib/onboarding/create-business.ts`.

Extracts the onboarding transaction from `POST /api/admin/businesses` (current file `src/app/api/admin/businesses/route.ts` lines 172–284) into a pure, callable helper.

Signature uses two discriminated unions to make invalid combinations unrepresentable at the type level:

```ts
// Discriminated union #1 — the place-id branch.
// Eliminates the "verified=true but placeId=null" / "verified=false but no URL"
// invalid combinations that loose fields would allow.
type PlaceIdInput =
  | { placeIdVerified: true;  placeId: string;  googleMapsUrl?: string | null }
  | { placeIdVerified: false; placeId?: string | null; googleMapsUrl: string };

interface BusinessTxInput {
  // Owner identity
  ownerEmail: string;
  ownerName: string;
  ownerPhone?: string | null;

  // Business profile
  businessName: string;            // → businesses.name (no overloaded `name`)
  category?: string | null;
  tone?: string | null;
  productsServices?: string | null;
  staffNames?: string[];
  highlightFacts?: string[];
  avoidFacts?: string[];
  sampleResponses?: string[];
  subscriptionTier: 'founding' | 'standard';
  website?: string | null;

  // Place ID — discriminated; see PlaceIdInput above.
  // Self-serve persists googleMapsUrl into the existing businesses.google_maps_url
  // column so the Stripe webhook (§1.6) can build a valid ValidatePlaceIdPayload
  // hours/days after signup. The discriminated union enforces that the URL is
  // present whenever placeIdVerified=false.
  placeId: PlaceIdInput;
}

// Discriminated union #2 — caller intent. Three independent flags
// (authId / onboardedBy / enqueueInitialSync) had 8 combinations but only
// 2 were valid. Collapse to two named modes so invalid combinations are
// unrepresentable at the type level.
type CreateBusinessOptions =
  | { mode: 'admin';      onboardedBy: string }   // → enqueues initial sync; users.auth_id = NULL
  | { mode: 'self_serve'; authId: string };       // → no initial sync; users.auth_id set; webhook (§1.6) enqueues on activation

interface CreateBusinessResult {
  businessId: string;
  userId: string;
  paymentUrl: string | null;       // built via buildPaymentLinkUrl helper from src/lib/payments/payment-link.ts
}

export class DuplicateEmailError extends Error {}

export async function createBusinessTx(
  input: BusinessTxInput,
  options: CreateBusinessOptions,
): Promise<CreateBusinessResult>;
```

**Behavior:** one `sql.begin` that inserts `businesses` (pending_payment) + `users` + `channel_enrollments` (email, verified). The `job_outbox` row is inserted **only when `options.mode === 'admin'`**, and uses `placeId.placeIdVerified` to choose between `sync_reviews` (verified) and `validate_place_id` (unverified). Self-serve mode skips the outbox insert entirely.

| Caller | `options` | Result |
| ------ | --------- | ------ |
| Admin route (`POST /api/admin/businesses`) | `{ mode: 'admin', onboardedBy: <adminUserId> }` | Admin onboarding behavior preserved verbatim — initial sync queued for sales-call demo. |
| Self-serve password (`POST /api/auth/signup`) | `{ mode: 'self_serve', authId: <newAuthUserId> }` | No SerpAPI/LLM spend pre-payment. Stripe webhook (§1.6) enqueues sync on activation. |
| Self-serve Google (`POST /api/auth/finish-signup`) | `{ mode: 'self_serve', authId: <sessionAuthId> }` | Same as above. |

Handles `23505` from the `users.email` unique constraint by re-throwing a typed `DuplicateEmailError`. Callers catch and return 409 (admin) or 409 + auth-user cleanup (self-serve password — see §3.1 step 7).

Unit tests for `createBusinessTx` cover:
- Admin mode — asserts `users.auth_id IS NULL` AND outbox row is created.
- Self-serve mode — asserts `users.auth_id` matches AND **NO** outbox row is created (regression guard against the most expensive bug class — pre-payment SerpAPI/LLM spend).
- Duplicate email (PG `23505`) → `DuplicateEmailError`.
- Place-ID branch in admin mode: `placeIdVerified=true` → enqueue `sync_reviews`; `placeIdVerified=false` → enqueue `validate_place_id`.
- Field-name regression: input with `businessName='Acme'` and `ownerName='Jane'` → asserts `businesses.name='Acme'` and `users.name='Jane'` (catches the easy-to-ship swap bug).
- Type-system regression (compile-time, not runtime): asserts that `{ mode: 'admin', authId: 'x' }` and `{ mode: 'self_serve', onboardedBy: 'y' }` fail to compile, proving the discriminated union prevents invalid combinations.

### 6.1 Shared route + form helpers

Three new shared modules exist to prevent drift across the many similar surfaces this spec adds. The implementation plan should produce them BEFORE the per-route work so each route handler / page composes from a tested base.

**`src/lib/shared/auth-flow.ts`** — single source of truth for the `flow=` query param contract:
```ts
export const AUTH_FLOWS = ['owner', 'admin'] as const;
export type AuthFlow = (typeof AUTH_FLOWS)[number];

export function isAuthFlow(v: string | null | undefined): v is AuthFlow {
  return v === 'owner' || v === 'admin';
}

export function loginUrlForFlow(flow: AuthFlow | undefined): string {
  return flow === 'admin' ? '/admin/login' : '/login';
}

export function resetPasswordPathForFlow(flow: AuthFlow): string {
  return flow === 'admin' ? '/admin/reset-password' : '/reset-password';
}
```
Used by: callback handler (§3.5), forgot-password (§3.4), reset-password (§3.6), middleware redirect builders (§5).

**`src/lib/auth/route-helpers.ts`** — composable wrappers for the new auth API routes. Without these, each of the five new endpoints duplicates rate-limit + Origin-check + session-read boilerplate. Composable shape:
```ts
export function withRateLimit(
  key: (req: NextRequest) => string,
  max: number,
  windowSeconds: number,
): (handler: NextHandler) => NextHandler;

export function withSameOrigin(): (handler: NextHandler) => NextHandler;

export function withSession(
  handler: (session: { user: User }, req: NextRequest) => Promise<Response>,
): NextHandler;
```
Routes compose left-to-right:
```ts
export const POST = withRateLimit(ipKey, 5, 3600)(
  withSameOrigin()(
    withSession(handleResetPassword),
  ),
);
```
Pattern is intentionally minimal — no opinionated middleware framework. Each wrapper is ~15 lines.

**`src/components/auth/LoginFormClient.tsx`** + **`src/components/auth/ResetPasswordFormClient.tsx`** + **`src/components/auth/ForgotPasswordFormClient.tsx`** — shared client components. The owner page and admin page differ only in branding and post-login default route; everything else (form state, error handling, OAuth button conditional, role-routing logic) lives in the shared component. Component props:
```ts
type LoginFormProps = {
  portal: AuthFlow;             // 'owner' | 'admin'
  brandName: string;            // "RepWorth" | "RepWorth Admin"
  showGoogleButton: boolean;    // true on /login, false on /admin/login
  defaultRoute: string;         // /dashboard | /admin/overview
  allowedRoles: readonly string[]; // ['owner'] | ['admin', 'sales_partner']
};
```
Each `page.tsx` becomes a 5-line wrapper. Reduces total new-page LOC by ~60% and eliminates drift risk between the two login flows. Without this extraction, a fix to one page's role-routing logic silently fails to propagate to the other — exactly the class of bug §3.5 was already complicated enough to suffer from.

---

## 7. External configuration (out-of-code, documented in spec)

These are Supabase / Stripe dashboard settings, not code. Captured here so the implementation plan surfaces them as deployment checklist items.

**Supabase:**

1. **Google OAuth provider.** Enable `google` provider. Set authorized redirect URI to `<APP_URL>/api/auth/callback`. Google OAuth client ID and secret live in Supabase's provider config, not in our `.env`.
2. **Email confirmation.** Default Supabase behavior (require confirmation) is what we want. No per-project flag change needed.
3. **Auth email templates.** Default Supabase templates. Future work: swap to Resend-sent custom templates (out of scope here).
4. **Password policy.** Supabase default (min 6 chars). We enforce 8 chars at the form/API layer so Supabase's default is not the binding constraint; no change needed on the Supabase side.

**Stripe:**

5. **Payment Link `success_url`.** Each Payment Link referenced by `STRIPE_PAYMENT_LINK_FOUNDING` and `STRIPE_PAYMENT_LINK_STANDARD` MUST have its `success_url` set in the Stripe dashboard to `<APP_URL>/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`. Without this, owners pay and land on Stripe's default success page, never reaching our welcome flow. Verify on every environment promotion (dev → staging → prod each have their own Payment Links).
6. **Payment Link `cancel_url`** (optional but recommended). Set to `<APP_URL>/onboarding/pay?cancelled=1` so owners who back out of Stripe checkout land back on our pay page rather than a Stripe default. The pay page can show a soft "Try again when you're ready" message based on the `?cancelled=1` query param.
7. **Stripe webhook endpoint.** Already configured for the existing `/ingress/stripe` handler. No change required; the webhook continues to receive `checkout.session.completed` events.

`.env.example` additions:

| Env var                                      | Required? | Purpose |
| -------------------------------------------- | --------- | ------- |
| `SELF_SERVE_SIGNUP_ENABLED`                  | Yes       | Server-authoritative flag gating owner self-serve pages + APIs. Default `false`. Flip to `true` per environment after staging ship gate. |
| `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS`      | Optional  | Override for the cleanup poller's interval (default `86_400_000` = 24h). Useful for staging where shorter cycles ease testing. |

Google OAuth client ID + secret live in Supabase's provider config, NOT in our env. The application never reads them.

Documented but unchanged: `NEXT_PUBLIC_APP_URL` is already the base for all `redirectTo` construction. `REDIS_CACHE_URL` becomes a hard requirement when `SELF_SERVE_SIGNUP_ENABLED='true'` (worker startup assertion fails on mismatch — see §8.1).

---

## 8. Security considerations

### 8.1 Rate limits

The existing `checkRateLimit` (`src/lib/shared/rate-limit.ts:46`) **fails open** when `REDIS_CACHE_URL` is missing or Redis is unreachable — it returns `{ allowed: true, remaining: max }` so user-facing endpoints don't 503 on a Redis blip. That tradeoff is wrong for public abuse-prone endpoints: it makes signup + forgot-password rate limits silently optional in production.

**All four self-serve auth endpoints pass `strict: true` to `checkRateLimit`.** Strict mode either throws (Redis unreachable) or returns the real rate-limit decision. The route handlers catch the throw and return `503 Service Unavailable` — the user retries momentarily. Better to fail loudly than silently disable abuse controls.

In addition, the worker startup assertion (matching the existing channels env-assert pattern) verifies `REDIS_CACHE_URL` is set whenever `SELF_SERVE_SIGNUP_ENABLED === 'true'`. The env-assert prevents shipping the flag without the dependency.

Per-endpoint limits:

- `POST /api/auth/signup`: 5/hour per IP.
- `POST /api/auth/forgot-password`: 3/hour per IP, 2/hour per email (two separate keys, both must allow).
- `POST /api/auth/finish-signup`: 3/hour per authenticated `auth_id`.
- `POST /api/auth/reset-password`: 5/hour per authenticated `auth_id` (legitimate retries on weak-password rejection).
- `GET /api/auth/signup-status`: no explicit limit — poll is cookie-authenticated and only returns the caller's own status. A bad actor can only DoS themselves; cookie-bound + service-role query is cheap.

### 8.2 No user enumeration

`POST /api/auth/forgot-password` returns the same `200 { ok: true }` regardless of whether the email matches. `POST /api/auth/signup` returns the same 409 message for both the pre-tx check hit and the Supabase "User already registered" error.

### 8.3 Identity linking

Supabase's default: if an email signs up with password and later signs in with Google (same email), Supabase auto-links the identities on the same `auth.users` row. Our `users.auth_id` mapping stays valid. The inverse (Google signup, later password login attempt) fails with Supabase's default "Invalid login credentials" — we don't add a hint because that would leak identity-provider information. Documented as acceptable MVP behavior.

### 8.4 Session cookie scope

Supabase SSR cookies are HttpOnly, Secure (production), SameSite=Lax. No change from today.

### 8.5 CSRF

`/api/auth/signup` and `/api/auth/forgot-password` are public, take no auth. They're not CSRF-sensitive in the classical sense (no authenticated state to abuse).

`/api/auth/finish-signup` AND `/api/auth/reset-password` are both cookie-authenticated state-changing endpoints. Both benefit from SameSite=Lax and **both must reject requests without an `Origin` header matching `APP_URL`** (defense in depth — protects against any future CSRF vector that bypasses SameSite, e.g. older browser quirks). Implemented as a small shared helper `assertSameOrigin(request)` called at the top of both route handlers.

### 8.6 Abandoned auth users

Two separate sources of orphan-auth-user risk:

**(a) Failed compensating cleanup at signup (§3.1 step 6).** If `auth.signUp` succeeds but the subsequent `createBusinessTx` throws AND the cleanup `auth.admin.deleteUser` ALSO fails (Supabase admin API down, network error), we leave an orphan auth user. This permanently blocks the email from re-signup until manually cleaned. Mitigations:
- Cleanup error is logged at ERROR level with correlation id (not swallowed silently).
- Test coverage: integration tests cover (i) tx fails + cleanup succeeds, (ii) tx fails + cleanup fails — assert the right log line is emitted in case (ii).
- Manual recovery: admin uses Supabase dashboard's user list to delete the orphan.
- Future: a daily reconciliation job that finds `auth.users` rows older than 24h with no matching `users.auth_id` and deletes them. Not built in MVP — failure rate expected to be near-zero.

**(b) Cleanup poller failure (§1.5).** Same shape — if the Supabase delete fails, the business row is left in place rather than orphaning the auth user. Logged as a warning; next poller run retries.

In both cases the failure mode is "user gets a 409 'account exists' on retry" — annoying but not data-loss or security-relevant. Acceptable for MVP.

---

## 9. Testing strategy

### 9.1 Unit tests

- `src/lib/onboarding/__tests__/create-business.test.ts` — the extracted helper, both admin and self-serve modes, duplicate email, place-id-verified vs unverified.
- `src/app/api/auth/__tests__/signup.test.ts` — form validation, rate limiting, 409 on duplicate, Supabase error fan-out.
- `src/app/api/auth/__tests__/finish-signup.test.ts` — session requirement, double-submit 409, validation.
- `src/app/api/auth/__tests__/forgot-password.test.ts` — rate limiting, role-based redirectTo, generic response.

### 9.2 Integration tests

- Full password signup → email-confirm callback → payment-pending → webhook fires → dashboard active. Webhook firing simulated by POSTing a fixture to `/ingress/stripe`.
- Full Google signup → finish form → payment-pending → webhook fires → dashboard active. OAuth redirect simulated by setting up a mock Supabase session cookie.
- Abandoned cleanup poller: insert a set of rows with varying ages and stripe_customer_id states, run the poller, assert correct deletions.
- Login role routing: password login as owner with pending_payment + email confirmed → lands on /onboarding/pay. Password login as admin on /login → gets signed out with "wrong portal" error.

### 9.3 E2E tests (Playwright)

- Password signup happy path: fill form → submit → check-email page → simulate email click → land on /onboarding/pay → click Stripe link → mock Stripe success URL → poll until active → land on /dashboard.
- Google signup happy path: click Google button → mock OAuth → land on /signup/finish → fill business fields → submit → land on /onboarding/pay.
- Forgot password: submit email → success message → Supabase email link simulated → password reset form → new password → login success.
- Cross-flow: submit owner email on `/admin/forgot-password` → generic success message (no enumeration).

---

## 10. Phasing + rollout

This is a single phase — everything ships together. The existing admin onboarding + admin login remains fully functional throughout.

**Rollout order:**

1. Run migration `025_signup_schema.sql` — two partial indexes (§2.2), the `users.email` lowercase backfill with collision precondition (§2.3), and the `businesses.onboarded_by` backfill with admin-presence precondition (§1.6 "Admin onboarding update"). Both backfills fail the migration loudly if their precondition is unmet. No new columns — `businesses.google_maps_url` already exists from migration 007.
2. Merge the `createBusinessTx` extraction (no behavior change). Admin route updated to set `onboarded_by` on every new insert.
3. Merge the new API routes:
   - `/api/auth/signup`
   - `/api/auth/finish-signup`
   - `/api/auth/signup-status`
   - `/api/auth/forgot-password`
   - `/api/auth/reset-password`
4. Merge the new pages and admin additions:
   - `/signup`, `/signup/check-email`, `/signup/finish`
   - `/login`
   - `/forgot-password`, `/reset-password`
   - `/onboarding/pay`, `/onboarding/payment-success`
   - `/admin/forgot-password`, `/admin/reset-password`
   - Dashboard payment-pending banner
   - `/admin/login` "Forgot password?" link
5. Merge the `CleanupAbandonedSignupsPoller` + worker registration (gated on flag).
6. Enable Google OAuth in Supabase dashboard.
7. Flip `SELF_SERVE_SIGNUP_ENABLED=true` on staging; run ship gate end-to-end:
   - Real email + real Stripe test-mode payment.
   - Real Google account → finish-signup → activation.
   - Real forgot-password flow on both owner and admin branches (different recipient inboxes).
   - Real reset-password completion (cookie-bound, both flows).
   - Cross-portal protection: submit owner email through `/admin/forgot-password`, assert NO admin-branded email arrives (and reciprocal for admin email through `/forgot-password`).
   - **Polling load sanity:** open 50 concurrent `/onboarding/payment-success` polling sessions against staging; assert p99 latency for `/api/auth/signup-status` stays < 100ms across 5-minute windows. The new `idx_users_owner_auth_by_business` partial index covers the join — this gate confirms it in practice. Cheap; doesn't need k6 or anything heavy — a 30-line script with `Promise.all` of `fetch` loops is enough.
8. Flip `SELF_SERVE_SIGNUP_ENABLED=true` in production AND merge the landing-page nav links (`/login`, `/signup`) in the same deploy so owners cannot land on a visible signup link while the flow is gated off.

**What the flag gates (single definition to resolve any ambiguity):**

The flag's purpose is to gate **owner self-serve traffic**, not admin functionality. Admin pages must keep working regardless of flag state because admins recover their own passwords, onboard businesses, etc.

**Owner-only public pages — gated** (return Next.js `notFound()` when `SELF_SERVE_SIGNUP_ENABLED !== 'true'`):
- `/signup`, `/signup/check-email`, `/signup/finish`
- `/login`
- `/forgot-password`, `/reset-password`

**Owner-only API endpoints — gated** (return 404 when flag is off):
- `POST /api/auth/signup`
- `POST /api/auth/finish-signup`
- `GET /api/auth/signup-status`

**Admin pages — never gated**:
- `/admin/forgot-password`, `/admin/reset-password` always available regardless of flag.

**Shared API endpoints — body-level gating, not whole-route gating** (admin needs them for their own reset flow even when self-serve is off):
- `POST /api/auth/forgot-password` — accepts both `role: 'owner'` and `role: 'admin'`. When flag is off, requests with `role: 'owner'` return 404; requests with `role: 'admin'` proceed as normal.
- `POST /api/auth/reset-password` — does not accept a role param (the role is implicit in the authenticated session). When flag is off, the route looks up the calling user's role; if `role === 'owner'`, return 404; if `role === 'admin' | 'sales_partner'`, proceed.

**Other surfaces:**
- The landing-page nav links to `/login` and `/signup` are conditionally rendered based on a server-read of the flag (no `NEXT_PUBLIC_*` companion — the landing page is a server component).
- The Stripe webhook's initial-sync enqueue (§1.6) is NOT gated — it's safe to enable unconditionally because the combined-predicate scope (`onboarded_by IS NULL AND auth_id IS NOT NULL`) can only match businesses created by self-serve, and self-serve creation requires the flag to have been on at signup time.
- `CleanupAbandonedSignupsPoller` registration is gated so local dev without the flag never runs it against real data.

Flag-gating lets the pages be reviewed on a staging deploy before the landing page directs any real traffic at them. Flipping the flag + landing links in the same production deploy guarantees no user can see a dead link mid-rollout.

---

## 11. YAGNI — explicitly NOT building

- ~~Email confirmation resend button on `/signup/check-email`.~~ — RECONSIDERED. Default Supabase confirmation links expire after 24h. Owners who don't see the email within 24h (spam, travel) are blocked from the flow until the 7-day cleanup runs, and they can't `forgot-password` because the account isn't confirmed yet. Add a "Resend confirmation" button on `/signup/check-email` that calls `supabase.auth.resend({ type: 'signup', email })`. Supabase rate-limits its own resend endpoint, so the button is safe to expose without additional guards. New file: `src/app/api/auth/resend-confirmation/route.ts` (cookie-less; takes email + flow=owner; rate-limited 2/hour per email per IP via `checkRateLimit` strict mode).
- CAPTCHA on signup. Payment is the real gate. Dormant-row cost is just storage + the nightly cleanup poller.
- Custom Resend-sent password-reset / email-confirm emails. Supabase's default templates are functional; swap is a separate spec if branding becomes a priority.
- Identity-unlinking UI (disconnect Google from an account). Supabase's auto-link behavior is one-way-enough for MVP.
- Multi-user-per-business. `UNIQUE(business_id, channel='email')` + one `users.role='owner'` per business today. Adding approvers is Phase 4 channels territory.
- Per-tier onboarding forms. One form handles both founding and standard; tier is a radio.
- `/signup?tier=founding` deep link from `/pricing`. Nice-to-have polish; add after the main flow is live if conversion data suggests the pricing-page-to-signup handoff needs it.

**Identity-layer lock-in note (informational, not actionable):** this spec adds many new touchpoints with Supabase Auth (`auth_id` writes, `auth.admin.deleteUser`, `auth.admin.generateLink` if added, `auth.signUp`, `auth.resetPasswordForEmail`, `auth.updateUser`, OAuth provider config). Migrating off Supabase Auth in the future would touch every file in this spec. No action required today — Supabase is a sound choice — but acknowledge the lock-in surface area is meaningfully larger after this change.

---

## 12. Risks + mitigations

| Risk                                                   | Mitigation                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe webhook delayed or dropped → owner pays but dashboard stays locked | `/onboarding/payment-success` polls with a generous timeout. Manual fallback: admin can flip `subscription_status` in the admin detail page.  |
| Email confirmation email delayed / goes to spam        | **Important:** Supabase's default email templates ship via Supabase's SMTP, NOT through our Resend account. The existing Resend bounce webhook (`worker/ingress/resend.ts`) does NOT see these emails — bounces on confirmation/recovery emails are silent. Mitigations: (a) generic "check spam folder" wording on `/signup/check-email` and `/forgot-password` confirmation; (b) document this as a known observability gap in `docs/operational-runbook.md`; (c) the implementation plan should evaluate configuring Supabase's SMTP through Resend (Supabase dashboard → Auth → SMTP Settings) so confirmation emails feed our existing bounce + delivery telemetry. The SMTP swap is a deployment task, not a code change. |
| Owner signs up, confirms, doesn't pay for weeks        | Cleanup poller removes after 7 days. Pre-cleanup, owner can log in and sees the "complete your payment" banner.                                |
| Google-signup owner later forgets which provider used  | `/login` password attempt against a Google-only account fails with Supabase's default "Invalid login credentials" — not ideal but acceptable MVP. |
| Race: two concurrent signups with same email           | `users.email` unique constraint + explicit 409 handling in `createBusinessTx` + auth user cleanup on race loss.                                 |
| Orphaned Supabase Auth users if our DB insert fails after `auth.signUp` succeeds | The signup route catches DB errors and attempts `auth.admin.deleteUser(authId)` as compensating action. Failures logged for manual cleanup. |
| Dashboard banner creates confusion for `past_due` businesses (existing users, not new signups) | Banner copy branches: `pending_payment` → "complete payment"; `past_due` → "update payment method" (links to Stripe customer portal — already exists). |
| Confirmation email expires (Supabase 24h default) before owner clicks | "Resend confirmation" button on `/signup/check-email` (see §11). Calls `supabase.auth.resend({ type: 'signup' })`, rate-limited 2/hour per email + IP. Documented as the supported recovery path. |
| Two-tab cosmetic race: tab A clicks confirm while tab B attempts password login | Tab B sees "Email not confirmed" briefly even though tab A is mid-confirm. Cosmetic only — Supabase serializes per-user, so no state corruption. The new `Email not confirmed` UX branch (see §1.2 routing block) re-routes to `/signup/check-email` instead of showing the raw error, which masks the cosmetic issue. |

---

## Appendix A — File inventory

**New files:**

- `src/app/(public)/signup/page.tsx`
- `src/app/(public)/signup/check-email/page.tsx`
- `src/app/(public)/signup/finish/page.tsx`
- `src/app/(public)/login/page.tsx`
- `src/app/(public)/forgot-password/page.tsx`
- `src/app/(public)/reset-password/page.tsx`
- `src/app/admin/forgot-password/page.tsx`
- `src/app/admin/reset-password/page.tsx`
- `src/app/onboarding/pay/page.tsx`
- `src/app/onboarding/payment-success/page.tsx`
- `src/app/api/auth/signup/route.ts`
- `src/app/api/auth/finish-signup/route.ts`
- `src/app/api/auth/signup-status/route.ts`
- `src/app/api/auth/forgot-password/route.ts`
- `src/app/api/auth/reset-password/route.ts`
- `src/app/api/auth/resend-confirmation/route.ts` — POST: takes `{ email, flow }`, calls `supabase.auth.resend({ type: 'signup' })`. Rate-limited 2/hour per email + IP via strict `checkRateLimit`. Generic 200 on no-row.
- `src/lib/onboarding/create-business.ts`
- `src/lib/onboarding/__tests__/create-business.test.ts`
- `src/lib/payments/payment-link.ts` — shared `buildPaymentLinkUrl(tier, businessId, ownerEmail)` extracted from `src/app/api/admin/businesses/route.ts:105`. Used by signup, admin onboarding, and the dashboard pending-payment branch.
- `src/lib/payments/__tests__/payment-link.test.ts`
- `src/lib/shared/csrf.ts` — `assertSameOrigin(request)` helper used by `/api/auth/finish-signup` and `/api/auth/reset-password` (see §8.5).
- `src/lib/shared/__tests__/csrf.test.ts`
- `src/lib/shared/auth-flow.ts` — `AuthFlow` type, `isAuthFlow`, `loginUrlForFlow`, `resetPasswordPathForFlow` (see §6.1). Single source of truth for the `flow=` query-param contract used by callback handler, forgot-password, reset-password, middleware redirect builders.
- `src/lib/shared/__tests__/auth-flow.test.ts`
- `src/lib/auth/route-helpers.ts` — composable `withRateLimit` / `withSameOrigin` / `withSession` wrappers for the new auth API routes (see §6.1). Eliminates boilerplate duplication across the five new endpoints.
- `src/lib/auth/__tests__/route-helpers.test.ts`
- `src/components/auth/LoginFormClient.tsx` — shared client component used by both `/login` and `/admin/login`. Props: `{ portal, brandName, showGoogleButton, defaultRoute, allowedRoles }`. See §6.1.
- `src/components/auth/ForgotPasswordFormClient.tsx` — shared client component used by both `/forgot-password` and `/admin/forgot-password`. Props: `{ portal, brandName }`.
- `src/components/auth/ResetPasswordFormClient.tsx` — shared client component used by both `/reset-password` and `/admin/reset-password`. Props: `{ portal, brandName }`.
- `src/components/auth/__tests__/*` — one test file per shared component, covering both portal modes.
- `src/app/api/auth/__tests__/signup.test.ts`
- `src/app/api/auth/__tests__/finish-signup.test.ts`
- `src/app/api/auth/__tests__/forgot-password.test.ts`
- `src/app/api/auth/__tests__/reset-password.test.ts`
- `src/app/api/auth/__tests__/signup-status.test.ts`
- `src/lib/shared/__tests__/protected-routes.test.ts`
- `worker/jobs/CleanupAbandonedSignupsPoller.ts`
- `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts`
- `worker/__tests__/stripe-activation-enqueue.test.ts` — webhook idempotent sync enqueue
- `supabase/migrations/025_signup_schema.sql` — two partial indexes (`idx_businesses_pending_unpaid_self_serve_cleanup`, `idx_users_owner_auth_by_business` — see §2.2) with `COMMENT ON INDEX` for both, the email-normalization collision check + lowercase backfill (§2.3), and the `onboarded_by` backfill with admin-presence precondition (§1.6 "Admin onboarding update"). Auth-id uniqueness is already enforced by migration 001's `UNIQUE` constraint on `users.auth_id` (see §3.6). Block ordering documented in §2.3. No new columns — `businesses.google_maps_url` already exists from migration 007 and is already populated by admin onboarding
- E2E: `tests/e2e/signup-password.spec.ts`, `tests/e2e/signup-google.spec.ts`, `tests/e2e/forgot-password.spec.ts`, `tests/e2e/reset-password.spec.ts`

**Modified files:**

- `src/app/api/admin/businesses/route.ts` — refactored to call `createBusinessTx(input, { mode: 'admin', onboardedBy: <adminId> })`. Inline `buildPaymentLinkUrl` removed — now imported from `src/lib/payments/payment-link.ts`. No behavior change to admin flow.
- `src/app/api/auth/callback/route.ts` — `flow` query-param branching (owner vs admin), recovery-type branch routing to reset-password pages, "Google signup no users row" branch routing to `/signup/finish`.
- `src/app/api/dashboard/route.ts` — early branch on `subscription_status='pending_payment'` returns minimal `{ businessId, businessName, subscriptionStatus, paymentUrl }` payload, skipping the 8-query block.
- `src/middleware.ts` — new `/onboarding/*` gate, new public paths, role-aware redirect URL on auth failure for owner vs admin flows.
- `src/lib/shared/protected-routes.ts` — exempt `/admin/forgot-password` + `/admin/reset-password`. Tests added.
- `src/app/(authenticated)/dashboard/...` layout — render minimal "complete payment" banner when API returns the `pending_payment` minimal payload.
- `src/app/admin/login/page.tsx` — "Forgot password?" link → `/admin/forgot-password`.
- `src/app/(public)/page.tsx` — landing nav additions ("Log In", "Sign Up") — server-rendered, gated on `SELF_SERVE_SIGNUP_ENABLED`.
- `worker/ingress/stripe.ts` — `processCheckoutSessionCompleted` extended (§1.6): wraps activation in `sql.begin` with `pg_advisory_xact_lock(hashtext(business_id || ':activation'))`, then idempotent INSERT of initial sync outbox entry scoped to self-serve via combined predicate `onboarded_by IS NULL AND auth_id IS NOT NULL`.
- `worker/index.ts` — register `startCleanupAbandonedSignupsPoller()` when `SELF_SERVE_SIGNUP_ENABLED='true'`. Add `assertSelfServeSignupEnv` startup assertion.
- `src/lib/shared/rate-limit.ts` — no changes; callers pass `strict: true`.
- `src/lib/shared/schemas.ts` — new `SignupSchema` + `FinishSignupSchema` with explicit `ownerName`/`businessName` fields (no overloaded `name`). New normalized `BusinessTxInput` shape consumed by `createBusinessTx`.
- `.env.example` — `SELF_SERVE_SIGNUP_ENABLED`, `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` (optional).
- `docs/operational-runbook.md` — note that Supabase confirmation/recovery emails do NOT feed Resend bounce telemetry (until SMTP swap).

**Migrations:** `025_signup_schema.sql` — one migration with explicit block ordering (§2.3): two partial indexes (§2.2 `idx_businesses_pending_unpaid_self_serve_cleanup`, `idx_users_owner_auth_by_business`) with `COMMENT ON INDEX` for both, then the email collision-check + lowercase backfill (§2.3), then the one-time `onboarded_by` backfill with admin-presence precondition (§1.6). Auth-id uniqueness is covered by migration 001's existing `UNIQUE` constraint (see §3.6). No new columns.

---

## Appendix B — Open items to confirm before implementation

Non-blocking. These can be nailed down during implementation planning (`writing-plans` stage):

1. Exact Playwright fixture approach for mocking Google OAuth — the standard pattern is to short-circuit the OAuth round-trip by directly setting a Supabase session cookie in the test harness. Implementation plan resolves.
2. Exact rate-limit values — numbers above (`5/hour per IP`, etc.) are reasonable defaults matching the existing `checkRateLimit` pattern; implementation plan can propose tuning based on expected traffic.
3. Dashboard banner copy wording — UX polish; not architecturally material. Implementation plan drafts the copy; design tweak during review.
