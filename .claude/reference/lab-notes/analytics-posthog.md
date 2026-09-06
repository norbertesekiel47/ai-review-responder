# Lab notes — Analytics / PostHog

## Summary

- **Analytics / PostHog** — unconfigured no-op retry budget, durable vs intent events, RLS on new tables

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-05.md § "Best-effort telemetry runs AFTER tx commit — return a candidate, don't capture inside the tx"
- history/2026-05.md § "`shutdownAnalytics()` must be flushed on worker shutdown — and guarded so it can't skip DB teardown"
- history/2026-05.md § "Unconfigured PostHog must not burn an analytics row's retry budget"
- history/2026-05.md § "Every public table needs RLS — a new table without it is anon-readable"
- history/2026-05.md § "Durable analytics facts are server-emitted; only intent events are client-postable"
- history/2026-08-01-to-07.md § "[2026-08-01] Registering an analytics event name only in `ANALYTICS_EVENT_NAMES` rolls back every transaction that emits it — the DB CHECK is a second, unpaired owner"
- history/2026-08-01-to-07.md § "[2026-08-01] A new table or a new analytics event is never wiring-only — budget the registry ripples at planning time"
- history/2026-08-08.md § "2026-08-08 — #697 import consent analytics sink ship"
- history/2026-08-21-to-31.md § "[2026-08-22] `docs/analytics/events.md` owns event keys and properties; the code does not"
