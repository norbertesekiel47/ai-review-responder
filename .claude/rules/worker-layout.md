---
paths:
  - "worker/**"
---

# Worker layout rules

## Read first

- File map: `docs/directory/worker-root.md` (env, config, boot files), `docs/directory/worker-jobs-a.md` / `worker-jobs-b.md` / `worker-jobs-c.md` (job handlers), `docs/directory/worker-background.md` (pollers + schedulers), `docs/directory/worker-ingress.md` (webhook ingress).
- Lab notes: `.claude/reference/lab-notes/worker-startup-sentry.md`, `.claude/reference/lab-notes/worker-crash-net-cost-guard.md`, `.claude/reference/lab-notes/ingress-rate-limiting.md`.
- Skills before writing: `outbox-pattern` (state change + `job_outbox` row in one transaction), `cost-guard` (any LLM or paid call).
- Invariants that bind here (`.claude/CLAUDE.md`): #1, #2, #6, #11, #12, #15. Global gotchas (admission chokepoint, crash-net, cost-guard fail-open) stay in `.claude/CLAUDE.md`.

## Traps

- **An exhaustion rollback can strand an already committed dispatch claim.** Prove the next recovery cycle can still select that state; do not stop at atomic rollback. Operator mechanics: lab-notes/worker-crash-net-cost-guard.md “Operator recovery after dispatch-exhaustion rollback”.
- **BullMQ rejects `:` in job IDs** — OutboxPoller uses `_` separator.
- **`CleanupAbandonedSignupsPoller`**: re-validate ALL predicates inside the tx with `SELECT FOR UPDATE`. `deleteUser()` is irreversible and non-transactional.
- **Three transactions hold a lock across an external call ON PURPOSE (#415) — do not "fix" them.** `publisher/edit-publish.ts` (review+response `FOR UPDATE` across Zernio delete→post→409-verify; stops `processReview` superseding mid-edit; ≈45 s+), `billing/UpdateStripeOverageWorker.ts` (billing lock + account row across Stripe retrieve+mutation — the same-account serialization guarantee of record, `worker/index.ts` boot comment; ≈2–3 min worst case at concurrency 1), `CleanupAbandonedSignupsPoller.ts` (signup lock across `deleteUser`, 10 s; releasing first lets a completing signup lose its Auth identity). A lock that CAN be released first follows `NotificationFailoverPoller.tryClaimAlert`: claim row committed, provider call outside the tx, per-claim idempotency key, failed send KEEPS the claim. WHY: lab-notes/postgres.md "Locks across external calls".
- **The worker is single-replica by invariant — DETECTED, not enforced.** Four boot guards + the in-process LLM circuit breaker assume one replica; `ci:static-policy` blocks `numReplicas`/`multiRegionConfig`, and replicas register in Redis so `HealthAlertPoller` pages when >1 is live (#587) — a registry, NOT a boot-gating lease. Before ever scaling, clear the P2 list in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`. Mechanics: lab-notes/worker-startup-sentry.md "Single-replica worker".
- **Railway private network is IPv6-only** — `ioredis`/BullMQ won't resolve `*.railway.internal` unless `family: 0` is set (`worker/redis-connection.ts` parses `?family=`). Works on local/Upstash, silently fails to connect on Railway without it.
- **Best-effort work after a worker's primary side effect needs its own `try/catch` (log-and-swallow)** — a secondary failure (telemetry, Sentry, cost-threshold check) caught by the outer handler flips an already-completed job to `failed`. Never let observability poison the success path.

## Rules

`docs/directory.md` (index) + `docs/directory/worker-*.md` are the full file map — this lists only the conventions that
decide *where new worker code goes*:

- **Job handlers** in `worker/jobs/`: one top-level `*.ts` per worker, plus a
  per-domain subfolder when a worker has helpers (`response-generation/`,
  `notification/`, `auto-post-notice/`, `publisher/`, `zernio/`, `billing/`,
  `onboarding-demo/`, `account-offboarding/`, `judge/`, `escalation-notice/`,
  `autonomy-suspended-notice/`, `pending-post-notice/`, `csv-ingest/`,
  `solicitation-batch/`, `solicitation-send/`, `solicitation-veto-notice/`).
- **Publishing goes through the `ReviewPublisher` seam** (`src/lib/publishing/review-publisher.ts`):
  the `worker/jobs/publisher/` call-sites resolve + post via `getReviewPublisher()`
  (`resolveTarget`/`publishReply`/`deleteReply`/`findReply`), NOT `zernioClient`
  directly. Zernio is the first adapter (`zernio-review-publisher.ts`); add a
  direct-Google-Business-Profile path as a *second adapter*, not a rewrite. (The
  zernio *ingest* workers READ reviews and are NOT part of this seam.)
- **`'failed'` exhaustion hooks** colocate with their worker
  (`worker/jobs/{publisher/failed-hook,zernio/ingest-failed-hook}.ts`).
- **Background loops** split by trigger: `background/pollers/` (Postgres-state-driven)
  vs `background/schedulers/` (time-cadence-driven) — new loop → pick by trigger.
- **Webhook ingress** terminates in `worker/ingress/`: `{stripe,resend,shared}.ts`
  + per-provider subfolders (`stripe/`, `twilio/`, `telegram/`, `zernio/`, `resend/`).
  `unsubscribe.ts` is the one **recipient-facing** ingress route, not a provider
  webhook: no signature, no `rawBody`, no `claimInboundEvent`, and deliberately
  **exempt from the ingress rate limiter** (§9.2 forbids throttling a statutory
  opt-out — the exemption is read from the RESOLVED route config so an unmatched
  path under the prefix cannot inherit it).
- **Boot-time env assertions**: `worker/config/startup-assert.ts`; **Fastify ingress bounds**:
  `worker/config/fastify-options.ts` (`buildFastifyOptions` — requestTimeout/keepAlive/connection/bodyLimit).
- **Sentry init + scrubber**: `worker/sentry.ts` (imported for side effect by `index.ts`).
- **Non-fatal emitter `'error'` sink**: `worker/emitter-errors.ts` (`attachEmitterErrorLogger`
  — every BullMQ Queue/Worker + raw Redis client gets a listener at its registration site;
  an unlistened `'error'` is a fatal `uncaughtException`).
- **Terminal job-failure sink**: `worker/job-failure-sink.ts` (`attachJobFailureSink` — attached
  to every BullMQ Worker in the same registration loop as `attachEmitterErrorLogger`; raises a
  real Sentry issue on the terminal attempt, replacing the breadcrumb that hid #719 for three
  months). Its terminal test is the `'failed'`-EVENT predicate `attemptsMade >= max` and is
  deliberately NOT `isTerminalAttempt` from `src/lib/shared/outbox.ts`, which is the
  CATCH-BLOCK form and fires one attempt early here — see `worker/jobs/judge/failed-hook.ts`,
  which keeps its own copy and says "do not unify them". Writes nothing to `job_outbox` —
  failed-hooks own that surface. (Since #736 the **Watchdog** terminalizer PRESERVES a
  non-empty `last_error` and writes its generic reclaim text only as a fallback, so a
  hook's bounded error class survives; watchdog seam: `runOutboxWatchdogRecovery`.)
- **Queues**: `worker/queues.ts`; **Redis connection options**: `worker/redis-connection.ts`
  (side-effect-free — unit-testable without booting the queues).
- **Entry point** `worker/index.ts`: pure registration + lifecycle, **no DB writes**.
