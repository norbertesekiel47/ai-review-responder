---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/instrumentation*.ts"
  - "next.config.mjs"
---

# Next.js app rules

## Read first

- Next.js 16 moved things: read the matching guide under `node_modules/next/dist/docs/` before writing or debugging Next-specific code (`.claude/CLAUDE.md` § Working rules is the single owner of that guidance).
- File map: `docs/directory/app-public.md`, `app-authenticated.md`, `app-admin.md`, `app-api-a.md`, `app-api-b.md` (one page per route group; the Pages table in `docs/directory.md` maps folders to pages), `docs/directory/components.md`; the `src/instrumentation.ts` section of the `docs/directory.md` index.
- Skill `repworth-brand-design` first for any RepWorth UI (Landing / Island / Console); lab notes `.claude/reference/lab-notes/frontend-css-brand.md` (`react-hooks/set-state-in-effect` is `error` repo-wide; iOS Safari rounded-island clip).
- Invariants #1 (Vercel = UI only; ESLint-enforced import boundary, `src/__tests__/eslint-boundaries.test.ts`), #8 (auth scope is app-enforced), #13, #14 stay in `.claude/CLAUDE.md`. Route handlers orchestrate only.

## Traps

- **`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`** required for PlaceAutocomplete. Use only Essentials-tier fields: `id + formattedAddress + location`. Do not use `displayName` (Pro tier).
- **Google Maps URLs use hex CIDs** (`0x...:0x...`), not canonical Place IDs. Resolve via PlaceAutocomplete or SerpAPI, never `data_id`.

## Rules

- Nothing beyond the two gotchas was moved from `.claude/CLAUDE.md`.
