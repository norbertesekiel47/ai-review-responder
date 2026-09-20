# `ci:weakened-checks` — a reason for every REVIEW row

`ci:weakened-checks` passed with **10 rows for the reviewer**. REVIEW rows never
fail the audit; it detects a reduction and assigns the explanation to a human.
A green audit is therefore NOT acceptance of these ten, which is why each one
gets an answer here.

Run at `5dbda4d56`. Reproduce with `pnpm ci:weakened-checks`.

---

## Rows 1–5 · `test-file-deleted` — "where did its coverage go?"

Five text-guard suites were deleted. Each has a named successor that executes
the migration instead of matching its SQL text. Case counts:

| Deleted | Cases | Successor | Cases |
|---|---|---|---|
| `migration-048-impersonation-sessions.test.ts` | 3 | `migration-048-impersonation-sessions.integration.test.ts` | 5 |
| `migration-049-analytics-events-rls.test.ts` | 2 | `migration-049-analytics-events-rls.integration.test.ts` | 4 |
| `migration-051-structure.test.ts` | 6 | `migration-051-flagged-responses.integration.test.ts` | 5 |
| `migration-053-structure.test.ts` | 6 | `migration-053-users-role-constraint.integration.test.ts` | 9 |
| `migration-057-…-nullability.test.ts` | 4 | `migration-057-…-nullability.integration.test.ts` | 4 |

Case count is the wrong measure, and 051 shows why: six cases became five while
coverage went UP. The old six were regexes over one file; the new five execute
the migration, pin fourteen columns, six foreign keys and three CHECK
definitions from the catalogue, and compare a real seeded row before and after
the apply. Each suite's header carries its own old-assertion → new-case
mapping; read those for the per-assertion detail.

**Three assertion classes were genuinely retired, not moved.** They are listed
under rows 9–10's sibling section below and in each suite's header.

**Why the deletions are not a net loss.** The deleted form was defeated five
times on #1171 by whitespace, a block comment, a `--` inside a string literal,
and a comment standing in as evidence. A guard that green-lights a weakened
migration is worse than no guard, because it is believed.

---

## Rows 6–8 · `quality-config-changed` — "confirm no check was relaxed"

### `.github/workflows/ci.yml`

One character: `image: postgres:16` → `postgres:17`. No other service key
moves — not the env block, the tmpfs data directory, the health-check options,
or the ports. This **strengthens** the lane: migration 122's `MAINTAIN`
statements are version-guarded to PostgreSQL ≥ 17 and had never executed in
CI. Measured — `acldefault('r', owner)` yields 8 privileges including
`MAINTAIN` on 17 against 7 on 16, and the 122 suite derives its revoked-rights
set from `acldefault` rather than a spelled list, so that branch is now
genuinely asserted. `e2e.yml` moves in lockstep, and a new test pins both
files to the same major AND to 17 — equality alone would pass if both
regressed to 16 together.

### `scripts/ci/live-db-suites-audit.ts`

Additive only: seven entries appended to `MIGRATION_SHAPE_FILES`, each with a
comment naming its migration and what its degrade removes. **No rule, escape
hatch, threshold or detection path changed.** Adding an entry does not weaken
R2 — it records that applying the migration IS the subject for that file, and
the audit then ENFORCES that the file holds a cross-process lock. Seven files
newly subject to the lock check is a tightening, not a loosening. Verify with
`git diff` on that file: every changed line is inside the `Set` literal or a
comment.

### `vitest.config.ts`

A comment only. `postgres:16` → `postgres:17` in prose describing which service
CI stands up. No config value changes; the diff is two characters inside a `//`
line.

---

## Rows 9–10 · `suppression-added` — two `@ts-expect-error` directives

Both are in `src/lib/shared/__tests__/helpers/migration-guard.test.ts`, inside
the case `assertDegradeLanded cannot be called with an empty object list`.

**These are not suppressions. They ARE the assertion.**

A suppression hides a real error so a build passes. `@ts-expect-error` does the
opposite: it FAILS the build when the error stops existing. TypeScript reports
`TS2578: Unused '@ts-expect-error' directive` for a directive with nothing to
suppress. So the directive over
`{ table: 'reviews', property: 'indexes', absent: [] }` asserts that
`DegradeTarget` rejects an empty selector list, and it breaks the moment the
type widens back.

That is exactly how the hole was proven. With the case written and the type
still `readonly string[]`, `pnpm typecheck` failed with TS2578 — the empty
literal type-checked, so the directive had nothing to suppress. After
tightening the type to `readonly [string, ...string[]]`, the directive is
consumed and typecheck is clean.

**A runtime guard backs it up**, and both halves are load-bearing: the type
stops the mistake being written, and `assertDegradeLanded` throws on an empty
list to stop it being smuggled in by a cast or a JavaScript caller. The same
case asserts that throw.

**What this defends.** An empty selector list collapses the check to "the named
property changed somehow" — the contract a plan-review round rejected as F1
PARTIAL, because a degrade that dropped one of four indexes would satisfy it
while the other three were never challenged. Deviations D9 and D12 carry the
full history.

---

## The three genuinely retired assertion classes

Listed here so no reviewer has to hunt them.

1. **`migration-057`: `not.toMatch(/\bpurging\b/i)`** and
   **`not.toMatch(/NEXT_PUBLIC_/i)`** — text-vocabulary checks over a SQL file.
   Neither corresponds to any catalogue object, and a catalogue assertion cannot
   and should not claim to police arbitrary text in a file. Retired with this
   reason in the 057 header.

2. **`migration-053`: "runs the conversion exactly once"** — an occurrence count
   of `UPDATE users` in the file text. Replaced by something stronger: the suite
   applies 053 a SECOND time and asserts the catalogue does not move and no row
   changes, which exercises the already-present branch of the `DO` guard that a
   single apply never reaches.

3. **`migration-117`: one text case** whose four regexes all DO have catalogue
   equivalents, mapped assertion-by-assertion in that suite's header. Retired
   for approach, not for want of an oracle — notably the `REVOKE ALL` regex
   could not distinguish `REVOKE ALL` from `REVOKE SELECT`, which the executing
   case now does by deriving the privilege list from `acldefault`.

## What no longer has a guard anywhere

Nothing. Every assertion in the five deleted files either has a named successor
case or appears in the three retired classes above with a written reason.
