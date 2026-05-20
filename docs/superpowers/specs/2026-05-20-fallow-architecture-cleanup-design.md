# Fallow Architecture Cleanup Design

## Goal

Improve RepWorth's modularity, testability, and long-term scalability in the areas surfaced by `fallow health`, without changing runtime behavior or breaking current owner, admin, onboarding, billing-adjacent, Zernio, notification, or worker workflows.

This is an architecture-first cleanup. Fallow findings are treated as signals, not commands. We will prioritize production modules whose current interfaces are too shallow, whose implementations combine unrelated responsibilities, or whose failure modes are hard to test safely.

## Current Signals

The current `fallow health` report shows a project that is broadly healthy but has concentrated risk in orchestration-heavy modules.

- Overall health is `67.9 C`; production-mode health is `70.8 B`.
- Average maintainability is good: `91.8` overall and `91.5` production-mode.
- There are no circular dependencies and no unused dependencies.
- `p90` cyclomatic complexity is low overall, which means complexity is concentrated in a long tail rather than spread across the codebase.
- Main penalties come from unit size, duplication, hotspots, and mild coupling.
- The most important production clusters are Zernio connect/publishing, dashboard data, onboarding/demo generation, and worker notification/ingress flows.

## Principles

1. Preserve behavior first. Refactors must move code behind clearer seams without changing user-visible outcomes.
2. Work in small, independently shippable phases. No single PR should touch all high-risk flows.
3. Test before moving logic. Existing route and worker tests should become the safety net before extraction.
4. Prefer deep modules over scattered helpers. A new module should hide a meaningful workflow detail behind a compact interface.
5. Do not chase the health score directly. Score improvement is a secondary effect of clearer seams.
6. Avoid suppression except for intentional static-analysis noise that has been reviewed.

## Non-Goals

- No broad rewrite of the app router, worker runner, database layer, or Supabase schema.
- No business logic changes unless tests expose an existing bug.
- No UI redesign.
- No dependency upgrades.
- No sweeping test-file deduplication before production seams are safer.

## Architecture Slices

### Slice 1: Safety Baseline

Purpose: make the refactor measurable and reversible.

Work:

- Save a Fallow baseline for health, targets, production health, and production duplication.
- Map each phase to the narrowest test suites that cover it.
- Identify missing tests for the most fragile seams before extraction.
- Add behavior-preserving regression tests only where a later extraction would otherwise be unsafe.

Success criteria:

- Current behavior is captured by tests for each planned phase.
- `pnpm build` remains the final app-level verification gate.
- Existing untracked files remain untouched unless explicitly brought into scope.

### Slice 2: Zernio Connect and Publishing

Purpose: reduce risk in the highest-complexity external workflow.

Files likely involved:

- `src/app/api/zernio/connect/start/route.ts`
- `src/app/api/zernio/connect/callback/route.ts`
- `src/app/api/zernio/connect/select-location/route.ts`
- `src/app/api/zernio/connect/cancel/route.ts`
- `src/app/api/zernio/disconnect/route.ts`
- `src/lib/zernio/client.ts`
- `src/lib/zernio/connect-state.ts`
- `src/lib/zernio/connect-session-cookie.ts`
- `worker/jobs/publisher/ResponsePublisherWorker.ts`
- `worker/jobs/publisher/publisher-error-handlers.ts`
- Existing tests under `src/app/api/zernio/**/__tests__` and `worker/jobs/publisher/__tests__`

Design:

- Extract Zernio route preflight logic into a small route support module: feature flag, same-origin guard, owner auth, requested location parsing, account/location scope, and active subscription checks.
- Extract Redis pending-flow operations into a module that owns marker parsing, stale checks, compare-and-set updates, compare-and-delete cleanup, and state/profile lookup keys.
- Split the Zernio client into stable outward exports backed by focused internal modules for request transport, error classification, profile/connect operations, location selection, and reply publishing.
- Extract response publisher stages: load context, validate publishable state, handle missing connection, resolve Zernio review id, publish reply, handle terminal outcomes, and mark outbox completion.

Expected interfaces:

- A route calls one compact preflight function and receives either a typed context or a response.
- A route calls pending-flow operations without hand-parsing Redis JSON.
- Publisher code reads as a sequence of named stages whose error modes remain explicit.
- Existing public imports from `src/lib/zernio/client.ts` continue to work during the split.

Risk controls:

- Keep route handler exports unchanged.
- Keep response payloads, redirect targets, cookies, Redis key names, TTLs, and database writes unchanged.
- Refactor one Zernio route at a time.
- Run the relevant Zernio route tests and publisher tests after each extraction.

### Slice 3: Dashboard Route and Data Services

Purpose: separate policy, data retrieval, row mapping, and UI state derivation.

Files likely involved:

- `src/app/api/dashboard/route.ts`
- `src/lib/dashboard/service.ts`
- `src/lib/dashboard/aggregate-service.ts`
- `src/lib/dashboard/types.ts`
- Existing dashboard route and hook tests

Design:

- Extract dashboard route policy into a module that resolves account id, scope mode, location id, subscription response, and fallback behavior.
- Extract active dashboard query execution from active dashboard response assembly.
- Extract row mappers for business settings, review velocity, ranking snapshots, recent reviews, latest brief, and value summary.
- Extract Zernio dashboard banner state calculation into a pure module with table-driven tests.
- Apply the same pattern to aggregate dashboard data where it improves locality.

Expected interfaces:

- The route should mostly coordinate auth, scope, and a data-service call.
- `getActiveDashboardData` should delegate query result assembly to named mapping functions.
- Banner precedence should be testable without SQL or Redis.

Risk controls:

- Preserve response shapes exactly.
- Preserve aggregate vs per-location behavior and fallback metadata.
- Add snapshot-style assertions for response shape where useful.
- Run dashboard route tests and dashboard data tests after each phase.

### Slice 4: Onboarding and Demo Generation

Purpose: make onboarding flows easier to reason about without changing conversion-critical behavior.

Files likely involved:

- `src/app/onboarding/business/BusinessWizardClient.tsx`
- `src/app/onboarding/business/StepLocation.tsx`
- `src/app/api/onboarding/start/route.ts`
- `src/app/api/onboarding/business/route.ts`
- `src/app/api/onboarding/demo/regenerate/route.ts`
- `worker/jobs/OnboardingDemoWorker.ts`
- `src/lib/demos/*`
- `src/lib/onboarding/*`
- Existing onboarding and demo tests

Design:

- Extract client-side payload construction from `BusinessWizardClient` into a pure function or hook-level helper.
- Extract onboarding route guards for auth/session/account state, request parsing, place resolution, and demo-flow branching.
- Extract demo worker stages: reservation release/finalization, subscription state check, claim handling, place id resolution, review source selection, response generation, completion, and failure handling.
- Reuse existing demo lifecycle and fallback modules rather than creating parallel abstractions.

Expected interfaces:

- Client wizard components should keep rendering and navigation state, while payload construction is independently testable.
- Route handlers should coordinate validated inputs and call domain modules.
- The demo worker should read as a durable job pipeline with clear terminal and retry behavior.

Risk controls:

- Preserve onboarding redirects, saved fields, demo fallback behavior, cost-reservation accounting, and outbox state transitions.
- Add focused tests around payload shape and demo worker terminal paths before moving logic.

### Slice 5: Worker Notification and Ingress Flows

Purpose: reduce operational risk in webhook and notification pipelines.

Files likely involved:

- `worker/jobs/notification/dispatch.ts`
- `worker/jobs/notification/NotificationWorker.ts`
- `worker/ingress/twilio/twilio-whatsapp-inbound.ts`
- `worker/ingress/twilio/twilio.ts`
- `worker/ingress/resend.ts`
- `worker/ingress/zernio/zernio.ts`
- `worker/ingress/stripe.ts`
- Existing worker and ingress tests

Design:

- Extract notification dispatch planning from channel execution and outcome recording.
- Extract webhook parsing/verification from side effects for Twilio, Resend, and Zernio ingress.
- Centralize transient vs terminal error classification where the same decision is repeated across workers.
- Keep adapters concrete. Do not introduce abstract provider interfaces unless there are already multiple real adapters.

Expected interfaces:

- Ingress handlers should parse and verify input, then pass a typed event to workflow code.
- Notification dispatch should produce a plan, execute it, and record outcomes in testable stages.
- Worker entry points should remain thin and compatible with BullMQ.

Risk controls:

- Preserve signature verification, deduplication, outbox behavior, retry semantics, and Sentry/audit logging.
- Run targeted worker tests after each extraction.

### Slice 6: Final Hygiene and Fallow Baseline

Purpose: clean up intentional noise after production seams are improved.

Work:

- Remove confirmed unused exports such as `synthesizeSpark` if still unused.
- Consolidate repeated test setup only where it reduces maintenance friction.
- Consider shared route test harnesses for auth/account/location mocks.
- Re-run Fallow in normal and production modes.
- Save a regression baseline or document the desired CI threshold.
- Add Fallow config ignores only for generated or intentionally noisy paths.

Success criteria:

- Health score improves without relying on broad suppressions.
- Production-mode Fallow output has fewer high-priority architecture targets.
- Tests and build pass.

## Testing Strategy

Each phase should use the narrowest relevant tests first, then broader verification before completion.

- Zernio: route tests for start/callback/select-location/cancel and publisher worker tests.
- Dashboard: dashboard route tests, dashboard scope tests, dashboard hook tests, and any data-service tests added for pure mappers.
- Onboarding: onboarding route tests, business wizard tests, demo worker tests, demo lifecycle tests.
- Worker ingress/notifications: notification worker tests, Twilio ingress tests, Resend webhook tests, Zernio ingress tests, Stripe ingress tests where touched.
- Final verification: `pnpm build`.

If coverage data is needed for CRAP accuracy, generate Istanbul coverage separately and pass it to Fallow. Until then, CRAP should be treated as directional.

## Rollout Plan

1. Create one implementation plan with separate tasks per slice.
2. Execute one slice at a time.
3. Commit after each behavior-preserving phase or coherent sub-phase.
4. Re-run Fallow after each slice and compare against baseline.
5. Stop and reassess if tests expose behavior differences.

## Acceptance Criteria

- No known current workflow regresses.
- Route response bodies, redirect locations, cookies, Redis keys, database status transitions, and outbox semantics remain compatible.
- High-complexity orchestration functions are split into named modules with smaller interfaces.
- The codebase has clearer seams for Zernio flows, dashboard data, onboarding/demo flows, and worker notification/ingress flows.
- Relevant unit/integration tests pass for each slice.
- `pnpm build` passes before completion.
- Fallow normal and production-mode outputs are captured after the cleanup.
