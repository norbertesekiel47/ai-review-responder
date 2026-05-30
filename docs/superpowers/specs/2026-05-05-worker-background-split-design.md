# Worker `background/` split — design

**Date:** 2026-05-05
**Author:** Norbert + Claude
**Scope:** Split `worker/background/` into `worker/background/pollers/` and `worker/background/schedulers/`. Mechanical move only — zero logic changes.

---

## Why

`worker/background/` currently holds 10 files of two distinct kinds:

- **Pollers** — react to Postgres state (outbox rows, stale deliveries, expired records, abandoned signups, engagement state)
- **Schedulers** — fire on time-based cadences (weekly summaries, monthly impact, drip emails, ranking checks)

User is adding more in both categories soon. Keeping them in one folder will become noisy. The `*Poller`/`*Scheduler` filename suffix already disambiguates, but with growth a folder split provides better navigation and clearer invariants.

---

## Target tree

```
worker/background/
├── pollers/
│   ├── ArchivalPoller.ts
│   ├── CleanupAbandonedSignupsPoller.ts
│   ├── EmailChannelReconcilePoller.ts
│   ├── EngagementMonitorPoller.ts
│   ├── NotificationFailoverPoller.ts
│   ├── OutboxPoller.ts
│   └── __tests__/
│       ├── ArchivalPoller.test.ts
│       ├── CleanupAbandonedSignupsPoller.test.ts
│       ├── EmailChannelReconcilePoller.test.ts
│       ├── EngagementMonitorPoller.test.ts
│       └── NotificationFailoverPoller.test.ts
└── schedulers/
    ├── MonthlyImpactScheduler.ts
    ├── OnboardingDripScheduler.ts
    ├── RankingTrackingScheduler.ts
    ├── WeeklySummaryScheduler.ts
    └── __tests__/
        ├── OnboardingDripScheduler.test.ts
        └── RankingTrackingScheduler.test.ts
```

**No barrel/index files.** Explicit imports in `worker/index.ts` keep runtime registration obvious.

---

## File counts (verified against `ls worker/background/`)

- 10 source files moving (6 pollers + 4 schedulers)
- 7 test files moving (5 poller tests + 2 scheduler tests)
- **Total: 17 moves**

Files without tests today: `OutboxPoller`, `MonthlyImpactScheduler`, `WeeklySummaryScheduler` (covered by integration tests elsewhere or untested).

---

## Path-depth math

| Move | From depth | To depth | `'../src/...'` becomes |
|---|---|---|---|
| Source `worker/background/X.ts` → `worker/background/<sub>/X.ts` | 2 | 3 | `'../../src/...'` → `'../../../src/...'` |
| Test `worker/background/__tests__/X.test.ts` → `worker/background/<sub>/__tests__/X.test.ts` | 3 | 4 | `'../../../src/...'` → `'../../../../src/...'` |
| `OutboxPoller.ts`'s `'../queues'` reaching `worker/queues.ts` | 2 | 3 | `'../queues'` → `'../../queues'` |

Test dynamic imports like `await import('../OnboardingDripScheduler')` stay correct because the test moves with its source.

`@/...`-aliased imports are stable; no edits needed.

---

## Execution sequence

> **Shell:** PowerShell on Windows. Folder creation uses `New-Item -Force`. Batched `git mv` via PowerShell with explicit pre-checks and abort-on-error.

1. **Create folders:**
   ```powershell
   New-Item -ItemType Directory -Force -Path "worker\background\pollers"
   New-Item -ItemType Directory -Force -Path "worker\background\pollers\__tests__"
   New-Item -ItemType Directory -Force -Path "worker\background\schedulers"
   New-Item -ItemType Directory -Force -Path "worker\background\schedulers\__tests__"
   ```

2. **`git mv` 17 files** via PowerShell move table with `$ErrorActionPreference = "Stop"`, count assertion (`$moves.Count -ne 17 → throw`), `Test-Path` pre-checks on both source and destination, and `$LASTEXITCODE` check after every `git mv`.

3. **Edit `worker/index.ts`** — 10 import-path rewrites:
   - `'./background/OutboxPoller'` → `'./background/pollers/OutboxPoller'`
   - `'./background/NotificationFailoverPoller'` → `'./background/pollers/NotificationFailoverPoller'`
   - `'./background/ArchivalPoller'` → `'./background/pollers/ArchivalPoller'`
   - `'./background/EngagementMonitorPoller'` → `'./background/pollers/EngagementMonitorPoller'`
   - `'./background/CleanupAbandonedSignupsPoller'` → `'./background/pollers/CleanupAbandonedSignupsPoller'`
   - `'./background/EmailChannelReconcilePoller'` → `'./background/pollers/EmailChannelReconcilePoller'`
   - `'./background/WeeklySummaryScheduler'` → `'./background/schedulers/WeeklySummaryScheduler'`
   - `'./background/MonthlyImpactScheduler'` → `'./background/schedulers/MonthlyImpactScheduler'`
   - `'./background/RankingTrackingScheduler'` → `'./background/schedulers/RankingTrackingScheduler'`
   - `'./background/OnboardingDripScheduler'` → `'./background/schedulers/OnboardingDripScheduler'`

4. **Edit moved source files** — 10 files: every `'../../src/...'` → `'../../../src/...'`. Plus `OutboxPoller.ts`'s `'../queues'` → `'../../queues'`.

5. **Edit moved test files** — 7 files: every relative `'../../../src/...'` (in static imports AND `vi.mock()` calls) → `'../../../../src/...'`. Verify dynamic `await import('../X')` paths stay correct (they should, since test+source move together).

6. **Update top-of-file path-comment headers** — every moved source file's `// worker/background/X.ts` header → `// worker/background/<sub>/X.ts`.

7. **Update living docs:**
   - `docs/directory.md` — add subsections for `pollers/` and `schedulers/` inside background/
   - `docs/runbooks/deployment-guide.md:607` — `worker/background/OnboardingDripScheduler.ts` → `worker/background/schedulers/OnboardingDripScheduler.ts`

8. **Verify — every gate must pass before commit:**
   - `pnpm exec tsc --noEmit` → zero errors.
   - `pnpm exec vitest run worker/background` → all background tests pass with same count as baseline.
   - `pnpm test` → full suite passes.
   - `pnpm lint` → zero errors.
   - `pnpm build` → succeeds.
   - **Worker boot smoke test:**
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
     } finally {
       if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
     }
     ```

9. **Single commit:** `refactor(worker): split background/ into pollers/ and schedulers/`

---

## Out of scope

- ❌ Splitting `worker/index.ts` or any other logic refactor
- ❌ Touching `package.json`, `vitest.config.ts`, `tsconfig.json`
- ❌ Migration SQL, historical specs, gitignored runbooks
- ❌ Adding barrel/index files
