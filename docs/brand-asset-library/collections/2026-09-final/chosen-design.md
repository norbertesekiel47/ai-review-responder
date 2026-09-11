# Chosen landing design — 2026-09-10

Status: owner-selected, implemented on the local `/` route; not yet merged or deployed by this work. This is the design decision record for the current landing narrative. The earlier four-way exploration remains in [README.md](README.md).

## Composition of record

| Section | Chosen treatment | Keep when refining |
| --- | --- | --- |
| Navigation and hero | Original landing bookend | Existing artwork, measured scrims, gold CTA and server-owned signup/trial flags. |
| Problem | M1 with M2's tilted square | Compact horizontal heading / original house film / explanation; warm paper contrast; 16px corners, −3° tilt. |
| Fleet | L2 courtyard, M2's sharp frame, M1's dark green | Wide 3:1 scene, four meaningful station links, heading left and click-to-play film right. Phones retain the full scene and use a two-column station index beneath it. |
| Acting agents | L1 | Alternating copy around a tall central CRT on desktop; original Reply, Guardian, Insights and Solicitor clips follow the paragraph in view. |
| Five jobs | L1 with final Higgsfield films | Respond, Protect, Request, Brief and Measure retain their canonical copy. Correspondence, inspection, invitations, briefing and measurement scenes illustrate their distinct jobs. |
| Judge / Governor | M1 | Paired original CRTs inside the arched scene; `overflow: hidden` belongs on the scene so media cannot protrude through its curved corners. |
| Owner controls | F3 | Light paper, left editorial heading, right L2 dispatch scene and mode controls. Copilot is left; Autopilot is right. |
| Where this is going | F1 Working Atlas | Three chapter controls, five illustrated stops per chapter, map and ordered detail ledger. Keep all 15 canonical stops and availability labels. |
| Closing CTA / footer | Original night bookend | Existing CTA, product/legal/contact navigation, and shared background-motion pause control. |

No variation selector, tweak panel or development controls render on `/`. The comparison routes were deleted after selection (same-day cleanup); this collection and its siblings keep their records. There is no new sitewide palette, navigation redesign, feature promise, backend workflow or dependency.

## Typography and responsive rules

- Preserve the selected serif editorial headings, existing body and mono label roles, and the landing's `--rw-lp-*` token scope. Gold marks acting agents; cooler accents distinguish supervision. Paper sections retain their selected dark text.
- Balance final narrative headings within their existing columns. Essential small captions and agent eyebrows are at least 11px; the fleet note is 12px. Mobile station descriptions are 10px and the secondary Live badge is 9px.
- On phones, place four 44×44px numbered agent controls **below** the CRT arch on a solid paper ground. The selected number uses the dark fill. Never put pale numbers over the upper curved edge.
- The phone CRT height is `min(190px, 28svh)`. Its anchor clearance is the screen height plus 90px. Selection measures the sticky stage's actual bottom plus 64px, capped at 80% of viewport height, instead of assuming a fixed 330px reading line. Resize updates the selection too.
- On wide screens shorter than 650px, the central CRT uses `100svh − 130px` height; decorative caption/plinth are hidden to leave room for the image and agent controls. The main alternating composition stays intact.
- The final desktop agent link aligns copy just above the reading line (`50svh − 16px`), leaving room for the full sticky frame at the last row. The 16px inset avoids fractional-pixel rounding selecting the previous agent. Earlier rows keep their 130px clearance. Phone links use the separate screen-height clearance above. Mode-button text aligns at the top so wrapped subtitles do not shift the two plan names out of line.
- Keep the whole 3:1 courtyard and owner mechanism visible. Avoid cropping away the lookout, outbox, approval tray or dispatch machine to fill a taller box.

## Map rendering contract

The chapter changes only the ground's framing: **Shipped = bright left; Planned = darker center; Horizon = right with the original cloud plates**. Foreground landmarks and detail layout remain stable.

The ground uses the original 3840×2144 JPEG, lazy-loaded without another Next image optimization pass. Its CSS scale is **1.75**, with 0%, 50% and 100% horizontal transform origins. At a 1440px viewport this paints at 1820 CSS pixels, or 3640 device pixels at 2× Retina; the previous 3× crop of a 1920px derivative was visibly soft. The approximately 1MB source is shared across tabs. The original `clouds-a.jpg` / `clouds-b.jpg` overlays appear only on Horizon, with screen blending and a vertical mask.

## Interaction and motion contract

- Navigation uses the existing real product, pricing, legal and contact routes. All primary conversion doors use the server-selected `/signup` or `/book-a-demo` target; closed signup never exposes a dead signup/login link. The landing's mode selector is an explanation, not a change to a customer's subscription.
- The fleet film opens in the accessible lightbox, with playback controls, Escape/close handling and focus restoration.
- Copilot points left at the approval tray; Autopilot points right at the bounded dispatch mechanism. The lever media is named by mode — `public/tiers/lever-{copilot,autopilot}.webp` and `lever-to-{copilot,autopilot}.mp4` — and mapped in `tiers/TiersSection.tsx`. (The generated files carried reversed names until the cleanup renamed them.)
- The lever's source is played at `duration / 0.7`. Going to Autopilot starts at 44% of the source to skip the stationary lead-in. Reverse clicks map to the corresponding frame of the inverse clip. Keep this timing; simply speeding both complete files leaves Autopilot feeling delayed.
- Only the selected side station animates after the lever settles. The center retains the correct still endpoint. There is no TV sliding across the scene.
- Ambient media loads near the viewport and follows the page's pause control. Reduced motion shows stills and makes map/lever state changes immediate. The footer pointer mask also loses its interpolation under reduced motion. User-initiated explainer playback keeps native controls.
- The hero's reduced-motion final pose is enforced by CSS from the first paint, including before hydration. Changing Motion's transition prop after hydration alone did not cancel an entrance already in progress; see the frontend lab note dated 2026-09-10.
- House, agent, watchdog, job and owner clips retain authored stills when media fails. A failed agent source cannot suppress a different agent's clip.

## Verification and boundaries

The browser checks and evidence below live alongside this record. They ran against the pre-cleanup tree: the `/design-*` routes and the `#final-middle`, `#final-owner` and `#final-roadmap` ids they use no longer exist, and section media moved to `public/fleet/`, `public/jobs/` and `public/tiers/`. Section class names are unchanged.

- `verify.mjs` with `FINAL_SELECTION=true`: desktop/phone film, agents in both directions, fleet links, five job films, both lever directions, rapid reversal, pause/reduced motion, all 15 stops and conversion destination.
- `verify-extra.mjs` with `FINAL_SELECTION=true`: nine viewport widths, menu/focus/touch targets, curved image containment, media failures and comparison isolation.
- `verify-polish.mjs`: phone/tablet/landscape keyboard navigation, all public link destinations, original video failures and a fully intercepted early-access form validation/error/retry/success journey. No real lead or email is sent.
- `capture.mjs` with `FINAL_SELECTION=true`: the seven selected narrative sections at 1440px and 390px. `screenshots/polished-*` includes short-screen and form-state evidence.
- `map-resolution-results.json`: all three map crops and 15 stops at standard and Retina densities; original decoded width and framing measurements.

Verification uses local production Chromium. Native Computer Use and a local WebKit binary are unavailable; native Safari/device verification is not claimed. Form submission is simulated at the network boundary, so this pass verifies the visitor UI, not delivery to a live backend. Generated films may retain slight generative texture; no new media was generated in this refinement.

## Documentation sweep

| File / area | Changed? | Reason |
| --- | --- | --- |
| This decision record and collection README | Yes | Selected composition, measurements, behavior and verification entry points. |
| Landing DESIGN.md / measurements.md | Yes | Route current readers to this selected narrative; preserve measured bookend rules. |
| docs/currents.md / docs/progresstracking.md | Yes | Local implementation state and dated build history. |
| Env vars / migrations / review-ingestion inventories | No | No flags, schema or ingestion changes. |
| Frontend lab notes | Yes | Record the reproduced reduced-motion hydration issue and first-paint verification. |
| Path rules / CLAUDE.md | No | Existing frontend routing already points at the owning lab note. |
| Directory / domain maps | No in this refinement | No production worker/library file or domain term added. The selected route's existing directory entry remains accurate. |
| Architecture review log | No | Work is not merged; do not increment the merge counter. |
