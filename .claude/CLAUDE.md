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

## Codex Review Bridge

- Scripts: `~/dev/codex-bridge/`
- Start: `bash ~/dev/codex-bridge/start`
- Send prompt: `bash ~/dev/codex-bridge/nudge "..."`
- Wait for review: `bash ~/dev/codex-bridge/watch <PR#>`
- Session name: `cdx` — always run in WSL2

## Architecture invariants — NEVER violate these

- **Vercel = UI only.** LLM calls, external API calls, and long-running
  operations MUST run on Railway workers. Never in Next.js API routes.
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
  owner read/write scoped by `business_id`.
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
  (NOT `claude-3-5-haiku-latest` — that model is 404)
- JSONB via Postgres.js: use `jsonb()` helper (`sql.json(value)`, OID 3802).
  `${JSON.stringify(x)}::jsonb` double-encodes in Postgres.js v3.
- Package manager: pnpm

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
- Current head: migration **032** (next: **033**)
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

## Agent skills

### Issue tracker

GitHub Issues on `norbertesekiel47/ai-review-responder` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at repo root (neither exists yet; skills proceed silently if absent). See `docs/agents/domain.md`.
