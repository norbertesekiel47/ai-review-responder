# feat-865 — Admin/support halt surface

Issue: [#865](https://github.com/RepWorth/ai-review-responder/issues/865)
Intake contract: `docs/superpowers/plans/feat-865-admin-halt-surface-intake.json`
Deviations: `docs/superpowers/plans/feat-865-admin-halt-surface-deviations.md`
Review reports: `docs/reviews/feat-865-admin-halt-surface/`

RISK = high · SURFACE = mixed · `db_touching: true` · no migration.

Glossary terms used verbatim from `CONTEXT.md`: **Halt latch**, **Batch state**,
**Send batch parent**, **Settled batch**, **Outreach row**, **Ask**, **Lazy
child**. (Round 1 finding 10: it is **Outreach row**, not "Outreach", and
**Halt latch**, not "Halt-latch".)

**Revision 2** — incorporates plan review round 1 (codex, adversarial). Findings
table and triage: `docs/reviews/feat-865-admin-halt-surface/plan-round1-codex.md`
and §6 below.

---

## 1. The problem in one paragraph

`admin_halt` is a live CHECK member with no writer. Migration 091 permits it in
`solicitation_batches_halt_consistency` and 108 re-spells it in
`solicitation_outreach_status_reason_consistency`. The read side already ships:
`ApprovalPanel.tsx` types `HALT_BODY` as a total `Record<HaltReason, string>`
and renders *"RepWorth support stopped this batch. It cannot be resumed — get in
touch if that was not expected."* **The product already tells owners this can
happen to them, and it cannot.** This is a shipped sentence that is not yet
true, not a missing feature.

## 2. Locked decisions

Settled during step 1 grilling with the owner, plus D11 from plan review round 1.
Do not re-litigate; a decision that looks wrong now is a question for the owner,
not a task-level improvisation.

| # | Decision | Why |
|---|---|---|
| **D1** | `halted_by` holds the acting admin's `users.id`. | The column is `UUID REFERENCES users(id)` (091:107) — the **global** users table, not tenant-scoped. `halt_reason='admin_halt'` is the discriminator for actor class; you never infer it from `halted_by`. Precedent: `unsuspendAccountAutonomy` already writes an admin id as the actor on a customer account. No migration, no second column. |
| **D2** | The route takes `accountId` + `businessId` + `batchId`, all from the **body**. | Matches the admin-actor precedent in `src/app/api/_shared/channels/resolve-actor.ts` — `resolveAdminActor` reads `businessId` from the BODY while `resolveOwnerActor` reads `locationId` from the SESSION. Every query stays tenant-scoped, so `ci:tenant-scope` needs no allowlist entry and no `ALLOWLIST_BASELINE` bump. A mismatched triple is the uniform 404. Free, because the panel is business-scoped and already holds both ids. **`ci:admin-aal2` does not prove body sourcing** — it enforces reachable AAL2 gates and page parity only (round 1 finding 11). |
| **D3** | Canonicalise the batch id at the **public entry point**, before the batch row is locked. | Post-#859 `lockBatchForAction` casts to `::uuid` and correlates the parent through `b.id::text`, so it is already casing-independent on its own. The rule that still matters is the boundary one: `approveBatch` / `haltBatch` / `adminHaltBatch` canonicalise before locking so every later TEXT-key consumer — including the `closeBatchIfSettled` argument — receives the canonical id. Reuse the existing `canonicalBatchId`. #858 (PR #868) additionally made `closeBatchIfSettled` normalise its own input; that is belt and braces, not a replacement for the boundary rule. |
| **D4** | The surface is a panel on `/admin/businesses/[id]`. | Matches how support actually works ("this customer called"). No cross-account query. `accountId` and `businessId` are already in scope on that page. Rejected: a dedicated `/admin/solicitation` list page — the literal `autonomy` precedent, but it needs a new cross-account read and roughly doubles the UI work. |
| **D5** | The admin arm is **not** gated on `SOLICITATION_SEND_ENABLED`. | Support must be able to stop a stranded batch *after* the lane flag is turned off. The flag is a lane switch, not an authorization. The owner arm keeps its `requireSolicitationSendWriteAccess` gate unchanged. Pinned by a **route**-level test — the domain module never reads the flag, so asserting this in the module would be vacuous (round 1, rejected missing-test 18). |
| **D6** | Audit `event_type` is `solicitation_batch_admin_halted`. | Follows the `<domain>_<verb-past>` convention (`solicitation_do_not_contact_cleared`, `autonomy_unsuspended`). Explicitly admin-scoped so a future owner-arm audit row cannot collide. |
| **D7** | The audit write happens **inside** `adminHaltBatch`, not in the route. | The domain module owns the transaction (`sql.begin`), and CLAUDE.md's "Audit writes" rule requires the same transaction. The route cannot satisfy that from outside. Precedent: `unsuspendAccountAutonomy`. |
| **D8** | No `ip` / `userAgent` / `requestId` on the audit row. | `writeAccountAuditLog` accepts them, but threading request plumbing into a domain module to reach them widens the module's interface for a field the sibling admin precedent also omits. Parity with `unsuspendAccountAutonomy`. |
| **D9** | The admin read projection lives in `batch-view.ts` and never carries outreach subjects or bodies. | `batch-view.ts` already owns `BatchView`, `SendLaneView`, `HaltReason` and `BatchState` presentation. A new `src/lib/admin/` service would be a second owner of the same vocabulary. Reusing `readLatestBatch` wholesale is **rejected** — its `attempts: AskAttemptView[]` would serialize customer message bodies into an admin browser. |
| **D10** | The admin action requires a free-text `note`. | An operator acting on a customer's account says why. Goes in the audit payload only — never into `halt_reason`, which is fixed by route identity (ticket constraint 2). Precedent: `unsuspendAccountAutonomy`'s required note. |
| **D11** | A `pending` batch (`built_at IS NULL`) is **not haltable** by the admin arm. | **Round 1 finding 2, confirmed against the schema.** 091:176 is `(halted_at IS NULL OR built_at IS NULL OR halted_at >= built_at)`. Halting a pending batch passes the CHECK at halt time via the `built_at IS NULL` arm — and then `batch-builder.ts:782-786` stamps `built_at = NOW()` with only an `AND built_at IS NULL` guard, producing `halted_at < built_at` and a CHECK violation that throws inside the builder. Refusing `pending` is strictly simpler than widening the builder's lifecycle contract. **`haltBatch` has the identical hole and is deliberately NOT fixed here** — see §7. |

## 3. Design — modules and seams

Applied `codebase-design`. No new seam is introduced; every change is an
existing module getting deeper or an existing seam getting another adapter.

### 3.1 `src/lib/solicitation/approval.ts` — deepen

Its stated identity is "transactional writers with an actor; the only writers a
human triggers". A RepWorth operator is a human actor, so the admin arm belongs
here. **Amend the file header comment** — the current text says this module
"cannot spell" `admin_halt`, and that stops being true.

**Internal seam** (private, not exported — this is the "extract the shared latch
write" the ticket asks for):

```ts
/** The writable Halt latch reasons. NOT exported: `OwnerHaltReason` stays the
 *  2-member public write union, and the admin arm's reason is a constant. */
type LatchHaltReason = OwnerHaltReason | 'admin_halt';

type LatchHaltOutcome =
  | { latched: false }
  | { latched: true; cancelledCount: number; close: CloseBatchIfSettledResult };

async function latchHalt(
  tx: TransactionSql,
  input: {
    batchId: string;            // ALREADY canonical
    accountId: string;
    businessId: string;
    actorUserId: string;
    reason: LatchHaltReason;
    state: BatchState;          // read under the lock by the caller
    sendParentRunId: string | null;
    /** Non-null only for the admin arm (D7). */
    audit: { eventType: string; payload: Record<string, unknown> } | null;
  },
): Promise<LatchHaltOutcome>;
```

`latchHalt` owns, **in this order**, the properties the ticket says are easy to
lose in a second writer:

1. **CAS** `SET halted_at = NOW(), halt_reason, halted_by WHERE … AND halted_at IS NULL`
   → monotone. No row returned ⇒ `{ latched: false }`, and nothing below runs.
   This is what makes the second halt add no audit row and no spine step.
2. **Cancel** `delivery_status IN ('rendered','queued')` only — **never
   `sending`**. `disposition_reason = reason`.
3. **Audit** (when `audit` is non-null): `writeAccountAuditLog(tx, …)` with
   `entityType: 'solicitation_batch'`, `entityId: batchId`,
   `locationId: businessId`, and the caller's payload merged with
   `{ halt_reason, state_at_halt, cancelled_count }`. Placed here because
   `cancelled_count` is only known after step 2, and **before** step 4 so the
   **run-spine call stays LAST** (lock order: advisory → batch row →
   `agent_runs`). It runs on `tx`, so a throw here rolls back steps 1–2.
4. **Spine step** `recordStep(batch_halted)` — skipped when
   `sendParentRunId === null` (a batch discarded before generation minted a
   **Send batch parent**).
5. **Join** `closeBatchIfSettled` — the latch **never** terminalizes the parent
   directly, and it is called even when step 4 was skipped.

`haltBatch` and `adminHaltBatch` become thin: lock, derive state, guard, call
`latchHalt`, map the outcome onto their own result union.

**Deletion test:** delete `adminHaltBatch` and all five steps reappear in the
route handler. It earns its keep.

**New export:**

```ts
export interface AdminHaltBatchInput {
  batchId: string;
  accountId: string;
  businessId: string;
  /** The acting admin's `users.id` (D1). */
  actorUserId: string;
  note: string;
}

export type AdminHaltBatchResult =
  | { status: 'halted'; cancelledCount: number; close: CloseBatchIfSettledResult }
  | { status: 'already_halted' }
  | { status: 'not_haltable'; state: BatchState }
  | { status: 'not_found' };
```

There is deliberately **no `reason` field on the result**. It is always
`admin_halt`; carrying it would invite a caller to believe it varies. This is
the shape difference from `HaltBatchResult`, which must report a derived reason.

**Guards, in order** (`adminHaltBatch`, after `lockBatchForAction`):

| Derived `state` | Result |
|---|---|
| `halted` | `already_halted` |
| `closed` | `not_haltable` |
| `pending` | `not_haltable` — **D11**, the 091:176 / builder collision |
| anything else (`built`, `expired`, `approved`, `veto_window`, `sending`) | proceed to `latchHalt` |

`haltBatch`'s guard list is unchanged (`halted`, `closed` only) — see §7.

### 3.2 `src/lib/solicitation/batch-view.ts` — deepen

One new export. Reads the latest batch for a location, admin projection only:

```ts
export interface AdminBatchSummary {
  batchId: string;
  batchState: BatchState;
  builtAt: string | null;
  approvedAt: string | null;
  haltedAt: string | null;
  haltReason: HaltReason | null;
  /** Outreach rows a stop WOULD cancel: `rendered` + `queued` only. */
  cancellableCount: number;
  /** In flight. A stop does NOT touch these — halt is "no further sends". */
  sendingCount: number;
  /** Already delivered; unreachable by any halt. */
  sentCount: number;
}

export async function readAdminBatchSummary(
  sql: Sql,
  accountId: string,
  businessId: string,
): Promise<AdminBatchSummary | null>;
```

Round 1 finding 8: the earlier single `liveOutreachCount` folded `sending` in
while being documented as "what a halt would stop", which is precisely the thing
the latch does **not** do. Three separate counts, so the UI cannot imply that a
stop recalls an in-flight send.

No subjects, no bodies, no `AskAttemptView` (D9). Timestamps as `::text` —
postgres.js truncates microseconds off `timestamptz`. Ordering follows
`readLatestBatch`: `ORDER BY created_at DESC, id DESC` (`created_at` is not
unique — 088:125,145). Both tenant predicates are top-level on every statement.

### 3.3 `src/app/api/admin/solicitation/batch/halt/route.ts` — new adapter

Follows `src/app/api/admin/autonomy/unsuspend/route.ts` exactly:
`requireAdminWithAal2` → `z.strictObject` body → domain call → `internalError`
on throw → `export const POST = withSameOrigin()(handler)`.

Body: `{ accountId: z.uuid(), businessId: z.uuid(), batchId: z.uuid(), note: z.string().trim().min(1).max(1_000) }`.

`strictObject` is what makes ticket constraint 2 mechanical, and the contract is
**400, not "ignored"** (round 1 finding 7): a body carrying `reason`,
`haltReason` or `halt_reason` is rejected with 400 and `adminHaltBatch` is never
called. "Ignoring" an unknown field would let a 200 response coexist with a
client that believes it chose the reason.

Wire projection follows the owner halt route's `toWire` discipline — no
`parentRunId`, no spine vocabulary, no raw counts beyond `cancelledCount`.

Status mapping: `halted`/`already_halted` → 200 · `not_haltable` → 409 ·
`not_found` → 404. All four mapped arms are pinned by a test.

`ci:admin-aal2` picks this up automatically (it globs
`src/app/api/admin/**/route.ts` and requires a `requireAdminWithAal2` **call**
reachable from each exported mutation handler). **No audit-script edit is
expected.** There is no sibling `src/app/admin/solicitation/**/page.tsx`, so the
P2 page-parity rule does not engage. Verify, do not assume — if the audit
reports anything, that is a finding, not a config to loosen.

### 3.4 The panel — new adapter

`src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx`, modelled
on `PastDueExtensionPanel.tsx` (186 lines, `useReducer`, form submit,
`onChanged` callback).

Renders the **Batch state**, the three counts from §3.2, and — only when the
batch is haltable — a note field and a stop control. There are **four**
non-actionable states, and the panel test asserts all four: `pending` (D11,
still building), `halted`, `closed`, and no batch at all. Copy must make the
`sending` distinction explicit:
a stop cancels the `cancellableCount` rows and does **not** recall the
`sendingCount` ones.

Copy uses the `CONTEXT.md` **Halt latch** carve-out: **"stop"** is the one
permitted owner-facing synonym; `pause`, `resume` and `cancel batch` stay banned
everywhere including copy. Code-level names stay on the term (`haltable`, not
`stoppable`).

Page wiring in `page.tsx`: one more **sequential** `await` after
`getBusinessChannelEnrollments`. **Do not introduce `Promise.all`** — that file
carries an explicit comment and a `react-doctor-disable-next-line` explaining
that parallelising these reads is the #773 pool fan-out. Pinned by a
source-assertion test, following `src/app/admin/autonomy/__tests__/page-source.test.ts`.

---

## 4. Tasks

Each task is a tracer bullet. Blocking edges are explicit. Every task stays
inside `allowed_edit_surface`.

### Task 0 — eval task (runs ALONE; enforcement spot check follows)

Author all **30** `tests_to_add` titles VERBATIM as **executable, failing**
tests.

> **`.todo` and `.skip` are PROHIBITED in this task** (round 1 finding 1). A
> title registered as `.todo` satisfies the gate's `promised-tests` row while
> executing zero assertions, so the eval would be green before any behaviour
> exists. Every test must run and fail for the right reason. Task 0 is not
> complete until the red run is recorded in the deviations file: the vitest
> summary line showing 30 failures, and for each, that it failed on a missing
> export or a wrong value — not on a typo or a bad import.

| Test file | Titles |
|---|---|
| `src/lib/solicitation/__tests__/approval.integration.test.ts` (exists) | the 13 `adminHaltBatch …` titles |
| `src/lib/solicitation/__tests__/batch-view.integration.test.ts` (exists) | the 3 `readAdminBatchSummary …` titles |
| `src/lib/solicitation/__tests__/approval.test.ts` (exists, already has a fast-check `invariants` block) | `haltBatch still derives …` · `type contract: …` · `invariants: halting is a fixed point …` |
| `src/app/api/admin/solicitation/batch/__tests__/routes.test.ts` (new) | the 7 `the admin halt route …` titles |
| `src/app/admin/businesses/[id]/_components/__tests__/SolicitationBatchPanel.test.tsx` (new) | the 3 `the admin halt panel …` titles |
| `src/app/admin/businesses/[id]/__tests__/page-source.test.ts` (new or existing) | `the business detail page reads the admin batch summary sequentially without Promise.all` |

Three tests need a technique, not just an assertion:

- **`… writes its audit row before recordStep and closeBatchIfSettled, on the
  same transaction`** — interpose on the transaction object and record call
  order plus the receiver identity. Observing that both rows exist is NOT
  sufficient: that passes when the audit runs on the base client, or after
  `recordStep` (the lock-order regression). Precedent for Proxy-based
  transaction interposition already exists in this repo's ingress tests.
- **`… rolls back the latch, the outreach cancellations and the audit row when
  writeAccountAuditLog fails`** — inject the failure, then assert `halted_at`,
  `halt_reason`, every outreach status AND the absence of any spine call.
- **`… delegates parent settlement to closeBatchIfSettled and never updates
  agent_runs directly`** — assert the seam receives the same `tx`, the canonical
  batch id and both tenant ids, and that no direct `agent_runs` UPDATE is
  issued. A final-parent-state assertion alone passes a direct terminalization.

The property test replaces the round-1 draft, which was self-contradictory —
its title claimed the admin arm "always writes … for every batch state" while
`halted` and `closed` correctly write nothing, and it could not prove either
type claim. The invariant now spent on `fast-check` is the one with a real state
space: over arbitrary multisets of outreach statuses, a first halt changes
exactly the `rendered` and `queued` members and nothing else, and a second halt
is a fixed point with audit and spine cardinality one. The two type claims move
to `type contract: …`, an exact bidirectional type-equality plus export-absence
assertion. House style for the `invariants` block:
`src/lib/reviews/__tests__/sentiment.test.ts:42-45`.

**Blocking edges:** none.

### Task 1 — the latch extraction and the admin arm

Deepen `approval.ts` per §3.1: extract `latchHalt`, rewrite `haltBatch` to use
it with **no behaviour change**, add `adminHaltBatch` with the D11 `pending`
guard. Amend the file header comment.

Turns green: the 13 integration titles + all 3 `approval.test.ts` titles.

**Blocking edges:** Task 0.
**Precedents:** `haltBatch` itself; `unsuspendAccountAutonomy` for the in-transaction audit write.

### Task 2 — the admin route

New route per §3.3, turning green the 7 `the admin halt route …` titles.

**Blocking edges:** Task 1.
**Precedents:** `api/admin/autonomy/unsuspend/route.ts`; `api/dashboard/solicitation/batch/halt/route.ts` for `toWire`.

### Task 3 — the read projection and the panel

`readAdminBatchSummary` per §3.2, the panel per §3.4, and the `page.tsx` +
`BusinessDetailClient.tsx` wiring.

Turns green: the 3 `readAdminBatchSummary …` titles, the 3 `the admin halt panel …`
titles, and the page-source title.

**Blocking edges:** Task 2 (the panel POSTs to that route's path and wire shape).
**Precedents:** `PastDueExtensionPanel.tsx`; `readLatestBatch` for the read shape;
`admin/autonomy/__tests__/page-source.test.ts` for the source assertion.

### Task 4 — docs sweep

- `CONTEXT.md` → **Halt latch**: the entry says `admin_halt` is one of five
  reasons. Amend to record that the admin writer now **exists** and name its
  surface. Keep the Avoid list and the one-word "stop" carve-out untouched.
- `docs/directory.md`: refresh the `src/lib/solicitation/` rows for
  `approval.ts` and `batch-view.ts`. `ci:directory-map` is CI-complete for
  `worker/` + `src/lib/` only, so the new `src/app/**` files need no row —
  confirm by running the audit, do not assume.

**Blocking edges:** Task 1 (for the `approval.ts` row wording). Otherwise
independent of Tasks 2–3 and may be dispatched in parallel with Task 3.

---

## 5. What would make this wrong

Read this list before reviewing the branch.

- A second halt writing a second `account_audit_log` row, **or a second
  `batch_halted` spine step**.
- An **Outreach row** in `sending` being cancelled, or UI copy implying a stop
  recalls one.
- `adminHaltBatch` terminalizing the **Send batch parent** itself instead of via
  `closeBatchIfSettled` — including the parentless case, where the spine step is
  skipped but the join must still run.
- `OwnerHaltReason` growing to 3 members, or `LatchHaltReason` being exported.
- Any request field reaching `halt_reason`, or an unknown-field body returning
  200 instead of 400.
- The audit write landing outside the latch transaction, or **after** the
  run-spine call (lock-order regression), or surviving a rolled-back latch.
- A `pending` batch being latched (D11) — the failure surfaces later, inside
  `batch-builder`, as a CHECK violation.
- The admin surface serializing an **Outreach row**'s subject or body to the
  browser.
- A `Promise.all` appearing in `src/app/admin/businesses/[id]/page.tsx`.
- The route reachable without an AAL2 step-up, by a non-admin role, or
  cross-origin.
- A panel that renders but is inert — no stop control on a haltable batch.

## 6. Review appendix

### Plan review round 1 — codex, adversarial, read-only — `VERDICT: REVISE`

Full report + codex thread id: `docs/reviews/feat-865-admin-halt-surface/plan-round1-codex.md`.
14 findings. **12 accepted, 2 rejected.**

Accepted and now folded in: 1 (partial — `.todo` ban, no meta-test), 2 (D11),
3, 4, 5, 6, 7, 8 (§3.2 count split), 9, 10 (glossary spelling), 11 (D2
citation), 12 (D3 restated), 13.

**Rejected, with reasoning:**

- **Finding 1's proposed meta-test** (`eval manifest contains 16 executable
  tests and no todo or skip markers`). The hazard is real; the instrument is
  wrong. A permanent test asserting the absence of syntax markers in one named
  file tests test syntax rather than the system, and rots the moment the file is
  split. It is replaced by three non-permanent controls: the Task 0 prohibition,
  the recorded red run, and the **green-run evidence** required below.

  > **Correction (round 2).** Revision 2 of this section claimed diff-coverage
  > "fails an all-`.todo` eval mechanically". That was **wrong for the Task 0
  > commit**: `scripts/diff-coverage.ts:62-65` excludes `__tests__|\.test\.`
  > from production source, and `104-106` exits PASS when no production lines
  > changed — so a test-only commit passes with "nothing to cover". What is
  > true is narrower: at `verify-gate.sh --review`, once Tasks 1–3 have added
  > production lines, an all-`.todo` eval leaves those lines uncovered and the
  > ≥80% changed-line threshold fails. The gate protects the *branch*, not the
  > eval commit. Do not restate the stronger claim.

  **Therefore Task 0 and the final gate each need explicit evidence**, recorded
  in the deviations file: a red run of 30 failures at Task 0, and at the final
  gate a run showing **30 passed, 0 skipped, 0 todo**. A count of "30 passing"
  that silently includes a skip is the failure this replaces the meta-test with.
- **Missing test 18** (`adminHaltBatch remains available when
  SOLICITATION_SEND_ENABLED is false`). `adminHaltBatch` never reads the flag,
  so asserting that a module ignores something it cannot see is vacuous. D5 is a
  claim about the **route**, and is pinned there instead: `the admin halt route
  has no SOLICITATION_SEND_ENABLED gate — it halts with the send lane flag off`.

Finding 14 (planned-new artifacts absent) needs no action pre-implementation,
but every named symbol must exist by branch review.

### Plan review round 2 — codex, verification-only — `VERDICT: REVISE`

Full report: `docs/reviews/feat-865-admin-halt-surface/plan-round2-codex.md`.
Same codex thread as round 1, so it verified its own findings.

**12 of 14 round-1 findings confirmed fully addressed** (4, 5, 6, 7, 8, 9, 10,
11, 12, 14 with no residual risk; 2 and 3 partially, resolved below). It
confirmed the 30 titles route 1:1 to files, both intake copies are byte-identical,
and the §3.1 five-step ordering genuinely holds the lock order and the rollback
claim. It also endorsed the route-level reframing of the rejected flag test.

Four defects **introduced by revision 2's own fixes**, all now corrected:

| Defect | Fix |
|---|---|
| The intake invariant claimed *all* unbuilt batches are never latched, contradicting the owner-arm non-goal. | Qualified **ADMIN ARM ONLY** in both intake copies. |
| D11 added a fourth non-actionable panel state (`pending`) that the panel test did not list. | Title now reads `… for a pending batch, a halted batch, a closed batch, or when there is no batch`; §3.4 states all four. |
| §6 and deviations D2 claimed diff-coverage mechanically rejects an all-`.todo` eval. **False for a test-only commit.** | Corrected above with the exact line evidence, and replaced with a required **30 passed / 0 skipped / 0 todo** green-run record. |
| Deviations D2 said `edge_cases` went 12 → 15; the real delta is 11 → 15. | Corrected in D2. |

Round-1 finding 13 (the sibling-worktree citation) was still open at round 2 and
is now qualified in deviations D1.

**Unrelated observation, filed not fixed** (round 2 appendix, pre-dates this
branch): `outreach.ts:309-315` documents that the send parent is resolved
*before* the settled predicate, but the implementation tallies and returns
`not_settled` at 350-359 before the parent lookup at 364-375. The comment and
the code disagree. Out of scope here — the code order is deliberate (#628 round
5 made a parentless batch closable by asking the domain table first); it is the
*comment* that is stale. Fold into the step-8 follow-up ticket alongside §7.

### Plan review round 3 — codex, final, verification-only — `VERDICT: REVISE`

Full report: `docs/reviews/feat-865-admin-halt-surface/plan-round3-codex.md`.
Scope was deliberately narrow: the four defects round 2 introduced, plus
round-1 finding 13.

**Four of five confirmed landed with no residual** — the admin-only invariant
qualification (both copies byte-identical), all four non-actionable panel
states, the corrected diff-coverage statement (codex explicitly judged the
`30 passed / 0 skipped / 0 todo` replacement *sufficient* to close round-1
finding 1), and the `11 → 15` count.

**The fifth was a factual error in this branch's own deviations D1**, now
corrected: revision 2 claimed the #860 counterpart note was left uncommitted to
protect that branch's green-gate record. True when written; false by round 3 —
#860's session committed it at `db89a700` and is now at `156b3457`, still
`gate_green` with `lastGreenGateSha == headSha`. Verified by reading the sibling
worktree's git state directly.

**No round 4 will run**, and this is not the round-3 escalation clause firing.
That clause exists for a *remaining disagreement* needing an owner's call. There
is none here: the sole residual was a stale prose citation, codex was right, the
correction is applied, and nothing about the design, the eval, or the 30 test
titles is contested. Rounds 1–3 moved this plan from "the eval can pass while
the feature is materially wrong" to a 30-test eval whose gaps codex could no
longer name.

## 7. Known defect deliberately left in place

`haltBatch` permits halting a `pending` batch, and that is the same 091:176 /
`batch-builder` collision D11 refuses for the admin arm. It is **not fixed
here**:

- The fix changes owner-visible behaviour that this intake's
  `user_visible_behavior` does not name — exactly the drift the intake contract
  exists to catch.
- It is reachable only if the owner surface offers a stop control on a batch
  that is still building, which is a separate question about the Requests panel.

**Action:** file a follow-up ticket at step 8, citing 091:176,
`batch-builder.ts:782-786`, and this plan's D11. Do not let it die in this file.
