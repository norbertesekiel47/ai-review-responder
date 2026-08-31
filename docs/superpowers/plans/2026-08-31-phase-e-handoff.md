# Handoff — beta launch, Phases E–H

> **Written:** 2026-08-31 · **Owner:** @norbertesekiel
> **Supersedes** `2026-08-31-phase-d-handoff.md`, which covered Phase D.
>
> **This is a pointer, not a source of truth.** Every fact it cites lives in exactly one
> owning file. **If this file and an owning file disagree, the owning file wins** — and fix
> this one in the same change.

---

## The one-line situation

**Production is live.** The 45-day freeze ended **2026-08-31T07:20:21Z**. The API answers,
the worker runs, review ingest is on, and every migration is applied. **Phase D is
complete.** What remains is the remaining webhooks (E), the beta coupon (F), alerting (G),
and the proof run (H) — then the first tester.

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | **The state of record.** D.1–D.10 in full, including the D.4 incident and the certificate resolution. **Read the D.4 section** — its finding governs every variable change you will make |
| 2 | `docs/runbooks/beta-production-standup.md` §§E–H | The protocol for what remains. Phase F's ten-step smoke is the long pole |
| 3 | `docs/runbooks/deployment-guide.md` §6 (webhooks), §§9–10 (the proof run) | Ops mechanics. **§5.1 carries the Railway redeploy trap** |
| 4 | `.claude/reference/lab-notes.md` 2026-08-31 "Railway deploy configuration" | The two findings that cost this run the most time |
| 5 | `docs/launch-checklist.md` | The three open hard blockers, and the dated 2026-12-01 obligation |

The ordered plan, every phase and command:
**https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c**

## Where things stand

| Area | State |
|---|---|
| **Production API** | ✅ **OPEN.** `https://repworth.net/api/health` → 200. Resumed 2026-08-31T07:20:21Z |
| **Prod worker** | ✅ Online, `tsx worker/index.ts`, deployment `d6d3ca9b`. **18/18 boot gates proven at runtime** |
| **Worker domain** | ✅ `worker.repworth.net`, Let's Encrypt cert **valid to 2026-11-29** |
| **Migrations** | ✅ **Full lockstep.** Head 116, 078 applied to prod 07:09Z. No standing exception |
| **Stripe live webhook** | ✅ `we_1UANVYIhPBLaM6xAfIMs3eMN`, **enabled**, `api_version=2026-05-27.dahlia`, 6 events. **Never yet delivered to** |
| **Six live Prices** | ✅ verified live, distinct, amounts match §1 |
| **Zernio ingest** | ✅ Running, 5-min cadence. Producer denial lifted |
| **Firewall** | 5 rules — 4 rate-limit + QR. The deny rule is **gone** |
| **Infisical `prod`** | 57 keys, 0 empty. Both Secret Syncs live (`Overwrite` + Disable Secret Deletion) |
| **Flags in prod** | `AUTO_APPROVAL_ENABLED` `AUTOPILOT_PURCHASABLE` `SELF_SERVE_SIGNUP_ENABLED` `TRIAL_ENABLED` all **`false`**; `ZERNIO_PUBLISHING_ENABLED=true` |
| **Beta comp coupon** | ✅ **`repworth-beta-comp-3mo` in BOTH modes**, 2026-08-31. Same id in each. `repeating` verified against the pinned apiVersion. Vercel `staging` set; **Production held for F.4** |
| **Resend / Zernio webhooks** | ✅ **Created and proven 2026-08-31.** Resend `3de61a3d-…`, Zernio `6a953153…`. Both delivered a `processed` `inbound_events` row |
| **Alert sink (Discord)** | ❌ Not routed. **Phase G** |
| **Hard blockers** | PITR drill, legal review, insurance — **all 3 open** |

---

## The nine traps. Read these before touching anything.

The first four are new from the Phase D run and cost real time.

1. **A Railway `redeploy` resolves NO deploy configuration.** Not `railway.toml`, not the
   service settings. It falls back to Railpack auto-detection and starts **`next start`** —
   the Next.js app, not the worker. **Any variable change fires a `redeploy`**, so every
   secret rotation and flag flip is exposed.
   **Always recover or apply with:**
   ```bash
   railway deployment redeploy --from-source \
     --service repworth-worker --environment production \
     --project ad641d0e-dc01-4250-b71c-db1beedb9c8c --yes
   ```
   Better: delete/set the variable with **`--skip-deploys`** first, then deploy from source.
   Full analysis: lab-notes 2026-08-31.

2. **"Online" on `repworth-worker` is not evidence.** `/api/health` is served by the
   Next.js app **and** the worker, so the impostor passes the healthcheck. The healthcheck
   path is now **`/ready`**, which only the worker serves — but when reading logs, require a
   **poller cycle in the worker's own output** before believing it is up.

3. **`repworth-worker` is ONE service shared by staging AND production.** Railway's
   `update-service` API updates **all** environments when `environmentId` is omitted.
   Always pass it, or a production fix rewrites staging.

4. **Two Stripe API facts the docs get wrong.** `POST /v1/webhook_endpoints` has **no
   `disabled` parameter** — it is update-only, so "create it disabled" is two calls. And
   **`api_version` is create-only**: changing it means delete + recreate + a **new signing
   secret**. Any future move of `STRIPE_CLIENT_CONFIG.apiVersion` must be paired with
   recreating the live endpoint.

5. **The production Redis service is named `Redis`, capital R.** Every documented copy of
   the queue-URL expression spells it lower-case and does not resolve. Manifest §13.

6. **`psql` rejects the pooler URL** — `invalid URI query parameter: "pgbouncer"`. libpq
   does not accept `?pgbouncer=true`; Postgres.js does. Strip the query string, or use the
   Supabase MCP.

7. **The Infisical CLI cannot delete a secret** at v0.43.128, even with `--projectId`. Web
   UI only. Project `1735b0d0-286e-4ca3-a53b-f3a7191b163c`, env slug **`prod`** (not
   `production`).

8. **`Initial Sync Behavior` is its own wizard step with a default already selected.** Any
   new Secret Sync must be set to **Overwrite** explicitly. Clicking past it caused the
   sync-1 incident. Manifest §14.

9. **Never print a secret.** Pull values to a mode-600 file under `.scratch/` (gitignored).
   **Do not call the Railway MCP `list-variables`** — it returns plaintext values, which is
   how finding F4 happened. Use `railway run --environment production --service
   repworth-worker -- <cmd>` for every live Stripe action.

---

## Phase E — the remaining live webhooks — ✅ COMPLETE 2026-08-31

> **Done.** Both endpoints were created through the **provider APIs**, not the dashboards.
> Full record: evidence file → **Phase E** (E.0–E.3) and **Findings E-F1…E-F5**.
> Standup §Phase E is ticked.
>
> **Owed out of it:** rotate `RESEND_API_KEY`, `ZERNIO_API_KEY` and
> `ZERNIO_WEBHOOK_SECRET` — `infisical secrets` prints values by default and exposed all
> three (E-F1). Near-zero blast radius while the database is zero-state; the window closes
> at the first connected location.

### What the plan got wrong, and the corrections that landed

- Both providers expose **webhook CRUD over the API**. No browser was needed for either.
- Resend **mints** the signing secret (`POST /webhooks` → `signing_secret`, shown once).
  Zernio **takes** one (`secret` is a request field), so the vault value was used verbatim.
- `webhook.test` is **not** a subscribable Zernio event; `POST /v1/webhooks/test` fires it.
- Newer Resend has no per-endpoint "Send test" — use `delivered@resend.dev`.
- Subscriptions are **per-user, not per-environment** at both providers, so every event now
  reaches both workers. Benign by construction (E-F3). Do not re-point an endpoint.
- The production **Zernio key is now PROVEN** — Phase A.6's UNPROVEN is cleared (E-F2).

### The original plan, for reference

Both terminate on the Railway worker (invariant #6). The routes are already live and
correctly reject unsigned requests.

### E.1 — Resend

- Endpoint: `https://worker.repworth.net/ingress/resend`
- **The signing secret is PROVIDER-ISSUED** — a Svix `whsec_…` shown once when the
  endpoint is created. **Do not generate your own.** This supersedes the older
  "generate a 64-hex secret" instruction.
- Put Resend's value into Infisical `prod` as `RESEND_WEBHOOK_SECRET`.
- The sync writes it to Railway, which fires a **`redeploy`** → **trap 1**. Follow with
  `redeploy --from-source`, then confirm `tsx worker/index.ts` in the boot log.

### E.2 — Zernio

- Endpoint: `https://worker.repworth.net/ingress/zernio`
- Its secret **must match `ZERNIO_WEBHOOK_SECRET` exactly** — that one was minted by us
  (Phase I) and already lives in the vault. Configure Zernio to use it; do not mint a new one.
- **This is also the first real proof of the Zernio production key.** Phase A.6 recorded it
  as UNPROVEN: every GET route in the client validates request shape before authenticating,
  so no read-only call discriminates a good key from a bad one.

### E.3 — verify delivery

Confirm 2xx in each provider dashboard. **Staging endpoints stay pointed at staging — never
re-point them.**

---

## Phase F — the beta comp coupon. The long pole.

**F.1 is already shipped** (2026-08-14). What remains is provider and environment work.

### F.2 — create the coupon in BOTH Stripe modes

100% off, `duration: repeating`, `duration_in_months: 3`. **Test mode for staging, live
mode for prod — the two IDs differ.** A test-mode ID deployed to live fails every invited
tester's checkout identically.

**Verify `repeating` behaves against the pinned `apiVersion` first** — a deprecation risk
was flagged 2026-08-10. If it fails, the fallback is three cycle-scoped 100% promotions.
Record both coupon IDs in `launch-checklist.md`.

### F.3 — the ten-step staging smoke. **This is why the first invite is not today.**

Run it as an operator against staging, in order. Every step is something you can see.

**Step 8 is the one that cannot be skipped:** confirm the **4th** billing cycle renders at
the full founding rate, not $0. That is the single assertion proving `duration_in_months: 3`
behaved as intended against the pinned API version.

**Step 6 matters nearly as much:** a card **is** collected. That is the
`payment_method_collection: 'always'` assertion — a 100%-off subscription would otherwise
skip card collection and month 4 would fail.

**Step 10 validates provider error mapping that shipped deliberately staging-unverified**
(`src/lib/onboarding/resend-invite.ts`). Record the actual Supabase error code you observe.

### F.4 — production

Order: set `BETA_COMP_COUPON_ID` (the **live-mode** ID) on **Vercel** — server-only, no
`NEXT_PUBLIC_` companion (invariant #13), and deliberately **not** a Railway variable.
Then re-run the F.3 smoke against production.

> **D.6 was skipped, and this is where that debt lands.** No Checkout has ever completed in
> live mode. Walk the production Checkout **before** tester one, or the first live Checkout
> is a customer's.

---

## Phase G — alerting and posture

> **G5 and G6 are DONE (2026-08-31).** The four-surface flag snapshot is appended to
> `launch-flag-readiness.md`, and the doc-hygiene corrections have landed.
> **G5-F1:** the Infisical Secret Sync does **not** preserve Vercel's Sensitive flag —
> Production went 9 `Secret` → 4. That converts the owed "re-add three vars as
> `--sensitive`" action into an owed **decision**.
> **G1, G2, G3 and G4 remain**, and G1/G2 need something from the owner.

### The original plan

- **G.1 — Discord** is the locked sink (decision 4; Zoho Cliq has no Sentry integration).
  Route four signals: `subsystem:health_alert`, `cost_event:limit_exceeded`,
  `subsystem:import_consent_analytics`, and **`feature:stripe_reconciliation`** (known
  unrouted — see the comment in `drift-alert.ts`).
- **G.2** — Sentry Cron monitor `health-alert-poller` (environment `production`) plus
  external `/ready` synthetics for worker and Next.js. **These now work** — the firewall no
  longer 403s them.
- **G.3** — **mutating acceptance drills run on STAGING only.** Production gets safe
  synthetic canaries. Never failure injection, worker stops, or cost-cap exhaustion against
  the live stack.
- **G.4** — the provider moderation gate is **binary** (`result.flagged`); there is no
  threshold to tune. Run the corpus validation, then flip `OPENAI_MODERATION_ENABLED=true`.
  `AUTO_APPROVAL_PROVIDER_MODERATION_READY` stays `false`.
- **G.5** — append a dated flag snapshot to `launch-flag-readiness.md`, covering **Railway
  AND Vercel**.

---

## Phase H — prove it, then invite tester one

Deployment-guide §§9–10, in order:

1. §9.1 sanity → §9.2 **read-only backfill** against a friendly or test GBP → §9.3 cost
   sanity → §9.4 an approval email in a real inbox → §9.5 the approval page, **no approve
   click**.
2. §9.6 — **one deliberate first post, clicked by a human**, with the kill switch
   (`ZERNIO_PUBLISHING_ENABLED=false`) ready.
3. §11 day-2 monitoring.
4. **Then** the first beta business.

---

## Owed, and not blocking

| Item | Why it is not done | Order when you do it |
|---|---|---|
| **`PAST_REPLIES_VIEW_ENABLED` deletion** | It is in the **Infisical vault**, so deleting it from Vercel alone returns on the next sync. The CLI cannot delete. Read by no code | **Vault (web UI) first, then Vercel** |
| **Re-add three Vercel vars as `--sensitive`** | `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET`, `WORKER_INTERNAL_SECRET` are `Config` on purpose, so Vercel could be verified against the vault by readback. **§8 is now closed, so this is due.** Standing tension: a sync writes `Config`, so a synced key drifts back on every write | After the next sync settles |
| **IaC migration, due 2026-12-01** | Railway deprecated Config as Code. The mirror onto the service already removes the single point of failure, so this is documentation truth, not an outage. **`railway config migrate` output is unsafe as generated** — it names the service `RepWorth` (creating a SECOND service) and drops both restart-policy fields | Its own PR, with a reviewed `railway config plan` |
| **Restore the light healthcheck** | `/ready` runs three live probes. Cost is bounded — Railway checks at deploy time only, 300s window, and a failure leaves the running deployment up. A worker-only dependency-free `GET` would restore the light posture | A boot-surface change; its own PR |

## The three open hard blockers

PITR restore drill, lawyer review, insurance binding. **Never tick an incomplete box.**

> **The PITR drill is now urgent.** Its runbook wants it run **before real customer data
> exists**. That window was open all through Phase D and **closes the moment beta tester
> one signs up.** It is the highest risk-reduction per hour on the list.

## What changed about the shape of this work

Phase D ended the freeze, so the failure mode has inverted. Until 07:20:21Z today a mistake
was invisible — the firewall ate it. **From now on a mistake is live.** The Stripe endpoint
is armed, review ingest is running, and the API is public. Prefer `--skip-deploys`, verify
by the worker's own logs rather than by a green dashboard, and treat every variable change
as a deploy.
