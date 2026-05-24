# Spec 13 — Customer Support

> **Goal:** Email + in-app chat + searchable KB day 1, tiered response SLA, Help Scout as the spine, admin impersonation behind 2FA + audit, top-20 macros maintained.

---

## 1. Why this matters

Support quality is a retention lever and a hiring signal. The right tools at the right stage avoid two anti-patterns: founder drowning in Slack DMs, or paying for Zendesk before any volume exists.

## 2. Current state (RepWorth)

_Verified 2026-05-23 against the live tree (migration head 042)._

- No support tooling (no Help Scout/Crisp/Plain/Intercom/Zendesk), no `/help` KB, no Mintlify/Docusaurus — all greenfield.
- **No admin impersonation** and no `impersonation_sessions` table. An admin area exists (`src/app/admin/*`: overview, businesses, costs, demos, jobs, notifications, runbook) to host it.
- Settings has tabs General/Account/BrandVoice/Channels/Locations (+ per-location overrides) but **no Export-my-data / Delete-account / API-token UI** yet (greenfield; data-export/delete cross-refs [Spec 09](./09-security-compliance.md)).
- Impersonation audit should reuse the existing **`account_audit_log`** (migration 034), consistent with [Spec 04](./04-auth-identity.md) — not a fresh audit table.
- `report@`/`support@` mailboxes not confirmed in repo.

## 3. Target state

### Channels (day 1)
| Channel | Tool | When to use |
|---|---|---|
| Email | Help Scout | Async, all tiers |
| In-app chat | Plain (modern) or Crisp (cheaper) | Real-time, all tiers, business hours |
| Knowledge base | Mintlify or Docusaurus | Self-serve, public |
| Community forum | Skip until 500+ paying customers | — |

### Response SLAs (per tier)
| Tier (live names) | First-response SLA | Resolution target |
|---|---|---|
| Basic / Founders | 24 business hours | 3 business days |
| Standard | 8 business hours | 1 business day |
| Premium | 2 business hours + dedicated CSM | 4 business hours |

Auto-responder confirms receipt with ticket ID, expected SLA. Published on `/help/contact`.

### Help Scout setup
- Shared inboxes: `support@`, `billing@`, `security@`, `report@`.
- Tags: tier, vertical, issue category, root-cause category.
- Saved replies (macros) for top 20 questions.
- Workflows: route Scale-tier emails to a dedicated queue (alerts founder/CSM).
- Reporting: monthly first-response SLA hit-rate, CSAT, top-issue trends.

### In-app chat
- **Plain** if budget allows ($35/agent/mo, Slack-style threads, great DX).
- **Crisp** if budget tight ($25/agent/mo, more features but older UX).
- Office hours visible to customer; outside hours route to email queue.

### Knowledge base
- **Mintlify** preferred (best DX, AI search, auto-generated OpenAPI rendering for the future API).
- Hosted at `docs.repworth.com`.
- Top 5 articles drive ~60% of self-serve resolutions:
  1. How to connect Google Business Profile
  2. Why is my response pending?
  3. How to set brand voice
  4. Pricing & billing FAQ
  5. Multi-location setup
- Article structure: problem statement, prerequisites, step-by-step (with screenshots), troubleshooting, next steps.
- Versioned per major API release (when API ships, see [Spec 20](./20-api-integrations.md)).
- CI: dead-link checker + code-snippet executor (snippets break the build if out of date).

### Admin impersonation
- **Feature-flagged + 2FA + audit log every action.**
- Workflow:
  1. Admin opens "Login as customer X" UI from admin tool.
  2. Required field: support ticket ID + reason text.
  3. Audit row written: `actor_user_id`, `impersonated_user_id`, `ticket_id`, `reason`, `started_at`, `expires_at`.
  4. Time-boxed session (1 hour, no extension).
  5. Banner during session: "Impersonating <customer-email> — All actions logged."
  6. Cannot perform destructive actions (account delete, billing cancel, password change).

### Macros / canned responses
- Maintain top 20 macros in Help Scout, mirrored in `docs/support/macros/*.md` for version-control.
- Audit monthly: if a question is in top 5 for 2 months, write KB article + update macro to link.

### Customer self-serve admin actions
- Settings → Billing → Cancel (see [Spec 05](./05-billing-subscription.md)).
- Settings → Privacy → Export My Data (see [Spec 09](./09-security-compliance.md)).
- Settings → Privacy → Delete My Account (30-day soft delete).
- Settings → API → Generate / Revoke API tokens (see [Spec 20](./20-api-integrations.md)).

## 4. Implementation tasks

1. Subscribe Help Scout. Configure inboxes + tags + workflows.
2. Subscribe Plain or Crisp. Wire chat widget into the `src/app/(authenticated)/dashboard/*` layout. Hide outside business hours.
3. Stand up Mintlify docs at `docs.repworth.com`. Seed with top 5 articles + GBP setup guide.
4. Build admin impersonation flow:
   - Migration (next free number; head 042 — coordinate per README): `impersonation_sessions(id, actor_user_id, impersonated_user_id, ticket_id, reason, started_at, expires_at, ended_at)`.
   - Admin UI page `src/app/admin/impersonate/page.tsx` (sibling to existing admin pages).
   - Write an `account_audit_log` row per session start/end (reuse the existing table); tag session traffic `impersonating: true`.
   - 1-hour TTL; banner UI; destructive actions blocked.
5. Author top 20 macros. Track usage monthly.
6. Add auto-responder template referencing tier + SLA + ticket ID.
7. Build `/help/contact` page surfacing channels + SLAs.
8. Wire customer self-serve admin actions per §3.
9. Document support runbook `docs/runbooks/support-rotation.md` (until first hire: founder is on call, business hours US ET).

## 5. Acceptance criteria

- [ ] Help Scout receiving emails on all four inboxes with workflows routing to correct queues.
- [ ] In-app chat visible in dashboard during business hours.
- [ ] Mintlify docs live with the top-5 articles published.
- [ ] Admin impersonation flow tested end-to-end; audit row written; destructive actions confirmed blocked.
- [ ] Auto-responder fires within 60s on incoming email.
- [ ] First-response SLA tracked weekly; hit-rate ≥ 95% per tier.
- [ ] Top-20 macros published and version-controlled.

## 6. Metrics

| Metric | Target |
|---|---|
| First-response SLA hit rate (all tiers) | ≥ 95% |
| CSAT | ≥ 90% |
| Self-serve resolution rate (top-5 KB articles) | ≥ 60% of new tickets |
| Impersonation sessions / month | Tracked, audited; outlier flagged |
| KB article TTL (refresh cadence) | ≤ 6 months |

## 7. Risks & mitigations

- **Risk:** Solo founder drowns in support volume. **Mitigation:** macros + KB + self-serve admin actions reduce volume; first hire at $20–30k MRR is CS-generalist ([Spec 27](./27-team-knowledge.md)).
- **Risk:** Impersonation abused. **Mitigation:** time-boxed + audit + destructive-action block; monthly review of impersonation log.
- **Risk:** KB drifts and gives wrong answers. **Mitigation:** dead-link CI + 6-month refresh cadence with explicit owner.

## 8. Dependencies & cross-links

- [Spec 04 — Auth & Identity](./04-auth-identity.md) (admin impersonation auth model)
- [Spec 05 — Billing & Subscription](./05-billing-subscription.md) (self-serve cancel)
- [Spec 09 — Security & Compliance](./09-security-compliance.md) (data export, account delete)
- [Spec 14 — Customer Success & Retention](./14-customer-success-retention.md) (CSM motion)
- [Spec 25 — Documentation](./25-documentation.md) (Mintlify infra)
- Code anchors: `src/app/admin/*`, `src/app/(authenticated)/settings/*`, `account_audit_log` (migration 034)

## 9. Implementation in the current repo

- **Everything except impersonation is third-party signup + config** (Help Scout, Crisp/Plain, Mintlify) — no code prerequisites.
- **Impersonation** is the one in-repo build: a new `impersonation_sessions` table + an `src/app/admin/impersonate` page (the admin shell already exists), reusing `account_audit_log` for the audit trail and the existing `src/middleware.ts` for the destructive-action block + banner gating.
- **Self-serve admin actions** (export/delete/API tokens) attach to the existing `SettingsShell` tab strip; export/delete cross-ref [Spec 09](./09-security-compliance.md), API tokens cross-ref [Spec 20](./20-api-integrations.md).
- **KB CI** (dead-link checker / snippet executor) needs a specialized docs/support workflow added to the existing base CI ([Spec 24](./24-devops-deployment.md)).

---
_Verified 2026-05-23 against migration head 042. Aligned SLA tiers to live names (basic/standard/premium); pointed impersonation audit at the existing `account_audit_log`; fixed dashboard path + migration numbering; noted the admin shell + settings tabs that already exist._
