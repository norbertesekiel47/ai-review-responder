# RepWorth — Progress Tracking

> **Human changelog — newest at the bottom.** This is the detailed build history.
> Agents looking for current state should read [currents.md](currents.md); for
> load-on-demand detail read [.claude/reference/](../.claude/reference/).
>
> **Older history is archived** to keep this file readable (live entries start at
> "CI Keystone", 2026-05-24):
> - [progress-archive/progresstracking-2026-04_sprints-1-to-6.md](progress-archive/progresstracking-2026-04_sprints-1-to-6.md) — Sprint 1 → Sprint 6 (2026-04-06 → 2026-04-17)
> - [progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md](progress-archive/progresstracking-2026-04-to-05_channels-to-multiloc.md) — Channels → Multi-location (2026-04-20 → 2026-05-22)

---

## CI Keystone + Repo Hardening (2026-05-24, branch `ci-keystone` → PR #57, follow-ups #61–#63)

**Why:** SaaS-readiness Step 1's first keystone (Spec 24, task 0) — stand up GitHub Actions CI from zero. There was no `.github/` directory at all; every "fail-the-build" gate in Specs 07/08/09/12/19/22/23/25 was blocked on a runner + required checks existing. Anything merged shipped (Vercel/Railway auto-deploy on push) with no lint/type/test barrier.

**What was done:**

1. **CI workflow** (`.github/workflows/ci.yml`) — four parallel jobs (`lint`, `typecheck`, `test`, `build`) on `pull_request` + `push:main`. Secret-free: a dummy env block (localhost URLs, `MOCK_EXTERNAL_APIS=false`, valid-length dummy `ENCRYPTION_KEY`) so `next build` and the unit suite run without production secrets. Hardened: least-privilege `permissions: contents: read`, `concurrency` with `cancel-in-progress`, pnpm-store caching.
2. **Composite action** (`.github/actions/setup`) — extracted the duplicated checkout/Node/corepack/pnpm/cache/install steps; `ci.yml` went 182 → 78 lines.
3. **Supply-chain hardening** (review-driven) — all third-party actions pinned to immutable commit SHAs with version comments (`checkout@…#v4.3.1`, `setup-node@…#v4.4.0`, `cache@…#v4.3.0`); `persist-credentials: false` on every checkout (gate never pushes). Rule documented in the design spec.
4. **Repo hygiene** — `.github/dependabot.yml` (npm + github-actions, weekly), `.github/pull_request_template.md`, `.github/CODEOWNERS` (`@norbertesekiel47`).
5. **Two real latent bugs the green-on-laptop suite hid, surfaced by the secret-free CI env:**
   - `MOCK_EXTERNAL_APIS=true` short-circuited the Zernio transport to a mock, so 16 real-path tests (injected `fetch`, error classification) never ran → fixed CI env to `MOCK_EXTERNAL_APIS=false` (matches `.env.local`).
   - `src/app/api/account/settings/__tests__/route.test.ts` built `new Request()` (a Web Request — no `.cookies`) and cast to `any`; the Supabase SSR cookie adapter (`src/lib/db/auth.ts:37`) threw inside GoTrueClient's async `_emitInitialSession` → unhandled rejections failed the run. Fixed by switching to `NextRequest` (carries a real cookies store).
6. **Branch protection** — repo transferred to the **RepWorth org** (Team plan) because private-repo branch protection requires a paid plan; then a repository **ruleset** ("main protection") was applied: requires the four checks + blocks force-push/deletion, enforced for all actors. (Classic branch protection and rulesets both 403 on a private Free-plan repo — hence the org move.)
7. **Verification** — CI proven green across PRs #57/#61/#62/#63; Vercel production auto-deploy verified end-to-end on the merge commit after the org transfer.
8. **Dependabot grouping fix** (PR #62) — the original prod/dev groups bundled breaking majors with safe patch/minor bumps, so the first grouped PRs (#59/#60) went red (Next 16 removed `next lint`; a TypeScript major broke CSS side-effect imports with `TS2882`). Reconfigured to group **only minor+patch**; majors now arrive as individual, reviewable PRs (#66–#73), with two safe green group PRs (#64/#65).

**Deliberately deferred (follow-ups, not gaps):** DB-backed integration tests in CI (need `TEST_DATABASE_POOL_URL` secret) and the 13 Playwright e2e — the integration subset self-skips today, so the gate is unit-only. The Railway worker deployment is parked pending a Redis choice (Upstash is a poor fit for BullMQ's polling; leaning Railway-managed Redis / Dragonfly).

**Lessons captured** (`.claude/skills/lab-notes.md`, 2026-05-24): CI is only trustworthy if its env mirrors prod intent (the `MOCK_EXTERNAL_APIS` trap); never validate CI from a git worktree nested inside the parent repo (module/eslintrc resolution leaks up and poisons lint+test); private-repo branch protection needs a paid plan (use a ruleset under an org); Dependabot groups must split majors from minor/patch.

---

## Step 1 Keystones — `past_due_at` + Audit Helper + Activation Capture (2026-05-24, branch `codex/step-1-keystones` → PR #81)

**Status:** COMPLETE — open as PR #81 (awaiting CI + merge). `pnpm typecheck`, `pnpm lint`, `pnpm build` green; focused Vitest suites pass (audit helper, posthog client, migration-043 structure, activation, publisher workers, Stripe webhooks, shutdown ordering). Migration **043** is additive/idempotent. Design: `docs/superpowers/specs/2026-05-25-step-1-keystones-design.md`.

**Why:** The SaaS-readiness plan (`docs/sass_ready/README.md`) has four Step 1 keystones; the CI keystone shipped in PR #57. This slice lands the remaining three together because they share migration numbering, worker paths, and verification: the `past_due_at` countdown source (Spec 05), the generalized account audit helper (Spec 04), and worker-side PostHog activation capture (Spec 01). Bundling them completes Step 1 and unblocks the dependent waves without pulling in the downstream UX (dunning banners, MFA/team UI, retention dashboards).

**What was done:**

1. **Migration 043** (`supabase/migrations/043_step_1_keystones.sql`) — `ADD COLUMN IF NOT EXISTS` only, no drops/data mutation. Adds `accounts.past_due_at TIMESTAMPTZ NULL` and five generic `account_audit_log` metadata columns (`entity_type`, `entity_id`, `ip`, `user_agent`, `request_id`). No new indexes (existing ones cover current queries). A structure test (`src/lib/shared/__tests__/migration-043-structure.test.ts`) guards the shape and asserts `account_memberships` is NOT created.
2. **Audit helper** (`src/lib/audit/log.ts`, `writeAccountAuditLog`) — typed Postgres.js helper that accepts the default `sql` client OR a transaction client, so audit rows are written atomically with the state change. Generates the UUIDv7, serializes JSONB via the existing `jsonb()` helper.
3. **`past_due_at` lifecycle** — wired into the three Stripe handlers (`worker/ingress/stripe/{invoice-payment-failed,invoice-paid,subscription-deleted}.ts`): set on the first `active→past_due`, preserved across repeat failures, cleared on recovery and on cancellation. All three now write their `subscription_status_changed` audit row through the helper instead of a raw INSERT.
4. **Worker analytics** (`src/lib/analytics/posthog.ts`) — lazy `posthog-node` client, no-op when `POSTHOG_API_KEY` is unset (so local/CI/build need no secret), with `shutdownAnalytics()` for lifecycle flush. Wired into `worker/index.ts` graceful shutdown (after workers close, before `sql.end()`, in a guarded try/catch).
5. **Activation chokepoint** (`worker/jobs/publisher/activation.ts`, `maybeCaptureActivationCompleted`) — emits `activation_completed` for the first account-level posted response within 7 days of `accounts.created_at`, scoped by `account_id`. Funnels ALL four posted-transition paths (main publish, edit-publish success, edit-publish `409_matches`, idempotent 409 reconciliation); captured AFTER the tx commits; best-effort (never blocks publish/outbox).

**Review-driven follow-ups (this branch, three rounds):**
- First review caught that the activation hook must cover all four `status = 'posted'` sites, not just the main path, and that `account_memberships` was scope creep for a Step 1 *audit* keystone (removed). Both fixed before implementation.
- Post-implementation review found `shutdownAnalytics()` was defined but never wired into the worker shutdown — a Railway redeploy would drop unflushed activation events. Wired in + guarded.
- Final cleanup: documented the helper's never-throws contract and removed the now-redundant outer try/catch at the three call sites; enforced the `reviewId` contract in the activation query (skip + warn on mismatch); replaced a dynamic `new RegExp` in the migration test with a whitespace-normalized substring check (external ReDoS-scanner false positive); added `invocationCallOrder` assertions so the "activation before outbox completion" contract is explicit.

**Deliberately deferred (not gaps):** `account_memberships` schema/backfill (later Spec 04 auth slice); the day-variant past-due banner + read-only route layer (Spec 05/29 Gap 5); `posthog-js` client SDK + retention dashboards + event taxonomy (Spec 01/11); wiring the CSV-import path through the audit helper. `checkSubscription`'s grace math still reads `businesses.updated_at` — `past_due_at` is now the available anchor to fix Known Residual Risk #2 but wasn't rewired here.

**Lessons captured** (`.claude/skills/lab-notes.md`, 2026-05-25): a "posted" response has four transition sites — hook all of them; fire best-effort telemetry after tx commit (return a candidate); flush + guard analytics on worker shutdown; let a best-effort helper own its never-throws contract instead of double-wrapping callers; remove dynamic-RegExp ReDoS false positives at the root rather than suppressing; `pnpm test` green doesn't imply `pnpm typecheck` green under `noUncheckedIndexedAccess`.

---

## Wave 1 — Foundation / Launch-Risk (2026-05-25, branch `codex/wave-1-foundation-launch-risk` → PR #85)

**Status:** COMPLETE — open as PR #85. `pnpm lint`, `pnpm typecheck`, `pnpm build` green; full Vitest suite green (3853 passed, 3 skipped — the DB-gated integration tests self-skip without `TEST_DATABASE_POOL_URL`). Migrations **044** and **045** are additive/idempotent. Design: `docs/superpowers/specs/2026-05-25-wave-1-foundation-launch-risk-design.md`; plan: `docs/superpowers/plans/2026-05-25-wave-1-foundation-launch-risk.md`.

**Why:** Wave 1 of the SaaS-readiness plan closes the risks that can make an early launch unrecoverable — cross-tenant data leakage, billing/invoice drift, missing approval evidence in disputes, inaccurate public legal/security claims, and PHI in review text. It implements the launch-risk subset of Specs 03, 05, 09, 17, and 29 (Gaps 1 + 2) as one coordinated "evidence-first launch gate," not the full contents of those specs.

**What was done (five slices):**

1. **Tenant isolation proofs (Spec 03).** `scripts/ci/rls-audit.ts` (reads `pg_class.relrowsecurity`, fails on a tenant table without RLS) + `scripts/ci/tenant-scope-audit.ts` (static scan of inline `sql\`...\`` for an `account_id`/`business_id` predicate) with a vetted, CI-guarded allowlist (`tenant-scope-allowlist.ts`); the scope audit runs in the blocking `lint` job. Guarded cross-tenant integration test (`src/__tests__/tenant-isolation.integration.test.ts`) seeds two accounts and asserts no leakage on real helpers. Docs: `docs/security/{rls-inventory,tenant-isolation}.md`.
2. **Billing + invoice reconciliation (Spec 05 / 29 Gap 2).** `StripeLocationsReconcilePoller` extended from location-count drift to subscription-level + multi-location upcoming-invoice reconciliation (`worker/background/pollers/billing-reconciliation/`). Detects missing/duplicate/status/price/quantity/upcoming-invoice drift, alerts via Sentry, never auto-corrects. Expected-invoice math respects grandfathering (stored `locations_included` + `locations_overage_price_cents`; base from live `TIER_CONFIG`). `past_due` within the 7-day grace window is informational, not drift. Pilot accounts via `accounts.flags.is_pilot` + `docs/finance/pilot-invoice-review-YYYY-MM.md`.
3. **Security launch controls (Spec 09).** `public/.well-known/security.txt`, static `/security` page (no overclaiming), vendor/access registers + secrets-rotation runbooks (`docs/security/`, `docs/runbooks/`), CSP report-only/nonce rollout plan (`'unsafe-inline'` NOT removed yet). **PHI scanner** (`src/lib/security/phi-scanner.ts`) blocks likely-PHI review text before persistence on every Zernio ingest path (webhook, backfill, recent-poller, reconcile), quarantines via a `zernio_likely_phi_review` exception, and never logs raw text.
4. **Legal + compliance accuracy (Spec 17).** Canonical `/legal/{terms,privacy,aup,dpa,cookies,sub-processors}` rendered from a typed content module (`src/lib/legal/content.ts`, no MDX); 308 permanent redirects from `/terms` + `/privacy`; reconciled sub-processor list (correct Zernio token-custody wording; PostHog omitted pending prod confirmation; SerpAPI + Google Maps Platform included); versioned docs; AI-disclosure banner at every owner-approval surface.
5. **Approval + invoice evidence (Spec 29 Gap 1 + 2).** Migration **044** adds `approval_audit_log.response_text_at_approval` — an immutable snapshot of the exact owner-approved text, written in the SAME transaction as the response mutation + outbox enqueue across all publish paths (token approve/edit, callback, owner session, dashboard publish/retry/restore). Migration **045** adds RLS to `onboarding_demos`.

**Review-driven follow-ups (this branch, multiple rounds):**
- First review caught two blockers: the recent-review poller bypassed the PHI scanner entirely (a live path), and the PHI regex over-matched normal review vocabulary for medical/wellness verticals. Both fixed — gate added to the poller; regex switched to co-occurrence (self-reference + medical-context).
- Closed should-fixes: stored-quota grandfathering in the reconciler, pilot process + finance template, PostHog removed from public sub-processor copy, `onboarding_demos` RLS (migration 045), tightened snapshot tests + DB-gated immutability test, canonical security email, CSP rollout doc, `docs/Legal`→`docs/legal` casing.
- Later CodeRabbit passes: removed misplaced UI disclaimer from the privacy/terms source docs; centralized `AI_DRAFT_DISCLOSURE`; made the PHI exception + admin-notify outbox atomic via a **caller-owned** `sql.begin` (TransactionSql lacks `.begin`); Sentry fires only for newly-created exceptions (not on `ON CONFLICT` no-op); added duplicate-no-op + `begin`-invoked test coverage; aligned all `security@` references to `.net`.

**Deliberately deferred (not gaps):** day-variant past-due UX + dunning emails + cancellation survey + Stripe Tax + chargeback tabletop (Wave 2 / later billing); `legal_acceptances` table + re-accept modal (later legal-hardening slice); CSP `'unsafe-inline'` removal (after report-only soak); ZAP/Trivy hard CI gates (need a stable staging target / image); MFA + team membership + support impersonation (later Spec 04/13); GBP-direct fallback + Zernio contract (Spec 29 Gap 3).

**Known follow-up:** the security contact is canonicalized to `security@repworth.net`, but every other operational mailbox is `@repworth.com` — reconcile which domain actually receives mail. The 6 DB-gated integration tests still self-skip in CI until `TEST_DATABASE_POOL_URL` exists (tracked in `docs/PENDING-db-gated-tests.md`). *(Resolved since: CI's `test` job gained a Postgres service + `TEST_DATABASE_POOL_URL`, the suites now run on every PR, and the reminder doc was deleted.)*

**Lessons captured** (`.claude/skills/lab-notes.md`, 2026-05-25 Wave 1): make the transactional-outbox helper caller-owned (`TransactionSql` has no `.begin`); gate PHI on every ingest path (`processReview` is the chokepoint, not just `insertImportedReview`) but don't double-gate the reconcile path; conservative PHI regex needs co-occurrence, not bare keywords; reconciliation expected-invoice reads STORED grandfathered quota, not live `TIER_CONFIG`; gate alerts behind a non-empty `RETURNING` so `ON CONFLICT DO NOTHING` doesn't spam.

---

## Wave 2 — Activation (2026-05-26, branch `codex-wave-2-activation` → PR #87)

**Status:** Implementation COMPLETE, open as PR #87. `pnpm lint` (eslint + tenant-scope audit), `pnpm typecheck`, `pnpm build` green; full Vitest suite green (**4051 passed, 3 skipped**). Migrations **046–049** are additive/idempotent and safe to run in order. Design: `docs/superpowers/specs/2026-05-25-wave-2-activation-design.md`. **CI on the final commit was blocked by a GitHub Actions outage (degraded → major, repo-wide), not by the branch** — all checks pass locally; re-run once Actions recovers.

**Why:** Wave 2 closes the risks that make a *paying* customer stall, churn, or need unsupported founder-only intervention during the first activation window. It implements the activation subset of Specs 06, 05/29 (Gaps 5–6), 04, and 13 as one "activation spine," not the full contents of those specs.

**What was done (four sub-specs):**

1. **Onboarding & activation measurement (Spec 06).** A **first-party analytics queue** replaces any `posthog-js`/Vercel→PostHog path: client intent events POST to `/api/analytics/enqueue` (same-origin, anon-rate-limited, gated to `CLIENT_ENQUEUEABLE_EVENT_NAMES`); durable events insert into `analytics_events` (migration 046) server-side; `worker/background/pollers/AnalyticsDispatchPoller.ts` ships rows to PostHog (`captureAnalyticsEvent`/`flushAnalytics`/`isAnalyticsConfigured` in `src/lib/analytics/posthog.ts`). Event taxonomy + dashboards documented in `docs/analytics/events.md`; funnel events `signup_started`, `email_verified`, `sample_demo_*`, `gbp_connect_*`, `first_review_ingested`, `first_response_drafted` (+ TTFV = first draft − email-verified). Zernio-connect polish (help link, redirect-timeout fallback, **server-side `gbp_connect_started`** so the per-account funnel joins `gbp_connected`), logged-out demo entry, CSV template + client validation + partial-success UI.
2. **Past-due recovery UX (Spec 05 / 29 Gaps 5–6).** Day-aware `SubscriptionStatusBanner` + day-5 `PastDueModal` + day-8 read-only layer, all driven by one shared `computePastDueRecoveryState` (`src/lib/shared/past-due-recovery.ts`) now consumed by BOTH the UI and the worker subscription guard (which stopped clocking off `businesses.updated_at`). Admin/founder **grant-extension** route (`/api/admin/billing/grant-extension`, AAL2-gated, writes `accounts.flags.past_due_extension` + audit in one tx; never mutates `past_due_at`). Migration **047** backfills `past_due_at` for pre-043 past-due accounts.
3. **Auth / MFA / audit hardening (Spec 04).** Settings → Security (`SecurityClient.tsx`) for Supabase TOTP enroll/verify/unenroll; `/api/auth/mfa/challenge` (challenge/verify/**unenroll**) with per-action rate limits and audit; `/mfa/challenge` step-up page; `src/lib/auth/mfa.ts` (`requireAal2` / `requireCurrentAal2FromSupabase`); AAL2 hard-required at grant-extension + impersonation; `MFA_ENFORCEMENT_ENABLED` kill-switch for the page-level blocking layer.
4. **Support & impersonation (Spec 13).** KB docs (`docs/help/*`), `/help/contact`, support macros (`docs/support/macros/*`), `docs/runbooks/support-extension.md`. **Admin view-as impersonation**: migration **048** `impersonation_sessions`, `src/lib/admin/impersonation/{cookie,session,view,guard}.ts`, `/admin/impersonate` pages + start/end routes — admin-owned (no Supabase session swap; service-role reads scoped by `account_id`), AAL2-gated, signed httpOnly cookie, 1-hour TTL, one-active-session (partial UNIQUE index), destructive-action allowlist guard. Migration **049** enables RLS on `analytics_events`.

**Review-driven follow-ups (two local rounds + the cloud `/ultrareview`):**
- My own first-pass review caught: the dispatcher permanently `failed` (and dropped) the whole funnel when `POSTHOG_API_KEY` was unset; `analytics_events` shipped without RLS (anon-readable); `daysRemaining` rounded up; future-dated `past_due_at` flipped instant read-only; impersonation lacked a view-loader AAL2 check, a one-active-session backstop, and a wired destructive guard; MFA unenroll was an unguarded client-side AAL1 call; the `/mfa/challenge` page broke `next build` (missing Suspense boundary). All fixed.
- `/ultrareview` (PR #87) then caught 5 more, all fixed: grant-extension `expires_at` was a no-op for already-locked-out accounts (now `max(graceDeadline, now) + days`); expired-but-unended impersonation sessions permanently 409'd new starts (now reaped on start); the enqueue route accepted server-owned event names (now gated to the intent subset); the connect funnel couldn't join per-account (now server-side `gbp_connect_started`); `/help/contact` had self-referential links.
- Also reconciled the **tenant-scope CI audit** allowlist, which had drifted from Wave 2's SQL changes (its first CI run on this long-lived branch surfaced accumulated drift).

**Deliberately deferred (not gaps):** `account_memberships` / teams / invite UI (later Spec 04); full dunning emails + cancellation survey + Stripe Tax (later Spec 05); Microsoft SSO / passkeys / custom recovery codes; full Mintlify docs site + in-app chat vendor + Help Scout API integration (later Spec 13); BI dashboards beyond the documented PostHog definitions (Spec 11); GBP-direct fallback / Trust Center (Spec 29 later gaps).

**External gates (not code):** confirm `POSTHOG_API_KEY` in prod before relying on the funnel; set `IMPERSONATION_COOKIE_SECRET` (≥32 chars); Help Scout inbox/workflow setup; lawyer review of support/legal copy. If migration 048 already ran in a shared dev DB, `supabase db reset` it to pick up the UNIQUE active-session index (prod unaffected — none of 046–049 have shipped).

**Lessons captured** (`.claude/skills/lab-notes.md`, 2026-05-26 Wave 2): unconfigured/transient analytics failures must not burn an event's retry budget (early-return + defer, `flush`-before-`completed`, drain on shutdown); one past-due recovery clock for UI + worker, floored and skew-clamped; grant-extension anchors `max(graceDeadline, now) + days`; reap expired impersonation sessions on start + re-check AAL2 on the view; every public table needs RLS or it's anon-readable; durable analytics facts are server-emitted, only intent events are client-postable; the `lint` CI job is eslint **and** the tenant-scope audit, and editing a query's SQL breaks its allowlist snippet.

---

## Wave 3 — Visibility & AI Safety (2026-05-26, **partially shipped as a stacked PR set**)

**Status:** Wave 3 ships in **six PRs**; PRs 1–3b are **merged to `main`** and PR 4 (eval harness + trust-safety docs) is **built and green**. **PRs 5–6 are not yet built.**

| PR | Branch | Scope | Migrations |
|---|---|---|---|
| #93 | `wave-3-pr1-observability-spine` (off `main`) | Observability spine | — |
| #94 | `wave-3-pr2-ai-audit-foundation` (off `main`) | AI audit foundation | 050 |
| #95 | `wave-3-pr3a-moderation-backend` (stacked on #94) | Moderation backend | 051 |
| #96 | `wave-3-pr3b-admin-flagged-queue` (stacked on #95) | Admin flagged queue | — |
| PR 4 | `wave-3-pr4-eval-trust-safety` (off `main`) | LLM eval harness + trust-safety docs | — |

Each PR's full unit suite + `typecheck` + `build` + `ci:tenant-scope` are green (suite grew to ~4118 tests). #93 is independent of the #94→#95→#96 stack; merge order is #93/#94 → #95 → #96. Design: `docs/superpowers/specs/2026-05-26-wave-3-visibility-ai-safety-design.md`. Per-PR plans: `docs/superpowers/plans/2026-05-26-wave-3-pr*.md`.

**Why:** Make failures *visible* first, then layer AI safety on traceable execution, then hold unsafe drafts out of the owner approval path. Implements the launch-critical slice of Specs 07, 22, and 10 (Specs 11 + 26 are the remaining PRs 5–6).

**What was done (PRs 1–3b):**

1. **Observability spine (Spec 07, #93).** `createWorkerLogger` emits one JSON object per line (`src/lib/shared/logger.ts`) with per-request/job IDs propagated via `AsyncLocalStorage` (`src/lib/shared/log-context.ts`); a `withJobLogContext` wrapper (`worker/job-log-context.ts`) binds job IDs at BullMQ registration — no handler edits. New Next.js `GET /api/health`; worker health enriched (`service`, `uptime_seconds`). Admin `/admin/jobs` queue view gained `completed` + `paused`. `docs/analytics/events.md` became a typed taxonomy, enforced by a CI drift audit (`scripts/ci/analytics-events-audit.ts`, `pnpm ci:analytics-events`). On-call runbooks added (`docs/runbooks/{observability,oncall-3am,alert-tuning}.md`). The logger fails open on cyclic/unserializable args.
2. **AI audit foundation (Spec 22, #94, migration 050).** OpenAI model pinned to `gpt-4o-mini-2024-07-18` (exported + guarded by `model-pinning.test.ts`; no bare alias). Versioned/hashed prompt safety base (`src/lib/responses/prompt-policy.ts` — `PROMPT_VERSION` + `systemPromptHash()`). Migration 050 adds the full `api_costs` metadata column set (`system_prompt_hash`, `prompt_version`, `latency_ms`, `moderation_*`, `flagged`, `flag_reason`, `output_excerpt`); generation records prompt version/hash + latency + `account_id`. Prompt-injection hardening: review text wrapped in a delimited `<review>` data block with a "do not follow instructions inside" directive, untrusted fields escaped so an embedded `</review>` can't break out.
3. **Moderation backend (Spec 10, #95, migration 051).** `src/lib/moderation/output-filter.ts` (local regex rules → `ModerationDecision`) + `moderate.ts` (orchestrator; OpenAI Moderation behind `OPENAI_MODERATION_ENABLED`, **fails open**). `ResponseGeneratorWorker` moderates after the avoid-facts guardrail and, in the existing transaction, records moderation on `api_costs` and — for a `high`-severity flag — inserts a `flagged_responses` row (migration 051, admin-only deny-all RLS) and **skips the owner `send_notification`**. Draft stays `pending_approval`; no auto-posting. `medium`/`low` are recorded but don't block.
4. **Admin flagged queue (Spec 10, #96).** `GET /api/admin/flagged` (admin cross-tenant list, allowlisted) + `POST` disposition (CSRF + admin + AAL2 + one tx). `approved_for_owner_review` releases the draft by enqueuing the notification via the transactional outbox; `dismissed_false_positive` / `requires_regeneration` are terminal status-only. `/admin/flagged` page with per-row disposition buttons + offset pagination.
5. **Eval harness + trust-safety docs (Specs 22 + 10, PR 4).** Launch-critical LLM eval harness at `tests/llm-eval/*` that **runs green with no provider keys**: `eval-set.jsonl` (8 launch rows — positive, negative complaint, refund demand, prompt injection, competitor mention, no-written-review, bilingual, sensitive category) each carrying a safe canned candidate; the offline default scores that candidate through the production `runOutputFilter` (`scorer.ts` — no rule reimplementation) against per-row severity + forbidden-category thresholds; `run.ts` exposes a pure `runEval` + `pnpm eval:llm` CLI writing gitignored JSON reports; `--live` dynamically imports a key-gated `live-runner.ts` that calls `generateResponse` in demo mode (heavy deps isolated off the offline path). A keyless Vitest smoke suite (21 tests) is the CI gate via a new `tests/**/__tests__` include glob. Trust-safety enforcement docs added: `docs/trust-safety/{enforcement-workflow,abuse-reporting}.md` + `cases/_template.md`. No migration.

**Review-driven follow-ups (fixed per PR):** #94 — escape `<review>` injections + require `accountId` in production generation + strip stray plan-doc artifacts; #95 — `flagged_responses.api_cost_id ON DELETE SET NULL` so the `api_costs` 90-day prune isn't blocked; #96 — paginate the flagged queue + add the `requires_regeneration` disposition test; plus MD040 fence labels in plan docs. The `tenant-scope` audit caught the new `api_costs` moderation UPDATE (row-id-scoped → reviewed allowlist entry) and the admin flagged-list cross-tenant joins (3 allowlist entries).

**PR 5a — Review sentiment (Spec 11, built; branch `wave-3-pr5a-sentiment` off `main`, migration 052).** Adds nullable `reviews.sentiment_score / sentiment_label / sentiment_classified_at / sentiment_source` (+ label-domain CHECK) and a one-time, bounded, star-based deterministic backfill of existing reviews. `classifySentiment(starRating)` (`src/lib/reviews/sentiment.ts`, `deterministic_star_v1`) is star-rating driven so the SQL backfill and the ingest path produce identical results, and is wired into all three review-content write sites (new insert + content-changed update in `process-review.ts`, and `insertImportedReview` in `zernio-ingest-shared.ts`); status-only writes untouched. LLM-ready via `sentiment_source` (a later text/LLM classifier swaps the tag, no schema change). No per-review analytics event.

**PR 5b — Customer KPI layer + sentiment trend (Spec 11, built; branch `wave-3-pr5b-kpi`, no migration).** New `src/lib/kpi/*` backend layer computing the launch KPI set into a dedicated `DashboardKpiSummary` (NOT overloading the lifetime `valueSummary`): response rate, average star rating, review volume MoM (calendar month), average time-to-respond (`approved_at − detected_at`), and an 8-week weekly sentiment trend from `reviews.sentiment_score`. Two scopes: `getLocationKpiSummary(businessId)` (per-location) and `getAccountKpiSummary(accountId)` (aggregate across active, non-archived locations via a `businesses` join). `GET /api/dashboard/kpis` mirrors `/api/dashboard` auth + scope resolution, IDOR-checks per-location access (cross-tenant → 403, archived → 404), **gates on subscription read-entitlement** (`active`/`past_due`), and **validates the `?scope=` UUID** (400, not a `::uuid` 500); error boundaries → 500. PostHog dashboard definitions doc added (`docs/analytics/posthog-dashboards.md`). No migration — the existing `idx_reviews_business_review_date` covers the trend query. 7 tenant-scope allowlist entries for KPI queries whose scope the static scanner can't trace — each verified genuinely scoped. Visible dashboard **cards** + CSV export are deferred to a UI follow-up.

**PR 6 — Finance (Spec 26, built; branch `wave-3-pr6-finance` off `main`, no migration).** `src/lib/admin/margin-service.ts` (`getMarginReport`) aggregates per-account variable API COGS (from `api_costs`, trailing 30d) vs per-account MRR (`monthlyMrrCents`, mirrors `currentBillingSnapshot`), classifies margin risk (account cost/MRR ≥25% warn / ≥40% act; platform gross margin <70% warn / <60% act), and rolls up platform gross margin. `GET /api/admin/costs` returns the margin payload **best-effort** (a margin fault never takes down the cost report); the `/admin/costs` page renders a margin-risk section (platform card + top-accounts-by-cost table, RepWorth palette). Finance docs `docs/finance/{cogs-template,monthly-close,model}.md`. 4 tenant-scope allowlist entries for the admin-wide margin aggregates (gated by `requireRole('admin')`; verified admin-only). Platform margin is API/LLM COGS only — vendor bills tracked in the finance docs.

**Deferred (external gates / later):** visible dashboard KPI **cards** + CSV export (the KPI query/API layer shipped; UI cards are a follow-up), materialized monthly finance rollup table, Bull Board, production log drain + Sentry alert routing + synthetic checks, owner-facing flag override/appeal, auto-regeneration on `requires_regeneration`, OpenAI Moderation turned on in prod, scheduled 50-row live eval, PostHog production dashboards + `POSTHOG_API_KEY` delivery, ProfitWell / Stripe Revenue Recognition / QuickBooks-Xero + first monthly close + first COGS file.

**External gates (not code):** wire `ci:analytics-events` into the org CI ruleset; configure log drain / Sentry P0–P2 routing / synthetic checks; set `OPENAI_MODERATION_ENABLED=true` + tune thresholds against real samples if the provider layer is wanted.

**Lessons captured** (`.claude/skills/lab-notes.md`, 2026-05-26 Wave 3): structured logging must fail open (never throw from a log call); bind log context once at the BullMQ registration boundary, not per handler; moderation must fail open (provider error → local decision, never silently approve); hold high-severity unsafe drafts by skipping notification in the SAME tx as response persist (no-auto-posting stays atomic); a long-lived audit FK (`flagged_responses.api_cost_id`) needs `ON DELETE SET NULL` so it can't block the `api_costs` prune; untrusted values in a delimited prompt block must be escaped or a `</review>` breaks out; a stale `.next/` after branch-switching breaks `typecheck` until cleared.

---

## Launch Readiness — Production Audit + Fix Sweep (2026-05-28 → 2026-05-29, PRs #152–#186)

**Status:** Code-side launch-readiness work COMPLETE on `main`. `pnpm lint` is 0-warning, `typecheck`/`build` green, the unit suite grew past **4500 tests**, and CI is green on `main`. What remains is **operational** (prod secrets, drills, flag flips), not code.

**Why:** Before opening GA / self-serve signup we ran a full-codebase readiness audit in two parts and then closed every code-side gap it surfaced. The two audit docs are the source of truth and carry the ✅/🟡 status per item:
- `docs/launch-ready-part1.md` — backend / infra / ops / test-coverage / architecture-invariant audit (commands actually run on `main`).
- `docs/launch-ready-part2.md` — all 57 frontend pages audited against the RepWorth brand-design system (design consistency, mobile, placeholders, accessibility).
- `docs/known-issues.md` — the multi-location channel-enrollment desync registry (now resolved for Telegram/WhatsApp + admin SMS; dispatcher branch resolved in #133).

The headline finding held: **every safety-critical architecture invariant still HOLDS in code** — most importantly the enforced no-auto-posting gate. The work below is polish, hardening, and closing hidden-config / off-brand gaps.

### Part 1 — Backend / infra / ops (PRs #152–#158, building on #132/#133/#135)

| PR | What shipped |
|---|---|
| #132/#133/#135 | **Multi-location channel-enrollment account-scope fixes** (resolved in `docs/known-issues.md`): admin SMS lock + cross-channel precheck + SMS-row scope (#135); dispatcher failure-branch writes account-scoped (#133); admin per-business channel status read surfaces org-default rows (#132). |
| #152 | Pricing copy bug fixed ("Multiple approval notification channels" — dropped *", if implemented"*); **PII removed from `console.log`** in contact/demo routes + all four schedulers switched to `createWorkerLogger`. |
| #153 | **`OutboxPoller` test** added (watchdog reset, dispatch, attempt-guard, dead-letter). |
| #154 | **Railway IaC** (`railway.toml`) + **rollback runbook** (`docs/runbooks/rollback.md`) in repo; stale `ADMIN_API_KEY` var/comment removed from `.env.example`. |
| #155 | **Resend webhook signature accept-path test** (real svix HMAC accept + stale-timestamp reject). |
| #156 | **Hidden-config closed**: `ADMIN_NOTIFICATION_EMAIL`, `CONTACT_NOTIFY_TO`, `SENTRY_DSN`, `IMPERSONATION_COOKIE_SECRET`, `LIST_UNSUBSCRIBE_EMAIL`, cost circuit-breakers + `STRIPE_PRICE_*` documented in `.env.example` and **boot-hardened** (worker hard-asserts `ADMIN_NOTIFICATION_EMAIL` in prod; the rest warn). These previously **silently dropped** alerts / fell back to a personal Gmail. |
| #157 | **Migration 054 `accounts.base_price_cents`** — founders price-lock no longer drifts; `quota.ts` + `margin-service.ts` read the stored column instead of live `TIER_CONFIG.baseCents`. Closes migrations-log Residual Risk #4. |
| #158 | **De-flaked** `worker/jobs/notification/__tests__/bounced-skip.test.ts` — isolated the shared module-level `sqlReturnQueue` per-test and replaced the fixed timeout (root cause: fixture-queue drift under parallel load). |

**Still ops-only (no code blocks them):** rotate `ZERNIO_WEBHOOK_SECRET`, set real prod URLs, Stripe live mode, PITR restore drill, DKIM/SPF/DMARC confirmation, lawyer-review of `/legal/*`, wire `SENTRY_DSN` + `TEST_DATABASE_POOL_URL` into CI, flip `SELF_SERVE_SIGNUP_ENABLED` / `OPENAI_MODERATION_ENABLED` once prerequisites are met.

### Part 2 — Frontend / brand / mobile / accessibility (PRs #159–#183)

The audit found three visual languages; only the marketing island was on-brand. The fix sweep brought the **conversion funnel, approval loop, MFA, demo, auth utility pages, and the Console amber bleed-through** onto the island/Console systems, and closed the mobile + a11y gaps.

| PR | What shipped |
|---|---|
| #159 | Pricing matrix scrolls on mobile (`overflow-x:auto` + `min-width`, keyboard-scrollable region). |
| #160 | **MFA page** rebuilt as a branded island; iOS input zoom fixed (≥16px) + `pattern="[0-9]*"`; `aria-live`/`role=alert`; support-recovery link on dead-ends. |
| #161 | **Removed `overflow:hidden`** from both `.rw-island` roots (real cause was the iOS Safari `overflow:hidden` + `border-radius` + retained `transform` repaint bug, **not** the dot-nav clip the audit assumed); auth `.rw-showcase` self-clips its corners; Vitest contract test locks the rule. |
| #162 | **Approval loop** rebuilt on the `PageShell` island — action-aware success + recovery CTAs on every error state (shared `ApprovalErrorState`), labeled textarea, inlined icon, `robots:noindex`. |
| #163 | Branded `(authenticated)/error.tsx` boundary + rebranded `global-error.tsx`; new `.error-state` Console CSS. |
| #164 | **Prospect demo page** redesigned across all four states (island + `DemoStatusIsland` + branded `not-found.tsx`); replaced the broken in-body `<meta refresh>` with a `router.refresh()` poller; teal CTA → `/book-a-demo`. |
| #165 | **Conversion funnel** rebuilt on a shared `OnboardingFunnelShell` + cross-page `FunnelStepThread`; reteal'd `ProgressDots`; payment-success acknowledgement (no more silent redirect); 16px inputs; `motion` CTAs. Built brainstorm → spec → plan → subagent-driven TDD. |
| #166 | `help/contact` + `feedback/thanks` rebuilt on `PageShell` (clickable `mailto:` cards, CTA out of the dead-end, `type="button"` dot-nav hardening). |
| #169 | **DPA placeholder route removed** (now 404s); misplaced AI-disclosure UI microcopy stripped from **three** legal docs (Terms/Privacy/AUP). |
| #171 | MobileTabBar active-state via URL-hash tracking; save-bar `left` moved to a shared `--rw-sidebar-width` token. |
| #172 | `select-location` gets the branded `TopBar` + back link; confirmed VoiceClient already wraps `SettingsShell`. |
| #173 | **Amber/orange/stone sweep** across owner Console + Admin (19 files + guard test): new `--rw-attn-*` blush tokens, `.banner-orange`→`.banner-attn`, admin amber → admin blue + neutral gray. |
| #175 | **Mobile nav** — `SiteNav` hamburger → `motion/react` dropdown (closes on tap + Escape, full ARIA). |
| #176 | SMS "coming soon" made honest + flag-independent; dead owner-UI plumbing removed (SMS enrollment is admin-only). |
| #177 | `dashboard/connect` (all 8 view states) reskinned onto Console primitives; warm tones removed. |
| #180 | Per-page metadata across public + auth + legal (`src/lib/seo.ts` `noindexRobots`); fabricated testimonial removed; signup 2-col mobile stack; payment-success timeout support link; admin payment-success polling cleanup. |
| #181 | **App-wide review-star color → teal** (`--rw-yellow-500`→`--rw-star`); tablet breakpoints (≤900px KPI/stats 2-col); 44×44 tap targets; settings `SettingsSkeleton`; ARIA `aria-current` route-nav semantics; security/legal typography to rubric; QR `<img>` rationale + `SiteNav` logo → `next/image`; `pnpm lint` reaches 0 warnings. |
| #183 | Remaining yellow polish: domain unified to `.net`, first-run empty-state copy, flagged-queue total count, FinishSignup visible labels, more `aria-live` regions. |

**Intentionally left (by design, not gaps):** Basic/Standard/Premium pricing cards stay "Coming soon" until those tiers open; chart series `#ea580c` is the lone intentional warm remainder; `How-it-works` green success states + legal AI-disclosure prose are P1 polish; GBP API application still gates `EDIT_REPLIES_ENABLED`.

### Finishing PRs (#182, #184, #185, #186)

- **#182** — marked completed code-side items in `docs/launch-ready-part1.md` (audit re-verified against the live tree).
- **#184** — consolidated the staging guide + deployment runbook into a single self-contained `docs/runbooks/deployment-guide.md`.
- **#185 — Zernio reconnect-queue admin actions (blocker #23b).** New admin-only `POST /api/admin/businesses/[id]/zernio-queue` (same-origin → admin → AAL2 → Zod → one tx, mirroring `grant-extension`/`flagged`): **force-drain** re-fires `drain_pending_owner_connect` → `DrainOwnerConnectWorker` for all parked responses (gated on `ZERNIO_PUBLISHING_ENABLED` + active connection), and per-response **dismiss** → `superseded` (`posting_error='admin_dismissed_awaiting_connect'`). Both write `account_audit_log` in the same tx. `ZernioConnectionPanel.tsx` gains "Force drain queue" + per-row "Dismiss"; the long-standing `TODO(zernio)` is removed. Invariant #3 preserved (these are post-approval drafts; the publisher subscription guard still applies). Cross-tenant SQL allowlisted; route + component tests added. Built brainstorm → TDD with two-stage review per task.
- **#186 — External-services catalogue + `.env.example` sync.** Full codebase scan found 119 distinct `process.env.*` reads vs 82 vars in `.env.example`: **34 real app vars were missing** (LLM moderation, SerpAPI, Zernio tuning, `LIST_UNSUBSCRIBE_URL`, poller/scheduler tuning, 7 feature flags, 4 test/CI vars) and **3 were vestigial** (`ENCRYPTION_KEY`/`ENCRYPTION_KEY_VERSION` commented out; `WORKER_SERVICE_URL` retired in favor of `WORKER_PUBLIC_URL`). New canonical doc `docs/eservices-variables.md` maps every external service + the full env-var inventory + a drift report; deep per-flag behavior still lives in `.claude/reference/env-vars.md`.

**Lessons captured** (`.claude/reference/lab-notes.md`, 2026-05-29): the iOS Safari island clip is the `overflow:hidden` + `border-radius` + retained `transform` repaint bug — fix the property, not the assumed sibling clip; a flag-driven "reason swap" on a feature that has no owner-facing path either way (owner SMS) is misleading — show one honest flag-independent message and delete the dead plumbing; an admin "act on stuck items" panel needs a real backend route + status transitions through the outbox, not a frontend-only button. Full per-item status lives in the two `docs/launch-ready-*.md` audit docs.

---

## Auto-Approval Policy — Phases 0–3 + staging verification (2026-05-31 → 2026-06-06, PRs #224–#229, #241)

**Status:** Feature COMPLETE and shipped to `main` **flag-OFF** (`AUTO_APPROVAL_ENABLED=false` in prod — zero customer-facing change until ops flips it); end-to-end **verified on staging** 2026-06-06. Plan/spec: `docs/superpowers/specs/2026-05-31-auto-approval-design.md`. Staging test runbook (now archived/tick-marked): `docs/runbooks/completed_runbooks/auto-approval-staging-test.md`.

**Why:** owners wanted routine first-time reviews handled automatically (draft → approval decision → Google post) while sensitive cases stay manual — without weakening moderation, billing, tenant-scope, approval-token, or transactional-outbox guarantees. Implemented as an owner-configured **star-threshold policy** (account default + optional per-location override; manual / 5 / 4-5 / 3-5 / 2-5 / all-rated) whose runtime decision is made at **response-persistence time** and stays subordinate to every existing gate. Built in the spec's recommended split, each piece landing behind the disabled flag until the whole stack was in place:

| PR | What shipped |
|---|---|
| #224 | Root-spec sync — the design doc became the implementation source of truth. |
| #225 (Phase 0) | Typed `ModerationDecision.providerStatus` (`'clean'`/`'error'`/null) — the canonical provider verdict the runtime auto-gate reads (not the legacy `api_costs` metadata string). |
| #226 (Phase 1) | **Migration 055** + helper hardening: `auto_approval_policies` (account-default + location-override partial unique indexes, composite `(location_id, account_id)` FK, RLS-on with no authenticated DML), `responses.approval_method` (`owner`/`auto_policy`/NULL + CHECK, conservative backfill), `approval_audit_log.auth_method` accepts `auto_policy`. Pre-built the policy math (`exposureRank`/`isThresholdExpansion`/`starMeetsThreshold`/`resolveEffectivePolicy`), the four server flag helpers, typed job-outbox + lane helpers, and reused the existing subscription/audit helpers. |
| #227 (Phase 2) | **Runtime path** behind the disabled flag: `origin_lane` (only `live_ingest_new` can auto), the persist-time current-state re-read + final predicate, the auto branch (`status=approved`, `approval_method=auto_policy`, publish enqueued, **no** owner notification, one `auto_approved_by_policy` audit row), the **publisher kill-switch downgrade** (flag-off → unposted auto rows revert to owner review + re-notify, never post), and manual-path `approval_method='owner'` attribution. |
| #229 (Phase 3) | **Settings API/UI + admin + DTOs**: `GET`/`PATCH /api/settings/auto-approval` (server-owned, session-scoped, same-origin, impersonation-rejecting; the exposure-rank expansion/confirmation/readiness state machine inside one `sql.begin()` tx); the owner settings page; an admin read-only diagnostics panel; nullable `approval_method` threaded into the four per-surface DTOs with an "Auto"/"Auto-approved" badge keyed on `approval_method` (not status). |

**Phase 3 review + hardening (this session).** Deep review found and fixed a real pre-merge bug: `delete_location_override` could **expand an archived location** into an auto account default and slip past the gates — now rejected `409 location_inactive`, with tests. Plus behavior-preserving cleanups: single-source the PATCH contract on one Zod schema (route imports it; deletes the hand-maintained TS union), an exhaustive admin block-reason label map, and a shared `<AutoApprovedBadge>` + `--rw-auto-*` color token. Two valid CodeRabbit nits addressed (save-flash `setTimeout` unmount cleanup; tighter test mock matchers). The deferred gate-before-write refactor of the settings tx is tracked in **#232**.

**Staging verification (runbook, 2026-06-06).** The full pipeline ran on `staging.repworth.net` + the Railway staging worker against a real connected GBP: §1 flags, §2 readiness (UI + API, `no-store`, derived booleans only), §3 settings (confirmation modals, contraction-while-blocked + `409 expansion_blocked`, `400`/`404`/strict-schema negatives, audit rows), §4 happy-path auto-post (`auto_policy` + `auto_approved_by_policy` audit, no actor), §5 fallback (rating-below-threshold + auto_approval_disabled, confirmed via the worker's structured gate log), §6 kill-switch downgrade (exercised **post-safe** — seed an approved auto row with the runtime flag off → the publisher downgrades, never posts), §7 admin diagnostics, §8 Supabase queries — **all passed**. Runbook archived + tick-marked via **#241**. Staging left owner-elected **armed** (both `AUTO_APPROVAL_ENABLED=true`, policy `Off/manual`). Open follow-ups: **#239** (live-verify the high-severity moderation HELD case — the moderation absolute veto), **#240** (a11y: "Settings saved" live-region on the settings page).

**Doc-change-map applied** (spec §18): invariants #3 (no-unapproved-posting now covers `auto_policy`) + #14 (auto-approval policy is server-owned) in `.claude/CLAUDE.md` + `AGENTS.md`; `AUTO_APPROVAL_ENABLED` / `AUTO_APPROVAL_PROVIDER_MODERATION_READY` in `.claude/reference/env-vars.md`; migration 055 in `.claude/reference/migrations-log.md`; `auto_approval_policies` in the RLS / tenant-scope inventories.

**Lessons captured** (`.claude/reference/lab-notes.md`, 2026-06-06): the kill-switch flag is read at worker **boot**, so a "flip mid-flight" race just posts — test the §6 downgrade post-safe (flag off + seed an approved auto row); `psql` rejects the staging `DATABASE_POOL_URL`'s `?pgbouncer=true` param (strip it / use `DATABASE_URL`); Vercel staging Deployment-Protection blocks automation-controlled browsers (use a Protection-Bypass token, then the app's own email/password login).

---

## Owner Offboarding v1 — schema → 7 PRs → staging dry-run → D1/D2/D3 fixes → live E2E → merge (2026-06-05 → 2026-06-09, PRs #244, #245)

**Status:** Feature COMPLETE and shipped to `main` **flag-OFF** (`ACCOUNT_OFFBOARDING_ENABLED` unset in prod — zero customer-facing change until ops enables it after the legal launch gate). End-to-end **verified live on staging** 2026-06-09. Plan: `~/.claude/grill-codex/20260605-214141/PLAN.md`; converged spec: `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md`; evidence record: `docs/runbooks/owner-offboarding-staging-dry-run.md`.

**Why:** owners needed a single, safe, durable way to stop using RepWorth without leaving the system in a half-state, and to keep the data-deletion promise precise (delete-or-anonymize, not "absolute deletion"). Two owner-initiated modes:
- **`cancel_only`** — schedule cancellation at period end (via RepWorth, not the Stripe portal), keep access + Google/Zernio live until `access_ends_at`, allow same-subscription reactivation before teardown, then archive + teardown.
- **`delete_data`** — stop processing immediately, cancel billing + revoke Zernio + archive locations at teardown-start, then a **30-day staged, resumable purge**; "keep my data" can cancel the purge (→ retained-data churn) but never undoes billing/provider teardown.

**What shipped (7-PR staged sequence; PR #244 = the feature branch → `main`):**

| PR/Task | What shipped |
|---|---|
| PR1 | `account_offboardings` + `account_offboarding_tokens` (migration **056**, deny-all RLS, `UNIQUE (account_id) WHERE terminal_at IS NULL`), the test-enforced **table-disposition inventory** (`src/lib/account-offboarding/table-disposition.ts` — CI fails on any unclassified account-linked table), and no-op shared guard helpers. |
| PR2 | cancel_only route/UI + Stripe schedule-at-period-end / reverse; Stripe Customer Portal self-serve cancellation removed. |
| PR3 | The single **offboarding guard gate** (`src/lib/account-offboarding/gate.ts`) wired across owner-write / worker / connect / billing surfaces; paid-through + read-only churn behavior. |
| PR4 | delete_data flow + **fresh re-auth** (`rw_delete_data_fresh_auth` HMAC stamp, +AAL2 when MFA enrolled) + type-to-confirm + keep-my-data `account_offboarding_tokens` (SHA-256 hashes only). |
| PR5 | Stripe invoice-cleanup spike/test + **snapshot-driven shared teardown** worker + Zernio/Stripe webhook reconciliation. |
| PR6 | **Staged resumable purge** worker (auth-delete revalidation under lock) + minimal admin stuck-offboarding visibility + provider-disposition override (migration **057** tombstone nullability). |
| PR7 | End-to-end hardening: migrations **058** (analytics-event allowlist), **059** (`purge_reminder_sent_at`), **060** (reactivation-claim columns); the **five recovery pollers** (AccessEnd, Purge, PurgeReminder, ReactivationReset, TeardownRetry); dedicated lifecycle emails; server-side analytics; the staging dry-run runbook; the server-only flag. |

**8-status machine:** `pending → scheduled → tearing_down → purge_scheduled → purged` with terminal branches `churned` / `reactivated` / `failed (+failed_step)`; every terminal stamps `terminal_at`. A `failed`/`failed_step='teardown'` row is re-driven by `TeardownRetryPoller` up to `…_TEARDOWN_MAX_RETRIES`, then held for an operator; a stale `reactivation_claimed_at` (>5 min) is released by `ReactivationResetPoller`.

**Staging dry-run (2026-06-08) — found 3 launch-blockers, all on disposable test accounts (real GBP `norbertliverpool@gmail.com` untouched, no reviews posted/edited):**
- **D1 — cancel_only never schedules.** `BillingScheduleWorker` read `subscription.current_period_end` (top-level), but the pinned Stripe API (`2026-05-27.dahlia`, Basil-era) returns it **only on the subscription item** → it threw, row stuck `failed/billing`. *Masked by:* a unit mock returning the field top-level.
- **D2 — keep-my-data email link 401s logged-out owners.** The proxy's `isProtectedOwnerApiRoute` blanket-matched `/api/account/*` and trapped the public, token-authenticated `/api/account/offboarding/keep-my-data` — the primary rescue path returned 401.
- **D3 — delete_data purge always failed; data never deleted.** The scrub + verification referenced `approval_audit_log` columns `approval_link_id` / `user_agent` that don't exist → purge threw at plan time, row stuck `failed/purge`. *Masked by:* unit tests asserting the scrub **SQL text** (incl. the phantom columns), never the real schema. A functional **and** compliance failure (deletion promised, not delivered).

**Fixes (PR #245 → `owner-offboarding-plan`):** D1 → read `items.data[0].current_period_end ?? top-level`; D2 → a `PUBLIC_OWNER_ACCOUNT_API_PATHS` exemption (the route does its own token validation); D3 → drop the two phantom columns from the scrub + verification (the real PII columns incl. `response_text_at_approval` are still nulled; the sibling `user_agent`/`ip` scrub on `account_audit_log` is correct — that table really has those columns). Each got a regression test at the seam the mock drift hid: D1 feeds the real Basil item shape, D3 adds a **real-DB integration test** running the production scrub/verification against the real schema, D2 pins the route public.

**Live UI E2E on fix-deployed staging (2026-06-09, Chrome DevTools):** deployed the fix branch to the full staging stack (Vercel staging custom env + Railway worker) and drove all three on a disposable account (real signup UI + Gmail OTP + Stripe **test-mode** checkout → active sub): **D1** cancel_only → `scheduled` (+ reactivation → `reactivated`), **D2** keep-my-data GET → 200 (was 401), **D3** delete_data → teardown → `purge_scheduled` → `purged` (account/user PII tombstoned). Recorded in the runbook (§0 "Live UI E2E").

> **Deploy gotcha (operational, NOT a code defect):** the first worker deploy via `railway up` *from the nested git worktree* shipped **stale** worker code missing the offboarding queue wiring (`OutboxPoller: Unknown topic "account_offboarding_billing_schedule"`), stalling every offboarding job. Redeploying the worker from a **clean clone** fixed it. Deploy the staging/prod worker from a clean checkout, never `railway up` from `.claude/worktrees/*`.

**Merge:** PR #245 squash-merged into `owner-offboarding-plan`, then PR #244 squash-merged into `main` (2026-06-09; CI green on both; `main` commit `22ba46c2`). Feature stays **dark in prod** (flag unset — merging code does not flip env vars).

**Remaining before prod enablement (Task 7.3 launch gate, non-code):** apply migrations 056–060 to the **prod** Supabase (staging-first already satisfied); complete the **legal launch gate** (ToS non-refundable mid-cycle `delete_data` clause + forfeiture disclosure copy); deploy the prod worker from a clean checkout; then set `ACCOUNT_OFFBOARDING_ENABLED=true` + run the post-enable smoke.

**Doc-change-map applied:** migrations 056–060 in `migrations-log.md`; `ACCOUNT_OFFBOARDING_*` in `env-vars.md` (incl. the recovery-poller tunables); the offboarding tables in the RLS / tenant-scope inventories; the `account-offboarding/` worker subfolder + a where-things-live pointer in `.claude/CLAUDE.md`; this entry + the `currents.md` quick summary; offboarding gotchas in `lab-notes.md`.

**Lessons captured** (`.claude/reference/lab-notes.md`, 2026-06-08): tests asserting on **mocked** provider responses / SQL **text** let API/schema drift sail through CI (D1 + D3) — integration-test the billing + purge paths against the real Stripe API / staging schema; `railway up` from a nested worktree ships stale worker code (deploy from a clean clone); Stripe Basil/Dahlia moved `current_period_end` onto the subscription item; the `enforce_account_offboarding_purge_after_token_expiry` trigger blocks shortening `purge_after` while a keep-my-data token is live (revoke it first).

---

## Billing Compliance Hardening (2026-06-08 → 2026-06-09, branch `billing/compliance-hardening` → PR pending)

**Status:** Code-COMPLETE on the branch; **pre-merge**. Full local gate green (lint, typecheck, `ci:static-policy`, **5881 tests pass / 0 fail**). No DB migration. Plan (grilled + hardened through **3 Codex adversarial review rounds → APPROVED**): `docs/superpowers/plans/2026-06-08-billing-compliance-hardening.md`; decision/debate artifacts: `~/.claude/grill-codex/20260608-210253/`.

**Why:** a billing audit surfaced pre-revenue compliance + Stripe-best-practice gaps. Close them now, all behind **reversible config** so code lands before the live checkout is configured. Everything operational (Stripe Dashboard, Product/Price tax config, dunning, flags, legal sign-off) stays in the plan's **Launch-Gate Checklist**, not code.

**What shipped (one commit per task; all behind flags / inert until ops configures Stripe):**

| Task | What shipped |
|---|---|
| 1 | **Single Stripe client factory** `src/lib/payments/stripe-client.ts` (`getStripe()`, pinned `apiVersion 2026-05-27.dahlia` + `timeout 20_000` + `maxNetworkRetries 2`). All 8 `new Stripe()` sites migrated; 2 extra consumers redirected so `stripe-client` is the **sole** import source. `rg "new Stripe("` → only the factory. (Accepted: the 4 previously-bare clients drop from Stripe's ~80s default timeout to 20s.) |
| 2 | **Flag-gated Stripe Tax** on `createCheckoutSession` — `automatic_tax` + `billing_address_collection:'required'` + `tax_id_collection` when `STRIPE_TAX_ENABLED==='true'` (server-only, default off; added to `startup-assert` optional-boolean set). `tax_behavior='exclusive'` model. |
| 3 | **Reconciliation tax-safety regression test** — locks that `recurringSubscriptionLineTotalCents` sums **pre-tax** line amounts (Dahlia `pricing.unit_amount_decimal`), ignoring tax-inflated `subtotal`/`amount`, so enabling Tax can't cause false drift. |
| 4 | **Auto-renewal disclosure on the onboarding plan picker** — per-card line + global fine-print ("auto-renews monthly … plus applicable taxes", "Cancel anytime from your account", `next/link` → `/legal/terms`). Copy points to the **real** cancel path (`/account/offboarding`), not "Settings". |
| 4b | **Same disclosure on the second recurring-charge surface** — a static "before any applicable taxes / continues monthly until cancelled" qualifier on the in-app tier-change estimate (`AccountPanel.tsx`). Static (not flag-gated) because the flag is server-only (invariant #13). |
| 5 | **Price-change safety** — (5a) a grandfathering regression test proving `currentBillingSnapshot` returns the **stored** `accounts` price, not live `TIER_CONFIG`; (5b) `pnpm verify:stripe-prices` (`scripts/verify-stripe-price-parity.ts`) reconciling each Stripe Price's `unit_amount`/`currency`/`interval`(+`tax_behavior`) against `TIER_CONFIG`; + the documented price-change procedure in `env-vars.md`. |

**Key decisions (grill + Codex):** Stripe Tax **exclusive** + "plus applicable taxes" disclosed; **grandfathering** is the chosen pricing semantic (new customers pay new prices, existing keep theirs — already built via migration 054, no behavior code); `apiVersion` pin is **outbound-only** (webhook shapes follow the Dashboard endpoint version — a hard launch-gate item); dispute/SCA/customer-reuse code **deferred** to Fast-Follow (pre-revenue, zero charge volume). Codex caught and we fixed: `tax_code` on the **Product** not the Price; `tax_behavior` immutable-once-set; the drift test must model the Dahlia field; the **second** consent surface (Task 4b); `STRIPE_TAX_ENABLED` missing from `startup-assert`.

**Review (this session):** verified every task against the plan + ran the gate (all green; 6 new test files pass in isolation, 14 tests). Three low-severity nits noted (test-only `TierChangeModal` export; `verify:stripe-prices` silently skips an unset overage env for non-basic tiers + doesn't assert `interval_count`/`active`) — none blocking. Branch was 1 commit behind `origin/main` → rebase before PR; Tasks 1/4b/5 touch worker/shared code → ride **staging first**.

**Deferred (NOT code — before charging a real customer):** the plan's **Launch-Gate Checklist** (enable Stripe Tax + Product/Price tax config + recreate-or-update Prices, set webhook endpoint version, dunning = cancel-after-retries, customer emails + retained-acknowledgment content, tier-change ARL §17602(g) fee-change timing, `ACCOUNT_OFFBOARDING_ENABLED=true` + cancellation smoke, `pnpm verify:stripe-prices`, binding legal sign-off) and the **Fast-Follow backlog** (`charge.dispute.created`, SCA, Stripe-customer reuse + `customer_update` for tax, grace/retry-window alignment, repricing existing customers).

**Doc-change-map applied:** Stripe single-factory + tax flag + price-change rule in `.claude/CLAUDE.md` (Tech-stack bullet); `STRIPE_TAX_ENABLED` row + the price-change procedure in `env-vars.md`; `STRIPE_TAX_ENABLED` in `.env.example`; this entry + the `currents.md` quick summary; billing/Stripe gotchas in `lab-notes.md` (2026-06-09). No migration → `migrations-log.md` unchanged; review ingestion untouched → `review-ingestion.md` unchanged.

---

## Rate-limiting & abuse hardening — Slices 1–2 + cost-guard item 4 (2026-06-09, PRs #254–#257)

**Status:** COMPLETE. Slice 1 (#254), cost-guard item 4 (#255 + docs #256), and Slice 2 BotID (#257, commit `cf546f29`) all merged / CI green. WAF rules are **owner-applied via runbook** (Vercel platform state, not code). Plan grilled + hardened through **4 Codex adversarial review rounds → APPROVED**; decision/debate artifacts: `~/.claude/grill-codex/20260609-044732/`.

**Why:** a security/trust pass on API rate limiting, focused on the LLM-cost-exposed paths where abuse = real money. The scan found the platform was already **spend-safe** (the worker cost-guard reserves before every LLM call), so the work is **defense-in-depth + one real bypass + edge hardening**, delivered in independently-landable slices.

**What shipped:**

| Slice / PR | What shipped |
|---|---|
| **Slice 1 — app-layer limits (#254)** | Shared `enforceDashboardRegenRateLimit(accountId)` (`src/lib/shared/dashboard-regen-rate-limit.ts`) — two layers, **distinct keys**, **fail-open**: `dashregen:owner:<id>:burst` (5/60s) + `:hour` (30/3600s). Wired into **BOTH** authenticated regenerate entrypoints — `/api/dashboard/reviews/[reviewId]/regenerate` **and** the `mode:'regenerate'` branch of `/api/dashboard/past-replies/draft` (the second was an unprotected bypass Codex caught). One flood-safe structured **429 log** per block (route, window, hashed accountId; no PII). Identity = owner account (not IP). Tests: independent burst/hour keys, both entrypoints 429, manual mode NOT throttled, Redis-down → allowed. |
| **Item 4 — retryable cost-guard infra (#255 / docs #256)** | New `CostInfraUnavailableError` (`src/lib/costs/errors.ts`). The three **pre-LLM** Redis touchpoints `checkIdempotentCache`/`reserveCost`/`acquireConcurrencySlot` now throw it on a transport error, and `generate-draft.ts` **re-throws it like `TransientLLMError`** → BullMQ retry (3×) + 1h outbox watchdog. Previously those fell into the generic permanent `{kind:'failed'}` catch and **lost the draft**. Guards: budget-exceeded errors stay **TERMINAL** (never reclassified as infra); `finalizeCost` (post-LLM) keeps its existing `onFinalizeError` policy — no job-level retry (a retry would re-spend + burn a regen slot). Net: a transient Upstash blip now **retries** instead of losing a regenerate/first-draft — spend-safe **and** blip-resilient. |
| **Slice 2 — Vercel WAF + BotID (#257)** | **BotID (code, ENFORCE-now)** on **4** hot unauth POST routes: `signup` + `onboarding/start` (Deep Analysis), `login-attempt` + `lead-intake` (Basic). One isomorphic source of truth `src/lib/security/botid-routes.ts` feeds **both** the client `initBotId` and the server gate `botIdBlockResponse` (`src/lib/security/botid.ts`: 403 on bot, **fail-open** on a BotID infra error, **throws** on an unregistered path). `withBotId` composed over Sentry in `next.config.mjs`. **ADR 0002** documents the `checkBotId`-in-route carve-out under invariant #1. **WAF (owner-applied via runbook `docs/runbooks/vercel-waf-rate-limiting.md`):** per-path **enforce** (signup 5/min, onboarding 10/min → 429) + a broad split `/api/*` net in **LOG mode** (mutating POST/PUT/DELETE 100/10s, GET 600/10s) with a flip-to-enforce checklist; Attack Mode break-glass mapped to `production.md`. |

**Pre-merge review (this session) — 2 findings, both fixed on #257 (`cf546f29`):** (1) **critical** — `/api/contact` + `/api/demo-request` had **no in-app token-bearing caller** (dead "public-lead remnants"; `book-a-demo` posts to `/api/lead-intake`, `help/contact` has no form). Enforce-now BotID would 403 any surviving external caller, invisible to preview/mocked tests. → removed both from the BotID set (now **4** routes); the WAF per-IP net covers them; dead-route deletion flagged as a separate owner cleanup + a regression test asserts they are NOT registered. (2) **cost** — `onboarding/start` ran the **billed** Deep call before the auth 401. → moved `botIdBlockResponse` to **after** the 401 so Deep fires only for a confirmed session; test asserts a session-less request 401s **without** calling `checkBotId`.

**Key decisions (grill + 4 Codex rounds):** API limits **fail OPEN** (availability) because the cost-guard reserve-before-LLM already guarantees spend; identity = **owner account**, not IP; **one shared limiter** for both regenerate entrypoints with **distinct** burst/hour keys; **WAF-first** (no `middleware.ts`) on Pro; broad net **LOG-first** then owner-approved flip after a NAT-safe baseline; **only BotID-protect routes with an in-app instrumented caller.**

**Owner follow-ups (NOT code):** apply the WAF rules from the runbook (`vercel link` → `vercel firewall rules add …` → `publish`); enable the BotID **Deep Analysis** dashboard toggle; review the 3–7 day LOG baseline, then flip Component 1 to enforce; delete the dead `/api/contact` + `/api/demo-request` routes.

**Doc-change-map applied:** a where-things-live pointer (runbook + `src/lib/security/botid*` + ADR 0002) in `.claude/CLAUDE.md` (the rate-limit/cost-guard gotcha there was already updated post-#255/#256); this entry + the `currents.md` simple-words summary; BotID/Vercel-WAF gotchas in `lab-notes.md` (2026-06-09). **No env var** (BotID uses the Vercel platform OIDC token) → `env-vars.md` unchanged; **no migration** → `migrations-log.md` unchanged; review ingestion untouched → `review-ingestion.md` unchanged.

---

## Multi-location launch hardening — PRs A–F + sign-off run (2026-06-09 → 2026-06-11)

**Status:** COMPLETE. Six ordered PRs (A–F) + two follow-ups all merged to `main` and reconciled to `staging`; migrations 062 + 063 applied to both Supabase projects; the two-location full-loop sign-off was **run and recorded**. Source artifacts (merged via #261): spec `docs/superpowers/specs/2026-06-09-multi-location-hardening-design.md`, plan `docs/superpowers/plans/2026-06-09-multi-location-hardening.md`. Design hardened through adversarial review rounds before implementation; implementation was subagent-driven (per task: implementer → spec-compliance review → code-quality review).

**Why:** the multi-location feature (one `accounts` row = billing parent; each `businesses` row = one Google Business Profile location) passed the security/tenant-isolation core review, but a launch-readiness sweep found lifecycle-edge, billing-recovery, and settings-scoping defects, plus zero E2E coverage of the multi-location pipeline.

**What shipped (PR by PR):**

| PR (#) | What shipped |
|---|---|
| **A — archived-location spend leak (#262)** | Every LLM-spend path now excludes archived locations: Zernio fan-out + ingest worker skip archived (`guardZernioJobEligibility`, `SKIP_REASON_ARCHIVED_LOCATION`), the generator gate terminal-skips on `archived_at`, both summary schedulers + the shared summary helper gained `AND b.archived_at IS NULL`. Skip-as-success (complete + structured log, never fail). |
| **B — exactly-one-primary + archived-approval gate (#263)** | Race-proof archive (locked snapshot + `blockPrimary`); promote repairs zero-primary; reactivation self-heals under the account lock. `assertLocationNotArchived` (`src/lib/approval/locks.ts`) blocks token approve/edit, callback approve, and dashboard approve/edit for archived locations. |
| **C — duplicate `google_place_id` (#264, migration 062)** | Partial unique index `businesses_account_place_uniq` (CONCURRENTLY, `WHERE archived_at IS NULL AND google_place_id IS NOT NULL`). 23505 → typed `duplicate_location` → HTTP 409 (`src/lib/locations/duplicate-location.ts` = single owner of the predicate + owner-facing copy). URL-mode add enqueues `validate_place_id`; the validation worker tolerates a 23505; CSV in-file + per-row dup handling. |
| **D — billing recovery + price-change guard (#265)** | Single shared `findOverageItem` (`src/lib/payments/overage-item.ts`, base-item exclusion FIRST) replaces three divergent copies (worker / reconcile poller / tier-change route) that would otherwise create a **second** overage item → double-billing on a rotated price. The worker grandfathers legacy-priced items. `past_due → active` recovery (invoice-paid + checkout-completed) enqueues an overage recompute in the recovery tx. Transient/terminal classifier `worker/jobs/billing/stripe-overage-error.ts` mirrors cost-guard #255 (5xx/429/409-in-flight = retry; 400 `idempotency_error`/auth/other-4xx = `markOutboxFailed`). Worker registered with explicit `concurrency:1` + boot assertion. |
| **E — digests account-level + channel cascade (#270, migration 063)** | `accounts.weekly_summary_enabled` / `monthly_impact_enabled` (NOT NULL DEFAULT TRUE) + three-branch backfill (active-primary value wins; else `bool_and` across all the account's businesses; else TRUE — re-run once post-deploy). `PUT /api/settings` splits the write (digests → `accounts`, voice/contact → `businesses`) in one tx; ALL readers moved to the account columns. Channel overrides stay visible/deletable regardless of mode (incl. since-archived locations), show "(archived)" labels (SSR + API), and `disable{Telegram,WhatsApp}Enrollment` cascade to per-location override rows with same-tx `writeAccountAuditLog`; override create/delete made atomic. |
| **F — E2E kit + full-loop sign-off (#271)** | `seedMultiLocationAccount`/`cleanupMultiLocationAccount` (`e2e/seed.ts`), in-memory fake Zernio server (`e2e/fixtures/zernio-fixture-server.ts` + `serve.ts`), `MOCK_ZERNIO_LOCATION_COUNT` in the mock transport, a `LOCATION_ID` param on `scripts/zernio-fire-webhook.sh`, `e2e/multi-location.spec.ts`, a DB-backed seeder contract test, and the runbook `docs/runbooks/multi-location-e2e-full-loop.md`. |
| **G — review-finding hardening (#272)** | Owner-pushed post-review hardening (hex-CID self-heal restore + reactivation/place-id fixes; `PlaceIdValidationWorker` test). |
| **Sign-off fixes (#273)** | Two defects the live full-loop run surfaced in the F kit: the fixture's `publish_reply` didn't attach the reply to the stored review (so the publisher's `verifyOwnReplyAttached` re-read saw `reviewReply: null` and marked every response `failed`), and `serve.ts` used top-level await (tsx-CJS `TransformError`). Both fixed + a regression test; the runbook sign-off record filled in. |

**The sign-off run (launch gate):** the full loop (Zernio webhook → ingest → real-LLM draft → owner approval → publish reply) was driven for **two locations** against a local-confined stack (Postgres on port 5499, local Redis on isolated DBs, the in-repo fixture for Zernio, real OpenAI `gpt-4o-mini` drafts; approval via `approveBySession`). **Result:** per-location routing held (each webhook fanned out exactly one row to its own location — no cross-routing), both drafts generated and were contextually correct, both were approved, and after the #273 fixes both reached `status=posted` with the fixture recording one reply per review. Recorded in `docs/runbooks/multi-location-e2e-full-loop.md` §5.

**Key decisions:** ordered A→F (each independently landable; B/C/E ride staging first; migrations staging-first + lockstep both Supabase projects); `findOverageItem` extracted only because the review found three proven divergent copies (no speculative centralization elsewhere); digests moved to `accounts`, not dropped from `businesses` (deprecated, cleanup migration later); approval archived-gate consolidated into the `lockPendingResponse` / `assertLocationNotArchived` primitives; the full-loop run used a sanctioned owner-approve path and local-only infra so it couldn't touch shared Redis/Supabase or the platform-wide cost counter.

**Doc-change-map applied:** this entry + the `currents.md` simple-words summary; a where-things-live pointer (spec/plan + the E2E full-loop runbook) in `.claude/CLAUDE.md`; multi-location full-loop gotchas in `lab-notes.md` (2026-06-11); a per-location-routing + archived-skip note in `review-ingestion.md`. **`migrations-log.md` already current** (062 + 063 written during PRs C/E; head 063); **`env-vars.md` already current** (`MOCK_ZERNIO_LOCATION_COUNT` documented during PR F).

---

## Channels productionization + auto-approved post FYI — PRs #319 / #320 / #322 (2026-06-13 → 2026-06-15)

**Status:** MERGED to `main` (2026-06-15) — A = **#319**, B = **#320**, C/D landed as **#322** (#321 was closed/superseded). The integrated work plus the correctness-review, thermo-nuclear quality, and Fallow CI fixes are all on `main` (full gate green — typecheck, lint, the four audits, ~6,175 tests; Fallow green). **The channels are still flag-OFF; pending before turning them ON in prod:** migration 067 applied to the staging + prod Supabase projects (needs project creds; the channel approve/edit/regenerate flows don't need it — only the FYI does), and the WhatsApp FYI template `repworth_autopost_notice_v1` clearing Meta. Planned via `grill-me-codex` (4 adversarial Codex rounds → APPROVED), implemented by the owner across three stacked PRs, then a correctness review + a thermo-nuclear code-quality review + Fallow CI fixes.

**Why:** the Telegram + WhatsApp channels were **already fully built but flag-OFF** (`CHANNELS_TELEGRAM_ENABLED` / `CHANNELS_WHATSAPP_ENABLED`), with approve/edit/regenerate already wired. The asks: (a) make them production-ready — audit + the missing regression tests + a rollout runbook; (b) add a per-event **FYI** when the auto-approval runtime approves AND posts a reply by itself; (c) leave a **reversible seam** for a future conversational RepWorth AI agent without building it now.

**What shipped (PR by PR):**

| PR (#) | What shipped |
|---|---|
| **A — channel audit + regression tests (#319)** | Adversarial tests for the live edges: WhatsApp 24h session-window confirmation + the **swallowed-failure** path (renamed `sendFreeformIgnoringErrors` → `sendFreeformBestEffort`, which now classifies + logs a 63016 instead of `.catch(()=>{})` while preserving commit-before-confirm), parallel-channel race (email + one mobile → "already handled", no double-post), and the mobile-channel-exclusivity 409 for Telegram (mirrors WhatsApp). |
| **B — auto-approved post FYI, end-to-end (#320, migration 067)** | New outbox topic `auto_post_notice` wired end-to-end (`queue-names`, `queues.ts`, `worker/index.ts`, snake_case `AutoPostNoticePayload`, **offboarding teardown terminalization**). Shared `markPostedAndMaybeEnqueueAutoPostNotice` called from **both** publisher success paths (fresh-2xx **and** the 409 text-match recovery), in one `sql.begin()`, with an affected-row guard (`UPDATE … RETURNING`, enqueue only on `count===1`) and `approval_method='auto_policy'` gate. New worker `worker/jobs/auto-post-notice/{AutoPostNoticeWorker,context,dispatch,errors}.ts` (separate from the approval dispatch; creates **zero** `approval_links`). New `sendAutoPostNotice` channel method returning a `sent`/`skipped` union (WhatsApp pre-filtered when its template SID is unset). **Claim-before-send** dedup (`notification_deliveries`, release on retryable / failed-row on terminal). Hardened public redirect `/r/google/[responseId]` (UUID + `status='posted'` join + Google host allowlist + `no-store` + unavailable page). FYI email template + `auto_post_notice` added to `OWNER_DIRECTED_TEMPLATES` (hard-bounce flags `owner_email_bounced`). Migration **067** = two partial unique indexes (in-flight outbox dedup + the claim dedup), additive/instant. |
| **B P1 follow-up (860c8944)** | The R2 #2 invariant assertion (`throw if auto_policy reaches edit-publish`) sat **before** the `hasPostedSibling \|\| isOrphanRetry` check, so with `EDIT_REPLIES_ENABLED=true` **every** first-time auto-policy publish threw instead of falling through to the fresh POST. Moved the assertion **inside** the edit-path branch; added the spec-required worker tests (both success paths enqueue exactly once; owner-approved enqueues none; the P1 regression; topic routing; the resend-bounce path). |
| **C/D — conversational seam + ADR + runbooks (#322; #321 closed/superseded)** | Future-agent free-text seam: inbound non-command, non-button text routes to one named no-op handler that gates on a **verified, non-archived enrollment + active account** and replies to no one today (no bot surface); `redactForAudit` now redacts **all** free-text bodies before `inbound_events`. ADR `docs/adr/0003-conversational-channel-seams.md` (records the seam + the WhatsApp 24h-window hard constraint). Runbooks `channels-rollout.md` + `channels-staging-smoke-test.md`; the `repworth_autopost_notice_v1` template content in `whatsapp-templates.md`. |

**Review + quality passes (post-implementation):** a **correctness review** raised 6 findings (409-recovery FYI enqueue untested, `correlation_id` not threaded into the 409 path, `maps.google.com` any-path redirect, systemic-FYI-failure not error-logged, claim INSERT outside the try, activation-ordering nit) — all addressed by the implementer in `4c5645cc`; the review **missed** the EDIT_REPLIES P1 above, which the implementer caught and fixed. A **thermo-nuclear code-quality review** then landed three behavior-preserving consolidations (`07d02cd8`): a single-owner `isTransientChannelSendError` predicate (the approval + FYI classifiers had drifted on the Telegram cases), a shared `buildEmailShell()` (the approval + FYI emails had near-identical chrome), and the claim/finalize/fail/release helpers moved into the canonical `delivery.ts`. Finding #4 (drop the `tx` param on `mark-posted`) was **deliberately declined** — taking `tx` matches the outbox-helper convention (caller owns the tx boundary, invariant #2) and rewriting the just-stabilized publisher tests for it is churn, not a win. Finally, **Fallow CI** was made green (`20acfb82`): deleted a genuinely-unused export, `usedClassMembers` for the interface-dispatched `sendAutoPostNotice`/`sendApprovalRequest`, inline `complexity` suppressions on the inherent-orchestration functions, and `duplicates.ignore` for the deliberately-parallel-but-divergent worker/context clones.

**Key decisions:** FYI is **view-only** (no post-hoc edit/undo — separate feature); **per-event** (no digest infra built); **all enrolled channels** with WhatsApp **graceful-degrade** until its Meta UTILITY template clears; **mobile-channel exclusivity** kept (email + one mobile); the FYI trigger lives in the **publisher** (a *confirmed* post), not at approval time; a **new outbox topic** over overloading `send_notification`; **Telegram-first** rollout (no external approval gate) with WhatsApp following its template. The conversational seam is the minimal reversible move — no agent, no conversation store, until a second concrete use case.

**Doc-change-map applied:** this entry + the `currents.md` simple-words summary; `.claude/CLAUDE.md` (added `auto-post-notice/` to the worker-subfolder list + a channels where-things-live row); `lab-notes.md` Fallow gotchas (2026-06-14: `fallow-ignore-next-line` is single-line; `--gate new-only` resolution conventions); the rollout + smoke-test + template runbooks + ADR 0003; `docs/directory.md` runbook index. **`migrations-log.md` already current** (067 written during PR B; head 067); **`env-vars.md` already current** (`CHANNELS_*` / `WHATSAPP_AUTOPOST_TEMPLATE_SID` / `AUTO_APPROVAL_ENABLED` documented during PR B); **`review-ingestion.md` unchanged** (channels/FYI don't touch review ingestion).

---

## Beta-launch alerting gate + worker hardening — PR #354 (2026-06-19 → 2026-06-20)

**Status:** MERGED to `staging` (2026-06-20). The change rides **staging first** per the branch model — **not yet promoted to `main`/prod** (production is unprovisioned; prod is out of scope for now). Full CI green on the PR (lint, typecheck, test 6545, e2e, build, the 5 audits, **fallow**, **react-doctor**). Planned via `/grill-with-docs-codex` (4 adversarial Codex rounds → APPROVED), implemented, then a `/codex:review`, a thermo-nuclear code-quality review, and fallow/CI hardening — all folded into the one PR.

**Why:** a 1000-business readiness audit flagged the system as operationally blind (no automated alerting) plus a few cheap critical-path gaps. The grill reframed the target to a **10–50 business owner-approval-only paid beta** (ADR 0005): the content-safety control for irreversible public posting is the **human owner approval** (`AUTO_APPROVAL_ENABLED=false`), so the alerting added here targets the failures alerting *can* catch — **silent pipeline failure / dropped paid work** — not "bad auto-posted content."

**What shipped:**

| Area | What shipped |
|---|---|
| **HealthAlertPoller** | New read-only probe (`worker/background/pollers/HealthAlertPoller.ts` + `health-alert/{checks,emit}.ts`), registered like the other pollers. Signals: stuck/failed outbox by topic (windowed on `completed_at`), oldest-pending age, stale `dispatching`, **zero-delivery** approval notifications (scoped to still-`pending_approval` responses on live/non-archived businesses, so by-design moderation-hold / Zernio-backfill suppression don't false-page), and the unreviewed `flagged_responses` backlog. Routes to **Sentry (non-email)** via `captureMessage` (tags `subsystem=health_alert`, `finding=<key>`) + a Sentry **Cron check-in** (`captureCheckIn`, slug `health-alert-poller`) as the dead-man heartbeat. |
| **sendEmail chokepoint** | `src/lib/notifications/email/send-email.ts` — every Resend send routes through it; `Promise.race` timeout (`EMAIL_SEND_TIMEOUT_MS`, default 10s) so a hung send can't head-of-line-block the concurrency-1 notification worker, plus a flat `idempotencyKey` so a timeout-retry or failover re-send of the same approval/FYI dedupes at Resend (24h window > the 2h failover window) instead of double-sending. The 3 real call sites (approval, auto-post-notice, internal) migrated to it. |
| **SENTRY_DSN boot gate** | `assertAlertSinkEnv` in `worker/config/startup-assert.ts` — `SENTRY_DSN` is now a **hard production boot requirement** (the mandatory non-email alert sink), moved from a non-fatal warning. |
| **Cost-cap alert** | `generate-draft.ts` emits a `cost_event:limit_exceeded` Sentry alert when a per-tier/global cost cap terminally drops a draft — including the avoid-facts guardrail-retry path (cost errors now propagate unwrapped to the alert+terminal path instead of being swallowed as `guardrail_failed`). |
| **Cheap critical-path timeouts** | Upstash cache `commandTimeout: 3s` (pre-LLM hot-path fast-fail → existing retryable/fail-open paths) + the **third** SerpAPI call site (`RankingTrackingWorker` `getJson`) bounded at 12s (the prior pre-beta scan fixed only two). |

**Review + quality passes (post-implementation):** a **Codex review** raised 4 P2 findings — all fixed: Resend timeout idempotency (the flat key above), `completed_at` windowing for watchdog-terminated failed rows, the zero-delivery response/business-state scoping, and the guardrail-retry cost alert. A **thermo-nuclear code-quality review** collapsed `sendEmail`'s leaky `requestOptions` passthrough into a flat `idempotencyKey` opt (deleted the `SendRequestOptions` type, de-nested all 3 call sites). **Fallow CI** made green: removed 2 genuinely-unused exports, 4 inline `complexity` acknowledgments (invariant-#12 orchestration + pre-existing handlers touched mechanically — rationale on the line *above* a bare single-line directive, per the existing fallow lab-note), and 2 `duplicates.ignore` entries (divergent SerpAPI call blocks; the deliberately-separate Redis cache vs queue clients). `react-doctor` unaffected (zero `.tsx` changes).

**Key decisions:** owner-approval-only beta (ADR 0005) — auto-approval go-live is a **separate** later gate (prod moderation validation + canary + kill-switch drill + FYI-failure paging); the probe targets **silent** failures only (post-hoc alerting can't prevent an irreversible auto-post, so that risk is carried by the human approval step); the alert sink is **Sentry → Discord**, mandatory non-email (admin email shares Resend with the product); the two cheap timeouts *gate* despite being small because at `concurrency:1` they're single points of stall; the 1000-scale work (worker concurrency / horizontal scale, circuit breakers, ArchivalPoller drain, etc.) is **deferred to growth triggers** in the worker-scaling backlog, not built for a 50-business reality. **Beta is subscription-invoices-only** (documented constraint) so the un-scoped `invoice.payment_failed` (backlog P4 #11) can't wrongly flip a paying account to `past_due`.

**Doc-change-map applied:** this entry + the `currents.md` simple-words summary; `.claude/CLAUDE.md` (a where-things-live row for the HealthAlertPoller / alerting runbook / ADR 0005); ADR `docs/adr/0005-beta-launch-posture.md`; runbook `docs/runbooks/beta-launch-alerting.md` (the ops wiring + acceptance drills, Discord-routed); the 1000-business audit slimmed to a verdict (`docs/future-plans/2026-06-18-1000-business-readiness-audit.md`) pointing at the worker-scaling backlog (`docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`), which absorbed the audit's deltas; `lab-notes.md` (2026-06-20: `NODE_ENV` gates the production startup asserts). **`env-vars.md` already current** (`SENTRY_DSN` boot note + `HEALTH_ALERT_*` + `EMAIL_SEND_TIMEOUT_MS` + the cost-ceiling section documented in the PR); **`migrations-log.md` unchanged** (no schema changes — the gate is code/config/docs only); **`review-ingestion.md` unchanged** (the probe reads `job_outbox`/`responses` but doesn't touch ingestion).

**Pending before the gate is "live" on staging (human-side, in the runbook):** wire Sentry → Discord (integration + alert rule + `health-alert-poller` cron) + the Better Stack `/ready` checks, then run the 6 acceptance drills. The staging worker env already has `SENTRY_DSN` + `HEALTH_ALERT_MONITOR_SLUG` (verified), so the worker boots clean today.

---

## Sprint: 1-Month Free Trial (card-up-front, Stripe-native) — PR #362 (2026-06-21 → 2026-06-22)

**Status:** Implemented + reviewed + live-tested on **staging**; **flag OFF (`TRIAL_ENABLED=false`)**, not yet flipped in prod. PR #362 open, CI green.

**What was built.** A 30-day free trial as the **default self-serve onboarding path**: a new self-serve owner enters a card at Stripe Checkout (`subscription_data.trial_period_days`), is charged **$0 now**, gets the full product for 30 days, and Stripe auto-charges at trial end.

1. **New explicit `'trialing'` subscription status** (5th value in `src/lib/shared/subscription-status.ts`) — treated like `'active'` for entitlement everywhere, via a new single predicate `subscriptionGrantsFullAccess(status)` that replaced ~18 scattered `=== 'active'` checks. Fails **closed** (a missed check blocks a trialer, never leaks).
2. **Single Stripe state applier** — `worker/ingress/stripe/apply-subscription-state.ts`: the ONE writer of `subscription_status`, with a concrete monotonic transition table (`cancelled` terminal; stale/out-of-order events are no-ops), two ref modes (`checkout` by `client_reference_id`, `subscription` by customer+sub id), and all in-tx side effects (status, `account_audit_log`, `businesses` mirror, overage recompute, trial analytics). Stripe is the source of truth.
3. **Webhook lifecycle** through the applier: `checkout.session.completed` (trial start), `customer.subscription.updated` + `invoice.paid` (convert → `active`, only when Stripe says `active` — the $0 trial-start invoice does NOT convert), `invoice.payment_failed` + new `invoice-payment-action-required.ts` (SCA → `past_due` + 7-day grace), `customer.subscription.deleted` (cancel via existing offboarding `cancel_at_period_end`).
4. **Reconcile poller** (`billing-reconciliation/reconcile-account.ts`) gained **scoped corrective authority**: a DB-`trialing` row whose Stripe status moved is auto-corrected; DB-`active`/other vs Stripe-`trialing` is surfaced as drift (was silently suppressed). No entitlement depends on a single webhook.
5. **Entitlement boundary:** `trialing` excluded ONLY from recurring paid **ranking** (SerpAPI) — a deliberate cost boundary; everything else (drafts, notify, approve, post, auto-approval) is full access. Trialing **blocked from creating a second Checkout** (duplicate-subscription guard). Trial eligibility is **self-serve only** (`onboarded_by IS NULL`).
6. **Data model:** migration **069** — a clarifying COMMENT on `accounts.subscription_activated_at` (the *service-start* anchor, set at trial start; **no new column**, rev-3's `entitlement_started_at` was rejected on a 47-vs-0 consumer sweep) + the `analytics_events` CHECK extended for the 4 trial events. `trial_ends_at` invariant: non-null ⟺ `trialing`.
7. **Funnel/UI:** landing hero "Start your N-day free trial" (gated on `TRIAL_ENABLED` + `SELF_SERVE_SIGNUP_ENABLED`), trialing routed like active through onboarding/signup-status/dashboard, "Trial — N days left" banner.

**Process (the value was in the review layers).**
- **Plan hardening:** `/grill-me-codex` — 6 rounds of cross-model adversarial review (OpenAI Codex) BEFORE any code → APPROVED. Two evidence-based pushbacks held (dropped `entitlement_started_at`; excluded paid ranking from trials).
- **Implementation:** TDD, 11 commits, full gate green.
- **Codex correctness review:** caught a **P1** (trial start never persisted `stripe_customer_id`/`stripe_subscription_id` → entire post-start lifecycle broken) + 4 P2s — fixed.
- **Thermo-nuclear maintainability pass:** collapsed the 18 scattered checks into `subscriptionGrantsFullAccess`; surfaced a real **PLAN §15 reconcile bug** (DB-active/Stripe-trialing drift suppressed) — fixed.
- **5-agent heavy review (+ cross-model Codex):** found 1 **HIGH** (`businesses.subscription_activated_at` not mirrored on trial start → drips dead for every trial) + 2 MEDIUM (admin-handoff trial leak; conversion blocked by tier-resolution) — all fixed (+ added `invoice.paid` as a 2nd convert path).
- **Live staging E2E (the decisive layer):** caught **3 launch-blockers invisible to all the above** (see lab-notes 2026-06-22): (a) Stripe reports a $0 card-up-front trial Checkout as `payment_status='paid'`/`amount_total=0` (not `no_payment_required`) → every trial misfiled `active`; (b) onboarding demo-mode infinite loop; (c) the drip-mirror HIGH confirmed in production behavior. All fixed and re-verified on staging.

**Staging E2E results (runbook sign-off, 2026-06-22).** ✅ live-verified: **T1** signup→`trialing` (twice), **T4** no ranking for trials, **T5** duplicate-checkout 409, **onboarding wizard** opens with demo ON (no loop, 3×). ◑ partial: **T2** AI draft generated + notification (approve→post to Google deliberately skipped — real business GBP), **T3** `businesses` anchor set (drip enqueue time-gated ~24h), **T7/T9/T10** Stripe **test-clock acceptance suite 4/4** (convert/cancel-$0/add-location-$0/tier-change-$0) but staging webhook→DB projection pending. ☐ remaining: **T6** live, **T8** card-fail/SCA, **T11** reconcile live, the staging projection for T7/T9/T10/T11. **Nothing was ever posted to the real GBP** (verified: the 12 "posted" rows are imported historical replies, `approval_method=NULL`, no LLM, no cost).

**Key decisions.** Card-up-front Stripe-native (reuses Checkout + webhooks; limits abuse on a real-cost product) · explicit `'trialing'` status (fails closed) over reusing `active` (fails open) · `subscription_activated_at` reused as the service-start anchor, NO new column · ranking excluded from trials (paid SerpAPI) as the one bound on "full product" · lean abuse posture (existing signup limits + Stripe card fingerprint; no repeat-trial blocker) · cancellation reuses existing offboarding `cancel_at_period_end`.

**Doc-change-map applied:** this entry + the `currents.md` simple-words summary; runbook `docs/runbooks/trial-staging-e2e-and-rollout.md` (NEW — staging E2E + prod rollout + rollback + dated sign-off); `.claude/CLAUDE.md` (invariant #11 — `trialing` → full access like active, gate on `subscriptionGrantsFullAccess`); `lab-notes.md` (2026-06-22: the 3 E2E-only bugs + the missing SCA webhook event); `review-ingestion.md` (trial note — trialing included in ingestion, service-start anchor set at trial start). **`env-vars.md` already current** (`TRIAL_ENABLED` + `TRIAL_PERIOD_DAYS` documented during implementation); **`migrations-log.md` already current** (069 logged, head=069).

**Pending before the prod flag flip:** apply migration 069 to the prod Supabase project (both projects in lockstep); add the 6 Stripe events incl. `invoice.payment_action_required` to the **prod** webhook (the staging endpoint was missing it — added); finish the remaining staging checks above (esp. the day-30 webhook→DB projection + T6 + T8); then flip `TRIAL_ENABLED=true` staging→prod per the runbook.

---

## Sprint: Modularity-audit remediation — Stages 5–6 + worker resilience + dep security — PR #397–#400 (2026-06-26)

**Status:** Implemented, reviewed, merged to `main`; the worker-touching/security PRs staging-verified (Railway worker boots clean). Completes the modularity-audit remediation campaign (Stages 1–6).

**Campaign context.** A heavy modularity audit graded the codebase against five questions (Q1 modify-without-touching B+, Q2 test-in-isolation A−, Q3 single-responsibility B+, Q4 dependencies-explicit **C+** = weakest, Q5 replace-a-component **B−** = 2 gaps). The "Recommended" fixes were grilled + Codex-approved into a 6-stage plan (`~/.claude/grill-codex/20260624-220320/PLAN.md`). **Stages 1–4 (prior sessions, #376–#396)** delivered the typed config layer (`src/lib/config/{client,server,worker}.ts`, lane-scoped boot asserts, process-env baseline 100→14 floor, all CI-guarded) + the per-feature feature-flag sweep (all 20 flags through `<feature>/flags.ts` → `readFlag`, CI-guarded). **This sprint completed Stages 5–6** and added two follow-ups.

### Stage 5 — `ReviewPublisher` seam (PR #397) — the last Q5 gap

The publish path was hard-wired to Zernio across ~7 worker files; the parked direct-GBP path would have been a 6-file rewrite, not an adapter swap. **Pure refactor, zero behavior change** (guarded by 195 existing publisher/publishing tests + 13 new adapter tests + 1 new concurrency test).

- **NEW `src/lib/publishing/review-publisher.ts`** — `ReviewPublisher` interface (`resolveTarget` + `publishReply`/`deleteReply`/`findReply`); neutral `ReviewRef` (app-owned `responseId`/`reviewId`/`businessId`) **nested separately** from a provider `ReviewLocator` (`accountId`/`locationId`/`providerReviewId`) so transport methods get a coords-only object (no app id leaks into the adapter — Codex R1 fix); `getReviewPublisher()` lazy-singleton factory (the adapter-selection seam).
- **NEW `src/lib/publishing/zernio-review-publisher.ts`** — first adapter; DELEGATES to the existing `zernioClient` + `lookupZernioReviewId` + the Redis page-cache (deliberate: keeps the worker's existing test mocks valid → strongest zero-behavior-change guard). Owns the active-connection SELECT (moved out of `ResponsePublisherWorker`), review-id resolution, and the verify-walk page-cache bounding (deduped out of `verify-posted` + both `verify409*`).
- **6 call-sites switched** (`worker/jobs/publisher/`): `ResponsePublisherWorker` (connection SELECT + review-id resolution → `publisher.resolveTarget`; threads the resolved target); `review-lookup` (`resolvePublishTarget` consolidates no_connection→park / review_not_found→exception / transient→`PublisherTransientWithContext` dispositions that were split across files); `post-reply` (`publisher.publishReply`); `verify-posted` + `verify409AndDispose`/`verify409InTx` (feed fetch via `publisher.findReply`); `edit-publish` (DELETE-before-POST via an injected `ReviewPublisher` instead of an injected `zernioClient`).
- **Scope:** the zernio INGEST workers (`ZernioReviewIngestWorker`, `ZernioBackfillWorker`) READ reviews — out of the publish seam. **Deferred (documented residual):** the worker keeps catching the existing Zernio error *classes* + all DB disposition — neutralizing the error taxonomy is left for when a real GBP adapter forces (and validates) its shape.
- **Reviews:** Codex APPROVED after 2 rounds (R1 caught the locator boundary leak — the full target carrying app ids into the adapter at runtime — fixed by nesting the locator); thermo-nuclear passed (two large files *shrank*; page-cache duplication removed).

### Stage 6 — hygiene (PR #398)

Re-verified all four audit "hygiene" items; only one was real. **Single-sourced `flagOff()`** — `telegram/_shared.ts` + `whatsapp/_shared.ts` each defined a byte-identical channel-agnostic 404 → extracted to `src/app/api/admin/channels/_shared/flag-off.ts`, both re-export it (route imports unchanged). The other three were fallow false-positives / already-resolved and **intentionally not touched** (documented in the PR): `warm-editorial.css` is referenced by 6 live dashboard-redesign mockups; `DrawerState` is actively used (prior team review confirmed the fallow flag is a false positive); the `AutoPostNoticeWorker` fallow-ignore comment is already well-formed.

### Follow-up — worker transient-DB crash-net resilience (PR #399)

**Observed on a staging boot:** a Postgres statement-timeout (SQLSTATE `57014`) surfaced as an `unhandledRejection` from postgres.js' connection layer (escaping the poller's own try/catch), and `worker/index.ts`'s process-level crash-net exited the **entire worker** (24 queues + 20 background loops) over one transient DB blip. `OnboardingDripScheduler` (where it originated) already catches its own cycle errors — the bug was the crash-net's blast radius, so the fix is **general**.

- **`worker/index.ts`** — the `unhandledRejection` handler now classifies the reason: a clearly-transient DB error **recovers** (Sentry `warning` + log, no exit); everything else fails fast; `uncaughtException` stays always-fatal.
- **NEW `worker/transient-rejection-governor.ts`** — a **duration-based** governor: survive a brief boot fan-out (dozens of rejections in seconds), but escalate a *sustained* storm (rejections persisting >10 min with no >5 min idle gap) back to a crash+restart so a permanently-broken path doesn't run alive-but-broken behind the `SELECT 1` `/ready` probe. Pure + clock-injectable → unit-tested.
- **MOVED `worker/jobs/billing/postgres-transient-error.ts` → `src/lib/db/transient-error.ts`** (+ its test) — it now has a second, process-wide consumer, so the entry point no longer imports a crash-net dependency from a billing module. Added `isCrashNetRecoverableDbError`: an **explicit allowlist** (not broad-minus-exclusions), strictly narrower than the billing predicate — it OMITS `08000`/`08007`/`08P01` and the open-ended `08xxx` prefix, so ambiguous-state codes still crash. Billing keeps the broad `isTransientPostgresError`.
- **Reviews:** Codex APPROVED after **3 rounds** — it forced (R1) narrowing the predicate + adding a storm bound; (R2) redesigning the governor from a raw count threshold (which a boot fan-out across ~20 loops could trip) to duration-based, and an explicit tested allowlist (08000 was an untested survivor). Thermo-nuclear passed.

### Follow-up — Dependabot security patches (PR #400)

Lockfile-only transitive bumps within existing ranges (no `package.json` change): **form-data 4.0.5→4.0.6** (HIGH, runtime — `twilio→axios`), **undici 7.25.0→7.28.0** (HIGH, dev), **esbuild 0.28.0→0.28.1** (LOW). Open advisories 13 → 4. **Deferred** (the repo's own `pnpm-workspace.yaml` hardening blocks them, and forcing them is a worse trade): vite 8.0.16 (inside the 7-day `minimumReleaseAge` quarantine — published 2d ago; test-only tooling), @opentelemetry/core 2.8.0 (needs a coordinated `@sentry/node` SDK bump — a partial core bump splits the OTEL version set), @babel/core 7.29.6 (the vulnerable instance is dev eslint tooling; bumping it trips `trustPolicy: no-downgrade` → non-provenanced `semver@6.3.1`).

**Per-batch pipeline** (every PR): sibling worktree → recon → TDD → independently re-run the full verify gate (lint/typecheck/test/build + ci:tenant-scope/rls-audit/static-policy/config-coverage/process-env/fallow) → Codex correctness review (read-only, multi-round, Claude final arbiter) → thermo-nuclear maintainability → PR → CI green incl. React Doctor 100/100 → staging ride (worker boots clean) → merge → reset staging to main.

**Key decisions.** ReviewPublisher built now with ONE adapter (user override of the audit's "defer") — minimal, residual risk noted · nested `ReviewLocator` so the adapter never sees an app-owned id · error-taxonomy neutralization deferred to the GBP adapter · crash-net recovers transient DB but NOT ambiguous-state codes; a sustained storm still crashes (governor) · DB-client injection (Q4) + LLM-provider abstraction (Q5) deliberately OUT of scope · respect the repo's supply-chain hardening over forcing low-sev dep bumps.

**Doc-change-map applied:** this entry + the `currents.md` top summary (+ bumped `Last updated`); `lab-notes.md` (2026-06-26: the transient-DB-rejection-crashes-the-worker root cause + the pnpm supply-chain-hardening-blocks-bumps gotcha); `.claude/CLAUDE.md` (worker-layout note on the ReviewPublisher seam + a crash-net gotcha). **Skipped (no trigger):** `env-vars.md` (no env var/flag added — the governor uses constants), `migrations-log.md` (no migration), `review-ingestion.md` (publish path, not ingest).

---

## Campaign: Modularity A+ — the injection + LLM-seam close-out — PRs #438–#456 (2026-07-01 → 2026-07-06) — COMPLETE

**Status:** COMPLETE, merged to `main` (head `3070f0e5`). Nine domain sweeps + the strict-ratchet flip, **zero behavior regressions, zero migrations**, clean staging rides for every worker-touching sweep. Exit re-audit PASS. Full retrospective + the five-question evidence table: [`docs/audits/2026-07-06-modularity-aplus-exit-audit.md`](audits/2026-07-06-modularity-aplus-exit-audit.md).

**Why.** The June modularity-audit remediation (#397–#400 above) closed Q1–Q5 to A−/B+ but **deliberately deferred two residuals**: (A) the ambient `sql`/`supabaseServer` DB singletons (~214 importer modules) and (B) the inline `callOpenAI`/`callAnthropic` LLM fallback. A fresh 2026-07-01 five-questions re-audit re-confirmed both as the remaining ceiling on "dependencies explicit" (Q4) and "test in isolation" (Q2). This campaign closed both to an **A+ exit bar** (A or better on all five, zero unaccepted caveats) and made the wins **permanent, CI-enforced invariants** rather than campaign artifacts.

**What was done.**

1. **DB-singleton injection — the `105 → 0` arc (Residual A, closed permanently + structurally).** The ambient-DB-singleton importer set was ratcheted from **105 checked-in files** (Stage 1, #441, when `ci:db-imports` landed as a baseline guard) to **zero** (2i, #455) across nine domain sweeps (auth/approval, admin/accounts, billing/onboarding, KPI/dashboard, channels/notifications, reviews/responses/zernio, publishing, offboarding/locations, shared/app tail). Every business-logic module under `src/lib/**` + every worker helper now takes `sql`/`supabaseServer` (or `tx` inside a transaction) as an **explicit parameter**; only composition roots import `@/lib/db/server`. The **baseline was then deleted and the guard flipped STRICT** (PR 3, #456): worker root status is **derived from `worker/index.ts` registration** via TypeScript-AST parsing (not file position), `import type` excluded, unit-tested (11/11), CI-wired — regression is now structurally impossible. Only `src/lib/db/auth.ts` (owner-classified root) imports the singleton in `src/lib`.

2. **LLM task seam — `runLlmTask` (Residual B, closed).** `src/lib/llm/` (introduced PR 1c #443, generator as first tenant; review-summary added as 2nd tenant in 2f #451): `LLMProvider` adapters (`openai-provider.ts`/`anthropic-provider.ts`) + the `LLM_TASKS` pinned-model registry (`tasks.ts`) + `runLlmTask` as the single executor (primary + fallback + transient/terminal classification). Both reply generation and review-insight summaries route through it; zero generation/insights completion call outside `src/lib/llm/`. The seam owns model-pinning (`model-pinning.test.ts`) + the cost-guard contract; UI-layer provider-SDK runtime imports stay ESLint-banned.

3. **Bonus single-source + guard hardening.** `ci:reviews-status` (strict) + `ci:outbox-topics` guards closed two June single-source residuals; new single-owner modules landed for the Q1 amplifiers (`src/components/ui/marketing-links.ts` for NAV/MARKETING links, `src/lib/shared/queue-health-states.ts`, `src/lib/reviews/status.ts` `REVIEW_STATUS`, `src/lib/account-offboarding/outbox.ts` for the offboarding enqueuers); `ci:process-env` widened; four fat routes extracted to thin+injected+test-pinned modules (Q3 → A).

**Exit grades (Jun 26 → Jul 06):** Q1 A−→**A**, Q2 A−→**A**, Q3 A−→**A**, Q4 B+→**A+** (the headline), Q5 A−→**A**. Objective statics at exit: 0 cycles, 0 boundary violations, fallow maintainability 92.5, duplication 1.379% (down from 1,151→1,116 lines), **12/12 CI guards pass live and strict**.

**Key decisions.** Injection as an **explicit parameter** (not a DI container) — the simplest thing that makes the dependency visible + testable · the strict guard **derives roots from registration** so "root" is earned, not asserted by path · the baseline was **deleted** (not frozen) so the guard can only tighten · the LLM seam scope stayed **generation/insights only** (moderation's `/moderations` + Twilio WhatsApp are separate APIs, left out by design) · Residual B is closed by seam + tests + ESLint boundary, but a dedicated `ci:llm-seam` grep-guard (to match Residual A's structural permanence) is a **recommended follow-up**, not shipped here.

**Per-PR ledger:** #438 (re-audit + spec + plan), #439 (0a single-source + dead-code), #440 (0b pre-push mirror + loud skip), #441 (1a `ci:db-imports` + baseline 105), #442 (1b constants + guards), #443 (1c LLM seam), #444 (docs plan), #445 (2z `jsonb` composition-root-only), #446–#453 (2a–2h domain injection sweeps + route extractions + SQL dedups), #455 (2i tail → baseline **0**), #456 (3 ratchet **strict** + registration-derived roots + process-env widen + fallow `--coverage`). (#454 was an unrelated docs PR.)

**Doc-change-map applied:** the exit-audit doc (`docs/audits/2026-07-06-modularity-aplus-exit-audit.md`, written separately); this entry; `currents.md` (the "two deliberate residuals" passage rewritten to CLOSED + grade bump); `.claude/CLAUDE.md` (**new invariant #15** — DB-injection convention as permanent law + the LLM-seam tech-stack update); `docs/directory.md` (LLM-seam tenants refreshed + the `scripts/ci/` audit scripts + the DB-injection note). **Skipped (no trigger):** `env-vars.md`, `migrations-log.md`, `review-ingestion.md` (no env/flag, no migration, no ingestion-path change — structural refactor only).

---

## Workstream 8 — Copilot/Autopilot tier wiring (2026-07-14 → 2026-07-15, execution branch; PR pending)

**Status:** Implementation Tasks 1–11 complete on the WS8 execution branch;
branch-final mechanical verification (Task 12), the reserved integration-owner
four-review pass, PR, CI observation, and every staging/production operator
action remain pending. No remote database, Stripe Price, environment variable,
deployment, or webhook configuration was changed during implementation.

**Commercial/data model.** The four old subscription tiers were deleted from
runtime types, schemas, fixtures, admin provisioning, billing, and feature
entitlements. The only plans are monthly Copilot ($29 list / $19 founding, $15
per extra location) and Autopilot ($69 / $49, $20 extra), with exactly one
included location. `accounts.price_variant` is immutable `list|founding`; all
creation/Checkout/tier-change/activation/webhook/reconciliation paths carry it,
and every billing write persists the full tier/cents/quota snapshot. Billing
reads remain stored-snapshot authoritative. Trial Checkout remains Stripe-native,
card-up-front, 30 days, explicitly selected, and promotion codes are disabled.

**Runtime authority.** Autopilot purchasing composes the operator gate with
auto-approval runtime readiness. Grant-time code rejects Copilot `auto_policy`;
publisher code rechecks immediately before posting and downgrades queued rows on
entitlement/runtime loss. Trust-dial threshold/veto/cap changes are classified
from effective before/after state: expansions require Autopilot readiness,
contractions and disablement remain available during suspension or gate loss.
All entitlement checks use `subscriptionGrantsFullAccess`, preserving trialing.

**Billing/Stripe safety.** The six-Price map owns four base IDs (list/founding
per tier) and two tier overage IDs with reverse `{tier,variant}` lookup. Tier,
webhook, activation, and overage writers use the fixed advisory-lock graph,
stable Stripe idempotency, provider-current subscription reads, and one status
applier. Webhook variant mismatch preserves the immutable variant and stored
snapshot while surfacing an operational alert; status remains owned by
`worker/ingress/stripe/apply-subscription-state.ts`. Explicit tests cover founder
preview, proration/quantity math, replay, mid-cycle loss, both lock acquisition
orders, and non-vacuous mock-SQL queues.

**Schema/rollout.** Migration 077 is direct SQL: first apply detects the absent
marker column, expands defaults/immutability, then unconditionally normalizes
pre-existing quiesced rows to the complete Copilot/list launch snapshot; second
apply repairs objects without rewriting post-cutover data. Migration 078 runs
only after strict code and smoke, aborts NULL-safely on either invalid mirror,
and installs re-runnable strict two-tier CHECK/NOT NULL contracts. The sole
operator order is documented in
[`ws8-tier-cutover.md`](runbooks/ws8-tier-cutover.md): create six immutable
Prices and retain seven old IDs → quiesce all writers/Stripe ingress → all-six
parity + provider-wide subscription/Session blocker zero → 077 → strict code →
controlled smoke → 078 → resume, staging before production.

**New/central files.** `src/lib/accounts/{tier-config,tier-snapshot}.ts`,
`src/lib/payments/{price-tier-map,founding-window,tier-purchasability,plan-presentation}.ts`,
`src/lib/accounts/tier-change.ts`, `worker/ingress/stripe/`,
`worker/jobs/publisher/`, `src/lib/auto-approval/settings.ts`,
`supabase/migrations/077_copilot_autopilot_expand.sql`,
`supabase/migrations/078_copilot_autopilot_contract.sql`,
`scripts/verify-stripe-price-parity.ts`, and
`scripts/ws8-stripe-cutover-preflight.ts`. Public pricing, onboarding plan
selection, and authenticated billing now consume server-produced two-tier view
models with no annual selector or default plan.

**Operator inputs still required.** Create six environment-specific immutable
Stripe Prices; supply positive `DAILY_COST_LIMIT_CENTS_COPILOT` and
`DAILY_COST_LIMIT_CENTS_AUTOPILOT`; configure the six IDs plus exact
`FOUNDING_DEADLINE=2027-01-01T00:00:00Z`; retain seven old IDs through rollback;
perform the quiesced staging/production sequence. `AUTOPILOT_PURCHASABLE=true`
has separate authorization: WS4/074 live, WS6/076 live, WS7 eval green,
documented cadence limits, and intentional `AUTO_APPROVAL_ENABLED=true`.

**Doc-change-map applied (Task 11).** Updated this history and the top
`currents.md` state summary; replaced old tier/Payment Link material in
`.claude/reference/env-vars.md`, refreshed the flat inventory in
`docs/eservices-variables.md`, cross-linked 077/078 in
`.claude/reference/migrations-log.md`, updated `docs/directory.md`, and added the
cutover runbook. Skipped `review-ingestion.md` (ReviewSource/ingest contract did
not change), `lab-notes.md` (no new subsystem root-cause gotcha), and
`.claude/CLAUDE.md` (existing invariants and where-to-read table already own the
architecture; no invariant changed in Task 11).

### WS8 adversarial launch-safety correction — 2026-07-15

Post-implementation review found three launch blockers in otherwise-green WS8
coverage: two selectable Checkout Sessions could cross-bind price and
entitlement; `NULL` daily-cap edits were compared as if NULL meant no limit
instead of the effective default of 10; and canonical Stripe status writers
could compose account → business with publisher business → entitlement and tier
entitlement → account into a three-party deadlock. The owner explicitly
authorized the narrow Checkout-design amendment; no commercial decision changed.

- **Checkout now has one authoritative attempt lease.** Migration 077 adds the
  complete attempt/Session/tier/variant/Price/cents/quota/quantity tuple plus
  frozen trial, tax, email, and return-URL inputs and a unique Session index.
  Reselection expires the prior open Session; provider-created/unbound Sessions
  are compensated; completion requires provider-current `active|trialing` and a
  changed+activated binding transition before status/snapshot. Stale or
  non-binding completion is canceled/remediated for explicit reselection.
- **Policy expansion uses effective state.** NULL daily cap means the default
  cap of 10, so NULL→1 contracts, NULL→10 is unchanged, NULL→50 expands, and
  finite→NULL remains cap removal/expansion.
- **Status and mirror projection are split durably.** Status ingress resolves
  account identity unlocked, provider-reads before DB locks, acquires that exact
  account's entitlement lock, and rechecks lineage on the locked row. Real
  transitions and resolved no-op subscription replays enqueue
  `stripe_subscription_mirror_sync`; the worker uses ordered business →
  entitlement locking and completes the outbox transactionally. Canonical
  status transactions never update the business mirror synchronously.

Mutation-sensitive tests cover cross-tier Session completion, frozen-create
drift, non-entitled/non-binding completion, founder preview/quantity/variant
guards, effective cap comparisons, status lineage races, mirror enqueue, and
both deterministic three-party waiter orders. The tenant-scope baseline remains
391. Integration-owner review, PR/CI, remote Price/env work, migration, deploy,
and rollout remain deliberately unperformed.

**Doc-change-map applied.** Updated `currents.md`, this history,
`.claude/reference/migrations-log.md`, `docs/directory.md`, the hardened design,
WS8 spec/plan/review log, and the cutover runbook. Skipped `env-vars.md` (no new
operator variable), `review-ingestion.md` (no ReviewSource change),
`lab-notes.md` (the root causes are recorded in the locked review history), and
`.claude/CLAUDE.md` (existing billing/outbox/worker-layout invariants already
cover the new modules).

---

## 2026-07-20 — Scalability verification remainders (#511)

Closed verification items 6 and 8, the final two pre-launch scalability
remainders. Branch `fix/verification-remainders`, squash-merged as `88be8e77`
via **PR #511**. Rode staging first (worker touched + migration), then main.

**Item 6 — boot-enforce the summed LLM worker-slot cap.**
- New `assertSummedLlmWorkerSlots(entries)` in `worker/config/startup-assert.ts`,
  colocated with the `assertSingleConcurrencyWorker` precedent. Reads EFFECTIVE
  `worker.opts` (`opts.concurrency ?? 1`), sums the non-flag-gated LLM queues,
  throws at boot if the sum > 9, and caps each flag-gated queue (`judge_verdict`)
  at 1 separately so booting with the judge flag ON never trips the sum.
- Called in `worker/index.ts` right after the six LLM-worker registrations, with
  the real `worker.opts` of `generate_response` (5), `generate_demo` (1),
  `weekly_summary` (1), `send_monthly_impact` (1), `onboarding_demo_response`
  (1) → sum 9; `judge_verdict` (1, flagGated).
- The two cap literals (`SUMMED_LLM_WORKER_SLOT_CAP=9`,
  `FLAG_GATED_LLM_WORKER_SLOT_CAP=1`) are module-private (implementation detail;
  the boundary tests pin 9/10 as concrete values by design).
- **No concurrency VALUE changed** — enforcement only. `generate_demo` was
  missing from #490's inventory; `docs/adr/0005-beta-launch-posture.md` addendum
  amended to cap 9 with `generate_demo` counted; `CONTEXT.md` glossary synced.
- Tests: `worker/config/__tests__/startup-assertion.test.ts` — sum exactly 9
  passes; sum 10 throws; undefined concurrency counts as 1; judge at 1 passes /
  at 2 throws; effective-opts drift (generate at 6) throws.

**Item 8 — NotificationFailoverPoller lookup indexes (migration 082).**
- `idx_jo_send_notification_by_aggregate` on `job_outbox (aggregate_id,
  created_at DESC) WHERE topic = 'send_notification'` — serves
  `recoverFailoverCorrelationId` (mirror of 018's `generate_response` twin).
- `idx_responses_pending_approval_created` on `responses (created_at) WHERE
  status = 'pending_approval'` — serves both global sweeps (all-failed + stale);
  supplies the `ORDER BY created_at ASC` so there is no Sort node.
- Both `CREATE INDEX CONCURRENTLY IF NOT EXISTS` → **non-transactional**, NOT
  atomic; header documents the 062 invalid-index recovery (`pg_index.indisvalid`
  → `DROP INDEX CONCURRENTLY` + re-run). Applied **staging then prod** in
  lockstep; both projects verified `indisvalid = indisready = true`.
- No INCLUDE columns yet — staging + prod `EXPLAIN (ANALYZE, BUFFERS)` captured
  first (evidence rule); INCLUDE deferred to a production EXPLAIN if heap-fetch
  cost ever shows up.
- Test: `src/lib/shared/__tests__/migration-082-failover-indexes.integration.test.ts`
  (DB-gated) — both indexes exist, partial predicates exact, `indisvalid` +
  `indisready` true.

**Post-merge hygiene (this same docs PR).** Untracked the `/feature` run scratch
(`.feature/intake.json`, `.feature/sessions`) from git and gitignored the whole
`.feature/` dir. Those files had been landing on `main` via squash-merge and,
combined with the committed enforcement hooks, armed feature-mode in every future
`main` session against the last-merged feature's edit surface. `.feature/` is
now purely on-disk run scratch (the hooks still arm off `.feature/intake.json`,
they just no longer follow a merge onto main).

**Follow-ups filed (from review triage), not in this PR:** extract the shared
DB-guard test harness (5 duplicate copies across the 076–082 integration tests);
candidate `ci:` audit mapping `runLlmTask` importers → LLM queue inventory (the
class of gap #490 hit).

**Doc-change-map applied.** Updated `currents.md`, this history, and
`.claude/reference/lab-notes.md`. `migrations-log.md`, `docs/adr/0005`, and
`CONTEXT.md` were updated inside the feature PR itself. Skipped `env-vars.md`
(no operator variable — the boot assert reads registrations, not env),
`review-ingestion.md` (no ReviewSource change), and `.claude/CLAUDE.md`
(existing worker-layout / boot-assert conventions already cover the new
`startup-assert.ts` export).

---

## 2026-07-20 — Production reliability guards P1/P2/P3/P5/P6/P7/P10 (#508)

Seven of the ten findings from the pre-production reliability review, scoped as
the mechanical/low-blast-radius "guards" branch. Branch
`fix/prod-hardening-guards` (sibling worktree), squash-merged as `8200a8ea` via
**PR #508**. Rode staging first (worker + ingress touched), then main. No
migrations, no env vars.

**The seven guards.**

- **P1 — crash-proof zernio ingest failed-hook**
  (`worker/jobs/zernio/ingest-failed-hook.ts`). The bare `'failed'` listener is
  now wrapped in a last-resort never-rethrow guard (mirrors
  `handlePublisherFailed`); a DB error during failure bookkeeping can no longer
  become a fatal unhandled rejection that kills all queues. Refactor M3+L1:
  `withOwnedTerminalTransition` owns the CAS-first coupled-tx contract — the
  `markOutboxFailed` CAS runs FIRST inside `sql.begin`, coupled
  `review_exceptions` writes run only on ownership, a stale attempt writes
  nothing, and the `coupledTerminalTxStarted` flag keeps the crash guard from
  splitting a rolled-back tx with a best-effort outbox write.
  `insertReviewExceptionIfAbsent` is the single owner of the
  byte-for-byte-critical `ON CONFLICT` predicate (type moved to a bound value).
- **P2 — bounded Supabase admin/storage fetch**
  (`src/lib/db/server.ts`). `boundedSupabaseFetch` attaches
  `AbortSignal.timeout` (`SUPABASE_FETCH_TIMEOUT_MS = 10_000`, code constant).
  **Adversarial finding 1 split the client:** bounding the shared
  `supabaseServer` global fetch also bounded Auth identity MUTATIONS — a signUp
  or invite committing remotely but responding >10s would surface as
  TimeoutError with no reconciliation path (orphaned identity →
  `account_exists` lockouts). So `supabaseServer` reverted to unbounded; new
  `supabaseServerBounded` carries the bounded fetch and is used by the
  account-offboarding purge wiring (`worker/index.ts` composition root) and
  `CleanupAbandonedSignupsPoller` (its 10s `Promise.race` belt stays — it also
  covers non-fetch hangs and preserves TIMEOUT classification).
- **P3 — guardrail-regen transient retry**
  (`worker/jobs/response-generation/generate-draft.ts`). **Owner decision
  2026-07-16, overriding the documented anti-respend carve-out:** all three
  transient classes (`TransientLLMError`, `ConcurrencyLimitExceededError`,
  `CostInfraUnavailableError`) re-throw from BOTH guardrail catch layers →
  BullMQ retries the job instead of terminal `guardrail_failed` (an OpenAI 503
  during regen was silently dropping a draft the owner paid for). Accepted
  trade-off: with Redis down, the idempotent cache may miss on retry → a
  re-spend of the primary generation, bounded by the `generate_response`
  queue's BullMQ attempts budget. Refactor M1: one `isTransientGenerationError`
  predicate owns the three-class classification at all three catch sites.
  `.claude/CLAUDE.md`'s cost-guard gotcha was updated in the same PR.
- **P5 — non-fatal emitter `'error'` listeners** (`worker/emitter-errors.ts`,
  wired in `worker/index.ts` + `worker/queues.ts`).
  `attachEmitterErrorLogger(emitter, source)` on every BullMQ Queue, every
  Worker, and the probe Redis client — an unlistened EventEmitter `'error'` is
  `uncaughtException`, which is always fatal, so a transient Railway Redis blip
  restarted the whole worker. Per-source 60s count-and-suppress window on both
  the structured log and the Sentry `warning` (ioredis reconnect loops emit one
  error per attempt across ~46 emitters — unthrottled capture is an alert
  storm). The listener body never throws.
- **P6 — bounded Fastify ingress** (`worker/config/fastify-options.ts`).
  `buildFastifyOptions(nodeEnv)`: requestTimeout 30s (default is 0/disabled),
  keepAliveTimeout 60s, connectionTimeout 10s, bodyLimit 5 MB (headroom for
  batch Zernio payloads). Options extracted to a testable pure function;
  `worker/index.ts` consumes it.
- **P7 — health-alert blind spots**
  (`worker/background/pollers/health-alert/checks.ts`). The failed-outbox topic
  filter gains `QUEUE_NAMES.GENERATE_RESPONSE` (terminal generation failures
  were invisible); new check on `inbound_events.status='failed'` within the
  existing lookback window (finding key
  `inbound_events_failed:<source>:<event_type>`), covered by the existing
  partial index — Stripe/Zernio processing bugs had been masked ~3 days by
  provider-side retries. Reuses existing `HEALTH_ALERT_FAILED_WINDOW_S` /
  `_THRESHOLD` config; no schema change. `ci:tenant-scope` allowlist entry
  added for the cross-account health query.
- **P10 — dashboard per-widget degradation**
  (`src/lib/dashboard/{service,aggregate-service,aggregate-queries}.ts`).
  Per-location path: the business lookup stays fatal
  (`BusinessNotFoundError` semantics preserved; adopted via
  `Promise.resolve` BEFORE the `allSettled` batch so the mock-sql FIFO order
  survives); the other queries settle independently and each degrades to its
  per-widget fallback via `widgetOrFallback`, ALWAYS reported
  (`reportCaughtError`) — degradation is never silent. The #495 opt-in
  reputation batch degrades as one widget. **Aggregate path went through three
  shapes:** (1) plan-era per-location slice exclusion; (2) post-rebase onto
  main's #476/#495 set-based rework, the "atomic slice wave" was declared fatal;
  (3) **adversarial finding 2 superseded that** — the wave was never atomic in
  the failure sense (~8 independent reads under an internal `Promise.all`), so
  one ranking/brief read timing out still 500'd the whole multi-location
  dashboard, the exact P10 failure. Final contract: the wave's reads settle
  independently and degrade per-query via the curried
  `widgetOrFallbackFor('dashboard/aggregate')` (L2 refactor — correct Sentry
  source) with per-widget names (`sliceReviewCounters`, `sliceReviewVelocity`,
  `sliceRatingBreakdown`, `sliceRanking`, `sliceMonthlyBriefs`,
  `sliceWeeklyBriefs`, `slicePendingApprovalCounts`), plus degradable
  `accountBillingRows` and `accountRecentReviews`; **exactly two reads stay
  fatal** — the locations list and the wave's baseline anchor read (slices are
  built by iterating its rows; degrading it would render an all-zeros
  misreporting dashboard). Known bounded trade-off: a degraded payload can sit
  in the #495 45s cache TTL.

**Key decisions (with evidence pointers).**

- P3 owner override of the anti-respend carve-out — spec §P3 + CLAUDE.md
  gotcha updated in-PR (bounded-re-spend accepted over silent draft loss).
- Adversarial-review round (post-staging) produced two shipped amendments:
  the Supabase client split (finding 1) and per-query slice-wave degradation
  (finding 2) — record in
  `docs/reviews/fix-prod-hardening-guards/plan-adversarial-round1.md`.
- Review/gate evidence: `docs/reviews/fix-prod-hardening-guards/spec-review.md`
  + `standards-review.md`; plan (3 revision rounds, Codex-approved):
  `docs/superpowers/plans/2026-07-16-prod-hardening-guards.md`; deviations log:
  `docs/superpowers/plans/fix-prod-hardening-guards-deviations.md`; P4/P8/P9
  follow-up map:
  `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md`.
  Gates: lint/typecheck/test + `ci:static-policy`/`ci:analytics-events`/
  `ci:tenant-scope`/`ci:rls-audit` + build, green per plan; staging smoke of
  webhook ingress + dashboard + a generation cycle before merge.

**Files (production surface).** `worker/emitter-errors.ts` (new) ·
`worker/config/fastify-options.ts` (new) · `worker/index.ts` ·
`worker/queues.ts` · `worker/jobs/zernio/ingest-failed-hook.ts` ·
`worker/jobs/response-generation/generate-draft.ts` ·
`worker/background/pollers/health-alert/checks.ts` ·
`worker/background/pollers/CleanupAbandonedSignupsPoller.ts` ·
`src/lib/db/server.ts` · `src/lib/dashboard/service.ts` ·
`src/lib/dashboard/aggregate-service.ts` ·
`src/lib/dashboard/aggregate-queries.ts` ·
`scripts/ci/tenant-scope-allowlist.ts` · tests:
`worker/__tests__/emitter-errors.test.ts`,
`worker/config/__tests__/fastify-options.test.ts`,
`src/lib/db/__tests__/supabase-fetch-timeout.test.ts`,
`src/lib/dashboard/__tests__/{service,aggregate-service}.degradation.test.ts`,
plus extended ingest-failed-hook / generate-draft / health-checks suites.

**Doc-change-map applied (this sweep).** Updated `currents.md`, this history,
`.claude/reference/lab-notes.md` (4 notes: bounded-fetch identity split,
emitter-error fatality + suppress window, `AbortSignal.timeout` vs fake
timers, `markOutboxFailed` CAS ownership-in-tx), the review-ingestion
exception-write note, and `.claude/CLAUDE.md` Worker layout (two one-line
entries for the new boot-level files; the cost-guard gotcha was updated inside
PR #508 itself). Skipped `env-vars.md` (no operator variable — all bounds are
code constants) and `migrations-log.md` (no migration).

---

## 2026-07-21 — Reliability follow-ups P4/P8/P9 — PRs #514 / #515 / #516

Closes out the 10-finding pre-production reliability report:
P1/P2/P3/P5/P6/P7/P10 shipped in #508 (previous entry); these three rode the
mapped follow-up branch
(`docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md`, tickets
F2/F3/F1). Each ran the full /feature lane (codex-gated plan, adversarial +
dual review, staging ride before merge).

**#514 — F2/P8: bound Stripe calls under tier-change advisory locks
(`3bd34d60`).** Key decision: a single owner constant
`STRIPE_UNDER_LOCK_REQUEST_OPTIONS = { timeout: 8_000, maxNetworkRetries: 0 }`
(`src/lib/accounts/tier-change.ts`), spread into `stripeOptions()` so every
under-lock mutating call carries the bound PLUS its deterministic
`tier-change:<accountId>:<operationKey>:<step>` idempotency key — recovery for
an ambiguous timeout is the Stripe webhook/reconciler path (provider-side
idempotency), never a retry while the pg advisory locks + `FOR UPDATE` are
held. Codex adversarial review corrected the bound's claim against stripe
22.2.0 source: `RequestSender._shouldRetry` retries ONCE on ECONNRESET/EPIPE
*before* the maxRetries guard, so worst-case lock hold is ~26s (down from
~60s+), not a hard 8s — timeouts (the target hung-provider case) do NOT retry.
Deviation: `subscriptions.retrieve` takes the bound as the THIRD arg (empty
params second; TS2559 otherwise). Tests:
`src/lib/accounts/__tests__/tier-change-stripe-timeout.test.ts` (356 lines) +
six existing options assertions moved to `expect.objectContaining`.

**#515 — F3/P9: LLM provider circuit breaker (`ee951445`).** In-process,
per-provider (`LLMProviderId`) breaker: `src/lib/llm/circuit-breaker.ts`,
consulted by `runLlmTask` — 5 consecutive `isTransientLLMError` failures ⇒
open 30s ⇒ one half-open probe; open primary ⇒ immediate fallback failover;
both blocked ⇒ retryable `TransientLLMError` (never terminal). Key decisions:
(a) epoch-correlated `Admission` token (step-6 adversarial F1 — a slow
pre-trip success from one of ~9 concurrent jobs must not close a just-tripped
breaker mid-cooldown; `recordAttempt(admission, error?)` ignores stale-epoch
outcomes); (b) kill switch read LIVE per call (invariant #13) and
disable-clears-state (step-6 F2 — disable→enable can't resurrect a stuck
`half_open`); (c) `throwBlocked` prefers the most recent real transient cause
over the synthetic `LlmCircuitOpenError` (step-7 ST-2, diagnostic context);
(d) Sentry `warning` only on trip (closed→open) and recovery (→closed) —
open↔half_open churn was ~240 warnings/hr in a sustained outage, now
structured-log-only (deviation D4, pre-merge nit N2). Flag
`LLM_CIRCUIT_BREAKER_ENABLED` default ON via new `readFlagEnabledByDefault`
(`src/lib/config/flags.ts`) + `src/lib/llm/flags.ts` accessor; OFF is
byte-identical to prior behavior. Test-hygiene nit N1: suites that mock the
raw SDKs but drive the real seam reset the singleton in `beforeEach`.

**#516 — F1/P4: owner-unreachable escalation (`9c32fa92`, ADR 0010).**
Migration **083** adds nullable `job_outbox.completion_reason` (additive, NO
new index — reuses 082's two partial indexes; `SET LOCAL lock_timeout='3s'`
bounds the ACCESS EXCLUSIVE lock). Applied staging 2026-07-21 → prod
2026-07-21 in lockstep (owner-confirmed). `NotificationWorker` records
`completion_reason='owner_unreachable'` on `no_verified_enrollments` via
`markOutboxOwnerUnreachable` (attempt-guarded CAS, `src/lib/shared/outbox.ts`;
generalized to `markOutboxCompletedWithReason` at #695 — same emitted UPDATE, same
persisted value; value owned by `OUTBOX_COMPLETION_REASON`,
`src/lib/shared/outbox-completion-reason.ts`). `checkOwnerUnreachable`
(health-alert): latest-COMPLETED-reason predicate, **4h age floor** — durable,
keeps firing until the draft resolves — and the pre-existing zero-delivery
check is de-conflated (ADR 0010 corrected the ticket's stale "no health check
can see it" premise: the case was conflated + transient, not invisible).
`NotificationFailoverPoller` third arm: advisory-locked retry INSERT
(at-most-once; in-flight `send_notification` excluded at candidate level —
step-6 finding 2) + 24h-deduped admin email. Env:
`HEALTH_ALERT_OWNER_UNREACHABLE_AGE_S` (14400) / `_THRESHOLD` (0). Tenant-scope
allowlist 395→405 (cross-tenant ops scans by design). Fallow gate drove an
owner-approved scope expansion: shared `resolveEligibleChannels` extracted to
`worker/jobs/notification/eligibility.ts` (three notice workers, behavior
byte-identical).

**Doc-change-map.** Riding the branches (cross-PR overlap files, verified
merged clean this sweep): `env-vars.md` rows (`LLM_CIRCUIT_BREAKER_ENABLED`,
`HEALTH_ALERT_OWNER_UNREACHABLE_*`), `migrations-log.md` 083 entry + head bump,
`CONTEXT.md` glossary (LLM provider circuit breaker; Owner-unreachable
outcome). This sweep added: `currents.md` summary + Last-updated bump, this
entry, two lab notes (stripe reset-retry caveat; breaker-singleton test-state
leak), the CLAUDE.md LLM-seam breaker mention, migration-083 applied dates,
follow-up-map SHIPPED status, and the arch-review counter 1→4 (next feature
merge hits the ≥5 review threshold).

## 2026-07-22→23 — Agentic staging E2E campaign (Phases A–D) + launch-gate closures — PRs #518–#522

**What:** the WS1–WS8 agentic platform was proven end-to-end on the staging full
stack (Supabase `kubdiqdhqbhwmqfditeg` + Railway staging worker + staging.repworth.net)
against a **live Google Business Profile** (Tancia Resort, owner-authorized),
per `docs/runbooks/agentic-staging-copilot-autopilot-e2e.md` and
`…phase-d-purchasability.md`. Evidence records:
`docs/runbooks/evidence/2026-07-21-agentic-staging-copilot-autopilot-e2e-evidence.md`
(A–C) and `…2026-07-22-agentic-staging-phase-d-evidence.md` (D).

**Phase results:** A (Copilot full loop: live ingest → draft → owner-notification →
`/approve` token flow → real Google post; spine `review_ingested→…→reply_posted`,
run completed) ✅. B (Guardian: WS2 triage discriminated severities on live
reviews with `api_costs endpoint='review-triage'` rows; WS3 escalations raised +
emailed + acknowledge/resolve lifecycle; drafts stayed `pending_approval`) ✅.
C (Autopilot: live 5★ auto-approved `approval_method='auto_policy'` with NO
owner action → 15-min veto window (delayed publish + pending-post notice) →
real auto-post 09:42Z → judge verdict `pass` 09:43Z; drills: moderation absolute
veto held `Refund Tester` despite AUTO_APPROVAL on; judge-off downgraded an
approved auto-post back to owner review (`auto_policy_revoked_judge_unavailable`);
governor auto-suspended on 5/6 flag rate with owner+admin notices, then
unsuspend re-armed) ✅. D (purchasability: 12/12 `WS8_SMOKE` scenarios incl.
gate-closed denials + publish-time downgrade; real fresh-signup Autopilot
checkout $49 founding/trialing; copilot→autopilot upgrade via billing UI with
`tier_changed` audit + in-place Stripe sub update; trust-dial settings-UI
expansion/blocked-409/contraction matrix; governor suspension rendered at
`/admin/autonomy` under real AAL2 TOTP and unsuspended with a note — no SQL) ✅.
Zero net new Google posts in Phase D; every flag returned to baseline after each
phase.

**Bugs found by live testing (all merged):**
- **#518** `fix(billing)` — every card-up-front trial signup stranded
  `pending_payment`: `trialContractMatchesLease`
  (`worker/ingress/stripe/checkout-completed.ts`) accepted only
  `no_payment_required`, but Stripe reports `payment_status='paid'` for the $0
  setup invoice → `invalid_trial` → `cancelUnexpectedSubscription` killed the
  valid trialing sub. Second bite of the known lab-note trap; both sites now
  accept `paid`. Regression test added.
- **#519** `fix(onboarding)` — `POST /api/onboarding/business` read raw
  `onboardingDemoEnabled()` while `page.tsx` used
  `shouldUseDemoWizard(flag,row)` → 409 `onboarding_not_started` redirect loop
  for a trial with no captured location. Route now shares the page's helper.
- **#520** `fix(governor)` — an account could NEVER be re-suspended after its
  first unsuspension: `listGovernorCandidates` derives `window_start` from the
  `autonomy_unsuspended` audit MAX (µs precision); postgres.js hands it to JS as
  a ms-precision `Date`; `revalidateGovernorCandidate`'s `created_at > $window`
  then matched the very row the window came from → silent skip every cycle.
  Found in the Phase D drill (5/5 flags, rate 1.0, >10 min at 20s cadence, no
  suspension, no log). Fix: `date_trunc('milliseconds', created_at) >` + the
  scheduler's skip path now logs. TDD: integration regression seeds the audit
  with `+ interval '419 microseconds'` (JS-Date-seeded fixtures carry zero µs —
  exactly why 31 green tests never caught it); red before, green after.

**Gate closures:** Zernio automated posting CLOSED (no limits, pay-per-use per
account; record + implications in `docs/runbooks/zernio-automated-posting-limits.md` —
pacing is entirely ours, Zernio volume is now a COGS line, pricing unit TBD).
Prod Supabase verified by introspection: 071–077 + 079–083 present, **078
deliberately absent** (expand/contract half-state; contract applies inside the
prod WS8 cutover; prod tables have 0 rows). Production stack deliberately not
stood up — build-first strategy recorded in design doc §8.4; bring-up is one
launch-day session.

**Docs landed:** #521 (audit trail: §8 as-built status in the design doc, 4
runbooks, 2 evidence records, scalability+reliability re-audits, `.scratch/`
gitignored) and #522 (CLAUDE.md Where-things-live row routing all agentic work
to §8 → per-WS specs → evidence). Runbook defects found during execution were
fixed upstream in the same pass (composed-gate `--gate-open` caveat, Vercel
both-halves env note, §1.1 triage-columns check, veto-window 15/30 enum, MFA
enroll-if-absent, OTP relay logistics).

**This sweep added:** `currents.md` summary + Last-updated bump, this entry,
two second-bite appendices on existing lab notes (#518 trial `paid`, #519
wizard-flag parity), and one new lab note + CLAUDE.md gotcha (postgres.js
timestamptz µs truncation — second subsystem bitten).

**Arch-review counter: unchanged at 4** — this era's merges were bugfixes
(#518–#520) and docs (#521–#522), not features. The next feature merge (likely
Phase 2 / Solicitation work) hits the ≥5 review threshold.

---

### 2026-07-23 — Restraint policy module (#542, PR #551) — Phase 2 Solicitation begins

First implementation ticket off wayfinder map #528, built exactly per the
locked spec `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`
(#533, PR #548) and ADR 0012, via the ticket-seeded `/feature` path.

**What shipped:** `src/lib/solicitation/restraint-policy.ts` — pure deep
module, zero imports. Exports: `evaluateAsk` (five per-candidate gates,
first-match precedence, one reason per withhold), `evaluateBatch` (adds
batch-relative `velocity_banked`: cap 25, most-recent-visit-first, UUIDv7
tie-break; returns decisions in input order), `resolveVertical` (precompiled
left-word-boundary keyword matchers → closed 8-vertical enum, `other`
fallback), closed six-reason enum, `RESTRAINT_POLICY_VERSION` +
tunable-constants table (freshness windows per spec §3.2, `BATCH_CAP=25`,
`MIN_GAP_DAYS=30`). Evidence snapshots: discriminated union, spec §4
snake_case field names verbatim (serialization contract for JSONB storage +
batch UI), never PII / never a star rating (typed + runtime-asserted).
34 Vitest tests incl. a fast-check invariants block (determinism, envelope +
single closed-enum reason, send∪banked set-equals the surviving pool,
|send| ≤ cap, no PII/sentiment keys in serialized evidence).

**Decisions made at build time (not in the spec):** no `sql` param (the
ticket's invariant-#15 note superseded by spec §5.1 purity — context fully
caller-loaded, #543's job); `evaluateBatch` as the batch-level entry since
`velocity_banked` is assessable only against the surviving pool;
`MIN_GAP_DAYS=30` day-one (spec gap, conservative middle, tunable);
over-contacted boundary symmetric with stale_visit (exact gap allowed).
Cross-review footnote added to spec §1: `no_consent`, like `suppressed`,
cannot fire in v-watch (the #535 attestation is blocking).

**Review round (5/5 accepted, 0 rejected —
`docs/reviews/feat-542-restraint-policy/triage.md`):** the real catch was
offset-ISO timestamp skew — the original `utcDayNumber` sliced the lexical
date part, so a `-07:00` `decidedAt` could flip a gate boundary vs true UTC;
fixed with `Date.parse`-based day arithmetic for timestamps + a deterministic
±offset boundary test. Also: partition property strengthened to set-equality,
over_contacted-beats-velocity_banked deterministic test, keyword regexes
precompiled, `docs/directory.md` entry (edit surface amended with sign-off).
Two sanctioned deviations (both `noUncheckedIndexedAccess` strict-mode fixes,
behavior identical) logged in the plan's deviations file.

**Gate evidence:** verify-gate GREEN ×2 (lint, typecheck, test, all 12 `ci:*`
audits); full CI green on PR #551; squash-merged `d4add503`; staging
fast-forwarded same day.

**Arch-review counter: 4 → 5 — threshold REACHED.** An architecture review
session is due before the counter grows further (user schedules it; see
`.claude/reference/arch-review-log.md`).

---

## 2026-07-23 → 2026-07-26 — Solicitation watch-mode: wayfinder map #528 charted, worked, and DESTINATION REACHED

The full arc from `/adhd` ideation to a live agent, in one map (issue #528,
now closed with every ticket indexed in its Decisions-so-far):

**Charting (2026-07-23):** destination locked by grilling (watch-mode live,
probes don't gate, owner-CSV candidates, all-paying-tiers flag) → design doc
§9 written (PR #545) → 16 tickets + blocking edges → 3 research subagents
resolved same-day (#529 run-spine gap, #530 SerpAPI fields, #531 policy
constraints — gating binds SELECTION even in watch-mode).

**Decision layer:** 4 parallel grilling sessions → PRs #547–#550 (executor
shape + ADR 0011; restraint policy + ADR 0012 — renumbered from a 0011
collision at merge; Delta semantics; CSV contract). Cross-PR review caught the
ADR collision, a 4-way CONTEXT.md append, and a ticket-range slip. Two
prototypes (#536 Voice Report Card, #537 batch screen) resolved with decisions
+ throwaway branches.

**Implementation wave (2026-07-24 → 26), every PR through review + fix-round
discipline:**
- **#554** (#538 competitor snapshots, migrations 084+**085** — REAL→NUMERIC
  amendment shipped as a new migration when the immutability guard correctly
  blocked editing staging-applied 084).
- **#561** (#540 Voice Report Card screen; APPROVE-WITH-NITS; two cosmetic
  follow-ups on the ticket).
- **#564** (#541 CSV ingestion, migrations 086+**087** — cascade-FK indexes
  from review; fix round closed a real polling-effect leak + fallow debt;
  merged with complexity advisories → #565).
- **#570** (#539 Delta digest line; review caught a production-fatal
  DATE-vs-string filter — every location would have degraded to teaser
  forever; fixed `::text` end-to-end + query-shape pin; #532 semantics
  amendments recorded).
- **#571** (#543 run-engine executor, migration 088; all five pinned
  carry-forwards resolved — whole-pool candidate set with 5,000 bound +
  rotation, banked-never-in-history test-pinned, executor failed-hook with D4
  amended, truncation logging added post-review).
- **#574** (#546 rival picker, migration 089; dropout-note glossary
  reconciled; title-snapshot made deterministic).
- **#575** (#544 Requests surface; reviewed-ping made retry-safe;
  pending-visibility divergence from 088 RLS documented in-code).

**Architecture review (2026-07-24, threshold 8 merges):** 6 findings, none
blocking — S1/S2 (ingest lock-key + terminalizer duplication → #569/#565),
S3/S4 (pre-build executor findings, resolved in #543's grilling), R1
(single-replica invariant unguarded → #567), R2 (outbox seam 13 typed helpers
vs 28 raw writers → #568). Counter reset, then 4 completion-wave merges → 4.

**Destination (2026-07-26):** `staging` reset onto `main` (squash protocol),
Railway worker SUCCESS + Vercel Ready, `SOLICITATION_WATCH_ENABLED=true` on
both staging surfaces (prod OFF). Evidence:
`docs/runbooks/evidence/2026-07-26-solicitation-watch-mode-staging-flip.md`.
Owner SSO smoke pending (upload → batch → funnel + verbatim withhold chips).

**Open debt carried forward:** #555 (send-mode gate), #565, #567, #568, #569,
#572, #573. Next effort: send-mode map per design doc §9.3, after watch-mode
engagement signal.

---

## 2026-07-30 → 2026-08-01 — Consent ledger #625 (send-mode map #617, ticket #620's primary implementation) — PR #640

**What shipped** (44 files, +3,124/−82; squash `7316383f`): the
`solicitation_consent` ledger and its ingest wiring, killing the
`consent_attested` tautology and the spec §1.2 re-upload trap. Full /feature
pipeline (RISK=high): 3-round adversarial plan review → 16 branch commits →
verify-gate `--review` green → Codex adversarial + dual step-7 review (all
findings fixed/triaged) → staging ride → owner-approved merge → prod lockstep.

- **Migrations** (staging `kubdiqdhqbhwmqfditeg` 2026-07-31; prod
  `udeyaqnvpojbwgoaxwdg` 2026-08-01; both verified by schema introspection):
  **093** ledger table — one current-state row per `(channel, normalized_handle,
  business_id)`, email-only + `owner_attested` CHECKs, NO account_id (§3.2), NO
  user FK (§3.4 — 086's staff cascade must not reach it), RLS deny-all, UUIDv7;
  **094** `analytics_events.event_name` CHECK gains
  `solicitation_consent_recorded`/`_upgraded` (089's lesson — TS-allowlist-only
  registration rolls back every emitting tx); **095** business-leading index for
  compliance deletes (Codex finding — PG16 has no skip scan; 093's scope unique
  leads with channel).
- **Attestation v2** (`attestation.ts`): text names email sending, opt-outs,
  the sender-agent relationship; `SEND_ELIGIBLE_ATTESTATION_VERSIONS = [v2]` —
  v1 deliberately absent, which is the tautology kill.
- **Ingest** (`ingest.ts`): `upsertConsent` — §4.2 guarded monotone upsert
  (`WHERE EXCLUDED.attested_at > attested_at`; replays are no-ops, in-flight v1
  jobs cannot downgrade v2), the ledger's ONLY writer, in the advisory-locked
  csv_ingest tx; `consentEligibleEmail` — §7.1 deletability guard, consent only
  for the resolved contact's RETAINED email (Codex HIGH: orphaned-PII fix);
  events idempotent on `event_key`, never carrying the handle.
- **Derivation** (`batch-builder.ts`/`restraint-policy.ts`): ledger lookup with
  `no_consent` case (a) no-row / case (b) ineligible-version evidence;
  `RESTRAINT_POLICY_VERSION` → `.3`. Legacy cohort reads case (a) — **no
  backfill by decision**; #629's case-(a) copy must be self-sufficient.
- **Compliance deletes**: contact hard-delete sweeps consent by handle in-tx
  (`contacts-repo.ts`); offboarding purge got an explicit
  `deleteByBusiness('solicitation_consent')` sweep — **spec §7.2's cascade
  assumption was WRONG** (businesses are tombstoned on purge; corrected in the
  spec at ship) — plus `TABLE_DISPOSITIONS`/`TENANT_TABLES`/rls-inventory rows.
- **Staging proof** (evidence on PR #640): 14-point smoke — attestation
  blocking, v2 rows minted with visits deduping (§1.2 remedy), DR3 phone-only
  zero rows, 40-contact legacy cohort withholding no_consent, seeded-v1 case
  (b), one genuine v1→v2 `upgraded` event, monotone same-version bumps with
  zero event churn, in-tx delete sweep.
- **Ship-lane fixes** (post-review, re-gated): `consentEligibleEmail` extracted
  to clear fallow's changed-code cognitive threshold (house precedent: extract
  new logic, waivers are for pre-existing complexity); 5000-contact suite body
  timeout 90s→180s (parallel-gate contention, completing the earlier
  hook-timeout fix).
- **Gotchas promoted to lab notes (2026-08-01)**: event-name CHECK pairing;
  abandoned-not-cancelled vitest timeouts poisoning following tests; "a new
  table/event is never wiring-only — budget the registry ripples."

**Deviations**: 7 entries, all ACCEPT (5 owner-approved surface amendments;
~2500 actual vs ~1200 estimated diff — lane already heaviest). **Merge order
honored: #625 before #628** — feat-628 must rebase over main before its
gate/review rounds. #630 owns spec §10 test 7 +
`solicitation_consent_missing_at_dispatch`.

---

## 2026-08-01 → 2026-08-03 — Suppression ledger #643 (send-mode map #617; split from #626) — PR #647

Ticket #643, "Suppression ledger: schema + domain core". Locked spec
`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md`; plan
`docs/superpowers/plans/2026-08-01-suppression-ledger-core.md` (G1–G14 decision
table). Merged as squash `4186cefa`. RISK=high lane: staging ride, then PR.

**Migrations 096 + 097 — staging 2026-08-02, production 2026-08-03, lockstep
complete.** Verified by schema introspection in both environments (never the
Supabase migration ledger, which does not track RepWorth's `0xx` migrations), then
the two introspection outputs were **diffed field-by-field and came back
identical** — that diff is the lockstep evidence, not the fact that both `psql`
runs exited 0. Prod schema was applied deliberately **before** the merge:
`loadCandidateWindow`'s LATERAL join and the purge stages both reference these
tables, so code deploying ahead of schema would have failed.

**What shipped**

- **096** — `solicitation_suppressions` (keyed on normalized handle per channel,
  never `contact_id`, so delete-and-re-upload cannot launder an opt-out) and
  `solicitation_unsubscribe_tokens` (dedicated table, not a column on the ask, so
  redemption survives the sender). Two partial unique indexes; two account-leading
  indexes (PG16 has no skip scan — migration 095's lesson applied up front); the
  G11 source/scope CHECK pairing; G12's one-way provenance-scrub implication; a
  `token_hash` SHA-256-hex format CHECK; RLS enabled with **zero** policies.
- **097** — analytics event-name CHECK swap for `solicitation_suppressed` and
  `solicitation_suppressed_at_dispatch`. Its own file, not folded into 096, because
  the swap takes a brief ACCESS EXCLUSIVE lock on `analytics_events`.
- **`src/lib/solicitation/suppression.ts`** — closed `as const` enums, the
  `suppressionMatchSql` fragment that solely owns the §1.2 lookup (global wins a
  double match), and first-write-wins `recordSuppression`.
- **Purge retention** — global rows survive with `account_id` intact, account rows
  hard-delete, token provenance scrubbed to NULL while the mechanism is kept; the
  receipt reports the retained global count in aggregate.
- **Populate, do not pre-filter** — the batch build stamps `candidate.suppression`
  and `evaluateAsk` owns the withhold, so the shipped `suppressed` gate is never
  dead code.

**Deliberately callerless.** `recordSuppression` ships with zero production callers
(G6) so its byte-for-byte `ON CONFLICT` predicates are proven against the real
partial indexes the moment those indexes exist. #644/#645/#627 supply the first
writers. Zero rows and zero `solicitation_suppressed` events is the expected steady
state, not a failure signal.

**Review — two rounds, 7 findings fixed.** Step 6 adversarial (Codex):
`needs-attention`, one [high] — `token_hash` was `TEXT NOT NULL UNIQUE` with a
comment claiming invariant #5 and nothing enforcing it. Fixed with a named format
CHECK mirroring migration 056, plus a 6-case rejection matrix, **mutation-verified**
(remove the CHECK → 6 of 7 new assertions fail). Step 7 dual review, two fresh
parallel agents: spec & correctness 3 low (37/37 paths in-surface, 19/19 promised
tests verbatim, 13/13 edge cases); standards & maintainability 3 medium + 3 low.
**6 accepted and fixed, 3 rejected with recorded reasoning.** The two that mattered:
`suppressionMatchSql` hardcoded `channel = 'email'` while `recordSuppression`
parameterized it — two owners for one dimension, failing **open** — now a required
parameter on both sides; and the token scrub's `OR business_id IN (…)` made the
account-leading index unusable on the one statement 096 added it for and was
redundant under G12, so it was dropped from the scrub while **kept in the verifier**
as the cross-account tripwire. That second fix also handed back two tenant-scope
allowlist entries: `ALLOWLIST_BASELINE` walked 410 → 413 → **411**, net +1.

**Staging smoke** (rolled-back transaction, zero residue): first-write-wins proved
`ON CONFLICT` inference against the real partial index (`INSERT 0 0` on the
duplicate), the LATERAL lookup returned the global row, G11 rejected
`owner_manual + global`, the `token_hash` CHECK rejected a raw token, and a real
digest was accepted.

**Deviations**: 33 entries at step 6.5, all ACCEPT, 0 RE-PLAN; 9 more added across
steps 6–7. `reclassify` fired at 2.94× and was adjudicated an **estimate error, not
a lane error** — production code landed at 435 lines across exactly the files the
plan named, with 1,537 of the counted lines being workflow artifacts. Two intake
amendments spent (2 of 2, budget exhausted): the tenant-scope allowlist during
planning, and two `tests_to_add` titles at step 7 that named `isSuppressed`, a
helper CONTEXT.md's G7 forbids by name.

**Carried forward**: the prod Railway worker has **never been deployed**
(`repworth-worker`/`production` reports no deployments, 35 env vars set) — so prod
here means schema + Vercel, not a running worker. Also: the RISK=high staging ride
makes the post-merge `git merge --ff-only main` structurally impossible, since
`main` gets a squash and `staging` a real merge; reconciling needed a
verified-identical-trees `reset --hard` + `--force-with-lease`.

---

## 2026-08-03 — Unsubscribe opt-out path #644 (send-mode map #617; the Suppression ledger's first writer) — PR #654

**No migration.** 096 created both tables and 097 registered the analytics event
names; this ticket added neither. No dependency added. Merged as `f937f462`.

### What shipped

Two entry points, one outcome. `POST /ingress/unsubscribe/:token` on the Railway
worker is the RFC 8058 one-click route (`source='unsubscribe_one_click'`);
`/u/<token>` on Vercel is the human landing path (`source='unsubscribe_link'`).
Both write one `scope='global'` row to `solicitation_suppressions`.

| File | Role |
|---|---|
| `src/lib/solicitation/unsubscribe.ts` (+612) | Token mint/gate/hash, claim-first redemption, Success receipt, `assertUnsubscribeTokenSecretConfigured` |
| `worker/ingress/unsubscribe.ts` (+532) | One-click route, both hook arms, 60s unknown-token aggregate + shutdown flush, `assertUnsubscribeIngressConfigured` |
| `worker/ingress/rate-limit.ts` (+70/−) | Both ingress-scope arms, `skipIngressRateLimit` context-config augmentation |
| `worker/config/fastify-options.ts` (+83/−) | Request serializer + prose-safe censor (`redactSensitiveTokenPaths`) |
| `src/app/(public)/u/[token]/page.tsx` (+185) | Button / success / Neutral render states |
| `src/app/api/u/[token]/route.ts` (+66) | Form POST → 303 + receipt mint |
| `src/lib/shared/sentry-scrub.ts` (+93/−) | Generalised path redaction incl. encoded spellings |
| `src/lib/config/server.ts` (+25) | `SESSION_COOKIE_SECRET_PREVIOUS`, `SOLICITATION_UNSUBSCRIBE_MAILTO` |
| `src/app/robots.ts` (+4) | `/u/` disallowed |

Tests: ~3,500 lines across 8 suites, including a 742-line live-DB integration
suite (20 tests: concurrent redemptions, a mint landing *inside* the race window,
concurrent purge, correction-path replay) and a **real-socket** rate-limit test.

### Decisions that shaped it

- **Claim first, then suppress.** One `UPDATE … RETURNING account_id,
  normalized_handle, channel` is the write-ordering primitive; `recordSuppression`
  is fed from the provenance it locked. `business_id` is deliberately **not**
  returned — the ledger has no field for it and G12 makes it redundant for the
  null case. The reverse order lets a replayed spent link undo an audited
  Correction path removal.
- **A spent token is not proof of a live suppression.** The spent branch reads the
  ledger explicitly against a *global-only* existence query — not
  `suppressionMatchSql`, which answers a different question and would be satisfied
  by an `account`-scoped row that makes the success sentence false.
- **Receipt necessary, never sufficient.** Success renders only on a verifying
  HMAC **and** a live global row read during that render. Three adversarial
  findings, one root cause: asserting a fact about mutable state from evidence
  decoupled in time from it.
- **Honest failure.** Unknown token → `503`, not a success-shaped no-op, so a #630
  mint race is recoverable by provider retry. Deliberately **no Sentry event** —
  the route is unauthenticated and unrate-limited; telemetry is a replica-tagged
  windowed aggregate instead.
- **Self-authenticating tokens (§1.4a).** A forged token opens **no DB connection**
  on either surface. Current-plus-previous key verification makes a
  `SESSION_COOKIE_SECRET` rollover survivable for the statutory ≥30-day window.

### Two live production bypasses closed as side effects

Both pre-existing, both affecting Stripe, Resend, Telegram, Twilio and Zernio:

1. **Percent-encoded ingress paths** — the limiter gated on raw
   `request.url.startsWith('/ingress/')`, so `/%69ngress/resend` resolved to the
   real route while escaping the limiter.
2. **Absolute-form request targets** (RFC 9112 §3.2.2) — `find-my-way` strips
   scheme+authority so the route resolves, while `request.url` stays absolute,
   defeating the decoded arm. **Invisible to the entire test suite** because
   `app.inject()` normalises the target; found only via a raw-socket test.

### Gotchas worth keeping

- `createWorkerLogger`'s **object** args pass through the analytics blocked-key
  sanitizer, which drops any key containing `token` — `token_hash_prefix` would
  have vanished silently. Renamed `hash_prefix`. (lab-notes 2026-08-03)
- `app.inject()` normalises the request target, so an inject-only suite is
  structurally blind to the raw request line. A surviving mutant there means dead
  logic **or** a harness blind spot. (lab-notes 2026-08-03)
- `feature-cleanup.sh` derives `MAIN_ROOT` from its cwd, so run from inside a
  feature worktree it skips that worktree and cleans nothing while exiting 0.
- The post-merge sweep does **not** require the main checkout, contradicting
  #643's note: park `.feature/intake.json` and branch the shipping worktree off
  `origin/main` (same checkout satisfies containment, no intake satisfies arming).

### Staging proof

Full stack, `SOLICITATION_SEND_ENABLED` **off** throughout (DR1 says every one of
these must work anyway). Unknown token → `503`; `GET`/`HEAD` → `302`; unmatched
sub-path → `404`; button page renders the generic fallback for NULL provenance;
form POST → `303` with a **relative** Location and `cache-control: no-store`;
success page renders only with a valid receipt **and** a live row; four forged
receipts (incl. a future-dated HMAC and a single flipped MAC character) all render
the Neutral page; two spent-token ingress POSTs return `200` and write **nothing**,
leaving `source='unsubscribe_link'` intact — first-write-wins proven on real
infrastructure. Test rows deleted afterwards.

### Deployment posture

`SESSION_COOKIE_SECRET` is now **boot-asserted on deployed worker lanes** — a
deployed worker without it crash-loops, deliberately, replacing a silent statutory
failure where every well-formed opt-out `503`'d indistinguishably from a genuine
unknown token. Staging: set. **Railway prod: deliberately unset** until the
Solicitation agent ships — safe because that worker is `Offline — never
successfully deployed`, so the gate has nothing to crash-loop; but
`RAILWAY_ENVIRONMENT_NAME=production` means it binds from that worker's **first
boot**, so setting it is a precondition of that deploy, not of any merge
(deviations D13). Vercel has no boot phase and throws per-request instead; it is
set on prod, which is the lane that went live at merge.

**Carried forward**: `SOLICITATION_UNSUBSCRIBE_MAILTO` is unset by choice — the
Neutral page omits the line rather than advertising an unserviced address, and
setting it creates a §7.2 daily business-day servicing obligation. Follow-ups
**#651** (dedicated bounded DB pool for redemption) and **#652**
(`redeemUnsubscribeToken` takes `Sql` and owns its transaction) are filed with
full context. The staging-reconcile item carried from #643 **recurred exactly as
predicted** — `staging` ended 61 ahead / 1 behind and needed `reset --hard
origin/main` + `--force-with-lease`.

---

## 2026-08-05 — Manual suppression paths #645 (send-mode map #617) — PR #659

Migration **098** `solicitation_suppression_corrections`, applied **staging
2026-08-04 / production 2026-08-05** in lockstep. Follow-up bookkeeping PR #661.
Wayfinder map #617. Spec §7 + §8.2 of
`docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md`.

### What shipped

- **Admin manual entry (§7.3)** — `POST /api/admin/suppressions`, AAL2-gated.
  `scope='global'` / `source='admin_manual'`, `account_id` deliberately NULL (a
  forwarded mailbox reply names no account and guessing one writes false
  provenance). Required note = the originating message reference. Re-entry is a
  **no-op success** per first-write-wins, rendered green, not as a failure.
- **The Correction path (§8.2)** — `POST /api/admin/suppressions/correct`. The
  admin-only audited removal of a factually-wrong row. Error correction, **never
  re-subscribe**: no owner or recipient entry point.
- **Lookup** — `POST /api/admin/suppressions/lookup`. A POST *for a read*: §9.5
  forbids logging the raw handle and a query string is logged by construction
  (access logs, log drains, browser history). Returns live rows **plus prior
  corrections**, so a re-entry after a correction is visible rather than a surprise.
- **Owner do-not-contact (§7.5/§7.6)** — `POST`/`DELETE
  /api/dashboard/contacts/[id]/suppression`. `scope='account'` /
  `owner_manual`. Mark and clear both confirm, with **distinct copy** in each
  direction.
- **§7.4 display seam** — `toSuppressionDisplay` returns a closed four-key
  object, so `account_id` and `source` cannot reach an owner surface.
- **`/admin/suppressions`** under the **Safety** nav group, AAL2 like
  `/admin/flagged`. Fetches nothing on load: there is deliberately no browsable
  list of every opted-out recipient — a cross-tenant liability with no use.

### Decisions that shaped it

- **The ticket said "no migration"; that was amended with owner sign-off.**
  §8.2's audit record has no existing sink that accepts an account-less row —
  `account_audit_log.account_id` is `NOT NULL REFERENCES accounts(id) ON DELETE
  CASCADE`, and both cases §8.2 exists to correct carry `account_id = NULL`. A
  CASCADE would additionally delete the compliance record along with the account
  it merely names as provenance.
- **Atomicity is structural, not conventional.** `correctSuppression` is ONE
  data-modifying CTE whose `DELETE … RETURNING` feeds the INSERT. Zero rows back
  = `not_found`: nothing deleted, no orphan record, no third outcome.
- **D-A11 reversed the original schema.** The plan had let detector-avoidance
  shape the table (`original_*` column names slip past
  `accountLinkedTablesFromMigrations()` on a word-boundary technicality). Two
  HIGH adversarial findings killed that: the record now carries the removed row's
  `account_id`, `created_by_user_id` and `note` under **honest names**, and the
  table is **classified** (`retain_compliance_limited_pii`) rather than renamed
  to evade classification. Naming data to dodge a governance check is worse than
  the gap it hides.
- **`reason` CHECK is `reason ~ '[^[:space:]]'`, not `length(btrim(reason)) > 0`**
  — one-argument `btrim` strips SPACES ONLY, so a tab- or newline-only reason
  passes it. The plan's own shape test caught this (D-A4).

### Gotchas worth keeping

Promoted to `lab-notes.md` under **2026-08-05**:

- **A legal refactor can blind a file-level `ci:*` security audit.** Extracting
  the routes' shared preamble into a `withAal2JsonBody` wrapper typechecked,
  passed every route test, and turned `ci:admin-aal2` RED on all three routes —
  that audit text-scans for `requireAdminWithAal2`. The gate now stays spelled
  out per route; only body parsing is shared.
- **`fallow` is a CI-only gate** — `verify-gate.sh` does not run it, so a fully
  green local gate does not predict it. And **local fallow invents findings**:
  without `--coverage` it estimates CRAP from export references and reported a
  HIGH the coverage-informed CI run did not have.
- **A design fact restated in a second place needs a grep for the fact.** The
  D-A11 resync swept the rows it edited; a stale claim ~1000 lines away in
  `docs/directory.md` survived two review rounds.

### Staging proof

Migration verified on both projects by **schema introspection**, not the Supabase
migration ledger. The shipped CTE was then exercised against live staging
Postgres — correct → `corrected`; replay → `not_found` with **no orphan**;
tab-only reason → CHECK aborts and **the suppression survives**. Then the full
browser ritual, **11/11**: admin entry → lookup → duplicate-entry → correction
confirm copy → correction + auto-re-read → blank-reason guard; owner mark →
§7.4 badge → clear with distinct copy → audit payload carrying the original
marker and **no handle** → a seeded `global` row making the clear control
**absent from the a11y tree**. Smoke data removed; staging left at 0 suppressions
/ 0 corrections / 43 contacts intact.

### Follow-ups

**#662** — two low-severity UI observations (stale entry receipt after a
correction; `REMOVED BY` rendered as a raw UUID). Deferred, still open: extract
`PRIMARY_BUTTON` into `src/components/admin/ui/` now that #658 has merged. The
staging-reconcile item recurred a **third** time (#647, #654, #659) and this
time in the inverse direction — `staging` held an *older* auth tree than `main`
after a second branch rode it mid-flight, so reconciling meant moving staging
forward.

---

## 2026-08-05 — importReview keystone #674 (consented review import map #667) — PR #682

### What shipped

`importReview` in `src/lib/reviews/process-review.ts` — the **Review import**
lane. Insert-only: stores a review as *inventory*, classifies sentiment at the
write site (`deterministic_star_v1`), writes **and completes** a
`review_ingested` run-spine record inside the insert transaction, enqueues **no**
`generate_response` (so it writes no `job_outbox` row on any path), and never
mutates an existing review row — both "row already existed" and "lost the insert
race" return `'unchanged'` with zero writes.

The shared new-review `INSERT` moved into a **private** `insertNewReviewRow`
seam, now used by both entry points. `startReviewRun` gained a `string | null`
return so the import can complete its own run; `processReview`'s two call sites
discard it, which is behaviour-neutral.

**No migration, no feature flag, zero callers** — inert on merge; the caller is
#675. One new file: `src/lib/reviews/__tests__/import-review.integration.test.ts`.

### Decisions that shaped it

- **A separate entry point, not a `skipGeneration` flag.** `importReview`
  structurally cannot reach `processExistingReview`, so "no behaviour change for
  existing callers" is a property of the code rather than a claim tests defend.
- **No `SELECT … FOR UPDATE` probe.** An existing row means zero writes, so the
  INSERT's `ON CONFLICT` is the whole decision; taking no lock keeps a 100-review
  import from contending with live-ingest work.
- **The run completes in the insert transaction (D3).** No downstream worker
  would ever complete it, so it would read as `stalled` after 48h. The
  counter-argument — that a never-handled review then reports `completed` — is
  real, was raised in branch review, and is owner-decided as ship-as-is (D16).
- **`first_review_ingested` fires from the import**, sharing
  `maybeEnqueueFirstReviewIngested` with the live lane.

### Gotchas worth keeping

Promoted to `lab-notes.md` under "2026-08-05":

- A hazard described too narrowly is worse than one not described at all — the
  deferred lost-draft hazard was written as a *race* when it needs no
  concurrency, and a correction must reach **every** copy (the plan embeds the
  implementation code).
- `describeWithDb` does **not** assert schema, and asserting what a suite *reads*
  is not enough — assert what the code under test **writes**.
- Plan-embedded code is unlinted, untypechecked and unexecuted until a subagent
  runs it, yet is then executed nearly verbatim.

### Staging proof

Rode `staging` at `6c8cc892`: Railway deploy SUCCESS, health `HTTP 200`,
`[boot] readiness cure complete`, `ZernioRecentReviewPoller` registered clean.
Honest caveat recorded at the time — with no migration, flag or caller, the ride
proves the worker still boots and nothing more.

### Follow-ups

**#675 inherits three comments**: the CORRECTED lost-draft hazard (no race
required); imported reviews counting as unanswered in `MonthlyImpactWorker.ts:168`
and the `src/lib/kpi/*` response rate; and a later owner-generated response
opening a second run for the same review. **#667**: `CONTEXT.md` still has no
**Origin lane** entry, which the map's reuse note #2 cites and #678 depends on.
The staging-reconcile item recurred a **fourth** time (#647, #654, #659, #682).

---

## Consented Review Import — schema (#673, migrations 100+101, PRs #685/#686, 2026-08-05)

**Why:** epic map #667's schema keystone — the per-location import-offer state
and the ADD half of the locked backfill-counter collapse, so #675 (selection),
#676 (consent gate), #677 (decision API) and #679 (expiry) have columns to
build on. Design of record: ADR 0015 + spec
`2026-08-05-consented-review-import-design.md` §4, §8a R1/R3/R4.

**What was done:**

1. **Migration 100** (additive-only) — `businesses.import_decision` TEXT
   `NOT NULL DEFAULT 'pending'` under the named CHECK, nullable
   `import_decision_at` / `import_offer_expires_at` TIMESTAMPTZ; on
   `zernio_backfill_runs`, collapsed `imported_count` / `skipped_count`
   INTEGER `NOT NULL DEFAULT 0` beside the four legacy counters (DROP is
   #680's, so any epic revert stays safe — §8a R4). No cross-column CHECK,
   no index — #677/#679 own those semantics.
2. **`ZernioBackfillWorker` dual-write** — one UPDATE writes both counter
   sets (`imported = gap + historical processed`, `skipped = gap + historical
   skipped`); tenant-scope allowlist re-pinned. Contract (adversarial-review
   amendment D7): the legacy writer contract ends at **#675**; #680's DROP
   requires a reconciliation preflight on pre-#675 rows.
3. **Migration 101** (same-day correction) — 100 shipped the CHECK
   four-valued (`…|expired`) from an intake locked ~17 minutes before #670's
   amendment (three-valued, expiry derived on read) hit ticket #673; every
   review round validates against the intake, so the drift surfaced only at
   promotion. 101 tightened the CHECK to `pending|accepted|declined`, rewrote
   both COMMENTs, and re-pinned the shape suite. Root-cause lesson promoted
   to lab-notes ("an intake is a snapshot").
4. **Shape suite** `migration-100-import-consent.integration.test.ts` — 4
   tests: catalog defaults + full-definition CHECK equality, cross-column
   absence by `pg_constraint` introspection, counters beside the legacy four,
   and an additive-only allowlist over 100's executable SQL. Schema-ready
   entry `MIGRATION_100_IMPORT_CONSENT`.
5. **Both environments in lockstep** — each migration applied staging-first,
   prod immediately before its PR merged, verified by
   `information_schema`/`pg_get_constraintdef` introspection (never
   `list_migrations`). Deviations D1–D8 triaged in the plans folder; D8: the
   §8a R3 "zero rows" premise was stale by hours at staging apply (2 smoke
   rows, both correctly `pending`) — second lab-notes lesson.

### Follow-ups

**#675 is UNBLOCKED** (#674 merged, #673 shipped) and is the next ticket;
**#679** likewise (blocked by #673 only). #677 → #676 → #678 → #680 stay
sequenced. The **F3 constraint** (archive→re-add can reset consent state)
sits on #676/#677. The staging-reconcile item hit its **fifth** occurrence
(#685) — feature.md step 8 still says "fast-forward"; entropy counter at
**6, threshold reached**, an architecture pass is due.

---

## Consented Review Import — selection (#675, PR #689, no migration, 2026-08-06)

`ZernioBackfillWorker` rewritten from the auto-drafting 50-cap backfill into the
consented Review import executor (spec §6.1; design
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md`, plan
`docs/superpowers/plans/2026-08-05-feat-675-consented-import-selection.md`).
Squash commit `3219bf02`; branch commits `28bc7ecc..d2a0d221` (13); ~2,760
insertions across 21 files, ~4:1 test:prod.

### What shipped

1. **Glossary first** (T1): **Import window** (`createTime ∈ [now − 12 months,
   live-ingest cutoff)`) and **Live-ingest cutoff** (`connected_at −
   ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS`, default 5 min) coined in
   `CONTEXT.md`; 30 promised-test stubs landed before any implementation.
2. **`liveIngestCutoff` seam** (T2): single owner in `zernio-ingest-shared.ts`;
   `ZernioRecentReviewPoller` delegates (`isRecentForConnection`, ≥ cutoff),
   the import consumes it as the window's upper bound (< cutoff). Null
   `connected_at` → null cutoff; poller owns nothing, import unbounded above.
   Grace complementarity is promised-tested on both sides.
3. **`selectImportWindow`** (T3): pure selection — in-window filter, defensive
   newest-first re-sort (Zernio ordering is verified but undocumented), take
   100, `capOverflow` seeds `skipped_count`, `oldestSkippedCreateTime` by epoch
   comparison (never lexicographic RFC3339). Property-tested.
4. **`consentedImport` option** (T4): `reconcileExternallyAnsweredReview`
   imports answered rows unconditionally in the consented lane (flag-independent);
   branch 3 gained the consented tail — after superseding stale drafts, the
   external reply is stored unless one of the active responses was OUR OWN
   posted reply (`protectedIds`), which would duplicate it.
5. **The executor** (T5): pages `listReviews` (pageSize 50) up to
   `ZERNIO_IMPORT_MAX_PAGES` (default 6, new env var), dedupes by review id
   across page boundaries, early-stops on target-met or floor-passed ONLY while
   ordering is clean; a non-descending page disables both early stops for the
   run (dirty mode pages to feed end or cap). Unanswered → `importReview`
   (draft-free since #674); answered → reconcile; PHI-matched unanswered →
   exception row + skip. Cap exhausted with `nextPageToken` set and <100
   in-window → **terminal** `ZernioImportPaginationCapExhaustedError`
   (markOutboxFailed + Sentry; `completed_at` NULL keeps the run claimable
   after an ops cap bump). Collapsed counters only; the four legacy
   `gap_*`/`historical_*` freeze at DEFAULT 0 (#680 drops them — *since done:
   migration 103, 2026-08-08, both projects*).
6. **Docs truth-up** (T6): the importReview KNOWN HAZARD paragraph rewritten —
   the lost-draft hazard is resolved by disjoint lane ownership, not by a guard.

### Decisions that shaped it

- **Dirty-ordering cap-out with ≥100 candidates proceeds best-effort** (locked
  intake edge case; codex holds it should be terminal — recorded disagreement,
  owner merged without overruling; both positions in
  `docs/reviews/feat-675-consented-import-selection/adversarial-codex-r1.md` §3).
- **Cap exhaustion is TERMINAL worker-side, not thrown** (D1): the backfill
  queue has no failed-hook; BullMQ retries would refetch identical pages.
- **Out-of-window reviews are not "skipped"** — `skipped_count` counts cap
  overflow + PHI/malformed only; the window is selection, not skipping.
- **Release sequencing**: this branch alone is strictly safer than the status
  quo (nothing drafted, nothing posted, zero outbox writes), but **#679's
  fail-closed `import_decision='accepted'` pre-flight must land before real
  customers**; enqueue gates are #676. Prod has zero customers (ADR 0015 R1).

### Reviews & deviations

Plan: 3 codex rounds → APPROVED. Branch: standards r1 (5 accepted, fixed
`7bbc0224`), spec-correctness r1 PASS, adversarial codex r1 (3 HIGHs, all
rejected with verification — two carried to the PR as the sequencing note +
recorded disagreement), standards r2 verification CLEAN. Deviations D1–D14
all ACCEPT, no RE-PLAN; D12 consumed surface amendment #1
(`scripts/ci/tenant-scope-allowlist.ts`). **D14** post-open: the CI fallow
new-findings gate went red (unconsumed export, the mirrored PHI-gate clone,
arrow complexity) — remediated in `d2a0d221` (de-export;
`phiGateAndImportExternalReply` extraction, log strings byte-identical; arrow
22→20 cyclomatic), lab-notes lesson recorded.

### Staging proof

Two runs on the reused test location (deploys `da602877`, `d2a0d221` —
identical results): `Import complete … imported=29 skipped=0 pages=4
window=[2025-08-06…, 2026-08-06T00:36:14.101Z)` with cutoff exactly
`connected_at − 5 min`; fresh run row with collapsed counters set and all four
legacy counters 0; zero `generate_response` / `send_notification` / other
outbox writes; 66 list rows, the 16 externally-answered as `posted` responses.
The dirty-ordering lane fired live (sandbox pages are non-descending in
practice) and proceeded best-effort as specified.

### Follow-ups

**#679 next** (fail-closed pre-flight — release constraint), then #677 → #676
→ #678 → #680 (drops the frozen legacy counters). Recorded, not scheduled: F3
`ZernioBackfillWorker.test.ts` split (2,100+ lines), F2 pagination-collector
extraction ONLY if a second caller appears, pre-#675 helper shadows in the
poller suite. Entropy counter now **7 — the architecture pass due since 6 is
still owed.**

---

## Consented Review Import — the offer (#677, PR #691, no migration, 2026-08-07)

Closes #677, **absorbs #676**. Map #667. Merge order was and remains
**#677 → #679 → #676(absorbed)**. Merged `fc2437ae`; 27 files,
**+5,384 / −238** (1,540 production / 3,846 test).

### What shipped

#673 built the consent columns (migrations 100+101), #674 made `importReview`
draft-free, #675 made selection consented and bounded. #677 ships the part that
lets an owner actually say yes.

**New modules**

- `src/lib/reviews/import-consent.ts` — the single owner of spec §5.3's
  derived-expiry predicate and of every write to it: `importConsentStateSql`
  (composable fragment, **no interpolation — callers alias `businesses` as
  `b`**), `readImportConsent`, `createImportOffer`, `recordImportDecisionAndEnqueue`,
  and the one shared `enqueueInitialImport`.
- `src/lib/reviews/import-offer-view.ts` — `readImportOfferView` → discriminated
  union `none / offer / importing / imported / empty / failed`. `completed_at`
  decides done, never `imported_count`. Run rows scoped to `run_reason='initial'`.

**Route + UI**

- `src/app/api/dashboard/import-offer/route.ts` — GET (state + self-heal),
  POST (accept | decline, `withSameOrigin`, zod-validated). Four outcomes map to
  200 / 409 / 409 / 404 so the banner can distinguish "too late" from "recorded"
  without inspecting a body field.
- `ImportOfferBanner.tsx` + `DashboardContent.tsx` mount. Polls only while
  `importing`; advances only on a successful POST, never optimistically; query
  key includes the scoped `locationId`.

**All four enqueue producers gated** on `accepted` under the `businesses` row
lock: connect finalize, Stripe activation resume, reactivation catch-up, and the
decision route.

### Decisions

1. **Offer created at the junction, in-transaction** — not lazily on render.
   `createImportOffer` proves both junction halves in its own SQL.
2. **Deadline is `now() + 7 days` at creation; no junction anchor.** Anchoring
   was self-invented, cost two High findings across two review rounds, deleted
   by owner adjudication 2026-08-06.
3. **`import_offer_expires_at IS NOT NULL` is load-bearing** — migration 100's
   `pending` + NULL default is deliberately not an offer (round-1 Critical).
4. **The GET writes, deliberately** — an idempotent self-heal behind two cheap
   gates (is there any offer to create; may this owner be written for). This is
   what makes best-effort offer creation on the Stripe path acceptable.
5. **Inheritance copies a past deadline, never a live one** (D12) — the
   first-choice phrasing would have invalidated a locked `user_visible_behavior`
   term and tripped the abort criteria.

### Three bugs review caught that tests did not

- **A4** — three diverged copies of the enqueue guard, none matching the view's.
  A completed *reactivation* run permanently suppressed the one-time initial
  import while the banner, correctly scoped to `initial`, reported `importing`
  forever on a 4s poll. Consolidated into one `enqueueInitialImport`, which also
  hands #679 one chokepoint instead of three.
- **A1** — a read-only GET minting 7-day offers for past-due owners, permanently
  consuming a one-time offer they could never answer.
- **A5** — every location took an exclusive row lock and ran a provably no-op
  UPDATE on every dashboard mount and every 4s poll tick.

### Plan defects found during execution

- **D7** — the analytics events were impossible as specified: extending the
  `analytics_events.event_name` CHECK needs a migration the intake's own
  non-goals forbid. Moved to #679; `src/lib/analytics/events.ts` was **removed**
  from the surface so the guard enforces the deferral.
- **D9** — `importConsentStateSql`'s published signature was unimplementable
  against the repo's hand-rolled `sql` mocks; and `ci:tenant-scope` cannot see
  predicates inside subqueries, which reshaped three queries to bind tenant keys
  at the top level (allowlist baseline **420 → 418**, a net shrink).
- **D11** — the recorded `ci:outbox-seam` blocker was **false**; the audit
  derives helper coverage only from `job-outbox-helpers.ts`.

### Process

Three plan-review rounds, all `REVISE`. Three review axes (spec / standards /
Codex adversarial): 10 findings accepted and fixed across four parallel batches,
5 rejected with reasoning, 3 escalated to owner decision. Surface amendments
**1 of 2**. Gate-fail recovery rounds **2 of 3** (the second was the fallow fix).

### Staging proof (2026-08-07)

Full loop walked in-browser as the owner on `Tanicia Resort`
(`019fd299…`), staging at `685226d4`:

- GET self-healed a missing offer — deadline written `now()+7d` at page load.
- The junction predicate **discriminated between two same-named businesses**:
  only the one with an active connection got a deadline.
- Accept committed `accepted` with the deadline preserved; the first accept
  enqueued **nothing**, because a completed `initial` run from #675's staging
  work already existed (the F101/A4 guard working as designed).
- Clearing that run's `completed_at` produced the fresh enqueue
  (`backfill_reason:'initial'` explicit) → `dispatched` in ~3s → `importing`
  banner → `Import complete … imported=29 skipped=0 pages=4` with a
  `correlation_id` matching the outbox payload exactly.
- Insert-only held under a genuine re-run: every external reply hit
  `ON CONFLICT`, `reviews` stayed at 66. Zero console errors.

### CI

`fallow` failed on first open (unused type export + a 9-line clone) — the third
consecutive occurrence of the fallow-outside-the-local-gate class. Fixed
in-surface: de-exported `ImportDecisionRejection`, and extracted a module-private
`resolveScopeOrResponse` justified by the route's own two handlers, which
dissolved the cross-file clone without touching the out-of-surface partner.
Staging was re-ridden so it carried exactly what merged. Final: **15/15 green**.

### Deliberately left

- `src/lib/shared/worker-types.ts:226-227` stale `needs_backfill` JSDoc (D13) —
  outside surface, handed to #679.
- `ImportOfferBanner` shares stagger index `section-enter-2` with the hero band;
  `console.css` defines only `-1…6` and all six are claimed. Cosmetic.

## Consented Review Import — the worker guard (#679, PR #698, migration 102, 2026-08-08)

Closes the last consent hole in map #667 — the gap ADR 0015 §3 accepted
explicitly while production holds zero customers, and the release constraint
both #675 and #677 carried forward. Enforcement was at the four **product**
enqueue producers; now the worker itself refuses to run without consent, so the
admin / hand-inserted / future-forgotten-producer path is covered at the one
chokepoint they all converge on.

### What shipped

- `worker/jobs/zernio/job-eligibility.ts` — new `guardImportConsent`, run by
  `ZernioBackfillWorker` **before** `guardZernioJobEligibility` and before the
  run-row INSERT. Proceeds only on `accepted`; `pending`, `declined`, derived
  `expired`, and a missing `businesses` row each log
  `import consent blocked — skipping backfill` with a structured `reason` and
  complete the outbox row.
- `src/lib/reviews/import-consent.ts` — the two analytics emissions, in the
  writers rather than at the call sites (`createImportOffer` has three
  producers; emitting at each would repeat the key, the properties and the
  only-when-written condition three times).
- `supabase/migrations/102_import_consent_analytics_events.sql` — extends the
  `analytics_events.event_name` CHECK with `import_offer_created` +
  `import_decision_recorded`. Applied **staging then production, 2026-08-08**,
  both before the emitting code went live.
- `src/app/admin/runbook/page.tsx` — A5 re-enqueue now conditioned on
  `import_decision = 'accepted'` AND no completed initial run, and states that
  declined/expired is permanent. Without that edit the runbook told ops to do
  something that now silently no-ops.
- `src/lib/shared/worker-types.ts` — `ZernioInitialBackfillPayload` JSDoc had
  named two producers since #677; corrected to all four (D13, handed over from
  #677's "deliberately left").

### Decisions

- **Separate function, not a `jobKind === 'backfill'` branch.** A merged guard
  would have two callers, one of which must never reach consent code. Splitting
  makes live-ingest independence structural, not a runtime branch.
- **The guard's body is one transaction, and that is correctness.** Without
  `sql.begin` + `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)` (the guard's
  writer since #695 is `markOutboxCompletedWithReason(tx, …)` — same transaction,
  now also stamping the block reason), the guard
  can read `pending` from an in-flight row while the owner accepts; the
  acceptance's in-flight dedup then inserts no replacement and the guard
  completes the row. Result: `accepted`, no completed run, no runnable outbox
  row — silent permanent data loss for a customer who said yes, violating spec
  §5.1 retryability. `FOR UPDATE` is a no-op outside `sql.begin()` under
  transaction pooling, so both halves are load-bearing. Lock order stays
  business-before-outbox, matching all four other writers; `OutboxPoller` takes
  only `job_outbox` with `SKIP LOCKED` and cannot deadlock against it.
- **Expiry stays derived in Postgres** via the imported `importConsentStateSql`
  fragment — hence the mandatory `b` alias. A JS-side branch would be a second
  spelling of the predicate and would truncate microseconds.
- **Skip-as-success everywhere.** Completed, never failed or retried, so a
  declined import cannot churn the queue forever.
- **Emissions are savepoint-wrapped.** Corrected at review round 2: an unapplied
  102 was originally assumed to cost "the metric", but `createImportOffer` runs
  inside `finalizeConnectionTx` and `select-location/route.ts` rethrows
  non-`23505` — so it broke GBP connect entirely. The savepoint contains that
  blast radius without making the deploy ordering optional.

### The through-line: false coverage, three rounds running

Three review rounds, 20 findings, all triaged (r1 REVISE×3 → 13 findings;
r2 REVISE×3 → 4; r3 spec APPROVED / adversarial APPROVED / standards REVISE → 5).
The dominant defect mode was **tests that pass whether or not the bug exists**,
and it recurred *inside its own fixes* twice:

- Round 1 found five instances. Every one was caught by mutation, none by reading.
- Round 2's decisive finding: the savepoint — the fix for the branch's worst
  defect — shipped unpinned. Deleting it left all 37 live-DB and 42 unit tests green.
- Round 3's decisive finding: the catch narrowing — round 2's own fix — shipped
  unpinned too. Both failure tests injected `23514`, which carries a string
  `code` and is swallowed either way, so deleting the guard left every suite green.

### Two things not to re-derive

- **The narrowing is correct and verified against driver source.** Every
  reachable error class carries a string `code` — `PostgresError`, `57014`,
  postgres.js `CONNECTION_*`, Node `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`. Do NOT
  "improve" it to `instanceof postgres.PostgresError`: the standards axis
  recommended exactly that, and the driver taxonomy shows it would rethrow a
  transient blip straight into `finalizeConnectionTx` and reintroduce a connect
  outage. A lost connection independently rejects the enclosing `begin`, so
  swallowing it locally cannot manufacture a quiet success.
- **A JS throw does not poison a Postgres transaction** — abort injections must
  be Postgres-side. One deliberate exception: the code-less test injects a JS
  `TypeError` on purpose, because it asserts the rethrow *propagates* rather
  than that the caller survives.

### Staging proof (2026-08-08)

`staging` at `0dad901f`; Railway worker `1afb4e96` SUCCESS, Vercel
`dpl_Gz27sWSAyE6emC9LvJXMLhQwQjRN` READY. Migration 102 applied to
`kubdiqdhqbhwmqfditeg` **before** the push and verified by schema introspection,
never the ledger — plus a live probe inside a deliberately-aborted `DO` block
(bogus `event_name` → `check_violation`, both new names accepted, zero residue
after rollback).

- Four block reasons each proven against a real hand-inserted row: `pending`,
  `missing`, derived `expired`, `declined`. Every one completed its outbox row
  (1 attempt, `last_error` NULL) and minted **zero** `zernio_backfill_runs` rows
  and **zero** reviews.
- `accepted` still imports: `Import complete … imported=29 skipped=0 pages=4
  window=[2025-08-08…, 2026-08-06…)`, outbox completed, still exactly one run
  row — re-entered idempotently after clearing `completed_at`.
- Both analytics events landed through their real writers:
  `import_offer_created` (`{"window_days":7}`) from the dashboard GET self-heal,
  `import_decision_recorded` (`{"decision":"accepted"}`) from the owner
  answering the banner. Business-scoped keys, correct `account_id`/`business_id`.
- Accepting enqueued **nothing** — a completed `initial` run already existed, so
  `enqueueInitialImport`'s `run_reason='initial'` guard (F101/A4) correctly
  declined. Consent still committed: `import_decision_at` is byte-identical to
  the event's `created_at`, proving both landed in one transaction.

Assertion F had to be driven through a browser: `staging.repworth.net` sits
behind Vercel team-SSO **and** app auth, and both emission writers are Next.js
routes, so an anonymous request 302s to `vercel.com/sso-api`. There is no
headless path today.

### CI

15/15 green at `0dad901f`, re-run 14/14 green at `88279b68` after the handoff
commit. `fallow` passed first time — the first branch in four not to trip the
fallow-outside-the-local-gate class.

### Filed, not fixed here

- **#694** — `ci:live-db-suites` R2 DDL detector keys on an incidental marker and
  misses 2 pre-existing sites. `scripts/**` was out of surface.
- **#695** — enforce consent at the `job_outbox` insertion boundary instead of
  per-worker, and give the guard a durable policy-block reason. Both challenge
  decisions locked at #670.
- **#696** — `verify-gate.sh:193` truncates row slugs to 40 chars; colliding rows
  share a status file and can report PASS for a failed suite. Worked around here
  by renaming the extracted suite (D30).
- **#697** — a swallowed analytics emission reaches no durable or paged sink. The
  savepoint traded a loud failure for a quiet one; this is the missing half.

### Deliberately left

- Spec §5/§5.3 still say three enqueue producers; source has four (D8) —
  out of surface.
- `.claude/CLAUDE.md` cited a nonexistent "ADR 0015 R2" (the ADR has §§1–4; R2 is
  spec §8a) — corrected in this sweep.

---

## Verify-gate row identity (#696, PR #701, no migration, 2026-08-08)

Workflow tooling. No runtime code, no migration, no env var, no feature flag.
Filed out of #679's fix round as deviation D30 and fixed here.

### The defect

`scripts/verify-gate.sh` derived two dynamic row names by truncating a string to
40 characters:

```sh
SAFE=$(echo "$FILE" | tr -c 'a-zA-Z0-9' '-' | cut -c1-40)
```

A row's name is simultaneously three things: its slot in the `NAMES`/`RESULTS`
arrays that produce the PASS/FAIL table, its `.feature/logs/<name>.log`, and —
for integration rows — its `--coverage.reportsDirectory`. Two inputs sharing a
40-character prefix therefore shared all three.

`src/lib/reviews/__tests__/import-consent.integration.test.ts` is **exactly** 40
slug characters (`src-lib-reviews---tests---import-consent`), so every
`import-consent-*.integration.test.ts` sibling collided with it.

The observed symptom at #679 was a spurious `GATE: RED` — two vitest processes
racing one coverage directory to an `ENOENT`, while both suites passed 30/30 run
individually. #679 worked around it by renaming its extracted suite to
`import-offer-analytics.integration.test.ts` and recording the constraint in
that file's header.

**The reason it earned its own ticket is the other direction of the same race: a
shared status slot can record PASS for a suite that actually FAILED** — a silent
green in the check that is the mechanical backstop for a whole `/feature` run,
and therefore in every downstream claim resting on it.

The ticket named the integration row (`:193`). The `extra-${SAFE}` row for
`verification_commands` (`:167`) carried the identical truncation and is fixed
here too.

### What shipped

| File | Change |
|---|---|
| `scripts/gate-rows.sh` | **New, 68 lines.** `row_slug` — the readable 40-char prefix plus a 6-char hash of the full input; truncation is for reading, the hash is for identity. `assert_unique_row_name` — non-zero if a candidate name is already registered. Hash tool resolved once at source time (`shasum`, falling back to `sha1sum`). |
| `scripts/verify-gate.sh` | Both slug sites route through `row_slug`. `launch()` asserts uniqueness before registering; the rejected-destructive-extra path asserts its own (it registers via `NAMES+=` and never reaches `launch`), and `REJECTED_EXTRAS` became an array. `gate_abort()` extracted and shared with the db-provision failure path. |
| `scripts/ci/__tests__/gate-rows.test.ts` | **New, 183 lines, 10 tests.** |

Its own file rather than inlined: bash has no in-file unit-test seam, because
sourcing `verify-gate.sh` runs the gate. Precedent for the location —
`scripts/ci/__tests__/merge-coverage.test.ts` covers a script in `scripts/`.

### Review round 1 — 7 findings, 3 blocking, all accepted

Full report and triage table: `docs/reviews/fix-696-gate-row-slug-collision/`.
Each blocking finding is the ticket's own theme recurring inside its own fix.

1. **The fix violated its own locked invariant.** `gate-rows.sh` ran `exit 1` at
   **source** time when no hash tool was on PATH. A sourced file's `exit`
   terminates the caller — and it fired *above* the line defining `gate_abort`,
   so the gate died without writing `.feature/gate-status.json`, leaving the
   previous run's `{"passed":true}` for `.claude/hooks/stop-gate.sh` to read as
   this run's result. Fixed: `gate_abort` is defined before the `source`, the
   library never exits, the caller aborts on an unset `GATE_ROW_HASH_CMD`.
2. **The wiring test could not see what it claimed to enforce.** It asserted
   `verify-gate.sh`'s source *text* and passed 7/7 against a mutant whose
   `launch()` asserted uniqueness over `${PIDS[@]}` instead of `${NAMES[@]}` —
   the fix entirely disarmed. Deleted; three tests now run the **real**
   `launch`/`gate_abort` bodies (`sed`-extracted from the script) and one runs
   the real gate with its library removed.
3. **A failed library load surfaced as a bogus collision.** With
   `assert_unique_row_name` undefined, `launch` read the resulting exit 127 as a
   duplicate and aborted naming an innocent row. A post-source
   `command -v row_slug` guard now names the real cause; `CDPATH= cd` closes one
   route into that state.

Knowingly not fixed: `kill $(jobs -p)` in `gate_abort` does not reach
grandchildren (reproduced). Per-row process groups need `set -m`, which changes
the `jobs -rp` throttle the fan-out depends on — a regression risk on a path
that only runs when the gate itself has a bug. The comment was corrected to
claim only what the call does.

### Verification

Mutation matrix, baseline 10/10 green, run against copies with repo files
untouched:

| Mutation | Result |
|---|---|
| `launch` asserts over `${PIDS[@]}` instead of `${NAMES[@]}` | 1 red |
| `${NAMES[@]+"${NAMES[@]}"}` → `"${NAMES[@]}"` | 2 red (on `bash 3.2.57`) |
| `gate-rows.sh` regains its source-time `exit 1` | 1 red |
| post-source load guard deleted | 1 red |
| `row_slug` drops the hash suffix | 2 red |
| `assert_unique_row_name` always returns 0 | 1 red |

`scripts/verify-gate.sh --review` GREEN at HEAD, 21 rows including
`diff-coverage` — the fixed gate verified its own branch. CI 13/13 green.

### Gotchas worth carrying (promoted to `lab-notes.md`, 2026-08-08 — #696)

- A **"is it wired?" test asserting source text** is the same defect class as the
  bug it guards. Extract to a sourced library, or `eval` the real function body
  out of the script; keep text assertions for genuinely textual properties, and
  write them as patterns not literals.
- **`exit` in a sourced bash file kills the caller.** A library signals, the
  entry point decides — and the entry point's abort path is defined *before* the
  `source` line. Follow every `source` with a `command -v <symbol>` guard.
- Under `set -u` on **bash 3.2** (what `/usr/bin/env bash` resolves to on macOS)
  `"${ARR[@]}"` on an **empty** array is a fatal unbound-variable error. Use
  `${ARR[@]+"${ARR[@]}"}`.
- Whenever a derived string is used as a **key** — a log filename, a cache key, a
  lock name, a job id — a lossy transform on the way in is a correctness bug, not
  a cosmetic one.

### Workflow notes

- The `reclassify` trigger fired (production 147 vs an estimated 65). Step 0 was
  re-run with the real numbers: lane **unchanged** (small — 147 ≤ ~150 lines, 3
  code files, one seam, no migration, no dependency). The estimate predated the
  review round whose fixes are real production code. `allowed_edit_surface` was
  never amended.
- `scripts/gate-rows.sh` is deliberately **not** added to `docs/directory.md`:
  that table is scoped to `tsx` operational scripts and lists none of the twelve
  existing `.sh` files. Recorded as deviation D3 for a future inventory pass to
  settle as a whole.
- The #679 workaround is retired as a *live* constraint — the header note in
  `import-offer-analytics.integration.test.ts` is now marked historical. The file
  keeps its name, which was always the accurate one.
- The post-merge sweep ran from a **fresh worktree off `origin/main`**, not the
  main checkout: a concurrent session had uncommitted #671/#672 work sitting in
  the shared checkout's working tree.

---

## Live-DB DDL detector (2026-08-08, #694 → PR #705)

CI/test tooling. No runtime code, no migration, no flag, no dependency.

**The defect.** `ci:live-db-suites` rule R2 ("a live-DB suite must not execute
DDL at run time") was `text.includes('supabase/migrations') && text.includes('.unsafe(')`
— a proxy for DDL, not DDL. Three suites executed DDL without naming a migration
path and passed clean. One of them forced a transaction abort by adding a
temporary CHECK constraint to `job_outbox` and dropping it in a `finally`; a
vitest timeout skips the `finally`, so `tmp_block_import_topic_analytics`
stranded on the shared test container and blocked every sibling suite enqueuing
`zernio_initial_backfill` — 14 spurious failures across three suites.

**What shipped.** AST extraction of executed SQL, DDL-verb match over extracted
text only, SQL comments blanked to equal-length whitespace so reported line
numbers survive, fail-closed on unreadable `.unsafe()` arguments (including a
template whose substitution stands where a statement begins). Two lock-enforced
allowlists (migration-shape + the new DDL-probe) and a per-line
`-- live-db-ddl-ignore` pragma for statically-invisible safety. Signature and
finding shape unchanged — the module was deepened, not widened.

**Seven sites, not three.** The census found four the ticket didn't name: a
second bootstrap `ALTER TABLE` in `health-alert/checks`, two `auth.uid()` RLS
probes (`outreach-render`, `migration-091`), and three pg_temp index builds in
`migration-080`. `migration-091` had been executing probe DDL on **no allowlist
at all**, so its `acquireLiveDbLock` enrolment had never once been verified.

**Process notes worth keeping:**
- T1–T4 were planned as parallel and run **serially**: three of them execute
  live-DB suites against the shared container, and proving a DDL fix while a
  sibling task mutates that container is the exact interference this ticket
  exists to remove.
- Two review rounds, 16 findings, **every one a false claim or a test that
  proved less than its name promised** — the executable logic was right from the
  first pass. Fitting, on a ticket about an audit asserting something it never
  checked.
- The audit header's exact template count went stale **three times inside the
  feature's own review**, each correction itself reviewed. Now stated as an
  approximate, explicitly point-in-time census with the recount method attached.
- Known bound filed as **#706** rather than patched at round 2 — DDL in a
  fragment built inside a `__tests__/` helper was invisible, and widening the
  glob trips the naming rule on helper files, a behaviour change needing its own
  design. **CLOSED at #706 the same day.** What shipped: the audited set is now
  every `.ts`/`.tsx` under `__tests__/` (904 → 917 files); the enforcement unit
  is split, so R1 naming applies to **suites** only (a helper cannot be renamed
  to `*.integration.test.ts`) while R2 and the lock check apply to every live-DB
  **file**; helpers reach the DB through their own marker, an import of
  `postgres` (they are handed the handle and name no env var, in either the
  `from 'postgres'` or the inline `import('postgres').Sql` spelling), deliberately
  not offered to suites because R1 is a claim about which vitest project a file
  lands in and a mock-shaping type import is not evidence a suite reaches a DB —
  many suites match the marker while touching no database, so admitting it
  would fire the naming rule across the tree on them;
  and `apply-migration-074.ts` — the one real occurrence, running
  `db.unsafe(readMigration074Sql())` and never audited before — is allowlisted
  **and** lock-enforced against its own `withMigration074ApplyLock`, proved by
  mutation. Both allowlists were renamed to `MIGRATION_SHAPE_FILES` /
  `DDL_PROBE_FILES`, because a set named for suites that holds a helper is the
  same false-claim class this ticket's review filed as its only Medium finding;
  the two exports are now `auditLiveDbFile` / `listAuditedFiles` for the same
  reason. Two bounds remain, both
  stated in the module: a fragment built outside `__tests__/` entirely (a `src/`
  module a suite imports), and the `e2e/` Playwright lane, which owns its own
  database lifecycle.

## Import consent analytics sink (2026-08-08, #697 → PR #708)

Observability. No migration, no env var, no flag, no dependency, no new file.
`/feature` SMALL lane at RISK = high — abbreviated intake, in-session
implementation, one review axis, full staging ride.

**The defect.** #679 wrapped both **Import offer** analytics emissions in a
postgres.js savepoint so a failed emission rolls back only itself. That closed a
real connect outage: an unapplied migration 102 raises `23514` inside
`finalizeConnectionTx`, and `select-location/route.ts` rethrows non-`23505`, so a
missing migration broke Google Business Profile connect entirely. But the
savepoint converted a loud failure into a quiet one — a lost metric and a `warn`.
`createWorkerLogger(...).warn` writes structured JSON to **stdout only**, while
the documented paging path is `captureMessage`
(`docs/runbooks/beta-launch-alerting.md` §1). Persistent analytics-schema drift
could therefore undercount both one-shot events indefinitely with nothing
alerting on it.

**The fix.** A second sink beside the existing `warn`: `Sentry.captureMessage` at
`level: 'warning'`, `tags: { subsystem: 'import_consent_analytics', event_name }`,
`extra` carrying exactly `business_id` / `event_name` / the error text.

**Design decisions, all locked during grilling:**

- **Guarded `captureMessage`, not `reportCaughtError`.** The shared helper exists
  and was the obvious reuse, but it fixes `level` at `error` (this is a P2 — the
  caller committed, only a metric was lost) and tags only `endpoint`, which the
  runbook's `subsystem`-keyed alert rules do not route on. Precedent followed
  instead: `src/lib/llm/circuit-breaker.ts:185-205` — a `src/lib` domain module
  doing a guarded `captureMessage` + `subsystem` tag while retaining its log line.
- **Not a HealthAlertPoller counter** (the issue's option B). These events are
  one-shot per business; aggregation would need a cross-lane counter store, since
  this code runs in BOTH the Vercel Next server (connect finalize, the dashboard
  Import offer route) and the Railway worker (the Stripe activation resume).
- **#695 deliberately NOT designed together with this**, despite the issue
  suggesting it. Different sink, different subject, and #695 carries an open
  architectural question (DB trigger vs per-worker guard). Owner decision.
- **`@sentry/node` from a route-reachable `src/lib` module is fine** —
  `@sentry/nextjs` re-exports the same module instance, so one import serves both
  lanes. Documented at `src/lib/shared/report-caught-error.ts:9-13`; verified
  against the ESLint boundary guard.

**Two bounds, both load-bearing, both pinned:**

1. The capture carries **its own** `try`/`catch`. Without it, an alert that
   throws is the #679 connect outage re-opened one layer out.
2. The `warn` sits **outside** that guard, so it survives Sentry being
   unreachable. Moving it inside looks like tidying toward the named precedent
   and would delete the last sink on exactly the transport-failure path.

**Verification.** Four new titles in
`src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts`, and five
mutations each verified to turn only its intended title red: delete the capture
(titles 1–3), delete the inner catch (title 3), capture above the code-less
rethrow guard (title 4), leak `properties` into `extra` (titles 1–2), warn inside
the guard (title 3).

**Staging ride.** The change only shows itself when an emission FAILS, and
staging has migration 102 applied. Rather than drop
`analytics_events_event_name_check` on a shared database, the same `23514` was
induced by offering the constraint a name it rejects, inside a transaction that
was then aborted. `offer_outcome: "created"` confirmed the emitting branch really
ran; Sentry issue `REPWORTH-STAGING-S` landed with the routable tag and was
resolved with a synthetic-marker comment; zero rows persisted. Evidence:
`docs/reviews/fix-697-import-consent-analytics-sink/staging-ride.md`.

**Review.** One round, spec & correctness axis: no Critical/High/Medium, two Low,
both accepted and fixed (mutations 4 and 5 are what now pin them). One surface
amendment (1 of the 2-item budget): `docs/launch-checklist.md`, which carried a
**second** inventory of Sentry routing tags that would otherwise have drifted
from the runbook.

**Residual ops gap (not code).** The Sentry rule for
`subsystem:import_consent_analytics` is not configured, so the signal is durable
but not paged. Both routing documents carry the checklist item, and both specify
an **event-frequency** condition rather than "a new issue is created" — the
capture title is a constant, so every occurrence groups into one Sentry issue and
a new-issue rule would fire exactly once, ever.

### Workflow notes

- The reviewer's strongest finding was not a bug but a **missing guard on a
  locked invariant**: `toMatchObject` on the Sentry `extra` is a subset
  assertion, so the intake's "only three fields leave the process" rule had no
  test. The key SET, not its contents, was where the invariant lived.
- A rejected finding worth recording: the four new titles live in a live-DB
  suite, which no *required* CI check runs. True, pre-existing, repo-wide
  (CLAUDE.md: "an existing-but-not-run suite is how #520 shipped"), and out of
  scope for an observability fix — mitigated here by running the suite locally on
  every gate pass plus the five mutations.

## Import consent enforcement locus + block reason (2026-08-08, #695 → PR #714)

An ADR plus one observability marker. **No migration, no env var, no flag, no new
dependency, no new runtime file.** `/feature` lane at RISK = high — 3 plan-review
rounds, 1 branch-review round across three axes, full staging ride.

### The question, and the answer

The adversarial axis of #679's review challenged the *enforcement locus*: the
`job_outbox` insertion boundary is also a chokepoint every producer shares — product
code, the admin manual-SQL re-enqueue path (`src/app/admin/runbook/page.tsx`), any
future producer — and unlike the worker guard it sits **before** dispatch. A `CHECK`
constraint or `BEFORE INSERT` trigger there would enforce **Import consent** with no
per-worker guard at all, and spec §5.3's own "no enqueue-time gate can ever cover
manual SQL" sentence, read literally, is answered by that proposal.

`docs/adr/0016-import-consent-enforcement-locus.md` **files the challenge and
declines it.** Enforcement stays at `guardImportConsent` in `ZernioBackfillWorker`.
Against, in descending weight:

1. **It forces a second spelling of the derived-expiry predicate, and nothing can
   check the two against each other.** A trigger must re-express
   `importConsentStateSql` — `pending AND import_offer_expires_at <= now()` — in
   PL/pgSQL, inside a migration. §5.3 exists to give that predicate exactly one
   owner (#670). Stated precisely, because overstating it is how an ADR loses its
   authority the first time someone checks it: a later migration *can*
   `CREATE OR REPLACE` the trigger function, so this is **unenforced drift plus a
   two-environment deploy coupling**, not literal impossibility. On this predicate
   that is decisive.
2. **`job_outbox` is topic-agnostic infrastructure** shared by 32 topics; a
   topic-specific trigger makes every later reader pay to learn why one is special.
3. **The marginal gain is small**, and this ticket shrinks it further — "row never
   created" vs "row no-op-completes without importing anything"; in both cases
   nothing is stored and nothing reaches Google.
4. **It would not remove the worker guard.** An insert-time gate cannot see consent
   that changes between enqueue and dispatch, so the proposal buys two enforcement
   points to keep in sync, not one — and its "removes the transaction + row lock"
   argument falls with it.

### What shipped

- `src/lib/shared/outbox.ts` — **`markOutboxOwnerUnreachable` is DELETED**, replaced
  by `markOutboxCompletedWithReason(exec, outboxId, reason, attempt?)`. A
  rename-and-parameterize, not a sibling, so the outbox seam stops growing one
  method per reason. Returns `void` (no caller needed the CAS result). Same emitted
  UPDATE, same attempt-guarded `dispatchedRow` CAS, same `warnOutboxNoop` — and
  **`owner_unreachable`'s persisted wire value is unchanged**, so both poller
  readers are untouched.
- `src/lib/shared/outbox-completion-reason.ts` — adds
  `OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED = 'import_consent_blocked'` plus
  the exported `OutboxCompletionReason` union the writer's parameter takes.
- `worker/jobs/zernio/job-eligibility.ts` — `guardImportConsent`'s skip branch
  completes the refused `zernio_initial_backfill` row via
  `markOutboxCompletedWithReason` on the **same `tx`**, inside its unchanged
  `sql.begin` + `businesses … FOR UPDATE`. The proceed/skip decision, the signature,
  `ImportConsentGate`, the serialization, the lock, `importConsentStateSql` and the
  structured log line are all unchanged.
- `worker/jobs/notification/NotificationWorker.ts` — call-site swap only.
- `docs/adr/0016-import-consent-enforcement-locus.md` (new) + spec §5.3, `CONTEXT.md`
  and `.claude/CLAUDE.md` updated to cite it **by filename**, not by number (D7).

**Column from migration 083** — `job_outbox.completion_reason` has existed since the
owner-unreachable work (#516), so this ticket adds no migration.

**Deliberate non-goal:** `guardZernioJobEligibility`'s three skips (missing row,
archived location, failed subscription guard) keep using plain `markOutboxCompleted`
and leave `completion_reason` NULL. They are not policy refusals, and 29 assertions
in `ZernioBackfillWorker.test.ts` legitimately still name the plain writer.

### What the marker is — and what it is NOT

Corrected mid-flight (D8, owner-decided): the intake said "durably queryable", which
was an **overclaim**. `ArchivalPoller` deletes completed `job_outbox` rows 7 days
after `completed_at` (`ArchivalPoller.ts:60`), and a refusal *completes* rather than
fails, so it takes the 7-day arm and not the 90-day dead-letter one. It is an
**operational-window signal, not an audit record** — the same life `owner_unreachable`
has always had (ADR 0010), i.e. a property of the sink, not of this ticket. What
outlives the window is `businesses.import_decision` / `import_decision_at`, plus the
log line under the log sink's own retention.

Three further stated limits, all recorded in ADR 0016 alongside the operator query:

- **No backfill of historical rows** — pre-change refusals also carry NULL, so
  outside the post-deploy band NULL means "genuine import OR pre-deployment
  refusal". The query's `created_at >= '<deploy timestamp>'` bound is what makes it
  trustworthy, and it is trustworthy in exactly one band: after that timestamp and
  within the last seven days.
- **ONE marker for all four refusal states.** It records THAT a refusal happened,
  not which state caused it; a `pending` refusal whose owner later accepts keeps the
  marker. A per-state column would put a point-in-time fact where readers would
  inevitably compare it against current state. The detail lives only in the
  structured log line `import consent blocked — skipping backfill` — the ONLY record
  of it in the `missing` case.
- **Nothing reads it in code** — no poller, no alert, no Sentry capture, no PostHog
  event, no `/admin/jobs` rendering. A refusal is the guard working, not an incident.

### Verification

Verify gate GREEN ×4 (`--review` mode 25/25, last at `70bf042d` post-merge of
`origin/main`); both live-DB suites executed, 0 skipped. 14 new/retargeted test
titles across `outbox.test.ts`, `job-eligibility.test.ts`,
`job-eligibility.integration.test.ts`, `ZernioBackfillWorker.test.ts`,
`NotificationWorker.test.ts` and `NotificationFailoverPoller.integration.test.ts`.

**Staging ride:** `e447ee5b..70bf042d` pushed, worker restarted, Railway check
`Success`. A hand-inserted `zernio_initial_backfill` row for a `pending`-consent
location completed in 3.5s with `completion_reason='import_consent_blocked'`,
`attempts=1`, `last_error=null`, **0** `zernio_backfill_runs` and **0** reviews
imported. Every other topic stayed NULL. The synthetic outbox row self-purges via
`ArchivalPoller` in 7 days — itself a live demonstration of the window limit above.

**Review:** one round, three axes — spec & correctness PASS (3 Low), standards PASS
(1 Medium, 1 Low), adversarial (Codex) needs-attention (1 Medium, the locus question
the ADR answers). F1–F3 fixed in round 1; F4 (five stale doc cross-references)
deferred to this post-merge sweep because all five sat outside
`allowed_edit_surface` and adding them would have been amendment #2 — an abort
trigger. They are fixed in the same change as this entry.

### Workflow notes — two lessons, both promoted to lab-notes

- **An eval that passes while the feature is unbuilt is worse than no eval** (D5).
  A shared mock recorder made `reason` optional, so `expect(x.reason).toBe(CONST)`
  compared `undefined` to `undefined` and passed at T1 with nothing implemented.
  Three plan-review rounds missed it. Round-1 finding F1 then found the same shape
  structurally re-armed by a **dead recorder** whose only effect was forcing the
  field optional. Guard: assert the *writer* was called, and keep the recorder's
  field required.
- **When a call site swaps writers, grep for suites that MOCK the module — not just
  importers of the removed symbol** (D6). Different searches:
  `rg markOutboxOwnerUnreachable` finds files importing the deleted export; only
  `rg 'vi\.mock\(.*shared/outbox'` finds files that stub the module and assert on
  the superseded writer. A module mock missing the new export fails at CALL time, so
  typecheck cannot see it, and three targeted per-suite green runs missed it. Only
  the whole-repo gate found `ZernioBackfillWorker.test.ts`.

---

## 2026-08-08 — #680 Legacy backfill counters DROPPED (migration 103, PR #716)

**The closing ticket of the Consented Review Import epic (#667).** Migration 103
drops `gap_processed_count`, `historical_processed_count`, `gap_skipped_count`
and `historical_skipped_count` from `zernio_backfill_runs`, completing the DROP
half of the counter collapse ADR 0015 §4 split across two migrations. Applied to
staging **and** production 2026-08-08 in lockstep. Migrations head 102 → 103.

### What shipped

1. **`supabase/migrations/103_drop_legacy_backfill_counters.sql`** — four
   statements: `SET lock_timeout = '5s'`, `SET search_path = public, pg_temp`, a
   `DO $$` preflight guard, one four-column `ALTER … DROP COLUMN IF EXISTS`.
2. **`migration-103-drop-legacy-backfill-counters.integration.test.ts`** (new,
   7 tests) — pins the migration's executable text exactly, executes its own
   guard against a `pg_temp` replica to prove BOTH branches, and introspects the
   final shape.
3. **Retargets**: the migration-100 suite's counter assertion 7 → 3 columns
   (intake E6 — it went red the moment the local DB passed 103), and the two
   `ZernioBackfillWorker` legacy-counter guards retitled to name 103.
4. **Docs**: migrations-log head + entry, ADR 0015's cleanup-migration
   consequence marked DISCHARGED, spec §8a R4 ticked, the completed
   zernio-ingestion runbook's two stale operator sites annotated as superseded.

**Zero production TypeScript changes.** The worker stopped writing the legacy
four at #675; no poller, offboarding/purge, admin, RLS, analytics or KPI path
read them. Two of the ticket's four scope bullets were therefore already
discharged by inspection at 0 diff (`scripts/ci/tenant-scope-allowlist.ts:2211`
already carried the collapsed two-column UPDATE form; the worker sweep found no
residual read), recorded as deviations D1/D2 rather than invented work.

### Decisions

- **The preflight is executable, not documented.** The first plan draft put the
  reconciliation query in the migration header for an operator to run. That was
  rejected on review: a guard that never fires is indistinguishable from a
  working one on clean data — both report zero abort rows, and both environments
  were clean — so the documented form could prove nothing and a forgotten one
  would protect nothing. As a migration statement it cannot be skipped, and its
  failing branch becomes testable.
- **The guard counts all four columns, not one.** `0 → RETURN` (keeps 103
  re-runnable after the drop), `4 → reconcile`, **any partial state → RAISE**.
  103's own `ALTER` is atomic and cannot produce a partial schema, but the guard
  is written to be sound against any input state, not merely the ones this file
  creates — returning early there would drop the survivors' values unreconciled.
- **The existence check is search_path-relative** (`to_regclass` +
  `pg_attribute`, `AND NOT attisdropped`) rather than a `table_schema='public'`
  literal, which cannot follow the `pg_temp` shadow the guard tests depend on.
- **`SET search_path` is session-level, not `SET LOCAL`** — see the gotcha below.
- **The worker guards were KEPT and retargeted, not deleted.** Reversal of an
  earlier decision: that suite is mock-`sql` based, so a reintroduced legacy
  column name is invisible to every other check and would surface only as a
  production 42703. "It would be a hard 42703" is the argument *for* the guard.

### Review

Four adversarial plan-review rounds before a line of code was written:
**10 → 7 → 2 → 0 findings**, blockers **1 → 2 → 0 → 0**. All 19 findings were
accepted after verification against disk; **none was ever rejected**. Triage in
`docs/reviews/feat-680-drop-legacy-backfill-counters/plan-review-round-{1,2,3,4}.md`.

Rounds 2 and 3 both found their blocker-class defects in the **fixes**, not in
the original plan — the standing lesson from this ticket.

### Gotchas found (full detail in lab-notes 2026-08-08 #680)

- **`SET LOCAL` in a migration is a no-op that only warns.** The fix for the
  temp-table hijack was written as `SET LOCAL search_path`, which takes effect
  only inside a transaction block; this repo applies migrations with plain
  `psql -f` and no migration carries `BEGIN`/`COMMIT`, so it would have governed
  nothing. The migration would have applied cleanly, tests would have stayed
  green, and the hole would have stayed open behind its own apparent remedy.
- **`.match()` without `/g` cannot count**, so an "exactly one `DO` block"
  assertion written with `.length` was inert.
- **`ci:live-db-suites` counts an unreadable `.unsafe()` argument as DDL**, so
  dynamically executing the migration's guard needs its own second pragma.
- **A column DROP cannot be proven by boot readiness** — probe the worker's own
  statement shapes inside a `DO` block that RAISEs.

### Verification

Local: full gate GREEN, 23/23 rows, both integration suites RUNNING (not
skipped). Mutation-tested in both directions — swapping the two-branch predicate
for the naive form turns the passing-branch test red; any edit to the migration
turns the text pin red.

Staging apply window: `total_rows=2, unreconciled_two_branch=0` — and
`unreconciled_naive=2`, i.e. **the naive predicate would have aborted the
migration on both healthy rows**, which is the header's central claim
demonstrated rather than argued. Post-apply introspection returned exactly three
counter columns; rows and totals unchanged at 2 runs / 58 imported. Guard re-run
took the `RETURN` branch. Worker write path proven by a rolled-back `DO` probe
(`PROBE OK … imported=0 skipped=0`).

Production: preflight `0 rows / 0 unreconciled / 0 businesses` (trivially
satisfied, recorded anyway — a skipped preflight is not a passed preflight);
post-apply introspection identical to staging.

### Known follow-ups

- **`RECLASSIFY` fired** (411 production lines vs 200 estimated) and was shipped
  through by owner decision. It was documentation and test volume, not code
  scope — zero TypeScript behaviour changed. Second instance of the lab-noted
  pattern that `estimated_diff_size` must budget production and test lines
  separately, or reclassify fires on exactly the DB-contract features whose
  heavy test ratio is by design.
- **Staging `onboarding_drip` failures** (~24 `job_outbox` rows in `failed` on
  Terry Business) remain open. Pre-existing, unrelated to the import path,
  outside this ticket's surface. Still needs its own ticket.

## Live-DB helper scan (2026-08-08, #706 → PR #720)

CI/test tooling. **No migration, no env var, no feature flag, no new file, no
new dependency, and zero runtime surface** — the whole change is one CI script
and its test file. #694 filed this bound against itself at its round-2 review
and shipped without it; #706 closes it the same day.

### The hole

`ci:live-db-suites` enforces two rules on files that reach the shared local
Postgres: **R1** a live-DB suite must be named `*.integration.test.ts` (that
glob is what puts it in vitest's serialized `integration` project), and **R2**
no run-time DDL, because DDL's ACCESS EXCLUSIVE locks deadlock sibling suites in
concurrent vitest processes (40P01, #573).

#694 replaced R2's text-marker heuristic with an AST walk over *executed* SQL,
and argued its own soundness this way: the walk visits the **producing** node,
so a fragment smuggled into a suite is caught in the file where it is built.
That argument is correct, and it is not sufficient — it is silently conditional
on the producing file being *read*, and `listTestFiles()` globbed
`*.test.ts`/`*.test.tsx` only.

The mechanism that turns the gap into a real hole is Postgres.js: a nested
`Query` substitution is routed through `fragment()` and spliced into the outer
statement as raw SQL **text**, not as a bind value. So a `__tests__/` helper can
export `` sql`ALTER TABLE …` ``, a suite can execute it as `` sql`${addCheck}` ``,
and *both* files audit clean — the helper because it was never opened, the suite
because it carries no DDL text of its own — while the tree takes ACCESS
EXCLUSIVE on `job_outbox`. `live-db-suites-audit: passed` would print over it.

### What shipped

- **The file set widened**, from two `git ls-files` pathspecs to four:
  `*.test.ts`, `*.test.tsx`, `*__tests__/*.ts`, `*__tests__/*.tsx`. That adds
  the 13 non-suite `.ts`/`.tsx` files under `__tests__/` the audit had never
  once opened. `git ls-files` dedupes across pathspecs, so a file matched by two
  of them is listed once — asserted by the audit's own test, since a
  double-listed file would double-report every finding it carries.
- **The enforcement unit split.** R1 **naming** applies to *suites* only: it is
  a claim about which vitest project a file lands in, and a helper renamed
  `*.integration.test.ts` would simply be executed as an empty suite. R2
  **run-time DDL** and the lock check apply to every live-DB *file*, suite or
  helper, because "does this statement take ACCESS EXCLUSIVE on a shared
  relation" is true of the statement wherever it was written. `isSuite()` is the
  predicate, and its JSDoc is the single owner of that argument.
- **Helpers got their own reachability marker.** `LIVE_DB_MARKERS` is
  suite-shaped — the env var by name, or an import of the module that
  resolves/gates/locks the handle — and a helper matches none of it, because it
  is *handed* its handle. What it cannot avoid is *typing* that handle, so
  `HELPER_DB_MARKER` is an import of `postgres`, in either spelling: the
  `from 'postgres'` clause, and the inline `import('postgres').Sql` type, which
  carries no `from` clause at all.
- **The marker is deliberately not offered to suites**, and the reason is what
  R1 *means* rather than noise volume: a mock-shaping type import is not
  evidence that a suite reaches a database. The volume is real too — many suites
  match the marker while touching no DB — so admitting it would fire the naming
  rule across the tree on files that reach nothing. The census and its recount
  method live in the module's `HELPER_DB_MARKER` JSDoc, which is their single
  owner; the docs carry the rationale and no figures.
- **`src/lib/shared/__tests__/helpers/apply-migration-074.ts` was the one real
  occurrence.** It runs `db.unsafe(readMigration074Sql())` and had never been
  audited. The file itself is unchanged; it is now on `MIGRATION_SHAPE_FILES`
  **and** lock-enforced against its own `withMigration074ApplyLock`.
- **Names corrected to match the widened scope.** Exported shape is unchanged —
  1 interface + 2 functions, same arity, same return shapes, same three-member
  `rule` union (`naming` | `runtime-ddl` | `unlocked-ddl`) — but
  `auditLiveDbSuite`→`auditLiveDbFile`, `listTestFiles`→`listAuditedFiles`,
  `LiveDbSuiteFinding`→`LiveDbFileFinding`, and the two internal allowlists
  `MIGRATION_SHAPE_SUITES`→`MIGRATION_SHAPE_FILES`,
  `DDL_PROBE_SUITES`→`DDL_PROBE_FILES`. A set named for *suites* that now holds
  a *helper* is exactly the false-claim class #694's review filed as its only
  Medium finding.

### Files

| File | Change |
|---|---|
| `scripts/ci/live-db-suites-audit.ts` | widened file set, the `isSuite` enforcement-unit split, `HELPER_DB_MARKER`, the 074 helper allowlisted + lock-enforced, five identifier renames, and the JSDoc/`BOUND:` prose that is this module's spec |
| `scripts/ci/__tests__/live-db-suites-audit.test.ts` | 43 tests — the helper fixtures authored red against the new interface, the dedupe assertion, and the pin on the inline `import('postgres')` spelling |
| `src/lib/shared/__tests__/helpers/apply-migration-074.ts` | **untouched** — listed only because it is the one file whose *audit status* changed |

No other file in the repo changed. Everything else in the merge commit is the
workflow record: the plan, deviations, handoff, intake and the two review
reports.

### Decisions

- **Split the enforcement unit rather than widen both rules.** The tempting
  alternative — scan helpers and apply both rules to them — is wrong in a way
  that would have looked right in CI: R1 would advise renaming a helper to
  `*.integration.test.ts`, which serializes nothing and produces an empty suite.
- **Reachability is a marker, not an import graph.** Inheriting a caller's lock,
  or proving a helper's DDL sits *inside* its wrapper, both need call-graph
  analysis — more machinery than a CI guard against accidental DDL warrants. The
  module states that in a `BOUND:` paragraph rather than implying the guarantee
  is total.
- **Renames over compatibility shims.** `rg` over the whole tree found zero live
  importers of the old names outside historical review and plan documents, so
  the rename is complete rather than aliased.

### Review

Two rounds, every finding accepted, one behaviour change in total.

- **Round 1** — findings across both axes resolved into **nine fixes**; eight
  prose, one behavioural. The behavioural one: `HELPER_DB_MARKER` did not match
  the inline `import('postgres').Sql` form, a spelling this tree already uses
  twice for exactly the "hand a fake handle to something" shape. A helper typed
  that way would have been invisible — the #694 blindness mode, reopened one
  ticket later. Both existing sites are suites, so no finding on the real tree
  moved; a new test pins the shape.
- **Round 2** — **five findings, every one of them a defect introduced by a
  round-1 fix**, and all five prose. The comment-stripped audit script is
  byte-identical across the round-2 commit, so no rule behaviour moved.
- **Round 3** — verification only, zero findings.

Four false or stale counts were corrected during round 1: a "~740 parallel unit
tests" figure that was false in three durable docs, a "four of the six" that was
five, a "~738 parallel siblings" **deleted** rather than restated because its
owner is another file and equally stale, and `currents.md`'s "same exported
signature" when all three exports had in fact been renamed.

### Gotchas

- **An exact count in a comment is a maintenance trap, demonstrated live.** The
  module's census (`186 of the 904 suites`) was exact when it shipped and had
  already moved by the time this sweep ran: PR #716 added
  `migration-103-drop-legacy-backfill-counters.integration.test.ts`, so `main`
  now measures 187 of 905, with the audited set at 918. The JSDoc calls it a
  census rather than a constant and carries the recount method — that is the
  mitigation, and it is doing its job. Recorded here rather than patched,
  because this sweep is documentation-only and the figure lives in a `.ts` file.
- **`reclassify` fired at 2.15×** — 280 production changed lines against
  `estimated_prod_lines: 130`. Step 0 was re-run per the workflow and the lane
  was **CONFIRMED, not changed**. The breakdown is the whole story: 32 lines of
  executable code, 144 comment lines in the audit, 52 lines across four repo
  docs. `estimated_prod_lines` was deliberately **not** amended after the fact —
  the intake is the record of what was predicted, and editing it would defeat
  the trigger. Durable lesson in `lab-notes.md` under **2026-08-08 — #706**.

### Verification

`pnpm ci:live-db-suites` → `passed`; 43/43 on the audit's own suite; typecheck
and lint clean. The behavioural fix was proved against all four marker shapes
plus three negative controls, and the 074 lock enforcement by mutation in both
directions — rename the lock marker in the real file text and `unlocked-ddl`
appears; hoist the DDL out of the wrapper with the declaration left in place and
it does not, which is the bound the module now states plainly instead of
claiming the check is total.

## Generate transaction extraction (2026-08-09, #729 → PR #733)

Wayfinder map #710, item 3 — the design correction #678's review filed against
itself. Behaviour-preserving: no migration, no env var, no flag, no new
dependency; net +163-line module against a 184-line route shrink to
composition root.

### What shipped

- `src/lib/reviews/on-demand-generate.ts` (new): `onDemandGenerateTx(tx,
  { reviewId, businessId })` → `OnDemandGenerateResult` discriminated union
  (`ok` | `review_not_found` | `not_writable` | `already_answered` |
  `draft_already_exists` | `orphan_recovery_pending` |
  `regenerate_in_progress`). Owns the review `FOR UPDATE` lock, the in-tx
  TOCTOU `assertWritableSubscriptionForBusiness` re-check, the three sibling
  exclusions + orphan guard, `COALESCE(MAX(version),0)+1` (D-B), and the
  atomic `enqueueGenerateResponse` with `originLane = ON_DEMAND_GENERATE` +
  `suppressNotification: true` (invariants #2/#3 comment block moved with the
  code). Receives `tx` explicitly; never imports `@/lib/db/server` (#15).
- Route slimmed to orchestration (#12); mapping table preserves every status
  code, error string, and the pre-existing NO_STORE_HEADERS asymmetry. The
  `on_demand_generate_enqueued` log line moved after `sql.begin` resolves —
  post-commit, where before it fired pre-commit inside the tx (deliberate
  truthfulness improvement; the only intentional observable delta).
- The three sibling reads gained `AND business_id = …` (zero cost — businessId
  already resolved and locked), so their 3 tenant-root-lookup allowlist
  entries were DELETED and `ALLOWLIST_BASELINE` moved 412→409 with a history
  step explaining the shrink.
- `statusArraySql` widened one line to take the caller's `sql`/`tx` client.

### Process notes (/feature run)

- Eval-first: the 9-title module suite was committed RED before any
  implementation; both #678 suites (515-line unit + live-DB
  `generate-version.integration.test.ts`) served as the characterization eval
  and survived with zero assertion changes (route.test.ts took a
  mock-plumbing-only txMock fragment pass-through, deviation D3).
- One counted surface amendment (A1): `src/lib/shared/response-status-sql.ts`
  — the plan's claim that `TransactionSql` is assignable to `Sql` was false.
- Cross-worktree coordination: `scripts/ci/tenant-scope-allowlist.ts` overlaps
  the parked feat-719 worktree; agreed merge order #729-first recorded in both
  deviations files (feat-719 rebases + recomputes the baseline on resume).
- Two-axis step-7 review: one shared finding (stale allowlist baseline
  narrative), fixed, round-2 verified. Verify gate GREEN 4× (2× `--review`
  with diff-coverage); all 12 GitHub checks green.

### Gotchas promoted to lab-notes

- The `/feature` edit-surface bash hook and `feature-surface-audit.ts`
  DISAGREE on Next.js dynamic-segment paths (`[reviewId]`): bash needs `\[`
  escaping, the TS matcher escapes literals and needs the unescaped form —
  declare BOTH spellings in `allowed_edit_surface`.
- postgres.js `TransactionSql` is NOT assignable to `Sql` (sibling
  interfaces) — shared SQL-fragment helpers must accept the union
  (`SubscriptionSql` precedent).

## 2026-08-09 — #726 Legacy Past Replies hold gates (PR #735, squash 174c121d)

Ticket-seeded `/feature` run off wayfinder map #710 (item 1, server half).
RISK=high (invariant #4) → full apparatus: codex plan review, three-axis
branch review, staging ride, owner merge pause. **No migration, no env var,
no flag, no new dependency.** 77 prod / 308 test lines (est. 60/280 — no
reclassify).

- **What shipped**: hold gates on all four handlers of the three legacy
  draft routes. Poller → text-free `failed`/`held_for_review` (200) via D6
  inline correlated EXISTS; POST existing-draft branch → 409 without the
  `existing` payload, SELECT upgraded to `FOR UPDATE` (post-lock gate per
  the held-draft.ts contract); PATCH + DELETE → 409 post-lock, row
  untouched. Tenant-before-held ordering locked by a green characterization
  test. Discharges the `EDIT_REPLIES_ENABLED` production-flip launch blocker.
- **Grilling forks locked** (owner, 2026-08-09): poller shape =
  `failed`+`held_for_review` over a named `held` state (client's existing
  terminal-closable path; #727 renders properly later); PATCH gated as a
  ticket delta (same file, "a server gate cannot depend on a client
  affordance"); DELETE refuses explicitly over silent no-op 204.
- **Plan review**: codex rounds 1–3 → APPROVED. Round-1 HIGH catch: the
  plan violated the intake's own post-FOR-UPDATE invariant in POST /draft
  (existing-draft SELECT was lock-free). Round-1 also hardened the eval:
  whole-body sentinel assertions, SQL-shape assertions
  (held-draft.test.ts technique), tenant-precedence characterization.
  Rejected with recorded reasons: live-DB matrix, `last_error` sentinel,
  `it.each` replacing the mandated fast-check property.
- **Execution**: eval task first (8 tests: 6 red / 2 green
  characterizations), then Tasks 2/3/4 as parallel subagents (disjoint
  files; Task 1 had already served as the enforcement spot check — D3).
- **Amendment A1** (owner-approved): `scripts/ci/tenant-scope-allowlist.ts`
  — the two changed queries moved out from under their `sqlSnippet`
  fingerprints (recurrence of the known lab-notes class); snippets updated
  in place, baseline unchanged.
- **Deviations D1–D5** all ACCEPT; D4 = edit-surface-guard bracket-glob
  footgun (existing lab-notes entry extended with the two-copies
  refinement).
- **Branch review round 1**: spec 2 LOW (correlation-predicate assertion —
  fixed; stale `useEditReplyDraft.ts` comment — deferred to #727,
  out-of-surface). Standards (thermo-nuclear): NO FINDINGS. Codex
  adversarial: **no-ship** (named-held poller state; shared enforcement
  seam; live-DB concurrency) — all three REJECTED as locked-decision /
  #730-scope / thrice-rejected re-asks; both positions in
  `docs/reviews/feat-726-legacy-hold-gates/triage-verdicts.md` and the PR.
  Round 2 verification: CLEAN.
- **Ship**: rebased onto #729 (allowlist baseline 412→409 absorbed clean);
  staging rode the exact SHA (deploy success `f8bd5dd3`; SSO-gated routes
  302 as documented — deployment-guide.md:1329); all 12 CI checks green;
  owner-approved squash-merge; staging reset to main per the documented
  post-squash procedure.

## 2026-08-09 — #727 Row-state axes + action projection (PR #741, squash 47748acd)

Ticket-seeded `/feature` run off wayfinder map #710 (item 1, UI/affordance
half; decision ticket #723, HITL-locked cross-product table). RISK=high
(invariant #4) → full apparatus: codex plan review, three-axis branch review,
staging ride, owner merge pause. **No migration, no env var, no flag, no new
dependency, no ingest change.**

- **What shipped**: #678's six-valued `ReviewRowState` enum and its
  `deriveRowState` precedence chain are DELETED, replaced by the #723-locked
  axes + action projection in `src/lib/past-replies/replies-view.ts` —
  `deriveAxes` (Posted-reply axis `reply_state` none/posted/orphan +
  server-internal Replacement-draft axis `draft_state`
  none/generating/ready/held, precedence held > ready > generating > none)
  and `deriveRowAction` ((reply, draft) → Action slot `row_action`, total
  over all 12 cells). The wire carries `reply_state` + `row_action` only;
  `draft_state` never crosses it (invariant #4 as structure). One behavioural
  delta: **posted×held silently withdraws Regenerate** while keeping the live
  Google reply visible — the old chain tested `response_id` before
  `draft_held`, so that cell rendered the `EditReplyDrawer` affordance.
  Grouping predicate becomes `reply_state === 'posted'`; the row set is
  pinned identical to the old `regenerate` grouping. `PastReplyCard.tsx`
  gained a shared `ReplyPanel` extraction and renders the slot with a
  `never`-typed exhaustive switch; the none×held "Reply on hold" panel is
  reconstructed client-side from `(none, none)`. CONTEXT.md **Reviews list**
  glossary rewritten; ADR 0018 (`docs/adr/0018-row-state-axes-projection.md`)
  records the decision, both rejected alternatives (raw axes on the wire; a
  7th enum value — the shape #678's own adversarial review had already
  REJECT/REMODEL'ed), and the accepted #672 polling-window transient.
- **Locked-decision refinements (deviations, all ACCEPT)**: ADR number is
  0018, not #723's promised 0017 (0017 was taken by #724 after the comment);
  #723's prose self-contradiction on orphan×held resolved in favor of the
  reacted-to table — the invariant is *a held draft never projects an
  affordance of its own*, so none/posted×held → `none` while orphan×held
  keeps `recover`; none×held rendering + proper union wire types locked by
  owner Q&A; one intake `tests_to_add` retitle (owner-approved).
- **Plan review**: codex round 1 REVISE (2 BLOCKER / 8 MAJOR / 1 MINOR) — 5
  test titles ADDED to the intake (now 17); 2 findings REJECTED with recorded
  reasons (held-settles-to-`idle` polling window = locked #672 design,
  documented as an ADR 0018 consequence instead of "fixed"; drawer-state sync
  across an RSC refresh = new scope, #726's server gates are the defense).
  Round 2: APPROVED (9 FIXED-VERIFIED, 2 REJECTION-SOUND).
- **Branch review round 1**: spec & correctness PASS, no findings; standards
  (thermo-nuclear) APPROVE with 3 accepted findings; codex adversarial 1 HIGH
  → triaged ACCEPT-AS-DOCS-FIX, and **the orphan×held
  recovery-vs-non-terminal-sibling question filed on map #710 (comment
  5231312267)** — ADR 0018 carries the affordance-vs-execution wording
  (recovery *renders*; executing it against any non-terminal sibling,
  a held one included, 409s `newer_draft_exists`, admin-controlled for a held
  sibling). Fix batch `480d5601` (shared ReplyPanel, exhaustive totality
  test, stale `useEditReplyDraft` comment, ADR recovery wording — the #726
  round-1 deferral discharged here as promised). Round 2 verification-only:
  APPROVED (4/4 VERIFIED).
- **Eval**: 17 pinned tests, incl. the 12-cell render oracle (raw facts →
  `toCardRow` → render → the sole affordance, every cell of the 3×4), the
  posted×held + delete-failed sidecar combo, a wire-shape test proving
  neither `draft_state` nor `held` ever crosses, and live-DB negative
  controls distinguishing an open-held replacement from unflagged and closed
  ones (`load-replies.integration.test.ts`).
- **Ship**: staging rode the branch (ride merge `5c13bdcb`); PR #741 all
  checks green; owner-approved squash-merge to `47748acd`. **Staging resync
  deliberately SKIPPED**: #719 is still riding staging, so staging =
  main-before-#727 (`ae110dfd`) + the #719 ride + the #727 ride-merge;
  staging re-anchors to main when #719 lands.
