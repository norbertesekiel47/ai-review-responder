---
paths:
  - "**/*.integration.test.ts"
  - "src/__tests__/**"
  - "scripts/test-db-setup.sh"
  - "vitest.config.*"
---

# Live-DB test rules

## Read first

- Lab notes: `.claude/reference/lab-notes/live-db-test-suites.md` (#573 naming + no run-time DDL; `TEST_DATABASE_POOL_URL` fallback; live-DB lane CI gating), `.claude/reference/lab-notes/testing.md`, `.claude/reference/lab-notes/false-coverage-mutation.md` (fallow coverage input is DB-complete; mutation-pin guard-shaped fixes), `.claude/reference/lab-notes/ci-tooling.md` (a local-only RLS/permission failure is probably the schema grant).
- Dev commands (`.claude/CLAUDE.md`): `pnpm test:db:setup` (provision to migrations head; re-run after every migration), `pnpm test:integration` (one-suite fast-path, never the gate), `pnpm test` (the gate).
- Audits: `scripts/ci/live-db-suites-audit.ts` (`ci:live-db-suites`, the two conventions), `src/__tests__/ci-audit-wiring.test.ts` (pins the CI YAML).
- Working rules: always write tests for webhook handlers, billing math, idempotency keys, tenant-scoped queries, approval-token paths, outbox transitions, subscription guards.

## Traps

- **A live-DB *suite* is named `*.integration.test.ts`; no live-DB *file* — suite or `__tests__/` helper — executes DDL at run time.** The name selects vitest's serialized `integration` project; run-time DDL deadlocks (40P01) across concurrent suites. Escapes: the lock-enforced allowlists in `scripts/ci/live-db-suites-audit.ts` or `-- live-db-ddl-ignore: <reason>`; force aborts via `helpers/abort-injection.ts`, never a temporary constraint. CI-enforced: `ci:live-db-suites`. Mechanics: lab-notes/live-db-test-suites.md "#573".
- **Unsetting `TEST_DATABASE_POOL_URL` does NOT put live-DB suites to sleep** — `resolveTestDatabaseUrl()` falls back to reading `.env.local` off disk, and a whole-repo `pnpm test` with the DB awake breaks import-time-singleton suites (the #520 class; CI is immune by coincidence). Kill switch: `REPWORTH_DISABLE_LIVE_DB_SUITES=1` (#563). Full mechanics: lab-notes/live-db-test-suites.md "TEST_DATABASE_POOL_URL fallback".
- **The fallow PR gate is `ci:fallow:coverage`, fed by the `test` job's `pnpm test:coverage` (live-DB lane included, #581); a bare `fallow audit` does NOT predict it in either direction** — it estimates CRAP from export references (#783: green locally, CRAP 420 in CI). Reproduce the real gate: `pnpm test:coverage && pnpm ci:fallow:coverage`. Details: lab-notes/ci-tooling.md "fallow coverage input is DB-complete".
- **The live-DB lane IS gated by `pnpm test`, not `pnpm test:integration`.** The `test` job stands up `postgres:16` + `TEST_DATABASE_POOL_URL` + schema, so `vitest run` runs both projects; `pnpm test:integration` is a one-suite fast-path, never the gate. Suites SILENTLY SKIP without a DB — `src/__tests__/ci-audit-wiring.test.ts` pins that YAML. Locally export `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` first. Mechanics: lab-notes/live-db-test-suites.md "live-DB lane CI gating".

## Rules

- Nothing beyond the four gotchas was moved from `.claude/CLAUDE.md`.
