# refactor-565 complexity bundle — deviations

Notes on where the executed work differed from
[the plan](refactor-565-complexity-bundle-plan.md). One entry per ticket that
needed one.

## Triage verdicts (step 6.5, orchestrator)

| Deviation | Verdict | Reasoning |
|---|---|---|
| 1 — `prepareBatch` not decomposed | **ACCEPT** | T5's instruction was "decompose further only if the targeted check still flags it". T4 already cleared it. Not churning it is the correct reading, and the measurement is recorded. |
| 2 — the finding was CRAP, not raw cyclomatic | **ACCEPT**, with a correction to the plan's framing | See below. Changes no decision, but the plan's dichotomy was stated too cleanly and is corrected here. |
| 3 — `commitTerminalCheckpoint` owns its `sql.begin` | **ACCEPT** — stronger than what the plan asked for | The plan said "extract the transaction *body*". Owning `begin` makes "the outbox CAS is the first statement" structurally unbreakable instead of comment-enforced, removing the seam the in-code warning exists to police. Failure semantics are unchanged: the `try`/`catch` and its leave-the-outbox-`dispatched` watchdog posture stay at the top level, so a throw from inside `begin` lands exactly where it did before. |

**Correction to the plan's framing (from deviation 2).** The plan's "What
measurement changed" section draws a clean line: ingest.ts findings are
CRAP/coverage-driven, batch-builder findings are real complexity. That is too
tidy. *Both* were CRAP findings (`CC² · (1 − cov)³ + CC`). The real distinction
is:

- **batch-builder**: CC was high enough (14) that cutting decision points
  dropped CRAP below threshold. Decomposition genuinely fixed it.
- **ingest.ts**: CC is already comfortably under threshold; with the
  suppressions stripped it reports **zero** findings locally. Its CI-only CRAP
  pressure comes from apparent ~0% coverage, which decomposition cannot fix —
  splitting a function with no attributed coverage yields several functions with
  no attributed coverage. Hence #581, and hence dropping former-T2.

So the *decision* (decompose the executor, do not touch ingest) stands on the
measurements. The one-line justification "CRAP vs complexity" does not — it is
"CC above vs below threshold". Recorded so the next reader inherits the accurate
version.

## Gate — re-classification trigger fired (orchestrator)

`verify-gate.sh --review` reported `reclassify WARN`: actual diff **1662**
changed lines vs `estimated_diff_size` **420** (~4×). Step 0 was re-run with the
real numbers.

| Component | Lines |
|---|---|
| Docs — plan/intake/deviations, rewritten across two adversarial-review REVISE rounds | +364 |
| Production code — 7 files | +522 / −361 (**net +161**) |
| Tests — 4 files | +411 / −4 |

**Outcome: lane unchanged.** RISK stays `high` (worker/ terminalizers), SURFACE
stays `mixed`, and the epic test still fails on every criterion — the edit
surface is 16 explicit file globs (not "a few top-level directories"), the work
sits in one risk domain with no schema/billing/auth-model change, it decomposed
into 4 executed tickets (≤8), and no open investigation question survived
grilling (the one discovery became #581, filed rather than left open).

So the heaviest applicable lane was already in force from the start; what was
wrong is the *estimate*, not the classification. Two things it failed to
anticipate: tests alone came to +411 (the promised-test titles each needed real
setup, and three were mutation-checked), and extracting from a 310-line function
rewrites ~577 lines of `batch-builder.ts` even though its net growth is modest.
Doc churn is an artifact of two REVISE rounds — legitimate, but not something a
pre-grilling estimate would size.

No surface amendment occurred in the widening direction; the surface was
*narrowed* once, when former-T2/T3 were dropped on measurement.

*Later gate runs report a larger number (2625) — the delta is the two committed
step-7 review reports plus this file. Docs only; the analysis above is unchanged.*

**Gate-arming incident (fix round).** The review fix-round agent, told to clean
up its scratch `.feature/fallow-health.json`, removed `.feature/intake.json` and
`.feature/state.json` with it. The immediately following `verify-gate.sh --review`
therefore ran **DISARMED** and reported GREEN while silently skipping the
intake-driven rows (`build`, `promised-tests`, the four `verification_commands`
extras, `reclassify`) — a green that meant materially less than it appeared to.
Caught by noticing the row count had dropped versus the previous run. The intake
was restored from the committed copy, the branch re-armed, the fix round's four
changed files confirmed in-surface after the fact, and the full 24-row gate re-run
green. Lesson: a shrinking gate table is a disarm signal, not a faster run — the
row count is worth reading, not just the verdict.

## T5 — decompose the executor

**Measured before/after** (`npx fallow health --complexity --format json`,
findings filtered to `src/lib/solicitation/batch-builder.ts`):

| When | Finding |
|---|---|
| Plan (pre-T4 snapshot) | `<arrow>:312` cyc=16 cog=16, 304 lines · `<arrow>:136` cyc=10 cog=11, 115 lines |
| This branch, after T4, before T5 | `<arrow>:346` cyc=14 cog=14, 287 lines (CRAP 56.3) — **one** finding |
| After T5 | none — targeted check prints `PASS` |

**Deviation 1 — `prepareBatch` was not decomposed, and did not need to be.**
T4's `evaluateBatchGate` / `deleteUnbuiltBatch` extraction already dropped
`prepareBatch` below every threshold: it carries no complexity finding on this
branch. Per T5's own instruction ("decompose further only if the targeted check
still flags it") it was left alone rather than churned.

**Deviation 2 — the surviving finding was a CRAP finding, not a raw
cyclomatic one.** `exceeded: "crap"` with `coverage_tier: "partial"`,
`coverage_source: "estimated"` — i.e. the threshold that fired is
`CC² · (1 − cov)³ + CC`, so it is sensitive to fallow's *estimated* coverage as
well as to structure. `loadCandidatePool` + `commitAskDecisions` removed enough
decision points to clear it, but a future coverage re-estimate could in
principle re-trip a function this ticket left untouched. Structure, not the
number, is the thing to hold: the executor now reads as CAS → lock → gate →
load pool → decide → commit decisions → complete run → mark built.

**Deviation 3 — `commitTerminalCheckpoint` owns its `sql.begin`.** The plan says
"extract the terminal transaction *body*". The helper in
`worker/jobs/solicitation-batch/failed-hook.ts` takes `sql` and owns the
transaction boundary instead of taking `tx`. Reason: the load-bearing contract
is that the outbox CAS is the transaction's *first* statement, and owning
`begin` makes that structurally impossible to violate — a `tx`-taking helper
would leave a seam above the CAS at the call site, which is exactly what the
in-code comment ("Do not add a query or lock above this statement") warns
against. The `try`/`catch` and its watchdog-recovery posture (leave the outbox
`dispatched`, never split the coupled transition) stay at the top level
alongside the exhaustion guard, the `missing_exact_attempt` branch, and the
final log, as specified.
