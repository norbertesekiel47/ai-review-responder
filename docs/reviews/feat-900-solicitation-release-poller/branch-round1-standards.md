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
