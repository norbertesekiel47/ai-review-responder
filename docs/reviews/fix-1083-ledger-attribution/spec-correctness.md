# Spec & correctness review — `fix/1083-ledger-attribution`

Axis: spec and correctness. Read-only; no source file edited.
Merge-base `91b32506` → HEAD `c94277bf`.
Diff under review: `git diff 91b32506..c94277bf` (12 files).

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| medium | `src/lib/refusals/write.ts:1096` | The stated reason for duplicating the lane string into `extra.refusal_lanes` is arithmetically impossible: the closed 7-member vocabulary joins to **108 characters** at most, against the 200-character limit the comment itself cites. Repeated in `CONTEXT.md:167` (LOCKED term), `write.test.ts:1614` and the plan. |
| low | `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts:89`, `:168`, `:939` | Three docblocks in a file **inside `allowed_edit_surface`** still name `withLedgerAttribution` as the reporter/rethrower on the `held_draft` and `policy_gate_held` **write** path, which this branch removed from both. D8 recorded exactly this grep lesson and did not apply it here. |
| low | `src/lib/refusals/vocabulary.ts:701` | Production docblock says "on the same terms as `write.ts`'s **uncaught** INSERT" — the INSERT is now caught and rethrown. Outside the edit surface (and the invariant forbids touching `vocabulary.ts`), and no deviation or follow-up records the residual contradiction against T5's "no doc sentence contradicts the code". |
| low | `docs/runbooks/beta-launch-alerting.md:106`, `:500` | The runbook enumerates the sources of `error`-level `subsystem:refusal_ledger` issues as "`withLedgerAttribution`'s ledger-failure attribution (since #1079)" plus the two #1105 faults. After this branch write faults are raised by `captureLedgerWriteFault` in `write.ts` across **seven** lanes, not by the wrapper across two. Outside the surface; unrecorded. |
| low | `docs/superpowers/plans/fix-1083-ledger-attribution.md:341` (T6) | The retry-cost follow-up ticket T6 requires has not been filed. `gh issue list --state open` tops out at **#1114**; the branch is at review. The intake's first non-goal defers that work explicitly to "its own follow-up ticket". |

### F1 — the 200-character tag-truncation rationale is false (medium)

`src/lib/refusals/write.ts:1093-1097`:

```
// `refusal_lanes` duplicates the TAG on purpose — a Sentry tag value
// truncates at 200 characters and `extra` does not, so `extra` is the durable
// copy for a cohort spanning every lane.
```

`REFUSAL_SOURCES` is closed at seven members (invariant: "REFUSAL_SOURCES stays
seven members"). The maximum tag value the set arm can ever produce is:

```
ask_withheld,auto_post_revoked,autonomy_suspended,batch_halted,held_draft,outreach_withheld,policy_gate_held
```

— **108 characters**, measured. The tag cannot lose a member at 200, so "a cohort
spanning every lane is the case where the tag can lose a member" is unreachable
by construction. Adding a lane is migration-bearing (`vocabulary.ts` rules), so
the bound is not going to drift past 200 without a schema change.

The duplication is harmless — `extra` is cheap and the key is pinned by an eval
case. The defect is the **reason**: it is now a LOCKED `CONTEXT.md` entry and a
production docblock, so the next reader inherits a false constraint and may
"defend" against a truncation that cannot occur, or reason about tag budgets
elsewhere from a premise this file taught them. The correct justification, if the
key is kept, is that `extra` and the tag serve different Sentry surfaces (search
facet vs. event body), not truncation.

Recommended: correct the sentence in all four places, or state the real reason.
No code change required.

### F2 — the surface's own integration suite still points at the removed wrapper (low)

`worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts` is
listed in `allowed_edit_surface` and is unchanged by the diff. Three of its
docblocks now misdescribe the code:

- `:88-89` — "the rollback they observe comes from Postgres and would happen even
  if `withLedgerAttribution` SWALLOWED the error". For `held_draft` there is no
  wrapper at all now; for `policy_gate_held` the wrapper covers only the resolve.
- `:168` — "`withLedgerAttribution`'s capture is the branch's whole observability
  claim". `captureLedgerWriteFault` is now the reporter for six of the seven
  lanes and for both of this file's write-fault cases.
- `:939` — "The oracle for `withLedgerAttribution`'s rethrow". The mutant this
  case is documented to kill (swallow inside `withLedgerAttribution`) can no
  longer live on the path this case drives; the rethrow it now guards is
  `writeRefusalEvent`'s.

The suite still **passes** (verified below) and its assertions remain correct —
this is prose, not behaviour. It is filed because the branch's own
`docs/directory.md` row adds the trap *"grep the symbol, not just the function"*
(D8) and then does not apply it to the one surface file it left untouched.

### F3 — `vocabulary.ts:701` calls the INSERT "uncaught" (low)

```
 * IT MAY THROW INSIDE A DECIDING TRANSACTION, and that is deliberate on the same
 * terms as `write.ts`'s uncaught INSERT: a writer bug aborts the decision, and
 * the lever against it is `REFUSAL_LEDGER_ENABLED`, not a silent default.
```

The substantive claim (a writer bug aborts the decision; the lever is the kill
switch) survives. The word "uncaught" does not: the branch corrected exactly this
word in `write.ts`'s own docblock and in `docs/directory.md`. `vocabulary.ts` is
outside `allowed_edit_surface` **and** an intake invariant says it is untouched,
so the branch could not fix it in place — but T5's Done-when is "no doc sentence
contradicts the code", and neither a deviation nor a follow-up records the gap.
Cheapest resolution: a deviations entry plus a one-line follow-up ticket.

### F4 — the alerting runbook's ledger-fault enumeration is stale (low)

`docs/runbooks/beta-launch-alerting.md:500`:

> Three different faults now carry `subsystem:refusal_ledger` at `error` —
> `withLedgerAttribution`'s ledger-failure attribution (since #1079) and both of
> these …

The operational rule the paragraph defends (rules 7/8 filter on the `fault` tag,
never on `subsystem` + level) is **more** correct after this change, not less. But
the enumeration now names the wrong owner and the wrong population: write faults
come from `captureLedgerWriteFault` and can now originate on all seven lanes
rather than the two `persist.ts` ones. The intake's `observability` section names
the `refusal_lane` facet as the success signal, and this runbook is where an
operator would look for it. Outside the edit surface; unrecorded.

### F5 — plan tracer T6 not executed (low)

T6: *"File the ticket the split-out promised, citing
`worker/jobs/ResponseGeneratorWorker.ts:92,105,110` and this branch, and stating
the open question it inherits."* `gh issue list --state open --limit 15` returns
#1114 as the highest-numbered open issue; PRs are already at #1125, so a
post-branch issue would number ≥ #1126. Nothing recorded in the deviations. Ticket
#1083 itself remains open and covers both halves, so the work is not lost — but
the split the intake's first non-goal relies on is not tracked.

---

## What was checked and found sound

### Sixteen `tests_to_add` titles — all present verbatim, all asserting their title

Machine-matched every title against every `*.test.ts`/`*.test.tsx` in the repo:
16/16 exact-string hits, twelve in `src/lib/refusals/__tests__/write.test.ts`,
four in `worker/jobs/response-generation/__tests__/persist.test.ts`. Each body was
read; none over- or under-claims relative to its title. Notable strengths:

- The set-arm lane-tag fixture is genuinely unsorted, duplicated and multi-source
  (`['outreach_withheld','ask_withheld','outreach_withheld']` → `ask_withheld,outreach_withheld`),
  so it kills first-source, input-order and no-dedup implementations.
- Every negative case ("does not capture …") drives a **positive control first**,
  so none is satisfied by a writer that captures nothing.
- The four `persist.test.ts` cases assert the capture's **`extra` shape**, not a
  bare count — `{response_id}` for the wrapper vs. the writer's five closed
  fields — which is what distinguishes "wrapper deleted, writer guard kept" from
  "writer guard deleted, wrapper kept". Plan round 1 F1's whole point.
- `persist.test.ts` mocks only `noteRefusalLedgerDark`/`noteUnmappedBlockReasons`
  out of `write.ts`, so `writeRefusalEvent` and its new guard are the **real**
  code under those four cases.
- The id-generation case mocks `uuid.v7` with `mockImplementationOnce` and
  asserts `harness.sqlCalls` is empty — it does fail on the forbidden hoist.

### The three control-flow invariants — verified against code, not docblock

1. **Same instance rethrown.** `write.ts:908` and `:1104` are bare `throw error;`
   on the caught binding; no wrapping, no `cause`, no re-`new`. Eleven eval cases
   assert `rejects.toBe(<instance>)` rather than `toThrow(/msg/)`.
2. **Kill switch still contains everything.** `writeRefusalEvent` returns at
   `:824-829` before the `try` at `:867`; `writeRefusalEvents` returns at `:995`
   (empty) and `:999-1002` (flag) before the `try` at `:1017`; `persist.ts:968-973`
   guard 4 returns before the resolve at `:978`. `endDisabledEpisode()` is outside
   both guards (`:833`, `:1004`), as required.
3. **A failing reporter never replaces the real error.** `captureLedgerWriteFault`
   (`write.ts:752-773`) wraps the whole `Sentry.captureException` call in its own
   `try {} catch {}` and returns `void`; the caller's `throw error` is on the next
   line in both arms. Two eval cases (single-row and set) arm a throwing
   `captureException` and assert the original still wins.

### Caller-side regression sweep — the five production importers not in the diff

`src/lib/auto-approval/suspension.ts:331`, `src/lib/solicitation/{approval.ts:637,
ask-generation.ts:710/1940, batch-builder.ts:670, dispatch.ts:1474}`,
`worker/jobs/publisher/auto-policy-downgrade.ts:208`.

1. **Double-report / swallow.** None of the six wraps its `writeRefusalEvent(s)`
   call. `suspension.ts`, `batch-builder.ts` and `auto-policy-downgrade.ts`
   contain **no `catch` at all**. `approval.ts`'s only catch (`:1153`) is in
   `requestAskRegeneration`, which never calls `latchHalt`. `dispatch.ts`'s only
   catch (`:1059`) is inside `sendWithBoundedRetry`, an out-of-transaction
   provider loop. `ask-generation.ts` has six catches: `:499`/`:915`/`:1203`/
   `:1524`/`:1583` are on LLM, `api_costs` and budget paths that do not enclose
   either write; `:1709` **does** enclose the `sql.begin` containing the `:1674`
   write, and it rethrows anything that is not a `RegenSwapAbort`. No Sentry
   capture exists on any of these paths, so nothing double-reports.
2. **Branching on the error.** No caller reads `.code`, `.constraint_name`,
   `.message` or the stack of a ledger error. The only type branches are
   `instanceof RegenSwapAbort` / `RegenRequestAbort` / `RegenBudgetExceededError`
   / `LLMStructuredOutputError` — all sentinel classes, and catch-and-rethrow
   preserves the instance, so every one of them still takes the `throw err`
   arm. Confirmed by execution, not inference: all six caller suites run green
   (below).
3. **The "NOT wrapped in try/catch … the lever is the helper's own kill switch"
   comments.** Still literally TRUE at all six sites — no catch was added, and
   the kill switch is still the operational lever. They remain accurate about
   swallowing (the writer does not swallow). They are now *incomplete* in one
   respect — the ledger does now report the fault, so "hidden in the one place
   the ledger cannot report it" reads slightly harder than it should — but the
   files are outside `allowed_edit_surface` and the sentence is not falsified.
   Recorded in the low-confidence appendix, not the table.
4. **`writeRefusalEvents`' two call sites.** `batch-builder.ts:670` emits only
   `refusalSource: 'ask_withheld' as const`. `ask-generation.ts:1940` emits only
   rows built by `outreachWithheldRefusalInput`, which is `outreach_withheld`
   only. Both are therefore **single-lane in practice**, and the sorted
   comma-joined tag degenerates to the bare lane name — exactly the shape
   `observability[2]` wants. The mixed-source path is type-reachable but not
   caller-reachable today, and it is the one the eval exercises directly.

### Non-goals — all held

- **No control-flow change.** Both new guards are catch-and-rethrow of the same
  instance. Nothing that aborted now commits; nothing that committed now aborts.
  The `held_draft` un-wrapping and the `policy_gate_held` narrowing preserve
  order of operations exactly (`if (!refusal) return;` moved from inside the
  callback to the wrapper's return value; both short-circuit identically).
- **No swallow.** Grep-verified: the only swallowing `catch {}` blocks in
  `write.ts` are the transports (`warnLedgerDisabled`, `noteUnmappedBlockReasons`,
  `noteUnmappedOverflow`, `captureLedgerWriteFault`), all pre-existing in kind.
- **No migration** (`supabase/migrations/` untouched), **no vocabulary member**
  (`vocabulary.ts` untouched, `REFUSAL_SOURCES` still seven), **no Restraint tab
  change** (`read.ts` and every owner-facing surface untouched).
- **Retry-cost work genuinely absent.** `worker/jobs/ResponseGeneratorWorker.ts`
  is not in the diff; nothing touches the retry ladder.
- **`captureLedgerWriteFault` is not exported** — module-private, exactly two
  callers, both write arms, as the plan requires.

### `allowed_edit_surface` — clean

All 12 changed paths are inside it:
`src/lib/refusals/write.ts`, `src/lib/refusals/__tests__/write.test.ts`,
`worker/jobs/response-generation/persist.ts`,
`worker/jobs/response-generation/__tests__/persist.test.ts`, `CONTEXT.md`,
`docs/directory.md`, `.claude/reference/arch-review-log.md`,
`docs/superpowers/plans/fix-1083-ledger-attribution{,-intake.json,-deviations.md,-handoff.md}`,
`docs/reviews/fix-1083-ledger-attribution/blast-radius.md`.

### Edge cases — all twelve reachable in code

Each intake `edge_cases` entry was resolved against source. The two that carried
real risk are both closed correctly:

- **Set-arm materialization failure (round 1 F2).** The `try` opens at `:1017`,
  before `inputs.map(…)` at `:1020`; `occurred_at`'s `toISOString()` at `:1038`
  and `uuidv7()` at `:1021` are both inside it. The lane tag is computed in the
  `catch` from `inputs` (`:1092`), never from `rows`. Eval case asserts
  `harness.sqlCalls` is empty, proving the fault preceded any statement.
- **Single-row id generation (round 2 R2-c).** `${uuidv7()}::uuid` at `:882` is
  a tagged-template interpolation, so it evaluates when the tag function is
  invoked — inside the `try` at `:867`. The eval fails on the hoist.

Also confirmed: `ON CONFLICT DO NOTHING` is not an error and captures nothing
(eval case issues the statement and asserts zero captures); an empty set input
returns before the flag read and before the guard; the wrapper returns `null`
without reaching the writer when the resolver vetoes; both lanes in one
transaction cannot both capture, because the first throw aborts the persist.

### Verification actually run at `c94277bf`

| Command | Result |
|---|---|
| `vitest run src/lib/refusals/__tests__/write.test.ts worker/jobs/response-generation/__tests__/persist.test.ts` | **107 passed** |
| `vitest run --project integration` on the two surface live-DB suites | **39 passed** (ran against the DB, not skipped) |
| `vitest run --project integration` on all six caller suites (blast radius) | **193 passed** (167 + 26 after exporting `TEST_DATABASE_POOL_URL`) |
| `pnpm ci:directory-map` | passed — 593 files, no stale rows |
| `pnpm ci:tenant-scope` | passed — 377 entries, baseline 377 |
| 16 `tests_to_add` titles, verbatim string match | 16/16 |
| `git diff --name-only 91b32506..c94277bf` vs `allowed_edit_surface` | 12/12 inside |

Production `INSERT INTO refusal_events` sites at HEAD: exactly two, both in
`write.ts` (`:869`, `:1042`) — the plan's completeness claim holds, so the writer
really does cover every lane by construction.

---

## Low-confidence appendix — not findings

- **Call-site comment completeness.** The five untouched call sites say the write
  is "not … hidden in the one place the ledger cannot report it". It never was
  hidden, and now it is also *reported*. Literally true, mildly under-informative.
  Outside the edit surface; a one-clause addition on the next branch that touches
  each file would close it.
- **Sentry grouping across lanes.** `captureException` groups on the error, and
  all seven lanes' write faults now originate at two throw sites in one module,
  so they may fold into a single issue with `refusal_lane` as a facet rather than
  one issue per lane. The intake anticipates this — it says "facet" — and the
  `fault`-tag alert design in `beta-launch-alerting.md` is unaffected. Worth
  knowing before someone expects seven issues.
- **`25P02` mis-attribution.** If a deciding transaction were already poisoned by
  an earlier swallowed statement error, the ledger INSERT would fail with
  "current transaction is aborted" and be tagged as a ledger fault. I could not
  find a reachable path: postgres.js rejects the `sql.begin` callback on the
  first failed query, and no caller swallows a `tx`-scoped query error before a
  ledger write. Theoretical.
- **`write.ts` size.** The file is now ~1,125 lines with a very high
  comment-to-code ratio. The maintainability axis owns that judgement; noting it
  only so this axis is not read as endorsing the volume.

---

**VERDICT: PASS** — the change does what the intake specifies, all sixteen
promised tests exist and assert their titles, the three control-flow invariants
hold against source, no non-goal is breached, every changed path is in surface,
and no caller regresses (verified by running all six blast-radius suites against
a live DB). Five findings, none blocking: one medium prose defect that is
arithmetically false in a LOCKED glossary entry, three stale cross-references
this change created, and one unexecuted plan tracer.
