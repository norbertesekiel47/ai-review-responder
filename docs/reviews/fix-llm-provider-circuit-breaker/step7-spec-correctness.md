# Step 7 — Spec & Correctness Review

Branch: `fix/llm-provider-circuit-breaker` · diff `git diff 880435ba...HEAD`
Reviewer: spec & correctness (read-only). Checked FIELD BY FIELD against
`.feature/intake.json`, the plan (AS-BUILT notes), deviations D1/D2/D3, and the
step-6 triage.

## Verdict

The implementation faithfully delivers the locked contract. The state machine,
the Admission/epoch correlation (D2), the disable-clears-state fix (D3), the
live-per-call flag (D1), the "any-provider-blocked ⇒ retryable TransientLLMError"
contract, and spend-safety are all correct and well tested. All CODE edits are
within `allowed_edit_surface` + the two surface amendments. All `tests_to_add`
items map to real tests.

**One genuine finding (Low, doc-only): `env-vars.md` still describes the
pre-fix flag semantics** — the exact staleness step-6 Finding 2 caught in the
plan doc, corrected in the plan but NOT propagated to the `env-vars.md` row
added in T3.

---

## High-confidence findings

### F-1 (Low) — `.claude/reference/env-vars.md:420` misdescribes the shipped flag semantics

The new `LLM_CIRCUIT_BREAKER_ENABLED` row states:

> "…read directly from `process.env` **at singleton construction, effectively
> once at boot** (like `BOOT_STAGGER_ENABLED`; **`reset()` re-reads it** but is
> test-only)." and "…`recordOutcome` a no-op…"

All three clauses contradict the shipped code and the recorded deviations:

1. **"read at singleton construction / once at boot"** — WRONG. Per D1 and
   `circuit-breaker.ts:66-72`, the flag is read **live per call** via
   `isEnabled()` → `llmCircuitBreakerEnabled()` → `readFlagEnabledByDefault`.
   The in-code comment explicitly says "Read on EVERY shouldAttempt/recordAttempt
   — never cached at construction".
2. **"`reset()` re-reads it"** — WRONG. `reset()` (`circuit-breaker.ts:164-166`)
   only clears the provider map; its comment says "The enabled flag is read live
   per-call, so there is nothing to re-read here."
3. **"`recordOutcome` a no-op"** — the method was renamed to `recordAttempt`
   (D2, surface amendment 2026-07-21). `recordOutcome` no longer exists on the
   breaker.

This is the same doc/code contradiction as step-6 Finding 2, whose accepted
work-item #5 was "correct the plan doc's flag-timing section." The plan doc was
corrected (AS-BUILT notes), but the `env-vars.md` row — the authoritative env
reference — still carries the superseded language. Project rules treat stale
reference docs as bugs.

- **Confidence:** high (~95%) that the doc is factually wrong.
- **Failure scenario:** an operator reading `env-vars.md` concludes a mid-process
  `LLM_CIRCUIT_BREAKER_ENABLED` change has no effect until a worker restart
  ("read once at boot"), when in fact the change takes effect on the next call.
  Low blast radius (Railway env changes restart the process anyway), but the
  authoritative reference is inaccurate. No runtime impact.
- **Fix:** rewrite the row to "read live per-call via `llm/flags.ts` →
  `config/flags.ts` (`readFlagEnabledByDefault`), not cached; `reset()` clears
  state only; method is `recordAttempt`."

---

## Field-by-field verification (all PASS)

### Correctness — state machine (`circuit-breaker.ts`)

- **Trip:** transient-while-closed increments; opens at exactly 5
  (`>= FAILURE_THRESHOLD`). Non-transient-while-closed falls through with no
  mutation (counter unchanged, never resets) — matches invariant "while closed a
  non-transient outcome is ignored (counter unchanged)". ✓
- **Open→half_open:** cooldown `now() - openedAt >= 30_000`, single probe claimed
  synchronously via `probeInFlight`. ✓
- **Half_open outcomes:** success OR non-transient (provider reachable) → close +
  reset; transient → re-open with fresh `openedAt`. Matches the intake edge
  cases exactly. ✓
- **Single-probe admission:** back-to-back `shouldAttempt` in half_open returns
  the token once, then `null`. ✓ (unit + property "at most one probe per open
  cycle").
- **Epoch/stale correlation (D2, step-6 F1):** `shouldAttempt` bumps epoch only on
  a REAL transition; closed admissions share an epoch (so concurrent closed
  failures accumulate). `recordAttempt` ignores any outcome whose epoch ≠ the
  provider's current epoch, and uses a **non-materializing** lookup so a
  cleared/reset entry is treated as stale. Traced the step-6 kill scenario (slow
  pre-trip success landing during cooldown) — now correctly ignored. ✓ (two
  explicit regression tests + two property tests).
- **transition():** epoch bump + single Sentry `warning` only on a real
  state change (`fromState === toState` early-returns) — one event per
  transition, never per skipped call. `emitTransition` is wrapped in try/catch
  ("observability must not poison the LLM path", matches the CLAUDE.md gotcha). ✓

### Correctness — failover (`run-task.ts`)

Traced the full 8-row matrix; each matches the plan table and has a test:

| primary | fallback | code path | result | test |
|---|---|---|---|---|
| blocked | transient | sawBlocked | TransientLLMError | Row 1 ✓ |
| blocked | permanent | sawBlocked | TransientLLMError | Row 2 ✓ |
| blocked | blocked | sawBlocked, neither called | TransientLLMError | Row 3 ✓ |
| transient | blocked | sawBlocked | TransientLLMError | Row 4 ✓ |
| permanent | blocked | sawBlocked | TransientLLMError | Row 5 ✓ |
| transient | permanent | throwExhaustedAttempts | TransientLLMError | Row 6 ✓ |
| permanent | permanent | throwExhaustedAttempts | rethrow permanent | Row 7 ✓ |
| blocked (no fallback) | — | sawBlocked | TransientLLMError | Row 8 ✓ |

- A `blocked` result never enters `attemptErrors` (verified) — it cannot be
  mistaken for a transient attempt error by `throwExhaustedAttempts`. ✓
- `throwExhaustedAttempts([])` (throw `undefined`) is unreachable: every path
  that reaches it has ≥1 attempted error (any blocked provider forces the
  `sawBlocked` TransientLLMError branch first). Verified all call sites. ✓
- Return-shape / classification unchanged on the healthy and pre-breaker paths
  (existing tests 62-397 still pass structurally). ✓

### Spend-safety (invariant)

`attemptProvider` returns `{blocked}` BEFORE `completeAttempt`, so a blocked
provider makes no `provider.complete` call and records nothing. Row 3
("neither provider called") is the seam-level spend proof. No re-spend, no
double call. ✓

### Kill switch (byte-identical passthrough)

Disabled: `shouldAttempt` deletes state + returns a non-null `bypass` token (so
the caller always calls the provider); `recordAttempt` early-returns. `sawBlocked`
never set ⇒ identical to pre-breaker primary→fallback. ✓ (run-task test at 588
+ property "with enabled:false, shouldAttempt is always non-null and clears
state"). D3 disable→enable clear-state fix verified by the dedicated regression
test.

### tests_to_add mapping

- #1 (unit): all listed transitions present incl. concurrent single-probe. ✓
- #2 (property): (a) disabled always-true ✓; (b) <5 never opens ✓; (c) success
  resets ✓; (d) purely non-transient unchanged ✓. Plus extra epoch/stale
  property tests. ✓
- #3 (integration): primary-open→fallback+primary-not-called ✓; both-open→Transient
  +neither-called ✓; closed→open exactly one Sentry warning ✓; flag=false
  identical ✓.

### edge_cases

All six intake edge cases handled (both-open fail-fast w/ cooldown probe
exception; half-open non-transient closes; exactly-one probe; no-fallback
fail-fast; non-transient primary still fails over; shared global covers demo
fan-out). ✓

### Drift / allowed_edit_surface

All CODE files changed are within `allowed_edit_surface` + amendments
(`circuit-breaker.ts`, `flags.ts`, `run-task.ts`, `__tests__/**`,
`config/flags.ts`, `env-vars.md`, `CONTEXT.md`). No product code touched outside
the surface. Invariants #13 (server-authoritative flag, no NEXT_PUBLIC), #15
(no DB client), and the no-new-dependency non-goal all upheld. ✓

### user_visible_behavior

All three named behaviors present; nothing material present that isn't named.
`inspect()` is a read-only test/observability affordance (not user-visible).

---

## Low-confidence appendix (NOT in the findings table)

- **A-1 (~40%, observability noise, not a bug):** the breaker emits a Sentry
  `warning` on EVERY transition, including `open→half_open` and `half_open→open`.
  During a sustained outage that is ~2 warnings per 30s cooldown, not just the
  "trips" and "recovers" events the intake's prose examples name. This is
  consistent with the contract's literal "one event per state transition" and the
  coined-term "Transitions emit a Sentry 'warning'", so it is within spec — noted
  only as a potential alert-volume consideration.
- **A-2 (informational, not drift):** `docs/superpowers/plans/*`,
  `docs/reviews/*`, and the handoff doc are outside `allowed_edit_surface` but are
  expected `/feature`-workflow process artifacts, not product changes. Not a real
  drift concern.
- **A-3 (~30%):** the run-task "trip test" and kill-switch test use the real
  module singleton with real `Date.now` (no fake timers), relying on the 6th call
  landing inside the 30s window. Fast in practice; a heavily loaded CI runner
  pausing >30s mid-test could theoretically flake. Very unlikely.
