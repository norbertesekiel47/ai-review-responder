# Lab notes — Solicitation / CSV ingest

## Summary

- **Solicitation / CSV ingest** — the `csv_ingest` advisory-lock contract covers status transitions only: the offboarding purge hard-DELETEs `contact_csv_uploads` unlocked, so `writeTerminalUploadState` deliberately TOLERATES a 0-row terminal write rather than asserting (#582); the batch builder pools every contact of the business, so a staging smoke's funnel never equals its own CSV; `useReviewedPing` is `visibilityState`-gated so background automation never writes `reviewed_at`; the Suppression ledger's §1.2 lookup has ONE owner (`suppressionMatchSql`) and its `channel` is a PARAMETER on both reader and writer — a hardcoded literal on one side fails OPEN the day the channel enum grows (#643); the offboarding token scrub matches on `account_id` alone so its account-leading index is usable, with the `business_id` arm kept only in the purge VERIFIER as a cross-account tripwire; ingest merges a re-uploaded handle in place and `normalizeEmail` keeps `+tag` sub-addresses, so a plus-addressed re-seed is a NEW contact and only an identical re-upload trips `over_contacted`; the owner's per-row Delete (§5) cascades asks + outreach and leaves the batch row, which is the "batch with zero children" shape — read `pool_count` in the batch-build log before blaming an upload (#965)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-05.md § "CSV bulk-import: enqueue ONE aggregate Stripe overage job, not one-per-row"
- history/2026-07.md § "2026-07-26 — Solicitation watch-mode owner UI smoke (#528)"
- history/2026-07.md § "[2026-07-26] The Solicitation batch builder pools EVERY contact of the business, so a staging smoke's funnel never equals its own CSV — predict the arithmetic instead of expecting a clean env"
- history/2026-07.md § "[2026-07-26] The `csv_ingest` advisory-lock contract is a STATUS-TRANSITION contract, not a table contract — the offboarding purge deletes unlocked, so a 0-row terminal write is tolerated on purpose (#582)"
- history/2026-08-01-to-07.md § "2026-08-01 — #625 consent-ledger ship promotions"
- history/2026-08-01-to-07.md § "2026-08-03 — #643 suppression-ledger ship promotions"
- history/2026-08-01-to-07.md § "2026-08-03 — #644 unsubscribe opt-out ship promotions"
- history/2026-08-01-to-07.md § "2026-08-05 — #645 manual suppression paths ship promotions"
- history/2026-08-21-to-31.md § "2026-08-21 — #898 solicitation send governors"
- history/2026-08-21-to-31.md § "2026-08-22 — #899 solicitation send worker"
- history/2026-08-21-to-31.md § "[2026-08-22] Two solicitation tables carry no tenant columns, and reflex tenant-scoping breaks on them"
- history/2026-08-21-to-31.md § "[2026-08-22] A restraint-policy fixture with a hard-coded date is a time bomb, not a constant"
- history/2026-08-21-to-31.md § "[2026-08-22] `sending_started_at` and `sending_at` are different columns with different owners"
- history/2026-08-21-to-31.md § "2026-08-22 — #900 solicitation release poller"
- history/2026-08-21-to-31.md § "[2026-08-22] Any fixture meaning "already happened today" must be pinned inside the UTC day"
- history/2026-08-21-to-31.md § "2026-08-26 — #967 post-purge global opt-out"
- history/2026-08-21-to-31.md § "2026-08-26 — feat-qr-review-request staging ride"
- history/2026-09.md § "2026-09-06 — #965: "the upload erased the history" was the owner's Delete button, read from a log counter twelve days later"
