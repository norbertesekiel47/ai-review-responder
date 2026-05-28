# Launch Ready — Part 2: Frontend Design & Mobile Audit

> **Date:** 2026-05-28
> **Scope:** All 57 frontend pages (`src/app/**/page.tsx` + their client components), audited against the RepWorth brand-design system (`~/.claude/skills/repworth-brand-design/SKILL.md`).
> **Lenses:** (1) design inconsistency, (2) mobile incompatibility, (3) missing/placeholder designs, (4) accessibility / other.
> **Companion:** `docs/launch-ready-part1.md` covers backend/infra/ops readiness. This file is the UI/UX audit.
> **Verification:** Key claims (island `overflow:hidden`, off-brand funnel palette, missing `noindex`) were grep-confirmed, not just agent-reported.

---

## ⚠️ Headline finding: the brand only skin-deep covers the marketing site

RepWorth currently ships **three different visual languages**, and only one of them is on-brand:

| Visual language | Where | State |
|---|---|---|
| **Island (brand)** — sage `#D2E0D3` bg, white `rounded-[3rem]` island, teal `#97B3AE`, motion animations | Landing, Features, How-it-works, Pricing, Book-a-demo | ✅ On-brand |
| **Console (deliberate)** — separate dashboard token set (`tokens.css`), documented as intentional | Authenticated owner app | 🟡 Intentional split, but **amber/orange bleed-through** |
| **Default gray/blue (unbranded)** — `bg-gray-50`, `bg-blue-600`, `focus:ring-blue-500` — bare Tailwind | **Entire conversion funnel, approval loop, MFA, several public utility pages** | 🔴 Off-brand prototype |

**The third bucket is the problem.** The highest-stakes external touchpoints — the post-signup funnel, the approval-email landing page, MFA, and the prospect demo page — look like unstyled developer prototypes. A prospect or new customer's **first and most important moments** (approve a reply, finish signup, pay, see "Welcome to RepWorth!") currently carry zero brand identity.

**Confirmed off-brand files (20):** all of `src/app/onboarding/*`, `src/app/mfa/challenge/page.tsx`, `src/components/auth/*` (Login, CheckEmail, FinishSignup, ForgotPassword, ResetPassword), `src/components/approval/approval-client.tsx`, `src/app/(public)/demo/[slug]/page.tsx`, `src/app/(public)/help/contact/page.tsx`, `src/app/(public)/feedback/thanks/page.tsx`.

**33 files** still use the explicitly-banned amber/orange/stone/yellow palette.

---

## 🔴 Cross-cutting P0 themes (fix before launch)

1. **Off-brand conversion funnel** — Every onboarding step (`start`, `business`, `demo`, `pay`, `payment-success`) renders on `bg-gray-50` with `bg-blue-600` CTAs, no island, no motion, no parallax. Most-impactful single fix. (`StartLocationClient.tsx:96`, `BusinessWizardClient.tsx:179`, `PaywallWithDemoClient.tsx:93`, `pay/page.tsx:88`, `PaymentSuccessClient.tsx:120`)
2. **Off-brand approval loop** — `src/components/approval/approval-client.tsx` + `approve/[token]/page.tsx`: `bg-gray-50`, `bg-blue-*`, `bg-amber-*`, `text-yellow-500` stars. This is *the* core product moment (owner approves a reply from an email link) and has no brand and no real success/error design.
3. **Off-brand MFA** — `mfa/challenge/page.tsx:147`: gray/blue, fired after every login.
4. **Off-brand prospect demo page** — `demo/[slug]/page.tsx`: the lead-gen asset sales sends to prospects. `bg-blue-600` CTA → `mailto:`, bare `"!"` error state, broken `<meta http-equiv="refresh">` in body.
5. **`overflow: hidden` on island roots breaks iOS Safari** — `globals.css:126` (`.rw-island`) and `auth-island.css:67`. The rubric explicitly forbids this; it clips the fixed dot-nav + parallax on iOS. Affects all four marketing pages + auth pages.
6. **Approval page has no `robots: noindex`** — verified absent. The page renders sensitive business review data keyed to a one-time token; it must not be crawlable/cacheable. Add `export const metadata = { robots: { index: false, follow: false } }` immediately.
7. **Public utility pages are unstyled stubs** — `help/contact` (no island, emails are plain text not `mailto:` links) and `feedback/thanks` (gray dead-end, no CTA back).
8. **DPA legal placeholder is live** — `src/lib/legal/content.ts:279`: "A lawyer-reviewed DPA is pending… should not treat this page as a completed legal addendum" renders on `/legal/dpa`. Gate or remove before launch.
9. **No `error.tsx` in `(authenticated)`** — any server-component throw drops owners to an unbranded Next.js error page.

---

## 📱 Mobile incompatibility (called out specifically)

| # | Issue | Location | Sev |
|---|---|---|---|
| M1 | **No mobile nav** — public nav links vanish `<640px` (`hidden sm:flex`), no hamburger | `src/components/ui/SiteNav.tsx:33` | P1 |
| M2 | **iOS input zoom** — `text-sm` (14px) inputs auto-zoom the viewport on focus; need ≥16px | `mfa/challenge/page.tsx:192,200` + onboarding inputs | P1 |
| M3 | **Pricing matrix never scrolls** — 5-col grid only shrinks font at ≤720px, no `overflow-x:auto`; illegible at 375px | `globals.css:2231,2361` | P0 |
| M4 | **`overflow:hidden` clips fixed elements on iOS** (see P0 #5) | `globals.css:126`, `auth-island.css:67` | P0 |
| M5 | **Signup name+phone locked to 2 columns** — `grid-template-columns:1fr 1fr` with no breakpoint; ~150px inputs on phones | `auth-island.css:136` | P1 |
| M6 | **Save-bar magic number** — `left:240px` hardcoded; breaks at 769–800px tablet widths before the 768px breakpoint | `settings.css:469` | P1 |
| M7 | **No tablet breakpoint** — KPI grid + Past-Replies stats stay 4-col from 769–900px (cramped on iPad portrait) | `console.css:529`, `past-replies.css:83` | P2 |
| M8 | **MobileTabBar "Needs Action"** links to `/dashboard#needs-action` (hash only) → tab never gets `.active` | `MobileTabBar.tsx:26` | P1 |
| M9 | **Auth island `min-height:680px`** with no mobile override → taller than iPhone SE (667px), clips on load | `auth-island.css:67` | P1 |
| M10 | **MFA input missing `pattern="[0-9]*"`** — some iOS Safari versions ignore `inputMode` alone | `mfa/challenge/page.tsx:192` | P1 |
| M11 | **Plan cards have no own horizontal padding** — `max-w-6xl` relies on parent `px-4`; cards hug screen edge | `PlanPickerClient.tsx:58` | P1 |
| — | Legal sub-processors table `whitespace-nowrap` first col may force horizontal scroll on small phones | `LegalPage.tsx:60` | P2 |

**Good news:** AdminNav has a working hamburger; admin tables use `overflow-x-auto`; the EditReplyDrawer and AddLocationWizard are largely mobile-OK. Admin mobile is acceptable (it's an internal tool).

---

## Per-domain findings

### A. Public marketing pages
- **Demo page (`demo/[slug]/page.tsx`)** — full off-brand: `bg-gray-50`/`bg-blue-*`/`bg-purple-*`/`text-green-*`, `"!"` error icon, broken `<meta refresh>`, `.com` email fallback, CTA → `mailto:` instead of `/book-a-demo`. **P0 redesign.**
- **`help/contact`** — unstyled stub, no island, emails not clickable. **P0.**
- **`feedback/thanks`** — gray dead-end, no CTA. **P0.**
- **Security page** — inside island but h1 is `text-3xl` (rubric: `text-5xl md:text-6xl lg:text-7xl`), h2s `text-xl`, body `#4a4a4a` (spec `#6a6a6a`). **P1–P2.**
- **How-it-works** — uses `#16A34A` (green-600) for success states — off-palette. **P1.**
- **Pricing** — "if implemented" in Premium bullet (`PricingContent.tsx:108`); 3/4 plans show "Coming soon" disabled CTAs. **P1.**
- **Book-a-demo** — testimonial attributed to "Local restaurant owner **(placeholder)**" (`BookADemoContent.tsx:77`). **P1.**
- **No per-page `metadata`** — every public page inherits the root `title: 'RepWorth'`; SEO gap. **P1.**
- **`SiteNav` logo** uses `<img>` (eslint-disabled) with a space in filename (`Logo - SVG.svg`); domain mix `.com` vs `.net`. **P2.**

### B. Public auth + legal pages
- **All auth forms off-brand** — ForgotPassword, ResetPassword, CheckEmail (post-signup OTP), FinishSignup (post-Google), Login: `bg-gray-50`/`bg-blue-600`/`focus:ring-blue-500`, no island, no RepWorth wordmark. **P0.**
- **Approval client** — amber "Archived" badge (`:199`), amber AI-disclosure banner (`:226`), yellow stars, blue spinner; success state is a plain green box with no "what happens next" or CTA; all four error states (invalid/expired/consumed/revoked) have **no recovery link**. Edit `<textarea>` has no label. Imports a **dashboard-private `Icon`** component into a public page. **P0.**
- **Legal AI-disclosure copy bug** — `'Draft generated by AI. Review carefully before approving.'` is pasted into the **Privacy Policy** (`content.ts:177`) and **AUP** (`content.ts:258`) body — approval-UI strings committed as legal text. **P1.**
- **DPA placeholder** live (see P0 #8). **P0.**
- **Legal pages** — `text-sm` (14px) body, `#4a4a4a` color, `text-3xl` h1, no `generateMetadata`. **P2.**
- `/terms` & `/privacy` correctly `permanentRedirect` to `/legal/*` — no action needed.

### C. Authenticated owner app (Console)
- **Connect page (`dashboard/connect/page.tsx`)** — raw Tailwind prototype (`rounded-lg border-gray-200`, `bg-blue-600`), not Console classes; looks like a different product. `ReadOnlyConnectView` uses `amber-*`, `ReconnectView` uses `text-orange-700`. **P0.**
- **Amber bleed-through** — `EditReplyDrawer.tsx:145` + `edit-reply/{PreviewPanel,RecoveryPanel,ManualEditor,ReviewChangedPanel}.tsx` all use `border-amber-200 bg-amber-50 text-amber-900`. `ConnectGoogleBanner` uses `.banner-orange` (`#EA580C`). **P1.**
- **SMS hardcoded "coming soon"** even when `CHANNELS_SMS_ENABLED=true` (`ChannelsClient.tsx:72-77`). **P0.**
- **Voice settings page** renders `<VoiceClient/>` **without `<SettingsShell>`** → no tab nav on that page (`settings/voice/page.tsx:38`). **P1.**
- **`select-location` page** renders bare `<LocationPicker/>` — no TopBar, no chrome, no back link (`connect/select-location/page.tsx:67`). **P1.**
- **No `error.tsx`** in the segment (see P0 #9). Settings loading state is plain text, not a skeleton. **P0 / P2.**
- **QR codes use `<img>`** in `SecurityClient.tsx:276`, `OwnerWhatsAppWidget.tsx:81`, `OwnerTelegramWidget.tsx:81`. **P2.**

### D. Onboarding funnel + MFA (high bar — most signups are mobile)
- **Every step off-brand** (see P0 #1). No shared shell / progress thread across `start → demo → pay → payment-success`; each is an independent gray page. **P0 / P1.**
- **Payment-success** — highest-emotion moment (user just paid) is a bare gray card with a blue button, no celebration/animation; and when `!businessOnboarded` it **silently redirects** with no payment acknowledgement (`PaymentSuccessClient.tsx:75`); timeout state strands the user with no support link. **P0 / P1.**
- **ProgressDots** use `bg-blue-600` (should be teal). **P1.**
- **Amber** in cancelled-checkout toast (`PlanPickerClient.tsx:60`) and demo fallback alert (`PaywallWithDemoClient.tsx:103`). **P1.**
- **No `motion`** anywhere in the funnel — plan cards are plain `div`, CTAs have no hover/tap. **P1.**
- **MFA dead-end** — "no verified factor" branch is a bare paragraph + link, no support path (`mfa/challenge/page.tsx:153`). **P1.**

### E. Admin console (utilitarian bar — internal tool)
Admin has a coherent internal gray/white/blue style; judged on function, not polish.
- **`ZernioConnectionPanel.tsx:235`** — TODO: awaiting-reconnect queue has **no action buttons** (force-drain/dismiss) — admins can see stuck items but can't act. **P1 functional.**
- **`admin/payment-success/page.tsx:28`** — polling loop has no unmount cleanup → state-update-on-unmounted warning. **P1.**
- **`admin/overview` "Add Business" = `bg-amber-600`**, `admin/payment-success` uses `amber-600` spinner/buttons — inconsistent with admin's own blue, and amber is banned. **P2.**
- `admin/runbook/page.tsx:88` missing `min-h-screen` wrapper; flagged-queue pagination shows range but no total. **P2.**

---

## ♿ Accessibility (cross-cutting)
- **No `aria-live`/`role="status"`** on async feedback anywhere — save confirmations, MFA notices, connection-status changes, dashboard error/loading are silent to screen readers. **P1.**
- **No `focus-visible` styles** on dot nav, pricing toggle, FAQ accordions, SiteNav links. **P1.**
- **Settings/MobileTabBar tabs** lack `role="tab"`/`aria-selected`/`role="tablist"` — no ARIA tab semantics, no arrow-key nav. **P2.**
- **Approval edit textarea, FinishSignup inputs** have no visible/associated labels (rely on placeholder or `sr-only`). **P1.**
- **`PageShell` dot-nav buttons missing `type="button"`** → submit forms when nested in `<form>` (e.g. book-a-demo). **P1.**
- **Tap targets** — EditReplyDrawer close (`✕`, ~24px) and dot nav below 44×44px guideline. **P2.**

---

## 📝 Copy / content / SEO bugs (quick wins)
- `PricingContent.tsx:108` — "Multiple approval notification channels, **if implemented**".
- `BookADemoContent.tsx:77` — testimonial "Local restaurant owner **(placeholder)**".
- `content.ts:177,258` — AI-disclosure string pasted into Privacy Policy + AUP.
- `content.ts:279` — DPA "lawyer-reviewed DPA is pending" placeholder live.
- Domain mix `.com` (demo, how-it-works) vs `.net` (contact, security).
- No per-page `<title>`/metadata across public + auth + legal pages; auth/approval pages not `noindex`.

---

## Prioritized fix list

### P0 — Launch blockers
1. **Brand the conversion funnel** — apply island layout + teal CTAs + motion to all `onboarding/*` pages, especially `payment-success`.
2. **Brand + complete the approval loop** (`approval-client.tsx` + `approve/[token]`) — island, real success ("posting to Google shortly") + recovery CTAs on every error state, remove amber/yellow, add textarea label, inline the icon.
3. **Add `robots: noindex` metadata** to `approve/[token]` (sensitive token data) — and to auth pages.
4. **Brand the MFA page** + fix iOS input zoom (≥16px) + add `pattern="[0-9]*"`.
5. **Redesign the prospect demo page** (`demo/[slug]`) — island, teal CTA → `/book-a-demo`, real error state, fix `<meta refresh>`.
6. **Brand `help/contact` + `feedback/thanks`** (island, clickable mailto, CTA out of dead-end).
7. **Remove `overflow:hidden`** from `.rw-island` (`globals.css:126`, `auth-island.css:67`).
8. **Pricing matrix**: wrap in `overflow-x:auto` + `min-width` so it scrolls on mobile.
9. **Add `(authenticated)/error.tsx`** branded error boundary.
10. **Restyle `dashboard/connect`** with Console classes; remove amber/orange.
11. **Gate/remove the DPA placeholder** and the AI-disclosure strings in Privacy/AUP.
12. **Fix SMS "coming soon" hardcode** to honor `CHANNELS_SMS_ENABLED`.

### P1 — Noticeable, fix before/at launch
13. Add a **mobile nav** (hamburger) to `SiteNav`.
14. Replace remaining **amber/orange** in `EditReplyDrawer` + panels, `ConnectGoogleBanner`, onboarding alerts, admin overview.
15. **ProgressDots** + all funnel CTAs → teal pills wrapped in `motion.button`.
16. Wrap **VoiceClient in `SettingsShell`**; add **TopBar to select-location**.
17. Fix **MobileTabBar active state**; fix **save-bar `left:240px`** coupling.
18. Add **`aria-live`** regions + **`focus-visible`** styles + **`type="button"`** on dot-nav.
19. Add **per-page metadata** (titles + auth/legal `noindex`).
20. Fix **silent post-payment redirect** + add support escape hatches (payment-success timeout, MFA no-factor).
21. Remove **"if implemented"** and **"(placeholder)"** public copy.
22. Fix **signup 2-col mobile grid** + **island `min-height` mobile override**.
23. Admin: add **Zernio reconnect-queue actions**; fix **admin payment-success polling cleanup**.

### P2 — Polish
24. QR codes + SiteNav logo → `next/image`.
25. Add ~900px tablet breakpoints for KPI/stats grids.
26. Security page typography to rubric scale; legal body color/size.
27. ARIA tab semantics on settings/mobile tabs; enlarge tap targets.
28. Settings loading skeleton; verify zero-replies empty state; admin runbook `min-h-screen`; star colors off `#eab308`.

---

## Effort framing
The single largest lift is **theming the unbranded ~20 files** (funnel + auth + approval + MFA + demo) into the island system. The marketing pages already prove the pattern exists — much of this is applying the established island wrapper, sage background, teal pills, and `motion` patterns that `LandingContent`/`FeaturesContent` already use. The auth pages share an `auth-island.css` that's *partly* branded already, so they're closer than the onboarding pages, which are raw gray. Recommend tackling in this order: **approval loop → onboarding funnel → MFA → auth forms → public utility/demo pages → Console amber cleanup → accessibility pass.**
