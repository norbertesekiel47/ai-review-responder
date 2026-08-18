# feat-865-admin-halt-surface — branch review round 1, **Standards & maintainability**

Axis: repo coding standards (`.claude/CLAUDE.md` working rules + architecture
invariants), `codebase-design` deep-module discipline, a Fowler smell baseline,
and `CONTEXT.md` glossary compliance. Spec/contract compliance and approach-level
design belong to the two sibling agents and are **not** covered here.

Method: `/thermo-nuclear-code-quality-review` against `d89c112f..HEAD` in
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-865-admin-halt-surface`.
Read the deviations file, `CONTEXT.md` § **Halt latch**, plan §3, both named
precedents (`autonomy/unsuspend/route.ts`, `PastDueExtensionPanel.tsx`), and every
production file in the diff in full.

---

## 0. Mechanical baseline — all green, verified, not taken on trust

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean, repo-wide (zero errors) |
| `pnpm exec eslint` on all 6 changed production files | clean |
| `ci:static-policy` | PASS |
| `ci:directory-map` | PASS |
| `ci:db-imports` | PASS |
| `ci:tenant-scope` | PASS |
| `ci:live-db-suites` | PASS |
| `ci:outbox-seam` / `ci:outbox-status` | PASS |
| `ci:admin-aal2` | PASS (33 admin route files, 20 admin pages) — plan §3.3 asked for this to be *verified*, not assumed |

Invariants checked by hand and **satisfied**:

- **#1 (Vercel = UI only)** — the route makes one Postgres call and no LLM /
  external / long-running call. No banned runtime import; the panel's only
  cross-boundary import is `import type`.
- **#8 (auth scope app-enforced)** — `actorUserId` is stamped from
  `gate.admin.id`, never the body; every statement in `latchHalt` and
  `readAdminBatchSummary` carries both `account_id` and `business_id`.
- **#12 (entry points orchestrate)** — the route parses, calls one domain
  function, maps four arms. No error-handling branch approaches 30 lines.
- **#15 (explicit DB client)** — `readAdminBatchSummary(sql, …)` and
  `adminHaltBatch(sql, …)` take the client as a parameter and match
  `readLatestBatch`'s positional convention; the singleton is imported only in
  `page.tsx` and the route, both sanctioned composition roots.
- **Audit writes** — `writeAccountAuditLog` in the same transaction, never a raw
  `INSERT INTO account_audit_log`.
- **No `any`, no `@ts-`, no `eslint-disable`** anywhere in the new production
  code. The single cast (`as AdminHaltResponse` on `res.json()`) is the
  precedent's own shape.
- **`react-doctor-disable-next-line`** in `page.tsx` is the third instance of an
  existing, well-argued #773 suppression on that exact page — consistent, not new
  debt.

## 1. Glossary compliance (`CONTEXT.md` § **Halt latch**) — **clean**

Grepped every changed production file for `pause`, `resume`, `stoppable`,
`cancel batch`. Hits are **only**:

- `SolicitationBatchPanel.tsx:8,11,137` — comments that *quote the ban* in order
  to explain it.
- `approval.ts:561` — "There is no resume, and it is structural", inside
  `haltBatch`'s **pre-existing** docstring, unchanged by this branch, and using
  the same negated construction `CONTEXT.md` itself uses.

The new `adminHaltBatch` docstring deliberately writes "There is no **un-halt**"
rather than reusing "no resume" — the author noticed. Code-level names stay on
the term: the panel's member is `haltable`, the label map key is `admin_halt`,
the run-step key is `batch_halted`, the audit event is
`solicitation_batch_admin_halted`. Owner/operator-facing copy uses the one
carved-out word ("Stop this batch", "Batch stopped", "A stop cancels") and never
implies reversibility. The panel test enforces the Avoid list on rendered text,
not just identifiers.

**No glossary violation found.** This is the strongest part of the branch.

## 2. Deep-module discipline

### `latchHalt` — a real seam, not a shallow wrapper

Interface: 8 input fields, one 2-arm outcome union, private. Implementation:
a CAS, a bulk cancel, a conditional audit write, a conditional spine step, and
the settlement join — with an **ordering contract** (steps 3 and 4 must sit
between 2 and 5 for `cancelled_count` availability and for the batch→run lock
order) that is invisible from the outside. That is depth: the callers do not know
the order exists, and the alternative is two hand-maintained copies of the
ordering.

The plan's own deletion test — "delete `adminHaltBatch` and all five steps
reappear in the route handler" — holds, and is the right test. `adminHaltBatch`
earns its keep; deleting it would put a transaction, a lock, a guard ladder and
five ordered writes into a Next.js route handler, i.e. straight through
invariant #12.

The one Fowler-flavoured concern is `audit: {…} | null` — a nullable mode
parameter, the classic flag argument. I looked for a way to delete it and could
not find one that is honest: the owner arm genuinely writes no
`account_audit_log` row, the audit must land after step 2 (it needs
`cancelled_count`) and before step 4 (lock order), and hoisting it to the caller
would move it outside those two constraints. One documented nullable field is
the minimal seam here. **Accept.**

### The remaining duplication between the two arms

`haltBatch` and `adminHaltBatch` still share a near-identical prologue —
`canonicalBatchId` → `sql.begin` → `lockBatchForAction` → `not_found` →
`halted`/`closed` guards — and a near-identical epilogue. Roughly 12 of
`adminHaltBatch`'s ~35 body lines are copies. I considered folding the whole
`sql.begin` + lock + guard ladder into `latchHalt` and rejected it: it would
trade one nullable flag (`audit`) for two (`refusePending`, a reason-deriving
callback) and the two result unions genuinely differ in shape (`reason` present
vs. absent, by design per plan §3.1). The extraction stopped at the right place.
Noted, not flagged.

## 3. D8 — is the 925 lines earned, or is there bloat? **Earned. There is no bloat.**

The owner has been told 2.2x and specifically asked for an honest "the panel is
doing too much". After reading the file line by line, that finding is **not
available**. The measurement the deviations file used — raw line count against a
precedent's raw line count — is what makes the ratio look bad.

| File | total | comment | blank | **code** | precedent code |
|---|---|---|---|---|---|
| `halt/route.ts` | 143 | 56 | 10 | **77** | 56 (`autonomy/unsuspend`) |
| `SolicitationBatchPanel.tsx` | 321 | 40 | 26 | **255** | 169 (`PastDueExtensionPanel`) |

The route is **+21 code lines** over its precedent, and every one of them is
`AdminHaltWire` + `toWire`, which plan §3.3 explicitly required. The precedent
has *zero* comment lines; this route has 56, because it is carrying five
non-obvious decisions (body-sourced tenant triple, gate-sourced actor,
`strictObject` as the mechanical form of ticket constraint 2, no
`SOLICITATION_SEND_ENABLED` gate, export-site CSRF). Those comments are the
house style for this codebase — `approval.ts` and `directory.md` are written the
same way — and stripping them to hit an estimate would be the wrong trade.

The panel is **+86 code lines** over its precedent, and they decompose cleanly:
`HALT_REASON_LABELS` (7), `NON_ACTIONABLE_COPY` (5), the metadata `<dl>` (25),
three `CountTile` call sites (19), the `PanelShell` extraction (12), the
`CountTile` component (24), the consequence paragraph (7). Every one maps to an
enumerated requirement — four non-actionable states, five halt-reason labels, the
three-count distinction that plan-review round 1 finding 8 forced. There is no
dead code, no speculative generality, no duplicated branch, no one-off boolean
threaded through an existing flow. The two sub-components (`PanelShell`,
`CountTile`) are extractions the precedent did not need and this file did.

D8's own conclusion — "estimate production from the enumerated behaviours, not
from a precedent's size" — is the correct lesson and I would sign it. The
estimate was wrong; the code is not.

The one genuine duplication in the panel is **not this branch's**: the
`HaltState` / `HaltAction` / `reducer` triple is structurally identical to the
same triple in four other admin surfaces (`PastDueExtensionPanel`,
`ManualRankingSection`, `ImpersonationStartClient`, `CsvImportClient`) — same
seven action types, same `submitReset`/`validationError`/`submitStart`/
`submitError`/`submitSuccess`/`submitDone` vocabulary. #865 makes it the fifth
copy. Following the house pattern is what CLAUDE.md asks for and is the right
call inside this branch, but five copies of a 40-line reducer is now a real
`useAdminActionForm` extraction, and that is a ticket, not a review finding
against this PR.

## 4. D5 — the reverted `as typeof halt`

Judged independently rather than deferred. **The revert is correct and the entry
now records the right reasoning.** The export is the plain house shape
(`export const POST = withSameOrigin()(halt)`), identical to the 33 other admin
routes, and `pnpm typecheck` is clean without any assertion. The deleted test
annotation (`(response: NextResponse) => response.status`) asserted nothing —
`status` exists on `Response` — so nothing was weakened. Putting the repo's only
`as typeof` on a CSRF wrapper to satisfy a redundant test annotation would have
taught every future reader that the export's type is asserted rather than
inferred. The follow-up (`withSameOrigin` made return-type-preserving with one
generic) is the right permanent fix and correctly scoped out.

## 5. Findings

Severity key: **medium** = will mislead a reader or a user on a reachable path;
**low** = a named smell with a concrete remedy, no live defect.

### M1 — `NON_ACTIONABLE_COPY` is `Partial<Record<…>>` where the file's own idiom (15 lines above) is a total `Record`

`src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx:54`

```ts
const NON_ACTIONABLE_COPY: Partial<Record<AdminBatchSummary['batchState'], string>> = {
  pending: …, halted: …, closed: …,
};
```

Fifteen lines earlier, the same file writes `HALT_REASON_LABELS:
Record<HaltReason, string>` with a docstring that says exactly why: *"Exhaustive
over the read side's five reasons, so a reason added to `HaltReason` is a compile
error here rather than a blank cell."* The refusal map gets the opposite
treatment, and it is the one that gates a write.

`BATCH_STATES` has eight members; this map names three. The set of refused states
is a **hand-maintained mirror of `adminHaltBatch`'s guard ladder**
(`approval.ts:657-658`) with nothing tying the two together — classic shotgun
surgery. Concrete failure: #630 lands `send_window_elapsed` / `batch_expired`
writers and adds a state or a guard; nothing fails, and the panel keeps rendering
"Stop this batch" for a batch whose only possible response is a 409 (see M3 for
what the operator then reads).

Named standard: the repo's own stated idiom, cited in `docs/directory.md` for
`redemptionConfirmsSuppression` — *"a total `Record` over the outcome union so a
fifth outcome without an answer is a **`tsc` error**"*.

Remedy: `Record<BatchState, string | null>`, the five actionable states mapped to
`null`, `haltable = NON_ACTIONABLE_COPY[state] === null`. A new `BatchState`
becomes a compile error. Two-line change.

### M2 — the panel re-declares the route's closed status union as an open `string`

`src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx:113`

```ts
interface AdminHaltResponse {
  status?: string;      // ← the route emits AdminHaltBatchResult['status']
  cancelledCount?: number;
  error?: string;
}
```

The route is careful here — `AdminHaltWire.status` is typed
`AdminHaltBatchResult['status']` precisely so the wire contract stays closed
(`route.ts:74`). The consumer 300 lines away throws that away and then
discriminates on a bare string literal at line 179
(`json.status === 'already_halted'`).

Concrete failure: rename or add a status in `AdminHaltBatchResult` and the panel
falls into the `else` branch and tells the operator **"Batch stopped. 0 queued
message(s) cancelled."** for a call that did not stop anything. Nothing —
typecheck, lint, or the panel suite — catches it. Contrast the branch's own
handling of the same risk on the read side, where the fixture was deliberately
bound to `AdminBatchSummary` (D6) *"so a field renamed on the projection fails
HERE rather than rendering an undefined into the panel"*. The write side did not
get the same treatment.

Remedy: `status?: AdminHaltBatchResult['status']` with
`import type { AdminHaltBatchResult } from '@/lib/solicitation/approval'`. A
type-only import is erased before transform, is exempt from the invariant-#1
ESLint boundary, and `BusinessDetailClient.tsx` already does exactly this for
`AdminBatchSummary`.

### M3 — the 409 and 404 bodies carry no `error` key, so the panel renders the raw discriminators `not_haltable` / `not_found` as operator-facing copy

`src/app/api/admin/solicitation/batch/halt/route.ts:126-134` ·
`src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx:172`

The route returns `{ status: 'not_haltable', state }` for 409 and
`{ status: 'not_found' }` for 404 — no `error` field. The panel's error line is:

```ts
dispatch({ type: 'submitError', error: json.error ?? json.status ?? `HTTP ${res.status}` });
```

so both land in the red paragraph verbatim. The precedent route
(`autonomy/unsuspend/route.ts`) returns `{ error: 'not_suspended' }` on 409, which
is why the precedent panel's identical `json.error ?? …` line never surfaces a
discriminator.

Reachable, not theoretical: the summary is server-rendered once. Two operators on
the same business page, or one page left open while a batch settles — operator
clicks "Stop this batch", server derives `closed`, 409, and the panel prints
`not_haltable`. On that path `onHalted()` is not called either, so the panel keeps
its stale actionable state and a second click reproduces it.

This sits badly against a branch that otherwise spent real effort on copy
discipline (a total reason-label map, four bespoke non-actionable sentences, a
test asserting the Avoid list against rendered text) — and against
`CONTEXT.md`'s framing of `halt` as internal vocabulary. **No test covers any
error path of this panel**: the suite has three cases, all happy-path or
non-actionable render.

Remedy: give the two refusal arms an `error` string in the route (matching the
precedent), or map `status` → sentence in the panel. Either way add the 409 case
to the panel suite.

### L4 — `approval.ts:27` says "These three do" where the same header says "All four"

`src/lib/solicitation/approval.ts:27`

Line 7 (rewritten by this branch): *"`approveBatch`, `haltBatch`,
`adminHaltBatch` and `requestAskRegeneration`. **All four** are transactional
writers with an actor…"*. Line 27, twenty lines later and **also rewritten by
this branch** (`two` → `three`): *"…has no actor in any signature. **These
three** do, and they are the only writers a human triggers."*

The off-by-one was inherited (main said "two" against a list of three), but the
branch touched the sentence and re-introduced it rather than fixing it. In a file
whose header is load-bearing lock-order analysis, a header that contradicts
itself twenty lines apart is exactly the drift the repo's doc discipline exists
to prevent. One word.

### L5 — `lockBatchForAction`'s docstring still claims three owner-verb callers; there are now four, and one is not an owner verb

`src/lib/solicitation/approval.ts:113` (and the caller enumeration at 116-124)

*"This is the shared opening of all **three owner verbs**, and it stops exactly
where they diverge."* Callers are now `approveBatch` (223), `haltBatch` (571),
`adminHaltBatch` (651), `requestAskRegeneration` (795) — four, and
`adminHaltBatch` is by the branch's own framing a **RepWorth operator's** verb,
not an owner's. The paragraph that follows enumerates how each caller maps a
`null` return (`approveBatch` and `haltBatch` return `not_found`;
`requestAskRegeneration` must throw) and omits `adminHaltBatch` entirely, even
though it introduces a fourth answer to that exact question.

This is the one place a future reader goes to learn "who may call this and what
must they do with `null`", and the branch added a caller without adding a row.

### L6 — two switches on the same discriminant in a 50-line handler; `toWire`'s `default:` arm undercuts the guarantee its docstring claims

`src/app/api/admin/solicitation/batch/halt/route.ts:80-93` and `:126-134`

`toWire` switches on `result.status` (three arms + `default`), then `halt()`
switches on `result.status` again (four arms, exhaustive). A reader has to hold
both to answer "what does a `not_haltable` response look like". Fowler's
duplicated-switch smell, and the thermo-nuclear "repeated conditionals that
signal a missing model".

`toWire`'s docstring claims *"a field added to the domain union later cannot start
shipping by accident — it has to be named here first"*. For a new **field** that
holds; for a new **status** the `default:` arm silently ships `{ status }`. (The
second switch does still fail `tsc` in that case, so this is imprecision, not a
hole — which is why this is low and not medium.)

Remedy: one switch returning the response per arm. It deletes `toWire`,
`AdminHaltWire` and the `default:` (~25 lines), puts each arm's whitelisted
fields next to its status code where the whitelist is most legible, and makes
exhaustiveness structural rather than incidental.

### L7 — three near-identical correlated subqueries where the repo already has a one-scan shape

`src/lib/solicitation/batch-view.ts:912-936`

`cancellableCount`, `sendingCount` and `sentCount` are three eight-line scalar
subqueries over `solicitation_outreach`, differing only in the
`delivery_status` predicate — 24 lines of SQL, three index scans of the same
rows, and three places to keep the tenant predicates in sync.

The docstring's stated reason for scalar subqueries over joins — *"a join shape
multiplies one child relation by the other"* — is about joining two **different**
child relations and does not apply to aggregating one. A single
`LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE …) AS …, … FROM
solicitation_outreach o WHERE o.batch_id = b.id AND <both tenant predicates>) c
ON TRUE` is ~10 lines, one scan, one copy of the tenant predicates, and is
already the shape `contacts-repo.ts` uses (per `docs/directory.md`). #859's
query-block-aware `ci:tenant-scope` reads it fine — `contacts-repo.ts` passes
today.

Not a defect; the counts are correct and the volume is small. It is duplicated
code with a canonical in-house alternative.

---

## Appendix — below the 80% bar, or deliberately not raised

- **`if (!summary) return;` at `SolicitationBatchPanel.tsx:153`, self-described
  as unreachable.** I tested whether TypeScript's narrowing survives into the
  hoisted `async function handleSubmit` — it does not (TS 6.0.3, minimal repro:
  `error TS18047: 'summary' is possibly 'null'`). So the guard is load-bearing
  and the comment is accurate, not a rationalisation. A one-line hoist
  (`const batchId = summary.batchId;` above the handler) would delete it, but
  this is taste.
- **The panel mixes a read projection with a write control.** Both named
  precedents do the same and the two concerns are genuinely coupled (the counts
  are the argument for the stop). Not a finding.
- **`useAdminActionForm`.** The five-copy reducer duplication described in §3 is
  a real extraction, but it is pre-existing debt that #865 follows correctly. It
  belongs on a ticket, not in this review's table.
- **`AdminHaltRequest` duplicating the route's zod shape** (`panel:104`). Weaker
  than deriving it, but it is strictly better than the precedent, which inlines an
  untyped object literal. M2 covers the half of this that can actually mislead.
- **`page.tsx` sequential reads.** The third `react-doctor` suppression on the
  page. Consistent with the two above it, correctly reasoned against #773, and
  the comment explains why independence is the *reason* for the rule, not an
  exemption from it. Correct as written.
- **`ADMIN_HALT_EVENT_TYPE` hoisted to a named const** where every other
  `writeAccountAuditLog` call site in the repo inlines the literal. This is
  *better* than house style, not a deviation. No change wanted.
- **`withSameOrigin` return-type widening** (D5's follow-up). Real, cross-cutting,
  correctly scoped to its own ticket. Not this branch's problem.
- **`docs/currents.md` / `progresstracking.md` untouched.** Correct — the repo's
  own history shows those land in a post-merge sweep commit, not on the feature
  branch.

## Verdict on this axis

No structural regression. No file pushed past 1k lines (`approval.ts` 897,
`batch-view.ts` 987 — both close, worth watching, neither crossed). No spaghetti
growth: the branch *removed* a duplicated write body rather than adding a second
one. No architecture-boundary leak, no bespoke re-implementation of a canonical
helper, no unjustified cast or `any`, and no glossary violation.

Three medium findings, all in the same client component, all cheap: the panel is
the one place where the branch's otherwise-strict "make the type say what it
means" discipline lapsed — a partial map where the file's own idiom is total, an
open `string` where the route publishes a closed union, and a raw discriminator
reaching operator-facing copy on an untested path. Four low findings, two of them
one-word doc drift in the file the branch changed most.

---

# TRIAGE (orchestrator, step 7 round 1, 2026-08-18)

Verdicts are one line each. Fixes landed in `084ea8cb` (panel) and `b9fc9e03`
(domain/route/docs).

| # | Finding | Verdict |
|---|---|---|
| M1 | `NON_ACTIONABLE_COPY` is `Partial`, hand-mirrors the server guards | **ACCEPTED, fixed.** Now `Readonly<Record<BatchState, string \| null>>`, total over all 8 states, and `haltable` is derived from it — one source of truth, and a new state is a tsc error. |
| M2 | `AdminHaltResponse.status?: string` re-opens the closed union | **ACCEPTED, fixed.** Typed from `AdminHaltBatchResult['status']`; the success branch is an exhaustive switch with no `default`, so a fifth status fails typecheck instead of narrating a stop that did not happen. |
| M3 | 409/404 render raw discriminators as operator copy | **ACCEPTED, fixed — in the panel, not the route.** That is the deliberate house split: the owner-side `refusalCopy` maps discriminators to sentences in the component while the route stays an explicit whitelist (plan §3.3). 6 error-path cases added; the finding that *no test covered any error path* was the sharper half. |
| L4 | `approval.ts:27` header says "three" 20 lines after "four" | **ACCEPTED, fixed.** |
| L5 | `lockBatchForAction` docstring says "all three owner verbs" | **ACCEPTED, fixed.** Four callers now, and `adminHaltBatch` is not an owner verb. |
| L6 | Two switches on one discriminant; delete `toWire` | **REJECTED.** The explicit whitelist is plan §3.3's requirement — it is what keeps `parentRunId` and spine vocabulary off an admin browser's wire. Collapsing to one switch trades a structural guarantee for ~25 lines. The `default:` arm returning `{status}` fails safe. Both fix agents independently agreed on re-read. |
| L7 | Three correlated subqueries → one `LEFT JOIN LATERAL` | **REJECTED.** Shape preference on code this reviewer judged correct, on a per-location read behind an admin gate. `ci:tenant-scope` proves each subquery's tenant predicates independently today; the rewrite would re-open a question that is currently closed, for no measured win. |

**Not triaged as findings, recorded as accurate:** the mechanical baseline
(typecheck/eslint/8 audits), the glossary result, the `latchHalt` seam judgement,
and the D8 size verdict — which independently confirmed the owner's step-5 call
that the estimate was wrong rather than the code.

**Carried to step 8, not fixed here:** the `useReducer` + 7-action-type
boilerplate now duplicated across five admin surfaces. #865 correctly follows the
pattern rather than diverging; the ticket is `useAdminActionForm`.
