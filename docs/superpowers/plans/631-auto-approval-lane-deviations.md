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
