# Standards & maintainability — #1010 / #1011 / #1012 reviewed together

Fork `06a163f0`. Heads: #1010 `e9a6a50b`, #1011 `535e0763`, #1012 `7c9bd9cd`.
Read-only review. Question asked: **will this stay right, and are these three one
thing or three?**

Scope note: correctness/spec is owned by other reviewers. Everything below is
about convergence, comment truth, drift surface, and test shape.

---

## What already agrees (stated so the divergences below read as exceptions)

All five call objects — `suspension.ts` (the #1009 precedent), `approval.ts`,
`batch-builder.ts`, `dispatch.ts`, `ask-generation.ts`, `auto-policy-downgrade.ts`
— spell the nine fields in **identical order** (`accountId`, `businessId`,
`refusalSource`, `refusalCode`, `allRefusalCodes`, `refusalCategory`,
`subjectType`, `subjectId`, `occurredAt`), all carry the same "reason VERBATIM,
never normalised" note on `refusalCode`, and all carry the same "NOT wrapped in
try/catch — the lever is the kill switch" paragraph. That is real convergence and
it survived three concurrent worktrees. The `null`-category guard appears exactly
where the lane map admits `null` (`approval.ts`, `batch-builder.ts`) and nowhere
else, which is forced rather than arbitrary.

The three `occurredAt` strategies are each **forced by their lane** and each is
documented at its own call site — I could not find a case where one could be
"simplified" into another without a test going red:

| lane | strategy | why it cannot be swapped | rail |
|---|---|---|---|
| `batch_halted` (#1010), `auto_post_revoked` (#1012) | `'transaction_time'` | joins `solicitation_batches.halted_at` / `approval_audit_log.created_at` to the microsecond; a JS `Date` loses them (#520) | live-DB equality asserted **inside** Postgres — `approval.integration.test.ts:3073`, `auto-policy-downgrade.integration.test.ts:383` |
| `ask_withheld` (#1010) | one `Date` per build (`batch-builder.ts:588`) | one build is one decision; the sentinel would be transaction START, before the advisory-lock wait | `batch-builder.integration.test.ts:2229` measures a >0.3 s skew against `created_at` under a held lock |
| `outreach_withheld` dispatch (#1010) | the gate's own `now`, threaded (`dispatch.ts:1366`) | `now` is read *after* the locks, so it is the verdict's clock | `dispatch.integration.test.ts:1662` |
| `outreach_withheld` render (#1011) | `decidedAt` read *before* `sql.begin` | the render decision happened before the transaction existed | `ask-generation.test.ts` "a forced clock advance…" asserts `toBe` **identity**, not equality |

#1010-dispatch reads its clock *after* the lock and #1011 reads its *before* — a
divergence, but the correct one in each lane, and both say so in prose.

---

## Findings

| # | branch | severity | file:line | finding |
|---|---|---|---|---|
| F1 | #1010 | MEDIUM | `src/lib/refusals/write.ts:578-585` | The comment calls `write.test.ts` "the compensating control for the second spelling" — it compares the `ON CONFLICT` clause only. Column list, value expressions, `id` mint, `vocabulary_version` and `COALESCE(occurred_at, NOW())` are duplicated with **no** comparison. |
| F2 | #1010/#1011 | MEDIUM | `dispatch.ts:1476` vs `ask-generation.ts:696` | Both halves of `outreach_withheld` key the partial unique index on the same `solicitation_outreach.id`. Neither comment names the other half. |
| F3 | all three | MEDIUM | `src/lib/refusals/vocabulary.ts:43-44` | "five exported constants have no production caller" is false for all five after these merge, and no branch may edit the file. |
| F4 | #1010 | MEDIUM | `dispatch.ts:1443` vs `approval.ts:602` | Two contradictory positioning rules for the ledger write, in one branch. |
| F5 | #1010 | MEDIUM | `batch-builder.integration.test.ts:2579`, `dispatch.integration.test.ts:2630`, `approval.integration.test.ts:3273` | Three suites carry byte-identical `it` titles claiming "all three lanes". |
| F6 | #1010 | LOW | `batch-builder.integration.test.ts:2270` | Title claims "full microsecond precision" for a lane whose clock is a JS `Date`. |
| F7 | #1010 | LOW | `src/lib/refusals/write.ts:533, 563` | Two branches of the new set arm have zero coverage in either suite. |
| F8 | all three | LOW | six files (below) | `'REFUSAL_LEDGER_ENABLED'` re-spelled as a literal in six test files. |
| F9 | #1011 | LOW | `ask-generation.ts:784-792` | `persistChildRender` is now eight positional parameters. |

### F1 — the set arm's duplication is controlled for the predicate and nothing else

`writeRefusalEvents` (`write.ts:498-586`) re-spells the whole 11-column INSERT.
`write.test.ts`'s new case reads both `ON CONFLICT` clauses out of the module
source and compares them — a good control, and the right shape (compared to each
other, never to a literal). But the comment at `write.ts:581-582` states that this
comparison *is* the control for "the second spelling #1001 warned about". It is
the control for one clause of it.

**The change that drifts them apart with every test green:** a migration that adds
a **nullable** column to `refusal_events` (say `correlation_id`). A future author
updates `writeRefusalEvent`'s column list and its `VALUES`; the set arm is 90 lines
further down and structurally different (INSERT … SELECT … `jsonb_to_recordset`
AS-list, plus a TS `RefusalEventRow` interface at `write.ts:446`). The set arm
silently writes NULL for the highest-volume lane in the ledger. Nothing compares
the two column lists; the `ON CONFLICT` case still passes; `batch-builder.integration`
asserts only the columns it names.

A second, cheaper vector: `RefusalEventRow`'s keys and the `AS event(...)` alias
list are two hand-maintained copies of the same contract (`write.ts:446-458` and
`write.ts:563-575`). A key renamed on one side yields `NULL` from
`jsonb_to_recordset` with no error. Most columns would then trip a 116 CHECK — but
`occurred_at` would not: it would fall through `COALESCE(…, NOW())` and silently
become transaction time for every ask Refusal. The only thing that catches that
today lives in a *different* suite (`batch-builder.integration.test.ts:2270`), so a
maintainer working inside `src/lib/refusals/` and running that directory's tests
gets a green light.

**Suggested rail (cheap):** extend the existing source-reading case to also pull
the two `INSERT INTO refusal_events ( … )` column lists and assert they are the
same text, and add one `occurred_at` assertion to `write.integration.test.ts`'s
set-arm block so the guarantee is tested where the code lives.

### F2 — the two halves of `outreach_withheld` share one uniqueness keyspace, undocumented

`#1010`'s dispatch half writes `refusal_source='outreach_withheld'`,
`subject_id = scope.outreachId` (`dispatch.ts:1476`). `#1011`'s render half writes
the same lane against the same column (`ask-generation.ts:696`). The partial index
`refusal_events_subject_uniq (refusal_source, subject_id) WHERE subject_id IS NOT NULL`
therefore admits **one** Refusal per outreach row across both writers, and
`DO NOTHING` makes the loser silent.

Today this is unreachable: `applyDispatchGate` refuses anything whose
`delivery_status !== 'queued'` (`dispatch.ts:1590`), and a render-withheld row is
`'withheld'`. So the branches are correct. But the invariant that makes them
correct is written down nowhere. `dispatch.ts:1453` does discuss subject collision —
and names the *wrong* neighbour (`ask_withheld`), which is the one that cannot
collide because its `refusal_source` differs. `ask-generation.ts:646-676` does not
mention the dispatch half at all.

**Failure scenario:** a future change that re-queues a withheld render (a retry
lane, a manual "try again", or a regeneration that reuses the row id instead of
minting a new one) makes the dispatch withhold's Refusal vanish into `DO NOTHING`.
The decision is made, the row exists, the ledger shows the earlier reason, and
nothing anywhere fails. Given the whole point of the ledger is that an absent row
and a decision that never happened look identical at read time, this is the exact
defect class the ledger cannot self-report.

**Suggested rail:** one sentence at both sites naming the other writer and the
`delivery_status = 'queued'` precondition that separates them.

### F3 — a comment all three branches leave false

`vocabulary.ts:43-44`: *"for as long as this file is ahead of them, five exported
constants have no production caller."* After these three merge, `ASK_WITHHELD_…`,
`OUTREACH_WITHHELD_DISPATCH_…`, `BATCH_HALTED_…`, `OUTREACH_WITHHELD_RENDER_…` and
`AUTO_POST_REVOKED_…` all have one. `vocabulary.ts` is outside all three edit
surfaces by design, so no branch can fix it and the "whichever lands last" handoff
in #1010's D3 cannot work either — #1010's deviations file already corrects itself
on this point and hands it to the orchestrator. Recording it here so it does not
live only in a branch-local deviations file: **this is an owed follow-up on the
orchestrator, to land after all three merge.** The same edit should also drop the
now-satisfied justification paragraph, or it will read as a live constraint on
#1013/#1014.

### F4 — two contradictory rules for where the ledger write goes, inside one branch

`approval.ts:602-611` states the rule as an **ordering contract**: the write goes
after step 3 (audit) and before step 4 (spine), because that "keeps the
advisory → batch row → `agent_runs` lock order this file's header describes", and
because a write placed earlier makes the rollback case pass vacuously.

`dispatch.ts:1443-1450` states the rule as **LAST**: after `completeRun`
(an `agent_runs` write), after `markOutboxCompletedIfOwned`, and after
`closeBatchIfSettled` — justified by the same non-vacuity argument, pointed the
opposite way.

`batch-builder.ts:637` and `auto-policy-downgrade.ts:173` both follow the
`approval.ts` rule (before the spine / before the outbox enqueue). So four sites
say "before the spine and outbox writes" and one says "after everything". Since
every one of these is inside a single transaction, position has **no** atomicity
consequence; it is chosen for lock order and test non-vacuity, and the two branches
weigh those differently with no arbiter.

The concrete cost is not a bug today, it is the next edit. `dispatch.ts:1445` says
"LAST, after every other write this withhold makes" — a self-falsifying comment: an
author adding a new write to `commitWithhold` will append it at the end, silently
demoting the ledger write and making the sentence false with no test to notice.
`approval.ts`'s "3b" numbering is the better precedent precisely because it is
positional rather than superlative.

**Suggested:** pick one rule for #1013 (the `approval.ts` one reads as the intended
house rule: after the domain writes the Refusal names, before the spine/outbox
writes) and either move `commitWithhold`'s call to match or replace "LAST" with a
named anchor ("after `closeBatchIfSettled`").

### F5 — three identical titles, none of which is true in isolation

`#1010`'s D1 records this and argues it well: three lanes need three incompatible
fixture chains and `src/lib/shared/__tests__/helpers/` is outside the edit surface,
so three instances is the honest shape. I agree with the *coverage* decision. I do
not agree the wording is settled, because the mitigation (a comment naming which
lane the instance owns) is invisible in the one place the title is actually read.

Three suites now each contain, byte-identically:

- `all three lanes complete their decisions unchanged when REFUSAL_LEDGER_ENABLED is false`
- `every solicitation refusal reason writes its verbatim code and mapped category, and every null-mapped reason writes nothing`
- `every refusal_events row these three lanes write carries the account and location already in the lane's scope`

**Failure scenario:** a CI failure line prints the title and the file. Three files
can print the same title, so the first thing a reader learns is wrong ("all three
lanes broke"), and `vitest -t "all three lanes complete"` runs three unrelated
fixture chains. #1011 and #1012 wrote per-lane titles for the same claims
(`ask-generation.integration.test.ts:1544` — "…across all four render writers";
`auto-policy-downgrade.integration.test.ts:722` — names its own five effects), which
is the shape #1010's own D1 recommends for #1013. Renaming three strings is a
no-risk edit and it should happen before #1013 copies the pattern a fourth time.

### F6 — a title borrowed from a lane where it means something

`batch-builder.integration.test.ts:2270`: *"an ask Refusal's occurred_at equals
solicitation_asks.decided_at inside PostgreSQL at full microsecond precision"*.
Both values in that lane originate from `new Date().toISOString()`
(`batch-builder.ts:810`) → millisecond resolution; there are no microseconds to
preserve, and the guard is `expect(join.occurred_at).toMatch(/\.\d{1,6}/)`, which
`.006` satisfies. The comparison-in-Postgres discipline is right and the case is
worth keeping; the *title* is copied from `approval.integration.test.ts:3073` and
`auto-policy-downgrade.integration.test.ts:383`, where the value genuinely is
`NOW()` and the phrase is load-bearing. Reading the three side by side, this is the
one that over-claims. "…at sub-second precision" is true and still falsifiable.

### F7 — the set arm's two untaken branches have no test anywhere

`writeRefusalEvents` has one caller, `ask_withheld`, which always supplies a `Date`
and always `allRefusalCodes: null`. So neither the sentinel path
(`write.ts:533` → `COALESCE(event.occurred_at, NOW())` at `write.ts:563`) nor the
`text[]` cast through `jsonb_to_recordset` is exercised by any unit or live-DB case
in either suite (checked: no set-arm fixture uses `'transaction_time'` or a non-null
array). `policy_gate_held` (#1013) is the only lane with `WithCodeSet` and is the
lane most likely to want the set arm for volume — so #1013's author is the one who
finds out. Also worth noting in the docblock: `.toISOString()` caps the set arm at
millisecond fidelity, so a lane needing the microsecond join #1006 relies on must
use the single-row arm or the sentinel.

### F8 — the flag name is a literal in six places

`const LEDGER_FLAG = 'REFUSAL_LEDGER_ENABLED'` now appears in
`src/lib/refusals/__tests__/write.test.ts`,
`src/lib/solicitation/__tests__/batch-builder.integration.test.ts:96`,
`dispatch.integration.test.ts:177`, `approval.integration.test.ts:779`,
`ask-generation.integration.test.ts:115` and
`worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts:58`, against
the private `REFUSAL_LEDGER_FLAG` in `write.ts:74`. `write.ts` already exports
`WARN_RETRY_COOLDOWN_MS` for exactly this "the eval pins it" reason, so the
precedent for exporting the flag name is in the same file. Three branches
independently chose the literal — a convergence miss rather than any one branch's
error. Low cost, but it is the class of duplication `.claude/CLAUDE.md`'s "no string
literals … import the constant from its single authoritative TS file" exists for.

### F9 — parameter-list length at #1011's threading seam

`persistChildRender(sql, ctx, child, outcome, attemptNo, parentRunId, handle, decidedAt)`
(`ask-generation.ts:784-792`) and `toInsertInput(ctx, child, outcome, attemptNo,
parentRunId, renderedAt)` (`ask-generation.ts:648`) both grew a trailing positional
`Date`. Nothing is wrong today and the docblocks are good. Flagged only because the
clock is the parameter this lane most needs to survive future edits, and a trailing
positional in an eight-arg list is the weakest place to keep it; an options object
for the last two (`{ handle, decidedAt }`) would make a future caller unable to
forget it. Not worth a change on its own — worth knowing if this function grows
again.

---

## Judgement on the three specific questions asked

**Do the shapes agree?** Yes, materially — field order, code-verbatim discipline,
try/catch stance and the null-category guard are consistent across all six sites,
and #1011's private helper is correctly framed as argument shaping, not a seam
(`ask-generation.ts:657-660` says so explicitly and cites `write.ts`'s "no seam"
paragraph). The one arbitrary divergence is F4's positioning rule.

**Comment mass.** Calibrated against `write.ts` and `suspension.ts`, the volume is
house style and I am not counting it as a finding. Density is not the problem;
three specific claims are (F1's over-claimed control, F3's now-false sentence,
F4's self-falsifying "LAST"). Everything else I spot-checked resolved against the
code: `MAX_DATA_ROWS = 5000` in `contacts-csv.ts:22` ✓; `commitAskDecisions`
asserting `insertedAsks.count` ✓; `askIds[index]` index-aligned with `decisions`
and every decision (send *and* withhold) getting a `solicitation_asks` row ✓;
`tx.json(x as never)` matching ~20 existing sites ✓; #1012's claim that a ledger
throw leaves the outbox attempt un-completed ✓ (the completion is rung 5, before
the ledger write, in the same tx); `refusal_events` already covered by the
offboarding purge (`worker/jobs/account-offboarding/purge-stages.ts:435-445`,
`table-disposition.ts:326`) so the new `business_id` FK writes have a purge path ✓.

**Is `writeRefusalEvents` duplication controlled well enough?** For the predicate,
yes and elegantly. For the statement, no — see F1.

---

## Low-confidence appendix (style, speculation, not staked)

- **`arch-review-log.md` merge conflict.** All three append one line at EOF
  (`+1/-0` each). The second and third PR will conflict textually. Git catches it;
  strict up-to-date required checks force the rebase. Mechanical, expected in a
  swarm, listed only so nobody is surprised.
- **`docs/directory.md` does not conflict** — edits are at lines 890/960/962/966
  (#1010), 974 (#1011), 1548/2011 (#1012). Verified disjoint.
- **#1011 changed `rendered_at` semantics for every outreach row**, successes
  included: it is now read before the transaction rather than inside it. Well
  argued and probably an improvement, but it is a pre-existing column's meaning
  changed in service of the ledger, and in `settleGenerationExhaustion` all holes
  in one invocation now share one stamp where they previously had distinct ones
  (the test at `ask-generation.integration.test.ts:127` already added `, id` as a
  tiebreak, so the author saw it). Spec reviewers own whether that is in scope.
- **#1012's full statement-ladder equality** (`auto-policy-downgrade.test.ts`, the
  ten-rung `toEqual`) is asserted twice, in two cases, and pins statement order
  fairly hard. The comment justifies it as the count assertion the owner's
  `account_id` decision rests on, and it is on stated precedent — I would not
  change it, but a third copy would be one too many.
- **#1012's source-regex cases** (`judgeGate.matchAll`, `publish.matchAll`) pin
  source text and will break on innocuous formatting (a line break inside the call).
  Precedented by `auto-policy-downgrade-lock-order.test.ts`; noted, not flagged.
- **Fixture duplication across suites.** `RefusalRow` + a `readRefusals` helper are
  written four times inside #1010 alone (`batch-builder:522`, `dispatch:958`,
  `approval:809`, `approval-system-halt:264`) and again in #1011 and #1012. D1's
  reason (closed edit surface, no shared helper directory available) is real and I
  accept it for these branches, but after all three land there is a clear case for
  one `refusal-ledger` test helper before #1013 writes a seventh copy.
- **`already_reviewed` is a live gate with no producer** (`toCandidate` hard-codes
  `matchedReview: null`). #1010's D2 found it, correctly declined to fix it, and
  escalated it. Agreed on all three counts; repeating it here only so it does not
  vanish with the deviations file. Not a Refusal-ledger question.
- **#1011's `toInsertInput` param docblock** carries a history note ("This function
  used to call `new Date()`…"). Useful now; it will read as archaeology in a year.
  Style preference only.
