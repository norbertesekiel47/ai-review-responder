# Digital asset management

[catalog.json](catalog.json) is the repository asset register. Search by `id`, `category`, `system`, or path. It inventories tracked logos, brand media, design evidence, and fonts; app files remain at their existing served/imported paths.

## How to read a record

Each record has a stable ID, repository-relative path, category, intended role, system, storage class, lifecycle status, byte count, SHA-256, provenance, rights status, and reuse notes. Paths resolve from the repository root. Checksums identify the bytes inspected during inventory; they are not a perpetual freshness guarantee.

- `runtime`: tracked app media or fonts; indicates storage/use, not live-deployment verification.
- `reference`: source material for an established design; consult the linked system before reuse.
- `evidence`: historical screenshot or design-board material; never treat it as a current customer result.
- `existing-export`: an existing export whose equivalence to the current master has not been reviewed.

The initial catalog records provenance as unknown where the repo supplies no evidence. `rights.status = unrecorded` means rights were not established in this task; it does not assert that the asset is unlicensed. Attach the actual license/source record when known. Do not infer distribution rights from a filename or a font family.

Two further `rights.status` values are in use. `first-party` means the asset was authored from editable source in this repository using repository brand assets; where it embeds a portrait whose own rights are unrecorded, the evidence says so. `provider-terms` means a generation provider produced the bytes and the output rights follow that provider's terms for the plan in force at generation; the evidence names the provider and the journal entry. Neither value is publication approval. Verify the provider terms before external publication.

Raster and video renders under `collections/` are stored with Git LFS (`.gitattributes` at the repository root). A fresh clone without `git lfs` installed sees pointer files; run `git lfs install --skip-repo` once, then `git lfs pull`. Lefthook runs the LFS pre-push hook.

## Add or replace an asset

1. Reuse an existing master if it meets the brief. Give new files descriptive lowercase names such as `repworth-copilot-demo-16x9-v01-poster.jpg`; retain current app filenames to preserve URLs.
2. Copy the [asset record template](../templates/asset-record.json). Record source/export relationships, creator or generator, source project or prompt, date, version, rights evidence, intended use, and any review decision. Use repository-relative paths or durable external locators; never temporary signed URLs.
3. Record dimensions/duration where relevant, byte count, and SHA-256. A new encoding, crop, or edit is a derivative with its own identity and checksum.
4. Review visual fidelity, suitability for the chosen system, and claim accuracy before marking a derivative ready for its intended publication. Record who reviewed it and when; catalog inclusion alone is not approval.
5. When replacing bytes, refresh metadata and record the predecessor's Git revision or archive location. Update consumers when paths change.

Keep originals and final exports distinguishable. For video, retain the script, source project, shot references, captions, poster, and reduced-motion alternative as applicable. Large editing caches and intermediate frames belong with the production project, not in the reusable catalog.

## Known gaps

- PNG/PDF logo exports have not been checked for equivalence to the current SVG; print and monochrome variants need an explicit design/export decision.
- The catalog records existing font files. The older font README lists superseded families; the layouts and Console Style Reference establish current usage (Gabarito/Figtree for Console).
- Historical UI evidence may include synthetic values or internal details. Review and sanitize it before external reuse; capture the current product for current product claims.
- Local explainer work in `output/` and `tmp/` is intentionally not registered as shared source. The tracked `public/video/repworth-explainer*` exports are inventoried, with no inferred publication approval.
