---
paths:
  - "src/lib/config/**"
  - "worker/env.ts"
  - "worker/config/**"
  - "docs/eservices-variables.md"
  - ".claude/reference/env-vars.md"
---

# Env vars and feature flags rules

## Read first

- `docs/eservices-variables.md` (canonical flat inventory) + `.claude/reference/env-vars.md` (per-flag behavior).
- Skill `flag-flip` before changing any feature-flag env var on Railway or Vercel — especially the autonomy flags.
- File map: `docs/directory/lib-db-config-shared.md` § `config/`; `docs/directory/worker-root.md` (`worker/env.ts`, `worker/config/`).
- Lab notes: `.claude/reference/lab-notes/worker-startup-sentry.md` (the production startup asserts early-return unless `NODE_ENV==='production'`), `.claude/reference/lab-notes/testing.md` (memoized `getServerConfig()` ignores late `process.env` mutation).

## Traps

- `ci:env-registry` fails any production-read var with no row.
- a flag needs BOTH rows (`docs/eservices-variables.md` = canonical flat inventory; `.claude/reference/env-vars.md` = per-flag behavior).
- Invariants #13 (feature flags are server-authoritative; no `NEXT_PUBLIC_*` companion — `ci:static-policy` allowlists every one) and #14 stay in `.claude/CLAUDE.md`.

## Rules

- Nothing beyond the two row parentheticals was moved from `.claude/CLAUDE.md`.
