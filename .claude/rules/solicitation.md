---
paths:
  - "src/lib/solicitation/**"
  - "worker/jobs/solicitation-*/**"
  - "worker/jobs/solicitation-send.ts"
  - "worker/jobs/csv-ingest/**"
  - "worker/ingress/unsubscribe.ts"
  - "worker/ingress/resend/**"
  - "src/app/api/dashboard/solicitation/**"
  - "src/app/api/admin/solicitation/**"
  - "src/app/api/dashboard/contacts/**"
  - "src/app/api/u/**"
---

# Solicitation rules

## Read first

- Consent / suppression: spec `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` + `docs/context/solicitation-suppression-unsubscribe.md` (**eight** LOCKED terms).
- Approval / halt lane: spec `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` D9/D22/D23 + ADRs `docs/adr/0020-regeneration-refused-after-approval.md` / `docs/adr/0021-ask-withdrawal-is-restraint-not-reapproval.md` + `docs/context/solicitation-send-mode-approval-halt-lane.md` → **Owner approval**, **Ask exclusion**, **Ask regeneration**, **Ask withdrawal**, **Halt latch** (LOCKED).
- Other contexts: `docs/context/solicitation-send-mode-batch-and-delivery-seam.md`, `docs/context/solicitation-send-mode-breaker-release-attribution.md`, `docs/context/solicitation-watch-mode.md`, `docs/context/solicitation-contacts-visits.md`, `docs/context/restraint-policy.md` (`CONTEXT-MAP.md` indexes every term).
- File map + rules and why: `docs/directory/lib-solicitation-a.md`, `lib-solicitation-b.md`, `lib-solicitation-c.md` § `solicitation/`; jobs in `docs/directory/worker-jobs-*.md`; `unsubscribe.ts` in `docs/directory/worker-ingress.md`.
- Lab notes: `.claude/reference/lab-notes/solicitation-csv-ingest.md`, `.claude/reference/lab-notes/ingress-rate-limiting.md` (the statutory opt-out route is exempt from the limiter by design).

## Traps

Consent or suppression (Consent ledger, Suppression ledger, Unsubscribe tokens, `suppressionMatchSql`, withhold-reason precedence in `evaluateAsk`):

- (a) attestation never overrides suppression; global wins a double match; (b) a page may claim "you are unsubscribed" only from a ledger read taken during that render — a receipt is never sufficient; (c) the admin **Correction path** and §7.6 owner clearing are different acts with different sinks (`solicitation_suppression_corrections` vs `account_audit_log`) — never one control.

Approval / halt lane (`approveBatch`/`haltBatch`/`adminHaltBatch`/`requestAskRegeneration`/`withdrawAsk`, the Requests panel, the admin batch panel):

- (a) exclusions validate BEFORE any write — postgres.js commits when the `sql.begin` callback resolves; (b) no verb terminalizes the parent — all call `closeBatchIfSettled`; (c) both halt arms share one private `latchHalt` and both refuse `pending`; (d) `withdrawAsk` checks idempotence BEFORE the state gate.

Release cycle P4 scan (`selectReleaseCandidates`, the two fairness arms, `runAccountArm`'s gates — #1329):

- (a) the SCAN's arms are a discovery bound on a snapshot; `runAccountArm`'s reads are the AUTHORIZATION and must stay current-state, because nothing downstream re-checks either dial; (b) `resolveAccountDailySendCap` owns the clamp — the arm binds its OUTPUT via `unnest`, never a SQL `LEAST`; (c) the cap entry gate changes only the REPORTED reason (`capacityExhausted()` also stops a zero remainder), so a test that deletes it must break BOTH account-level gates in one window to notice.

## Rules

- Nothing beyond the traps was moved from `.claude/CLAUDE.md`; the rules and their why live in the three `docs/directory/lib-solicitation-*.md` pages named above.
