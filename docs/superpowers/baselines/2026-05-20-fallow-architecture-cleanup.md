# Fallow Architecture Cleanup Baseline

Captured before implementation of `docs/superpowers/specs/2026-05-20-fallow-architecture-cleanup-design.md`.

Raw JSON was written to `/private/tmp` and is intentionally not committed.

## Baseline Metrics

- Normal health: 68.0 C
- Production health: 70.8 B
- Normal maintainability: 91.8
- Production maintainability: 91.5
- Normal duplication: 16.2%
- Production duplication: 11.0%
- Normal high-priority targets: 26
- Production high-priority targets: 38

## Primary Runtime Targets

- `src/lib/dashboard/service.ts`: `getActiveDashboardData`
- `src/app/api/zernio/connect/select-location/route.ts`: `POST`
- `src/app/api/zernio/connect/callback/route.ts`: `GET`
- `worker/jobs/publisher/ResponsePublisherWorker.ts`: `handlePublishResponse`
