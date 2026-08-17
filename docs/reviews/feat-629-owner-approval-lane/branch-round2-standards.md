# Branch review round 2 — standards & maintainability (#629 owner approval lane)

**Scope:** verification of the eleven round-1 findings plus the non-table FK-premise item.
Fix commits `b7299e2f` · `55e9744d` · `564129d1` · `bf3d76d0` · `351b8fb4`
(round-1 tree = `a45ac1f0`).
**Round-1 report:** `docs/reviews/feat-629-owner-approval-lane/branch-round1-standards.md`
**Reviewer stance:** verification only — no production file was edited. No new fronts were
opened against unchanged code; observations outside the eleven are in the appendix.

## Gate status (re-run in this worktree, against the branch head)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm ci:tenant-scope` | pass — entries 392, baseline 392 |
| `pnpm ci:static-policy` | pass — 1151 files |
| `pnpm ci:directory-map` | pass — 550 files, no missing or stale rows |
| `pnpm ci:db-imports` | pass (strict) |
| `pnpm ci:live-db-suites` | pass |
| live-DB suites (`approval.integration`, `batch-view.integration`) | 30 passed |
| panel / client / unit suites (5 files) | 78 passed |

Type-level claims were checked with a throwaway probe compiled against the worktree's own
`tsconfig` (`strict: true`, `noUncheckedIndexedAccess: true`), importing the real exported
types. Nothing in the repo was modified to run it.

---

## Verdict

**Nine FIXED, one PARTIAL, one NOT FIXED, one NOT-FIXED-BY-DESIGN.** The FK-premise item is
struck at all three sites and the replacement statement is *true* (verified against
`appendRunStep`, which does take `SELECT … FOR UPDATE` on the run row). Two items did not
land: the `parentRunId` leak (F10) was claimed fixed and the routes were never touched, and
the false structural claim (F7) survives in the third of its three places — where the fix
round also introduced a *new* false sentence.

---

## Per-finding verdicts

### F1 — `approval.ts:252` refusal after mutation → **FIXED**

The lost-CAS branch now throws (`src/lib/solicitation/approval.ts:332-336`) with a named
message, and the 14-line comment above it states the reasoning rather than just the rule.

- `{ status: 'already_approved' }` is still reachable, and from the **state gate** where it
  belongs: `approval.ts:208-212` returns it when `state !== 'built'` and `approved_at` is
  non-NULL — before any write.
- The double-submit test still passes:
  `src/lib/solicitation/__tests__/approval.integration.test.ts:555` asserts
  `{ status: 'already_approved' }` **and** that `approved_at` did not move.
- **No partial-write path survives.** Every branch between the exclusion `UPDATE`
  (`:294-307`) and commit was read: the CAS throws, `recordStep` throws on a missing run,
  `closeBatchIfSettled` throws on a missing batch, and there is no early `return` carrying a
  non-`approved` status. `haltBatch`'s `already_halted` at `:443` is likewise write-free —
  a lost latch CAS wrote zero rows.

The round-1 report cited the *old* `:267` throw as the house-style precedent. That throw is
gone, and correctly so: `no_send_parent` turned out to be genuinely reachable (a `sendCount
=== 0` batch never mints a parent, EXEC D21), so it is now a refusal at `:231-234`, moved
*ahead* of the readiness check because readiness passes vacuously over zero send asks. Two
impossible-vs-possible states, two correct treatments. The inconsistency is resolved.

### F2 — `panelCopy`'s nested ternary with a silent else → **FIXED**

`PanelMode` is a discriminated union whose haltable member carries its state
(`ApprovalPanel.tsx:98-106`), `HaltableState` is an `Extract` over `SendLaneView['batchState']`
(`:93-96`), and `haltableBody` (`:170-179`) switches over exactly three arms with no
`default`. `panelCopy`'s haltable arm is now one line (`:230-231`) and never re-reads
`lane.batchState`.

**A fourth state is a compile error, in both places.** Probe results under this repo's
`tsconfig`:

- routing a non-haltable state onto the member —
  `TS2322: Type '"pending" | "built" | … ' is not assignable to type 'HaltableState'`
- widening `HaltableState` without adding the arm —
  `TS2366: Function lacks ending return statement and return type does not include 'undefined'`

### F3 — `LaneOutcome.status: string` → **FIXED**

`LaneStatus = ApproveBatchResult['status'] | HaltBatchResult['status']`
(`ApprovalPanel.tsx:281`), and `LANE_REFUSAL_COPY` is
`Readonly<Record<LaneStatus, string | null>>` (`:293`) with an arm per member — the success
discriminants carry an explicit `null`, which is the forcing function round 1 asked for.

- A type-equality probe confirms `LaneStatus` is **exactly** the nine members of the two
  server unions — it is derived, not re-spelled.
- Deleting a key is a `tsc` error: `TS2741: Property 'not_found' is missing …`.
- **Unknown wire strings degrade safely.** `toLaneStatus` (`:311-315`) `Object.hasOwn`-checks
  the record's own keys and returns `null` otherwise; `refusalCopy` (`:368-370`) then returns
  `GENERIC_REFUSAL`. Its "Nothing changed" clause stays honest because that path is entered
  only on 400/409 (`:352-355`) — a refused write. Transport failure and any other non-2xx go
  to `{ kind: 'unconfirmed' }`, which deliberately claims nothing.

### F4 — `readBuiltBatch` at 241 lines / 6 params → **FIXED** (the stated reasoning does not hold; the decision does)

`readSendLane` is extracted (`batch-view.ts:373-514`) and `readBuiltBatch` is
`:516-618` — **103 lines**, with the `options.sendLane` branch reduced to a single ternary at
`:595-597`. The extraction also carries a real bonus the finding did not ask for: the two
readiness counts were decorrelated onto their own base relations (`:456-491`), killing the
Cartesian intermediate the old LEFT-JOIN form built on moderation-heavy batches.

**On the six parameters, judged rather than re-flagged:**

The stated reason — bundling the tenant keys would hide invariant #8 — **is not true as an
enforcement argument.** `ci:tenant-scope` (`scripts/ci/tenant-scope-audit.ts`) matches SQL
column identifiers (`account_id` / `business_id`, qualified or not) inside statement text; it
never reads a TypeScript signature. Verified by grep: nothing in that script inspects
parameter names. An options object would have changed nothing about what the audit can see.

**But the decision is right on a different ground, so I am not re-opening it.** The
positional `(sql|tx, accountId, businessId, …)` shape is this file's existing convention —
`readLatestBatch:636`, `markBatchReviewed:705` — and `readBuiltBatch` is a module-private
helper with exactly one call site, where the interface cost a Long Parameter List measures is
close to zero. Introducing a second parameter convention inside one file to satisfy a count is
a worse trade than the count. The substance of F4 — a 241-line function with a 110-line
conditional block inside it — is gone.

The residual is the one I already logged in the round-1 appendix, unchanged and not escalated:
three consecutive `string` parameters are transposable with no type error, and `readSendLane`
is now a fourth site of that shape.

### F5 — glossary: "Stop"/"stoppable" against the Halt latch Avoid list → **FIXED** (by owner decision D12)

Both halves verified:

- **No stop-vocabulary identifier remains.** `rg 'stoppable'` over the repo returns zero hits
  in `src/`; the only survivors are the round-1 report itself, D12's own record of the rename,
  the CONTEXT.md sentence describing it, and two unrelated pre-existing files
  (`e2e/fixtures/zernio-fixture-server.ts:165`, a #643 review doc). `PanelMode`'s member is
  `haltable` (`ApprovalPanel.tsx:103`), `ApprovalVerb` is `'approve' | 'halt'`, the route is
  `HALT_PATH`, the handler is `onHalt`. `RequestsClient.tsx:347-404`'s local `stop`/`stopped`
  are the poll-loop abort, unrelated to the latch and pre-existing.
- **The carve-out is written.** `CONTEXT.md:71` now scopes the Avoid list explicitly and
  carves out exactly one word for owner-facing copy, naming the shipped strings and re-stating
  that code-level names still obey the term. `D12` records the decision, the rejected wider
  amendment, and the reasoning.

The `resume` sub-issue is OPEN by owner decision and is not re-flagged here, per brief. One
further residual is recorded in the appendix rather than the table, because it turns on an
ambiguity inside the newly-written sentence rather than on a defect in the code.

### F6 — `laneMessage` unkeyed and never cleared → **FIXED**

`LaneSentence` carries `{ scope, message, outcome }` (`RequestsClient.tsx:55-60`);
`laneSentence` reads `''` whenever `lane.scope !== currentScope` (`:79`); `onLaneChanged`
stamps the current scope (`:92-98`); `onRetry` clears it (`:103-106`); and the loop's
`announcement` outranks it in the live region (`:131`).

Round-1's concrete scenario now behaves: approve at A → switch to B → the sentence is
scope-superseded → `COMPLETION_ANNOUNCEMENT` reaches `LiveRegion`. The `unconfirmed` case is
routed to a `role="alert"` banner instead of the region (`:133-137`) so it is not announced
twice — a deliberate addition, documented at `:126-129`.

### F7 — the false "only file that renders a control" claim → **PARTIAL**

Two of three sites are fixed, and fixed well:

- `ApprovalActions.tsx:8-14` now enumerates both controls, and explicitly disclaims the
  over-broad inference: *"not a claim that no other file renders anything."* The D22
  checkability claim is narrowed to "adding a **third verb** means widening `ApprovalVerb`",
  which is true.
- `AskList.tsx:28-29` says the checkbox is "the lane's only control outside `ApprovalActions`".
- `ApprovalPanel.tsx:44-48` names both kinds of control.

**`docs/directory.md:128` was not touched.** It still reads, verbatim:

> the only file in the lane that renders a control at all … adding one would have to widen
> `ApprovalVerb` here and add an arm there.

That is the exact sentence the finding was about, in the exact place round 1 said mattered
most ("a false structural claim in three places is worse than no claim: the next author will
trust it"). Two files now say one thing and the code map says another.

**And the fix round made the same row worse.** `docs/directory.md:126` still describes
`toRows` as projecting survivors onto `{outreachId, contactName, deliveryStatus}` and
concludes *"so no rendered subject or body is reachable downstream even by accident."* Commit
`564129d1` deliberately reversed that: `AskRowView` now carries `subject` and `body`
(`AskList.tsx:56-62`), because rendering them is the feature's primary user-visible behaviour
(D13, defect 1). The code map now asserts the absence of the thing the fix round shipped.

`ci:directory-map` cannot catch either one — it covers `worker/` and `src/lib/` only, and both
rows describe files under `src/app/`. Fixing them is two sentences in one file.

### F8 — `scoped-batch-route.ts` duplicates `withScopedContact` → **NOT FIXED BY DESIGN**

Verified as still a faithful duplicate, statement for statement:
`withScopedBatch` (`scoped-batch-route.ts:93-127`) and `withScopedContact`
(`src/app/api/dashboard/contacts/location-scope.ts:132-165`) both run gate-outside-the-`try`
→ resolve scope → validate input → `await handler(scoped)` → `catch` → `reportCaughtError`
→ `errorResponse(failureMessage, 500)`, and both headers enumerate the same four rationales
in the same order.

`withScopedBatch` remains the strictly more general form: it parameterizes both the gate and
the input reader, and `withScopedContact` is that shape with `requireContactsWriteAccess` and
a `params`-based id resolver. **My original recommendation stands unchanged** — collapse them
behind a signature that accepts Next's second handler argument, as a follow-up ticket. Not
escalated.

### F9 — `haltReason: string | null` → **FIXED**

`HaltReason` is exported as a closed five-member union with a 20-line rationale
(`batch-view.ts:150-155`), `SendLaneView.haltReason` is typed to it (`:172`), and the panel
consumes it: `HALT_BODY` (`ApprovalPanel.tsx:190-200`) is a total `Record<HaltReason, string>`
in which **only `owner_veto` and `owner_halt` say "you"** — `admin_halt` names support, and
the two system reasons describe what happened without an actor.

Probes: `HaltReason` is exactly the five expected members; `SendLaneView['haltReason']` is
exactly `HaltReason | null`; deleting a `HALT_BODY` key is `TS2741`.

The `UNKNOWN_HALT_BODY` fallback (`:205-211`) is a reasonable addition — the read model
asserts the CHECK rather than re-validating it, so a value outside the union is possible in
principle and must read as a stop rather than a blank line.

### F10 — `jsonResponse(result)` leaks `close.parentRunId` → **NOT FIXED**

`src/app/api/dashboard/solicitation/batch/approve/route.ts:67` and
`.../halt/route.ts:54` still return the raw domain union. Neither route file appears in
`git diff a45ac1f0..HEAD`; their last touching commit is `f1242a8e`, from before round 1.
`CloseBatchIfSettledResult`'s `closed` arm still carries `parentRunId`
(`src/lib/solicitation/outreach.ts:203-209`), and neither `approveBatch:370-376` nor
`haltBatch:480` narrows it.

D13 records this as done — *"the internal `agent_runs` UUID no longer ships to the browser"* —
and it does not. Recording a fix that was not made is worse than the leak: the next reviewer
reads the deviation instead of the route.

**Reachability is higher on halt than on approve.** `approveBatch` nulls `close` unless the
approval settled the batch outright (the exclude-everything case), so approve leaks only
there. `haltBatch` returns `close` **unconditionally**, and a halt cancels every
`rendered`/`queued` row — so the ordinary halt of a batch with nothing in `sending` settles,
returns `{ status: 'closed', parentRunId, disposition, parentStatus, counts }`, and ships all
of it. The client reads exactly one field, `result.status` (`ApprovalPanel.tsx:353-355`).

Nothing caught it because the route tests only ever stub `close: null` and
`close: { status: 'not_settled' }`
(`src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts:136,142`) — the
`closed` arm is never exercised through a route.

Fix is unchanged from round 1: return the discriminant plus the counts the panel uses.

### F11 — intake title implemented in the wrong suite → **FIXED**

`src/lib/solicitation/__tests__/batch-view.integration.test.ts:397` carries the title
character-identical to the intake
(`…-intake.json:101`) and to the `approval.test.ts:85` copy, and it genuinely exercises the
read model: three `readLatestBatch(…, { sendLane: true })` reads across pending → ready →
approved, asserting `batchState`, `ready`, `pendingRenders`, `approvedAt`, `vetoDeadlineAt`
and `haltReason`. A comment at `:392-396` states why both copies exist and why the batch is
seeded relative to `NOW` (a fixed `built_at` would derive `expired`). The `approval.test.ts`
copy is left in place per the plan's "asserted twice on purpose" note. Both suites pass.

### Non-table item — the copied-and-false FK `FOR KEY SHARE` premise → **FIXED at all three sites**

1. `src/lib/solicitation/approval.ts:20-28` — states the divergence from `outreach.ts`, names
   the correct first lock, and instructs against restoring the copied sentence.
2. `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts:114-130` — same correction,
   with *"a lock analysis resting on an untrue premise is worthless even when its conclusion
   happens to be right."*
3. `docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md` D8 — the old sentence
   struck through with `~~…~~` and dated, conclusion preserved *a fortiori*.

**The replacement statement is true, which is the part worth checking rather than assuming.**
`recordStep` → `appendRunStep` (`src/lib/agents/run-spine.ts:468-471`) opens with
`SELECT 1 FROM agent_runs WHERE id = … FOR UPDATE`, and `approval.ts:137-147` reads
`agent_runs` with no lock clause. So `recordStep`'s own row lock genuinely is this
transaction's first lock on the send parent, and it is taken strictly after the advisory lock
and the `solicitation_batches` `FOR UPDATE`. Batch → run holds.

---

## Untriaged appendix (not findings; recorded so they are not lost)

- **The D12 carve-out's scope sentence and its closing sentence disagree.** The amended Avoid
  list is scoped as *"internal vocabulary — identifiers, comments, docs, run-step and reason
  values"*, but the carve-out's last clause narrows the binding rule to *"code-level names"*.
  Under the first reading the branch is non-compliant in a dozen comments
  (`approval.ts:395`, `ApprovalPanel.tsx:45,88,182,204`, `batch-view.ts:142,145`,
  `halt/route.ts:1`, `docs/directory.md:358`) — nearly all of which are comments *about* the
  owner-facing copy, and one of which (`ApprovalActions.tsx:19`) exists to explain the
  carve-out itself. Under the second reading it is fully compliant. Note also that
  CONTEXT.md's own **Halt latch** definition has always opened *"…that stops a send batch"*,
  which is evidence the list was never read as banning the English verb. Not escalated:
  cosmetic, owner-decided territory, and resolvable with one word in the scope clause.
- **`LANE_REFUSAL_COPY.not_approvable` does not distinguish `reason: 'no_send_parent'`.** The
  copy says "can no longer be approved", which is slightly wrong for a batch that never could
  be. Unreachable in practice — the panel renders `nothing_to_send` and offers no control — so
  it only answers a direct POST or a stale tab.
- **`docs/directory.md:126` claims "Three exhaustive switches"** for `ApprovalPanel`. There
  are now four (`panelMode`, `actionVerb`, `haltableBody`, `panelCopy`). Trivially stale; folds
  into the F7 doc fix.
- **`approvedAnnounce(sendCount)` still uses the client's count** rather than the response's
  `approvedCount` (round-1 appendix item, unchanged). One line, still worth it.
- **`readSendLane`'s four positional parameters** add a fourth site of the transposable
  `(accountId, businessId, batchId)` shape. Consistent with the file, noted under F4.
