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
session id: 019fe8b1-3979-79e2-9e7d-aee1822460bb
--------
user
You are the adversarial plan reviewer for a high-risk refactor in this repo
(worktree root = your cwd). Review ONLY — do not modify anything.

## What to review

1. The implementation plan:
   docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
2. The locked intake contract:
   docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json
3. The research deliverable it builds on: GitHub issue #725's closing comment
   is summarized inside the plan's "Verified planning facts" — treat the plan's
   claims as claims to verify against the actual code, not as truth.

## Primary question — the eval task

The PRIMARY review target is Task 1 (the eval task), not the plan prose:
**can this eval pass while the feature is still wrong?** Every missing failure
mode must be named as a MISSING FAILING TEST (concrete title + what it pins),
not as a prose objection. Specifically probe:

- The behavior-pinning tests are green BEFORE the refactor by design. What
  regression could the migration introduce that NONE of the five tests (nor
  the existing suites) would catch? Think: fragment renders subtly wrong SQL
  in one composition context but not another (projected vs filtered vs
  parameter-correlated); the anti-join → NOT EXISTS rewrite in
  src/lib/agents/read.ts; the two pending-count spellings; LATERAL contexts.
- The property test's agreement claim (projected held ⇔ excluded from pending
  count) — is there a flag-status combination or multi-response scenario where
  the two legitimately disagree, making the property either vacuous or flaky?
- Mock-double blindness: unit suites capture template text; after migration the
  EXISTS text moves into a separate captured call. Could a migration task
  silently DELETE an assertion instead of relocating it and still go green?

## Secondary checks

- CITED-ARTIFACT CHECK (mandatory): verify every file, line range, symbol, and
  test fixture the plan cites actually exists in the tree as described. That
  includes: src/lib/moderation/held-draft.ts (hasOpenFlag), the 8 inline
  spellings at the cited files/lines, scripts/ci/tenant-scope-allowlist.ts
  entries near lines 327/1285/1509/1516/1530/1537 with the cited table: keys,
  ALLOWLIST_BASELINE = 409, scripts/ci/tenant-tables.ts NOT containing
  flagged_responses, migration 051's CHECK status list, the
  REVIEW_HELD_REPLACEMENT fixture in
  src/lib/past-replies/__tests__/load-replies.integration.test.ts, the mkTx
  double in src/lib/moderation/__tests__/held-draft.test.ts, and
  statusArraySql in src/lib/shared/response-status-sql.ts.
- Postgres.js mechanics: does nested-fragment splicing behave as the plan
  assumes in ALL cited composition contexts (projected in a LATERAL SELECT
  list, `AND NOT ${...}`, and `WHERE ${...}` with a parameter-carrying ref
  fragment)? Is `SELECT 1 AS one WHERE EXISTS(...)` (no FROM) valid and
  equivalent to the current hasOpenFlag body?
- Plan-level: simpler alternatives, wrong assumptions, task-ordering hazards
  (T3/T4/T5 serialized on the allowlist file; T6 parallel), and whether any
  task could leave the branch red in a way the next task masks.

## Output format (strict)

1. A findings table: severity (BLOCKER/MAJOR/MINOR) | artifact | one-line finding.
   Only findings you would stake >=80% confidence on; each with a concrete
   failure scenario or a named missing test title.
2. A short low-confidence appendix (optional).
3. The LAST line must be exactly `VERDICT: APPROVED` or `VERDICT: REVISE`.
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
I’m using the `verify-spec` workflow because this is an evidence-backed plan audit. I’ll keep the repository read-only and put Task 1’s missing failure modes ahead of prose-level critique.
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
/bin/zsh -lc "wc -l .claude/CLAUDE.md .agents/skills/verify-spec/SKILL.md && sed -n '1,220p' .claude/CLAUDE.md && sed -n '221,440p' .claude/CLAUDE.md && git status --short --branch" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     219 .claude/CLAUDE.md
      71 .agents/skills/verify-spec/SKILL.md
     290 total
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
## feat-730-open-flag-consolidation...origin/main [ahead 2]
?? docs/reviews/feat-730-open-flag-consolidation/

hook: PostToolUse
hook: PostToolUse Completed
codex
The worktree is ahead of `origin/main` by two commits and has an unrelated untracked `docs/reviews/feat-730-open-flag-consolidation/` directory. I’ll audit the current worktree state but won’t rely on or alter that untracked material.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'wc -l docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json && nl -ba docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md && nl -ba docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json' in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     603 docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
      72 docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json
     675 total
     1	# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan
     2	
     3	> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
     4	> (recommended) or executing-plans to implement this plan task-by-task. Steps
     5	> use checkbox (`- [ ]`) syntax for tracking.
     6	
     7	**Goal:** Consolidate every owner-facing surfacing spelling of the open-flag
     8	predicate onto one composable fragment `openFlagExistsSql`, owned by
     9	`src/lib/moderation/held-draft.ts`, leaving the deliberately-distinct
    10	consumers alone with the divergence recorded on the owner module.
    11	
    12	**Architecture:** Deepen the existing `held-draft.ts` module (the semantic
    13	owner of "is this draft held") with one new interface member — a fragment
    14	builder in the `statusArraySql` house pattern
    15	(`src/lib/shared/response-status-sql.ts`). The 7 owner-facing files (8 inline
    16	spellings) then compose the fragment instead of re-spelling the predicate;
    17	`hasOpenFlag`'s body is re-expressed on the same fragment so the
    18	`response_id`-correlation + `status='open'` semantics are spelled exactly
    19	once. The 8 deliberately-distinct consumers (#725 inventory) are untouched.
    20	
    21	**Tech stack:** Postgres.js nested-fragment splicing (a `PendingQuery`
    22	interpolated into another template splices as raw SQL text — the lab-notes
    23	#573/#706 mechanic), vitest, fast-check (house style:
    24	`src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).
    25	
    26	**Intake:** `.feature/intake.json` (committed copy:
    27	`docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`).
    28	**Research deliverable:** #725's closing comment (classified inventory, chosen
    29	shape, divergence sink).
    30	
    31	**Verified planning facts** (checked against the tree at fork, 2026-08-09):
    32	
    33	- `flagged_responses` is NOT in `TENANT_TABLES` (`scripts/ci/tenant-tables.ts`)
    34	  — the tenant-scope auditor never audits it directly. The fragment adds no new
    35	  audit surface, and `hasOpenFlag` today needs no allowlist entry for the same
    36	  reason.
    37	- The six allowlist entries whose `sqlSnippet` contains the migrating predicate
    38	  key on `table: "responses"` / `"review_escalations"`, NOT `flagged_responses`:
    39	  lines ~327 (past-replies draft-status), ~1285 (load-replies main), ~1509 +
    40	  ~1516 (service.ts), ~1530 + ~1537 (aggregate-service.ts). They regenerate **in
    41	  place** — count unchanged, `ALLOWLIST_BASELINE` stays 409. Snippets store
    42	  VERBATIM source text (interpolations appear as `${...}` source), normalized
    43	  by `normalizeSql(stripSqlComments(...))` — SQL comments do NOT appear in
    44	  snippets, so comment rewrites never touch the allowlist.
    45	- Flag statuses (migration `051_flagged_responses.sql` CHECK): `open`,
    46	  `approved_for_owner_review`, `dismissed_false_positive`,
    47	  `requires_regeneration`. Partial index machinery exists on
    48	  `WHERE status = 'open'` — the property test generates a SUBSET of the four
    49	  statuses (`fc.subarray`), so it never inserts two `open` rows per response.
    50	- Test doubles: `held-draft.test.ts` `mkTx` and the route-test `sqlMock`s
    51	  capture tagged-template calls and return `Promise.resolve(rows)` for every
    52	  call. After migration, building a nested fragment registers EXTRA captured
    53	  calls and splices a Promise into `values`; the executed query still resolves
    54	  the queued rows, but `toHaveLength(1)`-style call-count assertions and
    55	  outer-text `toContain('FROM flagged_responses')` assertions move to the
    56	  fragment's own captured call. Each migration task updates its suite's
    57	  assertions accordingly.
    58	- `load-replies.integration.test.ts` already seeds `flagged_responses`
    59	  (INSERT at ~line 138; held-replacement fixture `REVIEW_HELD_REPLACEMENT`,
    60	  cleanup at ~line 208) — crib its seed shape. `read.integration.test.ts` has
    61	  NO flag coverage today; the timeline test is genuinely new.
    62	
    63	---
    64	
    65	## File structure (locked)
    66	
    67	| File | Change |
    68	|---|---|
    69	| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql` fragment builder; `hasOpenFlag` body re-expressed on it; + "deliberately distinct consumers" divergence comment block |
    70	| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment rendering test; contract test; call-count assertion updates |
    71	| `src/lib/past-replies/load-replies.ts` | inline EXISTS → fragment; stale `#680` comment rewritten |
    72	| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + behavior-pinning test + fast-check property |
    73	| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
    74	| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | assertion updates only |
    75	| `src/app/api/dashboard/past-replies/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
    76	| `src/app/api/dashboard/past-replies/__tests__/**` | assertion updates only |
    77	| `src/lib/dashboard/service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
    78	| `src/lib/dashboard/aggregate-service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
    79	| `src/lib/dashboard/pending-count.ts` | BOTH spellings → `AND NOT ${fragment}` |
    80	| `src/lib/dashboard/__tests__/**` | assertion updates only |
    81	| `src/lib/agents/read.ts` | anti-join (`LEFT JOIN … fr.id IS NULL`) → `AND NOT ${fragment}` |
    82	| `src/lib/agents/__tests__/read.integration.test.ts` | + timeline exclusion test |
    83	| `src/lib/agents/__tests__/read.test.ts` | assertion updates only (if any pin the join text) |
    84	| `scripts/ci/tenant-scope-allowlist.ts` | 6 `sqlSnippet` strings regenerated in place; baseline stays 409 |
    85	
    86	No new files. No new dependencies.
    87	
    88	## Blocking edges / dispatch order
    89	
    90	- **T1 (eval)** runs first, ALONE (first-task enforcement spot check).
    91	- **T2 (owner module)** blocks every migration task.
    92	- **T3 → T4 → T5 SERIAL** — all three edit `scripts/ci/tenant-scope-allowlist.ts`.
    93	- **T6 independent of T3–T5** (agents/read.ts has no allowlist entry with the
    94	  predicate) — may run in parallel with the T3–T5 chain after T2.
    95	- **T7 (gate)** last.
    96	
    97	---
    98	
    99	### Task 1: Eval task — behavior-pinning tests + promised-test stubs
   100	
   101	**Files:**
   102	- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
   103	- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
   104	- Modify: `src/lib/agents/__tests__/read.integration.test.ts`
   105	
   106	These are the spec in executable form. The behavior-pinning tests must be
   107	GREEN before any implementation task (they pin current behavior across the
   108	refactor); the fragment-rendering test is a `.todo` stub until T2 fills it.
   109	All five intake `tests_to_add` titles land VERBATIM in this task (the gate's
   110	`promised-tests` row checks titles, `.todo` included).
   111	
   112	- [ ] **Step 1: held-draft.test.ts — add the two titles**
   113	
   114	Append inside `describe('hasOpenFlag', …)`:
   115	
   116	```ts
   117	  it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
   118	    // Same double, both branches — pins the contract across the #730 body
   119	    // re-expression (rows.length > 0 stays the decision rule).
   120	    const open = mkTx([{ one: 1 }]);
   121	    await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
   122	    const closed = mkTx([]);
   123	    await expect(hasOpenFlag(closed.tx, RESPONSE_ID)).resolves.toBe(false);
   124	  });
   125	```
   126	
   127	Append a new top-level describe:
   128	
   129	```ts
   130	describe('openFlagExistsSql', () => {
   131	  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
   132	});
   133	```
   134	
   135	- [ ] **Step 2: load-replies.integration.test.ts — behavior-pinning + property**
   136	
   137	Read the suite first; crib the existing `REVIEW_HELD_REPLACEMENT` seed and the
   138	FK-ordered cleanup (`DELETE FROM flagged_responses …` before responses). Add,
   139	inside the suite's existing live-DB describe (respecting its
   140	`assertSchemaReady` / lock conventions):
   141	
   142	```ts
   143	  it('a held draft still projects draft_held true after the fragment migration', async () => {
   144	    // Behavior-pinning (green BEFORE and AFTER #730): the Reviews list
   145	    // projects held-ness (D9 SELECTed-not-filtered) rather than dropping the
   146	    // row. Reuses the REVIEW_HELD_REPLACEMENT fixture seeded above.
   147	    const view = await loadReplies(sql(), businessId, 1);
   148	    const heldRow = view!.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
   149	    expect(heldRow).toBeDefined();
   150	    // draft_held is the projected fragment output — the wire never sees 'held'
   151	    // (CONTEXT.md "Reviews list"); the projection is what deriveRowAction
   152	    // consumes server-side.
   153	    expect(heldRow!.draft_held ?? heldRow!.row_action === 'none').toBeTruthy();
   154	  });
   155	```
   156	
   157	(The exact projected field the suite can see depends on what `loadReplies`
   158	returns post-#727 — `draft_held` on the raw row or `row_action 'none'` on the
   159	view. Match the suite's existing held-replacement assertions; the TITLE is
   160	locked, the assertion mirrors the neighbouring #727 held case.)
   161	
   162	```ts
   163	  it('property: projected held and filtered visibility agree for every flag-row status combination', async () => {
   164	    // Invariant #4 as a property: for ANY set of flag rows on a
   165	    // pending_approval draft, the projected predicate (draft held) and the
   166	    // filtered predicate (pending-count exclusion) must agree — they are the
   167	    // same fragment used in two modes. Bounded runs: live-DB roundtrips.
   168	    const FLAG_STATUSES = [
   169	      'open',
   170	      'approved_for_owner_review',
   171	      'dismissed_false_positive',
   172	      'requires_regeneration',
   173	    ] as const;
   174	    await fc.assert(
   175	      fc.asyncProperty(fc.subarray([...FLAG_STATUSES]), async (statuses) => {
   176	        // seed: one pending_approval response on a dedicated review row
   177	        // (INSERT shape cribbed from the suite's existing flagged_responses
   178	        // seed at ~line 138), one flag row per generated status
   179	        // (fc.subarray → at most one 'open', respecting the partial unique
   180	        // index on status='open').
   181	        // ... seed review + response + flag rows ...
   182	        const expectHeld = statuses.includes('open');
   183	        const view = await loadReplies(sql(), businessId, 1);
   184	        const count = await getPendingApprovalCount(sql(), businessId);
   185	        // projected mode: the row's draft is held iff an open flag exists
   186	        // filtered mode: the pending count excludes the draft iff held
   187	        expect(/* row projected as held */).toBe(expectHeld);
   188	        expect(count).toBe(expectHeld ? 0 : 1);
   189	        // ... FK-ordered cleanup ...
   190	      }),
   191	      { numRuns: 12 },
   192	    );
   193	  });
   194	```
   195	
   196	Import `fc` from `fast-check` and `getPendingApprovalCount` from
   197	`@/lib/dashboard/pending-count`. The property seeds/cleans INSIDE the
   198	predicate (per-run isolation); keep the fixture ids distinct from the suite's
   199	static seeds so the existing cases are undisturbed. Flesh the elided seed /
   200	assertion lines out against the suite's real helpers — the STRUCTURE above
   201	(subarray → seed → two reads → agree → cleanup) and `numRuns: 12` are locked.
   202	
   203	- [ ] **Step 3: read.integration.test.ts — timeline exclusion**
   204	
   205	Read the suite for its seed helpers, then add:
   206	
   207	```ts
   208	  it('getReviewTimeline excludes a response whose flag is open and includes it once closed', async () => {
   209	    // Behavior-pinning for the T6 anti-join → NOT EXISTS rewrite: the
   210	    // timeline hides a held draft (invariant #4) and shows it again after
   211	    // the admin disposition closes the flag.
   212	    // seed: review + pending_approval response (suite helpers), then:
   213	    // 1. INSERT flagged_responses row (status 'open') → timeline response null
   214	    // 2. UPDATE the flag to 'dismissed_false_positive' → timeline shows it
   215	  });
   216	```
   217	
   218	(Complete the body with the suite's own seed helpers; both assertions go
   219	through `getReviewTimeline(sql(), { accountId, reviewId })`.)
   220	
   221	- [ ] **Step 4: run — pinning tests GREEN, stub todo**
   222	
   223	```bash
   224	cd <worktree> && pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
   225	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts
   226	```
   227	
   228	Expected: all green (1 todo). If the live-DB suites fail on schema, run
   229	`pnpm test:db:setup` once first.
   230	
   231	- [ ] **Step 5: Commit**
   232	
   233	```bash
   234	git add -A && git commit -m "test(#730): eval task — pin held-draft behavior across the predicate consolidation"
   235	```
   236	
   237	### Task 2: `openFlagExistsSql` + re-expressed `hasOpenFlag` + divergence block
   238	
   239	**Files:**
   240	- Modify: `src/lib/moderation/held-draft.ts`
   241	- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
   242	
   243	- [ ] **Step 1: fill the `.todo` test (red)**
   244	
   245	Replace the `.todo` with (mkTx captures the fragment build as its own call):
   246	
   247	```ts
   248	describe('openFlagExistsSql', () => {
   249	  it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
   250	    const { tx, calls } = mkTx([]);
   251	    openFlagExistsSql(tx, tx`resp.id`);
   252	    // two captured calls: the ref fragment, then the EXISTS wrapper
   253	    const exists = calls.at(-1)!;
   254	    expect(exists.text).toContain('EXISTS (');
   255	    expect(exists.text).toContain('FROM flagged_responses fr');
   256	    expect(exists.text).toContain("fr.status = 'open'");
   257	    expect(exists.text).toContain('fr.response_id = ');
   258	  });
   259	});
   260	```
   261	
   262	Run: `pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts` —
   263	expected FAIL (`openFlagExistsSql` not exported).
   264	
   265	- [ ] **Step 2: implement in `held-draft.ts`**
   266	
   267	```ts
   268	import type postgres from 'postgres';
   269	
   270	type TxClient = postgres.TransactionSql;
   271	type DbClient = postgres.Sql | postgres.TransactionSql;
   272	
   273	/**
   274	 * The one read-side spelling of "response X has an OPEN moderation flag".
   275	 * Composable Postgres.js fragment (nested queries splice as raw SQL text), so
   276	 * it works projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` —
   277	 * D9 SELECTed-not-filtered sites) and filtered
   278	 * (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}` — dashboard reads).
   279	 * `ref` is itself a fragment: a correlated column ref (sql`resp.id`) or a
   280	 * bound parameter (tx`${responseId}::uuid`). Client-agnostic like
   281	 * statusArraySql — pass the surrounding query's client.
   282	 */
   283	export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
   284	  return db`EXISTS (
   285	    SELECT 1 FROM flagged_responses fr
   286	    WHERE fr.response_id = ${ref} AND fr.status = 'open'
   287	  )`;
   288	}
   289	```
   290	
   291	(If `postgres.PendingQuery<postgres.Row[]>` fights the tagged-template return
   292	type, mirror however `statusArraySql`'s return type is inferred — do NOT cast
   293	through `any`; `postgres.Fragment` is the v3 alternative.)
   294	
   295	Re-express `hasOpenFlag` (signature and contract UNCHANGED):
   296	
   297	```ts
   298	export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
   299	  const rows = await tx<{ one: number }[]>`
   300	    SELECT 1 AS one
   301	    WHERE ${openFlagExistsSql(tx, tx`${responseId}::uuid`)}
   302	  `;
   303	  return rows.length > 0;
   304	}
   305	```
   306	
   307	- [ ] **Step 3: divergence comment block**
   308	
   309	Extend the module's contract header (after the existing release-disposition
   310	lines) — the #725 §3 sink:
   311	
   312	```ts
   313	// Deliberately distinct consumers — do NOT consolidate onto this module.
   314	// Four categories read/write flagged_responses with DIFFERENT semantics, and
   315	// force-fitting them is how a shared helper acquires a boolean parameter
   316	// meaning "actually a different query" (full 16-consumer inventory: #725):
   317	//   - Admin surfaces (/api/admin/flagged, flagged-service, nav-counts): their
   318	//     subject is the FLAG ROW itself (disposition by id, queue enumeration,
   319	//     cross-tenant badge count) — not a response's held-ness.
   320	//   - Health alerting (health-alert/checks.ts): cross-tenant COUNT of open
   321	//     rows vs threshold; worker alerting must not couple to an owner-UI read.
   322	//   - Offboarding purge lane (purge-verification, purge-stages,
   323	//     table-disposition): deliberately IGNORES status — a closed flag left
   324	//     behind is still a purge violation.
   325	//   - The producer (response-generation/persist.ts): writes the flag row and
   326	//     keeps its own module-local status const (different lifecycle).
   327	```
   328	
   329	- [ ] **Step 4: update existing text-pinning assertions**
   330	
   331	The re-expressed body makes `mkTx` capture 3 calls (ref build, fragment
   332	build, executed query). In the existing test
   333	`"filters on status = 'open' and the response id — the predicate that makes the hold binding"`:
   334	drop `expect(calls).toHaveLength(1)`; assert over ALL captured text instead:
   335	
   336	```ts
   337	    const allText = calls.map((c) => c.text).join('\n');
   338	    expect(allText).toContain("status = 'open'");
   339	    expect(allText).toContain('FROM flagged_responses');
   340	    expect(calls.flatMap((c) => c.values)).toContain(RESPONSE_ID);
   341	```
   342	
   343	- [ ] **Step 5: run + commit**
   344	
   345	```bash
   346	pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts   # all green
   347	pnpm typecheck
   348	git add -A && git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
   349	```
   350	
   351	### Task 3: Migrate `load-replies.ts` + regen allowlist entry (~1285)
   352	
   353	**Files:**
   354	- Modify: `src/lib/past-replies/load-replies.ts:230-244`
   355	- Modify: `scripts/ci/tenant-scope-allowlist.ts` (`load-replies` main-query entry)
   356	- Check: `src/lib/past-replies/__tests__/` unit suites for outer-text assertions
   357	
   358	- [ ] **Step 1: rewrite the spelling + the stale comment**
   359	
   360	Old (the comment cites #680, which never did the consolidation):
   361	
   362	```
   363	      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
   364	      -- held while an open flagged_responses row exists". Its hasOpenFlag is an
   365	      -- in-tx, post-lock release gate taking a TransactionSql — it cannot be
   366	      -- composed into a LATERAL — so the predicate is spelled inline here (D6);
   367	      -- consolidating the spellings into one exported fragment is a #680 item.
   368	      LEFT JOIN LATERAL (
   369	        SELECT
   370	          resp2.id,
   371	          EXISTS (
   372	            SELECT 1
   373	            FROM flagged_responses f
   374	            WHERE f.response_id = resp2.id
   375	              AND f.status = 'open'
   376	          ) AS held
   377	```
   378	
   379	New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`):
   380	
   381	```
   382	      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
   383	      -- held while an open flagged_responses row exists"; this projection
   384	      -- composes its openFlagExistsSql fragment (#730). Projected, not
   385	      -- filtered (D9): a held draft must stay distinguishable from "no draft".
   386	      LEFT JOIN LATERAL (
   387	        SELECT
   388	          resp2.id,
   389	          ${openFlagExistsSql(sql, sql`resp2.id`)} AS held
   390	```
   391	
   392	(Use the client variable actually in scope in that function — read the file.)
   393	
   394	- [ ] **Step 2: regen the allowlist entry**
   395	
   396	```bash
   397	pnpm ci:tenant-scope 2>&1 | tail -30
   398	```
   399	
   400	Expected: FAIL naming `src/lib/past-replies/load-replies.ts` with the
   401	newly-extracted query text. Paste that text into the existing entry's
   402	`sqlSnippet` (file ~line 1285, `table: "responses"`). Entry COUNT unchanged —
   403	do not touch `ALLOWLIST_BASELINE`. Re-run; expected PASS.
   404	
   405	- [ ] **Step 3: run + commit**
   406	
   407	```bash
   408	pnpm vitest run src/lib/past-replies
   409	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
   410	git add -A && git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
   411	```
   412	
   413	If a unit suite pinned the outer query text containing the inline EXISTS,
   414	update it to expect the fragment call shape instead (see the Task 2 pattern).
   415	
   416	### Task 4: Migrate the two draft-status routes + regen entry (~327)
   417	
   418	**Files:**
   419	- Modify: `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:57-75`
   420	- Modify: `src/app/api/dashboard/past-replies/draft-status/route.ts:109-127`
   421	- Modify: `scripts/ci/tenant-scope-allowlist.ts` (past-replies draft-status entry ~327)
   422	- Check: both routes' test suites for outer-text/call-count assertions
   423	
   424	- [ ] **Step 1: reviews/[reviewId]/draft-status — rewrite**
   425	
   426	Comment block: keep the F5/invariant-#4 rationale and the D9 sentence; replace
   427	the two sentences claiming the predicate "spells … inline instead (D6)" with:
   428	
   429	```ts
   430	    // That module is the SEMANTIC OWNER of "is this draft held"; this read
   431	    // path composes its openFlagExistsSql fragment (#730).
   432	```
   433	
   434	Query: replace
   435	
   436	```
   437	        EXISTS (
   438	          SELECT 1 FROM flagged_responses f
   439	          WHERE f.response_id = resp.id AND f.status = 'open'
   440	        ) AS held
   441	```
   442	
   443	with
   444	
   445	```
   446	        ${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held
   447	```
   448	
   449	(build the fragment with the client executing the query — here `sqlRead`).
   450	
   451	- [ ] **Step 2: past-replies/draft-status — rewrite**
   452	
   453	Same treatment: the D6 sentence becomes "composes its openFlagExistsSql
   454	fragment (#730)"; the projected EXISTS becomes
   455	`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held` (this query's
   456	correlated ref is the unaliased table: `responses.id`).
   457	
   458	- [ ] **Step 3: regen entry ~327, run, commit**
   459	
   460	```bash
   461	pnpm ci:tenant-scope 2>&1 | tail -30   # fails naming past-replies/draft-status; paste new snippet
   462	pnpm vitest run "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies
   463	git add -A && git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
   464	```
   465	
   466	(The reviews route has no allowlist entry — it binds `resp.business_id`; only
   467	the past-replies entry regenerates. Update any route-test assertions that
   468	pinned `FROM flagged_responses` in the OUTER captured text — the fragment now
   469	registers its own captured call.)
   470	
   471	### Task 5: Migrate the dashboard trio + regen 4 entries (~1509/1516/1530/1537)
   472	
   473	**Files:**
   474	- Modify: `src/lib/dashboard/service.ts:253-256`
   475	- Modify: `src/lib/dashboard/aggregate-service.ts:404-407`
   476	- Modify: `src/lib/dashboard/pending-count.ts:17-20,45-48`
   477	- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries)
   478	- Check: `src/lib/dashboard/__tests__/` for text assertions
   479	
   480	- [ ] **Step 1: service.ts + aggregate-service.ts**
   481	
   482	Both LATERALs keep their two comments (tenant-scope + held-drafts rationale);
   483	the filter block
   484	
   485	```
   486	          AND NOT EXISTS (
   487	            SELECT 1 FROM flagged_responses fr
   488	            WHERE fr.response_id = responses.id AND fr.status = 'open'
   489	          )
   490	```
   491	
   492	becomes
   493	
   494	```
   495	          AND NOT ${openFlagExistsSql(sql, sql`responses.id`)}
   496	```
   497	
   498	(correlated ref is the unaliased `responses` table in both LATERALs; use each
   499	query's in-scope client variable).
   500	
   501	- [ ] **Step 2: pending-count.ts — BOTH spellings**
   502	
   503	In `getPendingApprovalCount` and `getPendingApprovalCountsForAccount`:
   504	
   505	```
   506	      AND NOT EXISTS (
   507	        SELECT 1 FROM flagged_responses fr
   508	        WHERE fr.response_id = resp.id AND fr.status = 'open'
   509	      )
   510	```
   511	
   512	becomes
   513	
   514	```
   515	      AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
   516	```
   517	
   518	Import `openFlagExistsSql` in all three files.
   519	
   520	- [ ] **Step 3: regen entries, run, commit**
   521	
   522	```bash
   523	pnpm ci:tenant-scope 2>&1 | tail -40   # 4 mismatches: service ×2, aggregate ×2 — paste each
   524	pnpm vitest run src/lib/dashboard
   525	git add -A && git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
   526	```
   527	
   528	(pending-count has NO allowlist entry — its queries are directly scoped;
   529	confirm `ci:tenant-scope` passes without adding one.)
   530	
   531	### Task 6: `agents/read.ts` — anti-join → NOT EXISTS (parallel-safe with T3–T5)
   532	
   533	**Files:**
   534	- Modify: `src/lib/agents/read.ts:317-334` (`getReviewTimeline` response query)
   535	- Check: `src/lib/agents/__tests__/read.test.ts` for join-text assertions
   536	
   537	- [ ] **Step 1: rewrite**
   538	
   539	Old:
   540	
   541	```
   542	      FROM responses resp
   543	      JOIN businesses b ON b.id = resp.business_id
   544	      LEFT JOIN flagged_responses fr
   545	        ON fr.response_id = resp.id AND fr.status = 'open'
   546	      WHERE resp.review_id = ${params.reviewId}
   547	        AND b.account_id = ${params.accountId}
   548	        AND b.archived_at IS NULL
   549	        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
   550	        AND fr.id IS NULL
   551	```
   552	
   553	New (semantics-preserving: LEFT JOIN + `fr.id IS NULL` ⇔ NOT EXISTS; add a
   554	one-line comment naming invariant #4 + the owner module):
   555	
   556	```
   557	      FROM responses resp
   558	      JOIN businesses b ON b.id = resp.business_id
   559	      WHERE resp.review_id = ${params.reviewId}
   560	        AND b.account_id = ${params.accountId}
   561	        AND b.archived_at IS NULL
   562	        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
   563	        -- Held drafts never surface on the timeline (invariant #4);
   564	        -- src/lib/moderation/held-draft.ts owns the predicate (#730).
   565	        AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
   566	```
   567	
   568	- [ ] **Step 2: run + commit**
   569	
   570	```bash
   571	pnpm vitest run src/lib/agents
   572	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/agents/__tests__/read.integration.test.ts
   573	git add -A && git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
   574	```
   575	
   576	(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched. No
   577	allowlist work in this task, which is what makes it parallel-safe.)
   578	
   579	### Task 7: Verify gate
   580	
   581	- [ ] `cd <worktree> && bash scripts/verify-gate.sh` — full run, all rows PASS;
   582	  `promised-tests` finds all five titles; `reclassify` inside 2× both buckets.
   583	- [ ] Fix fallout (each fix re-runs the gate); on the same failure class twice,
   584	  STOP per the anti-thrash rule.
   585	- [ ] Final pre-review run: `bash scripts/verify-gate.sh --review`
   586	  (diff-coverage row on).
   587	
   588	---
   589	
   590	## Self-review (done at write time)
   591	
   592	- **Spec coverage:** #725 §2's four "Concretely for #730" bullets → T2 (fragment
   593	  + hasOpenFlag + no new helpers), T3–T6 (both usage modes at all 8 spellings);
   594	  §3 divergence sink → T2 step 3; #730's "divergence recorded" → same; #725
   595	  notes 1–5 → allowlist regen steps (T3/T4/T5), stale-#680-comment rewrites
   596	  (T3/T4), pending-count both spellings (T5), net-negative expectation
   597	  (intake), verification commands (intake + T1/T3/T6).
   598	- **Placeholder scan:** the two integration-test bodies are deliberately
   599	  structure-locked with elided seed lines (the suite's own helpers are the
   600	  precedent to follow, per anti-slop "precedent over invention") — each names
   601	  the exact fixture/helper to crib and locks title + assertion shape. No TBDs.
   602	- **Type consistency:** `openFlagExistsSql(db, ref)` spelled identically in
   603	  T2–T6; ref always the executing client's fragment.
     1	{
     2	  "classification": "high",
     3	  "surface": "mixed",
     4	  "db_touching": true,
     5	  "goal": "Consolidate every owner-facing surfacing spelling of the open-flag predicate onto one composable fragment (openFlagExistsSql) owned by src/lib/moderation/held-draft.ts — the semantic owner of 'is this draft held' — leaving the deliberately-distinct consumers alone with the divergence recorded on the owner module (#725 deliverable, #730 build half).",
     6	  "non_goals": [
     7	    "No change to the 8 deliberately-distinct consumers: admin disposition (/api/admin/flagged), admin queue (flagged-service), admin badge (nav-counts-service), health-alert backlog check, offboarding purge-verification + purge-stages + table-disposition, and the producer (response-generation/persist.ts keeps its module-local FLAGGED_RESPONSE_STATUS_OPEN)",
     8	    "No higher-level read helpers — the shape is fragment + retained hasOpenFlag only (#725 §2)",
     9	    "No behavior change anywhere — every rewrite is semantics-preserving",
    10	    "No new CONTEXT.md glossary term — the divergence note lives as a comment block on the owner module (#725 §3)",
    11	    "No shared helper growing a boolean parameter meaning 'actually a different query' (the failure mode this scoping exists to prevent)",
    12	    "No touch to worker/jobs/publisher/held-flag-gate.ts or the other hasOpenFlag call sites — they are already on the owner"
    13	  ],
    14	  "user_visible_behavior": [
    15	    "None. Held drafts remain projected (SELECTed-not-filtered, D9) on the two draft-status routes and the Reviews list, and remain excluded from dashboard reads, pending counts, and the review timeline — byte-identical result sets"
    16	  ],
    17	  "invariants": [
    18	    "Invariant #4 as structure: a held draft never surfaces its text or an affordance to the owner — projected sites stay SELECTed-not-filtered (D9); filtered sites keep excluding held rows",
    19	    "hasOpenFlag keeps its exact signature and in-tx post-FOR-UPDATE release-gate contract; none of its call sites move",
    20	    "After migration, the read-side 'open' literal is spelled only inside openFlagExistsSql in held-draft.ts",
    21	    "Tenant scoping of every migrated query is unchanged; ALLOWLIST_BASELINE stays 409 — snippet text regenerates in place, no entry adds or removes",
    22	    "The 8 deliberately-distinct consumers keep their own spellings on purpose"
    23	  ],
    24	  "edge_cases": [
    25	    "src/lib/agents/read.ts getReviewTimeline: null-filtered anti-join (LEFT JOIN flagged_responses … AND fr.id IS NULL) rewrites to NOT EXISTS via the fragment — must preserve the timeline row set exactly",
    26	    "src/lib/dashboard/pending-count.ts has TWO spellings (per-business count + account-grouped sibling); both migrate",
    27	    "The fragment's correlated ref must compose in three contexts: qualified column refs (resp.id, resp2.id, responses.id) inside LATERAL/correlated subqueries, and hasOpenFlag's ${responseId}::uuid parameter — ref parameter is a Postgres.js fragment, not a string",
    28	    "scripts/ci/tenant-scope-allowlist.ts keys on verbatim SQL source text — every entry whose sqlSnippet contains a migrated predicate (at least load-replies main query, service.ts, aggregate-service.ts, pending-count, past-replies draft-status) regenerates in the same PR (the feat-719 gate-block trap, #725 note 1)",
    29	    "The stale D6 comments in draft-status/route.ts and load-replies.ts cite '#680 item' for a consolidation #680 never did — they are rewritten as part of the migration",
    30	    "past-replies/draft-status/route.ts (added by #726, after #725's 6-file table was drawn) carries an inline projected EXISTS — it joins the migration set, making it 7 files / 8 inline spellings"
    31	  ],
    32	  "existing_patterns_to_follow": [
    33	    "src/lib/shared/response-status-sql.ts (statusArraySql) — the house pattern for a composable Postgres.js SQL fragment builder, already interpolated by draft-status/route.ts",
    34	    "src/lib/moderation/held-draft.ts contract-header comment style — the divergence note extends it",
    35	    "Postgres.js nested-Query splicing (lab-notes #573/#706 mechanic) — fragments compose into LATERAL/correlated contexts as raw SQL text"
    36	  ],
    37	  "allowed_edit_surface": [
    38	    "src/lib/moderation/held-draft.ts",
    39	    "src/lib/moderation/__tests__/held-draft.test.ts",
    40	    "src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts",
    41	    "src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/**",
    42	    "src/app/api/dashboard/past-replies/draft-status/route.ts",
    43	    "src/app/api/dashboard/past-replies/__tests__/**",
    44	    "src/lib/past-replies/load-replies.ts",
    45	    "src/lib/past-replies/__tests__/**",
    46	    "src/lib/dashboard/service.ts",
    47	    "src/lib/dashboard/aggregate-service.ts",
    48	    "src/lib/dashboard/pending-count.ts",
    49	    "src/lib/dashboard/__tests__/**",
    50	    "src/lib/agents/read.ts",
    51	    "src/lib/agents/__tests__/**",
    52	    "scripts/ci/tenant-scope-allowlist.ts"
    53	  ],
    54	  "tests_to_add": [
    55	    "openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref",
    56	    "hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes",
    57	    "a held draft still projects draft_held true after the fragment migration",
    58	    "getReviewTimeline excludes a response whose flag is open and includes it once closed",
    59	    "property: projected held and filtered visibility agree for every flag-row status combination"
    60	  ],
    61	  "verification_commands": [
    62	    "pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts"
    63	  ],
    64	  "estimated_prod_lines": "±140 (held-draft.ts +~45 incl. divergence comment block; 8 spelling swaps net-negative ~-25 code; D6 comment rewrites; ~8 allowlist snippet lines regenerated). Code is net-negative; the divergence comment block offsets some of it in raw line count",
    65	  "estimated_test_lines": "±300 (new fragment unit tests + 2 integration titles + 1 bounded fast-check property; churn in SQL-text-pinning mock suites: draft-status route tests, dashboard aggregate-queries/service tests, agents read tests)",
    66	  "dependencies_added": [],
    67	  "rollback_plan": "No migration, no flag, no schema touch — db_touching covers read-query text only. Back out = revert the squash-merge commit on main; nothing to unwind in either Supabase project",
    68	  "observability": [
    69	    "No new runtime signal — semantics-preserving refactor. A regression would surface as held drafts appearing in owner reads (invariant #4 leak); guarded pre-merge by the two live-DB integration suites + the D9 projected assertions + ci:tenant-scope/ci:rls-audit green, not by a new prod metric. Post-deploy staging smoke: pending count and Reviews list for a location with a known held draft match pre-deploy values"
    70	  ],
    71	  "open_questions": []
    72	}

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/list_projects started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/list_projects (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_code started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_code (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/trace_path started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/trace_path (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'nl -ba src/lib/moderation/held-draft.ts; nl -ba src/lib/moderation/__tests__/held-draft.test.ts; nl -ba src/lib/shared/response-status-sql.ts; nl -ba src/lib/shared/__tests__/response-status-sql.test.ts; nl -ba src/lib/past-replies/__tests__/load-replies.integration.test.ts; nl -ba src/lib/dashboard/pending-count.ts; nl -ba src/lib/agents/__tests__/read.integration.test.ts' in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     1	// Held-draft gate ─────────────────────────────────────────────────────────
     2	//
     3	// A high-severity moderation flag writes a `flagged_responses` row (status
     4	// 'open') and leaves the draft at `pending_approval` (see
     5	// ResponseGeneratorWorker.persistResponseAndNotify). Suppressing the owner
     6	// email is NOT enough on its own — the dashboard renders pending drafts and
     7	// the owner can approve/edit/publish them directly. This module is the
     8	// shared gate that makes the hold actually binding: every owner-facing
     9	// release path must call `hasOpenFlag` (in-tx, post-lock) and refuse to act
    10	// while a flag is open.
    11	//
    12	// The flag is released only by an admin disposition at /admin/flagged:
    13	//   - approved_for_owner_review → flag closed, draft released
    14	//   - dismissed_false_positive  → flag closed, draft released (was safe)
    15	//   - requires_regeneration     → flag closed AND draft superseded + regenerated
    16	
    17	import type postgres from 'postgres';
    18	
    19	type TxClient = postgres.TransactionSql;
    20	
    21	/** Thrown by owner release paths when a draft is held for admin moderation review. */
    22	export class HeldForReviewError extends Error {
    23	  constructor() {
    24	    super('held_for_review');
    25	    this.name = 'HeldForReviewError';
    26	  }
    27	}
    28	
    29	/**
    30	 * Returns true when an OPEN moderation flag exists for the response. Callers
    31	 * should already hold a `FOR UPDATE` lock on the response row so the check is
    32	 * serialized against the admin disposition that closes the flag.
    33	 */
    34	export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
    35	  const rows = await tx<{ one: number }[]>`
    36	    SELECT 1 AS one
    37	    FROM flagged_responses
    38	    WHERE response_id = ${responseId}::uuid AND status = 'open'
    39	    LIMIT 1
    40	  `;
    41	  return rows.length > 0;
    42	}
     1	// Direct unit coverage for the held-draft gate (launch-audit part1, P1 test
     2	// gap): a typo in hasOpenFlag's status='open' predicate would silently
     3	// release admin-held drafts to owners. Previously covered only indirectly
     4	// via integration tests.
     5	import { describe, it, expect } from 'vitest';
     6	import { hasOpenFlag, HeldForReviewError } from '../held-draft';
     7	
     8	type TxCall = { text: string; values: unknown[] };
     9	
    10	/** Minimal tagged-template tx double — enough for hasOpenFlag's single query. */
    11	function mkTx(rows: unknown[]) {
    12	  const calls: TxCall[] = [];
    13	  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    14	    calls.push({ text: strings.raw.join('$'), values });
    15	    return Promise.resolve(rows);
    16	  }) as never;
    17	  return { tx, calls };
    18	}
    19	
    20	const RESPONSE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';
    21	
    22	describe('hasOpenFlag', () => {
    23	  it('returns true when an open flag row exists', async () => {
    24	    const { tx } = mkTx([{ one: 1 }]);
    25	    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(true);
    26	  });
    27	
    28	  it('returns false when no open flag exists', async () => {
    29	    const { tx } = mkTx([]);
    30	    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(false);
    31	  });
    32	
    33	  it("filters on status = 'open' and the response id — the predicate that makes the hold binding", async () => {
    34	    const { tx, calls } = mkTx([]);
    35	    await hasOpenFlag(tx, RESPONSE_ID);
    36	    expect(calls).toHaveLength(1);
    37	    const [query] = calls;
    38	    expect(query!.text).toContain("status = 'open'");
    39	    expect(query!.text).toContain('FROM flagged_responses');
    40	    expect(query!.values).toContain(RESPONSE_ID);
    41	  });
    42	});
    43	
    44	describe('HeldForReviewError', () => {
    45	  it('carries the held_for_review message and name', () => {
    46	    const err = new HeldForReviewError();
    47	    expect(err.message).toBe('held_for_review');
    48	    expect(err.name).toBe('HeldForReviewError');
    49	    expect(err).toBeInstanceOf(Error);
    50	  });
    51	});
     1	import type postgres from 'postgres';
     2	
     3	/**
     4	 * Binds a response-status group as a Postgres `text[]` array fragment for use
     5	 * in `status = ANY(${statusArraySql(db, GROUP)})` READ predicates. Reproduces
     6	 * the codebase's existing `${[...GROUP] as string[]}::text[]` array-binding
     7	 * convention exactly — it never emits an `IN (${...})` list, which Postgres.js
     8	 * v3 would expand into one bind per value and change the generated predicate
     9	 * shape.
    10	 *
    11	 * Takes the caller's `sql`/`tx` client explicitly (injection convention): the
    12	 * fragment is client-agnostic to compose (it is never executed on its own), so
    13	 * passing the surrounding query's client is byte-identical. Keeping the client
    14	 * a parameter lets the canonical const module (response-status.ts) stay a
    15	 * zero-dependency pure module — importers of the status groups pull them in
    16	 * without a transitive `sql` / DB import.
    17	 */
    18	export function statusArraySql(db: postgres.Sql | postgres.TransactionSql, statuses: readonly string[]) {
    19	  return db`${[...statuses] as string[]}::text[]`;
    20	}
     1	import { describe, it, expect, afterAll } from 'vitest';
     2	import postgres from 'postgres';
     3	import { statusArraySql } from '../response-status-sql';
     4	import { HANDLED_STATUSES } from '../response-status';
     5	
     6	// statusArraySql now takes its `sql`/`tx` client explicitly (injection
     7	// convention). Postgres.js is lazy — constructing a client opens no socket, and
     8	// statusArraySql only BUILDS a fragment (never awaits it), so this stays a pure
     9	// unit test with no DB. A real client (not a stub) keeps the assertions below
    10	// meaningful: the return value is a genuine Postgres.js fragment object.
    11	const db = postgres('postgres://user:pass@localhost:5432/response_status_test', {
    12	  prepare: false,
    13	});
    14	
    15	afterAll(async () => {
    16	  await db.end({ timeout: 0 });
    17	});
    18	
    19	describe('statusArraySql (pure shape)', () => {
    20	  it('returns a Postgres.js fragment object, not a raw string', () => {
    21	    const fragment = statusArraySql(db, HANDLED_STATUSES);
    22	    expect(typeof fragment).not.toBe('string');
    23	    expect(fragment).toBeTypeOf('object');
    24	    expect(fragment).not.toBeNull();
    25	  });
    26	
    27	  it('does not throw and accepts any readonly status group', () => {
    28	    expect(() => statusArraySql(db, HANDLED_STATUSES)).not.toThrow();
    29	    expect(() => statusArraySql(db, ['approved', 'edited'])).not.toThrow();
    30	  });
    31	});
     1	// src/lib/past-replies/__tests__/load-replies.integration.test.ts
     2	//
     3	// T1 EVAL suite for #678 — the LIVE half of the Reviews list query.
     4	//
     5	// The mocked suite (`reviews-list.test.ts`) asserts the SHAPE of the SQL the
     6	// loader issues; this asserts the statement actually RUNS against the real
     7	// schema: the LEFT JOIN + four LATERALs compile, `ORDER BY (resp.id IS NOT NULL)`
     8	// really puts Unanswered first in Postgres' own collation, and the two group
     9	// COUNTs really denominate over ALL reviews rather than posted-only ones. A
    10	// mocked `sql` tag structurally cannot prove any of that — it returns whatever
    11	// the fixture says regardless of what the SQL means.
    12	//
    13	// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
    14	// `*.integration.test.ts` so vitest serializes it in the `integration` project,
    15	// gated by `describeWithDb`, ASSERTS its schema with `assertSchemaReady`, and
    16	// NEVER applies migration SQL — provisioning is `pnpm test:db:setup`'s job.
    17	
    18	import { randomUUID } from 'node:crypto';
    19	import { afterAll, beforeAll, expect, it, vi } from 'vitest';
    20	import postgres from 'postgres';
    21	import type postgresType from 'postgres';
    22	import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
    23	import {
    24	  cleanupTenantAccount,
    25	  seedTenantAccount,
    26	  type TenantSeed,
    27	} from '@/lib/shared/__tests__/live-db-tenant';
    28	import {
    29	  assertSchemaReady,
    30	  MIGRATION_100_IMPORT_CONSENT,
    31	} from '@/lib/shared/__tests__/helpers/schema-ready';
    32	import { REVIEW_STATUS } from '@/lib/reviews/status';
    33	import { PAGE_SIZE } from '../replies-view';
    34	import { loadPastRepliesPageView } from '../load-replies';
    35	
    36	// The batched regen-budget peek is an Upstash read, orthogonal to ordering and
    37	// denominators. Stub it so this suite needs only Postgres. (Its own fail-open
    38	// contract lives in src/lib/costs/__tests__/regen-budget-batch.test.ts.)
    39	vi.mock('@/lib/costs/tracker', () => ({
    40	  peekRegenBudgetBatch: vi.fn(async () => new Map()),
    41	}));
    42	
    43	const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
    44	
    45	let db: postgresType.Sql | undefined;
    46	let tenant: TenantSeed | undefined;
    47	const businessId = randomUUID();
    48	
    49	function sql(): postgresType.Sql {
    50	  if (!db) throw new Error('reviews-list integration database was not initialized');
    51	  return db;
    52	}
    53	
    54	interface ReviewsListView {
    55	  unansweredRows: { review_id: string; reply_state: string; row_action: string }[];
    56	  answeredRows: { review_id: string; reply_state: string; row_action: string }[];
    57	  unansweredTotal: number;
    58	  answeredTotal: number;
    59	  avgStarRating: number | null;
    60	  totalPages: number;
    61	}
    62	
    63	// Deterministic ids so the assertions can name rows rather than positions.
    64	const REVIEW_ANSWERED_NEW = randomUUID();
    65	const REVIEW_ANSWERED_OLD = randomUUID();
    66	const REVIEW_UNANSWERED_NEW = randomUUID();
    67	const REVIEW_UNANSWERED_OLD = randomUUID();
    68	const RESPONSE_NEW = randomUUID();
    69	const RESPONSE_OLD = randomUUID();
    70	const REVIEW_HELD_REPLACEMENT = randomUUID();
    71	const RESPONSE_HELD_POSTED = randomUUID();
    72	const RESPONSE_HELD_DRAFT = randomUUID();
    73	const REVIEW_READY_CONTROL = randomUUID();
    74	const RESPONSE_READY_POSTED = randomUUID();
    75	const RESPONSE_READY_DRAFT = randomUUID();
    76	const REVIEW_CLOSED_CONTROL = randomUUID();
    77	const RESPONSE_CLOSED_POSTED = randomUUID();
    78	const RESPONSE_CLOSED_DRAFT = randomUUID();
    79	const HELD_DRAFT_TEXT = 'held replacement draft SECRET sentinel';
    80	
    81	async function seedReview(
    82	  reviewId: string,
    83	  starRating: number,
    84	  reviewDateIso: string,
    85	  status: string,
    86	): Promise<void> {
    87	  await sql()`
    88	    INSERT INTO reviews (
    89	      id, business_id, provider, provider_review_id, provider_review_name,
    90	      provider_location_name, reviewer_name, star_rating, review_text,
    91	      review_date, status
    92	    ) VALUES (
    93	      ${reviewId}::uuid, ${businessId}::uuid, 'zernio',
    94	      ${`revlist-${reviewId}`}, ${`zernio://revlist/reviews/${reviewId}`},
    95	      'zernio://revlist/locations/1', 'Reviews List Customer',
    96	      ${starRating}, 'Reviews list fixture review',
    97	      ${reviewDateIso}::timestamptz, ${status}
    98	    )
    99	  `;
   100	}
   101	
   102	async function seedPostedResponse(responseId: string, reviewId: string): Promise<void> {
   103	  await sql()`
   104	    INSERT INTO responses (
   105	      id, review_id, business_id, response_text, original_draft_text,
   106	      approved_text, response_language, version, status, approval_method, posted_at
   107	    ) VALUES (
   108	      ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
   109	      'Thank you!', 'Thank you!', 'Thank you!', 'en', 1, 'posted', 'owner', NOW()
   110	    )
   111	  `;
   112	}
   113	
   114	// A non-terminal replacement draft (version 2) beside a live posted reply.
   115	// `posted` is outside the responses_one_non_terminal_per_review predicate, so
   116	// the pair coexists — exactly the Regenerate-in-flight shape.
   117	async function seedReplacementDraft(
   118	  reviewId: string,
   119	  draftId: string,
   120	  responseText: string,
   121	): Promise<void> {
   122	  await sql()`
   123	    INSERT INTO responses (
   124	      id, review_id, business_id, response_text, original_draft_text,
   125	      response_language, version, status
   126	    ) VALUES (
   127	      ${draftId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
   128	      ${responseText}, ${responseText}, 'en', 2, 'pending_approval'
   129	    )
   130	  `;
   131	}
   132	
   133	// Status literals are spelled inline the same way the loader's LATERAL spells
   134	// `f.status = 'open'` (D6; src/lib/moderation/held-draft.ts is the semantic
   135	// owner). `api_cost_id` is nullable — deliberately omitted.
   136	async function seedFlag(reviewId: string, draftId: string, status: string): Promise<void> {
   137	  await sql()`
   138	    INSERT INTO flagged_responses (
   139	      id, response_id, account_id, business_id, review_id,
   140	      source, reason, severity, status
   141	    ) VALUES (
   142	      ${randomUUID()}::uuid, ${draftId}::uuid, ${tenant!.accountId}::uuid,
   143	      ${businessId}::uuid, ${reviewId}::uuid,
   144	      'local_regex', 'reviews-list integration fixture hold', 'high', ${status}
   145	    )
   146	  `;
   147	}
   148	
   149	describeWithDb('Reviews list query against live Postgres', { timeout: 30_000 }, () => {
   150	  beforeAll(async () => {
   151	    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
   152	    // #678 ships NO migration, so there is no requirement of its own to name.
   153	    // 100 is asserted as the head proxy: it is the newest requirement touching
   154	    // `businesses`, and a container behind it fails loudly with the actionable
   155	    // `pnpm test:db:setup` message instead of surfacing as a confusing
   156	    // assertion failure inside a title about ordering.
   157	    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
   158	    tenant = await seedTenantAccount(db, {
   159	      userName: 'Reviews List Owner',
   160	      accountDisplayName: 'Reviews List Account',
   161	    });
   162	    await sql()`
   163	      UPDATE accounts SET subscription_activated_at = '2026-03-01T00:00:00Z'::timestamptz
   164	      WHERE id = ${tenant.accountId}::uuid
   165	    `;
   166	    await sql()`
   167	      INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
   168	      VALUES (${businessId}::uuid, 'Reviews List Location', 'Reviews List Owner',
   169	              ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
   170	    `;
   171	
   172	    // Two answered + two unanswered, deliberately interleaved in time so a
   173	    // date-only ORDER BY would put an answered row first.
   174	    await seedReview(REVIEW_ANSWERED_NEW, 5, '2026-07-01T00:00:00Z', REVIEW_STATUS.POSTED);
   175	    await seedReview(REVIEW_ANSWERED_OLD, 4, '2026-05-01T00:00:00Z', REVIEW_STATUS.POSTED);
   176	    await seedReview(REVIEW_UNANSWERED_NEW, 2, '2026-06-01T00:00:00Z', REVIEW_STATUS.NEW);
   177	    await seedReview(REVIEW_UNANSWERED_OLD, 1, '2026-04-01T00:00:00Z', REVIEW_STATUS.NEW);
   178	    await seedPostedResponse(RESPONSE_NEW, REVIEW_ANSWERED_NEW);
   179	    await seedPostedResponse(RESPONSE_OLD, REVIEW_ANSWERED_OLD);
   180	
   181	    // #727: three answered rows with a replacement draft — held, ready, and
   182	    // closed-flag. All rate 3 so the avg assertion stays 3 = (5+4+2+1+3+3+3)/7;
   183	    // the dates sort them after the existing answered rows.
   184	    await seedReview(REVIEW_HELD_REPLACEMENT, 3, '2026-02-01T00:00:00Z', REVIEW_STATUS.POSTED);
   185	    await seedPostedResponse(RESPONSE_HELD_POSTED, REVIEW_HELD_REPLACEMENT);
   186	    await seedReplacementDraft(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_DRAFT, HELD_DRAFT_TEXT);
   187	    await seedFlag(REVIEW_HELD_REPLACEMENT, RESPONSE_HELD_DRAFT, 'open');
   188	
   189	    // Negative control 1: identical shape, NO flag → the draft is ready, not held.
   190	    await seedReview(REVIEW_READY_CONTROL, 3, '2026-01-15T00:00:00Z', REVIEW_STATUS.POSTED);
   191	    await seedPostedResponse(RESPONSE_READY_POSTED, REVIEW_READY_CONTROL);
   192	    await seedReplacementDraft(REVIEW_READY_CONTROL, RESPONSE_READY_DRAFT, 'ready replacement draft');
   193	
   194	    // Negative control 2: identical shape, flag exists but is NOT open.
   195	    // 'dismissed_false_positive' verified against the migration 051 status
   196	    // CHECK ('open' | 'approved_for_owner_review' | 'dismissed_false_positive'
   197	    // | 'requires_regeneration').
   198	    await seedReview(REVIEW_CLOSED_CONTROL, 3, '2026-01-10T00:00:00Z', REVIEW_STATUS.POSTED);
   199	    await seedPostedResponse(RESPONSE_CLOSED_POSTED, REVIEW_CLOSED_CONTROL);
   200	    await seedReplacementDraft(REVIEW_CLOSED_CONTROL, RESPONSE_CLOSED_DRAFT, 'closed-flag replacement draft');
   201	    await seedFlag(REVIEW_CLOSED_CONTROL, RESPONSE_CLOSED_DRAFT, 'dismissed_false_positive');
   202	  });
   203	
   204	  afterAll(async () => {
   205	    if (!db) return;
   206	    if (tenant) {
   207	      // FK order: flagged_responses references responses.
   208	      await sql()`DELETE FROM flagged_responses WHERE business_id = ${businessId}::uuid`;
   209	      await sql()`DELETE FROM responses WHERE business_id = ${businessId}::uuid`;
   210	      await sql()`DELETE FROM reviews WHERE business_id = ${businessId}::uuid`;
   211	      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
   212	      await cleanupTenantAccount(sql(), tenant);
   213	    }
   214	    await db.end({ timeout: 5 });
   215	  });
   216	
   217	  it('loadPastRepliesPageView integration: unanswered-first ordering and count denominators against the live schema', async () => {
   218	    const view = (await loadPastRepliesPageView(sql(), {
   219	      accountId: tenant!.accountId,
   220	      locationId: businessId,
   221	      page: 1,
   222	    })) as unknown as ReviewsListView | null;
   223	
   224	    expect(view).not.toBeNull();
   225	
   226	    // Unanswered first, newest-first inside each group (S6). The interleaved
   227	    // fixture dates mean this ordering cannot come out right by accident.
   228	    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual([
   229	      REVIEW_UNANSWERED_NEW,
   230	      REVIEW_UNANSWERED_OLD,
   231	    ]);
   232	    expect(view!.answeredRows.map((row) => row.review_id)).toEqual([
   233	      REVIEW_ANSWERED_NEW,
   234	      REVIEW_ANSWERED_OLD,
   235	      REVIEW_HELD_REPLACEMENT,
   236	      REVIEW_READY_CONTROL,
   237	      REVIEW_CLOSED_CONTROL,
   238	    ]);
   239	
   240	    // Count denominators span ALL reviews, not only replied ones (#671 landmine 3).
   241	    expect(view!.unansweredTotal).toBe(2);
   242	    expect(view!.answeredTotal).toBe(5);
   243	    expect(view!.totalPages).toBe(Math.max(1, Math.ceil(7 / PAGE_SIZE)));
   244	
   245	    // Avg rating over all seven reviews (5 + 4 + 2 + 1 + 3 + 3 + 3) / 7 = 3,
   246	    // NOT the posted-only average the pre-#678 query returned.
   247	    expect(view!.avgStarRating).toBeCloseTo(3, 5);
   248	
   249	    // The action slots the live query derives, end to end (#727): every
   250	    // unanswered row offers Generate; the held-replacement row alone withdraws
   251	    // its affordance while its posted siblings keep Regenerate.
   252	    expect(view!.unansweredRows.every((row) => row.row_action === 'generate')).toBe(true);
   253	    expect(view!.answeredRows.map((row) => row.row_action)).toEqual([
   254	      'regenerate', 'regenerate', 'none', 'regenerate', 'regenerate',
   255	    ]);
   256	  });
   257	
   258	  it('returns row_action none while keeping reply_state posted for a review whose replacement draft is moderation-held', async () => {
   259	    const view = (await loadPastRepliesPageView(sql(), {
   260	      accountId: tenant!.accountId,
   261	      locationId: businessId,
   262	      page: 1,
   263	    })) as unknown as ReviewsListView | null;
   264	
   265	    const heldRow = view!.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
   266	    // The posted-reply axis owns grouping: the row stays Answered.
   267	    expect(heldRow).toBeDefined();
   268	    expect(heldRow!.reply_state).toBe('posted');
   269	    // The action slot withdraws Regenerate (invariant #4, the #710-item-1 bug cell).
   270	    expect(heldRow!.row_action).toBe('none');
   271	    // The draft axis never crosses the wire — by key OR by value: the held
   272	    // draft's text must not appear anywhere in the serialized page view.
   273	    const keys = Object.keys(heldRow!);
   274	    expect(keys).not.toContain('draft_held');
   275	    expect(keys).not.toContain('draft_response_id');
   276	    expect(JSON.stringify(view)).not.toContain(HELD_DRAFT_TEXT);
   277	  });
   278	
   279	  it('distinguishes an open-held replacement from unflagged and closed replacements', async () => {
   280	    const view = (await loadPastRepliesPageView(sql(), {
   281	      accountId: tenant!.accountId,
   282	      locationId: businessId,
   283	      page: 1,
   284	    })) as unknown as ReviewsListView | null;
   285	
   286	    const actionFor = (id: string) =>
   287	      view!.answeredRows.find((row) => row.review_id === id)?.row_action;
   288	    // Only the OPEN flag holds; an unflagged or closed-flag replacement keeps
   289	    // Regenerate — the withdrawal tracks flagged_responses.status = 'open'
   290	    // exactly (src/lib/moderation/held-draft.ts semantics).
   291	    expect(actionFor(REVIEW_HELD_REPLACEMENT)).toBe('none');
   292	    expect(actionFor(REVIEW_READY_CONTROL)).toBe('regenerate');
   293	    expect(actionFor(REVIEW_CLOSED_CONTROL)).toBe('regenerate');
   294	  });
   295	});
     1	// src/lib/dashboard/pending-count.ts
     2	//
     3	// Single authoritative count of owner drafts awaiting approval for a location.
     4	// Excludes held/flagged drafts (the admin queue owns those). Used by BOTH the
     5	// dashboard response (reputationSummary.pendingApprovalCount) and the layout's
     6	// PendingCountProvider seed, so the approvals strip and the mobile tab badge
     7	// can never disagree or over-count (PLAN.md PR2 A.4).
     8	
     9	import type { Sql } from 'postgres';
    10	
    11	export async function getPendingApprovalCount(sql: Sql, businessId: string): Promise<number> {
    12	  const [row] = await sql<{ count: number }[]>`
    13	    SELECT COUNT(*)::int AS count
    14	    FROM responses resp
    15	    WHERE resp.business_id = ${businessId}
    16	      AND resp.status = 'pending_approval'
    17	      AND NOT EXISTS (
    18	        SELECT 1 FROM flagged_responses fr
    19	        WHERE fr.response_id = resp.id AND fr.status = 'open'
    20	      )
    21	  `;
    22	  return row?.count ?? 0;
    23	}
    24	
    25	/**
    26	 * Set-based sibling of {@link getPendingApprovalCount}: the same authoritative
    27	 * predicate (`pending_approval` and no open flagged_responses), grouped by
    28	 * `business_id` and account-scoped, so the All-Locations aggregate gets every
    29	 * location's count in ONE query instead of a fan-out. Returns a Map keyed by
    30	 * `business_id`; locations with zero pending drafts are simply absent (callers
    31	 * default them to 0). The explicit `JOIN businesses … account_id` scope is what
    32	 * the tenant-scope audit requires for an account-wide read.
    33	 */
    34	export async function getPendingApprovalCountsForAccount(
    35	  sql: Sql,
    36	  accountId: string,
    37	): Promise<Map<string, number>> {
    38	  const rows = await sql<{ business_id: string; count: number }[]>`
    39	    SELECT resp.business_id, COUNT(*)::int AS count
    40	    FROM responses resp
    41	    JOIN businesses b ON b.id = resp.business_id
    42	    WHERE b.account_id = ${accountId}::uuid
    43	      AND b.archived_at IS NULL
    44	      AND resp.status = 'pending_approval'
    45	      AND NOT EXISTS (
    46	        SELECT 1 FROM flagged_responses fr
    47	        WHERE fr.response_id = resp.id AND fr.status = 'open'
    48	      )
    49	    GROUP BY resp.business_id
    50	  `;
    51	
    52	  const counts = new Map<string, number>();
    53	  for (const row of rows) {
    54	    counts.set(row.business_id, Number(row.count));
    55	  }
    56	  return counts;
    57	}
     1	import { randomUUID } from 'node:crypto';
     2	import { afterAll, beforeAll, expect, it } from 'vitest';
     3	import postgres from 'postgres';
     4	import type postgresType from 'postgres';
     5	import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
     6	import {
     7	  cleanupTenantAccount,
     8	  seedTenantAccount,
     9	  type TenantSeed,
    10	} from '@/lib/shared/__tests__/live-db-tenant';
    11	import { getAgentTeamSummary, getReviewTimeline } from '../read';
    12	import {
    13	  completeRun,
    14	  recordOutcome,
    15	  recordStep,
    16	  startOrGetActiveRun,
    17	} from '../run-spine';
    18	
    19	const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
    20	
    21	let db: postgresType.Sql | undefined;
    22	let tenant: TenantSeed | undefined;
    23	const businessId = randomUUID();
    24	const otherBusinessId = randomUUID();
    25	const reviewId = randomUUID();
    26	const legacyReviewId = randomUUID();
    27	const olderResponseId = randomUUID();
    28	const responseId = randomUUID();
    29	const escalationId = randomUUID();
    30	const resolvedEscalationId = randomUUID();
    31	let olderRunId = '';
    32	let latestRunId = '';
    33	
    34	function sql(): postgresType.Sql {
    35	  if (!db) throw new Error('agent read integration database was not initialized');
    36	  return db;
    37	}
    38	
    39	function accountId(): string {
    40	  if (!tenant) throw new Error('agent read integration tenant was not seeded');
    41	  return tenant.accountId;
    42	}
    43	
    44	async function lockReview(tx: postgresType.TransactionSql): Promise<void> {
    45	  await tx`SELECT id FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
    46	}
    47	
    48	describeWithDb('agent spine reads against live Postgres', { timeout: 30_000 }, () => {
    49	  beforeAll(async () => {
    50	    db = postgres(testDatabaseUrl!, { max: 1, prepare: false });
    51	    tenant = await seedTenantAccount(db, {
    52	      userName: 'Agent Read Owner',
    53	      accountDisplayName: 'Agent Read Account',
    54	    });
    55	
    56	    await sql()`
    57	      INSERT INTO businesses (
    58	        id, name, owner_name, owner_email, account_id, subscription_status
    59	      ) VALUES
    60	        (${businessId}::uuid, 'Agent Read Primary', 'Agent Read Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'),
    61	        (${otherBusinessId}::uuid, 'Agent Read Other', 'Agent Read Owner', ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active')
    62	    `;
    63	    await sql()`
    64	      INSERT INTO reviews (
    65	        id, business_id, provider, provider_review_id, provider_review_name,
    66	        provider_location_name, reviewer_name, star_rating, review_text,
    67	        review_date, status
    68	      ) VALUES
    69	        (
    70	          ${reviewId}::uuid, ${businessId}::uuid, 'zernio', ${`agent-read-${reviewId}`},
    71	          ${`zernio://agent-read/reviews/${reviewId}`}, 'zernio://agent-read/locations/1',
    72	          'Timeline Reviewer', 5, 'A timeline fixture review.',
    73	          '2026-07-10T09:30:00.000Z'::timestamptz, 'approved'
    74	        ),
    75	        (
    76	          ${legacyReviewId}::uuid, ${businessId}::uuid, 'zernio', ${`agent-read-${legacyReviewId}`},
    77	          ${`zernio://agent-read/reviews/${legacyReviewId}`}, 'zernio://agent-read/locations/1',
    78	          'Legacy Reviewer', 4, 'A legacy fixture review.',
    79	          '2026-07-09T09:30:00.000Z'::timestamptz, 'pending_approval'
    80	        )
    81	    `;
    82	    await sql()`
    83	      INSERT INTO responses (
    84	        id, review_id, business_id, response_text, original_draft_text,
    85	        version, status, approval_method, approved_at, auto_post_scheduled_at,
    86	        posted_at
    87	      ) VALUES
    88	        (
    89	          ${olderResponseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
    90	          'Older posted response.', 'Older posted response.',
    91	          1, 'posted', 'owner', '2026-07-10T10:00:00.000Z'::timestamptz,
    92	          NULL, '2026-07-10T10:05:00.000Z'::timestamptz
    93	        ),
    94	        (
    95	          ${responseId}::uuid, ${reviewId}::uuid, ${businessId}::uuid,
    96	          'New scheduled response.', 'New scheduled response.',
    97	          2, 'approved', 'auto_policy', NOW(),
    98	          '2030-01-01T12:00:00.000Z'::timestamptz, NULL
    99	        )
   100	    `;
   101	
   102	    await sql().begin(async (tx) => {
   103	      await lockReview(tx);
   104	      const started = await startOrGetActiveRun(tx, {
   105	        kind: 'review_handler',
   106	        subjectType: 'review',
   107	        subjectId: reviewId,
   108	        accountId: accountId(),
   109	        businessId,
   110	        correlationId: 'agent-read-older',
   111	      });
   112	      olderRunId = started.runId;
   113	      await recordStep(tx, {
   114	        runId: olderRunId,
   115	        stepKey: 'triage',
   116	        detail: { severity: 'high' },
   117	      });
   118	      await recordOutcome(tx, {
   119	        runId: olderRunId,
   120	        accountId: accountId(),
   121	        businessId,
   122	        attributedAgent: 'guardian',
   123	        outcomeKind: 'review_escalated',
   124	      });
   125	      await completeRun(tx, olderRunId, 'failed', { reason: 'provider_terminal' });
   126	    });
   127	    await sql()`
   128	      UPDATE agent_runs
   129	      SET started_at = '2026-07-10T09:31:00.000Z'::timestamptz
   130	      WHERE id = ${olderRunId}::uuid
   131	    `;
   132	
   133	    await sql().begin(async (tx) => {
   134	      await lockReview(tx);
   135	      const started = await startOrGetActiveRun(tx, {
   136	        kind: 'review_handler',
   137	        subjectType: 'review',
   138	        subjectId: reviewId,
   139	        accountId: accountId(),
   140	        businessId,
   141	        correlationId: 'agent-read-latest',
   142	      });
   143	      latestRunId = started.runId;
   144	      await recordStep(tx, {
   145	        runId: latestRunId,
   146	        stepKey: 'review_ingested',
   147	        detail: { source: 'zernio' },
   148	      });
   149	      await recordStep(tx, {
   150	        runId: latestRunId,
   151	        stepKey: 'draft_generated',
   152	        detail: { response_id: responseId, version: 1 },
   153	        latencyMs: 42,
   154	      });
   155	      await recordStep(tx, {
   156	        runId: latestRunId,
   157	        stepKey: 'moderation_checked',
   158	        detail: { severity: 'none' },
   159	      });
   160	      await recordOutcome(tx, {
   161	        runId: latestRunId,
   162	        accountId: accountId(),
   163	        businessId,
   164	        attributedAgent: 'reply',
   165	        outcomeKind: 'reply_posted',
   166	      });
   167	      await recordOutcome(tx, {
   168	        runId: latestRunId,
   169	        accountId: accountId(),
   170	        businessId,
   171	        attributedAgent: 'reply',
   172	        outcomeKind: 'reply_auto_posted',
   173	      });
   174	    });
   175	
   176	    await sql()`
   177	      INSERT INTO review_escalations (
   178	        id, account_id, business_id, review_id, agent_run_id, status,
   179	        triage_severity, triage_source, triage_suggested_action,
   180	        escalated_at, acknowledged_at, resolved_at, created_at, updated_at
   181	      ) VALUES
   182	        (
   183	          ${escalationId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
   184	          ${reviewId}::uuid, ${latestRunId}::uuid, 'escalated', 'high',
   185	          'mock_v1', 'respond_and_escalate',
   186	          '2026-07-10T09:32:00.000Z'::timestamptz, NULL, NULL,
   187	          '2026-07-10T09:32:00.000Z'::timestamptz,
   188	          '2026-07-10T09:32:00.000Z'::timestamptz
   189	        ),
   190	        (
   191	          ${resolvedEscalationId}::uuid, ${tenant.accountId}::uuid, ${businessId}::uuid,
   192	          ${reviewId}::uuid, ${olderRunId}::uuid, 'resolved', 'medium',
   193	          'mock_v1', 'escalate',
   194	          '2026-07-11T09:32:00.000Z'::timestamptz,
   195	          '2026-07-11T09:34:00.000Z'::timestamptz,
   196	          '2026-07-11T09:36:00.000Z'::timestamptz,
   197	          '2026-07-11T09:32:00.000Z'::timestamptz,
   198	          '2026-07-11T09:36:00.000Z'::timestamptz
   199	        )
   200	    `;
   201	
   202	    await sql().begin(async (tx) => {
   203	      const { runId } = await startOrGetActiveRun(tx, {
   204	        kind: 'weekly_insights',
   205	        subjectType: 'account_week',
   206	        subjectId: `${accountId()}_2026-07-06`,
   207	        accountId: accountId(),
   208	        businessId: otherBusinessId,
   209	        correlationId: 'agent-read-insights',
   210	      });
   211	      await recordOutcome(tx, {
   212	        runId,
   213	        accountId: accountId(),
   214	        businessId: otherBusinessId,
   215	        attributedAgent: 'insights',
   216	        outcomeKind: 'digest_sent',
   217	      });
   218	      await completeRun(tx, runId, 'completed');
   219	    });
   220	  });
   221	
   222	  afterAll(async () => {
   223	    if (!db) return;
   224	    if (tenant) {
   225	      await sql()`DELETE FROM review_escalations WHERE account_id = ${tenant.accountId}::uuid`;
   226	      await sql()`DELETE FROM responses WHERE business_id IN (${businessId}::uuid, ${otherBusinessId}::uuid)`;
   227	      await sql()`DELETE FROM agent_outcomes WHERE account_id = ${tenant.accountId}::uuid`;
   228	      await sql()`DELETE FROM agent_runs WHERE account_id = ${tenant.accountId}::uuid`;
   229	      await sql()`DELETE FROM reviews WHERE business_id IN (${businessId}::uuid, ${otherBusinessId}::uuid)`;
   230	      await sql()`DELETE FROM businesses WHERE id IN (${businessId}::uuid, ${otherBusinessId}::uuid)`;
   231	      await cleanupTenantAccount(sql(), tenant);
   232	    }
   233	    await db.end({ timeout: 5 });
   234	  });
   235	
   236	  it('round-trips the bounded timeline with ordered runs, steps, outcomes, and JSONB', async () => {
   237	    const timeline = await getReviewTimeline(sql(), { accountId: accountId(), reviewId });
   238	
   239	    expect(timeline?.review).toMatchObject({
   240	      id: reviewId,
   241	      rating: 5,
   242	      reviewerName: 'Timeline Reviewer',
   243	    });
   244	    expect(timeline?.response).toMatchObject({
   245	      id: responseId,
   246	      status: 'approved',
   247	      approvalMethod: 'auto_policy',
   248	      autoPostScheduledAt: '2030-01-01T12:00:00.000Z',
   249	      responseText: 'New scheduled response.',
   250	      version: 2,
   251	    });
   252	    expect(timeline?.escalation).toMatchObject({
   253	      id: escalationId,
   254	      status: 'escalated',
   255	      severity: 'high',
   256	      createdAt: '2026-07-10T09:32:00.000Z',
   257	    });
   258	    expect(timeline?.runs.map((run) => run.id)).toEqual([latestRunId, olderRunId]);
   259	    expect(timeline?.runs[0]).toMatchObject({
   260	      displayState: 'in_progress',
   261	      steps: [
   262	        expect.objectContaining({ stepIndex: 1, detail: { source: 'zernio' } }),
   263	        expect.objectContaining({
   264	          stepIndex: 2,
   265	          detail: { response_id: responseId, version: 1 },
   266	        }),
   267	        expect.objectContaining({ stepIndex: 3, detail: { severity: 'none' } }),
   268	      ],
   269	      outcomes: [
   270	        expect.objectContaining({ outcomeKind: 'reply_posted', attributedAgent: 'reply' }),
   271	        expect.objectContaining({ outcomeKind: 'reply_auto_posted', attributedAgent: 'reply' }),
   272	      ],
   273	    });
   274	    expect(timeline?.runs[1]).toMatchObject({
   275	      displayState: 'failed',
   276	      error: { reason: 'provider_terminal' },
   277	    });
   278	  });
   279	
   280	  it('reads a pushed auto-post deadline live on every request', async () => {
   281	    await sql()`
   282	      UPDATE responses
   283	      SET auto_post_scheduled_at = '2030-01-01T12:30:00.000Z'::timestamptz
   284	      WHERE id = ${responseId}::uuid
   285	    `;
   286	
   287	    const timeline = await getReviewTimeline(sql(), { accountId: accountId(), reviewId });
   288	    expect(timeline?.response?.autoPostScheduledAt).toBe('2030-01-01T12:30:00.000Z');
   289	  });
   290	
   291	  it('returns a legacy empty timeline and rejects an out-of-scope account', async () => {
   292	    const legacy = await getReviewTimeline(sql(), {
   293	      accountId: accountId(),
   294	      reviewId: legacyReviewId,
   295	    });
   296	    expect(legacy).not.toBeNull();
   297	    expect(legacy?.runs).toEqual([]);
   298	
   299	    await expect(
   300	      getReviewTimeline(sql(), { accountId: randomUUID(), reviewId }),
   301	    ).resolves.toBeNull();
   302	  });
   303	
   304	  it('aggregates the team by account and filters it by location', async () => {
   305	    // The latest run seeds the real mark-posted co-occurrence (reply_posted +
   306	    // reply_auto_posted for ONE auto-policy post) — it must count as one reply.
   307	    await expect(
   308	      getAgentTeamSummary(sql(), { kind: 'account', accountId: accountId() }, '30d'),
   309	    ).resolves.toEqual({ reply: 1, guardian: 1, insights: 1 });
   310	
   311	    await expect(
   312	      getAgentTeamSummary(
   313	        sql(),
   314	        { kind: 'location', accountId: accountId(), businessId },
   315	        '30d',
   316	      ),
   317	    ).resolves.toEqual({ reply: 1, guardian: 1, insights: 0 });
   318	  });
   319	});

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/trace_path started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/trace_path (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/get_code_snippet started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/get_code_snippet (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/get_code_snippet started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/get_code_snippet (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/get_code_snippet started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/get_code_snippet (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/get_code_snippet started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/get_code_snippet (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/get_code_snippet started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/get_code_snippet (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/search_graph started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/search_graph (completed)
hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse Completed
mcp: codebase-memory-mcp/get_code_snippet started
hook: PermissionRequest
hook: PermissionRequest Completed
mcp: codebase-memory-mcp/get_code_snippet (completed)
hook: PostToolUse
hook: PostToolUse Completed
codex
A concrete problem is already visible in Task 1’s property skeleton: the chosen integration suite permanently seeds two unheld `pending_approval` responses in the same business, so an absolute pending-count assertion of `0/1` cannot be green without isolating the fixture or comparing a delta. I’m now checking the remaining migration surfaces and mocks for gaps that could still pass.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba src/lib/dashboard/__tests__/aggregate-queries.test.ts; nl -ba src/lib/agents/__tests__/read.test.ts; nl -ba 'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts'; nl -ba src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts; nl -ba src/lib/past-replies/__tests__/reviews-list.test.ts; nl -ba scripts/verify-gate.sh | sed -n '1,280p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     1	import { describe, it, expect, beforeEach } from 'vitest';
     2	import type { Sql } from 'postgres';
     3	import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
     4	
     5	// The set-based aggregate module is born-injected (sql is a parameter, invariant
     6	// #15), so the fragment-aware createMockSql harness stands in for `sql` directly.
     7	import {
     8	  fetchPerLocationAggregateSlices,
     9	  type PerLocationAggregateSlice,
    10	} from '../aggregate-queries';
    11	import { getPendingApprovalCountsForAccount } from '../pending-count';
    12	
    13	let harness: MockSqlHarness;
    14	let mockSql: Sql;
    15	
    16	beforeEach(() => {
    17	  harness = createMockSql();
    18	  mockSql = harness.mockSql as unknown as Sql;
    19	});
    20	
    21	/**
    22	 * Load the aggregate wave's return values in the deterministic order the mock
    23	 * consumes them. `getPendingApprovalCountsForAccount` awaits its `sql` inside an
    24	 * async function during Promise.all construction, so its query resolves FIRST;
    25	 * the six lazy `sql``` fragments then resolve in their array order.
    26	 */
    27	function pushWave(rows: {
    28	  pending: Array<{ business_id: string; count: number }>;
    29	  baseline: unknown[];
    30	  counters: unknown[];
    31	  velocity: unknown[];
    32	  rating: unknown[];
    33	  ranking: unknown[];
    34	  monthly: unknown[];
    35	  weekly: unknown[];
    36	}): void {
    37	  harness.sqlReturnQueue.push(
    38	    rows.pending,
    39	    rows.baseline,
    40	    rows.counters,
    41	    rows.velocity,
    42	    rows.rating,
    43	    rows.ranking,
    44	    rows.monthly,
    45	    rows.weekly,
    46	  );
    47	}
    48	
    49	describe('fetchPerLocationAggregateSlices — byte-identical per-location slices', () => {
    50	  beforeEach(() => {
    51	    pushWave({
    52	      pending: [
    53	        { business_id: 'loc-A', count: 25 },
    54	        { business_id: 'loc-B', count: 13 },
    55	      ],
    56	      baseline: [
    57	        {
    58	          business_id: 'loc-A',
    59	          name: 'Cafe A',
    60	          created_at: new Date('2026-01-01'),
    61	          initial_review_count: 100,
    62	          initial_responded_count: 30,
    63	          baseline_captured_at: new Date('2026-01-01'),
    64	        },
    65	        {
    66	          business_id: 'loc-B',
    67	          name: 'Bakery B',
    68	          created_at: new Date('2026-01-02'),
    69	          initial_review_count: null,
    70	          initial_responded_count: null,
    71	          baseline_captured_at: null,
    72	        },
    73	      ],
    74	      counters: [
    75	        { business_id: 'loc-A', total_received_all_time: 50, total_responded_all_time: 40, received_window: 12, responded_window: 9 },
    76	        { business_id: 'loc-B', total_received_all_time: 3, total_responded_all_time: 2, received_window: 1, responded_window: 1 },
    77	      ],
    78	      velocity: [
    79	        { business_id: 'loc-A', week_start: '2026-06-01', count: 2 },
    80	        { business_id: 'loc-A', week_start: '2026-06-08', count: 3 },
    81	        { business_id: 'loc-B', week_start: '2026-06-01', count: 1 },
    82	      ],
    83	      rating: [
    84	        { business_id: 'loc-A', stars: 5, count: 20 },
    85	        { business_id: 'loc-A', stars: 4, count: 5 },
    86	        { business_id: 'loc-B', stars: 5, count: 1 },
    87	      ],
    88	      ranking: [
    89	        { business_id: 'loc-A', keyword: 'coffee', snapshot_date: '2026-06-01', rank_position: 3 },
    90	        { business_id: 'loc-A', keyword: 'coffee', snapshot_date: '2026-06-08', rank_position: 2 },
    91	      ],
    92	      monthly: [
    93	        { business_id: 'loc-A', summary_text: 'Monthly A', month_start_date: '2026-06-01', sent_at: '2026-07-01T00:00:00Z' },
    94	      ],
    95	      weekly: [
    96	        { business_id: 'loc-B', summary_text: 'Weekly B', week_start_date: '2026-06-30', sent_at: '2026-07-05T00:00:00Z' },
    97	      ],
    98	    });
    99	  });
   100	
   101	  it('reproduces every retained field per location via the existing mappers', async () => {
   102	    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
   103	
   104	    const a = slices.get('loc-A')!;
   105	    expect(a.valueSummary).toEqual({
   106	      totalReviewsHandled: 40,
   107	      totalTimeSavedMinutes: 280, // 40 × MINUTES_SAVED_PER_RESPONSE (7)
   108	      currentResponseRate: 80, // round(40/50 × 100)
   109	      baselineResponseRate: 30, // round(30/100 × 100)
   110	    });
   111	    expect(a.reviewVelocity).toEqual([
   112	      { weekStart: '2026-06-01', count: 2 },
   113	      { weekStart: '2026-06-08', count: 3 },
   114	    ]);
   115	    expect(a.ranking).toEqual([
   116	      { keyword: 'coffee', snapshots: [
   117	        { date: '2026-06-01', position: 3 },
   118	        { date: '2026-06-08', position: 2 },
   119	      ] },
   120	    ]);
   121	    expect(a.ratingBreakdown.counts).toEqual([
   122	      { stars: 5, count: 20 },
   123	      { stars: 4, count: 5 },
   124	      { stars: 3, count: 0 },
   125	      { stars: 2, count: 0 },
   126	      { stars: 1, count: 0 },
   127	    ]);
   128	    expect(a.ratingBreakdown.total).toBe(25);
   129	    expect(a.latestBrief).toEqual({ text: 'Monthly A', type: 'monthly', periodLabel: 'June 2026' });
   130	    expect(a.recentReviewCount).toBe(10); // LEAST(50, 10)
   131	    expect(a.pendingApprovalCount).toBe(25);
   132	    expect(a.windowedReceived).toBe(12);
   133	    expect(a.windowedResponded).toBe(9);
   134	
   135	    const b = slices.get('loc-B')!;
   136	    expect(b.valueSummary).toEqual({
   137	      totalReviewsHandled: 2,
   138	      totalTimeSavedMinutes: 14,
   139	      currentResponseRate: 67, // round(2/3 × 100)
   140	      baselineResponseRate: null, // no baseline captured
   141	    });
   142	    expect(b.reviewVelocity).toEqual([{ weekStart: '2026-06-01', count: 1 }]);
   143	    expect(b.ranking).toBeNull(); // no ranking rows for loc-B
   144	    expect(b.ratingBreakdown.total).toBe(1);
   145	    expect(b.latestBrief).toEqual({ text: 'Weekly B', type: 'weekly', periodLabel: 'Week of 2026-06-30' });
   146	    expect(b.recentReviewCount).toBe(3); // LEAST(3, 10)
   147	    expect(b.pendingApprovalCount).toBe(13);
   148	  });
   149	
   150	  it('scopes every query by account_id (tenant isolation)', async () => {
   151	    await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
   152	
   153	    expect(harness.sqlCalls).toHaveLength(8);
   154	    for (const call of harness.sqlCalls) {
   155	      expect(call.text).toContain('account_id');
   156	      expect(call.values).toContain('acc-1');
   157	    }
   158	  });
   159	});
   160	
   161	describe('fetchPerLocationAggregateSlices — tenant/anchor gating', () => {
   162	  it('never emits a bucket for a business_id absent from the baseline (active-location) set', async () => {
   163	    // A stray counters row for a location NOT in the baseline anchor set (as
   164	    // could only happen via a leak) must never surface — output is gated by the
   165	    // account-scoped baseline set.
   166	    pushWave({
   167	      pending: [{ business_id: 'loc-FOREIGN', count: 99 }],
   168	      baseline: [
   169	        { business_id: 'loc-A', name: 'A', created_at: new Date('2026-01-01'), initial_review_count: null, initial_responded_count: null, baseline_captured_at: null },
   170	      ],
   171	      counters: [
   172	        { business_id: 'loc-A', total_received_all_time: 1, total_responded_all_time: 0, received_window: 0, responded_window: 0 },
   173	        { business_id: 'loc-FOREIGN', total_received_all_time: 500, total_responded_all_time: 500, received_window: 5, responded_window: 5 },
   174	      ],
   175	      velocity: [], rating: [], ranking: [], monthly: [], weekly: [],
   176	    });
   177	
   178	    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
   179	
   180	    expect([...slices.keys()]).toEqual(['loc-A']);
   181	    expect(slices.has('loc-FOREIGN')).toBe(false);
   182	  });
   183	});
   184	
   185	describe('fetchPerLocationAggregateSlices — empty-bucket parity', () => {
   186	  it('zero-fills a location absent from every GROUP BY result', async () => {
   187	    pushWave({
   188	      pending: [],
   189	      baseline: [
   190	        { business_id: 'loc-EMPTY', name: 'Empty', created_at: new Date('2026-01-01'), initial_review_count: null, initial_responded_count: null, baseline_captured_at: null },
   191	      ],
   192	      counters: [], velocity: [], rating: [], ranking: [], monthly: [], weekly: [],
   193	    });
   194	
   195	    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
   196	    const empty = slices.get('loc-EMPTY')!;
   197	
   198	    expect(empty.valueSummary).toEqual({
   199	      totalReviewsHandled: 0,
   200	      totalTimeSavedMinutes: 0,
   201	      currentResponseRate: 0,
   202	      baselineResponseRate: null,
   203	    });
   204	    expect(empty.reviewVelocity).toEqual([]);
   205	    expect(empty.ranking).toBeNull();
   206	    expect(empty.ratingBreakdown.total).toBe(0);
   207	    expect(empty.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
   208	    expect(empty.latestBrief).toBeNull();
   209	    expect(empty.recentReviewCount).toBe(0);
   210	    expect(empty.pendingApprovalCount).toBe(0);
   211	    expect(empty.windowedReceived).toBe(0);
   212	    expect(empty.windowedResponded).toBe(0);
   213	  });
   214	});
   215	
   216	describe('fetchPerLocationAggregateSlices — query count is constant in N', () => {
   217	  function emptyWave(locationCount: number): void {
   218	    const baseline = Array.from({ length: locationCount }, (_, i) => ({
   219	      business_id: `loc-${i}`,
   220	      name: `L${i}`,
   221	      created_at: new Date('2026-01-01'),
   222	      initial_review_count: null,
   223	      initial_responded_count: null,
   224	      baseline_captured_at: null,
   225	    }));
   226	    pushWave({ pending: [], baseline, counters: [], velocity: [], rating: [], ranking: [], monthly: [], weekly: [] });
   227	  }
   228	
   229	  it('issues the same number of SQL statements for 2 and 5 locations', async () => {
   230	    emptyWave(2);
   231	    await fetchPerLocationAggregateSlices(mockSql, 'acc-2', '30d');
   232	    const twoLocationQueries = harness.sqlCalls.length;
   233	
   234	    harness.resetMockSql();
   235	    emptyWave(5);
   236	    await fetchPerLocationAggregateSlices(mockSql, 'acc-5', '30d');
   237	    const fiveLocationQueries = harness.sqlCalls.length;
   238	
   239	    expect(twoLocationQueries).toBe(8);
   240	    expect(fiveLocationQueries).toBe(twoLocationQueries);
   241	  });
   242	});
   243	
   244	describe('getPendingApprovalCountsForAccount', () => {
   245	  it('buckets the authoritative pending count per business_id, account-scoped', async () => {
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
   267	// consumes (compile-time only; keeps the contract honest for the rewire).
   268	const _sliceShape: PerLocationAggregateSlice | undefined = undefined;
   269	void _sliceShape;
     1	import { beforeEach, describe, expect, it } from 'vitest';
     2	import type { Sql } from 'postgres';
     3	import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
     4	import {
     5	  deriveRunDisplayState,
     6	  getAgentTeamSummary,
     7	  getReviewTimeline,
     8	  stalledThresholdMsForKind,
     9	  STALLED_THRESHOLD_SEND_BATCH_DAYS,
    10	} from '../read';
    11	
    12	describe('deriveRunDisplayState', () => {
    13	  const now = new Date('2026-07-13T12:00:00.000Z');
    14	
    15	  it('renders a completed run as completed', () => {
    16	    expect(
    17	      deriveRunDisplayState(
    18	        { status: 'completed', kind: 'review_handler', startedAt: '2026-07-13T11:00:00.000Z' },
    19	        null,
    20	        now,
    21	      ),
    22	    ).toBe('completed');
    23	  });
    24	
    25	  it('deriveRunDisplayState returns cancelled for a cancelled run', () => {
    26	    expect(
    27	      deriveRunDisplayState(
    28	        {
    29	          status: 'cancelled',
    30	          kind: 'solicitation_send_batch',
    31	          startedAt: '2026-07-13T11:00:00.000Z',
    32	        },
    33	        null,
    34	        now,
    35	      ),
    36	    ).toBe('cancelled');
    37	  });
    38	
    39	  it('renders a failed run as failed', () => {
    40	    expect(
    41	      deriveRunDisplayState(
    42	        { status: 'failed', kind: 'review_handler', startedAt: '2026-07-13T11:00:00.000Z' },
    43	        null,
    44	        now,
    45	      ),
    46	    ).toBe('failed');
    47	  });
    48	
    49	  it('renders a running draft awaiting approval as waiting on the owner', () => {
    50	    expect(
    51	      deriveRunDisplayState(
    52	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-13T11:00:00.000Z' },
    53	        { status: 'pending_approval' },
    54	        now,
    55	      ),
    56	    ).toBe('waiting_on_owner');
    57	  });
    58	
    59	  it('renders a running draft awaiting owner connection as waiting on the owner', () => {
    60	    expect(
    61	      deriveRunDisplayState(
    62	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-13T11:00:00.000Z' },
    63	        { status: 'awaiting_owner_connect' },
    64	        now,
    65	      ),
    66	    ).toBe('waiting_on_owner');
    67	  });
    68	
    69	  it('prioritizes waiting on the owner over stalled for an old run', () => {
    70	    expect(
    71	      deriveRunDisplayState(
    72	        { status: 'running', kind: 'review_handler', startedAt: '2026-06-22T12:00:00.000Z' },
    73	        { status: 'pending_approval' },
    74	        now,
    75	      ),
    76	    ).toBe('waiting_on_owner');
    77	  });
    78	
    79	  it('renders a running run older than 48 hours as stalled', () => {
    80	    expect(
    81	      deriveRunDisplayState(
    82	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-11T11:59:59.999Z' },
    83	        { status: 'posted' },
    84	        now,
    85	      ),
    86	    ).toBe('stalled');
    87	  });
    88	
    89	  it('does not call a run stalled at the exact 48-hour boundary', () => {
    90	    expect(
    91	      deriveRunDisplayState(
    92	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-11T12:00:00.000Z' },
    93	        null,
    94	        now,
    95	      ),
    96	    ).toBe('in_progress');
    97	  });
    98	
    99	  it('renders a fresh running run as in progress', () => {
   100	    expect(
   101	      deriveRunDisplayState(
   102	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-13T11:00:00.000Z' },
   103	        null,
   104	        now,
   105	      ),
   106	    ).toBe('in_progress');
   107	  });
   108	
   109	  it('renders a scheduled auto-post as in progress', () => {
   110	    expect(
   111	      deriveRunDisplayState(
   112	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-13T11:00:00.000Z' },
   113	        {
   114	          status: 'approved',
   115	          approvalMethod: 'auto_policy',
   116	          autoPostScheduledAt: '2026-07-13T12:15:00.000Z',
   117	        },
   118	        now,
   119	      ),
   120	    ).toBe('in_progress');
   121	  });
   122	});
   123	
   124	describe('stalledThresholdMsForKind', () => {
   125	  const HOURS_48_MS = 48 * 60 * 60 * 1000;
   126	
   127	  it('stalledThresholdMsForKind returns 11 days for solicitation_send_batch runs', () => {
   128	    expect(stalledThresholdMsForKind('solicitation_send_batch')).toBe(
   129	      STALLED_THRESHOLD_SEND_BATCH_DAYS * 24 * 60 * 60 * 1000,
   130	    );
   131	    // The threshold sits past the 10-day construction bound (7-day approval
   132	    // window + 72-hour send window), so a healthy batch can never trip it.
   133	    expect(stalledThresholdMsForKind('solicitation_send_batch')).toBeGreaterThan(
   134	      10 * 24 * 60 * 60 * 1000,
   135	    );
   136	  });
   137	
   138	  it('stalledThresholdMsForKind returns the 48-hour default for every other run kind', () => {
   139	    for (const kind of [
   140	      'review_handler',
   141	      'weekly_insights',
   142	      'solicitation_batch',
   143	      'solicitation_ask',
   144	    ] as const) {
   145	      expect(stalledThresholdMsForKind(kind)).toBe(HOURS_48_MS);
   146	    }
   147	  });
   148	
   149	  it('deriveRunDisplayState applies the unchanged stalled threshold to review_handler runs', () => {
   150	    const now = new Date('2026-07-13T12:00:00.000Z');
   151	
   152	    // G10 wired the threshold through deriveRunDisplayState, and the one live
   153	    // caller's behaviour must not move: just past 48 hours still reads stalled,
   154	    // exactly at the boundary still reads in_progress.
   155	    expect(
   156	      deriveRunDisplayState(
   157	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-11T11:59:59.999Z' },
   158	        { status: 'posted' },
   159	        now,
   160	      ),
   161	    ).toBe('stalled');
   162	    expect(
   163	      deriveRunDisplayState(
   164	        { status: 'running', kind: 'review_handler', startedAt: '2026-07-11T12:00:00.000Z' },
   165	        null,
   166	        now,
   167	      ),
   168	    ).toBe('in_progress');
   169	
   170	    // The same age on a send batch is nowhere near its 11-day threshold.
   171	    expect(
   172	      deriveRunDisplayState(
   173	        {
   174	          status: 'running',
   175	          kind: 'solicitation_send_batch',
   176	          startedAt: '2026-07-11T11:59:59.999Z',
   177	        },
   178	        null,
   179	        now,
   180	      ),
   181	    ).toBe('in_progress');
   182	  });
   183	});
   184	
   185	describe('getReviewTimeline', () => {
   186	  const harness = createMockSql();
   187	
   188	  beforeEach(() => {
   189	    harness.resetMockSql();
   190	  });
   191	
   192	  it('returns null after the tenant-scoped review pre-read misses', async () => {
   193	    harness.sqlReturnQueue.push([]);
   194	
   195	    await expect(
   196	      getReviewTimeline(harness.mockSql as unknown as Sql, {
   197	        accountId: 'account-1',
   198	        reviewId: 'review-1',
   199	      }),
   200	    ).resolves.toBeNull();
   201	
   202	    expect(harness.sqlCalls).toHaveLength(1);
   203	    expect(harness.sqlCalls[0]!.text).toMatch(/FROM reviews r\s+JOIN businesses b/);
   204	    expect(harness.sqlCalls[0]!.text).toMatch(/r\.id = \?/);
   205	    expect(harness.sqlCalls[0]!.text).toMatch(/b\.account_id = \?/);
   206	    expect(harness.sqlCalls[0]!.text).toContain('b.archived_at IS NULL');
   207	    expect(harness.sqlCalls[0]!.values).toEqual(['review-1', 'account-1']);
   208	  });
   209	
   210	  it('returns an honest empty timeline for a scoped legacy review', async () => {
   211	    harness.sqlReturnQueue.push(
   212	      [
   213	        {
   214	          id: 'review-1',
   215	          star_rating: 4,
   216	          reviewer_name: 'Ada',
   217	          review_date: new Date('2026-07-10T09:30:00.000Z'),
   218	          status: 'pending_approval',
   219	        },
   220	      ],
   221	      [],
   222	      [],
   223	      [],
   224	    );
   225	
   226	    await expect(
   227	      getReviewTimeline(harness.mockSql as unknown as Sql, {
   228	        accountId: 'account-1',
   229	        reviewId: 'review-1',
   230	      }),
   231	    ).resolves.toEqual({
   232	      review: {
   233	        id: 'review-1',
   234	        rating: 4,
   235	        reviewerName: 'Ada',
   236	        submittedAt: '2026-07-10T09:30:00.000Z',
   237	        status: 'pending_approval',
   238	      },
   239	      response: null,
   240	      escalation: null,
   241	      runs: [],
   242	    });
   243	
   244	    expect(harness.sqlCalls).toHaveLength(4);
   245	    expect(harness.sqlCalls[1]!.text).toMatch(/FROM responses resp/);
   246	    expect(harness.sqlCalls[1]!.text).toMatch(/b\.account_id = \?/);
   247	    expect(harness.sqlCalls[2]!.text).toMatch(/FROM review_escalations e/);
   248	    expect(harness.sqlCalls[2]!.text).toMatch(/e\.account_id = \?/);
   249	    expect(harness.sqlCalls[3]!.text).toMatch(/FROM agent_runs ar/);
   250	    expect(harness.sqlCalls[3]!.text).toContain('LIMIT 20');
   251	  });
   252	
   253	  it('batches steps and outcomes and maps stored attribution and JSONB fields', async () => {
   254	    harness.sqlReturnQueue.push(
   255	      [
   256	        {
   257	          id: 'review-1',
   258	          star_rating: 5,
   259	          reviewer_name: 'Grace',
   260	          review_date: '2026-07-12T08:00:00.000Z',
   261	          status: 'pending_approval',
   262	        },
   263	      ],
   264	      [
   265	        {
   266	          id: 'response-1',
   267	          status: 'pending_approval',
   268	          approval_method: null,
   269	          auto_post_scheduled_at: null,
   270	          posted_at: null,
   271	          response_text: 'Thanks, Grace!',
   272	          version: 2,
   273	        },
   274	      ],
   275	      [
   276	        {
   277	          id: 'escalation-1',
   278	          status: 'acknowledged',
   279	          triage_severity: 'high',
   280	          triage_suggested_action: 'respond_and_escalate',
   281	          created_at: '2026-07-12T08:02:00.000Z',
   282	          acknowledged_at: '2026-07-12T08:05:00.000Z',
   283	          resolved_at: null,
   284	        },
   285	      ],
   286	      [
   287	        {
   288	          id: 'run-new',
   289	          status: 'running',
   290	          kind: 'review_handler',
   291	          started_at: '2026-07-12T08:01:00.000Z',
   292	          ended_at: null,
   293	          error: null,
   294	        },
   295	        {
   296	          id: 'run-old',
   297	          status: 'failed',
   298	          kind: 'review_handler',
   299	          started_at: '2026-07-11T08:01:00.000Z',
   300	          ended_at: '2026-07-11T08:03:00.000Z',
   301	          error: '{"reason":"provider_terminal"}',
   302	        },
   303	      ],
   304	      [
   305	        {
   306	          agent_run_id: 'run-new',
   307	          step_index: 1,
   308	          step_key: 'review_ingested',
   309	          attributed_agent: 'system',
   310	          status: 'completed',
   311	          detail: '{"source":"zernio"}',
   312	          latency_ms: 12,
   313	          created_at: '2026-07-12T08:01:01.000Z',
   314	        },
   315	        {
   316	          agent_run_id: 'run-new',
   317	          step_index: 2,
   318	          step_key: 'draft_generated',
   319	          attributed_agent: 'guardian',
   320	          status: 'completed',
   321	          detail: { response_id: 'response-1' },
   322	          latency_ms: null,
   323	          created_at: '2026-07-12T08:01:02.000Z',
   324	        },
   325	        {
   326	          agent_run_id: 'run-old',
   327	          step_index: 1,
   328	          step_key: 'policy_gate',
   329	          attributed_agent: 'reply',
   330	          status: 'failed',
   331	          detail: '{}',
   332	          latency_ms: 4,
   333	          created_at: '2026-07-11T08:02:00.000Z',
   334	        },
   335	      ],
   336	      [
   337	        {
   338	          agent_run_id: 'run-new',
   339	          outcome_kind: 'reply_drafted',
   340	          attributed_agent: 'insights',
   341	          occurred_at: '2026-07-12T08:01:03.000Z',
   342	        },
   343	        {
   344	          agent_run_id: 'run-old',
   345	          outcome_kind: 'review_escalated',
   346	          attributed_agent: 'guardian',
   347	          occurred_at: '2026-07-11T08:02:01.000Z',
   348	        },
   349	      ],
   350	    );
   351	
   352	    const timeline = await getReviewTimeline(harness.mockSql as unknown as Sql, {
   353	      accountId: 'account-1',
   354	      reviewId: 'review-1',
   355	    });
   356	
   357	    expect(timeline?.response).toEqual({
   358	      id: 'response-1',
   359	      status: 'pending_approval',
   360	      approvalMethod: null,
   361	      autoPostScheduledAt: null,
   362	      postedAt: null,
   363	      responseText: 'Thanks, Grace!',
   364	      version: 2,
   365	    });
   366	    expect(timeline?.escalation).toEqual({
   367	      id: 'escalation-1',
   368	      status: 'acknowledged',
   369	      severity: 'high',
   370	      suggestedAction: 'respond_and_escalate',
   371	      createdAt: '2026-07-12T08:02:00.000Z',
   372	      acknowledgedAt: '2026-07-12T08:05:00.000Z',
   373	      resolvedAt: null,
   374	    });
   375	    expect(timeline?.runs).toHaveLength(2);
   376	    expect(timeline?.runs[0]).toMatchObject({
   377	      id: 'run-new',
   378	      displayState: 'waiting_on_owner',
   379	      error: null,
   380	      steps: [
   381	        expect.objectContaining({
   382	          stepIndex: 1,
   383	          attributedAgent: 'system',
   384	          detail: { source: 'zernio' },
   385	        }),
   386	        expect.objectContaining({
   387	          stepIndex: 2,
   388	          attributedAgent: 'guardian',
   389	          detail: { response_id: 'response-1' },
   390	        }),
   391	      ],
   392	      outcomes: [
   393	        {
   394	          outcomeKind: 'reply_drafted',
   395	          attributedAgent: 'insights',
   396	          occurredAt: '2026-07-12T08:01:03.000Z',
   397	        },
   398	      ],
   399	    });
   400	    expect(timeline?.runs[1]).toMatchObject({
   401	      id: 'run-old',
   402	      displayState: 'failed',
   403	      error: { reason: 'provider_terminal' },
   404	    });
   405	
   406	    expect(harness.sqlCalls).toHaveLength(6);
   407	    expect(harness.sqlCalls[4]!.text).toMatch(/s\.agent_run_id = ANY\(\?::uuid\[\]\)/);
   408	    expect(harness.sqlCalls[4]!.text).toContain('ORDER BY s.agent_run_id, s.step_index');
   409	    expect(harness.sqlCalls[5]!.text).toMatch(/o\.agent_run_id = ANY\(\?::uuid\[\]\)/);
   410	    expect(harness.sqlCalls[4]!.values[0]).toEqual(['run-new', 'run-old']);
   411	    expect(harness.sqlCalls[5]!.values[0]).toEqual(['run-new', 'run-old']);
   412	  });
   413	});
   414	
   415	describe('getAgentTeamSummary', () => {
   416	  const harness = createMockSql();
   417	
   418	  beforeEach(() => {
   419	    harness.resetMockSql();
   420	  });
   421	
   422	  it('counts each posted reply once — reply_auto_posted is a qualifier, not an extra post', async () => {
   423	    // mark-posted records BOTH reply_posted and reply_auto_posted for one
   424	    // auto-policy post; only reply_posted may count or auto-posts double.
   425	    harness.sqlReturnQueue.push([
   426	      { attributed_agent: 'reply', outcome_kind: 'reply_posted', n: 2 },
   427	      { attributed_agent: 'reply', outcome_kind: 'reply_auto_posted', n: 3 },
   428	      { attributed_agent: 'guardian', outcome_kind: 'review_escalated', n: 4 },
   429	      { attributed_agent: 'insights', outcome_kind: 'digest_sent', n: 5 },
   430	      { attributed_agent: 'guardian', outcome_kind: 'reply_posted', n: 99 },
   431	    ]);
   432	
   433	    await expect(
   434	      getAgentTeamSummary(
   435	        harness.mockSql as unknown as Sql,
   436	        { kind: 'account', accountId: 'account-1' },
   437	        '30d',
   438	      ),
   439	    ).resolves.toEqual({ reply: 2, guardian: 4, insights: 5 });
   440	
   441	    expect(harness.sqlCalls).toHaveLength(1);
   442	    expect(harness.sqlCalls[0]!.text).toMatch(/FROM agent_outcomes o/);
   443	    expect(harness.sqlCalls[0]!.text).toMatch(/o\.account_id = \?/);
   444	    expect(harness.sqlCalls[0]!.text).not.toMatch(/o\.business_id = \?/);
   445	    expect(harness.sqlCalls[0]!.text).toContain('COUNT(*)::int AS n');
   446	    expect(harness.sqlCalls[0]!.values[0]).toBe('account-1');
   447	    expect(harness.sqlCalls[0]!.values[1]).toBeInstanceOf(Date);
   448	  });
   449	
   450	  it('agent team summary accepts persisted Solicitation outcomes without changing displayed totals', async () => {
   451	    harness.sqlReturnQueue.push([
   452	      {
   453	        attributed_agent: 'solicitation',
   454	        outcome_kind: 'solicitation_batch_built',
   455	        n: 7,
   456	      },
   457	      { attributed_agent: 'reply', outcome_kind: 'reply_posted', n: 2 },
   458	      { attributed_agent: 'guardian', outcome_kind: 'review_escalated', n: 3 },
   459	      { attributed_agent: 'insights', outcome_kind: 'digest_sent', n: 4 },
   460	    ]);
   461	
   462	    await expect(
   463	      getAgentTeamSummary(
   464	        harness.mockSql as unknown as Sql,
   465	        { kind: 'account', accountId: 'account-1' },
   466	        '30d',
   467	      ),
   468	    ).resolves.toEqual({ reply: 2, guardian: 3, insights: 4 });
   469	  });
   470	
   471	  it('adds the business filter for a location-scoped summary', async () => {
   472	    harness.sqlReturnQueue.push([
   473	      { attributed_agent: 'reply', outcome_kind: 'reply_posted', n: 1 },
   474	    ]);
   475	
   476	    await expect(
   477	      getAgentTeamSummary(
   478	        harness.mockSql as unknown as Sql,
   479	        { kind: 'location', accountId: 'account-1', businessId: 'business-1' },
   480	        '7d',
   481	      ),
   482	    ).resolves.toEqual({ reply: 1, guardian: 0, insights: 0 });
   483	
   484	    expect(harness.sqlCalls).toHaveLength(1);
   485	    expect(harness.sqlCalls[0]!.text).toMatch(/o\.account_id = \?/);
   486	    expect(harness.sqlCalls[0]!.text).toMatch(/o\.business_id = \?/);
   487	    expect(harness.sqlCalls[0]!.values).toEqual([
   488	      'account-1',
   489	      'business-1',
   490	      expect.any(Date),
   491	    ]);
   492	  });
   493	});
     1	// src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts
     2	//
     3	// T1 EVAL suite for #678 — the reviewId-keyed poller for **On-demand
     4	// generation**.
     5	//
     6	// D-C: deliberately NOT the existing `past-replies/draft-status`. That one
     7	// returns 503 `feature_disabled` when EDIT_REPLIES_ENABLED is off (Generate must
     8	// not depend on that flag — it never touches a live Google reply) and is keyed
     9	// on `outbox_id`, which is client state a refresh loses. Keying on `reviewId` is
    10	// what makes `Generating…` survive a page refresh.
    11	//
    12	// RED until Task 3 creates `../route.ts`.
    13	
    14	import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
    15	import { NextRequest } from 'next/server';
    16	import { QUEUE_NAMES } from '@/lib/shared/queue-names';
    17	
    18	// ── Hoisted shared state ─────────────────────────────────────────────────────
    19	
    20	const {
    21	  mockRequireRole,
    22	  mockGetRequestScope,
    23	  ownerQueue,
    24	  ownerCalls,
    25	  readQueue,
    26	  readCalls,
    27	  sqlProxy,
    28	  sqlReadProxy,
    29	} = vi.hoisted(() => {
    30	  const mockRequireRole = vi.fn();
    31	  const mockGetRequestScope = vi.fn();
    32	
    33	  const ownerQueue: unknown[][] = [];
    34	  const ownerCalls: { text: string; values: unknown[] }[] = [];
    35	  const readQueue: unknown[][] = [];
    36	  const readCalls: { text: string; values: unknown[] }[] = [];
    37	
    38	  // sql (write pool): only the `statusArraySql` fragment binding survives here.
    39	  // This handler writes nothing and is polled every ~1.5s, so every QUERY —
    40	  // including the tenant-ownership proof — runs on the read bulkhead below.
    41	  const sqlMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    42	    ownerCalls.push({ text: strings.join('?'), values });
    43	    return Promise.resolve(ownerQueue.shift() ?? []);
    44	  });
    45	  const sqlProxy = new Proxy(sqlMock, {
    46	    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
    47	  });
    48	
    49	  // sqlRead (read bulkhead): the tenant proof, the draft lookup, the outbox lookup.
    50	  const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    51	    readCalls.push({ text: strings.join('?'), values });
    52	    return Promise.resolve(readQueue.shift() ?? []);
    53	  });
    54	  const sqlReadProxy = new Proxy(sqlReadMock, {
    55	    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
    56	  });
    57	
    58	  return {
    59	    mockRequireRole,
    60	    mockGetRequestScope,
    61	    ownerQueue,
    62	    ownerCalls,
    63	    readQueue,
    64	    readCalls,
    65	    sqlProxy,
    66	    sqlReadProxy,
    67	  };
    68	});
    69	
    70	vi.mock('@/lib/db/auth', () => {
    71	  class AuthError extends Error {
    72	    constructor(message: string, public readonly statusCode: number) {
    73	      super(message);
    74	      this.name = 'AuthError';
    75	    }
    76	  }
    77	  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
    78	});
    79	
    80	vi.mock('@/lib/db/server', () => ({
    81	  sql: sqlProxy,
    82	  sqlRead: sqlReadProxy,
    83	  jsonb: (v: unknown) => v,
    84	}));
    85	
    86	// Mocked purely so the "must never be consulted" assertion below has something
    87	// to observe: this poller is ACCOUNT-scoped, not current-location-scoped.
    88	vi.mock('@/lib/auth/get-request-scope', () => ({
    89	  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
    90	}));
    91	
    92	// ── Helpers ──────────────────────────────────────────────────────────────────
    93	
    94	const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
    95	const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
    96	const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
    97	const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
    98	const APP_URL = 'http://localhost:3000';
    99	
   100	function makeRequest(locationScopeCookie?: string): NextRequest {
   101	  const headers: Record<string, string> = {};
   102	  if (locationScopeCookie) headers['Cookie'] = `rw_location_scope=${locationScopeCookie}`;
   103	  return new NextRequest(
   104	    `${APP_URL}/api/dashboard/reviews/${REVIEW_ID}/draft-status`,
   105	    { method: 'GET', headers },
   106	  );
   107	}
   108	
   109	const routeParams = { params: Promise.resolve({ reviewId: REVIEW_ID }) };
   110	
   111	type RouteHandler = (
   112	  req: NextRequest,
   113	  ctx: { params: Promise<{ reviewId: string }> },
   114	) => Promise<Response>;
   115	
   116	async function importGET(): Promise<RouteHandler> {
   117	  const mod = await import('../route');
   118	  return mod.GET as unknown as RouteHandler;
   119	}
   120	
   121	/** The tenant-ownership proof is the FIRST read-bulkhead query of the handler. */
   122	function seedOwned(rows: unknown[] = [{ business_id: LOCATION_ID }]): void {
   123	  readQueue.push(rows);
   124	}
   125	
   126	function seedRead(...rowsets: unknown[][]): void {
   127	  readQueue.push(...rowsets);
   128	}
   129	
   130	beforeEach(() => {
   131	  vi.clearAllMocks();
   132	  ownerQueue.length = 0;
   133	  ownerCalls.length = 0;
   134	  readQueue.length = 0;
   135	  readCalls.length = 0;
   136	  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
   137	  mockRequireRole.mockResolvedValue({
   138	    id: 'user-1',
   139	    name: 'Owner',
   140	    email: 'owner@test.com',
   141	    role: 'owner',
   142	    accountId: ACCOUNT_ID,
   143	  });
   144	});
   145	
   146	afterEach(() => {
   147	  delete process.env.NEXT_PUBLIC_APP_URL;
   148	  delete process.env.EDIT_REPLIES_ENABLED;
   149	});
   150	
   151	// ── Tests ────────────────────────────────────────────────────────────────────
   152	
   153	describe('GET /api/dashboard/reviews/[reviewId]/draft-status', () => {
   154	  it('GET draft-status returns 404 without querying draft text for a review owned by another account', async () => {
   155	    seedOwned([]);
   156	
   157	    const GET = await importGET();
   158	    const res = await GET(makeRequest(), routeParams);
   159	
   160	    expect(res.status).toBe(404);
   161	    expect((await res.json()).error).toBe('review_not_found');
   162	    // Tenant proof runs FIRST: a caller can never observe another account's
   163	    // generation status or draft text, not even as a timing difference. It is
   164	    // the ONLY query issued — nothing reached `responses` or `job_outbox`.
   165	    expect(readCalls).toHaveLength(1);
   166	    expect(readCalls[0]!.text).toMatch(/b\.account_id\s*=/i);
   167	    expect(readCalls[0]!.text).toMatch(/archived_at\s+IS\s+NULL/i);
   168	    expect(readCalls.some((call) => /FROM\s+responses/i.test(call.text))).toBe(false);
   169	    expect(readCalls.some((call) => /job_outbox/i.test(call.text))).toBe(false);
   170	  });
   171	
   172	  it('GET draft-status returns generating, ready, failed, and idle from the authoritative review state', async () => {
   173	    const GET = await importGET();
   174	
   175	    // ready — a live non-terminal response, not held.
   176	    seedOwned();
   177	    seedRead([{ id: 'resp-1', status: 'pending_approval', response_text: 'Draft text', held: false }]);
   178	    const ready = await GET(makeRequest(), routeParams);
   179	    expect(ready.status).toBe(200);
   180	    expect(await ready.json()).toEqual({
   181	      status: 'ready',
   182	      response_id: 'resp-1',
   183	      response_text: 'Draft text',
   184	    });
   185	
   186	    // generating — no draft yet, outbox row in flight.
   187	    seedOwned();
   188	    seedRead([], [{ status: 'pending', last_error: null }]);
   189	    const generating = await GET(makeRequest(), routeParams);
   190	    expect((await generating.json()).status).toBe('generating');
   191	    expect(readCalls.some((call) => call.values.includes(QUEUE_NAMES.GENERATE_RESPONSE))).toBe(true);
   192	
   193	    // failed — terminal-but-not-completed outbox row surfaces last_error.
   194	    seedOwned();
   195	    seedRead([], [{ status: 'failed', last_error: 'llm_terminal' }]);
   196	    const failed = await GET(makeRequest(), routeParams);
   197	    expect(await failed.json()).toEqual({ status: 'failed', error: 'llm_terminal' });
   198	
   199	    // idle — nothing in flight and no draft. The poller must stop.
   200	    seedOwned();
   201	    seedRead([], []);
   202	    const idle = await GET(makeRequest(), routeParams);
   203	    expect((await idle.json()).status).toBe('idle');
   204	  });
   205	
   206	  it('GET draft-status resumes a draft in another active location owned by the same account regardless of current-location cookie', async () => {
   207	    // The INTENDED authorization model (F4): same-account sibling-location
   208	    // access is correct, not a leak — only cross-account is a leak. The Reviews
   209	    // list row carries the reviewId, so a refresh resumes the poll even when the
   210	    // rw_location_scope cookie points at a different location.
   211	    seedOwned([{ business_id: ALT_LOCATION_ID }]);
   212	    seedRead([{ id: 'resp-alt', status: 'pending_approval', response_text: 'Alt draft', held: false }]);
   213	
   214	    const GET = await importGET();
   215	    const res = await GET(makeRequest(LOCATION_ID), routeParams);
   216	
   217	    expect(res.status).toBe(200);
   218	    const body = await res.json();
   219	    expect(body.status).toBe('ready');
   220	    expect(body.response_id).toBe('resp-alt');
   221	    // Account-scoped, never cookie-scoped.
   222	    expect(mockGetRequestScope).not.toHaveBeenCalled();
   223	    expect(readCalls.some((call) => call.values.includes(ALT_LOCATION_ID))).toBe(true);
   224	  });
   225	
   226	  it('GET draft-status never returns response_text or ready for a moderation-held response', async () => {
   227	    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
   228	    // pending_approval with an OPEN flagged_responses row. Returning it as
   229	    // `ready` would hand the owner held text plus an `Approve & post` button —
   230	    // the exact release path src/lib/moderation/held-draft.ts exists to block.
   231	    // The `held` flag is SELECTed, not filtered (D6/D9): filtering would make
   232	    // this route report `idle` for "no draft" and "held draft" alike.
   233	    seedOwned();
   234	    seedRead([{ id: 'resp-held', status: 'pending_approval', response_text: 'Held text', held: true }]);
   235	
   236	    const GET = await importGET();
   237	    const res = await GET(makeRequest(), routeParams);
   238	
   239	    expect(res.status).toBe(200);
   240	    const body = await res.json();
   241	    expect(body.status).toBe('idle');
   242	    expect(body.status).not.toBe('ready');
   243	    expect(body).not.toHaveProperty('response_text');
   244	    expect(JSON.stringify(body)).not.toContain('Held text');
   245	    // The hold must be read from flagged_responses, not inferred. Read call 0
   246	    // is the tenant proof; call 1 is the draft lookup that carries the predicate.
   247	    expect(readCalls[1]!.text).toContain('flagged_responses');
   248	  });
   249	});
     1	import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
     2	import { NextRequest } from 'next/server';
     3	
     4	// ── Hoisted shared state ────────────────────────────────────────────
     5	
     6	const {
     7	  mockRequireRole,
     8	  mockGetRequestScope,
     9	  accountQueue,
    10	  topLevelQueue,
    11	  sqlProxy,
    12	  sqlReadProxy,
    13	} = vi.hoisted(() => {
    14	  const mockRequireRole = vi.fn();
    15	  const mockGetRequestScope = vi.fn();
    16	
    17	  const accountQueue: unknown[][] = [];
    18	  const topLevelQueue: unknown[][] = [];
    19	
    20	  // sql (write pool): the resolveOwnerScope auth preamble stays on it — the
    21	  // subscription-gate SELECT it fires internally (plan #477 Task 1 wiring
    22	  // decision: shared auth helper is never threaded onto sqlRead).
    23	  const sqlMock = vi.fn(async (strings?: TemplateStringsArray) => {
    24	    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    25	    if (text.includes('subscription_status')) {
    26	      const nextAccount = accountQueue.shift();
    27	      if (nextAccount) return nextAccount;
    28	      return [{ subscription_status: 'active' }];
    29	    }
    30	    return [];
    31	  });
    32	  const sqlProxy = new Proxy(sqlMock, {
    33	    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
    34	  });
    35	
    36	  // sqlRead (read bulkhead): the route-body reads (job_outbox lookup + the
    37	  // completed-job response lookup) moved off write `sql` onto it (#477 Task 1).
    38	  const sqlReadMock = vi.fn(async () => topLevelQueue.shift() ?? []);
    39	  const sqlReadProxy = new Proxy(sqlReadMock, {
    40	    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
    41	  });
    42	
    43	  return {
    44	    mockRequireRole,
    45	    mockGetRequestScope,
    46	    accountQueue,
    47	    topLevelQueue,
    48	    sqlProxy,
    49	    sqlReadProxy,
    50	  };
    51	});
    52	
    53	// ── Mocks ───────────────────────────────────────────────────────────
    54	
    55	vi.mock('@/lib/db/auth', () => {
    56	  class AuthError extends Error {
    57	    constructor(message: string, public readonly statusCode: number) {
    58	      super(message);
    59	      this.name = 'AuthError';
    60	    }
    61	  }
    62	  return {
    63	    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    64	    AuthError,
    65	  };
    66	});
    67	
    68	vi.mock('@/lib/db/server', () => ({
    69	  sql: sqlProxy,
    70	  sqlRead: sqlReadProxy,
    71	  jsonb: (v: unknown) => v,
    72	}));
    73	
    74	vi.mock('@/lib/auth/get-request-scope', () => ({
    75	  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
    76	}));
    77	
    78	// ── Helpers ─────────────────────────────────────────────────────────
    79	
    80	const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
    81	const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
    82	// A second location on the same account — used for non-primary scoping tests.
    83	const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
    84	const OTHER_LOCATION_ID = '01234567-0000-7000-8000-000000000099';
    85	const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
    86	const RESPONSE_ID = '01234567-0000-7000-8000-0000000000bb';
    87	const OUTBOX_ID = '01234567-0000-7000-8000-0000000000cc';
    88	const APP_URL = 'http://localhost:3000';
    89	
    90	function ownerUser(overrides?: Partial<{ accountId: string | null }>) {
    91	  return {
    92	    id: 'user-1',
    93	    name: 'Test Owner',
    94	    email: 'owner@test.com',
    95	    role: 'owner',
    96	    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
    97	  };
    98	}
    99	
   100	function makeRequest(opts?: {
   101	  outboxId?: string | null;
   102	  locationScopeCookie?: string;
   103	}): NextRequest {
   104	  const params = new URLSearchParams();
   105	  if (opts?.outboxId !== undefined && opts.outboxId !== null) {
   106	    params.set('outbox_id', opts.outboxId);
   107	  }
   108	  const qs = params.toString();
   109	  const url = `${APP_URL}/api/dashboard/past-replies/draft-status${qs ? `?${qs}` : ''}`;
   110	  const headers: Record<string, string> = {};
   111	  if (opts?.locationScopeCookie) {
   112	    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
   113	  }
   114	  return new NextRequest(url, { method: 'GET', headers });
   115	}
   116	
   117	function seedTopLevel(...rowsets: unknown[][]) {
   118	  topLevelQueue.push(...rowsets);
   119	}
   120	
   121	function seedAccountRows(rows: unknown[]) {
   122	  accountQueue.push(rows);
   123	}
   124	
   125	beforeEach(() => {
   126	  vi.clearAllMocks();
   127	  accountQueue.length = 0;
   128	  topLevelQueue.length = 0;
   129	  process.env.EDIT_REPLIES_ENABLED = 'true';
   130	  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
   131	  // Default: requireRole succeeds; getRequestScope resolves to primary location.
   132	  mockRequireRole.mockResolvedValue(ownerUser());
   133	  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
   134	});
   135	
   136	afterEach(() => {
   137	  delete process.env.EDIT_REPLIES_ENABLED;
   138	});
   139	
   140	async function importGET() {
   141	  const mod = await import('../draft-status/route');
   142	  return mod.GET as (req: NextRequest) => Promise<Response>;
   143	}
   144	
   145	// ── Tests ───────────────────────────────────────────────────────────
   146	
   147	describe('GET /api/dashboard/past-replies/draft-status', () => {
   148	  it('returns 503 feature_disabled when flag is off', async () => {
   149	    process.env.EDIT_REPLIES_ENABLED = 'false';
   150	    const GET = await importGET();
   151	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   152	    expect(res.status).toBe(503);
   153	    expect(await res.json()).toEqual({ error: 'feature_disabled' });
   154	  });
   155	
   156	  it('returns 401 when no owner session', async () => {
   157	    const { AuthError } = await import('@/lib/db/auth');
   158	    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
   159	    const GET = await importGET();
   160	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   161	    expect(res.status).toBe(401);
   162	  });
   163	
   164	  it('returns 403 no_business when accountId is missing', async () => {
   165	    mockRequireRole.mockResolvedValue(ownerUser({ accountId: null }));
   166	    const GET = await importGET();
   167	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   168	    expect(res.status).toBe(403);
   169	    expect(await res.json()).toMatchObject({ error: 'no_business' });
   170	  });
   171	
   172	  it('returns 400 missing_outbox_id when query param is absent', async () => {
   173	    const GET = await importGET();
   174	    const res = await GET(makeRequest());
   175	    expect(res.status).toBe(400);
   176	    expect(await res.json()).toEqual({ error: 'missing_outbox_id' });
   177	  });
   178	
   179	  it('returns 404 outbox_not_found when outbox row is missing', async () => {
   180	    seedTopLevel([]);
   181	    const GET = await importGET();
   182	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   183	    expect(res.status).toBe(404);
   184	    expect(await res.json()).toEqual({ error: 'outbox_not_found' });
   185	  });
   186	
   187	  it('returns 403 forbidden when payload.business_id mismatches resolved locationId (TENANT LEAK GUARD)', async () => {
   188	    // Outbox payload belongs to a DIFFERENT location — must NOT leak status.
   189	    seedTopLevel([
   190	      {
   191	        status: 'completed',
   192	        payload: { business_id: OTHER_LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   193	        last_error: null,
   194	        aggregate_id: REVIEW_ID,
   195	      },
   196	    ]);
   197	    const GET = await importGET();
   198	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   199	    expect(res.status).toBe(403);
   200	    expect(await res.json()).toEqual({ error: 'forbidden' });
   201	  });
   202	
   203	  it("returns { status: 'generating' } for pending status", async () => {
   204	    seedTopLevel([
   205	      {
   206	        status: 'pending',
   207	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   208	        last_error: null,
   209	        aggregate_id: REVIEW_ID,
   210	      },
   211	    ]);
   212	    const GET = await importGET();
   213	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   214	    expect(res.status).toBe(200);
   215	    expect(await res.json()).toEqual({ status: 'generating' });
   216	  });
   217	
   218	  it('allows read-only past_due accounts to poll existing draft status', async () => {
   219	    seedAccountRows([{
   220	      subscription_status: 'past_due',
   221	      past_due_at: new Date(Date.now() - 8 * 86_400_000),
   222	      flags: {},
   223	    }]);
   224	    seedTopLevel([
   225	      {
   226	        status: 'pending',
   227	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   228	        last_error: null,
   229	        aggregate_id: REVIEW_ID,
   230	      },
   231	    ]);
   232	
   233	    const GET = await importGET();
   234	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   235	
   236	    expect(res.status).toBe(200);
   237	    expect(await res.json()).toEqual({ status: 'generating' });
   238	  });
   239	
   240	  it("returns { status: 'generating' } for dispatching status", async () => {
   241	    seedTopLevel([
   242	      {
   243	        status: 'dispatching',
   244	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   245	        last_error: null,
   246	        aggregate_id: REVIEW_ID,
   247	      },
   248	    ]);
   249	    const GET = await importGET();
   250	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   251	    expect(res.status).toBe(200);
   252	    expect(await res.json()).toEqual({ status: 'generating' });
   253	  });
   254	
   255	  it("returns { status: 'generating' } for dispatched status", async () => {
   256	    seedTopLevel([
   257	      {
   258	        status: 'dispatched',
   259	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   260	        last_error: null,
   261	        aggregate_id: REVIEW_ID,
   262	      },
   263	    ]);
   264	    const GET = await importGET();
   265	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   266	    expect(res.status).toBe(200);
   267	    expect(await res.json()).toEqual({ status: 'generating' });
   268	  });
   269	
   270	  it("returns { status: 'failed', error } for failed outbox", async () => {
   271	    seedTopLevel([
   272	      {
   273	        status: 'failed',
   274	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   275	        last_error: 'LLM call exceeded budget',
   276	        aggregate_id: REVIEW_ID,
   277	      },
   278	    ]);
   279	    const GET = await importGET();
   280	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   281	    expect(res.status).toBe(200);
   282	    expect(await res.json()).toEqual({ status: 'failed', error: 'LLM call exceeded budget' });
   283	  });
   284	
   285	  it('returns { response_id, status, response_text } for completed outbox with matching response row', async () => {
   286	    seedTopLevel(
   287	      // 1. outbox lookup
   288	      [
   289	        {
   290	          status: 'completed',
   291	          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
   292	          last_error: null,
   293	          aggregate_id: REVIEW_ID,
   294	        },
   295	      ],
   296	      // 2. response lookup
   297	      [
   298	        {
   299	          id: RESPONSE_ID,
   300	          status: 'pending_approval',
   301	          response_text: 'Generated draft text',
   302	          business_id: LOCATION_ID,
   303	        },
   304	      ],
   305	    );
   306	    const GET = await importGET();
   307	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   308	    expect(res.status).toBe(200);
   309	    expect(await res.json()).toEqual({
   310	      response_id: RESPONSE_ID,
   311	      status: 'pending_approval',
   312	      response_text: 'Generated draft text',
   313	    });
   314	  });
   315	
   316	  it('returns 404 response_not_found when completed but no response row matches', async () => {
   317	    seedTopLevel(
   318	      // 1. outbox lookup — completed
   319	      [
   320	        {
   321	          status: 'completed',
   322	          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
   323	          last_error: null,
   324	          aggregate_id: REVIEW_ID,
   325	        },
   326	      ],
   327	      // 2. response lookup — empty (worker may have failed to insert; race window)
   328	      [],
   329	    );
   330	    const GET = await importGET();
   331	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   332	    expect(res.status).toBe(404);
   333	    expect(await res.json()).toEqual({ error: 'response_not_found' });
   334	  });
   335	
   336	  it('returns 403 if completed response row belongs to another location (defense in depth)', async () => {
   337	    seedTopLevel(
   338	      // 1. outbox payload passes tenant check (business_id matches caller's location)
   339	      [
   340	        {
   341	          status: 'completed',
   342	          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
   343	          last_error: null,
   344	          aggregate_id: REVIEW_ID,
   345	        },
   346	      ],
   347	      // 2. response row belongs to a DIFFERENT location — defense-in-depth must block.
   348	      [
   349	        {
   350	          id: RESPONSE_ID,
   351	          status: 'pending_approval',
   352	          response_text: 'Should not leak',
   353	          business_id: OTHER_LOCATION_ID,
   354	        },
   355	      ],
   356	    );
   357	    const GET = await importGET();
   358	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   359	    expect(res.status).toBe(403);
   360	    expect(await res.json()).toEqual({ error: 'forbidden' });
   361	  });
   362	
   363	  it('parses JSONB payload that comes back as a string (Postgres.js + PgBouncer guard)', async () => {
   364	    // Payload arrives as a JSON-encoded string — handler must JSON.parse it.
   365	    seedTopLevel([
   366	      {
   367	        status: 'pending',
   368	        payload: JSON.stringify({ business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 }),
   369	        last_error: null,
   370	        aggregate_id: REVIEW_ID,
   371	      },
   372	    ]);
   373	    const GET = await importGET();
   374	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   375	    expect(res.status).toBe(200);
   376	    expect(await res.json()).toEqual({ status: 'generating' });
   377	  });
   378	
   379	  it('scopes to ALT_LOCATION_ID when rw_location_scope cookie is set (non-primary regression)', async () => {
   380	    // Simulate owner switching to a non-primary location via the cookie.
   381	    mockGetRequestScope.mockResolvedValue({
   382	      accountId: ACCOUNT_ID,
   383	      currentLocationId: ALT_LOCATION_ID,
   384	    });
   385	    // Outbox belongs to ALT location — should succeed.
   386	    seedTopLevel(
   387	      [
   388	        {
   389	          status: 'pending',
   390	          payload: { business_id: ALT_LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   391	          last_error: null,
   392	          aggregate_id: REVIEW_ID,
   393	        },
   394	      ],
   395	    );
   396	    const GET = await importGET();
   397	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID, locationScopeCookie: ALT_LOCATION_ID }));
   398	    expect(res.status).toBe(200);
   399	    expect(await res.json()).toEqual({ status: 'generating' });
   400	    // Verify getRequestScope was called with the ALT location from the cookie.
   401	    // Leading arg is the sql client resolveOwnerScope threads through (A+ campaign 2a).
   402	    expect(mockGetRequestScope).toHaveBeenCalledWith(sqlProxy, ACCOUNT_ID, ALT_LOCATION_ID);
   403	  });
   404	
   405	  it('returns 403 when polling a PRIMARY location outbox while scoped to ALT_LOCATION (cross-scope guard)', async () => {
   406	    // Owner scoped to ALT — should NOT see outbox from the primary location.
   407	    mockGetRequestScope.mockResolvedValue({
   408	      accountId: ACCOUNT_ID,
   409	      currentLocationId: ALT_LOCATION_ID,
   410	    });
   411	    seedTopLevel([
   412	      {
   413	        status: 'pending',
   414	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   415	        last_error: null,
   416	        aggregate_id: REVIEW_ID,
   417	      },
   418	    ]);
   419	    const GET = await importGET();
   420	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID, locationScopeCookie: ALT_LOCATION_ID }));
   421	    expect(res.status).toBe(403);
   422	    expect(await res.json()).toEqual({ error: 'forbidden' });
   423	  });
   424	});
   425	
   426	// ── #726 moderation-held draft gate ─────────────────────────────────
   427	//
   428	// A moderation-held draft (invariant #4) "surfaces neither its text nor any
   429	// button" — the poller must answer with the owner-visible refusal vocabulary
   430	// `held_for_review` and never the draft text. src/lib/moderation/held-draft.ts
   431	// is the semantic owner of "is this draft held"; the read-only poller holds no
   432	// tx, so it spells the same predicate as a correlated EXISTS on
   433	// flagged_responses inside the tenant-scoped response lookup.
   434	
   435	// Unique sentinels: heldness refusals assert these appear NOWHERE in the
   436	// serialized body — a leak of either is an invariant #4 violation.
   437	const SENTINEL_HELD_ID = 'SENTINEL_HELD_ID_84c1f0d2e6b34c5f';
   438	const SENTINEL_HELD_TEXT = 'SENTINEL_HELD_TEXT_9b3e5a710d2c4e8a';
   439	
   440	function seedCompletedOutbox() {
   441	  seedTopLevel([
   442	    {
   443	      status: 'completed',
   444	      payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
   445	      last_error: null,
   446	      aggregate_id: REVIEW_ID,
   447	    },
   448	  ]);
   449	}
   450	
   451	describe('GET /api/dashboard/past-replies/draft-status — moderation-held draft gate (#726)', () => {
   452	  it('returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag', async () => {
   453	    seedCompletedOutbox();
   454	    // Response row resolves for the caller's location but carries an OPEN flag.
   455	    seedTopLevel([
   456	      {
   457	        id: SENTINEL_HELD_ID,
   458	        status: 'pending_approval',
   459	        response_text: SENTINEL_HELD_TEXT,
   460	        business_id: LOCATION_ID,
   461	        held: true,
   462	      },
   463	    ]);
   464	    const GET = await importGET();
   465	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   466	    expect(res.status).toBe(200);
   467	    const body = await res.json();
   468	    const serialized = JSON.stringify(body);
   469	    expect(serialized).not.toContain(SENTINEL_HELD_ID);
   470	    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
   471	    // Exactly the safe shape — nothing but the refusal vocabulary.
   472	    expect(body).toEqual({ status: 'failed', error: 'held_for_review' });
   473	  });
   474	
   475	  it("returns the draft text when the resolved response's moderation flag is closed", async () => {
   476	    // Deliberate GREEN characterization: a closed flag (held: false) is the
   477	    // release path — the draft text surfaces exactly as today.
   478	    seedCompletedOutbox();
   479	    seedTopLevel([
   480	      {
   481	        id: SENTINEL_HELD_ID,
   482	        status: 'pending_approval',
   483	        response_text: SENTINEL_HELD_TEXT,
   484	        business_id: LOCATION_ID,
   485	        held: false,
   486	      },
   487	    ]);
   488	    const GET = await importGET();
   489	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   490	    expect(res.status).toBe(200);
   491	    expect(await res.json()).toEqual({
   492	      response_id: SENTINEL_HELD_ID,
   493	      status: 'pending_approval',
   494	      response_text: SENTINEL_HELD_TEXT,
   495	    });
   496	  });
   497	
   498	  it('spells the correlated open-flag EXISTS with status open inside the tenant-scoped response lookup', async () => {
   499	    // SQL-text assertion (held-draft.test.ts technique): the heldness
   500	    // predicate must live IN the response lookup itself — the poller's
   501	    // spelling of the held-draft.ts semantics.
   502	    seedCompletedOutbox();
   503	    seedTopLevel([
   504	      {
   505	        id: SENTINEL_HELD_ID,
   506	        status: 'pending_approval',
   507	        response_text: SENTINEL_HELD_TEXT,
   508	        business_id: LOCATION_ID,
   509	        held: false,
   510	      },
   511	    ]);
   512	    const GET = await importGET();
   513	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   514	    expect(res.status).toBe(200);
   515	
   516	    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
   517	    const joinTemplate = (call: unknown[]) => (call[0] as TemplateStringsArray).join('|');
   518	    const responseLookup = readCalls.find((call) => joinTemplate(call).includes('FROM responses'));
   519	    expect(responseLookup).toBeDefined();
   520	    const text = joinTemplate(responseLookup as unknown[]);
   521	    expect(text).toMatch(/EXISTS/);
   522	    expect(text).toMatch(/flagged_responses/);
   523	    // Correlation predicate: an uncorrelated EXISTS (any open flag anywhere
   524	    // holds every poll) would over-refuse fail-safe but still betray the
   525	    // query's contract — assert the join back to the outer responses row.
   526	    expect(text).toMatch(/f\.response_id\s*=\s*responses\.id/);
   527	    expect(text).toMatch(/f\.status\s*=\s*'open'/);
   528	  });
   529	
   530	  it('returns 403 with no heldness signal when the held response belongs to another tenant', async () => {
   531	    // Deliberate GREEN characterization locking tenant-before-held ordering:
   532	    // the tenant re-check must win over any held branching, and the refusal
   533	    // must carry no heldness signal (neither sentinel nor 'held' vocabulary).
   534	    seedCompletedOutbox();
   535	    seedTopLevel([
   536	      {
   537	        id: SENTINEL_HELD_ID,
   538	        status: 'pending_approval',
   539	        response_text: SENTINEL_HELD_TEXT,
   540	        business_id: OTHER_LOCATION_ID,
   541	        held: true,
   542	      },
   543	    ]);
   544	    const GET = await importGET();
   545	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   546	    expect(res.status).toBe(403);
   547	    const body = await res.json();
   548	    const serialized = JSON.stringify(body);
   549	    expect(serialized).not.toContain(SENTINEL_HELD_ID);
   550	    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
   551	    expect(serialized).not.toContain('held');
   552	    expect(body).toEqual({ error: 'forbidden' });
   553	  });
   554	});
     1	// src/lib/past-replies/__tests__/reviews-list.test.ts
     2	//
     3	// T1 EVAL suite for #678 — the Reviews list half of the 52 locked titles,
     4	// authored VERBATIM before implementation.
     5	//
     6	// **Reviews list** (CONTEXT.md glossary, verbatim): the owner's single
     7	// inventory of every review for a location. NOT a new page —
     8	// `dashboard/reviews/history` is widened in place. Grouped `Unanswered` then
     9	// `Answered`, newest-first inside each group, `PAGE_SIZE` 50. Distinct from the
    10	// **Needs Action** queue at `dashboard/reviews`.
    11	//
    12	// RED until Task 4 (the query) and Task 5 (the row derivation — since #727 the
    13	// two-axis `deriveAxes`/`deriveRowAction` — plus `provenanceBadge` /
    14	// `groupReplies`) land. Every symbol Task 5 owns is reached through the module
    15	// NAMESPACE rather than a named import: a named import of a missing export is an
    16	// ESM link error that kills the whole file, which would un-register all 17
    17	// titles. A namespace property is `undefined` today, so each title fails on its
    18	// own terms — a red test beats a todo.
    19	
    20	import { describe, expect, it, vi } from 'vitest';
    21	import type { Sql } from 'postgres';
    22	import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
    23	import * as repliesView from '../replies-view';
    24	import { loadPastRepliesPageView } from '../load-replies';
    25	
    26	// The batched regen-budget peek (Task 6) is an Upstash read. Stub it so these
    27	// pure query/grouping titles never reach Redis; its own fail-open behaviour is
    28	// pinned in src/lib/costs/__tests__/regen-budget-batch.test.ts.
    29	vi.mock('@/lib/costs/tracker', () => ({
    30	  peekRegenBudgetBatch: vi.fn(async () => new Map()),
    31	}));
    32	
    33	const { PAGE_SIZE } = repliesView;
    34	
    35	// Task 5 addition. Read off the namespace so a missing export is `undefined`
    36	// (per-title failure) rather than a module-level link error.
    37	const provenanceBadge = repliesView.provenanceBadge;
    38	
    39	const ACCOUNT_ID = '01234567-0000-7000-8000-0000000000a0';
    40	const LOCATION_ID = '01234567-0000-7000-8000-0000000000b0';
    41	const OTHER_LOCATION_ID = '01234567-0000-7000-8000-0000000000b1';
    42	const ACTIVATED = '2026-03-01T00:00:00.000Z';
    43	
    44	// ── The post-Task-4 view shape ────────────────────────────────────────────────
    45	//
    46	// `PastRepliesPageView` still spells gapRows/histRows today, so these local
    47	// interfaces describe what Task 4 Step 3 renames it to. The cast at the call
    48	// site keeps this scaffolding type-clean while leaving the ASSERTIONS red.
    49	
    50	interface ListCardRow {
    51	  review_id: string;
    52	  reply_state: string;
    53	  row_action: string;
    54	  response_id: string;
    55	  approved_text: string | null;
    56	  posted_at: string | null;
    57	  failed_response_id: string | null;
    58	  failed_posting_error: string | null;
    59	  version: number | null;
    60	}
    61	
    62	interface ReviewsListView {
    63	  locationDisplayName: string;
    64	  unansweredRows: ListCardRow[];
    65	  answeredRows: ListCardRow[];
    66	  unansweredTotal: number;
    67	  answeredTotal: number;
    68	  avgStarRating: number | null;
    69	  page: number;
    70	  totalPages: number;
    71	}
    72	
    73	interface SqlCall {
    74	  text: string;
    75	  values: readonly unknown[];
    76	}
    77	
    78	interface FakeRows {
    79	  biz?: Record<string, unknown>[];
    80	  main?: Record<string, unknown>[];
    81	  unansweredTotal?: number;
    82	  answeredTotal?: number;
    83	  avg?: number | null;
    84	}
    85	
    86	const DEFAULT_BIZ = {
    87	  name: 'Harbour Bakery',
    88	  display_label: null,
    89	  subscription_tier: 'copilot',
    90	  subscription_activated_at: new Date(ACTIVATED),
    91	};
    92	
    93	/**
    94	 * A tagged-template stand-in for the Postgres.js client. Dispatches by the SQL
    95	 * text so the assertions can also inspect what was actually issued (ORDER BY,
    96	 * OFFSET, the absence of a second row-producing query after F3).
    97	 */
    98	function fakeSql(rows: FakeRows): { sql: Sql; calls: SqlCall[] } {
    99	  const calls: SqlCall[] = [];
   100	  const tagged = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
   101	    const text = strings.join('?');
   102	    calls.push({ text, values });
   103	    if (/AS\s+review_id/i.test(text)) return Promise.resolve(rows.main ?? []);
   104	    if (/AVG\(/i.test(text)) return Promise.resolve([{ avg: rows.avg ?? null }]);
   105	    if (/COUNT\(\*\)/i.test(text) && /NOT\s+EXISTS/i.test(text)) {
   106	      return Promise.resolve([{ count: rows.unansweredTotal ?? 0 }]);
   107	    }
   108	    if (/COUNT\(\*\)/i.test(text)) return Promise.resolve([{ count: rows.answeredTotal ?? 0 }]);
   109	    if (/FROM\s+businesses/i.test(text)) return Promise.resolve(rows.biz ?? [DEFAULT_BIZ]);
   110	    return Promise.resolve([]);
   111	  };
   112	  return { sql: tagged as unknown as Sql, calls };
   113	}
   114	
   115	/** One row of the single post-F3 row source (Task 4 Step 1). */
   116	function listRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
   117	  return {
   118	    review_id: 'rev-1',
   119	    review_text: 'Lovely sourdough',
   120	    review_date: new Date('2026-04-01T12:00:00.000Z'),
   121	    review_content_hash: 'hash-1',
   122	    external_reply_ingested_at: null,
   123	    star_rating: 5,
   124	    reviewer_name: 'Sam',
   125	    // Answered iff response_id is non-null (the posted LEFT JOIN).
   126	    response_id: null,
   127	    approved_text: null,
   128	    approval_method: null,
   129	    posted_at: null,
   130	    version: null,
   131	    failed_response_id: null,
   132	    failed_posting_error: null,
   133	    draft_response_id: null,
   134	    draft_held: false,
   135	    generation_in_flight: false,
   136	    is_orphan: false,
   137	    orphan_failed_response_id: null,
   138	    orphan_posting_error: null,
   139	    superseded_text: null,
   140	    ...overrides,
   141	  };
   142	}
   143	
   144	function answeredRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
   145	  return listRow({
   146	    response_id: 'resp-1',
   147	    approved_text: 'Thanks for visiting!',
   148	    approval_method: APPROVAL_METHOD.OWNER,
   149	    posted_at: new Date('2026-04-02T09:00:00.000Z'),
   150	    version: 1,
   151	    ...overrides,
   152	  });
   153	}
   154	
   155	async function loadView(
   156	  rows: FakeRows,
   157	  page = 1,
   158	  locationId = LOCATION_ID,
   159	): Promise<{ view: ReviewsListView | null; calls: SqlCall[] }> {
   160	  const { sql, calls } = fakeSql(rows);
   161	  const raw = await loadPastRepliesPageView(sql, {
   162	    accountId: ACCOUNT_ID,
   163	    locationId,
   164	    page,
   165	  });
   166	  return { view: raw as unknown as ReviewsListView | null, calls };
   167	}
   168	
   169	function mainQuery(calls: SqlCall[]): SqlCall {
   170	  const found = calls.filter((call) => /AS\s+review_id/i.test(call.text));
   171	  expect(found).toHaveLength(1); // F3: exactly ONE row source, no orphan sidecar query
   172	  return found[0]!;
   173	}
   174	
   175	/**
   176	 * The four shapes `fakeSql` actually resolves rows for, i.e. the discrimination
   177	 * `mainQuery` does, widened to its three siblings.
   178	 *
   179	 * Query-count assertions must run through this rather than counting raw tagged
   180	 * template calls (Q3). A tagged call can also be a FRAGMENT — a bound
   181	 * `text[]` status array, for instance — which produces no rows; counting those
   182	 * makes the assertion measure helper calls instead of queries, and that is what
   183	 * dictates the production SQL's shape rather than its behaviour.
   184	 */
   185	const ROW_PRODUCING_QUERY_SHAPES = [
   186	  /AS\s+review_id/i,
   187	  /AVG\(/i,
   188	  /COUNT\(\*\)/i,
   189	  /FROM\s+businesses\s+b/i,
   190	] as const;
   191	
   192	function rowProducingQueries(calls: SqlCall[]): SqlCall[] {
   193	  return calls.filter((call) =>
   194	    ROW_PRODUCING_QUERY_SHAPES.some((shape) => shape.test(call.text)),
   195	  );
   196	}
   197	
   198	function allRows(view: ReviewsListView): ListCardRow[] {
   199	  return [...view.unansweredRows, ...view.answeredRows];
   200	}
   201	
   202	// ── loadPastRepliesPageView — the widened query ───────────────────────────────
   203	
   204	describe('loadPastRepliesPageView (Reviews list)', () => {
   205	  it('loadPastRepliesPageView returns never-replied reviews as unanswered rows', async () => {
   206	    const { view } = await loadView({
   207	      main: [listRow({ review_id: 'rev-never' })],
   208	      unansweredTotal: 1,
   209	      answeredTotal: 0,
   210	    });
   211	
   212	    expect(view).not.toBeNull();
   213	    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-never']);
   214	    expect(view!.answeredRows).toHaveLength(0);
   215	    // A never-replied review is exactly what the Generate door exists for.
   216	    expect(view!.unansweredRows[0]!.reply_state).toBe('none');
   217	    expect(view!.unansweredRows[0]!.row_action).toBe('generate');
   218	  });
   219	
   220	  it('loadPastRepliesPageView orders unanswered rows before answered rows', async () => {
   221	    // `false` sorts before `true` in Postgres, so `(resp.id IS NOT NULL)` leads
   222	    // with the unanswered group (S6). Pin the ORDER BY as well as the grouping:
   223	    // the grouping alone would still pass if the SQL sorted the other way and
   224	    // the mapper re-sorted in JS, which would break as soon as pagination bites.
   225	    const { view, calls } = await loadView({
   226	      main: [
   227	        answeredRow({ review_id: 'rev-answered', review_date: new Date('2026-05-01T00:00:00.000Z') }),
   228	        listRow({ review_id: 'rev-unanswered', review_date: new Date('2026-01-01T00:00:00.000Z') }),
   229	      ],
   230	      unansweredTotal: 1,
   231	      answeredTotal: 1,
   232	    });
   233	
   234	    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-unanswered']);
   235	    expect(view!.answeredRows.map((row) => row.review_id)).toEqual(['rev-answered']);
   236	    expect(mainQuery(calls).text).toMatch(/ORDER BY\s*\(\s*resp\.id IS NOT NULL\s*\)/i);
   237	  });
   238	
   239	  it('loadPastRepliesPageView orders newest-first within each group', async () => {
   240	    const { view } = await loadView({
   241	      main: [
   242	        listRow({ review_id: 'un-old', review_date: new Date('2026-02-01T00:00:00.000Z') }),
   243	        listRow({ review_id: 'un-new', review_date: new Date('2026-06-01T00:00:00.000Z') }),
   244	        answeredRow({ review_id: 'ans-old', review_date: new Date('2026-01-01T00:00:00.000Z') }),
   245	        answeredRow({ review_id: 'ans-new', review_date: new Date('2026-07-01T00:00:00.000Z') }),
   246	      ],
   247	      unansweredTotal: 2,
   248	      answeredTotal: 2,
   249	    });
   250	
   251	    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['un-new', 'un-old']);
   252	    expect(view!.answeredRows.map((row) => row.review_id)).toEqual(['ans-new', 'ans-old']);
   253	  });
   254	
   255	  it('loadPastRepliesPageView paginates over all reviews, not only replied ones', async () => {
   256	    // 120 unanswered + 30 answered = 150 reviews → 3 pages at PAGE_SIZE 50.
   257	    // Pre-#678 the denominator was posted-only (30 → 1 page) and the tail of a
   258	    // fresh Review import was unreachable.
   259	    const { view, calls } = await loadView({
   260	      main: [listRow()],
   261	      unansweredTotal: 120,
   262	      answeredTotal: 30,
   263	    }, 3);
   264	
   265	    expect(view!.totalPages).toBe(Math.ceil(150 / PAGE_SIZE));
   266	    expect(view!.unansweredTotal).toBe(120);
   267	    expect(view!.answeredTotal).toBe(30);
   268	    // Page 3 → OFFSET 2 * PAGE_SIZE. Asserted on page THREE, not page two: the
   269	    // `LIMIT ${PAGE_SIZE}` bind alone satisfies `toContain(PAGE_SIZE)`, so the
   270	    // page-2 form passed even with the OFFSET dropped entirely. 2 * PAGE_SIZE
   271	    // is a value the LIMIT cannot supply, so this pins the OFFSET distinctly.
   272	    expect(mainQuery(calls).values).toContain(2 * PAGE_SIZE);
   273	    expect(view!.page).toBe(3);
   274	  });
   275	
   276	  it('loadPastRepliesPageView marks a review with a non-terminal response as draft-ready and never generatable', async () => {
   277	    const { view } = await loadView({
   278	      main: [listRow({ review_id: 'rev-draft', draft_response_id: 'resp-draft', draft_held: false })],
   279	      unansweredTotal: 1,
   280	      answeredTotal: 0,
   281	    });
   282	
   283	    // No posted sibling → grouped Unanswered, but it must never offer Generate:
   284	    // the partial unique index (023+026+029) permits at most ONE non-terminal
   285	    // response per review, so a second draft could not persist anyway (S2).
   286	    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-draft']);
   287	    expect(view!.unansweredRows[0]!.reply_state).toBe('none');
   288	    expect(view!.unansweredRows[0]!.row_action).toBe('draft_ready');
   289	    expect(view!.unansweredRows[0]!.row_action).not.toBe('generate');
   290	  });
   291	
   292	  it('loadPastRepliesPageView marks a review with an in-flight generate_response outbox row as generating', async () => {
   293	    const { view, calls } = await loadView({
   294	      main: [listRow({ review_id: 'rev-gen', generation_in_flight: true })],
   295	      unansweredTotal: 1,
   296	      answeredTotal: 0,
   297	    });
   298	
   299	    expect(view!.unansweredRows[0]!.row_action).toBe('generating');
   300	    // The in-flight set is the byte-for-byte contract from job-outbox-status.ts
   301	    // (invariant #2) — members AND order.
   302	    expect(mainQuery(calls).text).toContain("'pending', 'dispatching', 'dispatched'");
   303	  });
   304	
   305	  it('loadPastRepliesPageView groups an orphan row under unanswered without a generate affordance', async () => {
   306	    const { view } = await loadView({
   307	      main: [listRow({
   308	        review_id: 'rev-orphan',
   309	        is_orphan: true,
   310	        orphan_failed_response_id: 'fail-1',
   311	        orphan_posting_error: 'post_after_delete_failed_http_400',
   312	        superseded_text: 'The reply we could not repost',
   313	      })],
   314	      unansweredTotal: 1,
   315	      answeredTotal: 0,
   316	    });
   317	
   318	    // D-G: an orphan has no live Google reply (so `Unanswered` is honest) but
   319	    // DOES have a superseded draft — offering Generate would race /retry and
   320	    // /restore-original.
   321	    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-orphan']);
   322	    expect(view!.unansweredRows[0]!.reply_state).toBe('orphan');
   323	    expect(view!.unansweredRows[0]!.row_action).toBe('recover');
   324	    expect(view!.answeredRows).toHaveLength(0);
   325	  });
   326	
   327	  it('loadPastRepliesPageView scopes every row and count to the requested business_id', async () => {
   328	    const { calls } = await loadView({
   329	      main: [listRow()],
   330	      unansweredTotal: 1,
   331	      answeredTotal: 1,
   332	    }, 1, OTHER_LOCATION_ID);
   333	
   334	    // Invariant #8: every query in the page load is tenant-scoped. The biz
   335	    // lookup additionally asserts account ownership.
   336	    const dataQueries = rowProducingQueries(calls).filter(
   337	      (call) => !/FROM\s+businesses\s+b/i.test(call.text),
   338	    );
   339	    // Exactly FOUR ROW-PRODUCING queries: the single row source, the two group
   340	    // COUNTs, and the average. Pre-#678 there were five (the separate orphan
   341	    // query, deleted by F3) and the counts were the activation-split
   342	    // gap/historical pair, which S3 replaces with per-row provenance badges.
   343	    // Counted through rowProducingQueries so a bound fragment (e.g. a status
   344	    // `text[]`) never inflates the number and dictates the production SQL (Q3).
   345	    expect(dataQueries).toHaveLength(4);
   346	    for (const call of dataQueries) {
   347	      expect(call.text).toMatch(/business_id\s*=/i);
   348	      expect(call.values).toContain(OTHER_LOCATION_ID);
   349	      // No query still splits on subscription_activated_at.
   350	      expect(call.text).not.toMatch(/timestamptz/i);
   351	    }
   352	    const bizLookup = calls.find((call) => /FROM\s+businesses\s+b/i.test(call.text));
   353	    expect(bizLookup!.values).toContain(ACCOUNT_ID);
   354	  });
   355	
   356	  it('loadPastRepliesPageView averages star rating over all reviews, not only replied ones', async () => {
   357	    const { view, calls } = await loadView({
   358	      main: [listRow()],
   359	      unansweredTotal: 3,
   360	      answeredTotal: 1,
   361	      avg: 4.25,
   362	    });
   363	
   364	    expect(view!.avgStarRating).toBe(4.25);
   365	    const avgQuery = calls.find((call) => /AVG\(/i.test(call.text))!;
   366	    // No posted-only JOIN: the denominator is every review for the location.
   367	    expect(avgQuery.text).not.toMatch(/JOIN\s+responses/i);
   368	    expect(avgQuery.text).not.toContain("'posted'");
   369	  });
   370	
   371	  it('loadPastRepliesPageView returns each orphan review exactly once as recover and never as generate', async () => {
   372	    // F3: before the single-query merge, an orphan review matched BOTH the
   373	    // (now LEFT-joined) main query and the separate un-offset orphan query, so
   374	    // it rendered twice — once as `generate`, once as `recover` — on every page.
   375	    const { view, calls } = await loadView({
   376	      main: [
   377	        listRow({
   378	          review_id: 'rev-orphan',
   379	          is_orphan: true,
   380	          orphan_failed_response_id: 'fail-9',
   381	          orphan_posting_error: 'post_after_delete_failed_timeout',
   382	          superseded_text: 'original',
   383	        }),
   384	        listRow({ review_id: 'rev-plain' }),
   385	      ],
   386	      unansweredTotal: 2,
   387	      answeredTotal: 0,
   388	    });
   389	
   390	    const orphanOccurrences = allRows(view!).filter((row) => row.review_id === 'rev-orphan');
   391	    expect(orphanOccurrences).toHaveLength(1);
   392	    expect(orphanOccurrences[0]!.row_action).toBe('recover');
   393	    expect(orphanOccurrences[0]!.row_action).not.toBe('generate');
   394	    // …and the separate orphan query is gone (mainQuery asserts exactly one).
   395	    mainQuery(calls);
   396	  });
   397	
   398	  it('consecutive Reviews-list pages are disjoint and each contains at most PAGE_SIZE unique reviews, including orphan recovery rows', async () => {
   399	    const pageOne = Array.from({ length: PAGE_SIZE }, (_unused, index) =>
   400	      listRow({
   401	        review_id: `p1-${index}`,
   402	        is_orphan: index === 0,
   403	        orphan_failed_response_id: index === 0 ? 'fail-p1' : null,
   404	        orphan_posting_error: index === 0 ? 'post_after_delete_failed_http_400' : null,
   405	        review_date: new Date(Date.UTC(2026, 5, 1) - index * 86_400_000),
   406	      }),
   407	    );
   408	    const pageTwo = Array.from({ length: 10 }, (_unused, index) =>
   409	      listRow({ review_id: `p2-${index}`, review_date: new Date(Date.UTC(2026, 3, 1) - index * 86_400_000) }),
   410	    );
   411	
   412	    const first = await loadView({ main: pageOne, unansweredTotal: 60, answeredTotal: 0 }, 1);
   413	    const second = await loadView({ main: pageTwo, unansweredTotal: 60, answeredTotal: 0 }, 2);
   414	
   415	    const firstIds = allRows(first.view!).map((row) => row.review_id);
   416	    const secondIds = allRows(second.view!).map((row) => row.review_id);
   417	
   418	    expect(new Set(firstIds).size).toBe(firstIds.length);
   419	    expect(new Set(secondIds).size).toBe(secondIds.length);
   420	    expect(firstIds.length).toBeLessThanOrEqual(PAGE_SIZE);
   421	    expect(secondIds.length).toBeLessThanOrEqual(PAGE_SIZE);
   422	    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
   423	
   424	    // Orphans are now INSIDE the LIMIT/OFFSET window rather than merged
   425	    // un-offset into every page (F3 / Task 4 Step 2a). The OFFSET is pinned
   426	    // POSITIONALLY — it is the last of the trailing `LIMIT ${PAGE_SIZE} OFFSET
   427	    // ${offset}` binds — rather than by membership: on page 2 the OFFSET equals
   428	    // PAGE_SIZE, so `toContain(PAGE_SIZE)` is satisfied by the LIMIT bind alone
   429	    // and passes even with the OFFSET dropped entirely.
   430	    const firstBinds = mainQuery(first.calls).values;
   431	    const secondBinds = mainQuery(second.calls).values;
   432	    expect(firstBinds.at(-2)).toBe(PAGE_SIZE);
   433	    expect(firstBinds.at(-1)).toBe(0);
   434	    expect(secondBinds.at(-2)).toBe(PAGE_SIZE);
   435	    expect(secondBinds.at(-1)).toBe(PAGE_SIZE);
   436	  });
   437	
   438	  it('Reviews-list pagination uses review_id as a deterministic tie-breaker when review dates are equal', async () => {
   439	    // F7: without `, r.id DESC` two reviews sharing a review_date can swap
   440	    // between pages, so a row is shown twice and another never at all.
   441	    const sameInstant = new Date('2026-05-05T10:00:00.000Z');
   442	    const { view, calls } = await loadView({
   443	      main: [
   444	        listRow({ review_id: 'rev-b', review_date: sameInstant }),
   445	        listRow({ review_id: 'rev-a', review_date: sameInstant }),
   446	      ],
   447	      unansweredTotal: 2,
   448	      answeredTotal: 0,
   449	    });
   450	
   451	    expect(mainQuery(calls).text).toMatch(/ORDER BY[\s\S]*r\.review_date DESC\s*,\s*r\.id DESC/i);
   452	    expect(allRows(view!)).toHaveLength(2);
   453	  });
   454	
   455	  it('an orphan row keeps its failed_response_id and superseded text after the single-query merge', async () => {
   456	    // Round-2 Defect A. `PastReplyCard` renders the recovery badge from the
   457	    // server-derived `recover` state (PastReplyCard.tsx:314) and gates the
   458	    // recovery ACTIONS on `row.failed_response_id` (:388, :442). The deleted
   459	    // `toOrphanCardRow` fed both from the orphan query's columns; post-F3
   460	    // they must come from the orphan_sidecar / orphan_superseded LATERALs.
   461	    const { view } = await loadView({
   462	      main: [listRow({
   463	        review_id: 'rev-orphan',
   464	        is_orphan: true,
   465	        orphan_failed_response_id: 'fail-42',
   466	        orphan_posting_error: 'post_after_delete_failed_retry_exhausted',
   467	        superseded_text: 'The reply the owner approved before the failed edit',
   468	      })],
   469	      unansweredTotal: 1,
   470	      answeredTotal: 0,
   471	    });
   472	
   473	    const row = view!.unansweredRows[0]!;
   474	    expect(row.failed_response_id).toBe('fail-42');
   475	    // The old mapper set BOTH — /retry and /restore-original address the failed
   476	    // response by id.
   477	    expect(row.response_id).toBe('fail-42');
   478	    expect(row.failed_posting_error).toBe('post_after_delete_failed_retry_exhausted');
   479	    expect(row.approved_text).toBe('The reply the owner approved before the failed edit');
   480	    // An orphan has no live posted reply, so posted_at must be null on the wire.
   481	    expect(row.posted_at).toBeNull();
   482	    expect(row.version).toBeNull();
   483	  });
   484	});
   485	
   486	// ── provenanceBadge (D-E) ─────────────────────────────────────────────────────
   487	
   488	describe('provenanceBadge', () => {
   489	  it('provenanceBadge returns posted-before-joining for an ingested reply predating activation', () => {
   490	    expect(
   491	      provenanceBadge(
   492	        {
   493	          external_reply_ingested_at: '2026-03-05T00:00:00.000Z',
   494	          approval_method: null,
   495	          review_date: '2026-01-15T00:00:00.000Z',
   496	        },
   497	        ACTIVATED,
   498	      ),
   499	    ).toBe('posted_before_joining');
   500	  });
   501	
   502	  it('provenanceBadge returns replied-on-google for an ingested reply dated after activation', () => {
   503	    // The owner replied in Google's own UI while subscribed — a different fact
   504	    // from "we imported your history", and the fourth badge D-E widened S3 with.
   505	    expect(
   506	      provenanceBadge(
   507	        {
   508	          external_reply_ingested_at: '2026-04-10T00:00:00.000Z',
   509	          approval_method: null,
   510	          review_date: '2026-04-01T00:00:00.000Z',
   511	        },
   512	        ACTIVATED,
   513	      ),
   514	    ).toBe('replied_on_google');
   515	  });
   516	
   517	  it('provenanceBadge returns auto-approved for an auto_policy reply', () => {
   518	    expect(
   519	      provenanceBadge(
   520	        {
   521	          external_reply_ingested_at: null,
   522	          approval_method: APPROVAL_METHOD.AUTO_POLICY,
   523	          review_date: '2026-04-01T00:00:00.000Z',
   524	        },
   525	        ACTIVATED,
   526	      ),
   527	    ).toBe('auto_approved');
   528	  });
   529	
   530	  it('provenanceBadge returns owner-approved for an owner-approved reply', () => {
   531	    expect(
   532	      provenanceBadge(
   533	        {
   534	          external_reply_ingested_at: null,
   535	          approval_method: APPROVAL_METHOD.OWNER,
   536	          review_date: '2026-04-01T00:00:00.000Z',
   537	        },
   538	        ACTIVATED,
   539	      ),
   540	    ).toBe('owner_approved');
   541	  });
   542	});
     1	#!/usr/bin/env bash
     2	# scripts/verify-gate.sh — the /feature step 5 gate.
     3	#
     4	# The audit set is derived from package.json's ci:* scripts (single
     5	# authoritative owner — the same list CI's lint job and the lefthook
     6	# pre-push gate run), so a gate-green branch can't fail push-time audits.
     7	# ci:fallow* is excluded: the fallow gate runs in its own CI workflow with
     8	# its own baseline and env expectations.
     9	#
    10	# Checks run in PARALLEL (like the lefthook pre-push gate): wall-clock ≈ the
    11	# slowest check, and all failures surface together in one table.
    12	#
    13	# Changed *.integration.test.ts files are surfaced explicitly: live-DB
    14	# suites self-skip without TEST_DATABASE_POOL_URL, which is how a red CI
    15	# once shipped from a "green" local run (the #520 failure class). With the
    16	# env var set they RUN as part of the gate; without it they appear as a
    17	# loud SKIP row instead of passing silently.
    18	#
    19	# DB precondition (owned by the gate, not the intake): TEST_DATABASE_POOL_URL
    20	# is resolved here (env first, .env.local fallback), and a db_touching intake
    21	# gets the test DB provisioned SERIALLY before the parallel fan-out.
    22	# `pnpm test:db:setup` drops schema `public` — run as a parallel peer (a #643
    23	# verification_command) it demolished the schema underneath its own siblings
    24	# (27 phantom timeouts). Destructive commands in verification_commands are
    25	# rejected, not run.
    26	#
    27	# Docs-only mode (auto-detected): when every changed path is docs/, .claude/,
    28	# or *.md, the code rows (test, build, promised-tests, reclassify,
    29	# diff-coverage) are meaningless — two #643 sessions hit a wall where a
    30	# docs-only commit could never go green. Lint, typecheck, and the ci:* audits
    31	# still run; gate-status.json records "mode":"docs_only".
    32	#
    33	# Post-check rows (after the parallel checks):
    34	#   promised-tests — every tests_to_add entry (a VERBATIM test title) must
    35	#     exist in a test file; missing titles are listed.
    36	#   reclassify — WARN when either diff bucket (production / test) exceeds
    37	#     ~2x its intake estimate (estimated_prod_lines / estimated_test_lines;
    38	#     legacy fallback: estimated_diff_size vs the combined total). Workflow
    39	#     artifacts (docs/superpowers/plans/**, docs/reviews/**) are EXCLUDED —
    40	#     #643's plan+deviations alone were 1,537 of 4,989 "changed lines",
    41	#     firing the trigger on the workflow's own paperwork.
    42	#
    43	# `--review` mode (run once before step 7): the test row runs with
    44	# coverage, then diff-coverage enforces changed-line coverage (default min
    45	# 80%, override with DIFF_COVERAGE_MIN) via scripts/diff-coverage.ts.
    46	set -uo pipefail
    47	
    48	REVIEW_MODE=false
    49	[ "${1:-}" = "--review" ] && REVIEW_MODE=true
    50	
    51	INTAKE=".feature/intake.json"
    52	mkdir -p .feature/logs
    53	
    54	# Fatal abort taken before the results table exists. Records a RED
    55	# gate-status.json on the way out: leaving the previous run's green file on
    56	# disk would let the Stop hook read a stale success as this run's result.
    57	#
    58	# Defined BEFORE anything that can fail, including the sourced row library, so
    59	# every later failure exits THROUGH here rather than around it.
    60	gate_abort() {
    61	  local row="$1" message="$2"
    62	  # Best effort: TERM the launched subshells so an abort does not leave a pile
    63	  # of visibly running rows. Their own children (pnpm → node) share this
    64	  # shell's process group and are NOT reaped — building per-row process groups
    65	  # would mean enabling job control, which changes the `jobs -rp` throttle the
    66	  # fan-out depends on. A duplicate row name is a gate bug that should never
    67	  # reach a user; this is tidiness, not a guarantee.
    68	  kill $(jobs -p) 2>/dev/null || true
    69	  printf '{"passed":false,"mode":"full","timestamp":%s,"checks":[{"name":"%s","result":"FAIL"}]}\n' \
    70	    "$(date +%s)" "$row" > .feature/gate-status.json
    71	  echo "VERIFY GATE:"
    72	  printf '  %-24s %s\n' "$row" "FAIL"
    73	  echo "GATE: RED — $message"
    74	  exit 1
    75	}
    76	
    77	# Row identity. A row's name is also its log file and its coverage directory,
    78	# so name uniqueness is a correctness property rather than cosmetics (#696).
    79	# Sourced rather than inlined: sourcing THIS script would run the gate, which
    80	# left the derivation with no unit-test seam.
    81	# `CDPATH=` because an exported CDPATH makes `cd` resolve somewhere else and
    82	# print the directory it chose, silently pointing this at the wrong tree.
    83	GATE_SCRIPT_DIR=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    84	# shellcheck source=scripts/gate-rows.sh
    85	. "$GATE_SCRIPT_DIR/gate-rows.sh"
    86	# A library that did not load must not surface as a bogus collision: with
    87	# assert_unique_row_name undefined, `launch` reads the resulting exit 127 as a
    88	# duplicate and aborts naming a row that is perfectly fine.
    89	command -v row_slug >/dev/null 2>&1 && [ -n "${GATE_ROW_HASH_CMD:-}" ] \
    90	  || gate_abort "row-identity" \
    91	       "scripts/gate-rows.sh did not load (see above) — row names cannot be made collision-free."
    92	
    93	SURFACE=$(jq -r '.surface // "backend"' "$INTAKE" 2>/dev/null || echo "backend")
    94	DB_TOUCHING=$(jq -r '.db_touching // false' "$INTAKE" 2>/dev/null || echo "false")
    95	
    96	BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
    97	
    98	# Docs-only detection: branch diff + working tree, same union the
    99	# integration-suite scan uses below.
   100	CHANGED_PATHS=$(
   101	  {
   102	    [ -n "$BASE" ] && git diff --name-only "$BASE" HEAD
   103	    git status --porcelain --untracked-files=all | cut -c4-
   104	  } 2>/dev/null | sort -u | grep -v '^$' || true
   105	)
   106	DOCS_ONLY=false
   107	if [ -n "$CHANGED_PATHS" ] && \
   108	   ! printf '%s\n' "$CHANGED_PATHS" | grep -qvE '^docs/|^\.claude/|\.md$'; then
   109	  DOCS_ONLY=true
   110	fi
   111	
   112	# Resolve TEST_DATABASE_POOL_URL so changed integration suites never SKIP on
   113	# a machine that has the DB configured (#643: the gate itself reported SKIP
   114	# and then declared its own result not review-ready).
   115	if [ -z "${TEST_DATABASE_POOL_URL:-}" ] && [ -f .env.local ]; then
   116	  ENV_URL=$(grep -E '^TEST_DATABASE_POOL_URL=' .env.local | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
   117	  [ -n "$ENV_URL" ] && export TEST_DATABASE_POOL_URL="$ENV_URL"
   118	fi
   119	
   120	# Serial DB provisioning — a precondition, never a parallel peer. Fail fast:
   121	# every DB row downstream of a failed provision is noise.
   122	DB_PROVISION_RESULT=""
   123	if [ "$DOCS_ONLY" = false ] && [ "$DB_TOUCHING" = "true" ] && [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
   124	  if pnpm test:db:setup > .feature/logs/db-provision.log 2>&1; then
   125	    DB_PROVISION_RESULT="PASS"
   126	  else
   127	    gate_abort "db-provision" \
   128	      "test-DB provisioning failed (tail .feature/logs/db-provision.log); parallel checks not started."
   129	  fi
   130	fi
   131	
   132	NAMES=()
   133	PIDS=()
   134	
   135	# Bound the fan-out. Unbounded, this script launches ~20 concurrent rows —
   136	# the full vitest suite, a Next build, one vitest process per changed live-DB
   137	# suite, and every ci:* audit — and the resulting CPU starvation trips vitest's
   138	# 5s default testTimeout in rows that pass in under a second on their own. A
   139	# gate that goes RED under its own load is worse than no gate.
   140	MAX_PARALLEL=${MAX_PARALLEL:-4}
   141	# The full-suite row sizes its own worker pool from the core count, so the row
   142	# cap alone still oversubscribes. Bound it too; gate-only, so `pnpm test` on its
   143	# own is untouched. (vitest 4 flag — the old VITEST_MAX_THREADS env var is gone.)
   144	VITEST_WORKERS=${VITEST_WORKERS:-4}
   145	
   146	launch() {
   147	  local name="$1"; shift
   148	  # One name = one status slot = one .feature/logs/<name>.log. A second row
   149	  # under the same name can only be reported as the first one's result, so it
   150	  # aborts the gate instead of resolving silently (#696). `${NAMES[@]+…}` is
   151	  # the bash 3.2 spelling for expanding a possibly-empty array under `set -u`.
   152	  assert_unique_row_name "$name" ${NAMES[@]+"${NAMES[@]}"} \
   153	    || gate_abort "row-name-collision" "duplicate gate row name '$name' (see above)."
   154	  # Throttle by POLLING `jobs -rp`, never `wait -n`: the result loop below
   155	  # recovers each row's exit code with `wait "${PIDS[$i]}"`, and `wait -n` does
   156	  # not exist in bash 3.2 (what /usr/bin/env bash resolves to on macOS) — it
   157	  # returns "invalid option" without blocking, spinning this loop forever.
   158	  # `jobs -rp` counts running jobs without consuming any exit status.
   159	  while [ "$(jobs -rp | wc -l)" -ge "$MAX_PARALLEL" ]; do
   160	    sleep 0.5
   161	  done
   162	  ( "$@" ) > ".feature/logs/${name}.log" 2>&1 &
   163	  NAMES+=("$name")
   164	  PIDS+=("$!")
   165	}
   166	
   167	launch lint      pnpm lint
   168	launch typecheck pnpm typecheck
   169	
   170	# The full-suite row runs with live-DB suites forced ASLEEP (#563 item 1).
   171	# With the test DB reachable, `pnpm test` wakes every *.integration.test.ts in
   172	# the repo; the ones that set the `src/lib/db/server` singleton at import time
   173	# then break inside a full run, because another file already initialized that
   174	# singleton against a different URL (ECONNREFUSED :5432 — the #520 class).
   175	# They pass when invoked directly, which is what the dedicated `integration-*`
   176	# rows below are for.
   177	#
   178	# BOTH switches are required. `env -u TEST_DATABASE_POOL_URL` alone is NOT
   179	# enough: `resolveTestDatabaseUrl()` falls back to reading .env.local off disk,
   180	# so the suites gating on it wake up regardless of the environment.
   181	run_full_suite() {
   182	  env -u TEST_DATABASE_POOL_URL REPWORTH_DISABLE_LIVE_DB_SUITES=1 "$@"
   183	}
   184	if [ "$DOCS_ONLY" = false ]; then
   185	  if [ "$REVIEW_MODE" = true ]; then
   186	    launch test run_full_suite pnpm test:coverage --maxWorkers="$VITEST_WORKERS"
   187	  else
   188	    launch test run_full_suite pnpm test --maxWorkers="$VITEST_WORKERS"
   189	  fi
   190	fi
   191	
   192	# Every ci:* audit from package.json (excluding ci:fallow*).
   193	while IFS= read -r SCRIPT; do
   194	  launch "${SCRIPT#ci:}" pnpm "$SCRIPT"
   195	done < <(jq -r '.scripts | keys[] | select(startswith("ci:")) | select(startswith("ci:fallow") | not)' package.json)
   196	
   197	if { [ "$SURFACE" = "ui" ] || [ "$SURFACE" = "mixed" ]; } && [ "$DOCS_ONLY" = false ]; then
   198	  launch build pnpm build
   199	fi
   200	
   201	# Extra commands declared in the intake (each entry is one shell command).
   202	# Destructive DB commands are REJECTED, not run: the gate owns provisioning
   203	# (serial, above) — a schema-dropping command can never be a safe parallel
   204	# peer of the suites reading that schema (#643 step-5 gate incident).
   205	#
   206	# A rejected extra never reaches `launch`, so it asserts its own name: row_slug
   207	# separates two DIFFERENT commands, but two IDENTICAL intake entries derive the
   208	# same slug and would share one row and one log (#696).
   209	REJECTED_EXTRAS=()
   210	while IFS= read -r CMD; do
   211	  [ -n "$CMD" ] || continue
   212	  SAFE=$(row_slug "$CMD")
   213	  if echo "$CMD" | grep -qiE 'test:db:setup|db:setup|drop schema'; then
   214	    assert_unique_row_name "extra-${SAFE}" \
   215	      ${NAMES[@]+"${NAMES[@]}"} ${REJECTED_EXTRAS[@]+"${REJECTED_EXTRAS[@]}"} \
   216	      || gate_abort "row-name-collision" "duplicate gate row name 'extra-${SAFE}' (see above)."
   217	    echo "rejected destructive verification_command: $CMD" > ".feature/logs/extra-${SAFE}.log"
   218	    echo "The gate provisions the test DB serially when db_touching — remove this from the intake." >> ".feature/logs/extra-${SAFE}.log"
   219	    REJECTED_EXTRAS+=("extra-${SAFE}")
   220	    continue
   221	  fi
   222	  launch "extra-${SAFE}" bash -c "$CMD"
   223	done < <(jq -r '.verification_commands[]?' "$INTAKE" 2>/dev/null)
   224	
   225	# Changed live-DB integration suites (branch diff vs fork point + working
   226	# tree). They self-skip without TEST_DATABASE_POOL_URL — never let that
   227	# read as green.
   228	CHANGED_INTEGRATION=$(printf '%s\n' "$CHANGED_PATHS" | grep -E '\.integration\.test\.ts$' || true)
   229	INTEGRATION_SKIPPED=0
   230	# Per-row coverage output. Each integration row is its own vitest process
   231	# writing a COMPLETE coverage-final.json, so a shared directory would let the
   232	# last row overwrite every other one (#563 item 2). One directory per row, then
   233	# merged into the base report before diff-coverage reads it. "Per row" is only
   234	# true because the row name is collision-free: while it was a 40-character
   235	# truncation, two import-consent-*.integration.test.ts suites resolved to ONE
   236	# directory and raced it to an ENOENT (#696) — and, worse, to one status slot.
   237	INTEGRATION_COV_DIR=".feature/coverage"
   238	rm -rf "$INTEGRATION_COV_DIR"
   239	if [ -n "$CHANGED_INTEGRATION" ]; then
   240	  if [ -n "${TEST_DATABASE_POOL_URL:-}" ]; then
   241	    while IFS= read -r FILE; do
   242	      [ -f "$FILE" ] || continue
   243	      SAFE=$(row_slug "$FILE")
   244	      if [ "$REVIEW_MODE" = true ]; then
   245	        launch "integration-${SAFE}" pnpm vitest run "$FILE" \
   246	          --coverage --coverage.reportOnFailure \
   247	          --coverage.reportsDirectory="${INTEGRATION_COV_DIR}/${SAFE}"
   248	      else
   249	        launch "integration-${SAFE}" pnpm vitest run "$FILE"
   250	      fi
   251	    done <<< "$CHANGED_INTEGRATION"
   252	  else
   253	    INTEGRATION_SKIPPED=$(printf '%s\n' "$CHANGED_INTEGRATION" | grep -c .)
   254	  fi
   255	fi
   256	
   257	RESULTS=()
   258	for i in "${!NAMES[@]}"; do
   259	  if wait "${PIDS[$i]}"; then
   260	    RESULTS+=("PASS")
   261	  else
   262	    RESULTS+=("FAIL")
   263	  fi
   264	done
   265	
   266	# Rows recorded outside the parallel section (appended after the wait loop so
   267	# NAMES/PIDS index pairing above stays intact).
   268	if [ -n "$DB_PROVISION_RESULT" ]; then
   269	  NAMES+=("db-provision"); RESULTS+=("$DB_PROVISION_RESULT")
   270	fi
   271	for REJECTED in ${REJECTED_EXTRAS[@]+"${REJECTED_EXTRAS[@]}"}; do
   272	  NAMES+=("$REJECTED"); RESULTS+=("FAIL")
   273	done
   274	
   275	# Synchronous post-check, appended after the parallel rows.
   276	run_sync() {
   277	  local name="$1"; shift
   278	  if "$@" > ".feature/logs/${name}.log" 2>&1; then
   279	    NAMES+=("$name"); RESULTS+=("PASS")
   280	  else

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba worker/__tests__/helpers/mock-sql.ts; sed -n '185,330p' src/lib/agents/__tests__/read.test.ts | nl -ba -v185; sed -n '1,260p' 'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts' | nl -ba; sed -n '1,300p' src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts | nl -ba; sed -n '275,430p' scripts/verify-gate.sh | nl -ba -v275" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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
   181	 *   vi.mock('../../../../src/lib/shared/logger', () => ({
   182	 *     createWorkerLogger: () => mockLogger,
   183	 *   }));
   184	 */
   185	export function mockWorkerLogger(): MockWorkerLogger {
   186	  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
   187	}
   185	describe('getReviewTimeline', () => {
   186	  const harness = createMockSql();
   187	
   188	  beforeEach(() => {
   189	    harness.resetMockSql();
   190	  });
   191	
   192	  it('returns null after the tenant-scoped review pre-read misses', async () => {
   193	    harness.sqlReturnQueue.push([]);
   194	
   195	    await expect(
   196	      getReviewTimeline(harness.mockSql as unknown as Sql, {
   197	        accountId: 'account-1',
   198	        reviewId: 'review-1',
   199	      }),
   200	    ).resolves.toBeNull();
   201	
   202	    expect(harness.sqlCalls).toHaveLength(1);
   203	    expect(harness.sqlCalls[0]!.text).toMatch(/FROM reviews r\s+JOIN businesses b/);
   204	    expect(harness.sqlCalls[0]!.text).toMatch(/r\.id = \?/);
   205	    expect(harness.sqlCalls[0]!.text).toMatch(/b\.account_id = \?/);
   206	    expect(harness.sqlCalls[0]!.text).toContain('b.archived_at IS NULL');
   207	    expect(harness.sqlCalls[0]!.values).toEqual(['review-1', 'account-1']);
   208	  });
   209	
   210	  it('returns an honest empty timeline for a scoped legacy review', async () => {
   211	    harness.sqlReturnQueue.push(
   212	      [
   213	        {
   214	          id: 'review-1',
   215	          star_rating: 4,
   216	          reviewer_name: 'Ada',
   217	          review_date: new Date('2026-07-10T09:30:00.000Z'),
   218	          status: 'pending_approval',
   219	        },
   220	      ],
   221	      [],
   222	      [],
   223	      [],
   224	    );
   225	
   226	    await expect(
   227	      getReviewTimeline(harness.mockSql as unknown as Sql, {
   228	        accountId: 'account-1',
   229	        reviewId: 'review-1',
   230	      }),
   231	    ).resolves.toEqual({
   232	      review: {
   233	        id: 'review-1',
   234	        rating: 4,
   235	        reviewerName: 'Ada',
   236	        submittedAt: '2026-07-10T09:30:00.000Z',
   237	        status: 'pending_approval',
   238	      },
   239	      response: null,
   240	      escalation: null,
   241	      runs: [],
   242	    });
   243	
   244	    expect(harness.sqlCalls).toHaveLength(4);
   245	    expect(harness.sqlCalls[1]!.text).toMatch(/FROM responses resp/);
   246	    expect(harness.sqlCalls[1]!.text).toMatch(/b\.account_id = \?/);
   247	    expect(harness.sqlCalls[2]!.text).toMatch(/FROM review_escalations e/);
   248	    expect(harness.sqlCalls[2]!.text).toMatch(/e\.account_id = \?/);
   249	    expect(harness.sqlCalls[3]!.text).toMatch(/FROM agent_runs ar/);
   250	    expect(harness.sqlCalls[3]!.text).toContain('LIMIT 20');
   251	  });
   252	
   253	  it('batches steps and outcomes and maps stored attribution and JSONB fields', async () => {
   254	    harness.sqlReturnQueue.push(
   255	      [
   256	        {
   257	          id: 'review-1',
   258	          star_rating: 5,
   259	          reviewer_name: 'Grace',
   260	          review_date: '2026-07-12T08:00:00.000Z',
   261	          status: 'pending_approval',
   262	        },
   263	      ],
   264	      [
   265	        {
   266	          id: 'response-1',
   267	          status: 'pending_approval',
   268	          approval_method: null,
   269	          auto_post_scheduled_at: null,
   270	          posted_at: null,
   271	          response_text: 'Thanks, Grace!',
   272	          version: 2,
   273	        },
   274	      ],
   275	      [
   276	        {
   277	          id: 'escalation-1',
   278	          status: 'acknowledged',
   279	          triage_severity: 'high',
   280	          triage_suggested_action: 'respond_and_escalate',
   281	          created_at: '2026-07-12T08:02:00.000Z',
   282	          acknowledged_at: '2026-07-12T08:05:00.000Z',
   283	          resolved_at: null,
   284	        },
   285	      ],
   286	      [
   287	        {
   288	          id: 'run-new',
   289	          status: 'running',
   290	          kind: 'review_handler',
   291	          started_at: '2026-07-12T08:01:00.000Z',
   292	          ended_at: null,
   293	          error: null,
   294	        },
   295	        {
   296	          id: 'run-old',
   297	          status: 'failed',
   298	          kind: 'review_handler',
   299	          started_at: '2026-07-11T08:01:00.000Z',
   300	          ended_at: '2026-07-11T08:03:00.000Z',
   301	          error: '{"reason":"provider_terminal"}',
   302	        },
   303	      ],
   304	      [
   305	        {
   306	          agent_run_id: 'run-new',
   307	          step_index: 1,
   308	          step_key: 'review_ingested',
   309	          attributed_agent: 'system',
   310	          status: 'completed',
   311	          detail: '{"source":"zernio"}',
   312	          latency_ms: 12,
   313	          created_at: '2026-07-12T08:01:01.000Z',
   314	        },
   315	        {
   316	          agent_run_id: 'run-new',
   317	          step_index: 2,
   318	          step_key: 'draft_generated',
   319	          attributed_agent: 'guardian',
   320	          status: 'completed',
   321	          detail: { response_id: 'response-1' },
   322	          latency_ms: null,
   323	          created_at: '2026-07-12T08:01:02.000Z',
   324	        },
   325	        {
   326	          agent_run_id: 'run-old',
   327	          step_index: 1,
   328	          step_key: 'policy_gate',
   329	          attributed_agent: 'reply',
   330	          status: 'failed',
     1	// src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts
     2	//
     3	// T1 EVAL suite for #678 — the reviewId-keyed poller for **On-demand
     4	// generation**.
     5	//
     6	// D-C: deliberately NOT the existing `past-replies/draft-status`. That one
     7	// returns 503 `feature_disabled` when EDIT_REPLIES_ENABLED is off (Generate must
     8	// not depend on that flag — it never touches a live Google reply) and is keyed
     9	// on `outbox_id`, which is client state a refresh loses. Keying on `reviewId` is
    10	// what makes `Generating…` survive a page refresh.
    11	//
    12	// RED until Task 3 creates `../route.ts`.
    13	
    14	import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
    15	import { NextRequest } from 'next/server';
    16	import { QUEUE_NAMES } from '@/lib/shared/queue-names';
    17	
    18	// ── Hoisted shared state ─────────────────────────────────────────────────────
    19	
    20	const {
    21	  mockRequireRole,
    22	  mockGetRequestScope,
    23	  ownerQueue,
    24	  ownerCalls,
    25	  readQueue,
    26	  readCalls,
    27	  sqlProxy,
    28	  sqlReadProxy,
    29	} = vi.hoisted(() => {
    30	  const mockRequireRole = vi.fn();
    31	  const mockGetRequestScope = vi.fn();
    32	
    33	  const ownerQueue: unknown[][] = [];
    34	  const ownerCalls: { text: string; values: unknown[] }[] = [];
    35	  const readQueue: unknown[][] = [];
    36	  const readCalls: { text: string; values: unknown[] }[] = [];
    37	
    38	  // sql (write pool): only the `statusArraySql` fragment binding survives here.
    39	  // This handler writes nothing and is polled every ~1.5s, so every QUERY —
    40	  // including the tenant-ownership proof — runs on the read bulkhead below.
    41	  const sqlMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    42	    ownerCalls.push({ text: strings.join('?'), values });
    43	    return Promise.resolve(ownerQueue.shift() ?? []);
    44	  });
    45	  const sqlProxy = new Proxy(sqlMock, {
    46	    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
    47	  });
    48	
    49	  // sqlRead (read bulkhead): the tenant proof, the draft lookup, the outbox lookup.
    50	  const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    51	    readCalls.push({ text: strings.join('?'), values });
    52	    return Promise.resolve(readQueue.shift() ?? []);
    53	  });
    54	  const sqlReadProxy = new Proxy(sqlReadMock, {
    55	    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
    56	  });
    57	
    58	  return {
    59	    mockRequireRole,
    60	    mockGetRequestScope,
    61	    ownerQueue,
    62	    ownerCalls,
    63	    readQueue,
    64	    readCalls,
    65	    sqlProxy,
    66	    sqlReadProxy,
    67	  };
    68	});
    69	
    70	vi.mock('@/lib/db/auth', () => {
    71	  class AuthError extends Error {
    72	    constructor(message: string, public readonly statusCode: number) {
    73	      super(message);
    74	      this.name = 'AuthError';
    75	    }
    76	  }
    77	  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
    78	});
    79	
    80	vi.mock('@/lib/db/server', () => ({
    81	  sql: sqlProxy,
    82	  sqlRead: sqlReadProxy,
    83	  jsonb: (v: unknown) => v,
    84	}));
    85	
    86	// Mocked purely so the "must never be consulted" assertion below has something
    87	// to observe: this poller is ACCOUNT-scoped, not current-location-scoped.
    88	vi.mock('@/lib/auth/get-request-scope', () => ({
    89	  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
    90	}));
    91	
    92	// ── Helpers ──────────────────────────────────────────────────────────────────
    93	
    94	const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
    95	const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
    96	const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
    97	const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
    98	const APP_URL = 'http://localhost:3000';
    99	
   100	function makeRequest(locationScopeCookie?: string): NextRequest {
   101	  const headers: Record<string, string> = {};
   102	  if (locationScopeCookie) headers['Cookie'] = `rw_location_scope=${locationScopeCookie}`;
   103	  return new NextRequest(
   104	    `${APP_URL}/api/dashboard/reviews/${REVIEW_ID}/draft-status`,
   105	    { method: 'GET', headers },
   106	  );
   107	}
   108	
   109	const routeParams = { params: Promise.resolve({ reviewId: REVIEW_ID }) };
   110	
   111	type RouteHandler = (
   112	  req: NextRequest,
   113	  ctx: { params: Promise<{ reviewId: string }> },
   114	) => Promise<Response>;
   115	
   116	async function importGET(): Promise<RouteHandler> {
   117	  const mod = await import('../route');
   118	  return mod.GET as unknown as RouteHandler;
   119	}
   120	
   121	/** The tenant-ownership proof is the FIRST read-bulkhead query of the handler. */
   122	function seedOwned(rows: unknown[] = [{ business_id: LOCATION_ID }]): void {
   123	  readQueue.push(rows);
   124	}
   125	
   126	function seedRead(...rowsets: unknown[][]): void {
   127	  readQueue.push(...rowsets);
   128	}
   129	
   130	beforeEach(() => {
   131	  vi.clearAllMocks();
   132	  ownerQueue.length = 0;
   133	  ownerCalls.length = 0;
   134	  readQueue.length = 0;
   135	  readCalls.length = 0;
   136	  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
   137	  mockRequireRole.mockResolvedValue({
   138	    id: 'user-1',
   139	    name: 'Owner',
   140	    email: 'owner@test.com',
   141	    role: 'owner',
   142	    accountId: ACCOUNT_ID,
   143	  });
   144	});
   145	
   146	afterEach(() => {
   147	  delete process.env.NEXT_PUBLIC_APP_URL;
   148	  delete process.env.EDIT_REPLIES_ENABLED;
   149	});
   150	
   151	// ── Tests ────────────────────────────────────────────────────────────────────
   152	
   153	describe('GET /api/dashboard/reviews/[reviewId]/draft-status', () => {
   154	  it('GET draft-status returns 404 without querying draft text for a review owned by another account', async () => {
   155	    seedOwned([]);
   156	
   157	    const GET = await importGET();
   158	    const res = await GET(makeRequest(), routeParams);
   159	
   160	    expect(res.status).toBe(404);
   161	    expect((await res.json()).error).toBe('review_not_found');
   162	    // Tenant proof runs FIRST: a caller can never observe another account's
   163	    // generation status or draft text, not even as a timing difference. It is
   164	    // the ONLY query issued — nothing reached `responses` or `job_outbox`.
   165	    expect(readCalls).toHaveLength(1);
   166	    expect(readCalls[0]!.text).toMatch(/b\.account_id\s*=/i);
   167	    expect(readCalls[0]!.text).toMatch(/archived_at\s+IS\s+NULL/i);
   168	    expect(readCalls.some((call) => /FROM\s+responses/i.test(call.text))).toBe(false);
   169	    expect(readCalls.some((call) => /job_outbox/i.test(call.text))).toBe(false);
   170	  });
   171	
   172	  it('GET draft-status returns generating, ready, failed, and idle from the authoritative review state', async () => {
   173	    const GET = await importGET();
   174	
   175	    // ready — a live non-terminal response, not held.
   176	    seedOwned();
   177	    seedRead([{ id: 'resp-1', status: 'pending_approval', response_text: 'Draft text', held: false }]);
   178	    const ready = await GET(makeRequest(), routeParams);
   179	    expect(ready.status).toBe(200);
   180	    expect(await ready.json()).toEqual({
   181	      status: 'ready',
   182	      response_id: 'resp-1',
   183	      response_text: 'Draft text',
   184	    });
   185	
   186	    // generating — no draft yet, outbox row in flight.
   187	    seedOwned();
   188	    seedRead([], [{ status: 'pending', last_error: null }]);
   189	    const generating = await GET(makeRequest(), routeParams);
   190	    expect((await generating.json()).status).toBe('generating');
   191	    expect(readCalls.some((call) => call.values.includes(QUEUE_NAMES.GENERATE_RESPONSE))).toBe(true);
   192	
   193	    // failed — terminal-but-not-completed outbox row surfaces last_error.
   194	    seedOwned();
   195	    seedRead([], [{ status: 'failed', last_error: 'llm_terminal' }]);
   196	    const failed = await GET(makeRequest(), routeParams);
   197	    expect(await failed.json()).toEqual({ status: 'failed', error: 'llm_terminal' });
   198	
   199	    // idle — nothing in flight and no draft. The poller must stop.
   200	    seedOwned();
   201	    seedRead([], []);
   202	    const idle = await GET(makeRequest(), routeParams);
   203	    expect((await idle.json()).status).toBe('idle');
   204	  });
   205	
   206	  it('GET draft-status resumes a draft in another active location owned by the same account regardless of current-location cookie', async () => {
   207	    // The INTENDED authorization model (F4): same-account sibling-location
   208	    // access is correct, not a leak — only cross-account is a leak. The Reviews
   209	    // list row carries the reviewId, so a refresh resumes the poll even when the
   210	    // rw_location_scope cookie points at a different location.
   211	    seedOwned([{ business_id: ALT_LOCATION_ID }]);
   212	    seedRead([{ id: 'resp-alt', status: 'pending_approval', response_text: 'Alt draft', held: false }]);
   213	
   214	    const GET = await importGET();
   215	    const res = await GET(makeRequest(LOCATION_ID), routeParams);
   216	
   217	    expect(res.status).toBe(200);
   218	    const body = await res.json();
   219	    expect(body.status).toBe('ready');
   220	    expect(body.response_id).toBe('resp-alt');
   221	    // Account-scoped, never cookie-scoped.
   222	    expect(mockGetRequestScope).not.toHaveBeenCalled();
   223	    expect(readCalls.some((call) => call.values.includes(ALT_LOCATION_ID))).toBe(true);
   224	  });
   225	
   226	  it('GET draft-status never returns response_text or ready for a moderation-held response', async () => {
   227	    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
   228	    // pending_approval with an OPEN flagged_responses row. Returning it as
   229	    // `ready` would hand the owner held text plus an `Approve & post` button —
   230	    // the exact release path src/lib/moderation/held-draft.ts exists to block.
   231	    // The `held` flag is SELECTed, not filtered (D6/D9): filtering would make
   232	    // this route report `idle` for "no draft" and "held draft" alike.
   233	    seedOwned();
   234	    seedRead([{ id: 'resp-held', status: 'pending_approval', response_text: 'Held text', held: true }]);
   235	
   236	    const GET = await importGET();
   237	    const res = await GET(makeRequest(), routeParams);
   238	
   239	    expect(res.status).toBe(200);
   240	    const body = await res.json();
   241	    expect(body.status).toBe('idle');
   242	    expect(body.status).not.toBe('ready');
   243	    expect(body).not.toHaveProperty('response_text');
   244	    expect(JSON.stringify(body)).not.toContain('Held text');
   245	    // The hold must be read from flagged_responses, not inferred. Read call 0
   246	    // is the tenant proof; call 1 is the draft lookup that carries the predicate.
   247	    expect(readCalls[1]!.text).toContain('flagged_responses');
   248	  });
   249	});
     1	import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
     2	import { NextRequest } from 'next/server';
     3	
     4	// ── Hoisted shared state ────────────────────────────────────────────
     5	
     6	const {
     7	  mockRequireRole,
     8	  mockGetRequestScope,
     9	  accountQueue,
    10	  topLevelQueue,
    11	  sqlProxy,
    12	  sqlReadProxy,
    13	} = vi.hoisted(() => {
    14	  const mockRequireRole = vi.fn();
    15	  const mockGetRequestScope = vi.fn();
    16	
    17	  const accountQueue: unknown[][] = [];
    18	  const topLevelQueue: unknown[][] = [];
    19	
    20	  // sql (write pool): the resolveOwnerScope auth preamble stays on it — the
    21	  // subscription-gate SELECT it fires internally (plan #477 Task 1 wiring
    22	  // decision: shared auth helper is never threaded onto sqlRead).
    23	  const sqlMock = vi.fn(async (strings?: TemplateStringsArray) => {
    24	    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
    25	    if (text.includes('subscription_status')) {
    26	      const nextAccount = accountQueue.shift();
    27	      if (nextAccount) return nextAccount;
    28	      return [{ subscription_status: 'active' }];
    29	    }
    30	    return [];
    31	  });
    32	  const sqlProxy = new Proxy(sqlMock, {
    33	    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
    34	  });
    35	
    36	  // sqlRead (read bulkhead): the route-body reads (job_outbox lookup + the
    37	  // completed-job response lookup) moved off write `sql` onto it (#477 Task 1).
    38	  const sqlReadMock = vi.fn(async () => topLevelQueue.shift() ?? []);
    39	  const sqlReadProxy = new Proxy(sqlReadMock, {
    40	    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
    41	  });
    42	
    43	  return {
    44	    mockRequireRole,
    45	    mockGetRequestScope,
    46	    accountQueue,
    47	    topLevelQueue,
    48	    sqlProxy,
    49	    sqlReadProxy,
    50	  };
    51	});
    52	
    53	// ── Mocks ───────────────────────────────────────────────────────────
    54	
    55	vi.mock('@/lib/db/auth', () => {
    56	  class AuthError extends Error {
    57	    constructor(message: string, public readonly statusCode: number) {
    58	      super(message);
    59	      this.name = 'AuthError';
    60	    }
    61	  }
    62	  return {
    63	    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    64	    AuthError,
    65	  };
    66	});
    67	
    68	vi.mock('@/lib/db/server', () => ({
    69	  sql: sqlProxy,
    70	  sqlRead: sqlReadProxy,
    71	  jsonb: (v: unknown) => v,
    72	}));
    73	
    74	vi.mock('@/lib/auth/get-request-scope', () => ({
    75	  getRequestScope: (...args: unknown[]) => mockGetRequestScope(...args),
    76	}));
    77	
    78	// ── Helpers ─────────────────────────────────────────────────────────
    79	
    80	const ACCOUNT_ID = '01234567-0000-7000-8000-000000000000';
    81	const LOCATION_ID = '01234567-0000-7000-8000-000000000001';
    82	// A second location on the same account — used for non-primary scoping tests.
    83	const ALT_LOCATION_ID = '01234567-0000-7000-8000-000000000002';
    84	const OTHER_LOCATION_ID = '01234567-0000-7000-8000-000000000099';
    85	const REVIEW_ID = '01234567-0000-7000-8000-0000000000aa';
    86	const RESPONSE_ID = '01234567-0000-7000-8000-0000000000bb';
    87	const OUTBOX_ID = '01234567-0000-7000-8000-0000000000cc';
    88	const APP_URL = 'http://localhost:3000';
    89	
    90	function ownerUser(overrides?: Partial<{ accountId: string | null }>) {
    91	  return {
    92	    id: 'user-1',
    93	    name: 'Test Owner',
    94	    email: 'owner@test.com',
    95	    role: 'owner',
    96	    accountId: overrides && 'accountId' in overrides ? overrides.accountId : ACCOUNT_ID,
    97	  };
    98	}
    99	
   100	function makeRequest(opts?: {
   101	  outboxId?: string | null;
   102	  locationScopeCookie?: string;
   103	}): NextRequest {
   104	  const params = new URLSearchParams();
   105	  if (opts?.outboxId !== undefined && opts.outboxId !== null) {
   106	    params.set('outbox_id', opts.outboxId);
   107	  }
   108	  const qs = params.toString();
   109	  const url = `${APP_URL}/api/dashboard/past-replies/draft-status${qs ? `?${qs}` : ''}`;
   110	  const headers: Record<string, string> = {};
   111	  if (opts?.locationScopeCookie) {
   112	    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
   113	  }
   114	  return new NextRequest(url, { method: 'GET', headers });
   115	}
   116	
   117	function seedTopLevel(...rowsets: unknown[][]) {
   118	  topLevelQueue.push(...rowsets);
   119	}
   120	
   121	function seedAccountRows(rows: unknown[]) {
   122	  accountQueue.push(rows);
   123	}
   124	
   125	beforeEach(() => {
   126	  vi.clearAllMocks();
   127	  accountQueue.length = 0;
   128	  topLevelQueue.length = 0;
   129	  process.env.EDIT_REPLIES_ENABLED = 'true';
   130	  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
   131	  // Default: requireRole succeeds; getRequestScope resolves to primary location.
   132	  mockRequireRole.mockResolvedValue(ownerUser());
   133	  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
   134	});
   135	
   136	afterEach(() => {
   137	  delete process.env.EDIT_REPLIES_ENABLED;
   138	});
   139	
   140	async function importGET() {
   141	  const mod = await import('../draft-status/route');
   142	  return mod.GET as (req: NextRequest) => Promise<Response>;
   143	}
   144	
   145	// ── Tests ───────────────────────────────────────────────────────────
   146	
   147	describe('GET /api/dashboard/past-replies/draft-status', () => {
   148	  it('returns 503 feature_disabled when flag is off', async () => {
   149	    process.env.EDIT_REPLIES_ENABLED = 'false';
   150	    const GET = await importGET();
   151	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   152	    expect(res.status).toBe(503);
   153	    expect(await res.json()).toEqual({ error: 'feature_disabled' });
   154	  });
   155	
   156	  it('returns 401 when no owner session', async () => {
   157	    const { AuthError } = await import('@/lib/db/auth');
   158	    mockRequireRole.mockRejectedValue(new AuthError('Unauthorized', 401));
   159	    const GET = await importGET();
   160	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   161	    expect(res.status).toBe(401);
   162	  });
   163	
   164	  it('returns 403 no_business when accountId is missing', async () => {
   165	    mockRequireRole.mockResolvedValue(ownerUser({ accountId: null }));
   166	    const GET = await importGET();
   167	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   168	    expect(res.status).toBe(403);
   169	    expect(await res.json()).toMatchObject({ error: 'no_business' });
   170	  });
   171	
   172	  it('returns 400 missing_outbox_id when query param is absent', async () => {
   173	    const GET = await importGET();
   174	    const res = await GET(makeRequest());
   175	    expect(res.status).toBe(400);
   176	    expect(await res.json()).toEqual({ error: 'missing_outbox_id' });
   177	  });
   178	
   179	  it('returns 404 outbox_not_found when outbox row is missing', async () => {
   180	    seedTopLevel([]);
   181	    const GET = await importGET();
   182	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   183	    expect(res.status).toBe(404);
   184	    expect(await res.json()).toEqual({ error: 'outbox_not_found' });
   185	  });
   186	
   187	  it('returns 403 forbidden when payload.business_id mismatches resolved locationId (TENANT LEAK GUARD)', async () => {
   188	    // Outbox payload belongs to a DIFFERENT location — must NOT leak status.
   189	    seedTopLevel([
   190	      {
   191	        status: 'completed',
   192	        payload: { business_id: OTHER_LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   193	        last_error: null,
   194	        aggregate_id: REVIEW_ID,
   195	      },
   196	    ]);
   197	    const GET = await importGET();
   198	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   199	    expect(res.status).toBe(403);
   200	    expect(await res.json()).toEqual({ error: 'forbidden' });
   201	  });
   202	
   203	  it("returns { status: 'generating' } for pending status", async () => {
   204	    seedTopLevel([
   205	      {
   206	        status: 'pending',
   207	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   208	        last_error: null,
   209	        aggregate_id: REVIEW_ID,
   210	      },
   211	    ]);
   212	    const GET = await importGET();
   213	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   214	    expect(res.status).toBe(200);
   215	    expect(await res.json()).toEqual({ status: 'generating' });
   216	  });
   217	
   218	  it('allows read-only past_due accounts to poll existing draft status', async () => {
   219	    seedAccountRows([{
   220	      subscription_status: 'past_due',
   221	      past_due_at: new Date(Date.now() - 8 * 86_400_000),
   222	      flags: {},
   223	    }]);
   224	    seedTopLevel([
   225	      {
   226	        status: 'pending',
   227	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   228	        last_error: null,
   229	        aggregate_id: REVIEW_ID,
   230	      },
   231	    ]);
   232	
   233	    const GET = await importGET();
   234	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   235	
   236	    expect(res.status).toBe(200);
   237	    expect(await res.json()).toEqual({ status: 'generating' });
   238	  });
   239	
   240	  it("returns { status: 'generating' } for dispatching status", async () => {
   241	    seedTopLevel([
   242	      {
   243	        status: 'dispatching',
   244	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   245	        last_error: null,
   246	        aggregate_id: REVIEW_ID,
   247	      },
   248	    ]);
   249	    const GET = await importGET();
   250	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   251	    expect(res.status).toBe(200);
   252	    expect(await res.json()).toEqual({ status: 'generating' });
   253	  });
   254	
   255	  it("returns { status: 'generating' } for dispatched status", async () => {
   256	    seedTopLevel([
   257	      {
   258	        status: 'dispatched',
   259	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   260	        last_error: null,
   261	        aggregate_id: REVIEW_ID,
   262	      },
   263	    ]);
   264	    const GET = await importGET();
   265	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   266	    expect(res.status).toBe(200);
   267	    expect(await res.json()).toEqual({ status: 'generating' });
   268	  });
   269	
   270	  it("returns { status: 'failed', error } for failed outbox", async () => {
   271	    seedTopLevel([
   272	      {
   273	        status: 'failed',
   274	        payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 1 },
   275	        last_error: 'LLM call exceeded budget',
   276	        aggregate_id: REVIEW_ID,
   277	      },
   278	    ]);
   279	    const GET = await importGET();
   280	    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
   281	    expect(res.status).toBe(200);
   282	    expect(await res.json()).toEqual({ status: 'failed', error: 'LLM call exceeded budget' });
   283	  });
   284	
   285	  it('returns { response_id, status, response_text } for completed outbox with matching response row', async () => {
   286	    seedTopLevel(
   287	      // 1. outbox lookup
   288	      [
   289	        {
   290	          status: 'completed',
   291	          payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
   292	          last_error: null,
   293	          aggregate_id: REVIEW_ID,
   294	        },
   295	      ],
   296	      // 2. response lookup
   297	      [
   298	        {
   299	          id: RESPONSE_ID,
   300	          status: 'pending_approval',
   275	# Synchronous post-check, appended after the parallel rows.
   276	run_sync() {
   277	  local name="$1"; shift
   278	  if "$@" > ".feature/logs/${name}.log" 2>&1; then
   279	    NAMES+=("$name"); RESULTS+=("PASS")
   280	  else
   281	    NAMES+=("$name"); RESULTS+=("FAIL")
   282	  fi
   283	}
   284	
   285	# --- promised-tests: tests_to_add entries are verbatim test titles ---
   286	# grep, not rg: rg lives only in the interactive shell here — child bash
   287	# processes don't have it, and a swallowed `command not found` reads as
   288	# "every title missing".
   289	#
   290	# Search `scripts` too, not just src/worker: the CI audits under scripts/ci/
   291	# carry their own suites (scripts/ci/__tests__/*.test.ts), and an intake may
   292	# legitimately promise titles there. Omitting it reported every such title as
   293	# missing while the tests existed and passed — a false RED that is
   294	# indistinguishable from a genuinely unwritten test (#611 feature, 2026-07-28).
   295	#
   296	# Matching is fixed-string against the file, so a promised title must appear
   297	# UNESCAPED in source: write a title containing an apostrophe with double
   298	# quotes, or the `\'` will not match the locked text.
   299	MISSING_TITLES=""
   300	while IFS= read -r TITLE; do
   301	  [ -n "$TITLE" ] || continue
   302	  grep -rqF "$TITLE" --include='*.test.ts' --include='*.test.tsx' src worker scripts 2>/dev/null && continue
   303	  MISSING_TITLES="${MISSING_TITLES}  - ${TITLE}
   304	"
   305	done < <(jq -r '.tests_to_add[]?' "$INTAKE" 2>/dev/null)
   306	if [ "$DOCS_ONLY" = false ] && jq -e '.tests_to_add | length > 0' "$INTAKE" >/dev/null 2>&1; then
   307	  NAMES+=("promised-tests")
   308	  if [ -n "$MISSING_TITLES" ]; then RESULTS+=("FAIL"); else RESULTS+=("PASS"); fi
   309	fi
   310	
   311	# --- reclassify: actual diff vs the intake's per-bucket estimates ---
   312	# Buckets: test (__tests__/, *.test.ts(x), e2e/) vs production (the rest).
   313	# Workflow artifacts (docs/superpowers/plans/**, docs/reviews/**) are excluded
   314	# entirely — the plan document is not scope creep against itself.
   315	RECLASSIFY_MSG=""
   316	if [ "$DOCS_ONLY" = false ] && [ -n "$BASE" ]; then
   317	  PROD_ACTUAL=0; TEST_ACTUAL=0
   318	  while IFS=$'\t' read -r ADDS DELS PATHNAME; do
   319	    [ -n "$PATHNAME" ] || continue
   320	    case "$ADDS" in ''|*[!0-9]*) continue ;; esac
   321	    case "$DELS" in ''|*[!0-9]*) continue ;; esac
   322	    case "$PATHNAME" in
   323	      docs/superpowers/plans/*|docs/reviews/*) continue ;;
   324	    esac
   325	    if echo "$PATHNAME" | grep -qE '(^|/)__tests__/|\.test\.tsx?$|^e2e/'; then
   326	      TEST_ACTUAL=$((TEST_ACTUAL + ADDS + DELS))
   327	    else
   328	      PROD_ACTUAL=$((PROD_ACTUAL + ADDS + DELS))
   329	    fi
   330	  done < <(git diff --numstat "$BASE" 2>/dev/null)
   331	
   332	  EST_PROD=$(jq -r '.estimated_prod_lines // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
   333	  EST_TEST=$(jq -r '.estimated_test_lines // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
   334	  if [ -n "$EST_PROD" ] || [ -n "$EST_TEST" ]; then
   335	    OVER=""
   336	    if [ -n "$EST_PROD" ] && [ "$EST_PROD" -gt 0 ] && [ "$PROD_ACTUAL" -gt $((EST_PROD * 2)) ]; then
   337	      OVER="production ${PROD_ACTUAL} > 2x estimated_prod_lines (${EST_PROD})"
   338	    fi
   339	    if [ -n "$EST_TEST" ] && [ "$EST_TEST" -gt 0 ] && [ "$TEST_ACTUAL" -gt $((EST_TEST * 2)) ]; then
   340	      [ -n "$OVER" ] && OVER="${OVER}; "
   341	      OVER="${OVER}test ${TEST_ACTUAL} > 2x estimated_test_lines (${EST_TEST})"
   342	    fi
   343	    if [ -n "$OVER" ]; then
   344	      NAMES+=("reclassify"); RESULTS+=("WARN")
   345	      RECLASSIFY_MSG="${OVER} changed lines (workflow artifacts excluded) — re-run step 0 (re-classification trigger)."
   346	    fi
   347	  else
   348	    # Legacy intakes: single estimated_diff_size vs the combined total.
   349	    EST=$(jq -r '.estimated_diff_size // empty' "$INTAKE" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
   350	    if [ -n "$EST" ] && [ "$EST" -gt 0 ] && [ $((PROD_ACTUAL + TEST_ACTUAL)) -gt $((EST * 2)) ]; then
   351	      NAMES+=("reclassify"); RESULTS+=("WARN")
   352	      RECLASSIFY_MSG="actual diff $((PROD_ACTUAL + TEST_ACTUAL)) changed lines (workflow artifacts excluded) > 2x estimated_diff_size (${EST}) — re-run step 0 (re-classification trigger)."
   353	    fi
   354	  fi
   355	fi
   356	
   357	# --- diff-coverage (review mode only; consumes the test row's coverage) ---
   358	# The test row above ran with live-DB suites asleep, so changed lines that only
   359	# a live-DB suite executes are absent from its report. Fold each integration
   360	# row's coverage in first, or DB-orchestration modules read ~0% on changed lines
   361	# despite their suites passing (#563 item 2).
   362	if [ "$REVIEW_MODE" = true ] && [ "$DOCS_ONLY" = false ]; then
   363	  if [ -d "$INTEGRATION_COV_DIR" ]; then
   364	    run_sync merge-coverage \
   365	      pnpm tsx scripts/merge-coverage.ts coverage/coverage-final.json "$INTEGRATION_COV_DIR"
   366	  fi
   367	  run_sync diff-coverage pnpm feature:diff-coverage
   368	fi
   369	
   370	if [ "$INTEGRATION_SKIPPED" -gt 0 ]; then
   371	  NAMES+=("integration-suites")
   372	  RESULTS+=("SKIP")
   373	fi
   374	
   375	PASSED=true
   376	CHECKS_JSON="["
   377	for i in "${!NAMES[@]}"; do
   378	  [ "${RESULTS[$i]}" = "FAIL" ] && PASSED=false
   379	  CHECKS_JSON+="{\"name\":\"${NAMES[$i]}\",\"result\":\"${RESULTS[$i]}\"},"
   380	done
   381	CHECKS_JSON="${CHECKS_JSON%,}]"
   382	
   383	GATE_MODE="full"
   384	[ "$DOCS_ONLY" = true ] && GATE_MODE="docs_only"
   385	printf '{"passed":%s,"mode":"%s","timestamp":%s,"checks":%s}\n' \
   386	  "$PASSED" "$GATE_MODE" "$(date +%s)" "$CHECKS_JSON" > .feature/gate-status.json
   387	
   388	echo "VERIFY GATE:"
   389	if [ "$DOCS_ONLY" = true ]; then
   390	  echo "  (docs-only mode: every changed path is docs/, .claude/, or *.md —"
   391	  echo "   test/build/promised-tests/reclassify/diff-coverage rows skipped)"
   392	fi
   393	for i in "${!NAMES[@]}"; do
   394	  printf '  %-24s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"
   395	done
   396	
   397	if [ "$INTEGRATION_SKIPPED" -gt 0 ]; then
   398	  echo "WARNING: $INTEGRATION_SKIPPED changed integration suite(s) NOT run (TEST_DATABASE_POOL_URL unset)."
   399	  echo "They self-skip locally and can go red in CI — set the var and re-run before review:"
   400	  printf '%s\n' "$CHANGED_INTEGRATION" | sed 's/^/  - /'
   401	fi
   402	if [ "$DOCS_ONLY" = false ] && [ -n "$MISSING_TITLES" ]; then
   403	  echo "PROMISED TESTS MISSING (tests_to_add titles not found verbatim in any test file):"
   404	  printf '%s' "$MISSING_TITLES"
   405	fi
   406	if [ -n "$RECLASSIFY_MSG" ]; then
   407	  echo "RECLASSIFY: $RECLASSIFY_MSG"
   408	fi
   409	
   410	if [ "$PASSED" = "true" ]; then
   411	  # Record the green gate in the machine-readable state (lastGreenGateSha
   412	  # snapshot) when this is an armed feature run.
   413	  if [ -f .feature/intake.json ] && [ -f scripts/feature-state.sh ]; then
   414	    bash scripts/feature-state.sh set-phase gate_green || true
   415	  fi
   416	  echo "GATE: GREEN"
   417	  exit 0
   418	else
   419	  echo "GATE: RED — tails in .feature/logs/<name>.log"
   420	  exit 1
   421	fi

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg -n -U \"(?:NOT )?EXISTS \\(\\n\\s*SELECT 1(?:\\n\\s*)?(?:FROM )?flagged_responses|LEFT JOIN flagged_responses\" src/lib/past-replies/load-replies.ts 'src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts' src/app/api/dashboard/past-replies/draft-status/route.ts src/lib/dashboard/service.ts src/lib/dashboard/aggregate-service.ts src/lib/dashboard/pending-count.ts src/lib/agents/read.ts; rg -n \"ALLOWLIST_BASELINE|file: \\\"(src/lib/past-replies/load-replies.ts|src/app/api/dashboard/past-replies/draft-status/route.ts|src/lib/dashboard/service.ts|src/lib/dashboard/aggregate-service.ts)\\\"|table: \\\"(responses|review_escalations)\\\"\" scripts/ci/tenant-scope-allowlist.ts; sed -n '300,345p' scripts/ci/tenant-scope-allowlist.ts | nl -ba -v300; sed -n '1260,1310p' scripts/ci/tenant-scope-allowlist.ts | nl -ba -v1260; sed -n '1485,1555p' scripts/ci/tenant-scope-allowlist.ts | nl -ba -v1485; rg -n \"flagged_responses\" scripts/ci/tenant-tables.ts || true; nl -ba scripts/ci/tenant-tables.ts | sed -n '1,220p'; rg -n \"status.*CHECK|approved_for_owner_review|dismissed_false_positive|requires_regeneration|WHERE status = 'open'\" supabase/migrations/051_flagged_responses.sql" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
src/lib/past-replies/load-replies.ts:239:          EXISTS (
src/lib/past-replies/load-replies.ts:240:            SELECT 1
src/lib/past-replies/load-replies.ts:241:            FROM flagged_responses f
src/lib/agents/read.ts:325:      LEFT JOIN flagged_responses fr
70:export const ALLOWLIST_BASELINE = 409;
244:    table: "responses",
327:    file: "src/app/api/dashboard/past-replies/draft-status/route.ts",
328:    table: "responses",
554:    file: "src/lib/dashboard/aggregate-service.ts",
561:    file: "src/lib/dashboard/service.ts",
568:    file: "src/lib/dashboard/service.ts",
580:    file: "src/lib/dashboard/service.ts",
581:    table: "responses",
587:    file: "src/lib/dashboard/service.ts",
630:    table: "responses",
644:    table: "responses",
735:    table: "responses",
749:    table: "responses",
903:    table: "responses",
931:    table: "responses",
952:    table: "responses",
973:    table: "responses",
1029:    table: "responses",
1043:    table: "responses",
1071:    table: "responses",
1099:    table: "responses",
1127:    table: "responses",
1141:    table: "responses",
1169:    table: "responses",
1285:    file: "src/lib/past-replies/load-replies.ts",
1286:    table: "responses",
1292:    file: "src/lib/past-replies/load-replies.ts",
1293:    table: "responses",
1299:    file: "src/lib/past-replies/load-replies.ts",
1300:    table: "responses",
1321:    table: "responses",
1475:    table: "responses",
1489:    table: "responses",
1502:    file: "src/lib/dashboard/service.ts",
1503:    table: "responses",
1509:    file: "src/lib/dashboard/service.ts",
1510:    table: "responses",
1516:    file: "src/lib/dashboard/service.ts",
1517:    table: "review_escalations",
1530:    file: "src/lib/dashboard/aggregate-service.ts",
1531:    table: "responses",
1537:    file: "src/lib/dashboard/aggregate-service.ts",
1538:    table: "review_escalations",
1650:    table: "responses",
1663:    file: "src/lib/dashboard/service.ts",
1678:    table: "responses",
1685:    table: "responses",
1692:    table: "responses",
1699:    table: "responses",
1706:    table: "responses",
1747:    table: "responses",
1768:    table: "responses",
1817:    table: "responses",
1838:    table: "responses",
1852:    table: "responses",
1859:    table: "responses",
1866:    table: "responses",
1873:    table: "responses",
1880:    table: "responses",
1957:    table: "responses",
1971:    table: "responses",
1978:    table: "responses",
1985:    table: "responses",
1992:    table: "responses",
2019:    file: "src/lib/dashboard/service.ts",
2041:    table: "responses",
2062:    table: "responses",
2069:    table: "responses",
2146:    table: "responses",
2251:    table: "responses",
2258:    table: "responses",
2276:    table: "responses",
2283:    table: "responses",
2350:    table: "responses",
2651:    table: "responses",
2665:    table: "review_escalations",
2686:    table: "responses",
2735:    table: "responses",
2921:    table: "responses",
2942:    table: "responses",
   300	    table: "accounts",
   301	    sqlSnippet: "SELECT a.id, a.subscription_status, u.email AS owner_email, (SELECT b.onboarded_by FROM businesses b WHERE b.account_id = ${accountId}::uuid AND b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS onboarded_by FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${accountId}::uuid",
   302	    category: 'tenant-root-lookup',
   303	    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
   304	  },
   305	  {
   306	    file: "src/app/api/billing/checkout/route.ts",
   307	    table: "businesses",
   308	    sqlSnippet: "SELECT a.id, a.subscription_status, u.email AS owner_email, (SELECT b.onboarded_by FROM businesses b WHERE b.account_id = ${accountId}::uuid AND b.account_id = a.id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS onboarded_by FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE a.id = ${accountId}::uuid",
   309	    category: 'tenant-root-lookup',
   310	    reason: "onboarded_by subquery is tenant-scoped: b.account_id = a.id where a.id = ${accountId} (the owner-verified tenant root).",
   311	  },
   312	  {
   313	    file: "src/app/api/billing/portal/route.ts",
   314	    table: "accounts",
   315	    sqlSnippet: "SELECT id, subscription_status, stripe_customer_id FROM accounts WHERE id = ${accountId}::uuid",
   316	    category: 'tenant-root-lookup',
   317	    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
   318	  },
   319	  {
   320	    file: "src/lib/accounts/tier-change.ts",
   321	    table: "account_offboardings",
   322	    sqlSnippet: "SELECT a.owner_user_id, a.price_variant, a.stripe_subscription_id, a.subscription_status, a.subscription_tier, a.locations_overage_price_cents, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM accounts a LEFT JOIN LATERAL ( SELECT active.* FROM account_offboardings active WHERE active.account_id = a.id AND active.terminal_at IS NULL ORDER BY active.created_at DESC LIMIT 1 ) ao ON TRUE WHERE a.id = ${accountId}::uuid",
   323	    category: 'tenant-root-lookup',
   324	    reason: "The tier-change transaction first locks the owner-resolved account id, then projects only that account's latest active offboarding row through a correlated lateral join; the scanner intentionally strips the correlated subquery predicate.",
   325	  },
   326	  {
   327	    file: "src/app/api/dashboard/past-replies/draft-status/route.ts",
   328	    table: "responses",
   329	    sqlSnippet: "SELECT id, status, response_text, business_id, EXISTS ( SELECT 1 FROM flagged_responses f WHERE f.response_id = responses.id AND f.status = 'open' ) AS held FROM responses WHERE review_id = ${outbox.aggregate_id} AND status IN ('pending_approval', 'approved', 'edited') ORDER BY version DESC LIMIT 1",
   330	    category: 'tenant-root-lookup',
   331	    reason: "Draft-status route verifies the owner-resolved location against the outbox payload before reading this response row, then rechecks response.business_id.",
   332	  },
   333	  {
   334	    file: "src/app/api/dashboard/route.ts",
   335	    table: "accounts",
   336	    sqlSnippet: "SELECT cancelled_at, subscription_activated_at FROM accounts WHERE id = ${accountId}::uuid",
   337	    category: 'tenant-root-lookup',
   338	    reason: "Authenticated flow uses account id as the tenant-root lookup key for this statement.",
   339	  },
   340	  {
   341	    file: "src/lib/payments/plan-activation.ts",
   342	    table: "businesses",
   343	    sqlSnippet: "SELECT account_id, onboarded_by FROM businesses WHERE id = ${businessId}::uuid",
   344	    category: 'tenant-root-lookup',
   345	    reason: "Authenticated flow uses business/location id as the lookup key after owner scope has been established.",
  1260	    table: "businesses",
  1261	    sqlSnippet: RANKING_TRACKING_CANDIDATES_SQL,
  1262	    category: 'background-global-scan',
  1263	    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  1264	  },
  1265	  {
  1266	    file: "worker/background/schedulers/WeeklySummaryScheduler.ts",
  1267	    table: "accounts",
  1268	    sqlSnippet: WEEKLY_SUMMARY_CANDIDATES_SQL,
  1269	    category: 'background-global-scan',
  1270	    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  1271	  },
  1272	  {
  1273	    file: "worker/background/schedulers/WeeklySummaryScheduler.ts",
  1274	    table: "businesses",
  1275	    sqlSnippet: WEEKLY_SUMMARY_CANDIDATES_SQL,
  1276	    category: 'background-global-scan',
  1277	    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
  1278	  },
  1279	  // #678 — the Reviews list. These three replace the four pre-#678 entries for
  1280	  // this file (two activation-split COUNTs, the posted-only AVG, the posted-JOIN
  1281	  // main query) plus the two for the orphan query F3 deleted. The new AVG needs
  1282	  // NO entry: it no longer joins `responses`, so `r.business_id = ${locationId}`
  1283	  // scopes it outright — a net shrink in exempted surface, 414 -> 412.
  1284	  {
  1285	    file: "src/lib/past-replies/load-replies.ts",
  1286	    table: "responses",
  1287	    sqlSnippet: "SELECT r.id AS review_id, r.review_text, r.review_date, r.review_content_hash, r.external_reply_ingested_at, r.star_rating, r.reviewer_name, resp.id AS response_id, resp.approved_text, resp.approval_method, resp.posted_at, resp.version, fail_sidecar.id AS failed_response_id, fail_sidecar.posting_error AS failed_posting_error, draft.id AS draft_response_id, COALESCE(draft.held, false) AS draft_held, (pending_gen.exists IS NOT NULL) AS generation_in_flight, (orphan_sidecar.id IS NOT NULL AND resp.id IS NULL) AS is_orphan, orphan_sidecar.id AS orphan_failed_response_id, orphan_sidecar.posting_error AS orphan_posting_error, orphan_superseded.approved_text AS superseded_text FROM reviews r LEFT JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted' LEFT JOIN LATERAL ( SELECT id, posting_error FROM responses WHERE review_id = r.id AND status = 'failed' AND posting_error LIKE ${deletePfx} ORDER BY created_at DESC LIMIT 1 ) fail_sidecar ON true LEFT JOIN LATERAL ( SELECT resp2.id, EXISTS ( SELECT 1 FROM flagged_responses f WHERE f.response_id = resp2.id AND f.status = 'open' ) AS held FROM responses resp2 WHERE resp2.review_id = r.id AND resp2.status = ANY(${[...NON_TERMINAL_STATUSES] as string[]}::text[]) ORDER BY resp2.version DESC LIMIT 1 ) draft ON true LEFT JOIN LATERAL ( SELECT 1 AS exists FROM job_outbox WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE} AND aggregate_id = r.id AND status IN ('pending', 'dispatching', 'dispatched') LIMIT 1 ) pending_gen ON true LEFT JOIN LATERAL ( SELECT id, posting_error FROM responses WHERE review_id = r.id AND status = 'failed' AND posting_error LIKE ${postAfterPfx} ORDER BY created_at DESC LIMIT 1 ) orphan_sidecar ON true LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS approved_text FROM responses WHERE review_id = r.id AND status = 'superseded' ORDER BY created_at DESC LIMIT 1 ) orphan_superseded ON true WHERE r.business_id = ${locationId} ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}",
  1288	    category: 'tenant-root-lookup',
  1289	    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  1290	  },
  1291	  {
  1292	    file: "src/lib/past-replies/load-replies.ts",
  1293	    table: "responses",
  1294	    sqlSnippet: "SELECT COUNT(*)::int AS count FROM reviews r WHERE r.business_id = ${locationId} AND NOT EXISTS ( SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted' )",
  1295	    category: 'tenant-root-lookup',
  1296	    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  1297	  },
  1298	  {
  1299	    file: "src/lib/past-replies/load-replies.ts",
  1300	    table: "responses",
  1301	    sqlSnippet: "SELECT COUNT(*)::int AS count FROM reviews r WHERE r.business_id = ${locationId} AND EXISTS ( SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted' )",
  1302	    category: 'tenant-root-lookup',
  1303	    reason: "Authenticated Reviews list page uses the owner-selected locationId resolved for the current account before joining or existence-testing response rows.",
  1304	  },
  1305	  {
  1306	    file: "src/app/api/approve/[token]/route.ts",
  1307	    table: "businesses",
  1308	    sqlSnippet: "SELECT resp.response_text, resp.version, resp.status, resp.approval_method, resp.auto_post_scheduled_at, r.reviewer_name, r.star_rating, r.review_text, r.review_date, b.name AS business_name, b.display_label, b.account_id, (b.archived_at IS NOT NULL) AS is_archived FROM responses resp JOIN reviews r ON resp.review_id = r.id JOIN businesses b ON resp.business_id = b.id WHERE resp.id = ${link.response_id}",
  1309	    category: 'pre-auth-token',
  1310	    reason: "Opaque approval token lookup resolves tenant rows before business scope is known.",
  1485	    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  1486	  },
  1487	  {
  1488	    file: "src/lib/approval/http-routes.ts",
  1489	    table: "responses",
  1490	    sqlSnippet: "SELECT r.id, r.business_id, r.status FROM responses r JOIN reviews rv ON rv.id = r.review_id JOIN businesses b ON b.id = rv.business_id WHERE rv.id = ${reviewId} AND b.account_id = ${owner.accountId}::uuid AND b.archived_at IS NULL AND r.status NOT IN ('superseded', 'failed') ORDER BY r.version DESC LIMIT 1",
  1491	    category: 'pre-auth-token',
  1492	    reason: "Owner approval route filters the review through owner.accountId and returns only the active response for that scoped review.",
  1493	  },
  1494	  {
  1495	    file: "src/lib/auth/require-owner-access.ts",
  1496	    table: "accounts",
  1497	    sqlSnippet: "SELECT u.role, u.account_id, a.subscription_status FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.auth_id = ${authUser.id} LIMIT 1",
  1498	    category: 'supabase-auth-id',
  1499	    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  1500	  },
  1501	  {
  1502	    file: "src/lib/dashboard/service.ts",
  1503	    table: "responses",
  1504	    sqlSnippet: "SELECT COUNT(DISTINCT r.id)::int AS count FROM reviews r JOIN responses resp ON resp.review_id = r.id WHERE r.business_id = ${businessId} AND r.status <> ${REVIEW_STATUS.DELETED} AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])",
  1505	    category: 'tenant-root-lookup',
  1506	    reason: "Dashboard service receives an owner-scoped accountId or businessId and uses it as the tenant boundary for joined data.",
  1507	  },
  1508	  {
  1509	    file: "src/lib/dashboard/service.ts",
  1510	    table: "responses",
  1511	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity FROM reviews rev LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = ${businessId} AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = ${businessId} AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE rev.business_id = ${businessId} AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 10",
  1512	    category: 'tenant-root-lookup',
  1513	    reason: "Dashboard service receives an owner-scoped accountId or businessId and uses it as the tenant boundary for joined data; the NOT EXISTS clause excludes drafts held by an open moderation flag from owner view.",
  1514	  },
  1515	  {
  1516	    file: "src/lib/dashboard/service.ts",
  1517	    table: "review_escalations",
  1518	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity FROM reviews rev LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = ${businessId} AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = ${businessId} AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE rev.business_id = ${businessId} AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 10",
  1519	    category: 'tenant-root-lookup',
  1520	    reason: "Open-escalation badge read (WS3); review_escalations accessed inside a LEFT JOIN LATERAL scoped by e.business_id = ${businessId} (mirrors the resp lateral). Scanner strips SELECT subqueries before predicate analysis. businessId is IDOR-checked in the dashboard route.",
  1521	  },
  1522	  // Account-wide recent-reviews feed (100-business perf pass, 2026-07-16):
  1523	  // one LIMIT 20 query replaces the aggregate view's fetch-10-per-location
  1524	  // composition. responses/review_escalations are accessed inside LEFT JOIN
  1525	  // LATERAL subqueries correlated on rev.business_id, which the scanner
  1526	  // strips before predicate analysis; the tenant boundary is
  1527	  // b.account_id = ${accountId} with rev.business_id = b.id. accountId is
  1528	  // owner-scoped by requireOwnerWithAccount in the dashboard route.
  1529	  {
  1530	    file: "src/lib/dashboard/aggregate-service.ts",
  1531	    table: "responses",
  1532	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity, b.id AS location_id, b.name AS location_name, b.display_label AS location_display_label FROM reviews rev JOIN businesses b ON b.id = rev.business_id LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = rev.business_id AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = rev.business_id AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE b.account_id = ${accountId}::uuid AND b.archived_at IS NULL AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 20",
  1533	    category: 'tenant-root-lookup',
  1534	    reason: "Aggregate recent-reviews feed; responses accessed via LEFT JOIN LATERAL correlated on rev.business_id inside a scan bounded by b.account_id = ${accountId}. Scanner strips SELECT subqueries before predicate analysis.",
  1535	  },
  1536	  {
  1537	    file: "src/lib/dashboard/aggregate-service.ts",
  1538	    table: "review_escalations",
  1539	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity, b.id AS location_id, b.name AS location_name, b.display_label AS location_display_label FROM reviews rev JOIN businesses b ON b.id = rev.business_id LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = rev.business_id AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = rev.business_id AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE b.account_id = ${accountId}::uuid AND b.archived_at IS NULL AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 20",
  1540	    category: 'tenant-root-lookup',
  1541	    reason: "Aggregate recent-reviews feed; review_escalations accessed via LEFT JOIN LATERAL correlated on rev.business_id inside a scan bounded by b.account_id = ${accountId}. Scanner strips SELECT subqueries before predicate analysis.",
  1542	  },
  1543	  {
  1544	    file: "src/lib/db/auth.ts",
  1545	    table: "businesses",
  1546	    sqlSnippet: "SELECT u.id, u.name, u.email, u.role, u.account_id, (SELECT b.id FROM businesses b WHERE b.account_id = u.account_id AND b.is_primary = TRUE AND b.archived_at IS NULL LIMIT 1) AS primary_location_id FROM users u WHERE u.auth_id = ${authUser.id} LIMIT 1",
  1547	    category: 'supabase-auth-id',
  1548	    reason: "Auth/onboarding flow scopes through Supabase auth_id to users.account_id before joining account or primary-location rows.",
  1549	  },
  1550	  {
  1551	    file: "src/lib/responses/voice-learning.ts",
  1552	    table: "reviews",
  1553	    sqlSnippet: "SELECT resp.original_draft_text, resp.edited_text, r.star_rating FROM responses resp JOIN reviews r ON resp.review_id = r.id WHERE resp.business_id = ${businessId} AND resp.status = 'posted' AND resp.edited_text IS NOT NULL ORDER BY resp.posted_at DESC LIMIT 10",
  1554	    category: 'worker-job-scoped',
  1555	    reason: "Voice-learning query receives a businessId from an owner-scoped request or worker payload before sampling review and response rows.",
     1	export const TENANT_TABLES = [
     2	  'accounts',
     3	  'businesses',
     4	  'channel_enrollments',
     5	  'reviews',
     6	  'responses',
     7	  'approval_links',
     8	  'approval_audit_log',
     9	  'account_audit_log',
    10	  'account_offboardings',
    11	  'account_offboarding_tokens',
    12	  'auto_approval_policies',
    13	  'notification_deliveries',
    14	  'api_costs',
    15	  'weekly_summaries',
    16	  'monthly_impact_emails',
    17	  'onboarding_drip_log',
    18	  'onboarding_demos',
    19	  'satisfaction_responses',
    20	  'api_costs_daily_rollups',
    21	  'review_exceptions',
    22	  'ranking_snapshots',
    23	  'competitor_snapshots',
    24	  'zernio_connections',
    25	  'zernio_finalize_incidents',
    26	  'zernio_backfill_runs',
    27	  // Owner-read-only RLS (migration 086, #541 contacts/visits CSV ingestion) —
    28	  // mirrors competitor_snapshots' RLS shape above.
    29	  'contact_csv_uploads',
    30	  'solicitation_contacts',
    31	  'solicitation_visits',
    32	  // Owner-read-only RLS (migration 088, #543 Solicitation executor).
    33	  // Batch SELECT also requires built_at IS NOT NULL at the policy layer so
    34	  // partial/failed logical fan-out never becomes owner-visible.
    35	  'solicitation_batches',
    36	  'solicitation_asks',
    37	  // Owner-read-only RLS (migration 091, #624 send-mode artifact table) — the
    38	  // owner SELECT policy carries the D6a moderation carve-out. Carries
    39	  // account_id/business_id; the ArchivalPoller body-redaction sweep is
    40	  // deliberately cross-tenant and is exempted in tenant-scope-allowlist.ts.
    41	  'solicitation_outreach',
    42	  // Deny-all RLS (migration 093, #625 consent ledger) — zero policies, the
    43	  // auto_approval_policies posture (invariant #14). Business-scoped via
    44	  // business_id; deliberately carries NO account_id (spec §3.2), so
    45	  // account-level sweeps join through businesses.
    46	  'solicitation_consent',
    47	  // Deny-all RLS (migration 096, #643 Suppression ledger) — zero policies, the
    48	  // auto_approval_policies posture (invariant #14). Not decorative here: a
    49	  // direct client read of a `global` row would expose the account_id
    50	  // provenance the spec forbids surfacing.
    51	  //
    52	  // solicitation_suppressions carries account_id as the Suppression scope, NOT
    53	  // as a denormalization: the row does not hang off a business, so there is
    54	  // nothing for it to drift from. Its `global` arm is deliberately
    55	  // cross-account — a recipient-authored opt-out applies to every tenant — and
    56	  // is exempted in tenant-scope-allowlist.ts.
    57	  //
    58	  // solicitation_unsubscribe_tokens carries account_id as provenance only, and
    59	  // the offboarding purge scrubs it to NULL while keeping the row: an
    60	  // Unsubscribe token must still redeem after the account that minted it is
    61	  // gone.
    62	  'solicitation_suppressions',
    63	  'solicitation_unsubscribe_tokens',
    64	  // Deny-all RLS (migration 098, #645 Correction path audit sink) — zero
    65	  // policies, same posture: a row names a recipient's Normalized handle, so a
    66	  // direct client read would expose that an identified person's opt-out was
    67	  // removed.
    68	  //
    69	  // It carries account_id, created_by_user_id and note copied off the row it
    70	  // records the removal of — the evidence behind the corrected assertion
    71	  // (D-A11). Listed here rather than named around the detector: the honest
    72	  // spelling is what keeps the retention obligation visible. Written only by
    73	  // the admin Correction path and read only by the admin lookup, both behind
    74	  // requireAdminWithAal2 and both exempted in tenant-scope-allowlist.ts.
    75	  'solicitation_suppression_corrections',
    76	  // Deny-all RLS (migration 066, deep-scan §4.1) — listed so ci:rls-audit
    77	  // guards them. These are NOT account/business-scoped: raw webhook payloads,
    78	  // sales-demo snapshots, and legacy Google OAuth secrets. Their SQL touchpoints
    79	  // are exempt via tenant-scope-allowlist.ts (ingress / background / admin /
    80	  // worker-job / pre-auth-token categories), not because they carry a tenant id.
    81	  'inbound_events',
    82	  'prospect_demos',
    83	  'google_connections',
    84	  // Deny-all RLS (migration 071, agent run spine) — listed so ci:rls-audit
    85	  // guards them. Written ONLY by src/lib/agents/run-spine.ts inside pipeline
    86	  // transactions that already carry account/business scope; run-keyed spine
    87	  // queries are exempt via tenant-scope-allowlist.ts (worker-job-scoped), not
    88	  // because they lack a tenant id (agent_runs/agent_outcomes carry account_id).
    89	  'agent_runs',
    90	  'agent_run_steps',
    91	  'agent_outcomes',
    92	  // Deny-all RLS (migration 073, WS3 Guardian escalation) — carries account_id/
    93	  // business_id; written by src/lib/escalations/* inside pipeline transactions
    94	  // that already carry account/business scope; non-owner-scoped statements
    95	  // exempted via tenant-scope-allowlist.ts.
    96	  'review_escalations',
    97	  // Deny-all RLS (migration 076, WS6 Judge verdicts) — carries account_id/
    98	  // business_id and is written only from tenant-scoped JudgeWorker transactions.
    99	  // Cross-tenant sweep anti-joins are exempted explicitly in the allowlist.
   100	  'judge_verdicts',
   101	] as const;
   102	
   103	export type TenantTable = (typeof TENANT_TABLES)[number];
24:                        CHECK (status IN ('open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration')),
44:  WHERE status = 'open';

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg -n \"flagged_responses|fr\\.id IS NULL\" src/lib/past-replies/load-replies.ts 'src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts' src/app/api/dashboard/past-replies/draft-status/route.ts src/lib/dashboard/service.ts src/lib/dashboard/aggregate-service.ts src/lib/dashboard/pending-count.ts src/lib/agents/read.ts; nl -ba src/lib/dashboard/service.ts | sed -n '230,275p'; nl -ba src/lib/dashboard/aggregate-service.ts | sed -n '385,425p'; nl -ba 'src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts' | sed -n '45,90p'; nl -ba src/app/api/dashboard/past-replies/draft-status/route.ts | sed -n '95,140p'; nl -ba supabase/migrations/051_flagged_responses.sql" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
src/lib/agents/read.ts:325:      LEFT JOIN flagged_responses fr
src/lib/agents/read.ts:331:        AND fr.id IS NULL
src/lib/dashboard/pending-count.ts:18:        SELECT 1 FROM flagged_responses fr
src/lib/dashboard/pending-count.ts:27: * predicate (`pending_approval` and no open flagged_responses), grouped by
src/lib/dashboard/pending-count.ts:46:        SELECT 1 FROM flagged_responses fr
src/app/api/dashboard/past-replies/draft-status/route.ts:110:      // `pending_approval` with an OPEN `flagged_responses` row — a
src/app/api/dashboard/past-replies/draft-status/route.ts:125:            SELECT 1 FROM flagged_responses f
src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:58:    // `pending_approval` with an OPEN `flagged_responses` row. Returning it as
src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:73:          SELECT 1 FROM flagged_responses f
src/lib/dashboard/aggregate-service.ts:405:          SELECT 1 FROM flagged_responses fr
src/lib/dashboard/service.ts:254:            SELECT 1 FROM flagged_responses fr
src/lib/past-replies/load-replies.ts:232:      -- held while an open flagged_responses row exists". Its hasOpenFlag is an
src/lib/past-replies/load-replies.ts:241:            FROM flagged_responses f
   230	        rev.reviewer_name,
   231	        rev.star_rating,
   232	        rev.review_text,
   233	        rev.review_date,
   234	        rev.status,
   235	        resp.response_text,
   236	        resp.status AS response_status,
   237	        resp.approval_method,
   238	        resp.auto_post_scheduled_at,
   239	        esc.id AS escalation_id,
   240	        esc.status AS escalation_status,
   241	        esc.triage_severity AS escalation_severity
   242	      FROM reviews rev
   243	      LEFT JOIN LATERAL (
   244	        SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at
   245	        FROM responses
   246	        WHERE review_id = rev.id
   247	          -- Explicit tenant scope: responses belong to the same location as the
   248	          -- review (defense-in-depth alongside the review_id correlation).
   249	          AND business_id = ${businessId}
   250	          AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
   251	          -- Held-for-review drafts (high-severity moderation flag still open)
   252	          -- must never surface to the owner UI; the admin queue owns them.
   253	          AND NOT EXISTS (
   254	            SELECT 1 FROM flagged_responses fr
   255	            WHERE fr.response_id = responses.id AND fr.status = 'open'
   256	          )
   257	        ORDER BY version DESC
   258	        LIMIT 1
   259	      ) resp ON true
   260	      LEFT JOIN LATERAL (
   261	        SELECT id, status, triage_severity
   262	        FROM review_escalations e
   263	        WHERE e.review_id = rev.id
   264	          -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
   265	          AND e.business_id = ${businessId}
   266	          -- Status literal kept deliberately: it matches the
   267	          -- review_escalations_one_open_per_review partial-index predicate
   268	          -- byte-for-byte so the planner can use that index; a bound
   269	          -- parameter could defeat the partial-index proof under a generic
   270	          -- plan.
   271	          AND e.status <> 'resolved'
   272	        LIMIT 1
   273	      ) esc ON true
   274	      WHERE rev.business_id = ${businessId}
   275	        AND rev.status <> ${REVIEW_STATUS.DELETED}
   385	      resp.auto_post_scheduled_at,
   386	      esc.id AS escalation_id,
   387	      esc.status AS escalation_status,
   388	      esc.triage_severity AS escalation_severity,
   389	      b.id AS location_id,
   390	      b.name AS location_name,
   391	      b.display_label AS location_display_label
   392	    FROM reviews rev
   393	    JOIN businesses b ON b.id = rev.business_id
   394	    LEFT JOIN LATERAL (
   395	      SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at
   396	      FROM responses
   397	      WHERE review_id = rev.id
   398	        -- Explicit tenant scope: responses belong to the same location as the
   399	        -- review (defense-in-depth alongside the review_id correlation).
   400	        AND business_id = rev.business_id
   401	        AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
   402	        -- Held-for-review drafts (high-severity moderation flag still open)
   403	        -- must never surface to the owner UI; the admin queue owns them.
   404	        AND NOT EXISTS (
   405	          SELECT 1 FROM flagged_responses fr
   406	          WHERE fr.response_id = responses.id AND fr.status = 'open'
   407	        )
   408	      ORDER BY version DESC
   409	      LIMIT 1
   410	    ) resp ON true
   411	    LEFT JOIN LATERAL (
   412	      SELECT id, status, triage_severity
   413	      FROM review_escalations e
   414	      WHERE e.review_id = rev.id
   415	        -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
   416	        AND e.business_id = rev.business_id
   417	        -- Status literal kept deliberately: it matches the
   418	        -- review_escalations_one_open_per_review partial-index predicate
   419	        -- byte-for-byte so the planner can use that index.
   420	        AND e.status <> 'resolved'
   421	      LIMIT 1
   422	    ) esc ON true
   423	    WHERE b.account_id = ${accountId}::uuid
   424	      AND b.archived_at IS NULL
   425	      AND rev.status <> ${REVIEW_STATUS.DELETED}
    45	    JOIN businesses b ON b.id = rv.business_id
    46	    WHERE rv.id = ${reviewId}::uuid
    47	      AND b.account_id = ${owner.accountId}::uuid
    48	      AND b.archived_at IS NULL
    49	    LIMIT 1
    50	  `;
    51	  if (!ownedRows[0]) {
    52	    return NextResponse.json({ error: 'review_not_found' }, { status: 404, headers: NO_STORE_HEADERS });
    53	  }
    54	  const businessId = ownedRows[0].business_id;
    55	
    56	  try {
    57	    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
    58	    // `pending_approval` with an OPEN `flagged_responses` row. Returning it as
    59	    // `ready` would hand the owner held text plus an `Approve & post` button —
    60	    // the exact release path `src/lib/moderation/held-draft.ts` exists to block.
    61	    // That module is the SEMANTIC OWNER of "is this draft held"; its `hasOpenFlag`
    62	    // is an in-tx, post-FOR-UPDATE release gate, so this read path spells the
    63	    // predicate inline instead (D6).
    64	    // The `held` flag is SELECTed (not filtered) so a held draft is
    65	    // distinguishable from "no draft at all"; filtering would make this route
    66	    // report `idle` for both and the list fall through to `generate` (D9).
    67	    const draftRows = await sqlRead<
    68	      { id: string; status: string; response_text: string | null; held: boolean }[]
    69	    >`
    70	      SELECT
    71	        resp.id, resp.status, resp.response_text,
    72	        EXISTS (
    73	          SELECT 1 FROM flagged_responses f
    74	          WHERE f.response_id = resp.id AND f.status = 'open'
    75	        ) AS held
    76	      FROM responses resp
    77	      WHERE resp.review_id = ${reviewId}::uuid
    78	        AND resp.business_id = ${businessId}::uuid
    79	        AND resp.status = ANY(${statusArraySql(sql, NON_TERMINAL_STATUSES)})
    80	      ORDER BY resp.version DESC
    81	      LIMIT 1
    82	    `;
    83	    if (draftRows[0]?.held) {
    84	      // Never `ready`, never `response_text`. `idle` stops the poller; the list
    85	      // row re-renders as `held` from its own query. Admin re-notification at
    86	      // /admin/flagged is the owner's only path back.
    87	      return NextResponse.json({ status: 'idle' }, { status: 200, headers: NO_STORE_HEADERS });
    88	    }
    89	    if (draftRows[0]) {
    90	      return NextResponse.json(
    95	      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    96	    }
    97	
    98	    if (
    99	      outbox.status === 'pending' ||
   100	      outbox.status === 'dispatching' ||
   101	      outbox.status === 'dispatched'
   102	    ) {
   103	      return NextResponse.json({ status: 'generating' }, { status: 200 });
   104	    }
   105	
   106	    if (outbox.status === 'completed') {
   107	      // Worker INSERTed the response row. aggregate_id is the review_id.
   108	      //
   109	      // Invariant #4: a high-severity moderation flag leaves the draft at
   110	      // `pending_approval` with an OPEN `flagged_responses` row — a
   111	      // moderation-held draft "surfaces neither its text nor any button".
   112	      // `src/lib/moderation/held-draft.ts` is the SEMANTIC OWNER of "is this
   113	      // draft held"; its `hasOpenFlag` is an in-tx, post-FOR-UPDATE release
   114	      // gate, so this read-only poller spells the predicate inline as a
   115	      // correlated EXISTS instead (D6).
   116	      const responseRows = await sqlRead<{
   117	        id: string;
   118	        status: string;
   119	        response_text: string | null;
   120	        business_id: string;
   121	        held: boolean;
   122	      }[]>`
   123	        SELECT id, status, response_text, business_id,
   124	          EXISTS (
   125	            SELECT 1 FROM flagged_responses f
   126	            WHERE f.response_id = responses.id AND f.status = 'open'
   127	          ) AS held
   128	        FROM responses
   129	        WHERE review_id = ${outbox.aggregate_id}
   130	          AND status IN ('pending_approval', 'approved', 'edited') -- status-audit-ignore: 3-value poll subset (excludes awaiting_owner_connect); no exact group match, not a reusable grouping
   131	        ORDER BY version DESC
   132	        LIMIT 1
   133	      `;
   134	      const response = responseRows[0];
   135	      if (!response) {
   136	        return NextResponse.json({ error: 'response_not_found' }, { status: 404 });
   137	      }
   138	      // Defense in depth: even if the outbox payload passed the tenant check,
   139	      // re-verify the response row also belongs to the caller's current location
   140	      // before returning the draft text.
     1	-- Migration 051: flagged_responses (Wave 3, PR 3a)
     2	--
     3	-- Holds high-confidence unsafe generated drafts that must NOT enter the normal
     4	-- owner approval-notification path until an admin dispositions them (PR 3b adds
     5	-- the admin queue + disposition actions). Preserves the no-auto-posting
     6	-- invariant: a flagged draft stays a `pending_approval` response with no
     7	-- notification and an `open` row here.
     8	--
     9	-- Admin-only via deny-all RLS (enable RLS, no policy) — server reads through the
    10	-- Postgres.js `postgres` role which bypasses RLS, like impersonation_sessions
    11	-- (048) and analytics_events (049). Owners never see this table directly.
    12	
    13	CREATE TABLE IF NOT EXISTS flagged_responses (
    14	  id                  UUID PRIMARY KEY,
    15	  response_id         UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
    16	  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    17	  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    18	  review_id           UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    19	  api_cost_id         UUID REFERENCES api_costs(id) ON DELETE SET NULL,
    20	  source              TEXT NOT NULL CHECK (source IN ('local_regex', 'openai_moderation', 'eval', 'admin')),
    21	  reason              TEXT,
    22	  severity            TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
    23	  status              TEXT NOT NULL DEFAULT 'open'
    24	                        CHECK (status IN ('open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration')),
    25	  reviewed_by_user_id UUID REFERENCES users(id),
    26	  reviewed_at         TIMESTAMPTZ,
    27	  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    28	  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    29	);
    30	
    31	COMMENT ON TABLE flagged_responses IS
    32	  'High-confidence unsafe drafts held out of the owner approval path until admin disposition (Wave 3 PR 3a/3b). Admin-only (deny-all RLS).';
    33	
    34	ALTER TABLE flagged_responses ENABLE ROW LEVEL SECURITY;
    35	
    36	-- Admin queue reads open items newest-first.
    37	CREATE INDEX IF NOT EXISTS idx_flagged_responses_status_created
    38	  ON flagged_responses (status, created_at DESC);
    39	
    40	-- One open flag per response (idempotent re-runs of a response generation must
    41	-- not stack duplicate open flags).
    42	CREATE UNIQUE INDEX IF NOT EXISTS idx_flagged_responses_open_response
    43	  ON flagged_responses (response_id)
    44	  WHERE status = 'open';

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "node -p \"require('./node_modules/postgres/package.json').version\"; rg -n \"value instanceof Query|function fragment|class Query|handleValue|stringifyValue\" node_modules/postgres/src node_modules/postgres/types/index.d.ts | head -80; sed -n '1,240p' node_modules/postgres/src/types.js; sed -n '1,180p' node_modules/postgres/src/query.js; rg -n \"PendingQuery|Fragment\" node_modules/postgres/types/index.d.ts | head -60" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
3.4.9
node_modules/postgres/src/query.js:6:export class Query extends Promise {
node_modules/postgres/src/types.js:75:export function handleValue(x, parameters, types, options) {
node_modules/postgres/src/types.js:100:    string += (stringifyValue(string, value, parameters, types, options)) + q.strings[i]
node_modules/postgres/src/types.js:107:function stringifyValue(string, value, parameters, types, o) {
node_modules/postgres/src/types.js:110:    value instanceof Query ? fragment(value, parameters, types, o) :
node_modules/postgres/src/types.js:113:    handleValue(value, parameters, types, o)
node_modules/postgres/src/types.js:117:function fragment(q, parameters, types, options) {
node_modules/postgres/src/types.js:125:      stringifyValue('values', row[column], parameters, types, options)
node_modules/postgres/src/types.js:146:      value instanceof Query ? fragment(value, parameters, types, options) :
node_modules/postgres/src/types.js:148:      handleValue(value, parameters, types, options)
node_modules/postgres/src/types.js:167:      '=' + stringifyValue('values', first[x], parameters, types, options)
node_modules/postgres/src/connection.js:7:import { stringify, handleValue, arrayParser, arraySerializer } from './types.js'
node_modules/postgres/src/connection.js:230:    !q.tagged && q.args.forEach(x => handleValue(x, parameters, types, options))
import { Query } from './query.js'
import { Errors } from './errors.js'

export const types = {
  string: {
    to: 25,
    from: null,             // defaults to string
    serialize: x => '' + x
  },
  number: {
    to: 0,
    from: [21, 23, 26, 700, 701],
    serialize: x => '' + x,
    parse: x => +x
  },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: x => JSON.stringify(x),
    parse: x => JSON.parse(x)
  },
  boolean: {
    to: 16,
    from: 16,
    serialize: x => x === true ? 't' : 'f',
    parse: x => x === 't'
  },
  date: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: x => (x instanceof Date ? x : new Date(x)).toISOString(),
    parse: x => new Date(x)
  },
  bytea: {
    to: 17,
    from: 17,
    serialize: x => '\\x' + Buffer.from(x).toString('hex'),
    parse: x => Buffer.from(x.slice(2), 'hex')
  }
}

class NotTagged { then() { notTagged() } catch() { notTagged() } finally() { notTagged() }}

export class Identifier extends NotTagged {
  constructor(value) {
    super()
    this.value = escapeIdentifier(value)
  }
}

export class Parameter extends NotTagged {
  constructor(value, type, array) {
    super()
    this.value = value
    this.type = type
    this.array = array
  }
}

export class Builder extends NotTagged {
  constructor(first, rest) {
    super()
    this.first = first
    this.rest = rest
  }

  build(before, parameters, types, options) {
    const keyword = builders.map(([x, fn]) => ({ fn, i: before.search(x) })).sort((a, b) => a.i - b.i).pop()
    return keyword.i === -1
      ? escapeIdentifiers(this.first, options)
      : keyword.fn(this.first, this.rest, parameters, types, options)
  }
}

export function handleValue(x, parameters, types, options) {
  let value = x instanceof Parameter ? x.value : x
  if (value === undefined) {
    x instanceof Parameter
      ? x.value = options.transform.undefined
      : value = x = options.transform.undefined

    if (value === undefined)
      throw Errors.generic('UNDEFINED_VALUE', 'Undefined values are not allowed')
  }

  return '$' + (types.push(
    x instanceof Parameter
      ? (parameters.push(x.value), x.array
        ? x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value)
        : x.type
      )
      : (parameters.push(x), inferType(x))
  ))
}

const defaultHandlers = typeHandlers(types)

export function stringify(q, string, value, parameters, types, options) { // eslint-disable-line
  for (let i = 1; i < q.strings.length; i++) {
    string += (stringifyValue(string, value, parameters, types, options)) + q.strings[i]
    value = q.args[i]
  }

  return string
}

function stringifyValue(string, value, parameters, types, o) {
  return (
    value instanceof Builder ? value.build(string, parameters, types, o) :
    value instanceof Query ? fragment(value, parameters, types, o) :
    value instanceof Identifier ? value.value :
    value && value[0] instanceof Query ? value.reduce((acc, x) => acc + ' ' + fragment(x, parameters, types, o), '') :
    handleValue(value, parameters, types, o)
  )
}

function fragment(q, parameters, types, options) {
  q.fragment = true
  return stringify(q, q.strings[0], q.args[0], parameters, types, options)
}

function valuesBuilder(first, parameters, types, columns, options) {
  return first.map(row =>
    '(' + columns.map(column =>
      stringifyValue('values', row[column], parameters, types, options)
    ).join(',') + ')'
  ).join(',')
}

function values(first, rest, parameters, types, options) {
  const multi = Array.isArray(first[0])
  const columns = rest.length ? rest.flat() : Object.keys(multi ? first[0] : first)
  return valuesBuilder(multi ? first : [first], parameters, types, columns, options)
}

function select(first, rest, parameters, types, options) {
  typeof first === 'string' && (first = [first].concat(rest))
  if (Array.isArray(first))
    return escapeIdentifiers(first, options)

  let value
  const columns = rest.length ? rest.flat() : Object.keys(first)
  return columns.map(x => {
    value = first[x]
    return (
      value instanceof Query ? fragment(value, parameters, types, options) :
      value instanceof Identifier ? value.value :
      handleValue(value, parameters, types, options)
    ) + ' as ' + escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x)
  }).join(',')
}

const builders = Object.entries({
  values,
  in: (...xs) => {
    const x = values(...xs)
    return x === '()' ? '(null)' : x
  },
  select,
  as: select,
  returning: select,
  '\\(': select,

  update(first, rest, parameters, types, options) {
    return (rest.length ? rest.flat() : Object.keys(first)).map(x =>
      escapeIdentifier(options.transform.column.to ? options.transform.column.to(x) : x) +
      '=' + stringifyValue('values', first[x], parameters, types, options)
    )
  },

  insert(first, rest, parameters, types, options) {
    const columns = rest.length ? rest.flat() : Object.keys(Array.isArray(first) ? first[0] : first)
    return '(' + escapeIdentifiers(columns, options) + ')values' +
    valuesBuilder(Array.isArray(first) ? first : [first], parameters, types, columns, options)
  }
}).map(([x, fn]) => ([new RegExp('((?:^|[\\s(])' + x + '(?:$|[\\s(]))(?![\\s\\S]*\\1)', 'i'), fn]))

function notTagged() {
  throw Errors.generic('NOT_TAGGED_CALL', 'Query not called as a tagged template literal')
}

export const serializers = defaultHandlers.serializers
export const parsers = defaultHandlers.parsers

export const END = {}

function firstIsString(x) {
  if (Array.isArray(x))
    return firstIsString(x[0])
  return typeof x === 'string' ? 1009 : 0
}

export const mergeUserTypes = function(types) {
  const user = typeHandlers(types || {})
  return {
    serializers: Object.assign({}, serializers, user.serializers),
    parsers: Object.assign({}, parsers, user.parsers)
  }
}

function typeHandlers(types) {
  return Object.keys(types).reduce((acc, k) => {
    types[k].from && [].concat(types[k].from).forEach(x => acc.parsers[x] = types[k].parse)
    if (types[k].serialize) {
      acc.serializers[types[k].to] = types[k].serialize
      types[k].from && [].concat(types[k].from).forEach(x => acc.serializers[x] = types[k].serialize)
    }
    return acc
  }, { parsers: {}, serializers: {} })
}

function escapeIdentifiers(xs, { transform: { column } }) {
  return xs.map(x => escapeIdentifier(column.to ? column.to(x) : x)).join(',')
}

export const escapeIdentifier = function escape(str) {
  return '"' + str.replace(/"/g, '""').replace(/\./g, '"."') + '"'
}

export const inferType = function inferType(x) {
  return (
    x instanceof Parameter ? x.type :
    x instanceof Date ? 1184 :
    x instanceof Uint8Array ? 17 :
    (x === true || x === false) ? 16 :
    typeof x === 'bigint' ? 20 :
    Array.isArray(x) ? inferType(x[0]) :
    0
  )
}

const escapeBackslash = /\\/g
const escapeQuote = /"/g

function arrayEscape(x) {
  return x
    .replace(escapeBackslash, '\\\\')
    .replace(escapeQuote, '\\"')
}

const originCache = new Map()
    , originStackCache = new Map()
    , originError = Symbol('OriginError')

export const CLOSE = {}
export class Query extends Promise {
  constructor(strings, args, handler, canceller, options = {}) {
    let resolve
      , reject

    super((a, b) => {
      resolve = a
      reject = b
    })

    this.tagged = Array.isArray(strings.raw)
    this.strings = strings
    this.args = args
    this.handler = handler
    this.canceller = canceller
    this.options = options

    this.state = null
    this.statement = null

    this.resolve = x => (this.active = false, resolve(x))
    this.reject = x => (this.active = false, reject(x))

    this.active = false
    this.cancelled = null
    this.executed = false
    this.signature = ''

    this[originError] = this.handler.debug
      ? new Error()
      : this.tagged && cachedError(this.strings)
  }

  get origin() {
    return (this.handler.debug
      ? this[originError].stack
      : this.tagged && originStackCache.has(this.strings)
        ? originStackCache.get(this.strings)
        : originStackCache.set(this.strings, this[originError].stack).get(this.strings)
    ) || ''
  }

  static get [Symbol.species]() {
    return Promise
  }

  cancel() {
    return this.canceller && (this.canceller(this), this.canceller = null)
  }

  simple() {
    this.options.simple = true
    this.options.prepare = false
    return this
  }

  async readable() {
    this.simple()
    this.streaming = true
    return this
  }

  async writable() {
    this.simple()
    this.streaming = true
    return this
  }

  cursor(rows = 1, fn) {
    this.options.simple = false
    if (typeof rows === 'function') {
      fn = rows
      rows = 1
    }

    this.cursorRows = rows

    if (typeof fn === 'function')
      return (this.cursorFn = fn, this)

    let prev
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (this.executed && !this.active)
            return { done: true }

          prev && prev()
          const promise = new Promise((resolve, reject) => {
            this.cursorFn = value => {
              resolve({ value, done: false })
              return new Promise(r => prev = r)
            }
            this.resolve = () => (this.active = false, resolve({ done: true }))
            this.reject = x => (this.active = false, reject(x))
          })
          this.execute()
          return promise
        },
        return() {
          prev && prev(CLOSE)
          return { done: true }
        }
      })
    }
  }

  describe() {
    this.options.simple = false
    this.onlyDescribe = this.options.prepare = true
    return this
  }

  stream() {
    throw new Error('.stream has been renamed to .forEach')
  }

  forEach(fn) {
    this.forEachFn = fn
    this.handle()
    return this
  }

  raw() {
    this.isRaw = true
    return this
  }

  values() {
    this.isRaw = 'values'
    return this
  }

  async handle() {
    !this.executed && (this.executed = true) && await 1 && this.handler(this)
  }

  execute() {
    this.handle()
    return this
  }

  then() {
    this.handle()
    return super.then.apply(this, arguments)
  }

  catch() {
    this.handle()
    return super.catch.apply(this, arguments)
  }

  finally() {
    this.handle()
    return super.finally.apply(this, arguments)
  }
}

function cachedError(xs) {
  if (originCache.has(xs))
    return originCache.get(xs)

  const x = Error.stackTraceLimit
  Error.stackTraceLimit = 4
  originCache.set(xs, new Error())
  Error.stackTraceLimit = x
  return originCache.get(xs)
}
195:  [unknown] extends [T] ? postgres.Helper<T, K> : // ensure no `PendingQuery` with `any` types
196:  [TemplateStringsArray] extends [T] ? postgres.PendingQuery<postgres.Row[]> :
602:  interface PendingQueryModifiers<TRow extends readonly any[]> {
625:  interface PendingValuesQuery<TRow extends readonly MaybeRow[]> extends Promise<ValuesRowList<TRow>>, PendingQueryModifiers<TRow[number][keyof TRow[number]][][]> {
629:  interface PendingRawQuery<TRow extends readonly MaybeRow[]> extends Promise<RawRowList<TRow>>, PendingQueryModifiers<Buffer[][]> {
632:  interface PendingQuery<TRow extends readonly MaybeRow[]> extends Promise<RowList<TRow>>, PendingQueryModifiers<TRow> {
650:  type Fragment = PendingQuery<any>
656:  type ParameterOrFragment<T> =
658:  | Fragment
659:  | Fragment[]
684:    <T extends readonly (object | undefined)[] = Row[]>(template: TemplateStringsArray, ...parameters: readonly (ParameterOrFragment<TTypes[keyof TTypes]>)[]): PendingQuery<T>;
691:    unsafe<T extends any[] = (Row & Iterable<Row>)[]>(query: string, parameters?: (ParameterOrJSON<TTypes[keyof TTypes]>)[] | undefined, queryOptions?: UnsafeQueryOptions | undefined): PendingQuery<T>;
696:    file<T extends readonly any[] = Row[]>(path: string | Buffer | URL | number, options?: { cache?: boolean | undefined } | undefined): PendingQuery<T>;
697:    file<T extends readonly any[] = Row[]>(path: string | Buffer | URL | number, args: (ParameterOrJSON<TTypes[keyof TTypes]>)[], options?: { cache?: boolean | undefined } | undefined): PendingQuery<T>;

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg -n -C 8 \"held|flagged_responses|readCalls|ownerCalls|topLevelQueue|toHaveLength\" 'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts' src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts src/lib/dashboard/__tests__ src/lib/agents/__tests__/read.test.ts src/lib/past-replies/__tests__/reviews-list.test.ts" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
src/lib/past-replies/__tests__/reviews-list.test.ts-126-    response_id: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-127-    approved_text: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-128-    approval_method: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-129-    posted_at: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-130-    version: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-131-    failed_response_id: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-132-    failed_posting_error: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-133-    draft_response_id: null,
src/lib/past-replies/__tests__/reviews-list.test.ts:134:    draft_held: false,
src/lib/past-replies/__tests__/reviews-list.test.ts-135-    generation_in_flight: false,
src/lib/past-replies/__tests__/reviews-list.test.ts-136-    is_orphan: false,
src/lib/past-replies/__tests__/reviews-list.test.ts-137-    orphan_failed_response_id: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-138-    orphan_posting_error: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-139-    superseded_text: null,
src/lib/past-replies/__tests__/reviews-list.test.ts-140-    ...overrides,
src/lib/past-replies/__tests__/reviews-list.test.ts-141-  };
src/lib/past-replies/__tests__/reviews-list.test.ts-142-}
--
src/lib/past-replies/__tests__/reviews-list.test.ts-163-    locationId,
src/lib/past-replies/__tests__/reviews-list.test.ts-164-    page,
src/lib/past-replies/__tests__/reviews-list.test.ts-165-  });
src/lib/past-replies/__tests__/reviews-list.test.ts-166-  return { view: raw as unknown as ReviewsListView | null, calls };
src/lib/past-replies/__tests__/reviews-list.test.ts-167-}
src/lib/past-replies/__tests__/reviews-list.test.ts-168-
src/lib/past-replies/__tests__/reviews-list.test.ts-169-function mainQuery(calls: SqlCall[]): SqlCall {
src/lib/past-replies/__tests__/reviews-list.test.ts-170-  const found = calls.filter((call) => /AS\s+review_id/i.test(call.text));
src/lib/past-replies/__tests__/reviews-list.test.ts:171:  expect(found).toHaveLength(1); // F3: exactly ONE row source, no orphan sidecar query
src/lib/past-replies/__tests__/reviews-list.test.ts-172-  return found[0]!;
src/lib/past-replies/__tests__/reviews-list.test.ts-173-}
src/lib/past-replies/__tests__/reviews-list.test.ts-174-
src/lib/past-replies/__tests__/reviews-list.test.ts-175-/**
src/lib/past-replies/__tests__/reviews-list.test.ts-176- * The four shapes `fakeSql` actually resolves rows for, i.e. the discrimination
src/lib/past-replies/__tests__/reviews-list.test.ts-177- * `mainQuery` does, widened to its three siblings.
src/lib/past-replies/__tests__/reviews-list.test.ts-178- *
src/lib/past-replies/__tests__/reviews-list.test.ts-179- * Query-count assertions must run through this rather than counting raw tagged
--
src/lib/past-replies/__tests__/reviews-list.test.ts-206-    const { view } = await loadView({
src/lib/past-replies/__tests__/reviews-list.test.ts-207-      main: [listRow({ review_id: 'rev-never' })],
src/lib/past-replies/__tests__/reviews-list.test.ts-208-      unansweredTotal: 1,
src/lib/past-replies/__tests__/reviews-list.test.ts-209-      answeredTotal: 0,
src/lib/past-replies/__tests__/reviews-list.test.ts-210-    });
src/lib/past-replies/__tests__/reviews-list.test.ts-211-
src/lib/past-replies/__tests__/reviews-list.test.ts-212-    expect(view).not.toBeNull();
src/lib/past-replies/__tests__/reviews-list.test.ts-213-    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-never']);
src/lib/past-replies/__tests__/reviews-list.test.ts:214:    expect(view!.answeredRows).toHaveLength(0);
src/lib/past-replies/__tests__/reviews-list.test.ts-215-    // A never-replied review is exactly what the Generate door exists for.
src/lib/past-replies/__tests__/reviews-list.test.ts-216-    expect(view!.unansweredRows[0]!.reply_state).toBe('none');
src/lib/past-replies/__tests__/reviews-list.test.ts-217-    expect(view!.unansweredRows[0]!.row_action).toBe('generate');
src/lib/past-replies/__tests__/reviews-list.test.ts-218-  });
src/lib/past-replies/__tests__/reviews-list.test.ts-219-
src/lib/past-replies/__tests__/reviews-list.test.ts-220-  it('loadPastRepliesPageView orders unanswered rows before answered rows', async () => {
src/lib/past-replies/__tests__/reviews-list.test.ts-221-    // `false` sorts before `true` in Postgres, so `(resp.id IS NOT NULL)` leads
src/lib/past-replies/__tests__/reviews-list.test.ts-222-    // with the unanswered group (S6). Pin the ORDER BY as well as the grouping:
--
src/lib/past-replies/__tests__/reviews-list.test.ts-270-    // page-2 form passed even with the OFFSET dropped entirely. 2 * PAGE_SIZE
src/lib/past-replies/__tests__/reviews-list.test.ts-271-    // is a value the LIMIT cannot supply, so this pins the OFFSET distinctly.
src/lib/past-replies/__tests__/reviews-list.test.ts-272-    expect(mainQuery(calls).values).toContain(2 * PAGE_SIZE);
src/lib/past-replies/__tests__/reviews-list.test.ts-273-    expect(view!.page).toBe(3);
src/lib/past-replies/__tests__/reviews-list.test.ts-274-  });
src/lib/past-replies/__tests__/reviews-list.test.ts-275-
src/lib/past-replies/__tests__/reviews-list.test.ts-276-  it('loadPastRepliesPageView marks a review with a non-terminal response as draft-ready and never generatable', async () => {
src/lib/past-replies/__tests__/reviews-list.test.ts-277-    const { view } = await loadView({
src/lib/past-replies/__tests__/reviews-list.test.ts:278:      main: [listRow({ review_id: 'rev-draft', draft_response_id: 'resp-draft', draft_held: false })],
src/lib/past-replies/__tests__/reviews-list.test.ts-279-      unansweredTotal: 1,
src/lib/past-replies/__tests__/reviews-list.test.ts-280-      answeredTotal: 0,
src/lib/past-replies/__tests__/reviews-list.test.ts-281-    });
src/lib/past-replies/__tests__/reviews-list.test.ts-282-
src/lib/past-replies/__tests__/reviews-list.test.ts-283-    // No posted sibling → grouped Unanswered, but it must never offer Generate:
src/lib/past-replies/__tests__/reviews-list.test.ts-284-    // the partial unique index (023+026+029) permits at most ONE non-terminal
src/lib/past-replies/__tests__/reviews-list.test.ts-285-    // response per review, so a second draft could not persist anyway (S2).
src/lib/past-replies/__tests__/reviews-list.test.ts-286-    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-draft']);
--
src/lib/past-replies/__tests__/reviews-list.test.ts-316-    });
src/lib/past-replies/__tests__/reviews-list.test.ts-317-
src/lib/past-replies/__tests__/reviews-list.test.ts-318-    // D-G: an orphan has no live Google reply (so `Unanswered` is honest) but
src/lib/past-replies/__tests__/reviews-list.test.ts-319-    // DOES have a superseded draft — offering Generate would race /retry and
src/lib/past-replies/__tests__/reviews-list.test.ts-320-    // /restore-original.
src/lib/past-replies/__tests__/reviews-list.test.ts-321-    expect(view!.unansweredRows.map((row) => row.review_id)).toEqual(['rev-orphan']);
src/lib/past-replies/__tests__/reviews-list.test.ts-322-    expect(view!.unansweredRows[0]!.reply_state).toBe('orphan');
src/lib/past-replies/__tests__/reviews-list.test.ts-323-    expect(view!.unansweredRows[0]!.row_action).toBe('recover');
src/lib/past-replies/__tests__/reviews-list.test.ts:324:    expect(view!.answeredRows).toHaveLength(0);
src/lib/past-replies/__tests__/reviews-list.test.ts-325-  });
src/lib/past-replies/__tests__/reviews-list.test.ts-326-
src/lib/past-replies/__tests__/reviews-list.test.ts-327-  it('loadPastRepliesPageView scopes every row and count to the requested business_id', async () => {
src/lib/past-replies/__tests__/reviews-list.test.ts-328-    const { calls } = await loadView({
src/lib/past-replies/__tests__/reviews-list.test.ts-329-      main: [listRow()],
src/lib/past-replies/__tests__/reviews-list.test.ts-330-      unansweredTotal: 1,
src/lib/past-replies/__tests__/reviews-list.test.ts-331-      answeredTotal: 1,
src/lib/past-replies/__tests__/reviews-list.test.ts-332-    }, 1, OTHER_LOCATION_ID);
--
src/lib/past-replies/__tests__/reviews-list.test.ts-337-      (call) => !/FROM\s+businesses\s+b/i.test(call.text),
src/lib/past-replies/__tests__/reviews-list.test.ts-338-    );
src/lib/past-replies/__tests__/reviews-list.test.ts-339-    // Exactly FOUR ROW-PRODUCING queries: the single row source, the two group
src/lib/past-replies/__tests__/reviews-list.test.ts-340-    // COUNTs, and the average. Pre-#678 there were five (the separate orphan
src/lib/past-replies/__tests__/reviews-list.test.ts-341-    // query, deleted by F3) and the counts were the activation-split
src/lib/past-replies/__tests__/reviews-list.test.ts-342-    // gap/historical pair, which S3 replaces with per-row provenance badges.
src/lib/past-replies/__tests__/reviews-list.test.ts-343-    // Counted through rowProducingQueries so a bound fragment (e.g. a status
src/lib/past-replies/__tests__/reviews-list.test.ts-344-    // `text[]`) never inflates the number and dictates the production SQL (Q3).
src/lib/past-replies/__tests__/reviews-list.test.ts:345:    expect(dataQueries).toHaveLength(4);
src/lib/past-replies/__tests__/reviews-list.test.ts-346-    for (const call of dataQueries) {
src/lib/past-replies/__tests__/reviews-list.test.ts-347-      expect(call.text).toMatch(/business_id\s*=/i);
src/lib/past-replies/__tests__/reviews-list.test.ts-348-      expect(call.values).toContain(OTHER_LOCATION_ID);
src/lib/past-replies/__tests__/reviews-list.test.ts-349-      // No query still splits on subscription_activated_at.
src/lib/past-replies/__tests__/reviews-list.test.ts-350-      expect(call.text).not.toMatch(/timestamptz/i);
src/lib/past-replies/__tests__/reviews-list.test.ts-351-    }
src/lib/past-replies/__tests__/reviews-list.test.ts-352-    const bizLookup = calls.find((call) => /FROM\s+businesses\s+b/i.test(call.text));
src/lib/past-replies/__tests__/reviews-list.test.ts-353-    expect(bizLookup!.values).toContain(ACCOUNT_ID);
--
src/lib/past-replies/__tests__/reviews-list.test.ts-383-        }),
src/lib/past-replies/__tests__/reviews-list.test.ts-384-        listRow({ review_id: 'rev-plain' }),
src/lib/past-replies/__tests__/reviews-list.test.ts-385-      ],
src/lib/past-replies/__tests__/reviews-list.test.ts-386-      unansweredTotal: 2,
src/lib/past-replies/__tests__/reviews-list.test.ts-387-      answeredTotal: 0,
src/lib/past-replies/__tests__/reviews-list.test.ts-388-    });
src/lib/past-replies/__tests__/reviews-list.test.ts-389-
src/lib/past-replies/__tests__/reviews-list.test.ts-390-    const orphanOccurrences = allRows(view!).filter((row) => row.review_id === 'rev-orphan');
src/lib/past-replies/__tests__/reviews-list.test.ts:391:    expect(orphanOccurrences).toHaveLength(1);
src/lib/past-replies/__tests__/reviews-list.test.ts-392-    expect(orphanOccurrences[0]!.row_action).toBe('recover');
src/lib/past-replies/__tests__/reviews-list.test.ts-393-    expect(orphanOccurrences[0]!.row_action).not.toBe('generate');
src/lib/past-replies/__tests__/reviews-list.test.ts-394-    // …and the separate orphan query is gone (mainQuery asserts exactly one).
src/lib/past-replies/__tests__/reviews-list.test.ts-395-    mainQuery(calls);
src/lib/past-replies/__tests__/reviews-list.test.ts-396-  });
src/lib/past-replies/__tests__/reviews-list.test.ts-397-
src/lib/past-replies/__tests__/reviews-list.test.ts-398-  it('consecutive Reviews-list pages are disjoint and each contains at most PAGE_SIZE unique reviews, including orphan recovery rows', async () => {
src/lib/past-replies/__tests__/reviews-list.test.ts-399-    const pageOne = Array.from({ length: PAGE_SIZE }, (_unused, index) =>
--
src/lib/past-replies/__tests__/reviews-list.test.ts-444-        listRow({ review_id: 'rev-b', review_date: sameInstant }),
src/lib/past-replies/__tests__/reviews-list.test.ts-445-        listRow({ review_id: 'rev-a', review_date: sameInstant }),
src/lib/past-replies/__tests__/reviews-list.test.ts-446-      ],
src/lib/past-replies/__tests__/reviews-list.test.ts-447-      unansweredTotal: 2,
src/lib/past-replies/__tests__/reviews-list.test.ts-448-      answeredTotal: 0,
src/lib/past-replies/__tests__/reviews-list.test.ts-449-    });
src/lib/past-replies/__tests__/reviews-list.test.ts-450-
src/lib/past-replies/__tests__/reviews-list.test.ts-451-    expect(mainQuery(calls).text).toMatch(/ORDER BY[\s\S]*r\.review_date DESC\s*,\s*r\.id DESC/i);
src/lib/past-replies/__tests__/reviews-list.test.ts:452:    expect(allRows(view!)).toHaveLength(2);
src/lib/past-replies/__tests__/reviews-list.test.ts-453-  });
src/lib/past-replies/__tests__/reviews-list.test.ts-454-
src/lib/past-replies/__tests__/reviews-list.test.ts-455-  it('an orphan row keeps its failed_response_id and superseded text after the single-query merge', async () => {
src/lib/past-replies/__tests__/reviews-list.test.ts-456-    // Round-2 Defect A. `PastReplyCard` renders the recovery badge from the
src/lib/past-replies/__tests__/reviews-list.test.ts-457-    // server-derived `recover` state (PastReplyCard.tsx:314) and gates the
src/lib/past-replies/__tests__/reviews-list.test.ts-458-    // recovery ACTIONS on `row.failed_response_id` (:388, :442). The deleted
src/lib/past-replies/__tests__/reviews-list.test.ts-459-    // `toOrphanCardRow` fed both from the orphan query's columns; post-F3
src/lib/past-replies/__tests__/reviews-list.test.ts-460-    // they must come from the orphan_sidecar / orphan_superseded LATERALs.
--
src/lib/agents/__tests__/read.test.ts-194-
src/lib/agents/__tests__/read.test.ts-195-    await expect(
src/lib/agents/__tests__/read.test.ts-196-      getReviewTimeline(harness.mockSql as unknown as Sql, {
src/lib/agents/__tests__/read.test.ts-197-        accountId: 'account-1',
src/lib/agents/__tests__/read.test.ts-198-        reviewId: 'review-1',
src/lib/agents/__tests__/read.test.ts-199-      }),
src/lib/agents/__tests__/read.test.ts-200-    ).resolves.toBeNull();
src/lib/agents/__tests__/read.test.ts-201-
src/lib/agents/__tests__/read.test.ts:202:    expect(harness.sqlCalls).toHaveLength(1);
src/lib/agents/__tests__/read.test.ts-203-    expect(harness.sqlCalls[0]!.text).toMatch(/FROM reviews r\s+JOIN businesses b/);
src/lib/agents/__tests__/read.test.ts-204-    expect(harness.sqlCalls[0]!.text).toMatch(/r\.id = \?/);
src/lib/agents/__tests__/read.test.ts-205-    expect(harness.sqlCalls[0]!.text).toMatch(/b\.account_id = \?/);
src/lib/agents/__tests__/read.test.ts-206-    expect(harness.sqlCalls[0]!.text).toContain('b.archived_at IS NULL');
src/lib/agents/__tests__/read.test.ts-207-    expect(harness.sqlCalls[0]!.values).toEqual(['review-1', 'account-1']);
src/lib/agents/__tests__/read.test.ts-208-  });
src/lib/agents/__tests__/read.test.ts-209-
src/lib/agents/__tests__/read.test.ts-210-  it('returns an honest empty timeline for a scoped legacy review', async () => {
--
src/lib/agents/__tests__/read.test.ts-236-        submittedAt: '2026-07-10T09:30:00.000Z',
src/lib/agents/__tests__/read.test.ts-237-        status: 'pending_approval',
src/lib/agents/__tests__/read.test.ts-238-      },
src/lib/agents/__tests__/read.test.ts-239-      response: null,
src/lib/agents/__tests__/read.test.ts-240-      escalation: null,
src/lib/agents/__tests__/read.test.ts-241-      runs: [],
src/lib/agents/__tests__/read.test.ts-242-    });
src/lib/agents/__tests__/read.test.ts-243-
src/lib/agents/__tests__/read.test.ts:244:    expect(harness.sqlCalls).toHaveLength(4);
src/lib/agents/__tests__/read.test.ts-245-    expect(harness.sqlCalls[1]!.text).toMatch(/FROM responses resp/);
src/lib/agents/__tests__/read.test.ts-246-    expect(harness.sqlCalls[1]!.text).toMatch(/b\.account_id = \?/);
src/lib/agents/__tests__/read.test.ts-247-    expect(harness.sqlCalls[2]!.text).toMatch(/FROM review_escalations e/);
src/lib/agents/__tests__/read.test.ts-248-    expect(harness.sqlCalls[2]!.text).toMatch(/e\.account_id = \?/);
src/lib/agents/__tests__/read.test.ts-249-    expect(harness.sqlCalls[3]!.text).toMatch(/FROM agent_runs ar/);
src/lib/agents/__tests__/read.test.ts-250-    expect(harness.sqlCalls[3]!.text).toContain('LIMIT 20');
src/lib/agents/__tests__/read.test.ts-251-  });
src/lib/agents/__tests__/read.test.ts-252-
--
src/lib/agents/__tests__/read.test.ts-367-      id: 'escalation-1',
src/lib/agents/__tests__/read.test.ts-368-      status: 'acknowledged',
src/lib/agents/__tests__/read.test.ts-369-      severity: 'high',
src/lib/agents/__tests__/read.test.ts-370-      suggestedAction: 'respond_and_escalate',
src/lib/agents/__tests__/read.test.ts-371-      createdAt: '2026-07-12T08:02:00.000Z',
src/lib/agents/__tests__/read.test.ts-372-      acknowledgedAt: '2026-07-12T08:05:00.000Z',
src/lib/agents/__tests__/read.test.ts-373-      resolvedAt: null,
src/lib/agents/__tests__/read.test.ts-374-    });
src/lib/agents/__tests__/read.test.ts:375:    expect(timeline?.runs).toHaveLength(2);
src/lib/agents/__tests__/read.test.ts-376-    expect(timeline?.runs[0]).toMatchObject({
src/lib/agents/__tests__/read.test.ts-377-      id: 'run-new',
src/lib/agents/__tests__/read.test.ts-378-      displayState: 'waiting_on_owner',
src/lib/agents/__tests__/read.test.ts-379-      error: null,
src/lib/agents/__tests__/read.test.ts-380-      steps: [
src/lib/agents/__tests__/read.test.ts-381-        expect.objectContaining({
src/lib/agents/__tests__/read.test.ts-382-          stepIndex: 1,
src/lib/agents/__tests__/read.test.ts-383-          attributedAgent: 'system',
--
src/lib/agents/__tests__/read.test.ts-398-      ],
src/lib/agents/__tests__/read.test.ts-399-    });
src/lib/agents/__tests__/read.test.ts-400-    expect(timeline?.runs[1]).toMatchObject({
src/lib/agents/__tests__/read.test.ts-401-      id: 'run-old',
src/lib/agents/__tests__/read.test.ts-402-      displayState: 'failed',
src/lib/agents/__tests__/read.test.ts-403-      error: { reason: 'provider_terminal' },
src/lib/agents/__tests__/read.test.ts-404-    });
src/lib/agents/__tests__/read.test.ts-405-
src/lib/agents/__tests__/read.test.ts:406:    expect(harness.sqlCalls).toHaveLength(6);
src/lib/agents/__tests__/read.test.ts-407-    expect(harness.sqlCalls[4]!.text).toMatch(/s\.agent_run_id = ANY\(\?::uuid\[\]\)/);
src/lib/agents/__tests__/read.test.ts-408-    expect(harness.sqlCalls[4]!.text).toContain('ORDER BY s.agent_run_id, s.step_index');
src/lib/agents/__tests__/read.test.ts-409-    expect(harness.sqlCalls[5]!.text).toMatch(/o\.agent_run_id = ANY\(\?::uuid\[\]\)/);
src/lib/agents/__tests__/read.test.ts-410-    expect(harness.sqlCalls[4]!.values[0]).toEqual(['run-new', 'run-old']);
src/lib/agents/__tests__/read.test.ts-411-    expect(harness.sqlCalls[5]!.values[0]).toEqual(['run-new', 'run-old']);
src/lib/agents/__tests__/read.test.ts-412-  });
src/lib/agents/__tests__/read.test.ts-413-});
src/lib/agents/__tests__/read.test.ts-414-
--
src/lib/agents/__tests__/read.test.ts-433-    await expect(
src/lib/agents/__tests__/read.test.ts-434-      getAgentTeamSummary(
src/lib/agents/__tests__/read.test.ts-435-        harness.mockSql as unknown as Sql,
src/lib/agents/__tests__/read.test.ts-436-        { kind: 'account', accountId: 'account-1' },
src/lib/agents/__tests__/read.test.ts-437-        '30d',
src/lib/agents/__tests__/read.test.ts-438-      ),
src/lib/agents/__tests__/read.test.ts-439-    ).resolves.toEqual({ reply: 2, guardian: 4, insights: 5 });
src/lib/agents/__tests__/read.test.ts-440-
src/lib/agents/__tests__/read.test.ts:441:    expect(harness.sqlCalls).toHaveLength(1);
src/lib/agents/__tests__/read.test.ts-442-    expect(harness.sqlCalls[0]!.text).toMatch(/FROM agent_outcomes o/);
src/lib/agents/__tests__/read.test.ts-443-    expect(harness.sqlCalls[0]!.text).toMatch(/o\.account_id = \?/);
src/lib/agents/__tests__/read.test.ts-444-    expect(harness.sqlCalls[0]!.text).not.toMatch(/o\.business_id = \?/);
src/lib/agents/__tests__/read.test.ts-445-    expect(harness.sqlCalls[0]!.text).toContain('COUNT(*)::int AS n');
src/lib/agents/__tests__/read.test.ts-446-    expect(harness.sqlCalls[0]!.values[0]).toBe('account-1');
src/lib/agents/__tests__/read.test.ts-447-    expect(harness.sqlCalls[0]!.values[1]).toBeInstanceOf(Date);
src/lib/agents/__tests__/read.test.ts-448-  });
src/lib/agents/__tests__/read.test.ts-449-
--
src/lib/agents/__tests__/read.test.ts-476-    await expect(
src/lib/agents/__tests__/read.test.ts-477-      getAgentTeamSummary(
src/lib/agents/__tests__/read.test.ts-478-        harness.mockSql as unknown as Sql,
src/lib/agents/__tests__/read.test.ts-479-        { kind: 'location', accountId: 'account-1', businessId: 'business-1' },
src/lib/agents/__tests__/read.test.ts-480-        '7d',
src/lib/agents/__tests__/read.test.ts-481-      ),
src/lib/agents/__tests__/read.test.ts-482-    ).resolves.toEqual({ reply: 1, guardian: 0, insights: 0 });
src/lib/agents/__tests__/read.test.ts-483-
src/lib/agents/__tests__/read.test.ts:484:    expect(harness.sqlCalls).toHaveLength(1);
src/lib/agents/__tests__/read.test.ts-485-    expect(harness.sqlCalls[0]!.text).toMatch(/o\.account_id = \?/);
src/lib/agents/__tests__/read.test.ts-486-    expect(harness.sqlCalls[0]!.text).toMatch(/o\.business_id = \?/);
src/lib/agents/__tests__/read.test.ts-487-    expect(harness.sqlCalls[0]!.values).toEqual([
src/lib/agents/__tests__/read.test.ts-488-      'account-1',
src/lib/agents/__tests__/read.test.ts-489-      'business-1',
src/lib/agents/__tests__/read.test.ts-490-      expect.any(Date),
src/lib/agents/__tests__/read.test.ts-491-    ]);
src/lib/agents/__tests__/read.test.ts-492-  });
--
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-2-import { NextRequest } from 'next/server';
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-3-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-4-// ── Hoisted shared state ────────────────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-5-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-6-const {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-7-  mockRequireRole,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-8-  mockGetRequestScope,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-9-  accountQueue,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:10:  topLevelQueue,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-11-  sqlProxy,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-12-  sqlReadProxy,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-13-} = vi.hoisted(() => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-14-  const mockRequireRole = vi.fn();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-15-  const mockGetRequestScope = vi.fn();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-16-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-17-  const accountQueue: unknown[][] = [];
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:18:  const topLevelQueue: unknown[][] = [];
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-19-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-20-  // sql (write pool): the resolveOwnerScope auth preamble stays on it — the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-21-  // subscription-gate SELECT it fires internally (plan #477 Task 1 wiring
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-22-  // decision: shared auth helper is never threaded onto sqlRead).
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-23-  const sqlMock = vi.fn(async (strings?: TemplateStringsArray) => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-24-    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-25-    if (text.includes('subscription_status')) {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-26-      const nextAccount = accountQueue.shift();
--
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-30-    return [];
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-31-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-32-  const sqlProxy = new Proxy(sqlMock, {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-33-    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-34-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-35-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-36-  // sqlRead (read bulkhead): the route-body reads (job_outbox lookup + the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-37-  // completed-job response lookup) moved off write `sql` onto it (#477 Task 1).
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:38:  const sqlReadMock = vi.fn(async () => topLevelQueue.shift() ?? []);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-39-  const sqlReadProxy = new Proxy(sqlReadMock, {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-40-    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-41-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-42-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-43-  return {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-44-    mockRequireRole,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-45-    mockGetRequestScope,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-46-    accountQueue,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:47:    topLevelQueue,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-48-    sqlProxy,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-49-    sqlReadProxy,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-50-  };
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-51-});
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-52-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-53-// ── Mocks ───────────────────────────────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-54-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-55-vi.mock('@/lib/db/auth', () => {
--
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-110-  const headers: Record<string, string> = {};
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-111-  if (opts?.locationScopeCookie) {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-112-    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-113-  }
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-114-  return new NextRequest(url, { method: 'GET', headers });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-115-}
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-116-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-117-function seedTopLevel(...rowsets: unknown[][]) {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:118:  topLevelQueue.push(...rowsets);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-119-}
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-120-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-121-function seedAccountRows(rows: unknown[]) {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-122-  accountQueue.push(rows);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-123-}
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-124-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-125-beforeEach(() => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-126-  vi.clearAllMocks();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-127-  accountQueue.length = 0;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:128:  topLevelQueue.length = 0;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-129-  process.env.EDIT_REPLIES_ENABLED = 'true';
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-130-  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-131-  // Default: requireRole succeeds; getRequestScope resolves to primary location.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-132-  mockRequireRole.mockResolvedValue(ownerUser());
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-133-  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-134-});
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-135-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-136-afterEach(() => {
--
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-418-    ]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-419-    const GET = await importGET();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-420-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID, locationScopeCookie: ALT_LOCATION_ID }));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-421-    expect(res.status).toBe(403);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-422-    expect(await res.json()).toEqual({ error: 'forbidden' });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-423-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-424-});
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-425-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:426:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-427-//
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:428:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-429-// button" — the poller must answer with the owner-visible refusal vocabulary
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:430:// `held_for_review` and never the draft text. src/lib/moderation/held-draft.ts
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:431:// is the semantic owner of "is this draft held"; the read-only poller holds no
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-432-// tx, so it spells the same predicate as a correlated EXISTS on
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:433:// flagged_responses inside the tenant-scoped response lookup.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-434-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:435:// Unique sentinels: heldness refusals assert these appear NOWHERE in the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-436-// serialized body — a leak of either is an invariant #4 violation.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-437-const SENTINEL_HELD_ID = 'SENTINEL_HELD_ID_84c1f0d2e6b34c5f';
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-438-const SENTINEL_HELD_TEXT = 'SENTINEL_HELD_TEXT_9b3e5a710d2c4e8a';
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-439-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-440-function seedCompletedOutbox() {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-441-  seedTopLevel([
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-442-    {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-443-      status: 'completed',
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-444-      payload: { business_id: LOCATION_ID, review_id: REVIEW_ID, version: 2 },
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-445-      last_error: null,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-446-      aggregate_id: REVIEW_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-447-    },
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-448-  ]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-449-}
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-450-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:451:describe('GET /api/dashboard/past-replies/draft-status — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:452:  it('returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-453-    seedCompletedOutbox();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-454-    // Response row resolves for the caller's location but carries an OPEN flag.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-455-    seedTopLevel([
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-456-      {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-457-        id: SENTINEL_HELD_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-458-        status: 'pending_approval',
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-459-        response_text: SENTINEL_HELD_TEXT,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-460-        business_id: LOCATION_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:461:        held: true,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-462-      },
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-463-    ]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-464-    const GET = await importGET();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-465-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-466-    expect(res.status).toBe(200);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-467-    const body = await res.json();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-468-    const serialized = JSON.stringify(body);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-469-    expect(serialized).not.toContain(SENTINEL_HELD_ID);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-470-    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-471-    // Exactly the safe shape — nothing but the refusal vocabulary.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:472:    expect(body).toEqual({ status: 'failed', error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-473-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-474-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-475-  it("returns the draft text when the resolved response's moderation flag is closed", async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:476:    // Deliberate GREEN characterization: a closed flag (held: false) is the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-477-    // release path — the draft text surfaces exactly as today.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-478-    seedCompletedOutbox();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-479-    seedTopLevel([
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-480-      {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-481-        id: SENTINEL_HELD_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-482-        status: 'pending_approval',
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-483-        response_text: SENTINEL_HELD_TEXT,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-484-        business_id: LOCATION_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:485:        held: false,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-486-      },
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-487-    ]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-488-    const GET = await importGET();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-489-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-490-    expect(res.status).toBe(200);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-491-    expect(await res.json()).toEqual({
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-492-      response_id: SENTINEL_HELD_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-493-      status: 'pending_approval',
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-494-      response_text: SENTINEL_HELD_TEXT,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-495-    });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-496-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-497-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-498-  it('spells the correlated open-flag EXISTS with status open inside the tenant-scoped response lookup', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:499:    // SQL-text assertion (held-draft.test.ts technique): the heldness
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-500-    // predicate must live IN the response lookup itself — the poller's
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:501:    // spelling of the held-draft.ts semantics.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-502-    seedCompletedOutbox();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-503-    seedTopLevel([
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-504-      {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-505-        id: SENTINEL_HELD_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-506-        status: 'pending_approval',
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-507-        response_text: SENTINEL_HELD_TEXT,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-508-        business_id: LOCATION_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:509:        held: false,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-510-      },
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-511-    ]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-512-    const GET = await importGET();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-513-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-514-    expect(res.status).toBe(200);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-515-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:516:    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-517-    const joinTemplate = (call: unknown[]) => (call[0] as TemplateStringsArray).join('|');
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:518:    const responseLookup = readCalls.find((call) => joinTemplate(call).includes('FROM responses'));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-519-    expect(responseLookup).toBeDefined();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-520-    const text = joinTemplate(responseLookup as unknown[]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-521-    expect(text).toMatch(/EXISTS/);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:522:    expect(text).toMatch(/flagged_responses/);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-523-    // Correlation predicate: an uncorrelated EXISTS (any open flag anywhere
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-524-    // holds every poll) would over-refuse fail-safe but still betray the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-525-    // query's contract — assert the join back to the outer responses row.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-526-    expect(text).toMatch(/f\.response_id\s*=\s*responses\.id/);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-527-    expect(text).toMatch(/f\.status\s*=\s*'open'/);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-528-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-529-
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:530:  it('returns 403 with no heldness signal when the held response belongs to another tenant', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:531:    // Deliberate GREEN characterization locking tenant-before-held ordering:
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:532:    // the tenant re-check must win over any held branching, and the refusal
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:533:    // must carry no heldness signal (neither sentinel nor 'held' vocabulary).
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-534-    seedCompletedOutbox();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-535-    seedTopLevel([
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-536-      {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-537-        id: SENTINEL_HELD_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-538-        status: 'pending_approval',
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-539-        response_text: SENTINEL_HELD_TEXT,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-540-        business_id: OTHER_LOCATION_ID,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:541:        held: true,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-542-      },
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-543-    ]);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-544-    const GET = await importGET();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-545-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-546-    expect(res.status).toBe(403);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-547-    const body = await res.json();
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-548-    const serialized = JSON.stringify(body);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-549-    expect(serialized).not.toContain(SENTINEL_HELD_ID);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-550-    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:551:    expect(serialized).not.toContain('held');
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-552-    expect(body).toEqual({ error: 'forbidden' });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-553-  });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts-554-});
--
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-16-import { QUEUE_NAMES } from '@/lib/shared/queue-names';
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-17-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-18-// ── Hoisted shared state ─────────────────────────────────────────────────────
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-19-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-20-const {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-21-  mockRequireRole,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-22-  mockGetRequestScope,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-23-  ownerQueue,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:24:  ownerCalls,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-25-  readQueue,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:26:  readCalls,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-27-  sqlProxy,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-28-  sqlReadProxy,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-29-} = vi.hoisted(() => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-30-  const mockRequireRole = vi.fn();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-31-  const mockGetRequestScope = vi.fn();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-32-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-33-  const ownerQueue: unknown[][] = [];
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:34:  const ownerCalls: { text: string; values: unknown[] }[] = [];
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-35-  const readQueue: unknown[][] = [];
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:36:  const readCalls: { text: string; values: unknown[] }[] = [];
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-37-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-38-  // sql (write pool): only the `statusArraySql` fragment binding survives here.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-39-  // This handler writes nothing and is polled every ~1.5s, so every QUERY —
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-40-  // including the tenant-ownership proof — runs on the read bulkhead below.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-41-  const sqlMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:42:    ownerCalls.push({ text: strings.join('?'), values });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-43-    return Promise.resolve(ownerQueue.shift() ?? []);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-44-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-45-  const sqlProxy = new Proxy(sqlMock, {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-46-    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-47-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-48-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-49-  // sqlRead (read bulkhead): the tenant proof, the draft lookup, the outbox lookup.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-50-  const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:51:    readCalls.push({ text: strings.join('?'), values });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-52-    return Promise.resolve(readQueue.shift() ?? []);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-53-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-54-  const sqlReadProxy = new Proxy(sqlReadMock, {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-55-    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-56-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-57-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-58-  return {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-59-    mockRequireRole,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-60-    mockGetRequestScope,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-61-    ownerQueue,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:62:    ownerCalls,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-63-    readQueue,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:64:    readCalls,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-65-    sqlProxy,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-66-    sqlReadProxy,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-67-  };
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-68-});
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-69-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-70-vi.mock('@/lib/db/auth', () => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-71-  class AuthError extends Error {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-72-    constructor(message: string, public readonly statusCode: number) {
--
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-125-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-126-function seedRead(...rowsets: unknown[][]): void {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-127-  readQueue.push(...rowsets);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-128-}
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-129-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-130-beforeEach(() => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-131-  vi.clearAllMocks();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-132-  ownerQueue.length = 0;
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:133:  ownerCalls.length = 0;
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-134-  readQueue.length = 0;
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:135:  readCalls.length = 0;
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-136-  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-137-  mockRequireRole.mockResolvedValue({
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-138-    id: 'user-1',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-139-    name: 'Owner',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-140-    email: 'owner@test.com',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-141-    role: 'owner',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-142-    accountId: ACCOUNT_ID,
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-143-  });
--
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-157-    const GET = await importGET();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-158-    const res = await GET(makeRequest(), routeParams);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-159-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-160-    expect(res.status).toBe(404);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-161-    expect((await res.json()).error).toBe('review_not_found');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-162-    // Tenant proof runs FIRST: a caller can never observe another account's
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-163-    // generation status or draft text, not even as a timing difference. It is
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-164-    // the ONLY query issued — nothing reached `responses` or `job_outbox`.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:165:    expect(readCalls).toHaveLength(1);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:166:    expect(readCalls[0]!.text).toMatch(/b\.account_id\s*=/i);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:167:    expect(readCalls[0]!.text).toMatch(/archived_at\s+IS\s+NULL/i);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:168:    expect(readCalls.some((call) => /FROM\s+responses/i.test(call.text))).toBe(false);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:169:    expect(readCalls.some((call) => /job_outbox/i.test(call.text))).toBe(false);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-170-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-171-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-172-  it('GET draft-status returns generating, ready, failed, and idle from the authoritative review state', async () => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-173-    const GET = await importGET();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-174-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:175:    // ready — a live non-terminal response, not held.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-176-    seedOwned();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:177:    seedRead([{ id: 'resp-1', status: 'pending_approval', response_text: 'Draft text', held: false }]);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-178-    const ready = await GET(makeRequest(), routeParams);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-179-    expect(ready.status).toBe(200);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-180-    expect(await ready.json()).toEqual({
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-181-      status: 'ready',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-182-      response_id: 'resp-1',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-183-      response_text: 'Draft text',
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-184-    });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-185-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-186-    // generating — no draft yet, outbox row in flight.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-187-    seedOwned();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-188-    seedRead([], [{ status: 'pending', last_error: null }]);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-189-    const generating = await GET(makeRequest(), routeParams);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-190-    expect((await generating.json()).status).toBe('generating');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:191:    expect(readCalls.some((call) => call.values.includes(QUEUE_NAMES.GENERATE_RESPONSE))).toBe(true);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-192-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-193-    // failed — terminal-but-not-completed outbox row surfaces last_error.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-194-    seedOwned();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-195-    seedRead([], [{ status: 'failed', last_error: 'llm_terminal' }]);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-196-    const failed = await GET(makeRequest(), routeParams);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-197-    expect(await failed.json()).toEqual({ status: 'failed', error: 'llm_terminal' });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-198-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-199-    // idle — nothing in flight and no draft. The poller must stop.
--
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-204-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-205-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-206-  it('GET draft-status resumes a draft in another active location owned by the same account regardless of current-location cookie', async () => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-207-    // The INTENDED authorization model (F4): same-account sibling-location
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-208-    // access is correct, not a leak — only cross-account is a leak. The Reviews
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-209-    // list row carries the reviewId, so a refresh resumes the poll even when the
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-210-    // rw_location_scope cookie points at a different location.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-211-    seedOwned([{ business_id: ALT_LOCATION_ID }]);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:212:    seedRead([{ id: 'resp-alt', status: 'pending_approval', response_text: 'Alt draft', held: false }]);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-213-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-214-    const GET = await importGET();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-215-    const res = await GET(makeRequest(LOCATION_ID), routeParams);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-216-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-217-    expect(res.status).toBe(200);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-218-    const body = await res.json();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-219-    expect(body.status).toBe('ready');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-220-    expect(body.response_id).toBe('resp-alt');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-221-    // Account-scoped, never cookie-scoped.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-222-    expect(mockGetRequestScope).not.toHaveBeenCalled();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:223:    expect(readCalls.some((call) => call.values.includes(ALT_LOCATION_ID))).toBe(true);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-224-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-225-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:226:  it('GET draft-status never returns response_text or ready for a moderation-held response', async () => {
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-227-    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:228:    // pending_approval with an OPEN flagged_responses row. Returning it as
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:229:    // `ready` would hand the owner held text plus an `Approve & post` button —
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:230:    // the exact release path src/lib/moderation/held-draft.ts exists to block.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:231:    // The `held` flag is SELECTed, not filtered (D6/D9): filtering would make
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:232:    // this route report `idle` for "no draft" and "held draft" alike.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-233-    seedOwned();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:234:    seedRead([{ id: 'resp-held', status: 'pending_approval', response_text: 'Held text', held: true }]);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-235-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-236-    const GET = await importGET();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-237-    const res = await GET(makeRequest(), routeParams);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-238-
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-239-    expect(res.status).toBe(200);
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-240-    const body = await res.json();
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-241-    expect(body.status).toBe('idle');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-242-    expect(body.status).not.toBe('ready');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-243-    expect(body).not.toHaveProperty('response_text');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-244-    expect(JSON.stringify(body)).not.toContain('Held text');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:245:    // The hold must be read from flagged_responses, not inferred. Read call 0
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-246-    // is the tenant proof; call 1 is the draft lookup that carries the predicate.
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:247:    expect(readCalls[1]!.text).toContain('flagged_responses');
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-248-  });
src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-249-});
--
src/lib/dashboard/__tests__/aggregate-queries.test.ts-145-    expect(b.latestBrief).toEqual({ text: 'Weekly B', type: 'weekly', periodLabel: 'Week of 2026-06-30' });
src/lib/dashboard/__tests__/aggregate-queries.test.ts-146-    expect(b.recentReviewCount).toBe(3); // LEAST(3, 10)
src/lib/dashboard/__tests__/aggregate-queries.test.ts-147-    expect(b.pendingApprovalCount).toBe(13);
src/lib/dashboard/__tests__/aggregate-queries.test.ts-148-  });
src/lib/dashboard/__tests__/aggregate-queries.test.ts-149-
src/lib/dashboard/__tests__/aggregate-queries.test.ts-150-  it('scopes every query by account_id (tenant isolation)', async () => {
src/lib/dashboard/__tests__/aggregate-queries.test.ts-151-    await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-152-
src/lib/dashboard/__tests__/aggregate-queries.test.ts:153:    expect(harness.sqlCalls).toHaveLength(8);
src/lib/dashboard/__tests__/aggregate-queries.test.ts-154-    for (const call of harness.sqlCalls) {
src/lib/dashboard/__tests__/aggregate-queries.test.ts-155-      expect(call.text).toContain('account_id');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-156-      expect(call.values).toContain('acc-1');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-157-    }
src/lib/dashboard/__tests__/aggregate-queries.test.ts-158-  });
src/lib/dashboard/__tests__/aggregate-queries.test.ts-159-});
src/lib/dashboard/__tests__/aggregate-queries.test.ts-160-
src/lib/dashboard/__tests__/aggregate-queries.test.ts-161-describe('fetchPerLocationAggregateSlices — tenant/anchor gating', () => {
--
src/lib/dashboard/__tests__/aggregate-queries.test.ts-253-    expect(counts.get('loc-A')).toBe(25);
src/lib/dashboard/__tests__/aggregate-queries.test.ts-254-    expect(counts.get('loc-B')).toBe(13);
src/lib/dashboard/__tests__/aggregate-queries.test.ts-255-    expect(counts.get('loc-absent')).toBeUndefined();
src/lib/dashboard/__tests__/aggregate-queries.test.ts-256-
src/lib/dashboard/__tests__/aggregate-queries.test.ts-257-    const call = harness.sqlCalls[0]!;
src/lib/dashboard/__tests__/aggregate-queries.test.ts-258-    expect(call.text).toContain('account_id');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-259-    expect(call.text).toContain('GROUP BY resp.business_id');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-260-    expect(call.text).toContain("resp.status = 'pending_approval'");
src/lib/dashboard/__tests__/aggregate-queries.test.ts:261:    expect(call.text).toContain('flagged_responses');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-262-    expect(call.values).toContain('acc-1');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-263-  });
src/lib/dashboard/__tests__/aggregate-queries.test.ts-264-});
src/lib/dashboard/__tests__/aggregate-queries.test.ts-265-
src/lib/dashboard/__tests__/aggregate-queries.test.ts-266-// Type-level guard: the exported slice shape stays in sync with what the service
src/lib/dashboard/__tests__/aggregate-queries.test.ts-267-// consumes (compile-time only; keeps the contract honest for the rewire).
src/lib/dashboard/__tests__/aggregate-queries.test.ts-268-const _sliceShape: PerLocationAggregateSlice | undefined = undefined;
src/lib/dashboard/__tests__/aggregate-queries.test.ts-269-void _sliceShape;
--
src/lib/dashboard/__tests__/aggregate-service.test.ts-216-        location_id: locationId,
src/lib/dashboard/__tests__/aggregate-service.test.ts-217-        location_name: locationId === 'loc-1' ? 'Downtown Cafe' : 'Westside Bakery',
src/lib/dashboard/__tests__/aggregate-service.test.ts-218-        location_display_label: locationId === 'loc-1' ? 'Downtown' : null,
src/lib/dashboard/__tests__/aggregate-service.test.ts-219-      })),
src/lib/dashboard/__tests__/aggregate-service.test.ts-220-    );
src/lib/dashboard/__tests__/aggregate-service.test.ts-221-
src/lib/dashboard/__tests__/aggregate-service.test.ts-222-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts-223-
src/lib/dashboard/__tests__/aggregate-service.test.ts:224:    expect(result.recentReviews).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-service.test.ts-225-    for (const review of result.recentReviews) {
src/lib/dashboard/__tests__/aggregate-service.test.ts-226-      expect(review.autoPostScheduledAt).toBe('2026-07-13T18:00:00.000Z');
src/lib/dashboard/__tests__/aggregate-service.test.ts-227-      expect(review.escalation).toEqual({ id: 'escalation-open-1', status: 'escalated', severity: 'high' });
src/lib/dashboard/__tests__/aggregate-service.test.ts-228-    }
src/lib/dashboard/__tests__/aggregate-service.test.ts-229-    expect(result.recentReviews.map((r) => r.locationDisplayName).sort()).toEqual(['Downtown', 'Westside Bakery']);
src/lib/dashboard/__tests__/aggregate-service.test.ts-230-  });
src/lib/dashboard/__tests__/aggregate-service.test.ts-231-});
src/lib/dashboard/__tests__/aggregate-service.test.ts-232-
--
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-124-  it('degrades a failed account billing query to defaults and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-125-    pushDashboardQueries({ billing: preHandledRejection(new Error('billing row timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-126-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-127-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-128-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-129-    // Defaults locations_included=1, locations_paid=0 → only the first
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-130-    // location is billing-confirmed; the second flags billingPending.
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-131-    expect(result.locationKpis.map((k) => k.billingPending)).toEqual([false, true]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:132:    expect(result.locationKpis).toHaveLength(2); // slices unaffected
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-133-    expectDegradationReported('accountBillingRows');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-134-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-135-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-136-  it('degrades a failed account-wide recent-reviews feed to an empty feed and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-137-    pushDashboardQueries({ recent: preHandledRejection(new Error('recent reviews timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-138-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-139-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-140-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-141-    expect(result.recentReviews).toEqual([]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:142:    expect(result.locationKpis).toHaveLength(2); // slices unaffected
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-143-    expect(result.valueSummary.currentResponseRate).toBe(80); // 16/20 windowed
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-144-    expectDegradationReported('accountRecentReviews');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-145-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-146-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-147-  it('keeps the locations-list query fatal', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-148-    const { getLocationsForAccount } = await import('@/lib/locations/repo');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-149-    vi.mocked(getLocationsForAccount).mockRejectedValueOnce(
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-150-      new Error('locations lookup down'),
--
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-168-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-169-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-170-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-171-    expect(result.valueSummary).toMatchObject({
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-172-      totalReviewsHandled: 0,
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-173-      totalTimeSavedMinutes: 0,
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-174-      currentResponseRate: 0,
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-175-    });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:176:    expect(result.locationKpis).toHaveLength(2); // dashboard still renders
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-177-    // Other widgets survive: pending counts came from their own read.
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-178-    expect(result.locationKpis.map((k) => k.pendingApprovalCount)).toEqual([3, 1]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-179-    expectDegradationReported('sliceReviewCounters');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-180-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-181-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-182-  it('degrades a failed velocity read to empty velocity and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-183-    pushDashboardQueries({ velocity: preHandledRejection(new Error('velocity timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-184-
--
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-191-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-192-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-193-  it('degrades a failed rating-breakdown read to a zero breakdown and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-194-    pushDashboardQueries({ rating: preHandledRejection(new Error('rating timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-195-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-196-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-197-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-198-    expect(result.ratingBreakdown.total).toBe(0);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:199:    expect(result.locationKpis).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-200-    expectDegradationReported('sliceRatingBreakdown');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-201-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-202-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-203-  it('degrades a failed ranking read to null ranking and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-204-    pushDashboardQueries({ ranking: preHandledRejection(new Error('ranking timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-205-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-206-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-207-
--
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-215-    pushDashboardQueries({
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-216-      monthly: preHandledRejection(new Error('monthly briefs timeout')),
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-217-      weekly: preHandledRejection(new Error('weekly briefs timeout')),
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-218-    });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-219-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-220-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-221-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-222-    expect(result.perLocationBriefs).toEqual([]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:223:    expect(result.locationKpis).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-224-    expectDegradationReported('sliceMonthlyBriefs');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-225-    expectDegradationReported('sliceWeeklyBriefs');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-226-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-227-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-228-  it('degrades a failed pending-approval-counts read to zero counts and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-229-    pushDashboardQueries({ pending: preHandledRejection(new Error('pending counts timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-230-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-231-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
--
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-238-  it('is unchanged when everything is healthy', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-239-    pushDashboardQueries();
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-240-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-241-    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-242-
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-243-    expect(result.valueSummary.currentResponseRate).toBe(80); // 16/20 windowed
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-244-    expect(result.valueSummary.totalReviewsHandled).toBe(20);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-245-    expect(result.valueSummary.baselineResponseRate).toBe(30); // primary loc-1
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:246:    expect(result.locationKpis).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-247-    expect(result.locationKpis.map((k) => k.billingPending)).toEqual([false, false]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-248-    expect(result.locationKpis.map((k) => k.pendingApprovalCount)).toEqual([3, 1]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-249-    expect(result.ratingBreakdown.total).toBe(2);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:250:    expect(result.perLocationBriefs).toHaveLength(1);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-251-    expect(mockReportCaughtError).not.toHaveBeenCalled();
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-252-  });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts-253-});
--
src/lib/dashboard/__tests__/service.cache.test.ts-65-
src/lib/dashboard/__tests__/service.cache.test.ts-66-  it('HIT: returns the cached payload and issues ZERO SQL', async () => {
src/lib/dashboard/__tests__/service.cache.test.ts-67-    const payload = { scope: 'active', valueSummary: { totalReviewsHandled: 7 } };
src/lib/dashboard/__tests__/service.cache.test.ts-68-    getMock.mockResolvedValue(JSON.stringify(payload));
src/lib/dashboard/__tests__/service.cache.test.ts-69-
src/lib/dashboard/__tests__/service.cache.test.ts-70-    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts-71-
src/lib/dashboard/__tests__/service.cache.test.ts-72-    expect(result).toEqual(payload);
src/lib/dashboard/__tests__/service.cache.test.ts:73:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts-74-    expect(setMock).not.toHaveBeenCalled();
src/lib/dashboard/__tests__/service.cache.test.ts-75-  });
src/lib/dashboard/__tests__/service.cache.test.ts-76-
src/lib/dashboard/__tests__/service.cache.test.ts-77-  it('MISS: computes then writes the payload with the expected key and 45s TTL', async () => {
src/lib/dashboard/__tests__/service.cache.test.ts-78-    seedDashboardQueries();
src/lib/dashboard/__tests__/service.cache.test.ts-79-
src/lib/dashboard/__tests__/service.cache.test.ts-80-    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts-81-
--
src/lib/dashboard/__tests__/service.cache.test.ts-178-    const freshResult = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts-179-    const stored = setMock.mock.calls[0]?.[1] as string;
src/lib/dashboard/__tests__/service.cache.test.ts-180-
src/lib/dashboard/__tests__/service.cache.test.ts-181-    // Simulate the subsequent HIT: the wrapper reads `stored` and JSON.parses it.
src/lib/dashboard/__tests__/service.cache.test.ts-182-    getMock.mockResolvedValue(stored);
src/lib/dashboard/__tests__/service.cache.test.ts-183-    harness.resetMockSql();
src/lib/dashboard/__tests__/service.cache.test.ts-184-    const cachedReadResult = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts-185-
src/lib/dashboard/__tests__/service.cache.test.ts:186:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts-187-    expect(JSON.stringify(cachedReadResult)).toBe(JSON.stringify(freshResult));
src/lib/dashboard/__tests__/service.cache.test.ts-188-  });
src/lib/dashboard/__tests__/service.cache.test.ts-189-});
--
src/lib/dashboard/__tests__/service.feed-projection.test.ts-66-    expect(query).toBeDefined();
src/lib/dashboard/__tests__/service.feed-projection.test.ts-67-    const responseLateral = lateralBody(query!.text, 'resp');
src/lib/dashboard/__tests__/service.feed-projection.test.ts-68-    expect(query!.text).toContain('resp.approval_method');
src/lib/dashboard/__tests__/service.feed-projection.test.ts-69-    expect(query!.text).toContain('resp.auto_post_scheduled_at');
src/lib/dashboard/__tests__/service.feed-projection.test.ts-70-    expect(responseLateral).toContain(
src/lib/dashboard/__tests__/service.feed-projection.test.ts-71-      'SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at',
src/lib/dashboard/__tests__/service.feed-projection.test.ts-72-    );
src/lib/dashboard/__tests__/service.feed-projection.test.ts-73-    expect(responseLateral).toContain('ORDER BY version DESC');
src/lib/dashboard/__tests__/service.feed-projection.test.ts:74:    expect(query!.values.filter((value) => value === BUSINESS_ID)).toHaveLength(3);
src/lib/dashboard/__tests__/service.feed-projection.test.ts-75-  });
src/lib/dashboard/__tests__/service.feed-projection.test.ts-76-
src/lib/dashboard/__tests__/service.feed-projection.test.ts-77-  it("uses the open-escalation partial-index predicate verbatim", async () => {
src/lib/dashboard/__tests__/service.feed-projection.test.ts-78-    seedDashboardQueries();
src/lib/dashboard/__tests__/service.feed-projection.test.ts-79-
src/lib/dashboard/__tests__/service.feed-projection.test.ts-80-    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.feed-projection.test.ts-81-
src/lib/dashboard/__tests__/service.feed-projection.test.ts-82-    const query = recentReviewsQuery();
--
src/lib/dashboard/__tests__/aggregate-types.test.ts-121-      locationId: 'loc-1',
src/lib/dashboard/__tests__/aggregate-types.test.ts-122-      displayName: 'Downtown Cafe',
src/lib/dashboard/__tests__/aggregate-types.test.ts-123-      velocity: [
src/lib/dashboard/__tests__/aggregate-types.test.ts-124-        { weekStart: '2026-04-27', count: 3 },
src/lib/dashboard/__tests__/aggregate-types.test.ts-125-        { weekStart: '2026-05-04', count: 5 },
src/lib/dashboard/__tests__/aggregate-types.test.ts-126-      ],
src/lib/dashboard/__tests__/aggregate-types.test.ts-127-    };
src/lib/dashboard/__tests__/aggregate-types.test.ts-128-
src/lib/dashboard/__tests__/aggregate-types.test.ts:129:    expect(vel.velocity).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-types.test.ts-130-    expect(vel.velocity[1]!.count).toBe(5);
src/lib/dashboard/__tests__/aggregate-types.test.ts-131-  });
src/lib/dashboard/__tests__/aggregate-types.test.ts-132-
src/lib/dashboard/__tests__/aggregate-types.test.ts-133-  it('PerLocationRanking has ranking per location', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts-134-    const rank: PerLocationRanking = {
src/lib/dashboard/__tests__/aggregate-types.test.ts-135-      locationId: 'loc-1',
src/lib/dashboard/__tests__/aggregate-types.test.ts-136-      displayName: 'Downtown Cafe',
src/lib/dashboard/__tests__/aggregate-types.test.ts-137-      ranking: [
--
src/lib/dashboard/__tests__/aggregate-types.test.ts-194-      recentReviews: [],
src/lib/dashboard/__tests__/aggregate-types.test.ts-195-      perLocationBriefs: [],
src/lib/dashboard/__tests__/aggregate-types.test.ts-196-      locationKpis: [],
src/lib/dashboard/__tests__/aggregate-types.test.ts-197-      activeLocationCount: 0,
src/lib/dashboard/__tests__/aggregate-types.test.ts-198-    };
src/lib/dashboard/__tests__/aggregate-types.test.ts-199-
src/lib/dashboard/__tests__/aggregate-types.test.ts-200-    expect(empty.activeLocationCount).toBe(0);
src/lib/dashboard/__tests__/aggregate-types.test.ts-201-    expect(empty.valueSummary.totalReviewsHandled).toBe(0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:202:    expect(empty.recentReviews).toHaveLength(0);
src/lib/dashboard/__tests__/aggregate-types.test.ts-203-  });
src/lib/dashboard/__tests__/aggregate-types.test.ts-204-});

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg -n -C 6 \"flagged_responses|held|readCalls|ownerCalls\" 'src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts'; rg -n -C 6 \"held|flagged_responses|topLevelQueue|sqlReadMock\" src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts; rg -n -C 6 \"flagged_responses|NOT EXISTS|responseLateral\" src/lib/dashboard/__tests__/*.test.ts; rg -n -C 6 \"flagged_responses|fr\\.id IS NULL|LEFT JOIN\" src/lib/agents/__tests__/read.test.ts" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 exited 1 in 0ms:
18-// ── Hoisted shared state ─────────────────────────────────────────────────────
19-
20-const {
21-  mockRequireRole,
22-  mockGetRequestScope,
23-  ownerQueue,
24:  ownerCalls,
25-  readQueue,
26:  readCalls,
27-  sqlProxy,
28-  sqlReadProxy,
29-} = vi.hoisted(() => {
30-  const mockRequireRole = vi.fn();
31-  const mockGetRequestScope = vi.fn();
32-
33-  const ownerQueue: unknown[][] = [];
34:  const ownerCalls: { text: string; values: unknown[] }[] = [];
35-  const readQueue: unknown[][] = [];
36:  const readCalls: { text: string; values: unknown[] }[] = [];
37-
38-  // sql (write pool): only the `statusArraySql` fragment binding survives here.
39-  // This handler writes nothing and is polled every ~1.5s, so every QUERY —
40-  // including the tenant-ownership proof — runs on the read bulkhead below.
41-  const sqlMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
42:    ownerCalls.push({ text: strings.join('?'), values });
43-    return Promise.resolve(ownerQueue.shift() ?? []);
44-  });
45-  const sqlProxy = new Proxy(sqlMock, {
46-    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
47-  });
48-
49-  // sqlRead (read bulkhead): the tenant proof, the draft lookup, the outbox lookup.
50-  const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
51:    readCalls.push({ text: strings.join('?'), values });
52-    return Promise.resolve(readQueue.shift() ?? []);
53-  });
54-  const sqlReadProxy = new Proxy(sqlReadMock, {
55-    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args),
56-  });
57-
58-  return {
59-    mockRequireRole,
60-    mockGetRequestScope,
61-    ownerQueue,
62:    ownerCalls,
63-    readQueue,
64:    readCalls,
65-    sqlProxy,
66-    sqlReadProxy,
67-  };
68-});
69-
70-vi.mock('@/lib/db/auth', () => {
--
127-  readQueue.push(...rowsets);
128-}
129-
130-beforeEach(() => {
131-  vi.clearAllMocks();
132-  ownerQueue.length = 0;
133:  ownerCalls.length = 0;
134-  readQueue.length = 0;
135:  readCalls.length = 0;
136-  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
137-  mockRequireRole.mockResolvedValue({
138-    id: 'user-1',
139-    name: 'Owner',
140-    email: 'owner@test.com',
141-    role: 'owner',
--
159-
160-    expect(res.status).toBe(404);
161-    expect((await res.json()).error).toBe('review_not_found');
162-    // Tenant proof runs FIRST: a caller can never observe another account's
163-    // generation status or draft text, not even as a timing difference. It is
164-    // the ONLY query issued — nothing reached `responses` or `job_outbox`.
165:    expect(readCalls).toHaveLength(1);
166:    expect(readCalls[0]!.text).toMatch(/b\.account_id\s*=/i);
167:    expect(readCalls[0]!.text).toMatch(/archived_at\s+IS\s+NULL/i);
168:    expect(readCalls.some((call) => /FROM\s+responses/i.test(call.text))).toBe(false);
169:    expect(readCalls.some((call) => /job_outbox/i.test(call.text))).toBe(false);
170-  });
171-
172-  it('GET draft-status returns generating, ready, failed, and idle from the authoritative review state', async () => {
173-    const GET = await importGET();
174-
175:    // ready — a live non-terminal response, not held.
176-    seedOwned();
177:    seedRead([{ id: 'resp-1', status: 'pending_approval', response_text: 'Draft text', held: false }]);
178-    const ready = await GET(makeRequest(), routeParams);
179-    expect(ready.status).toBe(200);
180-    expect(await ready.json()).toEqual({
181-      status: 'ready',
182-      response_id: 'resp-1',
183-      response_text: 'Draft text',
--
185-
186-    // generating — no draft yet, outbox row in flight.
187-    seedOwned();
188-    seedRead([], [{ status: 'pending', last_error: null }]);
189-    const generating = await GET(makeRequest(), routeParams);
190-    expect((await generating.json()).status).toBe('generating');
191:    expect(readCalls.some((call) => call.values.includes(QUEUE_NAMES.GENERATE_RESPONSE))).toBe(true);
192-
193-    // failed — terminal-but-not-completed outbox row surfaces last_error.
194-    seedOwned();
195-    seedRead([], [{ status: 'failed', last_error: 'llm_terminal' }]);
196-    const failed = await GET(makeRequest(), routeParams);
197-    expect(await failed.json()).toEqual({ status: 'failed', error: 'llm_terminal' });
--
206-  it('GET draft-status resumes a draft in another active location owned by the same account regardless of current-location cookie', async () => {
207-    // The INTENDED authorization model (F4): same-account sibling-location
208-    // access is correct, not a leak — only cross-account is a leak. The Reviews
209-    // list row carries the reviewId, so a refresh resumes the poll even when the
210-    // rw_location_scope cookie points at a different location.
211-    seedOwned([{ business_id: ALT_LOCATION_ID }]);
212:    seedRead([{ id: 'resp-alt', status: 'pending_approval', response_text: 'Alt draft', held: false }]);
213-
214-    const GET = await importGET();
215-    const res = await GET(makeRequest(LOCATION_ID), routeParams);
216-
217-    expect(res.status).toBe(200);
218-    const body = await res.json();
219-    expect(body.status).toBe('ready');
220-    expect(body.response_id).toBe('resp-alt');
221-    // Account-scoped, never cookie-scoped.
222-    expect(mockGetRequestScope).not.toHaveBeenCalled();
223:    expect(readCalls.some((call) => call.values.includes(ALT_LOCATION_ID))).toBe(true);
224-  });
225-
226:  it('GET draft-status never returns response_text or ready for a moderation-held response', async () => {
227-    // F5 / invariant #4: a high-severity moderation flag leaves the draft at
228:    // pending_approval with an OPEN flagged_responses row. Returning it as
229:    // `ready` would hand the owner held text plus an `Approve & post` button —
230:    // the exact release path src/lib/moderation/held-draft.ts exists to block.
231:    // The `held` flag is SELECTed, not filtered (D6/D9): filtering would make
232:    // this route report `idle` for "no draft" and "held draft" alike.
233-    seedOwned();
234:    seedRead([{ id: 'resp-held', status: 'pending_approval', response_text: 'Held text', held: true }]);
235-
236-    const GET = await importGET();
237-    const res = await GET(makeRequest(), routeParams);
238-
239-    expect(res.status).toBe(200);
240-    const body = await res.json();
241-    expect(body.status).toBe('idle');
242-    expect(body.status).not.toBe('ready');
243-    expect(body).not.toHaveProperty('response_text');
244-    expect(JSON.stringify(body)).not.toContain('Held text');
245:    // The hold must be read from flagged_responses, not inferred. Read call 0
246-    // is the tenant proof; call 1 is the draft lookup that carries the predicate.
247:    expect(readCalls[1]!.text).toContain('flagged_responses');
248-  });
249-});
4-// ── Hoisted shared state ────────────────────────────────────────────
5-
6-const {
7-  mockRequireRole,
8-  mockGetRequestScope,
9-  accountQueue,
10:  topLevelQueue,
11-  sqlProxy,
12-  sqlReadProxy,
13-} = vi.hoisted(() => {
14-  const mockRequireRole = vi.fn();
15-  const mockGetRequestScope = vi.fn();
16-
17-  const accountQueue: unknown[][] = [];
18:  const topLevelQueue: unknown[][] = [];
19-
20-  // sql (write pool): the resolveOwnerScope auth preamble stays on it — the
21-  // subscription-gate SELECT it fires internally (plan #477 Task 1 wiring
22-  // decision: shared auth helper is never threaded onto sqlRead).
23-  const sqlMock = vi.fn(async (strings?: TemplateStringsArray) => {
24-    const text = Array.isArray(strings) ? strings.join('') : String(strings ?? '');
--
32-  const sqlProxy = new Proxy(sqlMock, {
33-    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
34-  });
35-
36-  // sqlRead (read bulkhead): the route-body reads (job_outbox lookup + the
37-  // completed-job response lookup) moved off write `sql` onto it (#477 Task 1).
38:  const sqlReadMock = vi.fn(async () => topLevelQueue.shift() ?? []);
39:  const sqlReadProxy = new Proxy(sqlReadMock, {
40-    apply: (target, _this, args) => Reflect.apply(target as never, _this, args),
41-  });
42-
43-  return {
44-    mockRequireRole,
45-    mockGetRequestScope,
46-    accountQueue,
47:    topLevelQueue,
48-    sqlProxy,
49-    sqlReadProxy,
50-  };
51-});
52-
53-// ── Mocks ───────────────────────────────────────────────────────────
--
112-    headers['Cookie'] = `rw_location_scope=${opts.locationScopeCookie}`;
113-  }
114-  return new NextRequest(url, { method: 'GET', headers });
115-}
116-
117-function seedTopLevel(...rowsets: unknown[][]) {
118:  topLevelQueue.push(...rowsets);
119-}
120-
121-function seedAccountRows(rows: unknown[]) {
122-  accountQueue.push(rows);
123-}
124-
125-beforeEach(() => {
126-  vi.clearAllMocks();
127-  accountQueue.length = 0;
128:  topLevelQueue.length = 0;
129-  process.env.EDIT_REPLIES_ENABLED = 'true';
130-  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
131-  // Default: requireRole succeeds; getRequestScope resolves to primary location.
132-  mockRequireRole.mockResolvedValue(ownerUser());
133-  mockGetRequestScope.mockResolvedValue({ accountId: ACCOUNT_ID, currentLocationId: LOCATION_ID });
134-});
--
420-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID, locationScopeCookie: ALT_LOCATION_ID }));
421-    expect(res.status).toBe(403);
422-    expect(await res.json()).toEqual({ error: 'forbidden' });
423-  });
424-});
425-
426:// ── #726 moderation-held draft gate ─────────────────────────────────
427-//
428:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
429-// button" — the poller must answer with the owner-visible refusal vocabulary
430:// `held_for_review` and never the draft text. src/lib/moderation/held-draft.ts
431:// is the semantic owner of "is this draft held"; the read-only poller holds no
432-// tx, so it spells the same predicate as a correlated EXISTS on
433:// flagged_responses inside the tenant-scoped response lookup.
434-
435:// Unique sentinels: heldness refusals assert these appear NOWHERE in the
436-// serialized body — a leak of either is an invariant #4 violation.
437-const SENTINEL_HELD_ID = 'SENTINEL_HELD_ID_84c1f0d2e6b34c5f';
438-const SENTINEL_HELD_TEXT = 'SENTINEL_HELD_TEXT_9b3e5a710d2c4e8a';
439-
440-function seedCompletedOutbox() {
441-  seedTopLevel([
--
445-      last_error: null,
446-      aggregate_id: REVIEW_ID,
447-    },
448-  ]);
449-}
450-
451:describe('GET /api/dashboard/past-replies/draft-status — moderation-held draft gate (#726)', () => {
452:  it('returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag', async () => {
453-    seedCompletedOutbox();
454-    // Response row resolves for the caller's location but carries an OPEN flag.
455-    seedTopLevel([
456-      {
457-        id: SENTINEL_HELD_ID,
458-        status: 'pending_approval',
459-        response_text: SENTINEL_HELD_TEXT,
460-        business_id: LOCATION_ID,
461:        held: true,
462-      },
463-    ]);
464-    const GET = await importGET();
465-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
466-    expect(res.status).toBe(200);
467-    const body = await res.json();
468-    const serialized = JSON.stringify(body);
469-    expect(serialized).not.toContain(SENTINEL_HELD_ID);
470-    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
471-    // Exactly the safe shape — nothing but the refusal vocabulary.
472:    expect(body).toEqual({ status: 'failed', error: 'held_for_review' });
473-  });
474-
475-  it("returns the draft text when the resolved response's moderation flag is closed", async () => {
476:    // Deliberate GREEN characterization: a closed flag (held: false) is the
477-    // release path — the draft text surfaces exactly as today.
478-    seedCompletedOutbox();
479-    seedTopLevel([
480-      {
481-        id: SENTINEL_HELD_ID,
482-        status: 'pending_approval',
483-        response_text: SENTINEL_HELD_TEXT,
484-        business_id: LOCATION_ID,
485:        held: false,
486-      },
487-    ]);
488-    const GET = await importGET();
489-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
490-    expect(res.status).toBe(200);
491-    expect(await res.json()).toEqual({
--
493-      status: 'pending_approval',
494-      response_text: SENTINEL_HELD_TEXT,
495-    });
496-  });
497-
498-  it('spells the correlated open-flag EXISTS with status open inside the tenant-scoped response lookup', async () => {
499:    // SQL-text assertion (held-draft.test.ts technique): the heldness
500-    // predicate must live IN the response lookup itself — the poller's
501:    // spelling of the held-draft.ts semantics.
502-    seedCompletedOutbox();
503-    seedTopLevel([
504-      {
505-        id: SENTINEL_HELD_ID,
506-        status: 'pending_approval',
507-        response_text: SENTINEL_HELD_TEXT,
508-        business_id: LOCATION_ID,
509:        held: false,
510-      },
511-    ]);
512-    const GET = await importGET();
513-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
514-    expect(res.status).toBe(200);
515-
516-    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
517-    const joinTemplate = (call: unknown[]) => (call[0] as TemplateStringsArray).join('|');
518-    const responseLookup = readCalls.find((call) => joinTemplate(call).includes('FROM responses'));
519-    expect(responseLookup).toBeDefined();
520-    const text = joinTemplate(responseLookup as unknown[]);
521-    expect(text).toMatch(/EXISTS/);
522:    expect(text).toMatch(/flagged_responses/);
523-    // Correlation predicate: an uncorrelated EXISTS (any open flag anywhere
524-    // holds every poll) would over-refuse fail-safe but still betray the
525-    // query's contract — assert the join back to the outer responses row.
526-    expect(text).toMatch(/f\.response_id\s*=\s*responses\.id/);
527-    expect(text).toMatch(/f\.status\s*=\s*'open'/);
528-  });
529-
530:  it('returns 403 with no heldness signal when the held response belongs to another tenant', async () => {
531:    // Deliberate GREEN characterization locking tenant-before-held ordering:
532:    // the tenant re-check must win over any held branching, and the refusal
533:    // must carry no heldness signal (neither sentinel nor 'held' vocabulary).
534-    seedCompletedOutbox();
535-    seedTopLevel([
536-      {
537-        id: SENTINEL_HELD_ID,
538-        status: 'pending_approval',
539-        response_text: SENTINEL_HELD_TEXT,
540-        business_id: OTHER_LOCATION_ID,
541:        held: true,
542-      },
543-    ]);
544-    const GET = await importGET();
545-    const res = await GET(makeRequest({ outboxId: OUTBOX_ID }));
546-    expect(res.status).toBe(403);
547-    const body = await res.json();
548-    const serialized = JSON.stringify(body);
549-    expect(serialized).not.toContain(SENTINEL_HELD_ID);
550-    expect(serialized).not.toContain(SENTINEL_HELD_TEXT);
551:    expect(serialized).not.toContain('held');
552-    expect(body).toEqual({ error: 'forbidden' });
553-  });
554-});
src/lib/dashboard/__tests__/aggregate-queries.test.ts-255-    expect(counts.get('loc-absent')).toBeUndefined();
src/lib/dashboard/__tests__/aggregate-queries.test.ts-256-
src/lib/dashboard/__tests__/aggregate-queries.test.ts-257-    const call = harness.sqlCalls[0]!;
src/lib/dashboard/__tests__/aggregate-queries.test.ts-258-    expect(call.text).toContain('account_id');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-259-    expect(call.text).toContain('GROUP BY resp.business_id');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-260-    expect(call.text).toContain("resp.status = 'pending_approval'");
src/lib/dashboard/__tests__/aggregate-queries.test.ts:261:    expect(call.text).toContain('flagged_responses');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-262-    expect(call.values).toContain('acc-1');
src/lib/dashboard/__tests__/aggregate-queries.test.ts-263-  });
src/lib/dashboard/__tests__/aggregate-queries.test.ts-264-});
src/lib/dashboard/__tests__/aggregate-queries.test.ts-265-
src/lib/dashboard/__tests__/aggregate-queries.test.ts-266-// Type-level guard: the exported slice shape stays in sync with what the service
src/lib/dashboard/__tests__/aggregate-queries.test.ts-267-// consumes (compile-time only; keeps the contract honest for the rewire).
--
src/lib/dashboard/__tests__/service.feed-projection.test.ts-61-    seedDashboardQueries();
src/lib/dashboard/__tests__/service.feed-projection.test.ts-62-
src/lib/dashboard/__tests__/service.feed-projection.test.ts-63-    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.feed-projection.test.ts-64-
src/lib/dashboard/__tests__/service.feed-projection.test.ts-65-    const query = recentReviewsQuery();
src/lib/dashboard/__tests__/service.feed-projection.test.ts-66-    expect(query).toBeDefined();
src/lib/dashboard/__tests__/service.feed-projection.test.ts:67:    const responseLateral = lateralBody(query!.text, 'resp');
src/lib/dashboard/__tests__/service.feed-projection.test.ts-68-    expect(query!.text).toContain('resp.approval_method');
src/lib/dashboard/__tests__/service.feed-projection.test.ts-69-    expect(query!.text).toContain('resp.auto_post_scheduled_at');
src/lib/dashboard/__tests__/service.feed-projection.test.ts:70:    expect(responseLateral).toContain(
src/lib/dashboard/__tests__/service.feed-projection.test.ts-71-      'SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at',
src/lib/dashboard/__tests__/service.feed-projection.test.ts-72-    );
src/lib/dashboard/__tests__/service.feed-projection.test.ts:73:    expect(responseLateral).toContain('ORDER BY version DESC');
src/lib/dashboard/__tests__/service.feed-projection.test.ts-74-    expect(query!.values.filter((value) => value === BUSINESS_ID)).toHaveLength(3);
src/lib/dashboard/__tests__/service.feed-projection.test.ts-75-  });
src/lib/dashboard/__tests__/service.feed-projection.test.ts-76-
src/lib/dashboard/__tests__/service.feed-projection.test.ts-77-  it("uses the open-escalation partial-index predicate verbatim", async () => {
src/lib/dashboard/__tests__/service.feed-projection.test.ts-78-    seedDashboardQueries();
src/lib/dashboard/__tests__/service.feed-projection.test.ts-79-

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg -c '"'^    file:'"' scripts/ci/tenant-scope-allowlist.ts; rg -n \"flagged_responses\" src/app/api/admin/flagged/route.ts src/lib/admin/flagged-service.ts src/lib/admin/nav-counts-service.ts worker/background/pollers/health-alert/checks.ts src/lib/account-offboarding/purge-verification.ts worker/jobs/account-offboarding/purge-stages.ts src/lib/account-offboarding/table-disposition.ts worker/jobs/response-generation/persist.ts; rg -n \"fast-check|invariants\" src/lib/reviews/__tests__/sentiment.test.ts; rg -n \"typecheck|postgres\" package.json pnpm-lock.yaml | head -30" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
409
src/lib/account-offboarding/table-disposition.ts:62:  'flagged_responses',
src/lib/account-offboarding/table-disposition.ts:263:    table: 'flagged_responses',
src/lib/admin/nav-counts-service.ts:4:  /** flagged_responses awaiting admin disposition (status = 'open'). */
src/lib/admin/nav-counts-service.ts:20:    sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'`,
src/lib/admin/flagged-service.ts:74:      FROM flagged_responses fr
src/lib/admin/flagged-service.ts:84:      SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'
worker/jobs/response-generation/persist.ts:6:// flagged_responses row and skips the send_notification outbox enqueue) in the
worker/jobs/response-generation/persist.ts:647: * high-severity flag, HOLDS the draft by writing a flagged_responses row. Runs
worker/jobs/response-generation/persist.ts:685:      INSERT INTO flagged_responses (
worker/background/pollers/health-alert/checks.ts:5:// (job_outbox, notification_deliveries, flagged_responses, responses,
worker/background/pollers/health-alert/checks.ts:138:    SELECT COUNT(*)::int AS count FROM flagged_responses WHERE status = 'open'
src/app/api/admin/flagged/route.ts:99:        FROM flagged_responses
src/app/api/admin/flagged/route.ts:109:        UPDATE flagged_responses
worker/jobs/account-offboarding/purge-stages.ts:291:      DELETE FROM flagged_responses
src/lib/account-offboarding/purge-verification.ts:460:    case 'flagged_responses':
src/lib/account-offboarding/purge-verification.ts:466:        FROM flagged_responses
1:import fc from 'fast-check';
42:// Property tests (fast-check): the house style for invariant-level coverage —
45:describe('classifySentiment invariants', () => {
package.json:17:    "typecheck": "tsc --noEmit",
package.json:77:    "postgres": "^3.4.9",
pnpm-lock.yaml:83:      postgres:
pnpm-lock.yaml:1805:  '@supabase/postgrest-js@2.106.2':
pnpm-lock.yaml:4067:  postgres@3.4.9:
pnpm-lock.yaml:6154:  '@supabase/postgrest-js@2.106.2':
pnpm-lock.yaml:6177:      '@supabase/postgrest-js': 2.106.2
pnpm-lock.yaml:8639:  postgres@3.4.9: {}

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'if [ -f .feature/intake.json ]; then cmp -s .feature/intake.json docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json; echo "cmp_exit=$?"; nl -ba .feature/intake.json | sed -n '"'1,90p'; else echo '.feature/intake.json MISSING'; fi; git log --oneline --decorate -5; git diff --stat origin/main...HEAD; git diff --name-only origin/main...HEAD" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
cmp_exit=0
     1	{
     2	  "classification": "high",
     3	  "surface": "mixed",
     4	  "db_touching": true,
     5	  "goal": "Consolidate every owner-facing surfacing spelling of the open-flag predicate onto one composable fragment (openFlagExistsSql) owned by src/lib/moderation/held-draft.ts — the semantic owner of 'is this draft held' — leaving the deliberately-distinct consumers alone with the divergence recorded on the owner module (#725 deliverable, #730 build half).",
     6	  "non_goals": [
     7	    "No change to the 8 deliberately-distinct consumers: admin disposition (/api/admin/flagged), admin queue (flagged-service), admin badge (nav-counts-service), health-alert backlog check, offboarding purge-verification + purge-stages + table-disposition, and the producer (response-generation/persist.ts keeps its module-local FLAGGED_RESPONSE_STATUS_OPEN)",
     8	    "No higher-level read helpers — the shape is fragment + retained hasOpenFlag only (#725 §2)",
     9	    "No behavior change anywhere — every rewrite is semantics-preserving",
    10	    "No new CONTEXT.md glossary term — the divergence note lives as a comment block on the owner module (#725 §3)",
    11	    "No shared helper growing a boolean parameter meaning 'actually a different query' (the failure mode this scoping exists to prevent)",
    12	    "No touch to worker/jobs/publisher/held-flag-gate.ts or the other hasOpenFlag call sites — they are already on the owner"
    13	  ],
    14	  "user_visible_behavior": [
    15	    "None. Held drafts remain projected (SELECTed-not-filtered, D9) on the two draft-status routes and the Reviews list, and remain excluded from dashboard reads, pending counts, and the review timeline — byte-identical result sets"
    16	  ],
    17	  "invariants": [
    18	    "Invariant #4 as structure: a held draft never surfaces its text or an affordance to the owner — projected sites stay SELECTed-not-filtered (D9); filtered sites keep excluding held rows",
    19	    "hasOpenFlag keeps its exact signature and in-tx post-FOR-UPDATE release-gate contract; none of its call sites move",
    20	    "After migration, the read-side 'open' literal is spelled only inside openFlagExistsSql in held-draft.ts",
    21	    "Tenant scoping of every migrated query is unchanged; ALLOWLIST_BASELINE stays 409 — snippet text regenerates in place, no entry adds or removes",
    22	    "The 8 deliberately-distinct consumers keep their own spellings on purpose"
    23	  ],
    24	  "edge_cases": [
    25	    "src/lib/agents/read.ts getReviewTimeline: null-filtered anti-join (LEFT JOIN flagged_responses … AND fr.id IS NULL) rewrites to NOT EXISTS via the fragment — must preserve the timeline row set exactly",
    26	    "src/lib/dashboard/pending-count.ts has TWO spellings (per-business count + account-grouped sibling); both migrate",
    27	    "The fragment's correlated ref must compose in three contexts: qualified column refs (resp.id, resp2.id, responses.id) inside LATERAL/correlated subqueries, and hasOpenFlag's ${responseId}::uuid parameter — ref parameter is a Postgres.js fragment, not a string",
    28	    "scripts/ci/tenant-scope-allowlist.ts keys on verbatim SQL source text — every entry whose sqlSnippet contains a migrated predicate (at least load-replies main query, service.ts, aggregate-service.ts, pending-count, past-replies draft-status) regenerates in the same PR (the feat-719 gate-block trap, #725 note 1)",
    29	    "The stale D6 comments in draft-status/route.ts and load-replies.ts cite '#680 item' for a consolidation #680 never did — they are rewritten as part of the migration",
    30	    "past-replies/draft-status/route.ts (added by #726, after #725's 6-file table was drawn) carries an inline projected EXISTS — it joins the migration set, making it 7 files / 8 inline spellings"
    31	  ],
    32	  "existing_patterns_to_follow": [
    33	    "src/lib/shared/response-status-sql.ts (statusArraySql) — the house pattern for a composable Postgres.js SQL fragment builder, already interpolated by draft-status/route.ts",
    34	    "src/lib/moderation/held-draft.ts contract-header comment style — the divergence note extends it",
    35	    "Postgres.js nested-Query splicing (lab-notes #573/#706 mechanic) — fragments compose into LATERAL/correlated contexts as raw SQL text"
    36	  ],
    37	  "allowed_edit_surface": [
    38	    "src/lib/moderation/held-draft.ts",
    39	    "src/lib/moderation/__tests__/held-draft.test.ts",
    40	    "src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts",
    41	    "src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/**",
    42	    "src/app/api/dashboard/past-replies/draft-status/route.ts",
    43	    "src/app/api/dashboard/past-replies/__tests__/**",
    44	    "src/lib/past-replies/load-replies.ts",
    45	    "src/lib/past-replies/__tests__/**",
    46	    "src/lib/dashboard/service.ts",
    47	    "src/lib/dashboard/aggregate-service.ts",
    48	    "src/lib/dashboard/pending-count.ts",
    49	    "src/lib/dashboard/__tests__/**",
    50	    "src/lib/agents/read.ts",
    51	    "src/lib/agents/__tests__/**",
    52	    "scripts/ci/tenant-scope-allowlist.ts"
    53	  ],
    54	  "tests_to_add": [
    55	    "openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref",
    56	    "hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes",
    57	    "a held draft still projects draft_held true after the fragment migration",
    58	    "getReviewTimeline excludes a response whose flag is open and includes it once closed",
    59	    "property: projected held and filtered visibility agree for every flag-row status combination"
    60	  ],
    61	  "verification_commands": [
    62	    "pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts"
    63	  ],
    64	  "estimated_prod_lines": "±140 (held-draft.ts +~45 incl. divergence comment block; 8 spelling swaps net-negative ~-25 code; D6 comment rewrites; ~8 allowlist snippet lines regenerated). Code is net-negative; the divergence comment block offsets some of it in raw line count",
    65	  "estimated_test_lines": "±300 (new fragment unit tests + 2 integration titles + 1 bounded fast-check property; churn in SQL-text-pinning mock suites: draft-status route tests, dashboard aggregate-queries/service tests, agents read tests)",
    66	  "dependencies_added": [],
    67	  "rollback_plan": "No migration, no flag, no schema touch — db_touching covers read-query text only. Back out = revert the squash-merge commit on main; nothing to unwind in either Supabase project",
    68	  "observability": [
    69	    "No new runtime signal — semantics-preserving refactor. A regression would surface as held drafts appearing in owner reads (invariant #4 leak); guarded pre-merge by the two live-DB integration suites + the D9 projected assertions + ci:tenant-scope/ci:rls-audit green, not by a new prod metric. Post-deploy staging smoke: pending count and Reviews list for a location with a known held draft match pre-deploy values"
    70	  ],
    71	  "open_questions": []
    72	}
dbadaa85 (HEAD -> feat-730-open-flag-consolidation) docs(#730): implementation plan + deviations log (setup)
90e6c2dc chore(feature): intake contract for feat-730-open-flag-consolidation
76b40b7b (origin/main, origin/HEAD, main) docs(#728): post-merge sweep — currents, progress, directory, lab notes, ADR-0017 addendum, entropy counter (#745)
8ee889ff feat(#728): persist-boundary content-freshness gate + generation-cache provenance (ADR 0017) (#743)
d7cc49a3 docs(#727): post-merge sweep — currents, progress, lab-notes, arch counter, ADR cross-refs (#742)
 .../2026-08-09-feat-730-open-flag-consolidation.md | 603 +++++++++++++++++++++
 .../feat-730-open-flag-consolidation-deviations.md |  18 +
 .../feat-730-open-flag-consolidation-intake.json   |  72 +++
 3 files changed, 693 insertions(+)
docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md
docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json

hook: PostToolUse
hook: PostToolUse Completed
codex
| severity | artifact | one-line finding |
|---|---|---|
| BLOCKER | [Task 1 property](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:162) | The property cannot be green as written: `loadReplies` does not exist, and the suite already seeds two unheld `pending_approval` responses, so the count is baseline `2` and becomes `2/3`, never `0/1`; use `loadPastRepliesPageView` and isolate a business or assert a count delta. |
| MAJOR | [held-draft tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/moderation/__tests__/held-draft.test.ts:10) | **MISSING FAILING TEST — “hasOpenFlag executes the UUID-parameter fragment against live Postgres”**: pin two response IDs plus open/closed transitions; otherwise a parameter-only error such as `::text`, malformed nesting, or invalid no-FROM SQL passes because `mkTx` returns scripted rows. |
| MAJOR | [draft-status route tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:226) | **MISSING FAILING TEST — “each draft-status awaited query projects held from its correctly correlated response alias”**: pin `resp.id` and `responses.id` in fragment-flattened queries; current tests inject `held: true/false`, so deleting the SQL assertion or using the wrong alias can stay behavior-green. |
| MAJOR | [dashboard filtered LATERALs](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/service.ts:243) | **MISSING FAILING TEST — “location and aggregate response LATERALs skip a held newest response and fall back to the newest unheld sibling”**: pins `AND NOT`, `responses.id`, and LATERAL placement; scripted service results would not catch inverted polarity or filtering after `LIMIT`. |
| MAJOR | [account-grouped pending count](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/pending-count.ts:34) | **MISSING FAILING TEST — “per-business and account-grouped pending counts exclude the same open-held rows across two businesses”**: Task 1 calls only the singular spelling, while the grouped suite scripts counts and cannot detect a bad `resp.id` correlation or omitted `NOT`. |
| MAJOR | [timeline integration test](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/agents/__tests__/read.integration.test.ts:236) | **MISSING FAILING TEST — “getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged”**: the planned single-response open/closed case passes even if the rewrite applies `LIMIT 1` before exclusion and incorrectly returns `null` instead of the older unheld response. |
| MAJOR | [promised-tests gate](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/scripts/verify-gate.sh:285) | **MISSING FAILING TEST — “all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains”**: the gate only greps title text and accepts `.todo`, so assertions can be deleted—or the fragment test left todo—while mocked outputs and the promised-tests row remain green. |
| MAJOR | [route SQL doubles](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:41) | The plan’s mock-mechanics claim is false: both route doubles consume their result queue on every fragment-building tag call, so the ref and EXISTS fragments consume the intended row before the outer query; T4 requires fragment-aware doubles, not merely assertion/call-count updates. |
| MAJOR | [Task 5 verification](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:520) | Task 5 migrates the pending-count half of the cross-module property but never reruns that property; a bad singular-count alias can be committed green, remain unseen through T6, and surface only at the final gate. |
| MAJOR | [parallel T6 commit](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:568) | T6 is not parallel-safe in a shared worktree: every task uses `git add -A`, so T6 can stage and commit partially completed T3–T5/allowlist work or contend on the Git index; serialize commits or use isolated worktrees/path-scoped staging. |
| MINOR | [locked intake edge case](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json:28) | The intake says a pending-count allowlist entry regenerates, but no such entry exists; this contradicts Task 5’s correct statement that pending-count is directly scoped and has no entry. |

Cited-artifact check: all other requested artifacts and ranges were verified, including exactly eight inline spellings, the six cited allowlist entries and their table keys, baseline/count `409`, `flagged_responses` absent from `TENANT_TABLES`, migration 051’s statuses/index, `REVIEW_HELD_REPLACEMENT`, `mkTx`, and `statusArraySql`.

Postgres.js 3.4.9 does recursively splice nested `Query` fragments in all three real-client contexts. `SELECT 1 AS one WHERE EXISTS (...)` without `FROM` is valid and equivalent to the current existence check; the risk is the mocks and uncovered consumer compositions, not Postgres.js itself.

VERDICT: REVISE
hook: Stop
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
hook: Stop Completed
tokens used
182,579
| severity | artifact | one-line finding |
|---|---|---|
| BLOCKER | [Task 1 property](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:162) | The property cannot be green as written: `loadReplies` does not exist, and the suite already seeds two unheld `pending_approval` responses, so the count is baseline `2` and becomes `2/3`, never `0/1`; use `loadPastRepliesPageView` and isolate a business or assert a count delta. |
| MAJOR | [held-draft tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/moderation/__tests__/held-draft.test.ts:10) | **MISSING FAILING TEST — “hasOpenFlag executes the UUID-parameter fragment against live Postgres”**: pin two response IDs plus open/closed transitions; otherwise a parameter-only error such as `::text`, malformed nesting, or invalid no-FROM SQL passes because `mkTx` returns scripted rows. |
| MAJOR | [draft-status route tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:226) | **MISSING FAILING TEST — “each draft-status awaited query projects held from its correctly correlated response alias”**: pin `resp.id` and `responses.id` in fragment-flattened queries; current tests inject `held: true/false`, so deleting the SQL assertion or using the wrong alias can stay behavior-green. |
| MAJOR | [dashboard filtered LATERALs](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/service.ts:243) | **MISSING FAILING TEST — “location and aggregate response LATERALs skip a held newest response and fall back to the newest unheld sibling”**: pins `AND NOT`, `responses.id`, and LATERAL placement; scripted service results would not catch inverted polarity or filtering after `LIMIT`. |
| MAJOR | [account-grouped pending count](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/pending-count.ts:34) | **MISSING FAILING TEST — “per-business and account-grouped pending counts exclude the same open-held rows across two businesses”**: Task 1 calls only the singular spelling, while the grouped suite scripts counts and cannot detect a bad `resp.id` correlation or omitted `NOT`. |
| MAJOR | [timeline integration test](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/agents/__tests__/read.integration.test.ts:236) | **MISSING FAILING TEST — “getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged”**: the planned single-response open/closed case passes even if the rewrite applies `LIMIT 1` before exclusion and incorrectly returns `null` instead of the older unheld response. |
| MAJOR | [promised-tests gate](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/scripts/verify-gate.sh:285) | **MISSING FAILING TEST — “all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains”**: the gate only greps title text and accepts `.todo`, so assertions can be deleted—or the fragment test left todo—while mocked outputs and the promised-tests row remain green. |
| MAJOR | [route SQL doubles](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:41) | The plan’s mock-mechanics claim is false: both route doubles consume their result queue on every fragment-building tag call, so the ref and EXISTS fragments consume the intended row before the outer query; T4 requires fragment-aware doubles, not merely assertion/call-count updates. |
| MAJOR | [Task 5 verification](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:520) | Task 5 migrates the pending-count half of the cross-module property but never reruns that property; a bad singular-count alias can be committed green, remain unseen through T6, and surface only at the final gate. |
| MAJOR | [parallel T6 commit](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:568) | T6 is not parallel-safe in a shared worktree: every task uses `git add -A`, so T6 can stage and commit partially completed T3–T5/allowlist work or contend on the Git index; serialize commits or use isolated worktrees/path-scoped staging. |
| MINOR | [locked intake edge case](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json:28) | The intake says a pending-count allowlist entry regenerates, but no such entry exists; this contradicts Task 5’s correct statement that pending-count is directly scoped and has no entry. |

Cited-artifact check: all other requested artifacts and ranges were verified, including exactly eight inline spellings, the six cited allowlist entries and their table keys, baseline/count `409`, `flagged_responses` absent from `TENANT_TABLES`, migration 051’s statuses/index, `REVIEW_HELD_REPLACEMENT`, `mkTx`, and `statusArraySql`.

Postgres.js 3.4.9 does recursively splice nested `Query` fragments in all three real-client contexts. `SELECT 1 AS one WHERE EXISTS (...)` without `FROM` is valid and equivalent to the current existence check; the risk is the mocks and uncovered consumer compositions, not Postgres.js itself.

VERDICT: REVISE
