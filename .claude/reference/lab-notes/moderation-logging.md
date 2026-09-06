# Lab notes — Moderation / logging

## Summary

- **Moderation / logging** — fail-open moderation, logger-never-throws (incl. AsyncLocalStorage binding for correlation IDs); `createWorkerLogger` OBJECT args pass through the analytics blocked-key sanitizer, which silently drops any key containing `token` — a deliberately-safe derived value (hash prefix, masked suffix, key id) must be NAMED to survive it (`hash_prefix`, not `token_hash_prefix`), and string args bypass the sanitizer entirely (#644)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-05.md § "A best-effort helper should own its never-throws contract; callers shouldn't double-wrap"
- history/2026-05.md § "PHI scanning must gate EVERY ingest path — `processReview` is the real chokepoint, not just `insertImportedReview`"
- history/2026-05.md § "A conservative PHI regex must use co-occurrence, not bare medical keywords"
- history/2026-05.md § "A logger must never throw"
- history/2026-05.md § "Bind log context at the registration boundary, not per handler"
- history/2026-05.md § "Moderation must fail open, never silently approve"
- history/2026-05.md § "Holding an unsafe draft must stay atomic with the response write"
- history/2026-05.md § "Untrusted values inside a delimited prompt block must be escaped"
- history/2026-08-01-to-07.md § "[2026-08-03] `createWorkerLogger` object args pass through the analytics blocked-key sanitizer, which silently DROPS any key containing `token`"
- history/2026-08-08.md § "[2026-08-08] #697 — a `warn` is not a sink: swallowing an error into stdout is indistinguishable from having no error handling at all"
- history/2026-09.md § "[2026-09-04] A substring assertion against a serialized log line can be satisfied by the TIMESTAMP"
- history/2026-09.md § "[2026-09-04] `createWorkerLogger` silently DROPS array values"
