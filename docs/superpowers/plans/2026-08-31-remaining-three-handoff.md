# Handoff — the last three items before beta tester one

> **Written:** 2026-08-31 · **Owner:** @norbertesekiel
> **Supersedes** `2026-08-31-phase-f3-handoff.md` (F.3 and F.4 are both done).
>
> **This is a pointer, not a source of truth.** Every fact it cites lives in exactly one
> owning file. **If this file and an owning file disagree, the owning file wins** — and fix
> this one in the same change.

---

## The one-line situation

**Production is live, commissioned, and has completed a real Checkout.** The freeze lifted
2026-08-31T07:20:21Z; the first live-mode Checkout completed at 20:32Z and the owner was
charged **$0.00**. **Three items remain**, in the owner's order:
**G.3 (finish) → the PITR drill → the secret rotation.** Then **Phase H**, which is the
actual finish line.

**Full visual record:** https://claude.ai/code/artifact/44a2ff8f-75d8-48cd-a508-547320b01a2c

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `docs/runbooks/evidence/2026-08-30-ws8-prod-cutover-resume.md` | **The state of record.** Phase A, D.1–D.10, E, F.2, F.3, F.4, G — and findings E-F1…E-F5, G-F1…G-F3, F3-F1…F3-F3, F4-F1…F4-F6 |
| 2 | `docs/runbooks/evidence/2026-08-31-g3-alerting-acceptance-drills-evidence.md` | **The open campaign.** Preflight, D-1, D-2, teardown ledger, and which 8 drills remain |
| 3 | `docs/runbooks/beta-production-standup.md` §§F–H | The protocol. **Phase H is the finish line and has not started** |
| 4 | `.claude/reference/lab-notes.md`, entries dated 2026-08-31 | Fourteen findings from this run |
| 5 | `docs/runbooks/pitr-restore-drill.md` | Item 2's own procedure |
| 6 | `docs/launch-checklist.md` | The three hard blockers |

---

## Where things stand

| Area | State |
|---|---|
| **Production API + worker** | ✅ Live. Worker runs `tsx worker/index.ts`, pollers cycling |
| **Migrations** | ✅ Full lockstep, head 116 |
| **Live Stripe webhook** | ✅ **Proven** — `invoice.paid`, `checkout.session.completed`, `customer.subscription.deleted`, all `processed` |
| **Resend + Zernio webhooks** | ✅ Proven in Phase E |
| **Beta comp coupon** | ✅ `repworth-beta-comp-3mo`, both modes, set on Vercel staging **and** Production |
| **Production admin** | ✅ `01a0596a-4cd3-7248-aa02-27fba8886d5a`, MFA factor `37ffc97e-…` verified |
| **Supabase Auth URL config** | ✅ Site URL `https://repworth.net`, redirect `https://repworth.net/**` |
| **Ops alerting** | ✅ **Pages on repeats** since 21:34Z. Both rules carry `Every event` + a 60-min throttle |
| **Sentry monitors** | ✅ Three active |
| **Autonomy flags in prod** | `AUTO_APPROVAL_ENABLED` `AUTOPILOT_PURCHASABLE` `SELF_SERVE_SIGNUP_ENABLED` `TRIAL_ENABLED` all **`false`** |
| **Three secrets** | ⚠️ **EXPOSED, rotation owed** (item 3) |
| **Hard blockers** | PITR drill, legal review, insurance — **all 3 open** |

**Production data:** 1 admin user, 1 **cancelled** Account/Business (the F.4 walk), 2 auth
users, 3 `inbound_events`. **Not zero-state** — and that is deliberate; see item 2.

---

## The traps. Read before touching anything.

All eleven live in the artifact and in the evidence record. **The four that will bite this
session:**

1. **`infisical secrets` prints secret VALUES by default.** Its own `--show-values` help is
   wrong. Never let it write to a recorded terminal. Fingerprint under `railway run` to check;
   `@file` form to write.
2. **A vault write is a DEPLOY on every synced platform.** One vault env `prod` syncs to
   Vercel **and** Railway. Writing a Vercel-only key still redeploys the worker — so every
   vault write lands inside trap 2 below.
3. **A Railway `redeploy` may resolve no deploy config.** Always follow with
   `railway deployment redeploy --from-source --service repworth-worker --environment production --project ad641d0e-dc01-4250-b71c-db1beedb9c8c --yes`,
   then confirm `tsx worker/index.ts` **and a poller cycle**. "Online" is not evidence.
4. **A blank or `[SENSITIVE]` `env pull` value means `Secret` type, not empty.** Read runtime
   (the worker boot log), not config.

---

## 1. G.3 — finish the acceptance drills. **STAGING ONLY.**

`beta-launch-alerting.md` §4. **2 of 10 pass.** Invoke the **`runbook` skill** before the
first fixture — the evidence file and teardown ledger already exist, so this is a *resume*,
not a fresh start. Read its ledger first.

**Run §4.5 and §4.6 first.** Both assert repeat-notification **counts**, so both were
un-passable before D-2 was fixed and now re-test that fix from a second angle.

| Drill | Note |
|---|---|
| **§4.5** send-breaker re-page | ≥3 poll intervals (~15 min). Asserts **more than the opening two** notifications. `solicitation_send_breaker` **never self-clears** — clear it through `/admin/solicitation`, not SQL |
| **§4.6** unattributed suppression | Four svix-signed `email.complained` POSTs in one hour. **Fewer than four must produce nothing.** Writes **one permanent** `solicitation_suppressions` row — no expiry, no ordinary delete path, by design. Use an obviously fictional recipient and **leave the row** |
| §4.4 cost-cap | `GLOBAL_DAILY_COST_LIMIT_CENTS=1` + trigger a draft. Flag flip = a ledger row |
| §4.9 / §4.10 | `scripts/burst-drill-load.ts`. 15 min and 30 min respectively |
| **§4.1 + §4.7 as ONE drill** | **D-1** — §4.1 is unrunnable alone. `checkOldestPendingOutbox` and the `OutboxPoller` claim share the identical predicate, but the dispatcher runs every 5 s against the alert's 300 s, so it eats the fixture. Stop the worker, insert the aged row, restart, confirm on the first clean cycle |
| §4.8 probe stopped | Cron-monitor path — unaffected by D-2 |

**Verification method that worked:** run the check predicate verbatim from
`worker/background/pollers/health-alert/checks.ts` against the DB *before* waiting, so a
non-firing poller is distinguishable from a non-matching fixture. Then read the worker log
for `Health alert findings`, then the rule's `lastTriggered` via the Sentry MCP, then ask the
owner to confirm Discord. **`lastTriggered` proves Sentry fired; only a human proves Discord
received.**

**Runbook fixes owed** (contract step 7, both need owner sign-off on the reordering):
D-1's merge of §4.1 into §4.7, and a stated §4 precondition that the alert rules carry the
`Every event` trigger.

## 2. The PITR restore drill

`docs/runbooks/pitr-restore-drill.md`. Results table still reads *pending first drill*.

> **Ordering, corrected — do not re-derive this.** "The window closes at the first signup"
> reads as *drill before F.4*. It should not. The drill is **non-destructive** (§3 restores to
> a **new** project), and zero-state makes it **weaker**: §4's pass criteria are row-count
> comparisons, `count(*) as auth_users` and `max(created_at)`, all of which pass **vacuously**
> against an empty database. F.4's one cancelled staff Account is the minimum data that makes
> §4 a real check.

Roughly an hour. **Creating a Supabase project costs money — confirm the spend with the owner
before starting.** Verify schema by checking for the actual object, never the migrations
ledger.

## 3. The secret rotation — deliberately last

| Key | What the value permits | Runbook |
|---|---|---|
| `RESEND_API_KEY` | Send mail as `notifications@repworth.net`; alter webhook config | `secrets-rotation-email-and-messaging.md` |
| `ZERNIO_API_KEY` | Read profiles; post replies for any connected Google account | `secrets-rotation-zernio.md` |
| `ZERNIO_WEBHOOK_SECRET` | Forge `review.*` / `account.*` events into production ingress | `secrets-rotation-zernio.md` |

**Blast radius is near zero today** — no connected Google Business Profile, so a forged
`review.new` fans out to zero rows. **It stops being zero at the first connected location.**

> **Rotating `ZERNIO_WEBHOOK_SECRET` must `PUT` subscription `6a95315320358f33c89599e5`'s
> `secret` in the same change.** The vault value and the Zernio subscription move together or
> ingest breaks.

Every vault write is a deploy — **trap 11, then trap 2**. Invoke the **`flag-flip` skill**
before changing any env var.

---

## Then Phase H — the actual finish line

Standup §Phase H. **Not started.**

1. §9.1 sanity → §9.2 **read-only** backfill against a friendly/test GBP → §9.3 cost sanity →
   §9.4 approval email → §9.5 approval page (**no approve click**).
2. §9.6 — **one deliberate first post, clicked by a human**, with
   `ZERNIO_PUBLISHING_ENABLED=false` ready as the kill switch. Then §11 day-2 monitoring.
3. Only then: beta business one, per `beta-onboarding-cofounder-guide.md`.

---

## Owed, and not blocking

| Item | Why | Order |
|---|---|---|
| **Record the no-cancellation decision** | F4-F4: production has no self-serve cancellation — offboarding off **and** the portal withholds it. A tester should not discover this | A dated line in `launch-checklist.md` |
| The production test account | Cancelled, not deleted — deleting the Stripe customer orphans `accounts.stripe_customer_id`, and the rows make the PITR drill real | Decide after the drill |
| `PAST_REPLIES_VIEW_ENABLED` | Read by no code, but `true` on all four surfaces and in the vault. CLI cannot delete | Vault (web UI) first, **then** Vercel |
| Three Vercel vars → `--sensitive` | **A decision, not an action** — the sync does not preserve the flag | Decide first |
| Restore the light healthcheck | `/ready` runs three live probes; cost is bounded | Its own PR |
| Split the import-consent alert | One rule with `any` logic covers all four signals | Only if noisy. **Do not throttle all four** |
| IaC migration, due **2026-12-01** | `railway config migrate` output is **unsafe as generated** — names the service `RepWorth`, drops both restart-policy fields | Its own PR |
| Dependabot high-severity advisory | Reported on `main`. Not investigated | When convenient |

## The three open hard blockers

PITR restore drill, lawyer review, insurance binding. **Never tick an incomplete box.**

Two cannot finish quickly. That makes proceeding an explicit, recorded owner decision — a
dated block in `docs/launch-checklist.md`. **A recorded exception is a decision. An unticked
box that everyone stopped looking at is not.**

---

## What this run taught, in one line

**An environment is not live because its deploys are green.** Every blocker that mattered —
no admin user, an auth Site URL on `localhost:3000`, alerts that paged once per fault — was
invisible to configuration audit and obvious within minutes of a human walking the path.
Prefer walking a path to reading about one.
