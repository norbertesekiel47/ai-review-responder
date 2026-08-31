# Spec & correctness review — #1010, the three solicitation Refusal lanes

Reviewer: fresh, independent, read-only. Range `06a163f0..e9a6a50b`. No tests run
(gate reported green, 33 rows, review mode); every claim below was resolved
against the source at HEAD.

## Verdict

The three write sites and the set-based arm match the locked intake field by
field. Two LOW findings, both about artefacts *around* the change rather than the
change: three env/runbook doc rows that this branch falsified without recording a
deviation, and one test whose discrimination is weaker than the plan promised.
No HIGH or MEDIUM finding.

## Findings

| severity | file:line | finding |
|---|---|---|
| LOW | `.claude/reference/env-vars.md:551` | Three doc rows still name **one** ledger insert helper; this branch adds a second that also reads the kill switch and emits the disabled warning. Staleness not recorded as a deviation. |
| LOW | `src/lib/solicitation/__tests__/dispatch.integration.test.ts` (gate-clock case) | The clock case discriminates only against transaction start, not against any later intra-transaction JS clock — weaker than plan §4's promised evidence. |

### LOW-1 — the branch falsifies three doc rows outside its edit surface, unrecorded

* `.claude/reference/env-vars.md:551` — "is checked **inside** the one insert
  helper `writeRefusalEvent` (`src/lib/refusals/write.ts`) rather than at its
  call sites".
* `docs/eservices-variables.md:213` — "default-ON kill switch for the Refusal
  ledger's **one** insert helper (#1009)".
* `docs/runbooks/beta-launch-alerting.md:55` — the `subsystem:refusal_ledger`
  warning is "Emitted by `writeRefusalEvent` (`src/lib/refusals/write.ts`)".

`writeRefusalEvents` (`src/lib/refusals/write.ts`) reads `REFUSAL_LEDGER_ENABLED`
in its own body and calls the same `warnLedgerDisabled()`, so all three sentences
are now false as written. All three files are outside `allowed_edit_surface`, so
not editing them is correct — but the deviations doc records the *analogous*
`vocabulary.ts` staleness as **D3** and claims to record "everything the plan did
not anticipate", so the omission is the finding, not the restraint. Standard
violated: `.claude/CLAUDE.md` working rules — "grep the filename to clean every
cross-reference in the same change" / "one authoritative owner per fact"; and
"green CI is not proof that documentation is true". Fix: add a D6 to
`docs/superpowers/plans/feat-1010-refusal-solicitation-singles-deviations.md`
naming the three rows, and carry them on the same orchestrator-owned follow-up
D3 already opened (D3's own handoff is correctly identified as unworkable,
because `vocabulary.ts` is outside all three swarm branches' surfaces).

### LOW-2 — the dispatch clock case cannot see a late intra-transaction clock

The case asserts `Number(refusal.gate_skew_seconds) > 0.3` and
`occurred_at !== created_at`, where `created_at` is `DEFAULT NOW()` =
`transaction_timestamp()`. With the 0.5 s advisory-lock hold this proves the
stamp is **not** transaction start, which kills the `'transaction_time'`
sentinel. It does **not** anchor the value to the gate's `now`
(`src/lib/solicitation/dispatch.ts:1667`, passed as `decidedAt` at `:1719`): a
writer that used `new Date()` *inside* `commitWithhold`, after the withheld
terminal, the Lazy child, the receipt step and `closeBatchIfSettled`, produces a
skew of ~0.5 s + ε and passes every assertion in the case.

Plan §4's evidence line asks for both halves — "Assert `occurred_at` equals the
gate's `now` **and** is strictly greater than the transaction's `NOW()`" — and
only the second landed. The other two lanes do anchor: the ask lane compares
`occurred_at` to the batch's stored `built_at` (both written from the same
`decidedAt`), and the halt lane compares to `solicitation_batches.halted_at`
inside Postgres. The dispatch lane has no second stored artefact carrying the
gate's clock, which is why the anchor is missing — the honest fix is a
`vi.useFakeTimers`-free spy or an exported seam, neither of which is worth a
production change here. Production code is correct; this is a test-strength gap.

## What was attacked and found sound

1. **Two spellings of the `ON CONFLICT` predicate.** Both clauses squash to
   `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO
   NOTHING`, byte-identical, and both contain migration 116's own predicate
   (`WHERE subject_id IS NOT NULL`) parsed out of the migration. Re-ran
   `write.test.ts`'s `onConflictClauses()` strip+regex against the module at HEAD
   independently: exactly two matches, equal, both anchored. The
   `toHaveLength(2)` guard also makes a *third* spelling fail rather than drift.
   **Recordset column-list drift** is defended not by that test but by migration
   116's constraints: a renamed JSON key or AS-alias yields NULL and trips
   NOT NULL (`id`, `account_id`, `refusal_source`, `refusal_category`,
   `vocabulary_version`), C1 (`subject_type`), C2 (`subject_id`), C3
   (`business_id`) or C4 (`refusal_code`); `occurred_at` drift falls through
   `COALESCE` to `NOW()` and is caught by the ask lane's skew assertion. The one
   axis that *could* drift silently is `all_refusal_codes`, which is `null` in
   all three lanes here and is only load-bearing for #1013's `policy_gate_held`
   (see appendix).
2. **`COALESCE(event.occurred_at, NOW())`.** Resolution is per row, so a mixed
   `Date`/sentinel call is correct rather than ambiguous; it is also unreachable
   today — the only caller (`commitAskDecisions`) passes one shared
   `decidedAtInstant` for every row. `NOW()` is `transaction_timestamp()`, so a
   sentinel row lands exactly where `occurredAtFragment` would have put it.
3. **Three lanes, three clocks.** Ask: `decidedAt` is minted at
   `batch-builder.ts:810`, *after* `loadCandidateWindow` (i.e. after the advisory
   lock) and *before* `evaluateBatch` — it is the evaluation instant, and it is
   the same string the `built_at` CAS stores, which is what the test anchors to.
   Halt: the sentinel, and the CAS writes `halted_at = NOW()` in the same
   transaction, so `matches_halted_at` is computed in Postgres at full precision.
   Dispatch: `now` at `dispatch.ts:1667` is built *after* the outbox CAS, the
   advisory lock and both row locks, and is what `applyDispatchGate` judges —
   correct per the intake; only its test is weak (LOW-2).
4. **Halt write position.** `approval.ts` — CAS → cancel outreach →
   `writeAccountAuditLog` (when `audit !== null`) → **Refusal** → `recordStep` →
   `closeBatchIfSettled`. Exactly plan §5 / R1-6. The position case asserts it
   through recorded query text (`cancel < audit < ledger < step`), plus receiver
   identity (`onTransaction === true`, one transaction), so a write moved up to
   the CAS fails there and the rollback case stays non-vacuous.
5. **Null-mapped reasons.** Both guards key on the *category*
   (`if (refusalCategory === null) return []` in the ask lane;
   `if (refusalCategory !== null)` in the halt lane), never on a reason literal.
   All five null cases are exercised at runtime: `velocity_banked` in
   `batch-builder.integration.test.ts`, and all four halt nulls
   (`owner_veto`, `owner_halt`, `send_window_elapsed`, `batch_expired`) in the
   halt exhaustive case, which derives both halves from the map rather than
   re-listing them and pins `nullMapped.length === 4`.
6. **Tenant scope.** Ask uses `batch.accountId`/`batch.businessId`; dispatch uses
   `scope.accountId`/`scope.businessId`; halt uses `input.accountId`/
   `input.businessId`. No lane resolves a key it does not already hold, and no
   lane joins through `businesses`. All three assert `business_id` NOT NULL, so
   C3's account-wide meaning cannot be borrowed.
7. **Deviations.** **D1** — each of the three cross-lane titles genuinely covers
   its own lane: the ask instance drives four mapped reasons plus the one null and
   asserts its six accounted-for reasons are the whole of `WITHHOLD_REASONS`; the
   dispatch instance drives all six members of
   `OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES` and compares the written map to
   the real one; the halt instance drives all six halt reasons across three entry
   points. **D2** — verified against source: `toCandidate`
   (`src/lib/solicitation/batch-builder.ts:348`) hard-codes `matchedReview: null`,
   and `evaluateAsk`'s third gate (`restraint-policy.ts:377`) is the only producer
   of `already_reviewed`, so it is genuinely unreachable through
   `buildSolicitationBatch`. The substitute (pin the map entry + assert the six
   covered reasons exhaust `WITHHOLD_REASONS`) is the right one, and the escalation
   to the owner is correct — that gate is live code with no producer.
8. **Contract coverage.** All 31 `tests_to_add` titles appear verbatim (three of
   them three times, per D1); the two intake copies (`.feature/intake.json` and
   the plan-dir copy) are byte-equivalent as JSON; every touched path is inside
   `allowed_edit_surface`; no `try/catch` at any of the three call sites; the ask
   lane issues no statement for an empty or all-null-mapped set; `write.ts`
   remains the only module spelling `INSERT INTO refusal_events`.
9. **Client boundary (invariant #1).** `approval.ts` and `dispatch.ts` now
   value-import `@/lib/refusals/vocabulary`, and `vocabulary.ts`'s imports of
   `approval.ts`/`dispatch.ts` are all `import type`, so no runtime cycle is
   created. The one `'use client'` importer of `approval.ts`
   (`SolicitationBatchPanel.tsx:31`) is `import type`, so `@sentry/node` — pulled
   in by `write.ts` — does not reach a browser bundle.

## Low-confidence appendix (below the reporting bar)

* **`all_refusal_codes` is the one recordset key whose drift is silent.** A
  rename of that JSON key or AS-alias yields NULL, which is the correct value for
  all three lanes in this slice, so nothing here would go red. It only becomes
  load-bearing when #1013 routes `policy_gate_held` through the set arm, and C5
  would then reject it. Worth a line in #1013's intake; not a defect here.
* **Cross-lane `outreach_withheld` collision.** Render (#1011) and dispatch
  (this slice) share `refusal_source` and subject, so a second decision on one
  outreach id would be silently dropped by `ON CONFLICT DO NOTHING`. Checked and
  unreachable: a render withhold sets `delivery_status='withheld'`, which
  `lockAndTriageOutreach` refuses to dispatch and which `requestAskRegeneration`
  refuses to regenerate (it requires `'rendered'`). No finding.
* **FK lock acquisition.** `refusal_events`' FKs to `accounts` and `businesses`
  take KEY SHARE locks at the end of each deciding transaction. In all three
  lanes those locks are already held by an earlier write in the same transaction
  (`lockAccountBeforeOffboardingProjection`, the `agent_runs` insert, the audit
  row / the batch row), so no new lock-order edge is introduced.
* **`docs/reviews/feat-1010-.../blast-radius.md` is untracked.** Expected — it is
  a review-wave artefact produced after HEAD, not implementation output.
