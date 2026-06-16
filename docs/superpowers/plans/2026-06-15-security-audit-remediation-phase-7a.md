# Phase 7a Implementation Plan — F-12 COOP/CORP headers

**Spec:** `docs/superpowers/specs/2026-06-15-security-audit-remediation-phase-7a-design.md`
**Branch:** `security/audit-remediation-phase-7a` off `main@71977087`
**Lane:** preview · **Findings:** F-12 (F-23 held per owner)

## Task 1 — F-12: add COOP + CORP headers (TDD)

**Red.** Add `src/lib/security/__tests__/next-config-headers.test.ts`:
- import `next.config.mjs`, await `headers()`, map `result[0].headers` to `{key→value}`.
- expect `Cross-Origin-Opener-Policy` = `same-origin` (FAILS — not present yet).
- expect `Cross-Origin-Resource-Policy` = `same-origin` (FAILS).
- expect existing keys present: HSTS, X-Content-Type-Options, X-Frame-Options,
  Referrer-Policy, Permissions-Policy (passes already — full-block guard).
- expect HSTS value does NOT include `preload` (passes already — encodes F-23 held).

**Green.** In `next.config.mjs`, add the two header entries after `Permissions-Policy`,
before `Content-Security-Policy`. Keep the `.filter((h) => h.value !== '')`.

**Refactor.** None expected (declarative entries).

## Task 2 — doc status update

Update `docs/security-audit/2026-06-15-refresh-delta.md`:
- F-12 row (§7 table): mark fixed — COOP + CORP `same-origin` added in `next.config.mjs`.
- F-23 row (§7 table): note **held pending owner sign-off** on the irreversible
  HSTS preload-list submission (not left as bare "OPEN").

## Verification gate (before PR)

`pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm ci:fallow` ·
`pnpm ci:static-policy` · `pnpm ci:tenant-scope` · `pnpm ci:rls-audit` · `pnpm build`.

## Review

Trivial declarative change → controller verifies the diff directly (handoff allows
this for trivial changes; no novel logic). Then PR + watch CI to green.

## Out of scope

F-11 (7b), F-23 `; preload` (held), any header-block refactor.
