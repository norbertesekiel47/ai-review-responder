# feat-728-content-freshness-gate — deviations log

- [2026-08-09] **Token owner relocated (plan round 1, codex BLOCKER — ACCEPT).**
  ADR 0017's letter cited the `SKIP_REASON_ARCHIVED_LOCATION` precedent in
  `worker-types.ts`, but that precedent is for log-only skip reasons. Our skip
  reason is written to `job_outbox.completion_reason`, whose declared single
  owner is `OUTBOX_COMPLETION_REASON` (`src/lib/shared/outbox-completion-reason.ts`
  — `markOutboxCompletedWithReason` is typed against it, so the plan's original
  shape could not typecheck). Token becomes
  `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT` (spelling `stale_review_content`
  unchanged, per owner sign-off); `worker-types.ts` drops out of the change.
  Locus correction, not a decision reversal — one owner per fact preserved.
- [2026-08-09] **Surface amendment #1 (owner-approved via AskUserQuestion).**
  Added `src/lib/shared/outbox-completion-reason.ts` (blocker fix) and
  `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`
  (consumes persist's string return at :430-454, :475-516 — mechanical unwrap
  for the discriminated-union return). Removed `src/lib/shared/worker-types.ts`
  (token no longer lives there) and `worker/jobs/__tests__/correlation-chain.test.ts`
  (miscited path; the real `worker/__tests__/correlation-chain.test.ts` never
  calls persist and needs no edit). Amendment budget: 1 of 2.
- [2026-08-09] **tests_to_add additions (owner-approved deviations, not
  amendments — #643 rule).** Three titles added from codex round-1 findings:
  the two-client FOR-UPDATE lock-serialization test (an implementation reading
  the hash before the lock passes every original test), the all-lanes unit test
  (a gate conditional on `on_demand_generate` would have passed the eval), and
  the structured-log-line test (intake observability had no assertion).
  `estimated_test_lines` 500 → 650 accordingly.
- [2026-08-09] **Rejected codex finding (recorded per round protocol):**
  "plan must run `pnpm build` and explicit tenant-scope/rls commands." The
  verify-gate contract runs every `ci:*` audit on every gate (tenant-scope +
  rls-audit observed PASS in this branch's docs-only run) and runs `pnpm build`
  only when the surface includes ui; this feature is backend-surface. The
  gate script, not the plan, owns verification enumeration.
