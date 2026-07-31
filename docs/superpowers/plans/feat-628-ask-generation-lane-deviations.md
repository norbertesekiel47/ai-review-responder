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
- [2026-07-30] **Task 5: `AskLintInput` gains a required fourth field
  `subjectDisallowedValues` beyond the plan's pinned three-field shape.** The
  plan defines the B5 subject-PII check as "any interpolated value other than
  `contact_first_name`/`business_name` appearing in subject", but the pinned
  flat `interpolationValues: readonly string[]` carries no labels, so that
  half of the check is unimplementable as pinned — and a literal "everything
  but first/business name" reading would make the bucket phrase (`last week`)
  and vertical block ordinary subjects, which are closed vocabularies and not
  PII. Resolution: the caller passes the PII-capable subset (today: the
  admitted visit note) as `subjectDisallowedValues`; the field is REQUIRED so
  Task 8's call site must decide explicitly (fail-closed by construction).
  Email and separator-stripped digit-run(≥7) patterns cover the pattern half.
- [2026-07-30] **Task 5: class 6 (provenance) excludes the assembled footer
  region; footer byte facts exported from `ask-render.ts`.** SPEC §2.4 says
  "over subject + body", but the assembled body bakes the owner-attested
  postal address, whose digit runs (`123`, `78701`) and capitalized
  street/city tokens are not §1.1 interpolation values — a literal scope
  would block EVERY render, making the class unsatisfiable rather than
  conservative. The lint therefore checks subject + the model-authored body
  above the LAST occurrence of the assembly-produced footer anchor
  (`\n\n---\n\nSent by RepWorth on behalf of `); lastIndexOf means a model
  emitting the anchor itself only moves more of its own text INTO the checked
  region. To keep one owner of the footer bytes, `ask-render.ts` (Task 4's
  file) additionally exports `FOOTER_SEPARATOR`,
  `SENDER_IDENTIFICATION_PREFIX`, and `UNSUBSCRIBE_LINE_PREFIX`, now used by
  its own `assembleAskBody` and by lint classes 6/7 (byte contract unchanged —
  the exact-bytes test in ask-render.test.ts is untouched and green). Related:
  §2.4's "closed scaffolding allowlist" names categories (greetings,
  weekday/month words, fixed template scaffolding) without enumerating
  tokens; the enumeration now lives in the golden-filed
  `PROVENANCE_ALLOWLIST` (includes `RepWorth`, belt-and-braces on top of the
  footer exclusion). One deliberate pattern tune recorded in the golden file:
  class 1's `free <noun>` carries `(?!to\b)` so the near-universal polite
  idiom "feel free to …" does not block every render; "free coffee" still
  blocks.
- [2026-07-30] **Task 5 closes the Task 4 placeholder-uniqueness
  carry-forward:** class 7 asserts each placeholder appears EXACTLY once — a
  duplicated `{{unsubscribe_url}}`/`{{review_link}}` (e.g. emitted by the LLM
  body itself) is now a `missing_required_element` block. SPEC §2.3 row 7's
  "lacks" wording does not contradict exactly-once (the table is
  "illustrative, not exhaustive — the implementing table is the contract"),
  so no NEEDS_CONTEXT was required. Class 7 also asserts the postal-address
  block structurally: ≥1 non-blank line strictly between the identification
  line and the unsubscribe line of the assembled footer.
- [2026-07-30] **Task 5 spec-review observation (no code change): classes 1–4
  still scan the FOOTER region.** The §2.5 exemption covers only interpolated
  values, so a postal address containing an incentive-looking token (e.g.
  "10 Points Blvd") terminally blocks every render for that business via
  class 1. Spec-literal today (classes 1–4 run over `subject + '\n' + body`,
  footer included); candidate future tune is adding the footer/postal region
  to the class 1–4 exemption in an `ASK_LINT_VERSION` bump.
- [2026-07-30] **Task 5 finding — an effectively-empty (whitespace-only) LLM
  body passes the lint.** Verified: `assembleAskBody('   ', …)` yields a
  render with both placeholders and the address block, and no SPEC §2.3 class
  owns body-emptiness (class 5's non-empty bound is subject-only per B5).
  Per instruction, NO rule was invented. Exposure: zod `body.min(1)` blocks
  the empty case; a whitespace-only body would render as a footer-only ask
  that the owner sees (generate-then-approve) and would regenerate/exclude.
  Candidate fix for a later `ASK_LINT_VERSION` bump with map-owner sign-off:
  add "non-blank model-authored body" to class 7.
- [2026-07-30] **Task 4 spec-review carry-forward: placeholder uniqueness is
  unowned.** If the LLM body itself emitted `{{unsubscribe_url}}` /
  `{{review_link}}`, assembly would yield two occurrences: lint class 7 checks
  presence only, provenance (class 6) ignores lowercase tokens, and AMEND B4
  does not specify duplicate-substitution behavior for #630. Task 5 SHOULD
  close this cheaply by making class 7 assert exactly-once (a duplicated
  placeholder becomes a lint_failed render); otherwise it falls to #630's
  substitution contract.
