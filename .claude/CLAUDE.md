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

## Database

- All tables: UUIDv7 (time-ordered)
- Base schema: `supabase/migrations/001_initial_schema.sql`
- Current head: migration **031** (next: **032**)
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

## Current branch status

- `feat/past-replies-view` — **active branch, 9 commits, ready to ship**.
  Read-only "Past Replies" tab + flag-gated external-reply ingestion. Solves
  the Tanicia onboarding problem (silently-dropped pre-RepWorth replies)
  without baking Zernio's DELETE+POST edit complexity into the product
  core. Two independent flags: `EXTERNAL_REPLY_IMPORT_ENABLED` (writes path)
  + `PAST_REPLIES_VIEW_ENABLED` (UI). Branched off
  `feat/zernio-ingestion-replace-serpapi`. Adds migration 031.
- **Tag `wip/edit-existing-replies-zernio-v1`** — full edit / regenerate /
  recovery / DELETE+POST / orphan-marker machinery from the original
  `feat/edit-existing-replies` branch (31 commits, 6 review rounds, ~3,500
  LOC). Parked pending direct GBP API approval — GBP's single-PUT updateReply
  makes the orphan-recovery layer vestigial. Reusable when GBP arrives:
  route shapes, drawer state machine (minus recovery state), helpers like
  assertCanEditReply + validateOptimisticConcurrency. NOT to be merged into
  main as Zernio-shaped today; either rebuild against GBP, OR resurrect
  if GBP timeline blows up beyond ~12 months.
- `feat/zernio-ingestion-replace-serpapi` — base of the past-replies-view
  branch; code-complete, pending prod migration 028+029+030 + smoke test.
- `feat/owner-self-serve-signup` — pending Supabase custom SMTP config.
- Channels (Telegram/WhatsApp/SMS) — code-complete, flag-gated off.
- See `docs/currents.md` for the simple-words summary, `docs/progresstracking.md`
  for the detailed history including the split decision.
