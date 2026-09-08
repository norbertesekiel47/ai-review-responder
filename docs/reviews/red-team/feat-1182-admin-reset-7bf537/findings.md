# Red team — `feat/1182-admin-reset`, round 2

Round 1's report is not lost: it is the content of these two files at
`git show 7170c02c:docs/reviews/red-team/feat-1182-admin-reset-7bf537/findings.md`.
This file replaces it at the slug the checker derives from the branch.

- fork `c2de39d879c92cc657941b36d0be330cd0c20abf`
- merge-base `c2de39d879c92cc657941b36d0be330cd0c20abf`
- head `7170c02cde39239e64a08949ac81574b49986b17`
- risk `high` (intake `c019d0b6…`), mode `feature`, round 2 of the hard cap of 2
- baseline: `scripts/ci/__tests__/revoke-admin.test.ts` (42) +
  `…integration.test.ts` (5), **47/47 green** under the isolated env
  (localhost test DB, scrubbed `.env.local`, temporary `HOME`).
- 18 supervised runs of the 30-run budget. Every mutation restored;
  `git status --porcelain` empty apart from this directory.
- Remit, per the loop rule: verify round 1's fixes, and hunt inside the fix
  hunks and their directly affected callers. No fronts opened on unchanged code
  (one adjacent P2 is recorded as out-of-remit and blocks nothing).

## Severity table

| id | sev | disposition | title | at |
|---|---|---|---|---|
| RT-01 | P0 | **fixed** | Revoke ban duration's value unpinned | `scripts/revoke-admin.ts:166` |
| RT-02 | P1 | **fixed** | Ban-state predicate executed by nothing | `scripts/revoke-admin.ts:272` |
| RT-03 | P1 | **fixed** | `?? false` default unpinned; comment false for `--restore` | `scripts/revoke-admin.ts:277-280` |
| RT-04 | P1 | **fixed** | `main()`'s `assertMintTarget` call uncovered | `scripts/revoke-admin.ts:511` |
| RT-05 | P1 | **fixed** | Runbook audit repair not executable | `docs/runbooks/mint-admin.md:299` |
| RT-06 | P2 | **fixed** | Operator provenance droppable | `scripts/revoke-admin.ts:405` |
| RT-07 | P2 | **fixed** | `lower(email)` droppable | `scripts/revoke-admin.ts:238` |
| RT-08 | P2 | **fixed** | `unchanged` messages swappable | `scripts/revoke-admin.ts:475` |
| RT-09 | P2 | **fixed** | Real staging identifier in fixtures | `scripts/ci/__tests__/revoke-admin.test.ts:190` |
| **RT2-01** | **P1** | open | The fix added a new column read into `probeBanState`'s still-untested statement; nulling `deleted_at` neutralises the new `auth_identity_deleted` refusal | `scripts/revoke-admin.ts:309-310` |
| **RT2-02** | **P1** | open | The 15s Auth timeout is pinned by nothing — deleting the whole `global.fetch` block passes all 47 | `scripts/revoke-admin.ts:656-660` |
| **RT2-03** | **P1** | open | Missed sibling case: the horizon fix pinned `--revoke` over a short ban and left `--restore` unpinned | `scripts/revoke-admin.ts:461-462` |
| RT2-04 | P2 | open | Unparseable `banned_until` → false `ALREADY ACTIVE` on `--restore` | `scripts/revoke-admin.ts:288-292` |
| RT2-05 | P2 | open | Dead assertion: `not.toMatch(/enrols one if it has none/)` | `scripts/ci/__tests__/revoke-admin.test.ts:695` |
| RT2-06 | P2 | open | `banProbe` pass-through unpinned (**pre-existing**, out of remit) | `scripts/revoke-admin.ts:466` |

Status **`INCOMPLETE_ORACLE`** — no open P0, and no P1 survives as a *proven
fake test*; four survivors are honest oracle gaps, and any one of them forces
that status.

---

# Part 1 — every round-1 finding, re-killed by mutation

The orchestrator's claim was "ten mutants re-run, all KILLED". I re-ran them
myself. **All ten are genuinely dead**, and each kill is a targeted assertion
failure, not an import or type error — the killing test titles are listed so the
kill can be audited rather than believed.

| mutant | mutation | result | killed by |
|---|---|---|---|
| M1 | `REVOKE_BAN_DURATION` → `'none'` | **3 failed** / 44 | vocabulary pin · short-ban re-apply · operator provenance |
| M1b | `REVOKE_BAN_DURATION` → `'1h'` | **3 failed** / 44 | same three |
| M2 | `bannedNow: … > now` → `<= now` | **4 failed** / 43 | 3 × `classifyBanState` · `restore lifts the ban…` |
| M3 | `present: row !== undefined` → `present: true` | **2 failed** / 45 | both `auth_identity_missing` refusal tests |
| M4 | drop `lower(email)` | **1 failed** | `lowercases and trims the email before the lookup` |
| M5 | drop `operator: input.operator,` | **1 failed** | `records the operator provenance on the audit row` |
| M6 | swap `ALREADY REVOKED` / `ALREADY ACTIVE` | **1 failed** | `names the right unchanged state for each direction` |
| M7 | delete the `assertMintTarget(…)` call | **2 failed** | both `resolveRevokeTarget` guard tests |
| M8 | `allowProduction: true` | **3 failed** | two guard tests + the new `resolveRevokeTarget` production test |
| M9 | `REVOKE_HORIZON_MS` → `0` | **2 failed** | `separates a short ban…` · `re-applies the revoke over a short pre-existing ban` |

Two more, run to characterise the boundary rather than because round 1 asked:

| mutant | mutation | result |
|---|---|---|
| M11 | `deletedAt: row?.deleted_at ?? null` → `deletedAt: null` | **1 failed** — the probe→classifier pass-through IS pinned |
| M14 | `if (!guard?.present)` → `if (guard?.present)` | **12 failed** — the `to_regclass` short-circuit is well covered |

**RT-05 was not a mutation, so it was executed instead.** The runbook's new
`INSERT INTO admin_audit_log … SELECT gen_random_uuid(), …` was run VERBATIM
against the local test database at migrations head, inside a transaction that
was rolled back:

```
INSERT 0 1
 event_type   | entity_type |  entity_id  | payload
 admin_revoked| users       | ad636b07-…  | {"action":"revoke","attribution":"bootstrap_self_actor",
                                            "ban_duration":"876000h","manual_recovery":true,…}
ROLLBACK
```

It runs. The cited `117_admin_audit_log.sql:50` resolves exactly to
`id            UUID PRIMARY KEY,`; the column list matches (`entity_id` is
`TEXT`, so `u.id::text` is right), there is no `event_type` CHECK to violate,
and `gen_random_uuid()` is built in on PostgreSQL 16. The payload is
shape-identical to the script's minus `operator`, plus `manual_recovery: true` —
a difference the doc states.

**RT-09 is closed for this branch.** Fixtures are synthetic
(`revoke-admin.test.ts:294-295`). For completeness: `rg '728769a7|40361d1c38ca'`
still finds the owner's full staging `auth_id` in four PRE-EXISTING docs from
earlier tickets (the 2026-08-04 MFA spec, plan and evidence files) alongside the
masked roster row. Outside this branch's diff; worth its own ticket if the
masking is meant to be repo-wide.

---

# Part 2 — the hypothesis the orchestrator flagged as most likely, tested and REFUTED

> "`Date.parse` on a Postgres `timestamptz::text` — note the SPACE separator and
> 6-digit microseconds. If it returns NaN the classifier silently reports 'not
> banned'."

**It does not return NaN.** Measured, not reasoned, and measured against real
Postgres output rather than the ISO fixtures the unit tests use. I built a real
`auth.users` inside the local test DB in a rolled-back transaction and drove the
actual `probeBanState` → `classifyBanState` pair:

```
DateStyle          : ISO, MDY
wire banned_until  : "2126-08-15 09:37:16.251644+00"      ← space separator, 6-digit µs
Date.parse         : 4942460236251                        ← finite
classification     : {present:true, deleted:false, bannedNow:true, bannedForFullTerm:true}   OK
short ban (1h)     : {bannedNow:true, bannedForFullTerm:false}                               OK
```

V8's date parser accepts the PostgreSQL rendering (`+00`, `+02`, `-05:30`, with
or without fractional seconds) and the repo pins Node `v24.15.0` in `.nvmrc`.
The classifier is correct on the real wire format in both directions.

**The residual is real but small, and it is RT2-04:** the one shape `Date.parse`
cannot read is `infinity` / `-infinity`, which the same experiment confirms is
returned as the literal string `"infinity"` and classified as *not banned*. See
RT2-04 below.

---

# Part 3 — NEW findings

## RT2-01 (P1) — the fix put a new column read into a statement no test executes

`scripts/revoke-admin.ts:309-310`

```
SELECT banned_until::text AS banned_until, deleted_at::text AS deleted_at
  →  SELECT banned_until::text AS banned_until, NULL::text AS deleted_at
```

**Result: 47 passed, 0 failed.** `deleted_at` is the sole input to
`state.deleted`, which is the sole gate on the brand-new `auth_identity_deleted`
refusal — the one the runbook now documents to operators in its refusal table.
The mutant deletes that refusal arm silently.

**Arbiter.** Not a proven-fake test, so not P0: *no test claims this statement*.
The unit suite replaces `sql` with a queue-backed double and never sees SQL
text; every live-DB suite short-circuits on the `to_regclass` guard, because
`scripts/ci/test-db-bootstrap.sql:53-57` provisions schema `auth` with
`auth.uid()` and **no `auth.users` relation**. This is an oracle gap.

RT-02 is genuinely fixed — the *decision* moved into `classifyBanState` and is
now killable. What is new is that the fix moved a second *fact* into the
still-unpinned half. The predicate is pinned; the read that feeds it is not, and
it now feeds one more refusal than it did in round 1.

**Second half, measured.** With the same throwaway `auth.users`, dropping the
column makes `probeBanState` throw:

```
no deleted_at col  : THROWS -> column "deleted_at" does not exist
```

Nothing in `revokeAdmin` or `main()` catches it — the run dies at `EXIT_FAILED`
with a raw Postgres message. `auth.users.deleted_at` has been a GoTrue column
since 2022 and both projects are modern, so this fails **loudly on an unlikely
target** rather than silently; it is still a new hard dependency on a second
auth-schema column that no repo fixture provisions and no test pins.

**Closing it:** a unit case that asserts the probe's statement text mentions
both columns (the same technique the RT-07 fix already uses at
`revoke-admin.test.ts:617`), or a live-DB case that provisions a minimal
`auth.users` fixture.

## RT2-02 (P1) — the 15s Auth timeout is pinned by nothing

`scripts/revoke-admin.ts:656-660`

Deleting the entire block —

```ts
global: {
  fetch: (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS) }),
},
```

— gives **47 passed, 0 failed**. `rg AUTH_REQUEST_TIMEOUT_MS scripts/` returns
three hits, all inside the production file: the constant is exported and nothing
consumes it. `main()` is not exported and no test imports it, so this is an
unexecuted branch (oracle, not P0) — but the spec reviewer's fix can be deleted
in any later edit and ship green, and the failure it prevents is a CLI that
hangs forever in the middle of a revoke.

**The bound itself is correct where it runs — four things checked against the
installed tree, since the orchestrator asked:**

1. **It reaches the Auth admin API.** `supabase-js@2.106.2` forwards
   `settings.global.fetch` into `_initSupabaseAuthClient`
   (`dist/index.mjs:656`, `:803`, `:822`), so `auth.admin.updateUserById` uses it.
2. **15s is per-REQUEST, not per-client-lifetime.** `AbortSignal.timeout(…)` is
   constructed inside the arrow function, so every call gets a fresh signal.
3. **It cannot hang the CLI.** Node's timeout signal timer is unref'd —
   confirmed by running a process that creates one and exits immediately.
4. **It clobbers nothing.** `auth-js@2.106.2` never sets its own `signal`
   (`dist/main/lib/fetch.js:117` spreads `requestParams` only), so
   `{ ...init, signal }` overrides no caller intent.

**Closing it:** export the client factory from `main()` (the same extraction that
closed RT-04 for the guard) and assert that a stalled `fetch` aborts inside
`AUTH_REQUEST_TIMEOUT_MS`.

## RT2-03 (P1) — missed sibling case: `--restore` has no short-ban case

`scripts/revoke-admin.ts:461-462`

```ts
const alreadyInTargetState =
  action === 'revoke' ? state.bannedForFullTerm : !state.bannedNow;
//                                               ↑ mutate to !state.bannedForFullTerm
```

**Result: 47 passed, 0 failed.**

The horizon fix added exactly the right test for one direction —
`re-applies the revoke over a short pre-existing ban` — and no mirror for the
other. `queuePreflight` offers only two ban shapes, `null` and a 100-year ban,
and the two predicates agree on both, so the restore arm is decided by nothing.

**Arbiter.** The branch IS executed by both restore tests, but no fixture
discriminates, which makes this plausibly-equivalent-under-the-tested-inputs and
therefore `inconclusive`/`oracle`, not a P0. The shipped predicate is correct.
What the mutant buys is the RT-03 shape in the direction the production plan
actually runs: a `--restore` over a live ban shorter than 365 days would print
`ALREADY ACTIVE: users.id=… is not banned; nothing written.` and exit `0` while
the admin is still locked out.

**Closing it:** one fixture — queue a ban inside `REVOKE_HORIZON_MS` and assert
a `--restore` still calls `updateUserById` with `RESTORE_BAN_DURATION`.

## RT2-04 (P2) — an unparseable `banned_until` is a false `ALREADY ACTIVE`

`scripts/revoke-admin.ts:288-292`. Measured against real Postgres (see Part 2):
`banned_until = 'infinity'` renders as the literal `"infinity"`, `Date.parse`
gives `NaN`, and the classifier returns
`{bannedNow: false, bannedForFullTerm: false}`.

For `--revoke` that is fail-safe — the ban is simply re-applied. For `--restore`
it makes `alreadyInTargetState` true, so an identity banned FOREVER is reported
`ALREADY ACTIVE … is not banned; nothing written` with exit `0`. Held at **P2**
because GoTrue always writes a finite `now + duration`; only hand-editing
`auth.users` produces it. Worth recording because the test at
`revoke-admin.test.ts:239-243` *pins* the collapse — the asymmetry is deliberate
for one direction and simply was not considered for the other.

## RT2-05 (P2, Duty 2) — a dead assertion in the new restore-wording test

`scripts/ci/__tests__/revoke-admin.test.ts:695`

```ts
expect(report).not.toMatch(/enrols one if it has none/);
```

This pins one *deleted sentence*. It can never fail again, and it cannot catch
the same false claim reworded. The behavioural content of the test is its
positive half, `toMatch(/must\s+enrol manually at \/admin\/security/)`, which is
real and which resolves: `src/app/admin/security/page.tsx` exists, and ADR 0025
§ Consequences does say the lenient form passes an unenrolled user at `aal1`.

**Behavioural replacement:** assert the report promises no automatic prompt at
all, or drop the line and let the positive assertion carry it.

## RT2-06 (P2) — `banProbe` pass-through unpinned (pre-existing, out of remit)

`scripts/revoke-admin.ts:466`. `banProbe: probe.state` → `banProbe: 'checked'`
passes all 47: the only dry-run fixture has a readable `auth.users`, and the
`warns when a dry run could not read the ban state` test constructs the result
value directly instead of going through `revokeAdmin`. A `--dry-run` against a
target whose `auth.users` cannot be read would claim it checked the ban state.
`git diff ea534ae7 7170c02c -- scripts/revoke-admin.ts` shows this line
unchanged since round 1, so it is recorded rather than charged against this
round, at P2 so it blocks nothing.

---

# Part 3b — new-refusal blast radius: can a legitimate admin now be refused?

The orchestrator's question, answered by experiment rather than by reading.

- **`auth_identity_missing` on a case-mismatched `auth_id`: real, unreachable.**
  `users.auth_id` is `VARCHAR(255)` (`001_initial_schema.sql:53`), not `UUID`,
  and the probe compares `auth.users.id::text = ${authId}` — which renders
  canonical lowercase. Measured: an uppercase `auth_id` returns
  `{present:false}` and would now REFUSE a live admin, where round 1's code
  would have proceeded and GoTrue would have banned them. Unreachable in
  practice: every write site takes Supabase's own lowercase id, and
  `mint-admin.ts:413`/`:601` already compare `auth_id` exactly, so the whole
  codebase assumes canonical casing. Fail-closed either way. **No finding.**
- **`auth_identity_missing` on a non-UUID `auth_id`: safe.** The `::text`
  comparison means garbage does not raise a cast error; it simply matches
  nothing and refuses with a message that names the value. Correct.
- **`auth_identity_deleted`: safe.** `deleted_at` is NULL for every live GoTrue
  identity; only a soft-deleted one, which cannot sign in either way, trips it.

---

# Verified TRUE — recorded, no finding

- **`resolveRevokeTarget`'s guard is on the only path that produces a
  description.** There is no arm that returns a `RevokeTargetDescription`
  without having called `assertMintTarget`, and `main()` is the sole production
  caller. M7 and M8 both die.
- **Every `path:line` claim added since round 1 resolves at HEAD.**
  `prevalidate-plan.py` → **PASS** on all three changed docs
  (`mint-admin.md` 3 citations, the deviations doc, `triage.md` 2 citations),
  and by hand: `117_admin_audit_log.sql:50` = `id UUID PRIMARY KEY,` ✓ ·
  `mint-admin.ts:800-802` = the "printed BEFORE the first write … formatMintReport
  repeats it" comment + the `console.log` ✓ · `test-db-bootstrap.sql` really does
  provision `auth` + `auth.uid()` and no `auth.users` ✓ · ADR 0025 § Consequences
  really does say the lenient form passes an unenrolled user ✓ ·
  `/admin/security` really exists ✓.
- **Deviation D7's own claims are true.** "42 unit + 5 live-DB tests" — measured
  exactly 42 + 5. "All ten mutants now fail the suite" — independently
  reproduced, all ten. No false doc claim was found anywhere in the diff since
  round 1.
- **Duty 4 — sibling search.** Repo-wide, excluding `node_modules` and
  `docs/reviews/`: `AUTH_REQUEST_TIMEOUT_MS`, `AbortSignal`, `global: {`,
  `auth.users`, `deleted_at`, `to_regclass`, `Date.parse` on a DB value, and
  every `auth_id` write site. Two results. (a) `scripts/mint-admin.ts` has the
  same unbounded-Auth-call shape and the same `to_regclass`-guarded probe; the
  triage already records leaving it alone, and it is outside this branch's
  surface. (b) Nothing else in the repo reads `auth.users.deleted_at` or parses
  a DB timestamp with `Date.parse`. One in-scope sibling found and reported:
  RT2-03.
- **Duty 5 — no alert-path half is missing.** Unchanged from round 1: the diff
  adds no Sentry signal, no worker path and no poller; both terminal outcomes
  (`failed`, `audit_failed`) surface as printed output plus a non-zero exit from
  a hand-run CLI, and no row in `docs/runbooks/beta-launch-alerting.md` is
  implicated in either direction. The operational gap that IS real is RT2-01's
  second half — a target without `auth.users.deleted_at` kills the run with a
  raw Postgres message and no runbook row.
- **Not verified, out of scope for a read-only local pass:** the code comment
  claiming GoTrue omits `banned_until` from the admin API's JSON when null
  ("probed against the staging project on 2026-09-08"), and the `env-vars.md`
  claims about staging's `MFA_ENFORCEMENT_ENABLED` and production's missing
  Vercel row. All three are assertions about external provider state; this pass
  touched neither staging nor production.

## Fragile assertions (Duty 2)

One: RT2-05. Two more were examined and **cleared**:

- `expect(harness.sqlCalls[0]?.text).toMatch(/lower\(email\)/i)` — an assertion
  on statement text, which *is* structure, but it is the only oracle a mocked
  `sql` can give for a column-side predicate, it fails exactly when the
  behaviour is lost, and the test's own comment says why. Keep it.
- `expect(revoked).not.toMatch(/ALREADY ACTIVE/)` and its mirror — not an
  absence proxy: each direction is asserted positively AND negatively, which is
  what makes the swap unkillable-no-longer. Keep them.

## Authorizations

None. Three open P1s on a high-risk run; at the round cap these require user
adjudication.

## Inventory classification note

Nothing survived as a **proven fake test**, which is why round 2 has no P0. The
four survivors split into two honest shapes, and the schema's distinction
matters here:

- **Unexecuted** (M10, M12) — no test reaches the line at all.
- **Executed but undiscriminated** (M13, M15) — the branch runs, but every
  fixture makes both variants agree.

Both are claims about the ORACLE, not about the mutant, so all four are
`inconclusive` / class `oracle`, and any one of them forces `INCOMPLETE_ORACLE`.
One row is `equivalent` with its proof (M16: dropping `Number.isFinite` cannot
change behaviour, because `NaN > x` is false for every `x`) — a claim about the
MUTANT, which does not block.

`git status --porcelain` at the end of the pass is empty apart from this
directory.
