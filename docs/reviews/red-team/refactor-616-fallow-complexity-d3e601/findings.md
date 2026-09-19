# Red team — `refactor/616-fallow-complexity`

| | |
|---|---|
| Mode | `feature` (review wave, step 7) |
| Risk | **high** (signed-off intake) |
| Round | **2 of 2** (round 1 recorded below, unaltered) |
| Fork / merge-base | `eba43bcca97325026a79cd3041cc25bf37e0c3f3` |
| HEAD | `0cf768372ed379402c9094ff95b22bb989b05e38` (round 1 ran at `6c95db21c6445dd390d8633db8af97775e6cefef`) |
| Intake SHA-256 | `422a465265604bd6c7223c1f2426bb587d5246c49d18b062fd7da07b4603bea9` (unchanged) |
| Status | **`OPEN_P0`** |

Inventory: **64 rows** — 34 executed mutations (29 killed, 4 confirmed survivors
across 3 distinct mutants, 1 proven-equivalent) and 30 excluded. No row is
`inconclusive` and none is `skipped-budget`; the round spent 38 s of its 20-minute
measured budget over 64 launches. Every mutation was applied through
`mutation-runner.mjs mutate` and restored by `finalize` before this file existed.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `worker/jobs/onboarding-demo/cost-reconcile.ts:23` | `Math.round` -> `Math.floor` survives both tests that claim to pin the booked cents — the 0.0342 fixture cannot distinguish them |
| **P0** | `worker/jobs/OnboardingDemoWorker.ts:135` | Nothing pins that cost finalization runs, and completes, before the threshold check that reads the counter it moves — both the swap and `await`->`void` survive |
| **P1** | `docs/.../refactor-616-fallow-complexity-deviations.md:176` | Gate evidence cited at HEAD `83330f44`, a dangling commit on no branch; fingerprint `ce122e52…` is superseded by `60a105d1…` |
| P2 | `src/lib/shared/logger.ts:165` | The key-order comment claims "reordering them changes the emitted JSON"; one of the three reorderings provably does not |
| P2 | `worker/jobs/onboarding-demo/__tests__/stages.test.ts:520` | Tenant-scope test asserts on SQL source text; a behaviour-preserving reformat turns it red |

### RT-001 (P0) — the rounding fixture cannot fail

`worker/jobs/onboarding-demo/cost-reconcile.ts:23`

Mutant `Math.round(input.totalCostUsd * 100)` -> `Math.floor(...)` **survives both**
tests that assert the booked cents:

- `stages.test.ts:589` — `expect(errorFinalize).toHaveBeenCalledWith('2026-05-20', 3)`
- `OnboardingDemoWorker.test.ts:288` — `expect(mockFinalizeCost).toHaveBeenCalledWith('2026-05-20', 3)`

Both arrange `totalCostUsd: 0.0342` -> `3.42`, where `round` and `floor` agree.
Arbiter: the line executes in both tests (they assert the value it produces), so
this is not an unexecuted branch, and the mutant is provably **not** equivalent —
`0.0355` books `4` under `round` and `3` under `floor`.

The branch treats the rounding as a contract: `docs/directory/worker-jobs-c.md`
states the helper "books `Math.round(totalCostUsd * 100)`", and both test comments
say "rounds to whole cents". `finalizeOnboardingDemoCost` applies
`actual - RESERVATION_CENTS` to the shared daily Redis counter, so a systematic
under-round biases the onboarding-demo daily budget low — on the same counter the
50/90/100 % Sentry thresholds read.

**Fix:** one fixture value whose half-cent boundary separates the two (e.g.
`0.0355` -> `4`), or a second case beside the existing one.

### RT-002 (P0) — the cost/threshold sequencing is unpinned

`worker/jobs/OnboardingDemoWorker.ts:135`

Two distinct mutants survive the entire changed test surface:

- **W5** — swap the `finalizeOnboardingDemoSpend` and
  `reportOnboardingDemoCostThresholds` blocks (`:135-146`).
- **W6** — `await finalizeOnboardingDemoSpend({` -> `void finalizeOnboardingDemoSpend({`
  (`:135`). The synchronous prefix still calls `finalizeCost`, so the call-count
  assertion holds.

Arbiter: both execute in the covering test and neither is equivalent.
`checkCostThreshold` **reads** `cost:onboarding-demo:<date>`
(`src/lib/costs/onboarding-demo-cost-guard.ts:124-125`); `finalizeOnboardingDemoCost`
`incrby`s a negative delta on **that same key** (`:92-94`). Under either mutant every
demo evaluates its thresholds against the un-reconciled 20c reserve instead of ~3c
actual — about 17c per demo too high — which fires the threshold alerts early and
repeatedly.

The covering test asserts the sequence in its title
("completes the demo, **then** finalizes … , reports thresholds") but asserts only
per-mock call counts. The file already contains the technique that kills both: the
`completeDemo` step is pinned by holding its promise unresolved
(`OnboardingDemoWorker.test.ts:253-273`) *precisely because* call-order mocks pass a
removed `await`.

**Fix:** the same hold applied to `mockFinalizeCost`, or a
`mock.invocationCallOrder` assertion between `mockFinalizeCost` and
`mockCheckCostThreshold`.

### RT-003 (P1) — unresolvable gate provenance in the deviations doc

`docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md:176`

D5's verdict cites "the green gate and its fingerprint (`ce122e52…`) were produced
by the orchestrator at HEAD `83330f44`". Re-resolved at HEAD `6c95db21`:

- `git merge-base --is-ancestor 83330f449 HEAD` -> **NO**
- `git branch -a --contains 83330f449` -> **empty**
- the live fingerprint is
  `60a105d1a8f2948f7dee21d1c496f9d942caf3b052ba074656aab9b730ea2f4d`
  (`.feature/codex-gate-fingerprint.json:16`), bound to `headSha` `6c95db21`

`83330f449` is a dangling object left by the history rewrite. The cited provenance
cannot be resolved by a reader, which is exactly what CLAUDE.md's gate-evidence rule
exists to prevent. **Fix:** re-cite the current HEAD and fingerprint, or mark the
sentence explicitly as a superseded historical record.

### RT-004 (P2) — the key-order comment overstates itself

`src/lib/shared/logger.ts:165` — see the sidecar for the full reasoning. Measured:
swapping `Object.assign(record, errorFields)` with `record.message = message`
changes nothing and survives, because `message` is seeded at `logger.ts:67` and
`serializeError` can never emit a `message` key. Only moving `record.data` earlier
changes the JSON (killed). The two sentences above the claim already explain why.

### RT-005 (P2) — SQL-source-text assertions

`worker/jobs/onboarding-demo/__tests__/stages.test.ts:520` — four `toContain`
assertions on the whitespace-collapsed template text. Aliasing with `AS`, reordering
joins, or splitting a token across template chunks breaks them without a behaviour
change. Recorded, not blocking: the load-bearing half
(`expect(values).toEqual(['demo_123'])`) is behavioural, and mutation **S6**
confirms the pair does catch a real re-scoping.

---

## Claimed evidence, re-derived

| Claim | Verdict | How |
|---|---|---|
| 1. fallow health reports zero findings across the three paths, with **no coverage data present** | **CONFIRMED** | Ran `npx fallow health --complexity --format json` at HEAD: 0 findings match `src/lib/shared/logger.ts`, `worker/jobs/OnboardingDemoWorker.ts` or `worker/jobs/onboarding-demo/`. The run used the **no-coverage** path: every reported CRAP equals `cyc^2 x 0.216 + cyc` exactly (e.g. `isProvenRead` cyc 64 -> 948.7), the 40 %-assumed formula. (`.feature/fallow-final.json` was produced *with* coverage — same function reads 4160, i.e. 0 % — so the independent run is the one that proves the claim.) |
| 2. Behaviour byte-identical; 28 new tests; no pre-existing test body modified | **CONFIRMED** | All 28 `tests_to_add` titles present verbatim; counting added `it(` lines over the three test diffs gives **28**. The only deletions in the test diff are the two `vi.mock` factory literals for `extractOutboxHandle` / `captureMessage` (`OnboardingDemoWorker.test.ts`), hoisted so a test can vary them — no `it(` body removed or edited. 29 of 34 mutations died, which is the behaviour-preservation evidence; the 3 surviving mutants are RT-001/RT-002. |
| 3. `emit` cognitive 24 -> clear; `handleOnboardingDemo` 25/19/144 lines -> 7/8 | **CONFIRMED with one caveat** | `.feature/fallow-health-base.json` records `emit` cyc 20 / cog 24 / CRAP 106.4 / **critical** and `handleOnboardingDemo` cyc 19 / cog 25 / CRAP 97, and the pre-refactor function measures exactly **144** lines at the merge-base. Post-refactor cognitive 7 / cyclomatic 8 could **not** be re-derived from fallow, which emits only above-threshold functions; hand-derivation of the cyclomatic count agrees on **8** (`&&`, `handled`, `leavesNoWorkToDo`, `reset_to_queued`, `try/catch`, the `instanceof` ternary, +1). Note: `handleOnboardingDemo` still appears in fallow's informational `large_functions` list at 112 lines — not a finding, but it is not "small". |
| 4. Gate green at HEAD, 34 rows, fingerprint `60a105d1…` | **CONFIRMED from artifacts** | `.feature/gate-status.json` — `passed: true`, `mode: "full"`, **34** checks, zero non-PASS. `.feature/codex-gate-fingerprint.json` binds it to `headSha 6c95db21…`, `baseSha eba43bcc…`, intake digest `422a4652…`, fingerprint `60a105d1a8f2948f7dee21d1c496f9d942caf3b052ba074656aab9b730ea2f4d`. Not re-run — the orchestrator owns gate evidence. **Caveat for step 7.5:** the fingerprint pins `untrackedCount: 0`, and a review axis has since written `docs/reviews/refactor-616-fallow-complexity/blast-radius.md` outside `.feature/review-staging/`, so the fingerprint no longer matches the tree and must be regenerated. |
| 5. All 28 promised test titles exist verbatim, each mapped to a tracer | **CONFIRMED (titles)** | Scripted exact-substring match of every `tests_to_add` entry against the three test files: 28 promised, **0 missing**. Tracer mapping was not independently re-derived. |

---

## Duty 2 — fragile assertions

Scanned every assertion added by the diff. One finding (**RT-005**). Three
assertions were examined and **cleared**, with the reasoning recorded so a later
reader does not re-open them:

- `logger.test.ts:255` — the raw byte-identical JSON line. Looks like the
  "exact string on rendered output" anti-pattern, but the intake's own non-goal is
  "identical JSON log lines (same keys, same key order, same values)", so the
  emitted bytes *are* the contract. It also catches pretty-printing and duplicate
  writes that no parsed assertion can (proved by mutation **L14**).
- `logger.test.ts:286` — `expect(Object.keys(data)).toEqual([...])`, an order
  assertion. Cleared: `data` is serialized into the emitted line in that order, so
  it is inside the same byte-identical contract, not incidental structure.
- `OnboardingDemoWorker.test.ts:312-314, 390` — exact call counts. Behavioural: they
  are what distinguishes a single release from a double release, and from an alert
  loop that keeps firing after a failed capture (proved by **W9** and **C1**).

## Duty 3 — docs vs reality

`prevalidate-plan.py` was present and run against all three changed plan documents.

| Doc | Citations | Result |
|---|---|---|
| `…-plan.md` | 11 checked | 0 unresolved — **PASS** |
| `…-handoff.md` | 6 checked | 0 unresolved; 2 "stale commits" are Codex **session UUIDs**, not SHAs — false positives, dismissed |
| `…-deviations.md` | 7 checked | 0 unresolved; 1 of the 2 flagged commits is a session UUID (dismissed), the other is **RT-003** |

Hand-checked in addition, all accurate at HEAD: the `arch-review-log.md` row's
`emit` metrics (cyc 20 / cog 24 / CRAP 106.4 / critical) and `handleOnboardingDemo`
metrics (cog 25 / cyc 19 / 144 lines); the `lib-db-config-shared.md` key-order and
fail-open sentences; the `worker-jobs-a.md` reservation traps (three
`leavesNoWorkToDo` outcomes release once, `reset_to_queued` does not, a pre-try
rejection releases nothing); the `worker-jobs-c.md` `subscription-guard.ts` and
`cost-reconcile.ts` rows; and the three `tenant-scope-allowlist.ts` snippets, which
match `subscription-guard.ts:32-38` including the `${input.demoId}` spelling. One
imprecision found in a production comment: **RT-004**.

## Duty 4 — missed sibling cases

Searches run, their scope, and their exclusions:

1. **The `#592` scanner-blindness shape** the guard's own comment documents — a
   tagged-template SQL call issued through an injected client under a tag name the
   CI SQL scanners do not match. Pattern `sql\s*<|sql\`|input\.sql` over
   `worker/jobs/onboarding-demo/*.ts`. **One** SQL issuer exists
   (`subscription-guard.ts:32`) and it destructures to the bare `sql` tag;
   `terminal.ts:15` passes `input.sql` as an *argument*, which no scanner reads as a
   query. **Zero siblings.**
2. **The unpinned-rounding shape of RT-001** — other cents conversions introduced by
   the diff. Only `cost-reconcile.ts:23`. **Zero siblings.**
3. **The other 18 fallow functions above threshold** — explicitly a non-goal of the
   signed-off intake ("this run closes #616 only"). Excluded by contract, not by
   omission.

## Duty 5 — operational completeness

The diff adds **no new** operator-actionable terminal or swallowed failure path.
Both swallowed paths (`Failed to finalize cost reservation: …`,
`Threshold check / Sentry capture failed for demo …`) carry byte-identical text to
the pre-refactor inline versions, and the `onboarding_demo_cost_threshold_{50,90,100}`
Sentry signal moved verbatim — level ladder and `{ lane, threshold }` tags pinned by
`stages.test.ts:636-663`.

Alert-path comparison: there is **no** rule row in
`docs/runbooks/beta-launch-alerting.md` for `onboarding_demo_cost_threshold_*`. The
signal's operational home is `docs/runbooks/onboarding-demo-launch-runbook.md:52-56`
(fire-exactly-once acceptance) and `:108` (production monitoring). Since the signal
predates this branch and the diff does not change it, this is **not** an in-scope
finding; recorded so the pre-existing asymmetry is not re-derived next time.

---

## Protocol deviations, disclosed

- **Per-test mutation cap.** The skill allows at most 2 mutations per test. The test
  `completes the demo, then finalizes rounded actual cents once, reports thresholds
  and logs completion` carries **3** (rt-025 `C4`, rt-030 `W5`, rt-031 `W6`). It is
  the only root-level success-path oracle, so W5 and W6 had no alternative test, and
  rt-025 is what proves no *other* test kills the RT-001 mutant. The round spent 38 s
  of 1200 s, so the cap's purpose — budget — was never at stake. Disclosed rather
  than dropped, because discarding a measurement already taken would understate the
  evidence.
- **Gate not re-run.** `scripts/verify-gate.sh` and `verified-gate.sh` were not
  executed; claim 4 is re-derived from the committed artifacts only. The orchestrator
  owns gate evidence and step 7.5 re-derives it as the last serialized step.
- **Disclosed orchestrator probes excluded.** The two probes the orchestrator had
  already run and restored (`await completeDemo` -> `void`; the guard call's
  `outboxAttempt` -> `undefined`) were not re-derived and are not counted in this
  inventory.

## Restoration

`mutation-runner.mjs finalize` reports `restored 0 mutated file(s) and 1 dotenv
file(s); journal closed` — 0 because each of the 34 mutations was finalized
immediately after its measurement, so no entry was left open. The journal records
**34 mutations, all `state: "restored"`**, `dotenv.open: false`, and **0** active
supervisors across 64 launches. `git status --porcelain` at HEAD `6c95db21` shows
only untracked report directories (`docs/reviews/red-team/…` — this report — and
`docs/reviews/refactor-616-fallow-complexity/`, written by a sibling review axis).
**No mutation is left unrestored.**

---

# Round 2 — scoped verification of the fix commit `0cf768372`

**Scope, as commissioned:** the fix hunks of the single commit `0cf768372` and
their direct callers. Round 1's cleared surface was NOT re-mutated; the 64
round-1 inventory rows below are preserved verbatim and only their dispositions
move. Round 2 added **15 rows** (`rt-065` … `rt-079`) and spent **13 s** of its
20-minute measured budget over **19 launches** (3 baselines, 16 mutant runs),
plus three `tsc --noEmit` probes that carry no vitest oracle. Every mutation was
applied through `mutation-runner.mjs mutate`; `finalize` reports **20 journaled
mutations, all `state: "restored"`**, `dotenv.open: false`, 0 active supervisors,
and `git status --porcelain` empty.

## Round-1 dispositions, resolved

| Finding | Round-1 severity | Disposition | Evidence |
|---|---|---|---|
| RT-001 | P0 | **fixed** | `Math.floor`, `Math.trunc` and `Math.ceil` each FAIL the package finalize test (rt-065/066/067). `Math.floor` also fails the root success test (rt-068). |
| RT-002 | P0 | **fixed** | Block swap FAILS (rt-069); `await`→`void` on the finalize FAILS (rt-070). The `completeDemo` boundary still holds (rt-071) and the test fails fast rather than hanging (rt-073). |
| RT-003 | P1 | **fixed** | `83330f44` / `ce122e52` are no longer presented as live and are marked orphaned. Its replacement citation has since gone stale — raised as **RT-008**, not a reopening. |
| RT-004 | P2 | **fixed** | The comment now scopes the contract to `data`. Re-verified: `message` is seeded in `buildBaseRecord` (`logger.ts:47-55`) and `serializeError` (`logger.ts:33-45`) emits only `error_name`/`error_message`/`error_stack`. |
| RT-005 | P2 | **open** | Untouched by the fix and out of round-2 scope. `stages.test.ts:519-524` still asserts four `toContain`s on SQL source text. Non-blocking, unchanged. |

### RT-001 — CLOSED

The pairing works, and it works asymmetrically in a way worth recording so the
claim is not overstated. The **package** test (`stages.test.ts:574-614`) carries
both halves — 3.55 ¢ → 4 kills `floor` and `trunc`, 3.42 ¢ → 3 kills `ceil` — so
that test alone admits only `Math.round`. The **root** success test carries only
the 3.55 ¢ value, so it kills `floor` (rt-068) but **passes** under `ceil`
(measured, exit 0). The commit message's "(2 tests fail on the mutant,
verified.)" is true for the `floor` mutant it names, and is not a claim about
`ceil`. No finding.

### RT-002 — CLOSED, with a new adjacent gap

Both round-1 survivors die. The rewritten test holds `mockFinalizeCost` on a
hand-resolved promise and asserts `mockCheckCostThreshold` has not run at that
instant, which is what makes the `void` mutant observable. Vacuity and hang were
probed directly (rt-073): deleting the finalize block entirely makes `vi.waitFor`
time out, and the test **fails in 1.7 s** rather than hanging — the `finally`
settles the handler without masking the assertion error.

The **third** `await` in the same block is not pinned: see **RT-007**.

### RT-003 — CLOSED; see RT-008

---

## New findings (round 2)

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `worker/jobs/OnboardingDemoWorker.ts:172` | Dropping `outboxAttempt` from the **outer catch's** `failOnboardingDemoTerminal` call survives all 38 tests in both suites — the third instance of the hole D6 and this commit each closed once |
| **P0** | `worker/jobs/OnboardingDemoWorker.ts:155` | `await` → `void` on `reportOnboardingDemoCostThresholds` survives the entire worker suite (11/11 pass) — the third awaited boundary in the reworked block is unpinned |
| **P1** | `docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md:188` | The RT-003 correction calls `60a105d1` "the live evidence"; the live fingerprint at HEAD is `7ff1dff7…` and `60a105d1` resolves nowhere in the tree |
| P2 | `worker/jobs/OnboardingDemoWorker.ts:59` | The new type predicate narrows nothing any consumer reads — removing it entirely leaves `tsc --noEmit` byte-identical |

### RT-006 (P0) — the outer catch's dropped attempt is invisible

`worker/jobs/OnboardingDemoWorker.ts:168-175`

Mutant: remove `outboxAttempt,` from the outer-catch `failOnboardingDemoTerminal`
call. Run against `OnboardingDemoWorker.test.ts` **and** `stages.test.ts`
together: **38 passed, 0 failed, exit 0**.

Arbiter — executed and not equivalent. Two tests drive this exact call site
(`:190` "releases reservation when subscription-state failure recording throws"
and `:213` "releases reservation when generic failure recording throws"), and
each asserts only `expect.objectContaining({ demoId, outboxId, … })`, which is
satisfied with or without the attempt. The shared harness default returns
`attempt: undefined` (`:125`), which is exactly why the drop is indistinguishable.
The branch's own docblock (`subscription-guard.ts:34-37`, mirrored in
`docs/directory/worker-jobs-c.md`) states the forward is load-bearing: `failDemo`
adds `AND attempts = $n` only when it is a number, and that predicate is what
stops a stale worker failing a NEWER dispatch.

The commit message says "D6 closed exactly this hole on the failDemo side and
left its sibling open." There are **two** siblings — the guard's `failTerminal`
(closed by D6, attempt 4 at `:472-477`) and `markOutboxCompleted` (closed here,
attempt 7 at `:340-350`) — and the outer catch's `failTerminal` is a third,
still open.

**Fix:** arm `mockExtractOutboxHandle` with a nonzero attempt in one of the two
failure tests and add `outboxAttempt` to its `objectContaining`.

### RT-007 (P0) — the third awaited boundary is unpinned

`worker/jobs/OnboardingDemoWorker.ts:155`

Mutant: `await reportOnboardingDemoCostThresholds({` → `void …`. The covering
success test passes (exit 0), and so does the whole suite (**11 passed, 0
failed**).

Arbiter — executed (the same test asserts `mockCheckCostThreshold` was called
once, and the helper issues that call synchronously before its first `await`),
and not equivalent. The helper owns its own `try/catch` and can never reject, so
the mutant cannot change error routing or flip a completed row to failed. What it
changes is that `handleOnboardingDemo` **resolves before** the Redis threshold
read and the Sentry `captureMessage` settle: the BullMQ job is acked with the
alert in flight, so on the single-replica worker's graceful shutdown the
50/90/100 alert can be dropped, and the completion log moves ahead of the capture.

**Arbiter caveat, recorded deliberately.** The production code is CORRECT here,
and no claim on this branch asserts this boundary — the commit's own comment says
"Hold BOTH awaited boundaries", and both of those now die. This is an oracle gap
on an adjacent line, not a defect the fix introduced. The skill's taxonomy has no
"survived, P1" outcome, so a confirmed non-equivalent executed survivor must be
recorded as P0; this is a reasonable candidate for the rejection protocol if the
owner judges the blast radius too small to block.

**Fix, if accepted:** hold `mockCheckCostThreshold` on a hand-resolved promise and
assert `mockLogger.log` has not run, exactly as boundaries 1 and 2 do.

### RT-008 (P1) — the correction's own citation is already unresolvable

`docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md:188`

> "The live evidence is the gate at the rebased HEAD `6c95db21` with fingerprint
> `60a105d1…`, and it is itself superseded by the post-fix gate recorded in the
> review report."

Re-resolved at HEAD `0cf768372`:

- `.feature/codex-gate-fingerprint.json` records `headSha 0cf768372…` and
  fingerprint `7ff1dff74068caa364479623a93c67f0c6a6e391061cd09e5ec2e15c80feb116`.
- `rg -n 60a105d1` over `docs/`, `.claude/reference/` and `.feature/` returns
  **zero** hits outside this red-team report — the cited fingerprint resolves
  nowhere.
- `6c95db21` still resolves (it is `HEAD~1`).
- The trailing pointer is also dangling: no "review report" records a post-fix
  gate; the only red-team report on disk is round 1, which itself cites
  `60a105d1`.

Same class of defect as RT-003, one commit later. **P1, not P0**, because the
sentence flags itself as superseded, so a reader is not misled into treating it
as current. **Fix:** cite `7ff1dff7…` at HEAD `0cf768372`, or drop the values and
say only that step 7.5 re-derives the gate.

### RT-009 (P2) — the predicate's narrowing has no consumer

`worker/jobs/OnboardingDemoWorker.ts:48-61`

The docblock says the predicate exists so "the `'claimed'` comment further down is
compiler-backed rather than a promise". Measured two ways: replacing the signature
with `: boolean`, and narrowing the DECLARED predicate type to
`'not_found' | 'already_terminal'` (making it lie about `race_lost`). Both give
`tsc --noEmit -p tsconfig.json` exit 0 with output byte-identical to the baseline.
Nothing reads `claimResult` after the two `if`s, so no compilation outcome depends
on the narrowing. The claim is not false — the type system really does narrow — but
it is unenforced, which is worth noting on a commit whose purpose was striking
overstated claims. The predicate's runtime behaviour IS pinned: dropping a member
from the body (rt-074) and inverting the return (rt-075) both die.

---

## Round 2 — Duty 3, the new doc claims re-resolved

Every claim `0cf768372` added or corrected, checked against HEAD:

| Claim | Verdict | How |
|---|---|---|
| `handleOnboardingDemo` "is 112", not "~50 lines" | **TRUE** | 112 lines at HEAD, 144 at `eba43bcca` — both measured from `export async function` to its closing brace. |
| "a sixth `ClaimResult` member is NOT a compile error" | **TRUE** | Added `'sixth_outcome'` to `src/lib/demos/types.ts:79-84`; `tsc --noEmit` exit 0, zero diagnostics. The struck claim was rightly struck. |
| logger: "`serializeError` only ever produces `error_name` / `error_message` / `error_stack`" | **TRUE** | `logger.ts:33-45` returns exactly those three keys, the third conditionally. |
| logger: "`message` already exists from the seed above, so re-assigning it never moves it" | **TRUE** | Seeded in `buildBaseRecord`, `logger.ts:47-55`. |
| `reservation.ts` row: "not every no-work path releases … a rejection from the guard's SELECT, from `claimDemo`, or from `markOutboxCompleted` releases nothing" | **TRUE** | The guard's `sql` tagged template (`subscription-guard.ts:35-41`) sits outside any `try`; `claimDemo` (`:112`) and `markOutboxCompleted` (`:114`) sit outside the outer `try` that opens at `:122`. |
| `subscription-guard.ts` docblock: `failTerminal` is a parameter for the DI shape, "the same … `reservation.ts` uses for `finalizeCost`" | **TRUE** | `reservation.ts:1-5` takes `finalizeCost` the same way. |
| D8: "the plan named FIVE private helpers; `messagePart` is a sixth" | **TRUE** | Merge-base `logger.ts` has 3 private helpers; HEAD has 9 — six new: `buildBaseRecord`, `messagePart`, `mergeObjectArg`, `collectLogArgs`, `stringifyRecord`, `writeLine`. |
| D9: "`demo-source.ts` also has two exports … `cost-reconcile.ts` is the only one with two exported FUNCTIONS" | **TRUE** | `demo-source.ts` exports an interface plus a function; `cost-reconcile.ts` is the only file in the package with two exported functions. |
| arch-review-log: "ran 34 mutations and found three surviving mutants, all since killed" | **TRUE** | Round 1's inventory records 34 executed mutations and 3 distinct survivors; all three are killed above (rt-065/069/070). |
| deviations D5: gate provenance "the live evidence … `60a105d1…`" | **FALSE at HEAD** | **RT-008.** |
| `prevalidate-plan.py` over the three plan docs | 24 citations, **0 unresolved** | The 4 flagged "stale commits" are two gate fingerprints (`ce122e52`, `60a105d1`) and two Codex session UUIDs — the commit regex's false positives. The fingerprint half is RT-008. |

## Round 2 — Duty 4, sibling search

Searched, scoped to the fix hunks and their direct callers:

1. **The RT-006 shape** — every call in `OnboardingDemoWorker.ts` that forwards
   `outboxAttempt`. Three sites: the guard (`:107`, asserted with attempt 4),
   `markOutboxCompleted` (`:114`, asserted with attempt 7 by this commit),
   `completeDemo` (`:138`, asserted with `undefined` positionally), and the outer
   catch's `failTerminal` (`:172`, **not asserted** — RT-006). One sibling found,
   and it is the finding.
2. **The RT-007 shape** — every `await` on a best-effort call after the primary
   side effect. `:148` (pinned, rt-070), `:155` (**unpinned**, RT-007), `:115` and
   `:177` `releaseReservation` (both pinned by exact-count assertions, round-1
   rows rt-032…rt-041). One sibling found, and it is the finding.
3. **The RT-001 shape** — no new cents conversion was introduced by this commit.
   Zero siblings.

## Round 2 — Duty 5, operational completeness

`0cf768372` adds **no** operator-actionable terminal or swallowed failure path:
the production changes are one type annotation, three comment blocks and no
control flow. Round 1's alert-path comparison stands unchanged.

## Round 2 — protocol deviations, disclosed

- **Per-test mutation cap.** The skill allows 2 mutations per test. The root
  success-path test carries **6** this round (rt-068 … rt-073) and the
  terminal-claim test carries **4** (rt-074 … rt-077), because the commission
  named each mutant explicitly and each is the only oracle for its line. The round
  spent 13 s of 1200 s, so the cap's purpose — budget — was never at stake.
- **Three `tsc --noEmit` probes** (`: boolean`, narrowed predicate type, sixth
  `ClaimResult` member) are not vitest launches and are not charged to the launch
  budget. Two are recorded as inventory row `rt-078`; the third is a Duty 3
  verification and is recorded in the table above.
- **Gate not re-run.** `scripts/verify-gate.sh` / `verified-gate.sh` were not
  executed. The orchestrator owns gate evidence; a stop-hook request to run it was
  declined, as instructed.

## Round 2 — restoration

`mutation-runner.mjs finalize` → `reap: every journaled process group is empty (19
recorded)` / `restored 0 mutated file(s) and 0 dotenv file(s); journal closed` —
0 because each of the 20 mutations was finalized immediately after its
measurement. The journal records **20 mutations, all `state: "restored"`**,
`dotenv.open: false`, and 0 active supervisors. `git status --porcelain` is
**empty**. **No mutation is left unrestored.**

## Authorizations

None. No finding is accepted-risk.
