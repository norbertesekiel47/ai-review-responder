# RepWorth Brand Asset Library

Start here for RepWorth design, brand references, and content generation. This library owns the current brand documents and catalogs reusable media wherever the application needs those files to live.

## Find what you need

| Folder | Use it for |
|---|---|
| [Brand kit](brand-kit/README.md) | A compact writing brief, logo downloads, typography, and palette references |
| [Brand guidelines](brand-guidelines/README.md) | Positioning, brand story, voice, visual identity, and evidence requirements |
| [Design systems](design-systems/README.md) | Landing, Island, and Console Style References, including motion and accessibility |
| [Digital asset management](digital-asset-management/README.md) | Searchable asset inventory, source locations, variants, provenance, status, and reuse rules |
| [Content generation](content-generation/README.md) | Context packs and a repeatable workflow for copy, images, video, and product demonstrations |
| [Templates](templates/README.md) | Creative briefs and asset records to copy into a project |
| [Archive](archive/README.md) | Superseded guidance, earlier design explorations, and production history |

## Which source wins?

- **Product behavior and availability:** [PRODUCT.md](../../PRODUCT.md), implementation, and dated verification of the relevant deployment/account. A file's existence does not establish live availability.
- **Positioning, voice, and public claims:** [positioning](brand-guidelines/positioning.md) and the [brand story](brand-guidelines/brand-story.md), refreshed September 7, 2026. These supersede the older agent-first narrative retained in the archive.
- **Visuals:** [visual identity](../../DESIGN.md) routes to one Style Reference per surface. Exact tokens remain owned by CSS; the existing token-pin test checks the documentation against it.
- **Asset identity and provenance:** [catalog.json](digital-asset-management/catalog.json) records the file location, checksum, role, and known limitations. Inclusion is not publication approval or proof of a license.

The brand kit is a portable summary of these sources. If a fact changes, update its owner and refresh the kit in the same change. Existing `DESIGN.md`, `docs/design`, roadmap narrative, and marketing-kit paths retain pointers so older links and agent skills still find the current material.

## Adding material

Put reusable brand documentation here. Put a small reusable creative master in the relevant library folder and register it in the catalog. Keep app-served media in `public/`, fonts in `src/app/fonts/`, and implementation tokens in their existing stylesheets. Store large editable projects and renders in the project's established storage location, with a durable locator and provenance in the catalog; avoid duplicate binaries.

Campaign work belongs in a named, dated project with its completed brief, references, sources, and exports. Register reusable results after review. Historical specs and screenshot evidence stay at their citation paths and are discoverable through the archive index. Local `output/` and `tmp/` work is not a durable shared asset until explicitly registered and stored.

When replacing an asset or guideline, update its catalog entry and incoming links, retain the superseded version or Git reference, and identify its replacement. Keep one current owner per fact.
