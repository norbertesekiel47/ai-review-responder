# Step 7 — Standards & Maintainability Review

**Branch:** `fix/llm-provider-circuit-breaker`
**Diff:** `git diff 880435ba...HEAD`
**Skill:** `thermo-nuclear-code-quality-review` (strict maintainability lens)
**Scope:** LLM provider circuit breaker (`src/lib/llm/circuit-breaker.ts`, `run-task.ts`, `flags.ts`, `config/flags.ts`) + step-6 epoch/Admission-token correlation fix. Read-only.

## Verdict

The state machine in `circuit-breaker.ts` is a genuinely deep module: a clean `closed/open/half_open` model behind `shouldAttempt`/`recordAttempt`, with the epoch/Admission staleness guard well-motivated and thoroughly property-tested. Glossary fidelity is intact (states and the "LLM provider circuit breaker" term are used verbatim). No `any`, no silent catches, named exports, `const`-first, file sizes healthy (200 / ~200 lines — nowhere near the 1k smell). Invariant #13 is respected: the flag is routed through the sanctioned `config/flags` reader, no `NEXT_PUBLIC`, no inline `process.env.*_ENABLED`.

It is **not** a clean approve, though. There is one piece of documented-but-dead API surface, one diagnostic-context regression in the failover path, and one clear missed simplification (the Admission-token protocol should be a `run()` method). None are correctness blockers; all are legitimate maintainability findings under the house rules.

---

## Findings

### F1 — `Admission.bypass` is dead code with a misleading contract (Medium)
`src/lib/llm/circuit-breaker.ts:47,90` (+ JSDoc `:40–42`)

`bypass?: boolean` is **written** (`{ provider, epoch: -1, bypass: true }` in the disabled branch of `shouldAttempt`) but **never read** — confirmed by grep across `src/` and `worker/`. The Admission JSDoc asserts the mechanism explicitly:

> "`bypass` marks the token minted while the breaker is disabled: the caller still calls the provider, but recordAttempt ignores the outcome entirely."

But `recordAttempt` ignores a disabled-mint outcome via **two other** mechanisms, never `bypass`:
1. `if (!this.isEnabled()) return;` — the first line short-circuits while disabled.
2. Even if the flag flips ON mid-flight, the `epoch: -1` sentinel can never equal a real `entry.epoch` (≥0), so the `admission.epoch !== entry.epoch` stale check drops it.

So the field is redundant with the epoch sentinel and the enabled-guard, and the JSDoc describes a control path that does not exist. This is exactly the "direct, boring, maintainable code" bar (repworth.md / thermo-nuclear rule 4) and design.md's "comments must not misdescribe the contract."

**Remedy:** delete `bypass` from the `Admission` interface and the disabled-branch literal, and trim the JSDoc sentence. The `epoch: -1` sentinel already carries the full "always stale" guarantee — lean on it and document *that* instead. (If you'd rather keep a self-documenting marker, then make `recordAttempt` actually branch on `admission.bypass` and drop reliance on the sentinel — but one owner for the fact, not two.)

### F2 — `sawBlocked` discards a real transient cause in favor of a contextless marker (Low–Medium)
`src/lib/llm/run-task.ts:189–201` (and the `!task.fallback` branch at `:170`)

When any provider was blocked, both terminal branches throw `new TransientLLMError(new LlmCircuitOpenError())` **before** consulting `attemptErrors`. But `attemptErrors` can already hold a *real* transient error — e.g. primary blocked + fallback times out (test Row 1). In that case:
- `throwExhaustedAttempts(attemptErrors)` would *also* classify the outcome transient (fallback was transient) **and** preserve the actual cause (`anthropic timeout`).
- The current short-circuit instead surfaces the generic `"llm: circuit breaker open — provider attempt skipped"` and drops the anthropic timeout.

The retryability outcome is identical, so this is not a correctness bug — but it's a diagnostic-fidelity regression against production.md ("preserve diagnostic context") and the file's own stated intent to "surface the MOST RECENT transient cause." An operator debugging a fallback outage sees "circuit breaker open" instead of the transport error that actually fired.

**Remedy:** prefer the real cause when one exists. The marker is only needed when there is *no* attempted error to describe:
```ts
// blocked ⟹ retryable; keep the real transient cause when we have one.
if (attemptErrors.some(isTransientLLMError)) throwExhaustedAttempts(attemptErrors);
if (sawBlocked) throw new TransientLLMError(new LlmCircuitOpenError());
throwExhaustedAttempts(attemptErrors);
```
This collapses the two special-cased terminal blocks into one ordering and preserves context.

### F3 — Missed simplification: fold the Admission protocol into `breaker.run()` (Medium, structural — the code-judo move)
`src/lib/llm/run-task.ts:122–148` (`attemptProvider`) + `circuit-breaker.ts` public surface

The token is correctly *opaque* to callers (they never read `epoch`/`bypass`), so it does not leak the epoch mechanism — good information hiding. But it imposes a mandatory **temporal sequence** on every caller: `shouldAttempt` → (if non-null) call provider → `recordAttempt(token, err?)`. That protocol is a classic design.md temporal-coupling smell, and it is already **duplicated** in two places:
- `run-task.ts` `attemptProvider` (production), and
- `circuit-breaker.test.ts` `attempt()` (the test helper re-implements the same dance).

The deeper design collapses the whole protocol into one method and **deletes the exported `Admission` type from the public surface**:
```ts
type Attempt<T> = { kind: 'ok'; result: T } | { kind: 'blocked' } | { kind: 'error'; error: unknown };
async run<T>(provider: LLMProviderId, call: () => Promise<T>): Promise<Attempt<T>>
```
`attemptProvider` disappears (its body moves inside `run`), the temporal-coupling footgun is gone, `Admission` becomes a private implementation detail, and the disabled path simply runs the thunk. run-task keeps its `ok`/`blocked`/`error` discrimination as the return type it already wants. Tests exercise `run()` with fake thunks instead of hand-threading tokens.

This is the one place the PR preserves incidental complexity where a reframing would remove a concept (the caller-visible token) entirely. Recommend it, but not a blocker — the permit/lease-token pattern is defensible and the token is genuinely opaque.

---

## Low-confidence appendix ("might be nicer")

- **A1 — Duplicated primary/fallback result-handling in `runLlmTask`.** The 3-line `ok→return / error→push / else→sawBlocked` block and the terminal `sawBlocked ? marker : throwExhaustedAttempts` block each appear twice. A loop over `[task.primary, task.fallback].filter(Boolean)` (logging failover when `error && hasNextTarget`) would express the N-provider intent once. Bounded (exactly 2 providers today) so the linear form is readable — subsumed by F3 if `run()` lands.
- **A2 — `shouldAttempt` mutates state (`this.providers.delete`) in the disabled branch.** A side effect inside a `should…`-named query is mildly surprising (design.md: surprising code is complexity). Well-commented and there's no disable *event* to hook instead, so acceptable — noting only for awareness.
- **A3 — `inspect()` is test-only.** JSDoc says "for observability and tests," but grep finds no production/observability caller — only tests use it. Fine as a test seam; consider tightening the doc to "tests" so it doesn't imply a wired observability surface that doesn't exist.
- **A4 — Constructor `enabled?` test knob.** `enabledOverride ?? llmCircuitBreakerEnabled()` bakes a test-only construction path into production. Standard and low-cost (deterministic clock + flag), acceptable.

## What's solid (explicitly not flagged)
- Epoch staleness guard: correct, race-safe within Node's single-thread model, and the property tests (`applying a stale-epoch outcome never changes state`, `at most one probe per open cycle`, same-epoch fan-out accumulation) genuinely pin the invariant.
- `readFlagEnabledByDefault` is the sole `!== 'false'` reader (single authoritative home); default-ON kill switch routed correctly through `config/flags` → `llm/flags` per invariant #13.
- Observability wrapped in try/catch so alerting can never poison the breaker/LLM path (matches the repo's "best-effort work needs its own catch" gotcha).
- No new file crosses the 1k-line threshold; no spaghetti branches bolted onto unrelated flows; error handling uses `unknown` + narrowing throughout.
