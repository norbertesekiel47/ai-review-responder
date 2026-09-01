# Evidence — Phase H, the beta launch proof

Runbooks: [`docs/runbooks/deployment-guide.md`](../deployment-guide.md) **§8 → §9 → §10**
· protocol [`docs/runbooks/beta-production-standup.md`](../beta-production-standup.md) §§G–H
· onboarding [`docs/runbooks/beta-onboarding-cofounder-guide.md`](../beta-onboarding-cofounder-guide.md)

Campaign: the last item before beta tester one. Supersedes nothing; it executes what
`docs/superpowers/plans/2026-09-01-phase-h-execution-handoff.md` scoped.

---

## Environment

| Field | Value |
|---|---|
| Target | **production** `RepWorth` — Supabase ref `udeyaqnvpojbwgoaxwdg` |
| Staging project | `kubdiqdhqbhwmqfditeg` — **NOT touched by this campaign** |
| Worker | `https://worker.repworth.net` — Railway service `repworth-worker`, environment **production** |
| UI | Vercel Production |
| Stripe mode | **LIVE** |
| Git SHA at start | `b55b07822ef92f6c85047e6f42b5513ea8427257` (`main`) |
| Migrations head | 116 |
| UTC start | **2026-09-01T23:21Z** |
| Owner | @norbertesekiel — runs every browser click and every provider dashboard action |
| Live surface | **Tanicia Resort's Google Business Profile.** Place ID `ChIJqb_7RPR5UDcR6xUi5sIklYk` |

### Posture constraints — the whole campaign is written around these

- **Exactly one reply reaches Google, ever, in this campaign** (§9.6). Everything before it is
  read-only or internal.
- The GBP owner has agreed to the test. §10's two-person rule applies to the §9.6 click:
  the owner must name **the specific review** before the Approve click happens.
- `ZERNIO_PUBLISHING_ENABLED=false` is the kill switch and must be reachable in one command
  before §9.6 begins. Flipping it is a **vault write**, therefore a deploy — trap 11, then trap 2.
- The **F.4 account stays `cancelled` and untouched** (owner decision, 2026-09-01). It is the
  one real row that keeps a future restore check from passing vacuously. A NEW account carries
  beta tester one.
- §9.7's edge-case tests are **not** run against Tanicia Resort.

---

## Preflight

Every row below was measured in this session. None is quoted from a handoff.

| # | Check | Result | UTC | Evidence |
|---|---|---|---|---|
| P1 | `main` is current; handoff's SHA is stale | ⚠️ | 23:18Z | `git pull --ff-only` → already up to date at `b55b0782`. The handoff header names `e4338f1c`; `a72ba0eb` (#1065) and `b55b0782` (#1066) landed after it. **Expected — parallel sessions.** |
| P2 | Working tree carries other sessions' work | ⚠️ | 23:18Z | 6 dirty paths, all on the handoff's do-not-touch list. Commit named paths only. |
| P3 | Connected Google Business Profiles in production | ❌ **0** | 23:21:33Z | `select count(*) from zernio_connections` → `0` total, `0` active. **Block 1.** |
| P4 | Accounts with full access | ❌ **0** | 23:21:33Z | `subscription_status in ('active','trialing')` → `0`. One account, `cancelled`. **Block 2.** |
| P5 | Businesses | 1 | 23:21:33Z | `Tanicia Resort`, `01a05975-309d-7578-b684-6abfe6492e83`, tier `copilot`, created 2026-08-31T20:14:07Z by the F.4 walk |
| P6 | The Place ID is real and verified | ✅ | 23:22Z | `google_place_id = ChIJqb_7RPR5UDcR6xUi5sIklYk`, `place_id_verified = true` |
| P7 | Reviews / responses in production | 0 / 0 | 23:21:33Z | Nothing has ever been ingested or drafted here |
| P8 | Worker health | ✅ | 23:28:15Z | `GET /api/health` → `{"status":"ok","service":"worker","uptime_seconds":1790}`; `GET /ready` → `200` |
| P9 | Zernio ingress proven by a **signed** event | ✅ | 21:56:21Z | `inbound_events` `zernio` / `webhook.test` / `processed` in **64 ms** — the rotation's conclusive proof, still the newest Zernio test |
| P10 | Resend ingress proven | ✅ | 20:32:57Z | `inbound_events` `resend` / `email.delivered` / `processed`. Lane works; **U5 remains open** — no production email has been *sent* under the new key |
| P11 | Stripe live webhook proven | ✅ | 2026-08-31 20:32Z | `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, all `processed` |
| P12 | Import consent state on the existing business | ⚠️ `pending` | 23:22Z | `import_decision = 'pending'`, `import_offer_expires_at = null`. **Block 3 — see D-2.** |
| P13 | §10 rule 6 digests on the existing business | ⚠️ **both ON** | 23:22Z | `weekly_summary_enabled = true`, `monthly_impact_enabled = true`. Must be off before any testing on a real owner's row. |
| P14 | Schema permits a second row on the same Place ID | ✅ | 23:25Z | `businesses_account_place_uniq` is `(account_id, google_place_id) WHERE archived_at IS NULL` — **per account**, so a new account does not collide. `zernio_connections_one_active_per_business` is per business; the old row has none. |
| P15 | PITR / RPO posture | ⚠️ | 2026-09-01 21:14Z | `pitr_enabled: false` on prod and staging. Real RPO ≤ 24 h. **Owner decision 2026-09-01: accept 24 h through beta**, recorded as a dated block in `launch-checklist.md`. |

---

## Deviations

### D-1 (2026-09-01T23:24Z) — §8 connect is itself blocked by `cancelled`. The handoff's ordering understates it.

The handoff states the subscription block bites *"even with a connection … no approval email
would send and nothing would post"*, framing it as a §9.4/§9.6 problem. It is a **§8** problem.

`src/app/api/zernio/connect/start/route.ts:138` calls `assertWritableSubscriptionStatus`
before anything else:

```
const writable = assertWritableSubscriptionStatus({
  subscriptionStatus: accountRow.subscription_status, …
});
if (!writable.ok) return NextResponse.json({ error: writable.error }, { status: writable.status … });
```

`assertWritableSubscriptionStatus` (`src/lib/shared/writable-subscription.ts:48`) returns `ok`
only for `subscriptionGrantsFullAccess` — `active` or `trialing`
(`src/lib/shared/subscription-status.ts:57-60`) — or for `past_due` inside its grace window.
`cancelled` matches none, so the connect flow returns 402/403 and **never starts**.

**Consequence for the plan:** the two blocks are not parallel. Subscription is strictly
upstream of connect. Fixing the connection first is impossible.

### D-2 (2026-09-01T23:24Z) — §9.2's stated mechanism is wrong. A THIRD gate exists and no handoff names it.

§9.2 reads: *"Wait ~30s after §8 connect (the connect callback enqueues the backfill outbox
row)."* The callback does not do that.

`src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:205-232`:

```
if (accountLocation.subscription_activated_at) {
  await createImportOffer(tx, stored.businessId, ownerAccountId);
  const consent = await readImportConsent(tx, stored.businessId, ownerAccountId);
  if (consent?.state === 'accepted') {
    await enqueueInitialImport(tx, stored.businessId, ownerAccountId);
  } else {
    // "`pending` is the ordinary case here: the owner has not seen the banner yet."
  }
}
```

The connect callback creates the **Import offer**. It enqueues the backfill **only** when the
owner has already accepted. On a first connect the state is `pending` — the code's own comment
says so.

The worker is fail-closed to match. `guardImportConsent`
(`worker/jobs/zernio/job-eligibility.ts:192-220`) runs inside `sql.begin` with `FOR UPDATE`,
proceeds **only** on `state === 'accepted'`, and otherwise completes the outbox row with
`OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED`.

**Consequence for the plan:** §9.2 needs an owner click the runbook does not mention — accept
the Import offer in the dashboard. Without it the backfill enqueues nothing, silently and by
design, and §9.3 onward has no data to inspect. **Owed: fix §9.2 in `deployment-guide.md`
in the same change as this file.**

### D-3 (2026-09-01T23:28Z) — a `zernio` row in `inbound_events` is NOT evidence that production ingested anything.

`inbound_events` currently holds six `zernio` / `review.new` rows marked `processed`
(2026-09-01 08:30Z and 12:56Z) and an `account.connected` at 02:32:04Z — while
`zernio_connections = 0` and `reviews = 0`.

These are **staging's** events. Trap 9: Zernio webhook subscriptions are per-USER, so every
event fans out to both workers, and a foreign event matches zero rows and completes as a no-op.
The rows are correct behaviour, not ingestion.

**Consequence for the plan:** §9.1's pass criterion — *"`inbound_events` row with
`source='zernio'`"* — is satisfiable by an event this environment did not cause. §9.2's
verification must key on **`reviews.business_id`** and **`zernio_backfill_runs`**, never on the
presence of a `zernio` inbound row. Same shape as trap 12: the absence *and* the presence both
need the query stated before the result is believed.

### D-4 (2026-09-01T23:22Z) — §10 rule 6's digests are already ON, and rule 6 fires too late in the document.

`weekly_summary_enabled` and `monthly_impact_enabled` are both `true` on the existing business.
§10 is written after §9, but rule 6 must execute **before** §8 — a digest scheduler does not
wait for the runbook's page order. The new tester row must be checked at creation, not after.


### D-5 (2026-09-01T23:34Z) — §9.1's Sentry probe CANNOT PASS. The suggested trigger reports nothing.

§9.1 prescribes: *"trigger any handled error (e.g. visit `/api/admin/overview` without session)
| error appears in Sentry within 30s"*.

Executed against production at 23:31Z: `GET https://repworth.net/api/admin/overview` → **401**.
The app is live and the auth gate works. But the route
(`src/app/api/admin/overview/route.ts:14-15`) returns the 401 **before** its `try` block:

```
const auth = await requireRoleOr401(request, 'admin');
if (!auth.ok) return auth.response;      // <-- returns here
try { … } catch (error) { reportCaughtError('api/admin/overview', error); … }
```

`reportCaughtError` — the only Sentry call on this route — lives in the `catch`. A missing
session never reaches it. `reportCaughtError`'s own doc comment states why this matters:
*"Next.js `onRequestError` forwards only UNCAUGHT route errors to Sentry."* A 401 is neither
uncaught nor caught; it is a normal return value.

**So the prescribed probe produces a correct-looking 401 and zero Sentry events, and an
operator would read the silence as a Sentry failure.** The prediction was written before the
check and held: an expected auth rejection is not an error.

There is also **no dedicated Sentry test route** in `src/app/` — searched for
`sentry-example`, `sentry_test`, `/api/debug/sentry`: no match.

**Corrected probe owed in `deployment-guide.md` §9.1.** U1 must close on an error that actually
reaches `captureException` or an uncaught route throw — not on a 401.

---

## Teardown ledger

**Written before the first fixture, per the runbook contract.** Every row is created at fixture
creation time and ticked only after removal is VERIFIED by query, never assumed.

| # | Fixture | Identifier | Removal | State |
|---|---|---|---|---|
| T1 | *(none yet — no fixture created as of 23:30Z)* | — | — | — |

**Planned rows, to be filled in at creation:**

| # | Fixture (planned) | Removal plan | Note |
|---|---|---|---|
| T-a | New production account + business for tester one | **NOT torn down** — it is the beta row, by owner decision | Recorded here so the ledger is complete, not because it is disposable |
| T-b | Live Stripe subscription under the Beta comp coupon | **NOT cancelled** — F.4's mistake was cancelling; tester one keeps it | The $0 invoice still captures a card |
| T-c | Zernio connection to Tanicia Resort's GBP | `/api/zernio/disconnect` if the campaign aborts | Live third-party binding |
| T-d | One posted reply on Google (§9.6) | **NOT reversible by the app.** The GBP owner deletes it manually in Google's UI | This is why §9.6 is the line in the sand |
| T-e | `ZERNIO_PUBLISHING_ENABLED` if flipped | Restore recorded pre-flip value; vault write ⇒ redeploy `--from-source` | Record the pre-flip value BEFORE flipping |

---

## Unproven paths

Open until closed by evidence. The campaign cannot be declared PASS while any remain.

| # | Path | Closes at |
|---|---|---|
| U1 | Production Sentry receives an error from the live UI | §9.1 — **probe invalid, see D-5.** Needs a corrected trigger |
| U2 | A Zernio OAuth connect completes against a real GBP and writes `status='active'` | §8 |
| U3 | The Import offer renders to the owner and an acceptance enqueues the backfill | §9.2 |
| U4 | `ZernioBackfillWorker` ingests real reviews into `reviews` for this `business_id` | §9.2 |
| U5 | **A production email is SENT under the rotated `RESEND_API_KEY`** — inherited open from the 2026-09-01 rotation | §9.4 |
| U6 | An approval page renders read-only and writes an audit row on GET, with no state change | §9.5 |
| U7 | One approved reply reaches Google and is visible on the live profile | §9.6 |
| U8 | The OpenAI key is actually being used — not silently broken with Anthropic covering | §9.3 |

---

## Execution log

*(appended per step, with UTC, verbatim query/result, and PASS/FAIL/DEVIATION)*

### §9.1 — worker + ingress sanity. Partial, 2026-09-01T23:28Z.

| Test | Result | Evidence |
|---|---|---|
| Worker health | ✅ PASS | `GET /api/health` 23:28:15Z → `{"status":"ok","service":"worker","timestamp":"2026-09-01T23:28:15.847Z","uptime_seconds":1790}` |
| Worker `/ready` | ✅ PASS | `200` |
| Zernio ingress | ✅ PASS | Signed `webhook.test` → `processed` in 64 ms at 21:56:21Z (rotation evidence). **A signed event, not a presence check** — see D-3 |
| Resend ingress | ✅ PASS | `email.delivered` → `processed` at 20:32:57Z |
| App is live behind auth | ✅ PASS | `GET https://repworth.net/api/admin/overview` 23:31Z → **401**; `www` 308s to apex |
| Sentry wiring | ❌ **PROBE INVALID** | **U1 stays open.** The runbook's trigger cannot produce an event — see **D-5** |

**Observation, not a finding:** `uptime_seconds: 1790` puts the worker's last boot at
≈2026-09-01T22:58Z — after the rotation ended at 22:32Z. Cause not established. Recorded
because an unexplained restart before a live campaign is worth knowing about, not because it
is known to be a problem.

---

## Verdict

⏳ **IN PROGRESS.** Opened 2026-09-01T23:21Z.
