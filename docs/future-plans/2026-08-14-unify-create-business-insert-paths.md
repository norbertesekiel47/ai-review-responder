# Unify `createBusiness`'s two insert paths

**Raised:** 2026-08-14, step-7 review of `admin-invite-funnel` (standards axis,
HIGH). **Deferred by owner decision** in that review — see
`docs/superpowers/plans/admin-invite-funnel-deviations.md` → D-17.
**Status:** open, not scheduled.

## What

`src/lib/onboarding/create-business.ts` holds two sibling transactions —
`runAdminTx` and `runSelfServeTx` — that are each ~115 lines of near-identical
`INSERT` SQL: a 10-column `accounts` insert, a **21-column** `businesses` insert,
and a 7-column `users` insert. They differ in five interpolated values plus one
conditional `channel_enrollments` row. The file's own comment concedes "the only
content difference is `name`".

## Why it matters more than ordinary duplication

Column **order** across the two 21-column inserts is held in sync by nothing but
a comment. These are the rows that three separate downstream consumers read:

- `businesses.onboarded_by` — the **Admin invite** marker, which also gates
  trial eligibility (`plan-activation.ts`) and scopes
  `CleanupAbandonedSignupsPoller`
- the **Beta comp coupon**'s eligibility test, via that same column on the
  primary Business
- `accounts` billing columns, which invariant #9a says are read as a
  point-in-time snapshot

So a column added to one path and not the other, or added in a different
position, is a silent wrong-column write in the highest-consequence table pair
in the codebase. That is the shotgun-surgery risk, not the line count.

## Why it was deferred rather than fixed in the branch

The admin-invite journey had already been proven end to end on staging against
this exact file (`docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md`).
A ~230-line restructure with no behavioural change would have invalidated that
proof and required a full re-walk, for a maintainability win that keeps its value
whenever it is done. Deferring was the lower-risk ordering, not a dismissal.

## Shape of the fix

One parameterized insert per table, with the five varying values passed in and
the conditional enrollment row hoisted to the caller. The column list then exists
once, which removes the ordering hazard entirely rather than documenting it.

Fold in at the same time, from the same review:

- **D-12** — `CreateBusinessResult.paymentUrl` is hardcoded `null` with **no
  production reader**; its recorded justification ("deleting it means touching
  self-serve signup callers") does not hold, the reference set being the
  declaration, two assertions in its own suite, and mocked fixtures.

## Verification

`pnpm test src/lib/onboarding/__tests__/create-business*` plus the two migration
shape suites, then re-walk the admin-invite journey on staging per
`docs/runbooks/beta-onboarding-cofounder-guide.md` Part 5 — the restructure
touches account creation, so a green unit suite is necessary and not sufficient.
