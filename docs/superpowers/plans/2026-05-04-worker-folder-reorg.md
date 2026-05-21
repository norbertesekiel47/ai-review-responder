# Worker Folder Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the `worker/` directory from a flat layout into a structured tree (`background/`, `config/`, `ingress/<provider>/`, `jobs/<sub>/`) with zero logic changes, preserving all imports, tests, and runtime behavior.

**Architecture:** Mechanical move-only refactor driven by `git mv` plus targeted import-path rewrites. Files are grouped by responsibility (pollers/schedulers → `background/`, provider webhooks → `ingress/{twilio,telegram,zernio}/`, multi-file jobs → `jobs/{notification,publisher,zernio}/`). All relative import depths are recalculated per move pattern; sibling imports inside relocated folders are adjusted; external callers and living docs are updated.

**Tech Stack:** TypeScript, Vitest, BullMQ, PowerShell (Windows), Git

**Worktree requirement:** Execute this plan in a dedicated Git worktree created from the target branch. Do NOT run on `main` directly if other work is in flight.

---

## File Structure

### New folders to create
- `worker/config/` — `startup-assert.ts` + tests
- `worker/background/` — pollers and schedulers + tests
- `worker/ingress/twilio/` — Twilio webhook handlers + tests
- `worker/ingress/telegram/` — Telegram webhook handlers + tests
- `worker/ingress/zernio/` — Zernio webhook handlers + tests
- `worker/jobs/publisher/` — response publisher + tests
- `worker/jobs/zernio/` — Zernio ingestion workers + tests
- `worker/jobs/notification/__tests__/` — notification worker tests (source folder already exists)

### Files staying in place (27 total)
- Root: `worker/env.ts`, `worker/index.ts`, `worker/queues.ts`
- Ingress root: `worker/ingress/shared.ts`, `worker/ingress/stripe.ts`, `worker/ingress/resend.ts`
- Ingress tests: `worker/ingress/__tests__/shared.test.ts`, `worker/ingress/__tests__/stripe.test.ts`
- Jobs root: 12 single-file workers (`AdminExceptionWorker.ts` … `WeeklySummaryWorker.ts`)
- Jobs tests: `worker/jobs/__tests__/OnboardingDemoWorker.test.ts` (already at target path)
- Cross-cutting test: `worker/__tests__/correlation-chain.test.ts`
- Notification source: 5 files already in `worker/jobs/notification/`

### Files moving (71 total)
See the per-task tables below for exact `From → To` mappings.

---

## Baseline Capture

Before touching any file, capture the baseline so we can prove nothing broke.

### Task 0: Capture Baseline

**Files:**
- Read-only: `worker/index.ts`, `vitest.config.ts`, `package.json`

- [ ] **Step 0.1: Verify clean working tree**

Run:
```powershell
git status
```
Expected: `nothing to commit, working tree clean` (or only expected untracked files). If there are uncommitted changes, commit or stash them first.

- [ ] **Step 0.2: Capture test baseline count**

Run:
```powershell
pnpm vitest run --reporter=verbose 2>&1 | Select-String -Pattern "Test Files|Tests\s+\(" | Out-File ..\worker-reorg-baseline.txt; Get-Content ..\worker-reorg-baseline.txt
```
Expected: A line like `Test Files  123 passed (123)` and `Tests  456 passed (456)`. Save the exact numbers.

- [ ] **Step 0.3: Confirm TypeScript compiles**

Run:
```powershell
pnpm exec tsc --noEmit
```
Expected: Exit code 0, zero errors.

- [ ] **Step 0.4: Confirm lint passes**

Run:
```powershell
pnpm lint
```
Expected: Exit code 0, zero errors.

- [ ] **Step 0.5: Commit baseline marker (optional but recommended)**

```bash
git add -A
git commit -m "chore: baseline before worker folder reorg" --allow-empty
```

---

## Task 1: Create New Directories

**Files:**
- Create directories only (no files yet)

- [ ] **Step 1.1: Create all new source and test directories**

Run:
```powershell
New-Item -ItemType Directory -Force -Path "worker\config"
New-Item -ItemType Directory -Force -Path "worker\config\__tests__"
New-Item -ItemType Directory -Force -Path "worker\background"
New-Item -ItemType Directory -Force -Path "worker\background\__tests__"
New-Item -ItemType Directory -Force -Path "worker\ingress\twilio"
New-Item -ItemType Directory -Force -Path "worker\ingress\twilio\__tests__"
New-Item -ItemType Directory -Force -Path "worker\ingress\telegram"
New-Item -ItemType Directory -Force -Path "worker\ingress\telegram\__tests__"
New-Item -ItemType Directory -Force -Path "worker\ingress\zernio"
New-Item -ItemType Directory -Force -Path "worker\ingress\zernio\__tests__"
New-Item -ItemType Directory -Force -Path "worker\jobs\publisher"
New-Item -ItemType Directory -Force -Path "worker\jobs\publisher\__tests__"
New-Item -ItemType Directory -Force -Path "worker\jobs\zernio"
New-Item -ItemType Directory -Force -Path "worker\jobs\zernio\__tests__"
New-Item -ItemType Directory -Force -Path "worker\jobs\notification\__tests__"
```

Expected: All directories created without error (`-Force` makes existing folders a no-op).

---

## Task 2: Move Root → Config

**Files:**
- Move: `worker/startup-assert.ts` → `worker/config/startup-assert.ts`
- Move: `worker/__tests__/startup-assertion.test.ts` → `worker/config/__tests__/startup-assertion.test.ts`

- [ ] **Step 2.1: git mv root config files**

Run:
```powershell
git mv worker\startup-assert.ts worker\config\startup-assert.ts
git mv worker\__tests__\startup-assertion.test.ts worker\config\__tests__\startup-assertion.test.ts
```

Expected: `git status` shows these two as renamed.

---

## Task 3: Move Ingress Test Helper (Rename)

**Files:**
- Move+rename: `worker/ingress/__tests__/helpers.ts` → `worker/ingress/test-helpers.ts`

- [ ] **Step 3.1: git mv and rename helpers.ts**

Run:
```powershell
git mv worker\ingress\__tests__\helpers.ts worker\ingress\test-helpers.ts
```

Expected: `git status` shows `worker/ingress/__tests__/helpers.ts` → `worker/ingress/test-helpers.ts` as renamed.

---

## Task 4: Move Ingress Sources → Twilio/

**Files:**
- Move: `worker/ingress/twilio.ts` → `worker/ingress/twilio/twilio.ts`
- Move: `worker/ingress/twilio-intent.ts` → `worker/ingress/twilio/twilio-intent.ts`
- Move: `worker/ingress/twilio-verify.ts` → `worker/ingress/twilio/twilio-verify.ts`
- Move: `worker/ingress/twilio-whatsapp.ts` → `worker/ingress/twilio/twilio-whatsapp.ts`
- Move: `worker/ingress/twilio-whatsapp-inbound.ts` → `worker/ingress/twilio/twilio-whatsapp-inbound.ts`
- Move: `worker/ingress/twilio-whatsapp-status.ts` → `worker/ingress/twilio/twilio-whatsapp-status.ts`
- Move: `worker/ingress/whatsapp-shared.ts` → `worker/ingress/twilio/whatsapp-shared.ts`

- [ ] **Step 4.1: git mv Twilio source files**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\ingress\twilio.ts",                 "worker\ingress\twilio\twilio.ts")
  ,@("worker\ingress\twilio-intent.ts",          "worker\ingress\twilio\twilio-intent.ts")
  ,@("worker\ingress\twilio-verify.ts",          "worker\ingress\twilio\twilio-verify.ts")
  ,@("worker\ingress\twilio-whatsapp.ts",        "worker\ingress\twilio\twilio-whatsapp.ts")
  ,@("worker\ingress\twilio-whatsapp-inbound.ts","worker\ingress\twilio\twilio-whatsapp-inbound.ts")
  ,@("worker\ingress\twilio-whatsapp-status.ts", "worker\ingress\twilio\twilio-whatsapp-status.ts")
  ,@("worker\ingress\whatsapp-shared.ts",        "worker\ingress\twilio\whatsapp-shared.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 7 renames in `git status`.

---

## Task 5: Move Ingress Sources → Telegram/

**Files:**
- Move: `worker/ingress/telegram.ts` → `worker/ingress/telegram/telegram.ts`
- Move: `worker/ingress/telegram-callback.ts` → `worker/ingress/telegram/telegram-callback.ts`
- Move: `worker/ingress/telegram-enrollment.ts` → `worker/ingress/telegram/telegram-enrollment.ts`
- Move: `worker/ingress/telegram-shared.ts` → `worker/ingress/telegram/telegram-shared.ts`
- Move: `worker/ingress/telegram-verify.ts` → `worker/ingress/telegram/telegram-verify.ts`

- [ ] **Step 5.1: git mv Telegram source files**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\ingress\telegram.ts",           "worker\ingress\telegram\telegram.ts")
  ,@("worker\ingress\telegram-callback.ts",  "worker\ingress\telegram\telegram-callback.ts")
  ,@("worker\ingress\telegram-enrollment.ts","worker\ingress\telegram\telegram-enrollment.ts")
  ,@("worker\ingress\telegram-shared.ts",    "worker\ingress\telegram\telegram-shared.ts")
  ,@("worker\ingress\telegram-verify.ts",    "worker\ingress\telegram\telegram-verify.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 5 renames in `git status`.

---

## Task 6: Move Ingress Sources → Zernio/

**Files:**
- Move: `worker/ingress/zernio.ts` → `worker/ingress/zernio/zernio.ts`
- Move: `worker/ingress/zernio-verify.ts` → `worker/ingress/zernio/zernio-verify.ts`

- [ ] **Step 6.1: git mv Zernio source files**

Run:
```powershell
git mv worker\ingress\zernio.ts worker\ingress\zernio\zernio.ts
git mv worker\ingress\zernio-verify.ts worker\ingress\zernio\zernio-verify.ts
```

Expected: 2 renames in `git status`.

---

## Task 7: Move Ingress Tests → Provider __tests__/

**Files:**
- Move: `worker/ingress/__tests__/twilio-inbound.test.ts` → `worker/ingress/twilio/__tests__/twilio-inbound.test.ts`
- Move: `worker/ingress/__tests__/twilio-status.test.ts` → `worker/ingress/twilio/__tests__/twilio-status.test.ts`
- Move: `worker/ingress/__tests__/twilio-intent.test.ts` → `worker/ingress/twilio/__tests__/twilio-intent.test.ts`
- Move: `worker/ingress/__tests__/twilio-verify.test.ts` → `worker/ingress/twilio/__tests__/twilio-verify.test.ts`
- Move: `worker/ingress/__tests__/twilio-whatsapp.test.ts` → `worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts`
- Move: `worker/ingress/__tests__/telegram.test.ts` → `worker/ingress/telegram/__tests__/telegram.test.ts`
- Move: `worker/ingress/__tests__/telegram-verify.test.ts` → `worker/ingress/telegram/__tests__/telegram-verify.test.ts`
- Move: `worker/ingress/__tests__/zernio-verify.test.ts` → `worker/ingress/zernio/__tests__/zernio-verify.test.ts`

- [ ] **Step 7.1: git mv provider test files**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\ingress\__tests__\twilio-inbound.test.ts",   "worker\ingress\twilio\__tests__\twilio-inbound.test.ts")
  ,@("worker\ingress\__tests__\twilio-status.test.ts",    "worker\ingress\twilio\__tests__\twilio-status.test.ts")
  ,@("worker\ingress\__tests__\twilio-intent.test.ts",    "worker\ingress\twilio\__tests__\twilio-intent.test.ts")
  ,@("worker\ingress\__tests__\twilio-verify.test.ts",    "worker\ingress\twilio\__tests__\twilio-verify.test.ts")
  ,@("worker\ingress\__tests__\twilio-whatsapp.test.ts",  "worker\ingress\twilio\__tests__\twilio-whatsapp.test.ts")
  ,@("worker\ingress\__tests__\telegram.test.ts",         "worker\ingress\telegram\__tests__\telegram.test.ts")
  ,@("worker\ingress\__tests__\telegram-verify.test.ts",  "worker\ingress\telegram\__tests__\telegram-verify.test.ts")
  ,@("worker\ingress\__tests__\zernio-verify.test.ts",    "worker\ingress\zernio\__tests__\zernio-verify.test.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 8 renames in `git status`.

---

## Task 8: Move Cross-Cutting Tests into Ingress/__tests__/

**Files:**
- Move: `worker/__tests__/stripe-activation-enqueue.test.ts` → `worker/ingress/__tests__/stripe-activation-enqueue.test.ts`
- Move: `worker/__tests__/resend-webhook-bounce.test.ts` → `worker/ingress/__tests__/resend-webhook-bounce.test.ts`
- Move: `worker/__tests__/webhook-dedup.test.ts` → `worker/ingress/__tests__/webhook-dedup.test.ts`

- [ ] **Step 8.1: git mv cross-cutting ingress tests**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\__tests__\stripe-activation-enqueue.test.ts", "worker\ingress\__tests__\stripe-activation-enqueue.test.ts")
  ,@("worker\__tests__\resend-webhook-bounce.test.ts",     "worker\ingress\__tests__\resend-webhook-bounce.test.ts")
  ,@("worker\__tests__\webhook-dedup.test.ts",             "worker\ingress\__tests__\webhook-dedup.test.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 3 renames in `git status`.

---

## Task 9: Move Jobs → Notification / Publisher / Zernio

**Files:**
- Move: `worker/jobs/NotificationWorker.ts` → `worker/jobs/notification/NotificationWorker.ts`
- Move: `worker/jobs/ResponsePublisherWorker.ts` → `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Move: `worker/jobs/publisher-error-handlers.ts` → `worker/jobs/publisher/publisher-error-handlers.ts`
- Move: `worker/jobs/ZernioBackfillWorker.ts` → `worker/jobs/zernio/ZernioBackfillWorker.ts`
- Move: `worker/jobs/ZernioReviewIngestWorker.ts` → `worker/jobs/zernio/ZernioReviewIngestWorker.ts`
- Move: `worker/jobs/zernio-ingest-shared.ts` → `worker/jobs/zernio/zernio-ingest-shared.ts`

- [ ] **Step 9.1: git mv job sub-folder files**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\jobs\NotificationWorker.ts",       "worker\jobs\notification\NotificationWorker.ts")
  ,@("worker\jobs\ResponsePublisherWorker.ts",  "worker\jobs\publisher\ResponsePublisherWorker.ts")
  ,@("worker\jobs\publisher-error-handlers.ts", "worker\jobs\publisher\publisher-error-handlers.ts")
  ,@("worker\jobs\ZernioBackfillWorker.ts",     "worker\jobs\zernio\ZernioBackfillWorker.ts")
  ,@("worker\jobs\ZernioReviewIngestWorker.ts", "worker\jobs\zernio\ZernioReviewIngestWorker.ts")
  ,@("worker\jobs\zernio-ingest-shared.ts",     "worker\jobs\zernio\zernio-ingest-shared.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 6 renames in `git status`.

---

## Task 10: Move Pollers + Schedulers → Background/

**Files:**
- Move: `worker/jobs/ArchivalPoller.ts` → `worker/background/ArchivalPoller.ts`
- Move: `worker/jobs/CleanupAbandonedSignupsPoller.ts` → `worker/background/CleanupAbandonedSignupsPoller.ts`
- Move: `worker/jobs/EmailChannelReconcilePoller.ts` → `worker/background/EmailChannelReconcilePoller.ts`
- Move: `worker/jobs/EngagementMonitorPoller.ts` → `worker/background/EngagementMonitorPoller.ts`
- Move: `worker/jobs/MonthlyImpactScheduler.ts` → `worker/background/MonthlyImpactScheduler.ts`
- Move: `worker/jobs/NotificationFailoverPoller.ts` → `worker/background/NotificationFailoverPoller.ts`
- Move: `worker/jobs/OnboardingDripScheduler.ts` → `worker/background/OnboardingDripScheduler.ts`
- Move: `worker/jobs/OutboxPoller.ts` → `worker/background/OutboxPoller.ts`
- Move: `worker/jobs/RankingTrackingScheduler.ts` → `worker/background/RankingTrackingScheduler.ts`
- Move: `worker/jobs/WeeklySummaryScheduler.ts` → `worker/background/WeeklySummaryScheduler.ts`

- [ ] **Step 10.1: git mv background files**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\jobs\ArchivalPoller.ts",                    "worker\background\ArchivalPoller.ts")
  ,@("worker\jobs\CleanupAbandonedSignupsPoller.ts",     "worker\background\CleanupAbandonedSignupsPoller.ts")
  ,@("worker\jobs\EmailChannelReconcilePoller.ts",       "worker\background\EmailChannelReconcilePoller.ts")
  ,@("worker\jobs\EngagementMonitorPoller.ts",           "worker\background\EngagementMonitorPoller.ts")
  ,@("worker\jobs\MonthlyImpactScheduler.ts",            "worker\background\MonthlyImpactScheduler.ts")
  ,@("worker\jobs\NotificationFailoverPoller.ts",        "worker\background\NotificationFailoverPoller.ts")
  ,@("worker\jobs\OnboardingDripScheduler.ts",           "worker\background\OnboardingDripScheduler.ts")
  ,@("worker\jobs\OutboxPoller.ts",                      "worker\background\OutboxPoller.ts")
  ,@("worker\jobs\RankingTrackingScheduler.ts",          "worker\background\RankingTrackingScheduler.ts")
  ,@("worker\jobs\WeeklySummaryScheduler.ts",            "worker\background\WeeklySummaryScheduler.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 10 renames in `git status`.

---

## Task 11: Move Tests → Jobs/__tests__/

**Files:**
- Move: `worker/__tests__/AdminExceptionWorker.test.ts` → `worker/jobs/__tests__/AdminExceptionWorker.test.ts`
- Move: `worker/__tests__/DemoGenerationWorker.test.ts` → `worker/jobs/__tests__/DemoGenerationWorker.test.ts`
- Move: `worker/__tests__/EngagementAlertWorker.test.ts` → `worker/jobs/__tests__/EngagementAlertWorker.test.ts`
- Move: `worker/__tests__/MonthlyImpactWorker.test.ts` → `worker/jobs/__tests__/MonthlyImpactWorker.test.ts`
- Move: `worker/__tests__/OnboardingDripWorker.test.ts` → `worker/jobs/__tests__/OnboardingDripWorker.test.ts`
- Move: `worker/__tests__/PlaceIdValidationWorker.test.ts` → `worker/jobs/__tests__/PlaceIdValidationWorker.test.ts`
- Move: `worker/__tests__/RankingTrackingWorker.test.ts` → `worker/jobs/__tests__/RankingTrackingWorker.test.ts`
- Move: `worker/__tests__/ResponseGeneratorWorker.test.ts` → `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts`
- Move: `worker/__tests__/WeeklySummaryWorker.test.ts` → `worker/jobs/__tests__/WeeklySummaryWorker.test.ts`

- [ ] **Step 11.1: git mv job tests to jobs/__tests__/**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\__tests__\AdminExceptionWorker.test.ts",    "worker\jobs\__tests__\AdminExceptionWorker.test.ts")
  ,@("worker\__tests__\DemoGenerationWorker.test.ts",    "worker\jobs\__tests__\DemoGenerationWorker.test.ts")
  ,@("worker\__tests__\EngagementAlertWorker.test.ts",   "worker\jobs\__tests__\EngagementAlertWorker.test.ts")
  ,@("worker\__tests__\MonthlyImpactWorker.test.ts",     "worker\jobs\__tests__\MonthlyImpactWorker.test.ts")
  ,@("worker\__tests__\OnboardingDripWorker.test.ts",    "worker\jobs\__tests__\OnboardingDripWorker.test.ts")
  ,@("worker\__tests__\PlaceIdValidationWorker.test.ts", "worker\jobs\__tests__\PlaceIdValidationWorker.test.ts")
  ,@("worker\__tests__\RankingTrackingWorker.test.ts",   "worker\jobs\__tests__\RankingTrackingWorker.test.ts")
  ,@("worker\__tests__\ResponseGeneratorWorker.test.ts", "worker\jobs\__tests__\ResponseGeneratorWorker.test.ts")
  ,@("worker\__tests__\WeeklySummaryWorker.test.ts",     "worker\jobs\__tests__\WeeklySummaryWorker.test.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 9 renames in `git status`.

---

## Task 12: Move Tests → Notification / Publisher / Zernio __tests__/

**Files:**
- Move: `worker/__tests__/NotificationWorker.test.ts` → `worker/jobs/notification/__tests__/NotificationWorker.test.ts`
- Move: `worker/__tests__/NotificationWorker-sms.test.ts` → `worker/jobs/notification/__tests__/NotificationWorker-sms.test.ts`
- Move: `worker/__tests__/NotificationWorker-telegram.test.ts` → `worker/jobs/notification/__tests__/NotificationWorker-telegram.test.ts`
- Move: `worker/jobs/__tests__/NotificationWorker.whatsapp.test.ts` → `worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts`
- Move: `worker/__tests__/bounced-skip.test.ts` → `worker/jobs/notification/__tests__/bounced-skip.test.ts`
- Move: `worker/__tests__/ResponsePublisherWorker.test.ts` → `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`
- Move: `worker/__tests__/publisher-error-handlers.test.ts` → `worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts`
- Move: `worker/__tests__/ZernioBackfillWorker.test.ts` → `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`
- Move: `worker/__tests__/ZernioReviewIngestWorker.test.ts` → `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`
- Move: `worker/__tests__/zernio-ingest-shared.test.ts` → `worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts`
- Move: `worker/__tests__/zernio-end-to-end.integration.test.ts` → `worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts`

- [ ] **Step 12.1: git mv notification, publisher, and zernio tests**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\__tests__\NotificationWorker.test.ts",               "worker\jobs\notification\__tests__\NotificationWorker.test.ts")
  ,@("worker\__tests__\NotificationWorker-sms.test.ts",            "worker\jobs\notification\__tests__\NotificationWorker-sms.test.ts")
  ,@("worker\__tests__\NotificationWorker-telegram.test.ts",       "worker\jobs\notification\__tests__\NotificationWorker-telegram.test.ts")
  ,@("worker\jobs\__tests__\NotificationWorker.whatsapp.test.ts",  "worker\jobs\notification\__tests__\NotificationWorker.whatsapp.test.ts")
  ,@("worker\__tests__\bounced-skip.test.ts",                      "worker\jobs\notification\__tests__\bounced-skip.test.ts")
  ,@("worker\__tests__\ResponsePublisherWorker.test.ts",           "worker\jobs\publisher\__tests__\ResponsePublisherWorker.test.ts")
  ,@("worker\__tests__\publisher-error-handlers.test.ts",          "worker\jobs\publisher\__tests__\publisher-error-handlers.test.ts")
  ,@("worker\__tests__\ZernioBackfillWorker.test.ts",              "worker\jobs\zernio\__tests__\ZernioBackfillWorker.test.ts")
  ,@("worker\__tests__\ZernioReviewIngestWorker.test.ts",          "worker\jobs\zernio\__tests__\ZernioReviewIngestWorker.test.ts")
  ,@("worker\__tests__\zernio-ingest-shared.test.ts",              "worker\jobs\zernio\__tests__\zernio-ingest-shared.test.ts")
  ,@("worker\__tests__\zernio-end-to-end.integration.test.ts",     "worker\jobs\zernio\__tests__\zernio-end-to-end.integration.test.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 11 renames in `git status`.

---

## Task 13: Move Tests → Background/__tests__/

**Files:**
- Move: `worker/__tests__/ArchivalPoller.test.ts` → `worker/background/__tests__/ArchivalPoller.test.ts`
- Move: `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts` → `worker/background/__tests__/CleanupAbandonedSignupsPoller.test.ts`
- Move: `worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts` → `worker/background/__tests__/EmailChannelReconcilePoller.test.ts`
- Move: `worker/__tests__/EngagementMonitorPoller.test.ts` → `worker/background/__tests__/EngagementMonitorPoller.test.ts`
- Move: `worker/__tests__/NotificationFailoverPoller.test.ts` → `worker/background/__tests__/NotificationFailoverPoller.test.ts`
- Move: `worker/__tests__/OnboardingDripScheduler.test.ts` → `worker/background/__tests__/OnboardingDripScheduler.test.ts`
- Move: `worker/__tests__/RankingTrackingScheduler.test.ts` → `worker/background/__tests__/RankingTrackingScheduler.test.ts`

- [ ] **Step 13.1: git mv background tests**

Run:
```powershell
$ErrorActionPreference = "Stop"
$moves = @(
  ,@("worker\__tests__\ArchivalPoller.test.ts",                    "worker\background\__tests__\ArchivalPoller.test.ts")
  ,@("worker\jobs\__tests__\CleanupAbandonedSignupsPoller.test.ts", "worker\background\__tests__\CleanupAbandonedSignupsPoller.test.ts")
  ,@("worker\jobs\__tests__\EmailChannelReconcilePoller.test.ts",   "worker\background\__tests__\EmailChannelReconcilePoller.test.ts")
  ,@("worker\__tests__\EngagementMonitorPoller.test.ts",            "worker\background\__tests__\EngagementMonitorPoller.test.ts")
  ,@("worker\__tests__\NotificationFailoverPoller.test.ts",         "worker\background\__tests__\NotificationFailoverPoller.test.ts")
  ,@("worker\__tests__\OnboardingDripScheduler.test.ts",            "worker\background\__tests__\OnboardingDripScheduler.test.ts")
  ,@("worker\__tests__\RankingTrackingScheduler.test.ts",           "worker\background\__tests__\RankingTrackingScheduler.test.ts")
)
foreach ($pair in $moves) {
  if (-not (Test-Path $pair[0])) { throw "Missing: $($pair[0])" }
  if (Test-Path $pair[1]) { throw "Already exists: $($pair[1])" }
  git mv -- $pair[0] $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "git mv failed: $($pair[0])" }
}
```

Expected: 7 renames in `git status`.

- [ ] **Step 13.2: Verify all 71 moves are staged**

Run:
```powershell
git status --short | Measure-Object
```
Expected: Exactly 71 rename lines (`R  old → new`). If the count is off, stop and diagnose.

---

## Task 14: Edit worker/index.ts

**Files:**
- Modify: `worker/index.ts`

This file has ~30 static imports of moved files plus one re-export that must be updated.

- [ ] **Step 14.1: Rewrite the re-export of startup-assert**

Find the line:
```typescript
export { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv } from './startup-assert';
```
Replace with:
```typescript
export { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv } from './config/startup-assert';
```

- [ ] **Step 14.2: Rewrite static imports of moved files**

In `worker/index.ts`, perform the following exact replacements (order does not matter, but be precise with quotes):

| Old import string | New import string |
|---|---|
| `'./startup-assert'` | `'./config/startup-assert'` |
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

Leave `'./queues'`, `'./ingress/resend'`, `'./ingress/stripe'`, and all `src/` imports unchanged.

- [ ] **Step 14.3: Verify index.ts compiles**

Run:
```powershell
pnpm exec tsc --noEmit
```
Expected: Zero errors. If any `Cannot find module` errors appear, the corresponding import in Step 14.2 was missed or mistyped.

---

## Task 15: Edit Moved Source Files — Depth + Sibling Imports

**Files:**
- Modify all moved source files (not tests) that have relative `src/` imports or sibling imports that broke during the move.

Apply these exact edits using the Edit tool on each file's new path.

### 15a. Ingress provider sources (depth `../../src/` → `../../../src/`)

All 14 files in `worker/ingress/{twilio,telegram,zernio}/` that contain `'../../src/'` must become `'../../../src/'`.

- [ ] **Step 15.1: Edit `worker/ingress/twilio/twilio.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere in the file.
Also replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.2: Edit `worker/ingress/twilio/twilio-whatsapp.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Sibling barrel re-exports stay unchanged.
Also replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.3: Edit `worker/ingress/twilio/twilio-whatsapp-inbound.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.4: Edit `worker/ingress/twilio/twilio-whatsapp-status.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.5: Edit `worker/ingress/telegram/telegram.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.6: Edit `worker/ingress/telegram/telegram-callback.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.7: Edit `worker/ingress/telegram/telegram-enrollment.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace `'./shared'` with `'../shared'`.

- [ ] **Step 15.8: Edit `worker/ingress/zernio/zernio.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace `'./shared'` with `'../shared'`.

### 15b. Jobs sub-folder sources (depth `../../src/` → `../../../src/`)

- [ ] **Step 15.9: Edit `worker/jobs/notification/NotificationWorker.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
Replace sibling imports:
- `'./notification/eligibility'` → `'./eligibility'`
- `'./notification/dispatch'` → `'./dispatch'`
- `'./notification/context'` → `'./context'`

- [ ] **Step 15.10: Edit `worker/jobs/publisher/ResponsePublisherWorker.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
`'./publisher-error-handlers'` stays unchanged (still sibling).

- [ ] **Step 15.11: Edit `worker/jobs/zernio/ZernioBackfillWorker.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
`'./zernio-ingest-shared'` stays unchanged.

- [ ] **Step 15.12: Edit `worker/jobs/zernio/ZernioReviewIngestWorker.ts`**

Replace `'../../src/'` with `'../../../src/'` everywhere.
`'./zernio-ingest-shared'` stays unchanged.

### 15c. Background sources (depth unchanged — `../../src/` stays)

- [ ] **Step 15.13: Edit `worker/background/OutboxPoller.ts`**

Replace `'./queues'` with `'../queues'` if it exists. Otherwise leave as-is.
`'../../src/'` stays unchanged.

All other `worker/background/*.ts` files keep `'../../src/'` as-is (same depth as before). No edits needed for depth, but verify none reference `'./jobs/...'` or similar stale sibling paths.

- [ ] **Step 15.14: Verify all source edits compile**

Run:
```powershell
pnpm exec tsc --noEmit
```
Expected: Zero errors.

---

## Task 16: Edit Moved Test Files — Static, vi.mock, and Dynamic Imports

**Files:**
- Modify all moved test files with relative `src/`, sibling, or dynamic imports.

The rule: for every test file, update **all three** import surfaces (static `import`, `vi.mock(...)`, `await import(...)`).

### 16a. Tests moving from `worker/__tests__/` → `worker/jobs/__tests__/` (depth `../../src/` → `../../../src/`)

These 9 files: `AdminExceptionWorker.test.ts`, `DemoGenerationWorker.test.ts`, `EngagementAlertWorker.test.ts`, `MonthlyImpactWorker.test.ts`, `OnboardingDripWorker.test.ts`, `PlaceIdValidationWorker.test.ts`, `RankingTrackingWorker.test.ts`, `ResponseGeneratorWorker.test.ts`, `WeeklySummaryWorker.test.ts`.

- [ ] **Step 16.1: Batch depth-shift for jobs/__tests__ files**

In each of the 9 files under `worker/jobs/__tests__/`, replace `'../../src/'` with `'../../../src/'`.
Also replace dynamic imports like `await import('../jobs/SomeWorker')` with `await import('../SomeWorker')`.

Because these files moved from `worker/__tests__/` (depth 2) to `worker/jobs/__tests__/` (depth 3), the relative path to a sibling worker changes from `../jobs/X` to `../X`.

### 16b. Tests moving from `worker/__tests__/` → `worker/background/__tests__/` (depth `../../src/` → `../../../src/`)

These 5 files: `ArchivalPoller.test.ts`, `EngagementMonitorPoller.test.ts`, `NotificationFailoverPoller.test.ts`, `OnboardingDripScheduler.test.ts`, `RankingTrackingScheduler.test.ts`.

- [ ] **Step 16.2: Batch depth-shift for background/__tests__ files**

In each file under `worker/background/__tests__/`, replace `'../../src/'` with `'../../../src/'`.
Replace dynamic imports:
- `await import('../jobs/EngagementMonitorPoller')` → `await import('../EngagementMonitorPoller')`
- `await import('../jobs/OnboardingDripScheduler')` → `await import('../OnboardingDripScheduler')`
- `await import('../jobs/NotificationFailoverPoller')` → `await import('../NotificationFailoverPoller')`
- `await import('../jobs/RankingTrackingScheduler')` → `await import('../RankingTrackingScheduler')`
- `await import('../jobs/ArchivalPoller')` → `await import('../ArchivalPoller')`

### 16c. Tests moving from `worker/jobs/__tests__/` → `worker/background/__tests__/` (depth unchanged)

These 2 files: `CleanupAbandonedSignupsPoller.test.ts`, `EmailChannelReconcilePoller.test.ts`.

- [ ] **Step 16.3: Adjust dynamic imports for background poller tests**

In `worker/background/__tests__/CleanupAbandonedSignupsPoller.test.ts` and `worker/background/__tests__/EmailChannelReconcilePoller.test.ts`:
Replace `await import('../jobs/CleanupAbandonedSignupsPoller')` with `await import('../CleanupAbandonedSignupsPoller')`.
Replace `await import('../jobs/EmailChannelReconcilePoller')` with `await import('../EmailChannelReconcilePoller')`.
`'../../src/'` stays unchanged (already correct at depth 3).

### 16d. Tests moving from `worker/__tests__/` → `worker/jobs/notification/__tests__/` (depth `../../src/` → `../../../../src/`)

These 5 files: `NotificationWorker.test.ts`, `NotificationWorker-sms.test.ts`, `NotificationWorker-telegram.test.ts`, `bounced-skip.test.ts`, plus `NotificationWorker.whatsapp.test.ts` from `worker/jobs/__tests__/`.

- [ ] **Step 16.4: Batch depth-shift for notification tests**

In each file under `worker/jobs/notification/__tests__/`:
Replace `'../../src/'` with `'../../../../src/'`.
Replace dynamic imports:
- `await import('../jobs/NotificationWorker')` → `await import('../NotificationWorker')`
- `await import('../jobs/WeeklySummaryWorker')` → `await import('../../WeeklySummaryWorker')`
- `await import('../jobs/MonthlyImpactWorker')` → `await import('../../MonthlyImpactWorker')`
- `await import('../jobs/OnboardingDripWorker')` → `await import('../../OnboardingDripWorker')`

### 16e. Tests moving from `worker/__tests__/` → `worker/jobs/publisher/__tests__/` (depth `../../src/` → `../../../../src/`)

These 2 files: `ResponsePublisherWorker.test.ts`, `publisher-error-handlers.test.ts`.

- [ ] **Step 16.5: Batch depth-shift for publisher tests**

In each file under `worker/jobs/publisher/__tests__/`:
Replace `'../../src/'` with `'../../../../src/'`.
Replace dynamic imports:
- `await import('../jobs/ResponsePublisherWorker')` → `await import('../ResponsePublisherWorker')`
- `await import('../jobs/publisher-error-handlers')` → `await import('../publisher-error-handlers')`

### 16f. Tests moving from `worker/__tests__/` → `worker/jobs/zernio/__tests__/` (depth `../../src/` → `../../../../src/`)

These 4 files: `ZernioBackfillWorker.test.ts`, `ZernioReviewIngestWorker.test.ts`, `zernio-ingest-shared.test.ts`, `zernio-end-to-end.integration.test.ts`.

- [ ] **Step 16.6: Batch depth-shift for zernio tests**

In each file under `worker/jobs/zernio/__tests__/`:
Replace `'../../src/'` with `'../../../../src/'`.
Replace `vi.mock('../jobs/zernio-ingest-shared')` with `vi.mock('../zernio-ingest-shared')`.
Replace dynamic imports:
- `await import('../jobs/ZernioBackfillWorker')` → `await import('../ZernioBackfillWorker')`
- `await import('../jobs/ZernioReviewIngestWorker')` → `await import('../ZernioReviewIngestWorker')`

### 16g. Tests moving from `worker/ingress/__tests__/` → `worker/ingress/twilio/__tests__/` (depth `../../../src/` → `../../../../src/`)

These 5 files: `twilio-inbound.test.ts`, `twilio-status.test.ts`, `twilio-intent.test.ts`, `twilio-verify.test.ts`, `twilio-whatsapp.test.ts`.

- [ ] **Step 16.7: Batch depth-shift for twilio tests**

In each file under `worker/ingress/twilio/__tests__/`:
Replace `'../../../src/'` with `'../../../../src/'`.
Replace helper import:
- `'./helpers'` → `'../../test-helpers'`
Replace `vi.mock` paths:
- `vi.mock('../shared')` → `vi.mock('../../shared')`
- `vi.mock('../twilio-verify')` stays unchanged (still sibling under twilio/)

### 16h. Tests moving from `worker/ingress/__tests__/` → `worker/ingress/telegram/__tests__/` (depth `../../../src/` → `../../../../src/`)

These 2 files: `telegram.test.ts`, `telegram-verify.test.ts`.

- [ ] **Step 16.8: Batch depth-shift for telegram tests**

In each file under `worker/ingress/telegram/__tests__/`:
Replace `'../../../src/'` with `'../../../../src/'`.
Replace `vi.mock` paths:
- `vi.mock('../shared')` → `vi.mock('../../shared')`
- `vi.mock('../telegram-verify')` stays unchanged.

### 16i. Tests moving from `worker/ingress/__tests__/` → `worker/ingress/zernio/__tests__/` (depth `../../../src/` → `../../../../src/`)

This 1 file: `zernio-verify.test.ts`.

- [ ] **Step 16.9: Depth-shift for zernio verify test**

In `worker/ingress/zernio/__tests__/zernio-verify.test.ts`:
Replace `'../../../src/'` with `'../../../../src/'`.

### 16j. Cross-cutting tests now in `worker/ingress/__tests__/` (depth `../../src/` → `../../../src/`)

These 3 files: `stripe-activation-enqueue.test.ts`, `resend-webhook-bounce.test.ts`, `webhook-dedup.test.ts`.

- [ ] **Step 16.10: Batch depth-shift for ingress cross-cutting tests**

In each file under `worker/ingress/__tests__/`:
Replace `'../../src/'` with `'../../../src/'`.
Replace dynamic imports:
- `await import('../ingress/stripe')` → `await import('../stripe')`
- `await import('../ingress/resend')` → `await import('../resend')`

### 16k. Config test (depth `../../src/` → `../../../src/`)

- [ ] **Step 16.11: Depth-shift for config test**

In `worker/config/__tests__/startup-assertion.test.ts`:
Replace `'../../src/'` with `'../../../src/'`.

- [ ] **Step 16.12: Verify all test edits compile**

Run:
```powershell
pnpm exec tsc --noEmit
```
Expected: Zero errors.

---

## Task 17: Edit Helper Imports and External Callers

**Files:**
- Modify: `src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts`
- Modify: `scripts/zernio-backfill-external-replies.ts`

- [ ] **Step 17.1: Update reenable-e2e.test.ts helper import**

In `src/app/api/admin/channels/sms/__tests__/reenable-e2e.test.ts`:
Find the import from `'.../worker/ingress/__tests__/helpers'` (exact relative prefix will vary; search for `worker/ingress/__tests__/helpers`).
Replace with `worker/ingress/test-helpers` (preserve the leading relative `../` segments, only change the suffix).

For example, if the line is:
```typescript
import { someHelper } from '../../../../../worker/ingress/__tests__/helpers';
```
Change to:
```typescript
import { someHelper } from '../../../../../worker/ingress/test-helpers';
```

- [ ] **Step 17.2: Update reenable-e2e.test.ts twilio import**

In the same file, find the import from `worker/ingress/twilio` and change it to `worker/ingress/twilio/twilio`.

For example:
```typescript
import { handleTwilio } from '../../../../../worker/ingress/twilio';
```
Change to:
```typescript
import { handleTwilio } from '../../../../../worker/ingress/twilio/twilio';
```

- [ ] **Step 17.3: Update zernio-backfill-external-replies.ts import**

In `scripts/zernio-backfill-external-replies.ts`:
Find the import from `'../worker/jobs/zernio-ingest-shared'`.
Replace with:
```typescript
import { ... } from '../worker/jobs/zernio/zernio-ingest-shared';
```

- [ ] **Step 17.4: Verify external callers compile**

Run:
```powershell
pnpm exec tsc --noEmit
```
Expected: Zero errors.

---

## Task 18: Update Top-of-File Path Comments

**Files:**
- Modify every moved file that starts with a `// worker/...` path comment.

- [ ] **Step 18.1: Update path comments in moved files**

For each moved file listed below, if the first non-blank line is a comment like `// worker/ingress/twilio.ts`, update it to the new path.

| File (new path) | Old comment | New comment |
|---|---|---|
| `worker/config/startup-assert.ts` | `// worker/startup-assert.ts` | `// worker/config/startup-assert.ts` |
| `worker/ingress/twilio/twilio.ts` | `// worker/ingress/twilio.ts` | `// worker/ingress/twilio/twilio.ts` |
| `worker/ingress/twilio/twilio-whatsapp.ts` | `// worker/ingress/twilio-whatsapp.ts` | `// worker/ingress/twilio/twilio-whatsapp.ts` |
| `worker/ingress/twilio/twilio-whatsapp-inbound.ts` | `// worker/ingress/twilio-whatsapp-inbound.ts` | `// worker/ingress/twilio/twilio-whatsapp-inbound.ts` |
| `worker/ingress/twilio/twilio-whatsapp-status.ts` | `// worker/ingress/twilio-whatsapp-status.ts` | `// worker/ingress/twilio/twilio-whatsapp-status.ts` |
| `worker/ingress/twilio/whatsapp-shared.ts` | `// worker/ingress/whatsapp-shared.ts` | `// worker/ingress/twilio/whatsapp-shared.ts` |
| `worker/ingress/telegram/telegram.ts` | `// worker/ingress/telegram.ts` | `// worker/ingress/telegram/telegram.ts` |
| `worker/ingress/telegram/telegram-callback.ts` | `// worker/ingress/telegram-callback.ts` | `// worker/ingress/telegram/telegram-callback.ts` |
| `worker/ingress/telegram/telegram-enrollment.ts` | `// worker/ingress/telegram-enrollment.ts` | `// worker/ingress/telegram/telegram-enrollment.ts` |
| `worker/ingress/telegram/telegram-shared.ts` | `// worker/ingress/telegram-shared.ts` | `// worker/ingress/telegram/telegram-shared.ts` |
| `worker/ingress/telegram/telegram-verify.ts` | `// worker/ingress/telegram-verify.ts` | `// worker/ingress/telegram/telegram-verify.ts` |
| `worker/ingress/zernio/zernio.ts` | `// worker/ingress/zernio.ts` | `// worker/ingress/zernio/zernio.ts` |
| `worker/ingress/zernio/zernio-verify.ts` | `// worker/ingress/zernio-verify.ts` | `// worker/ingress/zernio/zernio-verify.ts` |

Files without path comments (common for tests and some workers) are skipped.

---

## Task 19: Update Living Documentation

**Files:**
- Modify: `docs/directory.md`
- Modify: `docs/runbooks/zernio-launch-runbook.md`
- Modify: `docs/runbooks/zernio-ingestion-test-runbook.md`
- Modify: `.claude/skills/feature-flags.md`
- Modify: `src/lib/notifications/channels/whatsapp-channel.ts`

- [ ] **Step 19.1: Update docs/directory.md**

Make these exact edits:

1. Find `### worker/startup-assert.ts` and change to `### worker/config/startup-assert.ts`.
2. Find `### worker/jobs/ — BullMQ Job Handlers` section. Restructure it to:
   - `### worker/jobs/ — BullMQ Job Handlers` (single-file workers stay here)
   - Add `### worker/background/ — Background Loops (Pollers & Schedulers)` immediately after, listing all 10 moved poller/scheduler files.
3. In the `#### worker/jobs/notification/` subsection, add `NotificationWorker.ts` to its file list.
4. Find `#### worker/jobs/ — shared utility modules (not handlers)`. Move the `publisher-error-handlers.ts` reference into a new `#### worker/jobs/publisher/` subsection and `zernio-ingest-shared.ts` into `#### worker/jobs/zernio/`.
5. Find `### worker/ingress/ — Inbound Webhook Handlers`. Restructure to show provider subfolders: `twilio/`, `telegram/`, `zernio/` under `ingress/`.
6. Find any stale path `worker/jobs/zernio-ingest-shared.ts` and change to `worker/jobs/zernio/zernio-ingest-shared.ts`.

- [ ] **Step 19.2: Update docs/runbooks/zernio-launch-runbook.md**

Replace:
- `worker/ingress/zernio.ts` → `worker/ingress/zernio/zernio.ts`
- `worker/ingress/zernio-verify.ts` → `worker/ingress/zernio/zernio-verify.ts`
- `worker/jobs/ResponsePublisherWorker.ts` → `worker/jobs/publisher/ResponsePublisherWorker.ts`

- [ ] **Step 19.3: Update docs/runbooks/zernio-ingestion-test-runbook.md**

Replace:
- `worker/ingress/zernio.ts` → `worker/ingress/zernio/zernio.ts`
- `worker/jobs/publisher-error-handlers.ts` → `worker/jobs/publisher/publisher-error-handlers.ts`

- [ ] **Step 19.4: Update .claude/skills/feature-flags.md**

Replace:
- `worker/ingress/zernio` → `worker/ingress/zernio/zernio`
- `worker/ingress/zernio-verify.ts` → `worker/ingress/zernio/zernio-verify.ts`

- [ ] **Step 19.5: Update src/lib/notifications/channels/whatsapp-channel.ts**

Replace:
- `worker/jobs/NotificationWorker.ts` → `worker/jobs/notification/NotificationWorker.ts`

---

## Task 20: Final Verification

**Files:**
- Read-only: entire `worker/` tree

- [ ] **Step 20.1: TypeScript compile check**

Run:
```powershell
pnpm exec tsc --noEmit
```
Expected: Exit code 0, zero errors.

- [ ] **Step 20.2: Run full test suite**

Run:
```powershell
pnpm vitest run
```
Expected: Test file count and total test count match the baseline captured in Task 0 exactly. Any drop means a test file was lost or a `vi.mock()` path is broken.

- [ ] **Step 20.3: Lint check**

Run:
```powershell
pnpm lint
```
Expected: Exit code 0, zero errors.

- [ ] **Step 20.4: Worker boot smoke test**

Run:
```powershell
$env:PORT = "3099"
$env:MOCK_EXTERNAL_APIS = "true"
$proc = Start-Process -PassThru -NoNewWindow pnpm -ArgumentList "worker"
try {
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

Expected: `Worker boot smoke test PASSED`. The health endpoint must return HTTP 200.

---

## Task 21: Commit

**Files:**
- All staged changes

- [ ] **Step 21.1: Stage all changes and commit**

Run:
```powershell
git add -A
git status --short | Measure-Object
```
Expected: ~71 rename lines plus modified lines for `worker/index.ts`, external callers, docs, and path comments. Total should be roughly 90–110 lines.

Run:
```bash
git commit -m "refactor(worker): reorganize folder layout (no logic changes)

- Move 71 files into background/, config/, ingress/{twilio,telegram,zernio}/,
  jobs/{notification,publisher,zernio}/
- Rename worker/ingress/__tests__/helpers.ts -> worker/ingress/test-helpers.ts
- Update all relative imports, re-exports, vi.mock paths, dynamic imports
- Update living docs: docs/directory.md, zernio runbooks, feature-flags.md
- Zero behavior change; all tests, tsc, lint, and smoke test pass"
```

Expected: Commit succeeds. SHA printed.

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] All 71 file moves from the spec are covered in Tasks 2–13.
- [x] `worker/index.ts` import + re-export edits are covered in Task 14.
- [x] Moved source file depth + sibling edits are covered in Task 15.
- [x] Test file static / `vi.mock` / `await import` edits are covered in Task 16.
- [x] Helper import rename (`helpers.ts` → `test-helpers.ts`) is covered in Tasks 3 and 17.
- [x] External callers are covered in Task 17.
- [x] Top-of-file path comments are covered in Task 18.
- [x] Living doc updates are covered in Task 19.
- [x] Verification (tsc, tests, lint, smoke test) is covered in Task 20.
- [x] Commit message is provided in Task 21.

**2. Placeholder scan:**
- [x] No "TBD", "TODO", "implement later", "fill in details".
- [x] No vague "add error handling" or "handle edge cases".
- [x] Every edit step shows the exact strings to find and replace.
- [x] No "Similar to Task N" shortcuts.

**3. Type consistency:**
- [x] File paths are consistent with the target tree in the spec.
- [x] Import depth math matches the spec's corrected table.
- [x] `worker/queues.ts` is correctly left untouched everywhere.
- [x] `OnboardingDemoWorker.test.ts` is correctly excluded from moves (already at target path).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-worker-folder-reorg.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
