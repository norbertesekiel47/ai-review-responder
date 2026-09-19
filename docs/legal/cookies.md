# Cookie Policy

Version: 2026-09-16
Effective date: 2026-09-16
Legal review status: pending lawyer review

Review copy of `src/lib/legal/content.ts`. Keep this file synchronized with the route-backed document; see `legal-review.md` for publication status and open questions.

## Cookies

Cookies are small browser records; local storage and session storage perform related functions. RepWorth uses these technologies for login, security, approvals, preferences, and product analytics. Not every item below is set on every visit.

Necessary storage supports functions you request. Analytics storage is a separate purpose and is not made strictly necessary simply because it is first-party or handled by our servers.

## Analytics

When the product analytics endpoint accepts an event, it sets or refreshes rw_analytics_id, a first-party pseudonymous identifier with a maximum age of one year. This links product interaction events. Events are recorded on our servers and sent to PostHog when configured; no PostHog browser SDK is required for that processing.

This identifier is used for product measurement, not cross-context advertising. Deleting it does not delete events already recorded, and later interactions may set a new identifier. Contact support@repworth.net about privacy requests. See /legal/privacy for the information collected and how it is used.

## Storage Used by the Service

The lifetimes below reflect application settings; session refresh, sign-out, clearing storage, or provider settings can change how long a particular record remains.

| Storage | Purpose | Lifetime |
| --- | --- | --- |
| Supabase authentication storage (sb-* cookies) | Sign-in and session refresh | Managed by the authentication session and refreshed as needed |
| __device and __csrf | Approval-device binding and request security | Up to 48 hours |
| zernio_connect_session | Securely complete a Google connection | Up to 15 minutes |
| rw_delete_data_fresh_auth | Confirm recent authentication for account deletion | Up to 10 minutes |
| rw_location_scope | Remember the selected business location | Up to one year |
| rw_impersonation | Authorized support-session control | Limited to the support session |
| rw_analytics_id | Pseudonymous product analytics | Up to one year; renewed on accepted events |
| Browser session storage | Carry an entered email between sign-in/signup steps | Cleared on use or when the tab session ends |
| Browser local storage | Remember dismissal of an account-status notice | Until cleared or replaced |

## Third-party Services

Payment checkout, Google connection or place lookup, bot protection, and messaging services may use their own storage when you interact with them. Those providers explain their practices in their privacy notices. Our Sentry configuration disables session replay.

## Managing Cookies

You can control cookies through your browser settings, but blocking necessary cookies may prevent login, approval, or account-management flows from working.

You can also clear local and session storage in your browser. These controls do not cancel a subscription, remove provider records, or replace a request to delete personal information. We do not currently provide an in-product cookie-preference center. For assistance, contact support@repworth.net.
