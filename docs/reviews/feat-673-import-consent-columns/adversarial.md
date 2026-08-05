# Adversarial approach review (codex) — feat-673-import-consent-columns

Runner: codex companion thread `019fd355-e207-74a2-a75b-94a7fa92641e`, base `44e5a62f`.
Codex verdict: **needs-attention** (approach challenge; line-level axes reviewed separately).

## Findings (verbatim substance) + orchestrator triage

### F1 [high] — "The expand/contract protocol has no safe version-skew window"
Code-before-schema 42703s; schema-before-code or a later revert lets the old
worker complete runs writing only legacy counters, leaving collapsed columns at
DEFAULT 0; #680 would then drop the only correct values. Recommends: migration
applied + introspected before either worker deploy; #680 reconciles collapsed
from legacy and aborts on mismatch.

**TRIAGE: REJECT as a blocker for this PR.** The repo's standing promotion rule
already orders migration-before-code (099's migrations-log entry documents the
42703 class and the ship lane applies the migration to each env BEFORE the code
reaches it); both environments hold zero `businesses`/`zernio_backfill_runs`
rows (§8a R3, staging reset 2026-08-05); the worker is single-replica, so there
is no mixed-fleet window. The valid kernel — **#680 must run a reconciliation
preflight before dropping** — is ACCEPTED as a constraint posted on #680 and
recorded in the migrations-log 100 entry (D7).

### F2 [high] — "Dual-write-until-#680 paints #675 into contradictory semantics"
After #675 replaces selection with newest-100/12-month there is no truthful
gap/historical decomposition to dual-write; the locked "dual-write until #680"
invariant would force #675 to preserve the obsolete algorithm or fabricate
bucket values.

**TRIAGE: ACCEPT (wording/contract — no code change).** The finding is correct
that the CONTRACT was over-scoped; the CODE this PR ships is right under the
corrected contract. Fixed in the migration COMMENT, migrations-log 100 entry,
and intake invariant 3 (D7): the legacy writer contract ends at #675 (legacy
counters freeze at DEFAULT 0 for new runs); legacy columns stay until #680;
#680's DROP requires the reconciliation preflight (collapsed = legacy sums on
pre-#675 rows). Whether #675 records a run-semantics discriminator is #675's
design decision — posted there as a constraint.

### F3 [medium] — "A businesses row is not yet a durable, serialized consent identity"
(a) Uniqueness only blocks duplicate ACTIVE `(account_id, google_place_id)`
rows, so archive → re-add can mint a fresh row whose `import_decision` resets
to DEFAULT `'pending'`, circumventing a permanent decline (D8). (b) #677
acceptance and #679 expiry will race on the mutable row without an atomic
transition contract.

**TRIAGE: REJECT for this PR; ACCEPT as constraints on #676/#677/#679.**
Additive, entirely-unwritten columns foreclose neither a side table nor any
transition contract — nothing reads or writes them until those tickets. The
transition contract was deliberately deferred by the signed intake (enum CHECK
only — owner decision 2026-08-05). The archive→re-add loophole is real but is a
property of the future consent GATE (#676) and offer creation (#677), not of
this schema: posted as a constraint there (gate/offer logic must treat a fresh
row for a place with a declined/expired sibling as declined, or add-location
must reactivate the archived row). Flagged to the owner in the step-7 summary
because it grazes the map-level "columns on businesses" decision.

## Disposition
No approach change to this branch. One wording amendment (D7), three follow-up
constraint comments (#675, #680, #677 — cc #676/#679).
