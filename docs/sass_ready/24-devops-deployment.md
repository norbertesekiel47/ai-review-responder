# Spec 24 — DevOps & Deployment

> **Goal:** Vercel + Railway PR previews on every PR, zero-downtime migration patterns, PostHog feature flags for gradual rollout, documented rollback playbook, CI < 10 min, secrets rotation on calendar.

---

## 1. Why this matters

Deployment speed is iteration speed. The right CI/CD setup makes ship-3x-a-day cheap and rollback-in-2-min reliable. The wrong setup means founder is too scared to merge on Friday.

## 2. Current state (RepWorth)

- Vercel deploys (Next.js).
- Railway deploys (worker).
- Migrations owner-run via Supabase SQL editor (CLAUDE.md).
- Documented patterns for entry-point modularization, outbox, subscription guard.
- No documented rollback playbook.
- No feature flag tool integrated.

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
- **PostHog feature flags** (one less tool — already using PostHog for analytics).
- Alternative: **GrowthBook** if open-source / self-hosted preferred.
- Default-off, 10% → 50% → 100% over a week for every new feature.
- Kill switch in `posthog.feature_flag.<flag-name>` for instant disable.

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

1. Document rollback playbook at `docs/runbooks/rollback.md`. Include Vercel + Railway commands + migration down + flag kill switch + comms template.
2. Set up Railway PR environments (GitHub integration in Railway dashboard).
3. Adopt PostHog feature flags (or GrowthBook). Wrap first feature behind a flag.
4. Set GitHub branch protection rules per §3.
5. Add Slack `#deploys` channel + Vercel/Railway webhook integrations.
6. Author secrets-rotation runbooks per §3. Calendar reminders.
7. Audit CI pipeline runtime. Parallelize where possible. Target < 10 min.
8. Document zero-downtime migration patterns in `docs/runbooks/migrations.md` (lots already in CLAUDE.md gotchas — formalize).
9. Add `.env.example` audit script: ensure every `process.env.*` has a corresponding entry.
10. Quarterly rollback drill calendar entry.

## 5. Acceptance criteria

- [ ] Vercel + Railway PR preview URLs auto-post on every PR.
- [ ] Branch protection enforced; direct pushes to `main` blocked.
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
- Code anchors: `supabase/migrations/`, `worker/config/startup-assert.ts`, `.claude/skills/migrations.md`
- Gotchas: partial-unique-index predicate byte-match; IMMUTABLE-only in index predicates (CLAUDE.md)
