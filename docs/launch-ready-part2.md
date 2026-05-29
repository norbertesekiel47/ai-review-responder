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

**33 files** still use the explicitly-banned amber/orange/stone/yellow palette. *(PR #173 cleared `amber`/`orange`/`stone` from the owner Console + Admin — 19 files — and added a guard test; the deliberately-excluded `dashboard/connect` (P0 #10), the yellow review-star color (P2 #28), and chart series `#ea580c` remain.)*

---

## 🔴 Cross-cutting P0 themes (fix before launch)

1. ✅ **Off-brand conversion funnel** — Every onboarding step (`start`, `business`, `demo`, `pay`, `payment-success`) renders on `bg-gray-50` with `bg-blue-600` CTAs, no island, no motion, no parallax. Most-impactful single fix. (`StartLocationClient.tsx:96`, `BusinessWizardClient.tsx:179`, `PaywallWithDemoClient.tsx:93`, `pay/page.tsx:88`, `PaymentSuccessClient.tsx:120`) → **DONE (PR #165):** all five funnel pages + `onboarding/error.tsx` rebuilt on a new shared `OnboardingFunnelShell` (sage island, RepWorth wordmark) with a cross-page `FunnelStepThread` (Find business → Preview → Plan → Set up) — closing the "no shared shell / progress thread" gap; teal `motion.button` CTAs, teal review stars (`#97B3AE`), `#F0EEEA` AI-response box; amber/yellow/blue/gray removed; one-owner `field-styles` (16px inputs). Presentational-only (polling/redirects/prefill/`handlePick`/step-switching unchanged); full suite green.
2. ✅ **Off-brand approval loop** — `src/components/approval/approval-client.tsx` + `approve/[token]/page.tsx`: `bg-gray-50`, `bg-blue-*`, `bg-amber-*`, `text-yellow-500` stars. This is *the* core product moment (owner approves a reply from an email link) and has no brand and no real success/error design. → **DONE (PR #162):** rebuilt on the shared `PageShell` island (sage/white/teal) with a minimal brand header; action-aware success state ("We'll post it to Google shortly" / "New draft on the way") + "View your reviews" dashboard CTA; recovery CTAs (dashboard + contact support) on all four error states **and** the client load-failure path, via a shared `ApprovalErrorState`; amber/yellow removed (neutral Archived badge, sage AI-disclosure note, teal stars/spinner); edit `<textarea>` labeled; dashboard-private `Icon` inlined as SVG; `role=status`/`aria-live`/`role=alert` + `sr-only` star rating + `focus-visible` rings added.
3. ✅ **Off-brand MFA** — `mfa/challenge/page.tsx:147`: gray/blue, fired after every login. → **DONE (PR #160):** rebuilt as a self-contained Tailwind + `motion/react` island (sage `#D2E0D3` bg, white `rounded-[3rem]` card, teal `#97B3AE` CTA), branded Suspense fallback, `prefers-reduced-motion` respected.
4. **Off-brand prospect demo page** — `demo/[slug]/page.tsx`: the lead-gen asset sales sends to prospects. `bg-blue-600` CTA → `mailto:`, bare `"!"` error state, broken `<meta http-equiv="refresh">` in body.
5. ✅ **`overflow: hidden` on island roots breaks iOS Safari** — `globals.css:126` (`.rw-island`) and `auth-island.css:67`. The rubric explicitly forbids this; it clips the fixed dot-nav + parallax on iOS. Affects all four marketing pages + auth pages. → **DONE (PR #161):** `overflow:hidden` removed from both `.rw-island` roots; auth `.rw-showcase` given `border-radius: 48px 0 0 48px` to self-clip its left corners; Vitest contract test added to lock the rule. (Correction: the dot-nav/parallax are *siblings* of `.rw-island`, not descendants — the real trigger is `overflow:hidden` + `border-radius` + a retained `transform`.) See prioritized #7.
6. ✅ **Approval page has no `robots: noindex`** — verified absent. The page renders sensitive business review data keyed to a one-time token; it must not be crawlable/cacheable. → **DONE (PR #162):** added `export const metadata = { robots: { index: false, follow: false } }` (+ a private `title`) to `approve/[token]/page.tsx`.
7. ✅ **Public utility pages are unstyled stubs** — `help/contact` (no island, emails are plain text not `mailto:` links) and `feedback/thanks` (gray dead-end, no CTA back). → **DONE (PR #166):** both rebuilt on the shared `PageShell` island; `help/contact` now uses three teal `mailto:` channel cards (account/billing/security) with the SLA + help-topic panels preserved, and `feedback/thanks` is a narrow island with a success check and a "Back to RepWorth" CTA out of the dead-end.
8. **DPA legal placeholder is live** — `src/lib/legal/content.ts:279`: "A lawyer-reviewed DPA is pending… should not treat this page as a completed legal addendum" renders on `/legal/dpa`. Gate or remove before launch.
9. ✅ **No `error.tsx` in `(authenticated)`** — any server-component throw drops owners to an unbranded Next.js error page. → **DONE (PR #163):** added `(authenticated)/error.tsx` — a Console-styled boundary that renders inside the layout shell (sidebar stays) with Try again (`reset()`) / Back to dashboard / Contact support + a conditional `Reference: <digest>`; `role=alert` + `aria-labelledby`, heading focused on mount, Sentry capture, inline-SVG icon. Also rebranded the bare `global-error.tsx` into a self-contained inline-styled island fallback (sage/teal + RepWorth wordmark) for root/layout throws (keeps Sentry capture; native `<a href="/">` hard-nav with justified eslint-disable). New `.error-state` Console CSS block (red accent, WCAG-AA contrast); 9 tests; full suite green (4439 tests).

---

## 📱 Mobile incompatibility (called out specifically)

| # | Issue | Location | Sev |
|---|---|---|---|
| M1 | **No mobile nav** — public nav links vanish `<640px` (`hidden sm:flex`), no hamburger | `src/components/ui/SiteNav.tsx:33` | P1 |
| M2 | ✅ **iOS input zoom** — `text-sm` (14px) inputs auto-zoom the viewport on focus; need ≥16px → **DONE (PR #160 + #165):** MFA code input + factor `<select>` (PR #160) and all onboarding funnel inputs via `field-styles` `fieldClass`/`textareaClass` (PR #165) are now `text-base` (16px) | `mfa/challenge/page.tsx:192,200` + onboarding inputs | P1 |
| M3 | ✅ **Pricing matrix never scrolls** — 5-col grid only shrinks font at ≤720px, no `overflow-x:auto`; illegible at 375px → **DONE (PR #159):** `.pr-matrix` `overflow-x:auto` + `.pr-matrix-grid` `min-width:720px`, dropped 12px font crush, added keyboard-scrollable `role=group`/`aria-label`/`tabIndex` region | `globals.css:2231,2361` | P0 |
| M4 | ✅ **`overflow:hidden` clips fixed elements on iOS** (see P0 #5) → **DONE (PR #161):** `overflow:hidden` removed from both `.rw-island` roots; auth `.rw-showcase` self-clips its corners; guard test added | `globals.css:126`, `auth-island.css:67` | P0 |
| M5 | **Signup name+phone locked to 2 columns** — `grid-template-columns:1fr 1fr` with no breakpoint; ~150px inputs on phones | `auth-island.css:136` | P1 |
| M6 | **Save-bar magic number** — `left:240px` hardcoded; breaks at 769–800px tablet widths before the 768px breakpoint | `settings.css:469` | P1 |
| M7 | **No tablet breakpoint** — KPI grid + Past-Replies stats stay 4-col from 769–900px (cramped on iPad portrait) | `console.css:529`, `past-replies.css:83` | P2 |
| M8 | **MobileTabBar "Needs Action"** links to `/dashboard#needs-action` (hash only) → tab never gets `.active` | `MobileTabBar.tsx:26` | P1 |
| M9 | **Auth island `min-height:680px`** with no mobile override → taller than iPhone SE (667px), clips on load | `auth-island.css:67` | P1 |
| M10 | ✅ **MFA input missing `pattern="[0-9]*"`** — some iOS Safari versions ignore `inputMode` alone → **DONE (PR #160):** `pattern="[0-9]*"` added alongside `inputMode="numeric"` | `mfa/challenge/page.tsx:192` | P1 |
| M11 | ✅ **Plan cards have no own horizontal padding** — `max-w-6xl` relies on parent `px-4`; cards hug screen edge → **DONE (PR #165):** cards now carry `mx-1 sm:mx-0` and sit inside the `OnboardingFunnelShell` island (`maxWidth="6xl"`) | `PlanPickerClient.tsx:58` | P1 |
| — | Legal sub-processors table `whitespace-nowrap` first col may force horizontal scroll on small phones | `LegalPage.tsx:60` | P2 |

**Good news:** AdminNav has a working hamburger; admin tables use `overflow-x-auto`; the EditReplyDrawer and AddLocationWizard are largely mobile-OK. Admin mobile is acceptable (it's an internal tool).

---

## Per-domain findings

### A. Public marketing pages
- ✅ **Demo page (`demo/[slug]/page.tsx`)** — full off-brand: `bg-gray-50`/`bg-blue-*`/`bg-purple-*`/`text-green-*`, `"!"` error icon, broken `<meta refresh>`, `.com` email fallback, CTA → `mailto:` instead of `/book-a-demo`. **P0 redesign.** — **DONE (PR #164).**
- ✅ **`help/contact`** — unstyled stub, no island, emails not clickable. **P0.** — **DONE (PR #166):** `PageShell` island + `SiteNav`; three clickable `mailto:` channel cards; per-page metadata; clean h1→h2 heading order + `focus-visible` rings.
- ✅ **`feedback/thanks`** — gray dead-end, no CTA. **P0.** — **DONE (PR #166):** narrow (`max-w-md`) `PageShell` island, minimal brand header, success check, "Back to RepWorth" CTA, `robots:noindex` + metadata.
- **Security page** — inside island but h1 is `text-3xl` (rubric: `text-5xl md:text-6xl lg:text-7xl`), h2s `text-xl`, body `#4a4a4a` (spec `#6a6a6a`). **P1–P2.**
- **How-it-works** — uses `#16A34A` (green-600) for success states — off-palette. **P1.**
- **Pricing** — "if implemented" in Premium bullet (`PricingContent.tsx:108`); 3/4 plans show "Coming soon" disabled CTAs. **P1.**
- **Book-a-demo** — testimonial attributed to "Local restaurant owner **(placeholder)**" (`BookADemoContent.tsx:77`). **P1.**
- 🟡 **No per-page `metadata`** — every public page inherits the root `title: 'RepWorth'`; SEO gap. **P1.** → **PARTIAL (PR #166):** `help/contact` + `feedback/thanks` now export their own `metadata`; **remaining public pages still pending.**
- **`SiteNav` logo** uses `<img>` (eslint-disabled) with a space in filename (`Logo - SVG.svg`); domain mix `.com` vs `.net`. **P2.**

### B. Public auth + legal pages
- **All auth forms off-brand** — ForgotPassword, ResetPassword, CheckEmail (post-signup OTP), FinishSignup (post-Google), Login: `bg-gray-50`/`bg-blue-600`/`focus:ring-blue-500`, no island, no RepWorth wordmark. **P0.**
- ✅ **Approval client** — amber "Archived" badge (`:199`), amber AI-disclosure banner (`:226`), yellow stars, blue spinner; success state is a plain green box with no "what happens next" or CTA; all four error states (invalid/expired/consumed/revoked) have **no recovery link**. Edit `<textarea>` has no label. Imports a **dashboard-private `Icon`** component into a public page. **P0.** → **DONE (PR #162):** every item resolved — teal-on-island reskin, action-aware success + dashboard CTA, dashboard/contact-support recovery on each error state, labeled textarea, inlined icon.
- **Legal AI-disclosure copy bug** — `'Draft generated by AI. Review carefully before approving.'` is pasted into the **Privacy Policy** (`content.ts:177`) and **AUP** (`content.ts:258`) body — approval-UI strings committed as legal text. **P1.**
- **DPA placeholder** live (see P0 #8). **P0.**
- **Legal pages** — `text-sm` (14px) body, `#4a4a4a` color, `text-3xl` h1, no `generateMetadata`. **P2.**
- `/terms` & `/privacy` correctly `permanentRedirect` to `/legal/*` — no action needed.

### C. Authenticated owner app (Console)
- **Connect page (`dashboard/connect/page.tsx`)** — raw Tailwind prototype (`rounded-lg border-gray-200`, `bg-blue-600`), not Console classes; looks like a different product. `ReadOnlyConnectView` uses `amber-*`, `ReconnectView` uses `text-orange-700`. **P0.**
- ✅ **Amber bleed-through** — `EditReplyDrawer.tsx:145` + `edit-reply/{PreviewPanel,RecoveryPanel,ManualEditor,ReviewChangedPanel}.tsx` all use `border-amber-200 bg-amber-50 text-amber-900`. `ConnectGoogleBanner` uses `.banner-orange` (`#EA580C`). **P1.** → **DONE (PR #173):** drawer panels (incl. `DraftConflictPanel`) → `#F0EEEA`/teal, with a blush `border-l-4 border-l-[#F2C3B9]` accent on the action-needed ones; `ConnectGoogleBanner` → `.banner-attn` (brand blush `#F2C3B9` surface, brand-teal CTA) via the new `--rw-attn-*` Console tokens.
- **SMS hardcoded "coming soon"** even when `CHANNELS_SMS_ENABLED=true` (`ChannelsClient.tsx:72-77`). **P0.**
- **Voice settings page** renders `<VoiceClient/>` **without `<SettingsShell>`** → no tab nav on that page (`settings/voice/page.tsx:38`). **P1.**
- **`select-location` page** renders bare `<LocationPicker/>` — no TopBar, no chrome, no back link (`connect/select-location/page.tsx:67`). **P1.**
- ✅ **No `error.tsx`** in the segment (see P0 #9). → **DONE (PR #163):** branded Console `error.tsx` added (+ rebranded `global-error.tsx`). **Still open:** Settings loading state is plain text, not a skeleton — **P2** (see prioritized #28), not addressed in this work.
- **QR codes use `<img>`** in `SecurityClient.tsx:276`, `OwnerWhatsAppWidget.tsx:81`, `OwnerTelegramWidget.tsx:81`. **P2.**

### D. Onboarding funnel + MFA (high bar — most signups are mobile)
- ✅ **Every step off-brand** (see P0 #1). No shared shell / progress thread across `start → demo → pay → payment-success`; each is an independent gray page. **P0 / P1.** → **DONE (PR #165):** new `OnboardingFunnelShell` + `FunnelStepThread` give the funnel one shared island shell and a cross-page progress thread.
- 🟡 **Payment-success** — highest-emotion moment (user just paid) is a bare gray card with a blue button, no celebration/animation; and when `!businessOnboarded` it **silently redirects** with no payment acknowledgement (`PaymentSuccessClient.tsx:75`); timeout state strands the user with no support link. **P0 / P1.** → **PARTIAL (PR #165):** branded island + teal check-circle celebration done; the silent `!businessOnboarded` redirect replaced with a "payment confirmed" acknowledgement + explicit "Continue setup →" CTA into the wizard (3 new tests incl. a 401 regression lock; polling internals byte-for-byte unchanged). **Still pending:** a support link on the 5-min timeout state.
- ✅ **ProgressDots** use `bg-blue-600` (should be teal). **P1.** → **DONE (PR #165):** reteal'd to `#97B3AE` (API/labels unchanged).
- ✅ **Amber** in cancelled-checkout toast (`PlanPickerClient.tsx:60`) and demo fallback alert (`PaywallWithDemoClient.tsx:103`). **P1.** → **DONE (PR #165):** recolored to brand tokens (`#6a6a6a` cancelled notice, `#F0EEEA` demo info banner).
- ✅ **No `motion`** anywhere in the funnel — plan cards are plain `div`, CTAs have no hover/tap. **P1.** → **DONE (PR #165):** funnel CTAs are now `motion.button`/`motion.a` with the brand hover/tap (`buttonMotion`).
- ✅ **MFA dead-end** — "no verified factor" branch is a bare paragraph + link, no support path (`mfa/challenge/page.tsx:153`). **P1.** → **DONE (PR #160):** added a `mailto:support@repworth.com` recovery link on the no-factor and error states (alongside "Return to login").

### E. Admin console (utilitarian bar — internal tool)
Admin has a coherent internal gray/white/blue style; judged on function, not polish.
- **`ZernioConnectionPanel.tsx:235`** — TODO: awaiting-reconnect queue has **no action buttons** (force-drain/dismiss) — admins can see stuck items but can't act. **P1 functional.**
- **`admin/payment-success/page.tsx:28`** — polling loop has no unmount cleanup → state-update-on-unmounted warning. **P1.**
- ✅ **`admin/overview` "Add Business" = `bg-amber-600`**, `admin/payment-success` uses `amber-600` spinner/buttons — inconsistent with admin's own blue, and amber is banned. **P2.** → **DONE (PR #173):** admin amber/stone → admin blue (CTAs/spinners/focus/notice panels) + neutral gray (watch/pending/awaiting status badges); folded in the broader admin sweep (impersonate read-only notice + focus + submit, past-due extension panel, business-detail badges + green→yellow→red severity bar, enrollment-widget `text-orange-600` → gray, stone nav links → gray).
- `admin/runbook/page.tsx:88` missing `min-h-screen` wrapper; flagged-queue pagination shows range but no total. **P2.**

---

## ♿ Accessibility (cross-cutting)
- 🟡 **No `aria-live`/`role="status"`** on async feedback anywhere — save confirmations, MFA notices, connection-status changes, dashboard error/loading are silent to screen readers. **P1.** → **PARTIAL (PR #160):** MFA now uses `aria-live="polite"` on loading/verifying and `role="alert"` on errors; **rest of app still pending.**
- **No `focus-visible` styles** on dot nav, pricing toggle, FAQ accordions, SiteNav links. **P1.**
- **Settings/MobileTabBar tabs** lack `role="tab"`/`aria-selected`/`role="tablist"` — no ARIA tab semantics, no arrow-key nav. **P2.**
- 🟡 **Approval edit textarea, FinishSignup inputs** have no visible/associated labels (rely on placeholder or `sr-only`). **P1.** → **PARTIAL (PR #162):** approval edit textarea now has an associated `<label htmlFor>`; **FinishSignup inputs still pending.**
- ✅ **`PageShell` dot-nav buttons missing `type="button"`** → submit forms when nested in `<form>` (e.g. book-a-demo). **P1.** → **DONE (PR #166):** dot-nav buttons now `type="button"` + regression test. (Defensive: the dot-nav renders as a fixed sibling outside the island `children`, so no current caller's `<form>` actually wraps it — but `type="button"` is the correct default.)
- **Tap targets** — EditReplyDrawer close (`✕`, ~24px) and dot nav below 44×44px guideline. **P2.**

---

## 📝 Copy / content / SEO bugs (quick wins)
- `PricingContent.tsx:108` — "Multiple approval notification channels, **if implemented**".
- `BookADemoContent.tsx:77` — testimonial "Local restaurant owner **(placeholder)**".
- ✅ `content.ts:177,258` — AI-disclosure string pasted into Privacy Policy + AUP. → **DONE (PR #169):** misplaced "Draft generated by AI…" UI microcopy removed from Privacy + AUP — **and** a third instance the audit missed, in Terms "AI-Generated Content". The string's authoritative owner stays `src/lib/ui/disclosures.ts`; each legal doc keeps its substantive disclosure prose.
- ✅ `content.ts:279` — DPA "lawyer-reviewed DPA is pending" placeholder live. → **DONE (PR #169):** orphaned `/legal/dpa` route + `legalDocs.dpa` entry + `'dpa'` slug removed (now 404s; nothing linked to it).
- Domain mix `.com` (demo, how-it-works) vs `.net` (contact, security).
- No per-page `<title>`/metadata across public + auth + legal pages; auth/approval pages not `noindex`. *(PR #162: approval page now has a private `<title>` + `noindex`. PR #166: `help/contact` + `feedback/thanks` now have per-page metadata, and `feedback/thanks` is `noindex`. Auth/legal + remaining public pages still pending.)*

---

## Prioritized fix list

### P0 — Launch blockers
1. ✅ **Brand the conversion funnel** — apply island layout + teal CTAs + motion to all `onboarding/*` pages, especially `payment-success`. — **DONE (PR #165):** new shared `OnboardingFunnelShell` + cross-page `FunnelStepThread` + one-owner `field-styles`; all five pages (`start`, `business` wizard + reteal'd `ProgressDots`, `demo`, `pay`, `payment-success`) and `onboarding/error.tsx` reskinned to sage/white/teal with `motion`; teal review stars, `#F0EEEA` AI box, 16px inputs, plan-card mobile padding; amber/yellow/blue/gray gone. Also folded in: payment-success acknowledgement (P1 #20, silent-redirect half) and a dead no-op "Back" button hidden on the first post-pay step. Presentational-only elsewhere; full suite green (4442 tests). Built via brainstorm → spec → plan → subagent-driven TDD with two-stage review per task; spec/plan in `docs/superpowers/`.
2. ✅ **Brand + complete the approval loop** (`approval-client.tsx` + `approve/[token]`) — island, real success ("posting to Google shortly") + recovery CTAs on every error state, remove amber/yellow, add textarea label, inline the icon. — **DONE (PR #162):** reused `PageShell` island (no `overflow:hidden`, so the iOS clip stays the separate #7 fix) + minimal brand header; new shared `ApprovalErrorState` owns dashboard + contact-support recovery for both the server token-precheck branches and the client load-failure; action-aware success + dashboard CTA; amber/yellow gone; textarea labeled; icon inlined; `robots:noindex` folded in (#3). Approval fetch/session/action logic preserved verbatim; full suite green (4441 tests).
3. 🟡 **Add `robots: noindex` metadata** to `approve/[token]` (sensitive token data) — and to auth pages. — **PARTIAL (PR #162):** `approve/[token]` is now `noindex`; **auth pages still pending.**
4. ✅ **Brand the MFA page** + fix iOS input zoom (≥16px) + add `pattern="[0-9]*"`. — **DONE (PR #160):** island rebuild (Tailwind + `motion/react`, sage/white/teal), code input + factor `<select>` → `text-base` (16px), `pattern="[0-9]*"` added; plus branded Suspense fallback, `aria-live`/`role="alert"`, and a `mailto:support@repworth.com` recovery link on dead-ends. Auth logic preserved verbatim; no shared `auth-island.css`/login/signup changes.
5. ✅ **Redesign the prospect demo page** (`demo/[slug]`) — island, teal CTA → `/book-a-demo`, real error state, fix `<meta refresh>`. — **DONE (PR #164):** reused `PageShell` island across all four states — completed feed (`DemoViewerContent`), a shared `DemoStatusIsland` for loading/error, and a new branded `not-found.tsx` for expired/invalid links; `router.refresh()` client poller replaces the invalid in-body `<meta refresh>`; teal CTA → `/book-a-demo` (was `mailto:`); real failed state with recovery CTA (was bare `"!"`); "RepWorth reply" label + teal stars/multilingual badge (was yellow/purple); truthful "languages handled" chip (omitted when all-English); `robots:noindex` added + fail-safe `notFound()` on unexpected status. Server `page.tsx` data behavior (query/expiry/view-count/JSONB guards) preserved verbatim; full suite green (4453 tests).
6. ✅ **Brand `help/contact` + `feedback/thanks`** (island, clickable mailto, CTA out of dead-end). — **DONE (PR #166):** both rebuilt on the shared `PageShell` island. `help/contact` → `SiteNav` + three teal `mailto:` channel cards (account/billing/security) + preserved SLA/help-topic panels + "Back to RepWorth" CTA; `feedback/thanks` → narrow `max-w-md` island, minimal brand header, success check, "Back to RepWorth" CTA out of the dead-end. Added a backward-compatible `PageShell` `maxWidthClassName` prop, per-page metadata (`feedback/thanks` `noindex`), `type="button"` dot-nav hardening (#18), and `focus-visible` rings + single-h1 heading order. Full suite green (4452 tests).
7. ✅ **Remove `overflow:hidden`** from `.rw-island` (`globals.css:126`, `auth-island.css:67`). — **DONE (PR #161):** removed `overflow:hidden` from both `.rw-island` roots (marketing `globals.css` + auth `auth-island.css`). Root cause is the iOS Safari `overflow:hidden` + `border-radius` + retained `transform` repaint bug (marketing island keeps `scale(1)` via `both`-fill; auth animates `transform` on intro) — **not** the dot-nav/parallax clip the audit described: those are *siblings* of `.rw-island` and were never clipped. Added `border-radius: 48px 0 0 48px` to the auth `.rw-showcase` so its full-bleed left gradient pane self-clips the island's left corners (it keeps its own `overflow:hidden` for the floating cards). Marketing corners verified safe (bottom CTAs already self-round; top is white nav/hero). Added a Vitest contract test (`src/__tests__/island-overflow.test.ts`) asserting no `.rw-island` block — root **or** `@media` override — declares `overflow:hidden`. CI green (lint/typecheck/test/build); real-iOS Safari visual confirmation still recommended post-deploy.
8. ✅ **Pricing matrix**: wrap in `overflow-x:auto` + `min-width` so it scrolls on mobile. — **DONE (PR #159):** `.pr-matrix` scroll container + `.pr-matrix-grid` `min-width:720px`, removed illegible 12px font crush, accessible keyboard-scrollable region (`role=group`/`aria-label`/`tabIndex`) with `:focus-visible` outline.
9. ✅ **Add `(authenticated)/error.tsx`** branded error boundary. — **DONE (PR #163):** Console-styled `error.tsx` rendering inside the owner-app shell — Try again (`reset()`), Back to dashboard, Contact support + conditional `Reference: <digest>`; `role=alert`/`aria-labelledby`, heading focused on mount, Sentry capture, inline-SVG icon, new `.error-state` CSS block (Console palette + red accent, WCAG-AA contrast). Also rebranded `global-error.tsx` → self-contained inline-styled island fallback (sage/teal + wordmark) for root/layout throws, keeping Sentry capture and a justified native `<a href="/">` hard-nav. 9 tests; full suite green (4439 tests).
10. **Restyle `dashboard/connect`** with Console classes; remove amber/orange.
11. ✅ **Gate/remove the DPA placeholder** and the AI-disclosure strings in Privacy/AUP. — **DONE (PR #169):** removed the orphaned, self-admitted DPA placeholder (route + `legalDocs.dpa` entry + `'dpa'` slug — now 404s, nothing linked to it) and the misplaced "Draft generated by AI…" UI microcopy from **three** legal docs (Terms "AI-Generated Content", Privacy "How We Use Data", AUP "Review and Approval Responsibility" — the audit listed only Privacy/AUP; Terms was the same defect, found via repo-wide grep). The substantive disclosure already lives in each doc's proper section; the string's owner stays `src/lib/ui/disclosures.ts`. Content-only; cross-doc regression guard added; full suite green (4510 tests).
12. **Fix SMS "coming soon" hardcode** to honor `CHANNELS_SMS_ENABLED`.

### P1 — Noticeable, fix before/at launch
13. Add a **mobile nav** (hamburger) to `SiteNav`.
14. ✅ Replace remaining **amber/orange** in `EditReplyDrawer` + panels, `ConnectGoogleBanner`, onboarding alerts, admin overview. — **DONE (PR #173):** full sweep of banned `amber`/`orange`/`stone` across the owner Console + Admin. Owner-facing attention/awaiting → brand blush `#F2C3B9` (new `--rw-attn-*` tokens; `.banner-orange`→`.banner-attn`; recolored `Awaiting Manual Post` badge); edit-reply drawer amber panels → `#F0EEEA`/teal with a blush `border-l-4` accent on the 3 action-needed panels; admin amber → admin blue (CTAs/focus/notices) + neutral gray (status badges) + a green→yellow→red severity bar; lone `stone-*` nav → gray. Scoped Vitest guard (`console-admin-palette.test.ts`) locks the 19 files. (Onboarding alerts were already done in PR #165.) Excludes `dashboard/connect` (P0 #10), chart series `#ea580c`, yellow stars (P2 #28). Presentational-only; full suite green (4524 tests).
15. ✅ **ProgressDots** + all funnel CTAs → teal pills wrapped in `motion.button`. — **DONE (PR #165).**
16. Wrap **VoiceClient in `SettingsShell`**; add **TopBar to select-location**.
17. Fix **MobileTabBar active state**; fix **save-bar `left:240px`** coupling.
18. Add **`aria-live`** regions + **`focus-visible`** styles + **`type="button"`** on dot-nav. *(Partial: MFA page got `aria-live`/`role="alert"` + `focus-visible` rings in PR #160; PR #166 added `type="button"` to the `PageShell` dot-nav and `focus-visible` rings on the `help/contact` + `feedback/thanks` CTAs; `aria-live` across the rest of the app + marketing-component focus styles still pending.)*
19. 🟡 Add **per-page metadata** (titles + auth/legal `noindex`). *(Partial: PR #162 added the approval-page `title` + `noindex`; PR #166 added `help/contact` + `feedback/thanks` metadata (`feedback/thanks` `noindex`); auth/legal + remaining public pages still pending.)*
20. 🟡 Fix **silent post-payment redirect** + add support escape hatches (payment-success timeout, MFA no-factor). *(Partial: MFA no-factor support hatch added in PR #160; the silent post-payment redirect was fixed in PR #165 — paid-but-not-onboarded users now get a "payment confirmed" ack + "Continue setup →" CTA into the wizard; **the payment-success 5-min-timeout support link is still pending.**)*
21. Remove **"if implemented"** and **"(placeholder)"** public copy.
22. Fix **signup 2-col mobile grid** + **island `min-height` mobile override**.
23. Admin: add **Zernio reconnect-queue actions**; fix **admin payment-success polling cleanup**.

### P2 — Polish
24. QR codes + SiteNav logo → `next/image`.
25. Add ~900px tablet breakpoints for KPI/stats grids.
26. Security page typography to rubric scale; legal body color/size.
27. ARIA tab semantics on settings/mobile tabs; enlarge tap targets.
28. Settings loading skeleton; verify zero-replies empty state; admin runbook `min-h-screen`; star colors off `#eab308`. *(Partial: onboarding-demo review stars moved off `#eab308` → teal `#97B3AE` in PR #165; other star locations + the rest still pending.)*

---

## Effort framing
The single largest lift is **theming the unbranded ~20 files** (funnel + auth + approval + MFA + demo) into the island system. The marketing pages already prove the pattern exists — much of this is applying the established island wrapper, sage background, teal pills, and `motion` patterns that `LandingContent`/`FeaturesContent` already use. The auth pages share an `auth-island.css` that's *partly* branded already, so they're closer than the onboarding pages, which are raw gray. Recommend tackling in this order: **approval loop → onboarding funnel → MFA → auth forms → public utility/demo pages → Console amber cleanup → accessibility pass.**
