# Plan — #408: relocate per-queue depth (`getJobCounts`) off Vercel onto the Railway worker

Branch: `feat/408-queue-health-worker`

## Problem

`src/app/api/admin/jobs/route.ts` instantiates a BullMQ `Queue` at runtime inside a
Next.js route to call `getJobCounts()`, guarded by a scoped
`eslint-disable-next-line @typescript-eslint/no-restricted-imports`. This violates
invariant #1 (Vercel = UI only) and the Vercel→Railway-Redis call almost certainly
already returns `{ unavailable: true }` in prod (Railway private network is
IPv6-only and not Vercel-reachable). The outbox summary + failed-job parts of the
panel already read from Postgres and are untouched — only the per-queue depth needs
relocating.

## Locked approach (from orchestrator — not re-litigated)

Authenticated worker Fastify endpoint; the Vercel route fetches it server-side.
No migration, no DB schema change.

## Decisions (self-resolved, recorded here)

1. **Module home = `worker/internal/queue-health.ts`, NOT `worker/ingress/`.**
   Invariant #6 reserves `worker/ingress/` for *third-party webhook* ingress
   (Stripe/Resend/Twilio/Zernio). This is a first-party admin read, so it belongs
   in a new `worker/internal/` namespace. `worker/index.ts` only registers it
   (invariant #12: entry points orchestrate; modules own behavior).

2. **Secret routed through the config lane, not a raw `process.env` read.**
   `ci:process-env` fails any NEW non-baseline `process.env` read under
   `src/lib/**` or `worker/**`. So `WORKER_INTERNAL_SECRET` is added as an
   **optional** (`optionalVar`) field to BOTH `src/lib/config/worker.ts`
   (worker reader) and `src/lib/config/server.ts` (Vercel reader). It is NOT added
   to `WORKER_REQUIRED_VARS` / boot asserts — staying optional keeps
   `ci:config-coverage` untouched and satisfies "do NOT boot-assert it / must not
   break prod boot when unset". `optionalVar` collapses `''`/whitespace → undefined,
   which is exactly the desired "absent ⇒ disabled" semantics.

3. **Job-count states reused verbatim** from the old route:
   `waiting, active, delayed, failed, completed, paused` — exported as
   `QUEUE_HEALTH_JOB_STATES` so the worker registration and any test share one owner.

4. **Queue iteration source = `ALL_QUEUE_NAMES`** (shared registry) so the endpoint
   cannot drift behind `worker/queues.ts`. The handler is dependency-injected with a
   `getQueueCounts(name)` fetcher (wired in `index.ts` to
   `topicToQueue[name].getJobCounts(...)`) so the module unit-tests without booting
   BullMQ/Redis.

5. **Auth = `Authorization: Bearer <secret>` with constant-time compare.**
   `node:crypto` `timingSafeEqual`, length-guarded (unequal length → reject before
   the compare). Missing/malformed/mismatch → 401. Secret unset → 503 `{disabled:true}`
   (never expose data). Secret is never logged.

6. **Vercel route degrades to the EXISTING shape.** On missing
   `WORKER_PUBLIC_URL` or `WORKER_INTERNAL_SECRET`, non-200, network error, or
   timeout, the route returns `queueHealth: { unavailable: true }` and logs a
   warning — never throws. Response contract
   `queueHealth: Record<string, Record<string, number>> | { unavailable: true }`
   is unchanged, so the admin UI is untouched. Outbound `fetch` uses
   `AbortSignal.timeout(5000)` (explicit short timeout, no retry — admin read).
   Worker origin normalization reuses the canonical `getWorkerPublicUrl()` reader
   (wrapped in try/catch so "unset" degrades instead of throwing).

## Changes

- `src/lib/config/worker.ts` — add `WORKER_INTERNAL_SECRET: opt`.
- `src/lib/config/server.ts` — add `WORKER_INTERNAL_SECRET: opt`.
- `worker/internal/queue-health.ts` — NEW. `QUEUE_HEALTH_JOB_STATES`,
  `isAuthorizedQueueHealthRequest`, `createQueueHealthHandler`.
- `worker/index.ts` — register `app.get('/internal/queue-health', …)`; import
  `topicToQueue` + `getWorkerConfig`.
- `src/app/api/admin/jobs/route.ts` — drop `bullmq`/`ioredis` imports,
  `parseRedisUrl`, the eslint-disable, and `ALL_QUEUE_NAMES`; replace the BullMQ
  block with a `fetchQueueHealth()` server-side fetch helper.
- `.claude/reference/env-vars.md` + `.env.example` — document the new secret
  (server-only, `openssl rand -hex 32`, optional/degrades).

## Tests (TDD)

- `worker/internal/__tests__/queue-health.test.ts` — 503 (secret unset), 401
  (no header / malformed / wrong secret), 200 (good secret → `{queues}` for all
  `ALL_QUEUE_NAMES`, fetcher called per queue).
- `src/app/api/admin/jobs/__tests__/route.test.ts` — mock `fetch`: success →
  depths surfaced under `queueHealth`; non-200 / network error / timeout / missing
  config → `{ unavailable: true }`. Outbox + failed-job Postgres reads still shape
  the rest of the payload.

## Verify gate

Targeted test files during dev; then `pnpm lint && pnpm typecheck && pnpm test` +
`pnpm ci:tenant-scope`. Worker-touching, not DB-schema-touching.

## Ops follow-up (for the PR)

Set `WORKER_INTERNAL_SECRET` (same value) on BOTH the Vercel project and the
Railway worker, per env, before the panel shows live depths. Until then it
degrades to `{ unavailable: true }` (the current prod behavior). `WORKER_PUBLIC_URL`
must also be set on Vercel (already required for Twilio).
