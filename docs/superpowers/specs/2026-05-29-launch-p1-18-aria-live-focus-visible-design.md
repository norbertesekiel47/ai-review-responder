# Launch P1 #18 — `aria-live` regions + `focus-visible` styles (+ dot-nav `type="button"`)

> **Date:** 2026-05-29
> **Audit item:** `docs/launch-ready-part2.md` Prioritized fix list #18 (P1).
> **Branch / worktree:** `fix/launch-p1-18-aria-live-focus-visible` in the sibling worktree `RepWorth-worktrees/launch-p1-18-aria-live-focus-visible` (off `origin/main` c04c7083).

## Goal

Close the remaining accessibility gaps in audit item #18 so that (a) keyboard
users get a visible focus indicator on the marketing interactive controls, and
(b) screen-reader users hear the app's async feedback on its highest-value
Console surfaces.

## Current state (verified)

Item #18 has three sub-parts. One is already done:

| Sub-part | State |
|---|---|
| `type="button"` on dot-navs | ✅ **Done.** `PageShell` dot-nav (`src/components/ui/PageShell.tsx:67`) and marketing `LandingContent` dot-nav (`src/components/sections/landing/LandingContent.tsx:66`) both already render `type="button"`. No change needed; a regression test will lock it. |
| `focus-visible` styles | ❌ Pending. Controls have correct semantics but no visible focus ring (`.rw-dot-nav button`, `.pr-toggle button`, `.pr-faq-q`, `PageShell` dot-nav, `SiteNav` links). |
| `aria-live` regions | ❌ Pending for the Console. MFA/approval/funnel already announce (PRs #160/#162/#165); the named-but-silent surfaces are settings save confirmations, connect/reconnect status, and dashboard load/error. |

## Scope & guardrails

- **Strictly additive.** Only ARIA attributes, an `sr-only` live region, and
  `:focus-visible` styling are added. **No surface is visually rebranded.**
- **Respect the P0 #10 boundary.** `dashboard/connect/page.tsx` and
  `ConnectGoogleBanner` use raw Tailwind reds/grays; rebranding them is the
  separate audit item **P0 #10**. This work adds the live-region announcement
  *alongside* the existing nodes and does **not** touch their colors/markup.
- **One authoritative focus treatment.** Reuse the existing pattern
  `outline: 2px solid var(--rw-teal); outline-offset: 2px` (already applied to
  `.pr-matrix` at `globals.css:2234`). No new visual language.
- **One authoritative live-region mechanism.** A single `<LiveRegion>`
  component owns all the `role`/`aria-live`/`sr-only` mechanics; surfaces pass a
  message string only.

## Workstream A — `focus-visible` (marketing controls)

Add a visible teal focus ring to the controls the audit named. The ring matches
the brand token `#97B3AE` (`--rw-teal`) and the existing `.pr-matrix` treatment.

**CSS (`src/app/globals.css`)** — three new rules using the existing pattern:

- `.rw-dot-nav button:focus-visible` → `outline: 2px solid var(--rw-teal); outline-offset: 2px;`
- `.pr-toggle button:focus-visible` → same (pricing billing-cadence toggle)
- `.pr-faq-q:focus-visible` → same (FAQ accordion question button)

**Tailwind (JSX) controls** — the same teal outline via utilities, because these
are not styled in `globals.css`:

- `src/components/ui/PageShell.tsx` dot-nav `<button>`:
  add `focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2`.
- `src/components/ui/SiteNav.tsx` nav `<Link>`s and the Log in / Sign up
  `<Link>`s: add `rounded` + `focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2`.

Rationale for two dot-navs: the marketing pages use the CSS-class dot-nav
(`.rw-dot-nav`), while the branded utility/approval/demo pages use the
Tailwind-styled `PageShell` dot-nav. Both need a focus ring.

## Workstream B — `<LiveRegion>` primitive + named surfaces

### Primitive

New file `src/components/ui/LiveRegion.tsx` — a deep, pure presentational sink
that hides all ARIA mechanics behind a `message` prop:

```tsx
interface LiveRegionProps {
  /** Current announcement. Empty string = nothing to announce. */
  message: string;
  /** 'polite' (default) → role=status; 'assertive' → role=alert. */
  level?: 'polite' | 'assertive';
}

export function LiveRegion({ message, level = 'polite' }: LiveRegionProps) {
  return (
    <div
      role={level === 'assertive' ? 'alert' : 'status'}
      aria-live={level}
      className="sr-only"
    >
      {message}
    </div>
  );
}
```

Contract:

- The element is **always mounted** by its caller. Screen readers only announce
  changes to a live region that already exists in the DOM, so the region must
  pre-exist the message; callers render it unconditionally and update `message`.
- `polite` (`role=status`, `aria-live=polite`) for success/loading/status.
- `assertive` (`role=alert`, `aria-live=assertive`) for errors.
- No internal state, effects, or context — props in, `sr-only` DOM out.

Home: `src/components/ui/` (alongside `PageShell`, `SiteNav`). Shared between
authenticated and public trees.

### Named surfaces (the three the audit named)

Each surface already owns its async state; `LiveRegion` is added as an
always-mounted sink driven by that existing state.

1. **Settings save confirmations**
   - `src/components/dashboard/settings/SettingsShell.tsx`: render a
     `<LiveRegion>` driven by the `savedFlash` prop →
     `message = savedFlash ? 'Settings saved' : ''`, `level="polite"`. The
     existing visual `saved-toast` (`:74`) is unchanged.
   - `src/app/(authenticated)/settings/SettingsClient.tsx`: render a
     `<LiveRegion level="assertive">` driven by `f.saveError` (`:99`). The
     existing red `<p>` is unchanged.

2. **Connect / reconnect status** (additive only — P0 #10 owns the rebrand)
   - `src/app/(authenticated)/dashboard/connect/page.tsx`: render a
     `<LiveRegion level="assertive">` driven by `actionError` (`:45`), and a
     `<LiveRegion level="polite">` for the page error (`:88`) and loading
     (`:102`) states. Existing nodes keep their current markup/colors.
   - `ConnectGoogleBanner` already exposes `role="alert"`; no change.

3. **Dashboard load / error**
   - `src/components/DashboardContent.tsx`: render `<LiveRegion level="assertive">`
     for the `error` branch (`:63`) and `<LiveRegion level="polite">` for the
     `loading` branch (`:84`) — e.g. `'Loading your dashboard…'`. Existing
     error/loading UI is unchanged.

### Data flow

```
existing async state (savedFlash | saveError | actionError | error | loading)
        │  (string / boolean already in component)
        ▼
   <LiveRegion message=… level=… />  ──renders──▶  sr-only role=status|alert node
        │
        ▼
   screen reader announces on message change
```

No new fetches, timers, or state. The live region is a read-only projection of
state the component already holds.

## Error handling / failure modes

- `LiveRegion` is a pure render with no failure modes.
- Surfaces map their existing strings: error strings → `assertive`;
  success/loading/status → `polite`.
- Empty `message` renders an empty (but present) region — correct idle state.

## Testing

- **`src/components/ui/__tests__/LiveRegion.test.tsx`** (new):
  - default → `role="status"`, `aria-live="polite"`, `sr-only` class present;
  - `level="assertive"` → `role="alert"`, `aria-live="assertive"`;
  - renders the `message` text; empty message → empty but present node.
- **Surface tests** (extend existing where present, add where not):
  - `SettingsShell` announces `Settings saved` in the live region when
    `savedFlash` is true; `SettingsClient` announces `saveError` assertively.
  - `dashboard/connect/page.tsx` announces `actionError` assertively (extend
    `dashboard/connect/__tests__/page.test.tsx`).
  - `DashboardContent` announces the error message assertively and a loading
    message politely.
- **Focus-ring CSS contract test** (mirrors `src/__tests__/island-overflow.test.ts`):
  assert `globals.css` declares `:focus-visible` outline for `.rw-dot-nav button`,
  `.pr-toggle button`, and `.pr-faq-q`.
- **Dot-nav `type` regression**: assert `PageShell` and marketing dot-nav
  buttons render `type="button"` (lock the already-done sub-part).

## Out of scope (explicit)

- Rebranding `dashboard/connect` / `ConnectGoogleBanner` (that is **P0 #10**).
- `aria-live` on surfaces beyond the three named (the broad Console sweep was
  declined in favor of "primitive + named surfaces").
- ARIA tab semantics on settings/mobile tabs (**P2 #27**).
- Tap-target sizing (**P2**).
- Per-page metadata / `noindex` (separate item **#19**).

## Delivery

- Implemented in the sibling worktree (outside the repo) so local
  `pnpm lint && pnpm typecheck && pnpm test` run cleanly (the project CLAUDE.md
  warns that worktrees nested inside the repo poison local lint/test via parent
  `node_modules` resolution).
- Validation gate before "done": `pnpm lint`, `pnpm typecheck`,
  `pnpm test` (full suite) all green.
- Land via PR into `main` (protected; direct push rejected). Update
  `docs/launch-ready-part2.md` item #18 (and the Accessibility section) to
  reflect completion in the same PR, matching the existing tick-mark convention.
```
