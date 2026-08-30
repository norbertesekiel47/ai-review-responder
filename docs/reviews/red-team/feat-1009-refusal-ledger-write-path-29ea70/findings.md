# Red team — #1009 the Refusal ledger's write path

- **Mode:** feature · **Round:** 1 · **Risk:** high
- **Branch:** `feat/1009-refusal-ledger-write-path`
- **fork / merge-base:** `0494297a0de3a9131fae1e6f2f641eb487ae7a58`
- **head:** `fc00bb9b7aa5a5f9ba9c65ee3afc97c54e4d5ec6`
- **intake sha256:** `c9490646205be56c60b7c35889d0b17c5252645d04330eda1a4f420d4288a69e`

**Mutation score — 10 planted / 9 killed / 1 survived (arbiter-reclassified equivalent).**

**Status: OPEN_P1.** No P0. Three P1, four P2. All dispositions `open`.

---

## Run preconditions — two deviations, recorded rather than waived

**W1 — the `watchers` precondition fired and was overridden on evidence.**
`mutation-runner.mjs watchers` aborted on four processes (`pnpm dev`, `next dev`,
two `next-server`). Its scan is a host-global `ps` pattern match with no worktree
discrimination. `lsof -a -p <pid> -d cwd` resolved every one outside this
worktree — three at `/Users/norbertesekiel/Developer/startups/RepWorth` (the
parent checkout) and one at `…/RepWorth-worktrees/refactor-globals-css-extraction`
(a different sibling worktree). No process serves or watches this worktree, so
the precondition holds in substance and the run proceeded. Worth telling the tool
owner: on a machine with sibling worktrees this check is unsatisfiable in
practice and will be routinely overridden, which is how a real guard rots.

**W2 — `mutation-runner run` silently disarms the live-DB lane.**
`commandEnv` sets `TEST_DATABASE_POOL_URL` only when `--test-db` is passed to
`run` itself; passing it to `dotenv-swap` is not enough, because
`REPWORTH_DISABLE_LIVE_DB_SUITES` is switched on first. My first baseline of
`write.integration.test.ts` reported **exit 0 with 4 pending and 0 executed**.
That is this run's deviation D14 reproduced inside the red-team tooling. Every
live-DB measurement below was re-run with `--test-db` and its executed/pending
counts read from the JSON report, never from the exit code.

---

## Findings

| ID | Sev | file:line | Finding |
|---|---|---|---|
| RT-1 | **P1** | `AutonomyGovernorScheduler.ts:112` · `write.ts:291` | Both new Sentry signals have no alert-rule row — neither pages anyone |
| RT-2 | **P1** | `docs/directory.md:890` | "the once-per-process Sentry warning" is FALSE and contradicts `env-vars.md` from the same commit |
| RT-3 | **P1** | `feat-1008-…-deviations.md:31` | The D16 sweep is short a FOURTH time — the summary row still says "unsettled" |
| RT-4 | P2 | `suspension.integration.test.ts:576` · `write.ts:31` | "A helper that swallowed the insert error would leave all three behind" is false; the test cannot discriminate it |
| RT-5 | P2 | `ArchivalPoller.ts:45` · intake `observability[3]` | The reconciliation query is prose-only AND wrong past day 180 by design |
| RT-6 | P2 | intake `rollback_plan` | Layers 2 and 3 contradict: the revert removes the sweep layer 3 relies on |
| RT-7 | P2 | `write.test.ts:295` | Promised title says "per process"; the shipped semantic is per disabled episode |

---

### RT-1 (P1) — two new Sentry signals, zero alert-rule rows

This branch adds two Sentry emissions:

- `AutonomyGovernorScheduler.ts:112` — `Sentry.captureException(error, { tags: { subsystem: 'autonomy_governor' }, … })`
- `write.ts:291` — `Sentry.captureMessage(…, { level: 'warning', tags: { subsystem: 'refusal_ledger', flag: … } })`

`docs/runbooks/beta-launch-alerting.md` is **unchanged by this branch**
(`git diff --stat` on that path is empty). Its §1a-do table carries exactly six
rules and every one keys on an explicit tag VALUE — `subsystem` = `health_alert`,
`cost_event` = `limit_exceeded`, `feature` = `stripe_reconciliation`, `subsystem`
= `import_consent_analytics`, `finding` = `solicitation_send_breaker_tripped`,
`feature` = `solicitation_lane`. There is no catch-all rule, and no §1 checklist
bullet was added. Neither `subsystem:autonomy_governor` nor
`subsystem:refusal_ledger` matches anything.

This is Duty 5's emitted-signal-with-no-rule-row half. Each signal's own stated
rationale sharpens it:

- The Governor comment (`AutonomyGovernorScheduler.ts:99-105`) justifies the
  capture with *"nothing else pages for it"*. With no rule row, adding the
  capture changes nothing about paging — the account still stays un-suspended,
  silently, every 15-minute cycle, on the autonomy safety lane.
- `env-vars.md`'s flag row calls the ledger warning *"the ONLY evidence a ledger
  gap exists, because the ledger structurally cannot show its own absence."* An
  un-routed warning is not evidence anyone sees.

**All six facets compared.** Signal identity and filter: no matching rule.
Level: `error` (Governor), `warning` (ledger). Grouping title: the Governor's is
the error message (varies); the ledger's is a constant string. Threshold/cadence:
the Governor rule needs a FREQUENCY trigger, not first-seen — the runbook already
spells out this reasoning for rules 4/5/6, and a repeated identical candidate
failure groups into one issue, so first-seen fires once then stays silent through
exactly the repetition that is the signal. Destination: the `#repworth-alerts`
Discord action every existing rule uses.

Comparison is STATIC, per the skill. No staging delivery drill was run.

---

### RT-2 (P1) — `docs/directory.md` states the opposite of `env-vars.md`, in one commit

`docs/directory.md:890` (the new `write.ts` row):

> …and **the once-per-process Sentry warning** with its cooldown latch…

`.claude/reference/env-vars.md:551`, added by the same commit:

> Off also emits **one warning per DISABLED EPISODE** — **not per process**: the
> latch clears the next time the helper observes the flag enabled, so a
> `false → true → false` sequence warns twice.

The code implements per-episode: `write.ts:235-238` (`endDisabledEpisode`) called
unconditionally on the enabled path at `write.ts:364`. Two tests pin it
(`write.test.ts:268` and `:442-454`), and mutation **M4** — removing that call —
was killed by `write.test.ts:268`, so the behaviour is measured, not asserted.

Per CLAUDE.md's "Where things live" table `env-vars.md` is the authority for
per-flag behaviour, so `directory.md` is the wrong one. But per-process silence
is *precisely the defect a branch-review round corrected*, and `directory.md` is
the code map — the file a future agent reads before touching `refusals/`. A
reader taking it at face value concludes the second outage is silent for the life
of the worker.

P1 rather than P0 because `directory.md` is not the authoritative owner of this
fact and the correct statement is present in the same commit. The owner may
reasonably escalate.

---

### RT-3 (P1) — the D16 sweep is short a fourth time

D12 records the sweep table being short three times. There is a fourth.

`docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md:31`
— that file's own summary table, at HEAD, unchanged by this branch:

> `| D16 | The write-site split point is **unsettled**, and two attempts to
> settle it were wrong | **ACCEPT** | 3-to-3, not 3-to-1; resolved by DECLINING
> to resolve it — #1009's PR is what knows. |`

The branch appended its "CLOSED by #1009" paragraph to the `## D16` **section**
(line ~497), roughly 470 lines below the row that indexes it. The plan's §0
sweep table gives this file the disposition **"APPEND ONE CLOSING LINE"**, so the
branch executed its plan faithfully — the *disposition itself* is the incomplete
instruction, which is exactly D12's lesson recurring.

The strongest evidence that this is a miss rather than a judgement call sits
thirteen lines below the stale row, in the same file:

> **This table has itself been a D15 casualty twice** — it claimed "Thirteen
> entries" while D14 and D15 sat below it untriaged, and the count went stale
> again when D16 landed. **A new deviation adds a ROW here, not just a section.**

The sweep's stated goal — plan §0 and the arch-review-log entry — is that *"a
reader following any pointer above lands here and must find the answer."* A
reader landing on this file reads the summary table first and is told the point
is unsettled.

**The rest of the sweep verified clean.** All five living docs
(`arch-review-log.md`, `migrations-log.md`, `lab-notes.md`, `currents.md`,
`progresstracking.md`) state the settlement consistently and on the same two
grounds (#1004's slice order, #1009 ticket §5). The arch-review-log's count word
**"Six artifacts were swept and eight deliberately left alone"** checks out
against §0's table (5 living docs + 1 appended paragraph; 8 do-not-touch rows).
`feat-1008-…-plan.md:436` still says "unsettled" but sits inside `## Not in this
PR` under a correct do-not-touch disposition.

---

### RT-4 (P2) — a false rationale, and a guard that cannot be measured

Mutation **M9** wrapped `write.ts`'s INSERT in `try { … } catch { return; }` —
the exact behaviour the module docblock (`write.ts:29-37`) forbids. The covering
test at `suspension.integration.test.ts:555` **still passed.**

**Arbiter finding: the mutation is observably EQUIVALENT**, so it is not a P0.
postgres.js 3.4.9's `scope`
(`node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js:290-296`)
attaches `q.catch(e => uncaughtError || (uncaughtError = e))` to **every** query
issued on the transaction handle and then does `if (uncaughtError) throw
uncaughtError` after the caller's callback resolves. A catch inside the callback
is structurally a no-op: the original `PostgresError` is re-raised and `rollback`
runs regardless. Read at source, not assumed.

Two claims are therefore false:

1. `suspension.integration.test.ts:576-578` — *"A helper that swallowed the
   insert error would leave all three behind and a green caller."* It would not,
   and this test would not notice.
2. `write.ts:31-36` — *"Catching would hide a writer bug in the one place the
   ledger cannot report it."* Catching cannot hide it; the library re-raises.

The test's other claim — *"one that opened its own connection would leave them
behind too"* — is also not discriminated by this fixture, since the forced insert
fails on either connection and leaves nothing behind either way.

**Behavioural replacement:** none needed — the invariant is unfalsifiable under
postgres.js, which is a *good* property. Delete the two false sentences and state
what is true: the no-catch style is a readability decision and postgres.js
enforces the outcome.

The candidate row was resolved by **M9b** (deleting the `writeRefusalEvent` call
from `suspension.ts`), which killed the same test — so it is not a
could-not-fail test.

---

### RT-5 (P2) — the reconciliation query is prose-only and diverges by design

The intake's `observability[3]` promises a per-account equality between
`refusal_events` (`refusal_source = 'autonomy_suspended'`) and
`account_audit_log` (`event_type = 'autonomy_suspended'`), and asserts *"A
divergence means either the flag is off or a write is failing."*

**It exists nowhere runnable.** `rg "refusal_source = 'autonomy_suspended'"`
across the repo returns only two test files and the intake itself — no runbook
section, no `scripts/` artifact, no admin surface. A reviewer already flagged
this; confirmed.

**As written it is wrong past 180 days.** `refusal_events` is swept at
`REFUSAL_LEDGER_RETENTION_DAYS = 180` (`ArchivalPoller.ts:45`).
`account_audit_log` has **no** `ArchivalPoller` arm and is retained indefinitely
(`rg "account_audit_log" worker/background/pollers/ArchivalPoller.ts` → no
match). Over any window older than 180 days the counts diverge *by design*, and
the quoted sentence is false there. `ArchivalPoller.ts:36-38` acknowledges the
ledger is shorter-lived than its sources, but the query's ≤180-day bound is
stated nowhere.

Judgement: modest. The lane ships two real observability halves — the `Archived`
count and the batch-limit name — both mutation-verified (M7 killed). The
reconciliation query blocks nothing today, but the bound should be written down
wherever it lands.

---

### RT-6 (P2) — the rollback plan contradicts itself

- Layer 2: *"PR revert on main plus a redeploy — this removes the helper, the
  caller, **the poller arm** and the scheduler's Sentry sink together."*
- Layer 3: *"Rows already written are not deleted by a rollback; **the 180-day
  sweep retires them**."*

After the layer-2 revert there is no 180-day sweep — layer 2 deleted it. Rows
written before the revert sit in `refusal_events` with unbounded retention.

P2 rather than P1: the rows are UUIDs, enum strings and timestamps only (no free
text, no PII), the table has deny-all RLS, and #1008's offboarding purge still
hard-deletes `refusal_events` per account, so an owner deletion request is
unaffected. The rest of the rollback claim verified TRUE — layer 1's flag flip is
byte-identical for suspension, audit and notification
(`suspension.integration.test.ts:524` asserts the policy, the audit row and both
outbox rows survive with zero refusal rows), and "no migration 117" is correct.

---

### RT-7 (P2) — a promised test title names the semantic the branch replaced

`write.test.ts:295` — *"…emits exactly one Sentry warning **per process** while
the kill switch stays off"*. The shipped bound is per DISABLED EPISODE. The body
exercises only one episode (five disabled calls, no toggle), so the case is
correct as written and is not fake coverage. But the title is frozen by
`promised-tests` and by the intake's `observability[0]` (*"once per process"*),
and it is the same stale phrase that produced RT-2's false `directory.md` claim.
The intake is sha-locked; a deviation entry noting the divergence is the fix.

---

## Duty 2 — fragile assertions: sound search, nothing found

Scanned all nine changed test files for absence-of-tag proxies, exact string
counts on rendered output, order assertions with no ordering contract,
`toContain` where `toEqual` is meant, `toBeGreaterThan` where "exactly one" is
the claim, and fixtures whose values coincide. Nothing qualifying. Specifically
checked and cleared:

- **Every SQL-text assertion has a live partner.** `write.test.ts:349`
  (byte-for-byte `ON CONFLICT`) pairs with `write.integration.test.ts:202`, and
  M1 killed the live one with a real `42P10`.
  `ArchivalPoller.integration.test.ts:573` (source-text `ORDER BY`) pairs with
  the crossed-clock case at `:554`, and M6 killed that one.
- **`toBeGreaterThan` is explicitly rejected where it would mask.**
  `suspension.integration.test.ts:469` uses `toHaveLength(1)` against a
  two-business fixture and names `toBeGreaterThan` as the defect it exists to
  catch.
- **Fixture values are distinct.** `ArchivalPoller.test.ts:120` gives all eleven
  targets distinct counts (10/20/5/100/50/7/3/9/11/13/17), so a dropped key
  cannot be masked by a sibling's value.
- **Both migration parsers throw on no-match.** `vocabulary.test.ts:90`, `:102`
  and `write.test.ts:130` raise rather than returning `undefined`, so a parse
  that silently matched nothing cannot make a case vacuous.
- **The eval-completeness guard is not self-defeating.** `EVAL_FILES` is pinned
  to 9 and deduped, the scan runs and throws at module scope independently of the
  case, its nine entries match `git diff --name-only` exactly, and a positive
  control proves the marker pattern can match.

## Duty 4 — missed sibling cases: patterns, scope, exclusions

**Patterns searched:** `toHaveLength\(`, `toHaveBeenCalledTimes\(`, `Ten
|Eleven |ten arms|eleven|seven lanes|eight categories|six rules|all six|eleven
call sites`, `ALLOWLIST_BASELINE`, `D16`, `refusal_source =
'autonomy_suspended'`, `account_audit_log` (against `ArchivalPoller.ts`),
`subsystem'`. **Scope:** whole worktree at HEAD. **Exclusions:** `node_modules/`,
`.feature/`.

**Result — one hit (RT-3).** Everything else cleared:

- `ArchivalPoller` 10 → 11: the prose at `ArchivalPoller.ts:55`, three test
  titles, the `queueArchivalResults` fixture and
  `expect(mockSql).toHaveBeenCalledTimes(11)` all moved together.
- `suspendAccountAutonomy` 5 → 6 statements: `suspension.test.ts:38` moved. The
  five other `toHaveLength` assertions in that file are on unaffected paths and
  the suite is green. No other caller (`JudgeWorker`,
  `AutonomyGovernorScheduler`, `solicitation-settings.ts`,
  `/api/admin/autonomy/unsuspend`) carries a statement-count assertion crossing
  this transaction.
- `ALLOWLIST_BASELINE` 370 → 371 with a matching `sqlSnippet`; `ci:tenant-scope`
  re-derived PASS at HEAD.
- Count words "eleven call sites" / "ten remain" / "seven lanes" / "eight
  categories" / "Six swept, eight left alone" all cross-check.
- No test or audit script enumerates Sentry `subsystem` tag values — which is why
  nothing would have caught RT-1.

## Duty 3 — docs vs reality

`grill-me-codex/scripts/prevalidate-plan.py` was **not** used; every citation was
hand-checked against HEAD, and I say so here as the skill requires.

- `env-vars.md` `REFUSAL_LEDGER_ENABLED`: per-episode claim TRUE (code + M4);
  "byte-identical suspension/audit/notification" TRUE
  (`suspension.integration.test.ts:524`); the `@sentry/node` "queued, not
  delivered" claim matches the installed 10.55.0 behaviour and the no-`flush()`
  decision; `REFUSAL_LEDGER_RETENTION_DAYS` correctly described as a code
  constant with no registry row, and `ci:env-registry` PASSes.
- `docs/directory.md` `refusals/` rows: accurate except RT-2.
- The plan's §2.2b claim that `NOW()` is `transaction_timestamp()`: **TRUE, now
  measured twice** — `write.integration.test.ts:242` asserts it against a live
  Postgres, and M2 (`NOW()` → `statement_timestamp()`) killed that case.
- D16 sweep: consistent across all five living docs; incomplete only at RT-3.
- CI audits re-derived at HEAD, all PASS: `ci:tenant-scope`, `ci:directory-map`,
  `ci:env-registry`, `ci:static-policy`, `ci:outbox-seam`, `ci:db-imports`,
  `ci:live-db-suites`.

## Duty 5 — operational completeness

- **Alert path:** RT-1. Both halves checked in both directions; no orphan rule
  row was introduced either.
- **Rollback:** RT-6. Flag flip and "no migration 117" verified TRUE.
- **Flag OFF byte-identical:** TRUE for suspension, audit and notification. Not
  byte-identical in *observability* — the OFF path now emits a log line and a
  Sentry capture that did not exist before — but every document scopes the claim
  to behaviour, correctly.
- **Logging of review bodies, tokens or PII — sound search, nothing found.**
  `write.ts:281` logs only the flag name. `AutonomyGovernorScheduler.ts:97` logs
  `account_id` (a UUID) and `error_name` (a class), never `error.message`. The
  new `Sentry.captureException(error, …)` does carry the error, and postgres.js
  `PostgresError` can hold bound values in `detail`/`where` — but
  `worker/sentry.ts` enables no `extraErrorDataIntegration`, so Sentry serializes
  only `message` + `stack`, and Postgres puts failing-row values in `DETAIL`, not
  in the message. `refusal_events` itself stores only UUIDs, enum strings and
  timestamps. No finding.

---

## Mutation log

| # | Mutation | Target case | Outcome |
|---|---|---|---|
| M1 | `write.ts:406` — drop `WHERE subject_id IS NOT NULL` from `ON CONFLICT` | `write.integration.test.ts:202` | **killed** (live `42P10`) |
| M2 | `write.ts:336` — `NOW()` → `statement_timestamp()` | `write.integration.test.ts:242` | **killed** |
| M3 | `suspension.ts:333` — `businessId: null` → a uuid string | `pnpm typecheck` | **killed** (`TS2345`) |
| M4 | `write.ts:364` — remove `endDisabledEpisode()` | `write.test.ts:268` | **killed** |
| M5 | `write.ts:280-307` — fold `logger.warn` inside the Sentry `try` | `write.test.ts:314` | **killed** |
| M6 | `ArchivalPoller.ts:394-396` — sweep `created_at` in WHERE + ORDER BY | `ArchivalPoller.integration.test.ts:554` | **killed** |
| M7 | `ArchivalPoller.ts:433` — drop `refusal_events` from the Archived log | `ArchivalPoller.integration.test.ts:614` | **killed** |
| M8 | `AutonomyGovernorScheduler.ts:111-118` — remove the swallowing guard | `AutonomyGovernorScheduler.test.ts:433` | **killed** |
| M9 | `write.ts:380-408` — catch the INSERT error and return | `suspension.integration.test.ts:555` | **SURVIVED → equivalent** (RT-4) |
| M9b | `suspension.ts:319-345` — delete the write site | `suspension.integration.test.ts:555` | **killed** (resolves M9's row) |

The full inventory, including the fourteen excluded candidates and their reasons,
is in `findings.json`.

## Authorizations

None.
