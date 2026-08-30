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

---

## Owner decisions recorded at start (2026-08-30, in-session)

1. **Roles: solo run.** Observer and incident owner are the cutover owner. Recorded as an
   owner-approved deviation, matching the 2026-07-16 precedent. No box left blank.
2. **Stripe live activation: COMPLETE.** `charges_enabled` reported **true** by the owner
   on 2026-08-30, resolving the blocker recorded as `charges_enabled=false` at
   2026-07-17T00:0xZ. This unblocks §6 smoke Checkout and all of Phase F.
   → **Agent re-verification owed at §6** — see "Open items", item 1.
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
- `RESEND_FROM_EMAIL` must stay on `send.repworth.net`. The root SPF has no
  `amazonses.com` include, so a root-domain envelope would fail SPF outright.
- DMARC `rua` still points at a third-party reporting mailbox. The launch checklist already
  flags pointing it at a RepWorth-owned address; now that Zoho hosts the domain, that is a
  five-minute change. Still non-blocking, still not done.

---

## Zero-state proof (replaces WS8 §2–§3 quiesce/drain)

Production holds no tenant data. This is by deliberate purge on 2026-07-16 (36-table FK
closure, owner-executed, recorded in the predecessor file), not because production was
never used — the earlier "never launched" line in that file is itself corrected there.

Agent verification, 2026-08-30:

```sql
SELECT
  (SELECT count(*) FROM accounts)   AS accounts,     -- 0
  (SELECT count(*) FROM businesses) AS businesses,   -- 0
  (SELECT count(*) FROM users)      AS users,        -- 0
  (SELECT count(*) FROM reviews)    AS reviews,      -- 0
  (SELECT count(*) FROM responses)  AS responses,    -- 0
  (SELECT count(*) FROM job_outbox) AS outbox;       -- 0
```

Structural, not merely observed: the Railway `production` environment has **no Redis
service** and the worker has **zero deployments ever**, so no BullMQ producer or consumer
has run. There is nothing to drain.

**This also settles the launch-checklist's BLOCKING legacy `onboarded_by` audit.** That
gate asks how many pre-existing admin-onboarded accounts sit in `pending_payment` and would
draw the 3-month comp the moment the live coupon exists. With zero businesses, the answer
is zero. The gate is satisfied by construction — tick it citing this query, not by running
the checklist's query against a populated table.

---

## Carried-forward open items from the 2026-07-17 record

That record closed with four "post-merge launch tasks, recorded so they don't vanish."
Three reached `beta-production-standup.md`. One did not, and this is where it is recovered.

| # | Item | Reached a checklist? | State 2026-08-30 |
|---|---|---|---|
| 1 | **Stripe activation (`charges_enabled`)** | **NO — orphaned** | Owner reports **activated**. Appears in no checklist, no stand-up phase, and no launch doc — only in the predecessor evidence file. **Re-verify before §6 smoke** and record the reading here: `____` |
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

- [ ] Roles recorded (solo deviation), predecessor evidence linked, HEAD pinned
- [ ] Reconciliation doc corrections 1–4 landed via PR
- [ ] Prod worker Online, all boot gates green on the production lane
- [ ] 078 applied in sequence; legacy price sentinels retained through the rollback window
- [ ] Deny rule removed; `/api/health` returns 200; Zernio poll restored
- [ ] Live webhooks delivering 2xx (Stripe, Resend, Zernio)
- [ ] Alert sink (Discord) receiving a canary for all four routed signals
- [ ] Flag snapshot appended to `launch-flag-readiness.md` — **Railway AND Vercel**
- [ ] 🔴 Hard blockers (PITR drill, legal review, insurance): each **completed**, or covered
      by a dated owner-approved policy decision recorded in `launch-checklist.md`.
      Never tick an incomplete box.
