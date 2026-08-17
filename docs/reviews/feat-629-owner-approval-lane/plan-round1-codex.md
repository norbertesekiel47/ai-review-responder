# Plan review round 1 — Codex adversarial (read-only)

**Target:** `docs/superpowers/plans/2026-08-16-629-owner-approval-lane.md` @ `91b0fe72`
**Brief:** eval-first — "can this eval pass while the feature is still wrong?" — plus the mandatory cited-artifact check.
**Codex thread id:** `01a00d4d-2df1-76f2-b081-94ed9caa1468`
**Verdict:** `REVISE`

## Findings and triage

| # | Finding | Verdict | Where fixed |
|---|---|---|---|
| 1 | A mixed/stale exclusion list returns `unknown_exclusion` **after** the UPDATE. postgres.js commits when the `sql.begin` callback resolves, so the partial cancellation commits while the caller is told the approval was refused. | ACCEPT | Task 3 step 4 — validate with a SELECT before any write |
| 2 | Readiness admits a `withheld` row, so "every ask has rendered" is the wrong phrasing and the UI title asserts something false. | ACCEPT | Comment on the readiness query + test retitled to "…every ask has an attempt" |
| 3 | No test for a `superseded` attempt plus its `attempt_no + 1` replacement (B2's shape). | ACCEPT | New title: "treats a superseded attempt as ready only once its replacement exists" |
| 4 | No test for approval interleaved with a generation commit. | ACCEPT, narrowed | Task 3's `not_ready` test becomes refuse-then-succeed across a committed render. The "hold the generation transaction open" form is NOT written: generation is not a single transaction (`persistChildRender` commits per child), so there is nothing to hold and a fake would prove nothing. |
| 5 | `regenerateAsk` already accepts `approved`/`veto_window`/`sending`, so the plan's "no row can render after approval" claim is false in general. | ACCEPT as scoping | Plan prose corrected. Unreachable today (no owner entry point enqueues a regenerate); recorded as a **binding constraint on the deferred regenerate ticket**: a post-approval regenerate must re-open approval for that ask or be refused. Narrowing `regenerateAsk` here would reopen locked amendment B2. |
| 6 | The exclude-all test asserts parent status but not the derived `disposition`. | ACCEPT | Assertion strengthened to `detail->>'disposition' = 'exhausted'` |
| 7 | The tenant test covers another account, not same-account cross-business. | ACCEPT | Both boundaries asserted in the one test |
| 8 | Only send-mode-off is pinned; watch-off-with-send-on is not. | ACCEPT | Both flag directions asserted |
| 9 | Cross-origin is pinned for approve only, not halt. | ACCEPT | Halt CSRF case added |
| 10 | Property 1 accepts either `veto_window`/`approved` and either `built`/`expired` — an implementation that never recognises an elapsed deadline passes. | ACCEPT | Every arm now names ONE expected state, computed from the inputs |
| 11 | Property 2 is a narrow unit check over five literals, not a constraint on the lifecycle. | ACCEPT | Rewritten to generate a `BatchLifecycleRow` and assert the reason against `sending_started_at` |
| 12 | Both readiness subqueries omit `o.account_id` / `o.business_id`. | ACCEPT | Added to both (approval writer + read model) |

## Not findings

- **Lock ordering is clean.** Codex verified advisory-lock → batch-row → `agent_runs` agrees with the generation lane and the offboarding purge, and that `closeBatchIfSettled` re-locks the batch before the run rather than inverting the order.
- **Halt vs `rendered → queued → sending` race is unwritable today** — #630's releaser does not exist. Codex explicitly said not to fake it. Deferred to #630's integration surface.
- **Cited-artifact check passed.** Every pre-existing path, symbol, constraint name, migration number and spec section cited by the plan exists. The only absent artifacts are the ones the plan creates.

## Full transcript

`/private/tmp/.../scratchpad/codex-plan-round1.jsonl` (session-local). The agent messages are reproduced in the triage table above; nothing material was dropped.
