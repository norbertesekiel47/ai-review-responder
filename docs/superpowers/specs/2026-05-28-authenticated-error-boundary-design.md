# Design — Branded error boundaries for the owner app

> **Date:** 2026-05-28
> **Branch:** `fix/launch-p0-error-boundary`
> **Source:** `docs/launch-ready-part2.md` → Prioritized fix list, P0 #9 (line 142):
> *"Add `(authenticated)/error.tsx` branded error boundary."* Cross-cutting finding (line 39):
> *"No `error.tsx` in `(authenticated)` — any server-component throw drops owners to an unbranded Next.js error page."*

## Problem

The `(authenticated)` route group (the owner Console) has **no error boundary**. When any
server component under it throws — most plausibly a DB read in `dashboard`, `settings`,
`past-replies`, etc. — Next.js falls back to the bare `global-error.tsx`, which is an
unstyled `system-ui` page with a naked "Try again" button. An owner mid-task lands on what
looks like a broken developer prototype, with no brand, no recovery path beyond reload, and
no way to reference the failure to support.

## Goals

1. Owners never see an unbranded error page in the authenticated app.
2. A page-level throw keeps the owner inside the Console (nav intact) with a branded,
   recoverable error state.
3. A catastrophic throw (root/layout) still lands on a branded, self-contained full-page
   error.
4. Both boundaries report to Sentry and give the owner a reference ID + support escape hatch.

## Non-goals (out of scope)

- Branded `not-found.tsx` (404s) — not flagged by the audit.
- Per-segment error boundaries below the group root — one boundary at the group root suffices.
- Reworking `(public)/login/error.tsx`, `signup/error.tsx`, `onboarding/error.tsx` — separate
  audit items, separate palettes.
- Retrofitting Sentry capture into the other existing `error.tsx` files.

## Key Next.js / brand facts that shape the design

- A **segment `error.tsx` renders *inside* its layout's children slot.** So
  `(authenticated)/error.tsx` renders within `(authenticated)/layout.tsx` — the `Sidebar` +
  `MobileTabBar` chrome stay, the error fills `.main`. The `.rw-console` wrapper (and thus
  `tokens.css` / `console.css`) is in scope.
- A segment `error.tsx` **does not catch throws from its own layout.** If
  `(authenticated)/layout.tsx`'s DB queries throw, the error bubbles past this boundary to
  `global-error.tsx`. Hence we brand `global-error.tsx` too.
- `global-error.tsx` **replaces the root layout** and renders its own `<html>`/`<body>`.
  None of the app/console CSS is guaranteed loaded, and it can fire on *any* surface (public,
  auth, console). It must be **fully self-contained** (inline styles), use the **public island
  palette** (sage/teal/white — RepWorth's universal brand face), and stay dependency-light
  (no `motion`/no external CSS — it is the catastrophic fallback).
- The RepWorth brand skill exempts the owner dashboard from the marketing island
  ("Never place content directly on the sage green … *except for the admin and owner dashboard
  pages*"). So `(authenticated)/error.tsx` uses the **Console** palette, not the island.

## Design

### Two boundaries

| File | Fires when | Renders in | Palette |
|---|---|---|---|
| `src/app/(authenticated)/error.tsx` *(new)* | A **page** under `(authenticated)/` throws | Inside Console shell — Sidebar/MobileTabBar stay, error fills `.main` | **Console** (gray-50/white, red error accent, green `.btn-primary` recovery) |
| `src/app/global-error.tsx` *(rebrand)* | Root layout or `(authenticated)/layout.tsx` throws | Full page, own `<html>`/`<body>`, no external CSS | **Island** (sage `#D2E0D3` + teal `#97B3AE` + white card + wordmark), inline-styled |

### `src/app/(authenticated)/error.tsx` (new)

- `'use client'`. Default export `AuthenticatedError({ error, reset })`,
  `error: Error & { digest?: string }`, `reset: () => void`.
- `useEffect(() => Sentry.captureException(error), [error])` — consistent with `global-error.tsx`.
- Markup uses Console classes (no inline Tailwind):
  - Container `.error-state` with `role="alert"`.
  - `.error-state-icon` — red-tinted circle, **inline SVG** warning glyph (no external icon lib).
    `aria-hidden="true"`. **Static — no float/bounce animation** (deliberate restraint; errors
    are not celebratory like the empty-state).
  - `<h1 className="error-state-title" tabIndex={-1}>` focused on mount via ref, so keyboard /
    screen-reader users land on the recovery region.
  - `.error-state-sub` body copy.
  - `.error-state-actions` row (flex-wrap), reusing existing `.btn` classes:
    - **Try again** — `<button type="button" className="btn btn-primary">` → `reset()`.
    - **Back to dashboard** — `<a className="btn btn-secondary" href="/dashboard">`.
    - **Contact support** — `<a className="btn btn-tertiary" href="mailto:support@repworth.com">`.
  - **Reference ID** — `{error.digest ? <p className="error-state-ref">Reference: {error.digest}</p> : null}`
    (absent in dev where `digest` is undefined).
- Copy (honest, no hype, no unverifiable data-safety claim):
  - Title: `Something went wrong`
  - Sub: `We couldn't load this page. This one's on us — try again, or head back to your dashboard.`

### New CSS — `.error-state` block in `src/app/(authenticated)/_styles/console.css`

Small focused block, modeled on the existing `.empty-caught-up` idiom, with a red accent from
existing `--rw-red-*` tokens (no new colors):

- `.error-state` — `min-height:70vh`, flex column, centered, `text-align:center`, `padding`, `gap`.
- `.error-state-icon` — ~56px circle, `background: var(--rw-red-50)`, glyph `color: var(--rw-red-600)`.
- `.error-state-title` — `var(--rw-font-display)`, ~20px, `var(--rw-app-text)`.
- `.error-state-sub` — 13–14px, `var(--rw-app-text-muted)`, `max-width: ~360px`.
- `.error-state-actions` — `display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin-top`.
- `.error-state-ref` — `var(--rw-font-mono)`, ~12px, `var(--rw-app-text-soft)`, `margin-top`.

One authoritative owner for the error-state pattern.

### `src/app/global-error.tsx` (rebrand)

Keep `'use client'`, the `Sentry.captureException` `useEffect`, and `reset`. Replace the bare
markup with a **self-contained inline-styled** sage island card:

- Returns `<html lang="en"><body style={{margin:0}}>…</body></html>`.
- Sage page field `#D2E0D3`, centered white card `border-radius: 2rem`, `shadow-2xl`-equivalent.
- RepWorth wordmark (teal gradient dot + uppercase `RepWorth`, `#97B3AE`).
- Title `Something went wrong`; sub `An unexpected error interrupted RepWorth. Please try again.`
- **Try again** — teal pill `<button type="button" onClick={() => reset()}>`.
- Links: **Go to RepWorth home** → `/` (not "dashboard" — wrong context for a root-level error)
  and **Contact support** → `mailto:support@repworth.com`.
- `{error.digest ? Reference: {error.digest} : null}` in muted mono.
- **No `motion`, no external CSS, no icon lib** — resilient catastrophic fallback.

## Testing

- `src/app/(authenticated)/__tests__/error.test.tsx`:
  - heading `Something went wrong` renders;
  - clicking **Try again** calls `reset`;
  - **Back to dashboard** link points to `/dashboard`; **Contact support** is a `mailto:`;
  - reference ID renders when `error.digest` set, hidden when undefined;
  - container has `role="alert"`;
  - `Sentry.captureException` called with the error (`@sentry/nextjs` mocked).
- `src/app/__tests__/global-error.test.tsx`:
  - renders; **Try again** calls `reset`; `Sentry.captureException` called; reference shows
    with digest. (Component returns `<html>`; the expected React DOM-nesting `console.error`
    is spied/suppressed in this one test.)

## Files changed

- `src/app/(authenticated)/error.tsx` — new
- `src/app/(authenticated)/_styles/console.css` — add `.error-state*` block
- `src/app/global-error.tsx` — rebrand
- `src/app/(authenticated)/__tests__/error.test.tsx` — new
- `src/app/__tests__/global-error.test.tsx` — new

## Verification

Run in the worktree (`/private/tmp/repworth-error-boundary`):

```
pnpm lint && pnpm typecheck && pnpm test
```

(No DB/schema changes → tenant-scope / RLS audits not required.)

## Alternatives considered

- **Reuse `.empty-caught-up`** — rejected: tuned for a celebratory "all caught up" tone
  (floating emoji), wrong for an error.
- **Inline Tailwind in the component** — rejected: raw Tailwind in the Console is exactly the
  `dashboard/connect` P0 anti-pattern the audit flags.
- **Island-style the in-shell error** — rejected: the brand skill exempts the dashboard from
  the island; the Console palette is the on-brand choice there.
- **Only `(authenticated)/error.tsx`, leave `global-error.tsx` bare** — rejected: leaves the
  layout-throw gap on an unbranded page; user opted to close it.
