# Adversarial approach review — round 2, verification only (Codex gpt-6-astra, resumed session 01a0c4bd-1b04-7d12-baaa-8d6c4723e3a9)

A1 — **ADDRESSED** — `worker/jobs/account-offboarding/PurgeWorker.ts:60,173`: terminal fingerprints include `account_offboarding_id`; retry fingerprints remain shared. Distinct offboardings no longer share the per-issue throttle.

A2 — **REJECTION-HOLDS** — `docs/runbooks/beta-launch-alerting.md:584` explicitly identifies watchdog and pre-handler failures as uncovered and references #1413; these are pre-existing paths outside this fix.

A3 — **REJECTION-HOLDS** — `docs/runbooks/beta-launch-alerting.md:584` explicitly names `account_offboarding_not_found` as returning without an alert and includes it under #1413.

A4 — **PARTIALLY** — `worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts:937–958` now checks the correct row’s filters, terminal fingerprint and every-event trigger, but still does not pin the throttle, environment or destination action. Removing the Discord action while retaining the rule name still passes; the retry fingerprint assertion targets the block, not specifically the row.

A5 — **REJECTION-HOLDS** — `src/lib/solicitation/__tests__/ingest.test.ts:86–93` accurately documents the locked regex’s limits. However, the added comment filtering introduces a separate regression below.

**Introduced defect — P2 — `src/lib/solicitation/__tests__/ingest.test.ts:106`:** `stripCommentLines` discards entire lines beginning with `/*` or `*`, including executable code after a closing block comment. For example, a second lock-key construction written as `/* per-business lock */ const key = 'csv_ingest_' + businessId;` is now invisible, although the unchanged regex previously detected it. The same happens to code following `*/` on a multiline comment’s closing line. Preserve executable suffixes when removing comments; this is a new false negative, independent of the accepted string-construction limitations.

**Per-offboarding fingerprint:** No concrete new notification-loss defect found in this fix. It intentionally increases issue cardinality and still suppresses repeat events for the *same* offboarding within 60 minutes. Consequently, the new claim at `docs/runbooks/beta-launch-alerting.md:578` that it keeps “a repeat failure on the same offboarding from being swallowed” needs qualification; the cross-offboarding guarantee is correct.

VERDICT: REVISE
