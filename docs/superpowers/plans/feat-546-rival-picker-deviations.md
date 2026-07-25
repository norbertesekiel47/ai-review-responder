# feat/546 rival picker — deviations

Short log of things the plan did not anticipate. One entry per surprise.

## Task 1 — migration 089

- **Migration-test drift-guard is a recurring landmine — promote to
  `.claude/reference/lab-notes.md` at step 8.** Whichever per-migration test holds
  the live "effective `event_name` CHECK list ⟺ `ANALYTICS_EVENT_NAMES`"
  assertion breaks the *next* time any analytics event is added, because the
  migration it guards is immutable and its list can never grow again. This has now
  happened twice and been fixed the same way both times: 058 handed the guard to
  069 (see the comment at `migration-058-offboarding-analytics-events.test.ts:40-42`),
  and this task hands it 069 → 089. The durable fix is to move the assertion out of
  per-migration tests into a single test that resolves the *latest*
  constraint-extending migration and asserts against that — out of scope for #546.

- **Plan's SQL header said "hence the lock_timeout above"; `SET lock_timeout`
  actually appears below the comment block.** Written as "below" in the shipped
  migration. Comment-only wording fix, no behavioral change.

- **069's test imported `ANALYTICS_EVENT_NAMES` solely for the assertion that was
  narrowed.** The import became unused (lint error) and was removed in the same
  edit. Not called out in the plan.

- **A naive "no DEFAULT" assertion on the whole migration file false-positives.**
  `[^,;]*` spans newlines, and the `COMMENT ON COLUMN` string literal contains the
  word "Auto-**default** rival". The nullability/no-default assertions in
  `migration-089-competitor-rival-pick.test.ts` are therefore scoped to the
  extracted `ALTER TABLE businesses …;` statement rather than the full file —
  which is also the more correct thing to assert.
