# Final directions — builder notes

The four `/design-final/F1`–`F4` pages share the owner's selected foundation. The comparison index is `/design-final`. All routes are noindex; page CTA destinations and trial labels resolve from the existing server flags. The current landing page and previous comparison routes keep their existing behavior.

**Selection update, 2026-09-10:** the local `/` now composes F3's middle with F1's roadmap. Copilot is left and Autopilot right; the two existing lever clips are remapped to those physical positions and play in 700ms. Side-station activity is masked away from the central lever so it cannot restore the old position. The Judge/Governor scene clips media at its curved boundary, fixing the phone arch protrusion. Latest evidence and commands are in `README.md`; the paragraphs below record the original four-way exploration.

## Selected sections

- M1's `ProblemBand` and `Supervision` are exported and reused. A narrow final-only rule gives the house M2's 16px corner radius and −3° rotation; M1's background, layout, copy and original film remain.
- L2's exact courtyard fleet is reused with straight, sharp image corners and M1's landing ink background. Station positions, links and film control remain functional.
- L1's `Agents` is exported without a markup or behavior change. L1's `Jobs` adds an optional `renderJobVisual(jobId)` hook; old callers keep the old visual, final pages inject `JobMotion` above the original explanation.
- `OwnerControl` and `JobMotion` are integrated through their named component contracts. Those implementations and their generated media are owned by the coordinating builder.

## New roadmap structures

| Direction | Structure | Phone behavior |
| --- | --- | --- |
| F1 · The Working Atlas | Five landmarks and a route per chapter, with a separate ordered ledger and selected detail | Compact numbered map, selected detail, then five full text controls |
| F2 · The Field Guide | Vertical chapter rail, large selected landmark on a map plate, paper detail and index | Chapter row, illustration, then the paper detail/index |
| F3 · The Survey Table | Three visible illustrated route bands; the selected band's detail expands beneath it | Three chapter controls, one illustrated five-stop band open at a time |
| F4 · The Next Chapter | Panoramic object stage with feature copy and previous/next controls, followed by a five-stop illustrated strip | Object and feature stack, with an illustrated stop index |

All 15 stops, their names and bodies come directly from `future/future-copy.ts`. Planned Phases 1–5 retain order. Shipped, Planned and Horizon labels appear in controls and detail; unbuilt details also say “Not available yet.” All ten existing cutouts are used individually. Horizon stops use a graphic beacon and are never assigned a fabricated landmark. Every stage uses `/future/roadmap-ground.jpg` as its actual background.

Controls are native buttons with focus rings, `aria-pressed` and detail relationships. Detail announcements are polite; no roadmap changes automatically. CSS transitions are disabled for reduced motion. The surrounding landing provider owns ambient pause for reused and new video components.

## Builder checks and review handoff

The builder inspected all four rendered roadmaps at 1440px and 390px from the coordinator's screenshot capture. This exposed a specificity issue in F2's shipped status on paper; its status now uses dark ink. Header, chapter, ledger and footer spacing were tightened without reducing label sizes. F4 uses a two-column stop index on phones, with its final stop spanning the row.

Scoped ESLint and `pnpm typecheck` passed. A local Playwright check at `http://localhost:3100/design-final/F1` through `F4` selected every canonical stop at 1440px and 390px, asserted the exact canonical body text, and found no roadmap horizontal overflow: 120 stop selections passed. Initial roadmap heights after refinement:

| Direction | 1440px | 390px |
| --- | ---: | ---: |
| F1 | 896px | 1299px |
| F2 | 844px | 1293px |
| F3 | 888px | 1292px |
| F4 | 859px | 1277px |

The independent brief, system and craft critics passed the final compositions. The comparison now uses each actual rendered roadmap capture. Final production verification and its native Computer Use limitation are recorded in `README.md`.

## Integration findings

- Variant-qualified desktop owner grids require equally specific mobile selectors; a generic mobile selector could not override F2's grid and caused phone overflow.
- For the 3:1 L2 scene, matched letterboxed start/end frames keep Higgsfield's video camera and side machines stable. The initial unconstrained generation reframed the scene. The final forward and reverse clips share one source frame clock, allowing smooth reversal during repeated mode changes.
- The lever alone did not communicate the workflow distinction. Separate activity films now hold a draft at the approval tray for Copilot and process one envelope at the dispatch machine for Autopilot, with the lever fixed in the selected position.
