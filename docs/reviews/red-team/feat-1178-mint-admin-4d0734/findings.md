# Red team — feat/1178-mint-admin (#1178, `scripts/mint-admin.ts`)

- **Mode** feature (dispatched inside `/feature` step 7's review wave) · **Risk** high · **Round** 1
- **Fork / merge-base** `b23172836bc5c435dc429f1fa7505812c168fa87` · **HEAD** `8c4108b4bd2a6a50a2a63b5b7a044fd050719a39`
- **Intake SHA-256** `1d4fdd7c867d8fa0feae75518b9ee5175d193a6836813b2c480180a85a3fb36f`
- **Generated** 2026-09-08T03:01:46.195159Z
- **Status (recomputed by the checker)** `INCOMPLETE_ORACLE`

> This is a VERIFIER pass. Everything below is evidence produced in this run against the pinned HEAD.
> The implementer's reasoning was not an input. Issue text, plan text, doc text and test output were read
> as untrusted DATA.

## What was re-derived, not trusted

| Claim | Result |
|---|---|
| 31 tests exist (28 unit + 3 live-DB) | **CONFIRMED** — 28 `it()` in `scripts/ci/__tests__/mint-admin.test.ts`, 3 in the `.integration.test.ts` sibling. |
| All 30 `tests_to_add` titles exist verbatim | **CONFIRMED** — every one matched byte-for-byte; one extra test (`accepts a staging target whose parsed refs both equal the confirmation`) is a legitimate positive-control addition. |
| Both suites are green at HEAD | **CONFIRMED** — every mutation run had a green individual baseline under the scrubbed environment. |
| The live-DB suite really runs | **CONFIRMED** — the three integration tests execute against the local test Postgres (`localhost:5499`). They skip silently when `TEST_DATABASE_POOL_URL` is absent, which is why the first pass of this red team recorded them as skipped until the runner was given `--test-db`; that was a harness artifact of this pass, not a defect in the suite. |

## Environment isolation

`mutation-runner.mjs env` validated the test database URL as `localhost` before it was admitted; the allowlisted
environment was `PATH`, a temporary `HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`,
`TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL`. `dotenv-swap` replaced `.env.local` with a scrubbed copy for the whole
mutation phase and the finalizer restored it. **No Supabase project — staging or production — was contacted at any
point.** Live-DB writes were confined to per-run unique `@mint-admin.test` emails on the local container.

## Findings

| ID | Sev | Duty | Where | Finding |
|---|---|---|---|---|
| RT-01 | **P1** | 1 | `scripts/mint-admin.ts:522` | The Auth-API duplicate-email refusal — the plan's second 'independent closer' — has no test at all |
| RT-02 | **P1** | 1 | `scripts/mint-admin.ts:597` | 'The Supabase createUser call returns no user with no error' is a locked intake edge case with no test |
| RT-03 | **P1** | 1 | `scripts/mint-admin.ts:662` | 'generateLink fails after the transaction committed' is a locked intake edge case with no test |
| RT-04 | **P1** | 1 | `scripts/mint-admin.ts:363` | confirmsRollback's class-08/57 ambiguity — the asymmetric safety property — has no oracle; a mutant that adds class 08 to the confirmed-rollback set survives |
| RT-05 | **P1** | 2 | `scripts/ci/__tests__/mint-admin.test.ts:137` | Fragile assertion: 'refuses a confirmed ref that is not a full Supabase project ref' asserts only that something throws |
| RT-06 | **P1** | 2 | `scripts/ci/__tests__/mint-admin.test.ts:544` | Fragile assertion: `inTransaction` is a time-window flag, not a connection identity, so the audit write can leave the transaction undetected |
| RT-07 | **P1** | 4 | `scripts/mint-admin.ts:207` | Two documented target-parser behaviours are unreachable by any test: the direct `db.<ref>.` form and the unparseable-target refusal |
| RT-08 | **P2** | 1 | `scripts/mint-admin.ts:149` | readMintConfig, requireValue and the --env validation throw are entirely untested |
| RT-09 | **P2** | 5 | `scripts/mint-admin.ts:707` | Only the `minted` arm of formatMintReport is ever rendered; the operator-facing warning lines are unasserted |
| RT-10 | **P1** | 3 | `docs/superpowers/plans/feat-1178-mint-admin-plan.md:21` | Plan §1 cites `staging-guard.ts:65,76` as 'the includes() test'; :76 is an equality test and the includes() is at :82 |
| RT-11 | **P2** | 5 | `docs/runbooks/mint-admin.md:103` | The runbook documents no exit codes, and omits the two createUser FAILED outputs from its refusal table |

### RT-01 — P1 — The Auth-API duplicate-email refusal — the plan's second 'independent closer' — has no test at all

**Where** `scripts/mint-admin.ts:522` · **Duty** 1 · **Disposition** `open`

plan §2 row (c′) and intake edge_cases both present TWO independent closers for the half-succeeded hand process: the read-only auth.users probe, and auth.admin.createUser's own duplicate-email error. Only the probe is tested. isDuplicateEmailError (:522-527) and the entire `created.error` arm (:581-595) are 0-covered — no test double ever returns an error from createUser. This matters most on the target the runbook actually names: the local and CI databases have no auth.users relation, so the probe reports `unavailable` and the createUser classifier is the ONLY closer left. Fix: one unit test per arm (code 'email_exists', status 422, an 'already registered' message, and a non-duplicate error -> status 'failed').

*Arbiter reasoning.* Not mutation-derived: an uncovered production hunk with no covering candidate is a P1 by Step 2. Verified by reading both suites and by an istanbul coverage run of mint-admin.ts at HEAD under both suites.

### RT-02 — P1 — 'The Supabase createUser call returns no user with no error' is a locked intake edge case with no test

**Where** `scripts/mint-admin.ts:597` · **Duty** 1 · **Disposition** `open`

intake edge_cases names it verbatim ('treated as a failure, not as a mint'). mint-admin.ts:597-604 is 0-covered. The sibling it copies, provision-auth-user.ts:67, exists precisely because hosted Supabase Auth does return { error: null, user: null }. Fix: one test asserting status 'failed' with orphanAuthId null.

*Arbiter reasoning.* Uncovered change, coverage-verified at HEAD.

### RT-03 — P1 — 'generateLink fails after the transaction committed' is a locked intake edge case with no test

**Where** `scripts/mint-admin.ts:662` · **Duty** 1 · **Disposition** `open`

intake edge_cases: 'the mint stands and the script tells the operator to re-issue a recovery link rather than re-mint'. mint-admin.ts:664-674 is 0-covered — every double returns a hashed_token. This is the arm that must return status 'minted' with recoveryUrl null; a regression that returned 'failed' here would tell an operator to re-run a script that already committed. Fix: one test with generateLink -> { error } and one with a missing hashed_token.

*Arbiter reasoning.* Uncovered change, coverage-verified at HEAD.

### RT-04 — P1 — confirmsRollback's class-08/57 ambiguity — the asymmetric safety property — has no oracle; a mutant that adds class 08 to the confirmed-rollback set survives

**Where** `scripts/mint-admin.ts:363` · **Duty** 1 · **Disposition** `open`

intake edge_cases defines the ambiguous set as 'no SQLSTATE, or class 08 / 57'. The one test named for that edge case ('preserves the auth user when the transaction outcome is ambiguous') injects a code-less Error, so it exercises only the first third. Mutating CONFIRMED_ROLLBACK_SQLSTATE to /^(08|22|23|42)\d{3}$/ survives the whole suite. The regression it would let through is the exact failure the design forbids: an 08007 transaction_resolution_unknown would confirm a rollback and delete the Auth identity behind a users row that committed. Fix: two tests — pgError('08007') and pgError('57014'), each with an empty reconciliation read, asserting deleteUser NOT called.

*Arbiter reasoning.* Mutation M1 survived. It is not executed on the candidate test's path (the injected error carries no `code`), so the inventory row is inconclusive/oracle rather than a confirmed survivor — a claim about the oracle. Not raised as P0 because the production code at HEAD is CORRECT; what is missing is the assertion that keeps it correct.

### RT-05 — P1 — Fragile assertion: 'refuses a confirmed ref that is not a full Supabase project ref' asserts only that something throws

**Where** `scripts/ci/__tests__/mint-admin.test.ts:137` · **Duty** 2 · **Disposition** `open`

The loop probes 'supabase', an 8-char slice and '' against a bare `.toThrow()` with no matcher. Every one of those is ALSO refused by the exact-equality checks at mint-admin.ts:261/:269, so the test passes whether or not the PROJECT_REF_PATTERN guard exists at all — proved by mutating all three `{20}` quantifiers to `{16,}` and watching it stay green. Behavioural replacement: assert the message the guard owns, `.toThrow(/must be a complete Supabase project ref/)`, and add a 19-char probe so the length contract is actually exercised.

*Arbiter reasoning.* Mutation M3 survived on an executed line. Archetype 1 (a proxy assertion that passes while the bug exists).

### RT-06 — P1 — Fragile assertion: `inTransaction` is a time-window flag, not a connection identity, so the audit write can leave the transaction undetected

**Where** `scripts/ci/__tests__/mint-admin.test.ts:544` · **Duty** 2 · **Disposition** `open`

mock-sql stamps `inTransaction: isInTransaction()` (worker/__tests__/helpers/mock-sql.ts:134) — a module-level flag set for the duration of begin(). Any query issued during the callback is stamped true, including one issued on the OUTER sql handle. Mutating `writeAdminAuditLog(tx, …)` to `writeAdminAuditLog(sql, …)` — a real defect that would put the audit row on a separate pooled connection outside the transaction — leaves this test green. The test's own comment ('In the SAME transaction as the users INSERT') claims more than the assertion proves. Mitigating: the live-DB sibling ('commits the users row and its admin_audit_log row in one transaction') DOES kill the same mutant, so no coverage is lost; the remedy is to assert the tag identity (or to retitle the comment and point it at the live-DB suite as the real oracle).

*Arbiter reasoning.* Mutation M12 survived the unit candidate and was killed by the integration candidate. The row is inconclusive/oracle rather than survived-confirmed-P0 precisely because the property IS covered elsewhere.

### RT-07 — P1 — Two documented target-parser behaviours are unreachable by any test: the direct `db.<ref>.` form and the unparseable-target refusal

**Where** `scripts/mint-admin.ts:207` · **Duty** 4 · **Disposition** `open`

refFromDatabaseTarget's JSDoc promises both forms — `db.<ref>.…` direct and `postgres.<ref>@…` pooler — and assertMintTarget's JSDoc promises 'an unparseable target is a refusal'. Coverage at HEAD: mint-admin.ts:208 (the direct branch) and :194 (refFromSupabaseUrl's invalid-URL return) never execute; every test uses a well-formed pooler descriptor with a 20-char ref. A regression that made either parser return the confirmRef instead of null would ship green. Fix: one test per form, plus one asserting a garbage dbTarget is refused with '(unparseable)' in the message.

*Arbiter reasoning.* Sibling hunt (Duty 4) over the guard's own documented input shapes, confirmed against the coverage run.

### RT-08 — P2 — readMintConfig, requireValue and the --env validation throw are entirely untested

**Where** `scripts/mint-admin.ts:149` · **Duty** 1 · **Disposition** `open`

resolveMintEnv (the pure mapping) is tested; readMintConfig — which selects .env.local vs .env.staging.local, raises the missing-file refusal (:163-167) and the four missing-variable refusals (:151-155) — is 0-covered, as is parseMintAdminArgs's `--env must be local or staging` throw (:100). P2 rather than P1: it is near-glue over a tested pure core, and a misconfiguration fails loudly on the operator's first invocation.

### RT-09 — P2 — Only the `minted` arm of formatMintReport is ever rendered; the operator-facing warning lines are unasserted

**Where** `scripts/mint-admin.ts:707` · **Duty** 5 · **Disposition** `open`

The 'Orphaned Supabase Auth identity: <id>' line (:734, :740), the dry-run 'auth.users is not readable' WARNING (:709-713) and the 'mint COMMITTED but the recovery link could not be generated' WARNING (:725-728) are all 0-covered — yet each is the ONLY channel by which the operator learns something the runbook then tells them to act on. deleteOrphanAuthUser's catch arm (:425-427) is likewise 0-covered. Operational note: the alert path itself is sound — this is an operator-run CLI with no Sentry signal and no rule row in beta-launch-alerting.md, and none is required; every terminal path is reported to stdout and mapped to a non-zero exit.

### RT-10 — P1 — Plan §1 cites `staging-guard.ts:65,76` as 'the includes() test'; :76 is an equality test and the includes() is at :82

**Where** `docs/superpowers/plans/feat-1178-mint-admin-plan.md:21` · **Duty** 3 · **Disposition** `open`

Re-resolved against HEAD: staging-guard.ts:65 is `const ref = confirmRef.trim().toLowerCase();` and :76 is `if (ref !== KNOWN_STAGING_REF)` — an EQUALITY test whose own JSDoc at :54-55 says 'the confirmed ref must EQUAL the known staging ref'. The `includes()` the plan means is at :82 (`if (!target.includes(ref))`), with a sibling at :126. The substantive comparison the plan draws is TRUE — assertMintTarget is stricter, because it parses the ref out of each half and requires equality where staging-guard only requires substring PRESENCE in the raw target — so this is a wrong pointer, not a false design claim. Fix: cite :82 (and :126).

*Arbiter reasoning.* P1, not P0: the claim the citation supports is verifiable and correct at :82; only the line numbers mislead. Every other path:line in the changed docs re-resolved cleanly at HEAD — 29 citations checked by hand (prevalidate-plan.py exists but is plan-shaped, so citations were resolved directly against HEAD).

### RT-11 — P2 — The runbook documents no exit codes, and omits the two createUser FAILED outputs from its refusal table

**Where** `docs/runbooks/mint-admin.md:103` · **Duty** 5 · **Disposition** `open`

The script maps outcomes to 0 / 2 (usage) / 3 (refused) / 4 (failed) at mint-admin.ts:748-751, which is the only signal a wrapper or a runbook step can branch on, and no doc records them. The 'Refusals, and what each one means' table also omits `FAILED: Supabase createUser failed: …` and `Supabase createUser returned no user and no error`. Everything else in the runbook re-resolved correctly, including both § headings the script points operators at.

## Duty 1 — hand-mutation

Seven distinct semantic mutations, nine scored candidate rows, 22 supervised runs of the 30-run round budget.
Every mutation was applied through the journaled `mutate` command and restored by `finalize`.

| Mutation | Line | Candidate test | Outcome |
|---|---|---|---|
| M1 `/^(22\|23\|42)\d{3}$/` → `/^(08\|22\|23\|42)\d{3}$/` | 363 | preserves the auth user when the transaction outcome is ambiguous | **survived** (inconclusive/oracle → RT-04) |
| M3 every `[a-z0-9]{20}` → `[a-z0-9]{16,}` | 186, 207, 209 | refuses a confirmed ref that is not a full Supabase project ref | **survived** (inconclusive/oracle → RT-05) |
| M6 users INSERT reordered after the audit write | 631–649 | commits the users row and its admin_audit_log row in one transaction | **killed** |
| M8 `if (input.dryRun)` → `if (false && …)` | 565 | dry run performs the refusal checks and writes nothing | **killed** |
| M9 `password: randomUUID()` added to `createUser` | 580 | never prints a password | **killed** |
| M10 `linked?.id === userId` → `linked` | 472 | treats a reconciled row with a different id as a failure, not a mint | **killed** |
| M11 `if (linked)` → `if (linked && !refusal)` | 477 | auth_id_taken returns refused without deleting the linked auth identity | **killed** |
| M12 `writeAdminAuditLog(tx, …)` → `(sql, …)` | 643 | records the mint … as its own actor **(unit)** | **survived** (inconclusive/oracle → RT-06) |
| M12 (same mutant) | 643 | commits the users row and its admin_audit_log row in one transaction **(live DB)** | **killed** |

**What this establishes.** The reconciliation core is genuinely asserted: row identity, the refusal-preserves-a-
linked-identity rule, the dry-run early return, the no-password property, and — on the live schema — the
single-transaction and users-INSERT-first properties all have real oracles. What is NOT asserted is the ambiguity
classification for the two SQLSTATE classes the intake names (RT-04) and the project-ref length contract (RT-05).

## Duty 2 — fragile assertions

Two, both proved by a surviving mutant rather than asserted by inspection: **RT-05** (a bare `.toThrow()` that cannot
attribute the refusal to the guard it is named for) and **RT-06** (`inTransaction` is a time-window flag, so a query
issued on the outer `sql` handle inside `begin()` is stamped as in-transaction). No exact-string-count assertions and
no order assertions without an ordering contract were found; `expect(Object.keys(createArgs).sort()).toEqual([…])` in
'never prints a password' is an intentional exact-set assertion and is the RIGHT shape — it fails on any added
credential-shaped field, which `not.toContain` would not.

## Duty 3 — docs vs reality

`prevalidate-plan.py` is present but is shaped for a plan-under-construction, so every `path:line` in the changed
docs and in the new source comments was re-resolved directly against HEAD — 29 citations across
`docs/runbooks/mint-admin.md`, the four `docs/superpowers/plans/feat-1178-*` files, the `.claude/reference/
arch-review-log.md` hunk and `scripts/mint-admin.ts` itself.

One finding: **RT-10**. Everything else resolved, including the ranged citations
(`117_admin_audit_log.sql:32-35,51`, `provision-auth-user.ts:67-77,135-160`, `e2e/harness.ts:118-142`,
`ws8-staging-smoke.ts:88-104`, `mfa-factor-reset.md:150-180`, `diff-coverage.ts:6-8`,
`admin-onboarding-service.ts:252/:286/:335`, `001_initial_schema.sql:45-57`, `039:51`, `053:29-30`).
Both runbook `§` headings the script points operators at (`§ Reconciling an uncertain run`,
`§ An Auth identity with no users row`) exist and say what the code claims they say. The arch-review-log entry's
three design points match the implementation, and its "31 tests (28 unit + 3 live-DB)" count is exact.

## Duty 4 — missed sibling cases

| Pattern searched | Scope | Exclusions | Result |
|---|---|---|---|
| `INSERT INTO admin_audit_log` | whole repo | `node_modules`, `*.test.ts`, `supabase/migrations/` | **1 hit, and it is the sanctioned writer** `src/lib/audit/log.ts:82`. Invariant "never a raw INSERT" holds; no sibling. |
| `auth\.admin\.createUser` | whole repo | `node_modules` | 4 hits: `scripts/mint-admin.ts:576` and three in `e2e/harness.ts` (93, 108, 182). The harness is a test fixture the intake names as an existing pattern and puts in `non_goals`; no production sibling mints an admin outside a transaction. |
| `INSERT INTO users (id, name, email, role, auth_id, account_id)` | whole repo | `node_modules` | `e2e/harness.ts:118`, `e2e/seed.ts:134`, both test-only. No production sibling. |
| `target.includes(ref)` confirm-ref guards | `scripts/`, `src/`, `worker/` | `node_modules` | `staging-guard.ts:82` and `:126`. Not a defect in this diff — but they are the lines the plan meant to cite (**RT-10**). |
| Documented-but-unreached input shapes of the new parsers | `scripts/mint-admin.ts` | — | **2 found: RT-07.** |

Three of the five searches returned zero actionable siblings. That is recorded as a result, not padded.

## Duty 5 — operational completeness

Scope check: this diff adds no worker, no poller, no Sentry signal and no tag, so there is no half of an alert path
to be missing, and `docs/runbooks/beta-launch-alerting.md` correctly gains no rule row. Every terminal path is
operator-visible on stdout and mapped to a non-zero exit, and the runbook documents a resolution procedure for each
refusal and for the orphaned-identity case. Two gaps, both P2: the exit codes are undocumented and two `FAILED`
outputs are missing from the refusal table (**RT-11**), and the warning lines themselves are unasserted (**RT-09**).

## Inventory

| ID | Candidate | File | Outcome | Class | Finding |
|---|---|---|---|---|---|
| IV-01 | preserves the auth user when the transaction outcome is ambiguous | `scripts/ci/__tests__/mint-admin.test.ts` | `inconclusive` | oracle | RT-04 |
| IV-02 | refuses a confirmed ref that is not a full Supabase project ref | `scripts/ci/__tests__/mint-admin.test.ts` | `inconclusive` | oracle | RT-05 |
| IV-03 | dry run performs the refusal checks and writes nothing | `scripts/ci/__tests__/mint-admin.test.ts` | `killed` | — | — |
| IV-04 | never prints a password | `scripts/ci/__tests__/mint-admin.test.ts` | `killed` | — | — |
| IV-05 | treats a reconciled row with a different id as a failure, not a mint | `scripts/ci/__tests__/mint-admin.test.ts` | `killed` | — | — |
| IV-06 | auth_id_taken returns refused without deleting the linked auth identity | `scripts/ci/__tests__/mint-admin.test.ts` | `killed` | — | — |
| IV-07 | records the mint through writeAdminAuditLog with the new admin as its own actor | `scripts/ci/__tests__/mint-admin.test.ts` | `inconclusive` | oracle | RT-06 |
| IV-08 | commits the users row and its admin_audit_log row in one transaction | `scripts/ci/__tests__/mint-admin.integration.test.ts` | `killed` | — | — |
| IV-09 | parses email, name and the dry-run flag | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-10 | lowercases and trims the email before use | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-11 | refuses when --confirm-ref is missing | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-12 | refuses when --email or --name is missing | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-13 | refuses when the Supabase host does not contain the confirmed project ref | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-14 | refuses when the database target does not contain the confirmed project ref | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-15 | refuses a production project ref outright | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-16 | accepts a staging target whose parsed refs both equal the confirmation | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-17 | maps STAGING_-prefixed variables onto their bare names | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-18 | falls back to STAGING_NEXT_PUBLIC_SUPABASE_URL when STAGING_SUPABASE_URL is empty | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-19 | builds the admin recovery URL from hashed_token and the admin reset path | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-20 | refuses when a users row already exists for the email | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-21 | refuses when an auth user already exists for the email | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-22 | refuses when a users row already exists for the resolved auth id | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-23 | returns a refusal when the in-transaction email re-check fires | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-24 | deletes the created auth user when the mint transaction fails | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-25 | does not delete the auth user when the mint transaction committed despite an error | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-26 | does not delete the auth user when the post-failure reconciliation read also fails | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-27 | reports the orphan auth id when the compensating delete also fails | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-28 | refuses in dry run when an auth identity already exists for the email | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-29 | reports the auth probe as unavailable when auth.users is absent | `scripts/ci/__tests__/mint-admin.test.ts` | `skipped-budget` | — | — |
| IV-30 | leaves no users row when the audit write fails | `scripts/ci/__tests__/mint-admin.integration.test.ts` | `skipped-budget` | — | — |
| IV-31 | refuses a second mint for the same email against the live schema | `scripts/ci/__tests__/mint-admin.integration.test.ts` | `skipped-budget` | — | — |
| IV-32 | (no covering test) createUser duplicate-email refusal | `scripts/mint-admin.ts:522-527,581-590` | `inconclusive` | oracle | RT-01 |
| IV-33 | (no covering test) createUser returned no user and no error | `scripts/mint-admin.ts:597-604` | `inconclusive` | oracle | RT-02 |
| IV-34 | (no covering test) generateLink failure after a committed mint | `scripts/mint-admin.ts:662-674` | `inconclusive` | oracle | RT-03 |
| IV-35 | (no covering test) direct db.<ref>. target form and the unparseable-target refusal | `scripts/mint-admin.ts:194,207-208,260-275` | `inconclusive` | oracle | RT-07 |
| IV-36 | (no covering test) readMintConfig / requireValue env selection | `scripts/mint-admin.ts:149-176` | `inconclusive` | oracle | RT-08 |
| IV-37 | (no covering test) formatMintReport refused/failed/dry-run-warning branches, and the deleteUser throw path | `scripts/mint-admin.ts:425-427,707-742` | `inconclusive` | oracle | RT-09 |
| IV-38 | (out of scope) main() and the runDirectCli exit-code mapping | `scripts/mint-admin.ts:753-810` | `excluded` | — | — |

Rows with `skipped-budget` are in-scope candidates deliberately not executed: the round budget is 30 runs and 22
were spent on the highest-value targets (the asymmetric compensation logic, the target guard, the transaction
boundary, the no-password property). A partial run can never report `CLEAR`, and this one does not.

## Authorizations

None. No finding on this run is disposed `accepted-risk`.

## Restoration

`finalize` reaped all 22 journaled process groups, restored every mutated file to its journaled original blob and
restored the swapped `.env.local`. `git status --porcelain --untracked-files=no` is EMPTY at
`8c4108b4bd2a6a50a2a63b5b7a044fd050719a39`; the only untracked paths are this report directory and the two read-only review axes' staging.

---

# Round 2 — scoped verification of the fixes

**Scope.** Only the fix hunks
`git diff 8c4108b4bd2a6a50a2a63b5b7a044fd050719a39..2eaac3339ed131523b11cd286a22f66dd8ada308`
and their direct callers. Nothing round 1 already covered was re-reviewed, and no
front was opened against unchanged code except where a fix RELOCATED behaviour into
it (RT-07) or where Duty 4 requires a sibling hunt (RT2-05).

| | |
|---|---|
| fork / merge-base | `b23172836bc5c435dc429f1fa7505812c168fa87` |
| round-1 HEAD (pre-fix) | `8c4108b4bd2a6a50a2a63b5b7a044fd050719a39` |
| round-2 HEAD (post-fix) | `2eaac3339ed131523b11cd286a22f66dd8ada308` |
| intake sha256 | `1d4fdd7c867d8fa0feae75518b9ee5175d193a6836813b2c480180a85a3fb36f` (unchanged) |
| risk | high · round 2 of a hard cap of 2 |
| mutation runs | 17 of 30 |
| **status** | **`INCOMPLETE_ORACLE`** |
| counts | 0 P0 open · 4 P1 open · 3 P2 open · 10 round-1 findings verified fixed |

**Environment.** `mutation-runner.mjs env --tmp-home <mktemp -d> --test-db <localhost:5499>`
plus `dotenv-swap --test-db` for the whole phase. Nothing was ever pointed at a Supabase
project. `--test-db` was threaded into every `run` invocation as well as `env`, so the
live-DB suite executed for real (3/3 passed, 0 skipped) — round 1's false-skip trap did
not recur. Watchers: none.

**Protocol deviation, recorded.** Mutant runs executed the WHOLE unit file rather than a
single `-t`-selected test. The baseline was the same whole file, green (54/54), so every
individual baseline is established; the JSON reporter attributes each failure to an exact
test title, which is strictly more information than `assert-one-test` yields and can never
turn a survivor into a false kill.

## The two round-1 survivors — both now dead

**IV-01 / RT-04 — SQLSTATE class 08.** `CONFIRMED_ROLLBACK_SQLSTATE`
`/^(22|23|42)\d{3}$/` → `/^(08|22|23|42)\d{3}$/`. **KILLED.** Exactly three tests fail,
51 pass: `never confirms a rollback for 08006 (connection_failure)`, `… 08007
(transaction_resolution_unknown — the ambiguous COMMIT outcome)`, `… 08003
(connection_does_not_exist)`. The orchestrator's claim of three is exact.

**IV-02 / RT-05 — `PROJECT_REF_PATTERN` widening.** `/^[a-z0-9]{20}$/` → `/^[a-z0-9]{16,}$/`.
**KILLED**, one failure: `refuses a confirmed ref that is not a full Supabase project ref`.
The failure message re-derives the mechanism the orchestrator described: under the widened
pattern the 16-, 19- and 21-character inputs pass the complete-ref guard and fall through to
the Supabase-URL equality guard, which throws `REFUSING TO RUN: the Supabase URL res…` —
a message the new attributed `.toThrow(/complete Supabase project ref/i)` rejects. **Both**
halves of the fix are load-bearing: the longer inputs alone would still throw (bare
`.toThrow()` would pass), and the attributed regex alone would have nothing to catch.

## The same shape, hunted elsewhere in this diff

The orchestrator asked whether any other assertion "looks strengthened but whose inputs
cannot distinguish the mutation". Two do, and both are new in this diff:

- **RT2-04** — the duplicate-email fixture satisfies BOTH arms of `isDuplicateEmailError`
  (`code: 'email_exists'` *and* the "already registered" message). Deleting the code arm
  survives.
- **RT2-02** — the TARGET-line fixture puts `STAGING_REF` inside all three fields, so
  `toContain(STAGING_REF)` discriminates nothing, and `toBe(formatMintTarget(target))`
  compares the function to itself. Deleting `project=` from the line survives.

## The questions the orchestrator posed, answered

**`flagValue` treating a `--`-prefixed value as absent.** No legitimate value is broken:
`--email`, `--name`, `--confirm-ref` and `--env` all take values that cannot begin with
`--`, and `dryRun` still comes from `argv.includes('--dry-run')`. A flag whose value is
swallowed reports its own name (`--email is required`) plus the usage block, so nothing goes
silently missing. The behaviour is correct — and completely untested (**RT2-01**).

**`isDuplicateEmailError` no longer accepting a bare 422.** The unsafe direction is closed
by construction: any `created.error` returns `refused` or `failed`, and neither arm reaches
the transaction, so a narrowed classifier can never let a duplicate be MINTED. It can only
turn a `refused (auth_user_exists)` into a `failed`, which is the safe direction and which
the runbook's new "Two `FAILED` outputs" section now covers. Real GoTrue duplicate shapes
were checked against the classifier: `email_exists` (code arm), `User already registered`
and `A user with this email address has already been registered` (message arm), and
`user_already_exists` / "User with this email or phone number already exists" (message arm).
The observed shape pinned in `src/lib/auth/__tests__/provision-auth-user.test.ts:187`
(`code: 'unexpected_failure', status: 422, message: 'User already registered'`) is still
caught. No hole found in the minting direction.

**Both `createUser` failure arms reporting UNKNOWN.** No path still asserts absence for
them. The three remaining "nothing was written" claims were each re-resolved and are all
true: the dry-run report line (`mint-admin.ts:773` — the dry run returns at `:605`, before
`createUser`), the runbook's `users_row_exists` row (that refusal returns at `:584`, also
before `createUser`), and the exit-code table's row 3.

**`assertMintTarget` taking `dbProjectRef` from the caller.** No weakening of the GUARD
was found. `extractProjectRefForLog` reads the host first (`^db\.<ref>\.`) then the pooler
username (`^[^.]+\.<ref>$`), both from the same `config.databasePoolUrl` string the
`postgres()` client is built from, so the ref it returns always describes the database
actually connected to; where the two could disagree (a pooler-style username beside a
`db.<ref>.` host) the host wins, which is the connection that is actually made. The
`{16,}` and `/i` looseness cannot admit a wrong ref, because `confirmRef` must match
`^[a-z0-9]{20}$` and `dbProjectRef` must EQUAL it — a longer or mixed-case extraction
simply fails equality and refuses. The two miss sentinels `(ref-not-found)` and
`(unparseable)` contain `(`, `-` and `)`, so they can never satisfy `PROJECT_REF_PATTERN`
and can never equal a valid `--confirm-ref`. **But the move cost coverage** — see RT-07.

**The audit payload's `operator` / `actor_is_subject` / `attribution`.** Pinned by a
`toMatchObject` that discriminates: M6 killed it. `writeAdminAuditLog`'s actor binding is
pinned positionally now: M11 killed it.

**`orphanAuthId` on both arms.** All ten construction sites were read; every one sets the
field explicitly (`mint-admin.ts:499, 513, 514, 525, 535, 541, 589, 602, 630, 645, 657`).
Both report arms are exercised (M16 killed the refused one).

**The integration suite and `abortingExecutor`.** The suite proves what its titles claim
and ran for real (3/3, no skip). The substitution is behaviour-identical for this caller:
the poison statement is byte-identical to the inline version's, and `mintAdmin` calls
`sql.begin(cb)` in the one-argument form. The helper's `begin(options, cb)` forwarding is
NOT defeated — `const leading = args.slice(0, -1)` is spread ahead of the wrapped callback
at `abort-injection.ts:73-82`. It is also untested, by the helper or by any of its eight
callers; recorded on inventory row `IV2-16` for the owning ticket rather than raised as a
finding here, because the helper is unchanged by these fix hunks.

**Doc claims that changed.** All re-resolved against HEAD.
`prevalidate-plan.py` PASSes on the plan (23 citations, 0 unresolved), the runbook and the
handoff. `scripts/staging-guard.ts:82` and `:126` are both `if (!target.includes(ref)) {`,
so the corrected §1 citation is true in both halves. The exit-code table matches
`EXIT_OK/USAGE/REFUSED/FAILED = 0/2/3/4` and `runDirectCli`'s mapping; both quoted `FAILED`
strings match what is emitted; `§ Reconciling an uncertain run` and `§ An Auth identity with
no users row` both exist as headings; `mfa-factor-reset.md` § step 2 "Environment matters"
really does own the `STAGING_` mapping, the empty-`STAGING_SUPABASE_URL` fallback and the
`source` hazard, so the ownership hand-off is honest; and "the operator is recorded in the
row's `payload`" is now true. One imprecision: **RT2-06**.

## Findings

| id | sev | at | title | disposition |
|---|---|---|---|---|
| `RT-01` | P1 | `scripts/mint-admin.ts:522` | The Auth-API duplicate-email refusal — the plan's second 'independent closer' — has no test at all | **fixed** |
| `RT-02` | P1 | `scripts/mint-admin.ts:597` | 'The Supabase createUser call returns no user with no error' is a locked intake edge case with no test | **fixed** |
| `RT-03` | P1 | `scripts/mint-admin.ts:662` | 'generateLink fails after the transaction committed' is a locked intake edge case with no test | **fixed** |
| `RT-04` | P1 | `scripts/mint-admin.ts:363` | confirmsRollback's class-08/57 ambiguity — the asymmetric safety property — has no oracle; a mutant that adds class 08 to the confirmed-rollback set survives | **fixed** |
| `RT-05` | P1 | `scripts/ci/__tests__/mint-admin.test.ts:137` | Fragile assertion: 'refuses a confirmed ref that is not a full Supabase project ref' asserts only that something throws | **fixed** |
| `RT-06` | P1 | `scripts/ci/__tests__/mint-admin.test.ts:544` | Fragile assertion: `inTransaction` is a time-window flag, not a connection identity, so the audit write can leave the transaction undetected | **fixed** |
| `RT-07` | P1 | `scripts/mint-admin.ts:207` | Two documented target-parser behaviours are unreachable by any test: the direct `db.<ref>.` form and the unparseable-target refusal | **open** |
| `RT-08` | P2 | `scripts/mint-admin.ts:149` | readMintConfig, requireValue and the --env validation throw are entirely untested | **fixed** |
| `RT-09` | P2 | `scripts/mint-admin.ts:707` | Only the `minted` arm of formatMintReport is ever rendered; the operator-facing warning lines are unasserted | **fixed** |
| `RT-10` | P1 | `docs/superpowers/plans/feat-1178-mint-admin-plan.md:21` | Plan §1 cites `staging-guard.ts:65,76` as 'the includes() test'; :76 is an equality test and the includes() is at :82 | **fixed** |
| `RT-11` | P2 | `docs/runbooks/mint-admin.md:103` | The runbook documents no exit codes, and omits the two createUser FAILED outputs from its refusal table | **fixed** |
| `RT2-01` | P1 | `scripts/mint-admin.ts:93-97` | The `flagValue` `--`-prefixed-value guard (review finding S3) shipped with no test at all | **open** |
| `RT2-02` | P1 | `scripts/ci/__tests__/mint-admin.test.ts:766-770` | Fragile assertion: the new TARGET-line test cannot see the TARGET line lose its project ref | **open** |
| `RT2-03` | P2 | `scripts/mint-admin.ts:247` | The new `['database project ref', dbProjectRef]` prod-denylist row has no oracle | **open** |
| `RT2-04` | P1 | `scripts/ci/__tests__/mint-admin.test.ts:612-624` | The duplicate-email test's fixture satisfies BOTH arms of `isDuplicateEmailError`, so neither is pinned | **open** |
| `RT2-05` | P2 | `scripts/diff-coverage.ts:34-42` | Sibling of the fixed `flagValue` shape: `argValue` in scripts/diff-coverage.ts is still unguarded | **open** |
| `RT2-06` | P2 | `docs/runbooks/mint-admin.md:122` | The new exit-code table calls code 2 'a missing or malformed flag'; a missing ENV VAR also exits 2 | **open** |

## Inventory

| id | candidate | file | outcome | finding |
|---|---|---|---|---|
| `IV2-01` | confirmsRollback never confirms a rollback for 08006/08007/08003 (3 rows of the it.each) | `scripts/ci/__tests__/mint-admin.test.ts:728` | **killed** | — |
| `IV2-02` | assertMintTarget refuses a confirmed ref that is not a full Supabase project ref | `scripts/ci/__tests__/mint-admin.test.ts:140` | **killed** | — |
| `IV2-03` | parseMintAdminArgs (all four cases) vs the new flagValue guard | `scripts/ci/__tests__/mint-admin.test.ts:66-113` | **inconclusive (oracle)** | RT2-01 |
| `IV2-04` | formatMintReport leads every report with the TARGET line | `scripts/ci/__tests__/mint-admin.test.ts:766` | **inconclusive (oracle)** | RT2-02 |
| `IV2-05` | mintAdmin does not report a duplicate for a non-duplicate 422 | `scripts/ci/__tests__/mint-admin.test.ts:627` | **killed** | — |
| `IV2-06` | mintAdmin refuses when the Auth API itself reports a duplicate email | `scripts/ci/__tests__/mint-admin.test.ts:612` | **inconclusive (oracle)** | RT2-04 |
| `IV2-07` | mintAdmin reports an unknown Auth outcome when createUser fails, never absence | `scripts/ci/__tests__/mint-admin.test.ts:642` | **killed** | — |
| `IV2-08` | mintAdmin treats createUser returning no user and no error as an unknown outcome | `scripts/ci/__tests__/mint-admin.test.ts:659` | **killed** | — |
| `IV2-09` | mintAdmin reports a committed mint with no link when generateLink fails | `scripts/ci/__tests__/mint-admin.test.ts:673` | **killed** | — |
| `IV2-10` | mintAdmin records the mint through writeAdminAuditLog with the new admin as its own actor | `scripts/ci/__tests__/mint-admin.test.ts:562` | **killed** | — |
| `IV2-11` | assertMintTarget refuses a production project ref outright | `scripts/ci/__tests__/mint-admin.test.ts:172` | **inconclusive (oracle)** | RT2-03 |
| `IV2-12` | formatMintReport surfaces an orphaned Auth identity on both the refused and failed arms | `scripts/ci/__tests__/mint-admin.test.ts:796` | **killed** | — |
| `IV2-13` | readMintConfig reads the ambient environment when no --env is given | `scripts/ci/__tests__/mint-admin.test.ts:813` | **killed** | — |
| `IV2-14` | extractProjectRefForLog -- the parser assertMintTarget now depends on (5 suites, 146 tests) | `scripts/staging-guard.ts:154-165` | **inconclusive (oracle)** | RT-07 |
| `IV2-15` | mintAdmin against live local Postgres -- all three live-DB cases | `scripts/ci/__tests__/mint-admin.integration.test.ts:141,170,223` | **excluded** | — |
| `IV2-16` | abortingExecutor begin(options, cb) leading-argument forwarding | `src/lib/shared/__tests__/helpers/abort-injection.ts:61-83` | **excluded** | — |
| `IV2-17` | Duty 5 -- operational completeness of the fix hunks | `scripts/mint-admin.ts` | **excluded** | — |

## Round-1 findings — verification evidence

**RT-01** — Round 2 re-verified. `scripts/ci/__tests__/mint-admin.test.ts:612` now drives the createUser error arm. Mutation M5 (`isDuplicateEmailError` widened back to accept a bare `status === 422`) KILLED `does not report a duplicate for a non-duplicate 422`. Residual gap raised as RT2-04.

**RT-02** — Round 2 re-verified. `mint-admin.test.ts:659` covers the no-user/no-error shape. Mutation M14 (the arm's detail loses its UNKNOWN language) KILLED it.

**RT-03** — Round 2 re-verified. `mint-admin.test.ts:673` covers a failed generateLink after a committed mint. Mutation M15 (`recoveryLinkError` forced to null) KILLED it.

**RT-04** — Round 2 re-verified. `describe('confirmsRollback')` at `mint-admin.test.ts:714` pins the classes. Mutation M1 (`/^(22|23|42)\d{3}$/` -> `/^(08|22|23|42)\d{3}$/`) KILLED exactly three tests: the 08006, 08007 and 08003 rows. The orchestrator's claim of three is exact.

**RT-05** — Round 2 re-verified. Mutation M2 (`PROJECT_REF_PATTERN` `{20}` -> `{16,}`) KILLED `refuses a confirmed ref that is not a full Supabase project ref`. BOTH halves of the fix are load-bearing: the attributed `.toThrow(/complete Supabase project ref/i)` is what fails (the widened pattern lets the 16/19/21-char inputs reach the equality guard, which throws a DIFFERENT message), and it only reaches that guard because the 16-, 19- and 21-character entries were added.

**RT-06** — Round 2 re-verified. The `inTransaction` proxy is replaced by a positional bind assertion plus a users-before-audit ordering assertion. Mutation M11 (`actorUserId: userId` -> `actorUserId: authId`) KILLED `records the mint through writeAdminAuditLog with the new admin as its own actor`; mutation M6 (`actor_is_subject: true` -> `false`) killed the same test.

**RT-08** — Round 2 re-verified. `describe('readMintConfig')` at `mint-admin.test.ts:812`. Mutation M17 (ambient mode reads `{}` instead of `process.env`) KILLED `reads the ambient environment when no --env is given`.

**RT-09** — Round 2 re-verified. `describe('formatMintReport')` at `mint-admin.test.ts:759` renders the would_mint/unavailable, minted-without-link, refused and failed arms. Mutation M16 (the refused arm stops surfacing the orphan) KILLED `surfaces an orphaned Auth identity on both the refused and failed arms`. The TARGET line's own content oracle is still weak: RT2-02.

**RT-10** — Round 2 re-resolved against HEAD. `scripts/staging-guard.ts:82` and `:126` are both `if (!target.includes(ref)) {` -- the containment tests, exactly as the corrected citation claims. `prevalidate-plan.py docs/superpowers/plans/feat-1178-mint-admin-plan.md --repo .` -> PASS, 23 citations, 0 unresolved.

**RT-11** — Round 2 re-resolved against HEAD. The Exit codes table (`docs/runbooks/mint-admin.md:114`) matches `EXIT_OK=0 / EXIT_USAGE=2 / EXIT_REFUSED=3 / EXIT_FAILED=4` and `runDirectCli`'s onError mapping at `scripts/mint-admin.ts:869-878`. The two FAILED strings quoted at `:125` match the emitted details byte-for-byte in substance. One imprecision raised separately as RT2-06.

## Round-2 findings — detail

### RT-07 — P1 — Two documented target-parser behaviours are unreachable by any test: the direct `db.<ref>.` form and the unparseable-target refusal

**At** `scripts/mint-admin.ts:207` · **Duty** 4 · **Disposition** `open`

NOT FIXED -- WIDENED by the fix. The fix deleted mint-admin's own `refFromDatabaseTarget` and made `assertMintTarget` take `dbProjectRef` from the caller, produced by `extractProjectRefForLog` (`scripts/staging-guard.ts:154-165`). Every `assertMintTarget` test now passes `dbProjectRef` as a LITERAL, so the parser is stubbed out of the guard's test surface entirely -- and `extractProjectRefForLog` has no test of its own anywhere in the repo (`scripts/ci/__tests__/staging-guard.test.ts` tests `describeConnectionTarget`, never this). Mutation M12 replaced its whole body with `return '(ref-not-found)'` and SURVIVED 146 tests across staging-guard, mint-admin, burst-drill-load, health-bundle-differential and wedge-repro. That mutant would make every mint refuse and print `project=(ref-not-found)`, and nothing in CI notices. At round-1 HEAD the pooler branch WAS covered (round 1 recorded only `:208` direct and `:194` invalid-URL as 0-covered); at round-2 HEAD none of it is. Fix: add `describe('extractProjectRefForLog')` to `staging-guard.test.ts` -- pooler username form, direct `db.<ref>.` host form, a host that matches neither (`(ref-not-found)`), and an unparseable URL (`(unparseable)`).

*Arbiter:* Mutation-derived (M12) plus a reverse import search: `rg extractProjectRefForLog` returns five production files and zero test files. The mutant is meaningful and non-equivalent, but it sits on a branch no test in the inventory executes -- the guard's tests inject `dbProjectRef` directly -- so the inventory row is `inconclusive`/`oracle`, a claim about the ORACLE, not a confirmed P0.

### RT2-01 — P1 — The `flagValue` `--`-prefixed-value guard (review finding S3) shipped with no test at all

**At** `scripts/mint-admin.ts:93-97` · **Duty** 1 · **Disposition** `open`

Mutation M3 reverted the guard to the pre-fix `return argv[index + 1];` and SURVIVED the whole unit suite (54/54 green). No test anywhere passes an argv where a flag's value is itself a flag. The fix's own docblock names the hazard it prevents -- `--email --dry-run` minting an admin named `--dry-run` -- and nothing pins it. Fix: two cases on `parseMintAdminArgs` -- `['--email','--dry-run','--name','X','--confirm-ref',REF]` throws `MintAdminUsageError` naming `--email`, and a trailing `--confirm-ref` with no following token does the same.

*Arbiter:* The mutant is meaningful and non-equivalent, but it is on a branch no existing test executes (every parse test supplies well-formed values), so per step 5 it is `inconclusive`/`oracle`, not a confirmed P0. This is an uncovered production hunk under Step 2 direction B, which is a P1 on its own.

### RT2-02 — P1 — Fragile assertion: the new TARGET-line test cannot see the TARGET line lose its project ref

**At** `scripts/ci/__tests__/mint-admin.test.ts:766-770` · **Duty** 2 · **Disposition** `open`

`it('leads every report with the TARGET line')` asserts `expect(line).toContain(STAGING_REF)` where `line = formatMintTarget(target)`, then `expect(formatMintReport(...)[0]).toBe(line)`. The second assertion compares the function's output to itself -- it is a tautology over content -- and the first cannot discriminate, because ALL THREE fixture fields contain `STAGING_REF` (`projectRef` is the ref, `supabaseHost` is `<ref>.supabase.co`, `databaseTarget` is `postgres.<ref>@...`). Mutation M9 deleted `project=${target.projectRef} ` from `formatMintTarget` and SURVIVED. Review finding S1 exists precisely so the operator sees which project they are pointed at before the first write; nothing pins that field. Fix: assert the whole line against an expected string built from three DISTINCT fixture values, e.g. `expect(line).toBe(`TARGET: project=${STAGING_REF} supabase=${host} db=${dbTarget}`)` with a `projectRef` that does not appear in the other two.

*Arbiter:* The mutant changes the emitted string, so it is not equivalent in general. Against the behaviour this test NAMES -- that the report leads with the TARGET line -- the mutant preserves it, so the survivor is recorded `inconclusive`/`oracle` rather than a confirmed P0. The defect is in the oracle, and that is the finding.

### RT2-03 — P2 — The new `['database project ref', dbProjectRef]` prod-denylist row has no oracle

**At** `scripts/mint-admin.ts:247` · **Duty** 1 · **Disposition** `open`

Mutation M4 deleted the row from `assertMintTarget`'s production-denylist loop and SURVIVED. The only test that reaches the prod branch (`refuses a production project ref outright`) also passes a prod `supabaseUrl`, which throws first. P2 rather than P1 because for the sole production caller the row is redundant: `main()` derives `dbProjectRef` by substring extraction from `config.databasePoolUrl`'s hostname or username, and `dbTarget` = `${username}@${hostname}:${port}` is a superset of both, so any prod ref in `dbProjectRef` is already in `dbTarget` -- which IS checked. It is not PROVABLY equivalent, because `assertMintTarget` is exported and a future caller could pass an unrelated pair. Fix: one case passing a clean supabaseUrl/dbTarget with a prod `dbProjectRef`.

*Arbiter:* Executed but indistinguishable under the current fixture; recorded inconclusive/oracle.

### RT2-04 — P1 — The duplicate-email test's fixture satisfies BOTH arms of `isDuplicateEmailError`, so neither is pinned

**At** `scripts/ci/__tests__/mint-admin.test.ts:612-624` · **Duty** 2 · **Disposition** `open`

The new `refuses when the Auth API itself reports a duplicate email` injects `{ code: 'email_exists', status: 422, message: 'User already registered' }` -- which matches the `email_exists` code arm AND the `/already (been )?registered|already exists/i` message arm. Mutation M13 deleted the code arm entirely and SURVIVED the whole suite. Round 1's RT-01 asked for one case PER ARM; the fix landed one case that covers the disjunction rather than either disjunct. This is the same shape as RT-05: an assertion that reads as strengthened but whose input cannot distinguish the mutation. Fix: split into two -- `{ code: 'email_exists', message: 'Email address is in use' }` (code arm only) and `{ status: 422, message: 'User already registered' }` with no code (message arm only).

*Arbiter:* The mutant changes `isDuplicateEmailError` for inputs outside this fixture, so it is not equivalent in general; against THIS input the function's result is unchanged, so it is recorded `inconclusive`/`oracle` rather than a confirmed P0. The gap is in the fixture, not in production behaviour.

### RT2-05 — P2 — Sibling of the fixed `flagValue` shape: `argValue` in scripts/diff-coverage.ts is still unguarded

**At** `scripts/diff-coverage.ts:34-42` · **Duty** 4 · **Disposition** `open`

Duty-4 sibling hunt for the S3 pattern. Patterns searched: `indexOf\(flag\)`, `argv\[index \+ 1\]`, `args\[index \+ 1\]`, `args\[i \+ 1\]`. Scope: the whole repo. Exclusions: `node_modules/`, `docs/`. Exactly two hits: `scripts/mint-admin.ts:93` (fixed by this diff) and `scripts/diff-coverage.ts:36-40`, which still does `const value = args[index + 1]; if (value) return value;`. `--min --base origin/main` therefore yields `Number('--base')` = NaN for the coverage floor. P2: it gates a CI coverage percentage, not a write path, and it is outside this diff. Recorded, not fixed.

*Arbiter:* Search-derived, not mutation-derived. The result is reported with its exact patterns, scope and exclusions.

### RT2-06 — P2 — The new exit-code table calls code 2 'a missing or malformed flag'; a missing ENV VAR also exits 2

**At** `docs/runbooks/mint-admin.md:122` · **Duty** 3 · **Disposition** `open`

`readMintConfig` -> `requireValue` throws `MintAdminUsageError` ('SUPABASE_URL is not set for this target -- export it, or pass --env local|staging'), and `runDirectCli`'s onError maps every `MintAdminUsageError` to `EXIT_USAGE` (2). So exit 2 also means 'a required environment variable is unset', which the table does not say. Every other row in the table verified true against HEAD. Fix: one clause -- 'or a required environment variable is unset'.

*Arbiter:* Doc-vs-code re-resolution against HEAD (Duty 3). A merely imprecise -- not false -- claim, hence P2.

## Authorizations

None. Rendered from `findings.json`'s (empty) `authorizations` array.

## What blocks

Status is `INCOMPLETE_ORACLE`: five in-scope rows are `inconclusive`/`oracle`. On a
high-risk run the four open P1s (RT-07, RT2-01, RT2-02, RT2-04) require user adjudication;
the three P2s are recorded and never block. No P0.
