# Deviations — #1011, the `outreach_withheld` render lane

Plan: `docs/superpowers/plans/feat-1011-refusal-outreach-render-plan.md`.
Intake: `docs/superpowers/plans/feat-1011-refusal-outreach-render-intake.json`.

---

## D1 — the `solicitation_outreach.rendered_at` reader audit (REQUIRED by plan §0)

The plan's §0 owner decision moves `rendered_at` from **persist time** (minted
inside `persistChildRender`'s transaction, after the per-Business advisory lock
had been waited on) to **decision time** (read where `generateChildRender`
returns, before the transaction opens). The plan requires every reader of that
column to be audited BEFORE the value moves, and a reader that depends on it
meaning persist time to STOP the work.

Method: `rg -n "rendered_at|renderedAt" src worker supabase e2e scripts docs -g '!**/__tests__/**'`
at the branch's base, then read each hit in place. Doc hits and this branch's
own plan/intake are excluded below; every production and schema hit is listed.

| # | Reader | What it needs from the column | Survives the move? |
|---|---|---|---|
| 1 | `worker/background/pollers/ArchivalPoller.ts:307-333` — the never-sent-terminal arm of body redaction | An AGE clock for rows with no `sent_at`, compared against `NOW() - BODY_RETENTION_DAYS` (90 days), plus `NOT NULL` and never-updated | **Yes.** The move shifts the value EARLIER by the advisory-lock wait — milliseconds to seconds against a 90-day window. `NOT NULL` and immutability are unchanged. The rule the poller's own comment states ("the moment the copy came into existence") is *better* served by decision time, not worse. |
| 2 | `scripts/ci/tenant-scope-allowlist.ts:972` | A byte-identical copy of #1's SQL for the audit allowlist | **Yes.** No SQL changes in this branch, so the snippet stays matched. |
| 3 | `src/lib/solicitation/batch-view.ts:492` — `o.rendered_at::text AS "renderedAt"` in the owner batch payload | A displayable per-attempt timestamp | **Yes.** It is projected and passed through (`:333`), never compared against a write clock or used to derive anything. Decision time is the more accurate thing to show an owner. |
| 4 | `src/lib/solicitation/batch-view.ts:511` — `ORDER BY o.rendered_at, o.id` | A stable ordering of a batch's attempts | **Yes.** Children generate SEQUENTIALLY, so decision order equals persist order. The one case where several rows now share ONE instant — `settleBudgetStop`, which reads the clock once when the budget exception decides the remaining rows — falls through to the `o.id` tiebreak, and `insertOutreachRender` mints UUIDv7 (time-ordered), so the order is still insertion order. |
| 5 | `src/lib/solicitation/release.ts:1642-1657` (`selectRenderedOutreach`) — `ORDER BY o.rendered_at ASC`, no tiebreak | Oldest-first release ordering within one approved batch | **Yes**, and the shared-instant case cannot reach it: the query filters `delivery_status = 'rendered'`, while the only rows that now share ONE instant are `withheld` (`settleBudgetStop`'s settled rows and `settleGenerationExhaustion`'s fills). Genuinely rendered children are generated sequentially and each reads its own clock, so no two `rendered` rows tie. |
| 6 | `supabase/migrations/092_terminal_outreach_body_redaction.sql:50-110` — `idx_solicitation_outreach_rendered_at_redaction` | An indexable `TIMESTAMPTZ` column feeding #1 | **Yes.** Index definition untouched; only the values written change. |
| 7 | `supabase/migrations/091_send_mode_spine_lifecycle.sql:210` — `rendered_at TIMESTAMPTZ NOT NULL` | `NOT NULL` | **Yes.** The value is still always supplied by the writer; no CHECK in 091 relates `rendered_at` to `created_at`, `sent_at` or any other column. |

**Result: no reader depends on `rendered_at` meaning persist time.** The audit
found no blocker and the work continued. Every reader wants one of three things
— an age, a display value, or an ordering — and all three are preserved or
improved. Recorded per plan §0; the intake invariant that a persist-time reader
"stops the work" was never triggered.

**Verdict:** ACCEPT. This is the deliverable §0 asked for and it is evidenced
reader by reader rather than summarised. The method is stated and repeatable,
and the two ORDERING readers — the ones that could actually break — are argued
from the data rather than waved through. Rows 4 and 5 carry the real finding:
reading the clock ONCE for a multi-row settle gives several rows one instant,
which an untiebroken `ORDER BY rendered_at` would scramble. `batch-view` survives
on its `o.id` tiebreak with UUIDv7's time ordering; `release.ts` has no tiebreak
and survives only because its `delivery_status = 'rendered'` filter excludes
every shared-instant row, all of which are `withheld`. That is a genuine
near-miss identified and closed, not an absence of risk.

**Standing consequence, recorded because it is not obvious from the code:** a
future writer that gives several `rendered` rows one shared instant breaks
`selectRenderedOutreach`'s ordering silently. The protection is the `withheld`
filter, not the clock.

---

## D0 — RED-TEAM P0: the branch's central property was pinned for ONE writer of four

**Found by the red-team pass, not by three plan rounds and not by the
spec-correctness axis.** Both of those examined whether the clock is read in the
right PLACE. Neither asked whether a test would NOTICE if it moved.

**The defect.** This branch exists to move the render clock ahead of the
transaction and the advisory-lock wait, so `rendered_at` and
`refusal_events.occurred_at` are decision time. Red team moved `regenerateAsk`'s
(`ask-generation.ts:1543`) and `settleGenerationExhaustion`'s (`:1752`)
`decidedAt` reads back inside their transactions — **the exact design the owner
rejected** — and all 23 titles stayed green. Both mutations were confirmed
executed and non-equivalent.

**Why the existing coverage could not see it.** The one position-measuring case
drives `generateAsksForBatch`, which reaches `persistChildRender` and
`settleBudgetStop` only. `regenerateAsk` and `settleGenerationExhaustion` are
separate exported entry points. And the column-equality titles CANNOT substitute:
when the clock moves, `rendered_at` and `occurred_at` move TOGETHER, so their
equality stays true. That is the trap — the branch's most-repeated assertion is
structurally incapable of catching the branch's own central regression.

**The fix.** Two titles, added to `tests_to_add` and to
`ask-generation.integration.test.ts` on the existing `holdBatchAdvisoryLock`
precedent, driving `regenerateAsk` and `settleGenerationExhaustion` directly:

* `a regeneration never stamps occurred_at from the swap transaction, so a slow lock does not move the decision time`
* `a generation exhaustion never stamps occurred_at from the settlement transaction, so a slow lock does not move the decision time`

**Verified by re-planting the mutation, which is the only evidence that counts
here.** Clean HEAD 21/21 green. Moving `regenerateAsk`'s read after
`acquireSolicitationBatchLock` → RED, exactly one failure, the new title, ~303 ms
over bound; the other 20 including every column-equality title stayed GREEN,
which reproduces the original blindness exactly. Same for
`settleGenerationExhaustion`, ~302 ms over. Restored → 21/21.

**One tuning detail worth keeping.** The discriminator binds to the MIDPOINT of
the advisory-lock hold, not its end. At the end-of-hold bound both mutations
failed by only ~4 ms — real, but too thin to trust on a loaded runner. The
midpoint clears in both directions by ~300 ms.

**No production change.** `ask-generation.ts` is byte-identical to HEAD; the
clock positions were always correct and only the eval was blind.

**Verdict:** ACCEPT — P0 closed, with the mutation re-planted to prove the close.

## D0b — RED-TEAM ROUND 2: the P0 is closed, and the fix exposed a P1 beside it

Round 2 was scoped to D0's fix hunks. **Round 1's P0 is confirmed closed** — both
re-planted mutations die independently of the implementer's report (regeneration
post-lock by 303 ms, exhaustion post-lock by 304 ms), verified from round 1's own
mutant files, and `ask-generation.ts` is the same blob at both SHAs, so no
production change rode along with a test-only fix.

### P1 — the ONE position title the fix did not touch had a 6 ms kill margin

D0 chose the midpoint bound for the two NEW titles because the end-of-hold bound
was too thin. **It did not go back and apply that reasoning to the existing
W1/W2 title**, which kept `lockHeldAt + HOLD_MS`. Red team measured its margin at
**6 ms**.

The mechanism matters: `holdBatchAdvisoryLock` signals `acquired` BEFORE starting
its timer, so a post-lock clock read lands just under the bound. On a loaded
runner the mutant slips beneath it and the case **FALSE-PASSES silently** — it
does not go red and flake, it goes green and lies.

**Fix:** the same `HOLD_MS / 2` midpoint the two new titles already used, with
the mechanism written at the assertion so it is not "simplified" back. All three
position cases pass.

**The lesson, recorded because it is the second time this shape appeared:** a fix
that introduces a better technique must be applied to the case that motivated it,
not only to the new cases beside it. D0 improved the bound and left the original
weaker than the two it spawned.

### P2 — the discriminator is one-sided

A clock read moved EARLIER — to function entry, ahead of the whole LLM round
trip — survives. No lower bound exists anywhere in the repo for this property.

**Verdict: ACCEPT as recorded, no action.** The unsafe direction is the one
trapped: reading late is the regression this branch exists to prevent, and
reading absurdly early is not a failure mode any code path produces. A lower
bound would pin a number nothing threatens.

### P2 — coverage binds to the lock, not the transaction

A read placed inside `sql.begin` but ABOVE the lock acquisition survives.

**Verdict: ACCEPT as recorded, no action**, on the arbiter's reasoning: the
unsafe direction stays trapped. The property that matters is "before the lock
wait", and that is what is pinned.

### Probes that came back clean

The midpoint bound is balanced (~300 ms in both directions) and survived 24
spinners on 12 cores — not flaky. The two-hole claim for
`settleGenerationExhaustion` HOLDS: a first hole correct with later holes
drifting still dies, by 326 ms. Every doc claim re-resolved true.

**Verdict on the round: ACCEPT.** P0 closed and re-proved, P1 fixed, two P2s
recorded with reasons. Round 2 is the cap; nothing follows it.

## D2 — negative titles cannot be RED before the writers exist

Six of the intake's twenty-three titles assert that **nothing** is written (the
two "successful render writes no row" titles, the four guard titles) and two
more assert the kill switch writes nothing. Those eight are vacuously green in
T1's RED phase, because there is no writer yet to write the row they forbid.
They become load-bearing the moment T2–T5 land the writers, and each was
re-confirmed green after every tracer rather than only at the end.

The fifteen titles that assert a write were RED at T1 as required: 5 of 9 in the
unit seam and 10 of 14 in the live-DB seam.

**Verdict:** ACCEPT, on the same reasoning as #1012's D1 — an absence assertion
cannot fail before the thing it forbids can exist, and demanding a RED phase for
one is demanding a broken test. Two details make this the stronger write-up: the
counts are measured and split by seam, and the eight were **re-confirmed green
after every tracer** rather than only at the end, which is what turns a vacuous
title into a live regression pin. 15 of 23 genuinely red→green is the honest
number.

---

## D3 — W2 lands with W1, because they are ONE call site

The plan's §0.2 records that there are **three physical ledger call sites, not
four**: `settleBudgetStop` settles its rows through `persistChildRender`. So the
code for W2 necessarily lands in T2 with W1 — a `decidedAt` parameter cannot be
added to `persistChildRender` for one caller and not the other. The T3 tracer
still owns W2's EVIDENCE (the multi-row "one Refusal per outreach" title), which
is what the plan's tracer split is actually protecting.

**Verdict:** ACCEPT. The plan's own §0.2 records the three-call-site count, so
this is the plan being followed rather than departed from — a `decidedAt`
parameter cannot reach `persistChildRender` for one caller and not the other.
The distinction that matters is preserved: the CODE moves to T2, the EVIDENCE
stays in T3, and the multi-row fixture is the whole reason review added that
title.

---

## D4 — the vocabulary module is mocked in the live-DB suite

`src/lib/solicitation/__tests__/ask-generation.integration.test.ts` now mocks
`@/lib/refusals/vocabulary`, deriving the stand-in map from the real one inside
the factory. This is the
`src/lib/auto-approval/__tests__/suspension.integration.test.ts` precedent named
by plan §5, and it exists so the two forced-failure titles can raise a REAL
`23514` out of the REAL helper inside the REAL persist transaction. Every other
title in that file runs against the production map.

**Verdict:** ACCEPT. The mock is on the VOCABULARY, not on the helper or the
transaction, so what the forced-failure titles exercise is still the real INSERT
hitting a real CHECK — which is the property plan §5 demanded and a mocked
rejection cannot give. Deriving the stand-in from the real map inside the factory
keeps it from drifting into a fixture that tests nothing. The blast radius is
stated and narrow: two titles, one file.

---

## D5 — the rollback twin needs a `Sql` wrapper, not a mocked rejection

Plan §5's success-then-rollback twin requires a transaction that writes a valid
Refusal and THEN aborts for a reason unrelated to the ledger. Unlike
`suspendAccountAutonomy` — which the suspension suite can call from inside its
own `sql.begin` — all three render call sites open their own transactions from a
`Sql` they receive as a parameter (invariant #15), so there is no outer
transaction for a test to abort.

`abortAfterLedgerWrite` (live-DB suite) is a `Proxy` over the real `Sql` whose
`begin` runs the caller's callback, reads the ledger count **on that same `tx`**,
and throws when a Refusal is visible. It is not a mocked rejection: the helper,
the INSERT and the transaction are all real, and reading inside the transaction
is what makes the assertion discriminate a helper that opened its own connection
(whose row would already be committed) from one that used the caller's.

**Verdict:** ACCEPT, and the in-transaction read is the part that earns it. The
suspension precedent could abort from an outer `sql.begin`; these three call
sites own their transactions (invariant #15 requires the `Sql` be a parameter),
so there is no outer scope to abort from and the precedent does not transfer
directly. Reading the ledger count on the SAME `tx` before throwing is what makes
this a real discriminator rather than a rearranged mock: a helper that opened its
own connection would have committed a row the caller's transaction cannot see,
and the twin would fail. That is the invariant #15 hole review found on two of
the three branches, closed here by construction.
