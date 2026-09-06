## `src/app/`

Next.js App Router pages, grouped by access level.

### `(public)/` — No login required

| Path | What it does |
|------|--------------|
| `page.tsx` | Landing page. Resolves three server-authoritative values and delegates everything else to `LandingExperience`: `SELF_SERVE_SIGNUP_ENABLED` (gates the nav's Log in / Sign up pair — **as of 2026-08-14 this is a posture choice, not a 404-correctness one**: `/signup` still `notFound()`s without the flag, but `/login` is now always-on, so hiding the pair is about not advertising anonymous signup to strangers, which is precisely what the re-scoped flag means; an invited owner reaches `/login` by its URL from the invite flow, not from this nav), the CTA target (`/signup`, else `/book-a-demo`), and the CTA label (the trial offer only when `TRIAL_ENABLED` **and** self-serve are both on — there is no signup to start a trial from otherwise). No `NEXT_PUBLIC_*` companion for any of them (invariant #13). It does **not** read an `x-coming-soon` header; the `comingSoon` prop still exists on `SiteShell`/`SiteNav` for the other public pages, but the landing page has never consumed it. |
| `_styles/` | **(PR 3b)** The Island's marketing **page** CSS, mirroring `(authenticated)/_styles/` for the Console: `island.css` (shared island chrome — `.rw-island`, `.rw-foot`, `.rw-dot-nav` — plus the `.rw-marquee-field` atmosphere and the original landing chrome), `features.css`, `how-it-works.css`, `pricing.css`. Extracted from `globals.css`, which keeps only the Island **tokens** + `@theme inline` and `@import`s these four at the bottom of the file, in that order. The order is the cascade and the `@import` (rather than a `layout.tsx` import) is what keeps Tailwind processing them — see the closing comment in `globals.css`; guard `src/__tests__/design-scope-purity.test.ts`. Style Reference: [`docs/design/island/DESIGN.md`](./design/island/DESIGN.md). |
| `login/page.tsx` | Owner login page. Renders `LoginFormClient`. |
| `login/error.tsx` | Error boundary for the login flow. |
| `signup/page.tsx` | Self-serve signup entry. Collects email. |
| `signup/error.tsx` | Error boundary for signup. |
| `signup/SignupFormClient.tsx` | Form component. Rate-checks via `checkRateLimit`, then POSTs to `/api/auth/signup`. |
| `signup/check-email/page.tsx` | "Check your inbox" screen. |
| `signup/check-email/CheckEmailClient.tsx` | Polls `/api/auth/signup-status` until confirmation completes. |
| `signup/finish/page.tsx` | Server shell for the Google OAuth finish-signup step. |
| `signup/finish/FinishSignupClient.tsx` | Second signup step (after Google OAuth). Collects business name, Place ID, tone, etc. POSTs to `/api/auth/finish-signup`. |
| `forgot-password/page.tsx` | Request a password reset email. |
| `reset-password/page.tsx` | Consume the reset token and set a new password. |
| `u/[token]/page.tsx` | **(#644)** The recipient unsubscribe landing page. Three states from one URL: the **button page** (names the originating business, or "the business that contacted you" when provenance was purged), the **success page**, and the **Neutral page** — one identical render for unknown, malformed *and* already-redeemed tokens, so no caller can tell them apart (§5.4). Success requires a verifying Success receipt **and** a live global suppression read **during that render**: a receipt proves a row existed when it was minted, and the Correction path can remove it inside the 10-min TTL. Plain `<form method="post">`, no client component — it works with JS disabled. |
| `approve/[token]/page.tsx` | Approval page reached via a notification link. Server component loads the approval context. |
| `src/components/approval/approval-client.tsx` | Interactive Approve / Edit / Regenerate UI (lives under `src/components/`, not `(public)/`). **(WS4)** also renders the scheduled-auto-post state (`ScheduledAutoPostView`): a response in `approved`/`auto_policy` with a future `auto_post_scheduled_at` shows "posts at HH:MM UTC" + a **Cancel auto-post** action → POST `/api/approve/[token]/veto`. |
| `demo/[slug]/page.tsx` | Public demo page for a prospect. |
| `book-a-demo/page.tsx` | Demo booking form → `/api/demo-request`. |
| `features/page.tsx` | Features marketing page. |
| `features/FeaturesContent.tsx` | Features page content component. |
| `how-it-works/page.tsx` | How-it-works marketing page. |
| `how-it-works/HowItWorksContent.tsx` | How-it-works content component. |
| `pricing/page.tsx` | Pricing marketing page. |
| `terms/page.tsx` | **(Wave 1)** 308-redirects to `/legal/terms` (`permanentRedirect`). Canonical content moved to `/legal/*`; `next.config.mjs` `redirects()` also covers this at the routing layer. |
| `privacy/page.tsx` | **(Wave 1)** 308-redirects to `/legal/privacy`. |
| `legal/{terms,privacy,aup,dpa,cookies,sub-processors}/page.tsx` | **(Wave 1)** Canonical legal pages. Each renders `<LegalPage doc={legalDocs[...]} />` from the typed content module `src/lib/legal/content.ts` (no MDX). Sub-processors page lists only live vendors. |
| `security/page.tsx` | **(Wave 1)** Public security / vulnerability-disclosure page. States current posture honestly (e.g. "SOC 2 not yet complete"); contact `security@repworth.net` (mirrors `public/.well-known/security.txt`). |
| `feedback/thanks/page.tsx` | Confirmation after feedback form submission. |
| `help/contact/page.tsx` | **(Wave 2)** Public support contact page with channels and SLA expectations. External Help Scout wiring remains out-of-repo. |

**Shared public-page components (live under `src/components/`, not `(public)/`):**

- `sections/landing/**` — the landing page, rewritten 2026-08 (replacing the #436 scroll-morph stage). `LandingExperience.tsx` is a composition root owning only the chrome — nav, the single `<main id="main-content">` landmark, the footer — plus a numbered section map; each narrative section is its own module under `sections/landing/<section>/` with colocated CSS and a `*-copy.ts` carrying its shipped-vs-roadmap accuracy contract. Shared: `agent-flip-card.tsx` (sections 3–4), `carousel.tsx`/`carousel.css` (the ≤767px card rail for sections 2–5 — it restyles the container each section already renders, so desktop keeps its shipped grid; `carousel.css` must stay the LAST landing CSS import before `landing-experience.css`, or the fleet's watchdog tier wins on order and never becomes a rail), `reveal.tsx` (the one arrival motion — opacity, ≤200ms), `ambient-motion.tsx` (the WCAG 2.2.2 pause control, rendered in the footer's bottom bar, plus the `AmbientVideo` that every looping background clip must use so none can escape it). The page scrolls natively since the 2026-08-16 Linear pass — the former `scroll/` folder (Lenis smooth scroll + snap, chapter rail, chapter markers, section transitions) was deleted. **This page is deliberately unlocked from the Island system** — read its Style Reference [`docs/design/landing/DESIGN.md`](./design/landing/DESIGN.md) and its engineering companion [`docs/design/landing/measurements.md`](./design/landing/measurements.md) before changing anything in it; most of the values in that folder are measurements with a documented failure mode, not preferences.
- `ui/PageShell.tsx` — header + footer wrapper used by all public pages.
- `ui/SiteNav.tsx` — navigation bar with logo and links.
- `ui/marketing-links.ts` — **(A+ campaign)** single owner of `NAV_LINKS` / `MARKETING_LINKS`; imported by SiteNav, SiteFooter, and LandingExperience (closed the Q1 nav-link duplication).

---

_Index: [`docs/directory.md`](../directory.md)_
