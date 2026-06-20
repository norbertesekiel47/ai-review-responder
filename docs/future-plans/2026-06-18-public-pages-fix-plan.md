# Plan: Fix public-page UI/UX issues from the 2026-06-18 audit
_Locked via grill-with-docs — by Claude + Norbert. Revised after Codex Round 1. Source audit: `docs/future-plans/2026-06-18-public-pages-ui-ux-audit.md`. Decision record: `docs/adr/0004-accessible-teal-token-split.md`._

## Goal
Remediate the UI/UX defects found across RepWorth's public surface (marketing, public auth, transactional/legal pages) — all confirmed post-redesign and stable — without entering the in-flight authenticated-dashboard redesign. Fix the verified production blocker first; land the rest as one reviewed polish PR organized into per-workstream commits. No new product features, no migrations, no schema changes in this effort. A few items touch existing API routes (no new endpoints) — called out per workstream.

## Delivery shape (two PRs)
1. **Hotfix PR: OTP input length.** See workstream "OTP" — gated on verifying the live Supabase OTP length first (see OQ0). Ships standalone the moment the fix is correct.
2. **Polish PR (one big PR, per-workstream commits): everything else.** User chose one PR (Codex recommended splitting — recorded as dissent; final call is the user's). Organized into reviewable commits by workstream.

## Definition of done (both PRs)
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green (build is an AGENTS.md requirement).
- New in-repo regression guards (the enforceable ones, since the `repworth-brand-design` skill lives in `~/.claude/skills/` and is NOT source-controlled / CI-visible):
  - a computed-contrast test that **bans all `#97B3AE` foreground use except a narrow rating-glyph allowlist** (glyph `aria-hidden` inside a container with an `aria-label` rating), and bans white-on-`#97B3AE` (Codex R2: otherwise the test either fails on the intentional decorative stars or gets weakened into noise);
  - OTP input attributes match `VERIFY_EMAIL_OTP_CONSTRAINTS` (see OTP workstream);
  - any wired form-error behavior.
- Update surface-scoped palette tests (`how-it-works-palette.test.ts`, `console-admin-palette.test.ts`) to allow `--rw-teal-strong`; reconcile with `no-yellow-star-colors.test.ts` (see Contrast — stars).
- React-doctor a11y pass on touched components.
- Amend the personal `repworth-brand-design` skill to encode the teal split — **nice-to-have**, not the regression guard.

---

## Hotfix PR — OTP input length

**Conflict (OQ0, BLOCKING):** the grill answer was "live = 6," but Codex found `docs/runbooks/completed_runbooks/signup-test-runbook.md` documenting Supabase issuing **8**-digit OTPs with a passing happy-path, and the code + in-file comment say 8. These cannot both be true. **Verify the live Supabase "Email OTP Length" before writing code.**

Fix (works regardless of the answer): make the input **length-neutral** against the server's real contract. Concretely (Codex R2): the contract is buried in `VerifyEmailOtpSchema` as **4–10 alphanumeric** — export a single `VERIFY_EMAIL_OTP_CONSTRAINTS` constant and build **both** the Zod schema **and** the UI `minLength`/`maxLength`/`pattern`/copy from it. One source of truth; can't drift; accepts whatever Supabase emits (the current hardcoded `\d{8}` rejects a 6-digit code, so this fixes it if prod is 6). No new env/config.
- If verification shows **6**: this is an urgent live signup-blocker → ship immediately.
- If verification shows **8**: code is already correct → the length-neutral change is hardening; also fix the stale CLAUDE.md/runbook notes.
- Add a regression test for the accepted length(s).

---

## Polish PR — workstreams

### A. Contrast system (ADR 0004) — highest-ROI systemic fix
- Add `--rw-teal-strong: #557069` (actionable teal) alongside `--rw-teal: #97B3AE` (decoration only).
- **Context rules (Codex R1 — `#557069` does NOT clear AA on every background):** `#557069` = 5.37:1 on white, 4.64:1 on cream `#F0EEEA` (both pass), but only 3.93:1 on sage `#D2E0D3` and 2.40:1 on `#97B3AE` (both fail normal text). Therefore:
  - Strong-teal **text** only on white/cream backgrounds.
  - On sage `#D2E0D3` or teal backgrounds, text uses ink `#2a2a2a` (or darker), never strong-teal-on-sage for body copy.
- **Primary buttons on white islands:** solid `#557069` pill, white label (grill: Row 1 = Option B).
- **Primary action on teal CTA band:** white pill, `#557069` text (grill: Row 2 = Option A).
- **CTA band rule (canonical — ADR 0004, exactly three cases):** (1) a `#97B3AE` band **may** carry **dark-ink `#2a2a2a`** copy plus **white-pill** actions (6.41:1); (2) a band that must carry **white** copy **darkens to `#557069` or darker** (white on `#97B3AE` is 2.24:1); (3) **text-free** teal decoration may stay `#97B3AE`.
- **Secondary/outline buttons:** `#557069` text + border.
- **Stars stay decorative `#97B3AE`** WITH an `aria-label` rating (Codex R1: avoids conflict with `no-yellow-star-colors.test.ts`, which requires `#97B3AE` stars across public+authenticated+admin, and avoids recoloring out-of-scope authenticated/admin surfaces).
- Add approved **error** + **success** tokens; purge non-token `#dc2626`/`#b91c1c`/`#16a34a`/`#EAB308`/`#e0a089`/`#D97757`/`#E8A394` (incl. amber signup confetti, green strength bar/dot, terracotta strength bar).
- Regression guard = the in-repo computed-contrast test above; update palette tests.

### B. Systemic a11y + motion
- Shared `usePrefersReducedMotion` / motion `useReducedMotion` guard on every JS animation: `useCountUp`, all typewriters, `TimelineSection` RAF clock, `TickerBar` intervals, `PageShell` parallax, all `motion/react` entrance/stagger. (CSS reduced-motion blocks exist but only cover CSS.)
- Skip-to-content link in **`src/app/(public)/layout.tsx`** (NOT the global `src/app/layout.tsx` — Codex R2: a global skip link would create broken `#main-content` targets on admin/auth/onboarding, which are out of scope) + **exactly one `<main id="main-content">` per public page, reconciled shell-by-shell** (Codex R1: `SiteShell` defaults to `div`, `PageShell` wraps in `div`, `security/page.tsx` already renders an inner `<main>` — don't create nested/missing landmarks).
- `:focus-visible` rings on all buttons/links/tabs/toggles (auth island CSS is missing them; match AuthCardShell).
- Touch targets ≥44px: hamburger, nav CTAs, password toggle, auth tabs, pricing toggle.
- Star glyphs `aria-label` + `aria-hidden` on glyphs (apply everywhere Hero already does it).
- Heading order: fix how-it-works h1→h3 skip; verify Features.
- VoiceDial: real `role="slider"` + arrow keys + visible focus (or surface the range input); drop `aria-hidden` on the control.
- Fix `.rw-lang-chip` reduced-motion content-loss (stays `opacity:0`).

### C. Chrome (keep the 3 deliberate shells)
- Expand `SiteFooter`: Product (Features/Pricing/How-it-works), Legal (Privacy/Terms/Security/Sub-processors/Cookies/AUP), Company (Contact). Keep the dynamic year.
- Place the footer on trust/content pages currently footerless: **security, book-a-demo, help/contact, legal**. Keep **approval and feedback/thanks focused** (no marketing footer/nav).
- Both shells consume `--rw-teal-strong` + the reduced-motion guard.
- Root metadata: `metadataBase`, favicon/icons, `openGraph` + `twitter` cards, `title` template (`%s · RepWorth`), `viewport` `themeColor: #D2E0D3`. Audit whether Inter is dead weight.
- Nav: `usePathname()` → `aria-current="page"` + visible active style; **mobile menu = disclosure pattern (Escape close + focus restore), NOT a focus trap** (Codex R1: it's an inline dropdown, not a modal); wrap nav in `<header>` with `aria-label`.

### D. Approval flow (pure UI — decline FEATURE deferred)
- **Confirm-before-post must gate BOTH `approve` AND `edit`/"Save & Approve"** (Codex R1: edit also enqueues `publish_response`). Snapshot the action + edited text in the confirm state.
- Relabel "Approve" → "Approve & post to Google".
- Fix the success CTA: stop sending logged-out link recipients to `/dashboard` (login wall); demote dashboard to secondary.
- Success copy: **generic async-safe** — **"Approved; posting has started"** (Codex R2: real state-specific handling of `awaiting_owner_connect`/publish-failure is NOT UI-only — the approve/edit routes only return immediate success + enqueue `publish_response`; defer actual publish-state reporting to a backend/worker-aware PR). This pass only changes copy so it never claims the reply is already live.
- Add decline-reassurance copy now (UI-only): **"Close this page — nothing posts unless you approve."** The real decline status/audit feature stays a separate staging-first PR.
- `ApprovalErrorState`: neutral **"This link has already been used"** for consumed links (Codex R1: consumed can be edit/regenerate, not only approve) unless the route is extended to read response/audit state; differentiate genuine errors (invalid/expired/5xx) from used.
- Map raw error strings (`HTTP 500`, "Session binding failed") to friendly copy by status (401/403/409/410/429/5xx).
- `aria-busy`/`aria-live` on in-flight actions; fix "0 hours" expiry display; `maxLength` + counter on the edit textarea.

### E. Transactional reliability + content
- `DemoStatusIsland`: cap the `router.refresh()` poll loop (currently every 5s forever) with attempts + backoff/jitter; "taking longer than usual" state past the window; soften "30–60 seconds".
- Add fetch timeouts (AbortController) to auth/approval/demo network calls (production.md) + recovery messaging.
- Demo viewer empty state; suppress "0 reviews/replies" chips.
- Legal: TOC/anchor nav with `scroll-margin-top`; `<caption>` + scroll hint on the sub-processor table; cross-links between legal docs; drop the internal repo path from public Terms copy.
- Fix the broken How-It-Works bullet (`"Polls sleeps and reacts and detecting a new review"`).
- Reconcile poll-cadence copy to one figure across pages; reconcile 96%/100% to one figure.

### F. Truthfulness (remove false claims, keep labeled demos)
- Remove: aggregate counts presented as live (ticker hours/businesses/joined), hardcoded "7 of 100 spots" scarcity, named real-sounding reviewers/competitors + invented competitor response rates, "127 reviews answered while you slept" framed as the user's data.
- Keep product demos, clearly marked "example / sample".
- Reconcile "waitlist vs claim-a-spot vs coming-soon" to one pre-launch verb; rename `/book-a-demo` to match the waitlist reality (or make the H1 match the route's promise).

### G. Forms (API-touching — NOT pure UI; Codex R1)
- Lead-intake: real `<label>`s; **honeypot/time-trap requires server-side validation in `/api/lead-intake`** (+ tests) to actually work — this workstream touches the route, not just the form. Per-field inline errors + `aria-invalid`/`aria-describedby`; focus-move to first invalid field; Maps field `type="url"`; mark required; consent/privacy microcopy; `aria-busy` + spinner.
- Auth forms: wire the existing-but-unused per-field error plumbing in `Field.tsx` (or remove it); show password rules before submit; de-noise the strength `aria-live`; fix `Tabs` ARIA (drop `role="tab"`/`tablist` for nav semantics, or implement the full pattern) and preserve typed email across mode switch; map raw Supabase/server messages to curated copy; keep email out of the URL on login→check-email.

## Key decisions & tradeoffs (resolved in the grill + Codex R1)
1. **Scope** — all 3 public surfaces stable; fix everything in-bounds. Dashboard redesign is authenticated-only.
2. **Contrast** — teal split via `--rw-teal-strong: #557069` (ADR 0004) WITH per-background context rules; CTA bands follow the canonical three-case rule (dark-ink copy OK on `#97B3AE`; white copy needs `#557069`+; text-free stays `#97B3AE`); stars stay decorative+labeled.
3. **Decline path** — DEFERRED feature; this pass adds reassurance copy only.
4. **Chrome** — keep 3 shells; fix shared gaps; one `<main>` per page; disclosure (not focus-trap) mobile nav.
5. **Truthfulness** — remove false claims, keep labeled demos.
6. **OTP** — length-neutral input bound to the server contract; **live length MUST be verified first (OQ0)**.
7. **Delivery** — OTP hotfix; everything else one big PR with per-workstream commits; DoD includes `pnpm build`.

## Risks / open questions
- **OQ0 (BLOCKING, the OTP conflict):** verify the live Supabase "Email OTP Length." Runbook + code say 8; the grill answer said 6. Do not write the OTP fix until confirmed. The length-neutral approach de-risks either way, but the "live blocker / ship today" urgency only holds if it's actually 6.
- **OQ1 (blocking the email-consistency fix):** canonical support/privacy email — legal docs use `info@`; contact uses `support@`/`billing@`/`security@`. GDPR data-deletion to a dead mailbox is a compliance risk.
- **OQ2 (review wording):** the Security-page RLS claim rewrite (from CLAUDE.md invariant #8) needs Norbert's review since security claims are sensitive.
- **Risk:** one big PR → slow review (Codex dissent). Mitigated by per-workstream commits + the carved-out OTP hotfix.
- **Risk:** contrast sweep is wide. Mitigated by the in-repo computed-contrast test + palette-test updates.

## Out of scope
- The authenticated owner dashboard + its in-flight redesign.
- Public auth visual redesign (only a11y/correctness here).
- The approval **decline/reject** feature (separate spec + staging-first migration).
- Recoloring stars on authenticated/admin surfaces (kept decorative `#97B3AE`).
- New testimonials/metrics infrastructure (no real data yet).
- A new `/help/contact` form backend (treat as follow-up unless trivial with existing BotID/enqueue infra).
