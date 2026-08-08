# Spec & correctness review — `fix-697-import-consent-analytics-sink` (round 1)

**Axis:** spec fidelity + correctness. **Diff:** `git diff main...HEAD`, commits `fbdc3e4e` (intake) + `314ab8cd` (implementation).
**Verdict:** implementation is faithful to the locked intake. No Critical / High / Medium finding. Two Low findings, both test-strength gaps on explicitly-locked intake items.

---

## 1. Files touched vs `allowed_edit_surface`

| File | Status | In surface? |
|---|---|---|
| `src/lib/reviews/import-consent.ts` | M | yes (named) |
| `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts` | M | yes (named) |
| `docs/runbooks/beta-launch-alerting.md` | M | yes (named) |
| `docs/superpowers/plans/fix-697-import-consent-analytics-sink-intake.json` | A | yes (`docs/superpowers/plans/**`) |

No file outside the surface. No new top-level directory, no new dependency (`@sentry/node` is already a direct dependency, `^10.55.0`).

## 2. `goal` — met

`emitConsentEvent`'s catch now calls `Sentry.captureMessage('Import consent analytics emission failed', { level: 'warning', tags: { subsystem: 'import_consent_analytics', event_name }, extra: { business_id, event_name, error } })` inside its own `try/catch`, then emits the pre-existing structured `warn`. That is precisely the goal sentence.

Verified live (`pnpm vitest run --project integration src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts` against the local test DB — 15/15 pass), and the stderr shows the warn line retained byte-identically:

```
{"level":"warn","logger":"import-consent","message":"Import consent analytics emission failed",
 "data":{"business_id":"061dc94a-…","event_name":"import_offer_created",
 "error":"new row for relation \"analytics_events\" violates check constraint \"analytics_events_event_name_check\""}}
```

## 3. `non_goals` — all respected

| Non-goal | Evidence |
|---|---|
| No change to the savepoint | `import-consent.ts:555` `await tx.savepoint((sp) => enqueueAnalyticsEvent(sp, input));` — byte-identical to `main` |
| No change to the `errorStringProperty(error,'code')` narrowing / swallow-vs-rethrow set | `import-consent.ts:557` `if (errorStringProperty(error, 'code') === undefined) throw error;` — byte-identical to `main`; the capture is strictly *after* it |
| No HealthAlertPoller counter / aggregation (option B) | `worker/background/pollers/**` untouched |
| #695's policy-block sink not designed in | nothing under the consent guard touched |
| No change to event names, keys, migration 102, the CHECK constraint | `src/lib/analytics/events.ts`, `supabase/migrations/**` untouched; `ci:analytics-events` passes |
| `reportCaughtError`'s interface not widened | `src/lib/shared/report-caught-error.ts` untouched |
| Sentry alert rule itself not configured — runbook checklist item only | the runbook diff is an unchecked `- [ ]` item under §1 |

## 4. `tests_to_add` — all four present VERBATIM and non-vacuous

| Intake title | Line | Non-vacuity |
|---|---|---|
| `createImportOffer reports a swallowed emission failure to Sentry with a routable subsystem tag` | :793 | Injects a real `23514` on `analytics_events_event_name_check`; asserts `toHaveBeenCalledTimes(1)`, exact title, `level:'warning'`, exact `tags` via `toEqual`, and that the constraint name reaches `extra.error`. Deleting the capture, dropping the tag, or renaming either string turns it red. |
| `recordImportDecisionAndEnqueue reports a swallowed emission failure to Sentry with a routable subsystem tag` | :829 | Same, second writer, `event_name: 'import_decision_recorded'`. |
| `a Sentry capture that throws does not resurface into the caller transaction` | :862 | `mockImplementationOnce(() => { throw … })`, then a `tx\`UPDATE businesses …\`` on the caller's own handle *after* the offer. Deleting the inner `catch` propagates the throw out of `emitConsentEvent` → `createImportOffer` → the `begin` callback → the outer `sql().begin()` rejects and the test fails. |
| `a code-less emission failure reports nothing to Sentry before it rethrows` | :894 | `codelessPoison` (a `TypeError` without `code`); asserts `rejects.toBeInstanceOf(TypeError)` **and** `not.toHaveBeenCalled()`. Moving the capture above the narrowing turns it red. |

The two operator-facing strings are re-spelled in the test rather than imported (`:275-276`), so a rename in `import-consent.ts` — which would silently unhook the configured Discord rule — fails the suite. That is the correct call.

## 5. `edge_cases` — 4 of 5 pinned by a test, all 5 correct in code

| Edge case | Handled? | Pinned? |
|---|---|---|
| Sentry uninitialized (no `SENTRY_DSN`) is an inert no-op | Yes — verified by direct probe: `require('@sentry/node').captureMessage(…)` with `getClient() === undefined` returns an event id and throws nothing | Not testable through the mock; behaviour is the SDK's |
| `captureMessage` itself throws → swallowed, warn still emits, caller usable | Yes | **Partially** — see finding L2: the "warn still emits" half is unasserted |
| Code-less failure rethrows before any Sentry call | Yes | Yes (`:894`) |
| Connection-lifecycle errors carry a `code` → swallowed *and* reported (known imprecision) | Yes, documented in both the module comment and the runbook | n/a (deliberate) |
| Both writers report | Yes — `createImportOffer` (`:308`) and `recordImportDecisionAndEnqueue` (`:407`) are the only two `emitConsentEvent` call sites in the repo | Yes, one title each |

## 6. `user_visible_behavior` — no drift

The only behavioural delta is the added capture. The warn's message string moved to the `EMISSION_FAILURE_MESSAGE` constant with the same literal value; the `detail` object was extracted to a local and passed to both sinks with identical contents. Confirmed byte-identical in the live run's stderr. No owner-visible change; nothing outside the two named observable effects.

## 7. Sentry correctness in BOTH runtimes

**(a) Cannot break the Next build or an ESLint boundary.**
`@sentry/node` is not on any `no-restricted-imports` list in `eslint.config.mjs`, and `src/lib/**` is not an entry-surface zone — `src/__tests__/eslint-boundaries.test.ts` explicitly asserts `shared src/lib importing openai does NOT error (shared boundary intact)`, i.e. the bans apply to `src/app/**`, `src/components/**` and `src/instrumentation.ts` only. `pnpm lint` passes. `pnpm build` passes (exit 0, full route manifest emitted). `next.config` applies `withSentryConfig`, which externalizes the Node SDK server-side.

`import-consent.ts` is reachable only from server code — `finalize-tx.ts`, `import-offer/route.ts`, `archive-location-tx.ts`, `job-eligibility.ts`, `worker/ingress/stripe/shared.ts`. The one component touching this area, `ImportOfferBanner.tsx:37`, uses `import type` from `import-offer-view.ts` and never reaches `import-consent.ts`, so nothing pulls `@sentry/node` into a client bundle.

**(b) The `@sentry/nextjs` re-export claim is TRUE for this install.**
`package.json` pins `@sentry/nextjs@^10` and `@sentry/node@^10.55.0`; both installed at `10.55.0`. Resolving `@sentry/node` from the repo root and from inside `@sentry/nextjs` both land on the identical physical file:

```
node_modules/.pnpm/@sentry+node@10.55.0/node_modules/@sentry/node/build/cjs/index.js
```

`src/instrumentation.ts:47` runs `Sentry.init` (from `@sentry/nextjs`) in the `nodejs` runtime and `worker/sentry.ts:6` runs `Sentry.init` (from `@sentry/node`) — both with `beforeSend: scrubSentryEvent(event, { scrubRequestData: true })` and no `sampleRate` override, so `warning`-level messages are not sampled away. This is the same property `report-caught-error.ts:9-13` already relies on from routes in production.

**(c) Safe when Sentry is uninitialized.** Probed directly: `getClient()` is `undefined`, `captureMessage` returns an event id and throws nothing. Local dev and DSN-less previews take the no-op path; the swallow behaviour is unchanged either way.

## 8. The `vi.mock('@sentry/node', () => ({ captureMessage }))` whole-module replacement — proven safe

I resolved the suite's full transitive runtime import graph (`@/…` + relative, `import type` excluded, dynamic `import()` included). It is 14 modules:

```
import-offer-analytics.integration.test.ts, __tests__/helpers/describe-with-db.ts,
shared/__tests__/live-db-tenant.ts, shared/__tests__/helpers/schema-ready.ts,
shared/__tests__/helpers/abort-injection.ts, reviews/import-consent.ts,
analytics/enqueue.ts, analytics/events.ts, shared/queue-names.ts,
accounts/tier-config.ts, shared/logger.ts, config/deployment-lane.ts,
shared/log-context.ts, payments/stripe-error-inspect.ts
```

Exactly one of them references `@sentry/node` — `import-consent.ts:95`, and it is a **namespace** import (`import * as Sentry`), which cannot fail at import time on a missing export the way a named import would. None of the 14 is a re-export barrel (`export * from` / `export {…} from` returns nothing across all 14), so no third module enters through a re-export. `vitest.setup.ts` imports only `@testing-library/jest-dom`. The suite's own comment claiming this is accurate.

Cross-suite contamination ruled out empirically: full `parallel` project **813 files / 10788 tests pass**; full `integration` project 78/80 files pass, the sole failure being `migration-056-account-offboarding.integration.test.ts` reporting `relation "account_offboarding_tokens" does not exist` — a local test DB behind migrations head (`pnpm test:db:setup`), unrelated to this diff and to any table it touches.

## 9. PII / logging discipline — clean

`extra` and the warn carry exactly `{ business_id, event_name, error }`. `error` is `error.message` only. For the `23514` case postgres.js puts the failing row (which contains the `properties` JSONB) in `error.detail`, never `error.message` — confirmed by the live run, whose logged message is just `new row for relation "analytics_events" violates check constraint "analytics_events_event_name_check"`. No review text, tokens, handles, or analytics `properties` reach either sink.

The `tags` are two low-cardinality strings (a constant + one of two event names) — no unbounded tag values.

## 10. `scrubSentryEvent` interaction — benign

`scrubSentryEvent` runs `scrubObject` over `event.extra`, redacting keys matching `/key|secret|token|password|authorization/i`. None of `business_id`, `event_name`, `error` matches, so the payload passes through intact — the scrubber neither corrupts the signal nor is defeated by it. `scrubObject` mutates in place, but Sentry `normalize()`s (deep-copies) the event before `beforeSend`, and `captureMessage`'s processing is deferred to a microtask, so the caller's `detail` object cannot be mutated before `logger.warn` reads it. Confirmed: the live warn line prints unredacted values.

## 11. Live-DB suite conventions — no violation

- Filename unchanged (`*.integration.test.ts`) → still in the serialized `integration` project.
- `assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT])` still at `:466`.
- The only SQL the four new tests execute is `UPDATE businesses SET name = …` (`:876`) — DML, not DDL. No `CREATE`/`ALTER`/`DROP`, no `.unsafe()`, no migration application.
- `pnpm ci:live-db-suites` passes. Because that audit AST-extracts *executed* SQL rather than matching a marker (#694), a violation here could not slip past it; nothing in the diff is statically invisible in the way the `-- live-db-ddl-ignore` escape exists for.

## 12. Blast radius — no caller relied on a changed semantic

The only semantic change is one additional, fully-guarded statement inside an already-existing catch. Every listed importer either (a) never reaches `emitConsentEvent` (`archive-location-tx.ts`, `job-eligibility.ts`, `import-offer-view.ts` — read paths) or (b) reaches it through `createImportOffer` / `recordImportDecisionAndEnqueue`, whose success/failure contract is unchanged. All 50 test files across those importer directories pass (759 tests).

## 13. Runbook accuracy

The new §1 checklist item's factual claims all check out: the tag and level match the code; `tags.event_name` does distinguish the two; the writers really are `finalize-tx.ts:208` + `import-offer/route.ts:103,176` (Vercel Next) and `worker/ingress/stripe/shared.ts:159` (Railway worker), so "fires from BOTH lanes" is exactly right and the list is complete; `SENTRY_DSN` is documented for **Vercel + Railway** (`env-vars.md:105`), so routing on the tag rather than on a project is the correct instruction.

## 14. Verification run

| Check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm build` | pass (exit 0) |
| 15 `ci:*` audits (tenant-scope, rls, analytics-events, static-policy, response-status, admin-aal2, config-coverage, process-env, reviews-status, outbox-topics, outbox-status, db-imports, feature-surface, agent-config, outbox-seam) | all pass |
| `ci:live-db-suites` | pass |
| `vitest --project parallel` (full) | 813 files / 10788 tests pass |
| `vitest --project integration` (full, live DB) | 78/80 pass; 1 pre-existing env failure (`migration-056`, local DB behind head), unrelated |
| changed suite, live DB | 15/15 pass |

---

## Findings

| severity | file:line | finding |
|---|---|---|
| Low | `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:820` (and `:856`) | `expect(options.extra).toMatchObject({…})` is a subset assertion, so the intake's locked invariant "No review text, tokens, handles, or event properties reach Sentry — only business_id, event_name, and the error message" has **no** guard. Adding `properties: input.properties` (or the review text, or a `Sql` handle) to `detail` at `import-consent.ts:558` would ship green through all 15 tests and start shipping analytics payloads to Sentry. The adjacent `options.tags` assertion at `:816`/`:852` uses exact `toEqual` — the same treatment on `extra` closes it. |
| Low | `src/lib/reviews/import-consent.ts:583` | The structured `warn` sits **outside** the inner guard — deliberate and correct, because it is what satisfies intake edge case #2 ("`captureMessage` throws → swallowed by the inner catch; **the warn still emits**"). But nothing pins it: the one test that makes the capture throw (`…test.ts:862`) asserts only `toHaveBeenCalledTimes(1)`, `result === 'created'` and the post-capture row write. Moving line 583 inside the `try` at `:569` — which is literally the shape of the precedent the intake names (`circuit-breaker.ts:185-205`, "the whole block wrapped in try/catch") and therefore a plausible "make it match the pattern" cleanup — silently deletes the second, independent sink on exactly the transport-failure path where it is the only remaining one, and every test stays green. A `console.warn` spy (or asserting the warn from the throwing test) makes the ordering load-bearing. |

---

## Triage — round 1 (orchestrator, 2026-08-08)

| # | verdict | disposition |
|---|---|---|
| 1 — `extra` is a subset assertion | **ACCEPT** | Fixed. Both titles now assert `toEqual` with an exact key set (`business_id`, `event_name`, `error: expect.stringContaining(EVENT_NAME_CONSTRAINT)`). Verified non-vacuous: adding `properties: input.properties` to `detail` turns both red (mutation 4). The reviewer is right that the key SET, not its contents, is where the PII invariant lives. |
| 2 — warn-outside-the-guard unpinned | **ACCEPT** | Fixed. "a Sentry capture that throws does not resurface into the caller transaction" now spies `console.warn` (the sink `createWorkerLogger` uses at level `warn`) and asserts the line still emits, with `mockRestore` in a `finally` so a vitest timeout cannot leave the stub in place for the rest of the serialized project. Verified non-vacuous: moving the warn inside the capture's `try` turns exactly that title red and nothing else (mutation 5). A comment at the call site now states why the ordering is load-bearing, so the next reader does not "tidy" it back toward the precedent. |

Appendix items acted on (below the bar as findings, but cheap and correct):

- **`docs/launch-checklist.md:47-48` second routing inventory** — acted on. The
  surface was AMENDED (+`docs/launch-checklist.md`; amendment #1 of the 2-item
  budget; both intake copies updated) rather than deferred: leaving one of two
  routing inventories un-extended is the same class of drift #697 is about, and
  the fix is two lines.
- **Sentry grouping is one bucket → a new-issue rule fires once, ever** — acted
  on. Both the runbook item and the launch-checklist item now say to use an
  event-frequency condition and why. That is the difference between a rule that
  works and one that only looks configured.

Rejected / not acted on:

- **"The four new tests never run in a required CI check."** Correct, and
  explicitly NOT a defect of this diff — it is the documented repo-wide property
  (CLAUDE.md: "an existing-but-not-run suite is how #520 shipped"). Changing which
  suites CI hard-gates is a separate decision with its own blast radius, and doing
  it inside an observability fix is exactly the scope sprawl this lane forbids.
  Mitigated here instead by running the suite locally against the live DB on every
  gate pass, and by the five mutations recorded above/below, each verified to turn
  the intended title red and only that title.
- **`warn` could in principle throw.** The reviewer already disproved it
  (`logger.ts:75-95` is fail-open on both `sanitizeAnalyticsProperties` and
  `JSON.stringify`). No change.

### Mutation log (all verified against the live DB)

| # | mutation | expected red | observed |
|---|---|---|---|
| 1 | delete the `captureMessage` call | titles 1–3 | 3 failed, 12 passed |
| 2 | delete the capture's inner `catch` | title 3 only | 1 failed, 14 passed |
| 3 | move the capture ABOVE the code-less rethrow guard | title 4 only | 1 failed, 14 passed |
| 4 | add `properties: input.properties` to `detail` | titles 1–2 | 2 failed, 13 passed |
| 5 | move the `warn` inside the capture's `try` | title 3 only | 1 failed, 14 passed |

---

## Appendix — below the confidence bar (not findings)

- **`warn` outside the guard is not itself a hazard.** I checked whether leaving line 583 unguarded could re-open the connect outage: `emit()` in `src/lib/shared/logger.ts:75-95` wraps *both* `sanitizeAnalyticsProperties` and `JSON.stringify` in their own fail-open `try/catch`, and `detail` is three JSON-safe primitives, so `logger.warn` has no realistic throw path. The deviation from the named precedent is a documented, intentional trade (it buys edge case #2) — only the missing test for it is reportable, above.
- **`docs/launch-checklist.md:47-48` carries a second inventory of routing tags** (`subsystem:health_alert` and `cost_event:limit_exceeded`) that was not extended with `subsystem:import_consent_analytics`. Not reported: that file is outside `allowed_edit_surface`, so editing it here would have been the larger violation. Worth a one-line follow-up at merge/sweep time.
- **The four new tests never run in a *required* CI check.** They are in a live-DB integration suite, which self-skips in `ci.yml` (`TEST_DATABASE_POOL_URL` unset) and is not in `pnpm test:integration`'s hard-gated set. They *do* execute in `fallow.yml`, which stands up its own `postgres:16` and runs `pnpm test:coverage` (#581) — but that job is explicitly "NOT a required status check yet". So a regression deleting the inner `catch` could merge green on required checks. This is a pre-existing, repo-wide, documented structural property (CLAUDE.md, "an existing-but-not-run suite is how #520 shipped"), not something this diff introduced.
- **Sentry issue grouping is one bucket.** The title is a constant, so all drift across both event names, all businesses and both lanes groups into a single Sentry issue. That is what the intake wanted ("Sentry already groups them"), but it means an alert rule keyed on *"a new issue is created"* fires once, ever. The runbook correctly says the actionable pattern is repetition — the rule therefore needs a frequency condition, not a new-issue condition. Rule configuration is non-goal #6 (an ops action), so this is a note for whoever configures it, not a code defect.
- **Local test DB is behind migrations head** in this worktree (`account_offboarding_tokens` missing → 2 failures in `migration-056-account-offboarding.integration.test.ts`). Unrelated to the diff; run `pnpm test:db:setup`.
