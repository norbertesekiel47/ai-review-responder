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

## Still outstanding

- **Resend invite** — the Supabase provider-error mapping (`INVITE_ERROR_CODE_MAP`) is still unverified against a real re-invite. D-13.
- **Production** — gated on the WS8 cutover. 077/078 are absent in prod and 105 rewrites a constraint over 077's columns, so **105 must not be applied to prod before that cutover**. No live-mode coupon exists; `ONBOARDING_DEMO_ENABLED` is still empty (off) on preview/production.
