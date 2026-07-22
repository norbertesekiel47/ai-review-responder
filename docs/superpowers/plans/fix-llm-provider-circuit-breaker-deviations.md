# Deviations — `fix/llm-provider-circuit-breaker`

Deviations from the signed plan (`2026-07-20-llm-provider-circuit-breaker.md`),
recorded as they arise so a resumed session inherits them.

## D1 — Flag read is live-per-call, not construction-time (already shipped in build)

- **Plan said:** flag read "at construction… read once at boot"; `reset()` re-reads it.
- **Code does:** live per-call read via `llm/flags.ts → config/flags.ts`
  (`readFlagEnabledByDefault`); `reset()` clears state only.
- **Why:** invariant #13 (server-authoritative flags, single sanctioned env
  reader) + `ci:process-env` baseline. Memoizing at construction reintroduces the
  staleness the audit forbids.
- **Status:** intentional; surfaced by step-6 adversarial review (Finding 2).
  Plan doc to be corrected to match code (this is the authoritative behavior).

## D2 — Admission-token/epoch correlation added to the breaker (step-6 fix)

- **Plan said:** `shouldAttempt(provider): boolean` / `recordAttempt(provider, error?)`.
- **Change:** `shouldAttempt` returns an admission token (provider + monotonic
  per-provider epoch + claimed-probe flag); `recordAttempt(token, error?)` applies
  state transitions only for the current epoch / the claimed probe, ignoring
  stale in-flight outcomes for transition purposes.
- **Why:** step-6 Finding 1 (high) — under concurrent in-flight attempts (summed
  LLM worker-slot cap ≤9), an outcome from an attempt admitted under a prior
  state was being applied to the current state, letting a stale success close the
  breaker during its cooldown. See `docs/reviews/fix-llm-provider-circuit-breaker/step6-adversarial-codex.md`.
- **Blast radius:** internal to `circuit-breaker.ts` + its single caller
  `attemptProvider` in `run-task.ts`; within `allowed_edit_surface`.

## D3 — Clear per-provider state when the breaker reads disabled (step-6 fix)

- **Change:** when `isEnabled()` is false, `shouldAttempt` clears that provider's
  state before returning admit, so a disable→enable toggle within one process
  cannot resurrect a stuck `half_open + probeInFlight` state.
- **Why:** step-6 Finding 2 latent footgun (medium; prod-unreachable but a real
  in-process hazard). Keeps the live-read design; no revert to construction-time.

## D4 — Sentry capture narrowed to trip/recovery transitions only (2026-07-21, pre-merge review nit N2)

- **Plan said:** alert "on each state transition (`closed→open`, `→closed`)".
- **Code did (as first built):** `Sentry.captureMessage` on EVERY real state
  change, including open↔half_open churn — a sustained outage emitted ~2
  warnings per 30s per provider (~240/hr).
- **Change:** `emitTransition` now captures to Sentry only on the two edges the
  plan named — closed→open (trip) and →closed (recovery). Structured logging
  (`logger.warn`) is kept for ALL real transitions, so the outage heartbeat
  survives in logs without the Sentry spam (production.md: no retry-storm
  alert noise). Regression test added: three open↔half_open→open churn cycles
  produce zero extra captures; recovery is the second and final capture.
- **Status:** telemetry narrowing only; no state-machine or failover change.
</content>
