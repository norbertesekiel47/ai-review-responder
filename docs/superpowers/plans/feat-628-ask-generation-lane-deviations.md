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
- [2026-07-30] **Task 1 (spec §4.4 prerequisite): Anthropic temperature
  forwarding changes the FALLBACK behavior of existing tasks.**
  `anthropic-provider.ts` now forwards `request.temperature` (key omitted when
  undefined, preserving the SDK default), so the Anthropic fallback path of
  `reply_generation` now runs at 0.7 and `insights` at 0.5 instead of the SDK
  default. The change rides deliberately with a pinning regression test
  (`changes reply_generation and insights anthropic fallback temperature
  knowingly` in `src/lib/llm/__tests__/anthropic-provider.test.ts`). Minor
  scope addition beyond the planned file list: the now-stale "NOT forwarded by
  anthropic today" doc comment on `LLMTaskDescriptor.temperature` in
  `src/lib/llm/types.ts` was updated in the same change (stale cross-references
  are bugs per repo rules).
  Spec-review addendum: the same forwarding also moves the Anthropic fallback
  of `triage` and `judge` (registry temperature 0) from the SDK default to 0 —
  beneficial (deterministic classification on fallback) but part of the blast
  radius the spec's §9 wording understated.
- [2026-07-30] **Task 4 spec-review carry-forward: placeholder uniqueness is
  unowned.** If the LLM body itself emitted `{{unsubscribe_url}}` /
  `{{review_link}}`, assembly would yield two occurrences: lint class 7 checks
  presence only, provenance (class 6) ignores lowercase tokens, and AMEND B4
  does not specify duplicate-substitution behavior for #630. Task 5 SHOULD
  close this cheaply by making class 7 assert exactly-once (a duplicated
  placeholder becomes a lint_failed render); otherwise it falls to #630's
  substitution contract.
