# Lab notes — Worker startup / Sentry

## Summary

- **Worker startup / Sentry** — the production startup asserts (`assertAlertSinkEnv` / `assertAdminNotificationEmail` / Stripe) early-return unless `NODE_ENV==='production'`, so a prod env that omits `NODE_ENV` silently disables the whole boot-safety layer (set `NODE_ENV=production` AND `SENTRY_DSN` together); Fallow reason-placement refinement (2026-06-20); unlistened EventEmitter `'error'` on any Queue/Worker/ioredis client = fatal uncaughtException → `attachEmitterErrorLogger` + per-source suppress window (#508)

## Canonical entries

### [2026-08-03] Single-replica worker — detection mechanics (moved from CLAUDE.md, context diet)
The worker is single-replica by invariant, and that is DETECTED, not enforced. Four boot guards (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1) plus the in-process LLM circuit breaker are only correct with one replica, and the P2 pollers in `docs/audits/2026-06-17-worker-scaling-hardening-backlog.md` become duplicate-processing bugs with two. `ci:static-policy` blocks `numReplicas`/`multiRegionConfig` in `railway.toml` (config-as-code overrides the dashboard, so that is the one path a static check can block), and every boot logs + Sentry-tags `replica_id`/`deployment_id` via `worker/config/replica-identity.ts`. Railway injects a per-replica id but **no replica count**, so no process can assert it is alone — scaling up starts a new replica without redeploying the existing one, so **two `replica_id`s under one `deployment_id` is the signal**. A dashboard-set replica is not prevented; clear the P2 list first. **The signal is acted on (#587):** each replica registers in Redis under a TTL every `HealthAlertPoller` cycle, and the poller pages when >1 is live — immediately for replicas sharing a `deployment_id` (scale-out), or after a 2-cycle grace for a cross-deployment overlap (so a normal zero-downtime deploy does not page). `worker/background/pollers/health-alert/replica-cardinality.ts`. Deliberately a registry, NOT a boot-gating lease: a Redis outage must degrade to "no replica alerting", never to a worker that will not start — the check carries its own log-and-swallow `try/catch` for exactly that reason.

## 2026-08-31 — WS8 production cutover: Railway deploy configuration

### [2026-08-31] A Railway `redeploy` resolves NO build/deploy config → the prod worker booted the Next.js UI and reported Online
FAIL → mid-WS8-cutover, an Infisical Secret Sync wrote `STRIPE_WEBHOOK_SECRET` and
triggered a Railway redeploy of production `repworth-worker`. The deployment reported
**SUCCESS**, the service reported **Online**, and the container was running
`$ next start` — the Next.js UI, not `tsx worker/index.ts`. No BullMQ consumers, no
pollers, no `assertWorkerStartupEnv`. The immediately previous deployment, at the
**same commit** `06a163f0`, had run `$ tsx worker/index.ts` correctly 29 minutes
earlier. `railway.toml` was unchanged and present on `main` throughout.

WHY → **a `redeploy` does not resolve the service's build/deploy configuration at all.**
It falls back to Railpack's auto-detection, which sees a Next.js repo and picks
`next build` + `next start`. Proven by isolating the variable rather than reasoning
about it: after setting `startCommand`/`buildCommand` **explicitly on the service** and
confirming the read-back, a second `redeploy` *still* ran `next start` and *still* ran
`next build`. So the fallback ignores the service settings, not merely `railway.toml`.
The distinguishing factor is the deployment **kind**, visible as `reason` in
`list-deployments`:

| `reason` | Trigger | Resolves config? |
|---|---|---|
| `deploy` | new commit on the source branch, or `railway deployment redeploy --from-source` | **yes** |
| `redeploy` | Railway dashboard redeploy, and **any variable change** — including an Infisical Secret Sync write | **no** — Railpack auto-detect |

That last row is the trap. Every secret rotation and every flag flip on this service
fires a `redeploy`, so a worker that is correct today reverts to `next start` the next
time anyone touches a variable.

**Why it looked healthy.** `healthcheckPath` is `/api/health`, and that route exists in
the Next.js app as well as the worker. Railway probed it, got 200, reported Online. Same
shape as the `${{Redis.…}}` capitalisation trap: a check that tests *presence of a
response* rather than *identity of the responder* cannot tell a healthy worker from a
healthy impostor. **Read "Online" on this service as unproven until a poller cycle
appears in its own logs.**

CORRECT → recover with **`railway deployment redeploy --from-source`**, not
`redeploy`. The flag means "pull and deploy the latest commit from the configured
source", which produces a `reason: deploy` deployment that resolves configuration
normally. Verified: that run executed the no-op `buildCommand` four times and `next
build` zero times, against the same commit the two failed redeploys used. The MCP
`redeploy` tool and Railway's own "use redeploy to apply immediately" note on service
updates are both wrong for this case — a service-settings change needs a source deploy
to take effect.

Belt and braces, since the two mechanisms are independent: the five deploy/build fields
are now set **both** in `railway.toml` **and** on the Railway service, per environment —
`startCommand`, `buildCommand`, `healthcheckPath`, `restartPolicyType`,
`restartPolicyMaxRetries`. With both in place and identical, a source deploy is correct
under either. `railway.toml`'s header says CHANGE ONE, CHANGE BOTH.

**`repworth-worker` is ONE service shared by both environments** (`fb413c72-…`), and
Railway's `update-service` API defaults to *all* environments when `environmentId` is
omitted. Always pass it, or a production fix silently rewrites staging.

### [2026-08-31] Mirroring the config did NOT stop recurrence → the healthcheck path had to stop identifying the wrong process
FAIL → the obvious fix for the entry above — mirror `startCommand`/`buildCommand` onto the
Railway service — restores the worker but leaves the fault armed. Redeploy `32a54658` ran
with `startCommand` set explicitly on the service and **still** ran `next start`. Since a
`redeploy` is what Railway fires on ANY variable change, every future secret rotation or
`flag-flip` would bring the impostor back, silently, reporting Online.

WHY the impostor could report healthy at all → `healthcheckPath` was `/api/health`, and
**that route exists in the Next.js app as well as the worker**. Railway probed it, got
200, and could not tell which process answered.

CORRECT → point the healthcheck at a path only the worker serves: **`/ready`**
(`worker/index.ts:638`). Next.js's nearest route is `/api/health/ready`, a different path,
so a `next start` deployment 404s the probe, the deployment is marked FAILED, and Railway
keeps the last good deployment live. The silent failure becomes a loud one that cannot
reach production. Verify the path against a running worker BEFORE switching — staging's
public Railway domain answered `{"status":"ready","checks":{"postgres":"ok",
"queue_redis":"ok","cache_redis":"ok"}}`.

**This reverses a deliberate choice and the tradeoff is the point.** `railway.toml` called
`/api/health` a "dependency-light endpoint (no DB/queue/external calls)". `/ready` runs
three live probes, so a deploy now fails if Postgres or either Redis is unreachable at
deploy time. Accepted because that direction is **fail-safe** — the running deployment
stays up — whereas the old posture let a dead worker replace a live one and report green.
**The cost is bounded — checked, not assumed.** Railway's docs say the healthcheck runs
at DEPLOY TIME ONLY ("not continuously after the deployment is live") with a 300s default
window, and a failure leaves the previous deployment serving traffic. So the added probes
gate one moment per deploy and are never a runtime restart risk. General lesson: **a healthcheck that any other process in the repo can also answer is not
a healthcheck, it is a liveness coin-flip.** Ask what else could be listening on that port
before trusting a 200. Follow-up to restore the light posture: a worker-only,
dependency-free `GET` (e.g. `/healthz/worker`) — a boot-surface change, so not done
mid-cutover.

### [2026-08-31] Railway deprecated Config as Code — `railway.toml` stops being read on 2026-12-01
FAIL → not yet a live failure, but it will be. Railway has **deprecated Config as Code**
(`railway.toml` / `railway.json`) in favour of Infrastructure as Code
(`.railway/railway.ts`). Hard cutoff **2026-12-01**; after it the file is not read, and
*new services cannot opt into it* at all. WHY it matters here → `railway.toml` is the
only in-repo record of the worker's start/build/healthcheck/restart configuration. The
mirror onto the service settings (entry above) already removes the single point of
failure, so the cutoff is a documentation-truth problem rather than an outage waiting to
happen. CORRECT → migrate to `.railway/railway.ts` as its own reviewed change before
2026-12-01. **Do NOT apply `railway config migrate` output as generated** — its dry run
(a) names the service `RepWorth`, taken from the *project* name rather than the real
`repworth-worker`, so `railway config apply` would CREATE a second service instead of
updating the existing one, and (b) silently drops `restartPolicyType` and
`restartPolicyMaxRetries`, carrying over only build/start/healthcheck. `railway config
apply` is project-wide with omit-means-delete semantics — never run it mid-cutover
against an environment holding 70 variables, a Redis service and a custom domain.

## History

- history/2026-06.md § "Railway RAILPACK builds have no `.git` → a git-touching `prepare` script breaks the deploy"
- history/2026-06.md § "`railway up` from a nested git worktree ships STALE worker code → `OutboxPoller: Unknown topic`"
- history/2026-06.md § "2026-06-20 — Beta-launch alerting gate (PR #354)"
- history/2026-06.md § "Production startup asserts are gated on `NODE_ENV` — an env without it silently disables them"
- history/2026-07.md § "[2026-07-16] `getServerConfig()` memoizes on first access — mutating `process.env` afterward is a silent no-op"
- history/2026-07.md § "[2026-07-20] A boot-time summed-concurrency assert is only as strong as its hand-maintained queue inventory — a `runLlmTask`-calling worker omitted from the list is silently uncapped"
- history/2026-07.md § "[2026-07-20] An unlistened EventEmitter `'error'` on any BullMQ Queue/Worker/raw ioredis client is a FATAL uncaughtException — every emitter needs a listener, and the listener needs a per-source suppress window"
- history/2026-08-08.md § "[2026-08-08] #697 — an alert on a CONSTANT title groups into one Sentry issue, so a "new issue" rule fires exactly once, ever"
- history/2026-08-09-to-12.md § "2026-08-09 — #719 onboarding drip: dropped column, invisible failure, unbounded churn"
- history/2026-08-21-to-31.md § "2026-08-31 — WS8 Phase G: Sentry seats, and a fail-open validation trap"
- history/2026-08-21-to-31.md § "[2026-08-31] The production dead-man heartbeat never worked → a Sentry monitor SEAT, not a toggle or our code"
- history/2026-08-21-to-31.md § "[2026-08-31] A vault write is a DEPLOY on every synced platform → one env var redeployed a worker that never reads it"
- history/2026-08-21-to-31.md § "2026-08-31 — WS8 G.3: the alarms fire once"
- history/2026-08-21-to-31.md § "[2026-08-31] A recurring ops finding pages NOBODY → Sentry issue alerts trigger on state changes, and an ongoing group has none"
- history/2026-09.md § "2026-09-01 — WS8 G.3 session 2: four drills pass, and three of five deviations correct the campaign itself"
- history/2026-09.md § "2026-09-01 — WS8 G.3 session 3: §4.6 and §4.10 pass, and every one of the four lessons is a claim that was wrong on paper"
- history/2026-09.md § "[2026-09-04] Two Sentry captures that differ only in `extra` are one signal to an alert rule"
