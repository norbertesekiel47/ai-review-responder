# RepWorth — Claude Code Context

## What this project is

Agentic reputation-management platform for SMBs, sold as **Copilot** (owner approves everything) and **Autopilot** (bounded autonomy) subscription tiers. Three customer personas — **Reply** (drafts every response; auto-posts positive-quadrant on Autopilot), **Guardian** (triage + escalation; never acts publicly), **Insights** (weekly digest) — supervised by two watchdogs: the **Judge** (LLM review of 100% of auto-posts; availability is a posting precondition) and the **Governor** (per-account autonomy suspension). Design of record: `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §8. Next.js 16 (Vercel, UI only) + Railway worker (Fastify + BullMQ, all LLM/external/long-running work) + Supabase/PostgreSQL + Redis(Upstash for Cache/Railway Redis for Queue).

Pipeline: Zernio webhook ingest → Guardian triage (`TRIAGE_ENABLED`, negative lane only) → AI draft → moderation → owner notification/approval, or gated `auto_policy` approval + veto window behind `AUTO_APPROVAL_ENABLED=true` → posted to Google → Judge verdict. Every persona action is recorded on the run spine (`agent_runs`/`agent_run_steps`/`agent_outcomes`) via the single writer `src/lib/agents/run-spine.ts`.

## Dev commands

- `pnpm dev` — Next.js (port 3000)
- `pnpm worker` — Railway worker via tsx (port 3001)
- `pnpm dev:all` — full stack (Next.js + worker)
- `pnpm worktree:new <branch> [base-ref]` — create an **isolated sibling worktree** outside the repo (own `node_modules`, copied `.env*.local`), then `cd` into the printed path. Use this for parallel feature branches; see "CI & repo" for why sibling not nested.
- `pnpm test` — Vitest unit + integration
- `pnpm test:watch` — Vitest watch
- `pnpm test:integration` — **hard-gates only the publisher edit-existing-reply suite** (fails fast without `TEST_DATABASE_POOL_URL`); other integration suites run only when invoked directly — see gotcha below
- `pnpm test:db:setup` — provision the local test DB to migrations head (bootstrap + every migration, local-only, drops schema `public` first). Run it once after creating the container and again whenever a migration lands: live-DB suites **assert** their schema (`assertSchemaReady`) instead of applying migrations, so a behind-head DB fails loudly rather than self-healing.
- `pnpm test:e2e` — Playwright E2E (skips gracefully without TEST_DATABASE_POOL_URL)
- `pnpm lint` — ESLint
- `pnpm eval:llm` — LLM safety eval harness (offline/keyless by default; `--live` needs provider keys)
- `pnpm ci:*` — the CI audit scripts. The `ci:` entries in package.json are the authoritative list; do not keep a second copy of it here. Wiring, enforced by `src/__tests__/ci-audit-wiring.test.ts` (#590): the `lint` CI job runs every one of them **except** `ci:fallow:coverage`, which runs in its own `fallow.yml` job, and `ci:fallow`, which is the developer-facing sweep and gates nothing; `lefthook.yml` mirrors every audit the `lint` job runs. `ci:static-policy` enforces invariants #10, #13, #14; `ci:live-db-suites` enforces the two live-DB test conventions (see the gotcha below); `ci:outbox-status` enforces the `job_outbox` in-flight status vocabulary (invariant #2).
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass all external APIs locally

## CI & repo

- Repo **`RepWorth/ai-review-responder`**; `main` is protected — **land changes via PR**, direct pushes rejected.
- CI (`.github/workflows/ci.yml`): `lint` (also runs the `ci:*` audit scripts — see "Dev commands" for which, and `src/__tests__/ci-audit-wiring.test.ts` for the check that keeps package.json, the workflows, and `lefthook.yml` from drifting apart), `typecheck`, `test`, `llm-eval` (path-filtered LLM-safety eval release gate — WS7), `build` on every PR + push to `main`. `MOCK_EXTERNAL_APIS=false` in CI — `true` short-circuits Zernio transport and breaks real-path tests. Third-party actions pinned to commit SHAs.
- **Local pre-push hook (`lefthook.yml`)** runs the cheap CI subset before code leaves the machine — lint, typecheck, every CI audit, and affected tests (`vitest --changed`), in parallel. Same commands as CI; CI stays the full-suite gate. Installed via the `prepare` script on `pnpm install`. Escape hatch for WIP: `git push --no-verify`.
- **Worktrees: sibling (blessed) vs nested (footgun).** Use `pnpm worktree:new <branch>` (→ `scripts/new-worktree.sh`) — it creates the worktree *outside* the repo at `../RepWorth-worktrees/<branch>/` with its own `node_modules` + copied `.env*.local`, so local lint/test/typecheck and the pre-push hook give a trustworthy signal. Do NOT use a *nested* worktree (`.claude/worktrees/`, `.worktrees/`): Node's upward `node_modules` resolution and ESLint's upward config cascade leak the parent's deps/config in, poisoning local CI — if you're stuck in one, push and read the runner instead. The harness `EnterWorktree` tool and Agent `isolation:'worktree'` both create *nested* worktrees, so they inherit that caveat (fine for edit+typecheck agents, not for trustworthy full CI). Either way, every Write/Edit path must point at the worktree root (`…-worktrees/<branch>/…` or `.claude/worktrees/<name>/…`), never the parent checkout, or the edit silently lands in `main`'s tree (now also hook-enforced in the worktree→elsewhere direction by `edit-surface-guard.sh`). **Cleanup:** first confirm the branch's PR is merged (`gh pr list --head <branch> --state merged` — squash merges make `git branch --merged` useless) and the tree is clean, then remove each worktree individually: `git worktree remove <path>`, then `git branch -D <branch>`. One at a time, no `--force` — each removal stays reviewable.

## Environments & branches

Trunk-based: `main` is the source of truth. Two long-lived branches — `main` (prod) and `staging` (integration anchor for the persistent staging env); "preview" is any open PR's auto-deploy, not a branch. Topology, URLs, concrete IDs: `docs/runbooks/deployment-guide.md`.

- **Three lanes.** *Preview* — per-PR, Vercel UI only (no worker/queue/webhooks → frontend checks only). *Staging* — persistent full stack, test/sandbox creds + separate Supabase; **the only non-prod place the whole pipeline runs**. *Production* — `main`, live creds.
- **Promotion = merge the PR into `main`.** `staging` is not a promotion gate — never "merge `staging` → `main`". Anything touching the worker, a webhook, a migration, or billing rides `staging` first, then lands on `main` via PR.
- **After promotion, fast-forward `staging` onto `main`** (`git merge --ff-only main`) so it never drifts. Migrations run against **both** Supabase projects in lockstep, **staging first**; "applied to prod, not staging" is a bug. **Standing exception until the prod WS8 cutover:** migration 078 is deliberately absent in prod — it applies *inside* the cutover (`docs/runbooks/ws8-tier-cutover.md`); do NOT apply it out-of-band. All autonomy flags are OFF in prod; ordered go-live flip per design doc §8.4.
- **Push to `staging` auto-deploys the full staging stack.** Both the Railway staging worker **and** the Vercel staging Custom Env redeploy on push (the Vercel deploy is git-sourced `target:staging`; verified 2026-06-02). Vercel previews still auto-deploy per PR. To rebuild the staging UI without a push, deploy the custom env explicitly (`POST /v13/deployments` with `target:"staging"` + `gitSource:{ref:"staging"}`) — see `deployment-guide.md` Phase 3.
- **CI gates PRs + push-to-`main`, NOT `staging` pushes** — rely on the PR's CI before promoting.
- **Local `main` lags after GitHub squash-merges** — `git pull --ff-only` (then `pnpm install` if deps changed).

## Architecture invariants — NEVER violate these

1. **Vercel = UI only.** LLM calls, external API calls, and long-running operations run on Railway workers, never in Next.js routes. Exception (ADR 0001): Next.js routes may make short, user-blocking OAuth-handshake calls when they must set/clear cookies or return a redirect synchronously (Zernio connect callback + select-location). Durable recovery and long-running work stay on Railway. ESLint-enforced: `src/app/**`, `src/components/**`, and `src/instrumentation.ts` may not runtime-import `openai`/`@anthropic-ai/sdk`/`bullmq`/`postgres`/the response generator/the worker queue registry (type-only `import type` allowed; tests exempt); guarded by `src/__tests__/eslint-boundaries.test.ts`.

2. **Transactional outbox.** State change + follow-up work go in ONE Postgres transaction via `job_outbox`. Never write Postgres then separately enqueue BullMQ — silent data loss on enqueue failure.

   > Enqueue via a typed helper for a NEW single-row topic. Raw `INSERT INTO job_outbox` is sanctioned for: set-based `INSERT … SELECT … FROM` fan-out; a dedup/payload variant the helper does not model; a topic with no helper (18 of 32 topics today — do not backfill on spec). The in-flight status set is guarded by `ci:outbox-status`.

   > **A topic that HAS a helper must use it** — a single-row raw INSERT for a helper-owned topic fails `ci:outbox-seam` (#568). Helper coverage is derived from `job-outbox-helpers.ts` itself, so writing `enqueueNotifyAdmin` turns all 6 raw `NOTIFY_ADMIN` sites red until they migrate in that same PR; a topic never has two live enqueue owners. Escape hatch is a per-line `-- outbox-seam-ignore: <reason>` (one use today). "Fan-out" means a row-producing top-level `FROM`, NOT merely containing `SELECT` — `enqueueValidatePlaceId` is itself an `INSERT … SELECT … WHERE NOT EXISTS` that inserts one row.

   The in-flight set `('pending', 'dispatching', 'dispatched')` is a **byte-for-byte contract** owned by `src/lib/shared/job-outbox-status.ts`, not a value to re-derive. It cannot be parameterized — a bind parameter inside an `ON CONFLICT … WHERE` defeats partial-index inference — so every site re-spells it by hand and `ci:outbox-status` checks members **and order**. Migration 018 exists solely because 004 shipped it missing `'dispatching'`.

3. **No unapproved posting.** A response may reach Google only after an explicit approval method is recorded: `approval_method='owner'` from an owner action, or `approval_method='auto_policy'` from the server-only auto-approval runtime. Auto-policy approval is disabled by default (`AUTO_APPROVAL_ENABLED=false`) and is allowed only for `live_ingest_new` v1 jobs that pass current-state, subscription, active-location/connection, review-hash, policy-threshold, provider-moderation, and triage-veto gates — plus the trust dial (rating band + daily cap), the 15/30-min veto window, and the **Autopilot tier** (`tierGrantsAutopilot`). **Judge availability is a posting precondition:** `JUDGE_ENABLED=false` or judge unavailability makes `ResponsePublisherWorker` downgrade unposted auto-policy rows to owner review — same as flipping the runtime flag off before publish.

   > Auto-approval skips only the owner step. Moderation remains an absolute veto; high-severity drafts are held and never auto-approved.

4. **High-confidence unsafe drafts are held, not notified.** After generation `ResponseGeneratorWorker` runs `moderateResponse`; a `high`-severity flag writes a `flagged_responses` row (admin-only deny-all RLS) and skips the `send_notification` enqueue in the SAME transaction as response persistence. Re-notify only via admin `approved_for_owner_review` at `/admin/flagged`. Full flow (admin actions, `api_costs` metadata, `OPENAI_MODERATION_ENABLED` fail-open, local regex filter): the `approval-security` skill.

5. **Approval tokens never stored raw.** Only SHA-256 hashes in `approval_links`. Raw tokens exist only in memory and in the approval link sent over the owner's notification channel — never in Postgres, outbox payloads, or logs.

6. **Third-party ingress terminates on Railway.** Stripe, Resend, Twilio, Zernio webhooks hit `worker/ingress/*`. Do NOT proxy through Next.js except in local dev with an explicit comment.

7. **ReviewSource contract.** All sources normalize to `NormalizedReview` DTO. No source-specific fields leak into the prompt builder.

8. **Auth scope is app-enforced.** `users.auth_id` maps to Supabase Auth identity. Browser code never receives `SUPABASE_SERVICE_KEY`. Every owner read/write scoped by `account_id` (billing parent) and, per-location, `business_id` (= one Google Business Profile location).

9. **`businesses` row = location; `accounts` row = billing parent.** Don't re-introduce subscription columns on `businesses`. Two sub-rules: (a) billing snapshot reads STORED quota + price from `accounts` (`locations_included`, `locations_overage_price_cents`, `base_price_cents` — point-in-time, grandfathered via migration 054), not live `TIER_CONFIG` values; (b) multi-location settings use three distinct checks — `shouldUseMultiLocationSettings` (mode: count > 1), `shouldShowLocationsSettings` (visibility: flag only), `canAddLocationForAccount` (eligibility: flag + active + `multiLocAllowed`) — never collapse to one boolean.

10. **Use Node.js native crypto.** `import { createHash, randomUUID } from 'node:crypto'`. Never `crypto-js` (CI-enforced: `ci:static-policy`).

11. **Subscription guard in all customer-facing workers.** Check status early: `cancelled` → no-op; `past_due` → 7-day grace; `pending_payment` → NotificationWorker and ResponsePublisherWorker skip (ResponseGenerator allowed for admin demo drafts); `trialing` (card-up-front 30-day trial, migration 069, flag `TRIAL_ENABLED`) → **full access, treated like `active`** everywhere EXCEPT recurring paid ranking tracking (SerpAPI stays active-only). Gate entitlement on `subscriptionGrantsFullAccess(status)`, never a raw `=== 'active'`. Stripe is the source of truth — `worker/ingress/stripe/apply-subscription-state.ts` is the single status applier.

12. **Entry points orchestrate; modules own failure behavior.** Route handlers, worker boot files, and ingress handlers may validate, orchestrate, and map errors — extract any error-handling branch over ~30 lines into a named module with focused tests.

13. **Feature flags are server-authoritative.** The browser learns flag state via API responses. Never add a `NEXT_PUBLIC_*` companion for a feature flag — `ci:static-policy` allowlists every `NEXT_PUBLIC_*` and fails CI on any new one.

14. **Auto-approval policy access is server-owned.** Browser/client code never reads or writes `auto_approval_policies` directly through Supabase. Owner settings must flow through server routes, and `ci:static-policy` blocks client components that reference the table.

15. **Domain modules receive their DB client as an explicit parameter.** Business-logic modules under `src/lib/**` and worker helpers take `sql: Sql` / `supabaseServer` (or `tx: TransactionSql` inside a transaction) as an explicit parameter — they never import `@/lib/db/server`. Only **composition roots** import the singleton and pass it down: route handlers (`src/app/**/route.ts`), server-component pages/layouts, `worker/index.ts`/`queues.ts`, worker job handlers + pollers/schedulers **registered in `worker/index.ts`** (root status is derived from that registration, not file position), ingress, `src/lib/db/server.ts` (the owner) and `src/lib/db/auth.ts` (the owner-classified auth gate). CI-enforced strict by `ci:db-imports` (`scripts/ci/db-imports-audit.ts`) — baseline deleted, any non-root importer fails. `jsonb(x)` is composition-root-only; domain modules use `tx.json(x)`.

## Where things live

Detailed inventories load on demand — read the matching file before the work:

| Before you… | Read |
|---|---|
| write or debug a migration / touch schema | `.claude/reference/migrations-log.md` |
| add an env var or flip a feature flag | `.claude/reference/env-vars.md` |
| touch review ingestion / add a ReviewSource | `.claude/reference/review-ingestion.md` |
| touch the **agentic platform** (run spine `agent_runs`/`agent_run_steps`/`agent_outcomes`, personas Reply/Guardian/Insights, triage, trust dial + veto window, judge, governor, Copilot/Autopilot tiers) or **plan Phase 2 (run engine + Solicitation agent)** | design of record `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` — **§8 As-built status is the entry point** (what shipped WS1–WS8, deltas, gates, what's deliberately unbuilt) → per-WS specs in `docs/superpowers/specs/2026-07-*-ws*-design.md` + WS1 plan `docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (has the WS1–WS8 decomposition) + staging proof in `docs/runbooks/evidence/2026-07-2*-agentic-*.md` |
| build or debug owner offboarding (cancel_only / delete_data / purge) | spec `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md` + runbook `docs/runbooks/owner-offboarding-staging-dry-run.md` |
| build or debug multi-location (locations lifecycle, per-location overage billing, account-level digests, channel overrides) or run the two-location full-loop | spec `docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md` + plan `docs/superpowers/plans/2026-06-09-multi-location-hardening.md` + runbook `docs/runbooks/multi-location-e2e-full-loop.md` |
| roll out / test the Telegram + WhatsApp channels, the auto-approved post FYI (`auto_post_notice` topic, `worker/jobs/auto-post-notice/`), or its `/r/google/<id>` redirect | runbooks `docs/runbooks/channels-rollout.md` (prod flip) + `docs/runbooks/channels-staging-smoke-test.md` (staging test) + `docs/runbooks/whatsapp-templates.md` (template content) + ADR `docs/adr/0003-conversational-channel-seams.md` (future-agent seam) |
| touch a named library/subsystem (Postgres.js, Zernio, Stripe, Supabase auth, Vercel BotID/WAF, …) | `.claude/reference/lab-notes.md` |
| deploy, promote, or reason about the preview/staging/prod split | `docs/runbooks/deployment-guide.md` |
| harden bot-protection / edge rate-limiting / WAF / Attack Mode | runbook `docs/runbooks/vercel-waf-rate-limiting.md` + `src/lib/security/botid*` + ADR `docs/adr/0002-botid-server-check-carveout.md` |
| build/debug worker health alerting, the `HealthAlertPoller`, or the `SENTRY_DSN` boot gate (`assertAlertSinkEnv`) | runbook `docs/runbooks/beta-launch-alerting.md` + ADR `docs/adr/0005-beta-launch-posture.md` + `worker/background/pollers/health-alert/` |
| verify a spec / plan / launch doc against the codebase, or answer "what's remaining" on a checklist | invoke the `verify-spec` skill — evidence table + mandatory `VERDICT: PASS/FAIL` |

Patterns to follow (invoke as Skills): `outbox-pattern`, `approval-security`,
`cost-guard`, `onboarding-demo-cost-guard`, `new-migration` (before any
`supabase/migrations/` file), `flag-flip` (before changing any feature-flag
env var). Also invoke: `repworth-brand-design`
(any RepWorth UI), `supabase:supabase-postgres-best-practices` (Postgres query/schema perf).

Code map: `docs/directory.md` · Layout reasoning: `docs/currents.md` ·
ADRs: `docs/adr/` · Ops runbooks: `docs/runbooks/`.

## Tech stack (non-obvious choices)

- **Two Postgres clients**: `postgres` (Postgres.js) for transactional writes; `@supabase/supabase-js` for auth/storage/reads. Do not collapse them.
- **Two Redis instances, different providers**: BullMQ queue on **Railway Redis** (private net, per-env — not the cache); cache on **Upstash** (TLS, Vercel-reachable — not the source of truth). Split to kill Upstash egress; full why in `deployment-guide.md` §1.4.
- **LLM**: `gpt-4o-mini-2024-07-18` primary, `claude-haiku-4-5-20251001` fallback — pinned IDs, never bare aliases. All LLM calls route through the **`src/lib/llm/` task seam**: `runLlmTask(taskId, prompt)` is the single executor (primary + fallback + transient/terminal classification + the per-provider circuit breaker `src/lib/llm/circuit-breaker.ts`, default-ON kill switch `LLM_CIRCUIT_BREAKER_ENABLED`), with per-task pinned models in the `LLM_TASKS` registry (`src/lib/llm/tasks.ts` — `OPENAI_MODEL`/`ANTHROPIC_MODEL` constants, guarded by `model-pinning.test.ts`). Both reply generation (`src/lib/responses/generator.ts`) and review-insight summaries (`src/lib/responses/review-summary.ts`) are tenants; the only completion calls live in the seam adapters (`openai-provider.ts`/`anthropic-provider.ts`). Prompt policy + version hash: `src/lib/responses/prompt-policy.ts`, recorded on every `api_costs` row.
- **Stripe**: one shared client factory `src/lib/payments/stripe-client.ts` (`getStripe()`) — pinned `apiVersion` + bounded `timeout`/`maxNetworkRetries`. Never `new Stripe()` elsewhere; every call site imports from it. The pin governs **outbound** calls only — webhook payload shapes follow the Stripe Dashboard **endpoint** version (keep them in lockstep). `STRIPE_TAX_ENABLED` (server-only, default off) gates `automatic_tax` on checkout. Tier prices are grandfathered (stored on `accounts`, invariant #9a) — change them via the procedure in `env-vars.md`, never edit a Stripe Price `unit_amount` (immutable → new Price).
- **JSONB via Postgres.js**: use `jsonb()` helper (`sql.json(value)`, OID 3802). `${JSON.stringify(x)}::jsonb` double-encodes in Postgres.js v3.
- **Package manager**: pnpm.
- **Analytics**: PostHog (`posthog-node`) worker/server-only via `src/lib/analytics/posthog.ts`. No-op when `POSTHOG_API_KEY` unset; flushed on shutdown. Browser/Next.js code never calls PostHog directly — client intent events POST to `/api/analytics/enqueue` (gated to `CLIENT_ENQUEUEABLE_EVENT_NAMES`; durable facts are NOT client-postable), durable events insert server-side, `AnalyticsDispatchPoller` ships them. Idempotency via `event_key` + `ON CONFLICT`.
- **Structured logging**: `createWorkerLogger(prefix, correlationId)` emits one JSON object per line (`src/lib/shared/logger.ts`). Per-request/job IDs via `AsyncLocalStorage` (`src/lib/shared/log-context.ts`). Never log raw review/response text, tokens, secrets, or MFA codes — object args pass through the analytics blocked-key sanitizer; string args are logged verbatim.
- **Audit writes**: account-status changes go through `src/lib/audit/log.ts` (`writeAccountAuditLog`) in the SAME transaction — never raw `INSERT INTO account_audit_log`.

## Worker layout

`docs/directory.md` is the full file map — this lists only the conventions that
decide *where new worker code goes*:

- **Job handlers** in `worker/jobs/`: one top-level `*.ts` per worker, plus a
  per-domain subfolder when a worker has helpers (`response-generation/`,
  `notification/`, `auto-post-notice/`, `publisher/`, `zernio/`, `billing/`,
  `onboarding-demo/`, `account-offboarding/`, `judge/`, `escalation-notice/`,
  `autonomy-suspended-notice/`, `pending-post-notice/`, `csv-ingest/`,
  `solicitation-batch/`).
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
  + per-provider subfolders (`stripe/`, `twilio/`, `telegram/`, `zernio/`).
- **Boot-time env assertions**: `worker/config/startup-assert.ts`; **Fastify ingress bounds**:
  `worker/config/fastify-options.ts` (`buildFastifyOptions` — requestTimeout/keepAlive/connection/bodyLimit).
- **Sentry init + scrubber**: `worker/sentry.ts` (imported for side effect by `index.ts`).
- **Non-fatal emitter `'error'` sink**: `worker/emitter-errors.ts` (`attachEmitterErrorLogger`
  — every BullMQ Queue/Worker + raw Redis client gets a listener at its registration site;
  an unlistened `'error'` is a fatal `uncaughtException`).
- **Queues**: `worker/queues.ts`; **Redis connection options**: `worker/redis-connection.ts`
  (side-effect-free — unit-testable without booting the queues).
- **Entry point** `worker/index.ts`: pure registration + lifecycle, **no DB writes**.

## Database

- **Schema + migrations** → `.claude/reference/migrations-log.md` (authoritative): base schema (`001_initial_schema.sql`), current head / next number, and the UUIDv7 time-ordered-PK convention. Read it before any migration.
- **Review sentiment**: `reviews.sentiment_*` populated by `classifySentiment` (`src/lib/reviews/sentiment.ts`, deterministic star-based `deterministic_star_v1`) at all review-content write sites; status-only writes don't touch it.
- **Customer KPIs**: `src/lib/kpi/*` (`DashboardKpiSummary` — response rate, avg star, review-volume MoM, avg time-to-respond, 8-week sentiment trend); per-location or per-account; served by `GET /api/dashboard/kpis`.
- **Finance/margin signals**: admin-only, aggregate-on-read from `api_costs` via `src/lib/admin/margin-service.ts`. Cross-account queries intentionally allowlisted in tenant-scope audit.

## Non-obvious gotchas — read before touching related code

- **Postgres.js + PgBouncer can return JSONB as strings.** Guard: `typeof x === 'string' ? JSON.parse(x) : x`, then narrow the result. This is the *only* sanctioned exception to repworth.md's "no `any`" (never paper over it with `: any`). **Explicit allowlist — exactly 16 production JSONB field-to-parser sites today:**
  - `job_outbox.payload` (2): `worker/background/pollers/OutboxPoller.ts`; `src/app/api/dashboard/past-replies/draft-status/route.ts`.
  - `businesses.tracked_keywords` (1): `src/lib/admin/business-detail/mappers.ts` (the `trackedKeywords` call through `parseDbArray`; its sibling calls parse `TEXT[]`, not JSONB). `RankingTrackingWorker` no longer parses this column — it reads the primary keyword via `primaryTrackedKeywordSql` (#572), which resolves it in SQL.
  - `accounts.flags` (2 shared parser sites): `src/lib/shared/past-due-recovery.ts`; `worker/background/pollers/billing-reconciliation/account-flags.ts`.
  - Demo snapshots (4): `prospect_demos.reviews_snapshot` + `.generated_responses` in `src/app/(public)/demo/[slug]/page.tsx`; the same two `onboarding_demos` fields, server-projected into `src/app/onboarding/demo/PaywallWithDemoClient.tsx`.
  - Run spine (2): `agent_runs.error` + `agent_run_steps.detail` in `src/lib/agents/read.ts`.
  - One each (5): `analytics_events.properties` in `worker/background/pollers/AnalyticsDispatchPoller.ts`; `review_exceptions.payload` in `worker/jobs/AdminExceptionWorker.ts`; `account_offboardings.provider_dispositions` through the shared parser in `src/lib/account-offboarding/provider-disposition.ts`; `contact_csv_uploads.report` through the shared parser `parseIngestReportValue` in `src/lib/solicitation/ingest.ts` (consumed by `getUploadStatus` in `uploads.ts` and the worker's terminal-status re-read); `solicitation_asks.evidence` through `parseEvidence` in `src/lib/solicitation/batch-view.ts` (the Requests read model — a non-object or discriminant-less value throws rather than rendering a blank spoilage row).
  Any new production JSONB field-to-parser site must be added here. Do **not** add HTTP/request bodies, provider responses, LLM output, Redis/cache/connect-state values, local storage, JSON structured clones, or `TEXT[]` reads — those are different parsing boundaries, not this PgBouncer JSONB carve-out.
- **BullMQ rejects `:` in job IDs** — OutboxPoller uses `_` separator.
- **PgBouncer `statement_timeout` ~8s** — set `statement_timeout: 30_000` on Postgres.js client (OutboxPoller CTE exceeds the default).
- **`ON CONFLICT` must match partial-index predicate BYTE-FOR-BYTE** or Postgres won't recognize the constraint. Expression indexes must use IMMUTABLE expressions: `(created_at AT TIME ZONE 'UTC')::date`, not `created_at::date` (STABLE is rejected in index predicates).
- **Zernio `account.disconnected` payload** uses nested `account.id`, not flat `accountId`. Read `body.account?.id`.
- **`SELF_SERVE_SIGNUP_ENABLED`**: confirmation template must use `{{ .Token }}` (6-digit OTP), NOT `{{ .ConfirmationURL }}`. Reset/invite links need `&amp;` not `&` in `href` attributes.
- **`CleanupAbandonedSignupsPoller`**: re-validate ALL predicates inside the tx with `SELECT FOR UPDATE`. `deleteUser()` is irreversible and non-transactional.
- **Supabase `signUp()`** returns `identities: []` for already-confirmed emails (anti-enumeration). Detect before `createBusinessTx`.
- **`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`** required for PlaceAutocomplete. Use only Essentials-tier fields: `id + formattedAddress + location`. Do not use `displayName` (Pro tier).
- **Google Maps URLs use hex CIDs** (`0x...:0x...`), not canonical Place IDs. Resolve via PlaceAutocomplete or SerpAPI, never `data_id`.
- **Owner channel enrollment org-default is account-scoped** — keyed by `account_id` + `channel` + `location_id IS NULL`. `business_id` is a legacy FK written on INSERT but NOT used for org-default lookup. All cancel/disable enrollment helpers take `accountId`.
- **`SELECT … FOR UPDATE` is a no-op outside `sql.begin()`** — Supabase PgBouncer (transaction pooling) drops the row lock the instant the SELECT returns, so it never spans the following work. Either wrap the whole flow in `sql.begin()`, or drop the lock and use provider-side idempotency keys.
- **The worker is single-replica by invariant, and that is DETECTED, not enforced.** Four boot guards (`assertSingleConcurrencyWorker`, `assertSummedLlmWorkerSlots`, overage OVERAGE-F1) plus the in-process LLM circuit breaker are only correct with one replica, and the P2 pollers in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md` become duplicate-processing bugs with two. `ci:static-policy` blocks `numReplicas`/`multiRegionConfig` in `railway.toml` (config-as-code overrides the dashboard, so that is the one path a static check can block), and every boot logs + Sentry-tags `replica_id`/`deployment_id` via `worker/config/replica-identity.ts`. Railway injects a per-replica id but **no replica count**, so no process can assert it is alone — scaling up starts a new replica without redeploying the existing one, so **two `replica_id`s under one `deployment_id` is the signal**. A dashboard-set replica is not prevented; clear the P2 list first. **The signal is now acted on (#587):** each replica registers in Redis under a TTL every `HealthAlertPoller` cycle, and the poller pages when >1 is live — immediately for replicas sharing a `deployment_id` (scale-out), or after a 2-cycle grace for a cross-deployment overlap (so a normal zero-downtime deploy does not page). `worker/background/pollers/health-alert/replica-cardinality.ts`. Deliberately a registry, NOT a boot-gating lease: a Redis outage must degrade to "no replica alerting", never to a worker that will not start — the check carries its own log-and-swallow `try/catch` for exactly that reason.
- **Railway private network is IPv6-only** — `ioredis`/BullMQ won't resolve `*.railway.internal` unless `family: 0` is set (`worker/redis-connection.ts` parses `?family=`). Works on local/Upstash, silently fails to connect on Railway without it.
- **Best-effort work after a worker's primary side effect needs its own `try/catch` (log-and-swallow)** — a secondary failure (telemetry, Sentry, cost-threshold check) caught by the outer handler flips an already-completed job to `failed`. Never let observability poison the success path.
- **postgres.js decodes `timestamptz` into a JS `Date` — Postgres MICROSECONDS are silently truncated to milliseconds.** Any SQL comparison against a value that round-tripped through JS can mis-order by <1ms; fatal when a row is compared against a window/anchor derived FROM that same row (governor permanent re-suspension immunity #520; wedge-reaper `backend_start` equality before it). Truncate the DB side (`date_trunc('milliseconds', col) > ${jsDate}`) or keep the value `::text` end-to-end. JS-Date-seeded test fixtures carry zero µs and CANNOT catch this — seed with `+ interval '419 microseconds'`.
- **A live-DB suite must be named `*.integration.test.ts` and must NOT apply migration SQL.** The name is what puts it in vitest's serialized `integration` project; a suite that misses the glob runs in the fully parallel project against every other live-DB writer. Run-time DDL takes ACCESS EXCLUSIVE locks that deadlock (40P01) against a sibling suite's row locks whenever the two run in **concurrent vitest processes** — which `verify-gate.sh` creates every time the intake declares a `pnpm test <file>` verification command, since vitest's serialization is per-process only. Provision once with `pnpm test:db:setup`; assert with `assertSchemaReady` (`src/lib/shared/__tests__/helpers/schema-ready.ts`, which also owns the migration→objects map). Migration-**shape** suites are the sanctioned exception and must both hold the cross-process lock (`acquireLiveDbLock`, `helpers/live-db-lock.ts`) and roll back any unconditional re-apply — a committed re-apply of an OLD migration silently reverts a later one on the shared DB. CI-enforced: `ci:live-db-suites`. Full mechanics: lab-notes "#573".
- **`pnpm test:integration` hard-gates only the publisher edit-existing-reply suite.** Other live-DB integration suites (e.g. the governor scheduler's) exist but run only when their file is invoked directly — an existing-but-not-run suite is how #520 shipped. When touching governor/judge/publisher paths, run the matching integration file explicitly with `TEST_DATABASE_POOL_URL` set.
- **The worker crash-net RECOVERS from transient-DB `unhandledRejection`s; it does NOT blanket-crash.** `worker/index.ts` classifies via `isCrashNetRecoverableDbError` (strict allowlist — keep it distinct from billing's broad `isTransientPostgresError`): transient Postgres rejections are survived (Sentry warning; sustained storms escalate to crash via `worker/transient-rejection-governor.ts`); everything else fails fast and `uncaughtException` is ALWAYS fatal. Never reintroduce blanket crash-on-any-rejection. Full mechanics: lab-notes "Worker crash-net".
- **API rate limits fail OPEN by design; the worker's Redis cost RESERVATION precedes every LLM call, so spend stays safe even when a limiter is bypassed.** Pre-LLM Redis **transport** failures are RETRYABLE (`CostInfraUnavailableError` → BullMQ retry + outbox watchdog; #255 — do not re-terminalize); **budget-exceeded** decisions stay TERMINAL (never reclassify as infra); post-LLM finalize failures are governed by `withCostGuard`'s `onFinalizeError`, never a job-level retry (would re-spend). Do NOT "fix" the limiters to strict. Upstash is a single-instance **SPOF** (cache + rate-limit + cost-reserve + regen-budget + idempotent-generation). Full touchpoint/retry matrix: lab-notes "Cost-guard fail-open/retry matrix".

## Codebase intelligence

### codebase-memory-mcp — structural queries

Prefer graph tools over Grep/Glob for structural code questions.
Graph = one tool call (~500 tokens) vs file-by-file (~80K tokens).

**Workflow:** `list_projects` → check freshness → `index_repository` if stale → `get_graph_schema` before complex Cypher → `search_graph` / `trace_call_path` → `get_code_snippet(qualified_name)`.

**Use for:** "Who calls X?", call chains, dead code, HTTP_CALLS cross-service links, REST routes, fan-out analysis.
**Use grep/Glob for:** string literals, error messages, config values.

### graphify — semantic + design orientation

Read `graphify-out/GRAPH_REPORT.md` before answering architecture or design questions. Use `/graphify query "..."` for focused subgraph pulls — never dump `graph.json` whole into context.

| Question | Tool |
|---|---|
| "Who calls X?" / call chains / dead code / HTTP links | codebase-memory-mcp |
| "Why was this designed this way?" / god nodes / architecture | graphify GRAPH_REPORT |
| Text/string search | grep/Glob |

## MCP servers & CLIs

**MCP servers** — load tool schemas via ToolSearch before calling; prefer the MCP over the matching CLI when both fit (structured results).

| MCP | When |
| --- | --- |
| **Supabase** | DB queries, migrations, data debugging (remote HTTP MCP — auth before first use). For DB WRITES prefer `execute_sql` over inline `psql` one-liners — structured results and fewer shell-permission prompts |
| **Railway** | Worker infra — deploys, logs, metrics, env vars, services |
| **Stripe** | Billing inspection — Prices, subscriptions, events (remote HTTP MCP — OAuth via `/mcp` before first use) |
| **Vercel** | Frontend deploys, build logs, project status (remote HTTP MCP — auth before first use) |
| **codebase-memory** | Structural code questions — who-calls-X, call chains, routes, dead code |
| **Context7** | Library/framework docs (BullMQ, Resend, Stripe, Next.js) before implementing |
| **claude-mem** | "Did we solve this before?" — cross-session memory / observations |

Playwright (E2E via `pnpm test:e2e`) and Sentry (`@sentry/*` SDK + `worker/sentry.ts`) are **not** MCPs. Per-developer personal MCPs (Gmail, Drive, Calendar) may also be connected; not project tools.

**CLIs** (in Bash):

- **Git/CI**: `git`, `gh` (PRs, issues, CI runs + logs)
- **Platform**: `vercel`, `railway`, `supabase`, `stripe` (webhook test + event replay), `gcloud`
- **Data/infra**: `psql` (Postgres direct), `redis-cli` (cache/queue), `docker`
- **Runtime/utils**: `node`, `pnpm`, `npx`, `tsx` (via pnpm/npx — not global), `rg`, `jq`, `curl`, `python3`
