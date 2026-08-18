# Branch review round 1 — Spec & correctness axis

Branch: `feat-865-admin-halt-surface` · Fork point `d89c112f` (= `origin/main`) · HEAD `3cb48a7e`
Contract: `.feature/intake.json` (byte-identical to `docs/superpowers/plans/feat-865-admin-halt-surface-intake.json`)

**Axis:** does the diff faithfully implement the intake contract? Field by field.
Line-level style and approach-level design belong to the sibling reviewers and are
deliberately not covered here.

**Verdict: the contract is implemented. One gap, at low severity.**
Everything in `invariants` (12/12), `edge_cases` (15/15), `non_goals` (9/9),
`user_visible_behavior` (7/7), `tests_to_add` (30/30) and `allowed_edit_surface`
checks out against the code. The single miss is `observability` bullet 3 — the
promised structured route log line does not exist.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| Low | `src/app/api/admin/solicitation/batch/halt/route.ts:116-137` | No structured log line on any success path. `observability` bullet 3 promises "A structured route log line naming status, batchId, businessId and cancelledCount"; the file contains no `console`/`logger` call at all except `internalError`'s throw path. The owner arm's counterpart emits exactly this at `src/app/api/dashboard/solicitation/batch/halt/route.ts:76`. |

Nothing else reached ≥80% confidence. Speculative observations are in the appendix.

---

## 1. `allowed_edit_surface` — no drift

22 changed paths, all inside the 9 armed globs. Enumerated:

| Path | Glob |
|---|---|
| `src/lib/solicitation/approval.ts` | exact |
| `src/lib/solicitation/batch-view.ts` | exact |
| `src/lib/solicitation/__tests__/{approval,approval.integration,batch-view.integration}.test.ts` | `src/lib/solicitation/__tests__/**` |
| `src/app/api/admin/solicitation/batch/halt/route.ts`, `.../batch/__tests__/routes.test.ts` | `src/app/api/admin/solicitation/**` |
| `src/app/admin/businesses/[id]/{page.tsx,BusinessDetailClient.tsx}` | `src/app/admin/businesses/[id]/**` |
| `.../[id]/_components/SolicitationBatchPanel.tsx` + its `__tests__` | same |
| `.../[id]/__tests__/{page-source.test.ts,BusinessDetailClient.test.tsx}` | same |
| `CONTEXT.md`, `docs/directory.md` | exact |
| `docs/superpowers/plans/**` (4 files), `docs/reviews/**` (4 files) | exact |

No migration file, no `package.json`, no lockfile. `dependencies_added: []` holds.

---

## 2. `invariants` — 12/12

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | Halt latch monotone: CAS on `halted_at IS NULL` | PASS | `approval.ts:463-474` — `AND halted_at IS NULL … RETURNING id`; `if (latched === undefined) return { latched: false }` short-circuits **before** the cancel, the audit and both spine calls. Double-guarded by the `state === 'halted'` early return at `:657`. |
| 2 | `sending` NEVER cancelled; only `rendered`/`queued` | PASS | `approval.ts:486` — `delivery_status IN ('rendered', 'queued')`. Pinned three ways: live-DB (`approval.integration.test.ts` "cancels rendered and queued…" asserts the `sending` row keeps `delivery_status:'sending', disposition_reason:null`), the fast-check property (asserts the normalized SQL text contains the exact IN list, over arbitrary status multisets), and the read projection's separate `sendingCount`. |
| 3 | Latch never terminalizes the parent; calls `closeBatchIfSettled` | PASS | `approval.ts:525-529` is the only settlement path. `approval.integration.test.ts` "delegates parent settlement…" asserts **zero** `UPDATE agent_runs` statements in the instrumented query log while the seam is stubbed — the strong form; a final-parent-state assertion would have passed a direct terminalization. |
| 4 | `halt_reason` fixed by route identity; no request field may name it | PASS | `ADMIN_HALT_REASON` is a module constant (`approval.ts:407`); `AdminHaltBatchInput` has no reason field; the route's `z.strictObject` (`route.ts:57-62`) 400s on `reason`/`haltReason`/`halt_reason`. Owner arm derives via `ownerHaltReason(state)`. |
| 5 | `OwnerHaltReason` stays 2 members; `LatchHaltReason` never exported | PASS | `approval.ts:75` and `:403`. `approval.test.ts` "type contract:…" uses a **bidirectional** `TypeEqual` (a one-way `extends` would pass for a widened union) plus a source assertion for the non-export and for `export .*reason\s*:\s*LatchHaltReason`. |
| 6 | `writeAccountAuditLog` in the SAME tx and BEFORE the run-spine calls; never a raw INSERT | PASS | `approval.ts:493-508` runs on `tx`, positioned between the cancel and `recordStep`. `approval.integration.test.ts` "writes its audit row before recordStep and closeBatchIfSettled…" proves **receiver identity** (`auditReceiver === transactions[0]`, `!== executor`) *and* `invocationCallOrder` *and* the query-log index ordering — the three claims that separate "both rows exist" from the real contract. |
| 7 | Lock order advisory → batch row → `agent_runs`; run-spine last | PASS | `lockBatchForAction` takes the advisory lock then `FOR UPDATE OF b` (`:141-173`); `latchHalt` steps 4-5 are the only `agent_runs` touches and are last. |
| 8 | ADMIN ARM ONLY: never latches `built_at IS NULL` | PASS | `approval.ts:658` — `state === 'closed' || state === 'pending'` → `not_haltable`. Verified the guard is **exactly** equivalent: migration 091's ordering CHECK (`091:161,167,170`) forces `approved_at`, `sending_started_at` and `send_closed_at` all NULL when `built_at IS NULL`, so for a non-halted row `built_at IS NULL ⟺ deriveBatchState === 'pending'`. No state escapes through a non-`pending` arm. |
| 9 | Invariant #15 — explicit `sql` param, no `@/lib/db/server` import | PASS | `approval.ts` and `batch-view.ts` import lists carry no `@/lib/db/server`; `ci:db-imports` PASS. |
| 10 | Invariant #12 — route parses/gates/maps only | PASS | `route.ts:95-138` is gate → parse → one domain call → status map. The latch, the cancellations, the audit and the join all live in `adminHaltBatch`'s single transaction. |
| 11 | Invariant #8 — body-supplied tenant triple; mismatch = uniform 404 | PASS | `lockBatchForAction`'s `WHERE` carries both tenant keys; `locked === null` → `not_found` → 404. `approval.integration.test.ts` "returns not_found for a real batch id under the wrong tenant" probes **both** boundaries — the foreign account and the *sibling business under the right account*, which is what a single-key `WHERE id =` would wrongly halt. |
| 12 | Admin arm NOT gated on `SOLICITATION_SEND_ENABLED` | PASS | No flag read anywhere in `route.ts`. Pinned at the route level (`routes.test.ts:248-259` sets the env var to `'false'` and asserts 200) — correctly placed there rather than in the module, which never reads the flag. |

---

## 3. `edge_cases` — 15/15

| # | Edge case | Verdict | Where |
|---|---|---|---|
| 1 | Mixed-case batch id canonicalised at the public entry point | PASS | `adminHaltBatch:649` calls `canonicalBatchId` before `sql.begin`; every downstream use — including the `closeBatchIfSettled` argument at `:526` — takes the canonical value. Reachable through the route: `z.uuid()` (zod 4.4.3) accepts upper case (verified by running the validator). Test asserts the seam receives the lower-case id **and** that the audit `entity_id` is canonical. |
| 2 | Already halted → `already_halted`, no second audit row, no second step | PASS | Guard at `:657` + the CAS. Live-DB test asserts `halted_at` is unchanged, `readSteps(…,'batch_halted')` length 1, `readAuditRows` length 1. |
| 3 | Already closed → `not_haltable` with the derived state | PASS | `:658`; test asserts `{ status:'not_haltable', state:'closed' }` and a byte-identical batch snapshot. |
| 4 | Still building (`built_at IS NULL`) → `not_haltable` | PASS | `:658`. The test goes further than the refusal — it then runs the builder's own `built_at IS NULL`-guarded CAS and asserts `count === 1`, i.e. the consequence D11 exists to protect. |
| 5 | Parentless batch → still latches, skips the step, still joins | PASS | `latchHalt:512` guards only `recordStep`; `closeBatchIfSettled` at `:525` is unconditional. Test asserts `recordStep` not called, `closeBatchIfSettled` called once, `close.status === 'no_send_parent'`, and — the load-bearing bit — that the audit row is still written (for a parentless batch it is the only durable record). |
| 6 | Real batch under the wrong account/business → 404 | PASS | See invariant 11. |
| 7 | AAL1 → 403 `mfa_required`, no write | PASS | `requireAdminWithAal2` returns `{ok:false}` before any parse; test asserts body `{error:'mfa_required'}` and `adminHaltBatch` not called. |
| 8 | Non-admin with a valid AAL2 session → refused by the role gate | PASS | `requireAdminWithAal2` calls `requireRole(request,'admin')` **first** (`admin-mfa-gate.ts:55`), so the role gate refuses independently. Test satisfies AAL2 on purpose and asserts 403 + no domain call. |
| 9 | `sending` mid-flight → those rows survive, join `not_settled`, parent stays running | PASS | Test asserts `close: { status:'not_settled', liveCount:1 }`, `readRunStatus === 'running'`, `send_closed_at` NULL. |
| 10 | `writeAccountAuditLog` throws → latch + cancellations roll back, no spine call | PASS | The audit runs on `tx`; a rejection propagates out of the `sql.begin` callback. Test asserts `halted_at/halt_reason/halted_by` all NULL, an identical outreach snapshot, zero audit rows, zero `batch_halted` steps, **and** that neither `recordStep` nor `closeBatchIfSettled` was called. |
| 11 | Missing / empty / >1000-char note → 400, no write | PASS | `z.string().trim().min(1).max(1_000)` — `.trim()` runs before the checks, so `'   '` fails `min(1)`. Test asserts `[400,400,400]` and no domain call. |
| 12 | Body naming a reason → 400, `adminHaltBatch` never called | PASS | `z.strictObject`; test covers all three spellings. |
| 13 | Cross-origin POST → refused before the gate | PASS | `withSameOrigin()(halt)` at the export; test asserts 403 **and** `requireRole` never consulted. |
| 14 | `SOLICITATION_SEND_ENABLED` off → still halts | PASS | See invariant 12. |
| 15 | No batch at all → no-batch state, no stop control | PASS | `SolicitationBatchPanel.tsx:127-135`; the panel test's `nonActionable` array includes `null` and asserts `queryByRole('button', {name:/stop/i})` is null. |

---

## 4. `user_visible_behavior` — 7/7, nothing unnamed

1. **Panel shows batch, state, cancellable count, sending/sent** — `SolicitationBatchPanel.tsx:194-239`, three `CountTile`s, never summed. `readAdminBatchSummary` supplies all three.
2. **Stop control + required note when haltable** — `:252-273`; `required` on the input plus a JS trim check plus the server's `min(1)`.
3. **Writes `admin_halt` + `halted_by` = acting admin; cancels rendered/queued** — `latchHalt:463-488`, actor stamped from `gate.admin.id` (`route.ts:121`), never from the body. `AppUser.id` is `users.id` — the same value `unsuspendAccountAutonomy` writes, and the FK target of both `solicitation_batches.halted_by` (091:107) and `account_audit_log.actor_user_id`.
4. **Owner's Requests panel renders the shipped copy** — verified present and untouched: `ApprovalPanel.tsx:266-267` carries the exact sentence, keyed on `admin_halt`.
5. **AAL1 → 403 `mfa_required`, nothing written** — see edge case 7.
6. **Second stop → `already_halted`, no second audit row, no second step** — see edge case 2; the panel renders "This batch was already stopped; nothing changed."
7. **Closed or still building → `not_haltable`, no control** — `NON_ACTIONABLE_COPY` covers `pending`/`halted`/`closed`, exactly mirroring `adminHaltBatch`'s refusal set, so the panel never offers a control whose only outcome is a 409.

**Nothing user-visible was built that the contract does not name.** The panel additionally renders built/approved/stopped timestamps and a halt-reason label; both fall under "its Batch state". The wire's `closed` boolean is never rendered.

---

## 5. `non_goals` — 9/9 respected

1. No migration — `supabase/migrations/` untouched.
2. No new CHECK member, no widened `OwnerHaltReason` (2), no widened `HaltReason` (5).
3. No resume/undo/un-halt surface anywhere.
4. No cross-account `/admin/solicitation` list page; the only file under `src/app/api/admin/solicitation/**` is the single halt route.
5. Owner Requests copy unchanged — `ApprovalPanel.tsx` is not in the diff.
6. `send_window_elapsed`, `batch_expired` and the #630 releaser remain unwritten.
7. No subject or body in the admin projection — the key set is closed at 9 and the test asserts it exactly, plus a negative string check on a seeded secret subject/body.
8. `closeBatchIfSettled` untouched.
9. **`haltBatch`'s pending hole deliberately unfixed** — confirmed asymmetric in the code: `haltBatch:575-576` guards `halted` and `closed` only; `adminHaltBatch:657-658` adds `pending`. The asymmetry is applied to exactly one arm, is documented at `approval.ts:637-640`, and plan §7 carries the follow-up. This is the item most likely to look like a bug to a reader who has not read the contract; it is not.

---

## 6. `tests_to_add` — 30/30 present verbatim and asserting

All 30 titles matched by exact substring against the six eval files (script-verified, no near-misses). Placement matches plan §4 Task 0's table. No `.todo`, `.skip` or `.only` anywhere in the six files.

Every title carries real assertions — I read all 30 bodies. The three the plan singled out as "needing a technique, not just an assertion" all use the strong instrument:

- **audit-before-spine** uses a `Proxy` over a real `Sql` recording receiver identity, `invocationCallOrder` and the query-log index. The weak form ("both rows exist") would pass for an audit on the base client and for an audit after `recordStep`; this one does not.
- **rollback on audit failure** asserts the latch columns, a full outreach snapshot, zero audit rows, zero spine steps and both spies uncalled.
- **settlement delegation** stubs the seam so the parent's terminalizing `UPDATE agent_runs` cannot come from the seam, then asserts zero such statements in the log — the only shape that catches a direct terminalization.

The fast-check property is genuinely a property (arbitrary multisets over 091's eight-member `delivery_status` vocabulary, `numRuns: 40`), asserts both the fixed-point claim and audit/spine cardinality one, and pins the exact IN list rather than restating the function body.

**Executed, this review's own run:**

```
5 non-DB suites  → 28 passed (28)
2 live-DB suites → 57 passed (57)
```

`ci:tenant-scope`, `ci:static-policy`, `ci:admin-aal2`, `ci:directory-map`, `ci:db-imports` — all PASS at HEAD.

---

## 7. The `latchHalt` extraction under 13 importers (blast-radius follow-through)

The blast-radius doc's real question: did `haltBatch`'s observable behaviour change
when its body moved into `latchHalt`?

**No.** Statement-by-statement against the pre-image in `git diff`:

| Old `haltBatch` | New path | Same? |
|---|---|---|
| guards `halted` → `already_halted`, `closed` → `not_haltable` | unchanged at `:575-576` | yes |
| `ownerHaltReason(state)` | unchanged at `:578` | yes |
| CAS with `${reason}` / `${input.haltedByUserId}` | `latchHalt` CAS with `input.reason` / `input.actorUserId` | yes — identical SQL, identical binds |
| `latched === undefined` → `already_halted` | `!outcome.latched` → `already_halted` | yes |
| cancel `IN ('rendered','queued')`, `disposition_reason = reason` | identical | yes |
| conditional `recordStep` on `send_parent_run_id !== null` | identical | yes |
| `closeBatchIfSettled(tx, {batchId, accountId, businessId})` | identical | yes |
| returns `{status:'halted', reason, cancelledCount, close}` | identical shape | yes |

The one *inserted* statement is the audit write, guarded by `input.audit !== null`,
and `haltBatch` passes `null`. `approval.test.ts` "haltBatch still derives…" pins
this directly: it asserts the owner arm's two derived reasons **and** that the CAS
and cancel SQL text are byte-identical between the two arms after normalization,
**and** that the owner arm issues zero `account_audit_log` statements while the
admin arm issues exactly one.

`HaltBatchResult` is unexported-unchanged, so the 13 importers are unaffected.
Checked the non-test ones individually: `ApprovalPanel.tsx` imports
`HaltBatchResult` type-only; `approve/route.ts`, `halt/route.ts` and
`regenerate/route.ts` import unchanged functions; `notifications/email.ts` has no
`approval` import at all (heuristic artefact, as the doc warns).

`batch-view.ts`'s 17 importers see a pure addition (`AdminBatchSummary` +
`readAdminBatchSummary`) and one doc-comment edit. `HaltReason` still names five
members, so `ApprovalPanel.tsx`'s total `Record<HaltReason, string>` still compiles
without a new entry.

The doc's caveat about the new route's "82 importers" is correct — that list is a
text-search artefact (it is every file matching the search, not a real import
graph); the route has no importers.

---

## 8. The three deviation entries with teeth

- **D7** (the semantic rebase drift on `lockBatchForAction`) — verified fixed and
  *not* half-fixed: `adminHaltBatch:651-655` now uses the three-line
  `locked === null` / destructure form, the `deriveBatchState` call is gone from
  the verb (the helper owns it), and the guard order and every result arm are
  intact. Both arms call the same helper with the same argument shape.
- **D5/D6** (the eval's deferred type errors) — both resolutions live in test
  files only; no production type assertion survives. `route.ts:143` is the plain
  house export `withSameOrigin()(halt)` with no `as typeof`.
- **D8** (2.2x production-line overrun) — an estimation miss, not scope creep: all
  22 paths are in-surface and every one was named by the intake. Confirmed
  independently by the surface enumeration in §1.

---

## Appendix — low-confidence / below the reporting bar

Deliberately **not** in the findings table. Each is either speculative, a
pre-existing model property the contract inherited, or a UX nit outside this axis.

1. **"Latest batch" is not necessarily "the batch that is sending."**
   `readAdminBatchSummary` orders `created_at DESC, id DESC` and takes one row.
   `ingest.ts:571-582` creates a new `pending` batch on every completed CSV upload
   with no guard against an older live batch, and 091's
   `solicitation_batches_one_active_send_per_business` only excludes a second
   *approved* batch — so a `pending` batch can sit newer than a `sending` one. In
   that state the panel shows "still building" and offers no control for the batch
   actually in flight. I am not raising this because it is *exactly* the shipped
   owner-side model (`readLatestBatch`, `batch-view.ts:790`), the plan locked the
   ordering to match it (§3.2), and the intake's `existing_patterns_to_follow`
   names that read model as the pattern to follow. If it is a real operational
   gap it is a gap in the send-lane read model, not something this branch
   introduced. Worth an owner decision, not a branch fix.

2. **Refusal statuses surface as raw tokens in the panel's error line.**
   `SolicitationBatchPanel.tsx:172` falls back `json.error ?? json.status`, and the
   admin route's `toWire` emits no `error` key — so a 409 renders the literal string
   `not_haltable` and a 404 renders `not_found`. Only reachable from a stale tab
   (the panel hides the control for every refusing state). Copy quality, not
   contract.

3. **The domain module does not bound the note.** `AdminHaltBatchInput.note` is a
   bare `string`; the 1–1000 bound lives only in the route's schema, and the note
   lands verbatim in the audit payload. The route is the only caller today and
   this matches `unsuspendAccountAutonomy`'s split, so it is consistent with the
   named precedent — but a second caller would not inherit the bound.

4. **The panel has no `maxLength` on the note input.** A >1000-character note
   round-trips to the server and comes back as a raw zod message
   ("Too big: expected string to have <=1000 characters"). Cosmetic.

5. **`writeAccountAuditLog` adds FK `FOR KEY SHARE` locks inside the latch
   transaction.** The INSERT touches `account_audit_log`'s parents
   (`accounts`, `users`, and `businesses` via `location_id`) between the
   `solicitation_batches` row lock and the `agent_runs` locks. Invariant 7 only
   constrains the run-spine calls being last, which they are, and the sibling admin
   precedent takes the same locks — but the file header's lock-order argument does
   not mention these acquisitions, so a future reader reasoning about the
   offboarding-purge ABBA will not find them named. Documentation observation, and
   possibly the maintainability reviewer's territory rather than mine.

6. **`route.ts:126-134`'s switch has no terminal `return`.** Exhaustive over the
   four-member union, so TypeScript treats the endpoint as unreachable and
   `pnpm typecheck` is clean. Only reachable if the domain union grows without the
   route being updated — which would be a compile error at `toWire`'s switch first.
   Noted for completeness, not a defect.

---

# TRIAGE (orchestrator, step 7 round 1, 2026-08-18)

| # | Finding | Verdict |
|---|---|---|
| L1 | No structured log line on any success path | **ACCEPTED, fixed** in `b9fc9e03`. The intake's `observability` bullet 3 promises it verbatim, so this was a contract miss, not a nice-to-have. Added `createWorkerLogger` + one `admin_batch_halted` line carrying status/batchId/businessId/cancelledCount. **The note is deliberately excluded** — it is free text an operator typed, and CLAUDE.md forbids logging raw content. |

**The appendix item was promoted to a finding by the adversarial axis and fixed.**
This report flagged, but deliberately did not file, that `readAdminBatchSummary`
selects the newest batch while `ingest.ts:571` can mint a newer `pending` one —
so a `pending` batch could shadow a `sending` one. The judgement not to file it
was defensible (it mirrors the shipped `readLatestBatch`, which the intake names
as the pattern to follow). The adversarial reviewer reached it independently and
rated it **High**, arguing the two projections answer different questions: the
owner view is presentational, this one is operational. The owner approved fixing
it in-branch. See F1 in `branch-round1-adversarial.md` and commit `b9fc9e03`.

**Worth keeping from this report:** the verification that invariant 8 is exactly
right rather than approximately — 091's ordering CHECK forces `approved_at` /
`sending_started_at` / `send_closed_at` all NULL when `built_at IS NULL`, so for
a non-halted row `built_at IS NULL` ⟺ state `pending`, and no state escapes the
guard. That is the kind of check that makes the rest of the report credible.
