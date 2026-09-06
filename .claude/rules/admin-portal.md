---
paths:
  - "src/lib/admin/**"
  - "src/lib/onboarding/**"
  - "src/app/admin/**"
  - "src/app/api/admin/**"
---

# Admin portal rules

## Read first

- Admin invite funnel (the 3-field admin form, `resolveFunnelEntry`/`funnelUrl`, the **Beta comp coupon**, the `checkout_attempt_*` snapshot, resend-invite): plan `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md` + `docs/context/admin-invite-funnel.md` → **Admin invite**, **Checkout attempt**, **Funnel entry**, **Beta comp coupon** (four LOCKED terms). Rules + why: `docs/directory/lib-admin-onboarding-payments.md` § `onboarding/`.
- Admin business query (`/admin/overview`, `/admin/businesses`, the **At-risk list**, the **Business summary** DTO): `docs/context/core-accounts-channels-admin.md` → **Business summary** + **At-risk list** (LOCKED) + spec `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §5. Rules + why: `docs/directory/lib-admin-onboarding-payments.md` § `admin/`.
- Route pages: `docs/directory/app-admin.md` (`src/app/admin/`), `docs/directory/app-api-a.md` (`src/app/api/admin/`).
- Admin channel routes under `src/app/api/admin/channels/**` are governed by `.claude/rules/channels.md`; admin autonomy routes by `.claude/rules/agentic-platform.md`.

## Traps

Admin invite funnel:

- (a) every Stripe Session parameter comes from the durable `accounts.checkout_attempt_*` snapshot, never a live env read; (b) `resolveFunnelEntry` is **pure** — flag state is passed in, never read; (c) `onboarded_by` on the PRIMARY business is the comp's only eligibility marker and already carries three meanings — read the rejected-finding record before widening it.

Admin business query:

- (a) the at-risk list is **filtered THEN capped**; (b) ranking is TypeScript and must never become `ORDER BY … LIMIT`; (c) Businesses fetches metrics for the current page's ids only.

## Rules

- `src/lib/admin/business-summary.ts` is the single owner of the query (`getBusinessSummaries`) and of churn derivation; `HealthBadge.tsx` owns health presentation.
- The admin MFA gate sentence (`ci:admin-aal2`) lives in `.claude/rules/channels.md` § Traps; it governs every `src/app/api/admin/**` route.
