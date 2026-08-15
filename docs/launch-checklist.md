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

### Beta cohort decisions — locked 2026-08-09

> Status note (2026-08-09): the alerting/dashboard wiring above is confirmed
> **not yet done** — it still gates the first invite.

- **Tier model: the cohort lands on the new Copilot/Autopilot tiers.** The prod
  WS8 tier cutover (`docs/runbooks/ws8-tier-cutover.md` — migration 078 applies
  *inside* it, never out-of-band) must run **before the first invite**. Autonomy
  posture is unchanged (ADR 0005): `AUTO_APPROVAL_ENABLED=false` and
  `AUTOPILOT_PURCHASABLE=false`, so beta accounts onboard on Copilot; Autopilot
  opens later through its own separate gate.
- **Pricing: the first 10–15 beta businesses are free for 3 months**, as a
  **100%-off Stripe coupon** (`duration: 'repeating'`, `duration_in_months: 3`)
  applied at subscription creation during hand-onboarding (card up front at $0
  recommended, so month 4 converts without a chase). Deliberately NOT a 90-day
  trial: `TRIAL_ENABLED` is off in prod, the trial is 30-day by design
  (migration 069), and `trialing` is excluded from ranking tracking (invariant
  #11). The coupon keeps the account `active` with normal $0 subscription
  invoices — consistent with the subscription-invoices-only constraint above —
  and never touches a Stripe Price (immutable/grandfathered, invariant #9a).
  **Mechanics note — superseded 2026-08-14 (`admin-invite-funnel`).** The old
  note said the coupon would be applied Stripe-side during an out-of-band
  activation step, because admin-onboarded accounts couldn't self-pay (they
  dead-ended on an admin-handoff screen that no longer exists). **The owner now
  completes a real Stripe Checkout themselves**, and the comp rides that
  checkout: eligibility (`onboarded_by IS NOT NULL` on the primary Business, plus
  `BETA_COMP_COUPON_ID` set) is resolved once inside `applyTierSnapshot` and
  frozen onto the **Checkout attempt**, and `create-checkout-session.ts` emits it
  as `discounts` plus an explicit `payment_method_collection: 'always'` so the
  $0-due session still collects a card. On the coupon path
  `allow_promotion_codes` is **omitted entirely, not sent as `false`** — Stripe
  rejects it beside `discounts` **by parameter presence, not by value**, which is
  the defect that 500'd the first real staging checkout (**D-16**). A full-price
  session still sends it as `false`. There is
  no out-of-band activation step any more; "activation" is the owner finishing
  checkout. Plan of record:
  `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md`. Ops steps still
  outstanding (creating the coupon in both Stripe modes, setting the env var):
  `docs/runbooks/beta-onboarding-cofounder-guide.md` → Part 12.
- **Acquisition: landing-page early-access form → manual invites.** Leads come
  in via `LeadIntakeForm` (`/book-a-demo` + the pricing CTA anchor); onboarding
  is hand-run per account via `/admin/businesses/new` (admin + AAL2). The
  non-technical co-founder playbook for these meetings is
  `docs/runbooks/beta-onboarding-cofounder-guide.md`.
  `SELF_SERVE_SIGNUP_ENABLED` stays **`false`** until public-release readiness
  is decided — do not flip it for the beta. **(2026-08-14)** That is now a
  cost-free posture: since the flag was re-scoped to gate only anonymous
  account-minting, an invited beta owner logs in, recovers their password and
  walks the entire funnel with it off. The flag no longer has to be flipped for
  any beta invitee, and flipping it off never locks one out.

Pre-invite actions from these decisions:

- [ ] **Stand up the production backend** —
  `docs/runbooks/beta-production-standup.md` (added 2026-08-10; revised same
  day after adversarial review) is the ordered path: the prod Railway worker
  has **never deployed**, prod queue Redis and a prod Sentry project don't
  exist, and the boot-gate set is wider than deployment-guide §5.2's old
  callout records (full Stripe env + six price IDs + both tier cost limits are
  also hard boot gates). The stand-up sequences: land-the-plan → provisioning
  → env vars → **WS8 zero-state cutover containing the first worker deploy
  (077 → deploy → smoke → 078 → 105)** → remaining webhooks → beta activation
  path → alerting → smoke. Its phases subsume the items below; they stay listed
  as individually tickable gates. Note the cutover does **not** end at 078 —
  migration 105 is section 8 of `ws8-tier-cutover.md`, and skipping it fails
  every checkout once traffic resumes.
  *(This also resolved the 2026-08-09 `ZERNIO_PUBLISHING_ENABLED` discrepancy
  note: both prior readings described a worker that had never run. The flag is
  set deliberately during stand-up Phase B; fix the stale env-vars.md row in
  Phase G6.)*
- [ ] Run the prod WS8 tier cutover (`docs/runbooks/ws8-tier-cutover.md`) —
  stand-up Phase D. **077, 078 AND 105 are all WS8-only migrations** (077 =
  quiesced expand, 078 = strict contract, **105 = the coupon column + its
  constraint rewrite, applied LAST**) — never apply any of them as an ordinary
  missing migration; the first prod worker deploy happens between 077 and 078.
  **Do not stop at 078.** 105 replaces a constraint 077 created, so it cannot be
  applied before 077 — and the strict code deployed mid-cutover writes the column
  105 adds, so skipping it fails **every** checkout, not only admin-invited ones.
  It is section 8 of that runbook. (Migration **106** is NOT part of this — it is
  independent of 077 and was applied to prod on 2026-08-14.)
- [ ] **Implement + staging-test the beta activation path** — stand-up
  Phase F: server-selected 100% coupon on the leased checkout for
  admin-onboarded accounts (`allow_promotion_codes` **omitted** on that path —
  Stripe rejects it beside `discounts` by presence, not value; see **D-16**).
  The 3-months-free offer has **no supported activation path today**;
  dashboard-created subscriptions, raw-SQL binding, and manual invoices are
  forbidden substitutes.
- [ ] **BLOCKING — audit the legacy `onboarded_by` population before the coupon
  exists.** The comp's eligibility test is `onboarded_by IS NOT NULL` on the
  primary Business, and migration **025** backfilled that column on every row
  that predated it, pointing them all at the oldest admin/sales_partner user.
  Those rows are genuinely admin-onboarded (self-serve signup shipped in the
  same commit as the backfill, so there was no self-serve population to
  mislabel) — but a *legacy* admin-onboarded account still sitting in
  `pending_payment` would draw a 3-month comp the moment the live coupon exists,
  which is not who the beta comp is for. Count them and decide each one
  deliberately; do not create the coupon while this is unresolved:
  ```sql
  SELECT b.id, b.name, a.id AS account_id, b.created_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
   WHERE b.is_primary = TRUE
     AND b.archived_at IS NULL
     AND b.onboarded_by IS NOT NULL
     AND a.subscription_status = 'pending_payment'
   ORDER BY b.created_at;
  ```
  Expected at beta launch: only the accounts you deliberately invited. Anything
  older is a legacy row — settle it (activate, offboard, or accept the comp
  knowingly) before Phase F2. **Do not "fix" this by NULLing `onboarded_by`**:
  that would hand those accounts trial eligibility they must not have
  (`plan-activation.ts` gates trials on `onboarded_by IS NULL`) and would strip
  the `CleanupAbandonedSignupsPoller` reference guard. Raised by the step-7
  adversarial review; see `docs/reviews/admin-invite-funnel/`.
- [ ] Create the live-mode beta coupon (100% off, repeating, 3 months —
  verify `repeating` behaves against the pinned Stripe apiVersion) and record
  its ID here: `____` — stand-up Phase F2.
- [ ] Set `BETA_COMP_COUPON_ID` to that coupon in **Vercel production** and
  redeploy (Vercel does not pick up env changes without one). Server-only, no
  `NEXT_PUBLIC_*` companion. Until it is set, every attempt snapshots NULL and
  invitees are charged full price — the failure is a **charged founding
  customer**, not an error.
- [ ] **Set `ONBOARDING_DEMO_ENABLED=true` in Vercel production** and redeploy —
  stand-up Phase B flag audit / Phase F. **This is a required rollout step, not
  an optional enhancement, and its failure mode is SILENT.** With it off the
  invited owner still gets their password, still pays $0, still reaches the
  dashboard — nothing errors and nothing looks broken — but they never see place
  capture or the AI demo, so the live onboarding call loses the wow-moment the
  whole beta script is built around (`beta-onboarding-cofounder-guide.md` Part 5,
  steps 4–5). `resolveFunnelEntry` takes the flag as an argument, so with it off
  the journey degrades to password → `/onboarding/pay` → legacy 3-step wizard.
  **Vercel-only**: 15 read sites under `src/**`, zero under `worker/**` — a
  Railway flip changes nothing. Flip via the `flag-flip` skill.
- [ ] Walk `docs/runbooks/launch-flag-readiness.md` and append a fresh dated
  live snapshot — Railway AND the still-missing Vercel-side read — stand-up
  Phase G5.
- [ ] Validate provider moderation on a representative corpus with recorded
  false-positive/negative acceptance criteria
  (`docs/runbooks/auto-approval-provider-moderation-validation.md` — the
  provider check is **binary** `flagged`; there is no threshold knob), then
  flip `OPENAI_MODERATION_ENABLED` in prod — stand-up Phase G4.

---

## 🟠 Production env / vendor gates — shipped features are inert without these

- [ ] **`POSTHOG_API_KEY` in prod** — the first-party analytics queue +
  activation funnel (Wave 2, mig 046/049) are no-ops until this is set.
- [ ] **`IMPERSONATION_COOKIE_SECRET`** (≥32 chars) — required for the admin
  "view-as" support flow (Wave 2, mig 048).
- [ ] **`OPENAI_MODERATION_ENABLED` + corpus validation** (Spec 10) — turns on
  the second moderation layer. Local regex rules always run; this adds the
  OpenAI Moderation pass. The provider decision is **binary** (`flagged` →
  high severity; `src/lib/moderation/moderate.ts`) — there is no threshold
  knob. Before relying on it, validate against a representative sample corpus
  with recorded FP/FN acceptance criteria
  (`docs/runbooks/auto-approval-provider-moderation-validation.md`).
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
