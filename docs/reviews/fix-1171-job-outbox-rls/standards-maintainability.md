# Standards & maintainability review — `fix-1171-job-outbox-rls`

- Merge base: `602e98930810177230c0edbc0830063db5f75d43`
- HEAD: `3a7d0ca9930ae60c5ebbafb25cd962675d751e78`
- Diff: 6 files, +683 / −1. Three effective SQL statements, one new read-only
  live-DB suite (255 lines), two `.claude/reference` entries, two plan
  artifacts. No production TypeScript, no dependency, no flag.
- Axis: standards, seam placement, locality, duplication, speculative
  generality, error handling, test coupling, naming, comment-to-code ratio,
  dependency growth.

Read for this review: `.claude/CLAUDE.md`, `.claude/rules/live-db-tests.md`,
`.claude/skills/new-migration/SKILL.md`, the deviations doc,
`docs/reviews/finding-checklists/standards-maintainability.md`, and the named
precedents — `supabase/migrations/{092,101,107,109,114,116,117,118}*.sql`,
`src/lib/shared/__tests__/migration-{116,117}-*.integration.test.ts`,
`src/lib/shared/__tests__/helpers/schema-ready.ts`, `scripts/test-db-setup.sh`,
`scripts/ci/live-db-suites-audit.ts`.

---

## Findings

| # | Severity | file:line | Finding |
|---|---|---|---|
| F1 | medium | `supabase/migrations/119_job_outbox_rls.sql:39` | "production has run **this exact posture** for five months" is contradicted by the same header's lines 13–14 and 72 — prod has never had the REVOKE |
| F2 | medium | `supabase/migrations/119_job_outbox_rls.sql:78` | The `SET` vs `SET LOCAL` justification mis-states its own cited precedent: 109 and 114 wrap in `BEGIN;`/`COMMIT;`, where `SET LOCAL` is fully effective; 088 is the sole unwrapped file |
| F3 | medium | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:119` | The widened-REVOKE mutation guard is case-sensitive and misses `SERVICE_ROLE`, lowercase `public`, and `Postgres` — 3 of 5 realistic mutations |
| F4 | medium | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:76` | The `SchemaRequirement` is vacuous and its comment names a "provisioning-marker path" that does not exist; `schema-ready.ts` records 094/097 as the house answer for an object-free migration |
| F5 | low | `.claude/reference/arch-review-log.md:94` | New entry has no blank line before it, so it renders glued to the 2026-09-06 entry as one paragraph; every neighbour is blank-separated |
| F6 | low | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:9` | The drift/provenance narrative is a fourth verbatim copy of facts owned by the migration header; 116's and 117's suite headers deliberately do not do this |

---

## F1 — [medium] The header's strongest safety claim covers only half the migration

**Standard violated:** "no silent catches / no claim without an oracle";
accepted-checklist class *"the shipped comment's stated condition is
incomplete"* and *"a comment that names the wrong mechanism teaches the next
reader to test the wrong thing"*.

**Evidence.** `supabase/migrations/119_job_outbox_rls.sql:38-40`:

> `service_role` additionally carries BYPASSRLS. **The strongest evidence is
> empirical: production has run this exact posture for five months.**

The same header, 25 lines earlier (13–14), says:

> and on **BOTH** projects `anon` and `authenticated` still hold the Supabase
> default table privileges.

and 33 lines later (72):

> **The revoke is a real change on both projects.**

So the posture production has run for five months is *RLS enabled, zero
policies, client roles still granted* — not the posture 119 establishes. The
empirical evidence is real and load-bearing for the `ALTER`; it says nothing
about the `REVOKE`, which is the statement that actually changes production.
The claim is restated in `.claude/reference/migrations-log.md:2702-2704`
("Convergence is UPWARD, toward the posture prod has run without incident since
2026-04-05 — that five months is the strongest safety evidence the change has")
and `.claude/reference/arch-review-log.md:94`.

This matters because it is the safety argument a reader will lean on when
deciding whether the prod apply is low-risk. The REVOKE's real precedent is
117/118 — and those are *new* tables with no live consumers, which is a weaker
analogy than the sentence implies, not a stronger one.

**Smallest correction.** Narrow the sentence to what it supports, in all three
copies:

> Production has run the RLS half — enabled, zero policies — without incident
> since 2026-04-05. The REVOKE is new on both projects; its precedent is the
> identical revoke on `admin_audit_log` (117) and `poller_heartbeats` (118),
> and its proof here is the post-apply introspection recorded on the PR.

---

## F2 — [medium] The `SET` / `SET LOCAL` decision rests on a mis-read of its own precedent

**Standard violated:** working rules — *"name the precedent; an unrecorded
departure reads as an unconsidered one"*; accepted-checklist class *"comment
states a FALSE mechanism"*.

**Evidence.** `supabase/migrations/119_job_outbox_rls.sql:78-83`:

> Session-scoped, NOT `SET LOCAL`: `scripts/test-db-setup.sh` applies each
> migration file through psql outside a transaction block, where `SET LOCAL`
> warns and does nothing. […] (092/101 precedent).

Restated at `.claude/reference/migrations-log.md:2684-2688` — "092/101
precedent, **not 088/109/114's**" — and as deviation D3.

Measured over the tree at HEAD, the eleven migrations that use
`SET LOCAL lock_timeout` and whether they open with `BEGIN;`:

| Migration | `BEGIN;` present |
|---|---|
| 083, 091, 104, 105, 108, **109**, 110, 111, **114**, **116** | yes |
| **088** | **no** |

Ten of eleven wrap the file in an explicit transaction, where `SET LOCAL` is
fully effective and emits no warning. 088 is the single outlier — and 088 is
exactly the file whose "pre-existing warning" D3 records as not being this
branch's. So the two files the note names as evidence that `SET LOCAL` is
broken in this repo's psql path (109 and 114) are files where it demonstrably
is not broken.

The repo's own dominant answer to psql autocommit is the transaction block, and
114's header states the reason in its own words
(`supabase/migrations/114_solicitation_attribution.sql:25-27`):

> psql autocommits each statement, so on a re-run an unwrapped DROP CONSTRAINT
> that succeeds followed by an ADD that fails would leave
> `solicitation_outreach` with NO attribution consistency constraint at all.

116 — the nearest deny-all-RLS precedent and the most recent lock_timeout
migration — is `BEGIN;` / `SET LOCAL lock_timeout = '10s';` / … / `COMMIT;`.
117 and 118 take no lock_timeout at all (they `CREATE TABLE`; nothing to
contend with), so they are not precedents on this point either way.

To be explicit about what is *not* wrong: bare `SET lock_timeout = '5s'` is
functionally correct here. `scripts/test-db-setup.sh:80` emits `RESET ALL;`
after every include, so nothing leaks between files, and under Supabase
`apply_migration` the statement is transaction-scoped anyway. The defect is the
recorded reasoning, which will be read by the author of migration 120 and will
teach them that `SET LOCAL` is unusable in this repo.

**Smallest correction — pick one:**

1. *Preferred, matches 114/116:* wrap the three statements in `BEGIN;` /
   `COMMIT;` and restore `SET LOCAL lock_timeout = '5s'`. Cost: two lines. Gain
   beyond precedent-conformance: the `ALTER` + `REVOKE` + `COMMENT` become
   atomic in the psql path, and the session-level leak disappears.
2. *Minimum:* keep bare `SET` and correct the three copies of the reason to
   name **088** — the one unwrapped file — instead of "088/109/114", and state
   that the departure from 114/116's transaction block is deliberate and why.

---

## F3 — [medium] The mutation guard the branch calls its only real REVOKE proof has a case hole

**Standard violated:** accepted-checklist class *"a test whose comment promises
a guarantee the assertion does not provide"* / guard-shaped fix with a hole.

**Evidence.** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:113-119`:

```
// The dangerous mutation is a WIDER revoke, not a missing one: stripping
// `postgres` or `service_role` would stop every worker in the platform, …
const revokes = text.match(/^\s*REVOKE\b.*$/gim) ?? [];
expect(revokes).toHaveLength(1);
expect(revokes[0]).not.toMatch(/\b(postgres|service_role|PUBLIC)\b/);
```

The line-extraction regex carries `i`; the role guard does not, and its
alternation mixes cases (`postgres` and `service_role` lowercase-only, `PUBLIC`
uppercase-only). Unquoted SQL role names fold to lower case and `PUBLIC` is a
case-insensitive keyword, so all of the following are valid, catastrophic, and
pass both assertions. Measured against the shipped regex:

| Mutation | Caught |
|---|---|
| `REVOKE ALL ON job_outbox FROM anon, authenticated, service_role;` | yes |
| `REVOKE ALL ON job_outbox FROM anon, authenticated, SERVICE_ROLE;` | **no** |
| `REVOKE ALL ON job_outbox FROM PUBLIC;` | yes |
| `REVOKE ALL ON job_outbox FROM public;` | **no** |
| `REVOKE ALL ON job_outbox FROM Postgres;` | **no** |

Three of five slip through — including `FROM public`, which is the spelling a
human is most likely to write. This is load-bearing precisely because D2 and
D5 both moved the REVOKE's guarantee *onto* this case after the catalogue
assertion was found vacuous locally: it is the only guard the branch claims
holds in every environment.

**Smallest correction.** One flag and one case fold:

```ts
expect(revokes[0]).not.toMatch(/\b(postgres|service_role|public)\b/i);
```

---

## F4 — [medium] Vacuous `SchemaRequirement`, justified by a mechanism that does not exist

**Standard violated:** "no abstractions for a single caller" is satisfied, but
*"a comment that names a false mechanism"* is not; and the repo has a
documented answer for this exact case that the branch departs from without
recording the departure.

**Evidence.** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:75-80`:

```
// 119 creates nothing, so the only object it can name is the table it hardens.
// Kept for the provisioning-marker path, not as proof the migration ran.
const MIGRATION_119_JOB_OUTBOX_RLS: SchemaRequirement = {
  migration: '119_job_outbox_rls',
  tables: [TABLE],
};
```

`assertSchemaReady` (`src/lib/shared/__tests__/helpers/schema-ready.ts:564-596`)
runs exactly five presence checks — tables, columns, indexes, constraints,
column types. It never reads `test_meta.provision`. A repo-wide grep for
`test_meta` finds one reader outside `scripts/test-db-setup.sh` itself:
`scripts/ci/rls-audit.ts:145`. There is **no provisioning-marker path** in any
test helper, so the comment attributes a purpose the call does not have. What
the call actually does is `SELECT table_name … WHERE table_name IN
('job_outbox')` against a table that has existed since 001 — it can only fail
on a container with no schema at all.

The house answer for an object-free migration is already written down, in the
same helper the branch imports (`schema-ready.ts:314-317`):

> 097 (the analytics CHECK swap) gets no requirement of its own: it adds no
> relation, column or index, and its constraint NAME has existed since 046 —
> presence would prove nothing. **Its suite inspects the migration SQL text
> instead, exactly as 094's does.**

That is 119's situation verbatim, and the branch already implements the second
half (the file-text cases). Only the requirement is surplus. The same file at
:427-443 and :450-464 names this the "false-proof hazard" and 105's/108's
entries record it as a trap.

D4 reached the right conclusion (do not extend `assertSchemaReady` for one
caller) but stopped one step short of the precedent's conclusion.

**Smallest correction.** Fix the load-bearing half — replace line 76 with what
the call does:

```
// job_outbox has existed since 001, so this proves only that the container is
// provisioned at all — never that 119 ran. 094/097 (schema-ready.ts:314) is
// the precedent for an object-free migration: the file-text cases below and
// the BEHIND_HEAD message on title 1 are the real detectors.
```

Deleting the constant and the `assertSchemaReady` call outright (the 094/097
shape) is also defensible; the suite already carries `BEHIND_HEAD` on the case
that matters.

---

## F5 — [low] The arch-review-log entry is glued to its predecessor

**Standard violated:** "follow the format of its neighbours".

**Evidence.** `.claude/reference/arch-review-log.md`:

```
91 | 2026-09-06 — **feat/marketing-five-jobs (pre-merge):** …
92 |
93 | 2026-09-06 — **feat/pricing-five-jobs (pre-merge):** …
94 | 2026-09-07 — **fix-1171-job-outbox-rls (pre-merge):** Migration 119 …
95 |
```

Every other entry in the section (lines 84–93) is separated by a blank line. In
Markdown, lines 93–94 render as a single paragraph, so the new entry loses its
own visual break in the rendered log.

Two things checked and found **not** to be defects: entry prose format matches
its neighbours exactly (`DATE — **branch (pre-merge):** …`, closing with
"Counter unchanged until merged"), and the dash-form branch name
`fix-1171-job-outbox-rls` is the real branch name (`git branch --show-current`),
not a typo for a `fix/` slug.

The parallel check on `migrations-log.md` came back clean: the 119 entry also
has no blank line before 118, but so do 118, 117, 115 and 111 — that file's
established shape is a tight list, and the entry conforms.

**Smallest correction.** Insert one blank line at
`.claude/reference/arch-review-log.md:94`.

---

## F6 — [low] The suite header is a fourth copy of a narrative with three owners

**Standard violated:** `.claude/CLAUDE.md` — *"one authoritative owner per
fact"*; duplication.

**Evidence.** `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:9-21`
("── the drift it closes ──") restates the two Supabase project IDs, both
provisioning dates, the `ensure_rls` trigger provenance, migration 107's
deferral, and the `anon`-INSERT + `OutboxPoller` attack. Every one of those
facts is already stated at full length in three other places in this diff:
`supabase/migrations/119_job_outbox_rls.sql:3-30`,
`.claude/reference/migrations-log.md:2689-2704`, and
`.claude/reference/arch-review-log.md:94`.

The precedent is against it. `migration-117-admin-audit-log.integration.test.ts:1-12`
is a 12-line header that says only what the suite guards, that it runs no DDL,
and why it takes the lock — it does not restate 117's rationale. 116's longer
header (46 lines) is spent on content that exists nowhere else: a per-title
guide to which of three assertion styles each case uses and why. 119's header
is 51 lines, of which lines 23–50 are in that unique-content category and are
worth their space; lines 9–21 are not.

On the migration file itself: at 83 comment lines to 5 code lines (16.6:1)
versus 118's 6.7:1 and 117's 2.6:1, 119 is the densest header in the tree — but
the content is genuinely non-obvious (the FORCE trap, the owner-exemption
argument, the registry decision, the lockstep instruction) and duplication with
the migrations-log entry is house standard, visible in 117 and 118 alike. I do
**not** report the migration header as padding. No comment block in the
migration restates what its adjacent statement says; the closest is line 87-88
("Deliberately NO policies: deny-all…"), which is copied verbatim from 117:66-67
and 118:79-80 and is therefore the convention.

**Smallest correction.** Replace lines 9–21 with one pointer:

```
// Drift, provenance and the safety argument: the header of
// supabase/migrations/119_job_outbox_rls.sql. Not restated here.
```

---

## Evaluated and found clean

Recording these so a later reader can tell "checked" from "not looked at".

**Live-DB conventions (`.claude/rules/live-db-tests.md`, `ci:live-db-suites`).**
Named `*.integration.test.ts` (R1). Executes no DDL (R2) — every case reads
`pg_class` / `pg_policies` / `has_table_privilege` or the checked-in file; the
file is correctly absent from `MIGRATION_SHAPE_FILES` and `DDL_PROBE_FILES`,
neither of which it needs. Takes the cross-process live-DB lock in `beforeAll`
before opening the pool, with `LIVE_DB_LOCK_HOOK_TIMEOUT_MS` on both hooks.
Teardown releases the lock in a `finally` so a failed `db.end` cannot strand it,
and clears `featureDatabaseLock` — the 117 shape. Connection options
(`prepare: false`, `statement_timeout: 30_000`) match 117; `max: 2` versus 117's
`max: 4` is right for a suite that seeds nothing. The two DB-free `describe`
blocks sit outside `describeWithDb`, so they fail rather than silently skip on a
keyless run — the rule 116's header states and 117 follows.

**Seam placement.** The suite is in `src/lib/shared/__tests__/` alongside
migrations 100–117's suites; the registry import path
(`../../../../scripts/ci/tenant-tables`) is byte-identical to 117's. The
`REVIEWED_NOT_TENANT_SCOPED` / `TENANT_TABLES` assertion is the same two-line
shape as 117:71-76.

**Speculative generality.** None found. D4 declined to add an `rlsEnabled`
requirement kind to `assertSchemaReady` for a single caller — correct under "no
abstraction before the second use". No new helper, no new export, no new
top-level anything. `sql()` and the module-level `db` are the precedented shape.

**Dependency growth.** Zero. No package added; no new import beyond what 117
already uses.

**Error handling.** No production TypeScript in the diff. The suite's failure
messages are actionable (`BEHIND_HEAD` names `pnpm test:db:setup`).

**`COMMENT ON TABLE job_outbox` (:91-92).** Checked for the two hazards. It
replaces nothing — grep over `supabase/migrations/` finds no prior
`COMMENT ON TABLE job_outbox`; 012 sets a `COMMENT ON COLUMN
job_outbox.status`, which a table comment does not disturb. And naming a
registry in a table comment has precedent: 118:72-73 names `TABLE_DISPOSITIONS`
in exactly this way. The one durable-staleness risk is the clause "is
`REVIEWED_NOT_TENANT_SCOPED` rather than a `TENANT_TABLES` member", whose owner
is `scripts/ci/tenant-tables.ts` and which nothing checks against the DB
comment — but that is 118's accepted risk too, so it is not a departure and I
do not report it.

**The 78-file and zero-`from()` claims.** Both re-measured at HEAD: `rg -l
job_outbox src worker` excluding tests → **78**; `rg "from\('job_outbox'\)" src
worker` → **zero matches**. The migrations-log and arch-review-log entries are
accurate on both.

**Registry decision.** Keeping `job_outbox` out of `TENANT_TABLES` is right and
is recorded in three places with the measurement behind it. `ci:tenant-scope`
would demand an `account_id`/`business_id` predicate on 78 files' bindings of a
table with neither column.

**`new-migration` skill checklist.** Numbering (head 118 → 119, log head line
bumped), header comment, `lock_timeout` on a hot-table `ALTER`, staging-first
lockstep instruction, introspection-not-ledger verification, migrations-log head
+ entry, arch-review-log row: all present. The retention-table and
four-registry obligations do not apply (no new table, no tenant table). No JSONB
column, so no parse-site allowlist entry owed.

**Test coupling.** The file-text assertions are literal-ish regexes over a file
that becomes immutable at promotion, which is the 117 pattern. They carry the
same latent fragility as 117's (`not.toMatch(/CREATE POLICY/i)` would fail on a
future comment containing that phrase), but that is inherited convention, not a
new defect.

---

## Low-confidence appendix (not reported in the table)

- **Test-title prefix redundancy.** Five of six `it` titles begin "migration
  119 …" inside describes already named "migration 119 registries" /
  "migration 119 job_outbox deny-all RLS", so full names read "migration 119
  job_outbox deny-all RLS > migration 119 enables row level security on
  job_outbox …". 117's titles do not repeat their describe. I did not report it
  because D2 records that these titles are the intake's promised
  `tests_to_add` strings, and retitling them would need another intake edit for
  a cosmetic gain.
- **`BEHIND_HEAD` (:73) has one caller** (:171). A single-use constant is
  arguably below the extraction bar, but it names the message so it can be
  found from the suite header's cross-reference, which is a fair trade.
- **`readFileSync` runs twice** (:109 and :123) for the same file in adjacent
  cases. 117 reads once. A shared `const text` at describe scope would be a
  module-scope read, which 116's header explicitly warns against (it throws at
  collection time); a small local helper would be the clean form. Too minor to
  bill.
- **`/^\s*REVOKE\b.*$/gim` does not exclude comment lines.** In practice safe —
  every comment line in the file begins `--`, which `^\s*REVOKE` cannot match —
  but the guard would count a `/* … */` block containing a line starting with
  "revoke". No such block exists and none is likely.
- **The `SET lock_timeout` value is 5s** where 116 (the nearest RLS precedent)
  uses 10s and 088/104/105/108/109 use 3s. Nothing in the tree establishes a
  rule, and `job_outbox` being the hottest table argues for the shorter bound,
  so I read 5s as a considered choice rather than a drift.
