# Spec 24 — DevOps & Deployment

> **Goal:** Vercel + Railway PR previews on every PR, zero-downtime migration patterns, PostHog feature flags for gradual rollout, documented rollback playbook, CI < 10 min, secrets rotation on calendar.

---

## 1. Why this matters

Deployment speed is iteration speed. The right CI/CD setup makes ship-3x-a-day cheap and rollback-in-2-min reliable. The wrong setup means founder is too scared to merge on Friday.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Vercel (Next.js) + Railway (worker). **No `vercel.json` / `railway.{json,toml}` / `Dockerfile`** — both dashboard-configured; the worker runs via `tsx`.
- ✅ **CI foundation shipped + enforced (Step 1 first slice, 2026-05-24, PR #57)** — `.github/workflows/ci.yml` runs the secret-free PR gate (`lint`, `typecheck`, `test`, `build`) with stable check names, least-privilege permissions, concurrency cancellation, and SHA-pinned actions. `.github/actions/setup` (composite), `.github/dependabot.yml` (minor/patch grouped, majors individual), `.github/pull_request_template.md`, and `.github/CODEOWNERS` are present. **Branch protection is live**: repo moved to the RepWorth org (Team plan) with a "main protection" **ruleset** requiring the four checks + blocking force-push/deletion. ⚠️ Database-backed integration tests still self-skip without `TEST_DATABASE_POOL_URL`, and Playwright is not in the PR gate yet.
- **Feature flags today are boolean env vars** (`SELF_SERVE_SIGNUP_ENABLED`, `ONBOARDING_DEMO_ENABLED`, `CHANNELS_*_ENABLED`, `ZERNIO_PUBLISHING_ENABLED`), asserted in `worker/config/startup-assert.ts`. These are **kill-switches, not per-user %-rollout**. ✅ Step-0 decision: keep them as kill-switches and add PostHog feature flags (per the [Spec 01 §2a](./01-product-market-fit.md) PostHog decision) when %-rollout is needed — see §Feature flags below.
- Migrations owner-run via Supabase SQL editor; head **042**, next **043**; patterns in `.claude/skills/migrations.md`.
- `.env.example` + `startup-assert.ts` present. **No** `docs/runbooks/rollback.md`.
- Documented patterns for entry-point modularization, outbox, subscription guard.

## 3. Target state

### Preview deployments
- **Vercel:** built-in PR preview URL on every push.
- **Railway:** PR-scoped environment via GitHub integration (one-time setup).
- Each PR comment auto-includes preview URLs.
- Preview env uses Supabase staging project + Upstash dev.

### Database migrations
- All migrations in `supabase/migrations/NNN_<slug>.sql`. Current head: **042**, next: **043** (CLAUDE.md state).
- **Owner-runs migration on prod** via Supabase SQL editor (current pattern). Document staging dry-run requirement.
- **Zero-downtime patterns enforced**:
  - No column drops without preceding app deploy that stops using the column.
  - No `NOT NULL` adds without backfill + default.
  - Index creates use `CONCURRENTLY`.
  - `ON CONFLICT` predicates match partial-index predicates byte-for-byte (CLAUDE.md gotcha).
  - Expression indexes: `(created_at AT TIME ZONE 'UTC')::date` (CLAUDE.md gotcha — STABLE rejected in index predicates).
- **Down migrations** for every up (tested on staging).
- **CI-applied migrations on staging** at first hire — until then, owner-run.

### Feature flags
- ✅ **Decided (Step 0, 2026-05-23): hybrid — keep env-var flags as kill-switches + PostHog feature flags for %-rollout.** Since [Spec 01 §2a](./01-product-market-fit.md) chose PostHog Cloud, %-rollout/A-B comes from PostHog flags; GrowthBook is rejected (no second vendor). The existing boolean env vars (`SELF_SERVE_SIGNUP_ENABLED`, `ONBOARDING_DEMO_ENABLED`, `CHANNELS_*_ENABLED`, `ZERNIO_PUBLISHING_ENABLED`, asserted in `worker/config/startup-assert.ts`) **stay as-is** as deploy-to-flip kill-switches.
- Use a PostHog flag only when a rollout actually needs per-user %-gating (10% → 50% → 100%) or A/B. The dark-ship pattern (PR #56 edit-replies) already uses env-var flags successfully — no need to migrate working kill-switches.

### Deploy strategy
- **Vercel rolling deploys** built-in; sufficient at current scale.
- **Railway rolling deploys** for worker.
- Canary deploys (10% traffic to new) not needed yet — revisit at 100k DAU.
- Blue/green only when downtime tolerance hits zero.

### Rollback playbook
- **`docs/runbooks/rollback.md`** with:
  - Vercel rollback command (`vercel rollback <deployment-id>`).
  - Railway rollback command (Railway dashboard or CLI).
  - Migration reversal: locate the down migration, run on prod (with confirmation).
  - Feature flag kill switch.
  - "Who to tell when": status page, customers via email if user-impacting > 5 min.
- **Practice quarterly** (drill via [Spec 08](./08-reliability-sre.md)).

### CI pipeline
| Stage | Tool | Budget |
|---|---|---|
| Install + cache | pnpm | < 1 min |
| Lint | ESLint | < 1 min |
| Type-check | tsc | < 2 min |
| Unit tests | Vitest | < 2 min |
| Integration tests (parallel) | Vitest + real services | < 4 min |
| Build | Next.js | < 2 min |
| **Total** | | **< 10 min** |

E2E (Playwright) runs on `main` push (not on every PR) due to time cost. Smoke check post-deploy is faster.

### Secrets rotation cadence
| Secret | Cadence | Runbook |
|---|---|---|
| Stripe webhook secret | Every 6 months | `docs/runbooks/secrets-rotation-stripe.md` |
| Supabase service key | Annually | `docs/runbooks/secrets-rotation-supabase.md` |
| OAuth refresh tokens (per-customer) | Automatic via Google / Zernio | — |
| RepWorth API keys (customer-issued) | Quarterly | `docs/runbooks/secrets-rotation-api.md` |
| Resend / Twilio API keys | Annually | `docs/runbooks/secrets-rotation-providers.md` |

Calendar reminders on the day-of for each.

### Environment parity
- 3 environments: **local**, **staging**, **prod**.
- Local: Supabase local CLI + Upstash local or skip-cache mode + `MOCK_EXTERNAL_APIS=true`.
- Staging: dedicated Supabase project + Upstash dev + Stripe test mode.
- Prod: real services.
- `.env.example` documents every env var.
- `worker/config/startup-assert.ts` asserts critical envs present at boot (CLAUDE.md).

### Branch protection
- `main` is protected:
  - PR required.
  - Status checks required (lint, type, unit, integration, tenant-isolation).
  - 1 approver required.
  - No direct pushes.
  - Force push disabled.

### Deploy notifications
- Slack `#deploys` channel posts: deployer, commit, status (green/red), preview URL, prod URL.
- Vercel + Railway both integrate natively.

## 4. Implementation tasks

0. ✅ **Stand up GitHub Actions CI — first secret-free slice shipped + enforced.** `.github/workflows/ci.yml` runs `lint`, `typecheck`, `test`, and `build` on PRs and `main` pushes; `.github/` includes the composite setup action, Dependabot, PR template, and CODEOWNERS; branch protection is live (RepWorth-org "main protection" ruleset requiring the four checks). Follow-up: add `test:integration` once `TEST_DATABASE_POOL_URL` is available as a GitHub secret, and add Playwright on `main`/scheduled/staging runs.
1. Document rollback playbook at `docs/runbooks/rollback.md`. Include Vercel + Railway commands + migration down + flag kill switch + comms template.
2. Set up Railway PR environments (GitHub integration in Railway dashboard).
3. Feature-flag decision resolved (Step 0): env-var flags stay as kill-switches; add PostHog feature flags (per §2a) for %-rollout. Wire `posthog-node` flag evaluation only on the first rollout that needs %-gating — no upfront migration of existing env-var flags.
4. ✅ **Branch protection set** — RepWorth-org "main protection" ruleset requires the four checks (`lint`/`typecheck`/`test`/`build`) and blocks force-push + deletion. Add DB-integration and Playwright checks to the required set later when those gates exist.
5. Add Slack `#deploys` channel + Vercel/Railway webhook integrations.
6. Author secrets-rotation runbooks per §3. Calendar reminders.
7. Audit CI pipeline runtime. Parallelize where possible. Target < 10 min.
8. Document zero-downtime migration patterns in `docs/runbooks/migrations.md` (lots already in CLAUDE.md gotchas — formalize).
9. Add `.env.example` audit script: ensure every `process.env.*` has a corresponding entry.
10. Quarterly rollback drill calendar entry.

## 5. Acceptance criteria

- [x] GitHub Actions CI exists (`.github/workflows/ci.yml`) running `lint`, `typecheck`, `test`, and `build` as the first secret-free gate.
- [ ] GitHub Actions CI runs database-backed integration tests with `TEST_DATABASE_POOL_URL`.
- [ ] Vercel + Railway PR preview URLs auto-post on every PR.
- [x] Branch protection enforced; direct pushes to `main` blocked (requires CI status checks above). Implemented as a **repository ruleset** ("main protection") — not classic branch protection — since the repo is a private repo under the RepWorth org (Team plan). Requires the four checks (`lint`/`typecheck`/`test`/`build`) and blocks force-push + deletion, enforced for all actors.
- [ ] Feature flag tool live; at least one feature gated behind a flag.
- [ ] `docs/runbooks/rollback.md` exists and was tested in a quarterly drill.
- [ ] Slack `#deploys` posts deployments in real-time.
- [ ] Secrets rotation log shows each cadence honored.
- [ ] CI runs < 10 min on average over last 30 PRs.
- [ ] `.env.example` matches `process.env.*` usage (audit script clean).

## 6. Metrics

| Metric | Target |
|---|---|
| CI run time | < 10 min |
| Deploy frequency | ≥ daily |
| Rollback time (MTTR after detection) | < 15 min |
| Feature-flag usage on new features | 100% |
| Secret rotation lateness | 0 days past cadence |
| Failed deploys / week | < 1 |

## 7. Risks & mitigations

- **Risk:** Migration drift between staging and prod. **Mitigation:** staging dry-run required; document deviations.
- **Risk:** Feature flag accumulates indefinitely (flag debt). **Mitigation:** flag has owner + retirement date; quarterly cleanup PR.
- **Risk:** PR preview leaks data to public URL. **Mitigation:** preview env uses staging data only; auth still required.

## 8. Dependencies & cross-links

- [Spec 08 — Reliability](./08-reliability-sre.md) (rollback drill, status page)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (secrets rotation, CI security scans)
- [Spec 22 — AI/LLM Operations](./22-ai-llm-ops.md) (LLM eval in CI)
- [Spec 23 — Testing & QA](./23-testing-qa.md) (gates)
- Code anchors: `supabase/migrations/` (head 042), `worker/config/startup-assert.ts` (env-var flags), `.env.example`, `.claude/skills/migrations.md`
- Gotchas: partial-unique-index predicate byte-match; IMMUTABLE-only in index predicates (CLAUDE.md)

## 9. Implementation in the current repo

- **This spec is the keystone.** The shipped `.github/` + secret-free CI gate now unblocks the "fail the build" tasks in Specs 07/08/09/12/19/22/23/25. Sequence the remaining CI gates next: DB-backed integration, e2e, then security/a11y/eval checks.
- **CI is no longer greenfield** — the first secret-free GitHub Actions gate now runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Next CI steps are integration with `TEST_DATABASE_POOL_URL`, e2e on `main`/scheduled/staging runs, then security/a11y/eval gates.
- **Flags**: the env-var pattern + `startup-assert.ts` already work as kill-switches and powered the edit-replies dark-ship (PR #56). Only adopt a flag *tool* if/when %-rollout is needed — and pin that to the §2a analytics decision.
- **Migrations stay owner-run** via Supabase SQL editor until a hire; formalize the zero-downtime patterns (already in CLAUDE.md gotchas) into `docs/runbooks/migrations.md`.
- **No IaC files** (`vercel.json`/`railway`/`Dockerfile`) — dashboard config is fine at this scale; document it rather than introduce IaC prematurely.

---
_Verified 2026-05-23 against migration head 042; updated 2026-05-24 after the first secret-free CI slice shipped **and branch protection was enabled** (RepWorth-org ruleset). CI remains the task-0 keystone for follow-up integration + e2e gates; corrected the feature-flag reality (env-var booleans, not PostHog), the absent IaC files, and the missing rollback runbook._
