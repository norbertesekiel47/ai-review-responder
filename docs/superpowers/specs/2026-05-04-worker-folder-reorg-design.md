# Worker folder reorganization — design

**Date:** 2026-05-04
**Author:** Norbert + Claude
**Scope:** Reorganize `worker/` directory layout. **Mechanical move only — zero logic changes.**

---

## Goal

Replace the current flat-ish `worker/` layout (where `jobs/` mixes job processors, pollers, schedulers, and shared helpers; where `ingress/` mixes webhook entry points with provider-specific helpers; where tests are split across three inconsistent `__tests__/` trees) with a layout that:

- Separates job processors from background loops
- Groups provider-specific webhook helpers under their provider folder
- Co-locates multi-file jobs (notification, publisher, zernio) in their own subfolder
- Co-locates tests next to source under per-folder `__tests__/` (matching `src/` convention)
- Preserves filenames (one accepted exception: `__tests__/helpers.ts` → `test-helpers.ts`)
- Does NOT change any function signatures, exports, or runtime behavior

---

## Confirmed decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Top-level `background/` separate from `ingress/` | Yes — `background/` (covers both `*Poller` and `*Scheduler` files) |
| 2 | Provider sub-folders under `ingress/` (`twilio/`, `telegram/`, `zernio/`) | Yes |
| 3 | Per-job sub-folders under `jobs/` (`notification/`, `publisher/`, `zernio/`) | Yes |
| 4 | Preserve filenames | Yes, with **one** accepted exception: `worker/ingress/__tests__/helpers.ts` → `worker/ingress/test-helpers.ts` |
| 5 | `worker/queues.ts` placement | **Stays at root.** Treated as a root runtime module like `index.ts` and `env.ts`. |
| 6 | Tests | **Colocated** per-folder `__tests__/` matching the `src/**/__tests__/` convention |
| 7 | `correlation-chain.test.ts` placement | Stays at root `worker/__tests__/` (cross-cutting) |
| 8 | `webhook-dedup.test.ts` placement | Goes to `worker/ingress/__tests__/` |

---

## Out of scope (explicitly NOT doing)

- ❌ Splitting `worker/index.ts` into per-section files — that's a logic refactor, not a move.
- ❌ Creating empty `lib/`, `utils/`, `types/`, or `workers/` folders — none has content under "no logic changes".
- ❌ Renaming any file other than `helpers.ts` → `test-helpers.ts`.
- ❌ Touching `package.json`, `vitest.config.ts`, `tsconfig.json`, or any external config (none needs to change).
- ❌ Touching `.env`, secrets, migrations, or production data.
- ❌ Updating historical plan docs in `docs/superpowers/specs/` (only living references).

---

## Target tree

```
worker/
├── env.ts                                  ← STAY (root)
├── index.ts                                ← STAY (root, executable entry)
├── queues.ts                               ← STAY (root) — Decision 5
├── __tests__/
│   └── correlation-chain.test.ts           ← from worker/__tests__/
│
├── config/
│   ├── startup-assert.ts                   ← from worker/startup-assert.ts
│   └── __tests__/
│       └── startup-assertion.test.ts       ← from worker/__tests__/
│
├── ingress/
│   ├── shared.ts                           ← unchanged
│   ├── stripe.ts                           ← unchanged
│   ├── resend.ts                           ← unchanged
│   ├── test-helpers.ts                     ← from worker/ingress/__tests__/helpers.ts (Decision 4 exception)
│   ├── __tests__/
│   │   ├── shared.test.ts                  ← unchanged location
│   │   ├── stripe.test.ts                  ← unchanged location
│   │   ├── stripe-activation-enqueue.test.ts ← from worker/__tests__/
│   │   ├── resend-webhook-bounce.test.ts   ← from worker/__tests__/
│   │   └── webhook-dedup.test.ts           ← from worker/__tests__/
│   ├── twilio/
│   │   ├── twilio.ts
│   │   ├── twilio-intent.ts
│   │   ├── twilio-verify.ts
│   │   ├── twilio-whatsapp.ts
│   │   ├── twilio-whatsapp-inbound.ts
│   │   ├── twilio-whatsapp-status.ts
│   │   ├── whatsapp-shared.ts
│   │   └── __tests__/
│   │       ├── twilio-inbound.test.ts
│   │       ├── twilio-status.test.ts
│   │       ├── twilio-intent.test.ts
│   │       ├── twilio-verify.test.ts
│   │       └── twilio-whatsapp.test.ts
│   ├── telegram/
│   │   ├── telegram.ts
│   │   ├── telegram-callback.ts
│   │   ├── telegram-enrollment.ts
│   │   ├── telegram-shared.ts
│   │   ├── telegram-verify.ts
│   │   └── __tests__/
│   │       ├── telegram.test.ts
│   │       └── telegram-verify.test.ts
│   └── zernio/
│       ├── zernio.ts
│       ├── zernio-verify.ts
│       └── __tests__/
│           └── zernio-verify.test.ts
│
├── jobs/
│   ├── AdminExceptionWorker.ts             ← unchanged
│   ├── DemoGenerationWorker.ts             ← unchanged
│   ├── DrainOwnerConnectWorker.ts          ← unchanged
│   ├── EngagementAlertWorker.ts            ← unchanged
│   ├── MonthlyImpactWorker.ts              ← unchanged
│   ├── OnboardingDemoWorker.ts             ← unchanged
│   ├── OnboardingDripWorker.ts             ← unchanged
│   ├── OwnerEmailWorker.ts                 ← unchanged
│   ├── PlaceIdValidationWorker.ts          ← unchanged
│   ├── RankingTrackingWorker.ts            ← unchanged
│   ├── ResponseGeneratorWorker.ts          ← unchanged
│   ├── WeeklySummaryWorker.ts              ← unchanged
│   ├── __tests__/
│   │   ├── AdminExceptionWorker.test.ts
│   │   ├── DemoGenerationWorker.test.ts
│   │   ├── EngagementAlertWorker.test.ts
│   │   ├── MonthlyImpactWorker.test.ts
│   │   ├── OnboardingDemoWorker.test.ts
│   │   ├── OnboardingDripWorker.test.ts
│   │   ├── PlaceIdValidationWorker.test.ts
│   │   ├── RankingTrackingWorker.test.ts
│   │   ├── ResponseGeneratorWorker.test.ts
│   │   └── WeeklySummaryWorker.test.ts
│   ├── notification/
│   │   ├── NotificationWorker.ts           ← from worker/jobs/
│   │   ├── context.ts                      ← unchanged
│   │   ├── dispatch.ts                     ← unchanged
│   │   ├── eligibility.ts                  ← unchanged
│   │   ├── errors.ts                       ← unchanged
│   │   ├── sms-budget.ts                   ← unchanged
│   │   └── __tests__/
│   │       ├── NotificationWorker.test.ts
│   │       ├── NotificationWorker-sms.test.ts
│   │       ├── NotificationWorker-telegram.test.ts
│   │       ├── NotificationWorker.whatsapp.test.ts
│   │       └── bounced-skip.test.ts
│   ├── publisher/
│   │   ├── ResponsePublisherWorker.ts      ← from worker/jobs/
│   │   ├── publisher-error-handlers.ts     ← from worker/jobs/
│   │   └── __tests__/
│   │       ├── ResponsePublisherWorker.test.ts
│   │       └── publisher-error-handlers.test.ts
│   └── zernio/
│       ├── ZernioBackfillWorker.ts         ← from worker/jobs/
│       ├── ZernioReviewIngestWorker.ts     ← from worker/jobs/
│       ├── zernio-ingest-shared.ts         ← from worker/jobs/
│       └── __tests__/
│           ├── ZernioBackfillWorker.test.ts
│           ├── ZernioReviewIngestWorker.test.ts
│           ├── zernio-ingest-shared.test.ts
│           └── zernio-end-to-end.integration.test.ts
│
└── background/
    ├── ArchivalPoller.ts                   ← from worker/jobs/
    ├── CleanupAbandonedSignupsPoller.ts    ← from worker/jobs/
    ├── EmailChannelReconcilePoller.ts      ← from worker/jobs/
    ├── EngagementMonitorPoller.ts          ← from worker/jobs/
    ├── MonthlyImpactScheduler.ts           ← from worker/jobs/
    ├── NotificationFailoverPoller.ts       ← from worker/jobs/
    ├── OnboardingDripScheduler.ts          ← from worker/jobs/
    ├── OutboxPoller.ts                     ← from worker/jobs/
    ├── RankingTrackingScheduler.ts         ← from worker/jobs/
    ├── WeeklySummaryScheduler.ts           ← from worker/jobs/
    └── __tests__/
        ├── ArchivalPoller.test.ts
        ├── CleanupAbandonedSignupsPoller.test.ts
        ├── EmailChannelReconcilePoller.test.ts
        ├── EngagementMonitorPoller.test.ts
        ├── NotificationFailoverPoller.test.ts
        ├── OnboardingDripScheduler.test.ts
        └── RankingTrackingScheduler.test.ts
```

---

## File counts (verified against `git ls-files worker/`)

- **Total tracked files in `worker/`:** 98
- **Files staying in place:** 27
  - 3 root: `env.ts`, `index.ts`, `queues.ts`
  - 3 ingress root: `shared.ts`, `stripe.ts`, `resend.ts`
  - 2 ingress test helpers: `shared.test.ts`, `stripe.test.ts`
  - 5 in `jobs/notification/`: `context.ts`, `dispatch.ts`, `eligibility.ts`, `errors.ts`, `sms-budget.ts`
  - 12 in `jobs/`: `AdminExceptionWorker`, `DemoGenerationWorker`, `DrainOwnerConnectWorker`, `EngagementAlertWorker`, `MonthlyImpactWorker`, `OnboardingDemoWorker`, `OnboardingDripWorker`, `OwnerEmailWorker`, `PlaceIdValidationWorker`, `RankingTrackingWorker`, `ResponseGeneratorWorker`, `WeeklySummaryWorker`
  - 1 in `jobs/__tests__/`: `OnboardingDemoWorker.test.ts` (already at target path)
  - 1 cross-cutting test: `worker/__tests__/correlation-chain.test.ts`
- **Files moving:** 71

---

## Path-depth math (corrected)

The relative-path adjustment depends on the source-folder depth change, not a blanket "+1" rule.

| Move pattern | From depth | To depth | `'../src/...'` becomes |
|---|---|---|---|
| `worker/X.ts` → `worker/<sub>/X.ts` (e.g. `startup-assert.ts` → `config/`) | 1 | 2 | `'../src/...'` → `'../../src/...'` |
| `worker/jobs/X.ts` → `worker/jobs/<sub>/X.ts` (notification/publisher/zernio) | 2 | 3 | `'../../src/...'` → `'../../../src/...'` |
| `worker/jobs/X.ts` → `worker/background/X.ts` | 2 | 2 | `'../../src/...'` **unchanged** |
| `worker/ingress/X.ts` → `worker/ingress/<provider>/X.ts` | 2 | 3 | `'../../src/...'` → `'../../../src/...'` |
| Test in `worker/__tests__/` → `worker/<sub>/__tests__/` (e.g. `MonthlyImpactWorker.test.ts` → `jobs/__tests__/`) | 2 | 3 | `'../../src/...'` → `'../../../src/...'` |
| Test in `worker/__tests__/` → `worker/<sub>/<sub2>/__tests__/` (e.g. `ResponsePublisherWorker.test.ts` → `jobs/publisher/__tests__/`) | 2 | 4 | `'../../src/...'` → `'../../../../src/...'` |
| Test in `worker/ingress/__tests__/` → `worker/ingress/<provider>/__tests__/` (e.g. `twilio-inbound.test.ts` → `ingress/twilio/__tests__/`) | 3 | 4 | `'../../../src/...'` → `'../../../../src/...'` |
| Test in `worker/jobs/__tests__/` → `worker/jobs/<sub>/__tests__/` (e.g. `OnboardingDemoWorker.test.ts` → `jobs/__tests__/` — same depth) | 3 | 3 | unchanged |
| Test in `worker/jobs/__tests__/` → `worker/jobs/<sub>/__tests__/` deeper (e.g. `NotificationWorker.whatsapp.test.ts` → `jobs/notification/__tests__/`) | 3 | 4 | `'../../../src/...'` → `'../../../../src/...'` |
| Test in `worker/jobs/__tests__/` → `worker/background/__tests__/` (e.g. `EmailChannelReconcilePoller.test.ts`) | 3 | 3 | unchanged |

`@/...`-aliased imports (`@/lib/...`) resolve via tsconfig path map and are **stable** under all moves.

---

## Files staying vs moving — full per-file table

### Stays in place (27)

| File | Why |
|---|---|
| `worker/env.ts` | Root runtime module |
| `worker/index.ts` | Executable entry point |
| `worker/queues.ts` | Root runtime module (Decision 5) |
| `worker/ingress/shared.ts` | Cross-provider helper, lives at ingress root |
| `worker/ingress/stripe.ts` | Single-file provider, no subfolder needed |
| `worker/ingress/resend.ts` | Single-file provider, no subfolder needed |
| `worker/ingress/__tests__/shared.test.ts` | Pairs with `ingress/shared.ts` |
| `worker/ingress/__tests__/stripe.test.ts` | Pairs with `ingress/stripe.ts` |
| `worker/jobs/AdminExceptionWorker.ts` | Single-file job, stays at jobs/ root |
| `worker/jobs/DemoGenerationWorker.ts` | " |
| `worker/jobs/DrainOwnerConnectWorker.ts` | " |
| `worker/jobs/EngagementAlertWorker.ts` | " |
| `worker/jobs/MonthlyImpactWorker.ts` | " |
| `worker/jobs/OnboardingDemoWorker.ts` | " |
| `worker/jobs/OnboardingDripWorker.ts` | " |
| `worker/jobs/OwnerEmailWorker.ts` | " |
| `worker/jobs/PlaceIdValidationWorker.ts` | " |
| `worker/jobs/RankingTrackingWorker.ts` | " |
| `worker/jobs/ResponseGeneratorWorker.ts` | " |
| `worker/jobs/WeeklySummaryWorker.ts` | " |
| `worker/jobs/notification/context.ts` | Already in correct subfolder |
| `worker/jobs/notification/dispatch.ts` | " |
| `worker/jobs/notification/eligibility.ts` | " |
| `worker/jobs/notification/errors.ts` | " |
| `worker/jobs/notification/sms-budget.ts` | " |
| `worker/__tests__/correlation-chain.test.ts` | Cross-cutting (Decision 7) |
| `worker/jobs/__tests__/OnboardingDemoWorker.test.ts` | Already at target path; no `git mv` needed |

### Moves (71)

| From | To | Notes |
|---|---|---|
| `worker/startup-assert.ts` | `worker/config/startup-assert.ts` | |
| `worker/ingress/__tests__/helpers.ts` | `worker/ingress/test-helpers.ts` | RENAME (Decision 4 exception) |
| `worker/ingress/twilio.ts` | `worker/ingress/twilio/twilio.ts` | |
| `worker/ingress/twilio-intent.ts` | `worker/ingress/twilio/twilio-intent.ts` | |
| `worker/ingress/twilio-verify.ts` | `worker/ingress/twilio/twilio-verify.ts` | |
| `worker/ingress/twilio-whatsapp.ts` | `worker/ingress/twilio/twilio-whatsapp.ts` | |
| `worker/ingress/twilio-whatsapp-inbound.ts` | `worker/ingress/twilio/twilio-whatsapp-inbound.ts` | |
| `worker/ingress/twilio-whatsapp-status.ts` | `worker/ingress/twilio/twilio-whatsapp-status.ts` | |
| `worker/ingress/whatsapp-shared.ts` | `worker/ingress/twilio/whatsapp-shared.ts` | |
| `worker/ingress/telegram.ts` | `worker/ingress/telegram/telegram.ts` | |
| `worker/ingress/telegram-callback.ts` | `worker/ingress/telegram/telegram-callback.ts` | |
| `worker/ingress/telegram-enrollment.ts` | `worker/ingress/telegram/telegram-enrollment.ts` | |
| `worker/ingress/telegram-shared.ts` | `worker/ingress/telegram/telegram-shared.ts` | |
| `worker/ingress/telegram-verify.ts` | `worker/ingress/telegram/telegram-verify.ts` | |
| `worker/ingress/zernio.ts` | `worker/ingress/zernio/zernio.ts` | |
| `worker/ingress/zernio-verify.ts` | `worker/ingress/zernio/zernio-verify.ts` | |
| `worker/ingress/__tests__/twilio-inbound.test.ts` | `worker/ingress/twilio/__tests__/twilio-inbound.test.ts` | |
| `worker/ingress/__tests__/twilio-status.test.ts` | `worker/ingress/twilio/__tests__/twilio-status.test.ts` | |
| `worker/ingress/__tests__/twilio-intent.test.ts` | `worker/ingress/twilio/__tests__/twilio-intent.test.ts` | |
| `worker/ingress/__tests__/twilio-verify.test.ts` | `worker/ingress/twilio/__tests__/twilio-verify.test.ts` | |
| `worker/ingress/__tests__/twilio-whatsapp.test.ts` | `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts` | |
| `worker/ingress/__tests__/telegram.test.ts` | `worker/ingress/telegram/__tests__/telegram.test.ts` | |
| `worker/ingress/__tests__/telegram-verify.test.ts` | `worker/ingress/telegram/__tests__/telegram-verify.test.ts` | |
| `worker/ingress/__tests__/zernio-verify.test.ts` | `worker/ingress/zernio/__tests__/zernio-verify.test.ts` | |
| `worker/__tests__/stripe-activation-enqueue.test.ts` | `worker/ingress/__tests__/stripe-activation-enqueue.test.ts` | |
| `worker/__tests__/resend-webhook-bounce.test.ts` | `worker/ingress/__tests__/resend-webhook-bounce.test.ts` | |
| `worker/__tests__/webhook-dedup.test.ts` | `worker/ingress/__tests__/webhook-dedup.test.ts` | Decision 8 |
| `worker/jobs/NotificationWorker.ts` | `worker/jobs/notification/NotificationWorker.ts` | |
| `worker/jobs/ResponsePublisherWorker.ts` | `worker/jobs/publisher/ResponsePublisherWorker.ts` | |
| `worker/jobs/publisher-error-handlers.ts` | `worker/jobs/publisher/publisher-error-handlers.ts` | |
| `worker/jobs/ZernioBackfillWorker.ts` | `worker/jobs/zernio/ZernioBackfillWorker.ts` | |
| `worker/jobs/ZernioReviewIngestWorker.ts` | `worker/jobs/zernio/ZernioReviewIngestWorker.ts` | |
| `worker/jobs/zernio-ingest-shared.ts` | `worker/jobs/zernio/zernio-ingest-shared.ts` | |
| `worker/jobs/ArchivalPoller.ts` | `worker/background/ArchivalPoller.ts` | |
| `worker/jobs/CleanupAbandonedSignupsPoller.ts` | `worker/background/CleanupAbandonedSignupsPoller.ts` | |
| `worker/jobs/EmailChannelReconcilePoller.ts` | `worker/background/EmailChannelReconcilePoller.ts` | |
| `worker/jobs/EngagementMonitorPoller.ts` | `worker/background/EngagementMonitorPoller.ts` | |
| `worker/jobs/MonthlyImpactScheduler.ts` | `worker/background/MonthlyImpactScheduler.ts` | |
| `worker/jobs/NotificationFailoverPoller.ts` | `worker/background/NotificationFailoverPoller.ts` | |
| `worker/jobs/OnboardingDripScheduler.ts` | `worker/background/OnboardingDripScheduler.ts` | |
| `worker/jobs/OutboxPoller.ts` | `worker/background/OutboxPoller.ts` | |
| `worker/jobs/RankingTrackingScheduler.ts` | `worker/background/RankingTrackingScheduler.ts` | |
| `worker/jobs/WeeklySummaryScheduler.ts` | `worker/background/WeeklySummaryScheduler.ts` | |
| `worker/__tests__/startup-assertion.test.ts` | `worker/config/__tests__/startup-assertion.test.ts` | |
| `worker/__tests__/AdminExceptionWorker.test.ts` | `worker/jobs/__tests__/AdminExceptionWorker.test.ts` | |
| `worker/__tests__/DemoGenerationWorker.test.ts` | `worker/jobs/__tests__/DemoGenerationWorker.test.ts` | |
| `worker/__tests__/EngagementAlertWorker.test.ts` | `worker/jobs/__tests__/EngagementAlertWorker.test.ts` | |
| `worker/__tests__/MonthlyImpactWorker.test.ts` | `worker/jobs/__tests__/MonthlyImpactWorker.test.ts` | |
| `worker/__tests__/OnboardingDripWorker.test.ts` | `worker/jobs/__tests__/OnboardingDripWorker.test.ts` | |
| `worker/__tests__/PlaceIdValidationWorker.test.ts` | `worker/jobs/__tests__/PlaceIdValidationWorker.test.ts` | |
| `worker/__tests__/RankingTrackingWorker.test.ts` | `worker/jobs/__tests__/RankingTrackingWorker.test.ts` | |
| `worker/__tests__/ResponseGeneratorWorker.test.ts` | `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` | |
| `worker/__tests__/WeeklySummaryWorker.test.ts` | `worker/jobs/__tests__/WeeklySummaryWorker.test.ts` | |
| `worker/__tests__/NotificationWorker.test.ts` | `worker/jobs/notification/__tests__/NotificationWorker.test.ts` | |
| `worker/__tests__/NotificationWorker-sms.test.ts` | `worker/jobs/notification/__tests__/NotificationWorker-sms.test.ts` | |
| `worker/__tests__/NotificationWorker-telegram.test.ts` | `worker/jobs/notification/__tests__/NotificationWorker-telegram.test.ts` | |
| `worker/jobs/__tests__/NotificationWorker.whatsapp.test.ts` | `worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts` | |
| `worker/__tests__/bounced-skip.test.ts` | `worker/jobs/notification/__tests__/bounced-skip.test.ts` | |
| `worker/__tests__/ResponsePublisherWorker.test.ts` | `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts` | |
| `worker/__tests__/publisher-error-handlers.test.ts` | `worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts` | |
| `worker/__tests__/ZernioBackfillWorker.test.ts` | `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` | |
| `worker/__tests__/ZernioReviewIngestWorker.test.ts` | `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts` | |
| `worker/__tests__/zernio-ingest-shared.test.ts` | `worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts` | |
| `worker/__tests__/zernio-end-to-end.integration.test.ts` | `worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts` | |
| `worker/__tests__/ArchivalPoller.test.ts` | `worker/background/__tests__/ArchivalPoller.test.ts` | |
| `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts` | `worker/background/__tests__/CleanupAbandonedSignupsPoller.test.ts` | |
| `worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts` | `worker/background/__tests__/EmailChannelReconcilePoller.test.ts` | |
| `worker/__tests__/EngagementMonitorPoller.test.ts` | `worker/background/__tests__/EngagementMonitorPoller.test.ts` | |
| `worker/__tests__/NotificationFailoverPoller.test.ts` | `worker/background/__tests__/NotificationFailoverPoller.test.ts` | |
| `worker/__tests__/OnboardingDripScheduler.test.ts` | `worker/background/__tests__/OnboardingDripScheduler.test.ts` | |
| `worker/__tests__/RankingTrackingScheduler.test.ts` | `worker/background/__tests__/RankingTrackingScheduler.test.ts` | |

---

## Import-path edits — comprehensive

### A. `worker/index.ts` — static imports AND re-exports

Currently 30+ imports of moved files PLUS one re-export that points at a moved file. Both surfaces must be updated; missing the re-export would silently break any consumer that does `import { assertChannelsSmsEnv } from '../worker'` or similar.

The three re-export statements at the bottom of `worker/index.ts` (lines 488–490):

| Statement | Action |
|---|---|
| `export { queues, QUEUE_NAMES } from './queues';` | unchanged — queues.ts stays at root |
| `export { sql } from '../src/lib/db/server';` | unchanged — src/ not moving |
| `export { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv } from './startup-assert';` | **rewrite source path** to `'./config/startup-assert'` |

The static imports of moved files:

| Old | New |
|---|---|
| `'./startup-assert'` | `'./config/startup-assert'` |
| `'./queues'` | unchanged (queues.ts stays) |
| `'./jobs/OutboxPoller'` | `'./background/OutboxPoller'` |
| `'./jobs/NotificationFailoverPoller'` | `'./background/NotificationFailoverPoller'` |
| `'./jobs/WeeklySummaryScheduler'` | `'./background/WeeklySummaryScheduler'` |
| `'./jobs/ArchivalPoller'` | `'./background/ArchivalPoller'` |
| `'./jobs/MonthlyImpactScheduler'` | `'./background/MonthlyImpactScheduler'` |
| `'./jobs/EngagementMonitorPoller'` | `'./background/EngagementMonitorPoller'` |
| `'./jobs/RankingTrackingScheduler'` | `'./background/RankingTrackingScheduler'` |
| `'./jobs/OnboardingDripScheduler'` | `'./background/OnboardingDripScheduler'` |
| `'./jobs/CleanupAbandonedSignupsPoller'` | `'./background/CleanupAbandonedSignupsPoller'` |
| `'./jobs/EmailChannelReconcilePoller'` | `'./background/EmailChannelReconcilePoller'` |
| `'./jobs/NotificationWorker'` | `'./jobs/notification/NotificationWorker'` |
| `'./jobs/ResponsePublisherWorker'` | `'./jobs/publisher/ResponsePublisherWorker'` |
| `'./jobs/publisher-error-handlers'` | `'./jobs/publisher/publisher-error-handlers'` |
| `'./jobs/ZernioReviewIngestWorker'` | `'./jobs/zernio/ZernioReviewIngestWorker'` |
| `'./jobs/ZernioBackfillWorker'` | `'./jobs/zernio/ZernioBackfillWorker'` |
| `'./ingress/twilio'` | `'./ingress/twilio/twilio'` |
| `'./ingress/twilio-whatsapp'` | `'./ingress/twilio/twilio-whatsapp'` |
| `'./ingress/telegram'` | `'./ingress/telegram/telegram'` |
| `'./ingress/zernio'` | `'./ingress/zernio/zernio'` |
| `'./ingress/{resend,stripe}'` | unchanged |

### B. Moved source files — parent-path adjustments per the depth math

Apply per the table above. Files needing `'../../src/...'` → `'../../../src/...'`:
- All 14 moved files in `worker/ingress/{twilio,telegram,zernio}/`
- All 6 moved files in `worker/jobs/{notification/NotificationWorker.ts,publisher/*,zernio/*}` (2 publisher + 3 zernio + 1 notification = 6)

Files where `'../../src/...'` stays unchanged (depth same):
- All 10 files moving from `worker/jobs/` → `worker/background/`

Files where `'../src/...'` becomes `'../../src/...'`:
- `worker/startup-assert.ts` (already verified: it has NO src imports — only `process.env` reads — so this is moot)

### C. Sibling-import adjustments inside relocated folders

| File (new path) | Edit |
|---|---|
| `worker/jobs/notification/NotificationWorker.ts` | `'./notification/eligibility'` → `'./eligibility'`; `'./notification/dispatch'` → `'./dispatch'`; `'./notification/context'` → `'./context'` |
| `worker/jobs/publisher/ResponsePublisherWorker.ts` | `'./publisher-error-handlers'` unchanged (still sibling) |
| `worker/jobs/zernio/ZernioBackfillWorker.ts` | `'./zernio-ingest-shared'` unchanged (still sibling) |
| `worker/jobs/zernio/ZernioReviewIngestWorker.ts` | `'./zernio-ingest-shared'` unchanged |
| `worker/ingress/twilio/twilio.ts` | `'./shared'` → `'../shared'`; `'./twilio-verify'` and `'./twilio-intent'` unchanged (siblings) |
| `worker/ingress/twilio/twilio-whatsapp.ts` | barrel re-exports of siblings unchanged |
| `worker/ingress/twilio/twilio-whatsapp-inbound.ts` | `'./shared'` → `'../shared'`; sibling refs unchanged |
| `worker/ingress/twilio/twilio-whatsapp-status.ts` | `'./shared'` → `'../shared'`; sibling refs unchanged |
| `worker/ingress/telegram/telegram.ts` | `'./shared'` → `'../shared'`; sibling refs unchanged |
| `worker/ingress/telegram/telegram-callback.ts` | `'./shared'` → `'../shared'`; sibling unchanged |
| `worker/ingress/telegram/telegram-enrollment.ts` | `'./shared'` → `'../shared'`; sibling unchanged |
| `worker/ingress/zernio/zernio.ts` | `'./shared'` → `'../shared'`; `'./zernio-verify'` unchanged |
| `worker/background/OutboxPoller.ts` | `'../queues'` unchanged (still one level up to root, where queues.ts stays) |

### D. Test files — static imports, `vi.mock()`, AND `await import('...')`

Apply path-depth math from the table above to **all three** import surfaces in every moved test file.

**Files using `vi.mock()` with relative paths that need rewriting:**

| File (old → new path) | Mock paths to rewrite |
|---|---|
| `worker/__tests__/ZernioReviewIngestWorker.test.ts` → `worker/jobs/zernio/__tests__/` | `vi.mock('../jobs/zernio-ingest-shared')` → `vi.mock('../zernio-ingest-shared')`; `vi.mock('../../src/...')` × N → `vi.mock('../../../../src/...')` |
| `worker/__tests__/ZernioBackfillWorker.test.ts` → same | Same shape |
| `worker/ingress/__tests__/twilio-whatsapp.test.ts` → `worker/ingress/twilio/__tests__/` | `vi.mock('../twilio-verify')` (sibling, unchanged); `vi.mock('../shared')` → `vi.mock('../../shared')`; `vi.mock('../../../src/...')` × N → `vi.mock('../../../../src/...')` |
| `worker/ingress/__tests__/telegram.test.ts` → `worker/ingress/telegram/__tests__/` | `vi.mock('../shared')` → `vi.mock('../../shared')`; `vi.mock('../telegram-verify')` (sibling, unchanged); `vi.mock('../../../src/...')` × N → `vi.mock('../../../../src/...')` |
| `worker/ingress/__tests__/stripe.test.ts` | Stays in place: **no path change** |
| `worker/ingress/__tests__/shared.test.ts` | Stays in place: **no path change** |

Plus every other test file that moves and uses `vi.mock('../../src/...')` gets the depth-shift per the table.

**Files using `await import('...')` with relative paths that need rewriting:**

| File (old → new path) | Dynamic-import rewrites |
|---|---|
| `worker/__tests__/EngagementMonitorPoller.test.ts` → `worker/background/__tests__/` | `await import('../jobs/EngagementMonitorPoller')` × 12 → `await import('../EngagementMonitorPoller')` |
| `worker/__tests__/OnboardingDripScheduler.test.ts` → same | × 12 → `'../OnboardingDripScheduler'` |
| `worker/__tests__/NotificationFailoverPoller.test.ts` → same | × 8 → `'../NotificationFailoverPoller'` |
| `worker/__tests__/RankingTrackingScheduler.test.ts` → same | × 19 → `'../RankingTrackingScheduler'` |
| `worker/__tests__/bounced-skip.test.ts` → `worker/jobs/notification/__tests__/` | `await import('../jobs/NotificationWorker')` → `'../NotificationWorker'`; `'../jobs/WeeklySummaryWorker'` → `'../../WeeklySummaryWorker'`; `'../jobs/MonthlyImpactWorker'` → `'../../MonthlyImpactWorker'`; `'../jobs/OnboardingDripWorker'` → `'../../OnboardingDripWorker'` |
| `worker/__tests__/webhook-dedup.test.ts` → `worker/ingress/__tests__/` | `await import('../ingress/stripe')` → `'../stripe'`; `'../ingress/resend'` → `'../resend'` (× 11 total) |
| `worker/__tests__/stripe-activation-enqueue.test.ts` → `worker/ingress/__tests__/` | `await import('../ingress/stripe')` × 9 → `'../stripe'` |

Files with `@/...`-aliased dynamic imports (no edits needed): `publisher-error-handlers.test.ts`, `zernio-ingest-shared.test.ts`, `OnboardingDemoWorker.test.ts`, `worker/index.ts` (single dynamic `await import('../src/lib/db/server')` in `shutdown()` — wait, actually that one IS relative; needs check). Note: `worker/index.ts` is NOT moving, so its dynamic import stays correct.

### E. Helper-file imports — explicit list (Decision 4 exception)

The renamed helper `worker/ingress/__tests__/helpers.ts` → `worker/ingress/test-helpers.ts` requires updating every importer:

| File (after move) | Old import | New import |
|---|---|---|
| `worker/ingress/twilio/__tests__/twilio-inbound.test.ts` | `'./helpers'` | `'../../test-helpers'` |
| `worker/ingress/twilio/__tests__/twilio-status.test.ts` | `'./helpers'` | `'../../test-helpers'` |
| `src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts` | `'.../worker/ingress/__tests__/helpers'` | `'.../worker/ingress/test-helpers'` |

(There are no other importers of `helpers.ts` — verified by grep.)

### F. External callers — non-`worker/` (3 files)

1. **`scripts/zernio-backfill-external-replies.ts:25`**
   - `'../worker/jobs/zernio-ingest-shared'` → `'../worker/jobs/zernio/zernio-ingest-shared'`
2. **`src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts:108`**
   - `'.../worker/ingress/twilio'` → `'.../worker/ingress/twilio/twilio'`
3. **`src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts:109`**
   - `'.../worker/ingress/__tests__/helpers'` → `'.../worker/ingress/test-helpers'` (covered by E above)

### G. Top-of-file path-comment headers in moved files

Many moved files start with a path-comment line like:
```ts
// worker/ingress/twilio.ts
//
// ... rest of header
```

For each moved file, **either update the path comment to the new path or delete the comment line**. Confirmed presence (sample): `telegram-shared.ts`, `telegram-callback.ts`, `telegram-enrollment.ts`, `telegram-verify.ts`, `whatsapp-shared.ts`, `zernio-verify.ts`, `shared.ts`, `startup-assert.ts`. Other moved files may or may not — will check during execution and update each one consistently.

**Choice:** update (don't delete) — the comments are useful navigation hints.

### H. Doc / instruction file references (living docs only — historical specs untouched)

| File | Location of stale path | Update |
|---|---|---|
| `docs/directory.md:546` | `### worker/queues.ts` | unchanged (queues.ts stays at root) |
| `docs/directory.md:556` | `### worker/startup-assert.ts` | `### worker/config/startup-assert.ts` |
| `docs/directory.md:562` | `### worker/jobs/ — BullMQ Job Handlers` | Restructure section to reflect new `jobs/` + `background/` split. Add `worker/background/` section. |
| `docs/directory.md:604` | `#### worker/jobs/notification/` | unchanged (still under jobs/) — but add `NotificationWorker.ts` to its file list |
| `docs/directory.md:616` | `#### worker/jobs/ — shared utility modules (not handlers)` | Move `publisher-error-handlers.ts` reference into `worker/jobs/publisher/` and `zernio-ingest-shared.ts` into `worker/jobs/zernio/` |
| `docs/directory.md:627` | `### worker/ingress/ — Inbound Webhook Handlers` | Restructure to show provider subfolders |
| `docs/directory.md:753` | `worker/jobs/zernio-ingest-shared.ts` | `worker/jobs/zernio/zernio-ingest-shared.ts` |
| `docs/runbooks/zernio-launch-runbook.md:587` | `worker/ingress/zernio.ts`, `worker/ingress/zernio-verify.ts` | `worker/ingress/zernio/zernio.ts`, `worker/ingress/zernio/zernio-verify.ts` |
| `docs/runbooks/zernio-launch-runbook.md:589` | `worker/jobs/ResponsePublisherWorker.ts` | `worker/jobs/publisher/ResponsePublisherWorker.ts` |
| `docs/runbooks/zernio-launch-runbook.md:590` | `worker/jobs/DrainOwnerConnectWorker.ts` | unchanged (stays at jobs/ root) |
| `docs/runbooks/zernio-launch-runbook.md:591` | `worker/jobs/OwnerEmailWorker.ts` | unchanged |
| `docs/runbooks/zernio-ingestion-test-runbook.md:20` | `worker/ingress/zernio.ts` | `worker/ingress/zernio/zernio.ts` |
| `docs/runbooks/zernio-ingestion-test-runbook.md:554` | `worker/jobs/publisher-error-handlers.ts` | `worker/jobs/publisher/publisher-error-handlers.ts` |
| `docs/runbooks/zernio-ingestion-test-runbook.md:569` | `worker/ingress/zernio.ts` | `worker/ingress/zernio/zernio.ts` |
| `.claude/skills/feature-flags.md:131` | `worker/ingress/zernio` | `worker/ingress/zernio/zernio` |
| `.claude/skills/feature-flags.md:139` | `worker/ingress/zernio-verify.ts` | `worker/ingress/zernio/zernio-verify.ts` |
| `.claude/CLAUDE.md:42` | `worker/ingress/*` | unchanged (still glob-true) |
| `src/lib/notifications/channels/whatsapp-channel.ts:7` | `worker/jobs/NotificationWorker.ts` | `worker/jobs/notification/NotificationWorker.ts` |
| `src/lib/shared/queue-names.ts:3` | `worker/queues.ts` | unchanged (queues.ts stays) |
| `src/lib/demos/lifecycle.ts:56` | `worker/jobs/DemoGenerationWorker.ts` | unchanged (stays at jobs/ root) |
| `src/app/api/admin/jobs/route.ts:9` | `worker/queues.ts` | unchanged |
| `src/app/api/onboarding/select-plan/route.ts:169` | `worker/ingress/stripe.ts` | unchanged (stays at ingress/ root) |

**Explicitly NOT updating** (historical, read-only specs): `docs/superpowers/specs/*` files referring to old worker paths. They document past decisions in their then-current form and should not be rewritten.

---

## Vitest / scripts / package.json impact

- **`vitest.config.ts`** — `worker/**/__tests__/**/*.test.{ts,tsx}` is recursive; **no change needed**. ✓
- **`package.json`** — `pnpm worker` runs `tsx worker/index.ts`. `index.ts` stays at root. **No change**. ✓
- **`tsconfig.json`** — `@/*` → `src/*` aliases unaffected. **No change**. ✓

---

## Execution sequence

> **Shell convention:** This repo's primary shell is PowerShell on Windows. Folder creation uses `New-Item -ItemType Directory -Force`. Where bash/POSIX semantics are needed (e.g., a batched `git mv` loop), use the Bash tool explicitly.

1. **Create new folders** — explicit, PowerShell-safe, idempotent (`-Force` makes existing folders no-op):

   ```powershell
   # New source folders
   New-Item -ItemType Directory -Force -Path "worker\config"
   New-Item -ItemType Directory -Force -Path "worker\background"
   New-Item -ItemType Directory -Force -Path "worker\ingress\twilio"
   New-Item -ItemType Directory -Force -Path "worker\ingress\telegram"
   New-Item -ItemType Directory -Force -Path "worker\ingress\zernio"
   New-Item -ItemType Directory -Force -Path "worker\jobs\publisher"
   New-Item -ItemType Directory -Force -Path "worker\jobs\zernio"

   # New __tests__ folders (one per source folder that will hold tests)
   New-Item -ItemType Directory -Force -Path "worker\config\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\background\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\ingress\twilio\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\ingress\telegram\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\ingress\zernio\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\jobs\notification\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\jobs\publisher\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\jobs\zernio\__tests__"
   ```

   Folders that **already exist** and need no creation: `worker\__tests__`, `worker\ingress\__tests__`, `worker\jobs\__tests__`, `worker\jobs\notification`.

2. **`git mv` each file** — driven by an explicit PowerShell move table. 71 entries (the no-op `OnboardingDemoWorker.test.ts` is excluded). The script fails loudly on any missing source or any non-zero `git mv` exit code, so a typo or a stale tree halts execution before half the moves land.

   ```powershell
   $ErrorActionPreference = "Stop"

   $moves = @(
     # Root → config/
     ,@("worker\startup-assert.ts",                                     "worker\config\startup-assert.ts")

     # Ingress test helper rename (Decision 4 exception)
     ,@("worker\ingress\__tests__\helpers.ts",                          "worker\ingress\test-helpers.ts")

     # Ingress sources → twilio/
     ,@("worker\ingress\twilio.ts",                                     "worker\ingress\twilio\twilio.ts")
     ,@("worker\ingress\twilio-intent.ts",                              "worker\ingress\twilio\twilio-intent.ts")
     ,@("worker\ingress\twilio-verify.ts",                              "worker\ingress\twilio\twilio-verify.ts")
     ,@("worker\ingress\twilio-whatsapp.ts",                            "worker\ingress\twilio\twilio-whatsapp.ts")
     ,@("worker\ingress\twilio-whatsapp-inbound.ts",                    "worker\ingress\twilio\twilio-whatsapp-inbound.ts")
     ,@("worker\ingress\twilio-whatsapp-status.ts",                     "worker\ingress\twilio\twilio-whatsapp-status.ts")
     ,@("worker\ingress\whatsapp-shared.ts",                            "worker\ingress\twilio\whatsapp-shared.ts")

     # Ingress sources → telegram/
     ,@("worker\ingress\telegram.ts",                                   "worker\ingress\telegram\telegram.ts")
     ,@("worker\ingress\telegram-callback.ts",                          "worker\ingress\telegram\telegram-callback.ts")
     ,@("worker\ingress\telegram-enrollment.ts",                        "worker\ingress\telegram\telegram-enrollment.ts")
     ,@("worker\ingress\telegram-shared.ts",                            "worker\ingress\telegram\telegram-shared.ts")
     ,@("worker\ingress\telegram-verify.ts",                            "worker\ingress\telegram\telegram-verify.ts")

     # Ingress sources → zernio/
     ,@("worker\ingress\zernio.ts",                                     "worker\ingress\zernio\zernio.ts")
     ,@("worker\ingress\zernio-verify.ts",                              "worker\ingress\zernio\zernio-verify.ts")

     # Ingress tests → provider __tests__/
     ,@("worker\ingress\__tests__\twilio-inbound.test.ts",              "worker\ingress\twilio\__tests__\twilio-inbound.test.ts")
     ,@("worker\ingress\__tests__\twilio-status.test.ts",               "worker\ingress\twilio\__tests__\twilio-status.test.ts")
     ,@("worker\ingress\__tests__\twilio-intent.test.ts",               "worker\ingress\twilio\__tests__\twilio-intent.test.ts")
     ,@("worker\ingress\__tests__\twilio-verify.test.ts",               "worker\ingress\twilio\__tests__\twilio-verify.test.ts")
     ,@("worker\ingress\__tests__\twilio-whatsapp.test.ts",             "worker\ingress\twilio\__tests__\twilio-whatsapp.test.ts")
     ,@("worker\ingress\__tests__\telegram.test.ts",                    "worker\ingress\telegram\__tests__\telegram.test.ts")
     ,@("worker\ingress\__tests__\telegram-verify.test.ts",             "worker\ingress\telegram\__tests__\telegram-verify.test.ts")
     ,@("worker\ingress\__tests__\zernio-verify.test.ts",               "worker\ingress\zernio\__tests__\zernio-verify.test.ts")

     # Cross-cutting tests now correctly placed in ingress/__tests__/
     ,@("worker\__tests__\stripe-activation-enqueue.test.ts",           "worker\ingress\__tests__\stripe-activation-enqueue.test.ts")
     ,@("worker\__tests__\resend-webhook-bounce.test.ts",               "worker\ingress\__tests__\resend-webhook-bounce.test.ts")
     ,@("worker\__tests__\webhook-dedup.test.ts",                       "worker\ingress\__tests__\webhook-dedup.test.ts")

     # Jobs → notification/
     ,@("worker\jobs\NotificationWorker.ts",                            "worker\jobs\notification\NotificationWorker.ts")

     # Jobs → publisher/
     ,@("worker\jobs\ResponsePublisherWorker.ts",                       "worker\jobs\publisher\ResponsePublisherWorker.ts")
     ,@("worker\jobs\publisher-error-handlers.ts",                      "worker\jobs\publisher\publisher-error-handlers.ts")

     # Jobs → zernio/
     ,@("worker\jobs\ZernioBackfillWorker.ts",                          "worker\jobs\zernio\ZernioBackfillWorker.ts")
     ,@("worker\jobs\ZernioReviewIngestWorker.ts",                      "worker\jobs\zernio\ZernioReviewIngestWorker.ts")
     ,@("worker\jobs\zernio-ingest-shared.ts",                          "worker\jobs\zernio\zernio-ingest-shared.ts")

     # Pollers + schedulers → background/
     ,@("worker\jobs\ArchivalPoller.ts",                                "worker\background\ArchivalPoller.ts")
     ,@("worker\jobs\CleanupAbandonedSignupsPoller.ts",                 "worker\background\CleanupAbandonedSignupsPoller.ts")
     ,@("worker\jobs\EmailChannelReconcilePoller.ts",                   "worker\background\EmailChannelReconcilePoller.ts")
     ,@("worker\jobs\EngagementMonitorPoller.ts",                       "worker\background\EngagementMonitorPoller.ts")
     ,@("worker\jobs\MonthlyImpactScheduler.ts",                        "worker\background\MonthlyImpactScheduler.ts")
     ,@("worker\jobs\NotificationFailoverPoller.ts",                    "worker\background\NotificationFailoverPoller.ts")
     ,@("worker\jobs\OnboardingDripScheduler.ts",                       "worker\background\OnboardingDripScheduler.ts")
     ,@("worker\jobs\OutboxPoller.ts",                                  "worker\background\OutboxPoller.ts")
     ,@("worker\jobs\RankingTrackingScheduler.ts",                      "worker\background\RankingTrackingScheduler.ts")
     ,@("worker\jobs\WeeklySummaryScheduler.ts",                        "worker\background\WeeklySummaryScheduler.ts")

     # Tests → config/__tests__/
     ,@("worker\__tests__\startup-assertion.test.ts",                   "worker\config\__tests__\startup-assertion.test.ts")

     # Tests → jobs/__tests__/
     ,@("worker\__tests__\AdminExceptionWorker.test.ts",                "worker\jobs\__tests__\AdminExceptionWorker.test.ts")
     ,@("worker\__tests__\DemoGenerationWorker.test.ts",                "worker\jobs\__tests__\DemoGenerationWorker.test.ts")
     ,@("worker\__tests__\EngagementAlertWorker.test.ts",               "worker\jobs\__tests__\EngagementAlertWorker.test.ts")
     ,@("worker\__tests__\MonthlyImpactWorker.test.ts",                 "worker\jobs\__tests__\MonthlyImpactWorker.test.ts")
     ,@("worker\__tests__\OnboardingDripWorker.test.ts",                "worker\jobs\__tests__\OnboardingDripWorker.test.ts")
     ,@("worker\__tests__\PlaceIdValidationWorker.test.ts",             "worker\jobs\__tests__\PlaceIdValidationWorker.test.ts")
     ,@("worker\__tests__\RankingTrackingWorker.test.ts",               "worker\jobs\__tests__\RankingTrackingWorker.test.ts")
     ,@("worker\__tests__\ResponseGeneratorWorker.test.ts",             "worker\jobs\__tests__\ResponseGeneratorWorker.test.ts")
     ,@("worker\__tests__\WeeklySummaryWorker.test.ts",                 "worker\jobs\__tests__\WeeklySummaryWorker.test.ts")

     # Tests → jobs/notification/__tests__/
     ,@("worker\__tests__\NotificationWorker.test.ts",                  "worker\jobs\notification\__tests__\NotificationWorker.test.ts")
     ,@("worker\__tests__\NotificationWorker-sms.test.ts",              "worker\jobs\notification\__tests__\NotificationWorker-sms.test.ts")
     ,@("worker\__tests__\NotificationWorker-telegram.test.ts",         "worker\jobs\notification\__tests__\NotificationWorker-telegram.test.ts")
     ,@("worker\jobs\__tests__\NotificationWorker.whatsapp.test.ts",    "worker\jobs\notification\__tests__\NotificationWorker.whatsapp.test.ts")
     ,@("worker\__tests__\bounced-skip.test.ts",                        "worker\jobs\notification\__tests__\bounced-skip.test.ts")

     # Tests → jobs/publisher/__tests__/
     ,@("worker\__tests__\ResponsePublisherWorker.test.ts",             "worker\jobs\publisher\__tests__\ResponsePublisherWorker.test.ts")
     ,@("worker\__tests__\publisher-error-handlers.test.ts",            "worker\jobs\publisher\__tests__\publisher-error-handlers.test.ts")

     # Tests → jobs/zernio/__tests__/
     ,@("worker\__tests__\ZernioBackfillWorker.test.ts",                "worker\jobs\zernio\__tests__\ZernioBackfillWorker.test.ts")
     ,@("worker\__tests__\ZernioReviewIngestWorker.test.ts",            "worker\jobs\zernio\__tests__\ZernioReviewIngestWorker.test.ts")
     ,@("worker\__tests__\zernio-ingest-shared.test.ts",                "worker\jobs\zernio\__tests__\zernio-ingest-shared.test.ts")
     ,@("worker\__tests__\zernio-end-to-end.integration.test.ts",       "worker\jobs\zernio\__tests__\zernio-end-to-end.integration.test.ts")

     # Tests → background/__tests__/
     ,@("worker\__tests__\ArchivalPoller.test.ts",                      "worker\background\__tests__\ArchivalPoller.test.ts")
     ,@("worker\jobs\__tests__\CleanupAbandonedSignupsPoller.test.ts",  "worker\background\__tests__\CleanupAbandonedSignupsPoller.test.ts")
     ,@("worker\jobs\__tests__\EmailChannelReconcilePoller.test.ts",    "worker\background\__tests__\EmailChannelReconcilePoller.test.ts")
     ,@("worker\__tests__\EngagementMonitorPoller.test.ts",             "worker\background\__tests__\EngagementMonitorPoller.test.ts")
     ,@("worker\__tests__\NotificationFailoverPoller.test.ts",          "worker\background\__tests__\NotificationFailoverPoller.test.ts")
     ,@("worker\__tests__\OnboardingDripScheduler.test.ts",             "worker\background\__tests__\OnboardingDripScheduler.test.ts")
     ,@("worker\__tests__\RankingTrackingScheduler.test.ts",            "worker\background\__tests__\RankingTrackingScheduler.test.ts")
   )

   if ($moves.Count -ne 71) {
     throw "Move table has $($moves.Count) entries; spec expects exactly 71. Refusing to run."
   }

   $i = 0
   foreach ($pair in $moves) {
     $i++
     $from = $pair[0]
     $to   = $pair[1]
     if (-not (Test-Path $from)) {
       throw "[$i/71] Source missing: $from — aborting before a partial move corrupts the tree"
     }
     if (Test-Path $to) {
       throw "[$i/71] Destination already exists: $to — aborting"
     }
     Write-Host "[$i/71] git mv $from -> $to"
     git mv -- $from $to
     if ($LASTEXITCODE -ne 0) {
       throw "[$i/71] git mv failed (exit $LASTEXITCODE): $from -> $to"
     }
   }

   Write-Host "All 71 moves complete. Run 'git status' to confirm rename detection."
   ```

   The script is idempotent against re-runs only in the sense that a re-run on a partially-moved tree will throw on the first source-missing or destination-exists check — preventing silent half-applied state. To recover from a failed run, `git restore --staged` and `git checkout` the affected paths, then start over.
3. **Edit `worker/index.ts`** — apply A.
4. **Edit moved source files** — apply B (per-file depth math) and C (sibling adjustments).
5. **Edit moved test files** — apply D (static imports + `vi.mock()` + `await import('...')`) per the depth table. Three import surfaces per file.
6. **Edit helper-import sites** (E) — 3 files.
7. **Edit external callers** (F) — 2 files (one is also covered by E).
8. **Update top-of-file path comments** (G) — every moved file with a `// worker/...` header line.
9. **Update doc references** (H) — `docs/directory.md`, two zernio runbooks, `.claude/skills/feature-flags.md`, plus the 2 src/ doc-comment fixes.
10. **Verify** — every gate must pass before commit:
    - `pnpm exec tsc --noEmit` → zero errors.
    - `pnpm test` → identical test count as the pre-refactor baseline (capture baseline `vitest run` summary first).
    - `pnpm lint` → zero errors.
    - **Worker boot smoke test** — proves the `tsx worker/index.ts` entry path resolves all moved modules and Sentry/Fastify/BullMQ wiring still constructs at runtime. Static checks above can pass while the actual entry crashes from a stale dynamic import or top-level side effect.
      ```powershell
      # Run on a non-default port so it can't collide with a dev worker
      $env:PORT = "3099"
      $env:MOCK_EXTERNAL_APIS = "true"   # avoid hitting Stripe/Twilio/Resend at boot
      $proc = Start-Process -PassThru -NoNewWindow pnpm -ArgumentList "worker"
      try {
        # Poll for readiness up to ~15s
        $ok = $false
        for ($i = 0; $i -lt 15; $i++) {
          Start-Sleep -Seconds 1
          try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3099/api/health" -UseBasicParsing -TimeoutSec 1
            if ($resp.StatusCode -eq 200) { $ok = $true; break }
          } catch { }
        }
        if (-not $ok) { throw "Worker did not respond healthy on :3099 within 15s" }
        Write-Host "Worker boot smoke test PASSED"
      } finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        Remove-Item Env:\PORT, Env:\MOCK_EXTERNAL_APIS -ErrorAction SilentlyContinue
      }
      ```
      Acceptance: `/api/health` returns HTTP 200 with `{"status":"ok",...}`. Failure means a moved module isn't resolving — diagnose before commit.
11. **Single commit**: `refactor(worker): reorganize folder layout (no logic changes)`. Body lists the file-move counts and confirms zero behavior delta.

---

## Risks

1. **Railway / Vercel deploy config**: not in repo; manual sanity check after first deploy in case anything hardcodes a worker path.
2. **Sentry source maps**: pre-deploy traces reference old paths; harmless after redeploy.
3. **Branch-rebase risk** (UPDATED): No open GitHub PRs. Of local feature branches, `feat/edit-existing-replies` is the only high-risk one if still needed — it likely touches `worker/` and will need a manual rebase against this refactor. Remaining local branches are either already merged-but-undeleted or stale.
4. **Doc drift**: `docs/directory.md` will need a moderate rewrite of the worker section. Listed as part of step 9 but it's the most opinion-heavy edit in the plan — worth a second look during review.

---

## Approval gate

I will not run any `git mv` or import edit until you reply with explicit approval on this spec. If you want any change to:
- The decisions
- The target tree
- The doc-update scope
- The execution sequence

…flag it now. I'll revise and re-post for review.
