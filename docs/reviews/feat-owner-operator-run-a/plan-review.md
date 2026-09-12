# Plan review record — feat/owner-operator-run-a

Plan: `docs/superpowers/plans/feat-owner-operator-run-a-plan.md` (its review appendix carries the per-item detail; this file is the round ledger).
Intake: `docs/superpowers/plans/feat-owner-operator-run-a-intake.json`.
Base: `f747cb7b64f8af5a7b74691110b0d10d9d8ff897` (origin/main, 2026-09-11).
Codex thread (round 1, resumed for rounds 2 and 3): `01a0937a-9cf7-7352-9e1f-72bf9fc86368`.

## Orchestrator review (before round 1)

18 findings on the first draft, all applied (F1–F18 in the writer's log): scrubber over-matching on ordinary owner text and on any block over 300 characters; `stars?` in the metric-word list; a location-scoped proposal with no location accepted; `SchemaRequirement.constraints` shape; idempotency read before the conversation lock (23505 on a concurrent replay); fenced UPDATEs without a `status = 'running'` predicate; the pasted-review notice never persisted; a `describe` field the INSERT ignored; unverified `getAutoApprovalSettings` projections; three prose corrections converted to code; comment-only test bodies in T7; missing exhaustiveness guard on the route switch.

## Round 1 — full plan-skeptic (cold), VERDICT: REVISE

14 findings, all accepted, applied as C1–C16:

| # | Severity | Finding (short) | Fix |
|---|---|---|---|
| F1 | High | Titles 7, 8, 35 had no bodies | real bodies in T3 |
| F2 | High | Historical `owner_text` and `sampleResponses` reached the snapshot unscrubbed | earlier terminal turns only, re-scrubbed; four-field `SnapshotFacts` |
| F3 | High | Transient failure kept the claim; the ~5 s retry lost it and ended the ladder | release the claim (fenced) before rethrow; new live case |
| F4 | High | Outbox CAS result ignored; stale hook could fail a newer attempt | terminal-turn branch completes the outbox; hook fences on the outbox attempt |
| F5 | High | `LLMStructuredOutputError` escaped the cost guard unaudited | handled inside the guarded closure; billed attempts summed and recorded |
| F6 | Medium | Same key, different conversations → 23505 instead of 409 | catch outside the tx, re-read, resolve |
| F7 | Medium | GET rendered historical `status_ref` with the latest location's metrics | materialize `status` at completion; renderer pure |
| F8 | Medium | Star bands counted deleted reviews | `r.status <> 'deleted'` + fixture |
| F9 | Medium | reviews join lacked the audit's scope proof | join on both keys; audit-silence note |
| F10 | Medium | `EXPLICIT_ACCOUNT_OFFBOARDING_TABLES` additions broke exact equality | removed; live two-account purge case |
| F11 | Medium | Test bodies with wrong signatures/imports | reconciled |
| F12 | Medium | `.trim()` altered stored text and idempotency | verbatim text; blank check only |
| F13 | Medium | No assertion that nothing was applied | before/after assertions on settings, policies, publish rows |
| F14 | Medium | Flag not proven registered in the boolean guard | both matrices extended |

Qualifications recorded in the plan: the `dispatching`→`dispatched` race for an instant flag-off completion is platform-wide (out of scope); lost primary spend on a successful fallback is the seam's documented behavior (out of scope).

## Round 2 — verification (resumed), VERDICT: REVISE

7 addressed (F1, F3, F8, F10, F11, F13, F14); 7 open because the fix existed but no test could fail for the defect, plus two fix-introduced defects (non-atomic failed-hook; duplicate `RenderedSegment`/import). Applied as D1–D10 (historical-turn fixture in title 31; atomic hook; real `LLMStructuredOutputError` unit test; live turn-key race and verbatim-text cases; duplicates removed; audit-silence note; deterministic title 23; `VoiceConfig` reconciled).

## Round 3 — verification (resumed), VERDICT: APPROVED

All nine re-checked items ADDRESSED; no D-fix introduced a defect. Appendix (untriaged): flag-off helper orders the turn write before the outbox CAS — recorded in the deviations file as a T5 implementer instruction (ACCEPT).

Token note: rounds 2 and 3 resumed the round-1 thread rather than starting cold, per `review-prompts.md` § Dispatching a Codex round.
