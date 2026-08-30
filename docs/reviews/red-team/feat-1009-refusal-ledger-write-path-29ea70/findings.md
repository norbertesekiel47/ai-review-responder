# Red team — #1009 the Refusal ledger's write path — ROUND 2 (final)

- **Mode:** feature · **Round:** 2 of a hard cap of 2 · **Risk:** high
- **Branch:** `feat/1009-refusal-ledger-write-path`
- **fork / merge-base:** `0494297a0de3a9131fae1e6f2f641eb487ae7a58`
- **head:** `2f57af488515d764b25bc8ab6f9e5342faef534f` (round 1 ran at `fc00bb9b7aa5a5f9ba9c65ee3afc97c54e4d5ec6`)
- **intake sha256:** `2d04d7353300d4b544d1b8e2687bc0e48d2ca8e8a931af7ecc5d1bae96583eaf`
  (round 1's `c9490646…` is superseded; the intake was amended twice since)

**Status: OPEN_P1.** No P0. Round 1's seven findings: **5 fixed, 1 accepted-risk
(owner-authorized), 1 open (half-fixed).** Four NEW findings, all inside the fix
hunks or the artifacts they were supposed to sweep: **1 P1, 3 P2.**

Round 2 is verification-only by instruction: it may report on whether round 1's
findings were resolved, and on defects introduced BY the fixes. It did not
re-run round 1's mutation sweep and did not open new fronts against unchanged
code. Anything else is in the out-of-scope appendix.

**This report replaces round 1's at the same derived path.** Round 1's mutation
log and duty summaries are preserved below and in `findings.json`'s inventory
reasons, so nothing measured in round 1 is lost.

---

## What changed since round 1 — and it is not what the diffstat suggests

Two commits (`ec5b9485`, `2f57af48`) over ten files. **Zero production bytes.**
Verified, not assumed: `git diff fc00bb9b..HEAD` with `docs/`, `__tests__/` and
`*.test.ts` excluded returns nothing. That is why round 1's nine kills carry
forward verbatim — they describe production files that are byte-identical at
HEAD — and why round 2's measurement budget went to the fix hunks instead.

---

## Preconditions

- **Worktree clean at a committed SHA** before the run. ✅
- **Journal:** closed with every round-1 mutation `restored` and `dotenv.open:
  false`; `round-start` opened **round 2** and reset the budget to 30 runs. ✅
- **W1 recurs, and it is the same tool defect round 1 recorded.**
  `mutation-runner.mjs watchers` aborted on four processes. `lsof -a -p <pid> -d
  cwd` resolved every one OUTSIDE this worktree — three at the parent checkout
  `/Users/…/RepWorth`, one at the sibling worktree
  `…/RepWorth-worktrees/refactor-globals-css-extraction`. No process serves or
  watches this worktree, so the precondition holds in substance and the run
  proceeded. Two rounds in a row is now evidence, not an anecdote: on a machine
  with sibling worktrees this check is unsatisfiable and will be routinely
  overridden, which is how a real guard rots.
- **Live-DB lane armed, not assumed.** Every live run exported BOTH
  `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` at localhost and its
  executed/pending counts were read from the run output, never from an exit
  code. `suspension.integration.test.ts` reported **11 executed, 11 passed** —
  not 11 pending.

---

## Round 1's seven findings — one disposition each

| ID | Sev | Disposition | Evidence |
|---|---|---|---|
| RT-1 | P1 | **accepted-risk** (AUTH-1) | Both tags now carry an unchecked pending row in `beta-launch-alerting.md` (`:54`, `:66`); the intake no longer claims the warning pages anyone. Routing gap unchanged and owner-accepted. Wording defect in the new rows → **RT-9**. |
| RT-2 | P1 | **fixed** | `docs/directory.md:890` now says "one per **disabled episode**, NEVER per process" with the queue-vs-delivery reason. Agrees with `env-vars.md:551` and with `write.ts:277-300`. |
| RT-3 | P1 | **fixed** | `feat-1008-…-deviations.md:31` — the summary TABLE ROW now carries "SETTLED 2026-08-30 by #1009". |
| RT-4 | P2 | **open — half fixed** | The test comment is corrected. `write.ts:32-35`'s "Catching would hide a writer bug…" — round 1's *second* false claim — is untouched, because no production byte changed. And the new comment now defers to it by name. |
| RT-5 | P2 | **fixed** | `observability[3]` now bounds the equality to inside `REFUSAL_LEDGER_RETENTION_DAYS`, says the counts diverge past 180 days **by design** and why, and says it is prose with no runnable artifact. |
| RT-6 | P2 | **fixed at the cited artifact** | The intake's `rollback_plan` is corrected in terms ("must not be described as self-cleaning"). The plan still states it the old way → **RT-11**. |
| RT-7 | P2 | **fixed** | Title renamed in the test, both intake copies and the inner comment. Measured: the new title selects exactly one case and passes; promised-tests re-derived PASS over all 28. One stale *quotation* survives → **RT-10**. |

---

## Round 2's four new findings

### RT-8 (P1) — the RT-4 fix replaced one false claim with another, and this one is measurable

`suspension.integration.test.ts:573-575`, added by the fix:

> *What this **DOES** discriminate: a helper that opens its own connection
> instead of using the caller's `tx` — its row would survive this rollback.*

**It does not, and I measured it.** M10 rerouted `writeRefusalEvent`'s INSERT and
its `occurredAtFragment` onto a freshly constructed postgres.js client instead of
the caller's `tx`.

- Baseline at HEAD: **1 executed, 10 skipped, passed.**
- Under the mutant: **1 executed, 10 skipped, passed. SURVIVED.**

**Arbiter — not equivalent, not unexecuted.** The mutation is exactly the
invariant #15 violation the comment names, and in the general case a successful
insert on an independent connection commits regardless of the caller's rollback.
The mutated line is the very INSERT this fixture forces to fail. It survives for
one reason: the fixture forces a CHECK violation (an invalid `refusal_category`),
so **no row is produced on either connection** and nothing can survive a
rollback — which is precisely why the assertion cannot see the difference.

**This was already on the record.** Round 1's RT-4 wrote: *"The test's other
claim — 'one that opened its own connection would leave them behind too' — is
also not discriminated by this fixture, since the forced insert fails on either
connection and leaves nothing behind either way."* The fix deleted the catch half
and **promoted the connection half into a positive coverage claim.**

**P1, not P0**, and the reasoning is on the record so the owner can re-rate:
production code is correct; M9b proves the case is not a could-not-fail test; and
the likeliest real shape of the defect — importing `@/lib/db/server` — is blocked
mechanically by `ci:db-imports` strict. **But note the residue:**
`scripts/ci/db-imports-audit.ts` matches only the `db/server` specifier
(`:24-34`), so a direct `postgres(…)` construction inside `src/lib/refusals/` is
caught by nothing today — no ESLint boundary (invariant #1 covers `src/app/**`
and `src/components/**`), no static-policy rule.

**Behavioural replacement.** Say what is true: this assertion discriminates a
helper that does not write at all (M9b killed it); the own-connection property is
held by invariant #15 and `ci:db-imports`, not by this test. Or make it real —
let the insert SUCCEED and assert the row is gone after the rollback, which
discriminates the connection but not the catch.

### RT-9 (P2) — the new Governor row calls an email-only route "not a gap", inside the section that forbids exactly that

`beta-launch-alerting.md:69-71`:

> *…so it defaults to level `error` and the existing high-priority rule should
> already reach email — the Discord route is an upgrade, **not a gap**.*

It sits under **`## 1. Non-email paging route (mandatory)`**, whose premise is
(`:25-26`) *"Alerts must reach a **non-email** channel because admin email shares
the Resend provider with the product."* By §1's own definition an email-only
route **is** the gap. The checkbox is correctly left unchecked, so nothing is
operationally lost — but the sentence invites an operator to deprioritise it.

**Both factual halves check out**, so this is wording and not a false mechanism:

- `AutonomyGovernorScheduler.ts:116` is `captureException(error, { tags: {
  subsystem: 'autonomy_governor' } })` with **no** level override, so Sentry's
  event default (`error`) applies — genuinely unlike `write.ts:291-295`, whose
  `captureMessage` overrides `eventFromMessage`'s `"info"` default to
  `'warning'`. The distinction the runbook draws is real.
- The `refusal_ledger` row's "**CONFIG-1's shape exactly**" claim matches the
  audit note it cites (`:152-158`): a `warning`-level `captureMessage`, no
  Discord route, the only rule being the default high-priority → email one.
- `The structured log line (refusals:write)` matches
  `createWorkerLogger('[refusals:write]')` at `write.ts:63`.

**Second, smaller half:** CONFIG-1's evidence is a 2026-06-24 audit of
`repworth-nv/repworth-**staging**`. The new row asserts "the existing
high-priority rule should already reach email" without scoping it to a project or
environment. The hedge ("should") carries it, but production was never audited.

### RT-10 (P2) — RT-7's rename left a dangling quotation of the old title

`feat-1009-…-deviations.md:276` still reads *"without it **title 9's "exactly one
per process"** is satisfied by whichever case ran first."* Title 9 no longer
contains that phrase. The sentence's mechanism claim stays true; only the quoted
text is stale. Found by grepping the FACT, not the cited line — the rule the
deviations file itself proposes.

### RT-11 (P2) — the SEVENTH sweep miss

`feat-1009-…-plan.md:1057-1060`, `## 8. Rollback`:

> *Per the intake: flag flip first (no deploy), PR revert second, and **no
> migration 117**. **Rows already written are retired by the 180-day sweep**;
> #1002 forbids any backfill that would re-create them.*

The intake it claims to be quoting now says the opposite in terms: layer 2
*"REMOVES THE SWEEP THAT WOULD RETIRE THEM"*, surviving rows have *"no writer, no
reader and no pruner"*, and it *"must not be described as self-cleaning, **which
an earlier draft of this field wrongly did**."* RT-6's fix swept the intake and
both copies, not the plan — and the plan is the operator-facing artifact at
revert time.

Rated **P2 for consistency with round 1's rating of the identical fact** (RT-6);
the operational consequence is the same modest one — UUIDs, enum strings and
timestamps only, deny-all RLS, offboarding purge unaffected.

---

## The sweep — the seventh miss exists, and two more with it

Per instruction, I grepped the **facts that changed**, not the lines that were
cited, across the whole worktree at HEAD.

| Fact swept | Patterns | Result |
|---|---|---|
| Warning scope (per-episode) | `once[- ]per[- ]process`, `per process`, `per-process`, `process lifetime`, `lifetime of the (worker\|process)` | **Clean** for the ledger. Every surviving hit belongs to another subsystem (`admission.ts`, `unsubscribe.ts`, `poller-heartbeat.ts`, `startup-assert.ts`, `billing/portal`). `CONTEXT.md`, `docs/currents.md`, `docs/progresstracking.md`, `.claude/reference/*` carry **no** ledger per-process claim. One examined-and-cleared case below. |
| D16 settlement | `D16`, `unsettled`, `split point is unsettled` | **Clean.** `progresstracking.md:5422-5425`, `handoff.md:63`, migration 116's header and the deviations row + section all agree. `feat-1008-…-plan.md:436` still says "unsettled" but stays inside `## Not in this PR` under its recorded do-not-touch disposition (round 1 cleared this; re-confirmed). The `D16` hits in `CONTEXT.md` and the solicitation spec are a different, unrelated D16. |
| Reconciliation window | `Reconciliation query`, `COUNT\(\*\) of refusal_events`, `must equal COUNT`, `reconcil` | **Clean.** The intake is the only artifact that states the query, and it now carries the ≤180-day bound. |
| Rollback contradiction | `sweep retires`, `180-day sweep`, `retires them`, `self-cleaning` | **MISS → RT-11**, at `feat-1009-…-plan.md:1059`. |
| The renamed test title | the full old title, and `exactly one per process` | **MISS → RT-10**, at `feat-1009-…-deviations.md:276`. The full old title survives only in round 1's own `findings.json`, which is a historical record and correct to leave. |

**Examined and CLEARED — `feat-1009-…-plan.md:336-338`.** §2.3 states the
per-process rule prescriptively (*"emit **one** …per process. Once per process,
because a suspended fleet would otherwise emit one per decision"*). It is not a
finding: a `####` subsection **inside the same §2.3**, twenty-six lines below,
is titled *"The design above was ALSO wrong, and branch review round 1 found out
why"* and the shipped-design list at `:391` says *"The rate limit is per DISABLED
EPISODE, not per process… Under **the old rule** a second outage in the same
process was silent."* The text is explicitly superseded in place. This is the
same test round 1 applied to clear `feat-1008-…-plan.md:436`. If the owner wants
belt-and-braces, an in-line "(superseded below)" marker at `:336` is a one-line
fix — recorded here so the choice is visible, not filed as a finding.

---

## The three verifications the brief asked for by name

**Intake copies — byte-identical.** `cmp .feature/intake.json
docs/superpowers/plans/feat-1009-refusal-ledger-write-path-intake.json` returns
clean, and both hash to
`2d04d7353300d4b544d1b8e2687bc0e48d2ca8e8a931af7ecc5d1bae96583eaf`. Both amendments
(the RT-7 title, the surface entry, and the four prose fields) landed in both.

**Surface amendment 2 of 2.** `docs/runbooks/beta-launch-alerting.md` is present
in `allowed_edit_surface` in both copies, and `pnpm ci:feature-surface` re-derived
**PASS** at HEAD: *"39 changed file(s) within the declared surface; every surface
entry matches a file."*

**Promised tests — all 28 still match byte-for-byte.** I re-derived the
verify-gate row's exact rule (fixed-string `grep -rF` over `src worker scripts`,
`--include='*.test.ts' --include='*.test.tsx'`) against the current intake: **28
titles, 0 missing.** The renamed title additionally selects **exactly one**
executed case under `vitest -t` with the runner's own regex escaping.

**RT-4's postgres.js citation — substance TRUE, line range half-wrong.** The
comment says postgres.js *"records `uncaughtError` per query inside `scope()` and
rethrows it after the callback returns (`index.js:290-296`)"*. Read at source in
the installed `postgres@3.4.9`: the RECORDING half is `handler(q)` at
**`src/index.js:291-296`**, whose body is
`q.catch(e => uncaughtError || (uncaughtError = e))` at `:292` — inside the cited
range. The RETHROW half is `if (uncaughtError) throw uncaughtError` at
**`:265-266`**, followed by the `catch` that issues `rollback` at `:267-273` —
**outside** the cited range. So the mechanism claim is correct and the equivalence
argument for M9 holds; only the citation attributes both halves to one range.
Recorded here rather than as a separate finding because it is a sub-clause of
RT-8's hunk; the precise correction is `:291-296` records, `:260-266` rethrows.

---

## Did any fix introduce a new defect? — the fix hunks, one by one

| Fix hunk | Verdict |
|---|---|
| `beta-launch-alerting.md` +22 lines | Two factual claims verified against code (level defaults, logger prefix, CONFIG-1 shape) — all TRUE. One wording defect → **RT-9**. |
| `docs/directory.md:890` | Rewritten row verified against `write.ts:63, 277-300, 364` and `env-vars.md:551`. No new defect. |
| `feat-1008-…-deviations.md:31` | Row now matches its own section. No new defect. |
| `suspension.integration.test.ts:571-586` | **New defect → RT-8**, measured. Suite re-run at HEAD: 11 executed, 11 passed, so the comment change broke nothing executable. |
| intake `observability`/`rollback_plan`/`edge_cases` | Verified against `ArchivalPoller.ts:36-45` and the absence of an `account_audit_log` arm. No new defect; the un-swept twin is RT-11. |
| `write.test.ts:295-310` rename | **Measured**: selects exactly one case, passes, promised-tests PASS. No new defect; the un-swept quotation is RT-10. |
| `plan.md:150` | Correct. No new defect. |

---

## Mutation log

Round 1's ten mutations are unchanged in force — every target file is
byte-identical at HEAD. Round 2 planted one.

| # | Round | Mutation | Target case | Outcome |
|---|---|---|---|---|
| M1 | 1 | `write.ts:406` — drop `WHERE subject_id IS NOT NULL` | `write.integration.test.ts:202` | killed (live `42P10`) |
| M2 | 1 | `write.ts:336` — `NOW()` → `statement_timestamp()` | `write.integration.test.ts:242` | killed |
| M3 | 1 | `suspension.ts:333` — `businessId: null` → a uuid | `pnpm typecheck` | killed (`TS2345`) |
| M4 | 1 | `write.ts:364` — remove `endDisabledEpisode()` | `write.test.ts:268` | killed |
| M5 | 1 | `write.ts:280-307` — fold `logger.warn` inside the Sentry `try` | `write.test.ts:314` | killed |
| M6 | 1 | `ArchivalPoller.ts:394-396` — sweep `created_at` | `ArchivalPoller.integration.test.ts:554` | killed |
| M7 | 1 | `ArchivalPoller.ts:433` — drop the `refusal_events` key | `ArchivalPoller.integration.test.ts:614` | killed |
| M8 | 1 | `AutonomyGovernorScheduler.ts:111-118` — remove the swallowing guard | `AutonomyGovernorScheduler.test.ts:433` | killed |
| M9 | 1 | `write.ts:380-408` — catch the INSERT error and return | `suspension.integration.test.ts:555` | SURVIVED → equivalent (RT-4) |
| M9b | 1 | `suspension.ts:319-345` — delete the write site | `suspension.integration.test.ts:555` | killed (resolves M9's row) |
| **M10** | **2** | `write.ts:380/404` — run the INSERT and its fragment on a **separate postgres.js client** instead of `tx` | `suspension.integration.test.ts:555` | **SURVIVED → confirmed non-equivalent (RT-8)** |

All planted mutations were journaled before the write and restored by
`mutation-runner.mjs finalize`, which reported *"restored 1 mutated file(s) and 0
dotenv file(s); journal closed"*. `git status --porcelain` was **empty** after
restoration and before the first report byte was written.

---

## Out of scope — not triaged

Round 2's brief limits it to round-1 dispositions and defects inside the fix
hunks. The following were noticed and are recorded WITHOUT triage:

- The round-1 W1 tool defect (`watchers` cannot discriminate sibling worktrees)
  belongs to the red-team skill, not this branch.
- `ci:db-imports` matching only the `db/server` specifier — noted inside RT-8 as
  context for its severity, not filed as a repo finding.
- The wider question of whether ANY `warning`-level Sentry capture in this repo
  is routed is a pre-existing, repo-wide gap explicitly covered by AUTH-1.

---

## Authorizations

*Rendered from `findings.json`'s `authorizations` array — never parsed back out
of this Markdown.*

**AUTH-1** · 2026-08-30 · names **RT-1**

> RT-1's disposition is accepted-risk, owner-authorized 2026-08-30: the routing
> gap is pre-existing, documented in beta-launch-alerting.md, and shared with
> every warning-level capture in the repo. The owner chose to correct the
> overstated claim and add both tags to the pending checklist rather than block
> the PR on a Sentry dashboard action this PR cannot contain.

---

## What the checker says, and why

`red-team-status.mjs` validated the schema, deduped the rows and **recomputed the
counts and status to match** the sidecar. It reports three blocks, all expected:

1. `status is OPEN_P1` — every non-CLEAR status blocks the `reviewed` transition.
2. `finding RT-8: a high-risk run cannot ship an open P1` — the round cap is
   reached, so this is **user adjudication**, per the skill: any high-risk
   `OPEN_P1` requires the user, not the orchestrator.
3. `the worktree carries 1 tracked modification outside this run's report` — this
   is the sidecar itself, still uncommitted at the time the checker ran. It
   clears when the report is committed, which is step 3 of the skill's ordering.

RT-4, RT-9, RT-10 and RT-11 are P2 and do not block.
