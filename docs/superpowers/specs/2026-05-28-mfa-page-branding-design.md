# Design: Brand the MFA challenge page

> **Date:** 2026-05-28
> **Launch-ready item:** Part 2, Prioritized fix list, **P0 #4** — "Brand the MFA page + fix iOS input zoom (≥16px) + add `pattern="[0-9]*"`."
> **Rolls in audit findings:** P0 #3 (off-brand MFA), M2 (iOS input zoom), M10 (missing `pattern`), plus the approved free adjacent fixes.
> **Branch / worktree:** `fix/launch-p0-mfa-brand` at `/tmp/repworth-mfa-brand`.

---

## Problem

`src/app/mfa/challenge/page.tsx` renders on `bg-gray-50` with a `bg-blue-600`
button and `text-sm` (14px) inputs. It fires after **every** login, so it is one
of the most-seen authenticated touchpoints — yet it carries zero RepWorth brand
identity and has three concrete defects:

1. **Off-brand visuals** (P0 #3) — gray/blue bare Tailwind, not the island system.
2. **iOS input zoom** (M2) — the code input and factor `<select>` are 14px;
   iOS Safari auto-zooms the viewport on focus of any `<16px` field.
3. **Missing `pattern="[0-9]*"`** (M10) — some iOS Safari versions ignore
   `inputMode="numeric"` alone and show a full keyboard.

It also has two rough edges that become nearly free to fix during a rebuild and
are in the approved scope:

- Async state changes (loading factors, verifying, errors) are **silent to
  screen readers** — no `aria-live`.
- The no-factor and error states are **dead-ends** with only a "Return to login"
  link and no support path.

## Goal

Rebuild the page's presentation in the RepWorth island brand, fix the three
point-4 defects, and finish the touched area (branded fallback, `aria-live`,
recovery link) — **without changing any auth logic** and **without touching
shared `auth-island.css` / `/login` / `/signup`.**

## Non-goals (explicit scope boundaries)

- **`robots: noindex` on auth pages** — a one-liner, but explicitly owned by
  **P0 #3** ("add to auth pages"). Left there to keep single ownership. (Trivial
  to fold in later if desired.)
- **Shared `auth-island.css`, `/login`, `/signup`** — untouched. (The shared
  `.rw-input` is also 14.5px, but fixing it there is a wider blast radius outside
  point 4 and was deliberately not chosen.)
- **`.com` vs `.net` domain mix** (audit P2) — out of scope.
- **MFA challenge API / verification logic** (`api/auth/mfa/challenge`,
  `src/lib/auth/mfa.ts`) — untouched; this is a presentation rebuild.

## Approach

**Self-contained Tailwind + `motion/react` island**, built directly in
`page.tsx` — the idiom documented in the `repworth-brand-design` skill and used
by the marketing pages. This keeps the blast radius to a single file and gives
direct control over the 16px input. It mirrors the same `#D2E0D3` / `#97B3AE`
tokens and font stack as `/login` so the two pages read as one family, but does
**not** reuse the two-pane login/signup `AuthIslandClient` (its Showcase + Tabs
are login/signup-specific and wrong for a post-login interstitial).

### Layout

A compact, single-action card — not the multi-section marketing scroll, not the
two-pane auth layout:

- **Root:** `min-h-screen bg-[#D2E0D3] relative` — **no** `overflow-hidden`
  (honors the iOS island rule).
- **Background atmosphere:** 2 muted glassmorphism cards, `aria-hidden`,
  `hidden lg:block`. Restrained (anti-slop) — brand feel without a dot-nav,
  because a single-action page has nothing to navigate.
- **Island:** centered `max-w-md bg-white rounded-[3rem] shadow-2xl`, entered
  with the brand `motion.div` mount animation. Teal wordmark dot + `REPWORTH` at
  the top.
- **Preserved logic:** `normalizeFactor(s)`, `safeNext`, `ensureChallenge`,
  `verify`, the multi-factor `<select>` branch, all state, and the Supabase /
  fetch flow are copied over **verbatim**. Only JSX/markup and class names change.

### The three point-4 fixes

| Fix | Detail |
|---|---|
| **Brand visuals** | Sage bg, white island, **teal `#97B3AE` pill** submit as a `motion.button` (brand hover/tap); `#2a2a2a` headings, `#6a6a6a` body; red retained only for the error alert. No blue, no gray-on-gray. |
| **iOS zoom (M2)** | Code input **and** factor `<select>` move from `text-sm` → **`text-base` (16px)** so iOS won't auto-zoom. |
| **`pattern` (M10)** | `pattern="[0-9]*"` added to the code input, beside the existing `inputMode="numeric"` + `autoComplete="one-time-code"`. |

### Free adjacent fixes (approved scope)

- **Branded Suspense fallback** — the outer `MfaChallengePage` fallback renders
  the same sage island shell instead of a gray page.
- **`aria-live`** — error → `role="alert"` (`aria-live="assertive"`);
  "Loading factors…" / "Verifying…" → `aria-live="polite"`.
- **Recovery link** — the no-factor branch keeps "Return to login" **and** gains
  a "Trouble? Contact support" `mailto:support@repworth.com` link styled
  `text-[#97B3AE]`, matching the sibling `login/error.tsx` / `signup/error.tsx`
  pattern exactly. The error state gains the same support affordance.

### Motion & accessibility

- Respect `prefers-reduced-motion` via `useReducedMotion()` — skip transform/
  entry animation when set.
- Inputs keep their associated `<label>`s (already present, preserved).
- Teal `focus-visible` ring on the input, select, and submit button.

## Testing

No component-level test exists for this page today (only the API route and
`src/lib/auth/mfa.ts` are covered). Add a focused React Testing Library test
asserting the **behavioral** regressions worth guarding — not pure styling:

- Code input carries `inputMode="numeric"` **and** `pattern="[0-9]*"`.
- The no-factor branch renders **both** the "Return to login" link and the
  `mailto:support@repworth.com` support link.
- The error path exposes a `role="alert"` region.

Then the full gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Risk / blast radius

Single file changed (`page.tsx`) plus one new test file. No shared CSS, no auth
logic, no API, no DB. `/login` and `/signup` are provably unaffected because
`auth-island.css` is not touched. Worst case is a visual-only regression on one
page, caught by typecheck/build and the new test.
