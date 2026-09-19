# Spec & correctness review — `refactor/616-fallow-complexity`

- Fork point: `eba43bcca97325026a79cd3041cc25bf37e0c3f3`
- HEAD reviewed: `6c95db21c6445dd390d8633db8af97775e6cefef`
- Mode: READ-ONLY. No source or test file edited. Gate scripts not run (orchestrator owns gate evidence).
- Commands run: `git diff/show`, `rg`/`grep`, `pnpm ci:weakened-checks`, `pnpm ci:tenant-scope`,
  `pnpm ci:db-imports`, `pnpm ci:directory-map`, `npx fallow health --complexity --format json`
  (output redirected to the session scratchpad, **not** `.feature/`), and one throwaway `tsc --noEmit`
  on a scratch file outside the repo.

---

## 1. The central claim: "behavior is byte-identical"

I attacked the four questions in the brief. All four hold. Detail below, because the
value of this review is in the attempt, not the verdict.

### 1.1 `logger.ts` — JSON key order across every arg combination

Pre-refactor body (`git show eba43bcca:src/lib/shared/logger.ts`, `emit` at :47) writes the
record in exactly this statement order:

1. seed `{timestamp, level, service, logger, message:''}`
2. `CONTEXT_FIELDS` loop → context ids
3. factory `correlation_id`, only when `record.correlation_id === undefined`
4. arg loop — **only Error args touch `record`** (`Object.assign(record, serializeError(arg))`);
   strings/numbers/booleans go to a local `messageParts`, objects to a local `data`
5. `record.message = messageParts.join(' ')` (re-assignment of a seeded key — does not move it)
6. `if (data && Object.keys(data).length > 0) record.data = data`

Post-refactor (`src/lib/shared/logger.ts:152-167`) is:

1-3. `buildBaseRecord` — byte-identical statements
4. `collectLogArgs` — same classification order (`messagePart` covers the `string` then
   `number|boolean` arms, then `instanceof Error`, then `arg && typeof arg === 'object'`),
   but error fields accumulate into a **separate** `errorFields` object
5. `Object.assign(record, errorFields)` → `record.message = message` → `if (data) record.data = data`

The deferral is safe **because nothing else wrote to `record` during the pre-refactor loop**.
Error fields were already contiguous, already positioned immediately after the context block,
already ordered by arrival (`Object.assign` onto an existing key preserves position), and
already ahead of `message`'s re-assignment and `data`. Deferring an assignment that was already
contiguous and terminal cannot reorder it. Checked combinations:

| combination | pre | post | same |
|---|---|---|---|
| empty args | `message:''`, no `data` | same (`messageParts.join('')` → `''`) | ✔ |
| string/number/boolean only, incl. `false`/`0` | `typeof` test, both appear | `messagePart` is `typeof`, not truthiness; `part !== undefined` guard keeps `''` and `0` | ✔ |
| `null` / `undefined` / symbol / function | dropped (`arg &&` keeps `null` out; `typeof function !== 'object'`) | identical guards | ✔ |
| object arg sanitizing to `{}` | no `data` key | `collectLogArgs` returns `data: undefined` under the same `Object.keys().length > 0` test | ✔ |
| several object args, one throwing | spread accumulation + `{...data, unserializable:true}` | `mergeObjectArg` identical; throw happens inside the spread expression, so the assignment never lands | ✔ |
| several Error args, later one without `stack` | `error_stack` from the first survives (guarded `if (!requiresProductionConfig() && err.stack)`) | same `serializeError`, same accumulate-by-`Object.assign` | ✔ |
| bound `correlation_id` + factory id | bound wins (`record.correlation_id === undefined` test) | same test inside `buildBaseRecord` | ✔ |
| unserializable record | `JSON.stringify({message: record.message, unserializable:true})`, evaluated after `record.message` was set | `stringifyRecord(record)` called after `record.message = message` | ✔ |

`sanitizeAnalyticsProperties` is unchanged (`src/lib/analytics/events.ts:110-128`) and
`LogContext` is all-optional-string (`src/lib/shared/log-context.ts:7-16`), so the
"only an `Error` can trigger the record-level fallback" reasoning in the intake's
`edge_cases[0]` is correct at HEAD.

Public surface: `createWorkerLogger`, `toError`, `logUnhandledPollError` unchanged
(same signatures, same bodies). Blast radius of 140 importers is therefore purely
mechanical — none of them reaches an `emit` internal, and all six new helpers are
unexported. Verified there is no named import of anything else from `logger.ts`.

**Verdict: no finding.** `non_goals[0]` ("identical JSON log lines — same keys, same key
order, same values") is met.

### 1.2 The asymmetric reservation contract

Compared `git show eba43bcca:worker/jobs/OnboardingDemoWorker.ts` against HEAD line by line.
Every boundary is preserved:

| path | pre | post | release? |
|---|---|---|---|
| subscription SELECT rejects | outside outer `try` (:67) | now inside `guardOnboardingDemoSubscription`, but the `await guard…()` at `OnboardingDemoWorker.ts:87-95` is itself outside any `try`, and the guard's own `try` starts **after** the SELECT (`subscription-guard.ts:44-49`) | none — unchanged |
| `claimDemo` rejects | outside outer `try` (:92) | `OnboardingDemoWorker.ts:98`, outside | none — unchanged |
| `markOutboxCompleted` rejects | outside outer `try` (:99) | `OnboardingDemoWorker.ts:101`, outside | none — unchanged |
| `not_found` / `already_terminal` / `race_lost` | `markOutboxCompleted` then one `releaseReservation()` | same, via `leavesNoWorkToDo` | exactly once — unchanged |
| `reset_to_queued` | throws, no release | `OnboardingDemoWorker.ts:107` identical throw, identical message | none — unchanged |
| subscription changed | `try { failTerminal } finally { release }` | moved verbatim into `subscription-guard.ts:50-70`; release still precedes the re-throw | exactly once — unchanged |
| generic terminal failure | `try { failTerminal } finally { release }` | unchanged, still in the root's outer catch | exactly once — unchanged |
| success | finalize actual, never release | unchanged | never — unchanged |

The De Morgan inversion in `subscription-guard.ts:46-48`
(`if (!biz || status === PENDING_PAYMENT) return false`) is exactly the negation of the
pre-refactor `if (biz && status !== PENDING_PAYMENT)`. Missing-row → not handled, which
matches `edge_cases[6]`.

**Verdict: no finding.** The extraction moved no boundary.

### 1.3 `finalizeOnboardingDemoCost` exactly-once on the success path

`src/lib/costs/onboarding-demo-cost-guard.ts:93` applies `delta = actualCostCents -
RESERVATION_CENTS` unconditionally, so the non-idempotence claim is real. On the post-refactor
success path (`OnboardingDemoWorker.ts:126-143`) the only `finalizeCost` invocation is the one
inside `finalizeOnboardingDemoSpend`, which is guarded by `if (!input.reservationDate) return`
and wraps the call in its own catch. `reportOnboardingDemoCostThresholds` swallows everything,
and `logger.log` is fail-open twice over, so the outer catch — the only other release site —
is unreachable once `completeDemo` resolves. Exactly once, never also released.

`worker/jobs/__tests__/OnboardingDemoWorker.test.ts:238-296` pins this with
`toHaveBeenCalledTimes(1)` plus a hand-resolved `completeDemo` promise, which is a materially
stronger assertion than `mock.invocationCallOrder` (it kills the `void completeDemo` mutation).

**Verdict: no finding.**

### 1.4 The guard's SQL after the file move

The template literal in `subscription-guard.ts:37-43` is byte-identical to the pre-refactor
one including indentation; only the interpolation spelling changed (`${demoId}` →
`${input.demoId}`, same value). The `const { sql } = input` destructure preserves the `sql`
tag spelling the CI scanners match on (#592) — without it the tenant-scope, outbox-status and
reviews-status audits would silently skip the query.

`scripts/ci/tenant-scope-allowlist.ts:1801-1820` moves all three entries (`accounts`,
`businesses`, `onboarding_demos`) to the new file with the `${input.demoId}` snippet, and
`pnpm ci:tenant-scope` passes at **380 entries / baseline 380** — no widening.
`pnpm ci:db-imports` passes strict (the guard takes `sql: Sql` and never imports
`@/lib/db/server`, satisfying invariant #15). `pnpm ci:directory-map` passes with rows for both
new files.

**Verdict: no finding.**

### 1.5 The fallow claim itself

`npx fallow health --complexity --format json` at HEAD: **161 project findings total,
0 for `src/lib/shared/logger.ts`, `worker/jobs/OnboardingDemoWorker.ts` or
`worker/jobs/onboarding-demo/`**. The six new logger helpers and the two new worker modules
are themselves finding-free, so the complexity was decomposed rather than displaced.
(Note: a `coverage/` directory is present in this worktree, so my run used coverage data;
D7's stronger claim — clean with *no* coverage data — is not something I re-derived.)

No `fallow-ignore` pragma, no `.fallowrc.jsonc` change, no `.github/workflows/fallow.yml`
change → `non_goals[1]` and `non_goals[6]` met.

### 1.6 Contract sweep

- **`allowed_edit_surface`**: all 16 changed paths are inside it. No scope creep.
- **`tests_to_add`**: all **28/28** promised titles present verbatim across the three test
  files (verified by string match against the intake JSON).
- **"No pre-existing test body modified"**: `git diff` removes exactly **5** lines across the
  two pre-existing test files, all of them the two `vi.mock` factory literals D6 declares.
  `stages.test.ts` is +311/-0. Claim holds.
- **`non_goals`**: no schema, migration, flag, env var or dependency in the diff; cost-guard
  arithmetic and the `[50, 90, 100]` threshold set untouched; no new top-level directory;
  public logger API unchanged.
- **`observability`**: the completion line text, the `onboarding_demo_cost_threshold_<t>`
  message names, the level ladder (`error`/`warning`/`info`) and the `{lane, threshold}` tags
  are all preserved and now pinned by `stages.test.ts` with `toHaveBeenNthCalledWith`.

---

## 2. Findings (≥80% confidence)

### F1 — low — `docs/superpowers/plans/refactor-616-fallow-complexity-plan.md:606-612`

**A block explicitly headed "Verified citations" contains two wrong line numbers, and the
same wrong number is propagated into the locked intake and the deviations record.**

Contract field: `docs/reviews/finding-checklists/spec-correctness.md` — accepted class
*"Eight stale file:line citations, most introduced by this very commit moving its own
targets"* (medium) and *"arch-review-log cites … ; the block is at L129-133 at HEAD"* (low).
Also CLAUDE.md "Gate evidence": *"Re-check cited line numbers and doc claims against current
HEAD before repeating them."*

Evidence, all re-resolved at HEAD:

| citation | where | actual |
|---|---|---|
| `src/lib/costs/onboarding-demo-cost-guard.ts:86` | plan.md:609 ("Verified citations"), deviations.md:111 and :119, intake.json `invariants` | `const delta = …` is at **:93**; `:86` is `): Promise<void> {`. Wrong at the merge-base too — that file is untouched by this branch, so the "verification" confirmed the fact and not the citation. |
| `src/lib/demos/lifecycle.ts:191` | plan.md:362, :406, :606; deviations.md:193 | the `typeof outboxAttempt === 'number'` branch is at **:190**, the `AND attempts = ${outboxAttempt}` predicate at **:196**; `:191` is `await tx\``. |
| `OnboardingDemoWorker.ts:136` and `:154-156` | plan.md:664, written post-implementation in the present tense ("now assert the exact strings from …") | those two diagnostic strings no longer live in that file at all — they are at `worker/jobs/onboarding-demo/cost-reconcile.ts:29-31` and `:61-63`. `OnboardingDemoWorker.ts:136` is `reservationDate,`; `:154-156` is inside the outer catch's `failOnboardingDemoTerminal` call. |
| `OnboardingDemoWorker.ts:67`, `:92`, `:99` | deviations.md:99 and :118, present tense in the D3 **verdict** | correct at the merge-base, stale at HEAD; two of the three call sites moved to a different file. |
| `stages.test.ts:281` | deviations.md:60 (D1 verdict, offered as the proof that the injection seam works) | `:281` is `googlePlaceId: validPlaceId,` inside the `buildOnboardingDemoSource` describe. The `failOnboardingDemoTerminal` describe begins at **:295**. |

**Failure scenario:** the next reader to act on D3 — the entry the read-back summary
singles out as the most valuable thing the review produced — opens
`onboarding-demo-cost-guard.ts:86`, sees a function signature, cannot confirm the
non-idempotence claim, and either re-derives it or, worse, concludes the claim is stale and
"fixes" the success path into a double-finalize. That is the exact corruption the invariant
exists to prevent. The `:136` / `:154-156` pair is the sharper case: it is a post-hoc claim
about where the newly asserted strings live, made stale by the very commit that wrote it.

### F2 — low — `docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md:243` and `:256`

**D7's stated justification for keeping a single-caller predicate is false: adding a sixth
`ClaimResult` outcome is NOT a compile error, and the outcome would silently take the
do-the-work path.**

Contract field: the D7 verdict is the record that admits `leavesNoWorkToDo` is "named debt"
against CLAUDE.md's *"no abstractions for a single caller"*, and the type-safety argument is
half of what buys that exemption. The brief instructs me to challenge a verdict's reasoning.

Evidence — I compiled the exact shape against this repo's `tsc` (strict), with a sixth member
added to the union and the function body copied verbatim from
`worker/jobs/OnboardingDemoWorker.ts:48-54`:

```
type ClaimResult = 'claimed'|'already_terminal'|'race_lost'|'not_found'|'reset_to_queued'|'sixth_outcome';
function leavesNoWorkToDo(claimResult: ClaimResult): boolean {
  return claimResult === 'not_found' || claimResult === 'already_terminal' || claimResult === 'race_lost';
}
export const x = leavesNoWorkToDo('sixth_outcome');
```
`node_modules/.bin/tsc --noEmit --strict` → **exit 0**. A `===` comparison against a union only
errors when a member is *removed*, never when one is *added*. The function has no exhaustive
switch and no `never` assertion.

**Failure scenario:** someone adds a sixth outcome to `ClaimResult` (say `'deferred'`).
`leavesNoWorkToDo` returns `false`; `OnboardingDemoWorker.ts:107` (`claimResult ===
'reset_to_queued'`) is false; control falls through to the comment
`// claimResult === 'claimed' — proceed.` at `:110` and the worker **runs the whole demo
including LLM spend** on a row it never claimed. This is precisely the "silent fall-through"
D7 claims is impossible here. No regression against the merge-base (the inline chain behaved
the same), but the recorded rationale is wrong and would survive into the next reviewer's
reasoning. The honest fix is one line — an exhaustive `switch` or a `const _never: never =
claimResult` tail — or deleting the claim.

### F3 — low — `docs/directory/worker-jobs-c.md:22`

**The branch edited two rows of this table to state the corrected reservation contract while
leaving the adjacent `reservation.ts` row asserting the exact invariant D3 proved false.**

Row as it stands: *"`releaseOnboardingDemoReservation` — calls the injected
`finalizeCost(date, 0)` to release the pessimistic reserve **on every no-work path**…"*

Contract field: intake `invariants` — the narrowed reservation contract ("`reset_to_queued`
deliberately does NOT release… A rejection BEFORE or DURING the claim… also do NOT release")
— and CLAUDE.md *"grep the filename to clean every cross-reference in the same change"*.

Evidence: the branch added `worker-jobs-a.md`'s new `OnboardingDemoWorker.ts` row, which
correctly reads *"`reset_to_queued` throws and deliberately does NOT release; a rejection
before the outer try releases nothing"*. The two rows now contradict each other, in adjacent
files of the same directory map, produced by the same commit. `ci:directory-map` is a
presence check and cannot catch it.

**Failure scenario:** the next engineer on this lane reads the package page (the more specific
one, and the one the CLAUDE.md router points at for `worker/jobs/onboarding-demo/`), concludes
the reserve is released on every no-work path, and "fixes" the `reset_to_queued` throw to
release first — double-counting the daily budget on every stale-running retry, since the demo
re-runs on the same reserve. That is the single most expensive mistake available in this lane
and it is the one D3 exists to prevent.

### F4 — low — `worker/jobs/__tests__/OnboardingDemoWorker.test.ts:297-317`

**The new terminal-claim test asserts call *counts* only, so the `outboxAttempt` argument to
`markOutboxCompleted` — the completion-side half of the attempt CAS — is pinned nowhere in
the repo. The branch closes exactly this gap on the `failDemo` side and leaves the sibling
open in the test it wrote for that branch.**

Contract field: conditional review axis (outbox attempt predicate); intake `test_seams`; the
branch's own D6/F3 rationale, which calls forwarding `outboxAttempt` "load-bearing" because
`failDemo` adds `AND attempts = $n` only for a number.

Evidence: `grep -n mockMarkOutboxCompleted worker/jobs/__tests__/OnboardingDemoWorker.test.ts`
returns only `toHaveBeenCalledTimes(1)` (:312), `not.toHaveBeenCalled()` (:328) and a
`mockRejectedValue` arrangement (:356) — no `toHaveBeenCalledWith` anywhere in the file.
`markOutboxCompleted` (`src/lib/shared/outbox.ts:86-92`) delegates to
`markOutboxCompletedIfOwned`, whose `dispatchedRow(exec, outboxId, attempt)` adds the same
attempt predicate and whose `warnOutboxNoop` fires only when an attempt was supplied.

**Failure scenario:** a future rewire (or this one, had it slipped) drops `outboxAttempt` from
`OnboardingDemoWorker.ts:101`. Every test in this file still passes — the D6 harness default
returns `attempt: undefined`, and the new test only counts calls. In production a stale worker
that lost the claim race then completes the job_outbox row for a **newer** dispatch attempt,
and the `warnOutboxNoop` signal that would have surfaced it is suppressed because the attempt
is `undefined`. One `toHaveBeenCalledWith(mockSql, 'outbox-demo-1', undefined)` — or reusing
the existing `mockReturnValueOnce({outboxId, attempt: 4})` override — closes it.

---

## 3. Weakened checks

`pnpm ci:weakened-checks` → **`weakened-checks-audit: passed (no finding)`**.
There are **zero REVIEW rows** on this branch, so there is no per-row protection-loss
accounting to give. That is consistent with the diff: no assertion was deleted, no allowlist
was widened (`ci:tenant-scope` reports 380 entries against a baseline of 380 — the three
onboarding-demo entries were *moved*, not added), no threshold was relaxed, and no test body
was changed beyond the two D6-declared `vi.mock` factory literals.

### 3.1 Can the new tests pass while the promised behavior is wrong?

| promised behavior | can a wrong implementation pass? | note |
|---|---|---|
| byte-identical log line | **No.** `logger.test.ts` asserts the exact raw string under fake timers with `LOG_SERVICE` unset and stacks suppressed, plus `toHaveBeenCalledTimes(1)` on the sink and `not.toHaveBeenCalled()` on the other two. This kills pretty-printing, duplicate writes and wrong-sink routing. | strongest test on the branch |
| key order | **No** for any reordering that is actually reachable. `JSON.parse` preserves insertion order for non-integer keys, so the `Object.keys` assertion is sound. Note the mutations it *cannot* catch — swapping `Object.assign(record, errorFields)` with `record.message = message`, or moving `record.message` after `record.data` — are no-ops, because `message` is seeded. Nothing is lost. | |
| `data` accumulates rather than replaces | **No.** The test asserts both the value map and `Object.keys(data)` order, killing "replace with newest" and "replace with `{unserializable:true}`". | |
| finalize exactly once, never also release | **No.** `toHaveBeenCalledTimes(1)` on `mockFinalizeCost` plus `not.toHaveBeenCalled()` on the release. The hand-resolved `completeDemo` promise additionally kills `void completeDemo`. | |
| `reset_to_queued` does not release | **No.** Negative assertions on both release and `markOutboxCompleted`. | |
| pre-work rejections release nothing | **No.** Parameterized over all three boundaries. | |
| Sentry containment (one try around lookup **and** loop) | **No.** `captureMessage` called exactly once with `crossed:[50,90]`, plus the exact log string. | |
| `outboxAttempt` reaches `failDemo` | **No.** Root-level test runs the **real** guard with `attempt: 4`. | |
| **`outboxAttempt` reaches `markOutboxCompleted`** | **YES — see F4.** | the one gap |

### 3.2 Trust-boundary negatives

The change crosses one trust boundary: the tenant-scoped `onboarding_demos ⋈ businesses ⋈
accounts` read that moved file.

- **Wrong tenant** — covered. `stages.test.ts` "reads status only through the demo's own
  business and account" uses a *capturing* `sql` fake and asserts the query text contains
  `FROM onboarding_demos od`, both joins and `WHERE od.id =`, and that `demo_123` is the
  **only** bound value. A fake that returned the fixture regardless of query could not do
  this; this one can. `ci:tenant-scope` independently re-pins the snippet at the new path.
- **Missing authorization** — N/A. This is a worker lane reached only through a dispatched
  `job_outbox` row created by the owner-authenticated `/onboarding/.../start` route; there is
  no caller-supplied identity to forge. The nearest analogue is the demo-row existence check,
  and the missing-row case is covered ("reports not handled when the demo row is missing").
- **Replayed / stale input** — partially covered. The `failDemo` attempt CAS is covered at
  both the root and the helper. The `markOutboxCompleted` attempt CAS is **not** — F4.

### 3.3 Compromises the review record does not already name

1. **F4** — the `markOutboxCompleted` attempt argument is unasserted; D6 names the identical
   concern for `failDemo` only.
2. **F2** — the `leavesNoWorkToDo` type-safety justification does not hold; the predicate is
   plain single-caller debt with a naming benefit only.
3. **F3** — one directory row still carries the invariant D3 retracted.
4. **F1** — "Verified citations" verified facts, not line numbers.
5. **`test_seams` collapse (informational, arguably already named).** The intake names four
   distinct helper test files (`subscription-guard.test.ts`, `cost-reconcile.test.ts`,
   `terminal.test.ts`, plus the worker root's). All of it landed in the pre-existing
   `worker/jobs/onboarding-demo/__tests__/stages.test.ts`. D1 refers in passing to "the
   package's single test file", so this is effectively acknowledged, and the `__tests__/**`
   glob permits it — but no deviation entry states the change. Consequence is mild: the
   file-wide `vi.mock('@sentry/node')` now sits in a file shared with four other describe
   blocks. The comment at `stages.test.ts:47-49` checks and states that Sentry appears nowhere
   else in the package, which is correct at HEAD.
6. **D7's CRAP mechanism is a proof-shape compromise, and it *is* named.** Recorded here only
   so the next reviewer sees it was weighed: the targeted fallow assertion's robustness now
   depends on cyclomatic 8 rather than on coverage data. D7 states this openly.

---

## 4. Low-confidence appendix (NOT findings — do not action without re-deriving)

- **`result.metadata.totalCostUsd` is now evaluated unconditionally.** Pre-refactor the
  property access sat inside `if (reservationDate) { … }`; post-refactor it is an argument at
  `OnboardingDemoWorker.ts:129`, evaluated whether or not a reservation date exists. If
  `result.metadata` were ever nullish, a demo with no reservation date would now throw into
  the outer catch and be marked failed where it previously completed. `DemoMetadata` is
  non-optional on both `buildOnboardingDemoSource` return paths (the fallback hard-codes
  `metadata: { totalCostUsd: 0 }`), so I believe this is unreachable — hence appendix, not
  finding. Worth one sentence in the module docstring if anyone ever makes `metadata` optional.
- **Key-order coverage is one combination, not the matrix.** The key-order test exercises
  (bound context + factory id + string + Error + object). Combinations with error fields but
  no `data`, or `data` but no error fields, are not order-asserted. I convinced myself by
  reading that no reachable mutation escapes, and the raw-string test covers a second
  combination end to end, so I am not raising it. A reviewer who wants belt-and-braces could
  add one `Object.keys` assertion on a no-error, data-only line.
- **`stages.test.ts` is now ~600 lines covering six modules.** No rule in this repo caps test
  file size and `ci:directory-map` does not police `__tests__`. Style only.
- **D7's "0 findings with no coverage data at all" claim** — I did not reproduce it, because a
  `coverage/` directory is present in this worktree and removing it would not be read-only.
  The weaker claim (0 findings at HEAD) is verified.
- **`arch-review-log.md` metrics** (`CRAP 106.4`, `cognitive 24`, `cognitive 25 / cyclomatic
  19 / 144 lines`) are copied from the plan's merge-base measurement table. I verified the
  post-state (0 findings) but did not re-measure the pre-state.

---

## 5. Bottom line

The "byte-identical behavior" premise **holds** under direct comparison against the merge-base
for both functions, across every combination named in the intake's `edge_cases`. The
decomposition is real (0 fallow findings for all three paths, and the new helpers are
themselves clean), the four tenant/DB/directory audits pass, all 28 promised tests exist, no
pre-existing test body changed, and nothing left the allowed edit surface.

All four findings are **low**: three are documentation or rationale defects in the branch's own
review record (F1, F2, F3) and one is a single missing argument assertion (F4). None blocks the
merge; F3 is the one I would fix before promotion, because a contradicted directory row on this
particular invariant is how the 20¢ reserve gets double-counted later.
