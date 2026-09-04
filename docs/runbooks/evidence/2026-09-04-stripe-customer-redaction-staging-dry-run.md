# Stripe Customer redaction — staging dry-run evidence

**Date:** 2026-09-04 · **Deployed SHA:** `dd883b1a` (staging worker deploy
`3f2a246d`, SUCCESS 19:55:01Z) · **Environment:** staging (Railway worker +
staging Supabase `kubdiqdhqbhwmqfditeg` + Stripe test mode `acct_1TUcR7IhPBLaM6xA`)

## Why this dry-run exists

#1121 shipped **Stripe Customer redaction** with 575 lines of unit and
integration tests, all against an injected fake client. Nothing had ever called
the real Stripe API. The purge is irreversible and the stage runs first, so a
wrong payload would be discovered on a customer, not in CI.

## Subject

Yesterday's `delete_data` offboarding, left in `purge_scheduled`:

| Field | Value |
|---|---|
| offboarding | `01a066ae-68b3-7688-a786-2ea8f5fcdf7e` |
| account | `01a0669b-de20-70b6-ba03-9e13e323d0b3` ("Tanicia Resort") |
| Stripe Customer | `cus_VBusqjQK7Itbne` (test mode) |
| attached PaymentMethod | `pm_1UBX2GIhPBLaM6xAWVITjJin` |

The shared-customer guard could not skip: no other account held that customer
id, so the stage ran for real.

## Procedure

| # | Step | Result |
|---|---|---|
| 1 | Confirm `origin/staging` contains the fix | `dd883b1a`, level with `main` |
| 2 | Confirm the deployed worker runs it | deploy `3f2a246d` at `dd883b1a`, SUCCESS |
| 3 | Capture the Stripe baseline | below |
| 4 | Snapshot all 6 staging accounts' child row counts | below |
| 5 | Move `purge_after` into the past | **REFUSED** by a DB trigger — see Finding 1 |
| 6 | Move the keep-my-data token expiry back first, then `purge_after` | accepted 20:22:45Z |
| 7 | `AccountOffboardingPurgePoller` claims and purges | 20:22:56.643Z → 20:23:02.419Z |
| 8 | Verify at Stripe | below |
| 9 | Verify no cross-tenant damage | below |

Time-travel preserved the production relationship: at day 30 the token
`expires_at` and `purge_after` are equal, so the trigger never fires there. The
token was moved to `now() - 2 min` and `purge_after` to `now() - 1 min`.

## Timing

```
20:21:45.793Z  purge_after set into the past
20:22:56.643Z  purge_started_at        (poller claimed, ~11s after trigger)
20:22:59.276Z  stripe_customer_redaction recorded, outcome = redacted
20:23:02.419Z  purged_at = terminal_at
```

Total 5.8 seconds. `retry_count` 0, `last_error` null.

## Stripe Customer — before and after

| Field | Before | After |
|---|---|---|
| `name` | `Norbert E Sunn` | `null` |
| `email` | `norbertliverpool@gmail.com` | `null` |
| `phone` | null | `null` |
| `description` | null | `null` |
| `address` | `{country: US, postal_code: 90007}` | `null` |
| `shipping` | null | `null` |
| `metadata` | `{}` | `{repworth_redacted_offboarding_id: 01a066ae-…}` |
| attached PaymentMethods | 1 | **0** |
| `deleted` | null | **null** — the Customer was not deleted |

`provider_dispositions[0]`:

```json
{"type":"stripe_customer_redaction","outcome":"redacted","provider":"stripe",
 "recorded_at":"2026-09-04T20:22:59.276Z",
 "stripe_customer_id_hash":"sha256:39068ecf11bc489128f3885af60ed9bbdbfabac567eb76f4cb0f4d0a6c359751"}
```

`sha256("cus_VBusqjQK7Itbne")` computes to the same digest. The raw id was never
written.

## Database after-state

`accounts.display_name` → `Deleted account`, `stripe_customer_id` → NULL.
Reviews 32→0, responses 15→0, agent runs 21→0, channel enrollments 1→0.
`users` tombstoned to `Deleted user` / `deleted-<id>@repworth.invalid`,
`auth_id` NULL. `businesses` tombstoned to `Deleted location`.
`auth.users` 9→8 — `f728d1ce-…` deleted. The keep-my-data token row is gone.

## No cross-tenant damage

Five other accounts were live on staging during the purge. Their
`(businesses, reviews, responses, agent_runs, users, channels)` counts and their
`stripe_customer_id` values are byte-identical before and after:

| Account | Before | After |
|---|---|---|
| `01a06713` Tanicia Resort (pending_payment) | 1,0,0,0,1,1 | 1,0,0,0,1,1 |
| `01a06861` ASH (trialing) | 1,0,0,0,1,1 | 1,0,0,0,1,1 |
| `01a0691d` Robert Industry (trialing) | 1,0,0,0,1,1 | 1,0,0,0,1,1 |
| `01a06dd3` Tanicia Resort Testing (active) | 1,0,0,0,1,1 | 1,0,0,0,1,1 |
| `01a06de4` Studio6 (trialing) | 1,0,0,0,1,1 | 1,0,0,0,1,1 |

## Finding 1 — a DB trigger blocked the first attempt, correctly

`enforce_account_offboarding_purge_after_token_expiry` raises when an
unconsumed, unrevoked keep-my-data token has `expires_at > purge_after`. The
owner's link stays honourable for its full life. In production both timestamps
are written from the same `NOW() + 30 days`, so it never fires. **Working as
designed**; recorded because it shapes how any future dry-run must time-travel.

## Finding 2 — the detached PaymentMethod is a retention, not an erasure

`CONTEXT.md` said a PaymentMethod's data *"is deletable"* unlike a paid invoice,
and the redaction module's header said leaving it *"would be an erasure gap
rather than an unavoidable retention."*

Both were wrong. Stripe exposes `detach` and no delete. After a completed purge,
`pm_1UBX2GIhPBLaM6xAWVITjJin` still returns:

```
customer                            = null      (detach worked)
billing_details.name                = "Norbert E Sunn"
billing_details.email               = "norbertliverpool@gmail.com"
billing_details.address.postal_code = "90007"
card.last4                          = "4242"
```

Detaching unlinks the method and prevents reuse. It does not erase it, and the
object stays retrievable by id. Corrected in this PR: a second
**Provider data retention** entry, the term, the module header, the privacy
policy and the purge receipt.

## Retained as documented

Invoice `in_1UBX2H…` keeps `customer_name`, `customer_email` and
`customer_address`. That matches the Stripe Customer inventory entry and both
disclosures. Correct as designed.

## Not tested

This invoice was a zero-amount Beta comp, so `charge` and `payment_intent` were
both null. A paying account's invoice carries a charge, and a charge holds its
own `billing_details` snapshot plus the PaymentMethod id — a possible third
retention surface and a path back to the detached method. **Unverified.**
