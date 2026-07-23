# Agentic platform — staging Phase D: Autopilot purchasability (WS8)

Continuation of `agentic-staging-copilot-autopilot-e2e.md` (Phases A–C proven
2026-07-21, evidence: `evidence/2026-07-21-agentic-staging-copilot-autopilot-e2e-evidence.md`).
Phase C proved the **autonomy runtime**; this phase proves the **commercial and
operational surfaces** it deliberately bypassed.

> ⚠️ **Staging only.** Never touch the production Supabase project
> (`udeyaqnvpojbwgoaxwdg`), the production Stripe account, or production env
> vars. Staging Stripe is **test mode** — all purchases use test cards (e.g.
> `4242 4242 4242 4242`); no real money moves.
>
> ✅ **No new Google posts are required by this phase.** Design goal: Phase D
> closes the purchasability/settings/admin gaps WITHOUT creating new public
> artifacts. If any step would auto-post (only possible with the full autonomy
> stack on AND a fresh qualifying live review), that step is out of scope here.

> `ws8-tier-cutover.md` remains authoritative for the **production** cutover
> choreography (quiesce → preflight → 077 → deploy → smoke → 078 → resume). It
> does NOT need re-running on staging: staging is already post-078 (verified by
> introspection 2026-07-21; a fresh signup activated directly as `tier=copilot`).

---

## 0. What Phase C left unproven (this phase's exact scope)

| # | Phase C shortcut | Real path Phase D must prove |
|---|---|---|
| 1 | `subscription_tier='autopilot'` set via SQL | **Stripe purchase → autopilot tier**: new-signup Autopilot Checkout AND copilot→autopilot upgrade via `POST /api/billing/tier-change` |
| 2 | `auto_approval_policies` seeded via SQL (invariant-#14 deviation) | **Owner trust-dial writes through the settings UI**: expansion allowed when the gate is open; expansion **blocked** when closed; contraction always allowed |
| 3 | Admin unsuspend SQL-simulated | **`/admin/autonomy` unsuspend UI** under a real admin session with **AAL2** (MFA) |
| 4 | — (not attempted) | **Publish-time downgrade**: tier drops mid-veto-window → no auto-post (smoke scenario `14`) |

**The purchasability gate is composed:** effective purchasability =
`AUTOPILOT_PURCHASABLE` **AND** `autoApprovalRuntimeEnabled()`
(accessor in `src/lib/auto-approval/settings.ts`). Closing either side blocks
new Autopilot Checkout and autonomy-expanding trust-dial edits; contractions
remain allowed. This means parts of Phase D need the autonomy runtime flags ON.

## 1. Preconditions

1. **Flags at baseline** (all six OFF) — same §1.3 check as the A–C runbook.
   Fix drift before starting; record it if found.
2. **Staging Stripe (test mode) has the six WS8 Prices** wired:
   `STRIPE_PRICE_{COPILOT,AUTOPILOT}_{LIST,FOUNDING}` + the two overage Prices.
   Verify amounts with `pnpm tsx scripts/verify-stripe-price-parity.ts` (run via
   `railway run … --environment staging` so it reads staging's env). Expected:
   copilot 2900/1900, autopilot 6900/4900 (list/founding), overage 1000/2000.
3. **Worker healthy** + `FOUNDING_DEADLINE=2027-01-01T00:00:00Z` observed
   literally (record `founding_deadline_verified_at_utc`, per the WS8 evidence
   convention).
4. **Admin account with AAL2 on staging**: `norbertesekiel@gmail.com` admin row
   survived the wipe. **Enroll MFA if absent** (via the admin-reachable
   enrollment surface, PR #467); **if already enrolled**, verify the TOTP factor
   shows verified at `/admin/security` and that admin login actually demands the
   step-up. Record whichever path was exercised.
5. **Existing test account** (`norbertliverpool@gmail.com`, Tancia Resort,
   `tier=copilot`, trialing) available for the upgrade path; a plus-addressed
   email (`…+phased-<date>@…`) reserved for the fresh-signup path.
   **OTP logistics:** the session's Gmail connector reads only the *owner's*
   inbox — signup OTPs sent to any other mailbox need live owner relay. Plan
   for the owner at the keyboard during signups/logins.
6. **Open a new evidence record**:
   `docs/runbooks/evidence/YYYY-MM-DD-agentic-staging-phase-d-evidence.md` —
   same conventions as the A–C record (env, git SHA, UTC start, per-step
   PASS/FAIL + UTC, deviations logged, no tokens/PII/Checkout URLs).

## 2. D1 — Smoke-driver battery (deployed env unchanged)

The WS8 driver manages the purchasability gate **process-scoped** (its
`gate-open-window … deployed_env_unchanged=true` line) — so run the battery
BEFORE flipping any deployed flag. Each scenario prints
`WS8_SMOKE <id> PASS|FAIL <detail>`; paste every line into evidence.

> **Composed-gate caveat (found 2026-07-22):** `--gate-open` sets only
> `AUTOPILOT_PURCHASABLE`, but `autopilotPurchasable()` ALSO requires
> `AUTO_APPROVAL_ENABLED=true`, and scenario 14's publisher path checks the
> runtime gate before tier entitlement. So `02-autopilot-*`, `05a`, and `14`
> need the env prefix — process-scoped, deployed env untouched, no post risk
> (fixtures have no Zernio connection):
>
> ```bash
> railway run --environment staging --service repworth-worker -- \
>   env AUTO_APPROVAL_ENABLED=true pnpm tsx scripts/ws8-staging-smoke.ts 02-autopilot-list --gate-open
> ```
>
> Also note: the CLI id `13-copilot-grant-denial` **emits** the line id
> `13-copilot-grant-auto-policy-denial` — grep evidence for the emitted id.

```bash
railway run --environment staging --service repworth-worker -- \
  pnpm tsx scripts/ws8-staging-smoke.ts state        # baseline snapshot
# Then, one at a time (order matters only where noted):
#   02b-autopilot-denied-gate-closed   ← run FIRST (proves the closed gate denies)
#   12-expansion-denial-gate-closed    ← ditto (settings expansion denied)
#   13-copilot-grant-denial            ← copilot tier never grants autonomy
#   01-list / 01-founding / 01c-trial  ← copilot checkout variants
#   02-autopilot-list / 02-autopilot-founding
#   03-same-tier-retry / 04-lease-drift-stability / 05a-reselection-expires-prior
#   14-publish-time-downgrade          ← closes unproven-path #4
railway run --environment staging --service repworth-worker -- \
  pnpm tsx scripts/ws8-staging-smoke.ts <scenario-id>
```

**Stop rule:** any `FAIL` line → stop the phase, capture `state`, report. Do not
proceed to browser testing on top of a failing driver.

## 3. D2 — Real-browser surfaces (deployed gate opened for the window)

Now open the gate for real UI testing — **both** sides of the composed gate:

```bash
# Autonomy runtime first, in the A–C order (upstream before downstream):
railway variables --set TRIAGE_ENABLED=true --environment staging --service repworth-worker
railway variables --set ESCALATION_ENABLED=true --environment staging --service repworth-worker
railway variables --set JUDGE_ENABLED=true --environment staging --service repworth-worker
railway variables --set GOVERNOR_ENABLED=true --environment staging --service repworth-worker
railway variables --set AUTO_APPROVAL_ENABLED=true --environment staging --service repworth-worker
# Then the commercial gate — set on BOTH Railway (worker) and Vercel (UI/routes):
railway variables --set AUTOPILOT_PURCHASABLE=true --environment staging --service repworth-worker
```

**Vercel needs BOTH halves of the composed gate** — `AUTOPILOT_PURCHASABLE=true`
**and** `AUTO_APPROVAL_ENABLED=true` — because `autopilotPurchasable()` runs on
Vercel for checkout / tier-change / trust-dial routes. Set them via **REST
PATCH with the value in the JSON body** (the documented v54 `vercel env add`
stdin bug stores `""`, which silently reads as false); then trigger the staging
custom-env redeploy and wait for READY before trusting the UI
(see deployment-guide.md Phase 3). Restore **both** to non-true at teardown.

Record `autopilot_purchasable_verified_at_utc` on both platforms (WS8 evidence
convention). Then, in a real browser against `https://staging.repworth.net`:

1. **Fresh-signup Autopilot Checkout** — new account (plus-addressed email),
   choose Autopilot, pay with `4242…` test card. Expect: activation with
   `subscription_tier='autopilot'`, correct (founding) Price on the sub, trial
   semantics per `01c`. *(Closes unproven-path #1a.)*
2. **Upgrade path** — on the Tancia copilot account, upgrade copilot→autopilot
   through the billing UI (`POST /api/billing/tier-change` underneath). Expect:
   tier flips, Stripe sub updated, audit row written. *(Closes #1b.)*
3. **Trust-dial settings UI, three writes** on the upgraded account
   *(closes #2 — the invariant-#14-clean path)*:
   a. **Expansion** (enable auto-approve ≥4★, window 15, cap 10) → succeeds.
   b. Flip `AUTOPILOT_PURCHASABLE=false` (both platforms) → **expansion edit
      blocked** with the `AutoApprovalExpansionBlockedError` surface;
      **contraction** (raise threshold / disable) → still **allowed**.
   c. Restore `AUTOPILOT_PURCHASABLE=true`, re-verify expansion works.
4. **Admin unsuspend under AAL2** *(closes #3)*: force a suspension exactly as
   Phase C §4.4 did (insert ≥5 `flag` judge_verdicts on the account, shorten
   `GOVERNOR_INTERVAL_MS`, wait for auto-suspend + notices), then — as the AAL2
   admin — unsuspend via **`/admin/autonomy`** with a note. Expect:
   `suspended_at` cleared, `autonomy_unsuspended` audit, policy re-armed, and
   the UI reflecting it. No SQL.
5. **No-post guard:** confirm NOTHING auto-posted during this window
   (`SELECT count(*) FROM responses WHERE approval_method='auto_policy' AND
   posted_at > <window start>` = 0 expected — no qualifying live review should
   exist; if one arrives organically mid-test, veto it from the pending-post
   notice and record it).

## 4. Teardown

- All six autonomy flags → **false** on Railway; `AUTOPILOT_PURCHASABLE` →
  **false** on both platforms; `GOVERNOR_INTERVAL_MS` → 900000. Redeploy.
- `ws8-staging-smoke.ts cleanup` (driver fixtures); delete synthetic
  judge_verdicts; cancel the fresh-signup test-mode Stripe subscription.
- **Decide the Tancia account's resting tier** (owner call): revert to copilot
  (matches A–C baseline) or keep autopilot (demoable). Record which.
- Close the evidence record with an overall PASS/FAIL.

## 5. After Phase D — what remains before production go-live

1. **Zernio automated-posting volume/cadence limits in writing** — still the
   one gate no code closes.
2. **Production cutover** per `ws8-tier-cutover.md` (trivial with zero
   customers, but run the choreography — Stripe prod Prices are created there).
3. The ordered production flag flip per the A–C runbook §7, Copilot-first.
