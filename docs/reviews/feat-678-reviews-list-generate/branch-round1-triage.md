# Branch review round 1 — orchestrator triage

Verdicts for all three axes in ONE file rather than three appended sections: a
resumed session needs one place to learn what was accepted, and the round-2
verification brief is built from this table. Full reports stay per-axis
(`branch-round1-{spec,standards,adversarial}.md`).

Round 1 of 3 (`.feature/state.json` → `branchReviewRounds`). Gate green at
`b0fed111` when dispatched.

**Every ACCEPT below was verified against the code before acceptance** — this
branch's recurring defect (D7) is that a *described* fix reads as done at every
later checkpoint. Findings taken on report alone are marked as such.

---

## Spec & correctness

| # | Sev | Verdict | Reasoning |
|---|---|---|---|
| S1 | Low | **ACCEPT** | Verified: `reviews-list.test.ts:244` asserts `values).toContain(PAGE_SIZE)` on page 2, which the `LIMIT ${PAGE_SIZE}` bind satisfies alone — the assertion passes with OFFSET dropped entirely. Strengthen to pin the OFFSET distinctly from the LIMIT. |
| S2 | Low | **ACCEPT** | Verified: an orphan passes all four in-tx guards (no `posted`, no non-terminal, no in-flight outbox), and `retry/route.ts:112-113` then 409s `newer_draft_exists` on the resulting draft — blocking the recovery path. Only reachable by a hand-crafted same-origin POST (the UI renders `recover`), hence Low, but the intake names this edge case explicitly. Fifth guard, same shape as its four siblings. |
| S3 | Low | **ACCEPT** | Verified: `CONTEXT.md` cites `generate-draft.ts:106`; the `version > 1` guard is at `:107`. D5 explicitly ruled "cite 107; do not correct the code to match the doc". Stale citation survived T8's rewrite. |

## Standards & maintainability

| # | Sev | Verdict | Reasoning |
|---|---|---|---|
| T1 | Med | **ACCEPT** | Verified: `tracker.ts:410` calls `getCacheRedis()` **inside** its own try, so D10's rationale for the caller's catch ("covers a synchronous `getCacheRedis()` throw before the `mget`") is **false** and the caller's catch is unreachable. The orchestrator accepted that rationale at D10 — this corrects it. A dead catch carrying a false justification is worse than no catch. |
| T3 | Med | **ACCEPT** | Verified: `http-routes.ts:222-224` re-asserts the writable/offboarding gate inside the locked tx, with a comment naming the TOCTOU. The Generate door checks it only pre-`sql.begin`, so an offboarding confirmed inside the window still commits a chargeable LLM enqueue. |
| T5 | Med | **ACCEPT** | Verified: `PastReplyCard.tsx:309` re-derives `!!failed_response_id && posted_at === null` instead of reading `row_state === 'recover'` — directly contradicts D-D ("the card renders a state, it never computes one"), which is the whole point of the discriminant. The two agree today only because `responses.posted_at` happens to be NULL for orphans; the column is nullable in general. |
| T9 | Low | **ACCEPT** | `deriveRowState` declares `failed_response_id` in its parameter shape and never reads it. Dead parameter on the branch's most invariant-adjacent function. |
| T11 | Low | **ACCEPT** | Invariant #2's byte-for-byte hand-spelling exemption exists because a bind parameter inside `ON CONFLICT … WHERE` defeats partial-index inference — that reasoning applies to **SQL literals only**. A TS-side triple comparison should use the exported constant. |
| T13 | Low | **ACCEPT** | `NO_STORE_HEADERS` missing on the Generate route's 500 while its sibling sets it on 7 of 8 returns. No rule distinguishes them. |
| T14 | Low | **ACCEPT** | The route header claims the origin lane is "the ONLY thing" excluding auto-approval, but `persist.ts` also requires `!suppressNotification`, which this route sets `true`. The comment invites deleting the wrong guard — precisely the risk on an invariant #3 surface. |
| T15 | Low | **ACCEPT** | Stale citations (`PastReplyCard.tsx:157`, `:201`) — actual sites are `:309`, `:383`, `:437`. Same class as D3. **Note: these came from the plan and were passed through in the T5 brief; the orchestrator propagated them.** |
| T16 | Low | **ACCEPT** | `aria-label="Search past replies"` keeps a banned glossary alias in assistive copy on the renamed surface — the one label in the file not updated. Screen-reader users get the old vocabulary. |
| T12 | Low | **ACCEPT** | Tenant proof runs on the write pool while the body reads use `sqlRead`, on an endpoint polled every ~1.5s. Cheap correctness-neutral fix. |
| T2 | Med | **ACCEPT (verify first)** | Claimed dead `isImported` branch. Taken on report — must be confirmed against `provenanceBadge`'s null cases before deleting a rendering branch. |
| T4 | Med | **REJECT** | The proposed refactor to `runDashboardReviewAction` does not fit: that helper resolves and locks an **existing** response (`response.id`, `response.business_id` at `http-routes.ts:216`), and the Generate door's whole purpose is creating the FIRST draft, where no response row exists. D-A chose the `past-replies/draft/route.ts` precedent for exactly this reason. The TOCTOU half of the objection is real and accepted separately as T3. |
| T6 | Low-Med | **REJECT** | D-C locked "two adapters at one seam with genuinely different keys, scopes and flag gates — do not factor a shared helper on first duplication". The duplication is the decision, not an oversight. |
| T7 | Low-Med | **DEFER → #680** | `toCardRow`'s seven ternaries are a real readability cost, but splitting the mapper now is a refactor of the exact function round-2 Defect A flagged as fragile. Not during review triage. |
| T8 | Low-Med | **DEFER → #680** | Three-snapshot skew is real but requires reshaping the query into `COUNT(*) FILTER`, which re-orphans allowlist entries (D13) and is blocked by a test assertion. Bundle with T-Q3. |
| T10 | Low | **DEFER → #680** | The two peeks' opposite failure contracts is the right observation; T1's fix removes the misleading half. Full reconciliation with `peekRegenBudget` belongs with the D6 consolidation. |
| Q1 | — | **DEFER → #680** | Standards agrees the eval's `ListRow` should have been retyped and notes the widening cost **two** casts, not one. Reversing it now edits the locked eval for a type-strength gain with exhaustiveness already preserved. Recorded so #680 inherits the reasoning. |
| Q3 | — | **ACCEPT (assertion only)** | Confirmed the fake `sql` double's query-count assertion dictates production shape, and confirmed it does not matter — the inline form is byte-identical, has pre-existing production sites, and passes `ci:response-status`. Fix the assertion to count row-producing queries; leave the SQL alone. |

---

## OUT OF SCOPE — surfaced to the owner, not fixed here

**`src/app/api/dashboard/past-replies/draft-status/route.ts` returns moderation-held
draft text with no check at all.** Verified: zero `flagged_responses` references in
the file, and `:107-108` selects `status` + `response_text` and returns them.

This is a **pre-existing invariant #4 exposure** on a route this branch did not
touch. #678 added the held check to its *own* poller (F5/D9) and to the list
query, which is what makes the older sibling's absence visible by contrast — the
new lane is correct and the old one is not.

It is not this branch's defect and fixing it is outside the ticket, on a branch
already 2.7× its estimate (D18). Recommended as its own ticket, sized with the D6
predicate consolidation (both touch `held-draft.ts`). **Owner decision required —
do not let it close with the ticket.**

---

## Adversarial approach

Codex task `task-mskqg6zk-w7gm8q` **completed** (19:08) and wrote its report. The
harness notification never fired, so the task briefly looked abandoned — it was
not. Recovered by polling the job JSON directly:
`jq -r .status ~/.claude/plugins/data/codex-openai-codex/state/feat-678-reviews-list-generate-*/jobs/task-mskqg6zk-w7gm8q.json`.
**A missing notification is not a dead agent** — check the job file before
re-dispatching, or a completed high-risk review gets silently thrown away.

| # | Sev | Verdict | Reasoning |
|---|---|---|---|
| A1 | High | **DEFER → #710** | D-A's boundary objection is *correct in principle*: a route holding a 77-line domain transaction contradicts invariant #12, and the cited precedent is existing debt rather than evidence of the right seam. **This also overturns my rejection of standards T4** — I rejected that on the mechanism (`runDashboardReviewAction` locks an existing response; Generate has none), and the rejection was right about the mechanism but wrong about the conclusion. Codex proposes a module in an allowed surface taking `tx` explicitly, which sidesteps the objection entirely. Deferred, not dismissed: it is a structural refactor of gate-green code on a branch already 2.7× estimate. |
| A2 | High | **DEFER → #710, deferral RE-OPENED** | D2's recorded blast radius (*"a wasted LLM call, not corruption"*) is **false**. Because `on_demand_generate` is structurally non-auto, the worker never reaches the content-hash re-read at `persist.ts:154` — that comparison lives only inside auto-approval evaluation. So the surviving draft can answer review text the customer has since changed. The unique indexes decide *which* draft survives, never that it is *current*. The owner deferred this on bad information; #710 says so explicitly. Note the hazard is not unique to the new door — `regenerate` is also non-auto — but #678 widens exposure. |
| A3 | High | **DEFER → #710** | A posted response and a moderation-held replacement draft can coexist (the list query left-joins them independently, correctly, for the edit-existing-reply workflow), but `deriveRowState` returns `regenerate` before considering `draft_held`. The row then renders Regenerate → the drawer reaches the unguarded legacy draft route → held text with Resume/Discard. **Deliberately not patched**: the verdict is REJECT/REMODEL, and adding a seventh mutually exclusive state does not fix a cross-product. A naive reorder would make `held` hide a live posted reply. **Pre-existing** — the pre-#678 `Edit reply` button reached the same drawer. |
| A4 | Med | **ACCEPT (correction recorded)** | D6's "three spellings" inventory is wrong; there are **at least eight**. Five pre-existing sites were never counted: `aggregate-service.ts:404`, `service.ts:253`, `pending-count.ts:17,45`, `agents/read.ts:325`. No code change here — the correction matters because #710's scope was sized on the bad number. |

### Design decisions CONFIRMED SOUND — recorded so they are not re-litigated

- **D-H (invariant #3)** — ACCEPT. The protection is the whole typed chain, not the enum alone: producers must supply a `GenerateResponseOriginLane`, the enqueue helper serialises it, unknown runtime values normalise **fail-closed to `null`**, and the only auto-candidate predicate is an exact `live_ingest_new` match plus v1 plus notification eligibility. Posting stays behind an explicit owner transition stamping `approval_method='owner'`. A second Generate-specific guard *would duplicate policy and could drift* — the ticket's prohibition is vindicated, not merely obeyed.
- **D-F (fail-open budget peek)** — ACCEPT. Advisory presentation, not spend authority; the worker's pre-LLM Lua `INCR` is the gate. Disabling every Regenerate during a Redis outage would convert an observability failure into a customer-facing denial with no spend-safety gain.
- **D-C (second poller)** — ACCEPT. A genuine seam: attempt-keyed vs review-keyed, location- vs account-scoped, flag-gated vs not. Adapting the old route would conflate attempt status with review workflow state.

---

## Round-1 outcome

**16 findings accepted and fixed** in `a408eee5` (verified: 52/52 titles intact,
`ci:tenant-scope` 412/412, lint/typecheck clean, 404 tests passing).

Two fixes were **improved on during application**, both by refusing to act on a
reviewer's say-so:

- **E2** — the "dead" `isImported` branch is REACHABLE. `provenance_badge` is optional on the component's declared contract and two existing tests exercise both supposedly-dead arms. The claim held only for production rows. Deleting it would have broken working tests to satisfy a wrong finding.
- **A2 (orphan guard)** — rather than take a tenant-scope exemption, the new query was scoped natively with `AND business_id = …` (already resolved and locked). Zero cost, no new allowlist entry, audit still 412/412. Better than the instruction given.

**4 deferred to #710** (A1, A2, A3, plus the standards deferrals T7/T8/T10/Q1),
**2 rejected on evidence** (T6 re-litigates locked D-C; T4's mechanism does not
fit — though A1 shows its *conclusion* was right).

No round 2 required: every accepted finding is fixed and re-verified, and every
deferral is recorded in a ticket rather than in this branch.
