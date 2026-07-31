# Deviations — feat-628-ask-generation-lane

Entries are appended by implementation subagents when reality diverges from the
plan; each gets an ACCEPT / RE-PLAN verdict at step 6.5.

## Pre-implementation coordination notes

- [2026-07-30] **Surface overlap with `feat-625-consent-ledger`** on
  `src/lib/solicitation/**`; the one real collision file is
  `src/lib/solicitation/batch-builder.ts` (#625 rewrites the consent read in
  the candidate query; #628 adds the generation enqueue to the `built_at`
  transaction). **Agreed merge order (owner-approved): #625 merges first;
  #628 rebases over it before its gate/review rounds.** Same note recorded in
  feat-625's deviations file.
- [2026-07-30] **Postal-address column dependency (locked at grilling):**
  renders bake `businesses.solicitation_postal_address` (#622 D7), but the
  column ships with #627 (unlanded; head = 092). #628 lands **inert**: footer
  assembly takes `postalAddress` as an explicit parameter; the loader SQL
  references the column but is unreachable while `SOLICITATION_SEND_ENABLED`
  is off/nonexistent. Full-path staging proof deferred to the #633 runbook
  campaign. Latent dependency: the loader query crashes if executed before
  #627's migration — do not flip the flag anywhere before #627 lands.
- [2026-07-30] **Adversarial round-1 spec gaps resolved in the plan** (codex session
  019fb5dc, VERDICT: REVISE → plan decisions 4–10): (a) never-moderated withheld rows
  (`lint_failed`, budget-refused) fill `moderation_status='error'` — 091 has no
  "not run" member and this ticket ships no migration; **candidate vocabulary widening
  for a later migration ticket**: a `skipped` moderation status and a `budget_exceeded`
  disposition reason would make these rows self-describing. (b) SPEC §1.1's bucket table
  starts at 1 day — same-day visits render bucket `today` (spec delta). (c) SPEC §7.4's
  "live render" idempotency wording is superseded by the stricter any-non-cancelled-row
  check — live-only would re-generate terminal withheld children on job retry.
- [2026-07-30] **Spec §10 offboarding obligation void:** the "adds the
  offboarding table-disposition entry" binding targeted the superseded
  `solicitation_ask_messages` table (B1); `solicitation_outreach` disposition
  is #624's and already shipped. Nothing to do in #628.
