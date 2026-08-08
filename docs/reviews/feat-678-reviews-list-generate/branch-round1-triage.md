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

Pending — codex background task `task-mskqg6zk-w7gm8q`. Verdicts appended on return.
