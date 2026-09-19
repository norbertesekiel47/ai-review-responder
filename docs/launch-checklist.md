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

> ### ✅ BETA TESTER ONE IS LIVE — 2026-09-16, @norbertesekiel
>
> The full loop ran in production and every step was verified by query, not by screen:
> admin sign-in on the Admin app → invite (`/invite` 200, email delivered) → **$0.00** checkout
> on the new **$49** Copilot founding price (card captured, discount ends 2026-12-16, so cycle 4
> bills $49) → Google connected → 31 reviews imported with consent → a live review drafted
> automatically by OpenAI → approval email **delivered** in 2.7 s → approval page audited
> read-only → **one owner-approved reply posted to Google** at 10:37:40Z with
> `approval_method='owner'`. 0 failed jobs, 0 held drafts, 0 Judge verdicts (correct — the Judge
> reviews auto-posts only). AI spend for the whole run: **$0.000168**.
>
> Prices changed the same week: Copilot **$79/$49**, Autopilot **$149/$99**, extra location at
> list price (#1290). Both environments were emptied first, so no account is grandfathered on the
> retired prices.
>
> **Still open before a wider cohort:** lawyer review of the legal documents and insurance
> binding. The alerting gaps closed on 2026-09-16 (drills §4.7 and §4.8, the
> `endpoint:admin-mfa-gate` rule `3999385`); U1's server half is an accepted risk, not a gap.
> Record: `docs/runbooks/evidence/2026-09-16-beta-tester-one-evidence.md`.

---

## 🔴 Hard blockers — do not launch without these

- [x] **Refusal ledger: staging ride — DONE 2026-08-31.** #1010, #1011 and #1012
  (slices 3-5 of map #994) merged to `main` **without** riding `staging` first,
  against `CLAUDE.md`'s worker rule. The waiver was sound only because production
  was provably empty at merge. The ride was then run retroactively, one commit at
  a time, in merge order:
  `220f0364` (#1012) → `7349acc6` (#1011) → `2ef07b4f` (#1010).
  Each deployed to the Railway staging worker **SUCCESS**, booted clean, and
  reported `postgres/queue_redis/cache_redis: ok`. No worker errors across the run.
  **The specific risk is closed:** all **27** lane tuples — every non-null code in
  all five category maps — were written through the REAL `writeRefusalEvent` and
  `writeRefusalEvents` helpers against the REAL staging schema, inside one
  transaction that was rolled back. Every one satisfied migration 116's five CHECK
  constraints, so no mis-mapped category can abort a deciding transaction. Staging
  `refusal_events` count before and after: **0**. No residue.
- [ ] **Refusal ledger: organic pipeline write (smaller residual, not a blocker).**
  The ride proved constraint conformance and clean boot; it did **not** drive an
  organic write through the full pipeline — no real batch build, dispatch, halt or
  auto-post revoke fired a Refusal on staging. Staging had no batch in a haltable
  state and `AUTO_APPROVAL_ENABLED=false`, so #1012's lane needs a flag flip to
  reach. Worth doing opportunistically the next time a staging solicitation loop
  runs; **not** a launch blocker, because the failure mode it would catch (a bad
  value aborting the transaction) is the one already closed above.

- [x] **First restore drill** (Spec 08) — ✅ **PASS, 2026-09-01.** Production
  `udeyaqnvpojbwgoaxwdg` was cloned from its daily physical backup
  (`2026-09-01T11:24:14Z`) via **Restore to a New Project**, verified, and the
  scratch project deleted. **Measured RTO 4 min 44 s** for a 17 MB database.
  Every predicted assertion held: 10 row counts identical, 6 id checksums
  identical, schema md5 `564fe5e8944da0a54757a3c840cbdc1c` (52 tables / 764
  columns / 278 indexes), `auth.users` intact, microsecond timestamps intact,
  head-116 object `refusal_events` present. Production served reads throughout
  and was unchanged afterwards. Real cost ≈ **$0.0007**. Evidence and verdict:
  `docs/runbooks/evidence/2026-09-01-pitr-restore-drill-evidence.md`; results
  table in `docs/runbooks/pitr-restore-drill.md` §7.
  _What this does NOT prove: restore time at real data volume (17 MB is a
  floor, not a forecast), and second-granularity recovery — see the next item._

- [ ] 🔴 **RPO decision — buy the PITR add-on, or accept a 24 h RPO for beta.**
  **Opened 2026-09-01 by the drill above; this is a NEW blocker, not a leftover.**
  **PITR is NOT enabled.** Measured, not assumed — `pitr_enabled: false` on
  production `udeyaqnvpojbwgoaxwdg` **and** on staging `kubdiqdhqbhwmqfditeg`,
  with `walg_enabled: true` on both. What exists is **daily physical backups on a
  7-day window**, so the true **RPO is up to 24 h**, not the ~2 min PITR gives.
  An earlier version of this checklist asserted PITR was enabled; that assertion
  was never verified and was false. Verify it yourself, no PAT needed:
  `supabase backups list --project-ref udeyaqnvpojbwgoaxwdg -o json | jq 'del(.backups)'`.
  **Price:** ~$100/month for 7-day retention (hourly $0.137), **not covered by
  the Supabase Spend Cap**, and it requires ≥ Small compute. Enabling it **stops
  daily backups** — PITR supersedes them.
  **Accepting 24 h is a defensible beta posture. Believing the RPO is 2 minutes
  is not.** Whichever way this goes, record it as a dated owner decision here.

  > ### ✅ DECIDED — 2026-09-01, @norbertesekiel
  >
  > **RepWorth runs beta on the existing daily physical backups and accepts an
  > RPO of up to 24 hours.** The PITR add-on is **not** bought at this time.
  >
  > **What is accepted:** in a data-loss incident, every write since the last
  > daily physical backup is unrecoverable — worst case ~24 h, best case minutes.
  > At beta scale (single-digit businesses, 17 MB of data) the recoverable
  > material is small and re-creatable: reviews re-ingest from Google, and drafts
  > regenerate. **Posted replies are the exception — they live on Google, not in
  > our database, so a restore cannot un-post or lose them.**
  >
  > **Why not buy it now:** ~$100/month against zero paying customers, not
  > covered by the Spend Cap, and enabling it **stops** the daily backups that
  > the 2026-09-01 drill actually proved end-to-end. Buying it would replace a
  > **demonstrated** recovery path with an undemonstrated one, on the eve of the
  > first live test.
  >
  > **Revisit trigger — this decision expires, it is not permanent.** Re-open the
  > moment ANY of these is true: (a) the first **paying** customer activates,
  > (b) production holds data for more than **5** businesses, or (c) any customer
  > contract or DPA states an RPO. Whichever comes first.
  >
  > **This closes the blocker as a recorded exception, not as a completed item.**
  > The box below stays unticked deliberately — the work was not done, the risk
  > was accepted.
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

- [x] **`AUTO_APPROVAL_ENABLED=false`** confirmed in prod — read on BOTH surfaces 2026-09-16 (Railway `production` and the Vercel Production env). The 2026-09-16 first post carries `approval_method='owner'`, which is the behavioural proof. — owner approval is the
  content-safety control for irreversible public posting. Auto-approval go-live is
  a separate gate (prod moderation validation + canary + kill-switch drill).
- [x] **Stripe live-mode activation** — ✅ **verified 2026-08-30**:
  `charges_enabled=True`, `payouts_enabled=True`, `details_submitted=True` on
  `acct_1TUcR7IhPBLaM6xA`, read with the production `sk_live_` key via
  `railway run --environment production`. **This item is new to this checklist and that
  is the point.** It was recorded on 2026-07-17 as `charges_enabled=false` — "no live
  payment (incl. prod smoke checkout) until complete" — inside an evidence file and
  nowhere else, so it silently stopped being tracked for six weeks while remaining a hard
  gate on WS8 §6 smoke and the entire beta coupon path. Evidence files are logs, not
  tracking surfaces; anything still owed at a pause belongs here. Reading recorded in
  `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` → D1d.
- [x] **`SENTRY_DSN` set in prod** — present on Railway `production` 2026-09-16, and the worker boots, which `assertAlertSinkEnv` would refuse without it. — now a hard boot gate (`assertAlertSinkEnv`);
  the worker refuses to start without the non-email alert sink.
- [ ] **Sentry alert routing → Discord** (sink decided 2026-08-30; Sentry has no Zoho Cliq
  integration and a Cliq bridge would put a translator service on the paging path) for
  `subsystem:health_alert` and
  `cost_event:limit_exceeded`, plus `subsystem:import_consent_analytics` (#697 —
  a P2 whose signal is *repetition*, so route it on an event-frequency
  condition, not on "a new issue is created"; alerting runbook §1).
- [ ] **Sentry Cron monitor `health-alert-poller`** + **external `/ready`
  synthetic check** (worker + Next.js) configured.
- [x] **DONE 2026-09-16 — 10 of 10.** The last two closed: §4.7 killed worker (staging uptime
  monitor `10354501`, page in 13 min, owner-confirmed in Discord) and §4.8 stopped probe
  (production's dead-man switch proven organically — miss → `REPWORTH-PRODUCTION-3` → rule
  `3925256` in 49 s → Discord). Evidence:
  `docs/runbooks/evidence/2026-09-16-alerting-gap-closure-evidence.md`.
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

- [x] **DONE — the production backend is live and proven end to end (2026-09-16).** See `evidence/2026-09-16-beta-tester-one-evidence.md`. Original text follows.
- [ ] ~~**Stand up the production backend**~~ —
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
  **Prod is already partway through that sequence (verified 2026-08-14):** 077
  and 105 are applied there, so §5 and §8 are **verify** steps and the live
  resume point is the worker deploy (§6). 078 is the only migration left.
  *(This also resolved the 2026-08-09 `ZERNIO_PUBLISHING_ENABLED` discrepancy
  note: both prior readings described a worker that had never run. The flag is
  set deliberately during stand-up Phase B; fix the stale env-vars.md row in
  Phase G6.)*
- [ ] Run the prod WS8 tier cutover (`docs/runbooks/ws8-tier-cutover.md`) —
  stand-up Phase D. **Migration 078 is the only one still to apply in prod**, and
  it applies *inside* the cutover (§7), never as an ordinary missing migration;
  the first prod worker deploy happens before it (§6), which is the live resume
  point.
  **077 and 105 are already applied in prod** (verified 2026-08-14 by the
  migration lockstep audit, #825): 077 was applied 2026-07-17T02:17:11Z and IS
  recorded — see that date's evidence file, "Quiescence + formal gates + phase 5"
  (the "landed unrecorded" wording was corrected 2026-08-30; only the Supabase
  migration ledger lacks it, because the SQL editor does not write there). 105
  was applied deliberately once that audit showed its only
  blocker — the 077 dependency — was already satisfied. **§5 and §8 are therefore
  verify steps in prod, not apply steps.** Staging has had all three since
  2026-07-16.
  What has NOT changed, and still governs any environment lacking them: 105
  replaces a constraint 077 created and cannot be applied before it, and the
  strict code deployed mid-cutover writes 105's column — so reaching that deploy
  without 105 fails **every** checkout, not only admin-invited ones.
  (Migration **106** was never part of this — independent of 077, applied to prod
  2026-08-14.)
- [x] **DONE — and proven in production 2026-09-16** with a live $0 checkout on the new $49 founding price (invoice total $0, card captured, discount ends 2026-12-16). Original text follows.
- [ ] ~~**Implement + staging-test the beta activation path**~~ — stand-up
  Phase F: server-selected 100% coupon on the leased checkout for
  admin-onboarded accounts (`allow_promotion_codes` **omitted** on that path —
  Stripe rejects it beside `discounts` by presence, not value; see **D-16**).
  The 3-months-free offer has **no supported activation path today**;
  dashboard-created subscriptions, raw-SQL binding, and manual invoices are
  forbidden substitutes.
- [x] **BLOCKING — audit the legacy `onboarded_by` population before the coupon
  exists.** ✅ **CLEARED 2026-08-30T22:28:33Z — zero rows, and permanently so.**
  The checklist query below was run verbatim against prod
  (`udeyaqnvpojbwgoaxwdg`) and returned **0 rows**. It cannot return rows again:
  every legacy row migration 025 backfilled was destroyed by the 2026-07-16
  36-table purge, and prod now holds **0 rows across all 52 `public` tables plus
  0 `auth.users`**. Any `onboarded_by IS NOT NULL` row created from here on is
  one you deliberately invited — which is exactly who the comp is for. **This
  gate is therefore satisfied by construction, not merely satisfied today**, so
  it does not need re-running before the coupon is created. Full evidence:
  `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` →
  "Zero-state proof". Original reasoning preserved below. The comp's eligibility test is `onboarded_by IS NOT NULL` on the
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
- [x] Create the live-mode beta coupon (100% off, repeating, 3 months —
  verify `repeating` behaves against the pinned Stripe apiVersion) and record
  its ID here: **`repworth-beta-comp-3mo`** — stand-up Phase F2.
  **Done 2026-08-31.** The id is the SAME in both Stripe modes:
  test `repworth-beta-comp-3mo` (pre-existing, created 2026-08-21) and live
  `repworth-beta-comp-3mo` (created 2026-08-31). One id in both modes makes the
  "test id deployed to live" failure the plan feared structurally impossible.
  **The `repeating` deprecation check PASSES.** Read back under the pinned
  `Stripe-Version: 2026-05-27.dahlia`: `percent_off=100`, `duration=repeating`,
  `duration_in_months=3`, `valid=true`, `livemode=true`. No fallback needed —
  the three cycle-scoped promotions are not required.
  The `onboarded_by` gate above was re-run verbatim against prod at the moment
  the live coupon came into existence: **0 rows.** See evidence file → **F.2**.
- [x] **DONE.** Set `BETA_COMP_COUPON_ID` to that coupon in **Vercel production** and
  redeploy (Vercel does not pick up env changes without one). Server-only, no
  `NEXT_PUBLIC_*` companion. Until it is set, every attempt snapshots NULL and
  invitees are charged full price — the failure is a **charged founding
  customer**, not an error.
- [x] **Set `ONBOARDING_DEMO_ENABLED=true` in Vercel production** and redeploy —
  ✅ **VERIFIED ALREADY TRUE 2026-08-31, on all four surfaces** (Railway prod/stg,
  Vercel prod/stg). No flip was needed. Read by `vercel env pull` to a mode-600 file;
  the running production deployment carries it. This box was open against a step that
  was already done — exactly the silent failure mode it warns about, inverted.
  Snapshot: `launch-flag-readiness.md` → 2026-08-31 four-surface read. Original text follows.
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
- [x] Walk `docs/runbooks/launch-flag-readiness.md` and append a fresh dated
  live snapshot — Railway AND the still-missing Vercel-side read — ✅ **DONE
  2026-08-31.** All four surfaces, 26 flags. It also discharged the open F8
  re-check and produced finding **G5-F1**: the Infisical Secret Sync does NOT
  preserve Vercel's Sensitive flag — production went from 9 `Secret` to 4, and
  the 4 survivors are exactly the 4 the vault does not manage. Original text: stand-up
  Phase G5.
- [x] Validate provider moderation on a representative corpus with recorded
  false-positive/negative acceptance criteria — ✅ **RUN 2026-09-18, both
  environments. VERDICT: PASS.** `OPENAI_MODERATION_ENABLED` was already
  flipped in prod on 2026-08-31, and the three outcome checks passed then.
  Staging and production now score 54/55 with identical results: FP 1/41
  (2.4%, inside the 5% budget), **FN 0**, provider misses 0, provider errors 0,
  safety errors 0, injection misses 0. Evidence:
  `docs/runbooks/evidence/2026-09-18-provider-moderation-corpus.md`. Lane:
  `pnpm eval:llm --live --moderation-corpus --with-safety-review`. The provider
  check is **binary** `flagged`; there is no threshold knob, which is why the
  Safety review (#1311) exists as a separate layer above it. **G4-F1 is
  closed** — the two drafts the provider missed are caught by the Safety review
  alone, as are both prompt-injection rows. G4-F2 (one provider false positive,
  `safe-sensitive-11`) is carried and inside budget. The 2026-09-17 FAIL run is
  superseded.

---

## 🟠 Production env / vendor gates — shipped features are inert without these

- [ ] **`POSTHOG_API_KEY` in prod** — the first-party analytics queue +
  activation funnel (Wave 2, mig 046/049) are no-ops until this is set.
- [ ] **`IMPERSONATION_COOKIE_SECRET`** (≥32 chars) — required for the admin
  "view-as" support flow (Wave 2, mig 048).
- [x] **`AUTO_APPROVAL_PROVIDER_MODERATION_READY`** (Spec 10) — **SET IN BOTH
  ENVIRONMENTS 2026-09-18/19, both lanes, smoked.** G4-F1 is closed. `omni-moderation-latest`
  still returns clean on veiled threats and sexual innuendo, and the local regex
  layer still covers neither — provider moderation remains a veto against
  **explicit** unsafe text only. What changed is that the **Safety review**
  (#1311) now sits above it and catches exactly that class, proven live: both
  environments score `VERDICT: PASS`, FN 0, injection misses 0, and the two
  drafts the provider misses are caught by the Safety review alone.
  **The flag is read on BOTH lanes** — Railway (boot validation only) and Vercel
  (`canExpand`, which gates an owner widening their policy). Both set `true` in
  staging and production, both redeployed, both verified by reading the value
  back. **Smoke (both environments): `blockReasons` is now exactly
  `auto_approval_disabled`** — `provider_moderation_not_validated` is gone,
  which is the flag working, and `canExpand` stays `false` because the runtime
  switch is still off, so no owner can widen a policy today. Evidence and the
  per-lane flip record:
  `docs/runbooks/evidence/2026-09-18-provider-moderation-corpus.md`. Procedure:
  `docs/runbooks/auto-approval-provider-moderation-validation.md`; flip via the
  `flag-flip` skill.
  **This flag is an EXPANSION control, not the runtime switch.** Setting it does
  not start auto-posting. `AUTO_APPROVAL_ENABLED` reads `false` in both
  environments, `JUDGE_ENABLED` is unset in production, and the ordered go-live
  flip (design doc §8.4) has not started.
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
- [ ] **`CONTEXT-MAP.md`** at repo root + `docs/context/*.md` (Spec 25; the single-file
  `CONTEXT.md` became a stub on 2026-09-05) — human-readable wrapper for CLAUDE.md.
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

## ⏳ Dated infrastructure obligations (not launch blockers)

| Due | Item | Why it has a date | Owner |
|---|---|---|---|
| **2026-12-01** | Migrate Railway worker config from `railway.toml` to Infrastructure as Code (`.railway/railway.ts`) | Railway's **hard cutoff** — Config as Code stops being read entirely on that date. Not urgent, because the five deploy/build fields are mirrored onto the Railway service itself (2026-08-31), so nothing breaks at the cutoff. It is a documentation-truth obligation: after it, `railway.toml` is a file that describes nothing. | @norbertesekiel |

**Do not run `railway config migrate --apply` and `railway config apply` blind.** The
2026-08-31 dry run produced a file with two defects: it names the service `RepWorth`
(taken from the *project* name, not the real `repworth-worker`), so an apply would
**create a second service** rather than update the existing one; and it silently drops
`restartPolicyType` and `restartPolicyMaxRetries`, carrying over only
build/start/healthcheck. `railway config apply` is project-wide with omit-means-delete
semantics. Do it as its own change, with a reviewed `railway config plan`, never
mid-cutover. Full note: lab-notes/worker-startup-sentry.md "Railway deploy configuration" (2026-08-31).

## Post-launch (tracked separately — see `updates.md`)

First-90-day gap-closing, Wave 4 (Growth), Wave 5 (Scale/Maturity), and the
deferred Spec 29 gaps (3, 4, 8) are **out of scope for launch** and planned in
[`docs/sass_ready/updates.md`](./sass_ready/updates.md). Do not let them block
shipping.
