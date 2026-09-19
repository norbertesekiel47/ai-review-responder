# Red team — `refactor/616-fallow-complexity`

| | |
|---|---|
| Mode | `feature` (review wave, step 7) |
| Risk | **high** (signed-off intake) |
| Round | 1 of 2 |
| Fork / merge-base | `eba43bcca97325026a79cd3041cc25bf37e0c3f3` |
| HEAD | `6c95db21c6445dd390d8633db8af97775e6cefef` |
| Intake SHA-256 | `422a465265604bd6c7223c1f2426bb587d5246c49d18b062fd7da07b4603bea9` |
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

## Authorizations

None. No finding is accepted-risk.
