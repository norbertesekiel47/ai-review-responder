# Spec & correctness review — feat/1011-refusal-outreach-render

Base `06a163f0` → head `535e0763`. Read-only; no commands that change state, no test run.
Every line number below was resolved at `535e0763`.

## Findings (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| LOW | `src/lib/solicitation/release.ts:1654` | `selectRenderedOutreach` orders on `rendered_at ASC` with no tiebreak; this change makes a shared `rendered_at` instant a real shape in the table, and the query's correctness now rests on an unenforced convention (only `withheld` rows share one) that nothing in code or schema holds. `, o.id` costs nothing. |

## Attack-by-attack record

### 1. Independent re-do of the D1 reader audit — D1 is COMPLETE and each verdict is right

Method: `rg -n "rendered_at|renderedAt" src worker supabase e2e scripts` (tests excluded, as
D1 states), then read every hit in place; separately enumerated every SQL statement touching
`solicitation_outreach` across `src`, `worker`, `scripts`, `e2e` to catch a `SELECT *` that
would surface the column without naming it.

Non-test hits, exhaustively:

| hit | D1 row | independent verdict |
|---|---|---|
| `worker/background/pollers/ArchivalPoller.ts:307-334` | #1 | Age clock vs a 90-day window. Survives. Its own comment ("the moment the body and its inputs came into existence") is now MORE accurate for W1/W3 — the clock is read after `generateChildRender` returns — and vacuous for W2/W4, whose rows are bodyless (`renderedSubject/renderedBody: null`, `interpolationInputs: {}`). |
| `scripts/ci/tenant-scope-allowlist.ts:972` | #2 | Byte-identical SQL snippet; no SQL changed. Survives. |
| `src/lib/solicitation/batch-view.ts:492` | #3 | Projected as `::text`, passed through at `:333`, never compared. Survives. |
| `src/lib/solicitation/batch-view.ts:511` | #4 | `ORDER BY o.rendered_at, o.id`. Survives — see §2. |
| `src/lib/solicitation/release.ts:1654` | #5 | `ORDER BY o.rendered_at ASC`, no tiebreak. Survives on the `delivery_status = 'rendered'` filter — see §2 and the finding above. |
| `supabase/migrations/092_…:50-110` | #6 | Index definition, values only. Survives. |
| `supabase/migrations/091_…:210` | #7 | `NOT NULL` only. Survives. |

No `SELECT *` / `o.*` reader of the table exists, so no eighth reader is hiding behind a
wildcard. `src/lib/solicitation/outreach.ts:550,598,606` are the WRITER (`insertOutreachRender`)
and correctly not in a reader list.

Two things D1 did not check and that I checked, both clean:

* **No CHECK constraint anywhere relates `rendered_at` to another column.** `rendered_at`
  appears in `supabase/migrations/` only at `091:210` (`NOT NULL`) and inside 092's index +
  comments. The move cannot violate a constraint.
* **`rendered_at` now always precedes the row's own `created_at`** (`DEFAULT NOW()` =
  transaction start, and the clock is read before the transaction opens). Grepped: no
  production code reads `solicitation_outreach.created_at` at all, so the new inversion is
  unobserved. It is observed only inside this branch's own integration test, deliberately
  (`r.created_at = o.created_at` as a same-transaction proof).

Docs sweep: `docs/adr/0023-refusal-log-owner-safe-projection.md:181,199-206` states the rule as
"`ask-generation.ts` passes `rendered_at`" — still literally true after the move, and the ADR
never characterises `rendered_at` as persist time. `CONTEXT.md:70`,
`.claude/reference/migrations-log.md:48,2109-2111` and
`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:329` all describe it as
"NOT NULL, never updated, the age clock" — all still true. **No documentation was falsified by
the move.**

### 2. The shared-instant hazard — both D1 claims verified, and no `rendered` row can tie

Established by reading the code, not by trusting D1:

* `settleBudgetStop` (`ask-generation.ts:928`) builds every settled row from
  `renderFailedOutcome(...)`, and `renderFailedOutcome` (`:422-436`) hard-codes
  `status: 'withheld'`. Every row it shares one instant with is `withheld`.
* `settleGenerationExhaustion` (`:1817-1836`) hard-codes `deliveryStatus: 'withheld'` on every
  fill.
* `generateAsksForBatch` (`:1197`) and `regenerateAsk` (`:1543`) each read the clock ONCE PER
  ROW. They are the only two writers that can produce a `rendered` row.

So: **there is no path where a `rendered` row shares an instant with another `rendered` row.**
`release.ts`'s untiebroken ORDER BY is safe today for exactly the reason D1 gives — the filter,
not the clock. `batch-view`'s `o.id` tiebreak is real (`insertOutreachRender` mints UUIDv7 per
insert, `outreach.ts:589-591`), and its `delivery_status <> 'cancelled'` filter does not exclude
the shared-instant rows, so the tiebreak is what carries it. Both D1 verdicts stand.

Residual, and the reason for the one LOW: `release.ts:1654`'s safety is a property of the data
distribution, not of the query. D1 and `arch-review-log.md` both record this as a "standing
consequence" for a future author to remember. A tiebreak converts a remembered convention into a
structural guarantee for one token.

*Not a finding, recorded for completeness:* a millisecond collision between two consecutive
`rendered` children is theoretically possible (`Date` is ms-resolution and the intervening work
is a probe + a transaction). This hazard is unchanged by the branch — the pre-image called
`new Date()` per row too, inside the transaction — so it is neither introduced nor worsened here.

### 3. Is the clock read before the lock? Yes, at all four writers

| writer | clock read | first `sql.begin` | `acquireSolicitationBatchLock` |
|---|---|---|---|
| W1 `persistChildRender` | caller, `:1197` | `:789` | `:797` |
| W2 `settleBudgetStop` | `:925`, before the loop | `:789` per iteration | `:797` |
| W3 `regenerateAsk` | `:1543`, after `generateChildRender` returns and after its budget/transient catch | `:1546` | `:1554` |
| W4 `settleGenerationExhaustion` | `:1752`, after `canonicalBatchId` | `:1753` | `:1764` |

No writer constructs a `Date` inside a transaction. `toInsertInput` (`:723-741`) no longer calls
`new Date()` — it receives the value, so the pre-image's post-lock mint is gone from the one
place it lived. All three `toInsertInput` call sites (`:814`, `:1604`, and W4's inline object at
`:1831`) pass the parameter.

### 4. One `Date`, two columns — verified as IDENTITY at every site

* W1/W2: `toInsertInput(…, decidedAt)` at `:814` and `recordOutreachWithheldRefusal(…, decidedAt)`
  at `:822` — same binding, same scope.
* W3: `:1609` and `:1621` — same binding.
* W4: `renderedAt: decidedAt` at `:1831` and `recordOutreachWithheldRefusal(…, decidedAt)` at
  `:1841` — same binding.

The helper (`:679-704`) passes `decidedAt` straight to `occurredAt`, and `writeRefusalEvent`
binds it as `${occurredAt}::timestamptz` (`write.ts:344`) while `insertOutreachRender` binds the
same object (`outreach.ts:606`) — one serialisation of one instance into two columns.

Test coverage matches: `ask-generation.test.ts:1437` asserts `toBe` (identity, not equality) for
**all six withheld rows across all four writers**, and `:1466` re-proves it under a forced
5-second clock advance injected inside `insertOutreachRender`, which is the only construction
that separates "reused the instance" from "minted a second `Date` in the same millisecond".

### 5. `regenerateAsk` — the conditional and the replaced row

The replacement inserts unconditionally (`:1602-1611`); the Refusal is guarded on
`outcome.status === 'withheld'` (`:1615`). The replaced row is provably never a Refusal subject:
`:1509` refuses any `current.delivery_status !== 'rendered'`, `:1567` re-checks it under the
advisory lock, and `supersedeLiveRender` (`:1593`) returns null otherwise — so the superseded row
was `rendered` at both checks, and a `rendered` row is never written with a
`disposition_reason`, therefore never had a render-lane Refusal to keep. It is set `cancelled`,
which is not a Refusal in this lane. Matches the intake `user_visible_behavior` bullet verbatim.

### 6. `settleGenerationExhaustion` — one Refusal per hole

`:1815` `for (const hole of holes)`; the insert is at `:1817` and the ledger call at `:1841`,
both inside the loop body, both on the same `tx`. Not per invocation, not per BullMQ attempt
(the `markOutboxFailed` CAS at `:1758` returns `stale` before any domain write on a losing
attempt). Matches the intake non-goal that explicitly warns against per-call.

### 7. Tenant and transaction scope

* Every row: W1/W2/W3 pass `ctx` (`BatchGenerationContext`, whose `accountId`/`businessId` are
  the same values every tenant predicate in the surrounding transactions uses); W4 passes
  `{ accountId: batch.account_id, businessId: input.businessId }`, where `accountId` is read from
  the batch row locked `FOR UPDATE` at `:1766-1773` and is the same value its own insert carries.
* Every write is on the caller's `tx: TransactionSql`. The helper's signature makes any other
  client a type error, and nothing in the diff imports `@/lib/db/server` (invariant #15 holds).
* No `try/catch` at any of the three call sites — matches the `suspension.ts` precedent and
  `write.ts`'s stated contract.
* The lane adds no new SQL text, so `ci:tenant-scope` / `ci:rls-audit` allowlists need no entry;
  `refusal_events` keeps #1008's deny-all RLS untouched.

### 8. Spec conformance against `.feature/intake.json`, field by field

* **goal** — met; all four writers record `outreach_withheld` against the outreach they withhold,
  stamped with the outreach's own `renderedAt`.
* **non_goals** — none breached. `commitWithhold` (dispatch), `ask_withheld`, `batch_halted`,
  `auto_post_revoked`, `held_draft`, `policy_gate_held`, the lane maps and the read path are all
  untouched; `src/lib/refusals/write.ts` is not edited; no migration.
* **invariants** — all eleven verified above (clock placement, sentinel never used, timestamp is
  a parameter not a `ChildRenderOutcome` field, reader audit performed and recorded, subject is
  the just-minted id, one per withheld outreach, rendered writes nothing, same transaction, no
  catch, tenant columns present).
* **edge_cases** — all nine hold in code: stale outbox CAS returns before any insert
  (`:795`, `:1550`, `:1761`); the lifecycle re-check returns `stopped` before the insert (`:812`)
  and `RegenSwapAbort` on the regen side (`:1568`); a `CHECK` violation propagates and aborts.
* **allowed_edit_surface** — the diff touches exactly `ask-generation.ts`, its two test files,
  `arch-review-log.md`, `docs/directory.md`, and `docs/superpowers/plans/**`. No file outside the
  surface. `outreach-render.integration.test.ts` was allowed but not needed.
* **tests_to_add** — all 23 titles present VERBATIM (9 unit, 14 live-DB); counted and matched
  string-by-string against the intake array.
* **existing_patterns_to_follow / test_seams** — followed; the seam list's own round-1 correction
  ("the batch entry point reaches `persistChildRender` and `settleBudgetStop` ONLY") matches the
  code.

Blast radius re-derived: `ask-generation.ts` has three non-test importers —
`worker/jobs/solicitation-batch/generate.ts` (`generateAsksForBatch`, `regenerateAsk`),
`generate-failed-hook.ts` (`settleGenerationExhaustion`), and `dispatch.ts` (`import type
{ OutboxHandle }`). All three exported signatures are unchanged; `decidedAt`, `toInsertInput`,
`persistChildRender` and the new helper are all module-private. No caller is affected.

## Low-confidence appendix (below the reporting bar)

1. **`ask-generation.integration.test.ts:1251-1252`** — the slow-lock discriminator's margin is
   the same knob as the contention (`HOLD_MS = 600`): it asserts `rendered_at_ms < lockHeldAt +
   600`, and the window between `lockHeldAt` and the `decidedAt` read contains the rest of
   `generateChildRender`. A >600 ms stall there flakes the gate. I checked before filing: the
   LLM task and `@/lib/costs/tracker` are both mocked (`:54`, `:58`), so the remaining work is
   footer + lint + moderation with no I/O, and the budget is comfortable. Filed here rather than
   above because the risk is real but small; asserting against `startedAt` instead of
   `lockHeldAt + HOLD_MS` would decouple the two knobs.
2. **`settleBudgetStop`'s single clock read spans N transactions.** A large batch settling many
   rows gives the last row a `rendered_at` that predates its own INSERT by the whole loop
   (a probe query plus a full advisory-lock transaction per row). This is the intended semantics
   — one budget exception, one decision instant — and no reader is affected (age against 90 days;
   ordering carried by the `o.id` tiebreak). Recorded only because it is the largest
   `rendered_at`-to-insert skew the branch introduces and it is not stated in the code comment
   at `:920-925`, which reads as if the rows settle promptly.
3. **`refusal_events` `ON CONFLICT (refusal_source, subject_id) DO NOTHING`** silently drops a
   second `outreach_withheld` row for one outreach id. I traced whether this lane and #1010's
   dispatch lane can ever collide on one subject: they cannot, because a render-withheld row is
   terminal and never reaches dispatch, and dispatch selects `rendered`. Not a finding for this
   branch; noted because #1010 lands on the same `(refusal_source, subject_id)` key.
