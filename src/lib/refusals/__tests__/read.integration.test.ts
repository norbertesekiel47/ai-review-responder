// The Refusal ledger's READ path — live-Postgres eval (#1014 T1, RED).
//
// Titles 1-22, VERBATIM from `.feature/intake.json` `tests_to_add`. The
// `promised-tests` gate row matches them as fixed strings, so a retitle here
// fails the gate rather than the test.
//
// WHY THEY ARE ALL `it.todo` AT T1. `src/lib/refusals/read.ts` does not exist
// yet. A named import of a module that is not there fails the whole FILE at
// collection, which would report 22 missing titles instead of 22 pending ones —
// the same collection trap `write.integration.test.ts` documents one directory
// over. Task 2 adds the import and the first bodies; Tasks 3 and 4 add the
// footnote and archived-period arms.
//
// WHY THE LIVE-DB LANE. `getRefusalLog` is three sequential queries whose whole
// contract is scoping, ordering and bounds against real rows: the account /
// location scope predicate, the account-wide suspension that must appear once
// per location view and once in the account total, and the two window bounds.
// None of that is provable against a mock — a mock returns whatever the query
// author believed the query said.
//
// This file applies NO migration SQL and executes NO DDL. `pnpm test:db:setup`
// provisions the schema; the bodies Task 2 adds assert it with
// `assertSchemaReady` and seed with `INSERT` only. Run-time DDL deadlocks
// (40P01) across concurrent suites, and `ci:live-db-suites` R2 enforces that.

import { describe, it } from 'vitest';

describe('getRefusalLog', () => {
  // --- What the read projects (ADR 0023) ---
  it.todo('renders the stored refusal_category and never re-derives it from refusal_code');
  it.todo('never selects all_refusal_codes');
  it.todo('distinguishes a non-null unresolved subject from a lane with no subject');

  // --- Scope: account vs location (invariant #8, CONTEXT.md Restraint tab) ---
  it.todo('scopes an account read to account_id alone');
  it.todo('scopes a location read to account_id and (business_id = $2 OR business_id IS NULL)');
  it.todo("isolates one account's refusals from another account's in the same window");
  it.todo("isolates one location's refusals from a sibling location's in the same account");

  // --- The account-wide suspension, which is the read's hardest case (I7) ---
  it.todo('returns one row per location view for a single account-wide suspension');
  it.todo('returns a single account-total row for a suspension and never multiplies it across locations');

  // --- Ordering and the empty window ---
  it.todo('orders newest first within each category');
  it.todo('returns an empty log without error when refusal_events holds no rows');

  // --- Archived locations: excluded from both totals, counted in the footnote ---
  it.todo('excludes rows belonging to an archived location from the account total');
  it.todo('excludes rows belonging to an archived location from a location total');
  it.todo('counts archived-location refusals in the account footnote for the same window');
  it.todo('reports a zero archived-location footnote count when no archived location has refusals in the window');
  it.todo('returns no rows for a location that is archived');

  // --- Archived periods, read from the audit log and never re-derived ---
  it.todo('returns archived periods that intersect the window and omits periods that do not');
  it.todo('reads archived periods from account_audit_log and never re-derives a refusal from it');

  // --- Coverage start and the window bounds (E13, I15) ---
  it.todo('clamps the account coverage start to accounts.created_at');
  it.todo('clamps a location coverage start to businesses.created_at');
  it.todo('returns windowStart clamped to accounts.created_at when the account was created inside the selected window');
  it.todo('excludes Refusals after windowEnd from entries and the archived-location footnote');
});
