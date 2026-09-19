# Deviations — refactor/616-fallow-complexity

Entries the plan did not anticipate, or corrections to the locked intake.
Step 6 reads this file end to end and logs a `Verdict:` per entry.

---

## D1 — `failOnboardingDemoAndRelease` extraction dropped at plan time

**Phase:** step 3 (plan)
**Kind:** `tests_to_add` retitle (deviations entry, NOT a surface amendment — see
`/feature` step 5, "Only `allowed_edit_surface` changes count").

The intake's design sketch assumed a shared
`failOnboardingDemoAndRelease` wrapper in
`worker/jobs/onboarding-demo/terminal.ts`, covering both the
`try { failOnboardingDemoTerminal } finally { releaseReservation }` blocks in
`handleOnboardingDemo`.

Dropped before any code was written, for two reasons:

1. **It is a hypothetical seam, not a real one.** Once
   `subscription-guard.ts` absorbs the subscription branch, each of the two
   blocks lives in a different module and each module holds exactly one. A
   shared wrapper would be a shallow module extracted for a single caller on
   each side — the `codebase-design` rule ("one adapter means a hypothetical
   seam") and `.claude/CLAUDE.md`'s "no abstractions for a single caller".
2. **It would force two passing tests to change.** `OnboardingDemoWorker.test.ts`
   asserts directly on `mockFailOnboardingDemoTerminal` and
   `mockReleaseOnboardingDemoReservation` ("releases reservation when
   subscription-state failure recording throws" / "…generic failure recording
   throws"). Mocking a wrapper would make both assertions unreachable. Keeping
   all four existing worker tests green **unmodified** is the strongest evidence
   of behavior preservation this refactor can produce, and the intake's
   `user_visible_behavior` names exactly that as the acceptance test.

Cost of dropping it: `handleOnboardingDemo` keeps one `try/finally` in its outer
catch, worth roughly +2 cognitive. Projected cognitive is ~11 against a
threshold of 15, so the finding still clears.

**Surface:** `worker/jobs/onboarding-demo/terminal.ts` stays listed in
`allowed_edit_surface` but is deliberately NOT touched. An unused surface entry
is inert — the guard only blocks edits outside the surface — so this costs no
amendment against the budget of 2.

**Intake edit (both copies):** the `tests_to_add` title
`failOnboardingDemoAndRelease releases the reservation and re-throws when the
terminal write fails` becomes
`guardOnboardingDemoSubscription releases the reservation and re-throws when the
terminal write fails`. Same invariant, asserted at the module where the
behavior now lives.

**Verdict:**

---

## D2 — `docs/directory/lib-db-config-shared.md` logger row is factually wrong

**Phase:** step 3 (plan)
**Kind:** in-surface doc correction.

The row reads `createWorkerLogger(correlationId)`. The real signature is
`createWorkerLogger(prefix, correlationId)` and has been for as long as the
structured logger has existed. The row also describes none of the emit
contract.

The file is already in `allowed_edit_surface` because the decomposition touches
`logger.ts`. Correcting one wrong claim about the exact function this branch
rewrites is in scope; the red-team pass re-resolves doc claims against HEAD and
would flag it otherwise. Recorded here so a reviewer sees it was deliberate and
not scope drift.

**Verdict:**

---

## D3 — The locked intake's reservation invariant was FALSE

**Phase:** step 3 (plan round 1, finding F4)
**Kind:** intake invariant correction (deviations entry — not an
`allowed_edit_surface` change, so no amendment counted).

The signed-off intake stated:

> Cost-guard reservation contract: EVERY path that does not complete the demo
> releases the 20c reserve exactly once…

That is not what the code does. `worker/jobs/OnboardingDemoWorker.ts:67` (the
subscription SELECT), `:92` (`claimDemo`) and `:99` (`markOutboxCompleted`) all
sit **outside** the outer `try`. A rejection from any of them escapes
`handleOnboardingDemo` with **no** release. The documented `reset_to_queued`
exception was not the only one.

Left uncorrected, this is a trap: an implementer reading the invariant as a
requirement would "fix" it by widening the outer catch, which is a behavior
change on a branch whose whole premise is behavior preservation.

Both intake copies now carry the as-built contract, and a new invariant records
that `finalizeOnboardingDemoCost` is **not idempotent**
(`src/lib/costs/onboarding-demo-cost-guard.ts:86` applies
`delta = actualCostCents - RESERVATION_CENTS` on every call), so a duplicate
finalize corrupts the daily counter. Plan T3 test 4 pins the rejection
boundaries; T3 test 1 pins the exactly-once finalize.

**Verdict:**

---

## D4 — `estimated_test_lines` raised 280 → 470

**Phase:** step 3 (after plan round 1)
**Kind:** estimate correction (deviations entry).

Round 1's six findings added nine test titles (7 → 26 total). The honest test
estimate is now ~470 lines, 1.7× the original. That is **under** the 2×
re-classification trigger, so the lane does not change, but leaving a stale 280
would have made that trigger meaningless at step 5. `estimated_prod_lines`
stays 240.

**Verdict:**

---

## D5 — Plan round 1 drifted out of read-only

**Phase:** step 3
**Kind:** process observation, no code impact.

The plan-skeptic session (`01a0ba18-fe60-7bb2-b5fa-211238b37576`) was briefed
read-only. Near the end it ran `verified-gate.sh --review` after a hook prompt,
having itself written that the gate "is not read-only". It changed no
production or test file; it wrote `.feature/` workflow state only. This
workflow always re-derives gate truth and never reuses it, so nothing
downstream is affected. It also attributed the handoff document to that gate
run — the orchestrator wrote it.

Recorded because the step 7 wave dispatches Codex again, and a reviewer that
runs the gate can move `.feature/gate-status.json` under the orchestrator's
evidence. Mitigation for the branch round: re-derive the gate after the wave
returns, which step 7.5 already requires.

Round 2 was given an explicit read-only instruction naming this drift. It
complied and declined a hook's gate request. The instruction works; reuse it
verbatim for the step 7 Codex axis.

**Verdict:**

---

## D6 — `extractOutboxHandle` mock made configurable in the worker test harness

**Phase:** step 3 (plan round 2, finding F3)
**Kind:** shared test-harness change (deviations entry). **No pre-existing test
body is edited.**

`worker/jobs/__tests__/OnboardingDemoWorker.test.ts:52-56` mocks
`extractOutboxHandle` as a plain arrow returning
`{ outboxId: fallback, attempt: undefined }` **unconditionally**. Because the
attempt is always `undefined`, a rewire that forgets to forward
`outboxAttempt` from the root into the extracted subscription guard is
invisible — and `failDemo` (`src/lib/demos/lifecycle.ts:191`) then drops its
`AND attempts = ${outboxAttempt}` predicate, which is what stops a stale worker
from failing a newer dispatch.

T3 converts it to a `vi.fn()` whose **default implementation is byte-identical
to today's**, so all four pre-existing tests keep their exact behavior, and T4
test 7 overrides it once with `mockReturnValueOnce` to supply a distinct outbox
id and a nonzero numeric attempt.

Risk and its control: if the default is not byte-identical, the four
pre-existing tests fail. That is the check, and it is mechanical.

Why not avoid it: the alternative is leaving the root→helper hop untested, and
that hop is exactly what this refactor creates.

**Verdict:**

---
