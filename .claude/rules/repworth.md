# RepWorth Project Rules

Project-specific rules. The general engineering posture lives in
[engineering.md](engineering.md), [production.md](production.md), and
[design.md](design.md) — this file only adds RepWorth-specific contracts and
trims gray areas where those rules could be misapplied.

Source of truth for architecture is [.claude/CLAUDE.md](../CLAUDE.md). If
anything here disagrees with CLAUDE.md, CLAUDE.md wins.

## Stack contract (behavioral rules only)

Stack facts (Next.js 16, dual Postgres clients, dual Redis, pinned LLM IDs,
pnpm, external integrations) are owned by CLAUDE.md "Tech stack". The rules
below govern *how to act* on that stack:

- **Route handlers parse input, call one module function, return output** — no business logic in route handlers, server actions, or worker boot files.
- **Do not collapse the two Postgres clients.** `postgres` (Postgres.js) is for transactional writes; `@supabase/supabase-js` is for auth/storage/reads. They serve different roles.
- **Auth scope is app-enforced, not RLS-enforced.** Every owner read/write must be scoped by `account_id` (billing parent) and, where per-location, by `business_id`. RLS is used in a few admin-only places (e.g. `flagged_responses` deny-all) but is NOT the primary security boundary.
- **Do not introduce npm or yarn lockfiles.** Package manager is pnpm; keep it that way.
- **LLM IDs are pinned; never use bare aliases.** Constants in `src/lib/responses/generator.ts`, guarded by `model-pinning.test.ts`.

## Architecture invariants

The canonical NEVER-violate list lives in [`../CLAUDE.md`](../CLAUDE.md)
("Architecture invariants — NEVER violate these"). This file does not restate
them; it adds the behavioral law for *applying* them. If anything here disagrees
with CLAUDE.md, CLAUDE.md wins.

## Reliability rules (production.md applied)

- Every outbound call to Stripe, Resend, Twilio, Zernio, SerpAPI, OpenAI, or
  Anthropic has an explicit timeout and a bounded retry policy with jitter.
  Postgres.js sets `statement_timeout: 30_000` (PgBouncer default of ~8s
  breaks OutboxPoller CTE).
- Every BullMQ job handler is **idempotent**. Idempotency key is the
  deterministic outbox key, not the BullMQ job ID (BullMQ also rejects `:`
  in job IDs — OutboxPoller uses `_`).
- Every webhook handler verifies signature **before** doing anything else
  and persists the raw payload + provider event ID for replay.
- Never log raw review text, raw response text, tokens, secrets, or MFA
  codes. Use `createWorkerLogger` (`src/lib/shared/logger.ts`); object args
  pass through the analytics blocked-key sanitizer, string args do not.

## Always do

- Check `docs/directory.md` and CLAUDE.md before adding a new file or
  top-level directory.
- For structural code questions ("who calls X?", "what does X call?"),
  prefer codebase-memory-mcp graph tools over Grep/Read — one call
  (~500 tokens) vs file-by-file (~80k tokens).
- Run `pnpm lint && pnpm typecheck && pnpm test` before claiming work is
  done. For DB-touching changes, also run `pnpm ci:tenant-scope` and
  `pnpm ci:rls-audit`.
- Write tests for: webhook handlers, billing math, idempotency keys,
  tenant-scoped queries, approval-token paths, outbox transitions,
  subscription guards.
- When deleting a doc or marking a checklist item done, fix its audit tick in
  the same change and grep the filename to clean every cross-reference —
  dangling refs and stale ticks are bugs.

## Never do

- Do not add a new top-level directory (`lib/`, `services/`, `utils/`,
  `helpers/`) without justifying what complexity it hides that wasn't hidden
  before. The bias is to add nothing.
- Do not introduce a new runtime dependency without checking what's already
  installed. Prefer fewer packages; never add a near-duplicate.
- Do not add abstraction layers in anticipation of a feature ("we might
  swap providers"). Wait for the second concrete use case before extracting.
- Do not put business logic in route handlers, server actions, or worker
  boot files. They orchestrate; modules own behavior.
- Do not catch errors silently. Either handle the specific failure mode or
  let it propagate with context preserved.
- Do not use `any`. Use `unknown` and narrow. The one carve-out is
  Postgres.js + PgBouncer returning JSONB as strings — guard with
  `typeof x === 'string' ? JSON.parse(x) : x`, don't paper over with `any`.
- Do not use `${JSON.stringify(x)}::jsonb` with Postgres.js v3 (it
  double-encodes). Use the `jsonb()` helper / `sql.json(value)`.
- Do not push directly to `main`. The "main protection" ruleset blocks it;
  land changes via PR with the CI checks green (`.github/workflows/ci.yml`
  jobs — CLAUDE.md "CI & repo" is the authoritative description).
- Do not use string literals for subscription status, tier IDs, job names,
  or review status. Import the enum/constant from its single authoritative
  TS file.

## Approval-and-modification posture

- Before adding a file, check whether the change belongs in an existing
  file. The default is "no new file."
- Before extracting a function, ask: would inlining it make the call site
  clearer? If yes, don't extract.
- Before adding a comment, ask: can a better name remove the need for the
  comment? Comments are for the "why," not the "what."
- Before adding an abstraction for a single caller, don't.
