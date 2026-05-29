# select-location page chrome — add TopBar

- **Date:** 2026-05-29
- **Audit item:** `docs/launch-ready-part2.md` → Prioritized fix list → P1 #16
  ("Wrap VoiceClient in `SettingsShell`; add TopBar to select-location").
- **Scope:** One JSX change to the `select-location` server page + a page test.
  Worktree/PR #2 of the two requested fixes.

## Problem & current state

The audit item has two halves; **only the second is still open**:

1. **VoiceClient in `SettingsShell` — already done.** `VoiceClient.tsx` already
   renders `<SettingsShell activeTab="voice" …>` in all three states (error,
   loading, ready), and `settings/voice/page.tsx` already renders a `<TopBar>`
   above it. The audit referenced an older state (`settings/voice/page.tsx:38`).
   No change needed.

2. **select-location renders bare `<LocationPicker/>` — open.**
   `src/app/(authenticated)/dashboard/connect/select-location/page.tsx:67`
   returns the connect-flow `<LocationPicker>` with no TopBar / no app chrome,
   so the page floats without the Console header the rest of the authenticated
   app has.

> Note: there are two distinct `LocationPicker` components — the connect-flow
> one at `…/select-location/LocationPicker.tsx` (rendered by this page) and a
> separate `components/dashboard/LocationPicker.tsx` used *inside* `TopBar` for
> the mobile location switcher. They do not collide (different import paths).

## Decision (from brainstorming)

- **TopBar chrome only.** Add `<TopBar>` matching the `voice/page.tsx` pattern.
  Leave the connect-flow `LocationPicker` body as-is — its full Console restyle
  belongs to P0 #10 (dashboard/connect restyle), which is out of scope here.

## Change

`src/app/(authenticated)/dashboard/connect/select-location/page.tsx` — wrap the
success return (the only change; all redirect/guard logic above it is untouched):

```tsx
import { TopBar } from '@/components/dashboard/TopBar';
// …
return (
  <>
    <TopBar
      title="Connect Google Business"
      subtitle="Select location"
      rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
    />
    <LocationPicker locations={blob.locations} />
  </>
);
```

### Why this is safe

- **Context is present.** The page lives under `(authenticated)/layout.tsx`,
  which wraps children in `AuthenticatedProviders` (provides `LocationContext`).
  `TopBar` calls `useLocationScope()`; it resolves here. ✅
- **No heading conflict.** `TopBar` renders its title as a `<div className="page-title">`
  (not a semantic heading), so the LocationPicker's existing `<h1>`
  ("Pick a Google Business location") remains the page's sole `h1`. ✅
- **Server→client boundary.** `TopBar` is a client component imported into a
  server page — the standard island pattern already used by `voice/page.tsx`.

### Accepted minor quirk

For a multi-location account, `TopBar` renders the mobile dashboard
location-switcher (`isMultiLocation` branch). Mid-connect this is slightly odd
(you are binding a *new* Google location, not switching dashboard scope), but it
is harmless and identical to the established voice-page behavior. We do not
suppress it — consistency with the rest of the app wins.

## Testing & verification

- Add `src/app/(authenticated)/dashboard/connect/select-location/__tests__/page.test.tsx`
  following the mocking style of `dashboard/connect/__tests__/page.test.tsx`:
  - Mock `next/headers` (`cookies()` → a stub with the signed connect cookie),
    `@/lib/db/redis-cache` (`getCacheRedis().get` → a 1-location blob JSON),
    `@/lib/zernio/connect-session-cookie` (`verifySignedConnectSessionValue` →
    a session id), and `@/contexts/LocationContext` (`useLocationScope` →
    single-location stub) as needed for `TopBar`.
  - Render `await SelectLocationPage()` and assert both the TopBar chrome
    ("Back to dashboard") **and** the picker ("Pick a Google Business location")
    are present.
  - If exercising the full server data path proves too mock-heavy, fall back to
    asserting the composition with the redis/cookie reads stubbed to the happy
    path only — the goal is to pin "TopBar renders above the picker", not to
    re-test the redirect guards (already covered by the API route tests).
- Full gate: `pnpm lint && pnpm typecheck && pnpm test`.

## Out of scope

- P0 #10 connect-page Console restyle and the `LocationPicker` body rebrand
  (raw Tailwind gray/blue stays for now).
- P1 #19 per-page metadata.
- The VoiceClient/SettingsShell half (already shipped).

## Risk

Very low. Additive chrome composed from an existing, already-branded component,
following an in-repo pattern; no data path or guard logic changes.
