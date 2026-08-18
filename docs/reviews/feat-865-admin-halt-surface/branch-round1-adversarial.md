# Branch review round 1 — adversarial approach axis

Branch: `feat-865-admin-halt-surface`

Fork point: `d89c112ffa31a38dc64f7dcccf005f2927446f52` (`origin/main`)

Reviewed diff: `git diff d89c112f..HEAD`

HEAD reviewed: `3cb48a7ea2327e6679de9ae7e87dec8940895056`

This review challenges the chosen seams, data model, trust boundaries, flag
semantics, lifecycle asymmetry, and target-selection policy. It deliberately
does not repeat the sibling spec finding (the missing structured route log) or
the standards review's presentation/documentation findings.

## Verdict

**REVISE.** Two approach findings clear the requested 80% confidence bar.

The more serious one is the admin reader's target-selection policy. “Newest
batch” and “batch currently sending” are different domain concepts, and the
schema explicitly permits them to be different rows. A normal later upload can
therefore hide the stranded sending batch this feature exists to stop.

The second is the deliberate owner/admin lifecycle asymmetry. The plan's stated
reason for deferring the owner arm's pending-batch defect depends on the UI not
offering a stop control, but the authenticated owner API remains directly
reachable and the owner read API exposes the pending batch id. This is not a
hypothetical unreachable state.

## Findings

| Severity | File / decision | Finding |
|---|---|---|
| **High** | `src/lib/solicitation/batch-view.ts:899` / plan D9 | `readAdminBatchSummary` selects the newest row, not the unique live send; a newer `pending`/`built` batch can shadow an older `sending` batch and remove support's stop control for the batch still dispatching. |
| **Medium** | plan D11 / §7; `src/lib/solicitation/approval.ts:565` | Deferring the owner arm's pending guard is unsafe: the owner GET exposes the pending `batchId`, the public halt route accepts it, and `haltBatch` latches it before the builder later fails migration 091's ordering CHECK. |

## F1 — Recency is the wrong selection policy for an emergency control

**Confidence: 98%. Severity: High.**

The branch treats the newest batch as the admin action target:

- `readAdminBatchSummary` orders all of a location's batches by
  `created_at DESC, id DESC` and takes one (`batch-view.ts:936-940`).
- The panel renders only that one summary and suppresses the control when its
  state is `pending` (`SolicitationBatchPanel.tsx:54-57,139-140`).
- There is no list or alternate selector in the feature; the intake explicitly
  excludes a cross-account batch page.

The write model does not make “newest” synonymous with “currently sending”:

1. Every completed CSV upload can insert a new unbuilt batch
   (`ingest.ts:563-586`). Its only conflict target is `source_upload_id`; there
   is no predicate against an older live batch.
2. Migration 091's one-active-send index applies only when
   `approved_at IS NOT NULL AND send_closed_at IS NULL AND halted_at IS NULL`
   (`091_send_mode_spine_lifecycle.sql:180-183`). A new `pending` or unapproved
   `built` batch therefore coexists legally with the older approved live batch.
3. The new row sorts first. While it is `pending`, the panel says it is still
   building and offers no stop. Once it becomes `built`, the panel may offer a
   stop for the new batch, but the older sending batch is still hidden. The
   problem is not only a short builder race.

Concrete consequence: after a customer uploads another CSV while an earlier
batch is stranded in `sending`, support opens the exact business-detail page
this feature adds and cannot stop the in-flight batch. Rendered/queued messages
on the older batch continue toward dispatch. Support could invoke the route only
if it recovered the hidden batch id through some out-of-band mechanism; the
shipped panel does not make the core operation reachable.

The counter-argument that this mirrors `readLatestBatch` does not hold. The
owner view answers a presentation question—“show my latest upload-derived
batch.” This admin panel answers an operational action question—“which batch is
still capable of sending?” Reusing the ordering copies syntax while discarding
the differing domain invariant.

The plan should be reopened around an action-oriented projection. At minimum,
the unique approved/non-closed/non-halted batch should outrank a newer pending
or unapproved batch. A clearer model would return `activeSendBatch` separately
from `latestBatch`, so the UI can show building progress without hiding the
emergency target. Add an integration case with an older `sending` row and a
newer `pending` row; the sending batch must remain visible and haltable.

The existing “latest” test does not cover this state. It seeds an older ordinary
batch and makes the newest batch the sending one
(`batch-view.integration.test.ts:759-836`), which proves the order but not that
the order selects the right operational target.

## F2 — The owner pending-batch defect is API-reachable, so the carve-out's premise fails

**Confidence: 94%. Severity: Medium.**

Plan §7 defers the owner arm's identical pending-batch defect partly because it
is “reachable only if the owner surface offers a stop control.” That argument
confuses UI reachability with API reachability:

1. `readLatestBatch` deliberately returns the unbuilt batch's `batchId` to the
   authenticated owner (`batch-view.ts:802-816`). It hides ask content, not the
   identifier.
2. The owner halt endpoint accepts any valid `batchId` from its JSON body
   (`scoped-batch-route.ts:58-66`) after deriving account, location, and actor
   from the authenticated scope. It does not require that the button which
   normally issues the request was rendered.
3. `haltBatch` refuses only `halted` and `closed`; `pending` falls through,
   derives `owner_veto`, and calls the shared latch (`approval.ts:569-592`).
4. The latch writes `halted_at` successfully because migration 091 explicitly
   permits a halt while `built_at IS NULL` (migration 091, lines 175-176).
5. The builder later stamps `built_at` with only an `AND built_at IS NULL` guard
   (`batch-builder.ts:780-787`). Its later timestamp makes
   `halted_at >= built_at` false, so the build transaction fails the CHECK.

Concrete consequence: an authenticated owner can take the pending id returned
by the ordinary GET and POST it to the ordinary halt endpoint, receive a
successful halt, and turn the subsequent builder run into a constraint failure.
The build job retries/fails instead of completing. This affects only the
owner's own tenant and requires bypassing the UI, which keeps the severity below
F1, but server-side lifecycle invariants cannot rely on a React button being
absent.

This is a new argument relative to the rejected plan discussion: it does not
claim the owner UI currently renders the control. It demonstrates that the
public backend contract remains reachable with an identifier the backend itself
returns.

The branch already rewrites `haltBatch` to pass through the new shared seam, and
the correct guard is known and implemented beside it for `adminHaltBatch`.
Applying the same pending refusal to both public verbs is the smaller and safer
approach. It preserves all documented owner UI behavior—the UI already offers
no pending stop—and removes an API-only behavior that corrupts the lifecycle.
The non-goal and D11 asymmetry should be revised rather than carried to a
follow-up.

## Attacks that did not produce findings

### 1. Is `latchHalt` the right seam?

Yes, for the current two verbs. I tested a third design: a single transactional
core taking a discriminated `owner | admin` actor and owning the lock, guards,
reason derivation, audit policy, and result mapping. It would make the
reason/audit pairing more type-closed, but it would also have to encode the
verbs' deliberately different guard and result unions or accept strategy
callbacks/flags. That moves policy into the mechanism and produces a wider,
less stable seam.

The implemented boundary shares the irreducible five-step ordered mutation and
keeps authentication, guard policy, and public result vocabulary in the two
verbs. Keeping it private limits the otherwise-generic `audit` input. The
extraction is preferable to both copies and a policy-heavy universal verb. F2
is a guard-policy decision above this seam, not evidence that the seam itself is
wrong.

### 2. D1 — an admin id in `halted_by`

No concrete defect. `halted_by` names the user who performed the halt, and its
FK deliberately targets the global `users` registry. The actor's tenant
membership is not part of that fact. `halt_reason='admin_halt'` preserves the
actor class at the time of action even if the user's role later changes, and the
same transaction adds the more explicit `solicitation_batch_admin_halted` audit
row. The route sources the actor only from the AAL2 admin gate, not the body.

A database CHECK cannot enforce “this referenced user had role admin at this
historical instant,” but a new admin-only FK or second actor column would not
solve mutable historical role either. Under the current global-admin model,
the chosen representation is defensible.

### 3. D2 — body-supplied tenant triple and uniform 404

The body triple is not, by itself, proof of authority; all three values are
untrusted. The authority is the preceding global-admin + AAL2 gate. Given that
authority model, the triple serves as an object-consistency constraint: every
read/write matches batch id, account id, and business id, and any mismatch
returns the same `not_found` result as an unknown batch.

That does not make all enumeration impossible—a correctly guessed full triple
returns a non-404—but the caller is already a global admin entitled to operate
across accounts, and the page already resolves those account/business ids. I
found no cross-tenant action or information available to a less privileged
caller, so the stronger wording is imprecise but has no concrete consequence in
this feature.

### 4. D5 — surviving `SOLICITATION_SEND_ENABLED=false`

The exception is sound. The flag stops new send work at the enqueue/domain
gates and removes owner approval controls. An admin halt creates no send work;
it monotonically reduces the set of rows that can still dispatch. Treating the
flag as an authorization gate for this safety action would make the emergency
control disappear at the exact moment operations disables the lane.

The actual emergency-brake dial for dispatch volume is also documented as
`SOLICITATION_PLATFORM_DAILY_CAP`, while the runbook preserves non-sending
control/ingress behavior with the send flag off. No surviving path here can
approve, render, release, or dispatch a message. I therefore found no kill-
switch bypass.

### 5. D11 asymmetry

Finding F2. The admin guard itself is correct; preserving the owner exception is
not.

### 6. Newest-batch shadowing

Finding F1. The feature's domain selection rule must differ from the owner
view's latest-upload rule if it is to guarantee access to the active send.

## Low-confidence appendix — not findings

These do not clear the 80% bar and should not be mixed into the findings table.

1. `LatchHaltInput` can represent internally inconsistent combinations such as
   `reason: 'admin_halt'` with `audit: null`. A discriminated actor input would
   prevent that, but the function is private, has two reviewed call sites, and
   no current path constructs an invalid combination. Revisit if the two system
   writers are added.
2. D2's prose should say the body tuple “constrains object identity,” not
   “proves tenancy.” If RepWorth ever introduces account-limited support roles,
   the global-admin premise changes and body-supplied ids will need an explicit
   authorization mapping. That role does not exist today.
3. D1 relies on the application gate, not a cross-table database constraint, to
   ensure an `admin_halt` actor had role `admin`. A new internal caller could
   misuse `adminHaltBatch`, but there is one production caller today and it
   stamps `gate.admin.id`; this is not a current reachable defect.

## Review boundary

No finding above repeats the missing structured success log or any of the
sibling standards findings. I did not count the already-recorded #860 rebase
break, deferred eval fixture typing, or line-estimate overrun as approach
findings; the deviations record shows each was detected and triaged by its
intended control.

---

# TRIAGE (orchestrator, step 7 round 1, 2026-08-18)

Both findings were put to the owner, because each contradicted a locked artifact:
F1 the plan's §3.2 design, F2 an explicit `non_goals` entry. Both were approved
for fixing in-branch.

| # | Finding | Verdict |
|---|---|---|
| F1 | Recency is the wrong selection policy for an emergency control (High, 98%) | **ACCEPTED, fixed** in `b9fc9e03`. `readAdminBatchSummary` now orders on the live-send predicate first, then the recency tiebreak; 091's partial unique index makes the first key untieable. The integration case you specified — older `sending` under newer `pending` — was verified genuinely red before the fix by reverting the `ORDER BY`. |
| F2 | The owner pending-batch defect is API-reachable (Medium, 94%) | **ACCEPTED, fixed** in `b9fc9e03`. `haltBatch` now refuses `pending` like `adminHaltBatch`. Recorded as deviations **D9**; plan §7, §2 D11, `CONTEXT.md` **Halt latch** and the `docs/directory.md` `approval.ts` row were all corrected in the same change, and §7's promised follow-up ticket is now moot rather than deferred. |

**Why F1 was accepted over its counter-argument.** The plan's defence was that the
ordering mirrors the shipped owner-side `readLatestBatch`. The report's answer —
that the owner view answers a presentation question while this panel answers an
operational one, so reusing the ordering copies syntax and discards the differing
invariant — is correct, and decisive for a feature whose entire purpose is
reaching a stranded batch.

**Why F2 counted as a new argument** rather than a re-run of the rejected plan
discussion: it never claims the owner UI renders the control. It shows the
backend contract is reachable with an identifier the backend itself hands out.
"Server-side lifecycle invariants cannot rely on a React button being absent" is
the sentence that settled it.

**The four attacks that failed are as valuable as the two that landed**, and are
recorded here deliberately: the `latchHalt` seam, D1's admin id in `halted_by`,
D2's body-supplied tenant triple with a uniform 404, and D5's survival of
`SOLICITATION_SEND_ENABLED=false`. Those four locked decisions have now been
attacked by three plan rounds and one adversarial branch round without moving.
