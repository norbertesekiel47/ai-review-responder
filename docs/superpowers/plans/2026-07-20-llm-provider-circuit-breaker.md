# Plan — LLM provider circuit breaker (ticket F3 / P9)

**Branch:** `fix/llm-provider-circuit-breaker` (sibling worktree off `origin/main`)
**Ticket:** F3, `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md`
**Intake:** `.feature/intake.json` (on-disk in the worktree; `.feature/` is gitignored)
**Risk:** high (LLM task seam, worker-side). No DB, no migration.

## Why (and what is already done)

F3's "verified state" (2026-07-16) is stale. Since then #508/#511 landed
**explicit BullMQ concurrency** on every LLM-calling queue plus the boot-enforced
**Summed LLM worker-slot cap** (`assertSummedLlmWorkerSlots`, ≤9). The stale
"Concurrency 5" comment F3 cited is already gone. Owner confirmed 2026-07-20:
**this run builds only the in-process circuit breaker**; the concurrency
invariant is untouched.

Today `runLlmTask` (`src/lib/llm/run-task.ts`) does primary→fallback with
`timeout: 30_000, maxRetries: 0`. During a sustained primary-provider (OpenAI)
outage, **every** LLM job pays the full ~30s primary timeout before failing over
— across ≤9 summed slots + BullMQ retries that backs the generation queue up.

## Design (locked via grilling, 2026-07-20)

**LLM provider circuit breaker** — an in-process, **per-provider**
(`LLMProviderId`) breaker in the `src/lib/llm/` seam, consulted by `runLlmTask`.

- **States:** closed / open / half-open.
- **Trip:** 5 consecutive `isTransientLLMError` failures (network/5xx/429/408/
  timeout). Non-transient errors (auth/4xx, `LLMStructuredOutputError`,
  empty-response) never **trip** the breaker. State-dependent reset: while
  **closed**, a non-transient outcome is **ignored** (counter unchanged); while
  **half-open**, a non-transient outcome (provider reachable) **closes** the
  breaker like a success (see Half-open). Only a transient outcome ever
  increments the counter.
- **Open:** 30_000 ms (matches the call timeout). While open, `shouldAttempt`
  returns false.
- **Half-open:** after the cooldown elapses, admit **exactly one** probe
  (claimed synchronously — single-threaded Node makes this race-free under
  concurrency ≤9); other calls behave as open. Probe **transient** failure →
  re-open for another cooldown; probe **success or non-transient** error →
  close (provider reachable, outage over).
- **Failover policy in `runLlmTask`:** primary open → skip its attempt, go
  straight to fallback. **Blocked ⟹ retryable:** if the flow ends in failure and
  *any* provider was **blocked** (breaker open, not attempted), throw a
  **retryable** `TransientLLMError` (BullMQ + outbox-watchdog retry) — a blocked
  provider may succeed on a later retry, and the owner posture (P3) prefers
  bounded retry over dropping paid work. **Terminal only when every provider was
  *attempted* and every attempt was non-transient** (unchanged
  `throwExhaustedAttempts` classification over the *attempted* errors). A
  "blocked" state is a boolean, **never** an entry in the `attemptErrors` array —
  it must not be mistaken for a transient attempt error by `throwExhaustedAttempts`.
- **Alerting:** `Sentry.captureMessage(title, { level: 'warning', tags, extra })`
  on each state transition (`closed→open`, `→closed`) — one event per
  transition, never per skipped call. Precedent: `health-alert/emit.ts`,
  `notifications/contact-notify.ts`.
- **Kill switch:** `LLM_CIRCUIT_BREAKER_ENABLED`, default ON, only the literal
  `'false'` disables (mirrors `BOOT_STAGGER_ENABLED`). Off ⇒ `shouldAttempt`
  always true, `recordOutcome` a no-op — byte-identical to today. Read directly
  from `process.env` (precedent: `src/lib/auth/flags.ts`) **at construction**;
  in prod the singleton is built once at module load, so the flag is effectively
  read once at boot (consistent with BOOT_STAGGER — no hot toggling). `reset()`
  re-reads it, but `reset()` is a **test-only** affordance (isolation + flag-flip
  cases); prod never calls it, so prod stays "read once at boot".
- **In-process = effectively global only under single-replica** (ADR 0005),
  same posture as the concurrency cap; multi-replica defers to the same Redis
  semaphore trigger. No Postgres/Redis/cross-process state.
- **No new dependency** — hand-rolled (~80 lines).

### Seams (codebase-design lens)

- **`LlmCircuitBreaker` (NEW, `src/lib/llm/circuit-breaker.ts`) — a real seam.**
  Small interface — `shouldAttempt(provider)`, `recordOutcome(provider, error?)`,
  `reset()` — hiding the full state machine, cooldown timing, single-probe
  admission, and transition alerting. The **clock** and **enabled** flag are
  constructor-injectable (`{ now?, enabled? }`) so tests drive the machine
  deterministically without mocks (replace-don't-mock). A module singleton
  `llmCircuitBreaker` reads `Date.now` + the env flag. `shouldAttempt`
  deliberately owns the open→half-open transition + probe claim (query+command
  together) rather than leaking the mechanism to callers.
- **`runLlmTask` (DEEPENED, `run-task.ts`) — interface unchanged.**
  `runLlmTask(taskId, prompt): Promise<LLMCallResult>` stays byte-identical to
  its callers (`generator.ts`, `triage.ts`, `judge.ts`, `review-summary.ts`).
  Internally, extract a private `attemptProvider(...)` (consult breaker →
  `completeAttempt` → record outcome) and orchestrate primary-then-fallback over
  it. The singleton breaker is an internal dependency, like `PROVIDERS`.

## Tracer tickets

Each is a thin vertical slice, within `allowed_edit_surface`, using glossary
terms verbatim. TDD (red→green→refactor) per slice.

### T1 — `LlmCircuitBreaker` module + unit/property tests
**Blocking edges:** none (leaf module).
**Surface:** `src/lib/llm/circuit-breaker.ts`, `src/lib/llm/__tests__/circuit-breaker.test.ts`.
**Slice:** the breaker as a runnable, fully-tested state machine in isolation
(construct → drive outcomes/clock → observe state + alerts).
- Class `LlmCircuitBreaker` with per-provider state map keyed by `LLMProviderId`;
  constructor `{ now?: () => number; enabled?: boolean }` (defaults: `Date.now`,
  `process.env.LLM_CIRCUIT_BREAKER_ENABLED !== 'false'`).
- `shouldAttempt(provider): boolean` — closed→true; open→(cooldown elapsed?
  transition half-open + claim probe → true : false); half-open→true only for
  the one unclaimed probe.
- `recordOutcome(provider, error?): void` — `error === undefined` (success) or a
  non-transient error while half-open → close + reset counter; transient error →
  increment, trip to open at 5 consecutive; non-transient while closed → ignore.
  Keys transient on `isTransientLLMError` (error-classifier.ts).
- `reset(): void` — clear all provider state and re-read the env flag (test
  isolation + flag re-evaluation).
- Transition emit: private helper → `Sentry.captureMessage` (level `warning`,
  `tags: { subsystem: 'llm_circuit_breaker', provider }`) + `createWorkerLogger`.
  Never throws (wrapped) — observability must not poison the LLM path.
- Module singleton `export const llmCircuitBreaker = new LlmCircuitBreaker();`.
- **Tests (`tests_to_add` #1, #2):** unit — all transitions incl. concurrent
  single-probe admission; fast-check property block ("invariants" describe,
  house style from `sentiment.test.ts`): (a) disabled ⇒ `shouldAttempt` always
  true for any outcome sequence; (b) `<5` consecutive transients never opens;
  (c) a success inside a failure run keeps it closed unless ≥5 consecutive
  transients follow; (d) purely non-transient sequences leave state unchanged.

### T2 — Wire breaker into `runLlmTask` + integration tests (the real end-to-end)
**Blocking edges:** T1.
**Surface:** `src/lib/llm/run-task.ts`, `src/lib/llm/__tests__/run-task.test.ts`.
**Slice:** the breaker consulted on the live failover path.
- `attemptProvider(breaker, provider, request, task)` returns a small tagged
  result: `{ ok: result }` on success, `{ blocked: true }` when
  `shouldAttempt` is false (no call, no error, nothing recorded as an attempt),
  or throws the attempt error after `recordOutcome(provider, err)`. The
  transient/non-transient DISCRIMINATION lives entirely **inside**
  `recordOutcome` (T1) — the call site records every real outcome and never
  decides trip/reset itself.
- `runLlmTask` orchestration over `attemptProvider`, tracking a `sawBlocked`
  boolean and an `attemptErrors` array (thrown attempt errors only — a `blocked`
  result NEVER enters this array):
  1. Primary: `{ ok }` → return; thrown → push to `attemptErrors`; `{ blocked }`
     → set `sawBlocked`.
  2. If no fallback and primary didn't return: `sawBlocked ? throw
     TransientLLMError : throwExhaustedAttempts(attemptErrors)`.
  3. Fallback (same three outcomes; on thrown, log the failover line as today).
  4. Terminal decision: if `sawBlocked` → `throw new TransientLLMError(...)`
     (retryable). Else `throwExhaustedAttempts(attemptErrors)` — the existing
     classification over the *attempted* errors, unchanged.
- **Failover matrix (all covered by tests):**

  | primary | fallback | result |
  |---|---|---|
  | blocked | attempted→transient | TransientLLMError (retryable) |
  | blocked | attempted→permanent | **TransientLLMError** (sawBlocked ⟹ retry) |
  | blocked | blocked | TransientLLMError, **no provider called** |
  | attempted→transient | blocked | TransientLLMError |
  | attempted→permanent | blocked | **TransientLLMError** (sawBlocked ⟹ retry) |
  | attempted→transient | attempted→permanent | TransientLLMError (today's behavior) |
  | attempted→permanent | attempted→permanent | rethrow permanent (terminal, unchanged) |
  | blocked (no fallback) | — | TransientLLMError |

- Interface unchanged; return shape identical. The only classification change:
  a `sawBlocked` failure is retryable (was impossible before — no breaker).
- **Spend-safety (proven at this seam, no cost-guard surface widened):** a
  `blocked` provider is skipped *before* `completeAttempt`, so the both-blocked
  test asserting **neither provider's `complete` is called** is the spend proof
  — zero tokens ⟹ nothing to finalize; `withCostGuard`'s existing onError
  release path (separately tested) reclaims the reservation unchanged. The
  breaker adds no new spend path.
- **Per-caller retry nuance:** "BullMQ retries on TransientLLMError" holds for
  callers that propagate (`generate-draft.ts` rethrows). Best-effort callers
  degrade gracefully instead — `review-summary.ts` catches and returns `null`
  (summary unavailable), which for a breaker-blocked insights task is the
  desired graceful degradation, not a lost paid draft. Both are spend-safe.
- **Tests (`tests_to_add` #3):** `beforeEach(() => llmCircuitBreaker.reset())`;
  the full failover matrix above (each row); `closed→open` emits exactly one
  Sentry warning (captureMessage mocked); `LLM_CIRCUIT_BREAKER_ENABLED='false'` +
  `reset()` ⇒ identical to current primary→fallback. Use `vi.useFakeTimers` for
  cooldown.

### T3 — Docs: env flag + glossary
**Blocking edges:** T2 (document shipped behavior).
**Surface:** `.claude/reference/env-vars.md`, `CONTEXT.md`.
- `env-vars.md`: `LLM_CIRCUIT_BREAKER_ENABLED` row in the BOOT_STAGGER default-ON
  style (default ON; only `'false'` disables; read via `process.env` in
  `src/lib/llm/circuit-breaker.ts`; describe trip/open/half-open + alert).
- `CONTEXT.md`: add the **LLM provider circuit breaker** glossary term
  (verbatim from intake `coined_terms`).

## Verification gate (step 5)

Standard set only — backend-only, no `pnpm build`:
`pnpm lint && pnpm typecheck && pnpm test` + every `ci:*` audit (except
`ci:fallow*`). No `verification_commands` beyond the standard set.

Property tests are mandatory here (the breaker is a state machine — example
tests are too weak); they live in T1.

## Ship lane (step 8)

RISK=high → ride `staging` first (push → full-stack auto-deploy), smoke a
generation cycle (breaker default-ON, no behavior change expected under healthy
providers), then PR to `main`, CI green, **pause for explicit owner merge
approval**. No migrations. After merge: ff-only pull `main`, ff `staging`,
remove worktree, `document-feature` sweep, fold the glossary term + note ADR
0005's LLM-concurrency posture now also covers the breaker.
