# Production Hardening — Guards Branch (P1, P2, P3, P5, P6, P7, P10)

**Date:** 2026-07-16
**Branch:** `fix/prod-hardening-guards` (sibling worktree off `origin/main`)
**Status:** Approved by owner (interactive session, 2026-07-16)

## Context

A pre-production review surfaced 10 prioritized reliability findings. All 10
were verified against the working tree (read-only sweep, 2026-07-16); every
finding was CONFIRMED. The owner split the work:

- **This branch (guards):** P1, P2, P3, P5, P6, P7, P10 — mechanical,
  low-blast-radius hardening.
- **Follow-up branch:** P4 (owner-unreachable escalation via a distinct
  `owner_unreachable` outcome + health-alert check), P8 (short per-call Stripe
  timeouts under lock only — no structural restructure; `tier-change.ts` has
  ~928 lines of uncommitted WS8 divergence), P9 (explicit BullMQ concurrency
  + in-process circuit breaker in the LLM task seam). Decisions locked; not
  in scope here.

## P1 — Guard `handleIngestFailed` against crashing the worker

**Problem.** `worker/jobs/zernio/ingest-failed-hook.ts:21-49` runs terminal
bookkeeping (`review_exceptions` INSERT, `markOutboxFailed`) with no
last-resort try/catch. It is wired as a bare `'failed'` listener at
`worker/index.ts:174`; a non-transient DB error there becomes an unhandled
rejection, and the crash-net treats non-transient/non-DB rejections as fatal
— one review's failure logging can kill all 30 queues.

**Fix.** Wrap the entire body in the same last-resort try/catch pattern as
its two siblings (`worker/jobs/publisher/failed-hook.ts:212-243` capture
pattern; `worker/jobs/judge/failed-hook.ts:66-140`): log via the module's
worker logger, capture to Sentry, never re-throw. (`logUnhandledPollError`
is a poller helper, not the right seam for a `'failed'` hook — the sibling
in-function wrap is the established template.)

**Test.** With a `sql` stub that throws, `handleIngestFailed` resolves
without rejection and captures to Sentry.

## P2 — Bound the Supabase admin/storage client

**Problem.** `src/lib/db/server.ts:67-70` creates `supabaseServer` with no
options — every `auth.admin.*` / `storage.*` call is unbounded. Only
`CleanupAbandonedSignupsPoller` self-defends (10s `Promise.race`); the
offboarding purge worker (`worker/index.ts:281-285`) can hang a BullMQ slot
forever while BullMQ auto-renews the lock.

**Fix.** Pass a bounded global fetch to `createClient`:
`global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) }`
with the 10s value as a named constant. **Scope: admin client only.** The
cookie-backed auth client (`src/lib/db/auth.ts`) is untouched — it runs
inside Vercel request handlers that already have execution timeouts.

**Test.** Unit test that the injected fetch attaches a timeout signal (or an
integration-style test with a never-resolving fetch stub rejecting within
the bound).

## P3 — Retry transient failures during the avoid-facts guardrail regen

**Problem.** The guardrail-regen catch (`worker/jobs/response-generation/generate-draft.ts:248-258`)
wraps every non-cost-cap error in a plain `Error`, and the outer catch
(`:166-177`) converts it to terminal `{ kind: 'failed', reason: 'guardrail_failed: …' }`.
An OpenAI 503 during the regenerate silently loses a draft the owner paid for.

**Fix (owner decision — overrides the documented anti-respend carve-out).**
Re-throw **all three** transient classes in the guardrail lane so BullMQ
retries the job: `TransientLLMError`, `ConcurrencyLimitExceededError`, and
`CostInfraUnavailableError`. Both catch layers (`:248-258` inner and
`:166-177` outer) must pass them through. Cost-cap errors
(`isCostCapError`) keep their existing handling; all other errors remain
terminal `guardrail_failed`.

**Accepted trade-off.** For `CostInfraUnavailableError` (Redis down), the
idempotent-generation cache may also be unavailable on retry, so a retry can
re-spend the primary generation — bounded by BullMQ's 3-attempt budget. The
owner explicitly accepted this over silently dropping paid drafts.
`.claude/CLAUDE.md:173` (the "stays terminal … anti-respend" gotcha) and the
inline comment at `generate-draft.ts:249-252` must be updated in the same
change to describe the new behavior and the accepted trade-off.

**Test.** Error-class matrix for the guardrail lane: each of the three
transients propagates out of the handler (BullMQ retry); cost-cap keeps its
current behavior; a violation-persists / generic error still returns
terminal `guardrail_failed`.

## P5 — `'error'` listeners on BullMQ Workers, Queues, and the probe Redis client

**Problem.** No `.on('error')` anywhere on the ~16 Workers
(`worker/index.ts:155-285`), the 30 Queues (`worker/queues.ts:45-74`), or
`queueProbeRedis` (`worker/index.ts:416-420`). An unlistened EventEmitter
`'error'` becomes `uncaughtException`, which is always fatal
(`worker/index.ts:641`). A transient Railway Redis blip can restart the
whole worker — inconsistent with the deliberate Postgres crash-net.

**Fix.** Attach `'error'` handlers to every Worker, every Queue, and the
probe Redis client, routed through `createWorkerLogger` + Sentry `warning`
with a tag identifying the emitter (queue/worker name, `probe_redis`).
Handlers must never throw. Implement as one small helper applied at the
registration sites (index.ts for Workers + probe, queues.ts for Queues) so
new registrations inherit it.

**Test.** Emitting `'error'` on a wired Worker/Queue/Redis stub logs +
captures and does not throw.

## P6 — Fastify ingress timeouts and body limit

**Problem.** `worker/index.ts:140` creates Fastify with only `logger` —
default `requestTimeout` 0 (disabled), no connection/keep-alive bounds, no
explicit body cap on the rawBody registration. Slow-loris / slow-body
connections can exhaust the single Railway worker and block Stripe/Zernio
webhooks.

**Fix (owner-selected values).**
`Fastify({ requestTimeout: 30_000, keepAliveTimeout: 60_000, connectionTimeout: 10_000, bodyLimit: 5 * 1024 * 1024, logger: {...} })`.
The 5 MB bodyLimit (up from the implicit 1 MB default) leaves headroom for
batch Zernio payloads while still bounding memory.

**Test.** Unit assertion on the server factory/options (extract options to a
testable constant if needed); manual staging smoke for webhook round-trips.

## P7 — Close health-alert blind spots

**Problem.** `worker/background/pollers/health-alert/checks.ts:45-66` only
watches `PUBLISH_RESPONSE` / `SEND_NOTIFICATION` failed-outbox topics.
Terminal `generate_response` failures and `inbound_events.status='failed'`
rows (Stripe/Zernio processing bugs, masked ~3 days by provider retries) are
invisible.

**Fix.**
1. Add `QUEUE_NAMES.GENERATE_RESPONSE` to the failed-outbox topic filter.
2. Add a new check for `inbound_events.status = 'failed'` within the lookback
   window (the partial index `idx_ie_status … WHERE status != 'processed'`
   already covers it), emitting through the existing `emitHealthFindings` →
   Sentry sink with source/event_type context. No schema change.

**Test.** Extend the health-check unit tests: seeded failed
`generate_response` outbox rows and failed `inbound_events` rows produce
findings; healthy state produces none.

## P10 — Dashboard degrades instead of hard-failing

**Problem.** `src/lib/dashboard/service.ts:67-81` runs 13 sub-queries in one
`Promise.all`; any single rejection 500s the entire dashboard via
`src/app/api/dashboard/route.ts:349-354`. The aggregate variant shares the
same all-or-nothing shape.

**Fix (owner decision).** Convert to `Promise.allSettled` in both the
per-location and aggregate paths. **Only the business lookup stays fatal**
(preserving `BusinessNotFoundError` semantics); the other 12 queries each
degrade to an empty/null per-widget fallback. Every degraded widget calls
`reportCaughtError` so failures remain visible in Sentry — degradation must
never be silent.

**Test.** Unit tests: one auxiliary query rejecting → response still renders
with that widget's fallback and the error reported; business lookup
rejecting → existing error semantics unchanged; all-healthy path
byte-identical to today.

## Testing & verification gate

Per-fix unit tests as above, then (all green before any review, re-run after
every fix round):

- `pnpm lint && pnpm typecheck && pnpm test`
- `pnpm ci:static-policy && pnpm ci:analytics-events`
- `pnpm ci:tenant-scope && pnpm ci:rls-audit` (P7 adds a cross-cutting
  `inbound_events` query; DB-touching)
- `pnpm build` (P10 touches `src/app`)

## Ship lane

RISK = high (worker + ingress). Ride `staging` first (push → full-stack
auto-deploy), smoke webhook ingress + dashboard + a generation cycle, then
PR to `main`, CI green, **pause for explicit owner merge approval**. No
migrations. After merge: ff-only pull `main`, fast-forward `staging`,
remove worktree, run the `document-feature` sweep.
