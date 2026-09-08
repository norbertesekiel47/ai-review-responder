# Red team — `feat/1182-admin-reset`, round 1

- fork `c2de39d879c92cc657941b36d0be330cd0c20abf`
- merge-base `c2de39d879c92cc657941b36d0be330cd0c20abf`
- head `ea534ae7bf206768bc113c2137565f94f19bd47a`
- risk `high` (intake `c019d0b6…`), mode `feature`
- baseline: `scripts/ci/__tests__/revoke-admin.test.ts` + `…integration.test.ts`,
  **30/30 green** under the isolated env (localhost test DB, scrubbed `.env.local`).
- 17 supervised runs of the 30-run budget. Every mutation restored; `git status --porcelain`
  empty apart from this directory.

## Severity table

| id | sev | title | at |
|---|---|---|---|
| RT-01 | **P0** | The revoke ban duration's VALUE is pinned by nothing — `'none'` passes all 30 tests | `scripts/revoke-admin.ts:166` |
| RT-02 | P1 | `probeBanState`'s ban predicate is executed by no test in either suite | `scripts/revoke-admin.ts:272` |
| RT-03 | P1 | The `?? false` default is unpinned, and its comment is false for `--restore` | `scripts/revoke-admin.ts:277-280` |
| RT-04 | P1 | `main()` is entirely uncovered — including the `assertMintTarget` call | `scripts/revoke-admin.ts:511` |
| RT-05 | P1 | The runbook's manual audit repair cannot be executed as written | `docs/runbooks/mint-admin.md:299` |
| RT-06 | P2 | Operator provenance can be dropped from the audit payload undetected | `scripts/revoke-admin.ts:405` |
| RT-07 | P2 | `lower(email)` can be dropped from the lookup undetected | `scripts/revoke-admin.ts:238` |
| RT-08 | P2 | `ALREADY REVOKED`/`ALREADY ACTIVE` can be swapped undetected | `scripts/revoke-admin.ts:475` |
| RT-09 | P2 | The unit suite commits the owner's real staging `auth_id` in full, which the roster masks | `scripts/ci/__tests__/revoke-admin.test.ts:190` |

---

## RT-01 (P0) — the revoke ban duration's value is pinned by nothing

`scripts/revoke-admin.ts:166`

```
REVOKE_BAN_DURATION = '876000h'  →  REVOKE_BAN_DURATION = 'none'
```

**Result: 30 passed, 0 failed.** A `--revoke` that sends GoTrue the documented
*lift* verb — i.e. a revoke that UNBANS — is green on the whole changed test
surface. The weaker mutant `'1h'` (a revoke the admin outlives by lunchtime)
also survives.

The test that claims to own this (`revoke-admin.test.ts:171-177`, "maps the
action onto Supabase's documented ban vocabulary") asserts
`expect(banDurationFor('revoke')).toBe(REVOKE_BAN_DURATION)` — a tautology over
the same symbol — and every other assertion in both suites spells the expected
`ban_duration` as `REVOKE_BAN_DURATION` too. The **restore** side IS literally
pinned (`expect(RESTORE_BAN_DURATION).toBe('none')`, line 175); the revoke side
is the one that was left out, and it is the security-relevant half.

`docs/runbooks/mint-admin.md:256` documents `'876000h'` to the operator. Nothing
holds the code to that number.

**Arbiter (required for a confirmed survivor).** Not equivalent: the mutated
constant is the entire content of the Auth-side state change, and the report the
operator reads (`REVOKED: … the Supabase Auth identity is banned`) is unchanged
by it, so the failure is silent by construction. Not an unexecuted branch: four
tests drive the `action === 'revoke'` arm through `banDurationFor` and assert on
`updateUserById`'s argument — they simply assert the mutated value.

**Fix:** one line beside the existing restore pin —
`expect(REVOKE_BAN_DURATION).toBe('876000h');`

## RT-02 (P1) — the ban-state predicate is executed by nothing

`scripts/revoke-admin.ts:272`

```
SELECT (banned_until IS NOT NULL AND banned_until > NOW()) AS banned
  →  SELECT (banned_until IS NULL) AS banned
```

**Result: 30 passed, 0 failed.** That inversion makes every un-banned admin read
as already banned, so a full reset reports `ALREADY REVOKED` for every identity,
writes nothing, exits `0`, and leaves every admin signed in. It is the exact
failure the reset exists to prevent, and it is invisible.

Neither suite can see it. The unit suite drives a mock `sql` and only ever
asserts `call.values` and `/^\s*SELECT/`, never this statement's text. The live
suite runs against a database that deliberately has no `auth.users` relation
(`scripts/ci/test-db-bootstrap.sql`), so `probeBanState` short-circuits on the
`to_regclass` guard and this query is never issued. The idempotency authority for
the whole script has no oracle anywhere.

Recorded as P1 rather than P0 because the shipped predicate is correct and no
test claims to cover it; it is an uncovered hunk, not a fake assertion. Closing
it needs a live-DB case that provisions a minimal `auth.users` fixture, or a
statement-text assertion in the unit suite.

## RT-03 (P1) — the `?? false` default is unpinned, and its comment is false for `--restore`

`scripts/revoke-admin.ts:277-280`

```
return { state: 'checked', banned: row?.banned ?? false };
  →  return { state: 'checked', banned: row?.banned ?? true };
```

**Result: 30 passed, 0 failed.** The unit harness always queues a probe row, so
the `??` never fires; the live suite never reaches the query at all.

The mutation is worth more than its own survival, because reading the branch it
covers exposes a comment that is wrong. Lines 277-279 say:

> No `auth.users` row for a linked `auth_id` is the half-2-only state. It is not
> "banned", so **the transition is attempted** and the Auth API reports the
> missing identity in its own vocabulary.

That is true for `revoke` and **false for `restore`**. With `banned === false`,
`alreadyInTargetState` (line 331) is TRUE for `action === 'restore'`, so the
function returns `unchanged` and the operator is told
`ALREADY ACTIVE: users.id=… is not banned; nothing written.` — for an identity
that does not exist and cannot sign in. `--restore` is the documented recovery
half of the reset (`mint-admin.md:270-272`, "Restoring is one command per
identity, so a reset is reversible end to end"), so this is the one direction
where a false "everything is fine" costs the most.

## RT-04 (P1) — `main()` is uncovered, including the production guard call

`scripts/revoke-admin.ts:503-535`

`main` is not exported and no test imports it, so nothing in either suite
executes: the `assertMintTarget(buildRevokeGuardInput(args, config,
databaseTarget))` call at line 511, the four exit codes (`EXIT_REFUSED`,
`EXIT_FAILED`, `EXIT_OK`, `EXIT_USAGE`), the print-before-anything-that-can-throw
ordering, the Postgres client options, or the `finally { sql.end() }`.

The docstring on `buildRevokeGuardInput` (lines 138-144) says the helper was
extracted precisely so a `allowProduction: true` mutant could not ship green —
and that half now works (mutating the field is killed by two tests). But the
extraction moved the untested seam one line outward rather than closing it:
**deleting line 511 entirely is invisible to the test surface**, and line 511 is
the only thing standing between `--env production` handling and an unguarded
write to the production project. Same class of gap the helper was extracted to
fix, one level up.

Inventory outcome `inconclusive` / class `oracle` — there is no covering
candidate to run.

## RT-05 (P1) — the runbook's manual audit repair is not executable

`docs/runbooks/mint-admin.md:294-302`

The `audit_failed` section instructs:

> Record one row by hand for that actor (`admin_revoked` or `admin_restored`,
> `entity_type='users'`, `entity_id` = the admin's `users.id`)

and supplies no SQL. `admin_audit_log.id` is `UUID PRIMARY KEY` with **no
DEFAULT** (`supabase/migrations/117_admin_audit_log.sql:50`; the migration header
states "Application code supplies UUIDv7 ids"), so the INSERT that sentence
describes fails immediately with a not-null violation on `id`. The operator hits
this on the one path that only ever fires *after* a security change has already
committed and the ledger is already wrong.

Precedent in the same file: §"Reconciling an uncertain run"
(`mint-admin.md:186-224`) hands the operator runnable SQL for every step,
including a `pg_stat_activity` probe. §"`FAILED: Supabase updateUserById failed`"
(lines 303-316) does the same. This one section breaks that pattern.

## RT-06 (P2) — operator provenance can be dropped from the audit payload

`scripts/revoke-admin.ts:405`. Deleting `operator: input.operator,` from the
`admin_audit_log` payload survives all 30 tests. The integration assertion
(`revoke-admin.integration.test.ts:167-173`) lists five payload keys and omits
`operator`. `describeOperator()` was newly exported from `mint-admin.ts` for this
script specifically so "both scripts record `provenance` the same way"; nothing
enforces that the value reaches the row.

## RT-07 (P2) — `lower(email)` can be dropped from the lookup

`scripts/revoke-admin.ts:238`. `WHERE lower(email) = ${email}` → `WHERE email =
${email}` survives all 30 tests (the live suite seeds an already-lowercase
address). `users.email` is a plain case-sensitive `VARCHAR(255) UNIQUE`
(`001_initial_schema.sql:47`) and the project's three other lookups all use
`lower(email)` (`mint-admin.ts:337`, `:363`, `provision-auth-user.ts:74`), so the
convention is real. Low likelihood only because both write paths lowercase first.

## RT-08 (P2) — the two `unchanged` operator messages can be swapped

`scripts/revoke-admin.ts:474-477`. Swapping `ALREADY REVOKED` and `ALREADY
ACTIVE` survives all 30 tests — no assertion covers either string. Both are
documented at `mint-admin.md:291-292`, and `ALREADY REVOKED` is specifically what
the runbook tells the operator to expect when confirming that the re-run after an
`audit_failed` was a no-op (`mint-admin.md:298-300`).

## RT-09 (P2) — the unit suite commits an identifier the roster deliberately masks

`scripts/ci/__tests__/revoke-admin.test.ts:189-190` hard-codes
`ADMIN_USER_ID`/`ADMIN_AUTH_ID` as the owner's real **staging** admin identity —
row 1 of `docs/superpowers/plans/feat-1182-admin-reset-roster.md:31`. The roster
masks the middle of that `auth_id` (`728769a7-…-40361d1c38ca`); the test file
commits it in full. Not a credential, but the two artifacts in the same PR
disagree about whether the value is publishable. Random UUIDs would carry the
same test value.

---

## Verified TRUE — recorded, no finding

- **The audit-ledger claim (`account_audit_log` is impossible for an admin) is
  CORRECT.** `account_audit_log.account_id UUID NOT NULL REFERENCES accounts(id)`
  (`034_multi_location_schema.sql:64`); admins carry NULL `account_id`
  (invariant #9), and `117_admin_audit_log.sql:6-17` states that as the reason
  117 exists. `writeAdminAuditLog` is the correct sink. Not a P0.
- **The no-delete / no-update safety claims hold in code, not only in comments.**
  `revoke-admin.ts` contains no `DELETE`, no `UPDATE`, and never references
  `auth.admin.deleteUser`; the only Postgres write in the module is the
  `writeAdminAuditLog` INSERT. The live suite's `to_jsonb(u)` before/after
  equality (`revoke-admin.integration.test.ts:229-243`) is a genuine oracle for
  it, and mutants against `entityType`/`entityId` and against the dry-run guard
  are both killed.
- **Production is unreachable without both controls.** Hard-coding
  `allowProduction: true` in `buildRevokeGuardInput` is killed by two tests.
  (The residual is RT-04: the guard's *call site* is uncovered.)
- **`scripts/mint-admin.ts` is an export-only change.** The diff is two
  `function` → `export function` keywords plus comments; no body, signature or
  behaviour edit. Claim verified.
- **Every `path:line` citation in the diff resolves at HEAD.**
  `src/proxy.ts:93` = the `mfaEnforcementEnabled()` call ✓ ·
  `src/proxy.ts:118-136` = exactly the admin-pages block ✓ ·
  `001_initial_schema.sql:107` = `onboarded_by UUID REFERENCES users(id)` ✓ ·
  `117_admin_audit_log.sql:51` = `actor_user_id UUID NOT NULL REFERENCES users(id)` ✓ ·
  `048` `impersonation_sessions.actor_user_id UUID NOT NULL` ✓ ·
  `014:135` actor column ✓. `prevalidate-plan.py` on the two plan docs: the
  deviations doc PASSES; the roster's 20 "stale commits" are admin UUID fragments
  matched as short SHAs — false positives, checked by hand.
- **`--restore` under `MFA_ENFORCEMENT_ENABLED=true` does not deadlock.** The
  report line claims a restored admin "enrols one if it has none";
  `src/proxy.ts:100-102` gates on `nextLevel === 'aal2'`, which is `aal1` for a
  factor-less user, so the gate answers `ok` and the enrolment path is reachable.
- **Duty 4 — no sibling admin-revocation path exists.** Searched, repo-wide,
  excluding `node_modules` and `docs/reviews/`:
  `auth.admin.(updateUserById|deleteUser|inviteUserByEmail|generateLink)`,
  `ban_duration`, `banned_until`, `DELETE FROM users`, `SET role`,
  `role = 'owner'`, and `revoke|remove|deactivate` within 25 chars of "admin"
  across `docs/` and `.claude/`. Every `deleteUser` hit is an **owner**-lifecycle
  path — `mint-admin.ts:374` (mint rollback), `provision-auth-user.ts:184`
  (orphan cleanup), `admin-onboarding-service.ts:388`,
  `purge-stages.ts:130` (account offboarding, account-scoped and therefore never
  an admin), plus `e2e/harness.ts` fixtures. Nothing else bans, disables or
  demotes an admin identity, and nothing this script does contradicts them. Sound
  search, zero siblings.
- **Duty 5 — no alert-path half is missing.** The diff adds no Sentry signal, no
  worker path and no poller; both terminal outcomes (`failed`, `audit_failed`)
  surface as printed operator output plus a non-zero exit from a hand-run CLI.
  No row in `docs/runbooks/beta-launch-alerting.md` is implicated in either
  direction. (The operational gap that IS real is RT-05, above.)
- **Not verified, out of scope for a read-only pass:** the `env-vars.md` claim
  that staging's `MFA_ENFORCEMENT_ENABLED` was set `true` at 2026-09-08T08:57:39Z
  and that production has no Vercel row — both are assertions about external
  provider state, and checking them was outside this pass's read-only remit.
  Also unverified: the runbook's "rotate the project's JWT secret" escape lever
  (`mint-admin.md:266-268`) is a claim about a Supabase dashboard capability, not
  about this repo.

## Fragile assertions (Duty 2)

One, and it is RT-01's root cause: `revoke-admin.test.ts:172`,
`expect(banDurationFor('revoke')).toBe(REVOKE_BAN_DURATION)` is a tautology —
both sides are the same import. Inside a test whose title promises to map the
action "onto Supabase's documented ban vocabulary", it reads as a value pin and
is not one. The behavioural replacement is the literal, exactly as line 175
already does for the restore side.

No absence-of-tag proxies, exact string counts, or order assertions without an
ordering contract were found in the changed tests.

## Authorizations

None.

## Inventory classification note

Seven mutants survived the full 30-test surface. Only RT-01's two (`M1`, `M1b`)
are recorded as `survived-confirmed-P0`; the schema binds that outcome to a P0
finding, and the other five sit below P0. They are recorded as
`inconclusive` / class `oracle` with their reasons, which is the honest bucket:
each survival is real and none is provably behaviour-preserving, but what the run
proved in those cases is that the ORACLE is missing, not that an assertion is
fake. `M9` and `M18` are the strongest of them — the statements they mutate are
executed by no test in either suite at all.

`git status --porcelain` at the end of the pass is empty apart from this
directory and the pre-existing `.feature/review-staging/` siblings.
