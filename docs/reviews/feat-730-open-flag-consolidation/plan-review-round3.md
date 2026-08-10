Reading additional input from stdin...
OpenAI Codex v0.145.0
--------
workdir: /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
model: gpt-5.6-sol
provider: openai
approval: on-request
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 019fe8c7-3355-7042-aeb4-4a27b577a6d8
--------
user
ROUND 3 (FINAL) — VERIFICATION-ONLY re-review of exactly TWO findings
(read-only; modify nothing). Plan v3:
docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md

Round-2 status: findings 1,2,3,5,6,8,9,10,11 ADDRESSED (settled — do NOT
re-open). Verify ONLY:

**Finding 4 (was FIX-INTRODUCED-DEFECT: nonexistent service.test.ts /
invented harness):** v3 now targets the REAL suites: title #10 lands in
src/lib/dashboard/__tests__/service.feed-projection.test.ts using its own
lateralBody(queryText, 'resp') slicer (~line 41) and harness.sqlCalls; the
shared queue-based dashboard harness gets the fragment-aware guard at its
defining module; a MANDATORY mirror assertion covers the aggregate feed query
in the aggregate suite that captures text; the existing
aggregate-queries.test.ts ~line 261 'flagged_responses' text pin is
explicitly relocated, never deleted. The residual (no live execution of the
service/aggregate LATERALs) is now an explicitly-recorded accepted risk with
stated reasoning (splice validity live-proven in all three composition
contexts elsewhere; surgical in-place block swaps; unit pins for
polarity/placement/correlation). Verify: do the cited suite mechanics
actually exist as claimed (lateralBody, harness.sqlCalls, the ~261 pin), and
is the accepted-residual reasoning sound as an EXPLICIT recorded tradeoff?

**Finding 7 (was NOT ADDRESSED: gate accepts .todo; import-only occurrence
satisfies the scan):** v3's T7 source-scan now (a) counts INVOCATIONS via
/openFlagExistsSql\(/g — import specifiers never match — with per-file
minimums including BOTH pending-count call sites (min 2), and (b) adds a
second mechanical test failing if ANY it.todo( remains in the three suites
that carried stubs — closing the .todo escape inside `pnpm test` (which the
gate always runs) without touching verify-gate.sh (out of surface). Verify
the mechanics: can an import line match /openFlagExistsSql\(/? Can a
promised title survive as .todo without failing this test? Name any
remaining bypass concretely.

Output format (strict):
1. Two-row table: finding # | ADDRESSED / NOT ADDRESSED / FIX-INTRODUCED-DEFECT | one line.
2. Optional short appendix (untriaged).
3. LAST line exactly `VERDICT: APPROVED` or `VERDICT: REVISE`.
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
I’m using the `verify-spec` workflow for this read-only re-review, scoped strictly to Findings 4 and 7. I’ll inspect Plan v3 and the cited test mechanics without reopening settled findings or modifying files.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '1,240p' .agents/skills/verify-spec/SKILL.md && sed -n '1,280p' .claude/CLAUDE.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
---
name: verify-spec
description: Audit a spec, plan, or launch-readiness doc against the actual codebase and emit an evidence-backed per-item verdict table plus an overall PASS/FAIL. Use when the user asks to verify, audit, or confirm that a spec/plan/checklist/launch doc was implemented, or asks "what's remaining" on a checklist. Verify-and-report only — it never implements fixes.
---

# Verify Spec Against Codebase

Audit-only skill. You verify and report; you do NOT implement, fix, or edit the
spec docs. The user decides what happens with the findings.

## Inputs

`$ARGUMENTS` = one or more spec/plan/checklist doc paths. If none given, ask
which doc(s) to verify — do not guess.

## Procedure

1. **Read the doc(s) and extract every verifiable claim** — checklist items,
   "must/should" statements, audit ticks, acceptance criteria. Number them.
   Ignore narrative prose with no testable assertion.

2. **Set up the incremental findings file** at
   `/tmp/verify-spec-findings-<docname>.md`. Append findings per item as you
   go — never accumulate the whole audit for one giant final message (large
   audits have hit output-token limits before).

3. **Verify each item against reality, not against other docs.** Evidence
   hierarchy, strongest first:
   - code inspection at a specific `file:line` (prefer codebase-memory-mcp
     graph tools for structural questions — who-calls-X, routes, call chains)
   - `git log`/`git diff` showing the change landed on `main`
   - a passing test that pins the behavior
   - migration applied (check `.claude/reference/migrations-log.md` head)
   A tick in another doc is NOT evidence. Mark each item:
   - `VERIFIED` — concrete evidence found
   - `PARTIAL` — implemented but incomplete vs. the claim (say what's missing)
   - `MISSING` — no evidence of implementation
   - `STALE` — doc claims something the code contradicts (flag for doc fix)

4. **For audits over ~15 items, fan out**: split items into sections and
   dispatch one Explore subagent per section, each returning a compressed
   `item | status | evidence` block. Verify any surprising MISSING/STALE
   finding yourself before reporting it.

5. **Run the validation suite** (skip any the turn already ran):
   - `pnpm lint && pnpm typecheck && pnpm test`
   - if any item touches DB/schema: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
   - if any item touches analytics or flags: `pnpm ci:analytics-events && pnpm ci:static-policy`

6. **Emit the mandatory output contract.** The final message MUST end with:

   ```
   | # | Item | Status | Evidence |
   |---|------|--------|----------|
   | 1 | ...  | VERIFIED | src/lib/foo.ts:42 |

   Suite: lint PASS | typecheck PASS | test PASS (NNN) | audits PASS/SKIPPED

   VERDICT: PASS            # every item VERIFIED and suite green
   VERDICT: FAIL — <n> items remaining: <numbered list of MISSING/PARTIAL/STALE>
   ```

   No audit ends without a `VERDICT:` line. "Ran out of things to check" is
   not a verdict.

## Rules

- Evidence before assertions — never mark VERIFIED from memory or doc ticks.
- Report STALE doc ticks; do not silently fix them (verify-and-report only).
- If the working tree is dirty, say so up front — audit `main`/HEAD state and
  note which findings could be affected by uncommitted changes.
# RepWorth — Claude Code Context

## What this project is

Agentic reputation-management platform for SMBs, sold as **Copilot** (owner approves everything) and **Autopilot** (bounded autonomy) subscription tiers. Three customer personas — **Reply** (drafts every response; auto-posts positive-quadrant on Autopilot), **Guardian** (triage + escalation; never acts publicly), **Insights** (weekly digest) — supervised by two watchdogs: the **Judge** (LLM review of 100% of auto-posts; availability is a posting precondition) and the **Governor** (per-account autonomy suspension). Design of record: `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §8. Next.js 16 (Vercel, UI only) + Railway worker (Fastify + BullMQ, all LLM/external/long-running work) + Supabase/PostgreSQL + Redis(Upstash for Cache/Railway Redis for Queue).

Pipeline: Zernio webhook ingest → Guardian triage (`TRIAGE_ENABLED`, negative lane only) → AI draft → moderation → owner notification/approval, or gated `auto_policy` approval + veto window behind `AUTO_APPROVAL_ENABLED=true` → posted to Google → Judge verdict. Every persona action is recorded on the run spine (`agent_runs`/`agent_run_steps`/`agent_outcomes`) via the single writer `src/lib/agents/run-spine.ts`.

## Dev commands

- `pnpm worker` — Railway worker via tsx (port 3001); `pnpm dev:all` — full stack
- `pnpm worktree:new <branch> [base-ref]` — create an **isolated sibling worktree** outside the repo (own `node_modules`, copied `.env*.local`), then `cd` into the printed path. Use this for parallel feature branches; see "CI & repo" for why sibling not nested.
- `pnpm test:integration` — **hard-gates only the publisher edit-existing-reply suite** (fails fast without `TEST_DATABASE_POOL_URL`); other integration suites run only when invoked directly — see gotcha below
- `pnpm test:db:setup` — provision the local test DB to migrations head (bootstrap + every migration, local-only, drops schema `public` first). Run it once after creating the container and again whenever a migration lands: live-DB suites **assert** their schema (`assertSchemaReady`) instead of applying migrations, so a behind-head DB fails loudly rather than self-healing.
- `pnpm test:e2e` — Playwright E2E (skips gracefully without TEST_DATABASE_POOL_URL)
- `pnpm eval:llm` — LLM safety eval harness (offline/keyless by default; `--live` needs provider keys)
- `pnpm ci:*` — the CI audit scripts. The `ci:` entries in package.json are the authoritative list; do not keep a second copy of it here. Wiring, enforced by `src/__tests__/ci-audit-wiring.test.ts` (#590): the `lint` CI job runs every one of them **except** `ci:fallow:coverage`, which runs in its own `fallow.yml` job, and `ci:fallow`, which is the developer-facing sweep and gates nothing; `lefthook.yml` mirrors every audit the `lint` job runs. `ci:static-policy` enforces invariants #10, #13, #14; `ci:live-db-suites` enforces the two live-DB test conventions (see the gotcha below); `ci:outbox-status` enforces the `job_outbox` in-flight status vocabulary (invariant #2).
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass all external APIs locally

## CI & repo

- Repo **`RepWorth/ai-review-responder`**; `main` is protected — **land changes via PR**, direct pushes rejected.
- CI (`.github/workflows/ci.yml`): `lint` (also runs the `ci:*` audit scripts — see "Dev commands" for which, and `src/__tests__/ci-audit-wiring.test.ts` for the check that keeps package.json, the workflows, and `lefthook.yml` from drifting apart), `typecheck`, `test`, `llm-eval` (path-filtered LLM-safety eval release gate — WS7), `build` on every PR + push to `main`. `MOCK_EXTERNAL_APIS=false` in CI — `true` short-circuits Zernio transport and breaks real-path tests. Third-party actions pinned to commit SHAs.
- **Local pre-push hook (`lefthook.yml`)** runs the cheap CI subset before code leaves the machine — lint, typecheck, every CI audit, and affected tests (`vitest --changed`), in parallel. Same commands as CI; CI stays the full-suite gate. Installed via the `prepare` script on `pnpm install`. Escape hatch for WIP: `git push --no-verify`.
- **Worktrees: sibling (blessed) vs nested (footgun).** Use `pnpm worktree:new <branch>` (→ `scripts/new-worktree.sh`) — a sibling worktree at `../RepWorth-worktrees/<branch>/` with its own `node_modules` + copied `.env*.local`, so local lint/test/typecheck give a trustworthy signal. Nested worktrees (`.claude/worktrees/`, harness `EnterWorktree`, Agent `isolation:'worktree'`) leak the parent's deps/ESLint config into local CI — fine for edit+typecheck agents, never for trustworthy full CI. Every Write/Edit path must point at the worktree root, never the parent checkout (hook-enforced by `edit-surface-guard.sh`). Cleanup procedure + full mechanics: lab-notes "Worktrees — sibling vs nested".

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

## Working rules

- Route handlers, server actions, and worker boot files orchestrate only: parse input, call one module function, return output — no business logic.
- Verify before claiming done: `pnpm lint && pnpm typecheck && pnpm test`. DB-touching changes also run `pnpm ci:tenant-scope` and `pnpm ci:rls-audit`.
- Always write tests for: webhook handlers, billing math, idempotency keys, tenant-scoped queries, approval-token paths, outbox transitions, subscription guards.
- Every outbound provider call (Stripe, Resend, Twilio, Zernio, SerpAPI, OpenAI, Anthropic) gets an explicit timeout + bounded, jittered retries. Every BullMQ handler is idempotent — the key is the deterministic outbox key, not the BullMQ job ID. Webhook handlers verify the signature FIRST and persist raw payload + provider event ID for replay.
- No `any` (JSONB carve-out excepted — use `unknown` and narrow). No silent catches. No string literals for subscription status, tier IDs, job names, or review status — import the constant from its single authoritative TS file.
- No new top-level directories, no near-duplicate dependencies, no abstractions for a single caller, no npm/yarn lockfiles. Default is "no new file" — check `docs/directory.md` first.
- When deleting a doc or ticking a checklist item, fix its audit tick and grep the filename to clean every cross-reference in the same change.

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
| touch **review import consent** (the Import offer, `import_decision`, the derived-expiry predicate, or any of the four enqueue gates) | spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` (§2 decision table D1–D10 is **locked**) + ADR `docs/adr/0015-consented-import-unflagged-replacement.md` + ADR `docs/adr/0016-import-consent-enforcement-locus.md` (enforcement locus — why not a `job_outbox` trigger) + `CONTEXT.md` → **Review import**, **Import consent**, **Import offer**, **Import window**, **Live-ingest cutoff**. `src/lib/reviews/import-consent.ts` is the SINGLE owner of the predicate and of every consent write — including `enqueueInitialImport`, which all four producers delegate to; do not re-spell its guard. Enforcement is at the four producers **and, since #679, at the chokepoint**: `guardImportConsent` (`worker/jobs/zernio/job-eligibility.ts`) is a fail-closed pre-flight in `ZernioBackfillWorker` that proceeds only on `accepted` — so a hand-inserted `zernio_initial_backfill` row no-op-completes with a logged reason instead of importing. It is deliberately a SEPARATE function from `guardZernioJobEligibility` (a merged guard would have two callers, one of which must never reach consent code), and its whole body must stay inside `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)` — without that serialization an owner's accept races the guard into silent permanent data loss. Enqueue-path inventory: `.claude/reference/review-ingestion.md`. |
| touch **solicitation consent or suppression** (Consent ledger `solicitation_consent`, Suppression ledger `solicitation_suppressions`, Unsubscribe tokens, the `suppressionMatchSql` lookup, or the withhold-reason precedence in `evaluateAsk`) | spec `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` + `CONTEXT.md` → "Solicitation suppression & unsubscribe" (**eight** locked terms, incl. **attestation never overrides suppression**; global wins a double match; the ledger is solicitation-only — DR2). **Redemption (#644) spans both surfaces** — `src/lib/solicitation/unsubscribe.ts` owns the token gate, the claim-first ordering and the Success receipt; `worker/ingress/unsubscribe.ts` is the RFC 8058 one-click route; `src/app/(public)/u/**` + `src/app/api/u/**` are the recipient landing path. A page may claim "you are unsubscribed" **only** from a ledger read taken during that render — a receipt is necessary, never sufficient. **Manual paths (#645)**: the **Correction path** is the admin-only, audited removal of a factually-wrong row — error correction, NEVER re-subscribe — sunk to `solicitation_suppression_corrections` (migration 098), NOT `account_audit_log`, and written by ONE data-modifying CTE so the DELETE cannot commit without its record. §7.6 **owner clearing** is a different act with a different sink (`account_audit_log`); an owner may never clear a `global` row, and the UI must not present the two as the same control. Daily servicing ritual: `docs/runbooks/channels-rollout.md` §6. |
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
- **Queues**: `worker/queues.ts`; **Redis connection options**: `worker/redis-connection.ts`
  (side-effect-free — unit-testable without booting the queues).
- **Entry point** `worker/index.ts`: pure registration + lifecycle, **no DB writes**.

## Database

- **Schema + migrations** → `.claude/reference/migrations-log.md` (authoritative): base schema (`001_initial_schema.sql`), current head / next number, and the UUIDv7 time-ordered-PK convention. Read it before any migration.
- **Review sentiment**: `reviews.sentiment_*` populated by `classifySentiment` (`src/lib/reviews/sentiment.ts`, deterministic star-based `deterministic_star_v1`) at all review-content write sites; status-only writes don't touch it.
- **Customer KPIs**: `src/lib/kpi/*` (`DashboardKpiSummary` — response rate, avg star, review-volume MoM, avg time-to-respond, 8-week sentiment trend); per-location or per-account; served by `GET /api/dashboard/kpis`.
- **Finance/margin signals**: admin-only, aggregate-on-read from `api_costs` via `src/lib/admin/margin-service.ts`. Cross-account queries intentionally allowlisted in tenant-scope audit.

## Non-obvious gotchas — read before touching related code

- **Postgres.js + PgBouncer can return JSONB as strings.** Guard: `typeof x === 'string' ? JSON.parse(x) : x`, then narrow the result — the *only* sanctioned exception to the no-`any` rule (never paper over it with `: any`). The **authoritative allowlist of production JSONB field-to-parser sites** (19 today) lives in lab-notes "PgBouncer JSONB parse-site allowlist" — any new site must be added there, and HTTP/request bodies, provider responses, LLM output, Redis/cache values, local storage, and `TEXT[]` reads do NOT belong on it (different parsing boundaries, not this carve-out).
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
- **The worker is single-replica by invariant — DETECTED, not enforced.** Four boot guards + the in-process LLM circuit breaker are only correct with one replica; `ci:static-policy` blocks `numReplicas`/`multiRegionConfig` in `railway.toml`, and replicas register in Redis so `HealthAlertPoller` pages when >1 is live (#587) — deliberately a registry, NOT a boot-gating lease (a Redis outage must never stop the worker starting). Before ever scaling: clear the P2 list in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`. Full mechanics: lab-notes "Single-replica worker".
- **Railway private network is IPv6-only** — `ioredis`/BullMQ won't resolve `*.railway.internal` unless `family: 0` is set (`worker/redis-connection.ts` parses `?family=`). Works on local/Upstash, silently fails to connect on Railway without it.
- **Best-effort work after a worker's primary side effect needs its own `try/catch` (log-and-swallow)** — a secondary failure (telemetry, Sentry, cost-threshold check) caught by the outer handler flips an already-completed job to `failed`. Never let observability poison the success path.
- **postgres.js decodes `timestamptz` into a JS `Date` — Postgres MICROSECONDS are silently truncated to milliseconds.** Any SQL comparison against a value that round-tripped through JS can mis-order by <1ms; fatal when a row is compared against a window/anchor derived FROM that same row (governor permanent re-suspension immunity #520; wedge-reaper `backend_start` equality before it). Truncate the DB side (`date_trunc('milliseconds', col) > ${jsDate}`) or keep the value `::text` end-to-end. JS-Date-seeded test fixtures carry zero µs and CANNOT catch this — seed with `+ interval '419 microseconds'`.
- **A live-DB *suite* must be named `*.integration.test.ts`; no live-DB *file* — suite or `__tests__/` helper — may execute DDL at run time.** The name puts it in vitest's serialized `integration` project; run-time DDL deadlocks (40P01) against sibling suites in concurrent vitest processes. Provision once with `pnpm test:db:setup`; assert with `assertSchemaReady`. Detection is AST extraction of **executed SQL** — every tagged template and `.unsafe()` call — never a text marker (#694: the `supabase/migrations` + `.unsafe(` conjunction missed three sites, one of which stranded a CHECK constraint and cost 14 spurious failures). The audited set is every `.ts`/`.tsx` under `__tests__/`, not just the suites (#706): Postgres.js splices a nested `Query` substitution in as raw SQL text, so a helper can build a DDL fragment a suite executes — the finding lands on the file that BUILDS it. Helpers reach the DB by importing `postgres` (they are handed the handle, so they name no env var); the `e2e/` Playwright lane is deliberately out of scope. Two sanctioned escapes, BOTH lock-enforced allowlists in `scripts/ci/live-db-suites-audit.ts`: migration-**shape** files (applying the migration IS the subject) and **DDL-probe** suites (session-scoped `auth.uid()` redefinition inside a rolled-back tx) — each must hold `acquireLiveDbLock` AND roll back any unconditional re-apply. Safety that is statically invisible takes a per-line `-- live-db-ddl-ignore: <reason>` (a `CREATE INDEX` on a `pg_temp` table reads exactly like one on the shared table). To force a transaction abort use `helpers/abort-injection.ts`, NEVER a temporary constraint — a vitest timeout skips the `finally` that would drop it. CI-enforced: `ci:live-db-suites`. Full mechanics: lab-notes "#573".
- **Unsetting `TEST_DATABASE_POOL_URL` does NOT put live-DB suites to sleep** — `resolveTestDatabaseUrl()` falls back to reading `.env.local` off disk, and a whole-repo `pnpm test` with the DB awake breaks import-time-singleton suites (the #520 class; CI is immune by coincidence). Kill switch: `REPWORTH_DISABLE_LIVE_DB_SUITES=1` (#563). Full mechanics: lab-notes "TEST_DATABASE_POOL_URL fallback".
- **fallow's coverage input is DB-complete as of #581** — `fallow.yml` stands up its own `postgres:16` container, so a module covered only by an integration suite no longer reads 0% with inflated CRAP. Details: lab-notes "fallow coverage DB-complete".
- **`pnpm test:integration` hard-gates only the publisher edit-existing-reply suite.** Other live-DB integration suites (e.g. the governor scheduler's) exist but run only when their file is invoked directly — an existing-but-not-run suite is how #520 shipped. When touching governor/judge/publisher paths, run the matching integration file explicitly with `TEST_DATABASE_POOL_URL` set.
- **The worker crash-net RECOVERS from transient-DB `unhandledRejection`s; it does NOT blanket-crash.** `worker/index.ts` classifies via `isCrashNetRecoverableDbError` (strict allowlist — keep it distinct from billing's broad `isTransientPostgresError`): transient Postgres rejections are survived (Sentry warning; sustained storms escalate to crash via `worker/transient-rejection-governor.ts`); everything else fails fast and `uncaughtException` is ALWAYS fatal. Never reintroduce blanket crash-on-any-rejection. Full mechanics: lab-notes "Worker crash-net".
- **API rate limits fail OPEN by design; the worker's Redis cost RESERVATION precedes every LLM call, so spend stays safe even when a limiter is bypassed.** Pre-LLM Redis **transport** failures are RETRYABLE (`CostInfraUnavailableError` → BullMQ retry + outbox watchdog; #255 — do not re-terminalize); **budget-exceeded** decisions stay TERMINAL (never reclassify as infra); post-LLM finalize failures are governed by `withCostGuard`'s `onFinalizeError`, never a job-level retry (would re-spend). Do NOT "fix" the limiters to strict. Upstash is a single-instance **SPOF** (cache + rate-limit + cost-reserve + regen-budget + idempotent-generation). Full touchpoint/retry matrix: lab-notes "Cost-guard fail-open/retry matrix".

## MCP servers & CLIs

**MCP servers** — load tool schemas via ToolSearch before calling; prefer the MCP over the matching CLI when both fit (structured results).

| MCP | When |
| --- | --- |
| **Supabase** | DB queries, migrations, data debugging (remote HTTP MCP — auth before first use). For DB WRITES prefer `execute_sql` over inline `psql` one-liners — structured results and fewer shell-permission prompts |
| **Railway** | Worker infra — deploys, logs, metrics, env vars, services |
| **Stripe** | Billing inspection — Prices, subscriptions, events (remote HTTP MCP — OAuth via `/mcp` before first use) |
| **Vercel** | Frontend deploys, build logs, project status (remote HTTP MCP — auth before first use) |
| **Context7** | Library/framework docs (BullMQ, Resend, Stripe, Next.js) before implementing |
| **claude-mem** | "Did we solve this before?" — cross-session memory / observations |

Playwright (E2E via `pnpm test:e2e`) and Sentry (`@sentry/*` SDK + `worker/sentry.ts`) are **not** MCPs. Per-developer personal MCPs (Gmail, Drive, Calendar) may also be connected; not project tools.

**CLIs** (in Bash):

- **Git/CI**: `git`, `gh` (PRs, issues, CI runs + logs)
- **Platform**: `vercel`, `railway`, `supabase`, `stripe` (webhook test + event replay), `gcloud`
- **Data/infra**: `psql` (Postgres direct), `redis-cli` (cache/queue), `docker`
- **Runtime/utils**: `node`, `pnpm`, `npx`, `tsx` (via pnpm/npx — not global), `rg`, `jq`, `curl`, `python3`

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "git status --short && rg -n \"Finding 4|Finding 7|T7|openFlagExistsSql|lateralBody|sqlCalls|flagged_responses|\\.todo|accepted risk|residual|aggregate-queries|feed-projection|title #10|#10\" docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
?? docs/reviews/feat-730-open-flag-consolidation/plan-review-round3.md
9:> into T1/T4/T5/T7, fragment-aware test doubles specified (the v1 mock claim
14:predicate onto one composable fragment `openFlagExistsSql`, owned by
39:- `flagged_responses` is NOT in `TENANT_TABLES` — the fragment adds no new
85:| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql`; `hasOpenFlag` body re-expressed; + divergence comment block |
86:| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment test; contract test; + T7 source-scan test; assertion updates |
106:T1 → T2 → T3 → T4 → T5 → T6 → T7. (v1 ran T6 parallel to T3–T5; round 1
122:`.todo` until their implementation task: #1 (T2), #9 (T4), #10 (T5), #11 (T7).
124:1. `openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref` — `.todo`
132:9. `each draft-status awaited query projects held from its correctly correlated response alias` — `.todo`
133:10. `the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned` — `.todo`
134:11. `all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains` — `.todo`
136:- [ ] **Step 1: held-draft.test.ts — titles #1 (.todo) and #2**
148:describe('openFlagExistsSql', () => {
149:  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
150:  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
157:`flagged_responses` INSERT shape (~line 138), the FK-ordered cleanup
245:Also add `.todo` stubs where they belong:
247:`it.todo('each draft-status awaited query projects held from its correctly correlated response alias')`;
248:in `src/lib/dashboard/__tests__/service.feed-projection.test.ts` (NOT
250:`it.todo('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned')`.
268:### Task 2: `openFlagExistsSql` + re-expressed `hasOpenFlag` + divergence block
277:describe('openFlagExistsSql', () => {
278:  it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
280:    openFlagExistsSql(tx, tx`resp.id`);
283:    expect(exists.text).toContain('FROM flagged_responses fr');
287:  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
292:expected FAIL (`openFlagExistsSql` not exported).
305: * projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` — D9 sites) or
306: * filtered (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`). `ref` is
311:export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
313:    SELECT 1 FROM flagged_responses fr
327:    WHERE ${openFlagExistsSql(tx, tx`${responseId}::uuid`)}
337:// Four categories read/write flagged_responses with DIFFERENT semantics, and
360:    expect(allText).toContain('FROM flagged_responses');
371:git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
387:      -- held while an open flagged_responses row exists". Its hasOpenFlag is an
396:            FROM flagged_responses f
402:New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`; use the
407:      -- held while an open flagged_responses row exists"; this projection
408:      -- composes its openFlagExistsSql fragment (#730). Projected, not
413:          ${openFlagExistsSql(sql, sql`resp2.id`)} AS held
433:git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
455:    // path composes its openFlagExistsSql fragment (#730).
459:`${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held`.
464:`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held`
469:row on fragment-build calls. Then fill title #9 (moved from `.todo`):
476:    const existsCall = readCalls.find((c) => c.text.includes('FROM flagged_responses'));
487:git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
492:`FROM flagged_responses`.)
494:### Task 5: Migrate the dashboard trio + regen 4 entries + title #10
501:- Modify: `src/lib/dashboard/__tests__/` — fragment-aware doubles where queue-based + title #10
507:            SELECT 1 FROM flagged_responses fr
515:          AND NOT ${openFlagExistsSql(sql, sql`responses.id`)}
522:`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`. Import in all three files.
524:- [ ] **Step 3: fragment-aware harness + fill title #10** — grounded in the
528:(`harness.sqlReturnQueue` / `harness.sqlCalls`, text via `strings.join`) —
533:Title #10 goes in `service.feed-projection.test.ts` (moved from `.todo`),
534:using that suite's OWN `lateralBody(queryText, 'resp')` slicer (defined at
540:    const body = lateralBody(recentReviewsQuery()!.text, 'resp');
546:    expect(harness.sqlCalls.some((c) => c.text.trim() === 'responses.id')).toBe(true);
547:    expect(harness.sqlCalls.some((c) => c.text.includes('FROM flagged_responses fr'))).toBe(true);
553:captures its query text (`aggregate-queries.test.ts` /
556:`aggregate-queries.test.ts` ~line 261 `expect(call.text).toContain('flagged_responses')`
560:**Accepted residual (recorded for review):** the migrated service/aggregate
576:git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
595:      LEFT JOIN flagged_responses fr
615:        AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
624:git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
632:- [ ] **Step 1: fill title #11** in held-draft.test.ts (moved from `.todo`) —
636:Round-2 hardening (finding 7): the scan counts INVOCATIONS (`openFlagExistsSql(`
639:`.todo` — closing the gate's `.todo` acceptance without touching
643:  it('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains', () => {
644:    // file → minimum openFlagExistsSql(...) INVOCATIONS (import lines never
645:    // match `openFlagExistsSql(`): pending-count has TWO spellings.
657:      const calls = src.match(/openFlagExistsSql\(/g)?.length ?? 0;
658:      expect(calls, `${file} must invoke openFlagExistsSql at least ${minCalls}×`).toBeGreaterThanOrEqual(minCalls);
659:      expect(src, `${file} re-spells the open-flag predicate inline`).not.toMatch(/FROM\s+flagged_responses/i);
663:  it('no promised #730 test title survives as .todo', () => {
664:    // The verify gate's promised-tests row accepts `.todo`; this closes that
669:      'src/lib/dashboard/__tests__/service.feed-projection.test.ts',
673:      expect(src, `${suite} still carries a .todo stub`).not.toMatch(/it\.todo\(/);
678:(The second test's title is a T7 implementation detail, not a promised intake
679:title — it needs no intake entry; it exists to make the ".todo left behind"
691:  `.todo` among the eleven titles; `reclassify` inside 2× both buckets.
702:  (newest-unheld fallback, T1/T6), #8 (grouped counts, T1/T5), #10
704:  disproportionate, reasoning inline), #11 (source-scan, T7); fragment-aware
710:- **Type consistency:** `openFlagExistsSql(db, ref)` spelled identically in
711:  T2–T7; ref always the executing client's fragment.

hook: PostToolUse
hook: PostToolUse Completed
codex
The worktree has one untracked review artifact (`docs/reviews/feat-730-open-flag-consolidation/plan-review-round3.md`); I’ll ignore it and base the verdict only on Plan v3 plus the cited source/test files. No tracked files are modified.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '112,172p' docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
sed -n '492,580p' docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
sed -n '626,684p' docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
rg -n \"function lateralBody|const lateralBody|lateralBody\\(|sqlCalls|sqlReturnQueue|flagged_responses|aggregate feed|feed query|aggregate\" src/lib/dashboard/__tests__ src/lib/dashboard -g '*.ts'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:

### Task 1: Eval task — behavior-pinning tests + promised-test stubs

**Files:**
- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
- Modify: `src/lib/agents/__tests__/read.integration.test.ts`

All eleven intake `tests_to_add` titles land VERBATIM here. GREEN now
(behavior-pinning, they must survive the refactor unchanged): #2–#8 below.
`.todo` until their implementation task: #1 (T2), #9 (T4), #10 (T5), #11 (T7).

1. `openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref` — `.todo`
2. `hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes`
3. `a held draft still projects draft_held true after the fragment migration`
4. `getReviewTimeline excludes a response whose flag is open and includes it once closed`
5. `property: projected held and filtered visibility agree for every flag-row status combination`
6. `hasOpenFlag executes the UUID-parameter fragment against live Postgres`
7. `getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged`
8. `per-business and account-grouped pending counts exclude the same open-held rows across two businesses`
9. `each draft-status awaited query projects held from its correctly correlated response alias` — `.todo`
10. `the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned` — `.todo`
11. `all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains` — `.todo`

- [ ] **Step 1: held-draft.test.ts — titles #1 (.todo) and #2**

```ts
  it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
    const open = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
    const closed = mkTx([]);
    await expect(hasOpenFlag(closed.tx, RESPONSE_ID)).resolves.toBe(false);
  });
```

```ts
describe('openFlagExistsSql', () => {
  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
});
```

- [ ] **Step 2: load-replies.integration.test.ts — titles #3, #5, #6, #8**

Read the suite first. Crib: the `REVIEW_HELD_REPLACEMENT` fixture + its
`flagged_responses` INSERT shape (~line 138), the FK-ordered cleanup
(~line 208), and how the suite creates its business/account rows.

Title #3 — behavior-pinning against the EXISTING fixture (mirror the
neighbouring #727 held-case assertions; through `loadPastRepliesPageView`,
a held replacement draft on a posted row projects `row_action 'none'` /
withdrawn Regenerate — assert exactly what the adjacent held case asserts,
under the locked title):

```ts
  it('a held draft still projects draft_held true after the fragment migration', async () => {
    const view = await loadPastRepliesPageView(/* suite's standard args */);
    const heldRow = view.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
    expect(heldRow).toBeDefined();
    expect(heldRow!.row_action).toBe('none'); // held ⇒ affordance withdrawn (invariant #4 as structure)
  });
`FROM flagged_responses`.)

### Task 5: Migrate the dashboard trio + regen 4 entries + title #10

**Files:**
- Modify: `src/lib/dashboard/service.ts:253-256`
- Modify: `src/lib/dashboard/aggregate-service.ts:404-407`
- Modify: `src/lib/dashboard/pending-count.ts:17-20,45-48`
- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries: ~1509/~1516/~1530/~1537)
- Modify: `src/lib/dashboard/__tests__/` — fragment-aware doubles where queue-based + title #10

- [ ] **Step 1: service.ts + aggregate-service.ts** — keep both comments; the block

```
          AND NOT EXISTS (
            SELECT 1 FROM flagged_responses fr
            WHERE fr.response_id = responses.id AND fr.status = 'open'
          )
```

becomes

```
          AND NOT ${openFlagExistsSql(sql, sql`responses.id`)}
```

(correlated ref is the unaliased `responses` table in both LATERALs; use each
query's in-scope client variable.)

- [ ] **Step 2: pending-count.ts — BOTH spellings** →
`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`. Import in all three files.

- [ ] **Step 3: fragment-aware harness + fill title #10** — grounded in the
REAL suites (round-2 fix; v2 cited a nonexistent `service.test.ts`):

The dashboard suites share a queue-based mock harness
(`harness.sqlReturnQueue` / `harness.sqlCalls`, text via `strings.join`) —
find its defining module under `src/lib/dashboard/__tests__/` and apply the
fragment-aware guard from the plan header THERE, once, so every dashboard
suite inherits it.

Title #10 goes in `service.feed-projection.test.ts` (moved from `.todo`),
using that suite's OWN `lateralBody(queryText, 'resp')` slicer (defined at
~line 41) instead of invented plumbing:

```ts
  it('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned', async () => {
    // (drive the feed query exactly like the suite's neighbouring cases, then:)
    const body = lateralBody(recentReviewsQuery()!.text, 'resp');
    const notIdx = body.indexOf('AND NOT ?');            // fragment placeholder, NEGATED polarity
    const orderIdx = body.indexOf('ORDER BY version DESC');
    expect(notIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeGreaterThan(notIdx);            // filter BEFORE order/limit — held newest falls back to unheld sibling
    // the fragment was built with the right correlation, as its own captured calls:
    expect(harness.sqlCalls.some((c) => c.text.trim() === 'responses.id')).toBe(true);
    expect(harness.sqlCalls.some((c) => c.text.includes('FROM flagged_responses fr'))).toBe(true);
  });
```

MANDATORY mirror for the aggregate feed query: place the same
polarity+placement+correlation assertions in the aggregate suite that
captures its query text (`aggregate-queries.test.ts` /
`aggregate-service.test.ts` — read them and put the pin beside the existing
text assertions). Also RELOCATE, never delete, the existing
`aggregate-queries.test.ts` ~line 261 `expect(call.text).toContain('flagged_responses')`
pin on the grouped pending count — post-migration that text lives in the
fragment's own captured call.

**Accepted residual (recorded for review):** the migrated service/aggregate
LATERALs have no live execution path in any suite. Accepted because the
fragment's splice validity is live-proven in all three composition contexts
(projected-in-LATERAL via load-replies, filtered via pending-count titles
#5/#8, parameter-correlated via title #6), the edits are surgical
in-place block swaps, and the unit pins above catch polarity/placement/
correlation regressions. A live dashboard-service suite remains
disproportionate for this refactor.

- [ ] **Step 4: regen entries, run — INCLUDING the cross-module property — commit**

```bash
pnpm ci:tenant-scope 2>&1 | tail -40   # 4 mismatches: service ×2, aggregate ×2 — paste each
pnpm vitest run src/lib/dashboard
TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # titles #5/#8 exercise BOTH pending-count spellings live against the migrated code
git add src/lib/dashboard scripts/ci/tenant-scope-allowlist.ts
git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
```

(pending-count has NO allowlist entry — its queries are directly scoped;
confirm the audit passes without adding one.)

(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched; no
allowlist work here.)

### Task 7: Source-scan test (title #11) + verify gate

- [ ] **Step 1: fill title #11** in held-draft.test.ts (moved from `.todo`) —
house precedent: source-scanning suites like
`src/__tests__/eslint-boundaries.test.ts` / `design-token-single-source.test.ts`:

Round-2 hardening (finding 7): the scan counts INVOCATIONS (`openFlagExistsSql(`
never matches the import specifier), requires BOTH pending-count call sites,
and mechanically forbids any of the eleven promised titles surviving as
`.todo` — closing the gate's `.todo` acceptance without touching
`verify-gate.sh` (out of surface).

```ts
  it('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains', () => {
    // file → minimum openFlagExistsSql(...) INVOCATIONS (import lines never
    // match `openFlagExistsSql(`): pending-count has TWO spellings.
    const OWNER_FACING: Array<[string, number]> = [
      ['src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts', 1],
      ['src/app/api/dashboard/past-replies/draft-status/route.ts', 1],
      ['src/lib/past-replies/load-replies.ts', 1],
      ['src/lib/dashboard/service.ts', 1],
      ['src/lib/dashboard/aggregate-service.ts', 1],
      ['src/lib/dashboard/pending-count.ts', 2],
      ['src/lib/agents/read.ts', 1],
    ];
    for (const [file, minCalls] of OWNER_FACING) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf-8');
      const calls = src.match(/openFlagExistsSql\(/g)?.length ?? 0;
      expect(calls, `${file} must invoke openFlagExistsSql at least ${minCalls}×`).toBeGreaterThanOrEqual(minCalls);
      expect(src, `${file} re-spells the open-flag predicate inline`).not.toMatch(/FROM\s+flagged_responses/i);
    }
  });

  it('no promised #730 test title survives as .todo', () => {
    // The verify gate's promised-tests row accepts `.todo`; this closes that
    // escape mechanically. Scans the four suites that carried stubs.
    const SUITES = [
      'src/lib/moderation/__tests__/held-draft.test.ts',
      'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts',
      'src/lib/dashboard/__tests__/service.feed-projection.test.ts',
    ];
    for (const suite of SUITES) {
      const src = readFileSync(resolve(process.cwd(), suite), 'utf-8');
      expect(src, `${suite} still carries a .todo stub`).not.toMatch(/it\.todo\(/);
    }
  });
```

(The second test's title is a T7 implementation detail, not a promised intake
title — it needs no intake entry; it exists to make the ".todo left behind"
failure mode mechanical rather than prose.)

Run the suite; commit:

```bash
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:6:// reads stay fatal: the locations-list query (an aggregate over unknown
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:11:// The REAL aggregate-queries module runs here (no seam mock): rejections are
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:46:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:61: * call consumes (same thenable-adoption reasoning as aggregate-queries.test.ts's
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:63: *   1. account billing row               (aggregate-service, settled)
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:72: *  10. account-wide recent reviews feed  (aggregate-service, settled)
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:78:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:107:    'dashboard/aggregate',
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:158:  it('keeps the baseline anchor read fatal (the slices are built from its rows — an all-zeros aggregate would misreport)', async () => {
src/lib/dashboard/rating-breakdown.ts:5:// (build from a GROUP BY) and the aggregate service (sum per-location rollups),
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:6:// reads stay fatal: the locations-list query (an aggregate over unknown
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:11:// The REAL aggregate-queries module runs here (no seam mock): rejections are
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:46:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:61: * call consumes (same thenable-adoption reasoning as aggregate-queries.test.ts's
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:63: *   1. account billing row               (aggregate-service, settled)
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:72: *  10. account-wide recent reviews feed  (aggregate-service, settled)
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:78:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:107:    'dashboard/aggregate',
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:158:  it('keeps the baseline anchor read fatal (the slices are built from its rows — an all-zeros aggregate would misreport)', async () => {
src/lib/dashboard/aggregate-service.ts:1:// src/lib/dashboard/aggregate-service.ts
src/lib/dashboard/aggregate-service.ts:3:// Builds AggregateDashboardData for the "All Locations" aggregate view.
src/lib/dashboard/aggregate-service.ts:6:// Strategy: a single set-based per-account aggregate wave
src/lib/dashboard/aggregate-service.ts:27:} from './aggregate-queries';
src/lib/dashboard/aggregate-service.ts:40:// getLocationsForAccount has no row in the aggregate wave (both derive from the
src/lib/dashboard/aggregate-service.ts:59:// Short TTL cache for the aggregate payload. Repeated loads within the TTL — tab
src/lib/dashboard/aggregate-service.ts:67:function aggregateCacheKey(accountId: string, window: DashboardWindow): string {
src/lib/dashboard/aggregate-service.ts:68:  return `dashboard:aggregate:${accountId}:${window}`;
src/lib/dashboard/aggregate-service.ts:73:const widgetOrFallback = widgetOrFallbackFor('dashboard/aggregate');
src/lib/dashboard/aggregate-service.ts:76: * Builds aggregate dashboard data for all active locations in an account.
src/lib/dashboard/aggregate-service.ts:80: * 2. Runs the set-based per-account aggregate (`fetchPerLocationAggregateSlices`) —
src/lib/dashboard/aggregate-service.ts:82: * 3. Computes aggregate sums across locations
src/lib/dashboard/aggregate-service.ts:96:  const cacheKey = aggregateCacheKey(accountId, window);
src/lib/dashboard/aggregate-service.ts:103:    console.error('[dashboard/aggregate] cache read failed (computing fresh):', err);
src/lib/dashboard/aggregate-service.ts:114:    console.error('[dashboard/aggregate] cache write failed (serving fresh):', err);
src/lib/dashboard/aggregate-service.ts:125:  // P10 (plan R2): the locations-list query stays FATAL — an aggregate over
src/lib/dashboard/aggregate-service.ts:159:      scope: 'aggregate',
src/lib/dashboard/aggregate-service.ts:178:  // One set-based aggregate wave (constant query count) + the account-wide
src/lib/dashboard/aggregate-service.ts:341:    scope: 'aggregate',
src/lib/dashboard/aggregate-service.ts:405:          SELECT 1 FROM flagged_responses fr
src/lib/dashboard/__tests__/service.cache.test.ts:9:// (#478), mirroring the aggregate-service block. Hoisted get/set mocks let each
src/lib/dashboard/__tests__/service.cache.test.ts:40:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.cache.test.ts:73:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts:82:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:99:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:186:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts:9:// (#478), mirroring the aggregate-service block. Hoisted get/set mocks let each
src/lib/dashboard/__tests__/service.cache.test.ts:40:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.cache.test.ts:73:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts:82:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:99:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:186:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/types.ts:30: *  Opt-in (route passes includeReputationMetrics) so the aggregate path stays light. */
src/lib/dashboard/types.ts:54: * A TRUE aggregate over every rated review in the window — NOT the capped
src/lib/dashboard/types.ts:95:/** Review-feed fields shared by per-location and aggregate dashboard payloads. */
src/lib/dashboard/types.ts:111:   *  absent on the aggregate / lighter paths. */
src/lib/dashboard/types.ts:113:  /** Windowed reviews-by-rating aggregate (#405) — distribution across the
src/lib/dashboard/types.ts:247:/** Review row extended with location chip data for the aggregate feed. */
src/lib/dashboard/types.ts:254:/** The full aggregate dashboard data shape. */
src/lib/dashboard/types.ts:256:  /** Discriminator: always 'aggregate' to distinguish from per-location DashboardData. */
src/lib/dashboard/types.ts:257:  scope: 'aggregate';
src/lib/dashboard/types.ts:271:  /** Windowed reviews-by-rating aggregate (#405) — summed across all active
src/lib/dashboard/types.ts:282:  /** Present when the account is past_due but aggregate read access remains available. */
src/lib/dashboard/aggregate-queries.ts:1:// src/lib/dashboard/aggregate-queries.ts
src/lib/dashboard/aggregate-queries.ts:3:// Set-based per-account aggregate: a fixed wave of `GROUP BY business_id`
src/lib/dashboard/aggregate-queries.ts:35:// Wave degradations report under the aggregate path's source tag, matching
src/lib/dashboard/aggregate-queries.ts:36:// aggregate-service.ts (which owns the other 'dashboard/aggregate' widgets).
src/lib/dashboard/aggregate-queries.ts:37:const widgetOrFallback = widgetOrFallbackFor('dashboard/aggregate');
src/lib/dashboard/aggregate-queries.ts:45: * Everything the aggregate view needs from ONE location, reproduced from the
src/lib/dashboard/aggregate-queries.ts:109: * Set-based per-account aggregate. Returns one {@link PerLocationAggregateSlice}
src/lib/dashboard/aggregate-queries.ts:117: * across locations instead of failing the whole aggregate. Only the baseline
src/lib/dashboard/aggregate-queries.ts:119: * (iterating its rows), so degrading it would return an all-zeros aggregate
src/lib/dashboard/aggregate-queries.ts:121: * locations-list query in aggregate-service.ts.
src/lib/dashboard/service.ts:42:// Short TTL cache for the per-location payload, mirroring the aggregate-service
src/lib/dashboard/service.ts:90: * aggregate path (aggregate-service.ts) binds `'dashboard/aggregate'` and
src/lib/dashboard/service.ts:254:            SELECT 1 FROM flagged_responses fr
src/lib/dashboard/scope.ts:11:/** Narrow the dashboard payload to the multi-location aggregate shape. */
src/lib/dashboard/scope.ts:13:  return 'scope' in data && data.scope === 'aggregate';
src/lib/dashboard/scope.ts:33: *   aggregate              → Σ locationKpis[].pendingApprovalCount
src/lib/dashboard/pending-count.ts:18:        SELECT 1 FROM flagged_responses fr
src/lib/dashboard/pending-count.ts:27: * predicate (`pending_approval` and no open flagged_responses), grouped by
src/lib/dashboard/pending-count.ts:28: * `business_id` and account-scoped, so the All-Locations aggregate gets every
src/lib/dashboard/pending-count.ts:46:        SELECT 1 FROM flagged_responses fr
src/lib/dashboard/__tests__/service.feed-projection.test.ts:21:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.feed-projection.test.ts:38:  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
src/lib/dashboard/__tests__/service.feed-projection.test.ts:41:function lateralBody(queryText: string, alias: 'resp' | 'esc'): string {
src/lib/dashboard/__tests__/service.feed-projection.test.ts:67:    const responseLateral = lateralBody(query!.text, 'resp');
src/lib/dashboard/__tests__/service.feed-projection.test.ts:84:    const escalationLateral = lateralBody(query!.text, 'esc');
src/lib/dashboard/__tests__/service.feed-projection.test.ts:21:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.feed-projection.test.ts:38:  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
src/lib/dashboard/__tests__/service.feed-projection.test.ts:41:function lateralBody(queryText: string, alias: 'resp' | 'esc'): string {
src/lib/dashboard/__tests__/service.feed-projection.test.ts:67:    const responseLateral = lateralBody(query!.text, 'resp');
src/lib/dashboard/__tests__/service.feed-projection.test.ts:84:    const escalationLateral = lateralBody(query!.text, 'esc');
src/lib/dashboard/__tests__/service.degradation.test.ts:69:  harness.sqlReturnQueue.push(...results);
src/lib/dashboard/__tests__/service.degradation.test.ts:113:    harness.sqlReturnQueue[0] = [];
src/lib/dashboard/__tests__/service.degradation.test.ts:69:  harness.sqlReturnQueue.push(...results);
src/lib/dashboard/__tests__/service.degradation.test.ts:113:    harness.sqlReturnQueue[0] = [];
src/lib/dashboard/__tests__/scope.test.ts:48:function aggregatePayload(kpiCounts: number[]): AggregateDashboardData {
src/lib/dashboard/__tests__/scope.test.ts:50:    scope: 'aggregate',
src/lib/dashboard/__tests__/scope.test.ts:71:  it('aggregate: sums locationKpis pending counts, not the capped slice (>10 regression)', () => {
src/lib/dashboard/__tests__/scope.test.ts:72:    const data = aggregatePayload([8, 9]);
src/lib/dashboard/__tests__/scope.test.ts:48:function aggregatePayload(kpiCounts: number[]): AggregateDashboardData {
src/lib/dashboard/__tests__/scope.test.ts:50:    scope: 'aggregate',
src/lib/dashboard/__tests__/scope.test.ts:71:  it('aggregate: sums locationKpis pending counts, not the capped slice (>10 regression)', () => {
src/lib/dashboard/__tests__/scope.test.ts:72:    const data = aggregatePayload([8, 9]);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:5:// The set-based aggregate module is born-injected (sql is a parameter, invariant
src/lib/dashboard/__tests__/aggregate-queries.test.ts:10:} from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-queries.test.ts:22: * Load the aggregate wave's return values in the deterministic order the mock
src/lib/dashboard/__tests__/aggregate-queries.test.ts:37:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-queries.test.ts:153:    expect(harness.sqlCalls).toHaveLength(8);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:154:    for (const call of harness.sqlCalls) {
src/lib/dashboard/__tests__/aggregate-queries.test.ts:232:    const twoLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:237:    const fiveLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:246:    harness.sqlReturnQueue.push([
src/lib/dashboard/__tests__/aggregate-queries.test.ts:257:    const call = harness.sqlCalls[0]!;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:261:    expect(call.text).toContain('flagged_responses');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:5:// The set-based aggregate module is born-injected (sql is a parameter, invariant
src/lib/dashboard/__tests__/aggregate-queries.test.ts:10:} from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-queries.test.ts:22: * Load the aggregate wave's return values in the deterministic order the mock
src/lib/dashboard/__tests__/aggregate-queries.test.ts:37:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-queries.test.ts:153:    expect(harness.sqlCalls).toHaveLength(8);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:154:    for (const call of harness.sqlCalls) {
src/lib/dashboard/__tests__/aggregate-queries.test.ts:232:    const twoLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:237:    const fiveLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:246:    harness.sqlReturnQueue.push([
src/lib/dashboard/__tests__/aggregate-queries.test.ts:257:    const call = harness.sqlCalls[0]!;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:261:    expect(call.text).toContain('flagged_responses');
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:30:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:47:  return harness.sqlCalls.find((call) => call.text.includes('GROUP BY star_rating'))?.text ?? '';
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:88:    const call = harness.sqlCalls[RATING_BREAKDOWN_CALL];
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:100:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(30);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:106:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(7);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:110:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(90);
src/lib/dashboard/__tests__/aggregate-types.test.ts:15:  return 'scope' in data && data.scope === 'aggregate';
src/lib/dashboard/__tests__/aggregate-types.test.ts:19:  it('distinguishes aggregate data from per-location data via scope field', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:20:    const aggregate: AggregateDashboardData = {
src/lib/dashboard/__tests__/aggregate-types.test.ts:21:      scope: 'aggregate',
src/lib/dashboard/__tests__/aggregate-types.test.ts:71:    expect(isAggregateData(aggregate)).toBe(true);
src/lib/dashboard/__tests__/aggregate-types.test.ts:167:  it('aggregate valueSummary matches sum of per-location KPIs', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:173:    const aggregateTotalHandled = kpis.reduce((sum, k) => sum + k.totalReviewsHandled, 0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:174:    const aggregatePending = kpis.reduce((sum, k) => sum + k.pendingApprovalCount, 0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:176:    expect(aggregateTotalHandled).toBe(35);
src/lib/dashboard/__tests__/aggregate-types.test.ts:177:    expect(aggregatePending).toBe(4);
src/lib/dashboard/__tests__/aggregate-types.test.ts:180:  it('aggregate with zero locations returns zero values', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:182:      scope: 'aggregate',
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:30:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:47:  return harness.sqlCalls.find((call) => call.text.includes('GROUP BY star_rating'))?.text ?? '';
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:88:    const call = harness.sqlCalls[RATING_BREAKDOWN_CALL];
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:100:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(30);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:106:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(7);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:110:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(90);
src/lib/dashboard/__tests__/aggregate-types.test.ts:15:  return 'scope' in data && data.scope === 'aggregate';
src/lib/dashboard/__tests__/aggregate-types.test.ts:19:  it('distinguishes aggregate data from per-location data via scope field', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:20:    const aggregate: AggregateDashboardData = {
src/lib/dashboard/__tests__/aggregate-types.test.ts:21:      scope: 'aggregate',
src/lib/dashboard/__tests__/aggregate-types.test.ts:71:    expect(isAggregateData(aggregate)).toBe(true);
src/lib/dashboard/__tests__/aggregate-types.test.ts:167:  it('aggregate valueSummary matches sum of per-location KPIs', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:173:    const aggregateTotalHandled = kpis.reduce((sum, k) => sum + k.totalReviewsHandled, 0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:174:    const aggregatePending = kpis.reduce((sum, k) => sum + k.pendingApprovalCount, 0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:176:    expect(aggregateTotalHandled).toBe(35);
src/lib/dashboard/__tests__/aggregate-types.test.ts:177:    expect(aggregatePending).toBe(4);
src/lib/dashboard/__tests__/aggregate-types.test.ts:180:  it('aggregate with zero locations returns zero values', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:182:      scope: 'aggregate',
src/lib/dashboard/__tests__/aggregate-service.test.ts:5:// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
src/lib/dashboard/__tests__/aggregate-service.test.ts:7:// directly. The set-based aggregate wave is mocked at the seam
src/lib/dashboard/__tests__/aggregate-service.test.ts:14:vi.mock('@/lib/dashboard/aggregate-queries', () => ({
src/lib/dashboard/__tests__/aggregate-service.test.ts:18:// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
src/lib/dashboard/__tests__/aggregate-service.test.ts:35:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.test.ts:38:import type { PerLocationAggregateSlice } from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-service.test.ts:44:/** A per-location aggregate slice with sensible defaults; override per test. */
src/lib/dashboard/__tests__/aggregate-service.test.ts:100:  harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
src/lib/dashboard/__tests__/aggregate-service.test.ts:150:  it('aggregate badge total sums the authoritative per-location counts (>10 regression, #346)', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:199:    harness.sqlReturnQueue.length = 0;
src/lib/dashboard/__tests__/aggregate-service.test.ts:200:    harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-service.test.ts:238:    harness.sqlReturnQueue.push([{ locations_included: 1, locations_paid: 0 }]);
src/lib/dashboard/__tests__/aggregate-service.test.ts:5:// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
src/lib/dashboard/__tests__/aggregate-service.test.ts:7:// directly. The set-based aggregate wave is mocked at the seam
src/lib/dashboard/__tests__/aggregate-service.test.ts:14:vi.mock('@/lib/dashboard/aggregate-queries', () => ({
src/lib/dashboard/__tests__/aggregate-service.test.ts:18:// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
src/lib/dashboard/__tests__/aggregate-service.test.ts:35:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.test.ts:38:import type { PerLocationAggregateSlice } from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-service.test.ts:44:/** A per-location aggregate slice with sensible defaults; override per test. */
src/lib/dashboard/__tests__/aggregate-service.test.ts:100:  harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
src/lib/dashboard/__tests__/aggregate-service.test.ts:150:  it('aggregate badge total sums the authoritative per-location counts (>10 regression, #346)', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:199:    harness.sqlReturnQueue.length = 0;
src/lib/dashboard/__tests__/aggregate-service.test.ts:200:    harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-service.test.ts:238:    harness.sqlReturnQueue.push([{ locations_included: 1, locations_paid: 0 }]);

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '1,125p' src/lib/dashboard/__tests__/service.feed-projection.test.ts
sed -n '1,110p' src/lib/dashboard/__tests__/aggregate-queries.test.ts
sed -n '225,275p' src/lib/dashboard/__tests__/aggregate-queries.test.ts
sed -n '1,125p' src/lib/dashboard/__tests__/aggregate-service.test.ts
rg -n \"create.*Harness|harness =|sqlReturnQueue|strings\\.join|sqlCalls\" src/lib/dashboard/__tests__ -g '*.ts'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

const BUSINESS_ID = 'biz-feed-1';

function seedDashboardQueries() {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    [{ count: 0 }],
    [{ count: 0 }],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  );
}

function recentReviewsQuery() {
  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
}

function lateralBody(queryText: string, alias: 'resp' | 'esc'): string {
  const startMarker = 'LEFT JOIN LATERAL (';
  const endMarker = `) ${alias} ON true`;
  const endIndex = queryText.indexOf(endMarker);
  const startIndex = queryText.lastIndexOf(startMarker, endIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Missing ${alias} LATERAL join in recent-reviews query`);
  }

  return queryText.slice(startIndex + startMarker.length, endIndex).trim();
}

describe('getActiveDashboardData — feed projection', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('reads the current scheduling fields and latest displayable response', async () => {
    seedDashboardQueries();

    await getActiveDashboardData(mockSql, BUSINESS_ID);

    const query = recentReviewsQuery();
    expect(query).toBeDefined();
    const responseLateral = lateralBody(query!.text, 'resp');
    expect(query!.text).toContain('resp.approval_method');
    expect(query!.text).toContain('resp.auto_post_scheduled_at');
    expect(responseLateral).toContain(
      'SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at',
    );
    expect(responseLateral).toContain('ORDER BY version DESC');
    expect(query!.values.filter((value) => value === BUSINESS_ID)).toHaveLength(3);
  });

  it("uses the open-escalation partial-index predicate verbatim", async () => {
    seedDashboardQueries();

    await getActiveDashboardData(mockSql, BUSINESS_ID);

    const query = recentReviewsQuery();
    expect(query).toBeDefined();
    const escalationLateral = lateralBody(query!.text, 'esc');
    expect(escalationLateral).toContain("AND e.status <> 'resolved'");
    expect(escalationLateral).toContain('LIMIT 1');
  });
});
import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// The set-based aggregate module is born-injected (sql is a parameter, invariant
// #15), so the fragment-aware createMockSql harness stands in for `sql` directly.
import {
  fetchPerLocationAggregateSlices,
  type PerLocationAggregateSlice,
} from '../aggregate-queries';
import { getPendingApprovalCountsForAccount } from '../pending-count';

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

/**
 * Load the aggregate wave's return values in the deterministic order the mock
 * consumes them. `getPendingApprovalCountsForAccount` awaits its `sql` inside an
 * async function during Promise.all construction, so its query resolves FIRST;
 * the six lazy `sql``` fragments then resolve in their array order.
 */
function pushWave(rows: {
  pending: Array<{ business_id: string; count: number }>;
  baseline: unknown[];
  counters: unknown[];
  velocity: unknown[];
  rating: unknown[];
  ranking: unknown[];
  monthly: unknown[];
  weekly: unknown[];
}): void {
  harness.sqlReturnQueue.push(
    rows.pending,
    rows.baseline,
    rows.counters,
    rows.velocity,
    rows.rating,
    rows.ranking,
    rows.monthly,
    rows.weekly,
  );
}

describe('fetchPerLocationAggregateSlices — byte-identical per-location slices', () => {
  beforeEach(() => {
    pushWave({
      pending: [
        { business_id: 'loc-A', count: 25 },
        { business_id: 'loc-B', count: 13 },
      ],
      baseline: [
        {
          business_id: 'loc-A',
          name: 'Cafe A',
          created_at: new Date('2026-01-01'),
          initial_review_count: 100,
          initial_responded_count: 30,
          baseline_captured_at: new Date('2026-01-01'),
        },
        {
          business_id: 'loc-B',
          name: 'Bakery B',
          created_at: new Date('2026-01-02'),
          initial_review_count: null,
          initial_responded_count: null,
          baseline_captured_at: null,
        },
      ],
      counters: [
        { business_id: 'loc-A', total_received_all_time: 50, total_responded_all_time: 40, received_window: 12, responded_window: 9 },
        { business_id: 'loc-B', total_received_all_time: 3, total_responded_all_time: 2, received_window: 1, responded_window: 1 },
      ],
      velocity: [
        { business_id: 'loc-A', week_start: '2026-06-01', count: 2 },
        { business_id: 'loc-A', week_start: '2026-06-08', count: 3 },
        { business_id: 'loc-B', week_start: '2026-06-01', count: 1 },
      ],
      rating: [
        { business_id: 'loc-A', stars: 5, count: 20 },
        { business_id: 'loc-A', stars: 4, count: 5 },
        { business_id: 'loc-B', stars: 5, count: 1 },
      ],
      ranking: [
        { business_id: 'loc-A', keyword: 'coffee', snapshot_date: '2026-06-01', rank_position: 3 },
        { business_id: 'loc-A', keyword: 'coffee', snapshot_date: '2026-06-08', rank_position: 2 },
      ],
      monthly: [
        { business_id: 'loc-A', summary_text: 'Monthly A', month_start_date: '2026-06-01', sent_at: '2026-07-01T00:00:00Z' },
      ],
      weekly: [
        { business_id: 'loc-B', summary_text: 'Weekly B', week_start_date: '2026-06-30', sent_at: '2026-07-05T00:00:00Z' },
      ],
    });
  });

  it('reproduces every retained field per location via the existing mappers', async () => {
    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');

    const a = slices.get('loc-A')!;
    expect(a.valueSummary).toEqual({
      totalReviewsHandled: 40,
      totalTimeSavedMinutes: 280, // 40 × MINUTES_SAVED_PER_RESPONSE (7)
      currentResponseRate: 80, // round(40/50 × 100)
      baselineResponseRate: 30, // round(30/100 × 100)
    });
    }));
    pushWave({ pending: [], baseline, counters: [], velocity: [], rating: [], ranking: [], monthly: [], weekly: [] });
  }

  it('issues the same number of SQL statements for 2 and 5 locations', async () => {
    emptyWave(2);
    await fetchPerLocationAggregateSlices(mockSql, 'acc-2', '30d');
    const twoLocationQueries = harness.sqlCalls.length;

    harness.resetMockSql();
    emptyWave(5);
    await fetchPerLocationAggregateSlices(mockSql, 'acc-5', '30d');
    const fiveLocationQueries = harness.sqlCalls.length;

    expect(twoLocationQueries).toBe(8);
    expect(fiveLocationQueries).toBe(twoLocationQueries);
  });
});

describe('getPendingApprovalCountsForAccount', () => {
  it('buckets the authoritative pending count per business_id, account-scoped', async () => {
    harness.sqlReturnQueue.push([
      { business_id: 'loc-A', count: 25 },
      { business_id: 'loc-B', count: 13 },
    ]);

    const counts = await getPendingApprovalCountsForAccount(mockSql, 'acc-1');

    expect(counts.get('loc-A')).toBe(25);
    expect(counts.get('loc-B')).toBe(13);
    expect(counts.get('loc-absent')).toBeUndefined();

    const call = harness.sqlCalls[0]!;
    expect(call.text).toContain('account_id');
    expect(call.text).toContain('GROUP BY resp.business_id');
    expect(call.text).toContain("resp.status = 'pending_approval'");
    expect(call.text).toContain('flagged_responses');
    expect(call.values).toContain('acc-1');
  });
});

// Type-level guard: the exported slice shape stays in sync with what the service
// consumes (compile-time only; keeps the contract honest for the rewire).
const _sliceShape: PerLocationAggregateSlice | undefined = undefined;
void _sliceShape;
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
// not mocked here — the fragment-aware createMockSql harness stands in for `sql`
// directly. The set-based aggregate wave is mocked at the seam
// (fetchPerLocationAggregateSlices); the service under test is now a pure
// composition of slices → AggregateDashboardData.

const { mockFetchSlices } = vi.hoisted(() => ({
  mockFetchSlices: vi.fn(),
}));
vi.mock('@/lib/dashboard/aggregate-queries', () => ({
  fetchPerLocationAggregateSlices: (...args: unknown[]) => mockFetchSlices(...args),
}));

// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
// always-miss so every test exercises a fresh computation.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: async () => null,
    set: async () => 'OK',
  }),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date('2026-01-01') },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date('2026-01-02') },
  ]),
}));

// Import AFTER mocks are set up.
import { getAggregateDashboardData } from '../aggregate-service';
import { authoritativePendingCount } from '../scope';
import { buildRatingBreakdown } from '../rating-breakdown';
import type { PerLocationAggregateSlice } from '../aggregate-queries';
import type { RatingBreakdown } from '../types';

let harness: MockSqlHarness;
let mockSql: Sql;

/** A per-location aggregate slice with sensible defaults; override per test. */
function makeSlice(overrides: Partial<PerLocationAggregateSlice> = {}): PerLocationAggregateSlice {
  return {
    valueSummary: {
      totalReviewsHandled: 0,
      totalTimeSavedMinutes: 0,
      currentResponseRate: 0,
      baselineResponseRate: null,
    },
    reviewVelocity: [],
    ranking: null,
    ratingBreakdown: buildRatingBreakdown([]),
    latestBrief: null,
    recentReviewCount: 0,
    pendingApprovalCount: 0,
    windowedReceived: 0,
    windowedResponded: 0,
    ...overrides,
  };
}

const MONTHLY_BRIEF = { text: 'Monthly A', type: 'monthly' as const, periodLabel: 'June 2026' };

/** Two-location fixture used across the byte-identical + windowed-rate cases. */
function twoLocationSlices(ratingA?: RatingBreakdown, ratingB?: RatingBreakdown): Map<string, PerLocationAggregateSlice> {
  return new Map<string, PerLocationAggregateSlice>([
    ['loc-1', makeSlice({
      valueSummary: { totalReviewsHandled: 40, totalTimeSavedMinutes: 280, currentResponseRate: 80, baselineResponseRate: 30 },
      reviewVelocity: [{ weekStart: '2026-06-01', count: 2 }, { weekStart: '2026-06-08', count: 3 }],
      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-06-01', position: 3 }, { date: '2026-06-08', position: 2 }] }],
      ratingBreakdown: ratingA ?? buildRatingBreakdown([{ stars: 5, count: 2 }, { stars: 1, count: 1 }]),
      latestBrief: MONTHLY_BRIEF,
      recentReviewCount: 2,
      pendingApprovalCount: 25,
      windowedReceived: 12,
      windowedResponded: 9,
    })],
    ['loc-2', makeSlice({
      valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 50, baselineResponseRate: 20 },
      reviewVelocity: [{ weekStart: '2026-06-01', count: 1 }, { weekStart: '2026-06-08', count: 4 }],
      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-06-01', position: 2 }, { date: '2026-06-08', position: 5 }] }],
      ratingBreakdown: ratingB ?? buildRatingBreakdown([{ stars: 5, count: 3 }, { stars: 4, count: 4 }]),
      latestBrief: null,
      recentReviewCount: 2,
      pendingApprovalCount: 13,
      windowedReceived: 8,
      windowedResponded: 5,
    })],
  ]);
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  mockFetchSlices.mockReset();
  // sql call order: [account billing row, account-wide recent-reviews feed].
  harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
});

describe('getAggregateDashboardData — byte-identical composition from slices', () => {
  beforeEach(() => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
  });

  it('sums value summary, merges velocity/ranking, and rolls up briefs', async () => {
    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.valueSummary.totalReviewsHandled).toBe(50);
    expect(result.valueSummary.totalTimeSavedMinutes).toBe(350);
    expect(result.valueSummary.baselineResponseRate).toBe(30); // primary (loc-1)

    // Velocity: per-week sum across locations.
    expect(result.reviewVelocity).toEqual([
      { weekStart: '2026-06-01', count: 3 },
      { weekStart: '2026-06-08', count: 7 },
    ]);

    // Ranking: best (lowest) position across locations per keyword/date.
    expect(result.ranking).toEqual([
      { keyword: 'coffee', snapshots: [
        { date: '2026-06-01', position: 2 },
        { date: '2026-06-08', position: 2 },
src/lib/dashboard/__tests__/service.cache.test.ts:40:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.cache.test.ts:58:    harness = createMockSql();
src/lib/dashboard/__tests__/service.cache.test.ts:73:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts:82:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:99:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:186:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.feed-projection.test.ts:21:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.feed-projection.test.ts:38:  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
src/lib/dashboard/__tests__/service.feed-projection.test.ts:56:    harness = createMockSql();
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:78:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:119:    harness = createMockSql();
src/lib/dashboard/__tests__/service.degradation.test.ts:69:  harness.sqlReturnQueue.push(...results);
src/lib/dashboard/__tests__/service.degradation.test.ts:74:    harness = createMockSql();
src/lib/dashboard/__tests__/service.degradation.test.ts:113:    harness.sqlReturnQueue[0] = [];
src/lib/dashboard/__tests__/aggregate-queries.test.ts:3:import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
src/lib/dashboard/__tests__/aggregate-queries.test.ts:17:  harness = createMockSql();
src/lib/dashboard/__tests__/aggregate-queries.test.ts:37:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-queries.test.ts:153:    expect(harness.sqlCalls).toHaveLength(8);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:154:    for (const call of harness.sqlCalls) {
src/lib/dashboard/__tests__/aggregate-queries.test.ts:232:    const twoLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:237:    const fiveLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:246:    harness.sqlReturnQueue.push([
src/lib/dashboard/__tests__/aggregate-queries.test.ts:257:    const call = harness.sqlCalls[0]!;
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:3:import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:30:  harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:47:  return harness.sqlCalls.find((call) => call.text.includes('GROUP BY star_rating'))?.text ?? '';
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:52:    harness = createMockSql();
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:88:    const call = harness.sqlCalls[RATING_BREAKDOWN_CALL];
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:100:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(30);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:106:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(7);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:110:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(90);
src/lib/dashboard/__tests__/aggregate-service.test.ts:3:import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
src/lib/dashboard/__tests__/aggregate-service.test.ts:96:  harness = createMockSql();
src/lib/dashboard/__tests__/aggregate-service.test.ts:100:  harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
src/lib/dashboard/__tests__/aggregate-service.test.ts:199:    harness.sqlReturnQueue.length = 0;
src/lib/dashboard/__tests__/aggregate-service.test.ts:200:    harness.sqlReturnQueue.push(
src/lib/dashboard/__tests__/aggregate-service.test.ts:238:    harness.sqlReturnQueue.push([{ locations_included: 1, locations_paid: 0 }]);

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '1,112p' docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
sed -n '1,260p' worker/__tests__/helpers/mock-sql.ts
sed -n '360,430p' src/lib/dashboard/aggregate-service.ts
sed -n '225,275p' src/lib/dashboard/service.ts
sed -n '180,265p' src/lib/dashboard/__tests__/aggregate-service.test.ts" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

> v2 after codex plan-review round 1 (REVISE): property test rebuilt on the
> real export + isolated business (BLOCKER), five missing-test findings folded
> into T1/T4/T5/T7, fragment-aware test doubles specified (the v1 mock claim
> was wrong for queue-based doubles), all tasks serialized with path-scoped
> staging. Full triage: docs/reviews/feat-730-open-flag-consolidation/.

**Goal:** Consolidate every owner-facing surfacing spelling of the open-flag
predicate onto one composable fragment `openFlagExistsSql`, owned by
`src/lib/moderation/held-draft.ts`, leaving the deliberately-distinct
consumers alone with the divergence recorded on the owner module.

**Architecture:** Deepen the existing `held-draft.ts` module (the semantic
owner of "is this draft held") with one new interface member — a fragment
builder in the `statusArraySql` house pattern
(`src/lib/shared/response-status-sql.ts`). The 7 owner-facing files (8 inline
spellings) then compose the fragment instead of re-spelling the predicate;
`hasOpenFlag`'s body is re-expressed on the same fragment so the
`response_id`-correlation + `status='open'` semantics are spelled exactly
once. The 8 deliberately-distinct consumers (#725 inventory) are untouched.

**Tech stack:** Postgres.js nested-fragment splicing (verified round 1:
postgres 3.4.9 recursively splices nested Query fragments in all three
composition contexts; `SELECT 1 AS one WHERE EXISTS (...)` without FROM is
valid), vitest, fast-check (house style:
`src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).

**Intake:** `.feature/intake.json` (committed copy:
`docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`).
**Research deliverable:** #725's closing comment.

**Verified planning facts** (round-1 review re-verified all of these):

- `flagged_responses` is NOT in `TENANT_TABLES` — the fragment adds no new
  audit surface; `hasOpenFlag` needs no allowlist entry today.
- Exactly 8 inline spellings exist. The six allowlist entries containing them
  key on `table: "responses"` / `"review_escalations"` (lines ~327, ~1285,
  ~1509, ~1516, ~1530, ~1537); they regenerate IN PLACE, `ALLOWLIST_BASELINE`
  stays 409. Snippets store verbatim source text normalized by
  `normalizeSql(stripSqlComments(...))`; SQL comments never appear in them.
  pending-count is directly scoped and has NO entry — confirm no new one
  appears.
- Flag statuses (migration 051 CHECK): `open`, `approved_for_owner_review`,
  `dismissed_false_positive`, `requires_regeneration`; partial unique index on
  `status = 'open'` → `fc.subarray` (subset ⇒ at most one `open`).
- The Reviews-list export is **`loadPastRepliesPageView`** (there is no
  `loadReplies`). The integration suite's static seeds already include
  unheld `pending_approval` responses on the suite's business — property and
  count tests MUST run on an isolated business and treat the suite business's
  counts as a baseline to be left undisturbed.
- **Test doubles are NOT uniformly safe under fragment migration.**
  `mkTx` (held-draft.test.ts) returns the same rows for every call — safe.
  The route/dashboard doubles `shift()` a result QUEUE per tagged call —
  a fragment-building call would eat the queued row meant for the executed
  query. Every queue-based suite touched by migration gets the
  fragment-aware double below (build-calls captured but NOT consuming).

**Fragment-aware double (house pattern for this branch, used in T4/T5):**

```ts
const isExecutedStatement = (text: string) =>
  /^\s*(select|insert|update|delete|with)\b/i.test(text);

const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?');
  readCalls.push({ text, values });
  // Fragment builds (`resp.id`, `EXISTS (...)`) are captured for assertions
  // but must NOT consume the queued result of the outer executed query.
  if (!isExecutedStatement(text)) return { fragmentText: text, values };
  return Promise.resolve(readQueue.shift() ?? []);
});
```

---

## File structure (locked)

| File | Change |
|---|---|
| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql`; `hasOpenFlag` body re-expressed; + divergence comment block |
| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment test; contract test; + T7 source-scan test; assertion updates |
| `src/lib/past-replies/load-replies.ts` | inline EXISTS → fragment; stale `#680` comment rewritten |
| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + pinning test, + property (isolated business), + grouped-count test, + live hasOpenFlag test |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | fragment-aware double + alias-correlation assertions |
| `src/app/api/dashboard/past-replies/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
| `src/app/api/dashboard/past-replies/__tests__/**` | fragment-aware double + alias-correlation assertions |
| `src/lib/dashboard/service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
| `src/lib/dashboard/aggregate-service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
| `src/lib/dashboard/pending-count.ts` | BOTH spellings → `AND NOT ${fragment}` |
| `src/lib/dashboard/__tests__/**` | fragment-aware double where queue-based + placement/polarity assertions |
| `src/lib/agents/read.ts` | anti-join → `AND NOT ${fragment}` |
| `src/lib/agents/__tests__/read.integration.test.ts` | + exclusion test + newest-unheld fallback test |
| `src/lib/agents/__tests__/read.test.ts` | assertion updates (if any pin the join text) |
| `scripts/ci/tenant-scope-allowlist.ts` | 6 `sqlSnippet` strings regenerated in place; baseline stays 409 |

No new files. No new dependencies.

## Dispatch order — FULLY SERIAL

T1 → T2 → T3 → T4 → T5 → T6 → T7. (v1 ran T6 parallel to T3–T5; round 1
killed that: tasks share the worktree Git index and `git add -A` could stage
a sibling's half-done work. All commits below are PATH-SCOPED — never
`git add -A`.) T1 still runs alone first as the enforcement spot check.

---

// Shared Postgres.js mock + worker-logger mock for worker unit suites.
//
// NOT a test file: the vitest include glob only matches `**/__tests__/**/*.test.{ts,tsx}`,
// so this helper is invisible to the runner and only ever loaded by suites
// that import it.
//
// Because `vi.hoisted` executes before static imports are initialized, consumers
// must construct the harness via a dynamic import inside an async hoisted block:
//
//   const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
//     const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
//     return { ...createMockSql() };
//   });
//   vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));

import { vi, type Mock } from 'vitest';

/** One awaited query, with nested fragments flattened into the parent text. */
export interface RecordedSqlCall {
  /** Query text with every bound value replaced by `?`. */
  text: string;
  /** Bound values in placeholder order (nested-fragment values inlined). */
  values: unknown[];
  /** True when the query was awaited inside a `sql.begin(...)` callback. */
  inTransaction: boolean;
}

interface MockQueryFragment {
  __mockSqlFragment: true;
  text: string;
  values: unknown[];
  then: (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
}

export type MockSql = Mock<(strings: TemplateStringsArray, ...values: unknown[]) => MockQueryFragment> & {
  begin: Mock<(
    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
    callback?: (tx: unknown) => Promise<unknown>,
  ) => Promise<unknown>>;
  /**
   * Stand-in for Postgres.js's `sql.json(value)` (real behavior: tags the
   * value as a JSONB-typed bind parameter, serialized exactly once).
   * Identity pass-through here — tests assert on the plain object the
   * production code builds, not on any wire encoding.
   */
  json: Mock<(value: unknown) => unknown>;
};

export interface MockSqlHarness {
  /**
   * Tagged-template mock standing in for the Postgres.js `sql` client.
   * `mockSql.mock.calls` records every invocation as `[strings, ...values]`
   * (including unawaited nested fragments); use `sqlCalls` for the awaited,
   * fragment-flattened view.
   */
  mockSql: MockSql;
  /**
   * FIFO of results for awaited queries. Push tagged count arrays
   * (`mkTaggedResult`), plain row arrays, or a (pre-handled) rejected Promise
   * to simulate a query failure. An empty queue yields `[] & { count: 0 }`.
   */
  sqlReturnQueue: unknown[];
  /** Awaited queries in execution order, as `{ text, values, inTransaction }`. */
  sqlCalls: RecordedSqlCall[];
  /**
   * True while a `sql.begin(...)` callback is in flight. `sqlCalls` already
   * carries this per query; call it from a mocked collaborator (a run-spine
   * writer, an audit-log writer) to assert that collaborator ran inside the
   * SAME transaction as the state change — invariant #2's actual claim.
   */
  isInTransaction: () => boolean;
  /** Clears `sqlReturnQueue` + `sqlCalls` (call in `beforeEach`). */
  resetMockSql: () => void;
}

/**
 * Postgres.js result arrays carry a `count` property (rows affected).
 * Mutates and returns `rows` so identity-based assertions keep working.
 */
export function mkTaggedResult<T>(rows: T[]): T[] & { count: number } {
  return Object.assign(rows, { count: rows.length });
}

/**
 * Fragment-aware Postgres.js mock.
 *
 * Mirrors real Postgres.js semantics: sql`` returns a LAZY thenable, so a
 * nested fragment (e.g. a conditional `sql\`AND …\`` / `sql\`\`` filter)
 * composes into the parent query's text without executing or consuming the
 * return queue. Only awaited queries record into `sqlCalls` and shift
 * `sqlReturnQueue`.
 *
 * Caveat (unlike real Postgres.js): fragments are await-once — awaiting the
 * same fragment twice re-executes it (records again and shifts the queue again).
 *
 * `sql.begin(cb)` and `sql.begin(options, cb)` invoke `cb` with the same mock,
 * so transactional code paths share the one queue and call log. The options
 * argument remains visible in `mockSql.begin.mock.calls` for isolation-mode
 * assertions, and every call awaited while `cb` is in flight records
 * `inTransaction: true` — which is what distinguishes "written in the same
 * transaction as the state change" from "written next to it".
 */
export function createMockSql(): MockSqlHarness {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: RecordedSqlCall[] = [];
  let openTransactions = 0;
  const isInTransaction = () => openTransactions > 0;

  const isFragment = (value: unknown): value is MockQueryFragment =>
    Boolean(value && typeof value === 'object' && (value as MockQueryFragment).__mockSqlFragment);

  const taggedTemplate = vi.fn((strings: TemplateStringsArray, ...values: unknown[]): MockQueryFragment => {
    let text = strings[0] ?? '';
    const flatValues: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (isFragment(value)) {
        text += value.text;
        flatValues.push(...value.values);
      } else {
        text += '?';
        flatValues.push(value);
      }
      text += strings[i + 1] ?? '';
    }
    return {
      __mockSqlFragment: true,
      text,
      values: flatValues,
      then(resolve, reject) {
        sqlCalls.push({ text, values: flatValues, inTransaction: isInTransaction() });
        const queued = sqlReturnQueue.shift();
        const result = queued !== undefined ? queued : mkTaggedResult([]);
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  });

  const mockSql = taggedTemplate as MockSql;
  mockSql.begin = vi.fn(async (
    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
    callback?: (tx: unknown) => Promise<unknown>,
  ) => {
    const transactionCallback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;
    if (!transactionCallback) throw new Error('mock sql.begin requires a callback');
    openTransactions++;
    try {
      return await transactionCallback(mockSql);
    } finally {
      openTransactions--;
    }
  });
  mockSql.json = vi.fn((value: unknown) => value);

  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    isInTransaction,
    resetMockSql: () => {
      sqlReturnQueue.length = 0;
      sqlCalls.length = 0;
    },
  };
}

export interface MockWorkerLogger {
  log: Mock;
  warn: Mock;
  error: Mock;
}

/**
 * Stand-in for a `createWorkerLogger` logger. Wire it up in a module mock:
 *
 *   vi.mock('../../../../src/lib/shared/logger', () => ({
 *     createWorkerLogger: () => mockLogger,
 *   }));
 */
export function mockWorkerLogger(): MockWorkerLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
// ── Account-wide recent reviews (combined feed) ─────────────────────────────

/**
 * The 20 most recently detected reviews across ALL active locations of the
 * account, with each row's latest displayable response and open escalation —
 * the account-wide twin of the per-location recentReviews query in
 * service.ts (same LATERAL joins, same held-for-review exclusion), plus the
 * location chip columns. Sorted for display by reviewDate (matching the old
 * composed feed's presentation order).
 */
async function getAccountRecentReviews(
  sql: Sql,
  accountId: string,
): Promise<AggregateReviewItem[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      rev.id,
      rev.reviewer_name,
      rev.star_rating,
      rev.review_text,
      rev.review_date,
      rev.status,
      resp.response_text,
      resp.status AS response_status,
      resp.approval_method,
      resp.auto_post_scheduled_at,
      esc.id AS escalation_id,
      esc.status AS escalation_status,
      esc.triage_severity AS escalation_severity,
      b.id AS location_id,
      b.name AS location_name,
      b.display_label AS location_display_label
    FROM reviews rev
    JOIN businesses b ON b.id = rev.business_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at
      FROM responses
      WHERE review_id = rev.id
        -- Explicit tenant scope: responses belong to the same location as the
        -- review (defense-in-depth alongside the review_id correlation).
        AND business_id = rev.business_id
        AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
        -- Held-for-review drafts (high-severity moderation flag still open)
        -- must never surface to the owner UI; the admin queue owns them.
        AND NOT EXISTS (
          SELECT 1 FROM flagged_responses fr
          WHERE fr.response_id = responses.id AND fr.status = 'open'
        )
      ORDER BY version DESC
      LIMIT 1
    ) resp ON true
    LEFT JOIN LATERAL (
      SELECT id, status, triage_severity
      FROM review_escalations e
      WHERE e.review_id = rev.id
        -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
        AND e.business_id = rev.business_id
        -- Status literal kept deliberately: it matches the
        -- review_escalations_one_open_per_review partial-index predicate
        -- byte-for-byte so the planner can use that index.
        AND e.status <> 'resolved'
      LIMIT 1
    ) esc ON true
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND rev.status <> ${REVIEW_STATUS.DELETED}
    ORDER BY rev.detected_at DESC
    LIMIT 20
  `;

  const base = mapRecentReviews(rows);
    // Recent reviews: last 10 with latest non-superseded/failed response
    // Include pending_approval so the UI can show "check your email" reminders
    sql<Record<string, unknown>[]>`
      SELECT
        rev.id,
        rev.reviewer_name,
        rev.star_rating,
        rev.review_text,
        rev.review_date,
        rev.status,
        resp.response_text,
        resp.status AS response_status,
        resp.approval_method,
        resp.auto_post_scheduled_at,
        esc.id AS escalation_id,
        esc.status AS escalation_status,
        esc.triage_severity AS escalation_severity
      FROM reviews rev
      LEFT JOIN LATERAL (
        SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at
        FROM responses
        WHERE review_id = rev.id
          -- Explicit tenant scope: responses belong to the same location as the
          -- review (defense-in-depth alongside the review_id correlation).
          AND business_id = ${businessId}
          AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
          -- Held-for-review drafts (high-severity moderation flag still open)
          -- must never surface to the owner UI; the admin queue owns them.
          AND NOT EXISTS (
            SELECT 1 FROM flagged_responses fr
            WHERE fr.response_id = responses.id AND fr.status = 'open'
          )
        ORDER BY version DESC
        LIMIT 1
      ) resp ON true
      LEFT JOIN LATERAL (
        SELECT id, status, triage_severity
        FROM review_escalations e
        WHERE e.review_id = rev.id
          -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
          AND e.business_id = ${businessId}
          -- Status literal kept deliberately: it matches the
          -- review_escalations_one_open_per_review partial-index predicate
          -- byte-for-byte so the planner can use that index; a bound
          -- parameter could defeat the partial-index proof under a generic
          -- plan.
          AND e.status <> 'resolved'
        LIMIT 1
      ) esc ON true
      WHERE rev.business_id = ${businessId}
        AND rev.status <> ${REVIEW_STATUS.DELETED}
  it('sums the per-location windowed breakdowns into one account-wide breakdown', async () => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 5 }, // 2 + 3
      { stars: 4, count: 4 }, // 0 + 4
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 1 }, // 1 + 0
    ]);
    expect(result.ratingBreakdown.total).toBe(10);
  });
});

describe('getAggregateDashboardData — recent-reviews feed (unchanged)', () => {
  it('preserves scheduled-post and open-escalation fields from the account-wide feed', async () => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
    // Override the recent-reviews return (2nd sql call after the billing row).
    harness.sqlReturnQueue.length = 0;
    harness.sqlReturnQueue.push(
      [{ locations_included: 5, locations_paid: 0 }],
      ['loc-1', 'loc-2'].map((locationId, index) => ({
        id: `rev-${index}`,
        reviewer_name: 'Reviewer',
        star_rating: 5,
        review_text: null,
        review_date: '2026-06-01',
        status: 'pending_approval',
        response_text: 'draft',
        response_status: 'pending_approval',
        approval_method: null,
        auto_post_scheduled_at: '2026-07-13T18:00:00.000Z',
        escalation_id: 'escalation-open-1',
        escalation_status: 'escalated',
        escalation_severity: 'high',
        location_id: locationId,
        location_name: locationId === 'loc-1' ? 'Downtown Cafe' : 'Westside Bakery',
        location_display_label: locationId === 'loc-1' ? 'Downtown' : null,
      })),
    );

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.recentReviews).toHaveLength(2);
    for (const review of result.recentReviews) {
      expect(review.autoPostScheduledAt).toBe('2026-07-13T18:00:00.000Z');
      expect(review.escalation).toEqual({ id: 'escalation-open-1', status: 'escalated', severity: 'high' });
    }
    expect(result.recentReviews.map((r) => r.locationDisplayName).sort()).toEqual(['Downtown', 'Westside Bakery']);
  });
});

describe('getAggregateDashboardData — no active locations', () => {
  it('returns an all-zero payload with no partialFailures', async () => {
    const { getLocationsForAccount } = await import('@/lib/locations/repo');
    vi.mocked(getLocationsForAccount).mockResolvedValueOnce([]);
    harness.resetMockSql();
    harness.sqlReturnQueue.push([{ locations_included: 1, locations_paid: 0 }]);

    const result = await getAggregateDashboardData(mockSql, 'acc-empty');

    expect(result.activeLocationCount).toBe(0);
    expect(result.ratingBreakdown.total).toBe(0);
    expect(result.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
    expect(result.valueSummary.currentResponseRate).toBe(0);
    expect('partialFailures' in result).toBe(false);
    // No slice wave is issued when there are no active locations.
    expect(mockFetchSlices).not.toHaveBeenCalled();
  });
});

hook: PostToolUse
hook: PostToolUse Completed
codex
The cited files and line landmarks exist, but the shared SQL harness has a materially different contract from Plan v3’s example: it records only awaited, fully flattened statements in `harness.sqlCalls`; standalone fragment construction is visible through `mockSql.mock.calls`, not as separate `sqlCalls`. I’m checking whether that makes the prescribed assertions non-runnable and whether T7 has equivalent lexical escapes.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '228,255p' docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
rg -n \"it\\.todo\\(|test\\.todo\\(|openFlagExistsSql\" src/lib/moderation/__tests__/held-draft.test.ts src/app/api/dashboard/reviews/'[reviewId]'/draft-status/__tests__/route.test.ts src/lib/dashboard/__tests__/service.feed-projection.test.ts src/app/api/dashboard/past-replies/__tests__ -g '*.ts'
rg -n \"function openFlagExistsSql|openFlagExistsSql\" src/lib/moderation/held-draft.ts src/lib/past-replies/load-replies.ts src/app/api/dashboard/reviews/'[reviewId]'/draft-status/route.ts src/app/api/dashboard/past-replies/draft-status/route.ts src/lib/dashboard/service.ts src/lib/dashboard/aggregate-service.ts src/lib/dashboard/pending-count.ts src/lib/agents/read.ts
nl -ba worker/__tests__/helpers/mock-sql.ts | sed -n '1,180p'
nl -ba src/lib/dashboard/__tests__/service.feed-projection.test.ts | sed -n '1,105p'
nl -ba src/lib/dashboard/__tests__/aggregate-queries.test.ts | sed -n '246,266p'
nl -ba src/lib/dashboard/__tests__/aggregate-service.test.ts | sed -n '185,240p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:

- [ ] **Step 3: read.integration.test.ts — titles #4 and #7**

```ts
  it('getReviewTimeline excludes a response whose flag is open and includes it once closed', async () => {
    // seed review + one displayable response; INSERT open flag → timeline response null;
    // UPDATE flag to 'dismissed_false_positive' → timeline shows the response.
  });

  it('getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged', async () => {
    // seed v1 (unheld) + v2 (open-flagged, higher version) on one review:
    // timeline must return v1 — NOT null. Pins that held-filtering applies to
    // the candidate set BEFORE ORDER BY version DESC LIMIT 1 (the T6 rewrite
    // must preserve this).
  });
```

Also add `.todo` stubs where they belong:
in `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts`:
`it.todo('each draft-status awaited query projects held from its correctly correlated response alias')`;
in `src/lib/dashboard/__tests__/service.feed-projection.test.ts` (NOT
`service.test.ts` — that file does not exist):
`it.todo('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned')`.

- [ ] **Step 4: run — all green (4 todos)**

```bash
pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
     1	// Shared Postgres.js mock + worker-logger mock for worker unit suites.
     2	//
     3	// NOT a test file: the vitest include glob only matches `**/__tests__/**/*.test.{ts,tsx}`,
     4	// so this helper is invisible to the runner and only ever loaded by suites
     5	// that import it.
     6	//
     7	// Because `vi.hoisted` executes before static imports are initialized, consumers
     8	// must construct the harness via a dynamic import inside an async hoisted block:
     9	//
    10	//   const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
    11	//     const { createMockSql } = await import('../../../__tests__/helpers/mock-sql');
    12	//     return { ...createMockSql() };
    13	//   });
    14	//   vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
    15	
    16	import { vi, type Mock } from 'vitest';
    17	
    18	/** One awaited query, with nested fragments flattened into the parent text. */
    19	export interface RecordedSqlCall {
    20	  /** Query text with every bound value replaced by `?`. */
    21	  text: string;
    22	  /** Bound values in placeholder order (nested-fragment values inlined). */
    23	  values: unknown[];
    24	  /** True when the query was awaited inside a `sql.begin(...)` callback. */
    25	  inTransaction: boolean;
    26	}
    27	
    28	interface MockQueryFragment {
    29	  __mockSqlFragment: true;
    30	  text: string;
    31	  values: unknown[];
    32	  then: (
    33	    resolve: (value: unknown) => unknown,
    34	    reject?: (reason: unknown) => unknown,
    35	  ) => Promise<unknown>;
    36	}
    37	
    38	export type MockSql = Mock<(strings: TemplateStringsArray, ...values: unknown[]) => MockQueryFragment> & {
    39	  begin: Mock<(
    40	    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
    41	    callback?: (tx: unknown) => Promise<unknown>,
    42	  ) => Promise<unknown>>;
    43	  /**
    44	   * Stand-in for Postgres.js's `sql.json(value)` (real behavior: tags the
    45	   * value as a JSONB-typed bind parameter, serialized exactly once).
    46	   * Identity pass-through here — tests assert on the plain object the
    47	   * production code builds, not on any wire encoding.
    48	   */
    49	  json: Mock<(value: unknown) => unknown>;
    50	};
    51	
    52	export interface MockSqlHarness {
    53	  /**
    54	   * Tagged-template mock standing in for the Postgres.js `sql` client.
    55	   * `mockSql.mock.calls` records every invocation as `[strings, ...values]`
    56	   * (including unawaited nested fragments); use `sqlCalls` for the awaited,
    57	   * fragment-flattened view.
    58	   */
    59	  mockSql: MockSql;
    60	  /**
    61	   * FIFO of results for awaited queries. Push tagged count arrays
    62	   * (`mkTaggedResult`), plain row arrays, or a (pre-handled) rejected Promise
    63	   * to simulate a query failure. An empty queue yields `[] & { count: 0 }`.
    64	   */
    65	  sqlReturnQueue: unknown[];
    66	  /** Awaited queries in execution order, as `{ text, values, inTransaction }`. */
    67	  sqlCalls: RecordedSqlCall[];
    68	  /**
    69	   * True while a `sql.begin(...)` callback is in flight. `sqlCalls` already
    70	   * carries this per query; call it from a mocked collaborator (a run-spine
    71	   * writer, an audit-log writer) to assert that collaborator ran inside the
    72	   * SAME transaction as the state change — invariant #2's actual claim.
    73	   */
    74	  isInTransaction: () => boolean;
    75	  /** Clears `sqlReturnQueue` + `sqlCalls` (call in `beforeEach`). */
    76	  resetMockSql: () => void;
    77	}
    78	
    79	/**
    80	 * Postgres.js result arrays carry a `count` property (rows affected).
    81	 * Mutates and returns `rows` so identity-based assertions keep working.
    82	 */
    83	export function mkTaggedResult<T>(rows: T[]): T[] & { count: number } {
    84	  return Object.assign(rows, { count: rows.length });
    85	}
    86	
    87	/**
    88	 * Fragment-aware Postgres.js mock.
    89	 *
    90	 * Mirrors real Postgres.js semantics: sql`` returns a LAZY thenable, so a
    91	 * nested fragment (e.g. a conditional `sql\`AND …\`` / `sql\`\`` filter)
    92	 * composes into the parent query's text without executing or consuming the
    93	 * return queue. Only awaited queries record into `sqlCalls` and shift
    94	 * `sqlReturnQueue`.
    95	 *
    96	 * Caveat (unlike real Postgres.js): fragments are await-once — awaiting the
    97	 * same fragment twice re-executes it (records again and shifts the queue again).
    98	 *
    99	 * `sql.begin(cb)` and `sql.begin(options, cb)` invoke `cb` with the same mock,
   100	 * so transactional code paths share the one queue and call log. The options
   101	 * argument remains visible in `mockSql.begin.mock.calls` for isolation-mode
   102	 * assertions, and every call awaited while `cb` is in flight records
   103	 * `inTransaction: true` — which is what distinguishes "written in the same
   104	 * transaction as the state change" from "written next to it".
   105	 */
   106	export function createMockSql(): MockSqlHarness {
   107	  const sqlReturnQueue: unknown[] = [];
   108	  const sqlCalls: RecordedSqlCall[] = [];
   109	  let openTransactions = 0;
   110	  const isInTransaction = () => openTransactions > 0;
   111	
   112	  const isFragment = (value: unknown): value is MockQueryFragment =>
   113	    Boolean(value && typeof value === 'object' && (value as MockQueryFragment).__mockSqlFragment);
   114	
   115	  const taggedTemplate = vi.fn((strings: TemplateStringsArray, ...values: unknown[]): MockQueryFragment => {
   116	    let text = strings[0] ?? '';
   117	    const flatValues: unknown[] = [];
   118	    for (let i = 0; i < values.length; i++) {
   119	      const value = values[i];
   120	      if (isFragment(value)) {
   121	        text += value.text;
   122	        flatValues.push(...value.values);
   123	      } else {
   124	        text += '?';
   125	        flatValues.push(value);
   126	      }
   127	      text += strings[i + 1] ?? '';
   128	    }
   129	    return {
   130	      __mockSqlFragment: true,
   131	      text,
   132	      values: flatValues,
   133	      then(resolve, reject) {
   134	        sqlCalls.push({ text, values: flatValues, inTransaction: isInTransaction() });
   135	        const queued = sqlReturnQueue.shift();
   136	        const result = queued !== undefined ? queued : mkTaggedResult([]);
   137	        return Promise.resolve(result).then(resolve, reject);
   138	      },
   139	    };
   140	  });
   141	
   142	  const mockSql = taggedTemplate as MockSql;
   143	  mockSql.begin = vi.fn(async (
   144	    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
   145	    callback?: (tx: unknown) => Promise<unknown>,
   146	  ) => {
   147	    const transactionCallback = typeof optionsOrCallback === 'function'
   148	      ? optionsOrCallback
   149	      : callback;
   150	    if (!transactionCallback) throw new Error('mock sql.begin requires a callback');
   151	    openTransactions++;
   152	    try {
   153	      return await transactionCallback(mockSql);
   154	    } finally {
   155	      openTransactions--;
   156	    }
   157	  });
   158	  mockSql.json = vi.fn((value: unknown) => value);
   159	
   160	  return {
   161	    mockSql,
   162	    sqlReturnQueue,
   163	    sqlCalls,
   164	    isInTransaction,
   165	    resetMockSql: () => {
   166	      sqlReturnQueue.length = 0;
   167	      sqlCalls.length = 0;
   168	    },
   169	  };
   170	}
   171	
   172	export interface MockWorkerLogger {
   173	  log: Mock;
   174	  warn: Mock;
   175	  error: Mock;
   176	}
   177	
   178	/**
   179	 * Stand-in for a `createWorkerLogger` logger. Wire it up in a module mock:
   180	 *
     1	import { beforeEach, describe, expect, it, vi } from 'vitest';
     2	import type { Sql } from 'postgres';
     3	import {
     4	  createMockSql,
     5	  type MockSqlHarness,
     6	} from '../../../../worker/__tests__/helpers/mock-sql';
     7	
     8	vi.mock('@/lib/db/redis-cache', () => ({
     9	  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
    10	}));
    11	
    12	import { getActiveDashboardData } from '../service';
    13	
    14	let harness: MockSqlHarness;
    15	let mockSql: Sql;
    16	
    17	const BUSINESS_ID = 'biz-feed-1';
    18	
    19	function seedDashboardQueries() {
    20	  harness.resetMockSql();
    21	  harness.sqlReturnQueue.push(
    22	    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    23	    [{ count: 0 }],
    24	    [{ count: 0 }],
    25	    [],
    26	    [],
    27	    [],
    28	    [],
    29	    [],
    30	    [],
    31	    [],
    32	    [],
    33	    [],
    34	  );
    35	}
    36	
    37	function recentReviewsQuery() {
    38	  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
    39	}
    40	
    41	function lateralBody(queryText: string, alias: 'resp' | 'esc'): string {
    42	  const startMarker = 'LEFT JOIN LATERAL (';
    43	  const endMarker = `) ${alias} ON true`;
    44	  const endIndex = queryText.indexOf(endMarker);
    45	  const startIndex = queryText.lastIndexOf(startMarker, endIndex);
    46	
    47	  if (startIndex === -1 || endIndex === -1) {
    48	    throw new Error(`Missing ${alias} LATERAL join in recent-reviews query`);
    49	  }
    50	
    51	  return queryText.slice(startIndex + startMarker.length, endIndex).trim();
    52	}
    53	
    54	describe('getActiveDashboardData — feed projection', () => {
    55	  beforeEach(() => {
    56	    harness = createMockSql();
    57	    mockSql = harness.mockSql as unknown as Sql;
    58	  });
    59	
    60	  it('reads the current scheduling fields and latest displayable response', async () => {
    61	    seedDashboardQueries();
    62	
    63	    await getActiveDashboardData(mockSql, BUSINESS_ID);
    64	
    65	    const query = recentReviewsQuery();
    66	    expect(query).toBeDefined();
    67	    const responseLateral = lateralBody(query!.text, 'resp');
    68	    expect(query!.text).toContain('resp.approval_method');
    69	    expect(query!.text).toContain('resp.auto_post_scheduled_at');
    70	    expect(responseLateral).toContain(
    71	      'SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at',
    72	    );
    73	    expect(responseLateral).toContain('ORDER BY version DESC');
    74	    expect(query!.values.filter((value) => value === BUSINESS_ID)).toHaveLength(3);
    75	  });
    76	
    77	  it("uses the open-escalation partial-index predicate verbatim", async () => {
    78	    seedDashboardQueries();
    79	
    80	    await getActiveDashboardData(mockSql, BUSINESS_ID);
    81	
    82	    const query = recentReviewsQuery();
    83	    expect(query).toBeDefined();
    84	    const escalationLateral = lateralBody(query!.text, 'esc');
    85	    expect(escalationLateral).toContain("AND e.status <> 'resolved'");
    86	    expect(escalationLateral).toContain('LIMIT 1');
    87	  });
    88	});
   246	    harness.sqlReturnQueue.push([
   247	      { business_id: 'loc-A', count: 25 },
   248	      { business_id: 'loc-B', count: 13 },
   249	    ]);
   250	
   251	    const counts = await getPendingApprovalCountsForAccount(mockSql, 'acc-1');
   252	
   253	    expect(counts.get('loc-A')).toBe(25);
   254	    expect(counts.get('loc-B')).toBe(13);
   255	    expect(counts.get('loc-absent')).toBeUndefined();
   256	
   257	    const call = harness.sqlCalls[0]!;
   258	    expect(call.text).toContain('account_id');
   259	    expect(call.text).toContain('GROUP BY resp.business_id');
   260	    expect(call.text).toContain("resp.status = 'pending_approval'");
   261	    expect(call.text).toContain('flagged_responses');
   262	    expect(call.values).toContain('acc-1');
   263	  });
   264	});
   265	
   266	// Type-level guard: the exported slice shape stays in sync with what the service
   185	      { stars: 5, count: 5 }, // 2 + 3
   186	      { stars: 4, count: 4 }, // 0 + 4
   187	      { stars: 3, count: 0 },
   188	      { stars: 2, count: 0 },
   189	      { stars: 1, count: 1 }, // 1 + 0
   190	    ]);
   191	    expect(result.ratingBreakdown.total).toBe(10);
   192	  });
   193	});
   194	
   195	describe('getAggregateDashboardData — recent-reviews feed (unchanged)', () => {
   196	  it('preserves scheduled-post and open-escalation fields from the account-wide feed', async () => {
   197	    mockFetchSlices.mockResolvedValue(twoLocationSlices());
   198	    // Override the recent-reviews return (2nd sql call after the billing row).
   199	    harness.sqlReturnQueue.length = 0;
   200	    harness.sqlReturnQueue.push(
   201	      [{ locations_included: 5, locations_paid: 0 }],
   202	      ['loc-1', 'loc-2'].map((locationId, index) => ({
   203	        id: `rev-${index}`,
   204	        reviewer_name: 'Reviewer',
   205	        star_rating: 5,
   206	        review_text: null,
   207	        review_date: '2026-06-01',
   208	        status: 'pending_approval',
   209	        response_text: 'draft',
   210	        response_status: 'pending_approval',
   211	        approval_method: null,
   212	        auto_post_scheduled_at: '2026-07-13T18:00:00.000Z',
   213	        escalation_id: 'escalation-open-1',
   214	        escalation_status: 'escalated',
   215	        escalation_severity: 'high',
   216	        location_id: locationId,
   217	        location_name: locationId === 'loc-1' ? 'Downtown Cafe' : 'Westside Bakery',
   218	        location_display_label: locationId === 'loc-1' ? 'Downtown' : null,
   219	      })),
   220	    );
   221	
   222	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   223	
   224	    expect(result.recentReviews).toHaveLength(2);
   225	    for (const review of result.recentReviews) {
   226	      expect(review.autoPostScheduledAt).toBe('2026-07-13T18:00:00.000Z');
   227	      expect(review.escalation).toEqual({ id: 'escalation-open-1', status: 'escalated', severity: 'high' });
   228	    }
   229	    expect(result.recentReviews.map((r) => r.locationDisplayName).sort()).toEqual(['Downtown', 'Westside Bakery']);
   230	  });
   231	});
   232	
   233	describe('getAggregateDashboardData — no active locations', () => {
   234	  it('returns an all-zero payload with no partialFailures', async () => {
   235	    const { getLocationsForAccount } = await import('@/lib/locations/repo');
   236	    vi.mocked(getLocationsForAccount).mockResolvedValueOnce([]);
   237	    harness.resetMockSql();
   238	    harness.sqlReturnQueue.push([{ locations_included: 1, locations_paid: 0 }]);
   239	
   240	    const result = await getAggregateDashboardData(mockSql, 'acc-empty');

hook: PostToolUse
hook: PostToolUse Completed
codex
| finding # | status | one line |
|---|---|---|
| 4 | FIX-INTRODUCED-DEFECT | The cited suite, `lateralBody`, `harness.sqlCalls`, and ~261 pin exist, and the accepted residual is explicit and reasonable; however, `sqlCalls` records only awaited flattened statements, so the prescribed standalone `responses.id` correlation assertion can never pass. |
| 7 | NOT ADDRESSED | An import alone cannot match `/openFlagExistsSql\(/g`, but comments/strings can; moreover, promised tests can remain disabled via `test.todo(...)`, `it.todo (...)`, or `it['todo'](...)` because the guard matches only exact `it.todo(`. |

VERDICT: REVISE
hook: Stop
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
hook: Stop Completed
tokens used
58,001
| finding # | status | one line |
|---|---|---|
| 4 | FIX-INTRODUCED-DEFECT | The cited suite, `lateralBody`, `harness.sqlCalls`, and ~261 pin exist, and the accepted residual is explicit and reasonable; however, `sqlCalls` records only awaited flattened statements, so the prescribed standalone `responses.id` correlation assertion can never pass. |
| 7 | NOT ADDRESSED | An import alone cannot match `/openFlagExistsSql\(/g`, but comments/strings can; moreover, promised tests can remain disabled via `test.todo(...)`, `it.todo (...)`, or `it['todo'](...)` because the guard matches only exact `it.todo(`. |

VERDICT: REVISE
