# Lab notes — Zernio

## Summary

- **Zernio** — nested `account.id`, MOCK_EXTERNAL_APIS real-path tests, reviewReply normalization; the sandbox feed is non-descending in practice — the consented import's dirty-ordering WARN + page-to-feed-end is the NORM on staging, not an incident (#675, 2026-08-06)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-04.md § "Zernio `account.disconnected` nested payload"
- history/2026-05.md § "Split decision: ship view-only, park Zernio-shaped edit machinery"
- history/2026-05.md § "Two-flag rollout pattern for ingest-vs-UI features"
- history/2026-05.md § "`MOCK_EXTERNAL_APIS=true` in CI breaks the Zernio real-path tests"
- history/2026-06.md § "Zernio fixture's `publish_reply` MUST attach the reply to the stored review"
- history/2026-08-01-to-07.md § "2026-08-06 — #675 consented import ship"
- history/2026-08-01-to-07.md § "[2026-08-06] #675 — the Zernio sandbox feed is non-descending in practice: the import's dirty-ordering lane is the norm there, not the exception"
- history/2026-08-21-to-31.md § "[2026-08-31] Both providers expose webhook CRUD over their APIs — the runbook's dashboard steps were never necessary"
- history/2026-08-21-to-31.md § "[2026-08-31] Webhook subscriptions are per-USER, not per-environment → every event fans out to both workers"
