# RepWorth final design variations

## Selected final page

The current composition and refinement rules are saved in [chosen-design.md](chosen-design.md). The final polish keeps F3 + the F1 atlas, moves the phone's four agent controls below the CRT arch, makes the sticky screen fit short viewports, measures the reading line from the actual screen edge, balances headings and improves small captions. Original house/agent/watchdog clips now keep still fallbacks on failure. The hero's reduced-motion copy is visible from the first paint, and footer pointer interpolation respects reduced motion. `polish-results.json` and `screenshots/polished-*` record the additional navigation, keyboard, original-media failure and simulated conversion checks. These are local implementation changes, not a deployment.

Final polish validation (2026-09-10): **338 tests across 12 files, full lint, typecheck, production build and diff whitespace checks passed.** The selected desktop/phone interaction suite and nine-width responsive suite passed. Additional final Chromium checks passed at 320×568, 390×844, 760×540, 768×1024, 844×390 and 1440×1000: all four keyboard agent links retain the correct TV, the frame fits the viewport, and phone targets are 44px. All 11 public destinations were followed successfully. Reduced-motion hero styles passed both without JavaScript and after hydration. The lead form passed empty validation, simulated server error, retry, simulated success and onward navigation; no lead was sent. Cached React Doctor 0.9.12 reported 100/100 on its six tracked changed files; untracked exploration sources are outside that tool's diff scan. Native Computer Use and WebKit remain unavailable. Visual evidence includes `screenshots/polished-390-reduced-motion-first-paint.png`, `polished-1440x1000-agents.png`, `polished-844x390-agents.png` and the desktop/phone `selected-*` captures.

The owner selected **F3 with F1's roadmap** on 2026-09-10. It is implemented on the local landing route: [open the final page](http://localhost:3101/). F1–F4 remain accessible for comparison.

- `src/app/(public)/page.tsx` composes `FinalMiddle` F3 and `FinalRoadmap` F1 with the existing hero, closing CTA and footer.
- Background-only roadmap refinement: Shipped frames the bright left of the original map; Planned frames its darker center; Horizon frames its right side with the original `clouds-a.jpg` / `clouds-b.jpg` plates. The foreground route, landmark positions, chapter controls and detail ledger are unchanged. Normal-motion tab changes and all 15 stops at desktop/phone sizes passed; reduced motion changes the crop immediately. Initial framing evidence: `map-background-results.json` and `screenshots/map-background-{shipped,planned,horizon}-{1440,390}.png`.
- Resolution refinement: the original 3× crop enlarged a 1920px optimized image to 3120 CSS pixels at a 1440px viewport (6240 device pixels at 2× Retina). The atlas now serves the original 3840×2144 JPEG, without another optimization pass, and uses a wider 1.75× crop. At that viewport the ground paints at 1820 CSS pixels / 3640 Retina pixels. The approximately 1MB source remains lazy-loaded and is reused between tabs; other comparison layouts retain responsive image optimization. All three states and 15 stops passed at 1440px/1×, 1440px/2×, 390px/3× and 1920px/2×, with no page errors or overflow. Build, scoped ESLint and 45 landing tests passed. Evidence: `map-resolution-results.json` and `screenshots/map-sharp-{shipped,planned,horizon}-{1440-2x,390-3x}.png`.
- Judge/Governor media now clips to the scene's curved boundary. The reproduced phone defect was the rectangular video background protruding beyond the arch, even though its rectangular bounds fit the card.
- Copilot is **left** and Autopilot is **right**. The existing opposite-direction lever clips and endpoints are remapped without regenerating the artwork. Side-station films are feathered into the corresponding side of the still, preserving the corrected central lever position.
- The return to Copilot takes **0.7 seconds**, down from approximately 2.5 seconds. A follow-up frame inspection found that the reversed Autopilot film held its starting pose for about 2.2 seconds of its 5.04-second source. Autopilot now skips that lead-in (44% of the source) while retaining the same playback rate. A local Chromium measurement showed its first moving frame at 74ms and completion at 465ms; Copilot remained 728ms. Mid-transition reversals reuse the inverse clip's matching frame, clamping only Autopilot's stationary lead-in. Reduced-motion and media-failure behavior keep the correct selected endpoint.

The final local production page passed complete 1440px and 390px journeys, including both activity films, the return-to-Copilot speed assertion, rapid reversals and all 15 roadmap stops. Responsive checks passed at 320, 375, 390, 428, 760, 900, 1100, 1440 and 1920px, plus mobile menu, keyboard focus and media-failure checks. Final source gates: lint, typecheck, build and 117 tests across 10 files passed. Cached React Doctor 0.9.12's changed-file scan returned 100/100 with no issues; installing 0.9.13 was blocked by pnpm's dependency trust check, which was not overridden. Native Computer Use and a local WebKit binary were unavailable; browser verification used Playwright Chromium.

Reports: `selected-interaction-results.json`, `selected-extra-results.json`, `selected-capture-results.json`. Visual evidence: `screenshots/selected-390-watch.webp`, `screenshots/selected-1440-owner.webp`, both mode-state captures and the selected roadmap captures. Reproduce the selected-page checks by prefixing the commands below with `FINAL_SELECTION=true`.

## Four-way exploration record

Completed 2026-09-10. Local production comparison: [all four variations](http://localhost:3101/design-final).

| Variation | Preview | Distinction |
| --- | --- | --- |
| F1 · The Working Atlas | [Open F1](http://localhost:3101/design-final/F1) | Map with five illustrated stations per chapter and an ordered detail ledger. |
| F2 · The Field Guide | [Open F2](http://localhost:3101/design-final/F2) | Chapter rail, oversized landmark, and a warm paper detail/index. |
| F3 · The Survey Table | [Open F3](http://localhost:3101/design-final/F3) | Three illustrated roadmap bands; the selected band expands into its detail. |
| F4 · The Next Chapter | [Open F4](http://localhost:3101/design-final/F4) | Panoramic landmark feature, previous/next navigation, and an illustrated stop index. |

The selected foundation is shared: M1 problem with the M2 tilted square; L2 courtyard with sharp corners on M1 dark green; unchanged L1 agent gallery; L1 jobs with new films; unchanged M1 Judge/Governor; and the light L2 dispatch scene. Each variation has its own owner-section composition and a completely rebuilt roadmap. The map uses the original contour background and all ten original landmark cutouts. All 15 canonical stops retain their exact detail copy and Shipped, Planned or Horizon status.

## Motion assets

All new generated motion was made through Higgsfield. Five unique films illustrate Respond, Protect, Request, Brief and Measure. Their themes are correspondence, inspection, invitations, briefing and measurement, using the landing page's sage, brass, stone and paper materials.

The owner scene uses the existing L2 image, exported only after the user's explicit approval. The initial exploration used Autopilot left / Copilot right; the final selection above supersedes that direction. Clicking a mode moves the actual brass lever, then starts the corresponding activity: a held approval draft for Copilot, or an envelope processed by the dispatch machine for Autopilot. The previous moving TV is removed. Rapid reversals preserve the lever's position. Films have still fallbacks, obey reduced motion and the site's ambient-animation pause control, and play only when visible.

Production media lives in `public/landing-final/motion/`. Generation prompts, job IDs, durable result URLs and processing notes are in:

- `generation-record.json`: five job illustrations/films and initial dispatch generation.
- `lever-refinement-record.json`: final fixed-camera lever transition.
- `owner-activity-record.json`: final approval-tray and dispatch-machine activity films.
- `media/job-filmstrip.jpg`, `media/lever-filmstrip-r2.jpg`, `media/activity-copilot-filmstrip.jpg` and `media/activity-autopilot-filmstrip.jpg`: visual inspection evidence.

## Design Loop

For the four-way exploration, independent brief, design-system and visual-craft critics passed the shared composition, five job films, all four roadmaps and owner activity films. The owner scene required a second review round: the first correct lever transition still needed meaningful activity in each station. The completed review ledger is `src/components/sections/landing/final-iteration/design-loop/progress.md`. The subsequent owner-selected composition and fixes are verified separately above.

## Verification

Browser target: local production build at `http://localhost:3101`, with the early-access CTA resolving to `/book-a-demo`. No account or customer data was used.

| Journey | Expected and observed result |
| --- | --- |
| Four versions at 1440px and 390px | All eight complete journeys passed; no page errors, missing images or horizontal overflow. |
| Fleet film | Opens, plays and closes; keyboard focus returns to the trigger. |
| Agent gallery | Scrolling down and back up selects the correct original agent video. |
| Five jobs | Each unique video becomes ready and plays when visible. |
| Owner controls | Left Autopilot/right Copilot, real lever movement, rapid reversal and selected activity playback pass. |
| Reduced motion and pause | Still endpoints remain legible; ambient animation stops. |
| Roadmap | All 15 stops are selectable in every version on both layouts; canonical copy and availability remain accurate. F4 previous/next wraps correctly. |
| Conversion | The early-access CTA navigates to `/book-a-demo`. |
| Additional widths | All four versions fit 320, 900, 1100 and 1920px without horizontal overflow. |
| Accessibility and fallback | Visible keyboard focus, adequate mode touch targets, video failure stills, invalid-ID 404 and noindex previews pass. |

The native Computer Use tool was unavailable in this session. Verification used real Playwright Chromium and independent Chrome DevTools review; native Computer Use verification is not claimed.

Automated gates passed: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `git diff --check`, and 117 tests across 10 files from the narrow landing/scope/focus suite:

```sh
pnpm test src/components/sections/landing/__tests__ src/__tests__/design-scope-purity.test.ts src/__tests__/focus-visible-marketing.test.ts
```

Reproduce the browser checks with the production preview running:

```sh
FINAL_ORIGIN=http://localhost:3101 node docs/brand-asset-library/collections/2026-09-final/verify.mjs
FINAL_ORIGIN=http://localhost:3101 node docs/brand-asset-library/collections/2026-09-final/verify-extra.mjs
FINAL_ORIGIN=http://localhost:3101 node docs/brand-asset-library/collections/2026-09-final/capture.mjs
```

Machine-readable reports: `interaction-results.json`, `extra-results.json` and `capture-results.json`. Sanitized screenshots are in `screenshots/`; names identify the variation, viewport and section. The comparison's thumbnails in `public/landing-final/previews/` are actual rendered roadmap captures. These local preview routes are ready for selection; the existing landing route and earlier design comparisons remain available.
