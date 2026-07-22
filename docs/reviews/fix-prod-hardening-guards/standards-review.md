# Standards & Maintainability Review — fix/prod-hardening-guards

Review axis: standards + maintainability (thermo-nuclear-code-quality-review skill).
Scope: `git diff origin/main...HEAD`, code files only (7 guards: zernio ingest
failed-hook, bounded Supabase fetch, guardrail transient re-throw,
emitter-errors + wiring, fastify-options, health-alert checks, dashboard
degradation). Reviewed 2026-07-16.

## Verification performed

- Full diff read (all 7 guards + tests + tenant-scope allowlist bump).
- `pnpm ci:db-imports` — **passed** (strict). `worker/emitter-errors.ts`,
  `worker/config/fastify-options.ts`, and `worker/jobs/zernio/ingest-failed-hook.ts`
  all take `sql`/no DB client as required; only composition roots
  (`worker/index.ts`, `worker/queues.ts`, `src/lib/db/server.ts`) touch the
  singleton.
- `pnpm ci:static-policy` — **passed** (945 files).
- No `any` introduced in production code (the `mockSql: any` in the zernio test
  is pre-existing). Typed fallbacks in `service.ts` match the pre-existing
  query generics (`sql<Record<string, unknown>[]>` at service.ts:159), so no
  type-boundary weakening.
- `.claude/CLAUDE.md` anti-respend carve-out updated in lockstep with the
  guardrail behavior change — no stale-doc drift.
- No file approaches the 1k-line boundary (largest touched: service.ts, 514).
- No new top-level directories; `worker/emitter-errors.ts` sits alongside
  existing root-level worker utilities (shutdown.ts, redis-connection.ts, …).
- No new string literals for statuses/job names/queue topics in production
  code (`QUEUE_NAMES.*` used throughout; the `'failed'` SQL literal in
  checks.ts follows the file's pre-existing convention for outbox status in
  SQL text). `workersByQueue` keys are `QUEUE_NAMES` values, so emitter source
  tags (`worker:generate_response` / `queue:generate_response`) are consistent.
- Deep-module check: `attachEmitterErrorLogger` earns its keep (hides
  throttle-window state, Sentry shaping, and never-throw hardening behind one
  call). `widgetOrFallback` earns its keep (settled-unwrap + mandatory
  reporting + fallback in one place; callers cannot degrade silently).
  `buildFastifyOptions` is thin but justified — it exists so the limits are
  assertable on a real Fastify instance without booting `worker/index.ts`.

## Findings (≥80% confidence)

| Severity | Location | Finding | Standard violated / failure |
|---|---|---|---|
| Medium | `worker/jobs/response-generation/generate-draft.ts:271-274` (also `:176-178`) | The three-class transient predicate (`TransientLLMError \|\| CostInfraUnavailableError \|\| ConcurrencyLimitExceededError`) is duplicated verbatim in the inner (`applyAvoidFactsGuardrail`) and outer guardrail catch blocks; a future 4th transient class needs coordinated edits in 2–3 places. | engineering.md "one authoritative representation"; change amplification |
| Medium | `worker/jobs/response-generation/generate-draft.ts:258-283` | Code-judo missed: the inner catch's carve-outs (`isCostCapError` at :263 and the transient triple at :271) exist *only* to defeat the inner catch's own wrapping. If the inner catch stops wrapping (only the `retryViolation` throw at :251 needs a message; raw regen errors already get the `guardrail_failed:` prefix + review-id log from the outer catch at :192-194), both carve-outs and the whole classification duplication disappear. | thermo-nuclear rule 0/3; design.md "reduce exception surface" |
| Medium | `worker/jobs/zernio/ingest-failed-hook.ts:113-135, 146-181, 204-241` | The CAS-first coupled-tx choreography and the `review_exceptions` INSERT — including the `ON CONFLICT (business_id, type, (payload->>'provider_review_id')) WHERE status = 'open' AND review_id IS NULL` predicate that must stay byte-for-byte in sync with the partial index (CLAUDE.md gotcha) — are now triplicated; this diff doubled the per-handler ceremony. Extract `insertReviewExceptionIfAbsent(tx, businessId, type, payload)` (and optionally a `withOwnedTerminalTransition(sql, outboxId, reason, attempt, cb)` wrapper) so the conflict target and the ownership contract each have one owner. | engineering.md "one authoritative owner"; repworth ON-CONFLICT byte-for-byte gotcha now has 3 copies to keep in sync |
| Low | `worker/jobs/zernio/ingest-failed-hook.ts:14-18, 41-48, 76-80` | Mutable `IngestFailedHookState` with `coupledTerminalTxStarted` set-true/await/set-false choreography (each set-false is immediately followed by `return`, so it is dead ceremony) plus four `state.outboxId!` non-null assertions. Coupledness is fully derivable from `err instanceof` one of the three typed Zernio errors — a pure predicate (or dispatch table: error class → {handler, coupled}) deletes the state object and the assertions. | design.md: mode flags / temporal coupling as complexity; thermo-nuclear rule 2 |
| Low | `src/lib/dashboard/service.ts:71` (`widgetOrFallback`) | The shared helper hardcodes `'dashboard/service'` as the `reportCaughtError` source, but aggregate-service.ts uses it for account-level degradations while its own slice-failure path (aggregate-service.ts:126) reports under `'dashboard/aggregate'` — one aggregate request emits degradations under two different Sentry source tags depending on which query failed. Pass `source` as a parameter (the helper already threads `widget` + `context`). | Observability consistency (production.md: structured context); shared helper leaks its original caller's identity |

## Positive notes (no action)

- The zernio hook's CAS-first coupled-tx rewrite is a genuine correctness and
  atomicity improvement (exception row + outbox terminal transition now
  all-or-nothing, stale attempts write nothing, post-commit-only Sentry
  trend signal), and the crash guard correctly refuses to split a rolled-back
  coupled tx. The findings above are about *how* it's expressed, not *what*
  it does.
- `boundedSupabaseFetch` composes caller signals via `AbortSignal.any` rather
  than replacing them, documents why `timeoutMs` is injectable, and exports
  the bound as a named constant — exactly the right shape.
- Dashboard degradation keeps the fatal paths (business lookup /
  locations list) explicitly fatal with rationale comments, and every
  degradation reports — no silent catches (repworth "never do" respected).
- Test quality is notably high: SQL-text assertions guard against
  row-queued-mock false positives; the fastify test proves wiring on a real
  instance, not just option shapes.

## Low-confidence appendix (speculative; not in findings table)

- `aggregate-service.ts:60-73`: `Promise.allSettled([...])` around a single
  promise, then single-element destructure, reads awkwardly. A tiny
  `settle(promise)` adapter (or try/catch feeding `widgetOrFallback`'s logic)
  would scan better, but adds a helper for one call site — repworth's
  "before extracting, don't" bias arguably wins. Left as-is.
- `worker/background/pollers/health-alert/checks.ts:147-162`: the new inbound
  check reuses `cfg.failedWindowS`/`cfg.failedThreshold` from the outbox-failed
  probe, coupling two probes to one knob. Likely deliberate to avoid env
  sprawl; worth a one-line comment if the knobs ever need to diverge.
- `service.ts:302-314`: twelve near-identical `widgetOrFallback` lines are
  verbose, but the alternative (a keyed map / loop over heterogeneous row
  types) would be more magical than the boring column of typed calls. The
  boring version is correct here.
- `emitter-errors.ts:73` `windowBySource` map is process-lifetime and unbounded
  in principle, but sources are a fixed finite set (~46 emitters + probe), so
  growth is bounded in practice.

## Verdict

No blockers. Two Medium findings are missed-simplification/duplication debt
in `generate-draft.ts` and `ingest-failed-hook.ts` that will amplify future
changes (a new transient error class; a fourth zernio exception type) — worth
a follow-up pass but not gating. All repo-specific standards checked
(db-imports, static-policy, no-any, constants, layering, doc lockstep) pass.

---
# Orchestrator triage (2026-07-19)

- M1 (transient predicate duplicated): ACCEPT — extract one module-local `isTransientGenerationError` predicate, use at all three sites (primary, inner guardrail, outer guardrail).
- M2 (stop wrapping regen errors): DECLINE for this branch — changes logged error-text contracts on tested code for marginal gain beyond M1's fix; queued as post-merge cleanup.
- M3 (CAS choreography + ON CONFLICT INSERT triplicated): ACCEPT — extract `withOwnedTerminalTransition` wrapper + `insertReviewExceptionIfAbsent` helper (single owner for the byte-for-byte-critical predicate); L1's flag ceremony folds into the wrapper.
- L1 (state-flag ceremony): ACCEPT via M3 (wrapper owns the flag); not reworked independently — publisher-sibling precedent keeps the flag concept.
- L2 (widgetOrFallback hardcodes Sentry source): ACCEPT — add source parameter.
