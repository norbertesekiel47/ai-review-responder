# RepWorth marketing collection · September 2026

Open [the visual gallery](gallery.html) to browse and download the assets. This collection contains **131 reusable exports**: **63 PNGs, 31 SVGs, and 37 silent MP4s**. Light and dark variants are kept in separate folders. These are production drafts for your review, not published campaigns.

## Pick an asset

| Folder | Contents | Use |
|---|---|---|
| [Social](social/) | 5 layouts × 2 looks × 3 sizes = 30 PNGs | Square 1080×1080, feed 1080×1350, story 1080×1920 |
| [Agent cards](agents/) | All 6 existing agents × 2 looks = 12 PNGs | Agent introductions, carousels, explainer chapters |
| [Agent worlds](agent-worlds/) | Reply's miniature path and Judge's lookout | Cinematic title cards and story artwork |
| [Panoramas](panoramas/) | Day and night miniature valleys | People-free establishing scenes and backgrounds |
| [Backgrounds](backgrounds/) | 3 light and 3 dark text-free plates | Add your own copy, product screens, or cutouts |
| [Objects](objects/) | 12 transparent SVG objects × 2 palettes | Scalable icons, arrows, paths, signals, paper, supervision graphics |
| [Motion](motion/) | 32 six-second clips: 16 per look | Agent intros, logo intro/outro, typography, workflows, route drawing, and abstract loops |
| [Cinematic](cinematic/) | 3 approximately five-second 720p clips | Reply, a valley glide, and a subtly moving parchment plate |
| [Maps](maps/) | 2 blank plates, 7 transparent PNG cutouts, 7 SVG overlays, 2 composed stills, 2 twelve-second animations | Build your own parchment-map sequences |

The map cutouts are a cottage, watchtower, mailbox, newsstand, lighthouse, airship, and cloud. The plates, landmarks, route, and labels remain separate. The assembled examples show how they fit together. They take aesthetic direction from your supplied tabletop video; they are newly composed assets, not an edit of that original.

## Make content quickly

- **Social post:** pick a light or dark layout, choose square/feed/story, change the text in [content.json](source/content.json), and render again.
- **Agent spotlight:** use a six-second agent introduction, the matching portrait card, and the logo outro. The twelve agent clips frame the exact existing portraits with native motion; they do not invent new character designs.
- **Explainer:** combine the owner-approved workflow, escalation, and report modules. Add the cinematic valley or Reply scene as a chapter break.
- **Map story:** use the blank parchment plate, place individual cutouts, then add the editable route and labels. The source for the assembled twelve-second examples is [map-index.tsx](source/map-index.tsx).
- **Motion background:** the orbit, paper-flow, and signal clips are designed to repeat. Other videos are short shots with holds or transitions; they are not advertised as seamless loops.

All videos are silent. No narration, music, ElevenLabs assets, real-life people, or fabricated testimonials were added. The workflow graphics are explicitly illustrative, and the map's future-concept label remains a concept. No new product screen recordings were made: those require a running verified demo environment. The agent cards use the existing 512-pixel portraits, so their source detail remains limited to those originals.

## Edit and render

Run from the repository root. Production dependencies are isolated from the application. Install Node/pnpm and FFmpeg, and use the repository's installed Playwright Chromium (or set `REPWORTH_RENDER_BROWSER` to a compatible Chromium executable).

```bash
mkdir -p output/repworth-marketing-2026-09-08/runtime
cp docs/brand-asset-library/collections/2026-09-marketing/source/package.json output/repworth-marketing-2026-09-08/runtime/package.json
cp docs/brand-asset-library/collections/2026-09-marketing/source/pnpm-lock.yaml output/repworth-marketing-2026-09-08/runtime/pnpm-lock.yaml
cp docs/brand-asset-library/collections/2026-09-marketing/source/pnpm-workspace.yaml output/repworth-marketing-2026-09-08/runtime/pnpm-workspace.yaml
pnpm --dir output/repworth-marketing-2026-09-08/runtime install --ignore-workspace

node docs/brand-asset-library/collections/2026-09-marketing/source/typecheck.mjs

node docs/brand-asset-library/collections/2026-09-marketing/source/render.mjs --stills --force
node docs/brand-asset-library/collections/2026-09-marketing/source/render.mjs --motion --force
node docs/brand-asset-library/collections/2026-09-marketing/source/render-map.mjs
node docs/brand-asset-library/collections/2026-09-marketing/source/render-abstract.mjs
node docs/brand-asset-library/collections/2026-09-marketing/source/objects.mjs
node docs/brand-asset-library/collections/2026-09-marketing/source/catalog.mjs --register
```

Use `--smoke --force` with `render.mjs` for one social still, an agent card, and a logo video. Add `--match=pattern` to select export paths with a regular expression, for example `--match=agents/dark/`. Existing exports are skipped unless `--force` is provided. Every renderer first runs the media project's strict TypeScript check. This source folder has its own [tsconfig.json](source/tsconfig.json) and is excluded only from the application's compiler scope; Remotion dependencies remain in the isolated runtime. Keep edits in `source/`; running the renderers regenerates the derivatives. Recheck wrapping after changing copy. The source resolves the exact logo, portraits, and fonts from the repository. Light and dark editorial colors are read from their owning stylesheets; [palette-snapshot.json](source/palette-snapshot.json) records this production's values. Map materials have their own reference-inspired palette.

## Production record

- Still artwork: built-in image generation. All 19 still-generation prompts are in [generation-journal.json](source/generation-journal.json).
- Cinematic motion: Runway and Higgsfield. Provider job IDs, prompts, and excluded attempts are recorded in the same journal.
- Typography, illustrations, and assembly: editable Remotion/React and SVG sources.
- Inventory: [manifest.json](manifest.json), also registered in the library's [central catalog](../../digital-asset-management/catalog.json).
- Checks and limitations: [verification.md](verification.md).

**Credit accounting:** Runway used 100 existing credits in this session: 50 for the two delivered clips and 50 for excluded attempts (the earlier people-based café direction and one Reply clip that invented text). Higgsfield used 32.5 existing credits for the delivered parchment clip. Final balances were 75 Runway and 217.5 Higgsfield credits. No purchase, top-up, or new subscription was made. Provider credit units are different and are not summed as dollars. Built-in image generation and local rendering do not have a reported dollar meter here.

The rejected outputs are kept outside the reusable library in ignored production scratch space. Signed URLs and credentials are excluded from the provenance files. The supplied original video remains unchanged in Downloads.
