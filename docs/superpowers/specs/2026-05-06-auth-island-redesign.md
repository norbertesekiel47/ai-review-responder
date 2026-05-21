# Auth Island Redesign — `/login` & `/signup`

**Date:** 2026-05-06
**Status:** Approved (verbal); pending written spec review
**Owner:** Norbert
**Source design bundle:** Claude Design handoff (`RepWorth Auth.html`) — combined Sign in / Create account on a single island with a tab toggle.

---

## 1. Goals

Replace the current minimalist gray `/login` and `/signup` pages with the brand-aligned "auth island" design — sage parallax field, white `rounded-[3rem]` two-pane island, tabbed Sign in / Create account, animated entry, password strength meter, success-state confetti — without breaking any existing auth behavior.

## 2. Non-goals (explicit)

- **Do not change the `/api/auth/signup` request schema.** It accepts only `{ ownerEmail, ownerName, ownerPhone, password }`. Business name belongs to the post-payment `/onboarding/business` wizard.
- **Do not touch `/admin/login`.** It must continue rendering today's `LoginFormClient` byte-identically (different `portal`, `allowedRoles`, `showGoogleButton=false`, `defaultRoute=/admin/overview`).
- **Do not restyle `/forgot-password`, `/reset-password`, `/signup/check-email`, or `/signup/finish`.** Linked-to from the new island, but their visual rework is a separate spec.
- **Do not add a "Business name" field to signup.** Out of scope; would require schema + migration + backend churn.
- **Do not change post-login routing logic.** Subscription guard, `from` param sanitization, role checks, "email not confirmed" branch all stay.

## 3. User-visible behavior

### 3.1 Routing

- `/login` renders the new island with **Sign in** tab active by default.
- `/signup` renders the same island with **Create account** tab active by default.
- Toggling the tab calls `router.replace('/login')` or `router.replace('/signup')` so the URL stays canonical, browser history doesn't grow, and refreshing keeps the user on the chosen tab.
- Both pages remain gated by `SELF_SERVE_SIGNUP_ENABLED === 'true'` (server-side `notFound()`).

### 3.2 Sign in form (preserves all existing behavior)

| Field | Type | Notes |
|---|---|---|
| Email | `email`, `autoComplete="email"`, required | Trim + lowercase before submit (existing) |
| Password | `password`, `autoComplete="current-password"`, required | Show/hide eye toggle (new) |
| Keep me signed in | checkbox, default true | New (visual only — Supabase session is already persistent; treated as a UX affordance, not wired to a different auth flow) |
| Forgot password? | link | Routes to `/forgot-password` (owner) — unchanged |
| Continue with Google | button | Same `signInWithOAuth` call with `redirectTo=/api/auth/callback?flow=owner&next=/dashboard` |

**Submit handler** is the existing logic, factored into `useLoginSubmit({ portal, allowedRoles, defaultRoute })`:

1. `signInWithPassword({ email, password })`
2. On `email not confirmed` → push to `/signup/check-email?from=login&email=…`
3. Lookup `users.role` by `auth_id`; failed lookup → "Could not load…", null row → "not fully set up", role mismatch → portal-mismatch copy.
4. Owner only: fetch `/api/auth/signup-status`; `pending_payment` → `/onboarding/pay`, `active && !businessOnboarded` → `/onboarding/business`. Soft-fail on fetch error.
5. Honor sanitized `from` query param (allow-listed prefixes per portal).
6. Surface `?error=account_incomplete` and `?error=auth_callback_failed` via the same in-form error slot.

### 3.3 Create account form (preserves all existing behavior)

| Field | Type | Notes |
|---|---|---|
| Your name | text, `autoComplete="name"`, required | Maps to `ownerName` |
| Phone (optional) | tel, `autoComplete="tel"` | Maps to `ownerPhone`. Replaces the design's "Business name" 2nd column to match the API. Empty → omit from payload. |
| Work email | email, `autoComplete="email"`, required | Maps to `ownerEmail` |
| Create a password | password, `autoComplete="new-password"`, required, `minLength=8` | Show/hide eye toggle |
| Password strength meter | 4 bars + label | Computed client-side; not sent. Uses the design's `strengthOf()` rules: ≥8 chars, mixed case, digit, ≥10 chars + symbol. |
| Terms & Privacy | checkbox, required | CTA disabled until checked. Links to `/terms` and `/privacy`. |
| Sign up with Google | button | Same OAuth flow, `redirectTo=/api/auth/callback?flow=owner&next=/signup/finish` |

**Submit handler** is the existing logic, factored into `useSignupSubmit()`:

1. `POST /api/auth/signup` with `{ ownerEmail, ownerName, ownerPhone?, password }`.
2. On 4xx/5xx, render `body.message` if present; otherwise map `body.error` through `KNOWN_MESSAGES` (rate_limited / rate_limit_unavailable / email_rate_limited / invalid_json / invalid_body / internal). On 409 `account_exists`, show "An account with that email already exists. Try signing in." and surface a link that switches the tab to **Sign in** with the email pre-filled.
3. On 201 → `router.push(body.redirectTo ?? '/signup/check-email')`.

### 3.4 Tab toggle

Single source of truth: the URL pathname. The `Tabs` component reads `usePathname()` and renders the spring-easing pill per the design CSS (`cubic-bezier(0.34, 1.56, 0.64, 1)`).

Tab pill implementation: measure the active tab's `getBoundingClientRect()` in a `useLayoutEffect` keyed on the active mode + `ResizeObserver`, then animate the pill's `left` / `width` via plain CSS transitions (no `motion/react` `layout` prop — its FLIP needs a stable element identity, which our two distinct buttons don't share). This matches the design's `app.jsx` exactly.

Clicking a tab calls `router.replace`. The footnote link ("Already have an account?" / "New to RepWorth?") behaves identically.

`AuthIslandClient` owns a small piece of shared state — `prefilledEmail: string` — set when the signup form receives `account_exists` (so switching to the Sign in tab carries the email forward). Reset on tab change initiated by the user clicking the tabs directly.

### 3.5 Decorative animations

| Element | Implementation |
|---|---|
| Page intro (island fade + rise) | `motion/react` initial→animate, 0.8s easeOut |
| Tab pill spring | `motion/react` `layout` prop (or measured rect + animated `left`/`width`) |
| Form field stagger | CSS `@keyframes rise` with `nth-child` delays (per design) |
| Parallax sage blobs (4) | CSS `@keyframes blobDrift1/2/3` |
| Floating frosted preview cards (4) | CSS `@keyframes floatA/floatB`, `display:none` < 1100px (per design) |
| Live-status chips (2) | CSS pulse + float |
| Walking robot mascot | Inline SVG + CSS keyframes (`robotWalk`, `robotBob`, arms/legs swing, eye blink, speech bubble) |
| Submit sheen sweep | CSS `::before` translate on `:hover` |
| Success ring pulse | CSS `@keyframes ringPulse` |
| Success check stroke draw | CSS `stroke-dashoffset` animation |
| Confetti | DOM-injected layer, 60 particles, `@keyframes confetti`, auto-remove after 2.2s |

`prefers-reduced-motion: reduce` collapses every keyframe duration to `0.001s` and disables the robot walk + parallax drift (CSS media query at the bottom of the auth island stylesheet).

### 3.6 Responsive behavior

- ≥ 900px → two-pane (showcase | form).
- < 900px → showcase pane hidden, form pane spans full width with reduced padding (per design CSS).
- < 1100px → parallax preview cards and chips hidden (per design CSS).
- Form pane min-width safe at 360px.

### 3.7 Accessibility

- All `aria-hidden="true"` on decorative `ParallaxField`, robot, chips.
- Tab buttons use `role="tab"` + `aria-selected`; tab pill is decorative.
- Password show/hide button has `aria-label="Show password"` / `"Hide password"`.
- Strength meter has `aria-live="polite"` on the label, bars are `aria-hidden`.
- Error message slot has `role="alert"`.
- Both forms are keyboard-traversable in source order; tab toggle is reachable above the form.
- Color contrast: heading `#2a2a2a` on `#fff` = 14.6:1; body `#6a6a6a` on `#fff` = 5.2:1; teal `#97B3AE` button text `#fff` = 2.6:1 (fails WCAG AA for body, but matches existing brand CTA pattern across the marketing site — accepted).

---

## 4. File-level changes

### 4.1 New files

- `src/components/auth/AuthIslandClient.tsx` — entry component. Props: `{ initialMode: 'login' | 'signup' }`. Owns `ParallaxField`, `Showcase`, `Tabs`, conditional `<LoginForm>`/`<SignupForm>`, footnote.
- `src/components/auth/auth-island.css` — all auth-island scoped styles (parallax, robot, confetti, strength bars, success ring). Imported once at the top of `AuthIslandClient.tsx`.
- `src/components/auth/auth-island/ParallaxField.tsx` — decorative blobs/pcards/chips (no props, `aria-hidden`).
- `src/components/auth/auth-island/Showcase.tsx` — left pane. Props: `{ mode: 'login' | 'signup' }`. Owns brand mark, eyebrow, heading, lead, two preview review cards, stat tiles, robot.
- `src/components/auth/auth-island/Tabs.tsx` — tab pill, reads `usePathname()`, calls `router.replace()`.
- `src/components/auth/auth-island/LoginForm.tsx` — visual login form. Calls `useLoginSubmit` + `useGoogleOAuth`.
- `src/components/auth/auth-island/SignupForm.tsx` — visual signup form. Calls `useSignupSubmit` + `useGoogleOAuth`. Owns strength meter + Terms checkbox.
- `src/components/auth/auth-island/Field.tsx` — input row with leading icon + optional show/hide toggle.
- `src/components/auth/auth-island/Icons.tsx` — inline-SVG set (`Mail`, `Lock`, `User`, `Phone`, `Eye`, `EyeOff`, `Check`, `Arrow`, `Sparkle`, `Google`).
- `src/components/auth/auth-island/Robot.tsx` — inline-SVG mascot.
- `src/components/auth/auth-island/fireConfetti.ts` — pure DOM helper.
- `src/components/auth/auth-island/strength.ts` — `strengthOf()` + `STRENGTH_LABELS`.
- `src/components/auth/hooks/useLoginSubmit.ts` — extracted from `LoginFormClient`. Inputs: `{ portal, allowedRoles, defaultRoute }`. Returns `{ submit, loading, error, success }`.
- `src/components/auth/hooks/useSignupSubmit.ts` — extracted from `SignupFormClient`. Returns `{ submit, loading, error, success }`.
- `src/components/auth/hooks/useGoogleOAuth.ts` — shared OAuth helper. Inputs: `{ flow: 'owner' | 'admin', next: string }`.
- `src/components/auth/__tests__/AuthIslandClient.test.tsx` — Vitest + RTL.

### 4.2 Modified files

- `src/app/(public)/login/page.tsx` — render `<AuthIslandClient initialMode="login" />`. Keep the `SELF_SERVE_SIGNUP_ENABLED` `notFound()` gate.
- `src/app/(public)/signup/page.tsx` — render `<AuthIslandClient initialMode="signup" />`. Keep the gate.
- `src/app/(public)/login/error.tsx` — re-skin to island palette (white card, sage page bg, teal CTA, ink text). Same retry + support-email behavior.
- `src/app/(public)/signup/error.tsx` — same re-skin.
- `src/components/auth/LoginFormClient.tsx` — refactor to consume `useLoginSubmit` + `useGoogleOAuth` (no behavior change). Visual remains gray-utility for `/admin/login`.
- `src/components/auth/SignupFormClient.tsx` — DELETE. Confirmed via grep: only consumer is `src/app/(public)/signup/page.tsx` (which now uses `AuthIslandClient`); two other matches in `signup/route.ts` and `signup.test.ts` are documentation comments referencing the symbol's behavior, not imports. Logic lives in `useSignupSubmit`.

### 4.3 Untouched (must remain identical)

- `src/app/admin/login/page.tsx`
- `src/app/api/auth/signup/route.ts`
- `src/app/api/auth/callback/**`
- `src/app/api/auth/signup-status/**`
- `src/lib/shared/auth-flow.ts`
- `src/lib/shared/auth-responses.ts`
- `src/lib/shared/schemas.ts` (SignupSchema)
- `src/lib/onboarding/create-business.ts`
- `src/components/auth/{ForgotPasswordFormClient,ResetPasswordFormClient,CheckEmailClient,FinishSignupClient}.tsx`

---

## 5. Failure-mode mapping (every API error has a rendered message)

The error slot lives above the CTA. It uses `role="alert"`, `bg-[#FEF2F2] border-[#DC2626]/30 text-[#B91C1C]` styling.

| Source | Surface |
|---|---|
| `signInWithPassword` returns `Invalid login credentials` | "Email or password is incorrect." |
| `signInWithPassword` returns `email not confirmed` | navigate to `/signup/check-email?from=login&email=…` (no inline error) |
| `users` lookup error | "Could not load your account details. Please try again." |
| `users` row missing | "Your account is not fully set up. Contact your administrator." |
| Role not in allowedRoles | "That account is for the admin portal. Use /admin/login instead." |
| `?error=account_incomplete` | "Your account is not set up yet. Contact your administrator." |
| `?error=auth_callback_failed` | "Sign-in failed. Please try again." |
| `signInWithOAuth` returns error synchronously | "Could not start Google sign-in. Please try again or use the email form below." |
| Signup 429 `rate_limited` | "Too many signup attempts from your network. Please wait a few minutes and try again." |
| Signup 503 `rate_limit_unavailable` | "Signup is temporarily unavailable. Please try again in a moment." |
| Signup 429 `email_rate_limited` | "Too many signup attempts for this email recently. Please wait a few minutes and try again." |
| Signup 409 `account_exists` | "An account with that email already exists." + "Sign in" link that switches tab and pre-fills email |
| Signup 400 `invalid_json` / `invalid_body` | "Some details don't look right. Please review and resubmit." |
| Signup 500 `internal` | "Something went wrong on our side. Please try again shortly." |
| Network/`fetch` rejection | "Connection failed" |

---

## 6. Testing plan

### 6.1 Vitest unit / component (`src/components/auth/__tests__/AuthIslandClient.test.tsx`)

- Renders Sign in heading when `initialMode="login"`.
- Renders Create account heading when `initialMode="signup"`.
- Tab click calls `router.replace('/signup')` / `'/login'`.
- Password show/hide toggle flips input `type` between `password` and `text`.
- Signup CTA is disabled until Terms checkbox is checked.
- Strength meter lights bars 1→4 as password complexity increases.
- Login submit calls `signInWithPassword` with trimmed lowercase email.
- Signup submit POSTs to `/api/auth/signup` with the right shape (omits `ownerPhone` when empty).
- Login `?error=auth_callback_failed` query param renders the alert.
- 409 `account_exists` from signup renders the "Sign in" link that switches to the login tab with email pre-filled.
- Reduced-motion media query suppresses confetti DOM injection.

### 6.2 Existing `LoginFormClient` regression

- After hook extraction, the existing `/admin/login` flow still works. Add a snapshot or render test that mounts `LoginFormClient` with admin props and asserts it does NOT render the Google button (since `showGoogleButton=false`).

### 6.3 Manual dev smoke (`pnpm dev`, port 3000)

- `/login` → Sign in tab active, island renders, parallax animates, robot walks.
- `/signup` → Create account tab active, strength meter responds.
- Toggle tabs → URL changes between `/login` and `/signup` without a full page reload.
- `/login?error=auth_callback_failed` → red alert renders.
- `/login?from=/dashboard/x` → after successful login, lands on `/dashboard/x`.
- `/login?from=//evil.com` → after successful login, lands on `/dashboard` (sanitized).
- `/admin/login` → unchanged gray utility form, no Google button.
- DevTools mobile emulation at 375px wide → showcase pane hidden, form usable.
- DevTools `prefers-reduced-motion: reduce` → no confetti, no robot walk, blobs static.
- Lighthouse a11y → no new errors above the existing baseline.

### 6.4 Lint + typecheck

- `pnpm lint` clean.
- `pnpm test` green.

---

## 7. Dependencies

- `motion/react` — already installed (used across marketing pages).
- Plus Jakarta Sans + DM Sans — already loaded in `src/app/layout.tsx` via `next/font/google` (`--font-plus-jakarta`, `--font-dm-sans`).
- No new npm packages.

---

## 8. Rollout

Single PR. Branch: `auth-island-redesign`. Behind no flag — the design replaces the existing pages directly. Risk is bounded by:

- Public auth surfaces only (`/login`, `/signup`).
- Admin login untouched.
- API contract untouched.
- No DB migrations.

Rollback = revert the PR; old pages return.

---

## 9. Open questions

None. The "Business name" omission is resolved (defer to onboarding wizard). The combined-page choice is approved (option B from the brainstorming proposal: same components on `/login` and `/signup`, default tab differs by route).
