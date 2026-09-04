# Handoff — feat/stripe-customer-redaction

Rewritten 2026-09-03 at the round-2 → fix boundary.
Resume with `/feature-resume feat/stripe-customer-redaction`.

**You are picking up a branch that is code-complete, gate-green at the previous
commit, and blocked by three red-team P0s.** Owner decision 2026-09-03: **fix
all three, re-run the gate, and do NOT run a third red-team round.** The
two-round cap is spent by design.

## Artifacts, by path

| What | Path |
|---|---|
| Locked intake (audit copy) | `docs/superpowers/plans/feat-stripe-customer-redaction-intake.json` |
| Arming copy (byte-identical) | `.feature/intake.json` |
| Plan, D1–D10 | `docs/superpowers/plans/feat-stripe-customer-redaction-plan.md` |
| Deviations D1–D7, all ACCEPT | `docs/superpowers/plans/feat-stripe-customer-redaction-deviations.md` |
| Review wave, 5 axes | `docs/reviews/feat-stripe-customer-redaction/` |
| Red team round 1 | `docs/reviews/red-team/feat-stripe-customer-redaction-17cab2/findings-round-1.md` |
| **Red team round 2 — read this first** | `docs/reviews/red-team/feat-stripe-customer-redaction-17cab2/findings.md` |
| Machine state | `.feature/state.json` |

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-stripe-customer-redaction`

## State

- Phase `gate_green`, recorded at `02bb7700`. HEAD has since moved to the
  round-2 report commit, so **the gate is stale against HEAD** — expected, and
  the first thing the stop hook will tell you.
- 0 behind `origin/main`. Working tree clean.
- Plan review rounds 3 of 3, exhausted. Red-team rounds **2 of 2, exhausted.**
- Surface amendment 4, at fourteen files, every addition owner-approved.
- `red-team-status.mjs` reports `OPEN_P0` and blocks the `reviewed` transition.

## THE THREE P0s TO FIX

Full evidence is in the round-2 `findings.md`. Summarised so you fix the right
thing, not a paraphrase of it.

### R03 — the guard predicate reopens the hazard D1 exists to prevent

`worker/jobs/account-offboarding/purge-stages.ts`, the sharing count in
`runStripeCustomerRedactionPurgeStage`.

The predicate excludes siblings on `ao.mode = 'delete_data' AND ao.status IN
('purge_scheduled', 'purged')`. It keys on **status**. The property it actually
needs is "past the point of no return", which this branch's own D5 argument
names as **`purge_started_at`**.

Intersect the guard's exclusion set with `keep-my-data.ts:197`'s admission set
and what remains is `status = 'purge_scheduled' AND purge_started_at IS NULL` —
the entire purge grace window. Account A's purge therefore redacts a shared
Stripe Customer while co-tenant B can still click "Keep my data" and stay a
paying customer, with B's billing contact destroyed and nothing recorded
against B.

Second defect in the same predicate: a terminally-`failed` sibling IS past the
point of no return and is NOT excluded, so the both-siblings-skip case survives
one status over.

**The fix, verified by the reviewer to close both:**

```
AND ao.purge_started_at IS NOT NULL
AND ao.purge_cancelled_at IS NULL
```

**It shipped because the predicate has NO BEHAVIOURAL TEST** — only a
byte-for-byte `tenant-scope-allowlist.ts` string, which tracks the SQL and
proves nothing about meaning. **Write that test.** It is the finding under the
finding, and without it the next predicate change is equally unprotected.

Changing this SQL will invalidate BOTH `tenant-scope-allowlist.ts` snippets
again (they are text-keyed). Re-pin them; `pnpm ci:tenant-scope` names them.

### R01 — `CONTEXT.md` LOCKED terms still assert the repudiated world

`CONTEXT.md:170-171`, § "Stripe Customer redaction".

The fix pass corrected three false sentences in the CODE docblocks and left the
identical claims standing in the authoritative domain model. All three are now
contradicted verbatim by the docblocks this branch wrote:

1. "It runs LATE (D5) … running first would leave a live account whose billing
   contact is wiped" — D5 is INVERTED; redaction runs FIRST. See deviation D6.
2. "the stage takes the binding lock ALONE" — false; the disposition append
   takes an exclusive `account_offboardings` row lock while it is held.
3. "the receipt and privacy policy are both written from it" — false; neither
   imports `PROVIDER_DATA_RETENTION`.

### R02 — four `docs/directory.md` rows made false by this pass

`:1684` "in one predicate" (now two equality arms under UNION ALL); `:1650` the
stage order, "runs LATE by D5", and "the worker resolves getStripe()" (now a
factory); `:1267` "(retrieve + update only)" (now also `paymentMethods`);
`:1725` omits `checkStaleIgnoredInboundEvents`.

`ci:directory-map` checks row COMPLETENESS, never truth. A green gate says
nothing here.

## The six P1s — adjudicate, do not assume

`red-team-status.mjs` blocks on each until it is fixed or recorded as
`accepted-risk` with owner authorization. Two are substantive:

- **R04** — `detachPaymentMethods` declares `has_more` and never reads it, while
  `stripe-invoices.ts` in the same directory paginates and throws
  `bounded_pagination_exhausted`. Returning `redacted` finalizes the purge and
  tombstones the id, and `isAlreadyRedacted` then blocks any retry: silent,
  permanent partial erasure past 100 attached methods.
- **R05** — round 1's F04 is NOT closed. `beta-launch-alerting.md` is untouched
  by this branch, and the acked-for-age warning carries
  `feature:stripe_subscription_out_of_order` with no `subsystem` tag, matching
  zero rules. The fix pass answered that finding with a different signal (the
  health probe) and left the runbook gap open.
- **R06** — the events arm was split in two but the saturation check
  (`eventsCount >= 5000`) was not, so it miss-fires across `[5000, 9999]`.
- **R09** — deviation D6's stated reason for dropping the receipt's erasure
  clause ("the template has no outcome data to condition on") is FALSE:
  `retained_suppression_count` is already snapshotted into the same
  `purge_receipt` payload in the same finalize transaction. **The decision may
  stand; the recorded reason must not.** Correct D6.

## What survived round 2, so you do not re-verify it

- All six mutations this session claimed died, died again independently:
  `ackedForAge = false`, `.every → .some`, dropping `event_id`, detach ordering,
  the `resource_missing` continue, and the stage reorder.
- The D5 inversion HOLDS. Every writer of `purge_cancelled_at` was checked.
- The ArchivalPoller index fix verified by the reviewer's own `EXPLAIN`.
- `processed_at` is the right window column for the new probe.
- A repo-wide hunt for sibling `IN`-list index bugs found none.

## Order of work

1. Fix R03 **with its behavioural test**, then R01, then R02.
2. Adjudicate the six P1s: fix, or record `accepted-risk` with owner
   authorization. R04 and R05 deserve fixing.
3. `bash scripts/verify-gate.sh` — and **export BOTH URLs first**, or the
   autopilot integration row fails `ECONNREFUSED`:
   ```
   export TEST_DATABASE_POOL_URL="$(grep -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2- | tr -d '"')"
   export DATABASE_POOL_URL="$TEST_DATABASE_POOL_URL"
   ```
   That gap is a `verify-gate.sh` defect, recorded as a follow-up, NOT a branch
   defect.
4. **No third red-team round** — owner decision. Record in the deviations that
   the round-2 fixes therefore ship without an adversarial pass, because that
   gap is real and the next reader deserves to know it.
5. Then the `reviewed` transition, staging, and PR. RISK is high, so this rides
   `staging` before `main`. Pause for explicit merge approval.

## What this branch has taught, twice

Read deviation D7 before you start. The short version:

- **Three separate defects came from confident comments.** "ONE predicate, not a
  second query" cost the archival sweep its index. "Every local destruction has
  committed" was the false premise under D5. "Requests no other lock" was untrue.
  Prose that reads like a design rule is where the defects have been hiding.
- **A green gate proves little about test QUALITY.** 14,805 tests passed over a
  tree where `ackedForAge = false` killed nothing.
- **Each round's fixes contained the next round's P0.** Round 1's P0 was a stale
  stub; round 2's P0 is the fix for round 1's guard finding. There is no round 3,
  so R03's fix will ship unattacked — which is exactly why it needs its
  behavioural test rather than another allowlist string.
