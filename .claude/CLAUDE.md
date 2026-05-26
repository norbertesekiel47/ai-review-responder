# RepWorth — Claude Code Context

## What this project is

Automated Google review response service for SMBs. Next.js 14 (Vercel) +
Railway worker (Fastify + BullMQ) + Supabase/PostgreSQL + Upstash Redis.
Reviews ingested via Zernio webhooks; responses require explicit owner
approval before posting.

## Dev commands

- `pnpm dev` — Next.js (port 3000)
- `pnpm worker` — Railway worker via tsx (port 3001)
- `pnpm test` — Vitest unit + integration
- `pnpm test:watch` — Vitest watch
- `pnpm test:e2e` — Playwright E2E (skips gracefully without TEST_DATABASE_POOL_URL)
- `pnpm lint` — ESLint
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass all external APIs locally

## CI & repo (since 2026-05-24)

- Repo lives at **`RepWorth/ai-review-responder`** (org, Team plan). `main` is
  protected by the **"main protection" ruleset**: requires the 4 CI checks +
  blocks force-push/deletion. **Land changes via PR** — direct pushes to `main`
  are rejected.
- **CI** (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test`, `build`
  on every PR + `push:main`. Secret-free env block; **`MOCK_EXTERNAL_APIS=false`
  in CI** (NOT true — `true` short-circuits the Zernio transport to a mock and
  breaks real-path tests). Integration + Playwright e2e are NOT yet gated (need
  `TEST_DATABASE_POOL_URL`). Third-party actions are pinned to commit SHAs.
- Never validate CI from a git worktree nested inside the repo — resolution
  leaks into the parent's `node_modules`/eslintrc and poisons lint+test. Push
  and read the runner, or clone clean.

## Codex Review Bridge

- Scripts: `~/dev/codex-bridge/`
- Start: `bash ~/dev/codex-bridge/start`
- Send prompt: `bash ~/dev/codex-bridge/nudge "..."`
- Wait for review: `bash ~/dev/codex-bridge/watch <PR#>`
- Session name: `cdx` — always run in WSL2

## Architecture invariants — NEVER violate these

- **Vercel = UI only.** LLM calls, external API calls, and long-running
  operations MUST run on Railway workers. Never in Next.js API routes.
  Exception (ADR 0001): Next.js routes may make short, user-blocking
  OAuth-handshake calls when they must set/clear cookies or return a redirect
  synchronously (Zernio connect callback + select-location). Durable recovery
  and long-running work still belong in modules/workers.
- **Transactional outbox.** State change + follow-up work go in ONE Postgres
  transaction via `job_outbox`. Never write Postgres then separately enqueue
  BullMQ — silent data loss on enqueue failure.
- **No auto-posting.** There is NO code path from response generation to
  Google posting without an explicit approval step. Make it architecturally
  impossible to bypass.
- **Approval tokens never stored raw.** Only SHA-256 hashes in
  `approval_links`. Raw tokens exist only in memory and in the sent email.
  Never persist in Postgres, outbox payloads, or logs.
- **Third-party ingress terminates on Railway.** Stripe, Resend, Twilio,
  Zernio webhooks hit `worker/ingress/*` in production. Do NOT proxy through
  Next.js unless in local dev with an explicit comment.
- **ReviewSource contract.** All sources normalize to `NormalizedReview` DTO.
  No source-specific fields leak into the prompt builder.
- **Auth scope is app-enforced.** `users.auth_id` must map to Supabase Auth
  identity. Browser code never receives `SUPABASE_SERVICE_KEY`. Every
  owner read/write scoped by `account_id` (the billing parent) and, when
  per-location, by `business_id` (= a single Google Business Profile
  location).
- **`businesses` row = location; `accounts` row = billing parent.** Since
  multi-location (migration 034), the `businesses` table holds one row per
  Google Business Profile location. Subscription / Stripe / quota state
  lives on `accounts`. Naming kept for blast-radius reasons; do not
  re-introduce subscription columns on `businesses`. See
  `docs/runbooks/multi-location.md`.
  - **Billing snapshot reads STORED quota, not `TIER_CONFIG`.** Since PR #51,
    `currentBillingSnapshot` / overage math read `accounts.locations_included`
    and `accounts.locations_overage_price_cents` (point-in-time, grandfathered)
    — not the live `TIER_CONFIG` values. Base price is the lone exception
    (still `TIER_CONFIG.baseCents`; no stored column yet), so the `founders`
    base is NOT grandfathered. See `quota.ts` TODO + multi-location runbook §6.
  - **Settings gating uses three separate checks, never one boolean.**
    `shouldUseMultiLocationSettings` (mode: `count > 1`),
    `shouldShowLocationsSettings` (visibility: flag only), and
    `canAddLocationForAccount` (eligibility: flag + active + `multiLocAllowed`)
    are distinct. The Locations tab now shows on the flag alone, even for
    one-location accounts; do not collapse these back into a count check.
- **Use Node.js native crypto.** `import { createHash, randomUUID } from
'node:crypto'`. Never `crypto-js`.
- **Subscription guard in all customer-facing workers.** Check status early:
  `cancelled` → no-op; `past_due` → 7-day grace; `pending_payment` →
  NotificationWorker and ResponsePublisherWorker skip (ResponseGenerator
  allowed for admin demo drafts).
- **Entry points orchestrate; modules own failure behavior.** Route handlers,
  worker boot files, and ingress handlers may validate, orchestrate, and map
  errors, but must not own durable side effects inside long failure branches.
  Extract any error-handling branch over ~30 lines into a named module
  interface next to its caller, with focused tests for the branch.

## Key patterns — read skill files before implementing these

- Cost guard: `.claude/skills/cost-guard.md`
- Approval flow + security: `.claude/skills/approval-security.md`
- Outbox pattern: `.claude/skills/outbox-pattern.md`
- Review deduplication: `.claude/skills/review-dedup.md`

## Tech stack (non-obvious choices)

- Two Postgres clients: `postgres` (Postgres.js) for transactional writes,
  `@supabase/supabase-js` for auth/storage/reads
- Two Redis instances: Upstash cache (separate from) Upstash BullMQ queue
- LLM: GPT-4o-mini primary, `claude-haiku-4-5-20251001` fallback
- JSONB via Postgres.js: use `jsonb()` helper (`sql.json(value)`, OID 3802).
  `${JSON.stringify(x)}::jsonb` double-encodes in Postgres.js v3.
- Package manager: pnpm
- Analytics: PostHog (`posthog-node`), worker/server-only via
  `src/lib/analytics/posthog.ts`. No-op when `POSTHOG_API_KEY` is unset;
  flushed on worker shutdown. Never `posthog-js` / Next.js routes (Vercel =
  UI only). Activation (`activation_completed`) is captured on the publisher
  path — see `worker/jobs/publisher/activation.ts`.
  - **First-party analytics queue (Wave 2, migration 046).** Browser/Next.js
    code never calls PostHog directly: client intent events POST to
    `/api/analytics/enqueue` (gated to `CLIENT_ENQUEUEABLE_EVENT_NAMES` — durable
    facts like `first_response_drafted`/`activation_completed` are NOT
    client-postable), durable events insert into `analytics_events` server-side
    (in-tx where one exists), and `AnalyticsDispatchPoller` ships rows to PostHog
    (`flush`-before-`completed`; unconfigured/transient failures defer without
    burning the retry budget). Idempotency via `event_key` + `ON CONFLICT`.
- Account-status audit writes go through `src/lib/audit/log.ts`
  (`writeAccountAuditLog`) in the SAME transaction as the state change — never
  raw `INSERT INTO account_audit_log`.

## Worker layout

- BullMQ job handlers: `worker/jobs/*.ts` + sub-folders `notification/`, `publisher/`, `zernio/` (multi-file jobs)
- BullMQ `'failed'` exhaustion hooks: `worker/jobs/zernio/ingest-failed-hook.ts` (`handleIngestFailed`) and `worker/jobs/publisher/failed-hook.ts` (`handlePublisherFailed`) — colocated with their workers per the entry-point invariant
- Background loops: `worker/background/pollers/` (Postgres-state-driven) + `worker/background/schedulers/` (time-cadence-driven)
- Webhook ingress: `worker/ingress/{stripe,resend,shared}.ts` + provider sub-folders `twilio/`, `telegram/`, `zernio/`
- Boot-time env assertions: `worker/config/startup-assert.ts`
- Sentry init + scrubber: `worker/sentry.ts` (imported for side effect by `worker/index.ts`)
- Queues + Redis options: `worker/queues.ts` (root)
- Entry point: `worker/index.ts` (root) — pure registration + lifecycle, no DB writes
- File-by-file map: `docs/directory.md`. Layout reasoning: `docs/currents.md`.

## Database

- All tables: UUIDv7 (time-ordered)
- Base schema: `supabase/migrations/001_initial_schema.sql`
- Current head: migration **049** (next: **050**)
- For migration details: see `.claude/skills/migrations.md`

## Non-obvious gotchas — read these before touching related code

- Postgres.js + PgBouncer returns JSONB as strings. Guard: `typeof x ===
'string' ? JSON.parse(x) : x`
- BullMQ rejects `:` in job IDs — OutboxPoller uses `_` separator
- Supabase PgBouncer `statement_timeout` ~8s — set `statement_timeout: 30_000`
  on Postgres.js client (OutboxPoller CTE exceeds it)
- `ON CONFLICT` clause must match partial-unique-index predicate BYTE-FOR-BYTE
  or Postgres won't recognize the constraint. Same for expression indexes:
  `(created_at AT TIME ZONE 'UTC')::date` not `created_at::date` (STABLE
  rejected in index predicates — must be IMMUTABLE)
- Zernio `account.disconnected` payload uses nested `account.id`, not flat
  `accountId`. Read `body.account?.id`
- `SELF_SERVE_SIGNUP_ENABLED`: confirmation template must use `{{ .Token }}`
  (6-digit OTP), NOT `{{ .ConfirmationURL }}`. Reset/invite links need
  `&amp;` not `&` in `href` attributes.
- `CleanupAbandonedSignupsPoller`: re-validate ALL predicates inside the tx
  with `SELECT FOR UPDATE`. `deleteUser()` is irreversible and non-transactional.
- Supabase `signUp()` returns `identities: []` for already-confirmed emails
  (anti-enumeration). Detect before `createBusinessTx`.
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` required for PlaceAutocomplete. Don't
  use `displayName` (Pro tier) — use `id + formattedAddress + location` only.
- Google Maps URLs use hex CIDs (`0x...:0x...`), not canonical Place IDs.
  Resolve via PlaceAutocomplete or SerpAPI, never `data_id`.
- Owner channel enrollment org-default is **account-scoped** — keyed by
  `account_id` + `channel` + `location_id IS NULL`, matching migration 034's unique
  index. `business_id` is a legacy FK written on INSERT but NOT used for org-default
  lookup. All cancel/disable enrollment helpers take `accountId` (owner + admin
  callers). See `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`.

## Codebase intelligence

### codebase-memory-mcp — structural queries

Prefer graph tools over Grep/Glob for structural code questions.
Graph = one tool call (~500 tokens) vs file-by-file (~80K tokens).

**Workflow:**

1. `list_projects` → check freshness
2. `index_repository` if stale or after significant changes
3. `get_graph_schema` before writing complex Cypher queries
4. `search_graph` / `trace_call_path` → find nodes
5. `get_code_snippet(qualified_name)` → read source

**Use for:** "Who calls X?", "What does X call?", call chains, dead code,
HTTP_CALLS cross-service links, REST routes, fan-out analysis.
**Use grep/Glob for:** string literals, error messages, config values.

### graphify — semantic + design orientation

Read `graphify-out/GRAPH_REPORT.md` before answering architecture or
design questions. Never dump `graph.json` whole into context — use
`/graphify query "..."` for focused subgraph pulls.

**Tool selection:**
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


