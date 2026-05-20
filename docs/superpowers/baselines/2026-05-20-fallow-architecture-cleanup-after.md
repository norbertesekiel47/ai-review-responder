# Fallow Architecture Cleanup After Report

Captured after implementation of `docs/superpowers/specs/2026-05-20-fallow-architecture-cleanup-design.md`.

Raw JSON was written to `/private/tmp` and is intentionally not committed.

## Verification

- Zernio route/client/publisher tests passed.
- Dashboard route/service tests passed.
- Onboarding/demo tests passed.
- Notification/ingress tests passed.
- Dashboard component checks passed.
- `pnpm build` passed.
- `fallow health --format json --explain` and `fallow health --production --format json --explain` wrote JSON and exited 1 because findings remain.
- `fallow health --targets --format json --explain` and `fallow dupes --production --format json` wrote JSON and exited 0.

## Fallow After Metrics

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Normal health | 68.0 C | 68.1 C | +0.1 |
| Production health | 70.8 B | 70.6 B | -0.2 |
| Normal maintainability | 91.8 | 91.9 | +0.1 |
| Production maintainability | 91.5 | 91.4 | -0.1 |
| Normal duplication | 16.2% | 16.1% | -0.1pp |
| Production duplication | 11.0% | 11.1% | +0.1pp |
| Normal high-priority targets | 26 | 26 | 0 |
| Production high-priority targets | 38 | 39 | +1 |
| Normal critical findings | 71 | 68 | -3 |
| Production critical findings | 196 | 198 | +2 |

## Fallow Scope Note

The global score stayed flat because this cleanup added production helper modules and focused tests while preserving behavior. Fallow now analyzes more files and functions: normal scope moved from 750 files / 8,828 functions to 782 files / 8,935 functions, and production scope moved from 477 files / 2,386 functions to 500 files / 2,420 functions.

New helper exports also register as dead exports until later route slices consume them, especially `src/app/api/zernio/connect/_shared/preflight.ts`.

## Primary Runtime Targets

- `src/lib/dashboard/service.ts`: `getActiveDashboardData` moved from 373 LOC / cognitive 41 to 335 LOC / cognitive 33. It now delegates Zernio banner resolution and active row mapping, but remains above Fallow's complexity target.
- `src/app/api/zernio/connect/select-location/route.ts`: `POST` remains 538 LOC / cognitive 63. This high-risk OAuth/select-location flow was not split in this pass; supporting shared route helpers were introduced first.
- `src/app/api/zernio/connect/callback/route.ts`: `GET` remains 282 LOC / cognitive 81. It is still a deferred high-risk OAuth callback target.
- `worker/jobs/publisher/ResponsePublisherWorker.ts`: `handlePublishResponse` moved from 431 LOC / cognitive 50 to 125 LOC and is no longer listed in Fallow's ranked targets. Publisher failure behavior is now owned by named stage modules.

## Deferred Runtime Targets

- Zernio `select-location` `POST` remains deferred because it is the largest production route and needs a dedicated behavior-preserving child plan with authenticated E2E coverage or an explicit route-test gate.
- Zernio callback `GET` remains deferred because OAuth redirect/cookie behavior is high risk and should be split behind route-level tests.
- `getActiveDashboardData` remains partially deferred because query execution and latest-brief/ranking/value-summary assembly still live in the service.

## Commits

- `fcc56c4` captured the Fallow baseline.
- `9579dd3` extracted Zernio connect preflight parsing.
- `4077e1d` extracted Zernio pending marker parsing.
- `fe667ab` preserved `finalizing` pending markers.
- `32126ea` split Zernio client internals.
- `c44feef` split response publisher stages.
- `4fef170` split dashboard state mapping.
- `bf1d71c` split onboarding payload and demo reservation.
- `b9a49be` covered onboarding demo worker stages.
- `4243eac` split notification planning and Twilio parsing.
- `b247218` applied notification dispatch plan order.
- `ec49216` cleaned the Fallow export surface.
