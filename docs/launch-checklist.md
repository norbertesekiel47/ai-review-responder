# RepWorth — Launch Checklist

> **Created:** 2026-05-27 · **Owner:** @norbertesekiel
>
> The launch-slice code (Step 0/1 + Waves 1–3) is complete and merged to `main`.
> **Nothing on this list is code** — these are the external/vendor gates and
> operational drills that stand between RepWorth and a safe launch. Source:
> [`docs/sass_ready/updates.md`](./sass_ready/updates.md).
>
> Check items as they land. Don't launch with an unchecked **🔴 Hard blocker**.

---

## 🔴 Hard blockers — do not launch without these

- [ ] **First PITR restore drill** (Spec 08) — PITR is *enabled* but has **never
  been restored end-to-end**. Runbook now exists:
  `docs/runbooks/pitr-restore-drill.md`. Remaining: **run** the clone-to-new-project
  drill, verify integrity, and **record the measured RTO** in that runbook's
  results table. _Highest risk-reduction per hour of any item here._
- [x] **Email auth: DKIM + SPF + DMARC** (Spec 28) — verified 2026-06-26: Resend
  reports `repworth.net` **verified**; DKIM TXT at `resend._domainkey`, SPF
  (`include:amazonses.com`) on `send.repworth.net`, DMARC published. _Follow-up
  (non-blocking): DMARC is at `p=quarantine` — tighten to `p=reject` after clean
  aggregate reports, and point `rua` at a RepWorth-owned mailbox._ The entire
  product hinges on approval emails reaching the inbox; unauthenticated mail
  silently lands in spam and breaks the core loop.
- [ ] **Lawyer review of legal docs** (Spec 17) — ToS / Privacy Policy / AUP /
  DPA are live at `/legal/*` but **unreviewed**. `docs/legal/legal-review.md`
  is a placeholder. _Long lead time — start immediately, in parallel with
  everything else._
- [ ] **Insurance binding** (Spec 17) — $1M E&O + Cyber bound by the first paid
  customer. Get quotes now; `docs/legal/insurance.md` is a placeholder.

---

## 🔴 Beta-launch gate (added 2026-06-19) — see `docs/runbooks/beta-launch-alerting.md`

Gates the **first paying customer** per ADR 0005. The code half ships in
`harden/beta-launch-gate`; these are the operating constraints + dashboard wiring.

- [ ] **`AUTO_APPROVAL_ENABLED=false`** confirmed in prod — owner approval is the
  content-safety control for irreversible public posting. Auto-approval go-live is
  a separate gate (prod moderation validation + canary + kill-switch drill).
- [ ] **`SENTRY_DSN` set in prod** — now a hard boot gate (`assertAlertSinkEnv`);
  the worker refuses to start without the non-email alert sink.
- [ ] **Sentry alert routing → Slack/PagerDuty** for `subsystem:health_alert` and
  `cost_event:limit_exceeded`, plus `subsystem:import_consent_analytics` (#697 —
  a P2 whose signal is *repetition*, so route it on an event-frequency
  condition, not on "a new issue is created"; alerting runbook §1).
- [ ] **Sentry Cron monitor `health-alert-poller`** + **external `/ready`
  synthetic check** (worker + Next.js) configured.
- [ ] **Alerting acceptance drills** run on staging (runbook §4).
- [ ] **Operating constraint — subscription invoices only.** During beta, do NOT
  create one-off/manual Stripe invoices for live accounts: `invoice.payment_failed`
  is not yet scoped to the current subscription (worker-scaling backlog P4 #11), so
  an unrelated invoice for the same Stripe customer could wrongly flip a paying
  account to `past_due`. The `invoice.subscription` scoping fix lands later.

---

## 🟠 Production env / vendor gates — shipped features are inert without these

- [ ] **`POSTHOG_API_KEY` in prod** — the first-party analytics queue +
  activation funnel (Wave 2, mig 046/049) are no-ops until this is set.
- [ ] **`IMPERSONATION_COOKIE_SECRET`** (≥32 chars) — required for the admin
  "view-as" support flow (Wave 2, mig 048).
- [ ] **`OPENAI_MODERATION_ENABLED` + threshold tuning** (Spec 10) — turns on
  the second moderation layer. Local regex rules always run; this adds the
  OpenAI Moderation pass. Tune the threshold before relying on it.
- [ ] **Help Scout inboxes** (Spec 13) — set up `support@` / `billing@` /
  `security@` / `report@` before first paying customer. Finish the macro catalog
  (6 of 20 shipped).
- [ ] **Smoke-test against prod config** — after the env vars above are set,
  manually exercise: activation funnel event → PostHog; admin impersonation
  start/stop; moderation flag → `/admin/flagged`.
- [ ] **Re-confirm the sub-processor list** (Spec 17) once PostHog is live in
  prod — keep `/legal/sub-processors` accurate (compliance correctness).

---

## 🟡 Quick wins — cheap, high-signal (hours, not days)

- [ ] **`docs/runbooks/rollback.md`** (Spec 24) — Vercel + Railway rollback
  commands, migration-reversal note, kill-switch flip, customer comms. _Have
  this before any prod incident, not after._
- [ ] **`docs/runbooks/secrets-rotation-*.md`** (Spec 24) — at least the Stripe
  + Supabase rotation procedures.
- [ ] **`CONTEXT.md`** at repo root (Spec 25) — human-readable wrapper for
  CLAUDE.md.
- [ ] **`docs/icp.md`** (Spec 01) — lock ICP / JTBD before writing launch copy.

---

## 🟢 Strongly recommended before launch (not strictly blocking)

- [ ] **Wire `TEST_DATABASE_POOL_URL` in CI** (Specs 03/23/24) — flips the
  cross-tenant isolation test + integration suite from self-skip to hard-gated.
  This is the strongest correctness guarantee you have; right now it doesn't run
  in the PR gate.
- [ ] **Sentry P0–P2 alert routing** (Spec 07) — structured logs + Sentry init
  exist, but severity routing isn't configured. Without it, observability is
  "logs exist" not "alerts fire."

---

## ✅ Already done (for reference — no action needed)

- Step 0 decisions (analytics, flags, ESP, legal routing, audit home, CSV cap)
- Step 1 keystones: base CI + branch protection (PR #57), `past_due_at` +
  audit helper (mig 043), worker analytics capture
- Wave 1: tenant-isolation test + RLS audit, billing reconciliation,
  security baseline + PHI scanner, `/legal/*` routes, approval-text snapshot
  (mig 044/045)
- Wave 2: analytics queue, TOTP MFA, past-due UX, admin impersonation,
  support KB/macros, CSV import (mig 046–049)
- Wave 3: structured logs + `/api/health`, model pinning + prompt policy +
  eval harness, output moderation + flagged-responses queue, sentiment + 5 KPIs,
  finance margin signals (mig 050–052)

---

## Post-launch (tracked separately — see `updates.md`)

First-90-day gap-closing, Wave 4 (Growth), Wave 5 (Scale/Maturity), and the
deferred Spec 29 gaps (3, 4, 8) are **out of scope for launch** and planned in
[`docs/sass_ready/updates.md`](./sass_ready/updates.md). Do not let them block
shipping.
