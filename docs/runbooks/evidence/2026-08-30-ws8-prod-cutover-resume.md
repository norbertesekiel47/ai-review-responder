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

### Doc corrections owed — ALL FIVE LANDED (1–4 in #1025/#1027, 5 on 2026-08-30)

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

**Status.** Corrections 1–4 landed in #1025/#1027 and are verified absent from HEAD by
grep. **Correction 5 landed 2026-08-30**: the Phase B blockquote now points at manifest
§1 as the owner and records all five errors so nobody re-derives them.

Two further contradictions were found inside that same Phase B block and fixed in the
same edit, rather than left standing in a runbook being corrected:

| Was | Is now | Why |
|---|---|---|
| `NODE_ENV=production` (confirm vs ADR 0013) | **leave `NODE_ENV` unset** | ADR 0013 records production Railway as `NODE_ENV` unset with `RAILWAY_ENVIRONMENT_NAME=production`. `requiresProductionConfig()` is already true from the Railway signal. Manifest §8. |
| `MOCK_EXTERNAL_APIS=false` | **do not create the entry** | It is a value gate, not a presence gate. `assertProductionMockModeEnv` throws only on `true`. Absence is correct. Manifest §8. |

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

### Phase A — provision what does not exist

Two facts recorded elsewhere were **stale** and are corrected here.

| Was recorded | Live read 2026-08-30 | Consequence |
|---|---|---|
| "Sentry prod project **does not exist**; only `repworth-staging`" | `find_projects` on org `repworth-nv` returns **two** projects: `repworth-staging` and `repworth-production` | A.1 is a **read**, not a create. `SENTRY_PROJECT=repworth-production` was already correct in Infisical. |
| Infisical project ID | `1735b0d0-286e-4ca3-a53b-f3a7191b163c` | The ID quoted in the resume prompt was truncated. Recovered from `.scratch/inf-read-production.err`. `--env prod` reads 43 keys. |

- [x] **A.1 — Sentry DSN, CLOSED 2026-08-30.** Project `repworth-production`
      already existed under org `repworth-nv`. Its single `Default` key was read
      via the Sentry MCP and written to Infisical `prod` as **both**
      `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` using
      `infisical secrets set --file` from a mode-600 scratch file. Both read
      back with SHA-256 prefix `ee14c7a4175df209`, matching the source file.
      **Infisical `prod` now holds 45 keys.**

      **No staging reuse.** The two DSNs are distinct in both halves —
      production key `d8957a1e…` on project `4512002871001088`; staging key
      `8ec0c3c9…` on project `4511599164850176`. Same org `o4511599159345152`.
      Reusing staging's would have tagged production events `staging`.

- [x] **A.2 — Railway Redis, CLOSED 2026-08-30.** Owner created the service via
      the dashboard template; agent wired the queue URL.

      | Fact | Value |
      |---|---|
      | Service | **`Redis`** (capital R), id `f9573767-3694-4b5e-b7d4-d7fe6dc53da8` |
      | Image | `redis:8.2`, `haTemplateCode: redis-ha` |
      | Volume | `/data` |
      | Private endpoint | `redis` → `redis.railway.internal` |
      | Template variables | `REDISHOST`, `REDISPASSWORD`, `REDISPORT`, `REDISUSER`, `REDIS_PASSWORD`, `REDIS_URL` |
      | **TCP proxy** | **none created** — `list-tcp-proxies` returns `[]`, and the service has no `REDIS_PUBLIC_URL`. Nothing to delete. |

      **Finding F14 — the service is named `Redis`, and every documented copy of
      the reference expression spells it lowercase.** `deployment-guide.md:1296`
      records staging's lowercase name as a deliberate choice *"so the
      `${{redis.…}}` reference resolves"*. The dashboard's Add Redis names it
      `Redis`. The expression set is therefore
      `redis://default:${{Redis.REDISPASSWORD}}@${{Redis.RAILWAY_PRIVATE_DOMAIN}}:6379/1?family=0`.

      **Resolution verified structurally, no value printed:**

      ```
      REDIS_QUEUE_URL present, length 87
        still contains an unresolved ${{...}} : False
        user      : default
        password  : non-empty, 32 chars
        host      : redis.railway.internal
        port/db   : 6379 / 1
        ?family=0 : present
      ```

      **Why the lowercase form would have failed silently.**
      `assertCoreInfraEnv` checks presence, not shape. An unresolved reference
      yields `redis://default:@redis.railway.internal:6379/1?family=0` — a valid
      URL that passes the boot gate, then fails `NOAUTH` on every BullMQ call.
      The worker reports healthy and no job ever runs. Same failure shape as a
      missing `?family=0`. Full record: manifest §13.

- [x] **A.3 — Upstash cache, CLOSED 2026-08-30.** Instance
      `sincere-primate-143545.upstash.io:6379`, `rediss://` (TLS).
      `REDIS_CACHE_URL` written to Infisical `prod` and verified byte-for-byte
      (`55a91f680d1b55ad`). **Infisical `prod` now holds 47 keys.**

      **Proved live before writing:** `redis-cli -u <url> PING` → **`PONG`**.
      The value is not merely well-formed; it reaches the instance and
      authenticates.

      **Not staging's instance** — the check the stand-up's A3 asks for, done by
      host comparison so no value was read:

      | Lane | Cache host |
      |---|---|
      | staging | `saving-mongoose-139950.upstash.io` |
      | production | `sincere-primate-143545.upstash.io` |

      The URL first reached the session with its password masked, then twice
      with the literal placeholder `PASTE_PASSWORD` still in it. Each attempt
      was caught by a structural check **before** any write. Nothing invalid
      ever entered the vault. The file was shredded after the write.

- [x] **A.4 — Worker public domain, ATTACHED 2026-08-30; DNS pending.** Custom
      domain chosen over the generated `*.up.railway.app` for the reasons below.

      | Field | Value |
      |---|---|
      | Domain | `worker.repworth.net`, id `a41807ff-8b11-4bc3-9ec6-9809bb8f720c` |
      | Certificate | `VALIDATING_OWNERSHIP` |
      | **DNS record required** | `worker.repworth.net` **CNAME** → `rhhe86c1.up.railway.app` |
      | Status 2026-08-31 | **`PROPAGATED`** — CNAME added at Cloudflare, DNS only (unproxied), resolving to `rhhe86c1.up.railway.app` |

      `WORKER_PUBLIC_URL=https://worker.repworth.net` is written to Infisical
      `prod`. It passes `assertWorkerPublicUrlFormat` — checked in-session with
      `raw === new URL(raw).origin`. **Infisical `prod` now holds 46 keys.**

      Adding this CNAME cannot disturb the MX/SPF/DKIM/DMARC state that
      `launch-checklist.md` records as a completed hard blocker: `worker.` is a
      new subdomain and touches no existing record.

- [x] **A.5 — GitHub source, CLOSED 2026-08-31T02:36Z.** Production
      `repworth-worker` now carries `source: {repo: RepWorth/ai-review-responder,
      branch: main, checkSuites: false}`.

      An earlier read in the same session showed no source at all. Railway
      collects service edits as **staged changes** that apply only on Deploy, so
      a connect that is not yet deployed reads as absent. Re-read after the
      deploy fired.

      **`checkSuites: false` is correct for this repo, and differs from staging's
      `true` deliberately.** CI here is PR-only — there is no push-to-`main` run
      (`.claude/CLAUDE.md` → CI & repo). A production service told to wait for a
      check suite on `main` would wait for a run that never starts.

      **The hazard the dashboard route avoided is confirmed avoided.** Staging
      still carries `branch: staging`, `checkSuites: true`, unchanged, verified
      after the production connect landed. Had the MCP `connect-service-source`
      been used — it states it "applies to the service in all environments" —
      that branch could have been rewritten to `main`, silently repointing the
      staging worker at production code.

### First production worker deploy — CRASHED, as designed

Connecting the source triggered an immediate build and deploy. It crashed. This
is the expected outcome at this point in the sequence, and it is the most
informative event of Phase A.

| Field | Value |
|---|---|
| Deployment | `4dc7793b-baa0-4221-91b2-95bdb2e396bb` |
| Source | `main` @ `fab6a49c` |
| Started | 2026-08-31T02:36:58Z |
| Status | **CRASHED** 02:38:47Z, after ten restart attempts |
| Thrown | `[worker] Startup assertion failed: [startup] Worker requires STRIPE_WEBHOOK_SECRET (RAILWAY_ENVIRONMENT_NAME=production)` |

**Nothing is broken.** `STRIPE_WEBHOOK_SECRET` is produced at **D.3**, by design
— manifest §1 row 6 and the ordered plan both hold it back until the live Stripe
endpoint exists. The worker cannot boot before D.3 and is not meant to.
`restartPolicyMaxRetries = 10` was **not** raised; the plan forbids it.

**What the crash proves, that a clean boot would not have.** The assertion order
in `worker/config/startup-assert.ts:296` is
`assertProductionMockModeEnv` → `assertCoreInfraEnv` → `assertStripeWorkerEnv` →
… , and within the Stripe list `STRIPE_SECRET_KEY` precedes
`STRIPE_WEBHOOK_SECRET`. Reaching that throw therefore means every gate before
it passed:

| Proven | How |
|---|---|
| The build works end to end | RAILPACK built, `pnpm worker` ran, `tsx worker/index.ts` started |
| `RAILWAY_ENVIRONMENT_NAME=production` | Named in the thrown message. ADR 0013 lane resolution is correct **with `NODE_ENV` unset** — manifest §8 vindicated |
| `MOCK_EXTERNAL_APIS` is not `true` | `assertProductionMockModeEnv` passed. Absence is correct |
| `REDIS_QUEUE_URL` is present and accepted | `assertCoreInfraEnv` passed — **the `${{Redis.…}}` capitalisation fix (F14) clears the gate** |
| `DATABASE_POOL_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` all present | Same gate |
| `STRIPE_SECRET_KEY` is present and non-empty **on Railway** | The throw named the *next* variable in the same list |

That last row is worth keeping. Vercel's `STRIPE_SECRET_KEY` reads as empty
(finding F8); Railway's demonstrably is not. The two platforms disagree, which
narrows F8 to a Vercel-side problem.

**Standing consequence until Phase D.3:** every merge to `main` now triggers a
production deploy that crash-loops and stops. It is noise, not harm — the WAF
still denies all `/api/*` and the database still holds zero rows. Do not "fix"
it by raising the retry count.

- [x] **A.6 — live provider access, FOUR OF FIVE PROVEN 2026-08-30.** Each key
      was pulled from Infisical straight to a mode-600 scratch file and curled
      once. No value entered a transcript.

      | Provider | Probe | Result |
      |---|---|---|
      | OpenAI | `GET /v1/models` | **200** |
      | Anthropic | `GET /v1/models` | **200** |
      | Resend | `GET /domains` | **200** |
      | SerpAPI | `GET /account` | **200** |
      | Zernio | see below | **unproven** |

      **Zernio cannot be proved read-only, and this is a finding.** Every GET
      route in `src/lib/zernio/client/` validates request shape *before* it
      authenticates. `GET /v1/accounts/{id}/gmb-reviews` returns **400** for a
      real key, a bad key and no key alike. `/v1/accounts/{id}` is DELETE-only
      and returns **405** on GET for all three. The only discriminating call is
      `POST /v1/profiles`, which **creates a live Zernio profile** — not run.

      Consequence: the Zernio key is first proved for real at Phase D or E.
      This matters because the smoke-test precedent recorded in
      `beta-production-standup.md` is exactly this failure class — a provider
      key that looked fine and silently was not, for 25 calls.

      **Spend caps set 2026-08-31** — 100 USD at OpenAI, 100 USD at Anthropic,
      owner-reported. Worth one check before Phase D: both providers offer a
      *notification* threshold and a *hard* limit, and only the hard limit stops
      spend. `GLOBAL_DAILY_COST_LIMIT_CENTS` and the two tier caps are RepWorth's
      own ceiling and are already in Infisical; the provider cap is the backstop
      for a bug that defeats them.

      A 200 from `/v1/models` proves the key authenticates. It proves nothing
      about billing state, and that is what the caps cover.

#### `WORKER_PUBLIC_URL` — recommendation: a custom domain

Scaling does not decide this. Railway load-balances behind either name
identically, so replica count favours neither. Four other things do.

1. **It is a webhook signature base, and four providers bind to it.** Zernio
   registers against it at Phase E, Stripe at D.3, Resend at E.1, Twilio when
   channels turn on. Changing the host later means re-registering all four and
   rotating each signing secret.
2. **Provider portability.** A custom domain moves with a CNAME edit. A
   `*.up.railway.app` name forces the four-provider re-registration above.
3. **It survives a service split.** If ingress ever splits from job execution,
   `worker.` and `ingress.` sit under one owned namespace.
4. **The DNS risk is zero.** `worker.` is a **new** subdomain. It cannot
   disturb the MX/SPF/DKIM/DMARC state `launch-checklist.md` records as a
   completed hard blocker — the same reasoning already recorded for
   `alerts@repworth.net`.

`https://worker.repworth.net` passes `assertWorkerPublicUrlFormat`
(`raw === new URL(raw).origin`). Decide once, before Phase E binds Zernio to it.

#### Finding F8 is REFUTED — the nine Vercel variables are Sensitive, not empty

**Settled 2026-08-31, two independent ways.** The owner opened
`STRIPE_SECRET_KEY` in the Vercel dashboard: the value exists and **cannot be
viewed**. That is the Sensitive signature, not the empty one.

`npx vercel@latest env ls production` then settled all nine at once. The current
CLI adds a **`type` column** that the installed **54.14.5 does not have**:

```
total production variables: 35
by type: {'Secret': 9, 'Config': 26}
Secret-type names:
   DB_POOL_MAX
   GOOGLE_SHEETS_CLIENT_EMAIL
   GOOGLE_SHEETS_PRIVATE_KEY
   ONBOARDING_DEMO_ENABLED
   OWNER_LEADS_GOOGLE_SHEET_ID
   OWNER_LEADS_GOOGLE_SHEET_RANGE
   SESSION_COOKIE_SECRET
   STRIPE_SECRET_KEY
   WORKER_INTERNAL_SECRET
```

Nine `Secret`, and they are **exactly** the nine the record called empty. A
Sensitive variable is write-only, so `vercel env pull` returns it zero-length by
design.

**Both arguments that pointed the other way were tooling artifacts.** The
"all 34 report `Encrypted`" reading came from a CLI with no type column — that
label was fixed on every row and could not distinguish the two types. And
`SUPABASE_SERVICE_KEY` pulling a real 219-character value was never a
counterexample: it is type `Config`.

**What this changes:**

| Claim | Status |
|---|---|
| "Production Checkout has been broken since `STRIPE_SECRET_KEY` was set" | **Withdrawn.** The key holds a real value. |
| "Vercel production runs at 10 connections per serverless instance" (F10) | **Withdrawn.** `DB_POOL_MAX` is Sensitive, not empty; `readPoolMax()` never saw a blank. |
| Phase C sets Vercel `DB_POOL_MAX=3` | **Unchanged.** Only the reason changes — from repairing a live defect to pinning a value that cannot be read back. |
| §9 rule 3, "do not import from Vercel" | **Weight increased.** Nine real variables would import blank, three of them credentials. |

**Carry into the first sync.** These nine hold the Sensitive flag today. Whether
an Infisical Secret Sync preserves it or writes them as ordinary encrypted
variables is unknown. Losing it on `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET`
and `WORKER_INTERNAL_SECRET` is a small posture regression. **Re-run
`npx vercel@latest env ls production` after the first sync and diff the `type`
column.**

**Tooling lesson.** One missing CLI column produced a month of confident wrong
conclusions, including an alarming one about live payments. The installed Vercel
CLI is 54.14.5 against a current 59.10.0. Use `npx vercel@latest` for any
type-sensitive read until it is upgraded.


### Phase I sync 1 — Vercel. Ran as Import, damaged, repaired.

**Root cause: the Initial Sync Behavior dropdown was left on Infisical's
default, `Import Destination Secrets - Prioritize Infisical Values`.** The
chosen setting (§14) was Overwrite + Disable Secret Deletion. Infisical behaved
exactly as documented; the configuration was simply not the one decided.

**§14's prediction was correct in every particular**, which is the reason to
keep this record rather than quietly fix it.

#### What the sync did right

| Check | Result |
|---|---|
| Seven legacy `STRIPE_PRICE_*` survived | ✅ rollback window intact |
| `DATABASE_URL` / `DB_POOL_MAX` names not deleted | ✅ |
| Value fidelity — 10 keys sampled against the vault | ✅ **10 / 10 byte-identical** |
| `NEXT_PUBLIC_APP_URL` | ✅ now `https://repworth.net` — **finding F2 closed** |

F2 is closed at the value layer only. `NEXT_PUBLIC_*` is inlined at build time,
so **Vercel must be redeployed** before a browser sees it.

#### What it damaged

1. **The vault grew 47 → 61.** The 14 added names are exactly the predicted
   Import set.
2. **Five arrived EMPTY** — `DB_POOL_MAX` and the four owner-lead names. They
   are Vercel *Sensitive*, so Infisical read nothing from them.
3. **It wrote the empties back.** All four owner-lead values on Vercel
   Production became `''`.
4. **All nine Sensitive variables were downgraded to `Config`** — 9 Secret / 35
   before, 0 Secret / 61 after. `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET` and
   `WORKER_INTERNAL_SECRET` became readable by any `vercel env pull`.

#### Correction — a `vercel env pull` is NOT a backup

The pre-sync backup was reported in-session as covering both platforms. **It did
not cover the nine Sensitive values.** The CLI writes the literal string
`"[SENSITIVE]"` in their place.

> **Operational rule, new:** a Vercel *Sensitive* variable cannot be backed up by
> any CLI read. Its value exists only at Vercel and in whatever wrote it. Before
> any operation that may overwrite one, confirm the value exists somewhere else
> first — `.env.local`, a password manager, or the provider that issued it.

The Railway backup **is** real: 39 variables, all values, mode 600.

#### Repair, and what proved what

| Step | Outcome |
|---|---|
| Located the four owner-lead values in `.env.local` | Service account `@repworth.iam.gserviceaccount.com`, a PEM key, a 44-char sheet id, range `Sheet1!A:K` |
| Owner deleted five empty keys from the vault (web UI) | **Vault 61 → 56, and all 56 hold a value** |
| Restored the four to Vercel with `--sensitive --force` | Back to `Secret`, write-only, confirmed by a pull returning `[SENSITIVE]` |
| Set `DB_POOL_MAX=3` on Vercel as `Config` | Read back as `'3'`. **Phase C item completed early** |

**`Disable Secret Deletion` is ON — proven, not read off a toggle.** Deleting
five keys from the vault left all five standing on Vercel. No check before this
could have tested it, because Import never deletes.

**The Infisical CLI still cannot delete** — re-confirmed at v0.43.128 *with*
`--projectId`, which §12.7 had not previously tried. A direct API call was
attempted and correctly refused by the session sandbox. Deletion is web-UI only.

#### Two deliberate deviations from the plan, both recorded

1. **The seven legacy `STRIPE_PRICE_*` and `DATABASE_URL` stay IN the vault.**
   §8 keeps them native so an Overwrite cannot delete them. Each was verified
   **byte-identical to Railway's**, so vault-managed is strictly safer: they are
   now preserved by *every* strategy rather than by a toggle. This improves on
   the plan; it does not weaken it.
2. **The three credentials stay `Config` until the cutover ends.** Marking them
   Sensitive would end the ability to verify Vercel against the vault by
   readback — the check that caught this incident. **Owed as a hardening step
   after §8 closes:** re-add `STRIPE_SECRET_KEY`, `SESSION_COOKIE_SECRET` and
   `WORKER_INTERNAL_SECRET` with `--sensitive`.

   Note the standing tension: an Infisical sync writes `Config`, so any
   vault-managed key drifts back to Config on the next write. Sensitive cannot
   be maintained on a synced key. That is a cost of locked decision #2, not a
   defect.

#### State after repair

| Store | Count | Detail |
|---|---|---|
| Infisical `prod` | **56** | zero empty |
| Vercel production | **61** | 57 `Config` + 4 `Secret` |
| Railway production | 28 | untouched — its sync is not yet created |

#### Carried forward

- **Vercel needs a redeploy** for the corrected `NEXT_PUBLIC_APP_URL` to reach a
  browser.
- The Railway sync must use **Overwrite**, selected explicitly. Import damage is
  initial-sync only, so a clean vault makes the second sync safe.

---

### Phase I sync 2 — Railway. Overwrite, clean, verified.

Created with **`Overwrite Destination Secrets`** + Disable Secret Deletion + Auto-Sync,
service `repworth-worker` named. Every check passed.

| Check | Result |
|---|---|
| Anything imported back into the vault? | **No.** Still 56 — nothing added, nothing removed |
| `REDIS_QUEUE_URL` | **Intact.** No unresolved `${{…}}`; 32-char password; `redis.railway.internal`; db 1; `?family=0` |
| `DB_POOL_MAX` | **Still `20`** — the drill-blessed value survived |
| `DATABASE_URL` | Unchanged, byte-identical |
| Seven legacy `STRIPE_PRICE_*` | **All present.** Rollback window intact |
| Railway variable count | 39 → **70** |

**This is the controlled comparison that proves §14.** Two syncs, same destination class,
same deletion toggle; the only difference is the step-4 strategy. `Import` imported 14 names
and destroyed four values. `Overwrite` imported nothing and destroyed nothing.

#### Boot gates — 17 of 18 green

Only `STRIPE_WEBHOOK_SECRET` is missing, and D.3 produces it. The Zernio conditional gate is
fully satisfied (`ZERNIO_PUBLISHING_ENABLED=true` with API key, webhook secret, and
`WORKER_PUBLIC_URL=https://worker.repworth.net`). Every exact-boolean gate is correct.
`MOCK_EXTERNAL_APIS` absent, `NODE_ENV` unset — manifest §8 satisfied.

#### Runtime confirmation, and the limit of what it proves

The sync triggered deploy `c0aeb482`. Its log carries one error, ten times:

```
[worker] Startup assertion failed:
[startup] Worker requires STRIPE_WEBHOOK_SECRET (RAILWAY_ENVIRONMENT_NAME=production)
```

`assertWorkerStartupEnv` (`worker/config/startup-assert.ts:296`) throws on the **first**
failure, and `STRIPE_WEBHOOK_SECRET` sits in the **second** check. So the claim must be split:

| Proven **by execution** | Present but **not yet exercised** |
|---|---|
| `assertProductionMockModeEnv` — `MOCK_EXTERNAL_APIS` correctly absent | `DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT` — must parse as positive integers |
| `assertCoreInfraEnv` — `DATABASE_POOL_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, **`REDIS_QUEUE_URL`** | `ADMIN_NOTIFICATION_EMAIL` |
| `assertStripeWorkerEnv` up to the throw — `STRIPE_SECRET_KEY` + six Price IDs, distinct | `SENTRY_DSN` |
| The lane resolves as `production` with `NODE_ENV` unset — ADR 0013 and manifest §8 confirmed | `SESSION_COOKIE_SECRET`, `NEXT_PUBLIC_APP_URL` |
| The build works end to end — RAILPACK, `pnpm worker`, `tsx` | the exact-boolean format gate |

**Twelve gates proven, six proven present but untested.** The first clean boot at D.4 closes
the remaining six. Recording the distinction rather than claiming 17/18 at runtime, because
"present" and "passes" are not the same claim — `DAILY_COST_LIMIT_CENTS_*` in particular has
a parse rule that presence does not test.

`assertCoreInfraEnv` passing **independently clears the F14 fix**: the `${{Redis.…}}`
capitalisation resolves.

---

### D.1 — verify §1, the six live Prices. PASS.

Read-only. Run 2026-08-31T04:46Z through the `railway run` injection pattern, so the
production `sk_live_` key was used but never observed:

```
railway run --environment production --service repworth-worker -- python3 <check>
key prefix: sk_live_ | length: 107
```

| Variable | Price ID | HTTP | Cents | Cur | Interval | Active | Livemode |
|---|---|---|---:|---|---|---|---|
| `STRIPE_PRICE_COPILOT_LIST` | `price_1Tu0tlIhPBLaM6xAh1ncYUyD` | 200 | 2900 | usd | 1/month | true | **true** |
| `STRIPE_PRICE_COPILOT_FOUNDING` | `price_1Tu0tlIhPBLaM6xAqs62deIQ` | 200 | 1900 | usd | 1/month | true | **true** |
| `STRIPE_PRICE_AUTOPILOT_LIST` | `price_1Tu0tmIhPBLaM6xAstHkMhBE` | 200 | 6900 | usd | 1/month | true | **true** |
| `STRIPE_PRICE_AUTOPILOT_FOUNDING` | `price_1Tu0tmIhPBLaM6xAWQWKfjLu` | 200 | 4900 | usd | 1/month | true | **true** |
| `STRIPE_PRICE_COPILOT_OVERAGE` | `price_1Tu0tmIhPBLaM6xAUH8w841l` | 200 | 1500 | usd | 1/month | true | **true** |
| `STRIPE_PRICE_AUTOPILOT_OVERAGE` | `price_1Tu0tnIhPBLaM6xAhDUqdd3r` | 200 | 2000 | usd | 1/month | true | **true** |

```
distinct price ids: 6 of 6
assertStripePriceIdsUnique: all six distinct - PASS
live webhook endpoints: 0
D1_RESULT: PASS
```

**What this closes.** Every amount matches the §1 table exactly. All six carry
`livemode=true`, so none is a test-mode ID pasted into the production lane — the failure
this step exists to catch. All six are `active`, all `usd`, all `1/month` recurring.
`assertStripePriceIdsUnique` therefore passes at boot, which the crashed deploy already
proved by execution (the throw is downstream of it).

**`live webhook endpoints: 0` is re-confirmed**, unchanged from the 2026-08-30 reading and
from the predecessor's 2026-07-17 reading. D.3 creates the first one. This is also the
before-value for D.3's confirmation check, which must then read `1`.

Not checked here: `charges_enabled`. D1d verified it `True` on 2026-08-30 and §6 re-verifies
it at deploy time; that box stays open.

---

### D.2 — verify §5, migration 077. PASS.

Read-only. Run 2026-08-31T04:47Z. The `ws8-tier-cutover.md` §5 introspection, verbatim, plus
the four supplementary reads that section's prose requires (`price_variant` column and
default, the named value constraint, the immutable-update trigger, the partial unique index
definition). Executed with `psql` against the injected `DATABASE_POOL_URL`, which was never
printed.

> **Connection note.** `psql` rejects the pooler URL as given: `invalid URI query parameter:
> "pgbouncer"`. libpq does not accept PgBouncer's `?pgbouncer=true`, which Postgres.js does.
> The query string was stripped in-script (`${DATABASE_POOL_URL%%\?*}`). Same host, same
> port `6543`, same pooler. Anyone re-running this by hand hits the same error first.

```
--- 1. incomplete_snapshot_count (must be 0) ---   0
--- 2. invalid_business_mirror_count (must be 0) ---   0
--- 3. outbox_count_after_077 (baseline; zero-state) ---   0
--- 4. Checkout lease safety objects (both must be true) ---
 checkout_session_index_present | checkout_lease_constraint_present
 t                              | t
```

| §5 requirement | Reading | Verdict |
|---|---|---|
| `incomplete_snapshot_count` = 0 | `0` | PASS |
| `invalid_business_mirror_count` = 0 | `0` | PASS |
| `outbox_count_after_077` equals baseline | `0`, and the zero-state proof fixes the baseline at `0` | PASS |
| `checkout_session_index_present` | `t` | PASS |
| `checkout_lease_constraint_present` | `t` | PASS |

Both invalid-row counts are trivially zero on a zero-state database. That is expected and is
not weaker evidence: §5's purpose is to prove the schema objects exist and are not widened,
and those reads are independent of row count.

**Column, default and nullability — the 077 expansion is complete:**

```
          column_name          |     data_type     | is_nullable |        column_default
-------------------------------+-------------------+-------------+------------------------------
 base_price_cents              | integer           | NO          | 2900
 locations_included            | integer           | NO          | 1
 locations_overage_price_cents | integer           | NO          | 1500
 locations_paid                | integer           | NO          | 0
 price_variant                 | text              | NO          | 'list'::text
 subscription_tier             | character varying | NO          | 'copilot'::character varying
```

`accounts.price_variant` is present, `NOT NULL`, defaulting to `list`. The four Copilot
defaults are the §1 amounts — `2900` base, `1500` overage, `1` included, `0` paid.

**Named value constraint, present and narrow:**

```
accounts_price_variant_check | CHECK ((price_variant = ANY (ARRAY['list'::text, 'founding'::text])))
```

**Immutable-update trigger, present:**

```
 accounts_price_variant_immutable | reject_accounts_price_variant_mutation | user_trigger = t
```

**The partial unique Session index is NOT widened** — the predicate is still present, so the
index constrains only non-NULL Session IDs:

```
CREATE UNIQUE INDEX accounts_checkout_session_id_uniq ON public.accounts
  USING btree (checkout_session_id) WHERE (checkout_session_id IS NOT NULL)
```

Both Checkout-lease objects are launch safety objects. Neither is absent and neither is
widened, so §5's stop condition — *"strict code must not start if either is absent or
widened"* — is satisfied.

#### Two things this run settles as a side effect

1. **Migration 105's §8 verification already reads PASS.** The
   `accounts_checkout_attempt_complete_check` body returned above enumerates
   `checkout_attempt_coupon_id IS NULL` in its cleared branch — the exact D.9 / §8
   expectation. Recorded here because the read was taken now; D.9 still runs its own two
   queries and records the `is_nullable = YES` half.
2. **078 is confirmed still absent, immediately before the phase that applies it.**
   ```
   businesses_tier_is_nullable | accounts_tier_check_present | businesses_tier_check_present
   YES                         | f                           | f
   ```
   That is the exact signature `.claude/CLAUDE.md` records for the standing exception. It
   holds until D.7.

**D2_RESULT: PASS.** §5 is verified. The cutover is executed through §5; the next unexecuted
protocol step is §6.

---

### D.3 — the live Stripe webhook endpoint. CREATED, DISABLED, verified.

Created 2026-08-31T05:11:48Z through `railway run --environment production`, so the
production `sk_live_` key was used but never observed.

```
id          : we_1UANVYIhPBLaM6xAfIMs3eMN
url         : https://worker.repworth.net/ingress/stripe
status      : disabled
api_version : 2026-05-27.dahlia
livemode    : True
application : None
enabled_events (6):
  - checkout.session.completed
  - customer.subscription.deleted
  - customer.subscription.updated
  - invoice.paid
  - invoice.payment_action_required
  - invoice.payment_failed

live webhook endpoints BEFORE: 0
live webhook endpoints AFTER : 1
D3_RESULT: PASS
```

#### The Sandbox trap (F7) is structurally avoided, not merely checked

The endpoint was created **by API, with the deployed `sk_live_` key**. That key *is* the
live account — no browser session, no account dropdown, no Sandbox context can enter the
path. `livemode: True` on the created object and `live webhook endpoints: 1` on the
re-run Phase 0.2 check are the two independent confirmations the plan asks for. A dashboard
confirmation is no longer load-bearing.

#### The endpoint cannot be created disabled — recorded, because the plan says otherwise

`POST /v1/webhook_endpoints` accepts `url`, `enabled_events`, `api_version`, `connect`,
`description`, `metadata`, `expand`. It has **no `disabled` parameter**. `disabled` exists
only on the update call. Verified against this account's own OpenAPI schema
(`openapi_spec_version 2026-06-24.preview`), not from memory.

So "create it disabled" is not one act. The run was **create, then disable in the next
call**, leaving an enabled window under a second.

**Why that window is not a risk here.** Live has zero customers and zero subscriptions
(zero-state proof), the WAF denies every production `/api/*`, and no Checkout has ever
run in live mode — so no live event could be generated. Inbound handling is idempotent
through `claimInboundEvent` in any case. The endpoint read back `status: disabled`.

#### `api_version` is create-only — a permanent choice, recorded as such

The update call accepts `url`, `enabled_events`, `description`, `metadata` and `disabled`.
It does **not** accept `api_version`. The value is therefore frozen for the life of the
endpoint. Changing it means deleting the endpoint and creating a new one, which mints a
**new signing secret** and forces a fresh Infisical write, sync and worker restart.

Three checks before writing it:

1. The pin in `src/lib/payments/stripe-client.ts:17` is `'2026-05-27.dahlia'`.
2. `2026-05-27.dahlia` is in the live account's accepted `api_version` enum.
3. A live `GET /v1/account` carrying `Stripe-Version: 2026-05-27.dahlia` returned HTTP 200.

**Owner approved the permanence explicitly**, 2026-08-31, after the create-only property
was explained.

> **Standing obligation, new.** The endpoint's `api_version` is frozen; the pin in
> `stripe-client.ts` is not. A future `stripe` SDK bump that moves that pin puts the two
> out of lockstep, and the failure is silent: the event arrives, the signature verifies,
> the handler reads a moved or renamed field as `undefined` and takes the wrong branch.
> **Any change to `STRIPE_CLIENT_CONFIG.apiVersion` must be paired with recreating this
> endpoint** (delete → create → new `whsec_` → Infisical → sync → restart). Nothing in CI
> enforces this today, because the endpoint's version lives at Stripe, not in the repo.

#### Event set — exactly the six the worker handles

`worker/ingress/stripe.ts:71-96` switches on `event.type` with six `case` arms and a
`default` that logs `Unhandled event type — ignoring`. The subscription matches it exactly:

| Event | Handler |
|---|---|
| `checkout.session.completed` | `worker/ingress/stripe/checkout-completed.ts` |
| `invoice.paid` | `worker/ingress/stripe/invoice-paid.ts` |
| `invoice.payment_failed` | `worker/ingress/stripe/invoice-payment-failed.ts` |
| `invoice.payment_action_required` | `worker/ingress/stripe/invoice-payment-action-required.ts` |
| `customer.subscription.updated` | `worker/ingress/stripe/subscription-updated.ts` |
| `customer.subscription.deleted` | `worker/ingress/stripe/subscription-deleted.ts` |

`invoice.payment_action_required` — the one the plan flags as easy to omit — **is
subscribed**. It has a live handler; omitting it would mean a bank's 3-D Secure challenge
on a renewal never reaches the worker.

Unlike `api_version`, `enabled_events` and `url` **are** updatable, so this list is
cheap to correct later.

#### The signing secret

Returned **only** in the create response — a later retrieve does not include it. Captured
directly into a mode-600 gitignored file and never printed. Shape recorded as structure
only: prefix `whsec_`, length 38.

Written to Infisical `prod` with `infisical secrets set --file`, whose output table masks
values:

```
│ STRIPE_WEBHOOK_SECRET │ ****** │ SECRET CREATED │
```

Verified by round-trip **hash comparison**, not by reading either value:

| Check | Result |
|---|---|
| Infisical `prod` key count | 43 → 56 → **57** |
| `STRIPE_WEBHOOK_SECRET` present | yes |
| Shape | prefix `whsec_`, length 38 |
| `sha256(vault)[:12]` vs `sha256(stripe create response)[:12]` | `50af6fce25d0` == `50af6fce25d0` — **MATCH** |
| Empty secrets in `prod` | **0** |

**The 18th boot gate now exists.** Manifest §1 row 6 moves from *missing* to *set*.

#### Blocker carried into D.5 — the worker certificate is not issued

Railway reports `worker.repworth.net` at `CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP`
with `verified: false`. The CNAME to `rhhe86c1.up.railway.app` reads
`DNS_RECORD_STATUS_PROPAGATED`, and `certificate.errorMessage` is `null` — so it is still
issuing, not failing. A direct request confirms the client-side symptom:

```
curl https://worker.repworth.net/
curl: (60) SSL: no alternative certificate subject name matches target host name
```

**Creating the endpoint now is safe** — Stripe does not probe the URL at create time, and
the endpoint is disabled. **Enabling it at D.5 is not**, until the certificate issues:
every delivery would fail TLS before it reached Fastify. Owner decision, 2026-08-31:
create now, re-check the certificate at D.5. **D.5 must not enable the endpoint while
`verified: false`.**

---

### D.4 — the first clean production worker boot. PASS, after an incident.

The sync from D.3 triggered a Railway redeploy, as designed. It brought up the **wrong
process**. The incident and its fix are recorded in full below, because the failure mode
is permanent, applies to every future variable change on this service, and reported
**SUCCESS / Online** the whole time it was wrong.

#### The incident — a false-healthy production deploy

Deployment `9c272e61`, triggered at 2026-08-31T05:12:54Z by the Secret Sync write:

```
Starting Container
$ next start
▲ Next.js 16.3.0
✓ Ready in 90ms
```

`next start` is the **Next.js UI**, not `tsx worker/index.ts`. No BullMQ consumers, no
pollers, no `assertWorkerStartupEnv`. Railway reported the deployment **SUCCESS** and the
service **Online**.

**Why it looked healthy.** `healthcheckPath` is `/api/health`, and that route exists in
the Next.js app as well as the worker. Railway probed it, got 200, reported Online. This
is the same shape as the `${{Redis.…}}` capitalisation trap in manifest §13: a check that
tests *presence of a response* rather than *identity of the responder* cannot tell a
healthy worker from a healthy impostor.

> **Standing rule.** On `repworth-worker`, "Online" is not evidence. Require a **poller
> cycle in the service's own logs** before calling the worker up.

#### Root cause — a `redeploy` resolves NO deploy configuration

The previous deployment `2c4b870d`, at the **same commit** `06a163f0`, ran
`$ tsx worker/index.ts` correctly 29 minutes earlier. `railway.toml` was unchanged and
present on `main` throughout, so the repo was not the variable.

`railway.toml` is the only thing that sets `startCommand = "pnpm worker"` and overrides
Railpack's auto-detected `next build` / `next start`. **A `redeploy` does not read it —
and does not read the service's own settings either.** Isolated rather than assumed:
`startCommand`/`buildCommand` were set **explicitly on the service**, the read-back
confirmed them, and a second `redeploy` (`32a54658`) *still* ran `next start` and *still*
ran `next build`. So the fallback ignores both mechanisms.

The distinguishing factor is the deployment **kind**, visible as `reason` in
`list-deployments`:

| `reason` | Trigger | Resolves config? | Observed |
|---|---|---|---|
| `deploy` | new commit on the source branch, or `redeploy --from-source` | **yes** | `2c4b870d`, `2e9a5dc4` → `tsx worker/index.ts` |
| `redeploy` | dashboard redeploy, **any variable change** | **no** — Railpack auto-detect | `9c272e61`, `32a54658` → `next start` |

**That second row is the trap that matters going forward.** Every secret rotation and
every flag flip on this service fires a `redeploy`. A worker that is correct today
reverts to `next start` the next time anyone touches a variable — silently, reporting
Online.

#### The fix, in three parts

**1. Mirror the config onto the Railway service, per environment.** Five fields, set on
`repworth-worker` in **both** environments so behaviour no longer depends on one
mechanism: `startCommand`, `buildCommand`, `healthcheckPath`, `restartPolicyType`,
`restartPolicyMaxRetries`. `restartPolicyMaxRetries` is **10** — the documented bound,
not raised.

> **`repworth-worker` is ONE service shared by BOTH environments** (`fb413c72-…`).
> Railway's `update-service` API updates **all** environments when `environmentId` is
> omitted. Every call in this run passed it explicitly. Staging was verified undisturbed
> afterwards — same deployment `f661c9a6` from 02:01Z, pollers cycling straight through
> the write at 06:0xZ.

**2. Recover with a SOURCE deploy, not a redeploy.**

```bash
railway deployment redeploy --from-source \
  --service repworth-worker --environment production \
  --project ad641d0e-dc01-4250-b71c-db1beedb9c8c --yes
```

`--from-source` pulls the latest commit from the configured source and produces a
`reason: deploy` deployment, which resolves configuration normally. Plain `redeploy` —
CLI, dashboard or MCP — is not a fix. Railway's own "use redeploy to apply immediately"
note on service updates is wrong for this case.

**3. Make the repo say so.** `railway.toml`'s header, `deployment-guide.md` §5.1, and
lab-notes 2026-08-31 "Railway deploy configuration" all now carry the rule. The
`railway.toml` values and the service values must stay identical — **change one, change
both**.

#### Separately: Config as Code is deprecated

`railway.toml` / `railway.json` stop being read on **2026-12-01**, and new services
cannot opt into them. This is **not** the cause of the incident above — a `redeploy`
ignored the service settings too. The mirror in part 1 already removes the single point
of failure, so the cutoff is a documentation-truth problem rather than an outage waiting
to happen. Migration to `.railway/railway.ts` is recorded as a dated obligation in
`docs/launch-checklist.md`.

**`railway config migrate` output is NOT safe to apply as generated.** The 2026-08-31 dry
run produced a file that (a) names the service **`RepWorth`** — taken from the *project*
name, not the real `repworth-worker` — so `railway config apply` would **create a second
service** rather than update the existing one, and (b) silently **drops
`restartPolicyType` and `restartPolicyMaxRetries`**, carrying over only
build/start/healthcheck.

#### The recurrence guard — because the mirror alone does NOT stop this happening again

Recording this because the obvious reading of the fix above is wrong. Mirroring the config
onto the service restored the worker; **it does not prevent recurrence.** The proof is in
the root-cause section: redeploy `32a54658` ran with `startCommand` set explicitly on the
service and *still* ran `next start`. A `redeploy` ignores the service settings too.

So the fault is still armed. Every secret rotation and every flag flip on this service
fires a `redeploy`, and each one would bring the impostor back — silently, reporting
Online. A worker that is correct today and wrong after the next `flag-flip` run is not
fixed.

**What actually disarms it: make the impostor fail the healthcheck.**

`healthcheckPath` was `/api/health`. That route exists in the Next.js app as well as the
worker, which is the entire reason the impostor looked healthy. Changed to **`/ready`**,
which `worker/index.ts:638` serves and Next.js does not — Next's nearest route is
`/api/health/ready`, a different path.

| Deployment | `/ready` | Result |
|---|---|---|
| Real worker | 200 `{"status":"ready","service":"worker"}` | Deploy succeeds |
| `next start` impostor | 404 — no such Next.js route | **Healthcheck fails → deployment marked FAILED → Railway keeps the last good deployment live** |

The silent failure becomes a loud one that cannot reach production. Set on **both**
environments, each with `environmentId` passed explicitly.

**Verified before switching, not after.** The path was exercised against a live worker
first — staging's public Railway domain, which has no certificate problem:

```
GET https://repworth-worker-staging.up.railway.app/ready → HTTP 200
{"status":"ready","service":"worker",
 "checks":{"postgres":"ok","queue_redis":"ok","cache_redis":"ok"}}
```

> **This REVERSES a deliberate documented choice, and the tradeoff is accepted knowingly.**
> `railway.toml` described `/api/health` as a *"dependency-light endpoint (no DB/queue/
> external calls); 200 = ready"*. `/ready` runs three live probes — `postgres`,
> `queue_redis`, `cache_redis` — so a deploy now fails if any of them is unreachable at
> deploy time.
>
> Accepted because the direction of failure is **fail-safe**: a failed healthcheck leaves
> the running deployment up, whereas the old posture let a dead worker replace a live one
> and report green. This incident is the evidence that a false POSITIVE costs far more
> than a false negative here — a worker that was not running, through a production
> cutover, on a dashboard showing Online.
>
> **The cost is bounded, and this was checked rather than assumed.** Railway's docs:
> *"Railway calls the endpoint at deploy time, **not continuously** after the deployment is
> live"*, and *"if the endpoint never returns 200 in that window, the deployment is marked
> failed and **the previous one keeps serving traffic**"* — a 300-second window by default.
> So the three probes gate one moment per deploy; they are never a runtime restart risk,
> and a transient blip has five minutes to clear. That turns the tradeoff from
> "defensible" into "clearly correct".
>
> **Follow-up that restores the light posture:** add a worker-only, dependency-free `GET`
> (e.g. `/healthz/worker`) in `worker/index.ts` and point the healthcheck at it. Not done
> in this run — it is a change to the worker's boot surface that cannot be verified until
> it merges, which is the wrong shape of risk mid-cutover.

#### The clean boot — deployment `2e9a5dc4`, 2026-08-31T06:10:47Z

```
$ tsx worker/index.ts
[worker] Feature flags: Telegram=off, WhatsApp=off, SelfServeSignup=off, ZernioPublishing=on
Worker listening {"port":8080,"deployment_lane":"production",
  "lane_source":"RAILWAY_ENVIRONMENT_NAME","service_name":"repworth-worker",
  "railway_environment":"production","replica_region":"us-west2",
  "deployment_id":"2e9a5dc4-fd45-457a-8f15-0eb2e637e134"}
[boot] readiness cure complete — background loops staggered, workers resumed
```

**`assertWorkerStartupEnv` passed**, naming the production lane. Verified by absence as
well as presence — across the whole deploy log:

| Grep | Count |
|---|---|
| `[startup] Worker requires` / `Startup assertion failed` | **0** |
| `next start` | **0** |
| `NOAUTH` / `ECONNREFUSED` / `ETIMEDOUT` / redis errors | **0** |
| `"level":"error"` / `"level":"fatal"` / `[ERRO]` / `[FATA]` | **0** |

**The six previously-unexercised boot gates are now CLOSED.** The 2026-08-30 record split
the claim into "twelve proven by execution, six present but untested", because
`assertWorkerStartupEnv` throws on the first failure and `STRIPE_WEBHOOK_SECRET` sat in
`assertStripeWorkerEnv`, its **third** check.

Two call sites carry the six, so the proof is stated per site rather than as one sweep:

- **Four of them sit after the old throw inside `assertWorkerStartupEnv`**
  (`worker/config/startup-assert.ts:294`), whose order is
  `assertProductionMockModeEnv → assertCoreInfraEnv → assertStripeWorkerEnv →
  assertTierDailyCostLimitsConfigured → assertAdminNotificationEmail → assertAlertSinkEnv
  → assertServerOnlyFeatureOptionalBooleansEnv`. Reaching the end of that function proves
  the last four ran.
- **The other two are a different call site.** `SESSION_COOKIE_SECRET` and
  `NEXT_PUBLIC_APP_URL` are gated by `assertUnsubscribeIngressConfigured`, called from
  `worker/index.ts:596` — separately from `assertWorkerStartupEnv`, and alongside
  `assertWorkerConfig()` at line 583. Both sit **above** the `Worker listening` log at
  line 717, so that log line is the proof they ran.

All six executed:

| Gate | Closed by this boot |
|---|---|
| `DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT` | `parseRequiredPositiveCostLimitCents` accepted both — the positive-integer parse rule that presence could not test |
| `ADMIN_NOTIFICATION_EMAIL` | `assertAdminNotificationEmail` passed |
| `SENTRY_DSN` | `assertAlertSinkEnv` passed |
| `SESSION_COOKIE_SECRET` | `assertUnsubscribeIngressConfigured` passed — ≥32 bytes |
| `NEXT_PUBLIC_APP_URL` | same gate passed |
| exact-boolean format gate | `assertServerOnlyFeatureOptionalBooleansEnv` passed on all seven names |

**All 18 unconditional boot gates are now proven at runtime, on the production lane.**
Manifest §1 has no `missing` row left.

The Zernio conditional gate is satisfied too — `ZernioPublishing=on` with its API key,
webhook secret and `WORKER_PUBLIC_URL` all accepted by `assertZernioPublishingEnv`.

#### The worker is proven running by its own behaviour, not by the healthcheck

Pollers and schedulers started and cycled:

```
OutboxPoller           Starting {"interval_ms":5000,"batch":50,"dispatch_timeout_ms":10000,
                                 "max_cycle_ms":60000,"watchdog_stale_ms":900000}
HealthAlertPoller      Starting {"interval_ms":300000}
JudgeSweepPoller       Starting (interval=60000ms)
AutonomyGovernorScheduler  Starting (interval=900000ms)
AnalyticsDispatchPoller    Starting {"interval_ms":30000,"batch":50}
SolicitationReleasePoller  Release cycle complete {"released":0, … "itemFailures":0}
ArchivalPoller             Nothing to archive
EngagementMonitorPoller    No engagement alerts needed
CancellationGracePoller    No expired cancelled accounts to archive
```

**`REDIS_QUEUE_URL` is proven working, not merely present.** `OutboxPoller` and the BullMQ
workers registered with no `NOAUTH`. That is the check `assertCoreInfraEnv` structurally
cannot make (manifest §13: it tests presence, not shape), so the `${{Redis.…}}`
capitalisation fix is now confirmed by queue behaviour rather than by URL structure.

Flags read exactly as the beta posture requires — self-serve signup off, both channels
off, offboarding off, Zernio publishing on. `ZernioRecentReviewPoller` logged
`Skipped - ZERNIO_RECENT_REVIEW_POLL_DISABLED=true`: the §2 producer denial is **still in
force**, correctly, until D.8 lifts it.

#### State after D.4

| Item | State |
|---|---|
| Production worker | **Online**, `tsx worker/index.ts`, deployment `2e9a5dc4` |
| Boot gates | **18/18 proven at runtime** on the production lane |
| Staging worker | Undisturbed — `f661c9a6` from 02:01Z, still cycling |
| Stripe endpoint | Still `disabled` — re-verified 06:11:52Z, nothing in this work enabled it |
| Producer denial | Still on (`ZERNIO_RECENT_REVIEW_POLL_DISABLED=true`) |
| WAF deny rule | Still Enabled — production `/api/*` still 403 |

#### Blocker still open for D.5 — the worker certificate

Re-checked 2026-08-31T06:12:50Z. Unchanged since D.3:

```
certificate.status : CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP
certificate.error  : null            (issuing, not failing)
verified           : false
CNAME              : DNS_RECORD_STATUS_PROPAGATED → rhhe86c1.up.railway.app
curl https://worker.repworth.net/api/health
  curl: (60) SSL: no alternative certificate subject name matches target host name
```

The worker is healthy **inside** Railway; it is not reachable from outside. **D.5 must not
enable the Stripe webhook endpoint while `verified: false`** — every delivery would fail
TLS before reaching Fastify.

---

### §6 — strict worker deploy + controlled smoke

- [x] Stripe `charges_enabled` re-verified. Reading: **`True`** (also `payouts_enabled=True`,
      `details_submitted=True`) at **2026-08-31T05:14:26Z**
- [x] Live webhook endpoint created **disabled**; API version matches the pin in
      `src/lib/payments/stripe-client.ts`; `invoice.payment_action_required` subscribed —
      `we_1UANVYIhPBLaM6xAfIMs3eMN`, `status=disabled`, `api_version=2026-05-27.dahlia`,
      6 events, `livemode=True`, created 2026-08-31T05:11:48Z. See **D.3** above.
      **Not yet enabled** — D.5 gates on the `worker.repworth.net` certificate issuing
- [x] `assertWorkerStartupEnv` passes, naming the production lane. Boot log excerpt:
      `Worker listening {"deployment_lane":"production","lane_source":"RAILWAY_ENVIRONMENT_NAME",`
      `"service_name":"repworth-worker","railway_environment":"production"}` — deployment
      `2e9a5dc4` at 2026-08-31T06:10:55Z. Zero `[startup] Worker requires` lines in the log.
      **All 18 gates now proven at runtime**; the six previously untested are closed. See **D.4**.
- [x] Worker Online; healthcheck green — **and proven by poller cycles, not by the
      healthcheck**, which this run showed can pass on the Next.js app instead of the
      worker. `OutboxPoller`/`HealthAlertPoller`/`JudgeSweepPoller` started;
      `SolicitationReleasePoller` logged `Release cycle complete`. No `NOAUTH`, so the
      `${{Redis.…}}` fix is confirmed by queue behaviour. See **D.4**.
- [x] `pnpm ws8:stripe-preflight --require-status-convergence` →
      `WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0 fixed_point_notices=0`
      at **2026-08-31T07:02Z**, preceded by `WS8_PREFLIGHT_PASS blockers=0`. Scanned
      counts all zero (`subscriptions=0 open_sessions=0 line_items=0 expired_sessions=0
      status_notices=0`) — a real execution that found nothing, not a skip. See **D.5**.
- [x] Checkpoint recorded: deadline-verification UTC **2026-08-31T07:02:51Z**
      (`FOUNDING_DEADLINE=2027-01-01T00:00:00Z`, `now < deadline` = **True**),
      `AUTOPILOT_PURCHASABLE` = **`false`**. Beta posture intact —
      `AUTO_APPROVAL_ENABLED`/`SELF_SERVE_SIGNUP_ENABLED`/`TRIAL_ENABLED` all `false`,
      `ZERNIO_RECENT_REVIEW_POLL_DISABLED` still `true`. See **D.5**.
- [ ] Copilot list + founding Checkout exercised on a disposable account —
      **SKIPPED by owner decision 2026-08-31. Deliberately left unticked.** A skipped step
      is not a passed one. Consequence: the first live Checkout will be a beta tester's.
      Carried to Phase H, before tester one is invited. See **D.6**.

### D.4a — the worker certificate ISSUED. The D.5 blocker is cleared.

Carried into this run as the one open blocker. Resolved 2026-08-31T07:00:46Z.

#### Root cause of the 4.5-hour stall

The domain was created at **02:28:14Z** (`railway domain status … --json` →
`domain.createdAt`). Railway held it at `CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP`
with `verified: false` for four and a half hours.

Nothing was wrong with DNS. Verified before touching anything:

| Check | Result |
|---|---|
| `CNAME worker → rhhe86c1.up.railway.app` | Correct, `DNS_RECORD_STATUS_PROPAGATED` |
| Resolves to | `69.46.46.110` — identical to the Railway edge target |
| `CAA` on `repworth.net` | **none** — nothing restricted Let's Encrypt |
| Cloudflare proxy | off (DNS only), as A.4 recorded |
| `/.well-known/acme-challenge/…` over HTTP | **404**, not a redirect — the edge was ready to serve a challenge |
| `syncStatus` | `ACTIVE` |

**Two things were actually missing.**

1. **No healthy deployment to validate against.** The domain was created at 02:28Z. The
   worker had no healthy deployment until **06:10:55Z** — first crash-looping on
   `STRIPE_WEBHOOK_SECRET`, then running the Next.js impostor (see D.4). Railway validates
   a custom domain by routing to a live service, and for those four hours there was
   nothing to route to.
2. **The ownership TXT record did not exist.** `dig +short TXT
   _railway-verify.worker.repworth.net` returned empty. Railway's **API** never surfaced
   it — `domain-status` lists exactly one required record, the CNAME, with
   `purpose: DNS_RECORD_PURPOSE_TRAFFIC_ROUTE`. Only the **dashboard** dialog named it.
   That asymmetry is why it went unnoticed: an API-driven check reports "all required DNS
   records propagated" while ownership verification is starved.

#### The Cloudflare one-click integration was DECLINED, deliberately

Railway's dashboard offered a Cloudflare integration that would have made three changes:

| Change | Verdict |
|---|---|
| **Add** `TXT _railway-verify.worker` | The one useful action |
| **Add** `CNAME worker` → same target, **Proxied** | **Rejected** |
| **Delete** the existing `CNAME worker`, DNS only | **Rejected** — unnecessary |

Rejected because the proxy flip is the wrong direction on three counts:

1. **It attacks the thing being fixed.** Proxied means Cloudflare terminates TLS, so
   Railway's ACME challenge would be answered by Cloudflare's edge and issuance could not
   complete.
2. **It contradicts a recorded decision.** A.4 records the CNAME as *"DNS only
   (unproxied)"*, chosen deliberately.
3. **It puts Cloudflare's bot rules in front of `/ingress/stripe`** — a live payments
   webhook path. A new failure surface on the money path, added mid-cutover.

The CNAME needed no change at all: Railway's own API already read it as correct and
propagated. **Only the TXT was missing, so only the TXT was added**, by hand, DNS only.
Minimal change beats a bundled one during a cutover.

#### Resolution timeline

| UTC | Event |
|---|---|
| 02:28:14 | Domain created. Certificate enters `VALIDATING_OWNERSHIP` |
| 06:10:55 | First healthy worker deployment (D.4). The routing precondition is met |
| ~06:56 | Owner adds `TXT _railway-verify.worker`, DNS only, by hand |
| 06:58 | TXT verified at the authoritative NS (`wally.ns.cloudflare.com`) and on `1.1.1.1` / `8.8.8.8`. One record, no duplicates |
| **07:00:34** | Status → `CERTIFICATE_STATUS_TYPE_ISSUING`. **Ownership validated** |
| **07:00:46** | Status → `CERTIFICATE_STATUS_TYPE_VALID` |
| 07:01:11 | TLS verified end to end from outside |

```
subject = CN=worker.repworth.net
issuer  = C=US, O=Let's Encrypt, CN=YR1
valid   = Aug 31 06:02:11 2026 GMT  →  Nov 29 06:02:10 2026 GMT
```

**Note the dashboard dialog still showed an amber warning on the TXT row after it had
already worked.** The UI lags the validator. Trust `dig` and the API status, not the
dialog.

#### The worker is now publicly reachable, and it is the WORKER

```
GET https://worker.repworth.net/api/health → HTTP 200, tls_verify=0, 92 ms
{"status":"ok","service":"worker","uptime_seconds":736}

GET https://worker.repworth.net/ready      → HTTP 200
{"status":"ready","service":"worker",
 "checks":{"postgres":"ok","queue_redis":"ok","cache_redis":"ok"}}
```

`"service":"worker"` on both — the D.4 impostor could not produce that. And `/ready`
answers all three dependency probes `ok` from **outside** the private network, which is
the first external proof that the Redis and Postgres wiring is sound.

---

### D.5 — enable the endpoint, run the convergence gate. PASS.

#### The ingress route was probed BEFORE the endpoint was enabled

So that Stripe's first live delivery would not also be the route's first ever test:

```
POST https://worker.repworth.net/ingress/stripe   (no signature, body {})
  → HTTP 401  {"error":"missing_signature"}

GET  https://worker.repworth.net/ingress/stripe
  → HTTP 404   (POST-only route, as registered at worker/index.ts:685)
```

The 401 is the correct answer and confirms the working rule that a webhook handler
**verifies the signature FIRST**. An unsigned request is rejected before any parsing.

#### Endpoint enabled 2026-08-31T07:02:09Z

```
BEFORE: status=disabled url=https://worker.repworth.net/ingress/stripe
        api_version=2026-05-27.dahlia events=6 livemode=True
AFTER : status=enabled  url=https://worker.repworth.net/ingress/stripe
        api_version=2026-05-27.dahlia events=6 livemode=True
  - checkout.session.completed
  - customer.subscription.deleted
  - customer.subscription.updated
  - invoice.paid
  - invoice.payment_action_required
  - invoice.payment_failed
D5_ENABLE: PASS
```

Run through `railway run --environment production`, so the `sk_live_` key was used and
never observed. The read-back re-asserts all four invariants — `enabled`, `livemode`, the
exact URL, the pinned `api_version`, and six events.

#### The convergence gate

```
$ railway run --environment production --service repworth-worker -- \
    pnpm ws8:stripe-preflight --require-status-convergence

SCANNED subscriptions=0 open_sessions=0 line_items=0 expired_sessions=0 status_notices=0
WS8_PREFLIGHT_PASS blockers=0
WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0 fixed_point_notices=0
```

The required literal `WS8_STATUS_CONVERGENCE_PASS blockers=0 actionable_notices=0` is
present. `fixed_point_notices=0` as well, so there is no `applier_noop_fixed_point`
evidence to record — §6 asks for it only when such notices exist.

**Every scanned count is zero, and that is the zero-state proof holding.** There are no
subscriptions to converge, no open Checkout Sessions carrying a legacy Price, and nothing
expired. The gate is a real execution against live Stripe and the production database, not
a skip: it enumerated and found nothing.

The script is **non-mutating** here — its only possible write is explicitly expiring open
Sessions containing a retained legacy Price, and `open_sessions=0`.

#### Post-enable checkpoint, recorded per §6

| Field | Value |
|---|---|
| Checkpoint UTC | **2026-08-31T07:02:51Z** |
| `FOUNDING_DEADLINE` | `2027-01-01T00:00:00Z` |
| Deadline verification | `now < deadline` → **True** — founding pricing is live |
| **`AUTOPILOT_PURCHASABLE`** | **`false`** — required, and unchanged |
| `AUTO_APPROVAL_ENABLED` | `false` |
| `SELF_SERVE_SIGNUP_ENABLED` | `false` |
| `TRIAL_ENABLED` | `false` |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` | `true` — the §2 producer denial still in force |

The beta posture of locked decision 7 is intact. Nothing in D.5 touched a flag.

**What D.5 does NOT prove.** No live event has been delivered yet, because a zero-state
account generates none. The endpoint is armed and the route answers correctly; a real
signed delivery is first exercised at Phase H. Recording that rather than implying the
webhook is proven end to end.

---

### D.6 — SKIPPED by owner decision, 2026-08-31

The §6 Checkout smoke was **not run**. Owner decision, recorded rather than quietly
dropped, because it removes a real proof from the record.

**What it would have proved.** A live Copilot list and founding Checkout on a disposable
account, through the operator allowlist, exercising the frozen lease create tuple, the
Session retry path, and the tier-reselection rules in §6's list.

**The consequence, stated plainly.** No Checkout has ever completed in live mode against
this account. **The first real live Checkout will be a beta tester's, not a test one.**
The pieces around it are individually verified — six live Prices resolve and are distinct
(D.1), 077 and 105 are present (D.2, D.9), the webhook endpoint is armed with the right
API version and events (D.3, D.5), the convergence gate is clean (D.5) — but the path has
not been walked end to end in production.

**What partially compensates.** The same flow is exercised on staging, and the §6 list is
staging-verified there. The zero-state means there is no legacy data for a first Checkout
to collide with. `AUTOPILOT_PURCHASABLE=false` keeps the untested Autopilot arms closed.

**Carried forward to Phase H**, which already owns "one deliberate post clicked by a
human". A first live Checkout belongs beside it, before tester one is invited.

The §6 checklist box stays **unticked**. It is not done, and a skipped step is not a
passed one.

---

### D.7 — apply migration 078. APPLIED and VERIFIED.

The last migration gap between staging and production. Applied 2026-08-31T07:09Z.

#### Staging first — verified, not assumed

The lockstep rule is "staging first". Staging was re-introspected immediately before the
apply rather than trusted from the standing-exception wording:

```
staging: accounts_tier_is_nullable   = NO
         businesses_tier_is_nullable = NO
         accounts_tier_check_present   = true
         businesses_tier_check_present = true
```

078 was already there. This apply closed a **prod-only** gap; it did not lead staging.

#### Preflight — clean, and the documented absence signature intact

```
accounts_invalid_count      0        accounts_total    0
businesses_invalid_count    0        businesses_total  0
                                     outbox_total      0

accounts_tier_is_nullable       NO     (already NOT NULL since migration 034)
businesses_tier_is_nullable     YES    ← 078 absent, exactly as documented
accounts_tier_check_present     false  ← 078 absent
businesses_tier_check_present   false  ← 078 absent
m077_price_variant_present      true   ← 077 applied
m105_coupon_col_present         true   ← 105 applied
```

Both §7 NULL-safe counts are **0**. The absence signature matches `.claude/CLAUDE.md`'s
recorded description word for word, and 077/105 are both present — so the ordering
precondition ("apply only after 077") holds by observation, not by ledger.

#### Applied through the approved channel

`mcp__supabase__apply_migration`, name `078_copilot_autopilot_contract`, the file
`supabase/migrations/078_copilot_autopilot_contract.sql` **verbatim**. Not retyped, not
adapted.

The migration is self-defending: it re-runs both NULL-safe preflights *inside* the
transaction and raises `23514` before touching any constraint, so a race between our
preflight read and the apply could not have slipped through. It is one atomic `DO` block,
and re-runnable — it drops each same-named CHECK scoped by both `conname` and `conrelid`
before re-adding it, so a stale or widened definition is repaired rather than trusted.

#### Post-apply verification — by introspection, never the ledger

```
accounts_tier_is_nullable    NO
businesses_tier_is_nullable  NO      ← was YES. This is the contract 078 exists to add

accounts_check_def    CHECK (((subscription_tier)::text = ANY
                        ((ARRAY['copilot'::character varying,
                                'autopilot'::character varying])::text[])))
businesses_check_def  CHECK (((subscription_tier)::text = ANY
                        ((ARRAY['copilot'::character varying,
                                'autopilot'::character varying])::text[])))

accounts_invalid_after    0     accounts_total_after    0
businesses_invalid_after  0     businesses_total_after  0
outbox_after              0
```

| §7 requirement | Reading | Verdict |
|---|---|---|
| `accounts.subscription_tier` NOT NULL | `NO` (not nullable) | PASS |
| `businesses.subscription_tier` NOT NULL | `NO` — changed from `YES` | PASS |
| `accounts_subscription_tier_check` present | present, strict two-tier domain | PASS |
| `businesses_subscription_tier_check` present | present, strict two-tier domain | PASS |
| NULL-safe counts still 0 | 0 and 0 | PASS |

**Both CHECK definitions are byte-identical to staging's**, compared in the same session
against the staging project. The two databases now render the same constraint text, which
is the check that catches a widened same-name constraint — the failure 078's
`conname`+`conrelid` scoping exists to repair.

`job_outbox` is **still 0** after the apply. 078 enqueues no follow-up work, as its entry
in `migrations-log.md` states. Row counts are unchanged: the migration constrains, it does
not write.

#### No insert path breaks under the new NOT NULL

Checked, because a NOT NULL added to a live schema is exactly where a working writer
starts failing:

```
accounts.subscription_tier    NOT NULL  DEFAULT 'copilot'::character varying
businesses.subscription_tier  NOT NULL  DEFAULT 'copilot'::character varying
```

Both carry a default, so an `INSERT` that omits the column still satisfies the constraint.
No code change is owed and no redeploy is needed — the strict worker already running
(`2e9a5dc4` → `bff4f256`) writes values inside the new domain.

> Noted in passing, unrelated to 078: `zernio_backfill_runs.subscription_tier` is NOT NULL
> with **no** default. Pre-existing, untouched by this migration.

#### D.10 — the doc change §7 requires, in the same change

`.claude/CLAUDE.md` → **Environments & branches**: the "Standing exception until the prod
WS8 cutover: migration 078 — and ONLY 078 — is absent in prod" sentence is **deleted**.
Replaced with the current truth — no standing exception, full lockstep — plus the apply
timestamp and the introspection that proves it. The shape guard
(`src/__tests__/claude-md-shape.test.ts`) passes, 44/44.

`migrations-log.md`'s 078 entry gains a `PROMOTED TO PRODUCTION` block with the preflight,
the post-apply introspection and the staging comparison. The head line is **unchanged at
116** — 078 is an existing migration being promoted, not a new one.

Three older entries in that log still say "the 078 standing exception is untouched"
(#1008, #926, #111 records). Those are **dated point-in-time receipts and are left alone**
— the file itself already warns that such a hash or state line "is a point-in-time
receipt, not a standing expectation". Rewriting history to match the present would destroy
the audit trail those entries exist to provide.

**"All autonomy flags are OFF in prod" is unchanged**, because no flag was flipped. §7's
instruction to revise it applies "as the ordered go-live flip proceeds", and that has not
started.

---

### D.9 — verify §8, migration 105. PASS.

Read-only. §8 is a verify step in production; 105 was applied 2026-08-14.

```sql
-- 1. the column exists and is nullable
column_name                  is_nullable  data_type
checkout_attempt_coupon_id   YES          text

-- 2. the rewritten constraint names the coupon column in its cleared branch
names_coupon_in_cleared_branch = true      (def_length 2541)
```

| §8 requirement | Reading | Verdict |
|---|---|---|
| `checkout_attempt_coupon_id` nullable = YES | `YES` | PASS |
| `accounts_checkout_attempt_complete_check` names it in the cleared branch | `checkout_attempt_coupon_id IS NULL` present | PASS |

The 2,541-character constraint enumerates all nineteen `checkout_attempt_*` columns, which
is the shape 105 rewrites onto 077's original. This was already visible in the D.2 read;
D.9 records it against §8's own two queries as the section requires.

**§8 is satisfied.** The cutover is verified through §8.

---

### D.8 — THE FREEZE IS LIFTED. Production resumed 2026-08-31T07:20:21Z.

The production API had been denied since **2026-07-17T01:56:31Z**. It was fenced off for
**45 days**.

```
2026-08-31T07:20:21Z  firewall config published to production
2026-08-31T07:20:22Z  GET https://repworth.net/api/health -> HTTP 200
                      {"status":"ok","service":"web",
                       "commit":"b7ea106173bd04819dd2565c808241b80d7b054c"}
```

**UTC RESUME TIME: 2026-08-31T07:20:21Z.**

The `commit` field is `b7ea1061` — the #1038 merge, so the live build is the current
`main`, not a stale artifact.

#### Two preconditions were cleared BEFORE the rule came down

Deliberate ordering. Anything that could break was fixed and verified while production was
still fenced, so a failure would have been invisible to the public.

**1. The `NEXT_PUBLIC_APP_URL` redeploy debt — settled, and verified rather than assumed.**
It is inlined at build time, so a corrected store value means nothing until a rebuild. The
handoff carried it as owed before D.8. It is already paid: the #1037/#1038 merges each
triggered a production build, the newest 8 minutes before the check. Verified against the
served HTML, not the env store:

| Check | Count |
|---|---|
| `rep-worth.vercel.app` (the wrong host) | **0** |
| `repworth.net` (correct) | present |

**2. `ZERNIO_RECENT_REVIEW_POLL_DISABLED` — deleted, without tripping the D.4 trap.**

This is where the D.4 finding paid for itself. Deleting a Railway variable fires a
`redeploy`, and a `redeploy` resolves no deploy configuration — it would have brought the
`next start` impostor back, silently, reporting Online, in the minutes before the firewall
opened.

Deleted with **`--skip-deploys`** so no redeploy fired at all, then a source deploy was
triggered explicitly:

```
railway variable --skip-deploys delete ZERNIO_RECENT_REVIEW_POLL_DISABLED …
  → {"deleted":true,"key":"ZERNIO_RECENT_REVIEW_POLL_DISABLED"}

railway deployment redeploy --from-source … --yes
  → deployment d6d3ca9b, reason=deploy
```

Boot of `d6d3ca9b`, 07:18:18Z:

```
$ tsx worker/index.ts
Worker listening {"deployment_lane":"production","lane_source":"RAILWAY_ENVIRONMENT_NAME",
                  "service_name":"repworth-worker","replica_region":"us-west2"}
ZernioRecentReviewPoller  Starting {"interval_ms":300000}
[boot] readiness cure complete — background loops staggered, workers resumed
```

**`ZernioRecentReviewPoller Starting` is the producer denial lifting.** Every prior
production boot logged `Skipped - ZERNIO_RECENT_REVIEW_POLL_DISABLED=true`. Ingest is live
on a 5-minute cadence.

The variable is **Railway-native, not in the Infisical vault** (checked: absent from all 57
keys), so no Secret Sync can write it back.

Zero error, fatal or `NOAUTH` lines across that deployment.

#### The removal itself, staged then published

The rule's exact configuration, recorded before removal so it can be recreated verbatim if
a rollback ever needs it:

```
Rule:       ws8-cutover-prod-api-deny
ID:         rule_ws8_cutover_prod_api_deny_gogW1I
Status:     Enabled
Conditions: environment equals production
            path starts with /api/
Action:     Deny
```

Vercel's firewall stages changes as a draft. The draft was **inspected before publishing**,
and contained exactly one change:

```
Pending changes (1):
  - Removed rule "rule_ws8_cutover_prod_api_deny_gogW1I"
```

One change, not five. That check is what guarantees the other rules were not swept up.

#### The other five rules are untouched, as §7 requires

Live configuration after publishing:

| # | Name | Action | Status |
|---|---|---|---|
| 1 | `signup-per-ip-enforce` | Rate Limit (5/60s) | Enabled |
| 2 | `onboarding-start-per-ip-enforce` | Rate Limit (10/60s) | Enabled |
| 3 | `api-mutating-volumetric-log` | Rate Limit (100/10s) | Enabled |
| 4 | `api-get-volumetric-log` | Rate Limit (600/10s) | Enabled |
| 5 | `qr-redirect-per-ip-enforce` | Rate Limit (30/60s) | Enabled |

Six rules before, five after. Only the Deny is gone. `firewall diff` reports
**"No pending changes"** — nothing left staged.

#### Post-lift verification

| Surface | Result |
|---|---|
| `https://repworth.net/` | **200** |
| `https://repworth.net/api/health` | **200** — `{"service":"web","commit":"b7ea1061…"}` |
| `https://repworth.net/pricing` | **200** |
| `https://worker.repworth.net/ready` | **200** — `postgres ok, queue_redis ok, cache_redis ok` |
| Worker error/fatal/`NOAUTH` lines | **0** |

Both halves of the stack are live and answering: Vercel serves `"service":"web"`, Railway
serves `"service":"worker"`. The `/ready` probe confirms Postgres and **both** Redis
instances reachable from outside.

#### §7 checklist — complete

| §7 item | State |
|---|---|
| Both NULL-safe preflight counts = 0 | ✅ D.7 |
| 078 applied via the approved channel | ✅ 07:09Z |
| Post-apply introspection | ✅ byte-identical to staging |
| `ws8-cutover-prod-api-deny` removed and published | ✅ **07:20:21Z** |
| `curl https://repworth.net/api/health` → 200 | ✅ **07:20:22Z** |
| `ZERNIO_RECENT_REVIEW_POLL_DISABLED` restored to unset | ✅ deleted; poller running |
| **UTC resume time** | ✅ **2026-08-31T07:20:21Z** |
| `.claude/CLAUDE.md` standing exception deleted | ✅ D.10 |

`SELF_SERVE_SIGNUP_ENABLED` is **deliberately left at `false`**. §7 says restore it to its
"recorded pre-cutover state", and locked decision 7 sets the beta posture to signup-off.
Restoring it to `true` would contradict the beta gate; it is not a pre-cutover value being
withheld.

#### What is now live, and what is still closed

| | State |
|---|---|
| Production API | **OPEN** |
| Production UI | **OPEN** |
| Worker + queue + pollers | **RUNNING** |
| Zernio review ingest | **RUNNING** (5-min cadence) |
| Stripe live webhook | **ENABLED** — armed, never yet delivered to |
| Rate limiting + QR rule | **ENABLED** — unchanged |
| `AUTO_APPROVAL_ENABLED` | `false` |
| `AUTOPILOT_PURCHASABLE` | `false` |
| `SELF_SERVE_SIGNUP_ENABLED` | `false` |
| `TRIAL_ENABLED` | `false` |

**Phase D is complete.** The autonomy flags stay off; the ordered go-live flip is design
doc §8.4 and has not started.

#### Still owed, and not blocking

**`PAST_REPLIES_VIEW_ENABLED` deletion is NOT done, and a half-deletion was refused.**
Manifest §7.10 says delete it from Vercel. It is read by no code — every grep hit in
`src/`/`worker/` is a comment recording its retirement at #678. **But it is in the
Infisical vault** (present among the 57 `prod` keys), so deleting it from Vercel alone
returns on the next Secret Sync. The Infisical CLI cannot delete a secret at v0.43.128
(trap 4), so the vault entry needs the **web UI** — an owner action. Doing the Vercel half
now would look done and silently revert. Order when it is done: **vault first, then
Vercel.**

---

### §7 — migration 078, then resume

- [x] Both NULL-safe preflight counts = 0. Recorded: `accounts_invalid_count=0`,
      `businesses_invalid_count=0` — with `accounts`/`businesses`/`job_outbox` all 0 rows,
      and the documented absence signature intact. See **D.7**.
- [x] 078 applied via the approved channel at **2026-08-31T07:09Z** —
      `apply_migration`, the repo file verbatim. Staging re-introspected first and
      already held both NOT NULLs and both CHECKs, so this closed a prod-only gap.
- [x] Post-apply introspection: `businesses.subscription_tier` **NOT NULL** (was nullable),
      `accounts_subscription_tier_check` and `businesses_subscription_tier_check` both
      present, both rendering the strict two-tier domain **byte-identical to staging**.
      Invalid counts still 0; `job_outbox` still 0. See **D.7**.
- [x] `ws8-cutover-prod-api-deny` (`rule_ws8_cutover_prod_api_deny_gogW1I`) removed and
      published at **2026-08-31T07:20:21Z**. Draft inspected first — exactly ONE pending
      change. The four rate-limit rules and the QR rule survive, `firewall diff` clean.
- [x] `curl https://repworth.net/api/health` → **200** at **2026-08-31T07:20:22Z** —
      `{"status":"ok","service":"web","commit":"b7ea106173bd04819dd2565c808241b80d7b054c"}`.
      `/` and `/pricing` also 200; worker `/ready` 200 with all three probes ok.
- [x] `ZERNIO_RECENT_REVIEW_POLL_DISABLED` restored to unset — deleted with
      `--skip-deploys` so no config-blind `redeploy` fired, then a source deploy
      (`d6d3ca9b`). `ZernioRecentReviewPoller Starting {"interval_ms":300000}` replaces
      the old `Skipped` line. Railway-native, absent from the vault, so no sync restores it.
- [x] **UTC resume time: `2026-08-31T07:20:21Z`** — after 45 days frozen
      (denied since 2026-07-17T01:56:31Z).
- [x] `.claude/CLAUDE.md` standing 078 exception deleted, in the same change — replaced
      with the full-lockstep statement plus the apply timestamp and its introspection.
      `claude-md-shape.test.ts` passes 44/44. `migrations-log.md` 078 entry gains a
      PROMOTED block; head unchanged at 116.

### §8 — verify 105

- [x] `checkout_attempt_coupon_id` nullable = **YES**, `data_type` `text`. See **D.9**.
- [x] `accounts_checkout_attempt_complete_check` names the coupon column in its cleared
      branch — `checkout_attempt_coupon_id IS NULL` present in the 2,541-char definition.
      **§8 is satisfied.** See **D.9**.

---

---

## Phase E — the remaining live webhooks. COMPLETE 2026-08-31.

Both endpoints were created **through the provider APIs**, not the dashboards. Neither
provider needed a browser. Both are proven by a real delivery that reached the production
worker, was signature-verified, and wrote an `inbound_events` row.

**These are the first two rows ever written to production `inbound_events`.** The database
was zero-state at 07:20:21Z (D1a).

### E.0 — preconditions, read-only

| Check | Result |
|---|---|
| `POST /ingress/resend` unsigned | **401** `{"error":"invalid_signature"}` |
| `POST /ingress/zernio` unsigned | **401** `{"error":"invalid_signature_format"}` |
| `POST /ingress/stripe` unsigned | **401** `{"error":"missing_signature"}` |
| Worker `GET /ready` | **200**, `postgres`/`queue_redis`/`cache_redis` all `ok` |
| `RESEND_WEBHOOK_SECRET` in prod | **ABSENT** — E.1 adds it, it does not replace one |
| `ZERNIO_WEBHOOK_SECRET` in prod | present, 64-hex — matches `verifyZernioSignature` |

Signature-first (working rule) holds on all three routes.

### E.1 — Resend. Created via the API. PASS.

`GET https://api.resend.com/webhooks` returns 200 — **Resend exposes webhook CRUD over the
API.** `POST` with an empty body returns 422 `Missing 'endpoint' field`, so create is
supported and validates.

```
POST https://api.resend.com/webhooks
  {"endpoint":"https://worker.repworth.net/ingress/resend",
   "events":["email.delivered","email.bounced","email.complained","email.opened"]}
→ 201  {id, object, signing_secret}
```

- Endpoint id **`3de61a3d-b4d5-416c-a0db-5d581d730a02`**, status `enabled`.
- The response carries **`signing_secret`** — a provider-issued Svix value, `whsec_`
  prefix, 38 characters. **Shown once.** Never generated locally, never printed.
- Written to Infisical `prod` as `RESEND_WEBHOOK_SECRET` with the CLI's `@file` form, from
  a mode-600 scratch file. No secret ever appeared as a shell argument.
- The Secret Sync carried it to Railway within seconds. Verified by **SHA-256 fingerprint
  comparison**, not by reading the value: create-response `799db5754a6e` == Railway
  `799db5754a6e`, `len=38`, `whsec_` prefix true.

### E.2 — Zernio. Created via the API. PASS.

The plan assumed a dashboard. **Zernio exposes webhook management over its API** —
discovered from `https://zernio.com/openapi.json`, which the 404 body advertises:
`/v1/webhooks/settings` (GET list, POST create), `/v1/webhooks/test`, `/v1/webhooks/logs`.

```
POST https://zernio.com/api/v1/webhooks/settings
  {"name":"RepWorth Production",
   "url":"https://worker.repworth.net/ingress/zernio",
   "secret":"<$ZERNIO_WEBHOOK_SECRET, injected by railway run>",
   "isActive":true,
   "events":["account.connected","account.disconnected","review.new","review.updated"]}
→ 200
```

- Subscription id **`6a95315320358f33c89599e5`**, `isActive=true`, `failureCount=0`.
- `secret` is a **caller-supplied** field, so the vault value was used verbatim. Read back
  as `secret_len=64`, matching the 64-hex vault entry. Nothing new was minted.
- Zernio signs with HMAC-SHA256 in `X-Zernio-Signature`, which is exactly what
  `verifyZernioSignature` recomputes.

### E.3 — delivery verified, both providers

**Zernio.** `POST /v1/webhooks/test {"webhookId":"6a9531…"}` → 200.

```
[ingress/zernio] webhook.test received (event=1d291c1f-38d6-46c5-9930-c111c3c7c0b7)
```

No `invalid_signature` line. Provider-side delivery log:
`webhook.test  200  https://worker.repworth.net/ingress/zernio  2026-08-31T07:46:48Z`.

**Resend.** Fired with Resend's simulator address `delivered@resend.dev`, which produces a
real `email.delivered` event and reaches no human. Message id
`91f5ab8d-b703-407c-8072-d54d20e16865`.

**Both landed in production Postgres:**

| source | event_type | status | received_at |
|---|---|---|---|
| `resend` | `email.delivered` | **processed** | 2026-08-31 07:47:08Z |
| `zernio` | `webhook.test` | **processed** | 2026-08-31 07:46:48Z |

Staging endpoints were not touched. Both still point at
`repworth-worker-staging.up.railway.app`.

### Trap 1 fired again, and the `/ready` guard held

The Infisical write to `RESEND_WEBHOOK_SECRET` triggered Railway deployment `c6b76974`
with `reason: redeploy` — the config-blind kind. It was superseded by
`railway deployment redeploy --from-source`, which produced `0f5060fe`, `reason: deploy`,
**SUCCESS**.

Boot log of `0f5060fe`, confirming the process and a poller cycle per the standing rule:

```
$ tsx worker/index.ts
[worker] Feature flags: Telegram=off, WhatsApp=off, SelfServeSignup=off, ZernioPublishing=on
[INFO] Worker listening  deployment_id="0f5060fe-0e9b-4f59-8382-8c362b20a6e1"
[INFO] Starting  logger="OutboxPoller"  interval_ms=5000
[INFO] Starting  logger="ZernioRecentReviewPoller"  interval_ms=300000
[INFO] Release cycle complete  logger="SolicitationReleasePoller"  released=0
[boot] readiness cure complete — background loops staggered, workers resumed
```

---

## Findings from Phase E

### E-F1 — INCIDENT: the Infisical CLI prints secret values by DEFAULT. Rotation is owed.

**`infisical secrets --projectId … --env prod` printed plaintext values into the session
transcript.** The CLI's own help for `--show-values` reads *"reveal secret values in the
output table **instead of masking them**"*, which states that masking is the default. It
is not. The table is unmasked with no flag at all.

Three production secrets were exposed to the transcript:

| Key | Exposure | Blast radius on 2026-08-31 |
|---|---|---|
| `RESEND_API_KEY` | full value | Can send mail as `notifications@repworth.net` and read/alter webhook config |
| `ZERNIO_API_KEY` | full value | Can read profiles and POST replies for any connected Google account |
| `ZERNIO_WEBHOOK_SECRET` | full value | Can forge `review.*` / `account.*` events into production ingress |

`RESEND_FROM_EMAIL` was also printed. It is not a secret.

**Actual blast radius today is near zero** — the production database is zero-state, no
Google Business Profile is connected, and a forged `review.new` fans out to zero rows. The
window closes the moment beta tester one connects a location.

**Rotation of all three is owed before the first connected location.** Runbooks:
`secrets-rotation-api-keys.md`, `secrets-rotation-zernio.md`,
`secrets-rotation-email-and-messaging.md`. Rotating `ZERNIO_WEBHOOK_SECRET` also requires
a `PUT` of subscription `6a95315320358f33c89599e5`'s `secret` field, in the same change —
the vault value and the Zernio subscription must move together.

> **Standing rule.** Never run `infisical secrets` without redirecting stdout away from the
> transcript. To check presence or identity, use a SHA-256 fingerprint under
> `railway run`, as E.1 did.

### E-F2 — the production Zernio API key is PROVEN. Phase A.6's UNPROVEN is cleared.

Phase A.6 recorded the key as unproven, reasoning that every GET route in the client
validates request shape before authenticating, so no read-only call discriminates a good
key from a bad one. **That is true of the client, not of the API.** A raw request bypasses
the client's shape validation and discriminates cleanly:

```
GET https://zernio.com/api/v1/profiles              → 200  {"profiles":[{"name":"repworth-prod-019e4e19-…"}]}
GET https://zernio.com/api/v1/profiles  (bad key)   → 401  {"error":"Unauthorized"}
```

The 200 also names the production profile, so the key is bound to the right tenant. The
webhook test fire (E.3) then proved write authority on the same key.

### E-F3 — webhook subscriptions are per-USER at both providers, not per-environment

Production and staging hold **different** API keys at both providers — verified by
fingerprint, all four distinct. But both keys resolve to the **same account**, and
subscriptions are account-scoped. `GET /v1/webhooks/settings` returns the identical list
under either Zernio key; `GET /webhooks` returns the identical list under either Resend key.

**Consequence: every event now fans out to both workers.** A production `review.new`
reaches the staging worker as well, and a staging one reaches production.

This is **benign by construction, not by luck**. `processReviewEvent` fans out from
`zernio_connections` filtered on the firing Zernio account id, so a foreign event matches
zero rows and produces a 0-row fan-out. The two workers hold separate databases, so
`claimInboundEvent` dedup never crosses. The cost is a noise row in each `inbound_events`
table and an unconnected warn in the log.

There is no per-profile webhook scoping in the Zernio API. Accept the fan-out; do not try
to fix it by re-pointing an endpoint.

### E-F4 — a stale ngrok endpoint is subscribed to every Resend event, production included

```
23123295-ef9a-49ca-9463-f3b1ef5fb71c  enabled
https://unmoderated-stormy-sweer.ngrok-free.dev/ingress/resend
17 events — every event Resend emits
```

This is a local-dev tunnel left enabled on the shared Resend account. It now receives
production email events, including recipient addresses. A free ngrok subdomain is
reassignable, so the destination is not durably owned.

**Not deleted — that is an owner decision, and it may be an active dev tunnel.**
Recommendation: delete it, or disable it until it is needed.

### E-F5 — two corrections owed to `deployment-guide.md` §6

1. **§6.1 says "Click Send test".** Newer Resend has no per-endpoint test control. Use the
   simulator address `delivered@resend.dev` (also `bounced@resend.dev`,
   `complained@resend.dev`), which fires the real event and reaches no human.
2. **§6.2 lists `webhook.test` as a subscribed event.** It is not subscribable — the
   create enum has no such member. It is fired by `POST /v1/webhooks/test`, which takes a
   `webhookId`. The correct subscription set is the four events used above.

Both corrections are applied in the same change as this record.

---

## Phase F.2 / F.2b — the Beta comp coupon. CREATED 2026-08-31.

Owner decisions taken at the start of this segment, recorded verbatim:

1. **Rotation of the three E-F1 secrets — deferred** to after the F.3 staging smoke and
   before any production Checkout. One rotation then covers everything.
2. **The stale ngrok Resend endpoint — delete.**
3. **Creating the live-mode coupon — approved.**

### F.2a — the ngrok endpoint is gone

```
DELETE https://api.resend.com/webhooks/23123295-ef9a-49ca-9463-f3b1ef5fb71c → 200 {"deleted":true}
```

Two Resend endpoints remain, and they are the two that should exist:

| id | status | endpoint |
|---|---|---|
| `3de61a3d-…` | enabled | `https://worker.repworth.net/ingress/resend` |
| `0e671d1f-…` | enabled | `https://repworth-worker-staging.up.railway.app/ingress/resend` |

### F.2b — the deprecation check PASSES

Every call in this segment pinned `Stripe-Version: 2026-05-27.dahlia`, taken from
`STRIPE_CLIENT_CONFIG.apiVersion`. A read-back under any other version would not have
tested the thing the 2026-08-10 review flagged.

| Field | Test mode | Live mode |
|---|---|---|
| `id` | `repworth-beta-comp-3mo` | `repworth-beta-comp-3mo` |
| `percent_off` | 100.0 | 100.0 |
| `duration` | **`repeating`** | **`repeating`** |
| `duration_in_months` | **3** | **3** |
| `valid` | true | true |
| `livemode` | false | **true** |
| `times_redeemed` | 0 | 0 |

**`duration: repeating` is intact on the pinned apiVersion.** The fallback recorded in the
plan — three cycle-scoped 100% promotions — is not needed. The F.2 box in
`beta-production-standup.md` no longer carries an open fallback field.

### F.2c — an error I made, and the check that caught it

I created the live coupon as **`beta_comp_3mo`** first. That id was wrong.

Vercel `staging` has held `BETA_COMP_COUPON_ID="repworth-beta-comp-3mo"` since
2026-08-21. Reading the configured value **before** declaring F.2 done is what surfaced
the mismatch. A live coupon under an id no environment names is not a coupon; it is a
`CheckoutCouponConfigurationError` waiting for the first invited tester.

Correction, in one pass:

1. Created live `repworth-beta-comp-3mo` and read it back under the pinned version.
2. Re-read `beta_comp_3mo`'s `times_redeemed` — **0** — and only then deleted it. The
   script refuses the delete on any non-zero count.
3. Listed live coupons: exactly one, `repworth-beta-comp-3mo`.

**Test mode still holds a second, legacy coupon `beta_comp_3mo`** (100%/repeating/3,
`times_redeemed=3`, created 2026-08-13). Nothing points at it — the three redemptions
predate the current env var. It is left in place: deleting a Stripe coupon strips the
discount from subscriptions already carrying it, and those three staging subscriptions are
not worth disturbing. **Live mode has no such twin, deliberately.**

> **Lesson.** "Create the coupon" is not the first step of F.2. **Reading the id the
> environment already names is.** The plan said "the two IDs differ", which invited a fresh
> id; the deployment had in fact already chosen one, ten days earlier, in a place the plan
> did not point at.

### F.2d — the environment variable. Staging done, production HELD.

`BETA_COMP_COUPON_ID` exists in exactly **one** place across the whole estate:

| Where | State |
|---|---|
| Vercel `staging` | **set** to `repworth-beta-comp-3mo`, 2026-08-21 — already correct, unchanged by this run |
| Vercel `Production` | **absent** — the F.4 gate, deliberately |
| Infisical vault `prod` | **absent** — so no Secret Sync can push it to Vercel Production by accident |
| Railway (either env) | absent, by design — no worker path reaches `applyTierSnapshot` |

That third row matters more than it looks. The F.4 gate is not held by someone remembering
not to set it; it is held because the value does not exist in the vault that writes to
Vercel Production. **Setting it in the vault would un-gate F.4 silently.** When F.4 comes,
set it on Vercel Production directly, or add it to the vault knowing that is the flip.

### F.2e — the BLOCKING `onboarded_by` gate, re-run at the moment the live coupon existed

`launch-checklist.md` forbids creating the live coupon while a legacy admin-onboarded
account sits in `pending_payment`, because such an account would draw a 3-month comp it
was never meant to have. The gate was cleared 2026-08-30 and declared satisfied *by
construction*. It was re-run verbatim anyway, against prod `udeyaqnvpojbwgoaxwdg`, in the
same minutes the live coupon came into existence:

```
0 rows
```

### What F.2 did NOT do

- No Vercel Production variable. No production redeploy.
- No Checkout was created, in either mode. `times_redeemed` is 0 on both live and the
  configured test coupon.
- The Stripe **live** webhook endpoint is still armed and still has never been delivered to.

---

## Phase F.3 — the ten-step staging smoke. NOT STARTED. Operator work.

F.3 needs a human at a browser: admin sign-in at AAL2, an invite email, a Stripe test card,
and eyes on the Stripe dashboard. Three of the ten steps carry the weight — step 6 (a card
**is** collected), step 8 (the **4th** cycle renders at full price), step 10 (record the
real Supabase error code for an already-accepted invite).

Two things to set before it runs:

1. Decide `ONBOARDING_DEMO_ENABLED` on staging. It is off by default, and step 4's expected
   landing page differs between the two postures. Record which posture was tested.
2. Prepare **two** owner email addresses. Step 10 needs a second owner who has not signed in.


---

## Phase G.4 — provider moderation. FLIPPED and VALIDATED in production, 2026-08-31.

Owner approved the production flip. All three runbook checks pass against the live
provider with real production credentials.

### G.4a — the flip

`OPENAI_MODERATION_ENABLED` lives in the **Infisical vault `prod`** (it was `false` there),
so the vault was the write point — it syncs to Railway **and** Vercel, keeping one source of
truth. Value set to exactly `true`.

Preconditions verified first, per the `flag-flip` workflow:

| Precondition | State |
|---|---|
| `OPENAI_API_KEY` in prod worker | present |
| `AUTO_APPROVAL_ENABLED` | `false` |
| `AUTO_APPROVAL_PROVIDER_MODERATION_READY` | absent → off, and **deliberately left that way** |
| Direction of change | **stricter**, never looser — the provider layer only adds a veto (invariant #4) |
| Ordering | not an autonomy flag; no §8.4 ordering constraint |

Confirmed live: `railway run … printenv OPENAI_MODERATION_ENABLED` → `true`, and the
running deployment booted **after** the variable landed.

### G.4b — the three checks, run against the live provider

`moderateResponse(text)` is pure — a string in, a `ModerationDecision` out, no DB writes and
no outbox rows — so it can be exercised directly without inventing a review.

| Check | Expected | Observed | Verdict |
|---|---|---|---|
| **1. Clean** | `providerStatus="clean"`, not flagged | `flagged:false`, `severity:"low"`, `providerStatus:"clean"`, `openai_moderation:"clean"` | **PASS** |
| **2. Provider-flagged** | `flagged=true`, no clean status, `openai_categories` present | `flagged:true`, `severity:"high"`, `reason:"openai_moderation"`, `providerStatus:null`, `openai_categories` with `harassment/threatening` and `violence` true | **PASS** |
| **3. Provider error** | falls back to local, `providerStatus="error"`, does not throw | `flagged:false`, `severity:"low"`, `providerStatus:"error"`, `openai_moderation:"error"`, process did not throw | **PASS** |

`AUTO_APPROVAL_PROVIDER_MODERATION_READY` is **not** set. The runbook would permit it now,
but the stand-up says it stays `false` as the later auto-approval-gate marker. The stand-up
governs. That tension is finding **G-F2** below.

---

## Phase G.2 — Sentry monitoring. BLOCKED on a Sentry billing seat. Root cause proven.

### The symptom

The production Sentry cron monitor `health-alert-poller` had **zero check-ins in 24 hours**,
while the production worker demonstrably ran with a 5-minute poller and a correct DSN.

That monitor is the **dead-man heartbeat**. Its entire job is to page when the poller stops.
With no check-ins it pages never. **Production has had no such alarm at any point.**

### Ruling out our side first

| Candidate cause | Checked | Result |
|---|---|---|
| Worker not sending | Sentry banner shows `10x  Monitor disabled` | **Sending.** Sentry rejects at ingest |
| Wrong DSN / wrong project | `SENTRY_DSN` project id differs between prod and staging; `SENTRY_PROJECT=repworth-production` | **Correct** |
| Code missing the check-in | `worker/background/pollers/health-alert/emit.ts` sends an **upserting** `captureCheckIn` with `crontab */5 * * * *` | **Present** |

### The root cause

Activating a monitor through the API returns:

```
HTTP 400  {"status":["You don't have enough pay-as-you-go available to create a new seat"]}
```

And `Settings → Subscription` shows: **Developer plan**, and **"No payment method on file"**.

**The chain:** free plan → a small fixed number of monitor seats → the two **staging**
monitors hold them → the production monitor cannot take a seat → Sentry keeps it `disabled`
→ every check-in is rejected with `Monitor disabled` → no alarm.

This is one root cause for **both** halves of G.2. Two uptime monitors were created for
production and both came back `disabled` for the same reason:

| Monitor | Target | Interval | State |
|---|---|---|---|
| `Prod worker /ready` (8341697) | `https://worker.repworth.net/ready` | 300 s | **disabled — no seat** |
| `Prod app /api/health` (8341701) | `https://repworth.net/api/health` | 300 s | **disabled — no seat** |

> 300 s, not 60 s, for the worker deliberately: `/ready` runs three **live** probes
> (`postgres`, `queue_redis`, `cache_redis`). A 60-second cadence would fire 1,440 sets of
> live probes a day at production Postgres and both Redis instances, purely to answer a
> health check.

### Two ways out. Neither is a button on the monitor page.

1. **Free — swap staging for production.** Disable the staging cron monitor and the staging
   uptime monitor to release their seats, then enable the three production ones. Production
   gains coverage; staging loses it. The staging monitors are already noisy — both show a
   failure "last seen 2mo ago".
2. **Paid — add a payment method** and a pay-as-you-go budget in
   `Settings → Subscription`, then enable all of them and keep staging.

**Where to click:** left nav → **Monitors**, or `https://repworth-nv.sentry.io/monitors/`.
The `…/crons/<project>/<slug>/` path this record previously cited is the OLD path and 404s.

### RESOLVED, same day — the owner upgraded to a Teams plan (20 monitors)

The seat constraint is gone. All three production monitors are now **active**:

| Monitor | Type | State | Evidence |
|---|---|---|---|
| `health-alert-poller` | cron | **active** | environment `production` = `ok`, last check-in **2026-08-31T18:00:53Z** |
| `Prod worker /ready` (8341697) | uptime | **active** | 300 s |
| `Prod app /api/health` (8341701) | uptime | **active** | 300 s |

**The cron monitor healed itself.** Nothing re-created it and nothing re-enabled it by hand.
The SDK sends an **upserting** `captureCheckIn`, so the first check-in after a seat became
available was accepted, and Sentry flipped the monitor from `disabled` to `active` on its
own. That is worth knowing: once the seat exists, a monitor that has been rejecting
check-ins repairs on its next scheduled beat — there is no manual step.

**The production dead-man heartbeat is live.** If `HealthAlertPoller` stops, Sentry now
notices a missed check-in.

> The two uptime monitors were activated through the API, which is why the earlier seat
> error is a useful signature: `update_uptime_monitor` returns HTTP 400
> `"You don't have enough pay-as-you-go available to create a new seat"` while a seat is
> short, and simply succeeds once one is free. It is a clean way to test the constraint
> without touching the plan.

### G.2 residual — routing, not monitoring

Monitoring now works. **Routing does not.** See G.1 below: the production project's only
alert rule sends Email, and none of the four required signals is routed anywhere.

---

## Phase G.1 — Discord routing. DONE 2026-08-31.

All four §G1 signals now reach the owner's prod-only Discord channel. Two changes, both
made through the Sentry UI because the MCP exposes only `find`/`get` for alert rules.

### The two rules

**1. Existing rule `3920752` — "Send a notification for high priority issues".** A Discord
action was added beside its Email action. Its only action was Email, and it had never
triggered.

**2. New rule `3925256` — "Prod — four ops signals to Discord".** Verified by API readback:

```
Action Filters — logic: any-short
  Tagged event (key: subsystem,   match: eq, value: health_alert)
  Tagged event (key: cost_event,  match: eq, value: limit_exceeded)
  Tagged event (key: feature,     match: eq, value: stripe_reconciliation)
  Tagged event (key: subsystem,   match: eq, value: import_consent_analytics)
Actions
  Discord (integration id: 443670, target: 1544045194264051842, tags: repworth-prod)
```

**One rule with `any` logic rather than four rules.** Four separate rules would allow
per-signal muting, which is a real benefit, but the marginal value did not justify four
times the hand-built UI surface — every extra rule is another chance to mis-key a tag in a
production alert path. The named tradeoff is that
`subsystem:import_consent_analytics` is described in the stand-up as
**frequency-conditioned** and this rule throttles at *notify on every trigger*, the same as
the other three. **If that signal proves noisy, split it into its own rule with its own
Action Throttle** rather than throttling all four.

### Two things worth knowing about the mechanism

**There is no "link a channel to Sentry" step.** The *server* is linked once at org level; a
*channel* is named per action as a **channel ID or URL** — never a name, which Sentry warns
about inline. A new channel therefore needs no Sentry-side setup of its own.

**Sentry had no `subsystem` / `cost_event` / `feature` tag keys to suggest**, so each was
entered through the dropdown's `Create "<key>"` option. That is expected, not a warning:
production has emitted no event carrying those tags yet. The rule matches correctly when
the first one arrives.

### Verified end to end

The owner confirmed a **Send Test Notification** arrived in the Discord channel. That
proves the channel id, the integration, and the bot's channel permissions together — the
one prerequisite that would otherwise fail silently is a private channel the Sentry bot
cannot see.

### Residual, deliberately accepted

Both rules keep Sentry's default trigger set, which includes **"An issue is resolved"**. A
Discord message will therefore post when someone resolves one of these issues. That is mild
noise, not a defect; remove the trigger from either rule if it grates.

---

## Phase G.1 — original scoping (kept for the reasoning)

The Discord **integration** exists and works — the owner installed it during the staging
build. Proven from the staging alert rule's action:

```
Discord (integration id: 443670, target type: specific,
         target: 1517968864724385822, tags: repworth-staging, status: active)
```

That rule last fired 2026-08-31T01:00:46Z, so the path is live.

**What is missing is every production rule.** `repworth-production` has exactly one alert
rule — `Send a notification for high priority issues` (3920752) — and its only action is
**Email** to issue owners. It has never triggered. None of the four §G1 signals
(`subsystem:health_alert`, `cost_event:limit_exceeded`,
`subsystem:import_consent_analytics`, `feature:stripe_reconciliation`) is routed anywhere,
in either project.

### There is no "link a channel to Sentry" step — that was the wrong mental model

The **server** is linked once, at the org level. A **channel** is not linked at all; it is
named per alert action. Sentry's action row reads:

> Send a **Discord** message to **[RepWorth]** server, to **[channel ID or URL]**
> Optional: in the message show tags **[e.g., environment,my_tag]**

with an inline warning: *"Note that you must enter a Discord channel **ID**, not a channel
name."* A channel **URL** is also accepted, and its trailing number is the id.

So a new prod-only Discord channel needs no Sentry-side setup of its own. Its id goes into
each action, and the **Send Test Notification** button on the rule editor verifies it.

**The one real prerequisite:** the Sentry bot must be able to see the channel. A private
channel denies it by default — add the Sentry bot or its role with *View Channel* and
*Send Messages*, or the save fails with a channel-not-found error.

### Why this is UI work

The Sentry MCP exposes `find_alert_rules` and `get_alert_rule` only. There is **no**
create-or-update tool for alert rules, so the four rules cannot be scripted from here.
Either drive the browser, or build them at
`https://repworth-nv.sentry.io/monitors/alerts/`.

---

## Findings from Phase G

### G-F1 — a `redeploy` DID resolve deploy configuration this time. Trap 1 needs a caveat, not a deletion.

D.4 established that a `redeploy` resolves no deploy configuration and falls back to
Railpack, booting `next start`. It was proven twice, including with `startCommand` set
explicitly on the service.

**Today it behaved differently.** The vault write for `OPENAI_MODERATION_ENABLED` fired
`58e58630`, `reason: redeploy`, and it reported SUCCESS **and booted the right process**:

```
$ tsx worker/index.ts
[INFO] Worker listening  deployment_id="58e58630-9463-456e-8ee6-5050a218feba"
[INFO] Starting  logger="OutboxPoller" … ZernioRecentReviewPoller … AnalyticsDispatchPoller
```

**The likely mechanism, and why it does not retire the trap.** A `redeploy` re-runs the
*previous* deployment. Three minutes earlier, the PR #1041 merge to `main` produced
`c5c7506b`, a `reason: deploy` source deployment that resolved configuration normally. The
redeploy inherited that resolved configuration. At D.4 the preceding deployment chain
started from a Railpack auto-detect, so the redeploy inherited *that* instead.

**So the rule becomes conditional, and a conditional safety rule is not one to rely on.**
A redeploy is safe only when the deployment it copies was itself config-resolved — which is
not something you can see at the moment you flip a variable. **Keep following trap 1:**
`redeploy --from-source` after any variable change. It is cheap, and it is correct under
both behaviours. What changes is the expected blast radius, not the procedure.

### G-F2 — the G4 runbook and the stand-up give opposite orderings

`beta-production-standup.md` §G4: *"Run the corpus validation … then flip
`OPENAI_MODERATION_ENABLED=true`."*

`auto-approval-provider-moderation-validation.md` → **Required Environment**: *"Set
`OPENAI_MODERATION_ENABLED=true` in the target environment being validated."*

**The runbook is right and the stand-up is wrong.** With the flag off, `moderateResponse`
returns the local decision before it ever calls the provider — so the "clean provider
result" check cannot be observed. The validation is impossible in the stand-up's order.
This run followed the runbook. The stand-up text is corrected in the same change.

### G-F3 — the OpenAI client is memoized, so the error-path check needs a FRESH process

The first attempt at check 3 set `process.env.OPENAI_API_KEY` to an invalid value and
called `moderateResponse` again in the same process. It returned `providerStatus:"clean"` —
the provider call **succeeded**. `client()` builds its OpenAI instance once and caches it,
so a later env change cannot reach it.

That result was recorded as **inconclusive, not as a pass.** Re-run in a fresh process with
the invalid key injected at start (`railway run … -- env OPENAI_API_KEY=… npx tsx …`), the
provider returned `invalid_api_key` and the decision correctly degraded to
`providerStatus:"error"` without throwing.

**Rule for any fail-open validation: inject the fault before the process starts.** A
memoized client makes an in-process fault injection silently test nothing, and a silent
no-op looks exactly like a pass.

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
- [x] **Reconciliation doc corrections 1–5 all landed.** 1–4 in #1025/#1027,
      verified absent from HEAD by grep. 5 on 2026-08-30 — the stand-up's Phase B
      blockquote now points at manifest §1 as owner and records all five errors.
      Two further contradictions in the same block were fixed with it:
      `NODE_ENV` is left unset and `MOCK_EXTERNAL_APIS` is not created.
- [x] **Prod worker Online, all 18 boot gates green on the production lane** — proven at
      runtime 2026-08-31, including the six never exercised before. Proven by poller
      cycles in the worker's own logs, not by the healthcheck (see D.4).
- [x] **078 applied in sequence 2026-08-31T07:09Z**; staging re-verified first; both CHECK
      definitions byte-identical to staging. The seven legacy `STRIPE_PRICE_*` names are
      still present on Railway — rollback window intact.
- [x] **Deny rule removed 07:20:21Z; `/api/health` returns 200 at 07:20:22Z; Zernio poll
      restored and cycling.** See D.8.
- [ ] Live webhooks delivering 2xx (Stripe, Resend, Zernio)
- [ ] Alert sink (Discord) receiving a canary for all four routed signals
- [ ] Flag snapshot appended to `launch-flag-readiness.md` — **Railway AND Vercel**
- [ ] 🔴 Hard blockers (PITR drill, legal review, insurance): each **completed**, or covered
      by a dated owner-approved policy decision recorded in `launch-checklist.md`.
      Never tick an incomplete box.
