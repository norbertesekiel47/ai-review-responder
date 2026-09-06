# Lab notes — Billing / multi-location

## Summary

- **Billing / multi-location** — stored-quota vs TIER_CONFIG, base price not grandfathered, channel account-scope desync

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-05.md § "`archived_at` is a separate skip from the subscription guard"
- history/2026-05.md § "Billing snapshot: read STORED quota, not `TIER_CONFIG` — but base price has no stored column"
- history/2026-05.md § "Don't gate three different questions with one location-count boolean"
- history/2026-05.md § "Owner channel enrollment: display reads by `account_id`, runtime keys by `business_id` → multi-location desync"
- history/2026-05.md § "Account-scoping a shared helper requires updating ALL call sites — TS + mocked tests won't catch a miss"
- history/2026-05.md § "Billing reconciliation must compute expected invoice from STORED quota, not live `TIER_CONFIG`"
- history/2026-05.md § "One past-due recovery clock, read DOWN, and clamp future timestamps"
- history/2026-05.md § "Grant-extension `expires_at` must be `max(graceDeadline, now) + days`"
- history/2026-05.md § "A new owner data endpoint must replicate the subscription read-entitlement gate"
- history/2026-06.md § "2026-06-09 — Billing compliance hardening"
- history/2026-06.md § "2026-06-11 — Multi-location two-location full-loop sign-off run"
- history/2026-06.md § "2026-06-22 — Card-up-front trial: bugs only a live staging E2E catches (PR #362)"
- history/2026-06.md § "A trial can't onboard when `ONBOARDING_DEMO_ENABLED=true` (infinite redirect loop)"
- history/2026-06.md § "Trial start must mirror `businesses.subscription_activated_at` or onboarding drips die for trials"
- history/2026-07.md § "2026-07-16 — WS8 tier-cutover promotions (claude-mem sweep)"
- history/2026-08-13-to-21.md § "2026-08-14 — admin invite funnel: four ways a mocked provider lies"
