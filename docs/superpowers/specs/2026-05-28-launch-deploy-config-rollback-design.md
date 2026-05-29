# Launch-readiness Point 3 — Deploy config (IaC) + rollback runbook + ADMIN_API_KEY cleanup

**Date:** 2026-05-28
**Author:** Norbert (+ Claude)
**Source task:** `docs/launch-ready-part1.md` line 166 — "Add `railway.toml` / `vercel.json`, write `docs/runbooks/rollback.md`, clean up the stale `ADMIN_API_KEY` comment."
**Branch:** `worktree-launch-p1-deploy-config` (isolated linked worktree under `.claude/worktrees/`)

---

## Problem / context

RepWorth deploys with **zero infrastructure-as-code**: no `railway.toml`,
`railway.json`, `vercel.json`, `nixpacks.toml`, or `Procfile`. Both services run
entirely from dashboard configuration, so the deploy contract is undocumented and
does not survive a project recreation or a stray dashboard edit. There is also no
written rollback procedure (only a Zernio publishing kill-switch in
`beta-deployment-plan.md §10.5`), and `.env.example` carries a **misleading,
unused** `ADMIN_API_KEY` entry whose comment claims it guards `/api/admin/*` when
admin authorization is actually enforced by `requireRole(request, 'admin')`.

Confirmed facts from the codebase:

- **Web (Vercel):** Next.js 16. Build `pnpm build` (= `next build`), start `next start`.
  No `output: 'standalone'`. Security headers already live in `next.config.mjs`.
  Health endpoint: `GET /api/health` → 200 `{service:"web"}` (dependency-light).
- **Worker (Railway):** Fastify + BullMQ, started by `pnpm worker`
  (= `tsx worker/index.ts`, no build step — tsx transpiles at runtime). Binds
  `0.0.0.0:$PORT` (Railway injects `PORT`). Health endpoint: `GET /api/health`
  → 200 `{service:"worker"}` (dependency-light).
- **Runtime:** Node `^24.15.0`, `pnpm@11.0.9` (declared in `package.json` →
  Nixpacks auto-detects pnpm).
- **OAuth handshake routes** (ADR 0001 carve-out, short user-blocking calls):
  `src/app/api/zernio/connect/callback/route.ts`,
  `src/app/api/zernio/connect/select-location/route.ts`. No route currently sets
  `maxDuration`.
- **`ADMIN_API_KEY`:** referenced **nowhere** in `src/`, `worker/`, `scripts/`,
  or `tests/`. Present only as a misleading entry in `.env.example:78-81` and a
  misleading line in `docs/runbooks/beta-deployment-plan.md:218`.

## Goals

1. Capture the existing deploy contract as in-repo config so it survives dashboard
   drift / project recreation — **without changing any current deploy behavior.**
2. Provide a single authoritative rollback runbook that orchestrates (does not
   duplicate) the existing runbooks.
3. Remove the dead, misleading `ADMIN_API_KEY` documentation.

## Non-goals

- No change to runtime behavior of either service.
- No new Railway builder (no `Dockerfile` / `nixpacks.toml`) — Nixpacks
  auto-detect already works.
- No `maxDuration` / route-segment changes (chosen: minimal `vercel.json`).
- No second admin-auth mechanism (would violate invariant 8 "auth is
  app-enforced"). `ADMIN_API_KEY` is removed, not revived.
- No edit to `docs/launch-ready-part1.md` (it is the tracking checklist and is
  already modified in the working tree; left untouched to avoid churn).

---

## Design

### Deliverable A — `railway.toml` (new, repo root)

Configures **only** the Railway worker service. Mirrors `beta-deployment-plan.md
§5.1` and the launch-doc spec (`launch-ready-part1.md:93-94`).

```toml
# Railway config for the RepWorth worker (Fastify + BullMQ).
# Vercel runs the Next.js UI; this file configures ONLY the Railway worker.
# Keeps deploy config in-repo so it survives dashboard edits / project recreation.

[build]
builder = "NIXPACKS"

[deploy]
startCommand = "pnpm worker"
healthcheckPath = "/api/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

Rationale:
- `startCommand` / `healthcheckPath` match what the worker already needs; `$PORT`
  is read by Fastify so no port setting is required.
- **No `buildCommand` override** → Nixpacks default behavior is preserved exactly
  (zero risk vs. today's dashboard deploy). *Known wasteful side effect:* Nixpacks
  runs `next build` on the worker too; harmless, left as a future optimization
  rather than a behavior change in this PR.
- `ON_FAILURE` + bounded retries = supervised crash recovery, not an infinite
  restart loop (production.md "let-it-crash with supervision").

### Deliverable B — `vercel.json` (new, repo root) — minimal & safe

Pins only what the dashboard already uses (`beta-deployment-plan.md §4.1`).

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "buildCommand": "pnpm build"
}
```

Rationale:
- Identical to current dashboard behavior; just version-controlled.
- **No `functions`/`maxDuration`** — default function timeout (300s) is ample and
  Vercel here is UI-only; the OAuth handshakes are short.
- **No `headers`** — those are owned by `next.config.mjs` (single owner; do not
  duplicate).
- **No `installCommand`** — left to Vercel auto-detect so any existing
  frozen-lockfile install setting is preserved.

### Deliverable C — `docs/runbooks/rollback.md` (new)

Follows the established runbook house style (H1 + short intro + `---` + sections).
**Orchestrates** existing runbooks rather than duplicating them. Section outline:

1. **Roll back vs. roll forward** — quick decision guidance; severity link to
   `observability.md`.
2. **Feature-flag rollback (fastest)** — server-authoritative flips (invariant 13);
   includes the Zernio kill-switch (`ZERNIO_PUBLISHING_ENABLED=false`) pointing to
   `beta-deployment-plan.md §10.5`.
3. **Vercel (web) rollback** — Instant Rollback / promote previous deployment.
4. **Railway (worker) rollback** — redeploy/rollback to a prior deployment;
   `$PORT` + healthcheck notes.
5. **Database — forward-only + expand/contract** — never auto-down-migrate prod;
   fix a bad migration via a compensating *forward* migration or a manual
   transaction; code must remain schema-compatible after a code rollback;
   reference Supabase PITR/backups (`beta-deployment-plan.md §12.5`).
6. **Web ↔ worker version skew** — the transactional outbox decouples them; safe
   ordering; what to watch.
7. **Post-rollback verification** — both `/api/health`, `/admin/jobs`, Sentry
   (reuses `observability.md` synthetic checks).
8. **Guardrails** — never bypass approval, never disable moderation, prefer
   pausing a queue (mirrors `oncall-3am.md`).

### Deliverable D — `ADMIN_API_KEY` cleanup (dead-config removal)

- **`.env.example:78-81`** — delete the entire `# --- Admin auth … ADMIN_API_KEY=`
  block. The comment falsely claims it locks down `/api/admin/*`; the var is
  unused (admin auth = `requireRole(request, 'admin')`). Collapse surrounding
  blank lines cleanly.
- **`docs/runbooks/beta-deployment-plan.md:218`** — remove the
  `ADMIN_API_KEY  # set to a random 32-char string for prod` line from the Vercel
  server-only env block (misleading; the var is unused).
- **Pre-removal verification** — re-grep `src/`, `worker/`, `scripts/`, `tests/`,
  and `worker/config/startup-assert.ts` to re-confirm zero references and that no
  `.env.example` parity test asserts the key.

---

## Risk / "don't break existing functionality"

| Change | Affects runtime? | Why safe |
|---|---|---|
| `railway.toml` | Worker deploy only | Encodes current behavior; no `buildCommand` override |
| `vercel.json` | Web deploy only | Mirrors current dashboard defaults; no headers/functions |
| `rollback.md` | No | New doc |
| `ADMIN_API_KEY` removal | No | Var unused in all code paths (verified) |

## Verification plan

- **Read-only greps**: confirm zero `ADMIN_API_KEY` references remain in
  code/tests after removal.
- **Config syntax**: `vercel.json` parses as JSON (`node -e`/`python3 -m json.tool`);
  `railway.toml` is trivial valid TOML (visual review).
- **lint / typecheck / test / build**: these changes touch no `src/` TS or tests,
  so the suite is unaffected. Per CLAUDE.md ("push and read the runner"), the full
  suite runs on **CI when the PR is opened** rather than locally inside this
  worktree (which has no `node_modules` and is nested — running it would leak
  module resolution into the parent).

## Integration

Land via PR (main is protected). Push the worktree branch to a clean remote name
(`feat/launch-p1-deploy-config`) and open a PR. The 4 CI checks (lint, typecheck,
test, build) must be green before merge.

## Out of scope / follow-ups

- Trim the wasteful `next build` on the Railway worker (Nixpacks `buildCommand`
  optimization).
- Mark `launch-ready-part1.md:100` resolved once this merges (tracking-doc edit).
