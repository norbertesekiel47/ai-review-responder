# RepWorth — Claude Code Context

**Before any task, read `docs/agents/context-layout.md` (about 1,000 words).** It is the map: where each kind of context lives, how large each page is allowed to be, and how to add to it.

## What this project is

Agentic reputation-management platform for SMBs, sold as **Copilot** (owner approves everything) and **Autopilot** (bounded autonomy) subscription tiers. Three customer personas — **Reply** (drafts every response; auto-posts positive-quadrant on Autopilot), **Guardian** (triage + escalation; never acts publicly), **Insights** (weekly digest) — supervised by two watchdogs: the **Judge** (LLM review of 100% of auto-posts; availability is a posting precondition) and the **Governor** (per-account autonomy suspension). Design of record: `docs/roadmap/2026-07-01-agentic-reputation-platform-design.md` §8. Next.js 16 (Vercel, UI only) + Railway worker (Fastify + BullMQ, all LLM/external/long-running work) + Supabase/PostgreSQL + Redis(Upstash for Cache/Railway Redis for Queue).

Pipeline: Zernio webhook ingest → Guardian triage (`TRIAGE_ENABLED`, negative lane only) → AI draft → moderation → owner notification/approval, or gated `auto_policy` approval + veto window behind `AUTO_APPROVAL_ENABLED=true` → posted to Google → Judge verdict. Every persona action is recorded on the run spine (`agent_runs`/`agent_run_steps`/`agent_outcomes`) via the single writer `src/lib/agents/run-spine.ts`.

## Dev commands

- `pnpm worker` — Railway worker via tsx (port 3001); `pnpm dev:all` — full stack
- `pnpm worktree:new <branch> [base-ref]` — create an **isolated sibling worktree** outside the repo (own `node_modules`, copied `.env*.local`), then `cd` into the printed path. Use this for parallel feature branches; see "CI & repo" for why sibling not nested.
- `pnpm test:integration` — a developer fast-path that **hard-gates only the publisher edit-existing-reply suite** (fails fast without `TEST_DATABASE_POOL_URL`). It is NOT the CI gate for the live-DB lane — `pnpm test` is, and it runs every integration suite both in CI and locally. See gotcha below.
- `pnpm test:db:setup` — provision the local test DB to migrations head (bootstrap + every migration, local-only, drops schema `public` first). Run it once after creating the container and again whenever a migration lands: live-DB suites **assert** their schema (`assertSchemaReady`) instead of applying migrations, so a behind-head DB fails loudly rather than self-healing.
- `pnpm test:e2e` — Playwright E2E (skips gracefully without TEST_DATABASE_POOL_URL)
- `pnpm eval:llm` — LLM safety eval harness (offline/keyless by default; `--live` needs provider keys)
- `pnpm ci:*` — the CI audit scripts. The `ci:` entries in package.json are the authoritative list; do not keep a second copy of it here. Wiring, enforced by `src/__tests__/ci-audit-wiring.test.ts` (#590): the `lint` CI job runs every one of them **except** `ci:fallow:coverage`, which runs in ci.yml's `fallow` job (`needs: test`, consumes the `test` job's coverage artifact — the one sanctioned lefthook exemption, `CI_ONLY_BY_DESIGN`), and `ci:fallow`, which is the developer-facing sweep and gates nothing; `lefthook.yml` mirrors every audit the `lint` job runs. `ci:static-policy` enforces invariants #10, #13, #14; `ci:live-db-suites` enforces the two live-DB test conventions (see the gotcha below); `ci:outbox-status` enforces the `job_outbox` in-flight status vocabulary (invariant #2); `ci:secret-scan` runs gitleaks over the COMMITS in `<base ref>..HEAD` and fails closed on an absent binary, an unresolvable base ref or a scan that read nothing (#1374 — see "CI & repo"). `ci:directory-map` keeps `docs/directory.md` + `docs/directory/*.md` complete for `worker/` + `src/lib/` (one row per production file, no stale rows); `ci:pool-fanout` fails any `Promise` combinator over ≥2 DB-issuing elements in `src/lib/{admin,dashboard,locations}` (#893 — replaces the four enumerated fan-out pins, which stay but must not be widened).
- Set `MOCK_EXTERNAL_APIS=true` in `.env.local` to bypass all external APIs locally

## CI & repo

- Repo **`RepWorth/ai-review-responder`**; `main` is protected — **land changes via PR**, direct pushes rejected.
- CI (`.github/workflows/ci.yml`) is **PR-only** — no push-to-`main` run: the ruleset requires branches up to date (strict), so the PR run tests the exact tree that lands and a post-merge re-run was a pure duplicate. Required checks: `changes` (path classifier), `lint` (runs `pnpm typecheck` and the `ci:*` audit scripts — see "Dev commands" for which, and `src/__tests__/ci-audit-wiring.test.ts` for the check that keeps package.json, the workflows, and `lefthook.yml` from drifting apart), `test`, `llm-eval` (path-filtered LLM-safety eval release gate — WS7), `build`, `deploy-install`. Docs-only PRs short-circuit the heavy jobs via `changes` (job-level skips satisfy required checks; workflow-level `paths:` filters would leave them Expected and block the merge — that asymmetry is the whole design). `cache-warm.yml` keeps the main-branch pnpm/Playwright caches warm when lockfile/.nvmrc change. `MOCK_EXTERNAL_APIS=false` in CI — `true` short-circuits Zernio transport and breaks real-path tests. Third-party actions pinned to commit SHAs.
- **CI runs on managed cloud runners, routed by two repo variables** (`docs/runbooks/self-hosted-ci-runner.md` § Routing): `vars.CI_RUNNER_HEAVY` (lint/test/build/llm-eval, e2e, cache-warm → Blacksmith 4 vCPU x64) and `vars.CI_RUNNER_LIGHT` (changes/deploy-install/fallow, react-doctor → GitHub-hosted, inside the free minutes); each falls back to the legacy `vars.CI_RUNNER` (`self-hosted` = the parked Lima VM on the founder's Mac), then `ubuntu-latest`. Move CI with `gh variable set`, never a file change. **Draft PRs run no CI** — open with `gh pr create --draft`, `gh pr ready` when done (`changes` and `lint` gate on `draft == false`; the rest `needs: changes`). e2e runs against a production build under CI (`pnpm build` step, `webServer` = `pnpm start`), never the dev server. `claude.yml`/`claude-code-review.yml` stay hosted (the OAuth secret never reaches another runner); every `actions/cache` key carries `runner.arch`. The Mac VM stays installable (`install.sh`) but is parked: one runner = serial jobs, and it shares the Mac's cores with local agents.
- **Never push and `gh pr ready` in one breath.** The push fires `synchronize` while the PR is still a draft, so `changes` skips on `draft == false` and every job that `needs: changes` skips with it; the following `ready_for_review` is then lost to `cancel-in-progress`. GitHub counts a skipped required check as SATISFIED, so the PR reads `mergeState=CLEAN` with nothing tested. Mark ready first, or leave a gap — then confirm a run EXISTS (`gh run list --branch <b>`), not just that the checks are green. A skipped job and a passing job are both "pass" in `gh pr checks`; the run DURATION is what tells them apart (#1376).
- **Local pre-push hook (`lefthook.yml`)** runs the cheap CI subset before code leaves the machine — lint, typecheck, every CI audit, and affected tests (`vitest --changed`), in parallel. Same commands as CI; CI stays the full-suite gate. Installed via the `prepare` script on `pnpm install`. Escape hatch for WIP: `git push --no-verify`. **It now needs the `gitleaks` binary** (`brew install gitleaks`, #1374): `ci:secret-scan` fails closed without it, so the hook — and every `scripts/verify-gate.sh` run, which derives its audit set from package.json's `ci:*` keys — hard-fails on a machine that lacks it. CI installs 8.30.1 pinned by sha256; Homebrew is unpinned locally, and the script prints both versions so a drift is visible.
- **Worktrees: sibling (blessed) vs nested (footgun).** Use `pnpm worktree:new <branch>` (→ `scripts/new-worktree.sh`) — a sibling worktree at `../RepWorth-worktrees/<branch>/` with its own `node_modules` + copied `.env*.local`, so local lint/test/typecheck give a trustworthy signal. Nested worktrees (`.claude/worktrees/`, harness `EnterWorktree`, Agent `isolation:'worktree'`) leak the parent's deps/ESLint config into local CI — fine for edit+typecheck agents, never for trustworthy full CI. Every Write/Edit path must point at the worktree root, never the parent checkout (hook-enforced by `edit-surface-guard.sh`). Cleanup procedure + full mechanics: lab-notes/ci-tooling.md "Worktrees — sibling vs nested".

## Environments & branches

Trunk-based: `main` is the source of truth. Two long-lived branches — `main` (prod) and `staging` (integration anchor for the persistent staging env); "preview" is any open PR's auto-deploy, not a branch. Topology, URLs, concrete IDs: `docs/runbooks/deployment-guide.md`.

- **Three lanes.** *Preview* — per-PR, Vercel UI only (no worker/queue/webhooks → frontend checks only). *Staging* — persistent full stack, test/sandbox creds + separate Supabase; **the only non-prod place the whole pipeline runs**. *Production* — `main`, live creds.
- **Promotion = merge the PR into `main`.** `staging` is not a promotion gate — never "merge `staging` → `main`". Anything touching the worker, a webhook, a migration, or billing rides `staging` first, then lands on `main` via PR.
- **After promotion, realign `staging` to `main`** so it never drifts — the exact procedure is `deployment-guide.md` §"Re-sync staging", which branches on how staging got ahead. `git merge --ff-only main` works **only** when staging was merely behind; after a squash merge the two have genuinely diverged and it aborts, and the runbook's answer is `git reset --hard origin/main` + `git push --force-with-lease` (safe because staging is a disposable integration anchor — nothing of value lives only there). **Do not substitute a sync merge**: it "works" and leaves staging permanently ahead, which is the drift this rule exists to prevent (staging reached 101 commits ahead by #719 that way). Migrations run against **both** Supabase projects in lockstep, **staging first**; "applied to prod, not staging" is a bug. **There is no standing migration exception — staging and prod are in full lockstep.** 078 was applied to prod at 2026-08-31T07:09Z inside WS8 §7, closing the last gap; 077 (2026-07-17) and 105 (2026-08-14) were already there. Verified by introspection, not the ledger: both `subscription_tier` columns NOT NULL, both `accounts_subscription_tier_check` and `businesses_subscription_tier_check` present with definitions byte-identical to staging. Never re-derive lockstep from this sentence — introspect both databases, because a stale version of it is what made sessions contradict each other about 077 (audit + method: lab-notes/migrations.md "Migration lockstep audit"). All autonomy flags are OFF in prod; ordered go-live flip per design doc §8.4.
- **Push to `staging` auto-deploys the full staging stack.** Both the Railway staging worker **and** the Vercel staging Custom Env redeploy on push, git-sourced — the Custom-Env alias and its scoped vars still apply (confirmed live, #878). But the Deployments API's `target` field now reads `null`, not `target:"staging"` (drifted after the 2026-06-02 claim; re-verified 2026-09-23) — don't use it to check custom-env membership. Vercel previews still auto-deploy per PR. See `deployment-guide.md` Phase 3.
- **CI gates PRs only — neither `staging` pushes nor post-merge `main` pushes run CI** (strict up-to-date required checks make the PR run the authoritative gate) — rely on the PR's CI before promoting.
- **Local `main` lags after GitHub squash-merges** — `git pull --ff-only` (then `pnpm install` if deps changed).

## Architecture invariants — NEVER violate these

1. **Vercel = UI only.** LLM calls, external API calls, and long-running operations run on Railway workers, never in Next.js routes. Exceptions (ADR 0001): short, user-blocking OAuth-handshake calls needed for synchronous cookies/redirects (Zernio callback + select-location), and the named bounded manual-Disconnect cleanup approved for #1226. Durable recovery and long-running work stay on Railway. ESLint-enforced: `src/app/**`, `src/components/**`, and `src/instrumentation.ts` may not runtime-import `openai`/`@anthropic-ai/sdk`/`bullmq`/`postgres`/the response generator/the worker queue registry (type-only `import type` allowed; tests exempt); guarded by `src/__tests__/eslint-boundaries.test.ts`.

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
- No new top-level directories, no near-duplicate dependencies, no abstractions for a single caller, no npm/yarn lockfiles. Default is "no new file" — check `docs/directory.md` (Pages table) + the folder's `docs/directory/<page>.md` first (CI-complete for `worker/` + `src/lib/`: `ci:directory-map` fails on a production file with no row, or a row whose file is gone — a new file under those roots ships with its row in the same PR).
- **Next.js 16 moved things** — APIs, conventions, and file structure differ from most training data. Before writing or debugging Next-specific code (routing, caching, `next.config`, server/client boundaries), read the matching guide under `node_modules/next/dist/docs/`; it is version-matched to the installed `next` and mirrors the structure of nextjs.org/docs. Next's own auto-generated `AGENTS.md` block is deliberately off (`agentRules: false`, #798) — this bullet is that guidance's single owner.
- **Context and skill routing:** read relevant glossary entries via `CONTEXT-MAP.md`, not a whole context page. Start RepWorth UI work with `repworth-brand-design`; add design/motion skills for a concrete need and preserve project tokens. Honor explicitly requested skills. Do not add a second progress ledger or completion workflow to `$feature`.
- A follow-up named in a review document (arch-log entry, review record, deviations file, findings doc) gets an issue number in the same PR, or it is not named (#1383).
- When deleting a doc or ticking a checklist item, fix its audit tick and grep the filename to clean every cross-reference in the same change.
- **This file is shape-guarded** (`src/__tests__/claude-md-shape.test.ts`): "Where things live" rows ≤ 80 words, gotcha bullets ≤ 60, total ≤ 6,000. A row says WHERE to read + ≤ 3 one-clause traps; the WHY lives in `docs/directory/<page>.md` § folder, `docs/context/<context>.md`, or `.claude/reference/lab-notes/<topic>.md`; area traps live in `.claude/rules/`.

## Path-scoped rules

`.claude/rules/*.md` carry each area's traps and conventions; a file's `paths:` frontmatter names the globs it governs. Claude Code loads a rule automatically when it reads a matching file. Codex does not — run `pnpm agent:rules <path>` before editing and read every file it lists. Layout and caps: `docs/agents/context-layout.md`.

## Where things live

Detailed inventories load on demand — read the matching file before the work:

| Before you… | Read |
|---|---|
| find brand assets, design guidance, or generate marketing content | `docs/brand-asset-library/README.md` — brand kit, guidelines, visual systems, asset catalog, generation workflow, templates, and archive |
| write or debug a migration / touch schema | rule `.claude/rules/migrations.md` + `.claude/reference/migrations-log.md` |
| add an env var or flip a feature flag | rule `.claude/rules/env-flags.md` + `docs/eservices-variables.md` + `.claude/reference/env-vars.md` |
| touch review ingestion / add a ReviewSource | rule `.claude/rules/reviews-import.md` + `.claude/reference/review-ingestion.md` |
| touch the **agentic platform** (run spine `agent_runs`/`agent_run_steps`/`agent_outcomes`, personas Reply/Guardian/Insights, triage, trust dial + veto window, judge, governor, Copilot/Autopilot tiers) or **plan Phase 2 (run engine + Solicitation agent)** | rule `.claude/rules/agentic-platform.md` + design of record `docs/roadmap/2026-07-01-agentic-reputation-platform-design.md` §8 (As-built status — the entry point) |
| touch the **Owner Operator** (`agent_conversations`/`agent_turns`/`agent_proposals`/`agent_unsupported_requests`, `src/lib/agents/operator/`, `worker/jobs/agent-turn/`, the `/api/operator/*` routes, flag `OWNER_OPERATOR_ENABLED`) | glossary `docs/context/owner-operator.md` (terms verbatim) + spec `docs/roadmap/2026-09-11-owner-operator.md` (§12 acceptance, §14 go-live, §15 review/release log); the spec owns current run and environment status |
| touch the **admin invite funnel** (the 3-field admin form, `resolveFunnelEntry`/`funnelUrl`, the **Beta comp coupon**, the `checkout_attempt_*` snapshot, or resend-invite) | rule `.claude/rules/admin-portal.md` + plan `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md` |
| build or debug owner offboarding (cancel_only / delete_data / purge) | rule `.claude/rules/offboarding.md` + spec `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md` |
| build or debug multi-location (locations lifecycle, per-location overage billing, account-level digests, channel overrides) or run the two-location full-loop | rule `.claude/rules/locations-billing.md` + spec `docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md` |
| roll out / test the Telegram + WhatsApp channels, the auto-approved post FYI (`auto_post_notice` topic, `worker/jobs/auto-post-notice/`), or its `/r/google/<id>` redirect | rule `.claude/rules/channels.md` + runbook `docs/runbooks/channels-rollout.md` |
| touch any of the **12 mobile-channel enrollment routes** (`{admin,dashboard}/channels/{telegram,whatsapp}/{start,cancel,disable}`), the shared runners, or the **Channel actor** resolvers | rule `.claude/rules/channels.md` + spec `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4 |
| touch the **admin business query** (`/admin/overview`, `/admin/businesses`, the **At-risk list**, or the **Business summary** DTO) | rule `.claude/rules/admin-portal.md` + spec `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §5 |
| touch **review import consent** (the Import offer, `import_decision`, the derived-expiry predicate, or any of the four enqueue gates) | rule `.claude/rules/reviews-import.md` + spec `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` (§2 D1–D10 locked) |
| touch **solicitation consent or suppression** (Consent ledger `solicitation_consent`, Suppression ledger `solicitation_suppressions`, Unsubscribe tokens, `suppressionMatchSql`, or withhold-reason precedence in `evaluateAsk`) | rule `.claude/rules/solicitation.md` + spec `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` |
| touch the **approval/halt lane** (`approveBatch`/`haltBatch`/`adminHaltBatch`/`requestAskRegeneration`/`withdrawAsk`, **Ask exclusion**, **Ask regeneration**, **Ask withdrawal**, the Requests panel, the admin batch panel) | rule `.claude/rules/solicitation.md` + spec `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` D9/D22/D23 |
| touch the **Refusal ledger** (`refusal_events`, `src/lib/refusals/`, any of the seven lanes, or the **Restraint tab**) | rule `.claude/rules/refusals.md` + ADR `docs/adr/0023-refusal-log-owner-safe-projection.md` |
| touch a named library/subsystem (Postgres.js, Zernio, Stripe, Supabase auth, Vercel BotID/WAF, …) | `.claude/reference/lab-notes/README.md` (topic index) |
| deploy, promote, or reason about the preview/staging/prod split | `docs/runbooks/deployment-guide.md` |
| harden bot-protection / edge rate-limiting / WAF / Attack Mode | rule `.claude/rules/security-edge.md` + runbook `docs/runbooks/vercel-waf-rate-limiting.md` |
| build/debug worker health alerting, the `HealthAlertPoller`, or the `SENTRY_DSN` boot gate (`assertAlertSinkEnv`) | rule `.claude/rules/alerting.md` + runbook `docs/runbooks/beta-launch-alerting.md` |
| verify a spec / plan / launch doc against the codebase, or answer "what's remaining" on a checklist | invoke the `verify-spec` skill — evidence table + mandatory `VERDICT: PASS/FAIL` |
| run an architecture pass (owner-requested only — there is no merge counter or reminder) | runbook `docs/runbooks/architecture-pass.md` — window, agenda, issues not prose |

Patterns to follow (invoke as Skills): `outbox-pattern`, `approval-security`,
`cost-guard`, `onboarding-demo-cost-guard`, `new-migration` (before any
`supabase/migrations/` file), `flag-flip` (before changing any feature-flag
env var). Also invoke: `repworth-brand-design`
(any RepWorth UI), `supabase:supabase-postgres-best-practices` (Postgres query/schema perf),
`security-and-hardening` (BEFORE planning a change that crosses a trust
boundary), `constraint-driven-development` (a check was weakened, or a quality
gate changes), `doubt-driven-development` (one risky decision outside a guarded
`/feature` run). The last three are adapted third-party skills —
`docs/agents/third-party-skills.md`.

Code map: `docs/directory.md` (index) + `docs/directory/` (pages) · Layout reasoning: `docs/currents.md` ·
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

## Database

- **Schema + migrations** → rule `.claude/rules/migrations.md` + `.claude/reference/migrations-log.md` (authoritative).
- **Review sentiment**: `reviews.sentiment_*` populated by `classifySentiment` (`src/lib/reviews/sentiment.ts`, deterministic star-based `deterministic_star_v1`) at all review-content write sites; status-only writes don't touch it.
- **Finance/margin signals**: admin-only, aggregate-on-read from `api_costs` via `src/lib/admin/margin-service.ts`. Cross-account queries intentionally allowlisted in tenant-scope audit.

## Non-obvious gotchas — read before touching related code

- **Postgres.js + PgBouncer can return JSONB as strings.** Guard: `typeof x === 'string' ? JSON.parse(x) : x`, then narrow — the *only* sanctioned exception to the no-`any` rule. Every production parse site is on the allowlist in lab-notes/postgres.md "PgBouncer JSONB parse-site allowlist"; HTTP bodies, provider/LLM output, Redis, local storage and `TEXT[]` reads are different boundaries, not this carve-out.
- **postgres.js has NO admission control — the #773 chokepoint (`src/lib/db/admission.ts`) wraps `sql`/`sqlRead`/`sqlUnsubscribe`; never unwrap them.** Busy pool ⇒ pipelining onto a busy connection; `max` caps connections, not concurrency; no `max_pipeline` value is transaction-safe; per-request sequencing alone is insufficient. The gate trades latency for never wedging — **never "fix" p95 via `DB_POOL_MAX`**. Kill switch `DB_ADMISSION_ENABLED=false`; mechanics: lab-notes/postgres.md "#773 admission chokepoint".
- **BullMQ job IDs** → `.claude/rules/worker-layout.md`.
- **PgBouncer `statement_timeout` ~8s** — set `statement_timeout: 30_000` on Postgres.js client (OutboxPoller CTE exceeds the default).
- **`ON CONFLICT` / IMMUTABLE indexes** → `.claude/rules/migrations.md`.
- **Zernio `account.disconnected`** → `.claude/rules/reviews-import.md`.
- **`SELF_SERVE_SIGNUP_ENABLED` templates** → `.claude/rules/supabase-auth.md`.
- **`CleanupAbandonedSignupsPoller`** → `.claude/rules/worker-layout.md`.
- **Supabase `signUp()` `identities: []`** → `.claude/rules/supabase-auth.md`.
- **`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`** → `.claude/rules/next-app.md`.
- **Google Maps hex CIDs** → `.claude/rules/next-app.md`.
- **Owner channel enrollment org-default (account-scoped)** → `.claude/rules/channels.md`.
- **`SELECT … FOR UPDATE` is a no-op outside `sql.begin()`** — Supabase PgBouncer (transaction pooling) drops the row lock the instant the SELECT returns, so it never spans the following work. Either wrap the whole flow in `sql.begin()`, or drop the lock and use provider-side idempotency keys.
- **Single-replica worker** → `.claude/rules/worker-layout.md`.
- **Railway IPv6 (`family: 0`)** → `.claude/rules/worker-layout.md`.
- **Best-effort work after side effect** → `.claude/rules/worker-layout.md`.
- **postgres.js decodes `timestamptz` to a JS `Date`, silently truncating MICROSECONDS.** A comparison against a JS-round-tripped value can mis-order by <1ms — fatal when a row is compared against a window derived FROM that row (#520). Truncate the DB side (`date_trunc('milliseconds', col) > ${jsDate}`) or keep `::text` end-to-end. JS-Date fixtures carry zero µs — seed with `+ interval '419 microseconds'`.
- **`WORKTREE_EDIT_GUARD_DISABLE=1` leaks into `pnpm test` and neuters the guard its own self-tests exercise** — six tests in two suites under `scripts/ci/__tests__/` go red on files no branch touched. Run every gate as `env -u WORKTREE_EDIT_GUARD_DISABLE bash scripts/verify-gate.sh …`; CI never sets it. Story: lab-notes/history/2026-09-19-to-30.md (2026-09-21).
- **Live-DB suite naming / DDL** → `.claude/rules/live-db-tests.md`.
- **`TEST_DATABASE_POOL_URL` fallback** → `.claude/rules/live-db-tests.md`.
- **fallow coverage gate** → `.claude/rules/live-db-tests.md`.
- **live-DB lane gating** → `.claude/rules/live-db-tests.md`.
- **The worker crash-net RECOVERS from transient-DB `unhandledRejection`s; it does NOT blanket-crash.** `worker/index.ts` classifies via `isCrashNetRecoverableDbError` (strict allowlist — keep it distinct from billing's broad `isTransientPostgresError`): transient Postgres rejections are survived (Sentry warning; sustained storms escalate to crash via `worker/transient-rejection-governor.ts`); everything else fails fast and `uncaughtException` is ALWAYS fatal. Never reintroduce blanket crash-on-any-rejection. Full mechanics: lab-notes/worker-crash-net-cost-guard.md "Worker crash-net".
- **API rate limits fail OPEN by design; the Redis cost RESERVATION precedes every LLM call, so spend is safe when a limiter is bypassed.** Pre-LLM Redis transport failures are RETRYABLE (`CostInfraUnavailableError`, #255); budget-exceeded is TERMINAL; post-LLM finalize failures use `withCostGuard`'s `onFinalizeError`, never job retry. Never make the limiters strict. Upstash is a single-instance SPOF. Matrix: lab-notes/worker-crash-net-cost-guard.md "Cost-guard fail-open/retry matrix".

## MCP servers & CLIs

**MCP servers** — discover tools actually exposed in this session (Codex: available definitions/`ALL_TOOLS`; Claude: ToolSearch). Prefer a fitting MCP; use the documented CLI or official docs if unavailable. Registration does not prove authentication. Codex's optional direct servers live in `.codex/config.toml`; OAuth uses `codex mcp login <name>`.

| MCP | When |
| --- | --- |
| **Supabase** | DB queries, migrations, data debugging (remote HTTP MCP — auth before first use). For DB WRITES prefer `execute_sql` over inline `psql` one-liners — structured results and fewer shell-permission prompts |
| **Railway** | Worker infra — deploys, logs, metrics, env vars, services |
| **Stripe** | Billing inspection — Prices, subscriptions, events; OAuth before first use |
| **Vercel** | Frontend deploys, build logs, project status (remote HTTP MCP — auth before first use) |
| **Context7** | Optional library docs; fall back to version-matched local or official docs |
| **Sentry** | Incident investigation; separate from the application's Sentry SDK |
| **claude-mem** | "Did we solve this before?" — cross-session memory / observations |

Playwright E2E runs via `pnpm test:e2e`. Personal MCPs (Gmail, Drive, Calendar) may also be connected; not project tools. Memory is supplementary: an observer outage must not veto coding tools.

**CLIs** (in Bash):

- **Git/CI**: `git`, `gh` (PRs, issues, CI runs + logs)
- **Platform**: `vercel`, `railway`, `supabase`, `stripe` (webhook test + event replay), `gcloud`
- **Data/infra**: `psql` (Postgres direct), `redis-cli` (cache/queue), `docker`
- **Runtime/utils**: `node`, `pnpm`, `npx`, `tsx` (via pnpm/npx — not global), `rg`, `jq`, `curl`, `python3`
