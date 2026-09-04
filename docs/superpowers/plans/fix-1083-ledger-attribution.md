# fix/1083 — Ledger attribution reaches every lane

Ticket: [#1083](https://github.com/RepWorth/ai-review-responder/issues/1083)
Intake: `docs/superpowers/plans/fix-1083-ledger-attribution-intake.json`
Base: `2be0c3236d3251682ef7342aca65deed958cc692`
SIZE `standard` · RISK `high` · SURFACE `backend`

## The defect, restated against current HEAD

The ticket was filed 2026-09-02. PR #1098 (#1079) merged 2026-09-03 and added
the `held_draft` arm. So the ticket's "one lane attributes, six do not" is one
lane out of date. Today **two lanes attribute and five do not**, across **seven
call sites**:

| Lane | Call site | Attributed today |
|---|---|---|
| `held_draft` | `worker/jobs/response-generation/persist.ts:1128` | yes |
| `policy_gate_held` | `worker/jobs/response-generation/persist.ts:980` | yes |
| `auto_post_revoked` | `worker/jobs/publisher/auto-policy-downgrade.ts:208` | no |
| `autonomy_suspended` | `src/lib/auto-approval/suspension.ts:331` | no |
| `ask_withheld` | `src/lib/solicitation/ask-generation.ts:710` | no |
| `ask_withheld` | `src/lib/solicitation/ask-generation.ts:1940` (set) | no |
| `ask_withheld` | `src/lib/solicitation/batch-builder.ts:670` (set) | no |
| `batch_halted` | `src/lib/solicitation/approval.ts:637` | no |
| `outreach_withheld` | `src/lib/solicitation/dispatch.ts:1474` | no |

Every unattributed site already carries the same comment — *"NOT wrapped in
try/catch … the lever is the helper's own kill switch"*. The comment is correct
and stays true. What is missing is the signal that tells an operator to reach
for that lever.

## The design decision, and why the call sites are not the fix

`src/lib/refusals/write.ts` is already the single owner of every
`refusal_events` statement. A fault in that statement is a property of the
statement, so its attribution belongs on the writer's side of the seam.

Attribution at the call site put it on the **caller's** side of a seam that
already existed. That is precisely why five callers could omit it, and why
nothing stops an eighth lane omitting it next. Pushing it into the writer:

- adds **zero** interface members and **zero** parameters — the module gets
  deeper, not wider;
- covers all seven lanes **by construction**, so the omission is unspellable;
- takes its tag from input the writer already holds (`refusalSource`,
  `subjectType`, `subjectId`), which is strictly better than `response_id` —
  only two lanes have a response.

**The deletion test on `withLedgerAttribution`.** Delete it entirely and ask
what reappears. The write-fault half reappears nowhere: the writer covers it.
The resolve-fault half reappears at exactly **one** call site — the
`policy_gate_held` resolve, which throws *before* the writer is reached. One
caller is not an abstraction (`working-rules.md`), so the wrapper stays a
private function in `persist.ts`, narrowed to that one fault and that one lane.

### What changes in the interface contract

`write.ts`'s docblock states *"the INSERT is deliberately **not** caught (a 116
CHECK violation is a writer bug and must abort the decision that names it)"*.
That sentence needs a precise correction, not a deletion. The INSERT is now
**caught and rethrown unchanged**. Catch-and-rethrow is not swallowing: the
decision still aborts, the same error instance propagates, and no caller
observes a different error. The distinction the sentence was drawing —
"facts propagate, observations swallow" — is preserved exactly. Only the
mechanism by which the fact is *reported* changes.

## Tracer bullets

`T1` blocks everything. `T2` and `T3` both edit `src/lib/refusals/write.ts`, so
they are **serial**, not parallel. `T4` follows `T2` so no commit exists in
which the `held_draft` write is unattributed. `T5` follows `T2`–`T4`.
`T6` is orchestrator work, not a subagent task.

---

### T1 — Eval: the sixteen promised tests, failing

**Blocking edges**: none. First task, dispatched alone (the enforcement spot
check runs against it).

Author every `tests_to_add` title from the intake as a real test. Titles are
**verbatim** — `promised-tests` matches the string, and an apostrophe in a
title silently fails that gate row (#1108), so no title here contains one.

Split by seam:

- `src/lib/refusals/__tests__/write.test.ts` — the **twelve** writer cases. Mock
  `@sentry/node`; assert on `captureException` calls. The id-generation case
  additionally mocks `uuid` (`write.ts:61` imports `v7 as uuidv7`).
- `worker/jobs/response-generation/__tests__/persist.test.ts` — the **four** lane
  cases (`policy gate vocabulary fault`, `exactly one capture for a held
  draft`, `exactly one capture for a policy gate write failure`, `commits … when
  the resolver would throw and the kill switch is off`).

Cases that cannot yet be written green may use `.fails`, never `.skip` — a
skipped test satisfies `promised-tests` while asserting nothing.

**The mixed-source fixture is specified, not left to the author** (round 1, F-note).
The set-arm lane-tag test must pass an input array that is **unsorted,
duplicated and multi-source** — for example
`['outreach_withheld', 'ask_withheld', 'outreach_withheld']`, expecting the tag
`ask_withheld,outreach_withheld`. A single-source or already-sorted fixture
passes under an input-order or first-source-only implementation, so it proves
nothing.

**Done when**: `pnpm vitest run src/lib/refusals worker/jobs/response-generation`
shows **fourteen** new failing assertions and no error outside them. Two of the
sixteen pass before implementation and that is correct — see deviations D5. Both
are regression pins: `commits the response persist when the policy gate resolver
would throw and the kill switch is off` is #1079's containment invariant, which
this section already required to pass before and after, and `attributes a policy
gate vocabulary fault without also attributing a write fault` pins that the
surviving wrapper's `extra` stays `{response_id}`.

---

### T2 — `writeRefusalEvent` attributes its own write fault

**Blocking edges**: T1.
**Files**: `src/lib/refusals/write.ts`.

Wrap the INSERT at `write.ts:777` in `try/catch`. The catch captures, then
rethrows **the same instance**.

```ts
try {
  await tx`INSERT INTO refusal_events ( … ) VALUES ( … )`;
} catch (error) {
  captureLedgerWriteFault(error, {
    lane: input.refusalSource,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    accountId: input.accountId,
    businessId: input.businessId,
  });
  throw error;
}
```

`captureLedgerWriteFault` is **private to the module** — one internal seam, two
callers (T2 and T3), never exported. It mirrors `withLedgerAttribution`'s inner
guard at `persist.ts:1047`–1055, whose capture is at `persist.ts:1048`: the
capture carries its own `try/catch`, so a broken reporter cannot replace the
writer bug it was reporting.

Tags: `subsystem: 'refusal_ledger'`, `refusal_lane: <RefusalSource>`,
`flag: REFUSAL_LEDGER_FLAG`. Level `error`.

`extra` carries **closed enums and UUIDs only** — no `refusal_code`, which is
free-ish text on some lanes, and no review or response prose.

Three facts the placement must preserve, each already true and each easy to
break here:

1. The flag guard at `write.ts:752` returns **before** this block. With the
   switch off the new code cannot run, so #1079's containment guarantee is
   untouched.
2. `ON CONFLICT DO NOTHING` absorbing a duplicate is **not** an error. No
   capture fires and the transaction commits.
3. The `try` starts at `await tx\`…\`` and `endDisabledEpisode()` stays
   **outside** it. That call is not a write and must not report as one.

**Do not hoist `uuidv7()` out of the template.** The single-row arm interpolates
`${uuidv7()}::uuid` at `write.ts:791`, inside the tagged template, so it is
evaluated when the tag function is invoked — that is, **inside** the `try`. A
generation failure is therefore already attributed. A later "tidy" to
`const id = uuidv7();` above the `try` would silently move it out of the guard
and open the same hole round 1 found in the set arm (F2 below).

**That instruction is test-protected, not merely written down** (round 2). A
prose rule with no failing test is the same defect class as F2: the other
fifteen titles all pass after the hoist. `attributes a single-row id generation
failure and rethrows the same error instance` mocks `uuid` so `v7` throws, and
asserts one capture tagged with the lane. It fails if the call moves above the
guard.

**Done when**: six of T1's writer cases pass.

---

### T3 — `writeRefusalEvents` attributes the set arm

**Blocking edges**: T2 (same file; also reuses `captureLedgerWriteFault`).
**Files**: `src/lib/refusals/write.ts`.

**The guard starts at the row map (`write.ts:904`), not at the INSERT
(`write.ts:925`).** Round 1 finding F2, accepted: the set arm materializes its
rows in a separate statement before the INSERT, and two things in that map can
throw. `occurred_at` calls `input.occurredAt.toISOString()` at `write.ts:922`,
and `new Date(NaN)` is a type-valid `Date` whose `toISOString()` raises
`RangeError: Invalid time value`. `uuidv7()` at `write.ts:905` can fail the same
way. Either aborts the deciding transaction with **no ledger row and no
attribution** — the exact defect this ticket exists to close, one layer in. So:

```ts
try {
  const rows: RefusalEventRow[] = inputs.map(…);
  await tx`INSERT INTO refusal_events ( … ) SELECT … FROM jsonb_to_recordset( … )`;
} catch (error) { … }
```

`endDisabledEpisode()` at `write.ts:900` stays outside, as in T2.

The lane tag is computed **in the catch**, from `inputs`, never from `rows` —
`rows` may not exist when materialization is what failed. The computation is a
`Set` over `refusalSource` strings and cannot itself throw.

Beyond that, the set arm differs in exactly two ways, and both follow from its
input being `readonly WriteRefusalEventInput[]`:

- **The lane tag.** The type permits mixed `refusalSource` values even though
  both call sites pass one lane. The tag is the **distinct sources, sorted,
  comma-joined**. Sorting is what makes the tag deterministic — an input-order
  tag would open two Sentry issue facets for the same pair of lanes. Cardinality
  is bounded at 127 and is 1 in practice.
- **`extra` is exactly `{ row_count, account_id, account_count }`, never per-row
  ids.** `ask_withheld` can propose up to `MAX_DATA_ROWS` (5,000) Refusals in one
  build; 5,000 subject ids in a Sentry event is a payload, not a signal.
  `account_id` is the single distinct value or `null`, `account_count` the
  distinct count — both bounded.

  > **Superseded by review round 1 (deviations D4, D10).** This section first
  > specified `{ row_count, refusal_lanes }`, justifying the duplicated lane
  > string by a Sentry tag truncating at 200 characters. All seven lanes sorted
  > and joined is **108**, so that rationale was unreachable and three axes
  > caught it independently; the tag already carries the lane and a tag is
  > filterable where `extra` is not. The tenant identity replacing it answers a
  > separate adversarial finding — the writer cannot see the batch or the run,
  > and without an account a rolled-back set write leaves an operator nothing to
  > join on.

The empty-input return at `write.ts:891` stays **first**, before the flag read
and before this block, exactly as it is today.

**The set arm gets its own reporter-throw test** (round 1, F3). One shared
`captureLedgerWriteFault` makes a divergent set-arm reporter impossible *if the
plan is followed* — but an eval must fail on a wrong implementation whatever the
plan said, and a single-row-only reporter test does not.

**Done when**: the remaining six writer cases pass.

---

### T4 — `persist.ts` keeps one wrapper, narrowed to one fault and one lane

**Blocking edges**: T2.
**Files**: `worker/jobs/response-generation/persist.ts`.

Three edits:

1. **Delete** the `withLedgerAttribution('held_draft', …)` call at
   `persist.ts:1128`. Its own #1079 docblock says the invocation *"still wraps a
   write and nothing else"* — the writer now covers that write, so keeping it
   raises two Sentry events for one failure. The bare `writeRefusalEvent(tx, …)`
   remains.
2. **Narrow** the `policy_gate_held` wrapper at `persist.ts:976` to cover
   `resolvePolicyGateRefusal` **only**. The write moves out from under it:

   ```ts
   const refusal = withLedgerAttribution(
     'policy_gate_held', responseId,
     () => resolvePolicyGateRefusal(autoDecision.blockReasons),
   );
   if (!refusal) return;
   await writeRefusalEvent(tx, { … });
   ```

   `resolvePolicyGateRefusal` is synchronous, so the wrapper becomes
   synchronous too. That is a simplification, not a compromise.
3. **Narrow the type.** `lane: 'held_draft' | 'policy_gate_held'` becomes the
   single literal `'policy_gate_held'`. One caller, one lane. The parameter
   could go entirely; keep it so the tag stays visible at the call site.

Guard 4 at `persist.ts:966` is **untouched**. It still returns before the
resolve, and `wouldRecordRefusal` / `unmappedBlockReasons` still cannot throw.

Correct the wrapper's docblock in the same edit. Two sentences go stale:
*"It covers two fault classes, not one"* becomes one class, and *"The
`held_draft` invocation still wraps a write and nothing else"* names a call
that no longer exists. A stale docblock beside a narrowed function is how the
next reader re-widens it.

**The narrowing needs its own test, and T1's list did not have one** (round 1,
F1, accepted). `raises exactly one capture for a policy gate write failure`
drives the real policy-persist path, forces a writer failure, and asserts the
capture count is one. Without it, leaving the write inside the wrapper doubles
every `policy_gate_held` write fault while all twelve original titles still
pass — the vocabulary-fault test never reaches the writer, and the one-capture
test covered `held_draft` only.

**Done when**: T1's four persist cases pass, and
`pnpm vitest run worker/jobs/response-generation` is green.

---

### T5 — The term, and the two rows

**Blocking edges**: T2, T3, T4.
**Files**: `CONTEXT.md`, `docs/directory.md`.

**Coin `Ledger attribution`** in `CONTEXT.md`'s Refusal ledger section, LOCKED:
tagging a Refusal-ledger fault so an operator can tell it from the decision the
Refusal was recording. It must carry an explicit *not to be confused with*
pointing at `Attribution window` and `Attribution match`, which are the
outreach-to-review family and share nothing but the word. Name its two fault
classes — the **write fault** the writer reports, and the **vocabulary fault**
`persist.ts` reports — and say that the two never fire for one failure.

`docs/directory.md`: update the `refusals/` → `write.ts` row (it currently
states the INSERT is not caught) and note the narrowing on `persist.ts`.
`ci:directory-map` requires a row per production file; this change adds no
file, so no row is added.

**Done when**: `pnpm ci:directory-map` passes and no doc sentence contradicts
the code.

---

### T6 — File the retry-cost follow-up

**Blocking edges**: none. Orchestrator, not a subagent.

The intake's first non-goal. File the ticket the split-out promised, citing
`worker/jobs/ResponseGeneratorWorker.ts:92,105,110` and this branch, and stating
the open question it inherits: what happens to the decision the ledger failed to
record if the retry ladder short-circuits.

---

## Verification

Gate rows beyond the standard set: `pnpm ci:directory-map`, `pnpm ci:tenant-scope`.

The live-DB suites in the surface (`write.integration.test.ts`,
`refusal-write.integration.test.ts`) must **run**, not SKIP. A gate carrying the
`TEST_DATABASE_POOL_URL` warning is not review-ready for this branch.

## Rollback

Revert the squash-merge commit. Additive telemetry, no schema, no contract, no
control-flow change. `REFUSAL_LEDGER_ENABLED=false` also disables the new
captures, because both arms still return before the new code.

## Review appendix

### Plan round 1 — Codex plan skeptic, 2026-09-04

`VERDICT: REVISE`. Four findings, all verified against source and all
**ACCEPTED**. Three questions were dispatched in one brief (failability, cited
artifacts, invariants); no delegate received a cloned brief.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | High | No test proves a `policy_gate_held` **write** failure yields exactly one capture. All twelve titles pass with the write left inside the wrapper. | ACCEPT — new test in T4 |
| F2 | High | The set arm materializes rows at `write.ts:904` before the INSERT at `:925`. `toISOString()` on a type-valid `new Date(NaN)` throws at `:922`, unattributed. | ACCEPT — guard moved to the row map in T3; new test |
| F3 | Med | The reporter-throw test covers the single-row arm only. | ACCEPT — new set-arm test in T3 |
| F4 | Low | `persist.ts:1046` is the outer `catch`, not the guarded capture (`:1047`–1055, capture at `:1048`). | ACCEPT — citation corrected in T2 |

F2 is the finding that mattered: it is this ticket's own defect reappearing one
layer in. Guarding only the statement would have shipped a writer that cannot
attribute its own row-construction failure.

The round also **confirmed** four things the plan asserted, which is why they are
not re-litigated later: production spells `INSERT INTO refusal_events` exactly
twice, both in `write.ts`; there are exactly nine direct helper calls, so the
plan's call-site table is complete with no omitted write path; no production
module under `src/lib/` imports from `worker/`; and no caller branches on the
ledger error's type, message, stack, `code` or `constraint_name`, so
catch-and-rethrow changes nothing any caller observes.

Test count rose 12 → 15. `estimated_test_lines` 350 → 420. The edit surface did
**not** change, so this is a deviations entry, not a surface amendment.

### Plan round 2 — verification only, resumed from round 1's session

`VERDICT: REVISE`. F1, F2 and F3 confirmed addressed with evidence. Three
residual items, all verified and all accepted:

| Item | Finding | Disposition |
|---|---|---|
| R2-a | F4 only half-applied — the plan cited `:1047`–1055 correctly, but the **intake invariant** still said `persist.ts:1046`. | ACCEPT — intake corrected |
| R2-b | T1 still said twelve promised tests, nine writer cases, three lane cases. | ACCEPT — now sixteen, twelve, four |
| R2-c | The new "do not hoist `uuidv7()`" instruction had **no test**. All fifteen titles pass after the hoist, leaving an id-generation failure unattributed. | ACCEPT — sixteenth test added |

R2-c is the same defect class as F2 and the reason the round earned its cost: a
prose rule that no test enforces is not a rule. `write.ts:61` imports
`v7 as uuidv7` from `uuid`, so the case is writable with `vi.mock('uuid')`.

The round also confirmed the F2 fix introduces no behavioural change: the empty
return at `write.ts:891` and the flag guard at `write.ts:895` still precede the
guard, `endDisabledEpisode()` at `write.ts:900` still sits outside it, and the
broadened guard captures only failures while materializing or executing the
ledger write.

Test count 15 → 16. `estimated_test_lines` 420 → 450. Edit surface still
unchanged.

### Plan round 3 — verification only, same resumed session

`VERDICT: APPROVED`. All three residual items applied, no fix-introduced
defects. The round independently recounted the title split and confirmed twelve
writer cases plus four lane cases equal the sixteen titles, none duplicated and
none unassigned. It also confirmed R2-c's test can actually fail on the hoist:
`write.ts:791` is a tagged-template interpolation, so a mocked `uuid` throw is
caught inside the planned guard, and moving the call above the `try` makes the
capture assertion fail.

**Plan gate closed at round 3 of 3.** No unresolved disagreement to surface.

### Round economics

Three rounds, one Codex session. Round 1 cold (120,104 tokens), rounds 2 and 3
resumed from it (15,853 and 19,355). Resuming cost about 15% of a cold start per
round, which is the whole reason the workflow forbids a cold verification round.
Net: 12 → 16 tests, and two of the four added tests close holes that would have
let the eval pass on a wrong implementation.
