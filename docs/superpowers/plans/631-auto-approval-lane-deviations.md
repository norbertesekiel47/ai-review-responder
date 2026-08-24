# #631 Auto-approval lane — deviations log

Entries the plan did not anticipate. Each entry gets an orchestrator verdict:
ACCEPT or RE-PLAN (step 6 read-back).

## Pre-execution (planning-time) entries

- [2026-08-23] **Surface amendment 1 of 2 (owner-approved).** The veto-notice
  dispatch mirrors `worker/jobs/pending-post-notice/`, whose claim helpers and
  per-channel send methods live in `src/lib/notifications/`. Added to
  `allowed_edit_surface`: `src/lib/notifications/**`, `src/lib/config/worker.ts`
  (one optional `WHATSAPP_SOLICITATION_VETO_TEMPLATE_SID` key),
  `docs/runbooks/whatsapp-templates.md`. Both intake copies updated. VERDICT:
  ACCEPT (owner sign-off recorded in session).
- [2026-08-23] **Intake wording correction (not an amendment).** The intake says
  the auto-approval decision runs "at build completion". The code shows
  `built_at` is stamped BEFORE ask generation (`batch-builder.ts` constructBatch),
  and rendered copy exists only after the generation FINALE transaction
  (`ask-generation.ts` ~line 1130). The decision hook therefore runs in the
  generation finale, initial generation only — never on the `regenerateAsk`
  path (regen exists only in `built`, i.e. only for batches the auto lane
  declined). The owner-facing meaning ("the batch auto-approves the moment its
  messages are ready to review") is unchanged. VERDICT: ACCEPT.

## Plan-review round 1 triage (2026-08-23, codex VERDICT: REVISE)

Report: `docs/reviews/631-auto-approval-lane/plan-round-1.md`. All 14
confidence-filtered findings triaged; plan rev 2 incorporates every ACCEPT.

- F1 owner-approval race → quiet `owner_won` outcome — ACCEPT (plan decision 2)
- F2 approval-time reads serialized via account lock — ACCEPT (decision 3)
- F3 release-time TOCTOU → re-read inside the downgrade tx; residual per-row
  window documented as the existing one-tick class — ACCEPT (decision 6)
- F4 B14/B15: subscription lapse holds, master flag stops the phase; neither
  downgrades. Plan mapper was wrong; the INTAKE's locked fork (auto flag off ⇒
  downgrade) stands untouched — ACCEPT (decision 6)
- F5 reason-parameterized downgrade split — ACCEPT (decision 7)
- F6 real tier ids `copilot`/`autopilot` — ACCEPT (decision 15)
- F7 settings PATCH is an operation union — ACCEPT (decision 14)
- F8 literal ON CONFLICT predicate for the upsert — ACCEPT (decision 14)
- F9 `uuidv7()` not `randomUUID()` — ACCEPT (decision 14)
- F10 CTA is `/dashboard/requests`, tokenless; context.ts precedent claim
  corrected — ACCEPT (decision 10)
- F11 systemic failure must cover the zero-enrolled Worker early return —
  ACCEPT (decision 12)
- F12 resend `OWNER_DIRECTED_TEMPLATES` registration, outside rev-1 surface —
  ACCEPT via intake re-lock rev 2 (owner decision; surface now includes
  `worker/ingress/resend.ts` + tests)
- F13 savepoint control flow: 23505 escapes the callback, caught outside —
  ACCEPT (decision 13)
- F14 no PgBouncer bug in the finale; the release-read hazard is F3 — ACCEPT
  (no separate change)

Appendix items resolved by owner re-lock: anchor = `MIN(sent_at)` (the
Reply-lane shipped semantic; Telegram has no delivery receipt); the notice
worker gates on batch state only, no flag reads.

Intake rev 2 also expands `tests_to_add` 19 → 44 (adopting the review's
missing-failing-test list where it pins production wiring, races, and B14/B15
behavior). Owner-approved in session, 2026-08-23.

## Plan-review round 2 triage (2026-08-23, codex VERDICT: REVISE)

Report: `docs/reviews/631-auto-approval-lane/plan-round-2.md`. 12/14 findings
+ both appendix items RESOLVED. Open items and disposition:

- F3/F14 (release-side TOCTOU on the PASSING arm-level check) — ACCEPT, fixed
  in plan rev 2.1: the four-condition guard moves INTO `releaseOutreachRow`'s
  transaction for auto_policy batches (account lock, in-tx re-read, new
  `auto_conditions` withhold reason). Affordable because
  RELEASE_PER_TICK_BUDGET=2/60s (ADR 0022). Intake edge_cases updated to
  match (intake-field correction, not an amendment).
- Appendix nit (Task 5 title count 6 → 7) — ACCEPT, fixed.

## Task 2 execution (2026-08-23)

- [2026-08-23] **Surface amendment 1 of 2 against intake rev 2 (auto-approved
  class).** The `ci:merge-ledger` audit (#896, landed 2026-08-23 — AFTER this
  intake was drafted) fails any production-diff PR that adds no line to
  `.claude/reference/arch-review-log.md`. That file was missing from the
  surface. Added it: a ≤2-file addition inside the `.claude/reference/`
  registry directory the intake already edits (env-vars.md, migrations-log.md),
  and the edit is mandated by the workflow's own audit. Ledger row for #631
  added (PR number to be filled at step 8). Both intake copies updated.
  VERDICT: ACCEPT.

## Task 1 execution (2026-08-23)

- [2026-08-23] #656 promised-test integrity meta-test (postal-address.test.ts:70)
  forbids it.todo in ask-generation.integration.test.ts → the 4 finale eval
  titles moved to auto-approval.integration.test.ts; Task 4 authors their
  bodies there (they drive generateAsksForBatch by import, so placement is
  equivalent). Plan Task 1 item 3 superseded.
