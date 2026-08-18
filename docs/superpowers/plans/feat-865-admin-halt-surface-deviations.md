# feat-865-admin-halt-surface — deviations

Entries the plan did not anticipate. Each gets a one-line ACCEPT / RE-PLAN
verdict at step 6 (deviations read-back) before any review agent sees this file.

---

## D1 — Surface overlap with `feat-860-ask-regeneration-surface` (step 2, owner-agreed)

`scripts/feature-setup.sh` reported two code-pair overlaps with the armed
worktree `feat-860-ask-regeneration-surface`:

- `src/lib/solicitation/approval.ts` — theirs `src/lib/solicitation/*`
- `src/lib/solicitation/batch-view.ts` — theirs `src/lib/solicitation/*`

(plus one test-glob overlap, not itemised by the script).

**What #860 actually changes in those two files**, read from its branch diff
against the shared base `f28451ee`:

| File | #860's change | Touches anything #865 needs? |
|---|---|---|
| `approval.ts` (+208) | file header comment, one added import, then a **pure append** of `RequestAskRegenerationInput` / `RequestAskRegenerationResult` / `requestAskRegeneration` after `haltBatch` | **No.** `haltBatch`, `lockBatchForAction`, `canonicalBatchId`, `ownerHaltReason` and `OwnerHaltReason` are all unmodified. |
| `batch-view.ts` (+105) | extends `SendLaneView` with regeneration fields, modifies `readSendLane` | **No.** `readLatestBatch`'s signature, `HaltReason` and `BatchView` are unmodified. |

So the collision is **mechanical, not semantic**: a shared file-header comment
and a shared append point at the end of each file.

**State of the two branches at the time of the decision.** #860 is
`phase: gate_green`, `branchReviewRounds: 1` with its triage verdicts committed,
10 commits, based on `f28451ee`. #865 was at zero commits on the same base.

**Agreed merge order (owner decision, step 2): #860 merges FIRST; #865
implements in parallel and rebases onto `main` before opening its PR.**

Rejected alternatives, and why:

- *Serialise completely (hold #865 until #860 lands).* Zero conflict risk, but
  idles this run behind another branch's merge and CI cycle to avoid two
  mechanical conflicts.
- *Narrow #865's surface by dropping `batch-view.ts`.* Would push the admin
  batch projection into a new `src/lib/admin/` module, against "default is no
  new file" — the projection belongs in the send-lane read model that already
  owns `BatchView`, `SendLaneView` and `HaltReason`.

**Obligation this creates for #865:** rebase onto `main` after #860 lands, then
re-run the full verify gate (`scripts/verify-gate.sh --review`) on the rebased
tree before review round 1 is treated as valid. A rebase that only resolves the
two mechanical conflicts still changes the tree the reviewers read.

The counterpart note is recorded as **sibling-worktree evidence**, not as a file
in this tree (round-1 finding 13). Absolute path:

```
/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface/docs/superpowers/plans/feat-860-ask-regeneration-surface-deviations.md
```

§ "Surface overlap with feat-865". It is unresolvable from THIS review root by
construction — it lives on the other branch — so a reviewer working only in this
worktree cannot follow it. Once #860 merges, the citation becomes moot.

> **Correction (round 3).** Revision 2 of this entry said the note was left
> **uncommitted** in the sibling worktree to protect that branch's
> `lastGreenGateSha == headSha` record. That was true when written and is now
> **false**: #860's own session folded it in at `db89a700` ("docs(860):
> directory rows follow the LaneRefresh fix; fold in feat-865 overlap note"),
> which is exactly what the note asked its owner to do. That branch is now at
> `156b3457`, still `phase: gate_green` with `lastGreenGateSha == headSha`, so
> the concern the original wording expressed never materialised. Verified by
> reading the sibling worktree's git state directly, not taken on the reviewer's
> word.

**Verdict:** _(pending step 6 read-back)_

---

## D2 — intake revised after plan review round 1 (NOT a surface amendment)

`docs/reviews/feat-865-admin-halt-surface/plan-round1-codex.md` returned
`VERDICT: REVISE` with 14 findings; 12 accepted, 2 rejected (reasoning in the
plan's §6). The intake changed in three ways. **Both copies were rewritten and
verified byte-identical**, and `scripts/arm-check.sh` re-confirmed ARMED.

| Field | Before | After |
|---|---|---|
| `tests_to_add` | 16 titles | **30 titles** |
| `estimated_prod_lines` | 380 | **420** |
| `estimated_test_lines` | 700 | **1400** |
| `non_goals` | 8 | 9 (added the `haltBatch` pending-hole carve-out) |
| `invariants` | 11 | 12 (added the `built_at IS NULL` never-latched rule) |
| `edge_cases` | 11 | 15 |
| `user_visible_behavior` | 7 | 7 (two sharpened) |
| `existing_patterns_to_follow` | 7 | 9 |
| **`allowed_edit_surface`** | **9 globs** | **9 globs — UNCHANGED** |

**This spends NO amendment.** `/feature`'s abort criteria count
`allowed_edit_surface` amendments only; `tests_to_add` retitles and other
intake-field corrections are deviations-file entries by design (the #643
lesson — that run nearly hit teardown over two test renames). The surface is
byte-for-byte what step 2 armed, so the amendment budget is still **0 of 2**.

The test-line estimate tripled because round 1 established that the original
eval could pass while the feature was materially wrong: it had no test for a
second spine step, for settlement ownership, for audit ordering or rollback, for
type/export widening, for the browser-serialization rule, or for a functioning
UI. Estimating tests at 1:1 with production is precisely the failure the
separate-bucket estimate exists to catch, so the estimate was raised to the
honest number rather than left to trip step 5's `reclassify` row.

**Two findings were rejected rather than absorbed** — a standing meta-test for
`.todo` markers, and a flag-availability test aimed at a module that never reads
the flag (reframed onto the route). Both rejections are recorded in the plan's
§6 with reasoning, per `receiving-code-review`.

> **Correction (round 2).** The meta-test rejection originally leaned on
> `diff-coverage` as the mechanical backstop. **That support was false for a
> test-only commit**: `scripts/diff-coverage.ts:62-65` excludes
> `__tests__|\.test\.`, and `104-106` exits PASS when no production line
> changed. Verified directly, not taken on the reviewer's word. The rejection
> stands on its own reasoning — a permanent test about test syntax rots — but
> the plan now requires explicit **30 passed / 0 skipped / 0 todo** evidence at
> the final gate instead of an imagined automatic one. Lesson worth promoting at
> step 8: *diff-coverage gates the branch's production lines, never the eval
> commit.*

**One finding produced a deliberate non-fix.** `haltBatch` carries the identical
`pending`-batch hole that D11 refuses for the admin arm. Fixing the owner arm
would change user-visible behaviour this intake does not name, so it is carved
out in `non_goals` and scheduled as a follow-up ticket at step 8. See the plan's
§7 — it must not die in this file.

**Verdict:** _(pending step 6 read-back)_

---

## D3 — Surface overlap with `feat-872-ask-withdrawal` (recorded from the #872 session, owner-agreed)

`feat-872-ask-withdrawal` (post-approval per-ask **Ask withdrawal**, issue
#872) armed on 2026-08-18 and its `scripts/feature-setup.sh` reported one
code-pair overlap with THIS worktree: `src/lib/solicitation/approval.ts`.

**What #872 changes there:** a pure APPEND of `withdrawAsk` (+ its
input/result types) after `requestAskRegeneration`, sharing
`lockBatchForAction` / `canonicalBatchId` unchanged. It does not edit
`haltBatch`, so this plan's `latchHalt` extraction is unaffected.

**Agreed merge order (owner decision): feat-865 lands FIRST; #872 rebases onto
it.** Nothing here has to wait for #872. Mirror entry: #872's deviations file,
D1.

**Verdict:** _(pending step 6 read-back)_

---

## D4 — Task 0 red run: 30 executable failures, no `.todo` and no `.skip`

Plan §4 Task 0 requires the red run to be recorded here before the task counts
as complete. Command (both vitest projects, the six eval files):

```
TEST_DATABASE_POOL_URL=… DATABASE_POOL_URL=… pnpm vitest run \
  src/lib/solicitation/__tests__/approval.integration.test.ts \
  src/lib/solicitation/__tests__/batch-view.integration.test.ts \
  src/lib/solicitation/__tests__/approval.test.ts \
  src/app/api/admin/solicitation/batch/__tests__/routes.test.ts \
  'src/app/admin/businesses/[id]/_components/__tests__/SolicitationBatchPanel.test.tsx' \
  'src/app/admin/businesses/[id]/__tests__/page-source.test.ts'
```

```
 Test Files  6 failed (6)
      Tests  30 failed | 35 passed (65)
```

The 35 passes are the pre-existing cases in the three files this task extended;
none of them regressed. `it.todo`, `it.skip`, `describe.skip`, empty bodies and
`expect(true).toBe(true)` are absent — verified by grepping the six files for
`\b(it|describe|test)\.(todo|skip)\b`, which returns nothing.

**Failure-reason distribution.** Every one of the 30 failed because a promised
symbol or module does not exist yet, or because an assertion read the current
value — never on a typo, a bad import path, a syntax error, or a fixture that
did not build:

| Reason | Count | Which |
|---|---|---|
| Missing export — `adminHaltBatch is not a function` | 14 | the 13 `adminHaltBatch …` integration titles + `haltBatch still derives …` |
| Missing export, via the property runner (`Property failed after 1 tests → Caused by: TypeError: adminHaltBatch is not a function`) | 1 | `invariants: halting is a fixed point …` |
| Missing export — `readAdminBatchSummary is not a function` | 3 | the 3 `readAdminBatchSummary …` titles |
| Missing module — `Cannot find module …/batch/halt/route` | 7 | the 7 `the admin halt route …` titles |
| Missing module — `Cannot find module …/_components/SolicitationBatchPanel` | 3 | the 3 `the admin halt panel …` titles |
| Wrong value — `page.tsx` does not contain `readAdminBatchSummary` | 1 | the page-source title |
| Wrong value — `approval.ts` has no `type LatchHaltReason` declaration | 1 | `type contract: …` |

Every fixture ran to completion before its failure — each stack points at the
`adminHaltBatch` / `readAdminBatchSummary` call line, not at a seed statement —
so the live-DB seeds satisfy 091's and 108's CHECKs as written.

`pnpm typecheck` reports **only** the same missing symbols (TS2307 / TS2339) in
these six files. `pnpm exec eslint` on all six is clean, and
`pnpm ci:live-db-suites` passes.

### Three things the plan did not anticipate

1. **A literal dynamic `import()` does NOT survive a missing module.** Plan §4
   Task 0 leans on the autonomy route suite's per-case `await import('../…')`
   to keep a not-yet-written module from taking the file down. That is true for
   a module that EXISTS; it is false for one that does not. Vite's
   `vite:import-analysis` resolves literal specifiers at **transform** time, so
   `Failed to resolve import` fails the whole file at collection and vitest
   reports `(0 test)` — which would have satisfied nothing, since the titles
   never run. Same hazard, different mechanism, for a static *named* import of
   a missing EXPORT: vite's ssr transform validates `importedNames`.

   Two idioms now carry this, both commented at their use site:
   - a module that does not exist yet is loaded through a **variable**
     specifier with `/* @vite-ignore */`, and typed from
     `typeof import('…')` in a **type** position (erased before transform).
     Used by the route suite (`loadRoute`) and the panel suite (`loadPanel`).
   - an export that does not exist yet is reached through a **namespace**
     import (`import * as approvalModule from '../approval'`). Used by both
     integration suites, so the ~35 pre-existing cases in those files keep
     running.

   Consequence for Tasks 1–3: once the symbols land, both idioms typecheck
   normally and need no rewrite. Do not "tidy" them back into literal imports —
   the comments say why.

2. **`writeAccountAuditLog`'s failure is injected as a JS rejection, not as a
   Postgres error.** `helpers/abort-injection.ts` insists a forced abort
   originate in Postgres, and that is right for its own callers — a JS throw
   does not put a transaction into aborted state. The claim here is different:
   that postgres.js **rolls back when the `sql.begin` callback rejects**. A
   real Postgres injection was considered and rejected as unavailable without
   DDL: the obvious lever, a bogus `actorUserId`, violates `halted_by`'s FK at
   the CAS instead of at the audit INSERT, so it would test the wrong statement.
   The delegating spy over `@/lib/audit/log` is the honest instrument, and the
   title names that function.

3. **The transaction-interposition helper needed its own proof.** Because every
   admin case fails before reaching it, `instrumentedExecutor` was exercised
   separately against the live test database (a throwaway script, not
   committed) and confirmed on all four properties it is relied on for: base vs
   transaction receivers are distinguished, `tx.json()` survives the `get`
   trap, `begin(options, cb)` forwards its leading argument, and a rejecting
   callback still propagates. Recorded here so the first green run in Task 1 is
   not the first time it is known to work.

**Verdict:** _(pending step 6 read-back)_

---

## D5 — Task 2: writing the route turned the eval file into a TYPECHECK failure

Plan §3.3 says "follows `api/admin/autonomy/unsuspend/route.ts` exactly", and
that route's export is the house shape shared by all 33 admin routes:

```ts
export const POST = withSameOrigin()(handler);
```

`withSameOrigin`'s wrapper type widens every handler's return to
`Promise<Response>` (`src/lib/auth/route-helpers.ts:13-16`), because it is
shared with routes that return a bare `Response`. The eval's route suite
annotates its `Promise.all` map callbacks as
`(response: NextResponse) => response.status` (routes.test.ts:167,184). `map`'s
`callbackfn` is a **function-type** parameter, so `strictFunctionTypes` checks
it contravariantly and `Response` is not assignable to `NextResponse` — two
fresh **TS2345** errors.

They did not exist during the Task 0 red run (D4 records typecheck as reporting
"only the same missing symbols"), because `typeof import('../halt/route')` on a
module that does not exist degrades to `any`. **Writing the module is what
surfaced them.** Nothing in the plan anticipated this: §3.3 pins the export
shape and Task 0 pins the annotation, and the two only become compatible once
the module is real.

Resolution — **the annotation was the defect, not the export**.

Task 2 resolved this inside production code, asserting
`withSameOrigin()(halt) as typeof halt` at the export. The orchestrator
reverted that at the Task 2 verification step. Two of its premises were wrong:

- *"Editing the test is out of surface."* It is not. The suite lives at
  `src/app/api/admin/solicitation/batch/__tests__/routes.test.ts`, inside the
  `src/app/api/admin/solicitation/**` glob. It was out of **task** scope,
  because Task 2's brief forbade touching test files — a different constraint,
  and one the orchestrator may lift.
- *"The annotation is the eval author's stated intent."* It is not. The eval
  asserts `.toEqual([400, 400, 400])` over `response.status`, and `status`
  exists on a plain `Response`. The `NextResponse` annotation carries no
  assertion; deleting it weakens nothing and the suite still fails if the route
  is wrong.

So the annotation went, not the export shape:

```diff
-expect(responses.map((response: NextResponse) => response.status)).toEqual(…)
+expect(responses.map((response) => response.status)).toEqual(…)
```

`routes.test.ts:167,184` plus the now-unused `type NextResponse` import. The
route keeps the canonical house export with no assertion:

```ts
export const POST = withSameOrigin()(halt);
```

**Why this way round.** The `as` was truthful — both arms really are
`NextResponse` — but it was the only `as typeof` on any route export in the
repo, and it sat on a CSRF wrapper, which is the worst place to teach a reader
that an export's type is asserted rather than inferred. It would also have gone
on lying if a later branch ever returned a bare `Response`. A production
workaround for a redundant test annotation is the tail wagging the dog.

Verified after the revert: route suite **7/7**, `eslint` clean on both files,
and `pnpm typecheck` reports **only** Task 3's not-yet-written symbols
(`readAdminBatchSummary`, `SolicitationBatchPanel`) — no TS2345.

**Follow-up, unchanged and still worth taking:** `withSameOrigin` could be made
return-type-preserving with one generic parameter, which would make the widening
impossible to hit again. That touches every wrapped route, so it stays its own
ticket. File it at step 8.

**Verdict:** _(pending step 6 read-back)_

---

## D6 — Task 3: the eval green-run, and a **D5 repeat** that leaves 4 typecheck errors in two test files

### The green run (plan §6's required final-gate evidence)

All six eval files, both vitest projects, live DB awake:

```
TEST_DATABASE_POOL_URL=… DATABASE_POOL_URL=… pnpm vitest run \
  src/lib/solicitation/__tests__/approval.test.ts \
  src/lib/solicitation/__tests__/approval.integration.test.ts \
  src/lib/solicitation/__tests__/batch-view.integration.test.ts \
  src/app/api/admin/solicitation/batch/__tests__/routes.test.ts \
  'src/app/admin/businesses/[id]/_components/__tests__/SolicitationBatchPanel.test.tsx' \
  'src/app/admin/businesses/[id]/__tests__/page-source.test.ts'
```

```
 Test Files  6 passed (6)
      Tests  65 passed (65)
```

**65 passed, 0 failed, 0 skipped, 0 todo** — the exact inverse of D4's
`30 failed | 35 passed (65)`, so all 30 promised titles execute and pass and
none of the 35 pre-existing cases regressed. `pnpm lint` is clean repo-wide, and
`ci:tenant-scope` (381/381, no baseline bump), `ci:db-imports`,
`ci:static-policy`, `ci:directory-map` and `ci:live-db-suites` all pass.

### The blocker: writing the panel turned two test files into typecheck failures

**This is D5's mechanism, second occurrence — and D5's resolution is the one
that applies.** A `typeof import('…')` of a module that does not exist degrades
to `any`, so the panel suite's props were unchecked for the whole of Tasks 0–2.
Writing `SolicitationBatchPanel.tsx` is what made them real:

| Error | Where | Cause |
|---|---|---|
| TS2740 ×2, TS2322 ×1 | `_components/__tests__/SolicitationBatchPanel.test.tsx:78,126,144` | the fixture helper is annotated `summary(overrides: Record<string, unknown> = {}): Record<string, unknown>`, and `Record<string, unknown>` is not assignable to `AdminBatchSummary` — `unknown` does not narrow to `string`. |
| TS2741 ×1 | `__tests__/BusinessDetailClient.test.tsx:112` | `renderClient` predates the new required `initialBatchSummary` prop. |

The eval author's own comment says the fixture is "**the `AdminBatchSummary`
shape** from plan §3.2, as the panel receives it", so `Record<string, unknown>`
was Task-0 scaffolding for a type that did not exist yet — exactly as
`typeof import(…)` was scaffolding for a module that did not exist yet. D4
predicted "once the symbols land, both idioms typecheck normally"; that is true
of the idioms and false of the fixture annotations beside them.

**Nothing was worked around in production**, per D5's ruling that "a production
workaround for a redundant test annotation is the tail wagging the dog". Three
widenings were considered and rejected:

- `summary: Record<string, unknown> | null` on the panel with a runtime parse —
  would be the only parse-the-props component in the admin UI, and would put
  `unknown` on a seam the server already types.
- `summary: AdminBatchSummary | Record<string, unknown> | null` — same runtime
  narrowing, plus a union no caller can discriminate.
- `initialBatchSummary?:` optional on `BusinessDetailClient` — cheaper, but it
  makes "prop not supplied" render as "no send batch on file", which is a
  different fact. `initialChannels` next to it is required for the same reason.

**Recommended fix — 4 lines, all in test files, and out of Task 3's scope by
the same distinction D5 drew** (in `allowed_edit_surface`, forbidden by the
task brief; the orchestrator may lift it):

```diff
- function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
+ function summary(overrides: Partial<AdminBatchSummary> = {}): AdminBatchSummary {
```
plus `import type { AdminBatchSummary } from '@/lib/solicitation/batch-view';`
(this is the house fixture shape — `ZernioConnectionPanel.test.tsx:10` is
`panelData(overrides: Partial<ZernioPanelData> = {}): ZernioPanelData`), the
matching `Array<AdminBatchSummary | null>` on `nonActionable`, and
`initialBatchSummary={null}` in `BusinessDetailClient.test.tsx`'s
`renderClient`. No assertion strength is lost: every case still asserts the same
values, and the fixtures already carry all nine fields.

Until that lands, `pnpm typecheck` and `pnpm build` report those four errors and
nothing else — no production file has an error, and `next build` compiles
successfully before the type pass.

**RESOLVED by the orchestrator**, which lifted the test-edit constraint — Task 3
was right to escalate rather than reach for a production workaround, which is
D5's lesson applied correctly one task later.

Applied, and slightly smaller than recommended:

- `summary(overrides: Partial<AdminBatchSummary> = {}): AdminBatchSummary`, with
  a type-only `import type { AdminBatchSummary } from '@/lib/solicitation/batch-view'`.
  A type-only import is erased before transform, so it does not hand
  `vite:import-analysis` a specifier and the D4 idiom is untouched.
- `initialBatchSummary={null}` in `BusinessDetailClient.test.tsx`'s
  `renderClient`.

The recommended `Array<AdminBatchSummary | null>` annotation on `nonActionable`
turned out to be **unnecessary**: once `summary()` returns `AdminBatchSummary`,
the array literal infers `(AdminBatchSummary | null)[]` on its own. Three lines,
not four. No assertion strength lost — every case asserts the same values, and
binding the fixture to the real type makes it strictly stronger: a field renamed
on `AdminBatchSummary` now fails in this file instead of rendering an `undefined`
into the panel.

Verified: `pnpm typecheck` clean repo-wide (zero errors), and both suites pass
(12/12).

**Lesson worth promoting at step 8:** an eval that stubs a not-yet-written
module must stub its **fixture types** too, or the type errors it defers land on
whichever task writes the module. Twice on this branch (D5, D6) — and the two
resolutions differ in the right way: D5's annotation asserted nothing and was
deleted, D6's fixture type asserts something real and was bound to the true
type. "Delete the annotation" is not the general rule; "make the test say what
it means" is.

**Verdict:** _(pending step 6 read-back)_
