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
- [x] **Reconciliation doc corrections 1–5 all landed.** 1–4 in #1025/#1027,
      verified absent from HEAD by grep. 5 on 2026-08-30 — the stand-up's Phase B
      blockquote now points at manifest §1 as owner and records all five errors.
      Two further contradictions in the same block were fixed with it:
      `NODE_ENV` is left unset and `MOCK_EXTERNAL_APIS` is not created.
- [ ] Prod worker Online, all boot gates green on the production lane
- [ ] 078 applied in sequence; legacy price sentinels retained through the rollback window
- [ ] Deny rule removed; `/api/health` returns 200; Zernio poll restored
- [ ] Live webhooks delivering 2xx (Stripe, Resend, Zernio)
- [ ] Alert sink (Discord) receiving a canary for all four routed signals
- [ ] Flag snapshot appended to `launch-flag-readiness.md` — **Railway AND Vercel**
- [ ] 🔴 Hard blockers (PITR drill, legal review, insurance): each **completed**, or covered
      by a dated owner-approved policy decision recorded in `launch-checklist.md`.
      Never tick an incomplete box.
