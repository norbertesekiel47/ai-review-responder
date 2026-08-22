# Branch review — Standards & maintainability (round 1)

- **Branch:** `feat-900-solicitation-release-poller`
- **Fork point:** `53bb0fcf`; diff under review is `git diff 53bb0fcf..HEAD`
- **Axis:** repo standards (`.claude/CLAUDE.md`), `codebase-design` deep-module
  discipline, Fowler smell baseline, `CONTEXT.md` glossary
- **Method:** `thermo-nuclear-code-quality-review` at high effort. Read-only.
  Live-DB suites deliberately not executed (two sibling review agents share the
  test DB); `pnpm typecheck`, `pnpm lint`, `ci:tenant-scope`, `ci:static-policy`,
  `ci:outbox-status`, `ci:outbox-seam`, `ci:directory-map`, `ci:db-imports`,
  `ci:rls-audit` were all run and all pass.
- **RISK:** high. **Verdict: no blocker. Seven findings, none structural-regression class.**

---

## Findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| 1 | Medium | `src/lib/solicitation/approval.ts:794` (and `CONTEXT.md:71`) | `latchSystemHalt` documents a caller precondition that neither of its callers satisfies, and the glossary now records the false version. |
| 2 | Medium | `src/lib/solicitation/release.ts:879-893` / `:909-923` | Two byte-identical 15-line three-branch guard blocks plus an undocumented `stopPhase` control flag; a missing `ReleaseBudgets` model. |
| 3 | Medium | `src/lib/solicitation/release.ts:493-500` vs `:421-425`, `:467`, `:473`, `:603`, `:675` | The stated justification for `findRunningLazyChild` returning `null` is left unenforced — five other throw sites in the same loops abort the tick exactly as described. |
| 4 | Medium | `scripts/ci/tenant-scope-allowlist.ts:165-178` | Baseline changelog records `383 → 385`; the constant three lines below is `390`. Five of seven new entries have no ledger bullet. |
| 5 | Low | `release.integration.test.ts:26-36`, `:60-84`, `:729-734`; `release.test.ts:7-12`; `release.ts:184-185`; `outcome-anchor-pairing.test.ts:182-183` | Branch-execution narration shipped as permanent comments; four statements are false at HEAD and one dead branch is duplicated. |
| 6 | Low | `src/lib/solicitation/__tests__/release.integration.test.ts:172-201` | Third hand-copy of the `contact_csv_uploads` / `solicitation_contacts` fixture pair, next to a shared helper written for exactly this failure mode. |
| 7 | Low | `CONTEXT.md` (no change) | The lane's own closed vocabulary (`ReleaseWithheldReason`, the P1–P5 order, the per-tick budget) coins no glossary term, unlike every sibling send-lane concept. |

---

## The headline question: is `release.ts` a deep module or a monolith?

**Verdict: a deep module. The file-size flag does not fire, and I am not raising
one.** The reasoning, stated so it can be argued with:

- **Measured shape.** 1,225 lines total = **652 code / 496 comment / 77 blank**.
  The thermo-nuclear 1,000-line rule is about how much a reader must hold in
  their head; 652 lines of code across a single lifecycle is a large function's
  worth, not a monolith's. Roughly 40% of the file is prose.
- **The interface really is narrow.** One function (`runReleaseCycle`), one
  options bag with two optional numbers, one report type, two exported
  constants, one closed union. Everything else — five scan predicates, four
  sweep bodies, the Judge split, the downgrade CAS, the release CAS — is
  private. That is the deep-module ratio the discipline asks for.
- **I tested the header's argument rather than accepting it.** The header claims
  the phase order is a domain rule and that a caller able to run phases
  separately could run them wrongly. The claim survives on evidence, not
  assertion: P1 must precede P2/P3/P5 because a row it resolves settles its
  batch in the *same* tick; P2/P3 must precede P4 because an overdue batch must
  never release, and `selectReleaseCandidates`'s `approved_at >` arm is the
  exact complement of `selectSendWindowElapsedBatches`'s `<=`; P5 must follow
  everything because it is a backstop over what the earlier phases did not
  close. Exporting the sweeps would let a future caller compose them in an order
  that silently releases an overdue batch — a failure with no test that catches
  it, because nothing asserts phase order from outside.
- **The seam I looked for is not there.** The obvious split is
  `release-sweeps.ts` (P1/P2/P3/P5) vs `release.ts` (P4). It has **no second
  caller** — nothing outside `runReleaseCycle` wants a sweep — so it would add
  four exports, one `docs/directory.md` row and one module boundary in exchange
  for a line count. Per the brief's own bar ("here is the specific seam … with
  the second caller that would use it"), I do not have one, so I am not asking
  for it.

**Where the decomposition IS owed is inside the module, not across files.**
`runReleasePhase` (`:777-935`) is 158 lines with three copies of one guard
triple. That is finding #2, and fixing it removes ~30 lines and one control
flag without moving a single function out of the file.

---

## Finding 1 (Medium) — `latchSystemHalt`'s documented lock precondition is false

`src/lib/solicitation/approval.ts:794-799`:

> **The caller MUST already hold the batch row lock**, and this is the one
> contract this function cannot check for itself. […] the release cycle's sweeps
> select candidates OUTSIDE any lock, then take the batch row lock and
> terminalize under it, so the lock is already theirs by the time they call in.
> Re-reading the row here under `FOR UPDATE OF b` makes a forgetful caller safe
> rather than merely wrong.

Both callers hold no lock at all. `sweepSendWindowElapsed`
(`src/lib/solicitation/release.ts:597-613`) and `sweepBatchExpired` (`:669-685`)
open a bare `sql.begin` whose entire body is the `latchSystemHalt` call
(`:603`, `:675`). The batch row lock is acquired *inside* `latchSystemHalt`, by
`readBatchForAction`'s `FOR UPDATE OF b`. Every caller is the "forgetful" one;
there is no non-forgetful path.

`release.ts` states the correct fact twice, in the two sweep docstrings
(`:588-591`, `:663-665`): "It does not hand-roll a `SELECT … FOR UPDATE` either:
`latchSystemHalt` re-reads the row `FOR UPDATE OF b` itself." So the branch
ships **two contradictory descriptions of one seam**, and `CONTEXT.md:71` — the
authoritative layer — carries the wrong one:

> Its only callers are the release cycle's two sweeps, which select candidates
> outside any lock **and hold the batch row lock across the call** — the one
> contract the function cannot check for itself…

That sentence is also internally inconsistent: if the function re-reads the row
`FOR UPDATE OF b`, the caller need not hold anything, and the contract is not
uncheckable — it does not exist.

**Concrete maintenance failure.** A future maintainer reading the docstring or
the glossary believes callers hold the lock, and reads `readBatchForAction`'s
`FOR UPDATE OF b` as the redundant second lock the same docstring warns about
("re-taking a lock this transaction already holds is a no-op"). Deleting it
removes the **only** row lock on the system-halt path — the halt CAS, the
outreach cancellations, the audit-free spine step and `closeBatchIfSettled`
would then run unserialised against `haltBatch`/`adminHaltBatch`/`withdrawAsk`.
The comment is not merely inaccurate; it is the argument for the deletion.

**Fix.** State what the code does in all three places: `latchSystemHalt` takes
the batch row lock itself; its callers take none; the advisory lock is skipped
because no sweep takes it. Drop the "MUST already hold" obligation entirely —
it is invented, and it makes the function's real contract sound weaker than it is.

---

## Finding 2 (Medium) — three copies of one guard triple, plus a control flag

`src/lib/solicitation/release.ts`, `runReleasePhase`:

- `:847-855` — two branches (budget, platform) at the account-loop head.
- `:879-893` — three branches (budget, platform, account) at the batch-loop head.
- `:909-923` — **byte-identical** to `:879-893` modulo indentation (verified by
  `diff`), at the outreach-loop head.

Standard violated — the skill's own escalation list: *"Copy-pasted logic instead
of extracted helpers"* and *"One-off booleans, nullable modes, or flags that
complicate existing control flow."* CLAUDE.md's "no abstractions for a single
caller" does **not** shield this: there is one *shape* with three call sites.

The `stopPhase` flag (`:832`, set at `:882`, `:887`, `:912`, `:917`, read at
`:846`) is the second half of the smell, and it is the one thing in this file
with **no comment**. Its only observable effect is arithmetic: without it, the
account-loop head at `:847` would catch the same exhausted counter and record a
*second* `withhold` for the same event. In a module where every other decision
carries a paragraph, an undocumented control flag whose purpose is
double-count suppression will not survive contact with the next maintainer.

**Code-judo move.** Give the three counters one owner:

```ts
type BudgetBlock = { reason: ReleaseWithheldReason; stopsPhase: boolean };

class ReleaseBudgets {
  constructor(private tick: number, private platform: number) {}
  private account = Number.POSITIVE_INFINITY;
  openAccount(remaining: number): void { this.account = remaining; }
  /** null = capacity available. */
  blockedBy(): BudgetBlock | null { /* tick → platform → account, in that order */ }
  consume(): void { this.tick--; this.platform--; this.account--; }
}
```

Each of the three sites collapses to one `blockedBy()` call plus a `break`
driven by `stopsPhase`; the flag disappears (it *is* `stopsPhase`); the "all
three decrement on every release" rule the module header shouts about becomes
one method instead of three adjacent statements at `:928-931` that a future edit
can desynchronise. Behaviour identical; ~30 lines and one boolean deleted.

This is also the only place the module's "THREE COUNTERS DECREMENT PER
SUCCESSFUL RELEASE" header rule is enforceable by construction rather than by
reading.

---

## Finding 3 (Medium) — the `findRunningLazyChild` departure is defended by an argument the module does not honour

The brief asked me to test this reasoning rather than accept or dismiss it.
`src/lib/solicitation/release.ts:493-500`:

> `null` is a legitimate answer, deliberately NOT an assertion. […] a throw here
> would abort the tick before phases 2 and 3 ever ran, letting one anomalous row
> hold every other account's wedged batch shut.

**The harm is real. The remedy does not deliver it.** The same
`sweepUnknownOutreach` loop body throws on at least four other paths, each with
exactly the effect the docstring calls unacceptable:

| Site | Throws when |
|---|---|
| `:421-425` | the batch row is missing for its own child's tenant — a deliberate `throw`, 40 lines *above* the null-return, justified as "ASSERT, do not branch" |
| `:467` `completeRun` | any run-spine write failure |
| `:473` `closeBatchIfSettled` | its own batch re-read finds nothing (its docstring says it throws on exactly that) |
| any statement | connection error, statement timeout, admission-gate rejection (`src/lib/db/admission.ts`) |

And the same applies phase-wide: `latchSystemHalt` at `:603` / `:675`,
`closeBatchIfSettled` at `:236`. `runReleaseCycle` (`:186-190`) awaits five
phases in sequence with **no error isolation anywhere**, so any throw in P1
skips P2–P5, any throw in P2 skips P3–P5, and so on.

The aggravating detail is the ordering. Every scan is `ORDER BY … ASC` —
`o.sending_at ASC` (`:383`), `approved_at ASC` (`:641`, `:731`, `:279`). A
**deterministic** per-item failure therefore re-selects the *same* item as the
first row of the same phase on every subsequent tick, forever. One poisoned row
or batch permanently disables the release lane platform-wide — which is issue
#915's wedge arriving through the door built to close it, the exact sentence
the module uses elsewhere (`:355-357`) to justify a different belt.

So the departure from "assert impossible states, don't branch around them" buys
one throw's worth of protection out of six, and the two hazards are not even
comparable: a missing running child is *anomalous*, a DB error is *routine*.

**Code-judo move that makes the departure unnecessary.** Wrap each sweep's
per-item body in `try/catch` (log-and-continue, one Sentry warning, count it in
the report). Then:

- the stated hazard is actually closed — for every throw site, not one;
- `findRunningLazyChild` can `throw` and obey the repo rule, because a throw now
  costs one row rather than the tick;
- the pattern matches the repo's own precedent for a loop that must not be
  stopped by one bad item (`StripeLocationsReconcilePoller.ts:443-458`,
  per-account `try/catch` inside the cycle).

Note the counter-precedent honestly: `JudgeSweepPoller.runJudgeSweepCycle`
(`:20-34`) has no per-item isolation either, and this module names it as its
precedent. The difference is that the Judge sweep is *one* phase whose failure
costs one tick of one job type, while this cycle is five phases where an early
failure starves four later ones — which is precisely why this module, and not
the Judge sweep, wrote the paragraph at `:493-500`.

---

## Finding 4 (Medium) — the tenant-scope baseline ledger under-accounts by five entries

`scripts/ci/tenant-scope-allowlist.ts:165-177` — the last dated bullet:

> `- 2026-08-22 (383 → 385): #900's release-candidate scan …`

`scripts/ci/tenant-scope-allowlist.ts:178`:

> `export const ALLOWLIST_BASELINE = 390;`

Seven entries were added (release-candidate ×2, send-window ×1, batch-expired
×2, `unknown` ×1, backstop ×1). `pnpm ci:tenant-scope` passes at 390/390, so the
constant is right and the audit is honest — it is the **ledger** that is wrong.
Five movements (385→386→…→390) have no bullet, although the deviations file
records each one (`…-deviations.md:152-153`, `:554`, `:700`, `:740`).

The file's own convention, unbroken for every prior movement in that comment
block, is one dated bullet per baseline change naming the from→to and the
reason. That block is the audit trail a reviewer reads to answer "why is this
number 390?"; today it answers 385. Nearest named standard: CLAUDE.md Working
rules — *"When deleting a doc or ticking a checklist item, fix its audit tick and
grep the filename to clean every cross-reference in the same change."*

**Fix.** One bullet: `- 2026-08-22 (383 → 390): #900's five release-cycle scans
— P4 (2 tables), P2 (1), P3 (2), P1 (1), P5 (1)`, with the shared justification
already written once in `RELEASE_CANDIDATE_SCAN_REASON` and pointed at rather
than repeated. The per-entry `*_REASON` prose is fine where it is; the ledger
just has to add up.

---

## Finding 5 (Low) — branch-execution narration shipped as permanent comments

Several comments describe an intermediate state of this branch and are false at
HEAD. Each will mislead the next reader in a specific way.

1. `src/lib/solicitation/__tests__/release.integration.test.ts:26-36` —
   *"THE `.fails` CONVENTION … `runReleaseCycle` throws `not implemented` today,
   so EVERY case below is registered with `it.fails` … Each later task deletes
   the `.fails` marker."* There are **zero** `it.fails` markers left anywhere in
   the repo (`grep -rn "it\.fails" src/ worker/ scripts/` returns only these two
   comments), and `runReleaseCycle` does not throw. A reader looking for the
   convention this header describes will not find it.
2. `src/lib/solicitation/__tests__/release.test.ts:7-12` — same claim, same
   falsity, plus *"Task 3 deletes the marker"* (already deleted).
3. `release.integration.test.ts:60-61, 76-84` and `:729-734` — *"`enqueueSolicitationSend`
   does not exist yet (#900 task 1)"* guarding a duplicated
   `typeof real === 'function' ? … : () => { throw new Error('… not implemented (#900 task 1)'); }`.
   The export exists (`src/lib/shared/job-outbox-helpers.ts:731`), so the else
   branch is **dead in two places** and unreachable by any test. Delete both
   ternaries and mock the real function directly.
4. `src/lib/solicitation/release.ts:184-185` — *"The scaffold is the phase order.
   Later tasks FILL these slots."* There are no later tasks; the slots are
   filled. The word "scaffold" describing finished, shipping code invites a
   future reader to treat the phase list as provisional, which is the opposite
   of the header's own point that the order is a contract.
5. `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts:182-183` — *"Its
   ONE spine write today is the `approval_downgraded` step; Tasks 4-7 add
   `completeRun` on the Lazy child and reach `closeBatchIfSettled`."* At HEAD
   `release.ts:467` already calls `completeRun` and `:473` already calls
   `closeBatchIfSettled`. This comment sits in the file that *guards* the
   spine anchor-pairing contract, so a stale inventory of that file's spine
   writes is the worst possible place for one.

None of these changes behaviour. Together they are the clearest sign in the diff
that the branch's task log leaked into its output.

---

## Finding 6 (Low) — third hand-copy of the upload/contact fixture pair

`src/lib/solicitation/__tests__/release.integration.test.ts:172-201` defines
`seedUpload` (a 13-column `contact_csv_uploads` INSERT) and `seedContact`. Both
already exist, near-identical modulo one label string and one parameter, at:

- `src/lib/solicitation/__tests__/approval.integration.test.ts:139` / `:156`
- `src/lib/solicitation/__tests__/outreach-close.integration.test.ts:62` / `:80`

`src/lib/shared/__tests__/helpers/outreach-fixture.ts` exists for precisely this
failure mode — its own header says *"Three suites re-spelled that set by hand …
a sixteenth NOT NULL column meant editing three files that had nothing to do
with the change"* — and this new suite already imports `checksum` from it
(`release.integration.test.ts:24`), while `outreach-close` still inlines the
same `padEnd(64,'0')` fabrication.

I read the helper's own carve-out honestly: it deliberately does **not** own the
upload → contact → batch → ask chain, because "the three callers need genuinely
different chains". That argument holds for `seedBatch`/`seedAsk`, whose
parameterisations really do diverge. It does **not** hold for `seedUpload` and
`seedContact`, which differ only in a filename prefix and a display name. Three
copies of a 13-column INSERT is the repo's own recorded extraction trigger
(CONTEXT.md **Ask withdrawal**: *"a THIRD caller is the signal to extract rather
than a second"*).

Concrete failure: one new NOT NULL column on `contact_csv_uploads` breaks three
suites in three files.

---

## Finding 7 (Low) — the release lane coins no glossary term

The branch introduces the send lane's largest module, a new closed union
(`ReleaseWithheldReason`, seven members: `flag_off`, `breaker_open`,
`platform_ceiling`, `account_cap`, `subscription`, `judge_unhealthy`,
`per_tick_budget`), a five-phase order named P1–P5, and a per-tick drip budget —
and amends `CONTEXT.md` in exactly **two places** (the **Halt latch** entry for
`latchSystemHalt`, the **Send breaker** entry for the pure-reader note). No term
is coined for the lane itself.

Every sibling concept in this map got a LOCKED entry from its implementing
ticket: **Dispatch gate** (#899), **Send breaker** / **Send breaker trip** /
**Breaker window** (#898), **Lazy child**, **Settled batch**, **Batch state**,
**Halt latch**. `CONTEXT.md` was on this branch's `allowed_edit_surface` from
intake, so nothing blocked it.

Consequence: the seven withhold reasons and the phase order are authoritative
only inside a source-file header comment. The next feature that touches release
pacing has no term to check itself against, and `release.ts`'s header — however
good — is not where a reader goes to find the shared language. The **Dispatch
gate** entry already gestures at this vocabulary from the outside ("*release
gate* (those are the three governors ABOVE it)") without anything defining it.

Worth noting as mitigation: the governor **order** is quoted from amendment B6
and is pinned by both the module header and `docs/directory.md`, so the
highest-risk fact is not homeless — only the vocabulary is.

---

## What I checked and found clean

Recording these so a later round does not re-derive them.

- **Invariant #2 (transactional outbox).** `releaseOutreachRow` (`:1161-1224`)
  performs the batch lock, the `rendered → queued` CAS, the `sending_started_at`
  stamp and `enqueueSolicitationSend` in one `sql.begin`. The enqueue goes
  through the new typed helper; `ci:outbox-seam` passes (16 helper-owned topics,
  no bypass) and `grep` confirms `enqueueSolicitationSend` is the sole producer
  of `solicitation_send` rows. The in-flight status set is re-spelled by hand,
  members and order, in all three places (`:381`, `:456`,
  `job-outbox-helpers.ts:747`); `ci:outbox-status` passes. The `null`-means-
  already-in-flight return and the caller's assert-don't-branch treatment of it
  (`:1212-1221`) are the right shape for a topic whose duplicate is a duplicate
  email.
- **Invariant #8 (tenant scope).** Every write in the cycle spells `account_id`
  **and** `business_id` in a top-level `WHERE`. The five cross-account SELECTs
  are read-only, project ids plus at most one lifecycle stamp, and are
  allowlisted under `background-global-scan` alongside the three existing peers.
  `ci:tenant-scope` passes at 390/390. No review text, contact handle, rendered
  subject/body or interpolation input crosses the boundary.
- **Invariant #11 (subscription guard).** `:873` uses
  `subscriptionGrantsFullAccess(status)`, never a raw `=== 'active'`;
  `ci:static-policy` passes.
- **Invariant #15 (injected DB client).** `release.ts` takes `Sql`/`TransactionSql`
  as parameters throughout and never imports `@/lib/db/server`; the poller is the
  composition root and is the only file that touches the singleton.
  `ci:db-imports` passes strict.
- **Invariant #12 (entry points orchestrate).** `SolicitationReleasePoller.ts` is
  74 lines and holds no rule — interval, timeout, singleton, guarded poll. The
  one piece of logic it does own (`getIntervalMs`'s extra rejection of intervals
  ≤ `CYCLE_TIMEOUT_MS`) is a property of the poller's own contract with
  `GuardedPollOptions`, so it belongs there.
- **Judge-split ordering.** The Judge is evaluated last, after the account cap,
  and `applyJudgeSplit` (`:1044`) returns `held` with **no writes** when
  `sending_started_at !== null`. `downgradeApproval` (`:1093`) moves all four
  approval columns together under the batch lock with `halted_at IS NULL AND
  send_closed_at IS NULL` arms. The lock order is batch → run everywhere,
  including inside `closeBatchIfSettled`.
- **Best-effort-after-primary-effect rule.** Both Sentry emissions
  (`alertUnknownTerminalization` `:534`, `applyJudgeSplit` `:1051`) are after the
  durable write, inside their own `try/catch`, with the logger outside the guard
  as the fallback sink. No id-only leak of body/subject/handle.
- **Glossary — Halt latch Avoid list.** No `pause`, `resume` or `cancel batch`
  anywhere in the new code (identifiers, comments or values). The `stop`
  occurrences are discussed in the appendix; none renames the latch.
- **`approval.ts` shape.** `readBatchForAction` is a genuine extraction, not a
  wrapper: `lockBatchForAction` = advisory lock + it, `latchSystemHalt` = it
  alone. `SystemHaltReason` is a two-member union pinned bidirectionally by
  `approval.test.ts:406-411` and structurally forced by 091's halt-consistency
  CHECK. `LatchHaltReason` stays unexported, source-pinned. Three arms over one
  private body is the right count — the file did not grow a fourth mechanism.
- **`docs/directory.md`.** Both new files carry rows and the `approval.ts` row
  was amended for the third arm; `ci:directory-map` passes.
- **`pnpm typecheck` and `pnpm lint`** are clean at HEAD.

---

## Low-confidence appendix

Things I would not stake 80% on, or that are matters of taste. Recorded so they
are not re-discovered, not to be actioned as-is.

**A. `runReleasePhase` takes `report` as an out-parameter.** Four phases return a
count; the fifth mutates a shared record (`:777-781`). Consistency argues for
returning a `Partial<ReleaseCycleReport>` and merging. Against: the phase reports
six different fields, and the merge would be its own small ceremony. Fowler would
call the current shape an output parameter; I would call it a wash.

**B. The docstring at `:770-771` says "the three checks below run once and refuse
every account".** There are four such early returns (`:784` flag, `:793` breaker,
`:805` platform, `:811` per-tick budget), and the fourth reports itself through
`withheldByReason` rather than `releasePhaseStoppedBy`, which the same paragraph
says are disjoint. Practical impact is nil — `perTickBudget <= 0` is only
reachable from a test that passes it — but an operator seeing
`releasePhaseStoppedBy: null` with `released: 0` gets a slightly wrong story
from the doc.

**C. "stop"/"stopped" in comments and one identifier.** `releasePhaseStoppedBy`
(`:124`), `stopPhase` (`:832`), and comments at `:23`, `:36`, `:770-775`, `:898`,
`:1155`. The **Halt latch** Avoid list bans `stop` in internal vocabulary. I do
**not** call this a violation: the list is directional — it forbids naming *the
latch* "stop" — and none of these refer to halting a batch; they refer to a
poller phase ending. Two comments come closest by applying the verb to a batch
("a batch the cap alone would simply have stopped", `:36` and `:898`); by the
module's own vocabulary the cap **withholds**, so `withheld` would be both more
accurate and clear of the Avoid list. Worth a one-word edit, not a finding.

**D. "release" as a coined word.** `CONTEXT.md`'s **Owner approval** entry lists
`release` on its Avoid list. That is directional too (do not call *approval*
"release"), and the **Dispatch gate** entry already uses "release gate" for this
lane's governors, which legitimises the branch's usage. Flagging only because
`src/lib/solicitation/` now contains two adjacent senses of the word and the
glossary defines neither (see finding 7).

**E. `readAccountDailySendCap` (`:987-998`) lives in `release.ts`, not
`send-caps.ts`.** `send-caps.ts` owns every other cap concept, including the
constant whose docstring names `auto_approval_policies.daily_send_cap`; the
release loop now carries that table's composite key (`persona='solicitation'`,
`action_class='sending'`, `location_id IS NULL`). Mild feature envy. I am not
raising it because the repo's established pattern is that each consumer reads
its own policy row (`worker/jobs/response-generation/auto-approval.ts:190`,
`src/lib/auto-approval/suspension.ts:114`), and there is exactly one reader of
this column today, so relocating it would be an abstraction for a single caller.
Revisit if a second reader appears.

**F. `selectRenderedOutreach` fetches `scanLimit` (50) rows per batch to release
at most `perTickBudget` (2).** Harmless — the projection is one id column — but
the two bounds are semantically unrelated and sharing `scanLimit` reads as reuse
rather than intent. `Math.min(scanLimit, perTickBudget)` would say what is meant.

**G. `release.test.ts`'s fake `Sql` routes on substrings of production SQL**
(`createFakeExecutor`, `:117-177`). It is a magic double coupled to statement
text: an innocuous rewrite of a `WHERE` clause can silently change which branch
matches. The property's non-vacuity assertion (`:282`) is a real mitigation and
is well argued in the file's own comment, and the alternative (driving 200
generated tick sequences against live Postgres) is genuinely unaffordable. Noted
as a known-fragile seam, not as a defect.

**H. `release.integration.test.ts` is 1,806 lines with a ~780-line preamble.**
The preamble is fixture builders and readers, not cases. Beyond finding 6's
three-way duplication I have no specific extraction to propose that would not
just relocate it, so I am not asking for one.

---

# TRIAGE — round 1, 2026-08-22 (orchestrator)

This agent declined to raise a file-size finding on `release.ts` and gave its
reasoning. That restraint is noted and was decisive: the adversarial agent DID
raise module shape, and this report's argument is why that finding was rejected.

- **Medium `latchSystemHalt` docstring inversion — ACCEPTED, FIX.** The strongest new finding in this table. The docstring and `CONTEXT.md` both say the caller must already hold the batch row lock; neither caller does, and the lock is taken inside by `readBatchForAction`'s `FOR UPDATE OF b`. As written the doc is a standing invitation to delete the only row lock on that path. The orchestrator relied on the inner lock when briefing Task 4 and did not notice the docstring contradicted it.
- **Medium duplicated guard blocks + `stopPhase` — ACCEPTED, DEFERRED.** Valid. Deferred to a follow-up issue by owner decision: it is a refactor of code all three agents just reviewed in its current shape, on a branch already 2.1x its line estimate. Refactoring reviewed code at review time re-opens what was just closed.
- **Medium error isolation — ACCEPTED, FIX.** Sharper than the adversarial agent's version of the same concern and this is the one being actioned: five throw sites do exactly what the `findRunningLazyChild` docstring says must not happen, and with every scan `ORDER BY … ASC` one deterministic failure re-selects the same item every tick, starving P2–P5 permanently.
- **Medium tenant-scope ledger — ACCEPTED, FIX.** Corroborated by the adversarial agent. Orchestrator's own error.
- **Low stale task-log comments — ACCEPTED, FIX.** Four statements are false at HEAD. Comments that lie are worse than no comments.
- **Low third `seedUpload` copy — ACCEPTED, DEFERRED.** Valid and correctly reasoned (one new NOT NULL column breaks three files). Deferred with G to the same follow-up issue: test-fixture consolidation touches two files this branch never opened.
- **Low no glossary term coined — ACCEPTED, DEFERRED.** A fair observation: every sibling send-lane concept has a `CONTEXT.md` term. Deferred to the same follow-up; coining a LOCKED term is a domain-modelling act that deserves its own deliberation, not a review-time patch.

---

# ROUND 2 VERIFICATION

Verification-only pass over `git diff a23d8afd..HEAD` (`cabeff32`, `1bd27676`).
No live-DB suite was executed (two sibling verifiers share the machine and the
test database); evidence below is read + `pnpm typecheck` + `pnpm ci:tenant-scope`,
on top of the orchestrator's `verify-gate.sh --review` GREEN at `1bd27676`.

## Summary

| finding | fixed? | evidence |
|---|---|---|
| 1 — `latchSystemHalt` docstring inversion | **YES** | All three sites corrected and now mutually consistent: `approval.ts:794-801`, `approval.ts:182-184` (`readBatchForAction`), `CONTEXT.md` **Halt latch**. `rg "already hold\|caller's obligation"` over `src worker docs CONTEXT.md .claude` returns no surviving copy of the old premise. The two `release.ts` sweep docstrings (`:711`, `:791`) already said the true thing and still do — five descriptions of the seam, one fact. |
| 2 — error isolation | **YES** (with a residual, new finding N1) | All five per-item loops isolated: `isolateItem` at `release.ts:335` (P5), `:429` (P1), `:723` (P2), `:801` (P3); bare `try`/`recordItemFailure` at `:1002-1081` (P4). Every round-1 throw site is inside one of them. No silent catch. `ReleaseCycleReport.itemFailures` reaches the tick line (`SolicitationReleasePoller.ts:58` spreads the whole report). `findRunningLazyChild`'s new justification is TRUE. |
| 3 — tenant-scope ledger | **YES** | `tenant-scope-allowlist.ts:165-201` now reads 383→385→386→388→389→390, contiguous, terminating at `ALLOWLIST_BASELINE = 390` (`:202`). `pnpm ci:tenant-scope` → `passed — entries: 390 (baseline: 390)` after the P4 SQL re-pin. |
| 4 — stale task-log comments | **YES** for the five named sites; **PARTIAL** repo-wide (new finding N2) | All four false statements gone, dead `not implemented (#900 task 1)` branch removed from both sites. Real-trap comments KEPT. One same-class comment outside the round-1 site list now dangles. |
| deferred: guard blocks + `stopPhase` | unchanged (correct) | Three copies of the guard triple survive at `release.ts:983-993`, `:1025-1039`, `:1039-1053`; `stopPhase` still undocumented. Not re-raised — #919. |
| deferred: `seedUpload` copies | unchanged across files; **grew in-file** (new finding N3) | The three cross-file copies are untouched. |
| deferred: no glossary term | unchanged (correct) | `CONTEXT.md` diff touches only **Halt latch**. Not re-raised — #919. |

## Fix 1 — the lock docstring

The round-1 requirement was that all three descriptions say the same true thing,
because a partial fix is worse than none. Verified:

- `approval.ts:794-801` — "**IT TAKES THE BATCH ROW LOCK ITSELF, and there is no
  caller precondition to forget**", naming the correction and stating what
  deleting the lock would cost.
- `approval.ts:182-184` (`readBatchForAction`, the docstring round 1 did not
  name but which repeated the same false premise) — now "for `latchSystemHalt`
  it is the **only** row lock on that path — its sweep callers hold nothing when
  they call in. Never delete it as a redundant re-take." The sentence that
  invited the deletion ("re-taking a lock this transaction already holds is a
  no-op") is gone.
- `CONTEXT.md` **Halt latch** — "select candidates outside any lock and hold
  **no** lock across the call".

No fourth spelling exists. Consistency check across all five mentions of
`FOR UPDATE OF b` in the two files passes.

## Fix 2 — error isolation

**Every round-1 throw site is now isolated.** The round-1 table listed
`terminalizeWedgedOutreach`'s deliberate throw, `completeRun`,
`closeBatchIfSettled`, any statement-level DB error (P1), `latchSystemHalt`
(P2/P3) and `closeBatchIfSettled` (P5). P1/P2/P3/P5 are wrapped by
`isolateItem`; P4 by the bare `try` at `:1002`. Nothing that round 1 named
survives unwrapped. The phase SCANS are deliberately outside, and
`isolateItem`'s docstring says so and gives the right reason (a scan failure has
no item to blame; the crash-net owns it) — that is a correct departure, not a
gap.

**No silent catch.** `recordItemFailure` (`:228-247`) counts, then
`Sentry.captureException` inside its own `try`, then `logger.error` **outside**
that guard. That is byte-for-byte the shape of the two existing alert helpers in
the same file (`alertUnknownTerminalization:655-677`, `applyJudgeSplit:1260-1282`),
which themselves cite `emitConsentEvent` / `llmCircuitBreaker.emitTransition`.
Precedent followed, not invented.

**`isolateItem` is not a single-caller abstraction.** Four call sites (`:335`,
`:429`, `:723`, `:801`). `recordItemFailure` has two (`isolateItem` + P4).
`tallyPhase` has four. `PhaseTally` is used by four functions. The house rule is
satisfied by a wide margin.

**`findRunningLazyChild`'s new justification is true.** The old one ("a throw
would abort the tick before phases 2 and 3") is now false and has been removed
rather than left standing. The replacement — a throw would roll the transaction
back, leave the Outreach row `sending`, and P1 would re-select and re-fail it
every tick — is exactly what the code does: `terminalizeWedgedOutreach` runs
inside `sql.begin`, and P1's scan is `ORDER BY` on the wedged row. The stronger
consequence is also right: the sweep exists to unwedge `sending` rows, so
refusing to terminalize one because its spine half has nothing to write
re-creates #915 inside the sweep built to close it.

**`no-any` / typing.** No `any` anywhere in the new code. The fix also *removed*
two `as Record<string, unknown>` casts from the integration test in favour of
`vi.importActual<typeof import(...)>` — a net improvement.

`pnpm typecheck` clean.

## Fix 3 — the ledger

Contiguous and terminating at the constant. Note the fix also re-pinned
`RELEASE_CANDIDATE_SCAN_SQL` for the new `capped_accounts` CTE and argued in
`RELEASE_CANDIDATE_SCAN_REASON` why the second `solicitation_outreach`
occurrence shares one entry (matching is by file+table+normalized SQL). The
audit agrees: 390/390.

## Fix 4 — the stale comments

- `release.integration.test.ts` — the 11-line `.fails` convention header deleted;
  the "Live-DB conventions this file obeys (`ci:live-db-suites`)" block, which
  records a real trap, **kept**. Correct call.
- `release.test.ts` — `.fails` paragraph deleted, `(#900 task 0, the eval task)`
  trimmed to `(#900)`; the "WHY A FAKE EXECUTOR AND NOT THE LIVE DATABASE"
  paragraph **kept**. Correct call.
- both `not implemented (#900 task 1)` ternaries deleted (`:62-65`, `:824-826`),
  replaced by a direct typed delegate.
- `release.ts:184-185` — "The scaffold is the phase order. Later tasks FILL these
  slots" → "The list IS the phase order… Nothing here may be reordered or run
  conditionally." The contract survives; the branch narration does not.
- `outcome-anchor-pairing.test.ts:181-186` — the spine-write inventory is now
  accurate (three writes, four `closeBatchIfSettled` call sites), which matters
  because that file guards the anchor-pairing contract.

`rg "it\.fails"` over `src worker scripts` returns exactly one hit — see N2.

---

## New findings introduced or left by the fixes

| # | Severity | file:line | Finding |
|---|---|---|---|
| N1 | Medium | `src/lib/solicitation/release.ts:1002-1081` | P4's isolation unit is the ACCOUNT, but the throws it isolates are per-BATCH and per-ROW; one poisoned batch still starves that account's remaining batches on every tick until they age out. |
| N2 | Low | `worker/background/pollers/__tests__/SolicitationReleasePoller.test.ts:18-19` | Deleting the `.fails` convention left the only back-reference to it dangling — the repo now has a comment that answers a question nothing asks. |
| N3 | Low | `src/lib/solicitation/__tests__/release.integration.test.ts:484-547` | `seedCappedForeignCandidate` re-spells FIVE of the file's own seed helpers inline because each hard-codes `accountId()`/`userId()`. New code, same file, distinct from deferred finding 6. |

### N1 (Medium) — P4 isolates the account, but the failures are per-batch

`isolateItem`'s own docstring states the principle the fix adopted: *"One
poisoned item must cost one item, not the lane."* P4 does not meet it. The
`try` at `:1002` opens before gate 4 and closes at `:1080`, so it spans the
per-account gate reads **and** the whole `for (const batch of accountBatches)`
loop at `:1024` **and** the per-outreach loop inside it. A throw from
`judgeAvailable()`, `applyJudgeSplit`, `selectRenderedOutreach` or
`releaseOutreachRow` — all per-batch or per-row — therefore discards every
remaining batch of that account.

That is the round-1 wedge, narrowed rather than closed:

- `selectReleaseCandidates` is `ORDER BY b.approved_at ASC` (`:1161`);
- `groupByAccount` (`:1166-1177`) is insertion-ordered and its own docstring says
  so — *"the oldest approval still leads inside each account"*;
- so the poisoned batch leads its account's group on **every** subsequent tick,
  and the account's other approved batches release nothing until they cross
  `BATCH_SEND_WINDOW_HOURS` and P2 latches them `send_window_elapsed` —
  owner-approved batches destroyed by an unrelated row's failure.

Blast radius is one account for up to 72h rather than the platform forever, so
this is strictly better than round 1. But the comment at `:997-1001` overstates
it — *"costs its own tick and no one else's"* — when it costs that account
**every** tick.

The stated justification does not justify the granularity, either. It reads:
*"A bare `try` rather than `isolateItem` because the body's `continue` and
`break` target these loops and may not cross a function boundary."* That argues
for a bare `try` over the wrapper — which is right — not for the account as the
unit. A second bare `try` around the body of `for (const batch of accountBatches)`
uses the identical technique: its inner `break`s target the candidate loop, which
would sit inside the try, and its `continue` targets the batch loop, which is
legal from inside a `try`. The finer unit is available at the same cost.

**Fix.** Either move the isolation to the batch (a second bare `try` at `:1025`
with `recordItemFailure('release', { account_id, batch_id }, …)`, leaving the
account-level one for the two gate reads that are genuinely per-account), or —
if the account really is the intended unit — say so honestly at `:997`: the unit
is the account, a per-batch failure costs the account's whole tick, and it
recurs deterministically.

### N2 (Low) — the deleted `.fails` convention left a dangling reference

`SolicitationReleasePoller.test.ts:18-19`:

> `// These need no `.fails` marker: the poller and its exports already exist, so`
> `// every case below is green from this commit.`

This is a branch file (added by this branch) and was not on round 1's site list,
so it is not a re-raise — it became dangling **because** the fix deleted the two
blocks that defined the convention. `rg "it\.fails|\.fails\b"` over `src worker
scripts` now returns this comment and nothing else. CLAUDE.md Working rules:
*"When deleting a doc … grep the filename to clean every cross-reference in the
same change."* Same act, same rule.

Its line 3 also still carries the full `(#900 task 0, the eval task)` form that
`release.test.ts:6` was trimmed to `(#900)` — a one-word inconsistency worth
folding into the same edit.

**Fix.** Delete `:18-19`; trim `:3` to `(#900)`. The paragraph above them —
why the poller is a shallow composition root and asserts no rules — is a real
trap and must stay.

### N3 (Low) — a fourth copy of the fixture pair, this time inside the file

`seedCappedForeignCandidate` (`:484-547`) inlines `contact_csv_uploads` (a copy
of `seedUpload:173`), `solicitation_batches` (`seedBatch:237`), `agent_runs`
(`seedSendParent:307`), `solicitation_contacts` (`seedContact:190`) and
`solicitation_asks` (`seedAsk:353`). It correctly reuses the shared
`insertOutreach` helper for the sixth.

The cause is mechanical and cheap to remove: every one of those five helpers
closes over `accountId()` / `userId()` rather than taking them, so a
second-tenant fixture cannot call any of them. Widening five signatures in ONE
file removes ~60 lines of duplicated DDL-shaped SQL.

This is **not** deferred finding 6 re-raised. Finding 6 is about three
near-identical copies across three files and was deferred to #919 as
"test-fixture consolidation touches two files this branch never opened". N3 is
new code added by `cabeff32`, entirely inside a file this branch owns, and the
remedy is local to it. The reason it is worth an entry rather than a shrug is
finding 6's own argument: one new `NOT NULL` column on `contact_csv_uploads` now
breaks four sites instead of three, and this file now contains two spellings of
the same INSERT with nothing marking which is canonical.

---

## Untriaged appendix (out of round-2 scope — unchanged code, not raised)

- `src/lib/solicitation/__tests__/batch-view.integration.test.ts:32` ("A namespace
  access is `undefined` until Task 3 lands") and
  `src/lib/solicitation/__tests__/dispatch.integration.test.ts:1259` ("Task 3 —")
  are the same task-log-narration class as finding 5 but belong to earlier
  branches (#629 / #899) and are untouched here. Not this branch's to fix.
- The module-header rewrite at `release.ts:44-55` ("SINGLE-REPLICA DOES NOT MEAN
  SINGLE-CONCURRENT-CYCLE") makes a factual claim about `guarded-poll.ts`. Spot-
  checked and TRUE: `worker/background/guarded-poll.ts:80` states the detached
  contract and `:107-112` frees `inFlight` in `finally` after `withTimeout`
  rejects. No new lying comment.

## ROUND 2 TRIAGE (orchestrator, 2026-08-22)

All four round-1 fixes on this axis verified YES. Three new findings, all accepted:

- **N1 P4 isolation granularity — ACCEPT, FIX.** Verified at `release.ts:1002`: the `try` wraps the whole account block INCLUDING the per-batch loop, while `applyJudgeSplit`, `selectRenderedOutreach` and `releaseOutreachRow` are per-batch/per-row. One poisoned batch discards that account's remaining batches every tick until they cross 72h. That is round 1's wedge narrowed, not closed — unacceptable on the branch whose purpose is closing a wedge — and the comment at `:997` ("costs its own tick and no one else's") is true only at account level, which is the kind of comment that stops the next reader looking.
- **N2 orphaned `.fails` back-reference — ACCEPT, FIX.** Verified: it is now the ONLY `.fails` hit in `src`, `worker` and `scripts`, explaining itself against a convention the fix deleted. CLAUDE.md is explicit — grep the filename and clean every cross-reference in the same change.
- **N3 in-file seed duplication — ACCEPT, FIX.** Accepted even though its cross-file cousin is deferred to #919, and the distinction is deliberate: #919 covers three files this branch never opened, while N3 is duplication the fix round ITSELF introduced into a file the branch owns. Leaving new duplication because an older instance was deferred is the wrong lesson.

The three deferred findings were correctly confirmed unchanged and not re-raised.
