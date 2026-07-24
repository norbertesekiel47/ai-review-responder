# Deviations — feat/competitor-snapshots-538

## Task 2

- Plan Step 4 prose says "the 7 new ones", but the authoritative Step 1 code
  block contains **8** `it(...)` tests. All 8 were written verbatim, all 8
  failed in the red phase, and all 8 pass after implementation. No code
  deviation — prose/code count mismatch only.

## Step 8 staging ride (2026-07-23) — discoveries, no code deviation

Smoke PASSED on the coords (`ll`) branch — the path prod actually takes:
20-row pack persisted with full field mapping, own-rank NULL + no `is_self`
row (own business absent), same-day re-run atomically replaced all 20 rows
(all `created_at` = second run), outbox `completed`. Evidence: staging
business `019f900b-aa3c-7568-af26-e42f15e63cc6`, outbox
`3b8d04e2-9acc-4957-ad38-3d791a2e7f8e`, correlation
`40ff039c-7b7d-457f-9de2-6d7193a587c4`, worker logs 04:40:44Z + 04:42:22Z.
Test state (account status, keywords, location, coords) restored after.

Two PRE-EXISTING defects surfaced by the smoke (both on `main` before this
branch; NOT fixed here — out of intake scope). File follow-up tickets:

1. **`ranking_search_location` fallback branch is broken against SerpAPI.**
   `google_maps` + `location` (no `ll`) returns HTTP 400 "Missing `z` or `m`
   parameter". Every business relying on `ranking_search_location` instead of
   stored coords fails ranking tracking. Latent in prod because onboarding
   stores lat/lng; first observed here because the seeded smoke business had
   only a search location.
2. **Failed `track_ranking` jobs are invisible.** The `serpapi` lib rejects
   non-200 responses with the raw body *string*; BullMQ records
   `failedReason: "null"` with no stacktrace. Generic workers' `failed`
   handler only adds a Sentry breadcrumb — no log line, no capture. The job
   died 3 silent attempts; only Redis inspection surfaced it. Candidate lab
   note + observability follow-up (log-line `failed` listener, wrap SerpAPI
   rejections in `Error`).
