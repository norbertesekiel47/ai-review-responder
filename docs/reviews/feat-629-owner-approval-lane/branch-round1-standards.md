# Branch review round 1 — standards & maintainability (#629 owner approval lane)

**Scope:** `git diff a6e38fe9b1fbc14da340947319976615eccebe5b...HEAD` — 36 files, 13 production
files (2 domain modules, 4 routes, 1 route runner, 3 client components, 1 CSS, 1 migration,
1 spine registry entry).
**Method:** `/thermo-nuclear-code-quality-review` applied to the branch diff, plus the repo's
own audits run against the worktree.
**Reviewer stance:** review only — no production file was edited.

## Gate status (run in this worktree, not inherited)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm ci:tenant-scope` | pass — entries 392, baseline 392 (no new allowlist entry) |
| `pnpm ci:static-policy` | pass — 1151 files |
| `pnpm ci:directory-map` | pass — 550 files, no missing or stale rows |

The branch is mechanically clean. Everything below is judgement, not a red gate.

---

## Verdict

**Do not approve as-is.** No architecture invariant is violated and no data-loss bug is live
today, but six findings clear the confidence bar, and two of them (F1, F5) are the kind that
get harder to fix after the surface ships. The engineering is unusually careful — the redaction
choke point, the derived halt reason, the validate-before-mutate ordering and the D8 lock
analysis are all better than this repo's median. The defects are concentrated in three places:
a refusal path that runs after a mutation, a client that re-types the server's closed unions as
`string`, and a glossary term the branch quietly stopped honouring.

---

## Findings (≥80% confidence)

### F1 — MEDIUM · `src/lib/solicitation/approval.ts:252`

`approveBatch` writes the exclusion `UPDATE` (`:223-234`), *then* runs the approval CAS, and on
a lost CAS returns `{ status: 'already_approved' }` at `:252`. Because postgres.js commits when
the `sql.begin` callback resolves normally, that refusal **commits the `owner_excluded`
cancellations it just wrote** while telling the caller the approval did not happen.

This directly contradicts the contract the same function states 46 lines earlier (`:201-206`):

> Validate first, mutate second — a refusal then leaves the batch untouched because nothing was
> written yet.

and CONTEXT.md's **Ask exclusion** term, which promises "there is no window in which some rows
are cancelled and the batch is not yet approved."

Reachability today: not reachable. `lockBatchForAction` takes the per-business advisory lock and
`FOR UPDATE` on the batch row, so a serialized second caller re-reads `approved_at` as non-NULL,
`deriveBatchState` returns `approved`/`veto_window`, and the function returns at `:160-163`
before any write. So `:252` is dead defence.

That is exactly the problem. The file already has a house style for a structurally identical
"this cannot happen" state — the missing send parent at `:267-271` **throws** with a named
message, on the stated grounds that a broken invariant "is not a branch to absorb". Two
impossible states, two different treatments, and the softer treatment is on the one with a
data-integrity consequence. Meanwhile CONTEXT.md presents the CAS as the *live* double-submit
defence ("CAS'd on `approved_at IS NULL` so a double-submit re-approves nothing"), which reads
as though `:252` is load-bearing.

Pick one and say so:

- if the advisory lock is the guarantee, make `:252` `throw` like `:267` and delete the
  ambiguity; or
- if the CAS is the guarantee (which is what #631's auto lane will assume when it becomes a
  second approval writer), move the exclusion `UPDATE` to *after* the CAS so a refusal is
  genuinely write-free.

The second is the safer shape and costs nothing: the exclusion validation `SELECT` at `:209-221`
can stay where it is; only the `UPDATE` moves.

### F2 — MEDIUM · `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:130-141`

The file's own header advertises "three exhaustive switches with no `default`", and `panelMode`
(`:76-92`) and `actionVerb` (`:100-112`) deliver on it. The `stoppable` arm of `panelCopy` does
not: it reaches back past the mode it was handed and re-derives from `lane.batchState` in a
nested ternary whose final branch is an unlabelled else.

```
lane.batchState === 'veto_window' ? … : lane.batchState === 'sending' ? … : <else>
```

`panelMode` maps three states onto `stoppable`. Route a fourth there and it silently inherits
"Approved and waiting to go out. Stopping cancels everything that has not left yet." — a claim
that *nothing has left*, made at the one moment the owner most needs it to be true.

This is the "repeated conditionals signal a missing model" smell. `PanelMode` is lossy where the
copy is not, so the code pays for the collapse twice. Two clean fixes:

- split the mode (`stoppable_pre_send` / `stoppable_sending`) so one exhaustive switch answers
  both questions; or
- let `panelMode` return the copy alongside the mode, so `BatchState` is destructured exactly
  once in the file.

Either deletes the ternary and restores the invariant the header claims.

### F3 — MEDIUM · `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:187-205`

`LaneOutcome` carries `status: string` and `REFUSAL_COPY` is `Record<string, string>`. Both
route results are closed unions (`ApproveBatchResult`, `HaltBatchResult` in `approval.ts`), and
the panel already type-imports from `src/lib/solicitation/` — invariant #1 permits `import type`
in client code — so the link was available and was not taken.

Concrete consequence: add a refusal discriminant to either union (which #631 will, when the auto
lane widens `approveBatch`) and nothing fails to compile. The owner gets
`GENERIC_FAILURE = 'Something went wrong. Nothing changed — try again.'` The second clause is an
assertion about server state that the client cannot make for an unmapped status, and for a
refusal that *did* change something it is simply false.

The repo already treats this as a solved problem and says so in `docs/directory.md`
§ `src/lib/solicitation/`, about `redemptionConfirmsSuppression`:

> a total `Record` over the outcome union so a fifth outcome without an answer is a **`tsc`
> error**

Same move here: `Record<ApproveBatchResult['status'] | HaltBatchResult['status'], string>` with
an arm per member. The success discriminants need copy or an explicit `''`, which is the point —
it forces the author to state that `approved` has no refusal sentence rather than letting the
index signature answer for them.

### F4 — MEDIUM · `src/lib/solicitation/batch-view.ts:322-563`

`readBuiltBatch` is now **241 lines with 6 parameters and 4 inline SQL statements**. Before this
branch it was ~130 lines with 5. The growth is one `if (options.sendLane) { … }` block of ~110
lines holding two of those four statements plus the `SendLaneView` assembly.

Named smells, all of them on the thermo-nuclear flag-aggressively list: Long Function, Long
Parameter List, and "one-off booleans / nullable modes that complicate existing control flow".
The boolean is not the problem — invariant #13 requires the caller to resolve the flag, and
`options.sendLane` as a *required* parameter (documented at `:576-579`) is the right call. The
problem is where the branch on it lives.

The judo move is small and obvious: extract

```
readSendLane(tx, { accountId, businessId, batchId }): Promise<{ attempts; sendLane }>
```

returning `{ attempts: [], sendLane: null }` when off. `readBuiltBatch` drops back to ~130 lines
with no conditional at all, the send lane gets its own named seam and its own test surface, and
the two large SQL statements stop competing for attention with the funnel query. Nothing about
behaviour or the flag ownership changes.

Note this is the *opposite* of what the branch did for the routes and the panel: those two got
split into named seams (D9), correctly. The read model was left un-split.

### F5 — MEDIUM · Glossary: **Halt latch**'s `Avoid` list is not honoured, and was not amended

`ApprovalActions.tsx:60` · `ApprovalPanel.tsx:66, 83, 104, 130, 137, 139-140, 149-150, 204, 251,
258-259, 396`

CONTEXT.md's **Halt latch** entry ends:

> _Avoid_: pause, stop, cancel batch, resume.

The branch makes "stop" the owner-facing verb for exactly that mechanism — `Stop this batch`,
`Stopping…`, `You stopped this batch`, `Batch stopped`, `there is nothing left to stop` — and
promotes it into an identifier, `PanelMode = … | 'stoppable' | …`.

Three facts make this a finding rather than a nit:

1. The plan (`2026-08-16-629-owner-approval-lane.md:17-24`) opens with a section titled
   **"Glossary — use these terms verbatim (`CONTEXT.md`)"** that lists **Halt latch**, and then
   at `:1260` mandates `Stop this batch` as the copy. The plan contradicts itself.
2. This branch **edits CONTEXT.md** (it adds two LOCKED terms). The Halt latch `Avoid` list was
   in the same file, in the same edit, and was left alone.
3. None of the ten deviation entries records the conflict. D6 exists precisely for "repo
   conventions the plan did not name"; this is the inverse and got no entry.

The repo treats `Avoid` lists as governing owner-facing nouns, not just engineering vocabulary —
**Review import** spells it out inline: "_Avoid_: backfill (the user-facing noun is **import**)".

Resolve it one of two ways, but resolve it:

- **Keep the copy, amend the term.** "Halt" is not SMB-owner English, and there is a real
  argument that the Avoid list was written in #619 D10 when the latch had no owner-facing
  surface at all. Then CONTEXT.md must say so — narrow the entry to
  `_Avoid_ in code and docs: pause, cancel batch, resume; the owner-facing verb is **stop**` —
  and `'stoppable'` should still become `'haltable'`, because that one is code.
- **Keep the term, change the copy.** "End this batch" / "You ended this batch" satisfies both.

What is not acceptable is the current state, where the glossary and the shipped surface disagree
and nothing in the branch admits it.

Same class, weaker: **Ask exclusion**'s `Avoid` list includes "skip ask", and
`ApprovalPanel.tsx:128` reads "Deselect anyone you would rather **skip**". "Deselect" carries the
verb, so this is borderline; I would fix it in the same pass ("anyone you would rather not
contact") rather than argue about it.

### F6 — MEDIUM · `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:52, 92`

`laneMessage` is component state that is never cleared and is not keyed by location scope:

```
<LiveRegion message={laneMessage !== '' ? laneMessage : announcement} />
```

After the owner's first approve or halt, `laneMessage` is non-empty for the rest of the session,
so `announcement` can never reach the live region again.

Concrete failure: approve at location A → switch to location B, whose batch is still building →
building → built fires → `useLatestBatch` sets `COMPLETION_ANNOUNCEMENT` → a screen-reader user
hears nothing, because the region still holds "Approved. 3 messages will send…". The stale
sentence also describes a location the owner has left.

The comment at `:58-67` reasons the collision away — "that one fires only on a building → built
transition, which cannot follow an approval of an already-built batch" — and the reasoning is
sound for one location and only one location. It misses the switcher. Which is notable, because
the hook it is reasoning about goes out of its way to handle exactly that case: `useLatestBatch`
scope-keys both `phase` and `announcement` (`:285-287`) and its docstring calls out that
`wasBuilding` is a per-run local "so it cannot leak across a scope switch and announce another
location's batch as if it had just finished." The new state took none of that treatment.

Fix: key `laneMessage` by scope the same way (`{ scope, message }` with a `superseded` read), or
clear it in `onLaneChanged`'s consumer when `currentScope` changes.

---

## Findings (low)

### F7 — LOW · `ApprovalActions.tsx:8-9` — the split's stated justification is not true

The file, `ApprovalPanel.tsx:33-34`, and the new `docs/directory.md` row all assert that
`ApprovalActions.tsx` is "the only file in the lane that renders a control at all", and derive
from it that D22 (no edit, no regenerate affordance) is structurally checkable: "adding one would
mean widening `ApprovalVerb` and touching `actionVerb`."

`SelectableAskList` renders a checkbox per row (`AskList.tsx:76-82`). That is a control, in
another file, already wired to a callback. An edit affordance would go there — beside the
checkbox, on the row it edits — and would touch neither `ApprovalVerb` nor `actionVerb`.

The split is still worth keeping (F8 aside, it is what took `ApprovalPanel`'s cognitive
complexity from 19 to below threshold). But the *guarantee* it advertises is not delivered, and a
false structural claim in three places is worse than no claim: the next author will trust it.
Either restate it accurately ("the only file that renders an **action button**"), or move
`AskRowView`'s checkbox here too and make the claim real.

### F8 — LOW · `scoped-batch-route.ts:93-127` vs `location-scope.ts:132-165` — the duplication moved up a level

`withScopedBatch` and `withScopedContact` are the same control flow, statement for statement:
gate outside the `try` (rethrow contract) → resolve location scope → validate the route's input →
`await handler(scoped)` → `catch` → `reportCaughtError(endpoint, …)` → `errorResponse(failureMessage, 500)`.
Both header comments enumerate the same four rationales in the same order.

The branch's own header names the relationship ("Batch-shaped sibling of `withScopedContact`") and
D9 cites it as precedent — but naming a duplicate is not resolving one. `withScopedBatch` is
already the more general form: it parameterizes the gate and the input reader. `withScopedContact`
is that shape with `requireWriteAccess = requireContactsWriteAccess` and a `readInput` that awaits
`params` and validates the UUID. Collapsing them removes a second copy of the exposure policy
that both headers spend a paragraph explaining and that a future route will now have three places
to get wrong.

The one real obstacle is Next's second handler argument (`{ params }`), which the batch form does
not take. That is a signature change on the runner, not a redesign.

Not a blocker — a follow-up ticket is a reasonable answer. But the branch should not record this
as "duplication went 131 lines → 0" (D9) when the runner it introduced is itself the 132nd line.

### F9 — LOW · `src/lib/solicitation/batch-view.ts:148` — `haltReason: string | null`

`SendLaneView` types `batchState` as the closed `BatchState` union and, one line later, ships the
halt reason as a bare `string`. The reason set is closed and enumerated in three places —
CONTEXT.md's **Halt latch** ("five reasons"), migration 091/108's CHECK, and `OwnerHaltReason` in
`approval.ts:43` for the two an owner can cause — but no exported TS union covers all five, so
the wire type degrades to `string`.

Because it is untyped it is also unread: `panelCopy`'s `halted` arm (`ApprovalPanel.tsx:147-151`)
hard-codes "**You** stopped this batch." for every reason. Today that is always true —
`approval.ts` is the only writer of `halt_reason` in the tree (verified by grep). It stops being
true the moment #630's releaser writes `send_window_elapsed`, the admin surface writes
`admin_halt`, or the expiry path writes `batch_expired`: the owner will be told they did
something they did not do, on the screen whose entire premise is "nothing happens without you".

Cheap fix now, expensive to retrofit later: export `HALT_REASONS`/`HaltReason` from `outreach.ts`
(where `BATCH_STATES` already lives), type the field, and make the halted arm a total switch. The
copy can stay one sentence until there is a second writer — what matters is that adding the
writer becomes a compile error.

### F10 — LOW · `approve/route.ts:67` · `halt/route.ts:54` — the domain union is serialized whole to the browser

Both routes `jsonResponse(result)` the raw result union. For a settled batch that includes
`close`, i.e. `CloseBatchIfSettledResult` — `parentRunId` (an internal `agent_runs` UUID),
`disposition`, `parentStatus`, and the full `counts` breakdown including `withheldByReason`.

The client reads exactly one field: `result.status` (`ApprovalPanel.tsx:223-225`). Nothing else
is consumed anywhere.

The Requests surface has an explicit posture against this — `BatchReport.tsx`'s header states
"ADR 0012: no star rating or sentiment signal, and no internal id, is ever rendered". Sent-but-
not-rendered is weaker than rendered, so this is low rather than medium, but it is the same
boundary: an implementation detail of the closure join is now part of a public route's response
shape, and the next consumer will read it.

Return the discriminant plus the two counts the panel actually uses.

### F11 — LOW · `src/lib/solicitation/__tests__/approval.test.ts:84-94`

The intake's `tests_to_add` (`…-intake.json:101`) declares
`"reports the derived batch state and approval readiness on the built batch view"`. It is
implemented in the **approval** module's suite, and asserts two `deriveBatchState` calls. It never
calls `readLatestBatch`, never touches `sendLane`, and never touches anything exported by
`approval.ts`. The property test 30 lines above already covers `deriveBatchState` exhaustively
over all six timestamps.

The behaviour it names *is* covered — `batch-view.test.ts:420-448` and the integration suite read
with `{ sendLane: true }` and assert the lane. So this is a title/placement defect, not a coverage
gap. Fix by deleting the block and letting the batch-view suite own the title, or by retitling it
to what it asserts.

---

## Missed simplification (no violation — recorded because nobody evaluated it)

**D7's third option: fix the auditor.** Three production SQL statements are now shaped against
their natural form purely to satisfy a parsing limitation in `scripts/ci/tenant-scope-audit.ts`:

- `approval.ts:70-111` — one statement split into two, with a 14-line comment
- `approval.ts:176-197` — `NOT EXISTS` rewritten as a `LEFT JOIN … o.id IS NULL` anti-join, with
  a 9-line comment
- `batch-view.ts:466-520` — two scalar subqueries rewritten as three `LEFT JOIN`s forcing
  `COUNT(DISTINCT …)` on both counts, with an 18-line comment

That is ~40 lines of comment and three non-obvious SQL shapes, all of which exist because
`stripSelectSubqueries` blanks parenthesised `SELECT`s before `splitTopLevelAnd` reads predicates.

D7 records two options and rejects one: allowlist (a false "deliberately cross-tenant" claim, and
a surface amendment) versus reshape. The third — teach the audit to descend into subqueries, or
give it the per-line pragma that `ci:outbox-seam` and `ci:live-db-suites` both already have — was
not considered. It is a one-file change to a CI script, it would delete all three workarounds and
all forty lines of comment, and it would stop this cost recurring on every future
solicitation query. Every subsequent author in this lane now pays the same tax.

The comments themselves do carry their weight (the brief asked): each states the rule, names the
audit function, and says "do not re-nest". They are the right mitigation for a constraint that is
staying. They are the wrong mitigation for a constraint that could be removed.

## D8 lock analysis — sound, one imprecise premise

The carve-out in `outcome-anchor-pairing.test.ts:104-130` is correct on the substance:

- `lockBatchForAction` takes the per-business advisory lock, then `solicitation_batches FOR UPDATE`,
  then reads `agent_runs` — verified at `approval.ts:69-111`.
- Every spine touch in both verbs (`recordStep` at `:273` and `:382`, `closeBatchIfSettled` at
  `:289` and `:394`) happens strictly after both locks. Verified by reading, not by trusting the
  comment.
- `closeBatchIfSettled`'s own contract (`outreach.ts:288-296`) demands exactly this — "batch → run
  is the sole order in this lane. Nothing may take the `agent_runs` row lock for the send parent
  before calling in" — and `approval.ts` complies: its `agent_runs` read is a plain `SELECT` with
  no `FOR UPDATE`.
- `reviews` and `businesses` are never touched. Correct.

One premise is copied from the `outreach.ts` precedent and is not true here: "the step INSERT's
implicit FK `FOR KEY SHARE` lands on the run row **the transaction already holds**". `approval.ts`
holds no lock on that `agent_runs` row — its read at `:101-111` is lock-free, so `recordStep`'s FK
share lock is the *first* lock this transaction takes on the run. The conclusion is unaffected
(that is still batch → run, still no ABBA pair), but the sentence asserts a lock the code does not
take, and the next author auditing this lane will check it. Worth a one-line correction.

The entry's forward-looking note — that `approval.ts` is the lane's only user-latency-bearing
caller of the advisory lock, affecting blocking *time* not *order* — is the most useful sentence
in the carve-out and is correctly scoped.

---

## Deep-module verdicts (the two late refactors, judged on their own terms)

| Seam | Verdict |
|---|---|
| `src/lib/solicitation/approval.ts` | **Deep, earns it.** Two functions hide the advisory lock, the CAS, the readiness anti-join, exclusion validation-then-cancellation, the run step and the settlement join. Interface is two inputs and two discriminated unions. Four future callers (#631's auto lane, the admin halt surface) would each re-spell the lock order otherwise. Keeping it out of `outreach.ts` is right: an actor in the signature is a different audience. |
| `batch/_shared/scoped-batch-route.ts` | **Earns it, with F8 attached.** Three callers, a real hazard made explicit (the per-route gate as a bound function, not a boolean — collapsing it 404s `reviewed` for every watch-mode customer today), and a config surface of four fields with a stated "a fifth means the seam is wrong" bound. That is a policy seam, not a wrapper. Marked down only because it is the second copy of a policy the repo already owned. |
| `AskList.tsx` | **Earns it.** `AskRowView` is the redaction choke point's downstream half, `STATUS_LABEL` is a total `Record` over the delivery-status union, and the two-components-not-one-flag argument is correct — the settled list is structurally unable to offer a toggle. |
| `ApprovalActions.tsx` | **Thin — kept for the wrong stated reason.** 65 lines, 5 props, body is one early return and one ternary over two nearly identical buttons; it hides no decision the caller has not already made (`verb`, `sendPhrase`, `busy` all arrive computed). Its stated justification — sole renderer of controls — is false (F7). It survives on a weaker but real ground: it took `ApprovalPanel` under the complexity threshold. If the D22 claim is the reason it exists, fix the claim or fix the file; do not leave a wrapper defended by an argument that does not hold. |

## Invariant sweep

Checked explicitly; no violation found.

| # | Invariant | Note |
|---|---|---|
| 1 | Vercel = UI only | No `openai`/`bullmq`/`postgres` runtime import in `src/app/**` components. Panel's imports from `src/lib/solicitation/` are `import type`. Lint's boundary rule passes. |
| 3 | No unapproved posting | Different lane (solicitation, not reply publishing). `approval_method='owner'` written with `approved_by_user_id`, per 091's CHECK. |
| 4 | High-confidence unsafe held, not surfaced | Ported correctly. `toRows` (`ApprovalPanel.tsx:53-61`) is the single `AskAttemptView` consumer; `redacted` rows are dropped before projection; the flag-off path returns `attempts: []` so a stale rendered body cannot resurface. Verified no `subject`/`body`/`interpolationInputs` read exists in any of the three components. |
| 8 | Tenant scope | Both keys top-level on every statement in `approval.ts` and the new `batch-view.ts` lane query; `ci:tenant-scope` baseline untouched at 392. |
| 12 | Entry points orchestrate | All four routes are adapters: bind config, one module call, map the union. No error branch over ~30 lines in a route. |
| 13 | Flags server-authoritative | `solicitationSendEnabled()` read only in `batch/route.ts:41` and `requireSolicitationSendWriteAccess`; `sendLane: null` is the wire signal; `ci:static-policy` confirms no new `NEXT_PUBLIC_*`. |
| 15 | DB client injected | `approval.ts` and `batch-view.ts` take `Sql`/`TransactionSql`; only the route files import the singleton. |
| — | No `any`, no silent catch, no `crypto-js` | Clean. `readJsonObject`'s bare `catch { return null }` matches nine existing precedents (`settings/route.ts:233`, `settings/voice/route.ts:134`, …) — validation boundary, not a swallowed error. |
| — | Migration | 108 is wrapped in one transaction with `SET LOCAL lock_timeout = '3s'` (D5), re-spells 091's predicate whole, comments the constraint. Correct per `new-migration`. See appendix for one optional improvement. |

---

## Low-confidence appendix (deliberately kept out of the table)

- **`MODERATION_REASON = 'moderation_high'` re-spelled in the client** (`ApprovalPanel.tsx:44`).
  `batch-view.ts:76` owns `MODERATION_HIGH` but does not export it, so there is no constant to
  import and nothing is technically violated. `satisfies RenderWithholdReason` (that type *is*
  exported) would at least tie the literal to the union. Exporting the constant would be better.
- **Migration 108 could avoid the validation scan.** `ADD CONSTRAINT` takes ACCESS EXCLUSIVE and
  scans the whole table; the new predicate is a strict superset of 091's, so the scan is
  guaranteed to pass. `ADD CONSTRAINT … NOT VALID` + `VALIDATE CONSTRAINT` in a second transaction
  would shorten the exclusive hold. At current `solicitation_outreach` volumes this is
  theoretical, which is why it is here and not above.
- **`readLatestBatch(sql, accountId, businessId, options)`** — four positional parameters, three of
  them strings; `accountId`/`businessId` are transposable at every call site with no type error.
  Pre-existing shape, not introduced by this branch, but the branch touched every call site and
  could have folded them into the options object at the same cost.
- **`Screen`'s `scope: string`** (`RequestsClient.tsx:110`) — primitive where the location scope has
  a type in `LocationContext`. Narrowed from `currentScope` after the `!== 'all'` check, so it is
  safe; it just does not say so in the type.
- **`console.error` in the panel** (`ApprovalPanel.tsx:227, 230`). Client-side, consistent with
  other dashboard islands, and the repo's structured-logging rule governs server/worker code.
  Noted only because the two messages are the sole diagnostic for a failed owner write.
- **`approvedAnnounce(sendCount)` uses the client's count, not the server's.** The comment at
  `:268-269` acknowledges it ("the server recounts under its own lock"). If an exclusion raced, the
  owner is told a number the server did not use. The response carries `approvedCount`; using it
  would cost one line. Left low because the race needs a concurrent render landing between the
  view read and the click, and the panel refetches immediately after.

---

## What I checked and did not find

To be explicit about negative results, since an empty finding is only useful if the search was
real:

- No `job_outbox` write is involved in this lane, so invariant #2 is not in scope — confirmed by
  grep, not assumed.
- No new string literal for a subscription status, tier id, job name or review status.
- No new top-level directory; `_shared/` sits under an existing route folder, matching
  `api/_shared/channels/` precedent.
- No file crossed 1000 lines. Largest production file touched is `batch-view.ts` at 667.
- The exclusion path does write inside the same transaction as the approval (CONTEXT.md **Ask
  exclusion**) — verified, and F1 is about ordering *within* that transaction, not about a second
  transaction.
- `haltBatch` genuinely never cancels `sending` rows (`approval.ts:375`), and the halt reason is
  genuinely never accepted from the request — the route passes exactly four keys
  (`halt/route.ts:32-37`) and the body reader reads only `batchId`.
- The `reviewed` route really does keep the watch-only gate through the shared runner
  (`reviewed/route.ts:35`), which is the regression D9 flagged as the hazard.
