# Lint & pre-push hardening — structural prevention (Tier 2)

**Date:** 2026-06-26
**Issues:** #234, #269, #374 (one combined PR — all three mutate the same two config files)
**Branch:** `chore/lint-boundaries-234-269-374`
**Status:** design approved, ready for implementation plan

## Goal

Make three classes of bug *structurally impossible at author-time* instead of relying on
convention + code review:

1. **#234** — UI/route code importing worker-only modules (LLM clients, BullMQ queue,
   Postgres.js transactional client) — violates architecture invariant #1 (*Vercel = UI only*).
2. **#269** — the entire Railway side (`worker/`, `scripts/`, `e2e/`) runs **unlinted**
   (`lint` script is `eslint src`), AND no unused-imports/vars rule exists anywhere — so dead
   imports survive CI.
3. **#374** — the lefthook pre-push hook runs `vitest --changed`, which misses `readFileSync`-based
   guard tests (they aren't in the import graph), giving false-green pushes.

These are cheap, single-PR, high-payoff: each one kills a bug class.

## Findings that shaped the design (verified against the codebase)

- `eslint.config.mjs` already has a **structural-boundaries** section using `no-restricted-imports`,
  with a documented footgun: **`no-restricted-imports` does NOT merge across flat-config objects** —
  for a given file the *last* matching object wins, so each more-specific zone **restates** the bans
  it inherits.
- `.mjs` files are **globally ignored** by ESLint (eslint-config-next crashes on `.mjs` under ESLint 10).
- The resolved config has **no `@typescript-eslint/no-unused-vars` / `no-unused-imports` rule at all** —
  only `react/jsx-no-undef`. So the original dead-import incident (#269) survived for *two* reasons:
  scope (`eslint src`) **and** the absence of any unused rule. Widening scope alone would not have
  caught it.
- Enabling `@typescript-eslint/no-unused-vars` (with `^_` ignore patterns) surfaces **126 violations:
  100 in `src/`, 23 in `worker/`, 3 in `e2e/`, 0 in `scripts/`**. The bulk is in already-linted `src/` —
  they don't fire today only because the rule is off.
- `@typescript-eslint/no-unused-vars` **already resolves** via the next flat config — **no new
  dependency** is needed to enable it.
- #234's existing surface in `src/app`/`src/components`:
  - `src/app/api/settings/route.ts` and `src/app/api/onboarding/start/route.ts` use
    `import type postgres from 'postgres'` — **type-only**, legitimately allowed.
  - `src/app/api/admin/jobs/route.ts` imports `bullmq`'s `Queue` at **runtime** to read admin
    queue-health — the one genuine pre-existing case.
  - The Zernio ADR-0001 routes (`connect/callback`, select-location) do **not** import any forbidden
    SDK directly (they go through `src/lib`) — so the ADR-0001 carve-out needs **no special handling**.
- `src/lib/**` is **shared** between Vercel and the worker (it legitimately imports
  `postgres`/`bullmq`/`openai`), so the #234 ban must scope to the **entry surface**
  (`src/app/**` + `src/components/**`), never `src/lib/**`.

## Decisions (locked with the user)

| Decision | Choice |
|---|---|
| PR structure | **One combined PR**, one sibling worktree. |
| #269 unused rule | **Full `@typescript-eslint/no-unused-vars` as `error`** across all dirs (no new dep); fix/scope all 126. |
| #234 `admin/jobs` bullmq case | **Scoped `eslint-disable` + rationale** (it's an admin *read*, not enqueue); **file a follow-up issue** to move queue-health to the worker. |
| #374 pre-push fix | **Run `pnpm vitest run src/__tests__` unconditionally** (issue's option 1). |
| Type-only imports | Allowed via `allowTypeImports: true`. |
| #234 ban scope | `src/app/**` + `src/components/**` (+ `middleware`/`instrumentation` if present); never `src/lib/**`. |
| Widened lint invocation | `eslint .` (robust to future top-level dirs; build artifacts already in `ignores`). |

## Part A — #234: `Vercel = UI only` as an ESLint boundary

**Forbidden in `src/app/**` + `src/components/**` (runtime imports only):**
`openai`, `@anthropic-ai/sdk`, `bullmq`, `postgres`, `**/responses/generator*`, `**/worker/queues*`.

**Mechanics:**
- New flat-config zone(s) for the entry surface with the invariant-#1 bans, each carrying a `message`
  citing invariant #1.
- `allowTypeImports: true` so `import type postgres` passes.
- **Restate inherited bans** (the `../..` parent-traversal ban; for components, the `@/app/*` ban) in
  the new zone per the no-merge footgun. Order the new zone(s) so the `components/ui/**` zone is not
  clobbered (place before it, or restate ui's bans).
- The one real case — `src/app/api/admin/jobs/route.ts` runtime `bullmq` import — gets a scoped
  `eslint-disable-next-line no-restricted-imports` + rationale comment (admin read, closes the queue
  after counting). Follow-up issue filed to relocate it to the worker (also fixes a likely-broken
  Vercel→Railway-Redis call).

**Robustness mechanism (the key deliverable):** a guard test that drives the **ESLint Node API**
(`new ESLint()` / `lintText({ filePath })`) over in-memory fixtures and asserts:
- `src/app/x/route.ts` importing `openai` → **errors** (and `bullmq`, `postgres`, `generator`, `queues`).
- `src/lib/x.ts` importing `openai` → **does NOT error** (shared lib boundary intact).
- `import type postgres from 'postgres'` in an app file → **allowed**.
- `../../foo` parent-traversal in an app file → **still errors** (inherited ban not dropped).

This makes the config correct-by-verification and is a permanent regression guard against future zone
edits silently dropping a ban. Written **test-first (red → green)**.

## Part B — #269: widen scope AND enable the unused rule

1. **Widen** `package.json` `lint`: `eslint src` → `eslint .`. The lefthook `lint` step calls
   `pnpm lint`, so it inherits the change with no edit.
2. **Enable** `@typescript-eslint/no-unused-vars` as `error` (no new dep), with
   `argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern` = `^_`.
3. **Clean up all 126 violations:** remove genuinely-dead imports/vars; `_`-prefix intentionally-unused
   bindings; scoped-disable only the rare legitimate case with a stated reason. No behavior change.
4. Confirm `eslint .` does not choke on any top-level dir (ESLint ignores `node_modules` by default;
   `.next/out/build/coverage/*.mjs` already in `ignores`). Add ignores if a generated dir surfaces.

## Part C — #374: close the pre-push guard gap

- Add a lefthook `pre-push` command `guards: pnpm vitest run src/__tests__` running unconditionally
  alongside `test-changed`. The `src/__tests__/*` guards are fast file-reads.
- Update the hook comment to explain the import-graph blind spot (why `--changed` misses
  `readFileSync` guards) so the reason is encoded, not folklore.
- **No CI change** — the full `pnpm test` already backstops in CI.

## Sequencing inside the PR

1. B: widen `eslint .` + enable `no-unused-vars` (surfaces the 126).
2. B: mechanical cleanup of the 126 → green.
3. A: boundary zone(s) + guard test (TDD red→green) + scoped disable on `admin/jobs`.
4. C: lefthook step + comment.

Each step lands green (`pnpm lint && pnpm typecheck && pnpm test`) before the next.

## Verification gate

From the **sibling worktree root** (trustworthy local CI):
`pnpm lint && pnpm typecheck && pnpm test`. Plus `pnpm ci:tenant-scope && pnpm ci:rls-audit` —
not strictly DB-touching, but cheap and they ride the same hook.

## Out of scope (follow-ups)

- Relocating `admin/jobs` queue-health reading to the worker (new issue, referenced from the scoped
  disable).
- `eslint-plugin-boundaries` or `eslint-plugin-unused-imports` — not adopted; existing
  `no-restricted-imports` + `@typescript-eslint/no-unused-vars` cover the need without new deps.
- Fixing the `.mjs` ESLint-10 incompatibility (tracked separately; `csp.mjs` stays covered by tsc + its unit test).

## Acceptance criteria

- [ ] A `src/app`/`src/components` file importing any forbidden module fails `pnpm lint` with an
      invariant-#1 message; `import type` and `src/lib` imports are unaffected.
- [ ] Guard test asserts the bans fire (and don't over-fire) via the ESLint Node API.
- [ ] `pnpm lint` covers `worker/`, `scripts/`, `e2e/` (via `eslint .`); `@typescript-eslint/no-unused-vars`
      is `error`; all 126 violations resolved.
- [ ] Pre-push runs `src/__tests__` guards unconditionally; comment explains why.
- [ ] One-line note in CLAUDE.md that invariant #1 is now ESLint-enforced.
- [ ] All 4 GitHub CI checks green; React Doctor 100/100.
