## `worker/`

Standalone Node.js process (Railway). Entry point is `worker/index.ts`.

### `worker/env.ts`

Calls `dotenv.config({ path: '.env.local' })`. **Must be the first import in `index.ts`** — before any module that reads `process.env`.

### `worker/index.ts`

Starts everything:

1. Calls `env.ts` (dotenv load).
2. Runs startup assertions (env vars for enabled channels).
3. Creates a Fastify server on `PORT` (default 3001) with `rawBody` enabled.
4. Registers BullMQ workers (one per queue, handler imported from `jobs/`).
5. Registers webhook routes (`POST /ingress/*`).
6. Starts all pollers and schedulers.
7. On `SIGTERM` / `SIGINT`: drains workers, stops pollers, closes Fastify, exits.

### `worker/queues.ts`

Defines all BullMQ `Queue` instances (one per job type), including WS6 autonomy queues and the WS8 Stripe subscription-mirror repair queue on the shared retry defaults. Exports:

- `queues` — object keyed by queue name.
- `topicToQueue` — maps `job_outbox.topic` strings to `Queue` instances (used by `OutboxPoller`).
- `getRedisOptions()` — Upstash Redis connection config for BullMQ.

Imports queue name constants from `src/lib/shared/queue-names.ts`.

### `worker/internal/queue-health.ts`

First-party internal endpoint backing the admin jobs panel's per-queue depth (`GET` with `WORKER_INTERNAL_SECRET` bearer auth, constant-time compare; 503 `{disabled}` when the secret is unset). Lives in `worker/internal/` because it is not third-party webhook ingress (invariant #6). Dependency-injected (secret reader + per-queue count fetcher) so `worker/index.ts` owns the BullMQ/Redis wiring. Imports the shared job-states list from `src/lib/shared/queue-health-states.ts` (and re-exports it for its callers).

### `worker/config/startup-assert.ts`

`assertChannelsSmsEnv()`, `assertChannelsTelegramEnv()`, `assertChannelsWhatsAppEnv()`, `assertSelfServeSignupEnv()`, `assertZernioEnv()` — each checks that required env vars are present when the corresponding feature flag is `true`. `assertServerOnlyFeatureOptionalBooleansEnv()` also rejects loose values for WS6 `JUDGE_ENABLED` / `GOVERNOR_ENABLED`. Called once at startup; throws if invalid.

### `worker/` — root modules (boot, lifecycle, sinks)

Side-effect-free helpers that `worker/index.ts` wires at boot — Redis options, Sentry init, the two error sinks, log-context wrapping, the shutdown handler, and the transient-rejection governor. `env.ts`, `index.ts` and `queues.ts` keep their own headings above.

| File | What it does |
|------|--------------|
| `emitter-errors.ts` | `attachEmitterErrorLogger(emitter, source)` — non-fatal `'error'` sink for BullMQ Workers/Queues and raw ioredis clients (an unlistened emitter `'error'` becomes a fatal `uncaughtException`). Logs a structured warning plus a Sentry `worker_emitter_error` message; a per-source 60s window reports the first error, counts and suppresses the rest, and surfaces the suppressed count when the next window opens. The listener never throws. |
| `job-failure-sink.ts` | `attachJobFailureSink(worker, queueName)` / `reportJobFailure()` — on a BullMQ `'failed'` event whose `attemptsMade >= attempts`, raises a real Sentry issue tagged `{subsystem, queue, topic}` and logs a bounded error class. Keeps its own `'failed'`-EVENT terminal test (deliberately not `isTerminalAttempt`) and never writes `job_outbox`. **(#719)** |
| `job-log-context.ts` | `extractJobLogContext(job)` reads `worker_job_id`, `correlation_id`, `account_id`, `business_id`, `review_id`, `response_id` from a BullMQ payload plus a fresh `request_id`; `withJobLogContext(handler)` wraps a processor in `withLogContext` so every log line during the job carries them. Applied at registration in `worker/index.ts`; handlers add `account_id` later via `mergeLogContext`. |
| `redis-connection.ts` | `getRedisOptions()` builds the BullMQ ioredis options from `REDIS_QUEUE_URL`/`REDIS_QUEUE_TOKEN` — local `redis://`, Railway private-net `?family=0` (IPv6-only), `rediss://` TLS, or an Upstash REST URL; `parseRedisFamily()` accepts only the literals `0`/`4`/`6`. Side-effect-free: importing it opens no connection, so it is unit-testable without `worker/queues.ts`. |
| `sentry.ts` | Side-effect module: `Sentry.init` with `SENTRY_DSN`, `tracesSampleRate 0.1`, `environment: deploymentLane()` (not `NODE_ENV` — #610) and `scrubSentryEvent` as `beforeSend`; then tags every event with `replicaIdentityFields(readReplicaIdentity())` so a second replica shows up as a second `replica_id` under one `deployment_id` **(#567)**. Re-exports `Sentry`. |
| `shutdown.ts` | `createGracefulShutdown(deps)` — the SIGTERM/SIGINT handler with every dependency injected (`GracefulShutdownDeps`). Idempotent across repeated signals, bails if the fatal-exit crash net is already running, arms a force-exit watchdog first, aborts the boot coordinator **(#505)**, stops loops, drains and flushes analytics + Sentry BEFORE the blocking `closeWorkers()`, then closes queues, server, analytics and DB. Every step is log-and-swallow. |
| `transient-rejection-governor.ts` | `createTransientRejectionGovernor({sustainedMs, idleResetMs})` — pure, clock-injected governor deciding when recovered transient-DB `unhandledRejection`s stop being transient. `record(nowMs)` returns true once an uninterrupted storm has lasted `sustainedMs` (default 10 min); a quiet gap of `idleResetMs` (default 5 min) resets it, so a boot fan-out burst never escalates to a fatal exit. |

### `worker/config/` — boot-time configuration modules

Ingress-server options and Railway/env readers consumed at boot; `startup-assert.ts` keeps its own heading above.

| File | What it does |
|------|--------------|
| `content-type-parsers.ts` | `registerIngressContentTypeParsers(app)` — registers an `application/x-www-form-urlencoded` parser (`parseAs: 'string'`, body passed through untouched) so Fastify accepts Twilio WhatsApp inbound and status-callback POSTs instead of rejecting them with 415 before the handler runs; the Twilio handlers parse `request.rawBody` themselves. |
| `fastify-options.ts` | `buildFastifyOptions(productionConfigRequired)` — the ingress server's `FastifyServerOptions`: 30s request / 60s keep-alive / 10s connect timeouts, 5 MB body limit, log level `warn` on production lanes, and URL redaction for the whole server — `serializers.req` runs `redactSensitivePathsAndQueries` on `req.url`, pino `redact` runs `redactSensitiveTokenPaths` over `msg`/`err.message`/`err.stack` (invariant #5). Reads no `process.env`; the caller resolves the lane. |
| `replica-identity.ts` | `readReplicaIdentity(env?)` reads the Railway system variables (`RAILWAY_REPLICA_ID`, `RAILWAY_DEPLOYMENT_ID`, region, service, environment) into a `ReplicaIdentity` with `onRailway`; `replicaIdentityFields()` turns it into log/tag fields (defined values only). Detection surface for the single-replica invariant — a second `replica_id` under one `deployment_id` means the service was scaled **(#567)**. |
| `startup-side-effect-guard.ts` | Side-effect module: calls `assertWorkerStartupEnv()` from `startup-assert.ts` at import time and, on failure, prints `[worker] Startup assertion failed: …` and `process.exit(1)`. Exports nothing. |



---

