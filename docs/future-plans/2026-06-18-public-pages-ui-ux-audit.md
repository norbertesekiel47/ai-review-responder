# Public Pages — UI/UX Audit

**Date:** 2026-06-18
**Scope:** Every public route under `src/app/(public)/*`, the shared marketing chrome (`src/components/ui/*`), and the root layout — ~20 pages across marketing, auth, and transactional flows.
**Method:** Audited against the RepWorth brand standard (`repworth-brand-design` skill) plus accessibility (WCAG 2.x), responsive, copy/truthfulness, motion, and conversion heuristics. Five parallel deep-audit passes, one per page cluster, with the headline claims verified directly against source.
**Status:** Report-only. No code was changed by this audit.

---

## How to read this

Findings are grouped: **systemic** first (highest ROI — one fix clears many pages), then **per-page**, then a **prioritized punch list**. Severities: **High** (correctness / trust / accessibility blocker), **Med** (real defect, not blocking), **Low** (polish / consistency).

Headline claims were verified in source (contrast math computed, line numbers confirmed): nothing below is speculative.

---

## The two dominant systemic problems

### 1. `#97B3AE` teal as text / button-fill fails WCAG AA contrast — everywhere

Computed contrast ratios:

| Pairing | Ratio | AA threshold | Verdict |
|---|---|---|---|
| `#97B3AE` text on white | **2.24:1** | 4.5:1 (body) | ❌ fail |
| White text on `#97B3AE` (every primary button) | **2.24:1** | 4.5:1 | ❌ fail |
| `#97B3AE` on off-white `#F0EEEA` | 1.93:1 | 4.5:1 | ❌ fail |
| Body `#6a6a6a` on white | 5.41:1 | 4.5:1 | ✅ pass (leave it) |

This is the single most pervasive defect. `#97B3AE` is used as foreground text in nearly every file: nav links, the "REPWORTH" wordmark, eyebrows, plan names, stars, expiry warnings, legal effective-dates, contact-page email addresses, and **all primary buttons** — including the highest-stakes control in the product, the approval-flow "Approve & post to Google" button.

**The brand's `#97B3AE` is a fill/decoration color, not a text color.**

→ **Fix:** Introduce a dedicated `--rw-teal-text` token (~`#5E7C77`, ≈5:1 on white) for any teal that carries text or is an interactive affordance, and darken the *button fill* (e.g. `#6E908A`) so white labels pass. Keep `#97B3AE` for large fills / decoration only. This one change clears ~25 findings.

### 2. The "shared" chrome is forked into two incompatible systems

`SiteShell` (with `SiteNav` + `SiteFooter` + marquee island) covers landing / features / how-it-works / pricing. But **security, book-a-demo, help/contact, demo, and feedback** instead compose `PageShell` + a bare `SiteNav`, render **no footer at all**, and use a different parallax island.

Result: footer, background, island radius, and nav behavior differ page-to-page, and five public pages are footerless dead-ends with no legal links, no copyright, and no path back into the funnel.

→ **Fix:** Standardize all marketing pages on `SiteShell`; ideally hoist it (or at least the skip link + `<main>` + footer) into `src/app/(public)/layout.tsx` so no page can opt out.

---

## Other systemic issues

- **[High] Motion ignores `prefers-reduced-motion`.** The CSS `@media (prefers-reduced-motion)` blocks only stop *CSS* animations. Every JS-driven motion runs regardless: `useCountUp`, all typewriters (Hero, How-It-Works), the RAF clock (`TimelineSection`), interval tickers (`TickerBar`), parallax (`PageShell`), and all `motion/react` entrance/stagger animations (book-a-demo, demo viewer, contact, feedback). → Add a shared `usePrefersReducedMotion` hook / use motion's `useReducedMotion()` and short-circuit to final frames. WCAG 2.3.3.
- **[High] No skip-to-content link anywhere**, and the `<main>` landmark is missing on most pages (only Features passes `islandAs="main"`). Keyboard/SR users tab through the full nav on every page with no "main" target. → Add a skip link in the root layout + default the island to `<main>` with `id="main-content"`.
- **[High] Banned & non-token colors leak in.** Amber `#EAB308` in signup confetti (`fireConfetti.ts:1` — explicitly banned); green `#16a34a` (strength meter + status dot); terracotta `#e0a089` / `#D97757` / `#E8A394` (strength bar, negative-review markers, ticker); reds `#dc2626` / `#b91c1c` / `text-red-600` / `text-red-200` (no approved error token exists). → Define approved error/success tokens; purge the rest.
- **[High] Fabricated metrics / social proof presented as fact** on a pre-launch waitlist product — anti-slop violation and a trust/legal risk. Verified: ticker "84,213 owner hours saved / 1,240+ businesses / 14 joined this week" (`TickerBar.tsx`); hardcoded scarcity "7 of 100 spots" (`PricingContent.tsx:38`); named fake reviewers/competitors ("Sarah K.", "El Farolito — 28% responded"); "96%" vs "100%" response-rate stated inconsistently across pages. → Gate behind real data or reframe as clearly illustrative.
- **[High] Raw server errors / codes shown to users** in the approval flow (`HTTP 500`, "Session binding failed"), login (Supabase passthrough), signup, finish-signup, and reset-password (`token_expired`). → Map to friendly, actionable copy; never render machine codes.
- **[Med] No fetch timeouts** on any auth/approval/demo network call (violates the project's own `production.md`). Hung requests leave spinners stuck forever with no recovery.
- **[Med] No active-page indicator in nav** (no `usePathname()` / `aria-current`); mobile menu isn't a focus trap and doesn't restore focus on close.
- **[Med] Root layout SEO/meta gaps:** no favicon / OG / Twitter cards, no `metadataBase`, no `title` template (separators drift: `· ` vs `| `), no `viewport` / `themeColor`. Five Google font families loaded (Inter may be dead weight).
- **[Med] Touch targets below 44px:** hamburger (~40px), nav CTAs (~36px), password toggle (~30px), auth tabs (~38px), pricing toggle (~38px).

---

## Per-page findings

### Landing — `src/components/sections/landing/` (LandingContent + Hero/TickerBar/Features/VoiceDial/TimelineSection)

- **[High]** VoiceDial is mouse/touch-only and `aria-hidden`; the only keyboard control is an invisible `sr-only` range input. → Make the dial a real `role="slider"` with arrow keys + visible focus.
- **[Med]** Hero has one lonely CTA — the secondary "See how it works" is commented out and `onTry` is now dead code.
- **[Med]** Hero typewriter disables the Approve/Edit buttons for ~6–8s until the animation completes. → Gate on reduced-motion; don't block the demo CTA behind decoration.
- **[Med]** Decorative star glyphs (`★★★★★`) read as "black star black star…" to screen readers (Hero does it right with `aria-label`; apply everywhere).
- **[Med]** `TimelineSection` clock SVG has no text alternative (`role="img"` + `aria-label`, or `aria-hidden`).
- **[Low]** Three different dot-nav implementations across the three marketing pages — extract one `SectionDotNav` + tracking hook.
- **[Low]** Copy contradiction: pages repeatedly say "not another dashboard" while selling a dashboard.
- **[Low]** `TickerBar` median-time counter cycles seconds purely for "liveness" — reads as fake telemetry.

### Features — `src/components/sections/features/FeaturesContent.tsx`

- **[High]** `.rw-lang-chip` stays at `opacity:0` under reduced motion (revealed by *animation*, not transition, and absent from the reduced-motion reset) → content loss. Add it to the reset block.
- **[Med]** Two equal-weight CTAs on the teal CTA block; the large concentric-ring SVGs are decorative filler.
- **[Med]** Unbuilt "Coming Q3" feature renders a fully fabricated competitor scorecard.
- **[Low]** Before/After toggle buttons lack `aria-pressed`; hero claims "Seven pieces" but feature #07 isn't shipped.
- **[Low]** Hero metric labels use hardcoded `\n` line breaks (`whitespace-pre-line`) that wrap awkwardly at intermediate widths.

### How-It-Works — `src/components/sections/how-it-works/HowItWorksContent.tsx`

- **[High]** **Broken sentence ships live:** bullet reads `"Polls sleeps and reacts and detecting a new review"` (line 345). → Rewrite, e.g. "Polls your profile and reacts the moment a new review appears."
- **[High]** Heading order skips h1 → h3 (the four main steps are h3 before any h2 appears).
- **[Med]** Poll cadence contradicts itself: "reactive" vs "every 60 min" vs "within seconds" vs Features' "< 60 seconds." Pick one and state it consistently.
- **[Med]** Interactive step demo and FAQ disclosure lack `aria-live` / `aria-controls`; the "under the hood" glyphs are emoji (inconsistent with the file's inline-SVG convention).
- **[Med]** Response-rate metric differs from the rest of the site (96% here vs 100% in Features).

### Pricing — `src/app/(public)/pricing/PricingContent.tsx`

- **[High]** Hardcoded fake scarcity "7 of 100 spots" (`slotsLeft: 7, slotsTotal: 100`) — static, so reloads still show 7. → Wire to a real count or remove.
- **[High]** Contradictory funnel: "Claim a spot" (Founders) links to a *waitlist*, while other tiers are "Coming soon" disabled — a visitor can't tell if anything is purchasable.
- **[Med]** Comparison matrix is a 720px-wide table that horizontally scrolls on mobile with **non-sticky** headers and first column → users lose plan name + row label. Collapse to stacked per-plan cards under 720px, or make headers/first-col sticky.
- **[Med]** Sliders expose no `aria-valuetext` and kill the focus outline; FAQ accordion lacks `aria-controls` / region association.
- **[Med]** Overage and per-location pricing never quantified; ROI "saves you $X/yr" presents a modeled assumption ("95% automation") as a guarantee.
- **[Low]** No currency code ($ is ambiguous); annual billing defaults on (shows annualized price as the headline); no reduced-motion block for the `pr-` styles; unused `.pr-cta-btn` CSS; "Recommended" emphasis moves to the last-clicked tier.

### Security — `src/app/(public)/security/page.tsx`

- **[High]** **Inaccurate security claim:** "Tenant access is … protected by RLS on authenticated reads" directly contradicts the system of record (CLAUDE.md invariant #8: auth is *app-enforced, not RLS-enforced*). Publishing a false control is a trust/legal risk. → Rewrite to "enforced in application code, scoped per account and location; row-level security additionally guards specific admin-only tables."
- **[High]** Uses `PageShell`, renders no footer → dead-end page.
- **[Med]** Unexplained jargon "PHI" on a public page; links rely on failing-contrast teal with no underline (fails WCAG 1.4.1, use-of-color).
- **[Low]** "SOC 2 audit is not yet complete" honest but unframed; verify `security@repworth.net` is monitored.

### Book-a-Demo — `src/app/(public)/book-a-demo/BookADemoContent.tsx` + `src/components/sections/lead-intake/*`

- **[High]** Route is `/book-a-demo` and pricing CTAs say "Claim a spot," but the page is a *waitlist* with no scheduling — mismatched promise. → Rename to `/waitlist` (update all links) or actually offer booking.
- **[High]** **Lead-form a11y / spam:** no visible `<label>`s (placeholder-only); no honeypot / time-trap (only IP rate-limit, which BotID fails-open behind); validation is one-error-at-a-time in a single bottom alert; no per-field inline errors; no focus-move to the invalid field; Maps field is `type="text"` not `url`; required fields unmarked; no consent/privacy microcopy.
- **[Med]** The key expectation-setting line ("We'll reach out when your area opens") is the smallest, italic, lowest-contrast text on the page.
- **[Med]** Uses `PageShell` (divergent chrome); entrance/stagger motion has no reduced-motion guard.

### Auth — login/signup island + forgot/reset/check-email/finish (`src/components/auth/*`)

- **[High]** **OTP length mismatch:** the UI hardcodes 8 digits (`pattern="\d{8}"`, `minLength/maxLength=8`, "8-digit code") but CLAUDE.md states prod uses the 6-digit `{{ .Token }}`. If Supabase emits 6 digits, the input rejects every valid code. → Verify the live "Email OTP Length" setting and make length a single source of truth (server-provided), not hardcoded in two places + copy. (An in-file comment claims prod is deliberately 8 — reconcile before launch.)
- **[High]** Signup shows a strength *meter* but never the actual password *rules* before submit; the strength label is a noisy `aria-live` firing on every keystroke.
- **[High]** Per-field error plumbing (`aria-invalid` / `aria-describedby`) exists in `Field.tsx` but no form ever wires it — errors are never programmatically associated and the red shake never triggers.
- **[High]** `Tabs` use `role="tab"` / `tablist` but navigate to routes with no `tabpanel` / `aria-controls` / arrow keys — wrong ARIA pattern; switching tabs also loses typed email.
- **[Med]** Login email-not-confirmed path puts the email **in the URL** (history / logs / referrer) despite the codebase otherwise routing it via `sessionStorage` — minor enumeration + privacy leak.
- **[Med]** Showcase (login) shows fabricated "127 reviews answered while you slept" as if it were the user's own data; all showcase/trust content is `display:none` on mobile, leaving a bare form.
- **[Med]** No `:focus-visible` rings on tabs / Google button / toggle / links in the island CSS (the secondary `AuthCardShell` flows do this right — inconsistent).
- **[Med]** Forgot / reset / check-email are dead-ends or stuck states: no "back to sign in" after send; resend permanently hidden after one use; no expired-token detection on reset until after the user types a new password.
- **[Med]** Raw Supabase/server messages leak in `mapSupabaseAuthError`, `mapSignupError`, `FinishSignupClient`, and `ResetPasswordFormClient`.
- **Positives to keep:** no-enumeration forgot-password; open-redirect guards; correct `autoComplete` values; `inputMode="numeric"` on OTP; 16px inputs (no iOS zoom).

### Approval flow — `src/components/approval/approval-client.tsx` (highest stakes)

- **[High]** **No confirmation before irreversibly posting to Google.** "Approve" immediately publishes; the button is just labeled "Approve." → Add an inline confirm step and relabel "Approve & post to Google."
- **[High]** **No reject / decline path** — an owner who decides the draft is wrong can only edit forever or regenerate; there's no "don't post."
- **[High]** Success view's primary CTA links to `/dashboard`, but email/SMS link recipients are usually logged out → likely bounces to a login wall. → Confirm "this reply is now live on Google" instead; make dashboard secondary.
- **[Med]** "Response approved!" claims success before the async publish actually completes (it can later fail). → Soften to "we're posting it now."
- **[Med]** Action-in-flight state isn't announced (`aria-busy` / `aria-live`); regenerate silently discards the current draft with no warning.
- **[Low]** Expiry shows "0 hours" when <1h remains (reads as already-expired); no `maxLength` on the edit textarea.

### Approval error / demo / feedback / contact / legal

- **[High]** `ApprovalErrorState` offers no "request a new link" — only a dashboard CTA (login wall); "already approved" (a happy state) gets an alarming red error triangle. → Differentiate already-approved from real errors; make the CTA context-aware.
- **[High]** `DemoStatusIsland` polls `router.refresh()` every 5s **forever** with no cap/backoff (violates `production.md`) — an abandoned tab hammers Postgres. "Usually 30–60 seconds" erodes trust after 2 min with no elapsed indicator. → Cap attempts + backoff; soften the timing claim.
- **[High]** `/help/contact` is `mailto:`-only (no form, no spam protection, no ticket capture); response-time targets ("Premium: 2 business hours") read as hard SLAs. → Add a form (reuse BotID infra) and/or copy-to-clipboard emails; soften SLA wording.
- **[High]** Legal pages have no TOC / anchor nav for ~15-section docs; the sub-processor table scrolls horizontally on mobile with no caption/hint.
- **[Med]** **Email inconsistency across surfaces:** `legal/content.ts` uses `info@repworth.net` for privacy / data-deletion / opt-out, but the contact page uses `support@` / `billing@` / `security@`. A GDPR "delete my data" request to an unmonitored mailbox is a compliance problem. Also: Terms prose leaks an internal repo path (`docs/legal/sub-processors.md`) to end users.
- **[Med]** Demo viewer has no empty state (renders blank + "0 reviews" chips if no data); feedback/thanks is a dead-end to the marketing homepage even when reached from inside the app.

---

## Prioritized punch list (highest ROI first)

1. **Darken `#97B3AE` for text + button fill** (new `--rw-teal-text` token) — clears ~25 contrast findings including the Approve button. *(small, global)*
2. **Add a confirm step + "post to Google" wording + a decline path** to the approval flow. *(high stakes, irreversible)*
3. **Fix live content bugs:** the broken How-It-Works bullet, the OTP 8-vs-6-digit length, the false RLS claim on Security. *(launch-blockers)*
4. **Unify chrome on `SiteShell`** (gives every page a footer) + add a **skip link** and `<main>` landmark. *(systemic a11y / consistency)*
5. **Add a shared reduced-motion guard** to all JS animations; **cap the demo polling loop** with backoff. *(a11y + reliability)*
6. **Remove/relabel fabricated metrics, scarcity, and named fake reviewers**; reconcile the "waitlist vs claim-a-spot vs coming-soon" funnel wording. *(trust)*
7. **Map raw error strings to friendly copy**; add fetch timeouts; fix the wired-but-unused per-field form errors and the lead-form labels/honeypot.
8. **Purge banned colors** (amber confetti, green/red/terracotta) into approved error/success tokens; bump touch targets to 44px; add root metadata (favicon / OG / title template / themeColor).

---

## Verification notes

Headline claims were confirmed directly in source before writing this report:

- Contrast ratios computed (`#97B3AE` on white = 2.24:1; white-on-`#97B3AE` = 2.24:1; `#6a6a6a` on white = 5.41:1).
- Broken sentence confirmed at `HowItWorksContent.tsx:345`.
- OTP hardcode confirmed at `CheckEmailClient.tsx` (`pattern="\d{8}"`, `minLength/maxLength=8`).
- Banned amber `#EAB308` confirmed at `fireConfetti.ts:1`; non-token green/red/terracotta confirmed in `auth-island.css`.
- False RLS claim confirmed at `security/page.tsx:46`.
- Sparse 2-link footer confirmed in `SiteFooter.tsx`.
- Hardcoded "7 of 100" scarcity confirmed at `PricingContent.tsx:38-39`.
