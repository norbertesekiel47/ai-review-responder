# Plan review round 2 — triage verdicts (#656)

Full report: `plan-review-round2-codex.md`. Verdict: **REVISE**.
Reviewer: `codex exec`, read-only sandbox, **verification-only** brief.
Round 2 of max 3 (`planReviewRounds=2`).

Round 2 confirmed **7 of 11** round-1 findings fully ADDRESSED, all **4**
miscitations corrected, and all **12** new cited artifacts present. It returned
four defects introduced by the fixes. Every factual claim below was
**independently re-verified against code or against the live test database**
before triage — round 1's lesson was that a reviewer's citation is a hypothesis,
not a fact.

## Round-1 findings: verification outcome

| # | Round-2 status | Triage |
|---|---|---|
| 1, 2, 4, 6, 7, 9, 11 | ADDRESSED | Accepted as verified. No action. |
| 3 | PARTIALLY ADDRESSED | → defect 1 below. |
| 5 | PARTIALLY ADDRESSED | → defect 2 below. |
| 8 | PARTIALLY ADDRESSED | → defect 3 below. |
| 10 | **NOT ADDRESSED** | **ACCEPT.** Verified: `A && B && echo OK \|\| echo STOP` exits **0** on the failure branch because `echo` succeeds — it reports a failure without being one. Rewritten as two guarded statements with explicit `exit 1`. |

## Defects introduced by a fix

| # | Sev | Verdict | Note |
|---|---|---|---|
| 1 | Critical | **PARTIAL ACCEPT — fact accepted, remedy rejected** | See below. |
| 2 | High | **ACCEPT** | Verified in code: `isFullBlockState` returns true for `mode === 'delete_data'` at **any** status (`src/lib/account-offboarding/gate.ts:212-215`), and confirming offboarding does not itself cancel the subscription — Stripe is the source of truth and cancellation is a separate async step. So a `delete_data/pending` account is still `active`, passes `assertSubscriptionAllowsOwnerScope`, and could edit its sender address mid-teardown. My "Design decisions #2" claim that the subscription gate covers offboarding was **false**. T4 now calls `getOffboardingState` + `isOperationalUIBlocked` explicitly, before the body parse — the same shape the cited draft route uses at `:103-106`. |
| 3 | High | **ACCEPT** | Verified: the shared `beforeAll` fixture (`batch-builder.integration.test.ts:365-374`) inserts no postal address, and the flag-on test at `:508` asserts exactly one generation row. Under the new gate that build is withheld → zero rows → red. I had checked that suite's *result-shape* matchers (`toMatchObject`, safe) and missed that the breakage is in its **enqueue** assertion. Added as the third fixture repair in T6 Step 5. |
| 4 | Low | **ACCEPT** | Verified against the live test DB: `SELECT proname, provolatile FROM pg_proc` returns `convert_to \| s` (STABLE), `encode \| i`, `sha256 \| i`. The migration comment claiming all three IMMUTABLE was wrong. Corrected, with the reason it is nonetheless sound in a CHECK, and an explicit "do not copy this into an index" warning. |

## Defect 1 — fact accepted, suggested remedy rejected

**The fact is real and was reproduced**, not merely reasoned about. Against the
live test DB, with both CHECKs in place:

```
INSERT … addr='123 Main St', at_ts='2020-01-01', digest=sha256('123 Main St')  -- OK
UPDATE … SET addr='999 Other Rd',
             digest=encode(sha256(convert_to('999 Other Rd','UTF8')),'hex')     -- ACCEPTED
SELECT addr, at_ts  →  999 Other Rd | 2020-01-01
```

A 2020 attestation standing over 2026 bytes, satisfying both constraints. The
plan's claim that "no writer can edit the address while leaving an older
attestation standing" is therefore **overclaimed** and must be narrowed.

The same run also confirms the fix does what it was added for: an address-**only**
UPDATE is rejected by `businesses_solicitation_postal_address_digest`, and both
constraints create cleanly despite `convert_to` being STABLE.

**The suggested remedy — "add an OLD/NEW enforcement boundary" — is rejected as
written.** A CHECK constraint cannot see `OLD`; that is a `BEFORE UPDATE` TRIGGER,
which the plan deliberately does not use. Two variants were considered and both
fail: widening the digest to cover the whole tuple still lets a writer recompute
over `(new address, old attested_at)`, and a GENERATED column would make the
digest derived and delete the constraint's value entirely. There is no
CHECK-only formulation that closes it.

**What the digest CHECK actually guarantees**, stated precisely so the plan can
say it honestly: *no writer can change the stored address without also
recomputing sha256 of the new bytes.* That closes the **accidental** path — the
future `UPDATE businesses SET solicitation_postal_address = $1` in some import
or admin path that forgets the attestation, which is the defect this feature
exists to prevent. The residual path requires a writer to lift the digest
expression out of the migration and deliberately preserve a stale timestamp.
That is forgery, not an oversight, and a forger could equally stamp a fresh
`attested_at` — so a trigger buys little against the adversary it would be
built for.

**Escalated to the owner** rather than decided here: this is a compliance-record
invariant on a `RISK=high` branch, and choosing between "accept the residual and
narrow the claim" and "add the trigger and make the invariant total" is a real
tradeoff with different work attached (a trigger adds a new mechanism class to
`businesses`, its own tests, and at least one more promised test title). See the
session's owner question.

## Consequence for the intake — owner decision required

Fixing defect 2 properly requires a promised test that does not exist in intake
v2: the route must refuse a write for an account whose offboarding is
operationally blocked. That is a **47th** `tests_to_add` title.

This is a **test-list widening, not a surface amendment** — `allowed_edit_surface`
is untouched, so the amendment budget stays at #1 of 2. But it is still an
intake re-issue, and a botched intake edit is precisely what the round-1
post-mortem was written about: both copies must move together and the ARMING
copy must be re-verified with `feature-setup.sh`, never just the committed one.

## Scope discipline

The round-2 brief forbade opening new fronts against unchanged plan sections.
The reviewer honoured it: every finding it raised traces to a specific round-1
fix. No out-of-scope findings were submitted, and none were rejected on scope
grounds.
