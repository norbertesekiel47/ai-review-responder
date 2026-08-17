# Branch review round 1 — spec & correctness (#629 owner approval lane)

Reviewer: spec & correctness. **Review only — no production file was edited.**
Diff reviewed: `a6e38fe9b1fbc14da340947319976615eccebe5b...HEAD` (37 files,
+6,333 / −148).

Inputs read in full: `.feature/intake.json` (field by field, from the file),
`docs/superpowers/plans/feat-629-owner-approval-lane-deviations.md` (ten
entries + the step-6 read-back table),
`docs/reviews/feat-629-owner-approval-lane/blast-radius.md`, and the plan
`docs/superpowers/plans/2026-08-16-629-owner-approval-lane.md` (treated as
non-authoritative where it is stale, per the brief).

---

## What I verified as green

| Check | Result |
|---|---|
| `allowed_edit_surface` drift | **None.** Every one of the 37 changed paths falls inside a listed glob. `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` is the D8 amendment and is listed. |
| Both intake copies byte-identical | **Yes** — `.feature/intake.json` and `docs/superpowers/plans/feat-629-owner-approval-lane-intake.json` are semantically identical (D8's claim holds). |
| All 33 `tests_to_add` titles present | **Yes**, verbatim, across the five files. Distribution matches D4's corrected count (3 + 17 + 6 + 5 + 2). Extra tests beyond the 33 (D9's halt-route coverage) are additive. |
| Migration 108 vs 091 | Every arm is 091 verbatim; the only change is `owner_excluded` added to the `cancelled` set. `BEGIN` + `SET LOCAL lock_timeout = '3s'` + `COMMIT` matches 105's precedent (D5). |
| Test runs | `approval.test.ts`, `approval-panel.test.tsx`, `approval-routes.test.ts`, `batch-view.test.ts`, `batch/route.test.ts`, `outcome-anchor-pairing.test.ts`, `requests-client.test.tsx` → **71 passed**. `approval.integration.test.ts` against `test_629` → **17 passed**. |
| CI audits | `ci:tenant-scope` (392/392, baseline untouched), `ci:static-policy`, `ci:directory-map`, `ci:rls-audit` (incl. live check), `ci:db-imports` — all pass. |
| Invariants #8, #11, #13, #15 | Hold. Every statement in `approval.ts` and the lane query in `batch-view.ts` carries both tenant keys; `requireWritableOwner` → `assertWritableSubscriptionForAccount`; the send flag is read only at the route and surfaces as `sendLane: null`; both modules take `sql`/`tx` explicitly. |
| Lock order (B11) | `lockBatchForAction` takes `acquireSolicitationBatchLock` → `solicitation_batches … FOR UPDATE OF b` → only then reads `agent_runs`. Every `recordStep` / `closeBatchIfSettled` call is strictly after. D8's carve-out entry is accurate. |
| Halt latch monotonicity | `halted_at IS NULL` CAS + the early `already_halted` return; no resume path anywhere; `sending` deliberately excluded from the cancel sweep. |

### Area 1 — is the flag gate genuinely per-route? **Yes.**

`withScopedBatch` takes `requireWriteAccess` as a bound **function reference**
(`scoped-batch-route.ts:87`, called at `:101`), not a boolean. `reviewed`
binds `requireContactsWriteAccess` (watch only, unchanged by this branch);
`approve` and `halt` bind the new `requireSolicitationSendWriteAccess`
(`location-scope.ts:66-75`, `watch && send`). The regression is pinned by
`batch/__tests__/route.test.ts:189` — "records reviewed_at with
SOLICITATION_SEND_ENABLED off" — which stubs the send flag explicitly off and
asserts 204. `reviewed` does not 404 for watch-mode customers.

The ordering inside the runner also matches the pre-refactor route exactly:
gate outside the `try`, then location scope, then body parse, then handler,
then the uniform 500. `withSameOrigin()` stays the outermost wrapper on each
route.

### Area 2 — is the D7 SQL reshape semantics-preserving?

**The readiness anti-join: yes.** The `LEFT JOIN … WHERE o.id IS NULL` form at
`approval.ts:183-197` is equivalent to the `NOT EXISTS` it replaced:

- Every former subquery predicate moved verbatim into `ON`; the `a`-side
  predicates stayed in `WHERE`. That is the correct split — moving an `a`-side
  predicate into `ON` would have changed the result.
- `o.id` is the PK, so `o.id IS NULL` is true exactly for the NULL-extended
  rows, i.e. exactly the asks `NOT EXISTS` would have kept.
- **Row multiplication cannot distort the count.** An unmatched `a` produces
  exactly one NULL-extended row; multiplication only affects *matched* rows,
  which the `o.id IS NULL` filter discards. `COUNT(DISTINCT a.id)` therefore
  equals `COUNT(*)` here — the `DISTINCT` is belt-and-braces, not load-bearing.
- NULL handling: `o.delivery_status <> 'cancelled'` yields NULL (→ no join) if
  the column were NULL, which is the same answer `NOT EXISTS` would give. It is
  `NOT NULL` in the schema regardless.

**The `batch-view.ts` lane query: yes.** `COUNT(DISTINCT a.id) FILTER (WHERE
o.id IS NULL)` and `COUNT(DISTINCT mo.id)` are both correct under the `mo`
cross-multiplication (a batch with 2 asks × 3 moderation rows yields 6 join
rows; the filtered distinct still returns 1 and 3). A batch with zero send asks
yields `COUNT(DISTINCT NULL) = 0` rather than a missing row, which is what the
`LEFT JOIN` onto the single `b` row buys — and which turns out to matter (see
finding 1).

**The `lockBatchForAction` hoist: NO, not for all inputs.** See finding 3 —
`agent_runs.subject_id` is `text` (verified against the live schema), so
replacing the correlated `r.subject_id = b.id::text` with
`r.subject_id = ${input.batchId}` introduced a case-sensitivity dependency the
old form did not have. The comment at `approval.ts:98-100` justifies the change
on *tenancy* grounds, which is sound, but tenancy was never the equivalence
risk here — normalization was, and it is unaddressed.

### Area 3 — is `moderation_high` redaction intact after the three-way split? **Yes.**

Verified independently of the deviations file's claim:

- Layer 1 (SQL): the five `CASE WHEN o.disposition_reason = ${MODERATION_HIGH}
  THEN NULL` projections are unchanged and now sit inside the `options.sendLane`
  branch, so with the flag off the statement is not issued at all.
- Layer 2 (mapper): `toAttempts` returns the `{ redacted: true }` arm with the
  content keys **absent**, not undefined. `batch-view.test.ts:393` asserts exact
  object equality plus `Object.keys()` absence plus a whole-view
  `JSON.stringify` scan for the poison string.
- Layer 3 (panel): `toRows` (`ApprovalPanel.tsx:53-61`) is the only consumer of
  an `AskAttemptView` in the lane — I grepped the whole of `src/app` and
  `src/components`: the only other references are the `import type` in
  `AskList.tsx:3` used solely for the indexed access
  `AskAttemptView['deliveryStatus']`, and the prop pass-through in
  `RequestsClient.tsx:164`. No `subject`, `body`, `moderationDetail` or
  `interpolationInputs` read exists in any of the three files.
- `approval-panel.test.tsx:267` renders a batch whose only attempt is redacted
  and asserts the contact is not even named.

Redaction is structurally sound. (It is, however, *too* structural — see
finding 2: the same projection also removes the bytes the intake requires the
owner to read.)

### D3 — my position

I agree with the ACCEPT, with one addition. The recorded conditional (amendment
B2 lets `regenerateAsk` swap an approved row) is correctly scoped out: it has
no owner entry point, and the constraint carried into the deferred ticket is the
right one. But D3 is not the only thing weakening "byte-for-byte what sends" on
this branch. Finding 2 below is the larger hole and is *not* recorded anywhere:
today the owner cannot read the bytes at all, so "what was approved is
byte-for-byte what sends" is true about a payload the approver never saw. The
regenerate constraint should be joined by a second one on the deferred ticket —
the panel must render the bytes before the veto window can honestly be called
"an undo, not a review window" (`approval.ts:35-37`).

---

## Findings (≥80% confidence)

### 1. HIGH — a built batch with zero send Asks is offered as approvable, and approving it 500s

`src/lib/solicitation/approval.ts:267-271` (the throw) ·
`src/lib/solicitation/batch-builder.ts:810` (why the parent is absent) ·
`src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:79` (why it is offered)

`batch-builder.ts:810` gates the generation handoff on
`summary.sendCount > 0 && solicitationSendEnabled()`, and its own comment says
so explicitly: *"zero send asks means no generation work exists — no enqueue,
**no send parent**, watch-mode report unchanged."* A batch where the restraint
policy withheld every candidate is therefore a legitimate, reachable `built`
batch with **no `solicitation_send_batch` parent run**.

Walk it through with `SOLICITATION_SEND_ENABLED` on:

1. `readBuiltBatch`'s lane query finds no `a` rows → `pendingRenders = 0` →
   `ready: true`, `batchState: 'built'`.
2. `panelMode` (`ApprovalPanel.tsx:76-92`) returns `'approvable'`. The panel
   renders "Ready for your approval" and `ApprovalActions` renders
   **"Approve and send 0 messages"**.
3. The owner clicks. `approveBatch` finds `missingRenders = 0` (vacuously —
   there are no send asks), skips exclusions, and **commits the CAS**:
   `approved_at`, `approval_method='owner'`, `veto_deadline_at`.
4. `batch.send_parent_run_id === null` → `throw new Error('approveBatch: batch
   … passed readiness with no send parent run')`.
5. The `sql.begin` rolls back, `withScopedBatch`'s catch calls
   `reportCaughtError` (a real Sentry issue, once per click) and returns
   500 "Failed to approve batch". The panel shows the generic
   "Something went wrong. Nothing changed — try again." and the owner can never
   clear the batch from this screen.

The comment defending the throw — *"The parent must exist: readiness passed, so
generation ran and minted one"* — is the bug: readiness passing does **not**
imply generation ran, because readiness is vacuously satisfied over zero send
asks. `haltBatch` gets this right (`approval.ts:379-381` treats a missing parent
as legitimate, with a comment naming exactly this case); `approveBatch`
contradicts its own sibling twelve lines away.

**Untested.** Every approve test seeds a parent through `seedRenderedBatch`
(`approval.integration.test.ts:229-234`); `{ renders: 0 }` is never used, and
there is no approve-side analogue of the halt suite's deliberately parentless
`halts a built batch that was never approved` case.

Note this also violates `edge_cases[0]`'s spirit: the intake promises that an
approval which settles the batch runs `closeBatchIfSettled` and terminalizes the
parent `completed`. Here the batch settles and nothing closes it.

### 2. HIGH — the panel never shows the rendered subject or body, which `user_visible_behavior[0]` requires

`src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:53-61` ·
`src/app/(authenticated)/dashboard/requests/AskList.tsx:44-48`

`user_visible_behavior[0]`, verbatim from `.feature/intake.json`:

> "With SOLICITATION_SEND_ENABLED on, a built batch shows an approval panel
> above the funnel hero listing every rendered Outreach row **(subject + body)**
> with a per-ask exclude control"

`toRows` projects each attempt onto `{outreachId, contactName, deliveryStatus}`,
and `AskRowView` is the only shape `AskList` / `SelectableAskList` accept. I
grepped all of `src/app` and `src/components`: **no component anywhere renders
an attempt's `subject` or `body`.** `BatchReport.tsx` does not either. The owner
sees "Send to Dana Reeve — Ready to send" and nothing more.

This is not the redaction rule. The redaction rule (`invariants[1]`,
`user_visible_behavior[1]`, D6a) is specifically about the `moderation_high`
arm — which only makes sense as a *carve-out* from a surface where the other
rows' bytes are visible. The implementation applied the carve-out to all rows.

Three things this breaks beyond the literal contract:

- The intake `goal` — "let an owner **review** a built batch's rendered Outreach
  rows" — is not delivered; there is nothing to review.
- `approval.ts:35-37` justifies the 15-minute window as "an undo, not a review
  window — the owner has already read every rendered message." He has not.
- It hollows out `invariants[8]` ("what was approved is byte-for-byte what
  sends"). The guarantee is intact mechanically and empty in substance.

The plan never specified rendering the bytes either (I grepped it: `subject`
appears only in the glossary, the redaction test, the SQL, and a log comment),
so this originated at planning and propagated. **It is not recorded in the
deviations file**, so it was never triaged.

`non_goals[0]` excludes owner *edit* (D22), not display — `ApprovalActions.tsx`
correctly renders no edit affordance, and that is a separate, satisfied
requirement.

### 3. MEDIUM — D7's `agent_runs` hoist is not case-equivalent to the correlated form it replaced

`src/lib/solicitation/approval.ts:101-111` (esp. `:106`) ·
`src/lib/shared/ids.ts:41`

Verified against the live test schema: `agent_runs.subject_id` is `text`, and

```
SELECT ('550E8400-…'::uuid = '550e8400-…'::uuid),   -- t
       ('550E8400-…'      = '550e8400-…');          -- f
```

`isValidUuid` uses `/…/i`, so a mixed-case UUID passes `readApproval` /
`readBatchId` untouched. In `lockBatchForAction` the batch row is found (uuid
cast normalizes) but the parent lookup — now a bare `text` comparison against
the raw client string — is not. The pre-D7 form `r.subject_id = b.id::text`
normalized through the column and had no such dependency.

Concrete failures for a real, tenant-owned batch whose id the caller uppercases:

- **approve** → `send_parent_run_id: null` → the finding-1 throw → 500 and a
  Sentry issue, with the approval rolled back.
- **halt** → the latch is written and the outreach rows are cancelled, but
  `approval.ts:381` skips `recordStep('batch_halted')`. The batch is
  permanently halted with **no run-spine record of who halted it or why** —
  precisely the immutable record `observability[2]` and D9 require.

The comment at `:98-100` justifies the hoist as "equivalent because the row
above already proved that id belongs to this tenant." That is true and is the
wrong axis: the equivalence risk was normalization, not tenancy.

Sibling note: `closeBatchIfSettled` (`outreach.ts:368`) and both
`ask-generation.ts` lookups share the shape, so the class is pre-existing — but
in those call sites the id always originates from the database. This branch is
the first to feed an HTTP-supplied id into it.

### 4. MEDIUM — `edge_cases[8]` is not handled: an all-withheld batch still shows the approve control

`src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx:76-92`

`edge_cases[8]`, verbatim:

> "A batch whose asks were all withheld at generation has no rendered rows: the
> panel shows the spoilage report and **no approve control**"

`panelMode` returns `'approvable'` for any `built` + `ready` lane, and readiness
deliberately admits a `withheld` attempt (correctly — that is the D1 retitle's
whole point). So a batch whose every send ask rendered to `withheld`
(`lint_failed`, `moderation_high`) reaches `'approvable'` with
`sendable.length === 0`: `SelectableAskList` returns `null`, and
`ApprovalActions` renders **"Approve and send 0 messages"**.

Clicking it is not destructive in this variant — a parent exists, so
`approveBatch` approves, counts 0, and `closeBatchIfSettled` settles the batch
`exhausted` — but the screen offers a control the contract says must be absent,
labelled with a count that reads as a mistake.

No test covers ready-with-zero-sendable-rows: `approval-panel.test.tsx:127`
exercises `ready:false` and `ready:true`-with-one-row only. The `tests_to_add`
title *"shows the approve control only when every ask has an attempt"* is
satisfied as written, so the gate did not catch this.

### 5. MEDIUM — the lane announcement is not scope-keyed and permanently masks the fetch loop's own announcement

`src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:52`, `:92`

`laneMessage` is plain component state, written only by `onLaneChanged` and
**never cleared**, while `announcement` from `useLatestBatch` is correctly
scope-keyed (`:285-287`: `superseded ? '' : state.announcement`). The
`LiveRegion` at `:92` gives `laneMessage` unconditional precedence:

```tsx
<LiveRegion message={laneMessage !== '' ? laneMessage : announcement} />
```

Two consequences:

1. **Permanent masking.** After the first approve or halt, the loop's
   `COMPLETION_ANNOUNCEMENT` can never reach the live region again for the life
   of the island. The inline comment claims otherwise — *"It cannot mask the
   loop's own announcement: that one fires only on a building → built
   transition, which cannot follow an approval of an already-built batch"* —
   but a location switch is exactly that sequence: approve on location A, switch
   to location B whose batch is building, B transitions building→built,
   `announcement` is set, and the stale "Approved. 3 messages will send." still
   wins. Screen-reader users lose the only signal that B's batch finished.
2. **Cross-scope leak.** A write in flight when the owner switches location
   still resolves and calls `onChanged`, announcing its sentence against the
   newly selected location. `edge_cases[13]` — "an approval response for a
   superseded scope is never rendered against the newly selected location" — is
   honoured for the *view* (phase is scope-keyed) but not for the announcement,
   which is part of what is rendered. There is no AbortController and no scope
   guard on the panel's `fetch`, unlike the loop's.

The fix shape is the one the loop already uses: key `laneMessage` by scope, or
reset it in the same place `phase` resets.

### 6. LOW–MEDIUM — `edge_cases[7]`'s halt reason contradicts the code, and the divergence is unrecorded

`src/lib/solicitation/approval.ts:51-53` ·
`src/lib/solicitation/__tests__/approval.integration.test.ts:982`

`edge_cases[7]`: *"Halt of a batch that was never approved is allowed (it is the
owner discarding a built batch) and records **`owner_halt`**."*

`ownerHaltReason` returns `owner_halt` only when `state === 'sending'`, so a
never-approved `built` batch records **`owner_veto`**, and the integration test
of that exact title asserts `owner_veto` on both the result and the row.

The intake contradicts itself here — `tests_to_add[18]` ("property: the owner
halt reason is `owner_veto` exactly when sending has not started") mandates the
implemented behaviour. I think the code chose correctly: a discarded built batch
sent nothing, and D10's framing ("a veto is halt at zero sends") makes
`owner_veto` the honest audit value. But `edge_cases` is part of the locked
contract, one of its entries is now false, and this was never raised as a
deviation. It should be an intake correction (like D1) rather than a silent
divergence, because `halt_reason` is the audit vocabulary a support person reads.

---

## Low-confidence appendix (NOT in the findings table)

Observations I would not stake 80% on, or that are stylistic / advisory.

1. **`observability[0]` names an `alreadyApproved` log field** that the route
   does not emit; it logs `status` instead
   (`approve/route.ts:56-62`). Functionally equivalent (`status ===
   'already_approved'`), and arguably better, but the contract named a field.
2. **`user_visible_behavior[6]`** says "A halted or closed batch is read-only
   and **states that it cannot be resumed**." Only the `halted` arm says so;
   `closed` maps to `'settled'` → "This batch is finished. Nothing more will
   send from it." Conveys the same thing without the phrase.
3. **`panelMode` maps `'pending'` to `'settled'`**, which would render "This
   batch is finished" for a batch that has not been built. Unreachable today —
   `readBuiltBatch` is the only producer of a lane and only runs for
   `built_at IS NOT NULL` — so this is a latent copy bug, not a live one.
4. **`attempts: []` when the send flag is off** narrows a payload #628 shipped
   unconditionally. Defensible (it stops a flag-off deployment from serving
   message bodies) and no consumer existed, but it is an API-shape change not
   named in `user_visible_behavior`, and `user_visible_behavior[7]`'s
   "byte-identical to watch-mode today" is about the screen, not the payload.
5. **`haltBatch` on an `expired` batch records `owner_veto`.** Not specified
   anywhere; `batch_expired` exists in the CHECK for the #630 writer. Probably
   right (the owner is still the actor), but worth an explicit line in the spec.
6. **`deriveBatchState(lane, new Date())` in `batch-view.ts`** mixes the app
   clock with a DB snapshot taken in a `REPEATABLE READ` transaction. Skew is
   sub-second and the panel's `ready` is explicitly advisory, so this is
   theoretical.
7. **`excluded` is not reset when the batch id changes.** Safe today only
   because `Screen` unmounts the panel on scope switch and on any non-`built`
   phase; a future refactor that keeps the panel mounted would carry an
   exclusion set across batches.
8. **`blast-radius.md` noise.** The "82 importers" rows for the four route files
   are a heuristic artefact (a whole-repo test barrel matches), and
   `src/lib/notifications/email.ts` is listed as an importer of
   `src/lib/solicitation/approval.ts` but imports nothing from it (it matches
   `@/lib/approval/*`). No caller in the document is broken by the diff; the
   only genuine signature change (`readLatestBatch` gaining a required
   `options`) is fully covered by typecheck and every call site is updated.
9. **D9's clone-elimination is sound**, and the `withScopedContact` precedent is
   real. The one thing I would keep an eye on: `withScopedBatch` is now a
   single point through which three routes' auth, scope and 500 mapping run, and
   its own behaviour is only tested transitively through the three routes. A
   direct unit test of the runner would be cheap insurance.
10. **`approveBatch` recomputes `approvedCount` after the exclusion UPDATE**
    (`approval.ts:254-262`), which is the right order and matches
    `observability[3]`'s "how I would know it broke" check. Good.

---

## Verdict

Two findings block: **1** (a UI-reachable 500 plus a Sentry issue on a real,
if uncommon, batch shape) and **2** (a named `user_visible_behavior` item that
was never built and never triaged, which also hollows out the feature's
headline guarantee). **3** should ship with them — it is a two-line
normalization and it currently costs a silent audit-record loss on the
destructive verb. **4**, **5** and **6** are worth clearing in the same pass;
none is a merge blocker on its own.

Everything else in the branch — the lock order, the CAS idempotence, the
redaction chain, the per-route gate, the migration, the tenant scoping and all
33 promised tests — checks out.
