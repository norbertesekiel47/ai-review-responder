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
session id: 019fe8c0-2d5f-7df0-8ba5-bb9f562dfe40
--------
user
ROUND 2 — VERIFICATION-ONLY plan re-review (read-only; modify nothing).

You reviewed this plan in round 1 and returned VERDICT: REVISE with 1 BLOCKER,
8 MAJOR, 1 MINOR. The plan was revised to v2:
docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
(intake corrections: docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json;
triage record: docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md,
section "Plan-review round 1").

Your ONLY job: verify each round-1 finding is addressed, and flag any defect a
FIX itself introduced. You may NOT open new fronts against unchanged plan
sections — anything new and unrelated goes in a short appendix, untriaged.

Round-1 findings → claimed fixes:

1. BLOCKER (property unrunnable: `loadReplies` nonexistent; suite baseline
   counts) → T1 rebuilt on `loadPastRepliesPageView`, an ISOLATED business
   under the suite account, per-run seeds/cleanup, and a suite-business
   baseline guard asserted inside every property run.
2. MAJOR (no live verification of hasOpenFlag's re-expressed body) → new
   title #6 "hasOpenFlag executes the UUID-parameter fragment against live
   Postgres" in load-replies.integration.test.ts (T1), re-run in T2.
3. MAJOR (alias correlation unpinned in route tests) → title #9 in T4 with
   fragment-aware doubles; asserts the captured ref call is exactly
   `resp.id` / `responses.id` and the EXISTS call text.
4. MAJOR (dashboard LATERAL fallback untested) → PARTIAL-ACCEPT, reasoning
   recorded: title #10 pins polarity (`AND NOT ?`) and placement (before
   `ORDER BY version DESC`, inside the LATERAL slice) at unit level; live
   coverage of the identical filtered composition comes from titles #5/#8
   (pending-count) — a live dashboard-service suite was rejected as
   disproportionate. Verify this reasoning is sound, or name the residual
   uncovered failure mode concretely.
5. MAJOR (grouped pending count untested) → title #8 + grouped-map
   assertions inside the property (isolated business + suite-business
   baseline as the second business).
6. MAJOR (timeline single-response case too weak) → title #7
   "falls back to the newest unheld response…" (T1, validates T6).
7. MAJOR (promised-tests accepts .todo forever; no mechanical
   no-inline-spelling check) → title #11 source-scan test implemented in T7
   before the gate; plan states no `.todo` may remain among the eleven at
   gate time.
8. MAJOR (v1 mock-mechanics claim false for queue-based doubles) →
   fragment-aware double pattern specified in the plan header, mandated in
   T4/T5 (`isExecutedStatement` guard; build-calls captured, queue not
   consumed).
9. MAJOR (T5 never re-runs the cross-module property) → T5 step 4 re-runs
   load-replies.integration.test.ts explicitly.
10. MAJOR (T6 parallel unsafe: shared Git index, `git add -A`) → fully
    serial T1→T7; every commit path-scoped; `git add -A` eliminated.
11. MINOR (intake wrongly listed a pending-count allowlist entry) → intake
    edge_case corrected in both copies; plan states pending-count has no
    entry and must not gain one.

Output format (strict):
1. A per-finding verification table: finding # | ADDRESSED / NOT ADDRESSED /
   FIX-INTRODUCED-DEFECT | one line.
2. Optional short appendix (new, unrelated observations — untriaged).
3. LAST line exactly `VERDICT: APPROVED` or `VERDICT: REVISE`.
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
I’m using the `verify-spec` workflow because this is a read-only, evidence-backed plan audit. I’ll constrain the review to the eleven round-1 findings and only note fix-introduced defects; unchanged sections remain out of scope.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '1,240p' .claude/CLAUDE.md && sed -n '1,280p' .agents/skills/verify-spec/SKILL.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'git status --short && wc -l .claude/CLAUDE.md .agents/skills/verify-spec/SKILL.md docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md' in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
?? docs/reviews/feat-730-open-flag-consolidation/plan-review-round2.md
     219 .claude/CLAUDE.md
      71 .agents/skills/verify-spec/SKILL.md
     662 docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
      78 docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json
      44 docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md
    1074 total

hook: PostToolUse
hook: PostToolUse Completed
codex
The worktree has one pre-existing untracked review file, [plan-review-round2.md](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/reviews/feat-730-open-flag-consolidation/plan-review-round2.md). I’ll leave it untouched and audit the current HEAD plan state. Since this is a plan-only re-review, I’m checking plan executability and code/test seams rather than running the implementation validation suite.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "sed -n '1,120p' .claude/CLAUDE.md; sed -n '121,240p' .claude/CLAUDE.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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
/bin/zsh -lc "nl -ba docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md | sed -n '1,220p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     1	# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan (v2)
     2	
     3	> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
     4	> (recommended) or executing-plans to implement this plan task-by-task. Steps
     5	> use checkbox (`- [ ]`) syntax for tracking.
     6	
     7	> v2 after codex plan-review round 1 (REVISE): property test rebuilt on the
     8	> real export + isolated business (BLOCKER), five missing-test findings folded
     9	> into T1/T4/T5/T7, fragment-aware test doubles specified (the v1 mock claim
    10	> was wrong for queue-based doubles), all tasks serialized with path-scoped
    11	> staging. Full triage: docs/reviews/feat-730-open-flag-consolidation/.
    12	
    13	**Goal:** Consolidate every owner-facing surfacing spelling of the open-flag
    14	predicate onto one composable fragment `openFlagExistsSql`, owned by
    15	`src/lib/moderation/held-draft.ts`, leaving the deliberately-distinct
    16	consumers alone with the divergence recorded on the owner module.
    17	
    18	**Architecture:** Deepen the existing `held-draft.ts` module (the semantic
    19	owner of "is this draft held") with one new interface member — a fragment
    20	builder in the `statusArraySql` house pattern
    21	(`src/lib/shared/response-status-sql.ts`). The 7 owner-facing files (8 inline
    22	spellings) then compose the fragment instead of re-spelling the predicate;
    23	`hasOpenFlag`'s body is re-expressed on the same fragment so the
    24	`response_id`-correlation + `status='open'` semantics are spelled exactly
    25	once. The 8 deliberately-distinct consumers (#725 inventory) are untouched.
    26	
    27	**Tech stack:** Postgres.js nested-fragment splicing (verified round 1:
    28	postgres 3.4.9 recursively splices nested Query fragments in all three
    29	composition contexts; `SELECT 1 AS one WHERE EXISTS (...)` without FROM is
    30	valid), vitest, fast-check (house style:
    31	`src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).
    32	
    33	**Intake:** `.feature/intake.json` (committed copy:
    34	`docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`).
    35	**Research deliverable:** #725's closing comment.
    36	
    37	**Verified planning facts** (round-1 review re-verified all of these):
    38	
    39	- `flagged_responses` is NOT in `TENANT_TABLES` — the fragment adds no new
    40	  audit surface; `hasOpenFlag` needs no allowlist entry today.
    41	- Exactly 8 inline spellings exist. The six allowlist entries containing them
    42	  key on `table: "responses"` / `"review_escalations"` (lines ~327, ~1285,
    43	  ~1509, ~1516, ~1530, ~1537); they regenerate IN PLACE, `ALLOWLIST_BASELINE`
    44	  stays 409. Snippets store verbatim source text normalized by
    45	  `normalizeSql(stripSqlComments(...))`; SQL comments never appear in them.
    46	  pending-count is directly scoped and has NO entry — confirm no new one
    47	  appears.
    48	- Flag statuses (migration 051 CHECK): `open`, `approved_for_owner_review`,
    49	  `dismissed_false_positive`, `requires_regeneration`; partial unique index on
    50	  `status = 'open'` → `fc.subarray` (subset ⇒ at most one `open`).
    51	- The Reviews-list export is **`loadPastRepliesPageView`** (there is no
    52	  `loadReplies`). The integration suite's static seeds already include
    53	  unheld `pending_approval` responses on the suite's business — property and
    54	  count tests MUST run on an isolated business and treat the suite business's
    55	  counts as a baseline to be left undisturbed.
    56	- **Test doubles are NOT uniformly safe under fragment migration.**
    57	  `mkTx` (held-draft.test.ts) returns the same rows for every call — safe.
    58	  The route/dashboard doubles `shift()` a result QUEUE per tagged call —
    59	  a fragment-building call would eat the queued row meant for the executed
    60	  query. Every queue-based suite touched by migration gets the
    61	  fragment-aware double below (build-calls captured but NOT consuming).
    62	
    63	**Fragment-aware double (house pattern for this branch, used in T4/T5):**
    64	
    65	```ts
    66	const isExecutedStatement = (text: string) =>
    67	  /^\s*(select|insert|update|delete|with)\b/i.test(text);
    68	
    69	const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    70	  const text = strings.join('?');
    71	  readCalls.push({ text, values });
    72	  // Fragment builds (`resp.id`, `EXISTS (...)`) are captured for assertions
    73	  // but must NOT consume the queued result of the outer executed query.
    74	  if (!isExecutedStatement(text)) return { fragmentText: text, values };
    75	  return Promise.resolve(readQueue.shift() ?? []);
    76	});
    77	```
    78	
    79	---
    80	
    81	## File structure (locked)
    82	
    83	| File | Change |
    84	|---|---|
    85	| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql`; `hasOpenFlag` body re-expressed; + divergence comment block |
    86	| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment test; contract test; + T7 source-scan test; assertion updates |
    87	| `src/lib/past-replies/load-replies.ts` | inline EXISTS → fragment; stale `#680` comment rewritten |
    88	| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + pinning test, + property (isolated business), + grouped-count test, + live hasOpenFlag test |
    89	| `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
    90	| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | fragment-aware double + alias-correlation assertions |
    91	| `src/app/api/dashboard/past-replies/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
    92	| `src/app/api/dashboard/past-replies/__tests__/**` | fragment-aware double + alias-correlation assertions |
    93	| `src/lib/dashboard/service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
    94	| `src/lib/dashboard/aggregate-service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
    95	| `src/lib/dashboard/pending-count.ts` | BOTH spellings → `AND NOT ${fragment}` |
    96	| `src/lib/dashboard/__tests__/**` | fragment-aware double where queue-based + placement/polarity assertions |
    97	| `src/lib/agents/read.ts` | anti-join → `AND NOT ${fragment}` |
    98	| `src/lib/agents/__tests__/read.integration.test.ts` | + exclusion test + newest-unheld fallback test |
    99	| `src/lib/agents/__tests__/read.test.ts` | assertion updates (if any pin the join text) |
   100	| `scripts/ci/tenant-scope-allowlist.ts` | 6 `sqlSnippet` strings regenerated in place; baseline stays 409 |
   101	
   102	No new files. No new dependencies.
   103	
   104	## Dispatch order — FULLY SERIAL
   105	
   106	T1 → T2 → T3 → T4 → T5 → T6 → T7. (v1 ran T6 parallel to T3–T5; round 1
   107	killed that: tasks share the worktree Git index and `git add -A` could stage
   108	a sibling's half-done work. All commits below are PATH-SCOPED — never
   109	`git add -A`.) T1 still runs alone first as the enforcement spot check.
   110	
   111	---
   112	
   113	### Task 1: Eval task — behavior-pinning tests + promised-test stubs
   114	
   115	**Files:**
   116	- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
   117	- Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
   118	- Modify: `src/lib/agents/__tests__/read.integration.test.ts`
   119	
   120	All eleven intake `tests_to_add` titles land VERBATIM here. GREEN now
   121	(behavior-pinning, they must survive the refactor unchanged): #2–#8 below.
   122	`.todo` until their implementation task: #1 (T2), #9 (T4), #10 (T5), #11 (T7).
   123	
   124	1. `openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref` — `.todo`
   125	2. `hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes`
   126	3. `a held draft still projects draft_held true after the fragment migration`
   127	4. `getReviewTimeline excludes a response whose flag is open and includes it once closed`
   128	5. `property: projected held and filtered visibility agree for every flag-row status combination`
   129	6. `hasOpenFlag executes the UUID-parameter fragment against live Postgres`
   130	7. `getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged`
   131	8. `per-business and account-grouped pending counts exclude the same open-held rows across two businesses`
   132	9. `each draft-status awaited query projects held from its correctly correlated response alias` — `.todo`
   133	10. `the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned` — `.todo`
   134	11. `all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains` — `.todo`
   135	
   136	- [ ] **Step 1: held-draft.test.ts — titles #1 (.todo) and #2**
   137	
   138	```ts
   139	  it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
   140	    const open = mkTx([{ one: 1 }]);
   141	    await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
   142	    const closed = mkTx([]);
   143	    await expect(hasOpenFlag(closed.tx, RESPONSE_ID)).resolves.toBe(false);
   144	  });
   145	```
   146	
   147	```ts
   148	describe('openFlagExistsSql', () => {
   149	  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
   150	  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
   151	});
   152	```
   153	
   154	- [ ] **Step 2: load-replies.integration.test.ts — titles #3, #5, #6, #8**
   155	
   156	Read the suite first. Crib: the `REVIEW_HELD_REPLACEMENT` fixture + its
   157	`flagged_responses` INSERT shape (~line 138), the FK-ordered cleanup
   158	(~line 208), and how the suite creates its business/account rows.
   159	
   160	Title #3 — behavior-pinning against the EXISTING fixture (mirror the
   161	neighbouring #727 held-case assertions; through `loadPastRepliesPageView`,
   162	a held replacement draft on a posted row projects `row_action 'none'` /
   163	withdrawn Regenerate — assert exactly what the adjacent held case asserts,
   164	under the locked title):
   165	
   166	```ts
   167	  it('a held draft still projects draft_held true after the fragment migration', async () => {
   168	    const view = await loadPastRepliesPageView(/* suite's standard args */);
   169	    const heldRow = view.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
   170	    expect(heldRow).toBeDefined();
   171	    expect(heldRow!.row_action).toBe('none'); // held ⇒ affordance withdrawn (invariant #4 as structure)
   172	  });
   173	```
   174	
   175	Titles #5, #6, #8 — an ISOLATED business under the suite's account (created
   176	once in a before-hook, torn down FK-ordered after). Baseline rule: read the
   177	suite business's `getPendingApprovalCountsForAccount` entry BEFORE the
   178	property and assert it is UNDISTURBED inside every run (cross-business
   179	correlation guard).
   180	
   181	```ts
   182	  it('property: projected held and filtered visibility agree for every flag-row status combination', async () => {
   183	    const FLAG_STATUSES = ['open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration'] as const;
   184	    const baseline = (await getPendingApprovalCountsForAccount(sql(), accountId)).get(suiteBusinessId) ?? 0;
   185	    await fc.assert(
   186	      fc.asyncProperty(fc.subarray([...FLAG_STATUSES]), async (statuses) => {
   187	        // seed on the ISOLATED business: one review + one pending_approval
   188	        // response + one flag row per status (INSERT shapes cribbed from ~138)
   189	        const expectHeld = statuses.includes('open');
   190	        const view = await loadPastRepliesPageView(/* isolated business */);
   191	        const row = view.unansweredRows.find((r) => r.review_id === propReviewId);
   192	        // projected mode: unanswered+pending draft ⇒ draft_ready unless held ⇒ none (#727 model)
   193	        expect(row!.row_action).toBe(expectHeld ? 'none' : 'draft_ready');
   194	        // filtered mode, BOTH spellings:
   195	        expect(await getPendingApprovalCount(sql(), isolatedBusinessId)).toBe(expectHeld ? 0 : 1);
   196	        const grouped = await getPendingApprovalCountsForAccount(sql(), accountId);
   197	        expect(grouped.get(isolatedBusinessId) ?? 0).toBe(expectHeld ? 0 : 1);
   198	        expect(grouped.get(suiteBusinessId) ?? 0).toBe(baseline); // no cross-business bleed
   199	        // FK-ordered cleanup of the per-run rows
   200	      }),
   201	      { numRuns: 12 },
   202	    );
   203	  });
   204	```
   205	
   206	```ts
   207	  it('per-business and account-grouped pending counts exclude the same open-held rows across two businesses', async () => {
   208	    // isolated business: one pending_approval response WITH an open flag;
   209	    // suite business: untouched (its unheld pending responses are the second business).
   210	    // Assert: singular count(isolated)=0; grouped map: isolated→absent/0, suite→baseline.
   211	  });
   212	```
   213	
   214	```ts
   215	  it('hasOpenFlag executes the UUID-parameter fragment against live Postgres', async () => {
   216	    // Inside sql().begin(): hasOpenFlag(tx, heldResponseId) === true and
   217	    // hasOpenFlag(tx, unheldResponseId) === false, using rows seeded above.
   218	    // This is what makes the T2 re-expression's SQL VALIDITY live-verified —
   219	    // mkTx cannot catch malformed nesting or a bad ::uuid cast.
   220	  });

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md | sed -n '221,440p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
   221	```
   222	
   223	(Complete elided bodies with the suite's own helpers; titles, structure,
   224	assertions-as-commented are locked. Import `fc` from `fast-check`,
   225	`getPendingApprovalCount`/`getPendingApprovalCountsForAccount` from
   226	`@/lib/dashboard/pending-count`, `hasOpenFlag` from
   227	`@/lib/moderation/held-draft`.)
   228	
   229	- [ ] **Step 3: read.integration.test.ts — titles #4 and #7**
   230	
   231	```ts
   232	  it('getReviewTimeline excludes a response whose flag is open and includes it once closed', async () => {
   233	    // seed review + one displayable response; INSERT open flag → timeline response null;
   234	    // UPDATE flag to 'dismissed_false_positive' → timeline shows the response.
   235	  });
   236	
   237	  it('getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged', async () => {
   238	    // seed v1 (unheld) + v2 (open-flagged, higher version) on one review:
   239	    // timeline must return v1 — NOT null. Pins that held-filtering applies to
   240	    // the candidate set BEFORE ORDER BY version DESC LIMIT 1 (the T6 rewrite
   241	    // must preserve this).
   242	  });
   243	```
   244	
   245	Also add `.todo` stubs where they belong:
   246	in `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts`:
   247	`it.todo('each draft-status awaited query projects held from its correctly correlated response alias')`;
   248	in `src/lib/dashboard/__tests__/service.test.ts`:
   249	`it.todo('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned')`.
   250	
   251	- [ ] **Step 4: run — all green (4 todos)**
   252	
   253	```bash
   254	pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
   255	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts
   256	```
   257	
   258	(If schema assertions fail: `pnpm test:db:setup` once, re-run.)
   259	
   260	- [ ] **Step 5: Commit (path-scoped)**
   261	
   262	```bash
   263	git add src/lib/moderation/__tests__ src/lib/past-replies/__tests__ src/lib/agents/__tests__ "src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__" src/lib/dashboard/__tests__
   264	git commit -m "test(#730): eval task — pin held-draft behavior across the predicate consolidation"
   265	```
   266	
   267	### Task 2: `openFlagExistsSql` + re-expressed `hasOpenFlag` + divergence block
   268	
   269	**Files:**
   270	- Modify: `src/lib/moderation/held-draft.ts`
   271	- Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
   272	
   273	- [ ] **Step 1: fill title #1 (red)**
   274	
   275	```ts
   276	describe('openFlagExistsSql', () => {
   277	  it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
   278	    const { tx, calls } = mkTx([]);
   279	    openFlagExistsSql(tx, tx`resp.id`);
   280	    const exists = calls.at(-1)!;
   281	    expect(exists.text).toContain('EXISTS (');
   282	    expect(exists.text).toContain('FROM flagged_responses fr');
   283	    expect(exists.text).toContain("fr.status = 'open'");
   284	    expect(exists.text).toContain('fr.response_id = ');
   285	  });
   286	  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
   287	});
   288	```
   289	
   290	Run: `pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts` —
   291	expected FAIL (`openFlagExistsSql` not exported).
   292	
   293	- [ ] **Step 2: implement in `held-draft.ts`**
   294	
   295	```ts
   296	import type postgres from 'postgres';
   297	
   298	type TxClient = postgres.TransactionSql;
   299	type DbClient = postgres.Sql | postgres.TransactionSql;
   300	
   301	/**
   302	 * The one read-side spelling of "response X has an OPEN moderation flag".
   303	 * Composable Postgres.js fragment (nested queries splice as raw SQL text):
   304	 * projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` — D9 sites) or
   305	 * filtered (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`). `ref` is
   306	 * itself a fragment: a correlated column ref (sql`resp.id`) or a bound
   307	 * parameter (tx`${responseId}::uuid`). Client-agnostic like statusArraySql —
   308	 * pass the surrounding query's client.
   309	 */
   310	export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
   311	  return db`EXISTS (
   312	    SELECT 1 FROM flagged_responses fr
   313	    WHERE fr.response_id = ${ref} AND fr.status = 'open'
   314	  )`;
   315	}
   316	```
   317	
   318	(If `postgres.PendingQuery<postgres.Row[]>` fights the inferred
   319	tagged-template type, mirror `statusArraySql`'s inference; `postgres.Fragment`
   320	is the v3 alternative. No `any`.)
   321	
   322	```ts
   323	export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
   324	  const rows = await tx<{ one: number }[]>`
   325	    SELECT 1 AS one
   326	    WHERE ${openFlagExistsSql(tx, tx`${responseId}::uuid`)}
   327	  `;
   328	  return rows.length > 0;
   329	}
   330	```
   331	
   332	- [ ] **Step 3: divergence comment block** (extend the contract header — #725 §3 sink)
   333	
   334	```ts
   335	// Deliberately distinct consumers — do NOT consolidate onto this module.
   336	// Four categories read/write flagged_responses with DIFFERENT semantics, and
   337	// force-fitting them is how a shared helper acquires a boolean parameter
   338	// meaning "actually a different query" (full 16-consumer inventory: #725):
   339	//   - Admin surfaces (/api/admin/flagged, flagged-service, nav-counts): their
   340	//     subject is the FLAG ROW itself (disposition by id, queue enumeration,
   341	//     cross-tenant badge count) — not a response's held-ness.
   342	//   - Health alerting (health-alert/checks.ts): cross-tenant COUNT of open
   343	//     rows vs threshold; worker alerting must not couple to an owner-UI read.
   344	//   - Offboarding purge lane (purge-verification, purge-stages,
   345	//     table-disposition): deliberately IGNORES status — a closed flag left
   346	//     behind is still a purge violation.
   347	//   - The producer (response-generation/persist.ts): writes the flag row and
   348	//     keeps its own module-local status const (different lifecycle).
   349	```
   350	
   351	- [ ] **Step 4: update mkTx call-count assertions**
   352	
   353	The re-expressed body makes `mkTx` capture 3 calls. In
   354	`"filters on status = 'open' and the response id — the predicate that makes the hold binding"`:
   355	
   356	```ts
   357	    const allText = calls.map((c) => c.text).join('\n');
   358	    expect(allText).toContain("status = 'open'");
   359	    expect(allText).toContain('FROM flagged_responses');
   360	    expect(calls.flatMap((c) => c.values)).toContain(RESPONSE_ID);
   361	```
   362	
   363	- [ ] **Step 5: run + commit**
   364	
   365	```bash
   366	pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
   367	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # title #6 live-verifies the new body
   368	pnpm typecheck
   369	git add src/lib/moderation
   370	git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
   371	```
   372	
   373	### Task 3: Migrate `load-replies.ts` + regen allowlist entry (~1285)
   374	
   375	**Files:**
   376	- Modify: `src/lib/past-replies/load-replies.ts:230-244`
   377	- Modify: `scripts/ci/tenant-scope-allowlist.ts` (load-replies main-query entry)
   378	- Check: `src/lib/past-replies/__tests__/` unit suites for outer-text assertions
   379	
   380	- [ ] **Step 1: rewrite the spelling + the stale #680 comment**
   381	
   382	Old:
   383	
   384	```
   385	      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
   386	      -- held while an open flagged_responses row exists". Its hasOpenFlag is an
   387	      -- in-tx, post-lock release gate taking a TransactionSql — it cannot be
   388	      -- composed into a LATERAL — so the predicate is spelled inline here (D6);
   389	      -- consolidating the spellings into one exported fragment is a #680 item.
   390	      LEFT JOIN LATERAL (
   391	        SELECT
   392	          resp2.id,
   393	          EXISTS (
   394	            SELECT 1
   395	            FROM flagged_responses f
   396	            WHERE f.response_id = resp2.id
   397	              AND f.status = 'open'
   398	          ) AS held
   399	```
   400	
   401	New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`; use the
   402	client variable actually in scope):
   403	
   404	```
   405	      -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
   406	      -- held while an open flagged_responses row exists"; this projection
   407	      -- composes its openFlagExistsSql fragment (#730). Projected, not
   408	      -- filtered (D9): a held draft must stay distinguishable from "no draft".
   409	      LEFT JOIN LATERAL (
   410	        SELECT
   411	          resp2.id,
   412	          ${openFlagExistsSql(sql, sql`resp2.id`)} AS held
   413	```
   414	
   415	- [ ] **Step 2: regen the allowlist entry**
   416	
   417	```bash
   418	pnpm ci:tenant-scope 2>&1 | tail -30
   419	```
   420	
   421	Expected: FAIL naming `load-replies.ts` with the newly-extracted query text.
   422	Paste it into the existing entry's `sqlSnippet` (~line 1285,
   423	`table: "responses"`). Entry COUNT unchanged — `ALLOWLIST_BASELINE` stays 409.
   424	Re-run; PASS.
   425	
   426	- [ ] **Step 3: run + commit**
   427	
   428	```bash
   429	pnpm vitest run src/lib/past-replies
   430	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
   431	git add src/lib/past-replies scripts/ci/tenant-scope-allowlist.ts
   432	git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
   433	```
   434	
   435	If a unit suite pinned outer query text containing the inline EXISTS, relocate
   436	the assertion to the fragment's captured call (fragment-aware double if the
   437	suite is queue-based) — never delete it.
   438	
   439	### Task 4: Migrate the two draft-status routes + regen entry (~327) + title #9
   440	

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md | sed -n '441,662p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
   441	**Files:**
   442	- Modify: `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:57-75`
   443	- Modify: `src/app/api/dashboard/past-replies/draft-status/route.ts:109-127`
   444	- Modify: `scripts/ci/tenant-scope-allowlist.ts` (past-replies draft-status entry ~327)
   445	- Modify: both routes' test suites — fragment-aware doubles + title #9
   446	
   447	- [ ] **Step 1: reviews/[reviewId]/draft-status — rewrite**
   448	
   449	Comment: keep F5/invariant-#4 + D9 sentences; the "spells … inline (D6)"
   450	sentences become:
   451	
   452	```ts
   453	    // That module is the SEMANTIC OWNER of "is this draft held"; this read
   454	    // path composes its openFlagExistsSql fragment (#730).
   455	```
   456	
   457	Query: `EXISTS (…) AS held` block →
   458	`${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held`.
   459	
   460	- [ ] **Step 2: past-replies/draft-status — rewrite**
   461	
   462	Same comment treatment; predicate →
   463	`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held`
   464	(this query's correlated ref is the unaliased table).
   465	
   466	- [ ] **Step 3: upgrade BOTH suites' doubles to the fragment-aware pattern**
   467	(header of this plan) — the queue-based mocks otherwise consume the queued
   468	row on fragment-build calls. Then fill title #9 (moved from `.todo`):
   469	
   470	```ts
   471	  it('each draft-status awaited query projects held from its correctly correlated response alias', async () => {
   472	    // run the route with a queued draft row, then:
   473	    const refCall = readCalls.find((c) => c.text.trim() === 'resp.id');   // 'responses.id' in the past-replies suite
   474	    expect(refCall, 'fragment ref must correlate on the outer query alias').toBeDefined();
   475	    const existsCall = readCalls.find((c) => c.text.includes('FROM flagged_responses'));
   476	    expect(existsCall!.text).toContain("fr.status = 'open'");
   477	  });
   478	```
   479	
   480	- [ ] **Step 4: regen entry ~327, run, commit**
   481	
   482	```bash
   483	pnpm ci:tenant-scope 2>&1 | tail -30   # fails naming past-replies/draft-status; paste new snippet
   484	pnpm vitest run "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies
   485	git add "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies scripts/ci/tenant-scope-allowlist.ts
   486	git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
   487	```
   488	
   489	(The reviews route has no allowlist entry — it binds `resp.business_id`.
   490	Relocate — never delete — any outer-text assertions that pinned
   491	`FROM flagged_responses`.)
   492	
   493	### Task 5: Migrate the dashboard trio + regen 4 entries + title #10
   494	
   495	**Files:**
   496	- Modify: `src/lib/dashboard/service.ts:253-256`
   497	- Modify: `src/lib/dashboard/aggregate-service.ts:404-407`
   498	- Modify: `src/lib/dashboard/pending-count.ts:17-20,45-48`
   499	- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries: ~1509/~1516/~1530/~1537)
   500	- Modify: `src/lib/dashboard/__tests__/` — fragment-aware doubles where queue-based + title #10
   501	
   502	- [ ] **Step 1: service.ts + aggregate-service.ts** — keep both comments; the block
   503	
   504	```
   505	          AND NOT EXISTS (
   506	            SELECT 1 FROM flagged_responses fr
   507	            WHERE fr.response_id = responses.id AND fr.status = 'open'
   508	          )
   509	```
   510	
   511	becomes
   512	
   513	```
   514	          AND NOT ${openFlagExistsSql(sql, sql`responses.id`)}
   515	```
   516	
   517	(correlated ref is the unaliased `responses` table in both LATERALs; use each
   518	query's in-scope client variable.)
   519	
   520	- [ ] **Step 2: pending-count.ts — BOTH spellings** →
   521	`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`. Import in all three files.
   522	
   523	- [ ] **Step 3: fill title #10** (in `service.test.ts`, moved from `.todo`;
   524	upgrade the suite's double to fragment-aware if queue-based):
   525	
   526	```ts
   527	  it('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned', () => {
   528	    // capture the dashboard feed query text; slice the responses-LATERAL
   529	    // substring (between 'LEFT JOIN LATERAL' and ') resp ON true'):
   530	    const lateral = feedQueryText.slice(feedQueryText.indexOf('LEFT JOIN LATERAL'), feedQueryText.indexOf(') resp ON true'));
   531	    const notIdx = lateral.indexOf('AND NOT ?');       // fragment placeholder, NEGATED polarity
   532	    const orderIdx = lateral.indexOf('ORDER BY version DESC');
   533	    expect(notIdx).toBeGreaterThan(-1);
   534	    expect(orderIdx).toBeGreaterThan(notIdx);          // filter BEFORE order/limit — held newest falls back to unheld sibling
   535	    // and the fragment itself was built with the right correlation:
   536	    expect(fragmentCalls.some((c) => c.text.trim() === 'responses.id')).toBe(true);
   537	  });
   538	```
   539	
   540	(Repeat the same assertion shape for aggregate-service in its suite if its
   541	query text is separately capturable. Round-1 triage note: a live
   542	dashboard-service suite was weighed and rejected as disproportionate — this
   543	placement/polarity pin plus the live property on the IDENTICAL filtered
   544	composition (pending-count, title #5) covers inverted-polarity and
   545	filter-after-LIMIT regressions.)
   546	
   547	- [ ] **Step 4: regen entries, run — INCLUDING the cross-module property — commit**
   548	
   549	```bash
   550	pnpm ci:tenant-scope 2>&1 | tail -40   # 4 mismatches: service ×2, aggregate ×2 — paste each
   551	pnpm vitest run src/lib/dashboard
   552	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # titles #5/#8 exercise BOTH pending-count spellings live against the migrated code
   553	git add src/lib/dashboard scripts/ci/tenant-scope-allowlist.ts
   554	git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
   555	```
   556	
   557	(pending-count has NO allowlist entry — its queries are directly scoped;
   558	confirm the audit passes without adding one.)
   559	
   560	### Task 6: `agents/read.ts` — anti-join → NOT EXISTS
   561	
   562	**Files:**
   563	- Modify: `src/lib/agents/read.ts:317-334`
   564	- Check: `src/lib/agents/__tests__/read.test.ts` for join-text assertions
   565	
   566	- [ ] **Step 1: rewrite**
   567	
   568	Old:
   569	
   570	```
   571	      FROM responses resp
   572	      JOIN businesses b ON b.id = resp.business_id
   573	      LEFT JOIN flagged_responses fr
   574	        ON fr.response_id = resp.id AND fr.status = 'open'
   575	      WHERE resp.review_id = ${params.reviewId}
   576	        AND b.account_id = ${params.accountId}
   577	        AND b.archived_at IS NULL
   578	        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
   579	        AND fr.id IS NULL
   580	```
   581	
   582	New:
   583	
   584	```
   585	      FROM responses resp
   586	      JOIN businesses b ON b.id = resp.business_id
   587	      WHERE resp.review_id = ${params.reviewId}
   588	        AND b.account_id = ${params.accountId}
   589	        AND b.archived_at IS NULL
   590	        AND resp.status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
   591	        -- Held drafts never surface on the timeline (invariant #4);
   592	        -- src/lib/moderation/held-draft.ts owns the predicate (#730).
   593	        AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
   594	```
   595	
   596	- [ ] **Step 2: run + commit**
   597	
   598	```bash
   599	pnpm vitest run src/lib/agents
   600	TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/agents/__tests__/read.integration.test.ts   # titles #4 and #7 — exclusion AND newest-unheld fallback
   601	git add src/lib/agents
   602	git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
   603	```
   604	
   605	(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched; no
   606	allowlist work here.)
   607	
   608	### Task 7: Source-scan test (title #11) + verify gate
   609	
   610	- [ ] **Step 1: fill title #11** in held-draft.test.ts (moved from `.todo`) —
   611	house precedent: source-scanning suites like
   612	`src/__tests__/eslint-boundaries.test.ts` / `design-token-single-source.test.ts`:
   613	
   614	```ts
   615	  it('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains', () => {
   616	    const OWNER_FACING = [
   617	      'src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts',
   618	      'src/app/api/dashboard/past-replies/draft-status/route.ts',
   619	      'src/lib/past-replies/load-replies.ts',
   620	      'src/lib/dashboard/service.ts',
   621	      'src/lib/dashboard/aggregate-service.ts',
   622	      'src/lib/dashboard/pending-count.ts',
   623	      'src/lib/agents/read.ts',
   624	    ];
   625	    for (const file of OWNER_FACING) {
   626	      const src = readFileSync(resolve(process.cwd(), file), 'utf-8');
   627	      expect(src, `${file} must compose openFlagExistsSql`).toContain('openFlagExistsSql');
   628	      expect(src, `${file} re-spells the open-flag predicate inline`).not.toMatch(/FROM\s+flagged_responses/i);
   629	    }
   630	  });
   631	```
   632	
   633	Run the suite; commit:
   634	
   635	```bash
   636	pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
   637	git add src/lib/moderation/__tests__
   638	git commit -m "test(#730): source-scan — no owner-facing inline open-flag spelling remains"
   639	```
   640	
   641	- [ ] **Step 2:** `bash scripts/verify-gate.sh` — all rows PASS; no remaining
   642	  `.todo` among the eleven titles; `reclassify` inside 2× both buckets.
   643	- [ ] **Step 3:** fix fallout (re-run per fix; same failure class twice → STOP,
   644	  anti-thrash rule). Final pre-review run: `bash scripts/verify-gate.sh --review`.
   645	
   646	---
   647	
   648	## Self-review (v2)
   649	
   650	- **Round-1 findings coverage:** BLOCKER → T1 rebuilt on
   651	  `loadPastRepliesPageView` + isolated business + baseline guard. MAJORs →
   652	  titles #6 (live hasOpenFlag, T1/T2), #9 (alias correlation, T4), #7
   653	  (newest-unheld fallback, T1/T6), #8 (grouped counts, T1/T5), #10
   654	  (placement/polarity, T5 — partial-accept, live dashboard suite rejected as
   655	  disproportionate, reasoning inline), #11 (source-scan, T7); fragment-aware
   656	  double specified and mandated in T4/T5; T5 re-runs the property; full
   657	  serialization + path-scoped staging. MINOR → intake edge_case corrected
   658	  (deviations entry).
   659	- **Placeholder scan:** elided test bodies each name the exact fixture/helper
   660	  to crib and lock title + assertion structure; no TBDs.
   661	- **Type consistency:** `openFlagExistsSql(db, ref)` spelled identically in
   662	  T2–T7; ref always the executing client's fragment.

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'nl -ba docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json; nl -ba .feature/intake.json; nl -ba docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md' in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     1	{
     2	  "classification": "high",
     3	  "surface": "mixed",
     4	  "db_touching": true,
     5	  "goal": "Consolidate every owner-facing surfacing spelling of the open-flag predicate onto one composable fragment (openFlagExistsSql) owned by src/lib/moderation/held-draft.ts \u2014 the semantic owner of 'is this draft held' \u2014 leaving the deliberately-distinct consumers alone with the divergence recorded on the owner module (#725 deliverable, #730 build half).",
     6	  "non_goals": [
     7	    "No change to the 8 deliberately-distinct consumers: admin disposition (/api/admin/flagged), admin queue (flagged-service), admin badge (nav-counts-service), health-alert backlog check, offboarding purge-verification + purge-stages + table-disposition, and the producer (response-generation/persist.ts keeps its module-local FLAGGED_RESPONSE_STATUS_OPEN)",
     8	    "No higher-level read helpers \u2014 the shape is fragment + retained hasOpenFlag only (#725 \u00a72)",
     9	    "No behavior change anywhere \u2014 every rewrite is semantics-preserving",
    10	    "No new CONTEXT.md glossary term \u2014 the divergence note lives as a comment block on the owner module (#725 \u00a73)",
    11	    "No shared helper growing a boolean parameter meaning 'actually a different query' (the failure mode this scoping exists to prevent)",
    12	    "No touch to worker/jobs/publisher/held-flag-gate.ts or the other hasOpenFlag call sites \u2014 they are already on the owner"
    13	  ],
    14	  "user_visible_behavior": [
    15	    "None. Held drafts remain projected (SELECTed-not-filtered, D9) on the two draft-status routes and the Reviews list, and remain excluded from dashboard reads, pending counts, and the review timeline \u2014 byte-identical result sets"
    16	  ],
    17	  "invariants": [
    18	    "Invariant #4 as structure: a held draft never surfaces its text or an affordance to the owner \u2014 projected sites stay SELECTed-not-filtered (D9); filtered sites keep excluding held rows",
    19	    "hasOpenFlag keeps its exact signature and in-tx post-FOR-UPDATE release-gate contract; none of its call sites move",
    20	    "After migration, the read-side 'open' literal is spelled only inside openFlagExistsSql in held-draft.ts",
    21	    "Tenant scoping of every migrated query is unchanged; ALLOWLIST_BASELINE stays 409 \u2014 snippet text regenerates in place, no entry adds or removes",
    22	    "The 8 deliberately-distinct consumers keep their own spellings on purpose"
    23	  ],
    24	  "edge_cases": [
    25	    "src/lib/agents/read.ts getReviewTimeline: null-filtered anti-join (LEFT JOIN flagged_responses \u2026 AND fr.id IS NULL) rewrites to NOT EXISTS via the fragment \u2014 must preserve the timeline row set exactly",
    26	    "src/lib/dashboard/pending-count.ts has TWO spellings (per-business count + account-grouped sibling); both migrate",
    27	    "The fragment's correlated ref must compose in three contexts: qualified column refs (resp.id, resp2.id, responses.id) inside LATERAL/correlated subqueries, and hasOpenFlag's ${responseId}::uuid parameter \u2014 ref parameter is a Postgres.js fragment, not a string",
    28	    "scripts/ci/tenant-scope-allowlist.ts keys on verbatim SQL source; the SIX entries whose sqlSnippet contains a migrated predicate (past-replies draft-status ~327; load-replies main ~1285; service.ts ~1509 + ~1516; aggregate-service.ts ~1530 + ~1537) regenerate in place in the same PR (the feat-719 gate-block trap, #725 note 1). pending-count has NO entry \u2014 its queries are directly scoped; the migration must not add one",
    29	    "The stale D6 comments in draft-status/route.ts and load-replies.ts cite '#680 item' for a consolidation #680 never did \u2014 they are rewritten as part of the migration",
    30	    "past-replies/draft-status/route.ts (added by #726, after #725's 6-file table was drawn) carries an inline projected EXISTS \u2014 it joins the migration set, making it 7 files / 8 inline spellings"
    31	  ],
    32	  "existing_patterns_to_follow": [
    33	    "src/lib/shared/response-status-sql.ts (statusArraySql) \u2014 the house pattern for a composable Postgres.js SQL fragment builder, already interpolated by draft-status/route.ts",
    34	    "src/lib/moderation/held-draft.ts contract-header comment style \u2014 the divergence note extends it",
    35	    "Postgres.js nested-Query splicing (lab-notes #573/#706 mechanic) \u2014 fragments compose into LATERAL/correlated contexts as raw SQL text"
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
    59	    "property: projected held and filtered visibility agree for every flag-row status combination",
    60	    "hasOpenFlag executes the UUID-parameter fragment against live Postgres",
    61	    "getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged",
    62	    "per-business and account-grouped pending counts exclude the same open-held rows across two businesses",
    63	    "each draft-status awaited query projects held from its correctly correlated response alias",
    64	    "the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned",
    65	    "all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains"
    66	  ],
    67	  "verification_commands": [
    68	    "pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts"
    69	  ],
    70	  "estimated_prod_lines": "\u00b1140 (held-draft.ts +~45 incl. divergence comment block; 8 spelling swaps net-negative ~-25 code; D6 comment rewrites; ~8 allowlist snippet lines regenerated). Code is net-negative; the divergence comment block offsets some of it in raw line count",
    71	  "estimated_test_lines": "\u00b1450 (eleven promised titles incl. live hasOpenFlag verification, fast-check property on an isolated business, grouped-count cross-business guard, alias/placement pins, source-scan; plus churn in SQL-text-pinning mock suites upgraded to fragment-aware doubles) \u2014 corrected from \u00b1300 after plan-review round 1",
    72	  "dependencies_added": [],
    73	  "rollback_plan": "No migration, no flag, no schema touch \u2014 db_touching covers read-query text only. Back out = revert the squash-merge commit on main; nothing to unwind in either Supabase project",
    74	  "observability": [
    75	    "No new runtime signal \u2014 semantics-preserving refactor. A regression would surface as held drafts appearing in owner reads (invariant #4 leak); guarded pre-merge by the two live-DB integration suites + the D9 projected assertions + ci:tenant-scope/ci:rls-audit green, not by a new prod metric. Post-deploy staging smoke: pending count and Reviews list for a location with a known held draft match pre-deploy values"
    76	  ],
    77	  "open_questions": []
    78	}
     1	{
     2	  "classification": "high",
     3	  "surface": "mixed",
     4	  "db_touching": true,
     5	  "goal": "Consolidate every owner-facing surfacing spelling of the open-flag predicate onto one composable fragment (openFlagExistsSql) owned by src/lib/moderation/held-draft.ts \u2014 the semantic owner of 'is this draft held' \u2014 leaving the deliberately-distinct consumers alone with the divergence recorded on the owner module (#725 deliverable, #730 build half).",
     6	  "non_goals": [
     7	    "No change to the 8 deliberately-distinct consumers: admin disposition (/api/admin/flagged), admin queue (flagged-service), admin badge (nav-counts-service), health-alert backlog check, offboarding purge-verification + purge-stages + table-disposition, and the producer (response-generation/persist.ts keeps its module-local FLAGGED_RESPONSE_STATUS_OPEN)",
     8	    "No higher-level read helpers \u2014 the shape is fragment + retained hasOpenFlag only (#725 \u00a72)",
     9	    "No behavior change anywhere \u2014 every rewrite is semantics-preserving",
    10	    "No new CONTEXT.md glossary term \u2014 the divergence note lives as a comment block on the owner module (#725 \u00a73)",
    11	    "No shared helper growing a boolean parameter meaning 'actually a different query' (the failure mode this scoping exists to prevent)",
    12	    "No touch to worker/jobs/publisher/held-flag-gate.ts or the other hasOpenFlag call sites \u2014 they are already on the owner"
    13	  ],
    14	  "user_visible_behavior": [
    15	    "None. Held drafts remain projected (SELECTed-not-filtered, D9) on the two draft-status routes and the Reviews list, and remain excluded from dashboard reads, pending counts, and the review timeline \u2014 byte-identical result sets"
    16	  ],
    17	  "invariants": [
    18	    "Invariant #4 as structure: a held draft never surfaces its text or an affordance to the owner \u2014 projected sites stay SELECTed-not-filtered (D9); filtered sites keep excluding held rows",
    19	    "hasOpenFlag keeps its exact signature and in-tx post-FOR-UPDATE release-gate contract; none of its call sites move",
    20	    "After migration, the read-side 'open' literal is spelled only inside openFlagExistsSql in held-draft.ts",
    21	    "Tenant scoping of every migrated query is unchanged; ALLOWLIST_BASELINE stays 409 \u2014 snippet text regenerates in place, no entry adds or removes",
    22	    "The 8 deliberately-distinct consumers keep their own spellings on purpose"
    23	  ],
    24	  "edge_cases": [
    25	    "src/lib/agents/read.ts getReviewTimeline: null-filtered anti-join (LEFT JOIN flagged_responses \u2026 AND fr.id IS NULL) rewrites to NOT EXISTS via the fragment \u2014 must preserve the timeline row set exactly",
    26	    "src/lib/dashboard/pending-count.ts has TWO spellings (per-business count + account-grouped sibling); both migrate",
    27	    "The fragment's correlated ref must compose in three contexts: qualified column refs (resp.id, resp2.id, responses.id) inside LATERAL/correlated subqueries, and hasOpenFlag's ${responseId}::uuid parameter \u2014 ref parameter is a Postgres.js fragment, not a string",
    28	    "scripts/ci/tenant-scope-allowlist.ts keys on verbatim SQL source; the SIX entries whose sqlSnippet contains a migrated predicate (past-replies draft-status ~327; load-replies main ~1285; service.ts ~1509 + ~1516; aggregate-service.ts ~1530 + ~1537) regenerate in place in the same PR (the feat-719 gate-block trap, #725 note 1). pending-count has NO entry \u2014 its queries are directly scoped; the migration must not add one",
    29	    "The stale D6 comments in draft-status/route.ts and load-replies.ts cite '#680 item' for a consolidation #680 never did \u2014 they are rewritten as part of the migration",
    30	    "past-replies/draft-status/route.ts (added by #726, after #725's 6-file table was drawn) carries an inline projected EXISTS \u2014 it joins the migration set, making it 7 files / 8 inline spellings"
    31	  ],
    32	  "existing_patterns_to_follow": [
    33	    "src/lib/shared/response-status-sql.ts (statusArraySql) \u2014 the house pattern for a composable Postgres.js SQL fragment builder, already interpolated by draft-status/route.ts",
    34	    "src/lib/moderation/held-draft.ts contract-header comment style \u2014 the divergence note extends it",
    35	    "Postgres.js nested-Query splicing (lab-notes #573/#706 mechanic) \u2014 fragments compose into LATERAL/correlated contexts as raw SQL text"
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
    59	    "property: projected held and filtered visibility agree for every flag-row status combination",
    60	    "hasOpenFlag executes the UUID-parameter fragment against live Postgres",
    61	    "getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged",
    62	    "per-business and account-grouped pending counts exclude the same open-held rows across two businesses",
    63	    "each draft-status awaited query projects held from its correctly correlated response alias",
    64	    "the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned",
    65	    "all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains"
    66	  ],
    67	  "verification_commands": [
    68	    "pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts"
    69	  ],
    70	  "estimated_prod_lines": "\u00b1140 (held-draft.ts +~45 incl. divergence comment block; 8 spelling swaps net-negative ~-25 code; D6 comment rewrites; ~8 allowlist snippet lines regenerated). Code is net-negative; the divergence comment block offsets some of it in raw line count",
    71	  "estimated_test_lines": "\u00b1450 (eleven promised titles incl. live hasOpenFlag verification, fast-check property on an isolated business, grouped-count cross-business guard, alias/placement pins, source-scan; plus churn in SQL-text-pinning mock suites upgraded to fragment-aware doubles) \u2014 corrected from \u00b1300 after plan-review round 1",
    72	  "dependencies_added": [],
    73	  "rollback_plan": "No migration, no flag, no schema touch \u2014 db_touching covers read-query text only. Back out = revert the squash-merge commit on main; nothing to unwind in either Supabase project",
    74	  "observability": [
    75	    "No new runtime signal \u2014 semantics-preserving refactor. A regression would surface as held drafts appearing in owner reads (invariant #4 leak); guarded pre-merge by the two live-DB integration suites + the D9 projected assertions + ci:tenant-scope/ci:rls-audit green, not by a new prod metric. Post-deploy staging smoke: pending count and Reviews list for a location with a known held draft match pre-deploy values"
    76	  ],
    77	  "open_questions": []
    78	}
     1	# feat-730-open-flag-consolidation — deviations log
     2	
     3	Entries the plan did not anticipate, one per item. Step 6 triages each with
     4	ACCEPT / RE-PLAN before review.
     5	
     6	## Setup-time notes
     7	
     8	- **[2026-08-09] Surface overlap with `feat-719-drip-dropped-column` on
     9	  `scripts/ci/tenant-scope-allowlist.ts` — no entry collision, merge order
    10	  agreed.** feat-719's diff touches only the `ONBOARDING_DRIP_CANDIDATES_SQL`
    11	  constant (~line 130); #730 regenerates entries in the load-replies /
    12	  dashboard / draft-status / agents-read regions (lines ~550–1300+, ~3040).
    13	  Disjoint hunks. Agreed order: PR #740 merges first (CI-green, auto-merge
    14	  armed since 11:17a); #730 rebases onto main before opening its PR if #740
    15	  has landed by then. feat-719's deviations file was deliberately NOT
    16	  updated: its PR is at the finish line and its worktree must stay clean for
    17	  `feature-cleanup.sh` to sweep it — this file is the single record of the
    18	  agreement.
    19	
    20	## Plan-review round 1 (codex, VERDICT: REVISE) — intake corrections
    21	
    22	Owner-approved intake-field corrections (NOT surface amendments; the
    23	amendment counter is untouched — `allowed_edit_surface` is unchanged):
    24	
    25	- **[2026-08-09] `edge_cases` wrongly listed pending-count among the
    26	  regenerating allowlist entries** → corrected to the six real entries
    27	  (~327/~1285/~1509/~1516/~1530/~1537); pending-count is directly scoped and
    28	  has NO entry (codex MINOR).
    29	- **[2026-08-09] `tests_to_add` grew 5 → 11 titles** after codex named six
    30	  missing failure modes as missing tests (live hasOpenFlag verification,
    31	  newest-unheld fallback, grouped-count cross-business guard, alias
    32	  correlation, LATERAL placement/polarity, source-scan). One partial-accept:
    33	  the dashboard-LATERAL finding asked for live behavior coverage; a live
    34	  dashboard-service suite was rejected as disproportionate — unit
    35	  placement/polarity pins + the live property on the identical filtered
    36	  composition (pending-count) cover the named regressions. Both intake copies
    37	  updated; `estimated_test_lines` corrected ±300 → ±450.
    38	- **[2026-08-09] v1 plan's mock claim was factually wrong** (queue-based
    39	  route doubles would consume queued rows on fragment-build calls) and the v1
    40	  property test was unrunnable (`loadReplies` does not exist; suite baseline
    41	  counts non-zero). Plan v2 fixes both — fragment-aware double pattern,
    42	  `loadPastRepliesPageView` + isolated business. T6 parallelism dropped
    43	  (shared Git index, `git add -A` hazard) — all tasks serial, path-scoped
    44	  staging.

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
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba docs/reviews/feat-730-open-flag-consolidation/plan-review-round1.md | sed -n '1,260p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
     1	Reading additional input from stdin...
     2	OpenAI Codex v0.145.0
     3	--------
     4	workdir: /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
     5	model: gpt-5.6-sol
     6	provider: openai
     7	approval: on-request
     8	sandbox: read-only
     9	reasoning effort: high
    10	reasoning summaries: none
    11	session id: 019fe8b1-3979-79e2-9e7d-aee1822460bb
    12	--------
    13	user
    14	You are the adversarial plan reviewer for a high-risk refactor in this repo
    15	(worktree root = your cwd). Review ONLY — do not modify anything.
    16	
    17	## What to review
    18	
    19	1. The implementation plan:
    20	   docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
    21	2. The locked intake contract:
    22	   docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json
    23	3. The research deliverable it builds on: GitHub issue #725's closing comment
    24	   is summarized inside the plan's "Verified planning facts" — treat the plan's
    25	   claims as claims to verify against the actual code, not as truth.
    26	
    27	## Primary question — the eval task
    28	
    29	The PRIMARY review target is Task 1 (the eval task), not the plan prose:
    30	**can this eval pass while the feature is still wrong?** Every missing failure
    31	mode must be named as a MISSING FAILING TEST (concrete title + what it pins),
    32	not as a prose objection. Specifically probe:
    33	
    34	- The behavior-pinning tests are green BEFORE the refactor by design. What
    35	  regression could the migration introduce that NONE of the five tests (nor
    36	  the existing suites) would catch? Think: fragment renders subtly wrong SQL
    37	  in one composition context but not another (projected vs filtered vs
    38	  parameter-correlated); the anti-join → NOT EXISTS rewrite in
    39	  src/lib/agents/read.ts; the two pending-count spellings; LATERAL contexts.
    40	- The property test's agreement claim (projected held ⇔ excluded from pending
    41	  count) — is there a flag-status combination or multi-response scenario where
    42	  the two legitimately disagree, making the property either vacuous or flaky?
    43	- Mock-double blindness: unit suites capture template text; after migration the
    44	  EXISTS text moves into a separate captured call. Could a migration task
    45	  silently DELETE an assertion instead of relocating it and still go green?
    46	
    47	## Secondary checks
    48	
    49	- CITED-ARTIFACT CHECK (mandatory): verify every file, line range, symbol, and
    50	  test fixture the plan cites actually exists in the tree as described. That
    51	  includes: src/lib/moderation/held-draft.ts (hasOpenFlag), the 8 inline
    52	  spellings at the cited files/lines, scripts/ci/tenant-scope-allowlist.ts
    53	  entries near lines 327/1285/1509/1516/1530/1537 with the cited table: keys,
    54	  ALLOWLIST_BASELINE = 409, scripts/ci/tenant-tables.ts NOT containing
    55	  flagged_responses, migration 051's CHECK status list, the
    56	  REVIEW_HELD_REPLACEMENT fixture in
    57	  src/lib/past-replies/__tests__/load-replies.integration.test.ts, the mkTx
    58	  double in src/lib/moderation/__tests__/held-draft.test.ts, and
    59	  statusArraySql in src/lib/shared/response-status-sql.ts.
    60	- Postgres.js mechanics: does nested-fragment splicing behave as the plan
    61	  assumes in ALL cited composition contexts (projected in a LATERAL SELECT
    62	  list, `AND NOT ${...}`, and `WHERE ${...}` with a parameter-carrying ref
    63	  fragment)? Is `SELECT 1 AS one WHERE EXISTS(...)` (no FROM) valid and
    64	  equivalent to the current hasOpenFlag body?
    65	- Plan-level: simpler alternatives, wrong assumptions, task-ordering hazards
    66	  (T3/T4/T5 serialized on the allowlist file; T6 parallel), and whether any
    67	  task could leave the branch red in a way the next task masks.
    68	
    69	## Output format (strict)
    70	
    71	1. A findings table: severity (BLOCKER/MAJOR/MINOR) | artifact | one-line finding.
    72	   Only findings you would stake >=80% confidence on; each with a concrete
    73	   failure scenario or a named missing test title.
    74	2. A short low-confidence appendix (optional).
    75	3. The LAST line must be exactly `VERDICT: APPROVED` or `VERDICT: REVISE`.
    76	hook: SessionStart
    77	hook: SessionStart Completed
    78	hook: UserPromptSubmit
    79	hook: UserPromptSubmit Completed
    80	codex
    81	I’m using the `verify-spec` workflow because this is an evidence-backed plan audit. I’ll keep the repository read-only and put Task 1’s missing failure modes ahead of prose-level critique.
    82	hook: PreToolUse
    83	hook: PreToolUse
    84	hook: PreToolUse Completed
    85	hook: PreToolUse Completed
    86	exec
    87	/bin/zsh -lc "sed -n '1,240p' .agents/skills/verify-spec/SKILL.md && sed -n '1,280p' .claude/CLAUDE.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
    88	 succeeded in 0ms:
    89	---
    90	name: verify-spec
    91	description: Audit a spec, plan, or launch-readiness doc against the actual codebase and emit an evidence-backed per-item verdict table plus an overall PASS/FAIL. Use when the user asks to verify, audit, or confirm that a spec/plan/checklist/launch doc was implemented, or asks "what's remaining" on a checklist. Verify-and-report only — it never implements fixes.
    92	---
    93	
    94	# Verify Spec Against Codebase
    95	
    96	Audit-only skill. You verify and report; you do NOT implement, fix, or edit the
    97	spec docs. The user decides what happens with the findings.
    98	
    99	## Inputs
   100	
   101	`$ARGUMENTS` = one or more spec/plan/checklist doc paths. If none given, ask
   102	which doc(s) to verify — do not guess.
   103	
   104	## Procedure
   105	
   106	1. **Read the doc(s) and extract every verifiable claim** — checklist items,
   107	   "must/should" statements, audit ticks, acceptance criteria. Number them.
   108	   Ignore narrative prose with no testable assertion.
   109	
   110	2. **Set up the incremental findings file** at
   111	   `/tmp/verify-spec-findings-<docname>.md`. Append findings per item as you
   112	   go — never accumulate the whole audit for one giant final message (large
   113	   audits have hit output-token limits before).
   114	
   115	3. **Verify each item against reality, not against other docs.** Evidence
   116	   hierarchy, strongest first:
   117	   - code inspection at a specific `file:line` (prefer codebase-memory-mcp
   118	     graph tools for structural questions — who-calls-X, routes, call chains)
   119	   - `git log`/`git diff` showing the change landed on `main`
   120	   - a passing test that pins the behavior
   121	   - migration applied (check `.claude/reference/migrations-log.md` head)
   122	   A tick in another doc is NOT evidence. Mark each item:
   123	   - `VERIFIED` — concrete evidence found
   124	   - `PARTIAL` — implemented but incomplete vs. the claim (say what's missing)
   125	   - `MISSING` — no evidence of implementation
   126	   - `STALE` — doc claims something the code contradicts (flag for doc fix)
   127	
   128	4. **For audits over ~15 items, fan out**: split items into sections and
   129	   dispatch one Explore subagent per section, each returning a compressed
   130	   `item | status | evidence` block. Verify any surprising MISSING/STALE
   131	   finding yourself before reporting it.
   132	
   133	5. **Run the validation suite** (skip any the turn already ran):
   134	   - `pnpm lint && pnpm typecheck && pnpm test`
   135	   - if any item touches DB/schema: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
   136	   - if any item touches analytics or flags: `pnpm ci:analytics-events && pnpm ci:static-policy`
   137	
   138	6. **Emit the mandatory output contract.** The final message MUST end with:
   139	
   140	   ```
   141	   | # | Item | Status | Evidence |
   142	   |---|------|--------|----------|
   143	   | 1 | ...  | VERIFIED | src/lib/foo.ts:42 |
   144	
   145	   Suite: lint PASS | typecheck PASS | test PASS (NNN) | audits PASS/SKIPPED
   146	
   147	   VERDICT: PASS            # every item VERIFIED and suite green
   148	   VERDICT: FAIL — <n> items remaining: <numbered list of MISSING/PARTIAL/STALE>
   149	   ```
   150	
   151	   No audit ends without a `VERDICT:` line. "Ran out of things to check" is
   152	   not a verdict.
   153	
   154	## Rules
   155	
   156	- Evidence before assertions — never mark VERIFIED from memory or doc ticks.
   157	- Report STALE doc ticks; do not silently fix them (verify-and-report only).
   158	- If the working tree is dirty, say so up front — audit `main`/HEAD state and
   159	  note which findings could be affected by uncommitted changes.
   160	# RepWorth — Claude Code Context
   161	
   162	## What this project is
   163	
   164	Agentic reputation-management platform for SMBs, sold as **Copilot** (owner approves everything) and **Autopilot** (bounded autonomy) subscription tiers. Three customer personas — **Reply** (drafts every response; auto-posts positive-quadrant on Autopilot), **Guardian** (triage + escalation; never acts publicly), **Insights** (weekly digest) — supervised by two watchdogs: the **Judge** (LLM review of 100% of auto-posts; availability is a posting precondition) and the **Governor** (per-account autonomy suspension). Design of record: `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §8. Next.js 16 (Vercel, UI only) + Railway worker (Fastify + BullMQ, all LLM/external/long-running work) + Supabase/PostgreSQL + Redis(Upstash for Cache/Railway Redis for Queue).
   165	
   166	Pipeline: Zernio webhook ingest → Guardian triage (`TRIAGE_ENABLED`, negative lane only) → AI draft → moderation → owner notification/approval, or gated `auto_policy` approval + veto window behind `AUTO_APPROVAL_ENABLED=true` → posted to Google → Judge verdict. Every persona action is recorded on the run spine (`agent_runs`/`agent_run_steps`/`agent_outcomes`) via the single writer `src/lib/agents/run-spine.ts`.
   167	
   168	## Dev commands
   169	
   170	- `pnpm worker` — Railway worker via tsx (port 3001); `pnpm dev:all` — full stack
   171	- `pnpm worktree:new <branch> [base-ref]` — create an **isolated sibling worktree** outside the repo (own `node_modules`, copied `.env*.local`), then `cd` into the printed path. Use this for parallel feature branches; see "CI & repo" for why sibling not nested.
   172	- `pnpm test:integration` — **hard-gates only the publisher edit-existing-reply suite** (fails fast without `TEST_DATABASE_POOL_URL`); other integration suites run only when invoked directly — see gotcha below
   173	- `pnpm test:db:setup` — provision the local test DB to migrations head (bootstrap + every migration, local-only, drops schema `public` first). Run it once after creating the container and again whenever a migration lands: live-DB suites **assert** their schema (`assertSchemaReady`) instead of applying migrations, so a behind-head DB fails loudly rather than self-healing.
   174	- `pnpm test:e2e` — Playwright E2E (skips gracefully without TEST_DATABASE_POOL_URL)
   175	- `pnpm eval:llm` — LLM safety eval harness (offline/keyless by default; `--live` needs provider keys)
   176	- `pnpm ci:*` — the CI audit scripts. The `ci:` entries in package.json are the authoritative list; do not keep a second copy of it here. Wiring, enforced by `src/__tests__/ci-audit-wiring.test.ts` (#590): the `lint` CI job runs every one of them **except** `ci:fallow:coverage`, which runs in its own `fallow.yml` job, and `ci:fallow`, which is the developer-facing sweep and gates nothing; `lefthook.yml` mirrors every audit the `lint` job runs. `ci:static-policy` enforces invariants #10, #13, #14; `ci:live-db-suites` enforces the two live-DB test conventions (see the gotcha below); `ci:outbox-status` enforces the `job_outbox` in-flight status vocabulary (invariant #2).
   177	- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass all external APIs locally
   178	
   179	## CI & repo
   180	
   181	- Repo **`RepWorth/ai-review-responder`**; `main` is protected — **land changes via PR**, direct pushes rejected.
   182	- CI (`.github/workflows/ci.yml`): `lint` (also runs the `ci:*` audit scripts — see "Dev commands" for which, and `src/__tests__/ci-audit-wiring.test.ts` for the check that keeps package.json, the workflows, and `lefthook.yml` from drifting apart), `typecheck`, `test`, `llm-eval` (path-filtered LLM-safety eval release gate — WS7), `build` on every PR + push to `main`. `MOCK_EXTERNAL_APIS=false` in CI — `true` short-circuits Zernio transport and breaks real-path tests. Third-party actions pinned to commit SHAs.
   183	- **Local pre-push hook (`lefthook.yml`)** runs the cheap CI subset before code leaves the machine — lint, typecheck, every CI audit, and affected tests (`vitest --changed`), in parallel. Same commands as CI; CI stays the full-suite gate. Installed via the `prepare` script on `pnpm install`. Escape hatch for WIP: `git push --no-verify`.
   184	- **Worktrees: sibling (blessed) vs nested (footgun).** Use `pnpm worktree:new <branch>` (→ `scripts/new-worktree.sh`) — a sibling worktree at `../RepWorth-worktrees/<branch>/` with its own `node_modules` + copied `.env*.local`, so local lint/test/typecheck give a trustworthy signal. Nested worktrees (`.claude/worktrees/`, harness `EnterWorktree`, Agent `isolation:'worktree'`) leak the parent's deps/ESLint config into local CI — fine for edit+typecheck agents, never for trustworthy full CI. Every Write/Edit path must point at the worktree root, never the parent checkout (hook-enforced by `edit-surface-guard.sh`). Cleanup procedure + full mechanics: lab-notes "Worktrees — sibling vs nested".
   185	
   186	## Environments & branches
   187	
   188	Trunk-based: `main` is the source of truth. Two long-lived branches — `main` (prod) and `staging` (integration anchor for the persistent staging env); "preview" is any open PR's auto-deploy, not a branch. Topology, URLs, concrete IDs: `docs/runbooks/deployment-guide.md`.
   189	
   190	- **Three lanes.** *Preview* — per-PR, Vercel UI only (no worker/queue/webhooks → frontend checks only). *Staging* — persistent full stack, test/sandbox creds + separate Supabase; **the only non-prod place the whole pipeline runs**. *Production* — `main`, live creds.
   191	- **Promotion = merge the PR into `main`.** `staging` is not a promotion gate — never "merge `staging` → `main`". Anything touching the worker, a webhook, a migration, or billing rides `staging` first, then lands on `main` via PR.
   192	- **After promotion, fast-forward `staging` onto `main`** (`git merge --ff-only main`) so it never drifts. Migrations run against **both** Supabase projects in lockstep, **staging first**; "applied to prod, not staging" is a bug. **Standing exception until the prod WS8 cutover:** migration 078 is deliberately absent in prod — it applies *inside* the cutover (`docs/runbooks/ws8-tier-cutover.md`); do NOT apply it out-of-band. All autonomy flags are OFF in prod; ordered go-live flip per design doc §8.4.
   193	- **Push to `staging` auto-deploys the full staging stack.** Both the Railway staging worker **and** the Vercel staging Custom Env redeploy on push (the Vercel deploy is git-sourced `target:staging`; verified 2026-06-02). Vercel previews still auto-deploy per PR. To rebuild the staging UI without a push, deploy the custom env explicitly (`POST /v13/deployments` with `target:"staging"` + `gitSource:{ref:"staging"}`) — see `deployment-guide.md` Phase 3.
   194	- **CI gates PRs + push-to-`main`, NOT `staging` pushes** — rely on the PR's CI before promoting.
   195	- **Local `main` lags after GitHub squash-merges** — `git pull --ff-only` (then `pnpm install` if deps changed).
   196	
   197	## Architecture invariants — NEVER violate these
   198	
   199	1. **Vercel = UI only.** LLM calls, external API calls, and long-running operations run on Railway workers, never in Next.js routes. Exception (ADR 0001): Next.js routes may make short, user-blocking OAuth-handshake calls when they must set/clear cookies or return a redirect synchronously (Zernio connect callback + select-location). Durable recovery and long-running work stay on Railway. ESLint-enforced: `src/app/**`, `src/components/**`, and `src/instrumentation.ts` may not runtime-import `openai`/`@anthropic-ai/sdk`/`bullmq`/`postgres`/the response generator/the worker queue registry (type-only `import type` allowed; tests exempt); guarded by `src/__tests__/eslint-boundaries.test.ts`.
   200	
   201	2. **Transactional outbox.** State change + follow-up work go in ONE Postgres transaction via `job_outbox`. Never write Postgres then separately enqueue BullMQ — silent data loss on enqueue failure.
   202	
   203	   > Enqueue via a typed helper for a NEW single-row topic. Raw `INSERT INTO job_outbox` is sanctioned for: set-based `INSERT … SELECT … FROM` fan-out; a dedup/payload variant the helper does not model; a topic with no helper (18 of 32 topics today — do not backfill on spec). The in-flight status set is guarded by `ci:outbox-status`.
   204	
   205	   > **A topic that HAS a helper must use it** — a single-row raw INSERT for a helper-owned topic fails `ci:outbox-seam` (#568). Helper coverage is derived from `job-outbox-helpers.ts` itself, so writing `enqueueNotifyAdmin` turns all 6 raw `NOTIFY_ADMIN` sites red until they migrate in that same PR; a topic never has two live enqueue owners. Escape hatch is a per-line `-- outbox-seam-ignore: <reason>` (one use today). "Fan-out" means a row-producing top-level `FROM`, NOT merely containing `SELECT` — `enqueueValidatePlaceId` is itself an `INSERT … SELECT … WHERE NOT EXISTS` that inserts one row.
   206	
   207	   The in-flight set `('pending', 'dispatching', 'dispatched')` is a **byte-for-byte contract** owned by `src/lib/shared/job-outbox-status.ts`, not a value to re-derive. It cannot be parameterized — a bind parameter inside an `ON CONFLICT … WHERE` defeats partial-index inference — so every site re-spells it by hand and `ci:outbox-status` checks members **and order**. Migration 018 exists solely because 004 shipped it missing `'dispatching'`.
   208	
   209	3. **No unapproved posting.** A response may reach Google only after an explicit approval method is recorded: `approval_method='owner'` from an owner action, or `approval_method='auto_policy'` from the server-only auto-approval runtime. Auto-policy approval is disabled by default (`AUTO_APPROVAL_ENABLED=false`) and is allowed only for `live_ingest_new` v1 jobs that pass current-state, subscription, active-location/connection, review-hash, policy-threshold, provider-moderation, and triage-veto gates — plus the trust dial (rating band + daily cap), the 15/30-min veto window, and the **Autopilot tier** (`tierGrantsAutopilot`). **Judge availability is a posting precondition:** `JUDGE_ENABLED=false` or judge unavailability makes `ResponsePublisherWorker` downgrade unposted auto-policy rows to owner review — same as flipping the runtime flag off before publish.
   210	
   211	   > Auto-approval skips only the owner step. Moderation remains an absolute veto; high-severity drafts are held and never auto-approved.
   212	
   213	4. **High-confidence unsafe drafts are held, not notified.** After generation `ResponseGeneratorWorker` runs `moderateResponse`; a `high`-severity flag writes a `flagged_responses` row (admin-only deny-all RLS) and skips the `send_notification` enqueue in the SAME transaction as response persistence. Re-notify only via admin `approved_for_owner_review` at `/admin/flagged`. Full flow (admin actions, `api_costs` metadata, `OPENAI_MODERATION_ENABLED` fail-open, local regex filter): the `approval-security` skill.
   214	
   215	5. **Approval tokens never stored raw.** Only SHA-256 hashes in `approval_links`. Raw tokens exist only in memory and in the approval link sent over the owner's notification channel — never in Postgres, outbox payloads, or logs.
   216	
   217	6. **Third-party ingress terminates on Railway.** Stripe, Resend, Twilio, Zernio webhooks hit `worker/ingress/*`. Do NOT proxy through Next.js except in local dev with an explicit comment.
   218	
   219	7. **ReviewSource contract.** All sources normalize to `NormalizedReview` DTO. No source-specific fields leak into the prompt builder.
   220	
   221	8. **Auth scope is app-enforced.** `users.auth_id` maps to Supabase Auth identity. Browser code never receives `SUPABASE_SERVICE_KEY`. Every owner read/write scoped by `account_id` (billing parent) and, per-location, `business_id` (= one Google Business Profile location).
   222	
   223	9. **`businesses` row = location; `accounts` row = billing parent.** Don't re-introduce subscription columns on `businesses`. Two sub-rules: (a) billing snapshot reads STORED quota + price from `accounts` (`locations_included`, `locations_overage_price_cents`, `base_price_cents` — point-in-time, grandfathered via migration 054), not live `TIER_CONFIG` values; (b) multi-location settings use three distinct checks — `shouldUseMultiLocationSettings` (mode: count > 1), `shouldShowLocationsSettings` (visibility: flag only), `canAddLocationForAccount` (eligibility: flag + active + `multiLocAllowed`) — never collapse to one boolean.
   224	
   225	10. **Use Node.js native crypto.** `import { createHash, randomUUID } from 'node:crypto'`. Never `crypto-js` (CI-enforced: `ci:static-policy`).
   226	
   227	11. **Subscription guard in all customer-facing workers.** Check status early: `cancelled` → no-op; `past_due` → 7-day grace; `pending_payment` → NotificationWorker and ResponsePublisherWorker skip (ResponseGenerator allowed for admin demo drafts); `trialing` (card-up-front 30-day trial, migration 069, flag `TRIAL_ENABLED`) → **full access, treated like `active`** everywhere EXCEPT recurring paid ranking tracking (SerpAPI stays active-only). Gate entitlement on `subscriptionGrantsFullAccess(status)`, never a raw `=== 'active'`. Stripe is the source of truth — `worker/ingress/stripe/apply-subscription-state.ts` is the single status applier.
   228	
   229	12. **Entry points orchestrate; modules own failure behavior.** Route handlers, worker boot files, and ingress handlers may validate, orchestrate, and map errors — extract any error-handling branch over ~30 lines into a named module with focused tests.
   230	
   231	13. **Feature flags are server-authoritative.** The browser learns flag state via API responses. Never add a `NEXT_PUBLIC_*` companion for a feature flag — `ci:static-policy` allowlists every `NEXT_PUBLIC_*` and fails CI on any new one.
   232	
   233	14. **Auto-approval policy access is server-owned.** Browser/client code never reads or writes `auto_approval_policies` directly through Supabase. Owner settings must flow through server routes, and `ci:static-policy` blocks client components that reference the table.
   234	
   235	15. **Domain modules receive their DB client as an explicit parameter.** Business-logic modules under `src/lib/**` and worker helpers take `sql: Sql` / `supabaseServer` (or `tx: TransactionSql` inside a transaction) as an explicit parameter — they never import `@/lib/db/server`. Only **composition roots** import the singleton and pass it down: route handlers (`src/app/**/route.ts`), server-component pages/layouts, `worker/index.ts`/`queues.ts`, worker job handlers + pollers/schedulers **registered in `worker/index.ts`** (root status is derived from that registration, not file position), ingress, `src/lib/db/server.ts` (the owner) and `src/lib/db/auth.ts` (the owner-classified auth gate). CI-enforced strict by `ci:db-imports` (`scripts/ci/db-imports-audit.ts`) — baseline deleted, any non-root importer fails. `jsonb(x)` is composition-root-only; domain modules use `tx.json(x)`.
   236	
   237	## Working rules
   238	
   239	- Route handlers, server actions, and worker boot files orchestrate only: parse input, call one module function, return output — no business logic.
   240	- Verify before claiming done: `pnpm lint && pnpm typecheck && pnpm test`. DB-touching changes also run `pnpm ci:tenant-scope` and `pnpm ci:rls-audit`.
   241	- Always write tests for: webhook handlers, billing math, idempotency keys, tenant-scoped queries, approval-token paths, outbox transitions, subscription guards.
   242	- Every outbound provider call (Stripe, Resend, Twilio, Zernio, SerpAPI, OpenAI, Anthropic) gets an explicit timeout + bounded, jittered retries. Every BullMQ handler is idempotent — the key is the deterministic outbox key, not the BullMQ job ID. Webhook handlers verify the signature FIRST and persist raw payload + provider event ID for replay.
   243	- No `any` (JSONB carve-out excepted — use `unknown` and narrow). No silent catches. No string literals for subscription status, tier IDs, job names, or review status — import the constant from its single authoritative TS file.
   244	- No new top-level directories, no near-duplicate dependencies, no abstractions for a single caller, no npm/yarn lockfiles. Default is "no new file" — check `docs/directory.md` first.
   245	- When deleting a doc or ticking a checklist item, fix its audit tick and grep the filename to clean every cross-reference in the same change.
   246	
   247	## Where things live
   248	
   249	Detailed inventories load on demand — read the matching file before the work:
   250	
   251	| Before you… | Read |
   252	|---|---|
   253	| write or debug a migration / touch schema | `.claude/reference/migrations-log.md` |
   254	| add an env var or flip a feature flag | `.claude/reference/env-vars.md` |
   255	| touch review ingestion / add a ReviewSource | `.claude/reference/review-ingestion.md` |
   256	| touch the **agentic platform** (run spine `agent_runs`/`agent_run_steps`/`agent_outcomes`, personas Reply/Guardian/Insights, triage, trust dial + veto window, judge, governor, Copilot/Autopilot tiers) or **plan Phase 2 (run engine + Solicitation agent)** | design of record `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` — **§8 As-built status is the entry point** (what shipped WS1–WS8, deltas, gates, what's deliberately unbuilt) → per-WS specs in `docs/superpowers/specs/2026-07-*-ws*-design.md` + WS1 plan `docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (has the WS1–WS8 decomposition) + staging proof in `docs/runbooks/evidence/2026-07-2*-agentic-*.md` |
   257	| build or debug owner offboarding (cancel_only / delete_data / purge) | spec `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md` + runbook `docs/runbooks/owner-offboarding-staging-dry-run.md` |
   258	| build or debug multi-location (locations lifecycle, per-location overage billing, account-level digests, channel overrides) or run the two-location full-loop | spec `docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md` + plan `docs/superpowers/plans/2026-06-09-multi-location-hardening.md` + runbook `docs/runbooks/multi-location-e2e-full-loop.md` |
   259	| roll out / test the Telegram + WhatsApp channels, the auto-approved post FYI (`auto_post_notice` topic, `worker/jobs/auto-post-notice/`), or its `/r/google/<id>` redirect | runbooks `docs/runbooks/channels-rollout.md` (prod flip) + `docs/runbooks/channels-staging-smoke-test.md` (staging test) + `docs/runbooks/whatsapp-templates.md` (template content) + ADR `docs/adr/0003-conversational-channel-seams.md` (future-agent seam) |
   260	| touch **review import consent** (the Import offer, `import_decision`, the derived-expiry predicate, or any of the four enqueue gates) | spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` (§2 decision table D1–D10 is **locked**) + ADR `docs/adr/0015-consented-import-unflagged-replacement.md` + ADR `docs/adr/0016-import-consent-enforcement-locus.md` (enforcement locus — why not a `job_outbox` trigger) + `CONTEXT.md` → **Review import**, **Import consent**, **Import offer**, **Import window**, **Live-ingest cutoff**. `src/lib/reviews/import-consent.ts` is the SINGLE owner of the predicate and of every consent write — including `enqueueInitialImport`, which all four producers delegate to; do not re-spell its guard. Enforcement is at the four producers **and, since #679, at the chokepoint**: `guardImportConsent` (`worker/jobs/zernio/job-eligibility.ts`) is a fail-closed pre-flight in `ZernioBackfillWorker` that proceeds only on `accepted` — so a hand-inserted `zernio_initial_backfill` row no-op-completes with a logged reason instead of importing. It is deliberately a SEPARATE function from `guardZernioJobEligibility` (a merged guard would have two callers, one of which must never reach consent code), and its whole body must stay inside `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)` — without that serialization an owner's accept races the guard into silent permanent data loss. Enqueue-path inventory: `.claude/reference/review-ingestion.md`. |

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'rg -n "BLOCKER|MAJOR|MINOR|VERDICT|LATERAL|MISSING FAILING TEST|loadReplies|alias|todo|queue|parallel" docs/reviews/feat-730-open-flag-consolidation/plan-review-round1.md | tail -100' in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
555:  (side-effect-free — unit-testable without booting the queues).
609:- **Data/infra**: `psql` (Postgres direct), `redis-cli` (cache/queue), `docker`
681:    54	  the queued rows, but `toHaveLength(1)`-style call-count assertions and
721:    94	  predicate) — may run in parallel with the T3–T5 chain after T2.
735:   108	refactor); the fragment-rendering test is a `.todo` stub until T2 fills it.
737:   110	`promised-tests` row checks titles, `.todo` included).
758:   131	  it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
774:   147	    const view = await loadReplies(sql(), businessId, 1);
784:   157	(The exact projected field the suite can see depends on what `loadReplies`
810:   183	        const view = await loadReplies(sql(), businessId, 1);
848:   221	- [ ] **Step 4: run — pinning tests GREEN, stub todo**
855:   228	Expected: all green (1 todo). If the live-DB suites fail on schema, run
870:   243	- [ ] **Step 1: fill the `.todo` test (red)**
872:   245	Replace the `.todo` with (mkTx captures the fragment build as its own call):
945:   318	//     subject is the FLAG ROW itself (disposition by id, queue enumeration,
993:   366	      -- composed into a LATERAL — so the predicate is spelled inline here (D6);
995:   368	      LEFT JOIN LATERAL (
1013:   386	      LEFT JOIN LATERAL (
1083:   456	correlated ref is the unaliased table: `responses.id`).
1109:   482	Both LATERALs keep their two comments (tenant-scope + held-drafts rationale);
1125:   498	(correlated ref is the unaliased `responses` table in both LATERALs; use each
1158:   531	### Task 6: `agents/read.ts` — anti-join → NOT EXISTS (parallel-safe with T3–T5)
1204:   577	allowlist work in this task, which is what makes it parallel-safe.)
1237:     7	    "No change to the 8 deliberately-distinct consumers: admin disposition (/api/admin/flagged), admin queue (flagged-service), admin badge (nav-counts-service), health-alert backlog check, offboarding purge-verification + purge-stages + table-disposition, and the producer (response-generation/persist.ts keeps its module-local FLAGGED_RESPONSE_STATUS_OPEN)",
1257:    27	    "The fragment's correlated ref must compose in three contexts: qualified column refs (resp.id, resp2.id, responses.id) inside LATERAL/correlated subqueries, and hasOpenFlag's ${responseId}::uuid parameter — ref parameter is a Postgres.js fragment, not a string",
1265:    35	    "Postgres.js nested-Query splicing (lab-notes #573/#706 mechanic) — fragments compose into LATERAL/correlated contexts as raw SQL text"
1543:     7	// schema: the LEFT JOIN + four LATERALs compile, `ORDER BY (resp.id IS NOT NULL)`
1669:   133	// Status literals are spelled inline the same way the loader's LATERAL spells
1835:     4	// Excludes held/flagged drafts (the admin queue owns those). Used by BOTH the
3061:    16	import { QUEUE_NAMES } from '@/lib/shared/queue-names';
3858:    10	// **Needs Action** queue at `dashboard/reviews`.
3866:    18	// own terms — a red test beats a todo.
4308:   460	    // they must come from the orphan_sidecar / orphan_superseded LATERALs.
4411:    21	# gets the test DB provisioned SERIALLY before the parallel fan-out.
4412:    22	# `pnpm test:db:setup` drops schema `public` — run as a parallel peer (a #643
4423:    33	# Post-check rows (after the parallel checks):
4510:   120	# Serial DB provisioning — a precondition, never a parallel peer. Fail fast:
4518:   128	      "test-DB provisioning failed (tail .feature/logs/db-provision.log); parallel checks not started."
4593:   203	# (serial, above) — a schema-dropping command can never be a safe parallel
4656:   266	# Rows recorded outside the parallel section (appended after the wait loop so
4665:   275	# Synchronous post-check, appended after the parallel rows.
4743:    63	   * to simulate a query failure. An empty queue yields `[] & { count: 0 }`.
4773:    93	 * return queue. Only awaited queries record into `sqlCalls` and shift
4777:    97	 * same fragment twice re-executes it (records again and shifts the queue again).
4780:   100	 * so transactional code paths share the one queue and call log. The options
4815:   135	        const queued = sqlReturnQueue.shift();
4816:   136	        const result = queued !== undefined ? queued : mkTaggedResult([]);
5029:    16	import { QUEUE_NAMES } from '@/lib/shared/queue-names';
5563:   275	# Synchronous post-check, appended after the parallel rows.
5827:   322	    sqlSnippet: "SELECT a.owner_user_id, a.price_variant, a.stripe_subscription_id, a.subscription_status, a.subscription_tier, a.locations_overage_price_cents, ao.id AS offboarding_id, ao.account_id AS offboarding_account_id, ao.mode AS offboarding_mode, ao.status AS offboarding_status, ao.failed_step AS offboarding_failed_step, ao.access_ends_at AS offboarding_access_ends_at, ao.teardown_started_at AS offboarding_teardown_started_at, ao.purge_after AS offboarding_purge_after, ao.purge_started_at AS offboarding_purge_started_at, ao.purge_cancelled_at AS offboarding_purge_cancelled_at FROM accounts a LEFT JOIN LATERAL ( SELECT active.* FROM account_offboardings active WHERE active.account_id = a.id AND active.terminal_at IS NULL ORDER BY active.created_at DESC LIMIT 1 ) ao ON TRUE WHERE a.id = ${accountId}::uuid",
5854:  1263	    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
5861:  1270	    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
5868:  1277	    reason: "Background scheduler or poller intentionally scans tenant rows globally before enqueueing scoped work.",
5878:  1287	    sqlSnippet: "SELECT r.id AS review_id, r.review_text, r.review_date, r.review_content_hash, r.external_reply_ingested_at, r.star_rating, r.reviewer_name, resp.id AS response_id, resp.approved_text, resp.approval_method, resp.posted_at, resp.version, fail_sidecar.id AS failed_response_id, fail_sidecar.posting_error AS failed_posting_error, draft.id AS draft_response_id, COALESCE(draft.held, false) AS draft_held, (pending_gen.exists IS NOT NULL) AS generation_in_flight, (orphan_sidecar.id IS NOT NULL AND resp.id IS NULL) AS is_orphan, orphan_sidecar.id AS orphan_failed_response_id, orphan_sidecar.posting_error AS orphan_posting_error, orphan_superseded.approved_text AS superseded_text FROM reviews r LEFT JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted' LEFT JOIN LATERAL ( SELECT id, posting_error FROM responses WHERE review_id = r.id AND status = 'failed' AND posting_error LIKE ${deletePfx} ORDER BY created_at DESC LIMIT 1 ) fail_sidecar ON true LEFT JOIN LATERAL ( SELECT resp2.id, EXISTS ( SELECT 1 FROM flagged_responses f WHERE f.response_id = resp2.id AND f.status = 'open' ) AS held FROM responses resp2 WHERE resp2.review_id = r.id AND resp2.status = ANY(${[...NON_TERMINAL_STATUSES] as string[]}::text[]) ORDER BY resp2.version DESC LIMIT 1 ) draft ON true LEFT JOIN LATERAL ( SELECT 1 AS exists FROM job_outbox WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE} AND aggregate_id = r.id AND status IN ('pending', 'dispatching', 'dispatched') LIMIT 1 ) pending_gen ON true LEFT JOIN LATERAL ( SELECT id, posting_error FROM responses WHERE review_id = r.id AND status = 'failed' AND posting_error LIKE ${postAfterPfx} ORDER BY created_at DESC LIMIT 1 ) orphan_sidecar ON true LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS approved_text FROM responses WHERE review_id = r.id AND status = 'superseded' ORDER BY created_at DESC LIMIT 1 ) orphan_superseded ON true WHERE r.business_id = ${locationId} ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}",
5928:  1511	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity FROM reviews rev LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = ${businessId} AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = ${businessId} AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE rev.business_id = ${businessId} AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 10",
5935:  1518	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity FROM reviews rev LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = ${businessId} AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = ${businessId} AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE rev.business_id = ${businessId} AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 10",
5937:  1520	    reason: "Open-escalation badge read (WS3); review_escalations accessed inside a LEFT JOIN LATERAL scoped by e.business_id = ${businessId} (mirrors the resp lateral). Scanner strips SELECT subqueries before predicate analysis. businessId is IDOR-checked in the dashboard route.",
5942:  1525	  // LATERAL subqueries correlated on rev.business_id, which the scanner
5949:  1532	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity, b.id AS location_id, b.name AS location_name, b.display_label AS location_display_label FROM reviews rev JOIN businesses b ON b.id = rev.business_id LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = rev.business_id AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = rev.business_id AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE b.account_id = ${accountId}::uuid AND b.archived_at IS NULL AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 20",
5951:  1534	    reason: "Aggregate recent-reviews feed; responses accessed via LEFT JOIN LATERAL correlated on rev.business_id inside a scan bounded by b.account_id = ${accountId}. Scanner strips SELECT subqueries before predicate analysis.",
5956:  1539	    sqlSnippet: "SELECT rev.id, rev.reviewer_name, rev.star_rating, rev.review_text, rev.review_date, rev.status, resp.response_text, resp.status AS response_status, resp.approval_method, resp.auto_post_scheduled_at, esc.id AS escalation_id, esc.status AS escalation_status, esc.triage_severity AS escalation_severity, b.id AS location_id, b.name AS location_name, b.display_label AS location_display_label FROM reviews rev JOIN businesses b ON b.id = rev.business_id LEFT JOIN LATERAL ( SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at FROM responses WHERE review_id = rev.id AND business_id = rev.business_id AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[]) AND NOT EXISTS ( SELECT 1 FROM flagged_responses fr WHERE fr.response_id = responses.id AND fr.status = 'open' ) ORDER BY version DESC LIMIT 1 ) resp ON true LEFT JOIN LATERAL ( SELECT id, status, triage_severity FROM review_escalations e WHERE e.review_id = rev.id AND e.business_id = rev.business_id AND e.status <> 'resolved' LIMIT 1 ) esc ON true WHERE b.account_id = ${accountId}::uuid AND b.archived_at IS NULL AND rev.status <> ${REVIEW_STATUS.DELETED} ORDER BY rev.detected_at DESC LIMIT 20",
5958:  1541	    reason: "Aggregate recent-reviews feed; review_escalations accessed via LEFT JOIN LATERAL correlated on rev.business_id inside a scan bounded by b.account_id = ${accountId}. Scanner strips SELECT subqueries before predicate analysis.",
6114:   243	      LEFT JOIN LATERAL (
6123:   252	          -- must never surface to the owner UI; the admin queue owns them.
6131:   260	      LEFT JOIN LATERAL (
6156:   394	    LEFT JOIN LATERAL (
6165:   403	        -- must never surface to the owner UI; the admin queue owns them.
6173:   411	    LEFT JOIN LATERAL (
6284:     5	-- the admin queue + disposition actions). Preserves the no-auto-posting
6315:    36	-- Admin queue reads open items newest-first.
6927:src/lib/past-replies/__tests__/reviews-list.test.ts-460-    // they must come from the orphan_sidecar / orphan_superseded LATERALs.
7256:src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts-16-import { QUEUE_NAMES } from '@/lib/shared/queue-names';
8072:worker/jobs/response-generation/persist.ts:6:// flagged_responses row and skips the send_notification outbox enqueue) in the
8110:     7	    "No change to the 8 deliberately-distinct consumers: admin disposition (/api/admin/flagged), admin queue (flagged-service), admin badge (nav-counts-service), health-alert backlog check, offboarding purge-verification + purge-stages + table-disposition, and the producer (response-generation/persist.ts keeps its module-local FLAGGED_RESPONSE_STATUS_OPEN)",
8130:    27	    "The fragment's correlated ref must compose in three contexts: qualified column refs (resp.id, resp2.id, responses.id) inside LATERAL/correlated subqueries, and hasOpenFlag's ${responseId}::uuid parameter — ref parameter is a Postgres.js fragment, not a string",
8138:    35	    "Postgres.js nested-Query splicing (lab-notes #573/#706 mechanic) — fragments compose into LATERAL/correlated contexts as raw SQL text"
8194:| BLOCKER | [Task 1 property](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:162) | The property cannot be green as written: `loadReplies` does not exist, and the suite already seeds two unheld `pending_approval` responses, so the count is baseline `2` and becomes `2/3`, never `0/1`; use `loadPastRepliesPageView` and isolate a business or assert a count delta. |
8195:| MAJOR | [held-draft tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/moderation/__tests__/held-draft.test.ts:10) | **MISSING FAILING TEST — “hasOpenFlag executes the UUID-parameter fragment against live Postgres”**: pin two response IDs plus open/closed transitions; otherwise a parameter-only error such as `::text`, malformed nesting, or invalid no-FROM SQL passes because `mkTx` returns scripted rows. |
8196:| MAJOR | [draft-status route tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:226) | **MISSING FAILING TEST — “each draft-status awaited query projects held from its correctly correlated response alias”**: pin `resp.id` and `responses.id` in fragment-flattened queries; current tests inject `held: true/false`, so deleting the SQL assertion or using the wrong alias can stay behavior-green. |
8197:| MAJOR | [dashboard filtered LATERALs](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/service.ts:243) | **MISSING FAILING TEST — “location and aggregate response LATERALs skip a held newest response and fall back to the newest unheld sibling”**: pins `AND NOT`, `responses.id`, and LATERAL placement; scripted service results would not catch inverted polarity or filtering after `LIMIT`. |
8198:| MAJOR | [account-grouped pending count](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/pending-count.ts:34) | **MISSING FAILING TEST — “per-business and account-grouped pending counts exclude the same open-held rows across two businesses”**: Task 1 calls only the singular spelling, while the grouped suite scripts counts and cannot detect a bad `resp.id` correlation or omitted `NOT`. |
8199:| MAJOR | [timeline integration test](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/agents/__tests__/read.integration.test.ts:236) | **MISSING FAILING TEST — “getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged”**: the planned single-response open/closed case passes even if the rewrite applies `LIMIT 1` before exclusion and incorrectly returns `null` instead of the older unheld response. |
8200:| MAJOR | [promised-tests gate](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/scripts/verify-gate.sh:285) | **MISSING FAILING TEST — “all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains”**: the gate only greps title text and accepts `.todo`, so assertions can be deleted—or the fragment test left todo—while mocked outputs and the promised-tests row remain green. |
8201:| MAJOR | [route SQL doubles](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:41) | The plan’s mock-mechanics claim is false: both route doubles consume their result queue on every fragment-building tag call, so the ref and EXISTS fragments consume the intended row before the outer query; T4 requires fragment-aware doubles, not merely assertion/call-count updates. |
8202:| MAJOR | [Task 5 verification](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:520) | Task 5 migrates the pending-count half of the cross-module property but never reruns that property; a bad singular-count alias can be committed green, remain unseen through T6, and surface only at the final gate. |
8203:| MAJOR | [parallel T6 commit](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:568) | T6 is not parallel-safe in a shared worktree: every task uses `git add -A`, so T6 can stage and commit partially completed T3–T5/allowlist work or contend on the Git index; serialize commits or use isolated worktrees/path-scoped staging. |
8204:| MINOR | [locked intake edge case](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json:28) | The intake says a pending-count allowlist entry regenerates, but no such entry exists; this contradicts Task 5’s correct statement that pending-count is directly scoped and has no entry. |
8210:VERDICT: REVISE
8221:| BLOCKER | [Task 1 property](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:162) | The property cannot be green as written: `loadReplies` does not exist, and the suite already seeds two unheld `pending_approval` responses, so the count is baseline `2` and becomes `2/3`, never `0/1`; use `loadPastRepliesPageView` and isolate a business or assert a count delta. |
8222:| MAJOR | [held-draft tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/moderation/__tests__/held-draft.test.ts:10) | **MISSING FAILING TEST — “hasOpenFlag executes the UUID-parameter fragment against live Postgres”**: pin two response IDs plus open/closed transitions; otherwise a parameter-only error such as `::text`, malformed nesting, or invalid no-FROM SQL passes because `mkTx` returns scripted rows. |
8223:| MAJOR | [draft-status route tests](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:226) | **MISSING FAILING TEST — “each draft-status awaited query projects held from its correctly correlated response alias”**: pin `resp.id` and `responses.id` in fragment-flattened queries; current tests inject `held: true/false`, so deleting the SQL assertion or using the wrong alias can stay behavior-green. |
8224:| MAJOR | [dashboard filtered LATERALs](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/service.ts:243) | **MISSING FAILING TEST — “location and aggregate response LATERALs skip a held newest response and fall back to the newest unheld sibling”**: pins `AND NOT`, `responses.id`, and LATERAL placement; scripted service results would not catch inverted polarity or filtering after `LIMIT`. |
8225:| MAJOR | [account-grouped pending count](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/dashboard/pending-count.ts:34) | **MISSING FAILING TEST — “per-business and account-grouped pending counts exclude the same open-held rows across two businesses”**: Task 1 calls only the singular spelling, while the grouped suite scripts counts and cannot detect a bad `resp.id` correlation or omitted `NOT`. |
8226:| MAJOR | [timeline integration test](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/lib/agents/__tests__/read.integration.test.ts:236) | **MISSING FAILING TEST — “getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged”**: the planned single-response open/closed case passes even if the rewrite applies `LIMIT 1` before exclusion and incorrectly returns `null` instead of the older unheld response. |
8227:| MAJOR | [promised-tests gate](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/scripts/verify-gate.sh:285) | **MISSING FAILING TEST — “all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains”**: the gate only greps title text and accepts `.todo`, so assertions can be deleted—or the fragment test left todo—while mocked outputs and the promised-tests row remain green. |
8228:| MAJOR | [route SQL doubles](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:41) | The plan’s mock-mechanics claim is false: both route doubles consume their result queue on every fragment-building tag call, so the ref and EXISTS fragments consume the intended row before the outer query; T4 requires fragment-aware doubles, not merely assertion/call-count updates. |
8229:| MAJOR | [Task 5 verification](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:520) | Task 5 migrates the pending-count half of the cross-module property but never reruns that property; a bad singular-count alias can be committed green, remain unseen through T6, and surface only at the final gate. |
8230:| MAJOR | [parallel T6 commit](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md:568) | T6 is not parallel-safe in a shared worktree: every task uses `git add -A`, so T6 can stage and commit partially completed T3–T5/allowlist work or contend on the Git index; serialize commits or use isolated worktrees/path-scoped staging. |
8231:| MINOR | [locked intake edge case](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation/docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json:28) | The intake says a pending-count allowlist entry regenerates, but no such entry exists; this contradicts Task 5’s correct statement that pending-count is directly scoped and has no entry. |
8237:VERDICT: REVISE

hook: PostToolUse
hook: PostToolUse Completed
codex
The re-review has narrowed to one disputed item: the dashboard LATERAL coverage. I’m checking whether the proposed unit capture actually covers both location and aggregate queries, and whether the pending-count live test exercises the same SQL context or only the shared predicate semantics.
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg -n \"function create|mockSql|sqlCalls|readQueue|shift\\(|LEFT JOIN LATERAL|recent|feed|aggregate\" src/lib/dashboard/__tests__/service.test.ts src/lib/dashboard/__tests__/aggregate-service.test.ts src/lib/dashboard/__tests__/*.test.ts | head -240" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
rg: src/lib/dashboard/__tests__/service.test.ts: No such file or directory (os error 2)
src/lib/dashboard/__tests__/service.feed-projection.test.ts:15:let mockSql: Sql;
src/lib/dashboard/__tests__/service.feed-projection.test.ts:17:const BUSINESS_ID = 'biz-feed-1';
src/lib/dashboard/__tests__/service.feed-projection.test.ts:37:function recentReviewsQuery() {
src/lib/dashboard/__tests__/service.feed-projection.test.ts:38:  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
src/lib/dashboard/__tests__/service.feed-projection.test.ts:42:  const startMarker = 'LEFT JOIN LATERAL (';
src/lib/dashboard/__tests__/service.feed-projection.test.ts:48:    throw new Error(`Missing ${alias} LATERAL join in recent-reviews query`);
src/lib/dashboard/__tests__/service.feed-projection.test.ts:54:describe('getActiveDashboardData — feed projection', () => {
src/lib/dashboard/__tests__/service.feed-projection.test.ts:57:    mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/service.feed-projection.test.ts:63:    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.feed-projection.test.ts:65:    const query = recentReviewsQuery();
src/lib/dashboard/__tests__/service.feed-projection.test.ts:80:    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.feed-projection.test.ts:82:    const query = recentReviewsQuery();
src/lib/dashboard/__tests__/scope.test.ts:9:/** N pending_approval recentReviews rows (per-location shape). */
src/lib/dashboard/__tests__/scope.test.ts:10:function recentPending(n: number): DashboardDataActive['recentReviews'] {
src/lib/dashboard/__tests__/scope.test.ts:29:  recentPendingCount: number;
src/lib/dashboard/__tests__/scope.test.ts:32:    recentReviews: recentPending(opts.recentPendingCount),
src/lib/dashboard/__tests__/scope.test.ts:47:/** Aggregate payload with one locationKpi per count. recentReviews stays empty. */
src/lib/dashboard/__tests__/scope.test.ts:48:function aggregatePayload(kpiCounts: number[]): AggregateDashboardData {
src/lib/dashboard/__tests__/scope.test.ts:50:    scope: 'aggregate',
src/lib/dashboard/__tests__/scope.test.ts:51:    recentReviews: [],
src/lib/dashboard/__tests__/scope.test.ts:58:      recentReviewCount: 0,
src/lib/dashboard/__tests__/scope.test.ts:67:    const data = activePayload({ reputationPending: 15, recentPendingCount: 10 });
src/lib/dashboard/__tests__/scope.test.ts:71:  it('aggregate: sums locationKpis pending counts, not the capped slice (>10 regression)', () => {
src/lib/dashboard/__tests__/scope.test.ts:72:    const data = aggregatePayload([8, 9]);
src/lib/dashboard/__tests__/scope.test.ts:77:    const base = activePayload({ reputationPending: 12, recentPendingCount: 3 });
src/lib/dashboard/__tests__/scope.test.ts:84:    const data = activePayload({ recentPendingCount: 3 });
src/lib/dashboard/__tests__/active-mappers.test.ts:5:  it('maps recent review row nulls and dates to dashboard shape', () => {
src/lib/dashboard/__tests__/service.degradation.test.ts:32:let mockSql: Sql;
src/lib/dashboard/__tests__/service.degradation.test.ts:75:    mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/service.degradation.test.ts:87:    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.degradation.test.ts:106:    await expect(getActiveDashboardData(mockSql, BUSINESS_ID)).rejects.toThrow(
src/lib/dashboard/__tests__/service.degradation.test.ts:115:    await expect(getActiveDashboardData(mockSql, BUSINESS_ID)).rejects.toThrow(
src/lib/dashboard/__tests__/service.degradation.test.ts:123:    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.degradation.test.ts:134:    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:6:// reads stay fatal: the locations-list query (an aggregate over unknown
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:11:// The REAL aggregate-queries module runs here (no seam mock): rejections are
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:46:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:49:let mockSql: Sql;
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:61: * call consumes (same thenable-adoption reasoning as aggregate-queries.test.ts's
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:63: *   1. account billing row               (aggregate-service, settled)
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:72: *  10. account-wide recent reviews feed  (aggregate-service, settled)
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:75:  'billing' | 'pending' | 'baseline' | 'counters' | 'velocity' | 'rating' | 'ranking' | 'monthly' | 'weekly' | 'recent',
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:101:    overrides.recent ?? [],
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:107:    'dashboard/aggregate',
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:120:    mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:127:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:136:  it('degrades a failed account-wide recent-reviews feed to an empty feed and reports it', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:137:    pushDashboardQueries({ recent: preHandledRejection(new Error('recent reviews timeout')) });
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:139:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:141:    expect(result.recentReviews).toEqual([]);
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:153:    await expect(getAggregateDashboardData(mockSql, 'acc-1')).rejects.toThrow(
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:158:  it('keeps the baseline anchor read fatal (the slices are built from its rows — an all-zeros aggregate would misreport)', async () => {
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:161:    await expect(getAggregateDashboardData(mockSql, 'acc-1')).rejects.toThrow(
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:169:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:185:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:196:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:206:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:220:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:231:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts:241:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/service-mappers.test.ts:66:  it('selects the most recently sent brief', () => {
src/lib/dashboard/__tests__/service-mappers.test.ts:108:  it('selects the monthly brief when it was sent more recently than the weekly', () => {
src/lib/dashboard/__tests__/service-mappers.test.ts:222:        recentReviewRows: [],
src/lib/dashboard/__tests__/service-mappers.test.ts:257:      recentReviews: [],
src/lib/dashboard/__tests__/aggregate-service.test.ts:5:// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
src/lib/dashboard/__tests__/aggregate-service.test.ts:7:// directly. The set-based aggregate wave is mocked at the seam
src/lib/dashboard/__tests__/aggregate-service.test.ts:14:vi.mock('@/lib/dashboard/aggregate-queries', () => ({
src/lib/dashboard/__tests__/aggregate-service.test.ts:18:// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
src/lib/dashboard/__tests__/aggregate-service.test.ts:35:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.test.ts:38:import type { PerLocationAggregateSlice } from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-service.test.ts:42:let mockSql: Sql;
src/lib/dashboard/__tests__/aggregate-service.test.ts:44:/** A per-location aggregate slice with sensible defaults; override per test. */
src/lib/dashboard/__tests__/aggregate-service.test.ts:57:    recentReviewCount: 0,
src/lib/dashboard/__tests__/aggregate-service.test.ts:76:      recentReviewCount: 2,
src/lib/dashboard/__tests__/aggregate-service.test.ts:87:      recentReviewCount: 2,
src/lib/dashboard/__tests__/aggregate-service.test.ts:97:  mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/aggregate-service.test.ts:99:  // sql call order: [account billing row, account-wide recent-reviews feed].
src/lib/dashboard/__tests__/aggregate-service.test.ts:109:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:138:  it('builds locationKpis from the slice (pending is authoritative, not the capped recentReviewCount)', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:139:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:143:    expect(loc1).toMatchObject({ displayName: 'Downtown', isPrimary: true, totalReviewsHandled: 40, pendingApprovalCount: 25, recentReviewCount: 2, billingPending: false });
src/lib/dashboard/__tests__/aggregate-service.test.ts:144:    expect(loc2).toMatchObject({ displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 10, pendingApprovalCount: 13, recentReviewCount: 2, billingPending: false });
src/lib/dashboard/__tests__/aggregate-service.test.ts:145:    // pending (25/13) diverges from the capped recentReviewCount (2) — proving it
src/lib/dashboard/__tests__/aggregate-service.test.ts:147:    expect(loc1!.pendingApprovalCount).not.toBe(loc1!.recentReviewCount);
src/lib/dashboard/__tests__/aggregate-service.test.ts:150:  it('aggregate badge total sums the authoritative per-location counts (>10 regression, #346)', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:151:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:156:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:164:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:174:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:182:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:195:describe('getAggregateDashboardData — recent-reviews feed (unchanged)', () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:196:  it('preserves scheduled-post and open-escalation fields from the account-wide feed', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:198:    // Override the recent-reviews return (2nd sql call after the billing row).
src/lib/dashboard/__tests__/aggregate-service.test.ts:222:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:224:    expect(result.recentReviews).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-service.test.ts:225:    for (const review of result.recentReviews) {
src/lib/dashboard/__tests__/aggregate-service.test.ts:229:    expect(result.recentReviews.map((r) => r.locationDisplayName).sort()).toEqual(['Downtown', 'Westside Bakery']);
src/lib/dashboard/__tests__/aggregate-service.test.ts:240:    const result = await getAggregateDashboardData(mockSql, 'acc-empty');
src/lib/dashboard/__tests__/aggregate-types.test.ts:15:  return 'scope' in data && data.scope === 'aggregate';
src/lib/dashboard/__tests__/aggregate-types.test.ts:19:  it('distinguishes aggregate data from per-location data via scope field', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:20:    const aggregate: AggregateDashboardData = {
src/lib/dashboard/__tests__/aggregate-types.test.ts:21:      scope: 'aggregate',
src/lib/dashboard/__tests__/aggregate-types.test.ts:33:      recentReviews: [],
src/lib/dashboard/__tests__/aggregate-types.test.ts:50:      recentReviews: [],
src/lib/dashboard/__tests__/aggregate-types.test.ts:71:    expect(isAggregateData(aggregate)).toBe(true);
src/lib/dashboard/__tests__/aggregate-types.test.ts:82:      recentReviewCount: 8,
src/lib/dashboard/__tests__/aggregate-types.test.ts:167:  it('aggregate valueSummary matches sum of per-location KPIs', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:169:      { locationId: 'loc-1', displayName: 'Downtown Cafe', isPrimary: true, totalReviewsHandled: 20, pendingApprovalCount: 3, recentReviewCount: 8, billingPending: false },
src/lib/dashboard/__tests__/aggregate-types.test.ts:170:      { locationId: 'loc-2', displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 15, pendingApprovalCount: 1, recentReviewCount: 5, billingPending: true },
src/lib/dashboard/__tests__/aggregate-types.test.ts:173:    const aggregateTotalHandled = kpis.reduce((sum, k) => sum + k.totalReviewsHandled, 0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:174:    const aggregatePending = kpis.reduce((sum, k) => sum + k.pendingApprovalCount, 0);
src/lib/dashboard/__tests__/aggregate-types.test.ts:176:    expect(aggregateTotalHandled).toBe(35);
src/lib/dashboard/__tests__/aggregate-types.test.ts:177:    expect(aggregatePending).toBe(4);
src/lib/dashboard/__tests__/aggregate-types.test.ts:180:  it('aggregate with zero locations returns zero values', () => {
src/lib/dashboard/__tests__/aggregate-types.test.ts:182:      scope: 'aggregate',
src/lib/dashboard/__tests__/aggregate-types.test.ts:194:      recentReviews: [],
src/lib/dashboard/__tests__/aggregate-types.test.ts:202:    expect(empty.recentReviews).toHaveLength(0);
src/lib/dashboard/__tests__/aggregate-service.test.ts:5:// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
src/lib/dashboard/__tests__/aggregate-service.test.ts:7:// directly. The set-based aggregate wave is mocked at the seam
src/lib/dashboard/__tests__/aggregate-service.test.ts:14:vi.mock('@/lib/dashboard/aggregate-queries', () => ({
src/lib/dashboard/__tests__/aggregate-service.test.ts:18:// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
src/lib/dashboard/__tests__/aggregate-service.test.ts:35:import { getAggregateDashboardData } from '../aggregate-service';
src/lib/dashboard/__tests__/aggregate-service.test.ts:38:import type { PerLocationAggregateSlice } from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-service.test.ts:42:let mockSql: Sql;
src/lib/dashboard/__tests__/aggregate-service.test.ts:44:/** A per-location aggregate slice with sensible defaults; override per test. */
src/lib/dashboard/__tests__/aggregate-service.test.ts:57:    recentReviewCount: 0,
src/lib/dashboard/__tests__/aggregate-service.test.ts:76:      recentReviewCount: 2,
src/lib/dashboard/__tests__/aggregate-service.test.ts:87:      recentReviewCount: 2,
src/lib/dashboard/__tests__/aggregate-service.test.ts:97:  mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/aggregate-service.test.ts:99:  // sql call order: [account billing row, account-wide recent-reviews feed].
src/lib/dashboard/__tests__/aggregate-service.test.ts:109:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:138:  it('builds locationKpis from the slice (pending is authoritative, not the capped recentReviewCount)', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:139:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:143:    expect(loc1).toMatchObject({ displayName: 'Downtown', isPrimary: true, totalReviewsHandled: 40, pendingApprovalCount: 25, recentReviewCount: 2, billingPending: false });
src/lib/dashboard/__tests__/aggregate-service.test.ts:144:    expect(loc2).toMatchObject({ displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 10, pendingApprovalCount: 13, recentReviewCount: 2, billingPending: false });
src/lib/dashboard/__tests__/aggregate-service.test.ts:145:    // pending (25/13) diverges from the capped recentReviewCount (2) — proving it
src/lib/dashboard/__tests__/aggregate-service.test.ts:147:    expect(loc1!.pendingApprovalCount).not.toBe(loc1!.recentReviewCount);
src/lib/dashboard/__tests__/aggregate-service.test.ts:150:  it('aggregate badge total sums the authoritative per-location counts (>10 regression, #346)', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:151:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:156:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:164:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:174:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:182:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:195:describe('getAggregateDashboardData — recent-reviews feed (unchanged)', () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:196:  it('preserves scheduled-post and open-escalation fields from the account-wide feed', async () => {
src/lib/dashboard/__tests__/aggregate-service.test.ts:198:    // Override the recent-reviews return (2nd sql call after the billing row).
src/lib/dashboard/__tests__/aggregate-service.test.ts:222:    const result = await getAggregateDashboardData(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-service.test.ts:224:    expect(result.recentReviews).toHaveLength(2);
src/lib/dashboard/__tests__/aggregate-service.test.ts:225:    for (const review of result.recentReviews) {
src/lib/dashboard/__tests__/aggregate-service.test.ts:229:    expect(result.recentReviews.map((r) => r.locationDisplayName).sort()).toEqual(['Downtown', 'Westside Bakery']);
src/lib/dashboard/__tests__/aggregate-service.test.ts:240:    const result = await getAggregateDashboardData(mockSql, 'acc-empty');
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:18:let mockSql: Sql;
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:24:// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:36:    [], // 5 recentReviews
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:47:  return harness.sqlCalls.find((call) => call.text.includes('GROUP BY star_rating'))?.text ?? '';
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:53:    mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:62:    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:75:    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:82:    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:88:    const call = harness.sqlCalls[RATING_BREAKDOWN_CALL];
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:95:    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '30d' });
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:100:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(30);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:105:    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '7d' });
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:106:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(7);
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:109:    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '90d' });
src/lib/dashboard/__tests__/service.rating-breakdown.test.ts:110:    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(90);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:5:// The set-based aggregate module is born-injected (sql is a parameter, invariant
src/lib/dashboard/__tests__/aggregate-queries.test.ts:10:} from '../aggregate-queries';
src/lib/dashboard/__tests__/aggregate-queries.test.ts:14:let mockSql: Sql;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:18:  mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:22: * Load the aggregate wave's return values in the deterministic order the mock
src/lib/dashboard/__tests__/aggregate-queries.test.ts:102:    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:130:    expect(a.recentReviewCount).toBe(10); // LEAST(50, 10)
src/lib/dashboard/__tests__/aggregate-queries.test.ts:146:    expect(b.recentReviewCount).toBe(3); // LEAST(3, 10)
src/lib/dashboard/__tests__/aggregate-queries.test.ts:151:    await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:153:    expect(harness.sqlCalls).toHaveLength(8);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:154:    for (const call of harness.sqlCalls) {
src/lib/dashboard/__tests__/aggregate-queries.test.ts:178:    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:195:    const slices = await fetchPerLocationAggregateSlices(mockSql, 'acc-1', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:209:    expect(empty.recentReviewCount).toBe(0);
src/lib/dashboard/__tests__/aggregate-queries.test.ts:231:    await fetchPerLocationAggregateSlices(mockSql, 'acc-2', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:232:    const twoLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:236:    await fetchPerLocationAggregateSlices(mockSql, 'acc-5', '30d');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:237:    const fiveLocationQueries = harness.sqlCalls.length;
src/lib/dashboard/__tests__/aggregate-queries.test.ts:251:    const counts = await getPendingApprovalCountsForAccount(mockSql, 'acc-1');
src/lib/dashboard/__tests__/aggregate-queries.test.ts:257:    const call = harness.sqlCalls[0]!;
src/lib/dashboard/__tests__/service.cache.test.ts:9:// (#478), mirroring the aggregate-service block. Hoisted get/set mocks let each
src/lib/dashboard/__tests__/service.cache.test.ts:27:let mockSql: Sql;
src/lib/dashboard/__tests__/service.cache.test.ts:33:// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
src/lib/dashboard/__tests__/service.cache.test.ts:37:  recentReviews?: unknown[];
src/lib/dashboard/__tests__/service.cache.test.ts:46:    overrides?.recentReviews ?? [],
src/lib/dashboard/__tests__/service.cache.test.ts:59:    mockSql = harness.mockSql as unknown as Sql;
src/lib/dashboard/__tests__/service.cache.test.ts:70:    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts:73:    expect(harness.sqlCalls).toHaveLength(0);
src/lib/dashboard/__tests__/service.cache.test.ts:80:    await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts:82:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:96:    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts:99:    expect(harness.sqlCalls.length).toBeGreaterThan(0);
src/lib/dashboard/__tests__/service.cache.test.ts:107:    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts:115:    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '7d' });
src/lib/dashboard/__tests__/service.cache.test.ts:120:    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '90d' });
src/lib/dashboard/__tests__/service.cache.test.ts:132:    await getActiveDashboardData(mockSql, BUSINESS_ID, {
src/lib/dashboard/__tests__/service.cache.test.ts:140:    await getActiveDashboardData(mockSql, BUSINESS_ID, {
src/lib/dashboard/__tests__/service.cache.test.ts:150:    await expect(getActiveDashboardData(mockSql, BUSINESS_ID)).rejects.toBeInstanceOf(
src/lib/dashboard/__tests__/service.cache.test.ts:161:      recentReviews: [
src/lib/dashboard/__tests__/service.cache.test.ts:178:    const freshResult = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts:184:    const cachedReadResult = await getActiveDashboardData(mockSql, BUSINESS_ID);
src/lib/dashboard/__tests__/service.cache.test.ts:186:    expect(harness.sqlCalls).toHaveLength(0);

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
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba src/lib/past-replies/__tests__/load-replies.integration.test.ts | sed -n '1,280p'; nl -ba src/lib/agents/__tests__/read.integration.test.ts | sed -n '1,320p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba \"src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts\" | sed -n '1,300p'; nl -ba src/app/api/dashboard/past-replies/__tests__/draft-status-route.test.ts | sed -n '1,320p'; nl -ba src/lib/dashboard/__tests__/service.feed-projection.test.ts | sed -n '1,180p'; nl -ba src/lib/dashboard/__tests__/aggregate-service.test.ts | sed -n '1,280p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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
nl: src/app/api/dashboard/past-replies/__tests__/draft-status-route.test.ts: No such file or directory
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
     1	import { describe, it, expect, vi, beforeEach } from 'vitest';
     2	import type { Sql } from 'postgres';
     3	import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
     4	
     5	// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
     6	// not mocked here — the fragment-aware createMockSql harness stands in for `sql`
     7	// directly. The set-based aggregate wave is mocked at the seam
     8	// (fetchPerLocationAggregateSlices); the service under test is now a pure
     9	// composition of slices → AggregateDashboardData.
    10	
    11	const { mockFetchSlices } = vi.hoisted(() => ({
    12	  mockFetchSlices: vi.fn(),
    13	}));
    14	vi.mock('@/lib/dashboard/aggregate-queries', () => ({
    15	  fetchPerLocationAggregateSlices: (...args: unknown[]) => mockFetchSlices(...args),
    16	}));
    17	
    18	// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
    19	// always-miss so every test exercises a fresh computation.
    20	vi.mock('@/lib/db/redis-cache', () => ({
    21	  getCacheRedis: () => ({
    22	    get: async () => null,
    23	    set: async () => 'OK',
    24	  }),
    25	}));
    26	
    27	vi.mock('@/lib/locations/repo', () => ({
    28	  getLocationsForAccount: vi.fn(async () => [
    29	    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date('2026-01-01') },
    30	    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date('2026-01-02') },
    31	  ]),
    32	}));
    33	
    34	// Import AFTER mocks are set up.
    35	import { getAggregateDashboardData } from '../aggregate-service';
    36	import { authoritativePendingCount } from '../scope';
    37	import { buildRatingBreakdown } from '../rating-breakdown';
    38	import type { PerLocationAggregateSlice } from '../aggregate-queries';
    39	import type { RatingBreakdown } from '../types';
    40	
    41	let harness: MockSqlHarness;
    42	let mockSql: Sql;
    43	
    44	/** A per-location aggregate slice with sensible defaults; override per test. */
    45	function makeSlice(overrides: Partial<PerLocationAggregateSlice> = {}): PerLocationAggregateSlice {
    46	  return {
    47	    valueSummary: {
    48	      totalReviewsHandled: 0,
    49	      totalTimeSavedMinutes: 0,
    50	      currentResponseRate: 0,
    51	      baselineResponseRate: null,
    52	    },
    53	    reviewVelocity: [],
    54	    ranking: null,
    55	    ratingBreakdown: buildRatingBreakdown([]),
    56	    latestBrief: null,
    57	    recentReviewCount: 0,
    58	    pendingApprovalCount: 0,
    59	    windowedReceived: 0,
    60	    windowedResponded: 0,
    61	    ...overrides,
    62	  };
    63	}
    64	
    65	const MONTHLY_BRIEF = { text: 'Monthly A', type: 'monthly' as const, periodLabel: 'June 2026' };
    66	
    67	/** Two-location fixture used across the byte-identical + windowed-rate cases. */
    68	function twoLocationSlices(ratingA?: RatingBreakdown, ratingB?: RatingBreakdown): Map<string, PerLocationAggregateSlice> {
    69	  return new Map<string, PerLocationAggregateSlice>([
    70	    ['loc-1', makeSlice({
    71	      valueSummary: { totalReviewsHandled: 40, totalTimeSavedMinutes: 280, currentResponseRate: 80, baselineResponseRate: 30 },
    72	      reviewVelocity: [{ weekStart: '2026-06-01', count: 2 }, { weekStart: '2026-06-08', count: 3 }],
    73	      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-06-01', position: 3 }, { date: '2026-06-08', position: 2 }] }],
    74	      ratingBreakdown: ratingA ?? buildRatingBreakdown([{ stars: 5, count: 2 }, { stars: 1, count: 1 }]),
    75	      latestBrief: MONTHLY_BRIEF,
    76	      recentReviewCount: 2,
    77	      pendingApprovalCount: 25,
    78	      windowedReceived: 12,
    79	      windowedResponded: 9,
    80	    })],
    81	    ['loc-2', makeSlice({
    82	      valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 50, baselineResponseRate: 20 },
    83	      reviewVelocity: [{ weekStart: '2026-06-01', count: 1 }, { weekStart: '2026-06-08', count: 4 }],
    84	      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-06-01', position: 2 }, { date: '2026-06-08', position: 5 }] }],
    85	      ratingBreakdown: ratingB ?? buildRatingBreakdown([{ stars: 5, count: 3 }, { stars: 4, count: 4 }]),
    86	      latestBrief: null,
    87	      recentReviewCount: 2,
    88	      pendingApprovalCount: 13,
    89	      windowedReceived: 8,
    90	      windowedResponded: 5,
    91	    })],
    92	  ]);
    93	}
    94	
    95	beforeEach(() => {
    96	  harness = createMockSql();
    97	  mockSql = harness.mockSql as unknown as Sql;
    98	  mockFetchSlices.mockReset();
    99	  // sql call order: [account billing row, account-wide recent-reviews feed].
   100	  harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
   101	});
   102	
   103	describe('getAggregateDashboardData — byte-identical composition from slices', () => {
   104	  beforeEach(() => {
   105	    mockFetchSlices.mockResolvedValue(twoLocationSlices());
   106	  });
   107	
   108	  it('sums value summary, merges velocity/ranking, and rolls up briefs', async () => {
   109	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   110	
   111	    expect(result.valueSummary.totalReviewsHandled).toBe(50);
   112	    expect(result.valueSummary.totalTimeSavedMinutes).toBe(350);
   113	    expect(result.valueSummary.baselineResponseRate).toBe(30); // primary (loc-1)
   114	
   115	    // Velocity: per-week sum across locations.
   116	    expect(result.reviewVelocity).toEqual([
   117	      { weekStart: '2026-06-01', count: 3 },
   118	      { weekStart: '2026-06-08', count: 7 },
   119	    ]);
   120	
   121	    // Ranking: best (lowest) position across locations per keyword/date.
   122	    expect(result.ranking).toEqual([
   123	      { keyword: 'coffee', snapshots: [
   124	        { date: '2026-06-01', position: 2 },
   125	        { date: '2026-06-08', position: 2 },
   126	      ] },
   127	    ]);
   128	
   129	    // Briefs roll up only locations that have one.
   130	    expect(result.perLocationBriefs).toEqual([
   131	      { locationId: 'loc-1', displayName: 'Downtown', brief: MONTHLY_BRIEF },
   132	    ]);
   133	
   134	    expect(result.activeLocationCount).toBe(2);
   135	    expect(mockFetchSlices).toHaveBeenCalledWith(expect.any(Function), 'acc-1', '30d');
   136	  });
   137	
   138	  it('builds locationKpis from the slice (pending is authoritative, not the capped recentReviewCount)', async () => {
   139	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   140	
   141	    const loc1 = result.locationKpis.find((k) => k.locationId === 'loc-1');
   142	    const loc2 = result.locationKpis.find((k) => k.locationId === 'loc-2');
   143	    expect(loc1).toMatchObject({ displayName: 'Downtown', isPrimary: true, totalReviewsHandled: 40, pendingApprovalCount: 25, recentReviewCount: 2, billingPending: false });
   144	    expect(loc2).toMatchObject({ displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 10, pendingApprovalCount: 13, recentReviewCount: 2, billingPending: false });
   145	    // pending (25/13) diverges from the capped recentReviewCount (2) — proving it
   146	    // is NOT derived from the displayed slice (#346).
   147	    expect(loc1!.pendingApprovalCount).not.toBe(loc1!.recentReviewCount);
   148	  });
   149	
   150	  it('aggregate badge total sums the authoritative per-location counts (>10 regression, #346)', async () => {
   151	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   152	    expect(authoritativePendingCount(result)).toBe(38); // 25 + 13, not 2 + 2
   153	  });
   154	
   155	  it('does not expose partialFailures on the returned payload', async () => {
   156	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   157	    expect('partialFailures' in result).toBe(false);
   158	  });
   159	});
   160	
   161	describe('getAggregateDashboardData — windowed currentResponseRate', () => {
   162	  it('derives from summed windowedResponded / windowedReceived (NOT all-time)', async () => {
   163	    mockFetchSlices.mockResolvedValue(twoLocationSlices());
   164	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   165	    // windowedResponded 9+5=14 over windowedReceived 12+8=20 → 70%.
   166	    expect(result.valueSummary.currentResponseRate).toBe(70);
   167	  });
   168	
   169	  it('is 0 when the window received no reviews', async () => {
   170	    mockFetchSlices.mockResolvedValue(new Map<string, PerLocationAggregateSlice>([
   171	      ['loc-1', makeSlice({ valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 100, baselineResponseRate: null }, windowedReceived: 0, windowedResponded: 0 })],
   172	      ['loc-2', makeSlice({ windowedReceived: 0, windowedResponded: 0 })],
   173	    ]));
   174	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   175	    expect(result.valueSummary.currentResponseRate).toBe(0);
   176	  });
   177	});
   178	
   179	describe('getAggregateDashboardData — ratingBreakdown rollup (#405)', () => {
   180	  it('sums the per-location windowed breakdowns into one account-wide breakdown', async () => {
   181	    mockFetchSlices.mockResolvedValue(twoLocationSlices());
   182	    const result = await getAggregateDashboardData(mockSql, 'acc-1');
   183	
   184	    expect(result.ratingBreakdown.counts).toEqual([
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
   241	
   242	    expect(result.activeLocationCount).toBe(0);
   243	    expect(result.ratingBreakdown.total).toBe(0);
   244	    expect(result.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
   245	    expect(result.valueSummary.currentResponseRate).toBe(0);
   246	    expect('partialFailures' in result).toBe(false);
   247	    // No slice wave is issued when there are no active locations.
   248	    expect(mockFetchSlices).not.toHaveBeenCalled();
   249	  });
   250	});

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "rg --files src/app/api/dashboard/past-replies | sort; rg -n \"readQueue|readCalls|draft-status|held\" src/app/api/dashboard/past-replies/**/__tests__/*.ts src/app/api/dashboard/past-replies/__tests__/*.ts 2>/dev/null | head -220; nl -ba worker/__tests__/helpers/mock-sql.ts | sed -n '70,160p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts
src/app/api/dashboard/past-replies/[responseId]/retry/route.ts
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts
src/app/api/dashboard/past-replies/__tests__/draft.test.ts
src/app/api/dashboard/past-replies/__tests__/publish.test.ts
src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts
src/app/api/dashboard/past-replies/__tests__/retry.test.ts
src/app/api/dashboard/past-replies/_shared/__tests__/edit-reply-errors.test.ts
src/app/api/dashboard/past-replies/_shared/edit-reply-errors.ts
src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts
src/app/api/dashboard/past-replies/_shared/schemas.ts
src/app/api/dashboard/past-replies/draft-status/route.ts
src/app/api/dashboard/past-replies/draft/[responseId]/route.ts
src/app/api/dashboard/past-replies/draft/route.ts
src/app/api/dashboard/past-replies/publish/route.ts
src/app/api/dashboard/past-replies/__tests__/publish.test.ts:301:  it('returns 409 held_for_review when an open moderation flag holds the draft', async () => {
src/app/api/dashboard/past-replies/__tests__/publish.test.ts:321:    expect(body.error).toBe('held_for_review');
src/app/api/dashboard/past-replies/__tests__/publish.test.ts:331:    //   3. hasOpenFlag (empty → not held)
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:323:    // hasOpenFlag → [] (not held), UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:352:    // hasOpenFlag → [] (not held), UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:386:    // hasOpenFlag → [] (not held), UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:448:    // tx queue: lock-response (pending_approval), hasOpenFlag → [] (not held),
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:465:    // tx queue: lock-response (pending_approval), hasOpenFlag → [] (not held),
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:516:    // hasOpenFlag → [] (not held), offboarding lookup, UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:538:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:540:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:541:// button" — neither mutation may act on a held row: DELETE must not supersede
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:543:// vocabulary `held_for_review`. src/lib/moderation/held-draft.ts is the
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:544:// semantic owner of "is this draft held" — the REAL hasOpenFlag executes its
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:548:describe('draft/:responseId — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:551:  it('DELETE returns 409 held_for_review and does not supersede a held draft', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:560:    expect(await res.json()).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:563:    // The held row is never superseded — no UPDATE executed in the tx.
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:573:  it('PATCH returns 409 held_for_review and does not update a held draft', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:584:    expect(await res.json()).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:587:    // The held row is never updated — no UPDATE executed in the tx.
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:5:// reject wrong-Origin requests with 403, AND that the GET /draft-status route
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:40:// DB connection. Mock it so the GET /draft-status exemption case can reach its
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:129:  it('GET /draft-status is EXEMPT from cross-origin check (CSRF does not apply to GETs)', async () => {
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:130:    const { GET } = await import('../draft-status/route');
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:134:    const res = await GET(reqWithOrigin('GET', '/api/dashboard/past-replies/draft-status', WRONG_ORIGIN));
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:261:    // hasOpenFlag → [] (not held) → 409 draft_already_exists.
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:283:    // tx queue: lock-row, existing-check, hasOpenFlag → [] (not held).
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:299:    // tx queue: lock-row, existing-check, hasOpenFlag → [] (not held).
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:502:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:504:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:505:// button". When the existing-draft branch resolves a held draft, the route
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:506:// must refuse with the owner-visible vocabulary `held_for_review` and never
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:507:// echo the draft payload. src/lib/moderation/held-draft.ts is the semantic
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:508:// owner of "is this draft held" — the REAL hasOpenFlag executes its
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:512:// Unique sentinels: heldness refusals assert these appear NOWHERE in the
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:517:describe('POST /api/dashboard/past-replies/draft — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:520:  it('returns 409 held_for_review without the existing draft payload when the existing draft has an open moderation flag', async () => {
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:522:    // tx queue: lock-review, existing-draft (held sentinels),
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:537:    expect(body).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:541:    // held-draft.ts contract requires (hasOpenFlag is in-tx, post-lock).
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:548:    // hasOpenFlag executed against flagged_responses, binding the held draft's id.
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:560:        // non-terminal status (held sentinels), hasOpenFlag → open.
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:574:        expect(body).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:5:// reject wrong-Origin requests with 403, AND that the GET /draft-status route
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:40:// DB connection. Mock it so the GET /draft-status exemption case can reach its
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:129:  it('GET /draft-status is EXEMPT from cross-origin check (CSRF does not apply to GETs)', async () => {
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:130:    const { GET } = await import('../draft-status/route');
src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts:134:    const res = await GET(reqWithOrigin('GET', '/api/dashboard/past-replies/draft-status', WRONG_ORIGIN));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:109:  const url = `${APP_URL}/api/dashboard/past-replies/draft-status${qs ? `?${qs}` : ''}`;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:141:  const mod = await import('../draft-status/route');
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:147:describe('GET /api/dashboard/past-replies/draft-status', () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:426:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:428:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:430:// `held_for_review` and never the draft text. src/lib/moderation/held-draft.ts
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:431:// is the semantic owner of "is this draft held"; the read-only poller holds no
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:435:// Unique sentinels: heldness refusals assert these appear NOWHERE in the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:451:describe('GET /api/dashboard/past-replies/draft-status — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:452:  it('returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:461:        held: true,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:472:    expect(body).toEqual({ status: 'failed', error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:476:    // Deliberate GREEN characterization: a closed flag (held: false) is the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:485:        held: false,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:499:    // SQL-text assertion (held-draft.test.ts technique): the heldness
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:501:    // spelling of the held-draft.ts semantics.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:509:        held: false,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:516:    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:518:    const responseLookup = readCalls.find((call) => joinTemplate(call).includes('FROM responses'));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:530:  it('returns 403 with no heldness signal when the held response belongs to another tenant', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:531:    // Deliberate GREEN characterization locking tenant-before-held ordering:
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:532:    // the tenant re-check must win over any held branching, and the refusal
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:533:    // must carry no heldness signal (neither sentinel nor 'held' vocabulary).
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:541:        held: true,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:551:    expect(serialized).not.toContain('held');
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:109:  const url = `${APP_URL}/api/dashboard/past-replies/draft-status${qs ? `?${qs}` : ''}`;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:141:  const mod = await import('../draft-status/route');
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:147:describe('GET /api/dashboard/past-replies/draft-status', () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:426:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:428:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:430:// `held_for_review` and never the draft text. src/lib/moderation/held-draft.ts
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:431:// is the semantic owner of "is this draft held"; the read-only poller holds no
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:435:// Unique sentinels: heldness refusals assert these appear NOWHERE in the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:451:describe('GET /api/dashboard/past-replies/draft-status — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:452:  it('returns status failed with error held_for_review and no draft sentinel anywhere in the serialized body when the resolved response has an open moderation flag', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:461:        held: true,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:472:    expect(body).toEqual({ status: 'failed', error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:476:    // Deliberate GREEN characterization: a closed flag (held: false) is the
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:485:        held: false,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:499:    // SQL-text assertion (held-draft.test.ts technique): the heldness
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:501:    // spelling of the held-draft.ts semantics.
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:509:        held: false,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:516:    const readCalls: unknown[][] = sqlReadProxy.mock.calls;
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:518:    const responseLookup = readCalls.find((call) => joinTemplate(call).includes('FROM responses'));
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:530:  it('returns 403 with no heldness signal when the held response belongs to another tenant', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:531:    // Deliberate GREEN characterization locking tenant-before-held ordering:
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:532:    // the tenant re-check must win over any held branching, and the refusal
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:533:    // must carry no heldness signal (neither sentinel nor 'held' vocabulary).
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:541:        held: true,
src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts:551:    expect(serialized).not.toContain('held');
src/app/api/dashboard/past-replies/__tests__/publish.test.ts:301:  it('returns 409 held_for_review when an open moderation flag holds the draft', async () => {
src/app/api/dashboard/past-replies/__tests__/publish.test.ts:321:    expect(body.error).toBe('held_for_review');
src/app/api/dashboard/past-replies/__tests__/publish.test.ts:331:    //   3. hasOpenFlag (empty → not held)
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:261:    // hasOpenFlag → [] (not held) → 409 draft_already_exists.
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:283:    // tx queue: lock-row, existing-check, hasOpenFlag → [] (not held).
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:299:    // tx queue: lock-row, existing-check, hasOpenFlag → [] (not held).
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:502:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:504:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:505:// button". When the existing-draft branch resolves a held draft, the route
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:506:// must refuse with the owner-visible vocabulary `held_for_review` and never
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:507:// echo the draft payload. src/lib/moderation/held-draft.ts is the semantic
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:508:// owner of "is this draft held" — the REAL hasOpenFlag executes its
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:512:// Unique sentinels: heldness refusals assert these appear NOWHERE in the
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:517:describe('POST /api/dashboard/past-replies/draft — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:520:  it('returns 409 held_for_review without the existing draft payload when the existing draft has an open moderation flag', async () => {
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:522:    // tx queue: lock-review, existing-draft (held sentinels),
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:537:    expect(body).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:541:    // held-draft.ts contract requires (hasOpenFlag is in-tx, post-lock).
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:548:    // hasOpenFlag executed against flagged_responses, binding the held draft's id.
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:560:        // non-terminal status (held sentinels), hasOpenFlag → open.
src/app/api/dashboard/past-replies/__tests__/draft.test.ts:574:        expect(body).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:323:    // hasOpenFlag → [] (not held), UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:352:    // hasOpenFlag → [] (not held), UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:386:    // hasOpenFlag → [] (not held), UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:448:    // tx queue: lock-response (pending_approval), hasOpenFlag → [] (not held),
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:465:    // tx queue: lock-response (pending_approval), hasOpenFlag → [] (not held),
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:516:    // hasOpenFlag → [] (not held), offboarding lookup, UPDATE
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:538:// ── #726 moderation-held draft gate ─────────────────────────────────
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:540:// A moderation-held draft (invariant #4) "surfaces neither its text nor any
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:541:// button" — neither mutation may act on a held row: DELETE must not supersede
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:543:// vocabulary `held_for_review`. src/lib/moderation/held-draft.ts is the
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:544:// semantic owner of "is this draft held" — the REAL hasOpenFlag executes its
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:548:describe('draft/:responseId — moderation-held draft gate (#726)', () => {
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:551:  it('DELETE returns 409 held_for_review and does not supersede a held draft', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:560:    expect(await res.json()).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:563:    // The held row is never superseded — no UPDATE executed in the tx.
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:573:  it('PATCH returns 409 held_for_review and does not update a held draft', async () => {
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:584:    expect(await res.json()).toEqual({ error: 'held_for_review' });
src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:587:    // The held row is never updated — no UPDATE executed in the tx.
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

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts | sed -n '1,180p'; nl -ba src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts | sed -n '420,535p'; nl -ba src/lib/moderation/__tests__/held-draft.test.ts | sed -n '1,180p'; rg -n \"service\\.test\\.ts|fragmentCalls|feedQueryText|service.feed-projection\" docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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
248:in `src/lib/dashboard/__tests__/service.test.ts`:
523:- [ ] **Step 3: fill title #10** (in `service.test.ts`, moved from `.todo`;
530:    const lateral = feedQueryText.slice(feedQueryText.indexOf('LEFT JOIN LATERAL'), feedQueryText.indexOf(') resp ON true'));
536:    expect(fragmentCalls.some((c) => c.text.trim() === 'responses.id')).toBe(true);

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'git log --oneline -5 -- docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md; git diff HEAD''^ -- docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json docs/superpowers/plans/feat-730-open-flag-consolidation-deviations.md | sed -n '"'1,320p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
7943458d docs(#730): plan v2 + intake corrections after codex plan-review round 1 (REVISE)
dbadaa85 docs(#730): implementation plan + deviations log (setup)
diff --git a/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md b/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
index 39461dad..89354dde 100644
--- a/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
+++ b/docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md
@@ -1,9 +1,15 @@
-# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan
+# #730 Owner-Facing Open-Flag Predicate Consolidation — Implementation Plan (v2)
 
 > **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
 > (recommended) or executing-plans to implement this plan task-by-task. Steps
 > use checkbox (`- [ ]`) syntax for tracking.
 
+> v2 after codex plan-review round 1 (REVISE): property test rebuilt on the
+> real export + isolated business (BLOCKER), five missing-test findings folded
+> into T1/T4/T5/T7, fragment-aware test doubles specified (the v1 mock claim
+> was wrong for queue-based doubles), all tasks serialized with path-scoped
+> staging. Full triage: docs/reviews/feat-730-open-flag-consolidation/.
+
 **Goal:** Consolidate every owner-facing surfacing spelling of the open-flag
 predicate onto one composable fragment `openFlagExistsSql`, owned by
 `src/lib/moderation/held-draft.ts`, leaving the deliberately-distinct
@@ -18,47 +24,57 @@ spellings) then compose the fragment instead of re-spelling the predicate;
 `response_id`-correlation + `status='open'` semantics are spelled exactly
 once. The 8 deliberately-distinct consumers (#725 inventory) are untouched.
 
-**Tech stack:** Postgres.js nested-fragment splicing (a `PendingQuery`
-interpolated into another template splices as raw SQL text — the lab-notes
-#573/#706 mechanic), vitest, fast-check (house style:
+**Tech stack:** Postgres.js nested-fragment splicing (verified round 1:
+postgres 3.4.9 recursively splices nested Query fragments in all three
+composition contexts; `SELECT 1 AS one WHERE EXISTS (...)` without FROM is
+valid), vitest, fast-check (house style:
 `src/lib/reviews/__tests__/sentiment.test.ts` "invariants" block).
 
 **Intake:** `.feature/intake.json` (committed copy:
 `docs/superpowers/plans/feat-730-open-flag-consolidation-intake.json`).
-**Research deliverable:** #725's closing comment (classified inventory, chosen
-shape, divergence sink).
-
-**Verified planning facts** (checked against the tree at fork, 2026-08-09):
-
-- `flagged_responses` is NOT in `TENANT_TABLES` (`scripts/ci/tenant-tables.ts`)
-  — the tenant-scope auditor never audits it directly. The fragment adds no new
-  audit surface, and `hasOpenFlag` today needs no allowlist entry for the same
-  reason.
-- The six allowlist entries whose `sqlSnippet` contains the migrating predicate
-  key on `table: "responses"` / `"review_escalations"`, NOT `flagged_responses`:
-  lines ~327 (past-replies draft-status), ~1285 (load-replies main), ~1509 +
-  ~1516 (service.ts), ~1530 + ~1537 (aggregate-service.ts). They regenerate **in
-  place** — count unchanged, `ALLOWLIST_BASELINE` stays 409. Snippets store
-  VERBATIM source text (interpolations appear as `${...}` source), normalized
-  by `normalizeSql(stripSqlComments(...))` — SQL comments do NOT appear in
-  snippets, so comment rewrites never touch the allowlist.
-- Flag statuses (migration `051_flagged_responses.sql` CHECK): `open`,
-  `approved_for_owner_review`, `dismissed_false_positive`,
-  `requires_regeneration`. Partial index machinery exists on
-  `WHERE status = 'open'` — the property test generates a SUBSET of the four
-  statuses (`fc.subarray`), so it never inserts two `open` rows per response.
-- Test doubles: `held-draft.test.ts` `mkTx` and the route-test `sqlMock`s
-  capture tagged-template calls and return `Promise.resolve(rows)` for every
-  call. After migration, building a nested fragment registers EXTRA captured
-  calls and splices a Promise into `values`; the executed query still resolves
-  the queued rows, but `toHaveLength(1)`-style call-count assertions and
-  outer-text `toContain('FROM flagged_responses')` assertions move to the
-  fragment's own captured call. Each migration task updates its suite's
-  assertions accordingly.
-- `load-replies.integration.test.ts` already seeds `flagged_responses`
-  (INSERT at ~line 138; held-replacement fixture `REVIEW_HELD_REPLACEMENT`,
-  cleanup at ~line 208) — crib its seed shape. `read.integration.test.ts` has
-  NO flag coverage today; the timeline test is genuinely new.
+**Research deliverable:** #725's closing comment.
+
+**Verified planning facts** (round-1 review re-verified all of these):
+
+- `flagged_responses` is NOT in `TENANT_TABLES` — the fragment adds no new
+  audit surface; `hasOpenFlag` needs no allowlist entry today.
+- Exactly 8 inline spellings exist. The six allowlist entries containing them
+  key on `table: "responses"` / `"review_escalations"` (lines ~327, ~1285,
+  ~1509, ~1516, ~1530, ~1537); they regenerate IN PLACE, `ALLOWLIST_BASELINE`
+  stays 409. Snippets store verbatim source text normalized by
+  `normalizeSql(stripSqlComments(...))`; SQL comments never appear in them.
+  pending-count is directly scoped and has NO entry — confirm no new one
+  appears.
+- Flag statuses (migration 051 CHECK): `open`, `approved_for_owner_review`,
+  `dismissed_false_positive`, `requires_regeneration`; partial unique index on
+  `status = 'open'` → `fc.subarray` (subset ⇒ at most one `open`).
+- The Reviews-list export is **`loadPastRepliesPageView`** (there is no
+  `loadReplies`). The integration suite's static seeds already include
+  unheld `pending_approval` responses on the suite's business — property and
+  count tests MUST run on an isolated business and treat the suite business's
+  counts as a baseline to be left undisturbed.
+- **Test doubles are NOT uniformly safe under fragment migration.**
+  `mkTx` (held-draft.test.ts) returns the same rows for every call — safe.
+  The route/dashboard doubles `shift()` a result QUEUE per tagged call —
+  a fragment-building call would eat the queued row meant for the executed
+  query. Every queue-based suite touched by migration gets the
+  fragment-aware double below (build-calls captured but NOT consuming).
+
+**Fragment-aware double (house pattern for this branch, used in T4/T5):**
+
+```ts
+const isExecutedStatement = (text: string) =>
+  /^\s*(select|insert|update|delete|with)\b/i.test(text);
+
+const sqlReadMock = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
+  const text = strings.join('?');
+  readCalls.push({ text, values });
+  // Fragment builds (`resp.id`, `EXISTS (...)`) are captured for assertions
+  // but must NOT consume the queued result of the outer executed query.
+  if (!isExecutedStatement(text)) return { fragmentText: text, values };
+  return Promise.resolve(readQueue.shift() ?? []);
+});
+```
 
 ---
 
@@ -66,33 +82,31 @@ shape, divergence sink).
 
 | File | Change |
 |---|---|
-| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql` fragment builder; `hasOpenFlag` body re-expressed on it; + "deliberately distinct consumers" divergence comment block |
-| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment rendering test; contract test; call-count assertion updates |
+| `src/lib/moderation/held-draft.ts` | + `openFlagExistsSql`; `hasOpenFlag` body re-expressed; + divergence comment block |
+| `src/lib/moderation/__tests__/held-draft.test.ts` | + fragment test; contract test; + T7 source-scan test; assertion updates |
 | `src/lib/past-replies/load-replies.ts` | inline EXISTS → fragment; stale `#680` comment rewritten |
-| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + behavior-pinning test + fast-check property |
+| `src/lib/past-replies/__tests__/load-replies.integration.test.ts` | + pinning test, + property (isolated business), + grouped-count test, + live hasOpenFlag test |
 | `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
-| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | assertion updates only |
+| `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts` | fragment-aware double + alias-correlation assertions |
 | `src/app/api/dashboard/past-replies/draft-status/route.ts` | inline EXISTS → fragment; D6 comment rewritten |
-| `src/app/api/dashboard/past-replies/__tests__/**` | assertion updates only |
+| `src/app/api/dashboard/past-replies/__tests__/**` | fragment-aware double + alias-correlation assertions |
 | `src/lib/dashboard/service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
 | `src/lib/dashboard/aggregate-service.ts` | NOT EXISTS filter → `AND NOT ${fragment}` |
 | `src/lib/dashboard/pending-count.ts` | BOTH spellings → `AND NOT ${fragment}` |
-| `src/lib/dashboard/__tests__/**` | assertion updates only |
-| `src/lib/agents/read.ts` | anti-join (`LEFT JOIN … fr.id IS NULL`) → `AND NOT ${fragment}` |
-| `src/lib/agents/__tests__/read.integration.test.ts` | + timeline exclusion test |
-| `src/lib/agents/__tests__/read.test.ts` | assertion updates only (if any pin the join text) |
+| `src/lib/dashboard/__tests__/**` | fragment-aware double where queue-based + placement/polarity assertions |
+| `src/lib/agents/read.ts` | anti-join → `AND NOT ${fragment}` |
+| `src/lib/agents/__tests__/read.integration.test.ts` | + exclusion test + newest-unheld fallback test |
+| `src/lib/agents/__tests__/read.test.ts` | assertion updates (if any pin the join text) |
 | `scripts/ci/tenant-scope-allowlist.ts` | 6 `sqlSnippet` strings regenerated in place; baseline stays 409 |
 
 No new files. No new dependencies.
 
-## Blocking edges / dispatch order
+## Dispatch order — FULLY SERIAL
 
-- **T1 (eval)** runs first, ALONE (first-task enforcement spot check).
-- **T2 (owner module)** blocks every migration task.
-- **T3 → T4 → T5 SERIAL** — all three edit `scripts/ci/tenant-scope-allowlist.ts`.
-- **T6 independent of T3–T5** (agents/read.ts has no allowlist entry with the
-  predicate) — may run in parallel with the T3–T5 chain after T2.
-- **T7 (gate)** last.
+T1 → T2 → T3 → T4 → T5 → T6 → T7. (v1 ran T6 parallel to T3–T5; round 1
+killed that: tasks share the worktree Git index and `git add -A` could stage
+a sibling's half-done work. All commits below are PATH-SCOPED — never
+`git add -A`.) T1 still runs alone first as the enforcement spot check.
 
 ---
 
@@ -103,20 +117,26 @@ No new files. No new dependencies.
 - Modify: `src/lib/past-replies/__tests__/load-replies.integration.test.ts`
 - Modify: `src/lib/agents/__tests__/read.integration.test.ts`
 
-These are the spec in executable form. The behavior-pinning tests must be
-GREEN before any implementation task (they pin current behavior across the
-refactor); the fragment-rendering test is a `.todo` stub until T2 fills it.
-All five intake `tests_to_add` titles land VERBATIM in this task (the gate's
-`promised-tests` row checks titles, `.todo` included).
+All eleven intake `tests_to_add` titles land VERBATIM here. GREEN now
+(behavior-pinning, they must survive the refactor unchanged): #2–#8 below.
+`.todo` until their implementation task: #1 (T2), #9 (T4), #10 (T5), #11 (T7).
 
-- [ ] **Step 1: held-draft.test.ts — add the two titles**
+1. `openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref` — `.todo`
+2. `hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes`
+3. `a held draft still projects draft_held true after the fragment migration`
+4. `getReviewTimeline excludes a response whose flag is open and includes it once closed`
+5. `property: projected held and filtered visibility agree for every flag-row status combination`
+6. `hasOpenFlag executes the UUID-parameter fragment against live Postgres`
+7. `getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged`
+8. `per-business and account-grouped pending counts exclude the same open-held rows across two businesses`
+9. `each draft-status awaited query projects held from its correctly correlated response alias` — `.todo`
+10. `the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned` — `.todo`
+11. `all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains` — `.todo`
 
-Append inside `describe('hasOpenFlag', …)`:
+- [ ] **Step 1: held-draft.test.ts — titles #1 (.todo) and #2**
 
 ```ts
   it('hasOpenFlag keeps its contract: true while a flag is open, false once the flag closes', async () => {
-    // Same double, both branches — pins the contract across the #730 body
-    // re-expression (rows.length > 0 stays the decision rule).
     const open = mkTx([{ one: 1 }]);
     await expect(hasOpenFlag(open.tx, RESPONSE_ID)).resolves.toBe(true);
     const closed = mkTx([]);
@@ -124,114 +144,124 @@ Append inside `describe('hasOpenFlag', …)`:
   });
 ```
 
-Append a new top-level describe:
-
 ```ts
 describe('openFlagExistsSql', () => {
   it.todo('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref');
+  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
 });
 ```
 
-- [ ] **Step 2: load-replies.integration.test.ts — behavior-pinning + property**
+- [ ] **Step 2: load-replies.integration.test.ts — titles #3, #5, #6, #8**
+
+Read the suite first. Crib: the `REVIEW_HELD_REPLACEMENT` fixture + its
+`flagged_responses` INSERT shape (~line 138), the FK-ordered cleanup
+(~line 208), and how the suite creates its business/account rows.
 
-Read the suite first; crib the existing `REVIEW_HELD_REPLACEMENT` seed and the
-FK-ordered cleanup (`DELETE FROM flagged_responses …` before responses). Add,
-inside the suite's existing live-DB describe (respecting its
-`assertSchemaReady` / lock conventions):
+Title #3 — behavior-pinning against the EXISTING fixture (mirror the
+neighbouring #727 held-case assertions; through `loadPastRepliesPageView`,
+a held replacement draft on a posted row projects `row_action 'none'` /
+withdrawn Regenerate — assert exactly what the adjacent held case asserts,
+under the locked title):
 
 ```ts
   it('a held draft still projects draft_held true after the fragment migration', async () => {
-    // Behavior-pinning (green BEFORE and AFTER #730): the Reviews list
-    // projects held-ness (D9 SELECTed-not-filtered) rather than dropping the
-    // row. Reuses the REVIEW_HELD_REPLACEMENT fixture seeded above.
-    const view = await loadReplies(sql(), businessId, 1);
-    const heldRow = view!.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
+    const view = await loadPastRepliesPageView(/* suite's standard args */);
+    const heldRow = view.answeredRows.find((row) => row.review_id === REVIEW_HELD_REPLACEMENT);
     expect(heldRow).toBeDefined();
-    // draft_held is the projected fragment output — the wire never sees 'held'
-    // (CONTEXT.md "Reviews list"); the projection is what deriveRowAction
-    // consumes server-side.
-    expect(heldRow!.draft_held ?? heldRow!.row_action === 'none').toBeTruthy();
+    expect(heldRow!.row_action).toBe('none'); // held ⇒ affordance withdrawn (invariant #4 as structure)
   });
 ```
 
-(The exact projected field the suite can see depends on what `loadReplies`
-returns post-#727 — `draft_held` on the raw row or `row_action 'none'` on the
-view. Match the suite's existing held-replacement assertions; the TITLE is
-locked, the assertion mirrors the neighbouring #727 held case.)
+Titles #5, #6, #8 — an ISOLATED business under the suite's account (created
+once in a before-hook, torn down FK-ordered after). Baseline rule: read the
+suite business's `getPendingApprovalCountsForAccount` entry BEFORE the
+property and assert it is UNDISTURBED inside every run (cross-business
+correlation guard).
 
 ```ts
   it('property: projected held and filtered visibility agree for every flag-row status combination', async () => {
-    // Invariant #4 as a property: for ANY set of flag rows on a
-    // pending_approval draft, the projected predicate (draft held) and the
-    // filtered predicate (pending-count exclusion) must agree — they are the
-    // same fragment used in two modes. Bounded runs: live-DB roundtrips.
-    const FLAG_STATUSES = [
-      'open',
-      'approved_for_owner_review',
-      'dismissed_false_positive',
-      'requires_regeneration',
-    ] as const;
+    const FLAG_STATUSES = ['open', 'approved_for_owner_review', 'dismissed_false_positive', 'requires_regeneration'] as const;
+    const baseline = (await getPendingApprovalCountsForAccount(sql(), accountId)).get(suiteBusinessId) ?? 0;
     await fc.assert(
       fc.asyncProperty(fc.subarray([...FLAG_STATUSES]), async (statuses) => {
-        // seed: one pending_approval response on a dedicated review row
-        // (INSERT shape cribbed from the suite's existing flagged_responses
-        // seed at ~line 138), one flag row per generated status
-        // (fc.subarray → at most one 'open', respecting the partial unique
-        // index on status='open').
-        // ... seed review + response + flag rows ...
+        // seed on the ISOLATED business: one review + one pending_approval
+        // response + one flag row per status (INSERT shapes cribbed from ~138)
         const expectHeld = statuses.includes('open');
-        const view = await loadReplies(sql(), businessId, 1);
-        const count = await getPendingApprovalCount(sql(), businessId);
-        // projected mode: the row's draft is held iff an open flag exists
-        // filtered mode: the pending count excludes the draft iff held
-        expect(/* row projected as held */).toBe(expectHeld);
-        expect(count).toBe(expectHeld ? 0 : 1);
-        // ... FK-ordered cleanup ...
+        const view = await loadPastRepliesPageView(/* isolated business */);
+        const row = view.unansweredRows.find((r) => r.review_id === propReviewId);
+        // projected mode: unanswered+pending draft ⇒ draft_ready unless held ⇒ none (#727 model)
+        expect(row!.row_action).toBe(expectHeld ? 'none' : 'draft_ready');
+        // filtered mode, BOTH spellings:
+        expect(await getPendingApprovalCount(sql(), isolatedBusinessId)).toBe(expectHeld ? 0 : 1);
+        const grouped = await getPendingApprovalCountsForAccount(sql(), accountId);
+        expect(grouped.get(isolatedBusinessId) ?? 0).toBe(expectHeld ? 0 : 1);
+        expect(grouped.get(suiteBusinessId) ?? 0).toBe(baseline); // no cross-business bleed
+        // FK-ordered cleanup of the per-run rows
       }),
       { numRuns: 12 },
     );
   });
 ```
 
-Import `fc` from `fast-check` and `getPendingApprovalCount` from
-`@/lib/dashboard/pending-count`. The property seeds/cleans INSIDE the
-predicate (per-run isolation); keep the fixture ids distinct from the suite's
-static seeds so the existing cases are undisturbed. Flesh the elided seed /
-assertion lines out against the suite's real helpers — the STRUCTURE above
-(subarray → seed → two reads → agree → cleanup) and `numRuns: 12` are locked.
+```ts
+  it('per-business and account-grouped pending counts exclude the same open-held rows across two businesses', async () => {
+    // isolated business: one pending_approval response WITH an open flag;
+    // suite business: untouched (its unheld pending responses are the second business).
+    // Assert: singular count(isolated)=0; grouped map: isolated→absent/0, suite→baseline.
+  });
+```
 

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'git diff HEAD''^ -- docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md | sed -n '"'320,760p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
 
-- [ ] **Step 3: read.integration.test.ts — timeline exclusion**
+```ts
+  it('hasOpenFlag executes the UUID-parameter fragment against live Postgres', async () => {
+    // Inside sql().begin(): hasOpenFlag(tx, heldResponseId) === true and
+    // hasOpenFlag(tx, unheldResponseId) === false, using rows seeded above.
+    // This is what makes the T2 re-expression's SQL VALIDITY live-verified —
+    // mkTx cannot catch malformed nesting or a bad ::uuid cast.
+  });
+```
 
-Read the suite for its seed helpers, then add:
+(Complete elided bodies with the suite's own helpers; titles, structure,
+assertions-as-commented are locked. Import `fc` from `fast-check`,
+`getPendingApprovalCount`/`getPendingApprovalCountsForAccount` from
+`@/lib/dashboard/pending-count`, `hasOpenFlag` from
+`@/lib/moderation/held-draft`.)
+
+- [ ] **Step 3: read.integration.test.ts — titles #4 and #7**
 
 ```ts
   it('getReviewTimeline excludes a response whose flag is open and includes it once closed', async () => {
-    // Behavior-pinning for the T6 anti-join → NOT EXISTS rewrite: the
-    // timeline hides a held draft (invariant #4) and shows it again after
-    // the admin disposition closes the flag.
-    // seed: review + pending_approval response (suite helpers), then:
-    // 1. INSERT flagged_responses row (status 'open') → timeline response null
-    // 2. UPDATE the flag to 'dismissed_false_positive' → timeline shows it
+    // seed review + one displayable response; INSERT open flag → timeline response null;
+    // UPDATE flag to 'dismissed_false_positive' → timeline shows the response.
+  });
+
+  it('getReviewTimeline falls back to the newest unheld response when the latest response is open-flagged', async () => {
+    // seed v1 (unheld) + v2 (open-flagged, higher version) on one review:
+    // timeline must return v1 — NOT null. Pins that held-filtering applies to
+    // the candidate set BEFORE ORDER BY version DESC LIMIT 1 (the T6 rewrite
+    // must preserve this).
   });
 ```
 
-(Complete the body with the suite's own seed helpers; both assertions go
-through `getReviewTimeline(sql(), { accountId, reviewId })`.)
+Also add `.todo` stubs where they belong:
+in `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts`:
+`it.todo('each draft-status awaited query projects held from its correctly correlated response alias')`;
+in `src/lib/dashboard/__tests__/service.test.ts`:
+`it.todo('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned')`.
 
-- [ ] **Step 4: run — pinning tests GREEN, stub todo**
+- [ ] **Step 4: run — all green (4 todos)**
 
 ```bash
-cd <worktree> && pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
+pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
 TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts src/lib/agents/__tests__/read.integration.test.ts
 ```
 
-Expected: all green (1 todo). If the live-DB suites fail on schema, run
-`pnpm test:db:setup` once first.
+(If schema assertions fail: `pnpm test:db:setup` once, re-run.)
 
-- [ ] **Step 5: Commit**
+- [ ] **Step 5: Commit (path-scoped)**
 
 ```bash
-git add -A && git commit -m "test(#730): eval task — pin held-draft behavior across the predicate consolidation"
+git add src/lib/moderation/__tests__ src/lib/past-replies/__tests__ src/lib/agents/__tests__ "src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__" src/lib/dashboard/__tests__
+git commit -m "test(#730): eval task — pin held-draft behavior across the predicate consolidation"
 ```
 
 ### Task 2: `openFlagExistsSql` + re-expressed `hasOpenFlag` + divergence block
@@ -240,22 +270,20 @@ git add -A && git commit -m "test(#730): eval task — pin held-draft behavior a
 - Modify: `src/lib/moderation/held-draft.ts`
 - Modify: `src/lib/moderation/__tests__/held-draft.test.ts`
 
-- [ ] **Step 1: fill the `.todo` test (red)**
-
-Replace the `.todo` with (mkTx captures the fragment build as its own call):
+- [ ] **Step 1: fill title #1 (red)**
 
 ```ts
 describe('openFlagExistsSql', () => {
   it('openFlagExistsSql spells the correlated open-flag EXISTS once, against the given ref', () => {
     const { tx, calls } = mkTx([]);
     openFlagExistsSql(tx, tx`resp.id`);
-    // two captured calls: the ref fragment, then the EXISTS wrapper
     const exists = calls.at(-1)!;
     expect(exists.text).toContain('EXISTS (');
     expect(exists.text).toContain('FROM flagged_responses fr');
     expect(exists.text).toContain("fr.status = 'open'");
     expect(exists.text).toContain('fr.response_id = ');
   });
+  it.todo('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains');
 });
 ```
 
@@ -272,13 +300,12 @@ type DbClient = postgres.Sql | postgres.TransactionSql;
 
 /**
  * The one read-side spelling of "response X has an OPEN moderation flag".
- * Composable Postgres.js fragment (nested queries splice as raw SQL text), so
- * it works projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` —
- * D9 SELECTed-not-filtered sites) and filtered
- * (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}` — dashboard reads).
- * `ref` is itself a fragment: a correlated column ref (sql`resp.id`) or a
- * bound parameter (tx`${responseId}::uuid`). Client-agnostic like
- * statusArraySql — pass the surrounding query's client.
+ * Composable Postgres.js fragment (nested queries splice as raw SQL text):
+ * projected (`${openFlagExistsSql(sql, sql`resp.id`)} AS held` — D9 sites) or
+ * filtered (`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`). `ref` is
+ * itself a fragment: a correlated column ref (sql`resp.id`) or a bound
+ * parameter (tx`${responseId}::uuid`). Client-agnostic like statusArraySql —
+ * pass the surrounding query's client.
  */
 export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postgres.Row[]>) {
   return db`EXISTS (
@@ -288,11 +315,9 @@ export function openFlagExistsSql(db: DbClient, ref: postgres.PendingQuery<postg
 }
 ```
 
-(If `postgres.PendingQuery<postgres.Row[]>` fights the tagged-template return
-type, mirror however `statusArraySql`'s return type is inferred — do NOT cast
-through `any`; `postgres.Fragment` is the v3 alternative.)
-
-Re-express `hasOpenFlag` (signature and contract UNCHANGED):
+(If `postgres.PendingQuery<postgres.Row[]>` fights the inferred
+tagged-template type, mirror `statusArraySql`'s inference; `postgres.Fragment`
+is the v3 alternative. No `any`.)
 
 ```ts
 export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boolean> {
@@ -304,10 +329,7 @@ export async function hasOpenFlag(tx: TxClient, responseId: string): Promise<boo
 }
 ```
 
-- [ ] **Step 3: divergence comment block**
-
-Extend the module's contract header (after the existing release-disposition
-lines) — the #725 §3 sink:
+- [ ] **Step 3: divergence comment block** (extend the contract header — #725 §3 sink)
 
 ```ts
 // Deliberately distinct consumers — do NOT consolidate onto this module.
@@ -326,12 +348,10 @@ lines) — the #725 §3 sink:
 //     keeps its own module-local status const (different lifecycle).
 ```
 
-- [ ] **Step 4: update existing text-pinning assertions**
+- [ ] **Step 4: update mkTx call-count assertions**
 
-The re-expressed body makes `mkTx` capture 3 calls (ref build, fragment
-build, executed query). In the existing test
+The re-expressed body makes `mkTx` capture 3 calls. In
 `"filters on status = 'open' and the response id — the predicate that makes the hold binding"`:
-drop `expect(calls).toHaveLength(1)`; assert over ALL captured text instead:
 
 ```ts
     const allText = calls.map((c) => c.text).join('\n');
@@ -343,21 +363,23 @@ drop `expect(calls).toHaveLength(1)`; assert over ALL captured text instead:
 - [ ] **Step 5: run + commit**
 
 ```bash
-pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts   # all green
+pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
+TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # title #6 live-verifies the new body
 pnpm typecheck
-git add -A && git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
+git add src/lib/moderation
+git commit -m "feat(#730): openFlagExistsSql fragment — one read-side spelling of the open-flag predicate"
 ```
 
 ### Task 3: Migrate `load-replies.ts` + regen allowlist entry (~1285)
 
 **Files:**
 - Modify: `src/lib/past-replies/load-replies.ts:230-244`
-- Modify: `scripts/ci/tenant-scope-allowlist.ts` (`load-replies` main-query entry)
+- Modify: `scripts/ci/tenant-scope-allowlist.ts` (load-replies main-query entry)
 - Check: `src/lib/past-replies/__tests__/` unit suites for outer-text assertions
 
-- [ ] **Step 1: rewrite the spelling + the stale comment**
+- [ ] **Step 1: rewrite the spelling + the stale #680 comment**
 
-Old (the comment cites #680, which never did the consolidation):
+Old:
 
 ```
       -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
@@ -376,7 +398,8 @@ Old (the comment cites #680, which never did the consolidation):
           ) AS held
 ```
 
-New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`):
+New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`; use the
+client variable actually in scope):
 
 ```
       -- src/lib/moderation/held-draft.ts is the SEMANTIC owner of "a draft is
@@ -389,98 +412,94 @@ New (import `openFlagExistsSql` from `@/lib/moderation/held-draft`):
           ${openFlagExistsSql(sql, sql`resp2.id`)} AS held
 ```
 
-(Use the client variable actually in scope in that function — read the file.)
-
 - [ ] **Step 2: regen the allowlist entry**
 
 ```bash
 pnpm ci:tenant-scope 2>&1 | tail -30
 ```
 
-Expected: FAIL naming `src/lib/past-replies/load-replies.ts` with the
-newly-extracted query text. Paste that text into the existing entry's
-`sqlSnippet` (file ~line 1285, `table: "responses"`). Entry COUNT unchanged —
-do not touch `ALLOWLIST_BASELINE`. Re-run; expected PASS.
+Expected: FAIL naming `load-replies.ts` with the newly-extracted query text.
+Paste it into the existing entry's `sqlSnippet` (~line 1285,
+`table: "responses"`). Entry COUNT unchanged — `ALLOWLIST_BASELINE` stays 409.
+Re-run; PASS.
 
 - [ ] **Step 3: run + commit**
 
 ```bash
 pnpm vitest run src/lib/past-replies
 TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts
-git add -A && git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
+git add src/lib/past-replies scripts/ci/tenant-scope-allowlist.ts
+git commit -m "refactor(#730): load-replies composes openFlagExistsSql"
 ```
 
-If a unit suite pinned the outer query text containing the inline EXISTS,
-update it to expect the fragment call shape instead (see the Task 2 pattern).
+If a unit suite pinned outer query text containing the inline EXISTS, relocate
+the assertion to the fragment's captured call (fragment-aware double if the
+suite is queue-based) — never delete it.
 
-### Task 4: Migrate the two draft-status routes + regen entry (~327)
+### Task 4: Migrate the two draft-status routes + regen entry (~327) + title #9
 
 **Files:**
 - Modify: `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:57-75`
 - Modify: `src/app/api/dashboard/past-replies/draft-status/route.ts:109-127`
 - Modify: `scripts/ci/tenant-scope-allowlist.ts` (past-replies draft-status entry ~327)
-- Check: both routes' test suites for outer-text/call-count assertions
+- Modify: both routes' test suites — fragment-aware doubles + title #9
 
 - [ ] **Step 1: reviews/[reviewId]/draft-status — rewrite**
 
-Comment block: keep the F5/invariant-#4 rationale and the D9 sentence; replace
-the two sentences claiming the predicate "spells … inline instead (D6)" with:
+Comment: keep F5/invariant-#4 + D9 sentences; the "spells … inline (D6)"
+sentences become:
 
 ```ts
     // That module is the SEMANTIC OWNER of "is this draft held"; this read
     // path composes its openFlagExistsSql fragment (#730).
 ```
 
-Query: replace
-
-```
-        EXISTS (
-          SELECT 1 FROM flagged_responses f
-          WHERE f.response_id = resp.id AND f.status = 'open'
-        ) AS held
-```
-
-with
+Query: `EXISTS (…) AS held` block →
+`${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held`.
 
-```
-        ${openFlagExistsSql(sqlRead, sqlRead`resp.id`)} AS held
-```
+- [ ] **Step 2: past-replies/draft-status — rewrite**
 
-(build the fragment with the client executing the query — here `sqlRead`).
+Same comment treatment; predicate →
+`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held`
+(this query's correlated ref is the unaliased table).
 
-- [ ] **Step 2: past-replies/draft-status — rewrite**
+- [ ] **Step 3: upgrade BOTH suites' doubles to the fragment-aware pattern**
+(header of this plan) — the queue-based mocks otherwise consume the queued
+row on fragment-build calls. Then fill title #9 (moved from `.todo`):
 
-Same treatment: the D6 sentence becomes "composes its openFlagExistsSql
-fragment (#730)"; the projected EXISTS becomes
-`${openFlagExistsSql(sqlRead, sqlRead`responses.id`)} AS held` (this query's
-correlated ref is the unaliased table: `responses.id`).
+```ts
+  it('each draft-status awaited query projects held from its correctly correlated response alias', async () => {
+    // run the route with a queued draft row, then:
+    const refCall = readCalls.find((c) => c.text.trim() === 'resp.id');   // 'responses.id' in the past-replies suite
+    expect(refCall, 'fragment ref must correlate on the outer query alias').toBeDefined();
+    const existsCall = readCalls.find((c) => c.text.includes('FROM flagged_responses'));
+    expect(existsCall!.text).toContain("fr.status = 'open'");
+  });
+```
 
-- [ ] **Step 3: regen entry ~327, run, commit**
+- [ ] **Step 4: regen entry ~327, run, commit**
 
 ```bash
 pnpm ci:tenant-scope 2>&1 | tail -30   # fails naming past-replies/draft-status; paste new snippet
 pnpm vitest run "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies
-git add -A && git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
+git add "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies scripts/ci/tenant-scope-allowlist.ts
+git commit -m "refactor(#730): draft-status routes compose openFlagExistsSql"
 ```
 
-(The reviews route has no allowlist entry — it binds `resp.business_id`; only
-the past-replies entry regenerates. Update any route-test assertions that
-pinned `FROM flagged_responses` in the OUTER captured text — the fragment now
-registers its own captured call.)
+(The reviews route has no allowlist entry — it binds `resp.business_id`.
+Relocate — never delete — any outer-text assertions that pinned
+`FROM flagged_responses`.)
 
-### Task 5: Migrate the dashboard trio + regen 4 entries (~1509/1516/1530/1537)
+### Task 5: Migrate the dashboard trio + regen 4 entries + title #10
 
 **Files:**
 - Modify: `src/lib/dashboard/service.ts:253-256`
 - Modify: `src/lib/dashboard/aggregate-service.ts:404-407`
 - Modify: `src/lib/dashboard/pending-count.ts:17-20,45-48`
-- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries)
-- Check: `src/lib/dashboard/__tests__/` for text assertions
+- Modify: `scripts/ci/tenant-scope-allowlist.ts` (4 entries: ~1509/~1516/~1530/~1537)
+- Modify: `src/lib/dashboard/__tests__/` — fragment-aware doubles where queue-based + title #10
 
-- [ ] **Step 1: service.ts + aggregate-service.ts**
-
-Both LATERALs keep their two comments (tenant-scope + held-drafts rationale);
-the filter block
+- [ ] **Step 1: service.ts + aggregate-service.ts** — keep both comments; the block
 
 ```
           AND NOT EXISTS (
@@ -496,42 +515,52 @@ becomes
 ```
 
 (correlated ref is the unaliased `responses` table in both LATERALs; use each
-query's in-scope client variable).
-
-- [ ] **Step 2: pending-count.ts — BOTH spellings**
-
-In `getPendingApprovalCount` and `getPendingApprovalCountsForAccount`:
+query's in-scope client variable.)
 
-```
-      AND NOT EXISTS (
-        SELECT 1 FROM flagged_responses fr
-        WHERE fr.response_id = resp.id AND fr.status = 'open'
-      )
-```
+- [ ] **Step 2: pending-count.ts — BOTH spellings** →
+`AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}`. Import in all three files.
 
-becomes
+- [ ] **Step 3: fill title #10** (in `service.test.ts`, moved from `.todo`;
+upgrade the suite's double to fragment-aware if queue-based):
 
-```
-      AND NOT ${openFlagExistsSql(sql, sql`resp.id`)}
+```ts
+  it('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned', () => {
+    // capture the dashboard feed query text; slice the responses-LATERAL
+    // substring (between 'LEFT JOIN LATERAL' and ') resp ON true'):
+    const lateral = feedQueryText.slice(feedQueryText.indexOf('LEFT JOIN LATERAL'), feedQueryText.indexOf(') resp ON true'));
+    const notIdx = lateral.indexOf('AND NOT ?');       // fragment placeholder, NEGATED polarity
+    const orderIdx = lateral.indexOf('ORDER BY version DESC');
+    expect(notIdx).toBeGreaterThan(-1);
+    expect(orderIdx).toBeGreaterThan(notIdx);          // filter BEFORE order/limit — held newest falls back to unheld sibling
+    // and the fragment itself was built with the right correlation:
+    expect(fragmentCalls.some((c) => c.text.trim() === 'responses.id')).toBe(true);
+  });
 ```
 
-Import `openFlagExistsSql` in all three files.
+(Repeat the same assertion shape for aggregate-service in its suite if its
+query text is separately capturable. Round-1 triage note: a live
+dashboard-service suite was weighed and rejected as disproportionate — this
+placement/polarity pin plus the live property on the IDENTICAL filtered
+composition (pending-count, title #5) covers inverted-polarity and
+filter-after-LIMIT regressions.)
 
-- [ ] **Step 3: regen entries, run, commit**
+- [ ] **Step 4: regen entries, run — INCLUDING the cross-module property — commit**
 
 ```bash
 pnpm ci:tenant-scope 2>&1 | tail -40   # 4 mismatches: service ×2, aggregate ×2 — paste each
 pnpm vitest run src/lib/dashboard
-git add -A && git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
+TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/past-replies/__tests__/load-replies.integration.test.ts   # titles #5/#8 exercise BOTH pending-count spellings live against the migrated code
+git add src/lib/dashboard scripts/ci/tenant-scope-allowlist.ts
+git commit -m "refactor(#730): dashboard reads compose openFlagExistsSql"
 ```
 
 (pending-count has NO allowlist entry — its queries are directly scoped;
-confirm `ci:tenant-scope` passes without adding one.)
+confirm the audit passes without adding one.)
 
-### Task 6: `agents/read.ts` — anti-join → NOT EXISTS (parallel-safe with T3–T5)
+### Task 6: `agents/read.ts` — anti-join → NOT EXISTS
 
 **Files:**
-- Modify: `src/lib/agents/read.ts:317-334` (`getReviewTimeline` response query)
+- Modify: `src/lib/agents/read.ts:317-334`
 - Check: `src/lib/agents/__tests__/read.test.ts` for join-text assertions
 
 - [ ] **Step 1: rewrite**
@@ -550,8 +579,7 @@ Old:
         AND fr.id IS NULL
 ```
 
-New (semantics-preserving: LEFT JOIN + `fr.id IS NULL` ⇔ NOT EXISTS; add a
-one-line comment naming invariant #4 + the owner module):
+New:
 
 ```
       FROM responses resp
@@ -569,35 +597,66 @@ one-line comment naming invariant #4 + the owner module):
 
 ```bash
 pnpm vitest run src/lib/agents
-TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/agents/__tests__/read.integration.test.ts
-git add -A && git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
+TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/agents/__tests__/read.integration.test.ts   # titles #4 and #7 — exclusion AND newest-unheld fallback
+git add src/lib/agents
+git commit -m "refactor(#730): timeline read composes openFlagExistsSql (anti-join → NOT EXISTS)"
+```
+
+(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched; no
+allowlist work here.)
+
+### Task 7: Source-scan test (title #11) + verify gate
+
+- [ ] **Step 1: fill title #11** in held-draft.test.ts (moved from `.todo`) —
+house precedent: source-scanning suites like
+`src/__tests__/eslint-boundaries.test.ts` / `design-token-single-source.test.ts`:
+
+```ts

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc 'git diff HEAD''^ -- docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md | sed -n '"'760,1040p'" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
+```ts
+  it('all eight owner-facing reads compose openFlagExistsSql and no owner-facing inline spelling remains', () => {
+    const OWNER_FACING = [
+      'src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts',
+      'src/app/api/dashboard/past-replies/draft-status/route.ts',
+      'src/lib/past-replies/load-replies.ts',
+      'src/lib/dashboard/service.ts',
+      'src/lib/dashboard/aggregate-service.ts',
+      'src/lib/dashboard/pending-count.ts',
+      'src/lib/agents/read.ts',
+    ];
+    for (const file of OWNER_FACING) {
+      const src = readFileSync(resolve(process.cwd(), file), 'utf-8');
+      expect(src, `${file} must compose openFlagExistsSql`).toContain('openFlagExistsSql');
+      expect(src, `${file} re-spells the open-flag predicate inline`).not.toMatch(/FROM\s+flagged_responses/i);
+    }
+  });
 ```
 
-(`agents/read.ts`'s allowlist entry is for `agent_run_steps` — untouched. No
-allowlist work in this task, which is what makes it parallel-safe.)
+Run the suite; commit:
 
-### Task 7: Verify gate
+```bash
+pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts
+git add src/lib/moderation/__tests__
+git commit -m "test(#730): source-scan — no owner-facing inline open-flag spelling remains"
+```
 
-- [ ] `cd <worktree> && bash scripts/verify-gate.sh` — full run, all rows PASS;
-  `promised-tests` finds all five titles; `reclassify` inside 2× both buckets.
-- [ ] Fix fallout (each fix re-runs the gate); on the same failure class twice,
-  STOP per the anti-thrash rule.
-- [ ] Final pre-review run: `bash scripts/verify-gate.sh --review`
-  (diff-coverage row on).
+- [ ] **Step 2:** `bash scripts/verify-gate.sh` — all rows PASS; no remaining
+  `.todo` among the eleven titles; `reclassify` inside 2× both buckets.
+- [ ] **Step 3:** fix fallout (re-run per fix; same failure class twice → STOP,
+  anti-thrash rule). Final pre-review run: `bash scripts/verify-gate.sh --review`.
 
 ---
 
-## Self-review (done at write time)
-
-- **Spec coverage:** #725 §2's four "Concretely for #730" bullets → T2 (fragment
-  + hasOpenFlag + no new helpers), T3–T6 (both usage modes at all 8 spellings);
-  §3 divergence sink → T2 step 3; #730's "divergence recorded" → same; #725
-  notes 1–5 → allowlist regen steps (T3/T4/T5), stale-#680-comment rewrites
-  (T3/T4), pending-count both spellings (T5), net-negative expectation
-  (intake), verification commands (intake + T1/T3/T6).
-- **Placeholder scan:** the two integration-test bodies are deliberately
-  structure-locked with elided seed lines (the suite's own helpers are the
-  precedent to follow, per anti-slop "precedent over invention") — each names
-  the exact fixture/helper to crib and locks title + assertion shape. No TBDs.
+## Self-review (v2)
+
+- **Round-1 findings coverage:** BLOCKER → T1 rebuilt on
+  `loadPastRepliesPageView` + isolated business + baseline guard. MAJORs →
+  titles #6 (live hasOpenFlag, T1/T2), #9 (alias correlation, T4), #7
+  (newest-unheld fallback, T1/T6), #8 (grouped counts, T1/T5), #10
+  (placement/polarity, T5 — partial-accept, live dashboard suite rejected as
+  disproportionate, reasoning inline), #11 (source-scan, T7); fragment-aware
+  double specified and mandated in T4/T5; T5 re-runs the property; full
+  serialization + path-scoped staging. MINOR → intake edge_case corrected
+  (deviations entry).
+- **Placeholder scan:** elided test bodies each name the exact fixture/helper
+  to crib and lock title + assertion structure; no TBDs.
 - **Type consistency:** `openFlagExistsSql(db, ref)` spelled identically in
-  T2–T6; ref always the executing client's fragment.
+  T2–T7; ref always the executing client's fragment.

hook: PostToolUse
hook: PostToolUse Completed
hook: PreToolUse
hook: PreToolUse
hook: PreToolUse Completed
hook: PreToolUse Completed
exec
/bin/zsh -lc "nl -ba scripts/verify-gate.sh | sed -n '270,320p'; rg -n \"\\.todo|promised-tests|tests_to_add\" scripts/verify-gate.sh .feature -g '*.sh' -g '*.ts' -g '*.json' | head -120; rg -n \"git add -A|git add\" docs/superpowers/plans/2026-08-09-feat-730-open-flag-consolidation.md" in /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-730-open-flag-consolidation
 succeeded in 0ms:
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
scripts/verify-gate.sh:28:# or *.md, the code rows (test, build, promised-tests, reclassify,
scripts/verify-gate.sh:34:#   promised-tests — every tests_to_add entry (a VERBATIM test title) must
scripts/verify-gate.sh:285:# --- promised-tests: tests_to_add entries are verbatim test titles ---
scripts/verify-gate.sh:305:done < <(jq -r '.tests_to_add[]?' "$INTAKE" 2>/dev/null)
scripts/verify-gate.sh:306:if [ "$DOCS_ONLY" = false ] && jq -e '.tests_to_add | length > 0' "$INTAKE" >/dev/null 2>&1; then
scripts/verify-gate.sh:307:  NAMES+=("promised-tests")
scripts/verify-gate.sh:391:  echo "   test/build/promised-tests/reclassify/diff-coverage rows skipped)"
scripts/verify-gate.sh:403:  echo "PROMISED TESTS MISSING (tests_to_add titles not found verbatim in any test file):"
.feature/intake.json:54:  "tests_to_add": [
107:killed that: tasks share the worktree Git index and `git add -A` could stage
109:`git add -A`.) T1 still runs alone first as the enforcement spot check.
263:git add src/lib/moderation/__tests__ src/lib/past-replies/__tests__ src/lib/agents/__tests__ "src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__" src/lib/dashboard/__tests__
369:git add src/lib/moderation
431:git add src/lib/past-replies scripts/ci/tenant-scope-allowlist.ts
485:git add "src/app/api/dashboard/reviews/[reviewId]/draft-status" src/app/api/dashboard/past-replies scripts/ci/tenant-scope-allowlist.ts
553:git add src/lib/dashboard scripts/ci/tenant-scope-allowlist.ts
601:git add src/lib/agents
637:git add src/lib/moderation/__tests__

hook: PostToolUse
hook: PostToolUse Completed
codex
| Finding # | Status | Verification |
|---:|---|---|
| 1 | ADDRESSED | T1 uses `loadPastRepliesPageView`, an isolated business, per-run rows, both count spellings, and asserts the suite-business baseline inside every property run. |
| 2 | ADDRESSED | Title #6 executes `hasOpenFlag` with UUID-bound references against live Postgres and is rerun after T2. |
| 3 | ADDRESSED | T4 requires fragment-aware doubles in both route suites and pins `resp.id`/`responses.id` plus the open-flag EXISTS text. |
| 4 | FIX-INTRODUCED-DEFECT | T1/T5 target nonexistent `src/lib/dashboard/__tests__/service.test.ts`; the real suite is `service.feed-projection.test.ts`, whose flattening harness has neither `feedQueryText` nor `fragmentCalls` and will not produce `AND NOT ?`. Aggregate coverage is also optional, while pending-count never executes either LATERAL, leaving aggregate/LATERAL SQL validity and fallback behavior uncovered. |
| 5 | ADDRESSED | Title #8 and the property exercise singular and grouped counts across the isolated and baseline businesses. |
| 6 | ADDRESSED | Title #7 explicitly verifies fallback from an open-flagged newest response to the older unheld response. |
| 7 | NOT ADDRESSED | `verify-gate.sh` remains a fixed-string grep that accepts `.todo`; the plan adds only a prose requirement. Title #11 also accepts an import-only occurrence and does not verify eight helper invocations, including both pending-count sites. |
| 8 | ADDRESSED | The `isExecutedStatement` guard prevents fragment-building calls from consuming queued results, and T4/T5 mandate fragment-aware doubles where needed. |
| 9 | ADDRESSED | T5 explicitly reruns `load-replies.integration.test.ts`, including titles #5/#8. |
| 10 | ADDRESSED | Dispatch is fully serial and every commit uses path-scoped staging; no `git add -A` remains. |
| 11 | ADDRESSED | Both intake copies now state that pending-count has no allowlist entry, consistent with the plan and deviations record. |

VERDICT: REVISE
hook: Stop
hook: Stop
hook: Stop
hook: Stop Completed
hook: Stop Completed
hook: Stop Completed
tokens used
178,322
| Finding # | Status | Verification |
|---:|---|---|
| 1 | ADDRESSED | T1 uses `loadPastRepliesPageView`, an isolated business, per-run rows, both count spellings, and asserts the suite-business baseline inside every property run. |
| 2 | ADDRESSED | Title #6 executes `hasOpenFlag` with UUID-bound references against live Postgres and is rerun after T2. |
| 3 | ADDRESSED | T4 requires fragment-aware doubles in both route suites and pins `resp.id`/`responses.id` plus the open-flag EXISTS text. |
| 4 | FIX-INTRODUCED-DEFECT | T1/T5 target nonexistent `src/lib/dashboard/__tests__/service.test.ts`; the real suite is `service.feed-projection.test.ts`, whose flattening harness has neither `feedQueryText` nor `fragmentCalls` and will not produce `AND NOT ?`. Aggregate coverage is also optional, while pending-count never executes either LATERAL, leaving aggregate/LATERAL SQL validity and fallback behavior uncovered. |
| 5 | ADDRESSED | Title #8 and the property exercise singular and grouped counts across the isolated and baseline businesses. |
| 6 | ADDRESSED | Title #7 explicitly verifies fallback from an open-flagged newest response to the older unheld response. |
| 7 | NOT ADDRESSED | `verify-gate.sh` remains a fixed-string grep that accepts `.todo`; the plan adds only a prose requirement. Title #11 also accepts an import-only occurrence and does not verify eight helper invocations, including both pending-count sites. |
| 8 | ADDRESSED | The `isExecutedStatement` guard prevents fragment-building calls from consuming queued results, and T4/T5 mandate fragment-aware doubles where needed. |
| 9 | ADDRESSED | T5 explicitly reruns `load-replies.integration.test.ts`, including titles #5/#8. |
| 10 | ADDRESSED | Dispatch is fully serial and every commit uses path-scoped staging; no `git add -A` remains. |
| 11 | ADDRESSED | Both intake copies now state that pending-count has no allowlist entry, consistent with the plan and deviations record. |

VERDICT: REVISE
