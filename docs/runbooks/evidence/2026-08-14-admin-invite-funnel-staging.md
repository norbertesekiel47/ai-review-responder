# Staging evidence — admin-invite-funnel (Phase F smoke)

Date: 2026-08-14 · Branch `admin-invite-funnel` · PR #821
Environment: staging (`staging.repworth.net`) · Supabase `kubdiqdhqbhwmqfditeg` · Stripe `acct_1TUcR7IhPBLaM6xA` **test mode**

## Result: PASS

An owner walked the whole **Admin invite** journey and reached the dashboard with an `active` **Account**.

## Preconditions applied

| Item | Value | Verified how |
|---|---|---|
| Migration 105 | applied | `checkout_attempt_coupon_id` present; null-at-rest branch of `accounts_checkout_attempt_complete_check` requires it NULL |
| Migration 106 | applied | `checkout_coupon_decision` present in `analytics_events_event_name_check` |
| **Beta comp coupon** | `beta_comp_3mo` | 100% off, `repeating`, 3 months, `valid: true` |
| `BETA_COMP_COUPON_ID` | set (staging custom env) | write-only (sensitive env) — proven only by the checkout below |
| `ONBOARDING_DEMO_ENABLED` | `true` (staging custom env) | `/onboarding/start` and `/onboarding/demo` return **307 → /login** instead of 404 |
| Always-on auth surfaces | reachable | `/login`, `/forgot-password`, `/reset-password` all **200** with `SELF_SERVE_SIGNUP_ENABLED` unchanged |

## Checkout evidence

Subscription `sub_1U4P38IhPBLaM6xAHjxEKDvl`

| Assertion (plan step 11c) | Observed | Verdict |
|---|---|---|
| $0 due today | invoice `in_1U4P37IhPBLaM6xAE3NIfaXp` — **total `0`**, status `paid` | PASS |
| Card still collected | `default_payment_method: pm_1U4P36IhPBLaM6xAZpDDQXub` | PASS |
| Subscription active, carrying the discount | `status: active`; discount `di_1U4P37IhPBLaM6xADAyKzSsp`, `source.coupon = "beta_comp_3mo"` | PASS |
| Month 4 at full price | discount runs **2026-08-14 → 2026-11-14** (exactly 3 months); item price `1900` cents resumes after | PASS |
| Owner reaches the dashboard | confirmed by the operator walking the funnel | PASS |

`payment_method_collection: 'always'` is what makes row 2 hold — a 100%-off subscription session does not otherwise guarantee card capture, which would surface as a failed charge in month 4.

## Defect found and fixed during this smoke

The **first** attempt failed at `/onboarding/pay` with:

```json
{ "error": "checkout_error",
  "detail": "Unable to connect to payment provider. Please try again later." }
```

Root cause: Stripe rejects `allow_promotion_codes` and `discounts` **by parameter presence, not by value** — sending `allow_promotion_codes: false` beside `discounts` fails the whole request. The locked plan asserted the opposite and the claim survived four adversarial review rounds and every unit test, because the tests mock Stripe. Full write-up: deviations **D-16**.

Fixed in `buildCheckoutSessionParams` (omit the key on the coupon path) plus an invariant test that the two keys never coexist. `CheckoutCouponConfigurationError` is now mapped in `/api/onboarding/select-plan` so a coupon fault no longer hides behind a generic connection message.

## D-13 — resend-invite provider contract: VERIFIED 2026-08-14

Probed directly against the staging Supabase project with the staging service key,
`@supabase/supabase-js` **2.106.2**, using throwaway addresses
(`norbertesekiel+d13probe@gmail.com` / `+d13probe2@`). The probe user was deleted
in both runs — staging left as found.

Run twice on purpose: once over raw HTTP to see the wire body, once through the
real client to see what the client hands our code. The second run is the one that
mattered.

| Step | Observed |
|---|---|
| Invite a fresh address | HTTP 200. `invited_at` set, `confirmed_at` null, `last_sign_in_at` **null** |
| **Re-invite while still pending** | **HTTP 200 — succeeds and re-sends.** The legitimate admin resend works; Supabase does not refuse it |
| Admin `updateUserById({ password, email_confirm: true })` | HTTP 200 — `last_sign_in_at` **stays null** |
| Real `signInWithPassword` | HTTP 200 — `last_sign_in_at` **now populated** |
| **Re-invite once accepted** | `AuthApiError { code: 'email_exists', status: 422, message: 'A user with this email address has already been registered' }` |

**Three findings.**

1. **The eligibility premise holds.** `last_sign_in_at` is null until a *real*
   sign-in and is unaffected by an admin password-set, so it is a sound proof of
   acceptance. D-13 said "if it did not, the `last_sign_in_at` premise is wrong
   and THAT is the finding" — it did hold, so there is no finding there.
2. **`email_exists` → 409 is confirmed end to end**, so that
   `INVITE_ERROR_CODE_MAP` entry is evidence rather than assumption. The
   pre-existing unit test already used exactly this shape — it was guessing
   correctly.
3. **The narrow escape worth remembering.** The raw wire body carries BOTH a
   numeric `code: 422` and `error_code: 'email_exists'`.
   `mapInviteProviderError` keys on `error.code` typed `string`, so the whole
   table's reachability rests on the client surfacing the STRING — which 2.106.2
   does. Had it passed the number through, every branch would have been dead code
   and every invite error would have fallen to the 502 fallback, silently. That
   dependency is now pinned by a test (`falls back to 502 when the provider
   reports a NUMERIC code`).

**Deliberately still unverified:** the exact rate-limit code and the four
`INVITE_REJECTED` codes. Probing them means exhausting a mail budget or breaking
SMTP, and it would change nothing — the `providerStatus === 429` secondary key
catches any rate-limit error regardless of code, so those entries are
redundant-but-harmless rather than load-bearing.

## Still outstanding

- **Resend invite, UI half** — the provider contract above is verified, but the
  admin button itself (AAL2 + the `/admin/businesses/[id]` control, and that the
  re-sent link actually works from the mailbox) has not been clicked on staging.
  The mapping is no longer the risk; the wiring is.
- **Production** — gated on the WS8 cutover. 077/078 are absent in prod and 105 rewrites a constraint over 077's columns, so **105 must not be applied to prod before that cutover**. No live-mode coupon exists; `ONBOARDING_DEMO_ENABLED` is still empty (off) on preview/production.
