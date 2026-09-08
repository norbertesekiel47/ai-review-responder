# Red team — `feat/1178-mint-admin` — round 1 (third pass, new tree)

- **Mode** `feature` · **Risk** `high` · **Round** 1 · **Run id** `feature-feat-1178-mint-admin-4d0734`
- **fork / merge-base** `b23172836bc5c435dc429f1fa7505812c168fa87`
- **HEAD** `f51ae7f009dfdab13d8ba9189d31bd450f84f712`
- **intake sha256** `6ac30407ecf4ff62b17ce3a627d499b9443d01e2e92187083b6f305e7ab936a0`
- **Generated** 2026-09-08T06:29:33Z
- **Status** `OPEN_P0`

## Authorization for this pass

Recorded verbatim, as instructed:

> "Owner-authorized third pass, 2026-09-07: re-derive a clean sidecar at the final HEAD after the production-selector and staging-guard-fold changes landed. The mutation journal was reset by the orchestrator so this pass opens cleanly; it is a NEW pass on a NEW tree (a different diff), not a third round on the tree the first two examined. Do not spend more than this pass. A new P0 goes to the owner."

This authorization scopes the PASS. It waives no finding, so `authorizations` in
`findings.json` is the empty array: that array is the strict-schema home of risk
ACCEPTANCES, each of which must name at least one finding
(`red-team-status.mjs:379`), and no finding here is `accepted-risk`. Recording
the pass authorization there would misrepresent it as a waiver.

## Re-derived evidence (never trusted from the claim)

| Claim | Re-derived at `f51ae7f0` | Result |
|---|---|---|
| Gate GREEN (lint, typecheck, test, 24 `ci:*`, merge-coverage, diff-coverage) | `bash scripts/verify-gate.sh --review` | **GREEN**, 29/29 PASS |
| 81 tests across `mint-admin.test.ts` + `staging-guard.test.ts`, 3 in `mint-admin.integration.test.ts` | `vitest run` over all three files | **84 passed (84)**, 3 files, no skip — the live-DB suite really ran (`TEST_DATABASE_POOL_URL` threaded via `--test-db`) |
| Every `tests_to_add` title present verbatim | `grep -F` of all 32 intake titles across the three suites | **32/32 present**, 0 missing |
| Mutation isolation | `mutation-runner.mjs watchers` → none; `env --tmp-home … --test-db …` validated the URL as localhost (no `REPWORTH_DISABLE_LIVE_DB_SUITES`); `dotenv-swap` swapped `.env.local` | clean |

Budget: **30/30 mutation runs used**, round 1. Journal closed; `finalize`
restored 1 dotenv file and reported every mutation `restored`;
`git status --porcelain` empty (tracked and untracked) before this file was
written.

**Nothing was ever pointed at a Supabase project.** Every mutation run executed
against the local test Postgres only; `scripts/mint-admin.ts` was never invoked
as a CLI.

---

## Findings

### RT3-01 — **P0** — both halves of "must EQUAL, not merely appear in" are unpinned

`scripts/staging-guard.ts:284` and `:291` · Duty 1 · disposition `open`

The module docblock, the runbook and `MINT_ADMIN_USAGE` all promise that
`--confirm-ref` "must EQUAL the ref parsed out of BOTH the Supabase URL and the
database target … not merely appear in it". That exact-equality property is what
the whole production path rests on once `allowProduction` lifts the denylist: it
is the only thing left standing between a typed selector and a write.

Two minimal mutations degrade each equality to substring containment. **Both
survived every one of the 84 tests**, individually and as a whole-suite run:

| Mutant | Line at HEAD | Mutation | Outcome |
|---|---|---|---|
| S8 | `staging-guard.ts:284` | `if (supabaseRef !== confirmRef)` -> `if (!supabaseUrl.toLowerCase().includes(confirmRef))` | **SURVIVED** — the named test passed; full 84-test run passed |
| S9 | `staging-guard.ts:291` | `if (dbProjectRef !== confirmRef)` -> `if (!dbTarget.toLowerCase().includes(confirmRef))` | **SURVIVED** — full 84-test run passed |

**Arbiter confirmation.** Neither is equivalent and neither sits on an
unexecuted branch.

*S8.* `refFromSupabaseUrl(supabaseUrl) === confirmRef` requires the FIRST host
label to parse as exactly twenty lowercase alphanumerics AND to equal the
confirmation. `supabaseUrl.toLowerCase().includes(confirmRef)` requires only
that the confirmed ref appear anywhere in the URL string. They differ on
concrete inputs: `https://xx<stagingref>.supabase.co` (a 22-character label —
not a project ref, and a different host) and
`https://attacker.example.com/<stagingref>` are REFUSED by HEAD and ACCEPTED by
the mutant. The test `refuses when the Supabase host does not contain the
confirmed project ref` executes precisely this branch — its own title names the
behaviour — and still passes, because its only oracle is `.toThrow(/supabase/i)`
and the mutant still throws.

*S9.* Same shape on the database half, and it additionally falsifies a second
documented guarantee: `MintTargetInput.dbProjectRef`'s docblock says the miss
sentinels `(ref-not-found)` / `(unparseable)` "fail the equality below, so an
unparseable target is a refusal, never a pass". Under S9 `dbProjectRef` is never
read at all, yet the sentinel test still passes — only because its fixture
`postgres@localhost:5432` happens not to contain the ref. A target such as
`postgres@<stagingref>-shadow.example.com:5432` is a sentinel case that the
mutant ACCEPTS.

**Behavioural replacement.** For each half add a superstring case that only
equality can refuse, and assert the discriminating message rather than a
substring every message carries:

- Supabase half: `supabaseUrl: 'https://xx' + STAGING_REF + '.supabase.co'`,
  `confirmRef: STAGING_REF` -> must throw `/resolves to project ref .*, not the confirmed/`.
- Database half: `dbTarget: 'postgres@' + STAGING_REF + '-shadow.example.com:5432'`,
  `dbProjectRef: '(ref-not-found)'`, `confirmRef: STAGING_REF` -> must throw
  `/resolves to project ref \(ref-not-found\), not the confirmed/`.

Each kills its mutant. This is the same "looks strengthened, cannot
discriminate" shape the suite already records for RT-05 and RT2-04.

### RT3-02 — **P1** — the production selector's only wiring has no covering test at any level

`scripts/mint-admin.ts:751` · Step 2 Direction B (uncovered change) · disposition `open`

```
allowProduction: args.envMode === 'production',
```

This single expression is the entire join between the operator's typed selector
and the guard that acts on it. Both ENDS of the join are pinned — the guard by
six killed mutants (S1–S6), the parse default by A1 — but the join itself is
executed by nothing.

Reverse import search (Direction B): `rg -l "mint-admin"` returns
`scripts/mint-admin.ts` and its three suites; `main()` is not exported and
`runDirectCli` calls it only when Node invoked the module directly (which the
unit suite's own header states is why importing is safe). No test spawns the
script as a process. **No covering candidate exists**, so the row is
`inconclusive` / class `oracle`.

A mutant `allowProduction: true` would let `ambient`, `local` and `staging`
reach a production project with a matching `--confirm-ref` — the exact escape
this pass was sent to attack — and would ship green.

**Behavioural replacement.** Extract the guard-input assembly
(`const guardInput = buildMintGuardInput(args, config)`) and assert
`allowProduction` is `true` for `production` and `false` for each of `ambient`,
`local`, `staging`. A four-row `it.each` closes it.

### RT3-03 — **P1** — `--env production` is never parsed by any test

`scripts/mint-admin.ts:114-121` · Step 2 Direction B · disposition `open`

`rg "'production'|\"production\""` over all three suites returns **zero
matches**. No test ever produces `envMode: 'production'`. The branch added to
`parseMintAdminArgs`'s validation — the one that admits the selector at all — is
uncovered, as is the `MintEnvMode` widening behind it.

Its failure direction is fail-closed (dropping `rawEnv !== 'production'` makes
production unreachable rather than reachable), which is why this is P1 and not
part of RT3-01. But it means the selector's whole parse path ships unexercised,
and it is the cheapest possible test to add.

**Behavioural replacement.** One assertion:
`expect(parseMintAdminArgs([..., '--env', 'production']).envMode).toBe('production')`,
plus `expect(() => parseMintAdminArgs([..., '--env', 'prod'])).toThrow(/--env must be/)`.

### RT3-04 — **P2** — `readMintConfig`'s production branch is uncovered

`scripts/mint-admin.ts:185` · disposition `open`

`readMintConfig('ambient')` is tested twice; `readMintConfig('production')` —
which must take the SAME ambient-source branch, per the comment added at
`:181-184` — is never called. Dropping `&& envMode !== 'production'` sends
`ENV_FILES['production']` (undefined) into a destructuring assignment and throws
a `TypeError`, not the documented usage error. Loud and fail-closed, hence P2.

### RT3-05 — **P1** — fragile assertions: the mint-mode refusal tests match a substring nearly every message carries

`scripts/ci/__tests__/staging-guard.test.ts:170, 181, 218` · Duty 2 · disposition `open`

This is the mechanism behind RT3-01, recorded separately because it also weakens
the sentinel test that RT3-01 does not cover.

`assertMintTarget` can throw four distinct messages. Substring inventory:

| Message | contains `supabase` | contains `database` |
|---|---|---|
| prod denylist (`the ${label} matches a PRODUCTION project ref`) | yes for label `Supabase URL` | yes for the two `database …` labels |
| `--confirm-ref must be a complete Supabase project ref … "supabase" is a substring of every ordinary target` | yes (twice) | no |
| `the Supabase URL resolves to project ref X, not the confirmed Y` | yes | no |
| `the database target (…) resolves to project ref X, not the confirmed Y. The Supabase URL and the database URL must belong to the SAME project.` | yes | yes |

So `.toThrow(/supabase/i)` at :170 is satisfied by **all four**, and
`.toThrow(/database/i)` at :181 and :218 by **two**. Neither can tell the check
it names from a different check firing first. The suite already knows the right
shape — the production tests next door assert `/not the confirmed/`,
`/--env production/` and `/complete Supabase project ref/i`.

**Behavioural replacement.** `/resolves to project ref .*, not the confirmed/` on
all three, with the superstring cases from RT3-01 added.

### RT3-06 — **P2** — the usage synopsis and the module docblock still omit the production selector

`scripts/mint-admin.ts:16` and `:74` · Duty 3 · disposition `open`

Both synopsis lines still read `[--env local|staging]`, three lines above a
`--env` block that documents `production` in full and a runbook that now names
`--env production` as the only route to production. Not false — incomplete — so
P2. An operator who reads only the synopsis concludes production is unreachable,
which is the claim this branch reversed.

### RT3-07 — **P2** — stale SHA quoted from `.feature/state.json`

`docs/superpowers/plans/feat-1178-mint-admin-deviations.md:54` · Duty 3 · disposition `open`

The doc asserts, present tense, that every phase claim "is read from
`.feature/state.json` (`phase=gate_green head=82b19407`)". At HEAD that file read
`{"phase":"gate_green","head":null}` before this pass's gate re-run and
`head=f51ae7f0` after it. `prevalidate-plan.py` flags it
(`HEAD claimed as 82b19407, but HEAD is f51ae7f0`). P2 rather than P1: it is a
dated quotation inside an append-only deviation record, it supports an argument
unaffected by the value, and no operator acts on it. The other three changed
plan/runbook docs prevalidate **PASS** (1, 23 and 0 citations, 0 unresolved).

### RT3-08 — **P2** — orphan section header left by the fold

`scripts/mint-admin.ts:202` · Duty 3 · disposition `open`

`// ── the target guard ─────` now owns nothing: the guard moved to
`staging-guard.ts` and the header sits immediately above the next header,
`// ── the recovery link ─────`. Cosmetic residue of the move.

---

## Duty 2 — fragile assertions, full scan

Scanned every added/modified test case in the two changed suites.

- **RT3-05** (above) is the one finding.
- The fixes the previous passes' findings asked for were re-verified and **hold
  at this HEAD, through the file move**:
  - RT2-01 (`flagValue`'s `--`-prefixed-value guard) -> mutant A2 **KILLED**.
  - RT2-02 (TARGET line with distinct per-field fixtures) -> the fixture at
    `mint-admin.test.ts:698-709` now uses three distinct 20-character values and
    asserts the literal line including every `project=`/`supabase=`/`db=` label;
    the round-2 survivor is dead by construction.
  - RT2-04 (`isDuplicateEmailError`'s two arms) -> the `it.each` at
    `mint-admin.test.ts:541` now carries ONE signal per case
    (`code: 'email_exists'` with message `'nope'`; `code: 'unexpected_failure'`
    with an "already registered" message), so deleting either arm fails a case.
  - RT-05 (the `{20}` pattern) -> mutant S5 widening it to `{16,}` **KILLED**;
    the 16-, 19- and 21-character entries survived the move verbatim.
  - RT-07 (the target parser) -> `describe('extractProjectRefForLog …')` now
    exists at `staging-guard.test.ts:308` with the pooler form, the direct
    `db.<ref>.` host form and both sentinels.
- No absence-of-tag proxies, no exact string counts on rendered output, and no
  order assertion without a contract: the one ordering assertion
  (`auditInsertAt > usersInsertAt`, `mint-admin.test.ts:517`) pins a real FK
  ordering contract and is corroborated by the live-DB suite (mutant A7).

## Duty 3 — docs vs reality, re-resolved at HEAD

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py <doc> --repo .`
run on all four changed plan/runbook docs: `mint-admin.md` PASS (1/1),
`…-plan.md` PASS (23/23 citations, 3/3 fixtures), `…-handoff.md` PASS (1/1
commit), `…-deviations.md` 1 ISSUE -> **RT3-07**.

Hand-checked every `path:line` citation in the changed CODE (the script does not
scan those). All resolve at HEAD:

| Citation | Resolves to |
|---|---|
| `src/lib/admin/shell-context.ts:103` | `SELECT id FROM users WHERE auth_id = … AND role = 'admin'` OK |
| `002_prompt2_fixes.sql:31` | `ALTER TABLE users ALTER COLUMN id DROP DEFAULT;` OK |
| `117_admin_audit_log.sql:51` | `actor_user_id UUID NOT NULL REFERENCES users(id)` OK |
| `001_initial_schema.sql:47,53` | `email … UNIQUE NOT NULL` / `auth_id … UNIQUE` OK |
| `signup-test-runbook.md:25` | the by-hand admin creation this script replaces OK |
| `admin-onboarding-service.ts:231` (at `src/lib/onboarding/`) | "admin-created `users.auth_id` must NEVER stay NULL" OK |

Re-resolved the changed prose claims:

- `staging-guard.ts` docblock "**Three modes**, all PURE and unit-tested" —
  **TRUE**: three exported asserts, all pure, all with tests.
- "In EVERY mode the prod denylist is checked FIRST and wins over every flag
  VALUE … Mint mode adds the one sanctioned exception" — **TRUE**:
  `rejectProdTarget` is statement 1 in both older modes and the
  `!allowProduction` loop is statement 1 in mint mode.
- "A selector … lifts nothing but the denylist" — **TRUE**: the guarded block
  contains only the denylist loop; the three equality checks run unconditionally
  (mutant S3, which returned early under the selector, was KILLED).
- Runbook "**Production needs TWO independent things, and neither is sufficient
  alone**" — **TRUE** (S3 kills the selector-alone direction; S1/S2/S4 kill the
  ref-alone direction).
- Runbook "`--dry-run` works against production too" — **TRUE** by trace:
  `assertMintTarget` runs at `main():744`, before the clients are built and
  before `mintAdmin`; the dry-run early return sits after both read-only probes
  (`mint-admin.ts:524`) and mutant A5 pins it.
- Runbook refusal-table row `… PRODUCTION project ref … production was not
  explicitly selected` — **TRUE**, byte-matching the message at
  `staging-guard.ts:266-270`.
- Runbook exit-code table — **TRUE** on both changed rows: `requireValue` and
  the env-file check raise `MintAdminUsageError` -> `EXIT_USAGE` (2); every
  target-guard refusal is a plain `Error` -> `EXIT_FAILED` (4).
- The synopsis lines -> **RT3-06**.

## Duty 4 — missed sibling cases

**Patterns searched, scope, exclusions — zero siblings found.**

1. `rg -n "assertStagingTarget|assertEphemeralBranchTarget|assertMintTarget" -g '*.ts'`
   over the repo excluding `node_modules`. Production callers:
   `burst-drill-load.ts:167`, `wedge-repro.ts:626,627` (staging mode),
   `health-bundle-differential.ts:128,129` (branch mode), and
   `mint-admin.ts:744` (mint mode). **`assertMintTarget` has exactly one
   caller**, and no other call site passes or could pass `allowProduction`.
2. Both older modes were re-read at HEAD and are byte-identical to the
   merge-base (`git diff` over `staging-guard.ts` shows only the docblock and the
   appended mode-3 block). They take no `allowProduction` parameter, call
   `rejectProdTarget(target)` unconditionally as their first statement, and
   independently reject a prod ref passed as the confirmation. Mutant S6
   (neutering `rejectProdTarget`) **KILLED** the test that pins both.
3. `rg -n "udeyaqnvpojbwgoaxwdg|PROD_PROJECT_REFS"` over `*.ts`/`*.mjs`/`*.sh`:
   the denylist is defined once and re-implemented nowhere; the only other hits
   are test fixtures in `burst-drill-load.test.ts` and
   `health-bundle-differential.test.ts`, both asserting refusal.
4. `rg -n "\-\-env|allowProduction|allow_production" -g 'scripts/**/*.ts'`: no
   other script carries a production selector. Two scripts mention
   `railway run --environment production` in a comment only.

Exclusions recorded: `node_modules/`, `docs/`, `.feature/`, and the `coverage/`
HTML mirrors.

## Duty 5 — operational completeness

**No alert path is in scope, and none is claimed.** The diff adds no Sentry
signal, no swallowed background failure, no worker, poller or ingress surface.
`scripts/mint-admin.ts` is an operator-invoked CLI: every terminal path prints to
stdout/stderr and maps to exit code 2, 3 or 4, and
`docs/runbooks/mint-admin.md` documents each output and each code (both tables
re-resolved above). `docs/runbooks/beta-launch-alerting.md` is untouched by the
diff and owes no new rule row. Sound search, zero findings.

## Inventory

| id | test / hunk | file | outcome |
|---|---|---|---|
| IV3-01 | `refuses a production target when --env production is not selected` | `staging-guard.test.ts:228` | killed |
| IV3-02 | same test, 2nd mutation | `staging-guard.test.ts:228` | killed |
| IV3-03 | `refuses a production target when --confirm-ref does not match` | `staging-guard.test.ts:243` | killed |
| IV3-04 | `accepts a production target under --env production with the matching ref` | `staging-guard.test.ts:277` | killed |
| IV3-05 | `refuses a confirmed ref that is not a full Supabase project ref` | `staging-guard.test.ts:184` | killed |
| IV3-06 | `leaves the other two modes production-proof — the selector is mint-mode only` | `staging-guard.test.ts:300` | killed |
| IV3-07 | `refuses when the Supabase host does not contain the confirmed project ref` | `staging-guard.test.ts:162` | killed |
| IV3-08 | `lowercases and trims the email before use` | `mint-admin.test.ts:82` | killed |
| IV3-09 | `treats a flag-shaped value as a missing value, not as the value` | `mint-admin.test.ts:102` | killed |
| IV3-10 | `preserves the auth user when the transaction outcome is ambiguous` | `mint-admin.test.ts:346` | killed |
| IV3-11 | `treats a reconciled row with a different id as a failure, not a mint` | `mint-admin.test.ts:374` | killed |
| IV3-12 | `dry run performs the refusal checks and writes nothing` | `mint-admin.test.ts:418` | killed |
| IV3-13 | `never prints a password` | `mint-admin.test.ts:451` | killed |
| IV3-14 | `commits the users row and its admin_audit_log row in one transaction` (live DB) | `mint-admin.integration.test.ts:133` | killed |
| IV3-15 | `refuses when the Supabase host does not contain the confirmed project ref` (2nd mutation) | `staging-guard.test.ts:162` | **survived-confirmed-P0** -> RT3-01 |
| IV3-16 | `refuses when the database target does not contain the confirmed project ref` | `staging-guard.test.ts:173` | **survived-confirmed-P0** -> RT3-01 |
| IV3-17 | `main()`'s `allowProduction` wiring | `mint-admin.ts:751` | inconclusive (oracle) -> RT3-02 |
| IV3-18 | `parseMintAdminArgs` accepting `--env production` | `mint-admin.ts:114` | inconclusive (oracle) -> RT3-03 |
| IV3-19 | `readMintConfig`'s production branch | `mint-admin.ts:185` | inconclusive (oracle) -> RT3-04 |
| IV3-20 | `confirmsRollback` SQLSTATE class boundary | `mint-admin.test.ts:641` | skipped-budget |
| IV3-21 | `isDuplicateEmailError` two arms | `mint-admin.test.ts:541` | skipped-budget |
| IV3-22 | `probeAuthIdentity` `to_regclass` guard | `mint-admin.test.ts:440` | skipped-budget |
| IV3-23 | `buildAdminRecoveryUrl` query parameters | `mint-admin.test.ts:164` | skipped-budget |
| IV3-24 | `formatMintReport` warning arms | `mint-admin.test.ts:717,726,741` | skipped-budget |
| IV3-25 | `resolveMintEnv` prefix mapping + empty-URL fallback | `mint-admin.test.ts:128,146` | skipped-budget |
| IV3-26 | live-DB rollback + second-mint refusal | `mint-admin.integration.test.ts:167,216` | skipped-budget |
| IV3-27 | doc / `.claude` / `.feature` hunks | `docs/**`, `.claude/reference/arch-review-log.md` | excluded |
| IV3-28 | `supabase/migrations/` | — | excluded |
| IV3-29 | Duty 5 operational completeness | `scripts/mint-admin.ts` | excluded |
| IV3-30 | Duty 4 sibling search | `scripts/staging-guard.ts` | excluded |

Every mutation's exact patch, target line and outcome is in `findings.json`'s
`reason` fields.

## Counts

inventory 30 · killed 14 · survived-confirmed-P0 2 · equivalent 0 ·
inconclusive 3 · skipped-budget 7 · excluded 4
findings 8 · P0 open 1 · P1 open 3 · P2 open 4 · accepted-risk 0 · fixed 0 ·
rejected 0

**Status `OPEN_P0`.** `OPEN_P0` takes precedence over the `INCOMPLETE_ORACLE`
that IV3-17..19 would otherwise force and the `INCOMPLETE_BUDGET` that
IV3-20..26 would.
