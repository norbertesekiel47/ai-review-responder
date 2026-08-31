# WS8 tier cutover — PRODUCTION resume evidence record

> **Continuation of** `docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md`.
> That record is complete and was never truncated — see "Reconciliation" below, which
> corrects a claim in `ws8-tier-cutover.md` §5 that has propagated into several docs.

| Field | Value |
|---|---|
| Environment | production |
| Cutover owner | Norbert Esekiel (norbertesekiel@gmail.com) |
| Observer | **UNFILLED** — owner-approved deviation, decided 2026-08-30. Precedent: the same deviation was recorded for the 2026-07-16/17 run. Recorded, not silent. |
| Incident owner | Norbert Esekiel — same person as cutover owner (solo run, recorded) |
| Repo HEAD at start | `0494297a0de3a9131fae1e6f2f641eb487ae7a58` (`main`) |
| UTC start | 2026-08-30T22:16:08Z |
| Stripe mode/account | **live** / `acct_1TUcR7IhPBLaM6xA` (RepWorth, Inc.) |
| Predecessor evidence | `2026-07-17-ws8-prod-cutover-evidence.md` — §§1–5 complete, 077 applied 02:17:11Z |
| Resume point | **§6** (deploy strict code + controlled smoke). §§1–5 are verify-only; §§2–4 are satisfied by the zero-state proof below. |

---

## Reconciliation — closing the 077 disagreement

**Finding: `ws8-tier-cutover.md` §5 states a fact that is false, and it is the origin of a
month of contradictory doc claims about migration 077.**

The §5 note (added 2026-08-14 by #825) reads:

> …verified `price_variant` absent at 01:11:05Z. 077 landed after that, and **no evidence
> file records it** — so the prod cutover is partially executed through this section.

The predecessor evidence file records 077 in full, 66 minutes after the read that note
cites. Verified timeline:

| UTC (2026-07-17) | Event | Source |
|---|---|---|
| 01:11:05Z | Synthetic-tenant purge verified; `price_variant` **absent** (077 correctly unapplied) | evidence file, "Prod DB findings" |
| 01:56:31Z | WAF rule `ws8-cutover-prod-api-deny` staged by agent, published by owner | evidence file, "Phase 2" |
| 02:09:45Z | Quiescence sample 2 — outbox in-flight 0, total 0 | evidence file, "Quiescence" |
| 02:10:04Z | **QUIESCENCE DECLARED**; §4 formal `WS8_PREFLIGHT_PASS blockers=0`, zero allowlist | same |
| 02:10:24Z | Outbox baseline recorded = 0; `price_variant` absent pre-apply = genuine first apply | same |
| **02:17:11Z** | **Migration 077 applied by owner via Supabase SQL editor, and verified** — `incomplete_snapshot_count=0`, `invalid_business_mirror_count=0`, `outbox_count_after_077=0=baseline`, `checkout_session_index_present=true`, `checkout_lease_constraint_present=true`, defaults `copilot/list/2900/1500/1`, `accounts_price_variant_check CHECK(list,founding)`, trigger `accounts_price_variant_immutable` enabled | same |
| 02:40:15Z | **PR #469 merged** — `feat: wire Copilot and Autopilot monetized autonomy` (the strict code) | `gh pr view 469` |
| 02:51:53Z | PR #470 commits the evidence file, 077 record included | `git log d1d227e4` |

**Cause of the error.** The 01:11:05Z line sits in the middle of the evidence file. The
077 record sits at the bottom, under a heading appended in the same session and committed
34 minutes after the apply. The #825 audit read as far as the first `price_variant` read,
concluded the session had stopped there, and re-derived from the database what the record
already stated — then wrote down that the record was silent.

**Proof the file has not changed since.** `git log -- <evidence file>` returns exactly one
commit, `d1d227e4` (authored 2026-07-16 19:51:53 -0700, committed 2026-07-17 02:51:53Z),
and `git diff d1d227e4 HEAD -- <evidence file>` is empty. The 077 record was in the file
from its first and only commit.

**Nothing about 077 is ambiguous.** It was applied by the owner, through the approved
channel, with eight named verification checks recorded.

### Doc corrections owed (fix at the cited spots, per the doc-hygiene rule)

1. `docs/runbooks/ws8-tier-cutover.md` §5 — delete "and no evidence file records it"; cite
   the 02:17:11Z record instead. The surrounding conclusion (077 is applied; §5 is a verify
   step in prod) is correct and stands.
2. `docs/runbooks/beta-production-standup.md` §0 — "How this happened: … no evidence file
   records it" inherits the same error. Same fix.
3. `docs/launch-checklist.md` — "077 landed unrecorded after the 2026-07-17 cutover pause"
   inherits it a third time. 077 landed **recorded**; what is true is that the
   *Supabase migration-history table* does not list it, because it was applied via the SQL
   editor. That distinction is the whole point of the "introspect the schema, not the
   ledger" rule at the top of `migrations-log.md`.
4. `.claude/CLAUDE.md` → Environments & branches — same sentence, same fix. (This file is
   edited again at §7 anyway, to delete the standing 078 exception.)
5. `docs/runbooks/beta-production-standup.md` Phase B — the boot-gate list is wrong in
   five places. Owner of the correct list, derived from code at `f6695494`:
   `docs/runbooks/infisical-production-manifest.md` §7. Fix Phase B by pointing at it,
   not by restating it.

---

## Owner decisions recorded at start (2026-08-30, in-session)

1. **Roles: solo run.** Observer and incident owner are the cutover owner. Recorded as an
   owner-approved deviation, matching the 2026-07-16 precedent. No box left blank.
2. **Stripe live activation: COMPLETE.** `charges_enabled` reported **true** by the owner
   on 2026-08-30, resolving the blocker recorded as `charges_enabled=false` at
   2026-07-17T00:0xZ. This unblocks §6 smoke Checkout and all of Phase F.
   **VERIFIED 2026-08-30** by owner-run `railway run` check against the production
   `sk_live_` key: `charges_enabled=True`, `payouts_enabled=True`,
   `details_submitted=True`. See D1d. No longer owed at §6.
3. **`ADMIN_NOTIFICATION_EMAIL` = `alerts@repworth.net`** — a new Zoho Mail mailbox on the
   already-Zoho-hosted domain. Receiving only; **no DNS change required** (see the mail
   note below). Must exist before Phase B, because it is a hard boot gate.
4. **Alert sink: Discord**, decided after checking Zoho. Rationale and the Zoho finding are
   recorded below.

### Decision 4 detail — why not Zoho Cliq

The team has moved to Zoho, so Zoho Cliq was checked first. It is not viable as the beta
alert sink today:

- **Sentry has no Zoho Cliq integration.** Its Notification & Incidents integrations are
  Slack, Microsoft Teams, **Discord**, Telegram, PagerDuty, Opsgenie, PagerTree, Rootly,
  SIGNL4, Spike.sh and similar. Cliq is not among them.
- **Zoho Cliq's incoming webhook is a bot endpoint with its own payload contract** —
  `https://cliq.zoho.com/api/v2/bots/<bot>/incoming?zapikey=<token>`, expecting Cliq's own
  JSON or a Cliq message-card template. Sentry emits Sentry's shape.
- Bridging them therefore needs a **translator service**: a new endpoint, a new deploy
  surface, and a new component that can be silently down. Putting that on the paging path
  contradicts the reason `assertAlertSinkEnv` is a hard boot gate — that paging must not be
  able to go silently inert.

**Decision: Discord now.** It is first-class in Sentry and needs no code. It also makes the
existing comment in `worker/background/pollers/billing-reconciliation/drift-alert.ts`
correct rather than requiring a correction — that comment already assumes Discord, and it
is the reason `beta-launch-alerting.md` and the code disagreed.

**Revisit after beta:** if the team consolidates on Zoho, a Sentry → Cliq bridge is a
small, well-understood piece of work. It is not a launch-day dependency. Record the
outcome here when decided: `____`.

### Decision 3 detail — `alerts@repworth.net` is a GROUP, not an alias

Created 2026-08-30 as Zoho Mail group **"RepWorth Alerts"**, 5 members, all Active, Post
Approval `Accept`, **"Send using group email address: Not allowed"** for every member.

A group rather than an alias, deliberately: an alias binds to one user and cannot be
reassigned without deletion, while `ADMIN_NOTIFICATION_EMAIL` carries admin, failover and
engagement alerts that must outlive any one founder. The group also gives the other founders
the same visibility.

"Send using group email address: Not allowed" is correct and should stay — the address is an
inbound-only alert sink, and nobody should be able to send *as* it. Receiving is unaffected.

### Mail note — `alerts@repworth.net` does not touch the verified email auth

Verified by DNS read, 2026-08-30:

| Record | Value | Meaning |
|---|---|---|
| `MX repworth.net` | `mx.zoho.com` (10), `mx2` (20), `mx3` (50) | Inbound mail already terminates at Zoho. A new mailbox is a Zoho admin action only. |
| `TXT repworth.net` (SPF) | `v=spf1 include:zoho.com include:zohomail.com ~all` | Root domain sends via Zoho. |
| `TXT send.repworth.net` (SPF) | `v=spf1 include:amazonses.com ~all` | **Resend sends from the `send.` subdomain**, not the root. |
| `TXT resend._domainkey` | present | DKIM intact. |
| `TXT _dmarc` | `p=quarantine; adkim=r; aspf=r; rua=mailto:…@dmarc.postmarkapp.com` | Relaxed alignment, so a `From:` on the root aligns against a `send.` envelope. |

**Consequence:** creating `alerts@repworth.net` requires **no DNS change** and cannot
disturb the DKIM/SPF/DMARC state that `launch-checklist.md` records as a *completed* hard
blocker. Do not edit those records while creating the mailbox.

**Two carried notes, both non-blocking:**
- ~~`RESEND_FROM_EMAIL` must stay on `send.repworth.net`.~~ **CORRECTED 2026-08-30.**
  That conflated the `From:` header with the envelope sender. DKIM signs
  `resend._domainkey.repworth.net` and there is **no key** at
  `resend._domainkey.send.repworth.net`; `send.` carries the SPF and an SES MX
  because it is Resend's Return-Path subdomain. The verified sending domain is
  **`repworth.net`**, and staging has been sending from the root all along. In use:
  `RepWorth <notifications@repworth.net>`. Full evidence:
  `infisical-production-manifest.md` §12.3.
- DMARC `rua` still points at a third-party reporting mailbox. The launch checklist already
  flags pointing it at a RepWorth-owned address; now that Zoho hosts the domain, that is a
  five-minute change. Still non-blocking, still not done.

---

## Zero-state proof (replaces WS8 §2–§3 quiesce/drain)

Production holds no data at all. This is by deliberate purge on 2026-07-16 (36-table FK
closure, owner-executed, recorded in the predecessor file), not because production was
never used — the "never launched" line in that file is corrected there.

WS8 §2–§3 exist to prove that producers are denied and that in-flight work has drained.
Both are satisfied here by something stronger than a drain: **there is nothing to drain,
and no infrastructure capable of producing.** Evidence below is a live read, not a doc
claim, and is recorded to the §2.5–2.8 two-sample discipline the predecessor used.

### D1a — whole-schema sweep (exact counts, not `reltuples`)

```sql
SELECT now() AT TIME ZONE 'UTC' AS sample_utc,
  count(*) AS base_tables_in_public,
  count(*) FILTER (WHERE n > 0) AS tables_with_rows,
  coalesce(sum(n), 0) AS total_rows_all_tables,
  coalesce(string_agg(table_name || '=' || n, ', ' ORDER BY n DESC)
           FILTER (WHERE n > 0), '(none)') AS non_empty_tables
FROM (
  SELECT t.table_name,
         (xpath('/row/cnt/text()',
                query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I',
                                    t.table_schema, t.table_name), false, true, '')
         ))[1]::text::bigint AS n
  FROM information_schema.tables t
  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
) s;
```

**Result 2026-08-30T22:28:22.624Z:**

| sample_utc | base_tables_in_public | tables_with_rows | total_rows_all_tables | non_empty_tables |
|---|---|---|---|---|
| 2026-08-30 22:28:22.6243 | **52** | **0** | **0** | `(none)` |

Every base table in `public` is empty. This is deliberately broader than the five-table
read the plan originally proposed: it enumerates the schema rather than trusting a
hand-written list, so a table nobody thought to name cannot hide rows.

### D1b — non-`public` schemas, and the in-flight outbox contract

The 2026-07-16 purge TRUNCATEd `public` only. Supabase Auth identities live in `auth`, so
they would have survived it. They did not exist:

```sql
SELECT now() AT TIME ZONE 'UTC' AS sample_utc,
  (SELECT count(*) FROM auth.users)       AS auth_users,
  (SELECT count(*) FROM auth.identities)  AS auth_identities,
  (SELECT count(*) FROM auth.sessions)    AS auth_sessions,
  (SELECT count(*) FROM auth.mfa_factors) AS auth_mfa_factors,
  (SELECT count(*) FROM job_outbox
     WHERE status IN ('pending','dispatching','dispatched')) AS outbox_in_flight,
  (SELECT count(*) FROM job_outbox)       AS outbox_total,
  (SELECT count(*) FROM storage.objects)  AS storage_objects;
```

**Sample 1 — 2026-08-30T22:28:33.224Z:** `auth_users=0`, `auth_identities=0`,
`auth_sessions=0`, `auth_mfa_factors=0`, **`outbox_in_flight=0`**, `outbox_total=0`,
`storage_objects=0`.

`outbox_in_flight` uses the byte-for-byte in-flight set `('pending','dispatching',
'dispatched')` owned by `src/lib/shared/job-outbox-status.ts` (invariant #2), not a
re-derived list.

**Sample 2 — 2026-08-30T22:30:03.359Z** (1m30s after sample 1): `outbox_in_flight=0`,
`outbox_total=0`, `auth_users=0`, `accounts=0`, `businesses=0`.

Two separated samples, both zero — the counts are stable, not merely zero at one instant.
Per §2.5–2.8, which is what the two-sample protocol is for.

**QUIESCENCE DECLARED 2026-08-30T22:30:03Z.**

### D1c — structural proof: nothing can produce or consume

| Fact | Verified 2026-08-30 | Consequence |
|---|---|---|
| Railway `production` environment services | **only `repworth-worker`; no `redis` service exists** | No queue. BullMQ has never had a broker in this environment. |
| `repworth-worker` deployments, all time | **0 active, "No deployment"** | No consumer or poller has ever run against prod. |
| `REDIS_QUEUE_URL` on the prod worker | **unset** | The worker could not connect even if deployed — `assertCoreInfraEnv` would refuse to boot. |
| Vercel WAF `ws8-cutover-prod-api-deny` | **Enabled**, `environment=production AND path startsWith /api/` → Deny | Every producer route is denied. `GET /api/health` → **403**, `x-vercel-mitigated: deny`. |
| `SELF_SERVE_SIGNUP_ENABLED` (Vercel prod) | `false` | Anonymous account-minting closed. |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` (Railway prod) | `true` | The §2.3 producer denial is still in force. |

Queue counts are **structurally zero, not merely observed zero** — the same finding the
predecessor recorded at §2.5–2.8, still true and now re-verified.

### D1d — live Stripe state, VERIFIED 2026-08-30

Initially recorded as UNVERIFIED because the local CLI's live key returned 401. Resolved the
same day through the **`railway run` injection pattern** the predecessor established, so the
production `sk_live_` key was used but never observed:

```
railway run --environment production --service repworth-worker -- python3 <check>
```

**Result — owner-run, 2026-08-30:**

```
key prefix: sk_live_ | length: 107
HTTP 200 — live account reachable
  id                : acct_1TUcR7IhPBLaM6xA
  charges_enabled   : True
  payouts_enabled   : True
  details_submitted : True
  live webhook endpoints: 0
  active livemode Prices: 6
```

| Fact | Value | Closes |
|---|---|---|
| `charges_enabled` | **True** | The orphaned 2026-07-17 blocker (`false` then). Live Checkout can complete. |
| `payouts_enabled` / `details_submitted` | True / True | Activation is complete, not partial |
| Live webhook endpoints | **0** | Matches the predecessor's 2026-07-17 reading. §2.4 "nothing to disable" still holds; D.3 creates the first one. |
| Active livemode Prices | **6** | WS8 §1 output present and active. Per-ID/amount match still runs at D.1. |

**Also proves the production credential is sound.** The `sk_live_` key already deployed to
the Railway prod worker authenticates and reads live resources.

### D1d-note — the local Stripe CLI returns 401 on live, and it does NOT block this cutover

`stripe login` succeeds and mints a working **test**-mode key (`sk_test_` → HTTP 200), but
its **live** restricted key (`rk_live_`) returns `401 Invalid API Key provided` on every
endpoint including `/v1/account`. Same login, same account id, opposite results — so the
fault is neither the CLI, the config, nor the account, which `charges_enabled=True` above
independently confirms.

Most likely cause: the browser authorization bound to a **Sandbox** rather than the live
account (modern Stripe puts sandboxes behind the same account-name dropdown).

**Not a blocker.** Every Stripe action in this cutover — including D.3's endpoint creation —
runs through `railway run --environment production` injection, which uses the deployed
`sk_live_` key and is the sanctioned path from the 2026-07-17 record ("the full live secret
key must never transit an agent transcript"). Fix the CLI when convenient; do not gate on it.

**Trap for D.3:** if the browser session defaults to a Sandbox, it is easy to create the live
webhook endpoint in the wrong context and not notice until checkouts silently fail. Confirm
the endpoint appears in the **live** dashboard, and re-run the check above — it must then
report `live webhook endpoints: 1`.

### D1e — what this settles

1. **WS8 §2–§3 are satisfied.** Producers denied (D1c), in-flight work zero and stable
   (D1b), drain unnecessary because no queue has ever existed. Record the substitution in
   place of the quiesce/drain protocol, per the stand-up's Phase D1 instruction.
2. **The launch-checklist BLOCKING `onboarded_by` audit is cleared — permanently.** The
   checklist's query was run **verbatim** against prod at 2026-08-30T22:28:33Z and returned
   **0 rows**:

   ```sql
   SELECT b.id, b.name, a.id AS account_id, b.created_at
     FROM businesses b
     JOIN accounts a ON a.id = b.account_id
    WHERE b.is_primary = TRUE
      AND b.archived_at IS NULL
      AND b.onboarded_by IS NOT NULL
      AND a.subscription_status = 'pending_payment'
    ORDER BY b.created_at;
   -- → 0 rows
   ```

   **It is satisfied by construction, not merely satisfied today.** The gate guards against
   rows migration **025** backfilled — every one of which was destroyed by the 2026-07-16
   purge. With 0 rows in all 52 tables and 0 `auth.users`, no legacy row can exist to draw
   the comp. Any `onboarded_by IS NOT NULL` row created from here on is an account you
   deliberately invited, which is precisely who the comp is for. **The audit does not need
   re-running before the coupon is created** — which is what the checklist's "do not create
   the coupon while this is unresolved" was blocking on.
3. **Migration 077's rollback boundary is inert.** The predecessor noted this: 077's
   first-apply normalization UPDATE touched no rows, so there are no normalized
   Copilot/`list` rows for an old binary to fail against. Re-confirmed by D1a.

---

## Carried-forward open items from the 2026-07-17 record

That record closed with four "post-merge launch tasks, recorded so they don't vanish."
Three reached `beta-production-standup.md`. One did not, and this is where it is recovered.

| # | Item | Reached a checklist? | State 2026-08-30 |
|---|---|---|---|
| 1 | **Stripe activation (`charges_enabled`)** | **NO — was orphaned; now tracked** | ✅ **RESOLVED 2026-08-30.** `charges_enabled=True`, `payouts_enabled=True`, `details_submitted=True`, verified against the production `sk_live_` key (D1d). **Now carried as a ticked item in `launch-checklist.md`**, so it can never orphan again — that was the whole lesson. |
| 2 | Live webhook endpoint + `STRIPE_WEBHOOK_SECRET` | Yes — stand-up Phase D3 | Not done. No live endpoint exists. |
| 3 | Prod worker infra (Redis, `SENTRY_DSN`, provider keys, boot-assert env) | Yes — stand-up Phases A/B | Not done. Worker has 27 vars; 6 hard boot gates missing. |
| 4 | §6 smoke → 078 → resume, removing `ws8-cutover-prod-api-deny` | Yes — stand-up Phase D | Not done. **The deny rule is still live.** |

**Item 1 is the lesson.** A blocker recorded only in an evidence file is a blocker that
disappears when the session ends. Evidence files are the log of what happened; they are not
a tracking surface. Anything still owed at a pause must be copied into
`launch-checklist.md` or the stand-up runbook before the session closes.

### Item 4 — the current production freeze, verified live 2026-08-30

Vercel firewall rule `rule_ws8_cutover_prod_api_deny_gogW1I`, still **Enabled**:

```
conditions: environment equals production AND path starts with /api/
action:     Deny
```

Confirmed empirically: `GET https://repworth.net/api/health` → **403**, header
`x-vercel-mitigated: deny`. Public pages return 200, which is why the site looks healthy.
`ZERNIO_RECENT_REVIEW_POLL_DISABLED=true` is still set on the Railway prod worker — the
other half of the same §2 denial. Both are removed at §7.

Also noted: the rule is **absent from the rule table in
`docs/runbooks/vercel-waf-rate-limiting.md`**, which lists four rules where six are live
(the sixth being `qr-redirect-per-ip-enforce`). Add both.

---

## Migration state (introspected, not read from the ledger)

Verified against the prod schema 2026-08-30. Head is **116, minus 078**.

| Migration | State | Evidence |
|---|---|---|
| 077 | **applied** 2026-07-17T02:17:11Z | `accounts.price_variant` present; checkout-lease index + constraint present |
| 078 | **NOT applied** — the only outstanding migration | `businesses.subscription_tier` is nullable; neither `accounts_subscription_tier_check` nor `businesses_subscription_tier_check` exists |
| 105 | applied 2026-08-14 | `accounts.checkout_attempt_coupon_id` present |
| 106 | applied 2026-08-14 | — |
| 109–115 | applied | `solicitation_outreach` constraint/columns, `solicitation_send_breaker`, veto-notice indexes, attribution columns all present |
| 116 | applied 2026-08-30 | `refusal_events` present |

078 applies **inside** this cutover at §7, never as an ordinary missing migration.

---

## Phase log — fill in as the run proceeds

### §6 — strict worker deploy + controlled smoke

- [ ] Stripe `charges_enabled` re-verified. Reading: `____` at `____`Z
- [ ] Live webhook endpoint created **disabled**; API version matches the pin in
      `src/lib/payments/stripe-client.ts`; `invoice.payment_action_required` subscribed
- [ ] `assertWorkerStartupEnv` passes, naming the production lane. Boot log excerpt: `____`
- [ ] Worker Online; healthcheck green
- [ ] `pnpm ws8:stripe-preflight --require-status-convergence` →
      `WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0` at `____`Z
- [ ] Checkpoint recorded: deadline-verification UTC `____`, `AUTOPILOT_PURCHASABLE` = `____`
- [ ] Copilot list + founding Checkout exercised on a disposable account

### §7 — migration 078, then resume

- [ ] Both NULL-safe preflight counts = 0. Recorded: `____`
- [ ] 078 applied via the approved channel at `____`Z
- [ ] Post-apply introspection: `businesses.subscription_tier` NOT NULL, both named CHECK
      constraints present. Output: `____`
- [ ] `ws8-cutover-prod-api-deny` removed and published at `____`Z
- [ ] `curl https://repworth.net/api/health` → **200** at `____`Z
- [ ] `ZERNIO_RECENT_REVIEW_POLL_DISABLED` restored to unset
- [ ] **UTC resume time: `____`**
- [ ] `.claude/CLAUDE.md` standing 078 exception deleted, in the same change

### §8 — verify 105

- [ ] `checkout_attempt_coupon_id` nullable = YES
- [ ] `accounts_checkout_attempt_complete_check` names the coupon column in its cleared branch

---

## Sign-off

- [x] Roles recorded (solo deviation), predecessor evidence linked, HEAD pinned
- [x] **Preflight closed 2026-08-30.** Stripe live verified via `railway run`
      (`charges_enabled=True`, 0 live webhook endpoints, 6 active livemode Prices);
      Infisical `RepWorth` project created, CLI v0.43.128 logged in;
      `alerts@repworth.net` Zoho group live with 5 members. Known non-blocker: the local
      Stripe CLI's `rk_live_` key 401s (D1d-note) — cutover uses `railway run` injection.
- [x] **Zero-state proof complete** — 52/52 `public` tables empty, `auth.users`=0, two
      separated outbox samples both zero, producers denied, no queue infrastructure.
      Quiescence declared 2026-08-30T22:30:03Z. WS8 §2–§3 satisfied by substitution.
- [x] **Launch-checklist BLOCKING `onboarded_by` audit cleared** — checklist query run
      verbatim, 0 rows, satisfied by construction (ticked in `launch-checklist.md`)
- [x] **Phase I pass 1 complete 2026-08-30.** Infisical `prod` holds 43 keys, verified
      byte-for-byte against source, 0 empty, nothing stray. F4 rotation closed — 5 minted,
      3 rotated at their provider. Secret Syncs deliberately NOT configured: four values
      wait on Phase A and three of those are boot gates. Record:
      `docs/runbooks/infisical-production-manifest.md` §12
- [ ] Reconciliation doc corrections 1–5 landed via PR
- [ ] Prod worker Online, all boot gates green on the production lane
- [ ] 078 applied in sequence; legacy price sentinels retained through the rollback window
- [ ] Deny rule removed; `/api/health` returns 200; Zernio poll restored
- [ ] Live webhooks delivering 2xx (Stripe, Resend, Zernio)
- [ ] Alert sink (Discord) receiving a canary for all four routed signals
- [ ] Flag snapshot appended to `launch-flag-readiness.md` — **Railway AND Vercel**
- [ ] 🔴 Hard blockers (PITR drill, legal review, insurance): each **completed**, or covered
      by a dated owner-approved policy decision recorded in `launch-checklist.md`.
      Never tick an incomplete box.
