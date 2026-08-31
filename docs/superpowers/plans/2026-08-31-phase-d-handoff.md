# Handoff — WS8 production cutover, Phase D

> **Written:** 2026-08-31 · **Owner:** @norbertesekiel · `main` @ `d19bd820`
> **Supersedes** `2026-08-30-prod-cutover-resume-handoff.md`, which covered Phases A–C.
>
> **This is a pointer, not a source of truth.** Every fact it cites lives in exactly one
> owning file. **If this file and an owning file disagree, the owning file wins** — and fix
> this one in the same change.

---

## The one-line situation

Production is **frozen mid-WS8-cutover since 2026-07-17** by a Vercel firewall rule denying
every `/api/*` request. **The entire production stack now exists and is wired.** 17 of the
18 unconditional worker boot gates are green. The 18th, `STRIPE_WEBHOOK_SECRET`, does not
exist until **D.3** creates the live Stripe webhook endpoint.

**Everything before Phase D is finished.** What remains is the cutover itself.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/infisical-production-manifest.md` | **Start here.** Every variable, its gate, its platform, its value source. §11 live state · §12 Phase I · **§13 the `Redis` name trap** · **§14 why Overwrite, not Import** |
| 2 | `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | **The state of record.** Zero-state proof, the Phase A log, the first-deploy crash, the sync-1 incident, and the empty phase log for §§6–8 that this run fills in |
| 3 | `docs/runbooks/ws8-tier-cutover.md` §§5–8 | The protocol. §§1, 5, 8 are **verify-only** in prod; §§2–4 are satisfied by the zero-state proof |
| 4 | `docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md` | The predecessor. **Read it to the END** — the 077 apply is at the bottom, and stopping partway caused a month of contradictory docs |
| 5 | `docs/launch-checklist.md` | Gates and the three open hard blockers |

Ops mechanics live in `docs/runbooks/deployment-guide.md`. Do not duplicate them here.

The ordered plan, every phase and command:
**https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c**

## Where things stand

| Area | State |
|---|---|
| Phases 0, I, A, B, C | ✅ **All closed.** B and C completed as a side effect of the two syncs |
| Infisical `prod` | **56 keys, 0 empty.** Slug is `prod` |
| Secret Syncs | ✅ Both live. **`Overwrite` + Disable Secret Deletion**, auto-sync ON |
| Railway prod worker | Source `main`, **70 vars, 17/18 gates green**. Crash-loops on `STRIPE_WEBHOOK_SECRET` — by design |
| Railway prod Redis | Service **`Redis`** (capital R — §13). No TCP proxy. Queue URL resolves |
| Upstash prod cache | `sincere-primate-143545`, `PING`→`PONG`, distinct from staging's |
| Sentry prod | `repworth-production` under `repworth-nv`. DSN distinct from staging's |
| Worker domain | `worker.repworth.net`, CNAME **propagated**, certificate issuing |
| Vercel prod | 61 vars, 57 `Config` + 4 `Secret`. `NEXT_PUBLIC_APP_URL` corrected, `DB_POOL_MAX=3` |
| Prod database | Zero-state — 52/52 `public` tables empty, `auth.users`=0 |
| Migrations | Head **116, minus 078**. 077 applied 2026-07-17T02:17:11Z |
| Stripe live | `charges_enabled=True`. **0** live webhook endpoints. **6** active livemode Prices |
| **WAF** | `ws8-cutover-prod-api-deny` **still Enabled** — every prod `/api/*` returns 403 |
| Beta comp coupon | Does not exist in either mode |
| Hard blockers | PITR drill, legal review, insurance — all 3 open |

## Locked decisions — do not relitigate

1. **Solo run.** Cutover owner, observer and incident owner are one person. Owner-approved
   deviation, 2026-07-16 precedent.
2. **Infisical Secret Sync**, not `infisical run` injection.
3. **One Infisical environment, union spread accepted.**
4. **Alert sink: Discord.** Zoho Cliq checked and rejected — no Sentry integration.
5. **`ADMIN_NOTIFICATION_EMAIL` = `alerts@repworth.net`**, a group not an alias.
6. **Supabase uses a new-format `sb_secret_` key.** Variable name unchanged.
7. **Beta posture** — `AUTO_APPROVAL_ENABLED=false`, `AUTOPILOT_PURCHASABLE=false`,
   `SELF_SERVE_SIGNUP_ENABLED=false`, `TRIAL_ENABLED=false`. Beta lands on Copilot (ADR 0005).
8. **Sync strategy is `Overwrite` + Disable Secret Deletion**, never `Import`. Owner
   decision after the sync-1 incident. Manifest §14.

## Traps

1. **`Initial Sync Behavior` is its own wizard step (step 4), with a default already
   selected.** Clicking past it is how the sync-1 incident happened. Any new sync — staging
   included — must have it set to **Overwrite** explicitly.
2. **A `vercel env pull` is NOT a backup.** It writes the literal `"[SENSITIVE]"` for every
   Sensitive variable. Confirm such a value exists elsewhere before overwriting it.
3. **The production Redis service is named `Redis`, capital R.** Every documented copy of
   the queue-URL expression spells it lower-case, which does **not** resolve in production.
   `assertCoreInfraEnv` checks presence, not shape, so a wrong reference yields a valid URL
   with an empty password: the worker boots, reports healthy, and fails `NOAUTH` on every
   queue operation. Manifest §13.
4. **The Infisical CLI cannot delete a secret** at v0.43.128, even with `--projectId`. Use
   the web UI.
5. **Railway restarts the worker on every variable change.** Until D.3 it crash-loops on
   `STRIPE_WEBHOOK_SECRET`. That is correct. **Never raise `restartPolicyMaxRetries`.**
6. **Vercel does not redeploy on an env change**, and `NEXT_PUBLIC_*` is inlined at build
   time. Redeploy after every sync.
7. **The local Stripe CLI 401s on live** — likely a Sandbox-bound browser authorization. Use
   `railway run --environment production --service repworth-worker -- <cmd>`. **A
   Sandbox-defaulted browser session can create the D.3 endpoint in the wrong context, where
   it looks created and delivers nothing.**
8. **`?family=0` on the queue URL is mandatory.** Railway's private network is IPv6-only.
9. **The stand-up's Phase B boot-gate list was wrong in five places.** It now points at
   manifest §1. Use the manifest, never a restated list.

---

## Two items owed before D, neither blocking

1. **Redeploy Vercel** — `NEXT_PUBLIC_APP_URL` is correct in the store but inlined at build
   time, so no browser sees it yet. Confirm by page-source check afterwards.
2. **Delete `PAST_REPLIES_VIEW_ENABLED` from Vercel** — read by no code (manifest §7.10).

## Phase D — the cutover, resuming at WS8 §6

### D.1 — verify §1, the six live Prices *(read-only)*

Confirm each of the six live Price IDs resolves in **live** mode and that all six are
distinct — `assertStripePriceIdsUnique` enforces distinctness at boot. Use the `railway run`
injection pattern, not the local CLI (trap 7).

### D.2 — verify §5, migration 077 *(read-only)*

Already applied. Run the introspection in `ws8-tier-cutover.md` §5 and paste it into the
evidence file. Expect both invalid-row counts `0`, `accounts.price_variant` present, and
both Checkout-lease objects present. **They are launch safety objects: strict code must not
start if either is absent or widened.**

### D.3 — create the live Stripe webhook endpoint, DISABLED

- Endpoint: `https://worker.repworth.net/ingress/stripe`
- Create it **disabled**.
- Set its API version **in lockstep** with the pinned `apiVersion` in
  `src/lib/payments/stripe-client.ts`. The pin governs outbound calls; the endpoint version
  governs inbound payload shape. They drift silently.
- Subscribe to the full set `worker/ingress/stripe.ts` handles — **including
  `invoice.payment_action_required`**, which is easy to omit and has a live handler.
- Put its signing secret into Infisical `prod` as `STRIPE_WEBHOOK_SECRET`. The Railway sync
  pushes it automatically and restarts the worker.
- **Confirm it appears in the LIVE dashboard** (trap 7), then re-run the Phase 0.2 check —
  it must report `live webhook endpoints: 1`.

### D.4 — §6, the first successful worker boot

The sync from D.3 triggers the deploy. Watch for `assertWorkerStartupEnv` passing and
naming the production lane.

**Six gates have never been exercised at runtime**, because the assertion order throws at
`STRIPE_WEBHOOK_SECRET` before reaching them. They are present but untested:
`DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT` (must parse as positive integers),
`ADMIN_NOTIFICATION_EMAIL`, `SENTRY_DSN`, `SESSION_COOKIE_SECRET`, `NEXT_PUBLIC_APP_URL`,
and the exact-boolean format gate. **This boot is what closes them.**

### D.5 — enable the endpoint, run the convergence gate

```bash
pnpm ws8:stripe-preflight --require-status-convergence
```

Require the literal `WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0`. On a
zero-state database this passes immediately — there are no subscriptions to converge.

### D.6 — §6 smoke, through the operator allowlist only

Record the exact UTC deadline-verification time and the `AUTOPILOT_PURCHASABLE` state.
Open the allowlist narrowly — **do not lift the deny rule yet** — and exercise Copilot list
and founding Checkout with a disposable account. Keep `AUTOPILOT_PURCHASABLE=false`.

### D.7 — §7, apply migration 078

Preflight both NULL-safe counts to zero and record the output, even though zero-state makes
them trivially zero. Apply `supabase/migrations/078_copilot_autopilot_contract.sql` through
the approved channel. Then introspect: `businesses.subscription_tier` NOT NULL, and both
`accounts_subscription_tier_check` and `businesses_subscription_tier_check` present.

### D.8 — lift the freeze. **This is the moment.**

Three acts, all part of §7:

1. Remove the Vercel firewall rule `rule_ws8_cutover_prod_api_deny_gogW1I` and publish.
2. `curl -s -o /dev/null -w "%{http_code}\n" https://repworth.net/api/health` → **200**.
3. Restore `ZERNIO_RECENT_REVIEW_POLL_DISABLED` to **unset** on Railway.

Record the UTC resume time. Leave the four rate-limit rules and the QR rule alone.

### D.9 — verify §8, migration 105 *(read-only)*

`checkout_attempt_coupon_id` nullable = YES, and the rewritten
`accounts_checkout_attempt_complete_check` names it in its cleared branch.

### D.10 — update `.claude/CLAUDE.md` in the same PR

§7 requires it: delete the "Standing exception until the prod WS8 cutover" sentence from
**Environments & branches** — 078 is no longer absent in production.

---

## After D

| Phase | What it is |
|---|---|
| **E** | Resend and Zernio webhooks. Resend's secret is **provider-issued** (`whsec_…`) — do not generate your own. Zernio's must match `ZERNIO_WEBHOOK_SECRET` exactly |
| **F** | The beta comp coupon, in **both** Stripe modes. **F.3's ten-step staging smoke is why the first invite is not today** — step 8 proves cycle 4 bills at full price |
| **G** | Discord alert routing, Sentry cron monitor, synthetics (they 403 until D.8), moderation corpus validation, a dated flag snapshot covering **both** platforms |
| **H** | The real proof: read-only backfill, an approval email in a real inbox, then **one deliberate post clicked by a human**. Then invite tester one |

## Owed after §8 closes

Re-add `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET` and `WORKER_INTERNAL_SECRET` to Vercel
with `--sensitive`. They are `Config` today **on purpose**, so Vercel can be verified against
the vault by readback — the check that caught the sync-1 incident. Note the standing tension:
an Infisical sync writes `Config`, so a synced key drifts back on every write. Sensitive
cannot be maintained on a synced key.

## The three open hard blockers

PITR restore drill, lawyer review, insurance binding. **Never tick an incomplete box.** The
PITR drill is the highest risk-reduction per hour on the list, and its runbook wants it run
**before real customer data exists** — a window the zero-state proof says is open right now
and closes the moment beta tester one signs up.

## The moment that matters

The first time `curl https://repworth.net/api/health` returns **200** is the moment
production stops being fenced off. It is **D.8**. Everything before it is preparation, and
almost all of that preparation is now done.
