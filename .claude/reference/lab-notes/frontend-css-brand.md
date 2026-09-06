# Lab notes — Frontend / CSS / brand

## Summary

- **Frontend / CSS / brand** — iOS Safari rounded-island clip is `overflow:hidden`+`border-radius`+retained `transform` (not a sibling clip), reproduce an audit's CSS cause before trusting it; flag-driven copy swaps on dead-end features mislead; an admin "act on stuck items" panel needs a real outbox-backed route (2026-05-29 launch readiness); **`react-hooks/set-state-in-effect` is `error` repo-wide** — "clear state when the thing it points at disappears" is React's adjust-state-on-prop-change written in the RENDER body behind a prev-value guard (precedent `ToneChipPicker.tsx`), never a `useEffect`; check it writes only on the transition and converges on the next render (#872, 2026-08-18); **a utility class is only real on routes whose stylesheet actually loads it** — `.btn-danger` lives only in `_styles/settings.css`, which the Requests route never imports, so a plan's danger-styled button would have rendered as a bare `.btn`; grep the definition, then check which layout imports that file (#872, 2026-08-18); **a client component importing a VALUE from a module with a module-scope `createWorkerLogger` breaks the Turbopack route build** with no lint/typecheck/boundary-audit failure — invariant #1's ESLint rule lists PACKAGES, not `node:` builtins reached transitively; pass the value as a prop from the server parent, or move the helper to a side-effect-free module (#898, 2026-08-21)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-04.md § "PlaceAutocompleteElement shadow DOM styling"
- history/2026-04.md § "Google Maps Essentials vs Pro tier fields"
- history/2026-04.md § "`@googlemaps/js-api-loader` v2 SSR guard"
- history/2026-05.md § "`EditReplyDrawer` close-during-async-op = hidden draft class of bug"
- history/2026-05.md § "iOS Safari clips the rounded island — `overflow:hidden` + `border-radius` + retained `transform`, NOT the sibling clip the audit assumed"
- history/2026-05.md § "An admin "act on stuck items" panel needs a real backend route + outbox transitions, not a frontend-only button"
- history/2026-05.md § "A flag-driven "reason swap" on a feature with no owner-facing path either way is misleading — show one honest, flag-independent message"
- history/2026-07.md § "[2026-07-26] Claude-in-Chrome `read_network_requests` reports a **204 No Content** as **503** — trust the server log, never the extension's status code"
- history/2026-07.md § "[2026-07-26] `useReviewedPing` is gated on `document.visibilityState === 'visible'`, so a minimized/background automation window never writes `reviewed_at` — this is the feature, not a bug"
- history/2026-08-13-to-21.md § "[2026-08-18] `react-hooks/set-state-in-effect` is `error` repo-wide — "clear state when the thing it points at disappears" is a render-time adjust"
- history/2026-08-13-to-21.md § "[2026-08-18] A utility class is only real on routes whose stylesheet actually loads it"
- history/2026-08-21-to-31.md § "[2026-08-21] A client component that imports a VALUE from a module with a module-scope worker logger breaks the Turbopack route build"
