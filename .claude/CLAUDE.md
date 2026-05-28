# RepWorth — Claude Code Context

## What this project is

Automated Google review response service for SMBs. Next.js 16 (Vercel) +
Railway worker (Fastify + BullMQ) + Supabase/PostgreSQL + Upstash Redis.
Reviews ingested via Zernio webhooks; responses require explicit owner
approval before posting.

## Dev commands

- `pnpm dev` — Next.js (port 3000)
- `pnpm worker` — Railway worker via tsx (port 3001)
- `pnpm dev:all` — full stack (Next.js + worker)
- `pnpm test` — Vitest unit + integration
- `pnpm test:watch` — Vitest watch
- `pnpm test:e2e` — Playwright E2E (skips gracefully without TEST_DATABASE_POOL_URL)
- `pnpm lint` — ESLint
- `pnpm eval:llm` — LLM safety eval harness (offline/keyless by default; `--live` needs provider keys)
- `pnpm ci:tenant-scope` — tenant-scope audit
- `pnpm ci:rls-audit` — RLS audit
- `pnpm ci:analytics-events` — analytics events audit
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass all external APIs locally

## CI & repo

- Repo: **`RepWorth/ai-review-responder`** (org, Team plan). `main` is protected — **land changes via PR**; direct pushes are rejected.
- CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test`, `build` on every PR + push to main. `MOCK_EXTERNAL_APIS=false` in CI (NOT true — `true` short-circuits Zernio transport and breaks real-path tests). Third-party actions pinned to commit SHAs.
- Never validate CI from a git worktree nested inside the repo — module resolution leaks into parent `node_modules`/eslintrc and poisons lint+test. Push and read the runner, or clone clean.

## Architecture invariants — NEVER violate these

1. **Vercel = UI only.** LLM calls, external API calls, and long-running operations run on Railway workers, never in Next.js routes. Exception (ADR 0001): Next.js routes may make short, user-blocking OAuth-handshake calls when they must set/clear cookies or return a redirect synchronously (Zernio connect callback + select-location). Durable recovery and long-running work stay on Railway.

2. **Transactional outbox.** State change + follow-up work go in ONE Postgres transaction via `job_outbox`. Never write Postgres then separately enqueue BullMQ — silent data loss on enqueue failure.

3. **No auto-posting.** There is NO code path from response generation to Google posting without an explicit owner approval step. Make it architecturally impossible to bypass.

4. **High-confidence unsafe drafts are held, not notified.** `ResponseGeneratorWorker` runs `moderateResponse` (`src/lib/moderation/*`) after generation; a `high`-severity flag writes a `flagged_responses` row (admin-only deny-all RLS) and skips `send_notification` outbox enqueue in the SAME transaction as response persistence. Owner notification re-fires only on admin `approved_for_owner_review` at `/admin/flagged`; dismiss/regenerate are terminal. Moderation metadata recorded on `api_costs`. Local regex rules (`src/lib/moderation/output-filter.ts`) always run regardless; the OpenAI Moderation layer is additionally gated by `OPENAI_MODERATION_ENABLED` and fails open. See `.claude/skills/approval-security.md`.

5. **Approval tokens never stored raw.** Only SHA-256 hashes in `approval_links`. Raw tokens exist only in memory and in the sent email — never in Postgres, outbox payloads, or logs.

6. **Third-party ingress terminates on Railway.** Stripe, Resend, Twilio, Zernio webhooks hit `worker/ingress/*`. Do NOT proxy through Next.js except in local dev with an explicit comment.

7. **ReviewSource contract.** All sources normalize to `NormalizedReview` DTO. No source-specific fields leak into the prompt builder.

8. **Auth scope is app-enforced.** `users.auth_id` maps to Supabase Auth identity. Browser code never receives `SUPABASE_SERVICE_KEY`. Every owner read/write scoped by `account_id` (billing parent) and, per-location, `business_id` (= one Google Business Profile location).

9. **`businesses` row = location; `accounts` row = billing parent.** Don't re-introduce subscription columns on `businesses`. Two sub-rules: (a) billing snapshot reads STORED quota from `accounts` (`locations_included`, `locations_overage_price_cents` — point-in-time, grandfathered), not live `TIER_CONFIG` values; base price is the lone un-stored exception (`TIER_CONFIG.baseCents`); (b) multi-location settings use three distinct checks — `shouldUseMultiLocationSettings` (mode: count > 1), `shouldShowLocationsSettings` (visibility: flag only), `canAddLocationForAccount` (eligibility: flag + active + `multiLocAllowed`) — never collapse to one boolean.

10. **Use Node.js native crypto.** `import { createHash, randomUUID } from 'node:crypto'`. Never `crypto-js`.

11. **Subscription guard in all customer-facing workers.** Check status early: `cancelled` → no-op; `past_due` → 7-day grace; `pending_payment` → NotificationWorker and ResponsePublisherWorker skip (ResponseGenerator allowed for admin demo drafts).

12. **Entry points orchestrate; modules own failure behavior.** Route handlers, worker boot files, and ingress handlers may validate, orchestrate, and map errors — extract any error-handling branch over ~30 lines into a named module with focused tests.

13. **Feature flags are server-authoritative.** The browser learns flag state via API responses. Never add a `NEXT_PUBLIC_*` companion for a feature flag.

## Where things live

Detailed inventories load on demand — read the matching file before the work:

| Before you… | Read |
|---|---|
| write or debug a migration / touch schema | `.claude/reference/migrations-log.md` |
| add an env var or flip a feature flag | `.claude/reference/env-vars.md` |
| touch review ingestion / add a ReviewSource | `.claude/reference/review-ingestion.md` |
| touch a named library/subsystem (Postgres.js, Zernio, Stripe, Supabase auth, …) | `.claude/reference/lab-notes.md` |

Patterns to follow (invoke as Skills): `outbox-pattern`, `approval-security`,
`cost-guard`, `onboarding-demo-cost-guard`.

Code map: `docs/directory.md` · Layout reasoning: `docs/currents.md` · ADRs via
codebase-memory `manage_adr`.

## Tech stack (non-obvious choices)

- **Two Postgres clients**: `postgres` (Postgres.js) for transactional writes; `@supabase/supabase-js` for auth/storage/reads. Do not collapse them.
- **Two Redis instances**: Upstash cache (not the source of truth) and Upstash BullMQ queue (not the cache).
- **LLM**: `gpt-4o-mini-2024-07-18` primary, `claude-haiku-4-5-20251001` fallback — pinned IDs, never bare aliases. Constants in `src/lib/responses/generator.ts` (guarded by `model-pinning.test.ts`). Prompt policy + version hash: `src/lib/responses/prompt-policy.ts`, recorded on every `api_costs` row.
- **JSONB via Postgres.js**: use `jsonb()` helper (`sql.json(value)`, OID 3802). `${JSON.stringify(x)}::jsonb` double-encodes in Postgres.js v3.
- **Package manager**: pnpm.
- **Analytics**: PostHog (`posthog-node`) worker/server-only via `src/lib/analytics/posthog.ts`. No-op when `POSTHOG_API_KEY` unset; flushed on shutdown. Browser/Next.js code never calls PostHog directly — client intent events POST to `/api/analytics/enqueue` (gated to `CLIENT_ENQUEUEABLE_EVENT_NAMES`; durable facts are NOT client-postable), durable events insert server-side, `AnalyticsDispatchPoller` ships them. Idempotency via `event_key` + `ON CONFLICT`.
- **Structured logging**: `createWorkerLogger(prefix, correlationId)` emits one JSON object per line (`src/lib/shared/logger.ts`). Per-request/job IDs via `AsyncLocalStorage` (`src/lib/shared/log-context.ts`). Never log raw review/response text, tokens, secrets, or MFA codes — object args pass through the analytics blocked-key sanitizer; string args are logged verbatim.
- **Audit writes**: account-status changes go through `src/lib/audit/log.ts` (`writeAccountAuditLog`) in the SAME transaction — never raw `INSERT INTO account_audit_log`.

## Worker layout

- BullMQ job handlers: `worker/jobs/*.ts` + sub-folders `notification/`, `publisher/`, `zernio/`
- BullMQ `'failed'` exhaustion hooks: `worker/jobs/zernio/ingest-failed-hook.ts` and `worker/jobs/publisher/failed-hook.ts` — colocated with their workers
- Background loops: `worker/background/pollers/` (Postgres-state-driven) + `worker/background/schedulers/` (time-cadence-driven)
- Webhook ingress: `worker/ingress/{stripe,resend,shared}.ts` + sub-folders `twilio/`, `telegram/`, `zernio/`
- Boot-time env assertions: `worker/config/startup-assert.ts`
- Sentry init + scrubber: `worker/sentry.ts` (imported for side effect by `worker/index.ts`)
- Queues + Redis options: `worker/queues.ts`
- Entry point: `worker/index.ts` — pure registration + lifecycle, no DB writes
- Full file map: `docs/directory.md`

## Database

- All tables: UUIDv7 (time-ordered)
- Base schema: `supabase/migrations/001_initial_schema.sql`; current head: migration **053** (next: **054**)
- Migration detail: `.claude/reference/migrations-log.md`
- Review sentiment: `reviews.sentiment_*` populated by `classifySentiment` (`src/lib/reviews/sentiment.ts`, deterministic star-based `deterministic_star_v1`) at all review-content write sites; status-only writes don't touch it.
- Customer KPIs: `src/lib/kpi/*` (`DashboardKpiSummary` — response rate, avg star, review-volume MoM, avg time-to-respond, 8-week sentiment trend); per-location or per-account; served by `GET /api/dashboard/kpis`.
- Finance/margin signals: admin-only, aggregate-on-read from `api_costs` via `src/lib/admin/margin-service.ts`. Cross-account queries intentionally allowlisted in tenant-scope audit.

## Non-obvious gotchas — read before touching related code

- **Postgres.js + PgBouncer returns JSONB as strings.** Guard: `typeof x === 'string' ? JSON.parse(x) : x`
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

## MCP servers in use

| MCP            | When                                                               |
| -------------- | ------------------------------------------------------------------ |
| **Supabase**   | DB queries, migrations, data debugging                             |
| **Context7**   | Library docs (BullMQ, Resend, Stripe, Next.js) before implementing |
| **Playwright** | E2E tests                                                          |
| **Sentry**     | Error tracking, production debugging                               |
