# Modularization Requirements

_Last assessed: 2026-05-27 · Basis: graphify graph refreshed against current `main`
(174 source files had drifted since the prior build), then per-file structural
aggregation (function/class count + fan-in/fan-out) cross-checked against raw LOC
and largest-function size._

## How candidates were chosen

Modularization debt is **not** "big file." It is one of two shapes:

1. **One function doing many things** — a single function spanning hundreds of
   lines that interleaves unrelated concerns.
2. **One file owning several unrelated concerns** — a wide export surface where
   the sub-systems share little beyond the file boundary.

Files with high fan-in but a *narrow* interface (many callers, few exports) are
**deep modules** — correctly designed per `design.md`. They are explicitly
excluded below; splitting them would raise cognitive load, not lower it.

All four Tier-1/Tier-2 worker/UI candidates grew through **feature accretion**
(edit-existing-replies revival, wave-1 launch gate, wave-3 AI audit), not the
fallow-health modularization pass (#117 lead-intake, #118 onboarding/start,
#119 tenant-scope, #113 parse-review-webhook). They are the next frontier, not
re-work.

---

## Tier 1 — Modularize now

One giant function hiding several concerns, sitting on a production failure path,
with a clean already-named seam.

### `worker/jobs/publisher/edit-publish.ts` — 910 LOC
- `runEditPublishIfApplicable` ≈ **380 lines**; `handle409Disposition` ≈ **167 lines**.
  Two functions are ~60% of the file.
- Bundles two concerns: publish orchestration **and** a full 409-conflict
  disposition sub-system (`handle409Disposition`, `supersedeSibling`,
  `setOrphanMarker`, `markCandidatePermanentFailedInTx`,
  `applyAuthErrorTerminalInTx`, `indeterminateError`, `Handle409Args`,
  `Tx409Outcome`).
- **Seam:** lift the 409-disposition cluster into
  `publisher/edit-publish-409.ts`. Directly the case CLAUDE.md invariant #12
  names ("extract any error-handling branch over ~30 lines"); `production.md`
  cares because conflict/terminal-failure logic buried in a 380-line function
  obscures failure isolation.

### `worker/background/pollers/StripeLocationsReconcilePoller.ts` — 617 LOC
- `runOnce` ≈ **330 lines** — a single reconcile loop making Stripe calls inline,
  interleaved with overage-item math, flag parsing, and drift alerting.
- **Seam:** move the pure Stripe-item helpers (`findOverageItem`, `isOverageItem`,
  `activeStripeSubscriptions`, `extractStripeCustomerId`) + flag parsing
  (`parseAccountFlags`, `isPilotAccount`) into `stripe-overage.ts`, then split
  the reconcile body into per-account steps so the outbound-Stripe failure path
  is visible.

### `src/components/dashboard/EditReplyDrawer.tsx` — 1275 LOC (largest logic file)
- Main component ≈ **820 lines**, with 6 panel sub-components defined inline
  (`ManualEditor`, `PreviewPanel`, `RecoveryPanel`, `DraftConflictPanel`,
  `ReviewChangedPanel`, `Spinner`).
- **Seam:** each panel → its own file; lift the polling + draft-conflict state
  machine (the `POLL_*` constants, the 4 `useEffect`s) into a `useEditReplyDraft`
  hook. The drawer should compose, not implement.

---

## Tier 2 — Strong, but touch carefully

### `worker/jobs/ResponseGeneratorWorker.ts` — 498 LOC
- `handleResponseGeneration` ≈ **228 lines** orchestrating cost-guard →
  generation → moderation-hold → persist+notify.
- This is the **invariant #4** file (high-confidence-unsafe drafts held, not
  notified). Refactor behind the existing tests; keep the moderation-hold +
  `send_notification` outbox-skip in the **same transaction** as response
  persistence. Extract the generation phase and the moderation/hold branch into
  named functions; leave the transactional boundary intact.

### `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx` — 846 LOC
- 4 inline wizard steps + **15 `useState`** in one component.
- **Seam:** each `WizardStep` → its own component; collapse the 15 `useState`
  into a reducer.

### `src/lib/costs/tracker.ts` — 355 LOC, 13 exports
- Borderline. Cohesive (all Redis-backed cost guards) but bundles three
  sub-systems, each with its own Lua script: cost reservation, concurrency slots,
  regen budget.
- **Seam (only if already in the file):** the concurrency-slot logic
  (`acquireConcurrencySlot`/`releaseConcurrencySlot` + `ACQUIRE_CONCURRENCY_LUA`
  + `concurrencyKey` + `ConcurrencyLimitExceededError`) → `concurrency-guard.ts`.
  The 13-export interface is the smell.
- **✅ Done — PR #130 (merged 2026-05-28).** Extracted the concurrency-slot
  sub-system into `src/lib/costs/concurrency-guard.ts`; `tracker.ts` keeps a
  one-line compat re-export so all consumers resolve unchanged. Cost-reservation +
  regen budget stay in `tracker.ts` (the single named seam — not the full
  13-export split, which the "touch carefully" note cautions against).
- **✅ Follow-up done — 2026-05-28.** Shim deleted. Repointed `cost-guard.ts`
  (slot fns) and `worker/jobs/response-generation/generate-draft.ts`
  (`ConcurrencyLimitExceededError`) to `concurrency-guard`, and moved the
  concurrency mocks in all **five** consumer tests — `cost-guard.test.ts`,
  `generator.test.ts`, `review-summary.test.ts` (transitive via `withCostGuard`),
  plus `generate-draft.test.ts` and `ResponseGeneratorWorker.test.ts` (transitive
  via the real `generate-draft`). The original follow-up named only the first
  three and `ResponseGeneratorWorker.ts`; the post-PR-#128 reality is that the
  RGW concurrency-error handling moved into `generate-draft.ts`, and the two
  worker tests were surfaced during implementation. `concurrency-guard.ts` is now
  the single source for the three symbols; `tracker.ts` keeps cost-reservation +
  regen budget only.

---

## Explicitly leave alone (look big, but splitting would hurt)

- **`scripts/ci/tenant-scope-allowlist.ts`** (2058 LOC) — 336 declarative entries,
  **0 functions**. Pure data registry; one file *is* the design ("one
  authoritative owner").
- **`scripts/ci/tenant-scope-audit.ts`** (781 LOC, 45 *small* functions) — already
  decomposed in #119. High function count here is good decomposition (a cohesive
  SQL-parsing mini-language), not a god file.
- **Deep modules (high fan-in, narrow interface):** `src/lib/db/server.ts`
  (deg 453 / 6 nodes), `db/auth.ts`, `shared/ids.ts`, `shared/outbox.ts`,
  `shared/logger.ts`. Textbook deep modules — splitting raises cognitive load.
- **Marketing content** (`FeaturesContent.tsx` 1150, `HowItWorksContent.tsx` 709,
  `PricingContent.tsx`) — JSX content, not logic. Low value; extract copy to data
  only if CMS-ability is later wanted.

---

## Recommended order

Start with `edit-publish.ts` and `StripeLocationsReconcilePoller.ts` — both have a
300+ line function with a clean, already-named seam, and both sit on production
failure paths where the current shape actively obscures error handling.
