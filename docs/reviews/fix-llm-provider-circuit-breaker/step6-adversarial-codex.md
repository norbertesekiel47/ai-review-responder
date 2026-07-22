# Step 6 — Adversarial Review (Codex) + Triage

Branch: `fix/llm-provider-circuit-breaker` · diff vs `main`
Codex verdict: **needs-attention** (do not ship yet)
Triaged in-session with `superpowers:receiving-code-review` on 2026-07-21.

## Findings table

| Severity | Location | Finding | Verdict |
|---|---|---|---|
| high | `src/lib/llm/circuit-breaker.ts:87-107` | Late provider outcomes can corrupt half-open/open recovery — `recordAttempt` applies an outcome to the *current* state, not the state the attempt was admitted under | **ACCEPT** — real concurrency/state-machine defect |
| medium | `src/lib/llm/circuit-breaker.ts:41-44` | Live per-call flag reads contradict the documented "read once at boot" contract; disable→enable in-process can resurrect stale (stuck `half_open`) state | **ACCEPT (scoped)** — fix doc mismatch + clear state on disable; **REJECT** the "revert to construction-time read" option (regresses invariant #13) |

## Verification notes (why these verdicts)

### Finding 1 — ACCEPT (high)
- The breaker is a module-level singleton (`circuit-breaker.ts:144 export const llmCircuitBreaker`),
  shared by every `runLlmTask` call. The worker runs up to the summed LLM
  worker-slot cap (≤9, CONTEXT.md) concurrent LLM jobs → concurrent in-flight
  attempts against the same provider are routine, not exotic.
- `attemptProvider` (`run-task.ts:130-137`) calls `shouldAttempt` (sync), then
  `await completeAttempt(...)` (up to `LLM_CLIENT_OPTIONS.timeout = 30_000`), then
  `recordAttempt`. The `await` yields the event loop, so N attempts interleave
  their admission and their outcome application.
- `recordAttempt` (lines 79-113) branches on `entry.state` **at completion time**,
  with no link back to the admission that produced the outcome.
- Reachable failure (does NOT need surviving the full 30s): during a partial
  brownout, attempt A is admitted `closed`; 5 other concurrent attempts fail and
  trip the breaker `open` at T0; A then returns a slow success at ~T0+1-2s →
  `recordAttempt(success)` runs the `success` branch → `transition(open→closed)`,
  defeating the 30s cooldown and re-flooding a provider that just tripped.
- The `timeout==cooldown` (30s==30s) coincidence narrows the specific *half-open*
  variant Codex described (a stale `closed`-phase attempt cannot usually outlive
  its own 30s timeout to land during half-open), but the `open`-window variant
  above is fully reachable. Coincidental equality is not a designed invariant.
- Fix (accepted design): `shouldAttempt` returns an **admission token** carrying
  the provider + a monotonic per-provider epoch + whether it claimed the probe.
  `recordAttempt(token, error?)` applies transitions ONLY when the token's epoch
  is current; a stale-epoch outcome is ignored for state transitions (it may
  still be logged). The half-open probe is resolved only by the token that
  claimed it.

### Finding 2 — ACCEPT scoped (medium)
- Plan doc `docs/superpowers/plans/2026-07-20-llm-provider-circuit-breaker.md`
  lines 59-63 and 107 assert construction-time / "read once at boot" semantics
  with `reset()` re-reading. The code reads live per-call (`isEnabled()`,
  lines 42-44) and `reset()` deliberately does NOT re-read (lines 115-119).
  This is a genuine doc/code contradiction — the plan is stale after the
  invariant-#13 pivot (live reads via `llm/flags.ts` → `config/flags.ts`).
- Latent footgun: while disabled, `shouldAttempt`/`recordAttempt` early-return
  and freeze state. A frozen `half_open + probeInFlight=true` is never cleared
  (half-open has no cooldown re-check), so a disable→enable toggle within one
  process skips that provider permanently. Production cannot reach this (env-var
  change on Railway = process restart = fresh singleton), hence medium.
- REJECT "snapshot at construction + reset() re-reads": that is exactly the
  memoization invariant #13 / `ci:process-env` pushed us away from. Keeping live
  reads is correct.
- Fix (accepted): when the breaker reads disabled, clear that provider's state
  (so re-enable starts clean) and document the live-read semantics in-code;
  update the plan doc to match reality. Add a disable→enable regression test.

## Accepted work items → step 7 gate
1. Admission-token/epoch correlation in `LlmCircuitBreaker` + `attemptProvider`; ignore stale-epoch outcomes for transitions. (F1)
2. Concurrent out-of-order regression test (fast-check property + explicit async interleave). (F1)
3. Clear per-provider state when disabled; in-code doc of live-read semantics. (F2)
4. disable→enable regression test proving no stuck `half_open`. (F2)
5. Correct the plan doc's flag-timing section to "live per-call read". (F2)

All items are within the intake `allowed_edit_surface` (circuit-breaker.ts,
run-task.ts, `__tests__/**`) + exempt docs. Recorded as a deviation in
`fix-llm-provider-circuit-breaker-deviations.md`.
</content>
</invoke>
