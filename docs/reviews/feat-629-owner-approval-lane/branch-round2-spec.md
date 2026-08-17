# Branch review round 2 — spec & correctness (#629 owner approval lane)

Reviewer: spec & correctness, **round 2 (verification only — no production file
was edited).** Scope is the six round-1 findings and nothing else; anything
noticed outside them is in the untriaged appendix at the bottom, deliberately
not in the findings table.

Fix commits reviewed: `b7299e2f` (writer) · `55e9744d` (read model) ·
`564129d1` (panel) · `bf3d76d0` (lock premise) · `351b8fb4` (load-failure copy).
Round-1 report: `docs/reviews/feat-629-owner-approval-lane/branch-round1-spec.md`.

Database: isolated `test_629` at migration 108, exported for every run
(`TEST_DATABASE_POOL_URL` / `DATABASE_POOL_URL`).

---

## Findings

**None.** All six round-1 findings are fixed; no new finding meets the ≥80%
confidence bar.

| severity | file:line | finding |
|---|---|---|
| — | — | — |

---

## Per-finding verdicts

| # | Round-1 finding | Verdict |
|---|---|---|
| 1 | HIGH — zero-send-ask batch approved then 500'd on the null-parent throw | **FIXED** |
| 2 | HIGH — panel never showed `subject`/`body` (`user_visible_behavior[0]`) | **FIXED** |
| 3 | MEDIUM — case-sensitive `subject_id` compare against an HTTP-supplied id | **FIXED** |
| 4 | MEDIUM — `edge_cases[8]`: all-withheld batch still offered an approve control | **FIXED** |
| 5 | MEDIUM — `laneMessage` unkeyed, uncleared, outranking `announcement` | **FIXED** |
| 6 | LOW–MEDIUM — `edge_cases[7]` halt reason contradicted the code | **FIXED** (contract amendment, D11 — code correctly unchanged) |

---

### 1 — HIGH, zero-send-ask batch. **FIXED.**

`src/lib/solicitation/approval.ts:231-234`

```ts
const sendParentRunId = batch.send_parent_run_id;
if (sendParentRunId === null) {
  return { status: 'not_approvable', state, reason: 'no_send_parent' };
}
```

**Unreachable now.** The old `throw new Error('approveBatch: batch … passed
readiness with no send parent run')` is gone. `sendParentRunId` is captured once
at `:231`, narrowed to `string` by the guard, and is what `recordStep` receives
at `:349` — so there is no second null-read to reintroduce a throw.

**The refusal precedes every write.** Statement order inside `sql.begin`:
`lockBatchForAction` (two SELECTs, `:115` and `:137`) → `deriveBatchState` guard
`:208` → **the `no_send_parent` refusal `:232`** → the readiness anti-join
`:254` (a SELECT) → the exclusion validation SELECT `:280` → the first mutation,
the exclusion UPDATE at `:294`. The refusal is three statements and one branch
ahead of anything that writes, and it is *before* readiness exactly as claimed —
which matters, because readiness passes vacuously over zero `status = 'send'`
asks and cannot catch this shape. Verified empirically:
`approval.integration.test.ts` — *"refuses a built batch that has no send work at
all"* — seeds a `withhold`-only batch, asserts
`{ status: 'not_approvable', state: 'built', reason: 'no_send_parent' }` and
asserts `snapshotBatch(batchId)` is byte-identical before and after.

**The route still maps it, and the switch is still exhaustive.**
`approve/route.ts:64-75` has five arms over
`ApproveBatchResult['status']`; `reason` rides the *same* `not_approvable`
discriminant as an optional field (`approval.ts:187`), so no arm was added and
none is missing. `pnpm typecheck` is clean, which is the enforcement: the
handler declares `Promise<NextResponse>` under `strictNullChecks`, so dropping
an arm would fail with "lacks ending return statement". `not_approvable` → 409
with the full result body, so `reason` reaches the wire.

**No new 500 was introduced in its place.** `:332` throws if the approval CAS
loses. That is provably unreachable: `deriveBatchState` (`outreach.ts:90-101`)
can only return `'built'` when `approved_at === null`, the row was read under
`FOR UPDATE OF b` at `:127`, and that lock is held to commit — so no concurrent
writer can stamp `approved_at` between the read and the CAS. The throw is a
loud-failure assertion protecting the validate-first/mutate-second contract, not
a live path.

**Panel side.** An all-withheld batch has no `rendered` rows, so `panelMode`
returns `nothing_to_send` and `actionVerb` returns `null` — the control the
owner used to click is gone. The 409 now answers only a direct POST or a stale
tab, which is what the code comment at `:230` claims.

### 2 — HIGH, the panel never showed the bytes. **FIXED, both halves.**

`src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:72-85` ·
`src/app/(authenticated)/dashboard/requests/AskList.tsx:56-62`, `:129-140`

**Half one — the required thing is present.** `toRows` now carries
`subject`/`body`; `AskRowView` gained both fields; `AskMessage` renders them
(`<p className="rq-ask-subject">` / `rq-ask-body`), with a distinct
"No message was written for this contact." for the both-null case so "nothing
was written" and "we hid it" cannot read alike. Both list forms render it —
`SelectableAskList` (mode `approvable`) and `AskList` (modes `haltable`,
`halted`, `nothing_to_send`) — so the copy is legible before approval *and*
after it. The CSS classes all exist in `requests.css`.

**Half two — the redacted arm still holds.** `toRows` `continue`s on
`attempt.redacted` **before reading any property**, so a `moderation_high`
attempt produces no row, hence no markup, no attribute, and no React key (a row
that is never constructed has no key). The narrowing is also type-enforced:
`AskRowView` has no redacted arm, and `attempt.subject` is only legal after the
guard, so a regression is a `tsc` error rather than a leak. Independently
grepped: `toRows` is still the ONLY place an `AskAttemptView` *value* is read
anywhere in `src/app` or `src/components` — `AskList.tsx:3` is a type-only
import used for the indexed accesses `AskAttemptView['deliveryStatus']`, and
`RequestsClient.tsx:216` is a prop pass-through.

**The test is the right shape, which is the part that failed last time.**
`approval-panel.test.tsx:183` renders two readable attempts plus
`leakyRedactedAttempt` — a fixture cast past the type so it *carries*
`FLAGGED-SUBJECT-must-never-render` / `FLAGGED-BODY-must-never-render` — then
asserts (a) both readable subjects and both readable bodies are in the DOM,
(b) neither flagged string appears anywhere in `document.body.innerHTML`,
(c) the redacted contact is not even named, (d) its `outreachId` is absent, and
(e) the count and reason chip *are* present. It proves the projection drops the
bytes rather than proving the type made the fixture impossible. A second case
(`:224`) repeats the pair on the settled read-only list.

### 3 — MEDIUM, non-canonical id into a `text` compare. **FIXED.**

`src/lib/solicitation/approval.ts:85-87`, `:195`, `:415`

`canonicalBatchId(input.batchId)` runs once at each verb's entry point, and the
canonical local `batchId` — not `input.batchId` — is what every statement below
uses, including the `closeBatchIfSettled` argument at `:364` and `:474` (whose
own parent lookup, `outreach.ts:368`, is the same `text` compare). The one
remaining `${input.batchId}` is inside `lockBatchForAction` (`:142`), which
receives the already-canonicalised value from both callers and says so in its
header contract (`:95-96`).

**Both verbs, verified against the live DB.** `approval.integration.test.ts` —
*"finds the send parent for an upper-cased batch id, for both verbs"* — seeds two
batches (only one approved, to avoid contending
`solicitation_batches_one_active_send_per_business`), calls each verb with
`.toUpperCase()`, and asserts the two things that actually broke: the
`batch_approved` and `batch_halted` **steps** each exist, and halt's close result
is `{ status: 'closed', disposition: 'halted', parentStatus: 'cancelled' }`
rather than `no_send_parent` — which is the `closeBatchIfSettled` half of the
same regression.

**No remaining path feeds a non-canonical id into a `subject_id` compare.** The
four HTTP entry points under `/api/dashboard/solicitation/batch`: `approve` and
`halt` canonicalise; `reviewed` → `markBatchReviewed` compares `id = ${batchId}`
against a `uuid` column (case-normalising, no `subject_id` at all); `GET` →
`readLatestBatch` sources its id from the database. Every other
`subject_id = ${…}` site (`ask-generation.ts:1423`/`:1621`,
`batch-builder.ts:296`, `outreach.ts:368`) is reached only with a DB-sourced id,
and `worker/jobs/solicitation-batch/failed-hook.ts:60` uses the correlated
`batch.id::text` form.

### 4 — MEDIUM, `edge_cases[8]` all-withheld batch. **FIXED, and it did not eat `edge_cases[0]`.**

`src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:118-135`, `:504-513`

`panelMode(lane, sendableRows)` returns `nothing_to_send` for a `built` + `ready`
lane with zero sendable rows, and `actionVerb` maps that to `null`. The panel
renders the honest "Nothing to send in this batch" heading and still lists the
held attempts with their reason-bearing status, so the batch is not pretended
away.

**The two rules are correctly kept apart.** `sendable` (`:504-507`) is derived
from `rows` filtered on `deliveryStatus === 'rendered'` and is **not** a function
of `excluded`; the exclusion set only feeds `sendCount` (`:513`), which is button
*copy*. So deselecting every ask leaves `sendable.length > 0`, the mode stays
`approvable`, and the control stays on screen reading "Approve and send 0
messages" — which is exactly what `edge_cases[0]` requires, since the server
then cancels every row `owner_excluded` and `closeBatchIfSettled` settles the
batch `exhausted`. Pinned by
`approval-panel.test.tsx:360` — *"keeps the approve control after the owner
deselects every ask"* — alongside `:285` and `:300` for the two
nothing-to-send shapes.

### 5 — MEDIUM, the lane announcement. **FIXED.**

`src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:55-64`, `:79`,
`:92-106`, `:131`

Three separate changes, all present:

1. **Scope-keyed.** `laneMessage: string` became
   `LaneSentence { scope, message, outcome }`, and `:79` reads
   `lane.scope === currentScope ? lane.message : ''` — the same key discipline
   the fetch loop already used for `phase`/`announcement`.
2. **Clearable.** `onRetry` (`:103`) resets it to `noLaneSentence(currentScope)`
   before delegating to `retry()`.
3. **`announcement` wins.** `:131` is now
   `announcement !== '' ? announcement : laneUnsure ? '' : laneSentence` — the
   precedence is inverted from round 1, and the `unconfirmed` sentence is
   withheld from the polite region because it already renders as its own
   `role="alert"` (`:133-137`), so it is not announced twice.

**The counter-example is a test.** `requests-client.test.tsx:462` scripts exactly
the sequence the old inline comment called impossible — building→built on
loc-1, approve, switch to loc-2, loc-2 building→built — and asserts the live
region is `''` immediately after the switch and then carries "your batch is
ready" on the next tick. **`edge_cases[13]` is a test too** (`:501`): the approve
POST is held open, the scope is switched, the POST then settles, and both
`getByRole('status').textContent` is `''` and no "will send" text renders.

### 6 — LOW–MEDIUM, the halt reason. **FIXED as a contract amendment. Code correctly untouched.**

`.feature/intake.json` · `docs/superpowers/plans/feat-629-owner-approval-lane-intake.json`
· deviations D11

`edge_cases[7]` now reads, verbatim and identically in both copies:

> Halt of a batch that was never approved is allowed (it is the owner discarding
> a built batch) and records owner_veto — a veto is 'halt at zero sends' per
> CONTEXT.md, and no email has left; amended 2026-08-17 (deviation D11) because
> this entry originally said owner_halt and contradicted tests_to_add's
> owner_veto property

**Byte-identical:** both files are 11,276 bytes with SHA-256
`bed8ded75bbcb4e3eb1609a9aa46bb1bcc430072bc84a5f9d970a93d2a773710`; `diff` is
empty.

**The code is unchanged, as required.** `git diff a45ac1f0..HEAD --
src/lib/solicitation/approval.ts` contains no hunk touching `ownerHaltReason` or
`OwnerHaltReason`. `tests_to_add[18]` — *"property: the owner halt reason is
owner_veto exactly when sending has not started"* — is still present and passing.
D11 records the owner decision and explicitly notes the fix agents were told not
to "fix" it. Not flagged.

---

## Regression sweep

| Check | Result |
|---|---|
| Both intake copies byte-identical | **Yes** — identical SHA-256, 11,276 bytes each, empty `diff`. |
| All 33 `tests_to_add` titles present | **Yes** — all 33 matched verbatim across `src`/`worker` by literal search; zero misses. |
| `allowed_edit_surface` drift | **None.** All 39 changed paths in `a6e38fe9…HEAD` fall inside a listed glob, including the one D8 amendment (`src/lib/approval/__tests__/outcome-anchor-pairing.test.ts`) and the new `src/lib/solicitation/__tests__/batch-view.integration.test.ts` (covered by `src/lib/solicitation/**`). No second amendment was needed. |
| `pnpm typecheck` | Clean. |
| `pnpm lint` | Clean. |
| `pnpm test` (full suite, live-DB lane awake) | **12,376 passed, 11 skipped, 964 files.** |
| CI audits | `ci:tenant-scope`, `ci:static-policy`, `ci:directory-map`, `ci:db-imports`, `ci:live-db-suites`, `ci:outbox-status`, `ci:outbox-seam` — all pass. |

### Did the fixes break anything they touched?

- **`55e9744d`'s read-model decorrelation is semantics-preserving.** The single
  `LEFT JOIN`-onto-`b` statement became three statements inside the same
  read-only `REPEATABLE READ` transaction, so they share one snapshot and cannot
  tear. `COUNT(DISTINCT a.id) FILTER (WHERE o.id IS NULL)` → `COUNT(*)` over the
  anti-join is exact: an unmatched `a` yields exactly one NULL-extended row and
  every matched row is discarded by `o.id IS NULL`, so the `DISTINCT` was never
  load-bearing. `COUNT(DISTINCT mo.id)` → `COUNT(*)` on `solicitation_outreach`
  alone is exact once the `mo` cross-multiplication is gone. Dropping the
  `delivery_status` filter from the moderation count is safe and I checked the
  constraint rather than the comment: migration 108's re-spelled
  `solicitation_outreach_status_reason_consistency` pins `moderation_high` to
  `withheld` only, so the unfiltered count cannot pick up a cancelled row — and
  the attempts query, which excludes only `cancelled`, therefore stays in
  agreement with it. The "unreadable in its own snapshot" throw is carried over
  verbatim from the pre-refactor code, not new. `haltReason` narrowed from
  `string | null` to `HaltReason | null` is an assertion, and the panel keeps its
  `Object.hasOwn` fallback (`ApprovalPanel.tsx:207-211`), so an out-of-union
  value still renders a stop sentence rather than a blank.
- **`bf3d76d0` is comments plus the deviations file.** It strikes a copied-and-
  false FK premise at all three sites and leaves the lock order itself untouched:
  `lockBatchForAction` still runs `acquireSolicitationBatchLock` →
  `solicitation_batches … FOR UPDATE OF b` → `agent_runs`, with every
  `recordStep` / `closeBatchIfSettled` strictly after. B11 still holds, now on a
  true premise.
- **`351b8fb4`'s load-failure copy** is read-scoped and drops a write-scoped
  "nothing changed" promise a failed read cannot make. No
  `user_visible_behavior` entry governs that card.

---

## Untriaged appendix (NOT findings; outside round-2 scope or below the bar)

1. **`.feature/` is gitignored** (`.gitignore:173`), so `.feature/intake.json` is
   untracked. The byte-identity check passes on disk, but only the
   `docs/superpowers/plans/` copy is under version control — a reviewer on a
   fresh clone cannot reproduce the pair check.
2. **Refusal ordering has a second-order effect on one 409's copy.** Putting
   `no_send_parent` before readiness means a batch built while
   `SOLICITATION_SEND_ENABLED` was off but with `sendCount > 0` (send asks exist,
   no parent, no outreach rows) now answers `not_approvable/no_send_parent` where
   it would previously have answered `not_ready`. Not UI-reachable — the panel
   shows `preparing` because `ready` is false — and both are 409s, so this is a
   copy nuance on a direct POST, not a behaviour change. The brief asked for this
   ordering.
3. **Off-by-one in two comments.** `ApprovalPanel.tsx:101` and
   `approval-panel.test.tsx:281` cite "edge case 9" / `edge_cases[9]` for the
   all-withheld case, which is `edge_cases[8]` in the intake's 0-indexed array
   (`edge_cases[9]` is the partially-generated batch). Either a 1-based
   convention or a typo; cosmetic.
4. **Returning to a previously-approved location re-announces its stale lane
   sentence.** Approve on A → switch to B (region clears) → switch back to A: the
   region goes from `''` to "Approved. N messages will send." again. The sentence
   is still true of A, and `announcement` still outranks it, so this is a wart
   rather than the masking bug — but it is the residue of `lane` being cleared
   only by `onRetry` and not by the poll loop's own refetches.
5. **The `settled` mode shows a count, not the copy.** A `closed` batch renders
   "N messages in this batch." with no list, so "what was approved" is legible
   during `haltable`/`halted` but not after close. `user_visible_behavior[0]`
   governs the *built* batch only, so this is not a contract miss.
6. **`ci:fallow:coverage` was not run** — it needs a full `pnpm test:coverage`
   feed and gates the standards axis, not this one. D14 records the post-fix gate
   run as GREEN.
7. **D12's `resume` sub-issue is recorded OPEN by owner decision** — CONTEXT.md's
   Halt-latch Avoid list bans a word in copy that `user_visible_behavior[6]`
   requires in copy. Already triaged and deliberately left visible; noted here
   only so round 2 does not read as having missed it.

---

## Verdict

**All six round-1 findings FIXED.** Every fix is backed by a test that would fail
if the fix were reverted, and finding 2's test is specifically built to catch the
verification error that let the original bug ship — it asserts the required
content is *present*, not merely that the dangerous content is absent. No fix
introduced a new defect: the writer's remaining `throw` is provably unreachable,
the route switches stay exhaustive under `tsc`, the read-model decorrelation is
count-for-count equivalent inside one snapshot, and the panel's redaction choke
point is now enforced by the type system as well as by the projection. Contract
integrity holds — both intake copies byte-identical, all 33 test titles present,
no edit outside `allowed_edit_surface`, and the one contract change (D11) landed
as an amendment in both copies with the code correctly left alone.

Findings table: **empty.**
