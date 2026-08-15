# WS8 Copilot/Autopilot tier cutover

This runbook is the only executable WS8 rollout path. It replaces the four old
subscription tiers with Copilot and Autopilot and deliberately requires a
quiesced environment:

> quiesce → provider-wide Stripe preflight reaches zero blockers → migration
> 077 expand/normalize → deploy strict code → controlled smoke → migration 078
> contract → resume → **migration 105** (section 8)

**105 is part of this cutover, not a follow-up.** It replaces a constraint 077
created and so cannot be applied before 077; the strict code deployed here writes
the column it adds, so skipping it fails every checkout. Section 8 is not
optional.

> **Production is partially through this sequence already (verified 2026-08-14).**
> **077 and 105 are applied in prod; 078 is not.** Sections 5 and 8 are therefore
> **verify** steps for the production run, and the live resume point is
> **section 6**. Staging is unaffected — it has had all three since 2026-07-16.
> Do not read the sequence above as "nothing has run in prod"; re-introspect
> before assuming. Detail: `.claude/reference/migrations-log.md` entries 077/105,
> and lab-notes "Migration lockstep audit".

There is no live-traffic compatibility reader, grandfathering map, or alternate
migration order. Run every phase in staging first. After staging evidence is
accepted, repeat the complete sequence in production. Do not edit an existing
Stripe Price amount.

## Roles, evidence, and stop rule

Assign one cutover owner and one observer. Before quiescence, open an evidence
record containing environment, owner, observer, git SHA, UTC start time, Stripe
mode/account, migrations present, and the expected six new plus seven retained
old Price variable names. Record command exit codes and sanitized output; never
record keys, customer details, or Checkout URLs.

At each of these three checkpoints, record the exact UTC verification time, the
observed literal `FOUNDING_DEADLINE=2027-01-01T00:00:00Z`, and the observed
`AUTOPILOT_PURCHASABLE` state on both Railway and Vercel:

1. pre-077, after quiescence and provider preflight;
2. immediately before controlled smoke;
3. post-078, before full resume.

The evidence fields are `founding_deadline_verified_at_utc` and
`autopilot_purchasable_verified_at_utc`; a value recorded earlier in the day is
not evidence for a later checkpoint.

Stop and keep the environment quiesced on any nonzero check, unexpected write,
schema/data discrepancy, provider error, or missing operator input. Do not
advance because a database projection appears terminal: Stripe is authoritative.

## 1. Create immutable Prices and stage configuration

Do this first in Stripe test mode for staging, then in the production Stripe
account only after staging completes.

Create six active USD monthly recurring Prices. If Stripe Tax is enabled, set
`tax_behavior=exclusive`.

| Variable | Amount |
|---|---:|
| `STRIPE_PRICE_COPILOT_LIST` | 2900 cents |
| `STRIPE_PRICE_COPILOT_FOUNDING` | 1900 cents |
| `STRIPE_PRICE_AUTOPILOT_LIST` | 6900 cents |
| `STRIPE_PRICE_AUTOPILOT_FOUNDING` | 4900 cents |
| `STRIPE_PRICE_COPILOT_OVERAGE` | 1500 cents |
| `STRIPE_PRICE_AUTOPILOT_OVERAGE` | 2000 cents |

Set all six new variables on both Railway and Vercel for the target environment.
Before strict code boots, also set these operator inputs:

- `FOUNDING_DEADLINE=2027-01-01T00:00:00Z`
- `DAILY_COST_LIMIT_CENTS_COPILOT=<approved positive integer>`
- `DAILY_COST_LIMIT_CENTS_AUTOPILOT=<approved positive integer>`
- `AUTOPILOT_PURCHASABLE=false`

Do not invent the two cost ceilings. The integration owner supplies them.

Retain all seven old Price variables on both platforms through the rollback
window:

- `STRIPE_PRICE_BASIC`
- `STRIPE_PRICE_FOUNDING`
- `STRIPE_PRICE_FOUNDERS_OVERAGE`
- `STRIPE_PRICE_STANDARD`
- `STRIPE_PRICE_STANDARD_OVERAGE`
- `STRIPE_PRICE_PREMIUM`
- `STRIPE_PRICE_PREMIUM_OVERAGE`

Strict code never resolves runtime billing from those seven values. The cutover
preflight reads them only to identify open legacy-Price Checkout Sessions.

## 2. Deny producers, drain every writer/publisher, then quiesce

Record owner and UTC quiescence start time before changing controls.

1. Set `SELF_SERVE_SIGNUP_ENABLED=false` on Railway and Vercel, but do not treat
   that flag as sufficient: admin creation and existing-owner billing routes are
   separate writers.
2. In the target Vercel environment, install a temporary maintenance/firewall
   rule that denies non-operator requests to **every producer before draining**.
   At minimum this includes account creation/admin import, signup status,
   Checkout, tier change, plan selection, location add/archive/reactivate,
   Zernio connect/backfill, owner approval/veto, dashboard approve/edit/publish/
   retry/restore, and account-offboarding/cancel actions. The known route set
   includes `POST /api/auth/signup`, `POST /api/auth/finish-signup`,
   `GET /api/auth/signup-status`, `POST /api/admin/businesses`,
   `POST /api/billing/checkout`, `POST /api/billing/tier-change`,
   `POST /api/onboarding/select-plan`, `/api/approve/*`, and the corresponding
   `/api/dashboard/reviews/*` and `/api/dashboard/past-replies/*` mutations.
   Deny every currently deployed alias or admin path that reaches the same
   modules; do not rely on this illustrative list as an allowlist. Preserve a
   tightly scoped operator allowlist only for the later controlled smoke.
3. Stop new worker-side producers without stopping consumers: deny
   `/ingress/zernio`, set `ZERNIO_RECENT_REVIEW_POLL_DISABLED=true` through the
   approved Railway configuration path, and wait for the replacement worker to
   be healthy. Record the previous value for resume. Do not set
   `ZERNIO_PUBLISHING_ENABLED=false`, because already-admitted publish jobs must
   finish through their normal safety gates.
4. Disable the target Stripe webhook endpoint while the Railway worker remains
   running. This closes `/ingress/stripe` but leaves OutboxPoller and BullMQ
   consumers available to drain. Do not rotate or blank the signing secret, and
   do not pause the worker yet.
5. Drain every queue that can still mutate account/billing state or reach a
   publish. The mandatory set is `publish_response`,
   `update_stripe_overage_quantity`, `stripe_checkout_session_reconcile`, and
   all their admitted producers: `ingest_zernio_review`,
   `zernio_initial_backfill`, `generate_response`,
   `drain_pending_owner_connect`, `account_offboarding_billing_schedule`,
   `account_offboarding_reactivation`, `account_offboarding_teardown`, and
   `account_offboarding_purge`. Add any newly deployed producer discovered from
   the current queue registry or writer inventory. For each queue, capture
   trusted BullMQ counts for `waiting`, `active`, `delayed`, `prioritized`, and
   `waiting-children`, plus any retry-capable job. Every one must reach zero.
   The admin jobs page omits some of these states, so supplement it with the
   authenticated worker/Redis BullMQ diagnostic. A retry in backoff counts as
   delayed work, not as drained.
6. Independently require the corresponding transactional-outbox rows to reach
   zero in every in-flight state. Preserve the result as evidence:

   ```sql
   SELECT topic, status, COUNT(*) AS in_flight_count,
          MIN(available_at) AS oldest_available_at,
          MAX(dispatched_at) AS last_dispatched_at
   FROM job_outbox
   WHERE topic IN (
     'ingest_zernio_review', 'zernio_initial_backfill', 'generate_response',
     'drain_pending_owner_connect', 'publish_response',
     'update_stripe_overage_quantity', 'stripe_checkout_session_reconcile',
     'account_offboarding_billing_schedule',
     'account_offboarding_reactivation', 'account_offboarding_teardown',
     'account_offboarding_purge'
   )
     AND status IN ('pending', 'dispatching', 'dispatched')
   GROUP BY topic, status
   ORDER BY topic, status;
   ```

   Zero rows is the pass condition. `dispatched` is still in flight even when a
   BullMQ snapshot briefly looks empty. Failed rows must be investigated for a
   scheduled/manual retry before they can be classified terminal.
7. Never delete, promote, discard, or mark complete a delayed veto-window
   `publish_response` merely to make the counters green. Let it execute through
   the normal publisher gate, or use an already-authorized owner veto/cancel
   path before that path is denied. If no safe normal resolution exists, stop
   the cutover and remain in maintenance.
8. After the first zero sample, wait through the outbox recovery interval and
   BullMQ retry/backoff boundary, then capture a second zero sample. Confirm
   from access logs and database timestamps that no denied producer was
   admitted between samples. Record the last account/billing-writer completion,
   last publisher completion, and the UTC time of both zero samples.
9. Only now pause the entire Railway worker. Declare quiescence only after the
   worker is stopped and a final read confirms the producer denials remain in
   force. A paused worker with pending, dispatching, dispatched, delayed,
   prioritized, active, or retry work is **not** quiesced.

Keep these controls in place until the controlled-smoke phase explicitly opens
only the required paths.

## 3. Verify all six new Prices after quiescence

Run with the target environment's securely injected variables:

```bash
pnpm verify:stripe-prices
```

The command retrieves exactly six Prices and exits nonzero for an unset or
duplicate ID, wrong amount/currency/interval/interval-count, inactive Price,
provider failure, or tax mismatch. It consumes only explicitly injected process
environment and never loads `.env.local`. Save the sanitized success output for
launch evidence.

## 4. Drive the provider-wide blocker to zero

The preflight reads `DATABASE_POOL_URL` plus the target Stripe key, all six new
Price variables, and all seven retained old Price variables. The six new IDs
must be nonblank and unique, and the new and retained sets must be disjoint;
duplicates within the retained legacy set are accepted because historical
variables can point at one Price. It manually paginates Stripe subscriptions
with `status=all`, reconciles provider subscription/customer/status data to
accounts, then independently paginates open Checkout Sessions and every
Session's line items. It logs provider/account/subscription/Session/Price
identifiers and counts only; it never logs customer PII or
`client_reference_id`.

Dry-run is the default:

```bash
pnpm ws8:stripe-preflight
```

Only Stripe `canceled` and `incomplete_expired` are terminal/pass statuses.
`incomplete`, `trialing`, `active`, `past_due`, `paused`, and `unpaid` all block
regardless of Price family or database status. Orphaned, unprojected, duplicate,
or disagreeing provider identifiers/projections also block. A status-only
disagreement is reported as `WARN subscription_status_disagreement` with a
typed resolution. `requires_status_applier` means the strict transition table
can move the projected status; `applier_noop_fixed_point` means the provider is
terminal but the single applier intentionally cannot move that local state.
Unrecognized states require manual resolution. Any open Session containing an
old Price blocks even when `client_reference_id` is absent or malformed. The
command consumes only explicitly injected process environment and never loads
`.env.local`.

Manually cancel every nonterminal subscription in Stripe. If any subscription
would need migration instead, stop the cutover: WS8 has no live-subscription
migration path, and proceeding requires a new, separately approved design.

After reviewing the dry-run identifiers, expire old-Price Sessions explicitly:

```bash
pnpm ws8:stripe-preflight --expire-legacy-sessions
```

That is the script's only mutation mode. It calls Stripe's Session-expire API
with a stable per-Session idempotency key; it never cancels subscriptions or
writes the database. Rerun the default dry-run after provider changes and require
`WS8_PREFLIGHT_PASS blockers=0`. Remain quiesced.

## 5. Apply migration 077 and verify expansion/normalization

> **Production status (verified 2026-08-14): 077 is ALREADY APPLIED in prod.**
> For the production run this section is a **verify** step, not an apply step —
> run the introspection below, confirm it passes, and continue to section 6.
> Re-applying is safe if you prefer the belt-and-braces path (077 is written to
> be re-runnable and repairs defaults/CHECK/function/trigger without rewriting
> account or business data), but it is not required.
>
> How this happened: the prod cutover paused on 2026-07-17 with this section
> pending (`docs/runbooks/evidence/2026-07-17-ws8-prod-cutover-evidence.md`
> verified `price_variant` absent at 01:11:05Z). 077 landed after that, and no
> evidence file records it — so **the prod cutover is partially executed through
> this section**. Staging is unaffected: it has 077 and always did.

Apply `supabase/migrations/077_copilot_autopilot_expand.sql` through the normal
approved migration channel. Migration 077 is direct SQL and does not call this
script, Stripe, Redis, TypeScript, or enqueue reconciliation work.

Immediately before applying it, record `SELECT COUNT(*) FROM job_outbox` as the
outbox baseline. No other writer should run during this measurement window.

Verify by direct schema/data introspection rather than the Supabase migration
ledger:

```sql
SELECT COUNT(*) AS incomplete_snapshot_count
FROM accounts
WHERE subscription_tier IS DISTINCT FROM 'copilot'
   OR price_variant IS DISTINCT FROM 'list'
   OR base_price_cents IS DISTINCT FROM 2900
   OR locations_overage_price_cents IS DISTINCT FROM 1500
   OR locations_included IS DISTINCT FROM 1
   OR locations_paid IS DISTINCT FROM 0;

SELECT COUNT(*) AS invalid_business_mirror_count
FROM businesses
WHERE subscription_tier IS DISTINCT FROM 'copilot';

SELECT COUNT(*) AS outbox_count_after_077 FROM job_outbox;

SELECT
  to_regclass('public.accounts_checkout_session_id_uniq') IS NOT NULL
    AS checkout_session_index_present,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.accounts'::regclass
      AND conname = 'accounts_checkout_attempt_complete_check'
  ) AS checkout_lease_constraint_present;
```

The two invalid-row counts must be zero and `outbox_count_after_077` must equal
the recorded baseline exactly. Also introspect the `accounts.price_variant`
column, its `list` default, the named value constraint, the immutable-update
trigger, and the new Copilot defaults. A second application may repair schema
objects but must not overwrite any post-first-apply founding or Autopilot row.
Also require both Checkout lease booleans above to be true. The partial unique
Session index and complete-tuple constraint are launch safety objects: strict
code must not start if either is absent or widened.

## 6. Deploy strict code and run controlled smoke

The two zero-sample drain from section 2 is proof that no old-code queue or
outbox work remains. Deploy and start the **whole strict Railway worker** while
every Vercel writer path and Zernio producer remains denied; this starts its
normal consumers and pollers, not a special Stripe-only process. Once the new
worker is healthy, re-enable Stripe ingress. Do **not** open the smoke allowlist
yet.

Drive each provider-current terminal status through the existing billing
reconciliation or signed-event replay path. Those paths must write status only
through `worker/ingress/stripe/apply-subscription-state.ts`; never repair status
with raw SQL. A real transition must atomically enqueue
`stripe_subscription_mirror_sync`; a resolved no-op `subscription.updated`
replay must enqueue one repair job. Verify the worker converges the deprecated
business status/activation mirror and completes the originating outbox entry.
Canonical status ingress must not update that business mirror synchronously.
Then run the non-mutating convergence gate:

```bash
pnpm ws8:stripe-preflight --require-status-convergence
```

Require the explicit line `WS8_STATUS_CONVERGENCE_PASS blockers=0
actionable_notices=0 ...` before smoke. The command exits nonzero for any
provider blocker or actionable notice. It may pass with recorded
`applier_noop_fixed_point` evidence: specifically, provider
`incomplete_expired` projected from local `pending_payment` or `cancelled`
cannot move to `past_due` under the monotonic applier. By contrast,
`incomplete_expired` from `active`/`trialing` and `canceled` from any stale
recognized non-cancelled state must be replayed/reconciled through the applier
until actionable notices reach zero. Record every remaining safe fixed-point
notice and its provider/current-state evidence.

Record the smoke checkpoint's exact deadline-verification UTC time and
`AUTOPILOT_PURCHASABLE` state, then open only the operator/tester allowlist
through the Vercel maintenance rule. Keep `AUTOPILOT_PURCHASABLE=false` except
for an explicitly recorded staging gate-open smoke after all prerequisites
below are met.

Exercise and record:

- explicit Copilot list/founding Checkout and card-up-front trial selection;
- explicit Autopilot list/founding Checkout only during the authorized staging
  gate-open portion;
- same-tier Checkout retry returns the same provider-open Session;
- exact creating/open retry remains stable after Price-map, tax-flag, owner-email,
  or deployment-URL drift because it uses the frozen lease create tuple;
- Copilot → Autopilot reselection expires the prior open Copilot Session before
  exposing the replacement, while a prior completed Session blocks reselection;
- delayed completion of a superseded Session applies no status/tier/snapshot,
  cancels its unexpected subscription idempotently, and leaves the newer lease
  unchanged;
- non-`active`/`trialing` completion and a non-binding status transition cancel
  and remediate the attempt without status/tier/snapshot mutation, permitting
  explicit reselection;
- successful completion replay skips status/snapshot/cancellation, never cancels
  the bound subscription, and still converges the deprecated tier mirror;
- tier-change preview/execute with stored founder pricing;
- overage item create/update/delete and quantity math;
- provider-current subscription webhook projection and replay;
- settings expansion denial when the Autopilot gate is closed;
- Copilot grant-time `auto_policy` denial;
- publish-time downgrade after entitlement loss.

Use disposable test accounts and the target environment's Stripe mode. Do not
fully reopen public/admin writers during smoke.

## 7. Apply migration 078, then resume

Before applying 078, require both NULL-safe preflight counts to be zero:

```sql
SELECT COUNT(*) FROM accounts
WHERE subscription_tier IS NULL
   OR subscription_tier NOT IN ('copilot', 'autopilot');

SELECT COUNT(*) FROM businesses
WHERE subscription_tier IS NULL
   OR subscription_tier NOT IN ('copilot', 'autopilot');
```

Apply `supabase/migrations/078_copilot_autopilot_contract.sql` through the normal
approved channel. Re-run the NULL-safe checks and introspect both named strict
CHECK constraints plus `NOT NULL` on both mirrors. Then remove the temporary
Vercel maintenance rule, remove the Zernio-ingress denial, restore
`ZERNIO_RECENT_REVIEW_POLL_DISABLED` and `SELF_SERVE_SIGNUP_ENABLED` to their
recorded pre-cutover states, and confirm the already-running strict Railway
worker plus Stripe webhook endpoint remain healthy. Before removing the rule,
record the post-078 checkpoint's exact deadline-verification UTC time and
`AUTOPILOT_PURCHASABLE` state. Record UTC resume time.

After the **production** run of this section, update `.claude/CLAUDE.md` in the
same change: delete the "Standing exception until the prod WS8 cutover"
sentence from "Environments & branches" (078 is no longer absent in prod), and
revise "All autonomy flags are OFF in prod" as the ordered go-live flip
proceeds. Stale entries there are bugs per the doc-hygiene rule.

After staging acceptance, repeat sections 1–7 in production. Do not reuse
staging Price IDs, Stripe mode, database URL, or evidence as production proof.

## 8. Verify migration 105 — the cutover is not finished at 078

> **Production status (verified 2026-08-14): 105 is ALREADY APPLIED in prod.**
> For the production run this is a **verify** step. Run the two queries below
> and confirm the expected values; do not re-apply.
>
> Why it moved out of the sequence: 105's only ordering constraint was the 077
> dependency, and the 2026-08-14 migration lockstep audit found 077 already
> applied in prod (see section 5). With the dependency satisfied, 105 is a
> nullable column plus a CHECK branch that passes trivially on NULL, against a
> table holding zero rows — so it was applied out of band to restore full
> staging↔prod lockstep and shrink the standing exception to **078 alone**.
> The warning below is unchanged in substance and still governs any environment
> that has NOT yet had 105 applied.

**Do not stop at 078.** `supabase/migrations/105_checkout_attempt_coupon.sql`
is the last step of this cutover, not a separate pending migration, and it is
the one most likely to be missed because every other section above is about
077/078.

105 adds `accounts.checkout_attempt_coupon_id` and REPLACES the named CHECK
`accounts_checkout_attempt_complete_check` that 077 created — a constraint whose
body enumerates all nineteen `checkout_attempt_*` columns. It therefore **cannot
be applied where 077 has not been** (it fails outright on the missing columns),
which is exactly why it is sequenced here and was deliberately held out of
production while 077/078 were absent.

**What breaks if you skip it.** The strict code deployed in section 6 writes
`checkout_attempt_coupon_id` on every checkout attempt
(`applyTierSnapshot`, `src/lib/payments/plan-activation.ts`). Without 105 that
column does not exist, so **every** plan selection fails — not only
admin-invited ones. The failure is loud and immediate rather than silent, but it
lands on live traffic the moment you resume, because resume happens in section 7.

Apply it through the normal approved channel, then verify:

```sql
-- 1. the column exists and is nullable
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_name = 'accounts' AND column_name = 'checkout_attempt_coupon_id';

-- 2. the rewritten constraint names the coupon column in its cleared branch
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname = 'accounts_checkout_attempt_complete_check';
```

Expect `is_nullable = YES`, and the constraint definition to contain
`checkout_attempt_coupon_id IS NULL` in the cleared branch. The shape is asserted
by `src/lib/shared/__tests__/migration-105-checkout-attempt-coupon.integration.test.ts`.

Migration **106** (`checkout_coupon_decision` analytics event name) is
independent of this cutover — it does not touch 077's columns and may be applied
at any time. It was applied to production on 2026-08-14, ahead of this cutover.

After 105 is live, the **Beta comp coupon** still does nothing until its own
prerequisites are met, and those are deliberately separate from this runbook:
create the live-mode Stripe coupon, set `BETA_COMP_COUPON_ID`, and clear the
blocking legacy-`onboarded_by` audit in `docs/launch-checklist.md`. See
`docs/runbooks/beta-production-standup.md` Phase F.

## Independent authorization for Autopilot sales

Completing 078 does not authorize `AUTOPILOT_PURCHASABLE=true`. The operations
owner must separately record all of the following in the target environment:

- WS4 and migration 074 are live;
- WS6 and migration 076 are live;
- the WS7 evaluation gate is green;
- cadence limits are documented and accepted;
- `AUTO_APPROVAL_ENABLED=true` is an intentional live setting.

Only then may operations set `AUTOPILOT_PURCHASABLE=true`. Effective
purchasability still composes that flag with `autoApprovalRuntimeEnabled()`;
closing the runtime is the live backstop for new sales and policy expansion.

## Rollback boundaries

- **Before 077:** old code may be restored while both new and old environment
  variable sets remain present. Keep traffic quiesced until the restored binary
  and its assertions are verified.
- **After 077:** old binaries cannot parse the normalized Copilot/list rows.
  Stay quiesced and roll forward or repair the strict code. Do not restore old
  tier data or open a compatibility window.
  > **Production has already crossed this boundary, and it is inert there.**
  > 077 is applied in prod, but prod was truncated to zero tenant rows on
  > 2026-07-16 and still holds 0 accounts / 0 businesses — so 077's first-apply
  > normalization UPDATE touched no rows, and there are no normalized
  > Copilot/list rows for an old binary to fail on. The boundary becomes real
  > the moment prod has its first account.
- **After 078:** recovery requires an explicit forward schema/data repair.
  Reintroducing old-tier rows or old constraints is not an authorized rollback.

When the rollback window closes, remove the seven retained old Price variables
from Railway and Vercel. Keep all six WS8 launch Price IDs in application reverse
lookup for as long as any Stripe subscription can reference them.
