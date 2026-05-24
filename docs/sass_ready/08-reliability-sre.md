# Spec 08 — Reliability, SRE & Incident Response

> **Goal:** Published 99.9% / 99.5% SLOs, public status page, P0–P3 severity ladder with documented response times, runbook for every top-10 alert, quarterly DR drill, blameless postmortems.

---

## 1. Why this matters

Reliability is invisible until it isn't. Customers don't reward great uptime; they punish bad uptime forever. Bootstrapped SaaS at RepWorth's stage doesn't need multi-region — it needs **discipline**: documented SLOs, tested backups, and a postmortem culture.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- Runbook coverage is real but partly archived: `operational-runbook.md`, `multi-location.md`, `smoke-test-checklist.md` live in `docs/runbooks/`; `zernio-ingestion-test-runbook.md`, `email-deliverability.md`, `signup-test-runbook.md` have moved to `docs/runbooks/completed_runbooks/`.
- No public status page; no documented uptime SLO; no `docs/sre/` directory.
- **Supabase PITR is on but has never been restored end-to-end** — the single most important untested assumption in this spec.
- No `docs/postmortems/` directory; no `/trust` page; no `/changelog/incidents`.
- ✅ **Base CI + branch protection now exist; infra-as-code is still absent:** the secret-free GitHub Actions gate runs `lint`, `typecheck`, `test`, and `build`, and **direct pushes to `main` are now blocked** (RepWorth-org "main protection" ruleset requires the four checks). There is still no `vercel.json`, no `railway.{json,toml}`, and no `Dockerfile` (Vercel/Railway are dashboard-configured), and the reliability-specific change-management gates (staging dry-run, smoke test in PR) remain follow-up work (see [Spec 24](./24-devops-deployment.md)).
- **Health checks:** worker has `/api/health` (Fastify :3001); Next.js has none — synthetic checks need a Next.js health route first ([Spec 07](./07-observability.md)).

## 3. Target state

### Uptime SLO
| Surface | SLO | Allowed downtime/mo |
|---|---|---|
| Customer-facing UI (Vercel) | 99.9% | ~43 min |
| Worker / background processing (Railway) | 99.5% | ~3.6 hr (worker lag doesn't equal downtime) |
| Webhook ingestion (Stripe / Zernio / Resend / Twilio) | 99.9% | ~43 min |

Published on `/trust` page (see [Spec 29](./29-repworth-specific-gaps.md)).

### Status page
- **Instatus** (cheaper) or **BetterStack** (already chosen for logs — bundle).
- Auto-fed from synthetic checks.
- Public at `status.repworth.com`. Linked from footer, login page, dashboard.
- Subscribe-by-email for customers.

### Severity ladder
| Level | Definition | Ack | Comms | Resolve target |
|---|---|---|---|---|
| **P0** | Customer-facing outage, data loss, security breach | < 15 min | Status page + email within 30 min | < 4 hr |
| **P1** | Degraded service affecting many customers | < 1 hr | Status page if > 50% impacted | < 24 hr |
| **P2** | Limited impact (single account, single feature) | < 24 hr | None | Next business day |
| **P3** | Cosmetic | Backlog | None | Backlog |

### Runbook coverage
**Every top-10 alert has a runbook.** Each runbook contains:
- Trigger condition (Sentry rule, synthetic check, manual report).
- First 5 commands to run (with copy-paste shells).
- Escalation path (whom to ping if first 5 don't resolve).
- Rollback steps (deploy revert, migration reversal).
- Postmortem expectation (P0/P1 require, P2/P3 optional).

Current runbook list is solid. Maintain pattern; add a runbook every time a new alert is created.

### Disaster recovery
- **RPO ≤ 1 hour** via Supabase PITR.
- **RTO ≤ 4 hours** (full restore + DNS + worker boot).
- **Quarterly DR drill**: restore prod backup to staging Supabase project, run smoke test, document elapsed time in `docs/runbooks/dr-drill-YYYY-QN.md`.
- First drill mandatory before claiming any SLO publicly.

### Backups
- Supabase Pro PITR (already on).
- Weekly automated export to S3-compatible storage (Backblaze B2 or Cloudflare R2) — defense in depth in case of Supabase outage or account compromise.
- Test restore quarterly (combined with DR drill).

### Multi-region
- **Accept single-region for the first 12 months.** Document the dependency on `status.repworth.com` honestly.
- Revisit at $500k ARR or first enterprise deal that demands it.

### Postmortems
- Blameless template in `docs/postmortems/_template.md`.
- File at `docs/postmortems/YYYY-MM-DD-<slug>.md` for every P0 and select P1s.
- Sections: timeline, customer impact, root cause, what went well, what didn't, action items with owners and dates, prevention.
- Public-facing summary on blog (transparency wins).

### Change management
- Major changes (migrations, infra) require:
  - Linked design doc or ADR.
  - Staging dry-run.
  - Rollback steps documented in PR description.
  - Smoke test from `docs/runbooks/smoke-test-checklist.md`.

## 4. Implementation tasks

1. Subscribe BetterStack status page, configure auto-feed from synthetic checks. Map check failures to component states.
2. Publish status page at `status.repworth.com` (CNAME). Link from footer, dashboard error states, login page.
3. Define SLO targets in `docs/sre/slos.md`. Tie to alert thresholds in Sentry / BetterStack.
4. Define severity ladder in `docs/sre/severity-ladder.md`. Cross-link from every runbook.
5. Create `docs/postmortems/_template.md` and `docs/postmortems/README.md` (the index).
6. **Do the first PITR restore now** — don't wait for a quarterly cadence to discover it's broken. Restore prod to staging, run the smoke test, record elapsed time in `docs/runbooks/dr-drill.md`. Then schedule it quarterly.
7. Set up weekly S3 backup export. Because the shipped base CI is secret-free, prefer a **Railway cron** that calls Supabase `pg_dump` → B2/R2 until a secret-bearing scheduled backup workflow is designed ([Spec 24](./24-devops-deployment.md)).
8. Audit current runbooks; ensure each has the five required sections.
9. Update Sentry alert rules to tag with severity (`severity:p0`, `severity:p1`, etc.) — drives routing in [Spec 07](./07-observability.md).
10. Add a "What broke" public page at `/changelog/incidents` summarizing last 12 months' incidents (auto-generated from postmortems).

## 5. Acceptance criteria

- [ ] `status.repworth.com` live and updates automatically from synthetic checks.
- [ ] SLO document published internally and on `/trust`.
- [ ] Severity ladder documented and every runbook references it.
- [ ] First DR drill completed; RTO measured; gaps logged.
- [ ] Weekly S3 backup running for 4 consecutive weeks before claiming compliance.
- [ ] Postmortem template + 1 example postmortem committed.
- [ ] Every Sentry P0/P1 alert maps to a runbook URL.

## 6. Metrics

| Metric | Target |
|---|---|
| Monthly UI uptime | ≥ 99.9% |
| Monthly worker uptime | ≥ 99.5% |
| Mean time to detect (MTTD) | < 5 min for P0 |
| Mean time to acknowledge (MTTA) | < 15 min for P0 |
| Mean time to resolve (MTTR) | < 4 hr for P0 |
| DR drills completed | ≥ 4/year |
| Postmortems on P0 incidents | 100% |

## 7. Risks & mitigations

- **Risk:** Publishing SLO + status page exposes you to scrutiny. **Mitigation:** that's the point — discipline forces operational maturity. Pick conservative SLOs and beat them.
- **Risk:** DR drill reveals brokenness. **Mitigation:** that's why you drill — better to find in staging than during a real incident.
- **Risk:** Solo-founder cannot meet 4-hr P0 MTTR if asleep / unavailable. **Mitigation:** combined with [Spec 27](./27-team-knowledge.md) bus-factor plan; status page + email warns customers honestly.

## 8. Dependencies & cross-links

- [Spec 07 — Observability](./07-observability.md) (synthetic checks, alert routing)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (incident response, breach notification)
- [Spec 24 — DevOps & Deployment](./24-devops-deployment.md) (rollback playbook, migration patterns)
- [Spec 27 — Team & Knowledge Management](./27-team-knowledge.md) (bus factor, emergency access)
- [Spec 29 — RepWorth Gaps](./29-repworth-specific-gaps.md) (`/trust` page)
- Code anchors: `docs/runbooks/operational-runbook.md`, `docs/runbooks/smoke-test-checklist.md`, `docs/runbooks/completed_runbooks/`, `worker/index.ts` (Fastify `/api/health`)

## 9. Implementation in the current repo

- **The cheapest win with the biggest risk reduction is the first PITR restore.** Everything else (SLO publishing, status page) is downstream of trusting the backup.
- **Status page + synthetic checks** depend on a Next.js `/api/health` route (only the worker has one). Build that route, then point BetterStack at both health endpoints.
- **Change-management controls:** "no direct push to `main`" is **done** (RepWorth-org branch-protection ruleset requires the four CI checks). The remaining controls — staging dry-run and smoke test in PR — still need reliability-specific CI gates and remain follow-up work in [Spec 24](./24-devops-deployment.md).
- **Backups** run as a Railway cron alongside the existing `worker/background/` loops until a secret-bearing scheduled GitHub Action is designed on top of the base CI.
- **Runbook audit** is doc-only: ensure each surviving runbook (and the archived ones if reactivated) carries the five required sections.

---
_Verified 2026-05-23 against migration head 042; updated 2026-05-24 (base CI + branch protection now live). Corrected runbook locations (3 archived to completed_runbooks/), flagged the never-tested PITR restore, the still-missing smoke/deploy controls, the no-IaC reality, and the missing Next.js health route._
