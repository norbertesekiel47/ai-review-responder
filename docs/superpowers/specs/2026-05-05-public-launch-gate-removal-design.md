# Public Launch Gate Removal

**Date:** 2026-05-05  
**Status:** Approved design, awaiting implementation plan  
**Purpose:** Launch the full RepWorth app on the public domain by removing the old `repworth.net` coming-soon gate while preserving normal route protection and unrelated product placeholders.

## Goal

`repworth.net` should behave like every other production host for this Next.js app. Public marketing pages, auth pages, owner dashboard pages, admin pages, APIs, and onboarding routes should no longer be blocked by hostname-specific coming-soon middleware. Existing authentication and authorization rules must continue to protect owner/admin surfaces.

## Scope

Remove only the public-site launch gate:

- Remove the `repworth.net` / `www.repworth.net` special-case block from `src/middleware.ts`.
- Remove `x-coming-soon` request-header injection and all public-page reads of that header.
- Remove `comingSoon` props and conditional branches from the public marketing components that were only serving the launch gate.
- Keep `SELF_SERVE_SIGNUP_ENABLED`; signup/login/onboarding availability still depends on that product flag.
- Keep unrelated product placeholders such as dashboard channel rows that display "Coming soon" for not-yet-launched channels.

## Current Behavior

The middleware currently checks the request `Host` header before normal route protection. For `repworth.net`, it allows only `/`, `/privacy`, `/terms`, `/features`, and `/how-it-works`; those routes receive `x-coming-soon: 1`. Every other route on `repworth.net` redirects to `/`. The public pages read the header and render reduced CTAs such as "Coming Soon" and "Launching soon".

Localhost and non-`repworth.net` hosts skip this coming-soon block and follow normal public/protected route behavior.

## Target Behavior

All hosts, including `repworth.net`, enter the same route path:

1. Static assets are excluded by the existing middleware matcher.
2. Public routes pass through without Supabase work.
3. Protected admin, owner, dashboard, settings, API, and onboarding routes use the existing Supabase-backed auth checks.
4. Public marketing pages always render the launched experience: Book a Demo navigation, Book a Demo hero CTA, and contact form CTA.

`www.repworth.net` canonicalization should be handled outside this codebase by the hosting/domain configuration if still desired. The app should not preserve the middleware-level `www` redirect because it was part of the coming-soon hostname special case.

The launch-gate removal does not turn on self-serve signup by itself. If owner login, signup, and onboarding should be reachable in production at launch, the production environment must already have `SELF_SERVE_SIGNUP_ENABLED=true`. This code change only stops the `repworth.net` hostname from redirecting those routes before the page-level flag checks run.

## Files To Change

### `src/middleware.ts`

Delete the host-specific block:

- `www.repworth.net` redirect to apex.
- `repworth.net` allow-list.
- `x-coming-soon` request-header injection.
- redirect of every other path to `https://repworth.net/`.

Leave the existing public-route fast path and protected-route auth logic in place.

### Public Page Wrappers

Remove `headers()` reads and `x-coming-soon` checks from:

- `src/app/(public)/page.tsx`
- `src/app/(public)/features/page.tsx`
- `src/app/(public)/how-it-works/page.tsx`
- `src/app/(public)/privacy/page.tsx`
- `src/app/(public)/terms/page.tsx`

Remove `export const dynamic = 'force-dynamic'` where it exists only to read headers.

### Public Components

Simplify launch-gate props and branches:

- `src/components/ui/SiteNav.tsx`
  - Remove `comingSoon?: boolean`.
  - Always include the "Book a Demo" nav link.
  - Keep `selfServeEnabled?: boolean` for Log In / Sign Up.
- `src/components/sections/landing/LandingContent.tsx`
  - Remove required `comingSoon` prop.
  - Always include the Book a Demo dot-nav item.
  - Always render the Book a Demo hero button.
  - Always render the full contact form CTA.
- `src/components/sections/features/FeaturesContent.tsx`
  - Remove `comingSoon` prop and render the normal CTA.
- `src/components/sections/how-it-works/HowItWorksContent.tsx`
  - Remove `comingSoon` prop and render the normal CTA.

## Out Of Scope

- Removing product-specific "Coming soon" indicators for SMS, WhatsApp, Telegram, pricing tiers, or roadmap messaging.
- Changing `SELF_SERVE_SIGNUP_ENABLED` behavior.
- Changing domain/DNS/Vercel settings.
- Changing authentication, authorization, or protected route semantics.
- Redesigning the landing page.

## Verification

Implementation should verify:

- No `x-coming-soon` references remain.
- No public marketing page imports `headers` solely for coming-soon mode.
- `repworth.net` host requests are no longer treated specially by middleware.
- TypeScript/build passes.
- If lint is run and unrelated baseline failures remain, they are reported separately.

Useful checks:

```powershell
rg -n "x-coming-soon|comingSoon|host === 'repworth.net'|www\.repworth\.net" src
pnpm build
```

## Rollback

If launch needs to be paused, rollback should be handled by reverting the implementation commit or by adding a new explicit launch flag in a separate change. This design intentionally does not keep a dormant coming-soon switch in the app because the launch goal is to remove the hostname gate cleanly.
