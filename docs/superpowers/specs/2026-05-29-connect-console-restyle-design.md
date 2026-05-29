# Restyle `dashboard/connect` into the Console — Design

**Date:** 2026-05-29
**Audit item:** `docs/launch-ready-part2.md` → Prioritized fix list → **P0 #10**:
"Restyle `dashboard/connect` with Console classes; remove amber/orange."
**Branch:** `worktree-fix-launch-p0-connect-console`

## Problem

`src/app/(authenticated)/dashboard/connect/page.tsx` (541 lines) is a raw-Tailwind
prototype living inside the owner **Console** shell (`.rw-console` → sidebar + `.main`),
but it ignores the Console design system entirely. Per the audit (line 86):

> raw Tailwind prototype (`rounded-lg border-gray-200`, `bg-blue-600`), not Console
> classes; **looks like a different product**. `ReadOnlyConnectView` uses `amber-*`,
> `ReconnectView` uses `text-orange-700`.

Concretely, all 8 view sub-components hand-roll `rounded-lg border-gray-200 bg-white p-6`
cards with `bg-blue-600` buttons, and three of them use the banned warm palette:

| Sub-view | Lines | Warm tones |
|---|---|---|
| `ReadOnlyConnectView` | 285–302 | `border-amber-200 bg-amber-50`, `text-amber-{950,900,800}` |
| `ReconnectView` (queued-count) | 385 | `text-orange-700` |
| `FinalizeUnknownView` | 484–488 | `border-yellow-300 bg-yellow-50`, `text-yellow-{900,800}` |

## Goal

Make the page read as a native Console page by expressing it through the existing
Console primitives, and remove **all** warm tones. This is a **presentational-only**
change — no behavior, copy, routing, or analytics changes.

## Non-goals (explicitly out of scope)

- **No `TopBar`.** The audit flags the missing TopBar on `select-location` (item #16)
  but **not** on the connect page — the connect-page complaint is purely visual styling.
  Adding TopBar would also entangle the connect-page tests with `LocationPicker` /
  `useLocationScope` internals. Out of scope.
- **No behavior/logic/copy changes.** Every `fetch` call, the `handleConnect` /
  `handleCancel` flow, the redirect-timeout fallback timer, analytics enqueue, the
  state-routing matrix, all headings, all body copy, and all button/link labels stay
  **verbatim**. Existing tests assert by role + visible text and must stay green
  untouched.
- **No broad amber/orange purge elsewhere.** The Console still uses amber/orange in
  other places (`EditReplyDrawer`, `ConnectGoogleBanner`, admin overview); that is the
  separately-tracked audit item **#14 (P1)**. This change touches only the connect page
  (plus one generic, reusable CSS addition — see below).

## Decisions (confirmed with the user)

1. **Reuse existing Console primitives** — no dedicated `.connect-*` CSS block.
2. **Fully cool palette** — zero amber/orange/yellow on this page.
3. **Green `.btn-primary`** for the Connect/Reconnect CTA (the existing Console primary
   button; green is the affirmative-action color across the Console).

## Design

### Page shell
Replace the bespoke wrapper `<div className="mx-auto max-w-2xl px-4 py-8">` with the
Console content container `<div className="content">` (identical to `DashboardContent.tsx`).
No TopBar. The state-specific heading stays as each view's own heading.

### The 8 view sub-components → Console primitives
Every view container `rounded-lg border-gray-200 bg-white p-6` → **`.card`**. Within each:

- **Heading** → `--rw-app-h1` token styling (h1 retained; text unchanged).
- **Body text** → Console muted/body tokens (`--rw-app-text-muted` / `#4B5563`).
- **Primary CTA** (`ConnectView`, `ReconnectView`) → `className="btn btn-primary"`
  (drops `bg-blue-600 …`). Disabled state via the existing `disabled` attr; Console
  `.btn` already handles it visually.
- **Secondary CTA** (`PendingView` Cancel, `InterruptedPendingView` Clear attempt) →
  `className="btn btn-secondary"`.
- **Spinner** → border `var(--rw-app-border)` with `var(--rw-teal)` top; drop the
  arbitrary `border-t-blue-600`.

### Remove all warm tones (the "fully cool" decision)

- **`ReadOnlyConnectView`** (amber → cool): neutral `.card`; heading + body in Console
  tokens; the "Update billing to connect…" line and queued-count / last-reason lines as
  Console muted text. The billing emphasis line stays text (copy unchanged) — no amber.
- **`ReconnectView` queued-count** (`text-orange-700` → cool): Console muted/body text.
- **`FinalizeUnknownView`** (yellow → cool): calm neutral `.card` ("support has been
  alerted … you don't need to do anything"); copy unchanged, no yellow.

### Error / loading / alert states (red is a Console utility token — allowed/cool)

- **Page data-load error** (`if (error)`, lines 88–97) → `.content` + a red Console
  alert (see `.banner-red` below) carrying `{error}`, plus the existing structure.
- **Inline `actionError` banner** (lines 214–218) → the same red `.banner-red` alert.
- **Loading** (`if (!data)`, lines 99–105) → centered Console muted text (token).
- **`!('zernioConnection' in data)` fallback** (lines 110–124) → `.card` + body +
  Console-blue "Back to dashboard" link.
- **Footer links** (Back to dashboard / Get help connecting / Open connection manually)
  → Console blue text links (`--rw-blue-600`; blue is the sanctioned Console link color).
  Markup/labels unchanged; only the color source moves to Console tokens.

### The one new CSS addition: `.banner-red`
The Console has `.banner-blue` and `.banner-orange` but **no red inline-alert variant**,
and errors must be red (not warm). Add a minimal `.banner-red` variant to
`_styles/console.css` mirroring the existing `.banner-blue` pattern (~6 lines), using
existing red tokens (`--rw-red-300` border, `--rw-red-50` bg, `--rw-red-700` title).
This is a **generic, reusable** primitive filling a real gap — not connect-specific —
consistent with the "reuse primitives, minimal CSS" decision.

```css
.banner-red { border-color: var(--rw-red-300); background: var(--rw-red-50); }
.banner-red .b-title { color: var(--rw-red-700); }
.banner-red .b-sub   { color: #B91C1Ccc; }
.banner-red .b-icon  { background: var(--rw-red-100); color: var(--rw-red-700); }
```

## Testing

- **Existing 8 tests** (`__tests__/page.test.tsx`): unchanged. They assert by role
  (`button` names) and visible text (billing copy, manual link) — all preserved. They
  must stay green with no edits.
- **New regression test** (mirrors PR #161's `island-overflow.test.ts` contract-test
  approach): render each connect-page state and assert **no element carries an
  `amber`/`orange`/`yellow` Tailwind class**, and that the primary/secondary CTAs carry
  the Console `.btn` class. This locks in the "fully cool, Console-classes" contract so a
  future edit can't silently reintroduce the warm prototype.

## Verification & process

- **Local (fast TDD feedback only):** targeted `pnpm vitest run` on the connect-page
  test files.
- **Authoritative gate:** CI (4 checks — lint, typecheck, test, build). Per CLAUDE.md,
  local lint/test from this *nested* worktree can be poisoned by the parent's
  `node_modules`/eslintrc, so CI is the source of truth. Push → read the runner.
- **No DB changes** → tenant-scope / RLS audits not required.
- Land via **PR** to `main` (protected). Spec + plan committed on the feature branch and
  included in the PR (matching prior P0 PRs).

## Risk / rollback
Presentational-only and CSS-additive (`.banner-red` is new, touches nothing existing).
Rollback = revert the PR. No data, schema, or API surface affected.
