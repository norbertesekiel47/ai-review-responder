# ADR 0021 — Ask withdrawal is a restraint act, not a re-approval

## Status

Accepted — 2026-08-18 (#872). Answers the follow-up ADR 0020 § Consequences →
"Cost, as verified" left open. Does not amend ADR 0020: the decision there
(regeneration is refused once `approved_at` is set) stands unchanged.

## Context

ADR 0020 refused **Ask regeneration** after approval and prescribed the **Halt
latch** as the owner's only post-approval recourse. Its "Cost, as verified"
subsection then established — against the code, file:line — that halting
costs the **cohort**, not the batch: `haltBatch` never touches
`solicitation_asks`, the rebuild's `priorBatch` query keys on
`solicitation_asks.status = 'send'`, `MIN_GAP_DAYS = 30` withholds every one
of those contacts as `over_contacted`, and `stale_visit` fires first for every
vertical but `home_services`. An owner who approves 25 messages and dislikes
one has two options: let it send, or forfeit all 25 for that visit.

Issue #872 proposed the cheaper recourse — cancel ONE approved outreach row —
and recorded three claims from #860's round-1 adversarial review as claims
**to be validated, not assumed**. This ADR is that validation.

## Decision

**Add `withdrawAsk` — the owner cancels one approved Ask's live Outreach row
(`rendered`/`queued` → `cancelled`, `disposition_reason='owner_withdrawn'`)
in every Batch state where the Halt latch would cancel that row
(`veto_window`, `approved`, `sending`). It removes a message and never
replaces one.** Glossary term: **Ask withdrawal** (`CONTEXT.md`).

Four properties make it a restraint act rather than a re-approval:

1. **No new bytes.** The row is cancelled; nothing is inserted, superseded or
   edited. Owner approval's byte-for-byte guarantee is a guarantee about what
   *sends*; a message that does not send cannot violate it. This is the same
   argument **Ask exclusion** makes for pre-approval deselection.
2. **No per-ask approval state.** `approved_at`, `approval_method`,
   `approved_by_user_id` and `veto_deadline_at` are untouched. The batch stays
   approved; the veto clock keeps running. Withdrawal is written on
   `solicitation_outreach` and nowhere else — D10's rule for dispositions.
3. **Halt's contract, inherited whole.** Same lock order (advisory batch lock →
   `solicitation_batches` FOR UPDATE → outreach UPDATE → `recordStep` →
   `closeBatchIfSettled`), same row predicate (`rendered`/`queued`, never
   `sending`), same "no further sends, not undo" semantics, same single
   terminal writer. Withdrawing the last live row settles the batch
   `exhausted` — the exclude-everything precedent.
4. **Same state set as halt, post-approval.** Legal exactly where the latch is
   legal AND the batch is approved: `veto_window`, `approved`, `sending`.
   Refused in `pending`, `built` (that is Ask exclusion's job), `expired`,
   `halted`, `closed`.

### The three claims, validated

| # | Claim (from #860 round-1 review) | Verdict | Evidence |
|---|---|---|---|
| 1 | No per-ask approval state is needed | **Holds** | Migration 091's `solicitation_batches_approval_consistency` CHECK and the `solicitation_batches_one_active_send_per_business` partial index are written against batch-level columns only (`approved_at`, `approval_method`, `approved_by_user_id`, `send_closed_at`, `halted_at`). Cancelling one outreach row writes none of them; the batch remains the unit of approval. |
| 2 | No migration is needed | **Does not hold — by choice, not necessity** | Migration 108's cancel arm admits `owner_excluded`, so a withdrawal *could* be stored without a schema change. It is not: `CONTEXT.md` locks **Ask exclusion** as an act written *in the approval transaction*, and a post-approval row carrying `owner_excluded` would misstate when and how it was cancelled — the audit argument the lane already uses to derive halt reasons server-side. Migration **109** re-spells 108's predicate verbatim plus `owner_withdrawn` under `cancelled`. Additive, re-runnable, rollback = re-apply 108's text (legal while no `owner_withdrawn` row exists; `SOLICITATION_SEND_ENABLED` is off everywhere). |
| 3 | No coordination class `haltBatch` does not already force | **Holds** | `haltBatch` (`src/lib/solicitation/approval.ts`) already cancels `rendered`/`queued` rows of an approved batch under the B11 lock order and excludes `sending`. The releaser (#630, unwritten) must therefore already re-check a row under the batch lock before dispatch and tolerate a `queued` row vanishing. Withdrawal is that hazard at smaller granularity — no new predicate, no new lock. |

### Also decided (the questions the reviewer did not address)

- **Last live row withdrawn → settle.** `closeBatchIfSettled` in the same
  transaction; disposition `exhausted`, send parent `completed`, exactly as
  excluding every ask at approval does. The veto clock becomes moot because
  `closed` outranks `veto_window` in the Batch state precedence.
- **Keyed on `askId`, not `outreachId`.** Post-approval there is exactly one
  non-cancelled row per send Ask and nothing can swap it, so both keys are
  correct; the ask id survives a pre-approval regeneration a stale tab may
  not have seen, and matches the regenerate route's body shape.
- **Surface.** A per-row `Withdraw` control in the existing post-approval
  panel mode, behind an inline two-tap confirm (terminal act, no browser
  dialog). Withdrawn rows leave the list the way excluded rows do.
- **The withdrawn contact is not released.** No `solicitation_asks` write —
  090 welds `status` to the decision — so the withdrawn contact is
  `over_contacted` for `MIN_GAP_DAYS` like any halted ask. The cost is one
  contact, not the cohort; that is the whole gain, and it is deliberate.

## Alternatives considered

### Reuse `owner_excluded` and skip the migration — rejected

Cheaper today, dishonest tomorrow: two different acts (at approval / after
approval, in the approval transaction / in its own) stored under one value,
distinguishable only by comparing `updated_at` to `approved_at`. The glossary
term would blur and the audit row would need a join to read. One CHECK
re-spell is the price of a stored value that means one thing.

### Veto-window only — rejected

Ticket-literal but leaves the 72-hour drip (`BATCH_SEND_WINDOW_HOURS`) with
halt as the only recourse — exactly where the cohort cost bites hardest. The
panel already collapses `veto_window`/`approved`/`sending` into one mode, so
the wider set costs no UI and no new coordination: halt is legal in all three.

### Withdraw and release the contact for a rebuild — rejected

Would require writing `solicitation_asks` (welded by 090) or a new "withdrawn
decision" the restraint policy understands — a restraint-policy change with
its own grill. Out of scope; the ticket asked for one contact's loss instead of
twenty-five's, not zero's.

## Consequences

- One new owner verb in `approval.ts`, one route, one panel control, one
  step key (`ask_withdrawn`), one additive migration (109).
- ADR 0020's recourse sentence gains a cheaper sibling; its decision is
  unchanged.
- The releaser (#630) inherits nothing new: the row-under-lock re-check halt
  already forces covers withdrawal.
- **Watch item, shared with ADR 0020:** the value of this recourse is a
  function of `MIN_GAP_DAYS` and `FRESHNESS_WINDOW_DAYS`. If a future change
  lets a rebuild recover halted contacts, withdrawal's advantage shrinks to
  ergonomics — re-read this ADR then.
