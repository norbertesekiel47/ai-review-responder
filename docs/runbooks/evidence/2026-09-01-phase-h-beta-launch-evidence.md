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
| P16 | Production flag values (owner-read, Vercel dashboard) | ✅ | 2026-09-02T00:0xZ | `ONBOARDING_DEMO_ENABLED=true` · `BETA_COMP_COUPON_ID=repworth-beta-comp-3mo` · `AUTOPILOT_PURCHASABLE=false` · `ZERNIO_PUBLISHING_ENABLED=true`. All four as required. **Values read from the dashboard, never from `vercel env ls`'s age column** (trap 19). |
| P17 | The live comp coupon exists and is valid — **the F.2 failure mode** | ✅ | 00:0xZ | `GET /v1/coupons/repworth-beta-comp-3mo` on `acct_1TUcR7IhPBLaM6xA` **livemode:true** → `percent_off: 100`, `duration: repeating`, `duration_in_months: 3`, `valid: true`, `redeem_by: null`, `max_redemptions: null`, `times_redeemed: 1`. The id matches the Vercel value **byte for byte** — F.2 shipped a live coupon under an id no environment named; this one is named by both. `times_redeemed: 1` is F.4. |
| P18 | Live Prices active | ✅ | 00:0xZ | 6 active live Prices. **Copilot founding base `price_1Tu0tlIhPBLaM6xAqs62deIQ` = $19.00** — the subtotal F.4's checkout showed. Copilot base $29, extra location $15; Autopilot $49/$69/$20. |
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
The app is live and the auth gate works. But the 401 is returned **before** the route's
`try` block — since #1203 by `src/proxy.ts` (no bearer on `/api/admin/**` → 401 before any
route runs), and otherwise by the route's own gate
(`src/app/api/admin/overview/route.ts:14-15`, re-resolved 2026-09-11 for #1223; it was
`requireRoleOr401` when this was written):

```
const gate = await requireAdminWithAal2(request);
if (!gate.ok) return gate.response;      // <-- returns here
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


### D-6 (2026-09-02T00:1xZ) — the planned owner email would have 409'd on the first click. Caught before the submit, not after.

**Owner decisions this session:** owner email `norbertliverpool@gmail.com` (F.4's address, kept
separate from the admin identity `norbertesekiel@gmail.com`); the owner authorizes §8 with his
own Google account, on which he is **already a manager** of the Tanicia Resort listing.

The first of those two would have failed. `norbertliverpool@gmail.com` **already exists** in
production:

```
users: 01a0596a-…-27fba8886d5a  norbertesekiel@gmail.com   admin  account_id NULL
       01a05975-…-b22b9491eae4  norbertliverpool@gmail.com owner  account_id 01a05975-…-b6fb26bf58d1
```

That `account_id` is the **cancelled** F.4 account. `createBusinessTx` normalizes the address
and writes it against a unique constraint on `users.email`; a 23505 there raises
`DuplicateEmailError`, which `admin-onboarding-service.ts:236-241` translates to
**`409 DUPLICATE_EMAIL — "A user with this email already exists"`**.

**Two independent dead ends, and the second is the quieter one.** Even if the create had
succeeded, `resolveFunnelEntry`'s precedence sends a `cancelled` owner to row 5 → `/dashboard`.
`cancelled` is neither `pending_payment` (rows 1–3, the checkout lane) nor full access (row 4).
**The existing owner cannot reach checkout at all** — so "sign in as the F.4 owner and pay
again" is not a workaround either.

**Resolution — a Gmail plus-alias.** `createBusinessTx` normalizes with `trim().toLowerCase()`
and nothing else; no plus-tag stripping anywhere on the path. So
**`norbertliverpool+beta1@gmail.com`** is a distinct `users.email` value, delivers to the same
inbox the owner reads, creates a genuinely new account and business, and leaves F.4 untouched as
the restore anchor. `businesses_account_place_uniq` is per-account, so the shared Tanicia Resort
Place ID is not a conflict (P14).

**How this was found matters more than the fix.** Nothing failed. The plan said "submit the
form"; reading `users` before the click, and then the collision path from source, is what turned
a live 409 into a one-word change. **The generalisable shape: a form's first field is a query
you have not run yet.**


### D-7 (2026-09-02T05:15:54Z) — 🔴 **INCIDENT. The 2026-09-01 rotation broke Supabase Auth's outbound email, and this is how we found out.**

H.0b was submitted at **05:15:52Z**. `createBusinessTx` committed. `inviteUserByEmail` then
failed, and the Auth log names the cause without ambiguity:

```
path: /invite   status: 500   error_code: unexpected_failure
error: 535 "Authentication credentials invalid"
auth_event.action: user_invited
traits.user_email: norbertliverpool+beta1@gmail.com
traits.user_id:    cf7d44b3-e5ee-429c-9e61-fbe644fb9f59
time: 2026-09-02T05:15:54Z
```

**SMTP 535 is a credential rejection.** Supabase Auth's custom SMTP password is no longer valid.

**The cause is the rotation, and the timing is conclusive.** `RESEND_API_KEY` was rotated at
2026-09-01T21:52Z and the old key was **deleted** at 22:31Z. Supabase Auth sends through Resend
SMTP, whose password **is a Resend API key**. The rotation moved the key in three places —
the vault, Vercel, Railway — and in the Zernio subscription. **Supabase Auth's SMTP settings is
a FOURTH holder of that credential, and it was not in anyone's inventory.**

F.4's invite sent successfully on 2026-08-31T20:27Z, *before* the rotation. **This was the first
Auth email production has attempted since.** The rotation's own evidence file closed U1–U6 and
listed U5 (no production email sent) as deliberately open — U5 was open on the **Resend API**
lane. Nobody asked about the **SMTP** lane, because nobody knew it was a consumer.

**Blast radius is larger than this campaign.** Supabase Auth sends invites, password resets and
email confirmations. **All three are down in production right now.** No customer has hit it only
because there are no customers yet.

**The generalisable lesson, and it is the sharpest one this launch has produced:**
`ROT-D7` already recorded that a rotation preflight must capture the **provider's key list**.
That is necessary and not sufficient. **A rotation must also enumerate every CONSUMER of the
credential, and a consumer is not always a variable in a vault** — here it is a password field
in a third party's dashboard, holding a copy of a key that a *different* provider issued.
Fingerprints, boot gates and signed webhooks all passed. **Every check the rotation ran was
scoped to the consumers it already knew about.**

### D-8 (2026-09-02T05:15:54Z) — the compensating rollback is DEAD CODE. It cannot succeed while a business row exists.

The invite failure triggered `rollbackProvisionedBusiness`
(`src/lib/onboarding/admin-onboarding-service.ts:189-199`), which deleted **nothing** — all
three rows survive. Not a partial delete; a total one, silently swallowed by the caller's
`catch`.

Its delete order is:

```
job_outbox → users → accounts → businesses
```

But `fk_businesses_account` is `FOREIGN KEY (account_id) REFERENCES accounts(id)` — **NO
`ON DELETE CASCADE`**, verified against production. So `DELETE FROM accounts` raises `23503`
while the `businesses` row still points at it, the enclosing `sql.begin` aborts, and every
earlier delete in the transaction is rolled back with it.

**The function can never work.** It is reached only when a business row exists, and a business
row is exactly what makes it fail. `users` deletes fine only because `fk_users_account` is
`DEFERRABLE INITIALLY DEFERRED`; nothing else is.

The doc comment above it reasons about the wrong edge — *"businesses last —
channel_enrollments cascade-deletes via businesses.id ON DELETE CASCADE"*. That cascade is
real (verified), but it is the `businesses → channel_enrollments` edge. The comment never
considers `businesses → accounts`, which is the one that blocks.

**Correct order: `job_outbox → users → businesses → accounts`.** Deleting `businesses` first
cascades `channel_enrollments` (one such row exists here), which then frees `accounts`.

**Owed: a code fix and a regression test.** The error message the operator sees —
*"the cleanup rollback partially failed"* — is also wrong: it did not partially fail, it wholly
failed. "Partially" is the message the `hasOrphans` branch prints whether one row or all three
survive.


### D-8a (2026-09-02T05:4xZ) — a correction to D-8, found by executing my own remedy

D-8 named the correct order as `job_outbox → users → businesses → accounts`. Executing the
first `DELETE FROM users` **as a standalone statement** raised:

```
23503: update or delete on table "users" violates foreign key constraint
       "accounts_owner_user_id_fkey" on table "accounts"
```

A **third** edge, unlisted in D-8: `accounts.owner_user_id → users.id`. The full cycle is

| Edge | Deferral |
|---|---|
| `accounts.owner_user_id → users.id` | **DEFERRABLE INITIALLY DEFERRED** |
| `users.account_id → accounts.id` | **DEFERRABLE INITIALLY DEFERRED** |
| `businesses.account_id → accounts.id` | immediate, no cascade |
| `businesses.onboarded_by → users.id` | immediate, no cascade (points at the ADMIN user) |

**D-8's order is right, and only inside a transaction.** Both deferrable edges are checked at
COMMIT; in autocommit each statement is its own transaction, so the check fires immediately and
the users delete fails. The production cleanup therefore ran as one explicit
`begin … commit`, and the fix's doc comment now says so.

**This is the session's third instance of the same shape** — PITR-D1, D-5, and now this: a
remedy that is only wrong when executed. It was caught because the delete was run as one
statement and verified, rather than assumed.

## Resolution — D-8 fixed, and the test that could not have caught it replaced

| Item | State |
|---|---|
| `rollbackProvisionedBusiness` delete order | ✅ `job_outbox → users → **businesses** → accounts` |
| Operator message | ✅ no longer claims "partially failed"; it names the required order |
| Doc comment | ✅ rewritten — the old one justified the order via the businesses→channel_enrollments cascade, which is real but is not the edge that blocks |
| Mocked characterization suite | ✅ order corrected, plus an explicit businesses-before-accounts assertion. **5 passed** |
| **New live-DB suite** `admin-onboarding-rollback.integration.test.ts` | ✅ **3 passed** against real Postgres |

**The mocked suite pinned the bug as correct for as long as the bug lived.** A mock `sql` has
no foreign keys, so a characterization test over emitted SQL text is blind to the constraint
that actually decides the outcome. The new suite asserts the ROWS ARE GONE, and carries a
**negative control** that re-runs the pre-fix order and asserts it still raises `23503` and
leaves all three rows — so the suite cannot pass vacuously if a future migration adds a cascade.


### §D-7 resolution — verified at the send layer, 2026-09-02T05:35:00Z

The owner updated Supabase Auth's SMTP password from the vault's rotated `RESEND_API_KEY`,
browser to browser (Infisical copy button → Supabase dashboard field). **No value passed through
a command, a shell history or a transcript** — trap 16, applied correctly this time.

**Verified by a real send that writes no rows.** `POST /api/auth/forgot-password` with an
existing owner address triggers `resetPasswordForEmail` through the same SMTP credential and
creates no `users`/`accounts`/`businesses` row — so a second failure could not orphan anything
while the D-8 fix is still unmerged.

The route returns a generic `{"ok":true}` `200` on **every** outcome (success, unknown email,
role mismatch) by design, so the HTTP response is not evidence. The Auth log is:

| UTC | path | status | error |
|---|---|---|---|
| 05:15:54Z | `/invite` | **500** | `535 "Authentication credentials invalid"` |
| 05:35:00Z | `/recover` | **200** | *(empty)* |

**The prediction was written before the run** and named both outcomes explicitly.

**One trap re-encountered:** the first log query filtered `path in ('/recover','/invite')` and
returned empty ~40 s after the send. That is ingestion lag, not absence — and it is trap 12's
shape exactly. Widening the window and dropping the path filter found the row. *An absence from
a filtered query is not evidence of absence, including when the filter is a time window.*

**U9 is FULLY CLOSED.** The `200` proved Supabase handed the message to Resend without a
credential rejection; **the owner then confirmed the reset email arrived in the inbox.** Both
halves of the lane are now demonstrated — the credential is accepted AND the message is
delivered. This is the same ladder the rotation used: a write returning success proves nothing,
a status code proves the handoff, and only the artifact arriving proves the lane.

**Note what this does NOT close.** This message went through **Supabase Auth's SMTP**
credential. §9.4's approval email goes through the **Resend API** in the worker. They are two
different consumers of the same rotated key, and D-7 is precisely the lesson that proving one
does not prove the other. **U5 stays open until a production approval email sends.**

---

## Teardown ledger

**Written before the first fixture, per the runbook contract.** Every row is created at fixture
creation time and ticked only after removal is VERIFIED by query, never assumed.

| # | Fixture | Identifier | Removal | State |
|---|---|---|---|---|
| T1 | `public.users` — `norbertliverpool+beta1@gmail.com`, `auth_id` NULL | `01a0608b-89a9-7543-9352-51a0f42bd769` | `DELETE FROM users WHERE id = …` | ✅ **CLOSED 2026-09-02T05:5xZ**, verified by absence |
| T2 | `businesses` — `Tanicia Resort`, no Place ID. Cascades 1 `channel_enrollments` row | `01a0608b-89a9-7543-9352-4ee520cc71ad` | `DELETE FROM businesses WHERE id = …` | ✅ **CLOSED**, verified by absence |
| T3 | `accounts` — `pending_payment`, `copilot`, no Stripe customer | `01a0608b-89a9-7543-9352-572df241de52` | `DELETE FROM accounts WHERE id = …` — **after T2** (D-8) | ✅ **CLOSED**, verified by absence |

**Created unintentionally at 2026-09-02T05:15:52Z by the failed H.0b, and orphaned by D-8.**
They are fixtures now regardless of intent. Delete order is load-bearing: `users` →
`businesses` → `accounts`. No `auth.users` row survives — Supabase rolled its own back
(verified: `auth.users` holds exactly 2 rows, both pre-existing).

| # | Fixture | Identifier | Removal | State |
|---|---|---|---|---|

**Planned rows, to be filled in at creation:**

| # | Fixture (planned) | Removal plan | Note |
|---|---|---|---|
| T-a | New production account + business for tester one — owner `norbertliverpool+beta1@gmail.com`, business `Tanicia Resort`, Place ID `ChIJqb_7RPR5UDcR6xUi5sIklYk` | **NOT torn down** — it is the beta row, by owner decision | Recorded so the ledger is complete, not because it is disposable. F.4's row is untouched. |
| T-b | Live Stripe subscription under the Beta comp coupon | **NOT cancelled** — F.4's mistake was cancelling; tester one keeps it | The $0 invoice still captures a card |
| T-c | Zernio connection to Tanicia Resort's GBP | `/api/zernio/disconnect` if the campaign aborts | Live third-party binding |
| T-d | One posted reply on Google (§9.6) | **NOT reversible by the app.** The GBP owner deletes it manually in Google's UI | This is why §9.6 is the line in the sand |
| T-e | `ZERNIO_PUBLISHING_ENABLED` if flipped | Restore to **`true`** — the pre-flip value, **recorded 2026-09-02 before any flip**. Vault write ⇒ redeploy `--from-source` | The kill switch is a flip to `false`. It is a vault write, therefore a deploy: trap 11, then trap 2 |

---

## Unproven paths

Open until closed by evidence. The campaign cannot be declared PASS while any remain.

| # | Path | Closes at |
|---|---|---|
| U9 | **Supabase Auth can send email again** (D-7) | ✅ **FULLY CLOSED 2026-09-02.** `/recover` 200 at 05:35:00Z (no 535), **and the owner confirmed the reset email ARRIVED** — accepted by Supabase, delivered by Resend, landed in the inbox |
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

⏸️ **PAUSED BY THE OWNER, 2026-09-02T05:4xZ — not blocked.** Opened 2026-09-01T23:21Z.

Both defects that stopped the first attempt are **closed**. The campaign stopped at a clean
state: no fixture is open, no flag was flipped, no worker was stopped, and production is at the
exact pre-H.0b baseline.

### Resume from here — the next step is H.0b, and nothing before it needs redoing

> **Superseded 2026-09-14 by "Resume 2" at the bottom of this file.** The admin split moved
> H.0b's page to `https://admin.repworth.net`; `repworth.net/admin/businesses/new` is gone.

| # | Step | State |
|---|---|---|
| — | Preflight P1–P18 | ✅ done, all measured this session |
| — | §9.1 read-only half | ✅ worker healthy, both ingress lanes proven. **U1 open on a bad probe (D-5), not a failure** |
| — | Orphan cleanup T1–T3 | ✅ executed and verified by absence |
| — | **D-7** Supabase Auth SMTP | ✅ **FIXED + verified end to end** (U9) |
| — | **D-8** rollback dead code | ✅ **FIXED, MERGED AND LIVE IN PRODUCTION.** PR #1067 squash-merged `3e1bcec0` at 2026-09-02T06:48:55Z; production alias flipped 06:50:15Z. Verified by SHA, not by timing: the served deployment's `githubCommitSha` is `3e1bcec0…`, `githubCommitRef: main`, `target: production`, `aliasError: null`, `repworth.net` + `www.repworth.net` on it |
| **→** | **H.0b** create tester one | ⏳ **NEXT.** `/admin/businesses/new` — `norbertliverpool+beta1@gmail.com` · `Norbert Sunn` · `Tanicia Resort` |
| | H.0c–H.0d | invite → password → location+demo → Copilot → **checkout MUST read $0.00** |
| | H.0e | **both digest flags OFF before §8** (D-4) |
| | §8 | owner connects Google; he is already a manager of the listing |
| | — | **owner accepts the Import offer** — the gate §9.2 omitted (D-2) |
| | §9.2 → §9.7 | per `deployment-guide.md`, as corrected by this file |

### Read these before resuming

1. **D-6** — `norbertliverpool@gmail.com` (no `+beta1`) is F.4's address and still exists on the
   cancelled account. Submitting it returns **409**. The alias is deliberate.
2. **D-8 IS deployed** — corrected 2026-09-02T06:50Z; an earlier revision of this block said it
   was not, and that is exactly the stale-doc failure this campaign kept finding. An onboarding
   failure now rolls back cleanly. Should manual cleanup ever be needed anyway, it is one
   transaction: `users → businesses → accounts`, inside an explicit `begin … commit`
   (**D-8a** — two edges are `DEFERRABLE INITIALLY DEFERRED`, so autocommit fails on
   `accounts_owner_user_id_fkey`).

   **Trap 19 fired on the way here and is worth keeping:** at merge+90s the alias still served a
   build from 8 hours earlier. A merge is not a deployment and a `Ready` deployment is not the
   served one — the check that settles it is the alias plus the commit SHA.
3. **U5 is still open and D-7 is why it matters.** The proven email went through Supabase Auth's
   **SMTP**; §9.4's approval email goes through the **Resend API** in the worker. Two consumers,
   one key. Proving one never proved the other — that is the whole finding.
4. **§9.6 is unchanged and unstarted.** The GBP owner has agreed in principle; the specific
   review has NOT been named. §10's two-person rule needs that before the Approve click.

### Deviations, eight, and six corrected a claim that was already standing

`D-1` §8 blocked by `cancelled`, ordered not parallel · `D-2` §9.2's mechanism is wrong, a third
gate exists · `D-3` a `zernio` inbound row is not ingestion · `D-4` digests already on ·
`D-5` §9.1's Sentry probe cannot pass · `D-6` the planned owner email would have 409'd ·
**`D-7` the rotation had an unlisted consumer** · **`D-8`/`D-8a` the rollback was dead code, and
my own first correction to it was also wrong**.

**Not one was found by something failing a check.** D-7 and D-8 surfaced because a real
onboarding was attempted; the other six because predicates were read from source and
predictions written down before running anything.

**UTC start 2026-09-01T23:21Z · paused 2026-09-02T05:4xZ.**

---

## Resume 2 — 2026-09-14, read-only preflight after the admin split

Run by an agent while the owner was away. **Read-only against production** except one browser
probe (R10). No account, business, flag, deploy or provider object was created or changed.
`main` = `a95478037` (#1288).

### What changed since the pause

- **The admin split finished** (map #1159, ADRs 0024–0031, `deployment-guide.md` §1.1.1–§1.1.2).
  Every admin page this campaign names — `/admin/businesses/new`, `/admin/businesses/[id]`
  (Resend invite), `/admin/costs`, `/admin/jobs`, `/admin/notifications`, `/admin/overview` — now
  lives on the **Admin app** at `https://admin.repworth.net`. On `repworth.net` the same path
  307s to the legacy `/admin/login` shell that is kept only for impersonation.
- **No admin has signed in to the production Admin app yet.** The owner's last production sign-in
  is 2026-09-08T23:34Z, before the Admin app's production config existed (2026-09-11). The
  2026-09-11 readiness evidence claims public checks only. The first authenticated production
  Admin app journey is therefore **R0 of the resume**, before H.0b.

### Preflight, re-measured

| # | Check | Result | UTC | Evidence |
|---|---|---|---|---|
| R1 | Production still at the pre-H.0b baseline | ✅ | 09:50:07Z | users 3 · accounts 1 (`cancelled`, F.4) · full-access 0 · businesses 1 · `zernio_connections` 0 · reviews 0 · responses 0 · `+beta1` email rows **0** · outbox failed 0 / in-flight 0 · open finalize incidents 0 |
| R2 | Served UI is current `main` | ✅ | — | `repworth.net` alias → `dpl_BCTiLHr1TvUnHJoYMQTP7qbzNVf2`, `githubCommitSha a95478037…`, `target: production`, `aliasError: null` |
| R3 | Production worker is current `main` | ✅ | 05:31:32Z | Railway deployment `b7eef8ee-…` `SUCCESS`, `commitHash a95478037…`; `/api/health` ok, `/ready` 200 |
| R4 | Migration head present | ✅ | 04:1xZ | `public.agent_turns` exists (migration 120) |
| R5 | Worker flag posture (Railway `production`, values read by name only) | ✅ | 09:3xZ | `AUTO_APPROVAL_ENABLED=false` · `AUTOPILOT_PURCHASABLE=false` · `TRIAL_ENABLED=false` · `SELF_SERVE_SIGNUP_ENABLED=false` · `ZERNIO_PUBLISHING_ENABLED=true` · `OPENAI_MODERATION_ENABLED=true` · `ONBOARDING_DEMO_ENABLED=true` · `BETA_COMP_COUPON_ID=repworth-beta-comp-3mo` · triage/escalation/judge/governor/ranking/owner-operator unset · `MOCK_EXTERNAL_APIS` and `NODE_ENV` unset · `SENTRY_DSN` set |
| R6 | Vercel Production flag posture | ⚠️ **not re-read** | — | The Vercel CLI is not logged in on this machine (no `auth.json`); `vercel link` hung and was killed. The vault syncs `BETA_COMP_COUPON_ID`/`ONBOARDING_DEMO_ENABLED`/`AUTOPILOT_PURCHASABLE` to both platforms, and R5 matches P16. **Owner: re-read the four P16 values in the Vercel dashboard before H.0b.** |
| R7 | Live comp coupon | ✅ | 09:4xZ | `repworth-beta-comp-3mo` livemode: `percent_off 100`, `repeating`, `duration_in_months 3`, `valid true`, `times_redeemed 1` (F.4) |
| R8 | Live Prices | ✅ | 09:4xZ | 6 active, unchanged from P18 (Copilot founding base `price_1Tu0tl…qs62deIQ` = $19.00) |
| R9 | Admin app reachable | ✅ | 04:13Z | `admin.repworth.net/login` 200; every admin path 307 → `/login?next=…` |
| R10 | **U1, browser half** | ✅ **CLOSED** | 09:42:56Z | On `https://repworth.net/`, `setTimeout(() => { throw new Error('U1 sentry probe (phase-h resume) …') }, 0)` → **REPWORTH-PRODUCTION-5**, `environment: vercel-production`, `url: https://repworth.net/`, `release: a95478037…`, `mechanism: auto.browser.browserapierrors.setTimeout`. No tag matches a Discord rule, so nothing paged. |
| R11 | **U1, server half** | ⚠️ covered by DSN match, not by an event | — | No safe unauthenticated server trigger exists (every `/api/admin/**` 401s in `src/proxy.ts`; public routes handle bad input). The production `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` name the **same** Sentry project `4512002871001088` (redacted read of the owner's `.env.production.local`, pulled 2026-09-08). R10 proves that project ingests. |
| R12 | Zernio ingress re-proof | ⏭️ not run | — | A signed `POST /v1/webhooks/test` via `railway run` was refused by the agent's permission policy. P9 (2026-09-01) stands; §9.2 re-proves ingress with real events keyed on `business_id`. |

### Deviations

**D-9 (2026-09-14) — a local production build reports into the production Sentry project, and
it looks exactly like a live error.** `REPWORTH-PRODUCTION-4` (2026-09-10, `GET /design-directions`)
carries `environment: vercel-production`, but `url: http://localhost:3020/…`,
`server_name: Norberts-MacBook-Pro.local`, `browser: HeadlessChrome`. Cause: a local `next start`
with the pulled production env inherits `SENTRY_DSN` and `VERCEL_ENV=production`. **Consequence:**
the issue list is not evidence of live traffic, and an agent looking for "a real production error"
to close U1 would have closed it on a laptop. Filter on `url`/`server_name`, or unset the DSN in
local production builds. Not a launch blocker; recorded so nobody reads it as U1.

**D-10 (2026-09-14) — H.0b's page moved.** See "What changed". Every admin step below uses the
Admin app. Impersonation (§8's "or impersonate") is a link-out from the Admin app's business
page to `repworth.net/admin/impersonate`, which asks for password + TOTP again.

### Teardown ledger additions

| # | Fixture | Identifier | Removal | State |
|---|---|---|---|---|
| T4 | Sentry issue from the R10 probe | `REPWORTH-PRODUCTION-5` (2 events) | Resolve in Sentry | ⏳ open — resolve after the owner has read it |

### Resume from here (2)

| # | Step | Who | Note |
|---|---|---|---|
| **R0** | Sign in at `https://admin.repworth.net/login`, pass TOTP, open `/admin/overview` and see data | owner | First authenticated production Admin app journey. A 401/403/CORS error here stops the campaign |
| — | Re-read the four P16 flags in the Vercel dashboard (R6) | owner | |
| **H.0b** | `https://admin.repworth.net/admin/businesses/new` — `norbertliverpool@gmail.com` · `Norbert Sunn` · `Tanicia Resort` | owner | **D-6 no longer applies** — the F.4 account and its Auth login were deleted on 2026-09-14, so the plain address is free. The `+beta1` alias is not needed. |
| H.0c–H.0d | invite → password → location+demo → Copilot → **checkout MUST read $0.00** | owner | Stop on any other amount |
| H.0e | **both digest flags OFF on the new business before §8** (D-4) | agent SQL, owner approves | |
| §8 | owner connects Google; verify `status='active'` | owner | |
| — | **owner accepts the Import offer** (D-2) | owner | |
| §9.2 → §9.5 | backfill (key on `business_id`, D-3) → cost sanity on the Admin app + OpenAI dashboard (U8) → approval email (U5) → approval page, **no click** (U6) | owner + agent | |
| §9.6 | one post; the GBP owner names the review first; kill switch ready | owner clicks | U7 |

**Still open outside this campaign** (`launch-checklist.md`): lawyer review of the legal docs,
insurance binding, alerting drills §4.7/§4.8, and the `endpoint:admin-mfa-gate` Discord rule
(`beta-launch-alerting.md` §1, #1212).

---

## Amendment — 2026-09-16: both environments emptied, tiers repriced

Owner decisions, executed and verified after "Resume 2" was written. They change three
rows above.

- **Production holds no customer data.** The F.4 account, its business, owner login and
  Supabase Auth user were deleted on 2026-09-14T17:44Z; the live Stripe customer
  `cus_VAxn9cbOQJGzz2` was deleted the same day (`deleted: true`, live mode holds 0
  customers). Only the two admin logins remain. **This retires the 2026-09-01 decision to
  keep F.4 as the restore-drill anchor, and it retires D-6:** tester one uses
  `norbertliverpool@gmail.com` with no alias.
- **Staging holds no customer data** (2026-09-16T07:14Z): 7 accounts, their businesses,
  owner logins and 6 Auth users deleted; 4 test subscriptions cancelled and their Stripe
  test customers deleted; the Zernio profile removed by the owner in Zernio's dashboard.
  The 6 admin logins and the Gate A non-admin login stay.
- **New prices are live** (#1290, `103d38043`): Copilot **$79** list / **$49** founding,
  Autopilot **$149** list / **$99** founding, and every extra location at the list price.
  Six new Stripe Prices per mode; the six `STRIPE_PRICE_*` values were rotated in the
  Infisical `prod` vault and on both staging surfaces, each readback verified, and all
  twelve Prices verified for amount, currency, monthly interval and active state. The
  Beta comp coupon is unchanged, so tester one still checks out at **$0.00** and converts
  at **$49** in month four — the co-founder guide now says $49.
- **`OWNER_OPERATOR_ENABLED` is ON in production** since 2026-09-15 (#1296), with Tanicia
  Resort named as the pilot owner. Tester one therefore lands on a dashboard where the
  Operator screen is live.

**Unchanged by this amendment:** R0 (first authenticated production Admin app sign-in)
still comes before H.0b, U1's server half is still unproven (R11), and §9.6 still needs
the GBP owner to name the specific review.
